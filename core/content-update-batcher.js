'use strict';
// Batch observations, not provider events or durable receipts. Each callback
// reads the current complete content; different submissions keep separate keys.
function createContentUpdateBatcher({delayMs=80, onError=error=>console.error('[content-update]',error)}={}) {
  const pending=new Map();let timer=null;
  function flush(scope) {
    if(scope===undefined){if(timer)clearTimeout(timer);timer=null;}
    for(const [key,entry] of [...pending]) {
      if(scope!==undefined && entry.scope!==scope)continue;
      pending.delete(key);
      try{entry.run();}catch(error){onError(error);}
    }
    if(pending.size)scheduleTimer();
    else {if(timer)clearTimeout(timer);timer=null;}
  }
  function scheduleTimer(){if(!timer){timer=setTimeout(()=>flush(),delayMs);timer.unref?.();}}
  return {
    schedule(scope,key,run){pending.set(JSON.stringify([scope,key]),{scope,run});scheduleTimer();},
    flush,
    dispose(){flush();if(timer)clearTimeout(timer);timer=null;},
  };
}
module.exports={createContentUpdateBatcher};
