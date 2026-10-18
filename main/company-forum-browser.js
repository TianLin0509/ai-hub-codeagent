'use strict';
// 「论坛」页的浏览器（2026-10-18，公司真机回执 Q-1018-01）：两个公司社区都是前端渲染的单页应用，内网单点登录记在浏览器里，
// 直接请求只拿到空壳、接口回「未登录」。所以 Hub 开一个看不见的窗口去打开首页，像人打开浏览器一样：
//   - 登录状态存在 Hub 自己的浏览器分区 persist:company-forum（数据目录里），不碰用户的 Chrome / Edge，也不和 CodeAgent 的抓取工具抢同一个浏览器资料；
//   - 用调试协议截下页面取数据的 JSON 响应（帖子编号、阅读、回复都在里面），再收页面上的帖子链接和指定板块的文字；
//   - 等页面「安定」（正文长度连续两次不变）再收，不是固定等几秒——固定等待在公司实测过同一页一次 3122 字、一次 189 字；
//   - 没登录时由用户点「登录」弹出同一分区的可见窗口，回到站点首页且不再是登录页就自动关掉。
// 窗口都挂在一个永不显示的宿主下（同桌宠，见 main/hub-pet-controller.js）：Windows 挑进程主窗口时不会挑到它们。
const LOGIN_WORDS = /账号登录|扫码登录|密码登录|统一身份认证|统一认证|请输入(?:账号|密码|工号)|忘记密码/;
const delay = ms => new Promise(r => setTimeout(r, ms));

// 在页面里执行：收帖子链接、指定板块的链接和文字行。
function collectScript(sections) {
  return `(() => {
    const wanted = ${JSON.stringify(sections || [])};
    const txt = el => (el && (el.innerText || el.textContent) || '').replace(/[ \\t\\u00a0]+/g, ' ').trim();
    const one = s => s.replace(/\\s+/g, ' ').trim();
    const abs = a => { try { return new URL(a.getAttribute('href'), location.href).href; } catch (e) { return ''; } };
    const linkOf = a => ({ href: abs(a), text: one(txt(a)).slice(0, 300) });
    const links = [...document.querySelectorAll('a[href]')].map(linkOf).filter(l => l.href && l.text.length >= 4);
    const all = [...document.querySelectorAll('body *')];
    const sections = wanted.map(heading => {
      const head = all.find(e => e.children.length <= 3 && one(txt(e)) === heading) || all.find(e => e.children.length <= 3 && one(txt(e)).startsWith(heading) && one(txt(e)).length <= heading.length + 10);
      if (!head) return { heading, found: false, links: [], lines: [] };
      let box = head.parentElement;
      for (let i = 0; i < 6 && box && box.parentElement; i += 1) {
        if (box.querySelectorAll('a[href]').length >= 5 || txt(box).split('\\n').filter(Boolean).length >= 8) break;
        box = box.parentElement;
      }
      const boxLinks = box ? [...box.querySelectorAll('a[href]')].map(linkOf).filter(l => l.href && l.text.length >= 4) : [];
      const lines = box ? txt(box).split('\\n').map(one).filter(s => s && s !== heading).slice(0, 60) : [];
      return { heading, found: true, links: boxLinks.slice(0, 60), lines };
    });
    const body = one(txt(document.body));
    return { finalUrl: location.href, title: document.title, textLength: body.length, text: body.slice(0, 6000), links: links.slice(0, 400), sections };
  })()`;
}
// 点页面上文字正好是 text 的那个元素（稼先首页的「热点」tab）。
function clickScript(text) {
  return `(() => {
    const want = ${JSON.stringify(text)};
    const els = [...document.querySelectorAll('a,button,li,span,div,[role=tab]')].filter(e => (e.innerText || '').trim() === want);
    const el = els.find(e => e.offsetParent !== null) || els[0];
    if (!el) return false;
    el.scrollIntoView({ block: 'center' }); el.click(); return true;
  })()`;
}
// 帖子详情：取正文块（字数最多、又不是整页的那个元素）。
const DETAIL_SCRIPT = `(() => {
  const txt = el => (el && (el.innerText || '') || '').replace(/\\s+/g, ' ').trim();
  const body = txt(document.body);
  let best = null, bestLen = 0;
  for (const el of document.querySelectorAll('article,main,section,div')) {
    const n = txt(el).length;
    if (n > bestLen && n < body.length * 0.95 && el.querySelectorAll('a').length < n / 40) { best = el; bestLen = n; }
  }
  const text = bestLen > 200 ? txt(best) : body;
  return { finalUrl: location.href, title: document.title, textLength: body.length, text: text.slice(0, 8000) };
})()`;

