const fs = require('fs');
const path = require('path');
const { getHubDataDir } = require('./data-dir');
const { acquireLock, acquireLockAsync, releaseLock, releaseLockAsync } = require('./file-lock');
const { migrateLegacyBranchSessionMeta } = require('./session-title-guards');
const { healPersistedBranchSessionTitles } = require('./branch-session-titles');

const STATE_DIR = getHubDataDir();
const STATE_FILE = path.join(STATE_DIR, 'state.json');
const LOCK_FILE = STATE_FILE + '.lock';
const CURRENT_VERSION = 1;

// 2026-05-07 maintainer — 多 Hub 并发安全：
//   - 旧版 save() 是 last-writer-wins 全量覆盖，多 Hub 共享同一份 ~/.ai-hub-community
//     时会互相吞 session/AI 群聊；这版改为 acquireLock + read-merge-write。
//   - 每条 session/meeting 加 updatedAt（毫秒），merge 时 LWW 仲裁。
//   - 删除靠显式 _removedSessionIds/_removedMeetingIds set（main.js 持续 push），
//     不依赖"内存里没有 = 已删除"，避免某 Hub 启动时把别 Hub 的进展抹掉。
//   - 锁拿不到时拒绝无锁直写；Windows 原子替换的瞬时 EPERM 则在持锁期内有界重试。

const _removedSessionIds = new Set();
const { preserveLatestInteraction } = require('./session-recency');
const _removedMeetingIds = new Set();

function markRemovedSession(hubId) { if (hubId) _removedSessionIds.add(hubId); }
function markRemovedMeeting(meetingId) { if (meetingId) _removedMeetingIds.add(meetingId); }
// 2026-05-07 多方审查 fix：暴露 isMarked* 给 session-store/meeting-store 的 markDirty
//   做防御。renderer schedulePersist 是 400ms 防抖的，close-meeting 同步标记 removed
//   后，紧随其后的 persist-sessions IPC 可能仍带着已删 hubId（renderer 的 sessions
//   Map 还没收到 session-closed 事件就 send 了），main.js 会调 markDirty(sid, ...)，
//   把刚删的 per-session JSON 又写回来。markDirty 检查这个集合，跳过即可。
//   注意：drain 时清空 set，所以这道防御只在 save 周期内有效；正常 save 完成后，
//   下一轮 persist-sessions 已经 diff 出 sid → 走 removed 路径，文件再次被删。
function isMarkedRemovedSession(hubId) { return _removedSessionIds.has(hubId); }
function isMarkedRemovedMeeting(meetingId) { return _removedMeetingIds.has(meetingId); }
function _drainRemoved() {
  const s = [..._removedSessionIds];
  const m = [..._removedMeetingIds];
  _removedSessionIds.clear();
  _removedMeetingIds.clear();
  return { sessions: s, meetings: m };
}

function defaultState() {
  return {
    version: CURRENT_VERSION,
    cleanShutdown: true,
    sessions: [],
    meetings: [],
    immersiveByMeeting: {},
  };
}

function _readDiskState() {
  try {
    const raw = fs.readFileSync(STATE_FILE, 'utf-8');
    const parsed = JSON.parse(raw);
    if (parsed.version !== CURRENT_VERSION) {
      try { fs.copyFileSync(STATE_FILE, STATE_FILE + '.old'); } catch {}
      return defaultState();
    }
    return _normalizeState(parsed);
  } catch {
    return defaultState();
  }
}

async function _readDiskStateAsync() {
  try {
    const raw = await fs.promises.readFile(STATE_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed.version !== CURRENT_VERSION) {
      try { await fs.promises.copyFile(STATE_FILE, STATE_FILE + '.old'); } catch {}
      return defaultState();
    }
    return _normalizeState(parsed);
  } catch {
    return defaultState();
  }
}

