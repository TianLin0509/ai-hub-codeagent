'use strict';

// Right-click context menu for <a class="rt-file-link"> elements.
// Local links can open the Hub file manager; remote URLs have no local directory.
const { fileURLToPath } = require('url');
const { classifyLocalPathHref } = require('./path-candidates');

function createPathLinkContextMenuController({
  document,
  window,
  menuEl,
  clipboard,
  shell,
  ipcRenderer,
  normalizeLocalPathForOpen,
  getSessionCwd,
  getActiveSessionId,
  getActiveCwd,
  openFileManager,
  pushToChatgpt,
  requestAnimationFrameFn = requestAnimationFrame,
}) {
  let currentTarget = null;
  let syncToastEl = null;
  let syncToastTimer = null;

  function showSyncStatus(message, state = 'working') {
    if (!document.body || typeof document.createElement !== 'function') return;
    if (!syncToastEl) {
      syncToastEl = document.createElement('div');
      syncToastEl.id = 'path-link-sync-status';
      syncToastEl.setAttribute('role', 'status');
      syncToastEl.setAttribute('aria-live', 'polite');
      Object.assign(syncToastEl.style, {
        position: 'fixed',
        right: '24px',
        bottom: '24px',
        zIndex: '12000',
        // Text-only status must never intercept composer clicks, including
        // after the opacity transition leaves an invisible toast in the DOM.
        pointerEvents: 'none',
        maxWidth: '420px',
        padding: '12px 16px',
        borderRadius: '12px',
        color: '#fff',
        fontSize: '13px',
        lineHeight: '1.55',
        whiteSpace: 'pre-line',
        boxShadow: '0 10px 32px rgba(0,0,0,.28)',
        transition: 'opacity .18s ease, transform .18s ease',
      });
      document.body.appendChild(syncToastEl);
    }
    if (syncToastTimer) {
      window.clearTimeout(syncToastTimer);
      syncToastTimer = null;
    }
    syncToastEl.textContent = message;
    syncToastEl.dataset.state = state;
    syncToastEl.style.background = state === 'error' ? '#9f2d2d' : (state === 'success' ? '#0f766e' : '#273b37');
    syncToastEl.style.opacity = '1';
    syncToastEl.style.transform = 'translateY(0)';
    if (state !== 'working') {
      syncToastTimer = window.setTimeout(() => {
        syncToastEl.style.opacity = '0';
        syncToastEl.style.transform = 'translateY(8px)';
      }, state === 'error' ? 7000 : 5000);
    }
  }

  function resolveTarget(rawPath, ownerCwd) {
    if (!rawPath) return null;
    let trimmed = String(rawPath).trim();
    if (!trimmed) return null;
    if (/^https?:\/\//i.test(trimmed)) {
      return { absPath: trimmed, isUrl: true };
    }
    // If already an absolute Windows path or POSIX absolute, no cwd needed.
    if (/^file:/i.test(trimmed)) {
      try { trimmed = fileURLToPath(trimmed); } catch (_) { return null; }
    }
    const cwd = ownerCwd || getActiveCwd?.() || getSessionCwd(getActiveSessionId());
    const full = normalizeLocalPathForOpen(trimmed, cwd, false);
    if (!full) return null;
    return { absPath: full, isUrl: false, cwd };
  }

  function open(rawPath, x, y, ownerCwd) {
    const t = resolveTarget(rawPath, ownerCwd);
    if (!t) return false;
    currentTarget = t;

    for (const el of menuEl.querySelectorAll('[data-file-only]')) {
      el.style.display = t.isUrl ? 'none' : '';
    }
    const copyBtn = menuEl.querySelector('[data-action="copy-abs-path"]');
    const managerBtn = menuEl.querySelector('[data-action="open-file-manager"]');
    if (managerBtn) {
      managerBtn.disabled = t.isUrl;
      managerBtn.title = t.isUrl ? '网页 URL 没有对应的本地文件目录' : '在 Hub 右侧文件管理中打开所在目录';
    }
    if (copyBtn) {
      copyBtn.textContent = t.isUrl
        ? (copyBtn.dataset.labelUrl || '复制 URL')
        : (copyBtn.dataset.labelFile || '复制绝对路径');
    }

    menuEl.style.display = 'block';
    menuEl.style.left = `${x}px`;
    menuEl.style.top = `${y}px`;
    requestAnimationFrameFn(() => {
      const rect = menuEl.getBoundingClientRect();
      if (rect.right > window.innerWidth) menuEl.style.left = `${x - rect.width}px`;
      if (rect.bottom > window.innerHeight) menuEl.style.top = `${y - rect.height}px`;
    });
    return true;
  }

  function close() {
    menuEl.style.display = 'none';
    currentTarget = null;
  }

  async function runAction(action, target = currentTarget) {
    const t = target;
    if (!t) return;
    try {
      if (action === 'copy-abs-path') {
        clipboard.writeText(t.absPath);
      } else if (action === 'copy-file') {
        if (t.isUrl) return;
        const r = await ipcRenderer.invoke('clipboard-copy-file', t.absPath);
        if (r && r.error) console.warn('[path-link-ctx] copy-file failed:', r.error);
      } else if (action === 'open-file-manager') {
        if (t.isUrl) return;
        if (typeof openFileManager !== 'function') throw new Error('文件管理尚未就绪');
        const result = await openFileManager(t.absPath, t.cwd);
        if (!result || result.ok !== true) throw new Error(result?.error || '文件管理打开失败');
      } else if (action === 'show-in-folder') {
        if (t.isUrl) return;
        const r = await ipcRenderer.invoke('show-in-folder', t.absPath);
        if (r && r.error) console.warn('[path-link-ctx] show-in-folder failed:', r.error);
      } else if (action === 'open-external') {
        if (t.isUrl) {
          const r = await ipcRenderer.invoke('open-external-url', t.absPath);
          if (r && r.success === false) console.warn('[path-link-ctx] open-external-url failed for', t.absPath);
        } else {
          const err = await ipcRenderer.invoke('open-path', t.absPath);
          if (err) console.warn('[path-link-ctx] open-path returned:', err);
        }
      }
    } catch (e) {
      if (action === 'open-file-manager') showSyncStatus(`文件管理打开失败\n${e && e.message ? e.message : '路径不可读取'}`, 'error');
      console.warn('[path-link-ctx] action failed:', action, e && e.message);
    }
  }

  function init() {
    document.addEventListener('contextmenu', (e) => {
      if (!e.target || !e.target.closest) return;
      let rawPath = null;
      const ownerCwd = e.target.closest('[data-cwd]')?.dataset.cwd
        || getSessionCwd(e.target.closest('[data-session-id]')?.dataset.sessionId);
      // Priority 1: explicit rt-file-link anchor (path-link.js wrapped)
      const rtLink = e.target.closest('a.rt-file-link');
      if (rtLink) {
        rawPath = rtLink.dataset.path;
      } else {
        // Marked anchors also include file URLs and explicit relative paths.
        const httpLink = e.target.closest('a[href]');
        if (httpLink && !httpLink.closest('#preview-body')) {
          const href = httpLink.getAttribute('href') || '';
          if (/^https?:\/\//i.test(href)) rawPath = href;
          else rawPath = classifyLocalPathHref(href, ownerCwd || getActiveCwd?.() || getSessionCwd(getActiveSessionId()))?.openPath;
        }
      }
      if (!rawPath) return;
      const opened = open(rawPath, e.clientX, e.clientY, ownerCwd);
      if (opened) {
        e.preventDefault();
        e.stopPropagation();
      }
    }, true);

    document.addEventListener('mousedown', (e) => {
      if (menuEl.style.display === 'block' && !menuEl.contains(e.target)) {
        close();
      }
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && menuEl.style.display === 'block') {
        close();
      }
    });

    for (const btn of menuEl.querySelectorAll('.context-menu-item')) {
      btn.addEventListener('click', async () => {
        const action = btn.dataset.action;
        const t = currentTarget;
        close();
        if (t) await runAction(action, t);
      });
    }
  }

  return { init, open, close, runAction };
}

module.exports = { createPathLinkContextMenuController };
