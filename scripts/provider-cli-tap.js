'use strict';
// Transparent ACP pipe under a real terminal client. Only the client controls
// the agent; Hub observes its exact requests/responses and never opens a writer.
const fs=require('node:fs');
const {spawn}=require('node:child_process');
const {Transform,pipeline}=require('node:stream');
const {StringDecoder}=require('node:string_decoder');
const launch=JSON.parse(process.env.AI_HUB_CLI_AGENT_LAUNCH);
const log=process.env.AI_HUB_CLI_EVENT_LOG;
const secrets=JSON.parse(process.env.AI_HUB_CLI_REDACT||'[]').filter(Boolean);
const child=spawn(launch.command,launch.args,{cwd:launch.cwd,env:process.env,windowsHide:true,stdio:['pipe','pipe','inherit']});
function tap(direction){let pending='';const decoder=new StringDecoder('utf8');return new Transform({transform(chunk,_encoding,callback){
  try{pending+=decoder.write(chunk);let end;while((end=pending.indexOf('\n'))>=0){const line=pending.slice(0,end);pending=pending.slice(end+1);
    if(line.trim()){const message=direction==='client'?require('../core/provider-cli-protocol').normalizeProviderCwd(JSON.parse(line),launch.mcpServers):JSON.parse(line);
      const observed=message.method==='authenticate'?{...message,params:{methodId:message.params?.methodId}}
        :message.params?.mcpServers?{...message,params:{...message.params,mcpServers:message.params.mcpServers.map(s=>({name:s.name,type:s.type}))}}:message;
      let record=JSON.stringify({direction,at:Date.now(),message:observed});
      for(const secret of secrets)record=record.split(JSON.stringify(secret).slice(1,-1)).join('[redacted]');
      fs.appendFileSync(log,record+'\n',{mode:0o600});
      this.push(JSON.stringify(message)+'\n');}}
    callback();
  }catch(error){callback(error);}
},flush(callback){
  pending+=decoder.end();
  callback(pending.trim()?new Error('CLI protocol ended with an incomplete JSON message'):null);
}});}
let failed=false;
function fail(error){if(failed)return;failed=true;console.error('[hub-cli-tap]',error.message);child.kill();process.exitCode=1;}
child.on('error',fail);
pipeline(process.stdin,tap('client'),child.stdin,error=>{if(error&&error.code!=='ERR_STREAM_PREMATURE_CLOSE')fail(error);});
pipeline(child.stdout,tap('agent'),process.stdout,error=>{if(error)fail(error);});
child.on('exit',(code)=>{if(code)process.exitCode=code;process.stdin.destroy();});
for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>child.kill());
