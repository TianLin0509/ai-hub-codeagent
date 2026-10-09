'use strict';

const supported = session => ['codex-app-server', 'claude-stream-json'].includes(session?.runtimeBackend);

// A display-only observation, never an execution vote. The event carries the
// identity stamped by Main; old writers/turns cannot refresh the current clock.
function recordNativeContent(session, event, now = Date.now()) {
  if (!supported(session) || session.status === 'dormant') return false;
  const r = session.nativeRuntime;
  if (!r || r.connection !== 'connected' || event.epoch !== r.epoch) return false;
  const claude = session.runtimeBackend === 'claude-stream-json';
  const identity = claude ? r.providerSessionId : r.threadId;
  const turn = claude ? r.userMessageId : r.turnId;
  if (!identity || !turn || (claude ? event.providerSessionId : event.threadId) !== identity
      || (claude ? event.userMessageId : event.turnId) !== turn) return false;
  session.nativeFeedback = { epoch: r.epoch, identity, turn, receivedAt: now };
  return true;
}

function nativeContentAge(session, now = Date.now()) {
  if (!supported(session) || session.status === 'dormant') return '';
  const r = session.nativeRuntime || {}, f = session.nativeFeedback;
  if (r.connection !== 'connected' || r.state !== 'running' || r.cancellation || r.configurationChange) return '';
  const claude = session.runtimeBackend === 'claude-stream-json';
  if (!f || f.epoch !== r.epoch || f.identity !== (claude ? r.providerSessionId : r.threadId)
      || f.turn !== (claude ? r.userMessageId : r.turnId)) return '';
  const seconds = Math.max(0, Math.floor((now - f.receivedAt) / 1000));
  const age = seconds < 60 ? `${seconds} 秒` : `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
  return seconds < 2 ? '刚收到更新' : seconds < 30 ? `${age}前收到更新` : `${age}没有新输出，等待后续结果`;
}

function promptReceipt(session, id, { authoritative = false, local, deliveryStatus } = {}) {
  if (!supported(session) || !id) return '';
  const r = session.nativeRuntime || {}, s = r.submission || {};
  const same = (s.id || s.clientSubmissionId || s.submissionId) === id;
  const status = same ? s.status || s.sendStatus : deliveryStatus;
  if (status === 'content-mismatch' || local?.status === 'content-mismatch') return '提交内容未确认';
  if (status === 'rejected' || local?.status === 'failed') return '提交失败';
  if (status === 'unknown' || local?.status === 'unconfirmed') return authoritative ? '引擎已收到 · 执行结果未确认' : '提交结果未确认';
  if (authoritative || status === 'accepted' || local?.status === 'confirmed') return '引擎已收到';
  if (status === 'queued' || local?.status === 'queued' || r.queued?.some(q => q.submissionId === id)) return '已排队 · 等待发送';
  if (status === 'cancelled') return '发送前已取消';
  if (status === 'interrupted') return '提交已中断';
  return 'Hub 已接收 · 正在提交';
}

const hasNativeReceipt = turn => turn?.source === 'codex-app-server'
  || turn?.source === 'claude-stream-json' && turn.receiptAccepted === true;
module.exports = { supported, recordNativeContent, nativeContentAge, promptReceipt, hasNativeReceipt };
