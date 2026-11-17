'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const N = require('../../assets/js/nodes.js');
const E = require('../../assets/js/engine.js');

const node = (id, type, config = {}, extra = {}) => Object.assign({ id, type, label: id, x: 0, y: 0, config }, extra);
const edge = (id, from, to, fromPort = 'out') => ({ id, from, fromPort, to, toPort: 'in' });
const GOOD_NODES = () => [node('s', 'start'), node('a', 'search_web', { query: 'ai' }), node('b', 'summarize'), node('e', 'end')];
const GOOD_EDGES = () => [edge('1', 's', 'a'), edge('2', 'a', 'b'), edge('3', 'b', 'e')];
const codes = r => r.errors.map(e => e.code).sort();

test('a complete flow validates cleanly', () => {
  const r = E.validateFlow(GOOD_NODES(), GOOD_EDGES());
  assert.deepEqual(r, { ok: true, errors: [], by_node: {} });
});

test('missing Start and missing End are reported on the flow, not a card', () => {
  const noStart = E.validateFlow([node('e', 'end')], []);
  assert.ok(codes(noStart).includes('no_start')); assert.equal(noStart.errors.find(e => e.code === 'no_start').node_id, null);
  const noEnd = E.validateFlow([node('s', 'start')], []);
  assert.ok(codes(noEnd).includes('no_end'));
  assert.match(noEnd.errors.find(e => e.code === 'no_end').message, /End card/);
  assert.ok(codes(E.validateFlow([], [])).includes('empty'));
});

test('only one Start card is allowed, and the extra one is marked', () => {
  const r = E.validateFlow([...GOOD_NODES(), node('s2', 'start')], [...GOOD_EDGES(), edge('9', 's2', 'a')]);
  assert.ok(codes(r).includes('many_start'));
  assert.deepEqual(r.by_node.s2.some(m => /Start/.test(m)), true);
});

test('unconnected cards and cards that never get reached are marked on the card itself', () => {
  const r = E.validateFlow([...GOOD_NODES(), node('lonely', 'translate', { target_language: 'Urdu' })], GOOD_EDGES());
  assert.ok(codes(r).includes('unconnected'));
  assert.match(r.by_node.lonely[0], /not connected/i);
  const island = E.validateFlow([...GOOD_NODES(), node('x', 'summarize'), node('y', 'summarize')], [...GOOD_EDGES(), edge('9', 'x', 'y')]);
  assert.ok(island.by_node.x.some(m => /never reached/i.test(m)));
});

test('a card that cannot lead to an End card is reported', () => {
  const nodes = [node('s', 'start'), node('a', 'summarize'), node('e', 'end')];
  const r = E.validateFlow(nodes, [edge('1', 's', 'a')]);
  assert.ok(r.by_node.a.some(m => /End card/.test(m)));
});

test('missing required settings are reported with the field name', () => {
  const nodes = [node('s', 'start'), node('m', 'write_email', { to: '', subject: 'Hi' }), node('e', 'end')];
  const r = E.validateFlow(nodes, [edge('1', 's', 'm'), edge('2', 'm', 'e')]);
  assert.deepEqual(codes(r), ['missing_field']);
  assert.match(r.by_node.m[0], /Send to/);
  const bad = E.validateFlow([node('s', 'start'), node('m', 'write_email', { to: 'not-an-email', subject: 'Hi' }), node('e', 'end')], [edge('1', 's', 'm'), edge('2', 'm', 'e')]);
  assert.ok(codes(bad).includes('invalid_field'));
});

test('a condition needs both its YES and its NO branch connected', () => {
  const nodes = [node('s', 'start'), node('c', 'condition', { expression: 'length > 5' }), node('y', 'end'), node('n', 'end')];
  const half = E.validateFlow(nodes, [edge('1', 's', 'c'), edge('2', 'c', 'y', 'yes')]);
  assert.ok(half.by_node.c.some(m => /NO/.test(m)));
  const full = E.validateFlow(nodes, [edge('1', 's', 'c'), edge('2', 'c', 'y', 'yes'), edge('3', 'c', 'n', 'no')]);
  assert.equal(full.ok, true);
});

test('cycles are errors unless a Loop card is part of them', () => {
  const nodes = [node('s', 'start'), node('a', 'summarize'), node('b', 'translate', { target_language: 'Urdu' }), node('e', 'end')];
  const cyc = E.validateFlow(nodes, [edge('1', 's', 'a'), edge('2', 'a', 'b'), edge('3', 'b', 'a'), edge('4', 'b', 'e')]);
  assert.ok(codes(cyc).includes('cycle')); assert.match(cyc.by_node.a.join(' '), /Loop/);
  const withLoop = [node('s', 'start'), node('l', 'loop', { count: 3 }), node('a', 'summarize'), node('e', 'end')];
  const ok = E.validateFlow(withLoop, [edge('1', 's', 'l'), edge('2', 'l', 'a', 'each'), edge('3', 'a', 'l'), edge('4', 'l', 'e', 'done')]);
  assert.equal(ok.ok, true, JSON.stringify(ok.errors));
  const self = E.validateFlow([node('s', 'start'), node('a', 'summarize'), node('e', 'end')], [edge('1', 's', 'a'), edge('2', 'a', 'a'), edge('3', 'a', 'e')]);
  assert.ok(codes(self).includes('invalid_connection'));
});

