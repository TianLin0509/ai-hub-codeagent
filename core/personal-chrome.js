'use strict';
// The person's own browser (2026-10-08). The Hub Chrome (hub-chrome.js) is where the web tools
// work: it runs with a debugging port and anti-throttling switches, and Cloudflare kept the
// person looping on "Verify you are human" there. The same profile launched as a plain Chrome
// passed at once (observed 2026-10-08 02:30). So the person gets a browser of their own that
// automation never touches, launched exactly like an ordinary Chrome.
//
// It starts as a copy of the Hub Chrome's profiles (logins, bookmarks, extensions, history;
// caches and Cloudflare challenge state are left behind), so nobody signs in again. Both live
// under the same Windows user, and this Chrome keeps its cookie key in Local State, so the copy
// decrypts as is. Copying needs both browsers closed: Chrome holds its databases exclusively.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const routing = require('./hub-browser-routing');

const MARKER = 'personal-browser.json';
// Rebuilt by Chrome on demand; copying them only costs time and disk.
const SKIP = new Set(['Cache', 'Code Cache', 'GPUCache', 'DawnGraphiteCache', 'DawnWebGPUCache', 'GrShaderCache',
  'ShaderCache', 'CacheStorage', 'blob_storage', 'Sessions', 'Crashpad', 'optimization_guide_hint_cache_store',
  'optimization_guide_model_metadata_store', 'Download Service', 'BudgetDatabase', 'LOCK', 'lockfile']);
// What carries a login, for refreshing the AI browser from the person's one later.
const LOGIN_PARTS = [['Network', 'Cookies'], ['Network', 'Cookies-journal'], ['Local Storage'], ['IndexedDB'], ['Session Storage']];

function personalRoot(env = process.env) {
  if (env.HUB_PERSONAL_CHROME_ROOT) return path.resolve(env.HUB_PERSONAL_CHROME_ROOT);
  if (env.CLAUDE_HUB_DATA_DIR || env.CLAUDE_HUB_HOME_DIR) return path.join(path.resolve(env.CLAUDE_HUB_DATA_DIR || env.CLAUDE_HUB_HOME_DIR), 'hub-personal-chrome');
  return path.join(require('./data-dir').getHubDataDir(), 'hub-personal-chrome');
}
// A directory that was just written can be briefly held by Windows Defender or
// the search indexer, and renaming it then fails with EPERM/EBUSY/EACCES (seen
// 1 in 4 isolated runs, 2026-10-08). Wait for the scanner instead of failing.
async function renameWhenReleased(from, to, attempts = 8) {
  for (let attempt = 1; ; attempt++) {
    try { fs.renameSync(from, to); return; }
    catch (error) {
      if (!['EPERM', 'EBUSY', 'EACCES'].includes(error.code) || attempt >= attempts || fs.existsSync(to)) throw error;
      await new Promise(resolve => setTimeout(resolve, 50 * attempt));
    }
  }
}

function copyTree(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue;
    const a = path.join(from, entry.name), b = path.join(to, entry.name);
    if (entry.isDirectory()) copyTree(a, b);
    else if (entry.isFile()) fs.copyFileSync(a, b);
  }
}
// Challenge state only; login cookies stay. Names are stored in clear even when values are not.
function scrubChallengeCookies(profileDir) {
  const db = path.join(profileDir, 'Network', 'Cookies');
  if (!fs.existsSync(db)) return 0;
  const { DatabaseSync } = require('node:sqlite');
  const conn = new DatabaseSync(db);
  try {
    return Number(conn.prepare("DELETE FROM cookies WHERE name IN ('cf_clearance','__cf_bm') OR name LIKE 'cf\\_chl\\_%' ESCAPE '\\'").run().changes || 0);
  } finally { conn.close(); }
}
function held(root) {
  try { fs.closeSync(fs.openSync(path.join(root, 'lockfile'), 'r+')); return false; }
  catch (e) { if (e.code === 'ENOENT') return false; if (['EBUSY', 'EPERM', 'EACCES'].includes(e.code)) return true; throw e; }
}

