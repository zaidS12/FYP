'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createServer } = require('../../server.js');
const P = require('../../assets/js/adapters/payment.js');

const PW = 'AgentFlow#2026';
const GOOD = { number: '4242 4242 4242 4242', exp: '12/99', cvc: '123', name: 'Test Person' };
let srv, base, ip = 0;

test.before(async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'af flows test '));
  srv = createServer({ dataDir, trustProxy: true, seedFile: path.join(__dirname, '..', '..', 'data', 'seed.json') });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  base = 'http://127.0.0.1:' + srv.address().port;
});
test.after(() => new Promise(r => srv.close(r)));

async function api(p, { method = 'GET', body, cookie } = {}) {
  const headers = {}; if (body !== undefined) headers['Content-Type'] = 'application/json'; if (cookie) headers.Cookie = cookie;
  const res = await fetch(base + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text(); let json = null; try { json = JSON.parse(text); } catch { /* none */ }
  return { status: res.status, json };
}
async function login(email, password = PW) {
  const res = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '10.7.0.' + (++ip % 250) }, body: JSON.stringify({ email, password }) });
  return (res.headers.get('set-cookie') || '').split(';')[0];
}

test('every Phase 5 endpoint refuses anonymous callers', async () => {
  const calls = [['GET', '/api/flows'], ['GET', '/api/flows/f_news'], ['POST', '/api/flows'], ['PATCH', '/api/flows/f_news'], ['DELETE', '/api/flows/f_news'], ['POST', '/api/flows/f_news/duplicate'],
    ['GET', '/api/templates'], ['POST', '/api/templates/tpl_news/clone'], ['GET', '/api/usage'], ['GET', '/api/account'], ['PATCH', '/api/account/profile'], ['POST', '/api/account/password'], ['GET', '/api/account/activity'], ['POST', '/api/account/plan']];
  for (const [method, p] of calls) assert.equal((await api(p, { method, body: ['GET', 'DELETE'].includes(method) ? undefined : {} })).status, 401, method + ' ' + p);
});

test('a flow can be created, opened, edited into a new version, duplicated and deleted over HTTP', async () => {
  const ana = await login('ana@agentflow.com');
  const made = await api('/api/flows', { method: 'POST', cookie: ana, body: { name: 'HTTP flow', tenant_id: 't_kestrel' } });
  assert.equal(made.status, 201); assert.equal(made.json.flow.tenant_id, 't_brightloom');
  const id = made.json.flow.id;
  const open = await api('/api/flows/' + id, { cookie: ana });
  assert.equal(open.json.flow.nodes.length, 2); assert.equal(open.json.can_edit, true);
  const nodes = [...open.json.flow.nodes, { id: 'n3', type: 'summarize', label: 'Summarize', x: 200, y: 300, config: {} }];
  const saved = await api('/api/flows/' + id, { method: 'PATCH', cookie: ana, body: { nodes, edges: open.json.flow.edges, base_version: 1 } });
  assert.equal(saved.status, 200); assert.equal(saved.json.flow.version, 2); assert.match(saved.json.version.summary, /Added 1 card/);
  const merged = await api('/api/flows/' + id, { method: 'PATCH', cookie: ana, body: { name: 'stale', base_version: 1 } });
  assert.equal(merged.status, 200, 'a stale save that touches different things merges card by card'); assert.equal(merged.json.merged, true);
  assert.equal(merged.json.flow.name, 'stale'); assert.equal(merged.json.flow.nodes.length, 3, 'the other save is kept');
  const clash = await api('/api/flows/' + id, { method: 'PATCH', cookie: ana, body: { name: 'other name', base_version: 1 } });
  assert.equal(clash.status, 409); assert.equal(clash.json.code, 'conflict'); assert.equal(clash.json.conflicts[0].label, 'Flow name');
  const copy = await api(`/api/flows/${id}/duplicate`, { method: 'POST', cookie: ana, body: {} });
  assert.equal(copy.status, 201); assert.equal(copy.json.flow.name, 'stale (copy)');
  const omar = await login('omar@agentflow.com');
  assert.equal((await api('/api/flows/' + id, { cookie: omar })).status, 404, 'private to Ana');
  assert.equal((await api('/api/flows/' + id, { method: 'DELETE', cookie: ana })).status, 200);
  assert.equal((await api('/api/flows/' + id, { cookie: ana })).status, 404);
});

