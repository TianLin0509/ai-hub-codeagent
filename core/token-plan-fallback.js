'use strict';
// 阿里云 Token Plan 套餐额度用完后，DeepSeek 旧 Harness 会话临时改走 DeepSeek 官方 API；
// 千问 / GLM 不改道，等额度重置（2026-10-12 用户拍板：只有 DeepSeek 要切 API）。
//
// 2026-10-12 实测（套餐月额度 100%）：
//   - 接口统一返回 429 insufficient_quota，正文「Your token-plan 1-month quota has been exhausted.
//     The quota will reset at 10-12 16:00:00 UTC.」；
//   - Qwen Code 不报错，把这句包成「Quota exhausted: ...」当普通回答交回；DSH 退出并打印
//     QUOTA: 429；ZCode 报 PROVIDER_BUSINESS_ERROR / insufficient_quota。
//   - 三个原生外壳直连 https://api.deepseek.com/v1 + deepseek-v4-flash，读文件的工具调用题 3/3 答对。
// 这里只放判断与状态；切换会话、重发消息的副作用在 main/token-plan-fallback-controller.js。
const fs = require('node:fs');
const path = require('node:path');

const DEEPSEEK_API_BASE = 'https://api.deepseek.com/v1';
const DEEPSEEK_ROUTE_PREFIX = 'deepseek-api:';
const TOKEN_PLAN_ROUTE_PREFIX = 'aliyun-token-plan:';
const FALLBACK_MODELS = Object.freeze(['deepseek-v4-pro', 'deepseek-v4-flash']);
const STATE_FILE = 'token-plan-fallback.json';
// 读不出重置时间时先按 1 小时算，到点再由下一次报错或用量读数续上。
const UNKNOWN_RESET_MS = 60 * 60 * 1000;
// 用量读数低于这个百分比才算「已恢复」，避免 99.9% 附近来回切。
const RECOVERED_BELOW_PCT = 98;

const PLAN_QUOTA_RE = /token-plan[\s\S]{0,40}quota has been exhausted/i;
// 报错通道（turn-error / 接口响应）：带 token-plan 原文或 insufficient_quota 都算。
function isTokenPlanQuotaText(text) { const t = String(text || ''); return PLAN_QUOTA_RE.test(t) || /\binsufficient_quota\b/i.test(t); }
// 正常回答通道：只认 Qwen Code 那条短的额度墙原文，讨论这个错误码的长回答不算。
function isTokenPlanQuotaAnswer(text) {
  const t = String(text || '').trim();
  return t.length <= 1200 && /^Quota exhausted:/i.test(t) && PLAN_QUOTA_RE.test(t);
}

// 「will reset at 10-12 16:00:00 UTC」→ 毫秒时间戳；年份取离 now 最近的那个将来时刻。
// 套餐窗口最长一个月：算出来超过 40 天的（比如引用了旧日志）不采信。
const MAX_RESET_AHEAD_MS = 40 * 24 * 3600_000;
function parseResetAt(text, now = Date.now()) {
  const m = String(text || '').match(/reset at (\d{1,2})-(\d{1,2}) (\d{1,2}):(\d{2})(?::(\d{2}))? UTC/i);
  if (!m) return null;
  const year = new Date(now).getUTCFullYear();
  for (const y of [year, year + 1]) {
    const at = Date.UTC(y, Number(m[1]) - 1, Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5] || 0));
    if (Number.isFinite(at) && at > now - 60_000) return at - now <= MAX_RESET_AHEAD_MS ? at : null;
  }
  return null;
}

function statePath(dataDir) { return path.join(dataDir, STATE_FILE); }
function readState(dataDir) {
  try {
    const value = JSON.parse(fs.readFileSync(statePath(dataDir), 'utf8').replace(/^﻿/, ''));
    return value && Number(value.exhaustedUntil) > 0 ? value : null;
  } catch { return null; }
}
function writeState(dataDir, value) {
  const file = statePath(dataDir), tmp = `${file}.${process.pid}-${Date.now()}.tmp`;
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, file);
}

function exhaustedUntil(dataDir, now = Date.now()) {
  const state = readState(dataDir);
  return state && Number(state.exhaustedUntil) > now ? Number(state.exhaustedUntil) : 0;
}

// 返回 true 表示这次让状态从「未用完」变成「用完」（或延长了重置时间）。
function markExhausted(dataDir, { resetsAt, source = 'unknown', now = Date.now() } = {}) {
  const until = Number(resetsAt) > now ? Number(resetsAt) : now + UNKNOWN_RESET_MS;
  const before = exhaustedUntil(dataDir, now);
  if (before >= until) return false;
  writeState(dataDir, { exhaustedUntil: until, observedAt: now, source, resetKnown: Number(resetsAt) > now });
  return true;
}

function clearExhausted(dataDir) {
  try { fs.unlinkSync(statePath(dataDir)); return true; }
  catch (error) { if (error.code !== 'ENOENT') throw error; return false; }
}

