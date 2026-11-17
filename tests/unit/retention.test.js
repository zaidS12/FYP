'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { prune, DEFAULTS } = require('../../server/services/retention.js');

const DAY = 86400000; const NOW = Date.parse('2026-11-17T12:00:00Z');
const run = (id, ageDays, extra) => Object.assign({ id, tenant_id: 't1', user_id: 'u1', status: 'success', started_at: new Date(NOW - ageDays * DAY).toISOString() }, extra || {});
const mk = runs => ({ runs, runSteps: runs.flatMap(r => [{ id: r.id + '_s1', run_id: r.id }, { id: r.id + '_s2', run_id: r.id }]), auditLog: [] });

test('runs older than the limit are removed together with their steps, newest few are always kept', () => {
  const d = mk([run('old1', 200), run('old2', 150), run('new1', 5)]);
  const r = prune(d, NOW, { maxAgeDays: 90, keepNewest: 1, maxPerScope: 500 });
  assert.deepEqual(d.runs.map(x => x.id), ['new1']); assert.equal(d.runSteps.length, 2);
  assert.deepEqual([r.runs, r.steps], [2, 4]);
});

test('keepNewest protects the latest runs of a quiet company even when they are old', () => {
  const d = mk([run('a', 400), run('b', 300), run('c', 200), run('d', 100)]);
  prune(d, NOW, { maxAgeDays: 90, keepNewest: 2, maxPerScope: 500 });
  assert.deepEqual(d.runs.map(x => x.id).sort(), ['c', 'd']);
});

test('each company (and each individual) is capped separately, newest first', () => {
  const runs = [...Array.from({ length: 6 }, (_, i) => run('t1_' + i, i)), ...Array.from({ length: 6 }, (_, i) => run('u_' + i, i, { tenant_id: null, user_id: 'solo' }))];
  const d = mk(runs);
  prune(d, NOW, { maxAgeDays: 90, keepNewest: 1, maxPerScope: 3 });
  assert.deepEqual(d.runs.filter(x => x.tenant_id === 't1').map(x => x.id), ['t1_0', 't1_1', 't1_2']);
  assert.deepEqual(d.runs.filter(x => !x.tenant_id).map(x => x.id), ['u_0', 'u_1', 'u_2']);
});

test('a run that is still running is never removed', () => {
  const d = mk([run('live', 500, { status: 'running' }), run('x', 1)]);
  prune(d, NOW, { maxAgeDays: 90, keepNewest: 1, maxPerScope: 1 });
  assert.ok(d.runs.some(x => x.id === 'live'));
});

test('the audit log keeps only the newest entries', () => {
  const d = { runs: [], runSteps: [], auditLog: Array.from({ length: 10 }, (_, i) => ({ id: 'a' + i })) };
  const r = prune(d, NOW, { maxAudit: 4 });
  assert.deepEqual(d.auditLog.map(x => x.id), ['a6', 'a7', 'a8', 'a9']); assert.equal(r.audit, 6);
});

test('nothing to prune returns zeros; bad dates are kept rather than guessed; defaults are sensible', () => {
  const d = mk([run('a', 1), Object.assign(run('b', 1), { started_at: 'garbage' })]);
  assert.deepEqual(prune(d, NOW), { runs: 0, steps: 0, audit: 0 });
  assert.ok(DEFAULTS.maxAgeDays >= 30 && DEFAULTS.maxPerScope >= 100 && DEFAULTS.keepNewest >= 20 && DEFAULTS.maxAudit >= 5000);
});
