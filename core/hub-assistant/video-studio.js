'use strict';
// 学习视频工作室（2026-10-09 改为 Vibe 知识大赏式：无旁白、图形动画 + 拟声 + 垫音）。
// 只按分镜本机渲染，不等配音、不调付费视频模型；成片经已有加密中继分片发给手机。
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {validateStoryboard,renderVibeVideo}=require('./video/vibe-renderer');
const CHUNK=192*1024,ID=/^[A-Za-z0-9-]{8,64}$/;
const defaultRenderer=opts=>renderVibeVideo({...opts,capture:require('./video/electron-capture').electronCapture()});
class VideoStudio{
  constructor({assistant,renderer=defaultRenderer,tools=()=>require('./podcast/voice').tools()}){
    this.a=assistant;this.root=path.join(assistant.deps.dataDir,'assistant','videos');this.renderer=renderer;this.tools=tools;this.running=new Map();this.queue=Promise.resolve();fs.mkdirSync(this.root,{recursive:true});
    for(const m of this.list())if(m.status==='working')this.save({...m,status:'interrupted',phase:'上次制作被中断，可以让助理重新制作'});
  }
  dir(id){if(!ID.test(id))throw Error('视频编号无效');return path.join(this.root,id);}
  read(id){return JSON.parse(fs.readFileSync(path.join(this.dir(id),'manifest.json'),'utf8'));}
  save(m){const dir=this.dir(m.id);fs.mkdirSync(dir,{recursive:true});const f=path.join(dir,'manifest.json');fs.writeFileSync(f+'.tmp',JSON.stringify(m));fs.renameSync(f+'.tmp',f);this.a.workbench?.changed();return m;}
  list(){const out=[];for(const id of fs.readdirSync(this.root)){if(!ID.test(id))continue;try{out.push(this.read(id));}catch(e){console.warn('[assistant] video manifest',id,e.message);}}return out.sort((a,b)=>b.createdAt-a.createdAt).slice(0,30);}
  // 手机清单不带分镜正文，只带标题、状态、时长、选题依据与讲述卡。
  summary(){return this.list().map(({storyboard,scenes,...m})=>m);}
  start(lesson){
    const storyboard=validateStoryboard({...lesson.storyboard,title:lesson.title});
    const id='video-'+crypto.createHash('sha256').update(JSON.stringify(storyboard)).digest('hex').slice(0,20);
    if(fs.existsSync(path.join(this.dir(id),'manifest.json'))&&(['done','working'].includes(this.read(id).status)||this.running.has(id)))return{id,duplicate:true};
    const m=this.save({id,title:lesson.title,storyboard,why:lesson.why||'',evidenceRefs:lesson.evidenceRefs||[],sources:lesson.sources||[],oneMinute:lesson.oneMinute||'',questions:lesson.questions||[],createdAt:Date.now(),status:'working',phase:'排队制作视频',progress:0,seconds:Math.round(storyboard.screens.reduce((a,s)=>a+s.duration+.3,0)),bytes:0});
    const job=this.queue.then(async()=>{
      const t=this.tools();
      const r=await this.renderer({storyboard,dir:this.dir(id),ffmpeg:t.ffmpeg,ffprobe:t.ffprobe,onProgress:(phase,progress)=>this.save({...this.read(id),phase,progress})});
      this.save({...this.read(id),...r,status:'done',phase:'视频已完成，可以下载观看',progress:100,sha256:crypto.createHash('sha256').update(fs.readFileSync(path.join(this.dir(id),'video.mp4'))).digest('hex'),finishedAt:Date.now()});
      try{this.a.onVideoDone?.(this.read(id));}catch(e){console.warn('[assistant] video done notice',e.message);}
    }).catch(e=>{console.warn('[assistant] video',e.message);this.save({...this.read(id),status:'failed',phase:'制作失败：'+e.message,error:e.message});}).finally(()=>this.running.delete(id));
    this.queue=job;this.running.set(id,job);return{id};
  }
  chunk(id,index){const m=this.read(id);if(m.status!=='done')throw Error('视频还没完成');if(!Number.isInteger(index)||index<0||index>=Math.ceil(m.bytes/CHUNK))throw Error('视频分段编号无效');const f=path.join(this.dir(id),'video.mp4'),fd=fs.openSync(f,'r');try{const b=Buffer.alloc(Math.min(CHUNK,m.bytes-index*CHUNK)),n=fs.readSync(fd,b,0,b.length,index*CHUNK);if(n!==b.length)throw Error('视频文件被改变，请刷新');return{id,index,total:Math.ceil(m.bytes/CHUNK),bytes:m.bytes,sha256:m.sha256,data:b.toString('base64')};}finally{fs.closeSync(fd);}}
  // 封面：钩子屏定格的 JPEG，手机缓存后做缩略图。
  cover(id){const f=path.join(this.dir(id),'cover.jpg');if(!fs.existsSync(f))throw Error('封面还没生成');const b=fs.readFileSync(f);if(b.length>400*1024)throw Error('封面过大');return b.toString('base64');}
}
module.exports={VideoStudio,CHUNK,validateStoryboard};
