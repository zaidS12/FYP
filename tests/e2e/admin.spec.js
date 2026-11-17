'use strict';
const fs = require('node:fs');
const { test, expect } = require('@playwright/test');
const { login, loginOk, logout, api } = require('./helpers');

test.describe.configure({ mode: 'serial' });

const ADMIN = 'bill@billing-co.test';
let adminPw;

async function asAdmin(page) { await loginOk(page, ADMIN, adminPw); }
async function fillCard(dlg, number = '4242 4242 4242 4242') {
  await dlg.getByLabel('Name on card').fill('Bill Admin');
  await dlg.getByLabel('Card number').fill(number);
  await dlg.getByLabel(/Expiry/).fill('12/99');
  await dlg.getByLabel('Security code').fill('123');
}

test('setup: the super admin creates a company for these tests', async ({ page }) => {
  await loginOk(page, 'super@agentflow.test');
  const r = await api(page, 'POST', '/api/tenants', { name: 'Billing Co', plan_id: 'basic', admin_name: 'Bill Admin', admin_email: ADMIN });
  expect(r.status).toBe(201);
  adminPw = r.json.temp_password;
});

test('admin dashboard lands first and shows seats, credits and the company name', async ({ page }) => {
  await asAdmin(page);
  await expect(page).toHaveURL(/admin\/dashboard\.html$/);
  await expect(page.locator('#title')).toHaveText('Billing Co');
  await expect(page.locator('.stat', { hasText: 'Seats used' }).locator('b')).toHaveText('1 / 10');
  await expect(page.getByRole('link', { name: 'Employees' })).toBeVisible();
});

