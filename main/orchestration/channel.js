'use strict';
// 持久化的星型通信；成员身份由服务端凭证确定，模型只指定收件人。
// 2026-10-23：成员发给负责人的消息并入 Hub 通知（wake=false 只留言、不单独叫醒）；
// 负责人可用 interrupt=true 把指示追加进成员正在进行的工作（inject），送不进去就退回排队。
const Ledger = require('../../core/orchestration/ledger');
const NOTICE_LIMIT = 1800;
function interruptText(item, source) {
  return [`## 负责人追加指示（${item.id}，来自 ${source?.name || item.from}）`, item.text,
    '按这条指示调整当前工作；不重做已完成的部分。需要回复时用 orch_send_message(to="' + item.from + '", message="回复")。'].join('\n');
}
function createChannel({ ledgerFor, members, persist, notify, dispatch, inject = null, ensureReady, busy, now, isFrozen, logger }) {
  const sending = new Set();
  const pair = (a, b) => [a, b].sort().join(':');
  function state(id) {
    const l = ledgerFor(id);
    l.channel ||= { messages: [], requests: [], grants: [] };
    return l.channel;
  }
  function enqueue(id, from, to, text, type = 'message', extra = {}) {
    const s = state(id);
    const item = { id: Ledger.newId('msg'), from, to, text, type, state: 'queued', at: now(), ...extra };
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
    if (target.orchestrator) {
      // 成员 → 负责人：并入通知，和同时到达的交付、故障一起送；wake=false 等负责人下次醒来再看。
      const wake = args.wake !== false;
      const item = { id: Ledger.newId('msg'), from: caller.memberId, to: target.memberId, text, type: 'message', state: 'noticed', wake, at: now() };
      s.messages.push(item);
      notify(id, item.id, `${caller.name}（${caller.memberId}）${wake ? '' : '留言'}：${text}`, { quiet: !wake });
      persist(id);
      const truncated = text.length > NOTICE_LIMIT;
      return { messageId: item.id, status: wake ? 'lead_notified' : 'left_for_lead',
        note: (wake ? '已叫醒负责人（与同时到达的通知合并送达）；继续做不受影响的部分。' : '已留言，负责人下次醒来一起看。') + (truncated ? `正文超过约 ${NOTICE_LIMIT} 字会被截断，长内容请写进文件后发路径。` : '') };
    }
    const result = enqueue(id, caller.memberId, target.memberId, text, 'message', caller.orchestrator && args.interrupt === true ? { interrupt: true } : {});
    if (!caller.orchestrator && !target.orchestrator) notify(id, result.messageId + ':copy', `${caller.name} → ${target.name}（已批准的成员交流）：${text}`, { quiet: true });
    if (caller.orchestrator && args.interrupt === true) result.note = '已入队；对方正在工作时直接追加进它当前的工作，空闲时作为新任务开始。结果可用 orch_status 查看。';
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
    const text = `成员交流申请 ${r.id} 已${args.approve ? '批准，两位可用 orch_send_message 双向交流，消息会抄送负责人' : '拒绝'}。${r.decision}`;
    enqueue(id, caller.memberId, r.from, text, 'decision');
    if (args.approve) enqueue(id, caller.memberId, r.to, text, 'decision');
    return r;
  }
  // 负责人主动开放 / 收回两位成员之间的直接交流（不必等成员申请）。
  function allow(id, caller, args) {
    if (!caller.orchestrator) throw Error('成员交流关系由负责人安排');
    if (typeof args.allow !== 'boolean') throw Error('allow 必须为 true 或 false');
    const roster = members(id), a = roster.find(m => m.memberId === String(args.memberA || '')), b = roster.find(m => m.memberId === String(args.memberB || ''));
    if (!a || !b || a.memberId === b.memberId || a.orchestrator || b.orchestrator) throw Error('memberA、memberB 要写两位不同的工作成员编号');
    const s = state(id), key = pair(a.memberId, b.memberId), had = s.grants.includes(key);
    if (args.allow && !had) s.grants.push(key);
    if (!args.allow && had) s.grants = s.grants.filter(g => g !== key);
    const reason = String(args.reason || '').trim();
    persist(id);
    if (args.allow !== had) {
      const text = args.allow
        ? `负责人已开放 ${a.name}（${a.memberId}）与 ${b.name}（${b.memberId}）之间的直接交流${reason ? '：' + reason : ''}。用 orch_send_message 互发消息，消息会抄送负责人。`
        : `负责人已收回 ${a.memberId} 与 ${b.memberId} 之间的直接交流${reason ? '：' + reason : ''}。之后请经负责人沟通。`;
      enqueue(id, caller.memberId, a.memberId, text, 'decision');
      enqueue(id, caller.memberId, b.memberId, text, 'decision');
    }
    return { ok: true, pair: [a.memberId, b.memberId], allowed: args.allow, grants: s.grants.slice() };
  }
  async function interruptNow(id, item, target, source) {
    const lock = id + ':' + item.to;
    sending.add(lock); item.state = 'sending'; persist(id);
    const fallback = reason => {
      // 没送进正在进行的工作：退回普通排队，对方空闲后作为新一轮送达。
      item.state = 'queued'; item.interrupt = false; item.interruptError = String(reason || '未确认送达').slice(0, 300);
      notify(id, item.id + ':interrupt-fallback', `发给 ${target.name} 的追加指示没能插进它当前的工作（${item.interruptError}），已改为等它空闲后送达。`, { quiet: true });
    };
    try {
      const result = await inject(id, target, interruptText(item, source));
      if (result && result.accepted) { item.state = 'sent'; item.sentAt = now(); item.via = 'interrupt'; }
      else if (result && result.uncertain) {
        // 写进去了但没拿到确认：不自动重发，免得同一条指示出现两次。
        item.state = 'sent'; item.sentAt = now(); item.via = 'interrupt'; item.uncertain = true;
        notify(id, item.id + ':interrupt-uncertain', `发给 ${target.name} 的追加指示已写入它的会话，但没拿到确认（${String(result.reason || '').slice(0, 200)}）；可在它的回答里核对，必要时重发。`, { quiet: true });
      } else fallback(result?.reason);
    } catch (error) { fallback(error.message || error); }
    finally { sending.delete(lock); persist(id); setImmediate(() => flush(id).catch(error => logger.warn('[orchestration] message delivery:', error.message))); }
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
    const urgent = typeof inject === 'function' && s.messages.find(m => m.state === 'queued' && m.interrupt && !sending.has(id + ':' + m.to) && roster.some(r => r.memberId === m.to && busy(r.sid)));
    if (urgent) {
      void interruptNow(id, urgent, roster.find(r => r.memberId === urgent.to), roster.find(r => r.memberId === urgent.from));
      return;
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
  return { send, request, decide, allow, flush, recover, state };
}
module.exports = { createChannel };
