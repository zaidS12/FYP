'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../../assets/js/collab.js');

const snap = {
  version: 3,
  presence: [
    { client_id: 'me', label: 'Ana Torres', color: '#111111', node_id: 'n1', can_edit: true },
    { client_id: 'o1', label: 'Omar Siddiqui', color: '#222222', node_id: 'n2', can_edit: true },
    { client_id: 'o2', label: 'Omar Siddiqui', color: '#222222', node_id: null, can_edit: true },
    { client_id: 'r1', label: 'Root (as Lina)', color: '#333333', node_id: 'n2', can_edit: true },
  ],
  locks: [{ node_id: 'n2', client_id: 'o1', label: 'Omar Siddiqui', color: '#222222' }, { node_id: 'n1', client_id: 'me', label: 'Ana Torres', color: '#111111' }],
};

test('peopleMap: my own tab never blocks me; locks and looking are told apart; a person is not listed twice on a card', () => {
  const m = C.peopleMap(snap, 'me');
  assert.equal(m.n1, undefined);
  assert.deepEqual(m.n2.map(x => [x.name, x.lock]), [['Omar Siddiqui', true], ['Root (as Lina)', false]]);
});

test('avatarList: one avatar per person, never me, initials ignore the "(as ...)" part', () => {
  const list = C.avatarList(snap, 'me');
  assert.deepEqual(list.map(x => x.label), ['Omar Siddiqui', 'Root (as Lina)']);
  assert.deepEqual(list.map(x => x.initials), ['OS', 'R']);
});

function harness(extra) {
  const calls = []; const listeners = {}; let closed = false;
  class ES { constructor(url) { this.url = url; this.readyState = 1; ES.last = this; } addEventListener(n, f) { listeners[n] = f; } close() { closed = true; this.readyState = 2; } }
  const db = { request: async (method, url, body) => { calls.push({ method, url, body }); return { ok: true, status: 200, presence: [], locks: [], version: 3 }; } };
  const events = { snapshots: [], versions: [], modes: [] };
  const handle = C.start(Object.assign({ flowId: 'f1', db, version: 3, EventSourceImpl: ES, BroadcastChannelImpl: null,
    onSnapshot: s => events.snapshots.push(s), onVersion: v => events.versions.push(v), onMode: m => events.modes.push(m) }, extra || {}));
  return { handle, calls, listeners, events, isClosed: () => closed, ES };
}

test('start opens the stream with a client id, reports live mode, and heartbeats', async () => {
  const h = harness();
  assert.match(h.ES.last.url, /^\/api\/flows\/f1\/events\?client=c[0-9a-f]{18}$/);
  h.listeners.open(); assert.deepEqual(h.events.modes, ['live']);
  await new Promise(r => setTimeout(r, 5));
  assert.ok(h.calls.some(c => c.url === '/api/flows/f1/collab/heartbeat' && c.body.client_id === h.handle.clientId));
  h.handle.stop();
});

test('events: collab snapshots are applied; a version from someone else is reported, our own is not', () => {
  const h = harness();
  h.listeners.collab({ data: JSON.stringify({ presence: [], locks: [], version: 3 }) });
  assert.equal(h.events.snapshots.length, 1);
  h.listeners.version({ data: JSON.stringify({ n: 4, by: 'Omar', summary: 'x', client: 'other' }) });
  h.listeners.version({ data: JSON.stringify({ n: 5, by: 'Ana', summary: 'mine', client: h.handle.clientId }) });
  assert.deepEqual(h.events.versions.map(v => v.n), [4]);
  h.handle.stop();
});

test('a newer version seen only in a snapshot (polling or a missed event) is still reported once', () => {
  const h = harness();
  h.listeners.collab({ data: JSON.stringify({ presence: [], locks: [], version: 4 }) });
  h.listeners.collab({ data: JSON.stringify({ presence: [], locks: [], version: 4 }) });
  assert.equal(h.events.versions.length, 1); assert.equal(h.events.versions[0].n, 4);
  h.handle.stop();
});

test('focusNode takes the lock for editors, releases the previous card, and reports a refusal', async () => {
  const h = harness(); await new Promise(r => setTimeout(r, 5)); h.calls.length = 0;
  assert.equal((await h.handle.focusNode('n1', true)).ok, true);
  await h.handle.focusNode('n2', true);
  const urls = h.calls.map(c => c.url.split('/collab/')[1] + ':' + (c.body.node_id || ''));
  assert.deepEqual(urls.filter(u => !u.startsWith('heartbeat')), ['lock:n1', 'unlock:n1', 'lock:n2']);
  h.calls.length = 0;
  assert.equal((await h.handle.focusNode('n3', false)).ok, true);
  assert.ok(!h.calls.some(c => c.url.endsWith('/lock')), 'viewers never take locks');
  h.handle.stop();
});

test('three stream errors switch to polling, and a closed stream does immediately', async () => {
  const h = harness();
  h.listeners.error(); h.listeners.error(); assert.deepEqual(h.events.modes, []);
  h.listeners.error(); assert.deepEqual(h.events.modes, ['polling']); assert.equal(h.isClosed(), true);
  await new Promise(r => setTimeout(r, 5));
  assert.ok(h.calls.some(c => c.method === 'GET' && c.url === '/api/flows/f1/collab'));
  h.handle.stop();
  const h2 = harness(); h2.ES.last.readyState = 2; h2.listeners.error(); assert.deepEqual(h2.events.modes, ['polling']); h2.handle.stop();
});

test('without EventSource support the client polls from the start', () => {
  const h = harness({ EventSourceImpl: null });
  assert.deepEqual(h.events.modes, ['polling']);
  h.handle.stop();
});

test('BroadcastChannel: a save announced by another tab is reported as local', () => {
  const channels = [];
  class BC { constructor(name) { this.name = name; channels.push(this); } postMessage(m) { channels.filter(c => c !== this && c.name === this.name).forEach(c => c.onmessage({ data: m })); } close() {} }
  const a = harness({ BroadcastChannelImpl: BC }); const b = harness({ BroadcastChannelImpl: BC });
  a.handle.announceSaved(4, 'Added a card');
  assert.deepEqual(b.events.versions.map(v => [v.n, v.local]), [[4, true]]);
  assert.equal(a.events.versions.length, 0, 'the sending tab is not told about its own save');
  a.handle.stop(); b.handle.stop();
});
