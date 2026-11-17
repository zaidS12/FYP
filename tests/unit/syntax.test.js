'use strict';
// Every JavaScript file must at least parse. Browser-only files are never loaded by the other unit tests,
// so a stray comment or bracket in one of them would otherwise only show up as a blank page.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..', '..');
const DIRS = ['assets/js', 'server', 'scripts', 'tests'];

function walk(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'node_modules') out.push(...walk(p)); } else if (e.name.endsWith('.js')) out.push(p);
  }
  return out;
}

test('every script in the project parses', () => {
  const files = [path.join(ROOT, 'server.js'), path.join(ROOT, 'playwright.config.js'), ...DIRS.flatMap(d => walk(path.join(ROOT, d)))];
  assert.ok(files.length > 40, 'found ' + files.length + ' files');
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8').replace(/^#!.*\n/, '');
    assert.doesNotThrow(() => new vm.Script('(function(){' + src + '\n})', { filename: f }), 'syntax error in ' + path.relative(ROOT, f));
  }
});

test('every page loads only scripts that exist', () => {
  const pages = ['index.html', 'register.html', ...['super', 'admin', 'app'].flatMap(d => fs.readdirSync(path.join(ROOT, d)).filter(n => n.endsWith('.html')).map(n => d + '/' + n))];
  for (const page of pages) {
    const html = fs.readFileSync(path.join(ROOT, page), 'utf8');
    for (const m of html.matchAll(/<script[^>]+src="([^"]+)"/g)) {
      const target = path.normalize(path.join(ROOT, path.dirname(page), m[1]));
      assert.ok(fs.existsSync(target), page + ' loads a missing script: ' + m[1]);
    }
    for (const m of html.matchAll(/<link[^>]+href="(\.\.?\/[^"]+)"/g)) {
      const target = path.normalize(path.join(ROOT, path.dirname(page), m[1]));
      assert.ok(fs.existsSync(target), page + ' links a missing file: ' + m[1]);
    }
  }
});
