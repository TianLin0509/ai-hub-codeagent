'use strict';
const {displayUserText,hubAttachedFields}=require('./synthetic-user-filter');
const {TERMINAL,BACKEND}=require('./codex-native-runtime');
// Live native turns stamp each tool item as it starts and completes. The
// model was working for the rest of the turn. An ACP tool can be announced
// while the model still streams its arguments; it runs from in_progress.
const MODEL_ITEMS=new Set(['userMessage','agentMessage','reasoning','acpPlan','plan']);
function nativeGeneration(turn,items,ts,tsEnd) {
  if(turn.hubGeneration)return turn.hubGeneration;
  const output=turn.hubUsage?.output_tokens;
  if(!TERMINAL.has(turn.status) || !Number.isFinite(ts) || !Number.isFinite(tsEnd) || !Number.isSafeInteger(output))return null;
  const tools=items.filter(i=>!MODEL_ITEMS.has(i.type)).map(i=>[i.hubRunningAt ?? i.hubStartedAt,i.hubCompletedAt ?? tsEnd]);
  if(tools.some(([start])=>!Number.isFinite(start)))return null;
  return {outputTokens:output,activeMs:tsEnd-ts-require('./turn-speed-metrics').coveredMs(tools,ts,tsEnd),
    calls:null,method:'minus-tools'};
}

// Content presentation never changes execution state. IDs come from the same
// native thread/turn/items used for live delivery and survive renderer reload.
function nativeTranscriptTurns(threadId, turns) {
  const cards=[];
  for(const turn of turns) {
    const ts=turn.startedAt ? turn.startedAt*1000 : turn.hubStartedAt || null;
    const tsEnd=turn.completedAt ? turn.completedAt*1000 : turn.hubCompletedAt || ts;
    const items=turn.items || [];
    for(const [itemOrder,item] of items.entries()) {
      if(item.type!=='userMessage')continue;
      const attachments=(item.content || []).filter(i=>['image','localImage'].includes(i.type))
        .map(i=>({type:'image',path:i.path || null,url:i.url || null}));
      const raw=(item.content || []).filter(i=>i.type==='text').map(i=>i.text).join('\n');
      const text=displayUserText(raw) || (!raw.trim() && attachments.length ? '[图片]' : '');
      if(text)cards.push({id:threadId+':'+item.id,role:'user',text,ts,source:BACKEND,clientSubmissionId:item.clientId,
        displayTurnKey:threadId+':'+turn.id,itemOrder,attachments,...hubAttachedFields(raw)});
    }
    const messages=items.filter(i=>i.type==='agentMessage');
    let clientSubmissionId=null;
    const ownerByItem=new Map();
    const orderByItem=new Map();
    const displayMessages=[];
    items.forEach((i,itemOrder)=>{
      if(i.type==='userMessage')clientSubmissionId=i.clientId || null;
      ownerByItem.set(i.id,clientSubmissionId);
      orderByItem.set(i.id,itemOrder);
      if(i.type==='reasoning') {
        const text=[...(i.summary || []),...(i.content || [])].map(x=>typeof x==='string'?x:x.text || '').filter(Boolean).join('\n\n');
        if(text)displayMessages.push({id:threadId+':'+turn.id+':'+i.id,
          itemId:i.id,providerTurnId:turn.id,clientSubmissionId,itemOrder,
          phase:'commentary',fromThinking:true,text,ts:i.hubStartedAt || ts});
      }
      if(i.type==='agentMessage')displayMessages.push({id:threadId+':'+turn.id+':'+i.id,
        itemId:i.id,providerTurnId:turn.id,clientSubmissionId,itemOrder,
        phase:i.phase || 'message',text:i.text || '',
        ts:i.hubStartedAt || ts,tsEnd:i.hubCompletedAt || tsEnd});
    });
    const finals=messages.filter(i=>i.phase==='final_answer' || !i.phase);
    const text=(TERMINAL.has(turn.status) && finals.length ? finals : messages).map(i=>i.text || '').join('\n\n');
    const tools=items.filter(i=>!['userMessage','agentMessage','reasoning'].includes(i.type)).map(i=>({
      id:i.id,callId:i.id,name:i.type,itemOrder:orderByItem.get(i.id),input:i,output:i.aggregatedOutput ?? i.result ?? i.error ?? null,
      exitCode:i.exitCode ?? null,durationMs:i.durationMs ?? null,isError:i.isError === true || !!i.error,
      clientSubmissionId:ownerByItem.get(i.id),
      status:(!i.status || i.status==='inProgress') ? (TERMINAL.has(turn.status)?'unknown':'running') : i.status,
      startedAt:ts,...(i.status==='completed'?{completedAt:tsEnd}:{}),
    }));
    const thinking=displayMessages.filter(m=>m.fromThinking).map(m=>m.text).join('\n');
    if(text || tools.length || thinking || TERMINAL.has(turn.status))cards.push({id:threadId+':'+turn.id+':assistant',
      role:'assistant',kind:'codex',text,ts,tsEnd,thinking,toolCalls:tools,source:BACKEND,displayMessages,
      stopReason:turn.status,nativeOutcome:TERMINAL.has(turn.status)?turn.status:null,
      displayTurnKey:threadId+':'+turn.id,
      providerTurnId:turn.id,
      ...(turn.hubUsage ? { usage: turn.hubUsage } : {}),
      generation:nativeGeneration(turn,items,ts,tsEnd),
      speedTier: turn.hubSpeedTier,
      durationMs:ts && tsEnd ? tsEnd-ts : undefined});
  }
  return cards.map(require('./turn-speed-metrics').withTurnSpeed);
}
module.exports={nativeTranscriptTurns};
