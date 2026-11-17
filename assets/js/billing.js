/* AgentFlow credits: what each card costs, flow estimates and usage status.
 * UMD: used by the server (charging runs, blocking when credits are gone), the engine and the UI. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else { root.AF = root.AF || {}; root.AF.credits = factory(); }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /** Credits consumed each time a card runs. Custom cards cost the same as the card they were made from. */
  const COST = { start: 0, end: 0, write_email: 2, create_report: 4, summarize: 3, translate: 2, search_web: 2, condition: 0, loop: 1, timer: 0, research_bot: 6, python_code: 1 };
  const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

  function costOf(type, options) {
    if (has(COST, type)) return COST[type];
    const base = options && options.base;
    if (typeof base === 'string' && has(COST, base)) return COST[base];
    return 1;
  }

  const estimateFlow = nodes => (Array.isArray(nodes) ? nodes : []).reduce((sum, n) => sum + costOf(n.type, { base: n.base }), 0);

  function creditStatus(usage) {
    const used = Number(usage && usage.credits_used) || 0;
    const limit = Number(usage && usage.credits_limit) || 0;
    const percent = limit > 0 ? Math.round((used / limit) * 100) : 0;
    const exhausted = limit > 0 ? used >= limit : true;
    return { used, limit, remaining: Math.max(0, limit - used), percent, exhausted, low: !exhausted && percent >= 90 };
  }

  const canAfford = (usage, amount) => (Number(usage.credits_used) || 0) + amount <= (Number(usage.credits_limit) || 0);

  return { COST, costOf, estimateFlow, creditStatus, canAfford };
});
