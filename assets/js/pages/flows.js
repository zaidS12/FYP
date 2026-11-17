/* Flows list: create, open, rename, duplicate, share inside the company, delete, import JSON, credit strip. */
(async function () {
  'use strict';
  const { el, timeAgo } = AF.ui; const K = AF.kit;
  const ctx = await AF.ui.boot({ roles: ['superadmin', 'admin', 'employee', 'individual'], title: 'Flows' });
  if (!ctx) return;
  const { user } = ctx;
  const host = document.getElementById('host');
  const canCreate = user.role !== 'superadmin';
  document.getElementById('sub').textContent = user.role === 'superadmin' ? 'Every flow across all companies (read only).'
    : user.role === 'individual' ? 'Your personal flows.' : 'Flows your company can see and edit together.';
  let query = ''; let scope = 'all';
  const reload = () => K.load(host, render);
  const open = id => { location.href = 'builder.html?id=' + encodeURIComponent(id); };

  function newFlow() {
    K.formModal({
      title: 'New flow', intro: 'You start with a Start and an End card connected together. Add cards between them in the builder.', submitLabel: 'Create flow and open builder',
      fields: [{ name: 'name', label: 'Flow name', required: true, maxlength: 120, hint: 'For example: Daily AI news email' }],
      onSubmit: async v => { const r = await AF.db.createFlow({ name: v.name }); if (r.ok) open(r.flow.id); return r; },
    });
  }
  async function importFlow() {
    const f = await K.pickJsonFile();
    if (f.cancelled) return;
    if (!f.ok) return AF.ui.toast(f.error, 'error');
    const p = AF.exporter.parseImport(f.data, f.name);
    if (!p.ok) return AF.ui.toast(p.error, 'error');
    const r = await AF.db.createFlow({ name: p.name, nodes: p.nodes, edges: p.edges });
    if (r.ok) { AF.ui.toast('Imported "' + r.flow.name + '".'); open(r.flow.id); } else AF.ui.toast(r.error, 'error');
  }
  function rename(f) {
    K.formModal({ title: 'Rename flow', fields: [{ name: 'name', label: 'Flow name', value: f.name, required: true, maxlength: 120 }], submitLabel: 'Save name',
      onSubmit: async v => { const r = await AF.db.saveFlow(f.id, { name: v.name, base_version: f.version }); if (r.ok) { AF.ui.toast('Renamed.'); reload(); } else if (r.code === 'conflict') { AF.ui.toast('Someone changed this flow a moment ago. The list was refreshed, try again.', 'error'); reload(); } return r; } });
  }
  async function duplicate(f) { const r = await AF.db.duplicateFlow(f.id); if (r.ok) { AF.ui.toast('Created "' + r.flow.name + '" for you.'); reload(); } else AF.ui.toast(r.error, 'error'); }
  async function toggleShare(f) {
    const r = await AF.db.saveFlow(f.id, { shared: !f.shared });
    if (r.ok) { AF.ui.toast(f.shared ? '"' + f.name + '" is now private to its owner.' : '"' + f.name + '" is now shared with your company.'); reload(); } else AF.ui.toast(r.error, 'error');
  }
  async function remove(f) {
    const yes = await K.confirmDialog({ title: 'Delete "' + f.name + '"?', message: 'The flow, all its saved versions and its run history are deleted for everyone. This cannot be undone. Export it first if you might need it.', confirmLabel: 'Delete flow', danger: true });
    if (!yes) return;
    const r = await AF.db.deleteFlow(f.id);
    if (r.ok) { AF.ui.toast('Deleted "' + f.name + '".'); reload(); } else AF.ui.toast(r.error, 'error');
  }

  const head = document.getElementById('head-actions');
  if (canCreate) head.append(el('button', { class: 'btn btn-secondary', type: 'button', text: 'Import flow (JSON)', on: { click: importFlow } }), el('button', { class: 'btn btn-primary', type: 'button', text: 'New flow', on: { click: newFlow } }));

  function usageStrip(u) {
    if (u.scope === 'platform') return null;
    const note = u.exhausted ? el('div', { class: 'notice is-danger', role: 'status' }, el('strong', { text: 'Credits used up. ' }), 'Runs are blocked until credits renew' + (user.role === 'individual' ? ' or you upgrade on your account page.' : ' or your admin upgrades the plan.'))
      : u.low ? el('div', { class: 'notice is-warn', role: 'status' }, el('strong', { text: 'Credits almost used. ' }), u.remaining + ' credits left this month.') : null;
    return el('div', {}, note, el('div', { class: 'card section' }, el('div', { class: 'row between' }, el('strong', { text: u.used.toLocaleString() + ' of ' + u.limit.toLocaleString() + ' credits used' }), el('span', { class: 'muted', text: u.plan_name + ' plan · ' + (u.scope === 'company' ? 'shared with your company' : 'personal') })), K.progress(u.used, u.limit, 'Credits used')));
  }

  async function render() {
    const [r, u] = await Promise.all([AF.db.listFlows(), AF.db.getUsage()]);
    K.must(r); K.must(u);
    const flows = r.flows.filter(f => (scope === 'all' || (scope === 'mine' && f.owner_id === user.id) || (scope === 'shared' && f.shared)) && (!query || f.name.toLowerCase().includes(query.toLowerCase())));
    const search = el('input', { class: 'input', type: 'search', placeholder: 'Search flows', 'aria-label': 'Search flows', value: query });
    search.addEventListener('input', () => { query = search.value; K.load(host, render).then(() => { const s = host.querySelector('input[type="search"]'); if (s) { s.focus(); s.setSelectionRange(s.value.length, s.value.length); } }); });
    const sel = el('select', { class: 'input', 'aria-label': 'Show' }, [['all', 'All flows'], ['mine', 'Created by me'], ['shared', 'Shared with company']].map(([v, l]) => el('option', { value: v, text: l })));
    sel.value = scope; sel.addEventListener('change', () => { scope = sel.value; reload(); });
    const showCompany = user.role === 'superadmin';
    const actions = f => el('div', { class: 'actions' },
      el('a', { class: 'btn btn-sm btn-primary', href: 'builder.html?id=' + encodeURIComponent(f.id), 'aria-label': (f.can_edit ? 'Open ' : 'View ') + f.name, text: f.can_edit ? 'Open' : 'View' }),
      f.can_edit ? el('button', { type: 'button', class: 'btn btn-sm btn-secondary', 'aria-label': 'Rename ' + f.name, text: 'Rename', on: { click: () => rename(f) } }) : null,
      canCreate ? el('button', { type: 'button', class: 'btn btn-sm btn-secondary', 'aria-label': 'Duplicate ' + f.name, text: 'Duplicate', on: { click: () => duplicate(f) } }) : null,
      f.can_manage && user.role !== 'individual' ? el('button', { type: 'button', class: 'btn btn-sm btn-secondary', 'aria-label': (f.shared ? 'Make private ' : 'Share with company ') + f.name, text: f.shared ? 'Make private' : 'Share with company', on: { click: () => toggleShare(f) } }) : null,
      f.can_manage ? el('button', { type: 'button', class: 'btn btn-sm btn-danger', 'aria-label': 'Delete ' + f.name, text: 'Delete', on: { click: () => remove(f) } }) : null);
    const cols = [
      { label: 'Flow', render: f => el('div', {}, el('a', { class: 'cell-strong', href: 'builder.html?id=' + encodeURIComponent(f.id), text: f.name }), el('div', { class: 'muted', text: 'v' + f.version + ' · ' + f.node_count + ' cards' })) },
      showCompany ? { label: 'Company', render: f => el('span', { text: f.tenant_name || 'Individual' }) } : null,
      { label: 'Owner', key: 'owner_name' },
      { label: 'Sharing', render: f => K.badge(f.shared ? 'Shared with company' : 'Private', f.shared ? 'ok' : '') },
      { label: 'Updated', render: f => el('span', { class: 'muted', text: timeAgo(f.updated_at) }) },
      { label: 'Actions', render: actions },
    ].filter(Boolean);
    const empty = r.flows.length ? { title: 'No flows match', body: 'Clear the search or choose "All flows".' }
      : { title: 'No flows yet', body: canCreate ? 'A flow is a chain of cards that does a job for you, like searching the web and emailing a summary. Start from a template or build one from scratch.' : 'There are no flows yet.', action: canCreate ? el('div', { class: 'row' }, el('button', { class: 'btn btn-primary', type: 'button', text: 'New flow', on: { click: newFlow } }), el('a', { class: 'btn btn-secondary', href: 'templates.html', text: 'Browse templates' })) : null };
    return [usageStrip(u.usage), el('div', { class: 'row section' }, search, sel, el('span', { class: 'muted', text: flows.length + ' of ' + r.flows.length + ' flows' })), K.table({ caption: 'Flows you can access', columns: cols, rows: flows, empty })];
  }
  reload();
})();
