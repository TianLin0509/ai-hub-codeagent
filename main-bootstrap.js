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
