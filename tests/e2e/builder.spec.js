'use strict';
const { test, expect } = require('@playwright/test');
const { loginOk, api } = require('./helpers');

test.describe.configure({ mode: 'serial' });

const card = (page, title) => page.locator('.cv-node').filter({ has: page.locator('.title', { hasText: new RegExp('^' + title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$') }) });
const count = page => page.locator('.cv-node').count();
async function openNew(page, name) {
  await page.goto('/app/flows.html');
  await page.getByRole('button', { name: 'New flow' }).click();
  await page.getByRole('dialog').getByLabel('Flow name').fill(name);
  await page.getByRole('dialog').getByRole('button', { name: 'Create flow and open builder' }).click();
  await page.waitForURL(/builder\.html\?id=/);
  await page.waitForSelector('.cv-node');
}
async function drag(page, from, to, offset = { x: 0, y: 0 }) {
  const a = await from.boundingBox(); const b = await to.boundingBox();
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2); await page.mouse.down();
  await page.mouse.move(b.x + b.width / 2 + offset.x, b.y + b.height / 2 + offset.y, { steps: 10 }); await page.mouse.up();
}

test('a new flow opens with Start and End joined, and no problems', async ({ page }) => {
  await loginOk(page, 'ana@brightloom.test');
  await openNew(page, 'Builder walkthrough');
  await expect(page.locator('.cv-node')).toHaveCount(2);
  await expect(page.locator('.wire-group')).toHaveCount(1);
  await expect(page.getByRole('button', { name: /No problems found/ })).toBeVisible();
  await expect(page.locator('#flow-name')).toHaveValue('Builder walkthrough');
  await expect(page.locator('#save-state')).toHaveText('All changes saved');
});

test('add cards by clicking and by dragging from the library; problems show on the card itself', async ({ page }) => {
  await loginOk(page, 'ana@brightloom.test');
  await openNew(page, 'Cards test');
  await page.getByRole('button', { name: /^Add Summarize card/ }).click();
  await expect(page.locator('.cv-node')).toHaveCount(3);
  await expect(page.locator('#settings h2')).toHaveText('Summarize');
  const sum = card(page, 'Summarize');
  await expect(sum).toHaveClass(/has-error/);
  await expect(sum.locator('.meta')).toContainText('not connected');
  await expect(sum.locator('.flag')).toHaveText('1');
  await expect(page.getByRole('button', { name: /1 problem/ })).toBeVisible();
  await page.getByRole('button', { name: /^Add Translate card/ }).dragTo(page.locator('#canvas'), { targetPosition: { x: 500, y: 300 } });
  await expect(page.locator('.cv-node')).toHaveCount(4);
  await expect(page.locator('#save-state')).toHaveText('Unsaved changes');
});

test('only one Start card is allowed', async ({ page }) => {
  await loginOk(page, 'ana@brightloom.test');
  await openNew(page, 'One start');
  await page.getByRole('button', { name: /^Add Start card/ }).click();
  await expect(page.locator('.toast.is-error')).toContainText('only have one Start');
  await expect(page.locator('.cv-node')).toHaveCount(2);
});

test('delete a connection, rewire through a new card, and the problems clear', async ({ page }) => {
  await loginOk(page, 'ana@brightloom.test');
  await openNew(page, 'Rewire');
  await page.getByRole('button', { name: /^Add Summarize card/ }).click();
  await page.locator('.wire-group .wire-hit').first().click({ force: true });
  await expect(page.locator('#settings h2')).toHaveText('Connection');
  await page.locator('.cv-wire-del').click();
  await expect(page.locator('.wire-group')).toHaveCount(0);
  await expect(card(page, 'Start').locator('.meta')).toContainText('not connected');
  await drag(page, card(page, 'Start').locator('.pin.out'), card(page, 'Summarize'));
  await drag(page, card(page, 'Summarize').locator('.pin.out'), card(page, 'End'));
  await expect(page.locator('.wire-group')).toHaveCount(2);
  await expect(page.getByRole('button', { name: /No problems found/ })).toBeVisible();
});

test('invalid connections are refused with a reason', async ({ page }) => {
  await loginOk(page, 'ana@brightloom.test');
  await openNew(page, 'Bad wire');
  await page.getByRole('button', { name: /^Add Summarize card/ }).click();
  const boxes = await Promise.all(['Start', 'End', 'Summarize'].map(async t => card(page, t).boundingBox()));
  for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
    const overlap = boxes[i].x < boxes[j].x + boxes[j].width && boxes[j].x < boxes[i].x + boxes[i].width && boxes[i].y < boxes[j].y + boxes[j].height && boxes[j].y < boxes[i].y + boxes[i].height;
    expect(overlap, 'new cards never land on top of existing ones').toBe(false);
  }
  await drag(page, card(page, 'Summarize').locator('.pin.out'), card(page, 'Start'));
  await expect(page.locator('.toast.is-error').last()).toContainText('Start cards begin the flow');
  await drag(page, card(page, 'Start').locator('.pin.out'), card(page, 'End'));
  await expect(page.locator('.toast.is-error').last()).toContainText('already connected');
});

test('required settings are shown on the card and clear when filled in', async ({ page }) => {
  await loginOk(page, 'ana@brightloom.test');
  await openNew(page, 'Email flow');
  await page.getByRole('button', { name: /^Add Write Email card/ }).click();
  await expect(card(page, 'Write Email').locator('.meta')).not.toHaveText('');
  await page.locator('.wire-group .wire-hit').first().click({ force: true });
  await page.locator('.cv-wire-del').click();
  await drag(page, card(page, 'Start').locator('.pin.out'), card(page, 'Write Email'));
  await drag(page, card(page, 'Write Email').locator('.pin.out'), card(page, 'End'));
  await page.locator('.cv-node', { hasText: 'Write Email' }).click();
  await expect(card(page, 'Write Email').locator('.meta')).toContainText('Fill in "Send to"');
  await page.locator('#settings').getByLabel('Send to').fill('team@brightloom.test');
  await expect(card(page, 'Write Email').locator('.meta')).toContainText('Fill in "Subject"');
  await page.locator('#settings').getByLabel('Subject').fill('Daily digest');
  await expect(card(page, 'Write Email').locator('.meta')).toContainText('To team@brightloom.test');
  await expect(page.getByRole('button', { name: /No problems found/ })).toBeVisible();
});

test('undo and redo, duplicate, delete and keyboard nudge', async ({ page }) => {
  await loginOk(page, 'ana@brightloom.test');
  await openNew(page, 'Keys');
  await page.getByRole('button', { name: /^Add Summarize card/ }).click();
  await expect(page.locator('.cv-node')).toHaveCount(3);
  await page.keyboard.press('Control+z');
  await expect(page.locator('.cv-node')).toHaveCount(2);
  await page.keyboard.press('Control+y');
  await expect(page.locator('.cv-node')).toHaveCount(3);
  const sum = card(page, 'Summarize'); await sum.click();
  const x0 = (await sum.boundingBox()).x;
  await page.keyboard.press('Shift+ArrowRight');
  expect((await card(page, 'Summarize').boundingBox()).x).toBeGreaterThan(x0);
  await page.keyboard.press('Control+d');
  await expect(page.locator('.cv-node')).toHaveCount(4);
  await expect(page.locator('.cv-node', { hasText: 'Summarize copy' })).toBeVisible();
  await page.keyboard.press('Delete');
  await expect(page.locator('.cv-node')).toHaveCount(3);
  await page.locator('.cv-node', { hasText: 'Start' }).click();
  await page.keyboard.press('Control+d');
  await expect(page.locator('.toast.is-error').last()).toContainText('cannot be duplicated');
});

test('auto-align tidies cards, and zoom works', async ({ page }) => {
  await loginOk(page, 'ana@brightloom.test');
  await openNew(page, 'Align');
  await page.getByRole('button', { name: /^Add Summarize card/ }).click();
  await page.getByRole('button', { name: 'Auto-align cards' }).click();
  const xs = [];
  for (const t of ['Start', 'End']) xs.push((await card(page, t).boundingBox()).x);
  expect(xs[0]).toBeLessThan(xs[1]);
  await page.locator('#canvas').hover();
  await page.keyboard.down('Control'); await page.mouse.wheel(0, -300); await page.keyboard.up('Control');
  await expect(page.locator('#zoom .btn-sm')).not.toHaveText('100%');
  await page.getByRole('button', { name: 'Reset zoom to 100 percent' }).click();
  await expect(page.locator('#zoom .btn-sm')).toHaveText('100%');
});

test('opening a wide flow keeps cards readable (at least 85%) and "Fit all" shows everything', async ({ page }) => {
  await loginOk(page, 'ana@brightloom.test');
  await page.goto('/app/builder.html?id=f_report');
  await page.waitForSelector('.cv-node');
  const zoom = async () => Number((await page.locator('#zoom .btn-sm').innerText()).replace('%', ''));
  expect(await zoom()).toBeGreaterThanOrEqual(85);
  const start = await card(page, 'Start').boundingBox(); const canvasBox = await page.locator('#canvas').boundingBox();
  expect(start.x).toBeGreaterThanOrEqual(canvasBox.x); expect(start.x + start.width).toBeLessThanOrEqual(canvasBox.x + canvasBox.width);
  await page.getByRole('button', { name: /^Fit all/ }).click();
  expect(await zoom()).toBeLessThan(85);
  const done = await card(page, 'Done').boundingBox();
  expect(done.x + done.width).toBeLessThanOrEqual(canvasBox.x + canvasBox.width + 1);
  await page.getByRole('button', { name: 'Reset zoom to 100 percent' }).click();
  expect(await zoom()).toBe(100);
  await page.locator('#canvas').focus(); await page.keyboard.press('f');
  await expect.poll(zoom).toBeLessThan(85);
});

test('the library folds by category, remembers it, and search opens matching groups', async ({ page }) => {
  await loginOk(page, 'ana@brightloom.test');
  await openNew(page, 'Library test');
  const ai = page.getByRole('button', { name: /^AI/ });
  await expect(ai).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByRole('button', { name: /^Add Summarize card/ })).toBeVisible();
  await ai.click();
  await expect(ai).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByRole('button', { name: /^Add Summarize card/ })).toBeHidden();
  await page.reload(); await page.waitForSelector('.cv-node');
  await expect(page.getByRole('button', { name: /^AI/ })).toHaveAttribute('aria-expanded', 'false');
  await page.getByLabel('Search cards').fill('summar');
  await expect(page.getByRole('button', { name: /^Add Summarize card/ })).toBeVisible();
  await page.getByLabel('Search cards').fill('');
  const tall = await page.locator('.lib-card').first().boundingBox();
  expect(tall.height).toBeLessThanOrEqual(52);
  const shadow = await page.locator('.lib-card').first().evaluate(e => getComputedStyle(e).boxShadow);
  expect(shadow).toBe('none');
});

test('save creates a version, a reload shows the same flow, and leaving with unsaved changes is guarded', async ({ page }) => {
  await loginOk(page, 'ana@brightloom.test');
  await openNew(page, 'Persisted');
  const url = page.url();
  await page.getByRole('button', { name: /^Add Summarize card/ }).click();
  await page.locator('.wire-group .wire-hit').first().click({ force: true }); await page.locator('.cv-wire-del').click();
  await drag(page, card(page, 'Start').locator('.pin.out'), card(page, 'Summarize'));
  await drag(page, card(page, 'Summarize').locator('.pin.out'), card(page, 'End'));
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.locator('.toast', { hasText: 'Saved as version 2' })).toBeVisible();
  await expect(page.locator('#ver-pill')).toHaveText('v2');
  await expect(page.locator('#save-state')).toHaveText('All changes saved');
  await page.goto(url);
  await page.waitForSelector('.cv-node');
  await expect(page.locator('.cv-node')).toHaveCount(3);
  await expect(page.locator('.wire-group')).toHaveCount(2);
  await page.keyboard.press('Control+s');
  await expect(page.locator('.toast', { hasText: 'Nothing had changed' })).toBeVisible();
});

