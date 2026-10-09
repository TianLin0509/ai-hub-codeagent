'use strict';

const os = require('os');
const path = require('node:path');
const { fork } = require('node:child_process');

// Keep optional snapshot dependencies out of module initialization. SessionManager
// deliberately wraps `new TerminalSnapshot()` so a damaged node_modules can fall
// back to its raw PTY ring buffer, but a top-level require used to throw before
// that guard existed and crashed the entire Electron main process at startup.
let snapshotDependencies = null;

function getSnapshotDependencies() {
  if (snapshotDependencies && snapshotDependencies.error) throw snapshotDependencies.error;
  if (snapshotDependencies) return snapshotDependencies;
  try {
    const { Terminal } = require('@xterm/headless');
    const { SerializeAddon } = require('@xterm/addon-serialize');
    snapshotDependencies = { Terminal, SerializeAddon };
    return snapshotDependencies;
  } catch (cause) {
    const error = new Error(`terminal snapshot dependencies unavailable: ${cause && cause.message}`);
    error.code = 'TERMINAL_SNAPSHOT_DEPENDENCY_MISSING';
    error.cause = cause;
    snapshotDependencies = { error };
    throw error;
  }
}

const DEFAULT_COLS = 120;
const DEFAULT_ROWS = 30;
const DEFAULT_SCROLLBACK = 10000;
const COMPACT_THRESHOLD_BYTES = 2 * 1024 * 1024;
const TERMINAL_REPLAY_CHUNK_CHARS = 64 * 1024;
const COMPACTOR_PROCESS_TIMEOUT_MS = 30 * 1000;

function yieldToEventLoop() {
  return new Promise(resolve => setImmediate(resolve));
}

// Headless xterm buffers are deliberately short-lived. A populated 10k-line
// terminal can use tens of MB; keeping another permanent parser per live Hub
// session would duplicate the renderer's lifecycle-managed xterm. Serialize /
// compaction jobs share one global lane so several noisy sessions cannot create
// large parsers at once.
const compactionJobs = [];
let compactionRunning = false;

async function drainCompactions() {
  if (compactionRunning) return;
  compactionRunning = true;
  try {
    while (compactionJobs.length) {
      const job = compactionJobs.shift();
      try { job.resolve(await job.operation()); } catch (error) { job.reject(error); }
      // Several noisy PTYs can cross the 2 MB compaction threshold together.
      // Yield between jobs so Electron's main thread can keep pumping window,
      // IPC and input messages instead of chaining every xterm replay through
      // the microtask queue and being marked "Not Responding" by Windows.
      if (compactionJobs.length) await yieldToEventLoop();
    }
  } finally {
    compactionRunning = false;
  }
}

function runCompaction(operation) {
  return new Promise((resolve, reject) => {
    compactionJobs.push({ operation, resolve, reject });
    void drainCompactions();
  });
}

function clampInt(value, fallback, min) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(min, Math.floor(n)) : fallback;
}

async function writeTerminal(terminal, text) {
  const source = String(text || '');
  for (let start = 0; start < source.length;) {
    let end = Math.min(source.length, start + TERMINAL_REPLAY_CHUNK_CHARS);
    // Do not split a UTF-16 surrogate pair. xterm's ANSI parser is streaming
    // and safely carries partial escape sequences across write calls.
    if (end < source.length) {
      const last = source.charCodeAt(end - 1);
      if (last >= 0xD800 && last <= 0xDBFF) end += 1;
    }
    await new Promise(resolve => terminal.write(source.slice(start, end), resolve));
    start = end;
    if (start < source.length) await yieldToEventLoop();
  }
}

function terminalOptions(cols, rows, scrollback) {
  return {
    cols,
    rows,
    scrollback,
    allowProposedApi: true,
    ...(process.platform === 'win32' ? {
      windowsPty: {
        backend: 'conpty',
        buildNumber: parseInt(os.release().split('.').pop(), 10) || 0,
      },
    } : {}),
  };
}

