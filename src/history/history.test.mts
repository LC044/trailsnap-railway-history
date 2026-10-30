import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import type { StationHistory, StationRecord, TrainHistoryEntry } from './store';
// Import after assigning isolation paths: tests never write production data.
process.env.DATA_DIR=fs.mkdtempSync(path.join(os.tmpdir(),'railway-history-'));
process.env.SNAPSHOT_DIR=fs.mkdtempSync(path.join(os.tmpdir(),'railway-snapshot-'));
const store=await import('./store');
const { mergeTrain, makeVersion }=await import('./merge');
const { publishFeed, snapshotPath, snapshotTag, sha256 }=await import('./feed');
const { enumerate, retry }=await import('../collect');
const { enumerateWithCheckpoint }=await import('../enumeration');
const { fetchWithFallback, describeNetworkError }=await import('../utils/transport');

test('transport fallback keeps TLS verification, JSON/status and nested error diagnostics',async()=>{
  const failure=new Error('fetch failed',{cause:Object.assign(new Error('handshake failure'),{code:'ECONNRESET'})});
  assert.match(describeNetworkError(failure),/ECONNRESET/);
  const args:string[][]=[];
  const response=await fetchWithFallback('https://search.12306.cn/test',{headers:{Accept:'application/json'}},null,
    (async()=>{throw failure;}) as typeof fetch,async values=>{args.push(values);return '{"data":[]}\n200';});
  assert.deepEqual(await response.json(),{data:[]});
  assert.ok(!args[0].includes('--insecure') && !args[0].includes('-k'));
  assert.ok(args[0].includes('=https'));
  const rejected=await fetchWithFallback('https://search.12306.cn/test',{},null,
    (async()=>new Response('unavailable',{status:503})) as typeof fetch,async()=>assert.fail('HTTP errors must not bypass retry'));
  assert.equal(rejected.status,503);
  await assert.rejects(fetchWithFallback('https://search.12306.cn/test',{},null,
    (async()=>{throw failure;}) as typeof fetch,async()=>{throw new Error('curl unavailable');}),/ECONNRESET.*curl unavailable/);
});

test('list failures are deferred, saved prefixes resume, and incomplete enumeration fails closed',async()=>{
  const file=path.join(fs.mkdtempSync(path.join(os.tmpdir(),'railway-enumeration-')),'checkpoint.json');
  const one={train_no:'no',station_train_code:'G12',date:'20261024',from_station:'A',to_station:'B',total_num:'2'};
  const calls:string[]=[];
  await assert.rejects(enumerateWithCheckpoint(['G1','D1'],'2026-10-24',async p=>{
    calls.push(p);if(p==='D1')throw new Error('HTTP 503 unavailable');return [one];
  },file,{rounds:2,pause:async()=>{}}),/D1: HTTP 503 unavailable/);
  assert.deepEqual(calls,['G1','D1','D1']);
  const saved=JSON.parse(fs.readFileSync(file,'utf8'));
  assert.deepEqual(Object.keys(saved.responses),['G1']);
  const resumed:string[]=[];
  const result=await enumerateWithCheckpoint(['G1','D1'],'2026-10-24',async p=>{resumed.push(p);return [];},file);
  assert.deepEqual(resumed,['D1']);assert.equal(result.size,1);
  const fresh:string[]=[];
  await enumerateWithCheckpoint(['G1','D1'],'2026-10-25',async p=>{fresh.push(p);return [];},file);
  assert.deepEqual(fresh,['G1','D1']);
  fresh.length=0;
  await enumerateWithCheckpoint(['G1'],'2026-10-25',async p=>{fresh.push(p);return [];},file);
  assert.deepEqual(fresh,['G1']);
});

test('truncated parent, successful children and exact train matches survive retry',async()=>{
  const file=path.join(fs.mkdtempSync(path.join(os.tmpdir(),'railway-enumeration-')),'checkpoint.json');
  const one={train_no:'no',station_train_code:'G1',date:'20261024',from_station:'A',to_station:'B',total_num:'2'};
  let attempts=0;const calls:string[]=[];
  const found=await enumerateWithCheckpoint(['G1'],'2026-10-24',async p=>{
    calls.push(p);if(p==='G12' && ++attempts===1)throw new Error('timeout');
    return p==='G1'?Array.from({length:200},()=>one):p==='G12'?[one]:[];
  },file,{pause:async()=>{}});
  assert.equal(found.size,1);assert.equal(attempts,2);
  assert.equal(calls.filter(p=>p==='G1').length,1);
  assert.ok(calls.indexOf('G19')<calls.lastIndexOf('G12'));
  assert.equal((await enumerateWithCheckpoint(['G1'],'2026-10-24',async()=>assert.fail('cached response refetched'),file)).size,1);
});

