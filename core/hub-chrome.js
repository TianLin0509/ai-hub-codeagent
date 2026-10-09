'use strict';
// The Hub's one Chrome. It is the only place any web login lives: one profile per account
// identity (a person's login, e.g. 主 / 副), holding every site that person uses. Web tools
// open pages in it instead of starting browsers of their own. Passive refresh reads only
// existing records; an explicit website check is orchestrated by HubAccounts.
//
// Measured on this machine (2026-09-25): 4 ChatGPT pages as 4 Chromes = 2,749 MB / 40
// processes; as 4 tabs of one Chrome = 1,199 MB / 14 processes. One process with one
// debugging port serves several profiles, and their cookies stay fully separate.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const routing = require('./hub-browser-routing');

// `cookie`: the cookie that carries the login; readable offline because Chrome does not
// encrypt cookie names or expiry. Sites without one keep their login in localStorage, which
// Chrome compresses on disk, so they can only be confirmed with the browser running.
const SITES = {
  chatgpt: { name: 'ChatGPT', url: 'https://chatgpt.com/', cookie: { host: 'chatgpt.com', name: /^__Secure-next-auth\.session-token(\.\d+)?$/ } },
  google: { name: 'Google', url: 'https://gemini.google.com/app', cookie: { host: 'google.com', name: /^__Secure-1PSID$/ } },
  claude: { name: 'Claude', url: 'https://claude.ai/', cookie: { host: 'claude.ai', name: /^sessionKey$/ } },
  doubao: { name: '豆包', url: 'https://www.doubao.com/chat/', cookie: { host: 'doubao.com', name: /^sessionid$/ } },
  deepseek: { name: 'DeepSeek', url: 'https://chat.deepseek.com/' },
  kimi: { name: 'Kimi', url: 'https://www.kimi.com/' },
  qwen: { name: '千问', url: 'https://www.qianwen.com/' },
};
const ALL_SITES = Object.keys(SITES);
// A cookie jar holds one login per site, so a second account on the same site needs a
// second identity. Everything else belongs in the main one.
const DEFAULT_IDENTITIES = [
  { id: 'main', label: '主', sites: ALL_SITES },
  { id: 'alt', label: '副', sites: ALL_SITES },
];
const OFFSCREEN = { left: -32000, top: -32000, width: 1280, height: 900 };
const ONSCREEN = { left: 60, top: 40, width: 1280, height: 860 };

