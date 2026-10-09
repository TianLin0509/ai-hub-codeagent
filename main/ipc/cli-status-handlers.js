'use strict';

function isCliReady(sessionId, deps) {
  const {
    cliReadyDetector,
    sessionManager,
  } = deps;

  if (!sessionId) return false;
  const session = sessionManager.getSession(sessionId);
  if (!session) return false;
  if (sessionManager.getGroupChatReady(sessionId)) {
    cliReadyDetector.markReady(sessionId);
    return true;
  }
  const buffer = sessionManager.getSessionBuffer(sessionId) || '';
  return cliReadyDetector.isReady(sessionId, session.kind, buffer);
}

function registerCliStatusIpc(ipcMain, deps) {
  const {
    sessionManager,
  } = deps;

  ipcMain.handle('get-ring-buffer', (_e, sessionId) => {
    return sessionManager.getSessionBuffer(sessionId);
  });

  ipcMain.handle('cli-ready-status', (_e, sessionId) => {
    return isCliReady(sessionId, deps);
  });
}

module.exports = {
  isCliReady,
  registerCliStatusIpc,
};
