/* Company admin dashboard: seats, credits, activity, warnings, company backup. */
(async function () {
  'use strict';
  const { el, timeAgo } = AF.ui; const K = AF.kit;
  const ctx = await AF.ui.boot({ roles: ['admin'], title: 'Dashboard' });
  if (!ctx) return;
  const host = document.getElementById('host');
  document.getElementById('title').textContent = ctx.tenant.name;

  const stat = (value, label, bad) => el('div', { class: 'stat' + (bad ? ' is-bad' : '') }, el('b', { text: String(value) }), el('span', { text: label }));

  function backupCard(reload) {
    const exportBtn = el('button', { class: 'btn btn-secondary', type: 'button', text: 'Export company data (JSON)', on: { click: async () => {
      const r = await AF.db.exportCompany();
      if (!r.ok) return AF.ui.toast(r.error, 'error');
      K.downloadJson('agentflow-company-' + new Date().toISOString().slice(0, 10) + '.json', r.bundle);
      AF.ui.toast('Company data exported.');
    } } });
    const importBtn = el('button', { class: 'btn btn-secondary', type: 'button', text: 'Import company data (JSON)', on: { click: async () => {
      const f = await K.pickJsonFile();
      if (f.cancelled) return;
      if (!f.ok) return AF.ui.toast(f.error, 'error');
      const yes = await K.confirmDialog({ title: 'Import flows from "' + f.name + '"?', message: 'The flows in the file are added to your company as private copies owned by you. Nothing existing is changed or deleted.', confirmLabel: 'Import flows' });
      if (!yes) return;
      const r = await AF.db.importCompany(f.data);
      if (r.ok) { AF.ui.toast(r.imported + ' flow' + (r.imported === 1 ? '' : 's') + ' imported.'); reload(); } else AF.ui.toast(r.error, 'error');
    } } });
    return el('div', { class: 'card' }, el('h2', { text: 'Company backup' }), el('p', { class: 'muted', text: 'Download all flows, versions and runs of your company, or add flows from a company export. Accounts and passwords are never included.' }), el('div', { class: 'row' }, exportBtn, importBtn));
  }

  async function render() {
    const [s, a, b] = await Promise.all([AF.db.companyStats(), AF.db.listAudit({ limit: 6 }), AF.db.getBilling()]);
    K.must(s); K.must(a); K.must(b);
    const st = s.stats; const bill = b.billing;
    const overdue = bill.invoices.filter(i => i.status === 'overdue');
    const warnings = [];
    if (overdue.length) warnings.push(el('div', { class: 'notice is-danger', role: 'status' }, el('strong', { text: overdue.length + ' overdue invoice' + (overdue.length === 1 ? '' : 's') + '. ' }), 'Pay now to avoid your company being frozen. ', el('a', { href: 'billing.html', text: 'Open billing' })));
    if (st.seats.available === 0) warnings.push(el('div', { class: 'notice is-warn', role: 'status' }, el('strong', { text: 'All ' + st.seats.limit + ' seats are used. ' }), 'You cannot add more accounts until you buy extra seats or upgrade. ', el('a', { href: 'billing.html', text: 'Open billing' })));
    if (st.credits.limit && st.credits.used >= st.credits.limit * 0.9) warnings.push(el('div', { class: 'notice is-warn', role: 'status' }, el('strong', { text: 'Credits almost used. ' }), 'Runs stop when credits run out. Upgrade your plan for more. ', el('a', { href: 'billing.html', text: 'Open billing' })));
    return [
      warnings,
      el('div', { class: 'stats' },
        stat(st.users.total, 'Accounts'), stat(st.seats.used + ' / ' + st.seats.limit, 'Seats used', st.seats.available === 0), stat(st.users.frozen, 'Frozen accounts'),
        stat(st.flows.total, 'Flows'), stat(st.runs.success, 'Successful runs'), stat(st.runs.failed, 'Failed runs', st.runs.failed > 0),
        stat(st.devices.total + ' · ' + st.devices.browsers, 'Devices · browsers')),
      el('div', { class: 'grid-2 section' },
        el('div', { class: 'card' }, el('h2', { text: 'Credits this month' }), el('p', { class: 'muted', text: st.credits.used.toLocaleString() + ' of ' + st.credits.limit.toLocaleString() + ' credits used on the ' + st.plan_name + ' plan.' }), K.progress(st.credits.used, st.credits.limit, 'Credits used'),
          el('h2', { text: 'Seats' }), el('p', { class: 'muted', text: st.seats.used + ' of ' + st.seats.limit + ' accounts created.' }), K.progress(st.seats.used, st.seats.limit, 'Seats used')),
        el('div', { class: 'card' }, el('h2', { text: 'Sign-ins, last 7 days' }), K.dayChart(st.logins_7d.by_day.map(d => ({ label: d.date.slice(5), success: d.success, failed: d.failed })), st.logins_7d.total + ' sign-in attempts, ' + st.logins_7d.failed + ' failed'))),
      el('div', { class: 'section' }, el('div', { class: 'section-head' }, el('h2', { text: 'Recent activity' }), el('a', { href: 'activity.html', text: 'Open all activity' })),
        K.table({ caption: 'Recent company activity', columns: [{ label: 'When', render: e => el('span', { class: 'muted', text: timeAgo(e.at) }) }, { label: 'Who', key: 'actor_name' }, { label: 'Action', render: e => el('code', { text: e.action }) }], rows: a.entries,
          empty: { title: 'No activity yet', body: 'Creating accounts, freezing users and billing changes appear here.' } })),
      backupCard(() => K.load(host, render)),
    ];
  }
  K.load(host, render);
})();
