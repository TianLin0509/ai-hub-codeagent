'use strict';
// 阿里云控制台专用浏览器（2026-10-13）。
// 一个只属于阿里云控制台的 Chrome 资料目录：用户在账号页登录一次，AI 会话之后用
// scripts/aliyun-console.js 打开页面、读文字、截图。和 Hub 的「AI 浏览器」(hub-chrome.js)
// 分开：控制台权限高，不和网页圆桌、生图等自动化工具共用同一份登录。
//
// 安全底线（工具与说明共同遵守）：
// - 只做导航和读取；页面里执行的脚本只读 title / 地址 / 可见文字，不点击、不输入。
// - 下单、付款、改配置、开通或关闭服务、删资源，一律由用户本人在界面上操作。
// - 不读取、不输出 cookie 值；登录状态只看 cookie 名字和页面地址。读到的文字先遮蔽
//   AccessKey、API Key 一类密钥；页面上出现密钥时拒绝截图。
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const SERVICE_ID = 'aliyunConsole';
const NAME = '阿里云控制台';
const HOME_URL = 'https://bailian.console.aliyun.com/';
const PURPOSE = '阿里云 / 百炼控制台（AI 可查看）';
const LOGIN_HINT = '阿里云 App 或支付宝扫码，也可以用账号密码登录';
// 只允许这两个域名（含子域名）；这个浏览器只给阿里云用。
const ALLOWED_DOMAINS = ['aliyun.com', 'alibabacloud.com'];
// 未登录访问控制台会被重定向到这些登录页。
const SIGNIN_HOSTS = ['signin.aliyun.com', 'account.aliyun.com', 'passport.aliyun.com', 'signin.alibabacloud.com', 'account.alibabacloud.com'];
// 阿里云登录后写在 .aliyun.com 上的登录票据。只比对名字，从不读取值。
const LOGIN_COOKIES = /^(login_aliyunid_ticket|login_aliyunid_pk)$/;
const COOKIE_URLS = ['https://www.aliyun.com/', HOME_URL, 'https://home.console.aliyun.com/'];
const OFFSCREEN = { left: -32000, top: -32000, width: 1280, height: 900 };
const sleep = ms => new Promise(r => setTimeout(r, ms));

function hostOf(url) { try { return new URL(url).hostname.toLowerCase(); } catch { return ''; } }
function domainMatch(host, domain) { return host === domain || host.endsWith('.' + domain); }
function hostAllowed(url) {
  let u; try { u = new URL(url); } catch { return false; }
  if (u.protocol !== 'https:' || u.username || u.password) return false;
  return ALLOWED_DOMAINS.some(d => domainMatch(u.hostname.toLowerCase(), d));
}
function isSigninUrl(url) { const host = hostOf(url); return SIGNIN_HOSTS.includes(host); }
function assertUrl(url) {
  if (!hostAllowed(url)) throw Error('只能打开阿里云控制台的 https 网址（*.aliyun.com 或 *.alibabacloud.com）');
  return new URL(url).href;
}
function profileDir(dataDir) { return path.join(path.resolve(dataDir), 'account-browsers', 'aliyun-console'); }

// 登录状态只由两类证据决定：页面是否停在阿里云登录页，以及是否有登录票据 cookie（只看名字）。
// pages: CDP /json/list 的页面；cookies: [{name, domain}]，读不到时传 null。
function classifyLogin({ pages = [], cookies = null } = {}) {
  const aliyun = pages.filter(p => p && p.type === 'page' && hostAllowed(p.url));
  const signin = aliyun.some(p => isSigninUrl(p.url));
  const consoleOpen = aliyun.some(p => !isSigninUrl(p.url));
  const ticket = Array.isArray(cookies) && cookies.some(c => c && LOGIN_COOKIES.test(String(c.name || '')) && ALLOWED_DOMAINS.some(d => domainMatch(String(c.domain || '').replace(/^\./, ''), d)));
  if (ticket && (!signin || consoleOpen)) return { state: 'signed_in', message: '专用浏览器里已登录阿里云' };
  if (signin) return { state: 'signed_out', message: '页面停在阿里云登录页，还没登录' };
  if (Array.isArray(cookies)) return { state: 'signed_out', message: '专用浏览器里没有阿里云登录记录' };
  return { state: 'unknown', message: '没能读取登录记录；打开专用浏览器后再检查' };
}

