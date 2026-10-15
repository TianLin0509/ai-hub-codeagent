'use strict';
const fs=require('node:fs'),path=require('node:path');
const storageRoots=require('../../core/storage-roots');
function registerPhoneIpc(ipcMain,assistant,{dataDir,electron}){
 const dir=path.join(dataDir,'assistant','phone');let channel;
 const ensure=()=>{if(channel)return channel;if(!electron.safeStorage.isEncryptionAvailable())throw Error('系统安全存储不可用，手机连接信息未保存');
  const {PhoneJournal}=require('../../core/hub-phone/journal'),{PhoneChannel}=require('../../core/hub-phone/channel');
  channel=new PhoneChannel({assistant,journal:new PhoneJournal(dir,electron.safeStorage,{claim:false}),lock:new (require('../../core/hub-phone/writer-lock').WriterLock)(path.join(dir,'channel.lock')),imageRoots:storageRoots.trustedFileRoots({dataDir}),renderHtml:file=>require('../../core/hub-phone/html-snapshot').renderHtml(electron,file),inboxRoot:storageRoots.workspaceRoot({fallback:'C:/Work'}),speak:text=>require('../../core/hub-phone/tts').synthesize(text,{credentials:()=>require('../../core/hub-phone/voice').dashscopeCredentials({dataDir,safeStorage:electron.safeStorage})}),transcribe:pcm=>require('../../core/hub-phone/voice').transcribe(pcm,{dataDir,safeStorage:electron.safeStorage}),prepareVoice:()=>require('../../core/hub-phone/voice').prepare({dataDir}),
    fastLane:process.env.HUB_ASSISTANT_FAST_LANE==='0'?null:new (require('../../core/hub-assistant/fast-lane').FastLane)({...(process.env.HUB_ASSISTANT_FAST_LANE_MODEL?{model:process.env.HUB_ASSISTANT_FAST_LANE_MODEL}:{}),credentials:()=>require('../../core/hub-assistant/fast-lane').fastLaneSources({dataDir,safeStorage:electron.safeStorage})})});
  if(channel.journal.state.enabled)channel.start();return channel;
 };
 for(const [name,fn]of Object.entries({status:()=>ensure().status(),pair:()=>ensure().pair(),pause:()=>ensure().pause(),resume:()=>{const c=ensure();if(!c.own())throw Error('另一个 Hub 进程正在负责手机连接，请等它退出后再试');c.journal.change(s=>{s.enabled=true;});c.start();return c.status();}}))ipcMain.handle('assistant:phone-'+name,async()=>{try{return await fn();}catch(e){return{ok:false,error:e.message};}});
 // 电脑卡片给手机发出的话标「手机」：只读已存在的通道，不为此新建连接。
 ipcMain.handle('assistant:phone-session-prompts',(_e,id)=>{try{return typeof id==='string'&&channel?channel.sessionChat.sentPrompts(id):[];}catch{return[];}});
 // 已配对过就自动恢复连接。注册发生在 app ready 之前，而 Windows 的 safeStorage 要到 ready 后才可用，
 // 提前恢复会静默失败、手机一直显示电脑不在线（2026-10-04），所以等 ready 再恢复。
 if(fs.existsSync(path.join(dir,'channel.bin')))electron.app.whenReady().then(()=>{try{ensure();console.log('[phone] channel restored');}catch(e){console.warn('[phone] unavailable:',e.message);}});
 return{observeReceipt:r=>channel?.observeReceipt(r),kick:()=>channel?.kick?.(),reminder:e=>channel?.syncReminder?.(e),close:()=>channel?.close()};
}
module.exports={registerPhoneIpc};
