'use strict';
// Shared protection for every tool that drives a signed-in website in the Hub Chrome.
//
// Observed 2026-09-29 on the secondary ChatGPT login: automated tabs that met a Cloudflare
// check could not pass it, the check page reloaded itself about every 85 s, and each failure
// changed Cloudflare's partitioned retry cookies (cf_chl_rc_*). A person in the affected
// profile also looped on "Verifying", while clean/incognito contexts passed on the same IP.
// That narrows the incident to stored browser state, without proving Cloudflare's scoring
// or whether debugger attachment caused it. The conservative recovery rules are:
//   1. an automated page that meets a challenge leaves it at once and the identity+site is
//      paused with growing backoff; nothing retries against a challenge;
//   2. a person verifying or signing in gets the browser to themselves: a handoff lease that
//      every automation transport honours, stale challenge counters cleared, a real window
//      placed on screen with no debugger attached.
// Nothing here solves or bypasses a check; the person completes it.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const FILE = 'web-risk.json';
// Paused, not failed: a site that challenged automation is left alone this long.
const BACKOFF_MS = [30, 120, 360, 1440].map(m => m * 60000);
const HANDOFF_MS = 15 * 60000;
// After a person verified or signed in, automation waits this long before touching the site
// again (2026-10-08: right after a pass, two lanes and a login check hit chatgpt.com within
// seconds; Cloudflare's session scoring treats such a burst as the same session acting oddly).
const COOLDOWN_MS = 20 * 60000;
// Automated page loads per identity and site in any rolling hour. A restrained person, not a
// crawler: an image job costs 2-4 loads, a roundtable answer one. Cloudflare-fronted
// subscription sites get the smallest budget.
const VISITS_PER_HOUR = { chatgpt: 30, claude: 10, google: 30 };
const DEFAULT_VISITS_PER_HOUR = 60;
const HOUR_MS = 3600000;
const STRIKE_MEMORY_MS = 24 * 3600000;
// Challenge-state cookies only. Login cookies are never touched.
const CHALLENGE_COOKIE = /^(cf_clearance|__cf_bm|cf_chl_[a-z_]*)$/;
const SITES = {
  // Keys match the account page (hub-chrome.js SITES): Gemini is the 'google' site there.
  chatgpt: ['chatgpt.com', 'openai.com'], google: ['google.com'],
  claude: ['claude.ai'], doubao: ['doubao.com'], deepseek: ['deepseek.com'], kimi: ['kimi.com', 'moonshot.cn'],
  qwen: ['qianwen.com', 'tongyi.com', 'qwen.ai', 'aliyun.com'], github: ['github.com'],
};

function siteOf(url) {
  let host;
  try { host = new URL(url).hostname.toLowerCase(); } catch { return null; }
  for (const [site, hosts] of Object.entries(SITES)) if (hosts.some(h => host === h || host.endsWith('.' + h))) return site;
  return null;
}

// Runs inside a page. Reports only whether a human check is showing and which kind.
const CHALLENGE_PROBE = `(() => {
  const title = document.title || '', url = location.href, text = (document.body && document.body.innerText || '').slice(0, 4000);
  const frame = sel => !!document.querySelector(sel);
  const conversation = frame('article,[data-message-author-role],textarea,[contenteditable="true"]');
  const visible = sel => [...document.querySelectorAll(sel)].some(e => {
    const style = getComputedStyle(e);
    return e.getClientRects().length > 0 && style.visibility !== 'hidden' && style.visibility !== 'collapse' && style.display !== 'none';
  });
  // Title alone is not proof (account-browser.js keeps the same rule): it needs Cloudflare's own script too.
  const cf = typeof window._cf_chl_opt === 'object' || frame('script[src*="/cdn-cgi/challenge-platform/"]');
  if ((/^(Just a moment|请稍候|請稍候|Attention Required)/i.test(title) && cf) || visible('iframe[src*="challenges.cloudflare.com"]') || visible('#challenge-running,#challenge-stage,#cf-challenge-running'))
    return { challenge: true, kind: 'cloudflare' };
  if (/google\\.[a-z.]+\\/sorry\\//.test(url) || (!conversation && text.length < 600 && /^Our systems have detected unusual traffic from your computer/i.test(text.trim()))) return { challenge: true, kind: 'google_unusual_traffic' };
  if (visible('iframe[src*="hcaptcha.com"]')) return { challenge: true, kind: 'hcaptcha' };
  if (visible('iframe[src*="recaptcha"][src*="bframe"]')) return { challenge: true, kind: 'recaptcha' };
  if (visible('.geetest_panel,.geetest_holder,#nc_1_wrapper,#aliyunCaptcha-window-popup,.captcha_verify_container,#captcha_container,.ds-shumei-captcha-modal'))
    return { challenge: true, kind: 'slider' };
  if (text.length < 600 && !conversation
    && /^(请完成安全验证|人机验证|拖动滑块|滑动验证|Verify you are human)/i.test(text.trim())) return { challenge: true, kind: 'text' };
  return { challenge: false };
})()`;

