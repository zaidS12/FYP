'use strict';
/* One place that writes audit rows, so impersonation is attributed the same way everywhere.
 * `actor` = {user, by}: `user` is the account whose permissions apply (the subject while impersonating),
 * `by` is the real signed-in person when they are acting as someone else, otherwise null. */
const Sec = require('../security.js');

/** Extra fields for versions and runs created while impersonating: {by_id, by_name}, or {} normally. */
function attribution(actor) {
  return actor && actor.by ? { by_id: actor.by.id, by_name: actor.by.name } : {};
}

function record(data, actor, action, target, tenantId, meta) {
  const m = Object.assign({}, meta || {});
  let actorId = actor.user.id; let actorName = actor.user.name;
  if (actor.by) {
    actorId = actor.by.id; actorName = `${actor.by.name} acting as ${actor.user.name}`;
    m.acting_as = { id: actor.user.id, name: actor.user.name };
  }
  data.auditLog.push({ id: Sec.newId('au'), tenant_id: tenantId == null ? null : tenantId, actor_id: actorId, actor_name: actorName, action, target, at: new Date().toISOString(), meta: m });
}

module.exports = { record, attribution };
