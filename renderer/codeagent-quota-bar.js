'use strict';
// CodeAgent 额度条（2026-10-16 用户：额度条可以补）。数据来自每轮回答结束时读到的 CodeAgent 屏幕 Stats 面板
// 「Credit 剩余 (百分比)」（core/codeagent-screen-stats.js parseCodeAgentCredit）——CodeAgent 没有查额度的命令。
// 每个账号（个人账号、号池里的号）各一行，显示最近一次读数和它是哪一档（今日忙时 / 月度）；读数过旧时标出来。
// 样式沿用左下角「用量与系统状态」里各家额度的行（renderer/styles/sidebar-v2.css）。
const STORE_KEY = 'hub.codeagentQuota.v1';
const STALE_MS = 3 * 3600 * 1000;
const MAX_ROWS = 4;

const levelFor = pct => pct < 10 ? 'danger' : pct < 20 ? 'warn' : '';
function ago(ms) {
  const m = Math.round(ms / 60000);
  return m < 1 ? '刚刚' : m < 60 ? `${m} 分钟前` : `${Math.round(m / 60)} 小时前`;
}
function fmt(n) { return Number(n).toLocaleString('en-US', { maximumFractionDigits: 1 }); }

function createCodeAgentQuotaBar({ document, storage = null, now = () => Date.now(), escapeHtml = s => String(s) } = {}) {
  let readings = {};
  try { readings = JSON.parse(storage?.getItem(STORE_KEY) || '{}') || {}; } catch { readings = {}; }
  const el = () => document.getElementById('rail-codeagent-quota');
  function save() { try { storage?.setItem(STORE_KEY, JSON.stringify(readings)); } catch { /* 存不了只影响重启后的显示 */ } }
  function render() {
    const host = el();
    if (!host) return;
    const rows = Object.values(readings).sort((a, b) => b.at - a.at).slice(0, MAX_ROWS);
    host.hidden = rows.length === 0;
    // 结构与「余量」各家的行一致（底栏的紧凑/摘要排版、「⋯」全部状态弹窗都按这套类名读）：
    // 读数格只放百分比，底栏摘要按它挑「最紧张」的一家；剩余点数和总额放在悬停说明里。
    host.innerHTML = rows.length ? `<div class="sidebar-quota">${rows.map(r => {
      const stale = now() - r.at > STALE_MS;
      const name = rows.length > 1 ? `CA ${r.account}` : 'CodeAgent';
      const label = `CodeAgent ${r.account} ${r.bucket}剩余 ${r.pct}%（${fmt(r.remaining)}${r.total ? ' / ' + fmt(r.total) : ''}）`;
      const title = `${label}\n读自 CodeAgent 界面右侧 Stats 面板 · ${ago(now() - r.at)}`;
      return `<div class="sidebar-quota-provider" data-provider="codeagent" data-freshness="${stale ? 'stale' : 'fresh'}" aria-label="${escapeHtml(label)}" title="${escapeHtml(title)}">`
        + '<span class="sidebar-quota-icon ai-logo logo-codeagent" aria-hidden="true"></span>'
        + `<span class="sidebar-quota-name">${escapeHtml(name)}</span>`
        + `<span class="sidebar-quota-metrics"><span class="sidebar-quota-metric" data-level="${levelFor(r.pct)}">`
        + `<span class="sidebar-quota-reading"><b class="sidebar-quota-value">${r.pct}%</b>`
        + `<span class="sidebar-quota-period">${escapeHtml(r.bucket)}${stale ? ' · ' + ago(now() - r.at) : ''}</span></span>`
        + `<span class="sidebar-quota-track" aria-hidden="true"><i style="width:${Math.max(0, Math.min(100, r.pct))}%"></i></span></span></span></div>`;
    }).join('')}</div>` : '';
  }
  // reading：parseCodeAgentCredit 的结果 + { account }（个人账号 / 号池账号的脱敏名）。
  function update(reading, { account = '个人账号' } = {}) {
    if (!reading || !Number.isFinite(reading.remaining) || !Number.isFinite(reading.pct)) return;
    readings[account] = { ...reading, account, at: now() };
    save(); render();
    try { document.dispatchEvent?.(new (document.defaultView?.CustomEvent || CustomEvent)('codeagent-quota', { detail: readings[account] })); } catch { /* 桌宠等订阅方可选 */ }
  }
  return { update, render, readings: () => ({ ...readings }) };
}

module.exports = { createCodeAgentQuotaBar };
