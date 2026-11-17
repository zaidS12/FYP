'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Architect = require('../../assets/js/architect.js');
const Nodes = require('../../assets/js/nodes.js');
const Engine = require('../../assets/js/engine.js');
const { FakeAIProvider } = require('../../assets/js/adapters/ai.js');

const types = plan => plan.steps.map(s => s.type);

test('the example from the brief: find daily AI news and email me a summary', () => {
  const p = Architect.plan('Find daily AI news and email me a summary');
  assert.equal(p.ok, true);
  assert.deepEqual(types(p), ['start', 'timer', 'search_web', 'summarize', 'write_email', 'end']);
  assert.match(p.steps[2].config.query, /AI news/i);
  assert.equal(p.steps[1].config.schedule, 'every_day');
});

test('steps always run fetch -> transform -> output, whatever order the sentence uses', () => {
  const p = Architect.plan('Email me a summary of the latest news about solar panels');
  assert.deepEqual(types(p), ['start', 'search_web', 'summarize', 'write_email', 'end']);
  assert.match(p.steps[1].config.query, /solar panels/i);
});

test('translate picks up the language; report and research cards are recognised', () => {
  const p = Architect.plan('Research competitor pricing, translate it into Urdu and create a report');
  assert.deepEqual(types(p), ['start', 'research_bot', 'translate', 'create_report', 'end']);
  assert.equal(p.steps[2].config.target_language, 'Urdu');
  assert.match(p.steps[1].config.topic, /competitor pricing/i);
});

test('an email address in the prompt is used; otherwise the card is left for the user and a note says so', () => {
  const a = Architect.plan('Search the web for AI news and send it to boss@example.com');
  assert.equal(a.steps.find(s => s.type === 'write_email').config.to, 'boss@example.com');
  const b = Architect.plan('Summarize the news and email me');
  assert.equal(b.steps.find(s => s.type === 'write_email').config.to, '');
  assert.ok(b.notes.some(n => /email address/i.test(n)));
});

test('schedules: hourly, weekly and a time of day', () => {
  assert.equal(Architect.plan('Every hour search the web for outages').steps[1].config.schedule, 'every_hour');
  const w = Architect.plan('Every week at 9:30 pm research my competitors').steps[1].config;
  assert.deepEqual([w.schedule, w.time], ['every_week', '21:30']);
  assert.equal(Architect.plan('Every morning at 7 search the web for weather').steps[1].config.time, '07:00');
});

test('a condition sends YES to the output step and NO straight to the end', () => {
  const p = Architect.plan('Search the web for server errors, and if the text contains "outage" email me');
  assert.deepEqual(types(p), ['start', 'search_web', 'condition', 'write_email', 'end']);
  assert.equal(p.steps[2].config.expression, 'contains "outage"');
  const links = p.links.filter(l => l.from === 2);
  assert.deepEqual(links.map(l => [l.port, p.steps[l.to].type]).sort(), [['no', 'end'], ['yes', 'write_email']]);
});

test('toGraph builds real cards that pass the flow validator once the user fills in what is missing', () => {
  const p = Architect.plan('Find daily AI news and email me a summary to me@example.com');
  const g = Architect.toGraph(p, Nodes);
  assert.equal(g.nodes.length, 6);
  assert.deepEqual(g.nodes.map(n => n.id), ['n1', 'n2', 'n3', 'n4', 'n5', 'n6']);
  assert.ok(g.nodes.every((n, i) => i === 0 || n.x > g.nodes[i - 1].x), 'laid out left to right');
  assert.equal(Engine.validateFlow(g.nodes, g.edges).ok, true, JSON.stringify(Engine.validateFlow(g.nodes, g.edges).errors));
  const bare = Architect.toGraph(Architect.plan('Find news and email me'), Nodes);
  assert.equal(Engine.validateFlow(bare.nodes, bare.edges).ok, false, 'missing email address is shown as a problem on the card');
});

test('conditions produce a valid graph too', () => {
  const g = Architect.toGraph(Architect.plan('Search the web for errors, if it contains "down" email ops@example.com'), Nodes);
  assert.equal(Engine.validateFlow(g.nodes, g.edges).ok, true, JSON.stringify(Engine.validateFlow(g.nodes, g.edges).errors));
});

test('a prompt with no recognisable step is refused with examples, not turned into an empty flow', () => {
  for (const bad of ['', '   ', 'hello', 'x'.repeat(10)]) {
    const p = Architect.plan(bad); assert.equal(p.ok, false); assert.match(p.error, /Try something like/);
  }
  assert.equal(Architect.plan('a'.repeat(3000)).ok, false, 'too long');
});

test('the flow gets a readable name and a plain-language explanation of each step', () => {
  const p = Architect.plan('Find daily AI news and email me a summary');
  assert.ok(p.name.length > 3 && p.name.length <= 60);
  assert.ok(p.explanation.length >= 4); assert.ok(p.explanation.every(x => typeof x === 'string' && x.length > 5));
});

test('the fake AI provider exposes the architect behind the AIProvider interface', async () => {
  const ai = new FakeAIProvider();
  const r = await ai.planFlow({ prompt: 'Summarize the news and email me at a@b.co' });
  assert.equal(r.ok, true); assert.ok(r.steps.length >= 4);
  await assert.rejects(() => ai.planFlow({ prompt: 'make it [ai-error]' }), /not responding/);
});