function createForumBrowser({ BrowserWindow, BaseWindow = null, session = null, partition = 'persist:company-forum', logger = console } = {}) {
  let owner = null, loginWin = null, busy = Promise.resolve();
  function ensureOwner() {
    if (!BaseWindow) return null;
    if (owner && !owner.isDestroyed?.()) return owner;
    try {
      owner = new BaseWindow({ show: false, width: 1, height: 1, frame: false, skipTaskbar: true, focusable: false, resizable: false, title: 'AI Hub 论坛宿主' });
      owner.on?.('closed', () => { owner = null; });
    } catch (error) { owner = null; logger.warn?.('[company-forum] owner window failed:', error && error.message); }
    return owner;
  }
  function makeWindow({ show = false, title = 'AI Hub 论坛' } = {}) {
    const parent = ensureOwner();
    const win = new BrowserWindow({
      ...(parent ? { parent } : {}), show, width: 1400, height: 900, title, autoHideMenuBar: true,
      webPreferences: { partition, sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, spellcheck: false },
    });
    win.webContents.setAudioMuted?.(true);
    // 站点弹新窗口（比如帖子在新标签打开）：在同一个窗口里跳过去，不另开。
    win.webContents.setWindowOpenHandler?.(({ url }) => { if (/^https?:/i.test(url)) void win.loadURL(url).catch(() => {}); return { action: 'deny' }; });
    return win;
  }
  // 截下页面取数据的 JSON 响应（只收网址匹配 api 的，单个最多 3MB）。
  function tap(win, api) {
    const out = [], pending = new Map(), dbg = win.webContents.debugger;
    try { dbg.attach('1.3'); } catch (error) { logger.warn?.('[company-forum] debugger attach failed:', error.message); return { out, ready: Promise.resolve(), stop() {} }; }
    const onMessage = (_e, method, params) => {
      if (method === 'Network.responseReceived') {
        const r = params.response || {};
        if (/json/i.test(r.mimeType || '') && (!api || api.test(r.url || ''))) pending.set(params.requestId, { url: r.url, status: r.status });
      } else if (method === 'Network.loadingFinished' && pending.has(params.requestId)) {
        const meta = pending.get(params.requestId); pending.delete(params.requestId);
        if (params.encodedDataLength > 3e6) return;
        dbg.sendCommand('Network.getResponseBody', { requestId: params.requestId }).then(({ body, base64Encoded }) => {
          const text = base64Encoded ? Buffer.from(body, 'base64').toString('utf8') : body;
          try { out.push({ ...meta, json: JSON.parse(text) }); } catch { /* 不是 JSON */ }
        }).catch(() => {});
      }
    };
    dbg.on('message', onMessage);
    const ready = dbg.sendCommand('Network.enable').catch(() => {});
    return { out, ready, stop() { try { dbg.removeListener('message', onMessage); dbg.detach(); } catch { /* 窗口已关 */ } } };
  }
  // 页面在跳转（比如单点登录的重定向）时，正在执行的脚本可能永远不返回（Electron 已知行为）：每次最多等 5 秒，当作没取到。
  const within = (p, ms, fallback) => Promise.race([p, delay(ms).then(() => fallback)]);
  async function run(win, script) { try { return await within(win.webContents.executeJavaScript(script, true), 5000, null); } catch { return null; } }
  // 等页面安定：正文长度连续两次（间隔 1.5 秒）不变且不为空，最多 maxMs。
  async function settle(win, { minMs = 2500, maxMs = 25000 } = {}) {
    const start = Date.now();
    let last = -1, same = 0;
    await delay(minMs);
    while (Date.now() - start < maxMs) {
      const n = await run(win, 'document.body ? document.body.innerText.length : 0');
      if (typeof n === 'number' && n > 0 && n === last) { same += 1; if (same >= 2) return; } else same = 0;
      last = n;
      await delay(1500);
    }
  }
  async function load(win, url) {
    // 单页应用的跳转、单点登录的重定向常让 loadURL 报 ERR_ABORTED，页面其实在继续加载：不当失败。
    // 一直没加载完（网络卡住）也不无限等：30 秒后照常往下，页面安定与否由 settle 判断。
    try { await within(win.loadURL(url), 30000, null); } catch (error) { if (!/ERR_ABORTED|ERR_FAILED \(-2\)/.test(String(error.message))) throw error; }
  }
  // 一次只开一个窗口，排队执行。
  function serial(fn) { const p = busy.then(fn, fn); busy = p.catch(() => {}); return p; }

  function capture({ url, clickText = '', clickUnless = null, sections = [], api = null, maxMs = 25000 }) {
    return serial(async () => {
      const win = makeWindow();
      const t = tap(win, api);
      try {
        await within(t.ready, 5000, null);
        await load(win, url);
        await settle(win, { maxMs });
        let page = await run(win, collectScript(sections));
        if (page && LOGIN_WORDS.test(String(page.text).slice(0, 3000)) && page.textLength < 4000) return { ...page, needsLogin: true, json: [] };
        const haveData = clickUnless && t.out.some(r => clickUnless.test(String(r.url)));
        if (clickText && !haveData && await run(win, clickScript(clickText))) { await settle(win, { minMs: 2000, maxMs: 15000 }); page = await run(win, collectScript(sections)) || page; }
        await delay(300); // 最后几个接口的响应体
        return { ...(page || { finalUrl: win.webContents.getURL(), textLength: 0, text: '', links: [], sections: [] }), needsLogin: false, json: t.out.slice(0, 80) };
      } finally { t.stop(); if (!win.isDestroyed()) win.destroy(); }
    });
  }
  function detail({ url, api = null, maxMs = 20000 }) {
    return serial(async () => {
      const win = makeWindow();
      const t = tap(win, api);
      try {
        await within(t.ready, 5000, null);
        await load(win, url);
        await settle(win, { maxMs });
        const page = await run(win, DETAIL_SCRIPT) || { text: '', textLength: 0 };
        return { ...page, needsLogin: LOGIN_WORDS.test(String(page.text).slice(0, 2000)) && page.textLength < 4000, json: t.out.slice(0, 20) };
      } finally { t.stop(); if (!win.isDestroyed()) win.destroy(); }
    });
  }
  // 登录：可见窗口，用户自己登录；回到站点且页面不再是登录页（连续 3 秒）就关掉并返回 ok。用户关窗返回 ok:false。
  function login({ url, base, title = '登录（AI Hub 论坛）', timeoutMs = 10 * 60000 }) {
    if (loginWin && !loginWin.isDestroyed()) { loginWin.show(); loginWin.focus(); return Promise.resolve({ ok: false, reason: 'already-open' }); }
    const want = (() => { try { return new URL(base || url).host; } catch { return ''; } })();
    const win = loginWin = makeWindow({ show: true, title });
    return new Promise(resolve => {
      let done = false, okSince = 0;
      const finish = ok => { if (done) return; done = true; clearInterval(timer); if (!win.isDestroyed()) win.destroy(); loginWin = null; resolve({ ok }); };
      win.on('closed', () => finish(false));
      const started = Date.now();
      const timer = setInterval(async () => {
        if (win.isDestroyed()) return finish(false);
        if (Date.now() - started > timeoutMs) return finish(false);
        let host = '';
        try { host = new URL(win.webContents.getURL()).host; } catch { /* 还没加载 */ }
        const page = host === want ? await run(win, '({ n: document.body ? document.body.innerText.length : 0, t: document.body ? document.body.innerText.slice(0, 3000) : "" })') : null;
        const fine = page && page.n > 60 && !(LOGIN_WORDS.test(page.t) && page.n < 4000);
        if (!fine) { okSince = 0; return; }
        if (!okSince) okSince = Date.now();
        if (Date.now() - okSince >= 3000) finish(true);
      }, 1000);
      void load(win, url).catch(error => logger.warn?.('[company-forum] login load', error.message));
    });
  }
  function close() { try { if (loginWin && !loginWin.isDestroyed()) loginWin.destroy(); } catch { /* 已关 */ } try { if (owner && !owner.isDestroyed?.()) owner.destroy?.(); } catch { /* 已关 */ } }
  // 退出登录：清掉这个分区里的登录状态。
  async function clearLogin() { if (!session) return; await session.fromPartition(partition).clearStorageData(); }
  return { capture, detail, login, close, clearLogin };
}

module.exports = { createForumBrowser, collectScript, clickScript, DETAIL_SCRIPT };
