'use strict';
// 直查通道（2026-10-18 用户：「AI HUB 信息、电脑信息等，是否也可以不通过 codeagent，而直接通过脚本读取 + 压缩来完成？……减少排队，给出另一种通道」）。
// 对端发 hub-admin op:'diag'（带 sections），这台 Hub 的主进程直接用系统接口和自己的状态收集信息，
// JSON → gzip → base64url 放进一条 hub-admin-status（phase:'diag'）报回：不开 CodeAgent 会话、不占并行名额、不排队。
//
// 段落（各自 try/catch，一段失败只在该段写原因）：
//   machine   内存总量/可用/占用率、CPU 占用（一次 0.5 秒采样）、开机时长、C/D 盘剩余；
//   processes 按内存排前 20 的进程；CodeAgent 进程数与总内存、Hub 自身（主进程 + 渲染进程 + 隐藏窗口）总内存、
//             不在当前 Hub 进程树里的 CodeAgent / node / electron（重启残留嫌疑）单列；
//   hub       版本、启动时间、并行状态、通道队列快照、Hub 里的会话（用途、状态、最后活动、PID 与内存）；
//   pool      号池各号状态与模型，只用「个人 / 号 1 / 号 2」代称；
//   logs      通道日志、会话收放日志、Hub 窗口事件日志的最后 N 行（脱敏）。
// 二期（2026-10-18 追加，只读）：
//   codeagent CodeAgent 版本、个人账号登录状态、额度剩余（各会话屏幕右侧 Stats 面板的 Credit，同 renderer/codeagent-quota-bar.js 的来源，主进程读）；
//   airview   仿真相关进程（按进程名白名单，不回传命令行）；代码目录与仿真结果目录下最近更新的结果文件元信息（相对路径、大小、修改时间，前 30 个，不读内容）；
//   features  论坛、简报、手机对话、桌宠形象下载各自最后一次成功时间与最后一次错误。
// 底线：只读；不读源码，不回传文件内容（日志尾部除外，已脱敏）；sections 只认白名单，不执行对端传来的任何命令。
// 回报整条消息（HTTP 正文 {to,mid,blob}）严格小于 60000 字节：超了按段降级（先截日志，再把进程截到前 10……），始终一条发完。
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');

// 三期（2026-10-18 额度感知）：
//   errors    最近 N 条（默认 20，最多 50）CodeAgent 会话里识别到 / 疑似的 API 报错原文片段（号身份、令牌、路径已脱敏），
//             用来把真实样本带回去核对识别规则；pool / codeagent 段另带每个号的避让状态与 Credit。
const SECTIONS = ['machine', 'processes', 'hub', 'pool', 'logs', 'codeagent', 'airview', 'features', 'errors'];
const SECTION_LABEL = { machine: '电脑', processes: '进程', hub: 'Hub 状态与队列', pool: '号池', logs: '日志', codeagent: 'CodeAgent', airview: '仿真', features: '功能', errors: 'API 报错' };
const DEFAULT_ERRORS = 20, MAX_ERRORS = 50;
const MIN_INTERVAL_MS = 30000;
const MESSAGE_LIMIT = 60000;
const MESSAGE_MARGIN = 400; // 量的是发前那一份，真正发出时编号、时间戳的位数可能略有不同
const PROCESS_TIMEOUT_MS = 15000;
const DEFAULT_LOG_LINES = 80;
const MAX_LOG_LINES = 200;
const LOG_LINE_CHARS = 400;
const LOG_TAIL_BYTES = 256 * 1024;
const TOP_N = 20;
const MAX_LEFTOVERS = 30;
const MAX_SESSIONS = 60;
const DECODE_LIMIT = 4 * 1024 * 1024;
const LOGS = [
  { key: 'bridge', label: '通道日志', file: 'company-bridge.log' },
  { key: 'care', label: '会话收放日志', file: 'company-session-care.log' },
  { key: 'window', label: 'Hub 主日志（窗口事件）', file: 'window-events.log' },
  // 谁、什么时候改了 CodeAgent 默认模型（2026-10-19）：启动、选模型、默认模型变化（写前、写后、来源）各一行
  { key: 'model', label: 'CodeAgent 模型日志', file: 'codeagent-model.log' },
];
const POOL_STATE = { ready: '可用', 'login-required': '需登录', expired: '登录过期', unreadable: '凭证读不到' };

