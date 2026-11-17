'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createServer } = require('../../server.js');

const PW = 'AgentFlow#2026';
let srv, base, ip = 0;

test.before(async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'af collab test '));
  srv = createServer({ dataDir, trustProxy: true, stepDelayMs: 0, seedFile: path.join(__dirname, '..', '..', 'data', 'seed.json') });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  base = 'http://127.0.0.1:' + srv.address().port;
});
test.after(() => new Promise(r => srv.close(r)));

async function api(p, { method = 'GET', body, cookie } = {}) {
  const headers = {}; if (body !== undefined) headers['Content-Type'] = 'application/json'; if (cookie) headers.Cookie = cookie;
  const res = await fetch(base + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text(); let json = null; try { json = JSON.parse(text); } catch { /* none */ }
  return { status: res.status, json };
}
async function login(email) {
  const res = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '10.7.0.' + (++ip % 250) }, body: JSON.stringify({ email, password: PW }) });
  return (res.headers.get('set-cookie') || '').split(';')[0];
}
const post = (cookie, p, body) => api(p, { method: 'POST', cookie, body });

/** A shared flow in Brightloom with three cards, so two people can edit it. */
async function sharedFlow(cookie) {
  const made = await api('/api/flows', { method: 'POST', cookie, body: { name: 'Co-work ' + Math.random().toString(36).slice(2, 7) } });
  const f = made.json.flow;
  const nodes = [...f.nodes, { id: 'n3', type: 'summarize', label: 'Summ', x: 200, y: 300, config: {} }, { id: 'n4', type: 'translate', label: 'Trans', x: 400, y: 300, config: { target_language: 'Urdu' } }];
  const saved = await api('/api/flows/' + f.id, { method: 'PATCH', cookie, body: { nodes, edges: f.edges, base_version: 1, shared: true } });
  assert.equal(saved.status, 200);
  await api('/api/flows/' + f.id, { method: 'PATCH', cookie, body: { shared: true } });
  return saved.json.flow;
}

/** Opens the SSE stream and resolves events as they arrive. */
async function openStream(cookie, flowId, client) {
  const ctl = new AbortController();
  const res = await fetch(`${base}/api/flows/${flowId}/events?client=${client}`, { headers: { Cookie: cookie }, signal: ctl.signal });
  assert.equal(res.status, 200); assert.match(res.headers.get('content-type'), /text\/event-stream/);
  const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = ''; const events = [];
  (async () => {
    try { for (;;) { const { value, done } = await reader.read(); if (done) break; buf += dec.decode(value, { stream: true }); let i; while ((i = buf.indexOf('\n\n')) >= 0) { const raw = buf.slice(0, i); buf = buf.slice(i + 2); const ev = /event: (\w+)/.exec(raw); const data = /data: (.*)/.exec(raw); if (ev && data) events.push({ event: ev[1], data: JSON.parse(data[1]) }); } } } catch { /* aborted */ }
  })();
  const waitFor = async (pred, ms = 3000) => { const t = Date.now(); while (Date.now() - t < ms) { const hit = events.find(pred); if (hit) return hit; await new Promise(r => setTimeout(r, 20)); } throw new Error('event did not arrive; got ' + JSON.stringify(events.map(e => e.event))); };
  return { events, waitFor, close: () => ctl.abort() };
}

test('collab endpoints need sign-in and the flow must be visible to you', async () => {
  const ana = await login('ana@brightloom.test'); const f = await sharedFlow(ana);
  assert.equal((await api(`/api/flows/${f.id}/collab`)).status, 401);
  assert.equal((await api(`/api/flows/${f.id}/events?client=abcdef`)).status, 401);
  const sam = await login('solo@example.test');
  assert.equal((await api(`/api/flows/${f.id}/collab`, { cookie: sam })).status, 404);
  assert.equal((await post(sam, `/api/flows/${f.id}/collab/heartbeat`, { client_id: 'solotab01' })).status, 404);
  assert.equal((await post(ana, `/api/flows/${f.id}/collab/heartbeat`, { client_id: 'x' })).status, 400, 'client id must look like an id');
});

