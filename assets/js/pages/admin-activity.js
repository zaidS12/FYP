/* Company admin: devices and browsers, sign-in log and audit log for their own company. */
(async function () {
  'use strict';
  const { el, timeAgo } = AF.ui; const K = AF.kit;
  const ctx = await AF.ui.boot({ roles: ['admin'], title: 'Activity' });
  if (!ctx) return;
  const host = document.getElementById('host');
  const metaText = m => Object.entries(m || {}).map(([k, v]) => k + ': ' + (typeof v === 'object' ? JSON.stringify(v) : v)).join(', ');
  let userId = '';

  async function render() {
    const [u, d, e, a] = await Promise.all([AF.db.listUsers(), AF.db.listDevices(), AF.db.listLoginEvents({ user_id: userId, limit: 100 }), AF.db.listAudit({ limit: 100 })]);
    K.must(u); K.must(d); K.must(e); K.must(a);
    const filter = el('select', { class: 'input', 'aria-label': 'Show sign-ins for' }, [el('option', { value: '', text: 'Everyone' })].concat(u.users.map(x => el('option', { value: x.id, text: x.name }))));
    filter.value = userId;
    filter.addEventListener('change', () => { userId = filter.value; K.load(host, render); });
    return [
      el('div', { class: 'section' }, el('h2', { text: 'Devices and browsers' }), K.table({ caption: 'Devices', rows: d.devices, columns: [
        { label: 'Account', render: x => el('div', {}, el('div', { class: 'cell-strong', text: x.user_name }), el('div', { class: 'muted', text: x.user_email })) }, { label: 'Browser', key: 'browser' },
        { label: 'System', render: x => el('span', { text: x.os + ' · ' + x.device }) }, { label: 'Sign-ins', key: 'login_count' }, { label: 'Last seen', render: x => el('span', { class: 'muted', text: timeAgo(x.last_seen) }) }],
        empty: { title: 'No devices yet', body: 'A device appears here after someone signs in.' } })),
      el('div', { class: 'section' }, el('div', { class: 'section-head' }, el('h2', { text: 'Sign-in log' }), filter), K.table({ caption: 'Sign-in events', rows: e.events, columns: [
        { label: 'When', render: x => el('span', { class: 'muted', text: K.formatDateTime(x.at) }) }, { label: 'Account', key: 'user_name' }, { label: 'Browser', render: x => el('span', { text: x.browser + ' · ' + x.os }) },
        { label: 'Result', render: x => (x.success ? K.badge('Signed in', 'ok') : K.badge(x.reason === 'bad_password' ? 'Wrong password' : 'Blocked: ' + (x.reason || 'unknown'), 'danger')) }],
        empty: { title: 'No sign-ins to show', body: 'Choose "Everyone" or another account.' } })),
      el('div', { class: 'section' }, el('h2', { text: 'Audit log' }), K.table({ caption: 'Audit log', rows: a.entries, columns: [
        { label: 'When', render: x => el('span', { class: 'muted', text: K.formatDateTime(x.at) }) }, { label: 'Who', key: 'actor_name' }, { label: 'Action', render: x => el('code', { text: x.action }) }, { label: 'Details', render: x => el('span', { class: 'muted', text: metaText(x.meta) }) }],
        empty: { title: 'No activity yet', body: 'Creating accounts, freezing users and billing changes appear here.' } })),
    ];
  }
  K.load(host, render);
})();
