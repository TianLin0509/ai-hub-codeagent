'use strict';

const path = require('path');

function normalizeWatchKey(value) {
  const resolved = path.resolve(String(value || ''));
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function fileSignature(fsImpl, filePath) {
  try {
    const stat = fsImpl.statSync(filePath);
    const mtimeMs = Number(stat.mtimeMs) || 0;
    const ctimeMs = Number(stat.ctimeMs) || 0;
    const birthtimeMs = Number(stat.birthtimeMs) || 0;
    const size = Number(stat.size) || 0;
    const dev = Number(stat.dev) || 0;
    const ino = Number(stat.ino) || 0;
    return {
      exists: true,
      missing: false,
      mtimeMs,
      size,
      signature: `${dev}:${ino}:${birthtimeMs}:${ctimeMs}:${mtimeMs}:${size}`,
    };
  } catch (error) {
    const errorCode = String(error && error.code || 'unknown');
    const missing = errorCode === 'ENOENT' || errorCode === 'ENOTDIR';
    return {
      exists: missing ? false : null,
      missing,
      mtimeMs: 0,
      size: 0,
      signature: `${missing ? 'missing' : 'error'}:${errorCode}:${String(error && error.message || error)}`,
      error: String(error && error.message || error),
      errorCode,
    };
  }
}

function createPreviewFileWatchManager({
  fs,
  debounceMs = 140,
  retryMs = 800,
  maxRetryMs = 8000,
  onError = () => {},
} = {}) {
  const directories = new Map();
  const intentionallyClosed = new WeakSet();
  const failedWatcherClosures = new Set();
  let disposed = false;

  function emit(entry, payload) {
    for (const file of entry.files.values()) {
      for (const listener of [...file.listeners]) {
        try { listener({ path: file.path, ...payload }); }
        catch (error) { onError(error, file.path); }
      }
    }
  }

  function closeWatcher(entry) {
    const watcher = entry.watcher;
    entry.watcher = null;
    if (!watcher) return;
    intentionallyClosed.add(watcher);
    try {
      watcher.close?.();
      failedWatcherClosures.delete(watcher);
      return true;
    } catch (error) {
      failedWatcherClosures.add(watcher);
      try { onError(error, entry.path); } catch (_) {}
      return false;
    }
  }

  function retryFailedWatcherClosures() {
    for (const watcher of [...failedWatcherClosures]) {
      try {
        watcher.close?.();
        failedWatcherClosures.delete(watcher);
      } catch (error) {
        try { onError(error, 'watcher cleanup'); } catch (_) {}
      }
    }
  }

  function scheduleRetry(entry) {
    if (disposed || entry.retryTimer || entry.files.size === 0 || !directories.has(entry.key)) return;
    const delay = Math.min(maxRetryMs, retryMs * Math.max(1, 2 ** entry.retryAttempt));
    entry.retryAttempt += 1;
    entry.retryTimer = setTimeout(() => {
      entry.retryTimer = null;
      startWatcher(entry);
    }, Math.max(10, Number(delay) || 10));
    entry.retryTimer.unref?.();
  }

  function handleWatchFailure(entry, error) {
    if (disposed || !directories.has(entry.key)) return;
    closeWatcher(entry);
    const message = String(error && error.message || error || 'watch unavailable');
    const changed = entry.lastError !== message;
    entry.lastError = message;
    onError(error instanceof Error ? error : new Error(message), entry.path);
    if (changed) emit(entry, { eventType: 'watch-error', exists: null, watchError: message });
    scheduleRetry(entry);
  }

  function startWatcher(entry) {
    if (disposed || entry.watcher || !directories.has(entry.key) || entry.files.size === 0) return;
    if (!fs || typeof fs.watch !== 'function') {
      handleWatchFailure(entry, new Error('fs.watch unavailable'));
      return;
    }
    try {
      const watcher = fs.watch(entry.path, { persistent: false }, (eventType, filename) => {
        if (disposed || entry.watcher !== watcher) return;
        const changedName = filename == null ? '' : String(filename);
        const changedKey = process.platform === 'win32' ? changedName.toLowerCase() : changedName;
        for (const file of entry.files.values()) {
          const fileName = path.basename(file.path);
          const fileNameKey = process.platform === 'win32' ? fileName.toLowerCase() : fileName;
          if (!changedKey || changedKey === fileNameKey) notifyFile(entry, file, eventType);
        }
      });
      entry.watcher = watcher;
      watcher.on?.('error', error => {
        if (entry.watcher !== watcher) return;
        handleWatchFailure(entry, error);
      });
      watcher.on?.('close', () => {
        if (intentionallyClosed.has(watcher) || entry.watcher !== watcher) return;
        handleWatchFailure(entry, new Error('watcher closed unexpectedly'));
      });
      watcher.unref?.();
      const recovered = !!entry.lastError;
      entry.lastError = null;
      entry.retryAttempt = 0;
      if (recovered) {
        emit(entry, { eventType: 'watch-recovered', exists: null, watchError: null });
        for (const file of entry.files.values()) notifyFile(entry, file, 'watch-recovered-scan');
      }
    } catch (error) {
      handleWatchFailure(entry, error);
    }
  }

  function closeDirectory(entry) {
    closeWatcher(entry);
    if (entry.retryTimer) clearTimeout(entry.retryTimer);
    entry.retryTimer = null;
    for (const file of entry.files.values()) {
      if (file.timer) clearTimeout(file.timer);
    }
    entry.files.clear();
    directories.delete(entry.key);
  }

  function notifyFile(directoryEntry, file, eventType) {
    if (disposed || file.timer) return;
    file.timer = setTimeout(() => {
      file.timer = null;
      if (disposed || !directoryEntry.files.has(file.key)) return;
      const next = fileSignature(fs, file.path);
      if (next.signature === file.signature && eventType !== 'rename') return;
      file.signature = next.signature;
      for (const listener of [...file.listeners]) {
        try {
          listener({
            path: file.path,
            exists: next.exists,
            missing: next.missing,
            mtimeMs: next.mtimeMs,
            size: next.size,
            eventType,
            error: next.error,
            errorCode: next.errorCode,
          });
        } catch (error) {
          onError(error, file.path);
        }
      }
    }, Math.max(0, Number(debounceMs) || 0));
  }

  function ensureDirectory(directoryPath) {
    const key = normalizeWatchKey(directoryPath);
    let entry = directories.get(key);
    if (entry) return entry;
    entry = {
      key,
      path: directoryPath,
      files: new Map(),
      watcher: null,
      retryTimer: null,
      retryAttempt: 0,
      lastError: null,
    };
    directories.set(key, entry);
    return entry;
  }

  function subscribe(filePath, listener) {
    if (disposed || !path.isAbsolute(String(filePath || '')) || typeof listener !== 'function') {
      return { active: false, dispose() {} };
    }
    const absolutePath = path.resolve(filePath);
    const directoryEntry = ensureDirectory(path.dirname(absolutePath));
    const key = normalizeWatchKey(absolutePath);
    let file = directoryEntry.files.get(key);
    if (!file) {
      file = {
        key,
        path: absolutePath,
        listeners: new Set(),
        timer: null,
        signature: fileSignature(fs, absolutePath).signature,
      };
      directoryEntry.files.set(key, file);
    }
    const priorWatchError = directoryEntry.lastError;
    file.listeners.add(listener);
    if (priorWatchError) {
      listener({
        path: file.path,
        eventType: 'watch-error',
        exists: null,
        watchError: priorWatchError,
      });
    }
    if (!directoryEntry.watcher) startWatcher(directoryEntry);
    let active = true;
    return {
      active: true,
      dispose() {
        if (!active) return;
        active = false;
        file.listeners.delete(listener);
        if (file.listeners.size > 0) return;
        if (file.timer) clearTimeout(file.timer);
        directoryEntry.files.delete(key);
        if (directoryEntry.files.size === 0) closeDirectory(directoryEntry);
      },
    };
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    for (const entry of [...directories.values()]) closeDirectory(entry);
    retryFailedWatcherClosures();
    return {
      ok: failedWatcherClosures.size === 0,
      cleanupFailures: failedWatcherClosures.size,
    };
  }

  return {
    subscribe,
    dispose,
    getStats: () => ({
      directories: directories.size,
      files: [...directories.values()].reduce((sum, entry) => sum + entry.files.size, 0),
      listeners: [...directories.values()].reduce((sum, entry) => (
        sum + [...entry.files.values()].reduce((fileSum, file) => fileSum + file.listeners.size, 0)
      ), 0),
      degradedDirectories: [...directories.values()].filter(entry => !!entry.lastError).length,
      cleanupFailures: failedWatcherClosures.size,
    }),
  };
}

module.exports = {
  createPreviewFileWatchManager,
  fileSignature,
  normalizeWatchKey,
};