test('presence: two colleagues see each other and the card each is on; leaving removes them', async () => {
  const ana = await login('ana@brightloom.test'); const omar = await login('omar@brightloom.test'); const f = await sharedFlow(ana);
  await post(ana, `/api/flows/${f.id}/collab/heartbeat`, { client_id: 'ana-tab-1', node_id: 'n3' });
  const r = await post(omar, `/api/flows/${f.id}/collab/heartbeat`, { client_id: 'omar-tab-1' });
  assert.deepEqual(r.json.presence.map(p => p.name).sort(), ['Ana Torres', 'Omar Siddiqui']);
  assert.equal(r.json.presence.find(p => p.name === 'Ana Torres').node_id, 'n3');
  await post(omar, `/api/flows/${f.id}/collab/leave`, { client_id: 'omar-tab-1' });
  assert.equal((await api(`/api/flows/${f.id}/collab`, { cookie: ana })).json.presence.length, 1);
});

test('locks: one editor per card; the saves of others on that card are refused, other cards still save and merge', async () => {
  const ana = await login('ana@brightloom.test'); const omar = await login('omar@brightloom.test'); const f = await sharedFlow(ana);
  assert.equal((await post(ana, `/api/flows/${f.id}/collab/lock`, { client_id: 'ana-tab-1', node_id: 'n3' })).status, 200);
  const clash = await post(omar, `/api/flows/${f.id}/collab/lock`, { client_id: 'omar-tab-1', node_id: 'n3' });
  assert.equal(clash.status, 409); assert.match(clash.json.error, /Ana Torres is editing this card/);

  const edited = f.nodes.map(n => (n.id === 'n3' ? Object.assign({}, n, { label: 'Omar edit' }) : n));
  const refused = await api('/api/flows/' + f.id, { method: 'PATCH', cookie: omar, body: { nodes: edited, edges: f.edges, base_version: f.version, client_id: 'omar-tab-1' } });
  assert.equal(refused.status, 423); assert.equal(refused.json.code, 'locked'); assert.equal(refused.json.locked[0].node_id, 'n3');

  const free = f.nodes.map(n => (n.id === 'n4' ? Object.assign({}, n, { label: 'Omar edit 4' }) : n));
  const okSave = await api('/api/flows/' + f.id, { method: 'PATCH', cookie: omar, body: { nodes: free, edges: f.edges, base_version: f.version, client_id: 'omar-tab-1' } });
  assert.equal(okSave.status, 200);

  // Ana's own save of her locked card works even though the flow moved on: merged card by card.
  const mine = f.nodes.map(n => (n.id === 'n3' ? Object.assign({}, n, { label: 'Ana edit' }) : n));
  const merged = await api('/api/flows/' + f.id, { method: 'PATCH', cookie: ana, body: { nodes: mine, edges: f.edges, base_version: f.version, client_id: 'ana-tab-1' } });
  assert.equal(merged.status, 200); assert.equal(merged.json.merged, true);
  const labels = Object.fromEntries(merged.json.flow.nodes.map(n => [n.id, n.label]));
  assert.equal(labels.n3, 'Ana edit'); assert.equal(labels.n4, 'Omar edit 4');

  // A client that sent no client_id (plain API caller) is treated as "someone else".
  const anon = await api('/api/flows/' + f.id, { method: 'PATCH', cookie: ana, body: { nodes: edited, edges: f.edges, base_version: merged.json.flow.version } });
  assert.equal(anon.status, 423);
});

