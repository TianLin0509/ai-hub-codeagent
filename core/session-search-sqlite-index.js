'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { DatabaseSync } = require('node:sqlite');
const { randomUUID } = require('node:crypto');
const { SearchCursorStore } = require('./session-search-query.js');
const { readSearchPreview } = require('./session-search-preview.js');
const { cjkAuxTokens, normalizeSearchText } = require('./session-search-index.js');
const {
  DEFAULT_MAX_CANDIDATE_SESSIONS,
  DEFAULT_MAX_QUERY_DOCS,
} = require('./session-search-config.js');

const SCHEMA_VERSION = 2;
const SHORT_TERM_SCOPES = Object.freeze(['title', 'user', 'assistant']);

function isRecoverableDatabaseError(error) {
  const text = `${error && error.code || ''} ${error && error.message || error || ''}`.toLocaleLowerCase();
  return /sqlite_corrupt|sqlite_notadb|database disk image is malformed|file is not a database|malformed database schema/.test(text);
}

function quarantineDatabase(databasePath) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const quarantined = [];
  for (const suffix of ['', '-wal', '-shm']) {
    const source = `${databasePath}${suffix}`;
    if (!fs.existsSync(source)) continue;
    const target = `${databasePath}.corrupt-${stamp}${suffix}`;
    fs.renameSync(source, target);
    quarantined.push(target);
  }
  return quarantined;
}

function quoteFtsTerm(term) {
  return `"${String(term || '').replace(/"/g, '""')}"`;
}

function rowToSession(row) {
  if (!row) return null;
  return {
    key: row.key,
    provider: row.provider,
    nativeFamily: row.native_family || null,
    kind: row.kind || null,
    title: row.title || '未命名会话',
    cwd: row.cwd || null,
    projectLabel: row.project_label || null,
    model: row.model || null,
    updatedAt: Number(row.updated_at) || 0,
    hubSessionId: row.hub_session_id || null,
    nativeSessionId: row.native_session_id || null,
    meetingId: row.meeting_id || null,
    transcriptPath: row.transcript_path || null,
    codexSessionsRoot: row.codex_sessions_root || null,
    codexProfile: row.codex_profile || null,
    turnCount: Number(row.turn_count) || 0,
  };
}

function rowToDoc(row) {
  return {
    id: row.event_id,
    eventId: row.event_id,
    scope: row.scope,
    role: row.role || null,
    speaker: row.speaker || null,
    text: row.text || '',
    normalizedText: row.normalized_text || '',
    ordinal: Number(row.ordinal) || 0,
    timestamp: Number(row.timestamp) || 0,
  };
}

class SqliteSessionSearchIndex {
  constructor(databasePath, options = {}) {
    if (!databasePath) throw new Error('databasePath is required');
    // A private temporary database preserves the :memory: lifetime contract
    // while permitting independent WAL readers for frozen search snapshots.
    this.temporaryDirectory = databasePath === ':memory:' ? fs.mkdtempSync(path.join(os.tmpdir(), 'hub-search-')) : null;
    if (this.temporaryDirectory) databasePath = path.join(this.temporaryDirectory, 'search.sqlite');
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
    this.databasePath = databasePath;
    this.maxCandidateSessions = Math.max(50, Number(options.maxCandidateSessions) || DEFAULT_MAX_CANDIDATE_SESSIONS);
    this.maxQueryDocs = Math.max(1000, Number(options.maxQueryDocs) || DEFAULT_MAX_QUERY_DOCS);
    this.db = null;
    this.statsCache = null;
    this.recoveredDatabaseFiles = [];
    try {
      this._open();
    } catch (error) {
      try { if (this.db) this.db.close(); } catch {}
      this.db = null;
      if (!isRecoverableDatabaseError(error)) throw error;
      this.recoveredDatabaseFiles = quarantineDatabase(databasePath);
      this._open();
    }
  }

