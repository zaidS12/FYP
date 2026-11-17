'use strict';
/* Flows: list, open, create, save (with versions and conflict detection), share, delete, duplicate, templates.
 * Visibility comes from tenancy.js; who may edit/manage is decided here. Graph input is validated and rebuilt, never stored as sent. */
const Auth = require('../../assets/js/auth.js');
const Ten = require('../../assets/js/tenancy.js');
const Versions = require('../../assets/js/versions.js');
const Sec = require('../security.js');
const Audit = require('./audit.js');
const Merge = require('./merge.js');

const ok = (status, extra) => Object.assign({ ok: true, status }, extra);
const fail = (status, error, extra) => Object.assign({ ok: false, status, error }, extra || {});
const iso = () => new Date().toISOString();
const plain = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const MAX_NODES = 200, MAX_EDGES = 400, MAX_NAME = 120, MAX_CONFIG_BYTES = 20000;
const ID_RE = /^[A-Za-z0-9_-]{1,40}$/, TYPE_RE = /^[a-z][a-z0-9_]{0,39}$/;
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
/** Deep copy that drops prototype-polluting keys wherever they appear. */
const clone = x => JSON.parse(JSON.stringify(x), (k, v) => (FORBIDDEN_KEYS.has(k) ? undefined : v));
const MAX_VERSIONS_PER_FLOW = 200, MAX_FLOWS_INDIVIDUAL = 50, MAX_FLOWS_TENANT = 500;
const num = v => typeof v === 'number' && isFinite(v) && Math.abs(v) <= 100000;

const audit = (data, actor, action, target, meta) => Audit.record(data, actor, action, target, actor.user.tenant_id || null, meta);

/** Returns {nodes, edges} rebuilt from trusted fields, or {error}. */
function cleanGraph(nodes, edges) {
  if (!Array.isArray(nodes) || !Array.isArray(edges)) return { error: 'A flow needs a list of cards and a list of connections.' };
  if (nodes.length > MAX_NODES) return { error: `A flow can have at most ${MAX_NODES} cards.` };
  if (edges.length > MAX_EDGES) return { error: `A flow can have at most ${MAX_EDGES} connections.` };
  const ids = new Set(); const outNodes = [];
  for (const n of nodes) {
    if (!plain(n)) return { error: 'One of the cards is broken (not an object).' };
    if (typeof n.id !== 'string' || !ID_RE.test(n.id)) return { error: 'Every card needs an id of letters, numbers, "-" or "_".' };
    if (ids.has(n.id)) return { error: `Two cards share the id "${n.id}". Card ids must be unique.` };
    if (typeof n.type !== 'string' || !TYPE_RE.test(n.type)) return { error: `The card "${n.id}" has an invalid type.` };
    if (!num(n.x) || !num(n.y)) return { error: `The card "${n.id}" has an invalid position.` };
    const label = typeof n.label === 'string' ? n.label.slice(0, 80) : n.id;
    const config = n.config === undefined ? {} : n.config;
    if (!plain(config) || JSON.stringify(config).length > MAX_CONFIG_BYTES) return { error: `The settings of card "${n.id}" are invalid or too large.` };
    if (n.base !== undefined && (typeof n.base !== 'string' || !TYPE_RE.test(n.base))) return { error: `The card "${n.id}" has an invalid base type.` };
    ids.add(n.id);
    const out = { id: n.id, type: n.type, label, x: n.x, y: n.y, config: clone(config) };
    if (n.base) out.base = n.base;
    outNodes.push(out);
  }
  const outEdges = []; const edgeIds = new Set();
  for (const e of edges) {
    if (!plain(e) || typeof e.id !== 'string' || !ID_RE.test(e.id)) return { error: 'Every connection needs an id.' };
    if (edgeIds.has(e.id)) return { error: `Two connections share the id "${e.id}".` };
    if (!ids.has(e.from) || !ids.has(e.to)) return { error: 'A connection points at a card that is not in the flow.' };
    const port = p => (typeof p === 'string' && p.length <= 20 ? p : undefined);
    edgeIds.add(e.id);
    outEdges.push({ id: e.id, from: e.from, fromPort: port(e.fromPort) || 'out', to: e.to, toPort: port(e.toPort) || 'in' });
  }
  return { nodes: outNodes, edges: outEdges };
}

