'use strict';
const fs=require('fs'),path=require('path');
const {spawn}=require('child_process');
const WebSocket=require('ws');
const SITES={deepseek:'https://chat.deepseek.com/',doubao:'https://www.doubao.com/chat/',kimi:'https://www.kimi.com/',qwen:'https://www.qianwen.com/',gemini:'https://gemini.google.com/app',chatgpt:'https://chatgpt.com/'};
// Read visible UI only. A guest composer is deliberately insufficient evidence.
const PROBE=`(()=>{const visible=e=>!!e&&e.getClientRects().length>0;
 const labels=[...document.querySelectorAll('button,a,[role="button"]')].filter(visible).map(e=>(e.innerText||e.getAttribute('aria-label')||'').trim());
 const login=labels.some(t=>/^(log in|sign in|登录|登入|登录帐号|登录账号)$/i.test(t));
 const named=selector=>[...document.querySelectorAll(selector)].some(e=>visible(e)&&e.textContent.trim()&&!/登录|sign in|log in/i.test(e.textContent));
 const profile=[...document.querySelectorAll('[data-testid="accounts-profile-button"],[aria-label*="Google Account"],[aria-label*="Google 帐号"],[aria-label*="Google 账号"],[data-testid="user-avatar"]')].some(visible)
  ||(location.hostname==='chatgpt.com'&&[...document.querySelectorAll('button[aria-label="Open profile menu"]')].some(visible))
  ||(location.hostname==='www.doubao.com'&&named('nav [data-slot="dropdown-menu-trigger"]')&&labels.includes('设置'))
  ||(location.hostname==='chat.deepseek.com'&&[...document.querySelectorAll('.ede5bc47 > img.fdf01f38')].some(visible))
  ||(location.hostname==='www.kimi.com'&&named('[data-testid="sidebar-user-menu-trigger"] .user-name'))
  ||(location.hostname==='www.qianwen.com'&&named('[class~="bg-pc-sidebar"][class~="pt-3"] > button.text-left'));
 // Observed on ChatGPT and Claude in the Hub's headless profiles, 2026-09-27:
 // the top-level Cloudflare gate has no iframe. A title alone is not enough proof.
 const challenge=(${require('./web-risk-guard').CHALLENGE_PROBE}).challenge;
 return {login,profile,challenge,host:location.hostname};})()`;
