'use strict';
const fs = require('fs');
const path = require('path');
const {UUID,receiptsFile} = require('./antigravity-config');
const hash=text=>require('crypto').createHash('sha256').update(text).digest('hex');
function parseAntigravityTranscriptToTurns(file, options = {}) {
  const match = /[\\/]brain[\\/]([^\\/]+)[\\/]/i.exec(file);
  if (!match || !UUID.test(match[1]) || (options.expectedSessionId && match[1] !== options.expectedSessionId))
    throw new Error('Antigravity 记录不属于当前会话');
  const candidates = ['transcript.jsonl','transcript_full.jsonl'].map(name=>path.join(path.dirname(file),name))
    .filter(candidate=>fs.existsSync(candidate)).sort((a,b)=>fs.statSync(a).mtimeMs-fs.statSync(b).mtimeMs
      // Windows can stamp adjacent writes identically. The live snapshot is
      // authoritative on a tie; its truncated fields still borrow full text.
      || (path.basename(a)==='transcript_full.jsonl' ? -1 : 1));
  const rows = new Map();
  for (const candidate of candidates) {
    const lines = fs.readFileSync(candidate, 'utf8').replace(/^\uFEFF/, '').split('\n');
    for (let i=0; i<lines.length; i++) {
      if (!lines[i].trim()) continue;
      try {
        const row=JSON.parse(lines[i]), key=row.step_index ?? i, old=rows.get(key);
        // created_at stays constant while a step streams. Snapshot mtime owns
        // freshness; only explicitly truncated fields may use the full copy.
        if (old && (!old.created_at || old.created_at===row.created_at) && old.status===row.status) {
          for(const field of Array.isArray(row.truncated_fields)?row.truncated_fields:[]) {
            if(old[field]!=null && !old.truncated_fields?.includes(field)) row[field]=old[field];
          }
        }
        rows.set(key,row);
      } catch (error) { if (i !== lines.length-1) throw error; }
    }
  }
  const turns=[];let replyKey=null;
  const receiptPath=options.receiptsFile||receiptsFile(match[1]);
  let receipts={};
  try { receipts=JSON.parse(fs.readFileSync(receiptPath,'utf8'))||{}; } catch { /* Optional completion evidence must not hide history. */ }
  for (const [index,row] of [...rows].sort((a,b)=>Number(a[0])-Number(b[0]))) {
    const user=row.type==='USER_INPUT' || row.source==='USER_EXPLICIT';
    if (!user && row.source !== 'MODEL') continue;
    let text=typeof row.content==='string'?row.content:'';
    if(user) text=/<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/.exec(text)?.[1] ?? text;
    const id=`agy-${index}`, ts=Date.parse(row.created_at)||null;
    if(user) replyKey=id;
    // GENERIC/MODEL is a tool result, not words spoken to the user.
    if (!user && row.type !== 'PLANNER_RESPONSE') {
      turns.push({id,role:'assistant',kind:'gemini',source:'antigravity-cli',replyKey,ts,text:'',thinking:'',
        toolCalls:text?[{id:`${id}-result`,name:row.type==='GENERIC'?'执行结果':row.type||'原生活动',output:text,
          status:row.status==='ERROR'?'failed':row.status==='DONE'?'completed':'running',isError:row.status==='ERROR'}]:[],displayMessages:[]});
      continue;
    }
    const receipt=receipts[id];
    const final=!user&&receipt?.textHash===hash(text)&&receipt.ts===ts?receipt:null;
    turns.push({id,role:user?'user':'assistant',kind:'gemini',source:'antigravity-cli',text,ts,
      thinking:typeof row.thinking==='string'?row.thinking:'',
      toolCalls:(row.tool_calls||[]).map((t,i)=>({id:`${id}-tool-${i}`,name:t.name,input:t.args,
        status:row.status==='ERROR'?'failed':row.status==='DONE'?'completed':'running',isError:row.status==='ERROR'})),
      // DONE marks a step, not a whole turn. Only the native Stop hook closes a turn.
      ...(user?{}:{replyKey,nativeOutcome:final?.outcome||null,tsEnd:final?.completedAt||null,displayMessages:[
        ...(typeof row.thinking==='string' && row.thinking.trim() ? [{id:`${id}:thinking`,text:row.thinking,phase:'commentary',fromThinking:true,ts}] : []),
        ...(text?[{id:`${id}:text`,text,phase:final?.outcome==='completed'?'final_answer':'commentary',ts}]:[])]})});
  }
  const result=options.rawSteps ? turns : groupSteps(turns);
  return Number.isFinite(options.limit)&&options.limit>=0
    ?options.limit===0?[]:options.fromTail===false?result.slice(0,options.limit):result.slice(-options.limit):result;
}
// Pagination counts user/answer cards, never internal model/tool steps. Keep
// the first step as the anchor while the response grows or history expands.
function groupSteps(turns) {
  const result=[];
  for(let start=0;start<turns.length;) {
    const first=turns[start];
    if(first.role==='user'){result.push(first);start++;continue;}
    let end=start+1;
    while(end<turns.length && turns[end].role==='assistant' && turns[end].replyKey===first.replyKey)end++;
    const steps=turns.slice(start,end), answer=steps.findLast(t=>t.text), last=steps.at(-1);
    result.push({...first,text:answer?.text||'',
      nativeOutcome:answer?.nativeOutcome||null,tsEnd:answer?.tsEnd||last.ts,
      thinking:steps.map(t=>t.thinking).filter(Boolean).join('\n\n'),
      toolCalls:steps.flatMap(t=>t.toolCalls||[]),
      displayMessages:steps.flatMap(t=>(t.displayMessages||[]).map(m=>({...m,
        phase:t===answer?m.phase:'commentary'})))});
    start=end;
  }
  return result;
}
module.exports={parseAntigravityTranscriptToTurns,hash};
