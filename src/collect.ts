import fs from 'node:fs';
import path from 'node:path';
import { getStationNames } from './services/station_names';
import { queryTrainListByKeywordAndDate, queryTrainDetailByTrainNoAndDate } from './services/train';
import type { ITrain } from './services/train/model';
import { ensureProxyPool, TaskScheduler } from './utils';
import { PAGE_SIZE } from './constants';
import { SNAPSHOT_DIR, ensureDirs, loadStationHistory, updateStationHistory, saveStationHistory,
  buildNameToTelecode, loadClassHistory, saveClassHistory, saveSummary, saveSnapshot, type TrainHistoryEntry } from './history/store';
import { makeVersion, mergeTrain } from './history/merge';
import { publishFeed } from './history/feed';

const sleep = (ms:number) => new Promise(r=>setTimeout(r,ms));
export async function retry<T>(task:()=>Promise<T>, valid:(v:T)=>boolean, attempts=4):Promise<T> {
  for (let i=0;i<attempts;i++) {
    try { const result=await task(); if (valid(result)) return result; } catch(e) { if(i===attempts-1) throw e; }
    if(i<attempts-1) await sleep((i+1)*3000);
  }
  throw new Error('Request failed after retries');
}
export async function enumerate(prefix:string, query:(prefix:string)=>Promise<ITrain[]>, result=new Map<string,ITrain>()) {
  const list=await query(prefix);
  for(const t of list) result.set(`${t.train_no}|${t.station_train_code}`,t);
  if(list.length>=PAGE_SIZE) {
    if(prefix.length>=8) throw new Error(`Truncated enumeration: ${prefix}`);
    for(let i=0;i<=9;i++) await enumerate(`${prefix}${i}`,query,result);
  }
  return result;
}
export async function collect() {
  ensureDirs();
  const replay=process.env.REPLAY_SNAPSHOT_DIR;
  const date=process.env.REPLAY_QUERY_DATE || new Date(Date.now()+Number(process.env.QUERY_DATE_OFFSET||0)*86400000).toLocaleDateString('sv-SE',{timeZone:'Asia/Shanghai'});
  const observed=(replay && process.env.REPLAY_DATE) || new Date().toLocaleDateString('sv-SE',{timeZone:'Asia/Shanghai'});
  const limited=Number(process.env.TEST_LIMIT||0);
  const testMode=Boolean(process.env.TEST_PREFIX||limited);
  if(testMode && !process.env.DATA_DIR) throw new Error('Test runs require isolated DATA_DIR');
  const readSnapshot=(name:string)=>JSON.parse(fs.readFileSync(path.join(replay!,`${name}_${process.env.REPLAY_DATE||observed}.json`),'utf8'));
  if(!replay) await ensureProxyPool();
  const stations=(replay?readSnapshot('stations'):await retry(getStationNames,s=>s.length>1000))
    .filter((s:any)=>s.name && /^[A-Z]{3}$/.test(s.tele_code));
  const history=loadStationHistory();
  const completeStations=stations.length>=Math.max(1000,Object.keys(history).length*0.9);
  if(!completeStations) throw new Error('Incomplete station list');
  const gps=JSON.parse(fs.readFileSync(path.resolve('assets/station_gps.json'),'utf8'));
  const gpsByCode=new Map<string,Record<string,unknown>>((gps.stationList??[]).map((s:any)=>[s.id,s]));
  const enriched=stations.map((s:any)=>({...s,gps:gpsByCode.get(s.tele_code)??null,gps_version:gps.version_no,
    gps_source:'12306-seed',coordinate_system:'unknown'}));
  const stationChanges=updateStationHistory(history,enriched,observed,completeStations);
  saveStationHistory(history); saveSnapshot(`stations_${observed}.json`,stations);
  const names=buildNameToTelecode(history);
  let trains:ITrain[];
  if(replay) trains=readSnapshot('train_list');
  else {
    const found=new Map<string,ITrain>();
    const query=async(prefix:string)=>{
      const rsp=await retry(()=>queryTrainListByKeywordAndDate(prefix,date.replaceAll('-','')),r=>r.success&&Array.isArray(r.data));
      console.log(`[list] ${prefix}: ${rsp.data!.length}`); return rsp.data!;
    };
    const roots=process.env.TEST_PREFIX?[process.env.TEST_PREFIX]:
      ['G','D','C','K','Z','T','S','Y','L','A',''].flatMap(c=>Array.from({length:9},(_,i)=>`${c}${i+1}`));
    for(const prefix of roots) await enumerate(prefix,query,found);
    trains=[...found.values()];
  }
  if(!trains.length) throw new Error('Empty train enumeration');
  saveSnapshot(`train_list_${observed}.json`,trains);
  const targets=[...new Map(trains.map(t=>[t.train_no,t])).values()];
  const scheduler=new TaskScheduler(5,2);
  const details:any[]=replay?readSnapshot('train_detail'):[];
  const failures:string[]=[];
  if(!replay) {
    const selected=limited?targets.slice(0,limited):targets;
    const checkpointPath=path.join(SNAPSHOT_DIR,`checkpoint_${date}.json`);
    const checkpoint:Record<string,any>=fs.existsSync(checkpointPath)?JSON.parse(fs.readFileSync(checkpointPath,'utf8')):{};
    for(let i=0;i<selected.length;i+=100) {
      await Promise.all(selected.slice(i,i+100).map(t=>scheduler.add(async()=>{
        if(checkpoint[t.train_no]) {details.push(checkpoint[t.train_no]);return;}
        try {
          const rsp=await retry(()=>queryTrainDetailByTrainNoAndDate(t.train_no,date),r=>r.success&&Array.isArray(r.data?.data)&&r.data.data.length>1);
          const detail={...t,stops:rsp.data!.data}; checkpoint[t.train_no]=detail;details.push(detail);
        } catch {failures.push(t.train_no);}
      })));
      fs.writeFileSync(checkpointPath+'.tmp',JSON.stringify(checkpoint));fs.renameSync(checkpointPath+'.tmp',checkpointPath);
      console.log(`[details] ${Math.min(i+100,selected.length)}/${selected.length}, failed ${failures.length}`);
    }
  }
  saveSnapshot(`train_detail_${observed}.json`,details);
  const classes=new Map<string,Map<string,TrainHistoryEntry>>();
  for(const detail of details) {
    const mapped=trains.filter(t=>t.train_no===detail.train_no).flatMap(t=>t.station_train_code.split('/'));
    const codes=[...new Set(mapped.length ? mapped : String(detail.station_train_code).split('/'))];
    const rawStops=detail.stops;
    const stops=rawStops.map((s:any,i:number)=>({n:s.station_name.trim(),c:names.get(s.station_name.trim())??'',
      a:i===0||!/^\d\d:\d\d$/.test(s.arrive_time)?null:s.arrive_time,
      d:i===rawStops.length-1||!/^\d\d:\d\d$/.test(s.start_time)?null:s.start_time,
      dd:Number(s.arrive_day_diff||0),raw:s}));
    for(const code of codes) {
      const cls=/^\d/.test(code)?'N':code[0];
      if(!classes.has(cls)) classes.set(cls,loadClassHistory(cls));
      const entries=classes.get(cls)!;const entry=entries.get(code)??{code,versions:[]};
      const listDate=trains.find(t=>t.train_no===detail.train_no)?.date??'';
      if (replay && !/^\d{8}$/.test(listDate) && !process.env.REPLAY_QUERY_DATE) throw new Error('REPLAY_QUERY_DATE required for unmatched details');
      const operatingDate=replay&&/^\d{8}$/.test(listDate)?listDate.replace(/^(\d{4})(\d{2})(\d{2})$/,'$1-$2-$3'):date;
      mergeTrain(entry,makeVersion(detail.train_no,detail.from_station,detail.to_station,stops,operatingDate,detail),operatingDate);
      entries.set(code,entry);
    }
  }
  const detailNos = new Set(details.map(d=>d.train_no));
  // Enumeration is useful even when a timetable request fails: retain observed endpoints.
  for (const train of trains) {
    if (detailNos.has(train.train_no) || (testMode && !replay)) continue;
    for (const code of train.station_train_code.split('/')) {
      const cls = /^\d/.test(code) ? 'N' : code[0];
      if (!classes.has(cls)) classes.set(cls,loadClassHistory(cls));
      const entries = classes.get(cls)!;
      const entry = entries.get(code) ?? {code,versions:[]};
      const operatingDate = replay && /^\d{8}$/.test(train.date) ? train.date.replace(/^(\d{4})(\d{2})(\d{2})$/,'$1-$2-$3') : date;
      mergeTrain(entry,makeVersion(train.train_no,train.from_station,train.to_station,[],operatingDate,train),operatingDate);
      entries.set(code,entry);
    }
  }
  for(const [cls,entries] of classes) saveClassHistory(cls,entries);
  const summary={query_date:date,observed_date:observed,test_mode:testMode,replay:Boolean(replay),stations:stations.length,
    station_changes:stationChanges,enumerated_codes:trains.length,enumerated_train_nos:targets.length,
    details_ok:details.length,details_failed:failures.length,details_unavailable:Math.max(0,targets.length-details.length),
    complete:!testMode&&!replay&&failures.length===0&&details.length===targets.length,
    gps_stations:gpsByCode.size,gps_source:'bundled seed (not freshly fetched)',failed_train_nos:failures};
  saveSummary(summary);publishFeed(summary);console.log(JSON.stringify(summary,null,2));
}
