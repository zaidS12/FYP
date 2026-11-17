'use strict';
/* Atomic JSON file store with rolling backups and corruption recovery. Zero dependencies. */
const fs = require('node:fs');
const path = require('node:path');

const COLLECTIONS = ['tenants', 'users', 'sessions', 'devices', 'loginEvents', 'plans', 'subscriptions', 'invoices', 'payments',
  'flows', 'flowVersions', 'runs', 'runSteps', 'templates', 'usage', 'auditLog', 'presence', 'locks'];

class Store {
  constructor({ file, backupDir, seedFile, maxBackups = 20, backupIntervalMs = 30000, now = Date.now, debounceMs = 250, onError = null }) {
    this.file = file; this.backupDir = backupDir; this.seedFile = seedFile;
    this.maxBackups = maxBackups; this.backupIntervalMs = backupIntervalMs; this.now = now;
    this.debounceMs = debounceMs; this.onError = onError; this._timer = null; this._pending = false;
    this.data = null; this.recovered = false; this._lastBackup = 0; this._seq = 0;
  }

  init() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    if (!fs.existsSync(this.file)) {
      this.data = JSON.parse(fs.readFileSync(this.seedFile, 'utf8'));
      this._writeAtomic();
      return this;
    }
    let parsed = null;
    try { parsed = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch { parsed = null; }
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      this.data = parsed;
    } else {
      this.data = this._restoreFromBackup();
      fs.renameSync(this.file, `${this.file}.corrupt-${this.now()}`); // keep the damaged file for inspection
      this.recovered = true;
    }
    for (const c of COLLECTIONS) if (!Array.isArray(this.data[c])) this.data[c] = [];
    this._writeAtomic();
    return this;
  }

  /** Re-read db.json (the last state that was saved). Used to undo in-memory changes when a save fails. */
  reload() {
    this.data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    for (const c of COLLECTIONS) if (!Array.isArray(this.data[c])) this.data[c] = [];
    return this;
  }

  _restoreFromBackup() {
    const files = fs.existsSync(this.backupDir) ? fs.readdirSync(this.backupDir).filter(n => n.endsWith('.json')).sort().reverse() : [];
    for (const name of files) {
      try { return JSON.parse(fs.readFileSync(path.join(this.backupDir, name), 'utf8')); } catch { /* try older */ }
    }
    throw new Error('db.json is corrupted and no usable backup exists in ' + this.backupDir + '. The file was left untouched; restore it manually or delete it to re-seed.');
  }

  _writeAtomic() {
    const tmp = this.file + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, this.file);
  }

  _backup(force) {
    const t = this.now();
    if (!fs.existsSync(this.file) || (!force && t - this._lastBackup < this.backupIntervalMs)) return;
    fs.mkdirSync(this.backupDir, { recursive: true });
    const name = `db-${String(t).padStart(15, '0')}-${String(++this._seq).padStart(4, '0')}.json`;
    fs.copyFileSync(this.file, path.join(this.backupDir, name));
    this._lastBackup = t;
    const all = fs.readdirSync(this.backupDir).filter(n => n.endsWith('.json')).sort();
    for (const old of all.slice(0, Math.max(0, all.length - this.maxBackups))) fs.unlinkSync(path.join(this.backupDir, old));
  }

  /** Durable write now. Used for changes a person is waiting on (so a failure can be reported to them). Also covers anything pending. */
  save() {
    this._cancelTimer();
    this._backup();
    this._writeAtomic();
    this._pending = false;
  }

  /** Delayed, batched write for high-frequency progress (run steps, sign-in bookkeeping): many calls inside the window make ONE write.
   *  Call flush() on shutdown. If the delayed write fails, the change stays pending, onError is told, and it is retried. */
  saveSoon() {
    this._pending = true;
    if (this._timer) return;
    this._timer = setTimeout(() => this._tick(), this.debounceMs);
    if (this._timer.unref) this._timer.unref();
  }

  hasPendingWrite() { return this._pending; }

  /** Write pending changes immediately (shutdown, tests). Throws if the write fails. */
  flush() {
    this._cancelTimer();
    if (!this._pending) return;
    this._backup();
    this._writeAtomic();
    this._pending = false;
  }

  _cancelTimer() { if (this._timer) { clearTimeout(this._timer); this._timer = null; } }

  _tick() {
    this._timer = null;
    if (!this._pending) return;
    try { this._backup(); this._writeAtomic(); this._pending = false; } catch (e) {
      if (this.onError) this.onError(e);
      this._timer = setTimeout(() => this._tick(), Math.max(1000, this.debounceMs)); if (this._timer.unref) this._timer.unref();   // try again later
    }
  }

  replace(next) {
    const ok = next && typeof next === 'object' && !Array.isArray(next) && Object.values(next).every(Array.isArray);
    if (!ok) throw new Error('Invalid database: expected an object whose collections are arrays.');
    const prev = this.data;
    this._backup(true); // a whole-database replace always leaves a restore point, even inside the throttle window
    this.data = next;
    try { this._writeAtomic(); } catch (e) { this.data = prev; throw e; }
  }
}

module.exports = { Store };
