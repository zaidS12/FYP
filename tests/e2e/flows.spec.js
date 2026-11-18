'use strict';
const fs = require('node:fs');
const { test, expect } = require('@playwright/test');
const { login, loginOk, logout, api } = require('./helpers');

test.describe.configure({ mode: 'serial' });

const row = (page, name) => page.locator('tbody tr', { hasText: name });

test('flows page: create a flow, rename it, duplicate it, share it and delete the copy', async ({ page }) => {
  await loginOk(page, 'ana@agentflow.com');
  await expect(page.locator('.card.section', { hasText: 'credits used' })).toBeVisible();
  await page.getByRole('button', { name: 'New flow' }).click();
  const dlg = page.getByRole('dialog');
  await dlg.getByLabel('Flow name').fill('E2E Digest');
  await dlg.getByRole('button', { name: 'Create flow and open builder' }).click();
  await expect(page).toHaveURL(/builder\.html\?id=/);
  await page.goto('/app/flows.html');
  await expect(row(page, 'E2E Digest')).toContainText('Private');
  await page.getByRole('button', { name: 'Rename E2E Digest' }).click();
  await page.getByRole('dialog').getByLabel('Flow name').fill('E2E Digest v2');
  await page.getByRole('dialog').getByRole('button', { name: 'Save name' }).click();
  await expect(row(page, 'E2E Digest v2')).toBeVisible();
  await page.getByRole('button', { name: 'Duplicate E2E Digest v2' }).click();
  await expect(row(page, 'E2E Digest v2 (copy)')).toBeVisible();
  await page.getByRole('button', { name: 'Share with company E2E Digest v2', exact: true }).click();
  await expect(row(page, 'E2E Digest v2').first()).toContainText('Shared with company');
  await page.getByRole('button', { name: 'Delete E2E Digest v2 (copy)' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Delete flow' }).click();
  await expect(row(page, 'E2E Digest v2 (copy)')).toHaveCount(0);
});

test('PRIVATE vs SHARED: a colleague sees a flow only after it is shared', async ({ page }) => {
  await loginOk(page, 'ana@agentflow.com');
  await api(page, 'POST', '/api/flows', { name: 'Secret plan' });
  await logout(page);
  await loginOk(page, 'omar@agentflow.com');
  await expect(page.locator('#host')).toContainText('E2E Digest v2');
  await expect(page.locator('#host')).not.toContainText('Secret plan');
  await logout(page);
  await loginOk(page, 'admin@agentflow.com');
  await page.goto('/app/flows.html');
  await expect(page.locator('#host')).toContainText('Secret plan');
});

test('search and filter narrow the list', async ({ page }) => {
  await loginOk(page, 'ana@agentflow.com');
  await page.getByLabel('Search flows').fill('digest');
  await expect(row(page, 'Daily AI news digest')).toBeVisible();
  await expect(row(page, 'Competitor research report')).toHaveCount(0);
  await page.getByLabel('Search flows').fill('');
  await page.getByLabel('Show').selectOption('mine');
  await expect(row(page, 'Competitor research report')).toHaveCount(0);
});

test('templates: use one and a private copy is created', async ({ page }) => {
  await loginOk(page, 'ana@agentflow.com');
  await page.goto('/app/templates.html');
  await expect(page.getByRole('heading', { name: 'Daily AI news digest' })).toBeVisible();
  await page.getByRole('button', { name: 'Use template Quick summary' }).click();
  const dlg = page.getByRole('dialog');
  await dlg.getByLabel('Name your flow').fill('My quick summary');
  await dlg.getByRole('button', { name: 'Create my flow' }).click();
  await expect(page).toHaveURL(/builder\.html\?id=/);
  await page.goto('/app/flows.html');
  await expect(row(page, 'My quick summary')).toBeVisible();
});

test('import a flow from a JSON file', async ({ page }) => {
  await loginOk(page, 'ana@agentflow.com');
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.getByRole('button', { name: 'Import flow (JSON)' }).click()]);
  const flow = { format: 'agentflow-flow', version: 1, flow: { name: 'Imported by e2e', nodes: [{ id: 'n1', type: 'start', label: 'Start', x: 0, y: 0, config: {} }, { id: 'n2', type: 'end', label: 'End', x: 200, y: 0, config: {} }], edges: [{ id: 'e1', from: 'n1', to: 'n2' }] } };
  await chooser.setFiles({ name: 'flow.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(flow)) });
  await expect(page).toHaveURL(/builder\.html\?id=/);
  await page.goto('/app/flows.html');
  await expect(row(page, 'Imported by e2e')).toBeVisible();
  const [chooser2] = await Promise.all([page.waitForEvent('filechooser'), page.getByRole('button', { name: 'Import flow (JSON)' }).click()]);
  await chooser2.setFiles({ name: 'bad.json', mimeType: 'application/json', buffer: Buffer.from('{"nothing":true}') });
  await expect(page.locator('.toast.is-error')).toContainText('not an AgentFlow flow');
});

test('super admin sees every flow but cannot create or change them', async ({ page }) => {
  await loginOk(page, 'super@agentflow.com');
  await page.goto('/app/flows.html');
  await expect(page.getByRole('button', { name: 'New flow' })).toHaveCount(0);
  await expect(page.locator('#host')).toContainText('Freight rate watch');
  await expect(page.getByRole('button', { name: /Delete/ })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'View Freight rate watch' })).toBeVisible();
});

