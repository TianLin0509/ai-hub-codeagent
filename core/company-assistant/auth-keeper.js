'use strict';
const W = require('./welink');
const CHECK_MS = 5 * 60000, RETRY_MS = 10 * 60000, SCAN_LIMIT = 2;
const authFailure = text => /(?:token|session)\s*(?:is\s*)?(?:expired|invalid)|unauthenticated|not\s+logged\s*in|未登录|登录(?:已)?(?:过期|失效)|no\s+token/i.test(String(text || ''));
// Same recognition as the manual login panel (data URI, image path, URL), plus the prompt wording.
const needsScan = text => !!W.qrFromLoginOutput(text) || /请.{0,12}扫码|二维码|scan\s+(?:the\s+)?qr|qr\s*code/i.test(String(text || ''));

class AuthKeeper {
  constructor(a) {
    this.a = a; this.pending = null; this.controller = null; this.closed = false;
    this.current = { state: 'unknown', lastCheckAt: 0, lastAttemptAt: 0, lastRenewAt: 0, scanAttempts: 0, notified: false, login: null, error: '',
      ...a.read('auth.json', {}) };
    // A process that ended mid-renewal is no longer renewing after restart.
    if (this.current.state === 'renewing') this.current.state = 'unknown';
  }
  status() { return { ...this.current }; }
  set(patch) { if (this.closed) return; this.current = { ...this.current, ...patch }; this.a.write('auth.json', this.current); this.a.changed(); }
  online(login, renewed = false) {
    this.set({ state: 'online', login, error: '', lastCheckAt: this.a.now(), scanAttempts: 0, notified: false, noticeId: '',
      ...(renewed ? { lastRenewAt: this.a.now() } : {}) });
  }
  manualSucceeded(login) { this.online(login); }
  notifyScan() {
    if (this.closed || this.current.state !== 'needs-scan' || this.current.notified) return;
    const id = this.current.noticeId || 'welink-login-' + this.a.now();
    this.set({ noticeId: id });
    if (this.a.publish({ id, kind: 'welink-login', title: 'WeLink 自动续期没成功', text: '自动续期连续两次没完成；点助理左栏的 WeLink 一行扫码登录即可继续。', at: this.a.now() })) this.set({ notified: true });
  }
  close() { this.closed = true; this.controller?.abort(); }
  check({ force = false, known = null, refresh = true } = {}) {
    if (this.closed || this.a.loginFlow?.state === 'waiting') return Promise.resolve(this.status());
    if (this.pending) return this.pending;
    if (!force && this.current.lastCheckAt && this.a.now() - this.current.lastCheckAt < CHECK_MS) return Promise.resolve(this.status());
    this.pending = this.perform(known, refresh).finally(() => { this.pending = null; });
    return this.pending;
  }
  async perform(known, refresh) {
    const now = this.a.now();
    let login;
    try {
      const result = known || await this.a.rawWelink(['auth', 'status']);
      if (this.closed) return this.status();
      const text = result.stdout + '\n' + result.stderr;
      login = { ...W.loginState(text), checkedAt: now };
      if (result.code !== 0 && login.ok) login = { ok: false, reason: 'error', checkedAt: now, error: '登录状态查询失败' };
      // A still-valid token renewed early must never turn into a scan request.
      const early = !!login.ok;
      if (login.ok) {
        this.online(login);
        const remaining = /expires in\s+(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?/i.exec(text);
        const ms = remaining ? (Number(remaining[1] || 0) * 3600 + Number(remaining[2] || 0) * 60 + Number(remaining[3] || 0)) * 1000 : Infinity;
        if (ms > CHECK_MS) return this.status();
      }
      this.set({ login, lastCheckAt: now, ...(!login.ok && this.current.state === 'online' ? { state: 'unknown', error: '等待自动续期' } : {}) });
      // A network/parse failure is not proof of expiry and must not launch login.
      if (!login.ok && login.reason !== 'expired') { this.set({ state: 'unknown', error: '暂时无法确认 WeLink 登录，稍后自动重查' }); return this.status(); }
      if (!login.ok && this.current.scanAttempts >= SCAN_LIMIT) this.set({ state: 'needs-scan', error: '' });
      if (this.current.scanAttempts >= SCAN_LIMIT || (this.current.lastAttemptAt && now - this.current.lastAttemptAt < RETRY_MS)) { this.notifyScan(); return this.status(); }
      this.set({ state: 'renewing', lastAttemptAt: now, error: '' });
      this.controller = new AbortController();
      let scan = false, timedOut = false;
      let resultLogin;
      try {
        resultLogin = await this.a.rawWelink(['auth', 'login'], { allowSetup: true, timeoutMs: 90000, signal: this.controller.signal, onData: text => {
          if (needsScan(text)) { scan = true; this.controller.abort(); }
        } });
        scan = scan || needsScan(resultLogin.stdout + resultLogin.stderr);
      } catch (error) {
        if (this.closed) return this.status();
        timedOut = !scan && error.code === 'WELINK_TIMEOUT';
        if (!scan && !timedOut) {
          this.set({ state: early ? 'online' : 'unknown', error: early ? '' : '自动续期没能完成：' + error.message });
          return this.status();
        }
      } finally { this.controller = null; }
      if (this.closed) return this.status();
      // Early renewal that asked for a QR code or timed out: the login process is already ended;
      // keep the valid login and let the normal flow handle it once the token has really expired.
      if (early && (scan || timedOut)) { this.set({ state: 'online', error: '' }); return this.status(); }
      if (!scan && resultLogin?.code === 0) {
        const after = await this.a.rawWelink(['auth', 'status']);
        if (this.closed) return this.status();
        const confirmed = { ...W.loginState(after.stdout + '\n' + after.stderr), checkedAt: this.a.now() };
        if (after.code === 0 && confirmed.ok) {
          this.online(confirmed, true);
          // Defer collection until the current auth/collection promise can settle.
          if (refresh) queueMicrotask(() => { if (!this.closed) void this.a.refresh({ force: true }).catch(e => console.warn('[company-assistant] renew refresh', e.message)); });
          return this.status();
        }
      }
      if (!scan && !timedOut) {
        this.set({ state: early ? 'online' : 'unknown', error: early ? '' : '自动续期未成功，十分钟后再试；也可手动登录' });
        return this.status();
      }
      // A QR request or a timeout both count; two in a row stop auto login and ask for a scan.
      const attempts = this.current.scanAttempts + 1;
      if (attempts < SCAN_LIMIT) {
        this.set({ state: 'unknown', scanAttempts: attempts, error: '自动续期没成功，十分钟后再试；也可点「扫码登录」' });
        return this.status();
      }
      this.set({ state: 'needs-scan', scanAttempts: attempts, error: '' });
      this.notifyScan();
    } catch (error) {
      if (!this.closed) this.set({ state: 'unknown', lastCheckAt: now, error: error.message, login: { ok: false, reason: error.code === 'WELINK_MISSING' ? 'missing' : 'error', checkedAt: now } });
    }
    return this.status();
  }
}
module.exports = { AuthKeeper, CHECK_MS, RETRY_MS, SCAN_LIMIT, authFailure, needsScan };
