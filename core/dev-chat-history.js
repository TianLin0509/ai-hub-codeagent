'use strict';

// File-flow chat history is informational. Its source identity survives dispatch
// handoffs; it never sends prompts or decides whether a task document is PASS.
const crypto = require('node:crypto');
const fs = require('node:fs');
const { JsonlTail } = require('./jsonl-tail');
const { promptFingerprint, normalizeProviderFamily } = require('./groupchat-attempt-protocol');
const { codexUserMessageEventFromRecord, codexAgentMessageEventFromRecord } = require('./transcript-payload-utils');
const hash = value => crypto.createHash('sha256').update(String(value)).digest('hex');
async function requireSourceFile(sourcePath) {
  const stat=await fs.promises.stat(sourcePath);
  if(!stat.isFile())throw Object.assign(new Error('Message source is not a file'),{code:'NOT_A_FILE'});
}
const textBlocks = content => typeof content === 'string' ? content
  : Array.isArray(content) ? content.filter(b => b && ['text','input_text','output_text'].includes(b.type) && typeof b.text === 'string').map(b => b.text).join('\n') : '';
function ledger(orch) {
  return orch.state.devChatHistory || (orch.state.devChatHistory = { receipts: {}, errors: {} });
}
function rememberPrompt(orch, sid, pending) {
  const attempt = pending && orch.state.attempts[pending.attemptId];
  if (!attempt) return null;
  const receipts = ledger(orch).receipts;
  if (!receipts[attempt.attemptId]) receipts[attempt.attemptId] = {
    attemptId: attempt.attemptId, sid, turnNum: attempt.turnNum, runId: attempt.runId,
    memberId: attempt.memberId, kind: attempt.kind, dispatchAt: attempt.dispatchAt,
    promptHash: pending.promptHash || promptFingerprint(pending.prompt),
  };
  orch._saveState('dev_chat_prompt_remembered', { attemptId: attempt.attemptId });
  return receipts[attempt.attemptId];
}
function hydrateReceipts(orch, sid) {
  const receipts = ledger(orch).receipts;
  for (const [n, bySid] of Object.entries(orch.state.pendingPrompts || {})) {
    if (bySid[sid]) rememberPrompt(orch, sid, bySid[sid]);
  }
  // Older empty answers still carry the exact dispatched sourcePrompt.
  for (const m of orch.state.messages) {
    if (m.sid !== sid || !m.sourcePrompt || !m.attemptId || receipts[m.attemptId]) continue;
    const a = orch.state.attempts[m.attemptId] || {};
    receipts[m.attemptId] = { attemptId:m.attemptId, sid, turnNum:m.turnNum, runId:m.runId,
      memberId:m.memberId, kind:a.kind, dispatchAt:a.dispatchAt || 0, promptHash:promptFingerprint(m.sourcePrompt) };
  }
}
function createHistoryReader({ orch, sid, kind, sourcePath, speaker = 'Agent', onChanged = () => {} }) {
  hydrateReceipts(orch,sid);
  const family = normalizeProviderFamily(kind), ancestors = new Map(), turns = new Map();
  const deferred = new Map();
  let currentTurn = null, current = null;
  const error = reason => {
    const state=ledger(orch);
    if (state.errors[sid] !== reason) { state.errors[sid]=reason; orch._saveState('dev_chat_history_warning',{sid,reason});
      if(orch.state.currentTurn)orch.appendSystemNote(orch.state.currentTurn,reason,{kind:'warning'}); onChanged(); }
  };
  function bind(text, key, turnId, at) {
    const receipts=Object.values(ledger(orch).receipts).filter(r=>r.sid===sid);
    let found=receipts.find(r=>r.sourcePath===sourcePath && r.sourceUserKey===key);
    if (!found) {
      const eligible=receipts.filter(r=>(!r.sourceUserKey || (turnId && r.sourcePath===sourcePath && r.sourceTurnId===turnId))
        && (!turnId || !orch.state.attempts[r.attemptId]?.providerTurnId || orch.state.attempts[r.attemptId].providerTurnId===turnId)
        && (!at || !r.dispatchAt || r.dispatchAt <= at+1000));
      // A steer adds another user message to the same provider turn. Exact
      // submitted text identifies that supplement; turn ID alone also matches
      // the original request and must only be a fallback.
      const exact=eligible.filter(r=>r.promptHash===promptFingerprint(text));
      const candidates=exact.length?exact:eligible.filter(r=>turnId && orch.state.attempts[r.attemptId]?.providerTurnId===turnId);
      if(candidates.length!==1) { if(candidates.length>1)error('无法确定这条发言对应的任务轮次，未将其填入当前轮。'); return null; }
      found=candidates[0]; found.sourcePath=sourcePath; found.sourceUserKey=key; found.sourceTurnId=turnId || key;
      found.sourcePromptMatched=found.promptHash===promptFingerprint(text);
      orch._saveState('dev_chat_source_bound',{sid,attemptId:found.attemptId});
    }
    if(turnId) turns.set(turnId,found);
    return found;
  }
  function save(receipt, text, key, at, phase, done=false) {
    if(!receipt) return;
    if(receipt.unresolved) {
      const found=bind(receipt.text,receipt.key,receipt.turnId,receipt.at);
      if(!found) { deferred.set(key,{receipt,text,key,at,phase,done}); return; }
      receipt=found;
    }
    const body=String(text || '').trim();
    const identity=hash(`${sourcePath}\n${receipt.attemptId}\n${key}`);
    let changed=false;
    if(body) {
      let m=orch.state.messages.find(m=>m.sourceMessage===identity);
      if(!m) {
        m=orch._appendMessage({id:`dh-${identity}`,sourceMessage:identity,
          sourcePath,sourceKey:key,phase,role:'assistant',status:'progress_update',
          sid,speaker,turnNum:receipt.turnNum,runId:receipt.runId,attemptId:receipt.attemptId,
          memberId:receipt.memberId,providerTurnId:receipt.sourceTurnId,content:body,createdAt:at || Date.now()});
        changed=true;
      } else if(m.content!==body && body.startsWith(m.content)) {
        m.content=body; m.phase=phase; changed=true;
      } else if(m.content!==body && !m.content.startsWith(body)) {
        // A provider may revise a message instead of streaming a prefix. Keep
        // both source revisions instead of silently replacing earlier text.
        return save(receipt,body,`${key}:revision:${hash(body)}`,at,phase,done);
      }
      if(done && m.phase!==phase) { m.phase=phase; changed=true; }
    }
    if(done && !receipt.sourceCompletedAt) { receipt.sourceCompletedAt=at || Date.now(); changed=true; }
    if(done && body) receipt.finalText=body;
    const attempt=orch.state.attempts[receipt.attemptId];
    if(done && attempt) attempt.sourceCompletedAt=receipt.sourceCompletedAt;
    const canonical=orch.state.messages.find(m=>m.role==='assistant' && !m.supplementReply && m.status!=='progress_update'
      && m.sid===sid && m.turnNum===receipt.turnNum);
    if(done && body && ['handed_off','superseded'].includes(attempt?.status)
      && (!canonical || canonical.attemptId===receipt.attemptId)) {
      orch.patchTurnResult(receipt.turnNum,sid,{text:body,status:phase==='error'?'errored':'completed',attemptId:receipt.attemptId,
        runId:receipt.runId,memberId:receipt.memberId,speaker,providerTurnId:receipt.sourceTurnId,
        signalSource:'dev_chat_source_final',finality:'provider_final'});
      changed=true;
    }
    if(changed) { orch._saveState('dev_chat_message_saved',{sid,turnNum:receipt.turnNum,attemptId:receipt.attemptId}); onChanged(); }
  }
  function record(obj, meta = {}) {
    const at=Date.parse(obj.timestamp) || 0;
    const rawKey=obj.uuid || obj.payload?.item?.id || obj.payload?.id || `byte:${meta.startOffset ?? hash(JSON.stringify(obj))}`;
    if(family==='claude') {
      const parent=obj.parentUuid ? ancestors.get(obj.parentUuid) : current;
      if(obj.type==='user') {
        const text=textBlocks(obj.message?.content);
        const tool=Array.isArray(obj.message?.content) && obj.message.content.some(b=>b.type==='tool_result');
        if(tool) { if(obj.uuid)ancestors.set(obj.uuid,parent || null); return; }
        current=text ? bind(text,rawKey,obj.uuid,at) || {unresolved:true,text,key:rawKey,turnId:obj.uuid,at} : null;
        if(obj.uuid)ancestors.set(obj.uuid,current); return;
      }
      if(obj.uuid)ancestors.set(obj.uuid,parent || null);
      if(obj.type!=='assistant' || obj.isSidechain || obj.isMeta) return;
      const body=textBlocks(obj.message?.content);
      // Claude emits multiple records for text and tool blocks of one API
      // message. UUID identifies the record; API id alone would merge them.
      // A thinking-only end_turn can precede the actual reply. Require text,
      // matching the existing Claude tap's terminal guard.
      const failed=obj.isApiErrorMessage===true;
      const done=!!body && (failed || ['end_turn','max_tokens','refusal'].includes(obj.message?.stop_reason));
      save(parent,body,rawKey,at,failed?'error':done?'final':'commentary',done);
      return;
    }
    if(family!=='codex')return;
    const p=obj.payload || {};
    const tid=p.turn_id || p.turnId || p.item?.turn_id || null;
    if(obj.type==='event_msg' && p.type==='task_started') { currentTurn=tid; current=turns.get(tid) || null; return; }
    const user=codexUserMessageEventFromRecord(obj);
    if(user) { const turnId=user.turnId || currentTurn;
      current=bind(user.text,rawKey,turnId,at) || {unresolved:true,text:user.text,key:rawKey,turnId,at};
      if(turnId)turns.set(turnId,current); return; }
    const message=codexAgentMessageEventFromRecord(obj);
    if(message) {
      const receipt=tid ? turns.get(tid) : current;
      const final=message.completed || p.phase==='final_answer' || p.phase==='final';
      // task_complete repeats the last agent message; keep the actual message
      // card and use this event only as an end receipt when text already exists.
      const previous=p.type==='task_complete' && receipt && !receipt.unresolved
        && orch.state.messages.filter(m=>m.sourceMessage && m.sourcePath===sourcePath && m.sid===sid
          && (m.attemptId===receipt.attemptId || (tid && m.providerTurnId===tid)))
          .reduce((last,m)=>!last || m.createdAt>=last.createdAt ? m : last,null);
      const mirror=previous && previous.content===message.text ? previous : null;
      // A steer can move the final to a supplement attempt while a replayed
      // end receipt is still bound to the original request in the same turn.
      // task_complete repeats that final; reuse its actual source identity.
      const owner=mirror ? ledger(orch).receipts[mirror.attemptId] || receipt : receipt;
      save(owner,message.text,mirror?mirror.sourceKey:rawKey,at,final?'final':'commentary',final);
      if(p.type==='task_complete' && tid){
        let changed=false;
        // One native turn can contain the workflow request and several steers.
        // Reusing its last message must not lose the original dispatch's end
        // receipt, which gates later reuse of that CLI after file handoff.
        for(const r of Object.values(ledger(orch).receipts)){
          if(r.sid!==sid || r.sourcePath!==sourcePath || r.sourceTurnId!==tid || r.sourceCompletedAt)continue;
          r.sourceCompletedAt=at || Date.now();
          const attempt=orch.state.attempts[r.attemptId];if(attempt)attempt.sourceCompletedAt=r.sourceCompletedAt;
          changed=true;
        }
        if(changed){orch._saveState('dev_chat_turn_completed',{sid,turnId:tid});onChanged();}
      }
    } else if(obj.type==='event_msg' && ['turn_aborted','task_complete'].includes(p.type)) {
      const failure=p.type==='turn_aborted' ? '本轮 CLI 已中断，已收录的消息仍保留。' : textBlocks(p.error?.message || p.error?.text);
      save(tid?turns.get(tid):current,failure,rawKey,at,failure?'error':'terminal',true);
    }
  }
  function refresh() {
    const pending=[...deferred.values()];deferred.clear();
    for(const item of pending)save(item.receipt,item.text,item.key,item.at,item.phase,item.done);
  }
  return {record,error,refresh};
}

