'use strict';
const {resolveRecipients}=require('../../core/groupchat-recipients');
const {PromptSubmissionReceipts}=require('../../core/prompt-submission-receipts');
const {isPtyAgentSession}=require('../../core/agent-runtime-mode');

// An already-running CLI is not evidence that this new message was accepted.
// Match the actual prompt, and keep listening for a late receipt without replay.
function createSpecificPromptObserver(sessionManager, transcriptTap) {
  const pending=new Map();
  const receipts=new PromptSubmissionReceipts(update=>{
    const entry=pending.get(update.clientSubmissionId);
    if(!entry)return;
    try {if(update.status==='confirmed')entry.onConfirmed(update);}
    finally {entry.cleanup();}
  });
  const onHook=event=>{
    if(event?.signalSource==='claude-user-prompt-submit')receipts.observe({...event,text:event.prompt});
  };
  const onTranscript=event=>receipts.observe(event);
  return (sid,id,prompt,onConfirmed)=>{
    receipts.prune(s=>!!sessionManager.getSession(s));
    if(!pending.size){
      sessionManager.on?.('agent-turn-started',onHook);
      transcriptTap?.on('prompt-submitted',onTranscript);
    }
    const receipt=receipts.begin(sid,id,prompt);
    let timer;
    const cleanup=()=>{
      clearTimeout(timer);pending.delete(id);
      const remaining=(receipts.unresolved.get(sid) || []).filter(r=>r!==receipt);
      if(remaining.length)receipts.unresolved.set(sid,remaining);else receipts.unresolved.delete(sid);
      if(receipts.get(sid)===receipt){
        if(remaining.length)receipts.entries.set(sid,remaining.at(-1));
        // Keep the last entry so prune can later remove this closed session's
        // deduplication history too; no listener or timer remains attached.
      }
      if(!pending.size){
        sessionManager.removeListener?.('agent-turn-started',onHook);
        transcriptTap?.removeListener('prompt-submitted',onTranscript);
      }
    };
    pending.set(id,{onConfirmed,cleanup});
    timer=setTimeout(cleanup,10*60*1000);timer.unref?.();
    return {receipt,cleanup};
  };
}
/*
 * 群聊插话（用户补充）· IPC
 * ────────────────────────────────────────────────────────────────────────────
 *
 * 修的是这个：开发群聊的循环跑起来之后，你在群聊输入框打一句话，renderer 走的是
 * `loop:start`，主进程看到循环已在跑就返回 already_running，消息被退回输入框 ——
 * 你以为说了，其实一个字都没送出去，也没落盘。
 *
 * 这条路的语义是「给当前任务补一句话」，不是「开一个新任务」：
 *   1. 先落盘（原文、身份、顺序都留在群聊消息里，看得见也查得到）；
 *   2. 头像选中的已打开成员即时收到 —— 现代 CLI 支持在回答中接新 prompt，
 *      走的是和派工一样的闭环提交（分块 → settle → 语义确认 → 有界补回车），
 *      **不是**盲发回车；
 *   3. 选中但尚未打开的成员不唤醒，只在账本里记一格；它下次真的被派工时，
 *      dispatcher 把没送到的原文补进 prompt。
 *
 * 它不开新一轮、不抢占当前步骤、不重置返工预算、不改阶段。
 * 送不出去就如实返回，账本保留待确认 —— 不提前标已读，也不盲目重发。
 */

// 即时注入时给一层很薄的框，让 agent 知道这是维护者插的一句话，
// 不是新的任务书，也不是「该交接了」的信号。刻意短：长了会挤占它正在做的事。
function wrapImmediate(text) {
  return [
    '## 维护者插话（不是新任务，也不是交接信号）',
    String(text || ''),
    '按当前阶段职责消化这句话；不要因此重置任务、重做已完成的部分，或提前交接。',
  ].join('\n');
}

