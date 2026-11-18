'use strict';
const { test, expect } = require('@playwright/test');
const { login, loginOk, logout, api } = require('./helpers');

test.describe.configure({ mode: 'serial' });

let companyAdminEmail; let companyAdminPassword;

test('super admin dashboard shows platform numbers and what needs attention', async ({ page }) => {
  await loginOk(page, 'super@agentflow.com');
  await expect(page).toHaveURL(/super\/dashboard\.html$/);
  await expect(page.locator('.stat', { hasText: 'Active companies' })).toBeVisible();
  await expect(page.locator('.stat', { hasText: 'Frozen companies' }).locator('b')).toHaveText('1');
  await expect(page.getByRole('link', { name: 'Kestrel Freight' })).toBeVisible();
  await expect(page.locator('.chart-bars')).toBeVisible();
});

test('create a company, hand over the temporary password, and the new admin can sign in', async ({ page }) => {
  await loginOk(page, 'super@agentflow.com');
  await page.goto('/super/tenants.html');
  await expect(page.getByRole('link', { name: 'Brightloom Studio' })).toBeVisible();
  await page.getByRole('button', { name: 'New company' }).first().click();
  const dlg = page.getByRole('dialog');
  await dlg.getByLabel('Company name').fill('E2E Company');
  await dlg.getByLabel('First admin: full name').fill('Eve Admin');
  await dlg.getByLabel('First admin: email').fill('eve@e2e-company.test');
  await dlg.getByRole('button', { name: 'Create company' }).click();
  const secret = page.getByRole('dialog', { name: 'First admin password' });
  await expect(secret).toBeVisible();
  companyAdminEmail = 'eve@e2e-company.test';
  companyAdminPassword = await secret.getByRole('textbox', { name: 'Temporary password' }).inputValue();
  expect(companyAdminPassword).toMatch(/^[A-Za-z0-9]{12}$/);
  await secret.getByRole('button', { name: 'Done' }).click();
  await expect(page.getByRole('link', { name: 'E2E Company' })).toBeVisible();
  await logout(page);
  await loginOk(page, companyAdminEmail, companyAdminPassword);
  await expect(page.locator('.workspace b')).toHaveText('E2E Company');
});

test('validation errors explain how to fix the form', async ({ page }) => {
  await loginOk(page, 'super@agentflow.com');
  await page.goto('/super/tenants.html');
  await page.getByRole('button', { name: 'New company' }).first().click();
  const dlg = page.getByRole('dialog');
  await dlg.getByLabel('Company name').fill('Brightloom Studio');
  await dlg.getByLabel('First admin: full name').fill('Dup');
  await dlg.getByLabel('First admin: email').fill('dup@x.test');
  await dlg.getByRole('button', { name: 'Create company' }).click();
  await expect(dlg).toContainText('This company name is taken.');
  await page.keyboard.press('Escape');
  await expect(dlg).toBeHidden();
});

test('freeze and unfreeze a company: its admin is told why, then can sign in again', async ({ page }) => {
  await loginOk(page, 'super@agentflow.com');
  await page.goto('/super/tenants.html');
  await page.getByRole('link', { name: 'E2E Company' }).click();
  await expect(page.locator('#title')).toHaveText('E2E Company');
  await page.getByRole('button', { name: 'Freeze company' }).click();
  const dlg = page.getByRole('dialog');
  await dlg.getByLabel(/Reason/).fill('Payment dispute');
  await dlg.getByRole('button', { name: 'Freeze company' }).click();
  await expect(page.locator('.notice.is-danger')).toContainText('Payment dispute');
  await logout(page);
  await login(page, companyAdminEmail, companyAdminPassword);
  await expect(page.locator('#login-error')).toContainText('E2E Company is frozen');
  await loginOk(page, 'super@agentflow.com');
  await page.goto('/super/tenants.html');
  await page.getByRole('link', { name: 'E2E Company' }).click();
  await page.getByRole('button', { name: 'Unfreeze company' }).click();
  await expect(page.getByRole('button', { name: 'Freeze company' })).toBeVisible();
  await logout(page);
  await loginOk(page, companyAdminEmail, companyAdminPassword);
});

