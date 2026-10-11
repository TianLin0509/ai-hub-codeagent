'use strict';
const fs = require('fs');
const path = require('path');
const {UUID,receiptsFile} = require('./antigravity-config');
const hash=text=>require('crypto').createHash('sha256').update(text).digest('hex');
function parseAntigravityTranscriptToTurns(file, options = {}) {
  const match = /[\\/]brain[\\/]([^\\/]+)[\\/]/i.exec(file);
  if (!match || !UUID.test(match[1]) || (options.expectedSessionId && match[1] !== options.expectedSessionId))
    throw new Error('Antigravity 记录不属于当前会话');
  const candidates = [file, path.join(path.dirname(file), 'transcript_full.jsonl')];
  const chosen = candidates.filter(f => fs.existsSync(f)).sort((a,b) => fs.statSync(b).size - fs.statSync(a).size)[0];
  if (!chosen) return [];
  const lines = fs.readFileSync(chosen, 'utf8').replace(/^\uFEFF/, '').split('\n');
  const rows = new Map();
  for (let i=0; i<lines.length; i++) {
    if (!lines[i].trim()) continue;
    try { const row=JSON.parse(lines[i]); rows.set(row.step_index ?? i,row); }
    catch (error) { if (i !== lines.length-1) throw error; }
  }
  const turns=[];
  const receiptPath=options.receiptsFile||receiptsFile(match[1]);
  const receipts=fs.existsSync(receiptPath)?JSON.parse(fs.readFileSync(receiptPath,'utf8')):{};
  for (const [index,row] of rows) {
    const user=row.type==='USER_INPUT' || row.source==='USER_EXPLICIT';
    if (!user && row.source !== 'MODEL') continue;
    let text=typeof row.content==='string'?row.content:'';
    if(user) text=/<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/.exec(text)?.[1] ?? text;
    const id=`agy-${index}`, ts=Date.parse(row.created_at)||null;
    const receipt=receipts[id];
    const final=!user&&receipt?.textHash===hash(text)&&receipt.ts===ts?receipt:null;
    turns.push({id,role:user?'user':'assistant',kind:'gemini',source:'antigravity-cli',text,ts,
      thinking:typeof row.thinking==='string'?row.thinking:'',
      toolCalls:(row.tool_calls||[]).map((t,i)=>({id:`${id}-tool-${i}`,name:t.name,input:t.args,
        status:row.status==='ERROR'?'failed':row.status==='DONE'?'completed':'running',isError:row.status==='ERROR'})),
      // DONE marks a step, not a whole turn. Only the native Stop hook closes a turn.
      ...(user?{}:{nativeOutcome:final?.outcome||null,tsEnd:final?.completedAt||null,displayMessages:text?[{id:`${id}:text`,text,phase:final?.outcome==='completed'?'final_answer':'commentary',ts}]:[]})});
  }
  return Number.isFinite(options.limit)&&options.limit>=0
    ?options.limit===0?[]:options.fromTail===false?turns.slice(0,options.limit):turns.slice(-options.limit):turns;
}
module.exports={parseAntigravityTranscriptToTurns,hash};
