'use strict';
// DeepSeek 跑在 Claude Code 上（2026-10-11 用户拍板）。
//
// 新建的 DeepSeek 会话一律是 kind = 'deepseek-claude'：真实 PTY 里的 Claude Code TUI，
// 与 Claude 会话共用 hook、状态、卡片和 transcript 绑定。区别只在环境变量：
//   - 接入方式两条：阿里云 Token Plan 套餐（默认、优先）或 DeepSeek 官方 API；
//   - 所有 Claude 模型名变量都指向所选的 DeepSeek 模型，任何请求都不会带出 Claude 模型名；
//   - CLAUDE_CONFIG_DIR 用独立目录（~/.claude-deepseek），里面绝不能有 Claude 登录信息。
// 旧的 kind = 'deepseek'（Codex 运行时 / 迁移前 Claude 兼容）会话仍按原路恢复，这里不碰。

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const KIND = 'deepseek-claude';
const DEFAULT_ROUTE = 'tokenplan';
const ROUTES = Object.freeze({
  tokenplan: Object.freeze({
    id: 'tokenplan',
    label: 'Token Plan 套餐',
    baseUrl: 'https://token-plan.cn-beijing.maas.aliyuncs.com/apps/anthropic',
    missingKey: '未配置阿里云 Token Plan 套餐 Key（Hub 配置 acp.apiKey）',
  }),
  api: Object.freeze({
    id: 'api',
    label: 'DeepSeek 官方 API',
    baseUrl: 'https://api.deepseek.com/anthropic',
    missingKey: '未配置 DeepSeek API Key（设置 → DeepSeek）',
  }),
});
const ROUTE_IDS = Object.freeze(Object.keys(ROUTES));

// 显示名一套，两条线各自的真实模型名不同：官方 API 只认 deepseek-flash（deepseek-v4.1-flash 返回 400）。
const DEFAULT_MODEL = 'deepseek-v4.1-flash';
const MODELS = Object.freeze([
  Object.freeze({ id: 'deepseek-v4.1-flash', label: 'DeepSeek V4.1 Flash', short: 'DS V4.1 Flash',
    wire: Object.freeze({ tokenplan: 'deepseek-v4.1-flash', api: 'deepseek-flash' }) }),
  Object.freeze({ id: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro', short: 'DS V4 Pro',
    wire: Object.freeze({ tokenplan: 'deepseek-v4-pro', api: 'deepseek-v4-pro' }) }),
]);
// 落盘或状态栏回报的可能是真实模型名；统一折回显示用的 id。
const MODEL_ALIASES = Object.freeze({
  'deepseek-flash': 'deepseek-v4.1-flash',
  'deepseek-v4-flash': 'deepseek-v4.1-flash',
});

function isDeepSeekClaudeKind(kind) {
  return String(kind || '').replace(/-resume$/, '') === KIND;
}

function normalizeRoute(route) {
  const value = String(route || '').trim().toLowerCase();
  return ROUTE_IDS.includes(value) ? value : null;
}

function normalizeModel(modelId) {
  const raw = String(modelId || '').trim().replace(/\[1m\]$/i, '').toLowerCase();
  if (MODELS.some(model => model.id === raw)) return raw;
  if (MODEL_ALIASES[raw]) return MODEL_ALIASES[raw];
  for (const model of MODELS) {
    if (Object.values(model.wire).includes(raw)) return model.id;
  }
  return DEFAULT_MODEL;
}

function isKnownModel(modelId) {
  const raw = String(modelId || '').trim().replace(/\[1m\]$/i, '').toLowerCase();
  return MODELS.some(model => model.id === raw || Object.values(model.wire).includes(raw)) || !!MODEL_ALIASES[raw];
}

function wireModel(modelId, route) {
  const routeId = normalizeRoute(route) || DEFAULT_ROUTE;
  const model = MODELS.find(item => item.id === normalizeModel(modelId));
  return model.wire[routeId];
}

function displayName(modelId, route) {
  const model = MODELS.find(item => item.id === normalizeModel(modelId));
  const routeId = normalizeRoute(route);
  return routeId ? `${model.short} · ${routeId === 'tokenplan' ? 'Token Plan' : '官方 API'}` : model.short;
}

function modelOptions() {
  return MODELS.map(model => ({ id: model.id, label: model.id === DEFAULT_MODEL ? `${model.label} · 默认` : model.label }));
}

