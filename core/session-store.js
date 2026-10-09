// core/session-store.js
//
// 2026-05-07 maintainer — per-session JSON 备份。镜像 meeting-store 的设计：
//   每个 session 独立写一份 sessions/<hubId>.json，作为 state.json 的双备份。
//   重点保护 codexSid / geminiChatId / Kimi kimiSid 等原生会话关联字段
//   这类 transcript 关联字段——历史上反复因 state.json 全量覆盖被吞回 null，
//   导致 Codex/Gemini 的 dormant resume 退化为 Level 2/3 fallback。
//
// 写时机：
//   markDirty(hubId, data)      — 200ms debounce 普通字段变更
//   markDirtySync(hubId, data)  — 即时落盘（codex/gemini sid 出现时立即固化）
//   flushAll()                  — before-quit 同步 flush

const fs = require('fs');
const path = require('path');
const { getHubDataDir } = require('./data-dir');
const { migrateLegacyBranchSessionMeta } = require('./session-title-guards');
const { positiveTimestamp, preserveLatestInteraction } = require('./session-recency');
const _activityHighWater = new Map();

function preserveActivity(hubId, data) {
  // One read per ownership period, not a disk read on every renderer update.
  if (!_activityHighWater.has(hubId)) {
    _activityHighWater.set(hubId, positiveTimestamp(preserveLatestInteraction(loadSessionFile(hubId))?.lastMessageTime));
  }
  const merged = preserveLatestInteraction(data, { lastMessageTime: _activityHighWater.get(hubId) });
  _activityHighWater.set(hubId, positiveTimestamp(merged.lastMessageTime));
  return merged;
}
// 2026-05-07 多方审查 fix：markDirty 检查 stateStore.isMarkedRemovedSession 跳过
//   已被 close-meeting / persist-sessions diff 标记 removed 的 sid，避免 renderer
//   端因 400ms 防抖窗口"列表还含旧 sid"导致刚删的文件被复活。
//   单向 require：state-store 不 require session-store（boot 时 main.js 注入），
//   不产生循环依赖。
let _stateStore = null;
function _getStateStore() {
  if (_stateStore !== null) return _stateStore;
  try { _stateStore = require('./state-store'); }
  catch { _stateStore = null; }
  return _stateStore;
}

const SCHEMA_VERSION = 1;
const DEBOUNCE_MS = 200;  // 比 meeting 短：sid 类字段一旦变化要尽快落盘

function sessionsDir() {
  return path.join(getHubDataDir(), 'sessions');
}

function ensureDir() {
  fs.mkdirSync(sessionsDir(), { recursive: true });
}

function sessionFilePath(hubId) {
  return path.join(sessionsDir(), `${hubId}.json`);
}

function _sanitizeConnectionIssue(value) {
  if (!value || typeof value !== 'object' || value.type !== 'stream-disconnected') return null;
  const message = typeof value.message === 'string' ? value.message.trim().slice(0, 500) : '';
  if (!message) return null;
  return {
    type: 'stream-disconnected',
    message,
    signature: typeof value.signature === 'string' ? value.signature.slice(0, 500) : message.toLowerCase(),
    observedAt: typeof value.observedAt === 'number' ? value.observedAt : null,
    occurrenceId: typeof value.occurrenceId === 'string' ? value.occurrenceId.slice(0, 500) : null,
    turnId: typeof value.turnId === 'string' ? value.turnId.slice(0, 200) : null,
  };
}

function _sanitizeConnectionIssueAck(value) {
  if (!value || typeof value !== 'object') return null;
  const signature = typeof value.signature === 'string' ? value.signature.trim().slice(0, 500) : '';
  const at = Number(value.at);
  if (!signature || !Number.isFinite(at) || at <= 0) return null;
  return {
    signature,
    at,
    occurrenceId: typeof value.occurrenceId === 'string' ? value.occurrenceId.slice(0, 500) : null,
  };
}

