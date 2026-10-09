'use strict';
const path = require('path');
const { Worker } = require('worker_threads');

function createDiskReleaseService(options = {}) {
  let worker = null; let sequence = 0; let busy = false; let kind = null;
  let status = { phase: 'idle', message: '' }; let lastResult = null; let lastUsage = null;
  const pending = new Map();
  function reset(error) {
    for (const request of pending.values()) request.reject(error);
    pending.clear(); busy = false; kind = null; worker = null;
  }
  function start() {
    if (worker) return;
    worker = new Worker(path.join(__dirname, 'disk-release-worker.js'), { workerData: { dataDir: options.dataDir, testRoot: options.testRoot } });
    worker.unref();
    worker.on('message', message => {
      if (message.progress) {
        status = { ...message.progress, kind };
        options.onProgress?.(status);
        return;
      }
      const request = pending.get(message.id);
      if (!request) return;
      pending.delete(message.id); busy = false;
      if (message.error) {
        status = { phase: 'error', message: message.error, kind };
        request.reject(new Error(message.error));
      } else {
        status = { phase: 'idle', message: '', kind };
        if (kind === 'execute') lastResult = message.result;
        if (kind === 'usage') lastUsage = message.result;
        request.resolve(message.result);
      }
      kind = null;
    });
    worker.on('error', error => reset(error));
    worker.on('exit', code => { if (worker) reset(new Error(`硬盘扫描工作进程退出（${code}），请重新扫描`)); });
  }
  function run(method, request) {
    if (busy) return Promise.reject(new Error('已有扫描或清理正在进行'));
    start(); busy = true; kind = method;
    const id = ++sequence;
    return new Promise((resolve, reject) => { pending.set(id, { resolve, reject }); worker.postMessage({ id, method, request }); });
  }
  return {
    scan: () => run('scan'), execute: request => run('execute', request),
    analyzeUsage: () => run('usage'),
    status: () => ({ ...status, busy, kind, completedKind: busy ? null : status.kind, lastResult, lastUsage }),
    cancelScan: () => { if (busy && ['scan', 'usage'].includes(kind)) worker?.postMessage({ method: 'cancel' }); },
    stop: () => { const owned = worker; worker = null; reset(new Error('Hub 已退出')); return owned?.terminate(); },
  };
}
module.exports = { createDiskReleaseService };
