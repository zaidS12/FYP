/* AgentFlow shared UI: safe DOM helpers (never innerHTML), icons, toasts and the role-aware app shell.
 * Pages call AF.ui.boot({roles, title}) which signs the user in, checks the role and renders the shell. */
(function (root, factory) { root.AF = root.AF || {}; root.AF.ui = factory(root.AF); })(self, function (AF) {
  'use strict';

  const SVGNS = 'http://www.w3.org/2000/svg';
  const ICONS = {
    grid: 'M3 3h7v7H3z|M14 3h7v7h-7z|M3 14h7v7H3z|M14 14h7v7h-7z',
    building: 'M4 21V4l9-2v19|M13 9l7 2v10|M8 8h1|M8 12h1|M8 16h1',
    card: 'M2 6h20v12H2z|M2 10h20',
    shield: 'M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z',
    users: 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2|M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z|M22 21v-2a4 4 0 0 0-3-3.9|M16 3.1a4 4 0 0 1 0 7.8',
    activity: 'M3 12h4l3-8 4 16 3-8h4',
    flow: 'M5 5h5v5H5z|M14 14h5v5h-5z|M10 7.5h2a2 2 0 0 1 2 2V14',
    template: 'M3 3h18v6H3z|M3 13h8v8H3z|M15 13h6v8h-6z',
    play: 'M6 4l14 8-14 8z',
    user: 'M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2|M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z',
    sun: 'M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10z|M12 1v2|M12 21v2|M4.2 4.2l1.4 1.4|M18.4 18.4l1.4 1.4|M1 12h2|M21 12h2|M4.2 19.8l1.4-1.4|M18.4 5.6l1.4-1.4',
    moon: 'M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z',
    menu: 'M3 6h18|M3 12h18|M3 18h18',
    logout: 'M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4|M16 17l5-5-5-5|M21 12H9',
    plus: 'M12 5v14|M5 12h14',
    minus: 'M5 12h14', stop: 'M6 6h12v12H6z', bolt: 'M13 2L4 14h7l-1 8 9-12h-7z', flag: 'M5 21V4|M5 4h12l-2 4 2 4H5', mail: 'M3 5h18v14H3z|M3 7l9 6 9-6', doc: 'M6 3h9l4 4v14H6z|M14 3v5h5|M9 13h6|M9 17h6',
    sparkle: 'M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z|M19 16l.7 2 2 .7-2 .7-.7 2-.7-2-2-.7 2-.7z', globe: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z|M3 12h18|M12 3c3 3 3 15 0 18|M12 3c-3 3-3 15 0 18',
    search: 'M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16z|M21 21l-4.3-4.3', branch: 'M6 3v12|M18 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6z|M6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6z|M18 9c0 6-12 3-12 6',
    repeat: 'M17 2l4 4-4 4|M3 11V9a3 3 0 0 1 3-3h15|M7 22l-4-4 4-4|M21 13v2a3 3 0 0 1-3 3H3', clock: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z|M12 7v5l3 2', bot: 'M5 8h14v10H5z|M12 8V4|M9 13h.01|M15 13h.01|M9 18v2|M15 18v2',
    code: 'M8 7l-5 5 5 5|M16 7l5 5-5 5|M14 4l-4 16', undo: 'M9 14L4 9l5-5|M4 9h10a6 6 0 0 1 0 12h-3', redo: 'M15 14l5-5-5-5|M20 9H10a6 6 0 0 0 0 12h3', fit: 'M4 9V4h5|M20 9V4h-5|M4 15v5h5|M20 15v5h-5',
    align: 'M4 5h6v4H4z|M14 5h6v4h-6z|M9 15h6v4H9z|M7 9v3h10V9|M12 12v3', save: 'M5 3h12l4 4v14H5z|M8 3v6h8V3|M8 21v-7h8v7', help: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z|M9.5 9a2.5 2.5 0 1 1 3.5 2.3c-.7.4-1 1-1 1.7|M12 17h.01',
    history: 'M3 12a9 9 0 1 0 3-6.7L3 8|M3 3v5h5|M12 7v5l3 2', export: 'M12 3v12|M7 8l5-5 5 5|M5 21h14', chev: 'M6 9l6 6 6-6', alert: 'M12 3l10 18H2z|M12 10v5|M12 18h.01', send: 'M22 2L11 13|M22 2l-7 20-4-9-9-4z',
  };

  function icon(name, size) {
    const s = document.createElementNS(SVGNS, 'svg');
    const px = String(size || 18);
    [['viewBox', '0 0 24 24'], ['width', px], ['height', px], ['fill', 'none'], ['stroke', 'currentColor'], ['stroke-width', '1.8'], ['stroke-linecap', 'round'], ['stroke-linejoin', 'round'], ['aria-hidden', 'true']].forEach(([k, v]) => s.setAttribute(k, v));
    (ICONS[name] || '').split('|').filter(Boolean).forEach(d => { const p = document.createElementNS(SVGNS, 'path'); p.setAttribute('d', d); s.appendChild(p); });
    return s;
  }

  /** el('div', {class:'x', text:'safe', on:{click:fn}}, child, ...). Text always goes through text nodes. */
  function el(tag, props, ...kids) {
    const e = document.createElement(tag);
    Object.entries(props || {}).forEach(([k, v]) => {
      if (v == null || v === false) return;
      if (k === 'class') e.className = v;
      else if (k === 'text') e.textContent = v;
      else if (k === 'on') Object.entries(v).forEach(([ev, fn]) => e.addEventListener(ev, fn));
      else if (/^on/i.test(k) || k === 'style' || k === 'innerHTML') return; // no inline handlers or styles
      else e.setAttribute(k, v === true ? '' : String(v));
    });
    kids.flat(Infinity).forEach(kid => { if (kid != null && kid !== false) e.append(kid.nodeType ? kid : document.createTextNode(String(kid))); });
    return e;
  }

  function toast(message, kind) {
    let host = document.getElementById('toasts');
    if (!host) { host = el('div', { id: 'toasts', class: 'toasts', 'aria-live': 'polite' }); document.body.appendChild(host); }
    const t = el('div', { class: 'toast' + (kind === 'error' ? ' is-error' : ''), role: kind === 'error' ? 'alert' : 'status', text: message });
    host.appendChild(t);
    setTimeout(() => t.remove(), 5000);
  }

  function timeAgo(iso) {
    const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
    if (!isFinite(s)) return '';
    if (s < 60) return 'just now';
    const units = [[86400 * 30, 'mo', 86400 * 30], [86400, 'd', 86400], [3600, 'h', 3600], [60, 'min', 60]];
    for (const [limit, label, div] of units) if (s >= limit) return Math.floor(s / div) + ' ' + label + ' ago';
    return '';
  }

  function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    try { localStorage.setItem('af.theme', theme); } catch (e) { /* storage blocked */ }
  }

  const ROLE_LABEL = { superadmin: 'Super Admin', admin: 'Company Admin', employee: 'Employee', individual: 'Individual (Free)' };
  const NAV = {
    superadmin: [
      { label: 'Dashboard', href: 'super/dashboard.html', icon: 'grid' },
      { label: 'Companies', href: 'super/tenants.html', icon: 'building', phase: 3, also: ['super/tenant-detail.html'] },
      { label: 'Payments', href: 'super/payments.html', icon: 'card' },
      { label: 'Audit log', href: 'super/audit.html', icon: 'shield' },
      { section: 'Workspace' },
      { label: 'All flows', href: 'app/flows.html', icon: 'flow' },
    ],
    admin: [
      { label: 'Dashboard', href: 'admin/dashboard.html', icon: 'grid' },
      { label: 'Employees', href: 'admin/employees.html', icon: 'users' },
      { label: 'Billing', href: 'admin/billing.html', icon: 'card' },
      { label: 'Activity', href: 'admin/activity.html', icon: 'activity' },
      { section: 'Workspace' },
      { label: 'Flows', href: 'app/flows.html', icon: 'flow' },
      { label: 'Templates', href: 'app/templates.html', icon: 'template' },
      { label: 'Runs', href: 'app/runs.html', icon: 'play' },
      { label: 'Account', href: 'app/account.html', icon: 'user' },
    ],
  };
  NAV.employee = NAV.individual = [
    { label: 'Flows', href: 'app/flows.html', icon: 'flow' },
    { label: 'Templates', href: 'app/templates.html', icon: 'template' },
    { label: 'Runs', href: 'app/runs.html', icon: 'play' },
    { label: 'Account', href: 'app/account.html', icon: 'user' },
  ];

  function renderNav(user, path, rootPath) {
    const ul = el('ul', { class: 'nav' });
    (NAV[user.role] || []).forEach(item => {
      if (item.section) { ul.appendChild(el('li', { class: 'nav-label', text: item.section })); return; }
      const content = [icon(item.icon), el('span', { text: item.label })];
      ul.appendChild(el('li', {}, el('a', { class: 'nav-item', href: rootPath + item.href, 'aria-current': item.href === path || (item.also || []).includes(path) ? 'page' : null }, content)));
    });
    return ul;
  }

  function renderShell(ctx, path, rootPath) {
    const { user, tenant } = ctx;
    const shell = document.getElementById('shell');
    const sidebar = document.getElementById('sidebar');
    const topbar = document.getElementById('topbar');
    const workspaceName = user.role === 'superadmin' ? 'All companies' : tenant ? tenant.name : 'Personal workspace';
    const workspaceSub = user.role === 'superadmin' ? 'Platform view' : tenant ? 'Company workspace' : 'Free plan';

    sidebar.replaceChildren(
      el('a', { class: 'brand', href: rootPath + 'index.html' }, el('img', { src: rootPath + 'assets/img/logo.svg', alt: '', width: 28, height: 28 }), 'AgentFlow'),
      el('div', { class: 'workspace' }, el('b', { text: workspaceName }), el('span', { text: workspaceSub })),
      el('nav', { 'aria-label': 'Main' }, renderNav(user, path, rootPath)),
      el('div', { class: 'sidebar-foot', text: AF.db.mode === 'server' ? 'Data: AgentFlow server' : 'Data: offline demo (this browser only)' })
    );

    const menuBtn = el('button', { class: 'btn btn-ghost icon-btn menu-btn', type: 'button', 'aria-label': 'Open navigation menu', 'aria-expanded': 'false', on: { click: () => { const open = shell.classList.toggle('nav-open'); menuBtn.setAttribute('aria-expanded', String(open)); } } }, icon('menu', 20));
    const themeBtn = el('button', { class: 'btn btn-ghost icon-btn', type: 'button' });
    const paintTheme = () => {
      const dark = document.documentElement.getAttribute('data-theme') === 'dark';
      themeBtn.replaceChildren(icon(dark ? 'sun' : 'moon', 18));
      themeBtn.setAttribute('aria-label', dark ? 'Switch to light mode' : 'Switch to dark mode');
      themeBtn.setAttribute('aria-pressed', String(dark));
    };
    themeBtn.addEventListener('click', async () => {
      const next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
      applyTheme(next); paintTheme();
      const r = await AF.db.setPrefs({ theme: next });
      if (!r.ok) toast('Theme changed here, but could not be saved to your account. ' + (r.error || ''), 'error');
    });
    paintTheme();

    const menu = el('div', { class: 'menu', role: 'menu', hidden: true },
      el('div', { class: 'who' }, el('b', { text: user.name }), el('span', { class: 'muted', text: user.email }), el('br'), el('span', { class: 'badge', text: ROLE_LABEL[user.role] || user.role })),
      el('button', { type: 'button', role: 'menuitem', on: { click: async () => { await AF.db.logout(); location.href = rootPath + 'index.html'; } } }, icon('logout'), 'Sign out'));
    const userBtn = el('button', { class: 'user-btn', type: 'button', 'aria-haspopup': 'menu', 'aria-expanded': 'false' },
      el('span', { class: 'avatar', 'aria-hidden': 'true', text: user.name.split(/\s+/).map(w => w[0]).slice(0, 2).join('').toUpperCase() }), el('span', { class: 'name', text: user.name }));
    const closeMenu = () => { menu.hidden = true; userBtn.setAttribute('aria-expanded', 'false'); };
    userBtn.addEventListener('click', e => { e.stopPropagation(); const open = menu.hidden; menu.hidden = !open; userBtn.setAttribute('aria-expanded', String(open)); });
    document.addEventListener('click', e => { if (!menu.contains(e.target)) closeMenu(); });
    document.addEventListener('keydown', e => { if (e.key === 'Escape') { closeMenu(); shell.classList.remove('nav-open'); } });

    topbar.replaceChildren(menuBtn, el('div', { class: 'grow', text: workspaceName }), themeBtn, el('div', { class: 'user-menu' }, userBtn, menu));
  }

  /** Persistent "you are acting as" bar. The real person's name comes from the server, never from the page URL. */
  function renderImpersonationBanner(me, rootPath) {
    document.querySelectorAll('.imp-banner').forEach(n => n.remove());
    const imp = me.impersonation;
    document.body.classList.toggle('has-imp', !!imp);
    if (!imp) return;
    const back = el('button', { class: 'btn btn-secondary btn-sm', type: 'button', text: 'Return to my account' });
    back.addEventListener('click', async () => {
      back.disabled = true;
      const r = await AF.db.endImpersonation();
      if (!r.ok) { back.disabled = false; toast(r.error || 'Could not return to your account.', 'error'); return; }
      location.href = rootPath + AF.auth.homeFor(imp.actor.role);
    });
    const frozen = imp.frozen ? el('span', { class: 'badge', text: 'Frozen account' }) : null;
    document.body.prepend(el('div', { class: 'imp-banner', role: 'status' }, icon('shield', 18),
      el('span', { class: 'grow' }, el('b', { text: imp.actor.name }), ' is acting as ', el('b', { text: me.user.name }), ' (' + (ROLE_LABEL[me.user.role] || me.user.role) + ')', me.tenant ? ' · ' + me.tenant.name : ''),
      frozen, back));
  }

  /** Signs the user in (or redirects), checks the role, renders the shell. Returns {user, tenant} or null if redirecting. */
  async function boot(opts) {
    const rootPath = document.body.dataset.root || '';
    const path = document.body.dataset.path || '';
    await AF.db.init();
    const me = await AF.db.me();
    if (!me.ok) { location.replace(rootPath + 'index.html?next=' + encodeURIComponent(path)); return null; }
    if (opts.roles && !opts.roles.includes(me.user.role)) { location.replace(rootPath + AF.auth.homeFor(me.user.role)); return null; }
    if (me.user.prefs && me.user.prefs.theme) applyTheme(me.user.prefs.theme);
    AF.ui.impersonation = me.impersonation || null;
    renderImpersonationBanner(me, rootPath);
    if (!opts.bare) renderShell(me, path, rootPath);
    if (opts.title) document.title = opts.title + ' · AgentFlow';
    document.getElementById(opts.bare ? 'builder' : 'shell').hidden = false;
    return { user: me.user, tenant: me.tenant };
  }

  return { impersonation: null, el, icon, toast, timeAgo, boot, applyTheme, ROLE_LABEL };
});
