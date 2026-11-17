'use strict';
/* Retention: keeps db.json from growing forever. Old runs (and their steps) and old audit entries are removed.
 * Per company (or per individual): the newest `keepNewest` runs are always kept, then runs younger than `maxAgeDays`,
 * and never more than `maxPerScope`. A run that is still running is never removed. */
const DEFAULTS = { maxAgeDays: 90, maxPerScope: 500, keepNewest: 50, maxAudit: 20000 };
const DAY = 86400000;

/** Mutates `data`. Returns how many {runs, steps, audit} entries were removed. */
function prune(data, now, options) {
  const o = Object.assign({}, DEFAULTS, options || {});
  const cutoff = (now == null ? Date.now() : now) - o.maxAgeDays * DAY;
  const scopes = new Map();
  for (const run of data.runs) {
    const key = run.tenant_id || 'user:' + run.user_id;
    if (!scopes.has(key)) scopes.set(key, []);
    scopes.get(key).push(run);
  }
  const drop = new Set();
  for (const list of scopes.values()) {
    list.sort((a, b) => (a.started_at < b.started_at ? 1 : a.started_at > b.started_at ? -1 : 0));   // newest first
    list.forEach((run, i) => {
      if (run.status === 'running' || i < o.keepNewest) return;
      const t = Date.parse(run.started_at);
      if (i >= o.maxPerScope || (Number.isFinite(t) && t < cutoff)) drop.add(run.id);
    });
  }
  let runs = 0; let steps = 0; let audit = 0;
  if (drop.size) {
    const before = data.runs.length; const beforeSteps = data.runSteps.length;
    data.runs = data.runs.filter(r => !drop.has(r.id));
    data.runSteps = data.runSteps.filter(s => !drop.has(s.run_id));
    runs = before - data.runs.length; steps = beforeSteps - data.runSteps.length;
  }
  if (data.auditLog.length > o.maxAudit) { audit = data.auditLog.length - o.maxAudit; data.auditLog = data.auditLog.slice(audit); }
  return { runs, steps, audit };
}

module.exports = { prune, DEFAULTS };
