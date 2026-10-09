'use strict';
// Compatibility entry for legacy account IPC and roundtable login recovery.
// All webpage opens use the same Hub profile; old per-site directories stay untouched.
const { HubAccounts } = require('./hub-accounts');
const { HubChrome } = require('./hub-chrome');
const path = require('path'), os = require('os');
const key = provider => provider === 'gemini' ? 'google' : provider;
class HubAccountBrowser {
  constructor({ env = process.env, dataDir, accounts } = {}) {
    const custom = dataDir && path.resolve(dataDir).toLowerCase() !== path.join(os.homedir(), '.ai-hub-community').toLowerCase();
    const scoped = (env.CLAUDE_HUB_HOME_DIR || env.CLAUDE_HUB_DATA_DIR || custom) ? { ...env, CLAUDE_HUB_DATA_DIR: env.CLAUDE_HUB_DATA_DIR || dataDir } : env;
    this.accounts = accounts || new HubAccounts({ env: scoped, hubChrome: new HubChrome({ env: scoped }) });
  }
  open(provider) { return this.accounts.open({ site: key(provider), identity: 'main' }); }
  async check(provider) {
    // Legacy snapshot refresh stays passive; live checks belong to the account-page job.
    const state = await this.accounts.state();
    const site = state.identities.find(i => i.id === 'main')?.sites.find(s => s.key === key(provider));
    if (!site) throw Error('不支持的网页登录');
    return { state: site.state === 'signed_in' && !site.stale ? 'signed_in' : site.state === 'signed_out' ? 'login_required' : 'unknown',
      message: site.stale ? '上次检查结果；请在账号页检查登录' : '登录资料保留在 AI Hub 专属 Chrome；请在账号页检查登录', source: 'AI Hub 专属 Chrome' };
  }
  async command() { throw Error('请在 AI Hub 专属 Chrome 官网窗口完成登录'); }
  async submitCode() { throw Error('请在 AI Hub 专属 Chrome 官网窗口输入验证码'); }
}
module.exports = { HubAccountBrowser };
