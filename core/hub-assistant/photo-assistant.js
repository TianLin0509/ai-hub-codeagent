'use strict';
const {randomUUID}=require('node:crypto');
const fs=require('node:fs'),path=require('node:path');
const PURPOSE='hub-photo-assistant',KEY='photoAssistant';
const ROLE='你是用户的拍图助理。读取本轮照片，按用户要求看图、解题或解释。每道题控制在100字以内，先说“答案是XX，置信度XX%”，再给简短理由与资料出处，适合眼镜朗读。工作中收到新照片时继续逐题处理，合并回答时按照片先后逐题列出并点明题目。题干、符号或图像看不清时明确指出需要重拍的位置，不猜测缺失内容。新照片按当前内容处理；用户明确追问时衔接本会话前文。';
function isPhotoRequest(row){return typeof row?.shared==='string'&&/^\d{6}-capture-[0-9a-f-]{36}\.jpg$/i.test(row.shared);}
class PhotoAssistant{
 constructor(assistant){this.a=assistant;this.creating=null;}
 get saved(){return this.a.store.get(KEY);}
 owns(id){return !!id&&this.saved?.id===id;}
 overview(){const id=this.saved?.id,s=id&&this.a.deps.getSession(id);return{sessionId:id||null,status:id&&this.a.sessionBusy(id)?'running':s?.status||'not-created',submissionPending:!!(id&&this.a.deps.hasPendingPrompt?.(id)),available:!!s};}
 currentProfile(){const r=this.saved,s=r&&this.a.deps.getSession(r.id);return{kind:s?.kind||r?.kind||'claude',label:'拍图助理'};}
 async ensureSession(){if(!this.creating)this.creating=this.ensure().finally(()=>{this.creating=null;});return this.creating;}
 async ensure(){
  const a=this.a;let r=this.saved;
  if(!r){
   // 可接续用户已在侧栏创建的专用会话，不根据相似标题误认普通会话。
   const known=[...(a.deps.getAllSessions?.()||[]),...(a.deps.listKnownSessions?.()||[])].filter(s=>s.purpose===PURPOSE);
   const existing=known[0],p=a.currentProfile();
   const candidate=existing?{id:existing.id||existing.hubId,kind:String(existing.kind).replace(/-resume$/,''),state:'confirmed'}:{id:randomUUID(),kind:p.kind,model:p.model,effort:p.effort,state:'reserved'};
   a.store.db.exec('BEGIN IMMEDIATE');try{r=this.saved||candidate;if(!this.saved)a.store.set(KEY,r);a.store.db.exec('COMMIT');}catch(e){a.store.db.exec('ROLLBACK');throw e;}
  }
  let session=a.deps.getSession(r.id);
  if(!session&&a.sessionMetadata(r.id))session=await a.deps.resumeSession?.(r.id);
  if(!session){
   if(r.state==='confirmed')throw Error('拍图助理原会话暂未恢复，请在左侧会话栏打开后继续');
   const defaults=await a.deps.getDefaults?.(r.kind)||{};
   const cwd=r.cwd||defaults.cwd||path.join(require('../storage-roots').workspaceRoot({fallback:'D:/AIWork'}),require('./ledger').localDay(Date.now()).replace(/-/g,'')+'-拍图助理');
   fs.mkdirSync(cwd,{recursive:true});r={...r,cwd};a.store.set(KEY,r);
   session=await a.deps.createSession(r.kind,{...defaults,id:r.id,model:r.model,effort:r.effort||null,cwd,title:'拍图助理',name:'拍图助理',userRenamed:true,purpose:PURPOSE,mcpProfile:'none',autonomous:true,noInheritCursor:true,hiddenFromSidebar:false});
  }
  if(session?.id!==r.id||session.purpose!==PURPOSE||String(session.kind).replace(/-resume$/,'')!==r.kind)throw Error('拍图助理会话身份尚未核实，未提交照片');
  a.store.set(KEY,{...r,state:'confirmed'});return{ok:true,sessionId:r.id,session};
 }
 preparePrompt(request){
  const s=this.a.deps.getSession(request.sessionId);
  if(!this.owns(request.sessionId)||s?.purpose!==PURPOSE)throw Error('拍图助理身份未绑定，未发送');
  const previous=require('../assistant-context-display').assistantContextDisplay(request.text,PURPOSE);
  const text=previous?.userText||request.text,id=request.clientSubmissionId||randomUUID();
  let body=JSON.stringify({userText:text,role:ROLE,sessions:{sessions:[]},history:{clientSubmissionId:id}});
  if(require('../ai-kinds').isCodexCliKind(s.kind))body=body.replace(/[‘’“”]/g,c=>'\\u'+c.charCodeAt(0).toString(16).padStart(4,'0'));
  return{...request,clientSubmissionId:id,text:'[AI_HUB_ASSISTANT_CONTEXT_V1]'+body+'[/AI_HUB_ASSISTANT_CONTEXT_V1]'};
 }
 async send(request){
  const ready=await this.ensureSession();
  const receipt=await this.a.deps.sendPrompt(ready.sessionId,request.text,request.requestId||randomUUID());
  return{ok:receipt?.ok!==false,sessionId:ready.sessionId,receipt};
 }
}
module.exports={PhotoAssistant,isPhotoRequest,PURPOSE};