  _open() {
    this.db = new DatabaseSync(this.databasePath);
    // cache_size 从 32MB 提到 128MB、并开 1GB mmap：这个库实测 1.8GB，短词查询要顺序
    // 扫 docs 表，页缓存太小时每次搜索都在重新读盘。
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA temp_store=FILE; PRAGMA cache_size=-131072; PRAGMA mmap_size=1073741824; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;');
    // WAL 从不截断（journal_size_limit 默认 -1），实测生产环境攒到 290MB，
    // 每次读都要先过一遍这么大的 WAL 索引。开库时截断一次，之后限制在 64MB。
    this.db.exec('PRAGMA journal_size_limit=67108864;');
    try { this.db.exec('PRAGMA wal_checkpoint(TRUNCATE);'); } catch { /* 别的进程占着就算了，下次再截 */ }
    this._ensureSchema();
    this._prepare();
    this.queryStore = new SearchCursorStore(this);
  }

  _ensureSchema() {
    const version = Number(this.db.prepare('PRAGMA user_version').get().user_version) || 0;
    if (version && version !== SCHEMA_VERSION) {
      this.db.exec(`
        DROP TRIGGER IF EXISTS docs_ai;
        DROP TRIGGER IF EXISTS docs_ad;
        DROP TRIGGER IF EXISTS docs_au;
        DROP TRIGGER IF EXISTS docs_cjk_ad;
        DROP TABLE IF EXISTS docs_fts;
        DROP TABLE IF EXISTS docs_cjk;
        DROP TABLE IF EXISTS docs;
        DROP TABLE IF EXISTS sessions;
        DROP TABLE IF EXISTS sources;
        DROP TABLE IF EXISTS meta;
      `);
      // 旧库的页不会自己还给磁盘：生产实测 8.5GB 里有 4.2GB 是空闲页。
      // 此刻库已经空了，VACUUM 很快，重建后的索引从一个干净的小文件开始长。
      try { this.db.exec('VACUUM;'); } catch { /* 有别的读者占着就留到下次 */ }
    }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS search_writer_lease (name TEXT PRIMARY KEY, token TEXT NOT NULL, pid INTEGER NOT NULL, acquired_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS sources (
        key TEXT PRIMARY KEY,
        signature TEXT NOT NULL,
        stale INTEGER NOT NULL DEFAULT 0,
        searchable INTEGER NOT NULL DEFAULT 1,
        updated_at INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS sessions (
        key TEXT PRIMARY KEY,
        source_key TEXT NOT NULL UNIQUE REFERENCES sources(key) ON DELETE CASCADE,
        provider TEXT NOT NULL,
        native_family TEXT,
        kind TEXT,
        title TEXT,
        cwd TEXT,
        project_label TEXT,
        model TEXT,
        updated_at INTEGER,
        hub_session_id TEXT,
        native_session_id TEXT,
        meeting_id TEXT,
        transcript_path TEXT,
        codex_sessions_root TEXT,
        codex_profile TEXT,
        turn_count INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_sessions_provider ON sessions(provider);
      CREATE INDEX IF NOT EXISTS idx_sessions_updated ON sessions(updated_at DESC);
      CREATE TABLE IF NOT EXISTS docs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source_key TEXT NOT NULL REFERENCES sources(key) ON DELETE CASCADE,
        session_key TEXT NOT NULL REFERENCES sessions(key) ON DELETE CASCADE,
        event_id TEXT NOT NULL,
        scope TEXT NOT NULL,
        role TEXT,
        speaker TEXT,
        text TEXT NOT NULL,
        normalized_text TEXT NOT NULL,
        ordinal REAL,
        timestamp INTEGER,
        UNIQUE(session_key, event_id)
      );
      CREATE INDEX IF NOT EXISTS idx_docs_source ON docs(source_key);
      CREATE INDEX IF NOT EXISTS idx_docs_session ON docs(session_key, ordinal);
      CREATE INDEX IF NOT EXISTS idx_docs_scope_time ON docs(scope, timestamp);
      CREATE INDEX IF NOT EXISTS idx_docs_session_scope_time ON docs(session_key, scope, timestamp);
      CREATE VIRTUAL TABLE IF NOT EXISTS docs_fts USING fts5(
        normalized_text,
        content='docs',
        content_rowid='id',
        tokenize='trigram'
      );
      -- 只有对话（标题/我的提问/AI 回答）进全文索引。工具 doc 只留一行元信息，
      -- 供预览、聊天记录 md 和造梦看「AI 做了什么」，不参与检索。
      CREATE TRIGGER IF NOT EXISTS docs_ai AFTER INSERT ON docs WHEN new.scope <> 'tool' BEGIN
        INSERT INTO docs_fts(rowid, normalized_text) VALUES (new.id, new.normalized_text);
      END;
      CREATE TRIGGER IF NOT EXISTS docs_ad AFTER DELETE ON docs WHEN old.scope <> 'tool' BEGIN
        INSERT INTO docs_fts(docs_fts, rowid, normalized_text) VALUES ('delete', old.id, old.normalized_text);
      END;
      CREATE TRIGGER IF NOT EXISTS docs_au AFTER UPDATE ON docs WHEN old.scope <> 'tool' OR new.scope <> 'tool' BEGIN
        INSERT INTO docs_fts(docs_fts, rowid, normalized_text) VALUES ('delete', old.id, old.normalized_text);
        INSERT INTO docs_fts(rowid, normalized_text) VALUES (new.id, new.normalized_text);
      END;
      PRAGMA user_version=${SCHEMA_VERSION};
    `);
    this._ensureCjkAuxSchema();
  }

  /**
   * CJK 短词辅助索引（2026-09-05）。
   *
   * FTS5 的 trigram 分词器至少要 3 个字符才走索引，中文最常用的 1~2 字词全部退化成
   * 顺序扫描（真实索引实测「圆桌」837ms vs 四字词 12ms）。这里另建一张 unicode61 的
   * FTS 表，只喂 CJK 的一元+二元词元，让 1~2 字中文查询变成精确词元查找。
   *
   * **刻意不升 SCHEMA_VERSION**：`_ensureSchema` 见到版本不符会 DROP 所有表，
   * 那意味着把 3GB 索引整个重建一遍。辅助索引是纯增量能力，缺了只是慢，
   * 不该拿全量重建去换。所以这里用幂等 DDL 就地补，老库平滑升级。
   *
   * 用 contentless（`content=''` + `contentless_delete=1`）：词元原文对检索毫无用处，
   * 存一份要多花 121MB（实测占辅助索引总体积的 63%）。contentless_delete 让
   * `DELETE FROM docs_cjk WHERE rowid=?` 不需要原文即可删，正好配合下面的删除触发器。
   * 需要 SQLite 3.43+，本机 3.51.2。
   *
   * 只覆盖 title/user/assistant 三档：它们只占 13% 的正文（33.8M 字符，
   * tool 独占 220M），而短词检索本来就默认只搜这三档，范围完全对齐。
   */
  _ensureCjkAuxSchema() {
    this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS docs_cjk USING fts5(
        tokens,
        content='',
        contentless_delete=1,
        tokenize='unicode61 remove_diacritics 0'
      );
      CREATE TRIGGER IF NOT EXISTS docs_cjk_ad AFTER DELETE ON docs BEGIN
        DELETE FROM docs_cjk WHERE rowid = old.id;
      END;
    `);
  }

  _prepare() {
    this.selectSourceStates = this.db.prepare('SELECT key, signature, stale FROM sources');
    this.markSourceStaleStatement = this.db.prepare('UPDATE sources SET signature = ?, stale = 1 WHERE key = ?');
    this.deleteSource = this.db.prepare('DELETE FROM sources WHERE key = ?');
    this.deleteCjkAux = this.db.prepare('DELETE FROM docs_cjk WHERE rowid = ?');
    this.insertCjkAux = this.db.prepare('INSERT INTO docs_cjk(rowid, tokens) VALUES (?, ?)');
    this.insertSource = this.db.prepare('INSERT INTO sources(key, signature, stale, searchable, updated_at) VALUES (?, ?, ?, ?, ?)');
    this.insertSession = this.db.prepare(`INSERT INTO sessions(
      key, source_key, provider, native_family, kind, title, cwd, project_label, model, updated_at,
      hub_session_id, native_session_id, meeting_id, transcript_path, codex_sessions_root, codex_profile, turn_count
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    this.insertDoc = this.db.prepare(`INSERT OR IGNORE INTO docs(
      source_key, session_key, event_id, scope, role, speaker, text, normalized_text, ordinal, timestamp
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    this.selectSession = this.db.prepare('SELECT * FROM sessions WHERE key = ?');
    this.selectSessionUpdatedAt = this.db.prepare('SELECT updated_at FROM sessions WHERE key = ?');
    this.selectDocs = this.db.prepare('SELECT * FROM docs WHERE session_key = ? ORDER BY ordinal, id');
    // scope / 时间 / 词条三个条件现在全部下推到 SQL，语句按条件形状缓存。
  }

  /**
   * 命中文档查询。原来这里只取 session_key，然后回头把**整个 session 的所有 doc**
   * （含 text 全文）捞进 JS 再逐条 includes —— 实测一次查询要物化 20000 条 / 40MB
   * 字符串，而其中真正命中的只有 0.3%~1.8%。
   *
   * 打分循环本来就只用得到「命中的那些 doc」（不命中的在 matchedTerms 为空时直接
   * continue），所以只取命中行与原实现**语义完全等价**，只是不再搬无关数据。
   */
  getSourceSignatures() {
    return new Map([...this.getSourceStates()].map(([key, state]) => [key, state.signature]));
  }

  acquireWriterLease(token=randomUUID()) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const owner=this.db.prepare("SELECT * FROM search_writer_lease WHERE name='refresh'").get();
      if(owner) {
        let alive=true;
        try {process.kill(Number(owner.pid),0);} catch(error) {if(error.code==='ESRCH') alive=false;else if(error.code!=='EPERM') throw error;}
        if(alive) {this.db.exec('ROLLBACK');return null;}
      }
      this.db.prepare("INSERT OR REPLACE INTO search_writer_lease VALUES ('refresh',?,?,?)").run(token,process.pid,Date.now());
      this.db.exec('COMMIT');return token;
    } catch(error) {this.db.exec('ROLLBACK');throw error;}
  }

  releaseWriterLease(token) {
    this.db.prepare("DELETE FROM search_writer_lease WHERE name='refresh' AND token=?").run(token);
  }

  getSourceStates() {
    return new Map(this.selectSourceStates.all().map(row => [row.key, {
      signature: row.signature,
      stale: Number(row.stale) === 1,
    }]));
  }

  markSourceStale(key, signature) {
    this.statsCache = null;
    this.markSourceStaleStatement.run(String(signature || ''), String(key || ''));
  }

  replaceSource(source) {
    this.statsCache = null;
    if (!source || !source.key) return { docs: 0, chars: 0 };
    const docs = source.searchable === false ? [] : (Array.isArray(source.docs) ? source.docs.slice() : []);
    return this.replaceSourceChunks(source, [docs]);
  }

  replaceSourceChunks(source, chunks) {
    this.statsCache = null;
    if (!source || !source.key) return { docs: 0, chars: 0 };
    const session = source.session || {};
    let documentCount = 0;
    let textChars = 0;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.deleteSource.run(source.key);
      this.insertSource.run(source.key, String(source.signature || ''), source.stale ? 1 : 0, source.searchable === false ? 0 : 1, Number(session.updatedAt) || 0);
      if (source.searchable !== false && session.key) {
        this.insertSession.run(
          session.key, source.key, session.provider || 'unknown', session.nativeFamily || null,
          session.kind || null, session.title || '未命名会话', session.cwd || null,
          session.projectLabel || null, session.model || null, Number(session.updatedAt) || 0,
          session.hubSessionId || null, session.nativeSessionId || null, session.meetingId || null,
          session.transcriptPath || null, session.codexSessionsRoot || null, session.codexProfile || null,
          Number(session.turnCount) || 0,
        );
        const insertDocument = (doc) => {
          const text = String(doc && doc.text || '');
          if (!text) return;
          const scope = doc.scope || 'assistant';
          const inserted = this.insertDoc.run(
            source.key, session.key, String(doc.eventId || doc.id || `doc-${doc.ordinal || 0}`),
            scope, doc.role || null, doc.speaker || null, text,
            // 工具 doc 不参与检索，规范化副本纯属重复存储（实测约占库的 12%）。
            scope === 'tool' ? '' : normalizeSearchText(text),
            Number(doc.ordinal) || 0, Number(doc.timestamp) || 0,
          );
          if (Number(inserted.changes) > 0) {
            documentCount += 1;
            textChars += text.length;
            this._writeCjkAux(Number(inserted.lastInsertRowid), scope, text);
          }
        };
        const insertedSyntheticTitle = !!session.title;
        if (insertedSyntheticTitle) insertDocument({
          id: 'title', eventId: 'title', scope: 'title', role: 'title',
          text: session.title, ordinal: -1, timestamp: Number(session.updatedAt) || 0,
        });
        for (const chunk of chunks || []) {
          for (const doc of (Array.isArray(chunk) ? chunk : [])) {
            if (insertedSyntheticTitle && doc && doc.scope === 'title') continue;
            insertDocument(doc);
          }
        }
      }
      this.db.exec('COMMIT');
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch {}
      throw error;
    }
    return {
      docs: documentCount,
      chars: textChars,
    };
  }

