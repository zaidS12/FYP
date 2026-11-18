'use strict';
const { test, expect } = require('@playwright/test');
const { login, loginOk, api, logout } = require('./helpers');

const ROLES = [
  ['super@agentflow.com', 'Platform Admin', 'Super Admin'],
  ['admin@agentflow.com', 'Maya Hussain', 'Company Admin'],
  ['ana@agentflow.com', 'Ana Torres', 'Employee'],
  ['solo@example.com', 'Sol Individual', 'Individual (Free)'],
];

for (const [email, name, roleLabel] of ROLES) {
  test(`login works for ${roleLabel}`, async ({ page }) => {
    await loginOk(page, email);
    await expect(page.locator('.user-btn .name')).toHaveText(name);
    expect((await api(page, 'GET', '/api/auth/me')).status).toBe(200);
    await page.click('.user-btn');
    await expect(page.locator('.menu .badge')).toHaveText(roleLabel);
    await page.click('.menu button');
    await page.waitForURL(/index\.html$/);
    expect((await api(page, 'GET', '/api/auth/me')).status).toBe(401);
  });
}

test('wrong password shows a generic, fixable error and stays on the login page', async ({ page }) => {
  await login(page, 'ana@agentflow.com', 'Wrong-pass1');
  await expect(page.locator('#login-error')).toContainText('Email or password is incorrect.');
  await expect(page.locator('#email')).toHaveAttribute('aria-invalid', 'true');
});

test('a frozen company and a frozen employee are told clearly why they cannot sign in', async ({ page }) => {
  await login(page, 'admin@kestrel.com');
  await expect(page.locator('#login-error')).toContainText('Kestrel Freight is frozen');
  await login(page, 'dev.frozen@agentflow.com');
  await expect(page.locator('#login-error')).toContainText('This account is frozen');
});

test('protected pages send anonymous visitors to the login page and back after sign-in', async ({ page }) => {
  await page.goto('/app/flows.html');
  await expect(page).toHaveURL(/index\.html\?next=app%2Fflows\.html/);
  await page.fill('#email', 'ana@agentflow.com');
  await page.fill('#password', 'AgentFlow#2026');
  await page.click('#login-submit');
  await expect(page).toHaveURL(/app\/flows\.html$/);
});

test('TENANT ISOLATION through the UI: each account only sees its own flows', async ({ page }) => {
  await loginOk(page, 'ana@agentflow.com');
  await expect(page.locator('#host')).toContainText('Daily AI news digest');
  await expect(page.locator('#host')).not.toContainText('Freight rate watch');
  await expect(page.locator('#host')).not.toContainText('Summarize my reading list');
  await expect(page.locator('#host')).not.toContainText('Translate announcement to Urdu');
  await logout(page);
  await loginOk(page, 'solo@example.com');
  await expect(page.locator('#host')).toContainText('Summarize my reading list');
  await expect(page.locator('#host')).not.toContainText('Daily AI news digest');
  await logout(page);
  await loginOk(page, 'super@agentflow.com');
  await page.goto('/app/flows.html');
  await expect(page.locator('#host')).toContainText('Freight rate watch');
  await expect(page.locator('#host')).toContainText('Daily AI news digest');
});

test('TENANT ISOLATION through direct API calls with another tenant id', async ({ page }) => {
  await loginOk(page, 'ana@agentflow.com');
  expect((await api(page, 'GET', '/api/users')).status).toBe(403);
  const flows = await api(page, 'GET', '/api/flows?tenant_id=t_kestrel');
  expect(flows.json.flows.every(f => f.tenant_id === 't_brightloom')).toBe(true);
  await logout(page);
  await loginOk(page, 'admin@agentflow.com');
  expect((await api(page, 'PATCH', '/api/users/u_ke_sam', { name: 'Hacked' })).status).toBe(404);
  expect((await api(page, 'POST', '/api/users/u_ke_sam/freeze', {})).status).toBe(404);
  const made = await api(page, 'POST', '/api/users?tenant_id=t_kestrel', { name: 'Cross Tenant', email: 'cross.tenant@x.test', tenant_id: 't_kestrel', role: 'admin' });
  expect(made.json.user.tenant_id).toBe('t_brightloom');
  expect(made.json.user.role).toBe('employee');
});
