'use strict';
/* Builds data/seed.json (scrypt hashes, used by server.js on first start) and
 * assets/js/fallback-seed.js (PBKDF2 hashes, used when pages open without the server).
 * Demo password for every seed account: AgentFlow#2026  (demo data only, listed in README.md). */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { hashPassword } = require('../server/security.js');

const ROOT = path.join(__dirname, '..');
const DEMO_PASSWORD = 'AgentFlow#2026';

function pbkdf2Hash(pw) {
  const salt = crypto.randomBytes(16);
  const h = crypto.pbkdf2Sync(pw, salt, 100000, 32, 'sha256');
  return ['pbkdf2', 100000, salt.toString('base64'), h.toString('base64')].join('$');
}

const UAS = {
  chromeWin: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  edgeWin: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0',
  firefoxLinux: 'Mozilla/5.0 (X11; Linux x86_64; rv:127.0) Gecko/20100101 Firefox/127.0',
  safariMac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',
  safariIphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
  chromeAndroid: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36',
};

const COST = { start: 0, end: 0, search_web: 2, summarize: 3, write_email: 2, create_report: 4, translate: 2, research_bot: 6, condition: 0, loop: 1, timer: 0, python_code: 1 };

function build(hash) {
  const now = Date.now();
  const iso = offsetMin => new Date(now - offsetMin * 60000).toISOString();
  const DAY = 1440;
  const period = new Date(now).toISOString().slice(0, 7);
  const pw = hash(DEMO_PASSWORD);

  const plans = [
    { id: 'free', name: 'Free', price_usd: 0, seats: 1, credits_per_month: 100, extra_seat_usd: 0, audience: 'individual' },
    { id: 'basic', name: 'Basic', price_usd: 100, seats: 10, credits_per_month: 5000, extra_seat_usd: 8, audience: 'company' },
    { id: 'pro', name: 'Pro', price_usd: 250, seats: 30, credits_per_month: 20000, extra_seat_usd: 6, audience: 'company' },
    { id: 'plus', name: 'Plus', price_usd: 12, seats: 1, credits_per_month: 1000, extra_seat_usd: 0, audience: 'individual' },
  ];

  const tenants = [
    { id: 't_brightloom', name: 'Brightloom Studio', plan_id: 'basic', status: 'active', frozen_reason: null, extra_seats: 0, created_at: iso(90 * DAY) },
    { id: 't_kestrel', name: 'Kestrel Freight', plan_id: 'basic', status: 'frozen', frozen_reason: 'Invoice INV-2026-0007 unpaid', extra_seats: 0, created_at: iso(60 * DAY) },
  ];

  const mk = (id, tenant_id, role, name, email, status = 'active', createdAgo = 30 * DAY) => ({
    id, tenant_id, role, name, email, password_hash: pw, status, prefs: { theme: 'light' }, created_at: iso(createdAgo), created_by: null,
  });
  const users = [
    mk('u_super', null, 'superadmin', 'Platform Admin', 'super@agentflow.test', 'active', 120 * DAY),
    mk('u_bl_admin', 't_brightloom', 'admin', 'Maya Hussain', 'admin@brightloom.test', 'active', 90 * DAY),
    mk('u_bl_ana', 't_brightloom', 'employee', 'Ana Torres', 'ana@brightloom.test', 'active', 80 * DAY),
    mk('u_bl_omar', 't_brightloom', 'employee', 'Omar Siddiqui', 'omar@brightloom.test', 'active', 70 * DAY),
    mk('u_bl_lina', 't_brightloom', 'employee', 'Lina Park', 'lina@brightloom.test', 'active', 55 * DAY),
    mk('u_bl_raj', 't_brightloom', 'employee', 'Raj Menon', 'raj@brightloom.test', 'active', 40 * DAY),
    mk('u_bl_devon', 't_brightloom', 'employee', 'Devon Clarke', 'dev.frozen@brightloom.test', 'frozen', 35 * DAY),
    mk('u_ke_admin', 't_kestrel', 'admin', 'Idris Kestrel', 'admin@kestrel.test', 'active', 60 * DAY),
    mk('u_ke_sam', 't_kestrel', 'employee', 'Sam Okafor', 'sam@kestrel.test', 'active', 50 * DAY),
    mk('u_ke_noor', 't_kestrel', 'employee', 'Noor Fatima', 'noor@kestrel.test', 'active', 45 * DAY),
    mk('u_solo', null, 'individual', 'Sol Individual', 'solo@example.test', 'active', 20 * DAY),
  ];
  users.filter(u => u.role === 'individual').forEach(u => { u.plan_id = 'free'; });
  users.forEach(u => { if (u.tenant_id && u.role === 'employee') u.created_by = u.tenant_id === 't_brightloom' ? 'u_bl_admin' : 'u_ke_admin'; });

  const subscriptions = tenants.map(t => ({ id: 'sub_' + t.id, tenant_id: t.id, plan_id: t.plan_id, status: t.status === 'frozen' ? 'suspended' : 'active', period_start: iso(12 * DAY), period_end: iso(-18 * DAY), extra_seats: 0 }));

  const invoices = [], payments = [];
  const inv = (tid, n, ago, status, amount = 100) => {
    const id = 'inv_' + tid + '_' + n;
    invoices.push({ id, tenant_id: tid, number: `INV-2026-${String(n).padStart(4, '0')}`, items: [{ description: 'Basic plan (10 accounts)', quantity: 1, unit_usd: amount }], amount_usd: amount, status, issued_at: iso(ago), paid_at: status === 'paid' ? iso(ago - 1) : null });
    if (status === 'paid') payments.push({ id: 'pay_' + id, tenant_id: tid, invoice_id: id, amount_usd: amount, method: 'card •••• 4242', status: 'succeeded', created_at: iso(ago - 1) });
  };
  inv('t_brightloom', 1, 85 * DAY, 'paid'); inv('t_brightloom', 2, 55 * DAY, 'paid'); inv('t_brightloom', 3, 25 * DAY, 'paid');
  inv('t_kestrel', 5, 58 * DAY, 'paid'); inv('t_kestrel', 6, 28 * DAY, 'paid'); inv('t_kestrel', 7, 6 * DAY, 'overdue');

  const N = (id, type, label, x, y, config = {}) => ({ id, type, label, x, y, config });
  const E = (id, from, to, fromPort = 'out') => ({ id, from, fromPort, to, toPort: 'in' });

  const defs = {
    f_news: { tenant: 't_brightloom', owner: 'u_bl_ana', name: 'Daily AI news digest', shared: true,
      nodes: [N('n1', 'start', 'Start', 80, 160), N('n2', 'search_web', 'Find AI news', 320, 160, { query: 'latest AI news', max_results: 5 }), N('n3', 'summarize', 'Summarize', 560, 160, { style: 'bullets', max_words: 120 }), N('n4', 'write_email', 'Email me', 800, 160, { to: 'team@brightloom.test', subject: 'Your AI news digest', tone: 'friendly' }), N('n5', 'end', 'End', 1040, 160)],
      edges: [E('e1', 'n1', 'n2'), E('e2', 'n2', 'n3'), E('e3', 'n3', 'n4'), E('e4', 'n4', 'n5')] },
    f_report: { tenant: 't_brightloom', owner: 'u_bl_omar', name: 'Competitor research report', shared: true,
      nodes: [N('n1', 'start', 'Start', 60, 200), N('n2', 'research_bot', 'Research competitors', 290, 200, { topic: 'competitor pricing', depth: 'standard' }), N('n3', 'create_report', 'Build report', 530, 200, { format: 'markdown', sections: 'Summary, Findings, Risks' }), N('n4', 'condition', 'Report ready?', 770, 200, { expression: 'length > 200' }), N('n5', 'write_email', 'Send report', 1010, 110, { to: 'omar@brightloom.test', subject: 'Competitor report', tone: 'formal' }), N('n6', 'end', 'Done', 1250, 110), N('n7', 'end', 'Stop (too short)', 1010, 300)],
      edges: [E('e1', 'n1', 'n2'), E('e2', 'n2', 'n3'), E('e3', 'n3', 'n4'), E('e4', 'n4', 'n5', 'yes'), E('e5', 'n4', 'n7', 'no'), E('e6', 'n5', 'n6')] },
    f_translate: { tenant: 't_brightloom', owner: 'u_bl_lina', name: 'Translate announcement to Urdu', shared: false,
      nodes: [N('n1', 'start', 'Start', 80, 140), N('n2', 'translate', 'To Urdu', 330, 140, { target_language: 'Urdu' }), N('n3', 'end', 'End', 580, 140)],
      edges: [E('e1', 'n1', 'n2'), E('e2', 'n2', 'n3')] },
    f_ke: { tenant: 't_kestrel', owner: 'u_ke_sam', name: 'Freight rate watch', shared: true,
      nodes: [N('n1', 'start', 'Start', 80, 160), N('n2', 'search_web', 'Search rates', 320, 160, { query: 'container freight rates', max_results: 5 }), N('n3', 'create_report', 'Rate report', 560, 160, { format: 'markdown', sections: 'Rates, Trends' }), N('n4', 'end', 'End', 800, 160)],
      edges: [E('e1', 'n1', 'n2'), E('e2', 'n2', 'n3'), E('e3', 'n3', 'n4')] },
    f_solo: { tenant: null, owner: 'u_solo', name: 'Summarize my reading list', shared: false,
      nodes: [N('n1', 'start', 'Start', 80, 140), N('n2', 'summarize', 'Summarize', 330, 140, { style: 'paragraph', max_words: 80 }), N('n3', 'end', 'End', 580, 140)],
      edges: [E('e1', 'n1', 'n2'), E('e2', 'n2', 'n3')] },
  };

  const flows = [], flowVersions = [], runs = [], runSteps = [];
  let fi = 0;
  for (const [id, d] of Object.entries(defs)) {
    fi += 1;
    const created = (40 - fi * 4) * DAY;
    const ownerName = users.find(u => u.id === d.owner).name;
    const firstNodes = d.nodes.slice(0, Math.min(3, d.nodes.length));
    const ids = new Set(firstNodes.map(n => n.id));
    const snaps = [
      { nodes: firstNodes, edges: d.edges.filter(e => ids.has(e.from) && ids.has(e.to)), summary: 'Created flow' },
      { nodes: d.nodes, edges: d.edges, summary: 'Added the remaining steps and connections' },
    ];
    snaps.forEach((s, i) => flowVersions.push({ id: `${id}_v${i + 1}`, flow_id: id, tenant_id: d.tenant, n: i + 1, user_id: d.owner, user_name: ownerName, at: iso(created - i * 2 * DAY), summary: s.summary, snapshot: { name: d.name, nodes: s.nodes, edges: s.edges } }));
    flows.push({ id, tenant_id: d.tenant, owner_id: d.owner, name: d.name, nodes: d.nodes, edges: d.edges, version: snaps.length, shared: d.shared, created_at: iso(created), updated_at: iso(created - 2 * DAY) });

    const outcomes = id === 'f_news' ? ['success', 'success', 'failed', 'success', 'success'] : ['success', 'success'];
    outcomes.forEach((status, i) => {
      const runId = `${id}_run${i + 1}`;
      const start = iso((outcomes.length - i) * 1.3 * DAY);
      let credits = 0; const failAt = status === 'failed' ? Math.min(2, d.nodes.length - 1) : -1;
      const order = d.nodes.filter(n => !(n.type === 'end' && n.label.startsWith('Stop')));
      order.forEach((n, k) => {
        if (failAt >= 0 && k > failAt) return;
        const failed = k === failAt;
        const c = failed ? 0 : (COST[n.type] || 0);
        credits += c;
        runSteps.push({ id: `${runId}_s${k + 1}`, run_id: runId, tenant_id: d.tenant, node_id: n.id, type: n.type, status: failed ? 'failed' : 'success', ms: 180 + k * 140, credits: c, input: k === 0 ? {} : { from: order[k - 1].id }, output: failed ? null : { ok: true, node: n.label }, error: failed ? 'Search provider timed out after 10s. Check your connection and run again.' : null });
      });
      runs.push({ id: runId, flow_id: id, tenant_id: d.tenant, user_id: d.owner, status, started_at: start, ended_at: start, credits, error: status === 'failed' ? 'Search provider timed out after 10s. Check your connection and run again.' : null });
    });
  }

  const sum = tid => runs.filter(r => r.tenant_id === tid).reduce((a, r) => a + r.credits, 0);
  const usage = [
    { id: 'use_t_brightloom', tenant_id: 't_brightloom', user_id: null, period, credits_used: sum('t_brightloom') + 1180, credits_limit: 5000 },
    { id: 'use_t_kestrel', tenant_id: 't_kestrel', user_id: null, period, credits_used: sum('t_kestrel') + 4200, credits_limit: 5000 },
    { id: 'use_u_solo', tenant_id: null, user_id: 'u_solo', period, credits_used: sum(null) + 62, credits_limit: 100 },
  ];

  const loginEvents = [], devices = [];
  const parse = require('../assets/js/auth.js').parseUserAgent;
  const ev = (uid, ago, ua, ip, success = true, reason = null) => {
    const u = users.find(x => x.id === uid); const p = parse(ua);
    loginEvents.push({ id: 'le_' + (loginEvents.length + 1), user_id: uid, tenant_id: u.tenant_id, at: iso(ago), ip, browser: p.browser, os: p.os, device: p.device, success, reason });
    if (!success) return;
    const fp = crypto.createHash('sha1').update(uid + ua).digest('hex').slice(0, 16);
    let d = devices.find(x => x.fingerprint === fp);
    if (!d) { d = { id: 'dev_' + fp, user_id: uid, fingerprint: fp, browser: p.browser, os: p.os, device: p.device, first_seen: iso(ago), last_seen: iso(ago), login_count: 0 }; devices.push(d); }
    d.login_count += 1; if (iso(ago) > d.last_seen) d.last_seen = iso(ago);
  };
  ev('u_super', 5 * DAY, UAS.chromeWin, '203.0.113.10'); ev('u_super', 1 * DAY, UAS.chromeWin, '203.0.113.10');
  ev('u_bl_admin', 3 * DAY, UAS.edgeWin, '198.51.100.21'); ev('u_bl_admin', 600, UAS.safariIphone, '198.51.100.58');
  ev('u_bl_ana', 2 * DAY, UAS.chromeWin, '198.51.100.22'); ev('u_bl_ana', 300, UAS.firefoxLinux, '198.51.100.22'); ev('u_bl_ana', 120, UAS.chromeWin, '198.51.100.22');
  ev('u_bl_omar', 2 * DAY, UAS.safariMac, '198.51.100.23'); ev('u_bl_omar', 4 * DAY, UAS.chromeAndroid, '198.51.100.77');
  ev('u_bl_lina', 1 * DAY, UAS.edgeWin, '198.51.100.24', false, 'bad_password'); ev('u_bl_lina', 1 * DAY - 5, UAS.edgeWin, '198.51.100.24');
  ev('u_ke_admin', 9 * DAY, UAS.chromeWin, '192.0.2.31'); ev('u_ke_sam', 8 * DAY, UAS.firefoxLinux, '192.0.2.32');
  ev('u_solo', 2 * DAY, UAS.safariIphone, '203.0.113.90'); ev('u_solo', 400, UAS.chromeWin, '203.0.113.91');

  let auditSeq = 0;
  const aud = (actor, ago, action, target, tenant_id, meta = {}) => ({ id: 'au_' + (++auditSeq), tenant_id, actor_id: actor, actor_name: users.find(u => u.id === actor).name, action, target, at: iso(ago), meta });
  const auditLog = [
    aud('u_super', 60 * DAY, 'tenant.create', 't_kestrel', null),
    aud('u_bl_admin', 80 * DAY, 'user.create', 'u_bl_ana', 't_brightloom'),
    aud('u_bl_admin', 35 * DAY, 'user.create', 'u_bl_devon', 't_brightloom'),
    aud('u_bl_admin', 3 * DAY, 'user.freeze', 'u_bl_devon', 't_brightloom', { reason: 'Left the team' }),
    aud('u_ke_admin', 7 * DAY, 'invoice.overdue', 'inv_t_kestrel_7', 't_kestrel'),
    aud('u_super', 5 * DAY, 'tenant.freeze', 't_kestrel', null, { reason: 'Invoice INV-2026-0007 unpaid' }),
    aud('u_bl_ana', 2 * DAY, 'flow.create', 'f_news', 't_brightloom'),
    aud('u_solo', 20 * DAY, 'user.register', 'u_solo', null),
  ];

  const tpl = (id, name, description, category, flowId) => ({ id, tenant_id: null, name, description, category, nodes: defs[flowId].nodes, edges: defs[flowId].edges });
  const templates = [
    tpl('tpl_news', 'Daily AI news digest', 'Search the web for news, summarize it and email the summary.', 'Research', 'f_news'),
    tpl('tpl_report', 'Research to report with a quality check', 'Research a topic, build a report and only email it if it is long enough.', 'Reporting', 'f_report'),
    tpl('tpl_translate', 'Translate an announcement', 'Translate text into another language in one step.', 'Language', 'f_translate'),
    tpl('tpl_summary', 'Quick summary', 'Summarize any text you pass in.', 'Writing', 'f_solo'),
  ];

  return { plans, tenants, users, sessions: [], devices, loginEvents, subscriptions, invoices, payments, flows, flowVersions, runs, runSteps, templates, usage, auditLog, presence: [], locks: [] };
}

fs.writeFileSync(path.join(ROOT, 'data', 'seed.json'), JSON.stringify(build(hashPassword), null, 2));
const fallback = JSON.stringify(build(pbkdf2Hash));
fs.writeFileSync(path.join(ROOT, 'assets', 'js', 'fallback-seed.js'),
  '/* GENERATED by scripts/build-seed.js - demo data for opening pages without the server. Do not edit. */\n' +
  "(function (r) { var seed = " + fallback + ";\n  if (typeof module === 'object' && module.exports) module.exports = seed; else r.AF_FALLBACK_SEED = seed;\n})(typeof self !== 'undefined' ? self : this);\n");
process.stdout.write('seed written: data/seed.json and assets/js/fallback-seed.js\n');
