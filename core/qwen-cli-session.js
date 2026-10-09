'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { randomUUID } = require('node:crypto');
const { JsonlTail } = require('./jsonl-tail');
const { captureClaudeMessage, claudeTranscriptTurns } = require('./claude-native-transcript');

// Real Qwen TUI owns execution and history. The two files are Qwen's native
// remote-composer channel and its JSON output; hooks alone settle lifecycle.
class QwenCliSession extends EventEmitter {
  constructor(options) {
    super(); this.options=options; this.isCliProvider=true; this.closed=false;
    this.runtime={connection:'starting',state:'starting',epoch:1,turnId:null};
    this.threadId=null;this.records=[];this.hookTurns=[];this.contentRevision=0;
    this.directory=path.join(options.home,'.qwen','hub-cli',randomUUID());
    fs.mkdirSync(this.directory,{recursive:true});
    this.hookFile=path.join(this.directory,'hooks.jsonl');
    this.inputFile=path.join(this.directory,'input.jsonl');
    this.outputFile=path.join(this.directory,'output.jsonl');
    this.telemetryFile=path.join(this.directory,'lifecycle.json');
    for(const file of [this.hookFile,this.inputFile,this.outputFile])fs.writeFileSync(file,'');
    const settingsPath=path.join(options.home,'.qwen/settings.json');
    const settings=JSON.parse(fs.readFileSync(settingsPath,'utf8'));
    const hook={type:'command',shell:'powershell',timeout:10000,
      command:'& "'+options.launch.command+'" "'+path.join(__dirname,'../scripts/provider-cli-hook.js')+'"'};
    settings.hooks=Object.fromEntries(['SessionStart','UserPromptSubmit','Stop','StopFailure','PreToolUse','PostToolUse','PermissionRequest']
      .map(name=>[name,[{hooks:[hook]}]]));
    settings.general={...settings.general,enableAutoUpdate:false};
    settings.telemetry={enabled:true,target:'local',outfile:this.telemetryFile,
      logPrompts:false,includeSensitiveSpanAttributes:false};
    settings.mcpServers=Object.fromEntries((options.mcpServers||[]).map(server=>[server.name,
      !server.type||server.type==='stdio'?{command:server.command,args:server.args,env:Object.fromEntries((server.env||[]).map(e=>[e.name,e.value]))}
        :{[server.type==='http'?'httpUrl':'url']:server.url,headers:Object.fromEntries((server.headers||[]).map(e=>[e.name,e.value]))}]));
    fs.writeFileSync(settingsPath,JSON.stringify(settings,null,2));
    this.manifest=path.join(options.home,'.qwen','hub-cli-history.json');
    if(!options.forkCli && fs.existsSync(this.manifest)) {
      const saved=JSON.parse(fs.readFileSync(this.manifest,'utf8'));
      if(options.resumeId && saved.sessionId===options.resumeId) this.loadTranscript(saved.path);
    }
  }
  get pid(){return this.pty?.pid || null;}
  onData(fn){this.on('data',fn);return{dispose:()=>this.off('data',fn)};}
  onExit(fn){this.on('exit',fn);return{dispose:()=>this.off('exit',fn)};}
  resize(cols,rows){this.cols=cols;this.rows=rows;this.pty?.resize(cols,rows);}
  write(data){if(this.closed)throw new Error('CLI 已退出');this.pty?.write(data);}
  apply(patch){this.runtime={...this.runtime,...patch};this.emit('state',this.runtime);}
  lifecycle(type,extra={}){this.emit('lifecycle',{type,hubSessionId:this.options.id,kind:this.options.kind,
    threadId:this.threadId,turnId:this.runtime.turnId,signalSource:'qwen-cli',...extra});}
  changed(){this.contentRevision++;this.emit('items');}
  start(){return this.ready ||= this.launch();}
  async launch(){
    if(this.closed)throw new Error('千问 CLI 已关闭');
    this.hookTail=new JsonlTail(this.hookFile,event=>{try{this.observe(event);}catch(error){this.fail(error);}},{onError:error=>this.fail(error)});
    await this.hookTail.start();
    if(this.closed)throw new Error('千问 CLI 已关闭');
    this.telemetryTail=new (require('./qwen-cli-telemetry').QwenTelemetryTail)(this.telemetryFile,
      event=>this.observeTelemetry(event),error=>this.fail(error));
    await this.telemetryTail.start();
    if(this.closed)throw new Error('千问 CLI 已关闭');
    const args=[this.options.launch.args[0],'--auth-type','openai','--approval-mode','yolo',
      '--model',this.options.model,'--json-file',this.outputFile,'--input-file',this.inputFile];
    if(this.options.resumeId)args.push('--resume',this.options.resumeId);
    if(this.options.forkCli)args.push('--fork-session');
    const ready=new Promise((resolve,reject)=>{this.readyResolve=resolve;this.readyReject=reject;});
    this.startTimer=setTimeout(()=>this.fail(new Error('千问 CLI 启动未确认，请查看终端')),60000);
    try{this.pty=require('node-pty').spawn(this.options.launch.command,args,{cwd:this.options.cwd,
      env:{...this.options.launch.env,AI_HUB_PROVIDER_HOOK_LOG:this.hookFile},cols:this.cols||120,rows:this.rows||30,
      name:'xterm-256color',useConpty:true,conptyInheritCursor:false});
    }catch(error){this.dispose();this.readyReject(error);return ready;}
    this.pty.onData(data=>this.emit('data',data));
    this.pty.onExit(info=>{this.closed=true;this.dispose();this.fail(new Error('千问 CLI 已退出'));
      this.emit('exit',info);});
    return ready;
  }
  fail(error){clearTimeout(this.startTimer);this.readyReject?.(error);this.pending?.reject(error);
    if(this.pending)clearTimeout(this.pending.timer);this.pending=null;
    this.apply({connection:'disconnected',state:'failed',reason:error.message});this.emit('action-error',error.message);}
  observe(event){
    if(this.closed || event.agent_id || !event.session_id || path.resolve(event.cwd||'')!==path.resolve(this.options.cwd))return;
    const name=event.hook_event_name;
    if(name==='SessionStart') {
      if(!this.threadId && this.options.resumeId && !this.options.forkCli && event.session_id!==this.options.resumeId)
        return this.fail(new Error('千问恢复返回了不同的会话，未继续发送'));
      this.threadId=event.session_id;this.loadTranscript(event.transcript_path);
      fs.writeFileSync(this.manifest,JSON.stringify({sessionId:this.threadId,path:event.transcript_path}));
      this.emit('bound',{threadId:this.threadId,path:event.transcript_path,cwd:event.cwd,model:event.model||this.options.model});
      this.apply({connection:'connected',state:'idle'});clearTimeout(this.startTimer);this.readyResolve?.();return;
    }
    if(event.session_id!==this.threadId)return;
    if(name==='UserPromptSubmit') {
      const at=Date.parse(event.timestamp)||Date.now(),text=event.submitted_prompt||event.prompt||'';
      // Native Qwen emits empty UserPromptSubmit hooks when continuing after a
      // tool result. They belong to the current user turn, not a new submission.
      if(!text.trim())return;
      this.hookTurn={id:randomUUID(),at,text,submissionId:this.pending?.text===text?this.pending.id:null};
      this.hookTurns.push(this.hookTurn);
      this.bindRecord(this.records.at(-1));
      this.apply({state:'running',turnId:this.hookTurn.id});
      this.lifecycle('prompt-submitted',{text,submittedAt:at,clientSubmissionId:this.pending?.text===text?this.pending.id:null});
      this.lifecycle('turn-started',{startedAt:at});
      if(this.pending?.text===text){clearTimeout(this.pending.timer);this.pending.resolve({ok:true,sendStatus:'ok',acknowledgementSource:'qwen-cli',threadId:this.threadId,turnId:this.runtime.turnId,clientSubmissionId:this.pending.id});this.pending=null;}
    } else if(name==='PermissionRequest')this.apply({state:'waiting'});
    else if(name==='Stop' || name==='StopFailure') {
      if(!this.hookTurn)return;
      const completedAt=Date.parse(event.timestamp)||Date.now();
      if(completedAt<this.hookTurn.at)return;
      this.lastOutcome={hubSessionId:this.options.id,threadId:this.threadId,turnId:this.runtime.turnId,
        signalSource:'qwen-cli',text:event.last_assistant_message||'',completedAt,finality:'provider_final',
        status:name==='Stop'?'completed':'failed'};
      this.apply({state:this.lastOutcome.status,completedAt});
      this.hookTurn.outcome=this.lastOutcome;
      for(const record of this.records)this.bindRecord(record);
      this.lifecycle(name==='Stop'?'turn-complete':'turn-error',this.lastOutcome);
      this.hookTurn=null;this.changed();
    }
  }
  bindRecord(record){
    if(!record)return;
    // Native Qwen emits UserPromptSubmit before persisting the real_user row.
    // Keep the hook even after Stop: the disk watcher may deliver that row later.
    const turn=this.hookTurns.findLast(t=>t.at<=record.createdAt);
    if(!turn||turn.text!==record.text)return;
    record.turnId=turn.id;record.submissionId=turn.submissionId;
    if(turn.outcome)Object.assign(record,{status:turn.outcome.status,
      completedAt:turn.outcome.completedAt,finalText:turn.outcome.text});
  }
  observeTelemetry(event){
    const a=event.attributes;
    if(this.closed||!this.hookTurn||a?.['session.id']!==this.threadId
      ||a['event.name']!=='qwen-code.api_cancel')return;
    const completedAt=Date.parse(a['event.timestamp']);
    if(!Number.isFinite(completedAt)||completedAt<this.hookTurn.at)return;
    this.lastOutcome={hubSessionId:this.options.id,threadId:this.threadId,turnId:this.hookTurn.id,
      signalSource:'qwen-cli',text:'',completedAt,finality:'provider_final',status:'interrupted'};
    this.hookTurn.outcome=this.lastOutcome;
    for(const record of this.records)this.bindRecord(record);
    this.apply({state:'interrupted',completedAt});this.lifecycle('turn-aborted',this.lastOutcome);
    this.hookTurn=null;this.changed();
  }
  loadTranscript(file){
    if(!file || !path.resolve(file).startsWith(path.resolve(this.options.home)+path.sep))throw new Error('千问记录路径越界');
    this.transcriptTail?.close();this.records=[];this.transcriptPath=file;
    this.transcriptTail=new JsonlTail(file,row=>{
      if(row.sessionId!==this.threadId && this.threadId)return;
      const parts=row.message?.parts;if(!Array.isArray(parts))return;
      if(row.type==='user' && row.provenance==='real_user')this.records.push({userMessageId:row.uuid,
        text:parts.filter(p=>p.text).map(p=>p.text).join('\n'),createdAt:Date.parse(row.timestamp),status:'running',accepted:true});
      const record=this.records.at(-1);if(!record)return;
      this.bindRecord(record);
      if(row.type==='assistant'&&row.model&&row.model!==this.currentModel){this.currentModel=row.model;this.emit('bound',{threadId:this.threadId,model:row.model});}
      if(row.type==='assistant' || row.type==='user')captureClaudeMessage(record,{...row,message:{...row.message,
        content:parts.map(p=>p.functionCall?{type:'tool_use',id:p.functionCall.id,name:p.functionCall.name,input:p.functionCall.args}
          :p.functionResponse?{type:'tool_result',tool_use_id:p.functionResponse.id,content:JSON.stringify(p.functionResponse.response)}
          :p.thought?{type:'thinking',thinking:p.text||''}:{type:'text',text:p.text||''})}});
      this.changed();
    },{onError:error=>{if(error.code!=='ENOENT')this.emit('action-error','千问记录读取失败：'+error.message);}});
    this.transcriptTail.start().catch(error=>this.fail(error));
  }
  async send(text,options={}){
    await this.start();
    if(this.closed||this.runtime.connection!=='connected')throw Object.assign(new Error('千问 CLI 未连接，消息未发送'),{notSent:true});
    if(this.configurePending&&!options.configurationCommand)throw Object.assign(new Error('千问正在确认模型切换，请稍候'),{notSent:true});
    if(this.pending||['running','waiting'].includes(this.runtime.state))throw Object.assign(new Error('千问仍在执行，请在终端处理或等待完成'),{notSent:true});
    if(options.attachments?.length)throw Object.assign(new Error('请在千问终端中添加附件'),{notSent:true});
    if(text.trimStart().startsWith('/')){
      fs.appendFileSync(this.inputFile,JSON.stringify({type:'submit',text})+'\n');
      return {ok:true,sendStatus:'dispatched',commandOutput:'已送入 CLI，请在终端查看执行结果'};
    }
    const id=options.clientSubmissionId||randomUUID();
    const promise=new Promise((resolve,reject)=>{this.pending={id,text,resolve,reject,
      // 超时如实报未确认，同时释放这一条的占位：否则之后每次发送都被「仍在执行」挡住，
      // 只能重启 CLI。真在运行时 runtime.state 的检查照样拦得住。
      timer:setTimeout(()=>{if(this.pending?.id===id)this.pending=null;resolve({ok:false,sendStatus:'stuck',unconfirmed:true});},15000)};});
    try{options.beforeStart?.();fs.appendFileSync(this.inputFile,JSON.stringify({type:'submit',text})+'\n');}
    catch(error){clearTimeout(this.pending.timer);this.pending=null;throw Object.assign(error,{notSent:true});}
    return promise;
  }
  readTranscript(options={}){
    const records=options.turnId?this.records.filter(r=>r.turnId===options.turnId):this.records;
    const cards=claudeTranscriptTurns(options.latestTurn?records.slice(-1):records).map(card=>{
      const record=records.find(r=>r.userMessageId===(card.userMessageId||card.id));
      const identity={providerTurnId:record?.turnId||null,clientSubmissionId:record?.submissionId||null};
      return {...card,...identity,source:'qwen-cli',kind:'qwen',
        ...(card.displayMessages?{displayMessages:card.displayMessages.map(m=>({...m,...identity}))}:{}),
        ...(card.toolCalls?{toolCalls:card.toolCalls.map(t=>({...t,...identity}))}:{})};
    });
    return Number.isFinite(options.limit)?options.fromTail===false?cards.slice(0,options.limit):cards.slice(-options.limit):cards;
  }
  blocks(){return this.readTranscript().filter(c=>c.role==='assistant').slice(-1).map(c=>({type:'text',text:c.text||''}));}
  finalText(){return this.blocks().map(b=>b.text).join('\n');}
  async configure({model,effort}={}, {timeoutMs=10000}={}){
    await this.start();
    if(effort!==undefined)throw new Error('千问思考设置请在原生 /settings 中调整');
    if(this.configurePending||this.pending||['running','waiting'].includes(this.runtime.state))throw new Error('请等当前轮结束后再切换模型');
    const file=path.join(this.options.home,'.qwen/settings.json');
    const settings=JSON.parse(fs.readFileSync(file,'utf8'));
    if(typeof model!=='string'||!settings.modelProviders?.openai?.some(m=>m.id===model))throw new Error('该模型不在当前千问配置中');
    if(this.currentModel===model)return{modelId:model,displayName:model};
    const revision=fs.statSync(file,{bigint:true}).mtimeNs;
    this.configurePending=true;
    try{
      await this.send('/model '+model,{configurationCommand:true});
      // Native Qwen persists model.name only after config.switchModel succeeds.
      // A pre-existing value is not a receipt for this command.
      for(const end=Date.now()+timeoutMs;Date.now()<end;){
        if(this.closed||this.runtime.connection!=='connected')throw new Error('千问连接已中断，模型切换未确认');
        const updated=fs.statSync(file,{bigint:true}).mtimeNs;
        if(updated!==revision&&JSON.parse(fs.readFileSync(file,'utf8')).model?.name===model){
          this.currentModel=model;this.options.model=model;
          this.emit('bound',{threadId:this.threadId,model});
          return{modelId:model,displayName:model,appliesOn:'next-turn',confirmationSource:'native-settings-write'};
        }
        await new Promise(resolve=>setTimeout(resolve,50));
      }
      throw new Error('千问未确认模型切换，请查看终端；Hub 未更新模型');
    }finally{this.configurePending=false;}
  }
  async reconcile(){if(this.runtime.connection!=='connected')throw new Error('请先恢复 CLI 连接');return this.runtime;}
  async readOutcome(turnId){return this.lastOutcome?.turnId===turnId?this.lastOutcome:null;}
  async interrupt(){if(!['running','waiting'].includes(this.runtime.state)||this.interruptAt&&Date.now()-this.interruptAt<1500)return;
    if(this.interruptedTurn===this.runtime.turnId)return;
    this.interruptedTurn=this.runtime.turnId;this.interruptAt=Date.now();this.write('\x03');}
  async fork(){await this.start();if(this.pending||['running','waiting'].includes(this.runtime.state))throw new Error('请等当前轮结束后再分支');return{home:this.options.home,sessionId:this.threadId,forkCli:true};}
  dispose(){clearTimeout(this.startTimer);this.hookTail?.close();this.transcriptTail?.close();this.telemetryTail?.close();}
  kill(){this.closed=true;this.readyReject?.(new Error('CLI 已关闭'));this.dispose();if(this.pending){clearTimeout(this.pending.timer);this.pending.reject(new Error('CLI 已关闭'));this.pending=null;}this.pty?.kill();}
}
module.exports={QwenCliSession};
