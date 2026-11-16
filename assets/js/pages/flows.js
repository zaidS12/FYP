/* Flows list page controller (Phase 1 shows real, tenant-scoped data; create/open arrive in phases 5-6). */
(async function () {
  'use strict';
  const { el, timeAgo } = AF.ui;
  const ctx = await AF.ui.boot({ roles: ['superadmin', 'admin', 'employee', 'individual'], title: 'Flows' });
  if (!ctx) return;
  const { user } = ctx;
  const host = document.getElementById('flows-host');
  const sub = document.getElementById('flows-sub');
  sub.textContent = user.role === 'superadmin' ? 'Every flow across all companies.'
    : user.role === 'individual' ? 'Your personal flows.'
    : 'Flows your company can see and edit together.';

  async function load() {
    host.replaceChildren(el('p', { class: 'muted', role: 'status', text: 'Loading flows…' }));
    const r = await AF.db.listFlows();
    if (!r.ok) {
      host.replaceChildren(el('div', { class: 'alert', role: 'alert' }, el('strong', { text: 'Could not load flows. ' }), r.error || 'Try again.', ' ',
        el('button', { class: 'btn btn-secondary', type: 'button', on: { click: load } }, 'Try again')));
      return;
    }
    const flows = r.flows;
    if (!flows.length) {
      host.replaceChildren(el('div', { class: 'empty' }, el('h2', { text: 'No flows yet' }),
        el('p', { text: 'A flow is a chain of cards that does a job for you, like searching the web and emailing a summary. Start from a template or build one from scratch.' }),
        el('span', { class: 'btn btn-primary', 'aria-disabled': 'true', title: 'Creating flows is built in phase 5.' }, 'Create your first flow')));
      return;
    }
    const showCompany = user.role === 'superadmin';
    const head = ['Flow', showCompany ? 'Company' : null, 'Owner', 'Steps', 'Version', 'Sharing', 'Updated'].filter(Boolean);
    const rows = flows.map(f => el('tr', {},
      el('td', {}, el('strong', { text: f.name })),
      showCompany ? el('td', { text: f.tenant_name || 'Individual' }) : null,
      el('td', { text: f.owner_name }),
      el('td', { text: String(f.node_count) }),
      el('td', {}, el('span', { class: 'mono', text: 'v' + f.version })),
      el('td', {}, el('span', { class: 'badge' + (f.shared ? ' badge-ok' : ''), text: f.shared ? 'Shared with company' : 'Private' })),
      el('td', { class: 'muted', text: timeAgo(f.updated_at) })));
    host.replaceChildren(
      el('div', { class: 'stats' },
        el('div', { class: 'stat' }, el('b', { text: String(flows.length) }), el('span', { text: 'Flows' })),
        el('div', { class: 'stat' }, el('b', { text: String(flows.filter(f => f.shared).length) }), el('span', { text: 'Shared' }))),
      el('div', { class: 'table-wrap' }, el('table', {}, el('caption', { class: 'sr-only', text: 'Flows you can access' }),
        el('thead', {}, el('tr', {}, head.map(h => el('th', { scope: 'col', text: h })))), el('tbody', {}, rows))));
  }
  load();
})();
