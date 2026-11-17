/* PaymentGateway adapter, client side + shared card validation (UMD: browser as AF.payment, Node for the server and tests).
 * The browser only validates the form for instant feedback; the server validates again and talks to the gateway.
 * Replace server/adapters/payment.js (FakeGateway) with a real gateway later; this validation can stay. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else { root.AF = root.AF || {}; root.AF.payment = factory(); }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function luhn(digits) {
    let sum = 0, dbl = false;
    for (let i = digits.length - 1; i >= 0; i--) {
      let n = digits.charCodeAt(i) - 48;
      if (n < 0 || n > 9) return false;
      if (dbl) { n *= 2; if (n > 9) n -= 9; }
      sum += n; dbl = !dbl;
    }
    return digits.length > 0 && sum % 10 === 0;
  }

  function brandOf(digits) {
    if (/^4/.test(digits)) return 'Visa';
    if (/^(5[1-5]|2(2[2-9]|[3-6]\d|7[01]|720))/.test(digits)) return 'Mastercard';
    if (/^3[47]/.test(digits)) return 'American Express';
    return 'Card';
  }

  /** Returns {ok:true, card} with normalised fields, or {ok:false, errors:{number, exp, cvc, name}}. */
  function validateCard(input, now) {
    const src = input && typeof input === 'object' ? input : {};
    const when = now instanceof Date ? now : new Date();
    const errors = {};
    const digits = typeof src.number === 'string' ? src.number.replace(/[\s-]/g, '') : '';
    const brand = brandOf(digits);
    const lengthOk = brand === 'American Express' ? digits.length === 15 : brand === 'Mastercard' ? digits.length === 16 : /^\d{13,19}$/.test(digits);
    if (!lengthOk || !luhn(digits)) errors.number = 'Enter the card number exactly as printed on the card.';
    const m = typeof src.exp === 'string' ? src.exp.trim().match(/^(0[1-9]|1[0-2])\s*\/\s*(\d{2}|\d{4})$/) : null;
    let expMonth = 0, expYear = 0;
    if (!m) errors.exp = 'Enter the expiry date as MM/YY, for example 08/28.';
    else {
      expMonth = Number(m[1]); expYear = m[2].length === 2 ? 2000 + Number(m[2]) : Number(m[2]);
      if (expYear < when.getFullYear() || (expYear === when.getFullYear() && expMonth < when.getMonth() + 1)) errors.exp = 'This card has expired. Use a card that is still valid.';
    }
    const cvcLen = brand === 'American Express' ? 4 : 3;
    if (typeof src.cvc !== 'string' || !new RegExp('^\\d{' + cvcLen + '}$').test(src.cvc.trim())) errors.cvc = 'Enter the ' + cvcLen + '-digit security code from the back of the card.';
    const name = typeof src.name === 'string' ? src.name.trim() : '';
    if (!name || name.length > 80) errors.name = 'Enter the name on the card.';
    if (Object.keys(errors).length) return { ok: false, errors };
    return { ok: true, card: { number: digits, exp_month: expMonth, exp_year: expYear, cvc: String(src.cvc).trim(), name, brand, last4: digits.slice(-4) } };
  }

  return { luhn, brandOf, validateCard };
});
