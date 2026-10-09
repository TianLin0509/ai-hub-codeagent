'use strict';
const http = require('node:http');
const { randomBytes, timingSafeEqual } = require('node:crypto');
class AssistantBridge {
  // identityHeader 默认是助理的请求头；编排模式另起一个实例并用自己的请求头。
  constructor(invoke,{identityHeader='x-hub-assistant-session'}={}) { this.invoke=invoke; this.identityHeader=identityHeader; this.secret=randomBytes(32).toString('hex'); }
  async start() {
    if(this.server) return this;
    this.server=http.createServer((req,res)=>{
      const supplied=Buffer.from(String(req.headers.authorization||'')), expected=Buffer.from('Bearer '+this.secret);
      if(req.method!=='POST'||req.url!=='/tool'||supplied.length!==expected.length||!timingSafeEqual(supplied,expected)) {res.writeHead(403);res.end();return;}
      // Decode across chunk boundaries so Chinese task text is preserved.
      req.setEncoding('utf8');
      let body='';
      req.on('data',chunk=>{body+=chunk;if(body.length>100000)req.destroy();});
      req.on('end',async()=>{try{const request=JSON.parse(body);
        // Always supply an identity, including the empty value. Network calls
        // cannot enter the legacy internal path or spoof identity in the body.
        request.callerSessionId=String(req.headers[this.identityHeader]||'');
        const result=await this.invoke(request);res.setHeader('Content-Type','application/json');res.end(JSON.stringify({ok:true,result}));}catch(error){res.writeHead(400,{'Content-Type':'application/json'});res.end(JSON.stringify({ok:false,error:error.message}));}});
    });
    await new Promise((resolve,reject)=>{this.server.once('error',reject);this.server.listen(0,'127.0.0.1',resolve);});
    this.server.unref();this.url=`http://127.0.0.1:${this.server.address().port}/tool`;return this;
  }
  close() {this.server?.close();this.server=null;}
}
module.exports={AssistantBridge};
