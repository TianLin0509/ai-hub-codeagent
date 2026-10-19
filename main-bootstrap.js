'use strict';

// Keep test/branch Hubs on an isolated Chromium profile before main.js starts.
// Production Hubs intentionally share the normal profile and Hub data directory:
// desktop multi-instance startup is a product contract. Shared state is protected
// by state-store's file lock + read/merge/write path, while hook/control resources
// are allocated per process. Do not add requestSingleInstanceLock here again.
const { app, BrowserWindow } = require('electron');
const path = require('path');

const configuredDataDir = String(process.env.CLAUDE_HUB_DATA_DIR || '').trim();
if (configuredDataDir) {
  app.setPath('userData', path.join(configuredDataDir, 'electron-userdata'));
}

// 启动环境自检（core/clean-launch-env.js，2026-10-19）：Hub 若是从某个会话的进程树里、或由更新脚本拉起的，
// 先把继承来的会话标记从 process.env 删掉，配置目录类变量后台读完注册表再按「桌面打开」还原；Hub 之后拉起的终端、CLI 都不再带。
try {
  const { isPackagedHubRuntime } = require('./core/electron-runtime-mode.js');
  process.__hubLaunchEnv = require('./core/clean-launch-env.js').cleanOwnEnvAtStartup({
    appRoot: __dirname,
    isPackaged: isPackagedHubRuntime({ appIsPackaged: app.isPackaged, defaultApp: process.defaultApp }),
    dataDir: require('./core/data-dir.js').getHubDataDir(),
  });
} catch (error) {
  process.__hubLaunchEnvError = error && error.message ? error.message : String(error);
}

try {
  const { installProcessLifecycleJournal } = require('./core/process-lifecycle-journal.js');
  process.__hubLifecycleJournal = installProcessLifecycleJournal({ app, BrowserWindow });
} catch (error) {
  // Diagnostics must never become a startup dependency. Keep the failure in
  // memory for an attached debugger without throwing into the production Hub.
  process.__hubLifecycleJournalInstallError = error && error.message ? error.message : String(error);
}

// 兼容渲染：必须在 app ready 之前决定（见 core/gpu-mode.js）。
try {
  // 返回值（关闭原因或 null）交给 main.js：界面进程据此给终端选不依赖显卡的渲染方式。
  process.__hubGpuDisabledReason = require('./core/gpu-mode.js').applyGpuMode({ app, dataDir: require('./core/data-dir.js').getHubDataDir() }) || null;
} catch (error) {
  process.__hubGpuModeError = error && error.message ? error.message : String(error);
}

require('./main.js');