// 文字里的密钥一律遮蔽；出现密钥的页面不截图（截图无法遮蔽）。
const SECRET_PATTERNS = [
  [/\bLTAI[0-9A-Za-z]{12,30}\b/g, 'LTAI****（AccessKey 已隐藏）'],
  [/\bsk-[0-9A-Za-z_-]{16,}\b/g, 'sk-****（API Key 已隐藏）'],
  [/\bSTS\.[0-9A-Za-z_-]{16,}\b/g, 'STS.****（临时凭证已隐藏）'],
  [/(Secret[^\n:：]{0,16}[:：]?\s*)[0-9A-Za-z]{30}\b/gi, '$1****（Secret 已隐藏）'],
];
function redact(text) { let out = String(text || ''); for (const [re, to] of SECRET_PATTERNS) out = out.replace(re, to); return out; }
function containsSecret(text) { const s = String(text || ''); return SECRET_PATTERNS.some(([re]) => { re.lastIndex = 0; const hit = re.test(s); re.lastIndex = 0; return hit; }); }

function chromeExecutable(env) { return require('./hub-chrome').chromeExecutable(env); }

class AliyunConsole {
  constructor({ dataDir, env = process.env, spawnImpl = spawn, executable, now = Date.now } = {}) {
    this.dataDir = path.resolve(dataDir || env.CLAUDE_HUB_DATA_DIR || require('./data-dir').getHubDataDir());
    this.profile = profileDir(this.dataDir);
    this.stateFile = path.join(path.dirname(this.profile), 'aliyun-console-tool.json');
    Object.assign(this, { env, spawn: spawnImpl, now });
    this.executable = executable || (() => chromeExecutable(env));
  }
  // 隔离测试实例在用户正在用的桌面上运行：「给用户看」的窗口也停在屏幕外、不抢焦点。
  parkVisible() { return !!this.env.CLAUDE_HUB_DATA_DIR && ['background', 'hidden'].includes(this.env.CLAUDE_HUB_E2E_WINDOW_MODE); }
  async endpoint() {
    let lines;
    try { lines = fs.readFileSync(path.join(this.profile, 'DevToolsActivePort'), 'utf8').trim().split('\n'); }
    catch (e) { if (['ENOENT', 'EBUSY', 'EPERM', 'EACCES'].includes(e.code)) return null; throw e; }
    const port = Number(lines[0]);
    if (!Number.isInteger(port) || port < 1024 || port > 65535) return null;
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1500) });
      if (!r.ok) return null;
      const info = await r.json();
      // 端口文件会比浏览器活得久；路径对得上才是这个资料目录的浏览器。
      if (new URL(info.webSocketDebuggerUrl).pathname !== String(lines[1] || '').trim()) return null;
      return { port, ws: info.webSocketDebuggerUrl };
    } catch { return null; }
  }
  profileHeld() {
    try { fs.closeSync(fs.openSync(path.join(this.profile, 'lockfile'), 'r+')); return false; }
    catch (e) { if (e.code === 'ENOENT') return false; if (['EBUSY', 'EPERM', 'EACCES'].includes(e.code)) return true; throw e; }
  }
  async pages(ep) {
    const r = await fetch(`http://127.0.0.1:${ep.port}/json/list`, { signal: AbortSignal.timeout(3000) });
    if (!r.ok) throw Error('专用浏览器没有返回标签页列表');
    return (await r.json()).filter(t => t.type === 'page');
  }
  async connect(ep) { const { CDP } = require('./web-roundtable/cdp'); return CDP.connect(ep.ws, ep.port); }
  async connectPage(ep, targetId) {
    const tab = (await this.pages(ep)).find(t => t.id === targetId);
    if (!tab) throw Error('标签页已关闭');
    const { CDP } = require('./web-roundtable/cdp');
    return CDP.connect(tab.webSocketDebuggerUrl, ep.port);
  }
  launchArgs(url, { visible }) {
    const parked = !visible || this.parkVisible();
    return [
      '--user-data-dir=' + this.profile, '--remote-debugging-port=0',
      '--no-first-run', '--no-default-browser-check',
      // 停在屏幕外的窗口照常渲染，截图和读文字不会卡住（与 hub-chrome.js 的工具窗口相同）。
      '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-background-timer-throttling',
      ...(parked ? ['--window-position=-32000,-32000', '--window-size=1280,900'] : ['--start-maximized']),
      url,
    ];
  }
  async launch(url, { visible = false } = {}) {
    if (this.profileHeld()) throw Error('阿里云控制台专用浏览器正在退出或被占用，请几秒后重试');
    fs.mkdirSync(this.profile, { recursive: true });
    const pid = await new Promise((resolve, reject) => {
      const child = this.spawn(this.executable(), this.launchArgs(url, { visible }), { env: this.env, detached: true, stdio: 'ignore', windowsHide: !visible || this.parkVisible() });
      child.once('error', reject);
      child.once('spawn', () => { child.unref(); resolve(child.pid); });
    });
    for (const end = Date.now() + 20000; Date.now() < end;) {
      const ep = await this.endpoint();
      if (ep) { this.writeState({ ...this.readState(), pid, browserWs: ep.ws }); return ep; }
      await sleep(250);
    }
    throw Error('阿里云控制台专用浏览器没有在 20 秒内就绪');
  }
  readState() { try { return JSON.parse(fs.readFileSync(this.stateFile, 'utf8')) || {}; } catch { return {}; } }
  writeState(value) {
    fs.mkdirSync(path.dirname(this.stateFile), { recursive: true });
    const tmp = this.stateFile + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(value), 'utf8'); fs.renameSync(tmp, this.stateFile);
  }
  async place(cdp, targetId, bounds) {
    const { windowId } = await cdp.call('Browser.getWindowForTarget', { targetId });
    await cdp.call('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } });
    await cdp.call('Browser.setWindowBounds', { windowId, bounds });
  }
  // AI 自己的那一个标签页：只在它自己的窗口里，窗口停在屏幕外，不动用户正在看的页面。
  async toolTarget(ep) {
    const state = this.readState();
    if (!state.targetId || state.browserWs !== ep.ws) return null;
    return (await this.pages(ep)).find(t => t.id === state.targetId) || null;
  }
  async waitLoaded(ep, targetId, timeoutMs = 20000) {
    const page = await this.connectPage(ep, targetId);
    try {
      await page.call('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});
      let last = -1, stable = 0;
      for (const end = Date.now() + timeoutMs; Date.now() < end;) {
        let v = null;
        try { v = await page.evaluate('({ready:document.readyState,len:(document.body&&document.body.innerText||"").length})'); }
        catch (e) { if (!/context|Cannot find|destroyed/i.test(e.message || '')) throw e; }
        // 控制台是单页应用：文档完成后再等文字长度稳定约 1.5 秒。
        if (v && v.ready === 'complete') { stable = v.len === last && v.len > 0 ? stable + 1 : 0; last = v.len; if (stable >= 3) return; }
        await sleep(500);
      }
    } finally { page.close(); }
  }
  // AI 用的「打开」。浏览器没开时用这个资料目录在屏幕外启动；开着时只用 AI 自己的标签页。
  async open(url = HOME_URL, { wait = true } = {}) {
    url = assertUrl(url);
    let ep = await this.endpoint(), targetId;
    if (!ep) {
      ep = await this.launch(url);
      for (const end = Date.now() + 10000; !targetId && Date.now() < end;) {
        targetId = (await this.pages(ep)).find(t => hostAllowed(t.url) || t.url === url)?.id;
        if (!targetId) await sleep(250);
      }
      if (!targetId) throw Error('专用浏览器没有打开页面');
    } else {
      const own = await this.toolTarget(ep);
      if (own) {
        targetId = own.id;
        const page = await this.connectPage(ep, targetId);
        try { const nav = await page.call('Page.navigate', { url }); if (nav.errorText) throw Error('网页未能打开：' + nav.errorText); }
        finally { page.close(); }
      } else {
        const cdp = await this.connect(ep);
        try {
          ({ targetId } = await cdp.call('Target.createTarget', { url, newWindow: true, background: true }));
          await this.place(cdp, targetId, OFFSCREEN).catch(() => {});
        } finally { cdp.close(); }
      }
    }
    this.writeState({ ...this.readState(), targetId, browserWs: ep.ws });
    if (wait) await this.waitLoaded(ep, targetId);
    const tab = (await this.pages(ep)).find(t => t.id === targetId);
    return { targetId, url: tab?.url || url, title: tab?.title || '', signin: isSigninUrl(tab?.url || '') };
  }
  // 账号页的「登录 / 打开」：给用户看的窗口，放在屏幕上并置前（隔离测试除外）。
  async openForUser(url = HOME_URL) {
    url = assertUrl(url);
    const ep = await this.endpoint();
    if (!ep) { await this.launch(url, { visible: true }); return { launched: true }; }
    const cdp = await this.connect(ep);
    try {
      const { targetId } = await cdp.call('Target.createTarget', { url, newWindow: true, background: this.parkVisible() });
      if (this.parkVisible()) await this.place(cdp, targetId, OFFSCREEN).catch(() => {});
      else {
        await this.place(cdp, targetId, { left: 60, top: 40, width: 1280, height: 860 }).catch(() => {});
        const { windowId } = await cdp.call('Browser.getWindowForTarget', { targetId });
        await cdp.call('Browser.setWindowBounds', { windowId, bounds: { windowState: 'maximized' } }).catch(() => {});
        await cdp.call('Target.activateTarget', { targetId }).catch(() => {});
      }
      return { launched: false, targetId };
    } finally { cdp.close(); }
  }
  // 浏览器关着时读磁盘上的 cookie 名（Chrome 不加密名字），不启动浏览器。
  offlineCookies() {
    const db = path.join(this.profile, 'Default', 'Network', 'Cookies');
    if (!fs.existsSync(db)) return null;
    const copy = path.join(require('os').tmpdir(), `aliyun-console-cookies-${process.pid}-${require('crypto').randomUUID()}.db`);
    try { fs.copyFileSync(db, copy); } catch { return null; }
    try {
      const { DatabaseSync } = require('node:sqlite');
      const conn = new DatabaseSync(copy, { readOnly: true });
      try {
        const now = this.now();
        return conn.prepare('SELECT host_key AS domain, name, expires_utc / 1000 AS expires FROM cookies').all()
          .filter(r => !Number(r.expires) || Number(r.expires) - 11644473600000 > now).map(r => ({ name: r.name, domain: r.domain }));
      } finally { conn.close(); }
    } finally { try { fs.unlinkSync(copy); } catch {} }
  }
  async liveCookies(ep) {
    const cdp = await this.connect(ep);
    try {
      const { cookies } = await cdp.call('Storage.getCookies');
      // 只留下名字与域名；值在这里就丢掉，不进入任何返回值或日志。
      return cookies.filter(c => ALLOWED_DOMAINS.some(d => domainMatch(String(c.domain || '').replace(/^\./, ''), d))).map(c => ({ name: c.name, domain: c.domain }));
    } finally { cdp.close(); }
  }
  async status() {
    const ep = await this.endpoint();
    if (!ep) {
      if (!fs.existsSync(this.profile)) return { state: 'unknown', running: false, message: '还没打开过专用浏览器；在账号页点「登录」' };
      if (this.profileHeld()) return { state: 'unknown', running: false, message: '专用浏览器正在退出，稍后再检查' };
      const result = classifyLogin({ pages: [], cookies: this.offlineCookies() });
      return { ...result, running: false, message: result.message + '；浏览器未运行，按本机登录记录判断' };
    }
    const pages = await this.pages(ep);
    let cookies = null;
    try { cookies = await this.liveCookies(ep); } catch { cookies = null; }
    return { ...classifyLogin({ pages, cookies }), running: true };
  }
  async target(ep, tabId) {
    const pages = await this.pages(ep);
    if (tabId) {
      const hit = pages.find(t => t.id === tabId || t.id.startsWith(tabId));
      if (!hit) throw Error('找不到这个标签页，先用 list 查看');
      return hit;
    }
    const own = await this.toolTarget(ep);
    if (own) return own;
    const aliyun = pages.find(t => hostAllowed(t.url));
    if (!aliyun) throw Error('专用浏览器里没有阿里云页面，先用 open 打开');
    return aliyun;
  }
  async requireEndpoint() {
    const ep = await this.endpoint();
    if (!ep) throw Error('阿里云控制台专用浏览器没在运行，先用 open 打开页面');
    return ep;
  }
  async text({ tab, max = 20000 } = {}) {
    const ep = await this.requireEndpoint(), t = await this.target(ep, tab);
    if (!hostAllowed(t.url)) throw Error('这个标签页不是阿里云页面，不读取');
    const page = await this.connectPage(ep, t.id);
    try {
      const v = await page.evaluate('({title:document.title,url:location.href,text:(document.body&&document.body.innerText)||""})');
      const text = redact(v.text).replace(/\n{3,}/g, '\n\n').trim();
      return { targetId: t.id, title: redact(v.title), url: v.url, signin: isSigninUrl(v.url), truncated: text.length > max, text: text.slice(0, max) };
    } finally { page.close(); }
  }
  async screenshot(file, { tab } = {}) {
    if (!/\.png$/i.test(file)) throw Error('截图文件名要以 .png 结尾');
    const ep = await this.requireEndpoint(), t = await this.target(ep, tab);
    if (!hostAllowed(t.url)) throw Error('这个标签页不是阿里云页面，不截图');
    const page = await this.connectPage(ep, t.id);
    try {
      const body = await page.evaluate('(document.body&&document.body.innerText)||""');
      if (containsSecret(body)) throw Error('页面上有 AccessKey / API Key 一类密钥，按安全底线不截图；可以用 text 读遮蔽后的文字');
      await page.call('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});
      const { data } = await page.call('Page.captureScreenshot', { format: 'png' });
      fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
      fs.writeFileSync(file, Buffer.from(data, 'base64'));
      return { file: path.resolve(file), targetId: t.id, url: t.url, title: t.title };
    } finally { page.close(); }
  }
  async list() {
    const ep = await this.endpoint();
    if (!ep) return { running: false, tabs: [] };
    const own = this.readState().browserWs === ep.ws ? this.readState().targetId : '';
    return { running: true, tabs: (await this.pages(ep)).map(t => ({ id: t.id, title: t.title, url: t.url, tool: t.id === own, signin: isSigninUrl(t.url) })) };
  }
  // 正常退出浏览器（CDP Browser.close），登录资料保留在资料目录里。
  async close() {
    const ep = await this.endpoint();
    if (!ep) return { closed: false };
    const cdp = await this.connect(ep);
    let pid;
    try { pid = (await cdp.call('SystemInfo.getProcessInfo')).processInfo.find(p => p.type === 'browser')?.id; await cdp.call('Browser.close'); }
    catch (e) { if (!pid) throw e; }
    finally { cdp.close(); }
    if (pid) { const { alive } = require('./web-roundtable/store'); for (const end = Date.now() + 15000; alive(pid) && Date.now() < end;) await sleep(100); }
    return { closed: true, pid };
  }
}

module.exports = { AliyunConsole, SERVICE_ID, NAME, HOME_URL, PURPOSE, LOGIN_HINT, LOGIN_COOKIES, hostAllowed, isSigninUrl, assertUrl, classifyLogin, redact, containsSecret, profileDir };
