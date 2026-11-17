'use strict';
/* User management rules: scoping, seat limits, create/edit/reset/freeze/delete, devices and login events.
 * Pure functions over the db object so they are unit-testable. `actor` = {user, session} from the server session.
 * Every function returns {ok, status, ...} and never throws on bad input. */
const Auth = require('../../assets/js/auth.js');
const Sec = require('../security.js');
const Audit = require('./audit.js');

const ok = (status, extra) => Object.assign({ ok: true, status }, extra);
const fail = (status, error, extra) => Object.assign({ ok: false, status, error }, extra || {});
const COMPANY_ROLES = ['admin', 'employee'];
const iso = () => new Date().toISOString();

const audit = Audit.record;

function seatInfo(data, tenantId) {
  const t = data.tenants.find(x => x.id === tenantId);
  if (!t) return null;
  const plan = data.plans.find(p => p.id === t.plan_id) || { seats: 0, extra_seat_usd: 0 };
  const used = data.users.filter(u => u.tenant_id === tenantId && COMPANY_ROLES.includes(u.role)).length;
  const limit = plan.seats + (t.extra_seats || 0);
  return { tenant_id: tenantId, plan_id: t.plan_id, used, limit, available: Math.max(0, limit - used), extra_seat_usd: plan.extra_seat_usd };
}

const denyUnlessManager = actor => (Auth.can(actor.user.role, 'users.manage') ? null : fail(403, 'Only company admins and the super admin can manage accounts.'));
const isSuper = actor => actor.user.role === 'superadmin';

function scopedUsers(data, actor) {
  return isSuper(actor) ? data.users : data.users.filter(u => u.tenant_id && u.tenant_id === actor.user.tenant_id && u.role !== 'superadmin');
}
function findTarget(data, actor, id) {
  return scopedUsers(data, actor).find(u => u.id === id) || null;
}

function userRow(data, u) {
  const devs = data.devices.filter(d => d.user_id === u.id);
  const t = u.tenant_id ? data.tenants.find(x => x.id === u.tenant_id) : null;
  const last = data.loginEvents.filter(e => e.user_id === u.id && e.success).reduce((m, e) => (e.at > m ? e.at : m), '');
  return Object.assign(Auth.publicUser(u), {
    tenant_name: t ? t.name : null, created_at: u.created_at, created_by: u.created_by || null,
    last_login: last || null, device_count: devs.length, browser_count: new Set(devs.map(d => d.browser)).size,
  });
}

function listUsers(data, actor) {
  const d = denyUnlessManager(actor); if (d) return d;
  const users = scopedUsers(data, actor).map(u => userRow(data, u));
  return ok(200, { users, seats: isSuper(actor) ? null : seatInfo(data, actor.user.tenant_id) });
}

function seatsFor(data, actor, tenantId) {
  const d = denyUnlessManager(actor); if (d) return d;
  const id = isSuper(actor) ? tenantId : actor.user.tenant_id;
  const info = id ? seatInfo(data, id) : null;
  return info ? ok(200, { seats: info }) : fail(400, 'Choose a company to see its seats.');
}

function createUser(data, actor, input) {
  const d = denyUnlessManager(actor); if (d) return d;
  const src = input && typeof input === 'object' ? input : {};
  const provided = typeof src.password === 'string' && src.password !== '';
  const password = provided ? src.password : Sec.randomPassword();
  const v = Auth.validateRegistration({ name: src.name, email: src.email, password });
  const errors = v.ok ? {} : Object.assign({}, v.errors);

  let role, tenantId = null;
  if (isSuper(actor)) {
    role = src.role === undefined ? 'employee' : src.role;
    if (!['admin', 'employee', 'individual'].includes(role)) errors.role = 'Choose Admin, Employee or Individual.';
    else if (COMPANY_ROLES.includes(role)) {
      tenantId = typeof src.tenant_id === 'string' ? src.tenant_id : null;
      if (!tenantId || !data.tenants.some(t => t.id === tenantId)) errors.tenant_id = 'Choose the company this account belongs to.';
    }
  } else { role = 'employee'; tenantId = actor.user.tenant_id; }
  if (Object.keys(errors).length) return fail(400, 'Check the highlighted fields and try again.', { errors });

  const { name, email } = v.value;
  if (data.users.some(u => u.email === email)) return fail(409, 'An account with this email already exists.', { errors: { email: 'This email is already used by another account.' } });

  if (tenantId && COMPANY_ROLES.includes(role)) {
    const info = seatInfo(data, tenantId);
    if (info.available <= 0) {
      const t = data.tenants.find(x => x.id === tenantId); const plan = data.plans.find(p => p.id === t.plan_id);
      return fail(409, `${t.name} has used all ${info.limit} seats on the ${plan ? plan.name : 'current'} plan. Buy extra seats ($${info.extra_seat_usd} each) or upgrade the plan in Billing, then add this account.`, { code: 'seat_limit', seats: info });
    }
  }
  const user = { id: Sec.newId('u'), tenant_id: tenantId, role, name, email, password_hash: Sec.hashPassword(password), status: 'active', prefs: { theme: 'light' }, created_at: iso(), created_by: actor.user.id };
  data.users.push(user);
  if (role === 'individual') {
    const free = data.plans.find(p => p.id === 'free');
    data.usage.push({ id: 'use_' + user.id, tenant_id: null, user_id: user.id, period: iso().slice(0, 7), credits_used: 0, credits_limit: free ? free.credits_per_month : 100 });
  }
  audit(data, actor, 'user.create', user.id, tenantId, { role });
  const out = { user: userRow(data, user), seats: tenantId ? seatInfo(data, tenantId) : null };
  if (!provided) out.temp_password = password;
  return ok(201, out);
}

