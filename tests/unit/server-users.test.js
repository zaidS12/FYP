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
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'af users test '));
  srv = createServer({ dataDir, trustProxy: true, seedFile: path.join(__dirname, '..', '..', 'data', 'seed.json') });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  base = 'http://127.0.0.1:' + srv.address().port;
});
test.after(() => new Promise(r => srv.close(r)));

async function api(p, { method = 'GET', body, cookie } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (cookie) headers.Cookie = cookie;
  const res = await fetch(base + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text(); let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, json, headers: res.headers };
}
async function login(email, password = PW) {
  const res = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '10.1.0.' + (++ip % 250) }, body: JSON.stringify({ email, password }) });
  return (res.headers.get('set-cookie') || '').split(';')[0];
}

test('401 without a session, 403 for employees and individuals, on every Phase 2 endpoint', async () => {
  const calls = [['GET', '/api/users'], ['POST', '/api/users'], ['PATCH', '/api/users/u_bl_ana'], ['POST', '/api/users/u_bl_ana/reset-password'],
    ['POST', '/api/users/u_bl_ana/freeze'], ['POST', '/api/users/u_bl_ana/unfreeze'], ['DELETE', '/api/users/u_bl_ana'], ['GET', '/api/devices'], ['GET', '/api/login-events'], ['GET', '/api/seats']];
  for (const [method, p] of calls) assert.equal((await api(p, { method, body: method === 'GET' || method === 'DELETE' ? undefined : {} })).status, 401, 'anon ' + method + ' ' + p);
  for (const who of ['ana@brightloom.test', 'solo@example.test']) {
    const cookie = await login(who);
    for (const [method, p] of calls) assert.equal((await api(p, { method, cookie, body: method === 'GET' || method === 'DELETE' ? undefined : {} })).status, 403, who + ' ' + method + ' ' + p);
  }
});

test('company admin lists only their own company; super admin lists all', async () => {
  const a = (await api('/api/users', { cookie: await login('admin@brightloom.test') })).json;
  assert.ok(a.users.length === 6 && a.users.every(u => u.tenant_id === 't_brightloom'));
  assert.equal(a.seats.used, 6); assert.equal(a.seats.limit, 10);
  assert.equal(JSON.stringify(a).includes('password_hash'), false);
  const s = (await api('/api/users', { cookie: await login('super@agentflow.test') })).json;
  assert.ok(s.users.length >= 11);
});

test('CROSS-TENANT: a company admin cannot read or change another company by id, header, query or body', async () => {
  const cookie = await login('admin@brightloom.test');
  for (const [method, p, body] of [['PATCH', '/api/users/u_ke_sam', { name: 'x' }], ['POST', '/api/users/u_ke_sam/reset-password', {}], ['POST', '/api/users/u_ke_sam/freeze', {}], ['DELETE', '/api/users/u_ke_sam'], ['PATCH', '/api/users/u_super', { name: 'x' }]]) {
    assert.equal((await api(p, { method, cookie, body })).status, 404, method + ' ' + p);
  }
  const made = await api('/api/users?tenant_id=t_kestrel', { method: 'POST', cookie, body: { name: 'Sneaky', email: 'sneaky@x.test', tenant_id: 't_kestrel', role: 'admin' } });
  assert.equal(made.status, 201);
  assert.equal(made.json.user.tenant_id, 't_brightloom'); assert.equal(made.json.user.role, 'employee');
  const devs = (await api('/api/devices', { cookie })).json.devices;
  assert.ok(devs.length > 0 && devs.every(d => d.tenant_id === 't_brightloom'));
  const evs = (await api('/api/login-events', { cookie })).json.events;
  assert.ok(evs.every(e => e.tenant_id === 't_brightloom'));
});

test('seat limit is enforced over HTTP, then extra seats are not available to the admin themselves', async () => {
  const cookie = await login('admin@brightloom.test');
  let last;
  for (let i = 0; i < 5; i++) last = await api('/api/users', { method: 'POST', cookie, body: { name: 'Seat ' + i, email: `seat${i}@brightloom.test` } });
  assert.equal(last.status, 409); assert.equal(last.json.code, 'seat_limit');
  assert.equal((await api('/api/seats', { cookie })).json.seats.available, 0);
});

