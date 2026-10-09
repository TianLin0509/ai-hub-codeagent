'use strict';
const path = require('path');
const os = require('os');
const {expandHomePath} = require('./codex-usage-scope');

function currentConfig() {
  const hub=require('./hub-config');
  // Another Hub can update the choice while this process keeps an older config
  // cache. Read only the account routing fields at launch/send/resume boundaries.
  // Corrupt/unreadable config must block routing, never silently select default.
  const raw=hub.readConfigJsonForUpdate();
  const codex=raw.providers?.codex || {};
  const routing={
    codexSubscriptionProfile:process.env.HUB_CODEX_PROFILE || codex.subscription_profile || hub.DEFAULTS.codex_subscription_profile,
    codexSubscriptionProfiles:hub.normalizeCodexSubscriptionProfiles(codex.subscription_profiles),
    codexAccountSwitchScope:codex.switch_scope === 'launch' ? 'launch' : 'live'};
  const cached=hub.getConfig();
  if (cached.codexSubscriptionProfile!==routing.codexSubscriptionProfile
      || JSON.stringify(cached.codexSubscriptionProfiles)!==JSON.stringify(routing.codexSubscriptionProfiles)) hub.clearConfigCache();
  return {...hub.getConfig(),...routing};
}

function resolveAccount(config, env = process.env) {
  const id = config.codexSubscriptionProfile;
  const profile = config.codexSubscriptionProfiles.find(p => p.id === id);
  if (!profile) throw new Error('全局 Codex 账号不存在，请在账号中心重新选择');
  const home = path.resolve(expandHomePath(profile.home) || (env.CLAUDE_HUB_DATA_DIR && env.CODEX_HOME) || path.join(os.homedir(), '.codex'));
  if (env.CLAUDE_HUB_DATA_DIR) {
    const relative = path.relative(path.dirname(path.resolve(env.CLAUDE_HUB_DATA_DIR)), home);
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('选定 Codex 账号不在隔离目录内，未启动或切换');
  }
  return {id, label:profile.label, home};
}

function withGlobalAccount(existing, config, id, env = process.env, scope) {
  if (typeof id !== 'string' || !config.codexSubscriptionProfiles.some(p => p.id === id)) throw new Error('Codex 账号配置不存在');
  if (env.HUB_CODEX_PROFILE && env.HUB_CODEX_PROFILE !== id) throw new Error('HUB_CODEX_PROFILE 环境变量固定了账号，请移除后切换');
  if (config.codexBackend === 'api') throw new Error('当前使用 Codex API，不能切换订阅账号');
  resolveAccount({...config,codexSubscriptionProfile:id},env);
  if (scope !== undefined && !['launch','live'].includes(scope)) throw new Error('账号切换范围无效');
  return {...existing,providers:{...existing.providers,codex:{...existing.providers?.codex,subscription_profile:id,
    ...(scope ? {switch_scope:scope} : {})}}};
}

function resolveRunningAccount(config, active, env = process.env) {
  return config.codexAccountSwitchScope === 'launch' ? {...active} : resolveAccount(config,env);
}

