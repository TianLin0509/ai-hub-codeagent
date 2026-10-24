'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { AssistantBridge } = require('../hub-assistant/bridge');
const text = data => ({ type: 'text', text: JSON.stringify(data) });
class MeetingTools {
  constructor(m) {
    this.m = m; this.tokens = new Map(); this.bridge = new AssistantBridge(r => this.invoke(r), { resolveIdentity: auth => this.tokens.get(auth) || null });
  }
  endpoint(id) { return path.join(this.m.dir(id), 'meeting-tools-endpoint.json'); }
  start() { this.closed=false; return this.ready ||= this.bridge.start().then(() => { if(this.closed){this.bridge.close();return;} for (const id of this.m.ids()) { const m=this.m.load(id); if(m.sessionId)this.bind(m); } }).catch(e => { this.ready=null; throw e; }); }
  bind(m) {
    let token;
    try { const old=JSON.parse(fs.readFileSync(this.endpoint(m.id),'utf8')); token=old.token; } catch {}
    if(!/^[a-f0-9]{64}$/.test(token||''))token=randomBytes(32).toString('hex');
    this.tokens.set('Bearer '+token,m.sessionId);
    fs.writeFileSync(this.endpoint(m.id), JSON.stringify({url:this.bridge.url,token}),{mode:0o600});
  }
  entry(sessionId) { const id=this.m.ids().find(id=>this.m.load(id).sessionId===sessionId); if(!id)throw new Error('会议会话不存在');return {name:'meeting',command:this.m.deps.nodeExecutable||process.execPath,args:[path.join(__dirname,'meeting-mcp.js')],env:{ELECTRON_RUN_AS_NODE:'1',HUB_MEETING_ENDPOINT:this.endpoint(id)}}; }
  async invoke(r) {
    const id=this.m.ids().find(id=>this.m.load(id).sessionId===r.callerSessionId);if(!id||!r.callerSessionId)throw new Error('工具仅供所属会议会话使用');
    const a=r.arguments||{},m=this.m.load(id);
    if (r.name === 'meeting_index') {
      const index=this.m.recording.index(id),offset=Number(a.offset||0);if(!Number.isInteger(offset)||offset<0)throw new Error('分页位置无效');
      const segments=index.recording.segments,pages=m.events.filter(e=>e.kind==='slide');
      return {content:[text({title:m.title,durationMs:m.capturedMs,transcribedMs:m.transcribedMs,understoodMs:m.understoodMs,recording:{bytes:index.recording.bytes,savedThrough:index.recording.savedThrough,openGap:index.recording.openGap||null,gaps:index.recording.gaps.slice(offset,offset+60),totalGaps:index.recording.gaps.length,segments:segments.slice(offset,offset+60),totalSegments:segments.length},pages:pages.slice(offset,offset+60).map(({seq,at,file})=>({seq,at,file})),totalPages:pages.length,nextOffset:offset+60<Math.max(segments.length,pages.length,index.recording.gaps.length)?offset+60:null,skill:'skills/meeting-companion/SKILL.md'})]};
    }
    if (r.name === 'meeting_read') {
      const start=this.m.time(a.startMs??0),end=this.m.time(a.endMs??m.capturedMs);if(end<start||end-start>15*60000)throw new Error('每次读取最多15分钟');
      const offset=Number(a.offset||0);if(!Number.isInteger(offset)||offset<0)throw new Error('分页位置无效');
      const all=m.events.filter(e=>['transcript','mark','slide'].includes(e.kind)&&e.at<=end&&(e.end??e.at)>=start).sort((a,b)=>a.at-b.at||a.seq-b.seq),rows=all.slice(offset,offset+60);
      return {content:[text({startMs:start,endMs:end,total:all.length,events:rows,nextOffset:offset+rows.length<all.length?offset+rows.length:null,gaps:(m.recording?.gaps||[]).filter(g=>g.at<=end&&g.end>=start),transcribedMs:m.transcribedMs})]};
    }
    if (r.name === 'meeting_frames') {
      const frames=await this.m.frames.extract(id,a);
      return {content:frames.flatMap(({data,...meta})=>[text(meta),{type:'image',mimeType:'image/jpeg',data}])};
    }
    throw new Error('未知会议工具');
  }
  close(){this.closed=true;this.bridge.close();this.tokens.clear();this.ready=null;}
}
module.exports={MeetingTools};
