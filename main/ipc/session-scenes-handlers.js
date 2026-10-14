'use strict';
// 「规则 → 场景」页与输入框「场景」按钮的主进程接口（数据层见 core/session-scenes.js）。
function registerSessionScenesIpc(ipcMain, { dataDir, shell }) {
  const scenes = require('../../core/session-scenes');
  const handle = (name, fn) =>
    ipcMain.handle('session-scenes:' + name, async (_event, request = {}) => {
      try { return { ok: true, data: await fn(request || {}) }; }
      catch (error) { return { ok: false, error: (error && error.message) || String(error) }; }
    });
  handle('snapshot', () => scenes.scenesSnapshot({ dataDir }));
  handle('set-default', r => { scenes.setDefaultScene(dataDir, String(r.id || '')); return scenes.scenesSnapshot({ dataDir }); });
  handle('save', r => { scenes.saveSceneBody(String(r.id || ''), r.body, { baseSha: r.baseSha, dataDir }); return scenes.scenesSnapshot({ dataDir }); });
  handle('open-folder', async r => {
    const snap = scenes.scenesSnapshot({ dataDir });
    const scene = snap.scenes.find(s => s.id === r.id);
    const target = r.which === 'knowledge' ? scene?.knowledgeInfo?.dir : snap.dir;
    if (!target) throw new Error('没有可打开的目录');
    const error = await shell.openPath(target);
    if (error) throw new Error(error);
    return true;
  });
}
module.exports = { registerSessionScenesIpc };
