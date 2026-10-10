'use strict';
// 本机复现「点后台后 CLI 画面变卡、随后卡死」（2026-10-11）。
// 关闭显卡加速 + DOM 终端（与公司电脑一致），3 个 CodeAgent 会话用全屏界面替身（tests/fixtures/codeagent-tui-standin）
// 按公司取证的流量持续输出；窗口最大化可见。逐秒记录：帧数、主线程延迟、页面可见性、界面/GPU 进程 CPU。
//   node tests/repro-backstage-render.js [--sessions 3] [--keep-rendering 0|1] [--phase-secs 20] [--gpu off|on] [--css "<extra css>"]
const fs = require('fs'), os = require('os'), net = require('net'), path = require('path');
const { spawnSync } = require('child_process');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const argv = process.argv.slice(2);
const arg = (n, d = null) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const N = Number(arg('--sessions', 3)), SECS = Number(arg('--phase-secs', 20));
const keep = arg('--keep-rendering', '0'), extraCss = arg('--css', ''), gpuOff = arg('--gpu', 'off') === 'off';
const outDir = path.resolve(arg('--out', 'artifacts/20261011-backstage-render-claude1')); fs.mkdirSync(outDir, { recursive: true });
process.env.HUB_E2E_SHOW_WINDOWS = '1'; process.env.HUB_TEST_PRIORITY = 'normal';
const j = JSON.stringify, sleep = ms => new Promise(r => setTimeout(r, ms));
const freePort = () => new Promise((res, rej) => { const s = net.createServer(); s.on('error', rej); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
const STANDIN = path.join(__dirname, 'fixtures', 'codeagent-tui-standin', 'codeagent.cmd');
let hub, c;
const WIN32 = `Add-Type -Namespace W -Name U -MemberDefinition '[DllImport("user32.dll")] public static extern bool SetWindowPos(System.IntPtr h, System.IntPtr a, int x, int y, int cx, int cy, uint f);'`;
const ps = (script) => String(spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true, timeout: 30000 }).stdout || '').trim();
function cpuSample() {
  const ps = "Get-CimInstance Win32_Process | ForEach-Object { '{0}|{1}|{2}|{3}' -f $_.ProcessId,$_.ParentProcessId,($_.KernelModeTime+$_.UserModeTime),($_.CommandLine -replace '\\|',' ') }";
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8', windowsHide: true, timeout: 20000 });
  const rows = String(r.stdout || '').split(/\r?\n/).map(l => { const [pid, ppid, cpu, ...rest] = l.split('|'); return { pid: +pid, ppid: +ppid, cpu: +cpu / 1e7, cmd: rest.join('|') }; }).filter(x => x.pid);
  const ids = new Set([hub.pid]); let grew = true;
  while (grew) { grew = false; for (const x of rows) if (!ids.has(x.pid) && ids.has(x.ppid)) { ids.add(x.pid); grew = true; } }
  const g = {};
  for (const x of rows) if (ids.has(x.pid)) {
    const type = (x.cmd.match(/--type=([a-z-]+)/) || [])[1];
    const k = x.pid === hub.pid ? 'main' : type === 'renderer' ? 'renderer' : type === 'gpu-process' ? 'gpu' : /fake-opentui/.test(x.cmd) ? 'cli' : type ? type : 'other';
    g[k] = (g[k] || 0) + x.cpu;
  }
  return { at: Date.now(), g };
}
const MON = `(() => { const m = window.__r = { frames: 0, lag: 0, vis: [] };
  document.addEventListener('visibilitychange', () => m.vis.push(document.visibilityState));
  const f = () => { m.frames++; requestAnimationFrame(f); }; requestAnimationFrame(f);
  let last = performance.now(); setInterval(() => { const n = performance.now(); m.lag = Math.max(m.lag, n - last - 100); last = n; }, 100); return 1; })()`;
