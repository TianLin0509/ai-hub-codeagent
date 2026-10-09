'use strict';

function attachResourceProcessTooltip({ document: doc, request, escapeHtml }) {
  const strip = doc.getElementById('sidebar-strip');
  if (!strip) return;
  const panel = doc.createElement('div');
  panel.id = 'resource-process-tooltip';
  panel.className = 'resource-process-tooltip';
  panel.setAttribute('role', 'tooltip');
  panel.hidden = true;
  doc.body.appendChild(panel);
  let anchor = null; let timer = null; let refresh = null; let epoch = 0;
  const position = () => {
    if (!anchor) return;
    const rect = anchor.getBoundingClientRect();
    panel.style.left = `${Math.max(8, Math.min(strip.getBoundingClientRect().left + 4, doc.documentElement.clientWidth - panel.offsetWidth - 8))}px`;
    panel.style.top = `${Math.max(8, rect.top - panel.offsetHeight - 10)}px`;
  };
  function hide() {
    epoch++;
    clearTimeout(timer); clearTimeout(refresh);
    anchor?.removeAttribute('aria-describedby');
    anchor = null; panel.hidden = true;
  }
  async function load(token) {
    if (!anchor || token !== epoch || doc.hidden) return hide();
    const kind = anchor.dataset.resourceKind;
    const title = kind === 'cpu' ? 'CPU 占用 Top 3' : '内存占用 Top 3';
    try {
      const result = await request();
      if (!anchor || token !== epoch) return;
      if (result?.status !== 'ok') throw new Error('unavailable');
      const rows = result[kind] || [];
      panel.innerHTML = `<div class="resource-tip-heading"><strong>${title}</strong><span>全机进程</span></div>` +
        (rows.length ? rows.map((row, index) => {
          const value = kind === 'cpu' ? `${row.cpuPct.toFixed(1)}%` : row.memoryBytes >= 1024 ** 3 ? `${(row.memoryBytes / 1024 ** 3).toFixed(2)} GB` : `${Math.round(row.memoryBytes / 1024 ** 2)} MB`;
          return `<div class="resource-tip-row"><span class="resource-tip-rank">${index + 1}</span><div class="resource-tip-process"><strong>${escapeHtml(row.name)}</strong><small>PID ${row.pid}</small></div><b>${value}</b></div>`;
        }).join('') : '<div class="resource-tip-empty">暂无可读取的进程</div>') +
        `<div class="resource-tip-footer">${kind === 'cpu' ? `最近 ${(result.windowMs / 1000).toFixed(1)} 秒均值 · 整机 100%` : '物理内存工作集 · 含共享页'}<br>${new Date(result.sampledAt).toLocaleTimeString()} 采样 · 悬停时每 5 秒刷新${kind === 'cpu' && result.unreadableCpuCount ? `<br>${result.unreadableCpuCount} 个进程未取得 CPU 增量` : ''}</div>`;
    } catch {
      if (!anchor || token !== epoch) return;
      panel.innerHTML = `<div class="resource-tip-heading"><strong>${title}</strong></div><div class="resource-tip-empty">暂时无法读取进程占用，稍后重试</div>`;
    }
    position();
    refresh = setTimeout(() => load(token), 5000);
  }
  function show(target) {
    if (!target || anchor === target) return;
    // 「释放内存」弹层打开时不再叠一层悬停提示。
    if (doc.body.classList.contains('memory-release-open')) return;
    hide(); anchor = target;
    const token = epoch;
    timer = setTimeout(() => {
      panel.hidden = false;
      panel.innerHTML = '<div class="resource-tip-empty">正在采样进程占用…</div>';
      anchor.setAttribute('aria-describedby', panel.id);
      position(); void load(token);
    }, 280);
  }
  strip.addEventListener('pointerover', event => show(event.target.closest('[data-resource-kind]')));
  strip.addEventListener('pointerout', event => {
    if (anchor && !anchor.contains(event.relatedTarget)) hide();
  });
  strip.addEventListener('focusin', event => show(event.target.closest('[data-resource-kind]')));
  strip.addEventListener('focusout', hide);
  doc.addEventListener('keydown', event => { if (event.key === 'Escape') hide(); });
  doc.addEventListener('visibilitychange', () => { if (doc.hidden) hide(); });
  doc.addEventListener('sidebar-insights:visibility', hide);
  doc.defaultView.addEventListener('resize', hide);
}

module.exports = { attachResourceProcessTooltip };
