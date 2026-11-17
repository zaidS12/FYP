/* Company admin: plan, extra seats, simulated card checkout, invoices and payments. */
(async function () {
  'use strict';
  const { el } = AF.ui; const K = AF.kit;
  const ctx = await AF.ui.boot({ roles: ['admin'], title: 'Billing' });
  if (!ctx) return;
  const host = document.getElementById('host');
  const reload = () => K.load(host, render);
  const { checkout, showInvoice } = AF.billingUI;

  function planCard(b, p) {
    const diff = p.price_usd - b.plan.price_usd;
    let action;
    if (p.current) action = el('span', { class: 'badge badge-ok', text: 'Your current plan' });
    else if (diff > 0) action = el('button', { class: 'btn btn-primary', type: 'button', text: `Upgrade to ${p.name} and pay ${K.money(diff)} today`, on: { click: () => checkout({
      title: 'Upgrade to ' + p.name, intro: `You pay the price difference of ${K.money(diff)} now. The ${p.name} plan includes ${p.seats} accounts and ${p.credits_per_month.toLocaleString()} credits a month.`, submitLabel: `Pay ${K.money(diff)} and upgrade`, who: b.tenant.name,
      send: card => AF.db.changePlan({ plan_id: p.id, card }), onDone: reload }) } });
    else action = el('button', { class: 'btn btn-secondary', type: 'button', text: `Switch to ${p.name} (no charge)`, on: { click: async () => {
      const yes = await K.confirmDialog({ title: 'Switch to ' + p.name + '?', message: `You get ${p.seats} accounts and ${p.credits_per_month.toLocaleString()} credits a month. There is no refund for the current period. You must have no more accounts than the new plan allows.`, confirmLabel: 'Switch plan' });
      if (!yes) return;
      const r = await AF.db.changePlan({ plan_id: p.id });
      if (r.ok) { AF.ui.toast('Plan changed to ' + p.name + '.'); reload(); } else AF.ui.toast(r.error, 'error');
    } } });
    return el('div', { class: 'card plan' + (p.current ? ' is-current' : '') }, el('h3', { text: p.name }), el('p', { class: 'plan-price' }, el('b', { text: K.money(p.price_usd) }), ' per month'),
      el('ul', { class: 'plain' }, el('li', { text: p.seats + ' accounts included' }), el('li', { text: p.credits_per_month.toLocaleString() + ' credits per month' }), el('li', { text: 'Extra accounts ' + K.money(p.extra_seat_usd) + ' each per month' })), action);
  }

  function buySeatsCard(b) {
    const price = b.plan.extra_seat_usd;
    return el('div', { class: 'card' }, el('h2', { text: 'Extra seats' }), el('p', { class: 'muted', text: `Each extra account costs ${K.money(price)} per month on the ${b.plan.name} plan. You have ${b.seats.used} of ${b.seats.limit} seats in use.` }),
      el('button', { class: 'btn btn-primary', type: 'button', text: 'Buy extra seats', on: { click: () => checkout({
        title: 'Buy extra seats', intro: `Each seat costs ${K.money(price)} per month.`, submitLabel: 'Pay and add seats', who: b.tenant.name, onDone: reload,
        extraFields: [{ name: 'count', label: 'Number of extra seats', type: 'number', value: 1, min: 1, max: 1000, required: true }],
        send: (card, v) => AF.db.buySeats({ count: Number(v.count), card }) }) } }));
  }

  async function render() {
    const b = K.must(await AF.db.getBilling()).billing;
    const t = b.tenant.name;
    const invoiceActions = i => el('div', { class: 'actions' },
      el('button', { type: 'button', class: 'btn btn-sm btn-secondary', 'aria-label': 'View invoice ' + i.number, text: 'View', on: { click: () => showInvoice(i, t) } }),
      i.status !== 'paid' ? el('button', { type: 'button', class: 'btn btn-sm btn-primary', 'aria-label': 'Pay invoice ' + i.number, text: 'Pay ' + K.money(i.amount_usd), on: { click: () => checkout({ title: 'Pay invoice ' + i.number, intro: `You pay ${K.money(i.amount_usd)} now.`, submitLabel: 'Pay ' + K.money(i.amount_usd), who: t, send: card => AF.db.payInvoice(i.id, { card }), onDone: reload }) } }) : null);
    return [
      el('div', { class: 'stats' },
        el('div', { class: 'stat' }, el('b', { text: b.plan.name }), el('span', { text: 'Current plan' })),
        el('div', { class: 'stat' }, el('b', { text: K.money(b.monthly_usd) }), el('span', { text: 'Monthly cost' })),
        el('div', { class: 'stat' }, el('b', { text: b.seats.used + ' / ' + b.seats.limit }), el('span', { text: 'Seats used' })),
        el('div', { class: 'stat' }, el('b', { text: b.credits.used.toLocaleString() + ' / ' + b.credits.limit.toLocaleString() }), el('span', { text: 'Credits used' })),
        el('div', { class: 'stat' }, el('b', { text: K.formatDate(b.renews_at) }), el('span', { text: 'Renews' }))),
      el('div', { class: 'section' }, el('h2', { text: 'Plans' }), el('div', { class: 'grid-2' }, b.plans.map(p => planCard(b, p)))),
      el('div', { class: 'section' }, buySeatsCard(b)),
      el('div', { class: 'section' }, el('h2', { text: 'Invoices' }), K.table({ caption: 'Invoices', rows: b.invoices, columns: [
        { label: 'Number', render: i => el('code', { text: i.number }) }, { label: 'Issued', render: i => el('span', { text: K.formatDate(i.issued_at) }) }, { label: 'Items', render: i => el('span', { class: 'muted', text: i.items.map(x => x.quantity + ' × ' + x.description).join(', ') }) },
        { label: 'Amount', render: i => el('span', { text: K.money(i.amount_usd) }) }, { label: 'Status', render: i => K.statusBadge(i.status) }, { label: 'Actions', render: invoiceActions }],
        empty: { title: 'No invoices yet', body: 'Invoices appear when you buy seats or change plan.' } })),
      el('div', { class: 'section' }, el('h2', { text: 'Payments' }), K.table({ caption: 'Payments', rows: b.payments, columns: [
        { label: 'Date', render: p => el('span', { text: K.formatDateTime(p.created_at) }) }, { label: 'Amount', render: p => el('span', { text: K.money(p.amount_usd) }) }, { label: 'Method', key: 'method' }, { label: 'Status', render: p => K.statusBadge(p.status) }],
        empty: { title: 'No payments yet', body: 'Payments appear here after a successful checkout.' } })),
    ];
  }
  reload();
})();