function _normalizeState(parsed) {
  if (!Array.isArray(parsed.sessions)) parsed.sessions = [];
  parsed.sessions = parsed.sessions.map((session) => {
    const s = migrateLegacyBranchSessionMeta(session);
    if (!s || typeof s !== 'object') return s;
    if (s.codexSid === undefined) s.codexSid = null;
    if (s.codexProfile === undefined) s.codexProfile = null;
    if (s.codexProfileLabel === undefined) s.codexProfileLabel = null;
    if (s.geminiChatId === undefined) s.geminiChatId = null;
    if (s.geminiProjectHash === undefined) s.geminiProjectHash = null;
    if (s.geminiProjectRoot === undefined) s.geminiProjectRoot = null;
    if (s.kimiSid === undefined) s.kimiSid = null;
    if (s.kimiSessionDir === undefined) s.kimiSessionDir = null;
    if (typeof s.updatedAt !== 'number') s.updatedAt = 0;  // 老条目视为最古老
    return s;
  });
  if (!Array.isArray(parsed.meetings)) parsed.meetings = [];
  for (const m of parsed.meetings) {
    if (typeof m.updatedAt !== 'number') m.updatedAt = 0;
  }
  if (!parsed.immersiveByMeeting || typeof parsed.immersiveByMeeting !== 'object') parsed.immersiveByMeeting = {};
  return parsed;
}

function load() {
  return _readDiskState();
}

// loadAndSelfHeal — boot path
//   1. read state.json
//   2. scan sessions/<id>.json  → restore orphans missing from state.sessions
//   3. scan meetings/<id>.json  → restore orphans missing from state.meetings (v2 only)
//   4. write back the healed state (cleanShutdown=false, sync)
//   返回 healed state.
function loadAndSelfHeal({ sessionStore, meetingStore, canEditSession = () => true } = {}) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const fd = acquireLock(LOCK_FILE, { retries: 300, retryDelayMs: 10 });
  // 2026-05-07 多方审查 fix：原版即使 fd==null 仍 read+merge+write，
  //   两 Hub 同时 boot 时第二个会盖掉第一个还没完成的写。
  // 改为：拿不到锁时只读不写，返回当前盘上 state（仍执行 self-heal 合并扫描，
  //   但不写回磁盘）。下次正常 save 路径会自然把内存合并落盘。
  const haveLock = fd != null;
  try {
    const disk = _readDiskState();
    // 2026-05-07 maintainer：保留盘上原始 cleanShutdown，让 main.js 看到 reboot 是不是
    //   优雅退出。下方 disk.cleanShutdown=false 会立即翻 flag，不能影响这个值。
    const originalCleanShutdown = !!disk.cleanShutdown;

    // session orphans — listSessionFilesWithData 内部已 try/catch（损坏 JSON skip）；
    //   再外层裹一道防御，万一目录权限错也不让 boot 死掉。
    if (sessionStore && typeof sessionStore.listSessionFilesWithData === 'function') {
      try {
        const onDisk = new Set(disk.sessions.map(s => s.hubId));
        const fromFiles = sessionStore.listSessionFilesWithData();
        for (const data of fromFiles) {
          if (!data || !data.hubId) continue;
          if (onDisk.has(data.hubId)) {
            const i = disk.sessions.findIndex(s => s.hubId === data.hubId);
            if (i >= 0) {
              const prior = disk.sessions[i];
              const winner = (data.updatedAt || 0) > (prior.updatedAt || 0) ? { ...prior, ...data } : prior;
              disk.sessions[i] = preserveLatestInteraction(winner, prior, data);
            }
          } else {
            disk.sessions.push({ ...data });
          }
        }
      } catch (e) {
        console.warn('[hub] session-store self-heal scan failed:', e.message);
      }
    }

    let meetingBackups = [];
    // meeting orphans
    if (meetingStore && typeof meetingStore.listMeetingFilesWithData === 'function') {
      try {
        const onDisk = new Set(disk.meetings.map(m => m.id));
        const fromFiles = meetingStore.listMeetingFilesWithData();
        meetingBackups = fromFiles;
        for (const data of fromFiles) {
          if (!data || !data.id) continue;
          if (onDisk.has(data.id)) {
            const i = disk.meetings.findIndex(m => m.id === data.id);
            if (i >= 0 && (data.updatedAt || 0) > (disk.meetings[i].updatedAt || 0)) {
              // v2 文件版字段更全（含 title/scene/createdAt/...），覆盖式合并
              disk.meetings[i] = { ...disk.meetings[i], ...data };
            }
          } else if ((data.schemaVersion || 0) >= 2) {
            // v2 文件包含完整字段，可单独还原
            disk.meetings.push({ ...data });
          }
          // v1 only 文件无 state.json 条目 → 字段不全，跳过避免画残缺侧边栏
        }
      } catch (e) {
        console.warn('[hub] meeting-store self-heal scan failed:', e.message);
      }
    }

    // Older builds deleted group members on unexpected CLI exit. An intact
    // roster backup plus exact native identities can restore the empty room.
    if (haveLock && sessionStore && meetingStore) {
      const repairs = require('./meeting-member-recovery').recoverEmptyMeetingMembers(disk, meetingBackups, { canEditSession });
      for (const repair of repairs) {
        for (const member of repair.members) sessionStore.saveSessionFile(member.hubId, member);
      }
    }

    // Old fork handlers persisted only "Codex 2 · 分支" and did not retain the
    // Hub parent id. Codex's own session_meta still carries forked_from_id, so
    // recover the parent and use its real title (or the owning meeting title)
    // before state.json and per-session JSON are written back.
    const healedBranches = healPersistedBranchSessionTitles(disk, {
      canEditSession,
      sessionStore: haveLock ? sessionStore : null,
      logger: console,
    });
    if (healedBranches.length > 0) {
      console.log(`[branch-title] healed ${healedBranches.length} persisted branch title(s)`);
    }

    disk.cleanShutdown = false;
    if (haveLock) {
      // 只在拿到锁的情况下写盘，避免与并发 boot 的 Hub 互踩
      _writeMergedToDisk(disk);
    } else {
      console.warn('[hub] loadAndSelfHeal: lock unavailable, returning in-memory heal without disk write');
    }
    // 返回时 cleanShutdown 字段已被翻成 false（运行中状态），但我们额外暴露
    //   bootWasCleanShutdown 给调用方判断"上次是不是优雅退出"。
    disk.bootWasCleanShutdown = originalCleanShutdown;
    return disk;
  } finally {
    if (fd != null) releaseLock(fd, LOCK_FILE);
  }
}

