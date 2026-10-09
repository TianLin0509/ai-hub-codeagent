'use strict';

const { createPromptPolisher } = require('../../core/prompt-polish');

function registerPromptPolishIpc(ipcMain, { getConfig, polish = createPromptPolisher({ getConfig }) }) {
  const pending = new Map();
  const watched = new WeakSet();
  ipcMain.handle('prompt:polish', async ({ sender }, { id, text } = {}) => {
    if (typeof id !== 'string' || !id || id.length > 100) return { ok: false, message: '整理请求无效' };
    const key = `${sender.id}:${id}`;
    if (pending.has(key) || [...pending.values()].filter(item => item.sender === sender).length >= 2) {
      return { ok: false, message: '已有草稿正在整理，请稍候' };
    }
    const controller = new AbortController();
    pending.set(key, { sender, controller });
    if (!watched.has(sender)) {
      watched.add(sender);
      sender.once('destroyed', () => {
        for (const [k, item] of pending) if (item.sender === sender) { item.controller.abort(); pending.delete(k); }
      });
    }
    try { return { ok: true, ...await polish(text, { signal: controller.signal }) }; }
    catch (error) { return { ok: false, message: error.message || '整理失败，原稿已保留' }; }
    finally { pending.delete(key); }
  });
  ipcMain.handle('prompt:polish-cancel', ({ sender }, id) => {
    const item = pending.get(`${sender.id}:${id}`);
    if (item?.sender === sender) item.controller.abort();
    return { ok: true };
  });
}

module.exports = { registerPromptPolishIpc };
