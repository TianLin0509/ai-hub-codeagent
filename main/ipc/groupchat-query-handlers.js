'use strict';

function snapshotDebug(getSnapshot) {
  try {
    return { ok: true, snapshot: getSnapshot() };
  } catch (err) {
    return { ok: false, reason: 'snapshot_failed', detail: err.message };
  }
}

function registerGroupchatQueryIpc(ipcMain, deps) {
  const {
    getHubDataDir,
    groupchat,
    transcriptTap,
    reconcileAnswers = () => false,
  } = deps;

  ipcMain.handle('groupchat:get-state', (_e, { meetingId }) => {
    // Pick up answer files written while nobody was watching (e.g. Hub restart).
    try { reconcileAnswers(meetingId); } catch {}
    const orch = groupchat.getOrchestrator(getHubDataDir(), meetingId);
    return orch.getState();
  });

  ipcMain.handle('groupchat:search-raw', (_e, { meetingId, query, limit } = {}) => {
    const orch = groupchat.getOrchestrator(getHubDataDir(), meetingId);
    return orch.searchRaw(query, limit);
  });

  ipcMain.handle('groupchat:read-raw', (_e, { meetingId, messageId } = {}) => {
    const orch = groupchat.getOrchestrator(getHubDataDir(), meetingId);
    return orch.readRaw(messageId);
  });

  ipcMain.handle('groupchat-codex-debug-state', async () =>
    snapshotDebug(() => transcriptTap.getCodexDebugSnapshot())
  );

  ipcMain.handle('groupchat-gemini-debug-state', async () =>
    snapshotDebug(() => transcriptTap.getGeminiDebugSnapshot())
  );
}

module.exports = {
  registerGroupchatQueryIpc,
  snapshotDebug,
};
