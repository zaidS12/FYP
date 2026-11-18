'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const DB = require('../../assets/js/db.js');
const seed = require('../../assets/js/fallback-seed.js');

const PW = 'AgentFlow#2026';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

function memStorage() {
  const m = new Map();
  return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k) };
}
function backend() {
  return DB.createLocalBackend({ storage: memStorage(), seed: JSON.parse(JSON.stringify(seed)), subtle: globalThis.crypto.subtle, ua: UA });
}

test('local backend logs in a seeded employee and never exposes the hash', async () => {
  const b = backend();
  const r = await b.login({ email: 'ana@agentflow.com', password: PW });
  assert.equal(r.ok, true);
  assert.equal(r.user.role, 'employee');
  assert.equal('password_hash' in r.user, false);
  const me = await b.me();
  assert.equal(me.user.email, 'ana@agentflow.com');
});

test('wrong password and unknown email give the same generic error', async () => {
  const b = backend();
  const a = await b.login({ email: 'ana@agentflow.com', password: 'nope-nope1' });
  const c = await b.login({ email: 'ghost@nowhere.test', password: 'nope-nope1' });
  assert.equal(a.ok, false); assert.equal(c.ok, false);
  assert.equal(a.status, 401);
  assert.equal(a.error, c.error);
});

test('frozen company and frozen user are refused with a clear reason', async () => {
  const b = backend();
  const t = await b.login({ email: 'admin@kestrel.com', password: PW });
  assert.equal(t.status, 403);
  assert.match(t.error, /Kestrel Freight/);
  const u = await b.login({ email: 'dev.frozen@agentflow.com', password: PW });
  assert.equal(u.status, 403);
  assert.match(u.error, /frozen/i);
});

test('login records a device and a login event with parsed browser/os', async () => {
  const b = backend();
  await b.login({ email: 'ana@agentflow.com', password: PW });
  const snap = b._snapshot();
  const ev = snap.loginEvents[snap.loginEvents.length - 1];
  assert.equal(ev.success, true);
  assert.equal(ev.browser, 'Chrome 126');
  assert.equal(ev.os, 'Windows');
  assert.ok(snap.devices.some(d => d.user_id === ev.user_id && d.browser === 'Chrome 126'));
});

test('register creates a free individual, logs in, and rejects duplicates', async () => {
  const b = backend();
  const r = await b.register({ name: 'New Person', email: 'New.Person@Example.com', password: 'Password1' });
  assert.equal(r.ok, true);
  assert.equal(r.user.role, 'individual');
  assert.equal(r.user.tenant_id, null);
  assert.equal(r.user.email, 'new.person@example.com');
  const dup = await b.register({ name: 'Again', email: 'new.person@example.com', password: 'Password1' });
  assert.equal(dup.status, 409);
  const bad = await b.register({ name: '', email: 'x', password: '1' });
  assert.equal(bad.status, 400);
  assert.ok(bad.errors.email);
});

test('flows are tenant scoped: employee sees company flows, individual sees only own, others never', async () => {
  const b = backend();
  await b.login({ email: 'ana@agentflow.com', password: PW });
  const mine = (await b.listFlows()).flows;
  assert.ok(mine.length >= 2);
  assert.ok(mine.every(f => f.tenant_id === 't_brightloom'));
  assert.ok(!mine.some(f => f.name === 'Translate announcement to Urdu'), 'private flow of a colleague must be hidden');
  await b.logout();
  assert.equal((await b.listFlows()).status, 401);
  await b.login({ email: 'solo@example.com', password: PW });
  const solo = (await b.listFlows()).flows;
  assert.ok(solo.every(f => f.tenant_id === null));
  await b.logout();
  await b.login({ email: 'super@agentflow.com', password: PW });
  const all = (await b.listFlows()).flows;
  assert.ok(new Set(all.map(f => f.tenant_id)).size >= 3);
});

test('theme preference is saved per user and validated', async () => {
  const b = backend();
  await b.login({ email: 'ana@agentflow.com', password: PW });
  assert.equal((await b.setPrefs({ theme: 'dark' })).ok, true);
  assert.equal((await b.me()).user.prefs.theme, 'dark');
  assert.equal((await b.setPrefs({ theme: 'neon' })).status, 400);
});

test('logout clears the session', async () => {
  const b = backend();
  await b.login({ email: 'ana@agentflow.com', password: PW });
  await b.logout();
  assert.equal((await b.me()).ok, false);
});
