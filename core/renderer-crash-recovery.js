'use strict';
// 界面进程崩溃后自动重新载入界面，并留下判断崩溃原因用的证据（2026-10-14）。
//
// 公司真机 v1.0.3（i7-9700、UHD 630、2560×1440 双屏）：界面先卡 9–20 秒（window-events.log 记
// unresponsive），随后界面进程崩溃（render-process-gone crashed，exitCode -36861）。主进程和各会话都还
// 活着，但窗口里只剩背景色 #0d1117 —— 这就是「先卡顿、后黑屏」，用户只能关掉重开。10-11 v0.5.9 启动卡死
// 也是同一个退出码。本机实测：没开崩溃转储时，界面内存涨满和界面进程直接崩溃（process.crash）都记成
// crashed / -36861，所以这个退出码只说明「界面进程崩了」，分不出原因；打开 crashReporter 后内存涨满记成
// oom / -536870904（0xE0000008），能分开。只卡不涨内存的死循环 3 分钟都不崩。
//
// 做法：
//   1. 自动恢复：终端、CLI、会话状态都在主进程里，界面重新载入后走和启动时同一条路（get-sessions）
//      取回在跑的会话。所以崩溃后约 1 秒重新载入界面，并告诉界面这是一次恢复，由界面提示用户。
//      不在 render-process-gone 回调里同步载入（Electron #51900：同步 reload 会让主进程崩溃）。
//      防循环：10 分钟内最多自动恢复 3 次，再崩就显示一页说明，不再重试。
//   2. 证据：每 30 秒记一次界面进程内存（只留内存里最近 10 次），无响应和崩溃时把这串数字写进
//      window-events.log，用来区分「内存涨爆了」和「别的原因」；内存第一次越过 1/2/3 GB 时也记一笔。
//      崩溃转储由 main.js 打开的 crashReporter 留在本机（不上传）。
//   3. 卡住时抓界面正在跑的代码：无响应（或页面心跳停了 6 秒）时用 collectJavaScriptCallStack 取界面线程当时的调用栈（每 2 秒一次，
//      最多 3 次），写进 window-events.log，下次出事直接看到是哪个功能把界面卡住、把内存吃满。这个接口要页面
//      声明 Document-Policy: include-js-call-stacks-in-crash-reports，本地文件没有响应头，meta 标签也不认
//      （Electron 41 实测），所以主进程接管 file:// 载入，只给界面主页面 index.html 补这个响应头，其余文件原样
//      交回 Chromium 自带的文件处理。AI_HUB_HANG_STACKS=0 可关掉。
//   4. 卡死自救：页面心跳连续 30 秒没来，就先记下当时的代码和内存，再结束界面进程，走第 1 条的重新载入，
//      不让窗口一直冻着。观察到的卡顿最长 18 秒后自己缓过来，30 秒留出余量。电脑睡眠唤醒、主进程自己
//      被卡住时，主进程这边的计时也停了，那段时间不算界面没心跳。AI_HUB_STALL_RESCUE_SEC 改秒数，0 关掉。
const url = require('url');
const path = require('path');

const RECOVER_DELAY_MS = 1000;
const RECOVER_WINDOW_MS = 10 * 60 * 1000;
const RECOVER_MAX = 3;
const SAMPLE_MS = 30 * 1000;
const SAMPLE_KEEP = 10;
const MEMORY_MARKS_MB = [1024, 2048, 3072];
const RECOVERABLE = new Set(['crashed', 'oom', 'killed', 'abnormal-exit', 'memory-eviction']);

const HEARTBEAT_CHANNEL = 'hub:renderer-heartbeat';
const STALL_MS = 6000;
const STALL_TICK_MS = 2000;
const RESCUE_STALL_MS = 30 * 1000;
const HANG_STACK_TRIES = 3;
const HANG_STACK_GAP_MS = 2000;
const HANG_STACK_POLICY = 'include-js-call-stacks-in-crash-reports';

const mb = kb => Math.round((Number(kb) || 0) / 1024);

// 调用栈里的 file:///.../resources/app.asar/renderer/x.js:12:3 只留 renderer/x.js:12:3，日志短、不带用户目录。
function shortenStack(stack) {
  return String(stack == null ? '(空)' : stack)
    .replace(/file:\/\/\/[^\s)]*?\/((?:renderer|core|main|node_modules)\/[^\s)]+)/g, '$1')
    .replace(/file:\/\/\/[^\s)]*\/([^/\s)]+)/g, '$1')
    .trim()
    .slice(0, 4000);
}

