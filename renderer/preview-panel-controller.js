'use strict';

const path = require('path');
const { fileURLToPath, pathToFileURL } = require('url');
const { createPreviewFileWatchManager } = require('./preview-file-watch.js');
const { createPreviewFindController } = require('./preview-find.js');
const {
  createHeadingSlug,
  extractMarkdownOutline,
  formatPreviewReference,
} = require('./preview-outline.js');
const { isBlockingModalOpen } = require('./modal-layer-guard.js');
const { createPreviewImmersiveController } = require('./preview-immersive.js');

// webview 挂掉时 Chromium 只给一个 reason 码。2026-08-29 用户报「预览打不开」，
// 屏幕上只有 `预览进程异常退出：launch-failed` —— 这句话既不说明发生了什么，也不
// 提示怎么办，害得排查方向一开始就跑偏到「是不是刚合的代码改坏了」。
// 这里把 reason 翻译成「原因 + 该干什么」，原始码保留在括号里供排查。
const GUEST_FAILURE_HINTS = {
  'launch-failed': '渲染进程起不来。最常见的原因是 Hub 的 exe 在运行期间被换掉过'
    + '（升版本号会重建品牌化副本），这种情况重启 Hub 就能恢复；系统内存/提交内存'
    + '吃紧时也会这样。',
  oom: '渲染进程内存不足被系统回收。先关掉一些占内存的程序，再点 ⟳ 重试。',
  crashed: '渲染进程崩溃了，点 ⟳ 重试。',
  'integrity-failure': '渲染进程完整性校验失败，通常是安全软件拦截或 exe 被改动过，重启 Hub 再试。',
};

function describeGuestFailure(reason, fallback) {
  const code = String(reason == null ? '' : reason);
  if (!code) return fallback;
  const hint = GUEST_FAILURE_HINTS[code];
  return hint ? `${fallback}：${hint}（${code}）` : `${fallback}：${code}`;
}

