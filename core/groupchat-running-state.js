'use strict';

const { isNativeSession, nativeUnfinished } = require('./codex-native-runtime.js');

const {
  RUNTIME_FAILED,
  RUNTIME_DORMANT,
  getSessionRuntimeTruth,
  sessionRuntimeIsActive,
} = require('./session-runtime-truth.js');

// Dispatcher watcher 活着时每 1.5 秒会送一次 streaming 心跳。给它留出数次抖动
// 余量，但不能再像旧实现那样让残留 gcWorking 挂 10 分钟。
const GC_WORKING_FRESH_MS = 8 * 1000;

function hasFreshGroupChatWork(session, now = Date.now()) {
  if (!session || !session.gcWorking) return false;
  const ts = session._gcWorkingLastTs;
  if (typeof ts !== 'number' || !Number.isFinite(ts)) return false;
  const age = now - ts;
  return age >= 0 && age <= GC_WORKING_FRESH_MS;
}

function isGroupChatMemberRunning(session, now = Date.now()) {
  if (isNativeSession(session)) return nativeUnfinished(session);
  if (session?.runtimeBackend === 'claude-stream-json') return ['starting', 'running', 'waiting'].includes(getSessionRuntimeTruth(session).state);
  if (!session) return false;
  const runtime = getSessionRuntimeTruth(session, { now });
  if (sessionRuntimeIsActive(session, { now })) return true;

  // 休眠/错误是不可运行的硬终态，不允许任何延迟到达的 watcher 心跳覆盖。
  if (runtime.state === RUNTIME_DORMANT || runtime.state === RUNTIME_FAILED) return false;

  // 群聊 watcher 比 PTY/hook 更贴近“这一轮是否仍在等该成员”。AI 思考期间
  // PTY 可能短暂回到 idle；只要心跳仍新鲜，侧栏就必须继续显示运行中。
  if (hasFreshGroupChatWork(session, now)) return true;

  // Legacy sessions without a materialized status predate RuntimeTruth and
  // heartbeat timestamps. Preserve their dispatcher-owned gcWorking signal.
  if (!String(session.status || '').trim()) return !!session.gcWorking;

  // Ctrl+C 后 status 会先回到 idle。没有新鲜心跳时，明确终态必须压过旧版遗留的
  // gcWorking（旧数据可能没有时间戳），避免状态灯永久亮着。
  if (runtime.state === 'idle' || runtime.state === 'completed') return false;

  // 兼容旧会话：状态未知时仍尊重 gcWorking；新的事件都会带时间戳并自动过期。
  return !!session.gcWorking;
}

module.exports = {
  GC_WORKING_FRESH_MS,
  hasFreshGroupChatWork,
  isGroupChatMemberRunning,
};
