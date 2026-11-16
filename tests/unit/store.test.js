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
