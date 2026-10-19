'use strict';
// 窗口缩放兜底（2026-10-19）。
//
// 公司真机：Hub 被远程更新 / 远程重启自动拉起后，窗口按 100% 缩放排版（show 事件记的是 2578×1398，屏幕实际 125%），
// 最小化再还原后才变成 2064×1120；这段时间里启动中心原生下拉框的弹层位置偏到窗口中间。
// 本机（直接启动、app.relaunch、更新脚本经隐藏 PowerShell 的 Start-Process 拉起）三种方式读数完全一致，
// 启动方式本身复现不出来，更可能是拉起那一刻显示器的状态（无人值守、锁屏、显示器休眠）让 Chromium 拿到了错误的缩放。
//
// 做法：窗口显示后、显示器参数变化、解锁 / 唤醒时各检查一次，只读不改；只有检测到「窗口的缩放和所在显示器的缩放不一致」才动作，
// 动作就是一次 setBounds（最大化的窗口是取消最大化 → 按所在显示器的工作区 setBounds → 重新最大化），
// 1 秒后复查，仍不一致只记日志、不再重试。正常启动时读数一致，什么都不做。
//
// 「不一致」的两个判据（任一成立）：
//   1. 页面的缩放（devicePixelRatio ÷ 页面缩放倍数）和所在显示器的 scaleFactor 相差超过 2%；
//   2. 窗口是最大化的，但宽或高比所在显示器的工作区大 15% 以上（按别的缩放排的版：125% 屏上按 100% 排，宽是工作区的 1.26 倍）。
//      正常最大化只比工作区多出边框（本机 2.25 倍屏：1720 对 1707，多 0.8%）。
const SCALE_TOLERANCE = 0.02;
const OVERSIZE_RATIO = 1.15;
const MAX_FIXES = 3;          // 一个进程里最多动作几次（防止异常情况下反复闪）
const RECHECK_MS = 1000;
const SHOW_DELAY_MS = 1500;
const DISPLAY_DEBOUNCE_MS = 1000;

// 纯函数：给定读数判断是否不一致。返回 null（一致或不该判断）或 { reasons, windowScale, displayScale }。
function detectScaleMismatch({ bounds, maximized = false, minimized = false, visible = true, fullScreen = false, display, windowScale } = {}) {
  // 全屏时窗口尺寸由系统定，不做处理（审核 2026-10-19）
  if (!visible || minimized || fullScreen || !bounds || !display) return null;
  const displayScale = Number(display.scaleFactor);
  const reasons = [];
  const ws = Number(windowScale);
  if (Number.isFinite(ws) && ws > 0 && Number.isFinite(displayScale) && displayScale > 0
      && Math.abs(ws - displayScale) / displayScale > SCALE_TOLERANCE) reasons.push('scale');
  const wa = display.workArea;
  if (maximized && wa && wa.width > 0 && wa.height > 0
      && (bounds.width > wa.width * OVERSIZE_RATIO || bounds.height > wa.height * OVERSIZE_RATIO)) reasons.push('maximized-oversize');
  return reasons.length ? { reasons, windowScale: Number.isFinite(ws) ? ws : null, displayScale } : null;
}

// 读当前窗口的读数（主进程）。probeOverride：端到端测试用，覆盖页面缩放读数（只在隔离实例里由 main.js 传入）。
async function readWindowScaleState(win, screen, { probeOverride = null } = {}) {
  if (!win || win.isDestroyed()) return null;
  const bounds = win.getBounds();
  const display = screen.getDisplayMatching(bounds);
  let windowScale = null;
  // 页面缩放倍数优先在页面里读（界面用 webFrame.setZoomLevel 调字号缩放，renderer/renderer.js），读不到再用主进程的。
  try {
    const r = await win.webContents.executeJavaScript(
      '(()=>{let z=null;try{z=require("electron").webFrame.getZoomFactor();}catch(_){}return {dpr:window.devicePixelRatio,zoom:z};})()', true);
    const zoom = Number(r && r.zoom) > 0 ? Number(r.zoom) : Number(win.webContents.getZoomFactor());
    if (Number(r && r.dpr) > 0 && zoom > 0) windowScale = Number(r.dpr) / zoom;
  } catch { windowScale = null; }
  const state = { bounds, maximized: win.isMaximized(), minimized: win.isMinimized(), visible: win.isVisible(),
    fullScreen: typeof win.isFullScreen === 'function' ? win.isFullScreen() : false,
    display: { id: display.id, scaleFactor: display.scaleFactor, workArea: display.workArea, bounds: display.bounds }, windowScale };
  if (probeOverride && typeof probeOverride === 'object') Object.assign(state, probeOverride);
  return state;
}