test('freezing signs the user out immediately; unfreezing lets them back in', async () => {
  const ana = await login('omar@brightloom.test');
  assert.equal((await api('/api/auth/me', { cookie: ana })).status, 200);
  const admin = await login('admin@brightloom.test');
  assert.equal((await api('/api/users/u_bl_omar/freeze', { method: 'POST', cookie: admin, body: { reason: 'test' } })).status, 200);
  assert.equal((await api('/api/auth/me', { cookie: ana })).status, 401);
  const blocked = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '10.2.0.1' }, body: JSON.stringify({ email: 'omar@brightloom.test', password: PW }) });
  assert.equal(blocked.status, 403);
  assert.equal((await api('/api/users/u_bl_omar/unfreeze', { method: 'POST', cookie: admin, body: {} })).status, 200);
  assert.ok(await login('omar@brightloom.test'));
});

test('reset-password signs the user out, the old password stops working, the new one works', async () => {
  const lina = await login('lina@brightloom.test');
  const admin = await login('admin@brightloom.test');
  const r = await api('/api/users/u_bl_lina/reset-password', { method: 'POST', cookie: admin, body: {} });
  assert.equal(r.status, 200); assert.match(r.json.temp_password, /^[A-Za-z0-9]{12}$/);
  assert.equal((await api('/api/auth/me', { cookie: lina })).status, 401);
  const oldTry = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '10.3.0.1' }, body: JSON.stringify({ email: 'lina@brightloom.test', password: PW }) });
  assert.equal(oldTry.status, 401);
  assert.ok(await login('lina@brightloom.test', r.json.temp_password));
});

test('super admin can create an admin for a company and delete an individual', async () => {
  const sa = await login('super@agentflow.test');
  const c = await api('/api/users', { method: 'POST', cookie: sa, body: { name: 'Second Admin', email: 'second@kestrel.test', role: 'admin', tenant_id: 't_kestrel' } });
  assert.equal(c.status, 201); assert.equal(c.json.user.role, 'admin');
  assert.equal((await api('/api/users/' + c.json.user.id, { method: 'DELETE', cookie: sa })).status, 200);
});

/** Earlier tests fill Brightloom's seats; add extra seats through the real super-admin endpoint. */
async function moreSeats(sa) { assert.equal((await api('/api/tenants/t_brightloom', { method: 'PATCH', cookie: sa, body: { extra_seats: 20 } })).status, 200); }

test('peer admins, self-service and super admin protections hold through HTTP', async () => {
  const sa = await login('super@agentflow.test');
  await moreSeats(sa);
  const peer = await api('/api/users', { method: 'POST', cookie: sa, body: { name: 'Peer Admin', email: 'peer@brightloom.test', role: 'admin', tenant_id: 't_brightloom' } });
  assert.equal(peer.status, 201);
  const admin = await login('admin@brightloom.test');
  const id = peer.json.user.id;
  assert.equal((await api(`/api/users/${id}/freeze`, { method: 'POST', cookie: admin, body: {} })).status, 403);
  assert.equal((await api(`/api/users/${id}/reset-password`, { method: 'POST', cookie: admin, body: {} })).status, 403);
  assert.equal((await api(`/api/users/${id}`, { method: 'DELETE', cookie: admin })).status, 403);
  assert.equal((await api('/api/users/u_bl_ana', { method: 'PATCH', cookie: admin, body: { role: 'admin' } })).status, 403);
  assert.equal((await api('/api/users/u_bl_admin/freeze', { method: 'POST', cookie: admin, body: {} })).status, 403);
  assert.equal((await api('/api/users/u_bl_admin', { method: 'DELETE', cookie: admin })).status, 403);
  assert.equal((await api('/api/users/u_super/freeze', { method: 'POST', cookie: sa, body: {} })).status, 403);
  assert.equal((await api('/api/users/u_super', { method: 'DELETE', cookie: sa })).status, 403);
});

