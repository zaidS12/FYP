'use strict';
/* Running flows on the server. The server executes the SAVED flow with the shared engine, so credits, stopping and history cannot be
 * bypassed from a browser. The page starts a run, then polls GET /api/runs/:id for live progress.
 * Providers (AI, search, mail) are injected: fakes now, real services later, with no change here. */
const Auth = require('../../assets/js/auth.js');
const Ten = require('../../assets/js/tenancy.js');
const Engine = require('../../assets/js/engine.js');
const Sec = require('../security.js');
const Audit = require('./audit.js');
const Credits = require('./credits.js');

const ok = (status, extra) => Object.assign({ ok: true, status }, extra);
const fail = (status, error, extra) => Object.assign({ ok: false, status, error }, extra || {});
const iso = () => new Date().toISOString();
const clone = x => JSON.parse(JSON.stringify(x));
const MAX_CONCURRENT_PER_USER = 3, MAX_LOGS = 500, MAX_OUTPUT = 20000;

/** Employees and individuals see their own runs; a company admin sees the whole company; a super admin sees everything. */
function canSee(actor, run) {
  const u = actor.user;
  if (u.role === 'superadmin') return true;
  if (u.role === 'admin') return !!u.tenant_id && run.tenant_id === u.tenant_id;
  return run.user_id === u.id;
}

function view(data, run, withLogs) {
  const flow = data.flows.find(f => f.id === run.flow_id); const user = data.users.find(u => u.id === run.user_id);
  const started = Date.parse(run.started_at); const end = run.ended_at ? Date.parse(run.ended_at) : Date.now();
  const out = Object.assign({}, run, {
    flow_name: run.flow_name || (flow ? flow.name : '(deleted flow)'), user_name: run.user_name || (user ? user.name : 'Deleted user'),
    duration_ms: Number.isFinite(started) ? Math.max(0, end - started) : 0, steps_count: data.runSteps.filter(s => s.run_id === run.id).length,
  });
  if (!withLogs) delete out.logs;
  return out;
}

function listRuns(data, actor, query) {
  const q = query && typeof query === 'object' ? query : {};
  const limit = Math.min(500, Math.max(1, parseInt(q.limit, 10) || 100));
  const text = typeof q.q === 'string' ? q.q.trim().toLowerCase() : '';
  const runs = data.runs.filter(r => canSee(actor, r)).map(r => view(data, r, false))
    .filter(r => (!q.status || r.status === q.status) && (!q.flow_id || r.flow_id === q.flow_id) && (!q.user_id || r.user_id === q.user_id)
      && (!text || r.flow_name.toLowerCase().includes(text)) && (!q.since || r.started_at >= q.since))
    .sort((a, b) => (b.started_at > a.started_at ? 1 : b.started_at < a.started_at ? -1 : 0)).slice(0, limit);
  return ok(200, { runs });
}

function getRun(data, actor, id) {
  const run = data.runs.find(r => r.id === id);
  if (!run || !canSee(actor, run)) return fail(404, 'No such run.');
  const flow = data.flows.find(f => f.id === run.flow_id);
  const labels = new Map(((flow && flow.nodes) || []).map(n => [n.id, n.label]));
  const steps = data.runSteps.filter(s => s.run_id === id).map(s => Object.assign({}, s, {
    n: typeof s.n === 'number' ? s.n : Number((String(s.id).match(/(\d+)$/) || [])[1]) || 0, label: s.label || labels.get(s.node_id) || s.type,
  })).sort((a, b) => a.n - b.n);
  return ok(200, { run: view(data, run, true), steps });
}

