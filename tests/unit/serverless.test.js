'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHandler } = require('../../server/serverless.js');

/** In-memory stand-in for the Supabase table: row "main" (whole db, changing updated_at) and row "live" (shared co-work state, compare-and-swap on data->>v). */
function fakeRemote() {
  const state = { row: null, version: 0, gets: 0, posts: 0, live: null };
  const fetchImpl = async (url, opts) => {
    const u = new URL(url);
    const reply = (status, body) => ({ ok: status < 300, status, json: async () => body, text: async () => JSON.stringify(body) });
    if (opts.headers.apikey !== 'k') return reply(401, {});
    const bodyId = opts.body ? JSON.parse(opts.body).id : null;
    const id = (u.searchParams.get('id') || bodyId || '').replace('eq.', '');
    if (id === 'live') {
      if (opts.method === 'GET') return reply(200, state.live ? [{ data: state.live }] : []);
      const body = JSON.parse(opts.body);
      if (opts.method === 'POST') { if (!state.live) state.live = body.data; return reply(201, []); }
      const want = u.searchParams.get('data->>v');
      if (!state.live || (want && String(state.live.v) !== want.replace('eq.', ''))) return reply(200, []);
      state.live = body.data; return reply(200, [{ data: state.live }]);
    }
    if (opts.method === 'GET') {
      state.gets += 1;
      if (!state.row) return reply(200, []);
      const select = u.searchParams.get('select');
      return reply(200, [select === 'updated_at' ? { updated_at: state.row.updated_at } : { data: state.row.data, updated_at: state.row.updated_at }]);
    }
    state.posts += 1; state.version += 1;
    const body = JSON.parse(opts.body);
    state.row = { data: body.data, updated_at: '2026-11-18T00:00:' + String(state.version % 60).padStart(2, '0') + '.' + String(state.version).padStart(6, '0') + '+00:00' };
    return reply(201, [{ updated_at: state.row.updated_at }]);
  };
  return { state, fetchImpl };
}

/** One "lambda instance": its own handler, own scratch disk, same remote store. */
async function instance(remote, extraEnv) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'af lambda '));
  const handler = createHandler({ REMOTE_STORE_URL: 'https://x.supabase.co/rest/v1/agentflow_state', REMOTE_STORE_KEY: 'k', DATA_DIR: dataDir, ...(extraEnv || {}) }, remote.fetchImpl);
  const server = http.createServer((req, res) => { handler(req, res); });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  const call = async (p, { method = 'GET', body, cookie, ip = '10.0.0.1' } = {}) => {
    const res = await fetch(base + p, { method, headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}), 'X-Forwarded-For': ip }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text(); let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: res.status, json, text, headers: res.headers };
  };
  return { call, close: () => new Promise(r => { server.closeAllConnections && server.closeAllConnections(); server.close(r); }) };
}
const login = async (inst, ip) => {
  const r = await inst.call('/api/auth/login', { method: 'POST', body: { email: 'ana@brightloom.test', password: 'AgentFlow#2026' }, ip });
  return (r.headers.get('set-cookie') || '').split(';')[0];
};

test('the first request starts from the seed and stores it remotely; pages and the API are served', async () => {
  const remote = fakeRemote(); const a = await instance(remote);
  try {
    assert.equal((await a.call('/api/health')).status, 200);
    assert.ok(remote.state.row, 'seed uploaded');
    assert.ok(remote.state.row.data.users.some(u => u.id === 'u_bl_ana'));
    const page = await a.call('/index.html'); assert.equal(page.status, 200); assert.match(page.text, /<form/);
    assert.equal((await a.call('/server/security.js')).status, 404, 'source files are never served');
  } finally { await a.close(); }
});

