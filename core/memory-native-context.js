'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { Worker, isMainThread, parentPort, workerData } = require('node:worker_threads');
const { JsonlByteScanner } = require('./jsonl-byte-scanner');
const { inspectCodexEnvelope } = require('./codex-rollout-reader');

// Read the bound native transcript only. File discovery and current disk rules
// are not evidence of what was included in this conversation.
function collectNativeContext({ file, nativeId, size, previous }) {
  const entries = new Map((previous?.entries || []).map(e => [e.key, e]));
  let observedId = previous?.nativeId || '', compactedAt = previous?.compactedAt || '';
  const warnings = (previous?.warnings || []).filter(w => !w.includes('末尾仍在写入'));
  const scanner = new JsonlByteScanner((record, index) => {
    const p = record.payload || {};
    if (record.type === 'session_meta') { observedId = p.id || p.session_id || ''; return; }
    if (record.type === 'compacted') { compactedAt = record.timestamp || 'unknown'; return; }
    if (record.type !== 'response_item' || p.type !== 'message') return;
    const text = (Array.isArray(p.content) ? p.content : []).map(c => c.text || '').join('\n');
    let key, label, content;
    const rule = p.role === 'user' && text.match(/^# AGENTS\.md instructions for ([^\r\n]+)\r?\n\s*<INSTRUCTIONS>([\s\S]*?)<\/INSTRUCTIONS>/);
    if (rule) {
      key = 'agents:' + rule[1].replace(/\\/g, '/').toLowerCase();
      label = 'AGENTS.md · ' + rule[1]; content = rule[0];
    } else if (p.role === 'developer' && /^## Memory\r?\n/.test(text)) {
      key = 'memory'; label = '原生 Memory 注入';
      const end = text.indexOf('========= MEMORY_SUMMARY ENDS =========');
      content = end < 0 ? text : text.slice(0, end + '========= MEMORY_SUMMARY ENDS ========='.length);
    } else return;
    entries.set(key, { key, label, content, path: file, line: index + 1,
      source: 'native', sentAt: Date.parse(record.timestamp) || 0, status: '原生记录' });
  }, {
    startOffset: previous?.offset || 0, startLineIndex: previous?.lineIndex || 0,
    lineFilter(prefix, context) {
      const e = inspectCodexEnvelope(prefix);
      const complete = context.final || context.prefixBytes >= context.maxPrefixBytes;
      if (!e.recordType) return complete ? false : null;
      if (e.recordType === 'session_meta') {
        const id = prefix.slice(e.payloadAt).match(/"(?:id|session_id)"\s*:\s*"([^"]+)"/);
        if (id) { observedId = id[1]; return false; }
        return complete ? false : null;
      }
      if (e.recordType === 'compacted') { compactedAt = 'observed'; return false; }
      if (e.recordType !== 'response_item') return false;
      if (!e.payloadType || !e.role) return complete ? false : null;
      if (e.payloadType !== 'message' || !['user', 'developer'].includes(e.role)) return false;
      // Reject ordinary messages and image/tool payloads before buffering them.
      const start = prefix.match(/"text"\s*:\s*"([^"\r\n]{0,80})/);
      if (!start) return complete ? false : null;
      const markers = e.role === 'user' ? ['# AGENTS.md instructions for '] : ['## Memory\\n', '## Memory\\r\\n'];
      if (markers.some(m => start[1].startsWith(m))) return true;
      if (!complete && markers.some(m => m.startsWith(start[1]))) return null;
      return false;
    },
  });
  const fd = fs.openSync(file, 'r');
  const fingerprint = createHash('sha256');
  let offset = 0, prefixMatches = !previous;
  try {
    const buffer = Buffer.allocUnsafe(256 * 1024);
    while (offset < size) {
      const n = fs.readSync(fd, buffer, 0, Math.min(buffer.length, size - offset), offset);
      if (!n) break;
      const chunk = buffer.subarray(0, n);
      // Size growth alone does not prove an append. Verify the complete old
      // byte prefix before reusing its extracted evidence (bounded memory).
      if (previous && offset < previous.fingerprintBytes && offset + n >= previous.fingerprintBytes) {
        prefixMatches = fingerprint.copy().update(chunk.subarray(0, previous.fingerprintBytes - offset)).digest('hex') === previous.fingerprint;
      }
      fingerprint.update(chunk);
      const skip = Math.max(0, (previous?.offset || 0) - offset);
      if (skip < n) scanner.push(chunk.subarray(skip));
      offset += n;
    }
  } finally { fs.closeSync(fd); }
  if (!prefixMatches) return collectNativeContext({ file, nativeId, size, previous: null });
  const stats = scanner.end({ flushFinal: false });
  if (observedId !== nativeId) throw new Error('原生记录的会话身份不匹配，未展示其中内容');
  if (stats.invalidRecords) warnings.push(`${stats.invalidRecords} 条原生记录无法解析，结果可能不完整`);
  if (stats.pendingLineBytes) warnings.push('原生记录末尾仍在写入，刷新后读取完整记录');
  return { entries: [...entries.values()], nativeId, offset: stats.safeOffset,
    lineIndex: stats.nextLineIndex, compactedAt, warnings, stats,
    fingerprint: fingerprint.digest('hex'), fingerprintBytes: offset };
}

