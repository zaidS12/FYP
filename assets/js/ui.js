/* AgentFlow shared UI: safe DOM helpers (never innerHTML), icons, toasts and the role-aware app shell.
 * Pages call AF.ui.boot({roles, title}) which signs the user in, checks the role and renders the shell. */
(function (root, factory) { root.AF = root.AF || {}; root.AF.ui = factory(root.AF); })(self, function (AF) {
  'use strict';

  /** Pages that already exist. Items not listed render as "Soon". Removed in the final phase. */
  const BUILT = ['app/flows.html'];
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
    kids.flat().forEach(kid => { if (kid != null && kid !== false) e.append(kid.nodeType ? kid : document.createTextNode(String(kid))); });
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
      { label: 'Dashboard', href: 'super/dashboard.html', icon: 'grid', phase: 3 },
      { label: 'Companies', href: 'super/tenants.html', icon: 'building', phase: 3 },
      { label: 'Payments', href: 'super/payments.html', icon: 'card', phase: 3 },
      { label: 'Audit log', href: 'super/audit.html', icon: 'shield', phase: 3 },
      { section: 'Workspace' },
      { label: 'All flows', href: 'app/flows.html', icon: 'flow' },
    ],
    admin: [
      { label: 'Dashboard', href: 'admin/dashboard.html', icon: 'grid', phase: 4 },
      { label: 'Employees', href: 'admin/employees.html', icon: 'users', phase: 4 },
      { label: 'Billing', href: 'admin/billing.html', icon: 'card', phase: 4 },
      { label: 'Activity', href: 'admin/activity.html', icon: 'activity', phase: 4 },
      { section: 'Workspace' },
      { label: 'Flows', href: 'app/flows.html', icon: 'flow' },
      { label: 'Templates', href: 'app/templates.html', icon: 'template', phase: 5 },
      { label: 'Runs', href: 'app/runs.html', icon: 'play', phase: 7 },
      { label: 'Account', href: 'app/account.html', icon: 'user', phase: 5 },
    ],
  };
  NAV.employee = NAV.individual = [
    { label: 'Flows', href: 'app/flows.html', icon: 'flow' },
    { label: 'Templates', href: 'app/templates.html', icon: 'template', phase: 5 },
    { label: 'Runs', href: 'app/runs.html', icon: 'play', phase: 7 },
    { label: 'Account', href: 'app/account.html', icon: 'user', phase: 5 },
  ];

  function renderNav(user, path, rootPath) {
    const ul = el('ul', { class: 'nav' });
    (NAV[user.role] || []).forEach(item => {
      if (item.section) { ul.appendChild(el('li', { class: 'nav-label', text: item.section })); return; }
      const content = [icon(item.icon), el('span', { text: item.label })];
      if (BUILT.includes(item.href)) {
        ul.appendChild(el('li', {}, el('a', { class: 'nav-item', href: rootPath + item.href, 'aria-current': item.href === path ? 'page' : null }, content)));
      } else {
        content.push(el('span', { class: 'soon', text: 'Soon' }));
        ul.appendChild(el('li', {}, el('span', { class: 'nav-item is-soon', 'aria-disabled': 'true', title: 'This screen is built in phase ' + item.phase + '.' }, content)));
      }
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

  /** Signs the user in (or redirects), checks the role, renders the shell. Returns {user, tenant} or null if redirecting. */
  async function boot(opts) {
    const rootPath = document.body.dataset.root || '';
    const path = document.body.dataset.path || '';
    await AF.db.init();
    const me = await AF.db.me();
    if (!me.ok) { location.replace(rootPath + 'index.html?next=' + encodeURIComponent(path)); return null; }
    if (opts.roles && !opts.roles.includes(me.user.role)) { location.replace(rootPath + AF.auth.homeFor(me.user.role, BUILT)); return null; }
    if (me.user.prefs && me.user.prefs.theme) applyTheme(me.user.prefs.theme);
    renderShell(me, path, rootPath);
    if (opts.title) document.title = opts.title + ' · AgentFlow';
    document.getElementById('shell').hidden = false;
    return { user: me.user, tenant: me.tenant };
  }

  return { BUILT, el, icon, toast, timeAgo, boot, applyTheme, ROLE_LABEL };
});