// 只给界面主页面补 Document-Policy 响应头。页面的这项声明在主文档载入时就定下了，所以只在载入主页面前
// 接管 file://，主页面一交出去就撤掉，其余文件仍由 Chromium 自带的文件处理（含 asar）直接读：全程接管时
// 每个图片/样式都要绕主进程一圈，本机实测页面载入慢 150–350 ms。返回 arm()：每次载入主页面前调用一次；
// 关掉（AI_HUB_HANG_STACKS=0）或接口不可用时返回 null。
function installHangStackOptIn({ protocol, net, indexPath, env = process.env, logger = console } = {}) {
  if (String(env.AI_HUB_HANG_STACKS || '').trim() === '0') return null;
  if (!protocol || typeof protocol.handle !== 'function' || typeof protocol.unhandle !== 'function' || !net || typeof net.fetch !== 'function') return null;
  const target = path.resolve(indexPath).toLowerCase();
  const isIndex = requestUrl => {
    try { return path.resolve(url.fileURLToPath(requestUrl.split(/[?#]/)[0])).toLowerCase() === target; } catch { return false; }
  };
  let armed = false;
  const disarm = () => {
    if (!armed) return;
    armed = false;
    try { protocol.unhandle('file'); } catch {}
  };
  const handler = async request => {
    const response = await net.fetch(request, { bypassCustomProtocolHandlers: true });
    if (!isIndex(request.url)) return response;
    disarm();
    if (!response.ok) return response;
    const headers = new Headers(response.headers);
    headers.set('Document-Policy', HANG_STACK_POLICY);
    if (!headers.get('Content-Type')) headers.set('Content-Type', 'text/html; charset=utf-8');
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  };
  return {
    arm() {
      if (armed) return true;
      try { protocol.handle('file', handler); armed = true; return true; }
      catch (error) {
        try { logger.warn?.('[crash-recovery] hang-stack opt-in failed:', error && error.message); } catch {}
        return false;
      }
    },
    disarm,
    get armed() { return armed; },
  };
}

function gaveUpPage(reason, exitCode) {
  const html = `<!doctype html><meta charset="utf-8"><title>AI Hub</title>
<body style="margin:0;background:#0d1117;color:#e6edf3;font:15px/1.7 'Microsoft YaHei',sans-serif;display:flex;align-items:center;justify-content:center;height:100vh">
<div style="max-width:560px;padding:24px"><h2 style="font-weight:600;margin:0 0 12px">界面连续崩溃，已停止自动恢复</h2>
<p style="margin:0 0 8px">10 分钟内界面进程崩溃超过 ${RECOVER_MAX} 次（最近一次：${reason}，退出码 ${exitCode}）。会话仍在后台，请关闭并重新打开 AI Hub。</p>
<p style="margin:0;color:#8b949e">记录在数据目录 logs\\window-events.log，反馈问题时一并带上。</p></div></body>`;
  return 'data:text/html;charset=utf-8,' + encodeURIComponent(html);
}

function installRendererCrashRecovery(win, {
  app,
  ipcMain,
  log = () => {},
  reload,
  now = () => Date.now(),
  setTimeoutFn = setTimeout,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
  enabled = true,
  hangStacks = true,
  rescueStallMs = RESCUE_STALL_MS,
} = {}) {
  if (!win || win.__hubCrashRecovery) return null;
  win.__hubCrashRecovery = true;
  const contents = win.webContents;
  const recoveries = [];
  const samples = [];
  const marked = new Set();
  let pendingRecovery = null;

  function sampleMemory() {
    try {
      const pid = contents.getOSProcessId();
      const metric = (app.getAppMetrics() || []).find(item => item.pid === pid);
      if (!metric || !metric.memory) return null;
      const sample = { at: new Date(now()).toISOString().slice(11, 19), workingSetMB: mb(metric.memory.workingSetSize), privateMB: mb(metric.memory.privateBytes) };
      samples.push(sample);
      if (samples.length > SAMPLE_KEEP) samples.shift();
      const top = Math.max(sample.workingSetMB, sample.privateMB);
      for (const mark of MEMORY_MARKS_MB) {
        if (top >= mark && !marked.has(mark)) { marked.add(mark); log('renderer-memory', { overMB: mark, ...sample }); }
      }
      return sample;
    } catch { return null; }
  }
  const timer = setIntervalFn(sampleMemory, SAMPLE_MS);
  try { timer?.unref?.(); } catch {}

  let hung = false;
  let hungAt = 0;
  let rescuing = false;
  async function captureHangStacks() {
    for (let n = 1; n <= HANG_STACK_TRIES && hung && !win.isDestroyed?.(); n++) {
      let stack;
      try {
        const frame = contents.mainFrame;
        if (!frame || typeof frame.collectJavaScriptCallStack !== 'function') { log('renderer-hang-stack', { n, error: 'api-missing' }); return; }
        stack = await Promise.race([frame.collectJavaScriptCallStack(), new Promise(resolve => setTimeoutFn(() => resolve('(8 秒没拿到调用栈)'), 8000))]);
      } catch (error) { stack = `(取调用栈失败：${error && error.message || error})`; }
      log('renderer-hang-stack', { n, stack: shortenStack(stack) });
      if (n < HANG_STACK_TRIES) await new Promise(resolve => setTimeoutFn(resolve, HANG_STACK_GAP_MS));
    }
  }
  function onHang(source, extra = {}) {
    log('renderer-memory-at-hang', { source, ...extra, recent: samples.slice(), now: sampleMemory() });
    if (hung) return;
    hung = true;
    hungAt = now();
    if (hangStacks) void captureHangStacks();
  }
  function rescueStall(silentMs) {
    if (rescuing || pendingRecovery) return;
    rescuing = true;
    log('renderer-stall-rescue', { silentMs, now: sampleMemory() });
    try {
      if (typeof contents.forcefullyCrashRenderer !== 'function') throw new Error('forcefullyCrashRenderer missing');
      contents.forcefullyCrashRenderer();
    } catch (error) {
      rescuing = false;
      log('renderer-recover-failed', { message: `结束卡死的界面进程失败：${error && error.message || error}` });
    }
  }
  // Chromium 的「无响应」只在有真实键鼠输入没被处理时才判（程序模拟的输入、改窗口尺寸都不算，Electron 41 实测）。
  // 另加一条不靠输入的心跳：页面每秒报一次，窗口在屏幕上、页面可见时超过 6 秒没报就算卡住。
  win.on('unresponsive', () => onHang('unresponsive'));
  win.on('responsive', () => { hung = false; });
  let lastBeat = 0;
  let lastBeatVisible = false;
  const onBeat = (event, state) => {
    if (event.sender !== contents) return;
    if (hung && lastBeat && now() - lastBeat > STALL_MS) log('renderer-stall-end', { ms: now() - lastBeat });
    lastBeat = now();
    lastBeatVisible = state === 'visible';
    if (hung) hung = false;
  };
  ipcMain?.on?.(HEARTBEAT_CHANNEL, onBeat);
  let lastTick = 0;
  const stallTimer = setIntervalFn(() => {
    const t = now();
    const gap = lastTick ? t - lastTick : 0;
    lastTick = t;
    // 主进程这边的计时停过（电脑睡眠、主进程自己卡住）：心跳可能还排在队里没处理，那段时间不算界面没心跳。
    if (gap > STALL_TICK_MS * 3) {
      if (lastBeat) lastBeat = t;
      if (hung) hungAt = t;
      return;
    }
    if (hung) {
      // 已经判定卡住后，窗口被最小化也照样计时：界面线程还卡着，最小化不会让它缓过来。
      const silent = t - (lastBeat || hungAt);
      if (rescueStallMs > 0 && silent >= rescueStallMs) rescueStall(silent);
      return;
    }
    if (!lastBeat || !lastBeatVisible) return;
    try { if (win.isDestroyed() || !win.isVisible() || win.isMinimized() || contents.isCrashed()) return; } catch { return; }
    const ms = t - lastBeat;
    if (ms > STALL_MS) onHang('heartbeat', { silentMs: ms });
  }, STALL_TICK_MS);
  try { stallTimer?.unref?.(); } catch {}

  contents.on('render-process-gone', (_event, details = {}) => {
    const rescued = rescuing;
    rescuing = false;
    // 卡死自救结束的进程按「卡死」恢复，界面据此提示「卡住太久」而不是「崩溃」。
    const reason = rescued ? 'stall' : String(details.reason || '');
    const exitCode = details.exitCode;
    hung = false;
    lastBeat = 0;
    log('renderer-memory-at-gone', { reason, exitCode, ...(rescued ? { gone: details.reason } : {}), recent: samples.slice() });
    if (!enabled || !(rescued || RECOVERABLE.has(reason)) || pendingRecovery) return;
    const t = now();
    while (recoveries.length && t - recoveries[0] > RECOVER_WINDOW_MS) recoveries.shift();
    const giveUp = recoveries.length >= RECOVER_MAX;
    if (!giveUp) recoveries.push(t);
    const failed = error => log('renderer-recover-failed', { message: String(error && error.message || error) });
    pendingRecovery = setTimeoutFn(() => {
      pendingRecovery = null;
      if (win.isDestroyed?.()) return;
      try {
        if (giveUp) {
          log('renderer-recover-gave-up', { reason, exitCode, recoveries: recoveries.length });
          Promise.resolve(contents.loadURL(gaveUpPage(reason, exitCode))).catch(failed);
          return;
        }
        log('renderer-recover', { reason, exitCode, attempt: recoveries.length });
        Promise.resolve(reload({ reason, exitCode, attempt: recoveries.length })).catch(failed);
      } catch (error) { failed(error); }
    }, RECOVER_DELAY_MS);
  });

  win.once('closed', () => {
    try { clearIntervalFn(timer); clearIntervalFn(stallTimer); } catch {}
    ipcMain?.removeListener?.(HEARTBEAT_CHANNEL, onBeat);
  });
  return { sampleMemory, samples, recoveries };
}

module.exports = { installRendererCrashRecovery, installHangStackOptIn, shortenStack, RECOVER_MAX, RECOVER_WINDOW_MS, SAMPLE_MS, STALL_MS, RESCUE_STALL_MS, HEARTBEAT_CHANNEL, HANG_STACK_POLICY };
