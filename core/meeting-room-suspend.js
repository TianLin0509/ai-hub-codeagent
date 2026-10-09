'use strict';

// 整间会议室休眠。
//
// 2026-09-07 用户要求：「群聊 AI 开发顺利 pass、任务完成之后，主动休眠整个会议室」。
// 在此之前，一场跑完的开发循环会把三四个 CLI 会话一直挂在那儿，等 5 小时闲置巡检
// 一个一个来收；而巡检又是按会话算的，收的顺序和时机都不整齐。既然「评审通过」是一个
// 明确的完成信号，就该在那一刻把整间房收干净。
//
// 与逐个 suspendSession 的区别只有两点，但都重要：
//   1. 成员全部落定之后才把 meeting.status 改成 dormant —— 只要还有一个成员没睡成
//      （比如原生会话 ID 还没绑好、或是扩展投研这类受保护会话），房间就不能标成休眠，
//      否则侧栏会出现一个「已休眠但里面还有人在跑」的房间，点进去还会被当成唤醒。
//   2. 已经不在 sessionManager 里的成员（早就休眠 / 已关闭）不算失败。

const DEFAULT_REASON = 'meeting-room-complete';

// 成员已经不在会话表里 = 它本来就睡着了，不是这次没收成。
const SETTLED_ERRORS = new Set(['session-not-found']);

function suspendMeetingRoom(meetingId, deps = {}) {
  const {
    meetingManager,
    sessionManager,
    sendToRenderer = () => {},
    logger = console,
    reason = DEFAULT_REASON,
  } = deps;

  if (!meetingId) return { ok: false, error: 'meeting-id-missing' };
  if (!meetingManager || typeof meetingManager.getMeeting !== 'function') {
    return { ok: false, error: 'meeting-manager-missing' };
  }
  if (!sessionManager || typeof sessionManager.suspendSession !== 'function') {
    return { ok: false, error: 'session-manager-missing' };
  }

  const meeting = meetingManager.getMeeting(meetingId);
  if (!meeting) return { ok: false, error: 'meeting-not-found' };

  const suspended = [];
  const skipped = {};
  const blocked = [];
  for (const sessionId of Array.isArray(meeting.subSessions) ? meeting.subSessions : []) {
    if (!sessionId) continue;
    let result;
    try {
      result = sessionManager.suspendSession(sessionId, { reason });
    } catch (error) {
      result = { ok: false, error: 'suspend-threw', message: error && error.message ? error.message : String(error) };
    }
    if (result && result.ok) {
      suspended.push(sessionId);
      continue;
    }
    const key = (result && result.error) || 'unknown';
    skipped[key] = (skipped[key] || 0) + 1;
    if (!SETTLED_ERRORS.has(key)) blocked.push({ sessionId, error: key, ...(result?.message ? { message: result.message } : {}) });
  }

  let meetingDormant = false;
  if (!blocked.length && typeof meetingManager.updateMeeting === 'function') {
    const updated = meetingManager.updateMeeting(meetingId, { status: 'dormant' });
    if (updated) {
      meetingDormant = true;
      try { sendToRenderer('meeting-updated', { meeting: updated }); }
      catch (error) {
        if (logger && typeof logger.warn === 'function') {
          logger.warn('[meeting-room-suspend] meeting-updated 推送失败:', error && error.message ? error.message : error);
        }
      }
    }
  }

  if (logger && typeof logger.log === 'function') {
    logger.log(`[meeting-room-suspend] ${meetingId} reason=${reason} suspended=${suspended.length}`
      + ` blocked=${blocked.length} dormant=${meetingDormant}`);
  }

  return { ok: true, meetingId, reason, suspended, skipped, blocked, meetingDormant };
}

module.exports = { DEFAULT_REASON, suspendMeetingRoom };
