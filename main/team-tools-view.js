'use strict';
// Remote sites are top-level, sandboxed web contents. They never receive a preload or Hub IPC authority.
function createTeamToolsView({ getWindow, WebContentsView, session, catalog, onChanged = () => {} }) {
  const byId = new Map(catalog.map(item => [item.id, item]));
  const origins = new Set(catalog.map(item => new URL(item.url).origin));
  let view = null, attachedTo = null, current = null, phase = 'idle', error = null, epoch = 0;
  const allowed = value => {
    try { const u = new URL(value); return origins.has(u.origin) && ['https:', 'http:'].includes(u.protocol) && !u.username && !u.password; }
    catch { return false; }
  };
  const state = () => ({ ok: true, id: current?.id || null, name: current?.name || null, phase, error, visible: !!attachedTo });
  const emit = () => onChanged(state());
  function bounds(value) {
    if (!view || !attachedTo) return;
    const [width, height] = attachedTo.getContentSize();
    const v = value || {};
    if (!['x', 'y', 'width', 'height'].every(k => Number.isFinite(v[k]))) throw new Error('网页区域尚未准备好，请重新打开');
    const zoom = attachedTo.webContents.getZoomFactor();
    const x = Math.min(width, Math.max(0, Math.round(v.x * zoom))), y = Math.min(height, Math.max(0, Math.round(v.y * zoom)));
    view.setBounds({ x, y, width: Math.min(width - x, Math.max(0, Math.round(v.width * zoom))), height: Math.min(height - y, Math.max(0, Math.round(v.height * zoom))) });
  }
  function close() {
    epoch += 1;
    if (attachedTo && !attachedTo.isDestroyed()) attachedTo.contentView.removeChildView(view);
    attachedTo = null;
    emit();
    return state();
  }
  function ensure() {
    if (view && !view.webContents.isDestroyed()) return;
    const partition = 'persist:team-tools';
    const webSession = session.fromPartition(partition);
    webSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
    webSession.setPermissionCheckHandler(() => false);
    view = new WebContentsView({ webPreferences: { partition, sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, spellcheck: false } });
    const wc = view.webContents;
    const guard = (event, url) => {
      if (!allowed(url)) { event.preventDefault(); error = '此链接不属于已接入的团队站点，请从原浏览器打开。'; emit(); }
    };
    wc.on('will-navigate', guard);
    wc.on('will-redirect', guard);
    wc.setWindowOpenHandler(({ url }) => {
      if (allowed(url)) void wc.loadURL(url).catch(e => { error = e.message; phase = 'error'; emit(); });
      else { error = '已阻止未接入站点的新窗口。'; emit(); }
      return { action: 'deny' };
    });
    wc.on('did-start-loading', () => { phase = 'loading'; error = null; emit(); });
    wc.on('did-stop-loading', () => { if (phase !== 'error') phase = 'ready'; emit(); });
    wc.on('did-fail-load', (_e, code, description, _url, isMainFrame) => {
      if (isMainFrame && code !== -3) { phase = 'error'; error = `网页未能打开：${description}，可以重试或返回团队页。`; emit(); }
    });
    wc.on('render-process-gone', () => { phase = 'error'; error = '网页进程已停止，重新打开即可恢复。'; emit(); });
  }
  async function open({ id, bounds: rectangle, reload = false } = {}) {
    const item = byId.get(id);
    if (!item) throw new Error('没有这个团队工具入口');
    if (!rectangle || !['x', 'y', 'width', 'height'].every(k => Number.isFinite(rectangle[k])) || rectangle.width < 1 || rectangle.height < 1) throw new Error('网页区域尚未准备好，请重新打开');
    const win = getWindow();
    if (!win || win.isDestroyed()) throw new Error('Hub 窗口尚未准备好');
    ensure();
    if (attachedTo && attachedTo !== win) close();
    if (!attachedTo) { win.contentView.addChildView(view); attachedTo = win; }
    bounds(rectangle);
    const changed = current?.id !== id;
    current = item;
    if (changed || reload || phase === 'error' || !view.webContents.getURL()) {
      const token = ++epoch;
      phase = 'loading'; error = null; emit();
      // Do not block an IPC until a remote network request finishes. Closing the page always remains possible.
      void view.webContents.loadURL(item.url).catch(e => { if (token === epoch) { phase = 'error'; error = `网页未能打开：${e.message}`; emit(); } });
    }
    emit();
    return state();
  }
  function dispose() {
    close();
    if (view && !view.webContents.isDestroyed()) view.webContents.close({ waitForBeforeUnload: false });
    view = null; current = null;
  }
  return { open, close, bounds: rectangle => { bounds(rectangle); return state(); }, state, dispose };
}
module.exports = { createTeamToolsView };
