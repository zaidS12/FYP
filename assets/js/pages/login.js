/* Login page controller. Business rules live in AF.auth / AF.db; this only wires the form. */
(async function () {
  'use strict';
  const { el } = AF.ui;
  const form = document.getElementById('login-form');
  const errorBox = document.getElementById('login-error');
  const emailInput = document.getElementById('email');
  const passInput = document.getElementById('password');
  const submit = document.getElementById('login-submit');
  const modeNote = document.getElementById('mode-note');
  const DEMO_PASSWORD = 'AgentFlow#2026';

  await AF.db.init();
  modeNote.textContent = AF.db.mode === 'server'
    ? 'Connected to the AgentFlow server. Data is saved in data/db.json.'
    : 'Offline demo mode: the server was not found, so data is kept in this browser only. Run "node server.js" for the real database.';

  function nextTarget() {
    const n = new URLSearchParams(location.search).get('next');
    return n && /^(app|admin|super)\/[a-z-]+\.html$/.test(n) ? n : null;
  }
  function go(user) { location.href = nextTarget() || AF.auth.homeFor(user.role); }

  const existing = await AF.db.me();
  if (existing.ok) { go(existing.user); return; }

  function showError(message) {
    errorBox.replaceChildren(el('strong', { text: 'Could not sign in. ' }), message);
    errorBox.hidden = false;
    emailInput.setAttribute('aria-invalid', 'true');
  }

  form.addEventListener('submit', async e => {
    e.preventDefault();
    errorBox.hidden = true; emailInput.removeAttribute('aria-invalid');
    const email = emailInput.value.trim(); const password = passInput.value;
    if (!AF.auth.validateEmail(email.toLowerCase())) { showError('Enter your email address, like name@company.com.'); emailInput.focus(); return; }
    if (!password) { showError('Enter your password.'); passInput.focus(); return; }
    submit.disabled = true; submit.textContent = 'Signing in…';
    const r = await AF.db.login({ email, password });
    if (r.ok) { if (r.user.prefs && r.user.prefs.theme) AF.ui.applyTheme(r.user.prefs.theme); go(r.user); return; }
    submit.disabled = false; submit.textContent = 'Sign in';
    showError(r.error || 'Something went wrong. Try again.');
    passInput.select();
  });

  const accounts = [
    ['Super Admin', 'super@agentflow.test'],
    ['Company Admin · Brightloom', 'admin@brightloom.test'],
    ['Employee · Brightloom', 'ana@brightloom.test'],
    ['Individual (Free)', 'solo@example.test'],
    ['Frozen company · Kestrel', 'admin@kestrel.test'],
    ['Frozen employee · Brightloom', 'dev.frozen@brightloom.test'],
  ];
  const list = document.getElementById('demo-list');
  accounts.forEach(([label, email]) => {
    list.appendChild(el('li', {}, el('button', { type: 'button', on: { click: () => { emailInput.value = email; passInput.value = DEMO_PASSWORD; passInput.focus(); } } }, el('span', { text: label }), el('small', { text: email }))));
  });
})();