test('only the holder can unlock; locks vanish when the editor leaves; viewers cannot lock', async () => {
  const ana = await login('ana@brightloom.test'); const omar = await login('omar@brightloom.test'); const f = await sharedFlow(ana);
  await post(ana, `/api/flows/${f.id}/collab/lock`, { client_id: 'ana-tab-1', node_id: 'n3' });
  await post(omar, `/api/flows/${f.id}/collab/unlock`, { client_id: 'omar-tab-1', node_id: 'n3' });
  assert.equal(srv.collab.snapshot(f.id).locks.length, 1);
  await post(ana, `/api/flows/${f.id}/collab/leave`, { client_id: 'ana-tab-1' });
  assert.equal(srv.collab.snapshot(f.id).locks.length, 0);
  const root = await login('super@agentflow.test');
  assert.equal((await post(root, `/api/flows/${f.id}/collab/lock`, { client_id: 'root-tab-1', node_id: 'n3' })).status, 409, 'the super admin only looks, never locks');
});

test('impersonation: the lock belongs to the real editor, labelled "Actor (as Subject)", and blocks the subject\'s own tab', async () => {
  const ana = await login('ana@brightloom.test'); const f = await sharedFlow(ana);
  const root = await login('super@agentflow.test');
  assert.equal((await post(root, '/api/impersonation/start', { user_id: 'u_bl_ana' })).status, 200);
  const l = await post(root, `/api/flows/${f.id}/collab/lock`, { client_id: 'root-tab-1', node_id: 'n3' });
  assert.equal(l.status, 200);
  assert.match(l.json.locks[0].label, /^.+ \(as Ana Torres\)$/);
  const own = await post(ana, `/api/flows/${f.id}/collab/lock`, { client_id: 'ana-tab-1', node_id: 'n3' });
  assert.equal(own.status, 409); assert.match(own.json.error, /\(as Ana Torres\)/);
  await post(root, '/api/impersonation/end', {});
});

test('SSE: a second editor receives presence, lock and version events live', async () => {
  const ana = await login('ana@brightloom.test'); const omar = await login('omar@brightloom.test'); const f = await sharedFlow(ana);
  const s = await openStream(omar, f.id, 'omar-tab-1');
  try {
    await s.waitFor(e => e.event === 'collab');
    await post(ana, `/api/flows/${f.id}/collab/heartbeat`, { client_id: 'ana-tab-1', node_id: 'n3' });
    await s.waitFor(e => e.event === 'collab' && e.data.presence.some(p => p.name === 'Ana Torres'));
    await post(ana, `/api/flows/${f.id}/collab/lock`, { client_id: 'ana-tab-1', node_id: 'n3' });
    await s.waitFor(e => e.event === 'collab' && e.data.locks.some(l => l.node_id === 'n3'));
    const saved = await api('/api/flows/' + f.id, { method: 'PATCH', cookie: ana, body: { name: 'Renamed live', base_version: f.version, client_id: 'ana-tab-1' } });
    assert.equal(saved.status, 200);
    const v = await s.waitFor(e => e.event === 'version');
    assert.equal(v.data.n, saved.json.flow.version); assert.equal(v.data.by, 'Ana Torres');
  } finally { s.close(); }
});

test('SSE refuses people who cannot see the flow', async () => {
  const ana = await login('ana@brightloom.test'); const f = await sharedFlow(ana);
  const sam = await login('solo@example.test');
  const res = await fetch(`${base}/api/flows/${f.id}/events?client=solotab01`, { headers: { Cookie: sam } });
  assert.equal(res.status, 404);
});

test('restoring an old version is refused while a colleague holds a lock', async () => {
  const ana = await login('ana@brightloom.test'); const omar = await login('omar@brightloom.test'); const f = await sharedFlow(ana);
  await post(omar, `/api/flows/${f.id}/collab/lock`, { client_id: 'omar-tab-1', node_id: 'n4' });
  const r = await post(ana, `/api/flows/${f.id}/versions/1/restore`, { base_version: f.version, client_id: 'ana-tab-1' });
  assert.equal(r.status, 423);
});

