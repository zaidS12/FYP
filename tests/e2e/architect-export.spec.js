'use strict';
const fs = require('node:fs');
const { test, expect } = require('@playwright/test');
const { loginOk } = require('./helpers');

test.describe.configure({ mode: 'serial' });

async function openNew(page, name) {
  await page.goto('/app/flows.html');
  await page.getByRole('button', { name: 'New flow' }).click();
  await page.getByRole('dialog').getByLabel('Flow name').fill(name);
  await page.getByRole('dialog').getByRole('button', { name: 'Create flow and open builder' }).click();
  await page.waitForURL(/builder\.html\?id=/);
  await page.waitForSelector('.cv-node');
}

async function exportAs(page, label) {
  await page.getByRole('button', { name: 'Export' }).click();
  const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('dialog', { name: 'Export this flow' }).getByRole('button', { name: label }).click()]);
  return { name: dl.suggestedFilename(), data: fs.readFileSync(await dl.path()) };
}

test('the AI Flow Architect builds an editable flow from a sentence, and it runs', async ({ page }) => {
  await loginOk(page, 'ana@agentflow.com');
  await openNew(page, 'Architect flow');
  await page.getByLabel('Describe the flow you want').fill('Find daily AI news and email me a summary to ana@agentflow.com');
  await page.getByRole('button', { name: 'Build it' }).click();
  await expect(page.locator('.cv-node')).toHaveCount(6);
  await expect(page.locator('#settings')).toContainText('Built from your description');
  await expect(page.locator('#settings')).toContainText('Search Web');
  await expect(page.locator('.wire-group')).toHaveCount(5);
  await expect(page.locator('#save-state')).toContainText('Unsaved');
  // It is a normal flow: valid, editable and runnable.
  await expect(page.getByRole('button', { name: /No problems/ })).toBeVisible();
  await page.getByRole('button', { name: 'Run this flow' }).click();
  await expect(page.locator('.run-head')).toContainText('credits', { timeout: 20000 });
  await expect(page.getByRole('button', { name: 'Run this flow' })).toBeEnabled({ timeout: 20000 });
  // One undo step takes the whole generated flow back.
  await page.locator('#canvas').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('Control+z');
  await expect(page.locator('.cv-node')).toHaveCount(2);
});

test('the Architect explains what it could not understand, and asks before replacing a flow', async ({ page }) => {
  await loginOk(page, 'ana@agentflow.com');
  await openNew(page, 'Architect refusals');
  await page.getByLabel('Describe the flow you want').fill('hello there');
  await page.getByRole('button', { name: 'Build it' }).click();
  await expect(page.locator('.toast.is-error')).toContainText('Try something like');
  await expect(page.locator('.cv-node')).toHaveCount(2);
  await page.getByLabel('Describe the flow you want').fill('Search the web for outages and email ops@example.com');
  await page.getByRole('button', { name: 'Build it' }).click();
  await expect(page.locator('.cv-node')).toHaveCount(4);
  await expect(page.locator('#settings')).toContainText('Built from your description');
  await page.getByLabel('Describe the flow you want').fill('Research competitor pricing and create a report');
  await page.getByRole('button', { name: 'Build it' }).click();
  const dlg = page.getByRole('dialog', { name: 'Replace the current flow?' });
  await expect(dlg).toBeVisible();
  await dlg.getByRole('button', { name: 'Keep my flow' }).click();
  await expect(page.locator('.cv-node')).toHaveCount(4);
  await page.getByRole('button', { name: 'Build it' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Replace with the new flow' }).click();
  await expect(page.locator('.cv-node')).toHaveCount(4);   // start, research, report, end
  await expect(page.locator('.cv-node').filter({ hasText: 'Research Bot' })).toHaveCount(1);
});

test('export as JSON, PNG and PDF; the JSON imports back into a new flow', async ({ page }) => {
  await loginOk(page, 'ana@agentflow.com');
  await openNew(page, 'Export me');
  await page.getByLabel('Describe the flow you want').fill('Search the web for AI news and summarize it');
  await page.getByRole('button', { name: 'Build it' }).click();
  await expect(page.locator('.cv-node')).toHaveCount(4);

  const json = await exportAs(page, 'JSON file');
  expect(json.name).toBe('Export-me.json');
  const parsed = JSON.parse(json.data.toString('utf8'));
  expect(parsed.format).toBe('agentflow.flow'); expect(parsed.nodes).toHaveLength(4); expect(parsed.edges).toHaveLength(3);
  expect(JSON.stringify(parsed)).not.toMatch(/tenant|owner|t_brightloom|u_bl/);

  const png = await exportAs(page, 'PNG picture');
  expect(png.name).toBe('Export-me.png');
  expect([...png.data.subarray(0, 4)]).toEqual([0x89, 0x50, 0x4E, 0x47]);
  expect(png.data.length).toBeGreaterThan(3000);

  const pdf = await exportAs(page, 'PDF document');
  expect(pdf.name).toBe('Export-me.pdf');
  const text = pdf.data.toString('latin1');
  expect(text.startsWith('%PDF-1.4')).toBe(true); expect(text).toContain('/DCTDecode'); expect(text).toContain('Cards in this flow');
  expect(text.trimEnd().endsWith('%%EOF')).toBe(true);

  // Import from the Flows page.
  const file = test.info().outputPath('Export-me.json'); fs.writeFileSync(file, json.data);
  await page.goto('/app/flows.html');
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.getByRole('button', { name: 'Import flow (JSON)' }).click()]);
  await chooser.setFiles(file);
  await page.waitForURL(/builder\.html\?id=/);
  await page.waitForSelector('.cv-node');
  await expect(page.locator('#flow-name')).toHaveValue('Export me');
  await expect(page.locator('.cv-node')).toHaveCount(4);
});

test('importing something that is not a flow says what to do instead', async ({ page }) => {
  await loginOk(page, 'ana@agentflow.com');
  await page.goto('/app/flows.html');
  const bad = test.info().outputPath('not-a-flow.json'); fs.writeFileSync(bad, JSON.stringify({ hello: 'world' }));
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.getByRole('button', { name: 'Import flow (JSON)' }).click()]);
  await chooser.setFiles(bad);
  await expect(page.locator('.toast.is-error')).toContainText('Export JSON');
  const broken = test.info().outputPath('broken.json'); fs.writeFileSync(broken, '{ nope');
  const [chooser2] = await Promise.all([page.waitForEvent('filechooser'), page.getByRole('button', { name: 'Import flow (JSON)' }).click()]);
  await chooser2.setFiles(broken);
  await expect(page.locator('.toast.is-error').last()).toContainText('not valid JSON');
});

test('people who can only look cannot use the Architect', async ({ page }) => {
  await loginOk(page, 'super@agentflow.com');
  await page.goto('/app/builder.html?id=f_news');
  await page.waitForSelector('.cv-node');
  await expect(page.getByLabel('Describe the flow you want')).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Build it' })).toBeDisabled();
});
