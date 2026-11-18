'use strict';
const { test, expect } = require('@playwright/test');
const { loginOk, api } = require('./helpers');

test.describe.configure({ mode: 'serial' });

test('history lists versions, restore makes a new version and keeps the old ones', async ({ page }) => {
  await loginOk(page, 'ana@agentflow.com');
  await page.goto('/app/flows.html');
  await page.getByRole('button', { name: 'New flow' }).click();
  await page.getByRole('dialog').getByLabel('Flow name').fill('Restore walkthrough');
  await page.getByRole('dialog').getByRole('button', { name: 'Create flow and open builder' }).click();
  await page.waitForURL(/builder\.html\?id=/);
  await page.waitForSelector('.cv-node');
  await expect(page.locator('.cv-node')).toHaveCount(2);
  await page.getByRole('button', { name: /^Add Summarize card/ }).click();
  await expect(page.locator('.cv-node')).toHaveCount(3);
  await page.keyboard.press('Control+s');
  await expect(page.locator('#ver-pill')).toHaveText('v2');

  await page.getByRole('button', { name: 'History' }).click();
  const panel = page.locator('#hist-panel');
  await expect(panel.locator('.hist-item')).toHaveCount(2);
  await expect(panel.locator('.hist-item').first()).toContainText('Current');
  await expect(panel.locator('.hist-item').first()).toContainText('Ana Torres');
  await expect(panel.locator('.hist-item').first()).toContainText('Added 1 card');

  await panel.getByRole('button', { name: 'Restore version 1' }).click();
  await expect(page.locator('#ver-pill')).toHaveText('v3');
  await expect(page.locator('.cv-node')).toHaveCount(2);
  await expect(panel.locator('.hist-item')).toHaveCount(3);
  await expect(panel.locator('.hist-item').first()).toContainText('Restore of v1');
  await expect(panel.locator('.hist-item').nth(1)).toContainText('Added 1 card'); // v2 is still there, untouched

  // Reopen: the restored content is what was saved.
  await page.reload();
  await page.waitForSelector('.cv-node');
  await expect(page.locator('.cv-node')).toHaveCount(2);
  await expect(page.locator('#ver-pill')).toHaveText('v3');
});

test('a save made while signed in as someone else shows who really did it', async ({ page }) => {
  await loginOk(page, 'super@agentflow.com');
  expect((await api(page, 'POST', '/api/impersonation/start', { user_id: 'u_bl_ana' })).status).toBe(200);
  const made = await api(page, 'POST', '/api/flows', { name: 'Support edit' });
  const id = made.json.flow.id;
  const saved = await api(page, 'PATCH', '/api/flows/' + id, { name: 'Support edit 2', base_version: 1 });
  expect(saved.status).toBe(200);
  await page.goto('/app/builder.html?id=' + id);
  await page.waitForSelector('.cv-node');
  await page.getByRole('button', { name: 'History' }).click();
  await expect(page.locator('#hist-panel .hist-item').first()).toContainText(/\(as Ana Torres\)/);
  await page.locator('.imp-banner').getByRole('button', { name: 'Return to my account' }).click();
  await page.waitForURL(/super\/dashboard\.html/);
});

test('people who can only look cannot restore', async ({ page }) => {
  await loginOk(page, 'super@agentflow.com');
  await page.goto('/app/builder.html?id=f_news');
  await page.waitForSelector('.cv-node');
  await page.getByRole('button', { name: 'History' }).click();
  await expect(page.locator('#hist-panel .hist-item').first()).toBeVisible();
  await expect(page.getByRole('button', { name: /^Restore version/ })).toHaveCount(0);
});
