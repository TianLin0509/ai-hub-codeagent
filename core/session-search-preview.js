'use strict';
const fs = require('node:fs');
const { termsFor } = require('./session-search-ranking');
const { discoverCompletionArtifacts } = require('./completion-artifacts');
const { normalizeRequest } = require('./session-search-query');

function readSearchPreview(index, request={}) {
  const key=String(request.sessionKey||'');
  const sessionRow=index.selectSession.get(key);
  if(!sessionRow) return null;
  const session={key,sessionKey:key,title:sessionRow.title,provider:sessionRow.provider,cwd:sessionRow.cwd,
    projectLabel:sessionRow.project_label,transcriptPath:sessionRow.transcript_path};
  // Read metadata first: a long tool transcript must not be materialized just
  // to show one related question and answer.
  const docs=index.db.prepare('SELECT id,event_id,scope,role,speaker,ordinal,timestamp FROM docs WHERE session_key=? ORDER BY ordinal,id').all(key).filter(d=>d.scope!=='title');
  if(!docs.length) {
    if(request.eventId && request.eventId!=='title') return {state:'stale',error:'命中原文已变化，请重新搜索后打开',session,context:[]};
    return {session,context:[],titleOnly:true,totalRecords:0,sourceAvailability:'metadata-only',artifacts:[]};
  }
  let at=docs.findIndex(d=>d.event_id===request.eventId);
  const stale=()=>({state:'stale',error:'命中原文或阅读位置已变化，请重新搜索后打开',session,context:[]});
  if(request.eventId && request.eventId!=='title' && at<0) return stale();
  for(const id of [request.afterEventId,request.beforeEventId,request.expandEventId].filter(Boolean)) if(!docs.some(d=>d.event_id===id)) return stale();
  if(at<0) { at=docs.map(d=>d.scope).lastIndexOf('user'); if(at<0) at=docs.length-1; }
  let start=at;
  while(start>0 && docs[start].scope!=='user') start--;
  let end=at+1;
  while(end<docs.length && docs[end].scope!=='user') end++;
  const mode=request.mode==='conversation'?'conversation':request.mode==='hits'?'hits':'overview';
  let chosen, pageStart=start, pageEnd=end;
  const terms=termsFor(request.query);
  if(mode==='hits') {
    const filters=normalizeRequest({query:request.query,...request.filters});
    const where=terms.map(()=> 'instr(normalized_text,?)>0').join(' OR ');
    const timed=filters.time.field==='eventTime' && (filters.time.from!=null || filters.time.to!=null);
    const timeWhere=timed?" AND event_id<>'last-output-preview' AND timestamp>0 AND timestamp>=? AND timestamp<=?":'';
    const ids=new Set(terms.length?index.db.prepare(`SELECT id FROM docs WHERE session_key=? AND scope<>'title' AND scope IN (${filters.scopes.map(()=>'?')}) AND (${where})${timeWhere}`)
      .all(key,...filters.scopes,...terms,...(timed?[filters.time.from??0,filters.time.to??Number.MAX_SAFE_INTEGER]:[])).map(d=>d.id):[]);
    const matches=docs.filter(d=>ids.has(d.id));
    if(request.afterEventId && !matches.some(d=>d.event_id===request.afterEventId)) return stale();
    const offset=request.afterEventId?matches.findIndex(d=>d.event_id===request.afterEventId)+1
      :request.expandEventId?Math.max(0,matches.findIndex(d=>d.event_id===request.expandEventId)):0;
    chosen=matches.slice(offset,offset+20);
    pageStart=offset;pageEnd=Math.min(matches.length,offset+20);
    end=matches.length;
  } else if(mode==='conversation') {
    if(request.afterEventId) pageStart=docs.findIndex(d=>d.event_id===request.afterEventId)+1;
    else if(request.beforeEventId) pageStart=Math.max(0,docs.findIndex(d=>d.event_id===request.beforeEventId)-20);
    else pageStart=request.expandEventId?docs.findIndex(d=>d.event_id===request.expandEventId):start;
    if(pageStart<0) pageStart=0;
    pageEnd=Math.min(docs.length,pageStart+20); chosen=docs.slice(pageStart,pageEnd);end=docs.length;
  } else {
    const episode=docs.slice(start,end);
    const dialogue=episode.filter(d=>d.scope!=='tool');
    const tools=episode.filter(d=>d.scope==='tool');
    chosen=[...dialogue.slice(0,2),...dialogue.slice(-3),...tools.slice(0,8),docs[at]];
    chosen=[...new Map(chosen.map(d=>[d.id,d])).values()].sort((a,b)=>a.ordinal-b.ordinal||a.id-b.id);
  }
  const textStatement=index.db.prepare('SELECT substr(text,?+1,?) AS text,length(text) AS full_length,substr(text,-16000) AS tail FROM docs WHERE id=?');
  const artifacts=[], seen=new Set();
  const context=chosen.map(doc=>{
    const expanded=request.expandEventId===doc.event_id;
    const max=expanded?64*1024:12000;
    const offset=expanded?Math.max(0,Math.floor(Number(request.textOffset)||0)):0;
    const stored=textStatement.get(offset,max,doc.id);
    const raw=stored?.text||'', fullLength=Number(stored?.full_length)||0;
    // SQLite length/substr offsets count Unicode code points, not UTF-16 units.
    const textLength=Array.from(raw).length;
    if(doc.scope==='assistant') for(const artifact of discoverCompletionArtifacts(raw+'\n'+stored.tail,session.cwd,{maxArtifacts:12})) {
      const identity=artifact.path||artifact.absolutePath||artifact.url;
      if(identity && !seen.has(identity)) {seen.add(identity);artifacts.push(artifact);}
    }
    return {eventId:doc.event_id,scope:doc.scope,role:doc.role||doc.scope,speaker:doc.speaker,
      timestamp:Number(doc.timestamp)||null,ordinal:doc.ordinal,text:raw,
      truncated:offset+textLength<fullLength,fullLength,expanded,textOffset:offset,
      nextTextOffset:offset+textLength<fullLength?offset+textLength:null,isMatch:mode==='hits' || doc.event_id===request.eventId,
      containsQuery:terms.some(term=>raw.normalize('NFKC').toLowerCase().includes(term))};
  });
  return {session,context,mode,targetEventId:docs[at].event_id,totalRecords:docs.length,
    episodeRecords:end-start,omittedRecords:mode==='overview'?Math.max(0,end-start-chosen.length):0,
    beforeCursor:mode==='conversation' && pageStart>0?chosen[0]?.event_id:null,
    afterCursor:mode!=='overview' && pageEnd<end?chosen.at(-1)?.event_id:null,
    artifacts,sourceAvailability:!session.transcriptPath?'indexed':fs.existsSync(session.transcriptPath)?'available':'missing',
  };
}
module.exports={readSearchPreview};
