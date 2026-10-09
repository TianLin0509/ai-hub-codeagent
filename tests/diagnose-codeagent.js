'use strict';
// CodeAgent 真机诊断：针对「新文件夹仍弹信任框」「CLI 仍是黑色」「界面卡顿 / 卡死」三个问题取证。
// 启动已安装的 AI Hub（隔离数据目录，不碰使用者自己的会话），记录原始数据，输出 diag-report.md。
//
//   node tests/diagnose-codeagent.js --exe "<AI Hub Community.exe 的完整路径>" [--gpu auto|on|off] [--only trust,theme,load]
//
// 发送的真实模型消息：负载测试 4 条（1 条单会话长回答 + 3 个会话同时各 1 条），信任与配色部分不发消息。
// 不修改 Code Agent 的配置（Hub 自己的状态回报和信任预写除外，这两项正常使用时也会发生）。
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const { spawnSync } = require('child_process');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');

const argv = process.argv.slice(2);
const arg = name => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : null; };
const exe = arg('--exe') || process.env.AI_HUB_EXE || '';
const only = arg('--only') ? new Set(arg('--only').split(',').map(s => s.trim())) : null;
const wants = part => !only || only.has(part);
const home = process.env.USERPROFILE || os.homedir();
for (const key of Object.keys(process.env)) {
  if (/^CODEAGENT_HUB_/.test(key) || ['CODEAGENT3_LAUNCHER_PID', 'CODEAGENT3_X_AUTH_TOKEN'].includes(key)) delete process.env[key];
}
const configDir = path.resolve(process.env.AI_HUB_CODEAGENT_CONFIG_DIR || process.env.CODEAGENT3_CONFIG_DIR || path.join(home, '.cac'));
const gpuMarker = path.join(home, '.ai-hub-community', 'gpu-disabled.json');
const gpuArg = arg('--gpu') || 'auto';
const gpuDisabled = gpuArg === 'off' || (gpuArg === 'auto' && fs.existsSync(gpuMarker));
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-diag-'));
const out = path.join(root, 'report');
fs.mkdirSync(out, { recursive: true });
const j = JSON.stringify;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const freePort = () => new Promise((resolve, reject) => { const s = net.createServer(); s.on('error', reject); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
// 界面框架用「光标右移 N 格」代替空格、用绝对定位换行：先还原成空格和换行，再去掉其余控制序列。
const STRIP = s => String(s || '').replace(/\x1b\[(\d*)C/g, (_, n) => ' '.repeat(Math.min(200, Number(n) || 1))).replace(/\x1b\[\d+;\d+H/g, '\n').replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '').replace(/\x1b\[[0-9;:?<=>]*[ -\/]*[@-~]/g, '').replace(/\x1b[()][0-9A-Za-z]/g, '');
const READY_RE = /Anything I can assist you with|bypass permissions on \(/;
const TRUST_RE = /Quick safety check|Yes, I trust this folder/;
const user = path.basename(home);
// 输入框出现在最后一次信任框文字之后，才算真正就绪。
function readyAfterTrust(text) {
  const lastIndex = re => { let at = -1; for (const m of text.matchAll(new RegExp(re.source, 'g'))) at = m.index; return at; };
  const ready = lastIndex(READY_RE);
  return ready >= 0 && ready > lastIndex(TRUST_RE);
}
function redact(text) {
  return String(text || '').split(home).join('%USERPROFILE%').split(home.replace(/\\/g, '/')).join('%USERPROFILE%')
    .split(user).join('<USER>').replace(/https?:\/\/[^\s'"]+/g, '<URL>');
}
const report = { startedAt: new Date().toISOString(), sections: [], facts: {} };
const md = [];
const section = (title, lines) => { md.push(`## ${title}`, '', ...lines, ''); };
let hub = null, c = null;

async function launch(label) {
  hub = await launchIsolatedHub({ dataDir: path.join(root, 'data'), port: await freePort(), ...(exe ? { executablePath: exe } : {}), windowMode: 'background', label,
    extraEnv: { AI_HUB_CODEAGENT_CONFIG_DIR: configDir, CLAUDE_HUB_HOME_DIR: path.join(root, 'home'), DEEPSEEK_API_KEY: '',
      ...(gpuDisabled ? { AI_HUB_DISABLE_GPU: '1' } : {}),
      ...(process.env.AI_HUB_CODEAGENT_COMMAND ? { AI_HUB_CODEAGENT_COMMAND: process.env.AI_HUB_CODEAGENT_COMMAND } : {}) } });
  c = await connectFirstPage(hub);
  const end = Date.now() + 60000;
  while (Date.now() < end) { try { if (await c.eval('typeof sessions !== "undefined" && typeof selectSession === "function"')) return; } catch {} await sleep(400); }
  throw new Error('Hub 界面 60 秒内没有加载');
}
async function quit() {
  if (c) { try { c.close(); } catch {} c = null; }
  if (hub) { try { await gracefulQuit(hub); } catch {} hub = null; }
}
// 带超时的页面求值：超时本身就是「界面卡住」的证据。
async function timedEval(expr, ms = 10000) {
  const t0 = Date.now();
  let timer;
  try {
    const value = await Promise.race([c.eval(expr), new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('timeout')), ms); })]);
    return { ok: true, ms: Date.now() - t0, value };
  } catch (error) { return { ok: false, ms: Date.now() - t0, error: error.message }; } finally { clearTimeout(timer); }
}
const rawBuffer = sid => c.eval(`ipcRenderer.invoke('debug:get-session-buffer', ${j(sid)})`).then(v => String(v || '')).catch(() => '');
const createSession = (cwd, extra = {}) => c.eval(`ipcRenderer.invoke('create-session', ${j({ kind: 'codeagent', opts: { cwd, effort: 'low', ...extra } })})`);
const closeSession = sid => c.eval(`ipcRenderer.invoke('close-session', ${j(sid)})`).catch(() => null);

function readJson(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (error) { return { __error: error.code || error.message }; } }
function projectKeys(dir) {
  const keys = [path.resolve(dir).replace(/\\/g, '/')];
  try { const real = fs.realpathSync.native(dir).replace(/\\/g, '/'); if (!keys.includes(real)) keys.push(real); } catch {}
  return keys;
}
function trustEntries(dir) {
  const state = readJson(path.join(configDir, '.cac.json'));
  if (state.__error) return { error: state.__error };
  const projects = state.projects || {};
  const result = {};
  for (const key of projectKeys(dir)) {
    const p = projects[key];
    result[redact(key)] = p ? { hasTrustDialogAccepted: p.hasTrustDialogAccepted, fields: Object.keys(p).sort().join(',') } : '无记录';
  }
  // CLI 自己把信任存在别处时，可能是大小写或盘符不同的键：列出包含目录名的所有键。
  const leaf = path.basename(dir).toLowerCase();
  const similar = Object.keys(projects).filter(k => k.toLowerCase().includes(leaf) && !projectKeys(dir).includes(k));
  if (similar.length) result.similarKeys = similar.map(k => `${redact(k)} → ${projects[k] && projects[k].hasTrustDialogAccepted}`);
  return result;
}

// ---------- 环境与配置 ----------
function envFacts() {
  const cliCommand = process.env.AI_HUB_CODEAGENT_COMMAND || 'codeagent';
  const version = spawnSync('cmd.exe', ['/d', '/c', `chcp 65001>nul & ${/\s/.test(cliCommand) ? `"${cliCommand}"` : cliCommand} --version`],
    { encoding: 'utf8', windowsHide: true, timeout: 60000, windowsVerbatimArguments: true });
  const cac = readJson(path.join(configDir, '.cac.json'));
  const settings = readJson(path.join(configDir, 'settings.json'));
  const projects = (cac && cac.projects) || {};
  const homeKey = home.replace(/\\/g, '/');
  const trustedProjects = Object.entries(projects).filter(([, p]) => p && p.hasTrustDialogAccepted === true).length;
  // 公司 CLI 的信任框提示「headersHelper, declared in .mcp.json」：找出这些 .mcp.json 在哪（只报路径和服务名）。
  const mcpCandidates = new Set([path.join(home, '.mcp.json'), path.join(configDir, '.mcp.json'), path.join(configDir, 'mcp.json')]);
  for (let d = path.resolve(os.tmpdir()); ; d = path.dirname(d)) { mcpCandidates.add(path.join(d, '.mcp.json')); if (path.dirname(d) === d) break; }
  for (const base of [process.env.ProgramData, 'C:\\Program Files\\CodeAgentCLI'].filter(Boolean)) {
    try {
      for (const name of fs.readdirSync(base)) {
        const p = path.join(base, name);
        if (/mcp|managed/i.test(name) && /\.json$/i.test(name)) mcpCandidates.add(p);
        if (/codeagent/i.test(name) && fs.statSync(p).isDirectory()) for (const n of fs.readdirSync(p)) if (/mcp|managed/i.test(n) && /\.json$/i.test(n)) mcpCandidates.add(path.join(p, n));
      }
    } catch {}
  }
  const mcpFiles = [];
  for (const file of mcpCandidates) {
    if (!fs.existsSync(file)) continue;
    const data = readJson(file);
    const servers = data.mcpServers || data.servers || {};
    mcpFiles.push({ file: redact(file), servers: Object.keys(servers), headersHelper: Object.entries(servers).filter(([, s]) => s && s.headersHelper).map(([n]) => n) });
  }
  const cacMcp = cac.mcpServers ? Object.entries(cac.mcpServers).map(([n, s]) => `${n}${s && s.headersHelper ? '（headersHelper）' : ''}`) : [];
  return {
    codeagentVersion: redact((version.stdout || version.stderr || '').trim()).slice(0, 200),
    node: process.version,
    os: `${os.type()} ${os.release()}，${os.cpus().length} 核 ${os.cpus()[0] && os.cpus()[0].model}，内存 ${Math.round(os.totalmem() / 2 ** 30)} GB`,
    remoteSession: process.env.SESSIONNAME || '',
    gpu: gpuDisabled ? '关闭（兼容渲染）' : '开启',
    cacTopLevelKeys: Object.keys(cac).sort(),
    cacTheme: cac.theme === undefined ? '（没有 theme 字段）' : cac.theme,
    settingsKeys: Object.keys(settings).sort(),
    settingsTheme: settings.theme === undefined ? '（没有 theme 字段）' : settings.theme,
    projectsCount: Object.keys(projects).length,
    trustedProjects,
    homeTrusted: projects[homeKey] ? projects[homeKey].hasTrustDialogAccepted : '无记录',
    cacMcpServers: cacMcp,
    mcpFiles,
    tmpdir: redact(os.tmpdir()),
    tmpdirReal: (() => { try { return redact(fs.realpathSync.native(os.tmpdir())); } catch { return ''; } })(),
  };
}

// ---------- 信任框 ----------
async function trustCase(label, dir) {
  fs.mkdirSync(dir, { recursive: true });
  const before = trustEntries(dir);
  const t0 = Date.now();
  const created = await createSession(dir);
  const sid = created && created.id;
  if (!sid) return { label, error: '创建会话失败：' + j(created).slice(0, 300) };
  await sleep(1500);
  const afterHubWrite = trustEntries(dir);
  let dialogAt = null, readyAt = null, dialogRaw = '', dialogRawLater = '', lastRaw = '';
  const end = Date.now() + 70000;
  while (Date.now() < end) {
    lastRaw = await rawBuffer(sid);
    const plain = STRIP(lastRaw);
    const tail = plain.slice(-6000);
    if (dialogAt === null && TRUST_RE.test(tail)) { dialogAt = Date.now() - t0; dialogRaw = lastRaw; }
    if (dialogAt !== null && !dialogRawLater && Date.now() - t0 - dialogAt > 3000) dialogRawLater = lastRaw;
    if (readyAfterTrust(tail)) { readyAt = Date.now() - t0; break; }
    await sleep(500);
  }
  const afterCli = trustEntries(dir);
  const typed = STRIP(lastRaw).replace(/\s+/g, ' ');
  const cmdMatch = typed.match(/codeagent[^\n]{0,40}--disable-update[^]*?(?=\s{2}|$)/i);
  const result = {
    label, dir: redact(dir),
    dialogSeenAfterMs: dialogAt, readyAfterMs: readyAt,
    outcome: dialogAt === null ? (readyAt ? '没有弹信任框，直接就绪' : '70 秒内既没弹框也没就绪')
      : (readyAt ? `弹了信任框，${Math.round((readyAt - dialogAt) / 100) / 10} 秒后被确认并就绪（Hub 自动确认生效）` : '弹了信任框，70 秒内一直没被确认'),
    launchCommand: cmdMatch ? redact(cmdMatch[0]).slice(0, 400) : '（没在输出里找到启动命令）',
    trustBefore: before, trustAfterHubWrite: afterHubWrite, trustAfterCli: afterCli,
    screenTail: redact(STRIP(lastRaw).split(/\r?\n|\r/).filter(l => l.trim()).slice(-14).join('\n')),
  };
  const rawFile = path.join(out, `trust-${label}-raw.json`);
  fs.writeFileSync(rawFile, JSON.stringify({ dialogRaw: redact(dialogRaw), dialogRawLater: redact(dialogRawLater), lastRaw: redact(lastRaw) }), 'utf8');
  // 信任框那一帧的原始字节（截取框附近，转义后可直接复制）：Hub 的自动确认要靠它离线复现。
  if (dialogRaw) {
    const idx = Math.max(0, dialogRaw.search(/Quick|Accessing|safety/));
    const from = Math.max(0, Math.min(idx, dialogRaw.length - 9000) - 1500);
    result.dialogRawExcerpt = JSON.stringify(redact(dialogRaw.slice(from, from + 9000)));
    result.dialogRawTotalChars = dialogRaw.length;
  }
  result.sessionId = sid;
  return result;
}

// ---------- 配色：CLI 启动时向终端问了什么、画的是什么底色 ----------
function themeFacts(raw) {
  const queries = new Map();
  const add = (k) => queries.set(k, (queries.get(k) || 0) + 1);
  for (const m of raw.matchAll(/\x1b\](\d+);\?(?:\x07|\x1b\\)/g)) add(`OSC ${m[1]} 查询（${{ 10: '前景色', 11: '背景色', 12: '光标色' }[m[1]] || '颜色'}）`);
  for (const m of raw.matchAll(/\x1b\]4;(\d+);\?/g)) add(`OSC 4 查询调色板 ${m[1]}`);
  for (const m of raw.matchAll(/\x1b\[\?(\d+)\$p/g)) add(`DECRQM ?${m[1]}${m[1] === '2031' ? '（明暗主题通知）' : ''}`);
  for (const m of raw.matchAll(/\x1b\[\?996n/g)) add('CSI ?996n（询问明暗主题）');
  for (const m of raw.matchAll(/\x1b\[(1[468])t/g)) add(`CSI ${m[1]}t（询问窗口/字符尺寸）`);
  for (const m of raw.matchAll(/\x1b\[([>=]?)0?c/g)) add(`CSI ${m[1]}c（设备属性）`);
  for (const m of raw.matchAll(/\x1b\[\?u/g)) add('CSI ?u（键盘协议）');
  for (const m of raw.matchAll(/\x1b\[\?(\d+)h/g)) if (['2031', '2026', '1004', '2004', '1049'].includes(m[1])) add(`开启模式 ?${m[1]}`);
  const bg = new Map();
  for (const m of raw.matchAll(/\x1b\[([0-9;:]*)m/g)) {
    const p = m[1].split(/[;:]/);
    for (let i = 0; i < p.length; i++) {
      if (p[i] === '48' && p[i + 1] === '2') { const k = `rgb(${p[i + 2]},${p[i + 3]},${p[i + 4]})`; bg.set(k, (bg.get(k) || 0) + 1); i += 4; }
      else if (p[i] === '48' && p[i + 1] === '5') { const k = `256色 ${p[i + 2]}`; bg.set(k, (bg.get(k) || 0) + 1); i += 2; }
      else if (/^(4[0-7]|10[0-7])$/.test(p[i])) { const k = `ANSI ${p[i]}`; bg.set(k, (bg.get(k) || 0) + 1); }
    }
  }
  return {
    queries: [...queries.entries()].map(([k, n]) => `${k} × ${n}`),
    topBackgrounds: [...bg.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, n]) => `${k} × ${n}`),
  };
}

// ---------- 负载：进程 CPU、界面响应、数据量 ----------
function processSample() {
  const script = "$ErrorActionPreference='SilentlyContinue';Get-CimInstance Win32_Process | Where-Object { $_.Name -match '^(AI Hub Community|electron|codeagentcli|OpenConsole|conhost|node|claude)\\.exe$' } | ForEach-Object { '{0}|{1}|{2}|{3}|{4}|{5}' -f $_.ProcessId,$_.ParentProcessId,$_.Name,($_.KernelModeTime+$_.UserModeTime),$_.WorkingSetSize,($_.CommandLine -replace '\\|',' ') }";
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true, timeout: 20000 });
  const rows = [];
  for (const line of String(r.stdout || '').split(/\r?\n/)) {
    const [pid, ppid, name, cpu100ns, ws, ...rest] = line.split('|');
    if (!pid) continue;
    const cmd = rest.join('|');
    // Chromium 子进程带 --type=；Hub 自己 fork 的后台任务只能从命令行里的脚本名认出来。
    const typeMatch = cmd.match(/--type=([a-z-]+)/);
    const scriptMatch = cmd.match(/[\\/]([\w.-]+\.(?:js|cjs|mjs|py))\b/i);
    rows.push({ pid: Number(pid), ppid: Number(ppid), name, cpu: Number(cpu100ns) / 1e7, ws: Number(ws),
      type: typeMatch ? typeMatch[1] : '', script: scriptMatch ? scriptMatch[1] : '' });
  }
  return { at: Date.now(), rows };
}
function hubTree(sample) {
  const root = hub && hub.pid;
  const ids = new Set([root]);
  let grew = true;
  while (grew) { grew = false; for (const r of sample.rows) if (!ids.has(r.pid) && ids.has(r.ppid)) { ids.add(r.pid); grew = true; } }
  return sample.rows.filter(r => ids.has(r.pid));
}
function groupOf(r) {
  if (r.pid === (hub && hub.pid)) return '主进程';
  if (/AI Hub Community|electron/i.test(r.name)) return { renderer: '界面进程', 'gpu-process': 'GPU 进程', utility: '辅助进程' }[r.type] || ('Hub 后台任务 ' + (r.type || r.script || '（未知）'));
  if (/codeagentcli|claude/i.test(r.name)) return 'CodeAgent CLI';
  if (/OpenConsole|conhost/i.test(r.name)) return '控制台宿主';
  return r.name;
}
function cpuDelta(a, b) {
  const seconds = (b.at - a.at) / 1000;
  const prev = new Map(hubTree(a).map(r => [r.pid, r]));
  const groups = new Map();
  for (const r of hubTree(b)) {
    const p = prev.get(r.pid);
    const g = groupOf(r);
    const cur = groups.get(g) || { cpu: 0, ws: 0, n: 0 };
    cur.cpu += p ? Math.max(0, r.cpu - p.cpu) : 0; cur.ws += r.ws; cur.n += 1;
    groups.set(g, cur);
  }
  const cores = os.cpus().length;
  return [...groups.entries()].map(([g, v]) => `${g}×${v.n} CPU ${Math.round(v.cpu / seconds * 100)}%（单核计，整机 ${Math.round(v.cpu / seconds / cores * 100)}%） 内存 ${Math.round(v.ws / 2 ** 20)} MB`);
}
const MONITOR = `(() => {
  if (window.__diag) return true;
  const d = window.__diag = { bytes: {}, chunks: {}, lagMax: 0, lagSum: 0, lagN: 0, longTasks: 0, longTaskMs: 0 };
  ipcRenderer.on('terminal-data', (_e, p) => { if (!p) return; d.bytes[p.sessionId] = (d.bytes[p.sessionId] || 0) + String(p.data || '').length; d.chunks[p.sessionId] = (d.chunks[p.sessionId] || 0) + 1; });
  let last = performance.now();
  setInterval(() => { const now = performance.now(); const lag = Math.max(0, now - last - 100); last = now; d.lagMax = Math.max(d.lagMax, lag); d.lagSum += lag; d.lagN += 1; }, 100);
  try { new PerformanceObserver(list => { for (const e of list.getEntries()) { d.longTasks += 1; d.longTaskMs += e.duration; } }).observe({ entryTypes: ['longtask'] }); } catch {}
  return true;
})()`;
const TAKE = `(() => { const d = window.__diag; const r = JSON.parse(JSON.stringify(d)); d.bytes = {}; d.chunks = {}; d.lagMax = 0; d.lagSum = 0; d.lagN = 0; d.longTasks = 0; d.longTaskMs = 0; return r; })()`;

async function measure(label, seconds, { sids = [], stopWhenDone = false } = {}) {
  await timedEval(TAKE);
  const s0 = processSample();
  const rtt = [], ipc = [];
  let freezes = 0, worst = 0;
  const seenRunning = new Set();
  const end = Date.now() + seconds * 1000;
  while (Date.now() < end) {
    const a = await timedEval('1', 15000);
    if (a.ok) rtt.push(a.ms); else { freezes += 1; worst = Math.max(worst, a.ms); }
    const b = await timedEval(`ipcRenderer.invoke('debug:get-last-session-write').then(() => 1)`, 15000);
    if (b.ok) ipc.push(b.ms); else { freezes += 1; worst = Math.max(worst, b.ms); }
    if (stopWhenDone && sids.length) {
      const st = await timedEval(`${j(sids)}.map(id => getSessionRuntimeTruth(sessions.get(id)).state)`, 15000);
      if (st.ok) st.value.forEach((x, i) => { if (x === 'running') seenRunning.add(i); });
      if (st.ok && seenRunning.size === sids.length && st.value.every(x => x === 'completed' || x === 'idle')) break;
    }
    await sleep(800);
  }
  const s1 = processSample();
  const d = (await timedEval(TAKE, 20000)).value || {};
  const elapsed = (s1.at - s0.at) / 1000;
  const pct = (arr, q) => { if (!arr.length) return null; const s = [...arr].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(q * s.length))]; };
  const bytes = Object.entries(d.bytes || {}).map(([sid, n]) => `${sids.includes(sid) ? '测试会话' : '其他'} ${Math.round(n / elapsed / 1024 * 10) / 10} KB/s（${Math.round((d.chunks[sid] || 0) / elapsed)} 块/s）`);
  return {
    label, seconds: Math.round(elapsed),
    cpu: cpuDelta(s0, s1),
    pageRoundTripMs: { p50: pct(rtt, 0.5), p95: pct(rtt, 0.95), max: rtt.length ? Math.max(...rtt) : null },
    mainIpcRoundTripMs: { p50: pct(ipc, 0.5), p95: pct(ipc, 0.95), max: ipc.length ? Math.max(...ipc) : null },
    unresponsive: freezes ? `${freezes} 次超过 15 秒无响应（最长 ${Math.round(worst / 1000)} 秒）` : '无',
    pageEventLoopLagMs: { max: Math.round(d.lagMax || 0), avg: d.lagN ? Math.round(d.lagSum / d.lagN) : null },
    longTasks: `${d.longTasks || 0} 次，共 ${Math.round(d.longTaskMs || 0)} ms`,
    terminalData: bytes.length ? bytes : ['无'],
  };
}
async function waitReady(sid, ms = 120000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const tail = STRIP(await rawBuffer(sid)).slice(-4000); if (readyAfterTrust(tail)) return true; await sleep(700); }
  return false;
}
const sendLong = sid => c.eval(`ipcRenderer.invoke('session:send-prompt', ${j({ sessionId: sid, text: LONG_PROMPT })})`)
  .then(r => r && r.ok !== false ? `已确认（${r.acknowledgementSource || r.sendStatus || 'ok'}）` : `未确认：${j(r).slice(0, 200)}`).catch(e => '出错：' + e.message);
const LONG_PROMPT = '请用中文写一段约 600 字的说明，介绍 OFDM 的基本原理和循环前缀的作用。直接输出正文，不要使用任何工具，不要读写文件。';

async function main() {
  if (!argv.includes('--source') && (!exe || !fs.existsSync(exe))) throw new Error('请用 --exe 指定已安装的「AI Hub Community.exe」完整路径（安装回执 JSON 的 executable）');
  report.facts.env = envFacts();
  await launch('diag');
  report.facts.env.hubTitle = await c.eval('document.title');
  report.facts.env.screen = await c.eval('`${screen.width}x${screen.height} 缩放 ${devicePixelRatio}`');
  report.facts.env.hubTheme = await c.eval(`document.documentElement.dataset.theme || document.body.dataset.theme || localStorage.getItem('hub.theme') || ''`).catch(() => '');
  await timedEval(MONITOR);
  const E = report.facts.env;
  section('环境', ['```json', j(E, null, 2), '```']);

  const trustResults = [];
  let firstRaw = '';
  if (wants('trust') || wants('theme')) {
    const tmpDir = path.join(root, 'trust-temp');
    const homeDir = path.join(home, `hub-diag-trust-${Date.now().toString(36)}`);
    const a = await trustCase('临时目录', tmpDir); trustResults.push(a);
    firstRaw = (readJson(path.join(out, 'trust-临时目录-raw.json')).lastRaw) || '';
    if (wants('trust')) {
      const b = await trustCase('用户目录下新文件夹', homeDir); trustResults.push(b);
      // 同一目录第二次启动：信任是否被记住。
      const c2 = await trustCase('临时目录第二次', tmpDir); trustResults.push(c2);
      try { fs.rmdirSync(homeDir); } catch {}
    }
    for (const r of trustResults) if (r.sessionId) await closeSession(r.sessionId);
    if (wants('trust')) {
      const lines = [];
      for (const r of trustResults) {
        lines.push(`### ${r.label}`, '', `- 结果：${r.outcome || r.error}`, `- 启动命令：\`${r.launchCommand || ''}\``,
          `- 信任记录（启动前）：\`${j(r.trustBefore)}\``, `- 信任记录（Hub 预写后）：\`${j(r.trustAfterHubWrite)}\``, `- 信任记录（结束时）：\`${j(r.trustAfterCli)}\``,
          '', '结束时屏幕：', '```text', r.screenTail || '', '```');
        if (r.dialogRawExcerpt) lines.push('', `信任框原始字节（共 ${r.dialogRawTotalChars} 字符，截取框附近 9000 字符，JSON 转义）：`, '```text', r.dialogRawExcerpt, '```');
        lines.push('');
      }
      section('一、新文件夹信任框', lines);
    }
  }
  if (wants('theme')) {
    const t = themeFacts(firstRaw);
    const termTheme = await c.eval(`(() => { const s = [...terminalCache.entries()].find(([, v]) => v && v.kind === 'codeagent'); const o = s && s[1].terminal && s[1].terminal.options.theme; return o ? { background: o.background, foreground: o.foreground } : null; })()`).catch(() => null);
    report.facts.theme = { ...t, hubTerminalTheme: termTheme };
    section('二、CLI 配色', ['- CLI 启动时向终端发出的查询：', ...(t.queries.length ? t.queries.map(q => `  - ${q}`) : ['  - 无']),
      '- CLI 画的背景色（出现次数前 6）：', ...(t.topBackgrounds.length ? t.topBackgrounds.map(q => `  - ${q}`) : ['  - 无']),
      `- Hub 终端配色：\`${j(termTheme)}\``, `- .cac.json 的 theme：\`${j(E.cacTheme)}\`；settings.json 的 theme：\`${j(E.settingsTheme)}\``]);
  }

  if (wants('load')) {
    const rows = [];
    const sendResults = [];
    const work = path.join(root, 'load');
    fs.mkdirSync(work, { recursive: true });
    const s1 = await createSession(work);
    const ok1 = await waitReady(s1.id);
    await c.eval(`selectSession(${j(s1.id)})`); await c.eval(`applyViewMode('card')`); await sleep(1500);
    rows.push(await measure('A 一个会话空闲 · 卡片视图', 30, { sids: [s1.id] }));
    await c.eval(`applyViewMode('pty')`); await sleep(1500);
    rows.push(await measure('B 一个会话空闲 · 终端视图', 30, { sids: [s1.id] }));
    await c.eval(`applyViewMode('card')`);
    if (ok1) {
      sendResults.push(await sendLong(s1.id));
      await sleep(3000);
      rows.push(await measure('C 一个会话长回答 · 卡片视图', 150, { sids: [s1.id], stopWhenDone: true }));
    }
    const s2 = await createSession(work), s3 = await createSession(work);
    const ok23 = (await waitReady(s2.id)) && (await waitReady(s3.id));
    await c.eval(`selectSession(${j(s1.id)})`); await c.eval(`applyViewMode('pty')`);
    if (ok1 && ok23) {
      for (const s of [s1, s2, s3]) sendResults.push(await sendLong(s.id));
      await sleep(3000);
      rows.push(await measure('D 三个会话同时长回答 · 终端视图', 180, { sids: [s1.id, s2.id, s3.id], stopWhenDone: true }));
    }
    await c.eval(`applyViewMode('card')`).catch(() => {});
    rows.push(await measure('E 回答结束后 · 卡片视图', 20, { sids: [s1.id, s2.id, s3.id] }));
    report.facts.load = rows;
    const lines = [`会话就绪：第 1 个 ${ok1 ? '是' : '否'}，第 2、3 个 ${ok23 ? '是' : '否'}`, `发送结果：${sendResults.join('；') || '未发送'}`, ''];
    for (const r of rows) {
      lines.push(`### ${r.label}（${r.seconds} 秒）`, '', `- 无响应：${r.unresponsive}`,
        `- 页面往返 ms：p50 ${r.pageRoundTripMs.p50} / p95 ${r.pageRoundTripMs.p95} / 最大 ${r.pageRoundTripMs.max}`,
        `- 经主进程往返 ms：p50 ${r.mainIpcRoundTripMs.p50} / p95 ${r.mainIpcRoundTripMs.p95} / 最大 ${r.mainIpcRoundTripMs.max}`,
        `- 页面主线程延迟 ms：最大 ${r.pageEventLoopLagMs.max} / 平均 ${r.pageEventLoopLagMs.avg}；长任务 ${r.longTasks}`,
        `- 终端数据：${r.terminalData.join('；')}`, '- 进程：', ...r.cpu.map(x => `  - ${x}`), '');
    }
    section('三、负载与卡顿', lines);
  }
}

main().catch(error => {
  report.fatal = redact(error && error.stack || String(error)).slice(0, 2000);
  console.error('致命错误：' + report.fatal);
}).finally(async () => {
  try { if (hub) report.facts.hubLogTail = hub.log().filter(l => /codeagent|trust|gpu|hook|error|warn|失败|slow|lag/i.test(l)).slice(-60).map(redact); } catch {}
  await quit();
  report.finishedAt = new Date().toISOString();
  const head = ['# CodeAgent 真机诊断报告', '', `- 时间：${report.startedAt} → ${report.finishedAt}`, `- 原始数据目录：${redact(out)}`, ''];
  if (report.fatal) md.push('## 致命错误', '```text', report.fatal, '```', '');
  if (report.facts.hubLogTail) md.push('## Hub 日志（相关行）', '```text', report.facts.hubLogTail.join('\n'), '```');
  fs.writeFileSync(path.join(out, 'diag-report.md'), head.concat(md).join('\n').slice(0, 42000), 'utf8');
  fs.writeFileSync(path.join(out, 'diag.json'), JSON.stringify(report, null, 2), 'utf8');
  console.log('\n报告：' + path.join(out, 'diag-report.md'));
  setTimeout(() => process.exit(report.fatal ? 1 : 0), 500);
});
