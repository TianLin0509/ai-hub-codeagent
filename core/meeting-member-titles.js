'use strict';

const { KIND_LABELS } = require('./ai-kinds');

function meetingMemberTitlePatch(session, meeting) {
  if (!session || !meeting || session.userRenamed || session.meetingId !== meeting.id) return null;
  const topic = String(meeting.title || '').trim();
  if (!topic) return null;
  const kind = String(session.kind || '').replace(/-resume$/, '');
  const model = session.currentModel;
  const label = String((model && typeof model === 'object' ? model.displayName || model.id : model)
    || KIND_LABELS[kind] || kind || 'AI').trim();
  const title = `${label} · ${topic}`;
  return session.title === title && session.autoTitleGenerated ? null : { title, autoTitleGenerated: true };
}

// One naming path for new members, title/model changes and dormant restoration.
// read/write retain the main process's existing ownership and persistence rules.
function createMeetingMemberTitleSync({ getMeeting, readSession, writeSession, publish, logger = console }) {
  const updating = new Set();
  const meetingNames = new Map();
  const signature = meeting => JSON.stringify([meeting.title, meeting.subSessions || []]);
  function rememberMeeting(meeting) { meetingNames.set(meeting.id, signature(meeting)); }
  function syncSession(session) {
    const id = session?.id || session?.hubId;
    if (!id || updating.has(id)) return session;
    const patch = meetingMemberTitlePatch(session, getMeeting(session.meetingId));
    if (!patch) return session;
    updating.add(id);
    try {
      return writeSession(id, patch) || session;
    } catch (error) {
      logger.warn(`[meeting-member-title] ${id}: ${error.message}`);
      return session;
    } finally {
      updating.delete(id);
    }
  }
  function syncMeeting(meeting) {
    for (const id of meeting?.subSessions || []) {
      const before = readSession(id);
      const after = syncSession(before);
      if (after && after !== before) publish('session-updated', { session: after });
    }
  }
  function onEvent(channel, data) {
    if ((channel === 'meeting-created' || channel === 'meeting-updated') && data?.meeting) {
      const meeting = data.meeting;
      if (meetingNames.get(meeting.id) !== signature(meeting)) {
        rememberMeeting(meeting);
        syncMeeting(meeting);
      }
    }
    if (channel === 'meeting-closed') meetingNames.delete(data?.meetingId);
    if ((channel === 'session-created' || channel === 'session-updated') && data?.session) {
      data = { ...data, session: syncSession(data.session) };
    }
    return data;
  }
  return { rememberMeeting, syncMeeting, onEvent };
}

module.exports = { meetingMemberTitlePatch, createMeetingMemberTitleSync };