  pruneSources(activeKeys) {
    this.statsCache = null;
    this.db.exec('CREATE TEMP TABLE IF NOT EXISTS active_source_keys(key TEXT PRIMARY KEY); DELETE FROM active_source_keys;');
    const insert = this.db.prepare('INSERT OR IGNORE INTO active_source_keys(key) VALUES (?)');
    this.db.exec('BEGIN');
    try {
      for (const key of activeKeys || []) insert.run(String(key));
      this.db.exec('DELETE FROM sources WHERE key NOT IN (SELECT key FROM active_source_keys); COMMIT;');
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch {}
      throw error;
    }
  }

  setMeta(key, value) {
    this.db.prepare('INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, JSON.stringify(value));
  }

  getMeta(key, fallback = null) {
    const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key);
    if (!row) return fallback;
    try { return JSON.parse(row.value); } catch { return fallback; }
  }

  getRepresentedIds(sourceKeys) {
    // Refresh chooses the retained transcript sources before pruning. Existing
    // fallback titles must not suppress themselves or a removed transcript's
    // replacement, even though both already have a sessions row.
    const rows = this.db.prepare('SELECT source_key, hub_session_id, meeting_id FROM sessions').all()
      .filter(row => !sourceKeys || sourceKeys.has(row.source_key));
    return {
      hubIds: new Set(rows.map(row => row.hub_session_id).filter(Boolean).map(String)),
      meetingIds: new Set(rows.map(row => row.meeting_id).filter(Boolean).map(String)),
    };
  }

