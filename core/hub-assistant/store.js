'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { createHash } = require('node:crypto');
class AssistantStore {
  constructor(dir) {
    fs.mkdirSync(dir, { recursive:true });
    this.db = new DatabaseSync(path.join(dir,'assistant.sqlite'));
    this.db.exec(`PRAGMA busy_timeout=3000; CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS actions(id TEXT PRIMARY KEY,fingerprint TEXT NOT NULL,payload TEXT NOT NULL,state TEXT NOT NULL,result TEXT,updated INTEGER NOT NULL);`);
  }
  get(key) { const row=this.db.prepare('SELECT value FROM meta WHERE key=?').get(key); return row ? JSON.parse(row.value) : null; }
  set(key,value) { this.db.prepare('INSERT INTO meta VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key,JSON.stringify(value)); }
  has(id) {return !!this.db.prepare('SELECT 1 FROM actions WHERE id=?').get(id);}
  reserveAssistant(id) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const existing=this.get('sessionId');
      if(existing&&existing!==id)throw new Error('助理创建已由另一请求预留，请重新读取助理状态');
      this.set('sessionId',id);
      this.set('assistantCreation',{id,state:'reserved',createdAt:Date.now()});
      this.db.exec('COMMIT');
    } catch(error) {this.db.exec('ROLLBACK');throw error;}
  }
  confirmAssistant(id) {this.set('assistantCreation',{id,state:'confirmed',confirmedAt:Date.now()});}
  begin(id,payload) {
    if (typeof id!=='string'||id.length<8||id.length>160) throw new Error('请求编号无效');
    const encoded=JSON.stringify(payload), fingerprint=createHash('sha256').update(encoded).digest('hex');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const old=this.db.prepare('SELECT * FROM actions WHERE id=?').get(id);
      if(old) { if(old.fingerprint!==fingerprint) throw new Error('同一请求编号不能用于不同任务'); this.db.exec('COMMIT'); return {...old,duplicate:true,result:old.result?JSON.parse(old.result):null}; }
      this.db.prepare('INSERT INTO actions VALUES(?,?,?,?,?,?)').run(id,fingerprint,encoded,'dispatching',null,Date.now());
      this.db.exec('COMMIT'); return {id,state:'dispatching',duplicate:false};
    } catch(error) { this.db.exec('ROLLBACK'); throw error; }
  }
  finish(id,state,result) { this.db.prepare('UPDATE actions SET state=?,result=?,updated=? WHERE id=?').run(state,JSON.stringify(result),Date.now(),id); }
  list() { return this.db.prepare('SELECT id,state,result,updated FROM actions ORDER BY updated DESC LIMIT 30').all().map(r=>({...r,result:r.result?JSON.parse(r.result):null})); }
  close() { this.db.close(); }
}
module.exports={AssistantStore};
