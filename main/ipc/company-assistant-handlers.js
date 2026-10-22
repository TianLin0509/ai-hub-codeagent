'use strict';
// 公司版「助理」页的主进程入口（2026-10-16）：页面只经这些 IPC 读状态、提问、改设置；
// 扫码登录、日历初始化只在用户点按钮时调用（core/company-assistant/service.js）。
function registerCompanyAssistantIpc(ipcMain, service) {
  const handlers = {
    status: () => service.status(),
    refresh: async () => { await service.refresh({ force: true }); return service.status(); },
    'brief-now': async () => { await service.generateBrief({ force: true }); return service.status(); },
    ask: request => ({ ok: true, item: service.ask(String(request?.text || ''), { entry: request?.entry === 'ppt' ? 'ppt' : '' }) }),
    'retry-chat': request => ({ ok: true, item: service.retryChat(String(request?.id || '')) }),
    'mark-done': request => service.markDone(String(request?.source || ''), request?.done !== false),
    source: request => service.sourceContext(String(request?.source || ''), request?.day),
    'set-settings': request => ({ ok: true, settings: service.setSettings(request || {}) }),
    memory: request => service.memory.execute(request || { op: 'list' }, { fromSettings: true }),
    login: async () => ({ ok: true, flow: await service.login() }),
    'setup-calendar': request => service.setupCalendar(String(request?.email || '')),
    // 「手机」设置页（2026-10-18）：选群、开关、推送范围；测试消息只发到选定的群。
    // 找 welink-cli（2026-10-19）：「再找一次」立刻全盘找；「手动选择…」弹系统选择框。
    'find-cli': async () => ({ ok: true, search: await service.findCli({ force: true }) }),
    'pick-cli': async () => {
      const { dialog, BrowserWindow } = require('electron');
      const r = await dialog.showOpenDialog(BrowserWindow.getFocusedWindow() || undefined, { title: '选择 welink-cli', properties: ['openFile'], filters: [{ name: 'welink-cli', extensions: ['exe', 'cmd'] }] });
      if (r.canceled || !r.filePaths[0]) return { ok: true, canceled: true };
      return service.useCliPath(r.filePaths[0]);
    },
    'phone-status': () => ({ ok: true, phone: service.phone.status(), conversations: service.status().conversations }),
    'phone-settings': request => service.setPhone(request || {}),
    'phone-test': async () => ({ ok: await service.phone.send('测试消息：Hub 能往这个群发消息。在这里直接跟我说话就行。', 'test') }),
    'phone-check-group': request => service.phone.checkGroup(String(request?.groupId || '')),
    'ppt-status': async () => ({ ok: true, ppt: await service.ppt.refresh({ force: true }) }),
    'ppt-query': request => service.ppt.execute(request?.op || 'status', request || {}),
    'ppt-open': request => service.ppt.open(String(request?.id || '')),
    'room-status': async () => { await service.rooms.tick(); return { ok: true, rooms: service.rooms.status() }; },
    'room-command': request => service.rooms.command(request?.op, request?.rules || {}, { user: true }),
    'room-connect': async () => ({ ok: true, rooms: await service.rooms.ensure({ user: true }) }),
    'room-discover': async () => ({ ok: true, rooms: await service.rooms.discover() }),
    'room-install': async () => ({ ok: true, rooms: await service.rooms.install() }),
    'room-pick': async () => {
      const { dialog } = require('electron');
      const r = await dialog.showOpenDialog({ title: '选择秘书终结者', properties: ['openFile'], filters: [{ name: '秘书终结者', extensions: ['exe'] }] });
      if (r.canceled || !r.filePaths[0]) return { ok: true, canceled: true };
      return { ok: true, rooms: service.rooms.useExecutable(r.filePaths[0]) };
    },
    'ppt-pick-index': async () => {
      const { dialog } = require('electron');
      const r = await dialog.showOpenDialog({ title: '选择 PPT Doctor 文字索引', properties: ['openFile'], filters: [{ name: 'SQLite 索引', extensions: ['db', 'sqlite', 'sqlite3'] }] });
      if (r.canceled || !r.filePaths[0]) return { ok: true, canceled: true };
      service.setSettings({ ppt: { db: r.filePaths[0] } });
      return { ok: true, ppt: await service.ppt.refresh({ force: true }) };
    },
    // 「打开会话」：助理会话关着就先按原生身份恢复，再交给界面选中。
    'open-session': async () => {
      const id = await service.ensureSession();
      return { ok: true, sessionId: id };
    },
    // 「重开助理会话」（v3.1.1，助理页「会话工具：未接上」旁的按钮）：按原会话重新启动，重新挂上会话工具。
    'reopen-session': () => service.reopenSession(),
  };
  Object.assign(handlers, require('../../core/company-assistant/ppt-ipc').createPptHandlers(service));
  for (const [name, handler] of Object.entries(handlers)) {
    ipcMain.handle('company-assistant:' + name, async (_event, request = {}) => {
      try { return await handler(request); } catch (error) { return { ok: false, error: error.message }; }
    });
  }
  return service;
}

module.exports = { registerCompanyAssistantIpc };
