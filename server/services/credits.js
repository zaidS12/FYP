'use strict';
/* Server-side credits: one usage record per company (shared by everyone in it) or per individual.
 * This is the single place that decides whether credits can be spent. Monthly reset happens when the record is read. */
const Shared = require('../../assets/js/billing.js');

const monthKey = (d = new Date()) => d.toISOString().slice(0, 7);

function planCredits(data, user) {
  if (user.tenant_id) { const t = data.tenants.find(x => x.id === user.tenant_id); const p = data.plans.find(x => x.id === (t && t.plan_id)); return p ? p.credits_per_month : 0; }
  const p = data.plans.find(x => x.id === (user.plan_id || 'free')); return p ? p.credits_per_month : 0;
}

/** The usage record that pays for this user's runs (null for super admins, who do not run flows). Creates and resets as needed. */
function usageRecord(data, user) {
  if (user.role === 'superadmin') return null;
  let rec = user.tenant_id ? data.usage.find(u => u.tenant_id === user.tenant_id) : data.usage.find(u => u.user_id === user.id && u.tenant_id == null);
  const period = monthKey();
  if (!rec) {
    rec = { id: 'use_' + (user.tenant_id || user.id), tenant_id: user.tenant_id || null, user_id: user.tenant_id ? null : user.id, period, credits_used: 0, credits_limit: planCredits(data, user) };
    data.usage.push(rec);
  } else if (rec.period !== period) { rec.period = period; rec.credits_used = 0; }
  return rec;
}

/** Spend credits if (and only if) the whole amount fits. A refused charge changes nothing. */
function tryCharge(data, user, amount) {
  const rec = usageRecord(data, user);
  if (!rec) return { ok: true, remaining: Infinity };
  if (!Shared.canAfford(rec, amount)) return { ok: false, remaining: Math.max(0, rec.credits_limit - rec.credits_used), limit: rec.credits_limit };
  rec.credits_used += amount;
  return { ok: true, remaining: rec.credits_limit - rec.credits_used };
}

function refund(data, user, amount) {
  const rec = usageRecord(data, user);
  if (rec) rec.credits_used = Math.max(0, rec.credits_used - amount);
}

module.exports = { monthKey, usageRecord, tryCharge, refund };
