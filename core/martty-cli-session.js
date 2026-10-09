'use strict';
const fs=require('node:fs'),path=require('node:path');
const {randomUUID,createHash}=require('node:crypto');
const {AcpSession}=require('./acp-session');
const {JsonlTail}=require('./jsonl-tail');
// Reuse only the existing event-to-card projection and durable history. The
// terminal client is the sole controller; this adapter has no ACP client.
class MarttyCliSession extends AcpSession {
  constructor(options){super(options);this.isCliProvider=true;this.source='provider-cli';this.requests=new Map();
    this.promptQueue={records:[],hold(){},schedule(){},restore(){},snapshot(){return[];}};
    this.directory=path.join(options.home,'.martty','hub-cli',randomUUID());fs.mkdirSync(this.directory,{recursive:true});
    this.events=path.join(this.directory,'events.jsonl');fs.writeFileSync(this.events,'');this.buffer='';
  }
  get pid(){return this.pty?.pid||null;}
  print(){} // Never duplicate protocol text into the real TUI's output.
  lifecycle(type,extra={}){super.lifecycle(type==='turn-start'?'turn-started':type,{...extra,signalSource:this.source});}
  async _start(){
    if(this.closed)throw new Error('CLI 已关闭');
    this.loadHistory();this.currentModel=this.options.model;
    const martty=require.resolve('martty/package.json',{paths:[path.dirname(this.options.launch.args[0])]});
    const args=[path.join(path.dirname(martty),'bin/martty.js'),'--agent',this.options.launch.command,
      '--agent-arg',path.join(__dirname,'../scripts/provider-cli-tap.js'),'--workspace',this.options.cwd,
      '--model',this.options.model];
    if(this.options.kind==='deepseek-acp')args.push('--provider','bailian-tpp');
    const resume=this.options.resumeId||this.saved?.sessionId;
    if(resume)args.push('--session-id',resume);
    const env={...this.options.launch.env,MARTTY_HOME:path.join(this.options.home,'.martty'),
      AI_HUB_CLI_EVENT_LOG:this.events,AI_HUB_CLI_REDACT:JSON.stringify(this.options.launch.secrets||[]),AI_HUB_CLI_AGENT_LAUNCH:JSON.stringify({command:this.options.launch.command,args:this.options.launch.args,cwd:this.options.cwd,mcpServers:this.options.mcpServers||[]})};
    if(resume&&this.options.kind==='glm')env.ZCODE_ACP_RESUME_SESSION=resume;
    this.tail=new JsonlTail(this.events,event=>{try{this.observe(event);}catch(error){this.fail(error);}},{onError:error=>this.fail(error)});
    await this.tail.start();
    if(this.closed)throw new Error('CLI 已关闭');
    const ready=new Promise((resolve,reject)=>{this.readyResolve=resolve;this.readyReject=reject;});
    this.startTimer=setTimeout(()=>this.fail(new Error('终端启动未确认，请查看 CLI')),60000);
    try{this.pty=require('node-pty').spawn(this.options.launch.command,args,{cwd:this.options.cwd,env,cols:this.cols||120,rows:this.rows||30,
      name:'xterm-256color',useConpty:true,conptyInheritCursor:false});
    }catch(error){this.dispose();this.readyReject(error);return ready;}
    this.pty.onData(data=>{this.buffer=(this.buffer+data).slice(-100000);this.emit('data',data);});
    this.pty.onExit(info=>{this.closed=true;this.fail(new Error('CLI 已退出'));this.dispose();this.emit('exit',info);});
    return ready;
  }
  fail(error){this.readyReject?.(error);clearTimeout(this.startTimer);
    if(this.pending){clearTimeout(this.pending.timer);this.pending.reject(error);this.pending=null;}
    this.apply({type:'disconnect',reason:error.message});this.emit('action-error',error.message);}
  observe({direction,at,message:m}){
    if(this.closed)return;
    if(direction==='client' && m.method && m.id!==undefined){this.requests.set(m.id,m);
      if(m.method==='session/prompt')this.begin(m,at);
      return;
    }
    if(direction!=='agent')return;
    const request=this.requests.get(m.id);
    if(request){this.requests.delete(m.id);
      if(m.error){
        if(request.method==='session/prompt'){
          if(this.active?.requestId===m.id)super.finish(this.active,'failed',m.error.message,m);
        }else this.fail(new Error(m.error.message));
        return;
      }
      if(request.method==='initialize'){this.capabilities=m.result.agentCapabilities;return;}
      if(['session/new','session/load','session/resume'].includes(request.method)){
        const sid=m.result?.sessionId||request.params?.sessionId;
        if(!sid)throw new Error('CLI 未返回会话身份');
        if(!this.threadId&&this.options.resumeId&&sid!==this.options.resumeId)throw new Error('CLI 恢复身份不一致');
        if(this.threadId&&sid!==this.threadId){
          const error=new Error('CLI 已切换会话，旧提交未确认');
          this.active?.reject(error);this.active=null;
          if(this.pending){clearTimeout(this.pending.timer);this.pending.reject(error);this.pending=null;}
          this.requests.clear();this.history.clear();this.items.clear();
          this.runtime=require('./codex-native-runtime').createNativeRuntime(this.runtime.epoch+1);
        }
        this.threadId=sid;this.configOptions=m.result.configOptions||[];
        this.apply({type:'snapshot',thread:{id:sid,status:{type:'idle'},turns:[]}});
        this.emit('bound',{threadId:sid,cwd:this.options.cwd,model:this.currentModel,
          capabilities:{loadSession:true},configOptions:this.configOptions});
        this.persist();clearTimeout(this.startTimer);this.readyResolve?.();return;
      }
      if(request.method==='session/prompt'&&this.active&&this.active.requestId===m.id){
        this.acknowledge();const reason=m.result?.stopReason;
        super.finish(this.active,reason==='end_turn'?'completed':reason==='cancelled'?'interrupted':'failed',
          ['end_turn','cancelled'].includes(reason)?null:'CLI 已停止：'+reason,m.result);return;
      }
    }
    if(m.method==='session/request_permission'){
      if(m.params?.sessionId!==this.threadId||!this.active)return;
      this.apply({type:'request',threadId:this.threadId,request:{...m,params:{...m.params,turnId:this.active?.turnId}}});return;
    }
    if(m.method==='session/update'){
      if(m.params?.sessionId!==this.threadId)return;
      if(m.params?.update?.sessionUpdate==='config_option_update'){
        const model=m.params.update.configOptions?.find(o=>o.category==='model')?.currentValue;
        if(model){this.currentModel=model.split(/[\\/]/).at(-1);this.emit('bound',{threadId:this.threadId,model:this.currentModel});}
      }
      super.notification(m);
    }
  }
  begin(message,at){
    if(message.params?.sessionId!==this.threadId)throw new Error('CLI prompt 身份与卡片不一致');
    const content=message.params.prompt||[],text=content.filter(c=>c.type==='text').map(c=>c.text).join('\n');
    const pending=this.pending?.text===text?this.pending:null;
    const turnId=randomUUID(),id=pending?.id||randomUUID();
    this.items=new Map([[turnId+':user',{id:turnId+':user',type:'userMessage',content,hubStartedAt:at}]]);
    this.segment=0;this.history.set(turnId,{id:turnId,status:'inProgress',model:this.currentModel,hubStartedAt:at,items:[...this.items.values()]});
    this.active={id,text,turnId,at,requestId:message.id,digest:createHash('sha256').update(text).digest('hex'),
      resolve:result=>{if(pending){clearTimeout(pending.timer);pending.resolve({...result,mode:this.source,acknowledgementSource:this.source});if(this.pending===pending)this.pending=null;}},
      reject:error=>{if(pending){clearTimeout(pending.timer);pending.reject(error);if(this.pending===pending)this.pending=null;}}};
    this.apply({type:'submission',submission:{id,submittedAt:at,status:'submitting'}});
    this.apply({type:'started',threadId:this.threadId,turn:{id:turnId}});this.changed();
  }
  async send(text,options={}){
    await this.start();
    if(this.closed||this.runtime.connection!=='connected'||this.active||this.pending)throw Object.assign(new Error('CLI 尚未就绪或仍在执行，消息未发送'),{notSent:true});
    if(options.attachments?.length)throw Object.assign(new Error('请在终端中添加附件'),{notSent:true});
    const input=require('./martty-prompt-input');
    const encoded=input.encodeMarttyPrompt(text);text=encoded.text;
    let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});
    // Own the acknowledgement rejection immediately: the PTY may exit while
    // this method is still awaiting chunk writes. Propagate it below.
    const acknowledgement=promise.then(value=>({value}),error=>({error}));
    // 超时如实报未确认，同时释放这一条的占位：否则之后每次发送都报「仍在执行」，只能重启 CLI。
    const pendingId=options.clientSubmissionId||randomUUID();
    this.pending={id:pendingId,text,resolve,reject,
      timer:setTimeout(()=>{if(this.pending?.id===pendingId)this.pending=null;resolve({ok:false,sendStatus:'stuck',unconfirmed:true});},Math.min(180000,20000+text.length*5))};
    const paste=require('./pty-prompt-submit');
    const write=data=>{
      if(this.closed||this.runtime.connection!=='connected')throw new Error(this.runtime.reason||'CLI 已断开，提交未确认');
      this.write(data);
    };
    const manager={writeToSession:(_,data)=>write(data),getSessionBuffer:()=>this.buffer};
    try{options.beforeStart?.();const baselineMarker=paste.snapshotPasteMarker(manager,this.options.id);
      await input.writeMarttyPrompt(write,encoded.payload);
      await paste.waitForPasteSettled({sessionManager:manager,sid:this.options.id,
        settleMs:paste.computeSettleMs(encoded.payload.length),baselineMarker});
      // Explicit unmodified Enter avoids inheriting a Shift modifier in ConPTY.
      write(input.ENTER);
      if(text.trimStart().startsWith('/')){clearTimeout(this.pending?.timer);this.pending=null;return {ok:true,sendStatus:'dispatched',commandOutput:'已送入 CLI，请在终端查看执行结果'};}
    }catch(error){clearTimeout(this.pending?.timer);this.pending=null;throw error;}
    const outcome=await acknowledgement;
    if(outcome.error)throw outcome.error;
    return outcome.value;
  }
  write(data){if(this.closed)throw new Error('CLI 已退出');
    try{data=require('./martty-prompt-input').translateMarttyInput(data);}
    catch(error){this.emit('action-error',error.message);return;}
    this.pty?.write(data);}
  resize(cols,rows){this.cols=cols;this.rows=rows;this.pty?.resize(cols,rows);}
  readTranscript(options){return super.readTranscript(options).map(c=>({...c,source:this.source}));}
  async interrupt(){if(!this.active||this.interruptAt&&Date.now()-this.interruptAt<1500)return;this.interruptAt=Date.now();this.write('\x1b');}
  async fork(){throw new Error('请在 CLI 中使用原生分支命令；Hub 尚未接入此终端的分支回执');}
  async configure(){throw new Error('请在 CLI 中使用 /model；卡片会同步原生模型变更回执');}
  async reconnect(){throw new Error('请使用「重启会话」恢复 CLI，必须先停止旧终端');}
  async reply(){throw new Error('请到 CLI 终端中回答或授权');}
  dispose(){clearTimeout(this.startTimer);this.tail?.close();if(this.pending){clearTimeout(this.pending.timer);this.pending.reject(new Error('CLI 已关闭'));this.pending=null;}
    this.backstage.close();this._historyStore?.close();this._historyStore=null;}
  kill(){
    try{this.persist();}
    finally{
      this.closed=true;this.readyReject?.(new Error('CLI 已关闭'));
      try{this.dispose();}finally{this.pty?.kill();}
    }
  }
}
module.exports={MarttyCliSession};
