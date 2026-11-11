import fs from 'node:fs';
import path from 'node:path';
import {gzipSync, gunzipSync} from 'node:zlib';
import {DATA_DIR, SNAPSHOT_DIR} from './store';
import {sha256, snapshotTag} from './feed';

export type Command = (program: string, args: string[]) => string;
export const statePointer = path.join(DATA_DIR, 'collector-state.json');
const trainFile = /^history_(?:[A-Z]|NUMERIC)\.jsonl$/;
const allowedFile = /^(stations\/station_history\.json|trains\/history_(?:[A-Z]|NUMERIC)\.jsonl|feed\/fingerprints\.json)$/;
const MAX_COMPRESSED = 128 * 1024 * 1024;
const MAX_DECODED = 1024 * 1024 * 1024;

/** Check the entire checkpoint before replacing any local files. */
function validateFiles(files: Record<string, string>) {
  if (!files || typeof files !== 'object' || Array.isArray(files) ||
      Object.entries(files).some(([name, text]) => !allowedFile.test(name) || typeof text !== 'string')) {
    throw new Error('Invalid collector state files');
  }
  const fingerprints = JSON.parse(files['feed/fingerprints.json']);
  const stations = JSON.parse(files['stations/station_history.json']);
  if (fingerprints.schema_version !== 2) throw new Error('Missing v2 publication state');
  const expected: any = {schema_version: 2, stations: {}, versions: {}};
  for (const [code, station] of Object.entries(stations) as [string, any][]) {
    if (station.telecode !== code) throw new Error('Invalid collector station identity');
    expected.stations[`station:${code}`] = sha256(JSON.stringify(station));
  }
  for (const name of Object.keys(files).filter(name => name.startsWith('trains/')).sort()) {
    for (const line of files[name].split('\n').filter(Boolean)) {
      const entry = JSON.parse(line);
      for (const version of entry.versions) {
        const {dates, fd, ld, observed_at, ...value} = version;
        const id = `${entry.code}:${value.h}`;
        if (id in expected.versions) throw new Error(`Duplicate collector version: ${id}`);
        expected.versions[id] = {hash: sha256(JSON.stringify(value)),
          dates: [...new Set<string>(dates?.length ? dates : [fd, ld])].sort()};
      }
    }
  }
  for (const group of ['stations', 'versions']) {
    const actual = fingerprints[group];
    if (!actual || Object.keys(actual).length !== Object.keys(expected[group]).length ||
        Object.entries(expected[group]).some(([key, value]) => JSON.stringify(actual[key]) !== JSON.stringify(value))) {
      throw new Error(`Collector state fingerprints do not match ${group}`);
    }
  }
}

function localFiles() {
  const files: Record<string, string> = {};
  for (const name of ['stations/station_history.json', 'feed/fingerprints.json',
    ...fs.readdirSync(path.join(DATA_DIR, 'trains')).filter(name => trainFile.test(name)).sort().map(name => `trains/${name}`)]) {
    files[name] = fs.readFileSync(path.join(DATA_DIR, name), 'utf8');
  }
  validateFiles(files);
  return files;
}

export function prepareCollectorState(manifest: any) {
  const payload = {schema_version: 1, sequence: manifest.sequence,
    snapshot_sha256: manifest.snapshot.sha256, files: localFiles()};
  const raw = gzipSync(JSON.stringify(payload));
  const digest = sha256(raw);
  const file = `collector-state-${digest}.json.gz`;
  const localPath = path.join(SNAPSHOT_DIR, file);
  fs.mkdirSync(SNAPSHOT_DIR, {recursive: true});
  fs.writeFileSync(localPath, raw);
  return {descriptor: {schema_version: 1, sequence: manifest.sequence,
    snapshot_sha256: manifest.snapshot.sha256, file, sha256: digest, bytes: raw.length}, localPath};
}

export function verifyCollectorState(raw: Buffer, descriptor: any, manifest: any) {
  if (descriptor?.schema_version !== 1 || descriptor.sequence !== manifest.sequence ||
      descriptor.snapshot_sha256 !== manifest.snapshot.sha256 ||
      !/^[a-f0-9]{64}$/.test(descriptor.sha256) ||
      descriptor.file !== `collector-state-${descriptor.sha256}.json.gz`) {
    throw new Error('Collector state descriptor does not match feed');
  }
  if (raw.length > MAX_COMPRESSED || raw.length !== descriptor.bytes || sha256(raw) !== descriptor.sha256) {
    throw new Error('Collector state checksum/size mismatch');
  }
  const payload = JSON.parse(gunzipSync(raw, {maxOutputLength: MAX_DECODED}).toString('utf8'));
  if (payload.schema_version !== 1 || payload.sequence !== manifest.sequence ||
      payload.snapshot_sha256 !== manifest.snapshot.sha256) throw new Error('Collector state sequence mismatch');
  validateFiles(payload.files);
  return payload.files as Record<string, string>;
}

export function restoreCollectorState(run: Command) {
  const manifest = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'feed/manifest.json'), 'utf8'));
  if (manifest.schema_version !== 2) throw new Error('Collector restore requires v2 feed');
  if (!fs.existsSync(statePointer)) {
    // One-time migration: the pre-migration Git checkout still contains all state.
    localFiles();
    console.log('Using verified legacy Git collector state for first Release migration');
    return;
  }
  const descriptor = JSON.parse(fs.readFileSync(statePointer, 'utf8'));
  // Validate descriptor before using it as a command argument.
  if (descriptor.schema_version !== 1 || descriptor.sequence !== manifest.sequence ||
      descriptor.snapshot_sha256 !== manifest.snapshot.sha256 ||
      !/^[a-f0-9]{64}$/.test(descriptor.sha256) ||
      descriptor.file !== `collector-state-${descriptor.sha256}.json.gz` ||
      !/^[a-f0-9]{64}$/.test(manifest.snapshot.sha256)) throw new Error('Invalid collector state descriptor');
  fs.mkdirSync(SNAPSHOT_DIR, {recursive: true});
  const temporary = fs.mkdtempSync(path.join(SNAPSHOT_DIR, 'state-restore-'));
  try {
    run('gh', ['release', 'download', snapshotTag(manifest.snapshot.sha256), '--repo',
      'LC044/trailsnap-railway-history', '--pattern', descriptor.file, '--dir', temporary]);
    const files = verifyCollectorState(fs.readFileSync(path.join(temporary, descriptor.file)), descriptor, manifest);
    // Remove stale class files only after every downloaded file has been verified.
    const trainDir = path.join(DATA_DIR, 'trains');
    fs.mkdirSync(trainDir, {recursive: true});
    for (const name of fs.readdirSync(trainDir).filter(name => trainFile.test(name))) {
      if (!(`trains/${name}` in files)) fs.unlinkSync(path.join(trainDir, name));
    }
    for (const [name, text] of Object.entries(files)) {
      const destination = path.join(DATA_DIR, name);
      fs.mkdirSync(path.dirname(destination), {recursive: true});
      fs.writeFileSync(destination + '.tmp', text);
      fs.renameSync(destination + '.tmp', destination);
    }
    console.log(`Restored collector state at sequence ${manifest.sequence}`);
  } finally {
    fs.rmSync(temporary, {recursive: true, force: true});
  }
}
