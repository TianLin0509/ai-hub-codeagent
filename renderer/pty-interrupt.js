'use strict';

// PTY 里跑的 Claude / Codex 的「停止」。
// 2026-09-26 真机：答题中双击停止 = 两次 Ctrl+C，Codex 第二次直接「Shutting down」退回 PowerShell，
// Hub 仍显示空闲，下一条消息就被当成 shell 命令。两家 TUI 的中断键都是 Esc（状态矩阵的中断场景
// 即用它），但空闲时连按两次 Esc 会进入「回退编辑历史消息」。所以只在确实运行 / 等待确认时发
// 一次 Esc，短时间内的连点忽略。
const PTY_INTERRUPT_STATES = new Set(['running', 'starting', 'waiting']);
const PTY_INTERRUPT_THROTTLE_MS = 1500;

function sendPtyAgentInterrupt(session, { state, send, now = Date.now() } = {}) {
  if (!session || !PTY_INTERRUPT_STATES.has(state)) return false;
  const last = Number(session._ptyStopSentAt) || 0;
  if (last && now - last < PTY_INTERRUPT_THROTTLE_MS) return false;
  session._ptyStopSentAt = now;
  // Qwen ignores Escape while its composer has a draft; Ctrl+C invokes its
  // cancel action first. Never repeat it within the same authoritative turn.
  const qwen=String(session.kind||'').replace(/-resume$/,'')==='qwen';
  if(qwen&&session.cliRuntime?.turnId){
    if(session._qwenStopTurn===session.cliRuntime.turnId)return false;
    session._qwenStopTurn=session.cliRuntime.turnId;
  }
  send(qwen?'\x03':'\x1b');
  return true;
}

module.exports = { sendPtyAgentInterrupt, PTY_INTERRUPT_STATES, PTY_INTERRUPT_THROTTLE_MS };