function _buildSessionPayload(hubId, data) {
  data = preserveActivity(hubId, data);
  data = migrateLegacyBranchSessionMeta(data);
  const now = Date.now();
  return {
    schemaVersion: SCHEMA_VERSION,
    hubId,
    kind: typeof data.kind === 'string' ? data.kind : 'claude',
    title: typeof data.title === 'string' ? data.title : null,
    cwd: typeof data.cwd === 'string' ? data.cwd : null,
    workspaceLabel: typeof data.workspaceLabel === 'string' ? data.workspaceLabel : null,
    pinned: !!data.pinned,
    bottomed: !!data.bottomed && !data.pinned,
    ccSessionId: data.ccSessionId || null,
    ...(data.runtimeBackend === 'claude-stream-json' ? {
      nativeConfig: data.nativeConfig || null,
    } : {}),
    transcriptPath: data.transcriptPath || null,
    codexSid: data.codexSid || null,
    acpSid: data.acpSid || null,
    acpProfileId: data.acpProfileId || null,
    acpCapabilities: data.acpCapabilities || null,
    runtimeBackend: data.runtimeBackend || null,
    nativeRuntime: require('./native-agent-runtime.js').persistNativeRuntime(data),
    // 重启后仍要知道这是 PTY 会话：isCodexSession 只看后端与快照，缺了这个标记，
    // 残留的原生字段就会让休眠记录被当成原生会话。
    agentRuntime: data.agentRuntime === 'pty' ? 'pty' : null,
    codexApprovalPolicy: data.codexApprovalPolicy || null,
    codexSandbox: data.codexSandbox || null,
    codexSessionsRoot: data.codexSessionsRoot || null,
    codexAllowMtimeFallback: !!data.codexAllowMtimeFallback,
    codexProfile: data.codexProfile || null,
    codexProfileLabel: data.codexProfileLabel || null,
    mcpProfile: data.mcpProfile || null,
    // 只有显式关掉 fast 才落 false；老会话没有这个字段 → null → 走"默认开"。
    // 用 `=== false` 而不是 !!data.fastMode，否则每条老记录都会变成"关"。
    fastMode: data.fastMode === false ? false : null,
    // Agent 联赛这类无人值守会话。Hub 重启后必须知道它仍是 autonomous，否则
    // resume 出来的 Agent 会丢掉权限旁路与 strict MCP，下一次自动 Prompt 静默卡住。
    autonomous: data.autonomous === true ? true : null,
    // Codex service_tier 档：'inherit' 等于没选，不落盘（null）。
    // inherit is an explicit choice. Dropping it would make a resumed Codex
    // session fall back to Hub's Standard default and silently change speed.
    codexSpeedTier: data.codexSpeedTier || null,
    geminiChatId: data.geminiChatId || null,
    geminiProjectHash: data.geminiProjectHash || null,
    geminiProjectRoot: data.geminiProjectRoot || null,
    kimiSid: data.kimiSid || null,
    kimiSessionDir: data.kimiSessionDir || null,
    currentModel: (data.currentModel && typeof data.currentModel === 'object') ? data.currentModel : null,
    effort: typeof data.effort === 'string' ? data.effort : null,
    contextPct: typeof data.contextPct === 'number' ? data.contextPct : null,
    contextUsed: typeof data.contextUsed === 'number' ? data.contextUsed : null,
    sessionUsage: data.sessionUsage || null,
    contextMax: typeof data.contextMax === 'number' ? data.contextMax : null,
    contextEffectiveMax: typeof data.contextEffectiveMax === 'number' ? data.contextEffectiveMax : null,
    contextEffectiveObservedAt: typeof data.contextEffectiveObservedAt === 'number'
      ? data.contextEffectiveObservedAt
      : null,
    userRenamed: !!data.userRenamed,
    autoTitleGenerated: !!data.autoTitleGenerated,
    branchSourceSessionId: data.branchSourceSessionId || null,
    branchIndex: Number.isInteger(Number(data.branchIndex)) && Number(data.branchIndex) > 0
      ? Number(data.branchIndex)
      : null,
    branchAutoTitlePending: !!data.branchAutoTitlePending,
    purpose: data.purpose || null,
    researchSessionId: data.researchSessionId || null,
    hiddenFromSidebar: !!data.hiddenFromSidebar,
    meetingId: data.meetingId || null,
    lastMessageTime: typeof data.lastMessageTime === 'number' ? data.lastMessageTime : null,
    lastOutputPreview: typeof data.lastOutputPreview === 'string' ? data.lastOutputPreview : '',
    unreadCount: typeof data.unreadCount === 'number' ? data.unreadCount : 0,
    attentionState: typeof data.attentionState === 'string' ? data.attentionState : null,
    needsUserInput: !!data.needsUserInput,
    replyReady: !!data.replyReady,
    waitingReason: typeof data.waitingReason === 'string' ? data.waitingReason : null,
    waitingText: typeof data.waitingText === 'string' ? data.waitingText : null,
    replyReadyText: typeof data.replyReadyText === 'string' ? data.replyReadyText : null,
    runStartedAt: typeof data.runStartedAt === 'number' ? data.runStartedAt : null,
    lastCompletedAt: typeof data.lastCompletedAt === 'number' ? data.lastCompletedAt : null,
    lastRunStartedAt: typeof data.lastRunStartedAt === 'number' ? data.lastRunStartedAt : null,
    lastRunDurationMs: typeof data.lastRunDurationMs === 'number' ? data.lastRunDurationMs : null,
    recentArtifacts: Array.isArray(data.recentArtifacts) ? data.recentArtifacts.slice(-8) : null,
    suspendedAt: typeof data.suspendedAt === 'number' ? data.suspendedAt : null,
    suspendReason: typeof data.suspendReason === 'string' ? data.suspendReason : null,
    connectionIssue: _sanitizeConnectionIssue(data.connectionIssue),
    _connectionIssueAck: _sanitizeConnectionIssueAck(data._connectionIssueAck),
    updatedAt: typeof data.updatedAt === 'number' ? data.updatedAt : now,
    savedAt: now,
  };
}

