'use strict';

// Repair only a missing back-reference with one unambiguous, existing owner.
// Never match titles, model names, or native transcript ids.
function restoreMissingMeetingIds(sessions, meetings) {
  const owners = new Map();
  for (const meeting of meetings || []) {
    for (const id of meeting.subSessions || []) {
      if (!owners.has(id)) owners.set(id, meeting.id);
      else if (owners.get(id) !== meeting.id) owners.set(id, null);
    }
  }
  const repaired = [];
  for (const session of sessions || []) {
    const id = session.id || session.hubId;
    const owner = owners.get(id);
    if (!session.meetingId && owner) { session.meetingId = owner; repaired.push(id); }
  }
  return repaired;
}
module.exports = { restoreMissingMeetingIds };
