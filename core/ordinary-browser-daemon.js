'use strict';
const fs=require('fs'),path=require('path'),http=require('http'),crypto=require('crypto');
const {OrdinarySession}=require('./ordinary-browser-session');
const {Dispatcher}=require('./ordinary-browser-dispatch');
function statePath(root,identity){return path.join(root,'ordinary-daemon-'+identity+'.json');}
function category(error){const m=String(error?.message||error);return /Extension pairing/.test(m)?'Extension pairing required':/Extension ownership/.test(m)?'Extension ownership check failed':/Human handoff/.test(m)?'Human handoff':/Site challenged/.test(m)?'Site challenged':/Hub cooldown/.test(m)?'Hub cooldown':/Rate limited by Hub/.test(m)?'Rate limited by Hub':/No browser session/.test(m)?'No browser session':/IMAGE_TOOL_UNAVAILABLE/.test(m)?'IMAGE_TOOL_UNAVAILABLE':/strict mode violation/.test(m)?'strict mode violation':/Target.*closed/.test(m)?'Target closed':/timeout|deadline exceeded/i.test(m)?'Timeout':'Hub browser operation failed';}
async function serve(options){
  const file=statePath(options.browserRoot,options.identity),secret=crypto.randomBytes(24).toString('hex');
  const log=(event,extra={})=>fs.appendFileSync(path.join(options.browserRoot,'ordinary-daemon-'+options.identity+'.log'),JSON.stringify({at:Date.now()/1000,event,...extra})+'\n');
  const session=new OrdinarySession(options,{log}),dispatch=new Dispatcher(session),chains=dispatch.chains;let lastCall=Date.now();
  const server=http.createServer((req,res)=>{
    if(req.method!=='POST'||req.url!=='/call'||req.headers['x-token']!==secret){res.writeHead(403);res.end();return;}
    let raw='';req.setEncoding('utf8');req.on('data',chunk=>{raw+=chunk;if(raw.length>1e6)req.destroy();});
    req.on('end',async()=>{
      let out,lane,command;const started=Date.now();lastCall=started;
      try{
        const body=JSON.parse(raw),{argv,timeoutMs=50000}=body;lane=body.lane;
        if(!/^[a-z0-9_-]{1,64}$/.test(lane||'')||!Array.isArray(argv)||!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>180000)throw Error('Invalid request');
        command=require('./hub-browser-tool').argumentsOf(argv)[0];
        out={result:(await dispatch.call(lane,argv,timeoutMs))??null};
      }catch(error){out={isError:true,error:category(error)};log('step_error',{error:out.error,lane:/^[a-z0-9_-]{1,64}$/.test(lane||'')?lane:undefined,command:['run-code','open','goto','close','evaluate','keyboard'].includes(command)?command:undefined,durationMs:Date.now()-started});}
      res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(out));
    });
  });
  server.listen(0,'127.0.0.1',()=>{
    const state={protocol:1,pid:process.pid,port:server.address().port,token:secret,identity:options.identity,started:Date.now()/1000};
    const tmp=file+'.'+process.pid+'.tmp';fs.writeFileSync(tmp,JSON.stringify(state));fs.renameSync(tmp,file);log('listening',{port:state.port});
  });
  let stopping=false;
  setInterval(()=>{if(session.risk.handoff(options.browserRoot))session.disconnect().catch(e=>log('disconnect_failed',{error:category(e)}));else session.reapIdlePages({busyLanes:[...chains.keys()]}).catch(e=>log('idle_cleanup_failed',{error:category(e)}));if(!stopping&&Date.now()-lastCall>6*3600000&&!chains.size){stopping=true;session.disconnect().finally(()=>process.exit(0));}},2000).unref();
}
if(require.main===module)serve(JSON.parse(process.argv[2])).catch(()=>{process.stderr.write('Ordinary browser daemon failed\n');process.exitCode=1;});
module.exports={statePath,category,serve};
