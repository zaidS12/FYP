'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { mergeGraph, changedNodeIds } = require('../../server/services/merge.js');

const n = (id, label = id, config = {}, x = 0, y = 0) => ({ id, type: 'summarize', label, x, y, config });
const e = (id, from, to) => ({ id, from, fromPort: 'out', to, toPort: 'in' });
const G = (nodes, edges = [], name = 'F') => ({ name, nodes, edges });

const base = G([n('a'), n('b'), n('c')], [e('e1', 'a', 'b'), e('e2', 'b', 'c')]);

test('edits to DIFFERENT cards merge cleanly', () => {
  const mine = G([n('a', 'A mine'), n('b'), n('c')], base.edges);
  const theirs = G([n('a'), n('b', 'B theirs'), n('c')], base.edges);
  const r = mergeGraph(base, mine, theirs);
  assert.equal(r.ok, true);
  assert.deepEqual(r.merged.nodes.map(x => x.label), ['a', 'B theirs', 'c'].map((l, i) => (i === 0 ? 'A mine' : l)));
});

test('the same card changed the same way on both sides is fine; changed differently is a conflict naming the card', () => {
  const same = mergeGraph(base, G([n('a', 'X'), n('b'), n('c')], base.edges), G([n('a', 'X'), n('b'), n('c')], base.edges));
  assert.equal(same.ok, true);
  const r = mergeGraph(base, G([n('a', 'Mine'), n('b'), n('c')], base.edges), G([n('a', 'Theirs'), n('b'), n('c')], base.edges));
  assert.equal(r.ok, false);
  assert.deepEqual(r.conflicts.map(c => c.node_id), ['a']);
  assert.match(r.conflicts[0].reason, /both/i);
});

test('cards added by both sides are kept; a card removed by one side stays removed when the other left it alone', () => {
  const mine = G([n('a'), n('b'), n('c'), n('m1')], base.edges);
  const theirs = G([n('a'), n('b'), n('t1')], [e('e1', 'a', 'b')]);
  const r = mergeGraph(base, mine, theirs);
  assert.equal(r.ok, true);
  assert.deepEqual(r.merged.nodes.map(x => x.id).sort(), ['a', 'b', 'm1', 't1']);
  assert.deepEqual(r.merged.edges.map(x => x.id), ['e1'], 'edge to the removed card is gone');
});

test('deleting a card the other side edited is a conflict', () => {
  const mine = G([n('a'), n('b')], [e('e1', 'a', 'b')]);
  const theirs = G([n('a'), n('b'), n('c', 'edited')], base.edges);
  const r = mergeGraph(base, mine, theirs);
  assert.equal(r.ok, false); assert.equal(r.conflicts[0].node_id, 'c');
});

test('connections: additions from both sides are unioned, removals from either side apply', () => {
  const mine = G(base.nodes, [e('e1', 'a', 'b'), e('e2', 'b', 'c'), e('e3', 'a', 'c')]);
  const theirs = G(base.nodes, [e('e2', 'b', 'c')]);
  const r = mergeGraph(base, mine, theirs);
  assert.equal(r.ok, true);
  assert.deepEqual(r.merged.edges.map(x => x.id).sort(), ['e2', 'e3']);
});

test('flow rename: one side wins when only one renamed; both renamed differently conflicts', () => {
  assert.equal(mergeGraph(base, G(base.nodes, base.edges, 'New'), G(base.nodes, base.edges, 'F')).merged.name, 'New');
  assert.equal(mergeGraph(base, G(base.nodes, base.edges, 'A'), G(base.nodes, base.edges, 'B')).ok, false);
});

test('moving a card counts as changing it', () => {
  const r = mergeGraph(base, G([n('a', 'a', {}, 50, 50), n('b'), n('c')], base.edges), G([n('a', 'a', {}, 90, 90), n('b'), n('c')], base.edges));
  assert.equal(r.ok, false);
});

test('changedNodeIds lists cards added, removed or edited relative to the base', () => {
  const mine = G([n('a', 'changed'), n('c'), n('z')], base.edges);
  assert.deepEqual(changedNodeIds(base, mine).sort(), ['a', 'b', 'z']);
  assert.deepEqual(changedNodeIds(base, base), []);
});

test('two people who each add a different card with the same new id both keep their card (mine is renamed, its connections follow)', () => {
  const mine = G([...base.nodes, n('n9', 'Mine')], [...base.edges, e('e7', 'c', 'n9')]);
  const theirs = G([...base.nodes, n('n9', 'Theirs')], base.edges);
  const r = mergeGraph(base, mine, theirs);
  assert.equal(r.ok, true);
  assert.deepEqual(r.merged.nodes.map(x => x.label).sort(), ['Mine', 'Theirs', 'a', 'b', 'c']);
  const renamed = r.merged.nodes.find(x => x.label === 'Mine').id;
  assert.notEqual(renamed, 'n9');
  assert.ok(r.merged.edges.some(x => x.from === 'c' && x.to === renamed));
});

test('two different connections that were both drawn as "e5" keep both, with unique ids', () => {
  const b2 = G([n('a'), n('b'), n('c')], [e('e1', 'a', 'b')]);
  const r = mergeGraph(b2, G(b2.nodes, [...b2.edges, e('e2', 'b', 'c')]), G(b2.nodes, [...b2.edges, e('e2', 'a', 'c')]));
  assert.equal(r.ok, true);
  assert.equal(r.merged.edges.length, 3);
  assert.equal(new Set(r.merged.edges.map(x => x.id)).size, 3);
});

test('key order inside a card does not look like a change', () => {
  const x = { id: 'a', type: 'summarize', label: 'a', x: 0, y: 0, config: { style: 'bullets', max_words: 5 } };
  const y = { id: 'a', type: 'summarize', label: 'a', x: 0, y: 0, config: { max_words: 5, style: 'bullets' } };
  assert.deepEqual(changedNodeIds(G([x]), G([y])), []);
});

test('changedNodeIds counts both ends of an added or removed connection', () => {
  const mine = G(base.nodes, [e('e1', 'a', 'b'), e('e9', 'a', 'c')]);
  assert.deepEqual(changedNodeIds(base, mine).sort(), ['a', 'b', 'c']);
});
