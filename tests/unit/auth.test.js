'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const A = require('../../assets/js/auth.js');

test('parseUserAgent identifies browser, os and device', () => {
  const chromeWin = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
  const edge = chromeWin + ' Edg/126.0.0.0';
  const firefoxLinux = 'Mozilla/5.0 (X11; Linux x86_64; rv:127.0) Gecko/20100101 Firefox/127.0';
  const safariIphone = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
  assert.deepEqual(A.parseUserAgent(chromeWin), { browser: 'Chrome 126', os: 'Windows', device: 'Desktop' });
  assert.equal(A.parseUserAgent(edge).browser, 'Edge 126');
  assert.deepEqual(A.parseUserAgent(firefoxLinux), { browser: 'Firefox 127', os: 'Linux', device: 'Desktop' });
  assert.deepEqual(A.parseUserAgent(safariIphone), { browser: 'Safari 17', os: 'iOS', device: 'Mobile' });
  assert.deepEqual(A.parseUserAgent(''), { browser: 'Unknown', os: 'Unknown', device: 'Unknown' });
  assert.equal(A.parseUserAgent(undefined).browser, 'Unknown');
});

test('validateEmail', () => {
  assert.equal(A.validateEmail('a@b.co'), true);
  assert.equal(A.validateEmail('not-an-email'), false);
  assert.equal(A.validateEmail('a@b'), false);
  assert.equal(A.validateEmail('x'.repeat(250) + '@b.co'), false);
  assert.equal(A.validateEmail(42), false);
});

test('validatePassword needs 8+ chars with a letter and a digit', () => {
  assert.equal(A.validatePassword('abc12345'), null);
  assert.match(A.validatePassword('short1'), /at least 8/);
  assert.match(A.validatePassword('onlyletters'), /letter and a number/);
  assert.match(A.validatePassword('12345678'), /letter and a number/);
  assert.match(A.validatePassword('a1'.repeat(100)), /too long/);
  assert.ok(A.validatePassword(undefined));
});

test('validateRegistration trims, lowercases email and reports every field error', () => {
  const ok = A.validateRegistration({ name: '  Sana Ali ', email: ' Sana@Example.COM ', password: 'goodpass1' });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.value, { name: 'Sana Ali', email: 'sana@example.com', password: 'goodpass1' });
  const bad = A.validateRegistration({ name: '', email: 'nope', password: 'x' });
  assert.equal(bad.ok, false);
  assert.deepEqual(Object.keys(bad.errors).sort(), ['email', 'name', 'password']);
});

test('checkLoginEligibility blocks frozen users and frozen companies with a clear message', () => {
  assert.equal(A.checkLoginEligibility({ status: 'active' }, null), null);
  assert.equal(A.checkLoginEligibility({ status: 'active' }, { status: 'active' }), null);
  const u = A.checkLoginEligibility({ status: 'frozen' }, null);
  assert.equal(u.code, 'user_frozen');
  assert.match(u.message, /frozen/i);
  const t = A.checkLoginEligibility({ status: 'active' }, { name: 'Kestrel Freight', status: 'frozen' });
  assert.equal(t.code, 'tenant_frozen');
  assert.match(t.message, /Kestrel Freight/);
});

test('can() encodes the role permission matrix', () => {
  assert.equal(A.can('superadmin', 'tenants.manage'), true);
  assert.equal(A.can('admin', 'tenants.manage'), false);
  assert.equal(A.can('admin', 'users.manage'), true);
  assert.equal(A.can('employee', 'users.manage'), false);
  assert.equal(A.can('employee', 'flows.write'), true);
  assert.equal(A.can('individual', 'flows.write'), true);
  assert.equal(A.can('superadmin', 'flows.write'), false);
  assert.equal(A.can('ghost', 'flows.write'), false);
});

test('publicUser never leaks the password hash', () => {
  const p = A.publicUser({ id: 'u1', name: 'A', email: 'a@b.co', role: 'admin', tenant_id: 't1', password_hash: 'secret', status: 'active', prefs: { theme: 'dark' } });
  assert.equal('password_hash' in p, false);
  assert.equal(p.prefs.theme, 'dark');
});

test('homeFor falls back to a built page', () => {
  assert.equal(A.homeFor('employee', ['app/flows.html']), 'app/flows.html');
  assert.equal(A.homeFor('superadmin', ['app/flows.html']), 'app/flows.html');
  assert.equal(A.homeFor('superadmin', ['super/dashboard.html', 'app/flows.html']), 'super/dashboard.html');
});
