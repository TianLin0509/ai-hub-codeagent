'use strict';

const { createSidebarAccountUsage } = require('./sidebar-account-usage.js');
const { mergeCodexEntry, sameScope } = require('../main/usage/usage-cache-merge.js');

const LOW_BALANCE_THRESHOLD = 20;
const PROVIDER_NAMES = { claude: 'Claude', codex: 'Codex', deepseek: 'DeepSeek', tokenPlan: 'Token Plan' };
const usageLevel = percent => percent > 85 ? 'danger' : percent >= 60 ? 'warn' : 'muted';
const validPercent = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
function balanceValue(provider) {
  const value = (provider && (provider.balance || provider) || {}).totalBalance;
  if ((typeof value !== 'number' && typeof value !== 'string') || String(value).trim() === '') return null;
  return Number.isFinite(Number(value)) ? Number(value) : null;
}

function pickTightestWindow(snapshot) {
  let tightest = null;
  for (const provider of ['claude', 'codex']) {
    for (const window of ['5h', '7d']) {
      const percent = snapshot?.[provider]?.['usage' + window]?.pct;
      if (validPercent(percent) && (!tightest || percent > tightest.percent)) {
        tightest = { provider, window, percent, level: usageLevel(percent) };
      }
    }
  }
  const balance = balanceValue(snapshot?.deepseek);
  // 60 is a warning rank, never a percentage of money spent.
  if (balance !== null && balance < LOW_BALANCE_THRESHOLD && (!tightest || tightest.percent < 60)) {
    tightest = { provider: 'deepseek', window: 'balance', percent: 60, level: 'warn' };
  }
  return tightest;
}

