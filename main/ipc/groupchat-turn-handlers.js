'use strict';

function registerGroupchatTurnIpc(ipcMain, deps) {
  const {
    dispatchGroupChatTurn,
    interruptGroupChatTurn,
    stopLoop,
    logger = console,
  } = deps;

  ipcMain.handle('groupchat:turn', async (_e, args = {}) => {
    try {
      return await dispatchGroupChatTurn(args.meetingId, args);
    } catch (err) {
      logger.error('[groupchat:turn] unhandled throw, returning error to renderer:', err);
      return { status: 'error', reason: (err && err.message) || 'internal_error', turnNum: null };
    }
  });

  // 运行中中断（2026-07-29 maintainer）：「停止本轮」——把用户在单 session 里按 ESC 的动作
  //   批量下发给本轮所有在跑成员，并把状态收敛到 interrupted/idle。
  //   串行/循环工作流同时在跑时一并停掉，避免「本轮停了、下一步又自动开跑」。
  ipcMain.handle('groupchat:interrupt', async (_e, args = {}) => {
    try {
      if (!args || !args.meetingId) return { ok: false, reason: 'no_meeting_id' };
      let loopStopped = false;
      let stopError = null;
      if (typeof stopLoop === 'function') {
        try { loopStopped = !!stopLoop(args.meetingId, { interrupt: false }); }
        catch (err) {
          stopError = err && err.message || '停止派工状态保存失败';
          if (logger && typeof logger.warn === 'function') logger.warn('[groupchat:interrupt] stopLoop threw:', err && err.message);
        }
      }
      if (typeof interruptGroupChatTurn !== 'function') {
        return { ok: false, reason: 'interrupt_unavailable', loopStopped };
      }
      const result = interruptGroupChatTurn(args.meetingId, { reason: args.reason || 'user_interrupt' });
      if (stopError) return { ...result, ok: false, reason: stopError, loopStopped };
      return { ...result, loopStopped };
    } catch (err) {
      logger.error('[groupchat:interrupt] unhandled throw:', err);
      return { ok: false, reason: (err && err.message) || 'internal_error' };
    }
  });
}

module.exports = {
  registerGroupchatTurnIpc,
};