function cleanName(v) {
  const name = typeof v === 'string' ? v.trim() : '';
  return !name || name.length > MAX_NAME ? null : name;
}

const canWrite = actor => Auth.can(actor.user.role, 'flows.write');
const visible = (data, actor, id) => { const f = data.flows.find(x => x.id === id); return f && Ten.canAccessFlow(actor.session, f) ? f : null; };
const canEdit = (actor, f) => actor.user.role !== 'superadmin' && Ten.canAccessFlow(actor.session, f);
const canManage = (actor, f) => actor.user.role !== 'superadmin' && Ten.canAccessFlow(actor.session, f) && (f.owner_id === actor.user.id || actor.user.role === 'admin');
const NOT_FOUND = () => fail(404, 'No such flow.');
const NO_WRITE = () => fail(403, 'Super admins can look at flows but cannot create or change them.');

function summary(data, actor, f) {
  const t = f.tenant_id ? data.tenants.find(x => x.id === f.tenant_id) : null; const o = data.users.find(u => u.id === f.owner_id);
  return { id: f.id, name: f.name, tenant_id: f.tenant_id, tenant_name: t ? t.name : null, owner_id: f.owner_id, owner_name: o ? o.name : 'Unknown', shared: !!f.shared, version: f.version,
    node_count: f.nodes.length, edge_count: f.edges.length, updated_at: f.updated_at, can_edit: canEdit(actor, f), can_manage: canManage(actor, f) };
}

function listFlows(data, actor) {
  const flows = Ten.scopeFlows(actor.session, data.flows).map(f => summary(data, actor, f)).sort((a, b) => (b.updated_at > a.updated_at ? 1 : -1));
  return ok(200, { flows });
}

function getFlow(data, actor, id) {
  const f = visible(data, actor, id); if (!f) return NOT_FOUND();
  return ok(200, { flow: clone(f), can_edit: canEdit(actor, f), can_manage: canManage(actor, f) });
}

/** null when the person may add another flow, otherwise a 409 explaining the limit. */
function flowQuota(data, actor) {
  const t = actor.user.tenant_id;
  const used = t ? data.flows.filter(f => f.tenant_id === t).length : data.flows.filter(f => f.tenant_id == null && f.owner_id === actor.user.id).length;
  const max = t ? MAX_FLOWS_TENANT : MAX_FLOWS_INDIVIDUAL;
  return used >= max ? fail(409, `You can keep up to ${max} flows${t ? ' in a company' : ''}. Delete flows you no longer need first.`) : null;
}

function makeFlow(data, actor, { name, nodes, edges, summaryText }) {
  const now = iso(); const id = Sec.newId('f');
  const flow = Object.assign(Ten.stamp(actor.session, { id, name, nodes, edges, version: 1, shared: false, created_at: now, updated_at: now }));
  data.flows.push(flow);
  data.flowVersions.push({ id: id + '_v1', flow_id: id, tenant_id: flow.tenant_id, n: 1, user_id: actor.user.id, user_name: actor.user.name, ...Audit.attribution(actor), at: now, summary: summaryText, snapshot: { name, nodes: clone(nodes), edges: clone(edges) } });
  return flow;
}

