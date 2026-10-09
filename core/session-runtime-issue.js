'use strict';
const { getSessionRuntimeTruth } = require('./session-runtime-truth');
const { hasStreamDisconnectIssue } = require('./stream-disconnect');

// Attention is a projection, not another runtime state writer. In particular a
// disconnected native runtime remains unknown until the provider reconciles it.
function sessionRuntimeIssue(session, truth = getSessionRuntimeTruth(session)) {
  if (!session || session.status === 'dormant' || truth.state === 'dormant') return null;
  if (truth.state === 'failed') return { label:'运行异常', message:truth.evidence || truth.reason || session.lastError || '本轮执行失败' };
  if (hasStreamDisconnectIssue(session)) return { label:'连接异常', message:session.connectionIssue.message || '连接已中断' };
  const native = session.nativeRuntime;
  if (native?.connection === 'disconnected' && native.state !== 'interrupted' && !session._resumePending) {
    return { label:'连接异常', message:native.reason || '连接已断开，状态待核对' };
  }
  // Claude 的一条提交没拿到收到证据、连接仍在：下一次发送会自动恢复，输入框只
  // 平静地说一句，侧栏也不再亮「待核对」（2026-09-24 用户决定）。
  const quietClaudeReceipt = session.runtimeBackend === 'claude-stream-json' && native?.connection === 'connected'
    && native?.cancellation?.status !== 'unknown';
  if (!quietClaudeReceipt && (native?.submission?.status === 'unknown' || native?.submission?.sendStatus === 'unknown')
      || native?.cancellation?.status === 'unknown') {
    return { label:'状态待核对', message:native.reason || '提交或停止操作尚未获得原生确认' };
  }
  return null;
}
module.exports = { sessionRuntimeIssue };