function createHistoryService({ getOrchestrator, onChanged = () => {}, logger = console }) {
  const readers=new Map();
  async function watch({sid,meetingId,kind,sourcePath,speaker}) {
    if(!sourcePath || !['claude','codex'].includes(normalizeProviderFamily(kind)))return;
    const key=`${meetingId}:${sid}:${sourcePath}`;
    if(readers.has(key)) {
      const existing=readers.get(key);
      if(!existing.failed) {
        try { existing.reader.refresh(); return existing.ready; }
        catch(error) {
          existing.failed=true;
          logger.error('[dev-chat-history] deferred source write failed:',error);
          existing.reader.error('已绑定消息的保存失败，正在从原始记录补收；未重新发送任务。');
          throw error;
        }
      }
      existing.tail.close();readers.delete(key); // replay source after a failed durable write
    }
    const orch=getOrchestrator(meetingId);
    const reader=createHistoryReader({orch,sid,kind,sourcePath,speaker,onChanged:()=>onChanged(meetingId,orch)});
    const entry={tail:null,reader,ready:null,failed:false};
    const fail=error=>{
      entry.failed=true;logger.error('[dev-chat-history] source record failed:',error);
      reader.error(`消息收录失败（${error.code || 'WRITE_ERROR'}），正在从原始记录补收；未重新发送任务。`);
    };
    const tail=new JsonlTail(sourcePath,(obj,_line,meta)=>{
      try { reader.record(obj,meta); }
      catch(error) { fail(error); }
    },{onError:fail});
    entry.tail=tail;readers.set(key,entry);
    entry.ready=(async()=>{
      try {
        await requireSourceFile(sourcePath); await tail.start();
        // A previous write may have left the message only in memory. Even an
        // identity-deduplicated replay must durably flush it before succeeding.
        if(!entry.failed)orch._saveState('dev_chat_history_replayed',{sid});
      }
      catch(error) { fail(error); throw error; }
    })();
    await entry.ready;
  }
  function dispose() { for(const r of readers.values())r.tail.close(); readers.clear(); }
  return {watch,dispose};
}
async function recollectHistory(options) {
  await requireSourceFile(options.sourcePath);
  const reader=createHistoryReader(options);let failure=null;
  const tail=new JsonlTail(options.sourcePath,(obj,_line,meta)=>{
    try {reader.record(obj,meta);} catch(error){failure=error;}
  },{onError:error=>{failure=error;}});
  try {await tail.start(); if(failure)throw failure; options.orch._saveState('dev_chat_history_replayed',{sid:options.sid});}
  finally {tail.close();}
}
module.exports={rememberPrompt,createHistoryReader,createHistoryService,recollectHistory};