function file(root) { return path.join(root, FILE); }
function read(root) {
  try {
    const value = JSON.parse(fs.readFileSync(file(root), 'utf8'));
    return { handoff: value.handoff || null, sites: value.sites && typeof value.sites === 'object' ? value.sites : {},
      visits: value.visits && typeof value.visits === 'object' ? value.visits : {} };
  } catch { return { handoff: null, sites: {}, visits: {} }; }
}
// Several processes (Hub, image lanes, bridge) share the file: short exclusive lock, atomic write.
function update(root, fn) {
  fs.mkdirSync(root, { recursive: true });
  const lock = file(root) + '.lock';
  let fd = null;
  for (const end = Date.now() + 3000; fd === null;) {
    try { fd = fs.openSync(lock, 'wx'); } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try { if (Date.now() - fs.statSync(lock).mtimeMs > 10000) fs.rmSync(lock, { force: true }); } catch {}
      if (Date.now() > end) throw Error('web-risk.json is locked');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
  try {
    const state = read(root), result = fn(state);
    const tmp = file(root) + '.' + process.pid + '.' + crypto.randomBytes(4).toString('hex') + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(state), 'utf8');
    fs.renameSync(tmp, file(root));
    return result;
  } finally { fs.closeSync(fd); fs.rmSync(lock, { force: true }); }
}
const key = (identity, site) => identity + ':' + site;

function recordChallenge(root, { identity, site, kind = 'unknown', source = '', now = Date.now() }) {
  if (!site) return null;
  return update(root, state => {
    const prev = state.sites[key(identity, site)] || {};
    // A challenge within a day of the last one escalates, also right after a person cleared it.
    // Several lanes can meet the same incident at once: while paused it is one strike. A new
    // challenge after the pause ended (or a person released it) within a day escalates.
    const strikes = prev.until > now ? prev.strikes || 1 : (now - (prev.at || 0) < STRIKE_MEMORY_MS ? prev.strikes || 0 : 0) + 1;
    const entry = { identity, site, kind, source, since: prev.until > now ? prev.since : now, at: now, strikes,
      until: prev.until > now ? prev.until : now + BACKOFF_MS[Math.min(strikes, BACKOFF_MS.length) - 1] };
    state.sites[key(identity, site)] = entry;
    return entry;
  });
}
function clearSite(root, identity, site) {
  return update(root, state => { const had = !!state.sites[key(identity, site)]; delete state.sites[key(identity, site)]; return had; });
}
// The person says the site is fine again: automation may try once more, but the strikes stay,
// so an immediate new challenge backs off longer instead of starting over.
function releaseSite(root, identity, site, now = Date.now()) {
  return update(root, state => { const e = state.sites[key(identity, site)]; if (e) e.until = Math.min(e.until, now); return !!e; });
}
// The person finished: automation may come back after a cool-down, not at once. Strikes stay.
// Only sites fronted by Cloudflare's session scoring cool down; a domestic slider check
// passed by the person lets automation continue at once.
const COOLING_SITES = new Set(['chatgpt', 'claude', 'google']);
function coolSite(root, identity, site, now = Date.now(), ms = COOLDOWN_MS) {
  if (!COOLING_SITES.has(site)) return releaseSite(root, identity, site, now);
  return update(root, state => {
    const prev = state.sites[key(identity, site)];
    state.sites[key(identity, site)] = { ...(prev || { identity, site, strikes: 0, since: now, at: prev?.at || 0 }),
      kind: 'cooldown', source: 'handoff', until: now + ms };
    return state.sites[key(identity, site)];
  });
}
// Counts one automated page load against the hourly budget, or refuses it.
function takeVisit(root, identity, site, now = Date.now()) {
  const limit = VISITS_PER_HOUR[site] || DEFAULT_VISITS_PER_HOUR;
  return update(root, state => {
    const visits = state.visits[key(identity, site)] = (state.visits[key(identity, site)] || []).filter(t => now - t < HOUR_MS);
    if (visits.length >= limit) return { refused: true, limit, until: visits[0] + HOUR_MS };
    visits.push(now);
    return { refused: false, limit, used: visits.length };
  });
}
function blocked(root, identity, site, now = Date.now()) {
  const entry = site && read(root).sites[key(identity, site)];
  return entry && entry.until > now ? entry : null;
}
function handoff(root, now = Date.now()) {
  const lease = read(root).handoff;
  return lease && lease.until > now ? lease : null;
}
function startHandoff(root, { identity, site, url = '', by = '', now = Date.now() }) {
  return update(root, state => (state.handoff = { id: crypto.randomUUID(), identity, site, url, by, started: now, until: now + HANDOFF_MS }));
}
function endHandoff(root, id) {
  return update(root, state => { const had = !!state.handoff && (!id || state.handoff.id === id); if (had) state.handoff = null; return had; });
}
// Every automation transport calls this before touching a page. Errors carry a stable code
// and a category word ('Human handoff' / 'Site challenged') for tools that only see stdout.
// `navigate`: the caller is about to load a page of that site; it counts against the hourly
// budget. Steps on an already open page pass `navigate` false and cost nothing.
function assertAutomationAllowed(root, { identity, url, navigate = false, now = Date.now() } = {}) {
  const lease = handoff(root, now);
  if (lease) throw Object.assign(Error(`Human handoff: 有人正在 Hub 浏览器里验证或登录（${lease.identity}/${lease.site || '网站'}），自动化暂停到 ${new Date(lease.until).toLocaleTimeString()}`), { code: 'HUB_HUMAN_HANDOFF', until: lease.until });
  const site = url && siteOf(url), entry = site && blocked(root, identity, site, now);
  // Its own word: tools must treat it as "try later", never as a new human check.
  if (entry && entry.kind === 'cooldown') throw Object.assign(Error(`Hub cooldown: ${identity}/${site} 刚由人完成验证或登录，自动化冷静到 ${new Date(entry.until).toLocaleTimeString()}`), { code: 'HUB_COOLDOWN', until: entry.until, site, cooldown: true });
  if (entry) throw Object.assign(Error(`Site challenged: ${identity}/${site} 刚遇到人机验证，自动化暂停到 ${new Date(entry.until).toLocaleTimeString()}；请在账号页打开网站完成验证`), { code: 'HUB_SITE_CHALLENGED', until: entry.until, site });
  if (navigate && site) {
    const visit = takeVisit(root, identity, site, now);
    if (visit.refused) throw Object.assign(Error(`Rate limited by Hub: ${identity}/${site} 一小时内自动打开网页已达 ${visit.limit} 次，到 ${new Date(visit.until).toLocaleTimeString()} 再继续`), { code: 'HUB_RATE_LIMITED', until: visit.until, site });
  }
}