function createFlow(data, actor, input) {
  if (!canWrite(actor)) return NO_WRITE();
  const src = plain(input) ? input : {};
  const name = cleanName(src.name);
  if (!name) return fail(400, `Give the flow a name (1 to ${MAX_NAME} characters).`, { errors: { name: `Enter a name up to ${MAX_NAME} characters.` } });
  const quota = flowQuota(data, actor); if (quota) return quota;
  const graph = src.nodes === undefined && src.edges === undefined
    ? { nodes: [{ id: 'n1', type: 'start', label: 'Start', x: 80, y: 160, config: {} }, { id: 'n2', type: 'end', label: 'End', x: 380, y: 160, config: {} }], edges: [{ id: 'e1', from: 'n1', fromPort: 'out', to: 'n2', toPort: 'in' }] }
    : cleanGraph(src.nodes, src.edges);
  if (graph.error) return fail(400, graph.error);
  const flow = makeFlow(data, actor, { name, nodes: graph.nodes, edges: graph.edges, summaryText: 'Created flow' });
  audit(data, actor, 'flow.create', flow.id, { name });
  return ok(201, { flow: clone(flow) });
}

/** Applies `next` to the flow as its newest version. History is append-only (old versions beyond the cap are dropped, never edited). */
function appendVersion(data, actor, f, next, text, extra) {
  const n = f.version + 1; const now = iso();
  Object.assign(f, next, { version: n, updated_at: now });
  data.flowVersions.push(Object.assign({ id: `${f.id}_v${n}`, flow_id: f.id, tenant_id: f.tenant_id, n, user_id: actor.user.id, user_name: actor.user.name }, Audit.attribution(actor), { at: now, summary: text, snapshot: clone(next) }, extra || {}));
  const mine = data.flowVersions.filter(v => v.flow_id === f.id);
  if (mine.length > MAX_VERSIONS_PER_FLOW) {
    const drop = new Set(mine.sort((a, b) => a.n - b.n).slice(0, mine.length - MAX_VERSIONS_PER_FLOW).map(v => v.id));
    data.flowVersions = data.flowVersions.filter(v => !drop.has(v.id));
  }
  return { n, summary: text };
}

function saveFlow(data, actor, id, patch) {
  const f = visible(data, actor, id); if (!f) return NOT_FOUND();
  if (actor.user.role === 'superadmin') return NO_WRITE();
  const src = plain(patch) ? patch : {};
  const wantsGraph = src.name !== undefined || src.nodes !== undefined || src.edges !== undefined;
  if (!wantsGraph && src.shared === undefined) return fail(400, 'Nothing to save. Send a name, the cards and connections, or the sharing setting.');
  if (src.shared !== undefined) {
    if (typeof src.shared !== 'boolean') return fail(400, 'Sharing must be true or false.');
    if (!canManage(actor, f)) return fail(403, 'Only the owner or a company admin can change who can see this flow.');
  }
  if (wantsGraph && !canEdit(actor, f)) return fail(403, 'You cannot edit this flow.');
  if (wantsGraph && !Number.isInteger(src.base_version)) return fail(400, 'Send base_version (the version you opened) with every change, so work is never overwritten by accident.', { errors: { base_version: 'Required.' } });
  const stale = wantsGraph && src.base_version !== f.version;
  const STALE = extra => fail(409, 'Someone saved this flow after you opened it. Review their changes before saving.', Object.assign({ code: 'conflict', flow: clone(f) }, extra || {}));
  if (stale && src.base_version > f.version) return STALE();
  let next = null;
  if (wantsGraph) {
    const name = src.name === undefined ? f.name : cleanName(src.name);
    if (!name) return fail(400, `Give the flow a name (1 to ${MAX_NAME} characters).`, { errors: { name: `Enter a name up to ${MAX_NAME} characters.` } });
    const graph = cleanGraph(src.nodes === undefined ? f.nodes : src.nodes, src.edges === undefined ? f.edges : src.edges);
    if (graph.error) return fail(400, graph.error);
    next = { name, nodes: graph.nodes, edges: graph.edges };
  }
  let merged = false;
  if (stale) {   // someone saved in between: merge card by card, or report exactly which cards clash
    const baseV = data.flowVersions.find(v => v.flow_id === f.id && v.n === src.base_version);
    if (!baseV) return STALE();
    const m = Merge.mergeGraph(baseV.snapshot, next, { name: f.name, nodes: f.nodes, edges: f.edges });
    if (!m.ok) return STALE({ conflicts: m.conflicts });
    const clean = cleanGraph(m.merged.nodes, m.merged.edges);
    const starts = m.merged.nodes.filter(n => n.type === 'start').length;
    if (clean.error || starts > 1) return STALE({ conflicts: [{ node_id: null, label: 'Merged flow', reason: clean.error || 'Both of you added a Start card, and a flow can only have one.' }] });
    next = { name: m.merged.name, nodes: clean.nodes, edges: clean.edges }; merged = true;
  }
  let version = null;
  if (next && JSON.stringify({ name: f.name, nodes: f.nodes, edges: f.edges }) !== JSON.stringify(next)) {
    const text = typeof src.summary === 'string' && src.summary.trim() ? src.summary.trim().slice(0, 200) : (merged ? `Merged with version ${f.version}: ` : '') + Versions.summarizeChange({ name: f.name, nodes: f.nodes, edges: f.edges }, next);
    version = appendVersion(data, actor, f, next, text);
  }
  if (src.shared !== undefined && src.shared !== !!f.shared) { f.shared = src.shared; f.updated_at = iso(); audit(data, actor, 'flow.share', f.id, { shared: f.shared }); }
  return ok(200, { flow: clone(f), version, merged });
}

