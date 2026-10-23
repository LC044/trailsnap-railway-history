import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import type { StationHistory, TrainHistoryEntry } from './store';
// Import after assigning isolation paths: tests never write production data.
process.env.DATA_DIR=fs.mkdtempSync(path.join(os.tmpdir(),'railway-history-'));
const store=await import('./store');
const { mergeTrain, makeVersion }=await import('./merge');
const { publishFeed }=await import('./feed');
const { enumerate, retry }=await import('../collect');

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
  const bytes=fs.readFileSync(path.join(store.DATA_DIR,'feed',first.snapshot.file));
  assert.equal(JSON.parse(gunzipSync(bytes).toString()).upserts.length,1);
  assert.equal(publishFeed({}).sequence,1);
  store.updateStationHistory(history,[{name:'B',tele_code:'AAA',pinyin:'b',pinyin_short:'b',city:'A'}],'2026-10-02');
  store.saveStationHistory(history);
  assert.equal(publishFeed({}).sequence,2);
  assert.ok(fs.existsSync(path.join(store.DATA_DIR,'feed',first.snapshot.file)));
  store.saveStationHistory({});
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
