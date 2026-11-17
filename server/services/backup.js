'use strict';
/* Export / import. Super admin: the whole database (needs password hashes to be restorable, so the file is sensitive).
 * Company admin: their own company's flows only; client-supplied ids and tenant ids are never trusted.
 * Imported JSON is treated as hostile: every entry is checked, dangerous keys are stripped, the live data is never mutated. */
const Sec = require('../security.js');
const Audit = require('./audit.js');
const Flows = require('./flows.js');
const MAX_IMPORT_BYTES = 5 * 1048576;
const Auth = require('../../assets/js/auth.js');

const ok = (status, extra) => Object.assign({ ok: true, status }, extra);
const fail = (status, error) => ({ ok: false, status, error });
const COLLECTIONS = ['tenants', 'users', 'sessions', 'devices', 'loginEvents', 'plans', 'subscriptions', 'invoices', 'payments',
  'flows', 'flowVersions', 'runs', 'runSteps', 'templates', 'usage', 'auditLog', 'presence', 'locks'];
const NO_ID = ['sessions', 'presence', 'locks'];
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const MAX_IMPORTED_FLOWS = 200;
const MAX_TENANT_FLOWS = 500;
const MAX_NODES = 200;
const MAX_EDGES = 400;
const iso = () => new Date().toISOString();
const plain = v => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Deep copy that drops prototype-polluting keys. */
function cleanse(v) {
  if (Array.isArray(v)) return v.map(cleanse);
  if (plain(v)) { const o = {}; for (const k of Object.keys(v)) if (!FORBIDDEN_KEYS.has(k)) o[k] = cleanse(v[k]); return o; }
  return v;
}

function exportAll(data, actor) {
  if (actor.user.role !== 'superadmin') return fail(403, 'Only the super admin can export the whole database.');
  Audit.record(data, actor, 'db.export', 'database', null, {});
  const copy = {}; for (const c of COLLECTIONS) copy[c] = c === 'sessions' ? [] : cleanse(data[c] || []);
  return ok(200, { bundle: { format: 'agentflow-db', version: 1, exported_at: iso(), data: copy } });
}

/** Returns an error message for the first problem found, or null. */
function checkWholeDb(incoming, actor) {
  const missing = COLLECTIONS.filter(c => c !== 'sessions' && !Array.isArray(incoming[c]));
  if (missing.length) return 'The file is missing these collections: ' + missing.join(', ') + '. Export a fresh copy and try again.';
  for (const c of COLLECTIONS) {
    if (c === 'sessions' || !Array.isArray(incoming[c])) continue;
    const seen = new Set();
    for (const row of incoming[c]) {
      if (!plain(row)) return `The file has a broken entry in "${c}" (not an object). Nothing was imported.`;
      if (NO_ID.includes(c)) continue;
      if (typeof row.id !== 'string' || !row.id) return `The file has an entry in "${c}" without an id. Nothing was imported.`;
      if (seen.has(row.id)) return `The file has two entries with the id "${row.id}" in "${c}". Nothing was imported.`;
      seen.add(row.id);
    }
  }
  const tenantIds = new Set(incoming.tenants.map(t => t.id));
  for (const u of incoming.users) {
    if (typeof u.email !== 'string' || !Auth.ROLES.includes(u.role) || typeof u.password_hash !== 'string' || !u.password_hash) return `The account "${u.id}" in the file is incomplete (needs email, role and password hash). Nothing was imported.`;
    if (u.tenant_id != null && !tenantIds.has(u.tenant_id)) return `The account "${u.id}" belongs to a company that is not in the file. Nothing was imported.`;
  }
  for (const f of incoming.flows) if (f.tenant_id != null && !tenantIds.has(f.tenant_id)) return `The flow "${f.id}" belongs to a company that is not in the file. Nothing was imported.`;
  const self = incoming.users.find(u => u.id === actor.user.id && u.role === 'superadmin' && u.status !== 'frozen');
  if (!self) return 'The import must contain your own super admin account, otherwise you would be signed out and could not continue.';
  return null;
}

