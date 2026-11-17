'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const F = require('../../server/services/flows.js');
const V = require('../../assets/js/versions.js');
const C = require('../../assets/js/billing.js');

const SEED = path.join(__dirname, '..', '..', 'data', 'seed.json');
const fresh = () => JSON.parse(fs.readFileSync(SEED, 'utf8'));
const actor = (data, id) => { const user = data.users.find(u => u.id === id); return { user, session: { user_id: user.id, tenant_id: user.tenant_id, role: user.role } }; };
const sv = (d, a, id, patch) => F.saveFlow(d, a, id, Object.assign({ base_version: (d.flows.find(f => f.id === id) || {}).version }, patch));
const N = (id, type, label = id, x = 0, y = 0) => ({ id, type, label, x, y, config: {} });

test('credits: costs per node type, flow estimate and status', () => {
  assert.equal(C.costOf('search_web'), 2); assert.equal(C.costOf('start'), 0); assert.equal(C.costOf('research_bot'), 6);
  assert.equal(C.costOf('my_custom_card', { base: 'summarize' }), 3);
  assert.equal(C.costOf('totally_unknown'), 1);
  assert.equal(C.estimateFlow([N('a', 'start'), N('b', 'search_web'), N('c', 'summarize'), N('d', 'end')]), 5);
  const s = C.creditStatus({ credits_used: 95, credits_limit: 100 });
  assert.deepEqual([s.remaining, s.percent, s.exhausted, s.low], [5, 95, false, true]);
  assert.equal(C.creditStatus({ credits_used: 100, credits_limit: 100 }).exhausted, true);
  assert.equal(C.canAfford({ credits_used: 98, credits_limit: 100 }, 3), false);
  assert.equal(C.canAfford({ credits_used: 98, credits_limit: 100 }, 2), true);
});

test('versions: change summaries say what changed in plain words', () => {
  const a = { name: 'F', nodes: [N('n1', 'start', 'Start'), N('n2', 'end', 'End')], edges: [{ id: 'e1', from: 'n1', to: 'n2' }] };
  assert.equal(V.summarizeChange(a, a), 'No changes');
  const added = { name: 'F', nodes: [...a.nodes, N('n3', 'summarize', 'Summarize')], edges: a.edges };
  assert.match(V.summarizeChange(a, added), /Added 1 card \(Summarize\)/);
  const removed = { name: 'F', nodes: [a.nodes[0]], edges: [] };
  assert.match(V.summarizeChange(a, removed), /Removed 1 card \(End\)/);
  assert.match(V.summarizeChange(a, removed), /Removed 1 connection/);
  const cfg = { name: 'F', nodes: [{ ...a.nodes[0], config: { q: 1 } }, a.nodes[1]], edges: a.edges };
  assert.match(V.summarizeChange(a, cfg), /Changed settings of Start/);
  assert.match(V.summarizeChange(a, { ...a, nodes: [{ ...a.nodes[0], x: 99 }, a.nodes[1]] }), /Moved 1 card/);
  assert.match(V.summarizeChange(a, { ...a, name: 'G' }), /Renamed the flow from "F" to "G"/);
  assert.ok(V.summarizeChange(a, { name: 'F', nodes: Array.from({ length: 40 }, (_, i) => N('x' + i, 'summarize', 'Long label number ' + i)), edges: [] }).length <= 200);
});

test('listFlows: employees see shared and their own flows only, with edit rights', () => {
  const d = fresh();
  const r = F.listFlows(d, actor(d, 'u_bl_ana'));
  assert.deepEqual(r.flows.map(f => f.name).sort(), ['Competitor research report', 'Daily AI news digest']);
  assert.ok(r.flows.every(f => f.can_edit === true), 'shared company flows can be edited by colleagues');
  const adm = F.listFlows(d, actor(d, 'u_bl_admin')).flows;
  assert.equal(adm.length, 3);
  const sup = F.listFlows(d, actor(d, 'u_super')).flows;
  assert.ok(sup.length === d.flows.length && sup.every(f => f.can_edit === false));
});

