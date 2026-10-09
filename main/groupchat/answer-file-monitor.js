'use strict';
// Watches member answer files and pushes changes to the group chat. Driven by
// task-directory events, with a slow sweep of recently active rooms as the
// fallback for dropped events; opening a room reconciles it too
// (groupchat:get-state), which covers changes made while the Hub was down.
const Answers = require('../../core/group-answer-files');
const SWEEP_MS = 15_000;
const HOT_MS = 24 * 3600_000;

function createAnswerFileMonitor({ getHubDataDir, getOrchestrator, meetingManager, sendToRenderer, onChanged = () => {}, logger = console }) {
  const hot = new Map();
  let subscription = null, timer = null;
  // touch=false for the sweep, so an idle room ages out of the hot set.
  function reconcile(meetingId, touch = true, changedPaths = null) {
    if (!meetingId) { for (const id of hot.keys()) reconcile(id, false); return false; }
    const meeting = meetingManager.getMeeting(meetingId);
    if (!Answers.enabled(meeting)) return false;
    try {
      const orch = getOrchestrator(meetingId);
      if (!orch.state.answerFiles) return false;
      if (touch || !hot.has(meetingId)) hot.set(meetingId, Date.now());
      const changed = Answers.reconcile(orch,{changedPaths});
      if (changed) {
        sendToRenderer('groupchat:answer-file', { meetingId, revision: orch.state.revision });
        try { onChanged(meetingId, orch); } catch (error) { logger.warn?.('[answer-files] change hook failed:', error.message); }
      }
      return changed;
    } catch (error) { logger.warn?.('[answer-files] reconcile failed:', meetingId, error.message); return false; }
  }
  function sweep() {
    subscription?.ensure();
    const now = Date.now();
    for (const [id, at] of hot) { if (now - at > HOT_MS) hot.delete(id); else reconcile(id, false); }
  }
  return {
    reconcile,
    start() {
      if (timer) return;
      subscription = require('../../core/task-directory-events').subscribeTaskDirectory(getHubDataDir(), (id,paths) => reconcile(id,true,paths), logger);
      timer = setInterval(sweep, SWEEP_MS); timer.unref?.();
    },
    dispose() { clearInterval(timer); timer = null; subscription?.dispose(); subscription = null; hot.clear(); },
  };
}

module.exports = { createAnswerFileMonitor };
