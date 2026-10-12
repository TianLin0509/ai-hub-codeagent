'use strict';
// 「规则」页的主进程接口（数据层见 core/hub-rules.js）。
function registerHubRulesIpc(ipcMain, { store, memoryService, shell }) {
  const handle = (name, fn) =>
    ipcMain.handle('hub-rules:' + name, async (_event, request = {}) => {
      try { return { ok: true, data: await fn(request || {}) }; }
      catch (error) { return { ok: false, error: (error && error.message) || String(error) }; }
    });
  const withDeliveries = snapshot => {
    let deliveries = [];
    try { deliveries = memoryService?.hubRulesDeliveries?.() || []; } catch (_) {}
    return { ...snapshot, deliveries };
  };
  handle('snapshot', () => withDeliveries(store.snapshot()));
  handle('set-enabled', r => withDeliveries(store.setEnabled(r.enabled === true)));
  handle('check-update', async () => {
    const result = await store.checkUpdate();
    return { ...result, snapshot: withDeliveries(result.snapshot) };
  });
  handle('rollback', () => withDeliveries(store.rollback()));
  handle('save-mine', r => {
    const result = store.saveMine({ text: r.text, baseSha: r.baseSha });
    return { ...result, snapshot: withDeliveries(result.snapshot) };
  });
  handle('open-folder', async r => {
    const target = r.which === 'mine' ? require('node:path').dirname(store.snapshot().mine.path) : store.root;
    require('node:fs').mkdirSync(target, { recursive: true });
    const error = await shell.openPath(target);
    if (error) throw new Error(error);
    return true;
  });
}
module.exports = { registerHubRulesIpc };
