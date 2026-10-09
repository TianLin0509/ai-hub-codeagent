'use strict';
// Quota of the Codex subscription accounts that are not in use right now (2026-10-08). The
// usage popover shows them under the current one, so the person sees which account still
// has room before switching. Read through the same official app-server rate-limit call as the
// current account, with that account's CODEX_HOME; only when the popover opens or 刷新 is
// pressed, at most once per account per two minutes. Accounts signed in with an API key have
// no subscription windows and are listed without a query.
const fs = require('fs');
const path = require('path');

const MIN_INTERVAL_MS = 2 * 60 * 1000;

function authMode(home) {
  try { return JSON.parse(fs.readFileSync(path.join(home, 'auth.json'), 'utf8')).auth_mode || ''; }
  catch { return ''; }
}

function createCodexOtherProfilesUsage({ getConfig, currentScope, resolveScope, readUsage, file, now = Date.now, minIntervalMs = MIN_INTERVAL_MS }) {
  let cache = {};
  try { cache = JSON.parse(fs.readFileSync(file, 'utf8')) || {}; } catch { cache = {}; }
  let flight = null;
  const save = () => {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = file + '.' + process.pid + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(cache), 'utf8');
      fs.renameSync(tmp, file);
    } catch { /* the popover still shows this run's values */ }
  };
  // Every subscription profile except the one in use, resolved the way the Hub resolves it.
  function profiles() {
    const config = getConfig() || {};
    const current = currentScope();
    if (current.backend !== 'subscription') return [];
    return (Array.isArray(config.codexSubscriptionProfiles) ? config.codexSubscriptionProfiles : [])
      .filter(p => p && p.id && p.id !== current.profileId)
      .map(p => resolveScope({ ...config, codexSubscriptionProfile: p.id }))
      .filter(scope => scope.profileId !== current.profileId);
  }
  function list() {
    return profiles().map(scope => {
      const entry = cache[scope.profileId];
      // A value read under another login of the same profile is not this account's quota.
      const own = entry && entry.scopeKey === scope.scopeKey ? entry : null;
      return { profileId: scope.profileId, profileLabel: scope.profileLabel, accountEmail: scope.accountEmail || '',
        apiKey: authMode(scope.home) === 'apikey', usage5h: own?.usage5h || null, usage7d: own?.usage7d || null,
        observedAt: own?.observedAt || 0, error: own?.error || '', checkedAt: own?.checkedAt || 0 };
    });
  }
  async function refreshOnce({ force = false } = {}) {
    const config = getConfig() || {};
    for (const scope of profiles()) {
      const entry = cache[scope.profileId];
      if (authMode(scope.home) === 'apikey') continue;
      if (!force && entry?.scopeKey === scope.scopeKey && now() - (entry.checkedAt || 0) < minIntervalMs) continue;
      try {
        const raw = await readUsage({ home: scope.home, proxy: config.proxy, timeoutMs: 8000 });
        cache[scope.profileId] = { scopeKey: scope.scopeKey, usage5h: raw.usage5h || null, usage7d: raw.usage7d || null,
          observedAt: raw.observedAt || now(), checkedAt: now(), error: '' };
      } catch (error) {
        // Keep the last real reading; say why it is not newer.
        cache[scope.profileId] = { ...(entry?.scopeKey === scope.scopeKey ? entry : { scopeKey: scope.scopeKey }),
          checkedAt: now(), error: String(error?.message || '读取失败').slice(0, 120) };
      }
    }
    save();
    return list();
  }
  function refresh(options) {
    if (!flight) flight = refreshOnce(options).finally(() => { flight = null; });
    return flight;
  }
  return { list, refresh };
}

module.exports = { createCodexOtherProfilesUsage, MIN_INTERVAL_MS };
