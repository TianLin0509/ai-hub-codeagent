'use strict';

class TerminalOutputBatcher {
  constructor({ emit, delayMs = 8, maxBytes = 256 * 1024 } = {}) {
    if (typeof emit !== 'function') throw new TypeError('emit callback required');
    this.emit = emit;
    this.delayMs = Math.max(0, Number(delayMs) || 0);
    this.maxBytes = Math.max(1024, Number(maxBytes) || 256 * 1024);
    this.pending = new Map();
    this.stats = {
      pushedChunks: 0,
      emittedBatches: 0,
      inputBytes: 0,
      outputBytes: 0,
      maxBatchChunks: 0,
    };
  }

  // delayMs 可按次覆盖：聚焦会话走默认的 8ms（等同实时），未聚焦的群聊成员走
  // 更长的合并窗口，用一个数量级的 IPC 次数换回完整的数据流（见 terminal-output-policy.js）。
  push(sessionId, data, seq, delayMs) {
    if (!sessionId || data === undefined || data === null || data === '') return false;
    const text = typeof data === 'string' ? data : String(data);
    const bytes = Buffer.byteLength(text);
    this.stats.pushedChunks += 1;
    this.stats.inputBytes += bytes;
    let item = this.pending.get(sessionId);
    if (!item) {
      item = { chunks: [], bytes: 0, seq: undefined, timer: null };
      this.pending.set(sessionId, item);
    }
    item.chunks.push(text);
    item.bytes += bytes;
    if (seq !== undefined) item.seq = seq;

    if (item.bytes >= this.maxBytes) {
      this.flush(sessionId);
      return true;
    }
    if (!item.timer) {
      const delay = Number.isFinite(Number(delayMs)) ? Math.max(0, Number(delayMs)) : this.delayMs;
      item.timer = setTimeout(() => this.flush(sessionId), delay);
      item.timer.unref?.();
    }
    return true;
  }

  flush(sessionId) {
    const item = this.pending.get(sessionId);
    if (!item) return false;
    this.pending.delete(sessionId);
    if (item.timer) clearTimeout(item.timer);
    const data = item.chunks.join('');
    if (data) {
      this.stats.emittedBatches += 1;
      this.stats.outputBytes += item.bytes;
      this.stats.maxBatchChunks = Math.max(this.stats.maxBatchChunks, item.chunks.length);
      this.emit({ sessionId, data, seq: item.seq });
    }
    return true;
  }

  flushAll() {
    for (const sessionId of [...this.pending.keys()]) this.flush(sessionId);
  }

  dispose({ flush = true } = {}) {
    if (flush) {
      this.flushAll();
      return;
    }
    for (const item of this.pending.values()) {
      if (item.timer) clearTimeout(item.timer);
    }
    this.pending.clear();
  }

  snapshotStats() {
    return { ...this.stats, pendingSessions: this.pending.size };
  }
}

module.exports = { TerminalOutputBatcher };
