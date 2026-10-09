'use strict';

function isNativeClaude(session) { return session?.runtimeBackend === 'claude-stream-json'; }
// Same evidence line Codex shows while waiting: the question or the tool being
// approved, not a generic "在等你回答".
function claudeRequestSummary(request) {
  const p = request && request.params || {};
  return (p.questions || []).map(q => q && q.question).filter(Boolean).join('; ')
    || (p.toolName ? '等待批准工具 ' + p.toolName : '') || 'Claude 等待你确认';
}
// The engine retries a failed API call on its own (up to max_retries) and says
// so with a system/api_retry frame. Without this line a 529 storm looks exactly
// like a Hub hang: minutes of "正在工作" and no output.
function claudeApiRetrySummary(snapshot) {
  const retry = snapshot?.apiRetry;
  if (!retry || !['starting', 'running'].includes(snapshot.state)
      || (retry.userMessageId && retry.userMessageId !== snapshot.userMessageId)) return '';
  const cause = retry.status === 529 ? '服务繁忙' : retry.status === 429 ? '请求限流'
    : retry.status >= 500 ? '服务异常' : '连接不稳定';
  const code = retry.status ? `（${retry.status}）` : '';
  const count = retry.maxRetries ? `${retry.attempt}/${retry.maxRetries}` : `${retry.attempt}`;
  return `Claude ${cause}${code}，引擎自动重试第 ${count} 次`;
}
function claudeRuntimeTruth(session) {
  const snapshot = session.nativeRuntime || {};
  const state = session.status === 'dormant' ? 'dormant'
    : snapshot.connection === 'disconnected' && !['completed', 'failed', 'interrupted'].includes(snapshot.state)
      ? 'unknown' : snapshot.state || 'unknown';
  const connected = snapshot.connection === 'connected';
  return { state, source: 'claude-stream-json', confidence: connected || snapshot.connection === 'unstarted' ? 'authoritative' : 'none',
    observedAt: snapshot.observedAt || 0, startedAt: snapshot.startedAt || 0,
    completedAt: snapshot.completedAt || 0, expiresAt: 0, reason: snapshot.reason || null,
    turnId: snapshot.turnId || null, userMessageId: snapshot.userMessageId || null,
    providerSessionId: snapshot.providerSessionId || null, epoch: snapshot.epoch || 0,
    revision: snapshot.revision || 0, corroborations: [],
    evidence: state === 'waiting' ? (snapshot.requests || []).map(claudeRequestSummary).join('; ') || (snapshot.reason || '')
      : snapshot.reason || '',
    connection: snapshot.connection || 'disconnected',
    cancellation: snapshot.cancellation || null,
  };
}

module.exports = { isNativeClaude, claudeRuntimeTruth, claudeRequestSummary, claudeApiRetrySummary };
