'use strict';
// Claude 模型自动发现 + CLI 更新提醒。
//
// 背景（2026-09-23 实测）：Hub 原来的模型清单只有两个来源——`~/.claude.json`
// 的 `additionalModelOptionsCache`，以及 `model-options.js` 里手写的静态兜底。
// 两者都发现不了新模型：Opus 5.5 发布当天，cache 里只躺着一条
// `{"value":"cc-update-required-1","label":"Opus 5.5 (disabled)",
//   "description":"Update to 2.1.280+ to use Opus 5.5","disabled":true}`，
// 而 `isClaudeModelSelection('cc-update-required-1')` 为 false，于是这条连同
// 「该升级了」的提示一起被静默丢掉，用户只看到下拉里没有新模型。
//
// Claude Code 自己用的是下面两个公开端点（从 2.1.280 二进制里取证），本模块
// 直接复用，不再靠猜：
//   - model-catalog/v1/catalog.json  官方模型目录，每条带 min_claude_code_version
//   - claude-code-releases/{latest,stable}  纯文本版本号，几十字节
//
// 两条铁律：
//   1. 发现失败绝不能影响会话启动。所有网络访问都包在 try 里，失败回落
//      「上次缓存 → CLI cache → 静态兜底」，向上只报 ok:false。
//   2. 不在启动路径上同步等网络。调用方拿缓存立即返回，刷新在后台做。

const fs = require('fs');
const path = require('path');
const { getHubDataDir } = require('./data-dir');

const CATALOG_URL = 'https://downloads.claude.ai/model-catalog/v1/catalog.json';
const RELEASES_BASE = 'https://downloads.claude.ai/claude-code-releases';
const CACHE_FILE = 'claude-model-discovery.json';

// catalog.json 自带 expires_at（实测签发后 7 天）。Hub 侧再压一层 6 小时，
// 新模型当天就能被发现，又不会每开一个会话都打一次网络。
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 8000;

// ---------------------------------------------------------------- 版本比较

// "2.1.280" 这类点分版本。逐段按数字比，段数不同时短的补 0，
// 这样 "2.1.9" < "2.1.280" 不会被字符串序判反。
function compareCliVersions(a, b) {
  const parse = value => String(value || '')
    .trim()
    .split('.')
    .map(part => {
      const digits = part.match(/^\d+/);
      return digits ? Number(digits[0]) : 0;
    });
  const left = parse(a);
  const right = parse(b);
  const length = Math.max(left.length, right.length);
  for (let i = 0; i < length; i += 1) {
    const l = left[i] || 0;
    const r = right[i] || 0;
    if (l !== r) return l < r ? -1 : 1;
  }
  return 0;
}

function isValidCliVersion(value) {
  return /^\d+(?:\.\d+)*$/.test(String(value || '').trim());
}

// ------------------------------------------------------------ catalog 解析

// 官方目录的形状：surfaces.cc.model_selector_config[0].models[]。
// 只认 `cc`（Claude Code）这个 surface —— chat / cowork 面向别的产品，
// 它们的模型未必能传给 CLI 的 --model。
function normalizeCatalogModels(catalog) {
  const config = catalog
    && catalog.surfaces
    && catalog.surfaces.cc
    && Array.isArray(catalog.surfaces.cc.model_selector_config)
    ? catalog.surfaces.cc.model_selector_config[0]
    : null;
  const models = config && Array.isArray(config.models) ? config.models : [];
  return models
    // Hub 走的是订阅/第一方登录，Bedrock/Vertex 独占的条目列出来也选不了。
    .filter(model => model && typeof model.id === 'string'
      && (!Array.isArray(model.offered_on) || model.offered_on.includes('first_party')))
    .map(model => ({
      id: model.id,
      name: String(model.name || model.id),
      description: String(model.description || ''),
      section: String(model.section || 'overflow'),
      quickSelect: !!model.quick_select,
      minCliVersion: isValidCliVersion(model.min_claude_code_version)
        ? String(model.min_claude_code_version).trim()
        : '',
      maxInputTokens: Number(model.runtime && model.runtime.max_input_tokens) || 0,
      family: String((model.runtime && model.runtime.family) || ''),
    }));
}

