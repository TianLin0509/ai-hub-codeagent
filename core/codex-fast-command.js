'use strict';
const fs = require('node:fs');
const path = require('node:path');
const {Terminal} = require('@xterm/headless');
const {scanTomlStatements,simpleStringValue,samePath} = require('./toml-statements');

function speedMessages(text) {
  return [...String(text).matchAll(/Service tier set to (default|priority|fast)\b/g)].map(m=>m[1] === 'default' ? 'standard' : 'fast');
}
// TUI updates may replace only "default" with "priority". Parse the rendered
// screen, never concatenate stripped ANSI chunks and infer a confirmation.
async function observeCodexFastCommand(manager,sid) {
  const queued=[]; let terminal=null, replayed=false, disposed=false, chain=Promise.resolve(), baseline=[], acknowledgement=null;
  const write = text => new Promise(resolve=>terminal.write(text,resolve));
  const listener = event => {
    if(event.sessionId !== sid || disposed)return;
    if(!replayed)queued.push(event);
    else chain=chain.then(()=>write(event.data));
  };
  manager.on('output',listener);
  try {
    const snapshot=await manager.getSessionBufferSnapshot(sid);
    terminal=new Terminal({cols:snapshot.baseCols||snapshot.cols||120,rows:snapshot.baseRows||snapshot.rows||30,scrollback:500,allowProposedApi:true});
    await write(snapshot.text||'');
    for(const operation of snapshot.operations||[]) {
      if(operation.type==='resize')terminal.resize(operation.cols,operation.rows);
      else if(operation.type==='write')await write(operation.data);
    }
    for(const event of queued)if(!event.seq||event.seq>snapshot.seq)await write(event.data);
    replayed=true;
  } catch(error) {disposed=true;manager.removeListener('output',listener);terminal?.dispose();throw error;}
  const text = () => {
    const buffer=terminal.buffer.active,lines=[];
    for(let i=0;i<buffer.length;i++)lines.push(buffer.getLine(i)?.translateToString(true)||'');
    return lines.join('\n');
  };
  return {
    async ready(){
      await chain;
      const buffer=terminal.buffer.active,lines=[];
      for(let i=buffer.baseY;i<buffer.baseY+terminal.rows;i++)lines.push(buffer.getLine(i)?.translateToString(true).trim()||'');
      return /^›\s*Ask Codex to do anything\s*$/i.test(lines.filter(line=>line.startsWith('›')).at(-1)||'');
    },
    get confirmation(){return acknowledgement;},
    async arm(){await chain;baseline=speedMessages(text());acknowledgement=null;},
    async wait(timeoutMs=12000){
      const deadline=Date.now()+timeoutMs;
      while(Date.now()<deadline&&!disposed){
        await chain;
        const messages=speedMessages(text());
        const tier=messages.at(-1);
        if(tier&&(messages.length>baseline.length||tier!==baseline.at(-1))){acknowledgement={ok:true,tier};return acknowledgement;}
        await new Promise(resolve=>setTimeout(resolve,60));
      }
      return {ok:false,message:'未收到 Codex 的速度确认，请查看终端；速度标签未改为成功'};
    },
    dispose(){disposed=true;manager.removeListener('output',listener);chain.finally(()=>terminal.dispose());},
  };
}
function tierStatement(text) {
  return scanTomlStatements(text).statements.find(s=>s.kind==='kv'&&samePath(s.path,['service_tier']));
}
function captureServiceTier(file) {
  const text=fs.readFileSync(file,'utf8'),statement=tierStatement(text);
  return {file,statement,line:statement ? text.split('\n').slice(statement.startLine,statement.endLine+1).join('\n') : null};
}
function restoreServiceTier(saved,expectedTier) {
  const text=fs.readFileSync(saved.file,'utf8'),statement=tierStatement(text);
  const expected=Array.isArray(expectedTier)?expectedTier:[expectedTier];
  if(!statement||!expected.includes(simpleStringValue(statement.valueText)))return;
  const lines=text.split('\n');
  lines.splice(statement.startLine,statement.endLine-statement.startLine+1,...(saved.line == null ? [] : saved.line.split('\n')));
  const next=lines.join('\n');if(next===text)return;
  scanTomlStatements(next);
  const temp=saved.file+'.hub-speed-'+process.pid+'.tmp';
  try {fs.writeFileSync(temp,next,'utf8');fs.renameSync(temp,saved.file);}
  finally {try{fs.unlinkSync(temp);}catch(_){}}
}
function registerCodexSpeedIpc(ipcMain,{sessionManager,sendToRenderer}) {
  let queue=Promise.resolve();
  ipcMain.handle('codex:set-speed',(_event,payload={})=>{
    const task=async()=>{
      const {sessionId,tier}=payload,session=sessionManager.getSession(sessionId);
      if(!session||String(session.kind).replace(/-resume$/,'')!=='codex'||session.runtimeBackend==='codex-app-server'||!['standard','fast'].includes(tier))return {ok:false,message:'Codex 会话或速度无效'};
      if(require('./session-runtime-truth').sessionRuntimeIsActive(session)||session.status==='running'||session.autonomous)return {ok:false,message:'请等当前回答结束后再切换速度'};
      const home=session.codexSessionsRoot ? path.dirname(session.codexSessionsRoot) : process.env.CODEX_HOME||path.join(require('node:os').homedir(),'.codex');
      const tuning=require('./codex-model-catalog').describeCodexModelTuning(session.currentModel?.id,{configDir:home});
      if(!tuning.fromCache||!tuning.supportsFast)return {ok:false,message:'当前模型尚未确认支持速度切换，请刷新模型目录'};
      const saved=captureServiceTier(path.join(home,'config.toml'));
      const {pendingSpeedSwitches}=require('./session-speed');
      pendingSpeedSwitches.add(sessionId);let confirmed=null,observer=null,attempted=false;
      try {
        observer=await observeCodexFastCommand(sessionManager,sessionId);
        if(!await observer.ready())return {ok:false,message:'Codex 输入框有草稿或不在主提示符，请先处理后再切换'};
        // Bare /fast is a toggle in CLI 0.159.3. Its on/off arguments are sent
        // to the model. At most two confirmed toggles reach the requested tier,
        // including when the user already changed speed directly in the TUI.
        for(let attempt=0;attempt<2;attempt++){
          await observer.arm();
          attempted=true;
          const result=await require('./group-chat-watcher').sendToPty(sessionId,'/fast',session.kind,{requireReady:false,localCommandObserver:observer});
          if(!result?.ok)return {ok:false,message:result?.message||'Codex 未确认速度切换'};
          confirmed=observer.confirmation?.tier;
          if(confirmed===tier)break;
        }
        if(confirmed!==tier)return {ok:false,message:'Codex 确认的速度与选择不一致，请查看终端'};
        const updated=sessionManager.updateSessionMeta(sessionId,{codexSpeedTier:tier});
        if(!updated)return {ok:false,message:'Codex 已切换，但会话设置保存失败'};
        sendToRenderer('session-updated',{session:updated});
        return {ok:true,result:{codexSpeedTier:tier}};
      } finally {
        observer?.dispose();
        try {if(attempted)restoreServiceTier(saved,confirmed ? (confirmed==='fast'?'fast':'default') : ['fast','default']);}
        finally {pendingSpeedSwitches.delete(sessionId);}
      }
    };
    const pending=queue.then(task).catch(error=>({ok:false,message:error.message}));queue=pending;return pending;
  });
}
module.exports={speedMessages,observeCodexFastCommand,captureServiceTier,restoreServiceTier,registerCodexSpeedIpc};
