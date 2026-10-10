'use strict';
const fs=require('fs'),path=require('path'),http=require('http'),crypto=require('crypto');
const {OrdinarySession}=require('./ordinary-browser-session');
function statePath(root,identity){return path.join(root,'ordinary-daemon-'+identity+'.json');}
function category(error){const m=String(error?.message||error);return /Extension pairing/.test(m)?'Extension pairing required':/Extension ownership/.test(m)?'Extension ownership check failed':/Human handoff/.test(m)?'Human handoff':/Site challenged/.test(m)?'Site challenged':/Hub cooldown/.test(m)?'Hub cooldown':/Rate limited by Hub/.test(m)?'Rate limited by Hub':/No browser session/.test(m)?'No browser session':/IMAGE_TOOL_UNAVAILABLE/.test(m)?'IMAGE_TOOL_UNAVAILABLE':/strict mode violation/.test(m)?'strict mode violation':/Target.*closed/.test(m)?'Target closed':/timeout/i.test(m)?'Timeout':'Hub browser operation failed';}
async function serve(options){
  const file=statePath(options.browserRoot,options.identity),secret=crypto.randomBytes(24).toString('hex');
  const log=(event,extra={})=>fs.appendFileSync(path.join(options.browserRoot,'ordinary-daemon-'+options.identity+'.log'),JSON.stringify({at:Date.now()/1000,event,...extra})+'\n');
  const session=new OrdinarySession(options,{log}),chains=new Map();let lastCall=Date.now();
  const server=http.createServer((req,res)=>{
    if(req.method!=='POST'||req.url!=='/call'||req.headers['x-token']!==secret){res.writeHead(403);res.end();return;}
    let raw='';req.setEncoding('utf8');req.on('data',chunk=>{raw+=chunk;if(raw.length>1e6)req.destroy();});
    req.on('end',async()=>{
      let out,timer;lastCall=Date.now();
      try{
        const {lane,argv,timeoutMs=50000}=JSON.parse(raw);
        if(!/^[a-z0-9_-]{1,64}$/.test(lane||'')||!Array.isArray(argv)||!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>180000)throw Error('Invalid request');
        const command=require('./hub-browser-tool').argumentsOf(argv)[0];
        if(['human-open','transport-release'].includes(command)&&chains.size)throw Error('Browser busy');
        const work=(chains.get(lane)||Promise.resolve()).catch(()=>{}).then(()=>session.execute(lane,argv));
        const tail=work.catch(()=>{}).finally(()=>{if(chains.get(lane)===tail)chains.delete(lane);});chains.set(lane,tail);
        out={result:(await Promise.race([work,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Timeout')),timeoutMs);})]))??null};
      }catch(error){out={isError:true,error:category(error)};log('step_error',{error:out.error});}
      finally{clearTimeout(timer);}
      res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(out));
      if(out.error==='Timeout'){session.disconnect().catch(e=>log('disconnect_failed',{error:category(e)}));setTimeout(()=>process.exit(0),100).unref();}
    });
  });
  server.listen(0,'127.0.0.1',()=>{
    const state={protocol:1,pid:process.pid,port:server.address().port,token:secret,identity:options.identity,started:Date.now()/1000};
    const tmp=file+'.'+process.pid+'.tmp';fs.writeFileSync(tmp,JSON.stringify(state));fs.renameSync(tmp,file);log('listening',{port:state.port});
  });
  setInterval(()=>{if(session.risk.handoff(options.browserRoot))session.disconnect().catch(e=>log('disconnect_failed',{error:category(e)}));if(Date.now()-lastCall>6*3600000&&!chains.size)process.exit(0);},2000).unref();
}
if(require.main===module)serve(JSON.parse(process.argv[2])).catch(()=>{process.stderr.write('Ordinary browser daemon failed\n');process.exitCode=1;});
module.exports={statePath,category,serve};
