'use strict';
const {parentPort,workerData}=require('node:worker_threads');
const {SessionSearchEngine}=require('./session-search-engine');
const engine=new SessionSearchEngine({...workerData,backgroundWriter:false},status=>parentPort.postMessage({type:'status',status}));
parentPort.on('message',async message=>{
  try {
    if(message.type==='close') {
      await engine.refreshPromise;
      await engine.close();
      parentPort.postMessage({type:'closed'});parentPort.close();return;
    }
    const status=await engine.refresh(message.snapshot,message.options);
    parentPort.postMessage({id:message.id,result:status});
  } catch(error) {parentPort.postMessage({id:message.id,error:error.message});}
});