function registerGroupchatSupplementIpc(ipcMain, deps) {
  const {
    getActiveWatchers,
    getHubDataDir,
    groupchat,
    groupChatWatcher,
    logger = console,
    meetingManager,
    sendToRenderer = () => {},
    sessionManager,
    transcriptTap,
  } = deps || {};
  if (!ipcMain || !groupchat || !meetingManager || !sessionManager) return;
  const observeSpecificPrompt=createSpecificPromptObserver(sessionManager,transcriptTap);

  // 已经把 prompt 送进去、正在等它回答的那几种状态。此时再往同一个 PTY 写一句话是安全的，
  // 也正是用户要的「插一句给正在干活的那位」。
  const INJECTABLE_ATTEMPT_STATES = new Set(['accepted', 'running', 'awaiting_binding', 'awaiting_final_text']);

  /**
   * 现在真的在跑、而且可以安全插话的成员。
   *
   * 2026-09-08 真实 CLI 上复现：原来只看 dispatcher 内存里的活跃 watcher，
   * 而 watcher 是在 sendToPty 之后才注册的 —— 派工刚提交、回答还没开始的那个窗口里，
   * 插话会被静默降级成「待送达」，用户以为送到了正在干活的那位，其实一个都没送。
   *
   * 所以判据改成两处取并集：内存里的活跃 watcher，加上编排器持久记录里
   * **已经提交、正在等回答**的席位。刻意不含 prepared / submitting ——
   * 未提供头像快照的旧调用仍用此判据；头像发送由共享提交队列避免交错。
   */
  function runningSidsOf(orch, memberSids) {
    const live = new Set();
    const watchers = typeof getActiveWatchers === 'function' ? getActiveWatchers() : null;
    if (watchers && typeof watchers.get === 'function') {
      for (const sid of memberSids) {
        const watcher = watchers.get(sid);
        if (!watcher) continue;
        if (typeof watcher.isSettled !== 'function' || !watcher.isSettled()) live.add(sid);
      }
    }
    try {
      const state = orch.state || {};
      const activeRunId = state.activeRun && state.activeRun.runId;
      for (const attempt of Object.values(state.attempts || {})) {
        if (!attempt || !attempt.sid || !memberSids.includes(attempt.sid)) continue;
        if (activeRunId && attempt.runId && attempt.runId !== activeRunId) continue;
        if (INJECTABLE_ATTEMPT_STATES.has(String(attempt.status || ''))) live.add(attempt.sid);
      }
    } catch (error) {
      logger.warn('[groupchat-supplement] 读取执行记录失败：', error && error.message);
    }
    return memberSids.filter(sid => live.has(sid));
  }

  ipcMain.handle('groupchat:user-supplement', async (_event, args = {}) => {
    const meetingId = typeof args.meetingId === 'string' ? args.meetingId : '';
    const text = typeof args.text === 'string' ? args.text : '';
    if (!meetingId || !text.trim()) return { ok: false, reason: 'invalid_args' };
    const meeting = meetingManager.getMeeting(meetingId);
    if (!meeting || !meeting.groupChat) return { ok: false, reason: 'group_chat_not_found' };

    let orch;
    try { orch = groupchat.getOrchestrator(getHubDataDir(), meetingId); }
    catch (error) {
      logger.warn('[groupchat-supplement] orchestrator unavailable:', error && error.message);
      return { ok: false, reason: 'meeting_state_unavailable' };
    }

    // Only the avatars selected when Send was clicked. A later workflow step
    // may already have changed meeting.participants by the time this arrives.
    // 不为了刷「全员已读」额外唤醒它：未打开的成员明确保留待送达。
    let memberSids;
    try {memberSids=resolveRecipients(meeting,args.recipientSids);}
    catch(error){return {ok:false,reason:error.message};}
    const toLabels=memberSids.map(sid=>{
      const i=meeting.subSessions.indexOf(sid),slot=meeting.slotSpecs?.[i],session=sessionManager.getSession(sid);
      return slot?.title || slot?.displayName || session?.title || slot?.memberId || `成员 ${i+1}`;
    });

    const added = orch.appendUserSupplement(text, { recipientSids: memberSids, toLabels, source: 'input-box' });
    if (!added) return { ok: false, reason: 'empty_text' };
    try{sendToRenderer('groupchat-user-supplement',{meetingId,seq:added.seq,revision:orch.state.revision});}
    catch(error){logger.warn('[groupchat-supplement] renderer notify failed:',error.message);}

    const deliveredNow = [];
    const queuedSids = [];
    const failures = [];
    const messageReceipts=new Map();
    const active=new Set(runningSidsOf(orch,memberSids));
    const immediate=memberSids.filter(sid=>{
      const s=sessionManager.getSession(sid);
      return s && s.status!=='dormant' && (Array.isArray(args.recipientSids) || active.has(sid));
    });
    // Reserve EVERY immediate recipient before the first await. A workflow
    // advancing during submission must not include the same supplement again.
    for(const sid of immediate)orch.markUserSupplementsUncertain?.(sid,[added.seq]);
    for (const sid of immediate) {
      const session = sessionManager.getSession(sid);
      if(!session || session.status==='dormant'){
        orch.releaseUserSupplementsUnsent?.(sid,[added.seq]);continue;
      }
      // Existing callers without a snapshot retain the legacy idle fallback;
      // the group composer supplies a snapshot and sends to every open target.
      if(!Array.isArray(args.recipientSids) && !active.has(sid))continue;
      const kind = session ? (session.transcriptKind || session.kind) : null;
      if (!kind) { failures.push({ sid, reason: 'no_session' }); continue; }
      let receipt;
      let messageReceipt;
      try {
        const prompt=wrapImmediate(text),index=meeting.subSessions.indexOf(sid);
        receipt=orch.recordSupplementPrompt?.(sid,prompt,{seq:added.seq,kind,memberId:meeting.slotSpecs?.[index]?.memberId || `m${index+1}`,
          label:toLabels[memberSids.indexOf(sid)],native:!!session.runtimeBackend});
        if(receipt)require('../../core/dev-chat-history').rememberPrompt(orch,sid,receipt);
        if(isPtyAgentSession(session))messageReceipt=observeSpecificPrompt(sid,
          receipt?.attemptId || `supplement-${meetingId}-${added.seq}-${sid}`,prompt,update=>{
            try {
            if(receipt)orch.finishSupplementPrompt(receipt.attemptId,{ok:true,turnId:update.turnId});
            orch.markUserSupplementsDelivered(sid,[added.seq]);
            sendToRenderer('groupchat-user-supplement',{meetingId,seq:added.seq,revision:orch.state.revision});
            }catch(error){logger.warn('[groupchat-supplement] late receipt update failed:',error.message);}
          });
        if(messageReceipt)messageReceipts.set(sid,messageReceipt.receipt);
        // requireReady:false —— CLI 正在回答，本来就活着；再走一次冷启动轮询只会白等。
        const result = await groupChatWatcher.sendToPty(sid, prompt, kind, { requireReady: false,clientSubmissionId:receipt?.attemptId,
          ...(messageReceipt ? {submissionReceipt:messageReceipt.receipt} : {}) });
        const accepted=messageReceipt ? messageReceipt.receipt.started : !!result?.ok && result.sendStatus!=='stuck';
        if(result?.notSent)messageReceipt?.cleanup();
        if(receipt)orch.finishSupplementPrompt(receipt.attemptId,{...result,
          turnId:messageReceipt?.receipt.acknowledgement?.turnId || result?.turnId || result?.acknowledgementTurnId,ok:accepted});
        if (accepted) {
          orch.markUserSupplementsDelivered(sid, [added.seq]);
          // A durable native queue owns this text now, so the next workflow
          // prompt must not repeat it. Queued is not an engine acknowledgement.
          if (result.sendStatus === 'queued') queuedSids.push(sid);
          else deliveredNow.push(sid);
        } else {
          if(!result?.notSent)orch.markUserSupplementsUncertain?.(sid,[added.seq]);
          failures.push({ sid, reason: (result && result.reason) || 'send_failed', sendStatus: result && result.sendStatus });
        }
      } catch (error) {
        if(error?.notSent)messageReceipt?.cleanup();
        const confirmed=messageReceipt?.receipt.started===true;
        if(receipt)orch.finishSupplementPrompt(receipt.attemptId,{ok:confirmed,reason:error.message,
          turnId:messageReceipt?.receipt.acknowledgement?.turnId});
        if(!confirmed && !error?.notSent)orch.markUserSupplementsUncertain?.(sid,[added.seq]);
        failures.push({ sid, reason: (error && error.message) || 'send_exception' });
      }
    }

    // A first recipient's receipt can arrive while we submit to another one.
    for(const [sid,r] of messageReceipts)if(r.started){
      if(!deliveredNow.includes(sid))deliveredNow.push(sid);
      const i=failures.findIndex(f=>f.sid===sid);if(i>=0)failures.splice(i,1);
    }
    const delivery={deliveredNow,queuedSids,pendingSids:memberSids.filter(sid=>!deliveredNow.includes(sid)&&!queuedSids.includes(sid)&&!failures.some(f=>f.sid===sid)),uncertainSids:failures.map(f=>f.sid)};
    orch.recordUserSupplementDelivery?.(added.seq,delivery);
    try {
      sendToRenderer('groupchat-user-supplement', {
        meetingId, seq: added.seq, revision: orch.state.revision,
        deliveredNow, queuedSids, recipientSids:memberSids, toLabels, pendingCount: memberSids.length - deliveredNow.length - queuedSids.length,
      });
    } catch (error) { logger.warn('[groupchat-supplement] renderer notify failed:', error && error.message); }

    return {
      ok: true,
      seq: added.seq,
      recipientSids:memberSids,
      toLabels,
      deliveredNow,
      queuedSids,
      // 没即时送到的不是「失败」，是「等它下次运行时补」。前端要按这个说人话。
      ...delivery,
      failures,
    };
  });
}

module.exports = { registerGroupchatSupplementIpc, _test: { wrapImmediate, createSpecificPromptObserver } };
