'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const F = require('../../server/services/flows.js');
const V = require('../../assets/js/versions.js');

const SEED = path.join(__dirname, '..', '..', 'data', 'seed.json');
const fresh = () => JSON.parse(fs.readFileSync(SEED, 'utf8'));
const actor = (data, id, by) => { const user = data.users.find(u => u.id === id); return { user, by: by ? data.users.find(u => u.id === by) : null, session: { user_id: user.id, tenant_id: user.tenant_id, role: user.role } }; };
const N = (id, type, label = id) => ({ id, type, label, x: 0, y: 0, config: {} });

function makeFlow(d, a) {
  const created = F.createFlow(d, a, { name: 'History demo' }).flow;
  const g = created.nodes;
  const s2 = F.saveFlow(d, a, created.id, { base_version: 1, nodes: [...g, N('n3', 'summarize', 'Sum')], edges: created.edges });
  assert.equal(s2.ok, true);
  return F.saveFlow(d, a, created.id, { base_version: 2, name: 'History demo v3' }).flow;
}

test('listVersions: newest first, author names, no snapshots; hidden from other companies', () => {
  const d = fresh(); const ana = actor(d, 'u_bl_ana'); const f = makeFlow(d, ana);
  const r = F.listVersions(d, ana, f.id);
  assert.equal(r.ok, true);
  assert.deepEqual(r.versions.map(v => v.n), [3, 2, 1]);
  assert.equal(r.versions[0].user_name, 'Ana Torres'); assert.ok(r.versions[0].summary);
  assert.equal(r.versions[0].snapshot, undefined);
  assert.equal(r.current, 3);
  assert.equal(F.listVersions(d, actor(d, 'u_ke_sam'), f.id).status, 404);
});

test('getVersion returns the snapshot; unknown version is 404', () => {
  const d = fresh(); const ana = actor(d, 'u_bl_ana'); const f = makeFlow(d, ana);
  const r = F.getVersion(d, ana, f.id, 1);
  assert.equal(r.ok, true); assert.equal(r.version.snapshot.nodes.length, 2);
  assert.equal(F.getVersion(d, ana, f.id, 99).status, 404);
  assert.equal(F.getVersion(d, ana, f.id, 'x').status, 400);
});

test('restore creates a NEW version with the old content and never rewrites history', () => {
  const d = fresh(); const ana = actor(d, 'u_bl_ana'); const f = makeFlow(d, ana);
  const before = JSON.stringify(d.flowVersions.filter(v => v.flow_id === f.id));
  const r = F.restoreVersion(d, ana, f.id, 1, { base_version: 3 });
  assert.equal(r.ok, true); assert.equal(r.flow.version, 4);
  assert.equal(r.flow.nodes.length, 2); assert.equal(r.flow.name, 'History demo');
  const vs = d.flowVersions.filter(v => v.flow_id === f.id);
  assert.equal(vs.length, 4);
  assert.equal(JSON.stringify(vs.slice(0, 3)), before, 'old versions untouched');
  const v4 = vs[3]; assert.equal(v4.restored_from, 1); assert.equal(v4.user_name, 'Ana Torres'); assert.match(v4.summary, /Restored version 1/);
  assert.ok(d.auditLog.some(e => e.action === 'flow.restore' && e.target === f.id));
});

test('restore needs the current base_version, refuses an identical or missing version, and viewers cannot restore', () => {
  const d = fresh(); const ana = actor(d, 'u_bl_ana'); const f = makeFlow(d, ana);
  assert.equal(F.restoreVersion(d, ana, f.id, 1, {}).status, 400);
  assert.equal(F.restoreVersion(d, ana, f.id, 1, { base_version: 2 }).status, 409);
  assert.equal(F.restoreVersion(d, ana, f.id, 3, { base_version: 3 }).status, 400, 'already identical to current');
  assert.equal(F.restoreVersion(d, ana, f.id, 42, { base_version: 3 }).status, 404);
  assert.equal(F.restoreVersion(d, actor(d, 'u_super'), f.id, 1, { base_version: 3 }).status, 403);
  assert.equal(F.restoreVersion(d, actor(d, 'u_ke_sam'), f.id, 1, { base_version: 3 }).status, 404);
});

test('restoring while impersonating records who really did it', () => {
  const d = fresh(); const ana = actor(d, 'u_bl_ana'); const f = makeFlow(d, ana);
  const r = F.restoreVersion(d, actor(d, 'u_bl_ana', 'u_bl_admin'), f.id, 1, { base_version: 3 });
  assert.equal(r.ok, true);
  const v = d.flowVersions.filter(x => x.flow_id === f.id).pop();
  assert.equal(v.by_id, 'u_bl_admin'); assert.equal(v.user_id, 'u_bl_ana');
  assert.match(d.auditLog.filter(e => e.action === 'flow.restore').pop().actor_name, / acting as /);
});

test('versions.authorLabel shows "(as X)" for impersonated saves', () => {
  assert.equal(V.authorLabel({ user_name: 'Ana' }), 'Ana');
  assert.equal(V.authorLabel({ user_name: 'Ana', by_name: 'Root' }), 'Root (as Ana)');
  assert.equal(V.authorLabel({}), 'Unknown');
});
