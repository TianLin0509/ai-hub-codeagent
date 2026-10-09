'use strict';

// Periodic telemetry runs small programs (nvidia-smi, netstat, tasklist). The
// callback API is asynchronous, but on Windows libuv creates the process
// (CreateProcess + handle setup) synchronously on the calling thread. On the
// live Hub (2026-10-08, loaded machine with endpoint security hooks) a single
// spawn held the main thread 69-751 ms; every click, IPC reply and window
// message queued behind it. A worker thread has its own event loop, so the
// same execFile there leaves the main thread free. Results are identical:
// same program, arguments, options and stdout.
const path = require('node:path');
const { execFile } = require('node:child_process');
const { Worker, isMainThread, parentPort } = require('node:worker_threads');

if (!isMainThread && parentPort) {
  parentPort.on('message', ({ id, file, args, options }) => {
    execFile(file, args, { ...options, encoding: 'utf8' }, (error, stdout, stderr) => {
      parentPort.postMessage(error
        ? { id, error: { message: error.message, code: error.code, killed: error.killed, signal: error.signal }, stdout, stderr }
        : { id, stdout, stderr });
    });
  });
}

function createOffMainExecFile({ WorkerImpl = Worker, fallback = execFile } = {}) {
  let worker = null;
  let nextId = 0;
  const pending = new Map();

  function failAll(error) {
    for (const { reject } of pending.values()) reject(error);
    pending.clear();
  }

  function ensureWorker() {
    if (worker) return worker;
    const created = new WorkerImpl(path.join(__dirname, 'off-main-exec.js'));
    created.on('message', message => {
      const entry = pending.get(message.id);
      if (!entry) return;
      pending.delete(message.id);
      // Only an in-flight command keeps the process alive.
      if (!pending.size) created.unref?.();
      if (!message.error) { entry.resolve({ stdout: message.stdout, stderr: message.stderr }); return; }
      const error = Object.assign(new Error(message.error.message), message.error, { stdout: message.stdout, stderr: message.stderr });
      entry.reject(error);
    });
    const reset = error => {
      if (worker !== created) return;
      worker = null;
      failAll(error);
    };
    created.on('error', reset);
    created.on('exit', code => reset(new Error(`off-main exec worker exited (${code})`)));
    created.unref?.();
    worker = created;
    return worker;
  }

  // Same shape as util.promisify(child_process.execFile): resolves { stdout, stderr }.
  return function execFileOffMain(file, args = [], options = {}) {
    let target;
    try { target = ensureWorker(); }
    catch {
      // No worker available: keep the feature working on the main thread.
      return new Promise((resolve, reject) => fallback(file, args, { ...options, encoding: 'utf8' },
        (error, stdout, stderr) => (error ? reject(Object.assign(error, { stdout, stderr })) : resolve({ stdout, stderr }))));
    }
    return new Promise((resolve, reject) => {
      const id = ++nextId;
      pending.set(id, { resolve, reject });
      target.ref?.();
      try { target.postMessage({ id, file, args, options }); }
      catch (error) { pending.delete(id); reject(error); }
    });
  };
}

let shared = null;
function sharedOffMainExecFile() {
  if (!shared) shared = createOffMainExecFile();
  return shared;
}

module.exports = { createOffMainExecFile, sharedOffMainExecFile };
