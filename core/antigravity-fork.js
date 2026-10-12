'use strict';
// Native branch for Antigravity conversations. agy 1.3.3 has no fork command,
// but a conversation is self-contained: conversations/<id>.db, brain/<id>/ and
// annotations/<id>.pbtxt. A snapshot copy with both UUIDs (conversation and
// trajectory) replaced byte-for-byte resumes under `agy --conversation <new>`
// with the full history (verified 2026-10-12 against the live CLI). UUIDs keep
// their length, so protobuf blobs stay valid. The source is only read.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const {UUID, configRoot} = require('./antigravity-config');

function replaceAll(value, pairs) {
  if (value instanceof Uint8Array) {
    let buf = Buffer.from(value);
    for (const [from, to] of pairs) {
      const a = Buffer.from(from), b = Buffer.from(to);
      for (let i = buf.indexOf(a); i >= 0; i = buf.indexOf(a, i + b.length)) b.copy(buf, i);
    }
    return buf;
  }
  if (typeof value === 'string') return pairs.reduce((text, [from, to]) => text.split(from).join(to), value);
  return value;
}

function sameBytes(a, b) {
  if (a instanceof Uint8Array && b instanceof Uint8Array) return Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0;
  return a === b;
}

function rewriteDatabase(file, pairs) {
  const {DatabaseSync} = require('node:sqlite');
  const db = new DatabaseSync(file);
  try {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map(r => r.name);
    db.exec('BEGIN');
    for (const table of tables) {
      const quoted = '"' + table.replace(/"/g, '""') + '"';
      const columns = db.prepare(`PRAGMA table_info(${quoted})`).all().map(c => c.name);
      if (!columns.length) continue;
      const update = db.prepare(`UPDATE ${quoted} SET ${columns.map(c => '"' + c.replace(/"/g, '""') + '"=?').join(',')} WHERE rowid=?`);
      for (const row of db.prepare(`SELECT rowid AS __rowid, * FROM ${quoted}`).all()) {
        const next = columns.map(c => replaceAll(row[c], pairs));
        if (next.some((v, i) => !sameBytes(v, row[columns[i]]))) update.run(...next, row.__rowid);
      }
    }
    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch {}
    throw error;
  } finally { db.close(); }
}

const REWRITE_LIMIT_BYTES = 8 * 1024 * 1024;

function copyTreeRewriting(from, to, pairs) {
  fs.mkdirSync(to, {recursive: true});
  for (const entry of fs.readdirSync(from, {withFileTypes: true})) {
    const src = path.join(from, entry.name), dst = path.join(to, replaceAll(entry.name, pairs));
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) copyTreeRewriting(src, dst, pairs);
    // Ids live in small transcript/protobuf files; big artifacts (screenshots,
    // recordings) are copied as-is so the synchronous clone stays fast.
    else if (fs.statSync(src).size > REWRITE_LIMIT_BYTES) fs.copyFileSync(src, dst);
    else fs.writeFileSync(dst, replaceAll(fs.readFileSync(src), pairs));
  }
}

/** Clone conversation `sourceId`; returns the new conversation id. */
function forkConversation(sourceId, {env = process.env, newId = crypto.randomUUID()} = {}) {
  if (!UUID.test(sourceId || '') || !UUID.test(newId)) throw new Error('Antigravity conversation ID 无效');
  const root = configRoot(env);
  const sourceDb = path.join(root, 'conversations', sourceId + '.db');
  if (!fs.existsSync(sourceDb)) throw new Error('找不到 Antigravity 原生会话记录，无法创建分支');
  const targetDb = path.join(root, 'conversations', newId + '.db');
  const targetBrain = path.join(root, 'brain', newId);
  if (fs.existsSync(targetDb) || fs.existsSync(targetBrain)) throw new Error('分支会话 ID 已存在');
  const {DatabaseSync} = require('node:sqlite');
  const created = [];
  const dispose = () => { for (const file of created.slice().reverse()) { try { fs.rmSync(file, {recursive: true, force: true}); } catch {} } };
  try {
    // VACUUM INTO is a consistent snapshot even while agy holds the source open.
    const source = new DatabaseSync(sourceDb, {readOnly: true});
    try { source.prepare('VACUUM INTO ?').run(targetDb); } finally { source.close(); }
    created.push(targetDb);
    const meta = new DatabaseSync(targetDb, {readOnly: true});
    let trajectory;
    try { trajectory = meta.prepare('SELECT trajectory_id FROM trajectory_meta').get()?.trajectory_id; } finally { meta.close(); }
    const pairs = [[sourceId, newId]];
    if (UUID.test(trajectory || '')) pairs.push([trajectory, crypto.randomUUID()]);
    rewriteDatabase(targetDb, pairs);
    const sourceBrain = path.join(root, 'brain', sourceId);
    if (fs.existsSync(sourceBrain)) { created.push(targetBrain); copyTreeRewriting(sourceBrain, targetBrain, pairs); }
    const annotation = path.join(root, 'annotations', sourceId + '.pbtxt');
    if (fs.existsSync(annotation)) {
      const target = path.join(root, 'annotations', newId + '.pbtxt');
      created.push(target);
      fs.writeFileSync(target, replaceAll(fs.readFileSync(annotation), pairs));
    }
    return {conversationId: newId, transcriptPath: path.join(targetBrain, '.system_generated', 'logs', 'transcript.jsonl'), dispose};
  } catch (error) {
    dispose();
    throw error;
  }
}

module.exports = {forkConversation, replaceAll};
