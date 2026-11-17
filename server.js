'use strict';
/* AgentFlow server. Zero dependencies. Serves the HTML pages and a small JSON REST API over data/db.json.
 * Start with: node server.js   (http://localhost:3000)
 * Role and tenant ALWAYS come from the server-side session, never from the request. */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const Auth = require('./assets/js/auth.js');
const Ten = require('./assets/js/tenancy.js');
const Sec = require('./server/security.js');
const { Store } = require('./server/store.js');
const Users = require('./server/services/users.js');
const Tenants = require('./server/services/tenants.js');
const Ledger = require('./server/services/ledger.js');
const Backup = require('./server/services/backup.js');
const Billing = require('./server/services/billing.js');
const Flows = require('./server/services/flows.js');
const Account = require('./server/services/account.js');
const Imp = require('./server/services/impersonation.js');
const Merge = require('./server/services/merge.js');
const Retention = require('./server/services/retention.js');
const RemoteSync = require('./server/remote-sync.js');
const { Collab } = require('./server/services/collab.js');
const { createRunner } = require('./server/services/runs.js');
const { FakeAIProvider } = require('./assets/js/adapters/ai.js');
const { FakeSearchProvider } = require('./assets/js/adapters/search.js');
const { FakeMailProvider } = require('./assets/js/adapters/mail.js');
const { FakeGateway } = require('./server/adapters/payment.js');

const ROOT = __dirname;
const COOKIE = 'af_session';
const SESSION_MS = 7 * 24 * 3600 * 1000;
const MAX_BODY = 1024 * 1024;
const MAX_SESSIONS_PER_USER = 10;
const MAX_DEVICES_PER_USER = 20;
const DUMMY_HASH = Sec.hashPassword('timing-equalizer-not-a-real-password');
const STATIC_FILES = new Set(['index.html', 'register.html']);
const STATIC_DIRS = new Set(['super', 'admin', 'app', 'assets']);
const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8',
};
const CSP = "default-src 'self'; script-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'";

class HttpError extends Error {
  constructor(status, message, extra) { super(message); this.status = status; this.extra = extra || {}; }
}

const log = msg => process.stdout.write('[agentflow] ' + msg + '\n');
const publicTenant = t => (t ? { id: t.id, name: t.name, status: t.status, plan_id: t.plan_id } : null);