const mb = bytes => Math.round((Number(bytes) || 0) / 1048576);
const gb = bytes => Math.round((Number(bytes) || 0) / 1073741824 * 10) / 10;
const short = (s, n = 60) => { s = String(s ?? '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n) + '…' : s; };
const errText = error => short(error && error.message || error, 200);

// ---- 段落白名单 ----
function parseSections(raw) {
  const list = Array.isArray(raw) ? raw : typeof raw === 'string' && raw.trim() ? raw.split(/[,，\s]+/) : [];
  const picked = [], ignored = [];
  for (const item of list) {
    const s = String(item || '').trim().toLowerCase();
    if (!s) continue;
    if (SECTIONS.includes(s)) { if (!picked.includes(s)) picked.push(s); } else if (ignored.length < 10) ignored.push(short(s, 20));
  }
  return { sections: picked.length ? SECTIONS.filter(s => picked.includes(s)) : [...SECTIONS], ignored };
}
function parseLines(raw) {
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 ? Math.min(MAX_LOG_LINES, n) : DEFAULT_LOG_LINES;
}
function parseErrorsLimit(raw) {
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 ? Math.min(MAX_ERRORS, n) : DEFAULT_ERRORS;
}

// ---- 编解码 ----
function encode(obj) { return zlib.gzipSync(Buffer.from(JSON.stringify(obj), 'utf8'), { level: 9 }).toString('base64url'); }
function decode(text, { maxBytes = DECODE_LIMIT } = {}) {
  const raw = Buffer.from(String(text || ''), 'base64url');
  if (!raw.length) throw new Error('回报内容为空');
  return JSON.parse(zlib.gunzipSync(raw, { maxOutputLength: maxBytes }).toString('utf8'));
}

// ---- 脱敏：号身份（复用 company.js scrubText）、口令/令牌样式、配对码、网址、本机用户名与用户目录 ----
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function makeRedactor({ scrub = s => s, home = os.homedir(), user = safeUser(), extra = [] } = {}) {
  const words = [...new Set(extra.map(String).filter(s => s.length >= 4))].sort((a, b) => b.length - a.length);
  return text => {
    let s = String(text ?? '');
    try { s = scrub(s); } catch { /* 号身份读不到时按下面的样式规则换 */ }
    for (const w of words) s = s.split(w).join('<已隐去>');
    s = s.replace(/AIHUB-LINK-1\.[A-Za-z0-9_-]+/g, 'AIHUB-LINK-1.<已隐去>')
      .replace(/https?:\/\/[^\s'"<>]+/gi, '<网址>')
      .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 <已隐去>')
      .replace(/((?:pass(?:word|wd)?|pwd|token|secret|api[_-]?key|access[_-]?key|authorization|cookie|credential|口令|密码|密钥|令牌)["']?\s*[:=：]\s*["']?)[^\s"',;，；]+/gi, '$1<已隐去>')
      .replace(/\b(?:sk|ghp|gho|ghs|github_pat|xox[abpr])[-_][A-Za-z0-9_-]{10,}/g, '<已隐去>')
      .replace(/[A-Za-z0-9_+-]{32,}={0,2}/g, m => (UUID.test(m) || !/[0-9]/.test(m) || !/[A-Za-z]/.test(m)) ? m : '<已隐去>');
    if (home && home.length > 3) s = s.split(home).join('%USERPROFILE%').split(home.replace(/\\/g, '/')).join('%USERPROFILE%');
    if (user && user.length >= 4) s =s.replace(new RegExp(user.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), '<USER>');
    return s;
  };
}
function safeUser() { try { return os.userInfo().username || ''; } catch { return ''; } }
// 结果里所有字符串都过一遍（标题、说明、日志）；数字和布尔原样。
function deepRedact(value, redact, depth = 0) {
  if (typeof value === 'string') return redact(value);
  if (!value || typeof value !== 'object' || depth > 12) return value;
  if (Array.isArray(value)) return value.map(v => deepRedact(v, redact, depth + 1));
  const out = {};
  for (const [k, v] of Object.entries(value)) out[k] = deepRedact(v, redact, depth + 1);
  return out;
}

// ---- 系统接口（测试换成夹具）----
function defaultSys() {
  return {
    os,
    statfs: dir => fs.promises.statfs(dir),
    // 开发版的别的 Hub：命令行里那个目录是不是 Hub 源码目录（有 main-bootstrap.js 和 core/company-bridge）。只看文件在不在，不读内容。
    isHubAppDir: dir => fs.existsSync(path.join(dir, 'main-bootstrap.js')) && fs.existsSync(path.join(dir, 'core', 'company-bridge')),
    processSnapshot: () => require('../process-inspector').createProcessInspector({ timeoutMs: PROCESS_TIMEOUT_MS, ttlMs: 2000, logger: { warn() {} } }).snapshot({ force: true }),
    // 同一个采集器隔 gapMs 采两次：第二份带每个进程这段时间用掉的 CPU（远程维护结束进程前用，还在干活的不结束）
    sampleProcesses: async gapMs => {
      const insp = require('../process-inspector').createProcessInspector({ timeoutMs: PROCESS_TIMEOUT_MS, ttlMs: 2000, logger: { warn() {} } });
      await insp.snapshot({ force: true });
      await new Promise(r => setTimeout(r, gapMs));
      return insp.snapshot({ force: true });
    },
    tail: (file, bytes) => {
      const fd = fs.openSync(file, 'r');
      try {
        const size = fs.fstatSync(fd).size, len = Math.min(size, bytes), buf = Buffer.alloc(len);
        fs.readSync(fd, buf, 0, len, size - len);
        return { text: buf.toString('utf8'), size, mtimeMs: fs.fstatSync(fd).mtimeMs };
      } finally { fs.closeSync(fd); }
    },
    mtime: file => fs.statSync(file).mtimeMs,
    sleep: ms => new Promise(r => setTimeout(r, ms)),
    drives: () => process.platform === 'win32' ? ['C:\\', 'D:\\'] : ['/'],
    clock: () => Date.now(),
    // 二期
    codeagentVersion: command => codeagentVersion(command),
    // Hub 主进程启动时继承的原始环境（启动自检会把会话标记从 process.env 删掉，旁证要看自检前的，core/clean-launch-env.js）
    hubEnv: (() => { try { return require('../clean-launch-env').inheritedEnv(); } catch { return process.env; } })(),
    renderRows: raw => require('../hub-phone/session-chat').renderRows(raw),
    readdir: dir => fs.promises.readdir(dir, { withFileTypes: true }),
    stat: file => fs.promises.stat(file),
  };
}


// CodeAgent 版本：跑一次「<命令> --version」（隐藏窗口、8 秒超时），10 分钟内复用。命令取本机配置（codeagent-config.js 已拦掉特殊字符），不来自对端。
// cmd.exe 用 windowsVerbatimArguments 原样传命令行（同 codeagent-pool.js 的号池登录）；超时只按 PID 用 taskkill /T 结束我们自己刚起的这一个 cmd 进程树
// ——这是整个直查 / 远程维护里唯一用 /T 的地方，因为这棵树确定是这里自己起的（2026-10-18 审核）。
let versionCache = null;
function codeagentVersion(command) {
  if (versionCache && versionCache.command === command && Date.now() - versionCache.at < 10 * 60000) return versionCache.promise;
  const promise = new Promise((resolve, reject) => {
    const { execFile } = require('node:child_process');
    let timer = null, timedOut = false;
    const done = (error, stdout, stderr) => {
      clearTimeout(timer);
      const m = /\d+\.\d+\.\d+[0-9A-Za-z.+-]*/.exec(String(stdout || '') + '\n' + String(stderr || ''));
      // 命令行输出可能是本机代码页（中文 Windows 是 GBK），不原样带回，只说结论
      if (m) resolve(m[0]); else reject(new Error(!error ? '版本号没读出来' : timedOut ? '8 秒没返回' : `命令没跑成（退出码 ${error.code}），可能没装 CodeAgent 或它不在 PATH 里`));
    };
    let child;
    const env = { ...process.env };
    require('../codeagent-launch-env').applyAccountEnv(env, require('../codeagent-config').resolveCodeAgentConfig(env));
    if (process.platform === 'win32') {
      const head = /^[A-Za-z0-9_.-]+$/.test(command) ? command : `"${String(command).replace(/"/g, '')}"`;
      child = execFile('cmd.exe', ['/d', '/s', '/c', `"call ${head} --version"`], { windowsHide: true, windowsVerbatimArguments: true, encoding: 'utf8', env }, done);
    } else child = execFile(command, ['--version'], { encoding: 'utf8', env }, done);
    timer = setTimeout(() => {
      timedOut = true;
      const pid = child && child.pid;
      if (pid && process.platform === 'win32') execFile('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => {});
      else { try { child.kill(); } catch { /* 已退出 */ } }
    }, 8000);
    timer.unref?.();
  });
  versionCache = { command, at: Date.now(), promise };
  promise.catch(() => { if (versionCache && versionCache.promise === promise) versionCache = null; });
  return promise;
}

// ---- machine ----
function cpuTimes(cpus) {
  let idle = 0, total = 0;
  for (const c of cpus || []) { const t = c.times || {}; idle += t.idle || 0; total += (t.user || 0) + (t.nice || 0) + (t.sys || 0) + (t.irq || 0) + (t.idle || 0); }
  return { idle, total };
}
async function machine(sys) {
  const total = sys.os.totalmem(), free = sys.os.freemem();
  const before = cpuTimes(sys.os.cpus());
  await sys.sleep(500);
  const cpus = sys.os.cpus(), after = cpuTimes(cpus);
  const dt = after.total - before.total;
  const disks = [];
  for (const dir of sys.drives()) {
    const drive = dir.replace(/[\\/]+$/, '') || dir;
    try {
      // 网络盘、休眠的盘可能卡住：3 秒没回就算这个盘没读到
      const st = await Promise.race([Promise.resolve().then(() => sys.statfs(dir)), new Promise((_, reject) => setTimeout(() => reject(new Error('3 秒没读到')), 3000).unref?.())]);
      const size = Number(st.blocks) * Number(st.bsize), avail = Number(st.bavail) * Number(st.bsize);
      disks.push({ drive, totalGB: gb(size), freeGB: gb(avail), freePct: size > 0 ? Math.round(avail / size * 100) : null });
    } catch (error) { disks.push({ drive, error: error.code === 'ENOENT' ? '没有这个盘' : errText(error) }); }
  }
  return {
    memory: { totalMB: mb(total), freeMB: mb(free), usedPct: total > 0 ? Math.round((1 - free / total) * 100) : null, freePct: total > 0 ? Math.round(free / total * 100) : null },
    cpu: { cores: cpus.length, model: short(cpus[0]?.model || '', 60), busyPct: dt > 0 ? Math.round((1 - (after.idle - before.idle) / dt) * 100) : null, sampleMs: 500 },
    uptimeHours: Math.round(sys.os.uptime() / 360) / 10,
    os: `${sys.os.platform()} ${sys.os.release()}`,
    disks,
  };
}

// ---- processes ----
// 命令行拆成参数（认双引号），只用来认「可执行文件 / 入口脚本」是谁，不发出去。
function cmdTokens(cmd) {
  const out = [], re = /"([^"]*)"|(\S+)/g;
  let m;
  while ((m = re.exec(String(cmd || ''))) && out.length < 8) out.push(m[1] !== undefined ? m[1] : m[2]);
  return out;
}
const NODE_LIKE = new Set(['node.exe', 'node', 'electron.exe', 'aigroupchathub.exe']);
// 入口脚本：node / electron 后面第一个像路径的参数（-e / -p / --eval 这类内联代码不算）。
function entryScript(p) {
  if (!NODE_LIKE.has(String(p.name || '').toLowerCase())) return '';
  const t = cmdTokens(p.cmd);
  for (let i = 1; i < t.length; i++) {
    if (/^(-e|-p|--eval|--print|-r|--require)$/i.test(t[i])) return '';
    if (t[i].startsWith('-')) continue;
    return /[\\/]|\.[cm]?js$/i.test(t[i]) ? t[i] : '';
  }
  return '';
}
// CodeAgent 怎么认（2026-10-18 二审收紧）：只认
//   1. 可执行文件名本身以 codeagent 开头（codeagent.exe / codeagent.cmd …）；
//   2. node 跑的入口脚本在 CodeAgent 的 npm 包目录里（…\node_modules\[@scope\]codeagent*\…）；
//   3. 入口脚本在本机配置的 CodeAgent 安装目录下（installDirs，取自 CodeAgent 命令的所在目录）。
// 路径里随便哪一层目录名带 codeagent、命令行里提到 codeagent，都不算。
const CODEAGENT_EXE = /^codeagent[\w.-]*?(\.(exe|cmd|bat))?$/i;
const CODEAGENT_PKG = /[\\/]node_modules[\\/](@[^\\/]+[\\/])?codeagent[\w.-]*[\\/]/i;
function isCodeAgentProc(p, installDirs = []) {
  if (CODEAGENT_EXE.test(String(p.name || ''))) return true;
  const exe = path.win32.basename(cmdTokens(p.cmd)[0] || '');
  if (exe && CODEAGENT_EXE.test(exe)) return true;
  const script = entryScript(p);
  if (!script) return false;
  if (CODEAGENT_PKG.test(script)) return true;
  const low = script.replace(/\//g, '\\').toLowerCase();
  return installDirs.some(d => { const dir = String(d || '').replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase(); return dir.length > 3 && low.startsWith(dir + '\\'); });
}
function processHint(p, installDirs = []) {
  if (isCodeAgentProc(p, installDirs)) return /\bserve\b/i.test(String(p.cmd || '')) ? 'CodeAgent（serve）' : 'CodeAgent';
  const c = String(p.cmd || '');
  if (/[\\/]_npx[\\/]/i.test(c)) return 'npx 临时工具';
  if (/\bmcp\b|mcp[-_]/i.test(entryScript(p))) return 'MCP 服务';
  return '';
}
// Hub 自己派生、按设计会脱离 Hub 进程树的进程（普通浏览器守护进程、网页圆桌 worker、更新替换脚本）：不是 Hub 主进程，也不是残留。
const HUB_SCRIPT = /(^|[\\/])(ordinary-browser-daemon|worker)\.[cm]?js$/i;
function isHubScript(p, exe) {
  const n = String(p.name || '').toLowerCase();
  if ((n === exe || n === 'electron.exe' || n === 'aigroupchathub.exe') && /\.[cm]?js$/i.test(entryScript(p))) return true;
  if (n === 'powershell.exe' && /apply-update\.ps1/i.test(String(p.cmd || ''))) return true;
  return HUB_SCRIPT.test(entryScript(p));
}
const SUSPECT_MIN_AGE_MS = 10 * 60000;
// 进程快照 + 会话 PTY 的 PID → 分类与汇总。纯函数，单测直接喂夹具。
// 残留分两档：suspect（嫌疑，只提示）与 killable（可结束，三期 kill-orphans 只认这一档）。
function analyzeProcesses(snap, { hubPid, hubExe, sessionPids = [], top = TOP_N, now = Date.now(), isHubAppDir = () => false,
  suspectMinAgeMs = SUSPECT_MIN_AGE_MS, killMinAgeMs = null, codeagentDirs = [] } = {}) {
  const R = require('../process-reclaim');
  const { realParent, subtreePids, ancestorChain } = R;
  const killAge = killMinAgeMs == null ? R.UNATTRIBUTED_MIN_AGE_MS : killMinAgeMs;
  const { buildChildrenMap } = require('../process-inspector');
  const list = (snap.processes || []).filter(p => p && p.pid > 0);
  const byPid = new Map(list.map(p => [p.pid, p]));
  const children = snap.childrenMap || buildChildrenMap(list);
  const hubTree = byPid.has(hubPid) ? subtreePids(hubPid, children, byPid) : new Set();
  const exe = String(hubExe || '').toLowerCase();
  const lower = p => String(p.name || '').toLowerCase();
  const isHelper = p => /--type=/.test(String(p.cmd || ''));
  const isHubCore = p => p.pid === hubPid || (hubTree.has(p.pid) && lower(p) === exe);
  const isCodeAgent = p => !isHubCore(p) && isCodeAgentProc(p, codeagentDirs);
  const sum = arr => arr.reduce((a, p) => a + (p.wsBytes || 0), 0);
  // 每个会话的 PTY 进程树：会话编号、内存
  const owner = new Map(), sessions = new Map();
  for (const { id, pid } of sessionPids) {
    if (!id || !byPid.has(Number(pid))) continue;
    const tree = subtreePids(Number(pid), children, byPid);
    let ws = 0, count = 0, codeAgent = 0;
    for (const x of tree) { const p = byPid.get(x); if (!p || owner.has(x)) continue; owner.set(x, id); ws += p.wsBytes || 0; count += 1; if (isCodeAgent(p)) codeAgent += 1; }
    sessions.set(id, { pid: Number(pid), memMB: mb(ws), processes: count, codeAgent });
  }
  const hubCore = list.filter(isHubCore), codeAgents = list.filter(isCodeAgent);
  const sessionProcs = list.filter(p => owner.has(p.pid));
  // 别的 Hub 主进程：树外、不是 --type= 子进程、不是 Hub 派生的脚本进程，并且确实是 Hub——
  // 安装版按程序名（AIHubCommunity.exe）；开发版是 electron.exe，要命令行里带 Hub 源码目录（别的 Electron 程序不算）。
  const hubScript = p => isHubScript(p, exe);
  const isHubMain = p => {
    if (hubTree.has(p.pid) || isHelper(p) || hubScript(p)) return false;
    const n = lower(p);
    if (n === 'aigroupchathub.exe' || (exe !== 'electron.exe' && n === exe)) return true;
    if (n !== 'electron.exe') return false;
    if (R.isHubProcess(p)) return true;
    const arg = cmdTokens(p.cmd).slice(1).find(x => !x.startsWith('-'));
    try { return !!arg && isHubAppDir(arg); } catch { return false; }
  };
  const otherTree = new Map(); // 进程 PID → 所属的别的 Hub 主进程 PID
  const otherHubs = [];
  for (const main of list.filter(isHubMain)) {
    const tree = subtreePids(main.pid, children, byPid);
    for (const x of tree) if (!otherTree.has(x)) otherTree.set(x, main.pid);
    const members = [...tree].map(x => byPid.get(x)).filter(Boolean);
    otherHubs.push({ pid: main.pid, name: main.name, startedAt: main.startedAt || null, memMB: mb(main.wsBytes), processes: members.length - 1, treeMemMB: mb(sum(members)),
      hasWindow: !!main.hasWindow, idle: members.length <= 1 && !main.hasWindow });
  }
  const hubScripts = list.filter(p => !hubTree.has(p.pid) && !otherTree.has(p.pid) && hubScript(p));
  // 残留：只看当前 Hub 树、别的 Hub 树都不包含、自己不是 Hub 主进程、也不是 Hub 派生脚本的进程。
  // 嫌疑 = 命中 process-reclaim 的残留形态白名单，或「父进程已经不在、活了 10 分钟以上」的 CodeAgent / node / 孤立 Electron 子进程。
  // 可结束 = 嫌疑里的 CodeAgent 或命中白名单的，父进程已经不在、活了 30 分钟以上（三期 kill-orphans 只认这一档）。
  const age = p => (p.startedAt ? now - p.startedAt : 0);
  const parentGone = p => !realParent(p, byPid);
  const outside = p => !hubTree.has(p.pid) && !otherTree.has(p.pid) && !isHubMain(p) && !hubScript(p);
  const kindOf = p => {
    if (isCodeAgent(p)) return 'codeagent';
    const pattern = R.matchLeftoverPattern(p);
    if (pattern) return 'pattern:' + pattern.id;
    const n = lower(p);
    if (n === 'node.exe' || n === 'node') return 'node';
    if (isHelper(p) && (n === exe || n === 'electron.exe' || n === 'aigroupchathub.exe')) return 'electron-helper';
    return null;
  };
  const judge = p => {
    if (!outside(p)) return null;
    const kind = kindOf(p);
    if (!kind) return null;
    const pattern = kind.startsWith('pattern:');
    const gone = parentGone(p);
    if (!pattern && !(gone && age(p) >= suspectMinAgeMs)) return null;
    // 再加两道（2026-10-18 二审，同 process-reclaim.js）：整棵进程树开着可见窗口的不算可结束；量得到 CPU 且最近还在用的不算可结束。
    // 量不到 CPU（直查只采一次）先不排除，远程维护结束前会隔 1.5 秒再采一次，量不到就不结束。
    const tree = subtreePids(p.pid, children, byPid);
    const windowed = R.treeHasWindow ? R.treeHasWindow(tree, byPid) : [...tree].some(x => byPid.get(x)?.hasWindow);
    const cpu = R.treeCpuState(tree, byPid, snap.cpuWindowMs, snap.cpuCount);
    const killable = (kind === 'codeagent' || pattern) && gone && age(p) >= killAge && !windowed && !(cpu.known && !cpu.idle);
    return { kind: pattern ? 'pattern' : kind, pattern: pattern ? kind.slice(8) : null, killable, gone, windowed,
      cpu: { known: cpu.known, idle: cpu.idle, pct: cpu.cpuPct == null ? null : Math.round(cpu.cpuPct * 100) / 100 } };
  };
  const verdict = new Map();
  for (const p of list) { const v = judge(p); if (v) verdict.set(p.pid, v); }
  const rank = { codeagent: 0, pattern: 1, node: 2, 'electron-helper': 3 };
  const leftovers = list.filter(p => verdict.has(p.pid))
    .sort((a, b) => (Number(verdict.get(b.pid).killable) - Number(verdict.get(a.pid).killable)) || (rank[verdict.get(a.pid).kind] - rank[verdict.get(b.pid).kind]) || ((b.wsBytes || 0) - (a.wsBytes || 0)));
  const otherMembers = list.filter(p => otherTree.has(p.pid));
  const hintOf = (p, v) => v.kind === 'pattern' ? (R.LEFTOVER_PATTERNS.find(x => x.id === v.pattern) || {}).label || v.pattern
    : v.kind === 'electron-helper' ? '孤立的 Electron 子进程（它的主进程已经不在了）' : processHint(p, codeagentDirs) || 'Node';
  const row = p => ({ name: p.name, pid: p.pid, ppid: p.ppid || 0, memMB: mb(p.wsBytes), privMB: mb(p.privBytes), startedAt: p.startedAt || null,
    hub: hubTree.has(p.pid), hubCore: isHubCore(p), codeAgent: isCodeAgent(p), session: owner.has(p.pid) ? String(owner.get(p.pid)).slice(0, 8) : null,
    otherHub: otherTree.has(p.pid), leftover: verdict.has(p.pid), killable: !!verdict.get(p.pid)?.killable });
  const killable = leftovers.filter(p => verdict.get(p.pid).killable);
  return {
    sampledAt: snap.sampledAt || now, total: list.length, hubPid, hubFound: byPid.has(hubPid),
    rules: { suspectMinAgeMin: Math.round(suspectMinAgeMs / 60000), killMinAgeMin: Math.round(killAge / 60000) },
    summary: {
      codeAgent: { count: codeAgents.length, memMB: mb(sum(codeAgents)), inHub: codeAgents.filter(p => hubTree.has(p.pid)).length, outside: codeAgents.filter(p => !hubTree.has(p.pid)).length },
      hubSelf: { count: hubCore.length, memMB: mb(sum(hubCore)) },
      hubSessions: { sessions: sessions.size, processes: sessionProcs.length, memMB: mb(sum(sessionProcs)) },
      hubTree: { count: hubTree.size, memMB: mb(sum(list.filter(p => hubTree.has(p.pid)))) },
      leftovers: { count: leftovers.length, memMB: mb(sum(leftovers)), killable: killable.length, killableMemMB: mb(sum(killable)) },
      otherHubs: { count: otherHubs.length, processes: otherMembers.length, memMB: mb(sum(otherMembers)) },
      hubScripts: { count: hubScripts.length, memMB: mb(sum(hubScripts)) },
    },
    top: [...list].sort((a, b) => (b.wsBytes || 0) - (a.wsBytes || 0)).slice(0, top).map(row),
    leftovers: leftovers.slice(0, MAX_LEFTOVERS).map(p => { const v = verdict.get(p.pid); return { name: p.name, pid: p.pid, ppid: p.ppid || 0, memMB: mb(p.wsBytes), startedAt: p.startedAt || null,
      ageMin: p.startedAt ? Math.max(0, Math.round((now - p.startedAt) / 60000)) : null, kind: v.kind, parentAlive: !v.gone, killable: v.killable, ...(v.windowed ? { windowed: true } : {}), cpu: v.cpu, hint: hintOf(p, v) }; }),
    otherHubs: otherHubs.sort((a, b) => b.treeMemMB - a.treeMemMB).slice(0, 10),
    sessions,
    // 三期远程维护用：永远不能结束的进程（当前 Hub 进程树、所有别的 Hub 主进程及其进程树、Hub 派生的脚本进程）
    protectedPids: new Set([...hubTree, ...otherTree.keys(), ...hubScripts.map(p => p.pid)]),
    // 二期仿真进程用（不发出去）
    internal: { hubTree, owner, list, now },
  };
}

// ---- 号池代称：个人 / 号 1 / 号 2，不带编号、工号掩码、备注 ----
// 有数据目录时用落盘的固定序号（core/codeagent-quota.js aliasMap，额度感知 2026-10-18：删号后其余号的代称不变），和通道、家里号表一致；
// 没有时（单测夹具）按号池登记顺序。
function poolAliases(raw, dataDir = null) {
  const ids = (raw?.accounts || []).map(a => a && a.id).filter(Boolean);
  if (dataDir) { try { return require('../codeagent-quota').aliasMap(dataDir, ids); } catch { /* 读写不了就按登记顺序 */ } }
  const map = new Map([['personal', '个人']]);
  ids.forEach((id, i) => map.set(id, `号 ${i + 1}`));
  return map;
}
// 每个号的避让状态（额度感知，core/codeagent-quota.js）：来源、种类、原因（已脱敏的报错片段）、首次时间、预计恢复。
function avoidView(e) {
  if (!e) return null;
  const Q = require('../codeagent-quota');
  // 模型配置避让（2026-10-19）：没有到期时间，until 给下一次允许试探的时间，另带被请求的模型和这个号的权限清单。
  const until = e.until != null ? Number(e.until) : e.kind === 'model-config' && e.probeAt ? Number(e.probeAt) : null;
  return { source: e.source, kind: e.kind, label: Q.describeAvoid(e), since: e.since || null, until, sample: e.sample || '', hits: Number(e.hits) || 1,
    ...(e.kind === 'model-config' ? { model: e.model || '', have: Array.isArray(e.have) ? e.have : [], probes: Number(e.probes) || 0 } : {}) };
}
function creditView(c) { return c && Number.isFinite(Number(c.remaining)) ? { remaining: Number(c.remaining), pct: Number(c.pct), bucket: c.bucket || '', at: c.at || null } : null; }
function pool(raw, { avoid = {}, credit = {}, aliases: given = null, pickBreaker = {}, ...extra } = {}) {
  if (!raw) throw new Error('这台 Hub 读不到号池');
  const aliases = given || poolAliases(raw);
  const pick = (a, alias, key) => ({ alias, state: POOL_STATE[a.state] || String(a.state || '未知'), ready: a.state === 'ready',
    activeSessions: Number(a.activeSessions) || 0, defaultModel: a.defaultModel ? String(a.defaultModel) : '', models: (Array.isArray(a.models) ? a.models : []).map(String).slice(0, 20),
    // 清单是否来自「获取模型权限」的探测文件（审核 2026-10-19：个人账号的修正要看它）
    modelsAuthoritative: !!(a.modelsAuthoritative ?? a.authoritative), modelsProbedAt: a.modelsProbedAt || null,
    modelsSource: a.modelsProbedAt ? 'probe' : (a.modelsAuthoritative ?? a.authoritative) ? 'enterprise' : 'config',
    ...(a.duplicateOf ? { duplicate: true } : {}), ...(a.sameAsPersonal ? { sameAsPersonal: true } : {}),
    ...(key === 'personal' && Array.isArray(a.answeredModels) ? { answeredModels: a.answeredModels } : {}),
    ...(key === 'personal' && a.configModel != null ? { configModel: String(a.configModel) } : {}),
    ...(key === 'personal' && a.settingsLastChange ? { settingsLastChange: settingsChangeView(a.settingsLastChange) } : {}),
    // 凭证读不懂时的原因（2026-10-19：读文件出错 / 不是 JSON / 没有登录项，不含凭证内容）
    ...(a.state === 'unreadable' && a.credentialsNote ? { credentialsNote: String(a.credentialsNote).slice(0, 120) } : {}),
    ...(key === 'personal' && a.lastBackup ? { lastBackup: { model: a.lastBackup.model == null ? null : String(a.lastBackup.model), at: String(a.lastBackup.name || '').replace(/^settings\.json\.hub-backup-/, '') } } : {}),
    ...(a.routeSwitched ? { routeSwitched: true } : {}), avoid: avoidView(avoid[key]), credit: creditView(credit[key]),
    // 自动选模型连续失败的计数与熔断（core/codeagent-auto-pick.js，2026-10-21）：熔断中这个号的自动会话不开模型菜单、直接发问题
    ...(pickBreaker[key] ? { autoPick: pickBreaker[key].open ? { breaker: true, failures: pickBreaker[key].failures, until: pickBreaker[key].until, note: '连续自动选模型没成功，熔断中：不开模型菜单、直接发问题', lastError: pickBreaker[key].lastError }
      : { breaker: false, failures: pickBreaker[key].failures, lastError: pickBreaker[key].lastError } } : {}),
    // 号池号默认模型未知 / 写的不在清单里（账号即模型，2026-10-19 审核）：这样的号不参与按模型派活
    ...(key !== 'personal' && a.defaultNote ? { defaultNote: String(a.defaultNote) } : {}),
    // 默认模型和权限不符（个人账号，2026-10-19）：settings.json 里写的值和权限清单，号表据此提示、可远程修正（set-personal-model）
    ...(a.configMismatch ? { configMismatch: { written: String(a.configMismatch.written || ''), models: (a.configMismatch.models || []).map(String).slice(0, 12), suggest: String(a.configMismatch.suggest || ''),
      note: require('../codeagent-model-route').describeMismatch(a.configMismatch) } } : {}) });
  const accounts = [];
  if (raw.personal) accounts.push(pick(raw.personal, '个人', 'personal'));
  for (const a of raw.accounts || []) accounts.push(pick(a, aliases.get(a.id), a.id));
  return { accounts, ready: accounts.filter(a => a.ready).length, avoiding: accounts.filter(a => a.avoid).length, ...extra };
}
// ---- errors：识别到 / 疑似的 API 报错原文（quota-watch.js 记下的，已脱敏），号换成代称 ----
function errorsSection(bridge, aliases, limit = DEFAULT_ERRORS) {
  if (!bridge.quota) throw new Error('这台 Hub 没有额度识别');
  const list = bridge.quota.errors(limit).map(e => ({ at: e.at || null, seenAt: e.seenAt || null, account: aliases.get(e.key) || (e.key === 'personal' ? '个人' : '号池'),
    session: e.session || null, purpose: e.purpose === 'company-bridge' ? '特战通道' : '其他会话', source: e.source === 'screen' ? '屏幕' : '原生记录',
    structured: !!e.structured, matched: e.ruleId || null, kind: e.kind || null, text: e.text || '' }));
  const status = bridge.quotaStatus ? bridge.quotaStatus() : null;
  return { limit, total: (bridge.store.get('quotaErrors') || []).length, list,
    rules: status && status.rules ? status.rules.map(r => ({ id: r.id, kind: r.kind, builtin: r.builtin })) : null, ruleErrors: status?.ruleErrors || [], guard: status ? status.on : null };
}

function settingsChangeView(c) {
  const str = v => (v == null ? '' : String(v).slice(0, 80));
  return { at: str(c.at), ...(c.mtime ? { mtime: str(c.mtime) } : {}), before: str(c.before), after: str(c.after), source: str(c.source),
    ...(c.session ? { session: str(c.session) } : {}), ...(Array.isArray(c.launches) && c.launches.length ? { launches: c.launches.slice(0, 6).map(str) } : {}) };
}

// ---- logs ----
function logs(sys, dir, lines) {
  const out = [];
  for (const spec of LOGS) {
    try {
      const { text, size, mtimeMs } = sys.tail(path.join(dir, spec.file), LOG_TAIL_BYTES);
      const all = String(text).split(/\r?\n/).filter(Boolean);
      if (size > LOG_TAIL_BYTES) all.shift(); // 从中间截的第一行不完整
      out.push({ key: spec.key, label: spec.label, file: spec.file, sizeKB: Math.round(size / 1024), mtime: mtimeMs || null, totalLines: all.length,
        lines: all.slice(-lines).map(l => l.length > LOG_LINE_CHARS ? l.slice(0, LOG_LINE_CHARS) + '…' : l) });
    } catch (error) { out.push({ key: spec.key, label: spec.label, file: spec.file, error: error.code === 'ENOENT' ? '还没有这份日志' : errText(error) }); }
  }
  return { linesPerLog: lines, files: out };
}

// ---- hub ----
function roundPhase(r) { return r.reply ? 'replied' : r.error ? 'failed' : r.sentAt ? 'running' : 'queued'; }
function hub(bridge, deps, sys, ctx) {
  const now = bridge.now();
  const aliases = ctx.aliases || new Map([['personal', '个人']]);
  const transcriptAt = meta => { try { return meta?.transcriptPath ? Math.round(sys.mtime(meta.transcriptPath)) : null; } catch { return null; } };
  const queue = bridge.openThreads().map(t => {
    const r = t.rounds.find(x => roundPhase(x) === 'running') || t.rounds.find(x => roundPhase(x) === 'queued') || t.rounds[t.rounds.length - 1] || {};
    const meta = t.sessionId ? (deps.getSession?.(t.sessionId) || deps.getSessionMetadata?.(t.sessionId)) : null;
    const phase = roundPhase(r);
    return { thread: t.id, title: short(t.title, 40), rounds: t.rounds.length, round: r.round ?? null, phase, model: t.model || null,
      receivedAt: r.receivedAt || null, sentAt: r.sentAt || null, waitedSec: phase === 'queued' && r.receivedAt ? Math.round((now - r.receivedAt) / 1000) : null,
      runningSec: phase === 'running' && r.sentAt ? Math.round((now - r.sentAt) / 1000) : null,
      queueNote: r.queueNote || null, retryAt: r.retryAt || null, resumePending: !!r.resumePending, receiptIssue: r.receiptIssue || null,
      ...(r.choiceStuck ? { choiceStuck: true } : {}),
      session: t.sessionId ? String(t.sessionId).slice(0, 8) : null, sessionAlive: !!(t.sessionId && deps.getSession?.(t.sessionId)),
      sessionBusy: !!(t.sessionId && bridge.sessionBusy(t.sessionId)), working: (() => { try { return !!bridge.roundWorking(t); } catch { return null; } })(),
      transcriptAt: transcriptAt(meta) };
  });
  const sessions = [];
  const ids = deps.listSessionIds?.() || [];
  for (const id of ids) {
    const s = deps.getSession?.(id);
    if (!s) continue;
    const mem = ctx.sessionMem?.get(id);
    const lastActiveAt = Math.max(Number(s.lastMessageTime) || 0, Number(s.lastCompletedAt) || 0, Number(s.lastRunStartedAt) || 0, Number(deps.sessionInputAt?.(id)) || 0) || null;
    // 标题里可能有公司项目名：只有通道会话（标题是「1018-Q1-codex」这类编号）保留，其余置空（2026-10-18 审核）
    sessions.push({ id: String(id).slice(0, 8), title: s.purpose === 'company-bridge' ? short(s.title, 40) : '', kind: String(s.kind || ''), purpose: s.purpose || null,
      state: s.status === 'dormant' ? 'dormant' : s.status === 'closed' ? 'closed' : 'active', status: s.status || null, busy: !!bridge.sessionBusy(id),
      lastActiveAt, pid: mem?.pid ?? ctx.ptyPids?.get(id) ?? null, memMB: mem ? mem.memMB : null, processes: mem ? mem.processes : null,
      account: s.codeagentPoolAccount ? (aliases.get(s.codeagentPoolAccount) || '号池') : /^codeagent/.test(String(s.kind || '')) ? '个人' : null });
  }
  sessions.sort((a, b) => (b.lastActiveAt || 0) - (a.lastActiveAt || 0));
  const byState = sessions.reduce((m, s) => ({ ...m, [s.state]: (m[s.state] || 0) + 1 }), {});
  const job = bridge.hubAdmin?.job?.();
  return {
    version: bridge.hubAdmin?.current?.() || deps.currentVersion || null, pid: ctx.hubPid, startedAt: ctx.hubStartedAt || null,
    uptimeMin: ctx.hubStartedAt ? Math.round((now - ctx.hubStartedAt) / 60000) : null, uptimeSec: ctx.hubStartedAt ? Math.round((now - ctx.hubStartedAt) / 1000) : null,
    parallel: bridge.parallelLimitSafe(),
    care: bridge.careState ? { keepWarmMinutes: bridge.careState.keepWarmMinutes, freePercent: bridge.careState.freePercent, warm: bridge.careState.warm, at: bridge.careState.at,
      bloatGB: bridge.careState.bloatGB ?? null, sessions: bridge.careState.sessions || [], bloatSuspended: bridge.careState.bloatSuspended || [] } : null,
    holdingDispatch: (() => { try { return !!bridge.hubAdmin.holdingDispatch(); } catch { return null; } })(),
    adminJob: job ? { id: job.id, op: job.op, phase: job.phase, note: short(job.note, 120) } : null,
    queue: { running: queue.filter(q => q.phase === 'running').length, queued: queue.filter(q => q.phase === 'queued').length, threads: queue },
    // 最近失败的问题（远程维护 retry 用）：当前配对代次、最近 10 个
    failed: (() => { try { return bridge.threads(60).filter(t => t.state === 'failed' && t.gen === bridge.link.gen()).slice(0, 10).map(t => { const r = [...t.rounds].reverse().find(x => x.error) || {}; return { thread: t.id, title: short(t.title, 40), round: r.round ?? null, error: short(r.error, 120), failedAt: r.failedAt || null }; }); } catch { return []; } })(),
    sessions: { total: sessions.length, byState, list: sessions.slice(0, MAX_SESSIONS) },
  };
}

// ==== 二期（只读）====
// ---- codeagent：版本、个人账号登录状态、额度剩余 ----
// 额度只有 CodeAgent 界面右侧 Stats 面板那一行（没有查额度的命令）：读开着的 CodeAgent 会话的屏幕，取最近活动的 8 个，按号归并。
const MAX_QUOTA_SCREENS = 8;
async function codeagent(bridge, deps, sys, ctx, poolRaw, poolError) {
  const out = {};
  let command = '';
  try { command = deps.codeagentCommand ? deps.codeagentCommand() : require('../codeagent-config').resolveCodeAgentConfig(process.env).command; } catch (error) { out.versionError = errText(error); }
  if (command) {
    try { out.version = await Promise.race([sys.codeagentVersion(command), new Promise((_, reject) => setTimeout(() => reject(new Error('10 秒没返回')), 10000).unref?.())]); }
    catch (error) { out.versionError = errText(error); }
  }
  if (poolError) out.loginError = errText(poolError);
  const p = poolRaw?.personal;
  out.personal = p ? { state: POOL_STATE[p.state] || String(p.state || '未知'), ready: p.state === 'ready', expiresAt: Number(p.expiresAt) || null, defaultModel: p.defaultModel || '',
    ...(p.state === 'unreadable' && p.credentialsNote ? { credentialsNote: String(p.credentialsNote).slice(0, 120) } : {}),
    ...(p.configModel != null ? { configModel: String(p.configModel || '') } : {}), ...(p.configMismatch ? { configNote: require('../codeagent-model-route').describeMismatch(p.configMismatch) } : {}),
    ...(p.configSource ? { configSource: p.configSource } : {}), ...(p.settingsMtime ? { settingsMtime: p.settingsMtime } : {}),
    // settings.json 最近一次被改写：时间、写前写后、来源（Hub 自己的写入按登记认，认不出记 external 并附前后启动的会话）
    ...(p.settingsLastChange ? { settingsLastChange: settingsChangeView(p.settingsLastChange) } : {}),
    // 个人目录是否等于（或包含于）某个号池号的目录：只回是否和号的代称（2026-10-19）
    inPool: !!p.poolDirMatch, ...(p.poolDirMatch ? { inPoolAlias: p.poolDirMatch.account ? (ctx.aliases?.get(p.poolDirMatch.account) || '号池里的一个号') : '号池目录' } : {}) } : null;
  // Hub 进程继承的配置目录：采用还是忽略、原因、来自哪一层环境变量、是否落在号池（代称），都不带路径。
  // 判定在 Hub 启动时读一次注册表做好（codeagent-config.js loadInheritedDecision，和个人目录的判定共用），这里不再读。
  const inh = p && p.inheritedConfigDir;
  if (out.personal) {
    // Presence only: never include a token value, account identity, or credentials.
    out.personal.inheritedAuthToken = require('../codeagent-launch-env').authStatus(sys.hubEnv || process.env);
  }
  if (out.personal && inh) {
    const env = sys.hubEnv || process.env; // Hub 主进程自己的环境（单测可替换）
    const origin = ['user-env', 'system-env', 'process-only', 'unknown'].includes(inh.origin) ? inh.origin : 'unknown';
    out.personal.inheritedConfigDir = { adopted: !!inh.adopted, ignored: !inh.adopted, reason: String(inh.reason || ''), note: String(inh.note || ''), variable: String(inh.variable || ''),
      origin, inPool: !!inh.inPool, ...(inh.inPool ? { inPoolAlias: inh.inPoolAccount ? (ctx.aliases?.get(inh.inPoolAccount) || '号池里的一个号') : '号池目录' } : {}),
      // 旁证（只给是否）：Hub 自己的环境里有 Hub 会话标记 / CodeAgent 启动器标记，说明这个 Hub 是从某个会话的进程树里启动的
      // （之后的远程重启、更新都会把同一份环境带下去）
      startedInside: { hubSession: !!env.CLAUDE_HUB_SESSION_ID, codeagent: !!env.CODEAGENT3_LAUNCHER_PID || Object.keys(env).some(k => /^CODEAGENT_HUB_/.test(k)) } };
  }
  // 通道会话自学习去重（core/codeagent-member-mcp.js，2026-10-21）：这台 CodeAgent 会自己加载、通道配置里不再重复写的插件，按号给代称、不回路径。
  if (deps.dataDir) {
    try {
      const norm = d => String(d || '').replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
      let personalDir = '';
      try { personalDir = norm(require('../codeagent-config').resolveCodeAgentConfig(process.env).configDir); } catch { /* 没有个人目录 */ }
      const label = dir => {
        if (personalDir && dir === personalDir) return '个人';
        try { const m = require('../codeagent-pool').poolDirMatch(deps.dataDir, dir); if (m && m.id) return ctx.aliases?.get(m.id) || '号池里的一个号'; } catch { /* 认不出 */ }
        return '某个号';
      };
      const native = require('../codeagent-member-mcp').describeNativeMcp(deps.dataDir, label);
      if (native.version || native.accounts.length) out.nativeMcp = { version: native.version, accounts: native.accounts.map(a => ({ account: a.account, names: a.names, learnedAt: a.learnedAt, text: a.text })) };
    } catch (error) { out.nativeMcpError = errText(error); }
  }
  const accounts = poolRaw?.accounts || [];
  out.pool = { total: accounts.length, ready: accounts.filter(a => a.state === 'ready').length, needLogin: accounts.filter(a => a.state !== 'ready').length };
  // 额度
  const aliases = ctx.aliases || new Map([['personal', '个人']]);
  const live = (deps.listSessionIds?.() || []).map(id => ({ id, s: deps.getSession?.(id) }))
    .filter(x => x.s && /^codeagent/.test(String(x.s.kind || '')) && x.s.status !== 'dormant' && x.s.status !== 'closed')
    .map(x => ({ ...x, at: Math.max(Number(x.s.lastMessageTime) || 0, Number(x.s.lastCompletedAt) || 0, Number(deps.sessionInputAt?.(x.id)) || 0) }))
    .sort((a, b) => b.at - a.at).slice(0, MAX_QUOTA_SCREENS);
  const quota = new Map();
  let read = 0;
  if (!deps.readTerminalScreen) out.quotaNote = '这台 Hub 读不到会话屏幕';
  else {
    const { parseCodeAgentCredit } = require('../codeagent-screen-stats');
    for (const x of live) {
      const account = x.s.codeagentPoolAccount ? (aliases.get(x.s.codeagentPoolAccount) || '号池') : '个人';
      if (quota.has(account)) continue;
      try {
        const raw = await deps.readTerminalScreen(x.id);
        if (!raw) continue;
        read += 1;
        const reading = parseCodeAgentCredit(await sys.renderRows(raw));
        if (reading) quota.set(account, { account, remaining: reading.remaining, pct: reading.pct, total: reading.total, bucket: reading.bucket, session: String(x.id).slice(0, 8), sessionActiveAt: x.at || null });
      } catch { /* 这个会话的屏幕读不了，看下一个 */ }
    }
  }
  out.quota = [...quota.values()];
  out.quotaScreens = { live: live.length, read };
  // 每个号的避让状态（额度感知，2026-10-18）
  try {
    const avoid = bridge.avoidViewMap ? bridge.avoidViewMap() : bridge.avoidMap ? bridge.avoidMap() : {};
    out.avoid = Object.entries(avoid).map(([k, e]) => ({ account: aliases.get(k) || (k === 'personal' ? '个人' : '号池'), ...avoidView(e) }));
  } catch (error) { out.avoidError = errText(error); }
  if (!out.quota.length && !out.quotaNote) out.quotaNote = live.length ? '开着的 CodeAgent 会话屏幕上没看到 Credit 行（Stats 面板没显示）' : '没有开着的 CodeAgent 会话，读不到额度';
  return out;
}

// ---- airview：仿真进程 + 结果文件元信息 ----
const SIM_PROCESS = /^(python[w]?(\d+(\.\d+)?)?|py|matlab|mlab|simulink|octave|airview[\w.-]*|.*airview.*)\.exe$/i;
function airviewProcesses(analyzed) {
  const { hubTree, owner, list, now } = analyzed.internal;
  return list.filter(p => SIM_PROCESS.test(String(p.name || '')))
    .sort((a, b) => (b.wsBytes || 0) - (a.wsBytes || 0)).slice(0, 30)
    .map(p => ({ name: p.name, pid: p.pid, memMB: mb(p.wsBytes), startedAt: p.startedAt || null, runningMin: p.startedAt ? Math.max(0, Math.round((now - p.startedAt) / 60000)) : null,
      hub: hubTree.has(p.pid), session: owner.has(p.pid) ? String(owner.get(p.pid)).slice(0, 8) : null,
      // 只给一句标签（命令行本身不发出去）
      hint: /airview_runner/i.test(String(p.cmd || '')) ? 'AirView 运行器' : /airview/i.test(String(p.cmd || '') + p.name) ? 'AirView 相关' : /matlab|mlab|simulink/i.test(p.name) ? 'MATLAB' : /python|^py\.exe$/i.test(p.name) ? 'Python' : '' }));
}
// 看哪些目录：设置里的仿真结果目录（默认 C:/AirView）+ 代码目录，去重，最多 12 个。
function resultDirsOf(bridge) {
  const s = bridge.settings();
  const list = [...(Array.isArray(s.resultDirs) ? s.resultDirs : []), ...(Array.isArray(s.codeRoots) ? s.codeRoots : [])].map(String).filter(Boolean);
  const seen = new Set(), out = [];
  for (const d of list) { const k = d.replace(/[\\/]+$/, '').toLowerCase(); if (!seen.has(k)) { seen.add(k); out.push(d); } }
  return out.slice(0, 12);
}
// 结果文件后缀白名单（源码后缀不在里面）：只看名字、大小、修改时间，不打开文件。
const RESULT_EXT = /\.(mat|csv|tsv|txt|log|json|xlsx|xls|png|jpe?g|svg|fig|h5|hdf5|dat|out|npz|npy|pkl|parquet|zip|7z|html?|pdf)$/i;
const SKIP_DIRS = new Set(['node_modules', '.git', '.svn', '.hg', '__pycache__', '.venv', 'venv', '.idea', '.vscode', '$recycle.bin', 'system volume information']);
const SCAN_BUDGET_MS = 4000, SCAN_HARD_MS = 6000, SCAN_OP_MS = 3000, SCAN_MAX_ENTRIES = 30000, SCAN_MAX_DEPTH = 6, RECENT_FILES = 30;
// 每次 readdir / stat 最多等 3 秒（网络盘、休眠的盘可能卡住）；每处理一个条目都看一次时间预算和条数；整段另有 6 秒硬上限（2026-10-18 二审）。
const within = (promise, ms, what) => Promise.race([promise, new Promise((_, reject) => { const t = setTimeout(() => reject(Object.assign(new Error(what + ' 超过 ' + ms / 1000 + ' 秒'), { code: 'ETIMEOUT' })), ms); t.unref?.(); })]);
async function resultFiles(sys, dirs, now) {
  const state = { dirs: [], recent: [], entries: 0, truncated: false, t0: sys.clock() };
  const scan = scanDirs(sys, dirs, state);
  // 硬上限：到点不再等，把已经扫到的交出去（扫描本身会在下一个条目处看到超时自行停下）
  let hard = false;
  await Promise.race([scan, new Promise(r => { const t = setTimeout(() => { hard = true; r(); }, SCAN_HARD_MS); t.unref?.(); })]);
  if (hard) { state.truncated = true; state.stopped = true; }
  return { dirs: state.dirs.map(d => ({ ...d })), recent: state.recent.map(f => ({ ...f, ageMin: Math.max(0, Math.round((now - f.mtime) / 60000)) })),
    scanned: state.entries, truncated: state.truncated, ...(hard ? { note: `扫描超过 ${SCAN_HARD_MS / 1000} 秒，先交已扫到的` } : {}), scanMs: sys.clock() - state.t0 };
}
async function scanDirs(sys, dirs, state) {
  const over = () => state.stopped || sys.clock() - state.t0 > SCAN_BUDGET_MS || state.entries > SCAN_MAX_ENTRIES;
  const keep = file => {
    state.recent.push(file); state.recent.sort((a, b) => b.mtime - a.mtime);
    if (state.recent.length > RECENT_FILES) state.recent.length = RECENT_FILES;
  };
  for (const root of dirs) {
    if (over()) { state.truncated = true; break; }
    const info = { dir: root, files: 0 };
    state.dirs.push(info);
    try { const st = await within(sys.stat(root), SCAN_OP_MS, '读目录信息'); if (!st.isDirectory()) { info.error = '不是目录'; continue; } }
    catch (error) { info.error = error.code === 'ENOENT' ? '目录不存在' : errText(error); continue; }
    const queue = [{ dir: root, depth: 0 }];
    while (queue.length) {
      if (over()) { state.truncated = true; info.truncated = true; break; }
      const { dir, depth } = queue.shift();
      let list;
      try { list = await within(sys.readdir(dir), SCAN_OP_MS, '列目录'); } catch { continue; }
      for (const e of list) {
        if (over()) { state.truncated = true; info.truncated = true; queue.length = 0; break; }
        state.entries += 1;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) { if (depth < SCAN_MAX_DEPTH && !SKIP_DIRS.has(e.name.toLowerCase())) queue.push({ dir: full, depth: depth + 1 }); continue; }
        if (!e.isFile() || !RESULT_EXT.test(e.name)) continue;
        try {
          const st = await within(sys.stat(full), SCAN_OP_MS, '读文件信息');
          info.files += 1;
          keep({ dir: root, rel: path.relative(root, full).split(path.sep).join('/'), sizeKB: Math.round(st.size / 1024), mtime: Math.round(st.mtimeMs) });
        } catch { /* 读不到就跳过 */ }
      }
    }
  }
}

// ---- features：论坛、简报、手机对话、桌宠形象下载 ----
// main 给原始状态（deps.featureStatus），这里只挑字段（白名单），不带正文、会话内容、账号。
function features(deps) {
  if (!deps.featureStatus) throw new Error('这台 Hub 没接功能状态');
  const raw = deps.featureStatus() || {};
  const out = {};
  const f = raw.forum;
  if (f === null) out.forum = { enabled: false, note: '这台 Hub 没启用论坛' };
  else if (f && f.error) out.forum = { error: short(f.error, 160) };
  else if (f) {
    const snap = f.snapshot || null, sites = (snap?.sites || []).map(x => ({ name: String(x.name || x.id || ''), ok: !!x.ok, needsLogin: !!x.needsLogin, error: x.error ? short(x.error, 160) : '' }));
    out.forum = { enabled: f.settings?.enabled !== false, lastAttemptAt: snap?.at || null, lastSuccessAt: sites.some(x => x.ok) ? snap.at : null, today: !!f.today, syncing: !!f.syncing, nextSyncAt: f.nextSyncAt || null,
      lastError: sites.filter(x => !x.ok).map(x => `${x.name}：${x.needsLogin ? '需要登录' : x.error || '没取到'}`).join('；') || null, sites };
  }
  const a = raw.assistant;
  if (a === null) out.brief = out.phone = { enabled: false, note: '这台 Hub 没启用助理' };
  else if (a && a.error) out.brief = out.phone = { error: short(a.error, 160) };
  else if (a) {
    const b = a.brief || null;
    const failed = b && (b.by === 'none' || /没完成|读不出来/.test(String(b.note || '')));
    out.brief = { enabled: a.enabled !== false, login: a.login ? { ok: !!a.login.ok, reason: a.login.reason || null } : null, dataRefreshedAt: a.refreshedAt || null,
      dataErrors: (a.errors || []).slice(0, 5).map(e => short(typeof e === 'string' ? e : e?.message || e?.error || JSON.stringify(e), 160)),
      today: b ? { generatedAt: b.generatedAt || null, total: Number(b.total) || 0, organizing: !!b.organizing } : null,
      lastSuccessAt: b && !failed && b.total ? b.generatedAt || null : null, lastError: failed ? short(b.note, 160) : null };
    const ph = a.phone || {};
    out.phone = { active: !!ph.active, lastPollAt: ph.lastPollAt || null, lastSuccessAt: ph.lastOkAt || null, lastError: ph.lastError ? short(ph.lastError, 160) : null };
  }
  const pet = raw.pet;
  if (pet === null) out.pet = { note: '桌宠没启动' };
  else if (pet && pet.error) out.pet = { error: short(pet.error, 160) };
  else if (pet) {
    const st = pet.state || {};
    out.pet = { phase: st.phase || null, lastError: st.error ? short(st.error, 160) : null, failedRole: st.failedId || null,
      downloaded: (pet.roles || []).filter(r => r.installed && !r.bundled).map(r => ({ id: r.id, name: r.name, version: r.version })).slice(0, 20),
      lastSuccessAt: pet.lastSuccessAt || null };
  }
  return out;
}

// 进程分类的参数：直查和远程维护（remote-act.js kill-orphans 动手前重新判定）用同一套。
function analyzeOptions(bridge, sys, ptyPids = null) {
  const deps = bridge.deps;
  const pids = ptyPids || (() => { try { return (deps.sessionPtyPids?.() || []).filter(x => x && x.id && Number(x.pid) > 0); } catch { return []; } })();
  const minAge = Number(deps.leftoverMinAgeMs);
  // CodeAgent 安装目录：配置的命令是绝对路径时取它所在目录（认 node 入口脚本用）
  let codeagentDirs = [];
  try { const cmd = deps.codeagentCommand ? deps.codeagentCommand() : ''; if (cmd && path.win32.isAbsolute(cmd)) codeagentDirs = [path.win32.dirname(cmd)]; } catch { codeagentDirs = []; }
  return { hubPid: Number(deps.hubPid) || process.pid, hubExe: path.basename(String(deps.hubExecPath || process.execPath)), sessionPids: pids, now: bridge.now(), isHubAppDir: sys.isHubAppDir, codeagentDirs,
    ...(deps.leftoverMinAgeMs != null && Number.isFinite(minAge) && minAge >= 0 ? { suspectMinAgeMs: minAge, killMinAgeMs: minAge } : {}) };
}

// ---- 汇总 ----
async function collect({ bridge, deps = bridge.deps, sections, lines = DEFAULT_LOG_LINES, errorsLimit = DEFAULT_ERRORS, sys = { ...defaultSys(), ...(deps.diagSys || {}) } }) {
  const t0 = sys.clock();
  const hubPid = Number(deps.hubPid) || process.pid;
  const ctx = { hubPid, hubStartedAt: Number(deps.hubStartedAt) || Math.round(Date.now() - process.uptime() * 1000) };
  const ptyPids = (() => { try { return (deps.sessionPtyPids?.() || []).filter(x => x && x.id && Number(x.pid) > 0); } catch { return []; } })();
  ctx.ptyPids = new Map(ptyPids.map(x => [x.id, Number(x.pid)]));
  let poolRaw = null, poolError = null;
  if (sections.includes('pool') || sections.includes('hub') || sections.includes('codeagent') || sections.includes('errors')) { try { poolRaw = deps.poolDiag ? deps.poolDiag() : null; } catch (error) { poolError = error; } }
  ctx.aliases = poolAliases(poolRaw, deps.dataDir || null);
  const out = { schema: 1, sections, at: bridge.now(), timings: {} };
  const run = async (name, fn) => {
    const s = sys.clock();
    try { out[name] = await fn(); } catch (error) { out[name] = { error: errText(error) }; }
    out.timings[name] = sys.clock() - s;
  };
  // 进程先采：hub 段要用会话的 PID 与内存
  const jobs = [];
  if (sections.includes('machine')) jobs.push(run('machine', () => machine(sys)));
  // CodeAgent 段（跑 --version、读会话屏幕）不依赖进程枚举：和它并行，省一两秒
  if (sections.includes('codeagent')) jobs.push(run('codeagent', () => codeagent(bridge, deps, sys, ctx, poolRaw, poolError)));
  if (sections.includes('airview')) jobs.push(run('airviewFiles', () => resultFiles(sys, resultDirsOf(bridge), bridge.now())));
  if (sections.includes('processes') || sections.includes('hub') || sections.includes('airview')) {
    jobs.push((async () => {
      const s = sys.clock();
      let analyzed = null, error = null;
      try {
        const snap = await Promise.race([sys.processSnapshot(), new Promise((_, reject) => setTimeout(() => reject(new Error(`进程枚举超过 ${PROCESS_TIMEOUT_MS / 1000} 秒没返回`)), PROCESS_TIMEOUT_MS + 1000).unref?.())]);
        analyzed = analyzeProcesses(snap, analyzeOptions(bridge, sys, ptyPids));
      } catch (e) { error = e; }
      if (analyzed) { ctx.sessionMem = analyzed.sessions; ctx.analyzed = analyzed; }
      if (error) ctx.processError = errText(error);
      if (sections.includes('processes')) {
        if (analyzed) { const { sessions: _s, protectedPids: _p, internal: _i, ...rest } = analyzed; out.processes = rest; } else out.processes = { error: errText(error) };
        out.timings.processes = sys.clock() - s;
      }
    })());
  }
  await Promise.all(jobs);
  if (sections.includes('hub')) await run('hub', () => { const h = hub(bridge, deps, sys, ctx); if (ctx.processError) h.processNote = '会话内存没算出来：' + ctx.processError; return h; });
  if (sections.includes('pool')) await run('pool', () => {
    if (poolError) throw poolError;
    let avoid = {}, credit = {};
    try { avoid = bridge.avoidViewMap ? bridge.avoidViewMap() : bridge.avoidMap ? bridge.avoidMap() : {}; credit = require('../codeagent-quota').creditReadings(deps.dataDir); } catch { /* 读不到避让状态不挡号池段 */ }
    // 个人账号实际作答过的模型（set-personal-model 的另一条权限依据）
    let raw = poolRaw;
    if (raw && raw.personal && bridge.personalAnsweredModels) { try { raw = { ...raw, personal: { ...raw.personal, answeredModels: bridge.personalAnsweredModels() } }; } catch { /* 读不到就不带 */ } }
    let pickBreaker = {};
    try { pickBreaker = require('../codeagent-auto-pick').snapshot(deps.dataDir); } catch { /* 读不到不挡号池段 */ }
    return pool(raw, { usePool: !!bridge.settings().usePool, models: bridge.modelTableSafe?.() || null, avoid, credit, aliases: ctx.aliases, pickBreaker });
  });
  if (sections.includes('errors')) await run('errors', () => errorsSection(bridge, ctx.aliases, errorsLimit));
  if (sections.includes('logs')) await run('logs', () => logs(sys, path.join(deps.dataDir, 'logs'), lines));
  if (sections.includes('airview')) {
    const files = out.airviewFiles; delete out.airviewFiles;
    const t1 = out.timings.airviewFiles || 0; delete out.timings.airviewFiles;
    await run('airview', () => ({ processes: ctx.analyzed ? airviewProcesses(ctx.analyzed) : { error: ctx.processError || '进程没采到' }, ...(files && files.error ? { filesError: files.error } : files) }));
    out.timings.airview = (out.timings.airview || 0) + t1;
  }
  if (sections.includes('features')) await run('features', () => features(deps));
  out.elapsedMs = sys.clock() - t0;
  return out;
}

// ---- 一句话摘要（老版本对端只看得到它；新版对端放在卡片顶上）----
function summarize(d) {
  const parts = [];
  const m = d.machine;
  if (m && !m.error) parts.push(`内存可用 ${m.memory.freePct}%（${gb(m.memory.freeMB * 1048576)}/${gb(m.memory.totalMB * 1048576)} GB）`);
  const p = d.processes;
  if (p && !p.error && p.summary) {
    parts.push(`CodeAgent ${p.summary.codeAgent.count} 个共 ${gb(p.summary.codeAgent.memMB * 1048576)} GB`);
    parts.push(`Hub 自身 ${gb(p.summary.hubSelf.memMB * 1048576)} GB`);
    if (p.summary.leftovers.count) parts.push(`残留嫌疑 ${p.summary.leftovers.count} 个（${gb(p.summary.leftovers.memMB * 1048576)} GB${p.summary.leftovers.killable ? `，其中可结束 ${p.summary.leftovers.killable} 个` : ''}）`);
  }
  const h = d.hub;
  if (h && !h.error) {
    const par = h.parallel;
    parts.push(`通道 ${h.queue.running} 个在跑、${h.queue.queued} 个排队${par ? `（上限 ${par.cap}，受${par.limitedBy}限制）${par.sessionGB ? `，内存按每个会话 ${par.sessionGB} GB 估算（${par.sessionMemSource === 'measured' ? `实测 ${par.sessionMemSamples} 个会话的平均` : '默认值'}）` : ''}` : ''}`);
  }
  const c = d.codeagent;
  if (c && !c.error) parts.push(`CodeAgent ${c.version ? 'v' + c.version : '版本没读到'}${(c.quota || []).length ? ' · 额度 ' + c.quota.map(q => `${q.account} ${q.pct}%`).join('、') : ''}${(c.nativeMcp?.accounts || []).length ? ' · ' + c.nativeMcp.accounts.map(a => `${a.account}${a.text}`).join('；') : ''}`);
  if (c && c.personal && c.personal.inPool) parts.push(`个人配置目录和${c.personal.inPoolAlias || '号池'}的目录重叠`);
  if (c?.personal?.inheritedAuthToken?.present) parts.push('Hub 继承了认证令牌；新会话优先使用完整且可登录的账号凭证');
  if (c && c.personal && c.personal.inheritedConfigDir) parts.push(c.personal.inheritedConfigDir.note + (c.personal.inheritedConfigDir.inPool ? `（它指向${c.personal.inheritedConfigDir.inPoolAlias || '号池'}的目录）` : ''));
  const avoiding = (d.pool && Array.isArray(d.pool.accounts) ? d.pool.accounts.filter(a => a.avoid).map(a => a.alias) : (c && c.avoid || []).map(a => a.account));
  if (avoiding.length) parts.push(`避让中：${avoiding.join('、')}`);
  const e = d.errors;
  if (e && !e.error && Array.isArray(e.list)) parts.push(`最近 API 报错 ${e.list.length} 条（命中规则 ${e.list.filter(x => x.matched).length} 条）`);
  const failed = SECTIONS.filter(s => d[s] && d[s].error);
  if (failed.length) parts.push(`没采到：${failed.map(s => SECTION_LABEL[s]).join('、')}`);
  if (d.degraded?.length) parts.push('超长已精简：' + d.degraded[d.degraded.length - 1]);
  parts.push(`采集 ${(d.elapsedMs / 1000).toFixed(1)} 秒`);
  return '这台电脑的状态：' + parts.join(' · ');
}

// ---- 塞进一条消息：先截日志，再把进程截到前 10，再精简会话列表……始终能发出去 ----
const STEPS = [
  ['日志每份截到 40 行', d => { if (d.logs?.files) for (const f of d.logs.files) if (f.lines) f.lines = f.lines.slice(-40); }],
  ['日志每份截到 15 行', d => { if (d.logs?.files) for (const f of d.logs.files) if (f.lines) f.lines = f.lines.slice(-15); }],
  ['API 报错只留最近 10 条', d => { if (d.errors?.list) d.errors.list = d.errors.list.slice(0, 10); }],
  ['进程只留前 10，残留嫌疑只留前 15', d => { if (d.processes?.top) d.processes.top = d.processes.top.slice(0, 10); if (d.processes?.leftovers) d.processes.leftovers = d.processes.leftovers.slice(0, 15); }],
  ['日志省略', d => { if (d.logs?.files) d.logs = { omitted: true, note: '回报超过单条消息上限，日志省略；可以只查 logs 段', files: d.logs.files.map(f => ({ key: f.key, label: f.label, file: f.file, sizeKB: f.sizeKB, mtime: f.mtime })) }; }],
  ['会话列表只留 20 个', d => { if (d.hub?.sessions?.list) d.hub.sessions.list = d.hub.sessions.list.slice(0, 20); }],
  ['进程只留前 5，残留嫌疑只留前 5，会话列表省略', d => {
    if (d.processes?.top) d.processes.top = d.processes.top.slice(0, 5);
    if (d.processes?.leftovers) d.processes.leftovers = d.processes.leftovers.slice(0, 5);
    if (d.hub?.sessions?.list) d.hub.sessions.list = [];
  }],
  ['只留各段汇总', d => {
    if (d.processes && !d.processes.error) { delete d.processes.top; delete d.processes.leftovers; delete d.processes.otherHubs; }
    if (d.hub?.queue?.threads) d.hub.queue.threads = d.hub.queue.threads.slice(0, 10).map(q => ({ thread: q.thread, phase: q.phase, round: q.round, queueNote: q.queueNote }));
    if (d.pool?.accounts) d.pool.accounts = d.pool.accounts.map(a => ({ alias: a.alias, state: a.state, activeSessions: a.activeSessions, ...(a.avoid ? { avoid: { label: a.avoid.label, until: a.avoid.until, source: a.avoid.source } } : {}) }));
    if (d.errors?.list) d.errors.list = d.errors.list.slice(0, 3);
    if (d.pool) delete d.pool.models;
    if (d.airview?.recent) d.airview.recent = d.airview.recent.slice(0, 10);
    if (d.airview?.dirs) d.airview.dirs = d.airview.dirs.map(x => ({ dir: x.dir, files: x.files, error: x.error }));
  }],
];
// measure(encoded) → 整条消息的字节数。返回 { data(编码后), result, degraded, bytes }。
function fit(result, measure, limit = MESSAGE_LIMIT - MESSAGE_MARGIN) {
  const d = JSON.parse(JSON.stringify(result));
  d.degraded = [];
  let data = encode(d), bytes = measure(data);
  for (const [label, step] of STEPS) {
    if (bytes < limit) break;
    step(d); d.degraded.push(label);
    data = encode(d); bytes = measure(data);
  }
  if (bytes >= limit) {
    const tiny = { schema: 1, sections: d.sections, at: d.at, elapsedMs: d.elapsedMs, degraded: [...d.degraded, '全部省略'], note: '回报仍超过单条消息上限，只留摘要；请少选几段再查', summary: summarize(d) };
    data = encode(tiny); bytes = measure(data);
    return { data, result: tiny, degraded: tiny.degraded, bytes };
  }
  return { data, result: d, degraded: d.degraded, bytes };
}

const STEP_LABELS = STEPS.map(s => s[0]);
module.exports = {
  STEP_LABELS, analyzeOptions, cmdTokens, entryScript, isCodeAgentProc, isHubScript, SUSPECT_MIN_AGE_MS,
  SECTIONS, SECTION_LABEL, MIN_INTERVAL_MS, MESSAGE_LIMIT, PROCESS_TIMEOUT_MS, DEFAULT_LOG_LINES, MAX_LOG_LINES, LOGS,
  parseSections, parseLines, parseErrorsLimit, errorsSection, DEFAULT_ERRORS, MAX_ERRORS, encode, decode, makeRedactor, deepRedact, analyzeProcesses, poolAliases, pool, machine, logs, hub, collect, summarize, fit, defaultSys,
};
