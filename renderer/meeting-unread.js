'use strict';

const { sessionHasCompletedUnread, clearSessionCompletedUnread } = require('../core/session-attention-state');

// Attention belongs to this renderer window. Never infer it from running/idle,
// selected rows or round progress: those can all change before a reply is read.
const {getMeetingUnreadMemberIds}=require('../core/session-sidebar-state');

function recordMeetingAnswer(meeting, payload, { seenByUser = false } = {}) {
  const { sid, status, turnNum, runId } = payload;
  if (!meeting?.subSessions?.includes(sid) || !['completed', 'manual_extracted'].includes(status)) return false;
  if (!(meeting.unreadAnswered instanceof Set)) meeting.unreadAnswered = new Set();
  if (!(meeting._answerCompletionKeys instanceof Map)) meeting._answerCompletionKeys = new Map();
  const round = JSON.stringify([runId || '', turnNum ?? null]);
  if (meeting._answeredRound !== round) {
    meeting.answeredThisTurn = new Set();
    meeting._answeredRound = round;
  }
  meeting.answeredThisTurn.add(sid);
  const key = JSON.stringify([round, payload.attemptId || '', payload.providerTurnId || '', status]);
  if (meeting._answerCompletionKeys.get(sid)?.key === key) return false;
  meeting._answerCompletionKeys.set(sid, { key, turnNum });
  if (!seenByUser) meeting.unreadAnswered.add(sid);
  else meeting.unreadAnswered.delete(sid);
  return true;
}

function readMeetingMember(meeting, sid, sessions = new Map(), readContext = null) {
  if (!meeting?.subSessions?.includes(sid)) return { changed: false, sessionRead: false };
  const latest = meeting._answerCompletionKeys?.get(sid);
  // A delayed panel repaint must not let an old visible bubble acknowledge a
  // newer completion which arrived after that bubble was rendered.
  if (readContext && latest && Number(readContext.turnNum) !== Number(latest.turnNum)) {
    return { changed: false, sessionRead: false };
  }
  const removed = meeting.unreadAnswered instanceof Set && meeting.unreadAnswered.delete(sid);
  const sessionRead = clearSessionCompletedUnread(sessions.get(sid));
  return { changed: removed || sessionRead, sessionRead };
}

function readMeeting(meeting, sessions = new Map()) {
  if (!meeting) return { changed: false, sessionIds: [] };
  let changed = Number(meeting.unreadCount) > 0 || !!meeting.unreadAnswered?.size;
  const sessionIds = [];
  for (const sid of meeting.subSessions || []) {
    const result = readMeetingMember(meeting, sid, sessions);
    changed = result.changed || changed;
    if (result.sessionRead) sessionIds.push(sid);
  }
  meeting.unreadCount = 0;
  meeting.unreadAnswered?.clear();
  return { changed, sessionIds };
}

function preserveMeetingAttention(previous, next) {
  if (!previous || !next) return;
  const valid = new Set(next.subSessions || []);
  for (const key of ['unreadAnswered', 'answeredThisTurn']) {
    if (previous[key] instanceof Set) next[key] = new Set([...previous[key]].filter(sid => valid.has(sid)));
  }
  if (previous._answerCompletionKeys instanceof Map) {
    next._answerCompletionKeys = new Map([...previous._answerCompletionKeys].filter(([sid]) => valid.has(sid)));
  }
  next._answeredRound = previous._answeredRound;
}

module.exports = { getMeetingUnreadMemberIds, recordMeetingAnswer, readMeetingMember, readMeeting, preserveMeetingAttention };
