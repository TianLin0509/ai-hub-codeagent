'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const DEFAULT_KIMI_BASE_URL = 'https://api.kimi.com/coding/v1';

function finiteNumber(value) {
  const parsed = typeof value === 'number' ? value : Number(String(value || '').trim());
  return Number.isFinite(parsed) ? parsed : null;
}

function toEpochMs(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'number' && Number.isFinite(value)) return value < 1e12 ? value * 1000 : value;
  const numeric = finiteNumber(value);
  if (numeric != null && /^\d+(?:\.\d+)?$/.test(String(value).trim())) {
    return numeric < 1e12 ? numeric * 1000 : numeric;
  }
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeWindow(detail, label) {
  if (!detail || typeof detail !== 'object') return null;
  const used = finiteNumber(detail.used);
  const limit = finiteNumber(detail.limit);
  if (used == null || limit == null || limit <= 0) return null;
  return {
    pct: Math.max(0, Math.round((used / limit) * 100)),
    used,
    limit,
    label,
    resetsAt: toEpochMs(detail.resetTime || detail.reset_time || detail.resetsAt),
  };
}

function usageWindowLabel(window) {
  const duration = finiteNumber(window && window.duration);
  const unit = String(window && (window.timeUnit || window.time_unit) || '').toLowerCase();
  if (duration === 300 && unit.includes('minute')) return '5h';
  if (duration != null && unit.includes('minute') && duration % 60 === 0) return `${duration / 60}h`;
  if (duration != null && unit.includes('hour')) return `${duration}h`;
  if (duration === 7 && unit.includes('day')) return '周';
  return duration != null ? String(duration) : '额度';
}

function parseKimiUsagePayload(payload, observedAt = Date.now()) {
  if (!payload || typeof payload !== 'object') throw new Error('Kimi 未返回账户额度');
  const limits = Array.isArray(payload.limits) ? payload.limits : [];
  let usage5h = null;
  for (const entry of limits) {
    const detail = entry && (entry.detail || entry.usage || entry);
    const label = usageWindowLabel(entry && entry.window);
    const normalized = normalizeWindow(detail, label);
    if (!normalized) continue;
    if (!usage5h || label === '5h') usage5h = normalized;
    if (label === '5h') break;
  }
  const usage7d = normalizeWindow(payload.usage, '周');
  if (!usage5h && !usage7d) throw new Error('Kimi 账户额度窗口为空');
  return {
    usage5h,
    usage7d,
    observedAt,
    source: 'kimi-api',
  };
}

function resolveKimiHome(home, env = process.env) {
  return path.resolve(home || env.KIMI_CODE_HOME || path.join(os.homedir(), '.kimi-code'));
}

async function readKimiAccountUsage(opts = {}) {
  const home = resolveKimiHome(opts.home, opts.env);
  const credentialPath = path.join(home, 'credentials', 'kimi-code.json');
  let credentials;
  try {
    credentials = JSON.parse(fs.readFileSync(credentialPath, 'utf8'));
  } catch {
    throw new Error('Kimi Code 尚未登录');
  }
  const accessToken = credentials && credentials.access_token;
  if (!accessToken) throw new Error('Kimi Code 登录凭据缺少 access_token');

  const fetchImpl = opts.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== 'function') throw new Error('当前运行时不支持 Kimi 额度请求');
  const baseUrl = String(opts.baseUrl || DEFAULT_KIMI_BASE_URL).replace(/\/+$/, '');
  const timeoutMs = Math.max(1000, Number(opts.timeoutMs) || 8000);
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  let response;
  try {
    response = await fetchImpl(`${baseUrl}/usages`, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${accessToken}`,
      },
      ...(controller ? { signal: controller.signal } : {}),
    });
  } catch (error) {
    if (error && error.name === 'AbortError') throw new Error('Kimi 额度请求超时');
    throw new Error(`Kimi 额度请求失败: ${error && error.message ? error.message : 'network error'}`);
  } finally {
    if (timer) clearTimeout(timer);
  }
  if (!response || !response.ok) {
    if (response && response.status === 401) throw new Error('Kimi Code 登录已失效，请重新登录');
    throw new Error(`Kimi 额度接口返回 HTTP ${response && response.status || 'unknown'}`);
  }
  const payload = await response.json();
  const now = typeof opts.now === 'function' ? opts.now() : Date.now();
  return parseKimiUsagePayload(payload, now);
}

module.exports = {
  DEFAULT_KIMI_BASE_URL,
  parseKimiUsagePayload,
  readKimiAccountUsage,
  resolveKimiHome,
};
