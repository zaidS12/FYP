'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const N = require('../../assets/js/nodes.js');
const E = require('../../assets/js/engine.js');
const { FakeAIProvider } = require('../../assets/js/adapters/ai.js');
const { FakeSearchProvider } = require('../../assets/js/adapters/search.js');
const { FakeMailProvider } = require('../../assets/js/adapters/mail.js');

const providers = () => ({ ai: new FakeAIProvider(), search: new FakeSearchProvider(), mail: new FakeMailProvider() });
const node = (id, type, config = {}, extra) => Object.assign({ id, type, label: id, x: 0, y: 0, config: Object.assign(N.defaults(type), config) }, extra);
const edge = (id, from, to, fromPort = 'out') => ({ id, from, fromPort, to, toPort: 'in' });
const quiet = extra => Object.assign({ providers: providers(), sleep: async () => {} }, extra);
const TEXT = 'AI is moving fast. Models got cheaper. Teams adopt agents. Regulation is coming. Final line here.';
const digest = (over = {}) => ({
  nodes: [node('s', 'start', { input_text: TEXT }), node('a', 'search_web', Object.assign({ query: 'ai news', max_results: 3 }, over.search)), node('b', 'summarize', { style: 'bullets', max_words: 40 }), node('m', 'write_email', Object.assign({ to: 'team@brightloom.test', subject: 'Digest' }, over.mail)), node('e', 'end')],
  edges: [edge('1', 's', 'a'), edge('2', 'a', 'b'), edge('3', 'b', 'm'), edge('4', 'm', 'e')],
});
const types = r => r.steps.map(s => s.type);

test('conditions: length, contains, starts with, equals, empty and their negations', () => {
  const ev = N.evalCondition;
  assert.deepEqual(ev('length > 5', 'abcdef'), { ok: true, value: true });
  assert.equal(ev('length < 3', 'abcdef').value, false);
  assert.equal(ev('length >= 6', 'abcdef').value, true); assert.equal(ev('length <= 5', 'abcdef').value, false); assert.equal(ev('length == 6', 'abcdef').value, true);
  assert.equal(ev('contains "err"', 'An Error happened').value, true, 'case-insensitive');
  assert.equal(ev('not contains "x"', 'abc').value, true);
  assert.equal(ev('starts with "ab"', 'abc').value, true);
  assert.equal(ev('equals "hi"', 'Hi').value, true);
  assert.equal(ev('is empty', '  ').value, true); assert.equal(ev('not empty', '').value, false);
  for (const bad of ['banana', 'length >', 'contains', 'length > abc', '']) assert.equal(ev(bad, 'x').ok, false, bad);
  assert.match(ev('banana', 'x').error, /Could not understand the check "banana"/);
});

test('a chain runs in order, passes each output to the next card, and charges per card', async () => {
  const p = providers(); const events = [];
  const r = await E.run(digest(), quiet({ providers: p, onEvent: e => events.push(e) }));
  assert.equal(r.status, 'success');
  assert.deepEqual(types(r), ['start', 'search_web', 'summarize', 'write_email', 'end']);
  assert.ok(r.steps.every(s => s.status === 'success' && typeof s.ms === 'number'));
  assert.equal(r.credits, 7);
  assert.equal(r.steps[2].input, r.steps[1].output, 'summarize receives what search produced');
  assert.equal(r.steps[3].input, r.steps[2].output);
  assert.match(r.output, /Sent to team@brightloom\.test/);
  assert.equal(p.mail.sent.length, 1); assert.equal(p.mail.sent[0].subject, 'Digest');
  assert.equal(r.vars.a, r.steps[1].output, 'context variables hold each card output');
  assert.equal(events[0].type, 'run_start'); assert.equal(events[events.length - 1].type, 'run_end');
  const started = events.filter(e => e.type === 'step_start').map(e => e.step.n); const ended = events.filter(e => e.type === 'step_end').map(e => e.step.n);
  assert.deepEqual(started, ended);
  assert.ok(r.logs.length >= 5 && r.logs.every(l => l.message));
});

