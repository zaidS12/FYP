/* MailProvider adapter. Swap FakeMailProvider for a real email service later.
 * FakeMailProvider "sends" nothing: it records the message in memory and returns a message id, so no real email ever leaves AgentFlow.
 * Demo trigger: an address at bounce.test is rejected, so you can see a failed run. UMD: browser (AF.adapters.mail), server, tests. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./ai.js'));
  else { root.AF = root.AF || {}; root.AF.adapters = root.AF.adapters || {}; root.AF.adapters.mail = factory(root.AF.adapters.ai); }
})(typeof self !== 'undefined' ? self : this, function (AI) {
  'use strict';
  const { ProviderError } = AI;
  const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

  /** Interface. send({to, subject, body}) resolves to {id, status}. */
  class MailProvider {
    // eslint-disable-next-line no-unused-vars
    async send(message) { throw new Error('not implemented'); }
  }

  class FakeMailProvider extends MailProvider {
    constructor() { super(); this.sent = []; this._n = 0; }
    async send({ to, subject, body }) {
      if (typeof to !== 'string' || !EMAIL.test(to)) throw new ProviderError(`"${to}" is not a valid email address. Fix the "Send to" setting.`, 'bad_address');
      if (/@bounce\.test$/i.test(to)) throw new ProviderError('The mail server at bounce.test rejected the message (simulated). Check the address and try again.', 'mail_rejected');
      this._n += 1;
      const id = 'msg_' + String(this._n).padStart(4, '0') + Math.abs([...to].reduce((h, c) => (h * 31 + c.charCodeAt(0)) | 0, 7)).toString(36);
      this.sent.push({ id, to, subject, body });
      if (this.sent.length > 50) this.sent.shift();
      return { id, status: 'sent (simulated)', latency_ms: 350 };
    }
  }

  return { MailProvider, FakeMailProvider };
});