test('every change is stored remotely BEFORE the answer reaches the browser (write-through)', async () => {
  const remote = fakeRemote(); const a = await instance(remote);
  try {
    const cookie = await login(a, '10.0.1.1');
    const made = await a.call('/api/flows', { method: 'POST', cookie, body: { name: 'Write-through flow' } });
    assert.equal(made.status, 201);
    assert.ok(remote.state.row.data.flows.some(f => f.id === made.json.flow.id), 'the flow is already in the remote store');
    assert.ok(remote.state.row.data.sessions.length >= 1, 'the sign-in session too, so other instances accept the cookie');
  } finally { await a.close(); }
});

test('a second instance sees the first one\'s data and accepts its session cookie; a warm instance notices changes made elsewhere', async () => {
  const remote = fakeRemote(); const a = await instance(remote); let b;
  try {
    const cookie = await login(a, '10.0.2.1');
    const made = await a.call('/api/flows', { method: 'POST', cookie, body: { name: 'Seen from B' } });
    b = await instance(remote);
    const seen = await b.call('/api/flows', { cookie });
    assert.equal(seen.status, 200); assert.ok(seen.json.flows.some(f => f.id === made.json.flow.id), 'cold instance loaded the stored data');
    const second = await b.call('/api/flows', { method: 'POST', cookie, body: { name: 'Made on B' } });
    const fromA = await a.call('/api/flows', { cookie });
    assert.ok(fromA.json.flows.some(f => f.id === second.json.flow.id), 'warm instance refreshed because the stored version changed');
  } finally { await a.close(); if (b) await b.close(); }
});

test('reading does not rewrite the remote store', async () => {
  const remote = fakeRemote(); const a = await instance(remote);
  try {
    const cookie = await login(a, '10.0.3.1');
    await a.call('/api/flows', { cookie }); const posts = remote.state.posts;
    await a.call('/api/flows', { cookie }); await a.call('/api/templates', { cookie });
    assert.equal(remote.state.posts, posts, 'no uploads for reads');
  } finally { await a.close(); }
});

const until = async (fn, ms = 8000) => { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) throw new Error('timed out'); await new Promise(r => setTimeout(r, 40)); } };

test('live streams are switched off (the page falls back to polling) and a run goes on after its answer, visible from another instance', async () => {
  const remote = fakeRemote(); const a = await instance(remote, { AF_STEP_DELAY_MS: '60' }); let b;
  try {
    const cookie = await login(a, '10.0.4.1');
    assert.equal((await a.call('/api/flows/f_news/events?client=abcdef123', { cookie })).status, 404);
    const run = await a.call('/api/flows/f_news/runs', { method: 'POST', cookie, body: {} });
    assert.equal(run.status, 202); assert.equal(run.json.run.status, 'running', 'the answer does not wait for the run');
    b = await instance(remote);
    const done = await until(async () => { const r = await b.call('/api/runs/' + run.json.run.id, { cookie }); return r.status === 200 && r.json.run.status !== 'running' ? r.json : null; });
    assert.equal(done.run.status, 'success', String(done.run.error)); assert.ok(done.run.credits > 0); assert.ok(done.steps.length >= 4);
    assert.equal(remote.state.row.data.runs.find(r => r.id === run.json.run.id).status, 'success');
  } finally { await a.close(); if (b) await b.close(); }
});

test('STOP works from another instance: the instance running the flow notices and ends the run', async () => {
  const remote = fakeRemote(); const a = await instance(remote, { AF_STEP_DELAY_MS: '400' }); let b;
  try {
    const cookie = await login(a, '10.0.5.1');
    const run = await a.call('/api/flows/f_news/runs', { method: 'POST', cookie, body: {} });
    assert.equal(run.json.run.status, 'running');
    b = await instance(remote);
    await new Promise(r => setTimeout(r, 500));
    const stop = await b.call('/api/runs/' + run.json.run.id + '/stop', { method: 'POST', cookie, body: {} });
    assert.equal(stop.status, 200);
    const ended = await until(async () => { const r = await b.call('/api/runs/' + run.json.run.id, { cookie }); return r.json.run.status !== 'running' ? r.json.run : null; }, 10000);
    assert.notEqual(ended.status, 'success', 'the run was stopped before it finished');
    assert.ok(ended.steps_count < 5, 'later cards did not run');
  } finally { await a.close(); if (b) await b.close(); }
});

