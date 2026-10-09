'use strict';
function createReconnectBackoff({ now = Date.now, random = Math.random, stableMs = 30_000 } = {}) {
  let failures = 0, connectedAt = null;
  return {
    connected() { connectedAt = now(); },
    disconnected() {
      if (connectedAt !== null && now() - connectedAt >= stableMs) failures = 0;
      connectedAt = null;
      const base = Math.min(15_000, 250 * 2 ** Math.min(failures++, 6));
      return Math.round(base * (1 + random() * 0.25));
    },
  };
}
module.exports = { createReconnectBackoff };