test('getFlow returns the full graph; flows you cannot see look like they do not exist', () => {
  const d = fresh();
  const r = F.getFlow(d, actor(d, 'u_bl_ana'), 'f_news');
  assert.equal(r.ok, true); assert.equal(r.flow.nodes.length, 5); assert.equal(r.can_edit, true);
  assert.equal(F.getFlow(d, actor(d, 'u_bl_ana'), 'f_translate').status, 404, 'a colleague private flow');
  assert.equal(F.getFlow(d, actor(d, 'u_bl_ana'), 'f_ke').status, 404, 'another company');
  assert.equal(F.getFlow(d, actor(d, 'u_solo'), 'f_news').status, 404);
  assert.equal(F.getFlow(d, actor(d, 'u_super'), 'f_news').can_edit, false);
  assert.equal(F.getFlow(d, actor(d, 'u_bl_ana'), 'nope').status, 404);
});

test('createFlow stamps tenant and owner from the session and starts with Start and End', () => {
  const d = fresh(); const ana = actor(d, 'u_bl_ana');
  const r = F.createFlow(d, ana, { name: '  Weekly digest ', tenant_id: 't_kestrel', owner_id: 'u_ke_sam', shared: true });
  assert.equal(r.ok, true); assert.equal(r.status, 201);
  const f = d.flows.find(x => x.id === r.flow.id);
  assert.equal(f.tenant_id, 't_brightloom'); assert.equal(f.owner_id, 'u_bl_ana'); assert.equal(f.name, 'Weekly digest'); assert.equal(f.shared, false);
  assert.deepEqual(f.nodes.map(n => n.type), ['start', 'end']); assert.equal(f.version, 1);
  const v = d.flowVersions.find(x => x.flow_id === f.id);
  assert.deepEqual([v.n, v.user_id, v.user_name, v.summary], [1, 'u_bl_ana', 'Ana Torres', 'Created flow']);
  assert.ok(d.auditLog.some(e => e.action === 'flow.create' && e.target === f.id));
  assert.equal(F.createFlow(d, actor(d, 'u_solo'), { name: 'Mine' }).flow.tenant_id, null);
});

test('createFlow validates the name and the graph, and super admins cannot create flows', () => {
  const d = fresh(); const ana = actor(d, 'u_bl_ana');
  assert.equal(F.createFlow(d, ana, { name: '' }).status, 400);
  assert.equal(F.createFlow(d, ana, { name: 'x'.repeat(121) }).status, 400);
  assert.equal(F.createFlow(d, actor(d, 'u_super'), { name: 'No' }).status, 403);
  assert.equal(F.createFlow(d, ana, { name: 'A', nodes: ['x'], edges: [] }).status, 400);
  assert.equal(F.createFlow(d, ana, { name: 'A', nodes: [N('n1', 'start')], edges: [{ id: 'e', from: 'n1', to: 'ghost' }] }).status, 400);
  assert.equal(F.createFlow(d, ana, { name: 'A', nodes: [N('n1', 'start'), N('n1', 'end')], edges: [] }).status, 400, 'duplicate card ids');
  assert.equal(F.createFlow(d, ana, { name: 'A', nodes: [{ ...N('n1', 'start'), x: 'left' }], edges: [] }).status, 400);
  assert.equal(F.createFlow(d, ana, { name: 'A', nodes: [{ ...N('n1', 'Bad Type!') }], edges: [] }).status, 400);
  assert.equal(F.createFlow(d, ana, { name: 'A', nodes: Array.from({ length: 201 }, (_, i) => N('n' + i, 'start')), edges: [] }).status, 400);
});

test('saveFlow: a colleague edits a shared flow and a version records who and what', () => {
  const d = fresh(); const omar = actor(d, 'u_bl_omar');
  const g = F.getFlow(d, omar, 'f_news').flow;
  const nodes = [...g.nodes, N('n6', 'translate', 'Translate', 100, 300)];
  const r = sv(d, omar, 'f_news', { nodes, edges: g.edges, base_version: 2 });
  assert.equal(r.ok, true); assert.equal(r.flow.version, 3);
  const v = d.flowVersions.find(x => x.flow_id === 'f_news' && x.n === 3);
  assert.equal(v.user_id, 'u_bl_omar'); assert.match(v.summary, /Added 1 card \(Translate\)/); assert.equal(v.snapshot.nodes.length, 6);
  assert.equal(sv(d, omar, 'f_news', { nodes, edges: g.edges }).flow.version, 3, 'identical save creates no version');
  assert.equal(sv(d, omar, 'f_translate', { name: 'x' }).status, 404, 'private colleague flow');
  assert.equal(sv(d, actor(d, 'u_bl_admin'), 'f_translate', { name: 'Admin rename' }).ok, true);
  assert.equal(sv(d, actor(d, 'u_super'), 'f_news', { name: 'x' }).status, 403);
});

