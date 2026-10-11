'use strict';

// Opt-in self-profiler for the Electron main process (2026-10-11).
//
// The production Hub never sets these variables, so this module does nothing
// there: no timers, no inspector session, no file access. Performance work
// sets them on an isolated Hub (tests/helpers/hub-launcher.js does not accept
// extra Electron flags, so `--inspect` / `--cpu-prof` are not an option).
//
//   HUB_MAIN_CPU_PROFILE=<seconds>         enable; profile length (1..600)
//   HUB_MAIN_CPU_PROFILE_TRIGGER=<path>    start when this file appears (polled 1/s)
//   HUB_MAIN_CPU_PROFILE_DELAY=<seconds>   otherwise start after this delay (default 0)
//   HUB_MAIN_CPU_PROFILE_INTERVAL_US=<us>  sampling interval (default 1000)
//
// Output, written to <dataDir>/diagnostics/main-cpu-profile-<pid>-<ts>.*:
//   .cpuprofile  V8 CPU profile (Chrome DevTools / speedscope)
//   .json        event-loop stalls > 50 ms, loop delay histogram, memoryUsage

const fs = require('fs');
const path = require('path');

const STALL_PROBE_MS = 20;
const STALL_REPORT_MS = 50;

function parseMainCpuProfileOptions(env = process.env) {
  const seconds = Number(env.HUB_MAIN_CPU_PROFILE);
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  const delay = Number(env.HUB_MAIN_CPU_PROFILE_DELAY);
  const interval = Number(env.HUB_MAIN_CPU_PROFILE_INTERVAL_US);
  const trigger = String(env.HUB_MAIN_CPU_PROFILE_TRIGGER || '').trim();
  return {
    durationMs: Math.round(Math.min(600, seconds) * 1000),
    delayMs: Number.isFinite(delay) && delay > 0 ? Math.round(delay * 1000) : 0,
    samplingIntervalUs: Number.isFinite(interval) && interval >= 100 ? Math.round(interval) : 1000,
    triggerPath: trigger || null,
  };
}

function createStallRecorder({ now = () => Number(process.hrtime.bigint() / 1000000n) } = {}) {
  const stalls = [];
  let last = now();
  let timer = null;
  return {
    start() {
      last = now();
      timer = setInterval(() => {
        const t = now();
        const lag = t - last - STALL_PROBE_MS;
        if (lag >= STALL_REPORT_MS) stalls.push({ at: Date.now(), lagMs: Math.round(lag) });
        last = t;
      }, STALL_PROBE_MS);
      timer.unref?.();
    },
    stop() { if (timer) clearInterval(timer); timer = null; return stalls.slice(); },
  };
}

// Child-process creation is synchronous on the calling thread (CreateProcess on
// Windows), so every spawn from Main is a potential window stall. While the
// profile runs, record how long each spawn call blocked and who made it.
function createSpawnAudit({ childProcess = require('child_process') } = {}) {
  const records = [];
  const originals = {};
  let recording = false;
  const wrap = (name) => {
    const original = childProcess[name];
    if (typeof original !== 'function') return;
    originals[name] = original;
    childProcess[name] = function auditedSpawn(file, ...rest) {
      if (!recording) return original.call(this, file, ...rest);
      const started = process.hrtime.bigint();
      try { return original.call(this, file, ...rest); }
      finally {
        const ms = Number(process.hrtime.bigint() - started) / 1e6;
        const caller = (new Error().stack || '').split('\n').slice(2)
          .map(line => line.trim())
          .find(line => !/node:|child_process|main-cpu-profiler/.test(line)) || '';
        const options = rest.find(value => value && typeof value === 'object' && !Array.isArray(value)) || {};
        const env = options.env || process.env;
        records.push({ at: Date.now(), api: name, file: String(file).slice(0, 120), ms: Math.round(ms * 10) / 10, caller: caller.slice(0, 200),
          codexHome: env.CODEX_HOME || null, userProfile: env.USERPROFILE || null });
      }
    };
  };
  // Installed at startup so modules that destructure child_process later still
  // get the wrapper; it only measures between start() and stop().
  for (const name of ['spawn', 'spawnSync', 'execSync', 'execFileSync', 'execFile', 'exec', 'fork']) wrap(name);
  return {
    start() { recording = true; },
    stop() { recording = false; return records.slice(); },
  };
}