const IMAGE_EXTENSIONS = new Set(['.svg', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp']);
const WEB_EXTENSIONS = new Set(['.html', '.htm']);
const MARKDOWN_EXTENSIONS = new Set(['.md', '.markdown']);
const TABLE_EXTENSIONS = new Set(['.csv', '.tsv']);
const NON_COPYABLE_EXTENSIONS = new Set([...IMAGE_EXTENSIONS, '.pdf']);
const QUICK_OPEN_DEBOUNCE_MS = 140;
const PREVIEW_SCROLL_CAPTURE_TIMEOUT_MS = 350;
const PREVIEW_COPY_TIMEOUT_MS = 2000;

function cleanPreviewTarget(value) {
  return String(value == null ? '' : value).replace(/[\0\r\n]+/g, '').trim();
}

function previewPathKey(value) {
  const target = cleanPreviewTarget(value);
  if (/^https?:\/\//i.test(target)) return `url:${target}`;
  const resolved = path.resolve(target);
  return `file:${process.platform === 'win32' ? resolved.toLowerCase() : resolved}`;
}

function previewTitle(value) {
  const target = cleanPreviewTarget(value);
  if (/^https?:\/\//i.test(target)) {
    try { return new URL(target).hostname || target; } catch (_) { return target; }
  }
  return path.basename(target) || target;
}

function previewExtension(value) {
  if (/^https?:\/\//i.test(String(value || ''))) return '';
  return path.extname(String(value || '')).toLowerCase();
}

function createPreviewPanelController({
  document,
  ipcRenderer,
  shell,
  clipboard,
  fs,
  marked,
  DOMPurify,
  getActiveSessionId,
  getActiveMeetingId,
  getActiveCwd,
  openPath,
  refitActiveTerminal,
  onReturnToConversation,
  onCopyFeedback,
  onBeforeOpen,
}) {
  const previewPanelEl = document.getElementById('preview-panel');
  const previewTitleEl = document.getElementById('preview-title');
  const previewBodyEl = document.getElementById('preview-body');
  const previewSplitterEl = document.getElementById('preview-splitter');
  const previewZoomLabelEl = document.getElementById('preview-zoom-label');
  const previewTabsEl = document.getElementById('preview-tabs');
  const previewLayoutSplitEl = document.getElementById('preview-layout-split');
  const previewLayoutFullEl = document.getElementById('preview-layout-full');
  const quickOpenEl = document.getElementById('preview-quick-open');
  const quickOpenInputEl = document.getElementById('preview-quick-open-input');
  const quickOpenResultsEl = document.getElementById('preview-quick-open-results');
  const quickOpenStatusEl = document.getElementById('preview-quick-open-status');
  const quickOpenModeHintEl = document.getElementById('preview-quick-open-mode-hint');
  const outlineToggleEl = document.getElementById('preview-outline-toggle');
  const outlineEl = document.getElementById('preview-outline');
  const outlineTitleEl = document.getElementById('preview-outline-title');
  const outlineCopyEl = document.getElementById('preview-outline-copy');
  const outlineListEl = document.getElementById('preview-outline-list');
  const outlineEmptyEl = document.getElementById('preview-outline-empty');
  const outlineCloseEl = document.getElementById('preview-outline-close');
  const gotoLineFormEl = document.getElementById('preview-goto-line-form');
  const gotoLineInputEl = document.getElementById('preview-goto-line-input');
  const contextPreviewStates = new Map();
  const fileWatchManager = createPreviewFileWatchManager({
    fs,
    onError: (error, target) => {
      console.debug('[preview-watch] unavailable:', target, error && error.message);
    },
  });
  const previewFind = createPreviewFindController({
    document,
    previewBody: previewBodyEl,
  });
  const immersive = createPreviewImmersiveController({
    document, ipcRenderer,
    onError: message => showPreviewNotice(message, 'error'),
    onExit: () => { syncPreviewLayoutControls(); refitActiveTerminal(); },
  });

  let currentContextKey = null;
  let previewSourcePanel = null;
  let currentPreviewPath = null;
  let previewIsFullscreen = true;
  let previewSplitRatio = 0.5;
  let previewZoomLevel = 1.0;
  let previewRenderToken = 0;
  let navigationToken = 0;
  let nextTabId = 1;
  let quickOpenItems = [];
  let quickOpenSelectedIndex = 0;
  let quickOpenSearchToken = 0;
  let quickOpenTimer = null;
  let quickOpenReturnFocus = null;
  let quickOpenPinnedIntent = false;
  let previewNoticeTimer = null;
  let outlineEntries = [];
  let outlineActiveIndex = -1;
  let outlineScrollFrame = 0;
  let outlineHighlightTimer = null;
  let outlineHighlightedElement = null;

  function getActiveContextKey() {
    const sessionId = getActiveSessionId && getActiveSessionId();
    if (sessionId) return `session:${sessionId}`;
    const meetingId = getActiveMeetingId && getActiveMeetingId();
    if (meetingId) return `meeting:${meetingId}`;
    return 'global';
  }

  function makeContextState() {
    return {
      tabs: [],
      activeTabId: null,
      isFullscreen: true,
      splitRatio: 0.5,
      outlineOpen: false,
    };
  }

  function getContextState(key = currentContextKey, create = false) {
    if (!key) return null;
    let state = contextPreviewStates.get(key);
    if (!state && create) {
      state = makeContextState();
      contextPreviewStates.set(key, state);
    }
    return state || null;
  }

  function getActiveTab(state = getContextState()) {
    if (!state || !state.activeTabId) return null;
    return state.tabs.find(tab => tab.id === state.activeTabId) || null;
  }

  function isTabPinned(tab) {
    return !tab || tab.pinned !== false;
  }

  function createTabRecord(target, { pinned = true, id = null } = {}) {
    return {
      id: id || 'preview-tab-' + nextTabId++,
      path: target,
      title: previewTitle(target),
      pinned: !!pinned,
      zoomLevel: 1,
      scroll: null,
      kind: null,
      openedAt: Date.now(),
      stale: false,
      missing: false,
      changeVersion: 0,
      loadError: null,
      watchError: null,
      outline: [],
      outlineActiveAnchor: null,
      lineCount: 0,
      referenceLine: 0,
      lineReferenceExact: true,
      _disposed: false,
    };
  }

  function disposeTab(tab) {
    if (!tab) return;
    tab._disposed = true;
    try { tab._watchSubscription?.dispose?.(); } catch (_) {}
    tab._watchSubscription = null;
  }

  function replaceTemporaryTab(tab, target) {
    const id = tab.id;
    disposeTab(tab);
    Object.assign(tab, createTabRecord(target, { pinned: false, id }));
    return tab;
  }

  function disposeContextState(state) {
    if (!state) return;
    for (const tab of state.tabs || []) disposeTab(tab);
  }

  function updateTabChangeUI(tab = getActiveTab()) {
    const badge = document.getElementById('preview-change-badge');
    const reload = document.getElementById('preview-reload');
    const errorState = !!(tab && (tab.watchError || tab.loadError));
    const changed = !!(tab && (tab.stale || tab.missing || errorState));
    const stateName = !tab ? '' : tab.missing ? 'missing' : errorState ? 'error' : 'stale';
    if (badge) {
      badge.hidden = !changed;
      badge.dataset.state = stateName;
      badge.textContent = !tab ? '' : tab.missing ? '已移除' : tab.loadError ? '读取异常' : tab.watchError ? '监听异常' : '已更新';
      badge.title = !changed ? '' : tab.missing
        ? '文件已移除，等待重新加载'
        : tab.loadError
          ? `文件读取异常：${tab.loadError}`
          : tab.watchError
            ? `文件监听异常，正在重试：${tab.watchError}`
            : '文件已更新，点击重新加载';
      if (changed) badge.setAttribute('aria-label', badge.title);
      else badge.removeAttribute('aria-label');
    }
    if (reload) {
      reload.disabled = !tab;
      reload.classList.toggle('attention', changed);
    }
  }

  function handleWatchedFileChange(tab, change) {
    if (!tab || tab._disposed) return;
    if (change && Object.prototype.hasOwnProperty.call(change, 'watchError')) {
      tab.watchError = change.watchError || null;
      const currentState = getContextState();
      if (currentState && currentState.tabs.includes(tab)) {
        renderTabs();
        if (currentState.activeTabId === tab.id) updateTabChangeUI(tab);
      }
      return;
    }
    tab.changeVersion = (Number(tab.changeVersion) || 0) + 1;
    tab.stale = true;
    tab.missing = change && change.exists === false;
    tab.loadError = change && change.exists === null ? (change.error || change.errorCode || '文件无法读取') : null;
    tab.change = change || null;
    const state = getContextState();
    if (state && state.tabs.includes(tab)) {
      renderTabs();
      if (state.activeTabId === tab.id) updateTabChangeUI(tab);
    }
  }

  function ensureTabWatch(tab) {
    if (!tab || tab._watchSubscription || /^https?:\/\//i.test(tab.path) || !path.isAbsolute(tab.path)) return;
    tab._watchSubscription = fileWatchManager.subscribe(tab.path, change => handleWatchedFileChange(tab, change));
  }

  function prepareTabForLoad(tab) {
    if (!tab) return false;
    if (/^https?:\/\//i.test(tab.path)) {
      tab.missing = false;
      tab.loadError = null;
      return true;
    }
    try {
      fs.statSync(tab.path);
      tab.missing = false;
      tab.loadError = null;
      return true;
    } catch (error) {
      const code = String(error && error.code || 'unknown');
      const missing = code === 'ENOENT' || code === 'ENOTDIR';
      tab.stale = true;
      tab.missing = missing;
      tab.loadError = missing ? null : String(error && error.message || error);
      return false;
    }
  }

  function updateSplitterA11y(ratio = previewSplitRatio) {
    if (!previewSplitterEl) return;
    const leftPercent = Math.round(Math.max(0.1, Math.min(0.9, Number(ratio) || 0.5)) * 100);
    previewSplitterEl.setAttribute('aria-valuenow', String(leftPercent));
    previewSplitterEl.setAttribute(
      'aria-valuetext',
      '左侧 ' + leftPercent + '%，预览 ' + (100 - leftPercent) + '%',
    );
  }

  function layoutSource(id) {
    const panel = id ? document.getElementById(id) : null;
    // Session panes share one horizontal slot alongside the preview. Resizing
    // its inner terminal would instead shrink that pane vertically.
    return id === 'terminal-panel' ? panel?.closest?.('.session-workspace') || panel : panel;
  }

  function applySplitWidths(ratio) {
    const src = layoutSource(previewSourcePanel);
    if (!ratio) {
      if (src) src.style.flex = '';
      previewPanelEl.style.flex = '';
      updateSplitterA11y();
      return;
    }
    const r = Math.max(0.1, Math.min(0.9, ratio));
    if (src) src.style.flex = String(r);
    previewPanelEl.style.flex = String(1 - r);
    updateSplitterA11y(r);
  }

  function resetPreviewLayoutEffects() {
    for (const id of ['terminal-panel', 'meeting-room-panel']) {
      const el = layoutSource(id);
      if (el) el.style.flex = '';
    }
    previewPanelEl.style.flex = '';
  }

  function setPreviewZoom(level, { persist = true } = {}) {
    previewZoomLevel = Math.max(0.25, Math.min(5.0, Number(level) || 1));
    previewBodyEl.style.zoom = previewZoomLevel;
    const webview = previewBodyEl.querySelector('webview');
    if (webview) {
      try { webview.setZoomFactor(previewZoomLevel); } catch (_) {}
    }
    previewZoomLabelEl.textContent = `${Math.round(previewZoomLevel * 100)}%`;
    if (persist) {
      const tab = getActiveTab();
      if (tab) tab.zoomLevel = previewZoomLevel;
    }
  }

  function resetPreviewZoom(options) {
    setPreviewZoom(1.0, options);
  }

  async function capturePreviewScroll() {
    const webview = previewBodyEl.querySelector('webview');
    if (webview && typeof webview.executeJavaScript === 'function') {
      try {
        let timeoutId = null;
        const request = Promise.resolve(webview.executeJavaScript(`(() => {
          const de = document.documentElement || {};
          const body = document.body || {};
          return {
            x: window.scrollX || de.scrollLeft || body.scrollLeft || 0,
            y: window.scrollY || de.scrollTop || body.scrollTop || 0
          };
        })()`)).catch(() => null);
        const pos = await Promise.race([
          request,
          new Promise(resolve => { timeoutId = setTimeout(() => resolve(null), PREVIEW_SCROLL_CAPTURE_TIMEOUT_MS); }),
        ]);
        if (timeoutId) clearTimeout(timeoutId);
        if (!pos) throw new Error('webview scroll capture timed out');
        return {
          type: 'webview',
          x: Math.max(0, Number(pos && pos.x) || 0),
          y: Math.max(0, Number(pos && pos.y) || 0),
        };
      } catch (error) {
        console.debug('[preview] webview scroll capture skipped:', error && error.message);
      }
    }
    return {
      type: 'body',
      x: Math.max(0, Number(previewBodyEl.scrollLeft) || 0),
      y: Math.max(0, Number(previewBodyEl.scrollTop) || 0),
    };
  }

  async function captureActiveTabState(state = getContextState()) {
    const tab = getActiveTab(state);
    if (!tab || previewPanelEl.style.display !== 'flex') return;
    const tabId = tab.id;
    const scroll = await capturePreviewScroll();
    const stillPresent = state.tabs.find(candidate => candidate.id === tabId);
    if (!stillPresent) return;
    stillPresent.scroll = scroll;
    stillPresent.zoomLevel = previewZoomLevel;
  }

  async function savePreviewState(options = {}) {
    const state = getContextState();
    if (!state || !getActiveTab(state)) return;
    state.isFullscreen = previewIsFullscreen;
    state.splitRatio = previewSplitRatio;
    const capture = captureActiveTabState(state);
    if (options.nonBlocking === true) {
      // Session navigation must react immediately. The webview scroll probe is
      // already bounded, but waiting for it before painting the selected row
      // made a healthy click look dead for up to 350ms. The request is issued
      // before the preview DOM is cleared and updates the retained state later.
      void Promise.resolve(capture).catch(error => {
        console.debug('[preview] deferred state capture skipped:', error && error.message);
      });
      return;
    }
    await capture;
  }

  function restoreSourcePanelVisibility() {
    if (!previewSourcePanel) return;
    const src = document.getElementById(previewSourcePanel);
    if (src) src.style.display = previewSourcePanel === 'terminal-panel' ? '' : 'flex';
    previewSourcePanel = null;
  }

  function resetPreviewHeader() {
    currentPreviewPath = null;
    previewTitleEl.textContent = 'Preview';
    previewTitleEl.title = '';
    const badge = document.getElementById('preview-file-badge');
    const meta = document.getElementById('preview-file-meta');
    if (badge) badge.textContent = '--';
    if (meta) meta.textContent = '';
    updateActionAvailability();
  }

  function clearPreviewUI() {
    immersive.exit();
    closeQuickOpen({ restoreFocus: false });
    previewFind.close({ restoreFocus: false, keepQuery: false });
    clearOutlineUI();
    clearPreviewNotice();
    previewRenderToken += 1;
    navigationToken += 1;
    previewPanelEl.style.display = 'none';
    previewPanelEl.classList.remove('preview-split');
    previewSplitterEl.style.display = 'none';
    previewIsFullscreen = true;
    previewSplitRatio = 0.5;
    previewBodyEl.innerHTML = '';
    if (previewTabsEl) previewTabsEl.innerHTML = '';
    resetPreviewLayoutEffects();
    resetPreviewZoom({ persist: false });
    resetPreviewHeader();
    syncPreviewLayoutControls();
    previewSourcePanel = null;
    currentContextKey = null;
  }

  function setPreviewBodyLayout(alignItems, justifyContent) {
    previewBodyEl.style.alignItems = alignItems;
    previewBodyEl.style.justifyContent = justifyContent;
  }

  function restoreBodyScroll(scroll, token, tabId) {
    if (!scroll) return;
    requestAnimationFrame(() => {
      const state = getContextState();
      if (token !== previewRenderToken || !state || state.activeTabId !== tabId) return;
      previewBodyEl.scrollLeft = Math.max(0, Number(scroll.x) || 0);
      previewBodyEl.scrollTop = Math.max(0, Number(scroll.y) || 0);
    });
  }

  function restoreWebviewScroll(webview, scroll, token) {
    if (!scroll || !webview || typeof webview.executeJavaScript !== 'function') return;
    const x = Math.max(0, Number(scroll.x) || 0);
    const y = Math.max(0, Number(scroll.y) || 0);
    const js = `window.scrollTo(${JSON.stringify(x)}, ${JSON.stringify(y)});`;
    const apply = () => {
      if (token !== previewRenderToken) return;
      try {
        const result = webview.executeJavaScript(js);
        if (result && typeof result.catch === 'function') {
          void result.catch(error => console.debug('[preview] webview scroll restore skipped:', error && error.message));
        }
      } catch (error) {
        console.debug('[preview] webview scroll restore skipped:', error && error.message);
      }
    };
    try { webview.addEventListener('dom-ready', apply, { once: true }); } catch (_) {}
    try { webview.addEventListener('did-finish-load', apply, { once: true }); } catch (_) {}
    setTimeout(apply, 80);
    setTimeout(apply, 300);
  }

  function settleAsyncTabLoad(tab, changeVersion, token, error = null) {
    if (!tab || tab._disposed) return;
    const state = getContextState();
    if (token !== previewRenderToken || !state || state.activeTabId !== tab.id || !state.tabs.includes(tab)) return;
    if (error) {
      tab.stale = true;
      tab.loadError = String(error);
    } else if (!tab.missing && (Number(tab.changeVersion) || 0) === changeVersion) {
      tab.stale = false;
      tab.change = null;
      tab.loadError = null;
    }
    if (state.tabs.includes(tab)) {
      renderTabs();
      if (state.activeTabId === tab.id) {
        updateTabChangeUI(tab);
        if (error && token === previewRenderToken) showPreviewError(error, token);
      }
    }
  }

  function makeWebview(src, scroll, token, { onLoad, onError } = {}) {
    const webview = document.createElement('webview');
    webview.preload = pathToFileURL(path.join(__dirname, 'preview-webview-preload.js')).href;
    webview.style.cssText = 'width:100%;height:100%;border:none;';
    setPreviewBodyLayout('stretch', 'stretch');
    const isCurrentWebview = () => (
      token === previewRenderToken
      && webview.isConnected
      && previewBodyEl.querySelector('webview') === webview
    );
    webview.addEventListener('ipc-message', (event) => {
      if (!isCurrentWebview()) return;
      if (event.channel === 'preview-copy-feedback') {
        const feedback = event.args && event.args[0] || {};
        if (typeof onCopyFeedback === 'function') onCopyFeedback(feedback);
        else showPreviewNotice(feedback.message || (feedback.ok ? '已复制' : '复制失败'), feedback.ok ? 'success' : 'error');
        return;
      }
      if (event.channel !== 'preview-shortcut') return;
      const action = event.args && event.args[0];
      if (action === 'find') previewFind.open();
      else if (action === 'open-path') openQuickOpen();
      else if (action === 'find-next' && previewFind.isOpen()) previewFind.next(Number(event.args && event.args[1]) < 0 ? -1 : 1);
      else if (action === 'escape' && immersive.isActive()) immersive.exit();
      else if (action === 'escape' && previewFind.isOpen()) previewFind.close();
    });
    try {
      webview.addEventListener('dom-ready', () => {
        if (isCurrentWebview()) previewFind.refresh();
      }, { once: true });
    } catch (_) {}
    try {
      webview.addEventListener('did-finish-load', () => {
        if (!isCurrentWebview()) return;
        previewFind.refresh();
        onLoad?.();
      }, { once: true });
    } catch (_) {}
    try {
      webview.addEventListener('did-fail-load', (event) => {
        if (!isCurrentWebview()) return;
        if (event && (event.isMainFrame === false || Number(event.errorCode) === -3)) return;
        onError?.(event && (event.errorDescription || `加载错误 ${event.errorCode}`) || 'webview 加载失败');
      });
    } catch (_) {}
    const reportGuestFailure = (event, fallback) => {
      if (!isCurrentWebview()) return;
      const details = event && (event.details || event.detail || event);
      const reason = details && (details.reason || details.exitCode);
      onError?.(describeGuestFailure(reason, fallback));
    };
    try {
      webview.addEventListener('render-process-gone', event => {
        reportGuestFailure(event, '预览进程异常退出');
      });
    } catch (_) {}
    try {
      webview.addEventListener('destroyed', event => {
        reportGuestFailure(event, '预览进程已销毁');
      });
    } catch (_) {}
    previewBodyEl.appendChild(webview);
    previewFind.attachWebview(webview);
    webview.src = src;
    try { webview.setZoomFactor(previewZoomLevel); } catch (_) {}
    restoreWebviewScroll(webview, scroll, token);
    return webview;
  }

  function showPreviewError(message, token = previewRenderToken) {
    if (token !== previewRenderToken) return;
    previewBodyEl.innerHTML = '';
    const error = document.createElement('div');
    error.className = 'preview-markdown';
    error.style.color = 'var(--text-secondary)';
    error.textContent = `加载失败：${String(message || 'unknown error')}`;
    previewBodyEl.appendChild(error);
  }

  function clearPreviewNotice() {
    if (previewNoticeTimer) {
      clearTimeout(previewNoticeTimer);
      previewNoticeTimer = null;
    }
    const notice = document.getElementById('preview-notice');
    if (notice) notice.remove();
  }

  function showPreviewNotice(message, level = 'error') {
    clearPreviewNotice();
    const notice = document.createElement('div');
    notice.id = 'preview-notice';
    notice.className = 'preview-notice';
    notice.dataset.level = level;
    notice.setAttribute('role', level === 'error' ? 'alert' : 'status');
    notice.setAttribute('aria-live', level === 'error' ? 'assertive' : 'polite');
    notice.setAttribute('aria-atomic', 'true');
    notice.textContent = String(message || '操作失败');
    document.body.appendChild(notice);
    previewNoticeTimer = setTimeout(() => {
      notice.remove();
      previewNoticeTimer = null;
    }, 2800);
  }

  async function runAsyncAction(action, failureLabel = '操作失败') {
    try {
      return await action();
    } catch (error) {
      console.warn(`[preview] ${failureLabel}:`, error);
      showPreviewNotice(`${failureLabel}：${String(error && error.message || error)}`, 'error');
      return null;
    }
  }

  async function readPreviewFile(filePath) {
    try {
      return await ipcRenderer.invoke('read-file', filePath);
    } catch (error) {
      return { error: String(error && error.message || error) };
    }
  }

  function updateFileMetadata(filePath) {
    const isUrl = /^https?:\/\//i.test(filePath);
    const badgeEl = document.getElementById('preview-file-badge');
    const metaEl = document.getElementById('preview-file-meta');
    previewTitleEl.textContent = previewTitle(filePath);
    previewTitleEl.title = filePath;
    if (!badgeEl || !metaEl) return;
    if (isUrl) {
      badgeEl.textContent = 'URL';
      metaEl.textContent = '';
      return;
    }
    const ext = previewExtension(filePath);
    badgeEl.textContent = ext ? ext.slice(1).toUpperCase().slice(0, 4) : '--';
    try {
      const size = fs.statSync(filePath).size;
      if (size < 1024) metaEl.textContent = `${size} B`;
      else if (size < 1024 * 1024) metaEl.textContent = `${(size / 1024).toFixed(1)} KB`;
      else metaEl.textContent = `${(size / 1024 / 1024).toFixed(1)} MB`;
    } catch (_) {
      metaEl.textContent = '';
    }
  }

  function updateActionAvailability() {
    const isUrl = /^https?:\/\//i.test(String(currentPreviewPath || ''));
    const ext = previewExtension(currentPreviewPath);
    const copyContent = document.getElementById('preview-copy-content');
    const copyPath = document.getElementById('preview-copy-path');
    const showInFolder = document.getElementById('preview-show-in-folder');
    const openExternal = document.getElementById('preview-open-external');
    const findButton = document.getElementById('preview-find-toggle');
    if (copyContent) copyContent.disabled = !currentPreviewPath || NON_COPYABLE_EXTENSIONS.has(ext);
    if (copyPath) copyPath.disabled = !currentPreviewPath;
    if (showInFolder) showInFolder.disabled = !currentPreviewPath || isUrl;
    if (openExternal) openExternal.disabled = !currentPreviewPath;
    if (findButton) findButton.disabled = !currentPreviewPath;
    updateTabChangeUI(currentPreviewPath ? getActiveTab() : null);
  }

  function renderTabs() {
    if (!previewTabsEl) return;
    const focusedElement = document.activeElement;
    const restoreTabFocus = !!(focusedElement && previewTabsEl.contains?.(focusedElement));
    const focusedTabId = restoreTabFocus
      ? (focusedElement.closest?.('[data-tab-id]')?.dataset?.tabId
        || focusedElement.closest?.('[data-close-tab-id]')?.dataset?.closeTabId
        || null)
      : null;
    previewTabsEl.innerHTML = '';
    previewBodyEl.removeAttribute('aria-labelledby');
    const state = getContextState();
    if (!state) return;
    for (const tab of state.tabs) {
      const active = tab.id === state.activeTabId;
      const hasError = !!(tab.watchError || tab.loadError);
      const temporary = !isTabPinned(tab);
      const shell = document.createElement('div');
      shell.className = `preview-tab-shell${active ? ' active' : ''}${temporary ? ' temporary' : ''}${tab.stale ? ' stale' : ''}${tab.missing ? ' missing' : ''}${hasError ? ' watch-error' : ''}`;
      const tabButton = document.createElement('button');
      tabButton.type = 'button';
      tabButton.className = `preview-tab${tab.id === state.activeTabId ? ' active' : ''}`;
      tabButton.dataset.tabId = tab.id;
      tabButton.id = `preview-tab-node-${tab.id}`;
      tabButton.title = tab.path + (temporary ? '\n临时预览：打开其他路径时会复用；双击或 Ctrl+Enter 固定' : '');
      tabButton.setAttribute('role', 'tab');
      tabButton.setAttribute('aria-selected', active ? 'true' : 'false');
      tabButton.setAttribute('aria-controls', 'preview-body');
      tabButton.setAttribute('aria-label', `${tab.title}${temporary ? '，临时预览，按 Ctrl+Enter 固定' : '，已固定'}${tab.missing ? '，文件已移除' : tab.loadError ? '，文件读取异常' : tab.watchError ? '，文件监听异常' : tab.stale ? '，文件已更新' : ''}`);
      tabButton.tabIndex = active ? 0 : -1;
      if (active) previewBodyEl.setAttribute('aria-labelledby', tabButton.id);

      const title = document.createElement('span');
      title.className = 'preview-tab-title';
      title.textContent = tab.title;
      tabButton.appendChild(title);
      if (temporary) {
        const previewBadge = document.createElement('span');
        previewBadge.className = 'preview-tab-preview-badge';
        previewBadge.textContent = '临时';
        previewBadge.setAttribute('aria-hidden', 'true');
        tabButton.appendChild(previewBadge);
      }
      if (tab.stale || tab.missing || hasError) {
        const stateMarker = document.createElement('span');
        stateMarker.className = 'preview-tab-state';
        stateMarker.setAttribute('aria-hidden', 'true');
        tabButton.appendChild(stateMarker);
      }
      let pin = null;
      if (temporary) {
        pin = document.createElement('button');
        pin.type = 'button';
        pin.className = 'preview-tab-pin';
        pin.dataset.pinTabId = tab.id;
        pin.title = '固定此预览';
        pin.setAttribute('aria-label', `固定 ${tab.title}`);
        pin.tabIndex = -1;
        pin.innerHTML = '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="m14 4 6 6-3 1-4 4-1 5-2-2-4 4-1-1 4-4-2-2 5-1 4-4z"/></svg>';
      }
      const close = document.createElement('button');
      close.type = 'button';
      close.className = 'preview-tab-close';
      close.dataset.closeTabId = tab.id;
      close.title = '关闭预览';
      close.setAttribute('aria-label', `关闭 ${tab.title}`);
      close.tabIndex = -1;
      close.textContent = '×';
      shell.append(...(pin ? [tabButton, pin, close] : [tabButton, close]));
      previewTabsEl.appendChild(shell);
    }
    if (restoreTabFocus) {
      const nextFocusId = state.tabs.some(tab => tab.id === focusedTabId)
        ? focusedTabId
        : state.activeTabId;
      if (nextFocusId) focusPreviewTab(nextFocusId);
    }
  }

  function focusPreviewTab(tabId) {
    if (!previewTabsEl) return;
    const tab = Array.from(previewTabsEl.querySelectorAll('[data-tab-id]'))
      .find(element => element.dataset.tabId === tabId);
    if (tab && typeof tab.focus === 'function') tab.focus();
  }

  function announcePreviewAction(message) {
    const liveStatus = document.getElementById('preview-action-status');
    if (!liveStatus) return;
    liveStatus.textContent = '';
    requestAnimationFrame(() => { liveStatus.textContent = String(message || ''); });
  }

  function pinPreviewTab(tabId = getContextState()?.activeTabId) {
    const state = getContextState();
    const tab = state && state.tabs.find(candidate => candidate.id === tabId);
    if (!tab || isTabPinned(tab)) return false;
    tab.pinned = true;
    renderTabs();
    announcePreviewAction(tab.title + ' 已固定');
    return true;
  }

  function outlineModeForTab(tab = getActiveTab()) {
    if (!tab) return null;
    const ext = previewExtension(tab.path);
    if (MARKDOWN_EXTENSIONS.has(ext)) return 'markdown';
    if (tab.kind === 'text' && !TABLE_EXTENSIONS.has(ext) && Number(tab.lineCount) > 0) return 'line';
    return null;
  }

  function setOutlineActiveIndex(index, { focus = false, reveal = false } = {}) {
    if (outlineEntries.length === 0) {
      outlineActiveIndex = -1;
      return;
    }
    outlineActiveIndex = Math.max(0, Math.min(outlineEntries.length - 1, Number(index) || 0));
    const state = getContextState();
    const tab = getActiveTab(state);
    if (tab) tab.outlineActiveAnchor = outlineEntries[outlineActiveIndex].anchor;
    const buttons = outlineListEl
      ? Array.from(outlineListEl.querySelectorAll('[data-outline-index]'))
      : [];
    buttons.forEach((button, buttonIndex) => {
      const active = buttonIndex === outlineActiveIndex;
      button.classList.toggle('active', active);
      button.tabIndex = active ? 0 : -1;
      if (active) button.setAttribute('aria-current', 'location');
      else button.removeAttribute('aria-current');
    });
    const activeButton = buttons[outlineActiveIndex];
    if (reveal) activeButton?.scrollIntoView?.({ block: 'nearest' });
    if (focus) activeButton?.focus?.();
    if (outlineCopyEl) outlineCopyEl.disabled = false;
  }

  function renderOutlineEntries(tab) {
    outlineEntries = Array.isArray(tab && tab.outline) ? tab.outline : [];
    if (outlineListEl) outlineListEl.innerHTML = '';
    if (outlineEntries.length === 0) {
      outlineActiveIndex = -1;
      return;
    }
    const preferred = String(tab.outlineActiveAnchor || '');
    const preferredIndex = outlineEntries.findIndex(entry => entry.anchor === preferred);
    outlineActiveIndex = preferredIndex >= 0 ? preferredIndex : 0;
    if (outlineListEl) {
      outlineEntries.forEach((entry, index) => {
        const item = document.createElement('li');
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'preview-outline-item';
        button.dataset.outlineIndex = String(index);
        button.dataset.outlineLevel = String(entry.level);
        button.tabIndex = index === outlineActiveIndex ? 0 : -1;
        button.setAttribute('aria-label', 'H' + entry.level + ' ' + entry.text + '，源文件第 ' + entry.line + ' 行');
        button.style.setProperty?.('--outline-depth', String(Math.max(0, Number(entry.level) - 1)));
        const level = document.createElement('span');
        level.className = 'preview-outline-item-level';
        level.textContent = 'H' + entry.level;
        level.setAttribute('aria-hidden', 'true');
        const text = document.createElement('span');
        text.className = 'preview-outline-item-text';
        text.textContent = entry.text;
        const line = document.createElement('span');
        line.className = 'preview-outline-item-line';
        line.textContent = 'L' + entry.line;
        button.append(level, text, line);
        item.appendChild(button);
        outlineListEl.appendChild(item);
      });
    }
    setOutlineActiveIndex(outlineActiveIndex);
  }

  function syncOutlineUI(tab = getActiveTab()) {
    const state = getContextState();
    const mode = outlineModeForTab(tab);
    const available = !!mode;
    const open = !!(available && state && state.outlineOpen);
    if (outlineToggleEl) {
      outlineToggleEl.disabled = !available;
      outlineToggleEl.setAttribute('aria-expanded', open ? 'true' : 'false');
      outlineToggleEl.title = mode === 'markdown'
        ? 'Markdown 文档大纲 (Ctrl+Shift+O)'
        : mode === 'line'
          ? '行号跳转 (Ctrl+Shift+O)'
          : '当前预览没有大纲或行号';
      const outlineLabel = mode === 'markdown'
        ? (open ? '关闭 Markdown 文档大纲' : '打开 Markdown 文档大纲')
        : mode === 'line'
          ? (open ? '关闭行号跳转' : '打开行号跳转')
          : '当前预览没有大纲或行号';
      outlineToggleEl.setAttribute('aria-label', outlineLabel);
    }
    if (outlineEl) outlineEl.hidden = !open;
    if (outlineTitleEl) outlineTitleEl.textContent = mode === 'line' ? '行号跳转' : '文档大纲';
    if (outlineCloseEl) {
      const closeLabel = mode === 'line' ? '关闭行号跳转' : '关闭文档大纲';
      outlineCloseEl.title = closeLabel;
      outlineCloseEl.setAttribute('aria-label', closeLabel);
    }
    if (outlineListEl) outlineListEl.hidden = mode !== 'markdown';
    if (gotoLineFormEl) gotoLineFormEl.hidden = mode !== 'line';
    if (gotoLineInputEl && mode === 'line') {
      gotoLineInputEl.max = String(Math.max(1, Number(tab.lineCount) || 1));
      gotoLineInputEl.value = String(Math.max(1, Number(tab.referenceLine) || 1));
    }
    if (outlineEmptyEl) {
      outlineEmptyEl.hidden = mode !== 'markdown' || outlineEntries.length > 0;
      outlineEmptyEl.textContent = mode === 'markdown'
        ? '此 Markdown 文档没有可用标题'
        : '';
    }
    if (outlineCopyEl) {
      outlineCopyEl.disabled = mode === 'markdown'
        ? outlineActiveIndex < 0
        : mode === 'line'
          ? !(Number(tab && tab.referenceLine) > 0) || tab.lineReferenceExact === false
          : true;
      const copyLabel = mode === 'line' && tab && tab.lineReferenceExact === false
        ? '格式化预览不能复制源文件行号引用'
        : mode === 'markdown'
          ? '复制当前标题引用'
          : '复制当前行号引用';
      outlineCopyEl.title = copyLabel;
      outlineCopyEl.setAttribute('aria-label', copyLabel);
    }
  }

  function clearOutlineForRender(tab) {
    if (outlineScrollFrame) cancelAnimationFrame(outlineScrollFrame);
    outlineScrollFrame = 0;
    if (outlineHighlightTimer) clearTimeout(outlineHighlightTimer);
    outlineHighlightTimer = null;
    if (outlineHighlightedElement) {
      outlineHighlightedElement.classList.remove('preview-heading-target', 'preview-line-target');
      outlineHighlightedElement = null;
    }
    outlineEntries = [];
    outlineActiveIndex = -1;
    if (tab) {
      tab.outline = [];
      tab.lineCount = 0;
      tab.lineReferenceExact = true;
    }
    if (outlineListEl) outlineListEl.innerHTML = '';
    if (outlineEmptyEl) outlineEmptyEl.hidden = true;
    if (gotoLineFormEl) gotoLineFormEl.hidden = true;
    if (outlineCopyEl) outlineCopyEl.disabled = true;
    syncOutlineUI(tab);
  }

  function installMarkdownOutline(tab, markdown, source, extracted = []) {
    const headings = markdown && typeof markdown.querySelectorAll === 'function'
      ? Array.from(markdown.querySelectorAll('h1, h2, h3, h4, h5, h6'))
      : [];
    const usedAnchors = new Map();
    const entries = [];
    headings.forEach((heading, index) => {
      const parsed = extracted[index] || {};
      const text = String(heading.textContent || '').trim();
      if (!text) return;
      const anchor = createHeadingSlug(text, usedAnchors);
      const domId = 'preview-heading-' + tab.id + '-' + index;
      heading.id = domId;
      heading.dataset.previewAnchor = anchor;
      heading.dataset.sourceLine = String(Number(parsed.line) || 0);
      entries.push({
        level: Number(parsed.level) || Number(String(heading.tagName || 'H2').slice(1)) || 2,
        text,
        line: Number(parsed.line) || 0,
        anchor,
        domId,
      });
    });
    tab.outline = entries;
    tab.lineCount = String(source || '').replace(/\r\n?/g, '\n').split('\n').length;
    if (!entries.some(entry => entry.anchor === tab.outlineActiveAnchor)) {
      tab.outlineActiveAnchor = entries[0]?.anchor || null;
    }
    renderOutlineEntries(tab);
    syncOutlineUI(tab);
  }

  function highlightOutlineTarget(element, className) {
    if (outlineHighlightTimer) clearTimeout(outlineHighlightTimer);
    if (outlineHighlightedElement) outlineHighlightedElement.classList.remove('preview-heading-target', 'preview-line-target');
    outlineHighlightedElement = element;
    element?.classList?.add(className);
    outlineHighlightTimer = setTimeout(() => {
      element?.classList?.remove(className);
      if (outlineHighlightedElement === element) outlineHighlightedElement = null;
      outlineHighlightTimer = null;
    }, 900);
  }

  function scrollElementIntoPreview(element) {
    if (!element || typeof element.getBoundingClientRect !== 'function') return false;
    const bodyRect = previewBodyEl.getBoundingClientRect();
    const targetRect = element.getBoundingClientRect();
    previewBodyEl.scrollTop += targetRect.top - bodyRect.top - 14;
    return true;
  }

  function activateOutlineEntry(index, { focus = false } = {}) {
    const entry = outlineEntries[index];
    if (!entry) return false;
    const element = document.getElementById(entry.domId);
    if (!scrollElementIntoPreview(element)) return false;
    setOutlineActiveIndex(index, { focus, reveal: true });
    highlightOutlineTarget(element, 'preview-heading-target');
    return true;
  }

  function updateOutlineFromScroll() {
    if (outlineScrollFrame || outlineEntries.length === 0 || outlineModeForTab() !== 'markdown') return;
    outlineScrollFrame = requestAnimationFrame(() => {
      outlineScrollFrame = 0;
      const bodyRect = previewBodyEl.getBoundingClientRect();
      let nextIndex = 0;
      outlineEntries.forEach((entry, index) => {
        const element = document.getElementById(entry.domId);
        if (element && element.getBoundingClientRect().top <= bodyRect.top + 28) nextIndex = index;
      });
      if (nextIndex !== outlineActiveIndex) setOutlineActiveIndex(nextIndex, { reveal: true });
    });
  }

  function jumpToPreviewLine(rawLine) {
    const state = getContextState();
    const tab = getActiveTab(state);
    if (!tab || outlineModeForTab(tab) !== 'line') return false;
    const normalized = String(rawLine == null ? '' : rawLine).trim();
    if (!/^\d+$/.test(normalized)) return false;
    const line = Number(normalized);
    if (!Number.isSafeInteger(line) || line < 1 || line > Number(tab.lineCount)) return false;
    const element = previewBodyEl.querySelector('.preview-code-line[data-line="' + line + '"]');
    if (!element || !scrollElementIntoPreview(element)) return false;
    tab.referenceLine = line;
    if (gotoLineInputEl) gotoLineInputEl.value = String(line);
    if (outlineCopyEl) outlineCopyEl.disabled = tab.lineReferenceExact === false;
    highlightOutlineTarget(element, 'preview-line-target');
    announcePreviewAction('已跳转到第 ' + line + ' 行');
    return true;
  }

  function copyOutlineReference() {
    const state = getContextState();
    const tab = getActiveTab(state);
    const mode = outlineModeForTab(tab);
    let line = 0;
    let anchor = '';
    if (mode === 'markdown' && outlineActiveIndex >= 0) {
      const entry = outlineEntries[outlineActiveIndex];
      line = Number(entry && entry.line) || 0;
      anchor = entry && entry.anchor || '';
    } else if (mode === 'line') {
      if (tab.lineReferenceExact === false) {
        showPreviewNotice('格式化预览的行号不等于源文件行号，已禁用引用复制', 'error');
        return false;
      }
      line = Number(tab && tab.referenceLine) || 1;
    }
    const reference = formatPreviewReference(tab && tab.path, { line, anchor });
    if (!reference) return false;
    writeClipboard(reference);
    flashIconButton(outlineCopyEl, '引用已复制');
    return reference;
  }

  function setOutlineOpen(open, { restoreFocus = false } = {}) {
    const state = getContextState();
    const tab = getActiveTab(state);
    if (!state || !outlineModeForTab(tab)) return false;
    state.outlineOpen = !!open;
    syncOutlineUI(tab);
    if (open) {
      if (outlineModeForTab(tab) === 'markdown') {
        const active = outlineListEl
          ? Array.from(outlineListEl.querySelectorAll('[data-outline-index]')).find(button => button.tabIndex === 0)
          : null;
        active?.focus?.();
      } else {
        gotoLineInputEl?.focus?.();
        gotoLineInputEl?.select?.();
      }
    } else if (restoreFocus) {
      outlineToggleEl?.focus?.();
    }
    return true;
  }

  function toggleOutline() {
    const state = getContextState();
    return setOutlineOpen(!(state && state.outlineOpen), { restoreFocus: true });
  }

  function clearOutlineUI() {
    if (outlineScrollFrame) cancelAnimationFrame(outlineScrollFrame);
    outlineScrollFrame = 0;
    if (outlineHighlightTimer) clearTimeout(outlineHighlightTimer);
    outlineHighlightTimer = null;
    if (outlineHighlightedElement) {
      outlineHighlightedElement.classList.remove('preview-heading-target', 'preview-line-target');
      outlineHighlightedElement = null;
    }
    outlineEntries = [];
    outlineActiveIndex = -1;
    if (outlineEl) outlineEl.hidden = true;
    if (outlineListEl) outlineListEl.innerHTML = '';
    if (outlineToggleEl) {
      outlineToggleEl.disabled = true;
      outlineToggleEl.setAttribute('aria-expanded', 'false');
    }
    if (outlineCopyEl) outlineCopyEl.disabled = true;
  }

  function ensureSourcePanel() {
    if (previewSourcePanel) return;
    if (String(currentContextKey || '').startsWith('meeting:')) {
      previewSourcePanel = 'meeting-room-panel';
      return;
    }
    const meetingPanel = document.getElementById('meeting-room-panel');
    if (meetingPanel && meetingPanel.style.display !== 'none' && meetingPanel.style.display !== '') {
      previewSourcePanel = 'meeting-room-panel';
    } else {
      previewSourcePanel = 'terminal-panel';
    }
  }

  function syncPreviewLayoutControls(isFullscreen = previewIsFullscreen) {
    const fullscreen = !!isFullscreen;
    if (previewLayoutSplitEl) {
      previewLayoutSplitEl.classList.toggle('active', !fullscreen);
      previewLayoutSplitEl.setAttribute('aria-pressed', String(!fullscreen));
    }
    if (previewLayoutFullEl) {
      previewLayoutFullEl.classList.toggle('active', fullscreen);
      previewLayoutFullEl.setAttribute('aria-pressed', String(fullscreen));
    }
  }

  function applyPreviewLayout(isFullscreen, { persist = true, refit = true } = {}) {
    const state = getContextState();
    previewIsFullscreen = !!isFullscreen;
    if (persist && state) state.isFullscreen = previewIsFullscreen;
    ensureSourcePanel();
    const isSplit = !previewIsFullscreen;
    previewPanelEl.classList.toggle('preview-split', isSplit);
    previewSplitterEl.style.display = isSplit ? '' : 'none';
    applySplitWidths(isSplit ? previewSplitRatio : null);
    const src = previewSourcePanel ? document.getElementById(previewSourcePanel) : null;
    if (src) src.style.display = previewIsFullscreen
      ? 'none'
      : (previewSourcePanel === 'terminal-panel' ? '' : 'flex');
    syncPreviewLayoutControls(previewIsFullscreen);
    if (refit) refitActiveTerminal();
    return true;
  }

  function setPreviewLayout(isFullscreen) {
    immersive.exit();
    if (!getContextState()) return false;
    return applyPreviewLayout(!!isFullscreen);
  }

  function showPanelFrame(state) {
    previewIsFullscreen = !!state.isFullscreen;
    previewSplitRatio = Number(state.splitRatio) || 0.5;
    ensureSourcePanel();
    const emptyEl = document.getElementById('empty-state');
    if (emptyEl) emptyEl.style.display = 'none';
    previewPanelEl.style.display = 'flex';
    applyPreviewLayout(previewIsFullscreen, { persist: false, refit: false });
    renderTabs();
    if (!previewIsFullscreen) refitActiveTerminal();
  }

  function renderCsv(content, separator) {
    const wrap = document.createElement('div');
    wrap.className = 'preview-csv-wrap';
    const table = document.createElement('table');
    table.className = 'preview-csv';
    const rows = String(content || '').split(/\r?\n/).filter(line => line.trim());
    if (rows.length > 0) {
      const head = document.createElement('thead');
      const headRow = document.createElement('tr');
      for (const value of rows[0].split(separator)) {
        const cell = document.createElement('th');
        cell.textContent = value;
        headRow.appendChild(cell);
      }
      head.appendChild(headRow);
      table.appendChild(head);
      const body = document.createElement('tbody');
      for (const row of rows.slice(1)) {
        const tr = document.createElement('tr');
        for (const value of row.split(separator)) {
          const cell = document.createElement('td');
          cell.textContent = value;
          tr.appendChild(cell);
        }
        body.appendChild(tr);
      }
      table.appendChild(body);
    }
    wrap.appendChild(table);
    previewBodyEl.appendChild(wrap);
  }

  async function renderActiveTab(tab, options = {}) {
    previewFind.clearForRender();
    const token = ++previewRenderToken;
    currentPreviewPath = tab.path;
    clearOutlineForRender(tab);
    updateFileMetadata(tab.path);
    updateActionAvailability();
    setPreviewZoom(options.preserveZoom ? (options.zoomLevel || tab.zoomLevel || 1) : (tab.zoomLevel || 1), { persist: false });
    previewBodyEl.innerHTML = '';
    previewBodyEl.scrollLeft = 0;
    previewBodyEl.scrollTop = 0;
    const isUrl = /^https?:\/\//i.test(tab.path);
    const ext = previewExtension(tab.path);
    const scroll = options.scroll || tab.scroll;
    const loadChangeVersion = Number(tab.changeVersion) || 0;
    const asyncLoadOptions = {
      onLoad: () => settleAsyncTabLoad(tab, loadChangeVersion, token),
      onError: error => settleAsyncTabLoad(tab, loadChangeVersion, token, error),
    };
    const isStillCurrent = () => {
      const state = getContextState();
      return token === previewRenderToken && state && state.activeTabId === tab.id;
    };
    const failRender = (message) => {
      tab.loadError = String(message || '预览加载失败');
      showPreviewError(tab.loadError, token);
      return false;
    };

    if (isUrl) {
      tab.kind = 'web';
      makeWebview(tab.path, scroll, token, asyncLoadOptions);
      return null;
    }
    if (WEB_EXTENSIONS.has(ext)) {
      tab.kind = 'web';
      makeWebview(pathToFileURL(tab.path).href, scroll, token, asyncLoadOptions);
      return null;
    }
    if (MARKDOWN_EXTENSIONS.has(ext)) {
      tab.kind = 'text';
      const result = await readPreviewFile(tab.path);
      if (!isStillCurrent()) return false;
      if (result.error) return failRender(result.error);
      let html;
      let parsedOutline = [];
      try {
        if (typeof marked.lexer === 'function'
            && typeof marked.parser === 'function') {
          const tokens = marked.lexer(result.content);
          parsedOutline = extractMarkdownOutline(result.content, tokens, { includeEmpty: true });
          html = DOMPurify.sanitize(marked.parser(tokens));
        } else {
          html = DOMPurify.sanitize(marked.parse(result.content));
        }
      }
      catch (error) { return failRender(`Markdown 渲染失败：${String(error && error.message || error)}`); }
      setPreviewBodyLayout('flex-start', 'flex-start');
      const markdown = document.createElement('div');
      markdown.className = 'preview-markdown';
      markdown.innerHTML = html;
      previewBodyEl.appendChild(markdown);
      installMarkdownOutline(tab, markdown, result.content, parsedOutline);
      restoreBodyScroll(scroll, token, tab.id);
      return true;
    }
    if (IMAGE_EXTENSIONS.has(ext)) {
      tab.kind = 'image';
      setPreviewBodyLayout('center', 'center');
      const image = document.createElement('img');
      image.className = 'preview-image';
      image.alt = tab.title;
      image.addEventListener('load', asyncLoadOptions.onLoad, { once: true });
      image.addEventListener('error', () => asyncLoadOptions.onError('图片加载失败'), { once: true });
      previewBodyEl.appendChild(image);
      image.src = pathToFileURL(tab.path).href;
      restoreBodyScroll(scroll, token, tab.id);
      return null;
    }
    if (ext === '.pdf') {
      tab.kind = 'pdf';
      makeWebview(pathToFileURL(tab.path).href, scroll, token, asyncLoadOptions);
      return null;
    }
    if (TABLE_EXTENSIONS.has(ext)) {
      tab.kind = 'text';
      const result = await readPreviewFile(tab.path);
      if (!isStillCurrent()) return false;
      if (result.error) return failRender(result.error);
      setPreviewBodyLayout('flex-start', 'flex-start');
      renderCsv(result.content, ext === '.tsv' ? '\t' : ',');
      restoreBodyScroll(scroll, token, tab.id);
      return true;
    }

    tab.kind = 'text';
    const result = await readPreviewFile(tab.path);
    if (!isStillCurrent()) return false;
    if (result.error) return failRender(result.error);
    let content = result.content;
    if (ext === '.json' || ext === '.jsonl') {
      try { content = JSON.stringify(JSON.parse(content), null, 2); } catch (_) {}
    }
    tab.lineReferenceExact = String(content) === String(result.content);
    setPreviewBodyLayout('flex-start', 'flex-start');
    const code = document.createElement('pre');
    code.className = 'preview-code';
    const lines = String(content || '').split('\n');
    lines.forEach((line, index) => {
      const row = document.createElement('span');
      row.className = 'preview-code-line';
      row.dataset.line = String(index + 1);
      const number = document.createElement('span');
      number.className = 'preview-line-num';
      number.textContent = String(index + 1);
      number.dataset.line = String(index + 1);
      number.setAttribute('aria-hidden', 'true');
      row.appendChild(number);
      row.appendChild(document.createTextNode ? document.createTextNode(line) : (() => {
        const span = document.createElement('span');
        span.textContent = line;
        return span;
      })());
      code.appendChild(row);
    });
    previewBodyEl.appendChild(code);
    tab.lineCount = lines.length;
    tab.referenceLine = Math.max(1, Math.min(lines.length, Number(tab.referenceLine) || 1));
    syncOutlineUI(tab);
    restoreBodyScroll(scroll, token, tab.id);
    return true;
  }

  async function renderActiveTabAndRefreshFind(tab, options = {}) {
    const changeVersion = Number(tab.changeVersion) || 0;
    const success = await renderActiveTab(tab, options);
    if (success && !tab.missing && (Number(tab.changeVersion) || 0) === changeVersion) {
      tab.stale = false;
      tab.change = null;
      tab.loadError = null;
    }
    renderTabs();
    if (getActiveTab() === tab) updateTabChangeUI(tab);
    if (getActiveTab() === tab) syncOutlineUI(tab);
    previewFind.refresh();
    return success;
  }

  async function openPreviewPanel(filePath, options = {}) {
    const target = cleanPreviewTarget(filePath);
    if (!target) return null;
    const operation = ++navigationToken;
    await onBeforeOpen?.();
    if (operation !== navigationToken) return null;
    const key = getActiveContextKey();
    const previousState = getContextState();
    if (currentContextKey === key && previousState) {
      await captureActiveTabState(previousState);
      if (operation !== navigationToken) return null;
    }

    currentContextKey = key;
    const state = getContextState(key, true);
    if (typeof options.fullscreen === 'boolean') state.isFullscreen = options.fullscreen;
    const openAsPreview = options.preview === true && options.pinned !== true;
    let tab = state.tabs.find(candidate => previewPathKey(candidate.path) === previewPathKey(target));
    if (!tab) {
      const reusable = openAsPreview
        ? state.tabs.find(candidate => !isTabPinned(candidate))
        : null;
      if (reusable) {
        tab = replaceTemporaryTab(reusable, target);
      } else {
        tab = createTabRecord(target, { pinned: !openAsPreview });
        state.tabs.push(tab);
      }
    } else {
      if (!openAsPreview) tab.pinned = true;
      tab.openedAt = Date.now();
    }
    if (options.scroll) tab.scroll = options.scroll;
    if (options.zoomLevel) tab.zoomLevel = options.zoomLevel;
    ensureTabWatch(tab);
    prepareTabForLoad(tab);
    state.activeTabId = tab.id;
    showPanelFrame(state);
    await renderActiveTabAndRefreshFind(tab, {
      preserveZoom: true,
      zoomLevel: tab.zoomLevel,
      scroll: tab.scroll,
    });
    return tab.id;
  }

  async function switchPreviewTab(tabId) {
    const state = getContextState();
    if (!state || state.activeTabId === tabId) return;
    const target = state.tabs.find(tab => tab.id === tabId);
    if (!target) return;
    const operation = ++navigationToken;
    await captureActiveTabState(state);
    if (operation !== navigationToken) return;
    state.activeTabId = target.id;
    prepareTabForLoad(target);
    renderTabs();
    await renderActiveTabAndRefreshFind(target, { preserveZoom: true, zoomLevel: target.zoomLevel, scroll: target.scroll });
  }

  async function closePreviewTab(tabId) {
    const state = getContextState();
    if (!state) return;
    const index = state.tabs.findIndex(tab => tab.id === tabId);
    if (index < 0) return;
    const wasActive = state.activeTabId === tabId;
    const operation = ++navigationToken;
    if (wasActive) await captureActiveTabState(state);
    if (operation !== navigationToken) return;
    const [removed] = state.tabs.splice(index, 1);
    disposeTab(removed);
    if (state.tabs.length === 0) {
      closePreviewPanel();
      const launcher = document.getElementById('btn-preview-path');
      if (launcher && typeof launcher.focus === 'function') launcher.focus();
      return;
    }
    if (!wasActive) {
      renderTabs();
      return;
    }
    const next = state.tabs[Math.min(index, state.tabs.length - 1)];
    state.activeTabId = next.id;
    prepareTabForLoad(next);
    renderTabs();
    await renderActiveTabAndRefreshFind(next, { preserveZoom: true, zoomLevel: next.zoomLevel, scroll: next.scroll });
  }

  async function restorePreviewForContext(key) {
    const state = getContextState(key);
    if (!state || state.tabs.length === 0) return;
    const operation = ++navigationToken;
    currentContextKey = key;
    let tab = getActiveTab(state);
    if (!tab) {
      tab = state.tabs[state.tabs.length - 1];
      state.activeTabId = tab.id;
    }
    ensureTabWatch(tab);
    prepareTabForLoad(tab);
    showPanelFrame(state);
    if (operation !== navigationToken) return;
    await renderActiveTabAndRefreshFind(tab, { preserveZoom: true, zoomLevel: tab.zoomLevel, scroll: tab.scroll });
  }

  function closePreviewPanel() {
    immersive.exit();
    const wasOpen = previewPanelEl.style.display !== 'none' && !!currentContextKey;
    clearPreviewNotice();
    previewFind.close({ restoreFocus: false, keepQuery: false });
    clearOutlineUI();
    navigationToken += 1;
    previewRenderToken += 1;
    const key = currentContextKey || getActiveContextKey();
    if (key) {
      disposeContextState(contextPreviewStates.get(key));
      contextPreviewStates.delete(key);
    }
    previewPanelEl.style.display = 'none';
    previewPanelEl.classList.remove('preview-split');
    previewSplitterEl.style.display = 'none';
    previewBodyEl.innerHTML = '';
    if (previewTabsEl) previewTabsEl.innerHTML = '';
    resetPreviewLayoutEffects();
    restoreSourcePanelVisibility();
    resetPreviewZoom({ persist: false });
    resetPreviewHeader();
    previewIsFullscreen = true;
    previewSplitRatio = 0.5;
    syncPreviewLayoutControls();
    currentContextKey = null;
    refitActiveTerminal();
    if (wasOpen && key === getActiveContextKey()) onReturnToConversation?.(key);
  }

  function dropPreviewContext(key) {
    if (!key) return false;
    disposeContextState(contextPreviewStates.get(key));
    const existed = contextPreviewStates.delete(key);
    if (currentContextKey === key) closePreviewPanel();
    return existed;
  }

  async function reloadActivePreview() {
    const state = getContextState();
    const tab = getActiveTab(state);
    if (!state || !tab) return false;
    const operation = ++navigationToken;
    await captureActiveTabState(state);
    if (operation !== navigationToken || state.activeTabId !== tab.id) return false;
    prepareTabForLoad(tab);
    renderTabs();
    updateTabChangeUI(tab);
    const success = await renderActiveTabAndRefreshFind(tab, {
      preserveZoom: true,
      zoomLevel: tab.zoomLevel,
      scroll: tab.scroll,
    });
    // Text formats settle synchronously. webview/image/PDF return null once a
    // real load has started and report completion through their load/error
    // callbacks, so this public boolean means "reload accepted", not "bytes
    // finished rendering".
    return success !== false && !tab.missing;
  }

  function flashButton(button, message, status = 'success') {
    if (!button) return;
    if (!button._previewFlashSnapshot) {
      button._previewFlashSnapshot = {
        html: button.innerHTML,
        title: button.title,
        ariaLabel: button.getAttribute('aria-label'),
        ariaLive: button.getAttribute('aria-live'),
      };
    }
    if (button._previewFlashTimer) clearTimeout(button._previewFlashTimer);
    const snapshot = button._previewFlashSnapshot;
    button.textContent = message;
    button.title = message;
    button.setAttribute('aria-label', message);
    button.setAttribute('aria-live', status === 'error' ? 'assertive' : 'polite');
    button.dataset.flash = status;
    const liveStatus = document.getElementById('preview-action-status');
    if (liveStatus) {
      liveStatus.textContent = '';
      requestAnimationFrame(() => { liveStatus.textContent = String(message); });
    }
    button._previewFlashTimer = setTimeout(() => {
      button.innerHTML = snapshot.html;
      button.title = snapshot.title;
      if (snapshot.ariaLabel == null) button.removeAttribute('aria-label');
      else button.setAttribute('aria-label', snapshot.ariaLabel);
      if (snapshot.ariaLive == null) button.removeAttribute('aria-live');
      else button.setAttribute('aria-live', snapshot.ariaLive);
      delete button.dataset.flash;
      delete button._previewFlashSnapshot;
      delete button._previewFlashTimer;
    }, 1200);
  }

  function flashIconButton(button, message, status = 'success') {
    if (!button) return;
    if (button._previewIconFlashTimer) clearTimeout(button._previewIconFlashTimer);
    button.dataset.flash = status;
    announcePreviewAction(message);
    button._previewIconFlashTimer = setTimeout(() => {
      delete button.dataset.flash;
      delete button._previewIconFlashTimer;
    }, 1200);
  }

  function writeClipboard(text) {
    if (!clipboard || typeof clipboard.writeText !== 'function') throw new Error('clipboard unavailable');
    clipboard.writeText(String(text));
  }

  async function copyPreviewPath() {
    const button = document.getElementById('preview-copy-path');
    if (!currentPreviewPath) return;
    try {
      writeClipboard(currentPreviewPath);
      flashButton(button, '路径已复制');
    } catch (error) {
      console.warn('[preview] copy path failed:', error);
      flashButton(button, '失败', 'error');
      showPreviewNotice(`复制路径失败：${String(error && error.message || error)}`, 'error');
    }
  }

  async function copyPreviewContent() {
    const button = document.getElementById('preview-copy-content');
    const state = getContextState();
    const tab = getActiveTab(state);
    if (!currentPreviewPath || !state || !tab) return;
    const snapshot = { tabId: tab.id, path: currentPreviewPath, renderToken: previewRenderToken };
    const ext = previewExtension(snapshot.path);
    if (NON_COPYABLE_EXTENSIONS.has(ext)) {
      flashButton(button, '此类型不可复制', 'error');
      return;
    }
    try {
      let content = '';
      const webview = previewBodyEl.querySelector('webview');
      if (webview && typeof webview.executeJavaScript === 'function') {
        let timeoutId = null;
        const request = Promise.resolve(webview.executeJavaScript(`(() => {
          const body = document.body;
          return body ? (body.innerText || body.textContent || '') : '';
        })()`));
        try {
          content = await Promise.race([
            request,
            new Promise((_, reject) => {
              timeoutId = setTimeout(() => reject(new Error('页面文字读取超时')), PREVIEW_COPY_TIMEOUT_MS);
            }),
          ]);
        } finally {
          if (timeoutId) clearTimeout(timeoutId);
        }
        if (!String(content || '').trim()) throw new Error('页面尚未就绪或没有可复制文字');
      } else {
        const result = await readPreviewFile(snapshot.path);
        if (result.error) throw new Error(result.error);
        content = result.content;
      }
      const currentState = getContextState();
      if (snapshot.renderToken !== previewRenderToken
          || currentPreviewPath !== snapshot.path
          || !currentState
          || currentState.activeTabId !== snapshot.tabId) {
        throw new Error('预览已切换，已取消复制');
      }
      writeClipboard(content || '');
      flashButton(button, '全文已复制');
    } catch (error) {
      console.warn('[preview] copy content failed:', error);
      flashButton(button, '复制失败', 'error');
      showPreviewNotice(`复制全文失败：${String(error && error.message || error)}`, 'error');
    }
  }

  async function showPreviewInFolder() {
    const button = document.getElementById('preview-show-in-folder');
    if (!currentPreviewPath || /^https?:\/\//i.test(currentPreviewPath)) return;
    try {
      const result = await ipcRenderer.invoke('show-in-folder', currentPreviewPath);
      if (result && result.error) {
        flashButton(button, '失败', 'error');
        showPreviewNotice(`定位失败：${result.error}`, 'error');
      }
      else flashButton(button, '已在资源管理器定位');
    } catch (error) {
      console.warn('[preview] show in folder failed:', error);
      flashButton(button, '失败', 'error');
      showPreviewNotice(`定位失败：${String(error && error.message || error)}`, 'error');
    }
  }

  async function openPreviewExternal() {
    if (!currentPreviewPath) return;
    const button = document.getElementById('preview-open-external');
    try {
      if (/^https?:\/\//i.test(currentPreviewPath)) {
        await shell.openExternal(currentPreviewPath);
        return;
      }
      const error = await ipcRenderer.invoke('open-path', currentPreviewPath);
      if (error) throw new Error(error);
    } catch (error) {
      console.warn('[hub] open external for preview failed:', currentPreviewPath, '->', error);
      flashButton(button, '失败', 'error');
      showPreviewNotice(`外部打开失败：${String(error && error.message || error)}`, 'error');
    }
  }

  async function handlePreviewLinkClick(event) {
    const anchor = event.target && event.target.closest && event.target.closest('a[href]');
    if (!anchor || anchor.classList.contains('rt-file-link')) return;
    const rawHref = anchor.getAttribute('href') || '';
    if (!rawHref) return;
    if (rawHref.startsWith('#')) {
      event.preventDefault();
      event.stopPropagation();
      let targetAnchor = rawHref.slice(1);
      try { targetAnchor = decodeURIComponent(targetAnchor); } catch (_) {}
      const index = outlineEntries.findIndex(entry => entry.anchor === targetAnchor);
      if (index >= 0) activateOutlineEntry(index);
      else showPreviewNotice('未找到标题锚点：' + targetAnchor, 'error');
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    if (/^(mailto|tel|sms|callto|skype):/i.test(rawHref)) {
      await shell.openExternal(rawHref);
      return;
    }
    const protocol = /^([a-z][a-z0-9+.-]*):/i.exec(rawHref);
    if (protocol && !/^(https?|file)$/i.test(protocol[1])) {
      console.warn('[hub] unsupported scheme blocked:', rawHref);
      return;
    }
    const hashIndex = rawHref.indexOf('#');
    const withoutHash = hashIndex >= 0 ? rawHref.slice(0, hashIndex) : rawHref;
    let href;
    try { href = decodeURIComponent(withoutHash); } catch (_) { href = withoutHash; }
    if (/^https?:\/\//i.test(href)) { await openPreviewPanel(href, { preview: true }); return; }
    let target = href;
    if (/^file:/i.test(href)) {
      try { target = fileURLToPath(href); } catch (_) { target = href.replace(/^file:\/+/i, ''); }
    }
    const isAbsolute = /^[a-zA-Z]:[\\/]/.test(target) || target.startsWith('/');
    if (!isAbsolute && currentPreviewPath && !/^https?:\/\//i.test(currentPreviewPath)) {
      try { target = path.resolve(path.dirname(currentPreviewPath), target); } catch (error) {
        console.warn('[hub] preview link resolve failed:', error);
      }
    }
    if (typeof openPath === 'function') await openPath(target);
    else await openPreviewPanel(target, { preview: true });
  }

  function recentQuickOpenItems() {
    const state = getContextState(currentContextKey || getActiveContextKey());
    if (!state) return [];
    return [...state.tabs]
      .sort((a, b) => b.openedAt - a.openedAt)
      .map(tab => ({
        path: tab.path,
        name: tab.title,
        relativePath: tab.path,
        isDirectory: false,
        source: 'recent',
      }));
  }

  function renderQuickOpenItems(items, statusText) {
    quickOpenItems = Array.isArray(items) ? items : [];
    quickOpenSelectedIndex = Math.min(Math.max(0, quickOpenSelectedIndex), Math.max(0, quickOpenItems.length - 1));
    if (quickOpenStatusEl) quickOpenStatusEl.textContent = statusText || '';
    if (quickOpenInputEl) quickOpenInputEl.setAttribute('aria-expanded', 'true');
    if (!quickOpenResultsEl) return;
    quickOpenResultsEl.innerHTML = '';
    if (quickOpenItems.length === 0) {
      if (quickOpenInputEl) quickOpenInputEl.removeAttribute('aria-activedescendant');
      const empty = document.createElement('div');
      empty.className = 'preview-quick-open-empty';
      empty.textContent = '没有匹配路径。可粘贴完整绝对路径后重试。';
      quickOpenResultsEl.appendChild(empty);
      return;
    }
    quickOpenItems.forEach((item, index) => {
      const row = document.createElement('div');
      row.className = `preview-quick-open-item${index === quickOpenSelectedIndex ? ' selected' : ''}`;
      row.id = `preview-quick-open-option-${index}`;
      row.dataset.resultIndex = String(index);
      row.setAttribute('role', 'option');
      row.setAttribute('aria-selected', index === quickOpenSelectedIndex ? 'true' : 'false');
      row.title = item.path;

      const icon = document.createElement('span');
      icon.className = 'preview-quick-open-item-icon';
      icon.textContent = item.isDirectory ? '▰' : '▤';
      icon.setAttribute('aria-hidden', 'true');
      const main = document.createElement('span');
      main.className = 'preview-quick-open-item-main';
      const name = document.createElement('span');
      name.className = 'preview-quick-open-item-name';
      name.textContent = item.name || previewTitle(item.path);
      const pathEl = document.createElement('span');
      pathEl.className = 'preview-quick-open-item-path';
      pathEl.textContent = item.relativePath || item.path;
      main.append(name, pathEl);
      const source = document.createElement('span');
      source.className = 'preview-quick-open-item-source';
      source.textContent = item.source === 'exact' ? '精确' : item.source === 'recent' ? '最近' : '本地';
      row.setAttribute(
        'aria-label',
        (item.name || previewTitle(item.path)) + '，'
          + (item.relativePath || item.path) + '，' + source.textContent,
      );
      row.append(icon, main, source);
      quickOpenResultsEl.appendChild(row);
    });
    if (quickOpenInputEl && quickOpenItems.length > 0) {
      quickOpenInputEl.setAttribute('aria-activedescendant', `preview-quick-open-option-${quickOpenSelectedIndex}`);
    }
  }

  async function runQuickOpenSearch(query, token, activateFirst = false) {
    const contextKey = getActiveContextKey();
    const cwd = getActiveCwd && getActiveCwd();
    const requestStillCurrent = () => (
      token === quickOpenSearchToken
      && quickOpenEl
      && quickOpenEl.style.display === 'flex'
      && getActiveContextKey() === contextKey
      && String(getActiveCwd && getActiveCwd() || '') === String(cwd || '')
    );
    let result;
    try {
      result = await ipcRenderer.invoke('preview:search-paths', { query, cwd, limit: 40 });
    } catch (error) {
      if (!requestStillCurrent()) return;
      renderQuickOpenItems([], `搜索失败：${String(error && error.message || error)}`);
      return;
    }
    if (!requestStillCurrent()) return;
    const items = result && Array.isArray(result.results) ? result.results : [];
    const scope = cwd ? `当前 workspace · ${result.indexedCount || 0} 项` : '仅检查精确绝对路径';
    const suffix = result && result.truncated ? ' · 索引已达上限' : '';
    const warning = result && result.errorsCount ? ` · ${result.errorsCount} 个目录不可读` : '';
    renderQuickOpenItems(items, result && result.error ? `搜索失败：${result.error}` : `${scope}${suffix}${warning}`);
    if (activateFirst && items.length > 0 && requestStillCurrent()) {
      await activateQuickOpenItem(0);
    }
  }

  function handleQuickOpenInput() {
    const query = String(quickOpenInputEl && quickOpenInputEl.value || '').trim();
    quickOpenSearchToken += 1;
    const token = quickOpenSearchToken;
    if (quickOpenTimer) {
      clearTimeout(quickOpenTimer);
      quickOpenTimer = null;
    }
    if (!query) {
      const recent = recentQuickOpenItems();
      renderQuickOpenItems(recent, recent.length ? '当前会话最近预览' : '输入绝对路径、相对路径或文件名');
      return;
    }
    renderQuickOpenItems([], '正在本地搜索…');
    quickOpenTimer = setTimeout(() => {
      quickOpenTimer = null;
      void runQuickOpenSearch(query, token);
    }, QUICK_OPEN_DEBOUNCE_MS);
  }

  async function activateQuickOpenItem(index = quickOpenSelectedIndex, { pinned = quickOpenPinnedIntent } = {}) {
    const item = quickOpenItems[index];
    if (!item || !item.path) return;
    const items = quickOpenItems.slice();
    const returnFocus = quickOpenReturnFocus;
    const pinIntent = !!pinned;
    closeQuickOpen({ restoreFocus: false });
    try {
      if (typeof openPath === 'function') {
        await openPath(item.path, { pinned: pinIntent, preview: !pinIntent });
      } else {
        await openPreviewPanel(item.path, { pinned: pinIntent, preview: !pinIntent });
      }
      const state = getContextState();
      if (state && state.activeTabId) focusPreviewTab(state.activeTabId);
      else if (returnFocus && returnFocus.isConnected !== false && typeof returnFocus.focus === 'function') returnFocus.focus();
    } catch (error) {
      console.warn('[preview] quick open failed:', item.path, error);
      if (quickOpenEl) quickOpenEl.style.display = 'flex';
      quickOpenReturnFocus = returnFocus;
      quickOpenPinnedIntent = pinIntent;
      if (quickOpenModeHintEl) {
      quickOpenModeHintEl.textContent = pinIntent
        ? '↑↓ 选择 · Enter 固定打开'
        : '↑↓ 选择 · Enter 临时预览 · Tab 上 Ctrl+Enter 固定';
      }
      if (quickOpenInputEl) {
        quickOpenInputEl.value = item.path;
        quickOpenInputEl.setAttribute('aria-expanded', 'true');
      }
      renderQuickOpenItems(items, `打开失败：${String(error && error.message || error)}`);
      try { quickOpenInputEl.focus(); } catch (_) {}
    }
  }

  function paintQuickOpenSelection() {
    if (!quickOpenResultsEl) return;
    const rows = quickOpenResultsEl.querySelectorAll('.preview-quick-open-item');
    rows.forEach((row, index) => {
      const selected = index === quickOpenSelectedIndex;
      row.classList.toggle('selected', selected);
      row.setAttribute('aria-selected', selected ? 'true' : 'false');
    });
    if (quickOpenInputEl) {
      if (rows[quickOpenSelectedIndex]) {
        quickOpenInputEl.setAttribute('aria-activedescendant', rows[quickOpenSelectedIndex].id);
      } else {
        quickOpenInputEl.removeAttribute('aria-activedescendant');
      }
    }
    if (rows[quickOpenSelectedIndex]) rows[quickOpenSelectedIndex].scrollIntoView({ block: 'nearest' });
  }

  function openQuickOpen(options = {}) {
    if (!quickOpenEl || !quickOpenInputEl) return;
    quickOpenPinnedIntent = options.pinned === true;
    if (quickOpenEl.style.display !== 'flex') quickOpenReturnFocus = document.activeElement || null;
    quickOpenEl.style.display = 'flex';
    quickOpenInputEl.setAttribute('aria-expanded', 'true');
    quickOpenInputEl.value = '';
    quickOpenSearchToken += 1;
    const recent = recentQuickOpenItems();
    if (quickOpenModeHintEl) {
      quickOpenModeHintEl.textContent = quickOpenPinnedIntent
        ? '↑↓ 选择 · Enter 固定打开'
        : '↑↓ 选择 · Enter 临时预览 · Tab 上 Ctrl+Enter 固定';
    }
    renderQuickOpenItems(recent, recent.length ? '当前会话最近预览' : '输入绝对路径、相对路径或文件名');
    setTimeout(() => {
      try { quickOpenInputEl.focus(); } catch (_) {}
    }, 0);
  }

  function closeQuickOpen({ restoreFocus = true } = {}) {
    if (quickOpenTimer) {
      clearTimeout(quickOpenTimer);
      quickOpenTimer = null;
    }
    quickOpenSearchToken += 1;
    if (quickOpenEl) quickOpenEl.style.display = 'none';
    if (quickOpenInputEl) {
      quickOpenInputEl.setAttribute('aria-expanded', 'false');
      quickOpenInputEl.removeAttribute('aria-activedescendant');
    }
    const returnFocus = quickOpenReturnFocus;
    quickOpenReturnFocus = null;
    quickOpenPinnedIntent = false;
    if (restoreFocus && returnFocus && returnFocus.isConnected !== false && typeof returnFocus.focus === 'function') {
      setTimeout(() => {
        try { returnFocus.focus(); } catch (_) {}
      }, 0);
    }
  }

  function handleQuickOpenKeydown(event) {
    if (event.key === 'Escape') {
      event.preventDefault();
      closeQuickOpen();
      return;
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      if (quickOpenItems.length === 0) return;
      quickOpenSelectedIndex = Math.min(quickOpenItems.length - 1, quickOpenSelectedIndex + 1);
      paintQuickOpenSelection();
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      if (quickOpenItems.length === 0) return;
      quickOpenSelectedIndex = Math.max(0, quickOpenSelectedIndex - 1);
      paintQuickOpenSelection();
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      if (quickOpenItems.length > 0) void activateQuickOpenItem();
      else {
        const query = String(quickOpenInputEl.value || '').trim();
        if (query) {
          if (quickOpenTimer) {
            clearTimeout(quickOpenTimer);
            quickOpenTimer = null;
          }
          quickOpenSearchToken += 1;
          void runQuickOpenSearch(query, quickOpenSearchToken, true);
        }
      }
    }
  }

  function initSplitterDrag() {
    let dragging = false;
    let rafId = 0;
    previewSplitterEl.addEventListener('mousedown', (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      dragging = true;
      previewSplitterEl.classList.add('dragging');
      previewBodyEl.style.pointerEvents = 'none';
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
    });
    previewSplitterEl.addEventListener('keydown', (event) => {
      let nextRatio = null;
      if (event.key === 'ArrowLeft') nextRatio = previewSplitRatio - 0.05;
      else if (event.key === 'ArrowRight') nextRatio = previewSplitRatio + 0.05;
      else if (event.key === 'Home') nextRatio = 0.1;
      else if (event.key === 'End') nextRatio = 0.9;
      if (nextRatio === null) return;
      event.preventDefault();
      previewSplitRatio = Math.max(0.1, Math.min(0.9, nextRatio));
      const state = getContextState();
      if (state) state.splitRatio = previewSplitRatio;
      applySplitWidths(previewSplitRatio);
      refitActiveTerminal();
    });
    document.addEventListener('mousemove', (event) => {
      if (!dragging || rafId) return;
      rafId = requestAnimationFrame(() => {
        rafId = 0;
        const src = previewSourcePanel ? document.getElementById(previewSourcePanel) : null;
        if (!src) return;
        const srcRect = src.getBoundingClientRect();
        const previewRect = previewPanelEl.getBoundingClientRect();
        const totalContent = srcRect.width + previewRect.width;
        if (totalContent <= 0) return;
        const desired = event.clientX - srcRect.left;
        previewSplitRatio = Math.max(0.1, Math.min(0.9, desired / totalContent));
        const state = getContextState();
        if (state) state.splitRatio = previewSplitRatio;
        applySplitWidths(previewSplitRatio);
      });
    });
    document.addEventListener('mouseup', () => {
      if (!dragging) return;
      dragging = false;
      if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
      previewSplitterEl.classList.remove('dragging');
      previewBodyEl.style.pointerEvents = '';
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      refitActiveTerminal();
    });
  }

  function addClickListener(id, handler) {
    const element = document.getElementById(id);
    if (element) element.addEventListener('click', handler);
  }

  previewBodyEl.addEventListener('click', event => {
    void runAsyncAction(() => handlePreviewLinkClick(event), '链接打开失败');
  });
  if (previewTabsEl) {
    previewTabsEl.addEventListener('click', event => {
      const pin = event.target && event.target.closest && event.target.closest('[data-pin-tab-id]');
      if (pin) {
        event.preventDefault();
        event.stopPropagation();
        pinPreviewTab(pin.dataset.pinTabId);
        return;
      }
      const close = event.target && event.target.closest && event.target.closest('[data-close-tab-id]');
      if (close) {
        event.preventDefault();
        event.stopPropagation();
        void runAsyncAction(() => closePreviewTab(close.dataset.closeTabId), '关闭预览失败');
        return;
      }
      const tab = event.target && event.target.closest && event.target.closest('[data-tab-id]');
      if (tab) void runAsyncAction(() => switchPreviewTab(tab.dataset.tabId), '切换预览失败');
    });
    previewTabsEl.addEventListener('dblclick', event => {
      const tab = event.target && event.target.closest && event.target.closest('[data-tab-id]');
      if (!tab) return;
      event.preventDefault();
      pinPreviewTab(tab.dataset.tabId);
    });
    previewTabsEl.addEventListener('keydown', event => {
      const tabElement = event.target && event.target.closest && event.target.closest('[data-tab-id]');
      if (!tabElement || event.target.closest('[data-close-tab-id], [data-pin-tab-id]')) return;
      const state = getContextState();
      if (!state || state.tabs.length === 0) return;
      const currentIndex = state.tabs.findIndex(tab => tab.id === tabElement.dataset.tabId);
      let targetIndex = null;
      if (event.ctrlKey && event.key === 'Enter') {
        event.preventDefault();
        pinPreviewTab(tabElement.dataset.tabId);
        focusPreviewTab(tabElement.dataset.tabId);
        return;
      }
      if (event.key === 'ArrowLeft') targetIndex = (currentIndex - 1 + state.tabs.length) % state.tabs.length;
      else if (event.key === 'ArrowRight') targetIndex = (currentIndex + 1) % state.tabs.length;
      else if (event.key === 'Home') targetIndex = 0;
      else if (event.key === 'End') targetIndex = state.tabs.length - 1;
      else if (event.key === 'Delete') {
        event.preventDefault();
        void runAsyncAction(() => closePreviewTab(tabElement.dataset.tabId), '关闭预览失败');
        return;
      }
      if (targetIndex === null) return;
      event.preventDefault();
      const targetId = state.tabs[targetIndex].id;
      void runAsyncAction(async () => {
        await switchPreviewTab(targetId);
        focusPreviewTab(targetId);
      }, '切换预览失败');
    });
  }
  addClickListener('preview-close', closePreviewPanel);
  addClickListener('preview-layout-split', () => setPreviewLayout(false));
  addClickListener('preview-layout-full', () => setPreviewLayout(true));
  addClickListener('preview-open-external', () => { void runAsyncAction(openPreviewExternal, '外部打开失败'); });
  addClickListener('preview-copy-content', () => { void runAsyncAction(copyPreviewContent, '复制全文失败'); });
  addClickListener('preview-copy-path', () => { void runAsyncAction(copyPreviewPath, '复制路径失败'); });
  addClickListener('preview-show-in-folder', () => { void runAsyncAction(showPreviewInFolder, '资源管理器定位失败'); });
  addClickListener('preview-reload', () => { void runAsyncAction(reloadActivePreview, '重新加载失败'); });
  addClickListener('preview-open-path', () => openQuickOpen({ pinned: false }));
  addClickListener('preview-find-toggle', () => {
    if (previewFind.isOpen()) previewFind.close();
    else previewFind.open();
  });
  addClickListener('preview-new-tab', () => openQuickOpen({ pinned: true }));
  addClickListener('btn-preview-path', () => openQuickOpen({ pinned: false }));
  addClickListener('preview-outline-toggle', toggleOutline);
  addClickListener('preview-outline-close', () => setOutlineOpen(false, { restoreFocus: true }));
  addClickListener('preview-outline-copy', () => {
    void runAsyncAction(copyOutlineReference, '复制引用失败');
  });
  addClickListener('preview-quick-open-close', closeQuickOpen);
  addClickListener('preview-zoom-out', () => setPreviewZoom(previewZoomLevel - 0.1));
  addClickListener('preview-zoom-in', () => setPreviewZoom(previewZoomLevel + 0.1));
  addClickListener('preview-zoom-reset', () => resetPreviewZoom());
  if (quickOpenInputEl) {
    quickOpenInputEl.addEventListener('input', handleQuickOpenInput);
    quickOpenInputEl.addEventListener('keydown', handleQuickOpenKeydown);
  }
  if (quickOpenEl) {
    quickOpenEl.addEventListener('mousedown', event => {
      if (event.target === quickOpenEl) closeQuickOpen();
    });
  }
  if (gotoLineFormEl) {
    gotoLineFormEl.addEventListener('submit', event => {
      event.preventDefault();
      if (!jumpToPreviewLine(gotoLineInputEl && gotoLineInputEl.value)) {
        showPreviewNotice('行号无效或当前内容尚未就绪', 'error');
      }
    });
  }
  if (outlineListEl) {
    outlineListEl.addEventListener('click', event => {
      const button = event.target && event.target.closest && event.target.closest('[data-outline-index]');
      if (button) activateOutlineEntry(Number(button.dataset.outlineIndex) || 0);
    });
    outlineListEl.addEventListener('keydown', event => {
      const button = event.target && event.target.closest && event.target.closest('[data-outline-index]');
      if (!button || outlineEntries.length === 0) return;
      const current = Number(button.dataset.outlineIndex) || 0;
      let next = null;
      if (event.key === 'ArrowUp') next = Math.max(0, current - 1);
      else if (event.key === 'ArrowDown') next = Math.min(outlineEntries.length - 1, current + 1);
      else if (event.key === 'Home') next = 0;
      else if (event.key === 'End') next = outlineEntries.length - 1;
      else if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        activateOutlineEntry(current, { focus: true });
        return;
      }
      if (next === null) return;
      event.preventDefault();
      setOutlineActiveIndex(next, { focus: true, reveal: true });
    });
  }
  if (quickOpenResultsEl) {
    quickOpenResultsEl.addEventListener('mousemove', event => {
      const row = event.target && event.target.closest && event.target.closest('[data-result-index]');
      if (!row) return;
      quickOpenSelectedIndex = Number(row.dataset.resultIndex) || 0;
      paintQuickOpenSelection();
    });
    quickOpenResultsEl.addEventListener('click', event => {
      const row = event.target && event.target.closest && event.target.closest('[data-result-index]');
      if (!row) return;
      void runAsyncAction(
        () => activateQuickOpenItem(Number(row.dataset.resultIndex) || 0),
        '路径打开失败',
      );
    });
  }

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && immersive.isActive()) {
      event.preventDefault();
      event.stopImmediatePropagation?.();
      immersive.exit();
      return;
    }
    if (isBlockingModalOpen(document, { exceptIds: ['preview-quick-open'] })) return;
    if (quickOpenEl && quickOpenEl.style.display === 'flex') {
      if (event.key === 'Tab') {
        const focusable = Array.from(quickOpenEl.querySelectorAll('input, button, [tabindex]'))
          .filter(element => !element.disabled && Number(element.tabIndex) >= 0);
        if (focusable.length > 0) {
          event.preventDefault();
          const current = focusable.indexOf(document.activeElement);
          const next = event.shiftKey
            ? (current <= 0 ? focusable.length - 1 : current - 1)
            : (current < 0 || current === focusable.length - 1 ? 0 : current + 1);
          focusable[next].focus();
        }
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        closeQuickOpen();
        return;
      }
      return;
    }
    const previewVisible = previewPanelEl.style.display === 'flex';
    if (previewVisible && (event.ctrlKey || event.metaKey) && event.shiftKey
        && (event.key === 'o' || event.key === 'O')) {
      event.preventDefault();
      event.stopImmediatePropagation?.();
      toggleOutline();
      return;
    }
    if (previewVisible && (event.ctrlKey || event.metaKey) && !event.shiftKey
        && (event.key === 'f' || event.key === 'F')) {
      event.preventDefault();
      event.stopImmediatePropagation?.();
      previewFind.open();
      return;
    }
    if (previewVisible && event.key === 'F3' && previewFind.isOpen()) {
      event.preventDefault();
      event.stopImmediatePropagation?.();
      previewFind.next(event.shiftKey ? -1 : 1);
      return;
    }
    if (event.key === 'Escape' && previewFind.isOpen()) {
      event.preventDefault();
      event.stopImmediatePropagation?.();
      previewFind.close();
      return;
    }
    const outlineState = getContextState();
    if (event.key === 'Escape' && outlineState && outlineState.outlineOpen
        && outlineEl && !outlineEl.hidden) {
      event.preventDefault();
      event.stopImmediatePropagation?.();
      setOutlineOpen(false, { restoreFocus: true });
      return;
    }
    if (event.key !== 'Escape') return;
    if (previewPanelEl.style.display === 'flex') {
      event.preventDefault();
      event.stopPropagation();
      closePreviewPanel();
    }
  }, true);
  previewBodyEl.addEventListener('scroll', updateOutlineFromScroll, { passive: true });
  previewBodyEl.addEventListener('wheel', (event) => {
    if (!event.ctrlKey && !event.metaKey) return;
    event.preventDefault();
    setPreviewZoom(previewZoomLevel + (event.deltaY < 0 ? 0.1 : -0.1));
  }, { passive: false });
  initSplitterDrag();
  updateActionAvailability();

  return {
    openPreviewPanel,
    closePreviewPanel,
    savePreviewState,
    clearPreviewUI,
    restorePreviewForContext,
    switchPreviewTab,
    closePreviewTab,
    pinPreviewTab,
    dropPreviewContext,
    setPreviewLayout,
    reloadActivePreview,
    openPreviewFind: () => previewFind.open(),
    closePreviewFind: options => previewFind.close(options),
    openQuickOpen,
    closeQuickOpen,
    copyPreviewContent,
    copyPreviewPath,
    showPreviewNotice,
    getFileWatchStats: () => fileWatchManager.getStats(),
    getPreviewFindState: () => previewFind.getState(),
    getPreviewState(key = currentContextKey || getActiveContextKey()) {
      const state = getContextState(key);
      if (!state) return null;
      return {
        activeTabId: state.activeTabId,
        isFullscreen: state.isFullscreen,
        splitRatio: state.splitRatio,
        outlineOpen: !!state.outlineOpen,
        tabs: state.tabs.map(tab => ({
          id: tab.id,
          path: tab.path,
          title: tab.title,
          pinned: isTabPinned(tab),
          zoomLevel: tab.zoomLevel,
          scroll: tab.scroll ? { ...tab.scroll } : null,
          kind: tab.kind,
          outlineActiveAnchor: tab.outlineActiveAnchor || null,
          outline: Array.isArray(tab.outline) ? tab.outline.map(entry => ({
            level: entry.level,
            text: entry.text,
            line: entry.line,
            anchor: entry.anchor,
          })) : [],
          lineCount: Number(tab.lineCount) || 0,
          referenceLine: Number(tab.referenceLine) || 0,
          lineReferenceExact: tab.lineReferenceExact !== false,
          openedAt: tab.openedAt,
          stale: !!tab.stale,
          missing: !!tab.missing,
          changeVersion: Number(tab.changeVersion) || 0,
          loadError: tab.loadError || null,
          watchError: tab.watchError || null,
          change: tab.change ? { ...tab.change } : null,
        })),
      };
    },
  };
}

module.exports = {
  QUICK_OPEN_DEBOUNCE_MS,
  cleanPreviewTarget,
  createPreviewPanelController,
  describeGuestFailure,
  previewPathKey,
  previewTitle,
};
