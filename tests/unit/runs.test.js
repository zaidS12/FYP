'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRunner, listRuns, getRun } = require('../../server/services/runs.js');
const Credits = require('../../server/services/credits.js');
const Account = require('../../server/services/account.js');
const { FakeAIProvider } = require('../../assets/js/adapters/ai.js');
const { FakeSearchProvider } = require('../../assets/js/adapters/search.js');
const { FakeMailProvider } = require('../../assets/js/adapters/mail.js');

const SEED = path.join(__dirname, '..', '..', 'data', 'seed.json');
const fresh = () => JSON.parse(fs.readFileSync(SEED, 'utf8'));
const actor = (data, id) => { const user = data.users.find(u => u.id === id); return { user, session: { user_id: user.id, tenant_id: user.tenant_id, role: user.role } }; };
const providers = () => ({ ai: new FakeAIProvider(), search: new FakeSearchProvider(), mail: new FakeMailProvider() });
function setup(extra) {
  const data = fresh(); const store = { data, saves: 0, save() { this.saves += 1; }, saveSoon() { this.saves += 1; } };
  const runner = createRunner(Object.assign({ store, providers: providers(), stepDelayMs: 0 }, extra));
  return { data, store, runner };
}
const N = (id, type, config = {}, label) => ({ id, type, label: label || id, x: 0, y: 0, config });
const E = (id, from, to, fromPort = 'out') => ({ id, from, fromPort, to, toPort: 'in' });
const addFlow = (data, id, owner, nodes, edges, tenant = 't_brightloom', shared = false) => data.flows.push({ id, tenant_id: tenant, owner_id: owner, name: id, nodes, edges, version: 1, shared, created_at: 'x', updated_at: 'x' });
const usageOf = (data, id) => data.usage.find(u => (id.startsWith('t_') ? u.tenant_id === id : u.user_id === id));

test('credits: usage records reset each month, charge atomically and refund', () => {
  const d = fresh(); const ana = d.users.find(u => u.id === 'u_bl_ana');
  const rec = Credits.usageRecord(d, ana);
  assert.equal(rec.tenant_id, 't_brightloom'); assert.equal(Credits.usageRecord(d, d.users.find(u => u.id === 'u_super')), null);
  rec.period = '2020-01'; rec.credits_used = 4999;
  assert.equal(Credits.usageRecord(d, ana).credits_used, 0, 'a new month starts at zero');
  assert.equal(Credits.usageRecord(d, ana).period, Credits.monthKey());
  rec.credits_used = 4998;
  assert.deepEqual(Credits.tryCharge(d, ana, 3), { ok: false, remaining: 2, limit: 5000 });
  assert.equal(rec.credits_used, 4998, 'a refused charge changes nothing');
  assert.equal(Credits.tryCharge(d, ana, 2).ok, true); assert.equal(rec.credits_used, 5000);
  Credits.refund(d, ana, 2); assert.equal(rec.credits_used, 4998);
  Credits.refund(d, ana, 99999); assert.equal(rec.credits_used, 0, 'never below zero');
  d.usage = d.usage.filter(u => u.user_id !== 'u_solo');
  const solo = Credits.usageRecord(d, d.users.find(u => u.id === 'u_solo'));
  assert.deepEqual([solo.credits_limit, solo.credits_used, solo.tenant_id], [100, 0, null], 'a missing record is created from the plan');
  assert.equal(Account.getUsage(d, actor(d, 'u_solo')).usage.limit, 100);
});