// --------------------------------------------------------------- 选项构建

// 保持与 model-options.js 既有 label 一致：1M 变体写成 "Opus 5.5 (1M context)"。
function optionLabel(model, oneMillion) {
  return oneMillion ? `${model.name} (1M context)` : model.name;
}

// 把目录条目摊平成 Hub 下拉用的选项。
//
// 关键取舍：min_claude_code_version 高于本地 CLI 的模型**仍然列出来**，只是
// 标上 disabled + upgradeTo。Hub 原来的做法是丢掉，结果用户完全不知道有新
// 模型、更不知道要升级——这正是 Opus 5.5 那次的翻车点。列出来（不可选）是
// 唯一能把「为什么没有」讲清楚的形态。
function discoveredModelOptions(models, options = {}) {
  const localVersion = String(options.localVersion || '').trim();
  const result = [];
  const ordered = [...models].sort((a, b) => {
    const sectionRank = value => (value === 'main' ? 0 : 1);
    if (sectionRank(a.section) !== sectionRank(b.section)) {
      return sectionRank(a.section) - sectionRank(b.section);
    }
    if (a.quickSelect !== b.quickSelect) return a.quickSelect ? -1 : 1;
    return 0;
  });
  for (const model of ordered) {
    const needsUpgrade = !!(model.minCliVersion
      && isValidCliVersion(localVersion)
      && compareCliVersions(localVersion, model.minCliVersion) < 0);
    // 目录里 max_input_tokens 到 1M 的模型，Hub 惯例是既给裸 id 也给 [1m]
    // 变体（[1m] 是传给 CLI 的后缀，不是另一个模型）。
    const variants = model.maxInputTokens >= 1000000
      ? [{ id: `${model.id}[1m]`, oneMillion: true }, { id: model.id, oneMillion: false }]
      : [{ id: model.id, oneMillion: false }];
    for (const variant of variants) {
      result.push({
        id: variant.id,
        label: optionLabel(model, variant.oneMillion),
        description: model.description,
        source: 'official-catalog',
        section: model.section,
        ...(needsUpgrade ? { disabled: true, upgradeTo: model.minCliVersion } : {}),
      });
    }
  }
  return result;
}

// --------------------------------------------------------------- 更新提醒

// 两路信号，合成一条人话提醒：
//   1. 有模型要求更高的 CLI 版本 —— 可操作、有理由，优先说这个。
//   2. releases/latest 比本地新 —— 泛化的「有新版」。
// 都没有就返回 null（调用方据此决定不显示任何东西）。
function cliUpdateNotice(input = {}) {
  const localVersion = String(input.localVersion || '').trim();
  const latestVersion = String(input.latestVersion || '').trim();
  const models = Array.isArray(input.models) ? input.models : [];
  if (!isValidCliVersion(localVersion)) return null;

  const blocked = models
    .filter(model => model.minCliVersion
      && compareCliVersions(localVersion, model.minCliVersion) < 0)
    .sort((a, b) => compareCliVersions(a.minCliVersion, b.minCliVersion));

  if (blocked.length) {
    // 取要求最低的那个版本：升到它就至少解锁一个模型。
    const target = blocked[0].minCliVersion;
    const names = blocked.map(model => model.name).join('、');
    return {
      kind: 'model-blocked',
      localVersion,
      targetVersion: target,
      blockedModels: blocked.map(model => model.id),
      message: `${names} 需要 Claude Code ${target}+，当前 ${localVersion}。运行 claude update 升级。`,
    };
  }

  if (isValidCliVersion(latestVersion) && compareCliVersions(localVersion, latestVersion) < 0) {
    return {
      kind: 'update-available',
      localVersion,
      targetVersion: latestVersion,
      blockedModels: [],
      message: `Claude Code 有新版本 ${latestVersion}（当前 ${localVersion}）。运行 claude update 升级。`,
    };
  }

  return null;
}