// 动作：一次 setBounds（最大化的先取消、按工作区 setBounds、再最大化）。
function applyScaleFix(win, state) {
  const wa = state.display && state.display.workArea;
  if (state.maximized) {
    win.unmaximize();
    if (wa) win.setBounds({ x: wa.x, y: wa.y, width: wa.width, height: wa.height });
    win.maximize();
    return 'remaximize';
  }
  if (!wa) return 'none';
  const b = state.bounds;
  const width = Math.min(b.width, wa.width), height = Math.min(b.height, wa.height);
  const x = Math.min(Math.max(b.x, wa.x), wa.x + wa.width - width), y = Math.min(Math.max(b.y, wa.y), wa.y + wa.height - height);
  win.setBounds({ x, y, width, height });
  return 'setbounds';
}

// 装到主窗口上。log(event, detail) 写 window-events.log。返回 { check(trigger) } 供测试与调试。
function installWindowScaleGuard(win, { screen, powerMonitor = null, log = () => {}, probeOverride = null, setTimeoutImpl = setTimeout, clearTimeoutImpl = clearTimeout,
  read = readWindowScaleState, fix = applyScaleFix } = {}) {
  if (!win || !screen || win.__hubScaleGuard) return null;
  let fixes = 0, running = false, displayTimer = null, disposed = false;
  const snapshot = s => s && { bounds: s.bounds, maximized: s.maximized, displayScale: s.display && s.display.scaleFactor,
    workArea: s.display && s.display.workArea, windowScale: s.windowScale };
  async function check(trigger) {
    if (disposed || running || !win || win.isDestroyed()) return null;
    running = true;
    try {
      const state = await read(win, screen, { probeOverride });
      const mismatch = detectScaleMismatch(state || {});
      if (trigger === 'show') log('scale-probe', { trigger, mismatch: mismatch ? mismatch.reasons : null, ...snapshot(state) });
      if (!mismatch) return null;
      if (fixes >= MAX_FIXES) { log('scale-mismatch-skipped', { trigger, reasons: mismatch.reasons, fixes, ...snapshot(state) }); return { mismatch, action: 'skipped' }; }
      fixes += 1;
      let action = 'none';
      try { action = fix(win, state); } catch (error) { log('scale-fix-failed', { trigger, error: error.message }); return { mismatch, action: 'failed' }; }
      log('scale-mismatch-fixed', { trigger, reasons: mismatch.reasons, action, ...snapshot(state) });
      await new Promise(r => setTimeoutImpl(r, RECHECK_MS));
      const after = await read(win, screen, { probeOverride: null });
      const still = detectScaleMismatch(after || {});
      log('scale-recheck', { trigger, ok: !still, reasons: still ? still.reasons : null, ...snapshot(after) });
      return { mismatch, action, after: still ? 'still-mismatch' : 'ok' };
    } catch (error) {
      log('scale-check-failed', { trigger, error: error && error.message });
      return null;
    } finally { running = false; }
  }
  const onDisplay = () => {
    clearTimeoutImpl(displayTimer);
    displayTimer = setTimeoutImpl(() => { void check('display-changed'); }, DISPLAY_DEBOUNCE_MS);
  };
  win.__hubScaleGuard = true;
  win.once('show', () => setTimeoutImpl(() => { void check('show'); }, SHOW_DELAY_MS));
  screen.on('display-metrics-changed', onDisplay);
  screen.on('display-added', onDisplay);
  screen.on('display-removed', onDisplay);
  const onUnlock = () => setTimeoutImpl(() => { void check('unlock'); }, SHOW_DELAY_MS);
  if (powerMonitor) { powerMonitor.on('unlock-screen', onUnlock); powerMonitor.on('resume', onUnlock); }
  win.once('closed', () => {
    disposed = true;
    clearTimeoutImpl(displayTimer);
    screen.removeListener('display-metrics-changed', onDisplay);
    screen.removeListener('display-added', onDisplay);
    screen.removeListener('display-removed', onDisplay);
    if (powerMonitor) { powerMonitor.removeListener('unlock-screen', onUnlock); powerMonitor.removeListener('resume', onUnlock); }
  });
  return { check };
}

module.exports = { detectScaleMismatch, readWindowScaleState, applyScaleFix, installWindowScaleGuard,
  SCALE_TOLERANCE, OVERSIZE_RATIO, MAX_FIXES };
