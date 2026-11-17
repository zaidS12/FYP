'use strict';
/* Company (tenant) management for the super admin: list, create, detail, change plan/seats, freeze, delete, platform stats. */
const Auth = require('../../assets/js/auth.js');
const Sec = require('../security.js');
const Users = require('./users.js');

const ok = (status, extra) => Object.assign({ ok: true, status }, extra);
const fail = (status, error, extra) => Object.assign({ ok: false, status, error }, extra || {});
const iso = () => new Date().toISOString();
const DENIED = () => fail(403, 'Only the super admin can manage companies.');
const isSuper = actor => actor.user.role === 'superadmin';
const paidPlan = (data, id) => data.plans.find(p => p.id === id && p.audience === 'company') || null;

function monthlyUsd(data, t) {
  if (t.status !== 'active') return 0;
  const plan = data.plans.find(p => p.id === t.plan_id);
  return plan ? plan.price_usd + (t.extra_seats || 0) * plan.extra_seat_usd : 0;
}

function tenantRow(data, t) {
  const plan = data.plans.find(p => p.id === t.plan_id) || {};
  const use = data.usage.find(u => u.tenant_id === t.id) || { credits_used: 0, credits_limit: plan.credits_per_month || 0 };
  return {
    id: t.id, name: t.name, plan_id: t.plan_id, plan_name: plan.name || t.plan_id, status: t.status, frozen_reason: t.frozen_reason || null,
    extra_seats: t.extra_seats || 0, created_at: t.created_at, seats: Users.seatInfo(data, t.id), monthly_usd: monthlyUsd(data, t),
    credits: { used: use.credits_used, limit: use.credits_limit }, user_count: data.users.filter(u => u.tenant_id === t.id).length,
    flow_count: data.flows.filter(f => f.tenant_id === t.id).length,
  };
}

function listTenants(data, actor) {
  if (!isSuper(actor)) return DENIED();
  return ok(200, { tenants: data.tenants.map(t => tenantRow(data, t)) });
}

function createTenant(data, actor, input) {
  if (!isSuper(actor)) return DENIED();
  const src = input && typeof input === 'object' ? input : {};
  const name = typeof src.name === 'string' ? src.name.trim() : '';
  const adminName = typeof src.admin_name === 'string' ? src.admin_name.trim() : '';
  const adminEmail = typeof src.admin_email === 'string' ? src.admin_email.trim().toLowerCase() : '';
  const errors = {};
  if (!name || name.length > 80) errors.name = 'Enter the company name (up to 80 characters).';
  const plan = paidPlan(data, src.plan_id);
  if (!plan) errors.plan_id = 'Choose Basic or Pro. The Free plan is for individuals.';
  if (!adminName || adminName.length > 80) errors.admin_name = 'Enter the first admin\'s name.';
  if (!Auth.validateEmail(adminEmail)) errors.admin_email = 'Enter a valid email address for the first admin.';
  if (Object.keys(errors).length) return fail(400, 'Check the highlighted fields and try again.', { errors });
  if (data.tenants.some(t => t.name.toLowerCase() === name.toLowerCase())) return fail(409, 'A company with this name already exists.', { errors: { name: 'This company name is taken.' } });
  if (data.users.some(u => u.email === adminEmail)) return fail(409, 'An account with this email already exists.', { errors: { admin_email: 'This email is already used by another account.' } });

  const now = iso();
  const tenant = { id: Sec.newId('t'), name, plan_id: plan.id, status: 'active', frozen_reason: null, extra_seats: 0, created_at: now };
  data.tenants.push(tenant);
  const created = Users.createUser(data, actor, { name: adminName, email: adminEmail, role: 'admin', tenant_id: tenant.id });
  if (!created.ok) { data.tenants = data.tenants.filter(t => t.id !== tenant.id); return created; }
  data.subscriptions.push({ id: 'sub_' + tenant.id, tenant_id: tenant.id, plan_id: plan.id, status: 'active', period_start: now, period_end: new Date(Date.now() + 30 * 86400000).toISOString(), extra_seats: 0 });
  data.usage.push({ id: 'use_' + tenant.id, tenant_id: tenant.id, user_id: null, period: now.slice(0, 7), credits_used: 0, credits_limit: plan.credits_per_month });
  Users.audit(data, actor, 'tenant.create', tenant.id, null, { name, plan: plan.id });
  return ok(201, { tenant: tenantRow(data, tenant), temp_password: created.temp_password });
}

