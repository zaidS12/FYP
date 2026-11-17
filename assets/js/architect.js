/* AI Flow Architect (SIMULATED): turns a sentence like "Find daily AI news and email me a summary" into a flow.
 * Rule based and deterministic. It sits behind AIProvider.planFlow(), so a real model replaces plan() later and
 * everything else (toGraph, the builder's prompt bar) stays as it is. UMD: browser (AF.architect), server and tests. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else { root.AF = root.AF || {}; root.AF.architect = factory(); }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const MAX_PROMPT = 2000;
  const EXAMPLES = 'Try something like: "Find daily AI news and email me a summary", "Research competitor pricing and create a report", or "Search the web for outages, and if it contains \\"down\\" email ops@company.com".';
  const LANGS = 'urdu|arabic|hindi|spanish|french|german|chinese|english|turkish|italian|portuguese|russian|japanese|korean|bengali';
  const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/;
  const clip = (s, n) => { const t = String(s); return t.length > n ? t.slice(0, n - 1).trimEnd() + '…' : t; };
  const cap = s => (s ? s[0].toUpperCase() + s.slice(1) : s);
  const tidy = s => String(s || '').replace(/^[\s"'\u201C\u201D]+/, '').replace(/^(?:the|some|any)\s+/i, '').replace(/[\s"'\u201C\u201D.,;:]+$/g, '').trim();

  function schedule(text) {
    const m = /\b(?:every|each)\s+(hour|day|morning|evening|night|week|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b|\b(hourly|daily|weekly)\b/i.exec(text);
    if (!m) return null;
    const w = (m[1] || m[2]).toLowerCase();
    const kind = /^hour/.test(w) ? 'every_hour' : (/^week/.test(w) || /^(?:mon|tues|wednes|thurs|fri|satur|sun)day$/.test(w)) ? 'every_week' : 'every_day';
    let time = '08:00';
    const t = /\bat\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/i.exec(text);
    if (t) {
      let h = Number(t[1]); const min = t[2] || '00'; const ap = (t[3] || '').toLowerCase();
      if (ap === 'pm' && h < 12) h += 12; if (ap === 'am' && h === 12) h = 0;
      if (h <= 23) time = String(h).padStart(2, '0') + ':' + min;
    }
    return { schedule: kind, time };
  }

  /** What to search for: the words after "find / search for / look up", or after "news about". */
  function searchQuery(text) {
    const verb = /\b(?:find|search(?:\s+the\s+web)?(?:\s+for)?|look(?:\s+up|\s+for)|gather|fetch|get)\s+(.+?)(?=\s+(?:and|then)\b|[,.;]|$)/i.exec(text);
    if (verb && tidy(verb[1])) return tidy(verb[1]);
    const news = /\bnews\s+(?:about|on|regarding)\s+(.+?)(?=\s+(?:and|then)\b|[,.;]|$)/i.exec(text);
    if (news && tidy(news[1])) return 'latest news about ' + tidy(news[1]);
    return clip(tidy(text), 60);
  }
  function researchTopic(text) {
    const m = /\bresearch(?:es|ing)?\s+(?:about\s+|on\s+)?(.+?)(?=\s+(?:and|then)\b|[,.;]|$)/i.exec(text);
    return m && tidy(m[1]) ? tidy(m[1]) : clip(tidy(text), 60);
  }

  function conditionExpr(text) {
    const m = /\bif\b[^.]*/i.exec(text); if (!m) return null;
    const part = m[0];
    let c;
    if ((c = /\b(?:contains|includes|mentions)\s+["“'](.+?)["”']/i.exec(part)) || (c = /\b(?:contains|includes|mentions)\s+(\w+)/i.exec(part))) return `contains "${c[1].replace(/["\\]/g, '').trim()}"`;
    if ((c = /\b(?:longer|more)\s+than\s+(\d+)/i.exec(part))) return `length > ${c[1]}`;
    if (/\bempty\b/i.test(part)) return /\bnot\b/i.test(part) ? 'not empty' : 'is empty';
    return 'not empty';
  }

  /** {ok:true, name, steps, links, notes, explanation} or {ok:false, error}. */
  function plan(prompt) {
    const text = typeof prompt === 'string' ? prompt.trim() : '';
    if (!text) return { ok: false, error: 'Describe the flow you want first. ' + EXAMPLES };
    if (text.length > MAX_PROMPT) return { ok: false, error: `That description is too long (over ${MAX_PROMPT} characters). Shorten it to a sentence or two.` };

    const notes = []; const fetch = []; const transform = []; const output = [];
    const sched = schedule(text);
    const wantsResearch = /\bresearch(?:es|ing)?\b/i.test(text);
    const wantsSearch = !wantsResearch && /\b(?:find|search|look\s?up|look for|gather|fetch)\b|\bnews\b/i.test(text);
    if (wantsResearch) fetch.push({ type: 'research_bot', config: { topic: researchTopic(text) }, say: topic => `Research Bot: researches "${topic}" across several sources.` });
    if (wantsSearch) fetch.push({ type: 'search_web', config: { query: searchQuery(text) }, say: q => `Search Web: looks up "${q}".` });
    if (/\bsummar(?:y|ize|ise|ies)\b|\bdigest\b|\btl;?dr\b|\bshorten\b/i.test(text)) transform.push({ type: 'summarize', config: {}, say: () => 'Summarize: shortens the text into bullet points.' });
    if (/\btranslat(?:e|ion)\b/i.test(text)) {
      const l = new RegExp(`\\b(?:into|to|in)\\s+(${LANGS})\\b`, 'i').exec(text);
      if (!l) notes.push('Fill in the language on the Translate card.');
      transform.push({ type: 'translate', config: { target_language: l ? cap(l[1].toLowerCase()) : '' }, say: lang => `Translate: translates the text${lang ? ' into ' + lang : ''}.` });
    }
    if (/\bpython\b|\bcustom code\b/i.test(text)) transform.push({ type: 'python_code', config: {}, say: () => 'Python Code: your own code step (saved and checked, never run here).' });
    if (/\breport\b/i.test(text)) output.push({ type: 'create_report', config: { title: 'Report' }, say: () => 'Create Report: turns the text into a structured report.' });
    const wantsEmail = /\be-?mail\b|\bmail\b|\bsend\s+(?:it|me|them|this)\b/i.test(text);
    const address = EMAIL.exec(text);
    if (wantsEmail) {
      if (!address) notes.push('Fill in the email address on the Write Email card.');
      const topic = (fetch[0] && (fetch[0].config.query || fetch[0].config.topic)) || '';
      output.push({ type: 'write_email', config: { to: address ? address[0] : '', subject: topic ? clip('Update: ' + topic, 80) : 'Your AgentFlow update' }, say: to => `Write Email: writes an email${to ? ' to ' + to : ''} and sends it.` });
    }

    if (!fetch.length && !transform.length && !output.length) return { ok: false, error: 'I could not find any steps in that. ' + EXAMPLES };

    const cond = conditionExpr(text);
    const steps = [{ type: 'start', config: {}, say: () => 'Start: where the flow begins.' }];
    if (sched) steps.push({ type: 'timer', config: sched, say: () => `Timer: ${sched.schedule === 'every_hour' ? 'every hour' : sched.schedule === 'every_week' ? 'every week at ' + sched.time : 'every day at ' + sched.time} (simulated: runs once when you press Run).` });
    steps.push(...fetch, ...transform);
    const gated = cond && output.length ? output.splice(output.findIndex(o => o.type === 'write_email') >= 0 ? output.findIndex(o => o.type === 'write_email') : 0) : [];
    steps.push(...output);
    let conditionAt = -1;
    if (cond && gated.length) { conditionAt = steps.length; steps.push({ type: 'condition', config: { expression: cond }, say: () => `Condition: continues only if the text passes "${cond}", otherwise ends.` }); steps.push(...gated); }
    else if (cond) notes.push('A condition was ignored because there is nothing to do when it is true.');
    steps.push({ type: 'end', config: {}, say: () => 'End: the final result.' });

    const endAt = steps.length - 1; const links = [];
    steps.forEach((s, i) => {
      if (i === endAt) return;
      if (i === conditionAt) { links.push({ from: i, port: 'yes', to: i + 1 }, { from: i, port: 'no', to: endAt }); return; }
      links.push({ from: i, port: 'out', to: i + 1 });
    });
    const explanation = steps.map(s => s.say(s.config.query || s.config.topic || s.config.target_language || s.config.to));
    const name = cap(clip(tidy(text.split(/[.!?\n]/)[0]), 60)) || 'My flow';
    const clean = steps.map(({ type, config }) => ({ type, config }));
    return { ok: true, name, steps: clean, links, notes, explanation };
  }

  /** Real cards and connections from a plan, laid out left to right. `Nodes` is the card registry (AF.nodes). */
  function toGraph(p, Nodes) {
    const nodes = p.steps.map((s, i) => {
      const n = Nodes.makeNode(s.type, 80 + i * 300, 200, 'n' + (i + 1));
      n.config = Object.assign({}, n.config, s.config);
      return n;
    });
    const edges = p.links.map((l, i) => ({ id: 'e' + (i + 1), from: 'n' + (l.from + 1), fromPort: l.port, to: 'n' + (l.to + 1), toPort: 'in' }));
    return { nodes, edges };
  }

  return { plan, toGraph, MAX_PROMPT };
});
