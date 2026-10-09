'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  MODEL_OPTIONS_BY_KIND,
  isClaudeModelSelection,
} = require('./model-options.js');
const {
  readClaudeModelDiscovery,
  refreshClaudeModelDiscovery,
} = require('./claude-model-discovery.js');

function resolveClaudeStatePath({ configDir, homeDir = os.homedir(), fsModule = fs } = {}) {
  const candidates = [];
  if (configDir) candidates.push(path.join(configDir, '.claude.json'));
  if (process.env.CLAUDE_CONFIG_DIR && process.env.CLAUDE_CONFIG_DIR !== configDir) {
    candidates.push(path.join(process.env.CLAUDE_CONFIG_DIR, '.claude.json'));
  }
  candidates.push(path.join(homeDir, '.claude.json'));
  return candidates.find(candidate => {
    try { return fsModule.existsSync(candidate); } catch (_) { return false; }
  }) || candidates[0];
}

function humanizeClaudeModelId(modelId) {
  const id = String(modelId || '').trim();
  const has1m = /\[1m\]$/i.test(id);
  const bare = id.replace(/\[1m\]$/i, '').replace(/^claude-/i, '');
  if (['fable', 'opus', 'sonnet', 'haiku'].includes(bare.toLowerCase())) {
    return `${bare[0].toUpperCase()}${bare.slice(1)} · 最新可用版本`;
  }
  const match = bare.match(/^(fable|opus|sonnet|haiku)-(\d+)(?:-(\d+))?(?:-\d{8})?$/i);
  if (!match) return id;
  const family = `${match[1][0].toUpperCase()}${match[1].slice(1).toLowerCase()}`;
  const version = match[3] ? `${match[2]}.${match[3]}` : match[2];
  return `${family} ${version}${has1m ? ' (1M context)' : ''}`;
}

function collectCachedModelOptions(value, result = [], depth = 0) {
  if (depth > 5 || value == null) return result;
  if (Array.isArray(value)) {
    value.forEach(item => collectCachedModelOptions(item, result, depth + 1));
    return result;
  }
  if (typeof value !== 'object') return result;
  const id = String(value.value || value.id || value.model || '').trim();
  if (isClaudeModelSelection(id)) {
    result.push({
      id,
      label: humanizeClaudeModelId(id),
      description: String(value.description || '').trim(),
      source: 'claude-cli-cache',
    });
    return result;
  }
  Object.values(value).forEach(item => collectCachedModelOptions(item, result, depth + 1));
  return result;
}

function readClaudeModelCache(options = {}) {
  const fsModule = options.fsModule || fs;
  const statePath = options.statePath || resolveClaudeStatePath({ ...options, fsModule });
  try {
    const parsed = JSON.parse(fsModule.readFileSync(statePath, 'utf8'));
    const models = collectCachedModelOptions(parsed && parsed.additionalModelOptionsCache);
    let mtimeMs = 0;
    try { mtimeMs = Number(fsModule.statSync(statePath).mtimeMs) || 0; } catch (_) {}
    return { models, statePath, mtimeMs, loaded: models.length > 0 };
  } catch (error) {
    return {
      models: [],
      statePath,
      mtimeMs: 0,
      loaded: false,
      error: error && error.message ? error.message : String(error),
    };
  }
}

function mergeModelOptions(primary, fallback) {
  const result = [];
  const seen = new Set();
  for (const option of [...(primary || []), ...(fallback || [])]) {
    if (!option || !isClaudeModelSelection(option.id)) continue;
    const key = String(option.id).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({
      ...option,
      id: String(option.id),
      label: String(option.label || humanizeClaudeModelId(option.id)),
    });
  }
  return result;
}

function buildClaudeModelSnapshot(options = {}) {
  // 三层来源，从权威到保底：
  //   1. 官方模型目录（downloads.claude.ai）—— 唯一能发现「刚发布的新模型」的来源，
  //      还带 min_claude_code_version，能说清为什么某个模型暂时不可选。
  //   2. `~/.claude.json` 的账号级额外模型缓存 —— 账号被单独授权的模型走这条。
  //   3. model-options.js 的静态清单 —— 断网/首次启动时的保底。
  // 全程同步：只读本地缓存，网络刷新在后台做，绝不挡住会话启动或下拉打开。
  const discovery = readClaudeModelDiscovery(options);
  // 显式给了 homeDir 的一律是隔离实例或单测上下文，不替它们打网络；
  // 生产 IPC 传的是 undefined，所以正常路径照常自动刷新。
  const autoRefresh = options.autoRefresh !== undefined
    ? options.autoRefresh
    : !options.homeDir;
  if (discovery.stale && autoRefresh) {
    // fire-and-forget：刷新结果进缓存，供下一次调用使用。失败已在模块内吞掉，
    // 这里再兜一层，确保任何情况下都不会冒出未捕获的 Promise 拒绝。
    Promise.resolve(refreshClaudeModelDiscovery(options)).catch(() => {});
  }
  const cache = readClaudeModelCache(options);
  const fallback = (options.fallbackOptions || MODEL_OPTIONS_BY_KIND.claude || [])
    .map(option => ({ ...option, source: option.source || 'static-fallback' }));
  const source = discovery.loaded
    ? 'official-catalog'
    : (cache.loaded ? 'claude-cli-cache' : 'static-fallback');
  return {
    ok: true,
    models: mergeModelOptions(discovery.options, mergeModelOptions(cache.models, fallback)),
    catalogLoaded: discovery.loaded || cache.loaded,
    source,
    catalogMtimeMs: cache.mtimeMs,
    cachePath: cache.statePath,
    discovery: {
      loaded: discovery.loaded,
      stale: discovery.stale,
      catalogVersion: discovery.catalogVersion,
    },
    // 没有可报的更新时是 null，UI 据此决定不显示任何东西。
    cliUpdateNotice: discovery.notice,
    ...(cache.error ? { refreshError: cache.error } : {}),
  };
}

module.exports = {
  buildClaudeModelSnapshot,
  collectCachedModelOptions,
  humanizeClaudeModelId,
  mergeModelOptions,
  readClaudeModelCache,
  resolveClaudeStatePath,
};