// config 是 hub-config.getConfig() 的结果。Token Plan Key 与千问 / 旧 DSH 共用 config.acp.apiKey。
function routeKey(route, config = {}, env = process.env) {
  const routeId = normalizeRoute(route);
  if (routeId === 'tokenplan') return String((config.acp && config.acp.apiKey) || env.AI_HUB_TOKEN_PLAN_KEY || '').trim();
  if (routeId === 'api') return String(config.deepseekApiKey || '').trim();
  return '';
}

function routeAvailability(config = {}, env = process.env) {
  const result = {};
  for (const id of ROUTE_IDS) {
    const available = !!routeKey(id, config, env);
    result[id] = { id, label: ROUTES[id].label, available, reason: available ? '' : ROUTES[id].missingKey };
  }
  return result;
}

// 用户上次在面板上选的接入方式（config.json 的 providers.deepseek.route）；没有就是 Token Plan。
function preferredRoute(rawConfig = {}) {
  const saved = rawConfig && rawConfig.providers && rawConfig.providers.deepseek && rawConfig.providers.deepseek.route;
  return normalizeRoute(saved) || DEFAULT_ROUTE;
}

function withPreferredRoute(rawConfig, route) {
  const routeId = normalizeRoute(route);
  if (!routeId) throw new Error('DeepSeek 接入方式无效');
  const next = { ...(rawConfig || {}) };
  next.providers = { ...(next.providers || {}) };
  next.providers.deepseek = { ...(next.providers.deepseek || {}), route: routeId };
  return next;
}

// 显式选了哪条就用哪条；缺 Key 直接报错，不静默换成另一条。
function resolveLaunchRoute(requested, config = {}, env = process.env) {
  const explicit = requested == null || requested === '' ? null : normalizeRoute(requested);
  if (requested && !explicit) throw new Error('DeepSeek 接入方式无效，未启动会话');
  const routeId = explicit || DEFAULT_ROUTE;
  const key = routeKey(routeId, config, env);
  if (!key) throw new Error(`DeepSeek ${ROUTES[routeId].label}不可用：${ROUTES[routeId].missingKey}；未切换到其他接入方式`);
  return { route: routeId, key, baseUrl: ROUTES[routeId].baseUrl };
}

function configDir(env = process.env) {
  const override = String(env.AI_HUB_DEEPSEEK_CLAUDE_CONFIG_DIR || '').trim();
  if (override) return path.resolve(override);
  return path.join(env.USERPROFILE || env.HOME || os.homedir(), '.claude-deepseek');
}

// 防封号底线：DeepSeek 专用配置目录里不能出现 Claude 的登录凭据。发现就拒绝启动，交给用户处理，
// 不替他删文件（那可能是别处手动放进去的东西）。
function claudeLoginEvidence(dir) {
  const found = [];
  if (fs.existsSync(path.join(dir, '.credentials.json'))) found.push('.credentials.json');
  try {
    const state = JSON.parse(fs.readFileSync(path.join(dir, '.claude.json'), 'utf8'));
    if (state && typeof state === 'object') {
      if (state.oauthAccount) found.push('.claude.json:oauthAccount');
      if (state.primaryApiKey) found.push('.claude.json:primaryApiKey');
    }
  } catch {}
  return found;
}

function assertNoClaudeLogin(dir) {
  const found = claudeLoginEvidence(dir);
  if (found.length) {
    throw new Error(`DeepSeek 专用配置目录 ${dir} 里有 Claude 登录信息（${found.join('、')}），为防止账号被关联已拒绝启动；请先移走这些登录文件`);
  }
}

