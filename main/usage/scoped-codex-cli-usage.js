'use strict';

const path = require('path');

function normalizeSessionsRoot(value) {
  try {
    return path.resolve(String(value || '')).toLowerCase();
  } catch {
    return String(value || '').toLowerCase();
  }
}

function recordCodexCliUsage(store, session, parsed, observedAt = Date.now(), defaultSessionsRoot = '') {
  if (!(store instanceof Map) || !session || !session.id || !parsed) return null;
  if (!parsed.usage5h && !parsed.usage7d) return null;
  const entry = {
    usage5h: parsed.usage5h || null,
    usage7d: parsed.usage7d || null,
    observedAt,
    _ts: observedAt,
    sessionId: session.id,
    sessionCreatedAt: Number(session.createdAt) || 0,
    sessionsRoot: normalizeSessionsRoot(session.codexSessionsRoot || defaultSessionsRoot),
  };
  store.set(session.id, entry);
  return entry;
}

function selectCodexCliUsageForScope(store, scope, opts = {}) {
  if (!(store instanceof Map) || !scope) return null;
  const now = Number(opts.now) || Date.now();
  const maxAgeMs = Math.max(0, Number(opts.maxAgeMs) || 0);
  const wantedRoot = normalizeSessionsRoot(scope.sessionsRoot || opts.defaultSessionsRoot || '');
  const authSinceMs = Number(scope.authSinceMs) || 0;
  const matches = [];

  for (const entry of store.values()) {
    if (!entry || entry.sessionsRoot !== wantedRoot) continue;
    const observedAt = Number(entry.observedAt || entry._ts) || 0;
    if (!observedAt || (maxAgeMs > 0 && now - observedAt > maxAgeMs)) continue;
    // A running CLI session can retain the account it was launched with after
    // auth.json changes. Only sessions created under the current auth epoch are
    // allowed to label their /usage output as the selected account.
    if (authSinceMs > 0 && (!entry.sessionCreatedAt || entry.sessionCreatedAt < authSinceMs)) continue;
    matches.push(entry);
  }

  matches.sort((a, b) => (b.observedAt || b._ts || 0) - (a.observedAt || a._ts || 0));
  return matches[0] || null;
}

function pruneCodexCliUsage(store, now = Date.now(), maxAgeMs = 10 * 60 * 1000) {
  if (!(store instanceof Map)) return;
  for (const [sessionId, entry] of store.entries()) {
    const observedAt = Number(entry && (entry.observedAt || entry._ts)) || 0;
    if (!observedAt || now - observedAt > maxAgeMs) store.delete(sessionId);
  }
}

module.exports = {
  normalizeSessionsRoot,
  pruneCodexCliUsage,
  recordCodexCliUsage,
  selectCodexCliUsageForScope,
};
