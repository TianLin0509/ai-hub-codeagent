'use strict';
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { getHubDataDir } = require('./data-dir');

class NativeDraftStore {
  constructor(root = getHubDataDir()) {
    fs.mkdirSync(root, { recursive: true });
    this.db = new DatabaseSync(path.join(root, 'native-input-drafts.sqlite'));
    try {
      // Every keystroke in a native composer commits here on Main's thread.
      // FULL fsyncs each commit (5 ms idle, 100 ms measured under transcript
      // I/O) and stalls all IPC, typing included. WAL+NORMAL still keeps every
      // commit across a Hub crash; only an OS crash or power loss can drop the
      // last few keystrokes of a draft.
      this.db.exec('PRAGMA busy_timeout=1000; PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;');
      this.db.exec('CREATE TABLE IF NOT EXISTS drafts (session_id TEXT PRIMARY KEY, revision INTEGER NOT NULL, text TEXT NOT NULL)');
    } catch (error) { this.db.close(); throw error; }
  }
  read(sessionId) {
    if (typeof sessionId !== 'string' || !/^[a-zA-Z0-9-]{1,128}$/.test(sessionId)) throw new Error('Invalid draft session ID');
    const row = this.db.prepare('SELECT revision,text FROM drafts WHERE session_id=?').get(sessionId);
    return row ? { revision: row.revision, text: row.text } : { revision: 0, text: null };
  }
  save(sessionId, text, revision) {
    if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > 16 * 1024 * 1024
        || !Number.isSafeInteger(revision) || revision < 0 || revision >= Number.MAX_SAFE_INTEGER) throw new Error('Invalid draft payload');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const current = this.read(sessionId);
      if (current.revision !== revision) {
        const error = new Error('草稿已被其他窗口修改；本框内容未覆盖已保存的版本，请先复制保存');
        error.code = 'NATIVE_DRAFT_CONFLICT'; error.current = current; throw error;
      }
      const next = { revision: revision + 1, text };
      this.db.prepare('INSERT INTO drafts(session_id,revision,text) VALUES(?,?,?) ON CONFLICT(session_id) DO UPDATE SET revision=excluded.revision,text=excluded.text')
        .run(sessionId, next.revision, text);
      this.db.exec('COMMIT');
      return next;
    } catch (error) {
      try { this.db.exec('ROLLBACK'); }
      catch (rollbackError) { error.message += '; draft rollback failed: ' + rollbackError.message; }
      throw error;
    }
  }
  close() { this.db.close(); }
}
module.exports = { NativeDraftStore };
