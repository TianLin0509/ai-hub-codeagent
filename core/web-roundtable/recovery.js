'use strict';
// Durable, credential-free pointers. Account Center reads only this small index,
// not every historical prompt/answer, and launches MCPs with its explicit data root.
const fs=require('fs'),path=require('path'),{randomUUID}=require('crypto');
const store=require('./store');
function directory(dataDir=store.dataDir()){return path.join(dataDir,'web-roundtable','recovery');}
function track(job){
  if(job.kind!=='web'||!job.recovery)return;
  const dir=directory();fs.mkdirSync(dir,{recursive:true});
  const file=path.join(dir,store.id(job.id)+'.json'),tmp=file+'.'+randomUUID()+'.tmp';
  fs.writeFileSync(tmp,JSON.stringify({taskId:job.id,provider:job.input.provider}),'utf8');fs.renameSync(tmp,file);
}
function link(childId,parentId){store.write('parent-'+store.id(childId),{taskId:store.id(parentId)});}
function parentOf(id,dataDir=store.dataDir()){
  try{return JSON.parse(fs.readFileSync(path.join(dataDir,'web-roundtable','parent-'+store.id(id)+'.json'),'utf8')).taskId;}
  catch(e){if(e.code==='ENOENT')return null;throw e;}
}
function parentCancelled(id){const parent=parentOf(id);return parent&&store.cancelled(parent);}
async function wakeParent(id){
  const parent=parentOf(id);if(!parent||store.cancelled(parent))return;
  const job=require('./jobs').status(parent);
  if(['needs_attention','interrupted','failed'].includes(job.state))await require('./roundtable').resume(parent);
}
function list(dataDir){
  const dir=directory(dataDir),root=path.join(dataDir,'web-roundtable');let names;
  try{names=fs.readdirSync(dir);}catch(e){if(e.code==='ENOENT')return [];throw e;}
  const tasks=[];
  for(const name of names.filter(n=>/^[a-zA-Z0-9_-]{1,100}\.json$/.test(n))){
    const id=name.slice(0,-5);let job;
    try{job=JSON.parse(fs.readFileSync(path.join(root,id+'.json'),'utf8'));}catch(e){if(e.code==='ENOENT')continue;throw Error('网页恢复任务记录不可读：'+id);}
    if(job.kind!=='web'||!job.recovery||job.state==='cancelled'||fs.existsSync(path.join(root,id+'.cancel')))continue;
    let parent=null;const parentId=parentOf(id,dataDir);
    if(parentId){parent=JSON.parse(fs.readFileSync(path.join(root,store.id(parentId)+'.json'),'utf8'));if(parent.state==='cancelled'||fs.existsSync(path.join(root,parentId+'.cancel')))continue;}
    if(job.state==='succeeded'){
      const needsWake=parent&&(['needs_attention','failed','interrupted'].includes(parent.state)||!require('./jobs').terminal.has(parent.state)&&(parent.pid?!store.alive(parent.pid):Date.now()-Date.parse(parent.updatedAt)>30000));
      if(!needsWake)continue;
    }
    const active=!require('./jobs').terminal.has(job.state)&&(job.pid?store.alive(job.pid):Date.now()-Date.parse(job.updatedAt)<30000);
    tasks.push({id,provider:job.input.provider,accountId:'web-'+job.input.provider,state:active?'resuming':job.state,
      reason:job.recovery.reason,submitted:!!job.submissionAttempted,roundtableId:parentId,
      canResume:!active,mode:job.state==='succeeded'?'coordinator':job.submissionAttempted?'collect':'resume',
      message:active?'正在恢复原任务':job.state==='succeeded'?'回答已补收，继续圆桌':job.submissionAttempted?'只补收原会话，不重复发送':'尚未发送，登录确认后继续原提问'});
  }
  return tasks;
}
class AccountRecovery {
  constructor({dataDir,makeClient}={}){this.dataDir=dataDir;this.makeClient=makeClient||((provider)=>require('./rpc').providerClient(provider,{env:{...process.env,AI_HUB_WEB_DATA_DIR:dataDir}}));}
  list(){return list(this.dataDir);}
  async resume(row){
    if(!row.managedBrowser)return {started:0,errors:[]};
    const tasks=this.list().filter(t=>t.provider===row.provider&&t.canResume);if(!tasks.length)return {started:0,errors:[]};
    const result={started:0,errors:[]};const client=this.makeClient(row.provider);
    try{await client.init();for(const task of tasks){try{await client.call('web_resume',{task_id:task.id});result.started++;}catch(e){result.errors.push({taskId:task.id,message:e.message});}}}
    finally{client.close();}
    return result;
  }
}
module.exports={track,link,parentOf,parentCancelled,wakeParent,list,AccountRecovery};
