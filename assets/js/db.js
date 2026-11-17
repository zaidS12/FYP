/* AgentFlow data access. The ONLY module pages use to read or write data.
 * Two backends with one interface: HTTP (/api on server.js) and Local (localStorage + embedded seed).
 * init() picks HTTP when the server answers, otherwise Local. UMD: browser (AF.db) and Node (tests). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./auth.js'), require('./tenancy.js'));
  else { root.AF = root.AF || {}; root.AF.db = factory(root.AF.auth, root.AF.tenancy); }
})(typeof self !== 'undefined' ? self : this, function (Auth, Ten) {
  'use strict';

  const GENERIC_LOGIN_ERROR = 'Email or password is incorrect.';
  const LS_DATA = 'af.localdb';
  const LS_SESSION = 'af.session';

  const toB64 = bytes => {
    if (typeof Buffer !== 'undefined') return Buffer.from(bytes).toString('base64');
    let s = ''; bytes.forEach(b => { s += String.fromCharCode(b); }); return btoa(s);
  };
  const fromB64 = s => (typeof Buffer !== 'undefined' ? new Uint8Array(Buffer.from(s, 'base64')) : Uint8Array.from(atob(s), c => c.charCodeAt(0)));
  const randomHex = n => Array.from(globalThis.crypto.getRandomValues(new Uint8Array(n)), x => x.toString(16).padStart(2, '0')).join('');
  const rid = p => p + '_' + randomHex(8);

  async function pbkdf2(subtle, password, salt, iterations) {
    const key = await subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
    return new Uint8Array(await subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256));
  }
  async function hashPw(subtle, password) {
    const salt = globalThis.crypto.getRandomValues(new Uint8Array(16));
    return ['pbkdf2', 100000, toB64(salt), toB64(await pbkdf2(subtle, password, salt, 100000))].join('$');
  }
  async function verifyPw(subtle, password, stored) {
    const parts = typeof stored === 'string' ? stored.split('$') : [];
    if (parts.length !== 4 || parts[0] !== 'pbkdf2') return false;
    const actual = await pbkdf2(subtle, password, fromB64(parts[2]), +parts[1]);
    const expected = fromB64(parts[3]);
    if (actual.length !== expected.length) return false;
    let diff = 0; for (let i = 0; i < actual.length; i++) diff |= actual[i] ^ expected[i];
    return diff === 0;
  }
  const simpleHash = s => { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0; return h.toString(16).padStart(8, '0'); };
  const publicTenant = t => (t ? { id: t.id, name: t.name, status: t.status, plan_id: t.plan_id } : null);
  const fail = (status, error, extra) => Object.assign({ ok: false, status, error }, extra || {});
  const NOT_SIGNED_IN = () => fail(401, 'Sign in to continue.');

  /** Local backend: same schema and rules as server.js, kept in localStorage. Demo fallback only. */
  function createLocalBackend({ storage, seed, subtle, ua }) {
    let data;
    const persist = () => { try { storage.setItem(LS_DATA, JSON.stringify(data)); } catch (e) { /* storage full or blocked: keep in memory */ } };
    (function load() {
      try { const raw = storage.getItem(LS_DATA); if (raw) { data = JSON.parse(raw); return; } } catch (e) { /* fall through to seed */ }
      data = JSON.parse(JSON.stringify(seed));
      persist();
    })();
    const userAgent = () => ua || (typeof navigator !== 'undefined' ? navigator.userAgent : '');

    function current() {
      let sid; try { sid = storage.getItem(LS_SESSION); } catch (e) { sid = null; }
      if (!sid) return null;
      const user = data.users.find(u => u.id === sid);
      if (!user) return null;
      const tenant = user.tenant_id ? data.tenants.find(t => t.id === user.tenant_id) || null : null;
      if (Auth.checkLoginEligibility(user, tenant)) return null;
      return { user, tenant, session: { user_id: user.id, tenant_id: user.tenant_id, role: user.role } };
    }
    function record(user, success, reason) {
      const p = Auth.parseUserAgent(userAgent());
      const now = new Date().toISOString();
      data.loginEvents.push({ id: rid('le'), user_id: user.id, tenant_id: user.tenant_id, at: now, ip: 'local', browser: p.browser, os: p.os, device: p.device, success, reason: reason || null });
      if (!success) return;
      const fp = simpleHash(user.id + userAgent());
      let d = data.devices.find(x => x.fingerprint === fp && x.user_id === user.id);
      if (!d) { d = { id: 'dev_' + fp, user_id: user.id, fingerprint: fp, browser: p.browser, os: p.os, device: p.device, first_seen: now, last_seen: now, login_count: 0 }; data.devices.push(d); }
      d.login_count += 1; d.last_seen = now;
    }
    const signIn = user => { try { storage.setItem(LS_SESSION, user.id); } catch (e) { /* ignore */ } };

    return {
      mode: 'local',
      _snapshot: () => JSON.parse(JSON.stringify(data)),
      async login(body) {
        const email = body && typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
        const password = body && typeof body.password === 'string' ? body.password : '';
        if (!email || !password) return fail(400, 'Enter your email and password.');
        const user = data.users.find(u => u.email === email);
        const ok = user ? await verifyPw(subtle, password, user.password_hash) : false;
        if (!ok) { if (user) { record(user, false, 'bad_password'); persist(); } return fail(401, GENERIC_LOGIN_ERROR); }
        const tenant = user.tenant_id ? data.tenants.find(t => t.id === user.tenant_id) || null : null;
        const block = Auth.checkLoginEligibility(user, tenant);
        if (block) { record(user, false, block.code); persist(); return fail(403, block.message, { code: block.code }); }
        record(user, true); signIn(user); persist();
        return { ok: true, status: 200, user: Auth.publicUser(user), tenant: publicTenant(tenant) };
      },
      async register(body) {
        const v = Auth.validateRegistration(body);
        if (!v.ok) return fail(400, 'Check the highlighted fields and try again.', { errors: v.errors });
        const { name, email, password } = v.value;
        if (data.users.some(u => u.email === email)) return fail(409, 'An account with this email already exists. Sign in instead.', { errors: { email: 'This email is already registered.' } });
        const now = new Date().toISOString();
        const user = { id: rid('u'), tenant_id: null, role: 'individual', plan_id: 'free', name, email, password_hash: await hashPw(subtle, password), status: 'active', prefs: { theme: 'light' }, created_at: now, created_by: null };
        const free = data.plans.find(p => p.id === 'free');
        data.users.push(user);
        data.usage.push({ id: 'use_' + user.id, tenant_id: null, user_id: user.id, period: now.slice(0, 7), credits_used: 0, credits_limit: free ? free.credits_per_month : 100 });
        data.auditLog.push({ id: rid('au'), tenant_id: null, actor_id: user.id, actor_name: name, action: 'user.register', target: user.id, at: now, meta: {} });
        record(user, true); signIn(user); persist();
        return { ok: true, status: 201, user: Auth.publicUser(user), tenant: null };
      },
      async logout() { try { storage.removeItem(LS_SESSION); } catch (e) { /* ignore */ } return { ok: true, status: 200 }; },
      async me() {
        const a = current();
        return a ? { ok: true, status: 200, user: Auth.publicUser(a.user), tenant: publicTenant(a.tenant) } : NOT_SIGNED_IN();
      },
      async setPrefs(body) {
        const a = current(); if (!a) return NOT_SIGNED_IN();
        if (!body || !['light', 'dark'].includes(body.theme)) return fail(400, 'Theme must be "light" or "dark".');
        a.user.prefs = Object.assign({}, a.user.prefs, { theme: body.theme }); persist();
        return { ok: true, status: 200, user: Auth.publicUser(a.user) };
      },
      async listFlows() {
        const a = current(); if (!a) return NOT_SIGNED_IN();
        const tName = id => (data.tenants.find(t => t.id === id) || {}).name || null;
        const uName = id => (data.users.find(u => u.id === id) || {}).name || 'Unknown';
        const flows = Ten.scopeFlows(a.session, data.flows).map(f => ({ id: f.id, name: f.name, tenant_id: f.tenant_id, tenant_name: tName(f.tenant_id), owner_id: f.owner_id, owner_name: uName(f.owner_id), shared: !!f.shared, version: f.version, node_count: f.nodes.length, updated_at: f.updated_at }));
        return { ok: true, status: 200, flows };
      },
    };
  }

  /** HTTP backend: thin client for server.js. The cookie carries the session; nothing sensitive is kept in JS. */
  function createHttpBackend(base) {
    async function req(method, p, body) {
      let res;
      try {
        res = await fetch((base || '') + p, { method, credentials: 'same-origin', headers: body !== undefined ? { 'Content-Type': 'application/json' } : {}, body: body !== undefined ? JSON.stringify(body) : undefined });
      } catch (e) {
        return fail(0, 'Cannot reach the AgentFlow server. Check that it is running (node server.js) and try again.');
      }
      let json = {};
      try { json = await res.json(); } catch (e) { /* non-JSON body */ }
      return Object.assign({ ok: res.ok, status: res.status }, json);
    }
    return {
      mode: 'server',
      request: req,
      login: b => req('POST', '/api/auth/login', b),
      register: b => req('POST', '/api/auth/register', b),
      logout: () => req('POST', '/api/auth/logout', {}),
      me: () => req('GET', '/api/auth/me'),
      setPrefs: b => req('PATCH', '/api/auth/prefs', b),
      listFlows: () => req('GET', '/api/flows'),
    };
  }

  /** Every server feature beyond sign-in: [method, path template, kind]. kind: 'body' sends JSON, 'query' adds ?a=b. */
  const ENDPOINTS = {
    listUsers: ['GET', '/api/users', 'query'], createUser: ['POST', '/api/users', 'body'], updateUser: ['PATCH', '/api/users/:id', 'body'],
    deleteUser: ['DELETE', '/api/users/:id', 'query'], resetPassword: ['POST', '/api/users/:id/reset-password', 'body'],
    freezeUser: ['POST', '/api/users/:id/freeze', 'body'], unfreezeUser: ['POST', '/api/users/:id/unfreeze', 'body'],
    listDevices: ['GET', '/api/devices', 'query'], listLoginEvents: ['GET', '/api/login-events', 'query'], getSeats: ['GET', '/api/seats', 'query'],
    listTenants: ['GET', '/api/tenants', 'query'], createTenant: ['POST', '/api/tenants', 'body'], getTenant: ['GET', '/api/tenants/:id', 'query'],
    updateTenant: ['PATCH', '/api/tenants/:id', 'body'], deleteTenant: ['DELETE', '/api/tenants/:id', 'query'],
    freezeTenant: ['POST', '/api/tenants/:id/freeze', 'body'], unfreezeTenant: ['POST', '/api/tenants/:id/unfreeze', 'body'],
    platformStats: ['GET', '/api/stats/platform', 'query'], listInvoices: ['GET', '/api/invoices', 'query'], listPayments: ['GET', '/api/payments', 'query'],
    listAudit: ['GET', '/api/audit', 'query'], exportDb: ['GET', '/api/db/export', 'query'], exportCompany: ['GET', '/api/db/export-company', 'query'],
    importDb: ['POST', '/api/db/import', 'body'], importCompany: ['POST', '/api/db/import-company', 'body'],
    companyStats: ['GET', '/api/stats/company', 'query'], getBilling: ['GET', '/api/billing', 'query'], buySeats: ['POST', '/api/billing/seats', 'body'],
    changePlan: ['POST', '/api/billing/plan', 'body'], payInvoice: ['POST', '/api/billing/invoices/:id/pay', 'body'],
    getFlow: ['GET', '/api/flows/:id', 'query'], createFlow: ['POST', '/api/flows', 'body'], saveFlow: ['PATCH', '/api/flows/:id', 'body'],
    deleteFlow: ['DELETE', '/api/flows/:id', 'query'], duplicateFlow: ['POST', '/api/flows/:id/duplicate', 'body'],
    listTemplates: ['GET', '/api/templates', 'query'], cloneTemplate: ['POST', '/api/templates/:id/clone', 'body'], getUsage: ['GET', '/api/usage', 'query'],
    getAccount: ['GET', '/api/account', 'query'], updateProfile: ['PATCH', '/api/account/profile', 'body'], changePassword: ['POST', '/api/account/password', 'body'],
    startRun: ['POST', '/api/flows/:id/runs', 'body'], listRuns: ['GET', '/api/runs', 'query'], getRun: ['GET', '/api/runs/:id', 'query'], stopRun: ['POST', '/api/runs/:id/stop', 'body'],
    listVersions: ['GET', '/api/flows/:id/versions', 'query'], getVersion: ['GET', '/api/flows/:id/versions/:n', 'query'], restoreVersion: ['POST', '/api/flows/:id/versions/:n/restore', 'body'],
    startImpersonation: ['POST', '/api/impersonation/start', 'body'], endImpersonation: ['POST', '/api/impersonation/end', 'body'],
    myActivity: ['GET', '/api/account/activity', 'query'], saveCustomCards: ['PUT', '/api/account/cards', 'body'], changePersonalPlan: ['POST', '/api/account/plan', 'body'],
  };
  const NEEDS_SERVER = 'This feature needs the AgentFlow server. Start it with "node server.js" (or "PORT=3200 node server.js" if port 3000 is busy) and open the address it prints. Pages opened from VS Code Live Preview or by double-clicking the file have no server behind them.';

  const db = { mode: null, _b: null, createLocalBackend, createHttpBackend, ENDPOINTS };
  Object.entries(ENDPOINTS).forEach(([name, [method, template, kind]]) => {
    db[name] = (...args) => {
      if (!db._b) return Promise.resolve(fail(0, 'Data layer is not ready. Call AF.db.init() first.'));
      if (db._b.mode !== 'server') return Promise.resolve(fail(501, NEEDS_SERVER));
      const path = template.replace(/:[a-z]+/g, () => encodeURIComponent(String(args.shift())));
      const extra = args[0];
      if (kind === 'query') {
        const qs = extra && typeof extra === 'object' ? new URLSearchParams(Object.entries(extra).filter(([, v]) => v !== undefined && v !== null && v !== '')).toString() : '';
        return db._b.request(method, path + (qs ? '?' + qs : ''));
      }
      return db._b.request(method, path, extra === undefined ? {} : extra);
    };
  });
  ['login', 'register', 'logout', 'me', 'setPrefs', 'listFlows'].forEach(name => {
    db[name] = (...args) => {
      if (!db._b) return Promise.resolve(fail(0, 'Data layer is not ready. Call AF.db.init() first.'));
      return db._b[name](...args);
    };
  });

  db.init = async function init() {
    if (db._b) return db;
    const g = typeof self !== 'undefined' ? self : globalThis;
    const isFile = typeof location !== 'undefined' && location.protocol === 'file:';
    if (!isFile && typeof fetch === 'function') {
      try {
        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(), 1500);
        const r = await fetch('/api/health', { signal: ctl.signal });
        clearTimeout(timer);
        if (r.ok) { db._b = createHttpBackend(''); db.mode = 'server'; return db; }
      } catch (e) { /* server unreachable: use the local fallback */ }
    }
    db._b = createLocalBackend({ storage: g.localStorage, seed: g.AF_FALLBACK_SEED, subtle: g.crypto && g.crypto.subtle });
    db.mode = 'local';
    return db;
  };

  return db;
});
