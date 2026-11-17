'use strict';
const { test, expect } = require('@playwright/test');
const { loginOk, api } = require('./helpers');

test.describe.configure({ mode: 'serial' });

async function openNew(page, name) {
  await page.goto('/app/flows.html');
  await page.getByRole('button', { name: 'New flow' }).click();
  await page.getByRole('dialog').getByLabel('Flow name').fill(name);
  await page.getByRole('dialog').getByRole('button', { name: 'Create flow and open builder' }).click();
  await page.waitForURL(/builder\.html\?id=/);
  await page.waitForSelector('.cv-node');
}

test('running a flow in the builder shows the result, and the run is kept in history', async ({ page }) => {
  await loginOk(page, 'ana@brightloom.test');
  await openNew(page, 'Run walkthrough');
  await page.getByRole('button', { name: /^Add Summarize card/ }).click();
  await expect(page.locator('.cv-node')).toHaveCount(3);
  // Summarize is not connected yet: Run must refuse and point at the problem instead of starting.
  await page.getByRole('button', { name: 'Run this flow' }).click();
  await expect(page.locator('.run-head')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await page.locator('.cv-node').filter({ hasText: 'Summarize' }).click();
  // A plain Start -> End flow runs fine.
  await page.keyboard.press('Delete');
  await expect(page.locator('.cv-node')).toHaveCount(2);
  await page.getByRole('button', { name: 'Run this flow' }).click();
  await expect(page.locator('.run-head')).toContainText('credits', { timeout: 15000 });
  await expect(page.getByRole('button', { name: 'Run this flow' })).toBeEnabled({ timeout: 15000 });

  await page.goto('/app/runs.html');
  await expect(page.getByRole('link', { name: 'Run walkthrough' }).first()).toBeVisible();
  await page.getByRole('button', { name: /^Details of the run of Run walkthrough/ }).first().click();
  await expect(page.getByRole('dialog')).toContainText('Steps');
  await page.getByRole('dialog').getByRole('button', { name: 'Close' }).click();
  await page.getByLabel('Search runs by flow name').fill('no such flow anywhere');
  await page.getByLabel('Search runs by flow name').press('Enter');
  await expect(page.getByText('No runs match')).toBeVisible();
});

test('a run is private to its owner and company admin; other companies and super admins cannot touch it', async ({ page }) => {
  await loginOk(page, 'ana@brightloom.test');
  const flows = await api(page, 'GET', '/api/flows');
  const flow = flows.json.flows.find(f => f.name === 'Run walkthrough');
  const started = await api(page, 'POST', `/api/flows/${flow.id}/runs`, {});
  expect(started.status).toBe(202);
  const runId = started.json.run.id;
  expect((await api(page, 'GET', `/api/runs/${runId}`)).status).toBe(200);

  const check = async (email, method, url, status) => {
    await page.context().clearCookies(); await loginOk(page, email);
    expect((await api(page, method, url, method === 'POST' ? {} : undefined)).status).toBe(status);
  };
  await check('solo@example.test', 'GET', `/api/runs/${runId}`, 404);
  await check('solo@example.test', 'POST', `/api/flows/${flow.id}/runs`, 404);
  await check('omar@brightloom.test', 'GET', `/api/runs/${runId}`, 404);
  await check('admin@brightloom.test', 'GET', `/api/runs/${runId}`, 200);
  await check('super@agentflow.test', 'POST', `/api/flows/${flow.id}/runs`, 403);
});
