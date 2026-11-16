'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const T = require('../../assets/js/tenancy.js');

const records = [
  { id: 'a', tenant_id: 't1', owner_id: 'u1' },
  { id: 'b', tenant_id: 't1', owner_id: 'u2' },
  { id: 'c', tenant_id: 't2', owner_id: 'u3' },
  { id: 'd', tenant_id: null, owner_id: 'u9' },
  { id: 'e', tenant_id: null, owner_id: 'u8' },
];

test('super admin sees everything', () => {
  assert.equal(T.scope({ role: 'superadmin', user_id: 's', tenant_id: null }, records).length, 5);
});

test('company users see only their own tenant, including colleagues records', () => {
  const ids = T.scope({ role: 'employee', user_id: 'u1', tenant_id: 't1' }, records).map(r => r.id);
  assert.deepEqual(ids, ['a', 'b']);
  const adminIds = T.scope({ role: 'admin', user_id: 'u2', tenant_id: 't2' }, records).map(r => r.id);
  assert.deepEqual(adminIds, ['c']);
});

test('individuals see only their own tenant-less records', () => {
  const ids = T.scope({ role: 'individual', user_id: 'u9', tenant_id: null }, records).map(r => r.id);
  assert.deepEqual(ids, ['d']);
});

test('a session without a tenant and a company role sees nothing (never everything)', () => {
  assert.deepEqual(T.scope({ role: 'employee', user_id: 'u1', tenant_id: null }, records), []);
  assert.deepEqual(T.scope(null, records), []);
  assert.deepEqual(T.scope({ role: 'wizard', user_id: 'u1', tenant_id: 't1' }, records), []);
});

test('canAccess mirrors scope for single records', () => {
  const emp = { role: 'employee', user_id: 'u1', tenant_id: 't1' };
  assert.equal(T.canAccess(emp, records[1]), true);
  assert.equal(T.canAccess(emp, records[2]), false);
  assert.equal(T.canAccess(emp, null), false);
  assert.equal(T.canAccess({ role: 'superadmin' }, records[2]), true);
});

test('private flows are visible only to their owner, company admins and super admin', () => {
  const flows = [
    { id: 'shared', tenant_id: 't1', owner_id: 'u2', shared: true },
    { id: 'mine', tenant_id: 't1', owner_id: 'u1', shared: false },
    { id: 'theirs', tenant_id: 't1', owner_id: 'u2', shared: false },
    { id: 'solo', tenant_id: null, owner_id: 'u9', shared: false },
  ];
  const ids = s => T.scopeFlows(s, flows).map(f => f.id);
  assert.deepEqual(ids({ role: 'employee', user_id: 'u1', tenant_id: 't1' }), ['shared', 'mine']);
  assert.deepEqual(ids({ role: 'admin', user_id: 'a', tenant_id: 't1' }), ['shared', 'mine', 'theirs']);
  assert.deepEqual(ids({ role: 'individual', user_id: 'u9', tenant_id: null }), ['solo']);
  assert.equal(ids({ role: 'superadmin', user_id: 's' }).length, 4);
  assert.equal(T.canAccessFlow({ role: 'employee', user_id: 'u1', tenant_id: 't1' }, flows[2]), false);
});

test('stamp adds tenant_id from the session, ignoring any client value', () => {
  const rec = T.stamp({ role: 'employee', user_id: 'u1', tenant_id: 't1' }, { name: 'x', tenant_id: 'EVIL' });
  assert.equal(rec.tenant_id, 't1');
  assert.equal(rec.owner_id, 'u1');
  const ind = T.stamp({ role: 'individual', user_id: 'u9', tenant_id: null }, { tenant_id: 't1' });
  assert.equal(ind.tenant_id, null);
});
