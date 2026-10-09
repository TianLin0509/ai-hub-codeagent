'use strict';
const {readFinals,nativeId}=require('./live-history');
class AssistantWatches{
  constructor(store,{getSession,getOpenSession=getSession,onNotification=()=>{},readFinal=readFinals}){this.store=store;this.getSession=getSession;this.getOpenSession=getOpenSession;this.onNotification=onNotification;this.readFinal=readFinal;
    store.db.exec('CREATE TABLE IF NOT EXISTS assistant_watches(session_id TEXT PRIMARY KEY,value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS assistant_notifications(id TEXT PRIMARY KEY,session_id TEXT NOT NULL,value TEXT NOT NULL,created_at INTEGER NOT NULL,read_at INTEGER);');
  }
  list(){return this.store.db.prepare('SELECT value FROM assistant_watches').all().map(r=>JSON.parse(r.value));}
  save(watch){this.store.db.prepare('INSERT INTO assistant_watches VALUES(?,?) ON CONFLICT(session_id) DO UPDATE SET value=excluded.value').run(watch.sessionId,JSON.stringify(watch));}
  saveChanged(previous,next){
    const {updatedAt:_old,...before}=previous,{updatedAt:_next,...after}=next;
    if(JSON.stringify(before)===JSON.stringify(after))return false;
    this.save({...next,updatedAt:Date.now()});return true;
  }
  follow(sessionId){
    const old=this.list().find(w=>w.sessionId===sessionId);if(old)return old;
    const meta=this.getSession(sessionId);if(!meta)throw new Error('找不到这个原会话');
    const now=Date.now(),result=this.readFinal(meta);
    const watch={id:sessionId,sessionId,title:meta.title||meta.name||'未命名会话',createdAt:now,updatedAt:now,nativeSessionId:nativeId(meta),cursor:result.cursor,seen:result.records.map(r=>r.notificationKey||r.id),state:!this.getOpenSession(sessionId)?'paused-closed':result.available?'watching':'waiting-binding',lastError:result.available?null:result.issue};
    this.save(watch);return watch;
  }
  unfollow(sessionId){this.store.db.prepare('DELETE FROM assistant_watches WHERE session_id=?').run(sessionId);return{ok:true};}
  notifications({unreadOnly=false,limit=50}={}){
    const rows=this.store.db.prepare(`SELECT value,read_at FROM assistant_notifications ${unreadOnly?'WHERE read_at IS NULL':''} ORDER BY created_at DESC LIMIT ?`).all(Math.max(1,Math.min(200,Number(limit)||50)));
    return{ok:true,notifications:rows.map(r=>({...JSON.parse(r.value),readAt:r.read_at})),unreadCount:this.store.db.prepare('SELECT count(*) n FROM assistant_notifications WHERE read_at IS NULL').get().n};
  }
  // Hub 自己发出的提醒（例如「我记下了：……」），和关注回复走同一条提醒通道（助理页 + 手机）。
  addNotice({id,title,text,kind='assistant-notice',label='助理提醒'}){
    const notice={id,sessionId:'assistant',title,text,createdAt:Date.now(),readAt:null,kind,label};
    const changed=this.store.db.prepare('INSERT OR IGNORE INTO assistant_notifications VALUES(?,?,?,?,NULL)').run(id,'assistant',JSON.stringify(notice),notice.createdAt).changes;
    if(changed){try{this.onNotification(notice);}catch{}}
    return changed?notice:null;
  }
  markRead(id){this.store.db.prepare('UPDATE assistant_notifications SET read_at=COALESCE(read_at,?) WHERE id=?').run(Date.now(),id);return{ok:true};}
  poll(){
    for(const watch of this.list()){
      try{
        const meta=this.getOpenSession(watch.sessionId);
        if(!meta){if(watch.state!=='paused-closed')this.save({...watch,state:'paused-closed',lastError:null,updatedAt:Date.now()});continue;}
        if(watch.nativeSessionId&&nativeId(meta)!==watch.nativeSessionId)throw new Error('原生会话身份发生变化，已暂停关注');
        const result=this.readFinal(meta,{cursor:watch.cursor});if(!result.available)throw new Error(result.issue);
        const seen=new Set(watch.seen),newRecords=result.records.filter(r=>!seen.has(r.notificationKey||r.id)&&(!watch.cursor?!!r.timestamp&&r.timestamp>=watch.createdAt:true));
        for(const record of result.records)seen.add(record.notificationKey||record.id);
        const next={...watch,nativeSessionId:result.identity,cursor:result.cursor,seen:[...seen].slice(-500),state:'watching',lastError:null};
        // Keep reading at the existing cadence. Only disk writes are skipped;
        // cursor advances without a final reply must still be persisted.
        if(!newRecords.length){this.saveChanged(watch,next);continue;}
        const notices=[];this.store.db.exec('BEGIN IMMEDIATE');
        try{
          for(const source of newRecords){
            const id=watch.sessionId+':'+(source.notificationKey||source.id);
            const notice={id,sessionId:watch.sessionId,title:meta.title||watch.title,text:source.text,createdAt:Date.now(),readAt:null,source:{...source,text:undefined},kind:'target-final-reply',label:'目标会话的新回复（原文）'};
            const changed=this.store.db.prepare('INSERT OR IGNORE INTO assistant_notifications VALUES(?,?,?,?,NULL)').run(id,watch.sessionId,JSON.stringify(notice),notice.createdAt).changes;
            if(changed)notices.push(notice);
          }
          this.saveChanged(watch,next);
          this.store.db.exec('COMMIT');
        }catch(error){this.store.db.exec('ROLLBACK');throw error;}
        for(const notice of notices){try{this.onNotification(notice);}catch{}}
      }catch(error){this.saveChanged(watch,{...watch,state:'error',lastError:error.message});}
    }
    return this.notifications();
  }
}
function reminderIntent(text){return !/(不要|不必|无需|别|不用).{0,12}(提醒|通知|反馈|关注)/.test(text)&&(/(回复|答复|回答|结果|进展).{0,25}(提醒|通知|反馈)|(提醒|通知).{0,25}(回复|答复|回答|结果)|第一时间.{0,8}(反馈|告诉我|提醒|通知)/.test(text)||/^(?:请|帮我)?关注\s*\S.{1,100}$/.test(String(text).trim()));}
module.exports={AssistantWatches,reminderIntent};
