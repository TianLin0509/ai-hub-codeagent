'use strict';

// Shared module singleton: meeting-room.js and renderer.js require the same
// instance, so both projections reject the same stale/out-of-order event.
const latestByMeeting = new Map();

function stateKey(meetingId, consumer) {
  return `${String(consumer || 'default')}::${String(meetingId || '')}`;
}

function finiteNonNegative(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function acceptGroupChatEvent(event = {}, options = {}) {
  const meetingId = String(event.meetingId || '');
  if (!meetingId) return { accepted: false, reason: 'missing_meeting_id' };
  const key = stateKey(meetingId, options.consumer);
  const incomingRevision = finiteNonNegative(event.revision);
  const incomingTurn = finiteNonNegative(event.turnNum);
  const previous = latestByMeeting.get(key) || { revision: null, turnNum: null, runId: null };

  if (incomingTurn != null && previous.turnNum != null && incomingTurn < previous.turnNum) {
    return { accepted: false, reason: 'stale_turn', previous };
  }
  if (incomingRevision != null && previous.revision != null
      && (incomingRevision < previous.revision
        || (incomingRevision === previous.revision && options.allowEqualRevision !== true))) {
    return { accepted: false, reason: 'stale_revision', previous };
  }
  if (event.runId && previous.runId && incomingTurn === previous.turnNum
      && String(event.runId) !== String(previous.runId)
      && options.allowRunReplacement !== true) {
    return { accepted: false, reason: 'run_mismatch', previous };
  }

  const next = {
    revision: incomingRevision != null ? incomingRevision : previous.revision,
    turnNum: incomingTurn != null ? incomingTurn : previous.turnNum,
    runId: event.runId ? String(event.runId) : previous.runId,
  };
  latestByMeeting.set(key, next);
  return { accepted: true, previous, current: next, legacy: incomingRevision == null };
}

function noteGroupChatSnapshot(meetingId, state = {}, options = {}) {
  return acceptGroupChatEvent({
    meetingId,
    revision: state.revision,
    turnNum: state.currentTurn,
    runId: state.activeRun && state.activeRun.runId,
  }, { ...options, allowRunReplacement: true, allowEqualRevision: true });
}

function resetGroupChatRevision(meetingId, consumer = null) {
  if (meetingId == null) latestByMeeting.clear();
  else if (consumer != null) latestByMeeting.delete(stateKey(meetingId, consumer));
  else {
    const suffix = `::${String(meetingId)}`;
    for (const key of latestByMeeting.keys()) if (key.endsWith(suffix)) latestByMeeting.delete(key);
  }
}

function getGroupChatRevision(meetingId, consumer = null) {
  const value = latestByMeeting.get(stateKey(meetingId, consumer));
  return value ? { ...value } : null;
}

module.exports = {
  acceptGroupChatEvent,
  getGroupChatRevision,
  noteGroupChatSnapshot,
  resetGroupChatRevision,
};
