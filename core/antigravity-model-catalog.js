'use strict';
const {resolveCommand,cliEnv}=require('./antigravity-config');
// `agy models` starts a full language server and refreshes OAuth (5-15 s). The
// new-session dialog asks on open and again on submit, so share one call.
const SUCCESS_TTL_MS=10*60*1000,FAILURE_TTL_MS=60*1000;
let cached=null,inflight=null;
function parseModels(text){
  const seen=new Set(),models=[];
  for(const line of String(text).replace(/\x1b\[[0-?]*[ -/]*[@-~]/g,'').split(/\r?\n/)){
    const m=/^\s*((?:gemini|claude|gpt-oss)[\w.-]+)\s+(.+?)\s*$/.exec(line);
    if(m&&!seen.has(m[1])){seen.add(m[1]);models.push({id:m[1],label:m[2]});}
  }
  return models;
}
async function fetchModelCatalog({env,runImpl}){
  if(env.CLAUDE_HUB_HOME_DIR&&!env.AI_HUB_ANTIGRAVITY_COMMAND)return {ok:false,models:[],error:'隔离 Hub 不读取真实 Antigravity 账号'};
  try{
    const e=cliEnv(env),r=await runImpl(resolveCommand(e),['models'],e,30000),models=parseModels(r.stdout);
    const loginRequired=/please sign in|not signed in|sign in to view|not logged in/i.test(r.stdout+'\n'+r.stderr);
    if(r.code!==0||!models.length)return {ok:false,models:[],loginRequired,error:loginRequired?'请先完成 Antigravity Google 登录':'未收到有效的 Antigravity 模型清单'};
    return {ok:true,models,source:'agy models',observedAt:Date.now()};
  }catch(error){return {ok:false,models:[],error:error.message};}
}
function readModelCatalog({env=process.env,runImpl=require('./account-adapters').run,force=false,now=Date.now}={}){
  if(!force&&cached&&now()-cached.at<(cached.value.ok?SUCCESS_TTL_MS:FAILURE_TTL_MS))return Promise.resolve(cached.value);
  if(inflight)return inflight;
  inflight=fetchModelCatalog({env,runImpl}).then(value=>{cached={at:now(),value};return value;}).finally(()=>{inflight=null;});
  return inflight;
}
function resetModelCatalogCache(){cached=null;inflight=null;}
module.exports={parseModels,readModelCatalog,resetModelCatalogCache};