test('two people saving different things: the second save is merged, nothing is overwritten', async ({ page }) => {
  await loginOk(page, 'ana@brightloom.test');
  await openNew(page, 'Merge flow');
  const id = new URL(page.url()).searchParams.get('id');
  await page.getByRole('button', { name: /^Add Summarize card/ }).click();
  const bump = await api(page, 'PATCH', '/api/flows/' + id, { name: 'Renamed by someone else', base_version: 1 });
  expect(bump.status).toBe(200);
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.locator('.toast', { hasText: 'merged with your colleague' })).toBeVisible();
  await expect(page.locator('#flow-name')).toHaveValue('Renamed by someone else');
  await expect(page.locator('.cv-node')).toHaveCount(3);
  await expect(page.locator('#ver-pill')).toHaveText('v3');
});

test('two people changing the same thing: the second save gets a clear choice instead of silently overwriting', async ({ page }) => {
  await loginOk(page, 'ana@brightloom.test');
  await openNew(page, 'Conflict flow');
  const id = new URL(page.url()).searchParams.get('id');
  await page.locator('#flow-name').fill('My own new name');
  const bump = await api(page, 'PATCH', '/api/flows/' + id, { name: 'Renamed by someone else', base_version: 1 });
  expect(bump.status).toBe(200);
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  const dlg = page.getByRole('dialog', { name: /clash with a colleague/ });
  await expect(dlg).toBeVisible();
  await expect(dlg).toContainText('Flow name');
  await dlg.getByRole('button', { name: 'Load their version' }).click();
  await expect(page.locator('#flow-name')).toHaveValue('Renamed by someone else');
  await expect(page.locator('.cv-node')).toHaveCount(2);
});

