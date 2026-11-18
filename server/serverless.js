'use strict';
/* Vercel (serverless) adapter. A function instance can be frozen or replaced at any moment and several can run at once, so:
 *   - the database lives in ONE Supabase row; an instance loads it on its first request (cold start),
 *   - before every request a cheap check compares the row's updated_at with what this instance last saw and reloads if another
 *     instance changed it,
 *   - every change is uploaded BEFORE the answer is sent (write-through), so nothing is lost when the instance is frozen,
 *   - a run continues after its answer is sent (Vercel waitUntil keeps the function alive) and uploads its progress every moment,
 *   - presence, card locks and Stop requests are shared between instances (server/live-sync.js, compare-and-swap),
 *   - live streams are off (the pages poll every few seconds instead).
 * Known limit (documented in README): two changes to the SAME flow data at the very same moment on different instances can
 * overwrite each other (last write wins). For many simultaneous editors, run the long-lived server (server.js) instead. */
const fs = require('node:fs');
const path = require('node:path');
const { SharedCollab } = require('./live-sync.js');

const log = msg => process.stdout.write('[agentflow] ' + msg + '\n');

function createHandler(env = process.env, fetchImpl = fetch) {
  const { REMOTE_STORE_URL: url, REMOTE_STORE_KEY: key } = env;
  const dataDir = env.DATA_DIR || '/tmp/agentflow-data';
  const file = path.join(dataDir, 'db.json');
  const H = { apikey: key, Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' };
  let server = null; let version = null; let booting = null; let dirtyText = null; let pushChain = Promise.resolve(); let soon = null;
  const stepDelayMs = Number(env.AF_STEP_DELAY_MS) || 200;

  const remote = async (query, init) => {
    const res = await fetchImpl(`${url}${query}`, Object.assign({ headers: H }, init));
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res;
  };
  const readRow = async select => { const rows = await (await remote(`?id=eq.main&select=${select}`, { method: 'GET' })).json(); return Array.isArray(rows) && rows.length ? rows[0] : null; };

  /** Upload the newest written text. Serialised, so a later answer can never be overtaken by an older upload. */
  function push() {
    pushChain = pushChain.catch(() => {}).then(async () => {
      if (!server) return;
      server.store.flush();                       // writes delayed changes, which hands us their text through afterWrite
      if (dirtyText === null) return;
      const text = dirtyText; dirtyText = null;
      try {
        const res = await remote('?on_conflict=id', { method: 'POST', headers: Object.assign({}, H, { Prefer: 'resolution=merge-duplicates,return=representation' }), body: JSON.stringify({ id: 'main', data: JSON.parse(text), updated_at: new Date().toISOString() }) });
        const rows = await res.json(); if (Array.isArray(rows) && rows[0]) version = rows[0].updated_at;
      } catch (e) { if (dirtyText === null) dirtyText = text; throw e; }   // keep it for the next request to retry
    });
    return pushChain;
  }

  /** While a run is going on, upload its progress every moment so other instances (and the polling page) can see it. */
  function pushSoon() { if (soon) return; soon = setTimeout(() => { soon = null; push().catch(e => log('upload failed: ' + e.message)); }, 250); }

  /** Vercel: ask the platform to keep this function alive until `promise` is done (the request context carries waitUntil). */
  function keepAlive(promise) {
    const done = promise.then(() => push()).catch(e => log('run follow-up failed: ' + e.message));
    try { const ctx = globalThis[Symbol.for('@vercel/request-context')]; const wu = ctx && ctx.get && ctx.get() && ctx.get().waitUntil; if (wu) wu(done); } catch (e) { /* not on Vercel: the process stays alive anyway */ }
  }

  async function boot() {
    const row = await readRow('data,updated_at');          // throws if unreadable: never start empty on top of real data
    fs.mkdirSync(dataDir, { recursive: true });
    if (row && row.data) { fs.writeFileSync(file, JSON.stringify(row.data)); version = row.updated_at; }
    const { createServer } = require('../server.js');
    const collab = new SharedCollab({ url, key, fetchImpl });
    server = createServer({ dataDir, trustProxy: true, allowFakeGateway: true, disableLive: true, stepDelayMs, saveDebounceMs: 0, collab, keepAlive, recoverOlderThanMs: 3 * 60 * 1000,
      afterWrite: t => { dirtyText = t; if (server && server.runner && server.runner.activeCount() > 0) pushSoon(); } });
    if (!row) await push();                                // first ever start: store the seed
  }

  async function ready() {
    if (!url || !key) throw Object.assign(new Error('Storage is not configured: set REMOTE_STORE_URL and REMOTE_STORE_KEY.'), { code: 'config' });
    if (!server) { booting = booting || boot().finally(() => { booting = null; }); await booting; return; }
    const row = await readRow('updated_at');                // tiny check on every request
    if (row && row.updated_at !== version) {
      const full = await readRow('data,updated_at');
      if (full && full.data) { fs.writeFileSync(file, JSON.stringify(full.data)); server.store.reload(); version = full.updated_at; }
    }
  }

  return async function handler(req, res) {
    try { await ready(); } catch (e) {
      log('storage problem: ' + e.message);
      res.statusCode = 503; res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.setHeader('Cache-Control', 'no-store');
      return res.end(JSON.stringify({ error: e.code === 'config' ? e.message : 'The storage service is not reachable right now, so AgentFlow cannot answer safely. Try again in a moment.' }));
    }
    const finish = res.end.bind(res); let finishing = false;
    res.end = (...args) => {                                // hold the answer until the change is stored
      if (finishing) return res; finishing = true;
      push().catch(e => log('upload failed (will retry on the next request): ' + e.message)).finally(() => finish(...args));
      return res;
    };
    const closed = new Promise(r => res.on('close', r));
    server.emit('request', req, res);
    await closed;                                           // keep the function alive until the answer has been sent
  };
}

module.exports = { createHandler };