test('a run executes the saved flow, records every step, charges the company and saves the final result', async () => {
  const { data, runner, store } = setup();
  const before = usageOf(data, 't_brightloom').credits_used;
  const r = runner.start(actor(data, 'u_bl_ana'), 'f_news', {});
  assert.equal(r.ok, true); assert.equal(r.status, 202); assert.equal(r.run.status, 'running');
  await runner.whenDone(r.run.id);
  const run = data.runs.find(x => x.id === r.run.id);
  assert.equal(run.status, 'success'); assert.equal(run.credits, 7); assert.equal(run.user_name, 'Ana Torres'); assert.equal(run.flow_name, 'Daily AI news digest'); assert.equal(run.flow_version, 2);
  assert.match(run.output, /Sent to team@agentflow.com/); assert.ok(run.ended_at && run.logs.length > 0);
  const steps = data.runSteps.filter(s => s.run_id === run.id).sort((a, b) => a.n - b.n);
  assert.deepEqual(steps.map(s => s.type), ['start', 'search_web', 'summarize', 'write_email', 'end']);
  assert.ok(steps.every(s => s.status === 'success' && s.tenant_id === 't_brightloom'));
  assert.equal(usageOf(data, 't_brightloom').credits_used, before + 7);
  assert.ok(store.saves >= 5, 'progress is saved as it happens');
});

test('who may start a run', async () => {
  const { data, runner } = setup();
  assert.equal(runner.start(actor(data, 'u_super'), 'f_news', {}).status, 403);
  assert.equal(runner.start(actor(data, 'u_bl_ana'), 'f_ke', {}).status, 404, 'another company');
  assert.equal(runner.start(actor(data, 'u_bl_ana'), 'f_translate', {}).status, 404, 'a colleague private flow');
  assert.equal(runner.start(actor(data, 'u_bl_ana'), 'nope', {}).status, 404);
  const o = runner.start(actor(data, 'u_bl_omar'), 'f_news', {}); assert.equal(o.status, 202, 'a colleague may run a shared flow');
  const a = runner.start(actor(data, 'u_bl_admin'), 'f_translate', {}); assert.equal(a.status, 202, 'the company admin may run any company flow');
  await Promise.all([runner.whenDone(o.run.id), runner.whenDone(a.run.id)]);
  assert.equal(data.runs.find(x => x.id === o.run.id).user_id, 'u_bl_omar');
});

test('a flow with problems is refused with the list of problems and creates no run', () => {
  const { data, runner } = setup();
  addFlow(data, 'f_bad', 'u_bl_ana', [N('s', 'start')], []);
  const n = data.runs.length;
  const r = runner.start(actor(data, 'u_bl_ana'), 'f_bad', {});
  assert.equal(r.status, 400); assert.match(r.error, /problem/); assert.ok(r.problems.length > 0); assert.equal(data.runs.length, n);
});

test('SERVER-SIDE CREDITS: a run is refused when credits are exhausted, with the right advice for company and individual', () => {
  const { data, runner } = setup();
  const u = usageOf(data, 't_brightloom'); u.credits_used = u.credits_limit;
  const n = data.runs.length;
  const c = runner.start(actor(data, 'u_bl_ana'), 'f_news', {});
  assert.equal(c.status, 402); assert.equal(c.code, 'credits_exhausted'); assert.match(c.error, /company has used all 5,000 credits/); assert.match(c.error, /admin/i);
  const s = usageOf(data, 'u_solo'); s.credits_used = s.credits_limit;
  const i = runner.start(actor(data, 'u_solo'), 'f_solo', {});
  assert.equal(i.status, 402); assert.match(i.error, /used all 100 credits/); assert.match(i.error, /Upgrade/);
  assert.equal(data.runs.length, n, 'no run is created for a refused start');
});

test('credits running out in the middle: the card that cannot be paid for fails, nothing after it runs', async () => {
  const { data, runner } = setup();
  const u = usageOf(data, 't_brightloom'); u.credits_used = u.credits_limit - 3;
  const r = runner.start(actor(data, 'u_bl_ana'), 'f_news', {}); await runner.whenDone(r.run.id);
  const run = data.runs.find(x => x.id === r.run.id);
  assert.equal(run.status, 'failed'); assert.equal(run.error_code, 'credits_exhausted'); assert.match(run.error, /Not enough credits/);
  assert.equal(run.credits, 2); assert.equal(u.credits_used, u.credits_limit - 1);
  const steps = data.runSteps.filter(s => s.run_id === run.id).sort((a, b) => a.n - b.n);
  assert.deepEqual(steps.map(s => s.status), ['success', 'success', 'failed']);
  assert.match(steps[2].error, /needs 3 and 1 is left/);
});

