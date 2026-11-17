/* Builder page: library, canvas, settings panel, validation, save. Phase 7 adds Run + the results drawer, phase 8 history,
 * phase 9 co-work, phase 10 the AI Flow Architect and export. Everything shared is exposed on AF.builder for those phases. */
(async function () {
  'use strict';
  const { el, icon } = AF.ui; const K = AF.kit; const Nodes = AF.nodes; const Engine = AF.engine; const CV = AF.canvas; const Credits = AF.credits;
  const ctx = await AF.ui.boot({ roles: ['superadmin', 'admin', 'employee', 'individual'], title: 'Builder', bare: true });
  if (!ctx) return;
  const $ = id => document.getElementById(id);
  const { user } = ctx;
  Nodes.loadCustomCards((user.prefs && user.prefs.customCards) || []);
  let customCards = Nodes.cleanCustomCards((user.prefs && user.prefs.customCards) || []);

  const flowId = new URLSearchParams(location.search).get('id') || '';
  const [r, u] = await Promise.all([AF.db.getFlow(flowId), AF.db.getUsage()]);
  if (!r.ok) {
    $('builder').replaceChildren(el('main', { class: 'content' }, el('h1', { text: 'This flow could not be opened' }), el('p', { class: 'muted', text: (r.error || 'Something went wrong.') + ' It may have been deleted, or it belongs to someone else.' }), el('a', { class: 'btn btn-primary', href: 'flows.html', text: 'Back to my flows' })));
    return;
  }
  let flow = r.flow; const canEdit = r.can_edit; let usage = u.ok ? u.usage : null; let dirty = false; let saving = false; let changeSeq = 0; let problems = { ok: true, errors: [], by_node: {} };
  document.title = flow.name + ' · AgentFlow';
  let cowork = null; let newer = null; let lockSig = '';   // phase 9: live co-work state

  // ---------------------------------------------------------------- toolbar
  const iconBtn = (name, label, fn) => { const b = el('button', { type: 'button', class: 'btn btn-ghost icon-btn', 'aria-label': label, title: label, on: { click: fn } }, icon(name, 18)); return b; };
  const undoBtn = iconBtn('undo', 'Undo (Ctrl+Z)', () => canvas.undo()); const redoBtn = iconBtn('redo', 'Redo (Ctrl+Y)', () => canvas.redo());
  $('tools').append(undoBtn, redoBtn, iconBtn('align', 'Auto-align cards', () => canvas.autoAlign()), iconBtn('fit', 'Fit all (F): zoom out until every card is visible', () => canvas.fitAll()), iconBtn('help', 'Keyboard shortcuts', showShortcuts));
  $('zoom').append(iconBtn('plus', 'Zoom in (+)', () => canvas.zoomAt(1.2)), iconBtn('minus', 'Zoom out (-)', () => canvas.zoomAt(1 / 1.2)));
  const zoomLabel = el('button', { type: 'button', class: 'btn btn-ghost btn-sm', 'aria-label': 'Reset zoom to 100 percent', text: '100%', on: { click: () => canvas.setZoom(1) } });
  $('zoom').append(zoomLabel);

  const problemsBtn = el('button', { type: 'button', class: 'badge', on: { click: showProblems } });
  const historyBtn = el('button', { type: 'button', id: 'hist-toggle', class: 'btn btn-secondary', 'aria-expanded': 'false', 'aria-controls': 'hist-panel', on: { click: () => AF.history.open() } }, icon('history', 16), el('span', { text: 'History' }));
  const exportBtn = el('button', { type: 'button', class: 'btn btn-secondary', on: { click: () => openExport() } }, icon('export', 16), el('span', { text: 'Export' }));
  const saveBtn = el('button', { type: 'button', class: 'btn btn-primary', text: 'Save', on: { click: () => save() } }, '');
  const canRun = user.role !== 'superadmin';
  const runBtn = el('button', { type: 'button', class: 'btn btn-secondary', title: canRun ? 'Run this flow (Ctrl+Enter)' : 'Super admins can look at flows but cannot run them', disabled: canRun ? null : true, on: { click: () => onRunClick() } });
  function paintRunBtn(mode) {   // 'idle' | 'starting' | 'running' | 'stopping'
    const label = { idle: 'Run', starting: 'Starting…', running: 'Stop', stopping: 'Stopping…' }[mode];
    runBtn.className = 'btn ' + (mode === 'running' ? 'btn-danger' : 'btn-secondary'); runBtn.disabled = !canRun || mode === 'starting' || mode === 'stopping';
    runBtn.replaceChildren(icon(mode === 'running' ? 'stop' : 'play', 16), el('span', { text: label }));
    runBtn.setAttribute('aria-label', { idle: 'Run this flow', starting: 'Starting the run', running: 'Stop the run', stopping: 'Stopping the run' }[mode]);
  }
  paintRunBtn('idle');
  $('b-right').append(problemsBtn, historyBtn, exportBtn, canEdit ? saveBtn : K.badge('View only'), runBtn);

  // ---------------------------------------------------------------- canvas
  const canvas = new CV.Canvas($('canvas'), {
    readOnly: !canEdit,
    onChange: () => { changeSeq += 1; dirty = true; paintState(); validateNow(); paintHistory(); },
    onSelect: sel => { renderSettings(sel); coworkFocus(sel); },
    onNotice: msg => AF.ui.toast(msg, 'error'),
    onOpen: () => { const f = $('settings').querySelector('input,textarea,select'); if (f) f.focus(); },
    onView: v => { zoomLabel.textContent = Math.round(v.zoom * 100) + '%'; },
    beforeAdd: (type, nodes) => (Engine.effective({ type }) === 'start' && nodes.some(n => Engine.effective(n) === 'start') ? 'A flow can only have one Start card.' : null),
  });
  canvas.setReadOnly(!canEdit);
  const nameInput = $('flow-name'); nameInput.value = flow.name; nameInput.disabled = !canEdit;
  nameInput.addEventListener('input', () => { changeSeq += 1; dirty = true; paintState(); });

  function paintHistory() { undoBtn.disabled = !canvas.canUndo() || !canEdit; redoBtn.disabled = !canvas.canRedo() || !canEdit; }
  function paintState() {
    const s = $('save-state'); $('ver-pill').textContent = 'v' + flow.version;
    if (!canEdit) { s.textContent = 'You can look, but not change this flow.'; s.className = 'b-state'; return; }
    s.textContent = saving ? 'Saving…' : dirty ? 'Unsaved changes' + (newer && newer.n > flow.version ? ' · ' + newer.by + ' saved v' + newer.n + ', saving will merge' : '') : 'All changes saved'; s.className = 'b-state' + (dirty && !saving ? ' is-dirty' : '');
  }
  function validateNow() {
    const g = canvas.getGraph(); problems = Engine.validateFlow(g.nodes, g.edges); canvas.setErrors(problems.by_node);
    const n = problems.errors.length;
    problemsBtn.textContent = n ? n + (n === 1 ? ' problem' : ' problems') : 'No problems'; problemsBtn.className = 'badge ' + (n ? 'badge-danger' : 'badge-ok'); problemsBtn.setAttribute('aria-label', n ? n + ' problems in this flow. Show them.' : 'No problems found in this flow');
    paintProblemLists();
  }

  // ---------------------------------------------------------------- save
  async function save() {
    if (!canEdit || saving) return; const g = canvas.getGraph(); const seqAtSend = changeSeq; const sentBase = flow.version; saving = true; paintState();
    const res = await AF.db.saveFlow(flow.id, { name: nameInput.value.trim() || flow.name, nodes: g.nodes, edges: g.edges, base_version: flow.version, client_id: cowork ? cowork.clientId : undefined });
    saving = false;
    if (res.ok) {
      flow = res.flow;
      dirty = changeSeq !== seqAtSend;                    // edits made while the save was in flight stay "unsaved"
      if (!dirty) nameInput.value = flow.name;
      newer = null;
      if (res.merged && dirty) {   // the canvas still lacks the colleague's cards: keep the OLD base so the next save merges again instead of deleting them
        flow = Object.assign({}, res.flow, { version: sentBase }); newer = { n: res.flow.version, by: 'A colleague' };
      }
      if (res.merged && !dirty) { canvas.replaceGraph(flow.nodes, flow.edges); nameInput.value = flow.name; }
      if (res.version && cowork) cowork.announceSaved(res.version.n, res.version.summary);
      document.title = flow.name + ' · AgentFlow'; paintState(); if (AF.history && AF.history.isOpen()) AF.history.refresh(); AF.ui.toast(res.version ? (res.merged ? 'Saved and merged with your colleague\'s changes as version ' : 'Saved as version ') + res.version.n + ': ' + res.version.summary : 'Nothing had changed.'); return; }
    paintState();
    if (res.status === 409 && res.code === 'conflict') return conflict(res.flow, res.conflicts);
    if (res.status === 423) { AF.ui.toast(res.error, 'error'); $('save-state').textContent = 'Not saved: a card is being edited'; return; }
    $('save-state').textContent = 'Could not save'; AF.ui.toast(res.error || 'Could not save.', 'error');
  }
  function conflict(theirs, conflicts) {
    const list = conflicts && conflicts.length ? el('ul', {}, conflicts.map(c => el('li', { text: c.label + ': ' + c.reason }))) : null;
    K.modal({ title: 'Your changes clash with a colleague\'s', body: el('div', {}, el('p', { text: 'Version ' + theirs.version + ' was saved after you opened the flow. Changes to different cards are merged automatically, but these clash:' }), list, el('p', { text: 'Your changes are not saved yet. Choose what to keep.' })), dismissible: false, actions: [
      { label: 'Keep editing', onClick: ({ close }) => close() },
      { label: 'Load their version', onClick: ({ close }) => { flow = theirs; canvas.load(theirs.nodes, theirs.edges); nameInput.value = theirs.name; dirty = false; paintState(); validateNow(); close(); AF.ui.toast('Loaded version ' + theirs.version + '. Your unsaved changes were discarded.'); } },
      { label: 'Overwrite with my changes', kind: 'danger', onClick: async ({ close }) => { flow.version = theirs.version; close(); await save(); } }] });
  }
  document.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); save(); }
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); onRunClick(); }
  });
  // Undo, redo, duplicate and delete work from anywhere on the page, except while typing in a field or a dialog is open.
  document.addEventListener('keydown', e => {
    if (e.afHandled || (e.target.closest && e.target.closest('.cv'))) return;
    const tag = (e.target.tagName || '').toLowerCase();
    if (['input', 'textarea', 'select'].includes(tag) || document.querySelector('.modal-backdrop')) return;
    const mod = e.ctrlKey || e.metaKey; const k = e.key.toLowerCase();
    if ((mod && ['z', 'y', 'd'].includes(k)) || e.key === 'Delete') canvas.handleKey(e);
  });
  window.addEventListener('beforeunload', e => { if (dirty) { e.preventDefault(); e.returnValue = ''; } });

  // ---------------------------------------------------------------- library
  const libHost = $('lib'); const search = $('lib-search'); let filter = '';
  function slug(s) { return s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 18) || 'card'; }
  function libCard(t) {
    const b = el('button', { type: 'button', class: `lib-card cat-${t.category}`, draggable: canEdit ? 'true' : null, disabled: canEdit ? null : true, 'aria-label': 'Add ' + t.label + ' card. ' + t.description, title: t.description },
      icon(t.icon, 20), el('span', { class: 'lib-text' }, el('b', { text: t.label }), el('span', { text: t.description })));
    b.addEventListener('click', () => { if (canEdit) canvas.addNodeCentered(t.id); });
    b.addEventListener('dragstart', e => { e.dataTransfer.setData('application/x-agentflow-card', t.id); e.dataTransfer.effectAllowed = 'copy'; });
    if (!t.custom) return b;
    const del = el('button', { type: 'button', class: 'btn btn-ghost btn-sm', 'aria-label': 'Remove my card ' + t.label, title: 'Remove from My cards', text: '×', on: { click: () => removeMyCard(t) } });
    return el('div', { class: 'lib-row' }, b, canEdit ? del : null);
  }
  // Which categories are folded is remembered in this browser only (a per-person convenience).
  let folded = new Set(); try { folded = new Set(JSON.parse(localStorage.getItem('af.lib.folded') || '[]')); } catch (e) { /* storage blocked */ }
  function toggleGroup(id) { if (folded.has(id)) folded.delete(id); else folded.add(id); try { localStorage.setItem('af.lib.folded', JSON.stringify([...folded])); } catch (e) { /* ignore */ } renderLib(); }
  function group(id, label, items) {
    const open = !!filter || !folded.has(id);   // searching always shows the matches
    const head = el('button', { type: 'button', class: 'lib-head', 'aria-expanded': String(open), 'aria-controls': 'lib-items-' + id, on: { click: () => toggleGroup(id) } }, icon('chev', 14), el('span', { text: label }), el('span', { class: 'count', text: String(items.length) }));
    return el('section', { class: 'lib-group' }, head, el('div', { class: 'lib-items', id: 'lib-items-' + id, hidden: open ? null : true }, items.map(libCard)));
  }
  function renderLib() {
    const q = filter.toLowerCase(); const all = Nodes.types().filter(t => !q || t.label.toLowerCase().includes(q) || t.description.toLowerCase().includes(q));
    const groups = Nodes.categories.map(c => ({ c, items: all.filter(t => t.category === c.id && !t.custom) })).filter(g => g.items.length);
    const mine = all.filter(t => t.custom);
    const out = groups.map(g => group(g.c.id, g.c.label, g.items));
    if (mine.length) out.push(group('mine', 'My cards', mine));
    if (!out.length) out.push(el('p', { class: 'muted', style: null, text: 'No card matches "' + filter + '". Try a different word.' }));
    if (!canEdit) out.unshift(el('p', { class: 'notice', text: 'View only: you cannot add cards to this flow.' }));
    libHost.replaceChildren(...out);
  }
  search.addEventListener('input', () => { filter = search.value; renderLib(); });
  async function persistCards(next, okMsg) {
    const res = await AF.db.saveCustomCards({ cards: next });
    if (!res.ok) { AF.ui.toast(res.error || 'Could not save your cards.', 'error'); return false; }
    customCards = res.cards; Nodes.loadCustomCards(customCards); renderLib(); AF.ui.toast(okMsg); return true;
  }
  function saveAsMyCard(shown) {
    const node = canvas.getGraph().nodes.find(x => x.id === shown.id) || shown;   // the panel's copy is from when it was drawn; use what is on the canvas now
    K.formModal({ title: 'Save as my card', intro: 'Keeps the current settings as a ready-made card in your library, under "My cards". Only you can see it.', submitLabel: 'Save card',
      fields: [{ name: 'name', label: 'Card name', value: node.label, required: true, maxlength: 40 }],
      onSubmit: async v => {
        if (customCards.length >= Nodes.MAX_CUSTOM) return { ok: false, error: 'You can keep up to ' + Nodes.MAX_CUSTOM + ' cards of your own. Remove one first.' };
        const base = Engine.effective(node);
        const card = { id: 'custom_' + slug(v.name) + '_' + Math.random().toString(36).slice(2, 6), label: v.name.trim(), base, config: node.config };
        if (!Nodes.registerCustom(card).ok) return { ok: false, errors: { name: 'Enter a name up to 40 characters.' } };
        Nodes.unregisterCustom(card.id);
        const ok = await persistCards(customCards.concat([card]), '"' + card.label + '" is now in My cards.');
        return ok ? { ok: true } : { ok: false, error: 'Could not save your card. Try again.' };
      } });
  }
  async function removeMyCard(t) {
    const yes = await K.confirmDialog({ title: 'Remove "' + t.label + '"?', message: 'It disappears from your library. Cards already placed in flows keep working as ' + Nodes.get(t.base).label + ' cards.', confirmLabel: 'Remove card', danger: true });
    if (yes) persistCards(customCards.filter(c => c.id !== t.id), 'Removed "' + t.label + '".');
  }

  // ---------------------------------------------------------------- settings panel
  const settings = $('settings'); let problemSpots = [];
  function problemList(list, onPick) {
    return el('ul', { class: 'problem-list' }, list.map(e => el('li', {}, e.node_id && onPick ? el('button', { type: 'button', text: e.message, on: { click: () => onPick(e.node_id) } }) : e.message)));
  }
  function paintProblemLists() { for (const s of problemSpots) s(); }
  function field(n, f) {
    const id = 'set-' + n.id + '-' + f.name; const val = (n.config || {})[f.name];
    let input;
    if (f.type === 'select') { input = el('select', { class: 'input', id }, f.options.map(o => el('option', { value: o.value, text: o.label }))); input.value = val === undefined ? '' : val; }
    else if (f.type === 'textarea') { input = el('textarea', { class: 'input', id, rows: 5, spellcheck: 'false' }); input.value = val === undefined ? '' : val; }
    else { input = el('input', { class: 'input', id, type: f.type === 'number' ? 'number' : f.type === 'email' ? 'email' : 'text', min: f.min, max: f.max, placeholder: f.placeholder, autocomplete: 'off' }); input.value = val === undefined || val === null ? '' : val; }
    input.disabled = !canEdit;
    input.addEventListener('input', () => canvas.updateNode(n.id, { config: { [f.name]: f.type === 'number' && input.value !== '' ? Number(input.value) : input.value } }, 'cfg:' + n.id + ':' + f.name));
    return el('div', { class: 'field' }, el('label', { class: 'label', for: id }, f.label, f.required ? el('span', { class: 'muted', text: ' (required)' }) : null), input, f.hint ? el('div', { class: 'hint', text: f.hint }) : null);
  }
  /** Connections of the selected card as a plain list plus a "Connect to…" form, so everything can be done without a mouse. */
  function connectionsPanel(n, g) {
    const labelOf = id => (g.nodes.find(x => x.id === id) || {}).label || id;
    const ports = Nodes.portsOf(n) || { in: false, out: [] };
    const outs = g.edges.filter(e => e.from === n.id);
    const list = outs.length
      ? el('ul', { class: 'conn-list' }, outs.map(e => el('li', {}, el('span', { text: (e.fromPort && e.fromPort !== 'out' ? e.fromPort.toUpperCase() + ' → ' : '→ ') + labelOf(e.to) }),
        canEdit ? el('button', { type: 'button', class: 'btn btn-ghost btn-sm', 'aria-label': 'Remove the connection to ' + labelOf(e.to), text: 'Remove', on: { click: () => { canvas.deleteEdge(e.id); renderSettings(canvas.sel); } } }) : null)))
      : el('p', { class: 'muted', text: ports.out.length ? 'Nothing is connected after this card yet.' : 'This card ends the flow, so it has no outputs.' });
    if (!canEdit || !ports.out.length) return el('div', { class: 'field' }, el('h3', { text: 'Connections' }), list);
    const targets = g.nodes.filter(x => x.id !== n.id && (Nodes.portsOf(x) || {}).in);
    const pick = el('select', { class: 'input', 'aria-label': 'Connect to card' }, targets.map(t => el('option', { value: t.id, text: t.label })));
    const portSel = ports.out.length > 1 ? el('select', { class: 'input', 'aria-label': 'From which output' }, ports.out.map(p => el('option', { value: p, text: p.toUpperCase() }))) : null;
    const go = el('button', { type: 'button', class: 'btn btn-secondary btn-sm', text: 'Connect', on: { click: () => { if (!targets.length) return; if (canvas.connect(n.id, portSel ? portSel.value : ports.out[0], pick.value, 'in')) renderSettings(canvas.sel); } } });
    return el('div', { class: 'field' }, el('h3', { text: 'Connections' }), list, targets.length ? el('div', { class: 'row' }, ...[portSel, pick, go].filter(Boolean)) : null);
  }
  /** A card another person is editing: show who, and make this panel read-only until they finish. */
  function applyLockState(id) {
    const who = canvas.lockHolders(id); if (!who.length) return;
    settings.prepend(el('p', { class: 'cw-lock-note', role: 'status', text: who.join(', ') + (who.length === 1 ? ' is' : ' are') + ' editing this card. You can look, but not change it until they finish.' }));
    settings.querySelectorAll('input, select, textarea, button').forEach(c => { c.disabled = true; });
  }
  function renderSettings(sel) {
    problemSpots = []; const g = canvas.getGraph();
    if (sel && sel.type === 'node') {
      const n = g.nodes.find(x => x.id === sel.id); if (!n) return renderSettings(null);
      const def = Nodes.get(n.type) || (n.base && Nodes.get(n.base)); const cat = def ? def.category : 'ai';
      const probs = el('div', {}); problemSpots.push(() => { const list = (problems.errors || []).filter(e => e.node_id === n.id); probs.replaceChildren(...(list.length ? [problemList(list)] : [])); }); problemSpots[0]();
      const nameId = 'set-' + n.id + '-label'; const nameInputEl = el('input', { class: 'input', id: nameId, type: 'text', maxlength: 80, autocomplete: 'off' }); nameInputEl.value = n.label; nameInputEl.disabled = !canEdit;
      nameInputEl.addEventListener('input', () => canvas.updateNode(n.id, { label: nameInputEl.value }, 'label:' + n.id));
      settings.replaceChildren(
        el('div', { class: `set-kind cat-${cat}` }, el('i'), el('span', { text: (def ? def.label : 'Unknown card') + (def && def.custom ? ' · based on ' + Nodes.get(def.base).label : '') })),
        el('h2', { text: n.label }), el('p', { class: 'muted', text: def ? def.description : 'This card type is not available.' }), probs,
        el('div', { class: 'field' }, el('label', { class: 'label', for: nameId, text: 'Name of this card' }), nameInputEl),
        ...Nodes.fieldsOf(Engine.effective(n)).map(f => field(n, f)),
        connectionsPanel(n, g),
        canEdit ? el('div', { class: 'row' },
          el('button', { class: 'btn btn-secondary btn-sm', type: 'button', text: 'Duplicate card', on: { click: () => canvas.duplicateSelected() } }),
          el('button', { class: 'btn btn-secondary btn-sm', type: 'button', text: 'Save as my card', on: { click: () => saveAsMyCard(n) } }),
          el('button', { class: 'btn btn-danger btn-sm', type: 'button', text: 'Delete card', on: { click: () => canvas.deleteSelected() } })) : null);
      applyLockState(n.id);
      return;
    }
    if (sel && sel.type === 'edge') {
      const e = g.edges.find(x => x.id === sel.id); if (!e) return renderSettings(null);
      const a = g.nodes.find(x => x.id === e.from), b = g.nodes.find(x => x.id === e.to); const port = e.fromPort && e.fromPort !== 'out' ? ' (' + e.fromPort.toUpperCase() + ')' : '';
      settings.replaceChildren(el('h2', { text: 'Connection' }), el('p', { class: 'muted', text: (a ? a.label : '?') + port + ' → ' + (b ? b.label : '?') }), el('p', { text: 'The output of the first card becomes the input of the second.' }),
        canEdit ? el('button', { class: 'btn btn-danger btn-sm', type: 'button', text: 'Delete connection', on: { click: () => canvas.deleteSelected() } }) : null);
      return;
    }
    const flowProblems = el('div', {});
    problemSpots.push(() => { const list = problems.errors || []; flowProblems.replaceChildren(list.length ? el('div', {}, el('h3', { text: 'Problems to fix' }), problemList(list, id => { canvas.select({ type: 'node', id }); canvas.focusNode(id); })) : el('p', { class: 'notice', text: 'No problems found. This flow is ready to run.' })); }); problemSpots[0]();
    const cost = Credits.estimateFlow(g.nodes);
    settings.replaceChildren(el('h2', { text: 'Flow overview' }), el('p', { class: 'muted', text: canEdit ? 'Click a card to change its settings, or drag from a card\'s round output to another card to connect them.' : 'Click a card to see its settings.' }),
      K.kv([['Cards', String(g.nodes.length)], ['Connections', String(g.edges.length)], ['Credits per run', '~' + cost], ['Credits left', usage && usage.scope !== 'platform' ? usage.remaining.toLocaleString() + ' of ' + usage.limit.toLocaleString() : '—']]), el('div', { class: 'section' }), flowProblems);
  }
  function showProblems() {
    const list = problems.errors;
    const body = list.length ? problemList(list, id => { document.querySelector('.modal-backdrop .btn').click(); canvas.select({ type: 'node', id }); canvas.focusNode(id); }) : el('p', { text: 'No problems found. This flow is ready to run.' });
    K.modal({ title: list.length ? 'Problems in this flow' : 'No problems', body, actions: [{ label: 'Close', onClick: ({ close }) => close() }] });
  }
  function showShortcuts() {
    const rows = [['Delete / Backspace', 'Delete the selected card or connection'], ['Ctrl + Z / Ctrl + Y', 'Undo / redo'], ['Ctrl + D', 'Duplicate the selected card'], ['Ctrl + S', 'Save the flow'], ['Arrow keys', 'Nudge the selected card (Shift for bigger steps)'], ['F', 'Fit all cards on screen'], ['+ / -', 'Zoom in / out'], ['Ctrl + mouse wheel', 'Zoom at the pointer'], ['Mouse wheel / drag empty space', 'Move around the canvas'], ['Enter', 'Edit the selected card'], ['Esc', 'Deselect']];
    K.modal({ title: 'Keyboard shortcuts', wide: true, body: K.table({ caption: 'Shortcuts', columns: [{ label: 'Keys', render: x => el('code', { text: x[0] }) }, { label: 'What it does', render: x => el('span', { text: x[1] }) }], rows }), actions: [{ label: 'Close', kind: 'primary', onClick: ({ close }) => close() }] });
  }

  // ---------------------------------------------------------------- drawer + architect (filled in by later phases)
  const drawer = $('drawer'); let tab = 'results'; let collapsed = true;
  const TABS = [['results', 'Results', 'Run the flow to see what each card produced.'], ['logs', 'Live logs', 'Step-by-step progress appears here while a flow runs.'], ['vars', 'Context variables', 'The text passed between cards appears here after a run.']];
  function renderDrawer() {
    const keepOpen = [...drawer.querySelectorAll('details.step')].map((d, i) => (d.open ? i : -1)).filter(i => i >= 0);   // keep expanded steps open while live updates redraw
    const keepScroll = drawer.querySelector('.b-drawer-body') ? drawer.querySelector('.b-drawer-body').scrollTop : 0;
    drawer.classList.toggle('is-collapsed', collapsed);
    const t = TABS.find(x => x[0] === tab);
    drawer.replaceChildren(el('div', { class: 'b-drawer-head', role: 'tablist', 'aria-label': 'Run output' },
      TABS.map(x => el('button', { type: 'button', class: 'tab', role: 'tab', 'aria-selected': String(x[0] === tab), text: x[1], on: { click: () => { tab = x[0]; collapsed = false; renderDrawer(); } } })),
      el('span', { class: 'grow' }), el('button', { type: 'button', class: 'btn btn-ghost icon-btn', 'aria-label': collapsed ? 'Expand the results drawer' : 'Collapse the results drawer', 'aria-expanded': String(!collapsed), on: { click: () => { collapsed = !collapsed; renderDrawer(); } } }, icon('chev', 18))),
      el('div', { class: 'b-drawer-body', id: 'drawer-body', role: 'tabpanel' }, drawerContent(t)));
    const all = drawer.querySelectorAll('details.step'); keepOpen.forEach(i => { if (all[i]) all[i].open = true; });
    const body = drawer.querySelector('.b-drawer-body'); if (body) body.scrollTop = keepScroll;
  }

  // ---------------------------------------------------------------- running a flow (the server executes the saved flow)
  let current = null;   // {id, run, steps, stopping}
  function drawerContent(t) {
    const c = current;
    if (!c || !c.run) return el('div', {}, el('p', { class: 'muted', text: t[2] }), el('a', { href: 'runs.html?flow=' + encodeURIComponent(flow.id), text: 'See the run history of this flow' }));
    if (t[0] === 'logs') return AF.runView.logs(c.run);
    if (t[0] === 'vars') return AF.runView.variables(c.steps);
    return el('div', {}, el('div', { class: 'run-head' }, AF.runView.statusBadge(c.run.status), el('span', { class: 'muted', text: c.run.credits + ' credits · ' + AF.runView.duration(c.run.duration_ms) + ' · started ' + K.formatDateTime(c.run.started_at) })),
      AF.runView.problem(c.run), AF.runView.output(c.run), el('h3', { text: 'Steps' }), AF.runView.steps(c.steps, id => canvas.select({ type: 'node', id })));
  }
  function paintNodes(run, steps) {
    const map = {}; for (const s of steps) map[s.node_id] = s.status;
    if (run.status !== 'running') for (const n of canvas.getGraph().nodes) if (!map[n.id]) map[n.id] = 'skipped';   // cards the run never reached
    canvas.setRunning(map, run.status === 'running');
  }
  async function refreshUsage() { const x = await AF.db.getUsage(); if (x.ok) { usage = x.usage; if (!canvas.sel) renderSettings(null); } }
  async function track(id) {
    current = { id, run: null, steps: [], stopping: false }; collapsed = false; tab = 'results'; paintRunBtn('running'); renderDrawer();
    while (current && current.id === id) {
      const r = await AF.db.getRun(id);
      if (!r.ok) { AF.ui.toast(r.error || 'Could not read the run.', 'error'); break; }
      current.run = r.run; current.steps = r.steps; paintNodes(r.run, r.steps);
      paintRunBtn(r.run.status === 'running' ? (current.stopping ? 'stopping' : 'running') : 'idle'); renderDrawer();
      if (r.run.status !== 'running') {
        if (r.run.status === 'success') AF.ui.toast('Run finished. ' + r.run.credits + ' credits used.');
        else if (r.run.status === 'failed') AF.ui.toast('The run failed: ' + r.run.error, 'error');
        else AF.ui.toast('The run was stopped.');
        break;
      }
      await new Promise(x => setTimeout(x, 400));
    }
    paintRunBtn('idle'); refreshUsage();
  }
  function runRefused(r) {
    if (r.code !== 'credits_exhausted') return AF.ui.toast(r.error || 'Could not start the run.', 'error');
    const go = user.role === 'admin' ? { label: 'Open billing', kind: 'primary', onClick: () => { location.href = '../admin/billing.html'; return false; } } : user.role === 'individual' ? { label: 'Open my account', kind: 'primary', onClick: () => { location.href = 'account.html'; return false; } } : null;
    K.modal({ title: 'No credits left', body: el('p', { text: r.error }), actions: [{ label: 'Close', onClick: ({ close }) => close() }].concat(go ? [go] : []) });
  }
  async function startFlowRun() {
    if (!canRun) return;
    validateNow();
    if (problems.errors.length) { showProblems(); return; }
    if (dirty) { await save(); if (dirty) return; }   // the server runs the saved version
    paintRunBtn('starting');
    const r = await AF.db.startRun(flow.id, {});
    if (!r.ok) { paintRunBtn('idle'); runRefused(r); return; }
    await track(r.run.id);
  }
  async function onRunClick() {
    if (current && current.run && current.run.status === 'running') {
      current.stopping = true; paintRunBtn('stopping');
      const r = await AF.db.stopRun(current.id, {});
      if (!r.ok) { current.stopping = false; paintRunBtn('running'); AF.ui.toast(r.error || 'Could not stop the run.', 'error'); }
      return;
    }
    await startFlowRun();
  }

  // ---------------------------------------------------------------- AI Flow Architect (phase 10)
  const architectForm = $('architect'); const architectInput = $('architect-input'); const architectBtn = architectForm.querySelector('button');
  if (!canEdit) { architectInput.disabled = true; architectBtn.disabled = true; architectForm.title = 'You can look at this flow but not change it.'; }
  function showPlan(plan) {
    settings.replaceChildren(el('h2', { text: 'Built from your description' }),
      el('p', { class: 'muted', text: 'Everything is editable. Click a card to change its settings, or press Ctrl+Z to undo the whole thing.' }),
      el('ol', { class: 'plan-list' }, plan.explanation.map(t => el('li', { text: t }))),
      plan.notes.length ? el('div', { class: 'cw-lock-note', role: 'status' }, plan.notes.map(t => el('div', { text: t }))) : null);
  }
  async function buildFromPrompt(prompt) {
    architectBtn.disabled = true; architectBtn.textContent = 'Building…';
    try {
      const plan = await new AF.adapters.ai.FakeAIProvider().planFlow({ prompt });   // the ONE call a real model replaces later
      if (!plan.ok) { AF.ui.toast(plan.error, 'error'); return; }
      const g = AF.architect.toGraph(plan, Nodes);
      const apply = () => { if (!canvas.replaceAll(g.nodes, g.edges)) { AF.ui.toast('Could not replace the flow right now. A colleague may be editing a card.', 'error'); return; } { showPlan(plan); AF.ui.toast('Built ' + g.nodes.length + ' cards. Check the cards marked with a problem, then press Run.'); architectInput.value = ''; } };
      if (canvas.getGraph().nodes.length > 2) {
        K.modal({ title: 'Replace the current flow?', body: el('p', { text: 'This flow already has cards. The new flow replaces them. You can undo with Ctrl+Z, and earlier saved versions stay in History.' }), actions: [
          { label: 'Keep my flow', onClick: ({ close }) => close() },
          { label: 'Replace with the new flow', kind: 'danger', onClick: ({ close }) => { close(); apply(); } }] });
      } else apply();
    } catch (err) {
      AF.ui.toast(err && err.message ? err.message : 'The AI Flow Architect could not build that. Try again.', 'error');
    } finally { architectBtn.disabled = !canEdit; architectBtn.textContent = 'Build it'; }
  }
  architectForm.addEventListener('submit', e => { e.preventDefault(); if (canEdit) buildFromPrompt(architectInput.value); });

  // ---------------------------------------------------------------- export (phase 10)
  const X = AF.exporter;
  const currentFlow = () => { const g = canvas.getGraph(); return { name: nameInput.value.trim() || flow.name, nodes: g.nodes, edges: g.edges }; };
  function cardLines(f) {
    const kindOf = n => { const d = Nodes.get(n.type) || (n.base && Nodes.get(n.base)); return d ? d.label : 'Unknown card'; };
    const names = new Map(f.nodes.map(n => [n.id, n.label]));
    const wires = f.edges.map(e => (names.get(e.from) || e.from) + ' -> ' + (names.get(e.to) || e.to) + (e.fromPort && e.fromPort !== 'out' ? ' [' + String(e.fromPort).toUpperCase() + ']' : ''));
    return [...f.nodes.map((n, i) => (i + 1) + '. ' + n.label + ' (' + kindOf(n) + '): ' + Nodes.summary(n)), '', 'Connections:', ...wires];
  }
  const scaleFor = (w, h, want) => Math.max(0.25, Math.min(want, 8000 / Math.max(w, h)));
  async function exportAs(kind) {
    const f = currentFlow();
    try {
      if (kind === 'json') K.downloadJson(X.safeFileName(f.name, 'json'), X.toExportObject(f));
      else if (kind === 'png') { const d = X.toSvg(f, { Nodes, CV, title: true }); const r = await X.rasterize(d.svg, d.width, d.height, 'png', scaleFor(d.width, d.height, 2)); X.download(r.blob, X.safeFileName(f.name, 'png')); }
      else {
        const d = X.toSvg(f, { Nodes, CV, title: false }); const r = await X.rasterize(d.svg, d.width, d.height, 'jpeg', scaleFor(d.width, d.height, 1.5));
        const sub = 'Exported ' + new Date().toLocaleString() + ' · ' + f.nodes.length + ' cards · ' + f.edges.length + ' connections · version ' + flow.version;
        X.download(X.buildPdf({ title: f.name, subtitle: sub, jpeg: { bytes: r.bytes, width: r.width, height: r.height }, lines: cardLines(f) }), X.safeFileName(f.name, 'pdf'), 'application/pdf');
      }
      AF.ui.toast('Exported as ' + kind.toUpperCase() + '.');
    } catch (e) { AF.ui.toast((e && e.message) || 'The export did not work. Try again.', 'error'); }
  }
  function openExport() {
    const go = kind => async ({ close }) => { close(); await exportAs(kind); };
    K.modal({ title: 'Export this flow', body: el('p', { text: 'Exports what you see now, including changes you have not saved yet. The JSON file includes every card setting (email addresses, code) and can be imported again from the Flows page.' }), actions: [
      { label: 'JSON file', kind: 'primary', onClick: go('json') }, { label: 'PNG picture', onClick: go('png') }, { label: 'PDF document', onClick: go('pdf') }, { label: 'Close', onClick: ({ close }) => close() }] });
  }

  canvas.load(flow.nodes, flow.edges); dirty = false;   // after every helper above exists, because loading selects nothing and renders the panel
  // ---------------------------------------------------------------- co-work (phase 9)
  const avatarsHost = el('div', { class: 'cw-avatars', role: 'group', 'aria-label': 'Other people on this flow' });
  $('b-right').prepend(avatarsHost);
  function paintAvatars(snap) {
    const list = AF.collab.avatarList(snap, cowork && cowork.clientId);
    const chips = list.slice(0, 4).map(p => {
      const card = p.node_id ? canvas.getGraph().nodes.find(n => n.id === p.node_id) : null;
      const chip = el('span', { class: 'cw-avatar', title: p.label + (card ? ' is on "' + card.label + '"' : p.can_edit ? ' is here' : ' is looking'), 'aria-label': p.label + (card ? ' is on the card ' + card.label : ' is on this flow'), text: p.initials });
      chip.style.background = p.color; return chip;
    });
    if (list.length > 4) chips.push(el('span', { class: 'cw-avatar cw-more', title: list.slice(4).map(p => p.label).join(', '), text: '+' + (list.length - 4) }));
    avatarsHost.replaceChildren(...chips);
  }
  function coworkFocus(sel) {
    if (!cowork) return;
    const id = sel && sel.type === 'node' ? sel.id : null;
    cowork.focusNode(id, canEdit).then(r => { if (!r.ok) AF.ui.toast(r.error, 'error'); });
  }
  async function remoteVersion(evt) {
    if (evt.n <= flow.version) return;
    if (dirty || saving) { newer = evt; paintState(); return; }
    const f = await AF.db.getFlow(flow.id);
    if (!f.ok || f.flow.version <= flow.version || dirty) { if (dirty) { newer = evt; paintState(); } return; }
    applyFlow(f.flow, true);
    AF.ui.toast((evt.by || 'A colleague') + ' saved version ' + f.flow.version + (evt.summary ? ': ' + evt.summary : '') + '. Your canvas is up to date.');
    if (AF.history && AF.history.isOpen()) AF.history.refresh();
  }
  if (AF.db.mode === 'server' && AF.collab) {
    cowork = AF.collab.start({
      flowId: flow.id, db: AF.db._b, version: flow.version,
      onSnapshot: snap => {
        canvas.setPeople(AF.collab.peopleMap(snap, cowork && cowork.clientId)); paintAvatars(snap);
        const sel = canvas.sel;
        if (sel && sel.type === 'node') { const sig = canvas.lockHolders(sel.id).join('|'); if (sig !== lockSig) { lockSig = sig; renderSettings(sel); } } else lockSig = '';
      },
      onVersion: remoteVersion,
      onMode: m => { avatarsHost.dataset.mode = m; avatarsHost.title = m === 'live' ? 'Live updates are on' : m === 'polling' ? 'Updating every few seconds' : 'Live updates are off'; },
    });
    window.addEventListener('pagehide', () => cowork.stop());
  }

  renderLib(); renderSettings(null); renderDrawer(); validateNow(); paintHistory(); paintState();
  if (canRun) AF.db.listRuns({ flow_id: flow.id, status: 'running', limit: 1 }).then(x => { if (x.ok && x.runs[0]) track(x.runs[0].id); });   // pick up a run that is still going after a reload
  function applyFlow(f, keepView) { flow = f; newer = null; if (cowork) cowork.setKnownVersion(f.version); if (keepView) canvas.replaceGraph(f.nodes, f.edges); else canvas.load(f.nodes, f.edges); nameInput.value = f.name; document.title = f.name + ' · AgentFlow'; dirty = false; paintState(); validateNow(); paintHistory(); }
  AF.builder = { clientId: () => (cowork ? cowork.clientId : undefined), applyFlow, isDirty: () => dirty, canvas, getFlow: () => flow, setFlow: f => { flow = f; }, validate: validateNow, save, canEdit, user, markDirty: () => { dirty = true; paintState(); }, markClean: () => { dirty = false; paintState(); }, drawer: { render: renderDrawer, body: () => $('drawer-body'), expand: () => { collapsed = false; renderDrawer(); }, setTab: t => { tab = t; renderDrawer(); } }, runButton: runBtn, usage: () => usage, setUsage: x => { usage = x; renderSettings(canvas.sel); } };
})();
