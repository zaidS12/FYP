'use strict';
const { test, expect } = require('@playwright/test');
const { loginOk, api } = require('./helpers');

test.describe.configure({ mode: 'serial' });

const banner = page => page.locator('.imp-banner');

test('super admin enters an employee account, runs a flow there, sees the banner, and returns', async ({ page }) => {
  await loginOk(page, 'super@agentflow.com');
  await page.goto('/super/tenant-detail.html?id=t_brightloom');
  await page.getByRole('button', { name: /^Login as Ana/ }).click();
  await page.waitForURL(/app\/flows\.html/);
  await page.waitForSelector('#shell:not([hidden])');
  await expect(banner(page)).toContainText('is acting as');
  await expect(banner(page)).toContainText('Employee');
  await expect(page.getByRole('link', { name: 'Companies' })).toHaveCount(0); // employee navigation, not super admin
  // Run a flow as the employee; credits go to the employee's company.
  const run = await api(page, 'POST', '/api/flows/f_news/runs', {});
  expect(run.status).toBe(202);
  expect(run.json.run.by_id).toBe('u_super');
  await page.goto('/app/runs.html');
  await expect(banner(page)).toBeVisible();
  await expect(page.getByRole('link', { name: 'Daily AI news digest' }).first()).toBeVisible();
  // Chained "Login as" is refused.
  expect((await api(page, 'POST', '/api/impersonation/start', { user_id: 'u_bl_omar' })).status).toBe(403);
  // Secrets stay protected.
  expect((await api(page, 'POST', '/api/account/password', { current: 'AgentFlow#2026', next: 'Changed#2026ab' })).status).toBe(403);
  const dump = JSON.stringify([(await api(page, 'GET', '/api/account')).json, (await api(page, 'GET', '/api/auth/me')).json]);
  expect(dump).not.toMatch(/scrypt\$|pbkdf2\$|password_hash/);
  await banner(page).getByRole('button', { name: 'Return to my account' }).click();
  await page.waitForURL(/super\/dashboard\.html/);
  await expect(banner(page)).toHaveCount(0);
  // Audit entries exist for start and end.
  const audit = (await api(page, 'GET', '/api/audit?limit=500')).json;
  const entries = audit.entries || audit.audit || [];
  expect(entries.some(e => e.action === 'impersonation.started' && e.target === 'u_bl_ana')).toBe(true);
  expect(entries.some(e => e.action === 'impersonation.ended' && e.target === 'u_bl_ana')).toBe(true);
  expect(entries.some(e => /acting as/.test(e.actor_name))).toBe(true);
});

test('company admin enters their own employee, and is refused for another company by UI and API', async ({ page }) => {
  await loginOk(page, 'admin@agentflow.com');
  await page.goto('/admin/employees.html');
  await expect(page.getByRole('button', { name: /^Login as Omar/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /^Login as Devon/ })).toHaveCount(0); // frozen employee
  await page.getByRole('button', { name: /^Login as Omar/ }).click();
  await page.waitForURL(/app\/flows\.html/);
  await expect(banner(page)).toContainText('Omar');
  await banner(page).getByRole('button', { name: 'Return to my account' }).click();
  await page.waitForURL(/admin\/dashboard\.html/);
  for (const id of ['u_ke_sam', 'u_super', 'u_ke_admin']) {
    expect([403, 404]).toContain((await api(page, 'POST', '/api/impersonation/start', { user_id: id })).status);
  }
  expect((await api(page, 'GET', '/api/auth/me')).json.user.id).toBe('u_bl_admin');
});

test('plain employees have no way to impersonate', async ({ page }) => {
  await loginOk(page, 'ana@agentflow.com');
  expect((await api(page, 'POST', '/api/impersonation/start', { user_id: 'u_bl_omar' })).status).toBe(403);
});

test('super admin may inspect a frozen company; the banner says so', async ({ page }) => {
  await loginOk(page, 'super@agentflow.com');
  expect((await api(page, 'POST', '/api/impersonation/start', { user_id: 'u_ke_sam' })).status).toBe(200);
  await page.goto('/app/flows.html');
  await expect(banner(page)).toContainText('Frozen account');
  await banner(page).getByRole('button', { name: 'Return to my account' }).click();
  await page.waitForURL(/super\/dashboard\.html/);
});
