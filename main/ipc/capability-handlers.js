'use strict';
function registerCapabilityIpc(ipcMain,service) {
  const handle=(name,fn)=>ipcMain.handle('capabilities:'+name,async(_event,request={})=>{
    try {return {ok:true,data:await fn(request || {})};}
    catch(error){return {ok:false,error:error.message};}
  });
  handle('catalog',r=>service.catalog(r.refresh===true));
  handle('update-note',r=>service.updateNote(r));
  handle('sharing-plan',()=>service.sharingPlan());
  handle('share-skills',r=>{if(typeof r.token!=='string')throw Error('请先预览补齐计划');return service.shareSkills(r.token);});
  handle('runtime',r=>{if(typeof r.sessionId!=='string')throw Error('请选择会话');return service.runtime(r.sessionId);});
}
module.exports={registerCapabilityIpc};
