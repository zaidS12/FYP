'use strict';
const { test, expect } = require('@playwright/test');
const { loginOk, api } = require('./helpers');

test.describe.configure({ mode: 'serial' });

async function twoPeople(browser, baseURL) {
  const open = async email => {
    const ctx = await browser.newContext({ baseURL, viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage(); await loginOk(page, email); return { ctx, page };
  };
  return { ana: await open('ana@brightloom.test'), omar: await open('omar@brightloom.test') };
}

/** A shared flow with two editable cards (Alpha, Beta) next to Start and End. */
async function makeSharedFlow(page) {
  const made = await api(page, 'POST', '/api/flows', { name: 'Co-work e2e ' + Date.now() });
  const f = made.json.flow;
  const nodes = [...f.nodes,
    { id: 'n3', type: 'summarize', label: 'Alpha card', x: 80, y: 360, config: {} },
    { id: 'n4', type: 'translate', label: 'Beta card', x: 400, y: 360, config: { target_language: 'Urdu' } }];
  const saved = await api(page, 'PATCH', '/api/flows/' + f.id, { nodes, edges: f.edges, base_version: 1, shared: true });
  expect(saved.status).toBe(200);
  await api(page, 'PATCH', '/api/flows/' + f.id, { shared: true });
  return f.id;
}

const card = (page, label) => page.locator('.cv-node').filter({ hasText: label });

test('two people see each other, each other\'s saves, and locked cards', async ({ browser, baseURL }) => {
  const { ana, omar } = await twoPeople(browser, baseURL);
  try {
    const id = await makeSharedFlow(ana.page);
    await ana.page.goto('/app/builder.html?id=' + id); await ana.page.waitForSelector('.cv-node');
    await omar.page.goto('/app/builder.html?id=' + id); await omar.page.waitForSelector('.cv-node');

    // Presence avatars, both ways.
    await expect(ana.page.locator('.cw-avatar[title*="Omar Siddiqui"]')).toBeVisible({ timeout: 8000 });
    await expect(omar.page.locator('.cw-avatar[title*="Ana Torres"]')).toBeVisible({ timeout: 8000 });

    // Ana selects Alpha: Omar sees it locked and cannot change it.
    await card(ana.page, 'Alpha card').click();
    await expect(card(omar.page, 'Alpha card')).toHaveClass(/is-locked/, { timeout: 8000 });
    await expect(omar.page.locator('.cw-avatar[title*="Ana Torres is on"]')).toBeVisible();
    await card(omar.page, 'Alpha card').click();
    await expect(omar.page.locator('.cw-lock-note')).toContainText('Ana Torres is editing this card');
    await expect(omar.page.getByLabel('Name of this card')).toBeDisabled();

    // Omar edits Beta (free) and saves; Ana's canvas updates by itself.
    await card(omar.page, 'Beta card').click();
    const name = omar.page.getByLabel('Name of this card');
    await expect(name).toBeEnabled();
    await name.fill('Beta by Omar');
    await omar.page.keyboard.press('Control+s');
    await expect(omar.page.locator('#ver-pill')).toHaveText('v3');
    await expect(card(ana.page, 'Beta by Omar')).toBeVisible({ timeout: 8000 });
    await expect(ana.page.locator('#ver-pill')).toHaveText('v3');
    await expect(ana.page.locator('.toast').filter({ hasText: 'Omar Siddiqui saved version 3' })).toBeVisible();

    // Ana moves on to another card: Alpha is free again for Omar.
    await card(ana.page, 'Beta by Omar').click();
    await expect(card(omar.page, 'Alpha card')).not.toHaveClass(/is-locked/, { timeout: 8000 });
  } finally { await ana.ctx.close(); await omar.ctx.close(); }
});

test('both edit different cards while apart: saves merge card by card; the same card clashes with a clear message', async ({ browser, baseURL }) => {
  const { ana, omar } = await twoPeople(browser, baseURL);
  try {
    const id = await makeSharedFlow(ana.page);
    await ana.page.goto('/app/builder.html?id=' + id); await ana.page.waitForSelector('.cv-node');
    await omar.page.goto('/app/builder.html?id=' + id); await omar.page.waitForSelector('.cv-node');
    await expect(omar.page.locator('.cw-avatar[title*="Ana Torres"]')).toBeVisible({ timeout: 8000 });

    // Ana edits Alpha but does not save yet; Omar saves Beta first. Ana's save then merges.
    await card(ana.page, 'Alpha card').click();
    await ana.page.getByLabel('Name of this card').fill('Alpha by Ana');
    await card(omar.page, 'Beta card').click();
    await omar.page.getByLabel('Name of this card').fill('Beta by Omar');
    await omar.page.keyboard.press('Control+s');
    await expect(omar.page.locator('#ver-pill')).toHaveText('v3');
    await expect(ana.page.locator('#save-state')).toContainText('Omar Siddiqui saved v3, saving will merge', { timeout: 8000 });
    await ana.page.keyboard.press('Control+s');
    await expect(ana.page.locator('.toast').filter({ hasText: 'merged with your colleague' })).toBeVisible();
    await expect(ana.page.locator('#ver-pill')).toHaveText('v4');
    await expect(card(ana.page, 'Alpha by Ana')).toBeVisible();
    await expect(card(ana.page, 'Beta by Omar')).toBeVisible();
    // A direct API save of the same card by someone who ignores locks and conflicts is refused with the card named.
    const stale = await api(omar.page, 'PATCH', '/api/flows/' + id, { name: 'Renamed by Omar', base_version: 3 });
    expect(stale.status).toBe(200);
    const clash = await api(ana.page, 'PATCH', '/api/flows/' + id, { name: 'Renamed by Ana', base_version: 3 });
    expect(clash.status).toBe(409); expect(clash.json.conflicts[0].label).toBe('Flow name');
  } finally { await ana.ctx.close(); await omar.ctx.close(); }
});

test('a super admin acting as Ana shows as "Actor (as Ana)" and holds the lock for Ana', async ({ browser, baseURL }) => {
  const { ana, omar } = await twoPeople(browser, baseURL);
  const rootCtx = await browser.newContext({ baseURL, viewport: { width: 1440, height: 900 } });
  const root = await rootCtx.newPage();
  try {
    const id = await makeSharedFlow(ana.page);
    await loginOk(root, 'super@agentflow.test');
    expect((await api(root, 'POST', '/api/impersonation/start', { user_id: 'u_bl_ana' })).status).toBe(200);
    await root.goto('/app/builder.html?id=' + id); await root.waitForSelector('.cv-node');
    await omar.page.goto('/app/builder.html?id=' + id); await omar.page.waitForSelector('.cv-node');
    await card(root, 'Alpha card').click();
    await expect(card(omar.page, 'Alpha card')).toHaveClass(/is-locked/, { timeout: 8000 });
    await expect(omar.page.locator('.cw-avatar[title*="(as Ana Torres)"]')).toBeVisible();
    await card(omar.page, 'Alpha card').click();
    await expect(omar.page.locator('.cw-lock-note')).toContainText('(as Ana Torres) is editing this card');
    // Ana's own tab is blocked by the support session too.
    await ana.page.goto('/app/builder.html?id=' + id); await ana.page.waitForSelector('.cv-node');
    await expect(card(ana.page, 'Alpha card')).toHaveClass(/is-locked/, { timeout: 8000 });
  } finally { await ana.ctx.close(); await omar.ctx.close(); await rootCtx.close(); }
});

test('when the live stream is blocked, the page falls back to polling and still sees saves and locks', async ({ browser, baseURL }) => {
  const { ana, omar } = await twoPeople(browser, baseURL);
  try {
    const id = await makeSharedFlow(ana.page);
    await omar.page.route('**/api/flows/*/events*', route => route.abort());
    await ana.page.goto('/app/builder.html?id=' + id); await ana.page.waitForSelector('.cv-node');
    await omar.page.goto('/app/builder.html?id=' + id); await omar.page.waitForSelector('.cv-node');
    await expect(omar.page.locator('.cw-avatars')).toHaveAttribute('data-mode', 'polling', { timeout: 20000 });
    await card(ana.page, 'Alpha card').click();
    await expect(card(omar.page, 'Alpha card')).toHaveClass(/is-locked/, { timeout: 15000 });
    await card(ana.page, 'Beta card').click();
    await ana.page.getByLabel('Name of this card').fill('Beta polled');
    await ana.page.keyboard.press('Control+s');
    await expect(card(omar.page, 'Beta polled')).toBeVisible({ timeout: 15000 });
  } finally { await ana.ctx.close(); await omar.ctx.close(); }
});