function createAccountUsageController({
  document,
  ipcRenderer,
  sessions,
  escapeHtml,
  setIntervalFn = setInterval,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
  nowFn = Date.now,
  isMemoOpen = () => false,
}) {
  if (!document) throw new Error('document is required');
  if (!ipcRenderer) throw new Error('ipcRenderer is required');
  if (!sessions) throw new Error('sessions is required');
  if (typeof escapeHtml !== 'function') throw new Error('escapeHtml is required');

  const accountUsage = { usage5h: null, usage7d: null };
  // The Codex subscription accounts not in use right now: read when the popover opens.
  let otherCodex = [];
  const otherCodexState = { inFlight: false };
  async function loadOtherCodex(force = false) {
    if (otherCodexState.inFlight) return;
    otherCodexState.inFlight = true;
    render();
    try {
      const list = await ipcRenderer.invoke('refresh-codex-other-usage', { force });
      if (Array.isArray(list)) otherCodex = list;
    } catch { /* the rows keep their last reading */ }
    finally { otherCodexState.inFlight = false; render(); }
  }
  Promise.resolve().then(() => ipcRenderer.invoke('codex-other-usage'))
    .then(list => { if (Array.isArray(list)) { otherCodex = list; render(); } }).catch(() => {});
  const agentUsage = { gemini: null, codex: null, kimi: null, deepseek: null, tokenPlan: null };
  const agentUsageLastSeen = { gemini: 0, codex: 0, kimi: 0, deepseek: 0, tokenPlan: 0 };
  let _claudeUsageLastSeen = 0;
  const usageRefreshState = { inFlight: false, error: null, lastManualAt: 0, providerResults: null };
  const providerRefreshStates = Object.fromEntries(['claude', 'codex', 'deepseek', 'tokenPlan'].map(p => [p,
    { inFlight: false, error: null, result: null }]));
  let _refreshStatusTimer = null;
  let staleTimer = null;
  let hoverTimer = null;
  let ui = null;
  let popoverPinned = false;

  const BURN_HISTORY_MS = 15 * 60 * 1000;
  const globalUsageSamples = []; // [{t, pct, totalUsedTokens}]
  const DEFAULT_TOKENS_PER_PCT = 2_000_000; // fallback baseline if we have no delta
  
  function pruneSamples(arr, now) {
    const cutoff = now - BURN_HISTORY_MS;
    while (arr.length && arr[0].t < cutoff) arr.shift();
  }
  
  function aggregateUsedTokens(now) {
    let total = 0;
    for (const s of sessions.values()) {
      // Use each session's most recent contextUsed as a proxy. Not perfect —
      // but good enough to attribute ratably.
      if (typeof s.contextUsed === 'number') total += s.contextUsed;
    }
    return total;
  }
  
  function estimateTokensPerPct() {
    // Find two global samples far enough apart with a positive pct delta.
    for (let i = globalUsageSamples.length - 1; i >= 1; i--) {
      const a = globalUsageSamples[i];
      for (let j = i - 1; j >= 0; j--) {
        const b = globalUsageSamples[j];
        if (a.t - b.t < 60 * 1000) continue; // need ≥1 min spread
        const dp = a.pct - b.pct;
        const dt = a.totalUsedTokens - b.totalUsedTokens;
        if (dp > 0.3 && dt > 0) return dt / dp;
      }
    }
    return DEFAULT_TOKENS_PER_PCT;
  }
  
  function sessionBurnRate(session) {
    const samples = session._tokenSamples;
    if (!samples || samples.length < 2) return null;
    const first = samples[0];
    const last = samples[samples.length - 1];
    const dt = last.t - first.t;
    if (dt < 60 * 1000) return null;
    const dTokens = last.used - first.used;
    if (dTokens <= 0) return null;
    const tokensPerMin = dTokens / (dt / 60000);
    const tokensPerPct = estimateTokensPerPct();
    const pctPerHour = (tokensPerMin * 60) / tokensPerPct;
    return { tokensPerMin, pctPerHour };
  }

  function recordStatusUsage(payload) {
    if (!payload) return;
    if (payload.usage5h || payload.usage7d) {
      const observedAt = payload.observedAt ?? nowFn();
      if (observedAt < _claudeUsageLastSeen) return;
      if (observedAt > _claudeUsageLastSeen) {
        providerRefreshStates.claude.error = null;
        providerRefreshStates.claude.result = null;
      }
      _claudeUsageLastSeen = observedAt;
    }
    if (payload.usage5h) {
      accountUsage.usage5h = payload.usage5h;
      const now = nowFn();
      globalUsageSamples.push({ t: now, pct: payload.usage5h.pct, totalUsedTokens: aggregateUsedTokens(now) });
      pruneSamples(globalUsageSamples, now);
    }
    if (payload.usage7d) accountUsage.usage7d = payload.usage7d;
    render();
  }

  function recordSessionContextSample(session, contextUsed) {
    if (!session || typeof contextUsed !== 'number') return;
    if (!session._tokenSamples) session._tokenSamples = [];
    session._tokenSamples.push({ t: nowFn(), used: contextUsed });
    pruneSamples(session._tokenSamples, nowFn());
  }

  function recordAgentUsage(totals) {
    if (totals && totals.gemini && (totals.gemini.usage5h || totals.gemini.usage7d)) {
      agentUsage.gemini = totals.gemini;
      agentUsageLastSeen.gemini = totals.gemini.observedAt || totals.gemini._ts || nowFn();
    }
    if (Object.prototype.hasOwnProperty.call(totals || {}, 'codex')) {
      recordCodexUsage(totals.codex);
    }
    if (Object.prototype.hasOwnProperty.call(totals || {}, 'kimi')) {
      agentUsage.kimi = totals.kimi;
      agentUsageLastSeen.kimi = (totals.kimi && (totals.kimi.observedAt || totals.kimi._ts)) || nowFn();
    }
    if (Object.prototype.hasOwnProperty.call(totals || {}, 'tokenPlan')) recordTokenPlan(totals.tokenPlan);
    if (Object.prototype.hasOwnProperty.call(totals || {}, 'deepseek')) {
      agentUsage.deepseek = totals.deepseek;
      agentUsageLastSeen.deepseek = (totals.deepseek && (totals.deepseek.observedAt || totals.deepseek._ts)) || nowFn();
    }
    render();
  }

  function recordTokenPlan(value) {
    agentUsage.tokenPlan = value;
    agentUsageLastSeen.tokenPlan = value?.observedAt || 0;
    providerRefreshStates.tokenPlan.error = value?.error || null;
  }

  function recordCodexUsage(value) {
    // Explicit clears/account switches cannot inherit another account's quota.
    const merged = value && sameScope(agentUsage.codex, value)
      ? mergeCodexEntry(agentUsage.codex, value, nowFn()) : value;
    agentUsage.codex = merged;
    agentUsageLastSeen.codex = merged && (merged.observedAt || merged._ts || merged.ts) || 0;
  }

  function applyUsageCache(cached) {
    if (!cached) cached = {};
    if (cached.claude && (cached.claude.usage5h || cached.claude.usage7d)) {
      accountUsage.usage5h = cached.claude.usage5h;
      accountUsage.usage7d = cached.claude.usage7d;
      _claudeUsageLastSeen = cached.claude.observedAt || cached.claude.ts || _claudeUsageLastSeen;
    }
    if (cached.gemini) agentUsage.gemini = cached.gemini;
    if (cached.gemini) agentUsageLastSeen.gemini = cached.gemini.observedAt || cached.gemini.ts || agentUsageLastSeen.gemini;
    if (Object.prototype.hasOwnProperty.call(cached, 'codex')) recordCodexUsage(cached.codex);
    if (cached.kimi) agentUsage.kimi = cached.kimi;
    if (cached.kimi) agentUsageLastSeen.kimi = cached.kimi.observedAt || cached.kimi.ts || agentUsageLastSeen.kimi;
    if (Object.prototype.hasOwnProperty.call(cached, 'tokenPlan')) recordTokenPlan(cached.tokenPlan);
    if (cached.deepseek) agentUsage.deepseek = cached.deepseek;
    if (cached.deepseek) agentUsageLastSeen.deepseek = cached.deepseek.observedAt || cached.deepseek.ts || agentUsageLastSeen.deepseek;
    render();
  }

  function formatResetIn(resetsAt) {
    if (!resetsAt) return '';
    const ms = new Date(resetsAt).getTime() - nowFn();
    if (isNaN(ms) || ms <= 0) return '';
    const mins = Math.round(ms / 60000);
    if (mins < 60) return `${mins}m`;
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    if (h < 24) return `${h}h${m ? ' ' + m + 'm' : ''}`;
    const d = Math.floor(h / 24);
    return `${d}d ${h % 24}h`;
  }

  function formatAge(ts) {
    if (!Number.isFinite(ts) || ts <= 0) return '数据未刷新';
    return '数据 ' + Math.floor(Math.max(0, nowFn() - ts) / 60000) + ' 分钟前';
  }

  function formatBalance(provider) {
    const total = balanceValue(provider);
    if (total === null) return '—';
    const balance = provider?.balance || provider || {};
    const currency = String(balance.currency || 'CNY').toUpperCase();
    return (currency === 'CNY' ? '¥' : currency + ' ') + total.toFixed(2);
  }

  function usageFreshnessClass(ts) {
    if (!Number.isFinite(ts) || ts <= 0) return 'unknown';
    return nowFn() - ts > 120000 ? 'stale' : 'fresh';
  }

  async function refreshProviderNow(provider) {
    if (!Object.prototype.hasOwnProperty.call(providerRefreshStates, provider)) throw new Error('不支持的刷新提供方');
    const state = providerRefreshStates[provider];
    if (!state) throw new Error('不支持的刷新提供方');
    if (state.inFlight || usageRefreshState.inFlight) return null;
    state.inFlight = true; state.error = null; state.result = null;
    render();
    try {
      const result = await ipcRenderer.invoke('refresh-usage-now', provider);
      const status = result?.providerResults?.[provider];
      if (!status) throw new Error('刷新未返回提供方结果');
      state.result = status;
      state.error = status.ok === false || status.degraded ? status.error || '未取得有效数据' : null;
      const value = result.cache?.[provider];
      const lastSeen = getSnapshot()[provider]?.lastSeen || 0;
      const observedAt = value?.observedAt || value?._ts || value?.ts || 0;
      // Do not roll a provider back when its background observation won a race.
      if (status.ok && !status.degraded && value && observedAt >= lastSeen) applyUsageCache({ [provider]: value });
      return result;
    } catch (error) {
      state.error = error?.message || '刷新失败';
      throw error;
    } finally { state.inFlight = false; render(); }
  }

  function refreshUsageNow(provider) {
    if (provider !== undefined) return refreshProviderNow(provider);
    if (Object.values(providerRefreshStates).some(state => state.inFlight)) return Promise.resolve(null);
    if (usageRefreshState.inFlight) return Promise.resolve(null);
    usageRefreshState.inFlight = true;
    usageRefreshState.error = null;
    render();
    return Promise.resolve().then(() => ipcRenderer.invoke('refresh-usage-now'))
      .then((result) => {
        void loadOtherCodex(true);
        usageRefreshState.providerResults = result && result.providerResults || null;
        usageRefreshState.error = ['claude', 'codex', 'deepseek'].flatMap(provider => {
          const status = usageRefreshState.providerResults?.[provider];
          return status && (status.ok === false || status.degraded)
            ? [`${PROVIDER_NAMES[provider]}: ${status.error || '实时接口不可用，已降级到本地快照'}`] : [];
        }).join('；') || null;
        usageRefreshState.lastManualAt = (result && result.refreshedAt) || nowFn();
        if (_refreshStatusTimer !== null) clearTimeoutFn(_refreshStatusTimer);
        _refreshStatusTimer = setTimeoutFn(() => {
          _refreshStatusTimer = null;
          render();
        }, Math.max(1, usageRefreshState.lastManualAt + 60_001 - nowFn()));
        if (result && result.cache) applyUsageCache(result.cache);
        if (result && result.agentData) recordAgentUsage(result.agentData);
        return result;
      })
      .catch((err) => {
        usageRefreshState.error = err && err.message ? err.message : '刷新失败';
        throw err;
      })
      .finally(() => {
        usageRefreshState.inFlight = false;
        render();
      });
  }
  

  function makeElement(tag, className, parent, text) {
    const el = document.createElement(tag);
    el.className = className;
    if (text !== undefined) el.textContent = text;
    parent.appendChild(el);
    return el;
  }

  function positionPopover(reanchor = false) {
    if (!ui || ui.popover.hidden) return;
    const view = document.defaultView;
    const anchor = ui.button.getBoundingClientRect();
    const rect = ui.popover.getBoundingClientRect();
    // The compact collapse control shares the Claude row to the right of details.
    // Open beside the whole sidebar so the popover does not cover that control.
    const insights = document.getElementById('sidebar-insights');
    const anchorRight = insights?.contains(ui.button) ? Math.max(anchor.right, insights.getBoundingClientRect().right) : anchor.right;
    ui.popover.style.left = Math.max(8, Math.min(anchorRight + 10, view.innerWidth - rect.width - 8)) + 'px';
    const previousTop = Number.parseFloat(ui.popover.style.top);
    const top = reanchor === true || !Number.isFinite(previousTop) ? anchor.bottom - rect.height : previousTop;
    // Status text can change while hovered. Keep the top edge steady unless it
    // would overflow the viewport, rather than moving controls under the cursor.
    ui.popover.style.top = Math.max(8, Math.min(top, view.innerHeight - rect.height - 8)) + 'px';
  }

  function cancelHoverClose() {
    if (hoverTimer !== null) clearTimeoutFn(hoverTimer);
    hoverTimer = null;
  }

  function setPopoverOpen(open, returnFocus = false) {
    cancelHoverClose();
    if (!ui) return;
    const wasHidden = ui.popover.hidden;
    ui.popover.hidden = !open;
    ui.button.setAttribute('aria-expanded', String(open));
    if (!open) popoverPinned = false;
    if (open) positionPopover(wasHidden);
    if (open && wasHidden) void loadOtherCodex(false);
    else if (returnFocus) ui.button.focus({ preventScroll: true });
  }

  function ensureUi() {
    if (ui) return ui;
    const root = document.getElementById('rail-usage');
    if (!root) return null;
    const sidebar = root.className === 'sidebar-account-usage' ? createSidebarAccountUsage({
      document, root, refresh: refreshProviderNow, formatAge, formatBalance, freshness: usageFreshnessClass, nowFn,
    }) : null;
    const button = makeElement('button', 'rail-usage-button', sidebar ? sidebar.detailsHost : root);
    button.type = 'button';
    button.setAttribute('aria-haspopup', 'dialog');
    button.setAttribute('aria-controls', 'rail-usage-popover');
    button.setAttribute('aria-expanded', 'false');
    const ring = makeElement('span', 'rail-usage-ring', button);
    const value = makeElement('span', 'rail-usage-value', ring);
    ring.setAttribute('aria-hidden', 'true');
    if (sidebar) makeElement('span', 'sidebar-quota-details', button, '⋯');
    const popover = makeElement('section', 'usage-popover', root);
    popover.id = 'rail-usage-popover';
    popover.hidden = true;
    popover.setAttribute('role', 'dialog');
    popover.setAttribute('aria-label', '账户用量明细');
    makeElement('strong', 'usage-popover-title', popover, '账户用量');
    const rows = makeElement('div', 'usage-popover-rows', popover);
    const footer = makeElement('div', 'usage-popover-footer', popover);
    const age = makeElement('span', 'usage-age', footer);
    age.title = '取三家已知观测中最旧的时间；未获取的提供商另标未刷新';
    const actions = makeElement('div', 'usage-popover-actions', footer);
    // Created once; the memo markup also retains the existing global-entry contract.
    actions.innerHTML = '<button type="button" class="usage-refresh" data-action="refresh-usage">刷新</button>'
      + '<button type="button" class="btn-memo-toggle" data-action="open-memo">备忘录</button>'
      + '<button type="button" class="usage-home">主页看全貌</button>';
    const refresh = actions.querySelector('.usage-refresh');
    const memo = actions.querySelector('.btn-memo-toggle');
    const home = actions.querySelector('.usage-home');
    const notice = makeElement('div', 'usage-refresh-notice', popover);
    notice.setAttribute('role', 'status');
    ui = { root, button, ring, value, popover, rows, age, refresh, memo, home, notice, sidebar };
    const enter = () => { cancelHoverClose(); setPopoverOpen(true); };
    const leave = () => {
      cancelHoverClose();
      if (!popoverPinned) hoverTimer = setTimeoutFn(() => {
        hoverTimer = null;
        if (!root.matches(':hover') && !popover.contains(document.activeElement)) setPopoverOpen(false);
      }, 180);
    };
    button.addEventListener('pointerenter', enter);
    popover.addEventListener('pointerenter', enter);
    button.addEventListener('pointerleave', leave);
    popover.addEventListener('pointerleave', leave);
    button.addEventListener('click', () => {
      if (popoverPinned) setPopoverOpen(false);
      else { popoverPinned = true; setPopoverOpen(true); }
    });
    root.addEventListener('focusout', event => {
      if (!root.contains(event.relatedTarget) && !popoverPinned) setPopoverOpen(false);
    });
    document.addEventListener('pointerdown', event => {
      if (!root.contains(event.target)) setPopoverOpen(false);
    });
    document.addEventListener('keydown', event => {
      if (event.key === 'Escape' && !popover.hidden) {
        event.preventDefault();
        event.stopPropagation();
        setPopoverOpen(false, true);
      }
    }, true);
    document.defaultView.addEventListener('resize', positionPopover);
    document.addEventListener('sidebar-insights:visibility', event => {
      if (event.detail.collapsed) setPopoverOpen(false);
    });
    // Keep the action nodes stable across usage updates: focus and hover survive.
    refresh.addEventListener('click', () => {
      refreshUsageNow().catch(error => {
        // The command rejects for programmatic callers; the UI displays its failure.
        notice.textContent = '刷新失败：' + (error?.message || '未知错误');
        notice.hidden = false;
      });
    });
    home.addEventListener('click', () => {
      const homeButton = document.getElementById('btn-home');
      if (!homeButton) {
        notice.textContent = '主页入口暂不可用';
        notice.hidden = false;
        return;
      }
      setPopoverOpen(false);
      homeButton.click();
      homeButton.focus({ preventScroll: true });
    });
    return ui;
  }

  function render() {
    const ticker = document.getElementById('quota-ticker');
    if (ticker) ticker.style.display = 'none'; // One-release compatibility node.
    if (!ensureUi()) return;
    const snapshot = getSnapshot();
    if (ui.sidebar) ui.sidebar.render(snapshot, providerRefreshStates);
    const tightest = pickTightestWindow(snapshot);
    const lastSeen = tightest ? snapshot[tightest.provider]?.lastSeen : 0;
    const freshness = usageFreshnessClass(lastSeen);
    const display = tightest ? tightest.window === 'balance' ? '!' : Math.round(tightest.percent) + '%' : '—';
    const selectedLabel = tightest
      ? tightest.window === 'balance' ? 'DeepSeek 余额偏低 · ' + formatBalance(snapshot.deepseek)
        : PROVIDER_NAMES[tightest.provider] + ' ' + tightest.window + ' 用量 ' + tightest.percent + '%'
      : '用量暂无数据';
    ui.button.dataset.provider = tightest?.provider || '';
    ui.button.dataset.window = tightest?.window || '';
    ui.button.dataset.level = tightest?.level || 'muted';
    ui.button.dataset.freshness = freshness;
    ui.button.title = selectedLabel + ' · ' + formatAge(lastSeen) + '（按获选提供商观测时间）';
    ui.button.setAttribute('aria-label', ui.button.title + '；打开账户用量明细');
    if (ui.sidebar) {
      ui.button.title = '账户用量明细、备忘录与主页';
      ui.button.setAttribute('aria-label', ui.button.title);
    }
    ui.ring.style.setProperty('--usage-percent', (tightest ? Math.min(100, Math.max(0, tightest.percent)) : 0) + '%');
    ui.value.textContent = display;
    if (staleTimer !== null) clearTimeoutFn(staleTimer);
    staleTimer = null;
    const nextExpiry = ['claude', 'codex', 'deepseek'].map(p => snapshot[p]?.lastSeen)
      .filter(ts => ts && usageFreshnessClass(ts) === 'fresh').sort((a, b) => a - b)[0];
    if (nextExpiry) {
      staleTimer = setTimeoutFn(() => { staleTimer = null; render(); }, Math.max(1, nextExpiry + 120001 - nowFn()));
    }

    const renderBar = (percent, level) => '<span class="usage-bar-track" aria-hidden="true"><span class="usage-bar-fill ' + level
      + '" style="width:' + Math.min(100, Math.max(0, percent)) + '%"></span></span>';
    const renderWindow = (window, usage) => {
      const pct = validPercent(usage?.pct) ? usage.pct : null;
      const reset = usage?.resetsAt ? formatResetIn(usage.resetsAt) : '';
      return '<span class="usage-window ' + (pct === null ? 'muted' : usageLevel(pct)) + '" title="'
        + escapeHtml(reset ? window + ' 配额重置还有 ' + reset : window + ' 重置时间未知')
        + '"><i>' + window + '</i><b>' + (pct === null ? '—' : Math.round(pct) + '%') + '</b>'
        + (reset ? '<em>↻' + escapeHtml(reset) + '</em>' : '') + '</span>';
    };
    ui.rows.innerHTML = ['claude', 'codex', 'deepseek'].map(provider => {
      const data = snapshot[provider] || {};
      const name = PROVIDER_NAMES[provider] + (data.profileLabel ? '·' + data.profileLabel : '')
        + (provider === 'codex' && otherCodex.length ? '（在用）' : '');
      const providerResult = usageRefreshState.providerResults?.[provider];
      const tip = name + ' · ' + formatAge(data.lastSeen)
        + (data.source ? ' · ' + data.source : provider === 'claude' ? ' · statusline' : '')
        + (data.accountEmail ? ' · ' + data.accountEmail : '')
        + (providerResult?.error ? ' · 刷新异常：' + providerResult.error : '');
      let bar, detail;
      if (provider === 'deepseek') {
        const balance = balanceValue(data);
        const low = balance !== null && balance < LOW_BALANCE_THRESHOLD;
        bar = renderBar(low ? 60 : 0, low ? 'warn' : 'muted');
        detail = '<span class="usage-window ' + (low ? 'warn' : 'muted') + '"><i>余额</i><b>'
          + escapeHtml(formatBalance(data)) + '</b></span>';
        if ((data.balance || data).available === false) detail += '<span class="usage-unavailable">当前不可用</span>';
      } else {
        const pick = pickTightestWindow({ [provider]: data });
        bar = renderBar(pick?.percent || 0, pick?.level || 'muted');
        detail = renderWindow('5h', data.usage5h) + renderWindow('7d', data.usage7d);
      }
      return '<div class="usage-provider-row" data-provider="' + provider + '" title="' + escapeHtml(tip)
        + '"><span class="usage-provider-name">' + escapeHtml(name) + '</span>' + bar
        + '<span class="usage-provider-detail">' + detail + '</span>'
        + (!data.lastSeen ? '<span class="usage-row-age">未刷新</span>' : '') + '</div>';
    }).join('');
    // Other Codex accounts, right under the one in use.
    const otherRows = otherCodex.map(other => {
      const name = 'Codex·' + (other.profileLabel || other.profileId);
      const tip = name + ' · 未在使用' + (other.accountEmail ? ' · ' + other.accountEmail : '')
        + (other.observedAt ? ' · ' + formatAge(other.observedAt) : '') + (other.error ? ' · 读取异常：' + other.error : '');
      let bar, detail, age = '';
      if (other.apiKey) {
        bar = renderBar(0, 'muted');
        detail = '<span class="usage-unavailable">API Key 登录，没有订阅配额</span>';
      } else {
        const pick = pickTightestWindow({ codex: other });
        bar = renderBar(pick?.percent || 0, pick?.level || 'muted');
        detail = renderWindow('5h', other.usage5h) + renderWindow('7d', other.usage7d);
        if (!other.observedAt) age = otherCodexState.inFlight ? '查询中…' : other.error ? '读取失败' : '未刷新';
      }
      return '<div class="usage-provider-row usage-provider-other" data-provider="codex-other" data-profile="' + escapeHtml(other.profileId)
        + '" title="' + escapeHtml(tip) + '"><span class="usage-provider-name">' + escapeHtml(name) + '</span>' + bar
        + '<span class="usage-provider-detail">' + detail + '</span>' + (age ? '<span class="usage-row-age">' + age + '</span>' : '') + '</div>';
    }).join('');
    if (otherRows) {
      const codexRow = ui.rows.querySelector('[data-provider="codex"]');
      if (codexRow) codexRow.insertAdjacentHTML('afterend', otherRows); else ui.rows.insertAdjacentHTML('beforeend', otherRows);
    }
    const times = ['claude', 'codex', 'deepseek'].map(p => snapshot[p]?.lastSeen).filter(ts => Number.isFinite(ts) && ts > 0);
    ui.age.textContent = formatAge(times.length ? Math.min(...times) : 0) + (times.length ? '（取三家最旧）' : '');
    ui.refresh.textContent = usageRefreshState.inFlight ? '刷新中…' : '刷新';
    // aria-disabled keeps keyboard focus on the same node; refreshUsageNow guards re-entry.
    ui.refresh.setAttribute('aria-disabled', String(usageRefreshState.inFlight || Object.values(providerRefreshStates).some(s => s.inFlight)));
    ui.memo.classList.toggle('active', isMemoOpen());
    ui.notice.textContent = usageRefreshState.error ? '刷新异常：' + usageRefreshState.error
      : usageRefreshState.lastManualAt && nowFn() - usageRefreshState.lastManualAt < 60000 ? '刷新请求已完成，数据时间以各提供商观测为准' : '';
    ui.notice.hidden = !ui.notice.textContent;
    positionPopover();
  }

  setIntervalFn(render, 60000);
  
  function pctClass(pct) {
    if (pct >= 85) return 'danger';
    if (pct >= 70) return 'warn';
    return 'ok';
  }

  function getSnapshot() {
    return {
      claude: {
        usage5h: accountUsage.usage5h,
        usage7d: accountUsage.usage7d,
        lastSeen: _claudeUsageLastSeen,
      },
      codex: agentUsage.codex ? { ...agentUsage.codex, lastSeen: agentUsageLastSeen.codex } : null,
      gemini: agentUsage.gemini ? { ...agentUsage.gemini, lastSeen: agentUsageLastSeen.gemini } : null,
      kimi: agentUsage.kimi ? { ...agentUsage.kimi, lastSeen: agentUsageLastSeen.kimi } : null,
      tokenPlan: agentUsage.tokenPlan ? { ...agentUsage.tokenPlan, lastSeen: agentUsageLastSeen.tokenPlan } : null,
      deepseek: agentUsage.deepseek ? { ...agentUsage.deepseek, lastSeen: agentUsageLastSeen.deepseek } : null,
      refresh: {
        inFlight: usageRefreshState.inFlight,
        error: usageRefreshState.error,
        lastManualAt: usageRefreshState.lastManualAt,
        providers: Object.fromEntries(Object.entries(providerRefreshStates).map(([p, s]) => [p, { ...s }])),
      },
    };
  }

  return {
    render,
    getSnapshot,
    sessionBurnRate,
    pctClass,
    recordSessionContextSample,
    recordStatusUsage,
    recordAgentUsage,
    applyUsageCache,
    refreshUsageNow,
  };
}

module.exports = { createAccountUsageController, pickTightestWindow };
