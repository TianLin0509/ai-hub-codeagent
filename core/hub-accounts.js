'use strict';
const fs = require('fs'), path = require('path');
const { HubChrome, SITES } = require('./hub-chrome');
const { cliAuthStatus } = require('./cli-auth');
const { readPreferences, updatePreferences } = require('./hub-account-preferences');
const { inspectAccounts, inspectCookies, cookieSite } = require('./hub-login-check');
const ROUNDTABLE_PROVIDER = { chatgpt: 'chatgpt', google: 'gemini', deepseek: 'deepseek', doubao: 'doubao', kimi: 'kimi', qwen: 'qwen' };
// Background confirmation: about twice a day, when nobody needs the browser. An account the
// person opened while it needed attention is looked at again soon, so the badge clears by
// itself once they have signed in.
const AUTO = { tickMs: 60000, firstMs: 3 * 60000, dueMs: 12 * 3600000, retryMs: 30 * 60000, recheckAfterMs: 90000, recheckEveryMs: 5 * 60000, recheckForMs: 3600000 };

class HubAccounts {
  constructor({ hubChrome, personalChrome, getConfig = () => require('./hub-config').getConfig(), env = process.env, recovery, now = Date.now, inspect = inspectCookies, inspectLive = inspectAccounts, getToolCatalog } = {}) {
    // The AI browser: the Hub Chrome every web tool drives. The person's own browser is a copy
    // of it that automation never touches (personal-chrome.js).
    this.chrome = hubChrome || new HubChrome({ env, proxy: () => getConfig().proxy });
    this.personal = personalChrome || new (require('./personal-chrome').PersonalChrome)({ env, proxy: () => getConfig().proxy });
    Object.assign(this, { getConfig, env, recovery, now, inspect, inspectLive, getToolCatalog });
    this.checking = null; this.progress = null; this.lastState = null;
    this.rechecks = new Map(); this.autoTried = 0; this.attention = null;
    this.setup = new (require('./hub-browser-setup').HubBrowserSetup)({ root: this.chrome.root, env });
  }
  cacheFile() { return path.join(this.chrome.root, 'last-check.json'); }
  async toolAccounts(refresh = false) {
    if (!this.getToolCatalog) throw Error('工具目录服务未连接，请重新打开新版 Hub');
    const catalog = await this.getToolCatalog(refresh);
    return require('./tool-accounts').buildToolAccounts(catalog, { root: this.chrome.root,
      homeDir: this.env.CLAUDE_HUB_HOME_DIR || require('os').homedir(), env: this.env });
  }
  async external({ service, action }) {
    const external = require('./external-accounts');
    const research = external.RESEARCH_SITES.includes(service);
    if (service !== 'github') throw Error('外部服务标识无效');
    external.externalSite(service);
    if (!['open', 'check', 'authorize'].includes(action)) throw Error('外部账号操作无效');
    if (this.setup.flight) throw Error('请等待工具接入完成');
    if (action === 'open') await this.yieldCheck();
    else if (this.checking || this.startingCheck) throw Error('请等待登录确认完成');
    if (action !== 'open' && service !== 'github') throw Error('此服务请在专属 Chrome 中确认登录');
    const fixture = this.fixture();
    if (fixture?.recordOpens) {
      fs.appendFileSync(path.join(this.env.CLAUDE_HUB_HOME_DIR, 'external-open.jsonl'), JSON.stringify({ service, action, identity: 'main' }) + '\n');
      if (action === 'check') external.writeExternalState(this.chrome.root, service, { state: 'signed_in', account: 'fixture-github', source: 'fixture', checkedAt: this.now() });
    } else if (action === 'open') {
      // Research sites feed the AI tools' cookie export, so they are signed in there.
      if (research) await this.chrome.openWebsite('main', service);
      else await this.openPersonal('main', service);
    }
    else if (action === 'check') {
      const isolated = this.env.CLAUDE_HUB_HOME_DIR || this.env.CLAUDE_HUB_DATA_DIR;
      if (isolated) throw Error('隔离实例不会核对或修改真实 GitHub 授权');
      external.writeExternalState(this.chrome.root, service, await external.githubStatus(this.env));
    } else {
      if (this.env.CLAUDE_HUB_HOME_DIR || this.env.CLAUDE_HUB_DATA_DIR) throw Error('隔离实例不会启动真实 GitHub 授权');
      const browser = '"' + process.execPath + '" "' + path.resolve(__dirname, '../scripts/open-hub-github-auth.js') + '"';
      await require('./account-adapters').openTerminal(external.githubCommand(this.env), ['auth', 'login', '--hostname', 'github.com', '--web', '--git-protocol', 'https', '--skip-ssh-key'],
        { ...this.env, GH_BROWSER: browser, ELECTRON_RUN_AS_NODE: '1' });
    }
    let usageWarning = '';
    if (action === 'open') try { require('./hub-account-activity').recordActivity(this.chrome.root, { site: service, outcome: 'opened', at: this.now() }); }
    catch { usageWarning = '；使用记录未保存'; }
    return { message: (action === 'check' ? 'GitHub 授权检查已完成，结果显示在外部服务中' : action === 'authorize' ? '已打开 GitHub 官方授权窗口，请按提示完成授权后检查' : '已在专属 Chrome 打开 ' + external.externalSite(service).name) + usageWarning };
  }
  readCache() {
    try {
      const value = JSON.parse(fs.readFileSync(this.cacheFile(), 'utf8'));
      if (!value?.identities || typeof value.identities !== 'object') throw Error('invalid');
      return value;
    } catch (e) { if (e.code === 'ENOENT') return { identities: {} }; throw Error('登录检查记录无法读取，请保留 last-check.json 并检查文件'); }
  }
  writeCache(cache) {
    fs.mkdirSync(this.chrome.root, { recursive: true });
    const file = this.cacheFile(), tmp = file + '.' + require('crypto').randomUUID() + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(cache), 'utf8'); fs.renameSync(tmp, file);
  }
  fixture() {
    const file = this.env.CLAUDE_HUB_HOME_DIR && this.env.HUB_ACCOUNTS_FIXTURE;
    if (!file) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  }
  async state() {
    if (this.checking && this.lastState) return this.publicState();
    if (this.lastState && this.progress?.finishedAt && this.now() - this.progress.finishedAt < 30000) return this.publicState();
    if (!this.reading) this.reading = this.compose().then(value => { this.lastState = value; return this.publicState(); }).finally(() => { this.reading = null; });
    return this.reading;
  }
  async passiveState() { return this.publicState(await this.compose({ passive: true })); }
  // Paused sites and a person's handoff, for the account page. Reading is file-only; while a
  // handoff runs, a browser-level target listing ends it once the person closed the window.
  riskState() {
    const guard = require('./web-risk-guard'), now = this.now(), risk = guard.read(this.chrome.root);
    if (risk.handoff) guard.settleHandoff(this.chrome).catch(() => {});
    const shared=require('./ordinary-browser-client').enabled({identity:'main',root:this.chrome.root},this.env),root=shared?require('./personal-chrome').personalRoot(this.env):this.chrome.root;
    const ordinary=shared?guard.read(root):{sites:{}};
    return { handoff: guard.handoff(root,now)||guard.handoff(this.chrome.root, now),
      sites: Object.fromEntries(Object.entries({...risk.sites,...ordinary.sites}).filter(([, e]) => e.until > now).map(([k, e]) => [k, { at: e.at, until: e.until, strikes: e.strikes, kind: e.kind, source: e.source || '' }])) };
  }
  publicState(value = this.lastState) {
    const risk = this.riskState(), activity = require('./hub-account-activity').readActivity(this.chrome.root, this.env);
    const { accountHealth } = require('./hub-account-health'), now = this.now();
    const identities = (value?.identities || []).map(identity => ({ ...identity, sites: identity.sites.map(site => ({ ...site,
      health: accountHealth({ site, activity: activity.entries[identity.id + ':' + site.key], paused: risk.sites[identity.id + ':' + site.key], now }) })) }));
    const attention = identities.reduce((n, i) => n + i.sites.filter(s => s.health.state === 'attention').length, 0);
    return JSON.parse(JSON.stringify({ ...value, identities, attention, risk,
      ...(this.setup.progress?.status === 'complete' ? { tools: require('./hub-browser-tool').integrationStatus(this.chrome.root) } : {}),
      activity, webTools: require('./web-tool-status').readWebTools({ root: this.chrome.root, env: this.env, recovery: this.recovery, now }),
      progress: this.progress, setupProgress: this.setup.progress }));
  }
  async compose({ passive = false } = {}) {
    const cache = this.readCache(), preferences = readPreferences(this.chrome.root);
    const running = passive ? null : await this.chrome.running(), identities = [];
    for (const identity of this.chrome.identities) {
      let status;
      try { status = passive ? { sites: {} } : await this.chrome.loginStatus(identity.id, { live: false }); }
      catch (e) { status = { sites: {}, error: e.message }; }
      const prev = cache.identities[identity.id] || {};
      const sites = identity.sites.filter(key => identity.id === 'main' || preferences.sites[key]?.secondary).map(key => {
        let observed = status.sites?.[key] || { state: 'unknown', error: status.error };
        const prior = prev.sites?.[key];
        if (prior?.checkedAt && observed.state !== 'signed_out') observed = { ...prior, stale: true, live: false };
        return { key, name: SITES[key].name, url: SITES[key].url, ...observed };
      });
      const chatgpt = sites.find(s => s.key === 'chatgpt');
      const account = chatgpt?.state === 'signed_out' ? '' : status.account || prev.account || '';
      identities.push({ id: identity.id, label: identity.label, account, accountStale: !status.account && !!account, sites });
    }
    const clis = cliAuthStatus({ env: this.env, config: this.getConfig(), now: this.now() }).map(cli => ({ ...cli, identity: this.owner(cli, identities) }));
    let network;try{network=this.chrome.routingStatus?.();}catch(e){network={state:'invalid',message:e.message};}
    return { chrome: { running, loginOpen: passive ? null : !running && this.chrome.profileHeld(), root: this.chrome.root, network }, identities, clis, preferences,
      tools: require('./hub-browser-tool').integrationStatus(this.chrome.root), checkedAt: cache.checkedAt || 0 };
  }
  // Routine checks read login cookies only. `live` (the person's 复核并继续原任务) visits that
  // one website to prove a fresh login before a waiting web task is resumed.
  async startCheck({ identity, site, only, auto = false, live = false } = {}) {
    if (this.setup.flight) throw Error('正在接入网页工具，请等待完成后检查');
    if (this.checking) return this.publicState();
    if (this.startingCheck) return this.startingCheck;
    this.startingCheck = (async () => {
      await this.state();
      const items = this.lastState.identities.flatMap(i => i.sites.map(s => ({ identity: i.id, site: s.key, state: 'queued' })))
        .filter(item => (!identity || item.identity === identity) && (!site || item.site === site)
          && (!only || only.some(o => o.identity === item.identity && o.site === item.site))
          && (live||this.inspect!==inspectCookies||this.fixture()||!require('./ordinary-browser-check').sharedSites.has(item.site)||!require('./ordinary-browser-client').enabled({identity:item.identity,root:this.chrome.root},this.env))
          && (live || this.inspect !== inspectCookies || cookieSite(item.site)));
      if (live && items.length > 1) throw Error('复核只针对一个账号');
      if (!items.length) throw Error('这个网站的登录无法从本机记录读取，打开网页即可确认');
      this.abort = new AbortController();
      // Only observations produced by this run may release waiting website tasks.
      for (const row of this.lastState.identities) for (const observed of row.sites) {
        observed.live = false;
        if (observed.checkedAt) observed.stale = true;
      }
      this.progress = { id: require('crypto').randomUUID(), status: 'running', auto, done: 0, total: items.length, startedAt: this.now(), current: null, stage: '准备检查', items };
      const progress = this.progress;
      this.checking = Promise.resolve().then(() => (live ? this.inspectLive : this.inspect)({ chrome: this.chrome, items, signal: this.abort.signal, fixture: this.fixture(),
        onStage: (item, stage) => { progress.current = item ? { identity: item.identity, site: item.site } : null; progress.stage = stage; if (item) item.state = 'checking'; },
        onResult: async (item, result) => {
          const cache = this.readCache();
          const entry = cache.identities[item.identity] ||= { sites: {} };
          // Remember that the login once worked: a later sign-out is then a lost login.
          const before = entry.sites?.[item.site];
          const signedInAt = result.state === 'signed_in' ? this.now() : before?.state === 'signed_in' && before.verified !== false ? before.checkedAt : before?.lastSignedInAt;
          const checked = { ...result, checkedAt: this.now(), ...(signedInAt ? { lastSignedInAt: signedInAt } : {}) };
          entry.sites ||= {}; entry.sites[item.site] = checked;
          if (item.site === 'chatgpt') {
            if (checked.state === 'signed_out') entry.account = '';
            else if (checked.account) entry.account = checked.account;
          }
          cache.checkedAt = this.now(); this.writeCache(cache);
          const row = this.lastState.identities.find(i => i.id === item.identity);
          const at = row.sites.findIndex(s => s.key === item.site);
          row.sites[at] = { key: item.site, name: SITES[item.site].name, url: SITES[item.site].url, ...checked };
          if (item.site === 'chatgpt') { row.account = entry.account || ''; row.accountStale = !!row.account && !checked.account; }
          item.state = checked.state; item.reason = checked.reason || ''; item.error = checked.error || ''; progress.done++;
          this.lastState.checkedAt = cache.checkedAt;
        },
      })).then(async outcome => {
        progress.status = this.abort.signal.aborted ? 'cancelled' : outcome?.yielded ? 'yielded' : 'complete';
        progress.stage = { cancelled: '已取消，已完成的结果已保留', yielded: '浏览器被使用，稍后继续确认' }[progress.status] || '检查完成';
        await this.resumeWaiting(this.lastState.identities);
      }).catch(e => { progress.status = 'failed'; progress.error = e.message; progress.stage = '检查未完成'; })
        .finally(() => { progress.current = null; progress.finishedAt = this.now(); this.checking = null; this.emitAttention(); });
      return this.publicState();
    })().finally(() => { this.startingCheck = null; });
    return this.startingCheck;
  }
  async check(options = {}) { await this.startCheck(options); await this.checking; return this.publicState(); }
  cancelCheck() { this.abort?.abort(); if (this.checking) this.progress.stage = '正在取消并释放检查资源'; return this.publicState(); }
  // A person's click always wins over a background confirmation in this Hub.
  async yieldCheck() {
    if (this.startingCheck) await this.startingCheck.catch(() => {});
    if (!this.checking) return;
    this.abort?.abort();
    await Promise.race([this.checking, new Promise(resolve => setTimeout(resolve, 20000))]);
  }
  owner(cli, identities) {
    if (!cli.account || !cli.site) return '';
    const matches = identities.filter(i => {
      const site = i.sites.find(s => s.key === cli.site);
      const account = site?.state === 'signed_out' ? '' : site?.account || (cli.site === 'chatgpt' ? i.account : '');
      return account && account.toLowerCase() === cli.account.toLowerCase();
    });
    return matches.length === 1 ? matches[0].id : '';
  }
  async resumeWaiting(identities) {
    if (!this.recovery) return;
    for (const identity of identities.filter(i => i.id === 'main')) for (const site of identity.sites) {
      const provider = ROUNDTABLE_PROVIDER[site.key];
      if (!provider || site.state !== 'signed_in' || !site.live || site.stale) continue;
      try {
        const result = await this.recovery.resume({ managedBrowser: true, provider });
        if (result.errors?.length && this.progress) (this.progress.warnings ||= []).push((site.name || site.key) + '：部分原任务未恢复，请在原会话查看任务状态');
      }
      catch (e) { if (this.progress) (this.progress.warnings ||= []).push((site.name || site.key) + '：任务恢复失败，' + e.message); }
    }
  }
  async preference(options) {
    await this.chrome.lifecycle(() => updatePreferences(this.chrome.root, options));
    this.lastState = null;
    return this.passiveState();
  }
  async open({ identity, site, login = false }) {
    if (!SITES[site]) throw Error('请选择 AI 网页');
    await this.yieldCheck();
    const prefs = readPreferences(this.chrome.root).sites[site];
    identity ||= prefs.preferred;
    if (identity === 'alt' && !prefs.secondary) throw Error('请先添加第二个账号');
    this.chrome.identity(identity);
    const fixture = this.fixture();
    // An account that needs the person is looked at again a little after they open it, so
    // the badge clears by itself once they have signed in or passed the check.
    let before = '';
    try { before = (await this.passiveState()).identities.find(i => i.id === identity)?.sites.find(s => s.key === site)?.health?.state || ''; } catch {}
    let opened;
    if (fixture?.recordOpens) {
      fs.appendFileSync(path.join(this.env.CLAUDE_HUB_HOME_DIR, 'accounts-open.jsonl'), JSON.stringify({ identity, site, url: SITES[site].url, browser: login ? 'ai' : 'personal' }) + '\n');
    } else if (login && require('./ordinary-browser-check').sharedSites.has(site) && require('./ordinary-browser-client').enabled({identity,root:this.chrome.root},this.env)) {
      const transport=require('./ordinary-browser-client');
      opened=await transport.call(transport.options({identity},this.env),'account-person-'+identity,['human-open',SITES[site].url]);
      opened.mode='personal';
    } else if (login) opened = await this.chrome.openLogin(identity, [site]);
    else opened = await this.openPersonal(identity, site);
    if (before !== 'ok') this.rechecks.set(identity + ':' + site, { identity, site, from: this.now() });
    this.lastState = null;
    let usageWarning = '';
    try { require('./hub-account-activity').recordActivity(this.chrome.root, { identity, site, outcome: 'opened', at: this.now() }); }
    catch { usageWarning = '；使用记录未保存'; }
    const name = SITES[site].name;
    if (login) {
      if(opened?.mode==='personal')return {identity,site,message:'已在账号 Tab 的普通浏览器打开 '+name+'；自动化已断开，完成后继续原任务，无需关闭浏览器'+usageWarning};
      const shared = opened?.mode === 'shared' ? '；AI 工具正在用它，若网站提示浏览器不安全，等工具空闲后再点一次' : '';
      return { identity, site, message: '已在 AI 浏览器打开 ' + name + ' 的登录页。登录或验证完成后关掉这个窗口，AI 工具就能继续用' + shared + usageWarning };
    }
    return { identity, site, message: (opened?.mode === 'personal' ? '已在你的浏览器打开 ' : '已在专属 Chrome 打开 ') + name + (opened?.note || '') + usageWarning };
  }
  // The person's own browser. Prepared on first use from the AI browser's profile (so every
  // login is already there); that needs the AI browser closed for a few seconds.
  async openPersonal(identity, siteKey) {
    const url = this.chrome.site(siteKey).url;
    let note = '';
    if (!this.personal.ready()) {
      try {
        await this.personal.prepare(this.chrome);
        note = '（第一次使用：已为你复制好一个独立的浏览器，登录都还在，AI 工具以后不会再碰它）';
      } catch (e) {
        if (!['HUB_WINDOW_OPEN', 'HUB_BROWSER_BUSY', 'HUB_NO_PROFILE'].includes(e.code)) throw e;
        const opened = await this.chrome.openWebsite(identity, siteKey);
        return { ...opened, note: '。你的独立浏览器要在专属 Chrome 关闭时才能准备好，这次先在专属 Chrome 打开' };
      }
    }
    return { ...await this.personal.open(identity, [url]), note };
  }
  // The person signed in again in their browser: the AI browser gets the same logins.
  async copyLogins({ identity = 'main' } = {}) {
    await this.yieldCheck();
    this.chrome.identity(identity);
    const r = await this.personal.copyLoginsTo(this.chrome, identity);
    this.lastState = null;
    try { await this.startCheck({ identity }); await this.checking; } catch { /* the next routine check reads it */ }
    return { ...(await this.passiveState()), message: '已把你浏览器里的登录复制给 AI 浏览器' + (r.scrubbed ? '（顺带清掉了 ' + r.scrubbed + ' 个网站验证记录）' : '') };
  }
  async login({ identity = 'main', site } = {}) {
    if (site) return this.open({ identity, site, login: true });
    await this.chrome.openLogin(identity, this.lastState?.identities.find(i => i.id === identity)?.sites.map(s => s.key));
    return { identity };
  }

  // ---- background confirmation and the sidebar badge ----
  startAuto({ onAttention, options = {} } = {}) {
    this.auto = { ...AUTO, ...options };
    this.onAttention = onAttention;
    // An isolated Hub never visits real websites; its tests opt in with a fixture.
    const real = !(this.env.CLAUDE_HUB_HOME_DIR || this.env.CLAUDE_HUB_DATA_DIR) || (this.env.HUB_ACCOUNTS_AUTO === '1' && !!this.fixture());
    const first = setTimeout(() => { void this.autoTick({ real }); this.autoTimer = setInterval(() => void this.autoTick({ real }), this.auto.tickMs); }, this.auto.firstMs);
    first.unref?.();
    this.autoFirst = first;
    // The badge is right from the start, before any check.
    void this.emitAttention();
  }
  stopAuto() { clearTimeout(this.autoFirst); clearInterval(this.autoTimer); }
  async emitAttention(state) {
    if (!this.onAttention) return;
    try {
      state ||= await this.passiveState();
      this.lastEmit = this.now();
      if (state.attention !== this.attention) { this.attention = state.attention; this.onAttention(state.attention); }
    } catch { /* a transient read failure keeps the last badge */ }
  }
  // What is due now: sites the person opened recently (checked a little after, then every few
  // minutes for an hour), or everything when the last full confirmation is half a day old.
  dueItems(state) {
    const now = this.now(), auto = this.auto || AUTO, due = [];
    for (const [key, r] of this.rechecks) {
      if (now - r.from > auto.recheckForMs) { this.rechecks.delete(key); continue; }
      const site = state.identities.find(i => i.id === r.identity)?.sites.find(s => s.key === r.site);
      if (!site) { this.rechecks.delete(key); continue; }
      if (site.checkedAt > r.from && site.health?.state === 'ok') { this.rechecks.delete(key); continue; }
      // Still signed out: the person may still be signing in, keep looking. A site whose
      // background check stays inconclusive (blocked by its own check) is left after 3 tries.
      if (site.checkedAt > (r.seenAt || r.from)) { r.seenAt = site.checkedAt; if (!site.verified) r.misses = (r.misses || 0) + 1; }
      if ((r.misses || 0) >= 3) { this.rechecks.delete(key); continue; }
      const last = Math.max(site.checkedAt > r.from ? site.checkedAt : 0, r.lastTry || 0);
      if (now - r.from >= auto.recheckAfterMs && now - last >= auto.recheckEveryMs) due.push(r);
    }
    if (due.length) return due;
    const oldest = Math.min(...state.identities.flatMap(i => i.sites.filter(s => cookieSite(s.key)).map(s => s.checkedAt || 0)));
    if (now - oldest >= auto.dueMs && now - this.autoTried >= auto.retryMs) return null;  // null = everything
    return [];
  }
  async autoTick({ real = true } = {}) {
    if (this.ticking) return;
    this.ticking = true;
    try {
      // Reading every record is cheap but not free: once every few minutes, or while a
      // recently opened account waits to be looked at again.
      if (!this.rechecks.size && this.now() - (this.lastEmit || 0) < (this.auto?.badgeEveryMs ?? 5 * 60000)) return;
      const state = await this.passiveState();
      await this.emitAttention(state);
      if (!real || this.checking || this.startingCheck || this.setup.flight) return;
      const due = this.dueItems(state);
      if (due && !due.length) return;
      // Nothing is read through a person's ordinary window or during a handoff; try later.
      if (state.risk.handoff || (!(await this.chrome.endpoint()) && this.chrome.profileHeld())) return;
      if (due) for (const r of due) r.lastTry = this.now(); else this.autoTried = this.now();
      await this.startCheck({ only: due || undefined, auto: true });
      await this.checking;
      await this.emitAttention();
    } catch { /* a failed background round is retried on a later tick */ }
    finally { this.ticking = false; }
  }
}
module.exports = { HubAccounts, ROUNDTABLE_PROVIDER };
