'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

function normalizeProfiles(profiles, home = process.env.CLAUDE_HUB_HOME_DIR || os.homedir()) {
  const rows = new Map([
    ['default', { id: 'default', label: '主账号', home: '' }],
    ['second', { id: 'second', label: '第二账号', home: path.join(home, '.claude-profiles', 'second') }],
  ]);
  for (const p of Array.isArray(profiles) ? profiles : []) {
    if (!p || !/^[\w-]{1,64}$/.test(p.id || '')) continue;
    rows.set(p.id, { id: p.id, label: String(p.label || p.id), home: String(p.home || '') });
  }
  return [...rows.values()];
}

function resolveProfile(config, id, env = process.env, home = env.CLAUDE_HUB_HOME_DIR || env.USERPROFILE || env.HOME || os.homedir()) {
  id = id || config.claudeSubscriptionProfile || 'default';
  const row = normalizeProfiles(config.claudeSubscriptionProfiles, home).find(p => p.id === id);
  if (!row) throw new Error('Claude 账号配置不存在，未切换到主账号');
  const dir = row.home || (id === 'default' ? env.CLAUDE_CONFIG_DIR || path.join(home, '.claude') : '');
  if (!dir) throw new Error('Claude 独立账号目录未配置');
  const resolved = path.resolve(require('./codex-usage-scope').expandHomePath(dir, home));
  if (env.CLAUDE_HUB_HOME_DIR) {
    const boundary = env.CLAUDE_HUB_DATA_DIR ? path.dirname(path.resolve(env.CLAUDE_HUB_DATA_DIR)) : path.resolve(home);
    const rel = path.relative(boundary, resolved);
    if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('Claude 账号目录超出隔离测试 home');
  }
  const otherHomes = normalizeProfiles(config.claudeSubscriptionProfiles, home).filter(p => p.id !== id)
    .map(p => p.home || (p.id === 'default' ? env.CLAUDE_CONFIG_DIR || path.join(home, '.claude') : ''));
  if (otherHomes.some(h => h && path.resolve(require('./codex-usage-scope').expandHomePath(h, home)).toLowerCase() === resolved.toLowerCase())) {
    throw new Error('两个 Claude 账号不能共用登录目录');
  }
  return { ...row, home: resolved, configDir: row.home || env.CLAUDE_CONFIG_DIR || (id !== 'default' ? resolved : '') };
}

function connectionId(id) { return !id || id === 'default' ? 'claude' : 'claude-' + id; }

function profileForSession(opts, config, env = process.env) {
  // Old histories belong to the original account even after the launch default changes.
  const history = opts.useResume || opts.resumeCCSessionId || opts.forkCCSessionId || opts.ccSessionId;
  let id = opts.claudeProfile || (history ? 'default' : config.claudeSubscriptionProfile);
  const transcriptPath = opts.transcriptPath || opts.resumeTranscriptPath;
  if (!opts.claudeProfile && transcriptPath) {
    for (const p of normalizeProfiles(config.claudeSubscriptionProfiles)) {
      const profile = resolveProfile(config, p.id, env);
      const rel = path.relative(path.join(profile.home, 'projects'), path.resolve(transcriptPath));
      if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) { id = p.id; break; }
    }
  }
  const profile = resolveProfile(config, id, env);
  if (opts.claudeConfigDir && path.resolve(opts.claudeConfigDir).toLowerCase() !== profile.home.toLowerCase()) {
    throw new Error('此会话原来的 Claude 账号目录已改变，请先恢复账号配置');
  }
  return profile;
}

function accountLabel(home) {
  try {
    const file = path.join(home, '.claude.json');
    const data = JSON.parse(fs.readFileSync(fs.existsSync(file) ? file : path.basename(home) === '.claude' ? path.join(path.dirname(home), '.claude.json') : file, 'utf8'));
    return String(data.oauthAccount?.emailAddress || '');
  } catch { return ''; }
}

function usageScope(config, id, env = process.env) {
  const p = resolveProfile(config, id, env);
  const identity = accountLabel(p.home);
  return p.id + ':' + require('crypto').createHash('sha256').update(p.home.toLowerCase()+'\0'+identity).digest('hex').slice(0,20);
}

function applyNetworkEnv(target, config, env = process.env) {
  // Reuse the user's established Claude egress policy for both logins. Copy
  // only transport settings, never credentials, cookies, hooks or account data.
  const primary=resolveProfile(config,'default',env);
  const file=path.join(primary.home,'settings.json');
  if (!fs.existsSync(file)) return;
  const settings=JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,''));
  for (const key of ['HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','http_proxy','https_proxy','all_proxy','NO_PROXY','no_proxy',
    'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC','DISABLE_TELEMETRY','DISABLE_ERROR_REPORTING']) {
    if (typeof settings.env?.[key] === 'string') target[key]=settings.env[key];
  }
}

module.exports = { normalizeProfiles, resolveProfile, connectionId, profileForSession, accountLabel, usageScope, applyNetworkEnv };
