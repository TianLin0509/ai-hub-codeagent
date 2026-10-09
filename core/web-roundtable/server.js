'use strict';
const {serve}=require('./rpc'),jobs=require('./jobs'),store=require('./store'),roundtable=require('./roundtable');
const {providers}=require('./providers');
const taskSchema={type:'object',properties:{task_id:{type:'string'}},required:['task_id'],additionalProperties:false};
serve('ai-hub-web-roundtable',[
  {name:'roundtable_providers',description:'List independent website MCP providers and supported features. This does not prove live login or quota.',inputSchema:{type:'object',properties:{},additionalProperties:false}},
  {name:'roundtable_start',description:'Start a durable website roundtable through independent provider MCP servers: parallel independent answers, optional debate rounds in the same conversations, synthesis and an offline HTML report. Share request_id/task_id across agents. rounds=1 means independent answers only; default 2. null synthesizer disables the extra synthesis call. Current website models/settings are preserved.',inputSchema:{type:'object',properties:{request_id:{type:'string'},prompt:{type:'string',maxLength:40000},providers:{type:'array',items:{type:'string',enum:Object.keys(providers)},minItems:1,uniqueItems:true},rounds:{type:'integer',minimum:1,maximum:3},synthesizer:{type:['string','null'],enum:[...Object.keys(providers),null]},continue_from:{type:'string'}},required:['request_id','prompt'],additionalProperties:false}},
  {name:'roundtable_get',description:'Read task progress, per-provider errorCode/nextAction, completed original answers, source URLs and HTML path. Use wait_seconds=20 while active to avoid frequent polling. quota_exhausted means wait for quota, NOT login or verification. No prompts sent.',inputSchema:{...taskSchema,properties:{...taskSchema.properties,wait_seconds:{type:'integer',minimum:0,maximum:20}}}},
  {name:'roundtable_resume',description:'Resume an interrupted or authentication-paused coordinator. Complete the account verification and resume/collect blocked children first, or use Hub Permissions Check and continue tasks. Deduplicates child calls; never resends uncertain submissions.',inputSchema:taskSchema},
  {name:'roundtable_refresh',description:'After collecting a timed-out child, refresh its final answer in a finished roundtable and regenerate HTML. Sends no prompts and does not replay debates.',inputSchema:taskSchema},
  {name:'roundtable_cancel',description:'Stop further debate and request cancellation of in-flight local child jobs. Remote website generation may continue.',inputSchema:taskSchema},
  {name:'roundtable_export',description:'Export current durable results as a self-contained UTF-8 HTML report, including incomplete and failed participants.',inputSchema:taskSchema},
],async(name,args)=>{
  if(name==='roundtable_providers')return {providers:Object.keys(providers).map(id=>({...require('./status').providerStatus(id),independentMcp:{command:process.execPath,args:[require('path').join(__dirname,'provider-server.js'),id]}})),loading:'Claude/Codex 新会话选择浏览器或全部加载 MCP；已运行的旧会话需要重新创建。'};
  if(name==='roundtable_start')return roundtable.start(args);
  const job=jobs.status(args.task_id);if(job.kind!=='roundtable')throw Error('Not a roundtable task');
  if(name==='roundtable_get')return require('./status').readProgress(job.id,args.wait_seconds || 0);
  if(name==='roundtable_resume')return roundtable.resume(job.id);
  if(name==='roundtable_refresh')return roundtable.refresh(job.id);
  if(name==='roundtable_export')return {task_id:job.id,path:require('./report').exportReport(job)};
  if(name==='roundtable_cancel')return roundtable.cancel(job.id);
});
