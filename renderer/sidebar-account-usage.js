'use strict';

const NAMES = { claude: 'Claude', codex: 'Codex', deepseek: 'DeepSeek', tokenPlan: 'Token Plan' };
function remainingPercent(window) {
  const used = window?.pct;
  return typeof used === 'number' && Number.isFinite(used) && used >= 0
    ? Math.max(0, 100 - Math.min(100, used)) : null;
}

function formatResetCountdown(resetsAt, now = Date.now()) {
  const reset = resetsAt ? new Date(resetsAt).getTime() : NaN;
  if (!Number.isFinite(reset)) return '—';
  if (reset <= now) return '0m';
  const minutes = Math.ceil((reset - now) / 60000);
  if (minutes < 60) return minutes + 'm';
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return hours + 'h' + (minutes % 60 ? minutes % 60 + 'm' : '');
  return Math.floor(hours / 24) + 'd' + (hours % 24 ? hours % 24 + 'h' : '');
}

// Each provider is one stable keyboard-accessible refresh target.
function createSidebarAccountUsage({ document, root, refresh, formatAge, formatBalance, freshness, nowFn = Date.now }) {
  const el = (tag, cls, parent, text) => {
    const node = document.createElement(tag); node.className = cls;
    if (text !== undefined) node.textContent = text;
    parent.appendChild(node); return node;
  };
  const quota = el('div', 'sidebar-quota', root);
  const claudeRow = el('div', 'sidebar-quota-claude', quota);
  const pair = el('div', 'sidebar-quota-pair', quota);
  const entries = {};
  for (const provider of Object.keys(NAMES)) {
    const row = el('button', 'sidebar-quota-provider', provider === 'claude' ? claudeRow : provider === 'tokenPlan' ? quota : pair);
    row.type = 'button';
    row.dataset.provider = provider;
    const icon = el('span', 'sidebar-quota-icon ' + (provider === 'tokenPlan' ? 'token-plan-icon' : 'ai-logo logo-' + provider), row,
      provider === 'tokenPlan' ? 'T' : '');
    icon.setAttribute('aria-hidden', 'true');
    el('span', 'sidebar-quota-name', row, NAMES[provider]);
    const metrics = el('span', 'sidebar-quota-metrics', row);
    const windows = provider === 'claude' ? ['5h', '7d'] : ['codex', 'tokenPlan'].includes(provider) ? ['7d'] : ['balance'];
    const cells = {};
    for (const window of windows) {
      const cell = el('span', 'sidebar-quota-metric', metrics); cell.dataset.window = window;
      const line = el('span', 'sidebar-quota-reading', cell);
      const value = el('b', 'sidebar-quota-value', line, '—');
      const period = el('span', 'sidebar-quota-period', line, window === 'balance' ? '' : '刷新未知');
      const track = window !== 'balance' ? el('span', 'sidebar-quota-track', cell) : null;
      const fill = track ? el('i', '', track) : null;
      if (track) track.setAttribute('aria-hidden', 'true');
      cells[window] = { cell, value, fill, period };
    }
    const button = row;
    button.setAttribute('aria-label', '刷新 ' + NAMES[provider]);
    button.addEventListener('click', () => {
      // Controller retains and renders errors for every programmatic/UI caller.
      refresh(provider).catch(error => { row.title = NAMES[provider] + ' 刷新失败：' + error.message; });
    });
    entries[provider] = { row, button, cells };
  }
  return {
    detailsHost: claudeRow,
    render(snapshot, states) {
      const now = nowFn();
      for (const provider of Object.keys(entries)) {
        const { row, cells, button } = entries[provider];
        const data = snapshot[provider] || {};
        const state = states[provider] || {};
        row.dataset.freshness = provider === 'tokenPlan' && data.lastSeen
          ? (now - data.lastSeen > 600000 || state.error ? 'stale' : 'fresh') : freshness(data.lastSeen);
        const age = formatAge(data.lastSeen);
        const tokenReset = provider === 'tokenPlan' && (data.usage7d || data.usage30d)?.resetsAt;
        const resetTip = tokenReset && Number.isFinite(new Date(tokenReset).getTime())
          ? '重置：' + new Date(tokenReset).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) + ' 北京时间' : '';
        const status = state.inFlight ? '刷新中…' : state.error ? '刷新失败：' + state.error
          : state.result ? state.result.fresh ? '已取得新数据' : '未取得新数据，保留旧值' : '';
        row.title = [NAMES[provider], data.profileLabel, age, status, resetTip].filter(Boolean).join(' · ');
        row.title = '点击刷新 · ' + row.title;
        button.setAttribute('aria-label', '刷新 ' + NAMES[provider] + (status ? ' · ' + status : ''));
        button.setAttribute('aria-disabled', String(!!state.inFlight));
        button.setAttribute('aria-busy', String(!!state.inFlight));
        button.dataset.state = state.inFlight ? 'loading' : state.error ? 'error' : 'idle';
        for (const [window, cell] of Object.entries(cells)) {
          if (window === 'balance') {
            cell.value.textContent = formatBalance(data);
            const raw = (data.balance || data).totalBalance;
            row.dataset.level = cell.value.textContent !== '—' && Number(raw) < 20 ? 'warn' : 'normal';
            cell.cell.title = '余额 · ' + age + ((data.balance || data).available === false ? ' · 当前不可用' : '')
              + ' · 点击刷新 ' + NAMES[provider] + (status ? ' · ' + status : '');
          } else {
            // Token Plan 单格自适应：服务端给周窗口就用周，改给月窗口就跟随月。
            const observation = provider === 'tokenPlan'
              ? (data.usage7d || data.usage30d || null) : data['usage' + window];
            const windowLabel = provider === 'tokenPlan'
              ? (data.usage7d ? '7d' : data.usage30d ? '30d' : window) : window;
            cell.cell.dataset.period = windowLabel;
            const pct = remainingPercent(observation);
            cell.value.textContent = pct === null ? (provider === 'tokenPlan' && data.needsLogin ? '需登录' : '—')
              : (provider === 'tokenPlan' ? pct.toFixed(2) : Math.round(pct)) + '%';
            cell.fill.style.width = (pct ?? 0) + '%';
            cell.cell.dataset.level = pct !== null && pct < 15 ? 'danger' : pct !== null && pct <= 40 ? 'warn' : 'normal';
            const countdown = formatResetCountdown(observation?.resetsAt, now);
            const reset = observation?.resetsAt ? new Date(observation.resetsAt).getTime() : NaN;
            const knownReset = Number.isFinite(reset);
            const expired = knownReset && reset <= now;
            cell.period.textContent = !knownReset ? '刷新未知' : expired ? '待刷新'
              : '↻' + countdown.replace('d', '天').replace('h', '时').replace('m', '分');
            cell.cell.dataset.resetState = !knownReset ? 'unknown' : expired ? 'due' : 'countdown';
            cell.cell.title = windowLabel + ' 剩余额度 · ' + formatAge(observation?.observedAt || data.lastSeen)
              + (expired ? ' · 上次记录，等待刷新' : knownReset ? ' · 距离额度重置 ' + countdown : ' · 重置时间未知')
              + (knownReset ? ' · 重置：' + new Date(reset).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) + ' 北京时间' : '')
              + ' · 点击刷新 ' + NAMES[provider] + (status ? ' · ' + status : '');
          }
        }
        button.setAttribute('aria-label', NAMES[provider] + ' · ' + Object.entries(cells).map(([window, cell]) =>
          (window === 'balance' ? '余额 ' : cell.cell.dataset.period + ' 剩余 ') + cell.value.textContent + ' ' + cell.period.textContent
        ).join(' · ') + ' · 点击刷新' + (status ? ' · ' + status : ''));
      }
    },
  };
}
module.exports = { createSidebarAccountUsage, remainingPercent, formatResetCountdown };