// DeepSeek 会话固定走 bypass，不进 auto 模式（2026-10-13/14 两次实测出事）：
//   - 2.1.296：独立目录没有 permissions.defaultMode，会话落进 auto，每次工具调用多一次分类器请求（走 Token Plan 计费）；
//   - 2.1.299：每个新会话弹「Make auto mode your default permission mode?」，光标默认在 Yes，
//     任何一次回车都会把 defaultMode 改成 auto；主 Claude 的状态里已答过（hasSeenAutoDefaultNudge），独立目录没有。
// disableAutoMode 从源头关掉 auto（分类器、Shift+Tab 进 auto、改默认的询问都没有）；nudge 标记是第二道保险。
// 两个文件都只在能解析时改、值已对就不写、tmp + rename 原子写；不凭空创建 .claude.json。
function ensurePermissionDefaults(dir, { fsImpl = fs, logger = console } = {}) {
  const { renameWithRetrySync } = require('./claude-project-trust.js');
  const result = { settings: 'unchanged', state: 'unchanged' };
  const update = (file, apply, { create = false } = {}) => {
    const target = path.join(dir, file);
    let raw = null;
    try { raw = fsImpl.readFileSync(target, 'utf8'); } catch {}
    if (raw === null && !create) return 'missing';
    let data = {};
    if (raw !== null) {
      try { data = JSON.parse(raw.replace(/^﻿/, '')); } catch { return 'unparsable'; }
      if (!data || typeof data !== 'object' || Array.isArray(data)) return 'unexpected';
    }
    if (!apply(data)) return 'unchanged';
    const tmp = `${target}.hub-${process.pid}-${Date.now()}.tmp`;
    fsImpl.mkdirSync(dir, { recursive: true });
    try {
      fsImpl.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8');
      renameWithRetrySync(tmp, target, { fsImpl });
    } finally {
      try { if (fsImpl.existsSync(tmp)) fsImpl.unlinkSync(tmp); } catch {}
    }
    return 'written';
  };
  try {
    result.settings = update('settings.json', settings => {
      const permissions = settings.permissions && typeof settings.permissions === 'object' && !Array.isArray(settings.permissions)
        ? settings.permissions : {};
      if (permissions.defaultMode === 'bypassPermissions' && permissions.disableAutoMode === 'disable') return false;
      settings.permissions = { ...permissions, defaultMode: 'bypassPermissions', disableAutoMode: 'disable' };
      return true;
    }, { create: true });
    result.state = update('.claude.json', state => {
      if (state.hasSeenAutoDefaultNudge === true) return false;
      state.hasSeenAutoDefaultNudge = true;
      return true;
    });
  } catch (error) {
    logger.warn?.('[deepseek-claude] permission defaults not pinned:', error && error.message);
    result.error = error && error.message;
  }
  return result;
}

const CLAUDE_MODEL_ENV_KEYS = Object.freeze([
  'ANTHROPIC_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'CLAUDE_CODE_SUBAGENT_MODEL',
]);
const PROXY_ENV_KEYS = Object.freeze(['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY',
  'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy']);

// 就地改写会话环境。返回实际用到的接入方式、真实模型名和配置目录。
function applyLaunchEnv(env, { route, model, config = {}, baseEnv = process.env } = {}) {
  const launch = resolveLaunchRoute(route, config, baseEnv);
  const wire = wireModel(model, launch.route);
  const dir = configDir(baseEnv);
  assertNoClaudeLogin(dir);
  for (const key of PROXY_ENV_KEYS) delete env[key];
  for (const key of ['ANTHROPIC_API_KEY', 'ANTHROPIC_API_BASE_URL', 'CLAUDE_CODE_OAUTH_TOKEN',
    'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'ANTHROPIC_SMALL_FAST_MODEL']) delete env[key];
  env.ANTHROPIC_BASE_URL = launch.baseUrl;
  // 真机验收用：只在隔离 Hub（CLAUDE_HUB_DATA_DIR）里允许把请求先经本地记账代理，代理按
  // /<route>/ 前缀转发到上面同一个真实端点，用来核对端点、Key 与模型名。生产实例不受影响。
  const e2eProxy = String(baseEnv.AI_HUB_E2E_DEEPSEEK_ROUTE_PROXY || '').trim();
  if (e2eProxy && baseEnv.CLAUDE_HUB_DATA_DIR && /^http:\/\/127\.0\.0\.1:\d+$/.test(e2eProxy)) {
    env.ANTHROPIC_BASE_URL = `${e2eProxy}/${launch.route}`;
  }
  env.ANTHROPIC_AUTH_TOKEN = launch.key;
  for (const key of CLAUDE_MODEL_ENV_KEYS) env[key] = wire;
  env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1';
  // claude.ai 账号连接器在 API Token 下无法认证，也不该去碰 Claude 账号。
  env.ENABLE_CLAUDEAI_MCP_SERVERS = 'false';
  env.CLAUDE_CONFIG_DIR = dir;
  return { route: launch.route, wireModel: wire, configDir: dir, baseUrl: launch.baseUrl };
}

module.exports = {
  KIND,
  DEFAULT_ROUTE,
  DEFAULT_MODEL,
  ROUTES,
  ROUTE_IDS,
  MODELS,
  CLAUDE_MODEL_ENV_KEYS,
  isDeepSeekClaudeKind,
  normalizeRoute,
  normalizeModel,
  isKnownModel,
  wireModel,
  displayName,
  modelOptions,
  routeKey,
  routeAvailability,
  preferredRoute,
  withPreferredRoute,
  resolveLaunchRoute,
  configDir,
  claudeLoginEvidence,
  assertNoClaudeLogin,
  ensurePermissionDefaults,
  applyLaunchEnv,
};
