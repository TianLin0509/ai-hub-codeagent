'use strict';
// 助理自身的模型设置，以及助理分派任务时的三档配置。
// 具体型号只写在这里：助理只说档位或用户点名的后端/模型，模型升级时改这张表。
const {modelOptionsFor,isClaudeModelSelection,isCodexConversationModelId,DEFAULT_MODEL_BY_KIND}=require('../model-options');
const {getKindLabel}=require('../ai-kinds');
const CLAUDE_EFFORTS=['low','medium','high','xhigh','max'];
const EFFORT_LABELS={none:'不思考',minimal:'最低',low:'低',medium:'中',high:'高',xhigh:'超高',max:'最高',ultra:'极限'};
// 助理是前台路由，默认要快：低档模型、低思考。用户 2026-10-03 指定 Sonnet 5.5，备选 GPT-6 Luna。
const ASSISTANT_DEFAULT_KIND='claude';
const ASSISTANT_DEFAULTS={claude:{model:'claude-sonnet-5-5',effort:'low'},codex:{model:'gpt-6-luna',effort:'low'}};
// deep 不写型号：直接用 Hub「新建会话」的默认配置（用户在设置里选的默认模型 + 默认深度）。
const TASK_TIERS={
  fast:{label:'快速',kind:'claude',byKind:{claude:{model:'claude-sonnet-5-5',effort:'low'},codex:{model:'gpt-6-luna',effort:'low'}}},
  standard:{label:'标准',kind:'codex',byKind:{codex:{model:'gpt-6.1-sol',effort:'medium'},claude:{model:'claude-opus-5-5',effort:'medium'}}},
  deep:{label:'深度',kind:'codex',byKind:{}},
};
function effortsFor(kind,model){
  if(kind==='claude')return /haiku/i.test(model||'')?[]:[...CLAUDE_EFFORTS];
  if(kind==='codex')return require('../codex-model-catalog').describeCodexModelTuning(model).efforts;
  return [];
}
function validModel(kind,model){
  if(typeof model!=='string'||!model.trim()||model.length>160)return false;
  if(kind==='claude')return isClaudeModelSelection(model);
  if(kind==='codex')return isCodexConversationModelId(model);
  return modelOptionsFor(kind).some(option=>option.id===model);
}
// requested 是用户/助理点名的值，fallback 是档位或 Hub 默认值；点名值不合法时报错，让助理换一个说法重试。
function pick(kind,requested={},fallback={}){
  const model=requested.model||fallback.model||DEFAULT_MODEL_BY_KIND[kind];
  // 只校验点名的型号；Hub 默认配置来自用户设置，原样信任。
  if(requested.model&&!validModel(kind,model))throw new Error(`${getKindLabel(kind)} 没有模型「${model||'未指定'}」，请从该后端的模型列表中选择`);
  const efforts=effortsFor(kind,model);
  if(requested.effort&&efforts.length&&!efforts.includes(requested.effort))throw new Error(`${model} 不支持思考深度「${requested.effort}」，可选：${efforts.join(' / ')}`);
  let effort=requested.effort||fallback.effort||null;
  // 没有已知深度表的后端（千问、GLM 等）沿用 Hub 默认深度；Haiku 不接受深度参数。
  if(!efforts.length)effort=kind==='claude'?null:fallback.effort||null;
  else if(effort&&!efforts.includes(effort))effort=efforts.includes('low')?'low':efforts[0];
  return{model,effort};
}
function withModel(kind,defaults,{model,effort}){
  const opts={...defaults,model};
  if(effort)opts.effort=effort;else delete opts.effort;
  if(kind==='codex'&&model!==defaults.model){
    const contextMax=require('../codex-context-window').defaultCodexContextWindow(model);
    if(typeof contextMax==='number')opts.contextMax=contextMax;else delete opts.contextMax;
  }
  return opts;
}
function assistantProfile(kind,saved,defaults={}){
  return pick(kind,saved||{},{...defaults,...(ASSISTANT_DEFAULTS[kind]||{})});
}
function taskKind({tier,kind}={}){
  const name=tier||'deep';
  if(!TASK_TIERS[name])throw new Error('档位只能是 fast / standard / deep');
  return kind||TASK_TIERS[name].kind;
}
function resolveTask(request={},defaults={}){
  const tier=request.tier||'deep',kind=taskKind(request);
  const picked=pick(kind,{model:request.model,effort:request.effort},{...defaults,...(TASK_TIERS[tier].byKind[kind]||{})});
  return{tier,kind,model:picked.model,effort:picked.effort,opts:withModel(kind,defaults,picked),
    label:`${getKindLabel(kind)} · ${modelLabel(kind,picked.model)}${picked.effort?' · '+(EFFORT_LABELS[picked.effort]||picked.effort)+'思考':''}`};
}
function modelLabel(kind,model){return modelOptionsFor(kind).find(option=>option.id===model)?.label||model;}
function describe(kind,model,effort){
  return{kind,model,effort:effort||null,label:modelLabel(kind,model)+(effort?' · '+(EFFORT_LABELS[effort]||effort):'')};
}
// 手机端的选择面板只展示这里给出的后端、型号和深度，手机不内置型号表。
function phoneCatalog(kinds,defaultsFor=()=>({})){
  return kinds.map(kind=>{
    const fallback=assistantProfile(kind,null,defaultsFor(kind));
    const models=modelOptionsFor(kind).filter(option=>kind!=='claude'||/^claude-/.test(option.id)).map(option=>({id:option.id,label:option.label,efforts:effortsFor(kind,option.id)}));
    if(!models.some(option=>option.id===fallback.model))models.unshift({id:fallback.model,label:modelLabel(kind,fallback.model),efforts:effortsFor(kind,fallback.model)});
    return{kind,label:getKindLabel(kind),models,efforts:effortsFor(kind,fallback.model),defaultModel:fallback.model,defaultEffort:fallback.effort};
  });
}
module.exports={ASSISTANT_DEFAULT_KIND,ASSISTANT_DEFAULTS,TASK_TIERS,EFFORT_LABELS,effortsFor,validModel,pick,withModel,assistantProfile,taskKind,resolveTask,describe,phoneCatalog};
