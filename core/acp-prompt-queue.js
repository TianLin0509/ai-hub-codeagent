'use strict';
const { randomUUID, createHash } = require('node:crypto');
const fingerprint = (text, attachments) => createHash('sha256').update(JSON.stringify([text,attachments || []])).digest('hex');

// These are unsent user intents, never a replay of an uncertain native RPC.
class AcpPromptQueue {
  constructor(session) { this.session=session;this.records=[];this.launching=null; }
  restore(records = []) { this.records=records.map(r=>({...r,status:'held',reason:'会话已恢复，请确认后发送'}));this.publish(); }
  snapshot() { return this.records.map(({id,text,status,reason})=>({id,preview:text.slice(0,320),length:text.length,status,reason})); }
  publish() {
    const s=this.session;
    s.runtime={...s.runtime,queued:this.snapshot(),revision:s.runtime.revision+1};
    s.emit('state',s.runtime);
  }
  save() { this.session.persist();this.publish(); }
  hold(reason) {
    if(!this.records.length)return;
    for(const record of this.records) {record.status='held';record.reason=reason;}
    this.save();
  }
  async submit(text, options) {
    const s=this.session,id=options.clientSubmissionId || randomUUID(),digest=fingerprint(text,options.attachments);
    const old=this.records.find(r=>r.id===id);
    if(old) {if(old.digest!==digest)throw new Error('同一提交 ID 的正文或附件已变化');return this.receipt(old);}
    if(s.receipts.has(id)) {
      const previous=s.receipts.get(id);if(previous.digest!==digest)throw new Error('同一提交 ID 的正文或附件已变化');return previous.result;
    }
    if(s.active?.id===id) {if(s.active.digest!==digest)throw new Error('同一提交 ID 的正文或附件已变化');return s.active.ack;}
    if(this.records.length>=20 || this.records.reduce((n,r)=>n+r.text.length,0)+text.length>2*1024*1024)throw Object.assign(new Error('待发送消息已满，请先处理队列'),{notSent:true});
    const record={id,digest,text,attachments:options.attachments || [],status:'queued',createdAt:Date.now()};
    this.records.push(record);
    try {this.save();}catch(error){this.records=this.records.filter(r=>r!==record);this.publish();error.notSent=true;throw error;}
    if(!s.active && !this.launching)return this.dispatch(record);
    return this.receipt(record);
  }
  receipt(record) {return {ok:true,sendStatus:'queued',mode:'acp',clientSubmissionId:record.id,message:record.status==='held'?'消息已保留，等待你确认发送':'消息已排队，当前轮结束后发送'};}
  async dispatch(record) {
    const s=this.session;
    this.launching=record;
    let durable=false;
    try {
      return await s._send(record.text,{clientSubmissionId:record.id,attachments:record.attachments,
        onDurable:()=>{durable=true;},
        beforeStart:()=>{
          if(record.status!=='queued' || s.closed)throw new Error('消息已暂停，未发送');
          this.records=this.records.filter(r=>r!==record);this.publish();
        }});
    } catch(error) {
      if(!durable && !this.records.includes(record))this.records.unshift(record);
      if(this.records.includes(record)) {
        record.status='held';record.reason=error.message;
        try{this.save();}catch(storageError){error.queueStorageError=storageError;this.publish();}
      }
      throw error;
    } finally {this.launching=null;this.schedule();}
  }
  schedule() {
    if(this.scheduled)return;
    this.scheduled=setImmediate(()=>{
      this.scheduled=null;const s=this.session;
      if(s.closed || s.active || this.launching || s.storageError || s.runtime.connection!=='connected'
          || s.runtime.submission?.status==='unknown' || s.configuring)return;
      const record=this.records.find(r=>r.status==='queued');
      if(record)this.dispatch(record).catch(error=>s.emit('action-error','待发送消息未完成：'+error.message));
    });
  }
  action(id, action, epoch) {
    const s=this.session;
    if(epoch!==s.runtime.epoch || s.closed)throw new Error('待发送消息来自旧连接');
    const record=this.records.find(r=>r.id===id);if(!record)throw new Error('消息已发送或移除');
    if(this.launching===record)throw new Error('消息正在提交，请等待确认');
    const previous=this.records.map(entry=>({...entry}));
    if(action==='remove')this.records=this.records.filter(r=>r!==record);
    else if(action==='resume') {
      if(s.runtime.connection!=='connected' || s.runtime.submission?.status==='unknown' || s.active?.cancelling)throw new Error('请先核对当前连接和轮次');
      record.status='queued';delete record.reason;
    }else throw new Error('未知队列操作');
    try {this.save();}
    catch(error){this.records=previous;this.publish();throw error;}
    this.schedule();return {ok:true};
  }
}
module.exports={AcpPromptQueue};
