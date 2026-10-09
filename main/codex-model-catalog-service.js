'use strict';

const { spawn } = require('child_process');
const {
  buildCodexTuningSnapshot,
} = require('../core/codex-model-catalog.js');
const { MODEL_OPTIONS_BY_KIND } = require('../core/model-options.js');
const {
  resolveCodexAppServerCommand,
  terminateOwnedProcessTree,
} = require('./usage/codex-app-server-usage.js');

function readCodexModelList(options = {}) {
  const spawnFn = options.spawnFn || spawn;
  const timeoutMs = Math.max(1000, Number(options.timeoutMs) || 8000);
  const commandSpec = resolveCodexAppServerCommand(options);
  const env = { ...(options.env || process.env), ...commandSpec.env };
  if (options.home) env.CODEX_HOME = options.home;
  if (options.proxy) {
    env.HTTP_PROXY = options.proxy;
    env.HTTPS_PROXY = options.proxy;
    env.NO_PROXY = 'localhost,127.0.0.1';
  }

  return new Promise((resolve, reject) => {
    let proc;
    try {
      proc = spawnFn(commandSpec.command, commandSpec.args, {
        cwd: options.cwd || options.home || process.cwd(),
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (error) {
      reject(error);
      return;
    }

    let settled = false;
    let lineBuffer = '';
    let stderr = '';
    let nextId = 1;
    const pending = new Map();
    const killTree = options.killTreeFn || (child => terminateOwnedProcessTree(child, {
      platform: options.platform,
      spawnFn: options.spawnFn,
    }));

    const stopOwnedProcess = () => {
      try { proc.stdin.end(); } catch (_) {}
      const timer = setTimeout(() => {
        try { if (!proc.killed) killTree(proc); } catch (_) {}
      }, 250);
      timer.unref?.();
    };
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      pending.clear();
      stopOwnedProcess();
      if (error) reject(error);
      else resolve(value);
    };
    const request = (method, params) => {
      const id = nextId++;
      pending.set(id, method);
      try {
        proc.stdin.write(JSON.stringify({ id, method, params }) + '\n', error => {
          if (error) finish(error);
        });
      } catch (error) {
        finish(error);
      }
    };

    const timeout = setTimeout(() => {
      const detail = stderr.trim() ? `：${stderr.trim().slice(-400)}` : '';
      finish(new Error(`Codex 模型目录刷新超时${detail}`));
    }, timeoutMs);
    timeout.unref?.();

    proc.stderr?.on('data', chunk => { stderr = (stderr + chunk.toString('utf8')).slice(-2000); });
    proc.stdin?.on('error', error => finish(error));
    proc.on('error', error => finish(error));
    proc.on('exit', (code, signal) => {
      if (!settled) finish(new Error(`Codex app-server 提前退出 code=${code} signal=${signal || 'none'}`));
    });
    proc.stdout?.on('data', chunk => {
      lineBuffer += chunk.toString('utf8');
      const lines = lineBuffer.split(/\r?\n/);
      lineBuffer = lines.pop() || '';
      for (const line of lines) {
        if (!line.trim()) continue;
        let message;
        try { message = JSON.parse(line); } catch (_) { continue; }
        if (!Object.prototype.hasOwnProperty.call(message, 'id')) continue;
        const method = pending.get(message.id);
        if (!method) continue;
        pending.delete(message.id);
        if (message.error) {
          finish(new Error(message.error.message || `${method} 失败`));
          return;
        }
        if (method === 'initialize') {
          request('model/list', { limit: 100, includeHidden: false });
          continue;
        }
        if (method === 'model/list') {
          const models = message.result && Array.isArray(message.result.data) ? message.result.data : [];
          if (!models.length) {
            finish(new Error('Codex app-server 返回空模型目录'));
            return;
          }
          finish(null, models);
          return;
        }
      }
    });

    request('initialize', {
      clientInfo: {
        name: 'claude-session-hub-model-catalog',
        title: 'AI Hub Model Catalog',
        version: '1.0.0',
      },
      capabilities: { experimentalApi: false },
    });
  });
}

function createCodexModelCatalogService(options = {}) {
  const ttlMs = Math.max(5000, Number(options.ttlMs) || 60_000);
  const readLive = options.readLive || readCodexModelList;
  const now = options.now || Date.now;
  const cachedByHome = new Map();
  const inFlightByHome = new Map();

  async function getCatalog(request = {}) {
    const current = now();
    const cacheKey = String(request.home || '<default>').toLowerCase();
    const existing = cachedByHome.get(cacheKey);
    if (!request.force && existing && current - existing.cachedAt < ttlMs) {
      return { ...existing.value, cached: true };
    }
    if (inFlightByHome.has(cacheKey)) return inFlightByHome.get(cacheKey);
    const inFlight = (async () => {
      const staticSlugs = (MODEL_OPTIONS_BY_KIND.codex || []).map(option => option.id);
      let value;
      if (request.offline === true) {
        value = {
          ok: true,
          ...buildCodexTuningSnapshot(staticSlugs, { configDir: request.home }),
          fetchedAt: now(),
        };
        cachedByHome.set(cacheKey, { value, cachedAt: now() });
        return { ...value, cached: false };
      }
      try {
        const liveModels = await readLive(request);
        value = {
          ok: true,
          ...buildCodexTuningSnapshot(staticSlugs, {
            configDir: request.home,
            models: liveModels,
          }),
          fetchedAt: now(),
        };
      } catch (error) {
        value = {
          ok: true,
          ...buildCodexTuningSnapshot(staticSlugs, { configDir: request.home }),
          fetchedAt: now(),
          refreshError: error && error.message ? error.message : String(error),
        };
      }
      cachedByHome.set(cacheKey, { value, cachedAt: now() });
      return { ...value, cached: false };
    })().finally(() => { inFlightByHome.delete(cacheKey); });
    inFlightByHome.set(cacheKey, inFlight);
    return inFlight;
  }

  return {
    getCatalog,
    invalidate(home = null) {
      if (home == null) cachedByHome.clear();
      else cachedByHome.delete(String(home || '<default>').toLowerCase());
    },
  };
}

module.exports = {
  createCodexModelCatalogService,
  readCodexModelList,
};