class AccountBrowser {
 constructor({dataDir,env=process.env,spawnImpl=spawn}){this.root=path.join(dataDir,'account-browsers');this.env=env;this.spawn=spawnImpl;}
 profileOwners(provider){return require('./account-browser-processes').profileOwners(this.profile(provider));}
 openProbe(provider,url,options){return require('./web-roundtable/cdp').open(provider,url,options);}
 profile(provider){if(!SITES[provider])throw Error('不支持的网页登录');return path.join(this.root,provider);}
 executable(){const candidates=[path.join(this.env.PROGRAMFILES||'C:\\Program Files','Google/Chrome/Application/chrome.exe'),path.join(this.env['PROGRAMFILES(X86)']||'C:\\Program Files (x86)','Microsoft/Edge/Application/msedge.exe'),path.join(this.env.LOCALAPPDATA||'','Google/Chrome/Application/chrome.exe')];const found=candidates.find(p=>fs.existsSync(p));if(!found)throw Error('未找到 Chrome 或 Edge 浏览器');return found;}
 async command(provider,expression,{activate=false}={}){
  const port=Number(fs.readFileSync(path.join(this.profile(provider),'DevToolsActivePort'),'utf8').split('\n')[0]);
  if(!Number.isInteger(port)||port<1024||port>65535)throw Error('浏览器地址无效');
  const response=await fetch('http://127.0.0.1:'+port+'/json/list',{signal:AbortSignal.timeout(3000)});if(!response.ok)throw Error('浏览器未就绪');
  const tabs=await response.json(),host=new URL(SITES[provider]).hostname;
  const tab=tabs.find(t=>{try{return t.type==='page'&&new URL(t.url).hostname===host;}catch{return false;}});if(!tab)throw Error('请在专用浏览器打开对应官方页面');
  const url=new URL(tab.webSocketDebuggerUrl);if(!['localhost','127.0.0.1'].includes(url.hostname)||Number(url.port)!==port)throw Error('浏览器地址无效');
  return new Promise((resolve,reject)=>{const ws=new WebSocket(url.href);let ended=false;const timer=setTimeout(()=>done(Error('页面操作超时，请检查官方窗口')),6000);
   const done=(error,value)=>{if(ended)return;ended=true;clearTimeout(timer);ws.close();error?reject(error):resolve(value);};
   ws.on('error',()=>done(Error('无法连接专用浏览器')));ws.on('close',()=>done(Error('专用浏览器已断开')));
   const evaluate=()=>ws.send(JSON.stringify({id:1,method:'Runtime.evaluate',params:{expression:`location.hostname===${JSON.stringify(host)}?(${expression}):({stage:'manual',message:'页面已跳转，请在官方窗口继续'})`,returnByValue:true,awaitPromise:true,userGesture:true}}));
   ws.on('open',()=>activate?ws.send(JSON.stringify({id:2,method:'Page.bringToFront'})):evaluate());
   ws.on('message',bytes=>{try{const value=JSON.parse(bytes);if(value.id===2&&activate){if(value.error)return done(Error('无法显示账号网页'));evaluate();return;}if(value.id!==1)return;if(value.error||value.result?.exceptionDetails)return done(Error('官方页面操作未完成，请人工继续'));done(null,value.result?.result?.value);}catch{done(Error('页面未返回有效状态'));}});
  });
 }
 async preparePhone(provider,phone){
  if(!['deepseek','doubao'].includes(provider))return {stage:'manual',message:'此站点请在官方窗口选择短信、扫码或已有账号登录'};
  if(!/^1[3-9]\d{9}$/.test(phone))throw Error('请输入有效的中国大陆手机号');
  for(let attempt=0;attempt<10;attempt++){
   const value=await this.command(provider,`(${phoneStep.toString()})(${JSON.stringify(provider)},${JSON.stringify(phone)})`);
   if(value?.stage!=='advance')return value;
   await new Promise(r=>setTimeout(r,300));
  }
  return {stage:'manual',message:'页面未进入下一步，请在官方窗口继续；不会自动重复发送短信'};
 }
 async submitCode(provider,code){
  if(!['deepseek','doubao'].includes(provider)||!/^\d{4,8}$/.test(code))throw Error('验证码或站点无效');
  return this.command(provider,`(${codeStep.toString()})(${JSON.stringify(provider)},${JSON.stringify(code)})`);
 }
 async open(provider){
  this.profile(provider);
  if(provider==='gemini')return this.openManual(provider);
  const lease=path.join(path.dirname(this.root),'web-roundtable','browser-'+provider+'.lock','owner.json');
  try{const owner=JSON.parse(fs.readFileSync(lease,'utf8'));if(require('./web-roundtable/store').alive(owner.pid))throw Error('此账号正在执行网页 MCP 任务。请等待任务结束或取消后，再打开可见网页；登录资料会保留。');}catch(error){if(error.code!=='ENOENT')throw error;}
  try{const existing=await this.command(provider,'({ready:true})',{activate:true});if(existing?.ready)return {message:'已显示此账号的原网页；登录状态以检查结果为准',reused:true};}catch{}
  const dir=this.profile(provider);fs.mkdirSync(dir,{recursive:true});await new Promise((resolve,reject)=>{const child=spawn(this.executable(),['--user-data-dir='+dir,'--remote-debugging-port=0','--no-first-run','--no-default-browser-check','--new-window',SITES[provider]],{env:this.env,windowsHide:false,detached:true,stdio:'ignore'});child.once('error',reject);child.once('spawn',()=>{child.unref();resolve();});});return {message:'已打开此账号的专用浏览器；登录资料会保留，状态以检查结果为准。'};
 }
 async check(provider){
  if(provider==='gemini')return this.checkManual(provider);
  let port;try{port=Number(fs.readFileSync(path.join(this.profile(provider),'DevToolsActivePort'),'utf8').split('\n')[0]);}catch(e){if(e.code==='ENOENT')return {state:'unknown',message:'尚无运行中的专用浏览器；点击登录',source:'专用浏览器'};throw e;}
  if(!Number.isInteger(port)||port<1024||port>65535)throw Error('浏览器调试地址无效');
  let tabs;try{const response=await fetch('http://127.0.0.1:'+port+'/json/list',{signal:AbortSignal.timeout(3000)});if(!response.ok)throw Error('CDP unavailable');tabs=await response.json();}catch{return {state:'offline',message:'浏览器未在线；本地登录配置仍保留，打开后再检查',source:'专用浏览器'};}
  const host=new URL(SITES[provider]).hostname;
  const tab=Array.isArray(tabs)&&tabs.find(t=>{try{return t.type==='page'&&new URL(t.url).hostname===host;}catch{return false;}});
  if(!tab?.webSocketDebuggerUrl)return {state:'unknown',message:'未找到目标网站页面；请在专用浏览器完成登录',source:'专用浏览器'};
  const wsURL=new URL(tab.webSocketDebuggerUrl);if(!['127.0.0.1','localhost'].includes(wsURL.hostname)||Number(wsURL.port)!==port)throw Error('无效浏览器连接');
  const result=await new Promise((resolve,reject)=>{
   const ws=new WebSocket(wsURL.href);const timer=setTimeout(()=>done(Error('浏览器检查超时')),5000);let ended=false;
   function done(error,value){if(ended)return;ended=true;clearTimeout(timer);ws.close();error?reject(error):resolve(value);}
   ws.on('error',e=>done(e));ws.on('close',()=>done(Error('浏览器连接关闭')));
   ws.on('open',()=>ws.send(JSON.stringify({id:1,method:'Runtime.evaluate',params:{expression:PROBE,returnByValue:true}})));
   ws.on('message',bytes=>{try{const m=JSON.parse(bytes);if(m.id===1){if(m.error||m.result?.exceptionDetails)return done(Error('网页检查失败'));done(null,m.result?.result?.value);}}catch(e){done(e);}});
  });
  if(result?.host!==host)throw Error('网页身份检查期间页面已切换');
  return {state:result.challenge?'unknown':result.login?'login_required':result.profile?'signed_in':'unknown',
   message:result.challenge?'请在官方页面完成人机验证':result.login?'网站显示登录入口':result.profile?'当前官方页面显示账号入口；具体功能额度另行确认':'未取得明确登录证据；请查看官方页面，不能仅凭输入框判断',source:'官方网页可见状态'};
 }
 async openManual(provider){
  const release=require('./web-roundtable/store').acquire('browser-'+provider,path.join(path.dirname(this.root),'web-roundtable'));
  if(!release)return {stage:'manual',message:'此账号正在检查或执行任务，请稍后再打开登录窗口。'};
  try{
   const owners=await this.profileOwners(provider);
   if(owners.some(p=>p.automated))return {stage:'manual',message:'请先关闭此网站的旧专用浏览器窗口，再点“打开网页”，以普通 Chrome 完成 Google 登录；原登录资料会保留。'};
   const dir=this.profile(provider);fs.mkdirSync(dir,{recursive:true});
   await new Promise((resolve,reject)=>{const child=this.spawn(this.executable(),['--user-data-dir='+dir,'--no-first-run','--no-default-browser-check','--new-window',SITES[provider]],{env:this.env,windowsHide:false,detached:true,stdio:'ignore'});child.once('error',reject);child.once('spawn',()=>{child.unref();resolve();});});
   return {stage:'manual',message:'已打开普通 Chrome 登录窗口。请在官网完成 Google 验证，然后关闭此网站的全部专用窗口，返回 Hub 点“检查登录”；登录资料会保留。'};
  }finally{release();}
 }
 async checkManual(provider){
  const unknown=message=>({state:'unknown',message,source:'官方手动登录窗口'});
  const release=require('./web-roundtable/store').acquire('browser-'+provider,path.join(path.dirname(this.root),'web-roundtable'));
  if(!release)return unknown('此账号正在检查或执行任务，请稍后重试');
  try{
   const owners=await this.profileOwners(provider);
   if(owners.length)return unknown(owners.some(p=>p.automated)?'请关闭此网站的旧专用浏览器，再点“打开网页”使用普通 Chrome 登录。':'请先在官方窗口完成登录，然后关闭此网站的全部专用窗口，再点“检查登录”；不会在输入密码时接管浏览器。');
   if(!fs.existsSync(path.join(this.profile(provider),'Default')))return unknown('尚无登录记录；点击登录，在普通 Chrome 中完成 Google 验证');
   return await this.probeClosedManual(provider);
  }finally{release();}
 }
 async probeClosedManual(provider){
  const browser=await this.openProbe(provider,SITES[provider],{dataDir:path.dirname(this.root)}),host=new URL(SITES[provider]).hostname;
  try{
   for(const end=Date.now()+15000;Date.now()<end;){
    const result=await browser.page.evaluate(PROBE);
    if(result?.host==='accounts.google.com')return {state:'login_required',message:'Google 仍要求登录，请打开普通 Chrome 完成本人验证；程序不会填写 Google 登录表单。',source:'官方网页跳转'};
    if(result?.host===host){
     if(result.challenge)return {state:'unknown',message:'请打开官方窗口完成人机验证',source:'官方网页可见状态'};
     if(result.login)return {state:'login_required',message:'网站显示登录入口，请在普通 Chrome 登录',source:'官方网页可见状态'};
     if(result.profile)return {state:'signed_in',message:'官方网页已确认登录；资料保留在原专用浏览器，额度另行确认。',source:'官方网页可见状态'};
    }
    await new Promise(r=>setTimeout(r,250));
   }
   return {state:'unknown',message:'未取得明确登录证据；请打开官方网页核对',source:'官方网页可见状态'};
  }finally{await browser.close();}
 }
}
// Fixed selectors inspected on the official login pages. Never solve challenges or retry SMS.
function phoneStep(provider,phone){
 const visible=e=>e&&e.getClientRects().length>0;
 const elements=selector=>[...document.querySelectorAll(selector)].filter(visible);
 const click=names=>{const candidates=elements('button,[role="button"]').filter(e=>names.includes(e.innerText.trim())&&!e.disabled&&e.getAttribute('aria-disabled')!=='true');if(candidates.length!==1)return false;candidates[0].click();return true;};
 const fill=(input,value)=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,value);input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new Event('change',{bubbles:true}));};
 const stage=(stage,message)=>({stage,message});
 if(document.querySelector('.ds-shumei-captcha-modal,iframe[src*="challenges.cloudflare.com"],[class*="captcha_verify_container"]'))return stage('manual','短信发送前需要本人在官方窗口完成人机验证');
 const sent=elements('button,[role="button"]').some(e=>/重新发送\s*\d|\d+\s*s$|resend.*\d/i.test(e.innerText));
 if(sent)return stage('waiting_code','网站正在验证码等待期，请输入收到的验证码');
 if(provider==='deepseek'){
  const inputs=elements('input');const input=inputs.find(e=>/phone number|手机号/i.test(e.placeholder));
  if(!input)return stage('manual','请查看 DeepSeek 官方窗口，确认当前账号或选择短信登录');
  if(input.dataset.hubSmsRequested)return stage('advance','等待短信申请结果');
  if(input.value!==phone){fill(input,phone);return stage('advance','正在填写手机号');}
  if(!click(['Send code','发送验证码','获取验证码']))return stage('manual','未找到可用的验证码按钮，请在官方窗口继续');
  input.dataset.hubSmsRequested='1';return stage('advance','正在读取短信申请结果');
 }
 const dialog=elements('[role="dialog"]')[0];
 if(!dialog){if(click(['登录']))return stage('advance','正在打开登录窗口');return stage('manual','请查看豆包官方窗口，确认当前账号');}
 if(/验证码已发送/.test(dialog.innerText))return stage('waiting_code','豆包已发送验证码，请输入验证码');
 if(click(['手机号登录']))return stage('advance','正在选择手机号登录');
 const input=elements('input').find(e=>e.placeholder==='请输入手机号');
 if(!input)return stage('manual','请在豆包官方登录窗口继续');
 if(input.dataset.hubSmsRequested)return stage('advance','等待短信申请结果');
 if(input.value!==phone){fill(input,phone);return stage('advance','正在填写手机号');}const agreement=dialog.querySelector('input[type="checkbox"],[role="checkbox"]');
 if(agreement&&!agreement.checked&&agreement.getAttribute('aria-checked')!=='true'){agreement.click();return stage('advance','正在确认登录协议');}
 if(!click(['下一步']))return stage('manual','下一步不可用，请在官方窗口确认手机号和协议');
 input.dataset.hubSmsRequested='1';return stage('advance','正在读取短信申请结果');
}
async function codeStep(provider,code){
 const visible=e=>e&&e.getClientRects().length>0;const dialog=[...document.querySelectorAll('[role="dialog"]')].find(visible);
 if(provider==='doubao'&&(!dialog||!/请输入验证码|验证码已发送/.test(dialog.innerText)))return {stage:'manual',message:'当前不是验证码步骤，请先在官方窗口申请验证码'};
 const inputs=[...(provider==='doubao'&&dialog?dialog:document).querySelectorAll('input')].filter(visible);
 const input=provider==='deepseek'?inputs.find(e=>/^(code|验证码|请输入验证码)$/i.test(e.placeholder)):inputs.length===1?inputs[0]:null;
 if(!input)return {stage:'manual',message:'未找到唯一验证码输入框，请在官方窗口输入'};
 Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,code);input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new Event('change',{bubbles:true}));
 // Let the official form consume its input event before invoking its submit control.
 await new Promise(resolve=>setTimeout(resolve,0));
 if(provider==='deepseek'){const buttons=[...document.querySelectorAll('button,[role="button"]')].filter(e=>visible(e)&&!e.disabled&&e.getAttribute('aria-disabled')!=='true'&&/^(Log in|登录)$/i.test(e.innerText.trim()));if(buttons.length!==1)return {stage:'manual',message:'验证码已填写，请在官方窗口确认登录'};buttons[0].click();}
 return {stage:'checking',message:'验证码已填写，请检查登录；结果以官方页面为准'};
}
module.exports={AccountBrowser,SITES,PROBE,phoneStep,codeStep};
