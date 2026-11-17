'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Collab, PRESENCE_MS, LOCK_MS } = require('../../server/services/collab.js');

const who = (client, name = client, extra) => Object.assign({ client_id: client, user_id: 'u_' + client, name, as_name: null, can_edit: true }, extra || {});
const clock = () => { const c = { t: 1000, now: () => c.t }; return c; };

test('heartbeat adds presence; snapshot lists everyone currently on the flow', () => {
  const c = clock(); const col = new Collab({ now: c.now });
  col.heartbeat('f1', who('a', 'Ana'), {}); col.heartbeat('f1', who('b', 'Omar'), {});
  col.heartbeat('f2', who('c', 'Lina'), {});
  assert.deepEqual(col.snapshot('f1').presence.map(p => p.name).sort(), ['Ana', 'Omar']);
  assert.equal(col.snapshot('f2').presence.length, 1);
});

test('presence expires without heartbeats and renews with them', () => {
  const c = clock(); const col = new Collab({ now: c.now });
  col.heartbeat('f1', who('a', 'Ana'), {});
  c.t += PRESENCE_MS - 1; col.heartbeat('f1', who('a', 'Ana'), {});
  c.t += PRESENCE_MS - 1; assert.equal(col.snapshot('f1').presence.length, 1);
  c.t += 5; assert.equal(col.snapshot('f1').presence.length, 0);
});

test('a card can be locked by one editor at a time; the holder can re-lock; others are told who holds it', () => {
  const col = new Collab({ now: clock().now });
  assert.equal(col.acquire('f1', 'n1', who('a', 'Ana')).ok, true);
  assert.equal(col.acquire('f1', 'n1', who('a', 'Ana')).ok, true);
  const r = col.acquire('f1', 'n1', who('b', 'Omar'));
  assert.equal(r.ok, false); assert.equal(r.holder.name, 'Ana');
  assert.equal(col.snapshot('f1').locks[0].node_id, 'n1');
});

test('viewers cannot lock; only the holder releases; leaving releases everything', () => {
  const col = new Collab({ now: clock().now });
  assert.equal(col.acquire('f1', 'n1', who('v', 'View', { can_edit: false })).ok, false);
  col.acquire('f1', 'n1', who('a')); col.acquire('f1', 'n2', who('a'));
  assert.equal(col.release('f1', 'n1', 'b'), false);
  assert.equal(col.release('f1', 'n1', 'a'), true);
  assert.equal(col.snapshot('f1').locks.length, 1);
  col.heartbeat('f1', who('a'), {});
  col.leave('f1', 'a');
  assert.equal(col.snapshot('f1').locks.length, 0); assert.equal(col.snapshot('f1').presence.length, 0);
});

test('locks expire when the holder goes quiet, and a heartbeat keeps them alive', () => {
  const c = clock(); const col = new Collab({ now: c.now });
  col.acquire('f1', 'n1', who('a')); col.heartbeat('f1', who('a'), {});
  c.t += LOCK_MS - 1; col.heartbeat('f1', who('a'), {});
  c.t += LOCK_MS - 1; assert.equal(col.snapshot('f1').locks.length, 1);
  c.t += 5000; assert.equal(col.snapshot('f1').locks.length, 0);
  assert.equal(col.acquire('f1', 'n1', who('b')).ok, true, 'free again');
});

test('heartbeat reports which card the editor is on, and an impersonated editor is shown as "Actor (as Subject)"', () => {
  const col = new Collab({ now: clock().now });
  col.heartbeat('f1', who('a', 'Root', { as_name: 'Ana' }), { node_id: 'n7' });
  const p = col.snapshot('f1').presence[0];
  assert.equal(p.node_id, 'n7'); assert.equal(p.label, 'Root (as Ana)'); assert.ok(/^#[0-9A-Fa-f]{6}$/.test(p.color));
  col.acquire('f1', 'n7', who('a', 'Root', { as_name: 'Ana' }));
  assert.equal(col.snapshot('f1').locks[0].label, 'Root (as Ana)');
});

test('locksHeldByOthers answers which of the given cards are locked by someone else', () => {
  const col = new Collab({ now: clock().now });
  col.acquire('f1', 'n1', who('a', 'Ana')); col.acquire('f1', 'n2', who('b', 'Omar'));
  assert.deepEqual(col.lockedByOthers('f1', ['n1', 'n2', 'n3'], 'a').map(l => l.node_id), ['n2']);
  assert.deepEqual(col.lockedByOthers('f1', ['n1'], 'a'), []);
});

test('sweep reports whether anything expired so the server knows to broadcast', () => {
  const c = clock(); const col = new Collab({ now: c.now });
  col.heartbeat('f1', who('a'), {});
  assert.deepEqual(col.sweep(), []);
  c.t += PRESENCE_MS + 1;
  assert.deepEqual(col.sweep(), ['f1']);
  assert.deepEqual(col.sweep(), []);
});
