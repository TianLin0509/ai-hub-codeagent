'use strict';
const path=require('path');
function entry(dataDir){return {name:'web_roundtable',command:process.execPath,args:[path.join(__dirname,'server.js')],env:{ELECTRON_RUN_AS_NODE:'1',AI_HUB_WEB_DATA_DIR:path.resolve(dataDir)}};}
function enabled(profile){return profile==='browser'||profile==='full';}
function entries(existing,profile,dataDir){const list=Array.isArray(existing)?existing:[];return enabled(profile)&&dataDir&&!list.some(e=>e.name==='web_roundtable')?[...list,entry(dataDir)]:list;}
module.exports={entry,enabled,entries};
