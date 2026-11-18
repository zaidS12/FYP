'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { SharedCollab } = require('../../server/live-sync.js');
const { Collab } = require('../../server/services/collab.js');

/** Fake PostgREST table with insert-ignore, select, and compare-and-swap PATCH on data->>v. */
function fakeTable() {
  const rows = new Map(); const stats = { patches: 0, conflicts: 0 };
  const fetchImpl = async (url, opts) => {
    const u = new URL(url); const reply = (status, body) => ({ ok: status < 300, status, json: async () => body, text: async () => JSON.stringify(body) });
    if (opts.headers.apikey !== 'k') return reply(401, {});
    const id = (u.searchParams.get('id') || '').replace('eq.', '');
    if (opts.method === 'GET') return reply(200, rows.has(id) ? [{ data: rows.get(id) }] : []);
    const body = JSON.parse(opts.body);
    if (opts.method === 'POST') { if (!rows.has(body.id)) rows.set(body.id, body.data); return reply(201, []); }
    if (opts.method === 'PATCH') {
      stats.patches += 1;
      const want = [...u.searchParams.entries()].find(([k]) => k === 'data->>v');
      const cur = rows.get(id);
      if (!cur || (want && String(cur.v) !== want[1].replace('eq.', ''))) { stats.conflicts += 1; return reply(200, []); }
      rows.set(id, body.data); return reply(200, [{ data: body.data }]);
    }
    return reply(405, {});
  };
  return { rows, stats, fetchImpl };
}
const mk = (t, now) => new SharedCollab({ url: 'https://x/rest/v1/agentflow_state', key: 'k', fetchImpl: t.fetchImpl, now, cacheMs: 0 });
const who = (client, name, extra) => Object.assign({ client_id: client, user_id: 'u_' + client, name, as_name: null, can_edit: true }, extra || {});

test('Collab state round-trips through plain JSON, including stop requests with an expiry', () => {
  let t = 1000; const a = new Collab({ now: () => t });
  a.heartbeat('f1', who('c1', 'Ana'), { node_id: 'n1' }); a.acquire('f1', 'n1', who('c1', 'Ana')); a.claim('c1', 'u_c1'); a.requestStop('run_1');
  const copy = JSON.parse(JSON.stringify(a.toState()));
  const b = new Collab({ now: () => t }); b.loadState(copy);
  assert.deepEqual(b.snapshot('f1'), a.snapshot('f1')); assert.equal(b.claim('c1', 'someone-else'), false); assert.equal(b.stopRequested('run_1'), true);
  t += 11 * 60 * 1000; assert.equal(b.stopRequested('run_1'), false, 'stop requests expire');
});

test('presence and locks made on one instance are seen on another', async () => {
  const t = fakeTable(); const a = mk(t); const b = mk(t);
  await a.heartbeat('f1', who('ca', 'Ana'), { node_id: 'n3' });
  assert.equal((await a.acquire('f1', 'n3', who('ca', 'Ana'))).ok, true);
  const seen = await b.snapshot('f1');
  assert.deepEqual(seen.presence.map(p => p.name), ['Ana']); assert.equal(seen.locks[0].node_id, 'n3');
  const refused = await b.acquire('f1', 'n3', who('cb', 'Omar'));
  assert.equal(refused.ok, false); assert.equal(refused.holder.name, 'Ana');
  assert.deepEqual((await b.lockedByOthers('f1', ['n3'], 'cb', 'u_cb')).map(l => l.node_id), ['n3']);
});

test('two instances racing for the same card: exactly one wins, nobody loses a heartbeat', async () => {
  const t = fakeTable(); const a = mk(t); const b = mk(t);
  const [ra, rb] = await Promise.all([a.acquire('f1', 'n1', who('ca', 'Ana')), b.acquire('f1', 'n1', who('cb', 'Omar'))]);
  assert.equal([ra, rb].filter(r => r.ok).length, 1);
  await Promise.all([a.heartbeat('f1', who('ca', 'Ana'), {}), b.heartbeat('f1', who('cb', 'Omar'), {})]);
  const snap = await mk(t).snapshot('f1');
  assert.deepEqual(snap.presence.map(p => p.name).sort(), ['Ana', 'Omar']);
});

test('release, leave and claim are shared; a borrowed client id is refused on every instance', async () => {
  const t = fakeTable(); const a = mk(t); const b = mk(t);
  assert.equal(await a.claim('c1', 'u1'), true); assert.equal(await b.claim('c1', 'u2'), false); assert.equal(await b.claim('c1', 'u1'), true);
  await a.acquire('f1', 'n1', who('c1', 'Ana', { user_id: 'u1' }));
  assert.equal(await b.release('f1', 'n1', 'someone-else'), false);
  assert.equal(await b.release('f1', 'n1', 'c1'), true);
  assert.equal((await a.snapshot('f1')).locks.length, 0);
  await a.heartbeat('f1', who('c1', 'Ana', { user_id: 'u1' }), {}); assert.equal(await b.leave('f1', 'c1'), true);
  assert.equal((await a.snapshot('f1')).presence.length, 0);
});

test('a stop request made on one instance is seen by the instance that runs the flow', async () => {
  const t = fakeTable(); const runner = mk(t); const clicker = mk(t);
  assert.equal(await runner.stopRequested('run_9'), false);
  await clicker.requestStop('run_9');
  assert.equal(await runner.stopRequested('run_9'), true); assert.equal(await runner.stopRequested('run_other'), false);
});

test('an unreadable store is an error, never an empty state', async () => {
  const bad = new SharedCollab({ url: 'https://x/rest/v1/t', key: 'WRONG', fetchImpl: fakeTable().fetchImpl, cacheMs: 0 });
  await assert.rejects(() => bad.snapshot('f1'), /401/);
});
