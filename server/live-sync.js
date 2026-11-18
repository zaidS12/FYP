'use strict';
/* Shared live state for serverless hosts: who is on which flow, card locks, client-id owners and "stop this run" requests.
 * On a normal server these live in memory (services/collab.js). On Vercel several function instances run at once, so the same
 * state is kept in ONE Supabase row {id:'live', data:{v, state}} and changed with compare-and-swap:
 *   read the row -> apply the change in memory -> PATCH only if `v` is still what we read (otherwise re-read and try again).
 * That makes "two people grab the same card at the same moment" safe: exactly one PATCH wins. Same async API as Collab. */
const { Collab } = require('./services/collab.js');

const stable = v => JSON.stringify(v);
const MAX_TRIES = 8;

class SharedCollab {
  constructor({ url, key, fetchImpl = fetch, now = Date.now, cacheMs = 700 }) {
    this.url = url; this.key = key; this.fetchImpl = fetchImpl; this.cacheMs = cacheMs; this.now = now;
    this.local = new Collab({ now }); this.v = null; this._loadedAt = 0;
  }

  _headers(extra) { return Object.assign({ apikey: this.key, Authorization: 'Bearer ' + this.key, 'Content-Type': 'application/json' }, extra || {}); }

  async _call(query, init) {
    const res = await this.fetchImpl(this.url + query, Object.assign({ headers: this._headers() }, init));
    if (!res.ok) throw new Error(`Live state store failed (HTTP ${res.status}).`);
    return res;
  }

  /** Read the shared row into memory (creating it the first time). `maxAgeMs` lets read-only polling reuse a very recent read. */
  async _load(maxAgeMs = 0) {
    if (this.v !== null && this.now() - this._loadedAt < maxAgeMs) return;
    let rows = await (await this._call('?id=eq.live&select=data', { method: 'GET' })).json();
    if (!Array.isArray(rows) || !rows.length) {
      await this._call('?on_conflict=id', { method: 'POST', headers: this._headers({ Prefer: 'resolution=ignore-duplicates,return=minimal' }), body: JSON.stringify({ id: 'live', data: { v: 0, state: {} } }) });
      rows = await (await this._call('?id=eq.live&select=data', { method: 'GET' })).json();
    }
    const data = rows && rows[0] && rows[0].data ? rows[0].data : { v: 0, state: {} };
    this.local.loadState(data.state); this.v = Number(data.v) || 0; this._loadedAt = this.now();
  }

  /** Write our in-memory state only if nobody changed the row since we read it. */
  async _swap() {
    const next = { v: this.v + 1, state: this.local.toState() };
    const rows = await (await this._call(`?id=eq.live&data-%3E%3Ev=eq.${this.v}`, { method: 'PATCH', headers: this._headers({ Prefer: 'return=representation' }), body: JSON.stringify({ data: next }) })).json();
    if (Array.isArray(rows) && rows.length) { this.v = next.v; this._loadedAt = this.now(); return true; }
    return false;
  }

  /** Re-run `fn` on fresh state until its change is stored (or nothing changed). Returns fn's result. */
  async _mutate(fn) {
    for (let i = 0; i < MAX_TRIES; i++) {
      await this._load();
      const before = stable(this.local.toState());
      const result = fn(this.local);
      if (stable(this.local.toState()) === before) return result;
      if (await this._swap()) return result;
      await new Promise(r => setTimeout(r, 15 + Math.floor(Math.random() * 40)));   // lost the race: someone else changed it, try again
    }
    throw new Error('The live state is too busy right now. Try again.');
  }

  async snapshot(flowId) { await this._load(this.cacheMs); return this.local.snapshot(flowId); }
  async lockedByOthers(flowId, nodeIds, clientId, userId) { await this._load(); return this.local.lockedByOthers(flowId, nodeIds, clientId, userId); }
  claim(clientId, userId) { return this._mutate(c => c.claim(clientId, userId)); }
  heartbeat(flowId, who, state) { return this._mutate(c => c.heartbeat(flowId, who, state)); }
  acquire(flowId, nodeId, who) { return this._mutate(c => c.acquire(flowId, nodeId, who)); }
  release(flowId, nodeId, clientId) { return this._mutate(c => c.release(flowId, nodeId, clientId)); }
  leave(flowId, clientId) { return this._mutate(c => c.leave(flowId, clientId)); }
  requestStop(runId) { return this._mutate(c => c.requestStop(runId)); }
  async stopRequested(runId) { await this._load(this.cacheMs); return this.local.stopRequested(runId); }
  async sweep() { return []; }   // expiry is applied as part of every change
}

module.exports = { SharedCollab };
