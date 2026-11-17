'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const T = require('../../server/services/tenants.js');
const L = require('../../server/services/ledger.js');
const B = require('../../server/services/backup.js');
const Sec = require('../../server/security.js');

const SEED = path.join(__dirname, '..', '..', 'data', 'seed.json');
const fresh = () => JSON.parse(fs.readFileSync(SEED, 'utf8'));
const actor = (data, id) => { const user = data.users.find(u => u.id === id); return { user, session: { user_id: user.id, tenant_id: user.tenant_id, role: user.role } }; };
const addSession = (data, uid) => data.sessions.push({ id: 's' + uid + data.sessions.length, user_id: uid, expires_at: new Date(Date.now() + 1e6).toISOString() });

test('only the super admin can use tenant management', () => {
  const d = fresh();
  for (const who of ['u_bl_admin', 'u_bl_ana', 'u_solo']) {
    assert.equal(T.listTenants(d, actor(d, who)).status, 403, who);
    assert.equal(T.createTenant(d, actor(d, who), {}).status, 403, who);
    assert.equal(T.tenantDetail(d, actor(d, who), 't_kestrel').status, 403, who);
    assert.equal(T.updateTenant(d, actor(d, who), 't_kestrel', { name: 'x' }).status, 403, who);
    assert.equal(T.setTenantFrozen(d, actor(d, who), 't_kestrel', false).status, 403, who);
    assert.equal(T.deleteTenant(d, actor(d, who), 't_kestrel').status, 403, who);
    assert.equal(T.platformStats(d, actor(d, who)).status, 403, who);
  }
});

test('listTenants reports plan, seats, status, usage and monthly revenue per company', () => {
  const d = fresh();
  const r = T.listTenants(d, actor(d, 'u_super'));
  assert.equal(r.ok, true);
  const b = r.tenants.find(t => t.id === 't_brightloom');
  assert.equal(b.plan_name, 'Basic'); assert.equal(b.seats.used, 6); assert.equal(b.seats.limit, 10);
  assert.equal(b.status, 'active'); assert.equal(b.monthly_usd, 100);
  assert.ok(b.credits.used > 0 && b.credits.limit === 5000);
  const k = r.tenants.find(t => t.id === 't_kestrel');
  assert.equal(k.status, 'frozen'); assert.equal(k.monthly_usd, 0, 'frozen companies do not count as revenue');
});

test('createTenant creates the company, its subscription, usage and a first admin with a temporary password', () => {
  const d = fresh();
  const r = T.createTenant(d, actor(d, 'u_super'), { name: 'Northwind Labs', plan_id: 'pro', admin_name: 'Nora Wind', admin_email: 'nora@northwind.test' });
  assert.equal(r.ok, true); assert.equal(r.status, 201);
  assert.match(r.temp_password, /^[A-Za-z0-9]{12}$/);
  const t = d.tenants.find(x => x.id === r.tenant.id);
  assert.equal(t.plan_id, 'pro'); assert.equal(t.status, 'active');
  assert.ok(d.subscriptions.some(s => s.tenant_id === t.id && s.plan_id === 'pro'));
  assert.ok(d.usage.some(u => u.tenant_id === t.id && u.credits_limit === 20000));
  const admin = d.users.find(u => u.email === 'nora@northwind.test');
  assert.equal(admin.role, 'admin'); assert.equal(admin.tenant_id, t.id);
  assert.ok(d.auditLog.some(e => e.action === 'tenant.create' && e.target === t.id));
});

test('createTenant validates name, plan and admin details and does not leave partial data behind', () => {
  const d = fresh(); const before = JSON.stringify(d);
  const sa = actor(d, 'u_super');
  assert.equal(T.createTenant(d, sa, { name: '', plan_id: 'basic', admin_name: 'A', admin_email: 'a@x.test' }).status, 400);
  assert.equal(T.createTenant(d, sa, { name: 'X Co', plan_id: 'free', admin_name: 'A', admin_email: 'a@x.test' }).status, 400);
  assert.equal(T.createTenant(d, sa, { name: 'X Co', plan_id: 'basic', admin_name: 'A', admin_email: 'bad' }).status, 400);
  assert.equal(T.createTenant(d, sa, { name: 'Brightloom Studio', plan_id: 'basic', admin_name: 'A', admin_email: 'a@x.test' }).status, 409);
  assert.equal(T.createTenant(d, sa, { name: 'X Co', plan_id: 'basic', admin_name: 'A', admin_email: 'ana@brightloom.test' }).status, 409);
  assert.equal(JSON.stringify(d), before, 'failed creates must not change data');
});

