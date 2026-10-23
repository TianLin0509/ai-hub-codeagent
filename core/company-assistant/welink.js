'use strict';
// 公司版助理的 WeLink 取数层（2026-10-16 用户定：只读；数据只留在公司电脑）。
// 依据公司真机 welink-cli 1.0.14 的命令树（Q-1016-19）：Hub 只调用下面白名单里的查询类子命令，
// 发消息、回邮件、建会议、建日程、云盘增删改一律拦住——不靠说明，靠这里的白名单。
// 唯一的例外是手机对话往用户选定的那个群发文字（sendAllowed），只有 Hub 主进程能用。
// 同一份白名单也给 CodeAgent 用的只读包装脚本（welink-ro.js），它在助理会话里只能通过包装脚本调 welink-cli。
const fs = require('node:fs');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');

const READ_ONLY = Object.freeze({
  im: ['query-recent-conversation', 'query-history-message', 'query-group-member'],
  meeting: ['list', 'query-list', 'info', 'topic', 'topic-materials', 'fuzzy-search'],
  calendar: ['list', 'get'],
  mail: ['folders', 'list', 'get'],
  search: ['person', 'group'],
  contact: ['detail', 'favorite_list'],
  onebox: ['user-info', 'folder-list', 'file-info', 'node-search'],
  auth: ['status'],
  version: [''],
});
// Hub 可自动维护登录、初始化日历；会话只读包装不开放这两条。
const SETUP = Object.freeze({ auth: ['login'], mail: ['autodiscover'] });

// 唯一放行的写命令（2026-10-18 用户同意）：手机对话往他自己选定的那个群发文字（phone.js）。
// 只有 Hub 主进程传 sendGroup（设置里选定的群号）时才放行，而且群号必须一字不差；助理会话用的 welink-ro 永远不传。
function sendAllowed(list, sendGroup) {
  if (!sendGroup || list[0] !== 'im' || list[1] !== 'send-to-group' || list.length !== 6) return false;
  const opt = name => { const i = list.indexOf(name); return i >= 2 && i % 2 === 0 ? list[i + 1] : undefined; };
  return opt('--group-id') === String(sendGroup) && typeof opt('--text') === 'string' && opt('--text').trim() !== '';
}

function checkArgs(args, { allowSetup = false, sendGroup = '' } = {}) {
  const list = Array.isArray(args) ? args.map(String) : [];
  const [group, sub = ''] = list;
  if (sendAllowed(list, sendGroup)) return list; // 发出的文字可以有换行
  const ok = (READ_ONLY[group] || []).includes(group === 'version' ? '' : sub)
    || (allowSetup && (SETUP[group] || []).includes(sub));
  if (!ok) throw Object.assign(new Error(`助理只能用 welink-cli 的查询命令，拒绝执行：${[group, sub].filter(Boolean).join(' ') || '（空）'}`), { code: 'WELINK_NOT_ALLOWED' });
  if (list.some(a => /[\r\n]/.test(a))) throw Object.assign(new Error('welink-cli 参数里不能有换行'), { code: 'WELINK_BAD_ARG' });
  return list;
}

