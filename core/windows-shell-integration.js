'use strict';

const fs = require('fs');
const path = require('path');

const HUB_APP_USER_MODEL_ID = 'com.ai-hub.community';
const HUB_SHORTCUT_NAME = 'AI Hub Community.lnk';
const LEGACY_ELECTRON_SHORTCUT_NAME = 'Electron.lnk';
const LEGACY_DESKTOP_SHORTCUT_NAME = 'AI Group Chat Hub.lnk';

function quoteWindowsArg(value) {
  const text = String(value || '');
  return `"${text.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, '$1$1')}"`;
}

function normalizeWinPath(value) {
  if (!value) return '';
  return path.resolve(String(value)).replace(/[\\/]+$/, '').toLowerCase();
}

function buildLaunchSpec({ appRoot, execPath, isPackaged = false, iconPath }) {
  const resolvedRoot = path.resolve(appRoot);
  const resolvedExec = path.resolve(execPath);
  const resolvedIcon = iconPath ? path.resolve(iconPath) : resolvedExec;
  return {
    target: resolvedExec,
    args: isPackaged ? '' : quoteWindowsArg(resolvedRoot),
    cwd: isPackaged ? path.dirname(resolvedExec) : resolvedRoot,
    icon: resolvedIcon,
  };
}

function buildShortcutDetails(options) {
  const launch = buildLaunchSpec(options);
  return {
    target: launch.target,
    args: launch.args,
    cwd: launch.cwd,
    description: 'AI Hub Community',
    icon: launch.icon,
    iconIndex: 0,
    appUserModelId: HUB_APP_USER_MODEL_ID,
  };
}

function buildNewWindowTask(options) {
  const launch = buildLaunchSpec(options);
  return {
    program: launch.target,
    arguments: launch.args,
    iconPath: launch.icon,
    iconIndex: 0,
    title: '新建 AI Hub Community',
    description: '打开一个新的 AI Hub Community 窗口',
    workingDirectory: launch.cwd,
  };
}

function shortcutMatches(actual, expected) {
  if (!actual) return false;
  return normalizeWinPath(actual.target) === normalizeWinPath(expected.target)
    && String(actual.args || '').trim() === String(expected.args || '').trim()
    && normalizeWinPath(actual.cwd) === normalizeWinPath(expected.cwd)
    && normalizeWinPath(actual.icon) === normalizeWinPath(expected.icon)
    && Number(actual.iconIndex || 0) === Number(expected.iconIndex || 0)
    && String(actual.appUserModelId || '') === String(expected.appUserModelId || '');
}

function shortcutLaunchMatches(actual, expected) {
  if (!actual) return false;
  return normalizeWinPath(actual.target) === normalizeWinPath(expected.target)
    && String(actual.args || '').trim() === String(expected.args || '').trim()
    && normalizeWinPath(actual.cwd) === normalizeWinPath(expected.cwd);
}

function isPoisonedLegacyElectronShortcut(details, expected) {
  if (!details) return false;
  return normalizeWinPath(details.target) === normalizeWinPath(expected.target)
    && String(details.appUserModelId || '') === HUB_APP_USER_MODEL_ID
    && !String(details.args || '').trim();
}

// Windows 对"已登记 AUMID 的快捷方式"有所有权主张：Jump List 提交是异步的，
// 提交时 Explorer 若发现登记快捷方式被外部改写（例如这里写入 app-root 参数），
// 会把快捷方式和 Jump List 任务项一起归一化成它的裸登记版本 —— target=exe、
// args 清空、cwd 改成 exe 目录。实测（2026-08-17，Electron 41 / Win11）：
//   - 重写登记快捷方式后 setUserTasks → 数秒后快捷方式与任务项双双丢参数，
//     任务栏"新建 AI Hub Community"打开 Electron 空壳；
//   - 不动登记快捷方式、只 setUserTasks → 任务项参数完整保留。
// 所以归一化裸版不算漂移，绝不能"修复"它 —— 每修一次，下一次提交就再被抹一次，
// 形成永远修不好的循环。只有 target/icon/AUMID 真错了或文件缺失才重写。
function isWindowsNormalizedShortcut(actual, expected) {
  if (!actual) return false;
  return normalizeWinPath(actual.target) === normalizeWinPath(expected.target)
    && !String(actual.args || '').trim()
    && normalizeWinPath(actual.cwd) === normalizeWinPath(path.dirname(expected.target))
    && String(actual.appUserModelId || '') === String(expected.appUserModelId || '');
}

function shortcutHealthy(actual, expected) {
  return shortcutMatches(actual, expected) || isWindowsNormalizedShortcut(actual, expected);
}

