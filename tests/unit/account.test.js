'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const A = require('../../server/services/account.js');
const Sec = require('../../server/security.js');
const { FakeGateway } = require('../../server/adapters/payment.js');

const SEED = path.join(__dirname, '..', '..', 'data', 'seed.json');
const fresh = () => JSON.parse(fs.readFileSync(SEED, 'utf8'));
const actor = (data, id) => { const user = data.users.find(u => u.id === id); return { user, session: { user_id: user.id, tenant_id: user.tenant_id, role: user.role } }; };
const GOOD = { number: '4242 4242 4242 4242', exp: '12/99', cvc: '123', name: 'Sol Individual' };
const gw = new FakeGateway();

test('getUsage: company people share the company credits, individuals have their own', () => {
  const d = fresh();
  const co = A.getUsage(d, actor(d, 'u_bl_ana'));
  assert.equal(co.usage.scope, 'company'); assert.equal(co.usage.limit, 5000); assert.ok(co.usage.used > 1000); assert.equal(co.usage.plan_name, 'Basic');
  assert.equal(co.usage.percent, Math.round((co.usage.used / 5000) * 100));
  const solo = A.getUsage(d, actor(d, 'u_solo'));
  assert.deepEqual([solo.usage.scope, solo.usage.limit, solo.usage.plan_name], ['personal', 100, 'Free']);
  assert.equal(solo.usage.low, false);
  assert.equal(A.getUsage(d, actor(d, 'u_super')).usage.scope, 'platform');
  assert.equal(A.getUsage(d, actor(d, 'u_ke_sam')).usage.exhausted, false);
});

test('getAccount bundles profile, usage, and own invoices', () => {
  const d = fresh();
  const r = A.getAccount(d, actor(d, 'u_bl_ana'));
  assert.equal(r.ok, true);
  assert.deepEqual([r.account.user.email, r.account.company, r.account.role_label], ['ana@brightloom.test', 'Brightloom Studio', 'Employee']);
  assert.equal(JSON.stringify(r).includes('password_hash'), false);
  assert.equal(r.account.plans.length, 0, 'employees cannot upgrade');
  const solo = A.getAccount(d, actor(d, 'u_solo')).account;
  assert.deepEqual(solo.plans.map(p => p.id), ['free', 'plus']);
  assert.equal(solo.plan.id, 'free');
});

test('updateProfile changes the display name only', () => {
  const d = fresh(); const ana = actor(d, 'u_bl_ana');
  assert.equal(A.updateProfile(d, ana, { name: '  Ana T. ' }).user.name, 'Ana T.');
  assert.equal(A.updateProfile(d, ana, { name: '' }).status, 400);
  assert.equal(A.updateProfile(d, ana, { name: 'x'.repeat(81) }).status, 400);
  assert.equal(A.updateProfile(d, ana, { name: 'Ok', email: 'hacker@x.test', role: 'superadmin' }).ok, true);
  assert.equal(d.users.find(u => u.id === 'u_bl_ana').email, 'ana@brightloom.test');
  assert.equal(d.users.find(u => u.id === 'u_bl_ana').role, 'employee');
});

test('profile changes are audited, and an upgrade creates the usage record when it is missing', () => {
  const d = fresh();
  A.updateProfile(d, actor(d, 'u_bl_ana'), { name: 'Ana Torres-Lee' });
  assert.ok(d.auditLog.some(e => e.action === 'user.update_profile' && e.actor_id === 'u_bl_ana' && e.meta.name === 'Ana Torres-Lee'));
  d.usage = d.usage.filter(u => u.user_id !== 'u_solo');
  const r = A.changePersonalPlan(d, actor(d, 'u_solo'), { plan_id: 'plus', card: GOOD }, gw);
  assert.equal(r.ok, true);
  const rec = d.usage.find(u => u.user_id === 'u_solo');
  assert.deepEqual([rec.credits_limit, rec.credits_used, rec.tenant_id], [1000, 0, null]);
  assert.equal(r.usage.limit, 1000);
});

test('card settings drop prototype-polluting keys when custom cards are saved', () => {
  const d = fresh();
  const cards = JSON.parse('[{"id":"custom_p","label":"P","base":"summarize","config":{"__proto__":{"x":1},"style":"headline"}}]');
  const r = A.saveCustomCards(d, actor(d, 'u_bl_ana'), { cards });
  assert.equal(Object.prototype.hasOwnProperty.call(r.cards[0].config, '__proto__'), false);
  assert.equal(r.cards[0].config.style, 'headline');
});