function mergeState(diskState, memState, removed = { sessions: [], meetings: [] }) {
  const sessByHubId = new Map();
  for (const raw of diskState.sessions || []) {
    const s = migrateLegacyBranchSessionMeta(raw);
    if (s && s.hubId) sessByHubId.set(s.hubId, s);
  }
  for (const raw of memState.sessions || []) {
    const s = migrateLegacyBranchSessionMeta(raw);
    if (!s || !s.hubId) continue;
    const existing = sessByHubId.get(s.hubId);
    const winner = !existing || (s.updatedAt || 0) >= (existing.updatedAt || 0) ? s : existing;
    sessByHubId.set(s.hubId, preserveLatestInteraction(winner, existing, s));
  }
  for (const id of removed.sessions || []) sessByHubId.delete(id);

  const meetByMtgId = new Map();
  for (const m of diskState.meetings || []) meetByMtgId.set(m.id, m);
  for (const m of memState.meetings || []) {
    if (!m || !m.id) continue;
    const existing = meetByMtgId.get(m.id);
    if (!existing || (m.updatedAt || 0) >= (existing.updatedAt || 0)) {
      meetByMtgId.set(m.id, m);
    }
  }
  for (const id of removed.meetings || []) meetByMtgId.delete(id);

  return {
    version: CURRENT_VERSION,
    cleanShutdown: !!memState.cleanShutdown,
    sessions: [...sessByHubId.values()],
    meetings: [...meetByMtgId.values()],
    immersiveByMeeting: { ...(diskState.immersiveByMeeting || {}), ...(memState.immersiveByMeeting || {}) },
  };
}