class PersonalChrome {
  constructor({ root, env = process.env, spawnImpl = spawn, executable, proxy, identities = ['main', 'alt'] } = {}) {
    this.root = root || personalRoot(env);
    Object.assign(this, { env, spawn: spawnImpl, identities, proxy });
    this.executable = executable || (() => require('./hub-chrome').chromeExecutable(env));
  }
  ready() { return fs.existsSync(path.join(this.root, MARKER)); }
  held() { return held(this.root); }
  proxyServer() {
    const value = typeof this.proxy === 'function' ? this.proxy() : this.proxy === undefined ? require('./hub-config').getConfig().proxy : this.proxy;
    return routing.normalizeProxy(value);
  }
  // Exactly an ordinary Chrome: the profile, the Hub's proxy, nothing else. No debugging port,
  // no background switches, no window placement.
  launchArgs(identityId, urls = []) {
    return [...routing.policy(this.proxyServer()).args, '--user-data-dir=' + this.root, '--profile-directory=' + identityId,
      '--no-first-run', '--no-default-browser-check', ...[].concat(urls)];
  }
  open(identityId, urls) {
    if (!this.identities.includes(identityId)) throw Error('未知的账号身份：' + identityId);
    if (!this.ready()) throw Object.assign(Error('你的浏览器还没准备好'), { code: 'PERSONAL_NOT_READY' });
    return new Promise((resolve, reject) => {
      const child = this.spawn(this.executable(), this.launchArgs(identityId, urls), { env: this.env, detached: true, stdio: 'ignore' });
      child.once('error', reject);
      child.once('spawn', () => { child.unref(); resolve({ identity: identityId, mode: 'personal', pid: child.pid }); });
    });
  }
  // One-time copy from the Hub Chrome. `hub` must be closed (its idle debugging Chrome is
  // closed here; a window someone uses, or a tool's page, is never closed).
  async prepare(hub) {
    if (this.ready()) return { prepared: false };
    await releaseHub(hub);
    if (!fs.existsSync(path.join(hub.root, 'Local State'))) throw Object.assign(Error('专属 Chrome 还没有可复制的资料'), { code: 'HUB_NO_PROFILE' });
    const staging = this.root + '.staging';
    fs.rmSync(staging, { recursive: true, force: true });
    fs.mkdirSync(staging, { recursive: true });
    fs.copyFileSync(path.join(hub.root, 'Local State'), path.join(staging, 'Local State'));
    let scrubbed = 0;
    const copied = [];
    for (const id of this.identities) {
      const from = path.join(hub.root, id);
      if (!fs.existsSync(from)) continue;
      copyTree(from, path.join(staging, id));
      scrubbed += scrubChallengeCookies(path.join(staging, id));
      copied.push(id);
    }
    fs.writeFileSync(path.join(staging, MARKER), JSON.stringify({ version: 1, from: hub.root, at: Date.now(), profiles: copied, scrubbed }), 'utf8');
    if (fs.existsSync(this.root)) throw Error('你的浏览器目录已存在但未完成准备，请保留并检查：' + this.root);
    await renameWhenReleased(staging, this.root);
    return { prepared: true, profiles: copied, scrubbed };
  }
  // The person signed in again in their browser: give the AI browser the same logins.
  async copyLoginsTo(hub, identityId) {
    if (!this.ready()) throw Error('你的浏览器还没准备好');
    if (this.held()) throw Object.assign(Error('请先关闭你的浏览器窗口，再把登录复制给 AI'), { code: 'PERSONAL_OPEN' });
    await releaseHub(hub);
    const from = path.join(this.root, identityId), to = path.join(hub.root, identityId);
    if (!fs.existsSync(from)) throw Error('你的浏览器里还没有这个账号的资料');
    for (const parts of LOGIN_PARTS) {
      const a = path.join(from, ...parts), b = path.join(to, ...parts);
      if (!fs.existsSync(a)) continue;
      fs.rmSync(b, { recursive: true, force: true });
      if (fs.statSync(a).isDirectory()) copyTree(a, b);
      else { fs.mkdirSync(path.dirname(b), { recursive: true }); fs.copyFileSync(a, b); }
    }
    return { identity: identityId, scrubbed: scrubChallengeCookies(to) };
  }
}
// The Hub Chrome's files can only be copied with it closed.
async function releaseHub(hub) {
  await hub.lifecycle(async () => {
    const ep = await hub.endpoint();
    if (!ep && hub.profileHeld()) throw Object.assign(Error('专属 Chrome 的窗口开着：关掉它后再试，登录会保留'), { code: 'HUB_WINDOW_OPEN' });
    if (ep) {
      const busy = await hub.workTabs();
      if (busy) throw Object.assign(Error(`AI 工具正在专属 Chrome 里工作（${busy} 个页面），稍后再试`), { code: 'HUB_BROWSER_BUSY' });
      await hub.close();
    }
  });
}
module.exports = { PersonalChrome, personalRoot, scrubChallengeCookies, MARKER };
