'use strict';
// Compatibility transport for the existing image queue and company bridge. Each lane
// keeps its own page; jobs, idempotency keys and bridge cursors remain in their tools.
const fs = require('fs');
const path = require('path');
const { HubChrome, defaultRoot } = require('./hub-chrome');
const guard = require('./web-risk-guard');

function argumentsOf(argv) {
  const args = [...argv];
  const session = args.indexOf('--session');
  if (session >= 0) args.splice(session, 2);
  const json = args.indexOf('--json');
  if (json >= 0) args.splice(json, 1);
  return args;
}
function validateBinding(binding, env = process.env) {
  if (!binding || !['images', 'bridge'].includes(binding.tool) || !['main', 'alt'].includes(binding.identity)
      || !/^[a-z0-9_-]{1,64}$/.test(binding.id) || !path.isAbsolute(binding.root) || !path.isAbsolute(binding.playwright)) {
    throw Error('Invalid Hub browser binding');
  }
  if ((env.CLAUDE_HUB_DATA_DIR || env.CLAUDE_HUB_HOME_DIR || env.HUB_CHROME_ROOT)
      && path.resolve(defaultRoot(env)).toLowerCase() !== path.resolve(binding.root).toLowerCase()) {
    throw Error('Isolated Hub cannot access another browser root');
  }
}
function save(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.' + require('crypto').randomUUID() + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(value), 'utf8');
  fs.renameSync(tmp, file);
}
function read(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } }
function integrationStatus(root) {
  const manifest = read(path.join(root, 'tool-bindings.json'));
  const tools = Array.isArray(manifest?.tools) ? manifest.tools : [];
  return ['images', 'bridge'].map(tool => {
    const entries = tools.filter(t => t && t.tool === tool);
    const connected = entries.filter(t => {
      if (typeof t.config !== 'string' || typeof t.entry !== 'string') return false;
      const config = read(t.config);
      return require('./hub-tool-binding').matchesBinding(t, config, { requireEntry: true });
    });
      return { tool, name: tool === 'images' ? '网页生图' : '中转工具', state: connected.length && connected.length === entries.length ? 'connected' : entries.length ? 'changed' : 'pending',
      identities: ['main', 'alt'].map(identity => ({ identity, count: connected.filter(t => t.identity === identity).length })).filter(i => i.count) };
  });
}

