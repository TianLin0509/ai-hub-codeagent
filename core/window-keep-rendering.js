'use strict';
// 窗口在屏幕上就一直出帧，并把窗口事件记进 <数据目录>/logs/window-events.log（2026-10-10）。
//
// 公司真机：开几个 CodeAgent 会话点「后台」后画面冻住，约半分钟后黑屏。取证数据是 0 帧/秒、
// 计时器从每 100 ms 掉到每秒一次、各进程几乎空闲 —— 这是 Chromium 把页面当成「不可见」后的
// 节能状态（本机把窗口最小化能复现出完全相同的数字）：不再出帧，旧画面过一阵被回收，窗口只剩
// 背景色 #0d1117，看上去就是黑屏。是什么让那台电脑上的窗口被判成不可见，现场还没抓到。
//
// 做法：
//   1. 关掉后台节流（Electron 的 backgroundThrottling 为 false 时页面不会被判成不可见），不管触发者
//      是谁，画面都继续刷新。本机复现：窗口被别的程序不激活地还原后，Chromium 先判可见、33 ms 后又判成
//      不可见（窗口 minimized:false visible:true），之后一直 0 帧。代价：最小化时也照常绘制 ——
//      Electron 在最小化之后再打开节流并不会让已显示的页面重新隐藏，按状态来回切换做不到省电，只会多一层逻辑。
//   2. 把可见性变化、最小化/还原、无响应、渲染/子进程退出、出帧停顿写进日志文件，带时间和窗口状态，
//      下次出事直接看文件就知道发生了什么。
// 社区版默认开启（公司版就是社区版）；AI_HUB_KEEP_RENDERING=1 / 0 可强制打开 / 关闭。
const fs = require('fs');
const path = require('path');

const LOG_LIMIT_BYTES = 512 * 1024;

function shouldKeepRendering({ env = process.env, community = false } = {}) {
  if (env.AI_HUB_KEEP_RENDERING === '1') return true;
  if (env.AI_HUB_KEEP_RENDERING === '0') return false;
  return !!community;
}

function createWindowEventLog(file, { now = () => new Date(), logger = console } = {}) {
  return function write(event, detail = {}) {
    const line = `${now().toISOString()} ${event} ${JSON.stringify(detail)}`;
    try { logger.log?.(`[window] ${event} ${JSON.stringify(detail)}`); } catch {}
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      try { if (fs.statSync(file).size > LOG_LIMIT_BYTES) fs.renameSync(file, file + '.1'); } catch {}
      fs.appendFileSync(file, line + '\n', 'utf8');
    } catch {}
  };
}

function windowState(win) {
  try {
    return { minimized: win.isMinimized(), visible: win.isVisible(), focused: win.isFocused(), bounds: win.getBounds() };
  } catch { return {}; }
}

function installWindowKeepRendering(win, { app, ipcMain, dataDir, enabled, logger = console } = {}) {
  if (!win || win.__hubKeepRendering) return null;
  win.__hubKeepRendering = true;
  const log = createWindowEventLog(path.join(dataDir, 'logs', 'window-events.log'), { logger });
  const contents = win.webContents;
  const setThrottling = (allowed) => { try { contents.setBackgroundThrottling(allowed); } catch {} };
  log('start', { keepRendering: !!enabled, pid: process.pid });
  if (enabled) setThrottling(false);
  win.on('minimize', () => log('minimize', windowState(win)));
  win.on('restore', () => log('restore', windowState(win)));
  win.on('hide', () => log('hide', windowState(win)));
  win.on('show', () => log('show', windowState(win)));
  win.on('unresponsive', () => log('unresponsive', windowState(win)));
  win.on('responsive', () => log('responsive', windowState(win)));
  contents.on('render-process-gone', (_e, d) => log('render-process-gone', { reason: d && d.reason, exitCode: d && d.exitCode }));
  const onChildGone = (_e, d) => log('child-process-gone', { type: d && d.type, reason: d && d.reason, exitCode: d && d.exitCode, name: d && d.name });
  app?.on?.('child-process-gone', onChildGone);
  const onPage = (event, payload = {}) => {
    if (event.sender !== contents) return;
    log(`page-${String(payload.event || 'event').replace(/[^\w-]/g, '')}`, { ...payload, event: undefined, window: windowState(win) });
  };
  ipcMain?.on?.('hub:page-window-event', onPage);
  win.once('closed', () => {
    app?.removeListener?.('child-process-gone', onChildGone);
    ipcMain?.removeListener?.('hub:page-window-event', onPage);
  });
  return { log };
}

module.exports = { shouldKeepRendering, createWindowEventLog, installWindowKeepRendering, LOG_LIMIT_BYTES };
