'use strict';

// \\?\C:\x and C:\x name the same file; neither spelling may detach the cards.
const identity = session => JSON.stringify([session?.id, session?.kind, session?.runtimeBackend,
  session?.codexSid, session?.ccSessionId,
  require('../core/plain-windows-path').plainWindowsPath(session?.transcriptPath)]);

// A new session receives its native ID/path after the first local message is
// already visible. Filling an unknown field binds that same conversation; it
// must not detach its cards. Replacing/removing a known binding, changing Hub
// session, provider or backend still invalidates the cached view.
function continuesHistory(previous, next) {
  if (!previous) return false;
  if (previous === next) return true;
  const before = JSON.parse(previous), after = JSON.parse(next);
  return before.every((value, index) => value === after[index]
    || (index >= 3 && (value == null || value === '')));
}

// Only detached, fully hydrated views are retained. No persisted HTML and no
// provider calls: the normal transcript refresh remains the source of truth.
function createCardHistoryViews({document, getTurns, setTurns, clearSignatures,
  maxEntries = 4, maxBytes = 8 * 1024 * 1024, maxNodes = 12000, now = Date.now}) {
  const entries = new Map();
  let active = null;
  const container = () => document.getElementById('msg-overlay');
  function trim() {
    let bytes = 0, nodes = 0;
    for (const entry of entries.values()) { bytes += entry.bytes; nodes += entry.nodeCount; }
    while (entries.size > maxEntries || bytes > maxBytes || nodes > maxNodes) {
      const key = entries.keys().next().value, entry = entries.get(key);
      bytes -= entry.bytes; nodes -= entry.nodeCount; entries.delete(key);
    }
  }
  function suspend() {
    const element = container();
    if (active?.hydrated && element) {
      const turns = new Map(getTurns() || []);
      const nodes = [...element.children].filter(node => !node.matches('.streaming-indicator,.card-history-status'));
      const bytes = 2 * JSON.stringify([...turns]).length;
      const nodeCount = nodes.reduce((n, node) => n + 1 + node.querySelectorAll('*').length, 0);
      entries.delete(active.id);
      if (bytes <= maxBytes && nodeCount <= maxNodes) {
        const fragment = document.createDocumentFragment();
        fragment.append(...nodes);
        entries.set(active.id, {...active, fragment, turns, bytes, nodeCount, savedAt: now()});
        trim();
      }
    }
    active = null;
  }
  return {
    ready(session) { return !!(active?.hydrated && continuesHistory(active.key, identity(session))); },
    activate(session) {
      const key = identity(session);
      if (active && continuesHistory(active.key, key)) {
        active.key = key;
        return {changed: false, hydrated: active.hydrated};
      }
      suspend();
      const element = container(), entry = entries.get(session.id);
      entries.delete(session.id);
      const restore = entry && continuesHistory(entry.key, key) && now() - entry.savedAt < 5 * 60_000;
      element.replaceChildren(...(restore ? [entry.fragment] : []));
      setTurns(restore ? entry.turns : new Map());
      clearSignatures();
      active = {id: session.id, key, hydrated: !!restore};
      return {changed: true, hydrated: !!restore};
    },
    markHydrated(session) {
      if (active?.id === session?.id) { active.key = identity(session); active.hydrated = true; }
    },
    suspend,
    drop(id) { entries.delete(id); if (active?.id === id) active = null; },
    stats() { return {cached: entries.size, activeId: active?.id, hydrated: !!active?.hydrated}; },
  };
}

function loadingMarkup() {
  return '<div class="msg-overlay-placeholder card-history-loading" role="status" aria-live="polite">'
    + '<div class="card-history-caption">正在读取最近对话</div><div class="card-history-skeleton" aria-hidden="true">'
    + '<div class="card-history-ghost user"><i></i><i></i></div>'
    + '<div class="card-history-ghost"><i></i><i></i><i></i><i></i></div></div></div>';
}

module.exports = {createCardHistoryViews, loadingMarkup};
