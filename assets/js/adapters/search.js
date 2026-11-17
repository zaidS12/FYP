/* SearchProvider adapter. Swap FakeSearchProvider for a real web search API later.
 * FakeSearchProvider returns deterministic, clearly simulated results and calls no network.
 * Demo trigger: a query containing "[fail]" times out, so you can see a failed run. UMD: browser (AF.adapters.search), server, tests. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./ai.js'));
  else { root.AF = root.AF || {}; root.AF.adapters = root.AF.adapters || {}; root.AF.adapters.search = factory(root.AF.adapters.ai); }
})(typeof self !== 'undefined' ? self : this, function (AI) {
  'use strict';
  const { ProviderError } = AI;

  /** Interface. search({query, max_results}) resolves to {results:[{title, url, snippet}]}. */
  class SearchProvider {
    // eslint-disable-next-line no-unused-vars
    async search(req) { throw new Error('not implemented'); }
  }

  const TEMPLATES = [
    ['{q}: what changed this week', 'A short roundup of the latest developments around {q}, with the key numbers and who is involved.'],
    ['Five things to know about {q}', 'Analysts highlight five practical points about {q} that teams are talking about right now.'],
    ['How teams are using {q} today', 'Case studies show where {q} saves time, and where it still needs a human in the loop.'],
    ['{q} explained for beginners', 'A plain-language introduction to {q}, starting from the basics and avoiding jargon.'],
    ['The cost of {q}: a 2026 overview', 'Pricing, hidden costs and savings reported for {q} across small and large organisations.'],
    ['Experts disagree on {q}', 'Two camps give different forecasts for {q}; this piece compares their evidence side by side.'],
    ['{q} tools compared', 'A neutral comparison of popular options related to {q}, including strengths and trade-offs.'],
    ['Risks and safeguards for {q}', 'What can go wrong with {q} and the checks organisations put in place.'],
    ['{q} in the news: timeline', 'A dated timeline of major announcements involving {q}.'],
    ['Questions people ask about {q}', 'The most common questions about {q}, answered briefly with links to deeper reading.'],
  ];
  const slug = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'results';

  class FakeSearchProvider extends SearchProvider {
    async search({ query, max_results }) {
      const q = String(query || '').trim();
      if (q.includes('[fail]')) throw new ProviderError('The search service timed out after 10 seconds. Check your connection and run again.', 'search_timeout');
      if (!q) throw new ProviderError('There was nothing to search for. Fill in the search query.', 'empty_query');
      const n = Math.min(10, Math.max(1, Number(max_results) || 5));
      const results = TEMPLATES.slice(0, n).map(([t, s], i) => ({ title: t.replace(/\{q\}/g, q), url: `https://news.example.test/${slug(q)}/${i + 1}`, snippet: s.replace(/\{q\}/g, q) }));
      return { results, latency_ms: 480 };
    }
  }

  return { SearchProvider, FakeSearchProvider };
});
