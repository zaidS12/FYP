/* AIProvider adapter. The engine only talks to this interface; swap FakeAIProvider for a real model API later.
 * FakeAIProvider is deterministic (same input, same output) and calls no network.
 * Demo trigger: any input containing "[ai-error]" makes the call fail, so you can see a failed run.
 * UMD: browser (AF.adapters.ai), server and tests. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('../architect.js'));
  else { root.AF = root.AF || {}; root.AF.adapters = root.AF.adapters || {}; root.AF.adapters.ai = factory(root.AF.architect); }
})(typeof self !== 'undefined' ? self : this, function (Architect) {
  'use strict';

  class ProviderError extends Error {
    constructor(message, code) { super(message); this.name = 'ProviderError'; this.code = code || 'provider_error'; }
  }

  /** Interface. Every method resolves to {text, tokens:{in, out}} (writeEmail also returns subject). */
  class AIProvider {
    // eslint-disable-next-line no-unused-vars
    async summarize(req) { throw new Error('not implemented'); }
    // eslint-disable-next-line no-unused-vars
    async translate(req) { throw new Error('not implemented'); }
    // eslint-disable-next-line no-unused-vars
    async writeEmail(req) { throw new Error('not implemented'); }
    // eslint-disable-next-line no-unused-vars
    async createReport(req) { throw new Error('not implemented'); }
    // eslint-disable-next-line no-unused-vars
    async research(req) { throw new Error('not implemented'); }
    // eslint-disable-next-line no-unused-vars
    async planFlow(req) { throw new Error('not implemented'); }   // {prompt} -> {ok, name, steps, links, notes, explanation}
  }

  const words = s => String(s || '').trim().split(/\s+/).filter(Boolean);
  const tokensOf = s => Math.max(1, Math.round(words(s).length * 1.3));
  const sentences = s => String(s || '').split(/(?<=[.!?])\s+|\n+/).map(x => x.trim()).filter(Boolean);
  const clipWords = (s, n) => { const w = words(s); return w.length > n ? w.slice(0, n).join(' ') + '…' : w.join(' '); };
  const cap = s => (s ? s[0].toUpperCase() + s.slice(1) : s);
  const LATENCY = { summarize: 420, translate: 360, writeEmail: 520, createReport: 640, research: 900 };

  class FakeAIProvider extends AIProvider {
    _guard(text) { if (String(text || '').includes('[ai-error]')) throw new ProviderError('The AI service is not responding (simulated). Wait a moment and run the flow again.', 'ai_unavailable'); }
    _done(text, input, task, extra) { return Object.assign({ text, tokens: { in: tokensOf(input), out: tokensOf(text) }, latency_ms: LATENCY[task] }, extra || {}); }

    async summarize({ text, style, max_words }) {
      this._guard(text);
      const s = sentences(text); const limit = Number(max_words) || 120;
      if (!s.length) return this._done('(There was nothing to summarize.)', text, 'summarize');
      let out;
      if (style === 'headline') out = clipWords(s[0].replace(/[.!?]+$/, ''), Math.min(limit, 14));
      else if (style === 'paragraph') out = clipWords(s.slice(0, 3).join(' '), limit);
      else {
        const kept = []; let used = 0;
        for (const line of s.slice(0, 5)) { const n = words(line).length; if (used + n > limit && kept.length) break; kept.push('• ' + line); used += n; }
        out = kept.join('\n');
      }
      return this._done(out, text, 'summarize');
    }

    async translate({ text, language }) {
      this._guard(text);
      return this._done(`[${language} translation, simulated]\n${String(text || '').trim()}`, text, 'translate');
    }

    async writeEmail({ text, tone, subject }) {
      this._guard(text);
      const opening = { friendly: 'Hi there,', formal: 'Dear colleague,', concise: 'Hello,' }[tone] || 'Hello,';
      const closing = { friendly: 'Best wishes,', formal: 'Kind regards,', concise: 'Thanks,' }[tone] || 'Regards,';
      const body = `${opening}\n\n${clipWords(text, 220) || '(No content was passed to this card.)'}\n\n${closing}\nAgentFlow`;
      return this._done(body, text, 'writeEmail', { subject: subject || 'Your AgentFlow update' });
    }

    async createReport({ text, title, format, sections }) {
      this._guard(text);
      const names = String(sections || 'Summary, Findings').split(',').map(x => x.trim()).filter(Boolean).slice(0, 8);
      const s = sentences(text); const per = Math.max(1, Math.ceil(s.length / Math.max(1, names.length)));
      const md = format !== 'plain';
      const parts = names.map((n, i) => { const body = s.slice(i * per, (i + 1) * per).join(' ') || '(No content for this section.)'; return md ? `## ${cap(n)}\n${body}` : `${cap(n).toUpperCase()}\n${body}`; });
      const head = md ? `# ${title || 'Report'}` : String(title || 'Report').toUpperCase();
      return this._done([head, ...parts].join('\n\n'), text, 'createReport');
    }

    /** AI Flow Architect. Rule based here; a real model returns the same shape later. */
    async planFlow({ prompt }) {
      this._guard(prompt);
      return Architect.plan(prompt);
    }

    async research({ topic, depth, sources }) {
      this._guard(topic);
      const list = Array.isArray(sources) ? sources : [];
      const take = { quick: 2, standard: 4, deep: 6 }[depth] || 4;
      const lines = list.slice(0, take).map((r, i) => `${i + 1}. ${r.title}: ${r.snippet}`);
      const text = `Research notes on "${topic}" (${depth || 'standard'}, simulated)\n${lines.join('\n') || '(No sources were found.)'}\n\nSources checked: ${Math.min(list.length, take)}.`;
      return this._done(text, topic, 'research');
    }
  }

  return { ProviderError, AIProvider, FakeAIProvider };
});
