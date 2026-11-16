'use strict';
/* Server-side security primitives: scrypt password hashing, session tokens, rate limiter, cookies. */
const crypto = require('node:crypto');

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('base64'), hash.toString('base64')].join('$');
}

function verifyPassword(password, stored) {
  try {
    if (typeof stored !== 'string') return false;
    const parts = stored.split('$');
    if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
    const [, N, r, p, saltB64, hashB64] = parts;
    const expected = Buffer.from(hashB64, 'base64');
    if (!expected.length) return false;
    const actual = crypto.scryptSync(String(password), Buffer.from(saltB64, 'base64'), expected.length, { N: +N, r: +r, p: +p });
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

const newToken = () => crypto.randomBytes(32).toString('base64url');
const hashToken = t => crypto.createHash('sha256').update(String(t)).digest('hex');
const newId = prefix => prefix + '_' + crypto.randomBytes(8).toString('hex');

class RateLimiter {
  constructor({ max, windowMs, now = Date.now }) {
    this.max = max; this.windowMs = windowMs; this.now = now; this.hits = new Map();
  }
  /** Read-only: would this key be blocked right now? Does not count as a hit. */
  check(key) {
    const t = this.now();
    const e = this.hits.get(key);
    if (!e || t >= e.resetAt || e.count < this.max) return { allowed: true, retryAfter: 0 };
    return { allowed: false, retryAfter: Math.max(1, Math.ceil((e.resetAt - t) / 1000)) };
  }
  _sweep(t) {
    if (this.hits.size <= 1000) return;
    for (const [k, e] of this.hits) if (t >= e.resetAt) this.hits.delete(k);
  }
  hit(key) {
    const t = this.now();
    this._sweep(t);
    let e = this.hits.get(key);
    if (!e || t >= e.resetAt) { e = { count: 0, resetAt: t + this.windowMs }; this.hits.set(key, e); }
    e.count += 1;
    if (e.count > this.max) return { allowed: false, retryAfter: Math.max(1, Math.ceil((e.resetAt - t) / 1000)) };
    return { allowed: true, retryAfter: 0 };
  }
  reset(key) { this.hits.delete(key); }
}

function parseCookies(header) {
  const out = {};
  if (typeof header !== 'string') return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (!k) continue;
    try { out[k] = decodeURIComponent(part.slice(i + 1).trim()); } catch { out[k] = part.slice(i + 1).trim(); }
  }
  return out;
}

function serializeCookie(name, value, { maxAgeSec, secure } = {}) {
  let c = `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Strict`;
  if (secure) c += '; Secure';
  if (maxAgeSec != null) c += `; Max-Age=${Math.max(0, Math.floor(maxAgeSec))}`;
  return c;
}

module.exports = { hashPassword, verifyPassword, newToken, hashToken, newId, RateLimiter, parseCookies, serializeCookie };
