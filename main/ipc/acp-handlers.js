'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { getConfigPath, getConfig, clearConfigCache } = require('../../core/hub-config');
const { ACP_KINDS, PLAN_BASE_URL } = require('../../core/acp-profiles');
function publicSettings(config) {
  const value = config.acp || {};
  return { nodePath: value.nodePath || '', baseURL: value.baseURL || PLAN_BASE_URL,
    apiKeySet: !!value.apiKey, providers: value.providers || {} };
}
function registerAcpIpc(ipcMain, {sessionManager} = {}) {
  ipcMain.handle('acp:queue', (_event, {sessionId,id,action,epoch} = {}) => {
    const session=sessionManager?.getNativeSession(sessionId);
    if(session?.isCliProvider)throw new Error('请在 CLI 中管理待发送消息');
    if(!session?.promptQueue)throw new Error('ACP 会话不可用');
    if(epoch!==session.runtime.epoch)throw new Error('待发送消息来自旧连接');
    if(action==='read') {
      const record=session.promptQueue.records.find(r=>r.id===id);
      if(!record)throw new Error('消息已发送或移除');
      return {ok:true,text:record.text};
    }
    return session.promptQueue.action(id,action,epoch);
  });
  ipcMain.handle('acp:tool-result', async (_event, reference = {}) => {
    const session = sessionManager?.getNativeSession(reference.hubSessionId);
    if (!session?.readToolResult || session.options?.kind && !ACP_KINDS.includes(session.options.kind)) throw new Error('原生工具来源不可用，请重新载入会话');
    await session.start();
    return session.readToolResult(reference);
  });
  ipcMain.handle('acp:settings:get', () => publicSettings(getConfig()));
  ipcMain.handle('acp:settings:save', (_event, request = {}) => {
    try {
      const configPath = getConfigPath();
      let config = {};
      try { config = JSON.parse(fs.readFileSync(configPath, 'utf8').replace(/^\uFEFF/, '')); }
      catch (error) { if (error.code !== 'ENOENT') throw new Error('现有配置无法读取，未覆盖'); }
      const previous = config.acp || {};
      const providers = {};
      for (const kind of ACP_KINDS) {
        const value = request.providers?.[kind] || previous.providers?.[kind] || {};
        providers[kind] = {};
        for (const key of ['entryPath','backendPath','bridgePath','model','mcpConfigPath']) {
          if (value[key] != null && typeof value[key] !== 'string') throw new Error('配置字段必须是文字');
          providers[kind][key] = (value[key] || '').trim();
        }
      }
      if (request.apiKey != null && typeof request.apiKey !== 'string') throw new Error('Key 格式无效');
      config.acp = { nodePath: String(request.nodePath || previous.nodePath || '').trim(),
        baseURL: PLAN_BASE_URL, providers, apiKey: request.apiKey?.trim() || previous.apiKey || '' };
      fs.mkdirSync(path.dirname(configPath), { recursive: true });
      const temp = configPath + '.' + randomUUID() + '.tmp';
      fs.writeFileSync(temp, JSON.stringify(config, null, 2), { encoding: 'utf8', mode: 0o600 });
      fs.renameSync(temp, configPath);
      clearConfigCache();
      return { ok: true, settings: publicSettings(config) };
    } catch (error) { return { ok: false, message: error.message }; }
  });
}
module.exports = { registerAcpIpc, publicSettings };
