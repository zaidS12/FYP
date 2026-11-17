/* AgentFlow co-work client: presence, card locks and "someone saved" notices for one open flow.
 * Live updates come from Server-Sent Events; if the stream cannot stay open it falls back to polling the same snapshot.
 * Tabs in the same browser also tell each other about saves through BroadcastChannel. UMD: browser (AF.collab) and Node (tests). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else { root.AF = root.AF || {}; root.AF.collab = factory(); }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const HEARTBEAT_MS = 10000;
  const POLL_MS = 4000;
  const MAX_SSE_ERRORS = 3;

  const initials = label => String(label || '?').replace(/\(as .*\)/, '').trim().split(/\s+/).map(w => w[0]).slice(0, 2).join('').toUpperCase() || '?';

  /** card id -> [{name, lock}] for the canvas. Your own tab is left out: you are never blocked by yourself. */
  function peopleMap(snapshot, myClientId) {
    const map = {};
    const add = (id, entry) => { (map[id] = map[id] || []).push(entry); };
    for (const l of (snapshot && snapshot.locks) || []) if (l.client_id !== myClientId) add(l.node_id, { name: l.label, lock: true, color: l.color, client_id: l.client_id });
    for (const p of (snapshot && snapshot.presence) || []) {
      if (p.client_id === myClientId || !p.node_id) continue;
      if ((map[p.node_id] || []).some(x => x.client_id === p.client_id)) continue;
      add(p.node_id, { name: p.label, lock: false, color: p.color, client_id: p.client_id });
    }
    return map;
  }

  /** People to show as avatars in the toolbar (everyone but this tab; one avatar per person even with several tabs). */
  function avatarList(snapshot, myClientId) {
    const seen = new Set(); const out = [];
    for (const p of (snapshot && snapshot.presence) || []) {
      if (p.client_id === myClientId || seen.has(p.label)) continue;
      seen.add(p.label); out.push({ label: p.label, initials: initials(p.label), color: p.color, node_id: p.node_id, can_edit: p.can_edit });
    }
    return out;
  }

  function newClientId() {
    const bytes = globalThis.crypto && globalThis.crypto.getRandomValues ? globalThis.crypto.getRandomValues(new Uint8Array(9)) : Array.from({ length: 9 }, () => Math.floor(Math.random() * 256));
    return 'c' + Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
  }

  /** opts: {flowId, db, version, onSnapshot(snapshot), onVersion({n, by, summary, merged, local}), onMode('live'|'polling'|'offline'), EventSourceImpl, BroadcastChannelImpl}.
   *  `db` is AF.db (its request goes through the same cookie and error handling as the rest of the app). */
  function start(opts) {
    const clientId = newClientId();
    const g = typeof self !== 'undefined' ? self : globalThis;
    const ES = opts.EventSourceImpl || g.EventSource; const BC = opts.BroadcastChannelImpl || g.BroadcastChannel;
    let es = null; let retryTimer = null; let pollTimer = null; let beatTimer = null; let heldNode = null; let currentNode = null; let stopped = false; let errors = 0; let knownVersion = opts.version || 0;
    let mode = 'offline'; let last = { presence: [], locks: [] };
    let channel = null;

    const req = opts.db.request || (opts.db._b && opts.db._b.request);
    const post = (action, body) => req('POST', `/api/flows/${encodeURIComponent(opts.flowId)}/collab/${action}`, Object.assign({ client_id: clientId }, body || {}));
    const setMode = m => { if (m !== mode) { mode = m; if (opts.onMode) opts.onMode(m); } };

    function applySnapshot(s) {
      if (!s || !Array.isArray(s.presence)) return;
      last = s;
      if (opts.onSnapshot) opts.onSnapshot(s);
      if (Number.isInteger(s.version) && s.version > knownVersion) {   // a save we have not heard about (missed event, polling mode)
        knownVersion = s.version;
        if (opts.onVersion) opts.onVersion({ n: s.version, by: 'a colleague', summary: '', merged: false, local: false });
      }
    }

    async function beat() { if (stopped) return; const r = await post('heartbeat', { node_id: currentNode }); if (r.ok) applySnapshot(r); }
    async function poll() { if (stopped) return; const r = await req('GET', `/api/flows/${encodeURIComponent(opts.flowId)}/collab`); if (r.ok) applySnapshot(r); else if (r.status === 0) setMode('offline'); }

    function startPolling() {
      if (pollTimer || stopped) return;
      setMode('polling'); poll(); pollTimer = setInterval(poll, POLL_MS);
    }
    function stopPolling() { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } }

    function openStream() {
      if (!ES || stopped) { startPolling(); return; }
      es = new ES(`/api/flows/${encodeURIComponent(opts.flowId)}/events?client=${encodeURIComponent(clientId)}`);
      es.addEventListener('open', () => { errors = 0; stopPolling(); setMode('live'); });
      es.addEventListener('collab', ev => { try { applySnapshot(JSON.parse(ev.data)); } catch (e) { /* ignore a damaged event */ } });
      es.addEventListener('version', ev => {
        try {
          const v = JSON.parse(ev.data); knownVersion = Math.max(knownVersion, v.n);
          if (opts.onVersion && v.client !== clientId) opts.onVersion(Object.assign({ local: false }, v));   // our own save needs no notice
        } catch (e) { /* ignore */ }
      });
      es.addEventListener('error', () => {
        errors += 1;
        if (es.readyState === 2 || errors >= MAX_SSE_ERRORS) { es.close(); es = null; startPolling(); retryTimer = setTimeout(() => { if (!stopped && !es) { errors = 0; openStream(); } }, 30000); }
      });
    }

    if (BC) {
      try {
        channel = new BC('agentflow-flow-' + opts.flowId);
        channel.onmessage = ev => {
          const m = ev.data; if (!m || m.type !== 'saved' || m.from === clientId || !Number.isInteger(m.n)) return;
          if (m.n > knownVersion) { knownVersion = m.n; if (opts.onVersion) opts.onVersion({ n: m.n, by: 'another tab of yours', summary: m.summary || '', merged: false, local: true }); }
        };
      } catch (e) { channel = null; }
    }

    openStream();
    beat();
    beatTimer = setInterval(beat, HEARTBEAT_MS);

    let focusChain = Promise.resolve();
    async function doFocus(nodeId, canEdit) {
      if (stopped || nodeId !== currentNode) return { ok: true };   // a newer selection replaced this one
      if (heldNode && heldNode !== nodeId) { const old = heldNode; heldNode = null; await post('unlock', { node_id: old }); }
      if (!nodeId || !canEdit) { beat(); return { ok: true }; }
      const r = await post('lock', { node_id: nodeId });
      if (r.ok) { heldNode = nodeId; applySnapshot(r); beat(); return { ok: true }; }
      beat();
      return { ok: false, error: r.error || 'This card is being edited by someone else.' };
    }

    return {
      clientId,
      snapshot: () => last,
      mode: () => mode,
      /** Call after this tab saved: lets other tabs of this browser react immediately. */
      announceSaved(n, summary) { knownVersion = Math.max(knownVersion, n); if (channel) channel.postMessage({ type: 'saved', n, summary: summary || '', from: clientId }); },
      setKnownVersion(n) { knownVersion = Math.max(knownVersion, n); },
      /** Select a card (or null). Takes the card's lock when you may edit; resolves {ok} or {ok:false, error}. */
      focusNode(nodeId, canEdit) {
        currentNode = nodeId;
        focusChain = focusChain.then(() => doFocus(nodeId, canEdit));   // one at a time, so a quick second click cannot strand a lock
        return focusChain;
      },
      async release() { if (heldNode) { const old = heldNode; heldNode = null; await post('unlock', { node_id: old }); } },
      stop() {
        if (stopped) return; stopped = true;
        clearInterval(beatTimer); clearTimeout(retryTimer); stopPolling(); if (es) es.close(); if (channel) channel.close();
        try { fetch(`/api/flows/${encodeURIComponent(opts.flowId)}/collab/leave`, { method: 'POST', credentials: 'same-origin', keepalive: true, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ client_id: clientId }) }).catch(() => {}); } catch (e) { /* page is closing */ }
      },
    };
  }

  return { start, peopleMap, avatarList, initials, HEARTBEAT_MS, POLL_MS };
});