test('change plan and seats, add an account, reset its password, freeze and delete it', async ({ page }) => {
  await loginOk(page, 'super@agentflow.com');
  await page.goto('/super/tenants.html');
  await page.getByRole('link', { name: 'E2E Company' }).click();
  await page.getByRole('button', { name: 'Change plan or seats' }).click();
  let dlg = page.getByRole('dialog');
  await dlg.getByLabel('Plan').selectOption('pro');
  await dlg.getByLabel('Extra seats').fill('2');
  await dlg.getByRole('button', { name: 'Save plan' }).click();
  await expect(page.locator('.stat', { hasText: 'Seats used' }).locator('b')).toHaveText('1 / 32');
  await page.getByRole('button', { name: 'Add an account' }).click();
  dlg = page.getByRole('dialog');
  await dlg.getByLabel('Role').selectOption('employee');
  await dlg.getByLabel('Full name').fill('Evan Employee');
  await dlg.getByLabel(/Email/).fill('evan@e2e-company.test');
  await dlg.getByRole('button', { name: 'Create account' }).click();
  await page.getByRole('dialog', { name: /Temporary password for Evan/ }).getByRole('button', { name: 'Done' }).click();
  const evan = page.locator('td .cell-strong', { hasText: 'Evan Employee' });
  await expect(evan).toBeVisible();
  await page.getByRole('button', { name: 'Reset password Evan Employee' }).click();
  dlg = page.getByRole('dialog');
  await dlg.getByLabel(/New password/).fill('Chosen#Pass9');
  await dlg.getByRole('button', { name: 'Reset password' }).click();
  await page.getByRole('button', { name: 'Freeze Evan Employee' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Freeze account' }).click();
  await expect(page.getByRole('button', { name: 'Unfreeze Evan Employee' })).toBeVisible();
  await page.getByRole('button', { name: 'Delete Evan Employee' }).click();
  dlg = page.getByRole('dialog');
  const confirm = dlg.getByRole('button', { name: 'Delete account' });
  await confirm.click();
  await expect(dlg).toBeVisible();
  await dlg.getByRole('textbox').fill('evan@e2e-company.test');
  await confirm.click();
  await expect(evan).toHaveCount(0);
});

test('payments and audit pages show money and who did what, with filters', async ({ page }) => {
  await loginOk(page, 'super@agentflow.com');
  await page.goto('/super/payments.html');
  await expect(page.locator('.stat.is-bad')).toContainText('Overdue');
  await page.getByLabel('Filter by company').selectOption({ label: 'Kestrel Freight' });
  await expect(page.getByRole('cell', { name: 'INV-2026-0007' })).toBeVisible();
  await expect(page.getByRole('cell', { name: 'INV-2026-0003' })).toHaveCount(0);
  await page.goto('/super/audit.html');
  await expect(page.getByRole('cell', { name: 'tenant.create' }).first()).toBeVisible();
  await page.getByLabel('Filter by action').selectOption('tenant.freeze');
  await expect(page.getByRole('cell', { name: 'tenant.freeze' }).first()).toBeVisible();
  await expect(page.getByRole('cell', { name: 'user.create' })).toHaveCount(0);
});

test('export the whole database and import it back without losing the sign-in', async ({ page }) => {
  await loginOk(page, 'super@agentflow.com');
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Export database (JSON)' }).click()]);
  expect(download.suggestedFilename()).toMatch(/^agentflow-database-\d{4}-\d{2}-\d{2}\.json$/);
  const fs = require('node:fs');
  const text = fs.readFileSync(await download.path(), 'utf8');
  const bundle = JSON.parse(text);
  expect(bundle.format).toBe('agentflow-db');
  expect(bundle.data.tenants.some(t => t.name === 'E2E Company')).toBe(true);
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.getByRole('button', { name: 'Import database (JSON)' }).click()]);
  await chooser.setFiles({ name: 'backup.json', mimeType: 'application/json', buffer: Buffer.from(text) });
  const dlg = page.getByRole('dialog');
  await dlg.getByRole('textbox').fill('REPLACE');
  await dlg.getByRole('button', { name: 'Replace database' }).click();
  await expect(page.locator('.toast', { hasText: 'Database imported.' })).toBeVisible();
  await page.reload();
  await expect(page.locator('.stat', { hasText: 'Active companies' })).toBeVisible();
  await expect(page.locator('.user-btn .name')).toHaveText('Platform Admin');
  expect((await api(page, 'GET', '/api/auth/me')).status).toBe(200);
});

