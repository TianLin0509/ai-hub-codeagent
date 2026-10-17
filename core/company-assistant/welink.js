'use strict';
// 公司版助理的 WeLink 取数层（2026-10-16 用户定：只读；数据只留在公司电脑）。
// 依据公司真机 welink-cli 1.0.14 的命令树（Q-1016-19）：Hub 只调用下面白名单里的查询类子命令，
// 发消息、回邮件、建会议、建日程、云盘增删改一律拦住——不靠说明，靠这里的白名单。
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
// 只有用户在助理页上点按钮才会跑的两条：扫码登录、日历初始化（mail autodiscover 只写 welink-cli 自己的本地配置）。
const SETUP = Object.freeze({ auth: ['login'], mail: ['autodiscover'] });

function checkArgs(args, { allowSetup = false } = {}) {
  const list = Array.isArray(args) ? args.map(String) : [];
  const [group, sub = ''] = list;
  const ok = (READ_ONLY[group] || []).includes(group === 'version' ? '' : sub)
    || (allowSetup && (SETUP[group] || []).includes(sub));
  if (!ok) throw Object.assign(new Error(`助理只能用 welink-cli 的查询命令，拒绝执行：${[group, sub].filter(Boolean).join(' ') || '（空）'}`), { code: 'WELINK_NOT_ALLOWED' });
  if (list.some(a => /[\r\n]/.test(a))) throw Object.assign(new Error('welink-cli 参数里不能有换行'), { code: 'WELINK_BAD_ARG' });
  return list;
}

// 找 welink-cli：环境变量（测试用假程序）→ 设置里填的路径 → npm 全局安装位置（.cmd 旁边的真 exe，不经 shell）。
function resolveCli({ env = process.env, configured = '', fsModule = fs } = {}) {
  const pick = [env.CLAUDE_HUB_WELINK_CLI, configured].find(p => p && fsModule.existsSync(p));
  if (pick) return pick;
  const appData = env.APPDATA || '';
  const exe = path.join(appData, 'npm', 'node_modules', '@welink', 'welink-cli', 'welink-cli.exe');
  if (appData && fsModule.existsSync(exe)) return exe;
  try {
    const found = execFileSync('where', ['welink-cli'], { encoding: 'utf8', windowsHide: true, timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }).split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    for (const f of found) {
      const sibling = path.join(path.dirname(f), 'node_modules', '@welink', 'welink-cli', 'welink-cli.exe');
      if (fsModule.existsSync(sibling)) return sibling;
      if (/\.exe$/i.test(f)) return f;
    }
  } catch { /* 没装 */ }
  return null;
}

// 跑一条 welink-cli。.js 结尾的是测试用的假程序，用 Hub 自己的程序以 Node 方式运行。
// onData：边跑边拿到目前为止的全部输出（扫码登录要在命令结束前把二维码显示出来）。
function run(args, { cli, timeoutMs = 30000, allowSetup = false, env = process.env, spawnFn = spawn, onData = null } = {}) {
  const list = checkArgs(args, { allowSetup });
  if (!cli) return Promise.reject(Object.assign(new Error('没找到 welink-cli：公司电脑上需先安装（npm 全局包 @welink/welink-cli）'), { code: 'WELINK_MISSING' }));
  const isScript = /\.(?:c?js)$/i.test(cli);
  const cmd = isScript ? process.execPath : cli;
  const argv = isScript ? [cli, ...list] : list;
  return new Promise((resolve, reject) => {
    let out = '', err = '', done = false;
    const child = spawnFn(cmd, argv, { windowsHide: true, env: { ...env, ...(isScript ? { ELECTRON_RUN_AS_NODE: '1' } : {}) } });
    const timer = setTimeout(() => { if (done) return; done = true; try { child.kill(); } catch {} reject(Object.assign(new Error(`welink-cli 超过 ${Math.round(timeoutMs / 1000)} 秒没返回：${list.slice(0, 2).join(' ')}`), { code: 'WELINK_TIMEOUT' })); }, timeoutMs);
    const tell = () => { if (onData) { try { onData(out + err); } catch { /* 显示失败不影响命令 */ } } };
    child.stdout?.on('data', d => { out += d; tell(); });
    child.stderr?.on('data', d => { err += d; tell(); });
    child.on('error', e => { if (done) return; done = true; clearTimeout(timer); reject(e); });
    child.on('close', code => { if (done) return; done = true; clearTimeout(timer); resolve({ code, stdout: out, stderr: err }); });
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
  if (/EXPIRED|未登录|not\s+logged\s*in|no\s+token/i.test(s)) return { ok: false, reason: 'expired', uid };
  if (/Token\s*[:：]\s*(?:VALID|OK|有效)|已登录|logged\s*in/i.test(s) || uid) return { ok: true, uid };
  return { ok: false, reason: 'unknown', uid };
}
const calendarNeedsSetup = text => /Exchange server domain not found|mail autodiscover/i.test(String(text || ''));

// auth login 返回二维码（真机输出格式待核对）：图片路径、data URI 或网址都认。
function qrFromLoginOutput(text) {
  const s = String(text || '');
  const dataUri = s.match(/data:image\/(?:png|jpe?g|svg\+xml);base64,[A-Za-z0-9+/=]+/);
  if (dataUri) return { kind: 'data', value: dataUri[0] };
  const file = s.match(/[A-Za-z]:\\[^\r\n"<>|]*?\.(?:png|jpe?g|bmp|svg)/i) || s.match(/\/[^\s"<>|]+\.(?:png|jpe?g|svg)/i);
  if (file) return { kind: 'file', value: file[0] };
  const url = s.match(/https?:\/\/[^\s"<>]+/);
  if (url) return { kind: 'url', value: url[0] };
  return null;
}

module.exports = { READ_ONLY, SETUP, checkArgs, resolveCli, run, parseJson, loginState, calendarNeedsSetup, qrFromLoginOutput };
