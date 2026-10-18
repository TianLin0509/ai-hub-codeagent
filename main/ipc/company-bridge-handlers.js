'use strict';
// 家里联动的主进程入口（2026-10-15）：家里 Hub 与公司 Hub 共用一组 IPC，按本机角色接到不同的服务。
//   家里：生成配对码、看往来、挂载范围；公司：粘贴配对码、代码位置与说明、模型、放行页。
// 公司一端没解锁隐藏入口前（core/company-bridge/unlock.js），只回答「是公司角色、未解锁」和解锁本身，其余一律拒绝。
function registerCompanyBridgeIpc(ipcMain, service, { openGate } = {}) {
  const role = service.status().role;
  const handlers = {
    status: () => service.status(),
    'check-now': () => service.checkNow(),
    'set-settings': request => ({ ok: true, settings: service.setSettings(request || {}) }),
    unpair: () => service.unpair(),
    'image-send': async request => {
      const { t } = service.images.requireContext(String(request?.thread || ''), null, request?.round);
      if (!t.sessionId) throw new Error('等所属会话建立后再发图片');
      return { ok: true, image: await service.images.send(t.sessionId, request) };
    },
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
    // 通道串里的「补收」按钮（2026-10-16）：和会话里 AI 调 recollect_company 是同一个动作，编号须属于这个会话。
    // 公司联动面板的「让公司 Hub 更新」（2026-10-17）：和 company_hub_update 工具同一个动作。
    handlers['hub-admin'] = request => service.hubAdmin({ op: String(request?.op || 'update'), force: request?.force === true,
      ...(request?.op === 'diag' ? { sections: request.sections, lines: request.lines } : {}),
      ...(request?.op === 'act' ? { action: String(request.action || ''), params: request.params || {} } : {}) });
    // 卡片上的远程维护按钮（2026-10-18 三期）：等回报期间每次调用顺带看一眼通道。
    handlers['act-result'] = async request => {
      const id = String(request?.id || '');
      if (service.actView(id).status === '等待回报') await service.checkNow().catch(() => {});
      return { ok: true, ...service.actView(id) };
    };
    // 「公司电脑状态」卡片（2026-10-18 直查）：等回报期间每次调用顺带看一眼通道，回报到了就返回完整内容。
    handlers['diag-result'] = async request => {
      const id = request?.id ? String(request.id) : '';
      if (id && service.diagView(id).status === '等待回报') await service.checkNow().catch(() => {});
      return { ok: true, ...service.diagLatest(id || undefined) };
    };
    handlers.recollect = request => service.recollect(String(request?.sessionId || ''), { thread: String(request?.thread || '') });
  } else {
    handlers.pair = request => service.pair(String(request?.code || ''));
    handlers.retry = request => service.retry(String(request?.id || ''));
    handlers['open-gate'] = async () => {
      const url = service.status().net?.gate?.url || service.link.client().gatePage();
      if (openGate) await openGate(url);
      return service.checkNow();
    };
  }
  const locked = () => role === 'company' && !service.unlocked();
  if (role === 'company') {
    handlers.status = () => locked() ? { ok: true, role: 'company', unlocked: false } : service.status();
    handlers.unlock = request => ({ ok: true, unlocked: service.unlock(String(request?.text || '')) });
  }
  const open = new Set(['status', 'unlock']);
  for (const [name, handler] of Object.entries(handlers)) {
    ipcMain.handle('bridge:' + name, async (_event, request = {}) => {
      try {
        if (!open.has(name) && locked()) throw new Error('功能未启用');
        return await handler(request);
      } catch (error) { return { ok: false, error: error.message }; }
    });
  }
  return service;
}

module.exports = { registerCompanyBridgeIpc };
