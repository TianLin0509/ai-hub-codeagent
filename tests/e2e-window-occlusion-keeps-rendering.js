'use strict';
// 「点『后台』后画面冻住、半分钟后黑屏，CPU 却几乎空闲」的机制复现与修复验证（2026-10-10）。
//
// 公司真机取证（3 个 CodeAgent 会话同时输出，兼容渲染）：点后台后帧数 173→31，切会话时 0 帧/秒持续 22 秒，
// 主线程最大延迟 943 ms 却没有长任务，界面进程 92–99% 空闲、GPU 进程 0%。这正是 Chromium 判定窗口
// 「被挡住」后的节能状态：不再出帧、requestAnimationFrame 停、计时器压到每秒一次；时间一长，
// 旧画面被回收，窗口只剩背景色 #0d1117（看上去就是黑屏）。
//
// 本测试把真实 Hub 窗口挪出屏幕（Chromium 用同一套遮挡计算判定它不可见），再用一个不抢焦点的
// 置顶小窗盖住它，两种情形都量帧数、计时器延迟和 document.visibilityState：
//   - 修复前（AI_HUB_KEEP_RENDERING=0）：应复现「0 帧 + 约 1 秒计时器延迟 + hidden」；
//   - 修复后（社区版默认 / AI_HUB_KEEP_RENDERING=1）：窗口没最小化就一直出帧。
// 修复后最小化时也照常绘制（代价见 core/window-keep-rendering.js）。
//
//   node tests/e2e-window-occlusion-keeps-rendering.js [--exe <打包后的 exe>]
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');

process.env.HUB_E2E_SHOW_WINDOWS = '1';
const argv = process.argv.slice(2);
const exeIdx = argv.indexOf('--exe');
const exe = exeIdx >= 0 ? argv[exeIdx + 1] : null;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const freePort = () => new Promise((res, rej) => { const s = net.createServer(); s.on('error', rej); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });

const WIN32 = `Add-Type -Namespace W -Name U -MemberDefinition '
[DllImport("user32.dll")] public static extern bool SetWindowPos(System.IntPtr h, System.IntPtr a, int x, int y, int cx, int cy, uint f);
[DllImport("user32.dll")] public static extern bool ShowWindow(System.IntPtr h, int c);
[DllImport("user32.dll")] public static extern bool IsIconic(System.IntPtr h);'`;
function ps(script, timeout = 30000) {
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true, timeout });
  return String(r.stdout || '').trim();
}
const hwndOf = pid => ps(`(Get-Process -Id ${pid}).MainWindowHandle.ToInt64()`);
// SWP_NOACTIVATE|SWP_NOZORDER = 0x14
const place = (hwnd, x, y, w, h) => ps(`${WIN32}; [W.U]::SetWindowPos([IntPtr]${hwnd}, [IntPtr]::Zero, ${x}, ${y}, ${w}, ${h}, 0x14) | Out-Null; 'ok'`);
const showCmd = (hwnd, cmd) => ps(`${WIN32}; [W.U]::ShowWindow([IntPtr]${hwnd}, ${cmd}) | Out-Null; 'ok'`);

// 一个不抢焦点的置顶窗口，盖住 (x,y,w,h)，持续 secs 秒后自行关闭。
function coverWindow(x, y, w, h, secs) {
  const script = `Add-Type -AssemblyName System.Windows.Forms; Add-Type -AssemblyName System.Drawing;
Add-Type -ReferencedAssemblies System.Windows.Forms,System.Drawing -TypeDefinition '
public class Cover : System.Windows.Forms.Form {
  protected override bool ShowWithoutActivation { get { return true; } }
  protected override System.Windows.Forms.CreateParams CreateParams { get { var p = base.CreateParams; p.ExStyle |= 0x08000000 | 0x8; return p; } }
}';
$f = New-Object Cover; $f.FormBorderStyle = 'None'; $f.StartPosition = 'Manual'; $f.ShowInTaskbar = $false;
$f.BackColor = [System.Drawing.Color]::FromArgb(240,240,240); $f.Bounds = New-Object System.Drawing.Rectangle(${x}, ${y}, ${w}, ${h});
$t = New-Object System.Windows.Forms.Timer; $t.Interval = ${secs * 1000}; $t.add_Tick({ $f.Close() }); $t.Start();
[System.Windows.Forms.Application]::Run($f)`;
  return spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, stdio: 'ignore' });
}

const MON = `(() => { if (window.__occ) return 1; const m = window.__occ = { frames: 0, lagMax: 0, changes: [] };
  const f = () => { m.frames++; requestAnimationFrame(f); }; requestAnimationFrame(f);
  let last = performance.now(); setInterval(() => { const n = performance.now(); m.lagMax = Math.max(m.lagMax, n - last - 100); last = n; }, 100);
  document.addEventListener('visibilitychange', () => m.changes.push(document.visibilityState));
  return 1; })()`;
const TAKE = `(() => { const m = window.__occ; const r = { frames: m.frames, lagMax: Math.round(m.lagMax), vis: document.visibilityState, changes: m.changes.slice() };
  m.frames = 0; m.lagMax = 0; m.changes = []; return r; })()`;

async function measure(c, secs) {
  await c.eval(TAKE); const t0 = Date.now(); await sleep(secs * 1000);
  const r = await c.eval(TAKE); r.fps = Math.round(r.frames / ((Date.now() - t0) / 1000)); return r;
}

