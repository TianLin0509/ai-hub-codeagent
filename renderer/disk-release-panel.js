'use strict';

function formatBytes(bytes) {
  const value = Math.max(0, Number(bytes) || 0);
  if (value >= 1024 ** 3) return `${(value / 1024 ** 3).toFixed(value >= 10 * 1024 ** 3 ? 1 : 2)} GB`;
  if (value >= 1024 ** 2) return `${(value / 1024 ** 2).toFixed(1)} MB`;
  return `${Math.round(value / 1024)} KB`;
}

function attachDiskReleasePanel({ document: doc, request, execute, analyzeUsage, getStatus, cancelScan, subscribeProgress, escapeHtml, onOpen, onComplete }) {
  const strip = doc.getElementById('sidebar-strip');
  if (!strip) return null;
  const esc = escapeHtml;
  const panel = doc.createElement('div');
  panel.id = 'disk-release-panel'; panel.className = 'disk-release-panel'; panel.hidden = true;
  panel.setAttribute('role', 'dialog'); panel.setAttribute('aria-label', '硬盘管理');
  doc.body.appendChild(panel);
  let plan = null; let result = null; let view = 'list'; let busy = false; let busyKind = null;
  let anchor = null; let epoch = 0; let poll = null; let selected = new Set(); let message = '';
  let statusPending = false;
  let usage = null;

  const chosen = () => (plan?.items || []).filter(item => selected.has(item.key) && item.tier !== 'info');
  const chosenBytes = () => chosen().reduce((sum, item) => sum + item.bytes, 0);
  function position() {
    if (panel.hidden) return;
    const rect = (strip.querySelector('.strip-disk') || strip).getBoundingClientRect();
    panel.style.left = `${Math.max(8, Math.min(rect.left, doc.documentElement.clientWidth - panel.offsetWidth - 8))}px`;
    panel.style.bottom = `${Math.max(8, doc.documentElement.clientHeight - rect.top + 8)}px`;
  }
  function head() {
    return '<div class="dr-head"><strong>硬盘管理</strong><span>'
      + `<button type="button" class="dr-link" data-dr-rescan${busy ? ' disabled' : ''}>${view === 'usage' ? '重新分析' : '重新扫描'}</button>`
      + '<button type="button" class="dr-close" data-dr-close aria-label="关闭">×</button></span></div>'
      + `<div class="dr-tabs" role="group" aria-label="硬盘管理功能"><button type="button" data-dr-tab="cleanup" aria-pressed="${view !== 'usage'}"${busy ? ' disabled' : ''}>清理数据</button>`
      + `<button type="button" data-dr-tab="usage" aria-pressed="${view === 'usage'}"${busy ? ' disabled' : ''}>查看大目录占用</button></div>`;
  }
  function diskHtml(disk) {
    const pct = disk?.usedPct;
    return `<div class="dr-disk"><div><span>${esc(disk?.root || '系统盘')} 已用 <b>${pct == null ? '—' : pct + '%'}</b></span>`
      + `<span>可用 ${formatBytes(disk?.freeBytes)} / ${formatBytes(disk?.totalBytes)}</span></div>`
      + `<div class="dr-meter"><i style="width:${Math.max(0, Math.min(100, pct || 0))}%"></i></div></div>`;
  }
  function itemHtml(item) {
    const selectable = item.tier !== 'info';
    const date = item.updatedAt ? new Date(item.updatedAt).toLocaleDateString('zh-CN') : '';
    return `<div class="dr-item dr-tier-${item.tier}"><label class="dr-row">`
      + (selectable ? `<input type="checkbox" data-dr-key="${esc(item.key)}" aria-label="${esc(item.title)}"${selected.has(item.key) ? ' checked' : ''}>` : '<span class="dr-spacer"></span>')
      + `<span class="dr-main"><strong>${esc(item.title)}</strong><small>${esc(item.reason || item.note || '')}</small>`
      + `<small class="dr-folder">${esc(item.path.split(/[\\/]/).pop())}</small>`
      + `${date ? `<small>最后更新 ${esc(date)} · ${item.fileCount} 个文件</small>` : ''}</span>`
      + `<b>${selectable ? formatBytes(item.bytes) : '保留'}</b></label>`
      + `<details class="dr-location"><summary>查看位置</summary><code>${esc(item.path)}</code></details></div>`;
  }
  function section(tier, title, hint) {
    const items = (plan.items || []).filter(item => item.tier === tier);
    if (!items.length && tier !== 'safe') return '';
    return `<section class="dr-section"><h4>${title}<span>${items.length} 项</span></h4><p>${hint}</p>`
      + (items.length ? items.map(itemHtml).join('') : '<div class="dr-empty">没有发现可以清理的旧缓存或测试数据</div>') + '</section>';
  }
  function renderList() {
    panel.innerHTML = `${head()}<div class="dr-scroll">${diskHtml(plan.disk)}`
      + section('safe', '可重建的缓存和测试数据', '默认勾选；删除后可重新生成，下载缓存以后需要重新下载。')
      + section('manual', 'Android 测试设备 · 自行选择', '设备与登录状态会一并删除，确认以后不再需要才勾选。')
      + `<details class="dr-protected"><summary>已保留 ${plan.totals?.protectedItems || 0} 项正在使用或无法确认的数据</summary>`
      + (plan.items || []).filter(item => item.tier === 'info').map(itemHtml).join('') + '</details>'
      + '<p class="dr-note">范围：npm、pip、uv、Yarn、Gradle、Chrome / Edge / AppData 浏览器缓存，以及临时 Hub 测试和 Android 测试设备。浏览器登录、正式聊天记录、源码和系统文件保留。共享文件与正在使用的缓存保留。</p></div>'
      + `<div class="dr-footer"><span data-dr-count>已勾选 ${chosen().length} 项</span><button type="button" class="dr-primary" data-dr-review${chosen().length ? '' : ' disabled'}>预计释放 ${formatBytes(chosenBytes())}</button></div>`;
  }
  function renderConfirm() {
    panel.innerHTML = `${head()}<div class="dr-scroll"><p class="dr-lead">确认后会永久删除下面的数据。执行前会重新检查；文件有变化、仍在使用或含目录链接的项目会跳过。</p>`
      + chosen().map(item => `<div class="dr-confirm-item"><strong>${esc(item.title)}<b>${formatBytes(item.bytes)}</b></strong><p>${esc(item.note)}</p><code>${esc(item.path)}</code></div>`).join('')
      + '</div><div class="dr-footer"><button type="button" class="dr-secondary" data-dr-back>返回</button>'
      + `<button type="button" class="dr-primary" data-dr-confirm>确认清理 ${chosen().length} 项</button></div>`;
  }
  function renderResult() {
    const rows = result.results || [];
    const successes = rows.filter(row => row.ok).length;
    const change = Number(result.netFreeChangeBytes) || 0;
    const receipt = result.receiptError ? `<p class="dr-note">${esc(result.receiptError)}</p>` : '';
    panel.innerHTML = `${head()}<div class="dr-scroll"><div class="dr-result" role="status"><strong>${change >= 0 ? '可用空间增加' : '可用空间减少'} ${formatBytes(Math.abs(change))}</strong>`
      + `<span>已处理 ${successes}/${rows.length} 项 · 盘占用 ${result.diskBefore?.usedPct ?? '—'}% → ${result.diskAfter?.usedPct ?? '—'}%</span></div>`
      + diskHtml(result.diskAfter)
      + rows.map(row => `<div class="dr-result-row ${row.ok ? 'ok' : 'skipped'}"><strong>${row.ok ? '✓' : '保留'} ${esc(row.title || '清理项')}</strong><p>${esc(row.message || '')}</p></div>`).join('')
      + '<p class="dr-note">空间变化按执行前后的磁盘可用空间计算，期间其他程序的写入也会影响这个数字。</p>' + receipt + '</div>'
      + '<div class="dr-footer"><span>清理结果已核对</span><button type="button" class="dr-primary" data-dr-rescan>重新扫描</button></div>';
  }
  function renderUsage() {
    const items = usage?.items || [];
    panel.innerHTML = `${head()}<div class="dr-scroll"><p class="dr-lead">查看微信、桌面、聊天历史、模型、环境和项目占用；这里仅分析，不提供删除操作。</p>`
      + (usage ? `<p class="dr-note">核对时间 ${esc(new Date(usage.scannedAt).toLocaleString('zh-CN'))}。按已核对大小排序；≥ 表示部分结果，实际可能更大。目录之间可能有共享文件，不相加为磁盘总占用。</p>` : '')
      + (items.length ? items.map(item => `<section class="dr-usage-item"><div class="dr-usage-title"><strong>${esc(item.title)}</strong><b>${item.partial ? '≥ ' : ''}${formatBytes(item.bytes)}</b></div>`
        + `<p>${esc(item.note || '')}</p>${item.partial ? `<p class="dr-usage-partial">${esc(item.reason || '部分文件未能核对')}</p>` : ''}`
        + `<details class="dr-location"><summary>位置与子目录占用</summary><code>${esc(item.path)}</code>`
        + (item.children || []).map(child => `<div class="dr-usage-child"><span>${esc(child.title)}</span><b>${formatBytes(child.bytes)}</b></div>`).join('') + '</details></section>').join('')
        : `<div class="dr-empty">${esc(message || '没有发现可读取的目录')}</div>`)
      + '</div><div class="dr-footer"><span>占用大小不等于可释放空间</span><button type="button" class="dr-primary" data-dr-rescan>重新分析</button></div>';
  }
  function showBusy(text) {
    panel.innerHTML = `${head()}<div class="dr-busy" role="status"><span class="dr-spinner"></span><span data-dr-progress>${esc(text)}</span></div>`
      + `<p class="dr-note dr-busy-note">${busyKind === 'execute' ? '关闭面板后仍会继续；再次点击硬盘可查看进度和结果。' : '正在后台检查，文件较多时需要一点时间。'}</p>`;
    position();
  }
  function render() {
    if (panel.hidden) return;
    if (busy) showBusy(message);
    else if (view === 'usage') renderUsage();
    else if (view === 'result' && result) renderResult();
    else if (view === 'confirm') renderConfirm();
    else if (plan) renderList();
    else panel.innerHTML = `${head()}<div class="dr-empty dr-error">${esc(message || '暂时无法读取，请重新扫描')}</div>`;
    position();
  }
  async function scan() {
    if (busy) return;
    const token = ++epoch;
    busy = true; busyKind = 'scan'; plan = null; result = null; selected.clear(); view = 'list';
    message = '正在检查可清理的数据…'; render();
    let next;
    try { next = await request(); } catch (error) { next = { error: error.message }; }
    if (token !== epoch) return;
    busy = false; busyKind = null;
    if (next?.ok) { plan = next; selected = new Set(next.items.filter(item => item.selected).map(item => item.key)); }
    else message = next?.error || '扫描失败，请重试';
    render();
  }
  async function run() {
    if (busy || view !== 'confirm' || !chosen().length) return;
    busy = true; busyKind = 'execute'; message = '正在重新核对并清理已确认的数据…'; render();
    try { result = await execute({ scanId: plan.scanId, keys: chosen().map(item => item.key), confirmed: true }); }
    catch (error) { result = { ok: false, error: error.message }; }
    busy = false; busyKind = null;
    if (result?.ok) { view = 'result'; onComplete?.(result); }
    else { view = 'list'; plan = null; message = result?.error || '清理失败，请重新扫描'; }
    render();
  }
  async function inspectUsage() {
    if (busy || !analyzeUsage) return;
    const token = ++epoch;
    view = 'usage'; busy = true; busyKind = 'usage'; message = '正在后台分析常用大目录的占用…'; render();
    let next;
    try { next = await analyzeUsage(); } catch (error) { next = { error: error.message }; }
    if (token !== epoch) return;
    busy = false; busyKind = null;
    if (next?.ok) { usage = next; message = ''; }
    else { usage = null; message = next?.error || '占用分析失败，请重试'; }
    render();
  }
  async function refreshStatus() {
    if (statusPending || panel.hidden || !busy || !getStatus) return;
    statusPending = true;
    try {
      const status = await getStatus();
      if (status.busy) {
        message = status.message || message;
        const target = panel.querySelector('[data-dr-progress]');
        if (target) target.textContent = message;
      } else if (busyKind === 'external') {
        busy = false; busyKind = null;
        if (status.phase === 'error') message = status.message || '检查失败，请重试';
        else if (status.completedKind === 'usage' && status.lastUsage) { usage = status.lastUsage; view = 'usage'; }
        else if (status.completedKind === 'execute' && status.lastResult) { result = status.lastResult; view = 'result'; }
        else message = '检查已结束，点「重新扫描」查看清单';
        render();
      }
    } catch {} finally { statusPending = false; }
  }
  async function open(target) {
    anchor = target || strip.querySelector('.strip-disk');
    onOpen?.(); panel.hidden = false; doc.body.classList.add('disk-release-open');
    anchor?.setAttribute('aria-expanded', 'true');
    if (busy || view === 'result' || (view === 'usage' && usage)) render();
    else {
      const status = getStatus ? await getStatus().catch(() => null) : null;
      if (panel.hidden) return;
      if (status?.busy) { busy = true; busyKind = 'external'; message = status.message || '正在后台处理…'; render(); }
      else if (view === 'usage') render();
      else void scan();
    }
    clearInterval(poll); poll = setInterval(refreshStatus, 1000);
  }
  function close() {
    panel.hidden = true; doc.body.classList.remove('disk-release-open');
    anchor?.setAttribute('aria-expanded', 'false'); clearInterval(poll);
    if (['scan', 'usage'].includes(busyKind)) {
      ++epoch; busy = false; busyKind = null; message = '扫描已取消';
      void cancelScan?.();
    }
  }
  subscribeProgress?.(progress => {
    if (!busy || panel.hidden) return;
    message = progress.message;
    const target = panel.querySelector('[data-dr-progress]');
    if (target) target.textContent = message;
  });
  strip.addEventListener('click', event => {
    const target = event.target.closest?.('.strip-disk');
    if (!target) return;
    event.preventDefault(); if (panel.hidden) void open(target); else close();
  });
  strip.addEventListener('keydown', event => {
    const target = event.target.closest?.('.strip-disk');
    if (target && ['Enter', ' '].includes(event.key)) { event.preventDefault(); if (panel.hidden) void open(target); else close(); }
  });
  panel.addEventListener('change', event => {
    const box = event.target.closest?.('[data-dr-key]'); if (!box) return;
    if (box.checked) selected.add(box.dataset.drKey); else selected.delete(box.dataset.drKey);
    const button = panel.querySelector('[data-dr-review]');
    if (button) { button.disabled = !chosen().length; button.textContent = `预计释放 ${formatBytes(chosenBytes())}`; }
    const count = panel.querySelector('[data-dr-count]'); if (count) count.textContent = `已勾选 ${chosen().length} 项`;
  });
  panel.addEventListener('click', event => {
    if (event.target.closest('[data-dr-close]')) { close(); return; }
    if (event.target.closest('[data-dr-rescan]')) { if (view === 'usage') void inspectUsage(); else void scan(); return; }
    if (busy) return;
    const tab = event.target.closest('[data-dr-tab]');
    if (tab) {
      if (tab.dataset.drTab === 'usage') { if (usage) { view = 'usage'; render(); } else void inspectUsage(); }
      else if (result) { view = 'result'; render(); }
      else if (plan) { view = 'list'; render(); }
      else void scan();
      return;
    }
    if (event.target.closest('[data-dr-review]') && chosen().length) { view = 'confirm'; render(); }
    else if (event.target.closest('[data-dr-back]')) { view = 'list'; render(); }
    else if (event.target.closest('[data-dr-confirm]')) void run();
  });
  doc.addEventListener('pointerdown', event => {
    if (!panel.hidden && !panel.contains(event.target) && !event.target.closest?.('.strip-disk')) close();
  }, true);
  doc.addEventListener('keydown', event => { if (event.key === 'Escape' && !panel.hidden) { close(); anchor?.focus(); } });
  doc.defaultView.addEventListener('resize', position);
  return { open, close };
}
module.exports = { attachDiskReleasePanel, formatBytes };
