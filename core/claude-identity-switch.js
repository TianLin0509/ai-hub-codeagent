'use strict';

// PTY Claude 的原生身份什么时候可以跟着 CLI 换。
//
// 顶层 CLI 在 TUI 里执行 /clear、/resume，或者退出后在同一个 shell 里重新启动，
// 都会换一个新的 session_id。嵌套进程（模型在 Bash 工具里跑的 `claude -p`）和
// 子代理会继承 CLAUDE_HUB_SESSION_ID，它们的 hook 同样带着别的 session_id 打进来。
// 两者只看 SessionStart 分不开。
//
// 真机实测（2026-09-25，Claude Code TUI）的事件顺序：
//   /clear：SessionEnd(旧 id, reason=clear) → 约 0.6s 后 SessionStart(新 id, source=clear)
//   /exit ：SessionEnd(旧 id, reason=prompt_input_exit)
// 判据：只有「当前绑定的会话自己先宣布结束」之后的新 SessionStart 才允许改绑。
// 嵌套进程或子代理不可能替已绑定的会话发出 SessionEnd，所以串线仍然被拒绝。

const SWITCH_SOURCES = new Set(['clear', 'resume']);
// CLI 真正退出的原因；之后在同一个 shell 里重新启动的 claude 才算接班。
const EXIT_REASONS = new Set(['prompt_input_exit', 'logout', 'other', 'bypass_permissions_disabled']);
const SWITCH_WINDOW_MS = 30_000;

function createClaudeIdentitySwitch({ now = () => Date.now(), windowMs = SWITCH_WINDOW_MS } = {}) {
  const ended = new Map(); // hubSessionId -> { id, reason, at }
  return {
    /**
     * @returns {{action:'record-end'|'rebind'|'same'|'ignore', why?:string}}
     */
    observe(hubSessionId, { event, boundId, incomingId, source = null, reason = null, agentId = null, promptId = null } = {}) {
      if (!hubSessionId || !incomingId) return { action: 'ignore', why: 'no-identity' };
      if (agentId) return { action: 'ignore', why: 'subagent' };
      if (event === 'session-end') {
        if (!boundId || incomingId !== boundId) return { action: 'ignore', why: 'foreign-end' };
        ended.set(hubSessionId, { id: boundId, reason: reason || null, at: now(), promptId: promptId || null });
        return { action: 'record-end' };
      }
      if (event !== 'session-start') return { action: 'ignore', why: 'not-lifecycle' };
      if (!boundId || incomingId === boundId) return { action: 'same' };
      const end = ended.get(hubSessionId);
      if (!end || end.id !== boundId) return { action: 'ignore', why: 'bound-session-still-running' };
      const src = String(source || '');
      const accepted = SWITCH_SOURCES.has(src)
        ? now() - end.at <= windowMs
        : src === 'startup' && EXIT_REASONS.has(String(end.reason || ''));
      if (!accepted) return { action: 'ignore', why: `unproven-${src || 'unknown'}-after-${end.reason || 'end'}` };
      ended.delete(hubSessionId);
      // SessionEnd 的 prompt_id 标识这次 /clear 的执行周期（R7：一个周期只确认一条提交）。
      return { action: 'rebind', cycleId: end.promptId || null };
    },
    forget(hubSessionId) { ended.delete(hubSessionId); },
    _ended: ended,
  };
}

// /clear、/compact 的提交确认：谁该被哪个信号确认，由 claude-local-command-acks 决定
// （按会话、命令、提交顺序、执行周期归属；第 5 轮 R7）。这里保留旧入口名。
const { localCommandAcksFor, parseLocalCommand } = require('./claude-local-command-acks');

function claudeLocalCommand(text) {
  const parsed = parseLocalCommand(text);
  return parsed ? parsed.command : null;
}

function observeClaudeLocalCommand(manager, sessionId, command, args = '') {
  if (!['clear', 'compact'].includes(command)) throw new Error('unsupported Claude local command: ' + command);
  return localCommandAcksFor(manager).register(sessionId, command, args);
}

const observeClaudeClearCommand = (manager, sessionId) => observeClaudeLocalCommand(manager, sessionId, 'clear');

module.exports = {
  createClaudeIdentitySwitch, claudeLocalCommand, observeClaudeLocalCommand, observeClaudeClearCommand,
  SWITCH_WINDOW_MS, EXIT_REASONS,
};
