'use strict';
const path = require('node:path');
const { createHash } = require('node:crypto');
const { CodexBackstage } = require('./codex-backstage');
const { CodexBackstageStore } = require('./codex-backstage-store');
const json = value => typeof value === 'string' ? value : JSON.stringify(value, null, 2);

// Reuse the bounded record store and reader used by Codex. The adapter owns
// Claude message/block identities; it does not invent App Server turn events.
class ClaudeBackstage extends CodexBackstage {
  constructor(session) {
    super(session);
    this.streams = new Map();
    this.messageOffsets = new Map();
    this.history = null;
  }
  ensure() {
    if (this.failure) throw this.failure;
    if (this.closed) throw new Error('后台记录已关闭');
    if (!this.store) {
      const o = this.session.options;
      const root = o.hubDataDir || o.env?.CLAUDE_HUB_DATA_DIR;
      const name = createHash('sha256').update(JSON.stringify([o.env?.CLAUDE_CONFIG_DIR || '', o.id, this.session.sessionId])).digest('hex');
      this.store = new CodexBackstageStore(root ? path.join(root, 'claude-backstage', name + '.sqlite') : ':memory:',
        revision => this.session.emit('backstage-updated', { revision }), error => this.failed(error));
      this.historyOrdinal = Math.min(-1, this.store.db.prepare('SELECT COALESCE(MIN(ordinal),0)-1 AS n FROM entries').get().n);
    }
    return this.store;
  }
  entry(turnId, id, fields, values, historical = false) {
    this.capture(store => {
      const key = this.key(turnId, id);
      const existing = store.cache.get(key) || (historical && store.db.prepare('SELECT value FROM entries WHERE id=?').get(key));
      if (historical && existing) {
        const old = existing.value ? JSON.parse(existing.value) : existing;
        if (!old.historical) return;
        if (!old.title && fields.title) store.update(key, {title:fields.title});
        for (const [field, value] of Object.entries(values)) if (value != null && !old.fields[field]) store.set(key, field, json(value));
        store.releaseHashes(key);
        return;
      }
      store.update(key, { turnId, itemId:id, ...fields,
        ...(historical ? { ordinal:this.historyOrdinal--, historical:true } : {}) });
      for (const [field, value] of Object.entries(values)) if (value != null) store.set(key, field, json(value));
      if (fields.status !== 'running') store.releaseHashes(key);
    });
  }
  frame(frame, turnId, historical = false) {
    if (!frame) return;
    const message = frame.message || {};
    if (frame.type === 'stream_event' && !historical) {
      const event = frame.event || {}, streamKey = frame.parent_tool_use_id || 'root';
      if (event.type === 'message_start') this.streams.set(streamKey, { id:event.message.id, turnId, blocks:new Map() });
      if (event.type === 'message_stop') {this.streams.delete(streamKey);return;}
      const stream = this.streams.get(streamKey);
      if (!stream) return;
      if (event.type === 'content_block_start') stream.blocks.set(event.index, event.content_block);
      const block = stream.blocks.get(event.index);
      if (!block) return;
      const id = block.id || `${stream.id}:${event.index}`;
      const type = block.type === 'text' ? 'agentMessage' : block.type === 'thinking' ? 'reasoning' : 'mcpToolCall';
      if (event.type === 'content_block_start') this.entry(turnId, id,
        { type, title:block.name || (type === 'agentMessage' ? 'Claude' : '思考'), status:'running' },
        { text:block.text, summary:block.thinking, details:block.input });
      if (event.type === 'content_block_delta') {
        const delta = event.delta || {};
        const field = delta.type === 'text_delta' ? 'text' : delta.type === 'thinking_delta' ? 'summary' : 'details';
        this.delta(turnId, id, field, delta.text ?? delta.thinking ?? delta.partial_json ?? '', type);
      }
      return;
    }
    if (frame.type === 'assistant' || frame.type === 'user') {
      const content = typeof message.content === 'string' ? [{ type:'text', text:message.content }] : message.content || [];
      let offset=frame.backstageBlockOffset || 0;
      if (frame.type === 'assistant' && !historical && frame.uuid) {
        const key=this.key(turnId,message.id || frame.uuid);
        let cursor=this.messageOffsets.get(key);
        if (!cursor) {cursor={next:0,frames:new Map()};this.messageOffsets.set(key,cursor);}
        if (!cursor.frames.has(frame.uuid)) {cursor.frames.set(frame.uuid,cursor.next);cursor.next+=content.length;}
        offset=cursor.frames.get(frame.uuid);
      }
      const blocks = content.map((block, index) => ({ block, index }));
      if (historical) blocks.reverse();
      for (const {block, index} of blocks) {
        if (!block) continue;
        const id = block.id || block.tool_use_id || `${message.id || frame.uuid}:${offset+index}`;
        const tool = block.type === 'tool_use', result = block.type === 'tool_result';
        const type = tool || result ? 'mcpToolCall' : block.type === 'thinking' ? 'reasoning'
          : frame.type === 'user' ? 'userMessage' : 'agentMessage';
        const values = tool ? { command:block.input?.command, details:block.input }
          : result ? { output:block.content } : block.type === 'thinking' ? { summary:block.thinking }
          : block.type === 'text' ? { text:block.text } : { details:block };
        // Tool-result frames update the call itself without replacing its name.
        this.entry(turnId, id, { type, ...(result ? {} : {title:block.name || (frame.type === 'user' ? '你' : 'Claude')}),
          phase:message.stop_reason === 'end_turn' ? 'final_answer' : 'commentary',
          status:tool ? (historical ? 'unknown' : 'running') : block.is_error ? 'failed' : 'completed' }, values, historical);
      }
    } else if (frame.type === 'result') {
      const status = ['aborted_streaming','aborted_tools'].includes(frame.terminal_reason) ? 'interrupted'
        : frame.is_error || frame.subtype !== 'success' ? 'failed' : 'completed';
      if (!historical) this.capture(store => {
        const prefix=this.key(turnId,'');
        const rows=new Map([...store.db.prepare('SELECT id,value FROM entries WHERE id>=? AND id<?')
          .iterate(prefix,prefix+'\uffff')].map(row=>[row.id,JSON.parse(row.value)]));
        for (const [id,entry] of store.pending) if (id.startsWith(prefix)) rows.set(id,entry);
        for (const [id,entry] of rows) if (entry.status === 'running') {
          // The turn ended without this item's own completion. Do not leave
          // it working forever or invent a successful tool result.
          store.update(id,{status:status === 'completed' ? 'unknown' : status});
          store.releaseHashes(id);
        }
        for (const [key,stream] of this.streams) if (stream.turnId === turnId) this.streams.delete(key);
        for (const key of this.messageOffsets.keys()) if (key.startsWith(prefix)) this.messageOffsets.delete(key);
      });
      this.entry(turnId, '$result', {type:'turn', title:'本轮',
        status}, {result:frame}, historical);
    } else if (frame.type === 'system') {
      this.entry(turnId, frame.uuid || `${frame.subtype}:${frame.task_id || ''}`, {type:'diagnostic', title:frame.subtype || 'Claude', status:'completed'}, {details:frame}, historical);
    }
  }
  seedHistory(count = 40) {
    if (!this.history) {
      this.history = [...this.session.records.values(), ...this.session.activities.records.values()]
        .sort((a,b) => a.createdAt-b.createdAt).map(record => {
          // SDK assistant frames contain individual blocks sharing one API
          // message ID. Compute forward offsets before paging history backwards.
          const offsets=new Map();
          const frames=[...(record.messages?.values() || [])].map(frame=>{
            if (frame.type !== 'assistant') return frame;
            const key=frame.message?.id || frame.uuid,offset=offsets.get(key) || 0;
            offsets.set(key,offset+(frame.message?.content?.length || 0));
            return {...frame,backstageBlockOffset:offset};
          });
          return {id:record.userMessageId,frames:[...(!record.nativeActivity ? [{type:'user',uuid:record.userMessageId,message:{content:record.content || record.text}}] : []),
            ...frames,...(record.result ? [record.result] : [])]};
        });
      this.historyCursor = {turn:this.history.length-1, item:null};
    }
    const cursor = this.historyCursor;
    let loaded = 0;
    while (cursor.turn >= 0 && loaded < count) {
      const turn = this.history[cursor.turn];
      if (cursor.item == null) cursor.item = turn.frames.length-1;
      if (cursor.item < 0) {cursor.turn--; cursor.item=null; continue;}
      this.frame(turn.frames[cursor.item--], turn.id, true); loaded++;
    }
    return cursor.turn >= 0;
  }
  read(options = {}) {
    const result = super.read(options);
    return {...result, capture:'保留启用后的 Claude 消息、思考、工具结果、原生回执和 stderr；较早内容来自本 Hub 已保存的会话记录。启用前未采集的诊断和历史逐字过程无法补录。'};
  }
}
module.exports = { ClaudeBackstage };
