'use strict';

// Only an explicit login failure opens a window. Network failures and unknown
// observations must never log a user out or repeatedly create login windows.
//
// 2026-10-14: every probe is a child process (`claude auth status` ~0.5–0.8 s,
// `codex login status` ~0.2–0.3 s) and starting one on Windows blocks the main
// process for 20–190 ms. Creating a two-member group used to probe four times
// in a row. A launch now reuses the account center's stored observation of the
// same account (id, home, credential) and the same local login files: a login
// seen within the account page's own freshness window (5 min), an inconclusive
// probe within a minute. The stored observation is the only record, so a newer
// "login required" — from a check or from a running CLI via recover() — always
// wins over an older "signed in", and the next successful check clears it.
const SIGNED_IN_REUSE_MS = 5 * 60 * 1000;
const INCONCLUSIVE_REUSE_MS = 60 * 1000;
class LaunchAuth {
  constructor({accounts, getConfig, notify = () => {}, now = Date.now}) {
    Object.assign(this, {accounts, getConfig, notify, now});
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
  // The account a connection id points at right now: id, home directory and credential.
  identity(id) { try { return this.accounts.checkIdentityOf?.(id) || this.accounts.scopeOf?.(id) || id; } catch { return id; } }
  reusable(id) {
    let seen = null;
    try { seen = this.accounts.recentObservation?.(id); } catch { return false; }
    if (!seen || seen.sameCredential === false || seen.state === 'login_required') return false;
    const age = this.now() - (Number(seen.observedAt) || 0);
    if (age < 0) return false;
    return age < (seen.state === 'signed_in' ? SIGNED_IN_REUSE_MS : INCONCLUSIVE_REUSE_MS);
  }
  // Start the same read-only check while the user chooses launch options.
  // AccountCenter deduplicates pending checks by identity and stores freshness.
  // Login windows and task recovery remain exclusive to explicit launch/login.
  async precheck(kind, opts = {}) {
    const id = this.connection(kind, opts);
    if (!id || this.reusable(id)) return;
    try { await this.accounts.check(id, {quiet:true, resume:false}); } catch {}
  }
  async ensure(kind, opts = {}) {
    const id = this.connection(kind, opts);
    if (!id) return;
    if (this.reusable(id)) return;
    // Only requests for the same account and credential files share a check: a profile
    // re-pointed to another home or freshly logged in while a check runs starts its own.
    const key = this.identity(id);
    if (this.flights.has(key)) return this.flights.get(key);
    const flight = this.checkAndOpen(id).finally(() => this.flights.delete(key));
    this.flights.set(key, flight);
    return flight;
  }
  async recover(kind, opts, failure) {
    if (!isLoginFailure(failure)) return;
    const id=this.connection(kind,{...opts,launchProfile:opts?.codexProfile});
    if (!id) return;
    try { this.accounts.markLoginRequired?.(id); } catch {}
    if (Date.now()-(this.recoveryAt.get(id)||0)<60000) return;
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
module.exports = {LaunchAuth,isLoginFailure,SIGNED_IN_REUSE_MS,INCONCLUSIVE_REUSE_MS};
