'use strict';
// The remote document UI keeps its sandbox. Only this main-process worker can
// claim tasks scoped to its random capability; the page receives no Hub IPC.
const fs=require('node:fs'),path=require('node:path'),{randomBytes}=require('node:crypto');
function bridgeRoot(value,catalog) {
  try {
    const url=new URL(value);
    if(url.protocol!=='https:'||url.username||url.password||!catalog.some(item=>new URL(item.url).origin===url.origin))return null;
    const match=url.pathname.match(/^\/(weekly|ai-team\/ui|reports\/[a-zA-Z0-9_-]+\/ui|style)(?:\/|$)/);
    return match ? `${url.origin}/${match[1]}/api/hub-ai` : null;
  }catch{return null;}
}
class CompanyWebAi {
  constructor({dataDir,catalog,run,fetch,onChanged=()=>{}}) {
    Object.assign(this,{catalog,run,fetch,onChanged});this.roots=new Map();this.closed=false;this.controllers=new Set();
    const file=path.join(dataDir,'company-web-ai-capability');fs.mkdirSync(dataDir,{recursive:true});
    try{this.capability=fs.readFileSync(file,'utf8').trim();}catch(e){if(e.code!=='ENOENT')throw e;}
    if(!/^[a-f0-9]{64}$/.test(this.capability||'')){this.capability=randomBytes(32).toString('hex');fs.writeFileSync(file,this.capability,{mode:0o600});}
  }
  attach(webSession) {
    this.fetch ||= (...args)=>webSession.fetch(...args);
    webSession.webRequest.onBeforeSendHeaders((details,callback)=>{
      const headers={...details.requestHeaders};
      // Strip a caller-supplied capability on every destination, including redirects.
      for(const key of Object.keys(headers))if(key.toLowerCase()==='x-hub-ai-client')delete headers[key];
      if(bridgeRoot(details.url,this.catalog))headers['X-Hub-AI-Client']=this.capability;
      callback({requestHeaders:headers});
    });
    webSession.webRequest.onHeadersReceived((details,callback)=>{
      const advertised=Object.entries(details.responseHeaders||{}).some(([k,v])=>k.toLowerCase()==='x-hub-ai-bridge'&&[].concat(v).includes('codeagent-v1'));
      if(advertised){const root=bridgeRoot(details.url,this.catalog);if(root&&!this.roots.has(root)){this.roots.set(root,false);void this.poll(root);}}
      callback({responseHeaders:details.responseHeaders});
    });
  }
  async request(root,op,body) {
    const response=await this.fetch(root+'/'+op,{method:'POST',redirect:'error',headers:{'Content-Type':'application/json','X-Hub-AI-Client':this.capability,'X-Weekly-Request':'1',Origin:new URL(root).origin},body:JSON.stringify(body),signal:AbortSignal.timeout(15000)});
    if(!response.ok)throw Error(`团队 AI 服务暂不可用（${response.status}）`);
    return response.json();
  }
  async poll(root) {
    if(this.closed||this.roots.get(root))return;this.roots.set(root,true);
    try{
      const claimed=await this.request(root,'claim',{});
      if(this.closed)return;
      if(claimed.job){
        const job=claimed.job;
        if(!/^[a-f0-9-]{36}$/.test(job.id)||!/^[a-f0-9]{64}$/.test(job.receipt)||typeof job.system!=='string'||typeof job.text!=='string')throw Error('团队 AI 任务格式无效');
        const controller=new AbortController();this.controllers.add(controller);let result;
        this.onChanged({state:'running',label:job.label||'团队文字任务'});
        try{const answer=await this.run({system:job.system,text:job.text,label:job.label||'团队文字任务'},{signal:controller.signal});result={text:answer.text};}
        catch{result={error:'CodeAgent 未完成任务，原材料保留，请在 Hub 查看会话后重试'};}
        finally{this.controllers.delete(controller);}
        // Retransmit only the receipt/result, never rerun an ambiguous model submission.
        let delivered=false;
        for(let i=0;i<3&&!this.closed;i++){try{await this.request(root,'complete',{id:job.id,receipt:job.receipt,...result});delivered=true;break;}catch{}}
        if(!delivered)throw Error('CodeAgent 结果回写失败；结果已保留在本机任务记录中');
        this.onChanged({state:result.error?'error':'done',label:job.label});
      }
    }catch(e){this.onChanged({state:'error',message:e.message});}
    finally{this.roots.set(root,false);if(!this.closed){const timer=setTimeout(()=>{void this.poll(root);},3000);timer.unref?.();}}
  }
  close(){this.closed=true;for(const controller of this.controllers)controller.abort();}
}
module.exports={CompanyWebAi,bridgeRoot};