// Page-level check after a navigation or a failed step. `page` is a Playwright page or a raw
// CDP session with call(). A challenged page is sent to about:blank so it stops retrying.
async function inspectAndLeave(root, { identity, page, cdp, url, source, probeTimeoutMs = 2000 }) {
  let probe, timer;
  try {
    const pending = page ? page.evaluate(CHALLENGE_PROBE)
      : cdp.call('Runtime.evaluate', { expression: CHALLENGE_PROBE, returnByValue: true }).then(r => r.result?.value);
    probe = await Promise.race([pending, new Promise(resolve => { timer = setTimeout(() => resolve(null), probeTimeoutMs); })]);
  } catch { return null; }
  finally { clearTimeout(timer); }
  if (!probe?.challenge) return null;
  const site = siteOf(url || (page ? page.url() : '')) || 'unknown';
  // Leave first: a failed record must never keep the page retrying the check.
  try {
    if (page) await page.goto('about:blank', { waitUntil: 'commit', timeout: 5000 });
    else await cdp.call('Page.navigate', { url: 'about:blank' });
  } catch {}
  try { return recordChallenge(root, { identity, site, kind: probe.kind, source }); }
  catch { return { identity, site, kind: probe.kind, unrecorded: true }; }
}

// Shared by one-shot bridge calls and persistent image lanes. Inspect failures once;
// never replay the operation, whose send/download outcome may already be uncertain.
async function runProtected(root, options, fn) {
  try { return await fn(); }
  catch (error) {
    if (!/^(Site challenged|Human handoff|Hub cooldown|Rate limited by Hub)/.test(error?.message || '') && !handoff(root)
      && await inspectAndLeave(root, options)) {
      throw Object.assign(Error('Site challenged: the page asked for human verification; left it and paused this site'), { cause: error });
    }
    throw error;
  }
}

