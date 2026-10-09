'use strict';

// Coalesce repeated room clicks. The existing session resume path owns per-agent
// deduplication and runtime transitions; this controller only coordinates opening.
function createMeetingMemberWake({ getSession, resumeSession }) {
  const pending = new Map();
  return function wakeMembers(meeting) {
    if (pending.has(meeting.id)) return pending.get(meeting.id);
    const ids = [...new Set(meeting.subSessions || [])]
      .filter(id => getSession(id)?.status === 'dormant');
    const task = Promise.allSettled(ids.map(async id => {
      const label = getSession(id)?.title || id;
      try {
        const resumed = await resumeSession(id);
        if (!resumed || resumed.error || resumed.ok === false) {
          throw new Error(resumed?.error || '未返回唤醒结果');
        }
      } catch (error) {
        throw new Error(`${label}：${error.message || error}`);
      }
    })).then(results => {
      const failures = results.filter(result => result.status === 'rejected');
      if (failures.length) throw new Error(failures.map(result => result.reason.message).join('\n'));
    }).finally(() => pending.delete(meeting.id));
    pending.set(meeting.id, task);
    return task;
  };
}
module.exports = { createMeetingMemberWake };