test('deleting a company needs the exact name typed, then removes it and its people', async ({ page }) => {
  await loginOk(page, 'super@agentflow.com');
  const made = await api(page, 'POST', '/api/tenants', { name: 'Delete Me Co', plan_id: 'basic', admin_name: 'Del Admin', admin_email: 'del@delete-me.test' });
  expect(made.status).toBe(201);
  await page.goto('/super/tenant-detail.html?id=' + made.json.tenant.id);
  await page.getByRole('button', { name: 'Delete company' }).click();
  const dlg = page.getByRole('dialog');
  await expect(dlg.getByRole('textbox')).toBeFocused();
  await dlg.getByRole('textbox').fill('wrong name');
  await dlg.getByRole('button', { name: 'Delete company' }).click();
  await expect(dlg).toBeVisible();
  await dlg.getByRole('textbox').fill('Delete Me Co');
  await dlg.getByRole('button', { name: 'Delete company' }).click();
  await expect(page).toHaveURL(/super\/tenants\.html$/);
  await expect(page.getByRole('link', { name: 'Delete Me Co' })).toHaveCount(0);
  await logout(page);
  await login(page, 'del@delete-me.test', 'whatever1');
  await expect(page.locator('#login-error')).toContainText('incorrect');
});

test('dialogs trap focus and give it back when they close', async ({ page }) => {
  await loginOk(page, 'super@agentflow.com');
  await page.goto('/super/tenants.html');
  const opener = page.getByRole('button', { name: 'New company' }).first();
  await opener.focus(); await opener.press('Enter');
  const dlg = page.getByRole('dialog');
  await expect(dlg.getByLabel('Company name')).toBeFocused();
  for (let i = 0; i < 8; i++) await page.keyboard.press('Tab');
  expect(await page.evaluate(() => !!document.activeElement.closest('[role="dialog"]'))).toBe(true);
  await page.keyboard.press('Escape');
  await expect(dlg).toBeHidden();
  await expect(opener).toBeFocused();
});

test('a bad import file is rejected with a clear message', async ({ page }) => {
  await loginOk(page, 'super@agentflow.com');
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.getByRole('button', { name: 'Import database (JSON)' }).click()]);
  await chooser.setFiles({ name: 'nope.json', mimeType: 'application/json', buffer: Buffer.from('{"format":"something-else"}') });
  const dlg = page.getByRole('dialog');
  await dlg.getByRole('textbox').fill('REPLACE');
  await dlg.getByRole('button', { name: 'Replace database' }).click();
  await expect(page.locator('.toast.is-error')).toContainText('not an AgentFlow database export');
});

test('company admins and employees cannot open super admin pages', async ({ page }) => {
  await loginOk(page, 'ana@agentflow.com');
  await page.goto('/super/dashboard.html');
  await expect(page).toHaveURL(/app\/flows\.html$/);
  await logout(page);
  await loginOk(page, 'admin@agentflow.com');
  await page.goto('/super/tenants.html');
  await expect(page).toHaveURL(/admin\/dashboard\.html$/);
});