test('Condition picks the YES or NO branch and records which one', async () => {
  const flow = text => ({ nodes: [node('s', 'start', { input_text: text }), node('c', 'condition', { expression: 'length > 10' }), node('y', 'end', { result_title: 'Long' }), node('n', 'end', { result_title: 'Short' })], edges: [edge('1', 's', 'c'), edge('2', 'c', 'y', 'yes'), edge('3', 'c', 'n', 'no')] });
  const short = await E.run(flow('short'), quiet());
  assert.deepEqual(types(short), ['start', 'condition', 'end']); assert.equal(short.result_title, 'Short'); assert.equal(short.steps[1].branch, 'no');
  const long = await E.run(flow('this text is long enough'), quiet());
  assert.equal(long.result_title, 'Long'); assert.equal(long.steps[1].branch, 'yes');
  const bad = await E.run({ ...flow('x'), nodes: [node('s', 'start', { input_text: 'x' }), node('c', 'condition', { expression: 'banana' }), node('y', 'end'), node('n', 'end')] }, quiet());
  assert.equal(bad.status, 'failed'); assert.equal(bad.code, 'bad_expression'); assert.match(bad.error, /Could not understand the check "banana"/);
  assert.equal(bad.steps[1].status, 'failed');
});

test('Loop repeats the EACH branch, feeds the result back in, then continues on DONE', async () => {
  const flow = count => ({ nodes: [node('s', 'start', { input_text: 'Hello' }), node('l', 'loop', { count }), node('t', 'translate', { target_language: 'Urdu' }), node('e', 'end')], edges: [edge('1', 's', 'l'), edge('2', 'l', 't', 'each'), edge('3', 't', 'l'), edge('4', 'l', 'e', 'done')] });
  const r = await E.run(flow(3), quiet());
  assert.equal(r.status, 'success');
  assert.deepEqual(types(r), ['start', 'loop', 'translate', 'translate', 'translate', 'end']);
  assert.deepEqual(r.steps.filter(s => s.type === 'translate').map(s => s.loop_index), [1, 2, 3]);
  assert.equal((r.output.match(/translation, simulated/g) || []).length, 3, 'each round works on the previous round result');
  assert.equal(r.credits, 1 + 3 * 2);
  const guarded = await E.run(flow(10), quiet({ maxSteps: 6 }));
  assert.equal(guarded.status, 'failed'); assert.equal(guarded.code, 'too_many_steps'); assert.match(guarded.error, /more than 6 steps/);
});

test('a failing provider fails that step, stops the run, skips the rest and refunds the credits', async () => {
  let spent = 0; const refunds = []; const p = providers();
  const r = await E.run(digest({ search: { query: 'news [fail]' } }), quiet({ providers: p, charge: async (n, c) => { spent += c; return { ok: true }; }, refund: async (n, c) => { spent -= c; refunds.push(n.id); } }));
  assert.equal(r.status, 'failed'); assert.equal(r.code, 'search_timeout'); assert.match(r.error, /timed out/);
  assert.deepEqual(r.steps.map(s => s.status), ['success', 'failed']);
  assert.match(r.steps[1].error, /timed out/); assert.equal(r.steps[1].credits, 0);
  assert.equal(spent, 0); assert.deepEqual(refunds, ['a']); assert.equal(r.credits, 0);
  assert.equal(p.mail.sent.length, 0);
  const bounced = await E.run(digest({ mail: { to: 'x@bounce.test' } }), quiet());
  assert.equal(bounced.status, 'failed'); assert.equal(bounced.code, 'mail_rejected'); assert.equal(bounced.credits, 5, 'cards that worked are still charged; only the failed card is refunded');
});

test('credits are checked before a card runs, and the run stops with a clear message when they are gone', async () => {
  let spent = 0; const p = providers(); let aiCalls = 0; const orig = p.ai.summarize.bind(p.ai); p.ai.summarize = async x => { aiCalls++; return orig(x); };
  const charge = async (n, c) => { if (spent + c > 3) return { ok: false, code: 'credits_exhausted', message: `Not enough credits: "${n.label}" needs ${c} and ${3 - spent} left.` }; spent += c; return { ok: true }; };
  const r = await E.run(digest(), quiet({ providers: p, charge }));
  assert.equal(r.status, 'failed'); assert.equal(r.code, 'credits_exhausted'); assert.match(r.error, /Not enough credits/);
  assert.deepEqual(r.steps.map(s => s.status), ['success', 'success', 'failed']);
  assert.equal(aiCalls, 0, 'the card that could not be paid for never ran'); assert.equal(p.mail.sent.length, 0);
  assert.equal(r.credits, 2);
});