test('saveFlow detects edits made since you opened the flow (conflict) and validates', () => {
  const d = fresh(); const ana = actor(d, 'u_bl_ana'); const omar = actor(d, 'u_bl_omar');
  const g = F.getFlow(d, ana, 'f_news').flow;
  sv(d, omar, 'f_news', { name: 'Omar was here', base_version: 2 });
  const stale = sv(d, ana, 'f_news', { name: 'Ana was here', base_version: 2 });
  assert.equal(stale.status, 409); assert.equal(stale.code, 'conflict'); assert.equal(stale.flow.version, 3);
  assert.equal(stale.conflicts[0].label, 'Flow name');
  assert.equal(sv(d, ana, 'f_news', { name: 'x', base_version: 99 }).status, 409, 'a version from the future is never merged');
  const ok = sv(d, ana, 'f_news', { nodes: g.nodes.slice(0, 4), edges: g.edges.filter(e => g.nodes.slice(0, 4).some(n => n.id === e.from) && g.nodes.slice(0, 4).some(n => n.id === e.to)), base_version: 2 });
  assert.equal(ok.status, 200); assert.equal(ok.merged, true); assert.equal(ok.flow.name, 'Omar was here', 'their rename is kept');
  assert.match(d.flowVersions.filter(v => v.flow_id === 'f_news').pop().summary, /^Merged with version 3/);
  assert.equal(sv(d, ana, 'f_news', { nodes: [N('n1', 'start')], edges: [{ id: 'e', from: 'n1', to: 'zzz' }] }).status, 400);
  assert.equal(sv(d, ana, 'f_news', { name: '' }).status, 400);
  assert.equal(sv(d, ana, 'f_news', {}).status, 400);
});

test('saving a name or graph without base_version is refused, so nobody overwrites blindly', () => {
  const d = fresh(); const ana = actor(d, 'u_bl_ana');
  const r = F.saveFlow(d, ana, 'f_news', { name: 'No version sent' });
  assert.equal(r.status, 400); assert.match(r.error, /base_version/);
  assert.equal(F.saveFlow(d, ana, 'f_news', { shared: true }).ok, true, 'sharing alone needs no version');
  assert.equal(sv(d, ana, 'f_news', { name: 'With version', base_version: 2 }).ok, true);
});

test('versions per flow are capped (oldest are pruned) and companies and individuals have flow quotas', () => {
  const d = fresh(); const ana = actor(d, 'u_bl_ana');
  const g = d.flows.find(f => f.id === 'f_news');
  for (let i = 0; i < F.MAX_VERSIONS_PER_FLOW + 5; i++) assert.equal(sv(d, ana, 'f_news', { name: 'Name ' + i, nodes: g.nodes, edges: g.edges, base_version: d.flows.find(f => f.id === 'f_news').version }).ok, true);
  const vs = d.flowVersions.filter(v => v.flow_id === 'f_news');
  assert.equal(vs.length, F.MAX_VERSIONS_PER_FLOW);
  assert.equal(Math.max(...vs.map(v => v.n)), d.flows.find(f => f.id === 'f_news').version, 'the newest version is always kept');
  const solo = actor(d, 'u_solo');
  for (let i = 0; i < F.MAX_FLOWS_INDIVIDUAL; i++) d.flows.push({ id: 'pad' + i, tenant_id: null, owner_id: 'u_solo', name: 'p', nodes: [], edges: [], version: 1 });
  const q = F.createFlow(d, solo, { name: 'One too many' });
  assert.equal(q.status, 409); assert.match(q.error, /up to \d+ flows/);
  assert.equal(F.duplicateFlow(d, solo, 'pad0').status, 409);
  assert.equal(F.cloneTemplate(d, solo, 'tpl_summary', {}).status, 409);
});

