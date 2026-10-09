'use strict';

// Existing native reads are current-turn memory projections, not disk history.
// Keep a bounded cadence and backpressure: a slow paint lowers the frequency.
function refreshDelay(session, state, now, force = false) {
  const native = ['codex-app-server', 'claude-stream-json', 'acp'].includes(session?.runtimeBackend);
  const interval = native ? Math.min(1200, Math.max(100, (state.lastDurationMs || 0) * 2)) : 1200;
  return force ? 0 : Math.max(native ? 16 : 200, interval - (now - state.lastReloadAt));
}

module.exports = { refreshDelay };
