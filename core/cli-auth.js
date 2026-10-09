'use strict';
// Command-line tools do not read browser cookies: each keeps its own OAuth token file,
// obtained once through a browser and then refreshed on its own. This reports those files
// only — no process is started, no token value leaves this module.
const fs = require('fs');
const os = require('os');
const path = require('path');

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')); }
  catch (e) { if (e.code === 'ENOENT') return null; return { __unreadable: true }; }
}
function homeOf(env) { return env.CLAUDE_HUB_HOME_DIR || os.homedir(); }

// `site` names the web login this tool is authorised from; the account page uses it to
// place the tool under the identity that holds that site.
function cliAuthStatus({ env = process.env, config = {}, now = Date.now() } = {}) {
  const home = homeOf(env);
  const out = [];
  const { readCodexAuthInfo, expandHomePath } = require('./codex-usage-scope');
  const profiles = config.codexSubscriptionProfiles?.length ? config.codexSubscriptionProfiles : [{ id: 'default', label: '主账号', home: '' }];
  for (const p of profiles) {
    const dir = path.resolve(expandHomePath(p.home || path.join(home, '.codex'), home));
    const auth = readJson(path.join(dir, 'auth.json'));
    let account = '';
    try { account = readCodexAuthInfo(dir).accountEmail || ''; } catch { /* no auth file yet */ }
    const tokens = auth && auth.tokens;
    out.push({
      id: 'codex:' + p.id, kind: 'codex', profileId: p.id, name: 'Codex CLI', label: p.label || p.id, site: 'chatgpt', account,
      isDefault: p.id === (config.codexSubscriptionProfile || 'default'),
      state: auth?.__unreadable ? 'unreadable' : require('./codex-auth-validation').invalidApiCredential(auth) ? 'invalid' : tokens && (tokens.refresh_token || tokens.access_token) ? 'authorized' : auth?.OPENAI_API_KEY ? 'api_key' : 'missing',
    });
  }
  const claudeDir = env.CLAUDE_CONFIG_DIR || path.join(home, '.claude');
  const claudeFile = readJson(path.join(claudeDir, '.credentials.json'));
  const creds = claudeFile?.claudeAiOauth;
  const claudeMeta = readJson(path.join(home, '.claude.json'));
  const refreshUntil = Number(creds?.refreshTokenExpiresAt) || 0;
  out.push({
    id: 'claude', kind: 'claude', name: 'Claude Code', site: 'claude', account: claudeMeta?.oauthAccount?.emailAddress || '',
    state: claudeFile?.__unreadable ? 'unreadable' : !creds ? 'missing' : creds.refreshToken && (!refreshUntil || refreshUntil > now) ? 'authorized' : 'expired',
    ...(refreshUntil ? { expiresAt: refreshUntil } : {}),
  });
  const gemini = readJson(path.join(home, '.gemini', 'oauth_creds.json'));
  out.push({
    id: 'gemini', kind: 'gemini', name: 'Gemini CLI', site: 'google',
    account: readJson(path.join(home, '.gemini', 'google_accounts.json'))?.active || '',
    // The access token expires hourly by design; the refresh token is what keeps it signed in.
    state: gemini?.__unreadable ? 'unreadable' : gemini?.refresh_token ? 'authorized' : gemini ? 'expired' : 'missing',
  });
  const kimi = readJson(path.join(env.KIMI_CODE_HOME || path.join(home, '.kimi-code'), 'credentials', 'kimi-code.json'));
  out.push({ id: 'kimi', kind: 'kimi', name: 'Kimi Code', site: 'kimi', account: '', state: kimi?.__unreadable ? 'unreadable' : kimi?.refresh_token ? 'authorized' : kimi ? 'expired' : 'missing' });
  return out;
}

module.exports = { cliAuthStatus };
