'use strict';
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { getHubDataDir } = require('./data-dir');

// User input belongs in history even when the provider executes it locally and
// never creates a model turn. This journal is presentation, never runtime truth.
class CommandTranscriptStore {
  constructor(root = getHubDataDir()) {
    fs.mkdirSync(root, { recursive: true });
    this.db = new DatabaseSync(path.join(root, 'command-transcript.sqlite'));
    try {
      this.db.exec('PRAGMA busy_timeout=3000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
      this.db.exec(`CREATE TABLE IF NOT EXISTS commands (
        session_id TEXT NOT NULL, submission_id TEXT NOT NULL, text TEXT NOT NULL,
        ts INTEGER NOT NULL, result TEXT, PRIMARY KEY(session_id, submission_id))`);
    } catch (error) { this.db.close(); throw error; }
  }
  begin(sessionId, id, text) {
    const old = this.db.prepare('SELECT text,result FROM commands WHERE session_id=? AND submission_id=?').get(sessionId, id);
    if (old) {
      if (old.text !== text) throw new Error('命令提交 ID 已用于其他正文');
      return { duplicate: true, result: old.result ? JSON.parse(old.result) : null };
    }
    this.db.prepare('INSERT INTO commands VALUES (?,?,?,?,NULL)').run(sessionId, id, text, Date.now());
    return { duplicate: false };
  }
  finish(sessionId, id, result) {
    this.db.prepare('UPDATE commands SET result=? WHERE session_id=? AND submission_id=?')
      .run(JSON.stringify(result), sessionId, id);
  }
  read(sessionId) {
    return this.db.prepare('SELECT submission_id,text,ts,result FROM commands WHERE session_id=? ORDER BY ts,rowid').all(sessionId)
      .map(row => ({ id: 'command:' + row.submission_id, role: 'user', text: row.text,
        ts: row.ts, source: 'hub-command', clientSubmissionId: row.submission_id,
        commandResult: row.result ? JSON.parse(row.result) : null }));
  }
  close() { this.db.close(); }
}
const stores = new Map();
function commandTranscriptStore() {
  const root = getHubDataDir();
  if (!stores.has(root)) stores.set(root, new CommandTranscriptStore(root));
  return stores.get(root);
}
function mergeCommandTurns(turns, commands, opts = {}) {
  // Correlate by submission identity, never collapse repeated identical commands.
  const ids = new Set(commands.map(c => c.clientSubmissionId));
  const unmatched = [...commands];
  const kept = turns.filter(turn => {
    if (turn.role !== 'user') return true;
    if (ids.has(turn.clientSubmissionId)) return false;
    // Legacy PTY transcripts have no submission IDs. Match each echo once by
    // exact text and nearby provider timestamp; repeated inputs remain separate.
    if (!turn.clientSubmissionId && turn.ts) {
      const index = unmatched.findIndex(c => c.text.trim() === String(turn.text || '').trim()
        && Math.abs(c.ts - turn.ts) < 30000);
      if (index >= 0) { unmatched.splice(index, 1); return false; }
    }
    return true;
  });
  const merged = [...kept, ...commands]
    .sort((a, b) => (a.ts || 0) - (b.ts || 0));
  const limit = opts.limit === undefined ? 50 : opts.limit;
  return Number.isFinite(limit) && limit >= 0
    ? (opts.fromTail === false ? merged.slice(0, limit) : limit === 0 ? [] : merged.slice(-limit)) : merged;
}
module.exports = { CommandTranscriptStore, commandTranscriptStore, mergeCommandTurns };
