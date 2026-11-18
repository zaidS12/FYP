'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const U = require('../../server/services/users.js');
const Sec = require('../../server/security.js');

const SEED = path.join(__dirname, '..', '..', 'data', 'seed.json');
const fresh = () => JSON.parse(fs.readFileSync(SEED, 'utf8'));
const actor = (data, id) => { const user = data.users.find(u => u.id === id); return { user, session: { user_id: user.id, tenant_id: user.tenant_id, role: user.role } }; };
const addSession = (data, uid) => data.sessions.push({ id: 'sess_' + uid + data.sessions.length, user_id: uid, tenant_id: null, role: 'x', expires_at: new Date(Date.now() + 1e6).toISOString() });

test('seatInfo counts admins and employees (frozen included) against plan seats + extra seats', () => {
  const d = fresh();
  assert.deepEqual(U.seatInfo(d, 't_brightloom'), { tenant_id: 't_brightloom', plan_id: 'basic', used: 6, limit: 10, available: 4, extra_seat_usd: 8 });
  d.tenants[0].extra_seats = 2;
  assert.equal(U.seatInfo(d, 't_brightloom').limit, 12);
  assert.equal(U.seatInfo(d, 'nope'), null);
});

test('listUsers: admin sees only their company, super admin sees everyone, others are refused', () => {
  const d = fresh();
  const a = U.listUsers(d, actor(d, 'u_bl_admin'));
  assert.equal(a.ok, true);
  assert.ok(a.users.length === 6 && a.users.every(u => u.tenant_id === 't_brightloom'));
  assert.equal(JSON.stringify(a).includes('password_hash'), false);
  assert.ok(a.users.find(u => u.id === 'u_bl_ana').device_count >= 2);
  assert.equal(U.listUsers(d, actor(d, 'u_super')).users.length, d.users.length);
  assert.equal(U.listUsers(d, actor(d, 'u_bl_ana')).status, 403);
  assert.equal(U.listUsers(d, actor(d, 'u_solo')).status, 403);
});

test('createUser by a company admin always creates an employee in their own company', () => {
  const d = fresh();
  const r = U.createUser(d, actor(d, 'u_bl_admin'), { name: 'New Hire', email: 'New.Hire@Agentflow.com', role: 'admin', tenant_id: 't_kestrel' });
  assert.equal(r.ok, true); assert.equal(r.status, 201);
  assert.equal(r.user.role, 'employee'); assert.equal(r.user.tenant_id, 't_brightloom');
  assert.equal(r.user.email, 'new.hire@agentflow.com');
  assert.match(r.temp_password, /^[A-Za-z0-9]{12}$/);
  const stored = d.users.find(u => u.id === r.user.id);
  assert.match(stored.password_hash, /^scrypt\$/);
  assert.equal(Sec.verifyPassword(r.temp_password, stored.password_hash), true);
  assert.ok(d.auditLog.some(e => e.action === 'user.create' && e.target === r.user.id && e.tenant_id === 't_brightloom'));
});

test('createUser enforces the seat limit with a message that says how to fix it', () => {
  const d = fresh(); const adm = actor(d, 'u_bl_admin');
  for (let i = 0; i < 4; i++) assert.equal(U.createUser(d, adm, { name: 'E' + i, email: `e${i}@agentflow.com` }).ok, true);
  const r = U.createUser(d, adm, { name: 'One Too Many', email: 'late@agentflow.com' });
  assert.equal(r.ok, false); assert.equal(r.status, 409); assert.equal(r.code, 'seat_limit');
  assert.match(r.error, /10 seats/); assert.match(r.error, /extra seat|upgrade/i);
  d.tenants[0].extra_seats = 1;
  assert.equal(U.createUser(d, adm, { name: 'Now Fits', email: 'fits@agentflow.com' }).ok, true);
});

test('createUser validates input and rejects duplicate emails', () => {
  const d = fresh(); const adm = actor(d, 'u_bl_admin');
  const bad = U.createUser(d, adm, { name: '', email: 'x' });
  assert.equal(bad.status, 400); assert.ok(bad.errors.name && bad.errors.email);
  assert.equal(U.createUser(d, adm, { name: 'Dup', email: 'ANA@agentflow.com' }).status, 409);
  assert.equal(U.createUser(d, adm, { name: 'Weak', email: 'w@agentflow.com', password: 'short' }).status, 400);
  assert.equal(U.createUser(d, actor(d, 'u_bl_ana'), { name: 'X', email: 'x@agentflow.com' }).status, 403);
});

test('super admin creates admins for a chosen company but never another super admin', () => {
  const d = fresh(); const sa = actor(d, 'u_super');
  const r = U.createUser(d, sa, { name: 'Kestrel Two', email: 'two@kestrel.com', role: 'admin', tenant_id: 't_kestrel' });
  assert.equal(r.ok, true); assert.equal(r.user.role, 'admin'); assert.equal(r.user.tenant_id, 't_kestrel');
  assert.equal(U.createUser(d, sa, { name: 'Root', email: 'root@x.test', role: 'superadmin' }).status, 400);
  assert.equal(U.createUser(d, sa, { name: 'Lost', email: 'l@x.test', role: 'employee', tenant_id: 'nope' }).status, 400);
  assert.equal(U.createUser(d, sa, { name: 'Lost', email: 'l2@x.test', role: 'employee' }).status, 400);
});

