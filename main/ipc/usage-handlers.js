'use strict';

const { didClaudeSnapshotAdvance } = require('../usage/claude-statusline-usage.js');

function hasUsageData(value) {
  if (!value || value.unavailable) return false;
  return [value.usage5h, value.usage7d]
    .some(window => window && typeof window.pct === 'number' && Number.isFinite(window.pct));
}

function hasDeepSeekBalanceData(value) {
  return !!(value && value.totalBalance !== null && value.totalBalance !== undefined
    && String(value.totalBalance).trim() !== '' && typeof value.totalBalance !== 'boolean'
    && Number.isFinite(Number(value.totalBalance)) && value.currency);
}

function deepSeekBalanceChanged(before, after) {
  const signature = (value) => JSON.stringify({
    available: value && value.available !== false,
    currency: value && value.currency || null,
    totalBalance: value && Number(value.totalBalance),
    toppedUpBalance: value && Number(value.toppedUpBalance),
    grantedBalance: value && Number(value.grantedBalance),
  });
  return signature(before) !== signature(after);
}

function registerUsageIpc(ipcMain, deps) {
  const {
    clearCodexJsonlCache,
    loadUsageCacheForCurrentConfig,
    refreshClaudeAccountUsage,
    refreshCodexAccountUsage,
    refreshDeepSeekAccountBalance,
    refreshKimiAccountUsage,
    refreshTokenPlanUsage,
    scanAgentSessions,
    getCodexUsageScopeKey = () => null,
  } = deps;

  const usageChanged = (before, after) => JSON.stringify({
    usage5h: before && before.usage5h || null,
    usage7d: before && before.usage7d || null,
  }) !== JSON.stringify({
    usage5h: after && after.usage5h || null,
    usage7d: after && after.usage7d || null,
  });

  const errorText = (err, fallback) => err && err.message ? err.message : fallback;

  ipcMain.handle('get-usage-cache', () => loadUsageCacheForCurrentConfig());

  const providerFlights = new Map();
  async function refreshProvider(provider) {
    const before = (loadUsageCacheForCurrentConfig() || {})[provider] || null;
    const scopeKey = provider === 'codex' ? getCodexUsageScopeKey() : null;
    const observed = value => value && (value.observedAt || value._ts || value.ts) || 0;
    try {
      const refresh = { claude: refreshClaudeAccountUsage, codex: refreshCodexAccountUsage,
        deepseek: refreshDeepSeekAccountBalance, tokenPlan: refreshTokenPlanUsage }[provider];
      if (typeof refresh !== 'function') throw new Error('刷新服务不可用');
      const raw = await refresh();
      if (provider === 'codex' && getCodexUsageScopeKey() !== scopeKey) throw new Error('Codex 账号已切换，请重新刷新');
      const data = provider === 'claude' && raw?.data !== undefined ? raw.data : raw;
      const valid = provider === 'deepseek' ? hasDeepSeekBalanceData(data) : hasUsageData(data);
      if (!valid) throw new Error('未取得有效数据');
      const observedAt = observed(data) || (provider === 'claude' ? raw?.observedAt : 0) || 0;
      const value = { ...data, observedAt };
      return { cache: { [provider]: value }, agentData: {}, refreshedAt: Date.now(),
        providerResults: { [provider]: { ok: true,
          changed: provider === 'claude' ? didClaudeSnapshotAdvance(before, value)
            : provider === 'deepseek' ? deepSeekBalanceChanged(before, value) : usageChanged(before, value),
          fresh: observedAt > observed(before), observedAt,
          mode: provider === 'claude' ? 'snapshot' : 'live',
          source: raw?.source || data.source || (provider === 'claude' ? 'statusline-cache' : 'live') } } };
    } catch (error) {
      // Keep the last observed value. A scoped refresh must never scan other
      // providers or manufacture a new observation timestamp on failure.
      const retained = provider === 'codex' && getCodexUsageScopeKey() !== scopeKey ? null : before;
      return { cache: retained ? { [provider]: retained } : {}, agentData: {}, refreshedAt: Date.now(),
        providerResults: { [provider]: { ok: false, fresh: false, changed: false,
          observedAt: observed(before), mode: 'snapshot', error: errorText(error, '刷新失败') } } };
    }
  }
  ipcMain.handle('refresh-usage-now', async (_event, provider) => {
    if (provider !== undefined) {
      if (!['claude', 'codex', 'deepseek', 'tokenPlan'].includes(provider)) throw new Error('不支持的刷新提供方');
      if (!providerFlights.has(provider)) {
        const flight = refreshProvider(provider).finally(() => providerFlights.delete(provider));
        providerFlights.set(provider, flight);
      }
      return providerFlights.get(provider);
    }
    const before = loadUsageCacheForCurrentConfig() || {};
    const providerResults = {};
    if (typeof refreshTokenPlanUsage === 'function') {
      const tokenResult = await refreshProvider('tokenPlan');
      Object.assign(providerResults, tokenResult.providerResults);
    }
    let refreshedClaudeData = null;

    try {
      const rawClaude = typeof refreshClaudeAccountUsage === 'function'
        ? await refreshClaudeAccountUsage()
        : null;
      const claudeData = rawClaude && rawClaude.data ? rawClaude.data : rawClaude;
      refreshedClaudeData = claudeData;
      const observedAt = rawClaude && rawClaude.observedAt
        || claudeData && (claudeData.observedAt || claudeData.ts)
        || before.claude && (before.claude.observedAt || before.claude.ts)
        || 0;
      providerResults.claude = {
        ok: hasUsageData(claudeData) || hasUsageData(before.claude),
        changed: rawClaude && typeof rawClaude.changed === 'boolean'
          ? rawClaude.changed
          : didClaudeSnapshotAdvance(before.claude, claudeData),
        mode: 'snapshot',
        source: rawClaude && rawClaude.source || 'statusline-cache',
        observedAt,
      };
    } catch (err) {
      providerResults.claude = {
        ok: false,
        changed: false,
        mode: 'snapshot',
        source: 'statusline-cache',
        observedAt: before.claude && (before.claude.observedAt || before.claude.ts) || 0,
        error: errorText(err, 'Claude 状态线快照读取失败'),
      };
    }

    let agentData = {};
    let liveError = null;
    try {
      if (typeof refreshCodexAccountUsage !== 'function') {
        throw new Error('Codex 实时刷新不可用');
      }
      const liveCodex = await refreshCodexAccountUsage();
      if (!hasUsageData(liveCodex)) {
        throw new Error('Codex 实时刷新未返回配额');
      }
      agentData.codex = liveCodex;
      providerResults.codex = {
        ok: true,
        changed: usageChanged(before.codex, liveCodex),
        mode: 'live',
        source: liveCodex.source || 'app-server',
        observedAt: liveCodex.observedAt || liveCodex._ts || Date.now(),
      };
    } catch (err) {
      liveError = errorText(err, 'Codex 实时刷新失败');
    }

    if (!agentData.codex) {
      if (typeof clearCodexJsonlCache === 'function') clearCodexJsonlCache();
      const scanned = typeof scanAgentSessions === 'function'
        ? (await scanAgentSessions({ force: true }) || {})
        : {};
      agentData = { ...agentData, ...scanned };
      const fallbackCodex = agentData.codex || null;
      providerResults.codex = {
        ok: hasUsageData(fallbackCodex),
        changed: usageChanged(before.codex, fallbackCodex),
        mode: 'fallback',
        source: fallbackCodex && fallbackCodex.source || 'jsonl',
        observedAt: fallbackCodex && (fallbackCodex.observedAt || fallbackCodex._ts) || 0,
        degraded: true,
        error: liveError,
      };
    }

    try {
      if (typeof refreshKimiAccountUsage !== 'function') {
        throw new Error('Kimi 实时刷新不可用');
      }
      const liveKimi = await refreshKimiAccountUsage();
      if (!hasUsageData(liveKimi)) {
        throw new Error('Kimi 实时刷新未返回配额');
      }
      agentData.kimi = liveKimi;
      providerResults.kimi = {
        ok: true,
        changed: usageChanged(before.kimi, liveKimi),
        mode: 'live',
        source: liveKimi.source || 'kimi-api',
        observedAt: liveKimi.observedAt || liveKimi._ts || Date.now(),
      };
    } catch (err) {
      const fallbackKimi = before.kimi || null;
      if (fallbackKimi) agentData.kimi = fallbackKimi;
      providerResults.kimi = {
        ok: hasUsageData(fallbackKimi),
        changed: false,
        mode: 'fallback',
        source: fallbackKimi && fallbackKimi.source || 'kimi-api',
        observedAt: fallbackKimi && (fallbackKimi.observedAt || fallbackKimi._ts || fallbackKimi.ts) || 0,
        degraded: true,
        error: errorText(err, 'Kimi 实时刷新失败'),
      };
    }

    try {
      if (typeof refreshDeepSeekAccountBalance !== 'function') {
        throw new Error('DeepSeek 余额刷新不可用');
      }
      const liveDeepSeek = await refreshDeepSeekAccountBalance();
      if (!hasDeepSeekBalanceData(liveDeepSeek)) {
        throw new Error('DeepSeek 余额接口未返回有效余额');
      }
      agentData.deepseek = liveDeepSeek;
      providerResults.deepseek = {
        ok: true,
        changed: deepSeekBalanceChanged(before.deepseek, liveDeepSeek),
        mode: 'live',
        source: liveDeepSeek.source || 'deepseek-balance-api',
        observedAt: liveDeepSeek.observedAt || liveDeepSeek._ts || Date.now(),
      };
    } catch (err) {
      const fallbackDeepSeek = before.deepseek || null;
      if (fallbackDeepSeek) agentData.deepseek = fallbackDeepSeek;
      providerResults.deepseek = {
        ok: hasDeepSeekBalanceData(fallbackDeepSeek),
        changed: false,
        mode: 'fallback',
        source: fallbackDeepSeek && fallbackDeepSeek.source || 'deepseek-balance-api',
        observedAt: fallbackDeepSeek && (fallbackDeepSeek.observedAt || fallbackDeepSeek._ts || fallbackDeepSeek.ts) || 0,
        degraded: true,
        error: errorText(err, 'DeepSeek 余额刷新失败'),
      };
    }

    const finalCache = loadUsageCacheForCurrentConfig() || {};
    const finalClaude = finalCache.claude || refreshedClaudeData || before.claude || null;
    const initialClaudeResult = providerResults.claude;
    const initialClaudeObservedAt = initialClaudeResult && initialClaudeResult.observedAt || 0;
    const finalClaudeObservedAt = finalClaude && (finalClaude.observedAt || finalClaude.ts) || 0;
    if (initialClaudeResult
      && (didClaudeSnapshotAdvance(refreshedClaudeData || before.claude, finalClaude)
        || finalClaudeObservedAt > initialClaudeObservedAt)) {
      providerResults.claude = {
        ...initialClaudeResult,
        ok: hasUsageData(finalClaude),
        changed: didClaudeSnapshotAdvance(before.claude, finalClaude),
        observedAt: finalClaudeObservedAt,
      };
    }

    return {
      cache: finalCache,
      agentData,
      providerResults,
      refreshedAt: Date.now(),
    };
  });
}

module.exports = {
  deepSeekBalanceChanged,
  hasDeepSeekBalanceData,
  hasUsageData,
  registerUsageIpc,
};