function defaultRoot(env = process.env) {
  if (env.HUB_CHROME_ROOT) return path.resolve(env.HUB_CHROME_ROOT);
  // An isolated Hub must never drive the production Chrome or its logins.
  if (env.CLAUDE_HUB_DATA_DIR || env.CLAUDE_HUB_HOME_DIR) {
    return path.join(path.resolve(env.CLAUDE_HUB_DATA_DIR || env.CLAUDE_HUB_HOME_DIR), 'hub-chrome');
  }
  return path.join(require('./data-dir').getHubDataDir(), 'hub-chrome');
}
function chromeExecutable(env = process.env) {
  const candidates = [
    path.join(env.PROGRAMFILES || 'C:\\Program Files', 'Google/Chrome/Application/chrome.exe'),
    path.join(env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)', 'Google/Chrome/Application/chrome.exe'),
    path.join(env.LOCALAPPDATA || '', 'Google/Chrome/Application/chrome.exe'),
    path.join(env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)', 'Microsoft/Edge/Application/msedge.exe'),
  ];
  const found = candidates.find(p => fs.existsSync(p));
  if (!found) throw new Error('未找到 Chrome 或 Edge 浏览器');
  return found;
}
// Chrome stores expiry as microseconds since 1601-01-01 (0 = "until the browser closes").
// That overflows a JS number, so the query divides by 1000 first; this takes milliseconds.
function chromeTimeToMs(msSince1601) {
  const n = Number(msSince1601);
  return n ? n - 11644473600000 : 0;
}
function hostMatches(hostKey, host) {
  const h = String(hostKey || '').replace(/^\./, '');
  return h === host || h.endsWith('.' + host);
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

class HubChrome {
  constructor({ root, env = process.env, spawnImpl = spawn, identities = DEFAULT_IDENTITIES, executable, now = Date.now, proxy } = {}) {
    this.root = root || defaultRoot(env);
    this.env = env;
    this.spawn = spawnImpl;
    this.identities = identities;
    this.executable = executable || (() => chromeExecutable(env));
    this.now = now;
    this.proxy = proxy;
    this.starting = null;
    this.contexts = new Map();
  }
  identity(id) {
    const found = this.identities.find(i => i.id === id);
    if (!found) throw new Error('未知的账号身份：' + id);
    return found;
  }
  site(key) {
    if (Object.hasOwn(SITES, key)) return SITES[key];
    const { EXTERNAL_SITES, externalSite } = require('./external-accounts');
    if (Object.hasOwn(EXTERNAL_SITES, key)) return externalSite(key);
    throw new Error('未知的网站：' + key);
  }
  async lifecycle(fn) {
    // The headless inspector holds the exclusive account-check lease for its whole run, and
    // a person's click or a tool may wait for it to yield while holding this lock.
    if (this.inspectionOwner) return fn();
    const { acquire } = require('./web-roundtable/store');
    for (const end = Date.now() + 45000; ; ) {
      const release = acquire('lifecycle', path.join(this.root, 'locks'));
      if (release) { try { return await fn(); } finally { release(); } }
      if (Date.now() > end) throw Error('Hub 浏览器正在切换模式，请稍后重试');
      await sleep(100);
    }
  }
  async closeIfIdle() {
    return this.lifecycle(async () => {
      // A tool may finish closing its page just as an inspector reserves Chrome.
      // Idle cleanup is optional: leave the inspector's browser to its owner.
      const release = this.inspectionOwner ? null : require('./web-roundtable/store').acquire('account-check', path.join(this.root, 'locks'));
      if (!this.inspectionOwner && !release) return false;
      try {
        if (await this.workTabs()) return false;
        await this.close();
        return true;
      } finally { release?.(); }
    });
  }

  // ---- offline: answer "is this identity logged in to that site" from disk alone ----
  cookieRows(identity) {
    const db = path.join(this.root, identity.id, 'Network', 'Cookies');
    if (!fs.existsSync(db)) return null;
    // Chrome may hold the file open; read a private copy so a running browser is never touched.
    const copy = path.join(os.tmpdir(), `hub-chrome-cookies-${process.pid}-${crypto.randomUUID()}.db`);
    try { fs.copyFileSync(db, copy); }
    catch (e) {
      // Only a running Chrome holds this file; with no debugging endpoint that is the
      // ordinary-mode window opened for a login.
      if (e.code === 'EBUSY' || e.code === 'EPERM') throw Object.assign(new Error('登录窗口开着'), { loginOpen: true });
      throw e;
    }
    try {
      const { DatabaseSync } = require('node:sqlite');
      const conn = new DatabaseSync(copy, { readOnly: true });
      try {
        return conn.prepare('SELECT host_key AS host, name, expires_utc / 1000 AS expires FROM cookies').all()
          .map(r => ({ host: r.host, name: r.name, expiresAt: chromeTimeToMs(r.expires) }));
      } finally { conn.close(); }
    } finally {
      try { fs.unlinkSync(copy); } catch { /* temp copy; leaving it behind only costs disk */ }
    }
  }
  // While Chrome runs it holds the cookie file exclusively, so ask the identity's own marker
  // page instead: Network.getCookies from a page returns that profile's cookies, httpOnly too.
  async liveCookieRows(identity, { allowOpen = false } = {}) {
    const ep = await this.endpoint();
    if (!ep) throw Error('浏览器已关闭，稍后刷新');
    const { CDP } = require('./web-roundtable/cdp');
    const cdp = await CDP.connect(ep.ws, ep.port);
    let page;
    try {
      const mark = allowOpen ? await this.marker(identity.id, cdp)
        : (await cdp.call('Target.getTargets')).targetInfos.find(t => t.url === this.markerUrl(identity.id));
      if (!mark) return this.cookieRows(identity);
      page = await this.page(mark.targetId);
      const urls = [...new Set(identity.sites.map(k => this.site(k)).map(s => s.cookie ? 'https://' + s.cookie.host : s.url))];
      const { cookies } = await page.call('Network.getCookies', { urls });
      return cookies.map(c => ({ host: c.domain, name: c.name, expiresAt: c.expires > 0 ? Math.round(c.expires * 1000) : 0 }));
    } finally { page?.close(); cdp.close(); }
  }
  // The one "检查登录". Reads the file when Chrome is closed (no process started at all) and
  // the live store when it is open; the answer has the same shape either way.
  // Sites without a login cookie get a quick look in a background tab, but only when Chrome
  // is already running — checking never starts the browser.
  // Cookie-only unless a caller explicitly asks to look at the websites (live: true).
  async loginStatus(identityId, { live = false } = {}) {
    const identity = this.identity(identityId);
    const running = await this.running();
    const loginOpen = () => ({ identity: identity.id, running: false, loginOpen: true, sites: Object.fromEntries(identity.sites.map(k => [k, { state: 'login_open' }])) });
    // A Chrome holds the profile but offers no debugging port: that is the login window.
    // Its cookies cannot be read until the person closes it.
    if (!running && this.profileHeld()) return loginOpen();
    let rows;
    try { rows = running ? await this.liveCookieRows(identity, { allowOpen: live }) : this.cookieRows(identity); }
    catch (e) { if (e.loginOpen) return loginOpen(); throw e; }
    const status = { ...this.statusFromRows(identity, rows), running };
    if (running && live) {
      const pending = Object.entries(status.sites).filter(([k, v]) => k !== 'chatgpt' && ['needs_browser', 'cookie_present'].includes(v.state)).map(([k]) => k);
      const results = await Promise.all(pending.map(k => this.liveStatus(identityId, k).catch(() => ({ state: 'unknown' }))));
      pending.forEach((k, i) => { status.sites[k] = { ...results[i], live: true }; });
    }
    if (running && live && status.sites.chatgpt?.state === 'cookie_present') {
      status.account = await this.chatgptAccount(identityId).catch(() => '');
      status.sites.chatgpt = { ...status.sites.chatgpt, state: status.account ? 'signed_in' : 'unknown', live: true };
    }
    return status;
  }
  // Which ChatGPT account this identity is signed in as, from the site's own session
  // endpoint. Only the email leaves the page; the session's token is never read here.
  async chatgptAccount(identityId, options = {}) { return (await this.chatgptCheck(identityId, options)).account || ''; }
  // One page load; the session endpoint is read at most twice, only once the page itself shows
  // a signed-in account (2026-10-08: the old loop could call it about 15 times per check).
  async chatgptCheck(identityId, { signal } = {}) {
    const { targetId } = await this.openTab(identityId, 'https://chatgpt.com/');
    let page, reads = 0;
    try {
      page = await this.page(targetId);
      for (const end = Date.now() + 15000; Date.now() < end;) {
        if (signal?.aborted) throw Error('检查已取消');
        let probe;
        try { probe = await page.evaluate(require('./account-browser').PROBE); }
        catch (e) { if (!/Execution context was destroyed|Cannot find context with specified id/i.test(e.message || '')) throw e; }
        if (probe?.challenge) {
          require('./web-risk-guard').recordChallenge(this.root, { identity: identityId, site: 'chatgpt', kind: 'cloudflare', source: 'account-check' });
          throw Object.assign(Error('网站安全验证拦截了后台检查'), { code: 'HUB_LOGIN_CHECK_RESTRICTED' });
        }
        if (probe?.host === 'chatgpt.com' && probe.login) return { state: 'signed_out', account: '' };
        if (!(probe?.host === 'chatgpt.com' && probe.profile)) { await sleep(1000); continue; }
        if (reads >= 2) return { state: 'signed_in', account: '' };
        reads++;
        const email = await page.evaluate(`(async()=>{if(location.hostname!=='chatgpt.com')return '';try{const r=await fetch('/api/auth/session',{credentials:'include',signal:AbortSignal.timeout(4000)});if(!r.ok)return '';const j=await r.json();return (j&&j.user&&j.user.email)||'';}catch{return ''}})()`).catch(e => {
          if (!/Execution context was destroyed|Cannot find context with specified id/i.test(e.message || '')) throw e;
          return '';
        });
        if (email) return { state: 'signed_in', account: String(email).slice(0, 120) };
        await sleep(2000);
      }
      return { state: 'unknown', account: '' };
    } finally { page?.close(); await this.closeTab(targetId); }
  }
  offlineStatus(identityId) {
    const identity = this.identity(identityId);
    return this.statusFromRows(identity, this.cookieRows(identity));
  }
  statusFromRows(identity, rows) {
    const now = this.now();
    const sites = {};
    for (const key of identity.sites) {
      const rule = this.site(key).cookie;
      if (!rule) { sites[key] = { state: 'needs_browser' }; continue; }
      const hits = (rows || []).filter(r => hostMatches(r.host, rule.host) && rule.name.test(r.name) && (!r.expiresAt || r.expiresAt > now));
      sites[key] = hits.length
        ? { state: 'cookie_present', expiresAt: hits.some(r => !r.expiresAt) ? 0 : Math.max(...hits.map(r => r.expiresAt)) }
        : { state: 'signed_out' };
    }
    return { identity: identity.id, profileExists: rows !== null, sites };
  }

  // ---- the running browser ----
  async endpoint() {
    let lines;
    try { lines = fs.readFileSync(path.join(this.root, 'DevToolsActivePort'), 'utf8').trim().split('\n'); }
    catch (e) { if (['ENOENT', 'EBUSY', 'EPERM', 'EACCES'].includes(e.code)) return null; throw e; }
    const port = Number(lines[0]);
    if (!Number.isInteger(port) || port < 1024 || port > 65535) return null;
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1500) });
      if (!r.ok) return null;
      const info = await r.json();
      // The port file outlives the browser; only trust it if the socket path matches too.
      if (new URL(info.webSocketDebuggerUrl).pathname !== String(lines[1] || '').trim()) return null;
      return { port, ws: info.webSocketDebuggerUrl, headless: /HeadlessChrome/.test(info['User-Agent'] || '') };
    } catch { return null; }
  }
  // Chrome drops about:/data: URLs given on its command line, so each identity's marker is
  // a small local page. It doubles as a note to anyone who finds the window.
  markerUrl(identityId) {
    const file = path.join(this.root, `identity-${identityId}.html`);
    return require('url').pathToFileURL(file).href;
  }
  writeMarker(identityId) {
    const identity = this.identity(identityId);
    fs.mkdirSync(this.root, { recursive: true });
    const file = path.join(this.root, `identity-${identityId}.html`);
    const html = `<!doctype html><meta charset="utf-8"><title>AI Hub 浏览器 · ${identity.label}</title>`
      + `<body style="font:15px system-ui;padding:40px;color:#333">这是 AI Hub 的浏览器（身份：${identity.label}）。`
      + `Hub 的网页工具都在这里工作，请不要关闭这个窗口。</body>`;
    if (!fs.existsSync(file) || fs.readFileSync(file, 'utf8') !== html) fs.writeFileSync(file, html, 'utf8');
  }
  // The Hub's proxy (hub-config.js) for every launch. Without it Chrome follows the Windows
  // system proxy, which the proxy client may switch off; then ChatGPT never loads (measured
  // 2026-09-30: navigating to chatgpt.com timed out, with the Hub proxy it loaded at once).
  proxyServer() {
    // Read on every launch: saving Hub settings must not leave this instance
    // permanently bound to the first proxy it saw.
    const value=typeof this.proxy==='function'?this.proxy():this.proxy===undefined?require('./hub-config').getConfig().proxy:this.proxy;
    return routing.normalizeProxy(value);
  }
  routingStatus() { return routing.status(this.root,routing.policy(this.proxyServer()),this.profileHeld()); }
  launchArgs(identityId, { debug = true, visible = false, headless = false, newWindow = true, url, urls } = {}) {
    return [
      ...routing.policy(this.proxyServer()).args,
      '--user-data-dir=' + this.root,
      '--profile-directory=' + identityId,
      ...(debug ? ['--remote-debugging-port=0'] : []),
      ...(headless ? ['--headless=new'] : []),
      '--no-first-run', '--no-default-browser-check',
      // Tool tabs live in windows parked off screen. Without these Chrome reports them hidden:
      // timers are throttled and no animation frame runs, so a Playwright click waits forever
      // for the element to be stable (measured 2026-09-30 on the bridge's send button). Chrome
      // launched by Playwright carries the same three switches.
      // Only for the debugging Chrome the tools drive. A window a person uses (debug false) gets
      // none of them: the same profile launched without these passed Cloudflare at once while
      // the debugging launch looped on "Verify you are human" (2026-10-08).
      ...(debug ? ['--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-background-timer-throttling'] : []),
      // Set an explicit visible state instead of restoring a parked off-screen window.
      // Measured on Windows Chrome: --window-position overrides --start-maximized,
      // for both the first launch and a new window in an already running browser.
      ...(visible ? ['--start-maximized']
        : ['--window-position=-32000,-32000', '--window-size=1280,900']),
      ...(newWindow ? ['--new-window'] : []), ...(urls && urls.length ? urls : [url || this.markerUrl(identityId)]),
    ];
  }
  launch(identityId, options) {
    const plan=routing.policy(this.proxyServer()),held=this.profileHeld();
    routing.assertCurrent(this.root,plan,held);
    this.writeMarker(identityId);
    return new Promise((resolve, reject) => {
      const child = this.spawn(this.executable(), this.launchArgs(identityId, options), { env: this.env, detached: true, stdio: 'ignore', windowsHide: !options?.visible });
      child.once('error', reject);
      child.once('spawn', () => { this.lastLaunchPid = child.pid; child.unref();
        try { if(!held)routing.record(this.root,plan,child.pid);resolve(); }catch(e){reject(e);}
      });
    });
  }
  // Chrome holds <profile>/lockfile exclusively for as long as it runs, so a failed open
  // answers "is a Chrome on this profile" without scanning processes (a scan also fails
  // whenever any unrelated chrome.exe hides its command line). Whether that Chrome is ours in
  // debugging mode or an ordinary login window is told by the debugging endpoint.
  profileHeld() {
    // Chrome lets others read the file but not write it; only a write open reveals the hold.
    try { fs.closeSync(fs.openSync(path.join(this.root, 'lockfile'), 'r+')); return false; }
    catch (e) {
      if (e.code === 'ENOENT') return false;
      if (e.code === 'EBUSY' || e.code === 'EPERM' || e.code === 'EACCES') return true;
      throw e;
    }
  }
  async owners() {
    if (!this.profileHeld()) return [];
    return [{ automated: !!(await this.endpoint()) }];
  }
  yieldFile() { return path.join(this.root, 'locks', 'account-check.yield'); }
  // A background login check never blocks anyone: a person's click or a tool asks it to
  // yield (a file, so it works across Hub processes) and waits for it to let go.
  async waitForCheck(timeoutMs = 30000) {
    if (this.inspectionOwner) return;
    const { acquire } = require('./web-roundtable/store'), dir = path.join(this.root, 'locks');
    for (let asked = false, end = Date.now() + timeoutMs; ; ) {
      const release = acquire('account-check', dir);
      if (release) { release(); return; }
      if (!asked) { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(this.yieldFile(), String(Date.now()), 'utf8'); asked = true; }
      if (Date.now() > end) throw Error('后台登录确认没有及时让出浏览器，请稍后再试');
      await sleep(200);
    }
  }
  yieldRequested() { return fs.existsSync(this.yieldFile()); }
  clearYield() { try { fs.unlinkSync(this.yieldFile()); } catch (e) { if (e.code !== 'ENOENT') throw e; } }
  // A headless Chrome exists only for a login check. One left behind with no check running
  // (seen 2026-10-07: alive a whole day, refusing every click with "正在后台检查登录") is
  // closed when it holds nothing but Hub markers.
  // Holds the check lease while closing, so a check starting this very moment is never hit.
  async closeOrphanHeadless(ep, { strict = true } = {}) {
    if (!ep?.headless || this.inspectionOwner) return false;
    const release = require('./web-roundtable/store').acquire('account-check', path.join(this.root, 'locks'));
    if (!release) { if (strict) throw Error('后台登录确认刚刚开始，请稍后再试'); return false; }
    try {
      const now = await this.endpoint();
      if (!now?.headless || now.ws !== ep.ws) return !now;
      const busy = await this.workTabs();
      if (busy) { if (strict) throw Error(`后台无头浏览器里还有 ${busy} 个任务页面，等它们结束后再打开`); return false; }
      await this.close();
      return true;
    } finally { release(); }
  }
  async ensure({ headless = false, identityId = this.identities[0].id } = {}) {
    await this.waitForCheck();
    let existing = await this.endpoint();
    if (!headless && await this.closeOrphanHeadless(existing, { strict: false })) existing = null;
    if (existing) {
      routing.assertCurrent(this.root,routing.policy(this.proxyServer()),this.profileHeld());
      if (headless && !existing.headless) throw Error('专属 Chrome 正在使用中，请关闭网页窗口后检查');
      return existing;
    }
    if (!this.starting) {
      this.starting = (async () => {
        // A launch would be handed to that ordinary window and never expose a debugging port.
        if ((await this.owners()).some(o => !o.automated)) throw new Error('Hub 浏览器正开着登录窗口；关掉那个窗口后，网页工具就能继续用它');
        this.contexts.clear();
        await this.launch(identityId, { headless });
        for (const end = Date.now() + 20000; Date.now() < end;) {
          const ep = await this.endpoint();
          if (ep) return ep;
          await sleep(250);
        }
        throw new Error('Hub 浏览器没有在 20 秒内就绪');
      })().finally(() => { this.starting = null; });
    }
    return this.starting;
  }
  async browser() {
    const ep = await this.ensure();
    const { CDP } = require('./web-roundtable/cdp');
    return { ep, cdp: await CDP.connect(ep.ws, ep.port) };
  }
  async running() { return !!(await this.endpoint()); }

  // Each profile appears to CDP as its own browser context, but Target.createTarget can
  // only place a tab in whichever profile Chrome currently treats as default (the one used
  // last) — naming any other profile fails, omitting it lands in the wrong identity. So a
  // headed tab is opened *from inside* its identity: every identity keeps one marker page,
  // parked off screen, and new tabs are window.open()ed by that page. The serial headless
  // inspector uses createTarget and verifies the returned context before navigation.
  async marker(identityId, cdp) {
    this.identity(identityId);
    const find = async () => {
      const { targetInfos } = await cdp.call('Target.getTargets');
      return targetInfos.find(t => t.type === 'page' && t.url === this.markerUrl(identityId));
    };
    let target = await find();
    if (!target) {
      await this.launch(identityId);   // Chrome hands this to the running process
      for (const end = Date.now() + 15000; !target && Date.now() < end;) { await sleep(250); target = await find(); }
      if (!target) throw new Error(`没能在 Hub 浏览器里打开身份「${this.identity(identityId).label}」`);
      await this.place(cdp, target.targetId, OFFSCREEN).catch(() => {});
    }
    return target;
  }
  async context(identityId, cdp) { return (await this.marker(identityId, cdp)).browserContextId; }
  async place(cdp, targetId, bounds) {
    const { windowId } = await cdp.call('Browser.getWindowForTarget', { targetId });
    await cdp.call('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } });
    await cdp.call('Browser.setWindowBounds', { windowId, bounds });
  }
  async pagesIn(cdp, browserContextId) {
    const { targetInfos } = await cdp.call('Target.getTargets');
    return targetInfos.filter(t => t.type === 'page' && t.browserContextId === browserContextId);
  }
  async waitNewPage(cdp, browserContextId, before, url) {
    for (const end = Date.now() + 15000; Date.now() < end;) {
      const fresh = (await this.pagesIn(cdp, browserContextId)).filter(t => !before.has(t.targetId));
      const hit = fresh.find(t => t.url === url);
      if (hit) return hit;
      await sleep(200);
    }
    throw new Error('Hub 浏览器没有打开新标签页');
  }
  // A person's window in a running Hub Chrome: Chrome opens it from its own command line, so
  // no debugger ever attaches to that page, and it is placed with browser-level window calls
  // only. Observed 2026-09-29: such a window inherited the parked off-screen position
  // (-14564,-14564) despite --window-position, so the person saw nothing when clicking it.
  async openVisible(identityId, url) { return this.lifecycle(() => this._openVisible(identityId, url)); }
  async _openVisible(identityId, url) {
    const { cdp } = await this.browser();
    try {
      const mark = await this.marker(identityId, cdp);
      const before = new Set((await this.pagesIn(cdp, mark.browserContextId)).map(t => t.targetId));
      await this.launch(identityId, { visible: true, url });
      let target;
      for (const end = Date.now() + 15000; !target && Date.now() < end;) {
        target = (await this.pagesIn(cdp, mark.browserContextId)).find(t => !before.has(t.targetId));
        if (!target) await sleep(200);
      }
      if (!target) throw new Error('Hub 浏览器没有打开网页窗口');
      await this.place(cdp, target.targetId, ONSCREEN);
      const { windowId } = await cdp.call('Browser.getWindowForTarget', { targetId: target.targetId });
      await cdp.call('Browser.setWindowBounds', { windowId, bounds: { windowState: 'maximized' } });
      await cdp.call('Target.activateTarget', { targetId: target.targetId }).catch(() => {});
      return { targetId: target.targetId };
    } finally { cdp.close(); }
  }
  // A tab in the given identity. `visible` is a login: a normal Chrome window on screen and in
  // front, opened by Chrome's own "open in this profile" path. Otherwise the tab gets a window
  // of its own parked off screen — its own window so it stays the active, unthrottled tab.
  async openTab(identityId, url, { visible = false } = {}) {
    return this.lifecycle(() => this._openTab(identityId, url, { visible }));
  }
  async _openTab(identityId, url, { visible = false } = {}) {
    if (!visible) require('./web-risk-guard').assertAutomationAllowed(this.root, { identity: identityId, url, navigate: true });
    const { ep, cdp } = await this.browser();
    try {
      const mark = await this.marker(identityId, cdp);
      const ctx = mark.browserContextId;
      const before = new Set((await this.pagesIn(cdp, ctx)).map(t => t.targetId));
      // A unique local URL correlates this request even across processes opening the same
      // website concurrently. Never select an arbitrary newly observed page.
      const ticketUrl = this.markerUrl(identityId) + '#task-' + crypto.randomUUID();
      let target;
      if (ep.headless) {
        // The inspector runs one profile at a time. Create its page through Chrome,
        // independent of marker document readiness and popup handling. Chrome may pick
        // a default profile: verify the context before navigating to any account website.
        const { targetId } = await cdp.call('Target.createTarget', { url: ticketUrl, newWindow: true });
        try {
          target = (await cdp.call('Target.getTargetInfo', { targetId })).targetInfo;
          if (target.browserContextId !== ctx) throw Error('检查标签页的账号隔离校验失败，未访问网站');
        } catch (e) { await this.closeTab(targetId); throw e; }
      } else if (visible) {
        await this.launch(identityId, { visible: true, url: ticketUrl });
      } else {
        const page = await this.page(mark.targetId);
        try {
          const result = await page.call('Runtime.evaluate', { expression: `window.open(${JSON.stringify(ticketUrl)},'_blank','popup=1,noopener');true`, userGesture: true, returnByValue: true });
          if (result.exceptionDetails) throw Error('Hub 浏览器创建标签页失败：' + (result.exceptionDetails.exception?.description || result.exceptionDetails.text));
        } finally { page.close(); }
      }
      target ||= await this.waitNewPage(cdp, ctx, before, ticketUrl);
      let tab;
      try {
        tab = await this.page(target.targetId);
        const navigation = await tab.call('Page.navigate', { url });
        if (navigation.errorText) throw Error('网页未能打开：' + navigation.errorText);
        await this.place(cdp, target.targetId, visible ? { windowState: 'maximized' } : OFFSCREEN);
      } catch (e) { await this.closeTab(target.targetId); throw e; }
      finally { tab?.close(); }
      if (visible) await cdp.call('Target.activateTarget', { targetId: target.targetId }).catch(() => {});
      return { targetId: target.targetId, port: ep.port, browserContextId: ctx };
    } finally { cdp.close(); }
  }
  async page(targetId) {
    const ep = await this.endpoint();
    if (!ep) throw new Error('Hub 浏览器未在运行');
    const tabs = await (await fetch(`http://127.0.0.1:${ep.port}/json/list`, { signal: AbortSignal.timeout(3000) })).json();
    const tab = tabs.find(t => t.id === targetId);
    if (!tab) throw new Error('标签页已关闭');
    const { CDP } = require('./web-roundtable/cdp');
    return CDP.connect(tab.webSocketDebuggerUrl, ep.port);
  }
  async closeTab(targetId) {
    const ep = await this.endpoint();
    if (!ep) return;
    await fetch(`http://127.0.0.1:${ep.port}/json/close/${encodeURIComponent(targetId)}`, { signal: AbortSignal.timeout(3000) }).catch(() => {});
  }
  // 登录 always happens in an ordinary Chrome on the same profile. Google refuses to sign in
  // (and so does every site using "Continue with Google") while the browser runs with a
  // debugging port — observed 2026-09-25 in this Hub Chrome, as the Gemini flow found before.
  // Cookies live in the profile, so the next debugging-mode start sees the login.
  async openLogin(identityId, siteKeys) {
    await this.waitForCheck();
    return this.lifecycle(() => this._openLogin(identityId, siteKeys));
  }
  // The account page's 打开. It always opens: a background check yields, an orphaned
  // headless Chrome is closed, and a running Hub Chrome gets a window of its own on screen
  // (no debugger attached to it) so web tools keep working alongside the person.
  async openWebsite(identityId, siteKey) {
    this.identity(identityId);
    const site = this.site(siteKey);
    await this.waitForCheck();
    return this.lifecycle(async () => {
      let ep = await this.endpoint();
      if (await this.closeOrphanHeadless(ep)) ep = null;
      // A browser containing only Hub markers has no website or draft to interrupt.
      if(ep&&this.routingStatus().state==='restart_required'&&!require('./web-risk-guard').handoff(this.root)&&!(await this.workTabs())){
        await this.close();ep=null;
      }
      const guard = require('./web-risk-guard');
      // A cool-down only holds the tools back; the person simply opens the site.
      if (guard.blocked(this.root, identityId, guard.siteOf(site.url))?.kind !== 'cooldown' && guard.blocked(this.root, identityId, guard.siteOf(site.url))) {
        const { lease, cleared } = await guard.openForHuman(this, { identity: identityId, url: site.url, by: 'account-tab' });
        return { mode: lease.mode, handoff: true, until: lease.until, cleared };
      }
      // A person's ordinary window is open: Chrome adds the page to it.
      if (!ep && this.profileHeld()) return this._openOrdinary(identityId, site.url);
      const recent = guard.read(this.root).sites[identityId + ':' + guard.siteOf(site.url)];
      if (recent && Date.now() - (recent.at || 0) < 24 * 3600000) {
        try { await guard.resetChallengeCookies(this, identityId, guard.siteOf(site.url), { countersOnly: true }); } catch { /* the visit matters more */ }
      }
      return { identity: identityId, mode: 'shared', ...await this._openVisible(identityId, site.url) };
    });
  }
  async assertOrdinaryAvailable() {
    await this.waitForCheck();
    let ep = await this.endpoint();
    if (await this.closeOrphanHeadless(ep)) ep = null;
    if (ep) {
      const busy = await this.workTabs();
      if (busy > 0) throw Object.assign(Error(`专属 Chrome 中还有 ${busy} 个网页或任务；请先保存并关闭这些标签页，再打开账号网站或去验证，登录记录会保留`), { code: 'HUB_BROWSER_BUSY' });
    }
    return ep;
  }
  async _openOrdinary(identityId, urls) {
    this.identity(identityId);
    const ep = await this.assertOrdinaryAvailable();
    if (ep) {
      await this.close();
      for (let i = 0; i < 40 && (await this.owners()).length; i++) await sleep(250);
      if ((await this.owners()).length) throw new Error('Hub 浏览器没能及时退出，请稍后再打开');
    }
    // Chrome creates a window if this profile has none, otherwise appends tabs.
    // Let its process singleton handle even clicks during initial startup;
    // --new-window would force a second window before the profile lock appears.
    await this.launch(identityId, { debug: false, visible: true, newWindow: false, urls: [].concat(urls) });
    return { identity: identityId, mode: 'ordinary', pid: routing.read(this.root)?.pid || this.lastLaunchPid };
  }
  // 去登录 prefers an ordinary window: Google sign-in refuses a browser with a debugging port.
  // While web tools have pages open, closing the browser would break their work, so the
  // login page opens in the running Hub Chrome instead of refusing the click.
  async _openLogin(identityId, siteKeys) {
    const identity = this.identity(identityId);
    const keys = [].concat(siteKeys || identity.sites).filter(Boolean);
    for (const k of keys) if (!identity.sites.includes(k) && !Object.hasOwn(require('./external-accounts').EXTERNAL_SITES, k)) throw new Error(`身份「${identity.label}」不负责 ${this.site(k).name}`);
    const urls = keys.map(k => this.site(k).url);
    try { return { ...await this._openOrdinary(identity.id, urls), sites: keys }; }
    catch (e) {
      if (e.code !== 'HUB_BROWSER_BUSY') throw e;
      for (const url of urls) await this._openVisible(identity.id, url);
      return { identity: identity.id, mode: 'shared', sites: keys };
    }
  }
  // Any non-marker page may still belong to a task or the user, irrespective of placement.
  async workTabs() {
    const ep = await this.endpoint();
    if (!ep) return 0;
    const { CDP } = require('./web-roundtable/cdp');
    const cdp = await CDP.connect(ep.ws, ep.port);
    try {
      const markers = new Set(this.identities.map(i => this.markerUrl(i.id)));
      const pages = (await cdp.call('Target.getTargets')).targetInfos.filter(t => t.type === 'page' && !markers.has(t.url));
      // Visible pages may also own a task (the image tool exposes its window for a
      // challenge). Window position is not evidence that it is safe to close one.
      return pages.length;
    } finally { cdp.close(); }
  }
  // Sites that keep their login in localStorage can only be read from a live page.
  async liveStatus(identityId, siteKey, { timeoutMs = 15000, signal } = {}) {
    if (!(await this.running())) return { state: 'needs_browser' };
    const site = this.site(siteKey), guard = require('./web-risk-guard');
    // A site that just challenged automation is not visited again until its pause ends.
    if (guard.blocked(this.root, identityId, guard.siteOf(site.url))) return { state: 'needs_attention', reason: 'challenge' };
    const { PROBE } = require('./account-browser');
    const { targetId } = await this.openTab(identityId, site.url);
    let page;
    try {
      page = await this.page(targetId);
      const host = new URL(site.url).hostname;
      for (const end = Date.now() + timeoutMs; Date.now() < end;) {
        if (signal?.aborted) throw Error('检查已取消');
        let r;
        try { r = await page.evaluate(PROBE); }
        catch (e) {
          // Page.navigate returns before redirects finish. Retry only this short
          // loss of the JavaScript context; real probe/connection errors stay visible.
          if (!/Execution context was destroyed|Cannot find context with specified id/i.test(e.message || '')) throw e;
        }
        if (r?.challenge) {
          guard.recordChallenge(this.root, { identity: identityId, site: guard.siteOf(site.url) || siteKey, kind: 'probe', source: 'account-check' });
          return { state: 'needs_attention', reason: 'challenge' };
        }
        if (siteKey === 'google' && r?.host === 'accounts.google.com') return { state: 'signed_out' };
        if (r && r.host === host) {
          if (r.login) return { state: 'signed_out' };
          if (r.profile) return { state: 'signed_in' };
        }
        await sleep(400);
      }
      return { state: 'unknown', reason: 'unrecognized_page', error: '后台暂未识别到账号状态，已有登录未被修改；可打开网页确认后重试。' };
    } finally {
      page?.close();
      await this.closeTab(targetId);
    }
  }
  async close() {
    const ep = await this.endpoint();
    if (!ep) return;
    const { CDP } = require('./web-roundtable/cdp');
    const cdp = await CDP.connect(ep.ws, ep.port);
    let pid;
    try {
      pid = (await cdp.call('SystemInfo.getProcessInfo')).processInfo.find(p => p.type === 'browser')?.id;
      await cdp.call('Browser.close');
    } catch (e) { if (!pid) throw e; /* the socket drops as the browser exits */ }
    finally { cdp.close(); }
    // DevTools disappears before Chrome releases all singleton/profile resources. A new
    // ordinary launch during that gap may still be handed to the exiting debug process.
    if (pid) {
      const { alive } = require('./web-roundtable/store');
      for (const end = Date.now() + 15000; alive(pid); ) {
        if (Date.now() >= end) throw Error('Hub 浏览器仍在退出，请稍后重试');
        await sleep(100);
      }
    }
    this.contexts.clear();
  }
}

module.exports = { HubChrome, SITES, DEFAULT_IDENTITIES, defaultRoot, chromeExecutable, chromeTimeToMs, hostMatches };