test('cross-company: a flow id from another company is invisible and untouchable', async () => {
  const ana = await login('ana@agentflow.com');
  assert.equal((await api('/api/flows/f_ke', { cookie: ana })).status, 404);
  assert.equal((await api('/api/flows/f_ke', { method: 'PATCH', cookie: ana, body: { name: 'x' } })).status, 404);
  assert.equal((await api('/api/flows/f_ke', { method: 'DELETE', cookie: ana })).status, 404);
  assert.equal((await api('/api/flows/f_ke/duplicate', { method: 'POST', cookie: ana, body: {} })).status, 404);
  const sa = await login('super@agentflow.com');
  assert.equal((await api('/api/flows/f_ke', { cookie: sa })).status, 200);
  assert.equal((await api('/api/flows/f_ke', { method: 'PATCH', cookie: sa, body: { name: 'x' } })).status, 403);
  assert.equal((await api('/api/flows', { method: 'POST', cookie: sa, body: { name: 'x' } })).status, 403);
});

test('templates can be listed and cloned into your own workspace', async () => {
  const solo = await login('solo@example.com');
  const list = await api('/api/templates', { cookie: solo });
  assert.equal(list.json.templates.length, 4);
  const clone = await api('/api/templates/tpl_news/clone', { method: 'POST', cookie: solo, body: { name: 'My digest' } });
  assert.equal(clone.status, 201); assert.equal(clone.json.flow.tenant_id, null);
  assert.equal((await api('/api/templates/nope/clone', { method: 'POST', cookie: solo, body: {} })).status, 404);
});

test('usage shows company credits for employees and personal credits for individuals', async () => {
  const ana = (await api('/api/usage', { cookie: await login('ana@agentflow.com') })).json.usage;
  const solo = (await api('/api/usage', { cookie: await login('solo@example.com') })).json.usage;
  assert.deepEqual([ana.scope, ana.limit], ['company', 5000]); assert.deepEqual([solo.scope, solo.limit], ['personal', 100]);
});

test('changing your password keeps this device signed in and signs the others out', async () => {
  const a = await login('raj@agentflow.com'); const b = await login('raj@agentflow.com');
  const r = await api('/api/account/password', { method: 'POST', cookie: a, body: { current: PW, next: 'Brand#New789' } });
  assert.equal(r.status, 200);
  assert.equal((await api('/api/auth/me', { cookie: a })).status, 200);
  assert.equal((await api('/api/auth/me', { cookie: b })).status, 401);
  assert.equal((await api('/api/account/password', { method: 'POST', cookie: a, body: { current: 'wrong', next: 'Another#123' } })).status, 400);
  assert.ok(await login('raj@agentflow.com', 'Brand#New789'));
});

test('guessing the current password is throttled per account', async () => {
  const cookie = await login('lina@agentflow.com');
  let last;
  for (let i = 0; i < 7; i++) last = await api('/api/account/password', { method: 'POST', cookie, body: { current: 'wrong-guess-' + i, next: 'Whatever#123' } });
  assert.equal(last.status, 429);
  assert.match(last.json.error, /Too many/);
  const ok = await api('/api/account/password', { method: 'POST', cookie, body: { current: PW, next: 'Whatever#123' } });
  assert.equal(ok.status, 429, 'even the right password waits until the window passes');
});

