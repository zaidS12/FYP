/* AgentFlow tenant isolation rules. UMD: browser (AF.tenancy), server and tests.
 * A session is {user_id, tenant_id, role}; it always comes from the server-side session, never the client. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else { root.AF = root.AF || {}; root.AF.tenancy = factory(); }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const COMPANY_ROLES = ['admin', 'employee'];

  /** Can this session see this record? Unknown roles and tenant-less company users see nothing. */
  function canAccess(session, record) {
    if (!session || !record) return false;
    if (session.role === 'superadmin') return true;
    if (COMPANY_ROLES.includes(session.role)) {
      return session.tenant_id != null && record.tenant_id === session.tenant_id;
    }
    if (session.role === 'individual') {
      return record.tenant_id == null && record.owner_id === session.user_id;
    }
    return false;
  }

  function scope(session, records) {
    if (!session || !Array.isArray(records)) return [];
    return records.filter(r => canAccess(session, r));
  }

  /** Flows add one rule: a colleague's private (not shared) flow is visible only to its owner and company admins. */
  function canAccessFlow(session, flow) {
    if (!canAccess(session, flow)) return false;
    if (session.role === 'employee') return !!flow.shared || flow.owner_id === session.user_id;
    return true;
  }
  const scopeFlows = (session, flows) => (Array.isArray(flows) ? flows.filter(f => canAccessFlow(session, f)) : []);

  /** Copy of `record` stamped with ownership from the session. Any client-sent tenant_id is overwritten. */
  function stamp(session, record) {
    return Object.assign({}, record, {
      tenant_id: session.tenant_id == null ? null : session.tenant_id,
      owner_id: session.user_id,
    });
  }

  return { canAccess, scope, canAccessFlow, scopeFlows, stamp };
});