/** Resolve the target and check that this actor may perform `op` on it. Returns {target} or a failure. */
function authorize(data, actor, id, op) {
  const d = denyUnlessManager(actor); if (d) return d;
  const target = findTarget(data, actor, id);
  if (!target) {
    if (data.users.some(u => u.id === id) && actor.user.tenant_id) audit(data, actor, 'security.cross_tenant_attempt', id, actor.user.tenant_id, { op });
    return fail(404, 'No such account.');
  }
  const self = target.id === actor.user.id;
  if ((op === 'freeze' || op === 'delete') && self) return fail(403, `You cannot ${op === 'freeze' ? 'freeze' : 'delete'} your own account.`);
  if (isSuper(actor)) {
    if ((op === 'freeze' || op === 'delete') && target.role === 'superadmin') return fail(403, 'Super admin accounts cannot be frozen or deleted here.');
    return { target };
  }
  if (target.role !== 'employee' && !(self && (op === 'update' || op === 'reset'))) return fail(403, 'Only the super admin can change another company admin.');
  return { target };
}

const SECRET_DENIED = () => fail(403, 'Change your own email or password from My account, which asks for your current password. (While signed in as someone else it is not possible at all.)');
function updateUser(data, actor, id, patch) {
  const a = authorize(data, actor, id, 'update'); if (!a.target) return a;
  const { target } = a; const src = patch && typeof patch === 'object' ? patch : {};
  if (target.id === actor.user.id && src.email !== undefined) return SECRET_DENIED();
  const errors = {}; const changes = {};
  if (src.name !== undefined) {
    const n = typeof src.name === 'string' ? src.name.trim() : '';
    if (!n || n.length > 80) errors.name = 'Enter a name (up to 80 characters).'; else changes.name = n;
  }
  if (src.email !== undefined) {
    const e = typeof src.email === 'string' ? src.email.trim().toLowerCase() : '';
    if (!Auth.validateEmail(e)) errors.email = 'Enter a valid email address, like name@company.com.';
    else if (data.users.some(u => u.email === e && u.id !== target.id)) return fail(409, 'That email is already used by another account.', { errors: { email: 'This email is already used by another account.' } });
    else changes.email = e;
  }
  if (src.role !== undefined) {
    if (!isSuper(actor)) return fail(403, 'Only the super admin can change roles.');
    if (!COMPANY_ROLES.includes(src.role) || !COMPANY_ROLES.includes(target.role)) errors.role = 'Roles can only be switched between Admin and Employee.'; else changes.role = src.role;
  }
  if (Object.keys(errors).length) return fail(400, 'Check the highlighted fields and try again.', { errors });
  if (!Object.keys(changes).length) return fail(400, 'Nothing to change. Send a name, email or role.');
  const meta = { fields: Object.keys(changes) };
  if (changes.email && changes.email !== target.email) { meta.email_from = target.email; meta.email_to = changes.email; revokeSessions(data, target.id); }
  Object.assign(target, changes);
  audit(data, actor, 'user.update', target.id, target.tenant_id, meta);
  return ok(200, { user: userRow(data, target) });
}

const revokeSessions = (data, userId) => { data.sessions = data.sessions.filter(s => s.user_id !== userId); };

