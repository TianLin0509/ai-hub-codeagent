'use strict';
// 公司版「论坛」页的主进程入口（2026-10-18）：页面只经这些 IPC 读状态、同步、改设置；
// 登录窗口只在用户点「登录」时弹出；点帖子用系统浏览器打开，只放行两个站点的网址（core/company-forum/service.js）。
function registerCompanyForumIpc(ipcMain, service, { shell, browser } = {}) {
  const handlers = {
    status: () => service.status(),
    sync: async () => { await service.sync({ reason: 'manual' }); return service.status(); },
    // 打开论坛页：今天还没同步就开始（不等结果）。
    'ensure-today': () => { const st = service.status(); if (!st.today && !st.syncing && st.settings.enabled) void service.sync({ reason: 'open' }).catch(() => {}); return service.status(); },
    summarize: () => service.summarize(service.status().day),
    login: request => service.login(String(request?.site || '')),
    'set-settings': request => ({ ok: true, settings: service.setSettings(request || {}) }),
    'open-url': async request => {
      const url = String(request?.url || '');
      if (!service.allowedUrl(url)) throw new Error('只能打开论坛站点的网址');
      await shell.openExternal(url);
      return { ok: true };
    },
    'clear-login': async () => { await browser?.clearLogin?.(); return { ok: true }; },
    'open-session': async () => ({ ok: true, sessionId: await service.ensureSession() }),
  };
  for (const [name, handler] of Object.entries(handlers)) {
    ipcMain.handle('company-forum:' + name, async (_event, request = {}) => {
      try { return await handler(request); } catch (error) { return { ok: false, error: error.message }; }
    });
  }
  return service;
}

module.exports = { registerCompanyForumIpc };
