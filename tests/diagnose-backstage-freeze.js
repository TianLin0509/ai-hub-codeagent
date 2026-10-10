'use strict';
// 「开 2-3 个 CodeAgent 会话后点『后台』就卡死、约半分钟后黑屏」的真机取证（2026-10-10）。
// 启动已安装的 Hub（独立数据目录、窗口可见、正常优先级），让几个 CodeAgent 会话同时干活，
// 然后点「后台」。在这个过程中记录：界面进程的 CPU 剖析（哪段代码在烧 CPU）、各进程 CPU 与内存、
// 界面响应往返、每秒画面帧数、终端数据量、进程崩溃或无响应事件。输出 freeze-report.md（可直接回传）。
//
//   node tests/diagnose-backstage-freeze.js --exe "<AI Hub Community.exe>" [--sessions 3] [--renderer auto|dom|canvas] [--copy-real-data]
//
// --copy-real-data：把 %USERPROFILE%\.ai-hub-community 复制一份来用（先关掉正在用的 Hub），
//   在你真实的长会话上点「后台」，复现「历史越长越卡」类问题；不改原数据。
// 发送的真实模型消息：每个会话 1 条（默认 3 条）。
//
// 对照开关（v0.5.7 起，同一安装包上切换新旧行为）：
//   --backstage september|october  「后台」走 9 月还是 10 月的路径（core/backstage-path.js；默认跟安装包）
//   --keep-rendering 1|0           窗口始终出帧（core/window-keep-rendering.js；默认跟安装包）
//   --gpu auto|on|off               显卡加速（auto = 有 gpu-disabled.json 就关）
//   --report <file>                 报告另存一份到这里
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const { spawnSync } = require('child_process');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');

