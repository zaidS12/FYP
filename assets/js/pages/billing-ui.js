/* Shared checkout and invoice dialogs (company Billing page and individual Account page). */
(function (root) {
  'use strict';
  const AF = root.AF; const { el } = AF.ui; const K = AF.kit;
  const CARD_HINT = 'Demo checkout, no real money moves. Use 4242 4242 4242 4242 with any future date and any 3 digits. 4000 0000 0000 0002 is declined; 4000 0000 0000 9995 has no funds.';

  function showInvoice(inv, who) {
    const rows = inv.items.map(i => el('tr', {}, el('td', { text: i.description }), el('td', { text: String(i.quantity) }), el('td', { text: K.money(i.unit_usd) }), el('td', { text: K.money(i.quantity * i.unit_usd) })));
    const body = el('div', { class: 'invoice' },
      K.kv([['Invoice', el('code', { text: inv.number })], ['Billed to', who], ['Issued', K.formatDate(inv.issued_at)], ['Status', K.statusBadge(inv.status)], ['Paid', inv.paid_at ? K.formatDate(inv.paid_at) : 'Not paid yet']]),
      el('div', { class: 'table-wrap' }, el('table', {}, el('thead', {}, el('tr', {}, ['Item', 'Qty', 'Unit price', 'Amount'].map(h => el('th', { scope: 'col', text: h })))), el('tbody', {}, rows))),
      el('p', { class: 'cell-strong', text: 'Total: ' + K.money(inv.amount_usd) }));
    K.modal({ title: 'Invoice ' + inv.number, body, wide: true, actions: [{ label: 'Close', onClick: ({ close }) => close() }, { label: 'Print or save as PDF', kind: 'primary', onClick: () => { window.print(); return false; } }] });
  }

  /** Card checkout dialog. send(card, values) -> API result {ok, invoice?, error?, errors?}. */
  function checkout({ title, intro, extraFields, submitLabel, send, who, onDone }) {
    K.formModal({
      title, intro: intro + ' ' + CARD_HINT, submitLabel, wide: true,
      fields: (extraFields || []).concat([
        { name: 'name', label: 'Name on card', autocomplete: 'cc-name', required: true },
        { name: 'number', label: 'Card number', autocomplete: 'cc-number', required: true, hint: 'Card numbers are checked and charged, then discarded. AgentFlow keeps only the brand and last 4 digits.' },
        { name: 'exp', label: 'Expiry (MM/YY)', autocomplete: 'cc-exp', required: true },
        { name: 'cvc', label: 'Security code', autocomplete: 'cc-csc', required: true, maxlength: 4 },
      ]),
      onSubmit: async v => {
        const card = { name: v.name, number: v.number, exp: v.exp, cvc: v.cvc };
        const local = AF.payment.validateCard(card);
        if (!local.ok) return { ok: false, errors: local.errors };
        const r = await send(card, v);
        if (r.ok) { AF.ui.toast('Payment received. Thank you.'); if (r.invoice) setTimeout(() => showInvoice(r.invoice, who), 0); if (onDone) onDone(r); }
        return r;
      },
    });
  }

  AF.billingUI = { CARD_HINT, showInvoice, checkout };
})(self);