function _tempPath(hubId) {
  return `${sessionFilePath(hubId)}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
}

function saveSessionFile(hubId, data) {
  ensureDir();
  const payload = _buildSessionPayload(hubId, data);
  const tmp = _tempPath(hubId);
  try {
    fs.writeFileSync(tmp, JSON.stringify(payload));
    fs.renameSync(tmp, sessionFilePath(hubId));
  } finally {
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch {}
  }
}

async function saveSessionFileAsync(hubId, data) {
  await fs.promises.mkdir(sessionsDir(), { recursive: true });
  const payload = _buildSessionPayload(hubId, data);
  const tmp = _tempPath(hubId);
  try {
    await fs.promises.writeFile(tmp, JSON.stringify(payload));
    await fs.promises.rename(tmp, sessionFilePath(hubId));
  } finally {
    try { await fs.promises.unlink(tmp); } catch {}
  }
}

function loadSessionFile(hubId, {strict = false} = {}) {
  try {
    const raw = fs.readFileSync(sessionFilePath(hubId), 'utf-8');
    const obj = JSON.parse(raw);
    if (obj.schemaVersion !== SCHEMA_VERSION) {
      if(strict)throw Error('不支持的会话记录版本：' + obj.schemaVersion);
      console.warn(`[session-store] schema mismatch for ${hubId}: ${obj.schemaVersion}`);
      return null;
    }
    if (typeof obj.updatedAt !== 'number') obj.updatedAt = obj.savedAt || 0;
    return migrateLegacyBranchSessionMeta(obj);
  } catch (e) {
    if(strict && e.code!=='ENOENT')throw e;
    if (e.code !== 'ENOENT') console.warn(`[session-store] load ${hubId} failed:`, e.message);
    return null;
  }
}

function listSessionFiles() {
  try {
    return fs.readdirSync(sessionsDir())
      .filter(f => f.endsWith('.json') && !f.endsWith('.tmp'))
      .map(f => f.slice(0, -5));
  } catch { return []; }
}

function listSessionFilesWithData() {
  const out = [];
  for (const id of listSessionFiles()) {
    const data = loadSessionFile(id);
    if (data) out.push(data);
  }
  return out;
}

function deleteSessionFile(hubId) {
  _activityHighWater.delete(hubId);
  // 2026-05-07 多方审查 fix：原版吞所有错误。ENOENT（文件本就不存在）静默 OK；
  //   EPERM/EBUSY（杀软/同步盘锁住）记 warn 让运维可见，下次 boot self-heal 才有
  //   线索查为什么有"僵尸"per-session JSON 残留。
  try { fs.unlinkSync(sessionFilePath(hubId)); }
  catch (e) {
    if (e.code !== 'ENOENT') console.warn(`[session-store] delete ${hubId} failed:`, e.message);
  }
}

const _dirty = new Map();
const _timers = new Map();
const _writeChains = new Map();
const _releasedWrites = new Set();

function _isRemoved(hubId) {
  const ss = _getStateStore();
  return !!(ss && typeof ss.isMarkedRemovedSession === 'function' && ss.isMarkedRemovedSession(hubId));
}

function _enqueueWrite(hubId, snap) {
  const previous = _writeChains.get(hubId) || Promise.resolve();
  const task = previous.then(async () => {
    if (_isRemoved(hubId) || _releasedWrites.has(hubId)) return;
    await saveSessionFileAsync(hubId, snap);
    if (_dirty.get(hubId) === snap) _dirty.delete(hubId);
  });
  const tracked = task
    .catch(error => console.warn(`[session-store] async flush ${hubId} failed:`, error.message))
    .finally(() => {
      if (_writeChains.get(hubId) === tracked) _writeChains.delete(hubId);
    });
  _writeChains.set(hubId, tracked);
  return tracked;
}

function markDirty(hubId, data) {
  if (!hubId) return;
  if (_releasedWrites.has(hubId)) return;
  // 2026-05-07 多方审查 fix：被标记 removed 的 sid 不再 markDirty——renderer 防抖
  //   窗口里的 stale list 不应复活已删条目。
  if (_isRemoved(hubId)) return;
  data = preserveActivity(hubId, data);
  _dirty.set(hubId, data);
  if (_timers.has(hubId)) clearTimeout(_timers.get(hubId));
  const t = setTimeout(() => {
    // 再检查一次 — timer 触发时 removed 状态可能已经变更
    if (_isRemoved(hubId)) {
      _dirty.delete(hubId);
      _timers.delete(hubId);
      return;
    }
    const snap = _dirty.get(hubId);
    if (snap) void _enqueueWrite(hubId, snap);
    _timers.delete(hubId);
  }, DEBOUNCE_MS);
  t.unref?.();
  _timers.set(hubId, t);
}

// Sync write — for codex/gemini sid 这类一旦确定不能丢的关键字段。
// 仍然保留 markDirty 的 pending 数据：本调用立即落盘，未触发的 debounce 取消。
function markDirtySync(hubId, data) {
  if (!hubId) return;
  if (_releasedWrites.has(hubId)) return;
  if (_isRemoved(hubId)) return;
  if (_timers.has(hubId)) { clearTimeout(_timers.get(hubId)); _timers.delete(hubId); }
  _dirty.delete(hubId);
  try { saveSessionFile(hubId, data); }
  catch (e) { console.warn(`[session-store] sync flush ${hubId} failed:`, e.message); }
}

function markDirtyImmediate(hubId, data) {
  if (!hubId || _isRemoved(hubId) || _releasedWrites.has(hubId)) return Promise.resolve();
  data = preserveActivity(hubId, data);
  if (_timers.has(hubId)) { clearTimeout(_timers.get(hubId)); _timers.delete(hubId); }
  _dirty.set(hubId, data);
  return _enqueueWrite(hubId, data);
}

function flushAll() {
  for (const [, t] of _timers) clearTimeout(t);
  _timers.clear();
  for (const [id, snap] of _dirty) {
    if (_isRemoved(id)) continue;  // 退出时也别复活已删条目
    try { saveSessionFile(id, snap); }
    catch (e) { console.warn(`[session-store] flushAll ${id} failed:`, e.message); }
  }
  _dirty.clear();
}

function cancelDirty(hubId) {
  if (_timers.has(hubId)) {
    clearTimeout(_timers.get(hubId));
    _timers.delete(hubId);
  }
  _dirty.delete(hubId);
}

async function flushSessionForRelease(hubId, data) {
  _releasedWrites.add(hubId);
  cancelDirty(hubId);
  // An older asynchronous rename must finish before the final authoritative
  // snapshot is written and another Hub is allowed to resume.
  while (_writeChains.has(hubId)) await _writeChains.get(hubId);
  cancelDirty(hubId);
  if (!_isRemoved(hubId)) saveSessionFile(hubId, {...data, updatedAt:Date.now()});
}

module.exports = {
  resumeSessionWrites: hubId => {
    _releasedWrites.delete(hubId);
    _activityHighWater.delete(hubId);
  },
  flushSessionForRelease,
  saveSessionFile,
  loadSessionFile,
  listSessionFiles,
  listSessionFilesWithData,
  deleteSessionFile,
  markDirty,
  markDirtyImmediate,
  markDirtySync,
  cancelDirty,
  flushAll,
  SCHEMA_VERSION,
  DEBOUNCE_MS,
};
