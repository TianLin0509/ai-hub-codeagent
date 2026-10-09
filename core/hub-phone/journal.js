'use strict';
const fs=require('node:fs'),path=require('node:path');
class PhoneJournal{
 constructor(dir,safeStorage){this.dir=dir;this.file=path.join(dir,'channel.bin');this.safe=safeStorage;fs.mkdirSync(dir,{recursive:true});this.state=fs.existsSync(this.file)?JSON.parse(safeStorage.decryptString(fs.readFileSync(this.file))):{enabled:false,cursor:0,inbox:[],outbox:[],notices:[]};for(const r of this.state.inbox)if(r.state==='dispatching'){r.state='unknown';r.issue='上次提交被中断，先核对，不自动重发';}for(const r of this.state.inbox)if(r.state==='transcribing'||r.state==='switching'){r.state='queued';}this.save();}
 // Windows 上刚写完的文件常被杀毒/索引短暂占用：EPERM/EBUSY/EACCES 时稍等重试，不让一次占用打断整轮收发。
 save(){const data=this.safe.encryptString(JSON.stringify(this.compact()));for(let i=0;;i++){try{fs.writeFileSync(this.file+'.tmp',data);fs.renameSync(this.file+'.tmp',this.file);return;}catch(e){if(i>=5||!['EPERM','EBUSY','EACCES'].includes(e.code))throw e;Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,40*(i+1));}}}
 // 只留必要记录（2026-10-05：发出的图片、网页全文原先永久留在 channel.bin，涨到 4MB+，每次状态变化都整份重写）：
 // 已发出的消息只留编号用于去重（最近 600 条），办完的收件只留最近 300 条，提醒去重表只留最近 500 条。
 compact(){const s=this.state;for(const r of s.outbox)if(r.sent)delete r.payload;
  if(s.outbox.length>600)s.outbox=s.outbox.filter((r,i)=>!r.sent||i>=s.outbox.length-600);
  const DONE=['done','answered','rejected','lost','unknown'],done=s.inbox.filter(r=>DONE.includes(r.state));
  if(done.length>300){const drop=new Set(done.slice(0,done.length-300));s.inbox=s.inbox.filter(r=>!drop.has(r));}
  for(const r of s.inbox)if(DONE.includes(r.state))delete r.pcm;
  if(Array.isArray(s.notices)&&s.notices.length>500)s.notices=s.notices.slice(-500);
  return s;}
 change(fn){fn(this.state);this.save();}
}
module.exports={PhoneJournal};