test('audit entries record who did what for create, reset, freeze and delete', async () => {
  const admin = await login('admin@brightloom.test'); const sa = await login('super@agentflow.test');
  await moreSeats(sa);
  const made = await api('/api/users', { method: 'POST', cookie: admin, body: { name: 'Audit Subject', email: 'audit.subject@brightloom.test' } });
  const id = made.json.user.id;
  await api(`/api/users/${id}/reset-password`, { method: 'POST', cookie: admin, body: {} });
  await api(`/api/users/${id}/freeze`, { method: 'POST', cookie: admin, body: { reason: 'audit test' } });
  await api(`/api/users/${id}`, { method: 'DELETE', cookie: admin });
  const entries = srv.store.data.auditLog.filter(e => e.target === id);
  assert.deepEqual(entries.map(e => e.action), ['user.create', 'user.reset_password', 'user.freeze', 'user.delete']);
  assert.ok(entries.every(e => e.actor_id === 'u_bl_admin' && e.tenant_id === 't_brightloom'));
  assert.equal(entries[1].meta.generated, true);
  await api('/api/users/u_ke_sam/freeze', { method: 'POST', cookie: admin, body: {} });
  assert.ok(srv.store.data.auditLog.some(e => e.action === 'security.cross_tenant_attempt' && e.actor_id === 'u_bl_admin' && e.tenant_id === 't_brightloom'), 'probing another company leaves a trace');
  void sa;
});

test('the last people able to own a company flows cannot be deleted into oblivion', async () => {
  const sa = await login('super@agentflow.test');
  const t = await api('/api/tenants', { method: 'POST', cookie: sa, body: { name: 'Solo Co', plan_id: 'basic', admin_name: 'Only Admin', admin_email: 'only@solo.test' } });
  assert.equal(t.status, 201);
  const adminId = srv.store.data.users.find(u => u.email === 'only@solo.test').id;
  srv.store.data.flows.push({ id: 'f_solo_co', tenant_id: t.json.tenant.id, owner_id: adminId, name: 'Precious flow', nodes: [], edges: [], version: 1, shared: false, created_at: 'x', updated_at: 'x' });
  const del = await api('/api/users/' + adminId, { method: 'DELETE', cookie: sa });
  assert.equal(del.status, 409);
  assert.match(del.json.error, /flow/i);
  assert.ok(srv.store.data.flows.some(f => f.id === 'f_solo_co'), 'flow still exists');
});

test('email change signs the user out and is audited with old and new values', async () => {
  const admin = await login('admin@brightloom.test');
  const raj = await login('raj@brightloom.test');
  const r = await api('/api/users/u_bl_raj', { method: 'PATCH', cookie: admin, body: { email: 'raj.menon@brightloom.test' } });
  assert.equal(r.status, 200);
  assert.equal((await api('/api/auth/me', { cookie: raj })).status, 401);
  const e = srv.store.data.auditLog.filter(x => x.action === 'user.update' && x.target === 'u_bl_raj').pop();
  assert.equal(e.meta.email_from, 'raj@brightloom.test'); assert.equal(e.meta.email_to, 'raj.menon@brightloom.test');
});

test('bad ids and bodies are rejected cleanly, and list limits are bounded', async () => {
  const cookie0 = await login('admin@brightloom.test');
  for (let i = 0; i < 3; i++) await api('/api/login-events?limit=1', { cookie: cookie0 });
  const big = await api('/api/login-events?limit=9999', { cookie: cookie0 });
  assert.ok(big.json.events.length <= 500);
  assert.equal((await api('/api/login-events?limit=1', { cookie: cookie0 })).json.events.length, 1);
  const cookie = await login('admin@brightloom.test');
  assert.equal((await api('/api/users/not-a-real-id', { method: 'PATCH', cookie, body: { name: 'x' } })).status, 404);
  assert.equal((await api('/api/users', { method: 'POST', cookie, body: { name: '', email: 'bad' } })).status, 400);
  assert.equal((await api('/api/login-events?limit=abc', { cookie })).status, 200);
});
