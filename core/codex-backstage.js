'use strict';
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { CodexBackstageStore, decodeChunk } = require('./codex-backstage-store');

const stringify = value => typeof value === 'string' ? value : JSON.stringify(value, null, 2);
const TITLES = { userMessage:'你', agentMessage:'Codex', commandExecution:'执行命令', fileChange:'文件变更',
  mcpToolCall:'调用工具', webSearch:'搜索', reasoning:'思考摘要', imageView:'查看图片', imageGeneration:'生成图片',
  collabAgentToolCall:'协作任务', contextCompaction:'整理上下文' };

class CodexBackstage {
  constructor(session) {
    this.session = session; this.store = null; this.failure = null; this.noteId = 0;
    this.historyCursor = null; this.historyOrdinal = -1; this.closed = false;
  }
  ensure() {
    if (this.failure) throw this.failure;
    if (this.closed) throw new Error('后台记录已关闭');
    if (!this.store) {
      const o = this.session.options;
      const root = o.hubDataDir || o.env?.CLAUDE_HUB_DATA_DIR;
      // An unsuccessful resume does not own the target thread. Its diagnostics
      // must never open the live owner's journal as a second writer.
      const identity = [o.env?.CODEX_HOME || '', this.session.threadId || o.id];
      const name = createHash('sha256').update(JSON.stringify(identity)).digest('hex');
      this.store = new CodexBackstageStore(root ? path.join(root, 'codex-backstage', name + '.sqlite') : ':memory:',
        revision => this.session.emit('backstage-updated', { revision }), error => this.failed(error));
      this.historyOrdinal = Math.min(-1, this.store.db.prepare('SELECT COALESCE(MIN(ordinal),0)-1 AS n FROM entries').get().n);
    }
    return this.store;
  }
  bind() {
    this.historyCursor = null;
    if (!this.store || !this.session.threadId || this.store.file === ':memory:') return;
    const previous = this.store;
    const o = this.session.options;
    const name = createHash('sha256').update(JSON.stringify([o.env?.CODEX_HOME || '',this.session.threadId])).digest('hex');
    const target = path.join(o.hubDataDir || o.env.CLAUDE_HUB_DATA_DIR,'codex-backstage',name+'.sqlite');
    if (previous.file === target) return;
    this.capture(() => {
      previous.flush(); this.store = null;
      const next = this.ensure();
      // Early startup messages belong to the now-confirmed native identity.
      // The thread owner is already claimed before this journal is opened.
      for (const row of previous.db.prepare('SELECT value FROM entries ORDER BY ordinal').iterate()) {
        const old = JSON.parse(row.value), {ordinal,revision,...fields} = old;
        const entry = next.update(old.id, fields);
        entry.fields = old.fields; next.dirty(entry);
      }
      for (const encoded of previous.db.prepare('SELECT * FROM chunks ORDER BY seq').iterate()) {
        const chunk=decodeChunk(encoded);
        next.chunks.push({...chunk,seq:++next.seq});next.pendingBytes+=chunk.text.length*2;
        if(next.pendingBytes>=256*1024)next.flush();
      }
      next.flush();previous.close();
    });
  }
  failed(error) {
    if (this.failure) return;
    this.failure = error;
    console.error('[codex-backstage] capture failed:', error.message);
    this.session.emit('backstage-updated', { error:'后台原始记录保存失败：' + error.message });
  }
  capture(fn) { if (this.closed || this.failure) return; try { fn(this.ensure()); } catch (error) { this.failed(error); } }
  key(turnId, itemId) { return `${turnId || 'session'}/${itemId}`; }
  item(turnId, item, completed, historical = false) {
    if (!item?.id) return;
    this.capture(store => {
      const id = this.key(turnId, item.id);
      if (historical && (store.cache.has(id) || store.db.prepare('SELECT 1 FROM entries WHERE id=?').get(id))) return;
      const title = TITLES[item.type] || item.type || '工具';
      const entry = store.update(id, { type:item.type || 'tool', title, turnId, itemId:item.id,
        ...(historical ? { ordinal:this.historyOrdinal--, historical:true } : {}),
        phase:item.phase, status:completed ? item.status || 'completed' : 'running',
        exitCode:item.exitCode, durationMs:item.durationMs,
        completedAt:completed ? item.hubCompletedAt || (historical ? null : Date.now()) : undefined });
      if (item.type === 'userMessage') {
        const text = (item.content || []).map(part => part.text ?? (part.path || part.url ? `[${part.type}] ${part.path || part.url}` : stringify(part))).join('\n');
        store.set(id, 'text', text);
      }
      if (typeof item.text === 'string') store.set(id, 'text', item.text);
      if (item.type === 'reasoning' && Array.isArray(item.summary)) {
        const text=item.summary.map(part=>typeof part==='string'?part:part.text||'').filter(Boolean).join('\n');
        if(text)store.set(id,'summary',text);
      }
      if (item.command) store.set(id, 'command', item.command);
      if (item.cwd) store.set(id, 'cwd', item.cwd);
      if (typeof item.aggregatedOutput === 'string') {
        const old = entry.fields.output;
        const value = item.aggregatedOutput;
        // Provider completion snapshots can be truncated or revised. Preserve
        // the first-hand stream and expose the reported snapshot separately.
        const samePrefix = old && value.length >= old.length
          && createHash('sha256').update(value.slice(0, old.length), 'utf16le').digest('hex') === old.digest;
        store.set(id, old && !samePrefix ? 'reported-output' : 'output', value);
      }
      if (item.error != null) store.set(id, 'error', stringify(item.error));
      const excluded = new Set(['id','type','text','content','command','cwd','aggregatedOutput','error','status','exitCode','durationMs','hubStartedAt','hubCompletedAt','phase','itemOrder']);
      const detail = Object.fromEntries(Object.entries(item).filter(([key,value]) => !excluded.has(key) && value != null));
      if (Object.keys(detail).length) store.set(id, 'details', stringify(detail));
      if (completed && !['agentMessage','userMessage','reasoning'].includes(item.type)) {
        store.set(id, 'result', stringify({status:item.status || 'completed',exitCode:item.exitCode,durationMs:item.durationMs}));
      }
      if (completed) store.releaseHashes(id);
    });
  }
  delta(turnId, itemId, field, text, type = 'commandExecution') {
    this.capture(store => {
      const id = this.key(turnId, itemId);
      const entry = store.get(id, { type, title:TITLES[type] || type, turnId, itemId, status:'running' });
      store.append(id, field, text);
      // Keep the native source type set by item/started if it arrived first.
      if (!entry.revision) store.dirty(entry);
    });
  }
  note(source, message, level = 'info', extra) {
    if (!message) return;
    this.capture(store => {
      const stderr=source==='App Server stderr（共享进程）';
      const id=stderr?this.key(this.session.runtime.turnId,`stderr-${this.session.pid || 'starting'}`):`diagnostic/${randomUUID()}`;
      if(stderr&&this.stderrEntry&&this.stderrEntry!==id)store.releaseHashes(this.stderrEntry);
      if(stderr)this.stderrEntry=id;
      store.update(id, { type:'diagnostic', title:source, level, status:level === 'error' ? 'failed' : 'completed', turnId:this.session.runtime.turnId });
      store.append(id, 'message', String(message));
      if (extra != null) store.set(id, 'details', stringify(extra));
      if(!stderr)store.releaseHashes(id);
    });
  }
  requestError(method, error) {
    this.recordedErrors ||= new WeakSet();
    if (this.recordedErrors.has(error)) return;
    this.recordedErrors.add(error);
    this.note('Codex 请求失败 · '+method, error.message, 'error',
      { method, message:error.message, code:error.code, data:error.data, stack:error.stack });
  }
  turn(turn, historical=false) {
    this.capture(store => {
      const id=this.key(turn.id,'$turn');
      if(historical&&(store.cache.has(id)||store.db.prepare('SELECT 1 FROM entries WHERE id=?').get(id)))return;
      store.update(id,{type:'turn',title:'本轮',turnId:turn.id,status:turn.status,
        ...(historical?{ordinal:this.historyOrdinal--,historical:true}:{})});
      store.set(id,'result',stringify({status:turn.status,error:turn.error}));
      if(turn.error)store.set(id,'error',stringify(turn.error));
      store.releaseHashes(id);
    });
  }
  notification(msg) {
    const p = msg.params || {}, type = msg.method, turnId = p.turnId || p.turn?.id || this.session.runtime.turnId;
    if (type === 'item/started' || type === 'item/completed') this.item(turnId, p.item, type === 'item/completed');
    else if (type === 'item/agentMessage/delta') this.delta(turnId, p.itemId, 'text', p.delta, 'agentMessage');
    else if (type === 'item/commandExecution/outputDelta' || type === 'item/fileChange/outputDelta') this.delta(turnId, p.itemId, 'output', p.delta);
    else if (/^item\/reasoning\/.+Delta$/.test(type)) this.delta(turnId, p.itemId, 'summary', p.delta, 'reasoning');
    else if (type === 'turn/completed' || type === 'turn/started') {
      for (const item of p.turn?.items || []) this.item(turnId, item, type === 'turn/completed');
      if (type === 'turn/completed') {
        this.turn(p.turn);
      }
    } else if (type === 'error') this.note(p.willRetry?'Codex 连接提示':'Codex 原生错误', p.error?.message || stringify(p), p.willRetry?'warning':'error', p);
    else if (!['thread/status/changed','thread/tokenUsage/updated','serverRequest/resolved'].includes(type)) {
      this.note(type, p.message || (typeof p.delta === 'string' ? p.delta : stringify(p)), 'info', p.message || p.delta ? p : undefined);
    }
  }
  seedHistory(count = 40) {
    if (!this.historyCursor) this.historyCursor = { turns:[...this.session.history.values()], turn:this.session.history.size - 1, item:null };
    const cursor = this.historyCursor;
    let loaded = 0;
    while (cursor.turn >= 0 && loaded < count) {
      const turn = cursor.turns[cursor.turn];
      if (cursor.item == null) {
        cursor.item = (turn.items || []).length - 1;
        if(turn.error||['failed','interrupted'].includes(turn.status)){
          this.turn(turn,true);loaded++;if(loaded>=count)break;
        }
      }
      if (cursor.item < 0) { cursor.turn--; cursor.item = null; continue; }
      this.item(turn.id, turn.items[cursor.item--], turn.status !== 'inProgress', true); loaded++;
    }
    return cursor.turn >= 0;
  }
  read(options = {}) {
    if (this.failure) throw new Error('后台原始记录保存失败：' + this.failure.message);
    const store = this.ensure();
    if (!this.historyCursor || options.history) this.seedHistory();
    const result = store.read(options);
    return { ...result, historyMore:!!this.historyCursor && this.historyCursor.turn >= 0,
      capture:'原始记录保留本功能启用后的输出；较早内容按需读取 Codex 提供的历史。stderr 属于共享 App Server，未绑定到具体会话的行会标注来源。',
      runtime:this.session.runtime, threadId:this.session.threadId };
  }
  close() { if (this.closed) return; this.closed = true; if (this.store) try { this.store.close(); } catch (error) { this.failed(error); } }
}

module.exports = { CodexBackstage, TITLES };
