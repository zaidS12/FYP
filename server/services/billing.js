'use strict';
/* Company billing for admins: view plan and invoices, buy extra seats, change plan, pay an open invoice.
 * Money moves only through the PaymentGateway adapter; card data is validated, charged, then dropped. */
const Pay = require('../../assets/js/adapters/payment.js');
const Sec = require('../security.js');
const Users = require('./users.js');
const Tenants = require('./tenants.js');
const { FakeGateway } = require('../adapters/payment.js');

const ok = (status, extra) => Object.assign({ ok: true, status }, extra);
const fail = (status, error, extra) => Object.assign({ ok: false, status, error }, extra || {});
const iso = () => new Date().toISOString();
const defaultGateway = new FakeGateway();
const DENIED = () => fail(403, 'Only the company admin can manage billing.');
const isAdmin = actor => actor.user.role === 'admin' && !!actor.user.tenant_id;
const paidPlans = data => data.plans.filter(p => p.audience === 'company');
const cents = n => Math.round(n * 100) / 100;
const FROZEN = () => fail(403, 'This company is frozen, so billing changes are paused. Contact AgentFlow support to restore access.');
const isFrozen = (data, actor) => { const t = data.tenants.find(x => x.id === actor.user.tenant_id); return !t || t.status === 'frozen'; };

function nextInvoiceNumber(data) {
  const max = data.invoices.reduce((m, i) => { const n = Number((String(i.number).match(/-(\d+)$/) || [])[1]); return n > m ? n : m; }, 0);
  return `INV-${new Date().getFullYear()}-${String(max + 1).padStart(4, '0')}`;
}

function getBilling(data, actor) {
  if (!isAdmin(actor)) return DENIED();
  const t = data.tenants.find(x => x.id === actor.user.tenant_id);
  if (!t) return fail(404, 'Company not found.');
  const row = Tenants.tenantRow(data, t);
  const plan = data.plans.find(p => p.id === t.plan_id);
  const sub = data.subscriptions.find(s => s.tenant_id === t.id);
  return ok(200, { billing: {
    tenant: { id: t.id, name: t.name, status: t.status }, plan, seats: row.seats, monthly_usd: row.monthly_usd, credits: row.credits,
    renews_at: sub ? sub.period_end : null,
    plans: paidPlans(data).map(p => ({ id: p.id, name: p.name, price_usd: p.price_usd, seats: p.seats, credits_per_month: p.credits_per_month, extra_seat_usd: p.extra_seat_usd, current: p.id === t.plan_id })),
    invoices: data.invoices.filter(i => i.tenant_id === t.id).sort((a, b) => (b.issued_at > a.issued_at ? 1 : -1)),
    payments: data.payments.filter(p => p.tenant_id === t.id).sort((a, b) => (b.created_at > a.created_at ? 1 : -1)),
  } });
}

/** Validate the card, charge it, and record the payment (success or failure). Returns {ok, payment, card} or a failure. */
function takePayment(data, actor, tenantId, amount, cardInput, gateway, invoiceId, extra) {
  const v = Pay.validateCard(cardInput);
  if (!v.ok) return fail(400, 'Check the card details and try again.', { errors: v.errors });
  const r = gateway.charge({ amount_usd: amount, card: v.card });
  const method = `${v.card.brand} •••• ${v.card.last4}`;
  const base = Object.assign({ id: Sec.newId('pay'), tenant_id: tenantId, invoice_id: invoiceId || null, amount_usd: amount, method, created_at: iso() }, extra || {});
  if (!r.ok) {
    data.payments.push(Object.assign(base, { status: 'failed', error: r.code }));
    Users.audit(data, actor, 'billing.payment_failed', tenantId || actor.user.id, tenantId, { amount, code: r.code });
    return fail(402, r.message, { code: r.code, persist: true });
  }
  const payment = Object.assign(base, { status: 'succeeded' });
  data.payments.push(payment);
  return { ok: true, payment };
}

function issueInvoice(data, tenantId, items, amount, payment, extra) {
  const now = iso();
  const invoice = Object.assign({ id: Sec.newId('inv'), tenant_id: tenantId, number: nextInvoiceNumber(data), items, amount_usd: amount, status: 'paid', issued_at: now, paid_at: now }, extra || {});
  data.invoices.push(invoice);
  payment.invoice_id = invoice.id;
  return invoice;
}

