'use strict';

const path = require('node:path');
const { Worker } = require('node:worker_threads');

class CodexJsonlUsageService {
  constructor(opts = {}) {
    this._Worker = opts.Worker || Worker;
    this._workerPath = opts.workerPath || path.join(__dirname, 'codex-jsonl-usage-worker.js');
    this._worker = null;
    this._nextId = 0;
    this._pending = new Map();
    this._inFlight = new Map();
    this._closed = false;
    this._stats = { submitted: 0, coalesced: 0, completed: 0, restarts: 0 };
  }

  _ensureWorker() {
    if (this._closed) throw new Error('Codex JSONL usage service is closed');
    if (this._worker) return this._worker;
    const worker = new this._Worker(this._workerPath);
    worker.unref?.();
    worker.on('message', message => this._onMessage(message));
    worker.on('error', error => this._fail(error));
    worker.on('exit', code => {
      if (this._worker !== worker) return;
      this._worker = null;
      if (!this._closed && code !== 0) this._fail(new Error(`Codex JSONL usage worker exited with code ${code}`));
    });
    this._worker = worker;
    this._stats.restarts += 1;
    return worker;
  }

  _onMessage(message) {
    const pending = message && this._pending.get(message.id);
    if (!pending) return;
    this._pending.delete(message.id);
    this._inFlight.delete(pending.key);
    if (message.error) pending.reject(new Error(message.error));
    else {
      this._stats.completed += 1;
      pending.resolve({ data: message.data || null, meta: message.meta || {} });
    }
  }

  _fail(error) {
    const worker = this._worker;
    this._worker = null;
    if (worker) worker.removeAllListeners();
    for (const pending of this._pending.values()) pending.reject(error);
    this._pending.clear();
    this._inFlight.clear();
  }

  scan(sessionsDir, opts = {}) {
    const normalizedOpts = opts && typeof opts === 'object' ? { ...opts } : {};
    const key = `${sessionsDir}\0${JSON.stringify(normalizedOpts)}`;
    const existing = this._inFlight.get(key);
    if (existing) {
      this._stats.coalesced += 1;
      return existing;
    }
    const id = ++this._nextId;
    const promise = new Promise((resolve, reject) => {
      this._pending.set(id, { key, resolve, reject });
      try {
        this._ensureWorker().postMessage({ id, sessionsDir, opts: normalizedOpts });
        this._stats.submitted += 1;
      } catch (error) {
        this._pending.delete(id);
        reject(error);
      }
    }).finally(() => {
      if (this._inFlight.get(key) === promise) this._inFlight.delete(key);
    });
    this._inFlight.set(key, promise);
    return promise;
  }

  getStats() {
    return { ...this._stats, pending: this._pending.size, inFlight: this._inFlight.size };
  }

  async close() {
    if (this._closed) return;
    this._closed = true;
    const error = new Error('Codex JSONL usage service closed');
    for (const pending of this._pending.values()) pending.reject(error);
    this._pending.clear();
    this._inFlight.clear();
    const worker = this._worker;
    this._worker = null;
    if (worker) await worker.terminate();
  }
}

module.exports = { CodexJsonlUsageService };
