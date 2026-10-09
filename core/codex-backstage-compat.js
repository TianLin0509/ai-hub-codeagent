'use strict';
const {EventEmitter}=require('node:events');
const {isDeepStrictEqual}=require('node:util');
const {CodexBackstage}=require('./codex-backstage');

// Older writers already supply native messages and complete tool results, but
// have no backstage RPC. Project those records only when the user opens this
// view. This in-memory reader never opens another writer's journal, starts an
// engine, polls a process, or invents stderr that the old engine did not retain.
class CodexBackstageCompat {
  constructor(owner) {
    this.owner=owner;this.source=null;this.imported=new Map();this.turnOrders=new Map();this.positions=new Map();this.records=[];
    this.session=new EventEmitter();
    this.session.options={id:owner.options.id}; // deliberately memory-only
    this.session.history=new Map();
    this.reader=new CodexBackstage(this.session);
    this.session.on('backstage-updated',event=>owner.emit('backstage-updated',event));
  }
  sync() {
    const owner=this.owner;
    this.session.runtime=owner.runtime;this.session.threadId=owner.threadId;
    if(this.source===owner.transcript)return;
    this.source=owner.transcript;
    const history=new Map();
    for(const card of owner.transcript) {
      const turnId=card.providerTurnId || card.displayTurnKey?.slice((owner.threadId+':').length);
      if(!turnId)continue;
      let turn=history.get(turnId);
      if(!turn){turn={id:turnId,status:'unknown',items:[]};history.set(turnId,turn);}
      if(card.role==='user')turn.items.push({id:card.id,type:'userMessage',content:[{type:'text',text:card.text}],
        hubStartedAt:card.ts,hubCompletedAt:card.ts,itemOrder:card.itemOrder});
      else {
        turn.status=card.nativeOutcome || card.stopReason || 'unknown';
        for(const message of card.displayMessages || [])turn.items.push({id:message.itemId || message.id,
          type:'agentMessage',text:message.text,phase:message.phase,hubStartedAt:message.ts,hubCompletedAt:message.tsEnd,itemOrder:message.itemOrder});
        if(!card.displayMessages?.length && card.text)turn.items.push({id:card.id,type:'agentMessage',text:card.text,hubCompletedAt:card.tsEnd});
        for(const tool of card.toolCalls || [])turn.items.push({
          ...(tool.input && typeof tool.input==='object'?tool.input:{input:tool.input}),
          id:tool.id,type:tool.input?.type || tool.name || 'tool',status:tool.status,
          ...(tool.output!=null && tool.input?.aggregatedOutput==null && tool.input?.result==null && tool.input?.error==null?{result:tool.output}:{}),
          exitCode:tool.exitCode,durationMs:tool.durationMs,hubCompletedAt:tool.completedAt || card.tsEnd,itemOrder:tool.itemOrder});
      }
    }
    for(const turn of history.values())turn.items.sort((a,b)=>{
      const order=item=>item.type==='userMessage'?-1:item.phase==='final_answer'?Infinity:item.itemOrder ?? Number.MAX_SAFE_INTEGER;
      return order(a)-order(b);
    });
    this.session.history=history;
    this.records=[];
    for(const turn of history.values()) {
      if(!this.turnOrders.has(turn.id))this.turnOrders.set(turn.id,this.turnOrders.size+1);
      let positions=this.positions.get(turn.id);
      if(!positions){positions=new Map();this.positions.set(turn.id,positions);}
      for(const item of turn.items) {
        const id=this.reader.key(turn.id,item.id);
        if(!positions.has(id))positions.set(id,positions.size+1);
        // Stable positions within a turn keep later arrivals in an earlier
        // turn ahead of subsequent turns. No full output is copied here.
        const ordinal=this.turnOrders.get(turn.id)*0x100000000+positions.get(id);
        if(!Number.isSafeInteger(ordinal)||positions.size>=0x100000000)throw Error('历史记录位置超过可表示范围');
        this.records.push({id,ordinal,turnId:turn.id,complete:turn.status!=='inProgress',item});
      }
    }
    this.records.sort((a,b)=>a.ordinal-b.ordinal);
  }
  import(records) {
    const store=this.reader.ensure();
    for(const record of records) {
      if(isDeepStrictEqual(this.imported.get(record.id),record))continue;
      store.ordinal=Math.max(store.ordinal,record.ordinal);
      store.get(record.id,{ordinal:record.ordinal,historical:true});
      this.reader.item(record.turnId,record.item,record.complete);
      store.update(record.id,{completedAt:record.item.hubCompletedAt || null});
      if(this.reader.failure)throw this.reader.failure;
      this.imported.set(record.id,record);
    }
  }
  read(options={}) {
    if(this.preparing)throw Error('后台原始记录正在整理，请稍后读取');
    this.sync();
    const limit=Math.max(1,Math.min(Number(options.limit)||40,60));
    const before=options.before==null?Infinity:Number(options.before);
    if(options.mode==='detail') {
      const record=this.records.find(record=>record.id===options.id);
      if(!record)throw Error('未找到原始工具记录');
      this.import([record]);
    } else {
      const window=this.records.filter(record=>options.mode==='raw'||record.ordinal<before).slice(-limit);
      this.import(window);
      if(options.since!=null)this.import(this.records.filter(record=>this.imported.has(record.id)
        && !isDeepStrictEqual(this.imported.get(record.id),record)).slice(0,40));
    }
    const page=this.reader.ensure().read(options);
    return {...page,compatibility:true,historyMore:options.mode==='raw'||options.mode==='detail'?false:
      this.records.some(record=>record.ordinal<(page.first??before)),
      capture:'显示原生会话已保存的消息、命令与工具结果；旧后台未保存的逐字过程和 stderr 无法补录。'};
  }
  async prepareExport() {
    this.sync();
    if(this.preparedSource===this.source)return;
    if(this.preparing){await this.preparing;return this.prepareExport();}
    if(!this.rawPrepared) {
      // Readable opens at the tail and may page backwards. Raw sequence numbers
      // must follow source order, not the order in which those pages were read.
      this.reader.close();this.reader=new CodexBackstage(this.session);
      this.imported.clear();
    }
    const source=this.source,records=this.records.slice();
    this.preparing=(async()=>{
      for(let i=0;i<records.length;i+=40){this.import(records.slice(i,i+40));await new Promise(resolve=>setImmediate(resolve));}
      this.preparedSource=source;this.rawPrepared=true;
    })();
    try{await this.preparing;}finally{this.preparing=null;}
  }
  close(){this.reader.close();this.imported.clear();this.records=[];}
}
module.exports={CodexBackstageCompat};
