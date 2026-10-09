'use strict';
const fs=require('node:fs');
const textOf=value=>typeof value==='string'?value:Array.isArray(value)?value.map(p=>typeof p?.text==='string'?p.text:'').join(''):'';
const at=value=>typeof value==='number'?value:Date.parse(value)||null;

// Gemini 0.38 stored one JSON document; 0.39+ appends native message rows.
// This is a display projection only. It never supplies runtime completion.
function parseGeminiTranscriptToTurns(file,options={}){
  const raw=fs.readFileSync(file,'utf8').replace(/^\uFEFF/,'');let metadata,rows;
  if(file.endsWith('.jsonl')){
    const lines=raw.split('\n');rows=[];
    for(let i=0;i<lines.length;i++){
      if(!lines[i].trim())continue;
      try{rows.push(JSON.parse(lines[i]));}
      catch(error){if(i!==lines.length-1)throw error;}
    }
    metadata=rows[0];
  }else{metadata=JSON.parse(raw);rows=metadata.messages||[];}
  if(options.expectedSessionId&&metadata.sessionId!==options.expectedSessionId
    &&!(options.expectedSessionId.length===8&&metadata.sessionId?.startsWith(options.expectedSessionId)))
    throw new Error('Gemini 记录不属于当前会话');
  const messages=new Map();
  for(const [index,row]of rows.entries())if(['user','gemini'].includes(row.type))
    messages.set(row.id||`row-${index}`,row);
  const turns=[];
  for(const [id,row]of messages){
    const text=textOf(row.content),user=row.type==='user';
    const tools=(row.toolCalls||[]).map(t=>({id:t.id,callId:t.id,name:t.displayName||t.name,input:t.args,
      output:t.resultDisplay||t.result,status:({success:'completed',error:'failed',cancelled:'interrupted',executing:'running',scheduled:'running'})[t.status]||'unknown',
      isError:t.status==='error',startedAt:at(t.timestamp)}));
    const completed=!user&&row.tokens?.total!=null&&!tools.some(t=>t.status==='running');
    turns.push({id,role:user?'user':'assistant',kind:'gemini',source:'gemini-cli',text,ts:at(row.timestamp),
      model:row.model,thinking:(row.thoughts||[]).map(t=>typeof t==='string'?t:t.text||t.subject||'').filter(Boolean).join('\n'),
      toolCalls:tools,usage:row.tokens,
      ...(user?{}:{nativeOutcome:completed?'completed':null,
        displayMessages:text?[{id:id+':text',text,phase:completed?'final_answer':'commentary',ts:at(row.timestamp)}]:[]})});
  }
  return Number.isFinite(options.limit)&&options.limit>=0
    ?options.limit===0?[]:options.fromTail===false?turns.slice(0,options.limit):turns.slice(-options.limit):turns;
}
module.exports={parseGeminiTranscriptToTurns};