test('tenantDetail bundles users, devices, logins, invoices, payments, usage and counts', () => {
  const d = fresh();
  const r = T.tenantDetail(d, actor(d, 'u_super'), 't_brightloom');
  assert.equal(r.ok, true);
  assert.equal(r.tenant.name, 'Brightloom Studio'); assert.equal(r.users.length, 6);
  assert.ok(r.devices.length > 0 && r.login_events.length > 0 && r.invoices.length === 3 && r.payments.length === 3);
  assert.equal(r.counts.flows, 3); assert.ok(r.counts.runs >= 5);
  assert.equal(JSON.stringify(r).includes('password_hash'), false);
  assert.equal(T.tenantDetail(d, actor(d, 'u_super'), 'nope').status, 404);
});

test('updateTenant renames, changes plan and extra seats, and refuses to shrink below used seats', () => {
  const d = fresh(); const sa = actor(d, 'u_super');
  assert.equal(T.updateTenant(d, sa, 't_brightloom', { name: 'Brightloom Group' }).tenant.name, 'Brightloom Group');
  const up = T.updateTenant(d, sa, 't_brightloom', { plan_id: 'pro', extra_seats: 3 });
  assert.equal(up.ok, true); assert.equal(up.tenant.seats.limit, 33);
  assert.equal(d.subscriptions.find(s => s.tenant_id === 't_brightloom').plan_id, 'pro');
  assert.equal(d.usage.find(u => u.tenant_id === 't_brightloom').credits_limit, 20000);
  assert.ok(d.auditLog.some(e => e.action === 'tenant.plan_change' && e.target === 't_brightloom'));
  for (let i = 0; i < 5; i++) d.users.push({ id: 'x' + i, tenant_id: 't_brightloom', role: 'employee', email: `x${i}@b.test`, name: 'x', status: 'active' });
  const bad = T.updateTenant(d, sa, 't_brightloom', { plan_id: 'basic', extra_seats: 0 });
  assert.equal(bad.status, 409); assert.match(bad.error, /seats/);
  assert.equal(T.updateTenant(d, sa, 't_brightloom', { plan_id: 'free' }).status, 400);
  assert.equal(T.updateTenant(d, sa, 't_brightloom', { extra_seats: -1 }).status, 400);
  assert.equal(T.updateTenant(d, sa, 'nope', { name: 'x' }).status, 404);
});

test('freezing a company signs everyone out; unfreezing restores access', () => {
  const d = fresh(); const sa = actor(d, 'u_super');
  addSession(d, 'u_bl_ana'); addSession(d, 'u_bl_admin');
  const f = T.setTenantFrozen(d, sa, 't_brightloom', true, 'Chargeback');
  assert.equal(f.ok, true);
  assert.equal(d.tenants.find(t => t.id === 't_brightloom').status, 'frozen');
  assert.equal(d.tenants.find(t => t.id === 't_brightloom').frozen_reason, 'Chargeback');
  assert.equal(d.sessions.filter(s => ['u_bl_ana', 'u_bl_admin'].includes(s.user_id)).length, 0);
  assert.ok(d.auditLog.some(e => e.action === 'tenant.freeze' && e.meta.reason === 'Chargeback'));
  const u = T.setTenantFrozen(d, sa, 't_kestrel', false);
  assert.equal(u.ok, true); assert.equal(d.tenants.find(t => t.id === 't_kestrel').status, 'active');
  assert.equal(d.tenants.find(t => t.id === 't_kestrel').frozen_reason, null);
});