function createServer(opts = {}) {
  let server_runner = null;
  const dataDir = opts.dataDir || path.join(ROOT, 'data');
  const store = new Store({
    file: path.join(dataDir, 'db.json'),
    backupDir: path.join(dataDir, 'backups'),
    seedFile: opts.seedFile || path.join(ROOT, 'data', 'seed.json'),
    debounceMs: opts.saveDebounceMs,
    afterWrite: opts.afterWrite,
    onError: e => log('delayed save failed, will retry: ' + e.message),
  }).init();
  const trustProxy = !!opts.trustProxy;
  const secureCookie = trustProxy || process.env.NODE_ENV === 'production';
  // Failed-attempt budgets. They are only charged on failure and never cleared by someone else's success.
  const loginByAccount = new Sec.RateLimiter({ max: 5, windowMs: 60000 });   // ip + email
  const loginByIp = new Sec.RateLimiter({ max: 20, windowMs: 60000 });       // spraying many emails from one IP
  const loginByEmail = new Sec.RateLimiter({ max: 15, windowMs: 60000 });    // one account attacked from many IPs
  const registerByIp = new Sec.RateLimiter({ max: 10, windowMs: 60000 });
  const passwordGuesses = new Sec.RateLimiter({ max: 5, windowMs: 60000 });   // wrong "current password" attempts per account
  const MAX_LOGIN_EVENTS = 5000;
  const db = () => store.data;

  // Persist after the response so a bad-password reply costs the same as an unknown-email reply.
  const saveSoon = () => store.saveSoon();   // batched: many sign-in records inside a moment make one write

  // With TRUST_PROXY=1 we assume exactly one trusted proxy that appends the real client address, so the LAST entry is used.
  const clientIp = req => {
    if (trustProxy) {
      const parts = String(req.headers['x-forwarded-for'] || '').split(',').map(s => s.trim()).filter(Boolean);
      if (parts.length) return parts[parts.length - 1];
    }
    return req.socket.remoteAddress || 'unknown';
  };

  function send(res, status, body, headers = {}) {
    const text = JSON.stringify(body);
    res.writeHead(status, Object.assign({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }, headers));
    res.end(text);
  }

  function readJson(req, limit = MAX_BODY) {
    return new Promise((resolve, reject) => {
      const chunks = []; let size = 0; let tooBig = false; let ended = false;
      req.on('data', c => {
        size += c.length;
        if (size > limit) { tooBig = true; chunks.length = 0; return; } // keep draining so the 413 can be delivered
        if (!tooBig) chunks.push(c);
      });
      req.on('end', () => {
        ended = true;
        if (tooBig) return reject(new HttpError(413, `Request is too large (limit ${Math.round(limit / 1048576)} MB).`));
        const raw = Buffer.concat(chunks).toString('utf8');
        if (!raw.trim()) return resolve({});
        let parsed;
        try { parsed = JSON.parse(raw); } catch { return reject(new HttpError(400, 'Request body is not valid JSON.')); }
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return reject(new HttpError(400, 'Request body must be a JSON object.'));
        resolve(parsed);
      });
      req.on('error', () => reject(new HttpError(400, 'Request could not be read.')));
      req.on('close', () => { if (!ended) reject(new HttpError(400, 'Request was cancelled before it finished.')); });
    });
  }

  function getAuth(req) {
    const tok = Sec.parseCookies(req.headers.cookie)[COOKIE];
    if (!tok) return null;
    const id = Sec.hashToken(tok);
    const s = db().sessions.find(x => x.id === id);
    if (!s) return null;
    if (Date.parse(s.expires_at) <= Date.now()) {
      db().sessions = db().sessions.filter(x => x.id !== id); store.save(); return null;
    }
    const real = db().users.find(u => u.id === s.user_id);
    if (!real) return null;
    const realTenant = real.tenant_id ? db().tenants.find(t => t.id === real.tenant_id) || null : null;
    if (Auth.checkLoginEligibility(real, realTenant)) return null; // freezing revokes access immediately
    const imp = Imp.resolve(db(), real, s);
    if (imp.ended) { // expired, or no longer allowed (subject frozen, moved, deleted): fall back to the real account
      Imp.end(db(), real, s, db().users.find(u => u.id === s.subject_id), requestContext(req), imp.ended);
      saveSoon();
    }
    if (!imp.subject) return { sid: id, user: real, tenant: realTenant, by: null, impersonation: null, session: { user_id: real.id, tenant_id: real.tenant_id, role: real.role } };
    const sub = imp.subject;
    const tenant = sub.tenant_id ? db().tenants.find(t => t.id === sub.tenant_id) || null : null;
    // Permissions and tenant isolation come from the SUBJECT; `by` is the real person for audit trails.
    return { sid: id, user: sub, tenant, by: real, session: { user_id: sub.id, tenant_id: sub.tenant_id, role: sub.role },
      impersonation: { actor: { id: real.id, name: real.name, role: real.role }, frozen: !!imp.frozen, expires_at: imp.expires_at } };
  }
  const requestContext = req => Object.assign({ ip: clientIp(req) }, Auth.parseUserAgent(String(req.headers['user-agent'] || '').slice(0, 400)));
  const requireAuth = req => {
    const a = getAuth(req);
    if (!a) throw new HttpError(401, 'Sign in to continue.');
    return a;
  };

  function recordLogin(user, ua, ip, success, reason) {
    const p = Auth.parseUserAgent(ua);
    db().loginEvents.push({ id: Sec.newId('le'), user_id: user.id, tenant_id: user.tenant_id, at: new Date().toISOString(), ip, browser: p.browser, os: p.os, device: p.device, success, reason: reason || null });
    if (db().loginEvents.length > MAX_LOGIN_EVENTS) db().loginEvents.splice(0, db().loginEvents.length - MAX_LOGIN_EVENTS);
    if (!success) return null;
    const fp = crypto.createHash('sha1').update(user.id + ua).digest('hex').slice(0, 16);
    let d = db().devices.find(x => x.fingerprint === fp && x.user_id === user.id);
    const nowIso = new Date().toISOString();
    if (!d) {
      const mineDevs = db().devices.filter(x => x.user_id === user.id);
      if (mineDevs.length >= MAX_DEVICES_PER_USER) { const oldest = mineDevs.sort((a, b) => (a.last_seen < b.last_seen ? -1 : 1))[0]; db().devices = db().devices.filter(x => x !== oldest); }
      d = { id: 'dev_' + fp, user_id: user.id, fingerprint: fp, browser: p.browser, os: p.os, device: p.device, first_seen: nowIso, last_seen: nowIso, login_count: 0 }; db().devices.push(d); }
    d.login_count += 1; d.last_seen = nowIso;
    return d.id;
  }

  function startSession(res, user, tenant, deviceId, ip) {
    const token = Sec.newToken();
    const now = Date.now();
    db().sessions = db().sessions.filter(s => Date.parse(s.expires_at) > now);
    const mine = db().sessions.filter(s => s.user_id === user.id).sort((a, b) => (a.created_at < b.created_at ? -1 : 1));
    const evict = new Set(mine.slice(0, Math.max(0, mine.length - (MAX_SESSIONS_PER_USER - 1))).map(s => s.id));   // oldest sign-ins make room
    if (evict.size) db().sessions = db().sessions.filter(s => !evict.has(s.id));
    db().sessions.push({ id: Sec.hashToken(token), user_id: user.id, tenant_id: user.tenant_id, role: user.role, device_id: deviceId, ip, created_at: new Date(now).toISOString(), expires_at: new Date(now + SESSION_MS).toISOString() });
    res.setHeader('Set-Cookie', Sec.serializeCookie(COOKIE, token, { maxAgeSec: SESSION_MS / 1000, secure: secureCookie }));
    return { user: Auth.publicUser(user), tenant: publicTenant(tenant) };
  }

  const routes = {
    'GET /api/health': async (req, res) => send(res, 200, { ok: true, mode: 'server', time: new Date().toISOString() }),

    'POST /api/auth/login': async (req, res) => {
      const body = await readJson(req);
      const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
      const password = typeof body.password === 'string' ? body.password : '';
      if (!email || !password || email.length > 254 || password.length > 128) throw new HttpError(400, 'Enter your email and password.');
      const ip = clientIp(req); const key = ip + '|' + email;
      const blocked = [loginByAccount.check(key), loginByIp.check(ip), loginByEmail.check(email)].find(r => !r.allowed);
      if (blocked) {
        return send(res, 429, { error: `Too many sign-in attempts. Wait ${blocked.retryAfter} seconds and try again.` }, { 'Retry-After': String(blocked.retryAfter) });
      }
      const user = db().users.find(u => u.email === email);
      const valid = Sec.verifyPassword(password, user ? user.password_hash : DUMMY_HASH) && !!user;
      const ua = String(req.headers['user-agent'] || '').slice(0, 400);
      if (!valid) {
        loginByAccount.hit(key); loginByIp.hit(ip); loginByEmail.hit(email);
        if (user) recordLogin(user, ua, ip, false, 'bad_password');
        saveSoon();
        return send(res, 401, { error: 'Email or password is incorrect.' });
      }
      const tenant = user.tenant_id ? db().tenants.find(t => t.id === user.tenant_id) || null : null;
      const block = Auth.checkLoginEligibility(user, tenant);
      if (block) { recordLogin(user, ua, ip, false, block.code); store.save(); return send(res, 403, { error: block.message, code: block.code }); }
      loginByAccount.reset(key); // only this client's own failure streak for this account; IP and email budgets keep their history
      const deviceId = recordLogin(user, ua, ip, true);
      const out = startSession(res, user, tenant, deviceId, ip);
      store.save();
      send(res, 200, out);
    },

    'POST /api/auth/register': async (req, res) => {
      const ip = clientIp(req);
      const rl = registerByIp.hit(ip);
      if (!rl.allowed) return send(res, 429, { error: `Too many sign-up attempts. Wait ${rl.retryAfter} seconds and try again.` }, { 'Retry-After': String(rl.retryAfter) });
      const v = Auth.validateRegistration(await readJson(req));
      if (!v.ok) return send(res, 400, { error: 'Check the highlighted fields and try again.', errors: v.errors });
      const { name, email, password } = v.value;
      if (db().users.some(u => u.email === email)) return send(res, 409, { error: 'An account with this email already exists. Sign in instead.', errors: { email: 'This email is already registered.' } });
      const now = new Date().toISOString();
      const user = { id: Sec.newId('u'), tenant_id: null, role: 'individual', plan_id: 'free', name, email, password_hash: Sec.hashPassword(password), status: 'active', prefs: { theme: 'light' }, created_at: now, created_by: null };
      const free = db().plans.find(p => p.id === 'free');
      db().users.push(user);
      db().usage.push({ id: 'use_' + user.id, tenant_id: null, user_id: user.id, period: now.slice(0, 7), credits_used: 0, credits_limit: free ? free.credits_per_month : 100 });
      db().auditLog.push({ id: Sec.newId('au'), tenant_id: null, actor_id: user.id, actor_name: name, action: 'user.register', target: user.id, at: now, meta: {} });
      const deviceId = recordLogin(user, String(req.headers['user-agent'] || '').slice(0, 400), ip, true);
      const out = startSession(res, user, null, deviceId, ip);
      store.save();
      send(res, 201, out);
    },

    'POST /api/auth/logout': async (req, res) => {
      await readJson(req);
      const tok = Sec.parseCookies(req.headers.cookie)[COOKIE];
      if (tok) {
        const id = Sec.hashToken(tok); const a = getAuth(req);
        if (a && a.by) Imp.end(db(), a.by, db().sessions.find(s => s.id === id) || {}, a.user, requestContext(req), 'signed_out');
        db().sessions = db().sessions.filter(s => s.id !== id); store.save();
      }
      res.setHeader('Set-Cookie', Sec.serializeCookie(COOKIE, '', { maxAgeSec: 0, secure: secureCookie }));
      send(res, 200, { ok: true });
    },

    'GET /api/auth/me': async (req, res) => {
      const a = requireAuth(req);
      send(res, 200, { user: Auth.publicUser(a.user), tenant: publicTenant(a.tenant), impersonation: a.impersonation });
    },

    'PATCH /api/auth/prefs': async (req, res) => {
      const a = requireAuth(req);
      const body = await readJson(req);
      if (!['light', 'dark'].includes(body.theme)) throw new HttpError(400, 'Theme must be "light" or "dark".');
      if (a.by) return send(res, 200, { user: Auth.publicUser(a.user) }); // never change the preferences of the account being viewed
      a.user.prefs = Object.assign({}, a.user.prefs, { theme: body.theme });
      store.save();
      send(res, 200, { user: Auth.publicUser(a.user) });
    },

    'GET /api/flows': async (req, res) => respond(res, Flows.listFlows(db(), actorOf(requireAuth(req)))),
  };

  // ---- Parameterised routes (Phase 2+). Services decide permissions; role and tenant come from the session only.
  const paramRoutes = [];
  const addRoute = (method, pattern, handler) => {
    const keys = [];
    const re = new RegExp('^' + pattern.replace(/:([a-z]+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
    paramRoutes.push({ method, re, keys, handler });
  };
  const actorOf = a => ({ user: a.user, session: a.session, by: a.by || null });
  const respond = (res, r) => { const { ok, status, ...body } = r; send(res, status || (ok ? 200 : 400), body); };
  // Save after a change. A failed payment (402) is saved too, so the audit trail is real. If the save fails,
  // the in-memory change is undone by re-reading the last saved file and the caller is told nothing changed.
  const commit = r => {
    if (!(r.ok || r.persist)) return r;
    delete r.persist;
    try { store.save(); } catch (e) {
      log('save failed, change undone: ' + e.message);
      try { store.reload(); } catch (e2) { log('reload failed: ' + e2.message); }
      return { ok: false, status: 500, error: 'Your change could not be saved, so nothing was changed. Check free disk space and try again.' };
    }
    return r;
  };

  addRoute('GET', '/api/users', async (req, res) => respond(res, Users.listUsers(db(), actorOf(requireAuth(req)))));
  addRoute('POST', '/api/users', async (req, res) => {
    const a = requireAuth(req);
    respond(res, commit(Users.createUser(db(), actorOf(a), await readJson(req))));
  });
  addRoute('PATCH', '/api/users/:id', async (req, res, url, p) => {
    const a = requireAuth(req);
    respond(res, commit(Users.updateUser(db(), actorOf(a), p.id, await readJson(req))));
  });
  addRoute('DELETE', '/api/users/:id', async (req, res, url, p) => respond(res, commit(Users.deleteUser(db(), actorOf(requireAuth(req)), p.id))));
  addRoute('POST', '/api/users/:id/reset-password', async (req, res, url, p) => {
    const a = requireAuth(req);
    respond(res, commit(Users.resetPassword(db(), actorOf(a), p.id, await readJson(req))));
  });
  addRoute('POST', '/api/users/:id/freeze', async (req, res, url, p) => {
    const a = requireAuth(req); const body = await readJson(req);
    respond(res, commit(Users.setFrozen(db(), actorOf(a), p.id, true, body.reason)));
  });
  addRoute('POST', '/api/users/:id/unfreeze', async (req, res, url, p) => {
    const a = requireAuth(req); await readJson(req);
    respond(res, commit(Users.setFrozen(db(), actorOf(a), p.id, false)));
  });
  addRoute('GET', '/api/devices', async (req, res) => respond(res, Users.listDevices(db(), actorOf(requireAuth(req)))));
  addRoute('GET', '/api/login-events', async (req, res, url) => respond(res, Users.listLoginEvents(db(), actorOf(requireAuth(req)), Object.fromEntries(url.searchParams))));
  addRoute('GET', '/api/seats', async (req, res, url) => respond(res, Users.seatsFor(db(), actorOf(requireAuth(req)), url.searchParams.get('tenant_id'))));

  // ---- Phase 3: companies, money, audit, backup
  addRoute('GET', '/api/tenants', async (req, res) => respond(res, Tenants.listTenants(db(), actorOf(requireAuth(req)))));
  addRoute('POST', '/api/tenants', async (req, res) => { const a = requireAuth(req); respond(res, commit(Tenants.createTenant(db(), actorOf(a), await readJson(req)))); });
  addRoute('GET', '/api/tenants/:id', async (req, res, url, p) => respond(res, Tenants.tenantDetail(db(), actorOf(requireAuth(req)), p.id)));
  addRoute('PATCH', '/api/tenants/:id', async (req, res, url, p) => { const a = requireAuth(req); respond(res, commit(Tenants.updateTenant(db(), actorOf(a), p.id, await readJson(req)))); });
  addRoute('DELETE', '/api/tenants/:id', async (req, res, url, p) => respond(res, commit(Tenants.deleteTenant(db(), actorOf(requireAuth(req)), p.id))));
  addRoute('POST', '/api/tenants/:id/freeze', async (req, res, url, p) => { const a = requireAuth(req); const b = await readJson(req); respond(res, commit(Tenants.setTenantFrozen(db(), actorOf(a), p.id, true, b.reason))); });
  addRoute('POST', '/api/tenants/:id/unfreeze', async (req, res, url, p) => { const a = requireAuth(req); await readJson(req); respond(res, commit(Tenants.setTenantFrozen(db(), actorOf(a), p.id, false))); });
  addRoute('GET', '/api/stats/platform', async (req, res) => respond(res, Tenants.platformStats(db(), actorOf(requireAuth(req)))));
  addRoute('GET', '/api/invoices', async (req, res) => respond(res, Ledger.listInvoices(db(), actorOf(requireAuth(req)))));
  addRoute('GET', '/api/payments', async (req, res) => respond(res, Ledger.listPayments(db(), actorOf(requireAuth(req)))));
  addRoute('GET', '/api/audit', async (req, res, url) => respond(res, Ledger.listAudit(db(), actorOf(requireAuth(req)), Object.fromEntries(url.searchParams))));
  addRoute('GET', '/api/db/export', async (req, res) => respond(res, commit(Object.assign(Backup.exportAll(db(), actorOf(requireAuth(req))), { persist: true }))));
  addRoute('GET', '/api/db/export-company', async (req, res) => respond(res, commit(Object.assign(Backup.exportTenant(db(), actorOf(requireAuth(req))), { persist: true }))));
  addRoute('POST', '/api/db/import', async (req, res) => {
    const a = requireAuth(req); const bundle = await readJson(req, 25 * 1048576);
    const r = Backup.importAll(db(), actorOf(a), bundle);
    if (r.ok) {
      try { store.replace(r.data); } catch (e) { log('import failed, previous data kept: ' + e.message); return send(res, 500, { error: 'The import could not be saved, so nothing was changed. Check free disk space and try again.' }); }
      Users.audit(db(), actorOf(a), 'db.import', 'database', null, {}); store.save();
      return send(res, 200, { imported: true });
    }
    respond(res, r);
  });
  addRoute('POST', '/api/db/import-company', async (req, res) => { const a = requireAuth(req); respond(res, commit(Backup.importTenant(db(), actorOf(a), await readJson(req, 6 * 1048576)))); });

  // ---- Phase 4: company dashboard and billing (simulated gateway behind an adapter)
  const gateway = opts.gateway || new FakeGateway();
  if (process.env.NODE_ENV === 'production' && gateway instanceof FakeGateway && !opts.allowFakeGateway) {
    throw new Error('Refusing to start in production with the FAKE payment gateway: every test card would succeed. Pass a real gateway (see server/adapters/payment.js).');
  }
  addRoute('GET', '/api/stats/company', async (req, res) => respond(res, Tenants.companyStats(db(), actorOf(requireAuth(req)))));
  addRoute('GET', '/api/billing', async (req, res) => respond(res, Billing.getBilling(db(), actorOf(requireAuth(req)))));
  addRoute('POST', '/api/billing/seats', async (req, res) => { const a = requireAuth(req); respond(res, commit(Billing.buySeats(db(), actorOf(a), await readJson(req), gateway))); });
  addRoute('POST', '/api/billing/plan', async (req, res) => { const a = requireAuth(req); respond(res, commit(Billing.changePlan(db(), actorOf(a), await readJson(req), gateway))); });
  addRoute('POST', '/api/billing/invoices/:id/pay', async (req, res, url, p) => { const a = requireAuth(req); respond(res, commit(Billing.payInvoice(db(), actorOf(a), p.id, await readJson(req), gateway))); });

  // ---- "Login as". The real person stays in sessions[].user_id; the subject is sessions[].subject_id (see services/impersonation.js).
  addRoute('POST', '/api/impersonation/start', async (req, res) => {
    const a = requireAuth(req); const body = await readJson(req);
    const session = db().sessions.find(s => s.id === a.sid);
    const subject = typeof body.user_id === 'string' ? db().users.find(u => u.id === body.user_id) : null;
    const r = a.by ? { ok: false, status: 403, error: 'Return to your own account before signing in as someone else.' } : Imp.begin(db(), a.user, session, subject, requestContext(req));
    if (!r.ok && a.user.tenant_id && subject && subject.tenant_id !== a.user.tenant_id) {
      Users.audit(db(), actorOf(a), 'security.cross_tenant_attempt', subject.id, a.user.tenant_id, { op: 'impersonate' });
    }
    respond(res, commit(Object.assign({}, r, r.ok ? { user: Auth.publicUser(subject) } : { persist: true })));
  });
  addRoute('POST', '/api/impersonation/end', async (req, res) => {
    const a = requireAuth(req); await readJson(req);
    if (!a.by) return send(res, 400, { error: 'You are not signed in as someone else.' });
    Imp.end(db(), a.by, db().sessions.find(s => s.id === a.sid), a.user, requestContext(req), 'returned');
    store.save();
    send(res, 200, { ok: true, user: Auth.publicUser(a.by) });
  });

  // ---- Phase 7: running flows. The server executes the saved flow, so credits, Stop and history cannot be bypassed from a browser.
  // Real AI / search / mail services replace these three fakes later without touching the runner.
  const providers = opts.providers || { ai: new FakeAIProvider(), search: new FakeSearchProvider(), mail: new FakeMailProvider() };
  const runner = createRunner({ store, providers, stepDelayMs: opts.stepDelayMs === undefined ? 350 : opts.stepDelayMs });
  if (runner.recover()) log('marked runs that were interrupted by the last shutdown as failed');
  addRoute('POST', '/api/flows/:id/runs', async (req, res, url, p) => { const a = requireAuth(req); respond(res, runner.start(actorOf(a), p.id, await readJson(req))); });
  addRoute('GET', '/api/runs', async (req, res, url) => respond(res, runner.list(actorOf(requireAuth(req)), Object.fromEntries(url.searchParams))));
  addRoute('GET', '/api/runs/:id', async (req, res, url, p) => respond(res, runner.get(actorOf(requireAuth(req)), p.id)));
  addRoute('POST', '/api/runs/:id/stop', async (req, res, url, p) => { const a = requireAuth(req); await readJson(req); respond(res, runner.stop(actorOf(a), p.id)); });
  server_runner = runner;


  // ---- Phase 9: co-work. Presence and locks live in memory (services/collab.js); events travel over Server-Sent Events,
  // with the same snapshot available by plain GET so a browser can fall back to polling.
  const collab = new Collab();
  const hub = new Map();   // flowId -> Set of {res, req, clientId}
  const clientIdOf = v => (typeof v === 'string' && /^[A-Za-z0-9_-]{6,64}$/.test(v) ? v : '');
  const MAX_STREAMS_PER_FLOW = 60;
  const MAX_STREAMS_PER_USER = 20;
  function publish(flowId, event, payload) {
    const conns = hub.get(flowId); if (!conns) return;
    const msg = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
    for (const c of conns) { try { c.res.write(msg); } catch (e) { conns.delete(c); } }
  }
  const publishCollab = flowId => publish(flowId, 'collab', collab.snapshot(flowId));
  function publishVersion(flowId, a, version, merged, client) {
    const by = a.by ? `${a.by.name} (as ${a.user.name})` : a.user.name;
    publish(flowId, 'version', { n: version.n, summary: version.summary, by, merged: !!merged, client: client || null, at: new Date().toISOString() });
  }
  const lockMessage = locks => `${[...new Set(locks.map(l => l.label))].join(', ')} ${locks.length === 1 ? 'is' : 'are'} editing cards that this change touches. Ask them to finish, then try again.`;
  /** Cards this save changes that another editor holds a lock on. */
  function lockedNodesFor(flowId, body, a) {
    if (!Array.isArray(body.nodes)) return [];
    const flow = db().flows.find(f => f.id === flowId); if (!flow) return [];
    const baseV = db().flowVersions.find(v => v.flow_id === flowId && v.n === body.base_version);
    const baseNodes = baseV ? baseV.snapshot.nodes : flow.nodes;
    const mine = body.nodes.filter(n => n && typeof n.id === 'string');
    const baseEdges = baseV ? baseV.snapshot.edges : flow.edges;
    const mineEdges = Array.isArray(body.edges) ? body.edges.filter(e => e && typeof e === 'object') : baseEdges;
    const changed = Merge.changedNodeIds({ nodes: baseNodes, edges: baseEdges }, { nodes: mine, edges: mineEdges });
    return collab.lockedByOthers(flowId, changed, clientIdOf(body.client_id), (a.by || a.user).id);
  }
  const whoOf = (a, clientId, canEditFlow) => { const real = a.by || a.user; return { client_id: clientId, user_id: real.id, name: real.name, as_name: a.by ? a.user.name : null, can_edit: canEditFlow }; };
  function collabContext(req, flowId, body) {
    const a = requireAuth(req);
    const f = Flows.getFlow(db(), actorOf(a), flowId);
    if (!f.ok) throw new HttpError(404, 'No such flow.');
    const clientId = clientIdOf(body ? body.client_id : new URL(req.url, 'http://x').searchParams.get('client'));
    if (!clientId) throw new HttpError(400, 'Send a client_id of 6 to 64 letters, digits, - or _.');
    if (!collab.claim(clientId, (a.by || a.user).id)) throw new HttpError(403, 'That client_id belongs to someone else.');
    return { a, clientId, who: whoOf(a, clientId, !!f.can_edit), version: f.flow.version };
  }
  const collabState = (flowId, version) => Object.assign(collab.snapshot(flowId), { version });
  addRoute('GET', '/api/flows/:id/collab', async (req, res, url, p) => {
    const a = requireAuth(req); const f = Flows.getFlow(db(), actorOf(a), p.id);
    if (!f.ok) throw new HttpError(404, 'No such flow.');
    send(res, 200, collabState(p.id, f.flow.version));
  });
  addRoute('POST', '/api/flows/:id/collab/heartbeat', async (req, res, url, p) => {
    const body = await readJson(req); const c = collabContext(req, p.id, body);
    const known = collab.snapshot(p.id).presence;
    if (known.length >= MAX_STREAMS_PER_FLOW && !known.some(x => x.client_id === c.clientId)) throw new HttpError(429, 'Too many people are on this flow right now.');
    const nodeId = typeof body.node_id === 'string' ? body.node_id.slice(0, 64) : null;
    if (collab.heartbeat(p.id, c.who, { node_id: nodeId })) publishCollab(p.id);
    send(res, 200, collabState(p.id, c.version));
  });
  addRoute('POST', '/api/flows/:id/collab/lock', async (req, res, url, p) => {
    const body = await readJson(req); const c = collabContext(req, p.id, body);
    if (typeof body.node_id !== 'string' || !body.node_id || body.node_id.length > 64) throw new HttpError(400, 'Send the card id to lock.');
    const lockFlow = db().flows.find(f => f.id === p.id);
    if (!lockFlow || !lockFlow.nodes.some(n => n.id === body.node_id)) throw new HttpError(404, 'That card is not in this flow.');
    const r = collab.acquire(p.id, body.node_id, c.who);
    if (!r.ok) return send(res, 409, { error: r.holder ? `${r.holder.label} is editing this card right now.` : r.error, code: 'locked', holder: r.holder });
    publishCollab(p.id); send(res, 200, collabState(p.id, c.version));
  });
  addRoute('POST', '/api/flows/:id/collab/unlock', async (req, res, url, p) => {
    const body = await readJson(req); const c = collabContext(req, p.id, body);
    if (collab.release(p.id, String(body.node_id || ''), c.clientId)) publishCollab(p.id);
    send(res, 200, collabState(p.id, c.version));
  });
  addRoute('POST', '/api/flows/:id/collab/leave', async (req, res, url, p) => {
    const body = await readJson(req); const c = collabContext(req, p.id, body);
    if (collab.leave(p.id, c.clientId)) publishCollab(p.id);
    send(res, 200, { ok: true });
  });
  addRoute('GET', '/api/flows/:id/events', async (req, res, url, p) => {
    const c = collabContext(req, p.id, null);
    const conns = hub.get(p.id) || new Set(); hub.set(p.id, conns);
    if (conns.size >= MAX_STREAMS_PER_FLOW) throw new HttpError(429, 'Too many live connections for this flow.');
    let mine = 0; for (const set of hub.values()) for (const k of set) if (k.userId === (c.a.by || c.a.user).id) mine += 1;
    if (mine >= MAX_STREAMS_PER_USER) throw new HttpError(429, 'You have too many live connections open. Close some flow tabs and try again.');
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    const conn = { res, req, clientId: c.clientId, flowId: p.id, userId: (c.a.by || c.a.user).id };
    conns.add(conn);
    res.write(`retry: 3000\n\nevent: collab\ndata: ${JSON.stringify(collabState(p.id, c.version))}\n\n`);
    req.on('close', () => { conns.delete(conn); if (!conns.size) hub.delete(p.id); });
  });
  // Every 5 s: expire stale presence, re-check that each stream's owner may still see the flow (freeze, delete, impersonation end), keep-alive.
  const collabTimer = setInterval(() => {
    for (const id of collab.sweep()) publishCollab(id);
    for (const [flowId, conns] of hub) {
      for (const c of [...conns]) {
        let allowed = false;
        try { const a = getAuth(c.req); allowed = !!a && Flows.getFlow(db(), actorOf(a), flowId).ok; } catch (e) { allowed = false; }
        if (!allowed) { conns.delete(c); try { c.res.end(); } catch (e) { /* closed */ } continue; }
        try { c.res.write(': keep-alive\n\n'); } catch (e) { conns.delete(c); }
      }
    }
  }, 5000);
  collabTimer.unref();

  // ---- Phase 5: flows, templates, account, credits
  addRoute('GET', '/api/flows/:id', async (req, res, url, p) => respond(res, Flows.getFlow(db(), actorOf(requireAuth(req)), p.id)));
  addRoute('POST', '/api/flows', async (req, res) => { const a = requireAuth(req); respond(res, commit(Flows.createFlow(db(), actorOf(a), await readJson(req)))); });
  addRoute('PATCH', '/api/flows/:id', async (req, res, url, p) => {
    const a = requireAuth(req); const body = await readJson(req);
    const seen = Flows.getFlow(db(), actorOf(a), p.id); if (!seen.ok) return respond(res, seen);   // access first: lock details are for people who can see the flow
    const locked = lockedNodesFor(p.id, body, a);
    if (locked.length) return send(res, 423, { error: lockMessage(locked), code: 'locked', locked });
    const r = commit(Flows.saveFlow(db(), actorOf(a), p.id, body));
    if (r.ok && r.version) publishVersion(p.id, a, r.version, r.merged, clientIdOf(body.client_id));
    respond(res, r);
  });
  addRoute('DELETE', '/api/flows/:id', async (req, res, url, p) => respond(res, commit(Flows.deleteFlow(db(), actorOf(requireAuth(req)), p.id))));
  addRoute('POST', '/api/flows/:id/duplicate', async (req, res, url, p) => { const a = requireAuth(req); await readJson(req); respond(res, commit(Flows.duplicateFlow(db(), actorOf(a), p.id))); });
  addRoute('GET', '/api/flows/:id/versions', async (req, res, url, p) => respond(res, Flows.listVersions(db(), actorOf(requireAuth(req)), p.id)));
  addRoute('GET', '/api/flows/:id/versions/:n', async (req, res, url, p) => respond(res, Flows.getVersion(db(), actorOf(requireAuth(req)), p.id, p.n)));
  addRoute('POST', '/api/flows/:id/versions/:n/restore', async (req, res, url, p) => { const a = requireAuth(req); const body = await readJson(req);
    const seen = Flows.getFlow(db(), actorOf(a), p.id); if (!seen.ok) return respond(res, seen);
    const others = collab.lockedByOthers(p.id, collab.snapshot(p.id).locks.map(l => l.node_id), clientIdOf(body.client_id), (a.by || a.user).id);
    if (others.length) return send(res, 423, { error: lockMessage(others), code: 'locked', locked: others });
    const r = commit(Flows.restoreVersion(db(), actorOf(a), p.id, Number(p.n), body));
    if (r.ok) publishVersion(p.id, a, r.version, false, clientIdOf(body.client_id));
    respond(res, r); });
  addRoute('GET', '/api/templates', async (req, res) => respond(res, Flows.listTemplates(db(), actorOf(requireAuth(req)))));
  addRoute('POST', '/api/templates/:id/clone', async (req, res, url, p) => { const a = requireAuth(req); respond(res, commit(Flows.cloneTemplate(db(), actorOf(a), p.id, await readJson(req)))); });
  addRoute('GET', '/api/usage', async (req, res) => respond(res, Account.getUsage(db(), actorOf(requireAuth(req)))));
  addRoute('GET', '/api/account', async (req, res) => respond(res, Account.getAccount(db(), actorOf(requireAuth(req)))));
  addRoute('PATCH', '/api/account/profile', async (req, res) => { const a = requireAuth(req); respond(res, commit(Account.updateProfile(db(), actorOf(a), await readJson(req)))); });
  addRoute('POST', '/api/account/password', async (req, res) => {
    const a = requireAuth(req); const body = await readJson(req);
    const wait = passwordGuesses.check(a.user.id);
    if (!wait.allowed) return send(res, 429, { error: `Too many wrong passwords. Wait ${wait.retryAfter} seconds and try again.` }, { 'Retry-After': String(wait.retryAfter) });
    const r = Account.changePassword(db(), actorOf(a), body, a.sid);
    if (r.ok) passwordGuesses.reset(a.user.id); else if (r.errors && r.errors.current) passwordGuesses.hit(a.user.id);
    respond(res, commit(r));
  });
  addRoute('GET', '/api/account/activity', async (req, res) => respond(res, Account.myActivity(db(), actorOf(requireAuth(req)))));
  addRoute('PUT', '/api/account/cards', async (req, res) => { const a = requireAuth(req); respond(res, commit(Account.saveCustomCards(db(), actorOf(a), await readJson(req)))); });
  addRoute('POST', '/api/account/plan', async (req, res) => { const a = requireAuth(req); respond(res, commit(Account.changePersonalPlan(db(), actorOf(a), await readJson(req), gateway))); });

  function matchRoute(method, pathname) {
    const exact = routes[method + ' ' + pathname];
    if (exact) return { handler: exact, params: {} };
    for (const r of paramRoutes) {
      if (r.method !== method) continue;
      const m = r.re.exec(pathname);
      if (!m) continue;
      try { return { handler: r.handler, params: Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])])) }; } catch { return null; }
    }
    return null;
  }
  const pathKnown = pathname => Object.keys(routes).some(k => k.endsWith(' ' + pathname)) || paramRoutes.some(r => r.re.test(pathname));

  function serveStatic(req, res, pathname) {
    const notFound = () => { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('Not found'); };
    let p;
    try { p = decodeURIComponent(pathname); } catch { return notFound(); }
    if (p.includes('\0')) return notFound();
    if (p === '/') p = '/index.html';
    const segs = p.split('/').filter(Boolean);
    if (!segs.length || segs.some(s => s === '..' || s.startsWith('.') || s.includes('\\'))) return notFound();
    const top = segs[0];
    const allowed = (segs.length === 1 && STATIC_FILES.has(top)) || (segs.length > 1 && STATIC_DIRS.has(top));
    if (!allowed) return notFound();
    const file = path.join(ROOT, ...segs);
    if (!file.startsWith(ROOT + path.sep)) return notFound();
    fs.stat(file, (err, st) => {
      if (err || !st.isFile()) return notFound();
      const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': type, 'Content-Length': st.size, 'Cache-Control': 'no-cache' });
      if (req.method === 'HEAD') return res.end();
      const stream = fs.createReadStream(file);
      stream.on('error', () => res.destroy());
      stream.pipe(res);
    });
  }

  const server = http.createServer(async (req, res) => {
    res.setHeader('Content-Security-Policy', CSP);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    if (secureCookie) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    try {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname.startsWith('/api/')) {
        if (['POST', 'PUT', 'PATCH'].includes(req.method) && !String(req.headers['content-type'] || '').toLowerCase().startsWith('application/json')) {
          throw new HttpError(415, 'Send requests as application/json.');
        }
        const match = matchRoute(req.method, url.pathname);
        if (!match) {
          const known = pathKnown(url.pathname);
          throw new HttpError(known ? 405 : 404, known ? 'That method is not allowed here.' : 'No such API endpoint.');
        }
        return await match.handler(req, res, url, match.params);
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Method not allowed.');
      serveStatic(req, res, url.pathname);
    } catch (e) {
      if (e instanceof HttpError) return send(res, e.status, Object.assign({ error: e.message }, e.extra));
      log('error: ' + (e && e.message ? e.message : e));
      send(res, 500, { error: 'Something went wrong on the server. Try again; if it keeps happening, check the server console.' });
    }
  });
  // Retention: trim old runs and audit entries at startup and then hourly, so db.json stays small.
  const retain = () => { try { const r = Retention.prune(db(), Date.now(), opts.retention); if (r.runs || r.audit) { store.save(); log(`retention removed ${r.runs} runs, ${r.steps} steps, ${r.audit} audit entries`); } } catch (e) { log('retention failed: ' + e.message); } };
  retain();
  const retentionTimer = setInterval(retain, 3600000); retentionTimer.unref();
  const originalClose = server.close.bind(server);
  server.close = cb => { clearInterval(collabTimer); clearInterval(retentionTimer); try { store.flush(); } catch (e) { log('final save failed: ' + e.message); } for (const conns of hub.values()) for (const c of conns) { try { c.res.end(); } catch (e) { /* closed */ } } hub.clear(); return originalClose(cb); };
  server.collab = collab;
  server.store = store;
  server.runner = server_runner;
  return server;
}

