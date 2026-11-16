'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createServer } = require('../../server.js');

const PW = 'AgentFlow#2026';
let srv, base;

test.before(async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'af server test '));
  srv = createServer({ dataDir, trustProxy: true, seedFile: path.join(__dirname, '..', '..', 'data', 'seed.json') });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  base = 'http://127.0.0.1:' + srv.address().port;
});
test.after(() => new Promise(r => srv.close(r)));

async function api(p, { method = 'GET', body, cookie, headers = {} } = {}) {
  const h = { ...headers };
  if (body !== undefined && !h['Content-Type']) h['Content-Type'] = 'application/json';
  if (cookie) h.Cookie = cookie;
  const res = await fetch(base + p, { method, headers: h, body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)) });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, json, text, headers: res.headers };
}
async function login(email, password = PW) {
  const r = await api('/api/auth/login', { method: 'POST', body: { email, password }, headers: { 'X-Forwarded-For': '10.0.0.' + Math.floor(Math.random() * 250) } });
  const raw = r.headers.get('set-cookie') || '';
  return { r, cookie: raw.split(';')[0] };
}

test('health is public', async () => {
  const r = await api('/api/health');
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true);
});

test('login sets an HttpOnly SameSite session cookie and returns a user without hash', async () => {
  const { r, cookie } = await login('ana@brightloom.test');
  assert.equal(r.status, 200);
  assert.match(r.headers.get('set-cookie'), /HttpOnly/);
  assert.match(r.headers.get('set-cookie'), /SameSite=Strict/);
  assert.equal(r.json.user.role, 'employee');
  assert.equal(JSON.stringify(r.json).includes('password_hash'), false);
  const me = await api('/api/auth/me', { cookie });
  assert.equal(me.json.user.email, 'ana@brightloom.test');
  assert.equal(me.json.tenant.name, 'Brightloom Studio');
});

test('wrong password is a generic 401; frozen company is a clear 403', async () => {
  const bad = await login('ana@brightloom.test', 'WrongPass9');
  assert.equal(bad.r.status, 401);
  const frozen = await login('admin@kestrel.test');
  assert.equal(frozen.r.status, 403);
  assert.match(frozen.r.json.error, /Kestrel Freight/);
});

test('unauthenticated requests are rejected', async () => {
  assert.equal((await api('/api/flows')).status, 401);
  assert.equal((await api('/api/auth/me')).status, 401);
});

test('TENANT ISOLATION: each role only receives its own scope from /api/flows', async () => {
  const emp = (await api('/api/flows', { cookie: (await login('ana@brightloom.test')).cookie })).json.flows;
  assert.ok(emp.length >= 2);
  assert.ok(emp.every(f => f.tenant_id === 't_brightloom'));
  const solo = (await api('/api/flows', { cookie: (await login('solo@example.test')).cookie })).json.flows;
  assert.ok(solo.every(f => f.tenant_id === null));
  const sup = (await api('/api/flows', { cookie: (await login('super@agentflow.test')).cookie })).json.flows;
  assert.ok(new Set(sup.map(f => f.tenant_id)).size >= 3);
});

test('client cannot choose its tenant or role through query or headers', async () => {
  const { cookie } = await login('ana@brightloom.test');
  const r = await api('/api/flows?tenant_id=t_kestrel&role=superadmin', { cookie, headers: { 'X-Tenant-Id': 't_kestrel', 'X-Role': 'superadmin' } });
  assert.ok(r.json.flows.every(f => f.tenant_id === 't_brightloom'));
});

test('login is rate limited per client and account', async () => {
  const hdr = { 'X-Forwarded-For': '203.0.113.77' };
  let last;
  for (let i = 0; i < 7; i++) last = await api('/api/auth/login', { method: 'POST', body: { email: 'ana@brightloom.test', password: 'Bad-pass1' + i }, headers: hdr });
  assert.equal(last.status, 429);
  assert.ok(last.headers.get('retry-after'));
});