// 侧栏的套餐用量读数：任一窗口到 100% 记为用完；全部窗口明显回落则撤销（比如套餐已续费）。
function observeUsage(dataDir, snapshot, now = Date.now()) {
  const windows = [snapshot?.usage30d, snapshot?.usage7d].filter(w => w && Number.isFinite(w.pct));
  if (!windows.length) return null;
  const full = windows.find(w => w.pct >= 100);
  if (full) return markExhausted(dataDir, { resetsAt: full.resetsAt, source: 'usage', now }) ? 'exhausted' : null;
  const state = readState(dataDir);
  const observedAt = Number(snapshot.observedAt) || now;
  // 由真实 429 记下的状态，读数可能滞后：要比撞墙晚 10 分钟以上的回落读数才撤销。
  const lagMs = state && state.source !== 'usage' ? 10 * 60_000 : 60_000;
  if (state && windows.every(w => w.pct < RECOVERED_BELOW_PCT) && observedAt > Number(state.observedAt || 0) + lagMs) {
    clearExhausted(dataDir);
    return 'recovered';
  }
  return null;
}

function fallbackModel(model) {
  const id = String(model || '');
  if (FALLBACK_MODELS.includes(id)) return id;
  return /flash/i.test(id) ? 'deepseek-v4-flash' : 'deepseek-v4-pro';
}

// 套餐用完且配了 DeepSeek Key 才改道；任一条件不满足都留在套餐上（报错照常可见）。
// 只有这些外壳在套餐用完时改走 DeepSeek API；其余等重置。
const FALLBACK_KINDS = Object.freeze(['deepseek-acp']);
function canFallback(kind) { return FALLBACK_KINDS.includes(String(kind || '').replace(/-resume$/, '')); }

// 套餐用完、外壳允许改道、且配了 DeepSeek Key 才改道；否则留在套餐上等重置（waitForReset）。
function resolveRoute({ config, dataDir, kind, now = Date.now() } = {}) {
  const key = String(config?.deepseekApiKey || '').trim();
  const until = dataDir ? exhaustedUntil(dataDir, now) : 0;
  const allowed = kind === undefined || canFallback(kind);
  if (until && key && allowed) return { route: 'deepseek', apiKey: key, baseURL: DEEPSEEK_API_BASE, exhaustedUntil: until };
  return { route: 'token-plan', exhaustedUntil: until, waitForReset: !!until, missingKey: !!until && allowed && !key };
}

// 「aliyun-token-plan:qwen」与「deepseek-api:qwen」是同一会话的两条计费线路。
function sameProfileDomain(a, b) {
  const strip = id => String(id || '').replace(new RegExp('^(?:' + TOKEN_PLAN_ROUTE_PREFIX + '|' + DEEPSEEK_ROUTE_PREFIX + ')'), '');
  return a === b || (/^(?:aliyun-token-plan|deepseek-api):/.test(a || '') && /^(?:aliyun-token-plan|deepseek-api):/.test(b || '') && strip(a) === strip(b));
}
function isDeepSeekRouteProfile(profileId) { return String(profileId || '').startsWith(DEEPSEEK_ROUTE_PREFIX); }
function isTokenPlanRouteProfile(profileId) { return String(profileId || '').startsWith(TOKEN_PLAN_ROUTE_PREFIX); }

// 北京时间「10-13 00:00」，给提示文字用。
function formatReset(at) {
  if (!(Number(at) > 0)) return '';
  const d = new Date(Number(at) + 8 * 3600_000);
  const p = n => String(n).padStart(2, '0');
  return `${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

// 卡片提示：套餐用完、本会话不改道，等重置。
function waitNotice(dataDir, { missingKey = false, now = Date.now() } = {}) {
  const at = exhaustedUntil(dataDir, now);
  return 'Token Plan 本月额度已用完（' + (at ? '北京时间 ' + formatReset(at) + ' 重置' : '重置时间未知') + '）。'
    + (missingKey ? 'Hub 没有配置 DeepSeek API Key，不能改走 API；填好后重发，或等重置。' : '本会话不改走 API，重置后再发即可。');
}

// 卡片提示：会话正挂在 DeepSeek 备用线路上。
function deepseekRouteNotice(model, dataDir, now = Date.now()) {
  const at = exhaustedUntil(dataDir, now);
  return 'Token Plan 本月额度已用完（' + (at ? '北京时间 ' + formatReset(at) + ' 重置' : '重置时间未知') + '），本会话暂用 DeepSeek API · '
    + (model || 'DeepSeek') + '（按量计费，从 DeepSeek 余额扣）。重置后发下一条消息时自动切回套餐。';
}

module.exports = {
  DEEPSEEK_API_BASE, DEEPSEEK_ROUTE_PREFIX, TOKEN_PLAN_ROUTE_PREFIX, FALLBACK_MODELS, STATE_FILE,
  isTokenPlanQuotaText, isTokenPlanQuotaAnswer, parseResetAt, readState, exhaustedUntil, markExhausted, clearExhausted,
  observeUsage, fallbackModel, resolveRoute, deepseekRouteNotice, waitNotice, canFallback, FALLBACK_KINDS, isDeepSeekRouteProfile, isTokenPlanRouteProfile, sameProfileDomain, formatReset,
};