// ------------------------------------------------------------------ 网络层

// 代理是这里唯一的坑，且非常容易漏（2026-09-23 实测）：这台开发机走本地代理
// 127.0.0.1:7890，curl 读 HTTPS_PROXY 一秒拿到结果，而 Node 内置 fetch 不读任何
// 代理环境变量（除非显式开 NODE_USE_ENV_PROXY=1），直连被墙、10 秒后才抛
// "fetch failed"。Hub 是 Electron 应用，`net.fetch` 走 Chromium 自己的代理栈，
// 系统代理和 PAC 都能正确处理，所以生产路径优先用它；非 Electron（单测、脚本）
// 才回落到全局 fetch。
function resolveFetchImpl(options = {}) {
  if (typeof options.fetchImpl === 'function') return options.fetchImpl;
  try {
    // 在纯 Node 里 require('electron') 返回的是可执行文件路径字符串，
    // net 自然是 undefined，会安全落到下面的全局 fetch。
    const electron = require('electron');
    if (electron && electron.net && typeof electron.net.fetch === 'function') {
      return (...args) => electron.net.fetch(...args);
    }
  } catch (_) {}
  return globalThis.fetch;
}

async function fetchWithTimeout(url, options = {}) {
  const fetchImpl = resolveFetchImpl(options);
  if (typeof fetchImpl !== 'function') throw new Error('运行环境没有 fetch');
  const timeoutMs = Number(options.timeoutMs) || FETCH_TIMEOUT_MS;
  const response = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!response || !response.ok) {
    throw new Error(`HTTP ${response ? response.status : 'no-response'} ${url}`);
  }
  return response;
}

async function fetchOfficialCatalog(options = {}) {
  const response = await fetchWithTimeout(options.catalogUrl || CATALOG_URL, options);
  return response.json();
}

// latest / stable 各是一个只含版本号的纯文本文件。stable 落后 latest 属正常
// （实测 2026-09-23：stable=2.1.267、latest=2.1.280），两个都取回来，让调用方
// 自己决定跟哪条通道比。
async function fetchReleaseVersions(options = {}) {
  const base = options.releasesBase || RELEASES_BASE;
  const read = async channel => {
    try {
      const response = await fetchWithTimeout(`${base}/${channel}`, options);
      const text = String(await response.text()).trim();
      return isValidCliVersion(text) ? text : '';
    } catch (_) {
      return '';
    }
  };
  const [latest, stable] = await Promise.all([read('latest'), read('stable')]);
  return { latest, stable };
}

// ------------------------------------------------------------------ 缓存层

// 隔离优先级与 Hub 其他模块一致：显式 cachePath > 调用方给的 homeDir
// （隔离实例 / 单测走这条，绝不能写进生产的 ~/.ai-hub-community）> 默认数据目录。
function discoveryCachePath(options = {}) {
  if (options.cachePath) return options.cachePath;
  if (options.homeDir) return path.join(options.homeDir, '.ai-hub-community', CACHE_FILE);
  return path.join(getHubDataDir(), CACHE_FILE);
}

function readDiscoveryCache(options = {}) {
  const fsModule = options.fsModule || fs;
  try {
    const parsed = JSON.parse(fsModule.readFileSync(discoveryCachePath(options), 'utf8'));
    if (!parsed || typeof parsed !== 'object') return null;
    return parsed;
  } catch (_) {
    // 缓存缺失/损坏都不是错误，回落到上层兜底即可。
    return null;
  }
}

