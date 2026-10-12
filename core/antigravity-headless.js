'use strict';
const {spawn}=require('child_process');
const {resolveCommand,cliEnv}=require('./antigravity-config');
function runPrompt(prompt,{env=cliEnv(process.env),timeoutMs=90000,spawnImpl=spawn}={}){
  return new Promise((resolve,reject)=>{
    const child=spawnImpl(resolveCommand(env),['--input-format','stream-json','--output-format','stream-json'],{env,windowsHide:true,stdio:['pipe','pipe','pipe']});
    let done=false,buffer='',stderr='',result=null;
    const finish=(error,value)=>{if(done)return;done=true;clearTimeout(timer);if(error)reject(error);else resolve(value);};
    const timer=setTimeout(()=>{child.kill();finish(Error('Antigravity 调用超时'));},timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data',chunk=>{
      buffer+=chunk;
      for(let p;(p=buffer.indexOf('\n'))>=0;){
        const line=buffer.slice(0,p);buffer=buffer.slice(p+1);if(!line.trim())continue;
        try{const e=JSON.parse(line);if(e.event==='result')result=e.result;}
        catch{child.kill();finish(Error('Antigravity 返回了无效的事件流'));return;}
      }
    });
    child.stderr.on('data',chunk=>{stderr=(stderr+chunk).slice(-2000);});
    child.on('error',error=>finish(Error('Antigravity 启动失败：'+error.message)));
    child.stdin.on('error',error=>{if(error.code!=='EPIPE')finish(error);});
    child.on('close',code=>{
      if(code!==0||result?.status!=='SUCCESS')return finish(Error(result?.error||`Antigravity 未成功完成（${code}）：${stderr.slice(-500)}`));
      if(typeof result.response!=='string'||!result.response.trim())return finish(Error('Antigravity 未返回正文'));
      finish(null,result.response);
    });
    child.stdin.end(JSON.stringify({event:'user',message:{content:prompt}})+'\n','utf8');
  });
}
module.exports={runPrompt};