  getStats() {
    // search() 有 4 个返回点都调它，里面的 count(*) FROM docs 要扫 325k 行。
    // 统计值只在写索引时会变，缓存到下次写入。
    if (this.statsCache) return this.statsCache;
    const sessions = Number(this.db.prepare('SELECT count(*) AS count FROM sessions').get().count) || 0;
    const documents = Number(this.db.prepare('SELECT count(*) AS count FROM docs').get().count) || 0;
    const staleSources = Number(this.db.prepare('SELECT count(*) AS count FROM sources WHERE stale = 1').get().count) || 0;
    const providers = Object.fromEntries(this.db.prepare('SELECT provider, count(*) AS count FROM sessions GROUP BY provider').all().map(row => [row.provider, Number(row.count) || 0]));
    this.statsCache = {
      sessions, documents, terms: 0, providers, staleSources, storage: 'sqlite-fts5',
      recoveredCorruptDatabase: this.recoveredDatabaseFiles.length > 0,
    };
    return this.statsCache;
  }

  /** 取一个词条命中的 doc id（不取正文）。scopes 为 null 表示不限 scope。 */

  /**
   * 把一条 doc 的 CJK 词元写进辅助索引。只覆盖短词默认搜索的三档；
   * tool 独占 87% 的行、220M 字符，而两个字在工具入参 JSON 里命中的基本是噪声，
   * 为它建索引是拿几倍体积换噪声。
   * 先删后插保证幂等：回填与实时写入可能覆盖同一个 rowid。
   */
  _writeCjkAux(rowid, scope, text) {
    if (!Number.isInteger(rowid) || rowid <= 0) return false;
    if (!SHORT_TERM_SCOPES.includes(scope)) return false;
    const tokens = cjkAuxTokens(text);
    if (!tokens) return false;
    this.deleteCjkAux.run(rowid);
    this.insertCjkAux.run(rowid, tokens);
    return true;
  }

