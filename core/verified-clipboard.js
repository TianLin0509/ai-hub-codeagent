'use strict';

// 主进程统一写入并读回系统剪贴板。所有窗口共享次序：新复制到达后，旧重试立即作废。
function createVerifiedClipboardWriter({ clipboard, wait = ms => new Promise(resolve => setTimeout(resolve, ms)),
  retryDelaysMs = [0, 20, 50, 100, 200] } = {}) {
  let sequence = 0;
  const normalize = value => String(value ?? '').replace(/\r\n?/g, '\n');
  return async function writeText(value, formats = {}) {
    const request = ++sequence;
    const text = String(value ?? '');
    const result = { ok: false, length: Array.from(text).length, attempts: 0 };
    const superseded = () => ({ ...result, reason: 'superseded' });
    if (!text) return { ...result, reason: 'empty' };
    if (!clipboard?.writeText || !clipboard?.readText) return { ...result, reason: 'clipboard-unavailable' };
    for (const delay of retryDelaysMs) {
      if (delay) await wait(delay);
      if (request !== sequence) return superseded();
      result.attempts++;
      try {
        // Electron's main-process API is synchronous; the first write has no retry delay.
        if (typeof formats?.html === 'string' && formats.html) clipboard.write({ text, html: formats.html });
        else clipboard.writeText(text);
        // Cross an event-loop turn before reading, instead of trusting the renderer's cached value.
        await wait(0);
        if (request !== sequence) return superseded();
        if (normalize(clipboard.readText()) === normalize(text)) return { ...result, ok: true };
        result.reason = 'clipboard verification mismatch';
      } catch (error) {
        result.reason = error.message || 'clipboard-write-failed';
      }
    }
    return result;
  };
}

module.exports = { createVerifiedClipboardWriter };
