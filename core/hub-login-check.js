'use strict';
const restrictedCheck = () => ({ state: 'needs_attention', reason: 'headless_challenge',
  error: '官网安全验证拦截了后台检查，不代表登录失效。可打开网页确认，无需因此重新登录。' });

// One site on one identity: the ChatGPT session endpoint names the account; other sites are
// read from the page itself. `browser` is the running Hub Chrome or the headless inspector.
async function checkSite(browser, item, signal) {
  if (item.site === 'chatgpt') return browser.chatgptCheck(item.identity, { signal });
  return browser.liveStatus(item.identity, item.site, { signal });
}
async function runItems(browser, items, signal, onStage, onResult, fixture) {
  for (const item of items) {
    if (signal.aborted) break;
    onStage(item, '正在确认官网账号');
    let result;
    try {
      if (fixture) {
        await new Promise(resolve => setTimeout(resolve, Math.min(2000, Math.max(0, fixture.delayMs || 0))));
        result = { ...(fixture[item.identity]?.sites?.[item.site] || { state: 'unknown' }) };
        if (item.site === 'chatgpt' && result.state === 'signed_in') result.account = fixture[item.identity]?.account || '';
      } else result = await checkSite(browser, item, signal);
    } catch (e) {
      if (signal.aborted) break;
      // A person took the browser over: stop here, nothing is concluded about the login.
      if (e.code === 'HUB_HUMAN_HANDOFF') break;
      result = ['HUB_LOGIN_CHECK_RESTRICTED', 'HUB_SITE_CHALLENGED'].includes(e.code) ? restrictedCheck() : { state: 'unknown', error: e.message };
    }
    if (result?.state === 'needs_attention' && result.reason === 'challenge') result = restrictedCheck();
    if (!signal.aborted) await onResult(item, { ...result, live: true, verified: ['signed_in', 'signed_out', 'needs_attention'].includes(result.state), checkedAt: Date.now(), stale: false });
  }
}

// The person's explicit 复核并继续原任务: one website, looked at in the ordinary Hub Chrome the
// tools use (started off screen when closed). No headless browser: a headless Chrome is a
// second, odd-looking client of the same login (2026-10-08 review), and the routine check
// below never visits a website at all.
async function inspectAccounts({ chrome, items, signal, onStage, onResult, fixture }) {
  if (!fixture) {
    const ep = await chrome.endpoint();
    if (!ep && chrome.profileHeld()) throw Error('专属 Chrome 的普通窗口开着，关掉后再确认登录；已有登录会保留。');
    if (!ep || ep.headless) await chrome.ensure();
  }
  return runItems(fixture ? null : chrome, items, signal, onStage, onResult, fixture);
}

// The routine check (2026-10-08): never visits a website. Opening chatgpt.com / claude.ai
// from automation met Cloudflare checks it cannot pass, and each failure raised the
// profile's challenge counters until the person looped on "Verify you are human" (observed
// 2026-10-07, ten passes in three minutes). The login cookie is read instead: from the file
// when Chrome is closed, through the identity's local marker page when it runs. A missing
// or expired cookie means signed out; sites that keep their login elsewhere are skipped.
async function inspectCookies({ chrome, items, signal, onStage, onResult, fixture }) {
  for (const identity of [...new Set(items.map(item => item.identity))]) {
    if (signal.aborted) break;
    const group = items.filter(item => item.identity === identity);
    onStage(group[0], '正在读取本机登录记录');
    let sites;
    if (fixture) sites = Object.fromEntries(group.map(item => [item.site, fixture[identity]?.sites?.[item.site]]));
    else {
      const ep = await chrome.endpoint();
      if (!ep && chrome.profileHeld()) throw Error('专属 Chrome 的普通窗口开着，关掉后再确认登录；已有登录会保留。');
      const who = chrome.identity(identity);
      const rows = ep ? await chrome.liveCookieRows(who, { allowOpen: true }) : chrome.cookieRows(who);
      sites = chrome.statusFromRows(who, rows).sites;
    }
    for (const item of group) {
      if (signal.aborted) break;
      const seen = sites[item.site];
      const state = seen?.state === 'cookie_present' || seen?.state === 'signed_in' ? 'signed_in' : seen?.state === 'signed_out' ? 'signed_out' : null;
      if (!state) continue;
      await onResult(item, { state, source: 'cookie', live: false, verified: true, checkedAt: Date.now(), stale: false, ...(seen.expiresAt ? { expiresAt: seen.expiresAt } : {}) });
    }
  }
}
// Sites whose login can be read from a cookie without visiting them.
const cookieSite = key => !!require('./hub-chrome').SITES[key]?.cookie;
module.exports = { inspectAccounts, inspectCookies, cookieSite, restrictedCheck };
