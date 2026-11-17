'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const P = require('../../assets/js/adapters/payment.js');
const { FakeGateway } = require('../../server/adapters/payment.js');
const Bill = require('../../server/services/billing.js');
const Users = require('../../server/services/users.js');
const Tenants = require('../../server/services/tenants.js');

const SEED = path.join(__dirname, '..', '..', 'data', 'seed.json');
const fresh = () => JSON.parse(fs.readFileSync(SEED, 'utf8'));
const actor = (data, id) => { const user = data.users.find(u => u.id === id); return { user, session: { user_id: user.id, tenant_id: user.tenant_id, role: user.role } }; };
const GOOD = { number: '4242 4242 4242 4242', exp: '12/99', cvc: '123', name: 'Maya Hussain' };
const gw = new FakeGateway();

test('luhn and brand detection', () => {
  assert.equal(P.luhn('4242424242424242'), true);
  assert.equal(P.luhn('4242424242424241'), false);
  assert.equal(P.brandOf('4242424242424242'), 'Visa');
  assert.equal(P.brandOf('5555555555554444'), 'Mastercard');
  assert.equal(P.brandOf('378282246310005'), 'American Express');
});

test('validateCard explains every problem and normalises a good card', () => {
  const ok = P.validateCard(GOOD, new Date('2026-11-17'));
  assert.equal(ok.ok, true);
  assert.deepEqual([ok.card.last4, ok.card.brand, ok.card.exp_month, ok.card.exp_year], ['4242', 'Visa', 12, 2099]);
  const bad = P.validateCard({ number: '1234', exp: '13/20', cvc: '1', name: '' }, new Date('2026-11-17'));
  assert.equal(bad.ok, false);
  assert.deepEqual(Object.keys(bad.errors).sort(), ['cvc', 'exp', 'name', 'number']);
  assert.match(P.validateCard({ ...GOOD, exp: '01/20' }, new Date('2026-11-17')).errors.exp, /expired/i);
  assert.equal(P.validateCard({ number: '378282246310005', exp: '12/99', cvc: '1234', name: 'A B' }, new Date()).ok, true);
  assert.equal(P.validateCard({ ...GOOD, number: undefined }, new Date()).ok, false);
});

test('FakeGateway: test cards succeed, decline, or lack funds, and never see more than the last 4 digits afterwards', () => {
  const ok = gw.charge({ amount_usd: 10, card: GOOD, description: 'x' });
  assert.equal(ok.ok, true); assert.match(ok.id, /^ch_/); assert.equal(ok.last4, '4242');
  const declined = gw.charge({ amount_usd: 10, card: { ...GOOD, number: '4000 0000 0000 0002' } });
  assert.deepEqual([declined.ok, declined.code], [false, 'card_declined']);
  assert.match(declined.message, /declined/i);
  const poor = gw.charge({ amount_usd: 10, card: { ...GOOD, number: '4000 0000 0000 9995' } });
  assert.equal(poor.code, 'insufficient_funds');
  assert.equal(gw.charge({ amount_usd: 0, card: GOOD }).ok, false);
  assert.equal(gw.charge({ amount_usd: 10, card: { number: '123' } }).code, 'invalid_card');
});

test('getBilling shows plan, plan choices, seats, invoices and payments for the admin only', () => {
  const d = fresh();
  const r = Bill.getBilling(d, actor(d, 'u_bl_admin'));
  assert.equal(r.ok, true);
  assert.equal(r.billing.plan.id, 'basic'); assert.equal(r.billing.seats.used, 6);
  assert.deepEqual(r.billing.plans.map(p => p.id), ['basic', 'pro']);
  assert.equal(r.billing.invoices.length, 3); assert.equal(r.billing.payments.length, 3);
  assert.equal(r.billing.monthly_usd, 100); assert.equal(r.billing.credits.limit, 5000);
  for (const who of ['u_bl_ana', 'u_solo', 'u_super']) assert.equal(Bill.getBilling(d, actor(d, who)).status, 403, who);
});

test('buySeats charges per seat, raises the limit, issues a paid invoice and records the payment', () => {
  const d = fresh(); const a = actor(d, 'u_bl_admin');
  const r = Bill.buySeats(d, a, { count: 3, card: GOOD }, gw);
  assert.equal(r.ok, true);
  assert.equal(r.invoice.amount_usd, 24); assert.equal(r.invoice.status, 'paid'); assert.match(r.invoice.number, /^INV-\d{4}-0008$/);
  assert.equal(d.tenants.find(t => t.id === 't_brightloom').extra_seats, 3);
  assert.equal(d.subscriptions.find(s => s.tenant_id === 't_brightloom').extra_seats, 3);
  assert.equal(Users.seatInfo(d, 't_brightloom').limit, 13);
  const pay = d.payments.find(p => p.invoice_id === r.invoice.id);
  assert.equal(pay.status, 'succeeded'); assert.equal(pay.method, 'Visa •••• 4242'); assert.equal(pay.amount_usd, 24);
  assert.ok(d.auditLog.some(e => e.action === 'billing.seats_purchased' && e.tenant_id === 't_brightloom' && e.meta.count === 3));
  assert.equal(JSON.stringify(d).includes('4242 4242'), false, 'full card numbers are never stored');
  assert.equal(JSON.stringify(d).includes('"cvc"'), false);
});

