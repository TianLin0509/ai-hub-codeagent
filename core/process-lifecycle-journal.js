'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const SCHEMA_VERSION = 1;
const DEFAULT_HEARTBEAT_MS = 10_000;

function limitText(value, maxLength = 4000) {
  const text = String(value == null ? '' : value);
  return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
}

function errorDetails(error) {
  if (!error) return { name: null, message: null, stack: null };
  return {
    name: limitText(error.name || 'Error', 160),
    message: limitText(error.message || error, 1000),
    stack: limitText(error.stack || '', 6000),
  };
}

function resolveLifecyclePaths(options = {}) {
  const processRef = options.processRef || process;
  const dataDir = path.resolve(
    options.dataDir
      || processRef.env && processRef.env.CLAUDE_HUB_DATA_DIR
      || path.join(os.homedir(), '.ai-hub-community'),
  );
  const diagnosticsDir = path.join(dataDir, 'diagnostics');
  const pid = Number(processRef.pid) || 0;
  return {
    dataDir,
    diagnosticsDir,
    journalPath: path.join(diagnosticsDir, `process-lifecycle-${pid}.jsonl`),
    heartbeatPath: path.join(diagnosticsDir, `process-lifecycle-${pid}.heartbeat.json`),
  };
}

function installProcessLifecycleJournal(options = {}) {
  const app = options.app;
  const BrowserWindow = options.BrowserWindow;
  const processRef = options.processRef || process;
  const fsRef = options.fsRef || fs;
  const now = options.now || Date.now;
  const setIntervalFn = options.setIntervalFn || setInterval;
  const clearIntervalFn = options.clearIntervalFn || clearInterval;
  const configuredHeartbeatMs = Number(options.heartbeatMs);
  const heartbeatMs = Number.isFinite(configuredHeartbeatMs)
    ? Math.max(1000, configuredHeartbeatMs)
    : DEFAULT_HEARTBEAT_MS;
  const appVersion = (() => {
    try { return app && typeof app.getVersion === 'function' ? app.getVersion() : null; } catch { return null; }
  })();
  const paths = resolveLifecyclePaths({ ...options, processRef });
  const listeners = [];
  const windowIds = new Set();
  let heartbeatTimer = null;
  let disposed = false;
  let lastWriteError = null;
  let state = {
    phase: 'starting',
    cleanExit: false,
    lastEvent: null,
  };

  function safeMkdir() {
    try {
      fsRef.mkdirSync(paths.diagnosticsDir, { recursive: true });
      return true;
    } catch (error) {
      lastWriteError = error;
      return false;
    }
  }

  function getWindowCount() {
    try {
      if (BrowserWindow && typeof BrowserWindow.getAllWindows === 'function') {
        return BrowserWindow.getAllWindows().length;
      }
    } catch {}
    return windowIds.size;
  }

  function processSnapshot() {
    let memory = null;
    let uptimeSec = null;
    try {
      if (typeof processRef.memoryUsage === 'function') {
        const usage = processRef.memoryUsage();
        memory = {
          rss: Number(usage.rss) || 0,
          heapUsed: Number(usage.heapUsed) || 0,
          external: Number(usage.external) || 0,
        };
      }
    } catch {}
    try {
      if (typeof processRef.uptime === 'function') uptimeSec = Math.round(processRef.uptime() * 1000) / 1000;
    } catch {}
    return { memory, uptimeSec };
  }

  function baseRecord(eventName, details = {}) {
    const epochMs = Number(now()) || Date.now();
    return {
      schemaVersion: SCHEMA_VERSION,
      ts: new Date(epochMs).toISOString(),
      epochMs,
      pid: Number(processRef.pid) || 0,
      ppid: Number(processRef.ppid) || 0,
      appVersion,
      event: eventName,
      phase: state.phase,
      cleanExit: state.cleanExit,
      windowCount: getWindowCount(),
      ...details,
    };
  }

  function append(eventName, details = {}) {
    state.lastEvent = eventName;
    const record = baseRecord(eventName, details);
    try {
      if (safeMkdir()) fsRef.appendFileSync(paths.journalPath, `${JSON.stringify(record)}\n`, 'utf8');
    } catch (error) {
      lastWriteError = error;
    }
    return record;
  }

  function writeHeartbeat(reason = 'heartbeat') {
    const snapshot = processSnapshot();
    const heartbeat = baseRecord(reason, {
      lastEvent: state.lastEvent,
      ...snapshot,
    });
    try {
      if (safeMkdir()) fsRef.writeFileSync(paths.heartbeatPath, JSON.stringify(heartbeat, null, 2), 'utf8');
    } catch (error) {
      lastWriteError = error;
    }
    return heartbeat;
  }

  function record(eventName, details = {}, phase = null) {
    if (phase) state.phase = phase;
    const result = append(eventName, details);
    writeHeartbeat(eventName);
    return result;
  }

  function on(emitter, eventName, handler) {
    if (!emitter || typeof emitter.on !== 'function') return;
    try {
      emitter.on(eventName, handler);
      listeners.push({ emitter, eventName, handler });
    } catch {}
  }

  function attachWindow(window) {
    if (!window) return;
    const windowId = Number(window.id) || 0;
    const webContentsId = Number(window.webContents && window.webContents.id) || 0;
    windowIds.add(windowId);
    let title = '';
    try { if (typeof window.getTitle === 'function') title = limitText(window.getTitle(), 300); } catch {}
    record('window-created', { windowId, webContentsId, title }, 'running');
    on(window, 'close', () => record('window-close-requested', { windowId, webContentsId }));
    on(window, 'closed', () => {
      windowIds.delete(windowId);
      record('window-closed', { windowId, webContentsId });
    });
    on(window, 'unresponsive', () => record('window-unresponsive', { windowId, webContentsId }));
    on(window, 'responsive', () => record('window-responsive', { windowId, webContentsId }));
    on(window, 'session-end', () => record('window-session-end', { windowId, webContentsId }, 'session-end'));
  }

  const cwd = (() => {
    try { return typeof processRef.cwd === 'function' ? processRef.cwd() : null; } catch { return null; }
  })();
  record('process-start', {
    appVersion,
    cwd,
    execPath: limitText(processRef.execPath || '', 1000),
    versions: {
      node: processRef.versions && processRef.versions.node || null,
      electron: processRef.versions && processRef.versions.electron || null,
      chrome: processRef.versions && processRef.versions.chrome || null,
    },
  }, 'starting');

  on(processRef, 'uncaughtExceptionMonitor', (error, origin) => {
    record('uncaught-exception-monitor', {
      origin: limitText(origin || '', 160),
      error: errorDetails(error),
    }, 'uncaught-exception');
  });
  on(processRef, 'exit', (code) => {
    record('process-exit', { code: Number(code) || 0 }, state.cleanExit ? 'process-exit-clean' : 'process-exit-unexpected');
  });

  on(app, 'ready', () => record('app-ready', {}, 'running'));
  on(app, 'browser-window-created', (_event, window) => attachWindow(window));
  on(app, 'window-all-closed', () => record('window-all-closed', {}, 'window-all-closed'));
  on(app, 'before-quit', () => record('app-before-quit', {}, 'before-quit'));
  on(app, 'will-quit', () => {
    state.cleanExit = processRef.__hubShutdownCleanupClean !== false;
    record('app-will-quit', {}, state.cleanExit ? 'will-quit' : 'will-quit-degraded');
  });
  on(app, 'quit', (_event, exitCode) => {
    state.cleanExit = state.cleanExit && processRef.__hubShutdownCleanupClean !== false;
    record('app-quit', { exitCode: Number(exitCode) || 0 }, state.cleanExit ? 'quit' : 'quit-degraded');
    if (heartbeatTimer) {
      try { clearIntervalFn(heartbeatTimer); } catch {}
      heartbeatTimer = null;
    }
  });
  on(app, 'render-process-gone', (_event, webContents, details = {}) => {
    record('render-process-gone', {
      webContentsId: Number(webContents && webContents.id) || 0,
      reason: limitText(details.reason || '', 160),
      exitCode: Number(details.exitCode) || 0,
    });
  });
  on(app, 'child-process-gone', (_event, details = {}) => {
    record('child-process-gone', {
      childType: limitText(details.type || '', 160),
      name: limitText(details.name || '', 300),
      serviceName: limitText(details.serviceName || '', 300),
      reason: limitText(details.reason || '', 160),
      exitCode: Number(details.exitCode) || 0,
    });
  });

  try {
    heartbeatTimer = setIntervalFn(() => writeHeartbeat('heartbeat'), heartbeatMs);
    if (heartbeatTimer && typeof heartbeatTimer.unref === 'function') heartbeatTimer.unref();
  } catch (error) {
    lastWriteError = error;
  }

  if (app && typeof app.isReady === 'function') {
    try { if (app.isReady()) record('app-already-ready', {}, 'running'); } catch {}
  }

  return {
    paths: { ...paths },
    record,
    writeHeartbeat,
    getHealth: () => ({
      installed: !disposed,
      phase: state.phase,
      cleanExit: state.cleanExit,
      lastEvent: state.lastEvent,
      lastWriteError: lastWriteError ? limitText(lastWriteError.message || lastWriteError, 1000) : null,
      paths: { ...paths },
    }),
    dispose({ recordEvent = true } = {}) {
      if (disposed) return;
      disposed = true;
      if (recordEvent) record('journal-disposed', {}, 'disposed');
      if (heartbeatTimer) {
        try { clearIntervalFn(heartbeatTimer); } catch {}
        heartbeatTimer = null;
      }
      for (const listener of listeners.splice(0)) {
        try {
          if (typeof listener.emitter.removeListener === 'function') {
            listener.emitter.removeListener(listener.eventName, listener.handler);
          }
        } catch {}
      }
    },
  };
}

module.exports = {
  DEFAULT_HEARTBEAT_MS,
  errorDetails,
  installProcessLifecycleJournal,
  limitText,
  resolveLifecyclePaths,
};