function tenantDetail(data, actor, id) {
  if (!isSuper(actor)) return DENIED();
  const t = data.tenants.find(x => x.id === id);
  if (!t) return fail(404, 'No such company.');
  const members = data.users.filter(u => u.tenant_id === id);
  const ids = new Set(members.map(u => u.id));
  const names = new Map(members.map(u => [u.id, u]));
  const devices = data.devices.filter(d => ids.has(d.user_id)).map(d => Object.assign({}, d, { user_name: names.get(d.user_id).name, user_email: names.get(d.user_id).email }));
  const events = data.loginEvents.filter(e => e.tenant_id === id).sort((a, b) => (b.at > a.at ? 1 : -1)).slice(0, 50)
    .map(e => Object.assign({}, e, { user_name: (names.get(e.user_id) || {}).name || 'Deleted user' }));
  return ok(200, {
    tenant: tenantRow(data, t), users: members.map(u => Users.userRow(data, u)), devices, login_events: events,
    invoices: data.invoices.filter(i => i.tenant_id === id).sort((a, b) => (b.issued_at > a.issued_at ? 1 : -1)),
    payments: data.payments.filter(p => p.tenant_id === id).sort((a, b) => (b.created_at > a.created_at ? 1 : -1)),
    counts: { users: members.length, flows: data.flows.filter(f => f.tenant_id === id).length, runs: data.runs.filter(r => r.tenant_id === id).length },
  });
}

function updateTenant(data, actor, id, patch) {
  if (!isSuper(actor)) return DENIED();
  const t = data.tenants.find(x => x.id === id);
  if (!t) return fail(404, 'No such company.');
  const src = patch && typeof patch === 'object' ? patch : {};
  const errors = {}; const next = {};
  if (src.name !== undefined) {
    const n = typeof src.name === 'string' ? src.name.trim() : '';
    if (!n || n.length > 80) errors.name = 'Enter the company name (up to 80 characters).';
    else if (data.tenants.some(x => x.id !== id && x.name.toLowerCase() === n.toLowerCase())) return fail(409, 'A company with this name already exists.', { errors: { name: 'This company name is taken.' } });
    else next.name = n;
  }
  if (src.plan_id !== undefined) { if (paidPlan(data, src.plan_id)) next.plan_id = src.plan_id; else errors.plan_id = 'Choose Basic or Pro. The Free plan is for individuals.'; }
  if (src.extra_seats !== undefined) { if (Number.isInteger(src.extra_seats) && src.extra_seats >= 0 && src.extra_seats <= 1000) next.extra_seats = src.extra_seats; else errors.extra_seats = 'Extra seats must be a whole number from 0 to 1000.'; }
  if (Object.keys(errors).length) return fail(400, 'Check the highlighted fields and try again.', { errors });
  if (!Object.keys(next).length) return fail(400, 'Nothing to change. Send a name, plan or extra seats.');

  const plan = data.plans.find(p => p.id === (next.plan_id || t.plan_id));
  const newLimit = plan.seats + (next.extra_seats !== undefined ? next.extra_seats : (t.extra_seats || 0));
  const used = Users.seatInfo(data, id).used;
  if (newLimit < used) return fail(409, `${t.name} has ${used} accounts, but this plan only has ${newLimit} seats. Delete or freeze accounts first, or keep more seats.`, { code: 'seats_below_used' });

  const planChanged = (next.plan_id && next.plan_id !== t.plan_id) || (next.extra_seats !== undefined && next.extra_seats !== (t.extra_seats || 0));
  const before = { plan: t.plan_id, extra_seats: t.extra_seats || 0 };
  Object.assign(t, next);
  const sub = data.subscriptions.find(s => s.tenant_id === id);
  if (sub) { sub.plan_id = t.plan_id; sub.extra_seats = t.extra_seats || 0; }
  if (next.plan_id) { const use = data.usage.find(u => u.tenant_id === id); if (use) use.credits_limit = plan.credits_per_month; }
  if (planChanged) Users.audit(data, actor, 'tenant.plan_change', id, id, { from: before, to: { plan: t.plan_id, extra_seats: t.extra_seats || 0 } });
  if (next.name) Users.audit(data, actor, 'tenant.update', id, id, { name: next.name });
  return ok(200, { tenant: tenantRow(data, t) });
}

function setTenantFrozen(data, actor, id, frozen, reason) {
  if (!isSuper(actor)) return DENIED();
  const t = data.tenants.find(x => x.id === id);
  if (!t) return fail(404, 'No such company.');
  if ((t.status === 'frozen') === !!frozen) return ok(200, { tenant: tenantRow(data, t) }); // already in that state: keep the original reason, no audit noise
  t.status = frozen ? 'frozen' : 'active';
  t.frozen_reason = frozen ? (typeof reason === 'string' && reason.trim() ? reason.trim().slice(0, 200) : 'Frozen by the super admin') : null;
  const sub = data.subscriptions.find(s => s.tenant_id === id);
  if (sub) sub.status = frozen ? 'suspended' : 'active';
  if (frozen) { const ids = new Set(data.users.filter(u => u.tenant_id === id).map(u => u.id)); data.sessions = data.sessions.filter(s => !ids.has(s.user_id)); }
  Users.audit(data, actor, frozen ? 'tenant.freeze' : 'tenant.unfreeze', id, id, frozen ? { reason: t.frozen_reason } : {});
  return ok(200, { tenant: tenantRow(data, t) });
}

