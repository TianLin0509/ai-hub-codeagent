const { supportsForkSession } = require('../core/session-capabilities.js');
const { compareSidebarPlacement } = require('./session-list-renderer.js');
const { isBlockingModalOpen, isElementOpen } = require('./modal-layer-guard.js');
const { isCodexOwnedTranscript, navigateCodexTranscript } = require('./terminal-input-controller');

function createKeyboardShortcuts({
  document,
  ipcRenderer,
  clipboard,
  sessions,
  terminalCache,
  getActiveSessionId,
  getCurrentFontSize,
  selectSession,
  escapeToHome,
  toggleSidebar,
  openTerminalSearch,
  openPreviewQuickOpen,
  setFontSize,
  closeSession,
  createWorkspaceSession,
  copyText,
}) {
  const createSession = kind => typeof createWorkspaceSession === 'function'
    ? createWorkspaceSession(kind)
    : ipcRenderer.invoke('create-session', kind);
  const closeSessionRequest = typeof closeSession === 'function'
    ? closeSession
    : sessionId => ipcRenderer.invoke('close-session', sessionId);
  function getSortedVisibleSessionIds() {
    return Array.from(sessions.values())
      .filter((session) => session && !session.hiddenFromSidebar && session.purpose !== 'xresearch-research')
      .sort(compareSidebarPlacement)
      .map(s => s.id);
  }

  function cycleSession(direction) {
    const ids = getSortedVisibleSessionIds();
    if (ids.length === 0) return;
    const activeSessionId = getActiveSessionId();
    const i = Math.max(0, ids.indexOf(activeSessionId));
    const next = (i + direction + ids.length) % ids.length;
    selectSession(ids[next]);
  }

  function jumpToSessionByIndex(idx) {
    const ids = getSortedVisibleSessionIds();
    if (idx < 0 || idx >= ids.length) return;
    selectSession(ids[idx]);
  }

  let shortcutNoticeTimer = null;

  function showShortcutNotice(message, level = 'info') {
    if (!document || typeof document.createElement !== 'function' || !document.body) return;
    let el = typeof document.getElementById === 'function'
      ? document.getElementById('hub-shortcut-notice')
      : null;
    if (!el) {
      el = document.createElement('div');
      el.id = 'hub-shortcut-notice';
      Object.assign(el.style, {
        position: 'fixed',
        left: '50%',
        bottom: '28px',
        transform: 'translateX(-50%)',
        zIndex: '100000',
        maxWidth: 'min(520px, 90vw)',
        padding: '10px 15px',
        borderRadius: '10px',
        color: '#f5f5f7',
        font: '13px -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif',
        boxShadow: '0 8px 28px rgba(0,0,0,.35)',
        pointerEvents: 'none',
      });
      document.body.appendChild(el);
    }
    el.textContent = message;
    el.style.background = level === 'error' ? 'rgba(184, 47, 47, .96)' : 'rgba(34, 34, 38, .96)';
    el.style.display = 'block';
    if (shortcutNoticeTimer) clearTimeout(shortcutNoticeTimer);
    shortcutNoticeTimer = setTimeout(() => { el.style.display = 'none'; }, 2600);
  }

  async function forkSession(sourceSessionId) {
    if (!sourceSessionId) {
      showShortcutNotice('请先打开一个 Claude Code、Codex 或 DeepSeek 会话', 'error');
      return null;
    }
    const source = sessions.get(sourceSessionId);
    if (!supportsForkSession(source)) {
      showShortcutNotice('当前类型不支持分支，仅支持 Claude Code、Codex 和 DeepSeek', 'error');
      return null;
    }

    showShortcutNotice('正在创建独立分支会话…');
    try {
      const result = await ipcRenderer.invoke('fork-session', {
        sourceSessionId,
        sourceTitle: source.title || '',
      });
      if (!result || result.ok !== true) {
        showShortcutNotice((result && result.message) || '分支创建失败', 'error');
        return result || null;
      }
      showShortcutNotice(`已创建：${result.session && result.session.title ? result.session.title : '分支会话'}`);
      return result;
    } catch (err) {
      showShortcutNotice(`分支创建失败：${err && err.message ? err.message : String(err)}`, 'error');
      return null;
    }
  }

  function forkActiveSession() {
    return forkSession(getActiveSessionId());
  }

  function handleKeydown(e) {
    if (!(e.ctrlKey || e.metaKey)) return;
    const commandPaletteOpen = document && typeof document.getElementById === 'function'
      ? document.getElementById('hub-cmdk-overlay')
      : null;
    if (commandPaletteOpen && isElementOpen(commandPaletteOpen)
        && (e.key === 'k' || e.key === 'K') && !e.shiftKey && !e.altKey) {
      e.preventDefault();
      closeCommandPalette();
      return;
    }
    if (isBlockingModalOpen(document, { exceptIds: ['preview-quick-open'] })) return;

    const target = e.target;
    const insideQuickOpen = !!(target && (
      target.id === 'preview-quick-open-input'
      || (typeof target.closest === 'function' && target.closest('#preview-quick-open'))
    ));

    // Ctrl+O 是 Hub 级“打开路径”命令，在 xterm helper textarea 和浮动输入框
    // 聚焦时也必须可用；仅 quick-open 自己的输入框保留原按键，避免重置查询。
    if (!e.shiftKey && !e.altKey && (e.key === 'o' || e.key === 'O')) {
      if (insideQuickOpen || typeof openPreviewQuickOpen !== 'function') return;
      e.preventDefault();
      openPreviewQuickOpen();
      return;
    }

    const insidePreviewInputLayer = !!(target && typeof target.closest === 'function'
      && target.closest('#preview-quick-open, #preview-find-bar'));
    if (insidePreviewInputLayer) return;

    // #3 命令面板：兑现启动页宣传的 Ctrl+K（原为死键）。再次按下切换关闭。
    if (!e.shiftKey && !e.altKey && (e.key === 'k' || e.key === 'K')) {
      e.preventDefault();
      if (_cmdk && _cmdk.overlay.style.display === 'flex') closeCommandPalette();
      else openCommandPalette();
      return;
    }

    if (!e.shiftKey && e.altKey && e.key === 'Home') {
      e.preventDefault();
      escapeToHome();
      return;
    }

    if (!e.shiftKey && !e.altKey && (e.key === 'n' || e.key === 'N')) {
      e.preventDefault();
      createSession('claude');
      return;
    }

    if (!e.shiftKey && !e.altKey && (e.key === 'w' || e.key === 'W')) {
      e.preventDefault();
      const activeSessionId = getActiveSessionId();
      if (activeSessionId) void closeSessionRequest(activeSessionId);
      return;
    }

    if (!e.shiftKey && !e.altKey && (e.key === 'b' || e.key === 'B')) {
      e.preventDefault();
      toggleSidebar();
      return;
    }

    if (e.shiftKey && !e.altKey && (e.key === 'b' || e.key === 'B' || e.code === 'KeyB')) {
      e.preventDefault();
      if (typeof e.stopPropagation === 'function') e.stopPropagation();
      void forkActiveSession();
      return;
    }

    if (e.key === 'Tab') {
      e.preventDefault();
      cycleSession(e.shiftKey ? -1 : 1);
      return;
    }

    if (!e.shiftKey && !e.altKey && /^[1-9]$/.test(e.key)) {
      e.preventDefault();
      jumpToSessionByIndex(parseInt(e.key, 10) - 1);
      return;
    }

    if (!e.shiftKey && !e.altKey && (e.key === 'f' || e.key === 'F')) {
      e.preventDefault();
      openTerminalSearch();
      return;
    }

    if (e.shiftKey && !e.altKey && (e.key === 'c' || e.key === 'C' || e.code === 'KeyC')) {
      const cached = terminalCache.get(getActiveSessionId());
      const sel = cached && cached.terminal.getSelection();
      if (sel) {
        e.preventDefault();
        if (typeof copyText === 'function') void copyText(sel);
        else clipboard.writeText(sel);
      }
      return;
    }

    if (!e.shiftKey && !e.altKey && e.key === 'End') {
      const c = terminalCache.get(getActiveSessionId());
      if (isCodexOwnedTranscript(sessions.get(getActiveSessionId()), c?.terminal)) {
        if (!e.defaultPrevented) navigateCodexTranscript(sessions.get(getActiveSessionId()), c.terminal, 'bottom');
        e.preventDefault();
        return;
      }
      e.preventDefault();
      if (c) c.terminal.scrollToBottom();
      return;
    }

    if (!e.shiftKey && !e.altKey && e.key === 'Home') {
      const c = terminalCache.get(getActiveSessionId());
      if (isCodexOwnedTranscript(sessions.get(getActiveSessionId()), c?.terminal)) {
        if (!e.defaultPrevented) navigateCodexTranscript(sessions.get(getActiveSessionId()), c.terminal, 'top');
        e.preventDefault();
        return;
      }
      e.preventDefault();
      if (c) c.terminal.scrollToTop();
      return;
    }

    if (!e.shiftKey && !e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      if (e.defaultPrevented) return;
      const c = terminalCache.get(getActiveSessionId());
      if (!c || !c._minimap) return;
      const moved = e.key === 'ArrowUp' ? c._minimap.navPrev() : c._minimap.navNext();
      if (moved) e.preventDefault();
      return;
    }

    if (!e.shiftKey && !e.altKey && (e.key === '=' || e.key === '+')) {
      e.preventDefault(); setFontSize(getCurrentFontSize() + 1); return;
    }
    if (!e.shiftKey && !e.altKey && e.key === '-') {
      e.preventDefault(); setFontSize(getCurrentFontSize() - 1); return;
    }
    if (!e.shiftKey && !e.altKey && e.key === '0') {
      e.preventDefault(); setFontSize(16);
    }
  }

  // ===== #3 命令面板 (Cmd+K) =====
  // 居中 overlay：对当前会话标题模糊匹配跳转 + 新建各类会话 / 切侧栏 / 回主界面。
  // 键盘优先（↑↓ 选择、Enter 执行、Esc/点遮罩 关）。数据与回调全部复用已注入的
  // sessions / selectSession / ipcRenderer / toggleSidebar / escapeToHome，
  // DOM 与样式动态创建——不依赖 index.html / renderer.js / CSS 文件改动。
  let _cmdk = null;       // { overlay, input, list }
  let _cmdkItems = [];    // 过滤后条目 [{label, sub, run}]
  let _cmdkSel = 0;

  function _cmdkEsc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }

  function _cmdkEnsureStyle() {
    if (document.getElementById('hub-cmdk-style')) return;
    const css = [
      // 2026-08-26：原来是一套写死的深色 Apple 调色板，外加一组 .light 变体——
      // 但 .light 从来没有任何代码加过，是死分支。改成直接吃 Hub 的主题 token，
      // 命令面板就自动跟着 data-theme 走，不用再维护第二套色。
      '.hub-cmdk-overlay{position:fixed;inset:0;z-index:99999;display:flex;align-items:flex-start;justify-content:center;padding-top:12vh;background:rgba(var(--rgb-scrim),.45);}',
      '.hub-cmdk-panel{width:min(560px,92vw);max-height:64vh;display:flex;flex-direction:column;border-radius:var(--radius-lg);overflow:hidden;background:var(--surface-overlay);border:1px solid var(--border-mid);box-shadow:var(--shadow-lg);font-family:var(--font-sans);}',
      '.hub-cmdk-input{border:0;outline:0;padding:15px 18px;font-size:15px;background:transparent;color:var(--fg-strong);border-bottom:1px solid var(--border-mid);}',
      '.hub-cmdk-list{overflow-y:auto;padding:6px;}',
      '.hub-cmdk-item{display:flex;align-items:center;gap:10px;padding:9px 12px;border-radius:var(--radius-md);cursor:pointer;color:var(--fg-strong);font-size:13.5px;}',
      '.hub-cmdk-item .sub{margin-left:auto;font-size:11.5px;color:var(--fg-muted);}',
      '.hub-cmdk-item.sel{background:rgba(var(--rgb-info),.22);}',
      '.hub-cmdk-empty{padding:18px;text-align:center;color:var(--fg-muted);font-size:13px;}',
    ].join('\n');
    const st = document.createElement('style');
    st.id = 'hub-cmdk-style';
    st.textContent = css;
    document.head.appendChild(st);
  }

  function _cmdkBuild() {
    if (_cmdk) return _cmdk;
    _cmdkEnsureStyle();
    const overlay = document.createElement('div');
    overlay.className = 'hub-cmdk-overlay';
    overlay.id = 'hub-cmdk-overlay';
    const panel = document.createElement('div');
    panel.className = 'hub-cmdk-panel';
    const input = document.createElement('input');
    input.className = 'hub-cmdk-input';
    input.type = 'text';
    input.placeholder = '跳转会话 / 新建 / 命令…';
    input.spellcheck = false;
    const list = document.createElement('div');
    list.className = 'hub-cmdk-list';
    panel.appendChild(input); panel.appendChild(list); overlay.appendChild(panel);
    overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) closeCommandPalette(); });
    input.addEventListener('input', () => _cmdkRender(input.value));
    input.addEventListener('keydown', _cmdkKeydown);
    list.addEventListener('mousemove', (e) => {
      const it = e.target.closest('.hub-cmdk-item'); if (!it) return;
      _cmdkSel = Number(it.dataset.idx); _cmdkPaint();
    });
    list.addEventListener('click', (e) => {
      const it = e.target.closest('.hub-cmdk-item'); if (!it) return;
      _cmdkActivate(Number(it.dataset.idx));
    });
    document.body.appendChild(overlay);
    _cmdk = { overlay, input, list };
    return _cmdk;
  }

  function _cmdkActions() {
    const actions = [
      ...(typeof openPreviewQuickOpen === 'function'
        ? [{ label: '预览文件或路径', sub: 'Ctrl+O', run: () => openPreviewQuickOpen() }]
        : []),
      { label: '创建当前会话分支', sub: 'Ctrl+Shift+B', run: () => { void forkActiveSession(); } },
      { label: '新建 Claude 会话', sub: 'new', run: () => createSession('claude') },
      { label: '新建 Gemini 会话', sub: 'new', run: () => createSession('gemini') },
      { label: '新建 Codex 会话', sub: 'new', run: () => createSession('codex') },
      { label: '新建 Kimi Code 会话', sub: 'new', run: () => createSession('kimi') },
      { label: '新建 DeepSeek 会话', sub: 'new', run: () => createSession('deepseek') },
      { label: '新建 PowerShell 终端', sub: 'new', run: () => createSession('powershell') },
      { label: '切换侧栏', sub: 'cmd', run: () => toggleSidebar() },
      { label: '回到主界面', sub: 'cmd', run: () => escapeToHome() },
    ];
    return actions;
  }

  function _cmdkFuzzy(q, text) {
    if (!q) return true;
    q = q.toLowerCase(); text = String(text || '').toLowerCase();
    if (text.includes(q)) return true;
    let i = 0;
    for (const ch of text) { if (ch === q[i]) i++; if (i === q.length) return true; }
    return false;
  }

  function _cmdkRender(query) {
    const q = (query || '').trim();
    const sess = getSortedVisibleSessionIds()
      .map(id => sessions.get(id)).filter(Boolean)
      .map(s => ({ label: s.title || s.kind || s.id, sub: s.kind || 'session', run: () => selectSession(s.id) }));
    const all = sess.concat(_cmdkActions());
    _cmdkItems = all.filter(it => _cmdkFuzzy(q, it.label) || _cmdkFuzzy(q, it.sub));
    _cmdkSel = 0;
    const { list } = _cmdk;
    if (_cmdkItems.length === 0) {
      list.innerHTML = '<div class="hub-cmdk-empty">无匹配项</div>';
      return;
    }
    list.innerHTML = _cmdkItems.map((it, i) =>
      `<div class="hub-cmdk-item${i === 0 ? ' sel' : ''}" data-idx="${i}"><span>${_cmdkEsc(it.label)}</span><span class="sub">${_cmdkEsc(it.sub)}</span></div>`
    ).join('');
  }

  function _cmdkPaint() {
    const items = _cmdk.list.querySelectorAll('.hub-cmdk-item');
    items.forEach((el, i) => el.classList.toggle('sel', i === _cmdkSel));
    if (items[_cmdkSel]) items[_cmdkSel].scrollIntoView({ block: 'nearest' });
  }

  function _cmdkActivate(idx) {
    const it = _cmdkItems[idx];
    closeCommandPalette();
    if (it && typeof it.run === 'function') {
      try { it.run(); } catch (err) { console.warn('[cmdk] action failed:', err && err.message); }
    }
  }

  function _cmdkKeydown(e) {
    if (e.key === 'Escape') { e.preventDefault(); closeCommandPalette(); return; }
    if (e.key === 'ArrowDown') { e.preventDefault(); _cmdkSel = Math.min(_cmdkItems.length - 1, _cmdkSel + 1); _cmdkPaint(); return; }
    if (e.key === 'ArrowUp') { e.preventDefault(); _cmdkSel = Math.max(0, _cmdkSel - 1); _cmdkPaint(); return; }
    if (e.key === 'Enter') { e.preventDefault(); if (_cmdkItems.length) _cmdkActivate(_cmdkSel); return; }
  }

  function openCommandPalette() {
    const { overlay, input } = _cmdkBuild();
    overlay.classList.toggle('light', /light/i.test(document.body.className));
    overlay.style.display = 'flex';
    input.value = '';
    _cmdkRender('');
    setTimeout(() => { try { input.focus(); } catch {} }, 0);
  }

  function closeCommandPalette() {
    if (_cmdk) _cmdk.overlay.style.display = 'none';
  }

  function init() {
    document.addEventListener('keydown', handleKeydown, true);
  }

  return {
    init,
    getSortedVisibleSessionIds,
    cycleSession,
    jumpToSessionByIndex,
    handleKeydown,
    forkSession,
    forkActiveSession,
    openCommandPalette,
    closeCommandPalette,
  };
}

module.exports = { createKeyboardShortcuts };
