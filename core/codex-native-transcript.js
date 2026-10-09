'use strict';
const {displayUserText}=require('./synthetic-user-filter');
const {TERMINAL,BACKEND}=require('./codex-native-runtime');
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
        displayTurnKey:threadId+':'+turn.id,itemOrder,attachments});
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
    const thinking=items.filter(i=>i.type==='reasoning').flatMap(i=>i.summary || []).map(x=>typeof x==='string'?x:x.text || '').join('\n');
    if(text || tools.length || thinking || TERMINAL.has(turn.status))cards.push({id:threadId+':'+turn.id+':assistant',
      role:'assistant',kind:'codex',text,ts,tsEnd,thinking,toolCalls:tools,source:BACKEND,displayMessages,
      stopReason:turn.status,nativeOutcome:TERMINAL.has(turn.status)?turn.status:null,
      displayTurnKey:threadId+':'+turn.id,
      providerTurnId:turn.id,
      ...(turn.hubUsage ? { usage: turn.hubUsage } : {}),
      speedTier: turn.hubSpeedTier,
      durationMs:ts && tsEnd ? tsEnd-ts : undefined});
  }
  return cards.map(require('./turn-speed-metrics').withTurnSpeed);
}
module.exports={nativeTranscriptTurns};