  /**
   * 回填历史 doc 的 CJK 辅助索引（2026-09-05）。
   *
   * 设计成「可续跑 + 有时间预算」：子进程是单线程的，一次性回填 10 万行会把搜索
   * 卡住几十秒。每次只花 budgetMs，游标存进 meta，下次接着跑。
   * 回填**没跑完之前查询一律不用辅助索引** —— 用了就会漏（假阴性比慢严重得多）。
   *
   * 返回 { done, processed, cursor }。
   */
  backfillCjkAux({ budgetMs = 400, batchSize = 500 } = {}) {
    if (this.getMeta('cjkAuxReady', '') === '1') return { done: true, processed: 0, cursor: null };
    const startedAt = Date.now();
    let cursor = Number(this.getMeta('cjkAuxCursor', 0)) || 0;
    let processed = 0;
    const scopePlaceholders = SHORT_TERM_SCOPES.map(() => '?').join(',');
    const select = this.db.prepare(
      `SELECT id, scope, text FROM docs NOT INDEXED WHERE id > ? AND scope IN (${scopePlaceholders}) ORDER BY id LIMIT ?`,
    );
    for (;;) {
      const rows = select.all(cursor, ...SHORT_TERM_SCOPES, batchSize);
      if (!rows.length) {
        this.setMeta('cjkAuxReady', '1');
        this.setMeta('cjkAuxCursor', String(cursor));
        this.statsCache = null;
        return { done: true, processed, cursor };
      }
      this.db.exec('BEGIN IMMEDIATE');
      try {
        for (const row of rows) {
          this._writeCjkAux(Number(row.id), row.scope, row.text || '');
          cursor = Number(row.id);
          processed += 1;
        }
        this.setMeta('cjkAuxCursor', String(cursor));
        this.db.exec('COMMIT');
      } catch (error) {
        try { this.db.exec('ROLLBACK'); } catch {}
        throw error;
      }
      if (Date.now() - startedAt >= budgetMs) break;
    }
    this.statsCache = null;
    return { done: false, processed, cursor };
  }

