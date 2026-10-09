'use strict';

// UI freshness policy, never a prompt/turn deadline. Lifecycle/focus requests
// coalesce for 30s; working accounts poll each minute, idle connections every
// five minutes. Errors back off to five minutes without changing cached data.
const CLAUDE_USAGE_REFRESH_POLICY = Object.freeze({ minMs: 30_000, activeMs: 60_000, idleMs: 300_000, maxBackoffMs: 300_000 });

function createClaudeUsageRefresh({ refresh, getSessions, getCached, publish, now = Date.now,
  onError = error => console.warn('[claude-usage] refresh failed:', error.message) }) {
  let flight = null, lastAttempt = -Infinity, failures = 0, retryAt = 0;
  let signature = '', pending = false, stopped = false;
  const policy = CLAUDE_USAGE_REFRESH_POLICY;
  function run(manual = false, reason = 'timer') {
    if (stopped) return Promise.resolve(null);
    const sessions = getSessions();
    const nextSignature = JSON.stringify(sessions.map(s => [s.id, s.epoch, s.state, s.userMessageId]).sort());
    if (signature !== nextSignature) { signature = nextSignature; pending = true; }
    if (reason === 'focus') pending = true;
    if (flight) return flight;
    const time = now();
    const cached = getCached();
    const observed = cached?.observedAt || cached?.ts || 0;
    // Publish shared account cache advances even if this Hub owns no Claude
    // writer. Never open a dormant session just to refresh an account footer.
    if (cached) publish(cached);
    const active = sessions.some(s => ['starting', 'running', 'waiting'].includes(s.state));
    const resetDue = [cached?.usage5h, cached?.usage7d].some(w => w?.resetsAt > observed && w.resetsAt <= time);
    const cadence = pending || resetDue ? policy.minMs : active ? policy.activeMs : policy.idleMs;
    if (!manual && (!sessions.length || time < retryAt || time - lastAttempt < cadence
      || (!pending && !resetDue && observed > 0 && time - observed < cadence))) return Promise.resolve(null);
    lastAttempt = time;
    pending = false;
    flight = Promise.resolve().then(refresh).then(result => {
      if (sessions.length && result?.source !== 'claude-native') throw new Error('Claude 未返回新的账号额度，保留上次数据');
      failures = 0; retryAt = 0;
      if (!stopped && result?.data) publish(result.data);
      return result;
    }).catch(error => {
      failures++;
      retryAt = now() + Math.min(policy.maxBackoffMs, policy.activeMs * 2 ** Math.min(failures - 1, 3));
      onError(error);
      if (manual) throw error;
      return null;
    }).finally(() => { flight = null; });
    return flight;
  }
  return { tick: reason => run(false, reason), refresh: () => run(true), stop: () => { stopped = true; } };
}

module.exports = { createClaudeUsageRefresh, CLAUDE_USAGE_REFRESH_POLICY };
