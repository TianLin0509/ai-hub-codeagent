"use strict";
function registerHubMemoryIpc(ipcMain, service) {
  const handle = (name, fn) =>
    ipcMain.handle("memory:" + name, async (_event, request = {}) => {
      try {
        return { ok: true, data: await fn(request) };
      } catch (error) {
        return { ok: false, error: error.message };
      }
    });
  handle("snapshot", (r) => service.snapshot(r.sessionId));
  handle("context", (r) => service.context(r.sessionId, r.refresh === true));
  handle("library", (r) => service.catalog(r.refresh === true));
  handle("dream-state", (r) => service.dreamState(r));
  handle("candidates", (r) => service.candidates(r));
  handle("scan", (r) => service.scan(r));
  handle("transcript", (r) => service.transcript(r.sessionId));
  handle("start-dream", (r) => service.start(r));
  handle("finalize-dream", (r) => service.finalize(r.jobId));
  handle("abandon-dream", (r) => service.abandon(r.jobId));
}
module.exports = { registerHubMemoryIpc };
