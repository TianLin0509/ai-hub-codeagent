'use strict';
const store=require('./store'),jobs=require('./jobs');
async function main(){const id=store.id(process.argv[2]),mode=process.argv[3];const release=store.acquire('worker-'+id);if(!release)return;
  const job=store.read(id);
  const save=patch=>{Object.assign(job,patch,{updatedAt:new Date().toISOString()});require('./recovery').track(job);store.write(id,job);
    try { require('../hub-account-activity').recordWebJob(job); }
    catch { job.activityWarning='账号使用记录未保存';store.write(id,job);console.error('Account activity could not be saved'); }
  };
  try{if(job.state==='succeeded')return;if(job.kind==='web'&&job.submissionAttempted&&mode!=='collect'){save({state:'needs_attention',error:'A previous worker attempted submission. Use web_collect; no automatic resend.'});return;}
    save({pid:process.pid,state:'running'});
    if(job.kind==='web')await jobs.runWeb(job,save,mode);else if(job.kind==='roundtable')await require('./roundtable').run(job,save);else throw Error('Unknown job kind');
  }catch(e){save({state:'failed',error:e.stack||e.message});if(job.kind==='roundtable')save({reportPath:require('./report').exportReport(job)});}
  finally{release();}
  try{
    if(job.kind==='web'&&job.state==='succeeded')await require('./recovery').wakeParent(id);
    // A child may finish while the coordinator is still collecting its peers.
    // Its wake-up then observes a running coordinator and does nothing. Recheck
    // after publishing the pause and releasing ownership to close that race.
    if(job.kind==='roundtable'&&job.state==='needs_attention'&&job.pendingRecovery?.length&&job.pendingRecovery.every(r=>jobs.status(r.taskId).state==='succeeded'))await require('./roundtable').resume(id);
  }catch(e){
    console.error('Recovery wake-up failed:',e.message);
    const guard=store.acquire('worker-'+id);
    if(guard)try{const current=store.read(id);store.write(id,{...current,recoveryError:'回答已完成，但圆桌恢复未完成：'+e.message});}finally{guard();}
  }
}
main().catch(e=>{console.error(e.stack);process.exitCode=1;});
