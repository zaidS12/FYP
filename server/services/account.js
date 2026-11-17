'use strict';
/* "My account": usage and credits, profile, password, own sign-in activity, and individual plan upgrade (Free <-> Plus). */
const Auth = require('../../assets/js/auth.js');
const Credits = require('../../assets/js/billing.js');
const Nodes = require('../../assets/js/nodes.js');
const CreditStore = require('./credits.js');
const Sec = require('../security.js');
const Audit = require('./audit.js');
const Billing = require('./billing.js');
const { FakeGateway } = require('../adapters/payment.js');

const ok = (status, extra) => Object.assign({ ok: true, status }, extra);
const fail = (status, error, extra) => Object.assign({ ok: false, status, error }, extra || {});
const iso = () => new Date().toISOString();
const ROLE_LABEL = { superadmin: 'Super Admin', admin: 'Company Admin', employee: 'Employee', individual: 'Individual' };
const defaultGateway = new FakeGateway();
const personalPlans = data => data.plans.filter(p => p.audience === 'individual');
const planOf = (data, user) => data.plans.find(p => p.id === (user.plan_id || 'free')) || data.plans.find(p => p.id === 'free');

const audit = (data, actor, action, target, meta) => Audit.record(data, actor, action, target, actor.user.tenant_id || null, meta);

function usageFor(data, actor) {
  const u = actor.user;
  if (u.role === 'superadmin') return Object.assign(Credits.creditStatus({ credits_used: 0, credits_limit: 0 }), { scope: 'platform', period: iso().slice(0, 7), plan_name: 'Platform', exhausted: false, low: false });
  const rec = CreditStore.usageRecord(data, u);   // creates a missing record and resets it in a new month
  if (u.tenant_id) {
    const t = data.tenants.find(x => x.id === u.tenant_id); const plan = data.plans.find(p => p.id === (t && t.plan_id));
    return Object.assign(Credits.creditStatus(rec), { scope: 'company', period: rec.period, plan_name: plan ? plan.name : '' });
  }
  return Object.assign(Credits.creditStatus(rec), { scope: 'personal', period: rec.period, plan_name: planOf(data, u).name });
}

function getUsage(data, actor) { return ok(200, { usage: usageFor(data, actor) }); }

function getAccount(data, actor) {
  const u = actor.user; const t = u.tenant_id ? data.tenants.find(x => x.id === u.tenant_id) : null;
  const plan = u.role === 'individual' ? planOf(data, u) : t ? data.plans.find(p => p.id === t.plan_id) : null;
  const mine = list => data[list].filter(x => x.user_id === u.id && x.tenant_id == null).sort((a, b) => ((b.issued_at || b.created_at) > (a.issued_at || a.created_at) ? 1 : -1));
  return ok(200, { account: {
    user: Object.assign(Auth.publicUser(u), { created_at: u.created_at }), company: t ? t.name : null, role_label: ROLE_LABEL[u.role] || u.role,
    plan: plan ? { id: plan.id, name: plan.name, price_usd: plan.price_usd, credits_per_month: plan.credits_per_month } : null,
    plans: u.role === 'individual' ? personalPlans(data).map(p => ({ id: p.id, name: p.name, price_usd: p.price_usd, credits_per_month: p.credits_per_month, current: p.id === planOf(data, u).id })) : [],
    usage: usageFor(data, actor), invoices: u.role === 'individual' ? mine('invoices') : [], payments: u.role === 'individual' ? mine('payments') : [],
  } });
}

function updateProfile(data, actor, input) {
  const name = input && typeof input.name === 'string' ? input.name.trim() : '';
  if (!name || name.length > 80) return fail(400, 'Enter your name (up to 80 characters).', { errors: { name: 'Enter your name (up to 80 characters).' } });
  if (actor.by) return fail(403, 'While you are signed in as someone else you cannot change their account details.');
  actor.user.name = name;
  audit(data, actor, 'user.update_profile', actor.user.id, { name });
  return ok(200, { user: Auth.publicUser(actor.user) });
}