test('a lock is not bypassed by changing connections, nor by borrowing the holder\'s client id', async () => {
  const ana = await login('ana@brightloom.test'); const omar = await login('omar@brightloom.test'); const f = await sharedFlow(ana);
  await post(ana, `/api/flows/${f.id}/collab/lock`, { client_id: 'ana-tab-1', node_id: 'n3' });
  const wired = await api('/api/flows/' + f.id, { method: 'PATCH', cookie: omar, body: { nodes: f.nodes, edges: [...f.edges, { id: 'e99', from: 'n3', fromPort: 'out', to: 'n4', toPort: 'in' }], base_version: f.version, client_id: 'omar-tab-1' } });
  assert.equal(wired.status, 423, 'adding a wire to a locked card is a change to it');
  const spoof = await api('/api/flows/' + f.id, { method: 'PATCH', cookie: omar, body: { nodes: f.nodes.map(n => (n.id === 'n3' ? Object.assign({}, n, { label: 'stolen' }) : n)), edges: f.edges, base_version: f.version, client_id: 'ana-tab-1' } });
  assert.equal(spoof.status, 423, 'the same client id from another person is not the holder');
  assert.equal((await post(omar, `/api/flows/${f.id}/collab/unlock`, { client_id: 'ana-tab-1', node_id: 'n3' })).status, 403);
  assert.equal((await post(omar, `/api/flows/${f.id}/collab/heartbeat`, { client_id: 'ana-tab-1' })).status, 403);
  assert.equal(srv.collab.snapshot(f.id).locks.length, 1, 'still Ana\'s');
});

test('lock details are only shown to people who can see the flow', async () => {
  const ana = await login('ana@brightloom.test'); const f = await sharedFlow(ana);
  await post(ana, `/api/flows/${f.id}/collab/lock`, { client_id: 'ana-tab-1', node_id: 'n3' });
  const outsider = await login('solo@example.test');
  const r = await api('/api/flows/' + f.id, { method: 'PATCH', cookie: outsider, body: { nodes: f.nodes, edges: f.edges, base_version: f.version, client_id: 'solo-tab-1' } });
  assert.equal(r.status, 404); assert.equal(r.json.locked, undefined);
  assert.equal((await post(outsider, `/api/flows/${f.id}/versions/1/restore`, { base_version: f.version, client_id: 'solo-tab-1' })).status, 404);
});

test('two people who both add a card from the same base merge into one flow with both cards', async () => {
  const ana = await login('ana@brightloom.test'); const omar = await login('omar@brightloom.test'); const f = await sharedFlow(ana);
  const add = (id, label) => [...f.nodes, { id, type: 'summarize', label, x: 600, y: 360, config: {} }];
  assert.equal((await api('/api/flows/' + f.id, { method: 'PATCH', cookie: omar, body: { nodes: add('n5', 'Omar card'), edges: f.edges, base_version: f.version, client_id: 'omar-tab-1' } })).status, 200);
  const r = await api('/api/flows/' + f.id, { method: 'PATCH', cookie: ana, body: { nodes: add('n5', 'Ana card'), edges: f.edges, base_version: f.version, client_id: 'ana-tab-1' } });
  assert.equal(r.status, 200); assert.equal(r.json.merged, true);
  assert.deepEqual(r.json.flow.nodes.map(n => n.label).filter(l => /card$/.test(l)).sort(), ['Ana card', 'Omar card']);
});

test('collab memory is released: no owners or empty maps remain after everyone leaves', async () => {
  const ana = await login('ana@brightloom.test'); const f = await sharedFlow(ana);
  await post(ana, `/api/flows/${f.id}/collab/lock`, { client_id: 'ana-gc-tab', node_id: 'n3' });
  await post(ana, `/api/flows/${f.id}/collab/leave`, { client_id: 'ana-gc-tab' });
  assert.equal(srv.collab.owners.has('ana-gc-tab'), false); assert.equal(srv.collab.locks.has(f.id), false); assert.equal(srv.collab.presence.has(f.id), false);
});
