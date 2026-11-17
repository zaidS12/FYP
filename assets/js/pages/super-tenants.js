/* Super admin: list of companies and "New company". */
(async function () {
  'use strict';
  const { el } = AF.ui; const K = AF.kit;
  const ctx = await AF.ui.boot({ roles: ['superadmin'], title: 'Companies' });
  if (!ctx) return;
  const host = document.getElementById('host');

  function newCompany() {
    K.formModal({
      title: 'New company', intro: 'Creates the company and its first admin. The admin signs in with a temporary password that you hand over.',
      fields: [
        { name: 'name', label: 'Company name', required: true, maxlength: 80 },
        { name: 'plan_id', label: 'Plan', type: 'select', value: 'basic', options: [{ value: 'basic', label: 'Basic · $100/month · 10 accounts' }, { value: 'pro', label: 'Pro · $250/month · 30 accounts' }] },
        { name: 'admin_name', label: 'First admin: full name', required: true, maxlength: 80 },
        { name: 'admin_email', label: 'First admin: email', type: 'email', required: true },
      ], submitLabel: 'Create company',
      onSubmit: async v => {
        const r = await AF.db.createTenant(v);
        if (r.ok) { AF.ui.toast(r.tenant.name + ' was created.'); setTimeout(() => K.secretDialog({ title: 'First admin password', intro: 'Give this temporary password to ' + v.admin_name + '. It is shown only once.', label: 'Temporary password', value: r.temp_password }), 0); K.load(host, render); }
        return r;
      },
    });
  }
  document.getElementById('head-actions').append(el('button', { class: 'btn btn-primary', type: 'button', text: 'New company', on: { click: newCompany } }));

  async function render() {
    const r = K.must(await AF.db.listTenants());
    return K.table({
      caption: 'Companies', rows: r.tenants,
      columns: [
        { label: 'Company', render: t => el('div', {}, el('a', { class: 'cell-strong', href: 'tenant-detail.html?id=' + encodeURIComponent(t.id), text: t.name }), el('div', { class: 'muted', text: t.frozen_reason ? 'Frozen: ' + t.frozen_reason : 'Since ' + K.formatDate(t.created_at) })) },
        { label: 'Plan', render: t => el('span', { text: t.plan_name + (t.extra_seats ? ' + ' + t.extra_seats + ' seats' : '') }) },
        { label: 'Seats', render: t => el('div', {}, el('span', { text: t.seats.used + ' of ' + t.seats.limit }), K.progress(t.seats.used, t.seats.limit, 'Seats used by ' + t.name)) },
        { label: 'Credits', render: t => el('div', {}, el('span', { text: t.credits.used.toLocaleString() + ' of ' + t.credits.limit.toLocaleString() }), K.progress(t.credits.used, t.credits.limit, 'Credits used by ' + t.name)) },
        { label: 'Monthly', render: t => el('span', { text: K.money(t.monthly_usd) }) },
        { label: 'Status', render: t => K.statusBadge(t.status) },
      ],
      empty: { title: 'No companies yet', body: 'Create the first company to give a team its own workspace.', action: el('button', { class: 'btn btn-primary', type: 'button', text: 'New company', on: { click: newCompany } }) },
    });
  }
  K.load(host, render);
})();
