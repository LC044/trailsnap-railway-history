import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {gunzipSync} from 'node:zlib';
import {DATA_DIR, SNAPSHOT_DIR} from './history/store';
import {sha256, snapshotPath, snapshotTag} from './history/feed';

type Command = (program: string, args: string[]) => string;
const execute: Command = (program, args) => execFileSync(program, args, {encoding:'utf8'});

/** Publish and verify the immutable asset BEFORE exposing its manifest via git. */
export function releaseFeed(run: Command = execute) {
  const manifestPath = path.join(DATA_DIR, 'feed/manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const snapshot = manifest.snapshot;
  const digest = snapshot.sha256;
  const tag = snapshotTag(digest);
  const asset = `${digest}.json.gz`;
  const expected = `https://github.com/LC044/trailsnap-railway-history/releases/download/${tag}/${asset}`;
  if (manifest.schema_version !== 2 || !/^[a-f0-9]{64}$/.test(digest) ||
      snapshot.file !== `packs/${asset}` || snapshot.url !== expected) throw new Error('Invalid Release snapshot descriptor');
  const verify = (file: string) => {
    const raw = fs.readFileSync(file);
    if (raw.length !== snapshot.bytes || sha256(raw) !== digest) throw new Error('Release snapshot checksum/size mismatch');
    const pack = JSON.parse(gunzipSync(raw).toString());
    if (pack.schema_version !== 2 || pack.full !== true || pack.sequence !== manifest.sequence) throw new Error('Invalid full snapshot');
  };
  let release: any = null;
  try { release = JSON.parse(run('gh', ['release','view',tag,'--json','isDraft,assets'])); }
  catch { /* A failed create below is fatal too; auth errors cannot publish a manifest. */ }
  if (!release) {
    verify(snapshotPath(snapshot));
    const target = run('git',['rev-parse','HEAD']).trim();
    run('gh', ['release','create',tag,snapshotPath(snapshot),manifestPath,'--target',target,'--latest=false',
      '--title',`Railway history v2 · ${manifest.sequence}`,'--notes',
      `Complete retained history. Sequence ${manifest.sequence}; SHA-256 ${digest}. Coverage is recorded in the feed manifest; partial observations never imply cancellation.`]);
  } else if (!release.assets.some((item: any) => item.name === asset)) {
    verify(snapshotPath(snapshot));
    run('gh',['release','upload',tag,snapshotPath(snapshot)]);
  }
  fs.mkdirSync(SNAPSHOT_DIR, {recursive:true});
  const verification = fs.mkdtempSync(path.join(SNAPSHOT_DIR,'release-verify-'));
  // Verify bytes served by GitHub, including when recovering an existing release.
  run('gh',['release','download',tag,'--pattern',asset,'--dir',verification]);
  verify(path.join(verification, asset));
  if (release?.isDraft) run('gh',['release','edit',tag,'--draft=false']);
  run('git',['config','user.name','github-actions[bot]']);
  run('git',['config','user.email','github-actions[bot]@users.noreply.github.com']);
  run('git',['add','data/','assets/station_gps.json']);
  const packs = run('git',['diff','--cached','--name-only','--diff-filter=AM','--','data/feed/packs/']).trim().split('\n').filter(Boolean);
  for (const file of packs) {
    if (JSON.parse(gunzipSync(fs.readFileSync(file)).toString()).full === true) throw new Error('Refusing to commit a full snapshot to git');
  }
  if (run('git',['diff','--cached','--name-only']).trim()) {
    run('git',['commit','-m',`data: railway observation ${new Date().toISOString()}`]);
    run('git',['push']);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) releaseFeed();