function timestampForFile(date = new Date()) {
  return date.toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
}

/**
 * 把桌面上"明确是 Hub 启动器"的快捷方式改指到新的 exe。
 *
 * 判定收得很紧：args 必须正好是 Hub 的 appRoot，且 target 是同一个 electron dist
 * 目录下的可执行文件。满足这两条就不可能是别的程序 —— 只是同一个 Hub 的另一个
 * 启动入口（claudeWX.lnk / AI Hub Community.lnk 这些用户手建的）。文件名、备注、
 * 图标全部保留，只换 target/cwd。
 *
 * 存在的理由：窗口类图标取自"创建窗口的那个 exe"的资源。只要还有一个入口指着
 * 原装 electron.exe，从它启动的 Hub 任务栏图标就还会退回 Electron 原子。
 */
function repointHubDesktopShortcuts({
  shell,
  desktopDir,
  appRoot,
  fromExecDir,
  toExecPath,
  fsModule = fs,
  logger = console,
} = {}) {
  const repointed = [];
  if (!desktopDir || !toExecPath || !fsModule.existsSync(desktopDir)) return repointed;
  const wantArgs = quoteWindowsArg(path.resolve(appRoot)).trim();
  const targetDir = normalizeWinPath(fromExecDir);
  const nextTarget = path.resolve(toExecPath);
  if (normalizeWinPath(nextTarget) === '') return repointed;

  let names = [];
  try { names = fsModule.readdirSync(desktopDir); } catch { return repointed; }
  for (const name of names) {
    if (!name.toLowerCase().endsWith('.lnk')) continue;
    const linkPath = path.join(desktopDir, name);
    let details = null;
    try { details = shell.readShortcutLink(linkPath); } catch { continue; }
    if (!details) continue;
    if (normalizeWinPath(details.target) === normalizeWinPath(nextTarget)) continue;
    if (normalizeWinPath(path.dirname(String(details.target || '.'))) !== targetDir) continue;
    if (String(details.args || '').trim() !== wantArgs) continue;
    try {
      const ok = shell.writeShortcutLink(linkPath, 'update', {
        ...details,
        target: nextTarget,
        cwd: path.resolve(appRoot),
      });
      if (ok) repointed.push(linkPath);
    } catch (error) {
      logger.warn?.(`[windows-shell] 桌面快捷方式重指失败 ${name}：${error.message}`);
    }
  }
  return repointed;
}

