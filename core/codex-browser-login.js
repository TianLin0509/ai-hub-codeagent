'use strict';
const fs = require('fs');
const path = require('path');

function loginIdentity(row, chrome) {
  let profiles = {};
  try { profiles = JSON.parse(fs.readFileSync(path.join(chrome.root, 'Local State'), 'utf8')).profile?.info_cache || {}; }
  catch (error) { if (error.code !== 'ENOENT') throw Error('浏览器账号资料不可读，请在账号页确认'); }
  const expected = row.accountLabel || '';
  const matches = ['main','alt'].filter(id => expected && profiles[id]?.user_name?.toLowerCase() === expected.toLowerCase());
  const identity = row.browserIdentity || (matches.length === 1 ? matches[0] : /副/.test(row.profileLabel || '') ? 'alt' : 'main');
  if (!['main','alt'].includes(identity)) throw Error('Codex 对应的浏览器账号无效');
  return {identity, expected:expected || profiles[identity]?.user_name || ''};
}

class CodexBrowserLogin {
  constructor({createClient, chrome, onComplete = () => {}} = {}) {
    this.createClient = createClient || (options => new (require('../main/codex-app-server-client').CodexAppServerClient)(options));
    this.chrome = chrome || new (require('./hub-chrome').HubChrome)({proxy:()=>require('./hub-config').getConfig().proxy});
    this.onComplete = onComplete;
    this.flights = new Map();
  }
  async login(row, env) {
    if (this.flights.has(row.home)) return {pending:true, message:'该 Codex 账号的官方授权页已打开'};
    const binding = loginIdentity(row, this.chrome);
    const client = this.createClient({cwd:row.home, env:{...env,CODEX_HOME:row.home}, args:['-c','forced_login_method="chatgpt"']});
    const entry = {client};
    this.flights.set(row.home, entry);
    const finish = async success => {
      if (this.flights.get(row.home) !== entry) return;
      if (entry.finishing) return;
      entry.finishing=true;clearTimeout(entry.timer);
      try {
        if (success && binding.expected) {
          const account = await client.request('account/read', {refreshToken:false});
          if (account.account?.type !== 'chatgpt' || account.account?.email?.toLowerCase() !== binding.expected.toLowerCase()) {
            await client.request('account/logout');
            this.onComplete({id:row.id, success:false, message:'授权返回了另一个账号，请使用对应账号重新登录'});
            return;
          }
        }
        this.onComplete({id:row.id, success, message:success ? 'Codex 订阅授权已完成，可以重新启动' : 'Codex 授权未完成，请在账号页重试'});
      } finally {
        client.close();await client.waitForExit();
        if(this.flights.get(row.home)===entry)this.flights.delete(row.home);
      }
    };
    client.on('notification', msg => {
      if (msg.method === 'account/login/completed') void finish(msg.params?.success === true).catch(() => {});
    });
    client.on('disconnect', () => { void finish(false).catch(() => {}); });
    entry.timer = setTimeout(() => { void finish(false).catch(() => {}); }, 10 * 60 * 1000);
    entry.timer.unref?.();
    try {
      await client.start();
      const result = await client.request('account/login/start', {type:'chatgpt'});
      const url = new URL(result.authUrl);
      if (url.protocol !== 'https:' || url.hostname !== 'auth.openai.com') throw Error('官方授权地址无效');
      await this.chrome.lifecycle(() => this.chrome._openOrdinary(binding.identity, result.authUrl));
      return {pending:true, message:'已在对应浏览器账号打开 Codex 官方授权页；完成后自动确认'};
    } catch (error) { await finish(false); throw error; }
  }
  close() { for (const entry of this.flights.values()) {clearTimeout(entry.timer); entry.client.close();} this.flights.clear(); }
}
module.exports = {CodexBrowserLogin, loginIdentity};
