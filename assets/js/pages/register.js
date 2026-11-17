/* Register page controller: free individual signup. Validation comes from AF.auth, saving from AF.db. */
(async function () {
  'use strict';
  const { el } = AF.ui;
  await AF.db.init();
  const form = document.getElementById('register-form');
  const errorBox = document.getElementById('register-error');
  const submit = document.getElementById('register-submit');
  const fields = ['name', 'email', 'password'].map(id => document.getElementById(id));

  function clearErrors() {
    errorBox.hidden = true;
    fields.forEach(f => { f.removeAttribute('aria-invalid'); const m = document.getElementById(f.id + '-error'); m.textContent = ''; });
  }
  function showFieldErrors(errors) {
    let first = null;
    fields.forEach(f => {
      const msg = errors && errors[f.id];
      if (msg) { f.setAttribute('aria-invalid', 'true'); document.getElementById(f.id + '-error').textContent = msg; first = first || f; }
    });
    if (first) first.focus();
  }

  form.addEventListener('submit', async e => {
    e.preventDefault();
    clearErrors();
    const input = { name: fields[0].value, email: fields[1].value, password: fields[2].value };
    const v = AF.auth.validateRegistration(input);
    if (!v.ok) { showFieldErrors(v.errors); return; }
    submit.disabled = true; submit.textContent = 'Creating account…';
    const r = await AF.db.register(input);
    if (r.ok) { location.href = AF.auth.homeFor(r.user.role); return; }
    submit.disabled = false; submit.textContent = 'Create free account';
    if (r.errors) showFieldErrors(r.errors);
    else { errorBox.replaceChildren(el('strong', { text: 'Could not create the account. ' }), r.error || 'Try again.'); errorBox.hidden = false; }
  });
})();
