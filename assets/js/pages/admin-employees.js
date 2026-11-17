/* Company admin: employees, seat usage, account actions. */
(async function () {
  'use strict';
  const { el } = AF.ui; const K = AF.kit;
  const ctx = await AF.ui.boot({ roles: ['admin'], title: 'Employees' });
  if (!ctx) return;
  const host = document.getElementById('host');
  const reload = () => K.load(host, render);

  async function render() {
    const r = K.must(await AF.db.listUsers());
    const seats = r.seats;
    const full = seats.available === 0;
    const add = el('button', { class: 'btn btn-primary', type: 'button', text: 'Add an employee', on: { click: () => AF.accounts.createAccountDialog({ viewer: ctx.user, onDone: reload }) } });
    document.getElementById('head-actions').replaceChildren(el('a', { class: 'btn btn-secondary', href: 'billing.html', text: 'Buy extra seats' }), add);
    return [
      full ? el('div', { class: 'notice is-warn', role: 'status' }, el('strong', { text: 'All ' + seats.limit + ' seats are used. ' }), 'To add another account, buy extra seats ($' + seats.extra_seat_usd + ' each) or upgrade your plan. ', el('a', { href: 'billing.html', text: 'Open billing' })) : null,
      el('div', { class: 'card section' }, el('div', { class: 'row between' }, el('strong', { text: seats.used + ' of ' + seats.limit + ' seats used' }), el('span', { class: 'muted', text: seats.available + ' available' })), K.progress(seats.used, seats.limit, 'Seats used')),
      AF.accounts.usersTable(r.users, ctx.user, reload, { empty: { title: 'No accounts yet', body: 'Add your first employee. They get a temporary password to sign in with.' } }),
    ];
  }
  reload();
})();
