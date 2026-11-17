'use strict';
/* "Login as": a signed-in Super Admin or company Admin views and uses another account without knowing its password.
 * The session keeps the REAL person (user_id) and records the subject (subject_id). Permissions come from the subject,
 * and canImpersonate() is re-run on every request via resolve(), not only when the session starts. */
const Audit = require('./audit.js');

const IMPERSONATION_MS = 30 * 60 * 1000;
const ok = extra => Object.assign({ ok: true, status: 200 }, extra);
const fail = (status, error) => ({ ok: false, status, error });
const DENIED = fail(403, 'You are not allowed to sign in as this account.');

/** May `real` act as `subject`? Returns {ok, frozen} or {ok:false, status, error}. */
function canImpersonate(data, real, subject, opts) {
  if (!subject) return fail(404, 'That account does not exist.');
  if (!real || (opts && opts.chained)) return fail(403, 'Return to your own account before signing in as someone else.');
  if (subject.id === real.id || subject.role === 'superadmin') return DENIED;
  const tenant = subject.tenant_id ? data.tenants.find(t => t.id === subject.tenant_id) : null;
  const frozen = subject.status === 'frozen' || !!(tenant && tenant.status === 'frozen');
  if (real.role === 'superadmin') return ['admin', 'employee'].includes(subject.role) ? ok({ frozen }) : DENIED;
  if (real.role === 'admin') {
    if (subject.role !== 'employee' || !real.tenant_id || subject.tenant_id !== real.tenant_id || frozen) return DENIED;
    return ok({ frozen: false });
  }
  return DENIED;
}

/** Called on every request. {subject:null} = not impersonating; {ended:'expired'|'not_allowed'} = the session must revert. */
function resolve(data, real, session, now) {
  if (!session || !session.subject_id) return { subject: null };
  if (Date.parse(session.imp_expires_at) <= (now == null ? Date.now() : now)) return { subject: null, ended: 'expired' };
  const subject = data.users.find(u => u.id === session.subject_id);
  const c = canImpersonate(data, real, subject);
  if (!c.ok) return { subject: null, ended: 'not_allowed' };
  return { subject, frozen: c.frozen, expires_at: session.imp_expires_at };
}

function audit(data, real, subject, action, ctx, extra) {
  Audit.record(data, { user: real, by: null }, action, subject.id, subject.tenant_id, Object.assign({
    subject_name: subject.name, subject_role: subject.role,
    ip: (ctx && ctx.ip) || null, browser: (ctx && ctx.browser) || null, os: (ctx && ctx.os) || null, device: (ctx && ctx.device) || null,
  }, extra || {}));
}

function begin(data, real, session, subject, ctx, now) {
  const c = canImpersonate(data, real, subject, { chained: !!(session && session.subject_id) });
  if (!c.ok) return c;
  session.subject_id = subject.id;
  session.imp_expires_at = new Date((now == null ? Date.now() : now) + IMPERSONATION_MS).toISOString();
  audit(data, real, subject, 'impersonation.started', ctx, { frozen_account: c.frozen });
  return ok({ frozen: c.frozen, expires_at: session.imp_expires_at });
}

function end(data, real, session, subject, ctx, reason) {
  const sid = session.subject_id;
  delete session.subject_id; delete session.imp_expires_at;
  const who = subject || { id: sid, name: '(deleted account)', role: null, tenant_id: null };
  if (who.id) audit(data, real, who, 'impersonation.ended', ctx, { reason: reason || 'returned' });
}

module.exports = { IMPERSONATION_MS, canImpersonate, resolve, begin, end };
