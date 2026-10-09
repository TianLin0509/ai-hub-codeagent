'use strict';
// Stores observations only. Credentials remain with the CLI/browser/tool that owns them.
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const STATES = new Set(['signed_in','login_required','configured','unknown','offline','unavailable','opening']);
function maskIdentity(value) {
  const s = String(value || '').slice(0,160);
  if (s.includes('@')) { const [name,domain] = s.split('@'); return name.slice(0,1)+'•••@'+domain; }
  return s ? s.slice(0,2)+'•••'+s.slice(-4) : '身份未确认';
}
// A login window is only ever open for minutes. An admission older than this was abandoned
// (Hub closed, browser closed, user walked away) and must stop claiming a window is open.
const LEASE_TTL = 10 * 60 * 1000;
function safeObservation(raw = {}, previous = null) {
  const state = STATES.has(raw.state) ? raw.state : 'unknown';
  const observedAt = Number(raw.observedAt) || Date.now();
  return { state, identity:raw.identity ? maskIdentity(raw.identity) : '身份未确认',
    message:String(raw.message || '').slice(0,240), observedAt,
    // Remembering when we last saw real proof is what lets a closed browser say
    // "signed in, window closed" instead of the flatly wrong "not signed in".
    signedInAt: state === 'signed_in' ? observedAt : Number(previous?.signedInAt) || 0,
    // Which account this connection belongs to. Unlike `identity` (a masked observation)
    // this is the label the owning tool already keeps in plaintext next to its profile,
    // and it is what the UI shows — "同一个平台" is useless when two accounts share a card.
    accountLabel:String(raw.accountLabel || previous?.accountLabel || '').slice(0,120),
    source:String(raw.source || '连接检查').slice(0,80) };
}
// Reads only the display name/email the official CLI already wrote next to its own profile.
// Local file, no subprocess, no token value — and no proof of anything: a label is not a login.
function codexAccountLabel(home){
  try{const info=require('./codex-usage-scope').readCodexAuthInfo(home);return info.accountEmail||info.accountName||'';}
  catch{return '';}
}
class AccountCenter {
  constructor({ dataDir, getConfig, adapter, homeDir = os.homedir(), env = process.env, recovery }) {
    Object.assign(this,{dataDir,getConfig,adapter,homeDir,env});
    this.root=path.join(dataDir,'account-center');this.flights=new Map();this.batches=new Map();this.codeFlights=new Map();this.openFlights=new Map();
    this.recovery=recovery||new(require('./web-roundtable/recovery').AccountRecovery)({dataDir});
  }
  baseConnections() {
    const c=this.getConfig();
    const profiles=c.codexSubscriptionProfiles?.length?c.codexSubscriptionProfiles:[{id:'default',label:'主账号',home:''}];
    const native=(id,name,provider,home,uses)=>({id,name,provider,home:path.resolve(require('./codex-usage-scope').expandHomePath(home,this.homeDir)),type:'native',uses,action:'login',configProvider:provider});
    const rows=[native('claude','Claude Code','claude',this.env.CLAUDE_CONFIG_DIR || path.join(this.homeDir,'.claude'),['Claude 会话','开发群聊']),
      ...profiles.filter(p=>/^[\w-]{1,64}$/.test(p.id)).map(p=>{const row=native('codex-'+p.id,'Codex · '+p.label,'codex',p.home || path.join(this.homeDir,'.codex'),['Codex 会话','开发群聊']);return {...row,profileLabel:p.label,browserIdentity:p.browserIdentity,isDefault:p.id===(c.codexSubscriptionProfile || 'default'),accountLabel:codexAccountLabel(row.home)};}),
      native('gemini-cli','Gemini CLI','gemini',path.join(this.homeDir,'.gemini'),['Gemini 会话']),
      native('kimi','Kimi Code','kimi',this.env.KIMI_CODE_HOME || path.join(this.homeDir,'.kimi-code'),['Kimi 会话']),
      ...['deepseek','doubao','kimi','qwen','gemini','chatgpt'].map(p=>({id:'web-'+p,name:({deepseek:'DeepSeek',doubao:'豆包',kimi:'Kimi',qwen:'千问',gemini:'Gemini',chatgpt:'ChatGPT'})[p]+' · 网页',type:'web',provider:p,uses:['专用网页登录'],action:'login',managedBrowser:true,phoneLogin:['deepseek','doubao'].includes(p)})),
      ...['claude','codex','deepseek'].map(p=>({id:'api-'+p,name:({claude:'Claude 中转',codex:'Codex API',deepseek:'DeepSeek API'})[p],type:'api',provider:p,uses:[p+' API 会话'],action:'configure',configProvider:p,configured:!!c[p+'ApiKey']})),
      {id:'token-plan',name:'百炼 · Token Plan',type:'service',provider:'token-plan',uses:['Token Plan 用量'],action:'login'},
      {id:'feishu',name:'飞书 CLI · 用户授权',type:'service',provider:'feishu',uses:['飞书用户授权 / 通知身份检查'],action:'login'},
      {id:'server-monitor',name:'服务器监控授权',type:'service',provider:'server',uses:['工作台服务器监控'],action:'configure',configProvider:'server',configured:!!c.operations?.aliyunMonitor?.bearerToken},
    ];
    for(const row of rows)row.loginHint=row.managedBrowser?({deepseek:'短信验证码；也可微信扫码',doubao:'短信验证码；已有豆包或飞书 App 可扫码',kimi:'官网手机号或扫码登录',qwen:'官网手机号或账号扫码登录',gemini:'Google 已有账号或官方账号验证',chatgpt:'原登录方式：Google / Apple / Microsoft / 邮箱'})[row.provider]:row.type==='api'?'配置 API Key，不能用短信替代':row.provider==='images'||row.provider==='bridge'?'复用原工具浏览器中的已记住账号':row.provider==='codex'||row.provider==='claude'?'复用本机登录；失效时打开官方授权':row.provider==='feishu'?'官方设备授权；通知机器人单独配置':'官方工具提供的登录方式';
    for(const row of rows)if(row.managedBrowser&&row.provider==='gemini')row.loginHint='普通 Chrome 中手动登录 Google；完成后关闭该网站专用窗口，状态会自动确认';
    return rows;
  }
  async connections() {
    const rows=this.baseConnections();
    return rows;
  }
  file(id,suffix='json'){return path.join(this.root,crypto.createHash('sha256').update(id).digest('hex')+'.'+suffix);}
  read(id){try{return JSON.parse(fs.readFileSync(this.file(id),'utf8'));}catch(e){if(e.code==='ENOENT')return null;return {state:'unknown',message:'账号状态记录不可读，请重新检查',observedAt:0,source:'状态记录'};}}
  save(id,raw){fs.mkdirSync(this.root,{recursive:true});const value=safeObservation(raw,this.read(id));const file=this.file(id),tmp=file+'.'+process.pid+'.'+crypto.randomUUID()+'.tmp';fs.writeFileSync(tmp,JSON.stringify(value),'utf8');fs.renameSync(tmp,file);return value;}
  scope(row){const c=this.getConfig();const credential=row.provider==='server'?c.operations?.aliyunMonitor?.bearerToken:row.type==='api'?c[row.provider+'ApiKey']:'';return row.id+':'+(row.home || '')+':'+(credential?crypto.createHash('sha256').update(String(credential)).digest('hex'):'');}
  // Cheap local probes, plus anything with a login window currently open: while the user is
  // finishing an official login we poll that one connection so nobody has to press a check button.
  // 社区版（同事电脑）不自动读取本机已登录的 CLI 账号：只有用户点了「检查 / 登录」才查（2026-10-08 公司验收后用户要求）。
  // 用户自己刚打开的登录窗口仍会自动复查，免得登录完还要再点一次。
  autoCheck(row){if(require('./distribution').community)return row.action==='login'&&this.leaseActive(row);return !!row.managedBrowser||row.type==='native'&&['claude','codex'].includes(row.provider)||row.provider!=='images'&&row.action==='login'&&this.leaseActive(row);}
  // Asking these costs a browser: the bridge launches one to read the page, and the image
  // pool's check can only be serviced by a running lane. Their own records already say what
  // we would learn, so a status refresh reads those instead of starting anything.
  heavyProbe(row){return row.provider==='bridge'||row.provider==='images';}
  async checkAll(){
    const rows=await this.connections(),cheap=rows.filter(r=>!this.heavyProbe(r)),skipped=rows.length-cheap.length;
    let done=0,failed=0,index=0;
    const work=async()=>{while(index<cheap.length){const row=cheap[index++];try{await this.check(row.id,{quiet:true});done++;}catch{failed++;}}};
    await Promise.all(Array.from({length:Math.min(6,cheap.length)},work));
    this.log({name:'刷新状态'},`检查 ${cheap.length} 项：${done} 项有结果，${failed} 项未确认；${skipped} 项按工具自己的记录显示`);
    const tail=skipped?`；另有 ${skipped} 项按工具自己的记录显示，刷新不会为此启动浏览器。`:'。';
    return {checked:done,failed,skipped,message:(failed?`已刷新 ${done} 项；${failed} 项未取得明确状态`:`已刷新 ${done} 项账号状态`)+tail};
  }
  async snapshot(){
    const rows=await this.connections();
    const webTasks=this.recovery.list();
    await Promise.allSettled(rows.filter(row=>this.autoCheck(row)).map(async row=>{
      const key=this.scope(row),cached=this.read(key),waiting=this.leaseActive(row);
      // A pending login window is rechecked sooner so the user never has to press a check button.
      if(cached?.observedAt&&Date.now()-cached.observedAt<(waiting?8000:60000))return;
      // Same path as an explicit check, so a finished login clears its own lease. Web tasks
      // only continue when the Hub itself opened that login window.
      return this.check(row.id,{quiet:true,resume:waiting});
    }));
    const connections=rows.map(row=>{
      const key=this.scope(row),cached=this.read(key);
      if(require('./distribution').community&&row.type==='native'&&!cached){
        const {home,observation:unused,...safe}=row;
        return {...safe,signedInAt:0,accountLabel:'',state:'unknown',message:'未检查：点「检查」读取这台电脑上的登录状态，或点「登录」用你自己的账号登录',webRecovery:[],stale:false};
      }
      const observation=(row.observation && (!cached || row.observation.observedAt>cached.observedAt) ? row.observation : cached) || row.observation || {state:row.configured?'configured':'unknown',message:row.action==='configure'?(row.configured?'密钥已配置，尚未验证有效性':row.provider==='server'?'尚未配置密钥；公开监控端点可以不需要授权':'尚未配置密钥'):'尚未检查；可点登录或刷新状态',observedAt:0,source:'配置发现'};
      // Once the owning tool reports a login there is nothing left to wait for, even when the
      // proof came from its own listing instead of our check — drop the admission we took.
      let pending=this.leaseActive(row);
      if(pending&&observation.state==='signed_in'){this.clearLease(key,this.leaseToken(key));pending=false;}
      const {home,observation:unused,...safe}=row;
      return {...safe,signedInAt:0,accountLabel:'',...observation,...(row.accountLabel?{accountLabel:row.accountLabel}:{}),webRecovery:row.managedBrowser?webTasks.filter(t=>t.accountId===row.id):[],stale:!!observation.observedAt&&Date.now()-observation.observedAt>300000,pending};
    });
    // Whoever produced a snapshot with nothing pending has answered the pump's only question.
    if(this.pumpTimer&&!connections.some(r=>r.pending))this.stopPump();
    return {connections,history:this.history(),batches:[...this.batches.values()].slice(-3)};
  }
  history(){try{return fs.readFileSync(path.join(this.root,'events.jsonl'),'utf8').trim().split('\n').filter(Boolean).slice(-80).map(x=>JSON.parse(x)).reverse();}catch(e){if(e.code==='ENOENT')return [];return [{at:Date.now(),name:'活动记录',message:'记录不可读；未覆盖原文件'}];}}
  log(row,message){fs.mkdirSync(this.root,{recursive:true});fs.appendFileSync(path.join(this.root,'events.jsonl'),JSON.stringify({at:Date.now(),name:row.name,message})+'\n','utf8');}
  // Never throws and never deletes an admission it cannot read: an unreadable file normally
  // means another Hub is between creating and writing it, and status code must not race that.
  leaseActive(row){
    const file=this.file(this.scope(row),'login');
    let raw;
    try{raw=JSON.parse(fs.readFileSync(file,'utf8'));}
    catch(e){return e.code!=='ENOENT';}
    if(Date.now()-(Number(raw?.at)||0)<LEASE_TTL)return true;
    try{fs.unlinkSync(file);}catch{}
    return false;
  }
  leaseToken(key){try{return JSON.parse(fs.readFileSync(this.file(key,'login'),'utf8')).token;}catch(e){if(e.code==='ENOENT')return null;throw e;}}
  clearLease(key,token){if(!token||this.leaseToken(key)!==token)return;try{fs.unlinkSync(this.file(key,'login'));}catch(e){if(e.code!=='ENOENT')throw e;}}
  async row(id){const row=(await this.connections()).find(r=>r.id===id);if(!row)throw new Error('连接不存在，请刷新账号列表');return row;}
  // An explicit check still resumes the tasks that were waiting for this login. Only the
  // background poll passes resume:false, so it can never restart web tasks on its own.
  async check(id,{quiet=false,resume=true}={}){
    const row=await this.row(id),key=this.scope(row),token=this.leaseToken(key);
    const mayResume=resume!==false;
    if(this.flights.has(key))return this.flights.get(key);
    const promise=(async()=>{
      try {
        const raw=await this.adapter.check(row);const result=this.save(key,raw);
        if(result.state==='signed_in')for(const batch of this.batches.values()){const item=batch.items.find(x=>x.id===id);if(item)Object.assign(item,{stage:'signed_in',message:'已有明确登录证据'});}
        if(result.state==='signed_in')this.clearLease(key,token);
        if(!quiet)this.log(row,result.state==='signed_in'?'检查完成：已有登录证据':result.state==='login_required'?'检查完成：需要登录':'检查完成：'+result.message);
        if(result.state==='signed_in'&&row.managedBrowser&&mayResume){
          try{
            const resumed=await this.recovery.resume(row);result.recovery=resumed;
            if(resumed.started||resumed.errors.length){result.message=`登录已确认；已安排 ${resumed.started} 项原任务继续${resumed.errors.length?'，'+resumed.errors.length+' 项仍需处理：'+resumed.errors[0].message:'，已发送的问题只补收。'}`;this.log(row,`登录后恢复：${resumed.started} 项已安排，${resumed.errors.length} 项未完成`);}
          }catch(e){result.message='登录已确认，但任务恢复未完成：'+e.message;result.recovery={started:0,errors:[{message:e.message}]};this.log(row,'登录已确认，任务恢复失败；可再次检查重试');}
        }
        return result;
      }catch(e){this.save(key,{state:'unknown',message:'检查未完成；未将网络或工具错误判为未登录',source:'连接检查'});if(!quiet)this.log(row,'检查失败，请重试或打开原工具');throw new Error('检查失败：'+(e.code==='ENOENT'?'未找到所需工具':'工具未返回有效状态，请在原工具检查'));}
      finally{this.flights.delete(key);}
    })();this.flights.set(key,promise);return promise;
  }
  // "完成后自动确认" has to hold even when nobody is looking at the account page: the panel's
  // own polling dies with the page. While any login window is open, keep taking snapshots —
  // that one call refreshes the tool listings, rechecks the leased rows and releases the
  // admission the moment there is proof. It stops itself once no admission is left.
  pump(){
    if(this.pumpTimer)return;
    this.pumpTimer=setInterval(()=>{this.snapshot().catch(()=>{});},15000);
    this.pumpTimer.unref?.();
  }
  stopPump(){if(this.pumpTimer){clearInterval(this.pumpTimer);this.pumpTimer=null;}}
  async login(id,options={}){
    const row=await this.row(id);if(row.action!=='login')throw new Error('此连接通过接入配置管理');
    fs.mkdirSync(this.root,{recursive:true});const key=this.scope(row),file=this.file(key,'login'),token=crypto.randomUUID();
    if(this.leaseActive(row))return {pending:true,message:'这个账号的登录窗口已打开；完成验证后这里会自动确认'};
    let fd;try{fd=fs.openSync(file,'wx');}catch(e){if(e.code==='EEXIST')return {pending:true,message:'另一个 Hub 正在打开此账号的登录窗口'};throw e;}
    try{fs.writeFileSync(fd,JSON.stringify({at:Date.now(),pid:process.pid,token}));}finally{fs.closeSync(fd);}
    try{const result=await this.adapter.login(row,options);this.log(row,'已打开登录入口；完成本人验证后自动确认');this.pump();return {...result,pending:true,message:result.message || '已打开官方登录入口；完成验证后这里会自动确认'};}
    catch(e){this.clearLease(key,token);this.log(row,'登录入口打开失败');throw new Error('无法打开登录入口：'+(e.message || '请检查工具安装'));}
  }
  async open(id){
    const row=await this.row(id);
    if(row.type!=='web')throw Error('此连接没有网页入口，请使用官方登录或接入配置');
    const key=this.scope(row);
    if(this.openFlights.has(key))return this.openFlights.get(key);
    const flight=Promise.resolve().then(async()=>{
      try{
        const result=await this.adapter.open(row);
        this.log(row,'已请求打开原账号网页；登录状态仍以检查结果为准');
        return {...result,message:result?.message||'已打开原账号网页；未重新发起登录或短信'};
      }catch{
        this.log(row,'网页入口打开失败；原登录资料保留');
        throw Error('无法打开账号网页，请检查浏览器或原工具后重试');
      }finally{this.openFlights.delete(key);}
    });
    this.openFlights.set(key,flight);return flight;
  }
  async release(id){const row=await this.row(id);try{fs.unlinkSync(this.file(this.scope(row),'login'));}catch(e){if(e.code!=='ENOENT')throw e;}this.log(row,'结束登录等待；未退出账号、未关闭浏览器');return {ok:true};}
  async loginMany(ids,{phone=''}={}){
    if(!Array.isArray(ids)||ids.length<1||ids.length>24||ids.some(id=>typeof id!=='string'))throw Error('请选择 1 至 24 个登录账号');
    if(phone&&!/^1[3-9]\d{9}$/.test(phone))throw Error('请输入有效的中国大陆手机号');
    const rows=await this.connections(),unique=[...new Set(ids)];
    const chosen=unique.map(id=>{const row=rows.find(r=>r.id===id);if(!row||row.action!=='login')throw Error('选择中包含无效或无需登录的连接');return row;});
    if([...this.batches.values()].some(b=>b.running))throw Error('已有一批登录正在发起，请等待该批进入验证阶段');
    const batch={id:crypto.randomUUID(),at:Date.now(),running:true,items:chosen.map(r=>({id:r.id,name:r.name,stage:'queued',message:'排队等待登录检查'}))};
    this.batches.set(batch.id,batch);while(this.batches.size>3)this.batches.delete(this.batches.keys().next().value);
    let index=0;
    const work=async()=>{while(index<chosen.length){const n=index++,row=chosen[n],item=batch.items[n];item.stage='checking';item.message='先检查已有登录';
      try{let proof=row.observation?.state==='signed_in'&&Date.now()-row.observation.observedAt<60000?row.observation:null;try{if(!proof)proof=await this.check(row.id,{quiet:true});}catch{}
        if(proof?.state==='signed_in'){Object.assign(item,{stage:'signed_in',message:'已有有效登录，已跳过'});continue;}
        const value=await this.login(row.id,{phone:row.phoneLogin?phone:''});
        Object.assign(item,{stage:value.stage||'manual',message:value.message||'请在官方窗口完成验证'});
      }catch{Object.assign(item,{stage:'failed',message:'登录入口未完成，请检查原工具或单独重试'});}
    }};
    void Promise.all(Array.from({length:Math.min(3,chosen.length)},work)).finally(()=>{batch.running=false;phone='';});
    return {id:batch.id,message:'已开始批量检查并登录；已有登录会跳过，最多同时发起 3 个'};
  }
  async submitCode(id,code){
    if(typeof code!=='string'||!/^\d{4,8}$/.test(code))throw Error('请输入有效验证码');
    const row=await this.row(id);if(!row.phoneLogin)throw Error('此连接请在官方窗口完成验证');
    if(this.codeFlights.has(id))throw Error('此账号的验证码正在提交，请勿重复提交');
    this.codeFlights.set(id,true);
    try{const value=await this.adapter.submitCode(row,code);for(const batch of this.batches.values()){const item=batch.items.find(x=>x.id===id);if(item)Object.assign(item,{stage:value.stage,message:value.message});}return value;}
    finally{this.codeFlights.delete(id);}
  }
}
module.exports={AccountCenter,maskIdentity,safeObservation,codexAccountLabel};