test('password spraying cannot be reset by interleaving successful logins', async () => {
  const hdr = { 'X-Forwarded-For': '198.18.0.5' };
  const statuses = [];
  for (let i = 0; i < 30; i++) {
    statuses.push((await api('/api/auth/login', { method: 'POST', body: { email: `victim${i}@nowhere.test`, password: 'Guess-it-1' }, headers: hdr })).status);
    await api('/api/auth/login', { method: 'POST', body: { email: 'solo@example.test', password: PW }, headers: hdr });
  }
  assert.ok(statuses.includes(429), 'the per-IP failure budget must trip even with good logins in between');
});

test('JSON bodies that are not objects are rejected with 400, not a crash', async () => {
  for (const raw of ['null', '42', '"str"', '[1]']) {
    assert.equal((await api('/api/auth/login', { method: 'POST', body: raw })).status, 400, raw);
  }
  assert.equal((await api('/api/health')).status, 200);
});

test('PRIVATE flows are hidden from colleagues but visible to the owner and the company admin', async () => {
  const names = async email => (await api('/api/flows', { cookie: (await login(email)).cookie })).json.flows.map(f => f.name);
  assert.ok(!(await names('ana@brightloom.test')).includes('Translate announcement to Urdu'));
  assert.ok((await names('lina@brightloom.test')).includes('Translate announcement to Urdu'));
  assert.ok((await names('admin@brightloom.test')).includes('Translate announcement to Urdu'));
});

test('register creates an individual and signs them in; duplicate email is 409', async () => {
  const email = `t${Date.now()}@example.test`;
  const r = await api('/api/auth/register', { method: 'POST', body: { name: 'Temp User', email, password: 'Password1' } });
  assert.equal(r.status, 201);
  assert.equal(r.json.user.role, 'individual');
  assert.ok(r.headers.get('set-cookie'));
  const d = await api('/api/auth/register', { method: 'POST', body: { name: 'Temp User', email, password: 'Password1' } });
  assert.equal(d.status, 409);
  const v = await api('/api/auth/register', { method: 'POST', body: { name: '', email: 'bad', password: '1' } });
  assert.equal(v.status, 400);
});

test('prefs update persists theme; invalid theme rejected', async () => {
  const { cookie } = await login('ana@brightloom.test');
  assert.equal((await api('/api/auth/prefs', { method: 'PATCH', body: { theme: 'dark' }, cookie })).status, 200);
  assert.equal((await api('/api/auth/me', { cookie })).json.user.prefs.theme, 'dark');
  assert.equal((await api('/api/auth/prefs', { method: 'PATCH', body: { theme: 'neon' }, cookie })).status, 400);
});

test('logout invalidates the session server-side', async () => {
  const { cookie } = await login('ana@brightloom.test');
  assert.equal((await api('/api/auth/logout', { method: 'POST', body: {}, cookie })).status, 200);
  assert.equal((await api('/api/auth/me', { cookie })).status, 401);
});

test('POST without a JSON content type is refused (CSRF hardening)', async () => {
  const r = await api('/api/auth/login', { method: 'POST', body: 'email=a&password=b', headers: { 'Content-Type': 'text/plain' } });
  assert.equal(r.status, 415);
});

test('static server serves pages but never data, server code or traversal paths', async () => {
  assert.equal((await api('/')).status, 200);
  assert.match((await api('/')).headers.get('content-security-policy'), /default-src 'self'/);
  for (const p of ['/data/db.json', '/data/seed.json', '/server.js', '/server/security.js', '/package.json', '/..%2fserver.js', '/assets/..%2f..%2fserver.js', '/.git/config', '/tests/unit/auth.test.js']) {
    const r = await api(p);
    assert.equal(r.status, 404, p + ' should be 404 but was ' + r.status);
  }
});

test('malformed JSON body returns 400, not a crash', async () => {
  const r = await api('/api/auth/login', { method: 'POST', body: '{bad' });
  assert.equal(r.status, 400);
  assert.equal((await api('/api/health')).status, 200);
});
