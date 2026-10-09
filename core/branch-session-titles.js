'use strict';

const { readCodexRolloutMeta } = require('./codex-transcript-parser.js');
const {
  formatBranchSessionTitle,
  isGenericAutoSessionTitle,
  isStableSessionTitle,
  normalizeTitle,
  parseBranchSessionIndex,
  stripBranchTitlePrefix,
} = require('./session-title-guards');

const CODEX_SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function meaningfulSourceTitle(value) {
  const clean = stripBranchTitlePrefix(normalizeTitle(value));
  if (!clean || clean === '待命名') return '';
  if (isGenericAutoSessionTitle(clean) || !isStableSessionTitle(clean)) return '';
  return clean;
}

function resolveBranchSourceTitle({ rendererTitle, source, meeting } = {}) {
  return meaningfulSourceTitle(rendererTitle)
    || meaningfulSourceTitle(source && source.title)
    || meaningfulSourceTitle(meeting && meeting.title)
    || '';
}

function normalizeBranchIndex(value) {
  const index = Number(value);
  return Number.isInteger(index) && index > 0 ? index : null;
}

function nextBranchIndex(sourceSessionId, sessions = []) {
  const sourceId = String(sourceSessionId || '');
  if (!sourceId) return 1;
  let maxIndex = 0;
  let siblingCount = 0;
  const seen = new Set();
  for (const session of sessions || []) {
    if (!session || String(session.branchSourceSessionId || '') !== sourceId) continue;
    const id = String(session.hubId || session.id || '');
    if (id && seen.has(id)) continue;
    if (id) seen.add(id);
    siblingCount += 1;
    maxIndex = Math.max(
      maxIndex,
      normalizeBranchIndex(session.branchIndex) || parseBranchSessionIndex(session.title) || 0,
    );
  }
  return Math.max(maxIndex + 1, siblingCount + 1);
}

function buildBranchSessionTitle({ rendererTitle, source, meeting, branchIndex } = {}) {
  const sourceTitle = resolveBranchSourceTitle({ rendererTitle, source, meeting });
  const normalizedIndex = normalizeBranchIndex(branchIndex);
  return {
    sourceTitle,
    title: formatBranchSessionTitle(sourceTitle || '待命名', '会话', normalizedIndex),
    ...(normalizedIndex ? { branchIndex: normalizedIndex } : {}),
    branchAutoTitlePending: !sourceTitle,
    autoTitleGenerated: !!sourceTitle,
  };
}

function readCodexForkedFromId(transcriptPath) {
  const parentId = readCodexRolloutMeta(transcriptPath)?.forked_from_id || null;
  return CODEX_SESSION_ID_RE.test(String(parentId || '')) ? String(parentId) : null;
}

function needsBranchTitleRecovery(session) {
  if (!session) return false;
  const clean = normalizeTitle(session.title);
  const isMarkedBranch = /^分支\s*\d*\s*[:：]\s*/u.test(clean) || !!session.branchSourceSessionId;
  if (!isMarkedBranch) return false;
  const base = stripBranchTitlePrefix(clean);
  // The legacy handler incorrectly set userRenamed=true on its generated
  // "分支: Codex 2" title. Preserve real manual names, but do not let that
  // stale flag protect a provider placeholder forever.
  if (session.userRenamed === true && meaningfulSourceTitle(base) && !session.branchAutoTitlePending) {
    return false;
  }
  return !meaningfulSourceTitle(base) || !!session.branchAutoTitlePending;
}