function compactOutOfProcess(payload) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const child = fork(path.join(__dirname, 'terminal-snapshot-compactor-process.js'), [], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      execPath: process.execPath,
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      serialization: 'advanced',
    });
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      try { if (child.connected) child.disconnect(); } catch {}
      try { if (!child.killed) child.kill(); } catch {}
      if (error) reject(error);
      else resolve(value);
    };
    const timeout = setTimeout(() => {
      finish(new Error(`terminal snapshot compactor timed out after ${COMPACTOR_PROCESS_TIMEOUT_MS}ms`));
    }, COMPACTOR_PROCESS_TIMEOUT_MS);
    timeout.unref?.();
    child.once('message', (message) => {
      if (!message || message.ok !== true) {
        finish(new Error(message && message.error ? message.error : 'terminal snapshot compactor failed'));
        return;
      }
      finish(null, String(message.base || ''));
    });
    child.once('error', error => { finish(error); });
    child.once('exit', (code) => {
      if (!settled) finish(new Error(`terminal snapshot compactor exited before replying (code ${code})`));
    });
    child.send(payload, (error) => { if (error) finish(error); });
  });
}

async function compactInProcess(payload, dependencies) {
  const terminal = new dependencies.Terminal(terminalOptions(
    payload.baseCols,
    payload.baseRows,
    payload.scrollback,
  ));
  const addon = new dependencies.SerializeAddon();
  terminal.loadAddon(addon);
  try {
    if (payload.base) await writeTerminal(terminal, payload.base);
    for (const operation of payload.operations) {
      if (operation.type === 'resize') {
        if (terminal.cols !== operation.cols || terminal.rows !== operation.rows) {
          terminal.resize(operation.cols, operation.rows);
        }
      } else if (operation.type === 'write') {
        await writeTerminal(terminal, operation.data);
      }
    }
    return Buffer.from(
      addon.serialize({ scrollback: payload.scrollback }),
      'utf8',
    ).toString('utf8');
  } finally {
    try { addon.dispose(); } catch {}
    try { terminal.dispose(); } catch {}
  }
}

function cloneCoalescedOperations(operations) {
  const result = [];
  let writeParts = [];
  const flushWrites = () => {
    if (!writeParts.length) return;
    result.push({ type: 'write', data: writeParts.join('') });
    writeParts = [];
  };
  for (const operation of operations) {
    if (operation.type === 'write') {
      writeParts.push(operation.data);
      continue;
    }
    flushWrites();
    if (operation.type === 'resize') {
      result.push({ type: 'resize', cols: operation.cols, rows: operation.rows });
    }
  }
  flushWrites();
  return result;
}

// Main-process terminal state without a permanently resident framebuffer.
//
// `_base` is a self-contained VT sequence produced by SerializeAddon; `_tail`
// contains complete raw PTY chunks that arrived after that exact sequence.
// Replaying base+tail can never start in the middle of an ANSI instruction,
// which is the defect in the old 1MB byte-tail restore. At snapshot time (or
// after 2MB of new output) we briefly replay into headless xterm, serialize a
// fresh base, then dispose the terminal and keep only strings in memory.
class TerminalSnapshot {
  constructor(opts = {}) {
    const dependencies = getSnapshotDependencies();
    this._Terminal = dependencies.Terminal;
    this._SerializeAddon = dependencies.SerializeAddon;
    this._scrollback = clampInt(opts.scrollback, DEFAULT_SCROLLBACK, 0);
    this._cols = clampInt(opts.cols, DEFAULT_COLS, 2);
    this._rows = clampInt(opts.rows, DEFAULT_ROWS, 1);
    this._baseCols = this._cols;
    this._baseRows = this._rows;
    this._base = '';
    this._tail = [];
    this._tailBytes = 0;
    this._operations = [];
    this._draining = false;
    this._seq = 0;
    this._disposed = false;
  }

  _append(operation) {
    return new Promise((resolve, reject) => {
      this._operations.push({ operation, resolve, reject });
      void this._drain();
    });
  }

  async _drain() {
    if (this._draining) return;
    this._draining = true;
    try {
      while (this._operations.length) {
        const job = this._operations.shift();
        try { job.resolve(await job.operation()); } catch (error) { job.reject(error); }
      }
    } finally {
      this._draining = false;
    }
  }