// Delete challenge-state cookies of one identity's site (partitioned ones included). Runs
// through the identity's own local marker page, never through a website tab.
// Storage.getCookies with the marker's context id fails for the default profile ("Failed to
// find browser context", 2026-10-08), which left every earlier reset silently undone; the
// marker page's own cookie store is that identity's profile, partitioned cookies included.
async function resetChallengeCookies(hub, identity, site, { countersOnly = false } = {}) {
  const hosts = SITES[site] || [];
  const { cdp } = await hub.browser();
  try {
    const marker = await hub.marker(identity, cdp);
    const reader = await hub.page(marker.targetId);
    let cookies;
    try { ({ cookies } = await reader.call('Network.getAllCookies')); } finally { reader.close(); }
    const ofSite = host => hosts.some(h => host === h || host.endsWith('.' + h));
    const partitionHost = c => { try { return new URL(c.partitionKey?.topLevelSite || '').hostname; } catch { return ''; } };
    // Only this site's check state: its own cookies, and Cloudflare's challenge cookies that are
    // partitioned under this site. Another site's check state and every login cookie stay.
    const doomed = cookies.filter(c => CHALLENGE_COOKIE.test(c.name) && (!countersOnly || /^cf_chl_/.test(c.name)) && hosts.length
      && (ofSite(c.domain.replace(/^\./, '')) || (c.domain.replace(/^\./, '').endsWith('cloudflare.com') && ofSite(partitionHost(c)))));
    if (!doomed.length) return 0;
    const page = await hub.page(marker.targetId);
    try {
      for (const c of doomed) await page.call('Network.deleteCookies', { name: c.name, domain: c.domain, path: c.path, ...(c.partitionKey ? { partitionKey: c.partitionKey } : {}) });
    } finally { page.close(); }
    return doomed.length;
  } finally { cdp.close(); }
}

// Give the person the browser: lease first (automation steps now refuse), reset challenge
// state for that site, then a visible window on screen with no debugger attached to it.
async function openForHuman(hub, { identity, url, by = '', reset = true }) {
  const root = hub.root, site = siteOf(url);
  // An ordinary window when the browser is free. While tools have pages open, closing it
  // would break their work: the person gets a window in the running Hub Chrome instead,
  // with no debugger attached, and the lease ends when that window's page is closed.
  let shared = false;
  try { await hub.assertOrdinaryAvailable(); }
  catch (e) { if (e.code !== 'HUB_BROWSER_BUSY') throw e; shared = true; }
  const lease = startHandoff(root, { identity, site, url, by });
  let cleared = 0;
  try { if (site && reset) cleared = await resetChallengeCookies(hub, identity, site); } catch {}
  let opened;
  try { opened = shared ? { mode: 'shared', ...await hub._openVisible(identity, url) } : await hub._openOrdinary(identity, url); }
  catch (e) { endHandoff(root, lease.id); throw e; }
  const extra = shared ? { mode: 'shared', targetId: opened.targetId } : { mode: opened.mode, browserPid: opened.pid };
  update(root, state => { if (state.handoff?.id === lease.id) Object.assign(state.handoff, extra); });
  return { lease: { ...lease, ...extra }, cleared, site };
}

// The person closed the window we gave them: they are done, automation may resume. Check the
// ordinary process/profile lock, or list targets for older leases; never attach to their page.
async function settleHandoff(hub) {
  const stored = read(hub.root).handoff;
  const lease = stored?.mode === 'ordinary' ? stored : handoff(hub.root);
  if (lease?.mode === 'ordinary') {
    // The spawned process exists before it takes the profile lock. That startup gap
    // must not be mistaken for the person having closed their window.
    if (Number.isInteger(lease.browserPid) && require('./web-roundtable/store').alive(lease.browserPid)) return lease;
    // Ordinary Chrome has no CDP target. Its profile lock is the completion signal;
    // expiry alone must never let a tool take over a person's open browser.
    if (await hub.endpoint() || hub.profileHeld()) return lease;
    if (endHandoff(hub.root, lease.id) && lease.site) coolSite(hub.root, lease.identity, lease.site);
    return null;
  }
  if (!lease?.targetId) return lease || null;
  // Only a successful listing without the person's page ends the handoff. An unreadable
  // endpoint (busy port file, slow Chrome) is unknown; the lease expiry still bounds it.
  const ep = await hub.endpoint();
  if (!ep) return lease;
  const { CDP } = require('./web-roundtable/cdp');
  const cdp = await CDP.connect(ep.ws, ep.port);
  try {
    const { targetInfos } = await cdp.call('Target.getTargets');
    if (targetInfos.some(t => t.targetId === lease.targetId)) return lease;
  } finally { cdp.close(); }
  // Closing the window is the person's "done": automation may try that site once more.
  if (endHandoff(hub.root, lease.id) && lease.site) coolSite(hub.root, lease.identity, lease.site);
  return null;
}

module.exports = { siteOf, CHALLENGE_PROBE, CHALLENGE_COOKIE, BACKOFF_MS, HANDOFF_MS, COOLDOWN_MS, VISITS_PER_HOUR, read, recordChallenge, clearSite, releaseSite, coolSite, takeVisit, blocked, runProtected,
  handoff, startHandoff, endHandoff, assertAutomationAllowed, inspectAndLeave, resetChallengeCookies, openForHuman, settleHandoff };
