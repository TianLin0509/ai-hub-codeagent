'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

function expandHomePath(value, homeDir = os.homedir()) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (raw === '~') return homeDir;
  if (raw.startsWith('~/') || raw.startsWith('~\\')) return path.join(homeDir, raw.slice(2));
  return raw;
}

function normalizePath(value) {
  if (!value) return '';
  try {
    return path.resolve(value);
  } catch {
    return String(value);
  }
}

function normalizeKey(value) {
  return normalizePath(value).toLowerCase();
}

function parseDateMs(value) {
  if (!value) return 0;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : 0;
}

function base64UrlJson(value) {
  try {
    const part = String(value || '').split('.')[1];
    if (!part) return {};
    const normalized = part.replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(Buffer.from(normalized, 'base64').toString('utf8'));
  } catch {
    return {};
  }
}

function findStringByKey(value, keyName, depth = 0) {
  if (!value || typeof value !== 'object' || depth > 6) return '';
  for (const [key, child] of Object.entries(value)) {
    if (key === keyName && typeof child === 'string' && child.trim()) return child.trim();
    const nested = findStringByKey(child, keyName, depth + 1);
    if (nested) return nested;
  }
  return '';
}

function normalizeAccountKey(value) {
  return String(value || '').trim().toLowerCase();
}

function readCodexAuthInfo(home) {
  const authPath = path.join(home, 'auth.json');
  try {
    const stat = fs.statSync(authPath);
    const raw = JSON.parse(fs.readFileSync(authPath, 'utf8').replace(/^\uFEFF/, ''));
    const idPayload = base64UrlJson(raw && raw.tokens && raw.tokens.id_token);
    const accountId = findStringByKey(raw, 'account_id') || findStringByKey(raw, 'accountId') || '';
    const email = typeof idPayload.email === 'string' ? idPayload.email.trim() : '';
    const name = typeof idPayload.name === 'string' ? idPayload.name.trim() : '';
    const subject = typeof idPayload.sub === 'string' ? idPayload.sub.trim() : '';
    const lastRefreshMs = parseDateMs(raw && raw.last_refresh);
    const mtimeMs = stat && Number.isFinite(stat.mtimeMs) ? stat.mtimeMs : 0;
    const accountKey = normalizeAccountKey(accountId || subject || email);
    return {
      authPath,
      accountId,
      accountEmail: email,
      accountName: name,
      accountSubject: subject,
      accountKey,
      authLastRefreshMs: lastRefreshMs,
      authMtimeMs: mtimeMs,
      authSinceMs: lastRefreshMs || mtimeMs || 0,
    };
  } catch {
    return {
      authPath,
      accountId: '',
      accountEmail: '',
      accountName: '',
      accountSubject: '',
      accountKey: '',
      authLastRefreshMs: 0,
      authMtimeMs: 0,
      authSinceMs: 0,
    };
  }
}

function resolveSubscriptionProfile(config, homeDir) {
  const profiles = Array.isArray(config.codexSubscriptionProfiles)
    ? config.codexSubscriptionProfiles
    : [];
  const fallback = profiles.find(p => p && p.id === 'default')
    || { id: 'default', label: 'Main account', home: '' };
  const wanted = String(config.codexSubscriptionProfile || fallback.id || 'default').trim();
  const selected = profiles.find(p => p && p.id === wanted) || fallback;
  const home = normalizePath(expandHomePath(selected.home, homeDir));
  return {
    id: selected.id || 'default',
    label: selected.label || selected.name || selected.id || 'Codex',
    home,
  };
}

function resolveCodexUsageScope(config = {}, opts = {}) {
  const homeDir = opts.homeDir || os.homedir();
  const hubDataDir = opts.hubDataDir || path.join(homeDir, '.ai-hub-community');
  const backend = config.codexBackend === 'api' && config.codexApiKey ? 'api' : 'subscription';

  if (backend === 'api') {
    const home = normalizePath(path.join(hubDataDir, 'codex-api-profile'));
    const sessionsRoot = path.join(home, 'sessions');
    return {
      provider: 'codex',
      backend,
      profileId: 'api',
      profileLabel: 'API',
      home,
      sessionsRoot,
      scopeKey: `api:${normalizeKey(sessionsRoot)}`,
    };
  }

  const profile = resolveSubscriptionProfile(config, homeDir);
  const home = profile.home || path.join(homeDir, '.codex');
  const sessionsRoot = path.join(home, 'sessions');
  const auth = readCodexAuthInfo(home);
  const authScope = auth.accountKey ? `:auth:${auth.accountKey}` : '';
  return {
    provider: 'codex',
    backend,
    profileId: profile.id,
    profileLabel: profile.label,
    home,
    sessionsRoot,
    accountId: auth.accountId,
    accountEmail: auth.accountEmail,
    accountName: auth.accountName,
    accountSubject: auth.accountSubject,
    authPath: auth.authPath,
    authLastRefreshMs: auth.authLastRefreshMs,
    authMtimeMs: auth.authMtimeMs,
    authSinceMs: auth.authSinceMs,
    scopeKey: `subscription:${profile.id}:${normalizeKey(sessionsRoot)}${authScope}`,
  };
}

function sameCodexUsageScope(entry, scope) {
  if (!entry || !scope) return false;
  if (entry.scopeKey) return entry.scopeKey === scope.scopeKey;
  if (entry.codexScopeKey) return entry.codexScopeKey === scope.scopeKey;
  if (entry.sessionsRoot) return normalizeKey(entry.sessionsRoot) === normalizeKey(scope.sessionsRoot);
  // Legacy cache had no scope. It can only be trusted for the default account.
  return scope.backend === 'subscription' && scope.profileId === 'default';
}

function attachCodexUsageScope(data, scope) {
  return {
    ...(data || {}),
    provider: 'codex',
    backend: scope.backend,
    profileId: scope.profileId,
    profileLabel: scope.profileLabel,
    accountId: scope.accountId,
    accountEmail: scope.accountEmail,
    accountName: scope.accountName,
    authSinceMs: scope.authSinceMs,
    sessionsRoot: scope.sessionsRoot,
    scopeKey: scope.scopeKey,
  };
}

function filterUsageCacheForCodexScope(cache, scope) {
  const out = { ...(cache || {}) };
  if (out.codex && !sameCodexUsageScope(out.codex, scope)) {
    delete out.codex;
  }
  return out;
}

module.exports = {
  expandHomePath,
  readCodexAuthInfo,
  resolveCodexUsageScope,
  sameCodexUsageScope,
  attachCodexUsageScope,
  filterUsageCacheForCodexScope,
};
