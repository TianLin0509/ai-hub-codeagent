'use strict';
// Passive account workspace, with legacy check IPC retained for existing callers.
function registerHubAccountsIpc(ipcMain, accounts) {
  const wrap = fn => async (_event, payload = {}) => {
    try { return { ok: true, data: await fn(payload) }; }
    catch (e) { return { ok: false, error: e.message || '账号操作失败' }; }
  };
  ipcMain.handle('hub-accounts:state', wrap(() => accounts.passiveState()));
  ipcMain.handle('hub-accounts:attention', wrap(async () => (await accounts.passiveState()).attention));
  ipcMain.handle('hub-accounts:check', wrap(() => accounts.check()));
  const selection = p => {
    if (!p || typeof p !== 'object' || Array.isArray(p)) throw Error('账号参数无效');
    if (p.identity !== undefined && !['main', 'alt'].includes(p.identity)) throw Error('账号标识无效');
    if (p.site !== undefined && !require('../../core/hub-account-catalog').companyFor(p.site)) throw Error('公司标识无效');
    return { identity: p.identity, site: p.site };
  };
  ipcMain.handle('hub-accounts:check-start', wrap(p => accounts.startCheck({ ...selection(p), live: p.live === true })));
  ipcMain.handle('hub-accounts:check-cancel', wrap(() => accounts.cancelCheck()));
  ipcMain.handle('hub-accounts:tools', wrap(() => accounts.setup.discover()));
  ipcMain.handle('hub-accounts:tool-accounts', wrap(p => accounts.toolAccounts(p.refresh === true)));
  ipcMain.handle('hub-accounts:external', wrap(p => accounts.external({ service: p.service, action: p.action })));
  ipcMain.handle('hub-accounts:tools-connect', wrap(p => {
    if (accounts.checking || accounts.startingCheck) throw Error('请等待登录检查结束后接入工具');
    accounts.lastState = null;
    return accounts.setup.start(p.choices);
  }));
  ipcMain.handle('hub-accounts:open', wrap(p => accounts.open(selection(p))));
  ipcMain.handle('hub-accounts:copy-logins', wrap(p => accounts.copyLogins({ identity: selection(p).identity })));
  ipcMain.handle('hub-accounts:preference', wrap(p => accounts.preference({ ...selection(p), add: p.add === true })));
  ipcMain.handle('hub-accounts:login', wrap(p => {
    if (p.identity !== undefined && (typeof p.identity !== 'string' || !/^[\w-]{1,32}$/.test(p.identity))) throw new Error('身份标识无效');
    if (p.site !== undefined && (typeof p.site !== 'string' || !/^[a-z]{1,20}$/.test(p.site))) throw new Error('网站标识无效');
    return accounts.login({ identity: p.identity, site: p.site });
  }));
}
module.exports = { registerHubAccountsIpc };
