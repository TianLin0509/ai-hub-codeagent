'use strict';

function registerMeetingTimelineIpc(ipcMain, deps) {
  const {
    logger = console,
    meetingManager,
    sendToRenderer,
  } = deps;

  ipcMain.handle('meeting-append-user-turn', (_e, { meetingId, text }) => {
    if (!meetingId || typeof text !== 'string' || !text) return null;
    const turn = meetingManager.appendTurn(meetingId, 'user', text, Date.now());
    if (turn) {
      sendToRenderer('meeting-timeline-updated', { meetingId, turn });
    }
    return turn;
  });

  ipcMain.handle('meeting-get-timeline', (_e, meetingId) => {
    if (meetingId) meetingManager.loadTimelineLazy(meetingId);
    return meetingManager.getTimeline(meetingId);
  });

  ipcMain.handle('meeting-incremental-context', (_e, { meetingId, targetSid }) => {
    if (!meetingId || !targetSid) return { turns: [], advancedTo: 0 };
    meetingManager.loadTimelineLazy(meetingId);
    if (meetingManager.getCursor(meetingId, targetSid) === null) {
      logger.warn(`[meeting-ipc] incremental-context called with unregistered targetSid=${targetSid} in meetingId=${meetingId}`);
    }
    return meetingManager.incrementalContext(meetingId, targetSid);
  });

  ipcMain.handle('get-dormant-meetings', () => meetingManager.getAllMeetings());

  ipcMain.handle('meeting-load-timeline', (_e, meetingId) => {
    if (!meetingId) return { ok: false, reason: 'missing meetingId' };
    const ok = meetingManager.loadTimelineLazy(meetingId);
    if (!ok) return { ok: false, reason: 'no persisted timeline (or meeting unknown)' };
    return {
      ok: true,
      timeline: meetingManager.getTimeline(meetingId),
    };
  });
}

module.exports = {
  registerMeetingTimelineIpc,
};