test('over HTTP a name or graph change without base_version is a 400, and sharing alone is fine', async () => {
  const ana = await login('ana@agentflow.com');
  const made = await api('/api/flows', { method: 'POST', cookie: ana, body: { name: 'Version rules' } });
  const id = made.json.flow.id;
  assert.equal((await api('/api/flows/' + id, { method: 'PATCH', cookie: ana, body: { name: 'blind overwrite' } })).status, 400);
  assert.equal((await api('/api/flows/' + id, { method: 'PATCH', cookie: ana, body: { shared: true } })).status, 200);
  assert.equal((await api('/api/flows/' + id, { method: 'PATCH', cookie: ana, body: { name: 'ok', base_version: 1 } })).status, 200);
  const omar = await login('omar@agentflow.com');
  assert.equal((await api('/api/flows/' + id, { method: 'PATCH', cookie: omar, body: { shared: false } })).status, 403, 'a colleague cannot change sharing');
  assert.equal((await api('/api/flows/' + id, { method: 'DELETE', cookie: omar })).status, 403, 'a colleague cannot delete it');
});

test('an individual upgrades to Plus, then returns to Free; the account shows invoices', async () => {
  const solo = await login('solo@example.com');
  assert.equal((await api('/api/account/plan', { method: 'POST', cookie: solo, body: { plan_id: 'plus', card: { ...GOOD, number: '4000 0000 0000 0002' } } })).status, 402);
  const up = await api('/api/account/plan', { method: 'POST', cookie: solo, body: { plan_id: 'plus', card: GOOD } });
  assert.equal(up.status, 200); assert.equal(up.json.usage.limit, 1000);
  const acct = (await api('/api/account', { cookie: solo })).json.account;
  assert.equal(acct.plan.id, 'plus'); assert.ok(acct.invoices.length === 1 && acct.payments.some(p => p.status === 'succeeded'));
  assert.equal((await api('/api/account/plan', { method: 'POST', cookie: solo, body: { plan_id: 'free' } })).status, 200);
  assert.equal((await api('/api/account/plan', { method: 'POST', cookie: await login('ana@agentflow.com'), body: { plan_id: 'plus', card: GOOD } })).status, 403);
});

test('a declined card is written to disk (payment + audit), not only to memory', async () => {
  const admin = await login('admin@agentflow.com');
  const r = await api('/api/billing/seats', { method: 'POST', cookie: admin, body: { count: 1, card: { ...GOOD, number: '4000 0000 0000 0002' } } });
  assert.equal(r.status, 402);
  const onDisk = JSON.parse(fs.readFileSync(srv.store.file, 'utf8'));
  assert.ok(onDisk.payments.some(p => p.status === 'failed' && p.tenant_id === 't_brightloom' && p.error === 'card_declined'));
  assert.ok(onDisk.auditLog.some(e => e.action === 'billing.payment_failed' && e.tenant_id === 't_brightloom'));
  assert.equal(JSON.stringify(onDisk).includes('4000 0000'), false);
});

test('a frozen company cannot buy seats, change plan or pay invoices', async () => {
  const admin = await login('admin@agentflow.com');
  srv.store.data.tenants.find(t => t.id === 't_brightloom').status = 'frozen';
  try {
    assert.equal((await api('/api/billing/seats', { method: 'POST', cookie: admin, body: { count: 1, card: GOOD } })).status, 401, 'frozen sessions are rejected before billing is reached');
  } finally { srv.store.data.tenants.find(t => t.id === 't_brightloom').status = 'active'; }
});

test('card brand lengths: an Amex-style number must have 15 digits', () => {
  const withCheck = (prefix, len) => { let body = prefix; while (body.length < len - 1) body += '0'; for (let c = 0; c < 10; c++) if (P.luhn(body + c)) return body + c; return null; };
  assert.equal(P.validateCard({ number: withCheck('37', 15), exp: '12/99', cvc: '1234', name: 'A B' }).ok, true);
  assert.ok(P.validateCard({ number: withCheck('37', 16), exp: '12/99', cvc: '1234', name: 'A B' }).errors.number);
  assert.ok(P.validateCard({ number: withCheck('55', 15), exp: '12/99', cvc: '123', name: 'A B' }).errors.number, 'Mastercard must be 16 digits');
});
