'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Store } = require('../../server/store.js');

function tmp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'af store test '));
  const seed = path.join(dir, 'seed.json');
  fs.writeFileSync(seed, JSON.stringify({ users: [{ id: 'u1' }], flows: [] }));
  return { dir, seed, file: path.join(dir, 'db.json'), backupDir: path.join(dir, 'backups') };
}

test('init copies the seed when db.json does not exist', () => {
  const t = tmp();
  const s = new Store({ file: t.file, backupDir: t.backupDir, seedFile: t.seed });
  s.init();
  assert.deepEqual(s.data.users, [{ id: 'u1' }]);
  assert.ok(fs.existsSync(t.file));
});

test('save is atomic: data persists across instances and no temp file is left', () => {
  const t = tmp();
  const s = new Store({ file: t.file, backupDir: t.backupDir, seedFile: t.seed });
  s.init();
  s.data.flows.push({ id: 'f1' });
  s.save();
  const left = fs.readdirSync(t.dir).filter(n => n.includes('.tmp'));
  assert.deepEqual(left, []);
  const s2 = new Store({ file: t.file, backupDir: t.backupDir, seedFile: t.seed });
  s2.init();
  assert.deepEqual(s2.data.flows, [{ id: 'f1' }]);
});

test('rolling backups never exceed maxBackups and keep the newest', () => {
  const t = tmp();
  let now = 1_700_000_000_000;
  const s = new Store({ file: t.file, backupDir: t.backupDir, seedFile: t.seed, maxBackups: 3, backupIntervalMs: 0, now: () => (now += 1000) });
  s.init();
  for (let i = 0; i < 8; i++) { s.data.flows.push({ id: 'f' + i }); s.save(); }
  const files = fs.readdirSync(t.backupDir).sort();
  assert.equal(files.length, 3);
});

test('backups are throttled by backupIntervalMs', () => {
  const t = tmp();
  let now = 1_700_000_000_000;
  const s = new Store({ file: t.file, backupDir: t.backupDir, seedFile: t.seed, maxBackups: 10, backupIntervalMs: 60_000, now: () => now });
  s.init();
  for (let i = 0; i < 5; i++) { s.data.flows.push({ id: 'f' + i }); s.save(); now += 1000; }
  assert.ok(fs.readdirSync(t.backupDir).length <= 1);
});

test('a corrupted db.json is restored from the newest backup', () => {
  const t = tmp();
  let now = 1_700_000_000_000;
  const s = new Store({ file: t.file, backupDir: t.backupDir, seedFile: t.seed, backupIntervalMs: 0, now: () => (now += 1000) });
  s.init();
  s.data.flows.push({ id: 'keep-me' }); s.save();
  s.data.flows.push({ id: 'second' }); s.save();
  fs.writeFileSync(t.file, '{ broken json');
  const s2 = new Store({ file: t.file, backupDir: t.backupDir, seedFile: t.seed });
  s2.init();
  assert.ok(s2.data.flows.some(f => f.id === 'keep-me'));
  assert.equal(s2.recovered, true);
});

test('a corrupted db.json with no backup raises a readable error instead of wiping data', () => {
  const t = tmp();
  fs.writeFileSync(t.file, 'garbage');
  const s = new Store({ file: t.file, backupDir: t.backupDir, seedFile: t.seed });
  assert.throws(() => s.init(), /db\.json is corrupted/);
  assert.equal(fs.readFileSync(t.file, 'utf8'), 'garbage');
});

test('a corrupted db.json is kept aside as db.json.corrupt-* when restoring', () => {
  const t = tmp();
  const s = new Store({ file: t.file, backupDir: t.backupDir, seedFile: t.seed, backupIntervalMs: 0 });
  s.init(); s.data.flows.push({ id: 'x' }); s.save(); s.save();
  fs.writeFileSync(t.file, '{ broken');
  new Store({ file: t.file, backupDir: t.backupDir, seedFile: t.seed }).init();
  const kept = fs.readdirSync(t.dir).filter(n => n.startsWith('db.json.corrupt-'));
  assert.equal(kept.length, 1);
  assert.equal(fs.readFileSync(path.join(t.dir, kept[0]), 'utf8'), '{ broken');
});

