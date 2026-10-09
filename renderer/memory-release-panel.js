'use strict';

// 底部状态条 CPU / 内存 / 硬盘区点开的「释放内存」弹层。
// 清单与执行都在 main（main/ipc/memory-release-handlers.js），这里负责勾选、确认和结果展示。
// 流程：扫描 → 勾选 → 确认清单 → 执行 → 显示实际腾出多少。

function formatGB(bytes) {
  const n = Number(bytes) || 0;
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(n >= 10 * 1024 ** 3 ? 1 : 2)} GB`;
  return `${Math.max(0, Math.round(n / 1024 ** 2))} MB`;
}

const SECTIONS = [
  { tier: 'safe', title: '可放心结束', hint: '已经没人在用的残留进程，结束后不影响任何会话' },
  { tier: 'suspend', title: '空闲会话 · 休眠后可恢复', hint: '关掉进程、保留聊天记录；之后点这个会话即可接着用' },
  { tier: 'info', title: '正在使用 · 只显示', hint: '正在工作的会话、Hub 窗口本身和其他程序，不提供一键操作' },
];

function attachMemoryReleasePanel({ document: doc, request, execute, escapeHtml, onOpen }) {
  const strip = doc.getElementById('sidebar-strip');
  if (!strip) return null;
  const esc = escapeHtml;
  const panel = doc.createElement('div');
  panel.id = 'memory-release-panel';
  panel.className = 'memory-release-panel';
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', '内存与进程');
  panel.hidden = true;
  doc.body.appendChild(panel);

  let plan = null;
  let selected = new Map();
  let view = 'list';
  let lastResult = null;
  let epoch = 0;

  const head = () => '<div class="mr-head"><strong>内存与进程</strong><span class="mr-head-actions">'
    + '<button type="button" class="mr-link" data-mr-rescan="true">重新扫描</button>'
    + '<button type="button" class="mr-close" data-mr-close="true" aria-label="关闭">×</button></span></div>';

  function position() {
    if (panel.hidden) return;
    const anchor = strip.querySelector('.strip-resources') || strip;
    const rect = anchor.getBoundingClientRect();
    panel.style.left = `${Math.max(8, Math.min(rect.left, doc.documentElement.clientWidth - panel.offsetWidth - 8))}px`;
    panel.style.bottom = `${Math.max(8, doc.documentElement.clientHeight - rect.top + 8)}px`;
  }

  function selectedItems() {
    return (plan?.items || []).filter(item => selected.get(item.key));
  }

  function memoryBar(memory) {
    const pct = memory?.usedPct ?? null;
    const level = pct >= 90 ? ' critical' : pct >= 80 ? ' high' : '';
    return `<div class="mr-memory${level}"><div class="mr-memory-line"><span>内存已用 <b>${pct == null ? '—' : pct + '%'}</b></span>`
      + `<span>${formatGB(memory?.usedBytes)} / ${formatGB(memory?.totalBytes)}</span></div>`
      + `<div class="mr-meter"><i style="width:${Math.max(0, Math.min(100, pct || 0))}%"></i></div></div>`;
  }

  function row(item) {
    const selectable = item.tier === 'safe' || item.tier === 'suspend';
    const checked = selectable && selected.get(item.key);
    const meta = [item.subtitle, item.status].filter(Boolean).map(esc).join(' · ');
    const parts = (item.parts || []).length
      ? `<small class="mr-parts">${item.parts.map(p => `${esc(p.label)} ${formatGB(p.wsBytes)}`).join(' · ')}</small>` : '';
    const note = item.note ? `<small class="mr-note">${esc(item.note)}</small>` : '';
    const control = selectable
      ? `<input type="checkbox" class="mr-check" data-mr-key="${esc(item.key)}"${checked ? ' checked' : ''} aria-label="${esc(item.title)}">`
      : '<span class="mr-check-spacer"></span>';
    return `<label class="mr-row mr-tier-${item.tier}${selectable ? '' : ' mr-readonly'}">${control}`
      + `<div class="mr-main"><strong>${esc(item.title)}${item.pinned ? '<em class="mr-badge">置顶</em>' : ''}</strong>`
      + `${meta ? `<small>${meta}</small>` : ''}${parts}${note}</div><b class="mr-size">${formatGB(item.wsBytes)}</b></label>`;
  }

  function renderList() {
    const items = plan.items || [];
    const chosen = selectedItems();
    const chosenBytes = chosen.reduce((sum, item) => sum + item.wsBytes, 0);
    const sections = SECTIONS.map(section => {
      const rows = items.filter(item => item.tier === section.tier);
      if (!rows.length && section.tier === 'info') return '';
      const body = rows.length ? rows.map(row).join('')
        : `<div class="mr-empty">${section.tier === 'safe' ? '没有发现残留进程' : '没有可休眠的空闲会话'}</div>`;
      return `<section class="mr-section"><h4>${section.title}<span title="${esc(section.hint)}">${esc(section.hint)}</span></h4>${body}</section>`;
    }).join('');
    const warn = plan.totals?.hubWindowsWithoutManifest
      ? `<div class="mr-warn">有 ${plan.totals.hubWindowsWithoutManifest} 个 Hub 窗口还是旧版本，看不到它们的会话状态；重启那些窗口后即可分会话显示。</div>` : '';
    panel.innerHTML = `${head()}<div class="mr-scroll">${memoryBar(plan.memory)}${warn}${sections}</div>`
      + `<div class="mr-footer"><span>已勾选 ${chosen.length} 项</span>`
      + `<button type="button" class="mr-primary" data-mr-review="true"${chosen.length ? '' : ' disabled'}>释放约 ${formatGB(chosenBytes)}</button></div>`;
  }

  function renderConfirm() {
    const chosen = selectedItems();
    const ends = chosen.filter(item => item.tier === 'safe');
    const sleeps = chosen.filter(item => item.tier === 'suspend');
    const list = (title, rows, verb) => rows.length
      ? `<section class="mr-section"><h4>${title}</h4>${rows.map(item => `<div class="mr-confirm-row"><span>${verb} · ${esc(item.title)}</span><b>${formatGB(item.wsBytes)}</b></div>`).join('')}</section>` : '';
    panel.innerHTML = `${head()}<div class="mr-scroll"><p class="mr-lead">确认后会执行下面的操作。执行前会再扫描一次，状态变了的项会自动跳过。</p>`
      + list(`结束 ${ends.length} 个残留`, ends, '结束')
      + list(`休眠 ${sleeps.length} 个会话（聊天记录保留，可随时恢复）`, sleeps, '休眠')
      + '</div><div class="mr-footer"><button type="button" class="mr-secondary" data-mr-back="true">返回</button>'
      + `<button type="button" class="mr-primary" data-mr-confirm="true">确认释放 ${formatGB(chosen.reduce((s, i) => s + i.wsBytes, 0))}</button></div>`;
  }

  function renderResult() {
    const r = lastResult;
    const pct = bytes => (r.totalBytes ? Math.round((1 - bytes / r.totalBytes) * 100) : null);
    const okCount = r.results.filter(x => x.ok).length;
    const rows = r.results.map(x => `<div class="mr-confirm-row ${x.ok ? 'ok' : 'fail'}"><span>${x.ok ? '✓' : '✕'} ${esc(x.title || x.key)}${x.message ? `<small>${esc(x.message)}</small>` : ''}</span><b>${x.ok ? formatGB(x.wsBytes) : '未处理'}</b></div>`).join('');
    panel.innerHTML = `${head()}<div class="mr-scroll"><div class="mr-result"><span class="mr-result-big">腾出 ${formatGB(r.freedBytes)}</span>`
      + `<span>内存 ${pct(r.freeBefore) ?? '—'}% → ${pct(r.freeAfter) ?? '—'}% · 成功 ${okCount}/${r.results.length} 项</span></div>`
      + `<section class="mr-section">${rows}</section><p class="mr-lead">「腾出」按执行前后系统可用内存的差值计算，期间其他程序的变化也会算进去。</p></div>`
      + '<div class="mr-footer"><span></span><button type="button" class="mr-primary" data-mr-rescan="true">重新扫描</button></div>';
  }

  function render() {
    if (view === 'confirm') renderConfirm();
    else if (view === 'result') renderResult();
    else renderList();
    position();
  }

  function showBusy(text) {
    panel.innerHTML = `${head()}<div class="mr-busy"><span class="mr-spinner"></span>${esc(text)}</div>`;
    position();
  }

  async function scan() {
    const token = ++epoch;
    view = 'list';
    showBusy('正在扫描全机进程，并认领到各个会话…（约 2 秒）');
    let next = null;
    try { next = await request(); } catch { next = null; }
    if (token !== epoch || panel.hidden) return;
    if (!next || !next.ok) {
      panel.innerHTML = `${head()}<div class="mr-empty">暂时扫描不到进程信息${next && next.error ? `：${esc(next.error)}` : ''}，稍后点「重新扫描」</div>`;
      position();
      return;
    }
    plan = next;
    selected = new Map(plan.items.filter(item => item.selected).map(item => [item.key, true]));
    render();
  }

  async function runRelease() {
    const keys = selectedItems().map(item => item.key);
    const token = ++epoch;
    showBusy(`正在释放 ${keys.length} 项，完成后统计实际腾出的内存…`);
    let result = null;
    try { result = await execute(keys); } catch { result = null; }
    if (token !== epoch || panel.hidden) return;
    lastResult = result && result.ok ? result : { results: keys.map(key => ({ key, ok: false, message: result?.error || '执行失败' })), freedBytes: 0, totalBytes: 0 };
    view = 'result';
    render();
  }

  function open() {
    onOpen?.();
    panel.hidden = false;
    doc.body.classList.add('memory-release-open');
    void scan();
  }

  function close() {
    epoch += 1;
    panel.hidden = true;
    doc.body.classList.remove('memory-release-open');
  }

  strip.addEventListener('click', event => {
    if (event.target.closest?.('.strip-disk')) return;
    if (!event.target.closest?.('.strip-resources')) return;
    event.preventDefault();
    if (panel.hidden) open(); else close();
  });

  panel.addEventListener('change', event => {
    const box = event.target.closest('[data-mr-key]');
    if (!box) return;
    selected.set(box.dataset.mrKey, box.checked);
    const chosen = selectedItems();
    const button = panel.querySelector('[data-mr-review]');
    if (button) {
      button.disabled = chosen.length === 0;
      button.textContent = `释放约 ${formatGB(chosen.reduce((s, i) => s + i.wsBytes, 0))}`;
    }
    const count = panel.querySelector('.mr-footer > span');
    if (count) count.textContent = `已勾选 ${chosen.length} 项`;
  });

  panel.addEventListener('click', event => {
    if (event.target.closest('[data-mr-close]')) { close(); return; }
    if (event.target.closest('[data-mr-rescan]')) { void scan(); return; }
    if (event.target.closest('[data-mr-review]')) { view = 'confirm'; render(); return; }
    if (event.target.closest('[data-mr-back]')) { view = 'list'; render(); return; }
    if (event.target.closest('[data-mr-confirm]')) void runRelease();
  });

  doc.addEventListener('pointerdown', event => {
    if (panel.hidden || panel.contains(event.target) || event.target.closest?.('.strip-resources')) return;
    close();
  }, true);
  doc.addEventListener('keydown', event => { if (event.key === 'Escape' && !panel.hidden) close(); });
  doc.defaultView.addEventListener('resize', position);

  return { open, close };
}

module.exports = { attachMemoryReleasePanel, formatGB };
