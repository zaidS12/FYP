'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('../../server/security.js');

test('scrypt hash verifies the right password and rejects the wrong one', () => {
  const h = S.hashPassword('Correct#Horse1');
  assert.match(h, /^scrypt\$/);
  assert.equal(S.verifyPassword('Correct#Horse1', h), true);
  assert.equal(S.verifyPassword('wrong', h), false);
  assert.notEqual(S.hashPassword('Correct#Horse1'), h, 'salt must differ');
});

test('verifyPassword fails safely on malformed or foreign hashes', () => {
  assert.equal(S.verifyPassword('x', ''), false);
  assert.equal(S.verifyPassword('x', 'plaintext'), false);
  assert.equal(S.verifyPassword('x', 'scrypt$bad'), false);
  assert.equal(S.verifyPassword('x', undefined), false);
});

test('tokens are random, long, and stored only as a sha-256 hash', () => {
  const a = S.newToken(), b = S.newToken();
  assert.notEqual(a, b);
  assert.ok(a.length >= 40);
  assert.match(S.hashToken(a), /^[0-9a-f]{64}$/);
  assert.notEqual(S.hashToken(a), a);
});

test('RateLimiter blocks after max hits and recovers after the window', () => {
  let now = 1000;
  const rl = new S.RateLimiter({ max: 3, windowMs: 60000, now: () => now });
  assert.equal(rl.hit('k').allowed, true);
  assert.equal(rl.hit('k').allowed, true);
  assert.equal(rl.hit('k').allowed, true);
  const blocked = rl.hit('k');
  assert.equal(blocked.allowed, false);
  assert.ok(blocked.retryAfter > 0 && blocked.retryAfter <= 60);
  assert.equal(rl.hit('other').allowed, true, 'keys are independent');
  now += 61000;
  assert.equal(rl.hit('k').allowed, true);
});

test('RateLimiter.check blocks without counting, and expired entries are swept', () => {
  let now = 0;
  const rl = new S.RateLimiter({ max: 2, windowMs: 1000, now: () => now });
  assert.equal(rl.check('a').allowed, true);
  rl.hit('a'); rl.hit('a');
  assert.equal(rl.check('a').allowed, false, 'blocked once max hits are recorded');
  assert.equal(rl.check('a').allowed, false, 'check never increments');
  for (let i = 0; i < 1500; i++) rl.hit('k' + i);
  now += 5000;
  rl.hit('fresh');
  assert.ok(rl.hits.size < 50, 'expired entries are evicted, got ' + rl.hits.size);
});

test('serializeCookie adds Secure when asked', () => {
  assert.match(S.serializeCookie('a', 'b', { secure: true }), /; Secure/);
  assert.doesNotMatch(S.serializeCookie('a', 'b', {}), /Secure/);
});

test('cookies parse and serialize with safe attributes', () => {
  assert.deepEqual(S.parseCookies('a=1; af_session=tok%20en; b=2'), { a: '1', af_session: 'tok en', b: '2' });
  assert.deepEqual(S.parseCookies(undefined), {});
  const c = S.serializeCookie('af_session', 'abc', { maxAgeSec: 60 });
  assert.match(c, /HttpOnly/);
  assert.match(c, /SameSite=Strict/);
  assert.match(c, /Path=\//);
  assert.match(c, /Max-Age=60/);
});
