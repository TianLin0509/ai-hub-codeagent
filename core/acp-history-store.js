'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

// Keep the old JSON as a read-only migration source. Streaming updates replace
// just one item; completed turns and large tool results are never rewritten for
// an unrelated text delta. Transactions retain complete recovery information.
class AcpHistoryStore {
  constructor(file) {
    this.legacyPath = file;
    this.file = file + '.sqlite';
    fs.mkdirSync(path.dirname(file), { recursive:true });
    this.db = new DatabaseSync(this.file);
    try {
      this.db.exec(`PRAGMA busy_timeout=100; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
        CREATE TABLE IF NOT EXISTS metadata (id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS migration (id INTEGER PRIMARY KEY CHECK(id=1), source TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS turns (id TEXT PRIMARY KEY, ordinal INTEGER UNIQUE NOT NULL, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS items (turn_id TEXT NOT NULL, id TEXT NOT NULL, ordinal INTEGER NOT NULL,
          value TEXT NOT NULL, PRIMARY KEY(turn_id,id), UNIQUE(turn_id,ordinal));`);
      this.setMeta = this.db.prepare('INSERT OR REPLACE INTO metadata VALUES(1,?)');
      this.setTurn = this.db.prepare('INSERT INTO turns VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value');
      this.setItem = this.db.prepare('INSERT INTO items VALUES(?,?,?,?) ON CONFLICT(turn_id,id) DO UPDATE SET value=excluded.value');
      this.turns = new Map();
      this.items = new Map();
      this.meta = null;
      this.failure = null;
    } catch (error) { this.db.close(); throw error; }
  }
  transaction(fn) {
    if (this.failure) throw this.failure;
    let begun = false;
    try { this.db.exec('BEGIN IMMEDIATE'); begun = true; fn(); this.db.exec('COMMIT'); }
    catch (error) {
      this.failure = error;
      if (begun) try { this.db.exec('ROLLBACK'); } catch (rollback) { error.rollbackError = rollback; }
      throw error;
    }
  }
  legacyStamp() {
    try {
      const stat = fs.statSync(this.legacyPath);
      return JSON.stringify([stat.size, stat.mtimeMs, stat.ctimeMs]);
    } catch (error) { if (error.code === 'ENOENT') return 'absent'; throw error; }
  }
  read(validate = () => {}) {
    let row = this.db.prepare('SELECT value FROM metadata WHERE id=1').get();
    // One check at open, never an output-time filesystem poll. An older Hub
    // must not silently change the JSON after this database becomes authoritative.
    this.sourceStamp = this.legacyStamp();
    const migrated = this.db.prepare('SELECT source FROM migration WHERE id=1').get();
    if (row && migrated && migrated.source !== this.sourceStamp)
      throw new Error('旧版 Hub 的 ACP 历史在迁移后发生变化；两份记录均已保留，请核对后恢复');
    if (!row && fs.existsSync(this.legacyPath)) {
      const legacy = JSON.parse(fs.readFileSync(this.legacyPath, 'utf8'));
      if (this.legacyStamp() !== this.sourceStamp) throw new Error('旧版 Hub 正在更新 ACP 历史，请待该会话停止写入后恢复');
      validate(legacy);
      this.sync(legacy);
      row = { value:this.meta };
    }
    if (!row) return null;
    validate(JSON.parse(row.value));
    this.meta = row.value;
    this.turns.clear(); this.items.clear();
    const turns = this.db.prepare('SELECT * FROM turns ORDER BY ordinal').all().map(row => {
      this.turns.set(row.id, { ordinal:row.ordinal, signature:row.value });
      const items = this.db.prepare('SELECT * FROM items WHERE turn_id=? ORDER BY ordinal').all(row.id).map(item => {
        this.items.set(row.id + '\0' + item.id, item.ordinal);
        return JSON.parse(item.value);
      });
      return { ...JSON.parse(row.value), items };
    });
    return { ...JSON.parse(row.value), turns };
  }
  putItem(turnId, item) {
    if (!this.turns.has(turnId)) throw new Error('ACP 历史缺少所属轮次');
    const key = turnId + '\0' + item.id;
    let ordinal = this.items.get(key);
    if (ordinal == null) {
      ordinal = this.db.prepare('SELECT COALESCE(MAX(ordinal),-1)+1 AS ordinal FROM items WHERE turn_id=?').get(turnId).ordinal;
    }
    this.setItem.run(turnId, item.id, ordinal, JSON.stringify(item));
    this.items.set(key, ordinal);
  }
  saveItem(turnId, item) { this.transaction(() => this.putItem(turnId, item)); }
  sync(snapshot) {
    const { turns, ...metadata } = snapshot;
    const meta = JSON.stringify(metadata);
    const changed = [];
    for (const turn of turns) {
      const { items, ...fields } = turn;
      const signature = JSON.stringify(fields);
      const old = this.turns.get(turn.id);
      if (old?.signature !== signature) changed.push({turn,signature,old});
    }
    if (meta === this.meta && !changed.length) return;
    this.transaction(() => {
      if (this.meta == null) this.db.prepare('INSERT OR IGNORE INTO migration VALUES(1,?)').run(this.sourceStamp ?? this.legacyStamp());
      if (meta !== this.meta) this.setMeta.run(meta);
      for (const {turn,signature,old} of changed) {
        const ordinal = old?.ordinal ?? this.turns.size;
        this.setTurn.run(turn.id, ordinal, signature);
        this.turns.set(turn.id, {ordinal,signature});
        if (!old) for (const item of turn.items || []) this.putItem(turn.id, item);
      }
    });
    this.meta = meta;
  }
  close() { this.db.close(); }
}
module.exports = { AcpHistoryStore };