test('a Loop only excuses cycles that go round through its EACH branch', () => {
  const inner = E.validateFlow([node('s', 'start'), node('l', 'loop', { count: 2 }), node('a', 'summarize'), node('b', 'summarize'), node('e', 'end')],
    [edge('1', 's', 'l'), edge('2', 'l', 'a', 'each'), edge('3', 'a', 'b'), edge('4', 'b', 'a'), edge('5', 'b', 'l'), edge('6', 'l', 'e', 'done')]);
  assert.ok(inner.errors.some(e => e.code === 'cycle' && e.node_id === 'a'), 'the a-b cycle inside the loop body is still an error');
  const viaDone = E.validateFlow([node('s', 'start'), node('l', 'loop', { count: 2 }), node('x', 'summarize'), node('a', 'summarize'), node('e', 'end')],
    [edge('1', 's', 'l'), edge('2', 'l', 'x', 'each'), edge('3', 'x', 'l'), edge('4', 'l', 'a', 'done'), edge('5', 'a', 'l'), edge('6', 'a', 'e')]);
  assert.ok(viaDone.errors.some(e => e.code === 'cycle'), 'going back to the Loop from DONE is not a repeat');
});

test('a Condition may send YES and NO to the same card without any complaint', () => {
  const r = E.validateFlow([node('s', 'start'), node('c', 'condition', { expression: 'not empty' }), node('e', 'end')], [edge('1', 's', 'c'), edge('2', 'c', 'e', 'yes'), edge('3', 'c', 'e', 'no')]);
  assert.equal(r.ok, true, JSON.stringify(r.errors));
});

test('whole-number fields reject fractions, booleans and arrays', () => {
  const flow = count => [[node('s', 'start'), node('l', 'loop', { count }), node('a', 'summarize'), node('e', 'end')], [edge('1', 's', 'l'), edge('2', 'l', 'a', 'each'), edge('3', 'a', 'l'), edge('4', 'l', 'e', 'done')]];
  for (const bad of [2.5, true, [5], 0, 11, 'abc']) assert.ok(codes(E.validateFlow(...flow(bad))).includes('invalid_field'), JSON.stringify(bad));
  assert.equal(E.validateFlow(...flow(4)).ok, true);
});

test('null or non-object entries are reported instead of throwing', () => {
  const r = E.validateFlow([null, node('s', 'start'), 'x', node('e', 'end')], [edge('1', 's', 'e'), null]);
  assert.ok(codes(r).includes('broken_entries'));
  assert.doesNotThrow(() => E.validateFlow([undefined], [undefined]));
});

test('a card whose custom type was removed is still validated as its base card', () => {
  const orphan = { id: 'm', type: 'custom_gone', base: 'write_email', label: 'Mail', x: 0, y: 0, config: { to: '', subject: '' } };
  assert.equal(E.effective(orphan), 'write_email');
  const r = E.validateFlow([node('s', 'start'), orphan, node('e', 'end')], [edge('1', 's', 'm'), edge('2', 'm', 'e')]);
  assert.ok(r.by_node.m.some(m => /Send to/.test(m)));
  assert.ok(!r.errors.some(e => e.code === 'unknown_type'));
});

test('a loop needs both its EACH and DONE branches', () => {
  const nodes = [node('s', 'start'), node('l', 'loop', { count: 2 }), node('e', 'end')];
  const r = E.validateFlow(nodes, [edge('1', 's', 'l'), edge('2', 'l', 'e', 'done')]);
  assert.ok(r.by_node.l.some(m => /EACH/.test(m)));
});

test('checkConnection explains why a connection is not allowed', () => {
  const nodes = [node('s', 'start'), node('a', 'summarize'), node('c', 'condition'), node('e', 'end')];
  const edges = [edge('1', 's', 'a')];
  assert.equal(E.checkConnection(nodes, edges, 'a', 'out', 'e', 'in'), null);
  assert.match(E.checkConnection(nodes, edges, 'a', 'out', 'a', 'in'), /itself/);
  assert.match(E.checkConnection(nodes, edges, 'a', 'out', 's', 'in'), /Start/);
  assert.match(E.checkConnection(nodes, edges, 'e', 'out', 'a', 'in'), /End/);
  assert.match(E.checkConnection(nodes, edges, 's', 'out', 'a', 'in'), /already connected/);
  assert.match(E.checkConnection(nodes, edges, 'a', 'yes', 'e', 'in'), /YES/);
  assert.equal(E.checkConnection(nodes, edges, 'c', 'yes', 'e', 'in'), null);
  assert.match(E.checkConnection(nodes, edges, 'ghost', 'out', 'e', 'in'), /no longer/);
  assert.match(E.checkConnection(nodes, edges, 'a', 'out', 'e', 'out'), /input/);
});

test('validateFlow never throws on junk and puts messages under by_node', () => {
  const r = E.validateFlow([node('s', 'start'), node('q', 'mystery_type'), node('e', 'end')], [edge('1', 's', 'q'), edge('2', 'q', 'e'), edge('3', 's', 'ghost')]);
  assert.equal(r.ok, false);
  assert.ok(r.by_node.q.some(m => /unknown card type/i.test(m)));
  assert.ok(r.errors.some(e => e.code === 'invalid_connection' && e.edge_id === '3'));
  assert.doesNotThrow(() => E.validateFlow(null, null));
});

test('custom cards validate using the settings of the card they were made from', () => {
  N.registerCustom({ id: 'custom_mail', label: 'Weekly mail', base: 'write_email', config: { to: 'team@x.test', subject: 'Weekly' } });
  const nodes = [node('s', 'start'), N.makeNode('custom_mail', 0, 0, 'm'), node('e', 'end')];
  assert.equal(E.validateFlow(nodes, [edge('1', 's', 'm'), edge('2', 'm', 'e')]).ok, true);
  nodes[1].config.to = '';
  assert.ok(E.validateFlow(nodes, [edge('1', 's', 'm'), edge('2', 'm', 'e')]).by_node.m.length > 0);
  N.unregisterCustom('custom_mail');
});