test('deleteTenant removes the company and everything it owns, but keeps an audit trail', () => {
  const d = fresh();
  const r = T.deleteTenant(d, actor(d, 'u_super'), 't_kestrel');
  assert.equal(r.ok, true);
  for (const c of ['users', 'flows', 'flowVersions', 'runs', 'runSteps', 'invoices', 'payments', 'subscriptions', 'usage', 'loginEvents']) {
    assert.equal(d[c].some(x => x.tenant_id === 't_kestrel'), false, c);
  }
  assert.equal(d.devices.some(x => x.user_id.startsWith('u_ke_')), false);
  assert.equal(d.tenants.some(t => t.id === 't_kestrel'), false);
  assert.ok(d.auditLog.some(e => e.action === 'tenant.delete' && e.target === 't_kestrel'));
  assert.equal(d.users.some(u => u.id === 'u_bl_ana'), true, 'other companies untouched');
  assert.equal(T.deleteTenant(d, actor(d, 'u_super'), 't_kestrel').status, 404);
});

test('platformStats summarises companies, accounts, runs, credits, revenue and recent sign-ins', () => {
  const d = fresh();
  const s = T.platformStats(d, actor(d, 'u_super')).stats;
  assert.equal(s.tenants.total, 2); assert.equal(s.tenants.frozen, 1); assert.equal(s.tenants.active, 1);
  assert.equal(s.users.total, d.users.length); assert.equal(s.users.individuals, 1);
  assert.equal(s.runs.total, d.runs.length); assert.ok(s.runs.failed >= 1 && s.runs.success >= 1);
  assert.equal(s.revenue.monthly_usd, 100);
  assert.ok(s.logins_7d.total > 0 && Array.isArray(s.logins_7d.by_day) && s.logins_7d.by_day.length === 7);
  assert.ok(s.flows.total === d.flows.length);
});

test('ledger: super admin sees all invoices, payments and audit; company admin only their own; others refused', () => {
  const d = fresh();
  assert.equal(L.listInvoices(d, actor(d, 'u_super')).invoices.length, d.invoices.length);
  const own = L.listInvoices(d, actor(d, 'u_bl_admin')).invoices;
  assert.ok(own.length === 3 && own.every(i => i.tenant_id === 't_brightloom'));
  assert.ok(own[0].tenant_name);
  assert.ok(L.listPayments(d, actor(d, 'u_bl_admin')).payments.every(p => p.tenant_id === 't_brightloom'));
  const aud = L.listAudit(d, actor(d, 'u_bl_admin'), {}).entries;
  assert.ok(aud.length > 0 && aud.every(e => e.tenant_id === 't_brightloom'));
  assert.ok(L.listAudit(d, actor(d, 'u_super'), {}).entries.some(e => e.tenant_id === null));
  const q = L.listAudit(d, actor(d, 'u_super'), { action: 'user.freeze' }).entries;
  assert.ok(q.length >= 1 && q.every(e => e.action === 'user.freeze'));
  for (const fn of [L.listInvoices, L.listPayments, (a, b) => L.listAudit(a, b, {})]) {
    assert.equal(fn(d, actor(d, 'u_bl_ana')).status, 403);
    assert.equal(fn(d, actor(d, 'u_solo')).status, 403);
  }
});

test('backup: super admin exports everything without sessions; import validates and keeps live sessions', () => {
  const d = fresh(); addSession(d, 'u_super');
  const ex = B.exportAll(d, actor(d, 'u_super'));
  assert.equal(ex.ok, true);
  assert.equal(ex.bundle.format, 'agentflow-db'); assert.equal(ex.bundle.data.sessions.length, 0);
  assert.ok(ex.bundle.data.users[0].password_hash, 'a full backup must keep hashes so it can be restored');
  assert.equal(B.exportAll(d, actor(d, 'u_bl_admin')).status, 403);

  const target = fresh();
  const imp = B.importAll(target, actor(target, 'u_super'), JSON.parse(JSON.stringify(ex.bundle)));
  assert.equal(imp.ok, true); assert.ok(imp.data.users.length === d.users.length);
  assert.equal(B.importAll(target, actor(target, 'u_bl_admin'), ex.bundle).status, 403);
  assert.equal(B.importAll(target, actor(target, 'u_super'), { format: 'nope' }).status, 400);
  assert.equal(B.importAll(target, actor(target, 'u_super'), { format: 'agentflow-db', version: 1, data: { users: [] } }).status, 400);
  const noSuper = JSON.parse(JSON.stringify(ex.bundle)); noSuper.data.users = noSuper.data.users.filter(u => u.role !== 'superadmin');
  const rej = B.importAll(target, actor(target, 'u_super'), noSuper);
  assert.equal(rej.status, 400); assert.match(rej.error, /super admin/i);
});

