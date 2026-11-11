/** Replay two retained production revisions entirely offline, outside data/. */
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {gzipSync, gunzipSync} from 'node:zlib';
import assert from 'node:assert/strict';

const repository = process.cwd();
const latestRef = process.env.COMPACT_REPLAY_REF || 'origin/main';
const previousRef = `${latestRef}~1`;
fs.mkdirSync(path.join(repository, 'snapshot'), {recursive: true});
const output = fs.mkdtempSync(path.join(repository, 'snapshot', 'compact-replay-'));
process.env.DATA_DIR = path.join(output, 'data');
process.env.SNAPSHOT_DIR = path.join(output, 'snapshots');
const store = await import('./history/store');
const {publishFeed, readEntities, sha256, snapshotPath} = await import('./history/feed');
store.ensureDirs();
fs.mkdirSync(path.join(store.DATA_DIR, 'feed'), {recursive: true});
const read = (ref: string, name: string) => execFileSync('git', ['show', `${ref}:data/${name}`],
  {cwd: repository, maxBuffer: 512 * 1024 * 1024});
const names = execFileSync('git', ['ls-tree', '-r', '--name-only', previousRef, 'data/trains'], {encoding: 'utf8'})
  .trim().split('\n').map(name => name.slice(5));
function copy(ref: string, files: string[]) {
  for (const name of files) fs.writeFileSync(path.join(store.DATA_DIR, name), read(ref, name));
}
copy(previousRef, ['feed/manifest.json', 'feed/fingerprints.json', 'stations/station_history.json', ...names]);
const old = JSON.parse(read(previousRef, 'feed/manifest.json').toString());
// Warm content hashes from unchanged history. This does not advance the cursor.
assert.equal(publishFeed({}).sequence, old.sequence);
const rows: any = {stations: [], train_versions: [], observations: []};
for (const [key, entity] of Object.entries(readEntities())) {
  if (key.startsWith('station:')) rows.stations.push(entity);
  else for (const version of entity.versions) {
    const {dates, fd, ld, observed_at, ...value} = version;
    rows.train_versions.push({code: entity.code, value});
    rows.observations.push({code: entity.code, hash: value.h,
      dates: [...new Set<string>(dates?.length ? dates : [fd, ld])].sort(), observed_at});
  }
}
const baselineRaw = gzipSync(JSON.stringify({schema_version: 2, sequence: old.sequence, full: true, ...rows}));
const baselineHash = sha256(baselineRaw);
const baseline = {sequence: old.sequence, file: `packs/${baselineHash}.json.gz`, sha256: baselineHash, bytes: baselineRaw.length};
const baselineFile = path.join(output, 'baseline.json.gz');
fs.writeFileSync(baselineFile, baselineRaw);
const baselineManifest = {...old, snapshot: baseline, deltas: []};
delete baselineManifest.compact_deltas;
delete baselineManifest.station_dates_version;
copy(latestRef, ['stations/station_history.json', ...names]);
const production = JSON.parse(read(latestRef, 'feed/manifest.json').toString());
const current = publishFeed(production.metadata);
assert.equal(current.sequence, production.sequence);
const compact = current.compact_deltas.at(-1)!;
const packFile = path.join(store.DATA_DIR, 'feed', compact.file);
const delta = JSON.parse(gunzipSync(fs.readFileSync(packFile)).toString());
assert.equal(delta.stations.length, 0, 'sample must have unchanged station content');
assert.equal(delta.station_dates.length, production.coverage.stations);
const original = production.deltas.at(-1)!;
const report = {previous_ref: previousRef, latest_ref: latestRef,
  baseline_compressed_bytes: baselineRaw.length,
  baseline: baselineManifest, current,
  files: {[baseline.file]: baselineFile, [compact.file]: packFile, [current.snapshot.file]: snapshotPath(current.snapshot)},
  comparison: {date: production.metadata.query_date, old_delta_bytes: original.bytes, compact_delta_bytes: compact.bytes,
    reduction_percent: Number(((1 - compact.bytes / original.bytes) * 100).toFixed(2)),
    full_stations: delta.stations.length, station_date_updates: delta.station_dates.length,
    new_train_versions: delta.train_versions.length, train_observations: delta.observations.length}};
fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify({report: path.join(output, 'report.json'),
  baseline_compressed_bytes: report.baseline_compressed_bytes, ...report.comparison}, null, 2));
