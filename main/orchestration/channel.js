'use strict';
// 持久化的星型通信；成员身份由服务端凭证确定，模型只指定收件人。
const Ledger = require('../../core/orchestration/ledger');
function createChannel({ ledgerFor, members, persist, notify, dispatch, ensureReady, busy, now, isFrozen, logger }) {
  const sending = new Set();
  const pair = (a, b) => [a, b].sort().join(':');
  function state(id) {
    const l = ledgerFor(id);
    l.channel ||= { messages: [], requests: [], grants: [] };
    return l.channel;
  }
  function enqueue(id, from, to, text, type = 'message') {
    const s = state(id);
    const item = { id: Ledger.newId('msg'), from, to, text, type, state: 'queued', at: now() };
    s.messages.push(item);
    persist(id);
    setImmediate(() => flush(id).catch(error => logger.warn('[orchestration] message delivery:', error.message)));
    return { messageId: item.id, status: 'queued', note: '已入队；收件人空闲后送达，结果可用 orch_status 查看。' };
  }
  function send(id, caller, args) {
    const roster = members(id), target = roster.find(m => m.memberId === String(args.to || ''));
    const text = String(args.message || '').trim();
    if (!text) throw Error('message 不能为空');
    if (!target || target.memberId === caller.memberId) throw Error('请指定本群中另一位成员');
    const s = state(id);
    if (!caller.orchestrator && !target.orchestrator && !s.grants.includes(pair(caller.memberId, target.memberId))) {
      throw Error('成员间交流需先用 orch_request_peer 向编排员申请');
    }
    const result = enqueue(id, caller.memberId, target.memberId, text);
    if (!caller.orchestrator && !target.orchestrator) notify(id, result.messageId + ':copy', `${caller.name} → ${target.name}（已批准的成员交流）：${text}`);
    return result;
  }
  function request(id, caller, args) {
    const target = members(id).find(m => m.memberId === String(args.memberId || ''));
    const reason = String(args.reason || '').trim();
    if (caller.orchestrator || !target || target.orchestrator || target.memberId === caller.memberId || !reason) throw Error('请说明与另一位工作成员交流的原因');
    const s = state(id);
    const pending = s.requests.find(r => r.from === caller.memberId && r.to === target.memberId && r.status === 'pending');
    if (pending) return pending;
    const r = { id: Ledger.newId('peer'), from: caller.memberId, to: target.memberId, reason, status: 'pending', at: now() };
    s.requests.push(r); persist(id);
    notify(id, r.id, `${caller.name} 申请与 ${target.name} 交流：${reason}。请用 orch_decide_peer(requestId=${r.id}, approve=true/false, reason=说明) 处理。`);
    return r;
  }
  function decide(id, caller, args) {
    if (!caller.orchestrator) throw Error('交流申请由编排员处理');
    if (typeof args.approve !== 'boolean') throw Error('approve 必须为 true 或 false');
    const s = state(id), r = s.requests.find(r => r.id === args.requestId);
    if (!r || r.status !== 'pending') throw Error('没有待处理的交流申请');
    r.status = args.approve ? 'approved' : 'declined'; r.decision = String(args.reason || '');
    if (args.approve && !s.grants.includes(pair(r.from, r.to))) s.grants.push(pair(r.from, r.to));
    persist(id);
    const text = `成员交流申请 ${r.id} 已${args.approve ? '批准，两位可用 orch_send_message 双向交流，消息会抄送编排员' : '拒绝'}。${r.decision}`;
    enqueue(id, caller.memberId, r.from, text, 'decision');
    if (args.approve) enqueue(id, caller.memberId, r.to, text, 'decision');
    return r;
  }
  async function flush(id) {
    const l = ledgerFor(id);
    if (isFrozen() || !l || ['halted', 'ended', 'finished'].includes(l.status)) return;
    const s = state(id), roster = members(id);
    for (const pending of s.messages.filter(m => m.state === 'queued')) {
      if (!roster.some(r => r.memberId === pending.to) || !roster.some(r => r.memberId === pending.from)) {
        pending.state = 'failed'; pending.error = '通信成员已离开群聊';
        notify(id, pending.id + ':removed', `${pending.id} 未送达：${pending.error}`);
        persist(id);
      }
    }
    const item = s.messages.find(m => m.state === 'queued' && !sending.has(id + ':' + m.to) && roster.some(r => r.memberId === m.to && !busy(r.sid)));
    if (!item) return;
    const target = roster.find(r => r.memberId === item.to);
    const source = roster.find(r => r.memberId === item.from);
    const lock = id + ':' + item.to;
    sending.add(lock); item.state = 'sending'; persist(id);
    setImmediate(() => flush(id).catch(error => logger.warn('[orchestration] message delivery:', error.message)));
    try {
      await ensureReady(id, target.memberId);
      if (isFrozen() || ['halted','ended','finished'].includes(l.status) || busy(target.sid)) { item.state = 'queued'; return; }
      const shouldDispatch = () => !isFrozen() && !['halted','ended','finished'].includes(ledgerFor(id)?.status) && item.state === 'sending';
      const result = await dispatch(id, {
        shouldDispatch,
        userInput: `【群内通信 ${item.id}】${source?.name || item.from} → ${target.name}\n${item.text}\n\n需要回复发件人时，用 orch_send_message(to="${item.from}", message="回复")；正式结果仍按本轮回答文件要求交付。`,
        targetMemberIds: [target.memberId], appendUserMessage: false,
        workflowRun: { kind: 'orchestration', runId: item.id, stepIndex: 0, attempt: 1 }, fileHandoff: true, turnTimeoutMs: 0,
      });
      if (!shouldDispatch() && (result?.cancelledBeforeDispatch || !result || ['no_sent','cancelled','skipped'].includes(result.status))) { item.state = 'queued'; return; }
      if (!result || ['error','no_sent','no_subs'].includes(result.status) || result.results?.some(r => ['errored','absent','failed','not_sent'].includes(r.status))) throw Error(result?.reason || '消息未送达');
      item.state = 'sent'; item.sentAt = now();
    } catch (error) {
      item.state = 'failed'; item.error = error.message;
      notify(id, item.id + ':failed', `${source?.name || item.from} 发给 ${target.name} 的消息未送达：${error.message}。内容保留在 orch_status，可处理后重新发送。`);
    } finally { sending.delete(lock); persist(id); }
  }
  function recover(id) {
    for (const m of state(id).messages) if (m.state === 'sending') {
      m.state = 'failed'; m.error = 'Hub 重启前可能已送达，请编排员核对后决定是否重发';
      notify(id, m.id + ':uncertain', `${m.id} 在 Hub 重启前可能已送达，已保留内容，请核对后决定是否重发。`);
    }
  }
  return { send, request, decide, flush, recover, state };
}
module.exports = { createChannel };