test('replace() always takes a backup first (even inside the throttle window) and rolls back if the write fails', () => {
  const t = tmp();
  const s = new Store({ file: t.file, backupDir: t.backupDir, seedFile: t.seed, backupIntervalMs: 3600000 });
  s.init(); s.data.flows.push({ id: 'before-import' }); s.save();
  const countBefore = fs.existsSync(t.backupDir) ? fs.readdirSync(t.backupDir).length : 0;
  s.replace({ users: [], flows: [{ id: 'after' }] });
  const files = fs.readdirSync(t.backupDir);
  assert.equal(files.length, countBefore + 1, 'forced backup even though the interval has not passed');
  const newest = JSON.parse(fs.readFileSync(path.join(t.backupDir, files.sort().pop()), 'utf8'));
  assert.ok(newest.flows.some(f => f.id === 'before-import'), 'the backup holds the data from before the replace');
  const keep = s.data;
  s._writeAtomic = () => { throw new Error('disk full'); };
  assert.throws(() => s.replace({ users: [], flows: [{ id: 'never' }] }), /disk full/);
  assert.equal(s.data, keep, 'in-memory data is restored when the write fails');
});

test('valid JSON that lacks collections gets every collection as an empty array', () => {
  const t = tmp();
  fs.writeFileSync(t.file, '{}');
  const s = new Store({ file: t.file, backupDir: t.backupDir, seedFile: t.seed }).init();
  for (const c of ['users', 'sessions', 'flows', 'loginEvents', 'tenants']) assert.deepEqual(s.data[c], []);
});

test('replace() swaps the whole dataset after validating collections are objects', () => {
  const t = tmp();
  const s = new Store({ file: t.file, backupDir: t.backupDir, seedFile: t.seed });
  s.init();
  assert.throws(() => s.replace('nope'), /invalid/i);
  assert.throws(() => s.replace({ users: 'x' }), /invalid/i);
  s.replace({ users: [], flows: [{ id: 'z' }] });
  assert.equal(s.data.flows[0].id, 'z');
});

test('saveSoon batches many changes into one write, and flush writes pending changes now', async () => {
  const t = tmp();
  const s = new Store({ file: t.file, backupDir: t.backupDir, seedFile: t.seed, debounceMs: 30 }).init();
  let writes = 0; const orig = s._writeAtomic.bind(s); s._writeAtomic = () => { writes += 1; orig(); };
  for (let i = 0; i < 20; i++) { s.data.users.push({ id: 'x' + i }); s.saveSoon(); }
  assert.equal(writes, 0, 'nothing is written inside the window');
  assert.equal(s.hasPendingWrite(), true);
  await new Promise(r => setTimeout(r, 80));
  assert.equal(writes, 1); assert.equal(s.hasPendingWrite(), false);
  assert.equal(JSON.parse(fs.readFileSync(t.file, 'utf8')).users.length, 21);
  s.data.users.push({ id: 'late' }); s.saveSoon(); s.flush();
  assert.equal(writes, 2); assert.ok(JSON.parse(fs.readFileSync(t.file, 'utf8')).users.some(u => u.id === 'late'));
  s.flush(); assert.equal(writes, 2, 'flush with nothing pending does nothing');
});

test('a normal save() also covers pending changes, so a later timer does not write twice', async () => {
  const t = tmp();
  const s = new Store({ file: t.file, backupDir: t.backupDir, seedFile: t.seed, debounceMs: 20 }).init();
  let writes = 0; const orig = s._writeAtomic.bind(s); s._writeAtomic = () => { writes += 1; orig(); };
  s.data.users.push({ id: 'a' }); s.saveSoon(); s.save();
  assert.equal(writes, 1);
  await new Promise(r => setTimeout(r, 60));
  assert.equal(writes, 1);
});

test('a failed delayed write keeps the change pending and is reported, never thrown into the event loop', async () => {
  const t = tmp(); const errors = [];
  const s = new Store({ file: t.file, backupDir: t.backupDir, seedFile: t.seed, debounceMs: 10, onError: e => errors.push(e.message) }).init();
  const orig = s._writeAtomic.bind(s); let fail = true; s._writeAtomic = () => { if (fail) throw new Error('disk full'); orig(); };
  s.data.users.push({ id: 'keep' }); s.saveSoon();
  await new Promise(r => setTimeout(r, 40));
  assert.deepEqual(errors.slice(0, 1), ['disk full']); assert.equal(s.hasPendingWrite(), true);
  fail = false; s.flush();
  assert.ok(JSON.parse(fs.readFileSync(t.file, 'utf8')).users.some(u => u.id === 'keep'));
});