if (require.main === module) {
  (async () => {
    const port = Number(process.env.PORT) || 3000;
    const host = process.env.HOST || '127.0.0.1';
    const dataDir = process.env.DATA_DIR || path.join(ROOT, 'data');
    // Optional off-machine copy of the database (hosts without a persistent disk). Needs REMOTE_STORE_URL + REMOTE_STORE_KEY.
    let pusher = null;
    if (process.env.REMOTE_STORE_URL && process.env.REMOTE_STORE_KEY) {
      const cfg = { url: process.env.REMOTE_STORE_URL, key: process.env.REMOTE_STORE_KEY };
      try {
        const r = await RemoteSync.pull({ ...cfg, file: path.join(dataDir, 'db.json') });   // before the Store loads
        log(r.restored ? 'restored the database from the remote store' : 'remote store is empty: starting from the seed');
      } catch (e) { log('cannot start: ' + e.message); process.exit(1); }   // never start on an unreadable store, it could overwrite real data
      pusher = RemoteSync.createPusher({ ...cfg, onError: e => log(e.message) });
    }
    const server = createServer({ trustProxy: process.env.TRUST_PROXY === '1', dataDir, allowFakeGateway: process.env.ALLOW_FAKE_GATEWAY === '1', afterWrite: pusher ? t => pusher.push(t) : undefined });
    server.listen(port, host, () => log(`running at http://localhost:${port}  (data: ${pusher ? 'remote store + ' : ''}${path.relative(ROOT, path.join(dataDir, 'db.json')) || 'db.json'})`));
    // Write anything still waiting (locally and to the remote store) before the process ends.
    let closing = false;
    const shutdown = async signal => {
      if (closing) return; closing = true;
      try { server.store.flush(); } catch (e) { log('final save failed: ' + e.message); }
      if (pusher) { try { await pusher.drain(8000); } catch (e) { log('final upload failed: ' + e.message); } }
      log(`stopped (${signal})`); process.exit(0);
    };
    process.on('SIGINT', () => shutdown('SIGINT')); process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('exit', () => { try { server.store.flush(); } catch (e) { /* nothing more to do */ } });
  })();
}

module.exports = { createServer };
