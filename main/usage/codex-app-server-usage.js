'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

function toEpochMs(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return value < 1e12 ? value * 1000 : value;
}

function codexUsageKeyForWindow(window, fallbackKey) {
  const durationMins = Number(window && window.windowDurationMins);
  if (!Number.isFinite(durationMins) || durationMins <= 0) return fallbackKey;
  // App-server no longer guarantees primary=5h and secondary=7d. Current Pro
  // accounts can return a single primary window whose duration is 10080 min
  // (weekly). Classify by the authoritative duration, not field position.
  return Math.abs(durationMins - 300) <= Math.abs(durationMins - 10080)
    ? 'usage5h'
    : 'usage7d';
}

function codexUsageLabelForWindow(window, fallbackLabel) {
  const mins = Number(window && window.windowDurationMins);
  if (!Number.isFinite(mins) || mins <= 0) return fallbackLabel;
  if (mins % 10080 === 0) return `${mins / 10080 * 7}d`;
  if (mins % 1440 === 0) return `${mins / 1440}d`;
  if (mins % 60 === 0) return `${mins / 60}h`;
  return `${mins}m`;
}

function normalizeCodexRateLimitsResponse(response, observedAt = Date.now()) {
  const rateLimits = response && (
    (response.rateLimitsByLimitId && response.rateLimitsByLimitId.codex)
    || response.rateLimits
  );
  if (!rateLimits || typeof rateLimits !== 'object') {
    throw new Error('Codex app-server 未返回账户配额');
  }

  const result = {
    usage5h: null,
    usage7d: null,
    limitId: rateLimits.limitId || 'codex',
    observedAt,
    source: 'app-server',
  };
  for (const [name, fallbackKey] of [['primary', 'usage5h'], ['secondary', 'usage7d']]) {
    const window = rateLimits[name];
    if (!window || typeof window.usedPercent !== 'number') continue;
    const key = codexUsageKeyForWindow(window, fallbackKey);
    result[key] = {
      pct: Math.round(window.usedPercent),
      resetsAt: toEpochMs(window.resetsAt),
      label: codexUsageLabelForWindow(window, key === 'usage5h' ? '5h' : '7d'),
    };
  }
  if (!result.usage5h && !result.usage7d) {
    throw new Error('Codex app-server 配额窗口为空');
  }
  return result;
}

function expireCodexUsageWindows(value, now = Date.now()) {
  if (!value || typeof value !== 'object') return value;
  const result = { ...value };
  for (const key of ['usage5h', 'usage7d']) {
    const window = value[key];
    const resetsAt = window && window.resetsAt ? new Date(window.resetsAt).getTime() : 0;
    if (Number.isFinite(resetsAt) && resetsAt > 0 && resetsAt <= now) result[key] = null;
  }
  if (!result.usage5h && !result.usage7d) result.unavailable = true;
  else delete result.unavailable;
  return result;
}

function usageObservedAt(value) {
  return Number(value && (value.observedAt || value._ts)) || 0;
}

function weeklyResetAt(value) {
  const raw = value && value.usage7d && value.usage7d.resetsAt;
  const parsed = raw ? new Date(raw).getTime() : 0;
  return Number.isFinite(parsed) ? parsed : 0;
}

function hasUsageWindow(value) {
  return !!(value && !value.unavailable && (value.usage5h || value.usage7d));
}

/**
 * Decide whether an account-scoped app-server snapshot should override a
 * session-derived snapshot. A non-expired live snapshot wins when the two
 * weekly windows disagree because the JSONL files can belong to a previously
 * authenticated account. Once that live weekly window has expired, however,
 * a newer local snapshot is allowed to advance into the next reset window.
 */
function shouldPreferCodexLiveUsage(live, local, now = Date.now()) {
  live = expireCodexUsageWindows(live, now);
  if (!hasUsageWindow(live)) return false;
  if (!hasUsageWindow(local)) return true;

  const liveObservedAt = usageObservedAt(live);
  const localObservedAt = usageObservedAt(local);
  const liveWeeklyReset = weeklyResetAt(live);
  const localWeeklyReset = weeklyResetAt(local);
  const hasBothWeeklyResets = liveWeeklyReset > 0 && localWeeklyReset > 0;
  const sameWeeklyWindow = hasBothWeeklyResets
    && Math.abs(liveWeeklyReset - localWeeklyReset) <= 60_000;

  if (sameWeeklyWindow) return liveObservedAt >= localObservedAt;

  if (hasBothWeeklyResets && liveWeeklyReset <= now && localObservedAt > liveObservedAt) {
    return false;
  }

  if (hasBothWeeklyResets) return true;
  return liveObservedAt >= localObservedAt;
}

function resolveCodexAppServerCommand(opts = {}) {
  const platform = opts.platform || process.platform;
  if (platform === 'win32') {
    const appData = opts.appData || process.env.APPDATA || '';
    const npmCmd = appData ? path.join(appData, 'npm', 'codex.cmd') : '';
    if (!opts.codexCommand && npmCmd && fs.existsSync(npmCmd)) {
      const launch = require('../codex-windows-command').resolveWindowsCodex(opts.env || process.env, { shim: npmCmd });
      return { ...launch, args: ['app-server', '--listen', 'stdio://'] };
    }
    if (!opts.codexCommand) {
      // No npm shim: an official native codex.exe (same lookup as every other Codex entry point).
      const found = require('../codex-windows-command').locateWindowsCodex(opts.env || process.env);
      if (found && found.kind === 'native') return { command: found.command, args: ['app-server', '--listen', 'stdio://'] };
    }
    const codexCommand = opts.codexCommand || (npmCmd && fs.existsSync(npmCmd) ? npmCmd : 'codex');
    return {
      command: opts.comSpec || process.env.ComSpec || 'cmd.exe',
      args: ['/d', '/c', codexCommand, 'app-server', '--listen', 'stdio://'],
    };
  }
  return {
    command: opts.codexCommand || 'codex',
    args: ['app-server', '--listen', 'stdio://'],
  };
}

