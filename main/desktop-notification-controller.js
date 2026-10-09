'use strict';

const NOTIFICATION_WIDTH = 392;
const NOTIFICATION_HEIGHT = 172;
const NOTIFICATION_MARGIN = 18;
const AUTO_HIDE_MS = 9000;

function cleanInline(value, maxLength) {
  return String(value == null ? '' : value)
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

function normalizeDesktopNotificationPayload(payload = {}) {
  const sessionId = cleanInline(payload.sessionId, 160);
  if (!sessionId) return null;
  return {
    sessionId,
    title: cleanInline(payload.title, 100) || 'AI 会话',
    body: cleanInline(payload.body, 240) || '本轮回答已经完成，点击回到会话查看。',
    kind: cleanInline(payload.kind, 32),
    completedAt: Number(payload.completedAt) || Date.now(),
    readyCount: Math.max(1, Math.min(99, Number(payload.readyCount) || 1)),
    newCount: Math.max(1, Math.min(99, Number(payload.newCount) || 1)),
    autoHideMs: AUTO_HIDE_MS,
  };
}

function notificationBounds(screen, mainWindow) {
  const fallback = { workArea: { x: 0, y: 0, width: 1280, height: 800 } };
  let display = fallback;
  try {
    if (screen && typeof screen.getDisplayMatching === 'function' && mainWindow && !mainWindow.isDestroyed?.()) {
      display = screen.getDisplayMatching(mainWindow.getBounds()) || fallback;
    } else if (screen && typeof screen.getPrimaryDisplay === 'function') {
      display = screen.getPrimaryDisplay() || fallback;
    }
  } catch (_) {}
  const area = display.workArea || fallback.workArea;
  return {
    x: Math.round(area.x + area.width - NOTIFICATION_WIDTH - NOTIFICATION_MARGIN),
    y: Math.round(area.y + area.height - NOTIFICATION_HEIGHT - NOTIFICATION_MARGIN),
    width: NOTIFICATION_WIDTH,
    height: NOTIFICATION_HEIGHT,
  };
}

function createDesktopNotificationController({
  BrowserWindow,
  screen,
  ipcMain,
  htmlPath,
  preloadPath,
  getMainWindow,
  focusPrimaryWindow,
  sendToRenderer,
  canShow = () => true,
  logger = console,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
  waitForPaint = ms => new Promise(resolve => setTimeout(resolve, ms)),
} = {}) {
  if (typeof BrowserWindow !== 'function') throw new Error('BrowserWindow is required');
  if (!ipcMain || typeof ipcMain.on !== 'function') throw new Error('ipcMain is required');
  let notificationWindow = null;
  let readyPromise = null;
  let autoHideTimer = null;
  let disposed = false;

  function hide() {
    if (autoHideTimer) clearTimeoutFn(autoHideTimer);
    autoHideTimer = null;
    if (notificationWindow && !notificationWindow.isDestroyed()) notificationWindow.hide();
  }

  function dismiss() {
    hide();
    if (notificationWindow && !notificationWindow.isDestroyed()) notificationWindow.destroy();
    notificationWindow = null;
    readyPromise = null;
  }

  function ensureWindow() {
    if (notificationWindow && !notificationWindow.isDestroyed()) return notificationWindow;
    notificationWindow = new BrowserWindow({
      width: NOTIFICATION_WIDTH,
      height: NOTIFICATION_HEIGHT,
      show: false,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      focusable: false,
      alwaysOnTop: true,
      hasShadow: true,
      webPreferences: {
        preload: preloadPath,
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
      },
    });
    try { notificationWindow.setAlwaysOnTop(true, 'floating'); } catch (_) {}
    notificationWindow.setMenuBarVisibility?.(false);
    notificationWindow.webContents.setWindowOpenHandler?.(() => ({ action: 'deny' }));
    let settleReady = null;
    readyPromise = new Promise((resolve) => {
      let settled = false;
      settleReady = (value) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      notificationWindow.webContents.once('did-finish-load', () => settleReady(true));
      notificationWindow.webContents.once('did-fail-load', (_event, code, description) => {
        logger.warn?.(`[desktop-notification] UI load failed (${code}): ${description}`);
        settleReady(false);
      });
    });
    notificationWindow.on('closed', () => {
      settleReady?.(false);
      notificationWindow = null;
      readyPromise = null;
    });
    try {
      Promise.resolve(notificationWindow.loadFile(htmlPath)).catch(error => {
        logger.warn?.('[desktop-notification] loadFile failed:', error && error.message);
        settleReady?.(false);
      });
    } catch (error) {
      logger.warn?.('[desktop-notification] loadFile threw:', error && error.message);
      settleReady?.(false);
    }
    return notificationWindow;
  }

  async function show(payload) {
    if (disposed) return false;
    const normalized = normalizeDesktopNotificationPayload(payload);
    if (!normalized) return false;
    const win = ensureWindow();
    const loaded = await readyPromise;
    if (!loaded || disposed || !win || win.isDestroyed()) return false;
    const mainWindow = typeof getMainWindow === 'function' ? getMainWindow() : null;
    win.setBounds(notificationBounds(screen, mainWindow), false);
    win.webContents.send('desktop-notification:payload', normalized);
    // Transparent Windows surfaces can expose a partially invalidated first
    // frame when shown in the same tick as the DOM update. Give Chromium one
    // short compositor window, then show without taking keyboard focus.
    await waitForPaint(48);
    if (disposed || !notificationWindow || notificationWindow !== win || win.isDestroyed()) return false;
    if (canShow()) win.showInactive();
    if (autoHideTimer) clearTimeoutFn(autoHideTimer);
    // Destroy after the visible lifetime instead of retaining a hidden
    // BrowserWindow. A hidden auxiliary window can otherwise keep Electron
    // alive after the primary webContents is closed by recovery/CDP tooling.
    autoHideTimer = setTimeoutFn(dismiss, normalized.autoHideMs);
    return true;
  }

  function isMainRenderer(sender) {
    const mainWindow = typeof getMainWindow === 'function' ? getMainWindow() : null;
    return !!(mainWindow && !mainWindow.isDestroyed?.() && sender === mainWindow.webContents);
  }

  function isNotificationRenderer(sender) {
    return !!(notificationWindow && !notificationWindow.isDestroyed() && sender === notificationWindow.webContents);
  }

  const onShow = (event, payload) => {
    if (!event || !isMainRenderer(event.sender)) return;
    void show(payload);
  };
  const onOpen = (event, payload = {}) => {
    if (!event || !isNotificationRenderer(event.sender)) return;
    const sessionId = cleanInline(payload.sessionId, 160);
    if (!sessionId) return;
    dismiss();
    try { focusPrimaryWindow?.(); } catch (_) {}
    try { sendToRenderer?.('desktop-notification:open-session', { sessionId }); } catch (_) {}
  };
  const onDismiss = (event) => {
    if (!event || !isNotificationRenderer(event.sender)) return;
    dismiss();
  };

  ipcMain.on('desktop-notification:show', onShow);
  ipcMain.on('desktop-notification:open', onOpen);
  ipcMain.on('desktop-notification:dismiss', onDismiss);

  function dispose() {
    if (disposed) return;
    disposed = true;
    dismiss();
    ipcMain.removeListener?.('desktop-notification:show', onShow);
    ipcMain.removeListener?.('desktop-notification:open', onOpen);
    ipcMain.removeListener?.('desktop-notification:dismiss', onDismiss);
  }

  return {
    dispose,
    dismiss,
    hide,
    show,
    getWindow: () => notificationWindow,
  };
}

module.exports = {
  AUTO_HIDE_MS,
  NOTIFICATION_HEIGHT,
  NOTIFICATION_MARGIN,
  NOTIFICATION_WIDTH,
  createDesktopNotificationController,
  normalizeDesktopNotificationPayload,
  notificationBounds,
};
