'use strict';
const fs=require('fs'),path=require('path'),{spawn}=require('child_process');
const {statePath}=require('./ordinary-browser-daemon');
const {pairingFile}=require('./ordinary-browser-session');
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function read(file){try{return JSON.parse(fs.readFileSync(file,'utf8'));}catch{return null;}}
function options(binding={},env=process.env){
  const browserRoot=binding.browserRoot||require('./personal-chrome').personalRoot(env);
  const playwright=binding.playwright||require.resolve('playwright');
  const identity=binding.identity||'main';return {browserRoot,playwright,identity,tokenFile:binding.tokenFile||pairingFile(browserRoot,identity)};
}
function enabled(binding={},env=process.env){
  if(binding.transport==='extension')return true;if(binding.transport==='cdp')return false;
  if(env.HUB_BROWSER_TRANSPORT==='extension')return true;
  // Fixtures/custom CDP roots never discover the production ordinary browser.
  if(env.HUB_CHROME_ROOT&&!env.HUB_PERSONAL_CHROME_ROOT&&!env.CLAUDE_HUB_DATA_DIR&&!env.CLAUDE_HUB_HOME_DIR)return false;
  if(binding.root&&path.resolve(binding.root).toLowerCase()!==path.resolve(require('./hub-chrome').defaultRoot(env)).toLowerCase())return false;
  const root=binding.browserRoot||require('./personal-chrome').personalRoot(env),config=read(path.join(root,'ordinary-automation.json'));
  return config?.version===1&&config.transport==='extension'&&config.identities?.includes(binding.identity||'main');
}
async function alive(state){
  if(state?.protocol!==1)return false;try{process.kill(state.pid,0);}catch{return false;}
  try{return (await fetch(`http://127.0.0.1:${state.port}/call`,{method:'POST',signal:AbortSignal.timeout(1500)})).status===403;}catch{return false;}
}
async function ensure(opts){
  const file=statePath(opts.browserRoot,opts.identity);fs.mkdirSync(opts.browserRoot,{recursive:true});
  let state=read(file);if(await alive(state))return state;
  const lock=file+'.lock';let fd;
  try{fd=fs.openSync(lock,'wx');}catch(e){if(e.code!=='EEXIST')throw e;if(Date.now()-fs.statSync(lock).mtimeMs>30000)throw Error('Ordinary browser start lock is stale');}
  try{
    if(fd!==undefined&&!await alive(read(file))){const child=spawn(process.execPath,[path.join(__dirname,'ordinary-browser-daemon.js'),JSON.stringify(opts)],{env:{...process.env,ELECTRON_RUN_AS_NODE:'1'},windowsHide:true,detached:true,stdio:'ignore'});child.unref();}
    for(let n=0;n<60;n++){state=read(file);if(await alive(state))return state;await sleep(250);}throw Error('Ordinary browser unavailable');
  }finally{if(fd!==undefined){fs.closeSync(fd);fs.unlinkSync(lock);}}
}
async function call(binding,lane,argv,timeoutMs=50000){
  const opts=options(binding),state=await ensure(opts);
  const r=await fetch(`http://127.0.0.1:${state.port}/call`,{method:'POST',headers:{'content-type':'application/json','x-token':state.token},body:JSON.stringify({lane,argv,timeoutMs}),signal:AbortSignal.timeout(timeoutMs+5000)});
  if(!r.ok)throw Error('Ordinary browser HTTP failure');const out=await r.json();if(out.isError)throw Error(out.error);if(!Object.hasOwn(out,'result'))throw Error('Ordinary browser protocol failure');return out.result;
}
async function main(binding,argv=process.argv.slice(2)){
  let out;try{out={result:await call(binding,binding.id,argv,Number(process.env.CHATGPT_WEB_IMAGES_STEP_TIMEOUT_MS)||50000)};}
  catch(error){out={isError:true,error:require('./ordinary-browser-daemon').category(error)};}
  process.stdout.write(JSON.stringify(out)+'\n');if(out.isError)process.exitCode=1;return out;
}
module.exports={options,enabled,call,main,ensure,alive};
