'use strict';
const fs=require('fs'),path=require('path'),os=require('os');
const {execFile,spawn}=require('child_process');
const {HubAccountBrowser:AccountBrowser}=require('./hub-account-browser');
function run(command,args,env,timeout=15000){return new Promise((resolve,reject)=>execFile(command,args,{env,windowsHide:true,timeout,maxBuffer:1024*1024,encoding:'utf8'},(error,stdout,stderr)=>{
 if(error&&(!Number.isInteger(error.code)||error.killed))return reject(error);
 resolve({code:error?.code||0,stdout,stderr});
}));}
function jsonResult(result){const lines=String(result.stdout).trim().split('\n');for(let i=lines.length-1;i>=0;i--){try{const v=JSON.parse(lines[i]);if(result.code||v.ok===false)throw Error('工具返回失败');return v;}catch(e){if(e.message==='工具返回失败')throw e;}}try{const v=JSON.parse(result.stdout);if(result.code||v.ok===false)throw Error('工具返回失败');return v;}catch{throw Error('未收到有效工具状态');}}
function quotePS(s){return "'"+String(s).replace(/'/g,"''")+"'";}
function openTerminal(command,args,env){
 // Fixed argv, quoted as PowerShell literals; no credential values in the command.
 const text='& '+[command,...args].map(quotePS).join(' ')+'; Write-Host "完成登录后返回 AI Hub，状态会自动确认。"';
 return new Promise((resolve,reject)=>{const p=spawn('powershell.exe',['-NoLogo','-NoProfile','-NoExit','-EncodedCommand',Buffer.from(text,'utf16le').toString('base64')],{env,windowsHide:false,detached:true,stdio:'ignore'});p.once('error',reject);p.once('spawn',()=>{p.unref();resolve({});});});
}
// The official Claude installer puts claude.exe in ~/.local/bin; a Hub started before the
// install may not have that folder on PATH yet. PATH wins when it already has claude.exe.
function resolveClaudeExe(env){
 const key=Object.keys(env).find(k=>k.toLowerCase()==='path')||'PATH';
 for(const dir of String(env[key]||'').split(path.delimiter).filter(Boolean)){const f=path.join(dir.replace(/^"|"$/g,''),'claude.exe');if(fs.existsSync(f))return f;}
 const local=path.join(env.USERPROFILE||os.homedir(),'.local','bin','claude.exe');
 return fs.existsSync(local)?local:'claude.exe';
}
function createAccountAdapters({dataDir,homeDir=os.homedir(),env=process.env,runImpl=run,terminal=openTerminal,browser=new AccountBrowser({dataDir,env}),getConfig=()=>require('./hub-config').getConfig(),onLoginComplete=()=>{}}={}){
 const isolated=!!env.CLAUDE_HUB_HOME_DIR;const py=path.join(env.LOCALAPPDATA||'','Programs/Python/Python312/python.exe');
 if(isolated && env.CLAUDE_HUB_ACCOUNT_FIXTURE){
  const fixture=env.CLAUDE_HUB_ACCOUNT_FIXTURE;
  const invoke=async(action,row={})=>jsonResult(await runImpl(process.execPath,[fixture,action,JSON.stringify({id:row.id,provider:row.provider,type:row.type})],{...env,ELECTRON_RUN_AS_NODE:'1'},5000));
  return {imageAccounts:async()=>(await invoke('images')).accounts.map(a=>({...a,accountLabel:a.account_name||''})),check:row=>invoke('check',row),open:row=>invoke('open',row),login:row=>invoke('login',row),submitCode:async()=>({stage:'checking',message:'夹具已接收验证码'})};
 }
 const codexLogin=new(require('./codex-browser-login').CodexBrowserLogin)({onComplete:onLoginComplete});
 const python=fs.existsSync(py)?py:'python';
 const toolsRoot=path.join(homeDir,'plugins/chatgpt-web-images/scripts');
 const bridgeRoot=null;
 const cleanEnv={...env,PYTHONUTF8:'1',PYTHONIOENCODING:'utf-8'};
 for(const key of ['CLAUDECODE','ANTHROPIC_API_KEY','ANTHROPIC_AUTH_TOKEN','ANTHROPIC_BASE_URL','OPENAI_API_KEY','OPENAI_BASE_URL','CODEX_API_KEY'])delete cleanEnv[key];
 function external(){if(isolated)throw Error('隔离 Hub 不访问真实工具账号');}
 function cliEnv(row){const e={...cleanEnv};if(isolated&&row.home){const rel=path.relative(homeDir,path.resolve(row.home));if(rel.startsWith('..')||path.isAbsolute(rel))throw Error('隔离账号路径超出测试 home');}if(row.provider==='codex')e.CODEX_HOME=path.resolve(row.home);if(row.provider==='claude')e.CLAUDE_CONFIG_DIR=row.home;if(row.provider==='kimi')e.KIMI_CODE_HOME=row.home;if(isolated){e.HOME=homeDir;e.USERPROFILE=homeDir;e.BAILIAN_CONFIG_DIR=path.join(homeDir,'.bailian');}return e;}
 async function tool(tool,action,accountId){external();const root=tool==='images'?toolsRoot:bridgeRoot;if(!fs.existsSync(root))throw Error('原工具未安装');return jsonResult(await runImpl(python,[path.resolve(__dirname,'../scripts/account-tool-adapter.py'),tool,action,root,...(accountId?[accountId]:[])],cleanEnv,45000));}
 const imageAccounts=async()=>{
  const data=await tool('images','status');return (data.accounts||[]).map(a=>({id:a.id,loginGroup:a.login_group||a.id,enabled:!!a.enabled,workerAlive:Date.now()/1000-a.heartbeat<20,accountLabel:String(a.account_name||'').slice(0,80),
   state:/login_required|credential_required|account_selection_required/.test(a.state)?'login_required':a.login_confirmed?'signed_in':'unknown',
   observedAt:a.checked_at*1000||0,message:a.control_pending?'原工具正在处理账号操作，请稍后检查':a.enabled?'原工具账号记录；额度与排队单独判断':'账号在原工具已停用'}));
 };
 return {imageAccounts,dispose:()=>codexLogin.close(),
 async open(row){
  external();
  if(row.managedBrowser)return browser.open(row.provider);
  if(row.provider==='images'){const v=await tool('images','open',row.accountId);return {message:(v.started_workers?'已唤醒生图池的工作进程并请求打开此账号网页；':'已请求原生图工具打开此账号网页；')+'不会重新提交图片任务'};}
  if(row.provider==='bridge'){await tool('bridge','login');return {message:'已打开原中转账号网页；未推进拉取记录'};}
  if(row.provider==='chatgpt-web')return require('./chatgpt-web-integration').openWebSettings();
  throw Error('此连接没有已适配的网页入口');
 },
 async check(row){
  if(row.managedBrowser)return browser.check(row.provider);
  if(row.action==='configure')return {state:row.configured?'configured':'unknown',message:row.configured?'密钥已配置；有效性和余额通过原服务入口验证':'尚未配置密钥',source:'本机配置'};
  if(row.provider==='images'){const v=await tool('images','check',row.accountId);return {state:'unknown',message:v.asleep?'这条生图车道没在运行；状态按生图池自己的记录显示，未为了检查而启动浏览器':'已在生图共享队列提交登录检查，请稍后刷新；未重新提交图片任务',source:'生图共享队列'};}
  if(row.provider==='bridge'){const v=await tool('bridge','check');return {state:v.logged_in?'signed_in':v.login_required?'login_required':'unknown',accountLabel:String(v.account_name||''),message:v.logged_in?'中转官方页面已确认登录；未读取或推进拉取游标':'请在原中转窗口完成验证',source:'中转浏览器'};}
  if(row.provider==='chatgpt-web'){external();const v=await require('./chatgpt-web-integration').webStatus();return {state:v.connected?'configured':'offline',message:v.connected?'原工具服务在线；网页登录须在原工具确认':v.message,source:'Codex Web GPT 服务健康，不是登录证明'};}
  if(row.provider==='claude'){
   const r=await runImpl(resolveClaudeExe(cliEnv(row)),['auth','status','--json'],cliEnv(row));let v;try{v=JSON.parse(r.stdout);}catch{throw Error('Claude 状态无效');}
   if(typeof v.loggedIn!=='boolean'||(r.code!==0&&v.loggedIn))throw Error('Claude 状态缺少登录证据');
   return {state:v.loggedIn?'signed_in':'login_required',identity:v.email,accountLabel:typeof v.email==='string'?v.email:'',message:v.loggedIn?'Claude 官方 CLI 已确认本机登录；会话仍保留启动身份':'Claude 官方 CLI 报告尚未登录',source:'claude auth status'};
  }
  if(row.provider==='codex'){
   try {require('./codex-auth-validation').assertUsableCredential(row.home);}catch {return {state:'login_required',message:'Codex 凭据不可用，请完成订阅授权',source:'本机凭据检查'};}
   const e=cliEnv(row),cmd=require('../main/codex-windows-command').resolveWindowsCodex(e);
   const r=await runImpl(cmd.command,[...cmd.args,'login','status'],cmd.env);const text=r.stdout+'\n'+r.stderr;
   if(r.code===0&&/logged in/i.test(text)&&!/not logged in/i.test(text)){const auth=require('./codex-usage-scope').readCodexAuthInfo(row.home);return {state:'signed_in',identity:auth.accountEmail,accountLabel:auth.accountEmail||auth.accountName,message:'Codex 官方 CLI 已确认本机登录；网页 ChatGPT 另行管理',source:'codex login status'};}
   if(/not logged in/i.test(text))return {state:'login_required',message:'Codex 官方 CLI 报告尚未登录',source:'codex login status'};
   throw Error('Codex 状态未确认');
  }
  if(row.provider==='kimi'){
   if(!fs.existsSync(path.join(row.home,'credentials','kimi-code.json')))return {state:'login_required',message:'未找到 Kimi 登录凭据，请登录',source:'Kimi 凭据发现'};
   let usage;try{usage=await require('../main/usage/kimi-account-usage').readKimiAccountUsage({home:row.home,env:cliEnv(row)});}catch(e){if(/登录已失效|尚未登录/.test(e.message))return {state:'login_required',message:'Kimi 官方接口确认登录已失效，请重新登录',source:'Kimi 官方接口'};throw e;}
   return {state:usage?'signed_in':'unknown',message:'Kimi 官方用量接口有响应；具体额度仍在侧栏展示',source:'Kimi 用量接口'};
  }
  if(row.provider==='gemini'){
   const present=fs.existsSync(path.join(row.home,'oauth_creds.json'));
   const api=!!(env.GEMINI_API_KEY||env.GOOGLE_API_KEY||env.GOOGLE_GENAI_USE_VERTEXAI);
   return {state:present||api?'configured':'login_required',message:present?'发现 Gemini CLI 登录记录；有效性需在官方 CLI 确认':api?'使用已配置的 Gemini 授权方式':'未发现 Gemini 登录记录，请完成官方登录',source:'Gemini 本地记录，不是有效性证明'};
  }
  if(row.provider==='token-plan'){
   const svc=require('../main/usage/token-plan-usage').createTokenPlanUsageService({env:cliEnv(row),...(isolated?{configDir:path.join(homeDir,'.bailian')}:{})});
   await svc.refresh(true);return {state:'signed_in',message:'百炼官方用量接口已返回计划数据',source:'百炼 CLI 用量接口'};
  }
  if(row.provider==='feishu'){
   external();const command=getConfig().notifications?.feishuCliPath||require('./completion-notifier').resolveDefaultFeishuCliPath(cleanEnv);
   const value=jsonResult(await runImpl(command,['auth','status','--json'],cleanEnv));const user=value.identities?.user,bot=value.identities?.bot;
   return {state:user?.available===true?'signed_in':user?.available===false?'login_required':'unknown',message:'这是 CLI 用户授权。回答通知使用独立机器人身份：'+(bot?.available===true?'已配置，投递结果以通知测试为准':'未确认，请在原 CLI 配置机器人'),source:'飞书 CLI 本机身份状态'};
  }
  return {state:'unknown',message:'此工具未提供已适配的只读登录检测；可直接打开官方登录入口',source:'官方工具'};
 },
 async submitCode(row,code){return browser.submitCode(row.provider,code);},
 async login(row,{phone=''}={}){
  if(row.managedBrowser){const opened=await browser.open(row.provider);if(phone&&row.phoneLogin){let ready=false;for(let i=0;i<8;i++){try{await browser.command(row.provider,'true');ready=true;break;}catch{await new Promise(r=>setTimeout(r,400));}}if(ready){try{return await browser.preparePhone(row.provider,phone);}catch{return {stage:'manual',message:'自动填写结果未确认，请查看官方窗口；不会自动重试短信请求'};}}return {stage:'manual',message:'浏览器未就绪，请在官方页面继续'};}return opened;}
  if(row.provider==='bridge'){await tool('bridge','login');return {message:'已打开原中转浏览器，完成登录后检查；未推进拉取记录'};}
  if(row.provider==='images'){await tool('images','open',row.accountId);return {message:'已交给生图共享队列打开原账号浏览器；当前图片任务不会重发'};}
  if(row.provider==='chatgpt-web'){external();return require('./chatgpt-web-integration').openWebSettings();}
  let e=cliEnv(row),command,args;
  if(row.provider==='codex'){if(isolated)throw Error('隔离 Hub 不打开真实 Codex 授权');return codexLogin.login(row,e);}
  else if(row.provider==='claude'){command=resolveClaudeExe(e);args=['auth','login'];}
  else if(row.provider==='kimi'){command='kimi.exe';args=['login'];}
  else if(row.provider==='gemini'){command='gemini';args=[];}
  else if(row.provider==='token-plan'){command='bl';args=['auth','login','--console'];}
  else if(row.provider==='feishu'){external();command=getConfig().notifications?.feishuCliPath||require('./completion-notifier').resolveDefaultFeishuCliPath(e);args=['auth','login'];}
  else throw Error('此连接没有登录入口');
  if(!path.isAbsolute(command)){
   const found=await runImpl('where.exe',[command],e,5000);
   if(found.code!==0)throw Error('未找到 '+command+'，请先安装官方 CLI');
  }
  return terminal(command,args,e);
 }};
}
module.exports={createAccountAdapters,quotePS,jsonResult,run,openTerminal,resolveClaudeExe};
