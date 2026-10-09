'use strict';

// Local IPC health only. No model request, task retry, or execution state change.
function createHubFeedbackHealth({ ping, enabled, now = Date.now, schedule = setTimeout, cancel = clearTimeout }) {
  let timer = null, pending = false, pendingSince = 0, lastReply = 0, lastError = '', disposed = false;
  function text(at = now()) {
    if (disposed || !enabled()) return '';
    if (lastError) return 'Hub 本地连接未确认';
    if (pending && at - pendingSince >= 3000) return `Hub 本地应答已等待 ${Math.floor((at-pendingSince)/1000)} 秒`;
    if (lastReply && at-lastReply < 10000) return 'Hub 本地有响应';
    return '正在检测 Hub 本地响应';
  }
  async function tick() {
    if (disposed) return;
    if (enabled() && !pending) {
      pending = true; pendingSince = now();
      try {
        const result = await ping();
        if (result?.ok !== true) throw new Error('Hub ping not acknowledged');
        lastReply = now(); lastError = '';
      } catch (error) { lastError = String(error?.message || error); }
      finally { pending = false; }
    }
    if (!disposed) timer = schedule(tick, 3000);
  }
  return { text, start() { void tick(); }, dispose() { disposed = true; cancel(timer); } };
}

let current = null;
function start(options) { current?.dispose(); current=createHubFeedbackHealth(options); current.start(); return current; }
const healthText = now => current?.text(now) || '';
module.exports = { createHubFeedbackHealth, start, healthText };
