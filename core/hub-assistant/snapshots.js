'use strict';
const fs=require('node:fs'),path=require('node:path');
const {createHash}=require('node:crypto');
const hashPacket=packet=>createHash('sha256').update(JSON.stringify(packet),'utf8').digest('hex');
class AssistantSnapshots {
  constructor(dataDir,store){this.directory=path.join(dataDir,'assistant','snapshots');this.store=store;}
  file(token){if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(token))throw new Error('资料请求编号无效');return path.join(this.directory,token+'.json');}
  save({requestId,requestToken,packet}){
    const packetHash=hashPacket(packet),createdAt=Date.now();
    const snapshot={schemaVersion:1,requestId,requestToken,createdAt,packetHash,packet};
    fs.mkdirSync(this.directory,{recursive:true});const file=this.file(requestToken),tmp=file+'.tmp';
    fs.writeFileSync(tmp,JSON.stringify(snapshot),{encoding:'utf8',mode:0o600});fs.renameSync(tmp,file);
    this.prune(createdAt);
    const manifest={requestToken,packetHash,sourceCount:packet.sources.length,selectedChars:packet.selectedChars||0,
      asOf:packet.asOf,since:packet.since,until:packet.until,range:packet.range,truncated:!!packet.truncated,
      state:'prepared-not-read',retrieval:'history_context(requestToken)'};
    this.store.set('snapshot:'+requestToken,{requestId,manifest,createdAt});return manifest;
  }
  // 资料包只在本轮有用；保留 7 天便于排查，更早的删除。
  prune(now=Date.now(),maxAgeMs=7*24*3600000){
    try{for(const name of fs.readdirSync(this.directory)){if(!name.endsWith('.json'))continue;const file=path.join(this.directory,name);
      if(now-fs.statSync(file).mtimeMs>maxAgeMs)fs.unlinkSync(file);}}catch(error){console.warn('[assistant] snapshot prune',error.message);}
  }
  read(requestToken){
    const snapshot=JSON.parse(fs.readFileSync(this.file(requestToken),'utf8'));
    if(snapshot.requestToken!==requestToken||snapshot.packetHash!==hashPacket(snapshot.packet))throw new Error('冻结资料完整性校验失败');
    const receipt={requestToken,packetHash:snapshot.packetHash,sourceCount:snapshot.packet.sources.length,
      selectedChars:snapshot.packet.selectedChars||0,readAt:Date.now(),identityVerified:true,
      evidence:'host-read-and-prepared-response; native receipt requires transcript verification'};
    this.store.set('snapshotRead:'+requestToken,receipt);
    return{kind:'frozen-snapshot',packet:snapshot.packet,snapshotReceipt:receipt};
  }
}
module.exports={AssistantSnapshots,hashPacket};
