'use strict';
// Only bound native files are evidence. Final text remains an agent's report,
// never independent acceptance of the underlying work.
const fs=require('node:fs'),{createHash}=require('node:crypto');
const {JsonlByteScanner}=require('../jsonl-byte-scanner');
const {codexLineFilter,inspectCodexEnvelope}=require('../codex-rollout-reader');
const {isUsableCodexRolloutPath}=require('../codex-transcript-parser');
const {codexAgentMessageEventFromRecord}=require('../transcript-payload-utils');
const aiKinds=require('../ai-kinds'),acpProfiles=require('../acp-profiles');
const hash=value=>createHash('sha256').update(value).digest('hex');
function nativeId(meta){
  const kind=String(meta?.kind||'').replace(/-resume$/,'');
  if(aiKinds.isCodexCliKind(kind))return meta.codexSid||meta.ccSessionId||null;
  if(aiKinds.isClaudeFamily(kind))return meta.ccSessionId||null;
  if(kind==='gemini')return meta.geminiChatId||null;
  if(kind==='kimi')return meta.kimiSid||null;
  if(acpProfiles.isAcpKind(kind))return meta.acpSid||null;
  return null;
}
function finalLineFilter(prefix,context){const e=inspectCodexEnvelope(prefix);if(e.recordType==='response_item'){if(!e.payloadType)return context.final?false:null;if(e.payloadType!=='message')return false;if(!e.role)return context.final?false:null;return e.role==='assistant';}return codexLineFilter(prefix,context,'turns');}
function claudeHeaderMatches(file,identity){const fd=fs.openSync(file,'r');try{const buffer=Buffer.alloc(1024*1024),n=fs.readSync(fd,buffer,0,buffer.length,0);for(const line of buffer.subarray(0,n).toString('utf8').split('\n')){try{const row=JSON.parse(line);if(row.sessionId)return row.sessionId===identity;}catch{}}return false;}finally{fs.closeSync(fd);}}
function readFinals(meta,{cursor=null,tailBytes=1024*1024,maxReadBytes=8*1024*1024,startOffset}={}){
  const identity=nativeId(meta),file=meta?.transcriptPath;
  const empty={available:false,records:[],identity,cursor};
  if(!['codex','claude'].includes(meta?.kind))return{...empty,issue:'该提供方的即时原文读取尚未接入；历史索引仍可用'};
  if(!identity||!file||!fs.existsSync(file))return{...empty,issue:'原生会话身份或绑定记录尚未就绪'};
  if(meta.kind==='codex'&&!isUsableCodexRolloutPath(file,identity))return{...empty,issue:'记录身份与目标会话不一致'};
  if(meta.kind==='claude'&&!claudeHeaderMatches(file,identity))return{...empty,issue:'Claude 记录头身份与目标会话不一致'};
  const stat=fs.statSync(file);
  if(cursor&&(cursor.identity!==identity||cursor.path!==file||cursor.offset>stat.size))return{...empty,issue:'绑定或文件发生变化，关注游标需核对'};
  const start=cursor?.offset??startOffset??Math.max(0,stat.size-tailBytes),end=Math.min(stat.size,start+maxReadBytes);
  let turnId=cursor?.turnId||null,clientSubmissionId=cursor?.clientSubmissionId||null,claudeIdentitySeen=false,lastFilter=null;const finals=[];
  const scanner=new JsonlByteScanner(row=>{
    const p=row.payload||{};
    if(meta.kind==='codex'){
      if(row.type==='event_msg'&&p.type==='task_started')turnId=p.turn_id||p.turnId||turnId;
      const event=codexAgentMessageEventFromRecord(row);
      // task_complete alone is a lifecycle signal, not the message source.
      if(event?.completed&&p.type==='item_completed'){
        const id=event.turnId||turnId, messageId=p.item?.id||null;
        finals.push({turnId:id,messageId:messageId||id||hash(JSON.stringify([row.timestamp,event.text])),text:event.text,timestamp:event.completedAt,recordType:'item_completed_final_answer'});
      }else if(row.type==='response_item'&&p.type==='message'&&p.role==='assistant'&&(p.channel==='final'||p.phase==='final_answer')){
        const text=(p.content||[]).filter(c=>typeof c.text==='string').map(c=>c.text).join('\n').trim();
        if(text)finals.push({turnId:p.turn_id||turnId,messageId:p.id||p.turn_id||turnId||hash(JSON.stringify([row.timestamp,text])),text,timestamp:Date.parse(row.timestamp)||null,recordType:'response_item_final'});
      }
    }else{
      if(row.sessionId===identity)claudeIdentitySeen=true;
      if(row.sessionId===identity&&row.type==='user'&&!row.isSidechain){
        const body=row.message?.content;
        const blocks=Array.isArray(body)?body:[];
        if(typeof body==='string'||blocks.some(c=>c.type==='text')&&!blocks.some(c=>c.type==='tool_result')){
          const text=typeof body==='string'?body:blocks.filter(c=>c.type==='text').map(c=>c.text||'').join('\n');
          clientSubmissionId=require('../assistant-context-display').assistantContextDisplay(text,'hub-assistant')?.clientSubmissionId||null;
        }
      }
      if(row.sessionId!==identity||row.type!=='assistant'||row.isSidechain||row.message?.stop_reason!=='end_turn')return;
      const text=(row.message.content||[]).filter(c=>c.type==='text').map(c=>c.text||'').join('\n').trim();
      if(text)finals.push({turnId:row.message.id||row.uuid,messageId:row.uuid||row.message.id,text,timestamp:Date.parse(row.timestamp)||null,recordType:'assistant_end_turn',clientSubmissionId});
    }
  },{startOffset:start,discardLeadingPartialLine:cursor?.skipPartial||!cursor&&startOffset==null&&start>0,lineFilter:meta.kind==='codex'?(prefix,ctx)=>{const decision=finalLineFilter(prefix,ctx);lastFilter={index:ctx.lineIndex,decision};return decision;}:undefined});
  const fd=fs.openSync(file,'r');try{const buffer=Buffer.alloc(65536);for(let at=start;at<end;){const n=fs.readSync(fd,buffer,0,Math.min(buffer.length,end-at),at);if(!n)break;scanner.push(buffer.subarray(0,n));at+=n;}}finally{fs.closeSync(fd);}
  const stats=scanner.end({flushFinal:false});
  // Rejected huge tool rows can cross several read batches. Persist the fact
  // that their remaining bytes must be discarded, rather than rereading the
  // same 8 MiB prefix forever. Accepted message rows always keep safeOffset.
  const skipPartial=stats.pendingLineBytes>0&&((cursor?.skipPartial&&stats.nextLineIndex===0)||(lastFilter?.index===stats.nextLineIndex&&lastFilter.decision===false));
  if(meta.kind==='claude'&&!claudeIdentitySeen&&finals.length)return{...empty,issue:'Claude 记录身份未核实'};
  const seen=new Set(),records=[];
  for(const entry of finals){const key=hash(JSON.stringify([identity,entry.turnId||entry.messageId,entry.text]));if(seen.has(key))continue;seen.add(key);
    records.push({...entry,ref:'E'+key.slice(0,16),id:key,notificationKey:hash(JSON.stringify([identity,entry.turnId||entry.messageId])),sessionId:meta.id||meta.hubId,title:meta.title||meta.name||'未命名会话',provider:meta.kind,nativeSessionId:identity,transcriptPath:file,role:'assistant',sourceType:'bound-native-final',evidenceMeaning:'目标助手的最新原文自述，业务结果是否验收需另行核实'});
  }
  return{available:true,identity,records,cursor:{identity,path:file,offset:skipPartial?end:stats.safeOffset,turnId,clientSubmissionId,skipPartial},truncated:start>0&&!cursor||end<stat.size,backlog:end<stat.size,observedAt:Date.now()};
}
// Locate complete record boundaries backwards using fixed byte blocks. Large
// tool bodies are not decoded: only their JSON prefix is inspected. Once the
// latest final is found, include its preceding task_started so its native turn
// identity is the same after a cold restart as during incremental reading.
function coldFinalStart(meta,size){
  const fd=fs.openSync(meta.transcriptPath,'r'),block=Buffer.alloc(65536);let lineEnd=null,found=null;
  const inspect=(start,end)=>{
    const prefix=Buffer.alloc(Math.min(65536,end-start));fs.readSync(fd,prefix,0,prefix.length,start);const text=prefix.toString('utf8');
    const envelope=meta.kind==='codex'?inspectCodexEnvelope(text):null;
    if(found!=null&&envelope?.recordType==='event_msg'&&envelope.payloadType==='task_started')return start;
    if(found!=null){
      if(meta.kind==='claude'&&/"type"\s*:\s*"user"/.test(text)){
        const bytes=Buffer.alloc(end-start);fs.readSync(fd,bytes,0,bytes.length,start);
        try{const row=JSON.parse(bytes.toString('utf8')),c=row.message?.content;
          if(row.sessionId===nativeId(meta)&&!row.isSidechain&&(typeof c==='string'||Array.isArray(c)&&c.some(b=>b.type==='text')&&!c.some(b=>b.type==='tool_result')))return start;
        }catch{}
      }
      return null;
    }
    const candidate=meta.kind==='codex'
      ?envelope?.recordType==='response_item'&&envelope.payloadType==='message'&&envelope.role==='assistant'||envelope?.recordType==='event_msg'&&envelope.payloadType==='item_completed'&&/agentmessage/i.test(String(envelope.itemType||'').replace(/_/g,''))
      :/"type"\s*:\s*"assistant"/.test(text);
    if(!candidate)return null;
    const bytes=Buffer.alloc(end-start);fs.readSync(fd,bytes,0,bytes.length,start);let row;try{row=JSON.parse(bytes.toString('utf8'));}catch{return null;}
    const p=row.payload||{};const final=meta.kind==='codex'
      ?p.role==='assistant'&&(p.phase==='final_answer'||p.channel==='final')||codexAgentMessageEventFromRecord(row)?.completed===true
      :row.type==='assistant'&&row.sessionId===nativeId(meta)&&row.message?.stop_reason==='end_turn';
    if(final)found=start;
    return null;
  };
  try{
    for(let end=size;end>0;){const start=Math.max(0,end-block.length),n=fs.readSync(fd,block,0,end-start,start);
      for(let i=n-1;i>=0;i--){if(block[i]!==10)continue;const boundary=start+i+1;if(lineEnd!=null&&boundary<lineEnd){const answer=inspect(boundary,lineEnd);if(answer!=null)return answer;}lineEnd=boundary;}
      end=start;
    }
    if(lineEnd>0){const answer=inspect(0,lineEnd);if(answer!=null)return answer;}
    return found;
  }finally{fs.closeSync(fd);}
}
class LiveHistory{
  constructor(){this.cache=new Map();}
  read(meta){const file=meta?.transcriptPath;if(!file)return readFinals(meta);let stat;try{stat=fs.statSync(file);}catch{return readFinals(meta);}
    const key=JSON.stringify([file,nativeId(meta),stat.size,stat.mtimeMs]);const old=this.cache.get(meta.id);if(old?.key===key&&!old.result.backlog)return old.result;
    const cursor=old?.result?.cursor;
    const incremental=cursor&&cursor.path===file&&cursor.identity===nativeId(meta)&&cursor.offset<=stat.size&&(stat.size>old.size||old.result.backlog);
    let result=readFinals(meta,incremental?{cursor}:{});
    if(result.available&&incremental){const records=new Map([...old.result.records,...result.records].map(r=>[r.id,r]));result={...result,records:[...records.values()].slice(-40)};}
    if(result.available&&!incremental&&result.truncated&&(!result.records.length||meta.kind==='claude'&&!result.records.at(-1)?.clientSubmissionId)){
      const start=coldFinalStart(meta,stat.size);if(start!=null)result=readFinals(meta,{startOffset:start,maxReadBytes:stat.size-start});
    }
    if(result.backlog)result.issue='原生新增记录仍在分批读取，当前仅为已核对到的最近答复';
    this.cache.set(meta.id,{key,result,size:stat.size});return result;
  }
}
module.exports={readFinals,LiveHistory,nativeId};
