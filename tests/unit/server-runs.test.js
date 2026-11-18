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
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'af runs test '));
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
  const res = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '10.9.0.' + (++ip % 250) }, body: JSON.stringify({ email, password: PW }) });
  return (res.headers.get('set-cookie') || '').split(';')[0];
}
async function finished(id, cookie) {
  for (let i = 0; i < 100; i++) { const r = await api('/api/runs/' + id, { cookie }); if (r.json.run.status !== 'running') return r.json; await new Promise(x => setTimeout(x, 20)); }
  throw new Error('run did not finish');
}

test('every run endpoint refuses anonymous callers', async () => {
  for (const [method, p] of [['POST', '/api/flows/f_news/runs'], ['GET', '/api/runs'], ['GET', '/api/runs/f_news_run1'], ['POST', '/api/runs/f_news_run1/stop']]) {
    assert.equal((await api(p, { method, body: method === 'POST' ? {} : undefined })).status, 401, method + ' ' + p);
  }
});

test('start a run, poll it to the end, and read the steps, logs and final result', async () => {
  const ana = await login('ana@agentflow.com');
  const started = await api('/api/flows/f_news/runs', { method: 'POST', cookie: ana, body: {} });
  assert.equal(started.status, 202); assert.equal(started.json.run.status, 'running');
  const done = await finished(started.json.run.id, ana);
  assert.equal(done.run.status, 'success'); assert.equal(done.run.credits, 7);
  assert.deepEqual(done.steps.map(s => s.type), ['start', 'search_web', 'summarize', 'write_email', 'end']);
  assert.ok(done.run.logs.length > 5); assert.match(done.run.output, /Sent to team@agentflow.com/);
  const list = await api('/api/runs', { cookie: ana });
  assert.ok(list.json.runs.some(r => r.id === started.json.run.id && r.flow_name === 'Daily AI news digest'));
  const usage = await api('/api/usage', { cookie: ana });
  assert.ok(usage.json.usage.used >= 7);
});

test('permissions over HTTP: super admin cannot start, other companies and private flows are invisible', async () => {
  assert.equal((await api('/api/flows/f_news/runs', { method: 'POST', cookie: await login('super@agentflow.com'), body: {} })).status, 403);
  const ana = await login('ana@agentflow.com');
  assert.equal((await api('/api/flows/f_ke/runs', { method: 'POST', cookie: ana, body: {} })).status, 404);
  assert.equal((await api('/api/flows/f_translate/runs', { method: 'POST', cookie: ana, body: {} })).status, 404);
  assert.equal((await api('/api/runs/f_ke_run1', { cookie: ana })).status, 404, 'another company run by id');
  assert.equal((await api('/api/runs/f_news_run1/stop', { method: 'POST', cookie: await login('omar@agentflow.com'), body: {} })).status, 404, 'a colleague cannot see or stop it');
  const omar = await login('omar@agentflow.com');
  assert.equal((await api('/api/runs/f_news_run1', { cookie: omar })).status, 404);
  assert.equal((await api('/api/runs/f_news_run1', { cookie: await login('admin@agentflow.com') })).status, 200);
  assert.equal((await api('/api/runs', { cookie: await login('solo@example.com') })).json.runs.every(r => r.user_id === 'u_solo'), true);
});

test('SERVER-SIDE CREDITS over HTTP: exhausted credits are refused with 402 no matter what the page does', async () => {
  const solo = await login('solo@example.com');
  const rec = srv.store.data.usage.find(u => u.user_id === 'u_solo');
  const saved = rec.credits_used; rec.credits_used = rec.credits_limit;
  try {
    const r = await api('/api/flows/f_solo/runs', { method: 'POST', cookie: solo, body: {} });
    assert.equal(r.status, 402); assert.equal(r.json.code, 'credits_exhausted'); assert.match(r.json.error, /Upgrade/);
    const usage = (await api('/api/usage', { cookie: solo })).json.usage;
    assert.equal(usage.exhausted, true);
  } finally { rec.credits_used = saved; }
});

test('a failing flow is recorded as failed with a readable error and no credits kept for the failed card', async () => {
  const ana = await login('ana@agentflow.com');
  const made = await api('/api/flows', { method: 'POST', cookie: ana, body: { name: 'Will fail', nodes: [
    { id: 'n1', type: 'start', label: 'Start', x: 0, y: 0, config: {} }, { id: 'n2', type: 'search_web', label: 'Search', x: 300, y: 0, config: { query: 'news [fail]', max_results: 3 } }, { id: 'n3', type: 'end', label: 'End', x: 600, y: 0, config: {} }],
    edges: [{ id: 'e1', from: 'n1', fromPort: 'out', to: 'n2', toPort: 'in' }, { id: 'e2', from: 'n2', fromPort: 'out', to: 'n3', toPort: 'in' }] } });
  const started = await api(`/api/flows/${made.json.flow.id}/runs`, { method: 'POST', cookie: ana, body: {} });
  const done = await finished(started.json.run.id, ana);
  assert.equal(done.run.status, 'failed'); assert.match(done.run.error, /timed out/); assert.equal(done.run.credits, 0);
  assert.deepEqual(done.steps.map(s => s.status), ['success', 'failed']);
});

test('an invalid flow is refused before anything runs', async () => {
  const ana = await login('ana@agentflow.com');
  const made = await api('/api/flows', { method: 'POST', cookie: ana, body: { name: 'No end', nodes: [{ id: 'n1', type: 'start', label: 'Start', x: 0, y: 0, config: {} }], edges: [] } });
  const r = await api(`/api/flows/${made.json.flow.id}/runs`, { method: 'POST', cookie: ana, body: {} });
  assert.equal(r.status, 400); assert.ok(r.json.problems.length > 0);
});

test('stop over HTTP ends a run as "stopped"', async () => {
  srv.runner.stepDelayMs = 30;
  const ana = await login('ana@agentflow.com');
  const slow = createServer({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'af stop test ')), trustProxy: true, stepDelayMs: 60, seedFile: path.join(__dirname, '..', '..', 'data', 'seed.json') });
  await new Promise(r => slow.listen(0, '127.0.0.1', r));
  try {
    const b = 'http://127.0.0.1:' + slow.address().port;
    const lg = await fetch(b + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '10.9.9.9' }, body: JSON.stringify({ email: 'ana@agentflow.com', password: PW }) });
    const cookie = (lg.headers.get('set-cookie') || '').split(';')[0];
    const call = async (p, method = 'GET', body) => { const r = await fetch(b + p, { method, headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: body === undefined ? undefined : JSON.stringify(body) }); return { status: r.status, json: await r.json() }; };
    const started = await call('/api/flows/f_news/runs', 'POST', {});
    assert.equal((await call(`/api/runs/${started.json.run.id}/stop`, 'POST', {})).status, 200);
    await slow.runner.whenDone(started.json.run.id);
    assert.equal((await call(`/api/runs/${started.json.run.id}`)).json.run.status, 'stopped');
    assert.equal((await call(`/api/runs/${started.json.run.id}/stop`, 'POST', {})).status, 409);
  } finally { await new Promise(r => slow.close(r)); }
  void ana;
});

test('run list filters work over HTTP', async () => {
  const admin = await login('admin@agentflow.com');
  assert.ok((await api('/api/runs?status=failed', { cookie: admin })).json.runs.every(r => r.status === 'failed'));
  assert.ok((await api('/api/runs?flow_id=f_report', { cookie: admin })).json.runs.every(r => r.flow_id === 'f_report'));
  assert.equal((await api('/api/runs?limit=2', { cookie: admin })).json.runs.length, 2);
});
