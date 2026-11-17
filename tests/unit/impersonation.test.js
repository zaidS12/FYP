'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Imp = require('../../server/services/impersonation.js');
const Audit = require('../../server/services/audit.js');

const mk = () => ({
  tenants: [{ id: 't1', name: 'Acme', status: 'active' }, { id: 't2', name: 'Other', status: 'active' }, { id: 't3', name: 'Frozen Co', status: 'frozen' }],
  users: [
    { id: 's', role: 'superadmin', name: 'Root', tenant_id: null, status: 'active' },
    { id: 'a1', role: 'admin', name: 'Ann', tenant_id: 't1', status: 'active' },
    { id: 'a1b', role: 'admin', name: 'Abe', tenant_id: 't1', status: 'active' },
    { id: 'e1', role: 'employee', name: 'Eve', tenant_id: 't1', status: 'active' },
    { id: 'e1f', role: 'employee', name: 'Frank', tenant_id: 't1', status: 'frozen' },
    { id: 'e2', role: 'employee', name: 'Zed', tenant_id: 't2', status: 'active' },
    { id: 'e3', role: 'employee', name: 'Fay', tenant_id: 't3', status: 'active' },
    { id: 'i1', role: 'individual', name: 'Indy', tenant_id: null, status: 'active' },
  ],
  auditLog: [], sessions: [],
});
const U = (d, id) => d.users.find(u => u.id === id);
const can = (d, real, sub, extra) => Imp.canImpersonate(d, U(d, real), U(d, sub), extra);

test('super admin may impersonate any admin or employee, including in frozen companies (flagged)', () => {
  const d = mk();
  assert.equal(can(d, 's', 'a1').ok, true);
  assert.equal(can(d, 's', 'e2').ok, true);
  const f = can(d, 's', 'e3'); assert.equal(f.ok, true); assert.equal(f.frozen, true);
  assert.equal(can(d, 's', 'e1f').frozen, true);
});
test('super admin cannot impersonate individuals, itself or a super admin', () => {
  const d = mk(); d.users.push({ id: 's2', role: 'superadmin', name: 'R2', tenant_id: null, status: 'active' });
  assert.equal(can(d, 's', 'i1').ok, false);
  assert.equal(can(d, 's', 's').ok, false);
  assert.equal(can(d, 's', 's2').status, 403);
});
test('admin may impersonate active employees of their own company only', () => {
  const d = mk();
  assert.equal(can(d, 'a1', 'e1').ok, true);
  assert.equal(can(d, 'a1', 'e2').ok, false);
  assert.equal(can(d, 'a1', 'e2').status, 403);
  assert.equal(can(d, 'a1', 'e1f').ok, false, 'frozen employee');
});
test('admin cannot impersonate admins, super admins, individuals or themselves', () => {
  const d = mk();
  for (const id of ['a1b', 's', 'i1', 'a1']) assert.equal(can(d, 'a1', id).ok, false, id);
});
test('employees and individuals cannot impersonate anyone', () => {
  const d = mk();
  assert.equal(can(d, 'e1', 'e1f').ok, false);
  assert.equal(can(d, 'i1', 'e1').ok, false);
});
test('no chained impersonation and a missing subject is a 404', () => {
  const d = mk();
  assert.equal(can(d, 's', 'e1', { chained: true }).status, 403);
  assert.equal(Imp.canImpersonate(d, U(d, 's'), undefined).status, 404);
});

test('resolve: valid session yields subject; expiry, deletion and later freezing end it', () => {
  const d = mk(); const now = Date.now();
  const sess = { subject_id: 'e1', imp_expires_at: new Date(now + 60000).toISOString() };
  assert.equal(Imp.resolve(d, U(d, 'a1'), sess, now).subject.id, 'e1');
  assert.equal(Imp.resolve(d, U(d, 'a1'), sess, now + 120000).ended, 'expired');
  d.users.find(u => u.id === 'e1').status = 'frozen';
  assert.equal(Imp.resolve(d, U(d, 'a1'), sess, now).ended, 'not_allowed');
  assert.equal(Imp.resolve(d, U(d, 'a1'), { subject_id: 'gone', imp_expires_at: sess.imp_expires_at }, now).ended, 'not_allowed');
  assert.equal(Imp.resolve(d, U(d, 'a1'), {}, now).subject, null);
});
test('resolve re-checks the permission every time: admin loses the right when the employee moves company', () => {
  const d = mk(); const now = Date.now();
  const sess = { subject_id: 'e1', imp_expires_at: new Date(now + 60000).toISOString() };
  U(d, 'e1').tenant_id = 't2';
  assert.equal(Imp.resolve(d, U(d, 'a1'), sess, now).ended, 'not_allowed');
});

test('begin/end write audit entries with actor, subject and context and set the expiry', () => {
  const d = mk(); const sess = {}; const ctx = { ip: '1.2.3.4', browser: 'Chrome 1', os: 'Windows', device: 'Desktop' };
  const r = Imp.begin(d, U(d, 'a1'), sess, U(d, 'e1'), ctx, 1000);
  assert.equal(r.ok, true);
  assert.equal(sess.subject_id, 'e1');
  assert.ok(Date.parse(sess.imp_expires_at) > 1000);
  const e = d.auditLog[0];
  assert.equal(e.action, 'impersonation.started'); assert.equal(e.actor_id, 'a1'); assert.equal(e.target, 'e1'); assert.equal(e.tenant_id, 't1');
  assert.equal(e.meta.ip, '1.2.3.4'); assert.equal(e.meta.browser, 'Chrome 1');
  Imp.end(d, U(d, 'a1'), sess, U(d, 'e1'), ctx, 'returned');
  assert.equal(sess.subject_id, undefined);
  assert.equal(d.auditLog[1].action, 'impersonation.ended'); assert.equal(d.auditLog[1].meta.reason, 'returned');
});
test('begin refuses while already impersonating and when not allowed', () => {
  const d = mk(); const sess = { subject_id: 'e1' };
  assert.equal(Imp.begin(d, U(d, 'a1'), sess, U(d, 'e1'), {}).status, 403);
  assert.equal(Imp.begin(d, U(d, 'a1'), {}, U(d, 'e2'), {}).status, 403);
  assert.equal(d.auditLog.length, 0);
});

test('audit rows say "<actor> acting as <subject>" only during impersonation', () => {
  const d = mk();
  Audit.record(d, { user: U(d, 'e1'), by: null }, 'flow.create', 'f1', 't1', { name: 'x' });
  Audit.record(d, { user: U(d, 'e1'), by: U(d, 'a1') }, 'flow.delete', 'f1', 't1', { name: 'x' });
  assert.equal(d.auditLog[0].actor_name, 'Eve'); assert.equal(d.auditLog[0].meta.acting_as, undefined);
  assert.equal(d.auditLog[1].actor_id, 'a1'); assert.equal(d.auditLog[1].actor_name, 'Ann acting as Eve');
  assert.deepEqual(d.auditLog[1].meta.acting_as, { id: 'e1', name: 'Eve' });
});
test('attribution gives by_id/by_name only when impersonating', () => {
  const d = mk();
  assert.deepEqual(Audit.attribution({ user: U(d, 'e1'), by: null }), {});
  assert.deepEqual(Audit.attribution({ user: U(d, 'e1'), by: U(d, 'a1') }), { by_id: 'a1', by_name: 'Ann' });
});
