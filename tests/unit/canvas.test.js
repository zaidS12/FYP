'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const CV = require('../../assets/js/canvas.js');

const node = (id, type = 'summarize') => ({ id, type, label: id, x: 0, y: 0, config: {} });
const edge = (id, from, to, fromPort = 'out') => ({ id, from, fromPort, to, toPort: 'in' });

test('port positions sit on the card edge, with two outputs split top and bottom', () => {
  const n = { id: 'a', type: 'summarize', x: 100, y: 50 };
  assert.deepEqual(CV.portPosition(n, 'in', 'in'), { x: 100, y: 50 + CV.NODE_H / 2 });
  assert.deepEqual(CV.portPosition(n, 'out', 'out'), { x: 100 + CV.NODE_W, y: 50 + CV.NODE_H / 2 });
  const c = { id: 'c', type: 'condition', x: 0, y: 0 };
  const yes = CV.portPosition(c, 'out', 'yes'), no = CV.portPosition(c, 'out', 'no');
  assert.ok(yes.y < CV.NODE_H / 2 && no.y > CV.NODE_H / 2 && yes.x === no.x);
});

test('wires are smooth curves that leave to the right and arrive from the left', () => {
  const d = CV.wirePath(0, 0, 300, 100);
  assert.match(d, /^M 0 0 C /);
  assert.match(d, / 300 100$/);
  const back = CV.wirePath(300, 0, 0, 100);
  const ctrl = back.match(/C ([\d.-]+) /);
  assert.ok(Number(ctrl[1]) > 300, 'backward wires swing out to the right first');
});

test('layoutFlow puts a chain left to right on one row', () => {
  const nodes = ['s', 'a', 'b', 'e'].map(id => node(id, id === 's' ? 'start' : id === 'e' ? 'end' : 'summarize'));
  const pos = CV.layoutFlow(nodes, [edge('1', 's', 'a'), edge('2', 'a', 'b'), edge('3', 'b', 'e')]);
  const xs = ['s', 'a', 'b', 'e'].map(id => pos[id].x);
  assert.deepEqual(xs, [...xs].sort((p, q) => p - q));
  assert.equal(new Set(xs).size, 4);
  assert.equal(new Set(['s', 'a', 'b', 'e'].map(id => pos[id].y)).size, 1);
});

test('layoutFlow separates branches and never stacks two cards on the same spot', () => {
  const nodes = [node('s', 'start'), node('c', 'condition'), node('y', 'write_email'), node('n', 'summarize'), node('e1', 'end'), node('e2', 'end'), node('orphan')];
  const edges = [edge('1', 's', 'c'), edge('2', 'c', 'y', 'yes'), edge('3', 'c', 'n', 'no'), edge('4', 'y', 'e1'), edge('5', 'n', 'e2')];
  const pos = CV.layoutFlow(nodes, edges);
  assert.notEqual(pos.y.y, pos.n.y);
  assert.ok(pos.y.y < pos.n.y, 'YES branch above NO branch');
  const spots = Object.values(pos).map(p => p.x + ',' + p.y);
  assert.equal(new Set(spots).size, nodes.length);
  assert.ok(pos.orphan.y > Math.max(pos.e1.y, pos.e2.y), 'unconnected cards go below the flow');
});

test('layoutFlow handles a loop back-edge without hanging or going backwards', () => {
  const nodes = [node('s', 'start'), node('l', 'loop'), node('a'), node('e', 'end')];
  const edges = [edge('1', 's', 'l'), edge('2', 'l', 'a', 'each'), edge('3', 'a', 'l'), edge('4', 'l', 'e', 'done')];
  const pos = CV.layoutFlow(nodes, edges);
  assert.ok(pos.s.x < pos.l.x && pos.l.x < pos.a.x);
  assert.ok(Object.values(pos).every(p => Number.isFinite(p.x) && Number.isFinite(p.y)));
});

test('History: undo, redo, a new change drops the redo trail, and it is capped', () => {
  const h = new CV.History(3);
  h.push('a'); h.push('b'); h.push('c');
  assert.equal(h.undo('d'), 'c'); assert.equal(h.undo('c'), 'b');
  assert.equal(h.redo('b'), 'c');
  h.push('x');
  assert.equal(h.redo('x'), null);
  assert.equal(h.canUndo(), true);
  const cap = new CV.History(2); cap.push(1); cap.push(2); cap.push(3);
  assert.equal(cap.undo(4), 3); assert.equal(cap.undo(3), 2); assert.equal(cap.undo(2), null);
  assert.equal(new CV.History().undo('x'), null);
});

test('snap rounds to the 8px grid and zoom stays within limits', () => {
  assert.equal(CV.snap(13), 16); assert.equal(CV.snap(12), 16); assert.equal(CV.snap(11), 8); assert.equal(CV.snap(-5), -8);
  assert.equal(CV.clampZoom(0.01), CV.MIN_ZOOM); assert.equal(CV.clampZoom(99), CV.MAX_ZOOM); assert.equal(CV.clampZoom(1), 1);
});

test('automatic fit never shrinks below the minimum zoom; a wide flow starts at the left instead', () => {
  const wide = [{ id: 'a', x: 80, y: 160 }, { id: 'b', x: 1480, y: 160 }];
  const auto = CV.fitView(wide, 900, 700, 60, 0.85);
  assert.equal(auto.zoom, 0.85);
  assert.equal(auto.x, 60 - 80 * 0.85, 'the first card sits at the left padding so the flow can be panned to the right');
  const all = CV.fitView(wide, 900, 700, 60);
  assert.ok(all.zoom < 0.85, 'Fit all still shows everything');
  const small = CV.fitView([{ id: 'a', x: 0, y: 0 }], 900, 700, 60, 0.85);
  assert.equal(small.zoom, 1, 'a small flow is not enlarged past 100%');
  assert.ok(CV.AUTO_FIT_MIN_ZOOM === 0.85);
});

test('fitView centres all cards inside the visible area', () => {
  const nodes = [{ id: 'a', x: 0, y: 0 }, { id: 'b', x: 1000, y: 400 }];
  const v = CV.fitView(nodes, 1200, 700, 60);
  assert.ok(v.zoom > 0 && v.zoom <= 1);
  const left = v.x + 0 * v.zoom, right = v.x + (1000 + CV.NODE_W) * v.zoom;
  assert.ok(left >= 0 && right <= 1200);
  assert.deepEqual(CV.fitView([], 1000, 600, 60), { x: 0, y: 0, zoom: 1 });
});
