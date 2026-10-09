// core/meeting-store.js
const fs = require('fs');
const path = require('path');
const { getHubDataDir } = require('./data-dir');
// 2026-05-07 多方审查 fix：见 session-store 同款注释——markDirty 检查 removed 集合
//   防 renderer 防抖窗口复活已删 meeting。
let _stateStore = null;
function _getStateStore() {
  if (_stateStore !== null) return _stateStore;
  try { _stateStore = require('./state-store'); }
  catch { _stateStore = null; }
  return _stateStore;
}
function _isMeetingRemoved(meetingId) {
  const ss = _getStateStore();
  return !!(ss && typeof ss.isMarkedRemovedMeeting === 'function' && ss.isMarkedRemovedMeeting(meetingId));
}

// 2026-05-07 maintainer — schemaVersion 1→2：补全 title/scene/createdAt/subSessions/...
//   字段，让 per-meeting JSON 成为完整权威备份。即使 state.json 损坏或被外部 Hub
//   覆盖，下次 boot 也能从 meetings/<id>.json 单独恢复整间 AI 群聊。
//   loadMeetingFile 同时支持 v1（部分字段）与 v2（完整字段），调用方按 schemaVersion
//   决定是否需要再去 state.json 取兜底。
const SCHEMA_VERSION = 2;
const DEBOUNCE_MS = 5000;

function meetingsDir() {
  return path.join(getHubDataDir(), 'meetings');
}

function ensureDir() {
  fs.mkdirSync(meetingsDir(), { recursive: true });
}

function meetingFilePath(id) {
  return path.join(meetingsDir(), `${id}.json`);
}

function _buildMeetingPayload(id, data) {
  const now = Date.now();
  return {
    schemaVersion: SCHEMA_VERSION,
    id,
    // ── timeline + cursors（v1 已有） ──
    _timeline: Array.isArray(data._timeline) ? data._timeline : [],
    _cursors: data._cursors && typeof data._cursors === 'object' ? data._cursors : {},
    _nextIdx: typeof data._nextIdx === 'number' ? data._nextIdx : 0,
    slotSpecs: Array.isArray(data.slotSpecs) ? data.slotSpecs : null,
    mode: ['pilot', 'free'].includes(data.mode) ? data.mode : 'free',
    participants: Array.isArray(data.participants) ? data.participants : null,
    groupChat: !!data.groupChat,
    groupMode: typeof data.groupMode === 'string' ? data.groupMode : 'deliberation',
    groupRecentRawN: Number.isInteger(data.groupRecentRawN) ? data.groupRecentRawN : 5,
    workspace: typeof data.workspace === 'string' ? data.workspace : null,
    workspaceLabel: typeof data.workspaceLabel === 'string' ? data.workspaceLabel : null,
    // ── v2 新增：完整 meeting metadata（用于 boot 自我修复） ──
    title: typeof data.title === 'string' ? data.title : null,
    scene: typeof data.scene === 'string' ? data.scene : null,
    createdAt: typeof data.createdAt === 'number' ? data.createdAt : null,
    subSessions: Array.isArray(data.subSessions) ? data.subSessions : [],
    layout: typeof data.layout === 'string' ? data.layout : 'focus',
    focusedSub: typeof data.focusedSub === 'string' ? data.focusedSub : null,
    syncContext: !!data.syncContext,
    sendTarget: typeof data.sendTarget === 'string' ? data.sendTarget : 'all',
    pinned: !!data.pinned,
    bottomed: !!data.bottomed && !data.pinned,
    lastScene: typeof data.lastScene === 'string' ? data.lastScene : null,
    lastMessageTime: typeof data.lastMessageTime === 'number' ? data.lastMessageTime : null,
    lastCompletedAt: typeof data.lastCompletedAt === 'number' ? data.lastCompletedAt : null,
    covenantText: typeof data.covenantText === 'string' ? data.covenantText : '',
    immersive: !!data.immersive,
    // 串行工作流配置（2026-06-17 maintainer）：群聊可反复用，需重启恢复
    serialWorkflow: (data.serialWorkflow && typeof data.serialWorkflow === 'object') ? data.serialWorkflow : null,
    orchestration: (data.orchestration && typeof data.orchestration === 'object' && data.orchestration.enabled === true) ? data.orchestration : null,
    // 时间戳
    updatedAt: typeof data.updatedAt === 'number' ? data.updatedAt : now,
    savedAt: now,
  };
}

