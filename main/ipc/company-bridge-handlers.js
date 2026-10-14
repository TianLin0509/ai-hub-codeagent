'use strict';
// 家里联动的主进程入口（2026-10-15）：家里 Hub 与公司 Hub 共用一组 IPC，按本机角色接到不同的服务。
//   家里：生成配对码、看往来、挂载范围；公司：粘贴配对码、代码位置与说明、模型、放行页。
function registerCompanyBridgeIpc(ipcMain, service, { openGate } = {}) {
  const role = service.status().role;
  const handlers = {
    status: () => service.status(),
    'check-now': () => service.checkNow(),
    'set-settings': request => ({ ok: true, settings: service.setSettings(request || {}) }),
    unpair: () => service.unpair(),
    // 「打开 / 找回会话」：会话已关闭（不在当前 Hub 里）就先按原生身份恢复，再交给界面选中。
    'open-session': async request => {
      const id = String(request?.sessionId || '');
      if (!/^[a-zA-Z0-9_-]{1,160}$/.test(id)) throw new Error('会话编号无效');
      if (service.deps.getSession(id)) return { ok: true, resumed: false };
      if (!service.deps.getSessionMetadata?.(id)) throw new Error('这个会话的记录已经不在了');
      await service.deps.resumeSession(id);
      if (!service.deps.getSession(id)) throw new Error('会话没能恢复');
      return { ok: true, resumed: true };
    },
  };
  if (role === 'home') {
    handlers['create-pairing'] = () => service.createPairing();
    handlers['send-pairing'] = () => service.sendPairingToInbox();
  } else {
    handlers.pair = request => service.pair(String(request?.code || ''));
    handlers.retry = request => service.retry(String(request?.id || ''));
    handlers['open-gate'] = async () => {
      const url = service.status().net?.gate?.url || service.link.client().gatePage();
      if (openGate) await openGate(url);
      return service.checkNow();
    };
  }
  for (const [name, handler] of Object.entries(handlers)) {
    ipcMain.handle('bridge:' + name, async (_event, request = {}) => { try { return await handler(request); } catch (error) { return { ok: false, error: error.message }; } });
  }
  return service;
}

module.exports = { registerCompanyBridgeIpc };