// 找 welink-cli（2026-10-19 扩大范围：用户在一台新电脑上装了，Hub 却说没找到——每个人的 npm 全局目录不一样，
// 有人改到 D:\nodejs\node_global，有人用 nvm；装完没重启 Hub 时，Hub 的 PATH 也还是旧的）。
// 快速查找（同步、只看文件在不在）：环境变量（测试用假程序）→ 设置里记住的路径 → 各个 npm 全局目录 → where。
// 还找不到就交给 findCliDeep 在后台全盘找，找到后记进设置，下次直接用。
const PKG_EXE = ['node_modules', '@welink', 'welink-cli', 'welink-cli.exe'];
function cliUnder(dir, fsModule = fs) {
  if (!dir) return null;
  for (const p of [path.join(dir, ...PKG_EXE), path.join(dir, 'welink-cli.exe')]) { try { if (fsModule.existsSync(p)) return p; } catch { /* 读不了就跳过 */ } }
  return null;
}
// npm 全局目录的候选：npm 配置文件里的 prefix、环境变量、nvm / pnpm / volta 的常见位置。
function npmPrefixes(env = process.env, fsModule = fs) {
  const out = [];
  const add = p => { if (p && !out.includes(p)) out.push(p); };
  const expand = v => String(v).trim().replace(/^["']|["']$/g, '').replace(/\$\{([^}]+)\}|%([^%]+)%/g, (_, a, b) => env[a || b] || '');
  add(env.npm_config_prefix || env.NPM_CONFIG_PREFIX);
  for (const rc of [env.USERPROFILE && path.join(env.USERPROFILE, '.npmrc'), env.APPDATA && path.join(env.APPDATA, 'npm', 'etc', 'npmrc')]) {
    if (!rc) continue;
    try { const m = /^\s*prefix\s*=\s*(.+?)\s*$/m.exec(fsModule.readFileSync(rc, 'utf8')); if (m) add(expand(m[1])); } catch { /* 没有这个文件 */ }
  }
  add(env.APPDATA && path.join(env.APPDATA, 'npm'));
  add(env.NVM_SYMLINK);
  add(env.ProgramFiles && path.join(env.ProgramFiles, 'nodejs'));
  add(env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'npm'));
  add(env.PNPM_HOME);
  add(env.VOLTA_HOME && path.join(env.VOLTA_HOME, 'bin'));
  return out;
}
// 快速查找没找到时，一分钟内不再跑 where（where 是同步的，会卡住主进程；状态每 20 秒查一次）。
let missCache = 0;
function resolveCli({ env = process.env, configured = '', fsModule = fs, now = Date.now } = {}) {
  const pick = [env.CLAUDE_HUB_WELINK_CLI, configured].find(p => p && fsModule.existsSync(p));
  if (pick) return pick;
  for (const dir of npmPrefixes(env, fsModule)) { const hit = cliUnder(dir, fsModule); if (hit) return hit; }
  const real = env === process.env && fsModule === fs;
  if (real && now() - missCache < 60000) return null;
  try {
    const found = execFileSync('where', ['welink-cli'], { encoding: 'utf8', windowsHide: true, timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'], env }).split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    for (const f of found) {
      const sibling = cliUnder(path.dirname(f), fsModule);
      if (sibling) return sibling;
      if (/\.exe$/i.test(f)) return f;
    }
  } catch { /* 没装，或不在 PATH 里 */ }
  if (real) missCache = now();
  return null;
}

// 全盘找（异步，后台跑，最多约 2 分钟）：
//   1) 注册表里最新的 PATH（装完 welink-cli 没重启 Hub 时，Hub 进程的 PATH 是旧的）；
//   2) npm config get prefix（用最新的 PATH 跑）；
//   3) 用户目录、各个硬盘里按文件名找 welink-cli.exe（限制深度，跳过 Windows 系统目录）。
function runText(file, args, { timeoutMs = 15000, env = process.env, execFileImpl = require('node:child_process').execFile } = {}) {
  return new Promise(resolve => {
    execFileImpl(file, args, { windowsHide: true, timeout: timeoutMs, encoding: 'utf8', env, maxBuffer: 1024 * 1024 }, (error, stdout) => resolve(error && !stdout ? '' : String(stdout || '')));
  });
}
async function findCliDeep({ env = process.env, fsModule = fs, execFileImpl, timeoutMs = 120000, onStage = () => {}, roots: rootsOverride = null } = {}) {
  const started = Date.now(), left = () => Math.max(5000, timeoutMs - (Date.now() - started));
  const expand = v => String(v).replace(/%([^%]+)%/g, (_, k) => env[k] || env[Object.keys(env).find(x => x.toLowerCase() === k.toLowerCase())] || '');
  onStage('path');
  const regPath = async key => { const t = await runText('reg.exe', ['query', key, '/v', 'Path'], { execFileImpl }); const m = /Path\s+REG_(?:EXPAND_)?SZ\s+(.+)/i.exec(t); return m ? expand(m[1].trim()) : ''; };
  const fresh = [await regPath('HKCU\\Environment'), await regPath('HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment')].filter(Boolean).join(';');
  for (const dir of fresh.split(';').map(s => s.trim()).filter(Boolean)) {
    const hit = cliUnder(dir, fsModule);
    if (hit) return { path: hit, via: 'path' };
    try { if (fsModule.existsSync(path.join(dir, 'welink-cli.cmd'))) { const sib = cliUnder(dir, fsModule); if (sib) return { path: sib, via: 'path' }; } } catch { /* 跳过 */ }
  }
  onStage('npm');
  const npmEnv = fresh ? { ...env, PATH: fresh + ';' + (env.PATH || env.Path || '') } : env;
  const prefix = (await runText('cmd.exe', ['/d', '/c', 'npm', 'config', 'get', 'prefix'], { env: npmEnv, timeoutMs: 20000, execFileImpl })).trim().split(/\r?\n/).pop();
  const viaNpm = prefix && cliUnder(prefix.trim(), fsModule);
  if (viaNpm) return { path: viaNpm, via: 'npm' };
  onStage('disk');
  const drives = 'CDEFGH'.split('').map(l => l + ':\\').filter(d => { try { return fsModule.existsSync(d); } catch { return false; } });
  const roots = rootsOverride || [[env.USERPROFILE, 8], ...drives.map(d => [d, 5])].filter(([r]) => r);
  for (const [root, depth] of roots) {
    if (Date.now() - started > timeoutMs) break;
    const script = `$ErrorActionPreference='SilentlyContinue'; Get-ChildItem -LiteralPath '${String(root).replace(/'/g, "''")}' -Directory -Force | Where-Object { $_.Name -notmatch '^(Windows|\$Recycle\.Bin|System Volume Information|ProgramData)$' } | ForEach-Object { Get-ChildItem -LiteralPath $_.FullName -Filter 'welink-cli.exe' -File -Recurse -Depth ${depth} -Force } | Select-Object -First 1 -ExpandProperty FullName`;
    const out = (await runText('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { timeoutMs: left(), execFileImpl })).trim().split(/\r?\n/)[0];
    if (out && fsModule.existsSync(out)) return { path: out, via: 'disk' };
  }
  return { path: null, via: null };
}

// 跑一条 welink-cli。.js 结尾的是测试用的假程序，用 Hub 自己的程序以 Node 方式运行。
// onData：边跑边拿到目前为止的全部输出（扫码登录要在命令结束前把二维码显示出来）。
function run(args, { cli, timeoutMs = 30000, allowSetup = false, sendGroup = '', env = process.env, spawnFn = spawn, onData = null, signal = null } = {}) {
  const list = checkArgs(args, { allowSetup, sendGroup });
  if (!cli) return Promise.reject(Object.assign(new Error('没找到 welink-cli：公司电脑上需先安装（npm 全局包 @welink/welink-cli）'), { code: 'WELINK_MISSING' }));
  const isScript = /\.(?:c?js)$/i.test(cli);
  const cmd = isScript ? process.execPath : cli;
  const argv = isScript ? [cli, ...list] : list;
  return new Promise((resolve, reject) => {
    let out = '', err = '', done = false, stopping = null, cleanupTimer = null;
    if (signal?.aborted) { reject(Object.assign(new Error('已停止这次 WeLink 登录'), { code: 'WELINK_ABORTED' })); return; }
    const child = spawnFn(cmd, argv, { windowsHide: true, env: { ...env, ...(isScript ? { ELECTRON_RUN_AS_NODE: '1' } : {}) } });
    const stop = error => {
      if (done || stopping) return; stopping = error; clearTimeout(timer); signal?.removeEventListener('abort', aborted);
      cleanupTimer = setTimeout(() => {
        if (done) return; done = true;
        reject(Object.assign(new Error(error.message + '；进程退出尚未确认，请稍后重试'), { code: 'WELINK_CLEANUP_TIMEOUT' }));
      }, 10000);
      // Only this invocation's child tree; never find/kill a process by name.
      if (process.platform === 'win32' && child.pid) {
        const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        killer.on('error', e => { console.warn('[welink] 结束登录进程树失败', e.message); child.kill(); });
        killer.on('close', code => { if (code && child.exitCode == null) { console.warn('[welink] 结束登录进程树返回', code); child.kill(); } });
      } else child.kill();
    };
    const aborted = () => stop(Object.assign(new Error('已停止这次 WeLink 登录'), { code: 'WELINK_ABORTED' }));
    const timer = setTimeout(() => stop(Object.assign(new Error(`welink-cli 超过 ${Math.round(timeoutMs / 1000)} 秒没返回：${list.slice(0, 2).join(' ')}`), { code: 'WELINK_TIMEOUT' })), timeoutMs);
    signal?.addEventListener('abort', aborted, { once: true });
    const tell = () => { if (onData) { try { onData(out + err); } catch { /* 显示失败不影响命令 */ } } };
    // 按 UTF-8 解码且跨数据块拼字（二维码的 █▀▄ 各占 3 个字节，按块各自转字符串会把切开的字变成乱码）。
    child.stdout?.setEncoding?.('utf8'); child.stderr?.setEncoding?.('utf8');
    child.stdout?.on('data', d => { out += d; tell(); });
    child.stderr?.on('data', d => { err += d; tell(); });
    child.on('error', e => { if (done) return; done = true; clearTimeout(timer); clearTimeout(cleanupTimer); signal?.removeEventListener('abort', aborted); reject(e); });
    child.on('close', code => { if (done) return; done = true; clearTimeout(timer); clearTimeout(cleanupTimer); signal?.removeEventListener('abort', aborted); if (stopping) reject(stopping); else resolve({ code, stdout: out, stderr: err }); });
  });
}

// 从输出里取 JSON（有的命令前后带提示文字）。取不到返回 null。
function parseJson(text) {
  const s = String(text || '').trim();
  if (!s) return null;
  try { return JSON.parse(s); } catch { /* 往下找 */ }
  const start = s.search(/[[{]/);
  if (start < 0) return null;
  for (let end = s.length; end > start; end -= 1) {
    const ch = s[end - 1];
    if (ch !== '}' && ch !== ']') continue;
    try { return JSON.parse(s.slice(start, end)); } catch { /* 再短一点 */ }
  }
  return null;
}

// 登录与日历状态：auth status 里 Token EXPIRED 或没登录 → 要扫码；日历报 Exchange 域名没找到 → 要初始化。
function loginState(statusText) {
  const s = String(statusText || '');
  const uid = (s.match(/UID\s*[:：]\s*([A-Za-z0-9_-]+)/i) || [])[1] || null;
  if (/EXPIRED|未登录|not\s+logged\s*in|no\s+token|\buser\s+token\s+not\s+found\b/i.test(s)) return { ok: false, reason: 'expired', uid };
  if (/Token\s*[:：]\s*(?:VALID|OK|有效)|已登录|logged\s*in/i.test(s) || uid) return { ok: true, uid };
  return { ok: false, reason: 'unknown', uid };
}
// 同 parseJson，但先把长整数的消息编号改成字符串（JSON.parse 会把它们舍入成同一个数，相邻两条消息就分不清了）。
function parseJsonBig(text) {
  return parseJson(String(text || '').replace(/("(?:msgId|msg_id|messageId|message_id|maxMsgId|minMsgId|meetingId)"\s*:\s*)(\d{15,})/g, '$1"$2"'));
}
// 群的历史消息（im query-history-message）。字段依据公司真机回执 Q-1018-04：msgId（整型）、sender（账号）、content、contentType、serverSendTime。
// msgId 是很长的整数，JSON.parse 会丢精度（游标就对不上了）：先把它们改成字符串再解析，比较大小用 BigInt。
function groupMessages(text) {
  const data = parseJson(String(text || '').replace(/("(?:msgId|msg_id|messageId)"\s*:\s*)(\d{15,})/g, '$1"$2"'));
  if (data == null) return null;
  const found = [];
  const walk = (v, depth) => {
    if (depth > 5 || !v || typeof v !== 'object') return;
    if (Array.isArray(v)) { for (const x of v) { if (x && typeof x === 'object' && (x.msgId != null || x.msg_id != null)) found.push(x); else walk(x, depth + 1); } return; }
    for (const x of Object.values(v)) walk(x, depth + 1);
  };
  walk(data, 0);
  const big = v => { try { return /^\d+$/.test(String(v)) ? BigInt(String(v)) : null; } catch { return null; } };
  return found.map(m => {
    const id = String(m.msgId ?? m.msg_id);
    const rawAt = m.serverSendTime ?? m.server_send_time ?? m.sendTime ?? m.send_time;
    const at = rawAt == null || rawAt === '' ? NaN : Number(rawAt) < 1e11 ? Number(rawAt) * 1000 : Number(rawAt);
    let content = m.content ?? m.msgContent ?? m.text ?? '';
    if (content && typeof content === 'object') content = content.text ?? content.content ?? '';
    return { id, n: big(id), sender: String(m.sender ?? m.sender_account ?? m.senderAccount ?? ''), type: String(m.contentType ?? m.content_type ?? ''),
      at: Number.isFinite(at) ? at : null, text: String(content || '') };
  }).filter(m => m.n !== null).sort((a, b) => (a.n < b.n ? -1 : a.n > b.n ? 1 : 0));
}
// 群成员（im query-group-member）：只取账号和显示名，给「手机」设置页核对群里是不是只剩自己和小微助手。
function groupMembers(text) {
  const data = parseJson(text);
  let list = [];
  const walk = (v, depth) => {
    if (list.length || depth > 5 || !v || typeof v !== 'object') return;
    if (Array.isArray(v) && v.some(x => x && typeof x === 'object' && !Array.isArray(x))) { list = v.filter(x => x && typeof x === 'object'); return; }
    for (const x of Object.values(v)) walk(x, depth + 1);
  };
  walk(data, 0);
  const pick = (m, keys) => { for (const k of keys) if (m[k] != null && m[k] !== '') return String(m[k]); return ''; };
  return list.map(m => ({ account: pick(m, ['account', 'userAccount', 'user_account', 'memberAccount', 'staffAccount', 'w3Account']),
    name: pick(m, ['name', 'staffName', 'staff_name', 'nativeName', 'native_name', 'nickName', 'userName', 'account']) }));
}
const calendarNeedsSetup =text => /Exchange server domain not found|mail autodiscover/i.test(String(text || ''));

// ---- 扫码登录的二维码（2026-10-22 v3.1.1，依据公司回执 Q-1021-14：welink-cli 1.0.14 反汇编）----
// 真机 auth login 不出图片、不出 base64，而是在 stdout 上用 Unicode 半块字符画二维码，外面套一个 +---+ / | | 的框；
// 每个字符 = 1 列 × 2 行模块：█ 上下都黑，▀ 只有上黑，▄ 只有下黑，空格都白。框后面那个网址是登录网页，不是图片。
const QR_CELL = Object.freeze({ ' ': [0, 0], '█': [1, 1], '▀': [1, 0], '▄': [0, 1] });
const QR_MIN = 21; // 最小的二维码（版本 1）是 21×21 模块
// 最后一个完整的框（两条等长的 +---+ 之间全是等宽的 |…| 行）。二维码刷新时一次输出里会有多个框，以最后一个为准；
// 流式输出里框只到一半时不算。行内（包括行尾）的空格原样保留：它们是白模块。
function lastQrBox(text) {
  let box = null, last = null;
  for (const line of String(text || '').split(/\r\n|\n|\r/)) {
    const border = /^\s*\+(-+)\+\s*$/.exec(line);
    if (border) {
      if (box && box.rows.length && border[1].length === box.width) { last = box; box = null; } else box = { width: border[1].length, rows: [] };
      continue;
    }
    if (!box) continue;
    const row = /^\s*\|(.*)\|\s*$/.exec(line);
    if (!row || row[1].length !== box.width) { box = null; continue; }
    box.rows.push(row[1]);
  }
  return last;
}
// 字符画 → 布尔矩阵（true=黑）。只有矩阵完整、每个字符都认得时才返回，否则 null。
// 奇数行的二维码最后一行字符只用 ▀：多出来的那半行全白，去掉它让矩阵回到正方形。
function qrMatrixFromBlocks(text) {
  const box = lastQrBox(text);
  if (!box) return null;
  const top = [], bottom = [];
  for (const line of box.rows) {
    const t = [], b = [];
    for (const ch of line) { const cell = QR_CELL[ch]; if (!cell) return null; t.push(!!cell[0]); b.push(!!cell[1]); }
    top.push(t); bottom.push(b);
  }
  const matrix = [];
  top.forEach((t, i) => { matrix.push(t, bottom[i]); });
  const width = box.width;
  if (!bottom[bottom.length - 1].some(Boolean) && matrix.length !== width) matrix.pop();
  if (width < QR_MIN || matrix.length < QR_MIN || matrix.some(r => r.length !== width)) return null;
  return matrix;
}
// 布尔矩阵 → 半块字符画（与上面的解析互逆；测试和 welink-cli 替身用它按真机格式出图）。
function qrBlocksFromMatrix(matrix) {
  const width = matrix[0].length, lines = [];
  for (let y = 0; y < matrix.length; y += 2) {
    let s = '';
    for (let x = 0; x < width; x += 1) { const t = !!matrix[y][x], b = !!(matrix[y + 1] && matrix[y + 1][x]); s += t && b ? '█' : t ? '▀' : b ? '▄' : ' '; }
    lines.push('|' + s + '|');
  }
  const border = '+' + '-'.repeat(width) + '+';
  return [border, ...lines, border].join('\n');
}
// 在主进程里把矩阵画成 SVG，交给页面的是 data: 地址（页面 CSP 只放行 'self' file: data: 图片，不用改 CSP，也不引入二维码库）。
// 黑 #000、白底、四周留 4 个模块的静区（扫码需要），每个模块 7px，crispEdges 保证边缘不糊。
function qrSvgDataUri(matrix, { cell = 7, margin = 4 } = {}) {
  const width = matrix[0].length, height = matrix.length, W = (width + margin * 2) * cell, H = (height + margin * 2) * cell;
  let d = '';
  matrix.forEach((row, y) => {
    for (let x = 0; x < width;) {
      if (!row[x]) { x += 1; continue; }
      let end = x; while (end < width && row[end]) end += 1;
      d += `M${(x + margin) * cell} ${(y + margin) * cell}h${(end - x) * cell}v${cell}h-${(end - x) * cell}z`;
      x = end;
    }
  });
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" shape-rendering="crispEdges"><rect width="${W}" height="${H}" fill="#fff"/><path fill="#000" d="${d}"/></svg>`;
  return { value: 'data:image/svg+xml;base64,' + Buffer.from(svg, 'utf8').toString('base64'), px: W, modules: width };
}
// 输出里有完整的框，却一个 █▀▄ 都没有（或带 U+FFFD 替换符）：多半是编码不对。只报告，不猜着换 GBK。
function loginOutputGarbled(text) {
  const s = String(text || '');
  if (/[█▀▄]/.test(s)) return false;
  return s.includes('\uFFFD') || !!lastQrBox(s)?.rows.some(r => /\S/.test(r));
}
// 「If QR code is not displayed correctly, open this URL to scan:」后面那个登录网页（只认 https），作兜底链接，不当图片。
function loginUrlFromOutput(text) {
  const s = String(text || '');
  const after = /open\s+this\s+url[^\r\n]*[\r\n]+\s*(https:\/\/[^\s"<>]+)/i.exec(s);
  if (after) return after[1];
  const any = s.match(/https:\/\/[^\s"<>]+/g);
  return any ? any[any.length - 1] : null;
}
// 登录进度（显示用）：Waiting for scan... (elapsed N seconds) → 等待扫码；Scan successful → 已扫码；timeout/failed → 失败及原因。
function loginProgress(text) {
  const lines = String(text || '').split(/\r\n|\n|\r/).map(l => l.trim()).filter(Boolean);
  let phase = null, elapsed = null, reason = '';
  for (const line of lines) {
    if (/^https?:\/\//i.test(line) || /not\s+displayed\s+correctly/i.test(line)) continue;
    const wait = /Waiting\s+for\s+scan/i.test(line);
    if (/Scan\s+successful/i.test(line)) { phase = 'scanned'; reason = ''; } else if (/time[d\s-]*out|expired|fail|error|超时|失败|过期/i.test(line)) { phase = 'failed'; reason = line.slice(0, 200); } else if (wait) {
      phase = 'waiting'; reason = '';
      const n = /elapsed\s+(\d+)\s*s/i.exec(line); elapsed = n ? Number(n[1]) : elapsed ?? 0;
    } else if (!phase && /Obtaining\s+QR\s+code/i.test(line)) phase = 'obtaining';
  }
  return phase ? { phase, elapsed, reason } : null;
}

// auth login 的二维码：半块字符画（真机格式，优先）→ data URI → 图片路径 → 网址。
// kind:'url' 只说明输出里有登录网页；它不是图片，页面不会放进 <img>，扫码面板只把它当「在浏览器打开」的兜底链接。
function qrFromLoginOutput(text) {
  const s = String(text || '');
  const matrix = qrMatrixFromBlocks(s);
  if (matrix) { const svg = qrSvgDataUri(matrix); return { kind: 'blocks', value: svg.value, px: svg.px, modules: svg.modules }; }
  const dataUri = s.match(/data:image\/(?:png|jpe?g|svg\+xml);base64,[A-Za-z0-9+/=]+/);
  if (dataUri) return { kind: 'data', value: dataUri[0] };
  const file = s.match(/[A-Za-z]:\\[^\r\n"<>|]*?\.(?:png|jpe?g|bmp|svg)/i) || s.match(/\/[^\s"<>|]+\.(?:png|jpe?g|svg)/i);
  if (file) return { kind: 'file', value: file[0] };
  const url = s.match(/https?:\/\/[^\s"<>]+/);
  if (url) return { kind: 'url', value: url[0] };
  return null;
}
// 登录输出是否在要人扫码：手动扫码面板和自动续期（auth-keeper）共用这一个判断。
// 认二维码本身（字符画、图片、网址），也认真机这几行固定文字——框还没画完时就能停下自动续期。
const SCAN_PROMPT = /请.{0,12}扫码|二维码|scan\s+(?:the\s+)?qr|qr\s*code|Please\s+scan|Waiting\s+for\s+scan|WeLink\s+QR\s+Code\s+Login/i;
function loginNeedsScan(text) {
  const s = String(text || '');
  return !!qrFromLoginOutput(s) || SCAN_PROMPT.test(s) || /^\s*\+-{21,}\+\s*$/m.test(s);
}

module.exports = { READ_ONLY, SETUP, checkArgs, resolveCli, findCliDeep, npmPrefixes, cliUnder, run, parseJson, parseJsonBig, groupMessages, groupMembers, loginState, calendarNeedsSetup,
  qrFromLoginOutput, qrMatrixFromBlocks, qrBlocksFromMatrix, qrSvgDataUri, loginOutputGarbled, loginUrlFromOutput, loginProgress, loginNeedsScan };
