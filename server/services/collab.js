'use strict';
/* Live co-work state: who is on a flow and which cards are locked. Kept in memory on purpose: it is short-lived,
 * changes every few seconds and must vanish on restart. (Migration: Redis or Flask-SocketIO rooms.)
 * An editor is a browser tab (`client_id`). When someone is signed in as another account, the editor is the REAL person
 * and is labelled "Actor (as Subject)". */
const PRESENCE_MS = 25000;
const LOCK_MS = 30000;
const STOP_MS = 10 * 60 * 1000;
const MAX_LOCKS_PER_CLIENT = 20;
const COLORS = ['#1D6B57', '#B4501F', '#2B5FAE', '#8A3D9B', '#9A7A00', '#C2335A', '#0E7C86', '#5B6B1F'];

const colorFor = id => { let h = 0; for (const ch of String(id)) h = (h * 31 + ch.charCodeAt(0)) >>> 0; return COLORS[h % COLORS.length]; };
const labelOf = w => (w.as_name ? `${w.name} (as ${w.as_name})` : w.name);

class Collab {
  constructor({ now = Date.now } = {}) { this.now = now; this.presence = new Map(); this.locks = new Map(); this.owners = new Map(); this.stops = new Map(); }

  /** Plain-JSON copy of everything, so several server instances can share it (see server/live-sync.js). */
  toState() {
    const obj = m => Object.fromEntries([...m].map(([flow, inner]) => [flow, Object.fromEntries(inner)]));
    return { presence: obj(this.presence), locks: obj(this.locks), owners: Object.fromEntries(this.owners), stops: Object.fromEntries(this.stops) };
  }

  loadState(s) {
    const maps = o => new Map(Object.entries(o || {}).map(([flow, inner]) => [flow, new Map(Object.entries(inner))]));
    const st = s || {};
    this.presence = maps(st.presence); this.locks = maps(st.locks);
    this.owners = new Map(Object.entries(st.owners || {})); this.stops = new Map(Object.entries(st.stops || {}));
  }

  /** "Stop this run": remembered for a few minutes so the instance that is running the flow can notice it. */
  requestStop(runId) { this.stops.set(runId, this.now()); }
  stopRequested(runId) { const t = this.stops.get(runId); return t !== undefined && this.now() - t < STOP_MS; }

  /** A client id belongs to the first person who uses it; anyone else sending it is refused (so ids seen in a snapshot cannot be borrowed). */
  claim(clientId, userId) {
    const o = this.owners.get(clientId);
    if (o === undefined) { this.owners.set(clientId, userId); return true; }
    return o === userId;
  }

  _flow(map, flowId) { let m = map.get(flowId); if (!m) { m = new Map(); map.set(flowId, m); } return m; }

  /** Drops expired entries for one flow. Returns true if anything was removed. */
  _expire(flowId) {
    const t = this.now(); let changed = false;
    const p = this.presence.get(flowId); const l = this.locks.get(flowId);
    if (p) for (const [k, v] of p) if (t - v.at > PRESENCE_MS) { p.delete(k); changed = true; }
    if (l) for (const [k, v] of l) if (t - v.at > LOCK_MS) { l.delete(k); changed = true; }
    if (p && !p.size) this.presence.delete(flowId);
    if (l && !l.size) this.locks.delete(flowId);
    return changed;
  }

  /** Marks an editor as present (and renews their locks). `state.node_id` = the card they are on. Returns true if the picture changed. */
  heartbeat(flowId, who, state) {
    const exp = this._expire(flowId);
    const p = this._flow(this.presence, flowId); const prev = p.get(who.client_id);
    const node = (state && state.node_id) || null;
    p.set(who.client_id, { client_id: who.client_id, user_id: who.user_id, name: who.name, as_name: who.as_name || null, can_edit: !!who.can_edit, node_id: node, at: this.now() });
    const l = this.locks.get(flowId);
    if (l) for (const v of l.values()) if (v.client_id === who.client_id) v.at = this.now();
    return exp || !prev || prev.node_id !== node || prev.name !== who.name || prev.as_name !== (who.as_name || null);
  }

  acquire(flowId, nodeId, who) {
    if (!who.can_edit) return { ok: false, holder: null, error: 'You can look at this flow but not change it.' };
    this._expire(flowId);
    const l = this._flow(this.locks, flowId); const cur = l.get(nodeId);
    if (!cur && [...l.values()].filter(v => v.client_id === who.client_id).length >= MAX_LOCKS_PER_CLIENT) return { ok: false, holder: null, error: 'You are holding too many cards at once. Click away from some first.' };
    if (cur && cur.client_id !== who.client_id) return { ok: false, holder: { name: cur.name, label: labelOf(cur) } };
    l.set(nodeId, { node_id: nodeId, client_id: who.client_id, user_id: who.user_id, name: who.name, as_name: who.as_name || null, at: this.now() });
    return { ok: true };
  }

  release(flowId, nodeId, clientId) {
    const l = this.locks.get(flowId); const cur = l && l.get(nodeId);
    if (!cur || cur.client_id !== clientId) return false;
    l.delete(nodeId); return true;
  }

  leave(flowId, clientId) {
    const p = this.presence.get(flowId); const l = this.locks.get(flowId); let changed = false;
    if (p && p.delete(clientId)) changed = true;
    if (l) for (const [k, v] of l) if (v.client_id === clientId) { l.delete(k); changed = true; }
    if (p && !p.size) this.presence.delete(flowId);
    if (l && !l.size) this.locks.delete(flowId);
    this._forgetUnused(clientId);
    return changed;
  }

  snapshot(flowId) {
    this._expire(flowId);
    const p = [...(this.presence.get(flowId) || new Map()).values()].map(v => ({ client_id: v.client_id, user_id: v.user_id, name: v.name, label: labelOf(v), color: colorFor(v.user_id), can_edit: v.can_edit, node_id: v.node_id }));
    const l = [...(this.locks.get(flowId) || new Map()).values()].map(v => ({ node_id: v.node_id, client_id: v.client_id, user_id: v.user_id, name: v.name, label: labelOf(v), color: colorFor(v.user_id) }));
    return { presence: p, locks: l };
  }

  /** Locks on these cards that are not yours. A lock is yours only if the tab id AND the person match. */
  lockedByOthers(flowId, nodeIds, clientId, userId) {
    return this.snapshot(flowId).locks.filter(k => nodeIds.includes(k.node_id) && (k.client_id !== clientId || (userId !== undefined && k.user_id !== userId)));
  }

  _forgetUnused(clientId) {
    for (const flowMap of [...this.presence.values(), ...this.locks.values()]) {
      for (const v of flowMap.values()) if (v.client_id === clientId) return;
    }
    this.owners.delete(clientId);
  }

  /** Expires everything stale; returns the ids of flows whose picture changed. */
  sweep() {
    const out = [];
    for (const id of new Set([...this.presence.keys(), ...this.locks.keys()])) if (this._expire(id)) out.push(id);
    for (const cid of [...this.owners.keys()]) this._forgetUnused(cid);
    for (const [run, t] of [...this.stops]) if (this.now() - t >= STOP_MS) this.stops.delete(run);
    return out;
  }
}

module.exports = { Collab, PRESENCE_MS, LOCK_MS, labelOf };