function changePassword(data, actor, input, keepSessionId) {
  if (actor.by) return fail(403, 'While you are signed in as someone else you cannot change their password.');
  const src = input && typeof input === 'object' ? input : {};
  if (typeof src.current !== 'string' || !Sec.verifyPassword(src.current, actor.user.password_hash)) return fail(400, 'Your current password is not correct.', { errors: { current: 'That is not your current password.' } });
  const pe = Auth.validatePassword(src.next);
  if (pe) return fail(400, pe, { errors: { next: pe } });
  if (src.next === src.current) return fail(400, 'Choose a new password that is different from the current one.', { errors: { next: 'Choose a different password.' } });
  actor.user.password_hash = Sec.hashPassword(src.next);
  data.sessions = data.sessions.filter(s => s.user_id !== actor.user.id || s.id === keepSessionId);
  audit(data, actor, 'user.change_password', actor.user.id);
  return ok(200, { changed: true });
}

function myActivity(data, actor) {
  const devices = data.devices.filter(d => d.user_id === actor.user.id).sort((a, b) => (b.last_seen > a.last_seen ? 1 : -1));
  const events = data.loginEvents.filter(e => e.user_id === actor.user.id).sort((a, b) => (b.at > a.at ? 1 : -1)).slice(0, 20);
  // Support/admin "Login as" sessions are a separate entry type: they never appear as devices or sign-ins.
  const access = data.auditLog.filter(e => e.target === actor.user.id && /^impersonation\./.test(e.action)).slice(-20).reverse()
    .map(e => ({ at: e.at, action: e.action, by: e.actor_name, ip: e.meta && e.meta.ip, browser: e.meta && e.meta.browser }));
  return ok(200, { devices, events, access });
}

/** "My cards": the user's own versions of built-in cards, kept in their preferences. */
function saveCustomCards(data, actor, input) {
  if (!Auth.can(actor.user.role, 'flows.write')) return fail(403, 'Only people who build flows can save their own cards.');
  if (!input || !Array.isArray(input.cards)) return fail(400, 'Send the list of cards to save.');
  if (actor.by) return fail(403, 'While you are signed in as someone else you cannot change their saved cards.');
  const cards = Nodes.cleanCustomCards(input.cards);
  actor.user.prefs = Object.assign({}, actor.user.prefs, { customCards: cards });
  return ok(200, { cards });
}

function changePersonalPlan(data, actor, input, gateway = defaultGateway) {
  if (actor.user.role !== 'individual') return fail(403, 'Only individual accounts have a personal plan. Company plans are managed by the company admin.');
  const src = input && typeof input === 'object' ? input : {};
  const next = personalPlans(data).find(p => p.id === src.plan_id);
  if (!next) return fail(400, 'Choose Free or Plus.');
  const cur = planOf(data, actor.user);
  if (next.id === cur.id) return fail(400, `You are already on the ${cur.name} plan.`);
  let invoice = null;
  if (next.price_usd > cur.price_usd) {
    const amount = next.price_usd - cur.price_usd;
    const paid = Billing.takePayment(data, actor, null, amount, src.card, gateway, null, { user_id: actor.user.id });
    if (!paid.ok) return paid;
    invoice = Billing.issueInvoice(data, null, [{ description: `${next.name} plan, first month`, quantity: 1, unit_usd: amount }], amount, paid.payment, { user_id: actor.user.id });
  }
  actor.user.plan_id = next.id;
  let use = data.usage.find(x => x.user_id === actor.user.id);
  if (!use) { use = { id: 'use_' + actor.user.id, tenant_id: null, user_id: actor.user.id, period: iso().slice(0, 7), credits_used: 0, credits_limit: next.credits_per_month }; data.usage.push(use); }
  use.credits_limit = next.credits_per_month;
  audit(data, actor, 'billing.personal_plan_change', actor.user.id, { from: cur.id, to: next.id });
  return ok(200, { invoice, usage: usageFor(data, actor) });
}

module.exports = { getUsage, getAccount, updateProfile, changePassword, myActivity, changePersonalPlan, saveCustomCards, usageFor };
