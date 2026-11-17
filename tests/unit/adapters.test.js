'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { FakeAIProvider, ProviderError } = require('../../assets/js/adapters/ai.js');
const { FakeSearchProvider } = require('../../assets/js/adapters/search.js');
const { FakeMailProvider } = require('../../assets/js/adapters/mail.js');

const TEXT = 'AI is moving fast. Models got cheaper. Teams adopt agents. Regulation is coming. Final line here. Extra sentence ignored.';

test('AI summarize: bullets respect the word limit, headline is short, paragraph joins sentences, empty input is explained', async () => {
  const ai = new FakeAIProvider();
  const b = await ai.summarize({ text: TEXT, style: 'bullets', max_words: 8 });
  assert.match(b.text, /^• AI is moving fast\./);
  assert.ok(b.text.split('\n').length <= 3 && b.text.split(/\s+/).length <= 14);
  assert.ok(b.tokens.in > 0 && b.tokens.out > 0);
  const h = await ai.summarize({ text: TEXT, style: 'headline', max_words: 100 });
  assert.equal(h.text, 'AI is moving fast');
  const p = await ai.summarize({ text: TEXT, style: 'paragraph', max_words: 100 });
  assert.equal(p.text, 'AI is moving fast. Models got cheaper. Teams adopt agents.');
  assert.match((await ai.summarize({ text: '   ', style: 'bullets', max_words: 50 })).text, /nothing to summarize/);
  assert.deepEqual(await ai.summarize({ text: TEXT, style: 'bullets', max_words: 40 }), await ai.summarize({ text: TEXT, style: 'bullets', max_words: 40 }), 'deterministic');
});

test('AI translate, email, report and research produce clearly simulated text', async () => {
  const ai = new FakeAIProvider();
  assert.match((await ai.translate({ text: 'Hello', language: 'Urdu' })).text, /^\[Urdu translation, simulated\]\nHello$/);
  const e = await ai.writeEmail({ text: 'Quarterly numbers are up.', tone: 'formal', subject: 'Q3' });
  assert.match(e.text, /^Dear colleague,/); assert.equal(e.subject, 'Q3'); assert.match(e.text, /Kind regards/);
  assert.equal((await ai.writeEmail({ text: 'x', tone: 'friendly' })).subject, 'Your AgentFlow update');
  const r = await ai.createReport({ text: TEXT, title: 'Weekly', format: 'markdown', sections: 'Summary, Risks' });
  assert.match(r.text, /^# Weekly/); assert.equal((r.text.match(/^## /gm) || []).length, 2);
  const plain = await ai.createReport({ text: TEXT, title: 'Weekly', format: 'plain', sections: 'Summary' });
  assert.match(plain.text, /^WEEKLY/); assert.doesNotMatch(plain.text, /#/);
  const res = await ai.research({ topic: 'pricing', depth: 'quick', sources: [1, 2, 3, 4].map(i => ({ title: 'T' + i, snippet: 'S' + i })) });
  assert.match(res.text, /Sources checked: 2/);
});

test('AI failures are readable ProviderErrors with a code', async () => {
  const ai = new FakeAIProvider();
  for (const call of [() => ai.summarize({ text: 'x [ai-error]' }), () => ai.translate({ text: '[ai-error]', language: 'Urdu' }), () => ai.writeEmail({ text: '[ai-error]' }), () => ai.createReport({ text: '[ai-error]' }), () => ai.research({ topic: '[ai-error]' })]) {
    await assert.rejects(call, e => e instanceof ProviderError && e.code === 'ai_unavailable' && /not responding/.test(e.message));
  }
});

test('search returns the requested number of deterministic, simulated results', async () => {
  const s = new FakeSearchProvider();
  const r = await s.search({ query: 'electric cars', max_results: 3 });
  assert.equal(r.results.length, 3);
  assert.ok(r.results.every(x => x.title && x.url.startsWith('https://news.example.test/electric-cars/') && x.snippet));
  assert.deepEqual(await s.search({ query: 'electric cars', max_results: 3 }), r);
  assert.equal((await s.search({ query: 'x', max_results: 99 })).results.length, 10);
  assert.equal((await s.search({ query: 'x' })).results.length, 5);
  await assert.rejects(() => s.search({ query: 'news [fail]' }), e => e.code === 'search_timeout' && /timed out/.test(e.message));
  await assert.rejects(() => s.search({ query: '  ' }), e => e.code === 'empty_query');
});

test('mail never leaves the building: it records the message, rejects bad and bouncing addresses', async () => {
  const m = new FakeMailProvider();
  const r = await m.send({ to: 'team@brightloom.test', subject: 'Hi', body: 'Body' });
  assert.match(r.id, /^msg_0001/); assert.equal(r.status, 'sent (simulated)');
  assert.equal(m.sent.length, 1); assert.equal(m.sent[0].subject, 'Hi');
  assert.notEqual((await m.send({ to: 'team@brightloom.test', subject: 'Hi', body: 'B' })).id, r.id);
  await assert.rejects(() => m.send({ to: 'x@bounce.test', subject: 's', body: 'b' }), e => e.code === 'mail_rejected' && /rejected/.test(e.message));
  await assert.rejects(() => m.send({ to: 'not-an-address', subject: 's', body: 'b' }), e => e.code === 'bad_address');
  assert.equal(m.sent.length, 2);
});