function createRunner({ store, providers, stepDelayMs = 350 }) {
  const active = new Map();                       // run id -> {promise, userId}
  const db = () => store.data;
  const delay = ms => new Promise(r => setTimeout(r, ms));

  function exhaustedMessage(user, rec) {
    if (user.tenant_id) return `Your company has used all ${rec.credits_limit.toLocaleString()} credits this month. Ask your admin to upgrade the plan in Billing, or wait until credits renew.`;
    const plan = (db().plans.find(p => p.id === (user.plan_id || 'free')) || {}).name || 'Free';
    return `You have used all ${rec.credits_limit.toLocaleString()} credits on the ${plan} plan this month. Upgrade on your account page, or wait until credits renew.`;
  }

  function start(actor, flowId, body) {
    const u = actor.user;
    if (u.role === 'superadmin' || !Auth.can(u.role, 'runs.execute')) return fail(403, 'Super admins can look at runs but cannot start them.');
    const flow = db().flows.find(f => f.id === flowId);
    if (!flow || !Ten.canAccessFlow(actor.session, flow)) return fail(404, 'No such flow.');
    const check = Engine.validateFlow(flow.nodes, flow.edges);
    if (!check.ok) return fail(400, `This flow has ${check.errors.length} problem${check.errors.length === 1 ? '' : 's'}. Fix ${check.errors.length === 1 ? 'it' : 'them'} in the builder, save, then run again.`, { code: 'invalid_flow', problems: check.errors });
    const rec = Credits.usageRecord(db(), u);
    if (rec && rec.credits_used >= rec.credits_limit) return fail(402, exhaustedMessage(u, rec), { code: 'credits_exhausted' });
    if ([...active.values()].filter(a => a.userId === u.id).length >= MAX_CONCURRENT_PER_USER) return fail(429, `You already have ${MAX_CONCURRENT_PER_USER} runs in progress. Wait for one to finish, or stop one.`, { code: 'too_many_runs' });
    const input = body && typeof body.input === 'string' && body.input.trim() ? body.input.slice(0, 5000) : null;
    const run = { id: Sec.newId('run'), flow_id: flow.id, flow_name: flow.name, flow_version: flow.version, tenant_id: flow.tenant_id, user_id: u.id, user_name: u.name, ...Audit.attribution(actor), status: 'running',
      started_at: iso(), ended_at: null, credits: 0, error: null, error_code: null, output: null, result_title: null, input, logs: [], stop_requested: false };
    db().runs.push(run);
    if (actor.by) Audit.record(db(), actor, 'run.start', run.id, flow.tenant_id, { flow: flow.name }); // normal runs are in the run history already
    store.save();
    const snapshot = { nodes: clone(flow.nodes), edges: clone(flow.edges) };
    const promise = execute(run.id, u.id, snapshot, input).catch(e => finish(run.id, { status: 'failed', error: 'Something went wrong while running this flow: ' + ((e && e.message) || e), code: 'internal', credits: undefined })).then(() => { active.delete(run.id); });
    active.set(run.id, { promise, userId: u.id });
    return ok(202, { run: view(db(), run, true) });
  }

  function finish(runId, r) {
    const run = db().runs.find(x => x.id === runId); if (!run) return;
    run.status = r.status; run.ended_at = iso(); run.error = r.error || null; run.error_code = r.code || null;
    run.output = r.output == null ? null : String(r.output).slice(0, MAX_OUTPUT); run.result_title = r.result_title || null;
    if (typeof r.credits === 'number') run.credits = r.credits;
    for (const s of db().runSteps) if (s.run_id === runId && s.status === 'running') s.status = r.status === 'success' ? 'success' : 'failed';
    store.save();
  }

  async function execute(runId, userId, snapshot, input) {
    const findRun = () => db().runs.find(r => r.id === runId);
    const user = () => db().users.find(u => u.id === userId);
    const result = await Engine.run(snapshot, {
      providers, input, maxSteps: 200, sleep: () => delay(stepDelayMs),
      isStopped: () => { const r = findRun(); return !r || r.stop_requested; },
      charge: async (node, cost) => {
        const run = findRun(); const u = user();
        if (!run || !u) return { ok: false, code: 'gone', message: 'This run is no longer available.' };
        const c = Credits.tryCharge(db(), u, cost);
        if (!c.ok) return { ok: false, code: 'credits_exhausted', message: `Not enough credits: "${node.label}" needs ${cost} and ${c.remaining} ${c.remaining === 1 ? 'is' : 'are'} left. ${u.tenant_id ? 'Ask your admin to upgrade the plan in Billing.' : 'Upgrade on your account page.'}` };
        run.credits += cost; return { ok: true };
      },
      refund: async (node, cost) => { const run = findRun(); const u = user(); if (run && u) { Credits.refund(db(), u, cost); run.credits = Math.max(0, run.credits - cost); } },
      onEvent: ev => {
        const run = findRun(); if (!run) return;
        if (ev.type === 'log') { run.logs.push(ev.log); if (run.logs.length > MAX_LOGS) run.logs.shift(); return; }
        const id = ev.step ? `${run.id}_s${ev.step.n}` : null;
        if (ev.type === 'step_start') {
          db().runSteps.push({ id, run_id: run.id, tenant_id: run.tenant_id, n: ev.step.n, node_id: ev.step.node_id, label: ev.step.label, type: ev.step.type, status: 'running', ms: 0, credits: 0, input: ev.step.input, output: null, error: null, branch: null, loop_index: ev.step.loop_index, started_at: iso() });
          store.saveSoon();
        } else if (ev.type === 'step_end') {
          const s = db().runSteps.find(x => x.id === id);
          if (s) { Object.assign(s, { status: ev.step.status, ms: ev.step.ms, credits: ev.step.credits, output: ev.step.output, error: ev.step.error, branch: ev.step.branch }); store.saveSoon(); }
        }
      },
    });
    finish(runId, result);
  }

  function stop(actor, id) {
    const run = db().runs.find(r => r.id === id);
    if (!run || !canSee(actor, run)) return fail(404, 'No such run.');
    if (actor.user.role === 'superadmin' || (run.user_id !== actor.user.id && actor.user.role !== 'admin')) return fail(403, 'Only the person who started a run, or a company admin, can stop it.');
    if (run.status !== 'running') return fail(409, 'This run has already finished.');
    if (run.stop_requested) return ok(200, { run: view(db(), run, true) });   // already asked: do not grow the log or rewrite the file again
    if (actor.by) Audit.record(db(), actor, 'run.stop', run.id, run.tenant_id, { flow: run.flow_name });
    run.stop_requested = true; run.logs.push({ at: iso(), level: 'warn', node_id: null, message: `Stop requested by ${actor.by ? actor.by.name + ' (as ' + actor.user.name + ')' : actor.user.name}.` });
    store.save();
    return ok(200, { run: view(db(), run, true) });
  }

  /** Runs that were in progress when the server stopped can never finish: mark them failed. Returns how many. */
  function recover() {
    let n = 0;
    for (const run of db().runs) {
      if (run.status !== 'running' || active.has(run.id)) continue;
      run.status = 'failed'; run.ended_at = iso(); run.error = 'The server restarted while this run was in progress, so it was stopped. Run the flow again.'; run.error_code = 'interrupted'; n += 1;
      for (const s of db().runSteps) if (s.run_id === run.id && s.status === 'running') s.status = 'failed';
    }
    if (n) store.save();
    return n;
  }

  return { start, stop, recover, whenDone: id => (active.has(id) ? active.get(id).promise : Promise.resolve()), allDone: () => [...active.values()].map(a => a.promise), activeCount: () => active.size,
    list: (actor, q) => listRuns(db(), actor, q), get: (actor, id) => getRun(db(), actor, id) };
}

module.exports = { createRunner, listRuns, getRun, canSee };