test('account: change name, change password, switch theme, see devices', async ({ page }) => {
  await loginOk(page, 'lina@agentflow.com');
  await page.goto('/app/account.html');
  await expect(page.locator('.kv')).toContainText('lina@agentflow.com');
  await expect(page.getByText('Credits are shared by everyone in your company')).toBeVisible();
  await page.getByRole('button', { name: 'Change password' }).click();
  let dlg = page.getByRole('dialog');
  await dlg.getByLabel('Current password').fill('AgentFlow#2026');
  await dlg.getByLabel('New password', { exact: true }).fill('Fresh#Pass4');
  await dlg.getByLabel('Repeat the new password').fill('Different#1');
  await dlg.getByRole('button', { name: 'Change password' }).click();
  await expect(dlg).toContainText('do not match');
  await dlg.getByLabel('Repeat the new password').fill('Fresh#Pass4');
  await dlg.getByRole('button', { name: 'Change password' }).click();
  await expect(page.locator('.toast', { hasText: 'Password changed' })).toBeVisible();
  await page.getByRole('button', { name: 'Dark mode', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(page.getByRole('cell', { name: /Chrome/ }).first()).toBeVisible();
  await logout(page);
  await login(page, 'lina@agentflow.com', 'AgentFlow#2026');
  await expect(page.locator('#login-error')).toContainText('incorrect');
  await loginOk(page, 'lina@agentflow.com', 'Fresh#Pass4');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
});

test('individual: upgrade to Plus with a card, see the invoice, then switch back to Free', async ({ page }) => {
  await loginOk(page, 'solo@example.com');
  await page.goto('/app/account.html');
  await expect(page.getByText(/of 100 credits used/)).toBeVisible();
  await page.getByRole('button', { name: /Upgrade to Plus and pay \$12 today/ }).click();
  const dlg = page.getByRole('dialog');
  await dlg.getByLabel('Name on card').fill('Sol Individual');
  await dlg.getByLabel('Card number').fill('4242 4242 4242 4242');
  await dlg.getByLabel(/Expiry/).fill('12/99');
  await dlg.getByLabel('Security code').fill('123');
  await dlg.getByRole('button', { name: /Pay \$12 and upgrade/ }).click();
  await page.getByRole('dialog', { name: /Invoice INV-/ }).getByRole('button', { name: 'Close' }).click();
  await expect(page.getByText(/of 1,000 credits used/)).toBeVisible();
  await expect(page.locator('.plan.is-current')).toContainText('Plus');
  await expect(page.getByRole('button', { name: /View invoice INV-/ })).toBeVisible();
  await page.getByRole('button', { name: 'Switch to Free' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Switch plan' }).click();
  await expect(page.getByText(/of 100 credits used/)).toBeVisible();
});

test('an employee sees no plan or billing controls on the account page', async ({ page }) => {
  await loginOk(page, 'omar@agentflow.com');
  await page.goto('/app/account.html');
  await expect(page.getByRole('button', { name: /Upgrade/ })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Your plan' })).toHaveCount(0);
  void fs;
});
