'use strict';
// 一键更新的主进程控制器（2026-10-13，公司版）：查版本 → 下载（多源自动切换）→ 暂存 → 用户点「立即重启」替换。
// 只有发行目标写了 update（community-edition.json）才会创建；主仓库和公开社区版没有这个入口。
// 状态全部推给渲染进程（app-update:state），界面照着画。
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { validateManifest, planUpdate, currentRuntime, compareVersions } = require('../core/app-update/manifest');
const { checkManifests, downloadWithFallback } = require('../core/app-update/downloader');
const { stageIncremental, stagingPaths, launchHelper, takeLastResult } = require('../core/app-update/apply');
const { verifyLocalFiles } = require('../core/app-update/payload');

const STARTUP_CHECK_DELAY_MS = 20000;
const PERIODIC_CHECK_MS = 6 * 60 * 60 * 1000;

function resolveFetch(fetchImpl) {
  if (typeof fetchImpl === 'function') return fetchImpl;
  try {
    const electron = require('electron');
    if (electron && electron.net && typeof electron.net.fetch === 'function') return (...args) => electron.net.fetch(...args);
  } catch (_) {}
  return globalThis.fetch;
}

// 测试用 AI_HUB_UPDATE_SOURCES（JSON 数组）把源换成本机服务；否则用发行目标里写的。
function resolveSources(config, env) {
  if (env.AI_HUB_UPDATE_SOURCES) {
    const list = JSON.parse(env.AI_HUB_UPDATE_SOURCES);
    if (!Array.isArray(list) || !list.length) throw new Error('AI_HUB_UPDATE_SOURCES 必须是非空数组');
    return list;
  }
  const list = config && Array.isArray(config.sources) ? config.sources : [];
  return list.filter(s => s && s.id && /^https:\/\//.test(String(s.manifest || '')) && /^https:\/\//.test(String(s.files || '')));
}

function createAppUpdateController({ app, config, dataDir, currentVersion, sendToRenderer = () => {}, logger = console,
  env = process.env, fetchImpl, resourcesPath = process.resourcesPath, isPackaged = !!(app && app.isPackaged), spawnImpl = spawn,
  // 拉起新程序用的干净环境与工作目录（core/clean-launch-env.js，2026-10-19）：main.js 传入；没传时按当前环境现算。
  prepareLaunch = () => require('../core/clean-launch-env').prepareHubLaunch({ env, isPackaged, appRoot: app && typeof app.getAppPath === 'function' ? app.getAppPath() : undefined }),
  // 「等通道问题答完再重启」的状态（2026-10-21，core/company-bridge/hub-admin.js restartWaitView）：只给界面看，不进 getState。
  restartWait = () => null }) {
  const sources = resolveSources(config, env);
  const releasePage = (config && config.releasePage) || '';
  let state = { phase: 'idle', current: currentVersion, sources: sources.map(s => ({ id: s.id, name: s.name })), releasePage, canApply: isPackaged || env.AI_HUB_UPDATE_FORCE_APPLY === '1' };
  let manifest = null, plan = null, abort = null, checkAbort = null, staged = null, checking = null, lastResult = null, timer = null;

  try { lastResult = takeLastResult(dataDir); } catch (error) { logger.warn?.('[app-update] 读取上次结果失败：', error.message); }
  if (lastResult) state.lastResult = lastResult;

  // 界面看到的 = 控制器状态 + 等待重启的状态（读不到就当没在等）。
  const view = () => { let wait = null; try { wait = restartWait() || null; } catch (_) {} return { ...state, restartWait: wait }; };
  const emit = patch => { state = { ...state, ...patch }; try { sendToRenderer('app-update:state', view()); } catch (_) {} return state; };

  async function check({ silent = false } = {}) {
    if (checking) return checking;
    if (['downloading', 'ready'].includes(state.phase)) return state;
    checking = (async () => {
      if (!silent) emit({ phase: 'checking', error: null });
      const fetchFn = resolveFetch(fetchImpl);
      checkAbort = new AbortController();
      const results = await checkManifests({ sources, fetchImpl: fetchFn, validate: validateManifest, signal: checkAbort.signal });
      if (checkAbort.signal.aborted) return emit({ phase: 'idle', error: null });
      const checks = results.map(r => ({ id: r.id, name: r.name, ok: r.ok, version: r.ok ? r.manifest.version : null, reason: r.reason || null,
        ...(r.blocked ? { blocked: true, url: r.url } : {}) }));
      const best = results.filter(r => r.ok).sort((a, b) => compareVersions(b.manifest.version, a.manifest.version))[0];
      if (!best) return emit({ phase: silent ? 'idle' : 'error', checks, checkedAt: new Date().toISOString(),
        error: '所有更新源都连不上，暂时查不到新版本', silentFailure: silent });
      manifest = best.manifest;
      // 能核对本机文件时才走小包（开发运行、没打包又没指定 resources 时无从核对）。
      const resDir = isPackaged || env.AI_HUB_UPDATE_RESOURCES ? (env.AI_HUB_UPDATE_RESOURCES || resourcesPath) : null;
      let runtime;
      try { runtime = currentRuntime({ resourcesPath: resDir }); }
      catch (_) { runtime = { electron: process.versions.electron, native: {} }; }
      if (!isPackaged && !env.AI_HUB_UPDATE_RESOURCES) runtime = { ...runtime, native: { ...manifest.runtime.native } };
      plan = planUpdate(manifest, { version: currentVersion, runtime });
      let variant = null;
      if (plan.kind === 'incremental') {
        const delta = manifest.incrementalDelta;
        if (delta && resDir && verifyLocalFiles(delta.requires, resDir).ok) variant = 'delta';
        else if (manifest.incremental) {
          variant = 'complete';
          // 小包的前提是本机那些没变的文件确实还是上一版的样子；对不上就退回完整更新包，仍然一步升到最新版。
          if (delta) plan = { ...plan, reason: '本机有些程序文件和这一版对不上，改为下载完整更新包（仍是一步升到最新版）' };
        } else plan = { kind: 'full', reason: '这一版只提供变化的程序文件，本机的程序文件对不上，需要完整安装包' };
      }
      const asset = plan.kind === 'incremental' ? (variant === 'delta' ? manifest.incrementalDelta : manifest.incremental) : plan.kind === 'full' ? manifest.installer : null;
      plan = { ...plan, variant, asset };
      return emit({ phase: plan.kind === 'none' ? 'none' : 'available', checks, checkedAt: new Date().toISOString(), error: null,
        latest: { version: manifest.version, notes: manifest.notes, publishedAt: manifest.publishedAt, sourceName: best.name },
        plan: { kind: plan.kind, variant: plan.variant, reason: plan.reason, bytes: plan.asset ? plan.asset.bytes : 0, file: plan.asset ? plan.asset.file : null } });
    })().catch(error => emit({ phase: silent ? 'idle' : 'error', error: `检查更新失败：${error.message}` }))
      .finally(() => { checking = null; checkAbort = null; });
    return checking;
  }

  async function download() {
    if (!manifest || !plan || plan.kind === 'none') throw new Error('还没有可下载的新版本，请先检查更新');
    if (state.phase === 'downloading') return state;
    const asset = plan.asset;
    const p = stagingPaths(dataDir);
    const dest = path.join(p.downloads, asset.file);
    abort = new AbortController();
    emit({ phase: 'downloading', attempts: [], progress: { received: 0, total: asset.bytes }, error: null });
    let lastEmit = 0;
    const result = await downloadWithFallback({ sources, version: manifest.version, expect: asset, dest, fetchImpl: resolveFetch(fetchImpl), signal: abort.signal,
      onAttempt: attempts => emit({ attempts }),
      onProgress: progress => { const now = Date.now(); if (now - lastEmit > 200 || progress.received === progress.total) { lastEmit = now; emit({ progress }); } } });
    abort = null;
    if (!result.ok) {
      return emit({ phase: result.cancelled ? 'available' : 'error', attempts: result.attempts,
        error: result.cancelled ? null : '所有下载源都失败了。可以稍后再试，或打开发布页手动下载安装包。' });
    }
    try {
      if (plan.kind === 'incremental') {
        if (!state.canApply) return emit({ phase: 'error', attempts: result.attempts, error: '开发运行的 Hub 不能自动替换程序文件，请用安装版' });
        staged = stageIncremental({ dataDir, payloadFile: dest, resourcesDir: env.AI_HUB_UPDATE_RESOURCES || resourcesPath, version: manifest.version, from: currentVersion,
          exe: process.execPath, args: process.argv.slice(1), simulateFailure: env.AI_HUB_UPDATE_SIMULATE_FAILURE || null });
        fs.rmSync(dest, { force: true });
      } else {
        staged = { installer: dest };
      }
    } catch (error) {
      // 下载到解包之间程序文件被改动过（很少见）：让用户再检查一次，下一次会自动改用完整更新包。
      if (error.code === 'stale-local') return emit({ phase: 'error', attempts: result.attempts,
        error: `本机程序文件在下载期间被改动过（${error.stale?.[0]?.path || '未知文件'}），请重新检查更新，这次会自动改用完整更新包` });
      return emit({ phase: 'error', attempts: result.attempts, error: `更新包解开或校验失败：${error.message}` });
    }
    return emit({ phase: 'ready', attempts: result.attempts, readySource: result.source.name });
  }

  function cancel() { if (abort) abort.abort(); if (checkAbort) checkAbort.abort(); return state; }

  // 用户点「立即重启」：增量 → 启动替换脚本后退出；完整安装包 → 打开安装程序后退出。
  function apply() {
    if (state.phase !== 'ready' || !staged) throw new Error('更新还没有下载好');
    // 安装程序装完会拉起新程序、替换脚本换完文件也会拉起新程序：都给干净环境（工作目录明显异常时才换成安装目录）。
    let launch = null;
    try { launch = prepareLaunch(); } catch (error) { logger.warn?.('[app-update] 准备干净启动环境失败，按当前环境启动：', error.message); }
    if (staged.installer) {
      const child = spawnImpl(staged.installer, [], { detached: true, stdio: 'ignore', windowsHide: false,
        ...(launch ? { env: launch.env, ...(launch.cwd ? { cwd: launch.cwd } : {}) } : {}) });
      child.unref?.();
    } else {
      launchHelper(staged.paths, { env: launch ? launch.env : env, spawnImpl });
    }
    emit({ phase: 'applying' });
    setTimeout(() => { try { app.quit(); } catch (error) { logger.warn?.('[app-update] 退出失败：', error.message); } }, 300);
    return state;
  }

  function startBackgroundChecks() {
    if (!sources.length) return;
    timer = setTimeout(function tick() {
      void check({ silent: true });
      timer = setTimeout(tick, PERIODIC_CHECK_MS);
      timer.unref?.();
    }, Number(env.AI_HUB_UPDATE_STARTUP_DELAY_MS || STARTUP_CHECK_DELAY_MS));
    timer.unref?.();
  }

  function dismissLastResult() { delete state.lastResult; return state; }

  // 界面弹出提示后就会 dismiss；家里远程更新（core/company-bridge/hub-admin.js）要在通道接通后另读一次本次启动读到的结果。
  return { check, download, cancel, apply, getState: () => state, view, startBackgroundChecks, dismissLastResult, lastResult: () => lastResult,
    dispose: () => { clearTimeout(timer); if (abort) abort.abort(); if (checkAbort) checkAbort.abort(); } };
}

// gate（2026-10-21）：公司版点「立即重启 / 立即安装」先过「通道问题答完再重启」这道关（hub-admin.js localApply）：
// { mode:'auto' } 有在途问题时回 needsConfirm；'wait' 答完再重启；'now' 立即重启（在途的记下、重启后接着做）；'cancel' 取消等待。
// 没有 gate（家里版、公开版、没有通道）照旧直接替换。
function registerAppUpdateIpc(ipcMain, controller, { gate = null } = {}) {
  ipcMain.handle('app-update:get-state', () => (controller.view ? controller.view() : controller.getState()));
  ipcMain.handle('app-update:check', () => controller.check({ silent: false }));
  ipcMain.handle('app-update:download', () => controller.download());
  ipcMain.handle('app-update:cancel', () => controller.cancel());
  ipcMain.handle('app-update:apply', (_e, opts) => {
    const mode = opts && ['auto', 'wait', 'now', 'cancel'].includes(opts.mode) ? opts.mode : 'auto';
    const viaGate = gate && typeof gate.apply === 'function' ? gate.apply({ mode }) : null;
    if (viaGate) return viaGate;
    if (mode === 'cancel') return controller.view ? controller.view() : controller.getState();
    return controller.apply();
  });
  ipcMain.handle('app-update:dismiss-result', () => controller.dismissLastResult());
}

module.exports = { createAppUpdateController, registerAppUpdateIpc, resolveSources };
