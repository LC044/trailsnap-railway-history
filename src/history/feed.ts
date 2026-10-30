import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { DATA_DIR, SNAPSHOT_DIR, loadStationHistory } from './store';

export const snapshotPath = (descriptor: {file: string}) => path.join(SNAPSHOT_DIR, 'feed', descriptor.file);
export const snapshotTag = (hash: string) => `snapshot-v2-${hash}`;

export const sha256 = (value: string | Buffer) => crypto.createHash('sha256').update(value).digest('hex');
export const readEntities = () => {
  const entities: Record<string, any> = {};
  for (const [code, station] of Object.entries(loadStationHistory())) entities[`station:${code}`] = station;
  for (const file of fs.readdirSync(path.join(DATA_DIR, 'trains')).filter(f => /^history_.*\.jsonl$/.test(f)).sort()) {
    for (const line of fs.readFileSync(path.join(DATA_DIR, 'trains', file), 'utf8').split('\n').filter(Boolean)) {
      const train = JSON.parse(line);
      entities[`train:${train.code}`] = train;
    }
  }
  return entities;
};

/** v2 separates immutable version contents from exact operating-day observations. */
export function publishFeed(metadata: Record<string, unknown>) {
  const dir = path.join(DATA_DIR, 'feed');
  fs.mkdirSync(path.join(dir, 'packs'), { recursive: true });
  const manifestPath = path.join(dir, 'manifest.json');
  const statePath = path.join(dir, 'fingerprints.json');
  const old = fs.existsSync(manifestPath) ? JSON.parse(fs.readFileSync(manifestPath, 'utf8')) : null;
  const previous = old?.schema_version === 2 ? old : null;
  const saved = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, 'utf8')) : null;
  if (previous && saved?.schema_version !== 2) throw new Error('Missing v2 publication state');
  const prior = previous ? saved : {stations: {}, versions: {}};
  const state: any = {schema_version: 2, stations: {}, versions: {}};
  const snapshot: any = {stations: [], train_versions: [], observations: []};
  const delta: any = {stations: [], train_versions: [], observations: []};
  const entities = readEntities();
  for (const [key, entity] of Object.entries(entities)) {
    if (key.startsWith('station:')) {
      state.stations[key] = sha256(JSON.stringify(entity));
      snapshot.stations.push(entity);
      if (state.stations[key] !== prior.stations[key]) delta.stations.push(entity);
      continue;
    }
    for (const version of entity.versions) {
      const {dates, fd, ld, observed_at, ...value} = version;
      const id = `${entity.code}:${value.h}`;
      const days: string[] = [...new Set<string>(dates?.length ? dates : [fd, ld])].sort();
      const hash = sha256(JSON.stringify(value));
      const before = prior.versions[id];
      if (before && before.hash !== hash) throw new Error(`Version content changed: ${id}`);
      if (before?.dates.some((day: string) => !days.includes(day))) throw new Error(`Refusing observation deletion: ${id}`);
      state.versions[id] = {hash, dates: days};
      const row = {code: entity.code, value};
      snapshot.train_versions.push(row);
      if (!before) delta.train_versions.push(row);
      const observation = {code: entity.code, hash: value.h, dates: days, observed_at};
      snapshot.observations.push(observation);
      const added = days.filter(day => !before?.dates.includes(day));
      if (added.length) delta.observations.push({...observation, dates: added});
    }
  }
  for (const key of Object.keys(prior.stations)) {
    if (!(key in state.stations)) throw new Error(`Refusing history deletion: ${key}`);
  }
  for (const key of Object.keys(prior.versions)) {
    if (!(key in state.versions)) throw new Error(`Refusing history deletion: ${key}`);
  }
  const changed = Object.values(delta).some((rows: any) => rows.length);
  if (previous && !changed && previous.snapshot.url) return previous;
  // Moving an existing v2 snapshot to Release does not invent a data update.
  const sequence = previous && !changed ? previous.sequence : (previous?.sequence ?? 0) + 1;
  const pack = (rows: any, full: boolean) => {
    const compressed = gzipSync(JSON.stringify({schema_version: 2, sequence, full, ...rows}));
    const hash = sha256(compressed);
    const file = `packs/${hash}.json.gz`;
    const destination = full ? snapshotPath({file}) : path.join(dir, file);
    fs.mkdirSync(path.dirname(destination), {recursive:true});
    fs.writeFileSync(destination, compressed);
    const descriptor = {sequence, file, sha256: hash, bytes: compressed.length};
    return full ? {...descriptor, url: `https://github.com/LC044/trailsnap-railway-history/releases/download/${snapshotTag(hash)}/${hash}.json.gz`} : descriptor;
  };
  // Fresh clients always bootstrap from the full Release snapshot, not delta 1.
  const incremental = previous && changed ? pack(delta, false) : null;
  const full = pack(snapshot, true);
  const trains = Object.entries(entities).filter(([key]) => key.startsWith('train:'));
  const coverage = {stations: snapshot.stations.length, trains: trains.length,
    trains_with_timetable: trains.filter(([,v]) => v.versions.some((version: any) => version.s.length)).length};
  const manifest = {schema_version: 2, sequence, generated_at: new Date().toISOString(), metadata,
    coverage, snapshot: full, deltas: [...(previous?.deltas ?? []).filter((d: any) => d.sequence > 1), ...(incremental ? [incremental] : [])]};
  for (const [file, value] of [[statePath, state], [manifestPath, manifest]] as const) {
    fs.writeFileSync(file + '.tmp', JSON.stringify(value, null, 2));
    fs.renameSync(file + '.tmp', file);
  }
  return manifest;
}