test('Stop ends the run cleanly between cards', async () => {
  let ended = 0;
  const r = await E.run(digest(), quiet({ onEvent: e => { if (e.type === 'step_end') ended++; }, isStopped: () => ended >= 2 }));
  assert.equal(r.status, 'stopped'); assert.equal(r.steps.length, 2); assert.equal(r.output, null);
});

test('a flow with problems is refused before anything runs or is charged', async () => {
  let charged = 0;
  const r = await E.run({ nodes: [node('s', 'start'), node('a', 'summarize')], edges: [edge('1', 's', 'a')] }, quiet({ charge: async () => { charged++; return { ok: true }; } }));
  assert.equal(r.status, 'failed'); assert.equal(r.code, 'invalid_flow'); assert.deepEqual(r.steps, []); assert.ok(r.problems.length > 0); assert.equal(charged, 0);
});

test('fan-out runs every connected branch, one after another', async () => {
  const flow = { nodes: [node('s', 'start', { input_text: TEXT }), node('a', 'summarize'), node('b', 'translate', { target_language: 'French' }), node('e', 'end')], edges: [edge('1', 's', 'a'), edge('2', 's', 'b'), edge('3', 'a', 'e'), edge('4', 'b', 'e')] };
  const r = await E.run(flow, quiet());
  assert.deepEqual(types(r), ['start', 'summarize', 'end', 'translate', 'end']);
  assert.match(r.output, /French translation/, 'the last End reached provides the result');
});

test('Timer passes data through; Python is checked but never executed', async () => {
  const flow = { nodes: [node('s', 'start', { input_text: 'abc' }), node('t', 'timer', { schedule: 'every_day', time: '08:00' }), node('p', 'python_code', { code: 'result = input_text.upper()' }), node('e', 'end')], edges: [edge('1', 's', 't'), edge('2', 't', 'p'), edge('3', 'p', 'e')] };
  const r = await E.run(flow, quiet());
  assert.equal(r.status, 'success'); assert.equal(r.output, 'abc', 'unchanged: ABC would mean the code ran');
  assert.ok(r.logs.some(l => /every day at 08:00/i.test(l.message))); assert.ok(r.logs.some(l => /checked but not run/i.test(l.message)));
});

test('dangerous or broken Python is rejected by validation, safe code passes', () => {
  const flowWith = code => ({ nodes: [node('s', 'start'), node('p', 'python_code', { code }), node('e', 'end')], edges: [edge('1', 's', 'p'), edge('2', 'p', 'e')] });
  for (const [code, word] of [['import os\nos.system("rm -rf /")', 'os'], ['import subprocess', 'subprocess'], ['x = eval("1+1")', 'eval'], ['f = open("/etc/passwd")', 'open'], ['__import__("socket")', '__import__'], ['print((1, 2)', 'bracket']]) {
    const v = E.validateFlow(flowWith(code).nodes, flowWith(code).edges);
    assert.equal(v.ok, false, code); assert.ok(v.by_node.p.some(m => m.includes(word)), code + ' -> ' + JSON.stringify(v.by_node.p));
  }
  assert.equal(E.validateFlow(flowWith('result = input_text.upper()').nodes, flowWith('result = input_text.upper()').edges).ok, true);
});

test('research uses search results; custom cards run as the card they were made from', async () => {
  const flow = { nodes: [node('s', 'start'), node('r', 'research_bot', { topic: 'pricing', depth: 'quick' }), node('e', 'end')], edges: [edge('1', 's', 'r'), edge('2', 'r', 'e')] };
  const r = await E.run(flow, quiet());
  assert.match(r.output, /Research notes on "pricing"/); assert.equal(r.credits, 6);
  N.registerCustom({ id: 'custom_tr', label: 'To Urdu', base: 'translate', config: { target_language: 'Urdu' } });
  const custom = { nodes: [node('s', 'start', { input_text: 'Hi' }), N.makeNode('custom_tr', 0, 0, 'c'), node('e', 'end')], edges: [edge('1', 's', 'c'), edge('2', 'c', 'e')] };
  const c = await E.run(custom, quiet());
  assert.equal(c.status, 'success'); assert.match(c.output, /Urdu translation/); assert.equal(c.credits, 2);
  N.unregisterCustom('custom_tr');
  const orphan = await E.run(custom, quiet());
  assert.equal(orphan.status, 'success', 'a removed custom card keeps working as its base card');
});
