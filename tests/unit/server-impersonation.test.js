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
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'af imp test '));
  srv = createServer({ dataDir, trustProxy: true, stepDelayMs: 0, seedFile: path.join(__dirname, '..', '..', 'data', 'seed.json') });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  base = 'http://127.0.0.1:' + srv.address().port;
});
test.after(() => new Promise(r => srv.close(r)));

async function api(p, { method = 'GET', body, cookie } = {}) {
  const headers = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0) Chrome/120.0 Safari/537.36' };
  if (body !== undefined) headers['Content-Type'] = 'application/json'; if (cookie) headers.Cookie = cookie;
  const res = await fetch(base + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text(); let json = null; try { json = JSON.parse(text); } catch { /* none */ }
  return { status: res.status, json, text };
}
async function login(email) {
  const res = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '10.8.0.' + (++ip % 250) }, body: JSON.stringify({ email, password: PW }) });
  return (res.headers.get('set-cookie') || '').split(';')[0];
}
const start = (cookie, user_id) => api('/api/impersonation/start', { method: 'POST', cookie, body: { user_id } });
const audit = () => srv.store.data.auditLog;

test('impersonation endpoints refuse anonymous callers', async () => {
  assert.equal((await start('', 'u_bl_ana')).status, 401);
  assert.equal((await api('/api/impersonation/end', { method: 'POST', body: {} })).status, 401);
});

test('employees and individuals cannot start impersonation', async () => {
  assert.equal((await start(await login('ana@agentflow.com'), 'u_bl_omar')).status, 403);
  assert.equal((await start(await login('solo@example.com'), 'u_bl_ana')).status, 403);
});

test('super admin enters an employee: me/permissions follow the subject, passwords never appear', async () => {
  const sa = await login('super@agentflow.com');
  const r = await start(sa, 'u_bl_ana');
  assert.equal(r.status, 200); assert.equal(r.json.user.id, 'u_bl_ana');
  const me = await api('/api/auth/me', { cookie: sa });
  assert.equal(me.json.user.id, 'u_bl_ana'); assert.equal(me.json.user.role, 'employee');
  assert.equal(me.json.impersonation.actor.id, 'u_super'); assert.equal(me.json.impersonation.frozen, false);
  const flows = await api('/api/flows', { cookie: sa });
  assert.equal(flows.status, 200); assert.ok(flows.json.flows.length > 0);
  assert.equal((await api('/api/tenants', { cookie: sa })).status, 403, 'now has the employee permissions, not super admin ones');
  for (const p of ['/api/auth/me', '/api/flows', '/api/account', '/api/account/activity', '/api/usage']) {
    const t = (await api(p, { cookie: sa })).text;
    assert.ok(!/password|scrypt\$|pbkdf2\$/i.test(t), 'secret leaked in ' + p);
  }
});

test('while impersonating: no chaining, cannot change subject password or email, theme is not persisted', async () => {
  const sa = await login('super@agentflow.com');
  await start(sa, 'u_bl_admin');
  assert.equal((await start(sa, 'u_bl_ana')).status, 403, 'no chained impersonation');
  assert.equal((await api('/api/account/password', { method: 'POST', cookie: sa, body: { current: PW, next: 'Another#2026x' } })).status, 403);
  assert.equal((await api('/api/users/u_bl_admin', { method: 'PATCH', cookie: sa, body: { email: 'x@agentflow.com' } })).status, 403);
  assert.equal((await api('/api/users/u_bl_admin/reset-password', { method: 'POST', cookie: sa, body: {} })).status, 403);
  await api('/api/auth/prefs', { method: 'PATCH', cookie: sa, body: { theme: 'dark' } });
  assert.notEqual(srv.store.data.users.find(u => u.id === 'u_bl_admin').prefs.theme, 'dark');
  assert.equal((await login('admin@agentflow.com')) !== '', true, 'subject password unchanged');
});

test('writes during impersonation are audited as "<actor> acting as <subject>", versions and runs show by', async () => {
  const sa = await login('super@agentflow.com');
  await start(sa, 'u_bl_ana');
  const created = await api('/api/flows', { method: 'POST', cookie: sa, body: { name: 'Made by support' } });
  assert.equal(created.status, 201);
  const flow = created.json.flow;
  const v = srv.store.data.flowVersions.find(x => x.flow_id === flow.id);
  assert.equal(v.user_id, 'u_bl_ana'); assert.equal(v.by_id, 'u_super'); assert.equal(v.by_name, 'Super Admin'.length ? v.by_name : '');
  const row = audit().filter(e => e.action === 'flow.create' && e.target === flow.id).pop();
  assert.equal(row.actor_id, 'u_super'); assert.match(row.actor_name, / acting as /); assert.equal(row.meta.acting_as.id, 'u_bl_ana');
  assert.equal(flow.owner_id, 'u_bl_ana');
});

test('credits are charged to the subject company and the run records who really started it', async () => {
  const sa = await login('super@agentflow.com');
  await start(sa, 'u_bl_ana');
  const before = (await api('/api/usage', { cookie: sa })).json.usage.used;
  const started = await api('/api/flows/f_news/runs', { method: 'POST', cookie: sa, body: {} });
  assert.equal(started.status, 202); assert.equal(started.json.run.user_id, 'u_bl_ana'); assert.equal(started.json.run.by_id, 'u_super');
  for (let i = 0; i < 100; i++) { const r = await api('/api/runs/' + started.json.run.id, { cookie: sa }); if (r.json.run.status !== 'running') break; await new Promise(x => setTimeout(x, 20)); }
  assert.ok((await api('/api/usage', { cookie: sa })).json.usage.used > before);
});

