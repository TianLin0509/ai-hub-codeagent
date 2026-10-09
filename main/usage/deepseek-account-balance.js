'use strict';

const DEFAULT_DEEPSEEK_BASE_URL = 'https://api.deepseek.com';

function finiteMoney(value) {
  if (value == null || value === '') return null;
  const parsed = typeof value === 'number' ? value : Number(String(value).trim());
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeBalanceInfo(info) {
  if (!info || typeof info !== 'object') return null;
  const currency = String(info.currency || '').trim().toUpperCase();
  const totalBalance = finiteMoney(info.total_balance ?? info.totalBalance);
  const grantedBalance = finiteMoney(info.granted_balance ?? info.grantedBalance);
  const toppedUpBalance = finiteMoney(info.topped_up_balance ?? info.toppedUpBalance);
  if (!currency || totalBalance == null) return null;
  return {
    currency,
    totalBalance,
    grantedBalance: grantedBalance == null ? 0 : grantedBalance,
    toppedUpBalance: toppedUpBalance == null ? 0 : toppedUpBalance,
  };
}

function parseDeepSeekBalancePayload(payload, observedAt = Date.now()) {
  if (!payload || typeof payload !== 'object') throw new Error('DeepSeek 未返回余额信息');
  const balances = (Array.isArray(payload.balance_infos) ? payload.balance_infos : [])
    .map(normalizeBalanceInfo)
    .filter(Boolean);
  if (!balances.length) throw new Error('DeepSeek 余额明细为空');
  const primary = balances.find((item) => item.currency === 'CNY') || balances[0];
  return {
    available: payload.is_available !== false,
    currency: primary.currency,
    totalBalance: primary.totalBalance,
    grantedBalance: primary.grantedBalance,
    toppedUpBalance: primary.toppedUpBalance,
    balances,
    observedAt,
    source: 'deepseek-balance-api',
  };
}

async function readDeepSeekAccountBalance(opts = {}) {
  const apiKey = String(opts.apiKey || '').trim();
  if (!apiKey) throw new Error('DeepSeek API Key 尚未配置');
  const fetchImpl = opts.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== 'function') throw new Error('当前运行时不支持 DeepSeek 余额请求');

  const baseUrl = String(opts.baseUrl || DEFAULT_DEEPSEEK_BASE_URL).trim().replace(/\/+$/, '');
  const timeoutMs = Math.max(1000, Number(opts.timeoutMs) || 8000);
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  let response;
  try {
    response = await fetchImpl(`${baseUrl}/user/balance`, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      ...(controller ? { signal: controller.signal } : {}),
    });
  } catch (error) {
    if (error && error.name === 'AbortError') throw new Error('DeepSeek 余额请求超时');
    throw new Error(`DeepSeek 余额请求失败: ${error && error.message ? error.message : 'network error'}`);
  } finally {
    if (timer) clearTimeout(timer);
  }

  if (!response || !response.ok) {
    if (response && response.status === 401) throw new Error('DeepSeek API Key 无效或已失效');
    throw new Error(`DeepSeek 余额接口返回 HTTP ${response && response.status || 'unknown'}`);
  }
  const payload = await response.json();
  const observedAt = typeof opts.now === 'function' ? opts.now() : Date.now();
  return parseDeepSeekBalancePayload(payload, observedAt);
}

module.exports = {
  DEFAULT_DEEPSEEK_BASE_URL,
  normalizeBalanceInfo,
  parseDeepSeekBalancePayload,
  readDeepSeekAccountBalance,
};