function writeDiscoveryCache(payload, options = {}) {
  const fsModule = options.fsModule || fs;
  const target = discoveryCachePath(options);
  const temp = `${target}.tmp-${process.pid}-${Date.now()}`;
  try {
    fsModule.mkdirSync(path.dirname(target), { recursive: true });
    fsModule.writeFileSync(temp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    fsModule.renameSync(temp, target);
    return true;
  } catch (_) {
    try { fsModule.unlinkSync(temp); } catch (_) {}
    return false;
  }
}

function isCacheFresh(cache, options = {}) {
  if (!cache || !cache.fetchedAt) return false;
  const ttl = Number(options.ttlMs) || CACHE_TTL_MS;
  return (Date.now() - Number(cache.fetchedAt)) < ttl;
}

// 本地 CLI 版本只有一个可靠来源：会话启动时 CLI 自己发的 system/init 帧里的
// `claude_code_version`（实测 2.1.280 带此字段）。`claude --version` 要另起进程、
// versions/ 目录里的最高版本也未必是实际在跑的那个。所以由 native session 在
// 收到 init 帧时把它记进缓存，下拉菜单那边再读出来判断哪些模型被版本挡住。
function recordLocalCliVersion(version, options = {}) {
  const value = String(version || '').trim();
  if (!isValidCliVersion(value)) return false;
  const cache = readDiscoveryCache(options) || {};
  if (cache.localCliVersion === value) return true;
  return writeDiscoveryCache({ ...cache, localCliVersion: value }, options);
}

// ------------------------------------------------------------------ 对外入口

// 拉一次官方目录 + 版本通道，写缓存。失败返回 { ok:false }，绝不抛。
async function refreshClaudeModelDiscovery(options = {}) {
  try {
    const [catalog, releases] = await Promise.all([
      fetchOfficialCatalog(options),
      fetchReleaseVersions(options),
    ]);
    const models = normalizeCatalogModels(catalog);
    if (!models.length) return { ok: false, reason: 'catalog-empty' };
    const payload = {
      fetchedAt: Date.now(),
      catalogVersion: Number(catalog && catalog.version) || 0,
      expiresAt: String((catalog && catalog.expires_at) || ''),
      models,
      releases,
    };
    writeDiscoveryCache(payload, options);
    return { ok: true, ...payload };
  } catch (error) {
    return { ok: false, reason: error && error.message ? error.message : String(error) };
  }
}

// 会话启动时调一次：记下本地 CLI 版本，并在缓存过期时顺手刷新官方目录。
// 整个过程不返回 Promise 给调用方、不抛异常、不等网络——会话启动路径上
// 任何一点阻塞都是不可接受的。6 小时 TTL 决定了它实际很少真的打网络。
function noteSessionStart(cliVersion, options = {}) {
  try { recordLocalCliVersion(cliVersion, options); } catch (_) {}
  try {
    if (isCacheFresh(readDiscoveryCache(options), options)) return;
    Promise.resolve(refreshClaudeModelDiscovery(options)).catch(() => {});
  } catch (_) {}
}

// 会话启动路径调用的就是这个：只读缓存，同步返回，永不等网络。
// stale 为 true 时调用方应触发一次后台 refresh。
function readClaudeModelDiscovery(options = {}) {
  const cache = readDiscoveryCache(options);
  const models = cache && Array.isArray(cache.models) ? cache.models : [];
  // 调用方显式给的版本优先；没给就用 init 帧记下来的那个。
  const localVersion = String(
    options.localVersion || (cache && cache.localCliVersion) || '',
  ).trim();
  return {
    loaded: models.length > 0,
    stale: !isCacheFresh(cache, options),
    catalogVersion: (cache && cache.catalogVersion) || 0,
    models,
    options: discoveredModelOptions(models, { localVersion }),
    notice: cliUpdateNotice({
      localVersion,
      latestVersion: cache && cache.releases ? cache.releases.latest : '',
      models,
    }),
  };
}

module.exports = {
  CACHE_FILE,
  CACHE_TTL_MS,
  CATALOG_URL,
  RELEASES_BASE,
  cliUpdateNotice,
  compareCliVersions,
  discoveredModelOptions,
  discoveryCachePath,
  fetchOfficialCatalog,
  fetchReleaseVersions,
  isCacheFresh,
  isValidCliVersion,
  normalizeCatalogModels,
  readClaudeModelDiscovery,
  readDiscoveryCache,
  noteSessionStart,
  recordLocalCliVersion,
  resolveFetchImpl,
  refreshClaudeModelDiscovery,
  writeDiscoveryCache,
};
