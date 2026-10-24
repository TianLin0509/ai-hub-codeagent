'use strict';
function registerTeamWorkspaceIpc(ipcMain, { workspace, web, getWindow, access = new (require('../../core/team-workspace/access').TeamAccess)(), onUnlock = () => {}, onLock = () => {} }) {
  const allowed = event => {
    const win = getWindow();
    return !!win && !win.isDestroyed() && event.sender === win.webContents && event.senderFrame === win.webContents.mainFrame;
  };
  const methods = {
    'team:access': () => access.status(),
    'team:unlock': async request => {
      access.unlock(request.password);
      try { await onUnlock(); } catch (e) { access.lock(); await onLock(); throw e; }
      return access.status();
    },
    'team:lock': async () => { access.lock(); await onLock(); return access.status(); },
    'team:state': () => workspace.state(),
    'team:call': request => workspace.execute(request),
    'team:web-open': request => web.open(request),
    'team:web-bounds': request => web.bounds(request.bounds),
    'team:web-close': () => web.close(),
  };
  for (const [channel, run] of Object.entries(methods)) ipcMain.handle(channel, async (event, request = {}) => {
    if (!allowed(event)) return { ok: false, error: '此页面不能访问团队工作台' };
    try {
      if (!['team:access', 'team:unlock', 'team:lock'].includes(channel)) access?.assert();
      return { ok: true, ...await run(request || {}) };
    }
    catch (e) { return { ok: false, error: e.message || '操作未完成，请重试' }; }
  });
}
module.exports = { registerTeamWorkspaceIpc };
