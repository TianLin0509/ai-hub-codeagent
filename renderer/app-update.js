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
  .au-foot { display: flex; justify-content: flex-end; gap: 8px; padding: 12px 20px 18px; }
  .au-btn { padding: 7px 16px; border-radius: 8px; border: 1px solid var(--border-subtle, #dcd9e6); background: var(--surface-raised, #fff); color: inherit; font: inherit; font-size: 13px; cursor: pointer; }
  .au-btn:hover { background: var(--surface-sunken, #f6f5fa); }
  .au-btn.primary { background: var(--brand, #8b5cf6); border-color: var(--brand, #8b5cf6); color: #fff; font-weight: 600; }
  .au-btn.primary:hover { filter: brightness(1.06); }
  .au-btn:disabled { opacity: .5; cursor: default; }
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

  function render() {
    if (!dialog || !state) return;
    const s = state, latest = s.latest, plan = s.plan;
    const versions = `<div class="au-versions"><div class="au-ver"><small>当前版本</small><b>v${esc(s.current)}</b></div>`
      + (latest && plan && plan.kind !== 'none' ? `<span class="au-arrow">→</span><div class="au-ver"><small>新版本</small><b>v${esc(latest.version)}</b></div>`
        + `<div class="au-plan"><b>${plan.kind === 'incremental' ? '增量更新' : '完整安装包'} · ${mb(plan.bytes)}</b>${esc(plan.reason)}</div>` : '')
      + '</div>';
    let body = versions, foot = '';
    if (s.phase === 'checking') {
      body += '<div class="au-msg info">正在向各个更新源查询最新版本…</div>';
      foot = '<button class="au-btn" data-au="close">关闭</button>';
    } else if (s.phase === 'none') {
      body += `<div class="au-msg ok">已是最新版本 v${esc(s.current)}。</div><div class="au-section">更新源</div><ul class="au-sources">${checkRows()}</ul>`;
      foot = '<button class="au-btn" data-au="close">好的</button>';
    } else if (s.phase === 'available') {
      if (latest && latest.notes && latest.notes.length) body += `<div class="au-section">本次更新</div><ul class="au-notes">${latest.notes.map(n => `<li>${esc(n)}</li>`).join('')}</ul>`;
      body += `<div class="au-section">更新源（按顺序尝试，失败自动换下一个）</div><ul class="au-sources">${(s.attempts && s.attempts.length) ? sourceRows() : checkRows()}</ul>`;
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
      if (action === 'close') dialog?.close();
      else if (action === 'retry') { await ipcRenderer.invoke('app-update:check'); }
      else if (action === 'download') { await ipcRenderer.invoke('app-update:download'); }
      else if (action === 'cancel') await ipcRenderer.invoke('app-update:cancel');
      else if (action === 'apply') await ipcRenderer.invoke('app-update:apply');
      else if (action === 'manual' && state?.releasePage) shell.openExternal(state.releasePage);
    } catch (error) {
      state = { ...state, phase: 'error', error: error.message };
      render();
    }
  }

  function renderPill() {
    let pill = document.getElementById('hub-update-pill');
    const show = state && ['available', 'ready', 'downloading'].includes(state.phase) && state.latest && state.plan?.kind !== 'none';
    if (!show) { pill?.remove(); return; }
    if (!pill) {
      pill = document.createElement('button');
      pill.type = 'button'; pill.id = 'hub-update-pill'; pill.className = 'hub-update-pill';
      pill.addEventListener('click', openDialog);
      const anchor = document.getElementById('hub-version');
      if (anchor) anchor.after(pill); else document.getElementById('hub-identity')?.appendChild(pill);
    }
    pill.textContent = state.phase === 'ready' ? `v${state.latest.version} 已就绪，重启生效` : state.phase === 'downloading' ? `正在下载 v${state.latest.version}` : `有新版本 v${state.latest.version}`;
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
    item.addEventListener('click', () => { menu.style.display = 'none'; openDialog(); void ipcRenderer.invoke('app-update:check'); });
    menu.appendChild(item);
  }

  ipcRenderer.on('app-update:state', (_e, next) => { state = next; render(); renderPill(); });
  addMenuEntry();
  ipcRenderer.invoke('app-update:get-state').then(initial => {
    state = initial; renderPill();
    const r = initial && initial.lastResult;
    if (r) {
      void ipcRenderer.invoke('app-update:dismiss-result');
      if (r.ok) toast(`✅ 已更新到 <b>v${esc(r.version)}</b>`);
      else toast(`⚠️ 更新到 v${esc(r.version)} 没有完成${r.rolledBack ? '，已恢复原来的版本' : ''}：${esc(r.reason)}`, 15000);
    }
  }).catch(() => {});
  window.__appUpdate = { open: openDialog, state: () => state };
})();
