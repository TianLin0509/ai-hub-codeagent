'use strict';

// 底部状态条「VPN」入口的流量详情弹层。数据来自 main 的 VPN 流量账本
// （core/vpn-traffic-recorder.js），这里只负责展示；节点变化告警的「确认」也挪到弹层里。

const RANGES = [
  { key: 'today', label: '今天' },
  { key: '7d', label: '近 7 天' },
  { key: 'month', label: '本月' },
  { key: '30d', label: '近 30 天' },
];

const APP_LABELS = {
  'claude.exe': 'Claude Code',
  'codex.exe': 'Codex',
  'gemini.exe': 'Gemini CLI',
  'kimi.exe': 'Kimi CLI',
  'chrome.exe': 'Chrome',
  'msedge.exe': 'Edge',
  'firefox.exe': 'Firefox',
  'aigroupchathub.exe': 'AI Hub',
  'electron.exe': 'Electron 程序',
  'node.exe': 'Node 脚本',
  'python.exe': 'Python 脚本',
  'pythonw.exe': 'Python 脚本',
  'git-remote-https.exe': 'Git',
  'curl.exe': 'curl',
  'code.exe': 'VS Code',
  '(未识别)': '未识别程序',
};

function formatBytes(value) {
  const n = Number(value) || 0;
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(n >= 10 * 1024 ** 3 ? 1 : 2)} GB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(n >= 100 * 1024 ** 2 ? 0 : 1)} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} KB`;
  return `${Math.round(n)} B`;
}

function formatRate(bps) {
  return `${formatBytes(bps)}/s`;
}

function formatDuration(ms) {
  const minutes = Math.round((Number(ms) || 0) / 60_000);
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = minutes / 60;
  return hours < 48 ? `${hours.toFixed(1)} 小时` : `${(hours / 24).toFixed(1)} 天`;
}

function appLabel(key) {
  return APP_LABELS[String(key || '').toLowerCase()] || key;
}

function renderPanelBody(report, { escapeHtml, range, alert }) {
  const esc = escapeHtml;
  const total = (report.proxied?.up || 0) + (report.proxied?.down || 0);
  const status = report.status || {};
  const tabs = RANGES.map(r => `<button type="button" class="vpn-traffic-tab${r.key === range ? ' active' : ''}" data-vpn-range="${r.key}" aria-pressed="${r.key === range}">${r.label}</button>`).join('');
  const live = status.liveRate ? `<span class="vpn-traffic-live" title="最近一次采样（约 2 秒）的 VPN 速率">实时 ↑ ${formatRate(status.liveRate.upBps)} · ↓ ${formatRate(status.liveRate.downBps)}</span>` : '';
  const alertBlock = alert ? `<div class="vpn-traffic-alert"><span>${esc(alert.title || '节点异常')}${alert.message ? `：${esc(alert.message)}` : ''}</span>${alert.acknowledgeable ? '<button type="button" class="vpn-traffic-ack" data-vpn-ack="true">确认当前节点</button>' : ''}</div>` : '';

  const maxApp = Math.max(1, ...(report.apps || []).map(a => a.total));
  const apps = (report.apps || []).filter(a => a.total > 0).slice(0, 10).map((a, i) => {
    const hosts = (a.hosts || []).slice(0, 3).map(h => `${esc(h.key)} ${formatBytes(h.total)}`).join(' · ');
    const share = total > 0 ? Math.round(a.total / total * 100) : 0;
    return `<div class="vpn-traffic-row" title="${esc(`${a.key}\n上传 ${formatBytes(a.up)} · 下载 ${formatBytes(a.down)}`)}">` +
      `<span class="vpn-traffic-rank">${i + 1}</span>` +
      `<div class="vpn-traffic-main"><div class="vpn-traffic-name"><strong>${esc(appLabel(a.key))}</strong>${appLabel(a.key) !== a.key ? `<small>${esc(a.key)}</small>` : ''}</div>` +
      `<div class="vpn-traffic-bar"><i style="width:${Math.max(2, a.total / maxApp * 100).toFixed(1)}%"></i></div>` +
      `<small class="vpn-traffic-sub">↑ ${formatBytes(a.up)} · ↓ ${formatBytes(a.down)}${hosts ? ` ｜ ${hosts}` : ''}</small></div>` +
      `<b>${formatBytes(a.total)}<small>${share}%</small></b></div>`;
  }).join('');

  const maxHost = Math.max(1, ...(report.hosts || []).map(h => h.total));
  const hosts = (report.hosts || []).filter(h => h.total > 0).slice(0, 8).map(h =>
    `<div class="vpn-traffic-host" title="${esc(`上传 ${formatBytes(h.up)} · 下载 ${formatBytes(h.down)}`)}"><span>${esc(h.key)}</span>` +
    `<div class="vpn-traffic-bar"><i style="width:${Math.max(2, h.total / maxHost * 100).toFixed(1)}%"></i></div><b>${formatBytes(h.total)}</b></div>`).join('');

  let daily = '';
  if (range !== 'today' && (report.daily || []).length) {
    const days = report.dates.map(date => report.daily.find(d => d.date === date) || { date, up: 0, down: 0, recordedMs: 0 });
    const maxDay = Math.max(1, ...days.map(d => d.up + d.down));
    daily = `<section class="vpn-traffic-section"><h4>每天</h4><div class="vpn-traffic-days">${days.map(d => {
      const value = d.up + d.down;
      const tip = `${d.date}：${formatBytes(value)}（↑ ${formatBytes(d.up)} · ↓ ${formatBytes(d.down)}）${d.recordedMs ? `，记录 ${formatDuration(d.recordedMs)}` : '，无记录'}`;
      return `<span class="vpn-traffic-day${d.recordedMs ? '' : ' empty'}" title="${esc(tip)}" aria-label="${esc(tip)}"><i style="height:${value > 0 ? Math.max(3, value / maxDay * 100).toFixed(1) : 0}%"></i></span>`;
    }).join('')}</div><div class="vpn-traffic-days-axis"><span>${esc(days[0].date.slice(5))}</span><span>${esc(days[days.length - 1].date.slice(5))}</span></div></section>`;
  }

  const notes = [];
  if (!status.recording) notes.push(status.error === 'recorder-disabled' ? '流量记录未启用' : '当前没有 Hub 在记录流量');
  else if (status.error) notes.push(`暂时读不到 Clash：${esc(status.error)}`);
  notes.push(`Clash 自己不保存历史，只有 Hub 开着时才记录${status.earliestDate ? `；最早记录 ${esc(status.earliestDate)}` : ''}；本期记录时长 ${formatDuration(report.recordedMs)}`);
  const estimated = (report.estimated?.up || 0) + (report.estimated?.down || 0);
  const unattributed = (report.unattributed?.up || 0) + (report.unattributed?.down || 0);
  if (estimated > 0) notes.push(`其中 ${formatBytes(estimated)} 是连接结束前最后一段，按该连接的速率估算归属`);
  if (unattributed > 0) notes.push(`另有 ${formatBytes(unattributed)} 来自极短连接，无法判断程序和线路，未计入上面的合计`);
  if (status.holder === 'other' && status.holderPid) notes.push(`由另一个 Hub 窗口（PID ${status.holderPid}）负责记录`);

  return `<div class="vpn-traffic-head"><strong>VPN 流量</strong><button type="button" class="vpn-traffic-close" data-vpn-close="true" aria-label="关闭">×</button></div>` +
    `<div class="vpn-traffic-tabs" role="group" aria-label="时间范围">${tabs}</div>` +
    alertBlock +
    `<div class="vpn-traffic-hero"><span class="vpn-traffic-total">${formatBytes(total)}</span><span class="vpn-traffic-split">↑ 上传 ${formatBytes(report.proxied?.up)} · ↓ 下载 ${formatBytes(report.proxied?.down)}</span>${live}</div>` +
    `<section class="vpn-traffic-section"><h4>按程序</h4>${apps || '<div class="vpn-traffic-empty">这段时间还没有经过 VPN 的流量记录</div>'}</section>` +
    (hosts ? `<section class="vpn-traffic-section"><h4>按网站</h4>${hosts}</section>` : '') +
    daily +
    `<div class="vpn-traffic-notes">${notes.map(n => `<p>${n}</p>`).join('')}</div>`;
}

function attachVpnTrafficPanel({ document: doc, request, escapeHtml, acknowledge, getAlert }) {
  const strip = doc.getElementById('sidebar-strip');
  if (!strip) return null;
  const panel = doc.createElement('div');
  panel.id = 'vpn-traffic-panel';
  panel.className = 'vpn-traffic-panel';
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', 'VPN 流量详情');
  panel.hidden = true;
  doc.body.appendChild(panel);
  let anchor = null; let range = 'today'; let timer = null; let epoch = 0;

  const position = () => {
    if (!anchor || panel.hidden) return;
    if (!anchor.isConnected) anchor = strip.querySelector('.strip-route-foreign') || anchor;
    const rect = anchor.getBoundingClientRect();
    const width = panel.offsetWidth;
    const left = Math.max(8, Math.min(rect.left, doc.documentElement.clientWidth - width - 8));
    panel.style.left = `${left}px`;
    panel.style.bottom = `${Math.max(8, doc.documentElement.clientHeight - rect.top + 8)}px`;
  };

  async function load(token, { quiet = false } = {}) {
    if (panel.hidden || token !== epoch) return;
    if (!quiet) panel.classList.add('loading');
    let report;
    try { report = await request(range); } catch { report = null; }
    if (panel.hidden || token !== epoch) return;
    panel.classList.remove('loading');
    const scroll = panel.querySelector('.vpn-traffic-scroll')?.scrollTop || 0;
    panel.innerHTML = report
      ? `<div class="vpn-traffic-scroll">${renderPanelBody(report, { escapeHtml, range, alert: typeof getAlert === 'function' ? getAlert() : null })}</div>`
      : `<div class="vpn-traffic-head"><strong>VPN 流量</strong><button type="button" class="vpn-traffic-close" data-vpn-close="true" aria-label="关闭">×</button></div><div class="vpn-traffic-empty">暂时读不到流量记录，稍后重试</div>`;
    const scroller = panel.querySelector('.vpn-traffic-scroll');
    if (scroller) scroller.scrollTop = scroll;
    position();
    clearTimeout(timer);
    timer = setTimeout(() => load(token, { quiet: true }), 5_000);
  }

  function open(target) {
    anchor = target;
    epoch += 1;
    panel.hidden = false;
    panel.innerHTML = '<div class="vpn-traffic-empty">正在读取流量记录…</div>';
    target.setAttribute('aria-expanded', 'true');
    position();
    void load(epoch);
  }

  function close() {
    epoch += 1;
    clearTimeout(timer);
    panel.hidden = true;
    anchor?.setAttribute('aria-expanded', 'false');
    anchor = null;
  }

  // 状态条每次心跳会重建 .strip-network 的内容，所以在稳定的 strip 上委托点击。
  strip.addEventListener('click', event => {
    const target = event.target.closest?.('.strip-route-foreign');
    if (!target) return;
    event.preventDefault();
    if (!panel.hidden) close(); else open(target);
  });

  panel.addEventListener('click', async event => {
    const tab = event.target.closest('[data-vpn-range]');
    if (tab) {
      range = tab.dataset.vpnRange;
      epoch += 1;
      void load(epoch);
      return;
    }
    if (event.target.closest('[data-vpn-close]')) { close(); return; }
    const ack = event.target.closest('[data-vpn-ack]');
    if (ack && typeof acknowledge === 'function') {
      ack.disabled = true;
      try { await acknowledge(); } finally { epoch += 1; void load(epoch, { quiet: true }); }
    }
  });

  doc.addEventListener('pointerdown', event => {
    if (panel.hidden) return;
    if (panel.contains(event.target) || event.target.closest?.('.strip-route-foreign')) return;
    close();
  }, true);
  doc.addEventListener('keydown', event => { if (event.key === 'Escape' && !panel.hidden) close(); });
  doc.defaultView.addEventListener('resize', position);

  return { open: () => { const t = strip.querySelector('.strip-route-foreign'); if (t) open(t); }, close };
}

module.exports = { attachVpnTrafficPanel, renderPanelBody, formatBytes, appLabel };