test('retry retains prefix and response diagnostics',async()=>{
  await assert.rejects(retry(async()=>({code:200,success:true}),()=>false,2,'list G12 (2026-10-24)',async()=>{}),/list G12.*HTTP 200.*data=undefined/);
  await assert.rejects(retry(async()=>{throw new Error('socket timeout');},()=>true,1,'list G12'),/list G12.*socket timeout/);
});

test('station rename, metadata change, disappearance and reactivation preserve all history',()=>{
  const history:StationHistory={};
  const station={name:'旧站',tele_code:'AAA',pinyin:'jiu',pinyin_short:'j',city:'城市',extra:{field:1}};
  store.updateStationHistory(history,[station],'2026-10-01');
  store.updateStationHistory(history,[{...station,name:'新站',extra:{field:2}}],'2026-10-02');
  store.updateStationHistory(history,[],'2026-10-03',false);
  assert.equal(history.AAA.status,'active');
  store.updateStationHistory(history,[],'2026-10-04');
  assert.equal(history.AAA.status,'inactive');
  assert.deepEqual(history.AAA.names.map(n=>n.name),['旧站','新站']);
  assert.deepEqual(history.AAA.versions?.[0].data.extra,{field:1});
  store.updateStationHistory(history,[station],'2026-10-05');
  assert.equal(history.AAA.status_history?.length,3);
});

test('train A-B-A and out-of-order observations retain exact operating dates',()=>{
  const entry:TrainHistoryEntry={code:'G1',versions:[]};
  const a=makeVersion('no','A','B',[{n:'A',c:'AAA',a:null,d:'08:00',dd:0}],'2026-10-01',{});
  const b=makeVersion('no','A','B',[{n:'A',c:'AAA',a:null,d:'09:00',dd:0}],'2026-10-02',{});
  mergeTrain(entry,a,'2026-10-01');mergeTrain(entry,b,'2026-10-02');mergeTrain(entry,a,'2026-10-03');
  mergeTrain(entry,a,'2026-09-30');
  assert.equal(entry.versions.length,2);
  assert.deepEqual(entry.versions[0].dates,['2026-09-30','2026-10-01','2026-10-03']);
});

test('truncated prefix enumeration keeps exact matches and deduplicates overlapping children',async()=>{
  const one={train_no:'no',station_train_code:'1234',date:'20261023',from_station:'A',to_station:'B',total_num:'2'};
  const found=await enumerate('1',async p=>p==='1'?Array.from({length:200},()=>one):p==='12'?[one]:[]);
  assert.equal(found.size,1);
});

test('retry response is returned to the caller',async()=>{
  let count=0;
  assert.equal(await retry(async()=>++count,v=>v===2,2),2);
});

