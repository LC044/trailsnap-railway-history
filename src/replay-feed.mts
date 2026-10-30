import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {gunzipSync} from 'node:zlib';
const repo=process.cwd();
const output=path.join(repo,'snapshot','v2-replay');
fs.mkdirSync(output,{recursive:true});
process.env.DATA_DIR=fs.mkdtempSync(path.join(output,'data-'));
process.env.SNAPSHOT_DIR=fs.mkdtempSync(path.join(output,'snapshots-'));
const {publishFeed,snapshotPath}=await import('./history/feed');
fs.mkdirSync(path.join(process.env.DATA_DIR,'stations'));
fs.mkdirSync(path.join(process.env.DATA_DIR,'trains'));
fs.mkdirSync(path.join(process.env.DATA_DIR,'feed'));
fs.writeFileSync(path.join(process.env.DATA_DIR,'feed','manifest.json'),JSON.stringify({schema_version:1,sequence:999}));
const shas=execFileSync('git',['log','--reverse','--format=%H','--grep=railway observation'],{encoding:'utf8'}).trim().split('\n');
const rows:any[]=[];
for(const sha of shas){
 const old=JSON.parse(execFileSync('git',['show',`${sha}:data/feed/manifest.json`],{encoding:'utf8',maxBuffer:10000000}));
 if(old.schema_version!==1) continue;
 const snapshot=JSON.parse(gunzipSync(fs.readFileSync(path.join(repo,'data/feed',old.snapshot.file))).toString());
 const stations:any={}; const classes:Record<string,any[]>={};
 for(const item of snapshot.upserts){
  if(item.key.startsWith('station:')) stations[item.value.telecode]=item.value;
  else {const cls=/^\d/.test(item.value.code)?'N':item.value.code[0]; (classes[cls]??=[]).push(item.value);}
 }
 fs.writeFileSync(path.join(process.env.DATA_DIR,'stations/station_history.json'),JSON.stringify(stations));
 for(const name of fs.readdirSync(path.join(process.env.DATA_DIR,'trains'))) fs.writeFileSync(path.join(process.env.DATA_DIR,'trains',name),'');
 for(const [cls,trains] of Object.entries(classes)) fs.writeFileSync(path.join(process.env.DATA_DIR,'trains',`history_${cls}.jsonl`),trains.map(t=>JSON.stringify(t)).join('\n')+'\n');
 const current=publishFeed(old.metadata);
 fs.writeFileSync(path.join(output,`manifest-${current.sequence}.json`),JSON.stringify(current));
 const descriptor=current.deltas.at(-1)??current.snapshot;
 const delta=JSON.parse(gunzipSync(fs.readFileSync(descriptor===current.snapshot?snapshotPath(descriptor):path.join(process.env.DATA_DIR,'feed',descriptor.file))).toString());
 rows.push({date:old.metadata.query_date??'2026-10-23',sha,old_snapshot:old.snapshot.file,sequence:current.sequence,v1_bytes:old.deltas.at(-1).bytes,v2_bytes:descriptor.bytes,versions:delta.train_versions.length,observations:delta.observations.length});
}
fs.writeFileSync(path.join(output,'report.json'),JSON.stringify({repository:repo,feed:path.join(process.env.DATA_DIR,'feed'),snapshots:path.join(process.env.SNAPSHOT_DIR,'feed'),rows},null,2));
console.log(JSON.stringify(rows,null,2));

