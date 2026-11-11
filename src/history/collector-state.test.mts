import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {gzipSync, gunzipSync} from 'node:zlib';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'railway-state-test-'));
process.env.DATA_DIR = path.join(root, 'data');
process.env.SNAPSHOT_DIR = path.join(root, 'snapshot');
const store = await import('./store');
const {publishFeed, snapshotPath, sha256} = await import('./feed');
const {makeVersion, mergeTrain} = await import('./merge');
const {prepareCollectorState, verifyCollectorState, restoreCollectorState, statePointer} = await import('./collector-state');
const {releaseFeed} = await import('../release-feed');

function reset() {
  fs.rmSync(store.DATA_DIR, {recursive: true, force: true});
  store.ensureDirs();
  const stations = {};
  store.updateStationHistory(stations, [{name: '站甲', tele_code: 'AAA', pinyin: 'a', pinyin_short: 'a', city: '甲'}], '2026-11-10');
  store.saveStationHistory(stations);
  const entry = {code: 'G1', versions: [] as any[]};
  mergeTrain(entry, makeVersion('n', '站甲', '站乙', [{n: '站甲', c: 'AAA', a: null, d: '08:00', dd: 0}], '2026-11-10', {source: 'original'}), '2026-11-10');
  store.saveClassHistory('G', new Map([['G1', entry]]));
  return {manifest: publishFeed({query_date: '2026-11-10'}), stations, entry};
}

test('Release checkpoint restores exact raw history and fingerprints; next date publishes only the new observation', () => {
  const {manifest, entry} = reset();
  const state = prepareCollectorState(manifest);
  const raw = fs.readFileSync(state.localPath);
  const original = verifyCollectorState(raw, state.descriptor, manifest);
  fs.writeFileSync(statePointer, JSON.stringify(state.descriptor));
  fs.unlinkSync(store.classFile('G'));
  fs.unlinkSync(path.join(store.DATA_DIR, 'stations/station_history.json'));
  fs.unlinkSync(path.join(store.DATA_DIR, 'feed/fingerprints.json'));
  const download = (_program: string, args: string[]) => {
    fs.writeFileSync(path.join(args[args.indexOf('--dir') + 1], state.descriptor.file), raw);
    return '';
  };
  restoreCollectorState(download);
  for (const [name, text] of Object.entries(original)) assert.equal(fs.readFileSync(path.join(store.DATA_DIR, name), 'utf8'), text);
  assert.equal(publishFeed({}).sequence, manifest.sequence);
  const resumed = store.loadClassHistory('G');
  mergeTrain(resumed.get('G1')!, entry.versions[0], '2026-11-11');
  store.saveClassHistory('G', resumed);
  const next = publishFeed({query_date: '2026-11-11'});
  assert.equal(next.sequence, manifest.sequence + 1);
  const delta = JSON.parse(gunzipSync(fs.readFileSync(path.join(store.DATA_DIR, 'feed', next.compact_deltas.at(-1)!.file))).toString());
  assert.deepEqual(delta.train_versions, []);
  assert.deepEqual(delta.observations[0].dates, ['2026-11-11']);
  const full = JSON.parse(gunzipSync(fs.readFileSync(snapshotPath(next.snapshot))).toString());
  assert.deepEqual(full.observations[0].dates, ['2026-11-10', '2026-11-11']);
});

test('missing, corrupt, mismatched or unsafe checkpoints abort without changing local history', () => {
  const {manifest} = reset();
  const state = prepareCollectorState(manifest);
  const raw = fs.readFileSync(state.localPath);
  const trainBefore = fs.readFileSync(store.classFile('G'), 'utf8');
  fs.writeFileSync(statePointer, JSON.stringify(state.descriptor));
  assert.throws(() => restoreCollectorState(() => {throw new Error('download failed');}), /download failed/);
  assert.throws(() => restoreCollectorState((_program, args) => {
    fs.writeFileSync(path.join(args[args.indexOf('--dir') + 1], state.descriptor.file), 'corrupt'); return '';
  }), /checksum/);
  assert.equal(fs.readFileSync(store.classFile('G'), 'utf8'), trainBefore);
  assert.throws(() => verifyCollectorState(raw, state.descriptor, {...manifest, sequence: manifest.sequence + 1}), /does not match feed/);
  const payload = JSON.parse(gunzipSync(raw).toString());
  payload.files['../escape'] = 'unsafe';
  let bad = gzipSync(JSON.stringify(payload));
  let descriptor = {...state.descriptor, file: `collector-state-${sha256(bad)}.json.gz`, sha256: sha256(bad), bytes: bad.length};
  assert.throws(() => verifyCollectorState(bad, descriptor, manifest), /Invalid collector state files/);
  delete payload.files['../escape']; delete payload.files['trains/history_G.jsonl'];
  bad = gzipSync(JSON.stringify(payload));
  descriptor = {...descriptor, file: `collector-state-${sha256(bad)}.json.gz`, sha256: sha256(bad), bytes: bad.length};
  assert.throws(() => verifyCollectorState(bad, descriptor, manifest), /fingerprints do not match versions/);
  fs.unlinkSync(statePointer);
  restoreCollectorState(() => assert.fail('legacy migration must not download'));
  fs.unlinkSync(store.classFile('G'));
  assert.throws(() => restoreCollectorState(() => ''), /fingerprints do not match versions/);
});

