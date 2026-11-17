/* AgentFlow engine: validation (shown on the cards) and the runner (Start -> follow connections -> pass each output on).
 * The runner is pure: it talks to providers, credits and storage only through the options it is given, so the server can run it
 * against real data and tests can run it against fakes. UMD: browser (AF.engine), server, tests. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./nodes.js'), require('./billing.js'));
  else { root.AF = root.AF || {}; root.AF.engine = factory(root.AF.nodes, root.AF.credits); }
})(typeof self !== 'undefined' ? self : this, function (Nodes, Credits) {
  'use strict';

  const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
  const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
  /** The built-in card a node really is: custom cards (even ones later removed from "My cards") count as their base card. */
  const effective = n => { const d = Nodes.get(n.type); if (d && d.custom) return d.base; if (!d && n.base && Nodes.get(n.base)) return n.base; return n.type; };
  const empty = v => v === undefined || v === null || (typeof v === 'string' && v.trim() === '');

  function portProblem(from, fromPort, to, toPort) {
    const fp = Nodes.portsOf(from), tp = Nodes.portsOf(to);
    if (!fp || !tp) return null; // unknown card types are reported separately
    if (!tp.in) return (effective(to) === 'start' ? 'Start' : 'This') + ' cards begin the flow, so nothing can connect into them.';
    if (!fp.out.length) return (effective(from) === 'end' ? 'End' : 'This') + ' cards finish the flow, so nothing can come out of them.';
    if (!fp.out.includes(fromPort)) return ['yes', 'no'].includes(fromPort) ? `Only Condition cards have a ${fromPort.toUpperCase()} output.` : `This card has no "${fromPort}" output.`;
    if (toPort !== 'in') return 'Connections must end at the input (the left side) of a card.';
    return null;
  }

  /** null when the connection is allowed, otherwise a sentence that says why not. */
  function checkConnection(nodes, edges, fromId, fromPort, toId, toPort) {
    const from = nodes.find(n => n.id === fromId), to = nodes.find(n => n.id === toId);
    if (!from || !to) return 'That card no longer exists.';
    if (fromId === toId) return 'A card cannot connect to itself.';
    const p = portProblem(from, fromPort, to, toPort);
    if (p) return p;
    if (edges.some(e => e.from === fromId && (e.fromPort || 'out') === fromPort && e.to === toId && (e.toPort || 'in') === toPort)) return 'Those two cards are already connected.';
    return null;
  }

  /** Strongly connected components (Tarjan) over the given adjacency; returns arrays of node ids. */
  function components(ids, adj) {
    const index = new Map(), low = new Map(), onStack = new Set(), stack = [], out = []; let i = 0;
    const visit = v => {
      index.set(v, i); low.set(v, i); i += 1; stack.push(v); onStack.add(v);
      for (const w of adj.get(v) || []) {
        if (!index.has(w)) { visit(w); low.set(v, Math.min(low.get(v), low.get(w))); } else if (onStack.has(w)) low.set(v, Math.min(low.get(v), index.get(w)));
      }
      if (low.get(v) === index.get(v)) { const comp = []; let w; do { w = stack.pop(); onStack.delete(w); comp.push(w); } while (w !== v); out.push(comp); }
    };
    for (const v of ids) if (!index.has(v)) visit(v);
    return out;
  }

  /** Checks a whole flow. Returns {ok, errors:[{code,node_id,edge_id,message}], by_node:{id:[messages]}}. Never throws. */
  function validateFlow(rawNodes, rawEdges) {
    const errors = [];
    const add = (code, nodeId, message, edgeId) => errors.push({ code, node_id: nodeId || null, edge_id: edgeId || null, message });
    const finish = () => {
      const by_node = {};
      for (const e of errors) if (e.node_id) (by_node[e.node_id] = by_node[e.node_id] || []).push(e.message);
      return { ok: errors.length === 0, errors, by_node };
    };
    if (!Array.isArray(rawNodes) || !Array.isArray(rawEdges) || !rawNodes.length) { add('empty', null, 'This flow has no cards yet. Drag a Start card onto the canvas, then add the steps you need.'); return finish(); }
    const nodes = rawNodes.filter(isObj), edges = rawEdges.filter(isObj);
    if (nodes.length !== rawNodes.length || edges.length !== rawEdges.length) add('broken_entries', null, 'The flow contains broken entries (not cards or connections). Re-create the flow or restore an earlier version.');
    const byId = new Map(nodes.map(n => [n.id, n]));

    const unknown = new Set();
    for (const n of nodes) if (!Nodes.get(n.type) && !(n.base && Nodes.get(n.base))) { unknown.add(n.id); add('unknown_type', n.id, `Unknown card type "${n.type}". Delete this card or add it back from the library.`); }

    const starts = nodes.filter(n => effective(n) === 'start');
    const ends = nodes.filter(n => effective(n) === 'end');
    if (!starts.length) add('no_start', null, 'Add a Start card. Every flow begins at Start.');
    starts.slice(1).forEach(n => add('many_start', n.id, 'Only one Start card is allowed. Delete this one or reuse the first.'));
    if (!ends.length) add('no_end', null, 'Add an End card so the flow knows where it finishes.');

    const good = []; // edges that point at real cards with valid ports
    for (const e of edges) {
      const from = byId.get(e.from), to = byId.get(e.to);
      let problem = null;
      if (!from || !to) problem = 'A connection points at a card that no longer exists. Delete the connection.';
      else if (from.id === to.id) problem = 'A card cannot connect to itself.';
      else problem = portProblem(from, e.fromPort || 'out', to, e.toPort || 'in');
      if (problem) add('invalid_connection', from ? from.id : null, problem, e.id); else good.push(e);
    }

    const touched = new Set(); const out = new Map(nodes.map(n => [n.id, []])); const back = new Map(nodes.map(n => [n.id, []]));
    for (const e of good) { touched.add(e.from); touched.add(e.to); out.get(e.from).push(e.to); back.get(e.to).push(e.from); }

    const reach = (seeds, adj) => { const seen = new Set(seeds); const q = [...seeds]; while (q.length) for (const w of adj.get(q.shift()) || []) if (!seen.has(w)) { seen.add(w); q.push(w); } return seen; };
    const fromStart = starts.length ? reach([starts[0].id], out) : new Set();
    const toEnd = ends.length ? reach(ends.map(n => n.id), back) : null;

    for (const n of nodes) {
      if (unknown.has(n.id)) continue;
      const isLoneFlow = nodes.length === 1;
      if (!touched.has(n.id) && !isLoneFlow) add('unconnected', n.id, 'This card is not connected to anything. Connect it to the flow, or delete it.');
      else if (starts.length && touched.has(n.id) && !fromStart.has(n.id) && effective(n) !== 'start') add('unreachable', n.id, 'This card is never reached from Start. Connect it to a card that is.');
      else if (toEnd && touched.has(n.id) && fromStart.has(n.id) && !toEnd.has(n.id)) add('dead_end', n.id, 'This card does not lead to an End card. Connect it onward.');

      const eff = effective(n);
      for (const f of Nodes.fieldsOf(eff)) {
        const v = (n.config || {})[f.name];
        if (f.required && empty(v)) { add('missing_field', n.id, `Fill in "${f.label}".`); continue; }
        if (empty(v)) continue;
        if (f.type === 'email' && !EMAIL.test(String(v))) add('invalid_field', n.id, `"${f.label}" must be an email address like name@company.com.`);
        else if (f.type === 'number') {
          const num = Number(v); const bad = typeof v === 'boolean' || Array.isArray(v) || !isFinite(num) || (f.integer && !Number.isInteger(num)) || (f.min !== undefined && num < f.min) || (f.max !== undefined && num > f.max);
          if (bad) add('invalid_field', n.id, `"${f.label}" must be a ${f.integer ? 'whole ' : ''}number from ${f.min} to ${f.max}.`);
        } else if (f.type === 'select' && !f.options.some(o => o.value === v)) add('invalid_field', n.id, `Choose one of the options for "${f.label}".`);
      }
      if (eff === 'python_code' && !empty((n.config || {}).code)) { const pm = Nodes.validatePython(n.config.code); if (pm) add('invalid_field', n.id, pm); }

      const outs = good.filter(e => e.from === n.id).map(e => e.fromPort || 'out');
      if (eff === 'condition') {
        if (!outs.includes('yes')) add('branch_missing', n.id, 'Connect the YES branch, so the flow knows what to do when the check passes.');
        if (!outs.includes('no')) add('branch_missing', n.id, 'Connect the NO branch, so the flow knows what to do when the check fails.');
      }
      if (eff === 'loop') {
        if (!outs.includes('each')) add('branch_missing', n.id, 'Connect the EACH branch, the steps to repeat.');
        if (!outs.includes('done')) add('branch_missing', n.id, 'Connect the DONE branch, where the flow continues after the last repeat.');
      }
    }

    // Cycles are only allowed when they go round through a Loop's EACH branch. Take those edges out and look for what is left.
    const adj = new Map(nodes.map(n => [n.id, []]));
    for (const e of good) { const from = byId.get(e.from); if (effective(from) === 'loop' && (e.fromPort || 'out') === 'each') continue; adj.get(e.from).push(e.to); }
    for (const comp of components(nodes.map(n => n.id), adj)) {
      if (comp.length < 2) continue;
      for (const id of comp) add('cycle', id, 'This card is part of a cycle. Use a Loop card if you want steps to repeat on purpose (a repeat must go back through the Loop\'s EACH branch).');
    }
    return finish();
  }

  // ---------------------------------------------------------------- the runner
  const clip = (s, n = 4000) => { const t = s == null ? '' : String(s); return t.length > n ? t.slice(0, n) + `… (${t.length - n} more characters)` : t; };

  /** Runs a flow. opts: {providers, sleep(ms), isStopped(), charge(node,cost)->{ok,code,message}, refund(node,cost), onEvent(ev), input, maxSteps}.
   *  Resolves to {status:'success'|'failed'|'stopped', output, result_title, error, code, problems, steps, logs, vars, credits}. Never throws. */
  async function run(flow, opts) {
    const o = opts || {}; const sleep = o.sleep || (() => Promise.resolve()); const maxSteps = o.maxSteps || 200;
    const result = { status: 'success', output: null, result_title: null, error: null, code: null, problems: null, steps: [], logs: [], vars: {}, credits: 0 };
    const emit = ev => { if (o.onEvent) o.onEvent(ev); };
    const log = (message, node, level) => { const l = { at: new Date().toISOString(), level: level || 'info', node_id: node ? node.id : null, message }; result.logs.push(l); emit({ type: 'log', log: l }); };
    const nodes = ((flow && flow.nodes) || []).filter(isObj); const edges = ((flow && flow.edges) || []).filter(isObj);
    emit({ type: 'run_start' });
    const check = validateFlow(nodes, edges);
    if (!check.ok) {
      result.status = 'failed'; result.code = 'invalid_flow'; result.problems = check.errors;
      result.error = `This flow has ${check.errors.length} problem${check.errors.length === 1 ? '' : 's'}. Fix ${check.errors.length === 1 ? 'it' : 'them'} in the builder, then run again.`;
      log(result.error, null, 'error'); emit({ type: 'run_end', status: result.status }); return result;
    }
    const byId = new Map(nodes.map(n => [n.id, n]));
    const outs = (id, port) => edges.filter(e => e.from === id && (e.fromPort || 'out') === port);
    let count = 0; let failed = false; let stopped = false;
    const stopNow = () => { if (!stopped && o.isStopped && o.isStopped()) stopped = true; return stopped; };
    const fail = (code, message, node) => { if (!failed) { failed = true; result.code = code; result.error = message; } log(message, node, 'error'); };

    async function visit(id, input, stack, loopInfo) {
      if (failed || stopNow()) return input;
      if (stack.includes(id)) return input;                       // back into an active loop: this round is finished
      const node = byId.get(id); const eff = effective(node);
      if (count >= maxSteps) { fail('too_many_steps', `This flow ran more than ${maxSteps} steps and was stopped. Check for a Loop that repeats too many times.`, node); return input; }
      count += 1;
      const step = { n: count, node_id: id, label: node.label, type: eff, status: 'running', input: clip(input), output: null, error: null, credits: 0, ms: 0, branch: null, loop_index: loopInfo ? loopInfo.index : null };
      result.steps.push(step); emit({ type: 'step_start', step: { ...step } });
      const t0 = Date.now(); const cost = Credits.costOf(node.type, { base: node.base });
      const finish = (status, error, code) => {
        step.status = status; step.error = error || null; step.ms = Date.now() - t0;
        if (status === 'failed') { log(`${node.label} failed: ${error}`, node, 'error'); fail(code || 'step_error', error, node); }
        emit({ type: 'step_end', step: { ...step } });
      };
      if (cost > 0) {
        if (o.charge) {   // the caller decides whether this card may run (the server checks the account's credits)
          const c = await o.charge(node, cost);
          if (!c || !c.ok) { finish('failed', (c && c.message) || 'Not enough credits to run this card.', (c && c.code) || 'credits_exhausted'); return input; }
        }
        step.credits = cost; result.credits += cost;
      }
      let r;
      try {
        const config = Object.assign({}, Nodes.defaults(node.type), node.config || {});
        const def = Nodes.get(eff);
        const ctx = { config, input: eff === 'start' && empty(config.input_text) && o.input != null ? o.input : (eff === 'start' ? config.input_text : input), providers: o.providers || {}, log: m => log(m, node), node, loop: loopInfo || null };
        log(`Running ${node.label}…`, node);
        r = await def.run(ctx);
        await sleep(r.latency || 0);
      } catch (e) {
        if (step.credits > 0) { if (o.refund) await o.refund(node, step.credits); result.credits -= step.credits; step.credits = 0; }   // a card that failed costs nothing
        finish('failed', (e && e.message) || 'This card failed.', (e && e.code) || 'step_error');
        return input;
      }
      step.output = clip(r.output); step.branch = r.branch || null; result.vars[id] = clip(r.output);
      finish('success'); log(`${node.label} finished` + (step.branch ? ` (${step.branch.toUpperCase()})` : '') + '.', node);
      const output = r.output;
      if (eff === 'end') { result.output = output; result.result_title = (node.config && node.config.result_title) || null; return output; }
      if (eff === 'condition') { let last = output; for (const e of outs(id, r.branch)) last = await visit(e.to, output, stack, loopInfo); return last; }
      if (eff === 'loop') {
        const times = Math.max(1, Math.min(10, Number((node.config || {}).count) || 1)); let value = output;
        for (let i = 1; i <= times && !failed && !stopNow(); i += 1) {
          log(`Loop round ${i} of ${times}.`, node);
          for (const e of outs(id, 'each')) value = await visit(e.to, value, stack.concat(id), { index: i, count: times });
        }
        let last = value; for (const e of outs(id, 'done')) last = await visit(e.to, value, stack, loopInfo); return last;
      }
      let last = output; for (const e of outs(id, 'out')) last = await visit(e.to, output, stack, loopInfo); return last;
    }

    const start = nodes.find(n => effective(n) === 'start');
    const final = await visit(start.id, '', [], null);
    if (result.output === null && !failed && !stopped) result.output = final;
    result.status = failed ? 'failed' : stopped ? 'stopped' : 'success';
    if (stopped) { result.output = null; log('The run was stopped.', null, 'warn'); }
    emit({ type: 'run_end', status: result.status });
    return result;
  }

  return { validateFlow, checkConnection, effective, run };
});
