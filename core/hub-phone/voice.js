'use strict';
const fs=require('node:fs'),path=require('node:path');
const MAX_SECONDS=120;
// 手机语音不属于某个项目：合并电脑端各项目的专业词表，领域说明因项目而异不带。
function mergedProfile(cfg){
 const terms=new Set();
 for(const profile of Object.values(cfg.profiles||{}))for(const term of String(profile?.terms||'').split(/[,，;；\n]/).map(t=>t.trim()))if(term&&term.length<=60&&terms.size<80)terms.add(term);
 return{terms:[...terms].join('\n'),context:''};
}
// 百炼凭据：语音识别与快速通道共用电脑上已配置的 Key。
function dashscopeCredentials({dataDir,safeStorage}){
 let cfg={region:'beijing'},key=process.env.DASHSCOPE_API_KEY||'';
 const file=path.join(dataDir,'voice-input.json');if(fs.existsSync(file)){cfg=JSON.parse(fs.readFileSync(file,'utf8'));if(cfg.encryptedKey)key=safeStorage.decryptString(Buffer.from(cfg.encryptedKey,'base64'));}
 if(!key)throw Error('电脑尚未设置百炼 Key，请在 Hub 输入框的语音设置中配置');
 return{key,cfg,base:cfg.region==='singapore'?'https://dashscope-intl.aliyuncs.com':'https://dashscope.aliyuncs.com'};
}
async function transcribe(data,{dataDir,safeStorage,chunkDelayMs=0}){
 const pcm=Buffer.from(data,'base64');if(!pcm.length||pcm.length%2||pcm.length>16000*2*MAX_SECONDS)throw Error(`录音需为 16kHz 单声道，且不超过 ${MAX_SECONDS} 秒`);
 let cfg={region:'beijing'},key=process.env.DASHSCOPE_API_KEY||'';
 const file=path.join(dataDir,'voice-input.json');if(fs.existsSync(file))cfg=JSON.parse(fs.readFileSync(file,'utf8'));
 // 与电脑端同一识别方式：本地（未就绪时 Token Plan 接力）、套餐或按量流式；失败不自动改走按量，免得悄悄计费。
 const voiceEngine=require('../voice-engine'),{engine,planKey,localReady}=voiceEngine.resolveEngine(cfg,dataDir);
 if(engine==='local'||engine==='tokenplan'){
  if(engine==='local'&&!localReady)throw Error('电脑上本地识别未安装，请在 Hub 语音设置里改用 Token Plan');
  if(engine==='tokenplan'&&!planKey)throw Error('电脑上未找到 Token Plan 套餐 Key，请在 Hub 语音设置里改用按量识别');
  const local=engine==='local'?require('../local-asr/manager').getLocalAsr(cfg):null;
  // 声纹过滤：电脑上录入的本人声纹同样用于手机语音（剔除旁人说话的段落）。
  const vpProfile=require('../voiceprint').active(dataDir),speaker=vpProfile?require('../local-asr/manager').getSpeakerWorker(cfg):null;
  // 云端只拿词表；本地另加个人背景与最近和助理的对话（不出本机）
  const voiceText=require('../voice-text'),merged=mergedProfile(cfg);
  const background=engine==='local'?voiceText.localBackground(merged,cfg.global,recentAssistantDialog(dataDir)):undefined;
  const r=await voiceEngine.transcribeRecording(pcm,{engine,planKey,profile:voiceText.cloudProfile(merged,cfg.global),background,local,source:'phone',usage:voiceEngine.usageLogger(dataDir),vp:vpProfile&&speaker?{profile:vpProfile,speaker}:null});
  return voiceText.cleanFillers(r.text);
 }
 if(cfg.encryptedKey)key=safeStorage.decryptString(Buffer.from(cfg.encryptedKey,'base64'));
 if(!key)throw Error('电脑尚未设置语音识别，请在 Hub 输入框的语音设置中配置');
 const {VoiceStream}=require('../voice-input');let finish,fail;const result=new Promise((a,b)=>{finish=a;fail=b;});result.catch(()=>{});
 // 整段一次推完，服务端收尾时间随录音长度增加，等待放宽到 30 秒。
 const voiceText=require('../voice-text');
 const stream=new VoiceStream({config:cfg,apiKey:key,sampleRate:16000,timeoutMs:30000,profile:voiceText.cloudProfile(mergedProfile(cfg),cfg.global),onEvent:r=>{if(r.type==='done')finish(voiceText.cleanFillers(r.text));if(r.type==='error')fail(Error(r.message));}});
 // 录音已完整到手，不再按说话节奏回放（旧做法让 30 秒语音多等约 27 秒）；按 0.1 秒一块连续推送。
 try{await stream.ready;for(let at=0;at<pcm.length;at+=3200){await stream.audio(pcm.subarray(at,at+3200));if(chunkDelayMs)await new Promise(r=>setTimeout(r,chunkDelayMs));}await stream.finish();return await result;}finally{if(!stream.ended)stream.cancel();}
}
// 手机语音的动态背景：最近和助理的若干条对话（assistant/dialog/当月.jsonl 末尾），只给本地模型。
function recentAssistantDialog(dataDir,maxChars=1500){
 try{const dir=path.join(dataDir,'assistant','dialog');const files=fs.readdirSync(dir).filter(f=>/^\d{4}-\d{2}\.jsonl$/.test(f)).sort();if(!files.length)return'';
  const lines=fs.readFileSync(path.join(dir,files.at(-1)),'utf8').trim().split(/\r?\n/).slice(-30);
  const text=lines.map(l=>{try{return String(JSON.parse(l).text||'')}catch{return''}}).filter(Boolean).join(' ').replace(/\s+/g,' ');
  return [...text].slice(-maxChars).join('');}catch{return'';}
}
// 手机按下说话键时先通知电脑：本地模式下趁用户说话把模型装进显卡。
function prepare({dataDir}){
 const file=path.join(dataDir,'voice-input.json');const cfg=fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):{};
 const voiceEngine=require('../voice-engine');if(voiceEngine.resolveEngine(cfg,dataDir).engine!=='local')return false;
 const local=require('../local-asr/manager').getLocalAsr(cfg);if(!local)return false;
 void local.prepare().catch(e=>console.warn('[phone] 本地识别准备失败：',e.message));return true;
}
module.exports={transcribe,prepare,mergedProfile,dashscopeCredentials,MAX_SECONDS};
