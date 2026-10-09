'use strict';
const {AssistantService}=require('../../core/hub-assistant/service');
const fs=require('node:fs'),path=require('node:path');
function registerAssistantIpc(ipcMain,deps){
  const service=new AssistantService(deps);
  ipcMain.on('assistant:session-view',(_event,packet)=>service.setSessionViews(packet));
  for(const [name,handler] of Object.entries({
    'session-cards':request=>service.sessionCards(request),
    'workbench':request=>request.refresh?service.workbench.refresh():service.workbench.snapshot(),
    'workbench-context':request=>({ok:true,text:service.workbench.context(request)}),
    'workbench-action':request=>service.workbench.action(request),
    'get-overview':()=>service.overview(),status:()=>service.overview(),
    'ensure-session':()=>service.ensureSession(),context:request=>service.context(request),
    'switch-backend':request=>service.switchBackend(request),
    'set-profile':request=>service.setProfile(request),'front-desk':()=>require('../../core/hub-assistant/front-desk').catalog(service.frontDesk()),'set-front-desk':request=>service.setFrontDesk(request),'memos':()=>service.memoView(),'memo-action':request=>{const r=service.memoAction(String(request?.ref||''),{action:request?.action,until:request?.until||'',title:request?.title||''});return{ok:true,memo:r.memo};},'dialog-log':request=>service.dialogLog(request),ask:request=>service.ask(request),'page-status':()=>service.pageStatus(),'rotate-now':()=>service.rotateNow(),
    'open-memory':async()=>{const file=service.memory.file('user');if(!deps.openPath)return{ok:false,error:'记忆文件暂不可打开'};const error=await deps.openPath(file);return error?{ok:false,error}:{ok:true,path:file};},'phone-profile':()=>service.phoneProfile(),
    send:request=>service.send(request),actions:()=>({ok:true,actions:service.store.list()}),
    notifications:request=>service.notifications(request),
    'mark-notification-read':request=>service.watches.markRead(request.id),
    'follow-task':request=>service.followTask(request),
    'unfollow-task':request=>service.watches.unfollow(request.sessionId),
    'followed-tasks':()=>({ok:true,tasks:service.followedTasks()}),
    'open-workbench':async()=>{const id=service.store.get('sessionId'),closed=id&&!deps.getSession(id);const file=closed?path.join(deps.dataDir,'assistant','workbench','CURRENT.md'):service.refreshDossier().markdownPath;if(!file||!fs.existsSync(file)||!deps.openPath)return{ok:false,error:'工作档案暂不可打开'};const error=await deps.openPath(file);return error?{ok:false,error}:{ok:true,path:file};},
  }))ipcMain.handle('assistant:'+name,async(_event,request={})=>{try{return await handler(request);}catch(error){return{ok:false,error:error.message};}});
  return service;
}
module.exports={registerAssistantIpc};
