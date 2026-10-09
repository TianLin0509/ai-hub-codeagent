'use strict';

// Only an explicit login failure opens a window. Network failures and unknown
// observations must never log a user out or repeatedly create login windows.
class LaunchAuth {
  constructor({accounts, getConfig, notify = () => {}}) {
    Object.assign(this, {accounts, getConfig, notify});
    this.flights = new Map();
    this.recoveryAt = new Map();
  }
  connection(kind, opts = {}) {
    const base = String(kind || '').replace(/-resume$/, '');
    const config = this.getConfig();
    if (base === 'codex') {
      if (config.codexBackend === 'api' || require('./chatgpt-web-models').isChatgptWebModel(opts.model)) return null;
      return 'codex-' + (opts.launchProfile || config.codexSubscriptionProfile || 'default');
    }
    if (base === 'claude') return config.claudeBackend === 'api' ? null : 'claude';
    return ({gemini:'gemini-cli', kimi:'kimi'})[base] || null;
  }
  async ensure(kind, opts = {}) {
    const id = this.connection(kind, opts);
    if (!id) return;
    if (this.flights.has(id)) return this.flights.get(id);
    const flight = this.checkAndOpen(id).finally(() => this.flights.delete(id));
    this.flights.set(id, flight);
    return flight;
  }
  async recover(kind, opts, failure) {
    if (!isLoginFailure(failure)) return;
    const id=this.connection(kind,{...opts,launchProfile:opts?.codexProfile});
    if (!id || Date.now()-(this.recoveryAt.get(id)||0)<60000) return;
    this.recoveryAt.set(id,Date.now());
    try {
      const result=await this.accounts.login(id);
      this.notify({id,pending:result.pending!==false,message:'登录已失效，已打开对应账号的官方登录界面；完成后请恢复或重启会话，已发送的问题不会自动重发。'});
    } catch(error) {this.notify({id,success:false,message:'需要登录，登录入口未能打开：'+error.message});}
  }
  async checkAndOpen(id) {
    let proof;
    try { proof = await this.accounts.check(id, {quiet:true, resume:false}); }
    catch { return; } // Preserve the normal launch error when status is unknown.
    if (proof.state !== 'login_required') return;
    let result;
    try { result = await this.accounts.login(id); }
    catch (error) { throw Object.assign(new Error('需要登录，但登录入口未能打开：' + error.message), {code:'auth_required'}); }
    const message = '已打开对应账号的官方登录界面，请完成登录后再启动；本次尚未启动会话。';
    this.notify({id, message, pending:result.pending !== false});
    throw Object.assign(new Error(message), {code:'auth_required'});
  }
}
function isLoginFailure(failure) {
  if (failure?.code==='auth_required') return true;
  const text=typeof failure==='string'?failure:failure?.message || '';
  return /(?:^|\n|:\s)(?:not logged in|please (?:run )?\/login|authentication required|login required|oauth token (?:has )?expired|登录失效|需要登录)/i.test(text)
    || /\b401\b[^\n]{0,60}\bunauthorized\b/i.test(text);
}
module.exports = {LaunchAuth,isLoginFailure};
