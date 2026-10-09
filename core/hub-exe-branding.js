'use strict';

/**
 * 任务栏图标根治：给源码模式的 Hub 一个自己的品牌化 exe。
 *
 * ## 为什么 setIcon 治不好
 *
 * Windows 取任务栏按钮图标的顺序是：
 *   1. WM_GETICON(ICON_SMALL2 → ICON_SMALL → ICON_BIG)  ← Electron 的 win.setIcon() 只写这一层
 *   2. GetClassLongPtr(GCLP_HICONSM → GCLP_HICON)       ← 窗口"类"图标
 *   3. 进程 exe 内嵌的图标资源
 *
 * 第 1 步用的是 SendMessageTimeout + SMTO_ABORTIFHUNG。Explorer 重建任务栏
 * （崩溃重启、DPI 切换、窗口重新分组）时会重新问一遍；只要主进程那一瞬间在忙
 * （PTY 洪水、state.json 落盘、transcript 解析），问询就超时，Windows 直接落到
 * 第 2 步并把结果缓存住。
 *
 * 而 Chromium 的窗口类图标是从 **宿主 exe 的图标资源** 来的。源码模式跑的是
 * 原装 electron.exe，它的资源里就是 Electron 原子 —— 所以第 2、3 步拿到的都是原子。
 * 2026-08-08 实测：运行中的 Hub 窗口 WM_GETICON 是橙色 logo，GCLP_HICON 是原子。
 * 历史上所有修复（b4fd5d5 挂 show/restore、2f7425d 挂 watchdog onTick）都只在
 * 第 1 层反复重贴，第 2、3 层的原子一直没动过，所以图标每隔一阵就变回去。
 *
 * ## 做法
 *
 * 把 electron.exe 复制成同目录下的 AIHubCommunity.exe，用 resedit 把图标资源和
 * 版本信息换成 Hub 自己的，快捷方式改指这个副本。于是三层全是橙色 logo，
 * Explorer 怎么重建都不会再摸到原子。
 *
 * ## 为什么不直接改 electron.exe
 *
 * 本仓库最大的历史事故都是 node_modules 被写坏（见 CLAUDE.md 铁律）。原地改
 * electron.exe 需要 Hub 先关掉，且 npm install 会静默把它换回去而没人发现。
 * 只新增一个副本则完全不碰 electron.exe：E2E/隔离测试仍直调 electron.exe，
 * 行为零变化；副本坏了删掉即可，下次启动自动重建。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const BRANDED_EXE_NAME = 'AIHubCommunity.exe';
const BRAND_STAMP_NAME = '.hub-brand-stamp.json';
const STALE_SUFFIX_PREFIX = '.stale-';
const STAMP_VERSION = 2;

/** electron.exe 220MB+，副本生成要读+写一整遍，别在主进程里同步干。 */
const BRANDING_MIN_HOST_BYTES = 1024 * 1024;

function sha256File(filePath, fsModule = fs) {
  const hash = crypto.createHash('sha256');
  hash.update(fsModule.readFileSync(filePath));
  return hash.digest('hex');
}

function brandedExePathFor(hostExePath) {
  return path.join(path.dirname(path.resolve(hostExePath)), BRANDED_EXE_NAME);
}

function brandStampPathFor(hostExePath) {
  return path.join(path.dirname(path.resolve(hostExePath)), BRAND_STAMP_NAME);
}

function isBrandedExePath(exePath) {
  return path.basename(String(exePath || '')).toLowerCase() === BRANDED_EXE_NAME.toLowerCase();
}

/**
 * 当前进程可能已经是从品牌化副本启动的。那时 process.execPath 指向副本，
 * 真正的"源"仍然是同目录的 electron.exe。
 */
function resolveHostExePath(execPath) {
  const resolved = path.resolve(String(execPath || ''));
  if (!isBrandedExePath(resolved)) return resolved;
  return path.join(path.dirname(resolved), 'electron.exe');
}

function computeBrandStamp({ hostExePath, icoPath, productVersion, fsModule = fs }) {
  const hostStat = fsModule.statSync(hostExePath);
  return {
    v: STAMP_VERSION,
    hostSize: hostStat.size,
    // mtimeMs 取整到毫秒：不同文件系统的亚毫秒精度不一致，会让 stamp 每次都对不上。
    hostMtimeMs: Math.floor(hostStat.mtimeMs),
    icoSha256: sha256File(icoPath, fsModule),
    productVersion: String(productVersion || ''),
  };
}

