// tests/helpers/cdp-client.js
//
// 最小化 CDP 客户端：连一个 page target 的 webSocketDebuggerUrl，发 Runtime.evaluate
// 在 renderer 里跑任意 JS（含 ipcRenderer.invoke 调 IPC handler）。
//
// 用法：
//   const client = await connectCDP(pageWsUrl);
//   const r = await client.eval(`(async () => await ipcRenderer.invoke('get-sessions'))()`);
//   await client.close();

const WebSocket = require('ws');

class CDPClient {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.id != null) {
          const p = this.pending.get(msg.id);
          if (p) {
            this.pending.delete(msg.id);
            clearTimeout(p.timer);
            if (msg.error) p.reject(new Error(`CDP ${p.method} error: ${JSON.stringify(msg.error)}`));
            else p.resolve(msg.result);
          }
        }
      } catch { /* malformed frame, ignore */ }
    });
  }

  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP ${method} timeout`));
        }
      }, 30000);
      this.pending.set(id, { resolve, reject, method, timer });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  // Run JS expression in renderer context. Use awaitPromise so async expressions resolve.
  async eval(expression, { awaitPromise = true, returnByValue = true } = {}) {
    const r = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise,
      returnByValue,
      userGesture: true,
    });
    if (r.exceptionDetails) {
      const e = r.exceptionDetails.exception;
      throw new Error(`Eval threw: ${e && (e.description || e.value || JSON.stringify(e))}`);
    }
    return r.result && r.result.value !== undefined ? r.result.value : r.result;
  }

  async close() {
    try { this.ws.close(); } catch {}
  }
}

async function connectCDP(wsUrl) {
  const ws = new WebSocket(wsUrl, { perMessageDeflate: false });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('CDP ws connect timeout')), 5000);
    ws.once('open', () => { clearTimeout(timer); resolve(); });
    ws.once('error', (e) => { clearTimeout(timer); reject(e); });
  });
  return new CDPClient(ws);
}

// Helper: 找到 main window 的 page target 并连上。Hub 启动后第一个 page 就是 index.html。
//   filter 可选：返回 boolean 决定是否选这个 target。
async function connectFirstPage(hub, filter = (t) => t.type === 'page') {
  const http = require('http');
  const targets = await new Promise((resolve) => {
    http.get(`${hub.cdpHttpBase}/json/list`, (res) => {
      let buf = ''; res.on('data', c => buf += c);
      res.on('end', () => { try { resolve(JSON.parse(buf)); } catch { resolve([]); } });
    }).on('error', () => resolve([]));
  });
  const t = targets.find(filter);
  if (!t) throw new Error(`No matching CDP target for ${hub.label}`);
  return await connectCDP(t.webSocketDebuggerUrl);
}

module.exports = { CDPClient, connectCDP, connectFirstPage };
