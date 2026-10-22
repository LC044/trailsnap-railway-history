import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { gzipSync } from "node:zlib";
import { DATA_DIR, loadStationHistory } from "./store";

export const sha256 = (value: string | Buffer) => crypto.createHash("sha256").update(value).digest("hex");
export const readEntities = () => {
  const entities: Record<string, unknown> = {};
  for (const [code, station] of Object.entries(loadStationHistory())) entities[`station:${code}`] = station;
  const dir = path.join(DATA_DIR, "trains");
  for (const file of fs.readdirSync(dir).filter(f => /^history_.*\.jsonl$/.test(f)).sort()) {
    for (const line of fs.readFileSync(path.join(dir, file), "utf8").split("\n").filter(Boolean)) {
      const train = JSON.parse(line);
      entities[`train:${train.code}`] = train;
    }
  }
  return entities;
};

/** Immutable content-addressed packs; publish manifest last, only after git push. */
export function publishFeed(metadata: Record<string, unknown>) {
  const dir = path.join(DATA_DIR, "feed");
  fs.mkdirSync(path.join(dir, "packs"), { recursive: true });
  const manifestPath = path.join(dir, "manifest.json");
  const statePath = path.join(dir, "fingerprints.json");
  const previous = fs.existsSync(manifestPath) ? JSON.parse(fs.readFileSync(manifestPath, "utf8")) : null;
  const previousHashes = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, "utf8")) : {};
  const entities = readEntities();
  for (const key of Object.keys(previousHashes)) {
    if (!(key in entities)) throw new Error(`Refusing history deletion: ${key}`);
  }
  const hashes = Object.fromEntries(Object.entries(entities).map(([k,v]) => [k, sha256(JSON.stringify(v))]));
  const upserts = Object.entries(entities).filter(([k]) => hashes[k] !== previousHashes[k]).map(([key,value]) => ({key,value}));
  if (!upserts.length && previous) return previous;
  const sequence = (previous?.sequence ?? 0) + 1;
  const pack = (rows: typeof upserts, full: boolean) => {
    const compressed = gzipSync(JSON.stringify({schema_version: 1, sequence, full, upserts: rows}));
    const hash = sha256(compressed);
    const file = `packs/${hash}.json.gz`;
    fs.writeFileSync(path.join(dir, file), compressed);
    return { sequence, file, sha256: hash, bytes: compressed.length };
  };
  const delta = pack(upserts, false);
  const snapshot = pack(Object.entries(entities).map(([key,value]) => ({key,value})), true);
  const stations = Object.entries(entities).filter(([key])=>key.startsWith('station:'));
  const trains = Object.entries(entities).filter(([key])=>key.startsWith('train:'));
  const coverage = {stations:stations.length, trains:trains.length,
    trains_with_timetable:trains.filter(([,v])=>(v as any).versions.some((version:any)=>version.s.length>0)).length};
  const manifest = {schema_version: 1, sequence, generated_at: new Date().toISOString(), metadata,
    coverage, snapshot, deltas: [...(previous?.deltas ?? []), delta]};
  for (const [file, value] of [[statePath, hashes], [manifestPath, manifest]] as const) {
    fs.writeFileSync(file + ".tmp", JSON.stringify(value, null, 2));
    fs.renameSync(file + ".tmp", file);
  }
  return manifest;
}
