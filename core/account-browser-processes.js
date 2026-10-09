'use strict';
const path=require('path');
function matchesProfile(command,profile){
 const literal=path.resolve(profile).replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
 return new RegExp('(?:^|\\s)(?:"--user-data-dir='+literal+'"|--user-data-dir="'+literal+'"|--user-data-dir='+literal+')(?=\\s|$)','i').test(command);
}
async function profileOwners(profile){
 // New inspector per action: never accept its previous-snapshot fallback when
 // deciding whether a human-owned browser has actually closed.
 const snapshot=await require('./process-inspector').createProcessInspector().snapshot({force:true});
 const browsers=snapshot.processes.filter(p=>/^(chrome|msedge)\.exe$/i.test(p.name));
 if(browsers.some(p=>!p.cmd))throw Error('无法确认浏览器占用情况，请关闭该网站专用窗口后重试');
 return browsers.filter(p=>!/(?:^|\s)--type=/.test(p.cmd)&&matchesProfile(p.cmd,profile))
  .map(p=>({pid:p.pid,automated:/--remote-debugging-(?:port|pipe)|--headless|--enable-automation/.test(p.cmd)}));
}
module.exports={matchesProfile,profileOwners};
