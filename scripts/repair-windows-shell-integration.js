'use strict';

// One-shot repair for a running production installation. It fixes Windows
// shortcuts and Jump List metadata without touching or restarting the Hub PID.
const path = require('path');
const os = require('os');
const fs = require('fs');
const { app, shell } = require('electron');
const {
  HUB_APP_USER_MODEL_ID,
  buildShortcutDetails,
  ensureWindowsShellIntegration,
  shortcutMatches,
  isWindowsNormalizedShortcut,
} = require('../core/windows-shell-integration.js');
const {
  ensureBrandedHubExe,
  inspectBrandedHubExe,
  resolveHubLaunchExePath,
} = require('../core/hub-exe-branding.js');

const appRoot = path.resolve(__dirname, '..');
const iconPath = path.join(appRoot, 'claude-wx.ico');
const productVersion = (() => {
  try { return require('../package.json').version || ''; } catch { return ''; }
})();

// This helper is a separate Electron process. Keep Chromium caches isolated
// from every running production Hub while still using app.getPath('appData')
// for the real Start Menu location.
app.setPath('userData', path.join(os.tmpdir(), 'ai-hub-shell-repair'));

if (process.platform === 'win32') app.setAppUserModelId(HUB_APP_USER_MODEL_ID);

app.whenReady().then(() => {
  // 先把品牌化 exe 补齐（缺失/过期时才真干活），再让快捷方式指过去。
  // 顺序不能反：exe 不在时 resolveHubLaunchExePath 会回落 electron.exe，
  // 快捷方式就白改一遍。npm install / npm ci 换过 Electron 之后跑这一条即可复原。
  const brandingOptions = { execPath: process.execPath, icoPath: iconPath, productVersion };
  const brandingBefore = inspectBrandedHubExe(brandingOptions);
  const branding = ensureBrandedHubExe({ ...brandingOptions, productName: 'AI Hub Community' });
  const launchExePath = resolveHubLaunchExePath(brandingOptions);
  const shellOptions = {
    app,
    shell,
    appRoot,
    execPath: launchExePath,
    isPackaged: false,
    iconPath,
  };
  const result = ensureWindowsShellIntegration(shellOptions);
  const expectedShortcut = buildShortcutDetails(shellOptions);
  result.branding = {
    stateBefore: brandingBefore.reason,
    rebuilt: branding.changed,
    brandedExePath: branding.brandedExePath,
    error: branding.error || null,
  };
  result.shortcutExistsBeforeExit = !!(result.shortcutPath && fs.existsSync(result.shortcutPath));
  // 归一化裸版（Windows 抹掉参数）也是健康终态，见 isWindowsNormalizedShortcut 的实测说明。
  const healthy = (details) => shortcutMatches(details, expectedShortcut)
    || isWindowsNormalizedShortcut(details, expectedShortcut);
  try {
    result.shortcutDetailsAfterRepair = shell.readShortcutLink(result.shortcutPath);
    result.shortcutHealthyAfterRepair = healthy(result.shortcutDetailsAfterRepair);
  } catch (error) {
    result.shortcutHealthyAfterRepair = false;
    result.shortcutReadError = error.message;
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  setTimeout(() => {
    let healthyAfter1s = false;
    try {
      healthyAfter1s = healthy(shell.readShortcutLink(result.shortcutPath));
    } catch {}
    process.stdout.write(`shortcutExistsAfter1s=${!!(result.shortcutPath && fs.existsSync(result.shortcutPath))}\n`);
    process.stdout.write(`shortcutHealthyAfter1s=${healthyAfter1s}\n`);
    app.exit(healthyAfter1s ? 0 : 2);
  }, 1000);
}).catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  app.exit(1);
});
