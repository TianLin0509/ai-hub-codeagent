'use strict';
const crypto=require('node:crypto'),fs=require('node:fs'),path=require('node:path');
const {seal,open,credentials,invite}=require('./crypto');
// 手机协议 v2（App 1.1）：voice_message 识别后直接交给助理，转写只回传显示；hello 声明能力后才下发 profile；set_profile 切换助理模型。
// 旧 App 只认 text/voice/status/answer/image/transcript，未声明能力前不向它发送新类型。
const TYPES=['text','voice','voice_message','hello','set_profile','set_front_desk','speak','memo_update','podcast_get','voice_prepare','workbench_get','workbench_action','session_cards_get','video_chunk_get','video_cover_get'];
// 本 Hub 能处理的手机消息能力，随 profile 下发；手机据此决定是否发 voice_prepare（老 Hub 不认会回「校验未通过」）。
const HUB_CAPS=['voice_prepare','workbench','session_cards','learning_video'];
const MAX_VOICE_BYTES=16000*2*120;
const ACTIVE=['dispatching','waiting','unknown'];
const LONG_POLL_SECONDS=15; // 中继支持长等待时，新消息一到即返回；旧中继忽略该参数、立即返回
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
class PhoneChannel{
 constructor({assistant,journal,renderHtml=null,transcribe,prepareVoice=null,fastLane=null,imageRoots=[],speak=null,inboxRoot=null}){Object.assign(this,{assistant,journal,renderHtml,transcribe,prepareVoice,fastLane,imageRoots,speak,inboxRoot});this.closed=false;this.issue=null;this.online=false;this.lastPoll=0;}
 status(){const s=this.journal.state;return{ok:true,version:'1.1.0',protocol:2,enabled:s.enabled,connected:this.online,issue:this.issue,paired:!!s.credentials,pending:s.inbox.filter(r=>r.state==='queued').length,unknown:s.inbox.filter(r=>r.state==='unknown').length,voice:true,phoneApp:s.phoneApp||null,backend:this.assistant.overview().backendKind||null};}
 async request(endpoint,{method='GET',body,role='hub',wait=0}={}){const c=this.journal.state.credentials;if(!c)throw Error('请先连接手机');const q=method==='GET'?`?channel=${c.channel}&role=${role}&after=${this.journal.state.cursor}${wait?'&wait='+wait:''}`:'';const headers={Authorization:'Bearer '+c.hubToken,'Content-Type':'application/json'};if(endpoint==='/create'){const file='C:/AppData/Secrets/aihub-phone-relay-registration.txt';const secret=process.env.HUB_PHONE_REGISTER_KEY||(fs.existsSync(file)?fs.readFileSync(file,'utf8').trim():'');if(!/^[A-Za-z0-9_-]{43}$/.test(secret))throw Error('手机连接服务尚未配置，请先完成手机服务部署');headers['X-Register-Key']=secret;}const r=await fetch(c.url+endpoint+q,{method,headers,body:body&&JSON.stringify({...body,channel:c.channel,role}),signal:AbortSignal.timeout(wait?(wait+15)*1000:20000)});if(!r.ok)throw Error('手机连接服务暂时不可用（'+r.status+'）');return r.json();}
 async pair(){const s=this.journal.state;if(!s.credentials)this.journal.change(x=>{x.credentials=credentials();x.notices=this.assistant.notifications({limit:200}).notifications.map(n=>n.id);x.created=Date.now();});const {channel,hubToken,phoneToken}=s.credentials;await this.request('/create',{method:'POST',body:{channel,hubToken,phoneToken}});this.journal.change(x=>{x.enabled=true;});this.start();return{...this.status(),code:invite(s.credentials)};}
 emit(id,value){const s=this.journal.state;if(s.outbox.some(r=>r.id===id))return;const c=s.credentials;this.journal.change(x=>{x.outbox.push({id,payload:seal(c.key,c.channel,id,'hub',{...value,time:Date.now()}),sent:false});});}
 observeReceipt(r){if(r?.status!=='confirmed'||r.notSent||r.contentMismatch)return;const row=this.journal.state.inbox.find(x=>x.id===r.clientSubmissionId&&x.sessionId===r.sessionId);if(row&&ACTIVE.includes(row.state)){this.journal.change(()=>{row.turnId=r.turnId||null;row.state='waiting';row.issue=null;row.t={...row.t,confirmed:row.t?.confirmed||Date.now()};});const by=this.assistantLabel();this.emit('receipt-'+row.id,{type:'status',requestId:row.id,state:'received',lane:'assistant',by,text:'已交给助理会话（'+by+'）处理。'});}}
 // 有任务在途或 10 分钟内有往来时 1.5 秒取一次，其余 2.2 秒；中继按 IP 限每分钟 180 次，手机与电脑常在同一出口。
 // 收消息走独立的长等待循环（消息一到立刻处理）；处理由 kick 触发（新消息、助理答完、关注提醒），定时器只做兜底。
 start(){if(this.timer||this.closed)return;this.timer=setInterval(()=>{const s=this.journal.state,busy=s.inbox.some(r=>r.state==='queued'||r.state==='transcribing'||ACTIVE.includes(r.state))||Date.now()-(s.lastInbound||0)<600000;if(Date.now()-this.lastPoll>=(busy?1500:5000))void this.tick();},500);this.timer.unref();void this.receiveLoop();void this.tick();}
 kick(){if(this.closed)return;if(this.working){this.rekick=true;return;}void this.tick();}
 async receiveLoop(){
  if(this.receiving)return;this.receiving=true;
  try{while(!this.closed&&this.journal.state.enabled&&this.journal.state.credentials){
   const started=Date.now();
   try{const polled=await this.request('/poll',{wait:LONG_POLL_SECONDS});if(this.closed)break;this.online=true;this.issue=null;
    const messages=polled.messages||[];await this.ingest(messages);
    if(messages.length)this.kick();else if(Date.now()-started<1000)await sleep(1500);}
   catch(e){this.online=false;this.issue=e.message;await sleep(3000);}
  }}finally{this.receiving=false;}
 }
 async ingest(messages){const s=this.journal.state;
  for(const packet of messages){if(packet.seq<=s.cursor)continue;if(!s.inbox.some(r=>r.id===packet.id)){try{const m=open(s.credentials.key,s.credentials.channel,packet.id,'phone',packet.payload);this.validate(m);
     if(m.type==='hello'){this.journal.change(x=>{x.cursor=packet.seq;x.lastInbound=Date.now();x.phoneCaps=m.caps.map(String).slice(0,20);x.phoneApp=String(m.app||'').slice(0,20);x.memoSignature=null;x.podcastSignature=null;x.workbenchSignature=null;x.inbox.push({id:packet.id,type:'hello',state:'done'});});await this.sendProfile(packet.id).catch(e=>console.warn('[phone] profile',e.message));this.sendReminders();if(this.supports('workbench'))this.sendWorkbench(packet.id);continue;}
     // 按下说话键的提前通知：立即让电脑准备本地识别，不进收件箱、不回执。
     if(m.type==='voice_prepare'){this.journal.change(x=>{x.cursor=packet.seq;x.lastInbound=Date.now();});try{this.prepareVoice?.();}catch(e){console.warn('[phone] voice_prepare',e.message);}continue;}
     if(m.attachment){const saved=this.saveAttachment(m.attachment);m.text=m.text+'\n\n（我从手机分享了一个文件：'+saved+'）';m.noFast=true;m.shared=require('node:path').basename(saved);delete m.attachment;}
     if(m.to==='assistant'||m.context)m.noFast=true;
     this.journal.change(x=>{x.inbox.push({...m,id:packet.id,state:'queued',t:{received:Date.now()}});x.cursor=packet.seq;x.lastInbound=Date.now();});if(m.type==='text')this.log({id:packet.id,role:'user',input:'text',text:m.text});}catch{this.journal.change(x=>{x.cursor=packet.seq;});this.emit('invalid-'+packet.id,{type:'status',requestId:packet.id,state:'rejected',text:'消息校验未通过，未提交任务。'});}}else this.journal.change(x=>{x.cursor=packet.seq;});}
 }
 validate(m){
  if(m.type==='session_cards_get'&&(typeof m.sessionId!=='string'||! /^[A-Za-z0-9_-]{1,100}$/.test(m.sessionId)||m.before!=null&&(typeof m.before!=='string'||m.before.length>160)))throw Error('卡片请求无效');
  if(m.type==='video_cover_get'&&(typeof m.videoId!=='string'||! /^[A-Za-z0-9-]{8,64}$/.test(m.videoId)))throw Error('封面请求无效');
  if(m.type==='video_chunk_get'&&(typeof m.videoId!=='string'||! /^[A-Za-z0-9-]{8,64}$/.test(m.videoId)||!Number.isInteger(m.index)||m.index<0))throw Error('视频请求无效');
  if(m.context!==undefined&&(!['text','voice_message'].includes(m.type)||!m.context||!['session','plan','lesson','summary','video'].includes(m.context.kind)||typeof m.context.id!=='string'||m.context.id.length>100))throw Error('工作台上下文无效');
  if(m.type==='workbench_action'&&(!['configure','confirm','done','reopen'].includes(m.action)||m.day!==undefined&&(typeof m.day!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(m.day))||m.itemId!==undefined&&(typeof m.itemId!=='string'||m.itemId.length>100)))throw Error('工作台操作无效');
  if(!TYPES.includes(m.type))throw Error('消息类型不支持');
  if(m.type==='text'&&(typeof m.text!=='string'||!m.text.trim()||m.text.length>50000))throw Error('任务文字无效');
  if(m.attachment!==undefined&&(m.type!=='text'||typeof m.attachment!=='object'||typeof m.attachment.name!=='string'||m.attachment.name.length>160||typeof m.attachment.data!=='string'||m.attachment.data.length>7400000))throw Error('分享的文件无效（单个不超过 4MB）');
  if(m.memo!==undefined&&(m.type!=='voice_message'||typeof m.memo!=='boolean'))throw Error('备忘标记无效');
  // 手机输入框上方选了「交给助理会话」，或点了回答下方的「重新回答」：这一条跳过快答。
  if(m.to!==undefined&&(!['text','voice_message'].includes(m.type)||m.to!=='assistant'))throw Error('交给谁的标记无效');
  if(m.type==='voice_message'&&(typeof m.pcm!=='string'||!m.pcm||m.pcm.length>Math.ceil(MAX_VOICE_BYTES/3)*4+4))throw Error('语音无效');
  if(m.type==='set_profile'&&!['kind','model'].every(k=>typeof m[k]==='string'&&m[k]&&m[k].length<=160))throw Error('助理设置无效');
  if(m.type==='hello'&&(!Array.isArray(m.caps)||m.caps.length>20))throw Error('手机能力声明无效');
  if(m.type==='speak'&&(typeof m.text!=='string'||!m.text.trim()||m.text.length>20000||typeof m.answerId!=='string'||m.answerId.length>120))throw Error('朗读请求无效');
  if(m.type==='podcast_get'&&(typeof m.podcast!=='string'||!/^[A-Za-z0-9-]{8,64}$/.test(m.podcast)||!Number.isInteger(m.episode)||m.episode<1||m.episode>99||!['audio','text'].includes(m.kind)))throw Error('口播请求无效');
  if(m.type==='memo_update'&&(typeof m.ref!=='string'||!m.ref||m.ref.length>64||!['done','drop','reopen','snooze'].includes(m.action)||m.until!==undefined&&(typeof m.until!=='string'||m.until.length>40)))throw Error('备忘操作无效');
  if(m.type==='set_front_desk'&&(!['api','cli'].includes(m.mode)||m.model!==undefined&&(typeof m.model!=='string'||m.model.length>80)))throw Error('回答方式设置无效');
 }
 supports(cap){return(this.journal.state.phoneCaps||[]).includes(cap);}
 // 提醒同步到手机：手机按时间设本地闹钟，App 在后台也能准时响。
 syncReminder({action,reminder}){if(!reminder||!this.journal.state.credentials)return;this.emit('reminder-'+action+'-'+reminder.id+(action==='set'?'-'+reminder.at:''),{type:'reminder',action,id:reminder.id,at:reminder.at,text:reminder.text,repeat:reminder.repeat||''});this.kick();}
 sendReminders(){for(const r of this.assistant.reminders?.upcoming?.()||[])this.emit('reminder-set-'+r.id+'-'+r.at,{type:'reminder',action:'set',id:r.id,at:r.at,text:r.text,repeat:r.repeat||''});}
 // 手机分享来的文件：存进工作区当天的「手机分享」文件夹，消息里给出路径交给助理会话处理。
 saveAttachment(a){
  const fs=require('node:fs'),path=require('node:path');
  const now=new Date(Date.now()+8*3600000),day=now.toISOString().slice(0,10).replace(/-/g,''),hms=now.toISOString().slice(11,19).replace(/:/g,'');
  const dir=path.join(this.inboxRoot||require('../storage-roots').workspaceRoot({fallback:'C:/Work'}),day+'-手机分享');fs.mkdirSync(dir,{recursive:true});
  const safe=String(a.name||'文件').replace(/[\\/:*?"<>|\u0000-\u001f]/g,'_').replace(/^\.+/,'').slice(-100)||'文件';
  const file=path.join(dir,hms+'-'+safe),data=Buffer.from(a.data,'base64');if(data.length>5.5*1024*1024)throw Error('分享的文件超过 5MB');
  fs.writeFileSync(file,data);return file;
 }
 // 手机对话记录（助理 Tab「对话记录」）：记失败不影响收发。
 // 口播清单（标题、各集状态与时长）变了就发给手机；音频与阅读版由手机按需要。
 sendWorkbench(requestId,refresh=false){if(!this.supports('workbench')||!this.assistant.workbench)return;const value=refresh?this.assistant.workbench.refresh():this.assistant.workbench.snapshot();this.emit('workbench-'+crypto.randomUUID(),{type:'workbench',...(requestId?{requestId}:{}),...value});this.journal.change(x=>{x.workbenchSignature=this.assistant.store?.get('workbench.revision')||0;});}
 sendPodcasts(){const studio=this.assistant.podcasts;if(!studio)return;const sig=studio.signature();if(sig===this.journal.state.podcastSignature)return;this.emit('podcasts-'+crypto.randomUUID(),{type:'podcasts',items:studio.summary()});this.journal.change(x=>{x.podcastSignature=sig;});}
 // 备忘清单变了（含跨天分组变化）就把整份精简清单发给手机；原话截到 600 字。
 sendMemos(force=false){const memos=this.assistant.memos;if(!memos)return;const sig=memos.signature();if(!force&&sig===this.journal.state.memoSignature)return;const v=memos.view(),cut=m=>({...m,raw:String(m.raw||'').slice(0,600)});this.emit('memos-'+crypto.randomUUID(),{type:'memos',open:v.open.map(cut),closed:v.closed.map(cut),groups:v.groups});this.journal.change(x=>{x.memoSignature=sig;});}
 log(entry){try{this.assistant.logDialog?.(entry);}catch(e){console.warn('[phone] dialog log',e.message);}}
 assistantLabel(){const p=this.assistant.currentProfile?.();if(!p)return'助理会话';let kind=p.kind;try{kind=require('../ai-kinds').getKindLabel(p.kind);}catch{}return[kind,p.label].filter(Boolean).join(' · ');}
 // 助理设置与回答方式任一变化（电脑面板改的也算）都重发 profile，手机两边保持一致。
 profileSignature(){return JSON.stringify([this.assistant.currentProfile?.(),this.assistant.frontDesk?.(),this.watchingCount()]);}
 // 关注中且正在运行的任务数：手机据此在后台继续等结果，任务停下就不再常驻后台。
 watchingCount(){try{return(this.assistant.followedTasks?.()||[]).filter(w=>['watching','waiting-binding'].includes(w.state)&&this.assistant.sessionBusy?.(w.sessionId)).length;}catch{return 0;}}
 async sendProfile(requestId){
  if(!this.supports('profile')||!this.assistant.phoneProfile)return;
  const profile=await this.assistant.phoneProfile();
  this.journal.change(x=>{x.profileSignature=this.profileSignature();});
  this.emit('profile-'+crypto.randomUUID(),{type:'profile',...(requestId?{requestId}:{}),...profile,hubCaps:HUB_CAPS.filter(c=>c==='workbench'?!!this.assistant.workbench:c==='session_cards'?typeof this.assistant.sessionCards==='function':c==='learning_video'?!!this.assistant.videos:true),watching:this.watchingCount(),switching:!!this.assistant.switching});
 }
 async tick(){const s=this.journal.state;if(this.working||this.closed||!s.enabled||!s.credentials)return;this.working=true;this.lastPoll=Date.now();
 try{
  // 长等待循环在跑时由它收消息；单独调用 tick（测试、旧路径）时自己取一次。
  if(!this.receiving){const polled=await this.request('/poll');if(this.closed||!s.enabled)return;this.online=true;this.issue=null;await this.ingest(polled.messages||[]);}
  if(this.closed||!s.enabled)return;
  for(const row of s.inbox.filter(r=>r.state==='queued'&&['workbench_get','workbench_action'].includes(r.type))){
   try{if(!this.supports('workbench')||!this.assistant.workbench)throw Error('工作台需要新版手机和 Hub');if(row.type==='workbench_action')this.assistant.workbench.action(row);this.sendWorkbench(row.id,row.type==='workbench_get');this.journal.change(()=>{row.state='done';});}
   catch(e){this.journal.change(()=>{row.state='rejected';row.issue=e.message;});this.emit('workbench-error-'+row.id,{type:'status',requestId:row.id,state:'rejected',text:e.message});}
  }
  for(const row of s.inbox.filter(r=>r.state==='queued'&&['session_cards_get','video_chunk_get','video_cover_get'].includes(r.type))){
   try{const cards=row.type==='session_cards_get',cover=row.type==='video_cover_get';if(!this.supports(cards?'session_cards':'learning_video'))throw Error('手机需要更新');
    // 封面：钩子屏定格的小图，手机缓存做缩略图。
    const body=cards?this.assistant.sessionCards(row):cover?{id:row.videoId,data:this.assistant.videos.cover(row.videoId)}:this.assistant.videos.chunk(row.videoId,row.index);
    this.emit('readonly-'+row.id,{type:cards?'session_cards':cover?'video_cover':'video_chunk',requestId:row.id,...body,...(cards?{append:!!row.before}:{})});this.journal.change(()=>{row.state='done';});
   }catch(e){this.journal.change(()=>{row.state='rejected';row.issue=e.message;});this.emit('readonly-error-'+row.id,{type:'status',requestId:row.id,state:'rejected',text:e.message});}
  }
  // 朗读请求不排队：合成后把音频地址发给手机（手机直接从阿里云下载播放）。
  for(const row of s.inbox.filter(r=>r.state==='queued'&&r.type==='speak')){this.journal.change(()=>{row.state='speaking';});try{if(!this.speak)throw Error('电脑未配置朗读');const a=await this.speak(row.text);this.emit('audio-'+row.id,{type:'audio',requestId:row.id,answerId:row.answerId,url:a.url,expiresAt:a.expiresAt});console.log('[phone] speak',row.id.slice(0,8),JSON.stringify({chars:a.chars,tokens:a.tokens,ms:a.ms}));this.journal.change(()=>{row.state='done';delete row.text;});}catch(e){this.journal.change(()=>{row.state='rejected';row.issue=e.message;delete row.text;});this.emit('speakerror-'+row.id,{type:'status',requestId:row.id,state:'rejected',text:'朗读暂不可用：'+e.message});}}
  // 回答方式设置不排队：助理忙时也立即生效。
  // 手机上点「完成 / 明天 / 以后 / 不做了」：直接改备忘（不排在助理任务后面），改完重发清单。
  // 手机要某一集的音频或阅读版：直接从口播目录读出来发过去（音频约 1～2MB）。
  for(const row of s.inbox.filter(r=>r.state==='queued'&&r.type==='podcast_get')){try{const studio=this.assistant.podcasts;if(!studio)throw Error('电脑上没有口播');const fs=require('node:fs'),f=studio.file(row.podcast,row.episode,row.kind);const body=row.kind==='audio'?{data:fs.readFileSync(f).toString('base64')}:{text:fs.readFileSync(f,'utf8').slice(0,60000)};this.emit('podcast-file-'+row.id,{type:'podcast_file',requestId:row.id,podcast:row.podcast,episode:row.episode,kind:row.kind,...body});this.journal.change(()=>{row.state='done';});}catch(e){this.journal.change(()=>{row.state='rejected';row.issue=e.message;});this.emit('podcasterror-'+row.id,{type:'status',requestId:row.id,state:'rejected',text:'口播没取到：'+e.message});}}
  for(const row of s.inbox.filter(r=>r.state==='queued'&&r.type==='memo_update')){try{this.assistant.memoAction(row.ref,{action:row.action,until:row.until||''});this.journal.change(()=>{row.state='done';});}catch(e){this.journal.change(()=>{row.state='rejected';row.issue=e.message;});this.emit('memoerror-'+row.id,{type:'status',requestId:row.id,state:'rejected',text:'备忘没改成：'+e.message});}}
  for(const row of s.inbox.filter(r=>r.state==='queued'&&r.type==='set_front_desk')){try{this.assistant.setFrontDesk({mode:row.mode,...(row.model?{model:row.model}:{})});this.journal.change(()=>{row.state='done';});await this.sendProfile(row.id).catch(e=>console.warn('[phone] profile',e.message));}catch(e){this.journal.change(()=>{row.state='rejected';row.issue=e.message;});this.emit('profileerror-'+row.id,{type:'status',requestId:row.id,state:'rejected',text:'回答方式未切换：'+e.message});}}
  // 语音先识别（不受助理忙碌影响），可直接答的简单问题走快速通道，其余照旧排队交给完整助理。
  for(const row of s.inbox.filter(r=>r.state==='queued'&&r.type==='voice_message'))await this.transcribeRow(row);
  if(this.fastLane&&!this.assistant.fastLaneDisabled?.())for(const row of s.inbox.filter(r=>r.state==='queued'&&r.type==='text'&&!r.fastTried))await this.tryFastLane(row);
  const active=s.inbox.find(r=>ACTIVE.includes(r.state));
  if(active){let finals;try{finals=this.assistant.readLiveFinal(active.sessionId).records;}catch(e){finals=[];if(/找不到原会话/.test(e.message)){this.journal.change(()=>{active.state='lost';active.issue=e.message;});this.emit('lost-'+active.id,{type:'status',requestId:active.id,state:'unknown',text:'助理会话已不在本窗口，结果请在电脑上查看；不会自动重发。'});}}const answer=finals.find(r=>r.clientSubmissionId===active.id||active.turnId&&r.turnId===active.turnId);if(answer){const found=Date.now();
    // 先记进对话记录（助理页靠它显示），再发手机、改通道状态：后两步出错也不会出现「手机收到了、助理页没有」。
    if(!active.logged){this.log({id:active.id,role:'assistant',lane:'assistant',by:this.assistantLabel(),text:answer.text,ms:active.t?.received?found-active.t.received:null});active.logged=true;}
    await this.reply('answer-'+active.id,answer.text,{requestId:active.id,lane:'assistant',by:this.assistantLabel(),...(active.t?.received?{ms:found-active.t.received}:{})});this.journal.change(()=>{active.state='answered';active.t={...active.t,answerFound:found,answerQueued:Date.now()};});
   const t=active.t||{},span=(a,b)=>t[a]&&t[b]?t[b]-t[a]:null;console.log('[phone] timing',active.id.slice(0,8),JSON.stringify({asr:span('asrStart','asrDone'),toDispatch:span('received','dispatch'),submit:span('dispatch','confirmed'),turn:span('confirmed','answerFound'),total:span('received','answerQueued')}));}}
  if(!s.inbox.some(r=>ACTIVE.includes(r.state))&&!this.assistant.switching){const row=s.inbox.find(r=>r.state==='queued');if(row){
    if(row.type==='voice'){this.journal.change(()=>{row.state='transcribing';});try{const text=await this.transcribe(row.pcm);if(!text.trim())throw Error('没有听清，请重新录音');this.emit('transcript-'+row.id,{type:'transcript',requestId:row.id,text});this.journal.change(()=>{row.state='transcribed';delete row.pcm;});}catch(e){this.emit('voiceerror-'+row.id,{type:'status',requestId:row.id,state:'rejected',text:e.message});this.journal.change(()=>{row.state='rejected';delete row.pcm;});}}
    else if(row.type==='set_profile'){this.journal.change(()=>{row.state='switching';});try{const r=await this.assistant.setProfile({kind:row.kind,model:row.model,effort:row.effort||undefined});if(!r.ok)throw Error(r.error||'切换未完成');this.journal.change(()=>{row.state='done';});await this.sendProfile(row.id).catch(e=>console.warn('[phone] profile',e.message));}catch(e){this.journal.change(()=>{row.state='rejected';row.issue=e.message;});this.emit('profileerror-'+row.id,{type:'status',requestId:row.id,state:'rejected',text:'助理设置未切换：'+e.message});await this.sendProfile().catch(()=>{});}}
    else{
     if(row.type==='voice_message')await this.transcribeRow(row);
     if(row.state==='queued'){
      // 助理暂时起不来时本条留在队首重试；连续 3 次失败就明确告诉手机，避免整条队列被挡住。
      try{await this.dispatch(row);}catch(e){this.issue=e.message;this.journal.change(()=>{row.attempts=(row.attempts||0)+1;if(row.attempts>=3){row.state='rejected';row.issue=e.message;}});if(row.state==='rejected'){this.log({id:row.id,role:'system',text:'助理暂时无法接收：'+e.message});}if(row.state==='rejected')this.emit('rejected-'+row.id,{type:'status',requestId:row.id,state:'rejected',text:'助理暂时无法接收：'+e.message+'。本条未提交，请稍后重发。'});}
     }
    }
   }}
  if(this.supports('profile')&&this.assistant.phoneProfile&&!this.assistant.switching){if(this.profileSignature()!==s.profileSignature)await this.sendProfile();}
  if(this.supports('workbench')&&this.assistant.workbench&&(this.assistant.store?.get('workbench.revision')||0)!==s.workbenchSignature)this.sendWorkbench();
  if(this.supports('memo'))this.sendMemos();
  if(this.supports('podcast'))this.sendPodcasts();
  for(const n of this.assistant.notifications({limit:200}).notifications){if(s.notices.includes(n.id)||n.createdAt<s.created)continue;await this.reply('notice-'+crypto.createHash('sha256').update(n.id).digest('hex').slice(0,32),n.kind==='memory-update'||n.kind==='reminder'||n.kind==='memo-digest'||n.kind==='podcast'||n.kind?.startsWith('daily-')?n.text:'关注任务「'+n.title+'」有新进展：\n'+n.text,{notice:true,...(n.kind==='reminder'?{reminder:true}:{}),...(n.kind?.startsWith('daily-')?{daily:n.kind.slice(6)}:{})});this.journal.change(x=>x.notices.push(n.id));if(n.kind?.startsWith('daily-'))this.sendWorkbench();}
  await this.flush(4);
 }catch(e){this.online=false;this.issue=e.message;}finally{this.working=false;if(this.rekick&&!this.closed){this.rekick=false;setTimeout(()=>void this.tick(),0);}}}
 async flush(limit=8){for(const row of this.journal.state.outbox.filter(r=>!r.sent).slice(0,limit)){await this.request('/send',{method:'POST',body:{id:row.id,payload:row.payload}});this.journal.change(()=>{row.sent=true;});}}
  async transcribeRow(row){
   this.journal.change(()=>{row.state='transcribing';row.t={...row.t,asrStart:Date.now()};});
   try{const heard=(await this.transcribe(row.pcm)).trim();if(!heard)throw Error('没有听清，请再说一次');this.emit('transcript-'+row.id,{type:'transcript',requestId:row.id,text:heard,auto:true});
   // 备忘页「说一句记下来」录的话：明确告诉助理这是要记进备忘的（用户说的原话照常保存）。
   const text=row.memo&&!/^(记|备忘|别忘)/.test(heard)?'记一下：'+heard:heard;
   this.journal.change(()=>{row.type='text';row.text=text;row.inputMode='voice';row.state='queued';row.t={...row.t,asrDone:Date.now()};delete row.pcm;});this.log({id:row.id,role:'user',input:'voice',text,durationMs:row.durationMs});}
   catch(e){this.log({id:row.id,role:'system',input:'voice',text:'语音识别失败：'+e.message});this.emit('voiceerror-'+row.id,{type:'status',requestId:row.id,state:'rejected',text:'识别失败：'+e.message});this.journal.change(()=>{row.state='rejected';row.issue=e.message;delete row.pcm;});}
   await this.flush().catch(()=>{});
  }
  // 快速通道：约 1 秒答复；交还标记、出错或超时都回到完整助理，不丢消息。
  async tryFastLane(row){
   this.journal.change(()=>{row.fastTried=true;});
   if(row.noFast||!this.fastLane.eligible(row.text))return false;
   try{
    const started=Date.now(),result=await this.fastLane.answer(row.text,{history:this.assistant.recentHistory?.()||[],userPrefs:this.assistant.memory?.read?.().user||'',memory:this.assistant.memory?.read?.().memory||'',...(this.assistant.frontDesk?{model:this.assistant.frontDesk().model}:{}),hubStatus:this.assistant.statusDigest?.()||''});
    if(result.handoff){console.log('[phone] fast lane handoff',row.id.slice(0,8),Date.now()-started+'ms');return false;}
    this.journal.change(()=>{row.state='answered';row.lane='fast';row.t={...row.t,answerFound:Date.now()};});
    await this.reply('answer-'+row.id,result.text,{requestId:row.id,lane:'fast',by:this.assistant.frontDesk?.().modelLabel||result.model,...(row.t?.received?{ms:Date.now()-row.t.received}:{})},{cards:false});
    await this.flush().catch(()=>{});
    const queued=Date.now();this.log({id:row.id,role:'assistant',lane:'fast',by:this.assistant.frontDesk?.().modelLabel||result.model,text:result.text,ms:row.t?.received?queued-row.t.received:null});
    this.journal.change(()=>{row.t={...row.t,answerQueued:queued};});
    try{this.assistant.recordFastLane?.({id:row.id,question:row.text,answer:result.text,model:result.model,inputMode:row.inputMode});}catch{}
    const t=row.t||{};console.log('[phone] fast lane',row.id.slice(0,8),JSON.stringify({via:result.via,asr:t.asrDone&&t.asrStart?t.asrDone-t.asrStart:null,model:result.ms,first:result.firstMs,total:t.answerQueued-t.received}));
    return true;
   }catch(e){console.warn('[phone] fast lane fallback',e.message);return false;}
  }
  async dispatch(row){
  const overview=this.assistant.overview();if(overview.submissionPending||['running','waiting'].includes(overview.status))return;
  const ready=await this.assistant.ensureSession();if(!ready.ok)throw Error(ready.error||'助理未就绪');if(!row.routed){this.journal.change(()=>{row.routed=true;});this.log({id:row.id,role:'route',lane:'assistant',by:this.assistantLabel()});}
  this.journal.change(()=>{row.state='dispatching';row.sessionId=ready.sessionId;row.t={...row.t,dispatch:Date.now()};});
  try{const r=await this.assistant.send({text:(row.context?this.assistant.workbench.context(row.context):'')+row.text,requestId:row.id,...(row.inputMode==='voice'?{inputMode:'voice'}:{})});const receipt=r.receipt?.receipt;if(receipt?.status==='confirmed')this.observeReceipt({...receipt,sessionId:ready.sessionId,clientSubmissionId:row.id});else if(r.receipt?.notSent){this.journal.change(()=>{row.state='rejected';row.issue=r.receipt.message||r.receipt.error;});this.emit('rejected-'+row.id,{type:'status',requestId:row.id,state:'rejected',text:r.receipt.message||'本条消息未发送，请等助理就绪后重新发送。'});}else if(row.state==='dispatching')this.journal.change(()=>{row.state='unknown';row.issue=r.receipt?.message||r.receipt?.error;});}catch(e){this.journal.change(()=>{row.state=e.notSent?'rejected':'unknown';row.issue=e.message;});}
  if(row.state==='unknown')this.emit('unknown-'+row.id,{type:'status',requestId:row.id,state:'unknown',text:'任务是否送达尚未确认，正在核对，不会自动再发。'});
 }
 async reply(id,text,extra={},{cards=true}={}){this.emit(id,{type:'answer',text,...extra});for(const [i,img]of require('./images').answerImages(text,{roots:this.imageRoots}).entries())this.emit(id+'-original-'+i,{type:'image',originId:id,png:img.data.toString('base64'),caption:img.caption,...extra});if(!cards||!this.renderHtml||this.journal.state.outbox.some(r=>r.id===id+'-html-0-0'))return;
  // 回复只发 Markdown 文字；引用了本机 HTML 报告时才渲染成长图发过去。
  // 转图可能要十几秒：后台进行，文字先到手机，图片随后补上，不挡住后面的消息。
  const pages=require('./html-snapshot').answerHtmlFiles(text,{roots:this.imageRoots});if(!pages.length)return;
  const work=(async()=>{for(const [n,page]of pages.entries()){try{const html=require('node:fs').readFileSync(page.file,'utf8');if(html.length<=3*1024*1024)this.emit(id+'-page-'+n,{type:'html',originId:id,name:page.caption,html,...extra});const images=await this.renderHtml(page.file);images.forEach((b,i)=>this.emit(id+'-html-'+n+'-'+i,{type:'image',originId:id,png:b.toString('base64'),caption:'网页：'+page.caption+(images.length>1?'（'+(i+1)+'/'+images.length+'）':''),...extra}));}catch(e){this.emit(id+'-html-error-'+n,{type:'status',text:'网页「'+page.caption+'」暂时没能转成图片，可在电脑上打开。'});}}await this.flush().catch(()=>{});this.kick?.();})();
  this.htmlWork=work;}
 pause(){this.journal.change(s=>{s.enabled=false;});clearInterval(this.timer);this.timer=null;this.online=false;return this.status();}
 close(){this.closed=true;clearInterval(this.timer);}
}
module.exports={PhoneChannel};
