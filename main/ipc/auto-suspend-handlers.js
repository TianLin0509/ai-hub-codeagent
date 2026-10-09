'use strict';

// 自动休眠的可见性入口。
//
// 背景：自动休眠一直是对所有 CLI 一视同仁的（core/session-capabilities.js 里
// claude / codex / gemini / kimi 都在 supportsRecoverableSession 名单内），
// 但 suspendIdleSessions 只回一个 skipped 计数，界面上又只显示「已请求 N 个」，
// 所以用户根本看不出自己的会话到底会不会被休眠、不会的话卡在哪一关。
// 「Claude Code 好像没有自动休眠」这个印象就是这么来的——功能在跑，只是不可见。
//
// 这里只提供预演，不提供任何执行入口：执行走原来的 suspend-idle-sessions。

function registerAutoSuspendIpc(ipcMain, deps = {}) {
  const getScheduler = typeof deps.getScheduler === 'function' ? deps.getScheduler : () => null;
  const logger = deps.logger || console;

  ipcMain.handle('preview-auto-suspend', () => {
    try {
      const scheduler = getScheduler();
      if (!scheduler || typeof scheduler.preview !== 'function') {
        return { ok: false, error: 'scheduler-unavailable' };
      }
      const result = scheduler.preview();
      if (!result || result.ok !== true) return result || { ok: false, error: 'preview-failed' };
      return {
        ...result,
        checkIntervalMs: scheduler.checkIntervalMs,
        schedulerRunning: scheduler.isStarted(),
      };
    } catch (error) {
      logger.warn('[群聊] 自动休眠预演失败:', error && error.message);
      return { ok: false, error: String((error && error.message) || error) };
    }
  });
}

module.exports = { registerAutoSuspendIpc };