test('importAll rejects broken entries instead of committing a file that would lock everybody out', () => {
  const d = fresh(); const sa = actor(d, 'u_super');
  const good = () => JSON.parse(JSON.stringify(B.exportAll(d, sa).bundle));
  const cases = {
    'null user': b => { b.data.users.unshift(null); },
    'user without id': b => { delete b.data.users[1].id; },
    'duplicate user id': b => { b.data.users[2].id = b.data.users[1].id; },
    'user without a hash': b => { b.data.users.find(u => u.id === 'u_super').password_hash = ''; },
    'user in an unknown company': b => { b.data.users.find(u => u.id === 'u_bl_ana').tenant_id = 't_ghost'; },
    'flow in an unknown company': b => { b.data.flows[0].tenant_id = 't_ghost'; },
    'string where an object belongs': b => { b.data.tenants[0] = 'oops'; },
    'array instead of object': b => { b.data.plans[0] = []; },
  };
  for (const [name, mutate] of Object.entries(cases)) {
    const b = good(); mutate(b);
    const r = B.importAll(fresh(), sa, b);
    assert.equal(r.ok, false, name); assert.equal(r.status, 400, name); assert.ok(r.error.length > 20, name);
  }
  const noSelf = good(); noSelf.data.users = noSelf.data.users.filter(u => u.id !== 'u_super');
  noSelf.data.users.push({ ...d.users.find(u => u.id === 'u_super'), id: 'u_other_super' });
  assert.match(B.importAll(fresh(), sa, noSelf).error, /your own super admin/i);
});

test('importAll strips prototype-polluting keys and does not touch the live data on failure', () => {
  const d = fresh(); const sa = actor(d, 'u_super');
  const exported = B.exportAll(d, sa).bundle; const before = JSON.stringify(d);   // the export itself is audited, so snapshot after it
  const raw = JSON.stringify(exported).replace('"name":"Brightloom Studio"', '"__proto__":{"polluted":true},"constructor":{"x":1},"name":"Brightloom Studio"');
  const r = B.importAll(d, sa, JSON.parse(raw));
  assert.equal(r.ok, true);
  const t = r.data.tenants.find(x => x.id === 't_brightloom');
  assert.equal(Object.prototype.hasOwnProperty.call(t, '__proto__'), false);
  assert.equal(({}).polluted, undefined); assert.equal(t.constructor, Object);
  assert.equal(JSON.stringify(d), before, 'importAll must not mutate the current data');
});

test('company import caps flow count, node count and refuses non-object nodes', () => {
  const d = fresh(); const adm = actor(d, 'u_bl_admin');
  const mk = nodes => ({ format: 'agentflow-tenant', version: 1, data: { flows: [{ name: 'X', nodes, edges: [] }] } });
  assert.equal(B.importTenant(d, adm, mk(['text'])).status, 400);
  assert.equal(B.importTenant(d, adm, mk(Array.from({ length: 201 }, (_, i) => ({ id: 'n' + i })))).status, 400);
  for (let i = 0; i < 500; i++) d.flows.push({ id: 'pad' + i, tenant_id: 't_brightloom', owner_id: 'u_bl_admin', name: 'p' + i, nodes: [], edges: [] });
  const r = B.importTenant(d, adm, mk([{ id: 'n1', type: 'start', label: 'Start', x: 0, y: 0, config: {} }]));
  assert.equal(r.status, 409); assert.match(r.error, /500/);
});

test('setTenantFrozen is idempotent: repeating it keeps the first reason and adds no audit noise', () => {
  const d = fresh(); const sa = actor(d, 'u_super');
  const audits = () => d.auditLog.filter(e => e.action.startsWith('tenant.')).length;
  const n0 = audits();
  T.setTenantFrozen(d, sa, 't_kestrel', true, 'Second reason');
  assert.equal(d.tenants.find(t => t.id === 't_kestrel').frozen_reason, 'Invoice INV-2026-0007 unpaid');
  T.setTenantFrozen(d, sa, 't_brightloom', false);
  assert.equal(audits(), n0, 'no-op changes are not audited');
});