async function runCase(label, keepRendering) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-occl-'));
  const hub = await launchIsolatedHub({ dataDir: path.join(root, 'data'), port: await freePort(), windowMode: 'visible', label: 'occl', ...(exe ? { executablePath: exe } : {}),
    extraEnv: { AI_HUB_DISABLE_GPU: '1', CLAUDE_HUB_HOME_DIR: path.join(root, 'home'), ...(keepRendering === null ? {} : { AI_HUB_KEEP_RENDERING: keepRendering ? '1' : '0' }) } });
  const res = { label };
  let c;
  try {
    c = await connectFirstPage(hub);
    for (let i = 0; i < 100 && !(await c.eval('typeof sessions !== "undefined"').catch(() => false)); i++) await sleep(300);
    await c.eval(MON);
    let hwnd = '0';
    for (let i = 0; i < 30 && (!hwnd || hwnd === '0'); i++) { hwnd = hwndOf(hub.pid); if (hwnd === '0') await sleep(500); }
    if (!hwnd || hwnd === '0') throw new Error('找不到 Hub 主窗口句柄');
    place(hwnd, 40, 40, 900, 640); await sleep(1500);
    res.onScreen = await measure(c, 3);
    place(hwnd, -24000, -24000, 900, 640); await sleep(1500);
    res.offScreen = await measure(c, 4);
    place(hwnd, 40, 40, 900, 640); await sleep(1500);
    const cover = coverWindow(20, 20, 960, 700, 9); await sleep(3500);
    res.covered = await measure(c, 4);
    await new Promise(r => cover.once('exit', r)); await sleep(1500);
    res.uncovered = await measure(c, 2);
    showCmd(hwnd, 6); await sleep(1500); // SW_MINIMIZE
    res.minimized = await measure(c, 3);
    showCmd(hwnd, 9); await sleep(1500); // SW_RESTORE：正常还原
    res.restored = await measure(c, 2);
    // 别的程序不激活地把最小化窗口显示回来（SW_SHOWNOACTIVATE）：窗口回到屏幕上，
    // 但 Chromium 没收到还原，页面一直停在不可见 —— 这就是「窗口看得见、画面却冻住」。
    showCmd(hwnd, 6); await sleep(1500);
    showCmd(hwnd, 4); await sleep(3500);
    res.shownNoActivate = await measure(c, 3);
    res.iconicAfterShow = ps(`${WIN32}; [W.U]::IsIconic([IntPtr]${hwnd})`);
    showCmd(hwnd, 9); await sleep(1000);
    res.log = (() => { try { return fs.readFileSync(path.join(root, 'data', 'logs', 'window-events.log'), 'utf8').trim().split(/\r?\n/); } catch { return []; } })();
    res.hubLog = hub.log().filter(l => /\[window\]/.test(l)).slice(-6);
  } finally {
    try { c && c.close(); } catch {}
    await gracefulQuit(hub).catch(() => {});
  }
  return res;
}

(async () => {
  const fmt = r => r ? `${r.fps} 帧/秒，计时器最大延迟 ${r.lagMax} ms，${r.vis}${r.changes.length ? `（变化：${r.changes.join('→')}）` : ''}` : '-';
  const results = [];
  for (const [label, keep] of [['修复前（AI_HUB_KEEP_RENDERING=0）', false], exe ? ['修复后（社区版默认，不设环境变量）', null] : ['修复后（AI_HUB_KEEP_RENDERING=1）', true]]) {
    const r = await runCase(label, keep); results.push(r);
    console.log(`\n== ${label}`);
    for (const k of ['onScreen', 'offScreen', 'covered', 'uncovered', 'minimized', 'restored', 'shownNoActivate']) console.log(`  ${k.padEnd(10)} ${fmt(r[k])}`);
    if (r.log.length) console.log('  window-events.log:\n    ' + r.log.slice(-8).join('\n    '));
  }
  const [before, after] = results;
  const frozen = r => r.fps < 5 && r.vis === 'hidden';
  const live = r => r.fps >= 20 && r.vis === 'visible' && r.lagMax < 500;
  const checks = [
    ['修复前：窗口回到屏幕后仍冻住（0 帧 + hidden，与公司取证同一特征）', frozen(before.shownNoActivate) && before.iconicAfterShow === 'False'],
    ['修复后：同样操作，画面继续刷新', live(after.shownNoActivate)],
    ['修复后：挪出屏幕仍在出帧', live(after.offScreen)],
    ['修复后：被置顶窗口盖住仍在出帧', live(after.covered)],
    ['修复前：日志抓到误判（窗口没最小化、可见，页面却被判 hidden）', before.log.some(l => /page-visibility .*"state":"hidden".*"minimized":false,"visible":true/.test(l))],
    ['修复后：还原后正常出帧', live(after.restored)],
    ['修复后：window-events.log 记下开关与最小化/还原', after.log.some(l => /start .*"keepRendering":true/.test(l)) && after.log.some(l => / minimize /.test(l)) && after.log.some(l => / restore /.test(l))],
  ];
  console.log('\n' + checks.map(([n, ok]) => `${ok ? 'PASS' : 'FAIL'} ${n}`).join('\n'));
  console.log(`  （参考）修复前被盖住：${fmt(before.covered)}`);
  process.exit(checks.every(([, ok]) => ok) ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