function deleteTenant(data, actor, id) {
  if (!isSuper(actor)) return DENIED();
  const t = data.tenants.find(x => x.id === id);
  if (!t) return fail(404, 'No such company.');
  const ids = new Set(data.users.filter(u => u.tenant_id === id).map(u => u.id));
  for (const c of ['flows', 'flowVersions', 'runs', 'runSteps', 'invoices', 'payments', 'subscriptions', 'usage', 'loginEvents', 'templates']) data[c] = data[c].filter(x => x.tenant_id !== id);
  data.devices = data.devices.filter(d => !ids.has(d.user_id));
  data.sessions = data.sessions.filter(s => !ids.has(s.user_id));
  data.presence = data.presence.filter(p => !ids.has(p.user_id));
  data.locks = data.locks.filter(l => !ids.has(l.user_id));
  data.users = data.users.filter(u => u.tenant_id !== id);
  data.tenants = data.tenants.filter(x => x.id !== id);
  Users.audit(data, actor, 'tenant.delete', id, null, { name: t.name, accounts: ids.size });
  return ok(200, { deleted: id });
}

function platformStats(data, actor) {
  if (!isSuper(actor)) return DENIED();
  const day = ms => new Date(ms).toISOString().slice(0, 10);
  const days = []; for (let i = 6; i >= 0; i--) days.push(day(Date.now() - i * 86400000));
  const week = data.loginEvents.filter(e => days.includes(e.at.slice(0, 10)));
  const credits = data.usage.reduce((a, u) => ({ used: a.used + u.credits_used, limit: a.limit + u.credits_limit }), { used: 0, limit: 0 });
  return ok(200, {
    stats: {
      tenants: { total: data.tenants.length, active: data.tenants.filter(t => t.status === 'active').length, frozen: data.tenants.filter(t => t.status === 'frozen').length },
      users: { total: data.users.length, admins: data.users.filter(u => u.role === 'admin').length, employees: data.users.filter(u => u.role === 'employee').length, individuals: data.users.filter(u => u.role === 'individual').length, frozen: data.users.filter(u => u.status === 'frozen').length },
      flows: { total: data.flows.length },
      runs: { total: data.runs.length, success: data.runs.filter(r => r.status === 'success').length, failed: data.runs.filter(r => r.status === 'failed').length },
      credits,
      revenue: { monthly_usd: data.tenants.reduce((a, t) => a + monthlyUsd(data, t), 0) },
      devices: { total: data.devices.length, browsers: new Set(data.devices.map(d => d.browser)).size },
      logins_7d: { total: week.length, failed: week.filter(e => !e.success).length, by_day: days.map(d => ({ date: d, success: week.filter(e => e.at.slice(0, 10) === d && e.success).length, failed: week.filter(e => e.at.slice(0, 10) === d && !e.success).length })) },
    },
  });
}

/** Company admin dashboard numbers (their own company only). */
function companyStats(data, actor) {
  if (actor.user.role !== 'admin' || !actor.user.tenant_id) return fail(403, 'Only the company admin can see company statistics.');
  const id = actor.user.tenant_id; const t = data.tenants.find(x => x.id === id);
  if (!t) return fail(404, 'Company not found.');
  const members = data.users.filter(u => u.tenant_id === id); const ids = new Set(members.map(u => u.id));
  const runs = data.runs.filter(r => r.tenant_id === id); const use = data.usage.find(u => u.tenant_id === id) || { credits_used: 0, credits_limit: 0 };
  const devices = data.devices.filter(d => ids.has(d.user_id));
  const day = ms => new Date(ms).toISOString().slice(0, 10);
  const days = []; for (let i = 6; i >= 0; i--) days.push(day(Date.now() - i * 86400000));
  const week = data.loginEvents.filter(e => e.tenant_id === id && days.includes(e.at.slice(0, 10)));
  return ok(200, { stats: {
    users: { total: members.length, admins: members.filter(u => u.role === 'admin').length, employees: members.filter(u => u.role === 'employee').length, frozen: members.filter(u => u.status === 'frozen').length },
    flows: { total: data.flows.filter(f => f.tenant_id === id).length, shared: data.flows.filter(f => f.tenant_id === id && f.shared).length },
    runs: { total: runs.length, success: runs.filter(r => r.status === 'success').length, failed: runs.filter(r => r.status === 'failed').length },
    seats: Users.seatInfo(data, id), credits: { used: use.credits_used, limit: use.credits_limit },
    devices: { total: devices.length, browsers: new Set(devices.map(d => d.browser)).size },
    logins_7d: { total: week.length, failed: week.filter(e => !e.success).length, by_day: days.map(d => ({ date: d, success: week.filter(e => e.at.slice(0, 10) === d && e.success).length, failed: week.filter(e => e.at.slice(0, 10) === d && !e.success).length })) },
    plan_name: (data.plans.find(p => p.id === t.plan_id) || {}).name || t.plan_id,
  } });
}

module.exports = { companyStats, listTenants, createTenant, tenantDetail, updateTenant, setTenantFrozen, deleteTenant, platformStats, tenantRow, monthlyUsd };
