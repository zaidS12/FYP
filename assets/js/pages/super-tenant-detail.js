/* Super admin: one company in depth (accounts, plan, devices, sign-ins, invoices, payments). */
(async function () {
  'use strict';
  const { el, timeAgo } = AF.ui; const K = AF.kit;
  const ctx = await AF.ui.boot({ roles: ['superadmin'], title: 'Company' });
  if (!ctx) return;
  const host = document.getElementById('host');
  const id = new URLSearchParams(location.search).get('id') || '';
  const title = document.getElementById('title'); const sub = document.getElementById('sub'); const headActions = document.getElementById('head-actions');
  let current = null;
  const reload = () => K.load(host, render);

  function changePlan(t) {
    K.formModal({
      title: 'Change plan or seats for ' + t.name, intro: 'The new plan applies immediately. You cannot go below the number of accounts the company already has.',
      fields: [
        { name: 'plan_id', label: 'Plan', type: 'select', value: t.plan_id, options: [{ value: 'basic', label: 'Basic · $100/month · 10 accounts' }, { value: 'pro', label: 'Pro · $250/month · 30 accounts' }] },
        { name: 'extra_seats', label: 'Extra seats', type: 'number', value: t.extra_seats, min: 0, max: 1000, hint: 'Each extra seat is billed on top of the plan.' },
      ], submitLabel: 'Save plan',
      onSubmit: async v => { const r = await AF.db.updateTenant(t.id, { plan_id: v.plan_id, extra_seats: Number(v.extra_seats) }); if (r.ok) { AF.ui.toast('Plan updated.'); reload(); } return r; },
    });
  }
  function rename(t) {
    K.formModal({ title: 'Rename company', fields: [{ name: 'name', label: 'Company name', value: t.name, required: true, maxlength: 80 }], submitLabel: 'Save name',
      onSubmit: async v => { const r = await AF.db.updateTenant(t.id, { name: v.name }); if (r.ok) { AF.ui.toast('Renamed.'); reload(); } return r; } });
  }
  function freeze(t) {
    K.formModal({ title: 'Freeze ' + t.name, intro: 'Everyone in the company is signed out at once and nobody can sign in until you unfreeze it. Data is kept.', danger: true, submitLabel: 'Freeze company',
      fields: [{ name: 'reason', label: 'Reason (shown to the company, saved in the audit log)', maxlength: 200 }],
      onSubmit: async v => { const r = await AF.db.freezeTenant(t.id, { reason: v.reason }); if (r.ok) { AF.ui.toast(t.name + ' is frozen.'); reload(); } return r; } });
  }
  async function unfreeze(t) { const r = await AF.db.unfreezeTenant(t.id); if (r.ok) { AF.ui.toast(t.name + ' is active again.'); reload(); } else AF.ui.toast(r.error, 'error'); }
  async function remove(t) {
    const yes = await K.confirmDialog({ title: 'Delete ' + t.name + '?', message: 'This permanently deletes the company, all its accounts, flows, runs, invoices and payments. Export the database first if you might need them. This cannot be undone.', confirmLabel: 'Delete company', danger: true, typeToConfirm: t.name });
    if (!yes) return;
    const r = await AF.db.deleteTenant(t.id);
    if (r.ok) { AF.ui.toast(t.name + ' was deleted.'); location.href = 'tenants.html'; } else AF.ui.toast(r.error, 'error');
  }

  async function render() {
    if (!id) throw new Error('No company was chosen. Open one from the Companies list.');
    const d = K.must(await AF.db.getTenant(id));
    const t = d.tenant; current = t;
    title.textContent = t.name; sub.textContent = t.plan_name + ' plan · created ' + K.formatDate(t.created_at);
    document.title = t.name + ' · AgentFlow';
    headActions.replaceChildren(
      el('button', { class: 'btn btn-secondary', type: 'button', text: 'Rename', on: { click: () => rename(t) } }),
      el('button', { class: 'btn btn-secondary', type: 'button', text: 'Change plan or seats', on: { click: () => changePlan(t) } }),
      t.status === 'frozen' ? el('button', { class: 'btn btn-primary', type: 'button', text: 'Unfreeze company', on: { click: () => unfreeze(t) } }) : el('button', { class: 'btn btn-secondary', type: 'button', text: 'Freeze company', on: { click: () => freeze(t) } }),
      el('button', { class: 'btn btn-danger', type: 'button', text: 'Delete company', on: { click: () => remove(t) } }));
    return [
      t.status === 'frozen' ? el('div', { class: 'notice is-danger', role: 'status' }, el('strong', { text: 'This company is frozen. ' }), t.frozen_reason || '') : null,
      el('div', { class: 'stats' },
        el('div', { class: 'stat' }, el('b', { text: t.seats.used + ' / ' + t.seats.limit }), el('span', { text: 'Seats used' })),
        el('div', { class: 'stat' }, el('b', { text: d.counts.flows }), el('span', { text: 'Flows' })),
        el('div', { class: 'stat' }, el('b', { text: d.counts.runs }), el('span', { text: 'Runs' })),
        el('div', { class: 'stat' }, el('b', { text: t.credits.used.toLocaleString() + ' / ' + t.credits.limit.toLocaleString() }), el('span', { text: 'Credits used' })),
        el('div', { class: 'stat' }, el('b', { text: K.money(t.monthly_usd) }), el('span', { text: 'Monthly revenue' }))),
      el('div', { class: 'section' }, el('div', { class: 'section-head' }, el('h2', { text: 'Accounts' }),
        el('button', { class: 'btn btn-primary', type: 'button', text: 'Add an account', on: { click: () => AF.accounts.createAccountDialog({ tenantId: t.id, viewer: ctx.user, onDone: reload }) } })),
        AF.accounts.usersTable(d.users, ctx.user, reload, { empty: { title: 'No accounts', body: 'Add the first admin for this company.' } })),
      el('div', { class: 'section' }, el('h2', { text: 'Devices and browsers' }),
        K.table({ caption: 'Devices', rows: d.devices, columns: [{ label: 'Account', render: x => el('span', { text: x.user_name }) }, { label: 'Browser', key: 'browser' }, { label: 'System', render: x => el('span', { text: x.os + ' · ' + x.device }) }, { label: 'Sign-ins', key: 'login_count' }, { label: 'Last seen', render: x => el('span', { class: 'muted', text: timeAgo(x.last_seen) }) }],
          empty: { title: 'No devices yet', body: 'A device appears here after someone signs in.' } })),
      el('div', { class: 'section' }, el('h2', { text: 'Recent sign-ins' }),
        K.table({ caption: 'Sign-in events', rows: d.login_events, columns: [{ label: 'When', render: e => el('span', { class: 'muted', text: K.formatDateTime(e.at) }) }, { label: 'Account', key: 'user_name' }, { label: 'Browser', render: e => el('span', { text: e.browser + ' · ' + e.os }) }, { label: 'Result', render: e => (e.success ? K.badge('Signed in', 'ok') : K.badge(e.reason === 'bad_password' ? 'Wrong password' : 'Blocked: ' + (e.reason || 'unknown'), 'danger')) }],
          empty: { title: 'No sign-ins yet', body: 'Sign-in attempts appear here.' } })),
      el('div', { class: 'grid-2 section' },
        el('div', {}, el('h2', { text: 'Invoices' }), K.table({ caption: 'Invoices', rows: d.invoices, columns: [{ label: 'Number', render: i => el('code', { text: i.number }) }, { label: 'Issued', render: i => el('span', { text: K.formatDate(i.issued_at) }) }, { label: 'Amount', render: i => el('span', { text: K.money(i.amount_usd) }) }, { label: 'Status', render: i => K.statusBadge(i.status) }], empty: { title: 'No invoices', body: 'Invoices are created when the company is billed.' } })),
        el('div', {}, el('h2', { text: 'Payments' }), K.table({ caption: 'Payments', rows: d.payments, columns: [{ label: 'Date', render: p => el('span', { text: K.formatDate(p.created_at) }) }, { label: 'Amount', render: p => el('span', { text: K.money(p.amount_usd) }) }, { label: 'Method', key: 'method' }, { label: 'Status', render: p => K.statusBadge(p.status) }], empty: { title: 'No payments', body: 'Payments appear after an invoice is paid.' } }))),
    ];
  }
  void current;
  reload();
})();
