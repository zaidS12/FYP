'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const X = require('../../assets/js/exporter.js');
const Nodes = require('../../assets/js/nodes.js');
const CV = require('../../assets/js/canvas.js');

const flow = {
  id: 'f1', tenant_id: 't_secret', owner_id: 'u_secret', name: 'Daily <digest> & "news"', version: 4,
  nodes: [
    { id: 'n1', type: 'start', label: 'Start', x: 80, y: 160, config: {} },
    { id: 'n2', type: 'search_web', label: 'Find <b>news</b>', x: 380, y: 160, config: { query: 'AI & robots' } },
    { id: 'n3', type: 'end', label: 'End', x: 680, y: 160, config: {} },
  ],
  edges: [{ id: 'e1', from: 'n1', fromPort: 'out', to: 'n2', toPort: 'in' }, { id: 'e2', from: 'n2', fromPort: 'out', to: 'n3', toPort: 'in' }],
};

test('the JSON export carries the flow itself and nothing about who owns it', () => {
  const out = X.toExportObject(flow);
  assert.equal(out.format, 'agentflow.flow'); assert.equal(out.version, 1);
  assert.equal(out.name, flow.name); assert.equal(out.nodes.length, 3); assert.equal(out.edges.length, 2);
  assert.ok(!JSON.stringify(out).match(/t_secret|u_secret|tenant|owner/));
  assert.ok(!Number.isNaN(Date.parse(out.exported_at)));
});

test('import accepts its own export, a {flow:...} wrapper and a bare graph, and gives a name', () => {
  const own = X.parseImport(JSON.parse(JSON.stringify(X.toExportObject(flow))), 'file.json');
  assert.equal(own.ok, true); assert.equal(own.name, flow.name); assert.equal(own.nodes.length, 3);
  assert.equal(X.parseImport({ flow: { name: 'W', nodes: [], edges: [] } }, 'x.json').name, 'W');
  assert.equal(X.parseImport({ nodes: [], edges: [] }, 'my-flow.json').name, 'my-flow');
});

test('import refuses things that are not flows, with a message that says what to do', () => {
  for (const bad of [null, 5, 'text', [], {}, { nodes: 'x', edges: [] }, { format: 'something.else', nodes: [], edges: [] }]) {
    const r = X.parseImport(bad, 'a.json'); assert.equal(r.ok, false); assert.match(r.error, /Export JSON/);
  }
  const big = { nodes: Array.from({ length: 201 }, (_, i) => ({ id: 'n' + i })), edges: [] };
  assert.match(X.parseImport(big, 'a.json').error, /at most 200/);
  const proto = X.parseImport({ nodes: [{ id: 'n1', type: 'start', config: JSON.parse('{"__proto__":{"x":1}}') }], edges: [] }, 'a.json');
  assert.equal(proto.ok, true); assert.equal(({}).x, undefined);
});

test('the SVG picture shows every card, wire and label, and escapes everything', () => {
  const { svg, width, height } = X.toSvg(flow, { Nodes, CV, title: true });
  assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
  assert.equal((svg.match(/class="card"/g) || []).length, 3);
  assert.equal((svg.match(/class="wire"/g) || []).length, 2);
  assert.ok(svg.includes('Find &lt;b&gt;news&lt;/b&gt;')); assert.ok(svg.includes('Daily &lt;digest&gt; &amp; &quot;news&quot;'));
  assert.ok(!/<script|onload|<b>/i.test(svg));
  assert.ok(width > 600 && height > 150);
});

test('an empty flow still draws a valid picture', () => {
  const { svg } = X.toSvg({ name: 'Empty', nodes: [], edges: [] }, { Nodes, CV });
  assert.match(svg, /<\/svg>$/); assert.match(svg, /no cards/i);
});

test('the PDF is well formed: header, objects, correct xref offsets, trailer', () => {
  const jpeg = { bytes: Uint8Array.from([0xFF, 0xD8, 0xFF, 0xE0, 1, 2, 3, 0xFF, 0xD9]), width: 640, height: 320 };
  const pdf = X.buildPdf({ title: 'My (flow) \\ test é', subtitle: 'Exported today', jpeg, lines: ['1. Start', '2. Search (web)'] });
  const text = Buffer.from(pdf).toString('latin1');
  assert.ok(text.startsWith('%PDF-1.4')); assert.ok(text.trimEnd().endsWith('%%EOF'));
  const start = Number(/startxref\s+(\d+)/.exec(text)[1]);
  assert.equal(text.slice(start, start + 4), 'xref');
  const entries = [...text.slice(start).matchAll(/(\d{10}) 00000 n /g)].map(m => Number(m[1]));
  assert.ok(entries.length >= 6);
  entries.forEach((off, i) => assert.ok(text.slice(off, off + 12).startsWith(`${i + 1} 0 obj`), `object ${i + 1} at ${off}`));
  assert.ok(text.includes('/DCTDecode')); assert.ok(text.includes('/Width 640')); assert.ok(text.includes('My \\(flow\\) \\\\ test ?'));
  assert.ok(Buffer.from(pdf).includes(Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 1, 2, 3, 0xFF, 0xD9])));
});

test('a PDF without a picture still works, and long card lists continue on more pages', () => {
  const lines = Array.from({ length: 150 }, (_, i) => `${i + 1}. Card number ${i + 1}`);
  const pdf = Buffer.from(X.buildPdf({ title: 'Big', subtitle: '', jpeg: null, lines })).toString('latin1');
  assert.ok(!pdf.includes('/DCTDecode'));
  assert.ok((pdf.match(/\/Type \/Page\b/g) || []).length >= 3);
});

test('file names are safe', () => {
  assert.equal(X.safeFileName('Daily <digest> & "news"', 'png'), 'Daily-digest-news.png');
  assert.equal(X.safeFileName('../../etc/passwd', 'json'), 'etc-passwd.json');
  assert.equal(X.safeFileName('', 'pdf'), 'flow.pdf');
});
