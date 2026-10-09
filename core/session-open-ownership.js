'use strict';

// One local Hub owns an open session. No subscribers, heartbeat or handoff.
// The database is shared by Hub instances using the same session library.
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { DatabaseSync } = require('node:sqlite');
const { getHubDataDir } = require('./data-dir');

function openOwnershipDatabase(filename) {
  // Concurrent first opens can return SQLITE_BUSY immediately while changing
  // journal mode, even with busy_timeout set. Retry only this idempotent setup;
  // ownership transactions must still fail normally when their lock is busy.
  let deadline;
  const pause = new Int32Array(new SharedArrayBuffer(4));
  for (;;) {
    let db;
    try {
      db = new DatabaseSync(filename);
      // Fail setup locks promptly so a losing opener releases its connection;
      // waiting here can prevent the winning opener from completing setup.
      db.exec('PRAGMA busy_timeout=0');
      db.exec('PRAGMA journal_mode=WAL');
      db.exec('BEGIN IMMEDIATE');
      db.exec('CREATE TABLE IF NOT EXISTS open_owners (key TEXT PRIMARY KEY, session TEXT NOT NULL, pid INTEGER NOT NULL, version TEXT, nonce TEXT NOT NULL, server_pid INTEGER, observed_at INTEGER)');
      if (!db.prepare('PRAGMA table_info(open_owners)').all().some(c=>c.name==='observed_at')) db.exec('ALTER TABLE open_owners ADD COLUMN observed_at INTEGER');
      db.exec('COMMIT');
      db.exec('PRAGMA busy_timeout=1000');
      return db;
    }
    catch (error) {
      // Close also rolls back incomplete setup and releases the old journal
      // mode's locks before another initializer can finish switching to WAL.
      try { db?.close(); } catch (closeError) { error.closeError = closeError; throw error; }
      if (error.code !== 'ERR_SQLITE_ERROR' || (error.errcode & 255) !== 5) throw error;
      // 1 秒在机器满载时不够：32 路并发压测里 11/32 次初始化报 database is locked
      // （2026-09-26，合并闸门也因此失败过）。每次尝试都立即失败并释放连接，放宽窗口不会造成
      // 互等；正常情况下几毫秒内就会完成。
      deadline ??= performance.now() + 3000;
      if (performance.now() >= deadline) throw error;
      Atomics.wait(pause, 0, 0, 10);
    }
  }
}

function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === 'ESRCH') return false; if (error.code === 'EPERM') return true; throw error; }
}
function occupied(owner) {
  const message = `此会话已在 AI HUB（PID ${owner.pid}${owner.version ? '，v' + owner.version : ''}）打开，请去该 AI HUB 操作。关闭原会话或退出原 Hub 后，可在这里恢复。`;
  return Object.assign(new Error(message), { code:'SESSION_OCCUPIED', owner });
}
class SessionOpenOwnership {
  constructor({directory = getHubDataDir(), pid = process.pid, version = require('../package.json').version, isAlive = alive} = {}) {
    fs.mkdirSync(directory, {recursive:true});
    this.db = openOwnershipDatabase(path.join(directory, 'session-open-owners.sqlite'));
    this.pid = pid; this.version = version; this.isAlive = isAlive;
  }
  live(row, verify = false) {
    if(!row)return false;
    const check = verify && this.isAlive === alive ? pid=>require('./owned-process').matches(pid,row.observed_at) : this.isAlive;
    return check(row.pid) || check(row.server_pid);
  }
  owner(sessionId, verify = false) {
    const row = this.db.prepare('SELECT * FROM open_owners WHERE key=?').get('hub:' + sessionId);
    return this.live(row,verify) ? row : null;
  }
  claim(sessionId, keys = []) {
    if(typeof sessionId!=='string' || !/^[a-zA-Z0-9_-]{1,200}$/.test(sessionId))throw Error('会话 ID 无效');
    const lease = {sessionId, nonce:randomUUID()};
    this.add(lease, ['hub:' + sessionId, ...keys]);
    return lease;
  }
  add(lease, keys) {
    const pending=[...new Set(keys)].filter(key=>!lease.keys?.has(key));
    if(!pending.length)return;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const key of pending) {
        const old = this.db.prepare('SELECT * FROM open_owners WHERE key=?').get(key);
        if (old?.nonce === lease.nonce) continue;
        if (this.live(old,true)) throw occupied(old);
        this.db.prepare('INSERT OR REPLACE INTO open_owners VALUES (?,?,?,?,?,NULL,?)').run(key, lease.sessionId, this.pid, this.version, lease.nonce, Date.now());
      }
      this.db.exec('COMMIT');
      lease.keys ||= new Set();for(const key of pending)lease.keys.add(key);
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  bindPid(lease, pid) {
    if (Number.isInteger(pid) && pid > 0 && lease.serverPid!==pid) {
      this.db.prepare('UPDATE open_owners SET server_pid=?, observed_at=? WHERE nonce=?').run(pid, Date.now(), lease.nonce);
      lease.serverPid=pid;
    }
  }
  editClosed(sessionId, edit) {
    return this.editSessions([sessionId], edit);
  }
  editSessions(sessionIds, edit, { allowOwn = false } = {}) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const sessionId of sessionIds) {
        const owner=this.owner(sessionId);
        if(owner && !(allowOwn && owner.pid === this.pid))throw occupied(owner);
      }
      const result=edit();
      this.db.exec('COMMIT');return result;
    } catch(error) {this.db.exec('ROLLBACK');throw error;}
  }
  release(lease) { if (lease) this.db.prepare('DELETE FROM open_owners WHERE nonce=?').run(lease.nonce); }
  close() { this.db.close(); }
}
function nativeKeys(kind, opts, env = process.env) {
  const home = value => path.resolve(value).toLowerCase();
  const os = require('os');
  const keys = [];
  if (opts.codexSid && !opts.codexForkSid) keys.push('codex:' + home(opts.codexHistoryHome || (opts.codexSessionsRoot && path.dirname(opts.codexSessionsRoot)) || env.CODEX_HOME || path.join(os.homedir(), '.codex')) + ':' + opts.codexSid);
  if (opts.resumeCCSessionId && !opts.forkCCSessionId) keys.push('claude:' + home(env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')) + ':' + opts.resumeCCSessionId);
  for (const field of ['acpSid','kimiSid','geminiChatId']) if (opts[field]) keys.push(kind.replace(/-resume$/, '') + ':' + field + ':' + opts[field]);
  return keys;
}
module.exports = {SessionOpenOwnership, nativeKeys, occupied, alive};
