'use strict';
const { randomUUID } = require('crypto');
const { captureClaudeMessage } = require('./claude-native-transcript');
const END = new Set(['completed', 'failed', 'interrupted']);
function originKey(origin) { return JSON.stringify([origin?.kind, origin?.subkind || null, origin?.server || null]); }

// A result closes one query turn, not the lifetime of a Claude process. Injected
// turns have their own provenance and never acquire a Hub submission receipt.
class ClaudeNativeActivities {
  constructor(options) {
    this.options = options;
    this.records = new Map();
    this.toolOwners = new Map();
    this.current = null;
    this.segment = [];
    this.ambiguous = false;
    for (const saved of options.restoredActivities || []) {
      const record = { ...saved, status: END.has(saved.status) ? saved.status : 'unknown',
        messages: new Map((saved.transcriptMessages || []).map(m => [m.uuid || m.message?.id, m])) };
      this.records.set(record.userMessageId, record);
      this.rememberTools(record);
    }
  }
  pending() { return [...this.records.values()].filter(r => !END.has(r.status) && !r.reconciliation); }
  // pending 是「还需要一个结论」，live 是「引擎此刻真的在跑它」。判成 unknown 的
  // 活动属于前者不属于后者：它要人核对，但不该继续占着发送队列，也不该让卡片
  // 一直亮「工作中」。两者混用过一次，代价是会话被锁死好几个小时。
  live() { return this.pending().filter(r => r.status === 'running'); }
  // 引擎一次只跑一轮。新的注入回合开始，就证明上一条还没结局的注入回合不会再有
  // 结局了 —— 留着它等于永远等一个不会来的 result。这里只判 unknown（待核对），
  // 绝不编造成功，也不丢弃它已经收下的正文。
  abandonStale() {
    const stale = this.pending().filter(r => !r.provisional && r.status === 'running');
    if (!stale.length) return stale;
    // 判 unknown 之前必须先把段关掉，否则紧接着的 deferSegment 会把已经收下的
    // 正文撤销，只剩一条空壳记录。关段只能按帧各归各家 —— 段里可能同时躺着还在
    // 跑的人类回合的帧（channel 这类注入不会并轮），整段改嫁给被放弃的活动就是
    // 把用户这一轮的回答偷走。
    this.settleSegment();
    for (const record of stale) { this.save({ ...record, status: 'unknown' }); record.status = 'unknown'; }
    if (stale.includes(this.current)) this.current = null;
    return stale;
  }
  // 注入回合（任务通知、Monitor 事件、Hub 恢复出来的后台任务）是引擎自己的续跑，
  // 不是用户发的消息，没有「重发」这回事；原生 transcript 也证明不了它的结局。
  // 让用户去「核对」它只能换来一次点按钮 —— 2026-09-17~24 生产日志里待核对的 Claude
  // 记录 86 条，83 条是它。这里直接登记 do-not-replay：状态仍是 unknown，不编造成功，
  // 只是不再要人确认。
  // persist=false 用在构造时：那时还没确认会话归属，不能写日志（会话独占），
  // 由 _start 拿到归属后调 saveUnsavedSettlements 补写。
  settleUnknown(source = 'hub', { persist = true } = {}) {
    const settled = [...this.records.values()].filter(r => r.status === 'unknown' && !r.reconciliation);
    const reconciliation = { source, resolution: 'do-not-replay', at: Date.now(), history: 'engine-internal' };
    for (const record of settled) {
      record.reconciliation = reconciliation;
      if (persist) this.save(record); else record.unsavedSettlement = true;
    }
    return settled;
  }
  saveUnsavedSettlements() {
    for (const record of this.records.values()) {
      if (!record.unsavedSettlement) continue;
      delete record.unsavedSettlement;
      this.save(record);
    }
  }
  // 段的作用是「结局到来前先别定归属」。现在判定这些活动不会再有结局了，就把
  // 每一帧还给它当初被记在的那条记录：既不整段丢掉，也不整段改嫁。
  settleSegment() {
    if (!this.segment.length) { this.ambiguous = false; return; }
    this.unprojectSegment();
    for (const { record, frame } of this.segment) {
      captureClaudeMessage(record, frame);
      for (const block of frame.message?.content || []) {
        if (block.type === 'tool_use' && block.id) this.toolOwners.set(block.id, record);
      }
      if (frame.type === 'assistant' && !frame.parent_tool_use_id) {
        record.finalText = (frame.message?.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
      }
    }
    this.segment = []; this.ambiguous = false;
  }
  save(record) {
    const { messages, streams, ...data } = record;
    const saved = this.options.persistActivity?.({ ...data, transcriptMessages: [...(messages?.values() || [])] });
    if (saved && typeof saved.then === 'function') throw new Error('persistActivity must save synchronously');
  }
  // Late child output after the activity settled used to re-save the whole
  // transcript per frame; the journal now merges an appended slice instead.
  saveAppended(record, frame) {
    const { messages, streams, ...data } = record;
    const saved = this.options.persistActivity?.({ ...data, transcriptAppend: [frame] });
    if (saved && typeof saved.then === 'function') throw new Error('persistActivity must save synchronously');
  }
  begin(frame) {
    const id = frame.uuid || randomUUID(); // Local display identity if the provider omitted its UUID.
    const record = { userMessageId: id, providerMessageId: frame.uuid || null,
      nativeActivity: true, origin: frame.origin, status: 'running', createdAt: Date.now(),
      content: frame.message?.content, finalText: '', messages: new Map() };
    this.save(record);
    this.records.set(id, record);
    this.current = record;
    return record;
  }
  // Measured on Claude Code 2.1.269: for a task-notification turn the engine
  // streams the assistant frames first and replays the injected user frame
  // (without a UUID) only milliseconds before the result. Dropping those early
  // frames left the activity with nothing but result.result, so the card showed
  // no progress and the disk history could not be deduplicated against it.
  // A provisional record takes them in; the injected input or the result then
  // adopts it instead of opening a second identity.
  beginProvisional() {
    const record = this.begin({ origin: { kind: 'pending' } });
    record.provisional = true;
    return record;
  }
  inject(frame) {
    const current = this.current;
    if (current?.provisional && !END.has(current.status)) {
      Object.assign(current, { provisional: false, origin: frame.origin,
        providerMessageId: frame.uuid || current.providerMessageId, content: frame.message?.content });
      this.save(current);
      return current;
    }
    this.deferSegment();
    return this.begin(frame);
  }
  owner(frame, human) {
    if (frame.parent_tool_use_id) return this.toolOwners.get(frame.parent_tool_use_id) || null;
    const results = Array.isArray(frame.message?.content) ? frame.message.content.filter(b => b.type === 'tool_result') : [];
    if (results.length) {
      const owners = results.map(b => this.toolOwners.get(b.tool_use_id));
      if (owners.every(owner => owner && owner === owners[0])) return owners[0];
      return null;
    }
    return this.current || human;
  }
  capture(record, frame) {
    // User echoes acknowledge intake, not which root query owns later output.
    // A query's result.origin is the final attribution boundary. Keep its
    // frames until that boundary, especially when injected inputs arrive early.
    if (!END.has(record.status)) this.segment.push({ record, frame });
    if (!this.ambiguous || END.has(record.status)) captureClaudeMessage(record, frame);
    for (const block of frame.message?.content || []) {
      if (block.type === 'tool_use' && block.id) this.toolOwners.set(block.id, record);
    }
  }
  unprojectSegment() {
    for (const { record, frame } of this.segment) {
      record.messages?.delete(frame.uuid || frame.message?.id);
      record.streams?.delete(frame.parent_tool_use_id || 'root');
      record.finalText = '';
    }
  }
  deferSegment() {
    this.unprojectSegment();
    this.ambiguous = true;
  }
  resolveSegment(owner) {
    this.unprojectSegment();
    for (const { frame } of this.segment) {
      captureClaudeMessage(owner, frame);
      for (const block of frame.message?.content || []) {
        if (block.type === 'tool_use' && block.id) this.toolOwners.set(block.id, owner);
      }
      if (frame.type === 'assistant' && !frame.parent_tool_use_id) {
        owner.finalText = (frame.message?.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
      }
    }
    this.segment = []; this.ambiguous = false;
  }
  rememberTools(record) {
    for (const frame of record.messages?.values() || []) {
      for (const block of frame.message?.content || []) {
        if (block.type === 'tool_use' && block.id) this.toolOwners.set(block.id, record);
      }
    }
  }
  finish(frame) {
    // 候选只能是还在跑的那些。已经判成 unknown 的活动在等人核对，不再是这条
    // result 的可能归属 —— 把它算进来会让同来源的第二条通知永远报「归属歧义」。
    const exact = this.live().filter(r => !r.provisional && originKey(r.origin) === originKey(frame.origin));
    if (exact.length > 1) throw new Error('Claude injected result has ambiguous origin; no activity was settled');
    const provisional = exact.length ? [] : this.live().filter(r => r.provisional);
    const matches = exact.length ? exact : provisional;
    // Some CLI event types omit a replayed user frame. Keep that result as a
    // standalone activity; never borrow the active human's output or identity.
    const previous = this.current;
    const record = matches[0] || this.begin({ origin: frame.origin });
    if (record.provisional) Object.assign(record, { provisional: false, origin: frame.origin });
    this.resolveSegment(record);
    const interrupted = ['aborted_streaming', 'aborted_tools'].includes(frame.terminal_reason);
    const status = interrupted ? 'interrupted' : frame.is_error || frame.subtype !== 'success' ? 'failed' : 'completed';
    const completed = { ...record, status, completedAt: Date.now(), providerResultId: frame.uuid || null,
      result: frame,
      finalText: typeof frame.result === 'string' ? frame.result : record.finalText,
      errors: frame.errors || null };
    this.save(completed);
    Object.assign(record, completed);
    if (this.current === record) this.current = matches.length ? null : previous;
    return record;
  }
  reset() {
    this.current = null;
    this.segment = []; this.ambiguous = false;
    for (const record of this.pending()) {
      this.save({ ...record, status: 'unknown' });
      record.status = 'unknown';
    }
  }
  recoverTasks(tasks, epoch, persist = true) {
    for (const task of tasks) {
      const id = 'task-recovery:' + epoch + ':' + task.id;
      if (this.records.has(id)) continue;
      // This is a Hub recovery record, explicitly not a provider user turn.
      const record = { userMessageId: id, providerMessageId: null, nativeActivity: true,
        nativeTask: true, taskId: task.id, origin: { kind: 'hub-task-recovery' },
        status: 'unknown', createdAt: Date.now(), content: '未确认结束的后台任务 ' + task.id,
        finalText: '', messages: new Map() };
      if (persist) this.save(record);
      this.records.set(id, record);
    }
  }
}
module.exports = { ClaudeNativeActivities };