const versionRow = v => ({ n: v.n, user_id: v.user_id, user_name: v.user_name, by_id: v.by_id || null, by_name: v.by_name || null, at: v.at, summary: v.summary, restored_from: v.restored_from || null });

function listVersions(data, actor, flowId) {
  const f = visible(data, actor, flowId); if (!f) return NOT_FOUND();
  const versions = data.flowVersions.filter(v => v.flow_id === f.id).sort((a, b) => b.n - a.n).map(versionRow);
  return ok(200, { versions, current: f.version, can_edit: canEdit(actor, f) });
}

function findVersion(data, f, n) {
  const num = typeof n === 'string' && /^\d+$/.test(n) ? Number(n) : n;
  if (!Number.isInteger(num) || num < 1) return { error: fail(400, 'Version numbers are whole numbers, like 3.') };
  const v = data.flowVersions.find(x => x.flow_id === f.id && x.n === num);
  return v ? { v } : { error: fail(404, 'That version is not in the history any more (very old versions are removed after 200 saves).') };
}

function getVersion(data, actor, flowId, n) {
  const f = visible(data, actor, flowId); if (!f) return NOT_FOUND();
  const r = findVersion(data, f, n); if (r.error) return r.error;
  return ok(200, { version: Object.assign(versionRow(r.v), { snapshot: clone(r.v.snapshot) }) });
}

/** One-click restore: the old content becomes a NEW version on top; nothing in the history is rewritten. */
function restoreVersion(data, actor, flowId, n, input) {
  const f = visible(data, actor, flowId); if (!f) return NOT_FOUND();
  if (actor.user.role === 'superadmin') return NO_WRITE();
  if (!canEdit(actor, f)) return fail(403, 'You cannot edit this flow.');
  const src = plain(input) ? input : {};
  if (!Number.isInteger(src.base_version)) return fail(400, 'Send base_version (the version you have open) so a restore never overwrites newer work by accident.');
  if (src.base_version !== f.version) return fail(409, 'Someone saved this flow after you opened it. Reload the history and try again.', { code: 'conflict', flow: clone(f) });
  const r = findVersion(data, f, n); if (r.error) return r.error;
  const snap = clone(r.v.snapshot);
  const current = { name: f.name, nodes: f.nodes, edges: f.edges };
  if (JSON.stringify(current) === JSON.stringify(snap)) return fail(400, `Version ${r.v.n} is the same as the current flow, so there is nothing to restore.`);
  const detail = Versions.summarizeChange(current, snap);
  const text = `Restored version ${r.v.n}: ${detail}`.slice(0, 200);
  const version = appendVersion(data, actor, f, { name: snap.name, nodes: snap.nodes, edges: snap.edges }, text, { restored_from: r.v.n });
  audit(data, actor, 'flow.restore', f.id, { from_version: r.v.n, new_version: version.n });
  return ok(200, { flow: clone(f), version });
}

