'use strict';
const path=require('path');
const {randomUUID}=require('crypto');
const {CodexSharedSession}=require('./codex-shared-session');
const {acquireBroker}=require('../main/codex-runtime-broker-client');
const {restoreRecord}=require('./claude-broker-session');
const {claudeTranscriptTurns,tailClaudeRecords}=require('./claude-native-transcript');
const END=new Set(['completed','failed','interrupted']);

async function connectClaudeBroker(options) {
  let client=await acquireBroker(options);
  if(client.features?.includes('claude-shared-v1'))return client;
  // An older live broker cannot be replaced while it owns Codex work. A new
  // compatible service handles Claude until that old service drains naturally.
  client.close();
  client=await acquireBroker({...options,dataDir:path.join(options.dataDir,'native-runtime-v2')});
  if(client.features?.includes('claude-shared-v1'))return client;
  client.close();throw Error('共享后台不支持 Claude 原生会话，请更新 Hub 后恢复');
}
class ClaudeSharedSession extends CodexSharedSession {
  constructor(options) {
    const sessionId=options.resumeSessionId&&!options.fork?options.resumeSessionId:options.sessionId||randomUUID();
    super({...options,sessionId,nativeProvider:'claude',brokerConnector:options.brokerConnector||connectClaudeBroker});
    this.view.claudeMessageMode='delta-v1';
    delete this.transcript;
    this.sessionId=sessionId;this.threadId=sessionId;this.records=new Map();this.activities={records:new Map(),pending:()=>[...this.activities.records.values()].filter(r=>!END.has(r.status)&&!r.reconciliation)};
    this.messageBases=new Map();this.messageRemovals=new Map();
    this.recovery=[];this.historyFile=null;
    this.nativeStarted=!!(options.resumeSessionId || options.restoredRuntime?.nativeStarted || options.restoredRuntime?.childPid);
    Object.assign(this.runtime,{providerSessionId:sessionId,ownerPid:null,childPid:null,reason:options.lazyStart?'尚未开始，收到消息后启动':'正在连接共享会话'});
  }
  attachOptions(){
    const unstarted=!this.nativeStarted && this.runtime.lazyStart;
    return {...this.options,sessionId:this.sessionId,journalSessionId:this.runtime.journalSessionId || this.options.journalSessionId,
      ...(this.everAttached?{restoredRuntime:this.runtime,resumeSessionId:unstarted?null:this.sessionId,fork:false}:{})};
  }
  applyRuntime(next){super.applyRuntime(next);this.sessionId=this.runtime.providerSessionId||this.sessionId;
    if(next?.nativeStarted || next?.childPid || next?.connection==='connected')this.nativeStarted=true;}
  applyContent(content) {
    if(!content)return;
    if(Number.isFinite(content.contentRevision) && content.contentRevision<this.contentRevision) {
      // A late attach snapshot may fill missing history, but cannot replace a
      // record already updated by a newer notification in the same socket read.
      for(const row of content.nativeRecords || []) {
        const map=row.nativeActivity?this.activities.records:this.records;
        const key=row.nativeActivity?row.userMessageId:row.submissionId;
        const identity=(row.nativeActivity?'activity:':'submission:')+key;
        const existing=map.get(key);
        if(existing) {
          if(row.messagePatch || (this.messageBases.get(identity)??-1)>=content.contentRevision)continue;
          const messages=new Map(row.messages || []);
          for(const id of this.messageRemovals.get(identity)||[])messages.delete(id);
          for(const [id,message] of existing.messages)messages.set(id,message);
          existing.messages=messages;
        } else map.set(key,restoreRecord(row));
        this.messageBases.set(identity,content.contentRevision);
        const record=map.get(key);
        this.emit('item',{userMessageId:record.userMessageId});
      }
      return;
    }
    if(content.relaunchOptions)this.options={...this.options,...content.relaunchOptions};
    if(content.replaceNativeRecords){this.records.clear();this.activities.records.clear();this.messageBases.clear();this.messageRemovals.clear();}
    const changed=[];
    for(const row of content.nativeRecords || []) {
      const map=row.nativeActivity?this.activities.records:this.records;
      const identity=(row.nativeActivity?'activity:':'submission:')+(row.nativeActivity?row.userMessageId:row.submissionId);
      if(!row.messagePatch){this.messageBases.set(identity,Number(content.contentRevision)||this.contentRevision);this.messageRemovals.delete(identity);}
      else {
        const removed=this.messageRemovals.get(identity)||new Set();
        for(const id of row.removedMessageIds||[])removed.add(id);
        for(const [id] of row.messages||[])removed.delete(id);
        this.messageRemovals.set(identity,removed);
      }
      const record=restoreRecord(row,map.get(row.nativeActivity?row.userMessageId:row.submissionId));
      map.set(record.nativeActivity?record.userMessageId:record.submissionId,record);changed.push(record.userMessageId);
    }
    if(Array.isArray(content.recoveryRecords))this.recovery=content.recoveryRecords;
    if(Object.hasOwn(content,'historyFile'))this.historyFile=content.historyFile;
    if(content.sessionUsage && !require('util').isDeepStrictEqual(content.sessionUsage,this.sessionUsage)){
      this.sessionUsage=content.sessionUsage;this.emit('session-usage',content.sessionUsage);
    }
    this.contentRevision=Number(content.contentRevision)||this.contentRevision;
    for(const userMessageId of changed)this.emit('item',{userMessageId});
  }
  transcript(options={}) {
    const records=[...this.records.values(),...this.activities.records.values()].sort((a,b)=>a.createdAt-b.createdAt);
    return claudeTranscriptTurns(options.tailRecords?tailClaudeRecords(records,options.tailRecords):records);
  }
  historyPath(){return this.historyFile;}
  historyExclusions(){
    const excludeEntryIds=[],excludeMessageIds=[];
    for(const record of [...this.records.values(),...this.activities.records.values()]) {
      excludeEntryIds.push(record.userMessageId);
      for(const frame of [...record.messages.values(),...record.streams.values()]) {
        if(frame.uuid)excludeEntryIds.push(frame.uuid);if(frame.message?.id)excludeMessageIds.push(frame.message.id);
      }
    }
    return {excludeEntryIds,excludeMessageIds};
  }
  update(patch){const previous=this.runtime;this.runtime={...previous,...patch,revision:previous.revision+1};this.emit('state',this.runtime,previous);}
  submit(text,options={}){return this.action('submit',[text,options]);}
  setModel(value){return this.action('setModel',[value]);}
  setEffort(value){return this.action('setEffort',[value]);}
  setPermissionMode(value){return this.action('setPermissionMode',[value]);}
  setFastMode(value){return this.action('setFastMode',[value]);}
  slash(value){return this.action('slash',[value]);}
  rename(value){return this.action('rename',[value]);}
  respond(id,decision,identity){
    if(identity?.epoch!==this.runtime.epoch)return Promise.reject(Error('审批来自旧窗口状态，请刷新'));
    return this.action('respond',[id,decision,{...identity,epoch:this.runtime.requests.find(r=>r.id===id)?.brokerEpoch ?? this.hostRuntimeEpoch}]);
  }
  recoveryRecords(){return this.recovery.map(r=>({...r,epoch:this.runtime.epoch}));}
  reconcile(identity){
    if(identity?.epoch!==this.runtime.epoch)return Promise.reject(Error('核对来自旧窗口状态，请刷新'));
    return this.action('claude-reconcile',[{...identity,epoch:this.hostRuntimeEpoch}]);
  }
  async reconnect(options={}){await this.action('reconnect',[options]);return this.runtime;}
  readAccountUsage(){return this.action('readAccountUsage');}
  close(){if(this.closed)return Promise.resolve();return new Promise(resolve=>{this.once('exit',resolve);this.kill();});}
  write(){throw Error('原生会话通过 Hub 输入框发送消息');}
}
module.exports={ClaudeSharedSession,connectClaudeBroker};