test('card settings lose prototype-polluting keys and size limits hold', () => {
  const d = fresh(); const ana = actor(d, 'u_bl_ana');
  const evil = JSON.parse('{"id":"n1","type":"start","label":"S","x":0,"y":0,"config":{"__proto__":{"polluted":true},"constructor":{"x":1},"ok":"fine"}}');
  const r = F.createFlow(d, ana, { name: 'Evil', nodes: [evil], edges: [] });
  assert.equal(r.ok, true);
  const cfg = d.flows.find(f => f.id === r.flow.id).nodes[0].config;
  assert.equal(Object.prototype.hasOwnProperty.call(cfg, '__proto__'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(cfg, 'constructor'), false);
  assert.equal(cfg.ok, 'fine'); assert.equal(({}).polluted, undefined);
  for (const bad of [NaN, Infinity, -Infinity, 1e9]) assert.equal(F.createFlow(d, ana, { name: 'B', nodes: [{ ...N('n1', 'start'), x: bad }], edges: [] }).status, 400, String(bad));
});

test('sharing can only be changed by the owner or a company admin', () => {
  const d = fresh();
  assert.equal(sv(d, actor(d, 'u_bl_omar'), 'f_news', { shared: false }).status, 403);
  const r = sv(d, actor(d, 'u_bl_ana'), 'f_news', { shared: false });
  assert.equal(r.ok, true); assert.equal(r.flow.shared, false);
  assert.equal(F.getFlow(d, actor(d, 'u_bl_omar'), 'f_news').status, 404, 'now private to the owner');
  assert.equal(r.flow.version, 2, 'sharing is not a version');
});

test('deleteFlow: owner and company admin only, and everything attached goes with it', () => {
  const d = fresh();
  assert.equal(F.deleteFlow(d, actor(d, 'u_bl_omar'), 'f_news').status, 403);
  assert.equal(F.deleteFlow(d, actor(d, 'u_bl_ana'), 'f_ke').status, 404);
  assert.equal(F.deleteFlow(d, actor(d, 'u_super'), 'f_news').status, 403);
  assert.equal(F.deleteFlow(d, actor(d, 'u_bl_ana'), 'f_news').ok, true);
  assert.equal(d.flows.some(f => f.id === 'f_news'), false);
  for (const c of ['flowVersions', 'runs', 'runSteps']) assert.equal(d[c].some(x => x.flow_id === 'f_news' || String(x.run_id || '').startsWith('f_news_')), false, c);
  assert.equal(F.deleteFlow(d, actor(d, 'u_bl_admin'), 'f_report').ok, true);
});

test('duplicateFlow makes a private copy owned by the person duplicating', () => {
  const d = fresh();
  const r = F.duplicateFlow(d, actor(d, 'u_bl_omar'), 'f_news');
  assert.equal(r.ok, true); assert.equal(r.status, 201);
  const c = d.flows.find(f => f.id === r.flow.id);
  assert.equal(c.name, 'Daily AI news digest (copy)'); assert.equal(c.owner_id, 'u_bl_omar'); assert.equal(c.shared, false); assert.equal(c.version, 1);
  assert.equal(c.nodes.length, 5); assert.notEqual(c.nodes, d.flows.find(f => f.id === 'f_news').nodes, 'deep copy');
  assert.equal(F.duplicateFlow(d, actor(d, 'u_bl_omar'), 'f_translate').status, 404);
  assert.equal(F.duplicateFlow(d, actor(d, 'u_super'), 'f_news').status, 403);
});

test('templates: everyone sees global templates; cloning creates a private flow in your workspace', () => {
  const d = fresh();
  const list = F.listTemplates(d, actor(d, 'u_solo')).templates;
  assert.equal(list.length, 4); assert.ok(list.every(t => t.node_count > 0));
  d.templates.push({ id: 'tpl_kestrel', tenant_id: 't_kestrel', name: 'Kestrel only', description: 'x', category: 'x', nodes: [N('n1', 'start')], edges: [] });
  assert.equal(F.listTemplates(d, actor(d, 'u_bl_ana')).templates.some(t => t.id === 'tpl_kestrel'), false);
  const r = F.cloneTemplate(d, actor(d, 'u_bl_ana'), 'tpl_news', { name: 'My news' });
  assert.equal(r.ok, true); assert.equal(r.flow.name, 'My news');
  const f = d.flows.find(x => x.id === r.flow.id);
  assert.equal(f.tenant_id, 't_brightloom'); assert.equal(f.owner_id, 'u_bl_ana'); assert.equal(f.nodes.length, 5);
  assert.equal(F.cloneTemplate(d, actor(d, 'u_bl_ana'), 'tpl_kestrel', {}).status, 404);
  assert.equal(F.cloneTemplate(d, actor(d, 'u_super'), 'tpl_news', {}).status, 403);
  assert.equal(F.cloneTemplate(d, actor(d, 'u_solo'), 'tpl_summary', {}).flow.name, 'Quick summary');
});