function importAll(data, actor, bundle) {
  if (actor.user.role !== 'superadmin') return fail(403, 'Only the super admin can import the whole database.');
  if (!plain(bundle) || bundle.format !== 'agentflow-db' || bundle.version !== 1 || !plain(bundle.data)) return fail(400, 'This is not an AgentFlow database export. Choose a file created with "Export database".');
  const problem = checkWholeDb(bundle.data, actor);
  if (problem) return fail(400, problem);
  const next = {}; for (const c of COLLECTIONS) next[c] = cleanse(Array.isArray(bundle.data[c]) ? bundle.data[c] : []);
  const live = new Set(next.users.map(u => u.id));
  next.sessions = (data.sessions || []).filter(s => live.has(s.user_id)).map(s => cleanse(s));
  return ok(200, { data: next });
}

function exportTenant(data, actor) {
  if (actor.user.role !== 'admin' || !actor.user.tenant_id) return fail(403, 'Only company admins can export their company data.');
  Audit.record(data, actor, 'flows.export', actor.user.tenant_id, actor.user.tenant_id, {});
  const t = actor.user.tenant_id; const own = list => cleanse((data[list] || []).filter(x => x.tenant_id === t));
  const tenant = data.tenants.find(x => x.id === t) || { id: t, name: '' };
  return ok(200, { bundle: { format: 'agentflow-tenant', version: 1, exported_at: iso(), tenant: { id: tenant.id, name: tenant.name }, data: { flows: own('flows'), flowVersions: own('flowVersions'), runs: own('runs'), runSteps: own('runSteps'), templates: own('templates') } } });
}

function importTenant(data, actor, bundle) {
  if (actor.user.role !== 'admin' || !actor.user.tenant_id) return fail(403, 'Only company admins can import company data.');
  if (!plain(bundle) || bundle.format !== 'agentflow-tenant' || bundle.version !== 1 || !plain(bundle.data) || !Array.isArray(bundle.data.flows)) return fail(400, 'This is not an AgentFlow company export. Choose a file created with "Export company data".');
  const flows = bundle.data.flows.filter(f => plain(f) && Array.isArray(f.nodes) && Array.isArray(f.edges)).slice(0, MAX_IMPORTED_FLOWS);
  if (!flows.length) return fail(400, 'The file has no flows to import.');
  for (const f of flows) {
    if (f.nodes.length > MAX_NODES || f.edges.length > MAX_EDGES) return fail(400, `A flow in the file is too large (limit ${MAX_NODES} cards and ${MAX_EDGES} connections). Nothing was imported.`);
    if (!f.nodes.every(n => plain(n) && typeof n.id === 'string') || !f.edges.every(e => plain(e))) return fail(400, 'A flow in the file has broken cards or connections. Nothing was imported.');
  }
  if (JSON.stringify(flows).length > MAX_IMPORT_BYTES) return fail(413, 'This file is too large to import (limit 5 MB of flows). Split it into smaller exports.');
  const cleaned = [];
  for (const f of flows) {
    const g = Flows.cleanGraph(f.nodes, f.edges);
    if (g.error) return fail(400, `A flow in the file is not valid: ${g.error} Nothing was imported.`);
    cleaned.push(g);
  }
  const t = actor.user.tenant_id;
  if (data.flows.filter(f => f.tenant_id === t).length + flows.length > MAX_TENANT_FLOWS) return fail(409, `Importing would take the company above ${MAX_TENANT_FLOWS} flows. Delete flows you no longer need first.`);
  const now = iso(); const taken = new Set(data.flows.filter(f => f.tenant_id === t).map(f => f.name));
  let imported = 0;
  for (const [fi, f] of flows.entries()) {
    let name = typeof f.name === 'string' && f.name.trim() ? f.name.trim().slice(0, 120) : 'Imported flow';
    while (taken.has(name)) name += ' (imported)';
    taken.add(name);
    const id = Sec.newId('f'); const nodes = cleaned[fi].nodes; const edges = cleaned[fi].edges;
    data.flows.push({ id, tenant_id: t, owner_id: actor.user.id, name, nodes, edges, version: 1, shared: false, created_at: now, updated_at: now, imported_at: now });
    data.flowVersions.push({ id: id + '_v1', flow_id: id, tenant_id: t, n: 1, user_id: actor.user.id, user_name: actor.user.name, ...Audit.attribution(actor), at: now, summary: 'Imported from a company export', snapshot: { name, nodes: cleanse(nodes), edges: cleanse(edges) } });
    imported += 1;
  }
  Audit.record(data, actor, 'flows.import', t, t, { count: imported });
  return ok(200, { imported });
}

module.exports = { exportAll, importAll, exportTenant, importTenant, COLLECTIONS };