function healPersistedBranchSessionTitles(state, {
  sessionStore = null,
  logger = console,
  now = () => Date.now(),
  canEditSession = () => true,
} = {}) {
  const sessions = Array.isArray(state && state.sessions) ? state.sessions : [];
  const meetings = Array.isArray(state && state.meetings) ? state.meetings : [];
  const byHubId = new Map(sessions.filter(Boolean).map(session => [session.hubId, session]));
  const byCodexSid = new Map(
    sessions.filter(session => session && session.codexSid).map(session => [session.codexSid, session]),
  );
  const meetingById = new Map(meetings.filter(Boolean).map(meeting => [meeting.id, meeting]));
  const changed = [];
  const changedIds = new Set();
  const recordChanged = (session) => {
    const id = String(session && (session.hubId || session.id) || '');
    if (!id || changedIds.has(id)) return;
    changedIds.add(id);
    changed.push(session);
  };
  const persistChanged = (session) => {
    if (sessionStore && typeof sessionStore.saveSessionFile === 'function' && session.hubId) {
      try { sessionStore.saveSessionFile(session.hubId, session); }
      catch (error) { logger.warn?.('[branch-title] per-session heal failed:', error.message); }
    }
  };

  for (const session of sessions) {
    if (!canEditSession(session)) continue;
    if (!needsBranchTitleRecovery(session)) continue;

    let source = session.branchSourceSessionId
      ? byHubId.get(session.branchSourceSessionId)
      : null;
    if (!source && session.codexSid && session.transcriptPath) {
      const parentCodexSid = readCodexForkedFromId(session.transcriptPath);
      if (parentCodexSid) source = byCodexSid.get(parentCodexSid) || null;
    }
    const meeting = source && source.meetingId ? meetingById.get(source.meetingId) : null;
    const resolved = buildBranchSessionTitle({ source, meeting });
    const nextSourceId = source && source.hubId ? source.hubId : session.branchSourceSessionId;
    const titleChanged = session.title !== resolved.title;
    const sourceChanged = !!nextSourceId && session.branchSourceSessionId !== nextSourceId;
    const flagsChanged = session.branchAutoTitlePending !== resolved.branchAutoTitlePending
      || session.autoTitleGenerated !== resolved.autoTitleGenerated
      || session.userRenamed === true;
    if (!titleChanged && !sourceChanged && !flagsChanged) continue;

    session.title = resolved.title;
    session.userRenamed = false;
    session.autoTitleGenerated = resolved.autoTitleGenerated;
    session.branchAutoTitlePending = resolved.branchAutoTitlePending;
    if (nextSourceId) session.branchSourceSessionId = nextSourceId;
    session.updatedAt = now();
    recordChanged(session);
  }

  // Number every sibling set deterministically. Existing explicit numbers win;
  // legacy unnumbered branches receive the lowest free number by creation time.
  const siblingGroups = new Map();
  for (const session of sessions) {
    const sourceId = String(session && session.branchSourceSessionId || '');
    if (!sourceId) continue;
    if (!siblingGroups.has(sourceId)) siblingGroups.set(sourceId, []);
    siblingGroups.get(sourceId).push(session);
  }
  for (const siblings of siblingGroups.values()) {
    siblings.sort((left, right) => {
      const leftAt = Number(left.createdAt || left.lastMessageTime || left.updatedAt) || 0;
      const rightAt = Number(right.createdAt || right.lastMessageTime || right.updatedAt) || 0;
      if (leftAt !== rightAt) return leftAt - rightAt;
      return String(left.hubId || left.id || '').localeCompare(String(right.hubId || right.id || ''));
    });
    const used = new Set();
    const pending = [];
    const assigned = new Map();
    for (const session of siblings) {
      const explicit = normalizeBranchIndex(session.branchIndex) || parseBranchSessionIndex(session.title);
      if (explicit && !used.has(explicit)) {
        used.add(explicit);
        assigned.set(session, explicit);
      } else {
        pending.push(session);
      }
    }
    let nextIndex = 1;
    for (const session of pending) {
      while (used.has(nextIndex)) nextIndex += 1;
      assigned.set(session, nextIndex);
      used.add(nextIndex);
      nextIndex += 1;
    }
    for (const session of siblings) {
      const branchIndex = assigned.get(session);
      if (!canEditSession(session)) continue;
      const baseTitle = stripBranchTitlePrefix(session.title) || '待命名';
      const expectedTitle = formatBranchSessionTitle(baseTitle, '会话', branchIndex);
      const indexChanged = session.branchIndex !== branchIndex;
      const titleChanged = session.userRenamed !== true && session.title !== expectedTitle;
      if (!indexChanged && !titleChanged) continue;
      session.branchIndex = branchIndex;
      if (titleChanged) session.title = expectedTitle;
      session.updatedAt = now();
      recordChanged(session);
    }
  }

  for (const session of changed) persistChanged(session);

  return changed;
}

module.exports = {
  buildBranchSessionTitle,
  healPersistedBranchSessionTitles,
  meaningfulSourceTitle,
  nextBranchIndex,
  readCodexForkedFromId,
  resolveBranchSourceTitle,
};
