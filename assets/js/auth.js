/* AgentFlow shared auth rules. UMD: runs in the browser (AF.auth) and in Node (server + tests).
 * Single source of truth for validation, roles, permissions and login eligibility. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else { root.AF = root.AF || {}; root.AF.auth = factory(); }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const ROLES = ['superadmin', 'admin', 'employee', 'individual'];

  const PERMISSIONS = {
    superadmin: ['tenants.manage', 'users.manage', 'billing.view_all', 'audit.view_all', 'db.export', 'db.import', 'flows.read_all'],
    admin: ['users.manage', 'billing.manage', 'audit.view', 'flows.read', 'flows.write', 'runs.execute', 'db.export_tenant'],
    employee: ['flows.read', 'flows.write', 'runs.execute'],
    individual: ['flows.read', 'flows.write', 'runs.execute'],
  };

  const ROLE_HOME = {
    superadmin: 'super/dashboard.html',
    admin: 'admin/dashboard.html',
    employee: 'app/flows.html',
    individual: 'app/flows.html',
  };

  function can(role, permission) {
    return Object.prototype.hasOwnProperty.call(PERMISSIONS, role) && PERMISSIONS[role].includes(permission);
  }

  /** Where a role lands after login. `built` lists pages that already exist (removed in the last phase). */
  function homeFor(role, built) {
    const home = ROLE_HOME[role] || 'app/flows.html';
    return !built || built.includes(home) ? home : 'app/flows.html';
  }

  function parseUserAgent(ua) {
    const unknown = { browser: 'Unknown', os: 'Unknown', device: 'Unknown' };
    if (typeof ua !== 'string' || !ua.trim()) return unknown;
    let browser = 'Unknown', m;
    if ((m = ua.match(/Edg(?:e|A|iOS)?\/(\d+)/))) browser = 'Edge ' + m[1];
    else if ((m = ua.match(/OPR\/(\d+)/))) browser = 'Opera ' + m[1];
    else if ((m = ua.match(/Firefox\/(\d+)/)) || (m = ua.match(/FxiOS\/(\d+)/))) browser = 'Firefox ' + m[1];
    else if ((m = ua.match(/(?:Chrome|CriOS)\/(\d+)/))) browser = 'Chrome ' + m[1];
    else if ((m = ua.match(/Version\/(\d+)[^]*Safari/))) browser = 'Safari ' + m[1];
    let os = 'Unknown';
    if (/Windows NT/.test(ua)) os = 'Windows';
    else if (/iPhone|iPad|iPod/.test(ua)) os = 'iOS';
    else if (/Android/.test(ua)) os = 'Android';
    else if (/Mac OS X/.test(ua)) os = 'macOS';
    else if (/Linux|X11/.test(ua)) os = 'Linux';
    let device = 'Desktop';
    if (/iPad|Tablet/.test(ua) || (/Android/.test(ua) && !/Mobile/.test(ua))) device = 'Tablet';
    else if (/iPhone|iPod|Mobile/.test(ua)) device = 'Mobile';
    return { browser, os, device };
  }

  function validateEmail(s) {
    return typeof s === 'string' && s.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s);
  }

  /** Returns null when valid, otherwise a message that says how to fix it. */
  function validatePassword(p) {
    if (typeof p !== 'string' || !p) return 'Enter a password.';
    if (p.length < 8) return 'Use at least 8 characters.';
    if (p.length > 128) return 'Password is too long (max 128 characters).';
    if (!/[A-Za-z]/.test(p) || !/\d/.test(p)) return 'Include at least one letter and a number.';
    return null;
  }

  function validateRegistration(input) {
    const src = input && typeof input === 'object' ? input : {};
    const name = typeof src.name === 'string' ? src.name.trim() : '';
    const email = typeof src.email === 'string' ? src.email.trim().toLowerCase() : '';
    const password = typeof src.password === 'string' ? src.password : '';
    const errors = {};
    if (!name || name.length > 80) errors.name = 'Enter your name (up to 80 characters).';
    if (!validateEmail(email)) errors.email = 'Enter a valid email address, like name@company.com.';
    const pe = validatePassword(password);
    if (pe) errors.password = pe;
    return Object.keys(errors).length ? { ok: false, errors } : { ok: true, value: { name, email, password } };
  }

  /** null when the user may sign in, otherwise {code, message}. */
  function checkLoginEligibility(user, tenant) {
    if (user && user.status === 'frozen') {
      return { code: 'user_frozen', message: 'This account is frozen. Ask your company admin (or AgentFlow support) to unfreeze it, then sign in again.' };
    }
    if (tenant && tenant.status === 'frozen') {
      return { code: 'tenant_frozen', message: tenant.name + ' is frozen, so nobody from the company can sign in. Contact your company admin or AgentFlow support to restore access.' };
    }
    return null;
  }

  function publicUser(u) {
    if (!u) return null;
    return { id: u.id, name: u.name, email: u.email, role: u.role, tenant_id: u.tenant_id == null ? null : u.tenant_id, status: u.status, prefs: u.prefs || {} };
  }

  return { ROLES, PERMISSIONS, ROLE_HOME, can, homeFor, parseUserAgent, validateEmail, validatePassword, validateRegistration, checkLoginEligibility, publicUser };
});