const argv = process.argv.slice(2);
const arg = (n, d = null) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const exe = arg('--exe') || '';
const N = Math.max(1, Math.min(6, Number(arg('--sessions', 3))));
const rendererPref = arg('--renderer', 'auto');
const copyReal = argv.includes('--copy-real-data');
const home = process.env.USERPROFILE || os.homedir();
for (const key of Object.keys(process.env)) {
  if (/^CODEAGENT_HUB_/.test(key) || ['CODEAGENT3_LAUNCHER_PID', 'CODEAGENT3_X_AUTH_TOKEN'].includes(key)) delete process.env[key];
}
process.env.HUB_E2E_SHOW_WINDOWS = '1';
process.env.HUB_TEST_PRIORITY = 'normal';
const configDir = path.resolve(process.env.AI_HUB_CODEAGENT_CONFIG_DIR || process.env.CODEAGENT3_CONFIG_DIR || path.join(home, '.cac'));
const gpuArg = arg('--gpu', 'auto');
const gpuDisabled = gpuArg === 'off' || (gpuArg === 'auto' && fs.existsSync(path.join(home, '.ai-hub-community', 'gpu-disabled.json')));
const backstageArg = arg('--backstage', '');
const keepArg = arg('--keep-rendering', '');
const reportCopy = arg('--report', '');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-freeze-'));
const out = path.join(root, 'report');
fs.mkdirSync(out, { recursive: true });
const j = JSON.stringify;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const freePort = () => new Promise((res, rej) => { const s = net.createServer(); s.on('error', rej); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
const user = path.basename(home);
const redact = t => String(t || '').split(home).join('%USERPROFILE%').split(user).join('<USER>').replace(/https?:\/\/[^\s'"]+/g, '<URL>');
const md = [];
const events = [];
let hub = null, c = null, crashed = false;

async function timed(expr, ms = 8000) {
  const t0 = Date.now(); let timer;
  try { const v = await Promise.race([c.eval(expr), new Promise((_, r) => { timer = setTimeout(() => r(new Error('timeout')), ms); })]); return { ok: true, ms: Date.now() - t0, v }; }
  catch (e) { return { ok: false, ms: Date.now() - t0, err: e.message }; } finally { clearTimeout(timer); }
}
function processSample() {
  const script = "$ErrorActionPreference='SilentlyContinue';Get-CimInstance Win32_Process | Where-Object { $_.Name -match '^(AI Hub Community|codeagentcli|OpenConsole|conhost)\\.exe$' } | ForEach-Object { '{0}|{1}|{2}|{3}|{4}|{5}' -f $_.ProcessId,$_.ParentProcessId,$_.Name,($_.KernelModeTime+$_.UserModeTime),$_.WorkingSetSize,($_.CommandLine -replace '\\|',' ') }";
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true, timeout: 20000 });
  const rows = [];
  for (const line of String(r.stdout || '').split(/\r?\n/)) {
    const [pid, ppid, name, cpu, ws, ...rest] = line.split('|'); if (!pid) continue;
    const cmd = rest.join('|'); const type = (cmd.match(/--type=([a-z-]+)/) || [])[1] || '';
    const script = (cmd.match(/[\\/]([\w.-]+\.(?:js|cjs|mjs))\b/i) || [])[1] || (cmd.includes('ELECTRON_RUN_AS_NODE') ? 'node' : cmd.replace(/^"[^"]*"\s*/, '').slice(0, 60));
    rows.push({ pid: +pid, ppid: +ppid, name, cpu: +cpu / 1e7, ws: +ws, type, script });
  }
  return { at: Date.now(), rows };
}
function tree(sample) {
  const ids = new Set([hub && hub.pid]); let grew = true;
  while (grew) { grew = false; for (const r of sample.rows) if (!ids.has(r.pid) && ids.has(r.ppid)) { ids.add(r.pid); grew = true; } }
  return sample.rows.filter(r => ids.has(r.pid));
}
function group(r) {
  if (r.pid === (hub && hub.pid)) return '主进程';
  if (/AI Hub Community/i.test(r.name)) return { renderer: '界面进程', 'gpu-process': 'GPU 进程', utility: '辅助进程' }[r.type] || ('Hub 子进程 ' + (r.script || '（无脚本名）'));
  if (/codeagentcli/i.test(r.name)) return 'CodeAgent CLI';
  return '控制台宿主';
}
function cpuLine(a, b) {
  const secs = (b.at - a.at) / 1000; const prev = new Map(tree(a).map(r => [r.pid, r])); const g = new Map();
  for (const r of tree(b)) { const p = prev.get(r.pid); const k = group(r); const cur = g.get(k) || { cpu: 0, ws: 0, n: 0 }; cur.cpu += p ? Math.max(0, r.cpu - p.cpu) : 0; cur.ws += r.ws; cur.n++; g.set(k, cur); }
  return [...g.entries()].map(([k, v]) => `${k}×${v.n} ${Math.round(v.cpu / secs * 100)}% ${Math.round(v.ws / 2 ** 20)}MB`).join(' · ');
}
const MON = `(() => { if (window.__f) return 1; const m = window.__f = { bytes: {}, chunks: {}, frames: 0, lagMax: 0, long: 0, longMs: 0, vis: [] };
  document.addEventListener('visibilitychange', () => m.vis.push(document.visibilityState));
  ipcRenderer.on('terminal-data', (_e, p) => { if (!p) return; m.bytes[p.sessionId] = (m.bytes[p.sessionId] || 0) + String(p.data || '').length; m.chunks[p.sessionId] = (m.chunks[p.sessionId] || 0) + 1; });
  const f = () => { m.frames++; requestAnimationFrame(f); }; requestAnimationFrame(f);
  let last = performance.now(); setInterval(() => { const n = performance.now(); m.lagMax = Math.max(m.lagMax, n - last - 100); last = n; }, 100);
  try { new PerformanceObserver(l => { for (const e of l.getEntries()) { m.long++; m.longMs += e.duration; } }).observe({ entryTypes: ['longtask'] }); } catch {}
  return 1; })()`;
const TAKE = `(() => { const m = window.__f; const r = { bytes: m.bytes, chunks: m.chunks, frames: m.frames, lagMax: Math.round(m.lagMax), long: m.long, longMs: Math.round(m.longMs), visNow: document.visibilityState, vis: m.vis.slice(),
  heapMB: Math.round(((performance.memory || {}).usedJSHeapSize || 0) / 1048576), dom: document.getElementsByTagName('*').length,
  terms: [...terminalCache.entries()].map(([k, v]) => ({ id: k.slice(0, 6), mode: v._rendererMode || '-', visible: !!(v.container && v.container.style.display !== 'none'), rows: v.terminal && v.terminal.buffer.active.length, alt: v.terminal && v.terminal.buffer.active.type })) };
  Object.assign(m, { bytes: {}, chunks: {}, frames: 0, lagMax: 0, long: 0, longMs: 0, vis: [] }); return r; })()`;

async function phase(label, secs, ids, { profile = false } = {}) {
  await timed(TAKE, 10000);
  if (profile) { await c.send('Profiler.enable').catch(() => {}); await c.send('Profiler.setSamplingInterval', { interval: 500 }).catch(() => {}); await c.send('Profiler.start').catch(() => {}); }
  const s0 = processSample(); const t0 = Date.now(); const rtt = []; let fails = 0, worst = 0; const cpuTimeline = [];
  let last = s0;
  while (Date.now() - t0 < secs * 1000 && !crashed) {
    const r = await timed('1', 10000); if (r.ok) rtt.push(r.ms); else { fails++; worst = Math.max(worst, r.ms); }
    const now = processSample(); cpuTimeline.push(`+${Math.round((now.at - t0) / 1000)}s ${cpuLine(last, now)}`); last = now;
    await sleep(800);
  }
  let profileTop = null;
  if (profile && !crashed) {
    const res = await Promise.race([c.send('Profiler.stop'), sleep(30000).then(() => null)]).catch(() => null);
    if (res && res.profile) { fs.writeFileSync(path.join(out, `${label.replace(/\W+/g, '_')}.cpuprofile`), JSON.stringify(res.profile)); profileTop = summarizeProfile(res.profile); }
  }
  const s1 = processSample();
  const t = await timed(TAKE, 15000); const v = t.v || {};
  const el = (Date.now() - t0) / 1000;
  const sorted = rtt.slice().sort((a, b) => a - b);
  const lines = [`### ${label}（${Math.round(el)} 秒）`, '',
    `- 界面响应往返 ms：p50 ${sorted[Math.floor(sorted.length / 2)] ?? '-'} / 最大 ${sorted.at(-1) ?? '-'}；超过 10 秒无响应 ${fails} 次${fails ? `（最长 ${Math.round(worst / 1000)} 秒）` : ''}`,
    `- 画面帧数 ${t.ok ? Math.round(v.frames / el) : '?'} 帧/秒；主线程最大延迟 ${v.lagMax ?? '?'} ms；长任务 ${v.long ?? '?'} 次 共 ${v.longMs ?? '?'} ms；JS 堆 ${v.heapMB ?? '?'} MB；页面元素 ${v.dom ?? '?'} 个；页面可见性 ${v.visNow ?? '?'}${(v.vis || []).length ? `（期间变化：${v.vis.join('→')}）` : ''}`,
    `- 终端数据：${ids.map((id, i) => `s${i + 1} ${(((v.bytes || {})[id] || 0) / el / 1024).toFixed(1)}KB/s ${Math.round(((v.chunks || {})[id] || 0) / el)}块/s`).join('；')}`,
    `- 终端：${(v.terms || []).map(x => `${x.id} ${x.mode}${x.visible ? ' 可见' : ''} ${x.alt === 'alternate' ? '全屏界面' : '普通'} ${x.rows}行`).join('；') || '无'}`,
    `- 全程各进程 CPU（单核=100%）：${cpuLine(s0, s1)}`, '', '每秒采样：', '```text', ...cpuTimeline.slice(0, 40), '```'];
  if (profileTop) lines.push('', '界面进程 CPU 剖析（自身耗时最多的 25 个函数）：', '```text', ...profileTop, '```');
  if (!t.ok) lines.push('', `- 结束时界面仍无响应（${t.err}）`);
  md.push(...lines, '');
  console.log(lines.slice(0, 6).join('\n'));
}
function summarizeProfile(p) {
  const self = new Map(); const byId = new Map(p.nodes.map(n => [n.id, n]));
  const dt = p.timeDeltas || []; const counts = new Map();
  (p.samples || []).forEach((id, i) => counts.set(id, (counts.get(id) || 0) + (dt[i] || 0)));
  for (const [id, us] of counts) {
    const n = byId.get(id); if (!n) continue; const f = n.callFrame;
    const key = `${f.functionName || '(anonymous)'}  ${redact(String(f.url || '').replace(/^.*?(app\.asar|resources)[\\/]/, ''))}:${f.lineNumber + 1}`;
    self.set(key, (self.get(key) || 0) + us);
  }
  const total = [...self.values()].reduce((a, b) => a + b, 0) || 1;
  return [...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25).map(([k, us]) => `${(us / 1000).toFixed(0).padStart(7)} ms ${(us / total * 100).toFixed(1).padStart(5)}%  ${k}`);
}
function copyRealData(dest) {
  const src = path.join(home, '.ai-hub-community');
  if (!fs.existsSync(src)) throw new Error('没有找到 %USERPROFILE%\\.ai-hub-community');
  fs.cpSync(src, dest, { recursive: true, filter: s => !/[\\/](electron-userdata|cache|Cache|GPUCache|Code Cache|logs)([\\/]|$)/.test(s) });
}

async function main() {
  if (!exe || !fs.existsSync(exe)) throw new Error('请用 --exe 指定已安装的「AI Hub Community.exe」完整路径');
  const dataDir = path.join(root, 'data');
  if (copyReal) { copyRealData(dataDir); md.push('（使用真实数据的副本）', ''); }
  hub = await launchIsolatedHub({ dataDir, port: await freePort(), executablePath: exe, windowMode: 'visible', label: 'freeze', allowExternalState: copyReal,
    extraEnv: { AI_HUB_CODEAGENT_CONFIG_DIR: configDir, CLAUDE_HUB_HOME_DIR: path.join(root, 'home'), DEEPSEEK_API_KEY: '', ...(gpuDisabled ? { AI_HUB_DISABLE_GPU: '1' } : {}),
      ...(backstageArg ? { AI_HUB_BACKSTAGE_PATH: backstageArg } : {}), ...(keepArg ? { AI_HUB_KEEP_RENDERING: keepArg } : {}) } });
  c = await connectFirstPage(hub);
  // 界面进程崩溃（黑屏的一种来源）：CDP 发 Inspector.targetCrashed；连接断开也记下来。
  c.ws.on('message', data => {
    try { const msg = JSON.parse(String(data)); if (msg.method === 'Inspector.targetCrashed') { crashed = true; events.push(`${new Date().toISOString()} 界面进程崩溃（Inspector.targetCrashed）`); } } catch {}
  });
  c.ws.on('close', () => { if (!crashed) events.push(`${new Date().toISOString()} 与界面的调试连接断开`); crashed = true; });
  for (let i = 0; i < 150 && !(await c.eval('typeof sessions !== "undefined" && typeof selectSession === "function"').catch(() => false)); i++) await sleep(400);
  await c.send('Inspector.enable').catch(() => {});
  if (rendererPref !== 'auto') await c.eval(`localStorage.setItem('hub.renderer', ${j(rendererPref)}), true`);
  else await c.eval(`localStorage.removeItem('hub.renderer'), true`);
  const env = { hub: await c.eval('document.title'), gpu: gpuDisabled ? '关闭（兼容渲染）' : '开启', gpuFlag: await c.eval("process.argv.includes('--ai-hub-gpu-disabled')"),
    renderer: rendererPref, backstage: await c.eval("require('../core/backstage-path.js').backstagePath()").catch(() => '（旧版无此开关）'),
    keepRendering: keepArg || '默认', screen: await c.eval('`${screen.width}x${screen.height} 缩放 ${devicePixelRatio}`'), cpu: `${os.cpus().length} 核 ${os.cpus()[0] && os.cpus()[0].model}`, mem: `${Math.round(os.totalmem() / 2 ** 30)} GB` };
  md.unshift('# 「后台」卡死取证报告', '', '```json', j(env, null, 2), '```', '');
  await c.eval(MON);
  let ids = [];
  if (copyReal) {
    ids = await c.eval(`[...sessions.values()].filter(s => /^codeagent/.test(s.kind)).sort((a, b) => (b.lastActiveAt || 0) - (a.lastActiveAt || 0)).slice(0, ${N}).map(s => s.id)`);
    for (const id of ids) { await c.eval(`selectSession(${j(id)})`).catch(() => {}); await sleep(8000); }
  } else {
    const work = path.join(root, 'work'); fs.mkdirSync(work, { recursive: true });
    for (let i = 0; i < N; i++) { const s = await c.eval(`ipcRenderer.invoke('create-session', ${j({ kind: 'codeagent', opts: { cwd: work, effort: 'low' } })})`); ids.push(s.id); await sleep(2000); }
    await sleep(20000);
    for (const id of ids) await c.eval(`ipcRenderer.invoke('session:send-prompt', ${j({ sessionId: id, text: '请用中文逐段写一篇约 1500 字的文章，介绍 5G NR 的物理层基本流程，分 8 个小节，直接输出正文，不要使用任何工具。' })})`).catch(() => {});
    await sleep(8000);
  }
  if (!ids.length) throw new Error('没有可用的 CodeAgent 会话');
  await c.eval(`selectSession(${j(ids[0])})`); await c.eval(`applyViewMode('card')`); await sleep(2000);
  await phase('A 卡片视图（会话在干活）', 15, ids);
  await c.eval(`applyViewMode('pty')`);
  await phase('B 点「后台」后', 30, ids, { profile: true });
  if (!crashed) { await c.eval(`selectSession(${j(ids[Math.min(1, ids.length - 1)])})`).catch(() => {}); await c.eval(`applyViewMode('pty')`).catch(() => {}); await phase('C 后台里切到另一个会话', 20, ids, { profile: true }); }
  if (!crashed) { await c.eval(`applyViewMode('card')`).catch(() => {}); await phase('D 切回卡片', 15, ids); }
}

main().catch(e => { md.push('## 致命错误', '```text', redact(e && e.stack || String(e)).slice(0, 1500), '```'); console.error(e); })
  .finally(async () => {
    try { if (hub) { const log = hub.log().filter(l => /gpu|render|crash|gone|unresponsive|OOM|memory|error|warn/i.test(l)).slice(-60).map(redact); if (log.length) md.push('## Hub 日志（相关行）', '```text', ...log, '```'); } } catch {}
    if (events.length) md.push('## 崩溃 / 无响应事件', '```text', ...events, '```');
    // Hub 自己的窗口事件日志（v0.5.5 起）：页面被判成不可见、出帧停顿、无响应、进程退出都在这里。
    try { const wl = fs.readFileSync(path.join(root, 'data', 'logs', 'window-events.log'), 'utf8').trim().split(/\r?\n/).slice(-40).map(redact); if (wl.length) md.push('## Hub 窗口事件日志（最后 40 行）', '```text', ...wl, '```'); } catch {}
    // 黑屏多半是某个进程崩溃：Windows 应用日志里有崩溃模块（最近 6 小时，含你平时使用时的崩溃）。显卡型号与驱动一并记下。
    try {
      const ps = "[Console]::OutputEncoding=[Text.Encoding]::UTF8;$ErrorActionPreference='SilentlyContinue';"
        + "Get-WinEvent -FilterHashtable @{LogName='Application'; StartTime=(Get-Date).AddHours(-6)} | Where-Object { $_.Id -in 1000,1001,1002 -and $_.Message -match 'AI Hub Community|AIHubCommunity' } | Select-Object -First 8 | ForEach-Object { '[' + $_.TimeCreated.ToString('MM-dd HH:mm:ss') + '] ' + (($_.Message -split \"`r?`n\" | Where-Object { $_ -match 'Faulting|P1:|P4:|P7:|Exception|模块|异常|名称' } | Select-Object -First 6) -join ' | ') };"
        + "Get-CimInstance Win32_VideoController | ForEach-Object { 'GPU: ' + $_.Name + ' / driver ' + $_.DriverVersion + ' / ' + $_.VideoModeDescription }";
      const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8', windowsHide: true, timeout: 60000 });
      const lines = String(r.stdout || '').split(/\r?\n/).filter(Boolean).map(redact);
      md.push('## Windows 崩溃记录与显卡', '```text', ...(lines.length ? lines : ['（没有找到）']), '```');
    } catch {}
    try { if (c) c.close(); } catch {}
    if (hub) await gracefulQuit(hub).catch(() => {});
    fs.writeFileSync(path.join(out, 'freeze-report.md'), md.join('\n').slice(0, 42000), 'utf8');
    if (reportCopy) { try { fs.writeFileSync(path.resolve(reportCopy), md.join('\n').slice(0, 42000), 'utf8'); } catch {} }
    console.log('\n报告：' + path.join(out, 'freeze-report.md'));
    setTimeout(() => process.exit(0), 500);
  });