class BrowserTool {
  constructor(binding, { env = process.env, hub, chromium } = {}) {
    validateBinding(binding, env);
    this.binding = binding;
    this.hub = hub || new HubChrome({ root: binding.root, env });
    this.chromium = chromium;
    this.file = path.join(binding.root, 'tool-pages', binding.id + '.json');
  }
  async target() {
    const record = read(this.file);
    if (!record) return null;
    // A busy local CDP endpoint can miss its short health deadline while Chrome
    // and the owned tab still exist. Recheck once before declaring the page gone.
    const ep = await this.hub.endpoint() || await this.hub.endpoint();
    // A missing health response is not proof that Chrome or the old task is gone.
    // Keep its binding while the profile is held; opening again would orphan that task.
    if (!ep && this.hub.profileHeld()) throw Error('Timeout: Hub browser endpoint unavailable; existing page preserved');
    if (!record || !ep || record.browserWs !== ep.ws || record.identity !== this.binding.identity) return null;
    const { CDP } = require('./web-roundtable/cdp');
    const cdp = await CDP.connect(ep.ws, ep.port);
    try {
      const { targetInfos } = await cdp.call('Target.getTargets');
      const marker = targetInfos.find(t => t.url === this.hub.markerUrl(this.binding.identity));
      const target = targetInfos.find(t => t.targetId === record.targetId && t.type === 'page');
      return marker && target && target.browserContextId === marker.browserContextId ? { ...record, ep, url: target.url } : null;
    } finally { cdp.close(); }
  }
  async open(url = 'about:blank') {
    const existing = await this.target();
    if (existing) return { targetId: existing.targetId, reused: true };
    const tab = await this.hub.openTab(this.binding.identity, url);
    const ep = await this.hub.endpoint() || await this.hub.endpoint();
    try { save(this.file, { targetId: tab.targetId, browserWs: ep.ws, identity: this.binding.identity }); }
    catch (e) { await this.hub.closeTab(tab.targetId); throw e; }
    return { targetId: tab.targetId, reused: false };
  }
  async withPage(fn, { downloads = false } = {}) {
    guard.assertAutomationAllowed(this.binding.root, { identity: this.binding.identity });
    const target = await this.target();
    if (!target) throw Error('No browser session: owned Hub page is not open');
    guard.assertAutomationAllowed(this.binding.root, { identity: this.binding.identity });
    // Attached to the owned page only: never the person's windows, other tools' tabs or the
    // challenge frame inside a page (see scoped-cdp.js).
    const connection = await this.connectPage(target, { downloads });
    try {
      guard.assertAutomationAllowed(this.binding.root, { identity: this.binding.identity, url: connection.page.url() });
      return await guard.runProtected(this.binding.root, {
        identity: this.binding.identity, page: connection.page, source: this.binding.id,
      }, () => fn(connection.page));
    } finally { await connection.close(); }
  }
  async connectPage(target, { downloads = false } = {}) {
    const chromium = this.chromium || require(this.binding.playwright).chromium;
    return require('./scoped-cdp').connectPage(chromium, target.ep, target.targetId, { downloads });
  }
  async execute(argv) {
    const [command, ...args] = argumentsOf(argv);
    const root = this.binding.root, identity = this.binding.identity;
    if (guard.read(root).handoff) await guard.settleHandoff(this.hub).catch(() => {});
    // A person asked to verify or sign in: the browser is theirs until they finish or 15 min pass.
    if (command === 'human-open') {
      const url = args.find(a => !a.startsWith('--')) || 'https://chatgpt.com/';
      const { lease, cleared, site } = await this.hub.lifecycle(async () => {
        // The guard has already parked a challenged task at about:blank. Close only
        // this tool's verified, empty page so it cannot block an ordinary handoff.
        const owned = await this.target();
        if (owned?.url === 'about:blank') {
          await this.hub.closeTab(owned.targetId);
          fs.rmSync(this.file, { force: true });
        }
        return guard.openForHuman(this.hub, { identity, url, by: this.binding.id });
      });
      return { handoff: true, until: lease.until, site, cleared };
    }
    if (command === 'human-done') {
      const site = guard.siteOf(args.find(a => !a.startsWith('--')) || 'https://chatgpt.com/');
      const lease = guard.handoff(root);
      if (lease && lease.identity === identity) guard.endHandoff(root, lease.id);
      if (site) guard.releaseSite(root, identity, site);
      return { handoff: false, site };
    }
    if (command === 'open') {
      guard.assertAutomationAllowed(root, { identity });
      return this.open(args.find(a => !a.startsWith('--')) || 'about:blank');
    }
    if (command === 'close') {
      const target = await this.target();
      if (target) await this.hub.closeTab(target.targetId);
      fs.rmSync(this.file, { force: true });
      if (target) await this.hub.closeIfIdle();
      return { closed: !!target };
    }
    // Never import another tool's cookies into a shared identity. Chrome owns its login.
    if (command === 'state-load') return { managedBy: 'hub-chrome', imported: false };
    if (command === 'state-save') {
      const file = path.resolve(args[0]);
      // Preserve old standalone snapshots. The bridge atomically saves through .new.
      if (!fs.existsSync(file)) {
        if (file.endsWith('.new') && fs.existsSync(file.slice(0, -4))) fs.copyFileSync(file.slice(0, -4), file);
        else save(file, { cookies: [], origins: [], managedBy: 'hub-chrome' });
      }
      return { managedBy: 'hub-chrome', exported: false };
    }
    if (command === 'goto') return this.withPage(async page => {
      guard.assertAutomationAllowed(root, { identity, url: args[0], navigate: true });
      await page.goto(args[0], { waitUntil: 'domcontentloaded' });
      if (await guard.inspectAndLeave(root, { identity, page, url: args[0], source: this.binding.id }))
        throw Error('Site challenged: the page asked for human verification; left it and paused this site');
      return { url: page.url() };
    });
    if (command === 'run-code') {
      const at = args.indexOf('--filename');
      if (at < 0 || !args[at + 1]) throw Error('run-code requires a local filename');
      const source = require('./chatgpt-selector-compat').adaptSource(fs.readFileSync(args[at + 1], 'utf8'));
      // Trusted local tool code, identical authority to the original Playwright CLI.
      const fn = new Function('return (' + source + '\n)')();
      return this.withPage(async page => {
        const result = await fn(page);
        // Tool code that reports a human check (the image tool's login state does) gets the
        // same treatment as a navigation that met one: record it and leave the page.
        if (result && typeof result === 'object' && result.challenge === true) {
          const site = guard.siteOf(page.url()) || 'unknown';
          await page.goto('about:blank').catch(() => {});  // leave first; recording may fail
          try { guard.recordChallenge(root, { identity, site, kind: 'reported', source: this.binding.id }); } catch {}
        }
        return result;
      }, { downloads: /\bwaitForEvent\s*\(\s*['"]download['"]/.test(source) });
    }
    throw Error('Unsupported Hub browser command: ' + command);
  }
}
// The account page shows how the company bridge's last step on its login went. Image
// results come from the image queue itself (hub-account-activity.js).
function noteActivity(binding, argv, outcome) {
  const [command] = argumentsOf(argv);
  if (binding.tool !== 'bridge' || !['goto', 'run-code'].includes(command) || !outcome) return;
  try { require('./hub-account-activity').recordActivity(binding.root, { identity: binding.identity, site: 'chatgpt', source: 'bridge', outcome }); } catch {}
}
function bridgeOutcome(result) {
  if (result?.challenge === true || result?.cloudflare === true) return 'verification_required';
  if (['login_required', 'credential_required', 'account_selection_required'].includes(result?.auth_state)) return 'login_required';
  if (result?.logged_in === false) return 'failed';
  return 'success';
}
function failureCategory(error) {
  const message=String(error?.message || ''), network=message.match(/\b(?:ERR_[A-Z_]+|ECONN[A-Z]+)\b/);
  return /^Unsupported Hub browser command/.test(message) ? 'Unsupported command'
    : /^Human handoff/.test(message) ? 'Human handoff'
    : /^Site challenged/.test(message) ? 'Site challenged'
    : /No browser session/.test(message) ? 'No browser session'
    : /IMAGE_TOOL_UNAVAILABLE/.test(message) ? 'IMAGE_TOOL_UNAVAILABLE'
    : /strict mode violation/.test(message) ? 'strict mode violation'
    : /Target.*closed/.test(message) ? 'Target closed'
    : network ? 'Network ' + network[0]
    : /Timeout|timeout/.test(message) ? 'Timeout' : 'Hub browser operation failed';
}
async function main(binding, argv = process.argv.slice(2)) {
  try {
    const result = await new BrowserTool(binding).execute(argv);
    noteActivity(binding, argv, bridgeOutcome(result));
    process.stdout.write(JSON.stringify({ result: result ?? null }) + '\n');
  } catch (e) {
    // Native tools classify these categories; never print evaluated code or page contents.
    const category = failureCategory(e);
    // A person holding the browser is not a failure of the tool.
    noteActivity(binding, argv, category === 'Site challenged' ? 'verification_required' : category === 'Human handoff' ? null
      : category.startsWith('Network ') ? 'network_error'
      : /strict mode violation|IMAGE_TOOL_UNAVAILABLE/.test(category) ? 'adapter_changed' : 'failed');
    process.stdout.write(JSON.stringify({ isError: true, error: category }) + '\n'); process.exitCode = 1;
  }
}
module.exports = { BrowserTool, main, noteActivity, bridgeOutcome, failureCategory, argumentsOf, validateBinding, save, read, integrationStatus };
