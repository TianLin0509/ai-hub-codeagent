'use strict';

// IPC events can overtake the initial get-sessions response while the page is
// awaiting dormant metadata. Keep only the newest native snapshot until that
// initial list is installed; never create a session from an update alone.
function createNativeSessionBootstrap() {
  let loading = true;
  const updates = new Map();
  const removed = new Set();
  function newer(left, right) {
    if (right?.agentRuntime === 'pty' && right.runtimeTruth && !left?.nativeRuntime) {
      return !left?.runtimeTruth || right.runtimeTruth.observedAt >= left.runtimeTruth.observedAt ? right : left;
    }
    const a = left?.nativeRuntime, b = right?.nativeRuntime;
    if (!b) return left;
    if (!a || b.epoch > a.epoch || (b.epoch === a.epoch && b.revision >= a.revision)) return right;
    return left;
  }
  return {
    record(session, { created = false } = {}) {
      if (!loading || !session?.id) return;
      if (created) removed.delete(session.id);
      if (removed.has(session.id)) return;
      if (!(session.runtimeBackend && session.nativeRuntime) && !(session.agentRuntime === 'pty' && session.runtimeTruth)) return;
      updates.set(session.id, newer(updates.get(session.id), session));
    },
    remove(id) {
      if (!loading) return false;
      updates.delete(id); removed.add(id);
      return true;
    },
    removed(id) { return loading && removed.has(id); },
    merge(initial, current) {
      if (removed.has(initial.id)) return null;
      const latest = newer(newer(initial, updates.get(initial.id)), current);
      // A live renderer object also holds local read acknowledgement/draft UI.
      return { ...initial, ...current, ...latest, ...(current ? { unreadCount: current.unreadCount } : {}) };
    },
    finish() { loading = false; updates.clear(); removed.clear(); },
  };
}

module.exports = { createNativeSessionBootstrap };
