'use strict';
const fs=require('fs');
const path=require('path');
const {EventEmitter}=require('events');
const {UUID,isAntigravity}=require('./antigravity-config');
const {parseAntigravityTranscriptToTurns,hash}=require('./antigravity-transcript-parser');
const EVENTS=['turn-complete','progress-update','turn-started','turn-aborted','turn-error','session-bound','prompt-submitted','background-work-changed','context-window-observed'];
class AntigravityTap extends EventEmitter {
  constructor(){super();this._bound=new Map();}
  hasSession(id){return this._bound.has(id);}
  registerSession(id,ctx){
    this.unregisterSession(id);
    if(!ctx.antigravityEventsFile)throw Error('Antigravity 原生事件路径缺失');
    const s={...ctx,id,offset:0,turns:[],lastText:null,active:false,lastStop:null,error:null};
    this._read(s);s.lastUser=s.turns.filter(t=>t.role==='user').at(-1)?.id;
    this._bound.set(id,s);
    s.timer=setInterval(()=>this._poll(s),400);s.timer.unref?.();this._poll(s);
  }
  unregisterSession(id){const s=this._bound.get(id);if(s)clearInterval(s.timer);this._bound.delete(id);}
  notePrompt(id){const s=this._bound.get(id);if(s)s.lastText=null;}
  _receiptPath(s){return path.join(path.dirname(s.antigravityEventsFile),'native-'+s.geminiChatId+'.json');}
  _read(s){
    if(!s.transcriptPath)return;
    const files=[s.transcriptPath,path.join(path.dirname(s.transcriptPath),'transcript_full.jsonl'),this._receiptPath(s)];
    const signature=files.map(f=>{try{const st=fs.statSync(f);return `${st.size}:${st.mtimeMs}`;}catch(e){if(e.code==='ENOENT')return 'missing';throw e;}}).join('|');
    if(signature===s.signature)return;
    s.turns=parseAntigravityTranscriptToTurns(s.transcriptPath,{expectedSessionId:s.geminiChatId,receiptsFile:this._receiptPath(s)});s.signature=signature;
  }
  _poll(s){
    try{
      if(fs.existsSync(s.antigravityEventsFile) && fs.statSync(s.antigravityEventsFile).size!==s.bytes){
        const raw=fs.readFileSync(s.antigravityEventsFile,'utf8');
        if(raw.length<s.offset)throw Error('Antigravity 事件记录意外被截断');
        const end=raw.lastIndexOf('\n')+1;
        for(const line of raw.slice(s.offset,end).split('\n').filter(Boolean))this._event(s,JSON.parse(line));
        s.offset=end;
        s.bytes=Buffer.byteLength(raw.slice(0,end),'utf8');
      }
      this._read(s);
      if(s.active)this._observeUser(s);
      if(s.active)this.emit('progress-update',{hubSessionId:s.id,kind:'gemini',source:'antigravity-cli'});
      s.error=null;
    }catch(error){if(s.error!==error.message){s.error=error.message;console.warn('[antigravity-tap]',s.id,error.message);
      this.emit('turn-error',{hubSessionId:s.id,kind:'gemini',error:error.message,source:'antigravity-cli'});}}
  }
  _observeUser(s){
    const u=s.turns.filter(t=>t.role==='user').at(-1);
    if(u&&u.id!==s.lastUser){s.lastUser=u.id;this.emit('prompt-submitted',{hubSessionId:s.id,kind:'gemini',text:u.text,
      transcriptPath:s.transcriptPath,submittedAt:u.ts||Date.now(),signalSource:'antigravity_user_message'});}
  }
  _event(s,e){
    if(e.hubSessionId!==s.id||!UUID.test(e.conversationId||''))throw Error('Antigravity 事件身份无效');
    if(s.geminiChatId && s.geminiChatId!==e.conversationId)throw Error('Antigravity 事件来自其他会话');
    if(e.transcriptPath && !new RegExp('[\\\\/]brain[\\\\/]'+e.conversationId+'[\\\\/]','i').test(e.transcriptPath))throw Error('Antigravity 转录路径身份无效');
    const fresh=!s.geminiChatId||s.transcriptPath!==e.transcriptPath;
    s.geminiChatId=e.conversationId;
    if(e.transcriptPath)s.transcriptPath=e.transcriptPath;
    if(fresh)this.emit('session-bound',{hubSessionId:s.id,kind:'gemini',geminiChatId:s.geminiChatId,
      geminiProjectHash:'antigravity',geminiProjectRoot:s.cwd,sessionPath:s.transcriptPath});
    // Read native content before publishing lifecycle so collectors see this turn.
    this._read(s);
    if(e.observedAt < (s.registeredAt||0))return;
    const ev={hubSessionId:s.id,kind:'gemini',source:'antigravity-cli',signalSource:'antigravity_hook',startedAt:e.observedAt,transcriptPath:s.transcriptPath,ts:e.observedAt,modelId:e.modelName};
    if(e.event==='PreInvocation'){
      if(!s.active){s.active=true;s.lastText=null;this.emit('turn-started',ev);}
      this._observeUser(s);
    }
    if(e.event==='Stop' && e.fullyIdle===true){
      const key=`${e.executionNum}:${e.observedAt}`;if(s.lastStop===key)return;s.active=false;
      const lastUser=s.turns.findLastIndex(t=>t.role==='user');
      const answer=s.turns.slice(lastUser+1).filter(t=>t.role==='assistant'&&t.text).at(-1);
      if(e.error||e.terminationReason==='error'){this.emit('turn-error',{...ev,error:e.error||'Antigravity 执行失败'});return;}
      // 1.3.3 emits NO_TOOL_CALL for a successful final response; newer hook
      // documentation calls the same normal completion model_stop.
      if(!['model_stop','NO_TOOL_CALL'].includes(e.terminationReason)){this.emit('turn-aborted',{...ev,reason:e.terminationReason||'未收到正常结束原因'});return;}
      if(!answer)throw Error('Antigravity 已停止，但最终正文尚未写入原生记录');
      s.lastText=answer?.text||null;
      if(answer){
        const file=this._receiptPath(s),receipts=fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):{};
        receipts[answer.id]={ts:answer.ts,textHash:hash(answer.text),outcome:'completed',completedAt:e.observedAt};
        const tmp=file+'.'+process.pid+'.tmp';fs.writeFileSync(tmp,JSON.stringify(receipts),'utf8');fs.renameSync(tmp,file);
        this._read(s);
      }
      s.lastStop=key;
      this.emit('turn-complete',{...ev,text:s.lastText||'',completedAt:e.observedAt});
    }
  }
  getLastAssistantText(id){return this._bound.get(id)?.lastText||null;}
  getStreamingText(id){const s=this._bound.get(id);if(!s?.active)return null;
    const lastUser=s.turns.findLastIndex(t=>t.role==='user');
    const a=s.turns.slice(lastUser+1).filter(t=>t.role==='assistant'&&t.text).at(-1);
    return a?[{type:'text',text:a.text}]:null;}
  clearStreamingBuf(){}
  getLastTokens(){return null;}
  clearLastTokens(){}
  async extractLatestGeminiTurn(id,since=0){const s=this._bound.get(id);if(!s)return null;this._read(s);const t=s.turns.filter(t=>t.role==='assistant'&&t.text&&(!since||t.ts>=since)).at(-1);return t?{text:t.text,source:'antigravity-cli'}:null;}
  getDebugSnapshot(){return [...this._bound.values()].map(s=>({hubSessionId:s.id,conversationId:s.geminiChatId,transcriptPath:s.transcriptPath,active:s.active,error:s.error}));}
}
// Existing Gemini transcripts stay readable; every new session uses the native agy adapter.
class GoogleCliTap extends EventEmitter {
  constructor(legacy){super();this.legacy=legacy;this.agy=new AntigravityTap();for(const b of [legacy,this.agy])for(const e of EVENTS)b.on(e,v=>this.emit(e,v));}
  get _bound(){return new Map([...this.legacy._bound,...this.agy._bound]);}
  get _pending(){return this.legacy._pending;}
  _for(id){return this.agy.hasSession(id)?this.agy:this.legacy;}
  registerSession(id,ctx){this.unregisterSession(id);(isAntigravity(ctx)?this.agy:this.legacy).registerSession(id,ctx);}
  unregisterSession(id){this.legacy.unregisterSession(id);this.agy.unregisterSession(id);}
  hasSession(id){return this.agy.hasSession(id)||this.legacy.hasSession(id);}
  getDebugSnapshot(){return {legacy:this.legacy.getDebugSnapshot(),antigravity:this.agy.getDebugSnapshot()};}
}
for(const method of ['notePrompt','getLastAssistantText','getStreamingText','clearStreamingBuf','getLastTokens','clearLastTokens','extractLatestGeminiTurn'])
  GoogleCliTap.prototype[method]=function(id,...args){return this._for(id)[method](id,...args);};
module.exports={AntigravityTap,GoogleCliTap};
