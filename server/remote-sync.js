'use strict';
/* Optional off-machine copy of data/db.json, so a host without a persistent disk (Render free, etc.) keeps its data across restarts.
 * It stores the whole database as ONE row {id, data} in a Supabase (PostgREST) table, using plain fetch: no dependencies.
 *   pull():   at startup, before the Store loads, copy the stored row into the local db.json (if there is one).
 *   pusher:   after every local write, upload the newest text (bursts are coalesced, failures are retried).
 * Configure with REMOTE_STORE_URL (the table's REST url) and REMOTE_STORE_KEY (service key, a secret: only in environment variables).
 * Real stack: replace with MySQL (see docs/MIGRATION.md). */
const fs = require('node:fs');
const path = require('node:path');

const headers = key => ({ apikey: key, Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' });

/** Restore the stored database into `file`. Resolves {restored}. Throws if the store cannot be read: an unreadable store must
 *  never look like an empty one, or the next upload would overwrite real data with the seed. */
async function pull({ url, key, id = 'main', file, fetchImpl = fetch }) {
  const res = await fetchImpl(`${url}?id=eq.${encodeURIComponent(id)}&select=data`, { method: 'GET', headers: headers(key) });
  if (!res.ok) throw new Error(`Remote store could not be read (HTTP ${res.status}). Check REMOTE_STORE_URL and REMOTE_STORE_KEY.`);
  const rows = await res.json();
  if (!Array.isArray(rows) || !rows.length || !rows[0].data || typeof rows[0].data !== 'object') return { restored: false };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(rows[0].data, null, 2));
  return { restored: true };
}

/** push(text) schedules an upload of the newest database text. drain() resolves when nothing is waiting or in flight. */
function createPusher({ url, key, id = 'main', delayMs = 2000, retryMs = 5000, onError = null, fetchImpl = fetch }) {
  let latest = null; let timer = null; let inflight = null; let stopped = false;

  async function send() {
    timer = null;
    if (latest === null) return;
    const text = latest; latest = null;
    inflight = (async () => {
      try {
        const res = await fetchImpl(`${url}?on_conflict=id`, { method: 'POST', headers: Object.assign(headers(key), { Prefer: 'resolution=merge-duplicates,return=minimal' }), body: JSON.stringify({ id, data: JSON.parse(text), updated_at: new Date().toISOString() }) });
        if (!res.ok) throw new Error(`Remote store upload failed (HTTP ${res.status}).`);
      } catch (e) {
        if (latest === null) latest = text;           // keep the data that failed unless something newer already replaced it
        if (onError) onError(e);
        if (!stopped) schedule(retryMs);
      } finally { inflight = null; }
    })();
    await inflight;
  }
  function schedule(ms) { if (timer) return; timer = setTimeout(send, ms); if (timer.unref) timer.unref(); }

  return {
    push(text) { latest = text; schedule(delayMs); },
    pending: () => latest !== null || inflight !== null,
    /** Upload now and wait. Used on shutdown (SIGTERM gives a few seconds). Gives up after `maxMs`. */
    async drain(maxMs = 15000) {
      const t0 = Date.now();
      while (this.pending() && Date.now() - t0 < maxMs) {
        if (timer) { clearTimeout(timer); timer = null; }
        if (inflight) await inflight; else await send();
        if (latest !== null && Date.now() - t0 < maxMs) await new Promise(r => setTimeout(r, 20));
      }
    },
    stop() { stopped = true; if (timer) { clearTimeout(timer); timer = null; } },
  };
}

module.exports = { pull, createPusher };
