'use strict';
const {resolveCommand}=require('./antigravity-config');
function parseModels(text){
  const seen=new Set(),models=[];
  for(const line of String(text).replace(/\x1b\[[0-?]*[ -/]*[@-~]/g,'').split(/\r?\n/)){
    const m=/^\s*((?:gemini|claude|gpt-oss)[\w.-]+)\s+(.+?)\s*$/.exec(line);
    if(m&&!seen.has(m[1])){seen.add(m[1]);models.push({id:m[1],label:m[2]});}
  }
  return models;
}
async function readModelCatalog({env=process.env,runImpl=require('./account-adapters').run}={}){
  if(env.CLAUDE_HUB_HOME_DIR&&!env.AI_HUB_ANTIGRAVITY_COMMAND)return {ok:false,models:[],error:'隔离 Hub 不读取真实 Antigravity 账号'};
  try{
    const r=await runImpl(resolveCommand(env),['models'],env,30000),models=parseModels(r.stdout);
    if(r.code!==0||!models.length)return {ok:false,models:[],error:/sign in/i.test(r.stdout+r.stderr)?'请先完成 Antigravity Google 登录':'未收到有效的 Antigravity 模型清单'};
    return {ok:true,models,source:'agy models',observedAt:Date.now()};
  }catch(error){return {ok:false,models:[],error:error.message};}
}
module.exports={parseModels,readModelCatalog};