test('CO-WORK across instances: a card locked on one instance is locked for the other, and presence is shared', async () => {
  const remote = fakeRemote(); const a = await instance(remote); const b = await instance(remote);
  try {
    const ana = await login(a, '10.0.6.1');
    const omarRes = await b.call('/api/auth/login', { method: 'POST', body: { email: 'omar@brightloom.test', password: 'AgentFlow#2026' }, ip: '10.0.6.2' });
    const omar = (omarRes.headers.get('set-cookie') || '').split(';')[0];
    await a.call('/api/flows/f_news/collab/heartbeat', { method: 'POST', cookie: ana, body: { client_id: 'ana-tab-aaaa' } });
    assert.equal((await a.call('/api/flows/f_news/collab/lock', { method: 'POST', cookie: ana, body: { client_id: 'ana-tab-aaaa', node_id: 'n2' } })).status, 200);
    const clash = await b.call('/api/flows/f_news/collab/lock', { method: 'POST', cookie: omar, body: { client_id: 'omar-tab-bbbb', node_id: 'n2' } });
    assert.equal(clash.status, 409); assert.match(clash.json.error, /Ana Torres is editing/);
    const hb = await b.call('/api/flows/f_news/collab/heartbeat', { method: 'POST', cookie: omar, body: { client_id: 'omar-tab-bbbb' } });
    assert.deepEqual(hb.json.presence.map(p => p.name).sort(), ['Ana Torres', 'Omar Siddiqui']);
    const stolen = await b.call('/api/flows/f_news/collab/heartbeat', { method: 'POST', cookie: omar, body: { client_id: 'ana-tab-aaaa' } });
    assert.equal(stolen.status, 403, 'a client id is bound to its first user on every instance');
    const flow = (await b.call('/api/flows/f_news', { cookie: omar })).json.flow;
    const changed = flow.nodes.map(n => (n.id === 'n2' ? Object.assign({}, n, { label: 'Omar edit' }) : n));
    const save = await b.call('/api/flows/f_news', { method: 'PATCH', cookie: omar, body: { nodes: changed, edges: flow.edges, base_version: flow.version, client_id: 'omar-tab-bbbb' } });
    assert.equal(save.status, 423);
  } finally { await a.close(); await b.close(); }
});

test('if the remote store cannot be read the handler answers 503 instead of starting empty', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'af lambda bad '));
  const handler = createHandler({ REMOTE_STORE_URL: 'https://x.supabase.co/rest/v1/t', REMOTE_STORE_KEY: 'wrong', DATA_DIR: dataDir }, fakeRemote().fetchImpl);
  const server = http.createServer((req, res) => { handler(req, res); }); await new Promise(r => server.listen(0, '127.0.0.1', r));
  try {
    const res = await fetch('http://127.0.0.1:' + server.address().port + '/api/health');
    assert.equal(res.status, 503); assert.match((await res.json()).error, /storage/i);
  } finally { await new Promise(r => { server.closeAllConnections && server.closeAllConnections(); server.close(r); }); }
});

test('missing storage settings give a clear 503 too', async () => {
  const handler = createHandler({ DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'af lambda none ')) }, fakeRemote().fetchImpl);
  const server = http.createServer((req, res) => { handler(req, res); }); await new Promise(r => server.listen(0, '127.0.0.1', r));
  try {
    const res = await fetch('http://127.0.0.1:' + server.address().port + '/api/health');
    assert.equal(res.status, 503); assert.match((await res.json()).error, /REMOTE_STORE/);
  } finally { await new Promise(r => { server.closeAllConnections && server.closeAllConnections(); server.close(r); }); }
});
