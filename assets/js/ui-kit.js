/* AgentFlow UI kit: accessible dialogs, forms, tables, charts and file helpers shared by every page.
 * Safe by construction: all text goes through text nodes (AF.ui.el). Depends on AF.ui. */
(function (root, factory) { root.AF = root.AF || {}; root.AF.kit = factory(root.AF); })(self, function (AF) {
  'use strict';
  const { el } = AF.ui;
  const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';
  let uid = 0;
  const nextId = p => p + (++uid);

  /** Generic modal. actions: [{label, kind, onClick(ctx)}]; onClick returning false keeps the dialog open. */
  function modal({ title, body, actions, wide, dismissible, focusFirstButton }) {
    const prev = document.activeElement;
    const titleId = nextId('dlg-title-');
    const closable = dismissible !== false;
    const btns = (actions || []).map(a => {
      const b = el('button', { type: 'button', class: 'btn btn-' + (a.kind || 'secondary'), text: a.label });
      b.addEventListener('click', async () => {
        b.disabled = true;
        let keep = false;
        try { keep = (await a.onClick({ close, button: b })) === false; } finally { if (keep) b.disabled = false; }
      });
      return b;
    });
    const dlg = el('div', { class: 'modal' + (wide ? ' modal-wide' : ''), role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId, tabindex: '-1' },
      el('h2', { id: titleId, text: title }), body, btns.length ? el('div', { class: 'modal-actions' }, btns) : null);
    const backdrop = el('div', { class: 'modal-backdrop' }, dlg);
    function onKey(e) {
      if (e.key === 'Escape' && closable) { e.stopPropagation(); close(); return; }
      if (e.key !== 'Tab') return;
      const items = [...dlg.querySelectorAll(FOCUSABLE)].filter(n => !n.hidden && n.offsetParent !== null);
      if (!items.length) return;
      const first = items[0], last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
    function close() { document.removeEventListener('keydown', onKey, true); backdrop.remove(); if (prev && prev.focus) prev.focus(); }
    if (closable) backdrop.addEventListener('mousedown', e => { if (e.target === backdrop) close(); });
    document.addEventListener('keydown', onKey, true);
    document.body.appendChild(backdrop);
    const firstField = dlg.querySelector('input,select,textarea') || (focusFirstButton ? btns[0] : btns[btns.length - 1]) || dlg;
    firstField.focus();
    return { close, dlg };
  }

  function field(f) {
    const id = nextId('f-');
    const hintId = id + '-hint', errId = id + '-err';
    let input;
    if (f.type === 'select') {
      input = el('select', { class: 'input', id, name: f.name }, (f.options || []).map(o => el('option', { value: o.value, text: o.label })));
      if (f.value !== undefined) input.value = f.value;
    } else if (f.type === 'textarea') {
      input = el('textarea', { class: 'input textarea', id, name: f.name, rows: f.rows || 3 }); input.value = f.value || '';
    } else {
      input = el('input', { class: 'input', id, name: f.name, type: f.type || 'text', autocomplete: f.autocomplete || 'off', min: f.min, max: f.max, maxlength: f.maxlength, required: f.required ? true : null });
      input.value = f.value === undefined || f.value === null ? '' : f.value;
    }
    input.setAttribute('aria-describedby', (f.hint ? hintId + ' ' : '') + errId);
    const err = el('div', { class: 'field-error', id: errId });
    const wrap = el('div', { class: 'field' }, el('label', { class: 'label', for: id, text: f.label }), input, f.hint ? el('div', { class: 'hint', id: hintId, text: f.hint }) : null, err);
    return { wrap, input, setError(msg) { err.textContent = msg || ''; if (msg) input.setAttribute('aria-invalid', 'true'); else input.removeAttribute('aria-invalid'); } };
  }

  /** Form dialog. onSubmit(values) -> {ok, errors?, error?}. Closes on ok. */
  function formModal({ title, intro, fields, submitLabel, danger, onSubmit, wide }) {
    const parts = fields.map(field);
    const alertBox = el('div', { class: 'alert', role: 'alert', hidden: true });
    const submit = el('button', { type: 'submit', class: 'btn ' + (danger ? 'btn-danger' : 'btn-primary'), text: submitLabel });
    const cancel = el('button', { type: 'button', class: 'btn btn-secondary', text: 'Cancel' });
    const form = el('form', { novalidate: true }, intro ? el('p', { class: 'muted', text: intro }) : null, alertBox, parts.map(p => p.wrap), el('div', { class: 'modal-actions' }, cancel, submit));
    const m = modal({ title, body: form, wide });
    cancel.addEventListener('click', () => m.close());
    form.addEventListener('submit', async e => {
      e.preventDefault();
      alertBox.hidden = true; parts.forEach(p => p.setError(''));
      const values = {}; fields.forEach((f, i) => { values[f.name] = parts[i].input.value; });
      submit.disabled = true; const label = submit.textContent; submit.textContent = 'Working…';
      const r = await onSubmit(values);
      submit.disabled = false; submit.textContent = label;
      if (r && r.ok) { m.close(); return; }
      let shown = false;
      if (r && r.errors) fields.forEach((f, i) => { if (r.errors[f.name]) { parts[i].setError(r.errors[f.name]); if (!shown) { parts[i].input.focus(); shown = true; } } });
      if (!shown) { alertBox.replaceChildren(el('strong', { text: 'Could not save. ' }), (r && r.error) || 'Try again.'); alertBox.hidden = false; }
    });
    return m;
  }

  /** Resolves true when confirmed. typeToConfirm: the exact text the user must type for destructive actions. */
  function confirmDialog({ title, message, confirmLabel, danger, typeToConfirm }) {
    return new Promise(resolve => {
      let typed = null;
      const body = el('div', {}, el('p', { text: message }));
      if (typeToConfirm) {
        typed = el('input', { class: 'input', type: 'text', 'aria-label': 'Type ' + typeToConfirm + ' to confirm', autocomplete: 'off' });
        body.append(el('p', { class: 'hint', text: 'Type "' + typeToConfirm + '" to confirm.' }), typed);
      }
      modal({ title, body, dismissible: false, focusFirstButton: true, actions: [
        { label: 'Cancel', onClick: ({ close }) => { close(); resolve(false); } },
        { label: confirmLabel, kind: danger ? 'danger' : 'primary', onClick: ({ close }) => {
          if (typeToConfirm && typed.value.trim() !== typeToConfirm) { typed.focus(); typed.setAttribute('aria-invalid', 'true'); return false; }
          close(); resolve(true); return undefined;
        } },
      ] });
    });
  }

  /** Shows a value exactly once (e.g. a temporary password) with a copy button. */
  function secretDialog({ title, intro, label, value }) {
    const out = el('input', { class: 'input mono', type: 'text', readonly: true, value, 'aria-label': label });
    const status = el('span', { class: 'hint', role: 'status' });
    const copy = el('button', { type: 'button', class: 'btn btn-secondary', text: 'Copy to clipboard' });
    copy.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(value); status.textContent = 'Copied.'; } catch (e) { out.select(); status.textContent = 'Press Ctrl+C to copy.'; }
    });
    return modal({ title, body: el('div', {}, el('p', { text: intro }), el('div', { class: 'field' }, el('label', { class: 'label', text: label }), out), el('div', { class: 'row' }, copy, status)), actions: [{ label: 'Done', kind: 'primary', onClick: ({ close }) => close() }] });
  }

  function table({ caption, columns, rows, empty }) {
    if (!rows.length && empty) return el('div', { class: 'empty' }, el('h2', { text: empty.title }), el('p', { text: empty.body }), empty.action || null);
    return el('div', { class: 'table-wrap' }, el('table', {}, el('caption', { class: 'sr-only', text: caption }),
      el('thead', {}, el('tr', {}, columns.map(c => el('th', { scope: 'col', class: c.class, text: c.label })))),
      el('tbody', {}, rows.map(r => el('tr', {}, columns.map(c => el('td', { class: c.class }, c.render ? c.render(r) : String(r[c.key] == null ? '' : r[c.key]))))))));
  }

  const badge = (text, kind) => el('span', { class: 'badge' + (kind ? ' badge-' + kind : ''), text });
  const cap = s => s[0].toUpperCase() + s.slice(1);
  const statusBadge = s => badge(cap(String(s)), ['active', 'success', 'paid', 'succeeded'].includes(s) ? 'ok' : ['frozen', 'failed', 'overdue', 'suspended'].includes(s) ? 'danger' : 'warn');
  const money = n => Number(n || 0).toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: Number.isInteger(Number(n)) ? 0 : 2 });
  const formatDateTime = iso => (iso ? new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '—');
  const formatDate = iso => (iso ? new Date(iso).toLocaleDateString(undefined, { dateStyle: 'medium' }) : '—');

  function progress(value, max, label) {
    const pct = max > 0 ? Math.min(100, Math.round((value / max) * 100)) : 0;
    const fill = el('i'); fill.style.width = pct + '%';
    return el('div', { class: 'usage' + (pct >= 90 ? ' is-high' : ''), role: 'progressbar', 'aria-valuemin': 0, 'aria-valuemax': max, 'aria-valuenow': value, 'aria-label': label || 'Usage' }, fill);
  }

  /** Stacked daily bars. days: [{label, success, failed}] */
  function dayChart(days, caption) {
    const max = Math.max(1, ...days.map(d => d.success + d.failed));
    return el('figure', { class: 'chart' }, el('div', { class: 'chart-bars', role: 'img', 'aria-label': caption }, days.map(d => {
      const ok = el('i', { class: 'bar-ok' }); ok.style.height = (d.success / max) * 100 + '%';
      const bad = el('i', { class: 'bar-bad' }); bad.style.height = (d.failed / max) * 100 + '%';
      return el('div', { class: 'chart-col', title: `${d.label}: ${d.success} successful, ${d.failed} failed` }, el('div', { class: 'chart-stack' }, bad, ok), el('span', { class: 'chart-x', text: d.label }));
    })), el('figcaption', { class: 'hint', text: caption }));
  }

  function downloadJson(filename, obj) {
    const url = URL.createObjectURL(new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' }));
    const a = el('a', { href: url, download: filename }); document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function pickJsonFile() {
    return new Promise(resolve => {
      const input = el('input', { type: 'file', accept: '.json,application/json', class: 'sr-only', 'aria-hidden': 'true', tabindex: '-1' });
      input.addEventListener('change', async () => {
        const f = input.files && input.files[0]; input.remove();
        if (!f) return resolve({ ok: false, cancelled: true });
        if (f.size > 25 * 1048576) return resolve({ ok: false, error: 'That file is larger than 25 MB.' });
        try { resolve({ ok: true, data: JSON.parse(await f.text()), name: f.name }); } catch (e) { resolve({ ok: false, error: 'That file is not valid JSON. Choose a file created by AgentFlow.' }); }
      });
      document.body.appendChild(input); input.click();
    });
  }

  /** Runs loader() into host with a loading line and a retry on failure. loader returns a Node/array or throws. */
  async function load(host, loader) {
    host.replaceChildren(el('p', { class: 'muted', role: 'status', text: 'Loading…' }));
    try { const out = await loader(); host.replaceChildren(...[].concat(out).filter(n => n !== null && n !== undefined && n !== false)); } catch (e) {
      host.replaceChildren(el('div', { class: 'alert', role: 'alert' }, el('strong', { text: 'Could not load this. ' }), (e && e.message) || 'Try again.', ' ', el('button', { class: 'btn btn-secondary', type: 'button', on: { click: () => load(host, loader) } }, 'Try again')));
    }
  }
  /** Unwraps an AF.db result or throws a readable error for load(). */
  function must(r) { if (!r.ok) throw new Error(r.error || 'Something went wrong.'); return r; }

  function kv(pairs) { return el('dl', { class: 'kv' }, pairs.map(([k, v]) => [el('dt', { text: k }), el('dd', {}, v)])); }

  return { modal, field, formModal, confirmDialog, secretDialog, table, badge, statusBadge, money, formatDateTime, formatDate, progress, dayChart, downloadJson, pickJsonFile, load, must, kv };
});
