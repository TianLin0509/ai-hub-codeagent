'use strict';

// Claude / Codex 用哪条后端跑，只在这里决定。
//
// 2026-09-25 用户拍板回到「CLI 为核心 + 卡片视图」：默认 pty，即 PowerShell 里跑真实
// TUI，状态靠 CLI hook，卡片读 CLI 自己落盘的 transcript / rollout。
// native（Claude stream-json / Codex App Server）保留为回退开关，UI 不暴露：
//   CLAUDE_HUB_AGENT_RUNTIME=native，或 config.json 的 runtime.agent = "native"。
// 非法值一律按 pty 处理并告警，不静默切到另一套路径以外的第三种状态。

const PTY = 'pty';
const NATIVE = 'native';
const AGENT_KINDS = new Set(['claude', 'claude-resume', 'codex', 'codex-resume']);

let warnedValue = null;
function agentRuntimeMode(config) {
  let raw;
  try { raw = (config || require('./hub-config').getConfig()).agentRuntime; } catch { raw = process.env.CLAUDE_HUB_AGENT_RUNTIME; }
  const value = String(raw == null || raw === '' ? PTY : raw).trim().toLowerCase();
  if (value === PTY || value === NATIVE) return value;
  if (warnedValue !== value) {
    warnedValue = value;
    console.warn(`[agent-runtime] 未知的 runtime.agent=${value}，按 pty 处理`);
  }
  return PTY;
}

// DeepSeek 旧 Claude 兼容会话、ACP profile 等不受这个开关影响。
function usesNativeAgentRuntime(kind, config) {
  return AGENT_KINDS.has(kind) && agentRuntimeMode(config) === NATIVE;
}

function usesPtyAgentRuntime(kind, config) {
  return AGENT_KINDS.has(kind) && agentRuntimeMode(config) === PTY;
}

// 这一条已经按 PTY 启动的 Claude / Codex 会话（看会话自己的标记，不看当前开关）。
function isPtyAgentSession(session) {
  return !!session && session.agentRuntime === PTY && !session.runtimeBackend;
}

module.exports = { PTY, NATIVE, AGENT_KINDS, agentRuntimeMode, usesNativeAgentRuntime, usesPtyAgentRuntime, isPtyAgentSession };