test('my cards: save a configured card, find it in the library, and remove it', async ({ page }) => {
  await loginOk(page, 'ana@brightloom.test');
  await openNew(page, 'Custom cards');
  await page.getByRole('button', { name: /^Add Translate card/ }).click();
  await page.locator('#settings').getByLabel('Translate into').fill('Urdu');
  await page.getByRole('button', { name: 'Save as my card' }).click();
  const dlg = page.getByRole('dialog');
  await dlg.getByLabel('Card name').fill('To Urdu');
  await dlg.getByRole('button', { name: 'Save card' }).click();
  await expect(page.getByRole('button', { name: /My cards/ })).toBeVisible();
  await page.getByRole('button', { name: /^Add To Urdu card/ }).click();
  await expect(page.locator('#settings')).toContainText('based on Translate');
  await expect(page.locator('#settings').getByLabel('Translate into')).toHaveValue('Urdu');
  await page.reload(); await page.waitForSelector('.cv-node');
  await expect(page.getByRole('button', { name: /^Add To Urdu card/ })).toBeVisible();
  await page.getByRole('button', { name: 'Remove my card To Urdu' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Remove card' }).click();
  await expect(page.getByRole('button', { name: /^Add To Urdu card/ })).toHaveCount(0);
});

test('read-only: super admin and colleagues without edit rights can look but not change', async ({ page }) => {
  await loginOk(page, 'super@agentflow.test');
  await page.goto('/app/builder.html?id=f_news');
  await page.waitForSelector('.cv-node');
  await expect(page.getByText('View only').first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toHaveCount(0);
  await card(page, 'Summarize').click();
  await expect(page.locator('#settings').getByLabel('Style')).toBeDisabled();
  const n0 = await count(page);
  const before = await card(page, 'Summarize').boundingBox();
  await page.keyboard.press('Delete');
  await page.keyboard.press('Control+d');
  await page.keyboard.press('Shift+ArrowRight');
  await page.keyboard.press('Control+z');
  await drag(page, card(page, 'Summarize'), card(page, 'End'), { x: 0, y: 200 });                        // try to move it
  await drag(page, card(page, 'Start').locator('.pin.out'), card(page, 'End'));                              // try to connect
  await expect(page.locator('.cv-node')).toHaveCount(n0);
  const after = await card(page, 'Summarize').boundingBox();
  expect([after.x, after.y]).toEqual([before.x, before.y]);
  await expect(page.locator('.wire-group')).toHaveCount(4);
  const lib = page.getByRole('button', { name: /^Add Summarize card/ });
  await expect(lib).toBeDisabled();
  await expect(page.locator('#settings').getByRole('button', { name: /Delete card|Duplicate card|Connect/ })).toHaveCount(0);
});

test('keyboard only: Tab selects a card, arrows move it, the settings panel connects and removes wires, Delete removes the card', async ({ page }) => {
  await loginOk(page, 'ana@brightloom.test');
  await openNew(page, 'Keyboard only');
  await page.getByRole('button', { name: /^Add Summarize card/ }).click();
  await page.locator('.wire-group .wire-hit').first().click({ force: true }); await page.locator('.cv-wire-del').click();
  await card(page, 'Start').focus();
  await expect(page.locator('#settings h2')).toHaveText('Start');
  await page.locator('#settings').getByLabel('Connect to card').selectOption({ label: 'Summarize' });
  await page.locator('#settings').getByRole('button', { name: 'Connect', exact: true }).click();
  await expect(page.locator('.wire-group')).toHaveCount(1);
  await expect(page.locator('#settings')).toContainText('→ Summarize');
  await card(page, 'Summarize').focus();
  await page.locator('#settings').getByLabel('Connect to card').selectOption({ label: 'End' });
  await page.locator('#settings').getByRole('button', { name: 'Connect', exact: true }).click();
  await expect(page.getByRole('button', { name: /No problems found/ })).toBeVisible();
  await page.locator('#settings').getByRole('button', { name: 'Remove the connection to End' }).click();
  await expect(page.locator('.wire-group')).toHaveCount(1);
  const x0 = (await card(page, 'Summarize').boundingBox()).x;
  await card(page, 'Summarize').focus(); await page.keyboard.press('ArrowRight');
  await expect.poll(async () => (await card(page, 'Summarize').boundingBox()).x).toBeGreaterThan(x0);
  await page.keyboard.press('Delete');
  await expect(page.locator('.cv-node')).toHaveCount(2);
});

test('holding an arrow key is one undo step and does not wipe earlier history', async ({ page }) => {
  await loginOk(page, 'ana@brightloom.test');
  await openNew(page, 'Held key');
  await page.getByRole('button', { name: /^Add Summarize card/ }).click();
  await expect(page.locator('.cv-node')).toHaveCount(3);
  const x0 = (await card(page, 'Summarize').boundingBox()).x;
  await card(page, 'Summarize').focus();
  for (let i = 0; i < 130; i++) await page.keyboard.press('ArrowRight');
  expect((await card(page, 'Summarize').boundingBox()).x).toBeGreaterThan(x0 + 200);
  await page.keyboard.press('Control+z');
  await expect.poll(async () => Math.abs((await card(page, 'Summarize').boundingBox()).x - x0)).toBeLessThan(2);
  await page.keyboard.press('Control+z');
  await expect(page.locator('.cv-node')).toHaveCount(2);
});

test('undo then keep typing, then redo, does not bring back old text', async ({ page }) => {
  await loginOk(page, 'ana@brightloom.test');
  await openNew(page, 'Typing undo');
  await page.getByRole('button', { name: /^Add Translate card/ }).click();
  const field = page.locator('#settings').getByLabel('Translate into');
  await field.fill('Urdu');
  await page.getByRole('button', { name: /^Undo/ }).click();
  await field.fill('French');
  await expect(page.getByRole('button', { name: /^Redo/ })).toBeDisabled();   // a new edit clears the redo trail, so old text can never come back
  await page.keyboard.press('Control+y');
  await expect(page.locator('#settings').getByLabel('Translate into')).toHaveValue('French');
});

test('clicking an output pin without dragging is not an error', async ({ page }) => {
  await loginOk(page, 'ana@brightloom.test');
  await openNew(page, 'Pin click');
  await card(page, 'Start').locator('.pin.out').click();
  await expect(page.locator('.toast.is-error')).toHaveCount(0);
});

test('a flow that does not exist, or belongs to another company, shows a clear page', async ({ page }) => {
  await loginOk(page, 'ana@brightloom.test');
  await page.goto('/app/builder.html?id=f_ke');
  await expect(page.getByRole('heading', { name: 'This flow could not be opened' })).toBeVisible();
  await page.goto('/app/builder.html?id=nope');
  await expect(page.getByRole('heading', { name: 'This flow could not be opened' })).toBeVisible();
  await page.getByRole('link', { name: 'Back to my flows' }).click();
  await expect(page).toHaveURL(/app\/flows\.html$/);
});

test('on a phone-sized screen the builder explains it needs a bigger screen', async ({ page }) => {
  await loginOk(page, 'ana@brightloom.test');
  await page.setViewportSize({ width: 700, height: 800 });
  await page.goto('/app/builder.html?id=f_news');
  await expect(page.getByRole('heading', { name: 'The builder needs a bigger screen' })).toBeVisible();
  await expect(page.locator('#builder')).toBeHidden();
});