function buySeats(data, actor, input, gateway = defaultGateway) {
  if (!isAdmin(actor)) return DENIED();
  const src = input && typeof input === 'object' ? input : {};
  if (!Number.isInteger(src.count) || src.count < 1 || src.count > 1000) return fail(400, 'Choose how many extra seats to buy (1 to 1000).', { errors: { count: 'Enter a whole number from 1 to 1000.' } });
  if (isFrozen(data, actor)) return FROZEN();
  const t = data.tenants.find(x => x.id === actor.user.tenant_id);
  const plan = data.plans.find(p => p.id === t.plan_id);
  const amount = cents(src.count * plan.extra_seat_usd);
  const paid = takePayment(data, actor, t.id, amount, src.card, gateway, null);
  if (!paid.ok) return paid;
  const invoice = issueInvoice(data, t.id, [{ description: 'Extra seats', quantity: src.count, unit_usd: plan.extra_seat_usd }], amount, paid.payment);
  t.extra_seats = (t.extra_seats || 0) + src.count;
  const sub = data.subscriptions.find(s => s.tenant_id === t.id); if (sub) sub.extra_seats = t.extra_seats;
  Users.audit(data, actor, 'billing.seats_purchased', t.id, t.id, { count: src.count, amount });
  return ok(200, { invoice, seats: Users.seatInfo(data, t.id) });
}

function changePlan(data, actor, input, gateway = defaultGateway) {
  if (!isAdmin(actor)) return DENIED();
  const src = input && typeof input === 'object' ? input : {};
  if (isFrozen(data, actor)) return FROZEN();
  const t = data.tenants.find(x => x.id === actor.user.tenant_id);
  const next = paidPlans(data).find(p => p.id === src.plan_id);
  if (!next) return fail(400, 'Choose Basic or Pro. The Free plan is for individuals.', { errors: { plan_id: 'Choose Basic or Pro.' } });
  const cur = data.plans.find(p => p.id === t.plan_id);
  if (next.id === cur.id) return fail(400, `You are already on the ${cur.name} plan.`);
  const used = Users.seatInfo(data, t.id).used; const limit = next.seats + (t.extra_seats || 0);
  if (limit < used) return fail(409, `The ${next.name} plan has ${limit} seats but you have ${used} accounts. Delete or freeze accounts first, or buy extra seats.`, { code: 'seats_below_used' });
  let invoice = null;
  if (next.price_usd > cur.price_usd) {
    const diff = cents(next.price_usd - cur.price_usd);
    const paid = takePayment(data, actor, t.id, diff, src.card, gateway, null);
    if (!paid.ok) return paid;
    invoice = issueInvoice(data, t.id, [{ description: `Upgrade from ${cur.name} to ${next.name} (price difference)`, quantity: 1, unit_usd: diff }], diff, paid.payment);
  }
  t.plan_id = next.id;
  const sub = data.subscriptions.find(s => s.tenant_id === t.id); if (sub) sub.plan_id = next.id;
  const use = data.usage.find(u => u.tenant_id === t.id); if (use) use.credits_limit = next.credits_per_month;
  Users.audit(data, actor, 'billing.plan_change', t.id, t.id, { from: cur.id, to: next.id, charged: invoice ? invoice.amount_usd : 0 });
  return ok(200, { invoice, tenant: Tenants.tenantRow(data, t) });
}

function payInvoice(data, actor, invoiceId, input, gateway = defaultGateway) {
  if (!isAdmin(actor)) return DENIED();
  if (isFrozen(data, actor)) return FROZEN();
  const inv = data.invoices.find(i => i.id === invoiceId && i.tenant_id === actor.user.tenant_id);
  if (!inv) return fail(404, 'No such invoice.');
  if (inv.status === 'paid') return fail(409, 'This invoice is already paid.');
  const src = input && typeof input === 'object' ? input : {};
  const paid = takePayment(data, actor, inv.tenant_id, inv.amount_usd, src.card, gateway, inv.id);
  if (!paid.ok) return paid;
  inv.status = 'paid'; inv.paid_at = iso();
  Users.audit(data, actor, 'billing.invoice_paid', inv.id, inv.tenant_id, { number: inv.number, amount: inv.amount_usd });
  return ok(200, { invoice: inv });
}

module.exports = { getBilling, buySeats, changePlan, payInvoice, nextInvoiceNumber, takePayment, issueInvoice };
