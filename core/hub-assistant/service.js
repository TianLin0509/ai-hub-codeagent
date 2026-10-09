'use strict';
const path=require('node:path');
const fs=require('node:fs');
const { randomUUID }=require('node:crypto');
const { AssistantHistory }=require('./history');
const { AssistantStore }=require('./store');
const { AssistantBridge }=require('./bridge');
const { buildBootstrapPrompt,resolveTimeRange }=require('./context');
const {AssistantSnapshots}=require('./snapshots');
const { readGroupHistory }=require('./group-history');
const { requireAuthorizedTarget,requireBoundTarget,bindOperation }=require('./action-policy');
const {nativeId}=require('./live-history');
const {AssistantWatches,reminderIntent}=require('./watches');
const {isAssistantSession,requireManagerCaller}=require('./permissions');
const {projectSessionStates}=require('./session-state');
const backends=require('./backends');
const profiles=require('./profiles');
// 助理始终是同一个长寿会话（上下文由 CLI 自带压缩），每天在同一会话里写一次交接记录，见 rotation.js。
const rotation=require('./rotation');
const EVENT_KINDS=new Set(['claude','codex','deepseek','kimi']); // 这些后端答完一轮会发完成事件
const CHECKPOINT_PROMPT='【交接记录】这是每天一次的交接记录：你继续担任助理（还是这个会话），这份记录用于上下文压缩后或以后新开会话时接续。先把最近发现的用户稳定偏好或长期约定用 update_memory 记下来（已记过的不重复）。USER.md 与 MEMORY.md 也是千问快答唯一的记忆来源：确认 USER.md 里有用户的称呼、工作领域、常在城市和沟通偏好，MEMORY.md 里有常用项目与长期约定，缺的从你已知的全局规则和对话中整理补上，每条一句、具体可用，不写密钥、账号和家人下属的私人细节。然后用不超过 300 字写交接，只写接续需要的内容：1. 还没办完或在等结果的事；2. 用户最近定下的决定和偏好；3. 正在关注的任务及当前状态。不派工、不新建会话，只输出交接正文。';
const HANDOFF_PROMPT='【换班交接】你即将换班，接班的是同一位助理的新会话，它只能看到你写的交接、成长记忆和 Hub 记录。先把这一班里发现的用户稳定偏好或长期约定用 update_memory 记下来（已记过的不重复）。然后用不超过 300 字写交接，只写对接班有用的内容：1. 还没办完或在等结果的事；2. 用户最近定下的决定和偏好；3. 正在关注的任务及当前状态。不派工、不新建会话，只输出交接正文。';
class AssistantService {
  constructor(deps) {
    this.deps=deps; this.sessionViews=new Map(); this.store=new AssistantStore(path.join(deps.dataDir,'assistant'));
    this.history=new AssistantHistory(deps.historyDatabasePath||path.join(deps.dataDir,'cache','session-search-v3.sqlite'));
    this.bridge=new AssistantBridge(request=>this.invokeTool(request)); this.currentRequest=null; this.inputModes=new Map();
    this.endpointFile=path.join(deps.dataDir,'assistant','bridge-endpoint.json');
    this.snapshots=new AssistantSnapshots(deps.dataDir,this.store);
    this.dossier=new (require('./dossier').AssistantDossier)(deps.dataDir);
    this.liveHistory=new (require('./final-readers').AssistantFinalReaders)(deps);
    this.continuity=new (require('./continuity').AssistantContinuity)(path.join(deps.dataDir,'assistant'));
    this.dialog=new (require('./dialog-log').DialogLog)(path.join(deps.dataDir,'assistant'));
    this.reminders=new (require('./reminders').AssistantReminders)({store:this.store,isOwner:()=>this.ownsTimers(),onFire:r=>this.fireReminder(r),onReschedule:r=>{try{this.deps.onReminderChanged?.({action:'set',reminder:r});}catch{}}});
    // 提醒检查不能因数据库已关闭等异常把进程带崩（测试结束、Hub 退出时）。
    // 备忘清单：助理写入、用户在助理页和手机上看与改；有时间的联动到点提醒，每晚 21:00 推一次清单。
    this.memos=new (require('./memos').AssistantMemos)({store:this.store,reminders:this.reminders,isOwner:()=>this.ownsTimers(),onChange:memo=>{try{this.deps.onMemosChanged?.(memo);}catch{}},onDigest:d=>this.watches.addNotice({id:d.id,title:'备忘清单',kind:'memo-digest',label:'晚间备忘',text:d.text})});
    if(!deps.noReminderTimer)setTimeout(()=>{try{this.reminders.schedule();this.memos.schedule();}catch(e){console.warn('[assistant] reminders',e.message);}},3000).unref?.();
    this.memory=new (require('./memory').AssistantMemory)(path.join(deps.dataDir,'assistant','memory'));
    this.ledger=new (require('./ledger').AssistantLedger)(path.join(deps.dataDir,'assistant','ledger'),{read:(meta,options)=>this.liveHistory.read(meta,options)});
    this.workbench=new (require('./workbench').AssistantWorkbench)({assistant:this});
    this.secretary=new (require('./daily-secretary').DailySecretary)({assistant:this});
    if(!deps.noReminderTimer){require('./timer-owner').claimTimers(this.store);setTimeout(()=>this.secretary.schedule(),4000).unref?.();}
    this.watches=new AssistantWatches(this.store,{getSession:id=>this.sessionMetadata(id),getOpenSession:id=>this.deps.getSession(id)?this.sessionMetadata(id):null,readFinal:(meta,options)=>this.liveHistory.read(meta,options),onNotification:notice=>{try{this.logDialog({id:'notice:'+notice.id,role:'assistant',lane:'notice',by:notice.title||'提醒',text:notice.text||''});}catch{}this.deps.onAssistantNotification?.(notice);}});
  }
  sessionMetadata(id){const persisted=this.deps.getSessionMetadata?.(id),live=this.deps.getSession(id);return persisted||live?{...persisted,...live,id}:null;}
  setSessionViews({changed=[],removed=[]}={}){
    for(const id of removed)this.sessionViews.delete(id);
    for(const row of changed){
      if(!this.deps.getSession(row.id)||!row.hubState||!['run','wait','error','unread','dorm','idle','unknown'].includes(row.hubState.state))continue;
      this.sessionViews.set(row.id,row);
    }
  }
  sessions() {const all=new Map();for(const s of this.deps.listKnownSessions?.()||[]){const id=s.id||s.hubId;if(id)all.set(id,{...s,id,isOpen:false,status:'closed'});}for(const s of this.deps.getAllSessions?.()||[])all.set(s.id,{...all.get(s.id),...s,isOpen:true,sidebarView:this.sessionViews.get(s.id)});return projectSessionStates([...all.values()].filter(s=>!this.assistantIds().includes(s.id)&&s.purpose!=='hub-assistant'));}
  assistantIds(){return Object.values(backends.bindings(this.store));}
  captureContinuity(){for(const id of this.assistantIds()){const meta=this.sessionMetadata(id);if(!meta)continue;for(const row of this.liveHistory.read(meta).records)this.continuity.add({...row,provider:meta.kind,timestamp:row.timestamp||Date.now()});}}
  liveInventory(){return this.sessions().map(s=>{const result=s.isOpen?this.liveHistory.read(s):null;return{...s,nativeSessionId:nativeId(s),latestFinal:result?.records.at(-1)||null,liveIssue:result?.issue||null};});}
  get videos(){if(!this._videos)this._videos=new (require('./video-studio').VideoStudio)({assistant:this});return this._videos;}
  sessionCards(request){return require('./session-cards').sessionCards(this,request);}
  readLiveFinal(sessionId){const meta=this.sessionMetadata(sessionId);if(!meta)throw new Error('找不到原会话');const result=this.liveHistory.read(meta);return{sessionId,title:meta.title,...result};}
  // 不做固定频率的心跳：会话答完一轮由完成事件记账与提醒；换班按精确时间点（空闲 2 小时、每天 4 点）触发；
  // 每 2 小时做一次全面核对补漏；只有被关注的会话不发完成事件（千问、GLM 等）时，才每 5 分钟补查关注任务。
  startWatching({reconcileMs=2*3600000,safetyPollMs=300000,startupDelayMs=20000}={}){
    if(this.reconcileTimer)return;
    const unref=timer=>{timer?.unref?.();return timer;};
    this.startupTimer=unref(setTimeout(()=>this.scheduledReconcile(),startupDelayMs));
    this.reconcileTimer=unref(setInterval(()=>this.scheduledReconcile(),reconcileMs));
    this.safetyTimer=unref(setInterval(()=>{try{if(this.ownsAssistant()&&this.watches.list().some(w=>w.state!=='paused-closed'&&!EVENT_KINDS.has(this.sessionMetadata(w.sessionId)?.kind)))this.pollWatches();}catch{}},safetyPollMs));
    this.scheduleDaily();
  }
  // 只有当前持有助理会话的 Hub 做定时核对，多开 Hub 时不会两边同时写账本。
  ownsAssistant(){const id=this.store.get('sessionId');return !!(id&&this.deps.getSession(id));}
  // 定时任务归属：见 timer-owner.js（不要求助理会话此刻开着）。
  ownsTimers(){return require('./timer-owner').ownsTimers(this.store);}
  scheduledReconcile(){
    if(!this.ownsAssistant())return;
    try{this.reconcileLedger();this.pollWatches();this.ledger.prune();}catch(error){console.warn('[assistant] reconcile',error.message);}
    void this.maybeCheckpointInBackground().catch(error=>console.warn('[assistant] checkpoint',error.message));
  }
  scheduleDaily(){
    clearTimeout(this.dailyTimer);const next=rotation.dailyBoundary(Date.now())+86400000+30000;
    this.dailyTimer=setTimeout(()=>{void this.maybeCheckpointInBackground().catch(()=>{});this.scheduleDaily();},Math.max(1000,next-Date.now()));this.dailyTimer.unref?.();
  }
  scheduleIdleCheckpoint(lastActiveAt){
    clearTimeout(this.idleTimer);
    this.idleTimer=setTimeout(()=>{void this.maybeCheckpointInBackground().catch(error=>console.warn('[assistant] checkpoint',error.message));},Math.max(1000,lastActiveAt+rotation.IDLE_MS+60000-Date.now()));this.idleTimer.unref?.();
  }
  // 任一会话答完一轮：助理自己 → 记上下文用量并排好空闲换班；其他会话 → 立即记账，被关注则立即提醒。
  onTurnComplete(sessionId,event={}){
    const at=Number(event.completedAt)||Date.now();
    if(this.assistantIds().includes(sessionId)){this.observeUsage(sessionId,event.usage,at);this.store.set('lastActiveAt:'+sessionId,at);this.scheduleIdleCheckpoint(at);
      // 助理答完立刻让手机通道取答案推送，不等下一次定时处理。
      try{this.deps.onAssistantTurnComplete?.(sessionId);}catch{}
      this.secretary?.schedule();
      if(this._desk){setTimeout(()=>this._desk.check(),300).unref?.();}return;}
    const meta=this.sessionMetadata(sessionId);if(!meta||meta.purpose==='hub-assistant')return;
    try{this.ledger.record({...meta,id:sessionId});}catch(error){console.warn('[assistant] ledger',error.message);}
    if(this.ownsAssistant()&&this.watches.list().some(w=>w.sessionId===sessionId))this.pollWatches();
  }
  reconcileLedger(){
    const metas=this.sessions().map(s=>({...(this.sessionMetadata(s.id)||s),id:s.id,isOpen:s.isOpen}));
    return this.ledger.reconcile(metas,{groupSources:since=>readGroupHistory({dataDir:this.deps.dataDir,since,until:Date.now(),query:'',maxChars:20000,maxFiles:30,meetings:this.deps.getMeetings?.()})});
  }
  // 定时器只检查「关注的任务有没有新回复」（结果推到手机和助理页靠它）。工作台按需刷新：
  // 你每问一次、助理按需查资料或打开工作档案时才重建，平时不读写文件（2026-10-04 用户要求）。
  pollWatches(){return this.watches.poll();}
  notifications(request){return this.watches.notifications(request);}
  followedTasks(){return this.watches.list().map(({cursor,seen,...watch})=>watch);}
  observePromptReceipt(snapshot){
    if(snapshot?.status!=='confirmed'||snapshot.notSent||snapshot.contentMismatch||!snapshot.clientSubmissionId||!snapshot.sessionId)return false;
    if(snapshot.sessionId===this.currentRequest?.sessionId&&snapshot.clientSubmissionId===this.currentRequest.id)this.continuity.add({id:'user:'+snapshot.clientSubmissionId,sessionId:snapshot.sessionId,provider:this.store.get('backendKind')||'codex',role:'user',deliveryState:'confirmed',timestamp:this.currentRequest.createdAt,text:this.currentRequest.text});
    const row=this.store.db.prepare('SELECT state,result FROM actions WHERE id=?').get(snapshot.clientSubmissionId);
    if(!row||row.state!=='unknown'||!row.result)return false;
    const result=JSON.parse(row.result);if(result.sessionId!==snapshot.sessionId)return false;
    this.store.finish(snapshot.clientSubmissionId,'acknowledged',{...result,originalReceipt:result.receipt,lateReceipt:snapshot,
      receipt:{...result.receipt,ok:true,lateReconciled:true,receipt:{...result.receipt?.receipt,...snapshot,status:'confirmed'}}});return true;
  }
  followTask({sessionId}){if(this.assistantIds().includes(sessionId)||this.sessionMetadata(sessionId)?.purpose==='hub-assistant')throw new Error('助理不能关注自身回复');return{ok:true,watch:this.watches.follow(sessionId)};}
  overview() {
    const sessionId=this.store.get('sessionId'),session=sessionId?this.deps.getSession(sessionId):null,lastContext=this.store.get('lastContext');
    const runtime=session?.cliRuntime||session?.nativeRuntime,issue=runtime?.connection==='disconnected'?runtime.reason||'原生后端连接中断':null;
    return{ok:true,sessionId,backendKind:this.store.get('backendKind')||'codex',profile:this.currentProfile(),context:this.contextStatus(),backends:backends.BACKENDS,backendSessions:backends.bindings(this.store),available:!!session,submissionPending:!!this.deps.hasPendingPrompt?.(sessionId),status:session?.status||'not-created',summary:'',connectionSummary:issue?'助理后端未连接：'+issue:session?'助理会话已打开；账号可用性和执行结果以原生回执为准。':'首次启用后，助理作为独立会话运行，可选择 Hub 支持的后端并连接专属工具。',toolConfiguration:'助理专用 lean 配置，连接 Hub 助理工具；普通会话配置保持不变。',needsAttention:issue?[issue]:[],updatedAt:lastContext?.asOf||null,contextCoverage:lastContext,actions:this.store.list(),followedTasks:this.followedTasks(),watchableSessions:this.sessions().map(s=>({id:s.id,title:s.title||s.name,kind:s.kind,status:s.status,isOpen:s.isOpen})),...this.notifications({limit:10})};
  }
  async ensureSession() {
    if(this.creating)return this.creating;
    if(this.switching)throw new Error('助理正在切换后端，请稍候');
    // 迁移与创建放在同一个 creating 里串行，并发的就绪请求只会得到同一个助理。
    this.creating=(async()=>{
      if(this.store.get('assistantDefaultsVersion')!==2){const migrated=await this.migrateDefaults();if(migrated)return migrated;}
      return this._ensureSession(this.activeKind());
    })();
    try{return await this.creating;}finally{this.creating=null;}
  }
  activeKind(){return this.store.get('backendKind')||profiles.ASSISTANT_DEFAULT_KIND;}
  // 每轮结束时记下助理上下文用量（来自 CLI 原生记录的 usage）、最后活动时间，并记一行速度日志供校准阈值。
  observeUsage(sessionId,usage,completedAt=Date.now()){
    if(!usage||!this.assistantIds().includes(sessionId))return null;
    const meta=this.sessionMetadata(sessionId),kind=meta?.kind;
    const tokens=require('../ai-kinds').isCodexCliKind(kind)?Number(usage.input_tokens)||0
      :(Number(usage.input_tokens)||0)+(Number(usage.cache_read_input_tokens)||0)+(Number(usage.cache_creation_input_tokens)||0);
    this.store.set('contextTokens:'+sessionId,tokens);this.store.set('lastActiveAt:'+sessionId,completedAt);
    const request=this.currentRequest,ms=request&&request.sessionId===sessionId?Math.max(0,completedAt-request.createdAt):null;
    this.recordMetric({at:completedAt,sessionId,kind,model:require('../session-capabilities').sessionModelId(meta),effort:meta?.effort||null,tokens,ms});
    return tokens;
  }
  recordMetric(row){
    try{const file=path.join(this.deps.dataDir,'assistant','turn-metrics.jsonl');
      if(fs.existsSync(file)&&fs.statSync(file).size>2*1024*1024)fs.renameSync(file,file.replace(/\.jsonl$/,'.1.jsonl'));
      fs.appendFileSync(file,JSON.stringify(row)+'\n');}catch(error){console.warn('[assistant] metrics',error.message);}
  }
  checkpointReasonFor(id){
    return rotation.checkpointReason({tokens:this.store.get('contextTokens:'+id),lastActiveAt:this.store.get('lastActiveAt:'+id),lastCheckpointAt:this.store.get('lastCheckpointAt:'+id)||0});
  }
  contextStatus(){
    const kind=this.activeKind(),id=backends.bindings(this.store)[kind],meta=id?this.sessionMetadata(id):null;
    return{tokens:id?this.store.get('contextTokens:'+id):null,cap:meta?.contextMax||null,lastActiveAt:id?this.store.get('lastActiveAt:'+id):null,
      checkpointDue:id?this.checkpointReasonFor(id):null,lastCheckpoint:this.store.get('lastCheckpoint'),lastRotation:this.store.get('lastRotation')};
  }
  // 每天一次交接记录：只对已打开且空闲的助理进行，在同一会话里复盘并写交接，不换会话。
  async maybeCheckpointInBackground(){
    if(this.creating||this.switching||this.checkpointing||this.store.get('assistantDefaultsVersion')!==2)return null;
    const kind=this.activeKind(),id=backends.bindings(this.store)[kind],session=id&&this.deps.getSession(id);
    if(!session)return null;
    if(require('../session-runtime-truth').sessionRuntimeIsActive(session)||['running','waiting'].includes(session.status)||this.deps.hasPendingPrompt?.(id))return null;
    const reason=this.checkpointReasonFor(id);if(!reason)return null;
    this.checkpointing=true;
    try{
      const since=this.store.get('lastReviewAt')||Date.now()-86400000;
      const text=await this.writeHandoff(kind,id,this.reviewPrompt(since,CHECKPOINT_PROMPT),420000,'【交接记录】');
      const now=Date.now();this.store.set('lastCheckpointAt:'+id,now);
      if(text){this.store.set('lastReviewDay',require('./ledger').localDay(now));this.store.set('lastReviewAt',now);}
      this.store.set('lastCheckpoint',{at:now,kind,reason,reasonLabel:rotation.REASON_LABELS[reason]||reason,sessionId:id,ok:!!text});
      return{ok:!!text,sessionId:id,reason};
    }finally{this.checkpointing=false;}
  }
  // 手动新开助理（用户在「···」里点）：先让旧助理写交接再换新会话；与就绪请求共用 creating，互不打架。
  async maybeRotateInBackground({reason:forced}={}){
    if(this.creating||this.switching||this.store.get('assistantDefaultsVersion')!==2)return null;
    const kind=this.activeKind(),id=backends.bindings(this.store)[kind];
    if(!id||!this.deps.getSession(id))return null;
    const reason=forced;if(!reason)return null;
    this.creating=(async()=>{const rotated=await this.rotate(kind,id,{reason,handoff:true});return rotated||this._ensureSession(kind);})();
    try{return await this.creating;}finally{this.creating=null;}
  }
  rotateNow(){
    if(this.creating||this.switching)throw new Error('助理正在连接或切换，请稍候');
    const id=backends.bindings(this.store)[this.activeKind()],session=id&&this.deps.getSession(id);
    if(!session)throw new Error('助理尚未打开，下次打开时会直接用新会话');
    if(require('../session-runtime-truth').sessionRuntimeIsActive(session)||['running','waiting'].includes(session.status)||this.deps.hasPendingPrompt?.(id))throw new Error('助理正在回答，请等本轮结束后再新开');
    return this.maybeRotateInBackground({reason:'manual'});
  }
  // 当天第一次换班时顺带复盘：主动记住用户没明说的稳定偏好，并参考两家 CLI 自带记忆当天的更新。
  reviewPrompt(sinceMs,base=HANDOFF_PROMPT){
    const files=this.nativeMemoryUpdates(sinceMs);
    return base+'在写交接之前先做今天的复盘：① 回顾今天和用户的交流，他没说「记住」但已明确表态或反复体现的偏好与约定，用 update_memory 记下；与旧条目矛盾的更新，重复的合并，只出现一次的推测不记。'
      +(files.length?'② 下面是今天更新过的 CLI 自带记忆（只在各自的 CLI 里自动生效），读一下，把与用户合作方式相关、稳定有价值的内容同步进 USER.md / MEMORY.md：'+files.join('；')+'。':'② 今天两家 CLI 自带记忆没有相关更新。');
  }
  // Claude Code 自动记忆目录里 user/feedback 类条目、Codex 记忆摘要，取 since 之后改过的。
  nativeMemoryUpdates(sinceMs){
    const os=require('node:os'),home=os.homedir(),files=[];
    const roots=this.deps.nativeMemoryRoots||(()=>{
      const list=[];
      try{const settings=JSON.parse(fs.readFileSync(path.join(process.env.CLAUDE_CONFIG_DIR||path.join(home,'.claude'),'settings.json'),'utf8'));if(settings.autoMemoryDirectory)list.push({kind:'claude',dir:settings.autoMemoryDirectory});}catch{}
      for(const codexHome of [process.env.CODEX_HOME||path.join(home,'.codex'),...(()=>{try{return fs.readdirSync(path.join(home,'.codex-profiles')).map(name=>path.join(home,'.codex-profiles',name));}catch{return[];}})()])list.push({kind:'codex',dir:path.join(codexHome,'memories')});
      return list;
    })();
    for(const root of roots){
      try{
        if(root.kind==='codex'){const file=path.join(root.dir,'memory_summary.md');if(fs.existsSync(file)&&fs.statSync(file).mtimeMs>sinceMs)files.push(file);continue;}
        const realRoot=fs.realpathSync(root.dir);
        for(const name of fs.readdirSync(realRoot)){
          // 只列根目录下名字规整的 .md，且真实路径仍在该目录内（不跟随指向别处的链接）。
          if(!/^[\w.-]+\.md$/.test(name))continue;const file=fs.realpathSync(path.join(realRoot,name));if(path.dirname(file)!==realRoot)continue;const stat=fs.statSync(file);
          if(stat.mtimeMs<=sinceMs)continue;
          const head=fs.readFileSync(file,'utf8').slice(0,600);if(/^\s*type:\s*(user|feedback)\s*$/m.test(head))files.push(file);
        }
      }catch{}
    }
    return files.slice(0,12);
  }
  // 让旧助理写一段交接，写进交接记录（最长等 3 分钟；拿不到就只靠原始记录接续）。
  async writeHandoff(kind,oldId,prompt=HANDOFF_PROMPT,timeoutMs=180000,label='【上一班交接】'){
    const requestId='handoff-'+randomUUID();
    try{const receipt=await this.deps.sendPrompt(oldId,prompt,requestId);if(receipt?.ok===false)return null;}catch(error){console.warn('[assistant] handoff not sent',error.message);return null;}
    for(const end=Date.now()+timeoutMs;Date.now()<end;await new Promise(r=>setTimeout(r,1500))){
      const meta=this.sessionMetadata(oldId);if(!meta)return null;
      const hit=this.liveHistory.read(meta).records.find(row=>row.clientSubmissionId===requestId);
      if(hit?.text){
        this.continuity.add({id:'handoff:'+requestId,sessionId:oldId,provider:kind,role:'assistant',timestamp:Date.now(),text:label+hit.text.trim()});
        // 等这轮在 CLI 里收尾，再休眠旧会话。
        for(const settle=Date.now()+15000;Date.now()<settle;await new Promise(r=>setTimeout(r,500))){const s=this.deps.getSession(oldId);if(!s||!(require('../session-runtime-truth').sessionRuntimeIsActive(s)||['running','waiting'].includes(s.status)))break;}
        return hit.text;
      }
    }
    return null;
  }
  // 换班：同一后端、同一档位新开助理会话，靠交接记录（assistantContinuity 与工作档案）接续；旧会话休眠保留可查。
  async rotate(kind,oldId,{reason='size',handoff=false}={}){
    const old=this.deps.getSession(oldId);
    if(old&&(require('../session-runtime-truth').sessionRuntimeIsActive(old)||['running','waiting'].includes(old.status)||this.deps.hasPendingPrompt?.(oldId)))return null;
    const today=require('./ledger').localDay(Date.now()),review=handoff&&old&&this.store.get('lastReviewDay')!==today;
    // 复盘窗口从上次复盘算起（隔了几天也不漏），复盘比普通交接多给时间。
    const handoffText=handoff&&old?await this.writeHandoff(kind,oldId,review?this.reviewPrompt(this.store.get('lastReviewAt')||Date.now()-86400000):HANDOFF_PROMPT,review?420000:180000):null;
    if(review&&handoffText){this.store.set('lastReviewDay',today);this.store.set('lastReviewAt',Date.now());}
    // 交接超时而旧助理还在跑：这次不换班，等它空下来再说，避免把正在干活的会话休眠掉。
    const stillBusy=s=>s&&(require('../session-runtime-truth').sessionRuntimeIsActive(s)||['running','waiting'].includes(s.status)||this.deps.hasPendingPrompt?.(s.id));
    if(handoff&&old&&stillBusy(this.deps.getSession(oldId)))return null;
    this.captureContinuity();
    backends.retire(this.store,kind,oldId);this.store.set('rotateDue:'+kind,null);
    let result;
    try{result=await this._ensureSession(kind);}catch(error){backends.unretire(this.store,kind,oldId);throw error;}
    if(!result.ok){backends.unretire(this.store,kind,oldId);return null;}
    this.currentRequest=null;this.store.set('lastContext',null);
    this.store.set('lastRotation',{at:Date.now(),kind,reason,reasonLabel:rotation.REASON_LABELS[reason]||reason,oldId,sessionId:result.sessionId,tokens:this.store.get('contextTokens:'+oldId),handoff:!!handoffText});
    console.log('[assistant] rotated',kind,reason,oldId,'->',result.sessionId,'context',this.store.get('contextTokens:'+oldId),'handoff',!!handoffText);
    try{await this.deps.retireSession?.(oldId);}catch(error){console.warn('[assistant] retire old session',error.message);}
    this.deps.onAssistantRotated?.({kind,oldId,sessionId:result.sessionId});
    return result;
  }
  // 2026-10-03：助理默认改为快速档（Sonnet 5.5 · 低思考）。旧数据只迁移一次，之后完全按用户选择。
  // 老用户走正规的后端切换：助理忙时推迟到下次空闲；切换失败就留在原后端并不再重试。
  async migrateDefaults(){
    const kind=profiles.ASSISTANT_DEFAULT_KIND,previous=this.store.get('backendKind'),currentId=this.store.get('sessionId');
    const markProfile=()=>{this.store.set('profile:'+kind,profiles.ASSISTANT_DEFAULTS[kind]);this.store.set('profilePending:'+kind,true);};
    if(!currentId||previous===kind||!previous){markProfile();this.store.set('backendKind',kind);this.store.set('assistantDefaultsVersion',2);return null;}
    const current=this.deps.getSession(currentId);
    if(current&&(require('../session-runtime-truth').sessionRuntimeIsActive(current)||['running','waiting'].includes(current.status)||this.deps.hasPendingPrompt?.(currentId)))return null;
    const before={profile:this.store.get('profile:'+kind),pending:!!this.store.get('profilePending:'+kind)};
    markProfile();this.store.set('assistantDefaultsVersion',2);
    try{const result=await this.switchUnguarded(kind);if(result.ok)return result;}catch(error){console.warn('[assistant] default migration kept',previous,error.message);}
    this.store.set('profile:'+kind,before.profile);this.store.set('profilePending:'+kind,before.pending);
    return null;
  }
  currentProfile(){
    const kind=this.activeKind();
    const id=backends.bindings(this.store)[kind],live=id?this.deps.getSession(id):null,saved=this.store.get('profile:'+kind)||profiles.ASSISTANT_DEFAULTS[kind]||{};
    const {sessionModelId}=require('../session-capabilities');
    const pending=!!this.store.get('profilePending:'+kind);
    const model=(!pending&&live&&sessionModelId(live))||saved.model||sessionModelId(live)||null;
    return{...profiles.describe(kind,model,(!pending&&live?.effort)||saved.effort||null),pending};
  }
  // 切换助理的后端、模型或思考深度。设置先保存；助理空闲时立即按新模型重启原会话（保留历史），忙时等下一次就绪再生效。
  async setProfile({kind,model,effort}={}){
    backends.backendKind(kind);
    const defaults=await this.deps.getDefaults?.(kind)||{};
    const picked=profiles.pick(kind,{model,effort},{...defaults,...(profiles.ASSISTANT_DEFAULTS[kind]||{})});
    this.store.set('assistantDefaultsVersion',2); // 用户亲自选择后不再做默认迁移
    const previous={profile:this.store.get('profile:'+kind),pending:!!this.store.get('profilePending:'+kind)};
    const restore=()=>{this.store.set('profile:'+kind,previous.profile);this.store.set('profilePending:'+kind,previous.pending);};
    this.store.set('profile:'+kind,picked);this.store.set('profilePending:'+kind,true);this.profileError=null;
    // 换后端失败（例如助理正在回答）时撤回本次设置，避免之后悄悄生效。
    let result;try{result=kind!==this.store.get('backendKind')?await this.switchBackend({kind}):await this.ensureSession();}catch(error){restore();throw error;}
    if(!result.ok){restore();return result;}
    if(this.profileError){const error=this.profileError;this.profileError=null;return{ok:false,error,profile:this.currentProfile()};}
    return{ok:true,profile:this.currentProfile()};
  }
  // 快速通道用：最近几轮对话（给追问用上下文），以及把快速通道的问答记进交接记录，完整助理也知道。
  recentHistory(){return this.continuity.records.slice(-6).map(row=>({role:row.role,text:row.text}));}
  recordFastLane({id,question,answer,model}){
    const at=Date.now();
    this.continuity.add({id:'user:'+id,sessionId:'fast-lane',provider:'fast-lane',role:'user',deliveryState:'confirmed',timestamp:at-1,text:question});
    this.continuity.add({id:'fast:'+id,sessionId:'fast-lane',provider:'fast-lane:'+(model||''),role:'assistant',timestamp:at,text:answer});
  }
  // 手机消息的回答方式：api＝前台快答（默认），cli＝每条交给助理会话。设置保存后立即生效，手机与电脑面板同步。
  frontDesk(){return require('./front-desk').describe(this.store.get('frontDesk'),{legacyDisabled:this.store.get('fastLaneDisabled')===true});}
  setFrontDesk(input={}){
    const fd=require('./front-desk'),picked=fd.validate(input),before=this.frontDesk();
    this.store.set('frontDesk',{mode:picked.mode,model:picked.model||before.model});
    const after=this.frontDesk();try{this.deps.onFrontDeskChanged?.(after);}catch{}
    return{ok:true,frontDesk:after};
  }
  fastLaneDisabled(){return this.frontDesk().mode==='cli';}
  // 快答用的 Hub 只读状态摘要（会话、最近结果、关注、待提醒）。
  // 会话是否在干活：PTY 会话以 CLI hook 报告的本轮为准（列表里的 status 对它们常显示空闲），再看原生运行态与待核对的提交。
  sessionBusy(id){const s=this.sessions().find(x=>x.id===id);if(!s?.isOpen)return false;return !!this.deps.isAgentTurnActive?.(id)||require('../session-runtime-truth').sessionRuntimeIsActive(s)||['running','waiting'].includes(s.status)||!!this.deps.hasPendingPrompt?.(id);}
  statusDigest(){
    try{return require('./status-digest').buildStatusDigest({sessions:this.sessions().map(x=>x.isOpen&&x.status!=='waiting'&&this.sessionBusy(x.id)?{...x,status:'running'}:x),ledger:this.ledger.entries(),followed:this.followedTasks(),reminders:this.reminders.list()});}
    catch(e){console.warn('[assistant] status digest',e.message);return '';}
  }
  // 到点提醒：走与关注提醒相同的通道（手机、电脑提示、助理页对话），并标明是否补发。
  fireReminder(r){
    try{this.memos?.reminderFired(r);}catch{}
    const late=r.late?'（原定 '+new Date(r.at).toLocaleTimeString('zh-CN',{timeZone:'Asia/Shanghai',hour:'2-digit',minute:'2-digit',hour12:false})+'，Hub 当时没开，现在补上）':'';
    this.watches.addNotice({id:'reminder:'+r.id,title:'提醒',kind:'reminder',label:'到点提醒',text:'用户，到点了：'+r.text+late});
  }
  // 备忘：写入与改动都在这里同步手机闹钟（联动的到点提醒）。原话取用户本轮消息原文，来源看对话记录。
  addMemo(input){const memo=this.memos.add(input);if(memo.reminderId)this.syncReminder('set',memo.reminderId);return memo;}
  memoAction(ref,change){const before=this.memos.find(ref).reminderId;const r=this.memos.update(ref,change);if(r.reminderCancelled)try{this.deps.onReminderChanged?.({action:'cancel',reminder:r.reminderCancelled});}catch{}if(r.reminderSet)this.syncReminder('set',r.reminderSet);void before;return r;}
  memoView(){return{ok:true,...this.memos.view()};}
  syncReminder(action,id){const reminder=this.reminders.list().find(x=>x.id===id);if(reminder)try{this.deps.onReminderChanged?.({action,reminder});}catch{}}
  requestSource(id){try{const row=this.dialog.recent({limit:80}).reverse().find(e=>e.role==='user'&&e.id===id);if(row)return(row.source==='hub'?'电脑':'手机')+(row.input==='voice'?'语音':'');}catch{}return this.inputModes?.get(id)==='voice'?'语音':'';}
  // 资料口播：用户主动提出才做（2026-10-06）。拆章、写稿、合成都在后台，做完发一条提醒。
  get podcasts(){
    if(!this._podcasts&&this.deps.podcast){const {PodcastStudio}=require('./podcast/studio');
      this._podcasts=new PodcastStudio({dataDir:this.deps.dataDir,...this.deps.podcast,listener:()=>{const m=this.memory?.read?.()||{};return[m.user,m.memory].filter(Boolean).join('\n');},onChange:()=>{try{this.deps.onPodcastsChanged?.();}catch{}},onDone:m=>this.podcastDone(m)});}
    return this._podcasts||null;
  }
  podcastDone(m){
    // 每日一档不单独推「做好了」：08:00 的计划通知里已带上它，避免一早连响几次。
    if(m.source==='daily-secretary')return;
    const done=m.episodes.filter(e=>e.status==='done'),failed=m.episodes.filter(e=>e.status==='failed').length,mins=Math.round(done.reduce((s,e)=>s+(e.seconds||0),0)/60);
    const text=done.length?`用户，《${m.title}》的口播做好了：${done.length} 集，约 ${mins} 分钟${failed?`（另有 ${failed} 集没做成，可以让我重做）`:''}。手机左侧菜单「资料口播」里可以听，也能看阅读版。`:`用户，《${m.title}》的口播没做成：${m.error||m.episodes.find(e=>e.error)?.error||'原因未知'}`;
    this.watches.addNotice({id:'podcast:'+m.id,title:'口播',kind:'podcast',label:'资料口播',text});
  }
  podcastSource(file){
    const p=require('node:path'),os=require('node:os'),abs=p.resolve(String(file||''));
    const roots=require('../storage-roots').trustedFileRoots({dataDir:this.deps.dataDir,home:os.homedir()}).map(r=>p.resolve(r).toLowerCase()+p.sep);
    if(!roots.some(r=>abs.toLowerCase().startsWith(r)))throw new Error('只能把工作区（含旧工作根）、产物目录（AI-Artifacts）或 Hub 数据目录里的资料做成口播');
    if(!/\.(html?|md|txt)$/i.test(abs))throw new Error('目前支持 HTML 和 Markdown 资料');
    return abs;
  }
  // 手机对话记录：写入后推给助理 Tab 实时显示。
  logDialog(entry){const row=this.dialog.append(entry);try{this.deps.onDialogEntry?.(row);}catch{}return row;}
  dialogLog({limit}={}){return{ok:true,entries:this.dialog.recent({limit}),desk:this.desk?.busy()||null};}
  // 电脑上对助理说的话（助理 Tab 输入框），与手机同一套回答方式。
  get desk(){if(!this._desk)this._desk=new (require('./desk').AssistantDesk)({assistant:this,fastLane:this.deps.fastLane||null});return this._desk;}
  ask({text,to,again}={}){return this.desk.ask(text,{to,again});}
  // 助理页右侧「助理状态」：会话、上下文用量、记忆、关注的任务。
  pageStatus(){
    const ctx=this.contextStatus(),o=this.overview(),mem=this.memory,fs=require('node:fs');
    const files=['user','memory'].map(kind=>{let entries=[],updatedAt=null;try{entries=mem.entries(kind);updatedAt=fs.statSync(mem.file(kind)).mtimeMs;}catch{}return{kind,count:entries.length,updatedAt,recent:entries.slice(-3).reverse().map(e=>e.replace(/^- /,'').slice(0,80))};});
    return{ok:true,session:{label:this.assistantLabel(),status:o.status,available:o.available},context:{tokens:ctx.tokens||null,cap:ctx.cap||null,lastActiveAt:ctx.lastActiveAt||null,lastRotation:ctx.lastRotation?{at:ctx.lastRotation.at,reason:ctx.lastRotation.reasonLabel||ctx.lastRotation.reason}:null},
      memory:files,memos:this.memos.openList().length,reminders:this.reminders.upcoming().slice(0,5).map(r=>({id:r.id,at:r.at,text:r.text})),followed:this.followedTasks().map(w=>({title:w.title,state:w.state||null,updatedAt:w.updatedAt||null})).slice(0,8),frontDesk:this.frontDesk()};
  }
  assistantLabel(){const p=this.currentProfile();let kind=p.kind;try{kind=require('../ai-kinds').getKindLabel(p.kind);}catch{}return[kind,p.label].filter(Boolean).join(' · ');}
  // 手机端选择面板的数据：当前助理设置 + 各后端可选型号与深度（手机不内置型号表）。
  async phoneProfile(){
    const defaults={};for(const kind of backends.BACKENDS)defaults[kind]=await this.deps.getDefaults?.(kind)||{};
    return{current:this.currentProfile(),kinds:profiles.phoneCatalog(backends.BACKENDS,kind=>defaults[kind]),frontDesk:require('./front-desk').catalog(this.frontDesk())};
  }
  async applyProfile(kind,id){
    if(!this.store.get('profilePending:'+kind))return;
    const want=this.store.get('profile:'+kind),session=this.deps.getSession(id);
    if(!want||!session)return;
    const {sessionModelId}=require('../session-capabilities');
    if(sessionModelId(session)===want.model&&(session.effort||null)===(want.effort||null)){this.store.set('profilePending:'+kind,false);return;}
    const busy=require('../session-runtime-truth').sessionRuntimeIsActive(session)||['running','waiting'].includes(session.status)||this.deps.hasPendingPrompt?.(id);
    if(busy||!this.deps.restartSession){console.log('[assistant] profile deferred',kind,id,JSON.stringify({status:session.status,runtimeActive:require('../session-runtime-truth').sessionRuntimeIsActive(session),pendingPrompt:!!this.deps.hasPendingPrompt?.(id),cliRuntime:session.cliRuntime?.state,restart:!!this.deps.restartSession}));return;}
    console.log('[assistant] profile restart',kind,id,sessionModelId(session),'->',want.model,want.effort);
    const defaults=await this.deps.getDefaults?.(kind)||{};
    const opts=profiles.withModel(kind,{...defaults,model:sessionModelId(session)},want);
    const result=await this.deps.restartSession(id,{model:want.model,effort:want.effort||null,...(typeof opts.contextMax==='number'?{contextMax:opts.contextMax}:{})});
    // 重启失败不能卡住后续消息：记录原因、把设置还原为实际在跑的型号，由 setProfile 如实回报。
    if(!result||result.ok===false){
      this.store.set('profile:'+kind,{model:sessionModelId(session),effort:session.effort||null});
      this.profileError='助理按新模型重启失败：'+(result?.message||'未知原因')+'；原会话和历史已保留';
    }
    this.store.set('profilePending:'+kind,false);
  }
  async switchBackend({kind}={}) {
    backends.backendKind(kind);
    if(this.switching||this.creating)throw new Error('助理正在连接或切换，请稍候');
    return this.switchUnguarded(kind);
  }
  async switchUnguarded(kind){
    const current=this.deps.getSession(this.store.get('sessionId'));
    if(current&&this.deps.hasPendingPrompt?.(current.id))throw new Error('助理上一条消息的提交仍在核对，请稍候切换；原会话和草稿已保留');
    if(current&&(require('../session-runtime-truth').sessionRuntimeIsActive(current)||['running','waiting'].includes(current.status)))throw new Error('助理正在处理请求或等待响应，请先结束当前回合；原会话和草稿已保留');
    this.captureContinuity();
    this.switching=this._ensureSession(kind);
    try {const result=await this.switching;if(result.ok){this.currentRequest=null;this.store.set('lastContext',null);}return result;}
    finally{this.switching=null;}
  }
  async _ensureSession(kind) {
    const old=backends.bindings(this.store)[kind];
    const finish=async(session,id)=>{
      if(session.id!==id||session.purpose!=='hub-assistant'||session.kind!==kind)throw new Error('助理返回的会话编号或后端与预留身份不一致，需核对创建结果');
      await this.connectBridge();backends.activate(this.store,kind,id);
      await this.applyProfile(kind,id);
      return{ok:true,sessionId:id,backendKind:kind,session:this.deps.getSession(id)||session};
    };
    if(old){const session=this.deps.getSession(old);if(session)return finish(session,old);
      // A reserved launch can have succeeded even when its receipt was lost.
      if(this.deps.resumeSession){const want=this.store.get('profilePending:'+kind)&&this.store.get('profile:'+kind);const session=await this.deps.resumeSession(old,this.getLaunchOptions(kind,old),want?{model:want.model,effort:want.effort||null}:undefined);if(session)return finish(session,old);}
      const pending=(this.store.get('backendCreation:'+kind)||this.store.get('assistantCreation'))?.state==='reserved';
      return{ok:false,sessionId:old,needsReconciliation:pending,error:pending?'上次助理创建结果未确认；已保留原编号，需核对该实体后恢复。':'助理原会话未打开，请从历史恢复该会话。'};
    }
    const hubDefaults=await this.deps.getDefaults?.(kind)||{};
    const defaults=profiles.withModel(kind,hubDefaults,profiles.assistantProfile(kind,this.store.get('profile:'+kind),hubDefaults));
    const id=randomUUID();backends.reserve(this.store,kind,id);
    await this.connectBridge();
    this.store.set('profilePending:'+kind,false);
    const session=await this.deps.createSession(kind,{...defaults,id,title:'AI Hub 助理 · '+backends.getKindLabel(kind),name:'AI Hub 助理',purpose:'hub-assistant',...this.getLaunchOptions(kind,id)});
    return finish(session,id);
  }
  getLaunchOptions(kind,id){return backends.launchOptions(this,backends.backendKind(kind),id);}
  async connectBridge(){await this.bridge.start();const temporary=this.endpointFile+'.'+process.pid+'.tmp';fs.writeFileSync(temporary,JSON.stringify({url:this.bridge.url,token:this.bridge.secret}),{mode:0o600});fs.renameSync(temporary,this.endpointFile);}
  getMcpEntry(sessionId=this.store.get('sessionId')){return{name:'hub_assistant',command:this.deps.nodeExecutable||'node',args:[path.resolve(__dirname,'../../scripts/assistant-mcp.js')],env:{HUB_ASSISTANT_ENDPOINT_FILE:this.endpointFile,HUB_ASSISTANT_SESSION_ID:sessionId||''},toolApprovalModes:{list_sessions:'approve',history_context:'approve',session_evidence:'approve',watch_session:'approve',send_session:'approve',create_session:'approve',update_memory:'approve'},toolOutputTokenLimits:{history_context:50000,session_evidence:50000}};}
  isAssistantSession(sessionId){return isAssistantSession(this.store,sessionId,this.deps.getSession(sessionId));}
  // 已换班的旧助理可以打开查看历史；它不再是固定助理，会话管理工具在每次调用时都会被拒绝。
  requireAssistantResume(meta){if(meta?.hubId&&(this.store.get('retiredAssistants')||[]).some(r=>r.id===meta.hubId&&r.kind===meta.kind))return;if(!meta?.hubId||!this.assistantIds().includes(meta.hubId)||(meta.kind&&backends.bindings(this.store)[meta.kind]!==meta.hubId))throw new Error('恢复实体不是固定助理，未授予专属工具');}
  context(request={}) {
    const sessionId=this.store.get('sessionId'),session=this.deps.getSession(sessionId);
    // 提问时先增量补齐账本（每个会话从上次读到的位置往后读），保证两次提问之间的答复一条不漏。
    try{this.reconcileLedger();}catch(error){console.warn('[assistant] ledger catch-up',error.message);}
    const board=this.refreshDossier();
    // Retrieval budgets limit supplemental historical excerpts, never which
    // current sessions the assistant can see or manage.
    const naturalBudget=Number(request.maxChars)||Math.max(6000,board.openedCount*1200);
    const natural=this.history.context({...request,maxChars:naturalBudget,excludeSessionId:sessionId,excludeNativeSessionId:nativeId(session),excludeSessionIds:this.assistantIds(),excludeNativeSessionIds:this.assistantIds().map(id=>nativeId(this.sessionMetadata(id))).filter(Boolean)});
    const groups=readGroupHistory({dataDir:this.deps.dataDir,since:request.query?undefined:(natural.since??request.from??((request.now||Date.now())-(request.hours||3)*3600000)),until:natural.until||natural.asOf,
      query:request.query||'',maxChars:Math.max(6000,board.openedCount*400),maxFiles:30,meetings:this.deps.getMeetings?.()});
    const {sources:groupSources,...groupCoverage}=groups;
    const groupChars=groupSources.reduce((n,s)=>n+s.text.length,0);
    const sources=[...board.sources.map(source=>({...source,timeScope:'当前原生最终答复快照；以该条timestamp为准，不代表它发生在历史检索窗口内'})),...natural.sources.filter(source=>!board.sources.some(live=>live.sessionId===source.sessionId&&source.role==='assistant'&&live.text===source.text)),...groups.sources];
    return {...natural,assistantContinuity:this.continuity.packet(),assistantMemory:this.memory.packet(),workLedger:this.ledger.since(this.store.get('lastAskAt')||Date.now()-86400000),asOf:Date.now(),available:natural.available||sources.length>0,sources,
      selectedChars:sources.reduce((n,source)=>n+source.text.length,0),groupSelectedChars:groupChars,
      workbench:{revision:board.revision,mode:board.mode,markdownPath:board.markdownPath,markdown:board.markdown,
        inventory:board.openedInventory,activeCount:board.activeCount,openedCount:board.openedCount,unreadCount:board.unreadCount,needsInputCount:board.needsInputCount,knownCount:board.knownCount,timeMeaning:'这是当前工作台状态；历史变化请结合每条来源时间及请求窗口，不能把旧最终答复说成刚发生的变化。',
        catalogPath:path.join(this.dossier.directory,'ALL-SESSIONS.md'),allActiveSessionsIncluded:true,
        revisions:Object.fromEntries(board.openedInventory.map(row=>[row.id,row.revision])),
        changedSessionIds:board.changedSessionIds.filter(id=>board.openedInventory.some(row=>row.id===id)),removedSessionIds:board.removedSessionIds,
        baselineMeaning:board.baselineMeaning,fullReplyChars:board.fullReplyChars},
      truncated:natural.truncated||groups.truncated||board.sources.some(source=>source.truncated),coverage:{singleSessions:natural.coverage,groups:groups.coverage,
        currentSessions:`当前已打开的 ${board.openedCount} 个其他会话全部列出，其中活跃 ${board.activeCount} 个。最新原生答复变化优先提供；长正文可按来源读取，历史片段预算不会排除受管理会话。`,
        groupTimeMeaning:'群聊材料的文件修改时间只证明文件被观察到变化，不证明任务在该时刻完成。'},groupFileCoverage:groupCoverage};
  }
  refreshDossier(){const id=this.store.get('sessionId'),assistant=this.deps.getSession(id);if(id&&!assistant)throw new Error('助理原会话尚未在本窗口打开，工作档案保留原版本');this.captureContinuity();return this.dossier.publish(this.liveInventory(),`${id||''}:${nativeId(assistant)||''}:${assistant?.codexProfile||assistant?.kind||''}`);}
  preparePrompt(request) {
    if(this.switching)throw new Error('助理正在切换后端，请稍候；草稿已保留');
    if(!request||String(request.text||'').trimStart().startsWith('/'))return request;
    const envelope=require('../assistant-context-display').assistantContextDisplay(request.text,'hub-assistant');
    if(envelope)request={...request,text:envelope.userText};
    const active=this.deps.getSession(this.store.get('sessionId'));
    if(request.sessionId!==undefined&&!this.isAssistantSession(request.sessionId))throw new Error('请求不是固定助理会话，消息未发送');
    if(active&&(require('../session-runtime-truth').sessionRuntimeIsActive(active)||active.status==='running'))throw new Error('助理正在处理上一条请求，请等本轮结束后发送；草稿已保留');
    const context=this.context({...resolveTimeRange(request.text,{hours:request.hours,timeZone:this.deps.timeZone}),query:request.historyQuery||''});
    // 账本增量在助理真正读取本轮资料时才算送达（见 history_context），闲聊不读资料就保留到下次。
    const id=request.clientSubmissionId||request.requestId||randomUUID();
    this.currentRequest={id,sessionId:request.sessionId,text:request.text,token:randomUUID(),createdAt:Date.now()};
    if(request.sessionId)this.continuity.add({id:'user:'+id,sessionId:request.sessionId,provider:active?.kind||'codex',role:'user',deliveryState:'prepared',timestamp:this.currentRequest.createdAt,text:request.text});
    const manifest=this.snapshots.save({requestId:id,requestToken:this.currentRequest.token,packet:context});
    // Claude 的成长记忆在系统提示里；其他后端在新会话第一轮读一次资料包里的 assistantMemory，之后全程遵守。
    const turns=(this.store.get('turns:'+request.sessionId)||0);if(request.sessionId)this.store.set('turns:'+request.sessionId,turns+1);
    const text=buildBootstrapPrompt(request.text,{...manifest,clientSubmissionId:id},this.sessions().length,active?.kind||'codex',{inputMode:this.inputModes.get(id)||'text',readMemory:turns===0&&(active?.kind||'codex')!=='claude'});
    this.store.set('lastContext',{asOf:context.asOf,selectedChars:context.selectedChars,sources:context.sources.length,truncated:context.truncated,
      workbenchPath:context.workbench.markdownPath,workbenchRevision:context.workbench.revision,openedSessions:context.workbench.openedCount,activeSessions:context.workbench.activeCount,allActiveSessionsIncluded:true,contextMode:context.workbench.mode,
      requestToken:this.currentRequest.token,packetHash:manifest.packetHash,snapshotRead:false,snapshotReadAt:null,bootstrapChars:text.length,
      inputTransportNote:text.length>=2048?'用户原话较长，仍可能触发普通 Codex 编辑器输入通道':'短请求正文；完整资料通过本轮工具读取'});
    return{...request,text,clientSubmissionId:id};
  }
  async send(request) {
    if(typeof request.text!=='string'||!request.text.trim()||request.text.length>50000)throw new Error('请输入有效任务');
    const ensured=await this.ensureSession();if(!ensured.ok)return ensured;
    const requestId=request.requestId||randomUUID();
    if(request.inputMode==='voice')this.inputModes.set(requestId,'voice');
    let receipt;try{receipt=await this.deps.sendPrompt(ensured.sessionId,request.text,requestId);}finally{this.inputModes.delete(requestId);}
    return{ok:receipt?.ok!==false,sessionId:ensured.sessionId,receipt,contextSummary:this.store.get('lastContext')};
  }
  async invokeTool({name,arguments:args={},callerSessionId}) {
    if(this.switching)throw new Error('助理正在切换后端，本轮工具调用已暂停');
    // No caller is a conservative internal compatibility path only. The HTTP
    // bridge always supplies its host identity and never falls back to it.
    const hasCaller=callerSessionId!==undefined;
    if(hasCaller&&!this.isAssistantSession(callerSessionId))throw new Error('调用方不是固定助理会话，未授予专属工具');
    if(name==='workbench_status')return this.workbench.refresh();
    // 学习选题用：用户最近一周在 Hub 里亲口问的话（已排除 Agent 之间的派活任务书），只读。
    if(name==='learning_context')return require('./learning-context').learningContext(this);
    if(name==='publish_daily_brief'){
      const current=this.currentRequest;
      if(!hasCaller||!current||args.requestToken!==current.token||Date.now()-current.createdAt>30*60000)throw new Error('日稿不属于当前回合');
      requireManagerCaller(this.store,current,callerSessionId,this.deps.getSession(callerSessionId));
      return this.workbench.publish(args,current);
    }
    if(String(this.currentRequest?.id||'').startsWith('daily-')&&!['list_sessions','session_evidence','history_context','list_podcasts','list_memos','list_reminders'].includes(name))throw new Error('每日秘书任务只允许读取资料和登记日稿，不能派工或更改其他数据');
    if(name==='list_sessions')return this.sessions().map(s=>({id:s.id,title:s.title||s.name,kind:s.kind,status:s.status,isOpen:s.isOpen,hubState:s.hubState,nativeSessionId:nativeId(s)}));
    if(name==='session_evidence')return this.readLiveFinal(args.sessionId);
    if(name==='history_context'){
      const implicitCurrent=hasCaller&&callerSessionId===this.currentRequest?.sessionId&&Object.keys(args).length===0;
      const requestToken=args.requestToken||(implicitCurrent?this.currentRequest.token:null);
      if(requestToken){
        if(requestToken!==this.currentRequest?.token)throw new Error('资料请求不属于当前用户回合');
        const response=this.snapshots.read(requestToken),last=this.store.get('lastContext');
        if(!String(this.currentRequest?.id||'').startsWith('handoff-')&&response.packet?.asOf)this.store.set('lastAskAt',response.packet.asOf);
        this.dossier.noteServed(response.packet.workbench);
        if(last?.requestToken===requestToken)this.store.set('lastContext',{...last,snapshotRead:true,snapshotReadAt:response.snapshotReceipt.readAt,snapshotReadReceipt:response.snapshotReceipt});
        return response;
      }
      return this.context(args);
    }
    if(name==='list_podcasts'){const s=this.podcasts?.summary()||[];return{ok:true,podcasts:s.slice(0,10).map(m=>({id:m.id,title:m.title,status:m.status,episodes:m.episodes.length,done:m.episodes.filter(e=>e.status==='done').length,minutes:Math.round(m.episodes.reduce((t,e)=>t+e.seconds,0)/60)}))};}
    if(name==='make_podcast'){
      const current=this.currentRequest;
      if(!hasCaller||!current||args.requestToken!==current.token||Date.now()-current.createdAt>30*60000)throw new Error('口播请求不属于当前用户回合');
      requireManagerCaller(this.store,current,callerSessionId,this.deps.getSession(callerSessionId));
      if(!this.podcasts)throw new Error('这台电脑还没配置口播');
      const r=await this.podcasts.start(this.podcastSource(args.path),{title:args.title||''});
      return{ok:true,...r,note:'已在后台制作：先写稿再合成，做好一集手机左侧菜单「资料口播」里就能听，全部完成会提醒用户。'};
    }
    if(name==='list_memos'){const v=this.memos.view();return{ok:true,open:v.open.map(m=>({no:m.no,id:m.id,title:m.title,kind:m.kind,group:v.groups[m.group]||m.group,due:m.dueLabel||null,recordedAt:new Date(m.createdAt).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false}),raw:m.raw.slice(0,200)})),recentlyClosed:v.closed.slice(0,10).map(m=>({id:m.id,title:m.title,status:m.status}))};}
    if(name==='add_memo'||name==='update_memo'){
      const current=this.currentRequest;
      if(!hasCaller||!current||args.requestToken!==current.token||Date.now()-current.createdAt>30*60000)throw new Error('备忘写入不属于当前用户回合');
      requireManagerCaller(this.store,current,callerSessionId,this.deps.getSession(callerSessionId));
      if(name==='add_memo'){const memo=this.addMemo({title:args.title,due:args.due||'',kind:args.kind||'todo',raw:current.text,source:this.requestSource(current.id)});return{ok:true,no:this.memos.openList().find(m=>m.id===memo.id)?.no,id:memo.id,title:memo.title,due:memo.due?require('./memos').whenLabel(memo.due,Date.now()):null,remind:!!memo.reminderId};}
      const r=this.memoAction(String(args.ref??''),{action:args.action,until:args.until||'',title:args.title||''});return{ok:true,id:r.memo.id,title:r.memo.title,status:r.memo.status,due:r.memo.due?require('./memos').whenLabel(r.memo.due,Date.now()):null,later:!!r.memo.later};
    }
    if(name==='list_reminders')return{ok:true,reminders:this.reminders.upcoming().map(r=>({id:r.id,when:new Date(r.at).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false}),text:r.text,...(r.repeat?{repeat:r.repeat}:{})}))};
    if(name==='set_reminder'||name==='cancel_reminder'){
      const current=this.currentRequest;
      if(!hasCaller||!current||args.requestToken!==current.token||Date.now()-current.createdAt>30*60000)throw new Error('提醒设置不属于当前用户回合');
      requireManagerCaller(this.store,current,callerSessionId,this.deps.getSession(callerSessionId));
      if(name==='cancel_reminder'){const r=this.reminders.cancel(String(args.id||''));try{this.deps.onReminderChanged?.({action:'cancel',reminder:r});}catch{}return{ok:true,cancelled:{id:r.id,text:r.text}};}
      const r=this.reminders.add({when:args.when,text:args.text,repeat:args.repeat||''});try{this.deps.onReminderChanged?.({action:'set',reminder:r});}catch{}
      return{ok:true,id:r.id,when:new Date(r.at).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false}),text:r.text,...(r.repeat?{repeat:r.repeat}:{})};
    }
    if(name==='update_memory'){
      // 只有本轮绑定的固定助理能改成长记忆；写入由 Hub 校验长度、拦截密钥并备份。
      const current=this.currentRequest;
      if(!hasCaller||!current||args.requestToken!==current.token||Date.now()-current.createdAt>30*60000)throw new Error('记忆写入不属于当前用户回合');
      requireManagerCaller(this.store,current,callerSessionId,this.deps.getSession(callerSessionId));
      const result=this.memory.update({file:args.file,action:args.action,text:args.text,reason:args.reason});
      // 用户没明说「记住」时的自动写入（包括换班复盘），都提示他一句，不认可可以直接删。
      if(result.ok&&!result.unchanged&&(String(current.id).startsWith('handoff-')||!/记住|记下|记一下|别忘/.test(String(current.text||''))))this.watches.addNotice({id:'memory:'+randomUUID(),title:'助理记忆',kind:'memory-update',label:'助理自动记下的偏好',
        text:'我记下了：'+String(args.text).slice(0,200).replace(/[。.\s]+$/,'')+(args.action==='add'?'':'（'+({remove:'删除',rewrite:'整理'}[args.action]||args.action)+'）')+'。不认可可以对我说，或在助理页「助理记忆」里改。'});
      return result;
    }
    if(!['send_session','create_session','watch_session'].includes(name))throw new Error('未知工具');
    const current=this.currentRequest;
    if(!current||Date.now()-current.createdAt>30*60000)throw new Error('本轮用户委托已过期，请重新发送任务');
    if(args.requestToken!==current.token)throw new Error('工具调用不属于当前用户委托');
    const manager=hasCaller&&requireManagerCaller(this.store,current,callerSessionId,this.deps.getSession(callerSessionId));
    if(name==='watch_session'){
      if(!manager){if(!reminderIntent(current.text))throw new Error('本轮没有明确要求新回复后提醒');
        requireBoundTarget(current,{targetSessionId:args.sessionId},this.sessions());}
      return this.followTask({sessionId:args.sessionId});
    }
    const action={type:name==='create_session'?'create':'send',targetSessionId:args.sessionId,title:args.title,text:args.text,
      ...(name==='create_session'?Object.fromEntries(['tier','kind','model','effort'].filter(key=>args[key]).map(key=>[key,args[key]])):{})};
    if(!manager)requireAuthorizedTarget(current,action,this.sessions());
    // 型号或深度写错时在占用本轮名额前报错，助理改正后可在同一轮重试。
    if(action.type==='create'){const kind=profiles.taskKind(action);backends.backendKind(kind);profiles.resolveTask(action,await this.deps.getDefaults?.(kind)||{});}
    if(typeof action.text!=='string'||!action.text.trim()||action.text.length>50000)throw new Error('任务无效');
    if(this.deps.authorizeAction&&!await this.deps.authorizeAction(action,current))throw new Error('目标不在本轮授权范围内');
    const requestId=bindOperation(this.store,current,args.operationKey,action);
    // 助理新建的任务总是关注：路由的承诺是把结果带回来（手机与助理页都会收到提醒）。
    const followed=reminderIntent(current.text)||action.type==='create';
    if(followed&&action.type==='send')this.followTask({sessionId:action.targetSessionId});
    const result=await this.execute({...action,requestId},{followNewReply:followed});
    return followed?{...result,followed:true,notificationMethod:'Hub监视原生最终回复并在助理页通知'}:result;
  }
  async execute(action,{followNewReply=false}={}) {
    if(!['send','create'].includes(action.type)||typeof action.text!=='string'||!action.text.trim()||action.text.length>50000)throw new Error('任务无效');
    const {requestId,...payload}=action;
    if(this.store.has(requestId)){
      const record=this.store.begin(requestId,payload);
      return{ok:record.state==='acknowledged',duplicate:true,state:record.state,result:record.result,needsReconciliation:record.state==='dispatching'||record.state==='unknown'};
    }
    let resumeMeta=null,route=null;
    if(action.type==='create'){
      // 档位解析失败（型号不存在、深度不支持）在落账前报错，助理可以换个说法重试。
      const kind=profiles.taskKind(action);backends.backendKind(kind);
      route=profiles.resolveTask(action,await this.deps.getDefaults?.(kind)||{});
    }
    if(action.type==='send'){
      if(this.assistantIds().includes(action.targetSessionId)||this.sessionMetadata(action.targetSessionId)?.purpose==='hub-assistant')throw new Error('助理不能向自身循环派发');
      const target=this.deps.getSession(action.targetSessionId);
      if(!target){
        const stored=this.deps.getSessionMetadata?.(action.targetSessionId);
        if(!stored||!nativeId(stored)||!this.deps.resumeSession)throw new Error('原目标未打开或缺少原生身份；未创建替代会话');
        resumeMeta=stored;
      }
      const truth=require('../session-runtime-truth');
      if(target&&(truth.sessionRuntimeIsActive(target)||['running','waiting'].includes(target.status)))throw new Error('目标会话正在运行或等待输入，请先明确处理当前任务');
    }
    const record=this.store.begin(requestId,payload);
    if(record.duplicate)return{ok:record.state==='acknowledged',duplicate:true,state:record.state,result:record.result,needsReconciliation:record.state==='dispatching'||record.state==='unknown'};
    let sessionId=action.targetSessionId;
    try {
      if(resumeMeta){
        await this.deps.resumeSession(sessionId);const target=this.deps.getSession(sessionId);
        if(!target||target.id!==sessionId||nativeId(target)!==nativeId(resumeMeta))throw new Error('原目标恢复身份未确认，未发送任务');
        if(require('../session-runtime-truth').sessionRuntimeIsActive(target)||['running','waiting'].includes(target.status))throw new Error('原目标恢复后仍在运行或等待输入，未发送任务');
      }
      if(action.type==='create'){
        const desiredId=randomUUID();this.store.set('reserved:'+requestId,desiredId);
        // 助理新建的是后台会话，没有界面终端回应光标查询；与群聊成员一样关闭 ConPTY 继承光标，否则 Claude 会卡在启动。
        const session=await this.deps.createSession(route.kind,{...route.opts,id:desiredId,title:String(action.title||'助理委托任务').slice(0,100),noInheritCursor:true});sessionId=session.id;
        // Follow before submission: a fast target can reply before the manager
        // receives create_session's result and gets a chance to call watch.
        if(followNewReply)this.followTask({sessionId});
      }
      const wireText=require('./delegated-prompt').encodeDelegatedPrompt(action.text,this.deps.getSession(sessionId)?.kind);
      const receipt=await this.deps.sendPrompt(sessionId,wireText,requestId);
      const confirmed=receipt?.ok===true&&receipt?.receipt?.status==='confirmed'&&!receipt.notSent&&!receipt.contentMismatch;
      const result={sessionId,receipt,...(route?{route:{tier:route.tier,kind:route.kind,model:route.model,effort:route.effort,label:route.label}}:{})};this.store.finish(requestId,confirmed?'acknowledged':'unknown',result);
      return{ok:confirmed,state:confirmed?'acknowledged':'unknown',...result};
    } catch(error) {this.store.finish(requestId,'unknown',{sessionId,error:error.message});return{ok:false,state:'unknown',sessionId,error:error.message};}
  }
  close(){this.secretary?.close();this.reminders?.stop();this.memos?.stop();for(const timer of [this.startupTimer,this.dailyTimer,this.idleTimer])clearTimeout(timer);clearInterval(this.reconcileTimer);clearInterval(this.safetyTimer);this.bridge.close();this.store.close();}
}
module.exports={AssistantService};
