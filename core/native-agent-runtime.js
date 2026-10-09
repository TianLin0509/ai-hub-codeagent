'use strict';
const codex = require('./codex-native-runtime');
const claude = require('./claude-native-runtime');

function isNativeAgent(session) {
  return codex.isNativeSession(session) || session?.runtimeBackend === 'claude-stream-json';
}

function nativeRuntimeTruth(session) {
  return claude.isNativeClaude(session) ? claude.claudeRuntimeTruth(session) : codex.nativeRuntimeTruth(session);
}

// Renderer copies never restore transport-bound approval requests. Submission
// identities and the previous process owner remain available for reconciliation.
function persistNativeRuntime(session) {
  if (session?.runtimeBackend !== 'claude-stream-json') return codex.persistNativeRuntime(session);
  const runtime = session.nativeRuntime;
  if (!runtime) return null;
  // "Never started" is not "disconnected": a seat that has not run yet must come
  // back unstarted instead of asking the user to reconcile a thread that never
  // existed.
  const connection = runtime.connection === 'unstarted' ? 'unstarted' : 'disconnected';
  return { ...runtime, connection, requests: [], waitingFlags: [], recoveryReady: false };
}

module.exports = { isNativeAgent, persistNativeRuntime, nativeRuntimeTruth };