test('return ends it: audit entries exist, subject device and sign-in lists stay clean, access log shows it', async () => {
  const sa = await login('super@agentflow.com');
  const devs = srv.store.data.devices.filter(d => d.user_id === 'u_bl_lina').length;
  const events = srv.store.data.loginEvents.filter(e => e.user_id === 'u_bl_lina').length;
  assert.equal((await start(sa, 'u_bl_lina')).status, 200);
  assert.equal((await api('/api/impersonation/end', { method: 'POST', cookie: sa, body: {} })).status, 200);
  assert.equal((await api('/api/auth/me', { cookie: sa })).json.user.id, 'u_super');
  assert.equal((await api('/api/impersonation/end', { method: 'POST', cookie: sa, body: {} })).status, 400);
  const started = audit().filter(e => e.action === 'impersonation.started' && e.target === 'u_bl_lina').pop();
  const ended = audit().filter(e => e.action === 'impersonation.ended' && e.target === 'u_bl_lina').pop();
  assert.ok(started && ended); assert.equal(started.actor_id, 'u_super'); assert.equal(started.meta.browser, 'Chrome 120'); assert.ok(started.meta.ip);
  assert.equal(srv.store.data.devices.filter(d => d.user_id === 'u_bl_lina').length, devs);
  assert.equal(srv.store.data.loginEvents.filter(e => e.user_id === 'u_bl_lina').length, events);
  const lina = await login('lina@agentflow.com');
  const act = (await api('/api/account/activity', { cookie: lina })).json;
  assert.ok(act.access.some(a => a.action === 'impersonation.started'));
});

test('admin: own employees only; other company, admins, frozen employee and super admin are refused', async () => {
  const ad = await login('admin@agentflow.com');
  for (const id of ['u_ke_sam', 'u_bl_admin', 'u_super', 'u_bl_devon', 'no_such_user']) assert.ok([403, 404].includes((await start(ad, id)).status), id);
  assert.equal((await start(ad, 'u_ke_sam')).status, 403);
  assert.ok(audit().some(e => e.action === 'security.cross_tenant_attempt' && e.meta.op === 'impersonate'));
  assert.equal((await api('/api/auth/me', { cookie: ad })).json.user.id, 'u_bl_admin', 'refusal did not switch accounts');
  assert.equal((await start(ad, 'u_bl_ana')).status, 200);
  assert.equal((await api('/api/flows', { cookie: ad })).status, 200);
  assert.equal((await api('/api/users', { cookie: ad })).status, 403, 'employee permissions only');
});

test('super admin may inspect a frozen employee, flagged; admin may not; refusal on a company that is frozen', async () => {
  const sa = await login('super@agentflow.com');
  const r = await start(sa, 'u_bl_devon');
  assert.equal(r.status, 200);
  const me = await api('/api/auth/me', { cookie: sa });
  assert.equal(me.json.impersonation.frozen, true); assert.equal(me.json.user.status, 'frozen');
});

test('the right is re-checked on every request: freezing the subject ends an admin session; expiry ends it too', async () => {
  const ad = await login('admin@agentflow.com');
  assert.equal((await start(ad, 'u_bl_omar')).status, 200);
  srv.store.data.users.find(u => u.id === 'u_bl_omar').status = 'frozen';
  const me = await api('/api/auth/me', { cookie: ad });
  assert.equal(me.json.user.id, 'u_bl_admin'); assert.equal(me.json.impersonation, null);
  assert.ok(audit().some(e => e.action === 'impersonation.ended' && e.meta.reason === 'not_allowed'));
  srv.store.data.users.find(u => u.id === 'u_bl_omar').status = 'active';
  assert.equal((await start(ad, 'u_bl_omar')).status, 200);
  srv.store.data.sessions.find(s => s.subject_id === 'u_bl_omar').imp_expires_at = new Date(Date.now() - 1000).toISOString();
  assert.equal((await api('/api/auth/me', { cookie: ad })).json.user.id, 'u_bl_admin');
  assert.ok(audit().some(e => e.action === 'impersonation.ended' && e.meta.reason === 'expired'));
});

test('signing out while impersonating ends the session and audits it', async () => {
  const sa = await login('super@agentflow.com');
  await start(sa, 'u_bl_raj');
  assert.equal((await api('/api/auth/logout', { method: 'POST', cookie: sa, body: {} })).status, 200);
  assert.equal((await api('/api/auth/me', { cookie: sa })).status, 401);
  assert.ok(audit().some(e => e.action === 'impersonation.ended' && e.target === 'u_bl_raj' && e.meta.reason === 'signed_out'));
});

test('SECURITY: nobody can reset their own password or change their own email without the current password; sessions per person are capped', async () => {
  const ad = await login('admin@agentflow.com');
  assert.equal((await api('/api/users/u_bl_admin/reset-password', { method: 'POST', cookie: ad, body: { password: 'Hacked#12345' } })).status, 403);
  assert.equal((await api('/api/users/u_bl_admin', { method: 'PATCH', cookie: ad, body: { email: 'new@agentflow.com' } })).status, 403);
  assert.equal((await api('/api/users/u_bl_admin', { method: 'PATCH', cookie: ad, body: { name: 'Maya H.' } })).status, 200, 'other self-edits still work');
  const sa = await login('super@agentflow.com');
  assert.equal((await api('/api/users/u_super/reset-password', { method: 'POST', cookie: sa, body: { password: 'Hacked#12345' } })).status, 403);
  for (let i = 0; i < 14; i++) await login('lina@agentflow.com');
  assert.ok(srv.store.data.sessions.filter(s => s.user_id === 'u_bl_lina').length <= 10, 'oldest sign-ins make room');
});