test('immutable feed supports bootstrap, no-op, changed entities and deletion protection',()=>{
  store.ensureDirs();
  const history:StationHistory={};
  store.updateStationHistory(history,[{name:'A',tele_code:'AAA',pinyin:'a',pinyin_short:'a',city:'A'}],'2026-10-01');
  store.saveStationHistory(history);
  const first=publishFeed({complete:false});
  const bytes=fs.readFileSync(snapshotPath(first.snapshot));
  assert.equal(JSON.parse(gunzipSync(bytes).toString()).stations.length,1);
  assert.equal(first.schema_version,2);
  assert.match(first.snapshot.url!,/github.com\/LC044\/trailsnap-railway-history\/releases\/download\//);
  assert.deepEqual(first.deltas,[]);
  assert.ok(!fs.existsSync(path.join(store.DATA_DIR,'feed',first.snapshot.file)));
  assert.equal(publishFeed({}).sequence,1);
  store.updateStationHistory(history,[{name:'B',tele_code:'AAA',pinyin:'b',pinyin_short:'b',city:'A'}],'2026-10-02');
  store.saveStationHistory(history);
  assert.equal(publishFeed({}).sequence,2);
  assert.ok(fs.existsSync(snapshotPath(first.snapshot)));
  store.saveStationHistory({});
  assert.throws(()=>publishFeed({}),/history deletion/);
});

test('v2 date-only deltas omit timetable content and migrate v1 sequence',()=>{
  store.ensureDirs();
  store.saveStationHistory({});
  const feedDir=path.join(store.DATA_DIR,'feed');
  fs.writeFileSync(path.join(feedDir,'manifest.json'),JSON.stringify({schema_version:1,sequence:900}));
  const entry:TrainHistoryEntry={code:'G1',versions:[]};
  const v=makeVersion('n','A','B',[{n:'A',c:'AAA',a:null,d:'08:00',dd:0}], '2026-10-01',{});
  mergeTrain(entry,v,'2026-10-01');
  store.saveClassHistory('G',new Map([['G1',entry]]));
  const first=publishFeed({});
  assert.equal(first.sequence,1);
  mergeTrain(entry,v,'2026-10-02');
  store.saveClassHistory('G',new Map([['G1',entry]]));
  const second=publishFeed({});
  const delta=JSON.parse(gunzipSync(fs.readFileSync(path.join(feedDir,second.deltas.at(-1)!.file))).toString());
  assert.deepEqual(delta.train_versions,[]);
  assert.deepEqual(delta.observations[0].dates,['2026-10-02']);
  assert.equal(publishFeed({}).sequence,2);
  const b=makeVersion('n','A','B',[{n:'A',c:'AAA',a:null,d:'09:00',dd:0}], '2026-10-03',{});
  mergeTrain(entry,b,'2026-10-03');
  store.saveClassHistory('G',new Map([['G1',entry]]));
  const third=publishFeed({});
  const changed=JSON.parse(gunzipSync(fs.readFileSync(path.join(feedDir,third.deltas.at(-1)!.file))).toString());
  assert.equal(changed.train_versions.length,1);
  mergeTrain(entry,v,'2026-10-04');
  store.saveClassHistory('G',new Map([['G1',entry]]));
  const fourth=publishFeed({});
  const reverted=JSON.parse(gunzipSync(fs.readFileSync(path.join(feedDir,fourth.deltas.at(-1)!.file))).toString());
  assert.deepEqual(reverted.train_versions,[]);
  assert.equal(reverted.observations[0].hash,v.h);
  assert.deepEqual(reverted.observations[0].dates,['2026-10-04']);
  entry.versions[0].f='mutated';
  store.saveClassHistory('G',new Map([['G1',entry]]));
  assert.throws(()=>publishFeed({}),/Version content changed/);
  entry.versions[0].f='A';
  entry.versions[0].dates=['2026-10-01'];
  store.saveClassHistory('G',new Map([['G1',entry]]));
  assert.throws(()=>publishFeed({}),/observation deletion/);
  fs.writeFileSync(store.classFile('G'),'');
  assert.throws(()=>publishFeed({}),/history deletion/);
});

test('official station formats retain fields and fall back when homepage is unavailable', async()=>{
  const { parseStationNames, getStationNames } = await import('../services/station_names/fetch');
  const one='aaa|站甲|AAA|a|a|0|001|城市|future';
  const two='bbb|站乙|BBB|b|b|1|002|城市';
  assert.equal(parseStationNames(`var station_names='@${one}@${two}';`).length,2);
  assert.equal(parseStationNames(`var station_names='@${one}|||@${two}';`)[0].raw_fields?.[8],'future');
  let calls=0;
  const fetcher=(async(url:unknown)=>{
    if(++calls===1) throw new Error('ETIMEDOUT');
    assert.equal(url,'https://kyfw.12306.cn/otn/resources/js/framework/station_name.js');
    return new Response(`var station_names='@${one}@${two}';`);
  }) as typeof fetch;
  assert.equal((await getStationNames(fetcher)).length,2);
});

test('retained history publication adds field snapshots without changing observations or status', async()=>{
  const { addRetainedStationFields }=await import('./retained');
  const history:StationHistory={};
  store.updateStationHistory(history,[{name:'旧站',tele_code:'AAA',pinyin:'a',pinyin_short:'a',city:'A'}],'2026-10-01');
  history.AAA.status='inactive';delete history.AAA.versions;
  addRetainedStationFields(history,{version_no:'seed',stationList:[{id:'AAA',latitude:'30',longitute:'120'}]});
  assert.equal(history.AAA.status,'inactive');
  assert.equal(history.AAA.last_seen,'2026-10-01');
  assert.equal((history.AAA as StationRecord).versions?.[0].data.gps_source,'12306-seed');
  const before=JSON.stringify(history);
  addRetainedStationFields(history,{version_no:'changed',stationList:[]});
  assert.equal(JSON.stringify(history),before);
});

test('Release bytes are verified before git; upload failures and retries leave the old manifest unexposed',async()=>{
  const {releaseFeed}=await import('../release-feed');
  const raw=gzipSync(JSON.stringify({schema_version:2,sequence:10,full:true,stations:[],train_versions:[],observations:[]}));
  const hash=sha256(raw);
  const descriptor={sequence:10,file:`packs/${hash}.json.gz`,sha256:hash,bytes:raw.length,
    url:`https://github.com/LC044/trailsnap-railway-history/releases/download/${snapshotTag(hash)}/${hash}.json.gz`};
  fs.mkdirSync(path.dirname(snapshotPath(descriptor)),{recursive:true});
  fs.writeFileSync(snapshotPath(descriptor),raw);
  fs.writeFileSync(path.join(store.DATA_DIR,'feed/manifest.json'),JSON.stringify({schema_version:2,sequence:10,snapshot:descriptor,deltas:[]}));
  const calls:string[]=[];
  let exists=false; let uploaded=false; let failUpload=true; let corrupt=false; let draft=false; let fullStaged=false;
  const run=(program:string,args:string[])=>{
    calls.push([program,...args.slice(0,3)].join(' '));
    if(program==='gh') {
      if(args[1]==='view') {if(!exists) throw new Error('not found');return JSON.stringify({isDraft:draft,assets:uploaded?[{name:`${hash}.json.gz`}]:[]});}
      if(args[1]==='create') {exists=true;if(failUpload) throw new Error('upload failed');uploaded=true;}
      if(args[1]==='upload') {if(failUpload) throw new Error('upload failed');uploaded=true;}
      if(args[1]==='download') fs.writeFileSync(path.join(args[args.indexOf('--dir')+1],`${hash}.json.gz`),corrupt?Buffer.from('corrupt'):raw);
    }
    if(program==='git' && args[0]==='rev-parse') return 'a'.repeat(40);
    if(program==='git' && args.includes('--diff-filter=AM')) return fullStaged?snapshotPath(descriptor):'';
    if(program==='git' && args[0]==='diff' && !args.includes('--diff-filter=AM')) return 'data/feed/manifest.json';
    return '';
  };
  assert.throws(()=>releaseFeed(run),/upload failed/);
  assert.ok(!calls.some(c=>c.startsWith('git add')||c.startsWith('git push')));
  calls.length=0;failUpload=false;corrupt=true;
  assert.throws(()=>releaseFeed(run),/checksum/);
  assert.ok(!calls.some(c=>c.startsWith('git add')));
  calls.length=0;corrupt=false;draft=true;
  releaseFeed(run);
  assert.ok(calls.findIndex(c=>c.startsWith('gh release download'))<calls.findIndex(c=>c.startsWith('git add')));
  assert.ok(calls.findIndex(c=>c.startsWith('gh release edit'))<calls.findIndex(c=>c.startsWith('git push')));
  assert.ok(!calls.some(c=>c.startsWith('gh release create')));
  calls.length=0;draft=false;
  releaseFeed(run);
  assert.ok(!calls.some(c=>c.startsWith('gh release create')||c.startsWith('gh release upload')));
  calls.length=0;exists=false;
  releaseFeed(run);
  assert.ok(calls.some(c=>c.startsWith('gh release create')));
  assert.ok(calls.findIndex(c=>c.startsWith('gh release download'))<calls.findIndex(c=>c.startsWith('git push')));
  calls.length=0;fullStaged=true;
  assert.throws(()=>releaseFeed(run),/Refusing to commit a full snapshot/);
  assert.ok(!calls.some(c=>c.startsWith('git push')));
});