test('a failed card is refunded, and the failure is explained', async () => {
  const { data, runner } = setup();
  addFlow(data, 'f_fail', 'u_bl_ana', [N('s', 'start'), N('a', 'search_web', { query: 'news [fail]', max_results: 3 }), N('e', 'end')], [E('1', 's', 'a'), E('2', 'a', 'e')]);
  const before = usageOf(data, 't_brightloom').credits_used;
  const r = runner.start(actor(data, 'u_bl_ana'), 'f_fail', {}); await runner.whenDone(r.run.id);
  const run = data.runs.find(x => x.id === r.run.id);
  assert.equal(run.status, 'failed'); assert.equal(run.error_code, 'search_timeout'); assert.match(run.error, /timed out/);
  assert.equal(run.credits, 0); assert.equal(usageOf(data, 't_brightloom').credits_used, before);
  assert.ok(data.runSteps.some(s => s.run_id === run.id && s.status === 'failed' && s.credits === 0));
});

test('Stop: only the person who started it, or a company admin, can stop a run; finished runs cannot be stopped', async () => {
  const { data, runner } = setup({ stepDelayMs: 25 });
  const r = runner.start(actor(data, 'u_bl_ana'), 'f_news', {});
  assert.equal(runner.stop(actor(data, 'u_bl_omar'), r.run.id).status, 404, 'a colleague cannot even see it');
  assert.equal(runner.stop(actor(data, 'u_super'), r.run.id).status, 403);
  const s = runner.stop(actor(data, 'u_bl_ana'), r.run.id); assert.equal(s.status, 200);
  await runner.whenDone(r.run.id);
  const run = data.runs.find(x => x.id === r.run.id);
  assert.equal(run.status, 'stopped'); assert.ok(data.runSteps.filter(x => x.run_id === run.id).length < 5);
  assert.equal(runner.stop(actor(data, 'u_bl_ana'), r.run.id).status, 409);
  const r2 = runner.start(actor(data, 'u_bl_ana'), 'f_news', {});
  assert.equal(runner.stop(actor(data, 'u_bl_admin'), r2.run.id).status, 200, 'the company admin may stop it');
  await runner.whenDone(r2.run.id);
  assert.equal(runner.stop(actor(data, 'u_bl_ana'), 'nope').status, 404);
});

test('at most 3 runs in progress per person', async () => {
  const { data, runner } = setup({ stepDelayMs: 30 });
  const ids = [1, 2, 3].map(() => runner.start(actor(data, 'u_bl_ana'), 'f_news', {}).run.id);
  const fourth = runner.start(actor(data, 'u_bl_ana'), 'f_news', {});
  assert.equal(fourth.status, 429); assert.equal(fourth.code, 'too_many_runs');
  assert.equal(runner.start(actor(data, 'u_bl_omar'), 'f_news', {}).status, 202, 'the limit is per person');
  await Promise.all(runner.allDone());
  assert.equal(runner.start(actor(data, 'u_bl_ana'), 'f_news', {}).status, 202);
  await Promise.all(runner.allDone());
  void ids;
});

test('runs left "running" by a server restart are marked failed', () => {
  const { data, runner } = setup();
  data.runs.push({ id: 'r_stuck', flow_id: 'f_news', tenant_id: 't_brightloom', user_id: 'u_bl_ana', status: 'running', started_at: 'x', ended_at: null, credits: 0, error: null });
  data.runSteps.push({ id: 'r_stuck_s1', run_id: 'r_stuck', tenant_id: 't_brightloom', node_id: 'n1', type: 'start', status: 'running', ms: 0, credits: 0 });
  assert.equal(runner.recover(), 1);
  const run = data.runs.find(r => r.id === 'r_stuck');
  assert.equal(run.status, 'failed'); assert.match(run.error, /restarted/); assert.ok(run.ended_at);
  assert.equal(data.runSteps.find(s => s.id === 'r_stuck_s1').status, 'failed');
});

