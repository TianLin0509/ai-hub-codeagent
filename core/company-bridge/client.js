'use strict';
// 任务通道的 HTTP 客户端。Hub 里用 Electron 的 net.fetch（走系统代理，和更新检查同一条路）；测试注入普通 fetch。
//
// 公司网络隔一段时间要人工点一次「允许访问」：这时代理返回的是一张网页（或跳转），不是 JSON。
// 这种情况归为 gate（待放行），和断网（offline）、服务端报错（server）分开，界面据此提示去点放行页。
class BridgeError extends Error {
  constructor(code, message, extra = {}) { super(message); this.code = code; Object.assign(this, extra); }
}

function defaultFetch() {
  try {
    const electron = require('electron');
    if (electron && electron.net && typeof electron.net.fetch === 'function') return (...args) => electron.net.fetch(...args);
  } catch {}
  return (...args) => fetch(...args);
}

class BridgeClient {
  constructor({ baseUrl, fetchImpl, timeoutMs = 30000 } = {}) {
    this.baseUrl = String(baseUrl || '').replace(/\/+$/, '');
    this.fetch = fetchImpl || defaultFetch();
    this.timeoutMs = timeoutMs;
  }
  // 放行页：收件箱网页本身（通道地址去掉末尾的 /api）。
  gatePage() { return this.baseUrl.replace(/\/api$/, '') + '/'; }

  async request(path, init = {}) {
    const url = this.baseUrl + path;
    let response;
    try {
      response = await this.fetch(url, { ...init, redirect: 'manual', cache: 'no-store', signal: AbortSignal.timeout(this.timeoutMs) });
    } catch (error) {
      throw new BridgeError('offline', '连不上通道：' + (error && error.message || error));
    }
    const type = String(response.headers?.get?.('content-type') || '');
    if (response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400)) {
      throw new BridgeError('gate', '网络要求重新放行（请求被跳转）', { gateUrl: response.headers?.get?.('location') || this.gatePage(), status: response.status });
    }
    let text = '';
    try { text = await response.text(); } catch {}
    let body = null;
    if (/json/i.test(type) || /^\s*\{/.test(text)) { try { body = JSON.parse(text); } catch {} }
    if (!body || typeof body !== 'object') {
      // 拿到一张网页而不是 JSON：多半是公司代理的放行 / 拦截页。
      throw new BridgeError('gate', `网络要求重新放行（返回了网页，HTTP ${response.status}）`, { gateUrl: this.gatePage(), status: response.status });
    }
    if (!response.ok || body.ok === false) {
      const code = body.error && body.error.code || 'server';
      throw new BridgeError(code === 'rate_limited' ? 'rate_limited' : 'server', (body.error && body.error.message) || `服务端返回 HTTP ${response.status}`, { status: response.status });
    }
    return body;
  }

  post(channel, to, mid, blob) {
    return this.request(`/bridge/${channel}/msg`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ to, mid, blob }) });
  }
  fetchMessages(channel, to, after, who) {
    const query = new URLSearchParams({ to, after: String(after || 0), ...(who ? { who } : {}) });
    return this.request(`/bridge/${channel}/msg?${query}`, { method: 'GET' });
  }
}

module.exports = { BridgeClient, BridgeError };