function readBrandStamp(stampPath, fsModule = fs) {
  try {
    const parsed = JSON.parse(fsModule.readFileSync(stampPath, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function brandStampMatches(actual, expected) {
  if (!actual || !expected) return false;
  return Number(actual.v) === Number(expected.v)
    && Number(actual.hostSize) === Number(expected.hostSize)
    && Number(actual.hostMtimeMs) === Number(expected.hostMtimeMs)
    && String(actual.icoSha256) === String(expected.icoSha256)
    && String(actual.productVersion) === String(expected.productVersion);
}

/**
 * 品牌化副本是否可用且与当前 electron.exe / 图标同步。
 * @returns {{ ok: boolean, reason: string, brandedExePath: string, stampPath: string, expected: object|null }}
 */
function inspectBrandedHubExe({
  execPath,
  icoPath,
  productVersion,
  platform = process.platform,
  fsModule = fs,
  minExeBytes = BRANDING_MIN_HOST_BYTES,
} = {}) {
  const hostExePath = resolveHostExePath(execPath);
  const brandedExePath = brandedExePathFor(hostExePath);
  const stampPath = brandStampPathFor(hostExePath);
  const base = { brandedExePath, stampPath, hostExePath, expected: null };

  if (platform !== 'win32') return { ...base, ok: false, reason: 'not-win32' };
  if (!fsModule.existsSync(hostExePath)) return { ...base, ok: false, reason: 'host-exe-missing' };
  if (!icoPath || !fsModule.existsSync(icoPath)) return { ...base, ok: false, reason: 'icon-missing' };

  let expected;
  try {
    expected = computeBrandStamp({ hostExePath, icoPath, productVersion, fsModule });
  } catch (error) {
    return { ...base, ok: false, reason: `stamp-failed:${error.message}` };
  }
  const withExpected = { ...base, expected };

  if (!fsModule.existsSync(brandedExePath)) {
    return { ...withExpected, ok: false, reason: 'branded-exe-missing' };
  }
  // 副本被截断/写了一半（上次生成被打断）也算不可用，别把半个 exe 挂到快捷方式上。
  try {
    if (fsModule.statSync(brandedExePath).size < minExeBytes) {
      return { ...withExpected, ok: false, reason: 'branded-exe-truncated' };
    }
  } catch (error) {
    return { ...withExpected, ok: false, reason: `branded-exe-stat-failed:${error.message}` };
  }
  if (!brandStampMatches(readBrandStamp(stampPath, fsModule), expected)) {
    return { ...withExpected, ok: false, reason: 'stamp-stale' };
  }
  return { ...withExpected, ok: true, reason: 'current' };
}

/**
 * 快捷方式该指向谁：副本可用就用副本，否则回落 electron.exe。
 * 回落保证任何环节出问题时桌面图标仍然能把 Hub 拉起来。
 */
function resolveHubLaunchExePath(options = {}) {
  const inspection = inspectBrandedHubExe(options);
  return inspection.ok ? inspection.brandedExePath : inspection.hostExePath;
}

/**
 * npm install / npm ci 换掉 Electron 时会把整个 dist 目录重建，品牌化副本随之消失。
 * 快捷方式此刻指着一个不存在的 exe —— 桌面图标点开没反应，正是 CLAUDE.md 里
 * 反复出现的那类事故。这个判定让调用方能提前把话说明白。
 */
function describeBrandingHealth(options = {}) {
  const inspection = inspectBrandedHubExe(options);
  if (inspection.ok) return { healthy: true, message: '', ...inspection };
  const hints = {
    'branded-exe-missing': '品牌化 exe 不存在（多半是 npm install/ci 重建了 electron dist），快捷方式已回落 electron.exe',
    'branded-exe-truncated': '品牌化 exe 不完整（上次生成被打断），需要重建',
    'stamp-stale': 'Electron 或图标已更新，品牌化 exe 过期，需要重建',
    'icon-missing': 'claude-wx.ico 找不到，无法品牌化',
    'host-exe-missing': 'electron.exe 找不到，node_modules 可能已损坏',
  };
  return { healthy: false, message: hints[inspection.reason] || inspection.reason, ...inspection };
}

function parseVersionQuad(version) {
  const parts = String(version || '').split(/[.\-+]/).map(n => parseInt(n, 10));
  const quad = [0, 0, 0, 0];
  for (let i = 0; i < 4; i++) {
    quad[i] = Number.isFinite(parts[i]) ? Math.max(0, Math.min(65535, parts[i])) : 0;
  }
  return quad;
}

/**
 * 把 ico 的图标组和版本信息写进 PE 资源。resedit 是纯 JS（electron-builder 的
 * 传递依赖，已在 node_modules 里），不需要 VS Build Tools，也不需要 native 编译。
 */
function applyBrandingToBuffer({ buffer, icoBuffer, productName, productVersion, resedit }) {
  const exe = resedit.NtExecutable.from(buffer);
  const res = resedit.NtExecutableResource.from(exe);

  const iconFile = resedit.Data.IconFile.from(icoBuffer);
  // iconGroupID=1 / lang=1033：Chromium 建窗口类时取的就是 exe 里的第一个图标组
  // （IDR_MAINFRAME），electron.exe 里它的 ID 就是 1。换掉它才能改到窗口类图标。
  resedit.Resource.IconGroupEntry.replaceIconsForResource(
    res.entries, 1, 1033, iconFile.icons.map(item => item.data)
  );

  const [major, minor, micro, revision] = parseVersionQuad(productVersion);
  const versionInfo = resedit.Resource.VersionInfo.fromEntries(res.entries)[0]
    || resedit.Resource.VersionInfo.createEmpty();
  versionInfo.setFileVersion(major, minor, micro, revision, 1033);
  versionInfo.setProductVersion(major, minor, micro, revision, 1033);
  versionInfo.setStringValues({ lang: 1033, codepage: 1200 }, {
    // FileDescription 就是任务管理器 / Alt+Tab 显示的名字。
    FileDescription: productName,
    ProductName: productName,
    InternalName: BRANDED_EXE_NAME,
    OriginalFilename: BRANDED_EXE_NAME,
    CompanyName: productName,
    LegalCopyright: '',
  });
  versionInfo.outputToResourceEntries(res.entries);

  res.outputResource(exe);
  return Buffer.from(exe.generate());
}

const IN_USE_ERROR_CODES = new Set(['EBUSY', 'EPERM', 'EACCES']);

function samePathIgnoringCase(left, right, platform = process.platform) {
  const a = path.resolve(String(left || ''));
  const b = path.resolve(String(right || ''));
  return platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/**
 * 品牌化副本此刻是否正被某个 Hub 实例执行。
 *
 * ⚠ 这条判断是 2026-08-29 那次「文件预览突然打不开」的正解，别删。
 *
 * Windows 允许**改名**一个正在执行的映像（自更新程序都这么干），所以原来的
 * 「先把旧副本改名成 .stale-* 腾位、再把新副本放回原路径」看起来是安全的。
 * 实测不是：真 Hub 跑起来之后做这套动作，之后每一次创建 Chromium 子进程都会
 * 失败 —— webview 直接 `render-process-gone reason=launch-failed exitCode=57`。
 * 用户侧的表现就是「文件预览挂了」（预览是唯一按需新建渲染进程的功能），
 * 而窗口本身还好好的，因为它的渲染进程是换 exe 之前就建好的。
 *
 * 复现（真 Hub，非最小 app —— 最小 app 复现不出来，会给出假阴性）：
 *   起 Hub → 探针建 webview = loaded → 把运行中的 exe 改名并放一个新副本回去
 *   → 再探针 = launch-failed exitCode=57。
 *
 * 而品牌化本身只是图标和版本资源，远没有重要到值得打断用户正开着的窗口。
 * 「每次改动同步升版本号」是铁律，也就意味着 stamp 会频繁失配、重建会频繁触发，
 * 所以这里必须有闸门：有实例在跑就跳过，留着 stamp 失配，下次冷启动再补。
 *
 * 判据用「能不能以写方式打开」：Windows 对正在执行的映像禁止写打开（EBUSY），
 * 这条在本机实测过（跑着的 AIHubCommunity.exe → EBUSY；没人跑的副本 → 可写）。
 * 误判只会偏向「跳过重建」，不会偏向「打断实例」。
 */
function brandedExeInUse({
  brandedExePath,
  execPath,
  fsModule = fs,
  platform = process.platform,
} = {}) {
  if (platform !== 'win32') return false;
  if (!brandedExePath || !fsModule.existsSync(brandedExePath)) return false;
  // 自己就跑在这个副本上。brand-hub-exe.js 是 Hub 用 ELECTRON_RUN_AS_NODE spawn 的，
  // 子进程的 execPath 就是父 Hub 的 exe，所以这一条同时覆盖了「父实例正在跑」。
  if (samePathIgnoringCase(execPath, brandedExePath, platform)) return true;
  try {
    fsModule.closeSync(fsModule.openSync(brandedExePath, 'r+'));
    return false;
  } catch (error) {
    return IN_USE_ERROR_CODES.has(error && error.code);
  }
}

function cleanupStaleBrandedExes({ hostExePath, fsModule = fs, logger = console } = {}) {
  const dir = path.dirname(path.resolve(hostExePath));
  const removed = [];
  let names = [];
  try { names = fsModule.readdirSync(dir); } catch { return removed; }
  for (const name of names) {
    if (!name.startsWith(`${BRANDED_EXE_NAME}${STALE_SUFFIX_PREFIX}`)) continue;
    try {
      fsModule.rmSync(path.join(dir, name), { force: true });
      removed.push(name);
    } catch (error) {
      // 还被上一次运行的进程锁着很正常，下次启动再删。
      logger.debug?.(`[hub-brand] stale copy still locked: ${name} (${error.code || error.message})`);
    }
  }
  return removed;
}

/**
 * 生成/刷新品牌化副本。幂等：stamp 对得上就直接返回 skipped。
 *
 * @returns {{ changed: boolean, reason: string, brandedExePath: string, error?: string }}
 */
function ensureBrandedHubExe({
  execPath,
  icoPath,
  productName = 'AI Hub Community',
  productVersion = '',
  platform = process.platform,
  fsModule = fs,
  resedit = null,
  logger = console,
  minExeBytes = BRANDING_MIN_HOST_BYTES,
} = {}) {
  const inspection = inspectBrandedHubExe({ execPath, icoPath, productVersion, platform, fsModule, minExeBytes });
  const { hostExePath, brandedExePath, stampPath, expected } = inspection;

  if (platform !== 'win32') return { changed: false, reason: 'not-win32', brandedExePath };
  if (inspection.ok) {
    cleanupStaleBrandedExes({ hostExePath, fsModule, logger });
    return { changed: false, reason: 'current', brandedExePath };
  }
  if (!expected) return { changed: false, reason: inspection.reason, brandedExePath };

  // 有 Hub 实例正跑在这个副本上就不要动它 —— 换掉之后那些实例再也起不了
  // Chromium 子进程（预览直接 launch-failed）。详见 brandedExeInUse 的注释。
  // 放在生成 buffer 之前：220MB 的读+改+写没必要白跑一趟。
  if (brandedExeInUse({ brandedExePath, execPath, fsModule, platform })) {
    logger.log?.('[hub-brand] 有实例正在运行该副本，本次跳过重建（下次冷启动再补）');
    return { changed: false, reason: 'branded-exe-in-use', brandedExePath, deferred: true };
  }

  let lib = resedit;
  if (!lib) {
    try {
      lib = require('resedit');
    } catch (error) {
      return { changed: false, reason: 'resedit-unavailable', brandedExePath, error: error.message };
    }
  }

  const tmpPath = `${brandedExePath}.tmp-${process.pid}-${Date.now()}`;
  try {
    const branded = applyBrandingToBuffer({
      buffer: fsModule.readFileSync(hostExePath),
      icoBuffer: fsModule.readFileSync(icoPath),
      productName,
      productVersion,
      resedit: lib,
    });
    fsModule.writeFileSync(tmpPath, branded);

    if (fsModule.existsSync(brandedExePath)) {
      // 副本此刻可能正被运行中的 Hub 占用。Windows 允许 rename 一个正在执行的
      // 映像（自更新程序都这么干），但不允许 delete —— 所以先改名腾位置，
      // 残留的 .stale-* 留给下次启动清理。
      const stalePath = `${brandedExePath}${STALE_SUFFIX_PREFIX}${Date.now()}`;
      fsModule.renameSync(brandedExePath, stalePath);
    }
    fsModule.renameSync(tmpPath, brandedExePath);
    fsModule.writeFileSync(stampPath, `${JSON.stringify(expected, null, 2)}\n`, 'utf8');
    cleanupStaleBrandedExes({ hostExePath, fsModule, logger });
    return { changed: true, reason: inspection.reason, brandedExePath };
  } catch (error) {
    try { if (fsModule.existsSync(tmpPath)) fsModule.rmSync(tmpPath, { force: true }); } catch {}
    logger.warn?.(`[hub-brand] 品牌化 exe 生成失败（快捷方式回落 electron.exe）：${error.message}`);
    return { changed: false, reason: 'branding-failed', brandedExePath, error: error.message };
  }
}

module.exports = {
  BRANDED_EXE_NAME,
  BRAND_STAMP_NAME,
  applyBrandingToBuffer,
  brandStampMatches,
  brandStampPathFor,
  brandedExeInUse,
  brandedExePathFor,
  cleanupStaleBrandedExes,
  computeBrandStamp,
  describeBrandingHealth,
  ensureBrandedHubExe,
  inspectBrandedHubExe,
  isBrandedExePath,
  parseVersionQuad,
  readBrandStamp,
  resolveHostExePath,
  resolveHubLaunchExePath,
};