function deleteFlow(data, actor, id) {
  const f = visible(data, actor, id); if (!f) return NOT_FOUND();
  if (actor.user.role === 'superadmin') return NO_WRITE();
  if (!canManage(actor, f)) return fail(403, 'Only the owner or a company admin can delete this flow.');
  const runIds = new Set(data.runs.filter(r => r.flow_id === id).map(r => r.id));
  data.flows = data.flows.filter(x => x.id !== id);
  data.flowVersions = data.flowVersions.filter(v => v.flow_id !== id);
  data.runs = data.runs.filter(r => r.flow_id !== id);
  data.runSteps = data.runSteps.filter(s => !runIds.has(s.run_id));
  data.presence = data.presence.filter(p => p.flow_id !== id);
  data.locks = data.locks.filter(l => l.flow_id !== id);
  audit(data, actor, 'flow.delete', id, { name: f.name });
  return ok(200, { deleted: id });
}

function duplicateFlow(data, actor, id) {
  const f = visible(data, actor, id); if (!f) return NOT_FOUND();
  if (!canWrite(actor)) return NO_WRITE();
  const quota = flowQuota(data, actor); if (quota) return quota;
  const name = (f.name + ' (copy)').slice(0, MAX_NAME);
  const copy = makeFlow(data, actor, { name, nodes: clone(f.nodes), edges: clone(f.edges), summaryText: `Duplicated from "${f.name}"` });
  audit(data, actor, 'flow.duplicate', copy.id, { from: f.id });
  return ok(201, { flow: clone(copy) });
}

function visibleTemplates(data, actor) {
  return data.templates.filter(t => t.tenant_id == null || (actor.user.tenant_id && t.tenant_id === actor.user.tenant_id));
}

function listTemplates(data, actor) {
  const templates = visibleTemplates(data, actor).map(t => ({ id: t.id, name: t.name, description: t.description, category: t.category, node_count: t.nodes.length, edge_count: t.edges.length, scope: t.tenant_id ? 'company' : 'global', nodes: t.nodes.map(n => ({ type: n.type, label: n.label })) }));
  return ok(200, { templates });
}

function cloneTemplate(data, actor, templateId, input) {
  if (!canWrite(actor)) return NO_WRITE();
  const t = visibleTemplates(data, actor).find(x => x.id === templateId);
  if (!t) return fail(404, 'No such template.');
  const quota = flowQuota(data, actor); if (quota) return quota;
  const src = plain(input) ? input : {};
  const name = src.name === undefined || src.name === '' ? t.name : cleanName(src.name);
  if (!name) return fail(400, `Give the flow a name (1 to ${MAX_NAME} characters).`, { errors: { name: `Enter a name up to ${MAX_NAME} characters.` } });
  const graph = cleanGraph(clone(t.nodes), clone(t.edges));
  if (graph.error) return fail(500, 'This template is damaged. Tell your admin.');
  const flow = makeFlow(data, actor, { name, nodes: graph.nodes, edges: graph.edges, summaryText: `Created from template "${t.name}"` });
  audit(data, actor, 'flow.create', flow.id, { name, template: t.id });
  return ok(201, { flow: clone(flow) });
}

module.exports = { MAX_VERSIONS_PER_FLOW, MAX_FLOWS_INDIVIDUAL, MAX_FLOWS_TENANT, listFlows, getFlow, createFlow, saveFlow, listVersions, getVersion, restoreVersion, deleteFlow, duplicateFlow, listTemplates, cloneTemplate, cleanGraph, canEdit, canManage };
