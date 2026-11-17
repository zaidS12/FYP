'use strict';
const { test, expect } = require('@playwright/test');
const { loginOk, api } = require('./helpers');

test('credit exhaustion: runs are blocked with a clear message, in the builder and over the API', async ({ page }) => {
  test.setTimeout(90000);
  await loginOk(page, 'solo@example.test');
  const nodes = [
    { id: 'n1', type: 'start', label: 'Start', x: 80, y: 160, config: {} },
    { id: 'n2', type: 'research_bot', label: 'Research', x: 380, y: 160, config: { topic: 'solar panels', depth: 'deep' } },
    { id: 'n3', type: 'end', label: 'End', x: 680, y: 160, config: {} }];
  const edges = [{ id: 'e1', from: 'n1', fromPort: 'out', to: 'n2', toPort: 'in' }, { id: 'e2', from: 'n2', fromPort: 'out', to: 'n3', toPort: 'in' }];
  const flow = (await api(page, 'POST', '/api/flows', { name: 'Costly flow', nodes, edges })).json.flow;
  // Use the free plan's credits up with real runs, one at a time. The end is either a refused start (402) or a card that cannot be paid for.
  let outcome = null;
  for (let i = 0; i < 60 && !outcome; i++) {
    const r = await api(page, 'POST', `/api/flows/${flow.id}/runs`, {});
    if (r.status === 402) { outcome = { code: r.json.code, message: r.json.error }; break; }
    expect(r.status).toBe(202);
    for (let k = 0; k < 200; k++) {
      const s = await api(page, 'GET', '/api/runs/' + r.json.run.id);
      if (s.json.run.status !== 'running') { if (s.json.run.error_code === 'credits_exhausted') outcome = { code: s.json.run.error_code, message: s.json.run.error }; break; }
      await page.waitForTimeout(100);
    }
  }
  expect(outcome, 'credits eventually run out').not.toBeNull();
  expect(outcome.code).toBe('credits_exhausted');
  expect(outcome.message).toMatch(/credits/i);
  expect(outcome.message).toMatch(/Plus|upgrade|credits/i);

  await page.goto('/app/builder.html?id=' + flow.id);
  await page.waitForSelector('.cv-node');
  await page.getByRole('button', { name: 'Run this flow' }).click();
  await expect(page.locator('#drawer-body, .drawer, body').first()).toContainText(/credits/i, { timeout: 20000 });
  await expect(page.getByRole('button', { name: 'Run this flow' })).toBeEnabled({ timeout: 20000 });
  // The failed attempt is in the history with its reason, and nothing is left running.
  const runs = (await api(page, 'GET', '/api/runs')).json.runs;
  expect(runs.every(r => r.status !== 'running')).toBe(true);
  expect(runs.some(r => r.status === 'failed' && r.error_code === 'credits_exhausted')).toBe(true);
});
