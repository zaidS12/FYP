'use strict';
/* Design-checkpoint screenshots. Starts the real server on a random port against a THROWAWAY copy of the seed,
 * so data/db.json is never touched. Output: docs/screenshots/*.png  (run: npm run shots) */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('@playwright/test');
const { createServer } = require('../server.js');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'docs', 'screenshots');

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'af shots '));
  const server = createServer({ dataDir, seedFile: path.join(ROOT, 'data', 'seed.json') });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  const browser = await chromium.launch();
  const written = [];
  try {
    for (const theme of ['light', 'dark']) {
      const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
      await ctx.addInitScript(t => { try { localStorage.setItem('af.theme', t); } catch (e) { /* ignore */ } }, theme);
      const page = await ctx.newPage();
      const shot = async name => { const f = path.join(OUT, `${name}-${theme}.png`); await page.screenshot({ path: f }); written.push(f); };

      await page.goto(base + '/index.html');
      await page.waitForSelector('#mode-note:not(:has-text("Checking"))');
      await shot('login');

      await page.goto(base + '/register.html');
      await shot('register');

      await page.goto(base + '/index.html');
      await page.fill('#email', 'ana@brightloom.test');
      await page.fill('#password', 'AgentFlow#2026');
      await Promise.all([page.waitForURL('**/app/flows.html'), page.click('#login-submit')]);
      await page.waitForSelector('#flows-host table');
      // The user's saved preference (light) wins after sign-in, so switch with the real toggle and check it sticks.
      if (theme === 'dark') {
        await page.click('button[aria-label="Switch to dark mode"]');
        await page.waitForFunction(() => document.documentElement.getAttribute('data-theme') === 'dark');
        await page.reload();
        await page.waitForSelector('#flows-host table');
        if (await page.evaluate(() => document.documentElement.getAttribute('data-theme')) !== 'dark') throw new Error('Dark theme did not persist per user after reload');
      }
      await shot('shell-employee');

      if (theme === 'light') {
        await page.setViewportSize({ width: 390, height: 800 });
        await page.waitForTimeout(150);
        await shot('shell-mobile');
      }
      await ctx.close();
    }
  } finally {
    await browser.close();
    await new Promise(r => server.close(r));
  }
  process.stdout.write(written.map(f => path.relative(ROOT, f)).join('\n') + '\n');
})().catch(e => { process.stderr.write('screenshots failed: ' + (e && e.stack || e) + '\n'); process.exit(1); });
