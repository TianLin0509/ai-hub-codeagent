'use strict';
// A locator timing out is an action failure, not a reason to detach every MCP.
// Only an expired outer deadline cancels a page, and only that request's page.
class Dispatcher {
  constructor(session) { this.session=session;this.chains=new Map(); }
  async call(lane,argv,timeoutMs) {
    const command=require('./hub-browser-tool').argumentsOf(argv)[0];
    if(['human-open','transport-release'].includes(command)&&this.chains.size)throw Error('Browser busy');
    let cancelled=false,started=false,timer;
    const work=(this.chains.get(lane)||Promise.resolve()).catch(()=>{}).then(()=>{
      if(cancelled)throw Error('Browser step deadline exceeded before execution');
      started=true;return this.session.execute(lane,argv);
    });
    const tail=work.catch(()=>{}).finally(()=>{if(this.chains.get(lane)===tail)this.chains.delete(lane);});
    this.chains.set(lane,tail);
    try {
      return await Promise.race([work,new Promise((_,reject)=>{
        timer=setTimeout(()=>{cancelled=true;reject(Error('Browser step deadline exceeded'));},timeoutMs);
      })]);
    } catch(error) {
      if(cancelled&&started)await this.session.abortLane(lane);
      throw error;
    } finally { clearTimeout(timer); }
  }
}
module.exports={Dispatcher};
