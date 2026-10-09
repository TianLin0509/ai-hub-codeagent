'use strict';

// 「全机残留」卡片。
//
// 设计上刻意做成一个**平时是空的健康指示器**：没有残留时只显示一行「未发现残留」，
// 有东西时才展开。分组顺序按「证据有多硬」排，不按占多少内存排——用户要的是
// 「我能放心关哪些」，不是「谁最占地方」。
//
// v1 不给「直接关掉」的按钮。误杀的代价是实打实的（把在跑的会话外壳当垃圾关了，
// 那个会话的活就没了），所以先只出清单和预演脚本，等判据在真实数据上跑一段时间
// 确认零误判，再谈自动执行。

const DEFAULT_ESCAPE = value => String(value == null ? '' : value)
  .replace(/[&<>"']/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[char]);

function formatBytes(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return '0 MB';
  if (number >= 1024 * 1024 * 1024) return `${(number / (1024 ** 3)).toFixed(1)} GB`;
  return `${Math.round(number / (1024 * 1024))} MB`;
}

function formatAge(ms) {
  const number = Number(ms);
  if (!Number.isFinite(number) || number <= 0) return '';
  const hours = number / 3_600_000;
  if (hours < 1) return `${Math.round(number / 60_000)} 分钟`;
  if (hours < 48) return `${hours.toFixed(1)} 小时`;
  return `${(hours / 24).toFixed(1)} 天`;
}

function createProcessReclaimCard(options = {}) {
  const doc = options.document || document;
  const ipcRenderer = options.ipcRenderer;
  const escapeHtml = typeof options.escapeHtml === 'function' ? options.escapeHtml : DEFAULT_ESCAPE;
  const onRendered = typeof options.onRendered === 'function' ? options.onRendered : null;
  const openPath = typeof options.openPath === 'function' ? options.openPath : null;
  const setIntervalFn = typeof options.setIntervalFn === 'function' ? options.setIntervalFn : setInterval;

  const state = {
    report: null,
    scanning: false,
    error: '',
    scannedAt: 0,
    selected: new Set(),
    expanded: new Set(),
    savedPath: '',
    dirty: false,
  };

  function el(id) {
    return doc.getElementById(id);
  }

  function setHtml(id, html) {
    const target = el(id);
    if (target) target.innerHTML = html;
  }

  // ── 摘要行 ─────────────────────────────────────────────────
  function renderSummary() {
    if (state.scanning) {
      setHtml('home-reclaim-summary', '<div class="reclaim-status scanning">正在扫描全机进程…（约 3 秒）</div>');
      return;
    }
    if (state.error) {
      setHtml('home-reclaim-summary', `<div class="reclaim-status bad">扫描失败：${escapeHtml(state.error)}</div>`);
      return;
    }
    const report = state.report;
    if (!report) {
      setHtml('home-reclaim-summary', '<div class="reclaim-status idle">还没扫描过。点右上角「扫描」看看这台电脑上有多少东西是本来就该关掉的。</div>');
      return;
    }

    const totals = report.totals || {};
    const count = totals.reclaimableCount || 0;
    const meta = `全机 ${totals.processes || 0} 个进程 · ${totals.hubAlive || 0} 个 Hub 运行中`
      + `${totals.hubDead ? ` · ${totals.hubDead} 个已退出` : ''} · 已保护 ${totals.protectedCount || 0} 个`;

    if (count === 0) {
      setHtml('home-reclaim-summary', `
        <div class="reclaim-status ok">✓ 未发现残留</div>
        <div class="reclaim-meta">${escapeHtml(meta)}</div>
      `);
      return;
    }

    setHtml('home-reclaim-summary', `
      <div class="reclaim-status warn">检出 ${count} 个残留进程 · 可回收 ${formatBytes(totals.reclaimableBytes)}</div>
      <div class="reclaim-meta">${escapeHtml(meta)}</div>
    `);
  }

  // ── 证据块 ─────────────────────────────────────────────────
  function evidenceHtml(item) {
    const lines = (item.evidence || [])
      .map(row => `<li class="${row.ok ? 'ok' : 'unsure'}">${row.ok ? '✓' : '?'} ${escapeHtml(row.text)}</li>`)
      .join('');
    return `
      <div class="reclaim-evidence">
        <div class="reclaim-evidence-lose"><b>关掉会失去什么？</b>${escapeHtml(item.whatYouLose || '')}</div>
        <ul class="reclaim-evidence-list">${lines}</ul>
        <div class="reclaim-evidence-cmd" title="${escapeHtml(item.commandLine || '')}">${escapeHtml((item.commandLine || '').slice(0, 240))}</div>
      </div>
    `;
  }

  function itemHtml(item, selectable) {
    const rootPid = Number(item.rootPid);
    const checked = state.selected.has(rootPid) ? ' checked' : '';
    const expanded = state.expanded.has(rootPid);
    const age = formatAge(item.ageMs);
    // CPU 标签给具体数字而不是「在用/没在用」。残留浏览器树的后台定时器
    // 总会让占用大于零，二值标签会把一堆早就没用的东西标成「仍在用」，反而误导。
    const cpuText = Number.isFinite(item.cpuPct)
      ? (item.cpuPct < 0.05 ? '0%' : `${item.cpuPct < 1 ? item.cpuPct.toFixed(2) : item.cpuPct.toFixed(1)}%`)
      : '';
    const idleTag = item.idleKnown
      ? (item.idle
        ? `<em class="reclaim-tag ok">几乎不动${cpuText ? ` ${cpuText}` : ''}</em>`
        : `<em class="reclaim-tag busy">在用 CPU ${cpuText}</em>`)
      : '<em class="reclaim-tag unsure">忙闲未知</em>';

    return `
      <div class="reclaim-item${expanded ? ' expanded' : ''}" data-reclaim-root="${rootPid}">
        <div class="reclaim-item-head">
          ${selectable ? `<input type="checkbox" data-reclaim-pick="${rootPid}"${checked} aria-label="选中这一项">` : '<span class="reclaim-nopick"></span>'}
          <span class="reclaim-item-label">
            ${escapeHtml(item.label || '残留')}
            ${item.detail ? `<b>${escapeHtml(item.detail)}</b>` : ''}
          </span>
          <span class="reclaim-item-stat">${item.processCount} 个 · ${formatBytes(item.wsBytes)}</span>
          ${age ? `<span class="reclaim-item-age">活了 ${escapeHtml(age)}</span>` : ''}
          ${idleTag}
          <button class="reclaim-detail-btn" type="button" data-reclaim-toggle="${rootPid}">${expanded ? '收起' : '看详情'}</button>
        </div>
        ${expanded ? evidenceHtml(item) : ''}
      </div>
    `;
  }

  function groupHtml(config) {
    const { key, index, title, hint, items, selectable } = config;
    if (!items || items.length === 0) return '';
    const processCount = items.reduce((sum, item) => sum + (item.processCount || 0), 0);
    const bytes = items.reduce((sum, item) => sum + (item.wsBytes || 0), 0);
    return `
      <div class="reclaim-group" data-reclaim-group="${key}">
        <div class="reclaim-group-head">
          <span class="reclaim-group-title"><i>${index}</i>${escapeHtml(title)}</span>
          <span class="reclaim-group-stat">${processCount} 个 · ${formatBytes(bytes)}</span>
        </div>
        <div class="reclaim-group-hint">${escapeHtml(hint)}</div>
        ${items.map(item => itemHtml(item, selectable)).join('')}
      </div>
    `;
  }

  // ── ④ 大户：只展示，永远没有按钮 ───────────────────────────
  function consumersHtml(consumers) {
    if (!consumers || consumers.length === 0) return '';
    const rows = consumers.slice(0, 6).map(row => `
      <div class="reclaim-consumer">
        <span class="reclaim-consumer-name">${escapeHtml(row.name)}${row.isHub ? '<i class="reclaim-tag hub">Hub</i>' : ''}</span>
        <span class="reclaim-consumer-count">${row.count} 个</span>
        <span class="reclaim-consumer-bytes">占用 ${formatBytes(row.wsBytes)}</span>
        <span class="reclaim-consumer-priv">预订 ${formatBytes(row.privBytes)}</span>
      </div>
    `).join('');
    return `
      <div class="reclaim-group muted" data-reclaim-group="bigConsumer">
        <div class="reclaim-group-head">
          <span class="reclaim-group-title"><i>④</i>不是 Hub 的大户</span>
          <span class="reclaim-group-stat">只看，不动</span>
        </div>
        <div class="reclaim-group-hint">这些不归 Hub 管，这里只是让你知道内存被谁占了。要关请自己去关。</div>
        ${rows}
      </div>
    `;
  }

  function renderGroups() {
    const report = state.report;
    if (!report || !report.ok) { setHtml('home-reclaim-groups', ''); return; }

    const groups = report.groups || {};
    const deadHubItems = (groups.deadHub || []).flatMap(bucket => (bucket.items || []).map(item => ({
      ...item,
      detail: item.detail || `来自 Hub #${bucket.hubPid}`,
    })));

    const blocks = [
      groupHtml({
        key: 'deadHub',
        index: '①',
        title: '已退出的 Hub 留下的',
        hint: '那个 Hub 已经不在了，它派出去的活当然没人要了。这是最硬的一条依据。',
        items: deadHubItems,
        selectable: true,
      }),
      groupHtml({
        key: 'endedSession',
        index: '②',
        title: '会话已结束但没关干净',
        hint: '属于当前这个 Hub，但已经不在任何活跃会话名下。',
        items: groups.endedSession,
        selectable: true,
      }),
      groupHtml({
        key: 'unattributed',
        index: '③',
        title: '认不出主人的（需要你确认）',
        hint: '这些是记账之前留下的历史遗留，追溯不到归属了。判断依据只有「形态像残留 + 没有窗口 + 活得够久」，所以要你自己勾。',
        items: groups.unattributed,
        selectable: true,
      }),
      consumersHtml(groups.bigConsumer),
    ].filter(Boolean);

    setHtml('home-reclaim-groups', blocks.join(''));
  }

  // ── 保护区 + 动作条 ────────────────────────────────────────
  function renderGuard() {
    const report = state.report;
    if (!report || !report.ok) { setHtml('home-reclaim-guard', ''); return; }

    const reasons = (report.protection && report.protection.reasons) || [];
    const reasonRows = reasons
      .map(row => `<li>${escapeHtml(row.reason)} — ${row.count} 个进程</li>`)
      .join('');

    const selectedCount = state.selected.size;
    const savedLine = state.savedPath
      ? `<div class="reclaim-saved">已生成预演清单：<code>${escapeHtml(state.savedPath)}</code>${openPath ? ' <button class="reclaim-open-btn" type="button" data-reclaim-action="open-saved">打开所在文件夹</button>' : ''}</div>`
      : '';

    const totals = report.totals || {};
    const hasItems = (totals.reclaimableCount || 0) > 0;

    setHtml('home-reclaim-guard', `
      ${hasItems ? `
        <div class="reclaim-actions">
          <button class="reclaim-primary" type="button" data-reclaim-action="save-script" ${selectedCount === 0 ? 'disabled' : ''}>
            生成预演清单${selectedCount > 0 ? `（${selectedCount} 项）` : ''}
          </button>
          <button class="reclaim-secondary" type="button" data-reclaim-action="select-all">全选</button>
          <button class="reclaim-secondary" type="button" data-reclaim-action="select-none">清空</button>
          <span class="reclaim-actions-note">Hub 不会替你关任何进程。这一步只生成一份可以自己读、自己跑的脚本。</span>
        </div>
      ` : ''}
      ${savedLine}
      <details class="reclaim-guard-box">
        <summary>🛡 已保护 ${totals.protectedCount || 0} 个进程，界面上不可选</summary>
        <ul class="reclaim-guard-list">${reasonRows || '<li>（无）</li>'}</ul>
        <p class="reclaim-guard-note">
          运行中的 Hub 和它们的会话一律整体保护。别的 Hub 的会话名单拿不到，
          所以宁可漏清也不误杀。系统进程从来不在可操作范围内——
          这个功能只对认得出形态的残留下结论，不做通用「内存优化」。
        </p>
      </details>
    `);
  }

  // 打开会话时 Hub 会把整个主页（#empty-state 子树）从文档里摘下来，回到主页再挂回去。
  // 摘下来的这段时间 getElementById 一律返回 null，render 写不进去。所以这里先探一下，
  // 写不进去就记个 dirty，等它回到文档里再补一次——否则「扫描结果在你切走的瞬间出来」
  // 会导致回到主页看到的还是旧内容。
  function attached() {
    return !!el('home-reclaim-summary');
  }

  function render() {
    if (!attached()) { state.dirty = true; return; }
    state.dirty = false;
    renderSummary();
    renderGroups();
    renderGuard();
    if (onRendered) onRendered();
  }

  // ── 交互 ───────────────────────────────────────────────────
  function allRootPids() {
    const report = state.report;
    if (!report || !report.ok) return [];
    const groups = report.groups || {};
    return [
      ...(groups.deadHub || []).flatMap(bucket => (bucket.items || []).map(item => Number(item.rootPid))),
      ...(groups.endedSession || []).map(item => Number(item.rootPid)),
      ...(groups.unattributed || []).map(item => Number(item.rootPid)),
    ].filter(Boolean);
  }

  async function scan() {
    if (state.scanning || !ipcRenderer) return;
    state.scanning = true;
    state.error = '';
    state.savedPath = '';
    render();
    try {
      const report = await ipcRenderer.invoke('get-process-reclaim-report', { force: true });
      if (report && report.ok) {
        state.report = report;
        state.scannedAt = Date.now();
        // 选中集合按新一轮结果收敛，免得留下已经消失的 PID。
        const live = new Set(allRootPids());
        state.selected = new Set(Array.from(state.selected).filter(pid => live.has(pid)));
      } else {
        state.report = null;
        state.error = (report && report.error) || '未知错误';
      }
    } catch (err) {
      state.report = null;
      state.error = String((err && err.message) || err);
    } finally {
      state.scanning = false;
      render();
    }
  }

  async function saveScript() {
    if (!ipcRenderer || state.selected.size === 0) return;
    try {
      const result = await ipcRenderer.invoke('save-process-reclaim-script', {
        rootPids: Array.from(state.selected),
      });
      state.savedPath = result && result.ok ? result.filePath : '';
      if (!state.savedPath) state.error = (result && result.error) || '生成失败';
    } catch (err) {
      state.error = String((err && err.message) || err);
    }
    render();
  }

  function handleClick(event) {
    const target = event.target;
    if (!target || !target.closest) return;

    const actionBtn = target.closest('[data-reclaim-action]');
    if (actionBtn) {
      const action = actionBtn.getAttribute('data-reclaim-action');
      if (action === 'scan') { scan(); return; }
      if (action === 'save-script') { saveScript(); return; }
      if (action === 'select-all') { state.selected = new Set(allRootPids()); render(); return; }
      if (action === 'select-none') { state.selected = new Set(); render(); return; }
      if (action === 'open-saved' && openPath && state.savedPath) { openPath(state.savedPath); return; }
    }

    const toggle = target.closest('[data-reclaim-toggle]');
    if (toggle) {
      const pid = Number(toggle.getAttribute('data-reclaim-toggle'));
      if (state.expanded.has(pid)) state.expanded.delete(pid);
      else state.expanded.add(pid);
      render();
    }
  }

  function handleChange(event) {
    const target = event.target;
    if (!target || !target.getAttribute) return;
    const raw = target.getAttribute('data-reclaim-pick');
    if (!raw) return;
    const pid = Number(raw);
    if (target.checked) state.selected.add(pid);
    else state.selected.delete(pid);
    render();
  }

  // 监听挂在 document 上而不是卡片元素上：卡片会随主页整体被摘下/挂回，
  // 绑在元素上的监听虽然跟着走，但一旦有人重建那段 DOM 就全丢了。
  // 仓库里记忆面板也是这个理由走的文档级委托。
  function scopedClick(event) {
    if (!event.target || !event.target.closest) return;
    if (!event.target.closest('[data-home-card="reclaim"]')) return;
    handleClick(event);
  }
  function scopedChange(event) {
    if (!event.target || !event.target.closest) return;
    if (!event.target.closest('[data-home-card="reclaim"]')) return;
    handleChange(event);
  }
  doc.addEventListener('click', scopedClick);
  doc.addEventListener('change', scopedChange);

  // 卡片被摘下期间产生的渲染补回来。只在 dirty 时才动，平时零开销。
  const healTimer = setIntervalFn(() => { if (state.dirty && attached()) render(); }, 2_000);

  render();

  return {
    render,
    scan,
    getState: () => state,
    dispose: () => {
      clearInterval(healTimer);
      doc.removeEventListener('click', scopedClick);
      doc.removeEventListener('change', scopedChange);
    },
  };
}

module.exports = {
  createProcessReclaimCard,
  formatAge,
  formatBytes,
};