test('real Git migration removes raw state only after verified uploads; next publication changes only feed metadata and delta', () => {
  const {manifest, entry} = reset();
  process.chdir(root);
  const git = (args: string[]) => execFileSync('git', args, {cwd: root, encoding: 'utf8'});
  git(['init', '-b', 'main']);
  git(['config', 'user.name', 'test']); git(['config', 'user.email', 'test@example.invalid']);
  git(['config', 'core.hooksPath', path.join(root, 'no-hooks')]);
  fs.mkdirSync(path.join(root, 'assets'));
  fs.writeFileSync(path.join(root, 'assets/station_gps.json'), '{}');
  fs.writeFileSync(path.join(root, '.gitignore'), 'snapshot/\ndata/stations/\ndata/trains/\ndata/feed/fingerprints.json\n');
  git(['add', '.']);
  git(['add', '-f', 'data/stations', 'data/trains', 'data/feed/fingerprints.json']);
  git(['commit', '-m', 'baseline']);
  const remote = fs.mkdtempSync(path.join(os.tmpdir(), 'railway-test-remote-'));
  execFileSync('git', ['init', '--bare', remote]);
  git(['remote', 'add', 'origin', remote]); git(['push', '-u', 'origin', 'main']);
  const assets = new Map<string, Buffer>();
  let exists = false, corruptState = true, failStateUpload = false;
  const run = (program: string, args: string[]) => {
    if (program === 'git') return git(args);
    if (args[1] === 'view') {if (!exists) throw new Error('missing'); return JSON.stringify({isDraft: false, assets: Array.from(assets.keys(), name => ({name}))});}
    if (args[1] === 'create') {
      exists = true;
      assets.set(path.basename(args[3]), fs.readFileSync(args[3]));
    }
    if (args[1] === 'upload') {
      if (failStateUpload) throw new Error('state upload failed');
      assets.set(path.basename(args[3]), fs.readFileSync(args[3]));
    }
    if (args[1] === 'download') {
      const name = args[args.indexOf('--pattern') + 1];
      fs.writeFileSync(path.join(args[args.indexOf('--dir') + 1], name),
        corruptState && name.startsWith('collector-state-') ? Buffer.from('corrupt') : assets.get(name)!);
    }
    return '';
  };
  assert.throws(() => releaseFeed(run), /checksum/);
  assert.match(git(['ls-files', 'data/trains/']), /history_G/);
  assert.ok(!fs.existsSync(statePointer));
  corruptState = false;
  releaseFeed(run);
  assert.equal(git(['ls-files', 'data/stations/', 'data/trains/', 'data/feed/fingerprints.json']), '');
  assert.ok(fs.existsSync(store.classFile('G')));
  assert.equal(JSON.parse(fs.readFileSync(statePointer, 'utf8')).sequence, manifest.sequence);
  // A shallow clone has no raw state and recovers solely from the verified Release.
  fs.unlinkSync(store.classFile('G')); fs.unlinkSync(path.join(store.DATA_DIR, 'feed/fingerprints.json'));
  fs.unlinkSync(path.join(store.DATA_DIR, 'stations/station_history.json'));
  restoreCollectorState(run);
  const resumed = store.loadClassHistory('G');
  mergeTrain(resumed.get('G1')!, entry.versions[0], '2026-11-11');
  store.saveClassHistory('G', resumed);
  const next = publishFeed({query_date: '2026-11-11'});
  failStateUpload = true;
  assert.throws(() => releaseFeed(run), /state upload failed/);
  assert.equal(JSON.parse(fs.readFileSync(statePointer, 'utf8')).sequence, manifest.sequence);
  failStateUpload = false;
  releaseFeed(run);
  const changes = git(['diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD']).trim().split('\n');
  assert.deepEqual(changes.sort(), ['data/collector-state.json', 'data/feed/manifest.json', `data/feed/${next.compact_deltas.at(-1)!.file}`].sort());
  const head = git(['rev-parse', 'HEAD']).trim();
  releaseFeed(run);
  assert.equal(git(['rev-parse', 'HEAD']).trim(), head, 'no-op publication must not create another Git commit');
});
