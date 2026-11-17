'use strict';
const PW = 'AgentFlow#2026';
let n = 0;

/** Sign in through the real login form. Each call uses a fresh client IP so rate limits never leak between tests. */
async function login(page, email, password = PW) {
  await page.context().setExtraHTTPHeaders({ 'X-Forwarded-For': '172.16.' + (++n % 250) + '.' + (Math.floor(n / 250) + 1) });
  await page.goto('/index.html');
  await page.fill('#email', email);
  await page.fill('#password', password);
  await page.click('#login-submit');
}

/** Sign in and wait for the app shell (used when the sign-in is expected to succeed). */
async function loginOk(page, email, password) {
  await login(page, email, password);
  await page.waitForSelector('#shell:not([hidden])');
}

/** Run an API call inside the page, so it uses the browser's real cookie jar (Secure cookies included). */
async function api(page, method, url, body) {
  return page.evaluate(async ({ method, url, body }) => {
    const res = await fetch(url, { method, credentials: 'same-origin', headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    let json = null; try { json = await res.json(); } catch (e) { /* no body */ }
    return { status: res.status, json };
  }, { method, url, body });
}

/** Sign out through the user menu and wait until the login page is ready again. */
async function logout(page) {
  await page.click('.user-btn');
  await page.click('.menu button');
  await page.waitForURL(/index\.html$/);
  await page.waitForSelector('#login-form');
}

module.exports = { PW, login, loginOk, api, logout };