// Per-channel IPC counts while the profile runs: Main -> renderer sends, renderer
// -> Main `send` messages and `invoke` handlers (with handler time). Diagnostic
// patches on Electron objects are restored when the profile ends.
function createIpcAudit({ electron = require('electron') } = {}) {
  const out = new Map(), incoming = new Map(), invokes = new Map();
  const restore = [];
  const bump = (map, key, bytes = 0, ms = 0) => {
    const row = map.get(key) || { n: 0, bytes: 0, ms: 0 };
    row.n += 1; row.bytes += bytes; row.ms += ms;
    map.set(key, row);
  };
  return {
    start() {
      try {
        const wc = electron.webContents.getAllWebContents()[0];
        const proto = wc && Object.getPrototypeOf(wc);
        if (proto && typeof proto.send === 'function') {
          const original = proto.send;
          proto.send = function auditedSend(channel, ...args) {
            const data = args[0] && typeof args[0] === 'object' ? args[0].data : null;
            bump(out, String(channel), typeof data === 'string' ? data.length : 0);
            return original.call(this, channel, ...args);
          };
          restore.push(() => { proto.send = original; });
        }
      } catch {}
      const { ipcMain } = electron;
      const originalEmit = ipcMain.emit;
      ipcMain.emit = function auditedEmit(channel, ...args) {
        const started = process.hrtime.bigint();
        try { return originalEmit.call(this, channel, ...args); }
        finally { bump(incoming, String(channel), 0, Number(process.hrtime.bigint() - started) / 1e6); }
      };
      restore.push(() => { ipcMain.emit = originalEmit; });
      const handlers = ipcMain._invokeHandlers;
      if (handlers && typeof handlers.get === 'function') {
        const originalGet = handlers.get;
        handlers.get = function auditedGet(channel) {
          const handler = originalGet.call(this, channel);
          if (typeof handler !== 'function') return handler;
          return async (...args) => {
            const started = process.hrtime.bigint();
            try { return await handler(...args); }
            finally { bump(invokes, String(channel), 0, Number(process.hrtime.bigint() - started) / 1e6); }
          };
        };
        restore.push(() => { handlers.get = originalGet; });
      }
    },
    stop() {
      while (restore.length) { try { restore.pop()(); } catch {} }
      const table = map => Object.fromEntries([...map].sort((a, b) => b[1].n - a[1].n)
        .map(([key, row]) => [key, { n: row.n, bytes: row.bytes, ms: Math.round(row.ms * 10) / 10 }]));
      return { toRenderer: table(out), fromRendererSend: table(incoming), invoke: table(invokes) };
    },
  };
}

function startMainCpuProfiler({ env = process.env, dataDir, logger = console } = {}) {
  const options = parseMainCpuProfileOptions(env);
  if (!options || !dataDir) return null;
  const outDir = path.join(dataDir, 'diagnostics');
  // Spawns are recorded from startup (boot-time pollers included); entries
  // carry timestamps, so the profile window can be told apart.
  const spawnAudit = createSpawnAudit();
  spawnAudit.start();
  let started = false;

  const run = () => {
    if (started) return;
    started = true;
    let inspector;
    try { inspector = require('inspector'); } catch (error) {
      logger.warn('[main-cpu-profile] inspector unavailable:', error.message);
      return;
    }
    const session = new inspector.Session();
    session.connect();
    const post = (method, params) => new Promise((resolve, reject) => {
      session.post(method, params || {}, (error, result) => (error ? reject(error) : resolve(result)));
    });
    const stall = createStallRecorder();
    let histogram = null;
    try {
      histogram = require('perf_hooks').monitorEventLoopDelay({ resolution: 10 });
      histogram.enable();
    } catch {}
    const startedAt = Date.now();
    const cpuStart = process.cpuUsage();
    const memStart = process.memoryUsage();
    stall.start();
    const ipcAudit = createIpcAudit();
    ipcAudit.start();
    post('Profiler.enable')
      .then(() => post('Profiler.setSamplingInterval', { interval: options.samplingIntervalUs }))
      .then(() => post('Profiler.start'))
      .then(() => new Promise(resolve => setTimeout(resolve, options.durationMs)))
      .then(() => post('Profiler.stop'))
      .then(({ profile }) => {
        const stalls = stall.stop();
        const spawns = spawnAudit.stop();
        const ipc = ipcAudit.stop();
        histogram?.disable();
        const cpu = process.cpuUsage(cpuStart);
        const wallMs = Date.now() - startedAt;
        fs.mkdirSync(outDir, { recursive: true });
        const base = path.join(outDir, `main-cpu-profile-${process.pid}-${startedAt}`);
        fs.writeFileSync(base + '.cpuprofile', JSON.stringify(profile));
        const ms = value => Math.round(value / 1e6 * 10) / 10;
        fs.writeFileSync(base + '.json', JSON.stringify({
          pid: process.pid,
          startedAt,
          wallMs,
          cpuUserMs: Math.round(cpu.user / 1000),
          cpuSystemMs: Math.round(cpu.system / 1000),
          cpuPercentOfOneCore: Math.round((cpu.user + cpu.system) / 10 / wallMs),
          stallsOver50ms: stalls,
          spawns,
          ipc,
          loopDelay: histogram ? {
            p50Ms: ms(histogram.percentile(50)),
            p95Ms: ms(histogram.percentile(95)),
            p99Ms: ms(histogram.percentile(99)),
            maxMs: ms(histogram.max),
          } : null,
          memoryStart: memStart,
          memoryEnd: process.memoryUsage(),
        }, null, 1));
        logger.log('[main-cpu-profile] wrote', base + '.cpuprofile');
      })
      .catch(error => logger.warn('[main-cpu-profile] failed:', error && error.message))
      .finally(() => { stall.stop(); spawnAudit.stop(); ipcAudit.stop(); try { session.disconnect(); } catch {} });
  };

  if (options.triggerPath) {
    const poll = setInterval(() => {
      if (!fs.existsSync(options.triggerPath)) return;
      clearInterval(poll);
      run();
    }, 1000);
    poll.unref?.();
  } else if (options.delayMs > 0) {
    setTimeout(run, options.delayMs).unref?.();
  } else {
    run();
  }
  return options;
}

module.exports = { parseMainCpuProfileOptions, startMainCpuProfiler, createStallRecorder, createSpawnAudit, createIpcAudit };