function terminateOwnedProcessTree(proc, opts = {}) {
  if (!proc) return;
  const platform = opts.platform || process.platform;
  if (platform === 'win32' && Number.isInteger(proc.pid) && proc.pid > 0) {
    try {
      const killer = (opts.spawnFn || spawn)('taskkill.exe', [
        '/pid', String(proc.pid), '/t', '/f',
      ], {
        windowsHide: true,
        stdio: 'ignore',
      });
      killer.on?.('error', () => {
        try { if (!proc.killed) proc.kill(); } catch {}
      });
      killer.unref?.();
      return;
    } catch {}
  }
  try { if (!proc.killed) proc.kill(); } catch {}
}

function readCodexAccountUsage(opts = {}) {
  const spawnFn = opts.spawnFn || spawn;
  const timeoutMs = Math.max(500, Number(opts.timeoutMs) || 8000);
  const now = typeof opts.now === 'function' ? opts.now : Date.now;
  const commandSpec = resolveCodexAppServerCommand(opts);
  const killTreeFn = opts.killTreeFn || (proc => terminateOwnedProcessTree(proc, {
    platform: opts.platform,
  }));
  const env = { ...(opts.env || process.env), ...commandSpec.env };
  if (opts.home) env.CODEX_HOME = opts.home;
  if (opts.proxy) {
    env.HTTP_PROXY = opts.proxy;
    env.HTTPS_PROXY = opts.proxy;
    env.NO_PROXY = 'localhost,127.0.0.1';
  }

  return new Promise((resolve, reject) => {
    let proc;
    try {
      proc = spawnFn(commandSpec.command, commandSpec.args, {
        cwd: opts.cwd || opts.home || process.cwd(),
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (err) {
      reject(err);
      return;
    }

    let settled = false;
    let lineBuffer = '';
    let stderr = '';
    let nextId = 1;
    const pending = new Map();

    const stopOwnedProcess = () => {
      try { proc.stdin.end(); } catch {}
      if ((opts.platform || process.platform) === 'win32') {
        killTreeFn(proc);
        return;
      }
      const killTimer = setTimeout(() => {
        killTreeFn(proc);
      }, 250);
      killTimer.unref?.();
    };

    const finish = (err, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      pending.clear();
      stopOwnedProcess();
      if (err) reject(err);
      else resolve(value);
    };

    const request = (method, params) => {
      const id = nextId++;
      pending.set(id, method);
      try {
        proc.stdin.write(JSON.stringify({ id, method, params }) + '\n', err => {
          if (err) finish(err);
        });
      } catch (err) {
        finish(err);
      }
      return id;
    };

    const timeout = setTimeout(() => {
      const detail = stderr.trim() ? `: ${stderr.trim().slice(-500)}` : '';
      finish(new Error(`Codex app-server 配额读取超时${detail}`));
    }, timeoutMs);
    timeout.unref?.();

    proc.stderr.on('data', chunk => {
      stderr = (stderr + chunk.toString('utf8')).slice(-2000);
    });
    proc.stdin.on('error', err => finish(err));
    proc.on('error', err => finish(err));
    proc.on('exit', (code, signal) => {
      if (!settled) finish(new Error(`Codex app-server 提前退出 code=${code} signal=${signal || 'none'}`));
    });
    proc.stdout.on('data', chunk => {
      lineBuffer += chunk.toString('utf8');
      const lines = lineBuffer.split(/\r?\n/);
      lineBuffer = lines.pop() || '';
      for (const line of lines) {
        if (!line.trim()) continue;
        let message;
        try { message = JSON.parse(line); } catch { continue; }
        if (!Object.prototype.hasOwnProperty.call(message, 'id')) continue;
        const method = pending.get(message.id);
        if (!method) continue;
        pending.delete(message.id);
        if (message.error) {
          finish(new Error(message.error.message || `${method} 失败`));
          return;
        }
        if (method === 'initialize') {
          request('account/rateLimits/read', {});
          continue;
        }
        if (method === 'account/rateLimits/read') {
          try {
            finish(null, normalizeCodexRateLimitsResponse(message.result, now()));
          } catch (err) {
            finish(err);
          }
          return;
        }
      }
    });

    request('initialize', {
      clientInfo: {
        name: 'claude-session-hub-usage',
        title: 'Claude Session Hub Usage',
        version: '1.0.0',
      },
      capabilities: { experimentalApi: false },
    });
  });
}

module.exports = {
  expireCodexUsageWindows,
  codexUsageKeyForWindow,
  codexUsageLabelForWindow,
  normalizeCodexRateLimitsResponse,
  readCodexAccountUsage,
  resolveCodexAppServerCommand,
  shouldPreferCodexLiveUsage,
  terminateOwnedProcessTree,
};
