'use strict';
/* Read-only money and audit views: invoices, payments, audit log. Super admin sees all, company admins only their own company. */
const ok = (status, extra) => Object.assign({ ok: true, status }, extra);
const fail = (status, error) => ({ ok: false, status, error });

const canSee = actor => actor.user.role === 'superadmin' || (actor.user.role === 'admin' && !!actor.user.tenant_id);
const DENIED = () => fail(403, 'Only company admins and the super admin can see billing and audit records.');
const mine = (actor, rec) => actor.user.role === 'superadmin' || (rec.tenant_id && rec.tenant_id === actor.user.tenant_id);
const tenantName = (data, id) => (data.tenants.find(t => t.id === id) || {}).name || null;

function listInvoices(data, actor) {
  if (!canSee(actor)) return DENIED();
  const invoices = data.invoices.filter(i => mine(actor, i)).map(i => Object.assign({}, i, { tenant_name: tenantName(data, i.tenant_id) }))
    .sort((a, b) => (b.issued_at > a.issued_at ? 1 : -1));
  return ok(200, { invoices });
}

function listPayments(data, actor) {
  if (!canSee(actor)) return DENIED();
  const numbers = new Map(data.invoices.map(i => [i.id, i.number]));
  const payments = data.payments.filter(p => mine(actor, p)).map(p => Object.assign({}, p, { tenant_name: tenantName(data, p.tenant_id), invoice_number: numbers.get(p.invoice_id) || null }))
    .sort((a, b) => (b.created_at > a.created_at ? 1 : -1));
  return ok(200, { payments });
}

function listAudit(data, actor, query) {
  if (!canSee(actor)) return DENIED();
  const q = query && typeof query === 'object' ? query : {};
  const limit = Math.min(1000, Math.max(1, parseInt(q.limit, 10) || 200));
  const entries = data.auditLog
    .filter(e => mine(actor, e) && (!q.action || e.action === q.action) && (!q.actor_id || e.actor_id === q.actor_id))
    .sort((a, b) => (b.at > a.at ? 1 : -1)).slice(0, limit)
    .map(e => Object.assign({}, e, { tenant_name: tenantName(data, e.tenant_id) }));
  const actions = [...new Set(data.auditLog.filter(e => mine(actor, e)).map(e => e.action))].sort();
  return ok(200, { entries, actions });
}

module.exports = { listInvoices, listPayments, listAudit };
