'use strict';
const {serve}=require('./rpc'), jobs=require('./jobs'), store=require('./store'), {get}=require('./providers');
const provider=process.argv[2];get(provider);
const taskSchema={type:'object',properties:{task_id:{type:'string'}},required:['task_id'],additionalProperties:false};
const tools=[
  {name:'web_status',description:'Describe this provider and its persistent Hub browser profile. Cached task success does not prove current login.',inputSchema:{type:'object',properties:{},additionalProperties:false}},
  {name:'web_ask',description:'Start one website question asynchronously. Required request_id deduplicates calls across agents. reply_to continues a completed task in the SAME website conversation. Uses current website model/settings.',inputSchema:{type:'object',properties:{request_id:{type:'string'},prompt:{type:'string',minLength:1,maxLength:40000},reply_to:{type:'string'}},required:['request_id','prompt'],additionalProperties:false}},
  {name:'web_get',description:'Read durable task status, full final answer and source URL. Poll this until terminal. Does not send anything.',inputSchema:taskSchema},
  {name:'web_collect',description:'Read the original conversation again after a timeout/disconnect. NEVER resubmits the prompt. Requires a known submitted conversation.',inputSchema:taskSchema},
  {name:'web_resume',description:'After login/connection repair, retry a task ONLY if no submission was attempted. Otherwise collect from the original conversation without resending.',inputSchema:taskSchema},
  {name:'web_cancel',description:'Stop local waiting/queued work. Cannot guarantee stopping generation already running on the website.',inputSchema:taskSchema},
];
serve('ai-hub-web-'+provider,tools,async(name,args)=>{
  if(name==='web_status')return require('./status').providerStatus(provider);
  if(name==='web_ask')return jobs.ask(provider,args);
  const job=jobs.status(args.task_id);if(job.kind!=='web'||job.input.provider!==provider)throw Error('Task belongs to another MCP/provider');
  if(name==='web_get')return job;
  if(name==='web_collect')return jobs.collect(job.id,provider);
  if(name==='web_resume')return jobs.resumeWeb(job.id,provider);
  if(name==='web_cancel'){store.cancel(job.id);return {task_id:job.id,cancelRequested:true};}
});
