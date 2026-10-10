'use strict';
const fs=require('fs'),path=require('path');
const {spawn}=require('child_process');
const store=require('./store');
const adapters=require('./providers');
// An answer still growing is waited for: only this long without new text ends the wait, up to
// the hard cap (long reasoning answers took more than the former fixed three minutes).
const ANSWER_IDLE_MS=180000,ANSWER_MAX_MS=15*60000;
const terminal=new Set(['succeeded','failed','needs_attention','cancelled','interrupted','partial']);
function text(value,name='prompt',max=40000){if(typeof value!=='string'||!value.trim()||value.length>max)throw Error(`${name} must contain 1..${max} characters (no truncation is performed)`);return value;}
function status(id){const j=store.read(id);if(!terminal.has(j.state)&&((j.pid&&!store.alive(j.pid))||(!j.pid&&Date.now()-Date.parse(j.updatedAt)>30000)))return {...j,state:'interrupted',error:'Worker exited or failed to start. Resume roundtable, or collect the provider reply without resending.'};return j;}
async function spawnWorker(id,mode='run'){
  const log=fs.openSync(path.join(store.root(),id+'.log'),'a');
  try{await new Promise((resolve,reject)=>{const child=spawn(process.execPath,[path.join(__dirname,'worker.js'),id,mode],{env:{...process.env,ELECTRON_RUN_AS_NODE:'1'},windowsHide:true,detached:true,stdio:['ignore',log,log]});child.once('error',reject);child.once('spawn',()=>{child.unref();resolve();});});}finally{fs.closeSync(log);}
}
async function create(kind,requestId,input,{launch=spawnWorker}={}){
  const id=store.taskId(kind,requestId), fingerprint=store.digest(input);
  return store.locked('create-'+id,async()=>{
    let previous;try{previous=status(id);}catch(e){if(e.code!=='ENOENT')throw e;}
    if(previous){if(previous.fingerprint!==fingerprint)throw Error('request_id was already used with different arguments');return previous;}
    const job={id,kind,requestId,input,fingerprint,state:'queued',createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()};store.write(id,job);
    try{await launch(id);}catch(e){job.state='failed';job.error=e.message;store.write(id,job);throw e;}
    return job;
  });
}
async function ask(provider,args){adapters.get(provider);text(args.prompt);if(args.reply_to){const parent=status(args.reply_to);if(parent.kind!=='web'||parent.input.provider!==provider||parent.state!=='succeeded'||!adapters.validUrl(provider,parent.url))throw Error('reply_to must be a completed task of the same provider');}
  return create('web',args.request_id,{provider,prompt:args.prompt,reply_to:args.reply_to||null});
}
async function schedule(job,mode='run',launch=spawnWorker){
  let launchNeeded=false;
  const queued=await store.locked('worker-'+job.id,async()=>{
    const current=status(job.id);if(current.state==='succeeded'||!terminal.has(current.state))return current;
    if(store.cancelled(job.id))throw Error('Cancelled tasks are not resumed');
    const value={...current,pid:null,state:'queued',updatedAt:new Date().toISOString()};store.write(job.id,value);launchNeeded=true;return value;
  });
  if(launchNeeded)try{await launch(job.id,mode);}catch(e){store.write(job.id,{...queued,state:'failed',error:e.message});throw e;}return queued;
}
async function collect(id,provider){return store.locked('create-'+id,async()=>{const job=status(id);if(job.kind!=='web'||job.input.provider!==provider)throw Error('Provider task mismatch');if(job.state==='succeeded')return job;if(store.cancelled(id)||require('./recovery').parentCancelled(id))throw Error('Cancelled tasks are not resumed');if(!terminal.has(job.state))return job;if(!job.submissionAttempted||!adapters.validUrl(provider,job.url))throw Error('No known submitted conversation to collect; inspect the official website before creating another task');return schedule(job,'collect');});}
async function resumeWeb(id,provider){
  const job=status(id);if(job.kind!=='web'||job.input.provider!==provider)throw Error('Provider task mismatch');
  if(store.cancelled(id)||require('./recovery').parentCancelled(id))throw Error('Cancelled tasks are not resumed');
  if(job.state==='succeeded'){await require('./recovery').wakeParent(id);return job;}
  const transport=require('../ordinary-browser-client');
  if(transport.enabled({identity:'main'}))await transport.call({identity:'main'},'roundtable-person-'+provider,['human-done',adapters.get(provider).url]);
  if(job.submissionAttempted)return collect(id,provider);
  return store.locked('create-'+id,async()=>schedule(status(id)));
}
async function runWeb(job,save,mode,runtime={}){
  const provider=job.input.provider, adapters=runtime.adapters||require('./providers'),p=adapters.get(provider),open=runtime.open||require('./cdp').open;
  let release,browser;
  const checkCancel=()=>{if(store.cancelled(job.id)||require('./recovery').parentCancelled(job.id))throw Object.assign(Error('Cancelled; a submitted website response may continue remotely'),{cancelled:true});};
  try{
    const queuedUntil=Date.now()+10*60*1000;
    while(!(release=store.acquire('browser-'+provider))){checkCancel();if(Date.now()>queuedUntil)throw Error('Provider browser remained busy for ten minutes');await store.sleep(300);}
    checkCancel();save({state:'opening'});
    const parent=job.input.reply_to?status(job.input.reply_to):null;
    if(parent&&mode!=='collect'){
      let next;try{next=store.read('next-'+parent.id);}catch(e){if(e.code!=='ENOENT')throw e;}
      if(next&&next.taskId!==job.id){const newer=status(next.taskId);if(newer.submissionAttempted)throw Error('This conversation already has a later submission: '+newer.id+'. Collect it or continue from its completed answer; never fork an uncertain conversation.');}
    }
    const url=mode==='collect'?job.url:parent?.url||p.url;
    if(url!==p.url&&!adapters.validUrl(provider,url))throw Error('Invalid stored conversation URL');
    // Shared Hub rules: wait while a person has the browser; never revisit a site that just
    // challenged automation (the person clears it from the account page).
    // The record belongs to the browser actually opened: the Hub Chrome for the real opener, or
    // whatever root a caller names together with its own opener.
    const ordinary=!runtime.open&&require('../ordinary-browser-client').enabled({identity:'main'});
    const hubRoot=runtime.hubRoot||(runtime.open?null:ordinary?require('../personal-chrome').personalRoot(process.env):require('../hub-chrome').defaultRoot(process.env)),guard=hubRoot&&(runtime.guard||require('../web-risk-guard'));
    for(;guard;){
      if(!ordinary&&typeof guard.read==='function'&&typeof guard.settleHandoff==='function'&&guard.read(hubRoot).handoff)
        await guard.settleHandoff(new (require('../hub-chrome').HubChrome)({root:hubRoot})).catch(()=>{});
      try{guard.assertAutomationAllowed(hubRoot,{identity:'main',url,navigate:!ordinary});break;}
      catch(e){
        if(e.code==='HUB_RATE_LIMITED'||e.code==='HUB_COOLDOWN')throw Object.assign(Error('这个网站本小时的自动访问次数已用完，稍后再试；不影响你自己使用'),{attention:true,recovery:'rate_limited'});
        if(e.code==='HUB_SITE_CHALLENGED')throw Object.assign(Error('此网站刚遇到人机验证，自动化已暂停；请从 Hub 账号页打开此网站完成验证后再处理任务'),{attention:true,recovery:'human_verification'});
        if(e.code!=='HUB_HUMAN_HANDOFF')throw e;
        checkCancel();if(Date.now()>queuedUntil)throw Error('Hub browser stayed with a person for ten minutes');await store.sleep(1000);
      }
    }
    browser=await open(provider,url);
    save({browser:{headless:browser.headless,owned:browser.owned,pid:browser.browserPid}});
    const checkQuota=snap=>{if(snap.quotaMessage)throw Object.assign(Error('网站提示额度已用完，请等待额度恢复，或在网站自行调整套餐：'+snap.quotaMessage),{attention:true,errorCode:'quota_exhausted'});};
    // Kimi hydrates its quota banner after its composer and account label. Let
    // that state settle before editing; seeing an editor alone is not readiness.
    let snap,readyEnd=Date.now()+45000,readyCount=0,loginCount=0;
    const readySamples=provider==='kimi'?12:3;
    const challenged=()=>guard&&guard.recordChallenge(hubRoot,{identity:'main',site:guard.siteOf(p.url),kind:'probe',source:'roundtable-'+provider});
    do{checkCancel();snap=await adapters.snapshot(browser.page,provider,job.input.prompt);checkQuota(snap);loginCount=snap.login?loginCount+1:0;if(snap.challenge)challenged();if(snap.challenge||loginCount>=4)throw Object.assign(Error('请从 Hub 权限页打开此网站，完成登录或人机验证后再处理任务'),{attention:true,recovery:snap.challenge?'human_verification':'login_required'});readyCount=snap.ready&&!snap.login&&(!parent||snap.answers.at(-1)?.done)?readyCount+1:0;if(readyCount>=readySamples)break;await adapters.dismissPromo(browser.page,provider);await store.sleep(300);}while(Date.now()<readyEnd);
    if(readyCount<readySamples)throw Error('Official composer not ready; website layout or network needs attention');
    if(mode!=='collect'){
      if(parent&&snap.answers.at(-1)?.text!==parent.answer)throw Error('Conversation changed since reply_to; refusing to send into another branch');
      if(snap.answers.length&&!parent)throw Error('New conversation unexpectedly contains messages');
      save({baseline:{count:snap.answers.length,last:snap.answers.at(-1)||null,echo:snap.echo},url:snap.url});
      await adapters.focus(browser.page,provider);await browser.page.call('Input.insertText',{text:job.input.prompt});
      // Wait for the website editor to consume its own input. Never send twice.
      let filled=false;for(let n=0;n<30;n++){snap=await adapters.snapshot(browser.page,provider,job.input.prompt);if(snap.composerText.replace(/\s+/g,' ').trim()===job.input.prompt.replace(/\s+/g,' ').trim()){filled=true;break;}await store.sleep(100);}
      if(!filled)throw Error('Website did not accept the complete prompt; nothing submitted');
      checkCancel();if(parent)store.write('next-'+parent.id,{taskId:job.id});save({state:'submitting',submissionAttempted:true});
      await adapters.send(browser.page,provider);
    }
    save({state:'waiting',error:null});
    const hardEnd=Date.now()+ANSWER_MAX_MS;let end=Date.now()+ANSWER_IDLE_MS,last='',stable=0,progress='';loginCount=0;
    do{
      checkCancel();snap=await adapters.snapshot(browser.page,provider,job.input.prompt);
      checkQuota(snap);
      if(adapters.validUrl(provider,snap.url)&&snap.url!==job.url)save({url:snap.url});
      loginCount=snap.login?loginCount+1:0;
      if(snap.challenge)challenged();
      if(loginCount>=4||snap.challenge)throw Object.assign(Error('Official website requires login or human verification after submission; not resending'),{attention:true,recovery:snap.challenge?'human_verification':'login_required'});
      const answer=snap.answers.at(-1),baseline=job.baseline;
      const seen=snap.answers.length+'|'+(answer?.text||'');
      if(seen!==progress){progress=seen;end=Math.min(hardEnd,Date.now()+ANSWER_IDLE_MS);}
      const changed=answer&& (snap.answers.length>baseline.count || (answer.key&&answer.key!==baseline.last?.key));
      const receipt=snap.echo>baseline.echo;
      if(receipt&&!job.promptEchoSeen)save({promptEchoSeen:true});
      if(changed&&receipt&&answer.text&&answer.done){if(answer.text===last)stable++;else{last=answer.text;stable=0;}if(stable>=2){save({state:'succeeded',submissionConfirmed:true,answer:answer.text,completionEvidence:'official answer completion control + prompt echo + stable final text',completedAt:new Date().toISOString()});return;}}
      else stable=0;
      await store.sleep(700);
    }while(Date.now()<end);
    throw Object.assign(Error('No verified complete answer before deadline. Use web_collect on the same task; never resend blindly.'),{attention:true});
  }catch(e){
    if(/^Extension pairing/.test(e.message)){e.attention=true;e.errorCode='extension_pairing_required';e.recovery='extension_pairing';}
    if(/^Site challenged/.test(e.message)){e.attention=true;e.errorCode='human_verification';e.recovery='human_verification';}
    save({state:e.cancelled?'cancelled':job.submissionAttempted||e.attention?'needs_attention':'failed',error:e.message,...(e.errorCode?{errorCode:e.errorCode}:{}),...(e.recovery?{recovery:{reason:e.recovery,accountId:'web-'+provider,instruction:e.recovery==='extension_pairing'?'在账号 Tab 普通浏览器配对官方扩展后继续原任务；不会转用其他浏览器':'在 AI Hub 账号页打开此账号，完成验证后让原工具继续此任务；原任务 ID 保留，已发送问题只补收。'}}:{}),...(browser?.page.networkErrors?.length?{networkErrors:browser.page.networkErrors}:{})});}
  finally{if(browser)try{await browser.close();}catch(e){save({cleanupError:e.message});}if(release)release();}
}
module.exports={terminal,text,status,create,ask,collect,resumeWeb,spawnWorker,runWeb,schedule};