test('buySeats validates the count and the card, and a declined card changes nothing but is recorded', () => {
  const d = fresh(); const a = actor(d, 'u_bl_admin'); const before = d.tenants[0].extra_seats;
  for (const count of [0, -1, 1.5, 1001, '3', undefined]) assert.equal(Bill.buySeats(d, a, { count, card: GOOD }, gw).status, 400, String(count));
  const badCard = Bill.buySeats(d, a, { count: 1, card: { ...GOOD, number: '1111' } }, gw);
  assert.equal(badCard.status, 400); assert.ok(badCard.errors.number);
  const declined = Bill.buySeats(d, a, { count: 2, card: { ...GOOD, number: '4000000000000002' } }, gw);
  assert.equal(declined.status, 402); assert.match(declined.error, /declined/i);
  assert.equal(d.tenants[0].extra_seats, before);
  assert.ok(d.payments.some(p => p.status === 'failed' && p.tenant_id === 't_brightloom' && p.invoice_id === null));
  assert.equal(d.invoices.filter(i => i.tenant_id === 't_brightloom').length, 3, 'no invoice for a failed charge');
  assert.equal(Bill.buySeats(d, actor(d, 'u_bl_ana'), { count: 1, card: GOOD }, gw).status, 403);
});

test('changePlan: upgrade charges the difference, downgrade is free but must fit the accounts, bad requests are refused', () => {
  const d = fresh(); const a = actor(d, 'u_bl_admin');
  assert.equal(Bill.changePlan(d, a, { plan_id: 'pro' }, gw).status, 400, 'upgrade needs a card');
  assert.equal(Bill.changePlan(d, a, { plan_id: 'basic', card: GOOD }, gw).status, 400, 'same plan');
  assert.equal(Bill.changePlan(d, a, { plan_id: 'free', card: GOOD }, gw).status, 400);
  const up = Bill.changePlan(d, a, { plan_id: 'pro', card: GOOD }, gw);
  assert.equal(up.ok, true); assert.equal(up.invoice.amount_usd, 150);
  assert.equal(d.tenants.find(t => t.id === 't_brightloom').plan_id, 'pro');
  assert.equal(d.usage.find(u => u.tenant_id === 't_brightloom').credits_limit, 20000);
  assert.ok(d.auditLog.some(e => e.action === 'billing.plan_change' && e.meta.to === 'pro'));
  const down = Bill.changePlan(d, a, { plan_id: 'basic' }, gw);
  assert.equal(down.ok, true); assert.equal(down.invoice, null);
  assert.equal(d.tenants.find(t => t.id === 't_brightloom').plan_id, 'basic');
  for (let i = 0; i < 5; i++) d.users.push({ id: 'z' + i, tenant_id: 't_brightloom', role: 'employee', email: `z${i}@b.test`, name: 'z', status: 'active' });
  Bill.changePlan(d, a, { plan_id: 'pro', card: GOOD }, gw);
  const blocked = Bill.changePlan(d, a, { plan_id: 'basic' }, gw);
  assert.equal(blocked.status, 409); assert.match(blocked.error, /seats/);
  assert.equal(Bill.changePlan(d, actor(d, 'u_bl_ana'), { plan_id: 'pro', card: GOOD }, gw).status, 403);
});

test('payInvoice settles an overdue invoice; only your own, only once, only with a working card', () => {
  const d = fresh(); const a = actor(d, 'u_bl_admin');
  d.invoices.push({ id: 'inv_open', tenant_id: 't_brightloom', number: 'INV-2026-0099', items: [{ description: 'Basic plan', quantity: 1, unit_usd: 100 }], amount_usd: 100, status: 'overdue', issued_at: new Date().toISOString(), paid_at: null });
  assert.equal(Bill.payInvoice(d, a, 'inv_open', { card: { ...GOOD, number: '4000000000000002' } }, gw).status, 402);
  assert.equal(d.invoices.find(i => i.id === 'inv_open').status, 'overdue');
  const ok = Bill.payInvoice(d, a, 'inv_open', { card: GOOD }, gw);
  assert.equal(ok.ok, true);
  assert.equal(d.invoices.find(i => i.id === 'inv_open').status, 'paid');
  assert.ok(d.invoices.find(i => i.id === 'inv_open').paid_at);
  assert.equal(Bill.payInvoice(d, a, 'inv_open', { card: GOOD }, gw).status, 409);
  assert.equal(Bill.payInvoice(d, a, 'inv_t_kestrel_7', { card: GOOD }, gw).status, 404, 'another company invoice looks missing');
  assert.equal(Bill.payInvoice(d, a, 'inv_open', { card: undefined }, gw).status, 409);
  assert.equal(Bill.payInvoice(d, actor(d, 'u_bl_ana'), 'inv_open', { card: GOOD }, gw).status, 403);
});

test('companyStats gives a company admin their own numbers and nobody else', () => {
  const d = fresh();
  const r = Tenants.companyStats(d, actor(d, 'u_bl_admin'));
  assert.equal(r.ok, true);
  const s = r.stats;
  assert.equal(s.users.total, 6); assert.equal(s.users.frozen, 1);
  assert.equal(s.flows.total, 3); assert.ok(s.runs.total >= 5 && s.runs.failed >= 1);
  assert.equal(s.seats.limit, 10); assert.equal(s.credits.limit, 5000);
  assert.equal(s.logins_7d.by_day.length, 7);
  assert.ok(s.devices.total > 0);
  for (const who of ['u_bl_ana', 'u_solo', 'u_super']) assert.equal(Tenants.companyStats(d, actor(d, who)).status, 403, who);
});
