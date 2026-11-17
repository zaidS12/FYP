/* Builder history panel: every saved version with author, time and change summary, plus one-click restore.
 * Restoring makes a NEW version on top; older versions are never changed. Opened by the History button in builder.js. */
(function () {
  'use strict';
  const { el, icon } = AF.ui; const K = AF.kit;
  let panel = null; let listHost = null;

  const b = () => AF.builder;

  async function refresh() {
    if (!panel || !b()) return;
    const flow = b().getFlow();
    listHost.replaceChildren(el('p', { class: 'muted', text: 'Loading history…' }));
    const r = await AF.db.listVersions(flow.id);
    if (!listHost) return;
    if (!r.ok) { listHost.replaceChildren(el('p', { class: 'field-error', role: 'alert', text: r.error || 'Could not load the history.' })); return; }
    listHost.replaceChildren(el('ol', { class: 'hist-list', 'aria-label': 'Saved versions, newest first' }, r.versions.map(v => row(v, r.current, r.can_edit))));
  }

  function row(v, current, canEdit) {
    const isCurrent = v.n === current;
    const head = el('div', { class: 'hist-head' }, el('b', { text: 'Version ' + v.n }), isCurrent ? K.badge('Current') : null, v.restored_from ? el('span', { class: 'badge', text: 'Restore of v' + v.restored_from }) : null);
    const meta = el('div', { class: 'muted hist-meta', text: AF.versions.authorLabel(v) + ' · ' + AF.ui.timeAgo(v.at) });
    const btn = !isCurrent && canEdit
      ? el('button', { type: 'button', class: 'btn btn-secondary btn-sm', 'aria-label': 'Restore version ' + v.n, text: 'Restore this version', on: { click: () => restore(v) } }) : null;
    return el('li', { class: 'hist-item' + (isCurrent ? ' is-current' : '') }, head, meta, el('p', { class: 'hist-sum', text: v.summary || 'No description' }), btn);
  }

  async function doRestore(v) {
    const flow = b().getFlow();
    const r = await AF.db.restoreVersion(flow.id, v.n, { base_version: flow.version, client_id: b().clientId() });
    if (r.ok) { b().applyFlow(r.flow); AF.ui.toast('Restored version ' + v.n + ' as the new version ' + r.version.n + '. Nothing was deleted from the history.'); refresh(); return; }
    if (r.status === 409) { AF.ui.toast(r.error, 'error'); const f = await AF.db.getFlow(flow.id); if (f.ok) b().applyFlow(f.flow); refresh(); return; }
    AF.ui.toast(r.error || 'Could not restore this version.', 'error');
  }

  function restore(v) {
    if (!b().isDirty()) { doRestore(v); return; }
    K.modal({ title: 'Replace your unsaved changes?', body: el('p', { text: 'You have changes that are not saved yet. Restoring version ' + v.n + ' replaces them. You can also close this and save first.' }), actions: [
      { label: 'Cancel', onClick: ({ close }) => close() },
      { label: 'Restore and drop my unsaved changes', kind: 'danger', onClick: async ({ close }) => { close(); await doRestore(v); } }] });
  }

  function close() {
    if (panel) { panel.remove(); panel = null; listHost = null; }
    const t = document.getElementById('hist-toggle');
    if (t) { t.setAttribute('aria-expanded', 'false'); t.focus(); }
  }

  function open() {
    if (panel) { close(); return; }
    const t = document.getElementById('hist-toggle'); if (t) t.setAttribute('aria-expanded', 'true');
    listHost = el('div', { class: 'hist-body' });
    panel = el('aside', { class: 'hist-panel', id: 'hist-panel', 'aria-label': 'Version history' },
      el('div', { class: 'hist-top' }, el('h2', { text: 'History' }), el('button', { type: 'button', class: 'btn btn-ghost icon-btn', 'aria-label': 'Close history', on: { click: close } }, icon('minus', 16))),
      el('p', { class: 'muted hist-note', text: 'Every save is a version. Restoring one adds a new version on top, so nothing is ever lost.' }), listHost);
    panel.addEventListener('keydown', e => { if (e.key === 'Escape') { e.stopPropagation(); close(); } });
    document.getElementById('builder').appendChild(panel);
    refresh();
    panel.querySelector('button').focus();
  }

  AF.history = { open, close, refresh, isOpen: () => !!panel };
})();