function resetPassword(data, actor, id, body) {
  const a = authorize(data, actor, id, 'reset'); if (!a.target) return a;
  if (a.target.id === actor.user.id) return SECRET_DENIED();
  const src = body && typeof body === 'object' ? body : {};
  const provided = typeof src.password === 'string' && src.password !== '';
  if (provided) { const pe = Auth.validatePassword(src.password); if (pe) return fail(400, pe, { errors: { password: pe } }); }
  const password = provided ? src.password : Sec.randomPassword();
  a.target.password_hash = Sec.hashPassword(password);
  revokeSessions(data, a.target.id);
  audit(data, actor, 'user.reset_password', a.target.id, a.target.tenant_id, { generated: !provided });
  return ok(200, provided ? { user: userRow(data, a.target) } : { user: userRow(data, a.target), temp_password: password });
}

function setFrozen(data, actor, id, frozen, reason) {
  const a = authorize(data, actor, id, 'freeze'); if (!a.target) return a;
  a.target.status = frozen ? 'frozen' : 'active';
  if (frozen) revokeSessions(data, a.target.id);
  audit(data, actor, frozen ? 'user.freeze' : 'user.unfreeze', a.target.id, a.target.tenant_id, reason ? { reason: String(reason).slice(0, 200) } : {});
  return ok(200, { user: userRow(data, a.target) });
}

function removeFlows(data, ids) {
  if (!ids.length) return;
  const set = new Set(ids);
  const runIds = new Set(data.runs.filter(r => set.has(r.flow_id)).map(r => r.id));
  data.flows = data.flows.filter(f => !set.has(f.id));
  data.flowVersions = data.flowVersions.filter(v => !set.has(v.flow_id));
  data.runs = data.runs.filter(r => !set.has(r.flow_id));
  data.runSteps = data.runSteps.filter(s => !runIds.has(s.run_id));
}

function deleteUser(data, actor, id) {
  const a = authorize(data, actor, id, 'delete'); if (!a.target) return a;
  const t = a.target;
  if (t.tenant_id) {
    let heir = actor.user.tenant_id === t.tenant_id ? actor.user.id : null;
    const active = data.users.filter(u => u.tenant_id === t.tenant_id && u.status === 'active' && u.id !== t.id);
    if (!heir) { const adm = active.find(u => u.role === 'admin') || active[0]; heir = adm ? adm.id : null; }
    const owned = data.flows.filter(f => f.owner_id === t.id);
    if (!heir && owned.length) return fail(409, `${t.name} would be left with nobody to own ${owned.length} flow${owned.length === 1 ? '' : 's'}. Add or unfreeze another account first, or delete the whole company instead.`);
    owned.forEach(f => { f.owner_id = heir; });
  } else {
    removeFlows(data, data.flows.filter(f => f.owner_id === t.id && f.tenant_id == null).map(f => f.id));
    data.usage = data.usage.filter(u => u.user_id !== t.id);
  }
  revokeSessions(data, t.id);
  data.devices = data.devices.filter(d => d.user_id !== t.id);
  data.users = data.users.filter(u => u.id !== t.id);
  audit(data, actor, 'user.delete', t.id, t.tenant_id, { email: t.email });
  return ok(200, { deleted: t.id });
}

function listDevices(data, actor) {
  const d = denyUnlessManager(actor); if (d) return d;
  const byId = new Map(scopedUsers(data, actor).map(u => [u.id, u]));
  const devices = data.devices.filter(x => byId.has(x.user_id)).map(x => {
    const u = byId.get(x.user_id); const t = u.tenant_id ? data.tenants.find(z => z.id === u.tenant_id) : null;
    return Object.assign({}, x, { user_name: u.name, user_email: u.email, tenant_id: u.tenant_id, tenant_name: t ? t.name : null });
  }).sort((p, q) => (q.last_seen > p.last_seen ? 1 : -1));
  return ok(200, { devices });
}

function listLoginEvents(data, actor, query) {
  const d = denyUnlessManager(actor); if (d) return d;
  const q = query && typeof query === 'object' ? query : {};
  const limit = Math.min(500, Math.max(1, parseInt(q.limit, 10) || 100));
  const names = new Map(data.users.map(u => [u.id, u]));
  const events = data.loginEvents
    .filter(e => (isSuper(actor) || (actor.user.tenant_id && e.tenant_id === actor.user.tenant_id)) && (!q.user_id || e.user_id === q.user_id))
    .sort((p, r) => (r.at > p.at ? 1 : -1)).slice(0, limit)
    .map(e => Object.assign({}, e, { user_name: (names.get(e.user_id) || {}).name || 'Deleted user', user_email: (names.get(e.user_id) || {}).email || '' }));
  return ok(200, { events });
}

module.exports = { seatInfo, listUsers, seatsFor, createUser, updateUser, resetPassword, setFrozen, deleteUser, listDevices, listLoginEvents, userRow, audit };