test('employees: add, reset password, freeze and unfreeze through the UI', async ({ page }) => {
  await asAdmin(page);
  await page.goto('/admin/employees.html');
  await page.getByRole('button', { name: 'Add an employee' }).click();
  let dlg = page.getByRole('dialog');
  await dlg.getByLabel('Full name').fill('Erin Employee');
  await dlg.getByLabel(/Email/).fill('erin@billing-co.test');
  await dlg.getByRole('button', { name: 'Create account' }).click();
  const secret = page.getByRole('dialog', { name: /Temporary password for Erin/ });
  const erinPw = await secret.getByRole('textbox', { name: 'Temporary password' }).inputValue();
  await secret.getByRole('button', { name: 'Done' }).click();
  await expect(page.locator('td .cell-strong', { hasText: 'Erin Employee' })).toBeVisible();
  await expect(page.getByText('2 of 10 seats used')).toBeVisible();
  await page.getByRole('button', { name: 'Reset password Erin Employee' }).click();
  dlg = page.getByRole('dialog');
  await dlg.getByRole('button', { name: 'Reset password' }).click();
  await page.getByRole('dialog', { name: /Temporary password for Erin/ }).getByRole('button', { name: 'Done' }).click();
  await page.getByRole('button', { name: 'Freeze Erin Employee' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Freeze account' }).click();
  await expect(page.getByRole('button', { name: 'Unfreeze Erin Employee' })).toBeVisible();
  await logout(page);
  await login(page, 'erin@billing-co.test', erinPw);
  await expect(page.locator('#login-error')).toContainText('incorrect');
  await asAdmin(page);
  await page.goto('/admin/employees.html');
  await page.getByRole('button', { name: 'Unfreeze Erin Employee' }).click();
  await expect(page.getByRole('button', { name: 'Freeze Erin Employee' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Delete Bill Admin' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Freeze Bill Admin' })).toHaveCount(0);
});

test('SEAT LIMIT: the 11th account is refused with a message that says how to fix it', async ({ page }) => {
  await asAdmin(page);
  for (let i = 0; i < 8; i++) expect((await api(page, 'POST', '/api/users', { name: 'Filler ' + i, email: `filler${i}@billing-co.test` })).status).toBe(201);
  await page.goto('/admin/employees.html');
  await expect(page.getByText('10 of 10 seats used')).toBeVisible();
  await expect(page.locator('.notice.is-warn')).toContainText('All 10 seats are used');
  await page.getByRole('button', { name: 'Add an employee' }).click();
  const dlg = page.getByRole('dialog');
  await dlg.getByLabel('Full name').fill('Too Many');
  await dlg.getByLabel(/Email/).fill('toomany@billing-co.test');
  await dlg.getByRole('button', { name: 'Create account' }).click();
  await expect(dlg.locator('.alert')).toContainText('used all 10 seats');
  await expect(dlg.locator('.alert')).toContainText('upgrade');
});

test('billing: buying seats handles bad, declined and good cards, then issues an invoice', async ({ page }) => {
  await asAdmin(page);
  await page.goto('/admin/billing.html');
  await expect(page.locator('.stat', { hasText: 'Current plan' }).locator('b')).toHaveText('Basic');
  await page.getByRole('button', { name: 'Buy extra seats' }).click();
  let dlg = page.getByRole('dialog');
  await dlg.getByLabel('Number of extra seats').fill('3');
  await fillCard(dlg, '1234 5678');
  await dlg.getByRole('button', { name: 'Pay and add seats' }).click();
  await expect(dlg).toContainText('Enter the card number exactly as printed');
  await fillCard(dlg, '4000 0000 0000 0002');
  await dlg.getByRole('button', { name: 'Pay and add seats' }).click();
  await expect(dlg.locator('.alert')).toContainText('declined');
  await fillCard(dlg, '4242 4242 4242 4242');
  await dlg.getByRole('button', { name: 'Pay and add seats' }).click();
  const inv = page.getByRole('dialog', { name: /Invoice INV-/ });
  await expect(inv).toContainText('$24');
  await expect(inv.getByRole('button', { name: 'Print or save as PDF' })).toBeVisible();
  await inv.getByRole('button', { name: 'Close' }).click();
  await expect(page.locator('.stat', { hasText: 'Seats used' }).locator('b')).toHaveText('10 / 13');
  await expect(page.getByRole('cell', { name: 'Visa •••• 4242' }).first()).toBeVisible();
  await expect(page.getByRole('cell', { name: 'Failed' })).toHaveCount(1);
  await page.goto('/admin/employees.html');
  await page.getByRole('button', { name: 'Add an employee' }).click();
  dlg = page.getByRole('dialog');
  await dlg.getByLabel('Full name').fill('Now Fits');
  await dlg.getByLabel(/Email/).fill('nowfits@billing-co.test');
  await dlg.getByRole('button', { name: 'Create account' }).click();
  await page.getByRole('dialog', { name: /Temporary password for Now/ }).getByRole('button', { name: 'Done' }).click();
  await expect(page.getByText('11 of 13 seats used')).toBeVisible();
});

test('billing: upgrade to Pro charges the difference; downgrade is free and keeps bought seats', async ({ page }) => {
  await asAdmin(page);
  await page.goto('/admin/billing.html');
  await page.getByRole('button', { name: /Upgrade to Pro and pay \$150 today/ }).click();
  const dlg = page.getByRole('dialog');
  await fillCard(dlg);
  await dlg.getByRole('button', { name: /Pay \$150 and upgrade/ }).click();
  await page.getByRole('dialog', { name: /Invoice INV-/ }).getByRole('button', { name: 'Close' }).click();
  await expect(page.locator('.stat', { hasText: 'Current plan' }).locator('b')).toHaveText('Pro');
  await expect(page.locator('.plan.is-current')).toContainText('Pro');
  await page.getByRole('button', { name: 'Switch to Basic (no charge)' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Switch plan' }).click();
  await expect(page.locator('.toast', { hasText: 'Plan changed to Basic.' })).toBeVisible();
  await expect(page.locator('.stat', { hasText: 'Current plan' }).locator('b')).toHaveText('Basic');
  await expect(page.locator('.stat', { hasText: 'Seats used' }).locator('b')).toHaveText('11 / 13');
});

test('invoices can be viewed from the list', async ({ page }) => {
  await asAdmin(page);
  await page.goto('/admin/billing.html');
  await page.getByRole('button', { name: /View invoice INV-/ }).first().click();
  const dlg = page.getByRole('dialog', { name: /Invoice INV-/ });
  await expect(dlg).toContainText('Billing Co');
  await expect(dlg).toContainText('Total:');
  await page.keyboard.press('Escape');
  await expect(dlg).toBeHidden();
});

test('activity shows devices, browsers, sign-ins and the audit log of this company only', async ({ page }) => {
  await asAdmin(page);
  await page.goto('/admin/activity.html');
  await expect(page.getByRole('cell', { name: /Chrome/ }).first()).toBeVisible();
  await expect(page.getByText('Bill Admin').first()).toBeVisible();
  await expect(page.getByRole('cell', { name: 'billing.seats_purchased' }).first()).toBeVisible();
  await expect(page.getByText('Brightloom')).toHaveCount(0);
  await page.getByLabel('Show sign-ins for').selectOption({ label: 'Erin Employee' });
  await expect(page.getByRole('cell', { name: 'Wrong password' }).first()).toBeVisible();
});

test('company backup: export downloads this company only, import adds private copies', async ({ page }) => {
  await asAdmin(page);
  await page.goto('/admin/dashboard.html');
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Export company data (JSON)' }).click()]);
  const bundle = JSON.parse(fs.readFileSync(await download.path(), 'utf8'));
  expect(bundle.format).toBe('agentflow-tenant');
  expect(JSON.stringify(bundle)).not.toContain('password_hash');
  bundle.data.flows = [{ name: 'Imported sample', nodes: [{ id: 'n1', type: 'start', label: 'Start', x: 0, y: 0, config: {} }], edges: [] }];
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.getByRole('button', { name: 'Import company data (JSON)' }).click()]);
  await chooser.setFiles({ name: 'company.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(bundle)) });
  await page.getByRole('dialog').getByRole('button', { name: 'Import flows' }).click();
  await expect(page.locator('.toast', { hasText: '1 flow imported' })).toBeVisible();
  await page.goto('/app/flows.html');
  await expect(page.locator('#host')).toContainText('Imported sample');
});

test('employees cannot open admin pages and admins cannot open super admin pages', async ({ page }) => {
  await loginOk(page, 'ana@brightloom.test');
  for (const p of ['/admin/employees.html', '/admin/billing.html', '/admin/activity.html', '/admin/dashboard.html']) {
    await page.goto(p);
    await expect(page).toHaveURL(/app\/flows\.html$/);
  }
  await logout(page);
  await asAdmin(page);
  await page.goto('/super/payments.html');
  await expect(page).toHaveURL(/admin\/dashboard\.html$/);
});
