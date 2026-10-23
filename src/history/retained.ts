import fs from 'node:fs';
import path from 'node:path';
import { ensureDirs, loadStationHistory, saveStationHistory, DATA_DIR, type StationHistory } from './store';
import { publishFeed } from './feed';

/** Upgrade retained station records without inventing new train observations or changing status. */
export function addRetainedStationFields(history: StationHistory, gps: any) {
  const coordinates = new Map<string,unknown>((gps.stationList ?? []).map((station:any)=>[station.id,station]));
  for (const station of Object.values(history)) {
    if (station.versions?.length) continue;
    station.versions = [{first:station.first_seen,last:station.last_seen,data:{
      tele_code:station.telecode,name:station.names.at(-1)!.name,pinyin:station.pinyin,
      pinyin_short:station.pinyin_short,city:station.city,source:'retained-history',
      gps:coordinates.get(station.telecode) ?? null,gps_source:'12306-seed',
      gps_version:gps.version_no,coordinate_system:'unknown',gps_sample_date:null,
    }}];
  }
}

export function publishExisting() {
  ensureDirs();
  const history = loadStationHistory();
  if (!Object.keys(history).length) throw new Error('No retained station history to publish');
  const gps = JSON.parse(fs.readFileSync(path.resolve('assets/station_gps.json'),'utf8'));
  addRetainedStationFields(history,gps);
  saveStationHistory(history);
  const summaryFile = path.join(DATA_DIR,'summary.json');
  const summary = fs.existsSync(summaryFile) ? JSON.parse(fs.readFileSync(summaryFile,'utf8')) : null;
  const manifest = publishFeed({source:'retained-history',complete:false,
    note:'Packages built from existing retained observations; no new train queries or operating dates were added.',
    collection_summary:summary});
  console.log(JSON.stringify({sequence:manifest.sequence,coverage:manifest.coverage,snapshot:manifest.snapshot},null,2));
}