test('updateUser: admins edit their own employees only; cross-company targets look like they do not exist', () => {
  const d = fresh(); const adm = actor(d, 'u_bl_admin');
  const r = U.updateUser(d, adm, 'u_bl_ana', { name: 'Ana T.', email: 'ana.t@agentflow.com' });
  assert.equal(r.ok, true); assert.equal(r.user.email, 'ana.t@agentflow.com');
  assert.equal(U.updateUser(d, adm, 'u_ke_sam', { name: 'Hack' }).status, 404);
  assert.equal(U.updateUser(d, adm, 'u_super', { name: 'Hack' }).status, 404);
  assert.equal(U.updateUser(d, adm, 'u_bl_omar', { email: 'ana.t@agentflow.com' }).status, 409);
  assert.equal(U.updateUser(d, adm, 'u_bl_omar', { role: 'admin' }).status, 403);
  assert.equal(U.updateUser(d, actor(d, 'u_bl_ana'), 'u_bl_omar', { name: 'x' }).status, 403);
});

test('resetPassword sets a new scrypt hash, signs the user out everywhere, and respects scope', () => {
  const d = fresh(); const adm = actor(d, 'u_bl_admin');
  addSession(d, 'u_bl_ana');
  const r = U.resetPassword(d, adm, 'u_bl_ana', {});
  assert.equal(r.ok, true); assert.match(r.temp_password, /^[A-Za-z0-9]{12}$/);
  assert.equal(Sec.verifyPassword(r.temp_password, d.users.find(u => u.id === 'u_bl_ana').password_hash), true);
  assert.equal(d.sessions.some(s => s.user_id === 'u_bl_ana'), false);
  const chosen = U.resetPassword(d, adm, 'u_bl_omar', { password: 'Chosen#Pass9' });
  assert.equal(chosen.ok, true); assert.equal('temp_password' in chosen, false);
  assert.equal(U.resetPassword(d, adm, 'u_bl_lina', { password: 'weak' }).status, 400);
  assert.equal(U.resetPassword(d, adm, 'u_ke_sam', {}).status, 404);
  assert.equal(U.resetPassword(d, adm, 'u_super', {}).status, 404);
  assert.equal(U.resetPassword(d, actor(d, 'u_super'), 'u_ke_admin', {}).ok, true);
  assert.equal(U.resetPassword(d, actor(d, 'u_bl_ana'), 'u_bl_omar', {}).status, 403);
});

test('setFrozen revokes sessions at once; admins freeze employees only, never themselves', () => {
  const d = fresh(); const adm = actor(d, 'u_bl_admin');
  addSession(d, 'u_bl_raj');
  const f = U.setFrozen(d, adm, 'u_bl_raj', true, 'Left the team');
  assert.equal(f.ok, true); assert.equal(f.user.status, 'frozen');
  assert.equal(d.sessions.some(s => s.user_id === 'u_bl_raj'), false);
  assert.ok(d.auditLog.some(e => e.action === 'user.freeze' && e.target === 'u_bl_raj'));
  assert.equal(U.setFrozen(d, adm, 'u_bl_raj', false).user.status, 'active');
  assert.equal(U.setFrozen(d, adm, 'u_bl_admin', true).status, 403);
  assert.equal(U.setFrozen(d, adm, 'u_ke_sam', true).status, 404);
  const sa = actor(d, 'u_super');
  assert.equal(U.setFrozen(d, sa, 'u_bl_admin', true).ok, true);
  assert.equal(U.setFrozen(d, sa, 'u_super', true).status, 403);
});

test('deleteUser hands company flows to the acting admin and removes an individual together with their flows', () => {
  const d = fresh(); const adm = actor(d, 'u_bl_admin');
  const r = U.deleteUser(d, adm, 'u_bl_ana');
  assert.equal(r.ok, true);
  assert.equal(d.users.some(u => u.id === 'u_bl_ana'), false);
  assert.equal(d.flows.find(f => f.id === 'f_news').owner_id, 'u_bl_admin');
  assert.equal(U.deleteUser(d, adm, 'u_bl_admin').status, 403);
  assert.equal(U.deleteUser(d, adm, 'u_ke_sam').status, 404);
  assert.equal(U.deleteUser(d, actor(d, 'u_super'), 'u_solo').ok, true);
  assert.equal(d.flows.some(f => f.owner_id === 'u_solo'), false);
  assert.equal(U.deleteUser(d, actor(d, 'u_super'), 'u_super').status, 403);
});

test('devices and login events are scoped like users', () => {
  const d = fresh();
  const own = U.listDevices(d, actor(d, 'u_bl_admin')).devices;
  assert.ok(own.length > 0 && own.every(x => x.tenant_id === 't_brightloom'));
  assert.ok(own[0].user_name && own[0].browser && own[0].os);
  const all = U.listDevices(d, actor(d, 'u_super')).devices;
  assert.ok(all.length > own.length);
  assert.equal(U.listDevices(d, actor(d, 'u_bl_ana')).status, 403);
  const ev = U.listLoginEvents(d, actor(d, 'u_bl_admin'), { limit: 5 });
  assert.ok(ev.events.length <= 5 && ev.events.every(e => e.tenant_id === 't_brightloom'));
  assert.ok(ev.events[0].at >= ev.events[ev.events.length - 1].at, 'newest first');
  assert.equal(U.listLoginEvents(d, actor(d, 'u_solo'), {}).status, 403);
});
