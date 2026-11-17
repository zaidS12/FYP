'use strict';
/* PaymentGateway adapter (server side). The real gateway later implements the same `charge` method.
 * FakeGateway behaves like a real checkout but touches no bank:
 *   any valid card succeeds, 4000 0000 0000 0002 is declined, 4000 0000 0000 9995 has insufficient funds.
 * Card numbers and CVCs are never stored by AgentFlow; only brand and last 4 digits are kept. */
const crypto = require('node:crypto');
const Pay = require('../../assets/js/adapters/payment.js');

class PaymentGateway {
  /** @param {{amount_usd:number, card:object, description?:string}} req  @returns {{ok:boolean, id?:string, last4?:string, brand?:string, code?:string, message?:string}} */
  // eslint-disable-next-line no-unused-vars
  charge(req) { throw new Error('PaymentGateway.charge is not implemented'); }
}

class FakeGateway extends PaymentGateway {
  charge({ amount_usd: amount, card }) {
    if (typeof amount !== 'number' || !isFinite(amount) || amount <= 0) return { ok: false, code: 'invalid_amount', message: 'The amount to charge must be greater than zero.' };
    // Services pass an already-validated card (exp_month/exp_year); raw form fields are validated here.
    const v = card && card.exp_month ? { ok: true, card } : Pay.validateCard(card);
    if (!v.ok) return { ok: false, code: 'invalid_card', message: 'The card details are not valid.', errors: v.errors };
    const c = v.card;
    if (c.number === '4000000000000002') return { ok: false, code: 'card_declined', message: 'Your card was declined. Try another card or contact your bank.' };
    if (c.number === '4000000000009995') return { ok: false, code: 'insufficient_funds', message: 'Your card has insufficient funds. Try another card.' };
    return { ok: true, id: 'ch_' + crypto.randomBytes(8).toString('hex'), last4: c.last4, brand: c.brand };
  }
}

module.exports = { PaymentGateway, FakeGateway };
