'use strict';

const path = require('node:path');
const { Worker } = require('node:worker_threads');

class TranscriptParserService {
  constructor(opts = {}) {
    this._Worker = opts.Worker || Worker;
    this._workerPath = opts.workerPath || path.join(__dirname, 'transcript-parser-worker.js');
    this._worker = null;
    this._nextId = 0;
    this._pendingById = new Map();
    this._inFlightByKey = new Map();
    this._closed = false;
    this._stats = { submitted: 0, coalesced: 0, completed: 0, cacheHits: 0, workerRestarts: 0 };
  }

  _ensureWorker() {
    if (this._closed) throw new Error('Transcript parser service is closed');
    if (this._worker) return this._worker;
    const worker = new this._Worker(this._workerPath);
    worker.unref?.();
    worker.on('message', (message) => this._handleMessage(message));
    worker.on('error', (error) => this._handleWorkerFailure(error));
    worker.on('exit', (code) => {
      if (this._worker !== worker) return;
      this._worker = null;
      if (!this._closed && code !== 0) this._handleWorkerFailure(new Error(`Transcript parser worker exited with code ${code}`));
    });
    this._worker = worker;
    this._stats.workerRestarts += 1;
    return worker;
  }

  _handleMessage(message) {
    const pending = message && this._pendingById.get(message.id);
    if (!pending) return;
    this._pendingById.delete(message.id);
    this._inFlightByKey.delete(pending.key);
    if (message.error) {
      pending.reject(new Error(message.error));
      return;
    }
    this._stats.completed += 1;
    if (message.meta && message.meta.cacheHit) this._stats.cacheHits += 1;
    pending.resolve({ turns: Array.isArray(message.turns) ? message.turns : [], meta: message.meta || {} });
  }

  _handleWorkerFailure(error) {
    const worker = this._worker;
    this._worker = null;
    if (worker) worker.removeAllListeners();
    for (const pending of this._pendingById.values()) pending.reject(error);
    this._pendingById.clear();
    this._inFlightByKey.clear();
  }

  parse(kind, transcriptPath, opts = {}) {
    const normalizedOpts = opts && typeof opts === 'object' ? { ...opts } : {};
    const key = `${kind}\0${transcriptPath}\0${JSON.stringify(normalizedOpts)}`;
    const existing = this._inFlightByKey.get(key);
    if (existing) {
      this._stats.coalesced += 1;
      return existing;
    }

    const id = ++this._nextId;
    const promise = new Promise((resolve, reject) => {
      this._pendingById.set(id, { key, resolve, reject });
      try {
        this._ensureWorker().postMessage({ id, kind, transcriptPath, opts: normalizedOpts });
        this._stats.submitted += 1;
      } catch (error) {
        this._pendingById.delete(id);
        reject(error);
      }
    }).finally(() => {
      if (this._inFlightByKey.get(key) === promise) this._inFlightByKey.delete(key);
    });
    this._inFlightByKey.set(key, promise);
    return promise;
  }

  getStats() {
    return { ...this._stats, pending: this._pendingById.size, inFlightKeys: this._inFlightByKey.size };
  }

  async close() {
    if (this._closed) return;
    this._closed = true;
    const error = new Error('Transcript parser service closed');
    for (const pending of this._pendingById.values()) pending.reject(error);
    this._pendingById.clear();
    this._inFlightByKey.clear();
    const worker = this._worker;
    this._worker = null;
    if (worker) await worker.terminate();
  }
}

module.exports = { TranscriptParserService };
