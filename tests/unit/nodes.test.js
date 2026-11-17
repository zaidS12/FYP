'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const N = require('../../assets/js/nodes.js');
const C = require('../../assets/js/billing.js');

const EXPECTED = ['start', 'end', 'write_email', 'create_report', 'summarize', 'translate', 'search_web', 'condition', 'loop', 'timer', 'research_bot', 'python_code'];

test('the registry has the twelve cards, each one object with id, category, icon, label and fields', () => {
  assert.deepEqual(N.types().map(t => t.id).sort(), [...EXPECTED].sort());
  for (const t of N.types()) {
    assert.ok(N.categories.some(c => c.id === t.category), t.id + ' category');
    assert.equal(typeof t.icon, 'string'); assert.ok(t.label && t.description, t.id);
    assert.ok(Array.isArray(t.fields), t.id + ' fields');
    for (const f of t.fields) assert.ok(f.name && f.label && ['text', 'textarea', 'select', 'number', 'email'].includes(f.type), t.id + '.' + f.name);
    for (const f of t.fields.filter(x => x.type === 'select')) assert.ok(f.options.length >= 2, t.id + '.' + f.name);
    assert.equal(typeof C.costOf(t.id), 'number', t.id + ' has a credit cost');
  }
});

test('ports follow what each card does', () => {
  assert.deepEqual(N.portsOf({ type: 'start' }), { in: false, out: ['out'] });
  assert.deepEqual(N.portsOf({ type: 'timer' }), { in: true, out: ['out'] });
  assert.deepEqual(N.portsOf({ type: 'end' }), { in: true, out: [] });
  assert.deepEqual(N.portsOf({ type: 'condition' }), { in: true, out: ['yes', 'no'] });
  assert.deepEqual(N.portsOf({ type: 'loop' }), { in: true, out: ['each', 'done'] });
  assert.deepEqual(N.portsOf({ type: 'summarize' }), { in: true, out: ['out'] });
  assert.equal(N.portsOf({ type: 'does_not_exist' }), null);
});

test('defaults, required fields and summaries come from the schema', () => {
  assert.equal(N.defaults('search_web').max_results, 5);
  assert.deepEqual(N.requiredFields('write_email').map(f => f.name).sort(), ['subject', 'to']);
  assert.deepEqual(N.requiredFields('start'), []);
  const s = N.summary({ type: 'search_web', config: { query: 'latest AI news', max_results: 5 } });
  assert.match(s, /latest AI news/);
  assert.equal(N.summary({ type: 'search_web', config: {} }), 'Not set up yet');
  assert.match(N.summary({ type: 'condition', config: { expression: 'length > 200' } }), /length > 200/);
  assert.equal(N.summary({ type: 'start', config: {} }), 'Where the flow begins');
});

test('makeNode builds a card with defaults and nextId never reuses an id', () => {
  const n = N.makeNode('summarize', 100, 200, 'n7');
  assert.deepEqual([n.id, n.type, n.label, n.x, n.y], ['n7', 'summarize', 'Summarize', 100, 200]);
  assert.equal(n.config.style, 'bullets');
  assert.equal(N.nextId([{ id: 'n1' }, { id: 'n9' }, { id: 'x' }]), 'n10');
  assert.equal(N.nextId([]), 'n1');
  assert.equal(N.makeNode('nope', 0, 0, 'n1'), null);
});

test('custom cards are made from an existing card and keep its ports, cost and fields', () => {
  const made = N.registerCustom({ id: 'custom_news', label: 'My news search', base: 'search_web', config: { query: 'ai news', max_results: 3 } });
  assert.equal(made.ok, true);
  const t = N.get('custom_news');
  assert.equal(t.base, 'search_web'); assert.equal(t.custom, true); assert.equal(t.category, 'data');
  assert.deepEqual(N.portsOf({ type: 'custom_news', base: 'search_web' }), { in: true, out: ['out'] });
  const node = N.makeNode('custom_news', 0, 0, 'n1');
  assert.equal(node.base, 'search_web'); assert.equal(node.config.query, 'ai news'); assert.equal(node.label, 'My news search');
  assert.equal(C.costOf(node.type, { base: node.base }), 2);
  assert.ok(N.types().some(x => x.id === 'custom_news'));
  assert.equal(N.registerCustom({ id: 'custom_bad', label: 'x', base: 'nope' }).ok, false);
  assert.equal(N.registerCustom({ id: 'search_web', label: 'Clash', base: 'summarize' }).ok, false, 'cannot shadow a built-in card');
  assert.equal(N.registerCustom({ id: 'custom_x', label: '', base: 'summarize' }).ok, false);
  N.unregisterCustom('custom_news');
  assert.equal(N.get('custom_news'), null);
});

test('serialising and restoring custom cards round-trips and rejects junk', () => {
  const cards = [{ id: 'custom_a', label: 'A', base: 'summarize', config: { style: 'headline' } }, { id: 'oops', label: 'bad id', base: 'summarize' }, null, { id: 'custom_b', label: 'B', base: 'ghost' }];
  const clean = N.cleanCustomCards(cards);
  assert.deepEqual(clean.map(c => c.id), ['custom_a']);
  assert.equal(N.cleanCustomCards(Array.from({ length: 50 }, (_, i) => ({ id: 'custom_' + i, label: 'c' + i, base: 'summarize' }))).length, 30);
  N.loadCustomCards(clean);
  assert.ok(N.get('custom_a'));
  N.loadCustomCards([]);
  assert.equal(N.get('custom_a'), null);
});