  cjkAuxReady() {
    return this.getMeta('cjkAuxReady', '') === '1';
  }

  /**
   * 用 CJK 辅助索引取候选。仅在回填完成后调用 —— 否则会漏。
   * 与 trigram 分支一样，scope/时间只放进投影由 JS 过滤：
   * 放进 WHERE 会让查询规划器改用 idx_docs_scope_time 驱动，LIMIT 失去短路能力。
   */
  prewarmShortTermScopes() {
    try {
      const placeholders = SHORT_TERM_SCOPES.map(() => '?').join(',');
      this.db.prepare(
        `SELECT count(*) AS c, sum(length(normalized_text)) AS b FROM docs WHERE scope IN (${placeholders})`,
      ).get(...SHORT_TERM_SCOPES);
      return true;
    } catch {
      return false;
    }
  }

  search(request = {}) {
    return this.queryStore.search(request);
  }

  preview(request = {}) {
    return readSearchPreview(this, request);
  }

  close() {
    this.queryStore?.close();
    if (!this.db) return;
    try { this.db.close(); } finally { this.db = null; }
    if (this.temporaryDirectory) {
      for (const suffix of ['', '-wal', '-shm']) fs.rmSync(this.databasePath + suffix, { force: true });
      fs.rmdirSync(this.temporaryDirectory);
      this.temporaryDirectory = null;
    }
  }
}

module.exports = {
  SqliteSessionSearchIndex,
  isRecoverableDatabaseError,
  quarantineDatabase,
  quoteFtsTerm,
  rowToDoc,
  rowToSession,
};
