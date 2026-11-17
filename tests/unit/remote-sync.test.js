'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pull, createPusher } = require('../../server/remote-sync.js');
const { Store } = require('../../server/store.js');

const CFG = { url: 'https://proj.supabase.co/rest/v1/agentflow_state', key: 'service-secret', id: 'main' };
const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'af remote test ')), 'data', 'db.json');
const resp = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) });

test('pull writes the stored database to the local file so the normal startup loads it', async () => {
  const file = tmpFile(); const calls = [];
  const fetchImpl = async (url, opts) => { calls.push({ url, opts }); return resp(200, [{ data: { users: [{ id: 'u1' }], flows: [] } }]); };
  const r = await pull({ ...CFG, file, fetchImpl });
  assert.equal(r.restored, true);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).users, [{ id: 'u1' }]);
  assert.match(calls[0].url, /\?id=eq\.main&select=data$/);
  assert.equal(calls[0].opts.headers.apikey, 'service-secret'); assert.equal(calls[0].opts.headers.Authorization, 'Bearer service-secret');
});

test('pull with nothing stored yet leaves the local file alone (first start uses the seed)', async () => {
  const file = tmpFile();
  const r = await pull({ ...CFG, file, fetchImpl: async () => resp(200, []) });
  assert.equal(r.restored, false); assert.equal(fs.existsSync(file), false);
});

test('pull failures are reported, never silently treated as "empty" (that would overwrite real data later)', async () => {
  await assert.rejects(() => pull({ ...CFG, file: tmpFile(), fetchImpl: async () => resp(401, { message: 'bad key' }) }), /401/);
  await assert.rejects(() => pull({ ...CFG, file: tmpFile(), fetchImpl: async () => { throw new Error('offline'); } }), /offline/);
});

test('the pusher upserts the newest text, coalescing a burst into few requests, and drain waits for it', async () => {
  const sent = [];
  const p = createPusher({ ...CFG, delayMs: 20, fetchImpl: async (url, opts) => { sent.push({ url, opts, body: JSON.parse(opts.body) }); return resp(201, {}); } });
  for (let i = 1; i <= 10; i++) p.push(JSON.stringify({ n: i }));
  await p.drain();
  assert.ok(sent.length <= 2, 'burst coalesced, got ' + sent.length);
  assert.deepEqual(sent[sent.length - 1].body.data, { n: 10 }); assert.equal(sent[0].body.id, 'main');
  assert.match(sent[0].url, /\?on_conflict=id$/); assert.match(sent[0].opts.headers.Prefer, /resolution=merge-duplicates/);
  assert.equal(p.pending(), false);
});

test('a failed upload is retried with the latest data and reported through onError', async () => {
  let n = 0; const errors = [];
  const p = createPusher({ ...CFG, delayMs: 5, retryMs: 10, onError: e => errors.push(e.message), fetchImpl: async () => { n += 1; return n < 3 ? resp(503, {}) : resp(201, {}); } });
  p.push(JSON.stringify({ keep: true }));
  await p.drain();
  assert.equal(n, 3); assert.equal(errors.length, 2); assert.equal(p.pending(), false);
});

test('Store calls afterWrite with the exact text it wrote, for saves and delayed saves', async () => {
  const file = tmpFile(); const seed = path.join(path.dirname(file), 'seed.json'); fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(seed, JSON.stringify({ users: [] })); const texts = [];
  const s = new Store({ file, backupDir: path.join(path.dirname(file), 'b'), seedFile: seed, debounceMs: 5, afterWrite: t => texts.push(t) }).init();
  const afterInit = texts.length;
  s.data.users.push({ id: 'a' }); s.save();
  s.data.users.push({ id: 'b' }); s.saveSoon(); await new Promise(r => setTimeout(r, 40));
  assert.equal(texts.length, afterInit + 2);
  assert.equal(texts[texts.length - 1], fs.readFileSync(file, 'utf8'));
});
