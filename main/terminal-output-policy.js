'use strict';

// 群聊里未被聚焦的成员，PTY 输出**仍然要送到 renderer** —— 只是降频。
//
// 2026-07-26 的性能优化把未聚焦成员的输出「完全不转发」，只留 main 侧 1MB ring
// buffer，用户切过去时一次性回灌。CPU 确实降了，代价却是交互退化：
//   · 未聚焦期间 xterm 收不到任何数据 → scrollback 完全无法累积；
//   · 切过去只能靠回灌一段「从中间截断的原始 ANSI 流」重建画面；
//   · AI CLI 全是 alt-screen TUI（见 core/ai-kinds.js），回灌结果基本只剩最后一屏。
// 用户实测反馈：Codex 的 PTY 经常卡住、滚轮往上滑一点就到头、"只渲染了一点点"。
//
// 现在改成**降频而非丢弃**：
//   聚焦会话      8ms 合并（等同实时）
//   未聚焦成员  250ms 合并
// 相比逐 chunk 转发，IPC 次数仍降低一个数量级（250ms 合并 = 4 次/秒，而密集 TUI
// 重绘可达上百次/秒），但数据一条不丢，scrollback 正常累积。
//
// 为什么这不会把 CPU 吃回去：renderer 对没有 xterm 实例的会话本来就直接丢弃
// （terminalCache 未命中即 return），所以「从没打开过的成员」依然是零渲染成本；
// 真正被省掉的是 IPC 往返次数，而那部分收益完整保留。
//
// 另外两条路已经试过并放弃，不要再走（详见 core/session-manager.js 顶部注释）：
//   × 回灌时对齐到最后一次 \x1b[2J —— TUI 每帧都清屏，对齐等于丢光滚动回缓冲；
//   × 给 CLI 传 --no-alt-screen —— 观感无改善且 Enter 提交失效。

const LIVE_BATCH_MS = 8;
const BACKGROUND_BATCH_MS = 250;

// 返回该会话本次输出应使用的合并延迟（ms）。
function getTerminalBatchDelay(sessionManager, sessionId) {
  if (!sessionManager || typeof sessionManager.getSession !== 'function') return LIVE_BATCH_MS;
  const session = sessionManager.getSession(sessionId);
  // 独立会话永远实时；群聊成员只有未聚焦时降频。
  if (!session || !session.meetingId) return LIVE_BATCH_MS;
  return sessionManager.focusedSessionId === sessionId ? LIVE_BATCH_MS : BACKGROUND_BATCH_MS;
}

// 是否是「后台成员」——调用方据此决定要不要额外发一个轻量活动指示给房间。
function isBackgroundMember(sessionManager, sessionId) {
  return getTerminalBatchDelay(sessionManager, sessionId) > LIVE_BATCH_MS;
}

// 保留旧名字给外部调用点/测试：现在**任何会话的输出都要转发**，差别只在节奏。
function shouldForwardTerminalOutput() {
  return true;
}

module.exports = {
  getTerminalBatchDelay,
  isBackgroundMember,
  shouldForwardTerminalOutput,
  LIVE_BATCH_MS,
  BACKGROUND_BATCH_MS,
};
