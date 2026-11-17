/* AgentFlow canvas: an infinite, zoomable board of node cards joined by curved wires.
 * The top half is pure geometry (unit tested); the Canvas class below needs a browser. UMD: browser (AF.canvas) and Node (tests). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./nodes.js'), null);
  else { root.AF = root.AF || {}; root.AF.canvas = factory(root.AF.nodes, root.AF.engine); }
})(typeof self !== 'undefined' ? self : this, function (Nodes, Engine) {
  'use strict';

  const NODE_W = 224, NODE_H = 84, GRID = 8, MIN_ZOOM = 0.25, MAX_ZOOM = 2, COL = 300, ROW = 140, ORIGIN = 80;
  const snap = v => Math.round(v / GRID) * GRID;
  const clampZoom = z => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));

  /** Where a wire attaches: inputs on the left edge, outputs on the right (two outputs sit top and bottom). */
  function portPosition(node, kind, name) {
    if (kind === 'in') return { x: node.x, y: node.y + NODE_H / 2 };
    const ports = Nodes.portsOf(node); const outs = ports ? ports.out : ['out'];
    const i = Math.max(0, outs.indexOf(name));
    const y = outs.length < 2 ? NODE_H / 2 : NODE_H * (i === 0 ? 0.32 : 0.68);
    return { x: node.x + NODE_W, y: node.y + y };
  }

  /** Cubic curve from an output to an input. Backward wires swing out to the right before returning. */
  function wirePath(x1, y1, x2, y2) {
    const dx = x2 - x1; const k = dx >= 0 ? Math.max(48, dx * 0.5) : Math.max(120, -dx * 0.5 + 80);
    return `M ${x1} ${y1} C ${x1 + k} ${y1}, ${x2 - k} ${y2}, ${x2} ${y2}`;
  }

  const PORT_ORDER = { out: 0, yes: 0, each: 0, no: 1, done: 1 };

  /** Auto-align: left to right by longest path, branches on separate rows (YES above NO), loop back-edges ignored. */
  function layoutFlow(nodes, edges) {
    const ids = nodes.map(n => n.id); const byId = new Map(nodes.map(n => [n.id, n]));
    const valid = edges.filter(e => byId.has(e.from) && byId.has(e.to) && e.from !== e.to);
    const outs = new Map(ids.map(id => [id, []])); const incoming = new Map(ids.map(id => [id, 0]));
    for (const e of valid) { outs.get(e.from).push(e); incoming.set(e.to, incoming.get(e.to) + 1); }
    for (const list of outs.values()) list.sort((a, b) => (PORT_ORDER[a.fromPort || 'out'] || 0) - (PORT_ORDER[b.fromPort || 'out'] || 0));
    const orphans = ids.filter(id => !valid.some(e => e.from === id || e.to === id));
    const startFirst = [...ids].sort((a, b) => (byId.get(a).type === 'start' ? -1 : 0) - (byId.get(b).type === 'start' ? -1 : 0));
    const sources = startFirst.filter(id => incoming.get(id) === 0 && !orphans.includes(id));

    // depth-first walk: finds back edges (loop returns) and the visiting order
    const state = new Map(); const forward = []; const order = []; const parentOf = new Map();
    const dfs = (v, parent) => {
      state.set(v, 1); order.push(v); parentOf.set(v, parent);
      for (const e of outs.get(v)) {
        if (state.get(e.to) === 1) continue;           // back edge: ignored for layout
        forward.push(e);
        if (!state.has(e.to)) dfs(e.to, v);
      }
      state.set(v, 2);
    };
    for (const s of sources) if (!state.has(s)) dfs(s, null);
    for (const id of ids) if (!state.has(id) && !orphans.includes(id)) dfs(id, null);

    // levels: longest path over forward edges
    const level = new Map(ids.map(id => [id, 0])); const indeg = new Map(ids.map(id => [id, 0]));
    for (const e of forward) indeg.set(e.to, indeg.get(e.to) + 1);
    const queue = ids.filter(id => indeg.get(id) === 0);
    while (queue.length) {
      const v = queue.shift();
      for (const e of forward.filter(f => f.from === v)) { level.set(e.to, Math.max(level.get(e.to), level.get(v) + 1)); indeg.set(e.to, indeg.get(e.to) - 1); if (indeg.get(e.to) === 0) queue.push(e.to); }
    }

    // rows: the first child keeps its parent's row, other children open new rows
    const rows = new Map(); const claimed = new Set(); const taken = new Set(); let maxRow = -1;
    for (const v of order) {
      const p = parentOf.get(v); let row;
      if (p === null || !rows.has(p)) row = ++maxRow;
      else if (!claimed.has(p)) { row = rows.get(p); claimed.add(p); } else row = ++maxRow;
      while (taken.has(level.get(v) + ':' + row)) row = ++maxRow;
      taken.add(level.get(v) + ':' + row); rows.set(v, row); if (row > maxRow) maxRow = row;
    }
    const pos = {};
    for (const v of order) pos[v] = { x: ORIGIN + level.get(v) * COL, y: ORIGIN + rows.get(v) * ROW };
    orphans.forEach((id, i) => { pos[id] = { x: ORIGIN + i * COL, y: ORIGIN + (maxRow + 1) * ROW }; });
    return pos;
  }

  class History {
    constructor(limit = 100) { this.limit = limit; this.past = []; this.future = []; }
    push(state) { this.past.push(state); if (this.past.length > this.limit) this.past.shift(); this.future = []; }
    canUndo() { return this.past.length > 0; }
    canRedo() { return this.future.length > 0; }
    undo(current) { if (!this.past.length) return null; this.future.push(current); return this.past.pop(); }
    redo(current) { if (!this.future.length) return null; this.past.push(current); return this.future.pop(); }
  }

  const AUTO_FIT_MIN_ZOOM = 0.85;

  /** View (pan + zoom) that shows every card inside a width x height box with padding.
   *  `minZoom` stops the view from shrinking too far: if the flow is wider (or taller) than the box at that zoom,
   *  the view starts at the left (or top) edge so the beginning of the flow is readable and the rest can be panned to. */
  function fitView(nodes, width, height, pad, minZoom) {
    if (!nodes.length) return { x: 0, y: 0, zoom: 1 };
    const minX = Math.min(...nodes.map(n => n.x)), minY = Math.min(...nodes.map(n => n.y));
    const maxX = Math.max(...nodes.map(n => n.x)) + NODE_W, maxY = Math.max(...nodes.map(n => n.y)) + NODE_H;
    const bw = maxX - minX, bh = maxY - minY;
    const wanted = Math.min(1, (width - 2 * pad) / bw, (height - 2 * pad) / bh);
    const zoom = clampZoom(Math.max(wanted, minZoom || MIN_ZOOM));
    const x = bw * zoom > width - 2 * pad ? pad - minX * zoom : (width - bw * zoom) / 2 - minX * zoom;
    const y = bh * zoom > height - 2 * pad ? pad - minY * zoom : (height - bh * zoom) / 2 - minY * zoom;
    return { x, y, zoom };
  }

  const api = { NODE_W, NODE_H, GRID, MIN_ZOOM, MAX_ZOOM, AUTO_FIT_MIN_ZOOM, snap, clampZoom, portPosition, wirePath, layoutFlow, History, fitView };
  if (typeof document === 'undefined') return api;

  // ---------------------------------------------------------------- browser part
  const SVGNS = 'http://www.w3.org/2000/svg';
  const mk = (tag, cls, attrs) => { const e = document.createElement(tag); if (cls) e.className = cls; for (const [k, v] of Object.entries(attrs || {})) e.setAttribute(k, v); return e; };
  const mkSvg = (tag, attrs) => { const e = document.createElementNS(SVGNS, tag); for (const [k, v] of Object.entries(attrs || {})) e.setAttribute(k, v); return e; };
  const PORT_LABEL = { yes: 'YES', no: 'NO', each: 'EACH', done: 'DONE' };
  const copy = x => JSON.parse(JSON.stringify(x));

  class Canvas {
    constructor(host, opts) {
      this.host = host; this.opts = opts || {}; this.nodes = []; this.edges = []; this.errors = {};
      this.sel = null; this.view = { x: 60, y: 60, zoom: 1 }; this.history = new History(100); this.readOnly = !!this.opts.readOnly;
      this.elems = new Map(); this.wireElems = new Map(); this.people = {}; this.running = {}; this._coalesce = null;
      this._build(); this._bind();
    }

    _build() {
      const h = this.host; h.classList.add('cv'); h.setAttribute('tabindex', '0'); h.setAttribute('role', 'application');
      h.setAttribute('aria-label', 'Flow canvas. Drag cards from the library, connect outputs to inputs. Arrow keys move the selected card, Delete removes it.');
      this.world = mk('div', 'cv-world'); this.svg = mkSvg('svg', { class: 'cv-wires', width: 1, height: 1 });
      this.layer = mk('div', 'cv-nodes'); this.temp = mkSvg('path', { class: 'wire-temp', d: '' });
      this.svg.appendChild(this.temp);
      this.delBtn = mk('button', 'cv-wire-del', { type: 'button', 'aria-label': 'Delete this connection', title: 'Delete this connection' }); this.delBtn.textContent = '×'; this.delBtn.hidden = true;
      this.world.append(this.svg, this.layer, this.delBtn); h.appendChild(this.world);
      this.empty = mk('div', 'cv-empty'); h.appendChild(this.empty);
    }

    _bind() {
      const h = this.host;
      h.addEventListener('pointerdown', e => this._down(e));
      h.addEventListener('wheel', e => this._wheel(e), { passive: false });
      h.addEventListener('dragover', e => { if (!this.readOnly && e.dataTransfer && [...e.dataTransfer.types].includes('application/x-agentflow-card')) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; } });
      h.addEventListener('drop', e => {
        const type = e.dataTransfer && e.dataTransfer.getData('application/x-agentflow-card'); if (!type || this.readOnly) return;
        e.preventDefault(); const p = this.toWorld(e.clientX, e.clientY); this.addNode(type, snap(p.x - NODE_W / 2), snap(p.y - NODE_H / 2));
      });
      h.addEventListener('keydown', e => { e.afHandled = true; this._key(e); });
      // Tabbing to a card selects it, so Delete, arrows, Enter and Ctrl+D work without a mouse.
      h.addEventListener('focusin', e => {
        const el = e.target.closest && e.target.closest('.cv-node'); if (!el) return;
        if (!(this.sel && this.sel.type === 'node' && this.sel.id === el.dataset.id)) this.select({ type: 'node', id: el.dataset.id });
      });
      this.delBtn.addEventListener('click', () => this.deleteSelected());
      new ResizeObserver(() => this._applyView()).observe(h);
    }

    // ------------------------------------------------------------ coordinates and view
    toWorld(cx, cy) { const r = this.host.getBoundingClientRect(); return { x: (cx - r.left - this.view.x) / this.view.zoom, y: (cy - r.top - this.view.y) / this.view.zoom }; }
    _applyView() {
      const v = this.view; this.world.style.transform = `translate(${v.x}px, ${v.y}px) scale(${v.zoom})`;
      this.host.style.backgroundPosition = `${v.x}px ${v.y}px`; this.host.style.backgroundSize = `${24 * v.zoom}px ${24 * v.zoom}px`;
      if (this.opts.onView) this.opts.onView(v);
    }
    zoomAt(factor, cx, cy) {
      const r = this.host.getBoundingClientRect(); const px = (cx === undefined ? r.left + r.width / 2 : cx) - r.left, py = (cy === undefined ? r.top + r.height / 2 : cy) - r.top;
      const z = clampZoom(this.view.zoom * factor); const k = z / this.view.zoom;
      this.view = { x: px - (px - this.view.x) * k, y: py - (py - this.view.y) * k, zoom: z }; this._applyView();
    }
    setZoom(z) { this.zoomAt(clampZoom(z) / this.view.zoom); }
    /** Automatic fit (on open and after auto-align): readable first, never below 85%. Wide flows start at the left and can be panned. */
    fit() { const r = this.host.getBoundingClientRect(); this.view = fitView(this.nodes, r.width, r.height, 72, AUTO_FIT_MIN_ZOOM); this._applyView(); }
    /** "Fit all": shrinks as far as needed so every card is visible at once. */
    fitAll() { const r = this.host.getBoundingClientRect(); this.view = fitView(this.nodes, r.width, r.height, 72, MIN_ZOOM); this._applyView(); }
    _wheel(e) {
      e.preventDefault();
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? this.host.clientHeight : 1;   // line and page mode (Firefox) to pixels
      const dx = e.deltaX * unit, dy = e.deltaY * unit;
      if (e.ctrlKey || e.metaKey) this.zoomAt(Math.min(1.25, Math.max(0.8, Math.exp(-dy * 0.01))), e.clientX, e.clientY);   // pinch and ctrl+wheel: smooth, bounded steps
      else { this.view = { ...this.view, x: this.view.x - (e.shiftKey ? dy : dx), y: this.view.y - (e.shiftKey ? 0 : dy) }; this._applyView(); }
    }

    // ------------------------------------------------------------ data
    load(nodes, edges) { this.nodes = copy(nodes); this.edges = copy(edges); this.history = new History(100); this._coalesce = null; this.sel = null; this.render(); this.fit(); this._emitSelect(); }
    getGraph() { return { nodes: copy(this.nodes), edges: copy(this.edges) }; }
    _snapshot() { return JSON.stringify({ nodes: this.nodes, edges: this.edges }); }
    _record() { this.history.push(this._snapshot()); this._coalesce = null; }
    /** Like _record, but repeated changes with the same key inside 0.9 s (typing, held arrow key) become one undo step. */
    _recordMerged(key) {
      const now = Date.now();
      if (!(this._coalesce && this._coalesce.key === key && now - this._coalesce.at < 900)) this._record();
      this._coalesce = { key, at: now };
    }
    _changed(reason) { if (this.opts.onChange) this.opts.onChange(this.getGraph(), reason); }
    _restore(json) { this._coalesce = null; const g = JSON.parse(json); this.nodes = g.nodes; this.edges = g.edges; if (this.sel && !(this.sel.type === 'node' ? this.nodes.some(n => n.id === this.sel.id) : this.edges.some(x => x.id === this.sel.id))) this.sel = null; this.render(); this._emitSelect(); this._changed('history'); }
    undo() { if (this.readOnly) return; const s = this.history.undo(this._snapshot()); if (s) this._restore(s); }
    redo() { if (this.readOnly) return; const s = this.history.redo(this._snapshot()); if (s) this._restore(s); }
    canUndo() { return this.history.canUndo(); } canRedo() { return this.history.canRedo(); }
    node(id) { return this.nodes.find(n => n.id === id) || null; }

    addNode(type, x, y) {
      if (this.readOnly) return null;
      const refusal = this.opts.beforeAdd ? this.opts.beforeAdd(type, this.nodes) : null;
      if (refusal) { if (this.opts.onNotice) this.opts.onNotice(refusal); return null; }
      const n = Nodes.makeNode(type, x, y, Nodes.nextId(this.nodes)); if (!n) return null;
      this._record(); this.nodes.push(n); this.sel = { type: 'node', id: n.id }; this.render(); this._emitSelect(); this._changed('add'); return n;
    }
    /** Adds a card near the middle of what you can see, on the first spot that does not sit on top of another card. */
    addNodeCentered(type) {
      const r = this.host.getBoundingClientRect(); const p = this.toWorld(r.left + r.width / 2, r.top + r.height / 2);
      const x = snap(p.x - NODE_W / 2); const y0 = snap(p.y - NODE_H / 2); const gap = NODE_H + 28;
      const taken = (cx, cy) => this.nodes.some(n => Math.abs(n.x - cx) < NODE_W + 16 && Math.abs(n.y - cy) < NODE_H + 16);
      let y = y0;
      for (let i = 0; i < 40; i++) { y = y0 + (i === 0 ? 0 : Math.ceil(i / 2) * gap * (i % 2 ? 1 : -1)); if (!taken(x, y)) break; }
      return this.addNode(type, x, snap(y));
    }

    /** Patch a card. Fast typing is merged into one undo step through `key`. */
    updateNode(id, patch, key) {
      if (this.readOnly) return; const n = this.node(id); if (!n) return;
      if (this._refuseLocked(id)) return;
      if (key) this._recordMerged(key); else this._record();
      if (patch.label !== undefined) n.label = patch.label;
      if (patch.config) n.config = Object.assign({}, n.config, patch.config);
      this._refreshNode(id); this._drawWires(); this._changed('edit');
    }

    deleteSelected() {
      if (this.readOnly || !this.sel) return;
      if (this.sel.type === 'node' && this._refuseLocked(this.sel.id)) return;
      this._record();
      if (this.sel.type === 'node') { const id = this.sel.id; this.nodes = this.nodes.filter(n => n.id !== id); this.edges = this.edges.filter(e => e.from !== id && e.to !== id); } else this.edges = this.edges.filter(e => e.id !== this.sel.id);
      this.sel = null; this.render(); this._emitSelect(); this._changed('delete');
    }
    duplicateSelected() {
      if (this.readOnly || !this.sel || this.sel.type !== 'node') return null;
      const src = this.node(this.sel.id); if (!src || Engine.effective(src) === 'start') { if (src && this.opts.onNotice) this.opts.onNotice('A flow can only have one Start card, so it cannot be duplicated.'); return null; }
      this._record(); const n = copy(src); n.id = Nodes.nextId(this.nodes); n.x = snap(src.x + 32); n.y = snap(src.y + 32); n.label = src.label + ' copy';
      this.nodes.push(n); this.sel = { type: 'node', id: n.id }; this.render(); this._emitSelect(); this._changed('duplicate'); return n;
    }
    connect(from, fromPort, to, toPort) {
      if (this.readOnly) return false;
      if (this._refuseLocked(from) || this._refuseLocked(to)) return false;
      const why = Engine.checkConnection(this.nodes, this.edges, from, fromPort, to, toPort);
      if (why) { if (this.opts.onNotice) this.opts.onNotice(why); return false; }
      this._record(); let n = this.edges.length + 1; while (this.edges.some(e => e.id === 'e' + n)) n += 1;
      this.edges.push({ id: 'e' + n, from, fromPort, to, toPort }); this._drawWires(); this._changed('connect'); return true;
    }
    /** Remove one connection (also used by the keyboard-accessible connection list in the settings panel). */
    deleteEdge(id) {
      if (this.readOnly || !this.edges.some(e => e.id === id)) return false;
      const ed = this.edges.find(e => e.id === id);
      if (this._refuseLocked(ed.from) || this._refuseLocked(ed.to)) return false;
      this._record(); this.edges = this.edges.filter(e => e.id !== id);
      if (this.sel && this.sel.type === 'edge' && this.sel.id === id) { this.sel = null; this._emitSelect(); }
      this._drawWires(); this._changed('delete'); return true;
    }
    autoAlign() {
      if (this.readOnly || !this.nodes.length) return;
      const held = this.nodes.find(n => this.isLocked(n.id)); if (held && this._refuseLocked(held.id)) return;
      this._record(); const pos = layoutFlow(this.nodes, this.edges);
      for (const n of this.nodes) if (pos[n.id]) { n.x = pos[n.id].x; n.y = pos[n.id].y; }
      this.render(); this.fit(); this._changed('align');
    }

    // ------------------------------------------------------------ selection and status
    select(sel) { this.sel = sel; this._markSelection(); this._emitSelect(); }
    _emitSelect() { this._markSelection(); if (this.opts.onSelect) this.opts.onSelect(this.sel ? { ...this.sel } : null); }
    setErrors(byNode) { this.errors = byNode || {}; for (const n of this.nodes) this._refreshNode(n.id); }
    setPeople(map) { this.people = map || {}; for (const n of this.nodes) this._refreshNode(n.id); }
    /** Names of colleagues who hold the edit lock on a card (never includes you). */
    lockHolders(id) { return (this.people[id] || []).filter(w => w.lock).map(w => w.name); }
    isLocked(id) { return this.lockHolders(id).length > 0; }
    _refuseLocked(id) {
      const who = this.lockHolders(id); if (!who.length) return false;
      if (this.opts.onNotice) this.opts.onNotice(`${who.join(', ')} ${who.length === 1 ? 'is' : 'are'} editing this card. You can change it when they finish.`);
      return true;
    }
    /** Replace everything with a new graph as a single undo step. Refused while a colleague holds a lock. */
    replaceAll(nodes, edges) {
      if (this.readOnly) return false;
      const held = this.nodes.find(n => this.isLocked(n.id)); if (held && this._refuseLocked(held.id)) return false;
      this._record(); this.nodes = copy(nodes); this.edges = copy(edges); this.sel = null;
      this.render(); this.fit(); this._emitSelect(); this._changed('architect'); return true;
    }
    /** Swap in a graph saved elsewhere (a colleague's save or a merge) without moving the view. Undo history starts over. */
    replaceGraph(nodes, edges) {
      this.nodes = copy(nodes); this.edges = copy(edges); this.history = new History(100); this._coalesce = null;
      if (this.sel && !(this.sel.type === 'node' ? this.nodes.some(n => n.id === this.sel.id) : this.edges.some(x => x.id === this.sel.id))) this.sel = null;
      this.render(); this._emitSelect();
    }
    /** Show run state on the cards (running / success / failed / skipped). `live` makes the wires pulse while a run is active. */
    setRunning(map, live) { this.running = map || {}; this.live = !!live; for (const n of this.nodes) this._refreshNode(n.id); this._drawWires(); }
    setReadOnly(v) { this.readOnly = !!v; this.host.classList.toggle('is-readonly', this.readOnly); }
    focusNode(id) { const el = this.elems.get(id); if (el) el.focus(); }
    pulseEdge(id, on) { const w = this.wireElems.get(id); if (w) w.classList.toggle('is-live', on); }

    // ------------------------------------------------------------ rendering
    render() {
      this.layer.replaceChildren(); this.elems.clear();
      for (const n of this.nodes) { const el = this._makeNode(n); this.elems.set(n.id, el); this.layer.appendChild(el); }
      this._drawWires(); this._markSelection(); this._emptyState();
    }
    _emptyState() {
      this.empty.hidden = this.nodes.length > 0;
      if (!this.nodes.length) this.empty.replaceChildren(Object.assign(mk('h2'), { textContent: 'Your canvas is empty' }), Object.assign(mk('p'), { textContent: 'Drag a card from the library on the left, or click one to add it. Start with a Start card.' }));
    }
    _makeNode(n) {
      const def = Nodes.get(n.type) || (n.base && Nodes.get(n.base)); const cat = def ? def.category : 'ai';
      const el = mk('div', `node cv-node cat-${cat}`, { 'data-id': n.id, tabindex: '0', role: 'group' });
      el.style.left = n.x + 'px'; el.style.top = n.y + 'px';
      el.append(mk('i', 'punch'));
      const ports = Nodes.portsOf(n) || { in: false, out: [] };
      if (ports.in) el.append(mk('i', 'pin in', { 'data-port': 'in', 'aria-hidden': 'true', title: 'Input' }));
      ports.out.forEach((p, i) => {
        const cls = ports.out.length < 2 ? 'pin out' : `pin out ${i === 0 ? 'pin-top' : 'pin-bottom'}`;
        el.append(mk('i', cls, { 'data-port': p, 'aria-hidden': 'true', title: PORT_LABEL[p] ? PORT_LABEL[p] + ' output' : 'Output' }));
        if (PORT_LABEL[p]) { const l = mk('span', `pin-label ${i === 0 ? 'pin-top' : 'pin-bottom'}`); l.textContent = PORT_LABEL[p]; el.append(l); }
      });
      el.append(mk('span', 'kind'), mk('span', 'title'), mk('span', 'meta'), mk('span', 'people'), mk('span', 'flag'));
      this._fill(el, n); return el;
    }
    _fill(el, n) {
      const def = Nodes.get(n.type) || (n.base && Nodes.get(n.base)); const errs = this.errors[n.id] || []; const state = this.running[n.id];
      el.querySelector('.kind').textContent = (def ? Nodes.categories.find(c => c.id === def.category).label.replace(/s$/, '') : 'Unknown') + (def && def.custom ? ' · custom' : '');
      el.querySelector('.title').textContent = n.label || (def ? def.label : 'Card');
      const meta = el.querySelector('.meta'); meta.textContent = errs.length ? errs[0] : Nodes.summary(n); meta.classList.toggle('is-error', errs.length > 0);
      el.classList.toggle('has-error', errs.length > 0);
      for (const s of ['is-running', 'is-success', 'is-failed', 'is-skipped']) el.classList.remove(s);
      if (state) el.classList.add('is-' + state);
      const flag = el.querySelector('.flag'); flag.textContent = errs.length ? String(errs.length) : ''; flag.hidden = !errs.length; flag.title = errs.join('\n');
      const who = this.people[n.id]; const pe = el.querySelector('.people'); pe.textContent = who ? who.map(w => w.name.split(/\s+/).map(x => x[0]).join('').slice(0, 2).toUpperCase()).join(' ') : ''; pe.hidden = !who; pe.title = who ? who.map(w => w.name + (w.lock ? ' is editing' : ' is looking')).join(', ') : '';
      el.classList.toggle('is-locked', !!(who && who.some(w => w.lock)));
      el.setAttribute('aria-label', `${n.label}, ${def ? def.label : 'unknown'} card${errs.length ? ', has a problem: ' + errs[0] : ''}`);
    }
    _refreshNode(id) { const el = this.elems.get(id), n = this.node(id); if (el && n) { el.style.left = n.x + 'px'; el.style.top = n.y + 'px'; this._fill(el, n); } }
    _markSelection() {
      for (const [id, el] of this.elems) el.classList.toggle('is-selected', !!this.sel && this.sel.type === 'node' && this.sel.id === id);
      for (const [id, w] of this.wireElems) w.classList.toggle('is-selected', !!this.sel && this.sel.type === 'edge' && this.sel.id === id);
      this._placeDelBtn();
    }
    _placeDelBtn() {
      const e = this.sel && this.sel.type === 'edge' ? this.edges.find(x => x.id === this.sel.id) : null;
      if (!e || this.readOnly) { this.delBtn.hidden = true; return; }
      const a = this.node(e.from), b = this.node(e.to); if (!a || !b) { this.delBtn.hidden = true; return; }
      const p1 = portPosition(a, 'out', e.fromPort || 'out'), p2 = portPosition(b, 'in', 'in');
      this.delBtn.style.left = (p1.x + p2.x) / 2 + 'px'; this.delBtn.style.top = (p1.y + p2.y) / 2 + 'px'; this.delBtn.hidden = false;
    }
    /** While a card moves, only its own wires change shape: update their path data instead of rebuilding every wire. */
    _moveWires(id) {
      for (const e of this.edges) {
        if (e.from !== id && e.to !== id) continue;
        const g = this.wireElems.get(e.id), a = this.node(e.from), b = this.node(e.to); if (!g || !a || !b) continue;
        const p1 = portPosition(a, 'out', e.fromPort || 'out'), p2 = portPosition(b, 'in', 'in'); const d = wirePath(p1.x, p1.y, p2.x, p2.y);
        g.querySelectorAll('path').forEach(p => p.setAttribute('d', d));
      }
      this._placeDelBtn();
    }
    _drawWires() {
      for (const el of this.wireElems.values()) el.remove(); this.wireElems.clear();
      for (const e of this.edges) {
        const a = this.node(e.from), b = this.node(e.to); if (!a || !b) continue;
        const p1 = portPosition(a, 'out', e.fromPort || 'out'), p2 = portPosition(b, 'in', 'in'); const d = wirePath(p1.x, p1.y, p2.x, p2.y);
        const g = mkSvg('g', { class: 'wire-group', 'data-edge': e.id });
        g.append(mkSvg('path', { class: 'wire-hit', d }), mkSvg('path', { class: 'wire', d }), mkSvg('path', { class: 'wire-pulse', d }));
        if (this.running[e.from] === 'success' && this.running[e.to] !== undefined && this.running[e.to] !== 'skipped') g.classList.add(this.live ? 'is-live' : 'is-done');
        this.svg.insertBefore(g, this.temp); this.wireElems.set(e.id, g);
      }
      this._markSelection();
    }

    // ------------------------------------------------------------ pointer interaction
    _down(e) {
      if (e.isPrimary === false) return;                 // a second finger must not start a second drag
      if (e.button !== 0 && e.button !== 1) return;
      if (e.button === 1) e.preventDefault();            // no browser autoscroll on middle-click panning
      const pin = e.target.closest('.pin.out'); const nodeEl = e.target.closest('.cv-node'); const wire = e.target.closest('.wire-group');
      this.host.focus({ preventScroll: true });
      if (this.opts.onCanvasPointer) this.opts.onCanvasPointer();
      if (pin && nodeEl && !this.readOnly) { e.preventDefault(); this._startConnect(e, nodeEl.dataset.id, pin.dataset.port); return; }
      if (nodeEl && e.button === 0) { this.select({ type: 'node', id: nodeEl.dataset.id }); if (!this.readOnly && !this.isLocked(nodeEl.dataset.id)) this._startDrag(e, nodeEl.dataset.id); return; }
      if (wire) { this.select({ type: 'edge', id: wire.dataset.edge }); return; }
      if (e.target.closest('.cv-wire-del')) return;
      if (this.sel) this.select(null);
      this._startPan(e);
    }
    _track(e, move, up) {
      const id = e.pointerId; const m = ev => { if (ev.pointerId === id) move(ev); }; const u = ev => { if (ev.pointerId !== id) return; window.removeEventListener('pointermove', m); window.removeEventListener('pointerup', u); window.removeEventListener('pointercancel', u); up(ev); };
      window.addEventListener('pointermove', m); window.addEventListener('pointerup', u); window.addEventListener('pointercancel', u);
    }
    _startPan(e) {
      const sx = e.clientX, sy = e.clientY, ox = this.view.x, oy = this.view.y; this.host.classList.add('is-panning');
      this._track(e, ev => { this.view = { ...this.view, x: ox + ev.clientX - sx, y: oy + ev.clientY - sy }; this._applyView(); }, () => this.host.classList.remove('is-panning'));
    }
    _startDrag(e, id) {
      const n = this.node(id); const sx = e.clientX, sy = e.clientY, ox = n.x, oy = n.y; let moved = false; const before = this._snapshot();
      this._track(e, ev => {
        const dx = (ev.clientX - sx) / this.view.zoom, dy = (ev.clientY - sy) / this.view.zoom;
        if (!moved && Math.abs(dx) + Math.abs(dy) < 3) return; moved = true;
        n.x = ev.altKey ? ox + dx : snap(ox + dx); n.y = ev.altKey ? oy + dy : snap(oy + dy); this._refreshNode(id); this._moveWires(id);
      }, () => { if (moved) { this.history.push(before); this._coalesce = null; this._changed('move'); } });
    }
    _startConnect(e, from, fromPort) {
      const a = this.node(from); const p1 = portPosition(a, 'out', fromPort); this.host.classList.add('is-connecting');
      for (const n of this.nodes) { const ok = !Engine.checkConnection(this.nodes, this.edges, from, fromPort, n.id, 'in'); const el = this.elems.get(n.id); el.classList.toggle('is-target', ok && n.id !== from); el.classList.toggle('is-denied', !ok && n.id !== from); }
      this._track(e, ev => { const p = this.toWorld(ev.clientX, ev.clientY); this.temp.setAttribute('d', wirePath(p1.x, p1.y, p.x, p.y)); }, ev => {
        this.temp.setAttribute('d', ''); this.host.classList.remove('is-connecting');
        for (const el of this.elems.values()) el.classList.remove('is-target', 'is-denied');
        if (ev.type === 'pointercancel') return;                         // a cancelled touch must not create a wire at a stale position
        const hit = document.elementFromPoint(ev.clientX, ev.clientY); const target = hit && hit.closest('.cv-node');
        if (target && this.host.contains(target) && target.dataset.id !== from) this.connect(from, fromPort, target.dataset.id, 'in');   // a plain click on the pin is not an error
      });
    }

    // ------------------------------------------------------------ keyboard
    handleKey(e) { this._key(e); }
    _key(e) {
      const tag = (e.target.tagName || '').toLowerCase(); if (['input', 'textarea', 'select'].includes(tag)) return;
      const mod = e.ctrlKey || e.metaKey; const k = e.key;
      if (mod && !e.shiftKey && k.toLowerCase() === 'z') { e.preventDefault(); this.undo(); return; }
      if (mod && (k.toLowerCase() === 'y' || (e.shiftKey && k.toLowerCase() === 'z'))) { e.preventDefault(); this.redo(); return; }
      if (mod && k.toLowerCase() === 'd') { e.preventDefault(); this.duplicateSelected(); return; }
      if (k === 'Delete' || k === 'Backspace') { if (this.sel) { e.preventDefault(); this.deleteSelected(); } return; }
      if (k === 'Escape') { this.select(null); return; }
      if (k === 'f' && !mod) { this.fitAll(); return; }
      if (!mod && (k === '+' || k === '=')) { this.zoomAt(1.2); return; }
      if (!mod && k === '-') { this.zoomAt(1 / 1.2); return; }
      if (k === 'Enter' && this.sel && this.sel.type === 'node') { if (this.opts.onOpen) this.opts.onOpen(this.sel.id); return; }
      const step = e.shiftKey ? 32 : GRID; const move = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[k];
      if (move && this.sel && this.sel.type === 'node' && !this.readOnly && !this.isLocked(this.sel.id)) { e.preventDefault(); const n = this.node(this.sel.id); this._recordMerged('move:' + n.id); n.x += move[0]; n.y += move[1]; this._refreshNode(n.id); this._moveWires(n.id); this._changed('move'); }
    }
  }

  return Object.assign(api, { Canvas });
});
