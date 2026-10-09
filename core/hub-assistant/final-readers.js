'use strict';
const fs=require('node:fs'),path=require('node:path'),{createHash}=require('node:crypto');
const {LiveHistory,nativeId,readFinals}=require('./live-history');
const digest=value=>createHash('sha256').update(value).digest('hex');
function projectFinals(meta,turns,sourceType) {
  const identity=nativeId(meta),records=[];let clientSubmissionId=null;
  for(const turn of turns) {
    if(turn.role==='user')clientSubmissionId=require('../assistant-context-display').assistantContextDisplay(turn.text,'hub-assistant')?.clientSubmissionId||null;
    if(turn.role!=='assistant'||turn.nativeOutcome!=='completed'||!turn.text?.trim())continue;
    const messages=(turn.displayMessages||[]).filter(m=>m.phase==='final_answer'&&m.text?.trim());
    const text=messages.length?messages.map(m=>m.text).join('\n\n'):turn.text.trim();
    const turnId=turn.providerTurnId||turn.id,key=digest(JSON.stringify([identity,turnId,text]));
    records.push({id:key,ref:'E'+key.slice(0,16),notificationKey:digest(JSON.stringify([identity,turnId])),
      sessionId:meta.id||meta.hubId,title:meta.title||meta.name,provider:meta.kind,nativeSessionId:identity,
      role:'assistant',turnId,clientSubmissionId,messageId:turn.id,text,timestamp:turn.tsEnd||turn.ts||null,
      transcriptPath:meta.transcriptPath||null,sourceType,recordType:sourceType,
      evidenceMeaning:'目标助手原生完成回合的最终自述，业务是否验收需另行核实'});
  }
  return {available:true,identity,records,observedAt:Date.now()};
}
class AssistantFinalReaders {
  constructor(deps) {this.deps=deps;this.files=new LiveHistory();}
  read(meta,options={}) {
    if(typeof meta?.kind==='string'&&meta.kind.endsWith('-resume'))meta={...meta,kind:meta.kind.slice(0,-7)};
    const identity=nativeId(meta),empty={available:false,identity,records:[]};
    if(!identity)return {...empty,issue:'原生会话身份尚未就绪'};
    if(['codex','claude'].includes(meta.kind))return Object.hasOwn(options,'cursor')?readFinals(meta,options):this.files.read(meta);
    if(meta.kind==='deepseek') {
      const source={...meta,kind:meta.codexSid?'codex':'claude'};
      const result=Object.hasOwn(options,'cursor')?readFinals(source,options):this.files.read(source);
      return {...result,records:result.records.map(s=>({...s,provider:meta.kind}))};
    }
    try {
      if(require('../acp-profiles').isAcpKind(meta.kind)) {
        const native=this.deps.readNativeTurns?.(meta.id||meta.hubId);
        if(native) {
          if(native.identity!==identity)return {...empty,issue:'原生运行通道身份与目标不一致'};
          return projectFinals(meta,native.turns,'bound-provider-final');
        }
        return this.readStoredAcp(meta);
      }
      if(!meta.transcriptPath||!fs.existsSync(meta.transcriptPath))return {...empty,issue:'绑定原生记录尚未就绪'};
      if(meta.kind==='gemini') {
        const turns=require('../gemini-transcript-parser').parseGeminiTranscriptToTurns(meta.transcriptPath,{expectedSessionId:identity,limit:80});
        return projectFinals(meta,turns,'bound-gemini-final');
      }
      if(meta.kind==='kimi') {
        const expected=path.join(meta.kimiSessionDir||'', 'agents','main','wire.jsonl');
        if(!meta.kimiSessionDir||path.basename(meta.kimiSessionDir)!==identity
          ||path.resolve(expected)!==path.resolve(meta.transcriptPath))return {...empty,issue:'Kimi 记录目录与目标身份不一致'};
        const turns=require('../kimi-transcript-parser').parseKimiWireToTurns(meta.transcriptPath,{limit:80});
        return projectFinals(meta,turns.map(t=>({...t,nativeOutcome:t.role==='assistant'&&['completed','end_turn','stop'].includes(t.stopReason)?'completed':null})), 'bound-kimi-final');
      }
      return {...empty,issue:'该提供方即时原文读取尚未接入'};
    }catch(error){return {...empty,issue:'原生记录核对失败：'+error.message};}
  }
  readStoredAcp(meta) {
    const empty={available:false,identity:nativeId(meta),records:[]};
    const file=path.join(this.deps.dataDir,'acp-history',digest(meta.id||meta.hubId)+'.json.sqlite');
    if(!fs.existsSync(file))return {...empty,issue:'该会话未打开且持久化原生记录尚未就绪'};
    const {DatabaseSync}=require('node:sqlite'),db=new DatabaseSync(file,{readOnly:true});
    try {
      const saved=JSON.parse(db.prepare('SELECT value FROM metadata WHERE id=1').get()?.value||'null');
      if(!saved||saved.kind!==meta.kind||saved.sessionId!==nativeId(meta)
        ||saved.profileId!==meta.acpProfileId||path.resolve(saved.cwd)!==path.resolve(meta.cwd))
        return {...empty,issue:'持久化会话身份或配置域不匹配'};
      const turns=db.prepare('SELECT * FROM turns ORDER BY ordinal DESC LIMIT 40').all().reverse().map(row=>({
        ...JSON.parse(row.value),items:db.prepare('SELECT value FROM items WHERE turn_id=? ORDER BY ordinal').all(row.id).map(i=>JSON.parse(i.value))
      }));
      const cards=require('../codex-native-transcript').nativeTranscriptTurns(nativeId(meta),turns);
      return projectFinals(meta,cards,'bound-stored-provider-final');
    }finally{db.close();}
  }
}
module.exports={AssistantFinalReaders,projectFinals};