  async _compact() {
    if (this._disposed) return;
    if (this._tail.length === 0) return;
    const operations = this._tail;
    const hasWrites = operations.some((operation) => operation.type === 'write');
    if (!this._base && !hasWrites) {
      this._tail = [];
      this._tailBytes = 0;
      this._baseCols = this._cols;
      this._baseRows = this._rows;
      return;
    }

    await runCompaction(async () => {
      if (this._disposed) return;
      const payload = {
        base: this._base,
        baseCols: this._baseCols,
        baseRows: this._baseRows,
        scrollback: this._scrollback,
        operations,
      };
      let nextBase;
      try {
        // Headless xterm can transiently allocate ~100 MB for a 10k-line
        // framebuffer. Run it in a short-lived Node child process: CPU parsing
        // cannot block Electron's window message pump, and process exit returns
        // the cell buffers instead of retaining them once per live Hub session.
        nextBase = await compactOutOfProcess(payload);
      } catch (compactorError) {
        // Packaged/runtime helper failures must not destroy terminal recovery.
        // Keep a complete in-process fallback, but make the degradation visible.
        console.warn('[terminal-snapshot] compactor process failed, using responsive in-process fallback:', compactorError && compactorError.message);
        nextBase = await compactInProcess(payload, {
          Terminal: this._Terminal,
          SerializeAddon: this._SerializeAddon,
        });
      }
      if (this._disposed) return;
      this._base = nextBase;
      this._tail = [];
      this._tailBytes = 0;
      this._baseCols = this._cols;
      this._baseRows = this._rows;
    });
  }

  write(data, seq) {
    if (this._disposed || data == null || data === '') return;
    const text = String(data);
    const outputSeq = Number(seq);
    void this._append(async () => {
      if (this._disposed) return;
      this._tail.push({ type: 'write', data: text });
      this._tailBytes += Buffer.byteLength(text, 'utf8');
      if (Number.isFinite(outputSeq)) this._seq = Math.max(this._seq, outputSeq);
      if (this._tailBytes >= COMPACT_THRESHOLD_BYTES) await this._compact();
    });
  }

  resize(cols, rows) {
    if (this._disposed) return;
    const nextCols = clampInt(cols, this._cols, 2);
    const nextRows = clampInt(rows, this._rows, 1);
    void this._append(async () => {
      if (this._disposed || (nextCols === this._cols && nextRows === this._rows)) return;
      // Record geometry changes in the same ordered operation log as PTY data.
      // Replaying them at compaction preserves xterm reflow semantics without
      // constructing a large headless terminal for every resize event.
      this._tail.push({ type: 'resize', cols: nextCols, rows: nextRows });
      this._cols = nextCols;
      this._rows = nextRows;
    });
  }

  snapshot() {
    if (this._disposed) return Promise.resolve(null);
    // Queueing is still the exact seq barrier used by renderer hydrate, but do
    // not force a headless-xterm compaction here. A group of resumed sessions
    // can each have megabytes of TUI history; serializing all of them through
    // the global compaction lane made every newly opened PTY remain blank until
    // the earlier sessions finished replaying.
    //
    // `_base` is already self-contained. `_tail` stores complete ordered write
    // chunks plus geometry changes, so the renderer can replay it losslessly.
    // Adjacent writes are joined to keep IPC payloads small. Threshold-driven
    // background compaction still bounds long-lived memory use.
    return this._append(async () => {
      if (this._disposed) return null;
      const operations = cloneCoalescedOperations(this._tail);
      const hasResize = operations.some((operation) => operation.type === 'resize');
      if (!hasResize) {
        const writes = operations
          .filter((operation) => operation.type === 'write')
          .map((operation) => operation.data);
        return {
          text: [this._base, ...writes].join(''),
          operations: null,
          seq: this._seq,
          source: 'ordered-vt-fast-snapshot',
          cols: this._cols,
          rows: this._rows,
          baseCols: this._baseCols,
          baseRows: this._baseRows,
        };
      }
      return {
        text: this._base,
        operations,
        seq: this._seq,
        source: 'ordered-vt-operations-snapshot',
        cols: this._cols,
        rows: this._rows,
        baseCols: this._baseCols,
        baseRows: this._baseRows,
      };
    });
  }

  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    this._base = '';
    this._tail = [];
    this._tailBytes = 0;
  }
}

module.exports = {
  COMPACT_THRESHOLD_BYTES,
  DEFAULT_SCROLLBACK,
  TerminalSnapshot,
  _private: {
    TERMINAL_REPLAY_CHUNK_CHARS,
    compactInProcess,
    compactOutOfProcess,
    writeTerminal,
    yieldToEventLoop,
  },
};