class NativeContextReader {
  constructor() { this.cache = new Map(); this.flights = new Map(); }
  async read(session, { force = false } = {}) {
    if ((session.transcriptKind || session.kind) !== 'codex') return { entries: [], warnings: ['此 AI 尚未接入原生注入记录；下方仅展示 Hub 已确认的提交。'] };
    if (!session.codexSid || !session.transcriptPath) return { entries: [], warnings: ['尚未定位本会话的原生记录，不能确认原生规则和记忆注入。'] };
    const file = path.resolve(session.transcriptPath), key = session.codexSid + ':' + file;
    const stat = await fs.promises.stat(file);
    const signature = [stat.ino, stat.birthtimeMs, stat.size, stat.mtimeMs].join(':');
    const cached = this.cache.get(key);
    if (!force && cached?.signature === signature) return cached.result;
    const flightKey = key + ':' + signature + ':' + force;
    if (this.flights.has(flightKey)) return this.flights.get(flightKey);
    const previous = !force && cached && stat.ino === cached.stat.ino && stat.birthtimeMs === cached.stat.birthtimeMs
      && stat.size > cached.stat.size ? cached.result : null;
    const task = new Promise((resolve, reject) => {
      const worker = new Worker(__filename, { workerData: { file, nativeId: session.codexSid, size: stat.size, previous } });
      let replied = false;
      const timeout = setTimeout(() => { void worker.terminate(); reject(new Error('读取原生注入记录超时，请刷新重试')); }, 15000);
      worker.once('message', result => { replied = true; clearTimeout(timeout); result.ok ? resolve(result.data) : reject(new Error(result.error)); });
      worker.once('error', reject);
      worker.once('exit', code => { clearTimeout(timeout); if (!replied) reject(new Error(`原生记录读取进程未返回结果 (${code})`)); });
    }).then(result => {
      // A slower old snapshot must not replace a newer append in the cache.
      const latest = this.cache.get(key);
      if (!latest || latest.stat.mtimeMs <= stat.mtimeMs) {
        this.cache.delete(key); this.cache.set(key, { signature, stat, result });
        while (this.cache.size > 8) this.cache.delete(this.cache.keys().next().value);
      }
      return result;
    }).finally(() => this.flights.delete(flightKey));
    this.flights.set(flightKey, task); return task;
  }
}
if (!isMainThread && workerData?.nativeId) {
  try { parentPort.postMessage({ ok: true, data: collectNativeContext(workerData) }); }
  catch (error) { parentPort.postMessage({ ok: false, error: error.message }); }
}
module.exports = { NativeContextReader, collectNativeContext };
