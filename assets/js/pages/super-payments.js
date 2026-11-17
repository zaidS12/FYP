/* Super admin: every payment and invoice across companies, with filters. */
(async function () {
  'use strict';
  const { el } = AF.ui; const K = AF.kit;
  const ctx = await AF.ui.boot({ roles: ['superadmin'], title: 'Payments' });
  if (!ctx) return;
  const host = document.getElementById('host');
  const select = (label, opts, onChange) => {
    const s = el('select', { class: 'input', 'aria-label': label }, opts.map(o => el('option', { value: o.value, text: o.label })));
    s.addEventListener('change', () => onChange(s.value)); return s;
  };

  async function render() {
    const [p, i] = await Promise.all([AF.db.listPayments(), AF.db.listInvoices()]);
    K.must(p); K.must(i);
    let tenant = ''; let status = '';
    const tenants = [...new Map(i.invoices.map(x => [x.tenant_id, x.tenant_name])).entries()];
    const body = el('div', {});
    function draw() {
      const inv = i.invoices.filter(x => (!tenant || x.tenant_id === tenant) && (!status || x.status === status));
      const pay = p.payments.filter(x => !tenant || x.tenant_id === tenant);
      const paid = pay.filter(x => x.status === 'succeeded').reduce((a, x) => a + x.amount_usd, 0);
      const overdue = inv.filter(x => x.status === 'overdue').reduce((a, x) => a + x.amount_usd, 0);
      body.replaceChildren(
        el('div', { class: 'stats' }, el('div', { class: 'stat' }, el('b', { text: K.money(paid) }), el('span', { text: 'Received' })), el('div', { class: 'stat' + (overdue ? ' is-bad' : '') }, el('b', { text: K.money(overdue) }), el('span', { text: 'Overdue' })), el('div', { class: 'stat' }, el('b', { text: inv.length }), el('span', { text: 'Invoices shown' }))),
        el('div', { class: 'section' }, el('h2', { text: 'Invoices' }), K.table({ caption: 'Invoices', rows: inv, columns: [
          { label: 'Number', render: x => el('code', { text: x.number }) }, { label: 'Company', render: x => el('a', { href: 'tenant-detail.html?id=' + encodeURIComponent(x.tenant_id), text: x.tenant_name || x.tenant_id }) },
          { label: 'Issued', render: x => el('span', { text: K.formatDate(x.issued_at) }) }, { label: 'Items', render: x => el('span', { class: 'muted', text: x.items.map(it => it.description).join(', ') }) },
          { label: 'Amount', render: x => el('span', { text: K.money(x.amount_usd) }) }, { label: 'Status', render: x => K.statusBadge(x.status) }], empty: { title: 'No invoices match', body: 'Change the filters above to see more.' } })),
        el('div', { class: 'section' }, el('h2', { text: 'Payments' }), K.table({ caption: 'Payments', rows: pay, columns: [
          { label: 'Date', render: x => el('span', { text: K.formatDateTime(x.created_at) }) }, { label: 'Company', render: x => el('span', { text: x.tenant_name || x.tenant_id }) },
          { label: 'Invoice', render: x => el('code', { text: x.invoice_number || '—' }) }, { label: 'Method', key: 'method' }, { label: 'Amount', render: x => el('span', { text: K.money(x.amount_usd) }) }, { label: 'Status', render: x => K.statusBadge(x.status) }], empty: { title: 'No payments', body: 'Payments appear after an invoice is paid.' } })));
    }
    draw();
    return [el('div', { class: 'row section' },
      select('Filter by company', [{ value: '', label: 'All companies' }].concat(tenants.map(([v, l]) => ({ value: v, label: l }))), v => { tenant = v; draw(); }),
      select('Filter invoices by status', [{ value: '', label: 'Any invoice status' }, { value: 'paid', label: 'Paid' }, { value: 'overdue', label: 'Overdue' }], v => { status = v; draw(); })), body];
  }
  K.load(host, render);
})();
