/* My account: profile, credits and plan, password, appearance, devices and sign-ins. */
(async function () {
  'use strict';
  const { el, timeAgo } = AF.ui; const K = AF.kit;
  const ctx = await AF.ui.boot({ roles: ['superadmin', 'admin', 'employee', 'individual'], title: 'Account' });
  if (!ctx) return;
  const host = document.getElementById('host');
  const reload = () => K.load(host, render);

  function editName(u) {
    K.formModal({ title: 'Change your name', fields: [{ name: 'name', label: 'Full name', value: u.name, required: true, maxlength: 80 }], submitLabel: 'Save name',
      onSubmit: async v => { const r = await AF.db.updateProfile({ name: v.name }); if (r.ok) { AF.ui.toast('Name updated.'); setTimeout(() => location.reload(), 400); } return r; } });
  }
  function changePassword() {
    K.formModal({ title: 'Change password', intro: 'You stay signed in here. Every other device is signed out.', submitLabel: 'Change password',
      fields: [{ name: 'current', label: 'Current password', type: 'password', autocomplete: 'current-password', required: true },
        { name: 'next', label: 'New password', type: 'password', autocomplete: 'new-password', required: true, hint: 'At least 8 characters with a letter and a number.' },
        { name: 'again', label: 'Repeat the new password', type: 'password', autocomplete: 'new-password', required: true }],
      onSubmit: async v => {
        if (v.next !== v.again) return { ok: false, errors: { again: 'The two new passwords do not match.' } };
        const r = await AF.db.changePassword({ current: v.current, next: v.next });
        if (r.ok) AF.ui.toast('Password changed. Other devices were signed out.');
        return r;
      } });
  }
  async function setTheme(theme) {
    AF.ui.applyTheme(theme);
    const r = await AF.db.setPrefs({ theme });
    if (!r.ok) AF.ui.toast('Theme changed here, but could not be saved to your account. ' + (r.error || ''), 'error');
    reload();
  }

  function planCards(acc) {
    const who = acc.user.name;
    return el('div', { class: 'grid-2' }, acc.plans.map(p => {
      const cur = acc.plan; const diff = p.price_usd - cur.price_usd;
      let action;
      if (p.current) action = el('span', { class: 'badge badge-ok', text: 'Your current plan' });
      else if (diff > 0) action = el('button', { class: 'btn btn-primary', type: 'button', text: `Upgrade to ${p.name} and pay ${K.money(diff)} today`, on: { click: () => AF.billingUI.checkout({
        title: 'Upgrade to ' + p.name, intro: `You get ${p.credits_per_month.toLocaleString()} credits a month for ${K.money(p.price_usd)}.`, submitLabel: `Pay ${K.money(diff)} and upgrade`, who, send: card => AF.db.changePersonalPlan({ plan_id: p.id, card }), onDone: reload }) } });
      else action = el('button', { class: 'btn btn-secondary', type: 'button', text: `Switch to ${p.name}`, on: { click: async () => {
        const yes = await K.confirmDialog({ title: 'Switch to ' + p.name + '?', message: `Your credit limit drops to ${p.credits_per_month.toLocaleString()} a month. There is no refund for the current period.`, confirmLabel: 'Switch plan' });
        if (!yes) return;
        const r = await AF.db.changePersonalPlan({ plan_id: p.id });
        if (r.ok) { AF.ui.toast('Switched to ' + p.name + '.'); reload(); } else AF.ui.toast(r.error, 'error');
      } } });
      return el('div', { class: 'card plan' + (p.current ? ' is-current' : '') }, el('h3', { text: p.name }), el('p', { class: 'plan-price' }, el('b', { text: K.money(p.price_usd) }), ' per month'), el('ul', { class: 'plain' }, el('li', { text: p.credits_per_month.toLocaleString() + ' credits per month' }), el('li', { text: 'Personal flows' })), action);
    }));
  }

  async function render() {
    const [a, act] = await Promise.all([AF.db.getAccount(), AF.db.myActivity()]);
    K.must(a); K.must(act);
    const acc = a.account; const u = acc.usage; const dark = document.documentElement.getAttribute('data-theme') === 'dark';
    const themeBtn = (theme, label) => el('button', { type: 'button', class: 'btn btn-secondary', 'aria-pressed': String((theme === 'dark') === dark), text: label, on: { click: () => setTheme(theme) } });
    return [
      el('div', { class: 'grid-2 section' },
        el('div', { class: 'card' }, el('div', { class: 'section-head' }, el('h2', { text: 'Profile' }), el('button', { class: 'btn btn-sm btn-secondary', type: 'button', text: 'Change name', on: { click: () => editName(acc.user) } })),
          K.kv([['Name', acc.user.name], ['Email', acc.user.email], ['Role', K.badge(acc.role_label)], ['Company', acc.company || 'None (personal account)'], ['Member since', K.formatDate(acc.user.created_at)]])),
        el('div', { class: 'card' }, el('h2', { text: 'Credits' }),
          u.scope === 'platform' ? el('p', { class: 'muted', text: 'Super admin accounts do not use credits.' }) : [
            el('p', { class: 'muted', text: u.used.toLocaleString() + ' of ' + u.limit.toLocaleString() + ' credits used this month on the ' + u.plan_name + ' plan' + (u.scope === 'company' ? '. Credits are shared by everyone in your company.' : '.') }),
            K.progress(u.used, u.limit, 'Credits used'),
            u.exhausted ? el('p', { class: 'field-error', text: 'Credits are used up, so runs are blocked until they renew' + (acc.user.role === 'individual' ? ' or you upgrade below.' : ' or your admin upgrades the plan.') }) : null,
            acc.user.role === 'admin' ? el('p', {}, el('a', { href: '../admin/billing.html', text: 'Manage plan and seats in Billing' })) : null])),
      acc.plans.length ? el('div', { class: 'section' }, el('h2', { text: 'Your plan' }), planCards(acc)) : null,
      acc.invoices.length ? el('div', { class: 'section' }, el('h2', { text: 'Invoices' }), K.table({ caption: 'Your invoices', rows: acc.invoices, columns: [
        { label: 'Number', render: i => el('code', { text: i.number }) }, { label: 'Issued', render: i => el('span', { text: K.formatDate(i.issued_at) }) }, { label: 'Amount', render: i => el('span', { text: K.money(i.amount_usd) }) }, { label: 'Status', render: i => K.statusBadge(i.status) },
        { label: 'Actions', render: i => el('button', { type: 'button', class: 'btn btn-sm btn-secondary', 'aria-label': 'View invoice ' + i.number, text: 'View', on: { click: () => AF.billingUI.showInvoice(i, acc.user.name) } }) }] })) : null,
      el('div', { class: 'grid-2 section' },
        el('div', { class: 'card' }, el('h2', { text: 'Security' }), el('p', { class: 'muted', text: 'Choose a password only you know. Changing it signs out your other devices.' }), el('button', { class: 'btn btn-secondary', type: 'button', text: 'Change password', on: { click: changePassword } })),
        el('div', { class: 'card' }, el('h2', { text: 'Appearance' }), el('p', { class: 'muted', text: 'Your choice is saved to your account and follows you to other devices.' }), el('div', { class: 'row' }, themeBtn('light', 'Light mode'), themeBtn('dark', 'Dark mode')))),
      el('div', { class: 'section' }, el('h2', { text: 'Your devices and browsers' }), K.table({ caption: 'Your devices', rows: act.devices, columns: [
        { label: 'Browser', key: 'browser' }, { label: 'System', render: d => el('span', { text: d.os + ' · ' + d.device }) }, { label: 'Sign-ins', key: 'login_count' }, { label: 'Last seen', render: d => el('span', { class: 'muted', text: timeAgo(d.last_seen) }) }],
        empty: { title: 'No devices yet', body: 'Devices appear after you sign in.' } })),
      el('div', { class: 'section' }, el('h2', { text: 'Recent sign-ins' }), K.table({ caption: 'Your sign-ins', rows: act.events, columns: [
        { label: 'When', render: e => el('span', { class: 'muted', text: K.formatDateTime(e.at) }) }, { label: 'Browser', render: e => el('span', { text: e.browser + ' · ' + e.os }) },
        { label: 'Result', render: e => (e.success ? K.badge('Signed in', 'ok') : K.badge(e.reason === 'bad_password' ? 'Wrong password' : 'Blocked', 'danger')) }], empty: { title: 'No sign-ins yet', body: 'Your sign-ins appear here.' } })),
    ];
  }
  reload();
})();
