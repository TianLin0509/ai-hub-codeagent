'use strict';

const AUTO_SUSPEND_IDLE_MS = 5 * 60 * 60 * 1000;
const AUTO_SUSPEND_CHECK_MS = 5 * 60 * 1000;
const AUTO_SUSPEND_REASON = 'idle-timeout';

function collectProtectedSessionIds({ agentLeagueBridge, groupChatDispatcher, loopEngine, meetingManager, studyBridge } = {}) {
  const protectedIds = new Set();

  try {
    const watchers = groupChatDispatcher
      && typeof groupChatDispatcher.getActiveWatchers === 'function'
      ? groupChatDispatcher.getActiveWatchers()
      : null;
    if (watchers && typeof watchers[Symbol.iterator] === 'function') {
      for (const [sessionId, watcher] of watchers) {
        const settled = watcher && typeof watcher.isSettled === 'function'
          ? watcher.isSettled()
          : false;
        if (!settled && sessionId) protectedIds.add(String(sessionId));
      }
    }
  } catch {}

  try {
    const meetings = meetingManager && typeof meetingManager.getAllMeetings === 'function'
      ? meetingManager.getAllMeetings()
      : [];
    for (const meeting of meetings || []) {
      if (!meeting || !meeting.id || !loopEngine || typeof loopEngine.isRunning !== 'function') continue;
      if (!loopEngine.isRunning(meeting.id)) continue;
      for (const sessionId of meeting.subSessions || []) {
        if (sessionId) protectedIds.add(String(sessionId));
      }
    }
  } catch {}

  try {
    const leagueIds = agentLeagueBridge
      && typeof agentLeagueBridge.getProtectedSessionIds === 'function'
      ? agentLeagueBridge.getProtectedSessionIds()
      : null;
    if (leagueIds && typeof leagueIds[Symbol.iterator] === 'function') {
      for (const sessionId of leagueIds) {
        if (sessionId) protectedIds.add(String(sessionId));
      }
    }
  } catch {}

  // 学习 Tab：某一棒正在跑时，对应的 Claude / Codex Session 不能被休眠收走，
  // 否则自动 prompt 发出去后会话就没了，这一棒只能等超时失败。
  try {
    const studyIds = studyBridge
      && typeof studyBridge.getProtectedSessionIds === 'function'
      ? studyBridge.getProtectedSessionIds()
      : null;
    if (studyIds && typeof studyIds[Symbol.iterator] === 'function') {
      for (const sessionId of studyIds) {
        if (sessionId) protectedIds.add(String(sessionId));
      }
    }
  } catch {}

  return protectedIds;
}

function createSessionAutoSuspendScheduler(options = {}) {
  const sessionManager = options.sessionManager;
  if (!sessionManager || typeof sessionManager.suspendIdleSessions !== 'function') {
    throw new TypeError('sessionManager.suspendIdleSessions is required');
  }

  const logger = options.logger || console;
  const idleMs = Math.max(60 * 1000, Number(options.idleMs) || AUTO_SUSPEND_IDLE_MS);
  const checkIntervalMs = Math.max(10 * 1000, Number(options.checkIntervalMs) || AUTO_SUSPEND_CHECK_MS);
  const getProtectedSessionIds = typeof options.getProtectedSessionIds === 'function'
    ? options.getProtectedSessionIds
    : () => new Set();
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const setIntervalFn = options.setIntervalFn || setInterval;
  const clearIntervalFn = options.clearIntervalFn || clearInterval;
  let timer = null;

  // sweep 和 preview 必须用同一份参数，否则「预演说会休眠」和「实际会休眠」
  // 会各说各话。这里集中一处产出，两边都从它取。
  function sweepOptions() {
    return {
      idleMs,
      now: now(),
      excludePinned: true,
      excludeFocused: true,
      // 2026-09-07：会议室成员一律不参与闲置巡检。
      //
      // 这里原本是 false，理由是「闲置群聊成员也应释放 PTY，真正在工作的由
      // excludeSessionIds 单独保护」。那个理由站不住：excludeSessionIds 保护的是
      // **正在工作的那一个**，而群聊里最典型的形态恰恰是「一号位在跑、二号位在等它
      // 说完」—— 二号位自己既没有输入也没有输出，watcher 也不挂在它头上，5 小时一到
      // 就被单独收走。房间缺一个人，整条流程就断在那里，这正是用户反复遇到的现象。
      //
      // 试过一版「按房间共享最近活动时间」，同样不够：watcher 长时间不吐字时，
      // 全房间的活动时间都是旧的，等待的队友照样被收走（复现见
      // tests/unit-meeting-room-suspend.test.js 里那条 watcher 场景）。
      // 会议室成员的 PTY 由「循环 pass 后整间休眠」和用户手动休眠回收，不靠闲置巡检。
      excludeMeeting: true,
      excludeSessionIds: getProtectedSessionIds() || new Set(),
    };
  }

  // 只报结论、不动任何 PTY。用来回答「我这些会话到底会不会自动休眠、
  // 不会的话是卡在哪一关、还差多久」——在此之前这些信息全被丢掉了。
  function preview() {
    if (typeof sessionManager.previewIdleSuspend !== 'function') {
      return { ok: false, error: 'preview-unsupported' };
    }
    return sessionManager.previewIdleSuspend(sweepOptions());
  }

  function sweep() {
    const result = sessionManager.suspendIdleSessions({
      ...sweepOptions(),
      reason: AUTO_SUSPEND_REASON,
    });
    if (result && result.count > 0 && logger && typeof logger.log === 'function') {
      logger.log(`[session-auto-suspend] requested ${result.count} session(s) after ${idleMs}ms idle`);
    }
    return result;
  }

  function start() {
    if (timer) return timer;
    timer = setIntervalFn(() => {
      try { sweep(); }
      catch (error) {
        if (logger && typeof logger.warn === 'function') {
          logger.warn('[session-auto-suspend] sweep failed:', error && error.message ? error.message : error);
        }
      }
    }, checkIntervalMs);
    if (timer && typeof timer.unref === 'function') timer.unref();
    return timer;
  }

  function stop() {
    if (!timer) return false;
    clearIntervalFn(timer);
    timer = null;
    return true;
  }

  return {
    idleMs,
    checkIntervalMs,
    start,
    stop,
    sweep,
    preview,
    isStarted: () => !!timer,
  };
}

module.exports = {
  AUTO_SUSPEND_CHECK_MS,
  AUTO_SUSPEND_IDLE_MS,
  AUTO_SUSPEND_REASON,
  collectProtectedSessionIds,
  createSessionAutoSuspendScheduler,
};
