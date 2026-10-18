'use strict';
// 公司版「助理」页的主进程入口（2026-10-16）：页面只经这些 IPC 读状态、提问、改设置；
// 扫码登录、日历初始化只在用户点按钮时调用（core/company-assistant/service.js）。
function registerCompanyAssistantIpc(ipcMain, service) {
  const handlers = {
    status: () => service.status(),
    refresh: async () => { await service.refresh({ force: true }); return service.status(); },
    'brief-now': async () => { await service.generateBrief({ force: true }); return service.status(); },
    ask: request => ({ ok: true, item: service.ask(String(request?.text || '')) }),
    'retry-chat': request => ({ ok: true, item: service.retryChat(String(request?.id || '')) }),
    'mark-done': request => service.markDone(String(request?.source || ''), request?.done !== false),
    'set-settings': request => ({ ok: true, settings: service.setSettings(request || {}) }),
    login: async () => ({ ok: true, flow: await service.login() }),
    'setup-calendar': request => service.setupCalendar(String(request?.email || '')),
    // 「手机」设置页（2026-10-18）：选群、开关、推送范围；测试消息只发到选定的群。
    'phone-status': () => ({ ok: true, phone: service.phone.status(), conversations: service.status().conversations }),
    'phone-settings': request => service.setPhone(request || {}),
    'phone-test': async () => ({ ok: await service.phone.send('测试消息：Hub 能往这个群发消息。在这里直接跟我说话就行。', 'test') }),
    'phone-check-group': request => service.phone.checkGroup(String(request?.groupId || '')),
    // 「打开会话」：助理会话关着就先按原生身份恢复，再交给界面选中。
    'open-session': async () => {
      const id = await service.ensureSession();
      return { ok: true, sessionId: id };
    },
  };
  for (const [name, handler] of Object.entries(handlers)) {
    ipcMain.handle('company-assistant:' + name, async (_event, request = {}) => {
      try { return await handler(request); } catch (error) { return { ok: false, error: error.message }; }
    });
  }
  return service;
}

module.exports = { registerCompanyAssistantIpc };
