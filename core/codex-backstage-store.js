'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

const PREVIEW = 4096;
const CHUNK = 8192;
const digest = text => createHash('sha256').update(text, 'utf16le').digest('hex');
// JSON encoding preserves NUL and individual UTF-16 code units across deltas.
const decodeChunk = row => ({ ...row, text:row.encoding === 'json' ? JSON.parse(row.text) : row.text });
const number = (value, fallback = 0) => Number.isSafeInteger(Number(value)) && Number(value) >= 0 ? Number(value) : fallback;
function pieces(text) {
  const result = [];
  for (let offset = 0; offset < text.length;) {
    let end = Math.min(text.length, offset + CHUNK);
    if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1])) end--;
    result.push(text.slice(offset, end)); offset = end;
  }
  return result;
}

// One append journal per native writer. IPC carries bounded previews; original
// stream chunks remain pageable, including revisions and diagnostics. No scan,
// whole-history serialization, or idle polling is on the output path.
class CodexBackstageStore {
  constructor(file = ':memory:', onChange = () => {}, onFailure = () => {}) {
    this.file = file;
    if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive:true });
    const { DatabaseSync } = require('node:sqlite');
    this.db = new DatabaseSync(file);
    try {
      this.db.exec(`PRAGMA busy_timeout=100; PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;
        CREATE TABLE IF NOT EXISTS entries (id TEXT PRIMARY KEY, ordinal INTEGER NOT NULL UNIQUE, revision INTEGER NOT NULL, value TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS entry_revision ON entries(revision);
        CREATE TABLE IF NOT EXISTS chunks (seq INTEGER PRIMARY KEY, id TEXT NOT NULL, field TEXT NOT NULL, generation INTEGER NOT NULL, stamp INTEGER NOT NULL, text TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS chunk_entry ON chunks(id,field,generation,seq);`);
      if (!this.db.prepare('PRAGMA table_info(chunks)').all().some(column => column.name === 'encoding')) {
        this.db.exec("ALTER TABLE chunks ADD COLUMN encoding TEXT NOT NULL DEFAULT 'text'");
      }
      this.revision = this.db.prepare('SELECT COALESCE(MAX(revision),0) AS n FROM entries').get().n;
      this.ordinal = this.db.prepare('SELECT COALESCE(MAX(ordinal),0) AS n FROM entries').get().n;
      this.seq = this.db.prepare('SELECT COALESCE(MAX(seq),0) AS n FROM chunks').get().n;
      this.putEntry = this.db.prepare('INSERT INTO entries VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,value=excluded.value');
      this.putChunk = this.db.prepare("INSERT INTO chunks(seq,id,field,generation,stamp,text,encoding) VALUES(?,?,?,?,?,?,'json')");
      this.cache = new Map(); this.hashes = new Map(); this.pending = new Map(); this.chunks = []; this.pendingBytes = 0;
      this.onChange = onChange; this.onFailure = onFailure; this.timer = null; this.failure = null; this.closed = false;
    } catch (error) { this.db.close(); throw error; }
  }
  get(id, fields = {}) {
    let entry = this.cache.get(id);
    if (!entry) {
      const row = this.db.prepare('SELECT value FROM entries WHERE id=?').get(id);
      entry = row ? JSON.parse(row.value) : { id, ordinal:++this.ordinal, stamp:Date.now(), fields:{}, ...fields };
      this.cache.set(id, entry);
      // Active changes remain in pending until committed. Evict completed cache
      // entries only; the SQLite index is authoritative for older history.
      if (this.cache.size > 256) for (const [key, value] of this.cache) {
        if (key !== id && value.status !== 'running' && !this.pending.has(key)) { this.cache.delete(key); if (this.cache.size <= 192) break; }
      }
    }
    return entry;
  }
  dirty(entry) {
    if (this.failure) throw this.failure;
    if (this.closed) throw new Error('后台记录已关闭');
    entry.revision = ++this.revision;
    this.pending.set(entry.id, entry);
    if (this.pendingBytes >= 256 * 1024) this.flush();
    else if (!this.timer) {
      this.timer = setTimeout(() => { this.timer = null; try { this.flush(); } catch (error) { this.onFailure(error); } }, 50);
      this.timer.unref?.();
    }
  }
  update(id, fields) {
    const entry = this.get(id, fields);
    let changed = !entry.revision;
    for (const [key, value] of Object.entries(fields)) if (value !== undefined && entry[key] !== value) { entry[key] = value; changed = true; }
    if (changed) this.dirty(entry);
    return entry;
  }
  append(id, field, text, fields = {}) {
    text = String(text ?? '');
    if (!text) return;
    const entry = this.get(id, fields);
    let info = entry.fields[field];
    if (!info) info = entry.fields[field] = { generation:1, length:0, preview:'', digest:digest('') };
    const hashKey = id + '\0' + field;
    let hash = this.hashes.get(hashKey);
    if (!hash) {
      hash = createHash('sha256');
      if (info.length) {
        for (const chunk of this.db.prepare('SELECT text,encoding FROM chunks WHERE id=? AND field=? AND generation=? ORDER BY seq').iterate(id, field, info.generation)) hash.update(decodeChunk(chunk).text, 'utf16le');
        for (const chunk of this.chunks) if (chunk.id === id && chunk.field === field && chunk.generation === info.generation) hash.update(chunk.text, 'utf16le');
      }
      this.hashes.set(hashKey, hash);
    }
    hash.update(text, 'utf16le'); info.digest = hash.copy().digest('hex');
    info.length += text.length;
    info.preview = (info.preview + text).slice(-PREVIEW);
    for (const part of pieces(text)) {
      this.chunks.push({ seq:++this.seq, id, field, generation:info.generation, stamp:Date.now(), text:part });
      this.pendingBytes += part.length * 2;
    }
    this.dirty(entry);
  }
  set(id, field, text, fields = {}) {
    text = String(text ?? '');
    const entry = this.get(id, fields), old = entry.fields[field];
    if (old && text.length === old.length && digest(text) === old.digest) return;
    if (old && text.length >= old.length && digest(text.slice(0, old.length)) === old.digest) {
      this.append(id, field, text.slice(old.length), fields); return;
    }
    if (old) {
      entry.fields[field] = { generation:old.generation + 1, length:0, preview:'', digest:digest('') };
      this.hashes.delete(id + '\0' + field);
      this.dirty(entry);
    }
    this.append(id, field, text, fields);
  }
  flush() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.failure) throw this.failure;
    if (!this.pending.size && !this.chunks.length) return;
    let begun = false;
    try {
      this.db.exec('BEGIN IMMEDIATE'); begun = true;
      for (const chunk of this.chunks) this.putChunk.run(chunk.seq, chunk.id, chunk.field, chunk.generation, chunk.stamp, JSON.stringify(chunk.text));
      for (const entry of this.pending.values()) this.putEntry.run(entry.id, entry.ordinal, entry.revision, JSON.stringify(entry));
      this.db.exec('COMMIT');
      this.chunks = []; this.pending.clear(); this.pendingBytes = 0;
      this.onChange(this.revision);
    } catch (error) {
      if (begun) try { this.db.exec('ROLLBACK'); } catch (rollback) { error.rollbackError = rollback; }
      this.failure = error; throw error;
    }
  }
  read(options = {}) {
    this.flush();
    const limit = Math.min(60, Math.max(1, number(options.limit, 40)));
    if (options.mode === 'raw' || options.mode === 'detail') {
      const detail = options.mode === 'detail';
      const filters = [], values = [];
      if (detail) {
        if (typeof options.id !== 'string' || options.id.length > 2048) throw new Error('后台步骤身份无效');
        const row = this.db.prepare('SELECT value FROM entries WHERE id=?').get(options.id);
        if (!row) throw new Error('后台步骤不存在');
        const entry = JSON.parse(row.value);
        const generations = Object.entries(entry.fields);
        if (!generations.length) return { chunks:[], more:false, revision:this.revision };
        filters.push('id=?'); values.push(options.id);
        filters.push('(' + generations.map(([field, info]) => { values.push(field, info.generation); return '(field=? AND generation=?)'; }).join(' OR ') + ')');
      }
      const descending = options.before != null || options.after == null;
      if (options.before != null) { filters.push('seq<?'); values.push(number(options.before)); }
      else if (options.after != null) { filters.push('seq>?'); values.push(number(options.after)); }
      const count = Math.min(limit, 16);
      const rows = this.db.prepare(`SELECT * FROM chunks ${filters.length ? 'WHERE ' + filters.join(' AND ') : ''} ORDER BY seq ${descending ? 'DESC' : 'ASC'} LIMIT ?`).all(...values, count + 1);
      const more = rows.length > count;
      const chunks = rows.slice(0, count).map(decodeChunk); if (descending) chunks.reverse();
      return { chunks, more, first:chunks[0]?.seq, last:chunks.at(-1)?.seq, revision:this.revision, end:this.seq };
    }
    const since = options.since == null ? null : number(options.since);
    const before = options.before == null ? null : Number.isSafeInteger(Number(options.before)) ? Number(options.before) : 0;
    const rows = since != null
      ? this.db.prepare('SELECT value FROM entries WHERE revision>? ORDER BY revision LIMIT ?').all(since, limit + 1)
      : this.db.prepare('SELECT value FROM entries WHERE ordinal<? ORDER BY ordinal DESC LIMIT ?').all(before ?? this.ordinal + 1, limit + 1);
    const more = rows.length > limit;
    let entries = rows.slice(0, limit).map(row => JSON.parse(row.value));
    const revision = since != null && more ? entries.at(-1)?.revision ?? since : this.revision;
    entries.sort((a,b) => a.ordinal - b.ordinal);
    return { entries, more, first:entries[0]?.ordinal, revision, end:this.seq };
  }
  releaseHashes(id) { for (const key of this.hashes.keys()) if (key.startsWith(id + '\0')) this.hashes.delete(key); }
  close() { if (this.closed) return; try { this.flush(); } finally { this.closed = true; this.db.close(); } }
}

module.exports = { CodexBackstageStore, pieces, PREVIEW, CHUNK, decodeChunk };
