/* Super admin dashboard: platform numbers, attention list, recent audit, database backup. */
(async function () {
  'use strict';
  const { el, timeAgo } = AF.ui; const K = AF.kit;
  const ctx = await AF.ui.boot({ roles: ['superadmin'], title: 'Dashboard' });
  if (!ctx) return;
  const host = document.getElementById('host');

  const stat = (value, label, bad) => el('div', { class: 'stat' + (bad ? ' is-bad' : '') }, el('b', { text: String(value) }), el('span', { text: label }));

  function backupCard(reload) {
    const exportBtn = el('button', { class: 'btn btn-secondary', type: 'button', text: 'Export database (JSON)', on: { click: async () => {
      const r = await AF.db.exportDb();
      if (!r.ok) return AF.ui.toast(r.error, 'error');
      K.downloadJson('agentflow-database-' + new Date().toISOString().slice(0, 10) + '.json', r.bundle);
      AF.ui.toast('Database exported. The file contains password hashes, so store it somewhere safe.');
    } } });
    const importBtn = el('button', { class: 'btn btn-secondary', type: 'button', text: 'Import database (JSON)', on: { click: async () => {
      const f = await K.pickJsonFile();
      if (f.cancelled) return;
      if (!f.ok) return AF.ui.toast(f.error, 'error');
      const yes = await K.confirmDialog({ title: 'Replace the whole database?', message: 'Every company, account, flow and run will be replaced by the contents of "' + f.name + '". The file must contain your own super admin account. A backup of the current data is saved automatically in data/backups first.', confirmLabel: 'Replace database', danger: true, typeToConfirm: 'REPLACE' });
      if (!yes) return;
      const r = await AF.db.importDb(f.data);
      if (r.ok) { AF.ui.toast('Database imported.'); reload(); } else AF.ui.toast(r.error, 'error');
    } } });
    return el('div', { class: 'card' }, el('h2', { text: 'Database backup' }), el('p', { class: 'muted', text: 'Export a full copy of all companies and accounts, or restore one. Importing replaces everything and makes a restore point first.' }), el('div', { class: 'row' }, exportBtn, importBtn));
  }

  async function render() {
    const [s, a, t] = await Promise.all([AF.db.platformStats(), AF.db.listAudit({ limit: 6 }), AF.db.listTenants()]);
    K.must(s); K.must(a); K.must(t);
    const st = s.stats;
    const attention = t.tenants.filter(x => x.status === 'frozen' || x.seats.available === 0 || x.credits.used >= x.credits.limit * 0.9);
    return [
      el('div', { class: 'stats' },
        stat(st.tenants.active, 'Active companies'), stat(st.tenants.frozen, 'Frozen companies', st.tenants.frozen > 0),
        stat(st.users.total, 'Accounts'), stat(st.flows.total, 'Flows'),
        stat(st.runs.success, 'Successful runs'), stat(st.runs.failed, 'Failed runs', st.runs.failed > 0),
        stat(K.money(st.revenue.monthly_usd), 'Monthly revenue'), stat(st.credits.used.toLocaleString() + ' / ' + st.credits.limit.toLocaleString(), 'Credits used'),
        stat(st.devices.total + ' · ' + st.devices.browsers, 'Devices · browsers')),
      el('div', { class: 'grid-2 section' },
        el('div', { class: 'card' }, el('h2', { text: 'Sign-ins, last 7 days' }),
          K.dayChart(st.logins_7d.by_day.map(d => ({ label: d.date.slice(5), success: d.success, failed: d.failed })), st.logins_7d.total + ' sign-in attempts, ' + st.logins_7d.failed + ' failed')),
        el('div', { class: 'card' }, el('h2', { text: 'Needs attention' }),
          attention.length ? el('ul', { class: 'plain' }, attention.map(x => el('li', {}, el('a', { href: 'tenant-detail.html?id=' + encodeURIComponent(x.id), text: x.name }), ' ',
            x.status === 'frozen' ? K.badge('Frozen', 'danger') : null, x.seats.available === 0 ? K.badge('No seats left', 'warn') : null, x.credits.used >= x.credits.limit * 0.9 ? K.badge('Credits almost used', 'warn') : null)))
            : el('p', { class: 'muted', text: 'Nothing needs attention. All companies are active with seats and credits to spare.' }))),
      el('div', { class: 'section' }, el('div', { class: 'section-head' }, el('h2', { text: 'Recent activity' }), el('a', { href: 'audit.html', text: 'Open the full audit log' })),
        K.table({ caption: 'Recent audit entries', columns: [
          { label: 'When', render: e => el('span', { class: 'muted', text: timeAgo(e.at) }) }, { label: 'Who', key: 'actor_name' },
          { label: 'Action', render: e => el('code', { text: e.action }) }, { label: 'Company', render: e => e.tenant_name || '—' }], rows: a.entries,
        empty: { title: 'No activity yet', body: 'Actions such as creating accounts or freezing a company appear here.' } })),
      backupCard(() => K.load(host, render)),
    ];
  }
  K.load(host, render);
})();
