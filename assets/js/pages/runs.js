/* Runs page: history of runs with filters, and per-step detail for each one. */
(async function () {
  'use strict';
  const { el, timeAgo } = AF.ui; const K = AF.kit; const RV = AF.runView;
  const ctx = await AF.ui.boot({ roles: ['superadmin', 'admin', 'employee', 'individual'], title: 'Runs' });
  if (!ctx) return;
  const { user } = ctx;
  const host = document.getElementById('host');
  document.getElementById('sub').textContent = user.role === 'superadmin' ? 'Every run across all companies.' : user.role === 'admin' ? 'Every run in your company, newest first.' : 'Your runs, newest first.';
  const params = new URLSearchParams(location.search);
  const f = { status: params.get('status') || '', flow_id: params.get('flow') || '', user_id: '', q: '', since: '' };
  const SINCE = { '': 'Any time', day: 'Last 24 hours', week: 'Last 7 days', month: 'Last 30 days' };
  const sinceIso = k => (k ? new Date(Date.now() - { day: 1, week: 7, month: 30 }[k] * 86400000).toISOString() : '');
  let timer = null;

  async function openDetail(id) {
    const r = await AF.db.getRun(id);
    if (!r.ok) return AF.ui.toast(r.error, 'error');
    const run = r.run;
    const body = el('div', { class: 'run-detail' }, RV.summary(run), RV.problem(run), RV.output(run),
      el('h3', { text: 'Steps' }), RV.steps(r.steps), el('h3', { text: 'Log' }), RV.logs(run));
    K.modal({ title: 'Run of ' + run.flow_name, wide: true, body, actions: [
      { label: 'Close', onClick: ({ close }) => close() },
      { label: 'Open the flow', kind: 'primary', onClick: () => { location.href = 'builder.html?id=' + encodeURIComponent(run.flow_id); return false; } }] });
  }

  async function render() {
    clearTimeout(timer);
    const [r, flows] = await Promise.all([AF.db.listRuns({ status: f.status, flow_id: f.flow_id, user_id: f.user_id, q: f.q, since: sinceIso(f.since), limit: 200 }), AF.db.listFlows()]);
    K.must(r); K.must(flows);
    const people = [...new Map(r.runs.map(x => [x.user_id, x.user_name])).entries()];
    const sel = (label, value, opts, onChange) => { const s = el('select', { class: 'input', 'aria-label': label }, opts.map(([v, t]) => el('option', { value: v, text: t }))); s.value = value; s.addEventListener('change', () => onChange(s.value)); return s; };
    const search = el('input', { class: 'input', type: 'search', placeholder: 'Search by flow name', 'aria-label': 'Search runs by flow name', value: f.q });
    search.addEventListener('keydown', e => { if (e.key === 'Enter') { f.q = search.value; K.load(host, render); } });
    search.addEventListener('change', () => { f.q = search.value; K.load(host, render); });
    const showWho = user.role !== 'individual' && user.role !== 'employee';
    const cols = [
      { label: 'Flow', render: x => el('div', {}, el('a', { class: 'cell-strong', href: 'builder.html?id=' + encodeURIComponent(x.flow_id), text: x.flow_name }), el('div', { class: 'muted', text: x.steps_count + ' steps' + (x.flow_version ? ' · v' + x.flow_version : '') })) },
      { label: 'Status', render: x => RV.statusBadge(x.status) },
      { label: 'Started', render: x => el('span', { class: 'muted', title: K.formatDateTime(x.started_at), text: timeAgo(x.started_at) }) },
      { label: 'Duration', render: x => el('span', { text: x.status === 'running' ? 'running…' : RV.duration(x.duration_ms) }) },
      { label: 'Credits', render: x => el('span', { text: String(x.credits) }) },
      showWho ? { label: 'Run by', key: 'user_name' } : null,
      { label: 'Details', render: x => el('button', { type: 'button', class: 'btn btn-sm btn-secondary', 'aria-label': 'Details of the run of ' + x.flow_name + ' started ' + timeAgo(x.started_at), text: 'Details', on: { click: () => openDetail(x.id) } }) },
    ].filter(Boolean);
    const filtered = f.status || f.flow_id || f.user_id || f.q || f.since;
    if (r.runs.some(x => x.status === 'running')) timer = setTimeout(() => K.load(host, render), 2000);
    return [
      el('div', { class: 'row section' }, search,
        sel('Status', f.status, [['', 'Any status'], ['success', 'Finished'], ['failed', 'Failed'], ['stopped', 'Stopped'], ['running', 'Running']], v => { f.status = v; K.load(host, render); }),
        sel('Flow', f.flow_id, [['', 'Any flow']].concat(flows.flows.map(x => [x.id, x.name])), v => { f.flow_id = v; K.load(host, render); }),
        showWho ? sel('Run by', f.user_id, [['', 'Anyone']].concat(people), v => { f.user_id = v; K.load(host, render); }) : null,
        sel('When', f.since, Object.entries(SINCE), v => { f.since = v; K.load(host, render); }),
        el('span', { class: 'muted', text: r.runs.length + (r.runs.length === 1 ? ' run' : ' runs') })),
      K.table({ caption: 'Runs', columns: cols, rows: r.runs, empty: filtered ? { title: 'No runs match', body: 'Change or clear the filters above to see more runs.' } : { title: 'No runs yet', body: 'Open a flow in the builder and press Run. Every run, with each step, is saved here.', action: el('a', { class: 'btn btn-primary', href: 'flows.html', text: 'Go to my flows' }) } }),
    ];
  }
  K.load(host, render);
})();