// state.json carries every session the Hub has ever kept (1400+ in real use,
// ~5 MB indented) and is rewritten every couple of seconds while agents run.
// Indentation doubled the stringify cost on Main's thread (52 ms -> 17 ms
// compact on real data) and nothing reads the file by eye.
function _serializeState(state) {
  return JSON.stringify(state);
}

// What this process last wrote, keyed by the file identity it produced. While
// no other Hub has replaced the file since, the next save merges against this
// instead of reading and parsing the whole file again on Main's thread.
let _diskCache = null;

async function _statDiskAsync() {
  try {
    const stat = await fs.promises.stat(STATE_FILE);
    return { mtimeMs: stat.mtimeMs, size: stat.size, ino: stat.ino };
  } catch {
    return null;
  }
}

function _sameDiskIdentity(left, right) {
  return !!left && !!right
    && left.mtimeMs === right.mtimeMs && left.size === right.size && left.ino === right.ino;
}

function _writeMergedToDisk(state) {
  _diskCache = null;
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const tmp = `${STATE_FILE}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
  try {
    fs.writeFileSync(tmp, _serializeState(state));
    _renameWithRetrySync(tmp, STATE_FILE);
  } finally {
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch {}
  }
}

async function _writeMergedToDiskAsync(state) {
  await fs.promises.mkdir(STATE_DIR, { recursive: true });
  const tmp = `${STATE_FILE}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
  try {
    await fs.promises.writeFile(tmp, _serializeState(state));
    await _renameWithRetryAsync(tmp, STATE_FILE);
  } finally {
    try { await fs.promises.unlink(tmp); } catch {}
  }
}

const TRANSIENT_RENAME_CODES = new Set(['EACCES', 'EBUSY', 'EPERM']);
const RENAME_RETRIES = 80;
const RENAME_RETRY_DELAY_MS = 15;
const _renameSleepCell = new Int32Array(new SharedArrayBuffer(4));

function _isTransientRenameError(error) {
  return !!error && TRANSIENT_RENAME_CODES.has(error.code);
}

function _renameWithRetrySync(source, target, options = {}) {
  const rename = options.rename || fs.renameSync;
  const retries = Number.isInteger(options.retries) ? Math.max(0, options.retries) : RENAME_RETRIES;
  const retryDelayMs = Number.isFinite(options.retryDelayMs)
    ? Math.max(0, options.retryDelayMs)
    : RENAME_RETRY_DELAY_MS;
  const sleep = options.sleep || (ms => { if (ms > 0) Atomics.wait(_renameSleepCell, 0, 0, ms); });
  for (let attempt = 0; ; attempt += 1) {
    try {
      rename(source, target);
      return attempt;
    } catch (error) {
      if (!_isTransientRenameError(error) || attempt >= retries) throw error;
      sleep(retryDelayMs);
    }
  }
}

async function _renameWithRetryAsync(source, target, options = {}) {
  const rename = options.rename || fs.promises.rename.bind(fs.promises);
  const retries = Number.isInteger(options.retries) ? Math.max(0, options.retries) : RENAME_RETRIES;
  const retryDelayMs = Number.isFinite(options.retryDelayMs)
    ? Math.max(0, options.retryDelayMs)
    : RENAME_RETRY_DELAY_MS;
  const sleep = options.sleep || (ms => new Promise(resolve => setTimeout(resolve, ms)));
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(source, target);
      return attempt;
    } catch (error) {
      if (!_isTransientRenameError(error) || attempt >= retries) throw error;
      await sleep(retryDelayMs);
    }
  }
}

function _stampUpdatedAt(state) {
  const now = Date.now();
  if (Array.isArray(state.sessions)) {
    for (const s of state.sessions) if (typeof s.updatedAt !== 'number') s.updatedAt = now;
  }
  if (Array.isArray(state.meetings)) {
    for (const m of state.meetings) if (typeof m.updatedAt !== 'number') m.updatedAt = now;
  }
}

