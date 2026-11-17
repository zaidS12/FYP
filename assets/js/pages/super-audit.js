/* Super admin: global audit log with an action filter. Also used (company-scoped by the server) by the admin Activity page. */
(async function () {
  'use strict';
  const { el } = AF.ui; const K = AF.kit;
  const ctx = await AF.ui.boot({ roles: ['superadmin'], title: 'Audit log' });
  if (!ctx) return;
  const host = document.getElementById('host');
  const metaText = m => Object.entries(m || {}).map(([k, v]) => k + ': ' + (typeof v === 'object' ? JSON.stringify(v) : v)).join(', ');
  let action = '';

  async function render() {
    const r = K.must(await AF.db.listAudit({ action, limit: 300 }));
    const filter = el('select', { class: 'input', 'aria-label': 'Filter by action' }, [el('option', { value: '', text: 'All actions' })].concat(r.actions.map(a => el('option', { value: a, text: a }))));
    filter.value = action;
    filter.addEventListener('change', () => { action = filter.value; K.load(host, render); });
    return [el('div', { class: 'row section' }, filter, el('span', { class: 'muted', text: r.entries.length + ' entries, newest first' })),
      K.table({ caption: 'Audit log', rows: r.entries, columns: [
        { label: 'When', render: e => el('span', { class: 'muted', text: K.formatDateTime(e.at) }) }, { label: 'Who', key: 'actor_name' },
        { label: 'Action', render: e => el('code', { text: e.action }) }, { label: 'Company', render: e => e.tenant_name || '—' },
        { label: 'Target', render: e => el('code', { text: e.target }) }, { label: 'Details', render: e => el('span', { class: 'muted', text: metaText(e.meta) }) }],
      empty: { title: 'No entries match', body: 'Pick a different action, or choose "All actions".' } })];
  }
  K.load(host, render);
})();