const TAKE = `(() => { const m = window.__r; const r = { frames: m.frames, lag: Math.round(m.lag), vis: document.visibilityState, ch: m.vis.join('>') }; m.frames = 0; m.lag = 0; m.vis = []; return r; })()`;
const timeline = [];
const TERMS = `[...terminalCache.values()].map(v => ({ mode: v._rendererMode, cols: v.terminal.cols, rows: v.terminal.rows, display: v.container && v.container.style.display }))`;
async function phase(label, secs) {
  let prev = cpuSample(); await c.eval(TAKE);
  const rows = [];
  for (let i = 0; i < secs; i++) {
    await sleep(1000);
    const t0 = Date.now(); const v = await Promise.race([c.eval(TAKE), sleep(5000).then(() => null)]); const rtt = Date.now() - t0;
    const now = cpuSample(); const dt = (now.at - prev.at) / 1000;
    const pct = k => Math.round(((now.g[k] || 0) - (prev.g[k] || 0)) / dt * 100);
    const row = { label, t: i + 1, fps: v ? v.frames : null, lag: v ? v.lag : null, vis: v ? v.vis + (v.ch ? `(${v.ch})` : '') : 'NO-REPLY', rtt, renderer: pct('renderer'), gpu: pct('gpu'), main: pct('main'), cli: pct('cli') };
    rows.push(row); timeline.push(row); prev = now;
    if (i === 3) { const shot = await c.send('Page.captureScreenshot', { format: 'png' }).catch(() => null); if (shot) fs.writeFileSync(path.join(outDir, `shot-${label}.png`), Buffer.from(shot.data, 'base64')); }
    console.log(`${label} +${row.t}s fps=${row.fps} lag=${row.lag} vis=${row.vis} rtt=${rtt} renderer=${row.renderer}% gpu=${row.gpu}% main=${row.main}% cli=${row.cli}%`);
  }
  const avg = k => Math.round(rows.reduce((a, r) => a + (r[k] || 0), 0) / rows.length);
  return { label, fps: avg('fps'), renderer: avg('renderer'), gpu: avg('gpu'), main: avg('main'), maxLag: Math.max(...rows.map(r => r.lag || 0)), hidden: rows.filter(r => /hidden/.test(r.vis)).length };
}
async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-render-'));
  const cac = path.join(root, '.cac'), work = path.join(root, 'work'); for (const d of [cac, work]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(cac, '.cac.json'), j({ hasCompletedOnboarding: true, projects: {} }));
  fs.writeFileSync(path.join(cac, 'settings.json'), j({ permissions: { defaultMode: 'bypassPermissions' } }));
  hub = await launchIsolatedHub({ dataDir: path.join(root, 'data'), port: await freePort(), windowMode: 'visible', label: 'render repro', extraEnv: {
    AI_HUB_CODEAGENT_COMMAND: STANDIN, AI_HUB_CODEAGENT_CONFIG_DIR: cac, CLAUDE_HUB_HOME_DIR: path.join(root, 'home'), DEEPSEEK_API_KEY: '',
    AI_HUB_KEEP_RENDERING: keep, AI_HUB_BACKSTAGE_PATH: arg('--backstage', 'october'), ...(gpuOff ? { AI_HUB_DISABLE_GPU: '1' } : {}), HUB_SESSION_SEARCH_CLAUDE_ROOTS: path.join(root, 'none') } });
  c = await connectFirstPage(hub);
  for (let i = 0; i < 150 && !(await c.eval('typeof sessions !== "undefined" && typeof selectSession === "function"').catch(() => false)); i++) await sleep(400);
  // 不抢焦点地把窗口铺满主屏（SWP_NOACTIVATE|SWP_NOZORDER），与公司「最大化使用」一致。
  let hwnd = '0';
  for (let i = 0; i < 30 && hwnd === '0'; i++) { hwnd = ps(`(Get-Process -Id ${hub.pid}).MainWindowHandle.ToInt64()`) || '0'; if (hwnd === '0') await sleep(500); }
  const [sw, sh] = ps("Add-Type -AssemblyName System.Windows.Forms; $b=[System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea; \"$($b.Width) $($b.Height)\"").split(' ').map(Number);
  ps(`${WIN32}; [W.U]::SetWindowPos([IntPtr]${hwnd}, [IntPtr]::Zero, 0, 0, ${sw}, ${sh}, 0x14) | Out-Null`);
  await sleep(1500);
  if (extraCss) await c.eval(`(() => { const s = document.createElement('style'); s.textContent = ${j(extraCss)}; document.head.appendChild(s); return 1; })()`);
  const env = await c.eval(`({ title: document.title, gpuFlag: process.argv.includes('--ai-hub-gpu-disabled'), size: innerWidth + 'x' + innerHeight + '@' + devicePixelRatio })`);
  console.log('env', j(env));
  const ids = [];
  for (let i = 0; i < N; i++) { const s = await c.eval(`ipcRenderer.invoke('create-session', ${j({ kind: 'codeagent', opts: { cwd: work, effort: 'low' } })})`); ids.push(s.id); await sleep(1500); }
  await sleep(6000);
  const thr = Number(arg('--cpu-throttle', 1)); if (thr > 1) await c.send('Emulation.setCPUThrottlingRate', { rate: thr });
  await c.eval(MON);
  await c.eval(`selectSession(${j(ids[0])})`); await sleep(500); await c.eval(`applyViewMode('card')`); await sleep(2000);
  const res = [];
  res.push(await phase('A-card', Math.min(SECS, 10)));
  const termsCard = await c.eval(TERMS);
  console.log('terms in card view', j(termsCard));
  await c.eval(`applyViewMode('pty')`);
  res.push(await phase('B-pty', SECS));
  await c.eval(`selectSession(${j(ids[1 % ids.length])})`).catch(() => {}); await c.eval(`applyViewMode('pty')`).catch(() => {});
  res.push(await phase('C-pty-switch', Math.min(SECS, 15)));
  await c.eval(`applyViewMode('card')`).catch(() => {});
  res.push(await phase('D-card', 8));
  const terms = await c.eval(TERMS).catch(() => null);
  const summary = { env, backstage: arg('--backstage', 'october'), keep, gpuOff, extraCss, terms, phases: res };
  console.log('SUMMARY', j(summary));
  try { console.log(fs.readFileSync(path.join(root, 'data', 'logs', 'window-events.log'), 'utf8').trim().split('\n').slice(-30).join('\n')); } catch (e) { console.log('no window log', e.message); }
  fs.writeFileSync(path.join(outDir, `repro-${Date.now()}.json`), j({ summary, timeline }, null, 1));
}
main().catch(e => { console.error(e); process.exitCode = 1; }).finally(async () => { try { c && c.close(); } catch {} if (hub) await gracefulQuit(hub).catch(() => {}); setTimeout(() => process.exit(), 500); });
