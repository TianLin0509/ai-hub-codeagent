'use strict';
const fs=require('node:fs');
const readline=require('node:readline');
const {preview}=require('./acp-tool-preview');
const cached=new WeakMap();
function compactClaudeTools(cards,{hubSessionId,threadId}) {
  return cards.map(card=>!card.toolCalls?.length?card:{...card,toolCalls:card.toolCalls.map(tool=>{
    const key=tool.input && typeof tool.input==='object'?tool.input:null;
    let compact=key && cached.get(key);
    if(!compact || compact.fullOutput!==tool.output) {
      const input={};
      for(const name of ['command','file_path','path','pattern','query','url','target_path','destination','new_path','description']) {
        if(typeof tool.input?.[name]==='string')input[name]=tool.input[name].slice(0,512);
      }
      compact={input,output:tool.output==null?'':preview(tool.output).text,fullOutput:tool.output};
      if(key)cached.set(key,compact);
    }
    return {...tool,input:compact.input,output:compact.output,resultTruncated:tool.output!=null,
      resultRef:{source:'claude-stream-json',hubSessionId,threadId,userMessageId:card.userMessageId,itemId:tool.id}};
  })});
}
const asText=value=>typeof value==='string'?value:JSON.stringify(value ?? '',null,2);

// A restored frame carries only a preview-sized head of its tool output (see
// core/native-transcript-trim.js); the provider transcript still holds all of
// it. Streaming and line-filtering keeps this off the main thread's critical
// path — a synchronous read of a multi-megabyte transcript would stall the
// window on a click. A live session never reaches here: its in-memory frames
// are untrimmed.
async function readTrimmedFromTranscript(session,toolUseId) {
  const file=typeof session.historyPath==='function'?session.historyPath():null;
  return readToolResultFromTranscriptFile(file,toolUseId);
}

async function readToolResultFromTranscriptFile(file,toolUseId) {
  if(!file || !toolUseId)return null;
  let stream;
  try { stream=fs.createReadStream(file,{encoding:'utf8'}); }
  catch { return null; }
  const lines=readline.createInterface({input:stream,crlfDelay:Infinity});
  try {
    for await (const line of lines) {
      // Parsing every frame of a large transcript is the cost this avoids.
      if(!line.includes(toolUseId))continue;
      let frame;
      try { frame=JSON.parse(line); } catch { continue; }
      const block=(frame?.message?.content || []).find(b=>b && b.type==='tool_result' && b.tool_use_id===toolUseId);
      if(block)return asText(block.content);
    }
    return null;
  }
  catch { return null; }
  finally { lines.close(); stream.destroy(); }
}

async function readClaudeToolResult(session,reference) {
  if(reference.threadId!==session.sessionId)throw Error('工具详情不属于当前 Claude 会话');
  const record=[...session.records.values(),...session.activities.records.values()].find(record=>record.userMessageId===reference.userMessageId);
  for(const frame of record?.messages?.values() || []) {
    const result=frame.message?.content?.find(block=>block.type==='tool_result' && block.tool_use_id===reference.itemId);
    if(!result)continue;
    if(!result.hubTrimmed)return asText(result.content);
    const full=await readTrimmedFromTranscript(session,reference.itemId);
    if(full!=null)return full;
    // The head Hub kept is still worth showing, but never as if it were whole.
    return `［Claude 原生记录中已找不到这段工具输出的全文（原长 ${result.hubTrimmed.bytes} 字），`
      + `以下是 Hub 保留的开头 ${result.hubTrimmed.kept} 字］\n\n`+asText(result.content);
  }
  throw Error('未找到完整 Claude 工具来源，请重新载入会话');
}
module.exports={compactClaudeTools,readClaudeToolResult,readToolResultFromTranscriptFile};
