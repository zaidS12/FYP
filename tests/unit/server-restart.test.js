'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createServer } = require('../../server.js');

const SEED = path.join(__dirname, '..', '..', 'data', 'seed.json');
const open = async dataDir => {
  const srv = createServer({ dataDir, trustProxy: true, stepDelayMs: 0, seedFile: SEED, saveDebounceMs: 5000 });   // long window: only a flush can save these
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  return { srv, base: 'http://127.0.0.1:' + srv.address().port };
};
const close = srv => new Promise(r => srv.close(r));

test('data survives a restart, including changes still waiting in the delayed-write window', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'af restart test '));
  let { srv, base } = await open(dataDir);
  const login = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '10.3.0.1' }, body: JSON.stringify({ email: 'ana@brightloom.test', password: 'AgentFlow#2026' }) });
  const cookie = (login.headers.get('set-cookie') || '').split(';')[0];
  const made = await (await fetch(base + '/api/flows', { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify({ name: 'Survives restarts' }) })).json();
  const run = await (await fetch(base + '/api/flows/' + made.flow.id + '/runs', { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: '{}' })).json();
  await srv.runner.whenDone(run.run.id);
  const stepsBefore = srv.store.data.runSteps.filter(s => s.run_id === run.run.id).length;
  assert.ok(stepsBefore >= 2);
  await close(srv);                                   // close() flushes whatever was still waiting

  ({ srv, base } = await open(dataDir));
  try {
    const d = srv.store.data;
    assert.ok(d.flows.some(f => f.id === made.flow.id && f.name === 'Survives restarts'));
    assert.equal(d.runs.find(r => r.id === run.run.id).status, 'success');
    assert.equal(d.runSteps.filter(s => s.run_id === run.run.id).length, stepsBefore);
    assert.ok(d.loginEvents.some(e => e.user_id === 'u_bl_ana' && e.success), 'the sign-in record was kept');
  } finally { await close(srv); }
});

test('old runs are trimmed when the server starts', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'af retention test '));
  let { srv } = await open(dataDir);
  const old = new Date(Date.now() - 400 * 86400000).toISOString();
  for (let i = 0; i < 60; i++) srv.store.data.runs.push({ id: 'ancient' + i, flow_id: 'f_x', flow_name: 'x', tenant_id: 't_brightloom', user_id: 'u_bl_ana', user_name: 'Ana', status: 'success', started_at: old, ended_at: old, credits: 1, logs: [] });
  srv.store.save(); await close(srv);
  ({ srv } = await open(dataDir));
  try { assert.ok(srv.store.data.runs.filter(r => r.id.startsWith('ancient')).length < 60, 'ancient runs beyond the always-kept newest are removed'); } finally { await close(srv); }
});