// History and writer ownership stay with their original home. Only credentials,
// native config and future new threads follow the selected global account.
function prepareLaunch(opts, config, env = process.env) {
  const account = resolveAccount(config,env);
  require('./codex-auth-validation').assertUsableCredential(account.home);
  const oldProfile = config.codexSubscriptionProfiles.find(p => p.id === opts.codexProfile);
  const sid = opts.codexSid || opts.codexForkSid;
  if (opts.codexProfile && !oldProfile && !(sid && opts.codexSessionsRoot)) throw new Error('Codex 账号配置不存在');
  const historyHome = !sid ? account.home : opts.codexSessionsRoot ? path.dirname(opts.codexSessionsRoot)
    : oldProfile ? path.resolve(expandHomePath(oldProfile.home) || (env.CLAUDE_HUB_DATA_DIR && env.CODEX_HOME) || path.join(os.homedir(),'.codex')) : account.home;
  if (env.CLAUDE_HUB_DATA_DIR) {
    const root=path.dirname(path.resolve(env.CLAUDE_HUB_DATA_DIR));
    for (const candidate of [historyHome,opts.resumeTranscriptPath].filter(Boolean)) {
      const relative=path.relative(root,candidate);
      if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('旧 Codex 历史不在隔离目录内，未恢复');
    }
  }
  let resumePath = opts.resumeTranscriptPath;
  if (sid && !resumePath) resumePath = require('./codex-transcript-parser').findCodexRolloutBySid(sid,path.join(historyHome,'sessions'));
  if (sid && !resumePath && path.toNamespacedPath(historyHome).toLowerCase() !== path.toNamespacedPath(account.home).toLowerCase()) {
    throw new Error('未找到旧 Codex 会话的原始历史，无法换账号恢复；未新建替代会话');
  }
  return {account,opts:{...opts,codexProfile:account.id,resumeTranscriptPath:resumePath,
    codexHistoryStorageHome:historyHome,
    codexHistoryHome:opts.codexSid ? historyHome : account.home,
    codexSessionsRoot:opts.codexSid ? path.join(historyHome,'sessions') : path.join(account.home,'sessions')}};
}
// Paginated rollouts need their original SQLite thread index as well as the
// JSONL path. Resolve the source config with Codex itself (including TOML and
// project overrides), without opening a thread or copying credentials.
async function resolveHistorySqliteHome(options, persistedHome) {
  let sqliteHome = options.sqliteHome || persistedHome;
  if (!sqliteHome) {
    const historyHome = options.historyStorageHome || options.ownershipHome || options.env.CODEX_HOME;
    const {CodexAppServerClient} = require('../main/codex-app-server-client');
    const probe = new CodexAppServerClient({cwd:options.cwd,
      env:{...options.env,CODEX_HOME:historyHome},args:[]});
    try {
      await probe.start();
      const response = await probe.request('config/read',{includeLayers:false});
      sqliteHome = response.config?.sqlite_home || options.env.CODEX_SQLITE_HOME || historyHome;
    } finally { probe.close(); await probe.waitForExit(); }
  }
  sqliteHome = path.resolve(options.cwd,sqliteHome);
  if (options.env.CLAUDE_HUB_DATA_DIR) {
    const relative=path.relative(path.dirname(path.resolve(options.env.CLAUDE_HUB_DATA_DIR)),sqliteHome);
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Codex 历史数据库不在隔离目录内，未启动会话');
  }
  return sqliteHome;
}
// PTY Codex has no thread/resume{path}: the TUI finds a rollout only by id in
// the thread index under sqlite_home (default: CODEX_HOME). After the global
// account changes, CODEX_HOME carries the new credentials, so the index must be
// pointed back at the original history, the same split the native app-server
// uses. Resolved synchronously from the history home's own config.toml; a
// sqlite_home written in a form we cannot read blocks the resume instead of
// guessing another database.
function historySqliteHomeSync(historyHome, persistedHome, env = process.env) {
  let sqliteHome = persistedHome || null;
  if (!sqliteHome) {
    const {scanTomlStatements,simpleStringValue,samePath} = require('./toml-statements');
    let text = '';
    try { text = require('fs').readFileSync(path.join(historyHome,'config.toml'),'utf8'); }
    catch (error) { if (error.code !== 'ENOENT') throw new Error('旧 Codex 账号配置无法读取，未恢复：'+error.message); }
    let statements;
    try { statements = scanTomlStatements(text).statements; }
    catch (error) { throw new Error('旧 Codex 账号 config.toml 无法识别，未恢复：'+error.message); }
    const stmt = statements.find(s => s.kind === 'kv' && samePath(s.path,['sqlite_home']));
    const value = stmt ? simpleStringValue(stmt.valueText) : null;
    if (stmt && !value) throw new Error('旧 Codex 账号的 sqlite_home 写法无法识别，未恢复');
    sqliteHome = value ? path.resolve(historyHome,expandHomePath(value)) : historyHome;
  }
  sqliteHome = path.resolve(sqliteHome);
  if (env.CLAUDE_HUB_DATA_DIR) {
    const relative=path.relative(path.dirname(path.resolve(env.CLAUDE_HUB_DATA_DIR)),sqliteHome);
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Codex 历史数据库不在隔离目录内，未启动会话');
  }
  return sqliteHome;
}
module.exports = {resolveAccount,resolveRunningAccount,withGlobalAccount,prepareLaunch,currentConfig,resolveHistorySqliteHome,historySqliteHomeSync};