function _saveImpl(state) {
  _stampUpdatedAt(state);

  // Reserved for boot/final shutdown and tests. It may wait longer than a
  // normal async save, but it must never write without mutual exclusion.
  const fd = acquireLock(LOCK_FILE, { retries: 1200, retryDelayMs: 10 });
  if (fd == null) {
    console.warn('[hub] state save skipped: lock unavailable; refusing unsafe no-lock write');
    return;
  }

  try {
    const disk = _readDiskState();
    const removed = _drainRemoved();
    const merged = mergeState(disk, state, removed);
    _writeMergedToDisk(merged);
  } catch (e) {
    console.warn('[hub] state save failed:', e.message);
  } finally {
    releaseLock(fd, LOCK_FILE);
  }
}

async function _saveImplAsync(state, { strict = false } = {}) {
  if (!state) return;
  _stampUpdatedAt(state);
  const handle = await acquireLockAsync(LOCK_FILE, { retries: 1200, retryDelayMs: 10 });
  if (!handle) {
    if (strict) throw new Error('state.json 保存锁不可用');
    console.warn('[hub] async state save skipped: lock unavailable; refusing unsafe no-lock write');
    return;
  }
  try {
    const cached = _diskCache;
    _diskCache = null;
    const disk = cached && _sameDiskIdentity(cached.identity, await _statDiskAsync())
      ? cached.state
      : await _readDiskStateAsync();
    const merged = mergeState(disk, state, _drainRemoved());
    await _writeMergedToDiskAsync(merged);
    // Still under the lock, so this identity is the file we just renamed in.
    const identity = await _statDiskAsync();
    if (identity) _diskCache = { identity, state: merged };
  } catch (error) {
    if (strict) throw error;
    console.warn('[hub] async state save failed:', error.message);
  } finally {
    await releaseLockAsync(handle, LOCK_FILE);
  }
}

// A save lands SAVE_DELAY_MS after the first change of a burst, then at most
// once per SAVE_MIN_INTERVAL_MS. Running agents change session metadata every
// second or so; a plain debounce either never fired under that stream or, at
// 500 ms, rewrote the whole file on nearly every change. Each timer always
// writes the newest pending state, and flushPending() bypasses the wait.
const SAVE_DELAY_MS = 500;
const SAVE_MIN_INTERVAL_MS = 2000;
let saveDebounceTimer = null;
let _lastSaveStartedAt = 0;
let _pendingState = null;
let _saveQueue = Promise.resolve();

function _enqueueSave(state) {
  _saveQueue = _saveQueue
    .then(() => _saveImplAsync(state))
    .catch((error) => console.warn('[hub] async state save queue failed:', error.message));
  return _saveQueue;
}

function save(state, { sync = false } = {}) {
  _pendingState = state;
  if (sync) {
    if (saveDebounceTimer) { clearTimeout(saveDebounceTimer); saveDebounceTimer = null; }
    _saveImpl(_pendingState);
    _pendingState = null;
    return;
  }
  if (saveDebounceTimer) return;
  const delay = Math.max(SAVE_DELAY_MS, _lastSaveStartedAt + SAVE_MIN_INTERVAL_MS - Date.now());
  saveDebounceTimer = setTimeout(() => {
    const s = _pendingState;
    _pendingState = null;
    saveDebounceTimer = null;
    _lastSaveStartedAt = Date.now();
    _enqueueSave(s);
  }, delay);
}

async function flushPending() {
  if (saveDebounceTimer) {
    clearTimeout(saveDebounceTimer);
    saveDebounceTimer = null;
    const state = _pendingState;
    _pendingState = null;
    if (state) _enqueueSave(state);
  }
  await _saveQueue;
}

module.exports = {
  load,
  loadAndSelfHeal,
  save,
  flushPending,
  saveForRestart: async state => { await flushPending(); await _saveImplAsync(state, { strict: true }); },
  mergeState,
  markRemovedSession,
  markRemovedMeeting,
  isMarkedRemovedSession,
  isMarkedRemovedMeeting,
  STATE_FILE,
  LOCK_FILE,
  CURRENT_VERSION,
  _private: {
    _isTransientRenameError,
    _renameWithRetryAsync,
    _renameWithRetrySync,
  },
};
