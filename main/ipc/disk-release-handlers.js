'use strict';
const path = require('path');
const os = require('os');
const { inside } = require('../../core/disk-release-policy');
const { createDiskReleaseService } = require('../../core/disk-release-service');

function registerDiskReleaseIpc(ipcMain, deps = {}) {
  const dataDir = deps.dataDir;
  let owner = null;
  const configuredTestRoot = process.env.HUB_DISK_RELEASE_TEST_ROOT;
  const isIsolated = dataDir && path.resolve(dataDir) !== path.join(os.homedir(), '.ai-hub-community');
  const testRoot = configuredTestRoot && process.env.CLAUDE_HUB_E2E === '1' && isIsolated
    && inside(path.dirname(dataDir), configuredTestRoot) && inside(os.tmpdir(), configuredTestRoot)
    ? configuredTestRoot : undefined;
  if (configuredTestRoot && !testRoot) throw new Error('硬盘释放测试目录未通过隔离验证');
  const service = deps.service || createDiskReleaseService({ dataDir, testRoot,
    onProgress: progress => { if (owner && !owner.isDestroyed()) owner.send('disk-release-progress', progress); },
  });
  const guard = callback => async (event, options) => {
    try { return await callback(event, options || {}); }
    catch (error) { return { ok: false, error: error.message }; }
  };
  ipcMain.handle('get-disk-release-plan', guard(async event => {
    if (service.status().busy) return { ok: false, error: '已有扫描或清理正在进行' };
    owner = event.sender;
    return service.scan();
  }));
  ipcMain.handle('execute-disk-release', guard(async (event, options) => {
    owner = event.sender;
    return service.execute({ scanId: options.scanId, keys: options.keys, confirmed: options.confirmed === true });
  }));
  ipcMain.handle('get-disk-usage-analysis', guard(async event => {
    if (service.status().busy) return { ok: false, error: '已有扫描或清理正在进行' };
    owner = event.sender;
    return service.analyzeUsage();
  }));
  ipcMain.handle('get-disk-release-status', () => service.status());
  ipcMain.handle('cancel-disk-release-scan', () => { service.cancelScan(); return { ok: true }; });
  deps.app?.on?.('will-quit', () => service.stop());
  return service;
}
module.exports = { registerDiskReleaseIpc };
