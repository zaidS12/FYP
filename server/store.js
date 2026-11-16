'use strict';
/* Atomic JSON file store with rolling backups and corruption recovery. Zero dependencies. */
const fs = require('node:fs');
const path = require('node:path');

const COLLECTIONS = ['tenants', 'users', 'sessions', 'devices', 'loginEvents', 'plans', 'subscriptions', 'invoices', 'payments',
  'flows', 'flowVersions', 'runs', 'runSteps', 'templates', 'usage', 'auditLog', 'presence', 'locks'];

class Store {
  constructor({ file, backupDir, seedFile, maxBackups = 20, backupIntervalMs = 30000, now = Date.now }) {
    this.file = file; this.backupDir = backupDir; this.seedFile = seedFile;
    this.maxBackups = maxBackups; this.backupIntervalMs = backupIntervalMs; this.now = now;
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

  _backup() {
    const t = this.now();
    if (!fs.existsSync(this.file) || t - this._lastBackup < this.backupIntervalMs) return;
    fs.mkdirSync(this.backupDir, { recursive: true });
    const name = `db-${String(t).padStart(15, '0')}-${String(++this._seq).padStart(4, '0')}.json`;
    fs.copyFileSync(this.file, path.join(this.backupDir, name));
    this._lastBackup = t;
    const all = fs.readdirSync(this.backupDir).filter(n => n.endsWith('.json')).sort();
    for (const old of all.slice(0, Math.max(0, all.length - this.maxBackups))) fs.unlinkSync(path.join(this.backupDir, old));
  }

  save() {
    this._backup();
    this._writeAtomic();
  }

  replace(next) {
    const ok = next && typeof next === 'object' && !Array.isArray(next) && Object.values(next).every(Array.isArray);
    if (!ok) throw new Error('Invalid database: expected an object whose collections are arrays.');
    this.data = next;
    this.save();
  }
}

module.exports = { Store };
