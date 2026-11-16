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

const ROOT = __dirname;
const COOKIE = 'af_session';
const SESSION_MS = 7 * 24 * 3600 * 1000;
const MAX_BODY = 1024 * 1024;
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
  const dataDir = opts.dataDir || path.join(ROOT, 'data');
  const store = new Store({
    file: path.join(dataDir, 'db.json'),
    backupDir: path.join(dataDir, 'backups'),
    seedFile: opts.seedFile || path.join(ROOT, 'data', 'seed.json'),
  }).init();
  const trustProxy = !!opts.trustProxy;
  const secureCookie = trustProxy || process.env.NODE_ENV === 'production';
  // Failed-attempt budgets. They are only charged on failure and never cleared by someone else's success.
  const loginByAccount = new Sec.RateLimiter({ max: 5, windowMs: 60000 });   // ip + email
  const loginByIp = new Sec.RateLimiter({ max: 20, windowMs: 60000 });       // spraying many emails from one IP
  const loginByEmail = new Sec.RateLimiter({ max: 15, windowMs: 60000 });    // one account attacked from many IPs
  const registerByIp = new Sec.RateLimiter({ max: 10, windowMs: 60000 });
  const MAX_LOGIN_EVENTS = 5000;
  const db = () => store.data;

  // Persist after the response so a bad-password reply costs the same as an unknown-email reply.
  let saveQueued = false;
  const saveSoon = () => {
    if (saveQueued) return;
    saveQueued = true;
    setImmediate(() => { saveQueued = false; try { store.save(); } catch (e) { log('save failed: ' + e.message); } });
  };

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

  function readJson(req) {
    return new Promise((resolve, reject) => {
      const chunks = []; let size = 0; let tooBig = false; let ended = false;
      req.on('data', c => {
        size += c.length;
        if (size > MAX_BODY) { tooBig = true; chunks.length = 0; return; } // keep draining so the 413 can be delivered
        if (!tooBig) chunks.push(c);
      });
      req.on('end', () => {
        ended = true;
        if (tooBig) return reject(new HttpError(413, 'Request is too large (limit 1 MB).'));
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
    const user = db().users.find(u => u.id === s.user_id);
    if (!user) return null;
    const tenant = user.tenant_id ? db().tenants.find(t => t.id === user.tenant_id) || null : null;
    if (Auth.checkLoginEligibility(user, tenant)) return null; // freezing revokes access immediately
    return { sid: id, user, tenant, session: { user_id: user.id, tenant_id: user.tenant_id, role: user.role } };
  }
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
    if (!d) { d = { id: 'dev_' + fp, user_id: user.id, fingerprint: fp, browser: p.browser, os: p.os, device: p.device, first_seen: nowIso, last_seen: nowIso, login_count: 0 }; db().devices.push(d); }
    d.login_count += 1; d.last_seen = nowIso;
    return d.id;
  }

  function startSession(res, user, tenant, deviceId, ip) {
    const token = Sec.newToken();
    const now = Date.now();
    db().sessions = db().sessions.filter(s => Date.parse(s.expires_at) > now);
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
      const user = { id: Sec.newId('u'), tenant_id: null, role: 'individual', name, email, password_hash: Sec.hashPassword(password), status: 'active', prefs: { theme: 'light' }, created_at: now, created_by: null };
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
      if (tok) { const id = Sec.hashToken(tok); db().sessions = db().sessions.filter(s => s.id !== id); store.save(); }
      res.setHeader('Set-Cookie', Sec.serializeCookie(COOKIE, '', { maxAgeSec: 0, secure: secureCookie }));
      send(res, 200, { ok: true });
    },

    'GET /api/auth/me': async (req, res) => {
      const a = requireAuth(req);
      send(res, 200, { user: Auth.publicUser(a.user), tenant: publicTenant(a.tenant) });
    },

    'PATCH /api/auth/prefs': async (req, res) => {
      const a = requireAuth(req);
      const body = await readJson(req);
      if (!['light', 'dark'].includes(body.theme)) throw new HttpError(400, 'Theme must be "light" or "dark".');
      a.user.prefs = Object.assign({}, a.user.prefs, { theme: body.theme });
      store.save();
      send(res, 200, { user: Auth.publicUser(a.user) });
    },

    'GET /api/flows': async (req, res) => {
      const a = requireAuth(req);
      const tenantName = id => (db().tenants.find(t => t.id === id) || {}).name || null;
      const userName = id => (db().users.find(u => u.id === id) || {}).name || 'Unknown';
      const flows = Ten.scopeFlows(a.session, db().flows).map(f => ({
        id: f.id, name: f.name, tenant_id: f.tenant_id, tenant_name: tenantName(f.tenant_id), owner_id: f.owner_id,
        owner_name: userName(f.owner_id), shared: !!f.shared, version: f.version, node_count: f.nodes.length, updated_at: f.updated_at,
      }));
      send(res, 200, { flows });
    },
  };

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
        const handler = routes[req.method + ' ' + url.pathname];
        if (!handler) {
          const known = Object.keys(routes).some(k => k.endsWith(' ' + url.pathname));
          throw new HttpError(known ? 405 : 404, known ? 'That method is not allowed here.' : 'No such API endpoint.');
        }
        return await handler(req, res, url);
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Method not allowed.');
      serveStatic(req, res, url.pathname);
    } catch (e) {
      if (e instanceof HttpError) return send(res, e.status, Object.assign({ error: e.message }, e.extra));
      log('error: ' + (e && e.message ? e.message : e));
      send(res, 500, { error: 'Something went wrong on the server. Try again; if it keeps happening, check the server console.' });
    }
  });
  server.store = store;
  return server;
}

if (require.main === module) {
  const port = Number(process.env.PORT) || 3000;
  const host = process.env.HOST || '127.0.0.1';
  const server = createServer({ trustProxy: process.env.TRUST_PROXY === '1' });
  server.listen(port, host, () => log(`running at http://localhost:${port}  (data: data/db.json)`));
}

module.exports = { createServer };
