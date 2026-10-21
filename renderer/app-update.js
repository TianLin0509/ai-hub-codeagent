'use strict';
// 一键更新的界面（2026-10-13，公司版）：设置菜单里的「检查更新」、标题栏的新版本提示、更新弹窗。
// 弹窗显示：当前版本 → 新版本、发布说明、包大小与更新方式；下载时显示当前下载源、进度、速度、
// 剩余时间和每个源的结果（成功 / 失败 + 原因）；下载好后「立即重启 / 稍后」。
// 数据与动作都在主进程 main/app-update-controller.js；没有下载源的发行版（主仓库、公开版）什么也不做。
(() => {
  const distribution = require('../core/distribution');
  if (!distribution.updateConfig) return;
  const { ipcRenderer, shell } = require('electron');
  const productName = distribution.productName || 'AI Hub';
  let state = null, dialog = null;
  // 点「立即重启」时通道还有在途问题：主进程回 needsConfirm，弹窗里让人选「答完再重启」还是「立即重启」（2026-10-21）。
  let confirmInfo = null;

  const css = `
  .app-update-dialog { position: fixed; inset: 0; margin: auto; height: fit-content; max-height: calc(100vh - 48px); overflow: auto; width: min(560px, calc(100vw - 48px)); padding: 0; border: 1px solid var(--border-subtle, #e3e1ea); border-radius: 14px;
    background: var(--surface-raised, #fff); color: var(--fg-default, #1f2330); box-shadow: 0 24px 60px rgba(30, 24, 60, .22); font: inherit; }
  .app-update-dialog::backdrop { background: rgba(24, 20, 40, .38); }
  .au-head { display: flex; align-items: center; gap: 12px; padding: 18px 20px 12px; }
  .au-head img { width: 34px; height: 34px; border-radius: 8px; }
  .au-title { flex: 1; min-width: 0; }
  .au-title strong { display: block; font-size: 15px; }
  .au-title span { font-size: 12px; color: var(--fg-muted, #6b7080); }
  .au-close { border: 0; background: transparent; color: var(--fg-muted, #6b7080); font-size: 18px; cursor: pointer; padding: 4px 8px; border-radius: 6px; }
  .au-close:hover { background: rgba(0,0,0,.05); }
  .au-body { padding: 0 20px 6px; font-size: 13px; line-height: 1.6; }
  .au-versions { display: flex; align-items: center; gap: 10px; padding: 12px 14px; border-radius: 10px; background: var(--surface-sunken, #f6f5fa); margin-bottom: 12px; }
  .au-ver { display: flex; flex-direction: column; }
  .au-ver small { font-size: 11px; color: var(--fg-muted, #6b7080); }
  .au-ver b { font-size: 16px; }
  .au-arrow { color: var(--brand, #8b5cf6); font-size: 18px; }
  .au-plan { margin-left: auto; text-align: right; font-size: 12px; color: var(--fg-muted, #6b7080); }
  .au-plan b { display: block; color: var(--fg-default, #1f2330); font-size: 13px; }
  .au-notes { margin: 0 0 12px; padding-left: 18px; }
  .au-notes li { margin: 2px 0; }
  .au-section { font-size: 12px; font-weight: 600; color: var(--fg-muted, #6b7080); margin: 10px 0 6px; }
  .au-progress { height: 8px; border-radius: 99px; background: var(--surface-sunken, #eeedf4); overflow: hidden; }
  .au-allow { margin: 10px 0 4px; padding: 10px 12px; border-radius: 10px; background: var(--surface-sunken, #f6f5fa); font-size: 12.5px; }
  .au-allow b { display: block; font-size: 13px; margin-bottom: 4px; }
  .au-allow ol { margin: 0 0 6px; padding-left: 18px; }
  .au-allow-url { display: block; padding: 6px 8px; border-radius: 6px; background: var(--surface, #fff); font-family: Consolas, monospace; font-size: 12px; word-break: break-all; user-select: text; }
  .au-allow-actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 8px; }
  .au-progress i { display: block; height: 100%; width: 0; background: var(--brand, #8b5cf6); border-radius: 99px; transition: width .2s; }
  .au-progress-meta { display: flex; justify-content: space-between; font-size: 12px; color: var(--fg-muted, #6b7080); margin: 6px 0 10px; }
  .au-sources { list-style: none; margin: 0; padding: 0; border: 1px solid var(--border-subtle, #e3e1ea); border-radius: 10px; }
  .au-sources li { display: flex; gap: 10px; align-items: baseline; padding: 8px 12px; font-size: 12px; }
  .au-sources li + li { border-top: 1px solid var(--border-subtle, #eceaf2); }
  .au-sources .au-src { width: 64px; flex: none; font-weight: 600; }
  .au-sources .au-st { flex: 1; min-width: 0; color: var(--fg-muted, #6b7080); overflow-wrap: anywhere; }
  .au-sources .ok .au-st { color: #2f8a57; }
  .au-sources .failed .au-st { color: #b4472f; }
  .au-sources .downloading .au-st { color: var(--brand, #8b5cf6); }
  .au-msg { padding: 10px 12px; border-radius: 10px; font-size: 12.5px; margin: 8px 0; }
  .au-msg.ok { background: #ecf7f0; color: #24704a; }
  .au-msg.bad { background: #fbefec; color: #9b3a24; }
  .au-msg.info { background: var(--surface-sunken, #f6f5fa); color: var(--fg-muted, #6b7080); }
  .au-msg.warn { background: #fff6e5; color: #8a5a00; }
  .au-wait-list { margin: 4px 0 8px; padding-left: 18px; font-size: 12px; color: var(--fg-muted, #6b7080); }
  .au-foot { display: flex; justify-content: flex-end; gap: 8px; padding: 12px 20px 18px; }
  .au-btn { padding: 7px 16px; border-radius: 8px; border: 1px solid var(--border-subtle, #dcd9e6); background: var(--surface-raised, #fff); color: inherit; font: inherit; font-size: 13px; cursor: pointer; }
  .au-btn:hover { background: var(--surface-sunken, #f6f5fa); }
  .au-btn.primary { background: var(--brand, #8b5cf6); border-color: var(--brand, #8b5cf6); color: #fff; font-weight: 600; }
  .au-btn.primary:hover { filter: brightness(1.06); }
  .au-btn:disabled { opacity: .5; cursor: default; }
  #btn-options.update-has-unread .rail-utility-label { position: relative; }
  #btn-options.update-has-unread .rail-utility-label:after { content: ''; position: absolute; top: -1px; right: -8px; width: 6px; height: 6px; background: #ff755c; border-radius: 50%; }
  #options-check-update.update-has-unread:after { content: ''; display: inline-block; width: 6px; height: 6px; background: #ff755c; border-radius: 50%; margin: 0 0 7px 6px; }
  #options-check-update.update-has-unread { font-weight: 600; }
  .au-toast { position: fixed; right: 20px; top: 56px; z-index: 10050; max-width: 420px; padding: 10px 14px; border-radius: 10px; font-size: 13px;
    background: var(--surface-raised, #fff); border: 1px solid var(--border-subtle, #e3e1ea); box-shadow: 0 10px 30px rgba(30,24,60,.16); }
  `;
  const style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);

  const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const mb = n => n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round((n || 0) / 1024))} KB`;
  const eta = s => s == null ? '' : s >= 60 ? `剩余约 ${Math.ceil(s / 60)} 分钟` : `剩余约 ${Math.max(1, s)} 秒`;

  function sourceRows() {
    const attempts = state.attempts || [];
    const byId = new Map(attempts.map(a => [a.id, a]));
    return (state.sources || []).map(s => {
      const a = byId.get(s.id);
      const status = !a ? 'idle' : a.status;
      const text = !a ? (state.phase === 'downloading' ? '排队中（前一个源失败才会用）' : '未使用')
        : a.status === 'ok' ? `下载完成并校验通过 · ${mb(a.bytes)} · ${(a.ms / 1000).toFixed(1)} 秒`
        : a.status === 'downloading' ? '正在下载…'
        : a.status === 'cancelled' ? '已取消' : `失败：${a.reason}`;
      return `<li class="${esc(status)}" data-source="${esc(s.id)}"><span class="au-src">${esc(s.name)}</span><span class="au-st">${esc(text)}</span></li>`;
    }).join('');
  }

  function checkRows() {
    return (state.checks || []).map(c => `<li class="${c.ok ? 'ok' : 'failed'}" data-source="${esc(c.id)}"><span class="au-src">${esc(c.name)}</span>`
      + `<span class="au-st">${c.ok ? `可用，最新 v${esc(c.version)}` : `连不上：${esc(c.reason)}`}</span></li>`).join('');
  }

  // 被公司代理拦截的源：给出网址，用户在浏览器里打开、点「允许」放行后回来重新检查（2026-10-14 用户：阿里云点一下允许就通）。
  function blockedSources() {
    const seen = new Map();
    for (const row of [...(state.checks || []), ...(state.attempts || [])]) {
      if (row && row.blocked && /^https?:\/\//i.test(String(row.url || ''))) seen.set(row.id, { name: row.name, url: row.url, file: !(state.checks || []).includes(row) });
    }
    return [...seen.values()];
  }

  function allowBox() {
    const rows = blockedSources();
    if (!rows.length) return '';
    return rows.map(r => `<div class="au-allow" data-allow-source="${esc(r.name)}"><b>「${esc(r.name)}」被公司网络拦截了，可以手动放行</b>`
      + `<ol><li>点「打开网页放行」，会用浏览器打开下面这个网址；</li><li>在打开的网页上点「允许」${r.file ? '（之后浏览器若开始下载文件，取消即可）' : ''}；</li><li>回到这里点「重新检查」。</li></ol>`
      + `<code class="au-allow-url">${esc(r.url)}</code>`
      + `<div class="au-allow-actions"><button class="au-btn" data-au="allow-open" data-url="${esc(r.url)}">打开网页放行</button>`
      + `<button class="au-btn" data-au="allow-copy" data-url="${esc(r.url)}">复制网址</button>`
      + `<button class="au-btn${state.phase === 'error' ? '' : ' primary'}" data-au="retry">重新检查</button></div></div>`).join('');
  }

  const hhmm = ms => { const d = new Date(ms); return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'); };
  const waitItems = items => (items && items.length ? `<ul class="au-wait-list">${items.slice(0, 8).map(x => `<li>${x.kind === 'bridge'
    ? `通道问题 ${esc(x.thread || '')}${x.round != null ? ` 第 ${esc(x.round)} 轮` : ''}` : `本机会话${x.title ? '「' + esc(x.title) + '」' : ''}`}</li>`).join('')}${items.length > 8 ? `<li>另有 ${items.length - 8} 个</li>` : ''}</ul>` : '');
  // 正在等通道问题答完再重启（本机点的或家里发的）：说清等谁、等到几点，可以立即重启或取消。
  function waitBlock(w) {
    return `<div class="au-msg warn" data-au-wait>${esc(w.text)}。期间新问题先排队，答完立即重启；到点还没答完的先记下、重启后自动接着做。</div>${waitItems(w.items)}`;
  }
  function render() {
    if (!dialog || !state) return;
    const w = state.restartWait;
    if (w || confirmInfo) {
      const c = confirmInfo, versions0 = `<div class="au-versions"><div class="au-ver"><small>当前版本</small><b>v${esc(state.current)}</b></div>`
        + (state.latest ? `<span class="au-arrow">→</span><div class="au-ver"><small>新版本</small><b>v${esc((w && w.target) || state.latest.version)}</b></div>` : '') + '</div>';
      let body0, foot0;
      if (w) {
        body0 = versions0 + waitBlock(w);
        foot0 = `<button class="au-btn" data-au="close">关闭</button>${w.local ? '<button class="au-btn" data-au="wait-cancel">不重启了</button>' : ''}`
          + `<button class="au-btn primary" data-au="apply-now">立即重启${w.count ? `（打断 ${w.count} 个问题）` : ''}</button>`;
      } else {
        body0 = versions0 + `<div class="au-msg warn" data-au-confirm>通道里还有 ${esc(c.text)}在答。现在重启会打断这 ${c.count} 个问题（重启后自动恢复会话接着做，回执照常发回家里）。</div>${waitItems(c.items)}`
          + `<div class="au-msg info">「答完再重启」：最多等 ${c.graceMinutes} 分钟（预计最晚 ${hhmm(c.deadline)}），期间新问题先排队${c.queued ? `（现有 ${c.queued} 个排队的重启后接着发）` : ''}，答完立即重启。</div>`;
        foot0 = `<button class="au-btn" data-au="close">稍后</button><button class="au-btn" data-au="apply-now">立即重启（打断 ${c.count} 个问题）</button>`
          + '<button class="au-btn primary" data-au="apply-wait">答完再重启</button>';
      }
      dialog.innerHTML = `<div class="au-head"><img src="../claude-wx.ico" alt=""><div class="au-title"><strong>软件更新</strong><span>${esc(productName)}${distribution.editionBadge ? ' · ' + esc(distribution.editionBadge) : ''}</span></div>`
        + '<button class="au-close" data-au="close" aria-label="关闭">×</button></div>'
        + `<div class="au-body">${body0}</div><div class="au-foot">${foot0}</div>`;
      return;
    }
    const s = state, latest = s.latest, plan = s.plan;
    const versions = `<div class="au-versions"><div class="au-ver"><small>当前版本</small><b>v${esc(s.current)}</b></div>`
      + (latest && plan && plan.kind !== 'none' ? `<span class="au-arrow">→</span><div class="au-ver"><small>新版本</small><b>v${esc(latest.version)}</b></div>`
        + `<div class="au-plan"><b>${plan.kind === 'incremental' ? '程序更新（不含运行库）' : '完整安装包'} · ${mb(plan.bytes)}</b>${esc(plan.reason)}</div>` : '')
      + '</div>';
    let body = versions, foot = '';
    if (s.phase === 'checking') {
      body += '<div class="au-msg info">正在向各个更新源查询最新版本…</div>';
      foot = '<button class="au-btn" data-au="close">关闭</button>';
    } else if (s.phase === 'none') {
      body += `<div class="au-msg ok">已是最新版本 v${esc(s.current)}。</div><div class="au-section">更新源</div><ul class="au-sources">${checkRows()}</ul>${allowBox()}`;
      foot = '<button class="au-btn" data-au="close">好的</button>';
    } else if (s.phase === 'available') {
      if (latest && latest.notes && latest.notes.length) body += `<div class="au-section">本次更新</div><ul class="au-notes">${latest.notes.map(n => `<li>${esc(n)}</li>`).join('')}</ul>`;
      body += `<div class="au-section">更新源（按顺序尝试，失败自动换下一个）</div><ul class="au-sources">${(s.attempts && s.attempts.length) ? sourceRows() : checkRows()}</ul>${allowBox()}`;
      foot = '<button class="au-btn" data-au="close">稍后</button><button class="au-btn primary" data-au="download">下载更新</button>';
    } else if (s.phase === 'downloading') {
      const p = s.progress || {}, pct = p.total ? Math.min(100, p.received / p.total * 100) : 0;
      const current = (s.attempts || []).find(a => a.status === 'downloading');
      body += `<div class="au-section">正在从「${esc(current ? current.name : '…')}」下载</div>`
        + `<div class="au-progress"><i style="width:${pct.toFixed(1)}%"></i></div>`
        + `<div class="au-progress-meta"><span>${mb(p.received || 0)} / ${mb(p.total || 0)}${p.speed ? ` · ${mb(p.speed)}/s` : ''}</span><span>${eta(p.etaSec)}</span></div>`
        + `<ul class="au-sources">${sourceRows()}</ul>`;
      foot = '<button class="au-btn" data-au="cancel">取消</button>';
    } else if (s.phase === 'ready') {
      body += `<div class="au-msg ok">新版本已从「${esc(s.readySource)}」下载并校验通过。${plan && plan.kind === 'incremental' ? '点「立即重启」后约 5 秒完成替换并自动重新打开；替换失败会自动恢复旧版本。' : '点「立即安装」会打开安装程序，并关闭当前窗口。'}</div>`
        + `<ul class="au-sources">${sourceRows()}</ul>`;
      foot = `<button class="au-btn" data-au="close">稍后</button><button class="au-btn primary" data-au="apply">${plan && plan.kind === 'incremental' ? '立即重启' : '立即安装'}</button>`;
    } else if (s.phase === 'applying') {
      body += '<div class="au-msg info">正在关闭并替换程序文件，完成后会自动重新打开…</div>';
    } else if (s.phase === 'error') {
      body += `<div class="au-msg bad">${esc(s.error || '更新失败')}</div>`;
      if (s.attempts && s.attempts.length) body += `<div class="au-section">各下载源的结果</div><ul class="au-sources">${sourceRows()}</ul>`;
      else if (s.checks && s.checks.length) body += `<div class="au-section">更新源</div><ul class="au-sources">${checkRows()}</ul>`;
      body += allowBox();
      foot = `${s.releasePage ? '<button class="au-btn" data-au="manual">打开发布页手动下载</button>' : ''}<button class="au-btn" data-au="close">关闭</button><button class="au-btn primary" data-au="retry">重试</button>`;
    } else {
      body += '<div class="au-msg info">点「检查更新」查询最新版本。</div>';
      foot = '<button class="au-btn" data-au="close">关闭</button><button class="au-btn primary" data-au="retry">检查更新</button>';
    }
    dialog.innerHTML = `<div class="au-head"><img src="../claude-wx.ico" alt=""><div class="au-title"><strong>软件更新</strong><span>${esc(productName)}${distribution.editionBadge ? ' · ' + esc(distribution.editionBadge) : ''}</span></div>`
      + '<button class="au-close" data-au="close" aria-label="关闭">×</button></div>'
      + `<div class="au-body">${body}</div><div class="au-foot">${foot}</div>`;
  }

  function openDialog() {
    if (!dialog) {
      dialog = document.createElement('dialog');
      dialog.className = 'app-update-dialog';
      dialog.addEventListener('click', onClick);
      dialog.addEventListener('close', () => { dialog.remove(); dialog = null; });
      document.body.appendChild(dialog);
    }
    render();
    if (!dialog.open) dialog.showModal();
  }

  async function onClick(event) {
    const action = event.target.closest('[data-au]')?.dataset.au;
    if (!action) return;
    try {
      if (action === 'close') { confirmInfo = null; dialog?.close(); }
      else if (action === 'retry') { await ipcRenderer.invoke('app-update:check'); }
      else if (action === 'download') {
        // 已经动手更新了，设置上的红点就不用再提醒。
        if (pendingVersion()) { writeKey(SEEN_KEY, pendingVersion()); renderUnread(); }
        await ipcRenderer.invoke('app-update:download');
      }
      else if (action === 'cancel') await ipcRenderer.invoke('app-update:cancel');
      else if (['apply', 'apply-wait', 'apply-now', 'wait-cancel'].includes(action)) {
        const mode = { apply: 'auto', 'apply-wait': 'wait', 'apply-now': 'now', 'wait-cancel': 'cancel' }[action];
        const next = await ipcRenderer.invoke('app-update:apply', { mode });
        confirmInfo = next && next.needsConfirm ? next.confirm : null;
        if (next && next.phase) update(next); else render();
      }
      else if (action === 'manual' && state?.releasePage) shell.openExternal(state.releasePage);
      else if (action === 'allow-open' || action === 'allow-copy') {
        const button = event.target.closest('[data-au]');
        const url = button.dataset.url || '';
        // 只放行界面上列出的被拦截网址，不打开别的。
        if (!blockedSources().some(r => r.url === url)) return;
        if (action === 'allow-open') shell.openExternal(url);
        else { require('electron').clipboard.writeText(url); button.textContent = '已复制'; }
      }
    } catch (error) {
      state = { ...state, phase: 'error', error: error.message };
      render();
    }
  }

  // 新版本提醒（2026-10-13 用户）：同一个版本只自动弹一次窗；之后「设置」按钮挂红点（同助理的未读红点），
  // 直到用户从设置菜单点开这个版本的更新为止。两个标记按版本号记在本机，换了新版本重新提醒。
  const PROMPTED_KEY = 'hub:appUpdate:promptedVersion';
  const SEEN_KEY = 'hub:appUpdate:seenVersion';
  const readKey = key => { try { return localStorage.getItem(key) || ''; } catch { return ''; } };
  const writeKey = (key, value) => { try { localStorage.setItem(key, value); } catch {} };
  function pendingVersion() {
    return state && state.latest && state.plan && state.plan.kind !== 'none'
      && ['available', 'downloading', 'ready'].includes(state.phase) ? String(state.latest.version) : '';
  }
  function maybePromptOnce() {
    const version = pendingVersion();
    if (!version || state.phase !== 'available' || readKey(PROMPTED_KEY) === version) return;
    writeKey(PROMPTED_KEY, version);
    // 用户自己从设置里点开、正看着弹窗时查到的新版本，算已看过，不再挂红点。
    if (dialog) { writeKey(SEEN_KEY, version); renderUnread(); return; }
    openDialog();
  }
  function renderUnread() {
    const version = pendingVersion();
    const unread = !!version && readKey(SEEN_KEY) !== version;
    const button = document.getElementById('btn-options');
    if (button) {
      button.classList.toggle('update-has-unread', unread);
      if (unread) button.title = `选项 · 有新版本 v${version}`;
      else if (button.title.startsWith('选项 · 有新版本')) button.title = '选项';
    }
    const item = document.getElementById('options-check-update');
    if (item) {
      item.textContent = version ? `⬆️ 有新版本 v${version}` : '⬆️ 检查更新';
      item.classList.toggle('update-has-unread', unread);
    }
  }

  // 左上角「内测先锋版」标签（2026-10-14 用户）：查到新版本时换成「有新版本 vX」加绿色呼吸圆点，点它打开更新窗。
  // 下载中 / 已就绪由标题栏的进度小标签提示，标签恢复原样。
  function renderBadge() {
    const badge = document.getElementById('hub-edition-badge');
    if (!badge) return;
    const version = state && state.phase === 'available' ? pendingVersion() : '';
    badge.classList.toggle('has-update', !!version);
    badge.textContent = version ? `有新版本 v${version}` : (distribution.editionBadge || badge.textContent);
    if (version) { badge.title = '点击查看并更新'; badge.setAttribute('role', 'button'); badge.tabIndex = 0; }
    else { badge.removeAttribute('title'); badge.removeAttribute('role'); badge.removeAttribute('tabindex'); }
    if (!badge.dataset.updateBound) {
      badge.dataset.updateBound = '1';
      const open = () => { if (!badge.classList.contains('has-update')) return; const v = pendingVersion(); if (v) { writeKey(SEEN_KEY, v); renderUnread(); } openDialog(); };
      badge.addEventListener('click', open);
      badge.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); open(); } });
    }
  }

  function renderPill() {
    let pill = document.getElementById('hub-update-pill');
    // 「有新版本」改由弹窗 + 设置红点提醒；标题栏只在下载中 / 已就绪时提示进度和重启。
    const wait = state && state.restartWait;
    const show = wait || (state && ['ready', 'downloading'].includes(state.phase) && state.latest && state.plan?.kind !== 'none');
    if (!show) { pill?.remove(); return; }
    if (!pill) {
      pill = document.createElement('button');
      pill.type = 'button'; pill.id = 'hub-update-pill'; pill.className = 'hub-update-pill';
      pill.addEventListener('click', openDialog);
      const anchor = document.getElementById('hub-version');
      if (anchor) anchor.after(pill); else document.getElementById('hub-identity')?.appendChild(pill);
    }
    pill.textContent = wait ? (wait.count ? `等 ${wait.count} 个${wait.bridgeCount === wait.count ? '通道问题' : '任务'}答完再重启 · 最晚 ${hhmm(wait.deadline)}` : '马上重启')
      : state.phase === 'ready' ? `v${state.latest.version} 已就绪，重启生效` : state.phase === 'downloading' ? `正在下载 v${state.latest.version}` : `有新版本 v${state.latest.version}`;
    pill.title = '点击查看更新';
  }

  function toast(html, ms = 8000) {
    const el = document.createElement('div');
    el.className = 'au-toast'; el.innerHTML = html;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), ms);
  }

  function addMenuEntry() {
    const menu = document.getElementById('options-menu');
    if (!menu || document.getElementById('options-check-update')) return;
    const item = document.createElement('div');
    item.className = 'options-item'; item.id = 'options-check-update'; item.textContent = '⬆️ 检查更新';
    item.addEventListener('click', () => {
      menu.style.display = 'none';
      const version = pendingVersion();
      if (version) { writeKey(SEEN_KEY, version); writeKey(PROMPTED_KEY, version); renderUnread(); }
      openDialog();
      // 已经查到新版本（或正在下载 / 已就绪）就直接看它；否则现查一次。
      if (!version) void ipcRenderer.invoke('app-update:check');
    });
    menu.appendChild(item);
  }

  const update = next => { state = next; render(); renderPill(); renderBadge(); renderUnread(); maybePromptOnce(); };
  ipcRenderer.on('app-update:state', (_e, next) => update(next));
  // 通道状态变了（问题答完、开始等待重启……）：重读一次，标题栏小标签和弹窗里的「等 N 个问题」跟着变；等待中每 30 秒刷新已等时长。
  let refreshTimer = null;
  const refresh = () => { if (refreshTimer) return; refreshTimer = setTimeout(() => { refreshTimer = null; ipcRenderer.invoke('app-update:get-state').then(next => { if (next) update(next); }).catch(() => {}); }, 1500); };
  ipcRenderer.on('bridge:changed', refresh);
  setInterval(() => { if (state && state.restartWait) refresh(); }, 30000);
  addMenuEntry();
  ipcRenderer.invoke('app-update:get-state').then(initial => {
    update(initial);
    const r = initial && initial.lastResult;
    if (r) {
      void ipcRenderer.invoke('app-update:dismiss-result');
      if (r.ok) toast(`✅ 已更新到 <b>v${esc(r.version)}</b>`);
      else toast(`⚠️ 更新到 v${esc(r.version)} 没有完成${r.rolledBack ? '，已恢复原来的版本' : ''}：${esc(r.reason)}`, 15000);
    }
  }).catch(() => {});
  window.__appUpdate = { open: openDialog, state: () => state };
})();