test('deleteTenant also clears presence and locks of its people', () => {
  const d = fresh();
  d.presence.push({ flow_id: 'f_ke', user_id: 'u_ke_sam', name: 'Sam', at: 'x' }, { flow_id: 'f_news', user_id: 'u_bl_ana', name: 'Ana', at: 'x' });
  d.locks.push({ flow_id: 'f_ke', node_id: 'n1', user_id: 'u_ke_sam', at: 'x', expires_at: 'y' }, { flow_id: 'f_news', node_id: 'n2', user_id: 'u_bl_ana', at: 'x', expires_at: 'y' });
  T.deleteTenant(d, actor(d, 'u_super'), 't_kestrel');
  assert.deepEqual(d.presence.map(p => p.user_id), ['u_bl_ana']);
  assert.deepEqual(d.locks.map(l => l.user_id), ['u_bl_ana']);
});

test('updateTenant refuses string, fractional and negative extra seats', () => {
  const d = fresh(); const sa = actor(d, 'u_super');
  for (const extra_seats of ['3', 1.5, -1, null]) assert.equal(T.updateTenant(d, sa, 't_brightloom', { extra_seats }).status, 400, String(extra_seats));
});

test('backup: a company admin exports and imports only their own company flows, never other tenants', () => {
  const d = fresh();
  const ex = B.exportTenant(d, actor(d, 'u_bl_admin'));
  assert.equal(ex.ok, true);
  assert.equal(JSON.stringify(ex.bundle).includes('password_hash'), false);
  assert.ok(ex.bundle.data.flows.length === 3 && ex.bundle.data.flows.every(f => f.tenant_id === 't_brightloom'));
  assert.equal(B.exportTenant(d, actor(d, 'u_bl_ana')).status, 403);

  const forged = JSON.parse(JSON.stringify(ex.bundle));
  forged.data.flows[0].tenant_id = 't_kestrel'; forged.data.flows[0].id = 'f_forged'; forged.data.flows[0].owner_id = 'u_ke_sam';
  const before = d.flows.length;
  const r = B.importTenant(d, actor(d, 'u_bl_admin'), forged);
  assert.equal(r.ok, true);
  assert.ok(d.flows.length > before, 'flows were added');
  assert.ok(d.flows.every(f => f.tenant_id === 't_brightloom' || f.tenant_id === 't_kestrel' || f.tenant_id === null));
  const imported = d.flows.filter(f => f.imported_at);
  assert.equal(imported.length, 3);
  assert.ok(imported.every(f => f.tenant_id === 't_brightloom' && f.owner_id === 'u_bl_admin' && f.name.endsWith('(imported)')));
  assert.equal(d.flows.some(f => f.id === 'f_forged'), false, 'client ids are never trusted');
  assert.equal(B.importTenant(d, actor(d, 'u_bl_admin'), { format: 'x' }).status, 400);
});

test('company import validates every card like a normal save, caps total size, and exports are audited', () => {
  const d = fresh(); const adm = actor(d, 'u_bl_admin');
  const bundle = nodes => ({ format: 'agentflow-tenant', version: 1, data: { flows: [{ name: 'X', nodes, edges: [] }] } });
  const huge = [{ id: 'n1', type: 'start', label: 'Start', x: 0, y: 0, config: { note: 'A'.repeat(30000) } }];
  assert.equal(B.importTenant(d, adm, bundle(huge)).status, 400, 'oversized card settings are refused');
  assert.equal(B.importTenant(d, adm, bundle([{ id: 'n1', type: 'x<script>', label: 'L', x: 'a', y: 0, config: {} }])).status, 400);
  const many = { format: 'agentflow-tenant', version: 1, data: { flows: Array.from({ length: 10 }, (_, i) => ({ name: 'F' + i, nodes: Array.from({ length: 30 }, (__, k) => ({ id: 'n' + k, type: 'summarize', label: 'S', x: 0, y: 0, config: { note: 'B'.repeat(19000) } })), edges: [] })) } };
  assert.equal(B.importTenant(d, adm, many).status, 413);
  const before = d.auditLog.length;
  B.exportTenant(d, adm); B.exportAll(d, actor(d, 'u_super'));
  assert.deepEqual(d.auditLog.slice(before).map(e => e.action), ['flows.export', 'db.export']);
});