test('changePassword needs the current password, signs out other devices, keeps this one', () => {
  const d = fresh(); const ana = actor(d, 'u_bl_ana');
  d.users.find(u => u.id === 'u_bl_ana').password_hash = Sec.hashPassword('Old#Pass123');
  d.sessions.push({ id: 'mine', user_id: 'u_bl_ana', expires_at: 'x' }, { id: 'other-device', user_id: 'u_bl_ana', expires_at: 'x' }, { id: 'someone-else', user_id: 'u_bl_omar', expires_at: 'x' });
  assert.equal(A.changePassword(d, ana, { current: 'wrong', next: 'New#Pass456' }, 'mine').status, 400);
  assert.equal(A.changePassword(d, ana, { current: 'Old#Pass123', next: 'short' }, 'mine').status, 400);
  assert.equal(A.changePassword(d, ana, { current: 'Old#Pass123', next: 'Old#Pass123' }, 'mine').status, 400);
  const r = A.changePassword(d, ana, { current: 'Old#Pass123', next: 'New#Pass456' }, 'mine');
  assert.equal(r.ok, true);
  assert.equal(Sec.verifyPassword('New#Pass456', d.users.find(u => u.id === 'u_bl_ana').password_hash), true);
  assert.deepEqual(d.sessions.map(s => s.id).sort(), ['mine', 'someone-else']);
  assert.ok(d.auditLog.some(e => e.action === 'user.change_password' && e.actor_id === 'u_bl_ana'));
});

test('custom cards are cleaned, capped and saved with the account of whoever can build flows', () => {
  const d = fresh(); const ana = actor(d, 'u_bl_ana');
  const r = A.saveCustomCards(d, ana, { cards: [{ id: 'custom_news', label: 'My news', base: 'search_web', config: { query: 'ai' } }, { id: 'bad id', label: 'x', base: 'search_web' }, { id: 'custom_x', label: 'x', base: 'nope' }] });
  assert.equal(r.ok, true); assert.deepEqual(r.cards.map(c => c.id), ['custom_news']);
  assert.deepEqual(d.users.find(u => u.id === 'u_bl_ana').prefs.customCards, r.cards);
  assert.equal(d.users.find(u => u.id === 'u_bl_ana').prefs.theme, 'light', 'other preferences are kept');
  assert.equal(A.saveCustomCards(d, ana, { cards: 'nope' }).status, 400);
  assert.equal(A.saveCustomCards(d, ana, {}).status, 400);
  assert.equal(A.saveCustomCards(d, actor(d, 'u_super'), { cards: [] }).status, 403);
  assert.equal(A.saveCustomCards(d, ana, { cards: [] }).ok, true);
  assert.deepEqual(d.users.find(u => u.id === 'u_bl_ana').prefs.customCards, []);
});

test('myActivity returns only the signed-in person devices and sign-ins', () => {
  const d = fresh();
  const r = A.myActivity(d, actor(d, 'u_bl_ana'));
  assert.ok(r.devices.length >= 2 && r.devices.every(x => x.user_id === 'u_bl_ana'));
  assert.ok(r.events.length >= 1 && r.events.every(x => x.user_id === 'u_bl_ana'));
});

test('individuals upgrade to Plus with a card, get more credits, and can go back to Free', () => {
  const d = fresh(); const solo = actor(d, 'u_solo');
  assert.equal(A.changePersonalPlan(d, solo, { plan_id: 'plus' }, gw).status, 400, 'a card is needed');
  assert.equal(A.changePersonalPlan(d, solo, { plan_id: 'free' }, gw).status, 400, 'already free');
  assert.equal(A.changePersonalPlan(d, solo, { plan_id: 'pro' }, gw).status, 400);
  const bad = A.changePersonalPlan(d, solo, { plan_id: 'plus', card: { ...GOOD, number: '4000000000000002' } }, gw);
  assert.equal(bad.status, 402); assert.equal(d.users.find(u => u.id === 'u_solo').plan_id || 'free', 'free');
  const r = A.changePersonalPlan(d, solo, { plan_id: 'plus', card: GOOD }, gw);
  assert.equal(r.ok, true); assert.equal(r.invoice.amount_usd, 12); assert.equal(r.invoice.user_id, 'u_solo'); assert.equal(r.invoice.tenant_id, null);
  assert.equal(d.users.find(u => u.id === 'u_solo').plan_id, 'plus');
  assert.equal(d.usage.find(u => u.user_id === 'u_solo').credits_limit, 1000);
  assert.ok(d.payments.some(p => p.user_id === 'u_solo' && p.status === 'succeeded' && p.method === 'Visa •••• 4242'));
  assert.equal(A.changePersonalPlan(d, solo, { plan_id: 'plus', card: GOOD }, gw).status, 400, 'already on Plus');
  const back = A.changePersonalPlan(d, solo, { plan_id: 'free' }, gw);
  assert.equal(back.ok, true);
  assert.equal(d.usage.find(u => u.user_id === 'u_solo').credits_limit, 100);
  assert.equal(A.changePersonalPlan(d, actor(d, 'u_bl_ana'), { plan_id: 'plus', card: GOOD }, gw).status, 403);
  assert.equal(A.changePersonalPlan(d, actor(d, 'u_bl_admin'), { plan_id: 'plus', card: GOOD }, gw).status, 403);
});
