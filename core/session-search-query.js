'use strict';

const { DatabaseSync } = require('node:sqlite');
const { randomUUID } = require('node:crypto');
const { normalize, termsFor, normalizeSort, documentRank, compareRank, compareResults, rankReason, RANK_VERSION } = require('./session-search-ranking');
const { createSnippet, isCjkAuxTerm, sinceTimestamp } = require('./session-search-index');
const { normalizeProjectFilter, matchesProjectFilter } = require('./session-search-projects');
const { matchesSearchProvider } = require('./session-search-providers');
const DIALOGUE = ['title', 'user', 'assistant'];
// 工具 doc 不在全文索引里，所以它不是一个可检索范围；老请求里的 tool 直接忽略。
const ALL_SCOPES = [...DIALOGUE];
const quote = value => '"' + value.replace(/"/g, '""') + '"';

function normalizeRequest(request, now = Date.now()) {
  if (String(request.query || '').length > 512) throw new Error('搜索关键词过长（最多 512 个字符）');
  const query = normalize(String(request.query || '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, ''));
  if(String(request.query||'').trim() && !query) throw new Error('请输入可搜索的文字，控制字符不能作为关键词');
  const time = request.time || {};
  const from = time.from != null ? Number(time.from) : sinceTimestamp(request.timeRange, now);
  const to = time.to != null ? Number(time.to) : from != null ? now : null;
  if ((from != null && !Number.isFinite(from)) || (to != null && !Number.isFinite(to)) || (from != null && to != null && from > to)) throw new Error('时间范围无效');
  const requested = Array.isArray(request.scopes) ? [...new Set(request.scopes)].filter(scope => scope !== 'tool') : [];
  const scopes = requested.length ? requested.sort() : DIALOGUE.slice().sort();
  if (scopes.some(scope=>!ALL_SCOPES.includes(scope))) throw new Error('搜索内容范围无效');
  let filter = null;
  if (request.sessionFilter != null) {
    if (typeof request.sessionFilter !== 'object' || Array.isArray(request.sessionFilter)) throw new Error('Invalid session filter');
    filter = {};
    for (const key of ['hubSessionIds','meetingIds']) {
      const ids = request.sessionFilter[key] || [];
      if (!Array.isArray(ids)) throw new Error('Session filter IDs must be arrays');
      filter[key] = [...new Set(ids.filter(id=>typeof id==='string' && id))].sort();
    }
  }
  const sort = query ? normalizeSort(request.sort, query) : normalizeSort(request.sort === 'relevance' ? 'conversationTime' : request.sort);
  return { query, providers:[...new Set(Array.isArray(request.providers)?request.providers:[])].sort(), scopes,
    project:normalize(request.project), projectFilter:normalizeProjectFilter(request.projectFilter), sessionFilter:filter, sort,
    direction: request.direction || (sort==='title'?'asc':'desc'),
    time:{field:time.field === 'conversationTime' ? 'conversationTime':'eventTime',from,to,timeZone:time.timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone},
    limit:Math.min(200,Math.max(1,Number(request.limit || request.pageSize)||50)), now };
}

function sessionFrom(row) {
  return { key:row.key, sessionKey:row.key, provider:row.provider, nativeFamily:row.native_family,
    kind:row.kind, title:row.title || '未命名会话', cwd:row.cwd, projectLabel:row.project_label,
    model:row.model, updatedAt:Number(row.updated_at)||0, lastConversationAt:Number(row.last_conversation_at)||null,
    hubSessionId:row.hub_session_id, nativeSessionId:row.native_session_id, meetingId:row.meeting_id,
    transcriptPath:row.transcript_path, codexSessionsRoot:row.codex_sessions_root, codexProfile:row.codex_profile,
    turnCount:Number(row.turn_count)||0 };
}

// One read transaction per live query. Incremental writes can commit while a
// user pages through this frozen snapshot; no missing/repeated rows on refresh.
class QuerySnapshot {
  constructor(owner, request) {
    this.id = randomUUID(); this.request = request; this.lastUsed = Date.now(); this.done = false;
    this.groups = new Map(); this.seen = new Set(); this.users = new Map();
    this.terms = termsFor(request.query).sort((a,b)=>b.length-a.length);
    this.termIndex = 0; this.afterId = 0; this.scanned = 0; this.db = null;
    try {
      this.db = new DatabaseSync(owner.databasePath, {readOnly:true});
      this.db.exec('PRAGMA query_only=ON; PRAGMA cache_size=-8192; PRAGMA busy_timeout=5000; BEGIN');
      this.db.function('search_features', {deterministic:true}, (text,scope)=>JSON.stringify(documentRank({normalized_text:text,scope},request.query,this.terms)));
      const rows = this.db.prepare(`SELECT s.*, (SELECT MAX(timestamp) FROM docs d WHERE d.session_key=s.key AND d.scope IN ('user','assistant') AND d.event_id<>'last-output-preview') AS last_conversation_at FROM sessions s`).all();
      this.sessions = new Map(rows.map(row=>[row.key,sessionFrom(row)]));
      this.unknownTimeSources = rows.filter(row=>!row.last_conversation_at).length;
      const {from,to,field} = request.time;
      this.timed = from != null || to != null;
      this.rangeSessions = this.timed ? new Set(this.db.prepare(`SELECT DISTINCT session_key FROM docs WHERE scope IN ('user','assistant') AND event_id<>'last-output-preview' AND timestamp>0 AND timestamp>=? AND timestamp<=?`).all(from ?? 0,to ?? Number.MAX_SAFE_INTEGER).map(r=>r.session_key)) : null;
      this.allowed = new Set([...this.sessions.values()].filter(s=>
        matchesSearchProvider(s.provider, request.providers)
        && (!request.project || normalize(`${s.projectLabel||''} ${s.cwd||''}`).includes(request.project))
        && matchesProjectFilter(s.cwd, request.projectFilter)
        && (!request.sessionFilter || request.sessionFilter.hubSessionIds.includes(s.hubSessionId) || request.sessionFilter.meetingIds.includes(s.meetingId))
        && (!this.timed || field!=='conversationTime' || (s.lastConversationAt && s.lastConversationAt >= (from??0) && s.lastConversationAt <= (to??Number.MAX_SAFE_INTEGER)))
      ).map(s=>s.key));
      this.allAllowed = this.allowed.size === this.sessions.size;
      this.auxReady = JSON.parse(this.db.prepare("SELECT value FROM meta WHERE key='cjkAuxReady'").get()?.value || 'null') === '1';
      this.userStatement = this.db.prepare("SELECT ordinal, event_id FROM docs WHERE session_key=? AND scope='user' ORDER BY ordinal,id");
      this.questionStatement = this.db.prepare("SELECT substr(text,1,600) AS text FROM docs WHERE session_key=? AND scope='user' AND ordinal=? LIMIT 1");
      this.answerStatement = this.db.prepare("SELECT substr(text,1,600) AS text FROM docs WHERE session_key=? AND scope='assistant' AND ordinal>=? AND ordinal<? ORDER BY ordinal DESC LIMIT 1");
      if (request.query && request.scopes.includes('title')) {
        for (const key of this.allowed) {
          const session = this.sessions.get(key);
          if (![key, session.hubSessionId, session.nativeSessionId, session.meetingId].some(id => id && normalize(id) === request.query)) continue;
          if (this.timed && !this.rangeSessions.has(key)) continue;
          const rank = { tier:0, distance:0, field:0, covered:this.terms.map((_,i)=>i) };
          this.groups.set(key, {session, exactId:true, covered:new Set(rank.covered), episodes:new Map(),
            best:{rank,docId:`id:${key}`,eventId:'title',scope:'title',role:'title',timestamp:null,ordinal:-1,text:session.title},
            count:1,newest:null,scopes:new Set(['title']),matchedEventIds:[]});
        }
      }
      if (!this.terms.length) {
        const eventPredicate=this.timed && field==='eventTime'
          ? ` AND ((scope<>'title' AND event_id<>'last-output-preview' AND timestamp>0 AND timestamp>=? AND timestamp<=?) OR (scope='title' AND session_key IN (SELECT value FROM json_each(?))))` : '';
        const eventArgs=eventPredicate?[from??0,to??Number.MAX_SAFE_INTEGER,JSON.stringify([...this.rangeSessions])]:[];
        const scoped=new Set(this.db.prepare(`SELECT DISTINCT session_key FROM docs WHERE scope IN (${request.scopes.map(()=>'?')})${eventPredicate}`).all(...request.scopes,...eventArgs).map(r=>r.session_key));
        this.finalResults = [...this.allowed].filter(key=>scoped.has(key)).map(key=>({
          ...this.sessions.get(key), matchCount:0, titleOnly:true, indexed:true, newestMatchedEventAt:null,
          rank:{tier:4,distance:0,field:0}, matchReasons:['最近对话'],
          bestMatch:{scope:'title',role:'title',eventId:'title',timestamp:null,text:this.sessions.get(key).title},
          ...this.excerpts(key,Number.MAX_SAFE_INTEGER),
        })).sort((a,b)=>compareResults(a,b,request.sort,request.direction));
        this.done=true; this.close();
      }
    } catch(error) { this.close(); throw error; }
  }
  close() { if(this.db) { try { this.db.close(); } finally { this.db=null; } } }
  userBounds(key, ordinal) {
    let users=this.users.get(key);
    if(!users) { users=this.userStatement.all(key); this.users.set(key,users); }
    let lo=0,hi=users.length;
    while(lo<hi) { const mid=(lo+hi)>>1; if(users[mid].ordinal<=ordinal) lo=mid+1; else hi=mid; }
    return {start:lo?users[lo-1].ordinal:null,end:lo<users.length?users[lo].ordinal:Number.MAX_SAFE_INTEGER};
  }
  excerpts(key,ordinal) {
    const bounds=this.userBounds(key,ordinal);
    return { questionExcerpt:bounds.start==null?'':this.questionStatement.get(key,bounds.start)?.text||'',
      answerExcerpt:this.answerStatement.get(key,bounds.start??-1,bounds.end)?.text||'' };
  }
  makeStatement() {
    const term=this.terms[this.termIndex], r=this.request;
    const useCjk=isCjkAuxTerm(term) && this.auxReady && r.scopes.every(s=>DIALOGUE.includes(s));
    const table=useCjk?'docs_cjk':Array.from(term).length>=3?'docs_fts':null;
    // Short non-indexable terms scan bounded metadata pages. A WHERE instr +
    // LIMIT would scan the entire text corpus on a zero-hit query before yielding.
    const where=[...(table?[`${table} MATCH ?`]:[]), `${table?table+'.rowid':'d.id'}>?`, `d.scope IN (${r.scopes.map(()=>'?')})`];
    const args=[...(table?[quote(term)]:[]), this.afterId, ...r.scopes];
    const allowed=this.termIndex ? [...this.groups.keys()] : this.allAllowed?null:[...this.allowed];
    if(allowed) { where.push('d.session_key IN (SELECT value FROM json_each(?))'); args.push(JSON.stringify(allowed)); }
    if(this.timed && r.time.field==='eventTime') {
      where.push(`((d.scope<>'title' AND d.event_id<>'last-output-preview' AND d.timestamp>0 AND d.timestamp>=? AND d.timestamp<=?) OR (d.scope='title' AND d.session_key IN (SELECT value FROM json_each(?))))`);
      args.push(r.time.from??0,r.time.to??Number.MAX_SAFE_INTEGER,JSON.stringify([...this.rangeSessions]));
    }
    // CROSS JOIN pins the FTS iterator as the driver. A normal JOIN lets SQLite
    // pick scope_time first, turning a selective term into thousands of FTS probes.
    const from=table?`FROM ${table} CROSS JOIN docs d ON d.id=${table}.rowid`:'FROM docs d NOT INDEXED';
    const sql=`SELECT d.id,d.session_key,d.scope,d.role,d.speaker,d.ordinal,d.timestamp,d.event_id,
      search_features(d.normalized_text,d.scope) AS features,
      substr(d.text,MAX(1,instr(d.normalized_text,?)-100),500) AS snippet
      ${from} WHERE ${where.join(' AND ')} ORDER BY ${table?`${table}.rowid`:'d.id'} LIMIT ?`;
    return {statement:this.db.prepare(sql),args:[term,...args],scanAll:!table};
  }
  consume(row) {
    if(this.seen.has(row.id)) return;
    this.seen.add(row.id);
    const feature=JSON.parse(row.features);
    if(!feature.covered.length) return;
    let group=this.groups.get(row.session_key);
    if(!group) {
      group={session:this.sessions.get(row.session_key),covered:new Set(),episodes:new Map(),best:null,count:0,newest:null,scopes:new Set(),matchedEventIds:[]};
      this.groups.set(row.session_key,group);
    }
    feature.covered.forEach(i=>group.covered.add(i));
    group.count++; group.scopes.add(row.scope);
    if(row.scope!=='title' && row.event_id!=='last-output-preview') group.newest=Math.max(group.newest||0,Number(row.timestamp)||0)||null;
    if(group.matchedEventIds.length<30) group.matchedEventIds.push(row.event_id);
    if(row.scope!=='title') {
      const bounds=this.userBounds(row.session_key,row.ordinal);
      const key=bounds.start==null?`event:${row.event_id}`:`user:${bounds.start}`;
      let episode=group.episodes.get(key);
      if(!episode) { episode={covered:new Set(),best:null}; group.episodes.set(key,episode); }
      feature.covered.forEach(i=>episode.covered.add(i));
      if(!episode.best || compareRank(feature,episode.best.rank)<0) episode.best={rank:feature,...row};
    }
    if(!group.best || compareRank(feature,group.best.rank)<0 || (compareRank(feature,group.best.rank)===0 && row.timestamp>group.best.timestamp)) {
      group.best={rank:feature,docId:row.id,eventId:row.event_id,scope:row.scope,role:row.role,speaker:row.speaker,
        timestamp:row.scope==='title'?null:Number(row.timestamp)||null,ordinal:row.ordinal,text:row.snippet};
    }
  }
  step(maxDocs) {
    if(this.done) return;
    const started=Date.now(); let processed=0, chars=0;
    while(this.termIndex<this.terms.length && processed<maxDocs && chars<8*1024*1024 && Date.now()-started<160) {
      if(!this.allowed.size || (this.termIndex && !this.groups.size)) { this.termIndex=this.terms.length; break; }
      const {statement,args,scanAll}=this.makeStatement();
      // Many overlapping query terms can make one document expensive. Yield
      // between those documents instead of running 32 UDF calls atomically.
      const batchSize=Math.min(this.terms.length>8?1:32,maxDocs-processed);
      const rows=statement.all(...args,batchSize);
      for(const row of rows) { this.consume(row); this.afterId=row.id; chars+=row.snippet.length; }
      processed+=rows.length; this.scanned+=rows.length;
      if(rows.length<batchSize) { this.termIndex=scanAll?this.terms.length:this.termIndex+1; this.afterId=0; }
    }
    if(this.termIndex>=this.terms.length) {
      this.done=true;
      this.finalResults=this.resultRows();
      this.close(); this.seen.clear(); this.groups.clear(); this.users.clear();
    }
  }
  resultRows() {
    if(this.finalResults) return this.finalResults;
    const groups=[...this.groups.values()].filter(g=>g.covered.size===this.terms.length);
    const results=groups.map(g=>{
      let best=g.best;
      let rank={...best.rank}; delete rank.covered;
      if(rank.tier>=4) {
        const episodes=[...g.episodes.values()].filter(e=>e.covered.size===this.terms.length).sort((a,b)=>compareRank(a.best.rank,b.best.rank)||b.best.timestamp-a.best.timestamp);
        if(episodes.length) {
          const row=episodes[0].best;
          best={rank:row.rank,docId:row.id,eventId:row.event_id,scope:row.scope,role:row.role,speaker:row.speaker,timestamp:row.timestamp,ordinal:row.ordinal,text:row.snippet};
          rank={tier:3,distance:0,field:row.rank.field};
        }
      }
      const titleOnly=g.scopes.size===1 && g.scopes.has('title');
      const {rank:_rank,docId,...bestMatch}=best;
      if(g.excerptId!==docId) {g.excerptId=docId;g.excerpts=this.excerpts(g.session.key,best.scope==='title'?Number.MAX_SAFE_INTEGER:best.ordinal);}
      return {...g.session,indexed:true,matchCount:g.count,newestMatchedEventAt:g.newest,
        titleOnly,rank,matchReasons:g.exactId?['会话 ID 精确匹配',...(this.timed?['范围内有对话']:[])]:rankReason(rank,titleOnly,this.timed),matchedEventIds:g.matchedEventIds,
        bestMatch, ...g.excerpts};
    });
    return results.sort((a,b)=>compareResults(a,b,this.request.sort,this.request.direction));
  }
  response(offset=0) {
    const results=this.resultRows(), r=this.request, shown=results.slice(offset,offset+r.limit);
    const providers={},scopes={},projects=new Map();
    for(const result of results) {
      providers[result.provider]=(providers[result.provider]||0)+1;
      const scope=result.bestMatch.scope; scopes[scope]=(scopes[scope]||0)+1;
      const label=result.projectLabel||result.cwd; if(label) projects.set(label,(projects.get(label)||0)+1);
    }
    const cursor=(kind,start)=>Buffer.from(JSON.stringify({id:this.id,kind,offset:start})).toString('base64url');
    return {queryId:this.id,snapshotId:this.id,rankVersion:RANK_VERSION,appliedFilters:r,
      state:this.done?'complete':'partial',total:{value:results.length,relation:this.done?'exact':'lowerBound'},
      totalSessions:results.length,totalMatches:results.reduce((sum,r)=>sum+r.matchCount,0),results:shown,
      truncated:!this.done || results.length>offset+r.limit,truncatedReason:!this.done?'query_guard':results.length>offset+r.limit?'result_limit':null,
      partialReason:this.done?null:'仍在检索同一快照中的其余记录',scannedDocuments:this.scanned,
      continuationCursor:this.done?null:cursor('scan',0),
      nextPageCursor:this.done && offset+r.limit<results.length?cursor('page',offset+r.limit):null,
      coverage:{unknownTimeSources:this.unknownTimeSources},
      facets:{providers,scopes,projects:[...projects].map(([label,count])=>({label,count})).sort((a,b)=>b.count-a.count)},
    };
  }
}

class SearchCursorStore {
  constructor(owner) { this.owner=owner; this.snapshots=new Map(); this.timer=setInterval(()=>this.expire(),30000); this.timer.unref?.(); }
  expire() { for(const [id,s] of this.snapshots) if(Date.now()-s.lastUsed>120000) { s.close(); this.snapshots.delete(id); } }
  search(request) {
    const started=Date.now(); this.expire(); let snapshot;
    try {
      let cursor=null;
      if(request.cursor) {
        try { cursor=JSON.parse(Buffer.from(String(request.cursor),'base64url').toString()); } catch { throw new Error('搜索游标无效，请重新搜索'); }
        snapshot=this.snapshots.get(cursor.id);
        if(!snapshot) throw new Error('搜索快照已过期，请重新搜索');
        if(JSON.stringify(normalizeRequest(request,snapshot.request.now))!==JSON.stringify(snapshot.request)) throw new Error('搜索条件已改变，请重新搜索');
        if(!['scan','page'].includes(cursor.kind) || !Number.isInteger(cursor.offset) || cursor.offset<0 || (cursor.kind==='page' && !snapshot.done)) throw new Error('搜索游标无效');
      } else {
        if(this.snapshots.size>=4) { const [id,old]=this.snapshots.entries().next().value; old.close(); this.snapshots.delete(id); }
        snapshot=new QuerySnapshot(this.owner,normalizeRequest(request)); this.snapshots.set(snapshot.id,snapshot);
      }
      snapshot.lastUsed=Date.now(); snapshot.step(this.owner.maxQueryDocs);
      return {...snapshot.response(cursor?.kind==='page'?cursor.offset:0),requestId:request.requestId,queryMs:Date.now()-started,index:this.owner.getStats()};
    } catch(error) {
      if(snapshot && !snapshot.done) { snapshot.close(); this.snapshots.delete(snapshot.id); }
      return {state:'error',error:error.message,requestId:request.requestId,results:[],totalSessions:0,totalMatches:0,total:{value:0,relation:'lowerBound'},truncated:false,facets:{providers:{},scopes:{},projects:[]},queryMs:Date.now()-started,index:this.owner.getStats()};
    }
  }
  close() { clearInterval(this.timer); for(const snapshot of this.snapshots.values()) snapshot.close(); this.snapshots.clear(); }
}
module.exports={SearchCursorStore,normalizeRequest,QuerySnapshot};