function _tempPath(id) {
  return `${meetingFilePath(id)}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
}

function saveMeetingFile(id, data) {
  ensureDir();
  const payload = _buildMeetingPayload(id, data);
  const tmp = _tempPath(id);
  try {
    fs.writeFileSync(tmp, JSON.stringify(payload));
    fs.renameSync(tmp, meetingFilePath(id));
  } finally {
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch {}
  }
}

async function saveMeetingFileAsync(id, data) {
  await fs.promises.mkdir(meetingsDir(), { recursive: true });
  const payload = _buildMeetingPayload(id, data);
  const tmp = _tempPath(id);
  try {
    await fs.promises.writeFile(tmp, JSON.stringify(payload));
    await fs.promises.rename(tmp, meetingFilePath(id));
  } finally {
    try { await fs.promises.unlink(tmp); } catch {}
  }
}

async function loadMeetingFileAsync(id) {
  try {
    return JSON.parse(await fs.promises.readFile(meetingFilePath(id), 'utf8'));
  } catch {
    return null;
  }
}

function loadMeetingFile(id) {
  try {
    const raw = fs.readFileSync(meetingFilePath(id), 'utf-8');
    const obj = JSON.parse(raw);
    const v = obj.schemaVersion;
    if (v !== 1 && v !== 2) {
      console.warn(`[meeting-store] schema mismatch for ${id}: ${v}`);
      return null;
    }
    // 通用兜底
    if (!['pilot', 'free'].includes(obj.mode)) obj.mode = 'free';
    obj.groupChat = !!obj.groupChat;
    if (typeof obj.groupMode !== 'string') obj.groupMode = 'deliberation';
    if (!Number.isInteger(obj.groupRecentRawN)) obj.groupRecentRawN = 5;
    if (typeof obj.workspace !== 'string') obj.workspace = null;
    if (typeof obj.workspaceLabel !== 'string') obj.workspaceLabel = null;
    if (!Array.isArray(obj.participants)) obj.participants = null;
    if (!obj.serialWorkflow || typeof obj.serialWorkflow !== 'object') obj.serialWorkflow = null;
    if (!obj.orchestration || typeof obj.orchestration !== 'object' || obj.orchestration.enabled !== true) obj.orchestration = null;
    if (typeof obj.updatedAt !== 'number') obj.updatedAt = obj.savedAt || 0;
    if (v === 1) {
      // v1 → 缺 title/scene/createdAt/subSessions 等。返回时显式带 schemaVersion=1
      // 让调用方判断是否需要补全（main.js boot 会在 state.json 里反查；如果都没有则
      // 不画 sidebar 条目，避免残缺）
      obj.schemaVersion = 1;
    }
    return obj;
  } catch (e) {
    if (e.code !== 'ENOENT') console.warn(`[meeting-store] load ${id} failed:`, e.message);
    return null;
  }
}

function listMeetingFiles() {
  try {
    return fs.readdirSync(meetingsDir())
      .filter(f => f.endsWith('.json') && !f.endsWith('.tmp'))
      .map(f => f.slice(0, -5));
  } catch (e) {
    // ENOENT = meetings 目录尚不存在（首次/无会议），属正常，静默返回。
    // 其它错误（权限/磁盘）会让 boot 孤儿恢复静默跳过，至少留日志以便排查。
    if (e && e.code !== 'ENOENT') console.warn('[meeting-store] listMeetingFiles 读取目录失败:', e && e.message);
    return [];
  }
}

// Boot 自我修复用：扫目录返回所有 per-meeting JSON 内容（含 schemaVersion）。
// 损坏文件 skip 不影响其他文件加载。
function listMeetingFilesWithData() {
  const out = [];
  for (const id of listMeetingFiles()) {
    const data = loadMeetingFile(id);
    if (data) out.push(data);
  }
  return out;
}

function deleteMeetingFile(id) {
  // 2026-05-07 多方审查 fix：ENOENT 静默，EPERM/EBUSY 记 warn
  try { fs.unlinkSync(meetingFilePath(id)); }
  catch (e) {
    if (e.code !== 'ENOENT') console.warn(`[meeting-store] delete ${id} failed:`, e.message);
  }
}

// Debounced flush registry
const _dirty = new Map();
const _timers = new Map();
const _writeChains = new Map();

function _enqueueWrite(id, snap) {
  const previous = _writeChains.get(id) || Promise.resolve();
  const task = previous.then(async () => {
    if (_isMeetingRemoved(id)) return;
    const disk = await loadMeetingFileAsync(id) || {};
    await saveMeetingFileAsync(id, { ...disk, ...snap });
    if (_dirty.get(id) === snap) _dirty.delete(id);
  });
  const tracked = task
    .catch(error => console.warn(`[meeting-store] async flush ${id} failed:`, error.message))
    .finally(() => {
      if (_writeChains.get(id) === tracked) _writeChains.delete(id);
    });
  _writeChains.set(id, tracked);
  return tracked;
}

function markDirty(id, data) {
  if (!id) return;
  if (_isMeetingRemoved(id)) return;  // 防复活
  const prev = _dirty.get(id) || {};
  _dirty.set(id, { ...prev, ...(data || {}) });
  if (_timers.has(id)) clearTimeout(_timers.get(id));
  const t = setTimeout(() => {
    if (_isMeetingRemoved(id)) {
      _dirty.delete(id);
      _timers.delete(id);
      return;
    }
    const snap = _dirty.get(id);
    if (snap) void _enqueueWrite(id, snap);
    _timers.delete(id);
  }, DEBOUNCE_MS);
  t.unref?.();
  _timers.set(id, t);
}

async function flushAll() {
  for (const [, t] of _timers) clearTimeout(t);
  _timers.clear();
  for (const [id, snap] of _dirty) {
    if (_isMeetingRemoved(id)) continue;
    try {
      const disk = loadMeetingFile(id) || {};
      saveMeetingFile(id, { ...disk, ...snap });
    } catch (e) { console.warn(`[meeting-store] flushAll ${id} failed:`, e.message); }
  }
  _dirty.clear();
}

function cancelDirty(id) {
  if (_timers.has(id)) {
    clearTimeout(_timers.get(id));
    _timers.delete(id);
  }
  _dirty.delete(id);
}

module.exports = {
  saveMeetingFile,
  loadMeetingFile,
  listMeetingFiles,
  listMeetingFilesWithData,
  deleteMeetingFile,
  markDirty,
  cancelDirty,
  flushAll,
  SCHEMA_VERSION,
  DEBOUNCE_MS,
};
