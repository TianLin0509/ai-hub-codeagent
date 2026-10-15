'use strict';
// 手机通道同一时间只允许一个 Hub 进程收发（2026-10-15）。
// Hub 重启时新进程先起、旧进程 10～60 秒后才退出，两边同时读写 channel.bin、同时拉取中继，
// 会互相覆盖记录、重复处理手机消息。新进程拿不到锁就等旧进程退出（或心跳超过 30 秒视为已死）再接手。
const fs=require('node:fs');
function alive(pid){try{process.kill(pid,0);return true;}catch(e){return e.code==='EPERM';}}
class WriterLock{
 constructor(file,{pid=process.pid,staleMs=30000,now=Date.now,isAlive=alive}={}){this.file=file;this.pid=pid;this.staleMs=staleMs;this.now=now;this.isAlive=isAlive;this.held=false;}
 read(){try{const v=JSON.parse(fs.readFileSync(this.file,'utf8'));return Number.isInteger(v.pid)?v:null;}catch{return null;}}
 write(){fs.writeFileSync(this.file+'.tmp',JSON.stringify({pid:this.pid,at:this.now()}));fs.renameSync(this.file+'.tmp',this.file);}
 holder(){const v=this.read();return v&&v.pid!==this.pid&&this.isAlive(v.pid)&&this.now()-v.at<this.staleMs?v:null;}
 tryAcquire(){if(this.holder())return false;this.write();this.held=this.read()?.pid===this.pid;return this.held;}
 beat(){if(this.held&&this.read()?.pid===this.pid)this.write();}
 release(){if(this.held&&this.read()?.pid===this.pid)try{fs.unlinkSync(this.file);}catch{}this.held=false;}
}
module.exports={WriterLock,alive};
