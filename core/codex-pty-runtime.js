'use strict';

const { isCodexCliKind } = require('./ai-kinds');
const { applySessionRuntimeObservation } = require('./session-runtime-truth');

// Keep native lifecycle evidence in main so reloading the renderer does not
// turn a live Codex task into an idle session. This state is process-local;
// persisted history is not treated as a currently running task on app startup.
function observeCodexPtyRuntime(entry, observation) {
  const info = entry?.info;
  if (info?.agentRuntime !== 'pty' || !isCodexCliKind(info.transcriptKind || info.kind)) return false;
  return applySessionRuntimeObservation(info, {
    confidence: 'authoritative', observedAt: Date.now(), ...observation,
  }, { mirrorLegacy: false }).applied;
}

function observeCodexHookActivity(entry, event, parsed, at) {
  if (!entry?.agentTurnActive) return false;
  if (entry.agentTurnId && parsed.turnId && entry.agentTurnId !== parsed.turnId) return false;
  const question = ['request_user_input', 'AskUserQuestion', 'ExitPlanMode'].includes(parsed.toolName);
  if (event === 'permission-request' || (event === 'tool-start' && question)) {
    return observeCodexPtyRuntime(entry, {
      state: 'waiting', source: event === 'permission-request' ? 'codex-permission-request' : 'codex-question',
      observedAt: at, turnId: parsed.turnId || entry.agentTurnId,
      reason: event === 'permission-request' ? 'permission' : 'question',
      evidence: event === 'permission-request' ? 'Codex 等待权限确认' : '请在 Codex 终端回答问题',
    });
  }
  if (event === 'tool-start' || (event === 'tool-complete' && question)) {
    return observeCodexPtyRuntime(entry, {
      state: 'running', source: `codex-${event}`, observedAt: at,
      turnId: parsed.turnId || entry.agentTurnId, startedAt: entry.agentTurnStartedAt,
      evidence: parsed.toolName || null,
    });
  }
  return false;
}

module.exports = { observeCodexPtyRuntime, observeCodexHookActivity };