test('run history is scoped: own runs for employees and individuals, the whole company for its admin, everything for the super admin', () => {
  const d = fresh();
  assert.ok(listRuns(d, actor(d, 'u_bl_ana'), {}).runs.every(r => r.user_id === 'u_bl_ana'));
  assert.equal(listRuns(d, actor(d, 'u_bl_ana'), {}).runs.length, 5);
  assert.equal(listRuns(d, actor(d, 'u_bl_admin'), {}).runs.length, 9);
  assert.equal(listRuns(d, actor(d, 'u_super'), {}).runs.length, d.runs.length);
  assert.equal(listRuns(d, actor(d, 'u_solo'), {}).runs.length, 2);
  assert.ok(!listRuns(d, actor(d, 'u_bl_admin'), {}).runs.some(r => r.tenant_id === 't_kestrel'));
  const all = listRuns(d, actor(d, 'u_bl_admin'), {}).runs;
  assert.ok(all[0].started_at >= all[all.length - 1].started_at, 'newest first');
  assert.ok(all.every(r => r.flow_name && r.user_name && typeof r.duration_ms === 'number'));
});

test('run history filters: status, flow, person, text, date and limit', () => {
  const d = fresh(); const adm = actor(d, 'u_bl_admin');
  assert.deepEqual(listRuns(d, adm, { status: 'failed' }).runs.map(r => r.id), ['f_news_run3']);
  assert.equal(listRuns(d, adm, { flow_id: 'f_report' }).runs.length, 2);
  assert.equal(listRuns(d, adm, { user_id: 'u_bl_omar' }).runs.length, 2);
  assert.equal(listRuns(d, adm, { q: 'DIGEST' }).runs.length, 5);
  assert.equal(listRuns(d, adm, { limit: '3' }).runs.length, 3);
  assert.equal(listRuns(d, adm, { since: new Date(Date.now() + 86400000).toISOString() }).runs.length, 0);
  assert.equal(listRuns(d, actor(d, 'u_bl_ana'), { user_id: 'u_bl_omar' }).runs.length, 0, 'an employee cannot ask for someone else\'s runs');
  assert.equal(listRuns(d, adm, { limit: '99999' }).runs.length, 9);
});

test('getRun returns ordered steps with labels, and hides runs you are not allowed to see', () => {
  const d = fresh();
  const r = getRun(d, actor(d, 'u_bl_ana'), 'f_news_run3');
  assert.equal(r.ok, true); assert.equal(r.run.status, 'failed'); assert.match(r.run.error, /timed out/);
  assert.deepEqual(r.steps.map(s => s.type), ['start', 'search_web', 'summarize']);
  assert.ok(r.steps.every(s => s.label && typeof s.n === 'number'));
  assert.equal(r.steps[2].status, 'failed');
  assert.equal(getRun(d, actor(d, 'u_bl_omar'), 'f_news_run3').status, 404, 'a colleague');
  assert.equal(getRun(d, actor(d, 'u_bl_admin'), 'f_news_run3').ok, true);
  assert.equal(getRun(d, actor(d, 'u_super'), 'f_news_run3').ok, true);
  assert.equal(getRun(d, actor(d, 'u_bl_ana'), 'f_ke_run1').status, 404, 'another company');
  assert.equal(getRun(d, actor(d, 'u_bl_ana'), 'nope').status, 404);
});

test('a new month resets credits before a run is checked', async () => {
  const { data, runner } = setup();
  const u = usageOf(data, 't_brightloom'); u.period = '2020-01'; u.credits_used = u.credits_limit;
  const r = runner.start(actor(data, 'u_bl_ana'), 'f_news', {}); assert.equal(r.status, 202);
  await runner.whenDone(r.run.id);
  assert.equal(usageOf(data, 't_brightloom').credits_used, 7);
});
