'use strict';
const fs=require('node:fs'),path=require('node:path');
const {createHash,randomUUID}=require('node:crypto');
const hash=text=>createHash('sha256').update(text).digest('hex');
class NativeMemoryEvidence {
  constructor({root,notify,logger=console}){this.root=root;this.notify=notify;this.logger=logger;this.cache=new Map();this.writes=new Map();}
  identity(s){return !s.codexSid && s.ccSessionId ? 'claude:'+s.ccSessionId : null;}
  location(id){return path.join(this.root,'native-context',hash(id)+'.json');}
  async read(s){
    const id=this.identity(s);if(!id)return {rows:[],state:'unavailable',warnings:[]};
    let entry=this.cache.get(id);
    if(!entry){
      try{entry=JSON.parse(await fs.promises.readFile(this.location(id),'utf8'));if(entry.identity!==id)throw new Error('上下文证据身份不匹配');if(!Array.isArray(entry.rows)||!Array.isArray(entry.warnings))throw new Error('上下文证据格式无效');}
      catch(e){if(e.code!=='ENOENT')return {rows:[],state:'error',warnings:[e.message]};entry={identity:id,rows:[],warnings:[],state:'unavailable'};}
      // Concurrent hook arrival must win over a stale disk read.
      entry=this.cache.get(id)||entry;this.cache.set(id,entry);
    }
    return entry;
  }
  async persist(id,value){
    const previous=this.writes.get(id)||Promise.resolve();
    const task=previous.catch(()=>{}).then(async()=>{
      const file=this.location(id),tmp=file+'.'+randomUUID()+'.tmp';await fs.promises.mkdir(path.dirname(file),{recursive:true});
      try{await fs.promises.writeFile(tmp,JSON.stringify(value),'utf8');for(let i=0;;i++){try{await fs.promises.rename(tmp,file);break;}catch(e){if(i>=8||!['EPERM','EACCES','EBUSY'].includes(e.code))throw e;await new Promise(r=>setTimeout(r,15));}}}
      catch(e){try{await fs.promises.unlink(tmp);}catch(clean){if(clean.code!=='ENOENT')e.cleanupError=clean;}throw e;}
    });this.writes.set(id,task);try{await task;}finally{if(this.writes.get(id)===task)this.writes.delete(id);}
  }
  async loaded(s,event){
    // Hooks are evidence, never lifecycle authority. Require exact native identity.
    if(!s?.ccSessionId || s.codexSid || event.claudeSessionId!==s.ccSessionId || event.agentId || !path.isAbsolute(event.instructionPath||''))return false;
    const id=this.identity(s),loaded=await this.read(s);
    if(loaded.state==='error')throw new Error(loaded.warnings.join('；'));
    const entry=this.cache.get(id);
    if(!entry)throw new Error('无法读取原生规则证据缓存');
    if(entry.state==='error')throw new Error(entry.warnings.join('；'));
    const row={id:hash(event.instructionPath),label:path.basename(event.instructionPath),path:event.instructionPath,
      observedAt:Date.now(),evidence:'Claude InstructionsLoaded · '+String(event.loadReason||'unknown'),snapshot:false};
    const next={identity:id,state:'ready',rows:[row,...entry.rows.filter(r=>r.id!==row.id)],warnings:entry.warnings||[]};
    this.cache.set(id,next);
    try {await this.persist(id,next);}
    catch(error) {
      // Keep the observed event but disclose that it has not survived to disk.
      this.cache.set(id,{...this.cache.get(id),persistenceError:'加载证据保存失败：'+error.message});
      this.notify();throw error;
    }
    this.notify();return true;
  }
}
module.exports={NativeMemoryEvidence};
