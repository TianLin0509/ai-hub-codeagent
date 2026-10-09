'use strict';
const path = require('node:path');
const os = require('node:os');
const { createDesktopOrganizer, inside } = require('../../core/desktop-organizer');
const { createDesktopIconLayout } = require('../../core/desktop-icon-layout');
function registerDesktopOrganizerIpc(ipcMain, { dataDir, shell, layoutService } = {}) {
  const configured = process.env.HUB_DESKTOP_ORGANIZER_TEST_ROOT;
  const isolated = dataDir && path.resolve(dataDir) !== path.join(os.homedir(), '.ai-hub-community');
  const testRoot = configured && process.env.CLAUDE_HUB_E2E === '1' && isolated && inside(os.tmpdir(), configured) && inside(path.dirname(dataDir), configured) ? configured : undefined;
  if (configured && !testRoot) throw new Error('桌面整理测试目录未通过隔离验证');
  const service = createDesktopOrganizer({ testRoot });
  const layout = layoutService || createDesktopIconLayout({ testRoot });
  const arrangeAfter = async (result, count) => {
    if (count > 0) {
      try { result.layout = await layout.arrange(); }
      catch (error) { result.layout = { ok: false, error: error.message }; }
    }
    return result;
  };
  const guard = callback => async (_event, options) => { try { return await callback(options || {}); } catch (e) { return { ok: false, error: e.message }; } };
  ipcMain.handle('desktop-organizer:scan', guard(() => service.scan()));
  ipcMain.handle('desktop-organizer:execute', guard(async options => { const result = await service.execute(options); return arrangeAfter(result, result.moved); }));
  ipcMain.handle('desktop-organizer:undo', guard(async () => { const result = await service.undo(); return arrangeAfter(result, result.restored); }));
  ipcMain.handle('desktop-organizer:arrange', guard(() => layout.arrange()));
  ipcMain.handle('desktop-organizer:open', guard(async () => {
    const fs = require('node:fs/promises'); await fs.mkdir(service.archive, { recursive: true });
    const error = await shell.openPath(service.archive); if (error) throw new Error(error); return { ok: true };
  }));
  return service;
}
module.exports = { registerDesktopOrganizerIpc };