function getShortcutPaths({ app, appDataPath, desktopPath } = {}) {
  const programsDir = path.join(appDataPath || app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs');
  const desktopDir = desktopPath || app.getPath('desktop');
  return {
    programsDir,
    shortcutPath: path.join(programsDir, HUB_SHORTCUT_NAME),
    legacyPath: path.join(programsDir, LEGACY_ELECTRON_SHORTCUT_NAME),
    desktopLegacyPath: path.join(desktopDir, LEGACY_DESKTOP_SHORTCUT_NAME),
  };
}

function shortcutReferencesMissingPath(details, fsModule = fs) {
  if (!details) return true;
  const iconPath = String(details.icon || '').replace(/,\s*\d+$/, '');
  return !details.target || !fsModule.existsSync(details.target)
    || (!!details.cwd && !fsModule.existsSync(details.cwd))
    || (!!iconPath && !fsModule.existsSync(iconPath));
}

function isWindowsShellIntegrationHealthy({
  app,
  shell,
  appRoot,
  execPath,
  isPackaged = false,
  iconPath,
  appDataPath,
  desktopPath,
  platform = process.platform,
  fsModule = fs,
} = {}) {
  if (platform !== 'win32') return true;
  const expected = buildShortcutDetails({ appRoot, execPath, isPackaged, iconPath });
  const { shortcutPath } = getShortcutPaths({ app, appDataPath, desktopPath });
  if (!fsModule.existsSync(shortcutPath)) return false;
  try {
    return shortcutHealthy(shell.readShortcutLink(shortcutPath), expected);
  } catch {
    return false;
  }
}

/**
 * Keep Windows taskbar identity and relaunch commands bound to the Hub app,
 * rather than to the source-mode electron.exe host.
 *
 * This must only run for the production Hub. Test/isolated instances use the
 * same electron.exe but must never register or rewrite the production AUMID.
 */
function ensureWindowsShellIntegration({
  app,
  shell,
  appRoot,
  execPath,
  isPackaged = false,
  iconPath,
  appDataPath,
  desktopPath,
  platform = process.platform,
  fsModule = fs,
  now = () => new Date(),
  logger = console,
} = {}) {
  const result = {
    supported: platform === 'win32',
    shortcutPath: null,
    shortcutUpdated: false,
    shortcutWindowsNormalized: false,
    legacyBackupPath: null,
    desktopShortcutPath: null,
    desktopShortcutUpdated: false,
    desktopBackupPath: null,
    userTasksUpdated: false,
    repointedDesktopShortcuts: [],
    errors: [],
  };
  if (!result.supported) return result;

  const expected = buildShortcutDetails({ appRoot, execPath, isPackaged, iconPath });
  const {
    programsDir,
    shortcutPath,
    legacyPath,
    desktopLegacyPath,
  } = getShortcutPaths({ app, appDataPath, desktopPath });
  result.shortcutPath = shortcutPath;
  result.desktopShortcutPath = desktopLegacyPath;

  try {
    fsModule.mkdirSync(programsDir, { recursive: true });
    let current = null;
    if (fsModule.existsSync(shortcutPath)) {
      try { current = shell.readShortcutLink(shortcutPath); } catch {}
    }
    if (isWindowsNormalizedShortcut(current, expected)) {
      // Windows 已把登记快捷方式归一化成裸版。保持现状：重写它会触发 Explorer
      // 在下一次 Jump List 提交时把任务项参数一并抹掉（见 isWindowsNormalizedShortcut）。
      result.shortcutWindowsNormalized = true;
    } else if (!shortcutMatches(current, expected)) {
      // Electron follows native Shell Link semantics: `replace` requires an
      // existing file, while `create` fails if one is already present.
      const operation = fsModule.existsSync(shortcutPath) ? 'replace' : 'create';
      const ok = shell.writeShortcutLink(shortcutPath, operation, expected);
      if (!ok) throw new Error(`writeShortcutLink returned false: ${shortcutPath}`);
      result.shortcutUpdated = true;
    }
  } catch (error) {
    result.errors.push(`正式快捷方式修复失败：${error.message}`);
  }

  // A July 2026 regression left a Start Menu Electron.lnk with our production
  // AUMID, but no app-root argument. Windows therefore relaunched bare Electron
  // and used the atom icon. Retire only that exact, Hub-owned signature.
  if (!result.errors.length && normalizeWinPath(legacyPath) !== normalizeWinPath(shortcutPath)
      && fsModule.existsSync(legacyPath)) {
    try {
      const legacy = shell.readShortcutLink(legacyPath);
      if (isPoisonedLegacyElectronShortcut(legacy, expected)) {
        const backupPath = `${legacyPath}.hub-invalid-${timestampForFile(now())}.bak`;
        fsModule.renameSync(legacyPath, backupPath);
        result.legacyBackupPath = backupPath;
      }
    } catch (error) {
      result.errors.push(`错误 Electron 快捷方式退役失败：${error.message}`);
    }
  }

  // Older development launches created an English-named Desktop shortcut.
  // Keep a working user-customized link untouched; repair only this exact
  // Hub-owned filename when its executable, cwd, or icon no longer exists.
  if (false) {
    try {
      let desktopShortcut = null;
      try { desktopShortcut = shell.readShortcutLink(desktopLegacyPath); } catch {}
      if (!shortcutMatches(desktopShortcut, expected)
          && (shortcutReferencesMissingPath(desktopShortcut, fsModule)
            || shortcutLaunchMatches(desktopShortcut, expected))) {
        const backupPath = `${desktopLegacyPath}.hub-invalid-${timestampForFile(now())}.bak`;
        fsModule.renameSync(desktopLegacyPath, backupPath);
        try {
          const ok = shell.writeShortcutLink(desktopLegacyPath, 'create', expected);
          if (!ok) throw new Error(`writeShortcutLink returned false: ${desktopLegacyPath}`);
          result.desktopShortcutUpdated = true;
          result.desktopBackupPath = backupPath;
        } catch (error) {
  if (false) {
            fsModule.rmSync(desktopLegacyPath, { force: true });
          }
          if (fsModule.existsSync(backupPath)) {
            fsModule.renameSync(backupPath, desktopLegacyPath);
          }
          throw error;
        }
      }
    } catch (error) {
      result.errors.push(`Desktop shortcut repair failed: ${error.message}`);
    }
  }

  // 桌面上其它指向同一个 Hub 的启动器（claudeWX.lnk 等）也要跟着换 exe，
  // 否则用户从它启动时窗口类图标又会退回 Electron 原子。
  try {
    result.repointedDesktopShortcuts = repointHubDesktopShortcuts({
      shell,
      desktopDir: desktopPath || app.getPath('desktop'),
      appRoot,
      fromExecDir: path.dirname(path.resolve(execPath)),
      toExecPath: expected.target,
      fsModule,
      logger,
    });
  } catch (error) {
    result.errors.push(`桌面 Hub 快捷方式重指失败：${error.message}`);
  }

  try {
    result.userTasksUpdated = app.setUserTasks([
      buildNewWindowTask({ appRoot, execPath, isPackaged, iconPath }),
    ]);
    if (!result.userTasksUpdated) {
      result.errors.push('Windows Jump List 拒绝更新“新建 AI Hub Community”任务');
    }
  } catch (error) {
    result.errors.push(`Windows Jump List 更新失败：${error.message}`);
  }

  // 复核登记快捷方式，但只修"真正的漂移"（文件缺失 / target / icon / AUMID 错误）。
  // 注意：抹掉参数的元凶不是 setUserTasks 本身，而是 Explorer 发现登记快捷方式被
  // 外部改写后做的异步归一化（见 isWindowsNormalizedShortcut 的实测记录）。因此
  // 这里绝不能把归一化裸版再改回带参数版——那只会让下一次 Jump List 提交再把
  // 任务项参数抹掉，"新建 AI Hub Community"反复退回 Electron 空壳。文件缺失时才补建，
  // 且本次提交已完成，补建不会影响刚登记的 Jump List。
  try {
    let current = null;
    const exists = fsModule.existsSync(shortcutPath);
    if (exists) {
      try { current = shell.readShortcutLink(shortcutPath); } catch {}
    }
    if (isWindowsNormalizedShortcut(current, expected)) {
      result.shortcutWindowsNormalized = true;
    } else if (!shortcutMatches(current, expected)) {
      const operation = exists ? 'replace' : 'create';
      const ok = shell.writeShortcutLink(shortcutPath, operation, expected);
      if (!ok) throw new Error(`writeShortcutLink returned false: ${shortcutPath}`);
      result.shortcutUpdated = true;
    }
  } catch (error) {
    result.errors.push(`Jump List 登记后快捷方式复核失败：${error.message}`);
  }

  if (result.errors.length) logger.warn('[windows-shell]', result.errors.join('；'));
  return result;
}

function startWindowsShellIntegrationWatchdog({
  intervalMs = 15 * 1000,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
  onRepair = null,
  onTick = null,
  logger = console,
  ...integrationOptions
} = {}) {
  let checking = false;
  const audit = () => {
    if (checking) return null;
    checking = true;
    try {
      // onTick 每一拍都跑，与快捷方式是否漂移无关 —— 窗口 HICON 的丢失和快捷方式
      // 的漂移是两件独立的事。Explorer 崩溃重启会重建任务栏并丢掉 HICON，但快捷
      // 方式本身完好，健康检查会直接 return，onRepair 永远不触发。把「重贴图标」
      // 挂在 onRepair 上就是 2026-08-08 那次图标变原子没能自愈的原因。
      if (typeof onTick === 'function') {
        try { onTick(); } catch (error) {
          logger.warn?.(`[windows-shell] watchdog onTick failed: ${error && error.message}`);
        }
      }
      if (isWindowsShellIntegrationHealthy(integrationOptions)) return null;
      const result = ensureWindowsShellIntegration({ ...integrationOptions, logger });
      if (result.shortcutUpdated) {
        logger.warn?.(`[windows-shell] 快捷方式丢失或漂移，已自动修复：${result.shortcutPath}`);
        if (typeof onRepair === 'function') onRepair(result);
      }
      return result;
    } finally {
      checking = false;
    }
  };
  const timer = setIntervalFn(audit, Math.max(1000, Number(intervalMs) || 15000));
  timer && timer.unref?.();
  return {
    audit,
    stop() { if (timer) clearIntervalFn(timer); },
  };
}

module.exports = {
  HUB_APP_USER_MODEL_ID,
  HUB_SHORTCUT_NAME,
  LEGACY_ELECTRON_SHORTCUT_NAME,
  LEGACY_DESKTOP_SHORTCUT_NAME,
  buildLaunchSpec,
  buildShortcutDetails,
  buildNewWindowTask,
  shortcutMatches,
  shortcutLaunchMatches,
  isPoisonedLegacyElectronShortcut,
  isWindowsNormalizedShortcut,
  shortcutHealthy,
  shortcutReferencesMissingPath,
  getShortcutPaths,
  isWindowsShellIntegrationHealthy,
  ensureWindowsShellIntegration,
  repointHubDesktopShortcuts,
  startWindowsShellIntegrationWatchdog,
};
