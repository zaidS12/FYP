/* AgentFlow node registry. A new card type is ONE object: {id, category, icon, label, description, ports, fields, summary(config)}.
 * `run()` for each card is attached by engine.js (phase 7). Users can also make their own cards from an existing one ("custom cards").
 * UMD: browser (AF.nodes), server and tests. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else { root.AF = root.AF || {}; root.AF.nodes = factory(); }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const categories = [
    { id: 'trigger', label: 'Triggers' }, { id: 'ai', label: 'AI' }, { id: 'data', label: 'Data' },
    { id: 'logic', label: 'Logic' }, { id: 'output', label: 'Output' }, { id: 'code', label: 'Code' },
  ];
  const opt = (value, label) => ({ value, label });
  const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
  const FORBIDDEN = new Set(['__proto__', 'constructor', 'prototype']);
  const safeCopy = x => JSON.parse(JSON.stringify(x), (k, v) => (FORBIDDEN.has(k) ? undefined : v));
  const clip = (s, n) => { const t = String(s); return t.length > n ? t.slice(0, n - 1) + '…' : t; };
  const NOT_SET = 'Not set up yet';

  /** The built-in cards. ports.in: does it have an input; ports.out: names of its outputs. */
  const BUILT_IN = [
    { id: 'start', category: 'trigger', icon: 'bolt', label: 'Start', description: 'Where the flow begins. You can give it some starting text.', ports: { in: false, out: ['out'] },
      fields: [{ name: 'input_text', label: 'Starting text (optional)', type: 'textarea', hint: 'Handed to the next card as its input.' }],
      summary: c => (c.input_text ? 'Starts with: "' + clip(c.input_text, 40) + '"' : 'Where the flow begins') },
    { id: 'end', category: 'output', icon: 'flag', label: 'End', description: 'Where the flow finishes. Whatever reaches it becomes the final result.', ports: { in: true, out: [] },
      fields: [{ name: 'result_title', label: 'Result title (optional)', type: 'text', placeholder: 'Final result' }],
      summary: c => (c.result_title ? 'Result: ' + clip(c.result_title, 34) : 'Where the flow finishes') },
    { id: 'timer', category: 'trigger', icon: 'clock', label: 'Timer / Cron', description: 'Runs the rest of the flow on a schedule, such as every morning at 8.', ports: { in: true, out: ['out'] },
      fields: [
        { name: 'schedule', label: 'How often', type: 'select', default: 'every_day', options: [opt('every_hour', 'Every hour'), opt('every_day', 'Every day'), opt('every_week', 'Every week'), opt('custom', 'Custom cron')] },
        { name: 'time', label: 'At what time (HH:MM)', type: 'text', default: '08:00', placeholder: '08:00' },
        { name: 'cron', label: 'Cron expression (custom only)', type: 'text', placeholder: '0 8 * * 1-5', hint: 'Five fields: minute hour day month weekday.' }],
      summary: c => (c.schedule === 'custom' ? 'Cron: ' + (c.cron || '…') : { every_hour: 'Every hour', every_day: 'Every day at ' + (c.time || '08:00'), every_week: 'Every week at ' + (c.time || '08:00') }[c.schedule] || NOT_SET) },
    { id: 'search_web', category: 'data', icon: 'search', label: 'Search Web', description: 'Searches the web and passes the results on.', ports: { in: true, out: ['out'] },
      fields: [{ name: 'query', label: 'Search query', type: 'text', required: true, placeholder: 'latest AI news' }, { name: 'max_results', label: 'How many results', type: 'number', integer: true, default: 5, min: 1, max: 10 }],
      summary: c => (c.query ? 'Search: "' + clip(c.query, 36) + '"' : NOT_SET) },
    { id: 'research_bot', category: 'ai', icon: 'bot', label: 'Research Bot', description: 'An AI agent that researches a topic across several sources.', ports: { in: true, out: ['out'] },
      fields: [{ name: 'topic', label: 'Topic to research', type: 'text', required: true, placeholder: 'competitor pricing' }, { name: 'depth', label: 'How deep', type: 'select', default: 'standard', options: [opt('quick', 'Quick'), opt('standard', 'Standard'), opt('deep', 'Deep')] }],
      summary: c => (c.topic ? 'Research: ' + clip(c.topic, 34) : NOT_SET) },
    { id: 'summarize', category: 'ai', icon: 'sparkle', label: 'Summarize', description: 'Shortens the incoming text.', ports: { in: true, out: ['out'] },
      fields: [{ name: 'style', label: 'Style', type: 'select', default: 'bullets', options: [opt('bullets', 'Bullets'), opt('paragraph', 'Paragraph'), opt('headline', 'Headline')] }, { name: 'max_words', label: 'Up to how many words', type: 'number', integer: true, default: 120, min: 20, max: 1000 }],
      summary: c => ({ bullets: 'Bullets', paragraph: 'Paragraph', headline: 'Headline' }[c.style] || 'Bullets') + ', up to ' + (c.max_words || 120) + ' words' },
    { id: 'translate', category: 'ai', icon: 'globe', label: 'Translate', description: 'Translates the incoming text into another language.', ports: { in: true, out: ['out'] },
      fields: [{ name: 'target_language', label: 'Translate into', type: 'text', required: true, placeholder: 'Urdu' }],
      summary: c => (c.target_language ? 'Into ' + clip(c.target_language, 30) : NOT_SET) },
    { id: 'write_email', category: 'output', icon: 'mail', label: 'Write Email', description: 'Writes an email from the incoming text and sends it.', ports: { in: true, out: ['out'] },
      fields: [{ name: 'to', label: 'Send to', type: 'email', required: true, placeholder: 'name@company.com' }, { name: 'subject', label: 'Subject', type: 'text', required: true }, { name: 'tone', label: 'Tone', type: 'select', default: 'friendly', options: [opt('friendly', 'Friendly'), opt('formal', 'Formal'), opt('concise', 'Concise')] }],
      summary: c => (c.to ? 'To ' + clip(c.to, 34) : NOT_SET) },
    { id: 'create_report', category: 'output', icon: 'doc', label: 'Create Report', description: 'Turns the incoming text into a structured report.', ports: { in: true, out: ['out'] },
      fields: [{ name: 'title', label: 'Report title', type: 'text', default: 'Report' }, { name: 'format', label: 'Format', type: 'select', default: 'markdown', options: [opt('markdown', 'Markdown'), opt('plain', 'Plain text')] }, { name: 'sections', label: 'Sections (comma separated)', type: 'text', default: 'Summary, Findings' }],
      summary: c => ({ markdown: 'Markdown', plain: 'Plain text' }[c.format] || 'Markdown') + ' report' },
    { id: 'condition', category: 'logic', icon: 'branch', label: 'Condition', description: 'Chooses the YES or NO path depending on the incoming text.', ports: { in: true, out: ['yes', 'no'] },
      fields: [{ name: 'expression', label: 'Check', type: 'text', required: true, placeholder: 'length > 200', hint: 'Examples: length > 200, contains "error", not contains "sorry".' }],
      summary: c => (c.expression ? 'If ' + clip(c.expression, 34) : NOT_SET) },
    { id: 'loop', category: 'logic', icon: 'repeat', label: 'Loop', description: 'Repeats the EACH path a number of times, then continues on DONE.', ports: { in: true, out: ['each', 'done'] },
      fields: [{ name: 'count', label: 'Repeat how many times', type: 'number', integer: true, required: true, default: 3, min: 1, max: 10 }],
      summary: c => 'Repeat ' + (c.count || 3) + ' times' },
    { id: 'python_code', category: 'code', icon: 'code', label: 'Python Code', description: 'Your own Python. It is saved and checked for problems but never executed here.', ports: { in: true, out: ['out'] },
      fields: [{ name: 'code', label: 'Python code', type: 'textarea', required: true, default: '# input_text holds the text from the previous card\nresult = input_text.upper()\n', hint: 'Saved and validated only. AgentFlow does not run custom code in this stage.' }],
      summary: c => String(c.code || '').split('\n').filter(l => l.trim()).length + ' lines of Python' },
  ];

  // ---------------------------------------------------------------- running a card
  class RunError extends Error { constructor(message, code) { super(message); this.name = 'RunError'; this.code = code || 'step_error'; } }

  /** The checks a Condition card understands. Returns {ok:true, value} or {ok:false, error}. */
  function evalCondition(expr, text) {
    const e = String(expr == null ? '' : expr).trim(); const t = String(text == null ? '' : text); let m;
    if ((m = /^length\s*(>=|<=|==|>|<)\s*(\d+)$/.exec(e))) { const n = Number(m[2]); const l = t.length; return { ok: true, value: { '>': l > n, '<': l < n, '>=': l >= n, '<=': l <= n, '==': l === n }[m[1]] }; }
    if ((m = /^(not\s+)?contains\s+"([^"]*)"$/i.exec(e))) { const has = t.toLowerCase().includes(m[2].toLowerCase()); return { ok: true, value: m[1] ? !has : has }; }
    if ((m = /^starts\s+with\s+"([^"]*)"$/i.exec(e))) return { ok: true, value: t.toLowerCase().startsWith(m[1].toLowerCase()) };
    if ((m = /^equals\s+"([^"]*)"$/i.exec(e))) return { ok: true, value: t.trim().toLowerCase() === m[1].toLowerCase() };
    if (/^is\s+empty$/i.test(e)) return { ok: true, value: t.trim() === '' };
    if (/^not\s+empty$/i.test(e)) return { ok: true, value: t.trim() !== '' };
    return { ok: false, error: `Could not understand the check "${e}". Try: length > 200, contains "error", starts with "Hello", or is empty.` };
  }

  /** Python code is saved and checked, never executed. Returns null when it looks safe, otherwise a sentence that says what to fix. */
  function validatePython(code) {
    const src = String(code == null ? '' : code);
    const banned = /\b(?:import\s+(os|subprocess|socket|shutil|sys|ctypes|pathlib)\b|from\s+(os|subprocess|socket|shutil|sys|ctypes|pathlib)\b|(__import__)|(eval)\s*\(|(exec)\s*\(|(open)\s*\(|(compile)\s*\(|(os)\.\w+)/.exec(src);
    if (banned) { const word = banned.slice(1).find(Boolean); return `Python code uses "${word}", which is not allowed because custom code is only saved and checked. Remove it.`; }
    const bare = src.replace(/#.*$/gm, '').replace(/"""[\s\S]*?"""|'''[\s\S]*?'''/g, '').replace(/"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'/g, '');
    const stack = []; const pairs = { ')': '(', ']': '[', '}': '{' };
    for (const ch of bare) {
      if ('([{'.includes(ch)) stack.push(ch);
      else if (pairs[ch]) { if (stack.pop() !== pairs[ch]) return 'Python code has a closing bracket that does not match an opening one. Check your brackets.'; }
    }
    if (stack.length) return 'Python code has an unclosed bracket. Close every ( [ { you open.';
    return null;
  }

  const lines = r => r.results.map((x, i) => `${i + 1}. ${x.title}\n   ${x.url}\n   ${x.snippet}`).join('\n');
  const need = (providers, name) => { if (!providers || !providers[name]) throw new RunError(`The ${name} provider is not available on this server.`, 'no_provider'); return providers[name]; };
  /** What each built-in card does when the flow runs. ctx: {config, input, providers, log, loop}. Returns {output, branch?, latency?}. */
  const RUN = {
    start: async ctx => ({ output: String(ctx.input == null ? '' : ctx.input) }),
    timer: async ctx => { ctx.log('Schedule: ' + summaryOf('timer', ctx.config) + ' (simulated: the rest of the flow runs once now).'); return { output: ctx.input }; },
    search_web: async ctx => { const r = await need(ctx.providers, 'search').search({ query: ctx.config.query, max_results: ctx.config.max_results }); ctx.log(`Found ${r.results.length} results for "${ctx.config.query}".`); return { output: lines(r), latency: r.latency_ms }; },
    research_bot: async ctx => {
      const search = need(ctx.providers, 'search'); const a = await search.search({ query: ctx.config.topic, max_results: 4 }); const b = await search.search({ query: ctx.config.topic + ' overview', max_results: 4 });
      const r = await need(ctx.providers, 'ai').research({ topic: ctx.config.topic, depth: ctx.config.depth, sources: a.results.concat(b.results) }); ctx.log(`Read ${a.results.length + b.results.length} sources.`); return { output: r.text, latency: r.latency_ms };
    },
    summarize: async ctx => { const r = await need(ctx.providers, 'ai').summarize({ text: ctx.input, style: ctx.config.style, max_words: ctx.config.max_words }); return { output: r.text, latency: r.latency_ms }; },
    translate: async ctx => { const r = await need(ctx.providers, 'ai').translate({ text: ctx.input, language: ctx.config.target_language }); return { output: r.text, latency: r.latency_ms }; },
    write_email: async ctx => {
      const r = await need(ctx.providers, 'ai').writeEmail({ text: ctx.input, tone: ctx.config.tone, subject: ctx.config.subject });
      const sent = await need(ctx.providers, 'mail').send({ to: ctx.config.to, subject: ctx.config.subject || r.subject, body: r.text });
      ctx.log(`Email to ${ctx.config.to} ${sent.status}.`);
      return { output: `${r.text}\n\n— Sent to ${ctx.config.to} (${sent.status}, id ${sent.id})`, latency: (r.latency_ms || 0) + (sent.latency_ms || 0) };
    },
    create_report: async ctx => { const r = await need(ctx.providers, 'ai').createReport({ text: ctx.input, title: ctx.config.title, format: ctx.config.format, sections: ctx.config.sections }); return { output: r.text, latency: r.latency_ms }; },
    condition: async ctx => {
      const r = evalCondition(ctx.config.expression, ctx.input);
      if (!r.ok) throw new RunError(r.error, 'bad_expression');
      ctx.log(`Check "${ctx.config.expression}" is ${r.value ? 'true, taking YES' : 'false, taking NO'}.`);
      return { output: ctx.input, branch: r.value ? 'yes' : 'no' };
    },
    loop: async ctx => { ctx.log(`Repeating ${ctx.config.count} times.`); return { output: ctx.input }; },
    python_code: async ctx => {
      const problem = validatePython(ctx.config.code);
      if (problem) throw new RunError(problem, 'bad_code');
      ctx.log('Python code was checked but not run (custom code never runs in this stage). Its input is passed on unchanged.');
      return { output: ctx.input };
    },
    end: async ctx => ({ output: ctx.input }),
  };
  function summaryOf(id, config) { return builtIns.get(id).summary(config || {}); }

  const builtIns = new Map(BUILT_IN.map(d => [d.id, d]));
  for (const d of BUILT_IN) d.run = RUN[d.id];
  const customs = new Map();
  const CUSTOM_ID = /^custom_[a-z0-9_]{1,30}$/;
  const MAX_CUSTOM = 30;

  const get = type => builtIns.get(type) || customs.get(type) || null;
  const baseDef = node => { const d = get(node.type); return d && d.custom ? get(d.base) : d; };

  function types() {
    const order = new Map(categories.map((c, i) => [c.id, i]));
    return [...builtIns.values(), ...customs.values()].sort((a, b) => order.get(a.category) - order.get(b.category));
  }

  function defaults(type) {
    const d = get(type); if (!d) return {};
    const src = d.custom ? get(d.base) : d;
    const out = {};
    for (const f of src.fields) out[f.name] = f.default !== undefined ? f.default : (f.type === 'number' ? '' : '');
    return d.custom ? Object.assign(out, d.preset) : out;
  }

  function portsOf(node) {
    const d = get(node.type) || (node.base && get(node.base));
    if (!d) return null;
    const src = d.custom ? get(d.base) : d;
    return { in: src.ports.in, out: src.ports.out.slice() };
  }

  const fieldsOf = type => { const d = get(type); if (!d) return []; return (d.custom ? get(d.base) : d).fields; };
  const requiredFields = type => fieldsOf(type).filter(f => f.required);

  function summary(node) {
    const d = baseDef(node) || (node.base && get(node.base));
    return d ? d.summary(node.config || {}) : NOT_SET;
  }

  function nextId(nodes) {
    let max = 0;
    for (const n of nodes || []) { const m = /^n(\d+)$/.exec(n.id); if (m && Number(m[1]) > max) max = Number(m[1]); }
    return 'n' + (max + 1);
  }

  function makeNode(type, x, y, id) {
    const d = get(type); if (!d) return null;
    const node = { id, type, label: d.label, x, y, config: defaults(type) };
    if (d.custom) node.base = d.base;
    return node;
  }

  /** Create a card of your own from an existing built-in card with preset settings. */
  function registerCustom(card) {
    const c = card && typeof card === 'object' ? card : {};
    if (typeof c.id !== 'string' || !CUSTOM_ID.test(c.id)) return { ok: false, error: 'A custom card id must look like custom_my_card.' };
    if (builtIns.has(c.id)) return { ok: false, error: 'That id is used by a built-in card.' };
    const label = typeof c.label === 'string' ? c.label.trim() : '';
    if (!label || label.length > 40) return { ok: false, error: 'Give your card a name (up to 40 characters).' };
    const base = builtIns.get(c.base);
    if (!base) return { ok: false, error: 'Custom cards must be made from one of the built-in cards.' };
    const preset = c.config && typeof c.config === 'object' && !Array.isArray(c.config) ? safeCopy(c.config) : {};
    customs.set(c.id, { id: c.id, category: base.category, icon: base.icon, label, description: 'Your card, made from ' + base.label + '.', custom: true, base: base.id, preset, ports: base.ports, fields: base.fields, summary: base.summary });
    return { ok: true };
  }
  const unregisterCustom = id => { customs.delete(id); };

  /** Keep only valid, unique custom cards (at most 30). Used before saving and after loading. */
  function cleanCustomCards(list) {
    const out = []; const seen = new Set();
    for (const c of Array.isArray(list) ? list : []) {
      if (!c || typeof c !== 'object' || seen.has(c.id) || typeof c.id !== 'string' || !CUSTOM_ID.test(c.id) || builtIns.has(c.id)) continue;
      const label = typeof c.label === 'string' ? c.label.trim() : '';
      if (!label || label.length > 40 || !builtIns.has(c.base)) continue;
      const config = c.config && typeof c.config === 'object' && !Array.isArray(c.config) && JSON.stringify(c.config).length <= 5000 ? safeCopy(c.config) : {};
      seen.add(c.id); out.push({ id: c.id, label, base: c.base, config });
      if (out.length >= MAX_CUSTOM) break;
    }
    return out;
  }
  function loadCustomCards(list) { customs.clear(); for (const c of cleanCustomCards(list)) registerCustom(c); }

  return { categories, types, get, defaults, portsOf, fieldsOf, requiredFields, summary, nextId, makeNode, registerCustom, unregisterCustom, cleanCustomCards, loadCustomCards, has, MAX_CUSTOM, RunError, evalCondition, validatePython };
});
