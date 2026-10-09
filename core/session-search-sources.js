'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { isAiKind, getKindLabel } = require('./ai-kinds');
const { parseClaudeTranscriptEntries } = require('./claude-transcript-parser.js');
const { JsonlByteScanner } = require('./jsonl-byte-scanner.js');
const {
  parseCodexRolloutEntries,
  readCodexRolloutMeta,
  isCodexTopLevelRolloutMeta,
} = require('./codex-transcript-parser.js');
const { streamCodexJsonlRecordsSync } = require('./codex-rollout-reader.js');
const {
  codexAgentMessageEventFromRecord,
} = require('./transcript-payload-utils.js');
const { searchableUserText } = require('./synthetic-user-filter.js');

function normalizePath(value) {
  if (!value) return '';
  try { return path.resolve(String(value)).replace(/\\/g, '/').toLocaleLowerCase(); }
  catch { return String(value).replace(/\\/g, '/').toLocaleLowerCase(); }
}

const DEFAULT_SEARCH_SOURCE_READ_BYTES = 4 * 1024 * 1024;
// 单文件 JSON（群聊 timeline、Gemini）只能整读；在搜索子进程里读，64MB 以内不值得降级。
const DEFAULT_JSON_SOURCE_READ_BYTES = 64 * 1024 * 1024;
// v3：对话 doc 的 ordinal 改用 rollout 行号，与工具 doc 同一尺度。
const CODEX_SEARCH_PROJECTION_VERSION = 4;

// 索引里「一条 doc 的文本长什么样」的版本号。refresh() 是按 signature 增量复用的
// （mtime+size+元数据都没变就直接复用旧文档），所以**只改解析逻辑不改签名，
// 已经入库的源永远不会重新解析**。2026-08-28 给 user 文档加了注入清洗，
// 必须靠这个版本号把全量源顶掉重来。以后再改文本投影就 +1。
// v2：Claude 由尾部 4MB 改为流式读完整文件；剥掉 Hub 附加的梦境索引。
const SEARCH_TEXT_PROJECTION_VERSION = 3;
const PROJECTION_SUFFIX = `:utext-v${SEARCH_TEXT_PROJECTION_VERSION}`;

function readBoundedJsonlTailText(filePath, maxBytes = DEFAULT_SEARCH_SOURCE_READ_BYTES, fsRef = fs) {
  const stat = fsRef.statSync(filePath);
  const limit = Math.max(256 * 1024, Number(maxBytes) || DEFAULT_SEARCH_SOURCE_READ_BYTES);
  if (stat.size <= limit) return { raw: fsRef.readFileSync(filePath, 'utf8'), truncated: false };
  const length = Math.min(stat.size, limit);
  const buffer = Buffer.allocUnsafe(length);
  const fd = fsRef.openSync(filePath, 'r');
  let bytesRead = 0;
  try {
    while (bytesRead < length) {
      const count = fsRef.readSync(fd, buffer, bytesRead, length - bytesRead, stat.size - length + bytesRead);
      if (count <= 0) break;
      bytesRead += count;
    }
  } finally {
    fsRef.closeSync(fd);
  }
  let raw = buffer.subarray(0, bytesRead).toString('utf8');
  const firstNewline = raw.indexOf('\n');
  raw = firstNewline >= 0 ? raw.slice(firstNewline + 1) : '';
  return { raw, truncated: true };
}

function shortHash(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex').slice(0, 12);
}

function stableJsonHash(value) {
  return shortHash(JSON.stringify(value || null));
}

function statSignature(stat) {
  return `${Number(stat && stat.size) || 0}:${Math.round(Number(stat && stat.mtimeMs) || 0)}`;
}

function hubIdOf(session) {
  return String(session && (session.hubId || session.id) || '').trim();
}

function baseKind(kind) {
  return String(kind || '').replace(/-resume$/, '');
}

function providerForHubSession(session) {
  if (!session || session.meetingId) return session && session.meetingId ? 'meeting' : 'unknown';
  const kind = baseKind(session.kind);
  if (kind === 'deepseek' || kind === 'deepseek-legacy' || kind === 'deepseek-acp') return 'deepseek';
  if (kind === 'codex') return 'codex';
  if (kind === 'claude') return 'claude';
  if (kind === 'kimi') return 'kimi';
  if (kind === 'gemini') return 'gemini';
  return isAiKind(kind) ? kind : 'unknown';
}

function providerForClaudeRoot(root) {
  return /(?:^|[\\/])\.claude-deepseek(?:[\\/]|$)/i.test(String(root || '')) ? 'deepseek' : 'claude';
}

function providerLabel(provider) {
  if (provider === 'claude') return 'Claude';
  if (provider === 'codex') return 'Codex';
  if (provider === 'deepseek') return 'DeepSeek';
  if (provider === 'meeting') return '群聊';
  if (provider === 'kimi') return 'Kimi';
  if (provider === 'gemini') return 'Gemini';
  return isAiKind(provider) ? getKindLabel(provider) : 'AI';
}

function sessionUpdatedAt(session) {
  return Number(session && (
    session.lastCompletedAt || session.lastMessageTime || session.updatedAt || session.createdAt
  )) || 0;
}

function preferredHubSession(candidates = []) {
  return [...candidates].filter(Boolean).sort((a, b) => {
    const aLive = a.status && a.status !== 'dormant' ? 1 : 0;
    const bLive = b.status && b.status !== 'dormant' ? 1 : 0;
    if (aLive !== bLive) return bLive - aLive;
    const aStandalone = a.meetingId ? 0 : 1;
    const bStandalone = b.meetingId ? 0 : 1;
    if (aStandalone !== bStandalone) return bStandalone - aStandalone;
    return sessionUpdatedAt(b) - sessionUpdatedAt(a);
  })[0] || null;
}

function dedupeHubSessions(snapshot = {}) {
  const byId = new Map();
  for (const raw of (Array.isArray(snapshot.sessions) ? snapshot.sessions : [])) {
    const id = hubIdOf(raw);
    if (!id) continue;
    const existing = byId.get(id);
    if (!existing || sessionUpdatedAt(raw) >= sessionUpdatedAt(existing)) byId.set(id, { ...existing, ...raw, hubId: id });
  }
  return [...byId.values()];
}

function createMetadataMaps(snapshot = {}) {
  const sessions = dedupeHubSessions(snapshot);
  const byTranscriptPath = new Map();
  const byClaudeNative = new Map();
  const byCodexRootNative = new Map();
  const byCodexNative = new Map();
  for (const session of sessions) {
    const provider = providerForHubSession(session);
    const transcriptPath = normalizePath(session.transcriptPath);
    if (transcriptPath) {
      const list = byTranscriptPath.get(transcriptPath) || [];
      list.push(session);
      byTranscriptPath.set(transcriptPath, list);
    }
    if ((provider === 'claude' || provider === 'deepseek') && session.ccSessionId) {
      const key = `${provider}:${session.ccSessionId}`;
      const list = byClaudeNative.get(key) || [];
      list.push(session);
      byClaudeNative.set(key, list);
    }
    if ((provider === 'codex' || provider === 'deepseek') && session.codexSid) {
      const rootKey = normalizePath(session.codexSessionsRoot || '');
      if (rootKey) {
        const key = `${rootKey}:${session.codexSid}`;
        const list = byCodexRootNative.get(key) || [];
        list.push(session);
        byCodexRootNative.set(key, list);
      }
      const list = byCodexNative.get(String(session.codexSid)) || [];
      list.push(session);
      byCodexNative.set(String(session.codexSid), list);
    }
  }
  const meetings = new Map();
  for (const meeting of (Array.isArray(snapshot.meetings) ? snapshot.meetings : [])) {
    if (meeting && meeting.id) meetings.set(String(meeting.id), meeting);
  }
  return { sessions, byTranscriptPath, byClaudeNative, byCodexRootNative, byCodexNative, meetings };
}

function matchClaudeHubSession(filePath, sid, provider, maps) {
  const byPath = preferredHubSession(maps.byTranscriptPath.get(normalizePath(filePath)) || []);
  if (byPath) return byPath;
  return preferredHubSession(maps.byClaudeNative.get(`${provider}:${sid}`) || []);
}

function matchCodexHubSession(filePath, sid, root, maps) {
  const byPath = preferredHubSession(maps.byTranscriptPath.get(normalizePath(filePath)) || []);
  if (byPath) return byPath;
  const byRoot = preferredHubSession(maps.byCodexRootNative.get(`${normalizePath(root)}:${sid}`) || []);
  if (byRoot) return byRoot;
  const anyRoot = maps.byCodexNative.get(String(sid)) || [];
  const rootless = anyRoot.filter(session => !normalizePath(session.codexSessionsRoot));
  if (rootless.length) return preferredHubSession(rootless);
  const distinctRoots = new Set(anyRoot.map(session => normalizePath(session.codexSessionsRoot)).filter(Boolean));
  // Copied SIDs across subscription profiles are different Hub identities.
  // If this rollout's root does not match any persisted scope and more than one
  // scope owns the SID, guessing would make “open result” resume the wrong account.
  return distinctRoots.size <= 1 ? preferredHubSession(anyRoot) : null;
}

function metadataSignature(meta) {
  if (!meta) return 'none';
  return stableJsonHash({
    hubId: hubIdOf(meta), title: meta.title || null, cwd: meta.cwd || null,
    transcriptPath: meta.transcriptPath || null,
    workspaceLabel: meta.workspaceLabel || null, kind: meta.kind || null,
    workspace: meta.workspace || null,
    subSessions: Array.isArray(meta.subSessions) ? meta.subSessions : null,
    slotSpecs: Array.isArray(meta.slotSpecs) ? meta.slotSpecs : null,
    groupChat: meta.groupChat === true,
    meetingId: meta.meetingId || null, currentModel: meta.currentModel || meta.model || null,
    codexSessionsRoot: meta.codexSessionsRoot || null, codexProfile: meta.codexProfile || null,
    lastMessageTime: meta.lastMessageTime || null, lastCompletedAt: meta.lastCompletedAt || null,
  });
}

function pickDuplicateDescriptor(descriptors) {
  return [...descriptors].sort((a, b) => {
    const aExact = a.hubSession && normalizePath(a.hubSession.transcriptPath) === normalizePath(a.filePath) ? 1 : 0;
    const bExact = b.hubSession && normalizePath(b.hubSession.transcriptPath) === normalizePath(b.filePath) ? 1 : 0;
    if (aExact !== bExact) return bExact - aExact;
    return b.mtime - a.mtime;
  })[0];
}

function recordDiscoveryError(diagnostics, label, error) {
  if (!error || error.code === 'ENOENT') return;
  diagnostics.push(`${label}: ${error.message || error}`);
}

function listClaudeDescriptors(roots, maps, diagnostics = []) {
  const groups = new Map();
  for (const root of roots || []) {
    const provider = providerForClaudeRoot(root);
    let projectDirs;
    try { projectDirs = fs.readdirSync(root, { withFileTypes: true }); }
    catch (error) { recordDiscoveryError(diagnostics, `Claude root ${root}`, error); continue; }
    for (const projectDir of projectDirs) {
      if (!projectDir.isDirectory()) continue;
      const directory = path.join(root, projectDir.name);
      let files;
      try { files = fs.readdirSync(directory, { withFileTypes: true }); }
      catch (error) { recordDiscoveryError(diagnostics, `Claude project ${directory}`, error); continue; }
      for (const entry of files) {
        if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
        const filePath = path.join(directory, entry.name);
        let stat;
        try { stat = fs.statSync(filePath); }
        catch (error) { recordDiscoveryError(diagnostics, `Claude transcript ${filePath}`, error); continue; }
        const sid = entry.name.slice(0, -6);
        const hubSession = matchClaudeHubSession(filePath, sid, provider, maps);
        const descriptor = {
          type: 'claude', key: `claude:${provider}:${sid}`,
          filePath, root, provider, nativeSessionId: sid, hubSession,
          fileSignature: statSignature(stat), mtime: stat.mtimeMs || 0,
        };
        descriptor.signature = `${descriptor.fileSignature}:${shortHash(normalizePath(filePath))}:${metadataSignature(hubSession)}` + PROJECTION_SUFFIX;
        const list = groups.get(descriptor.key) || [];
        list.push(descriptor);
        groups.set(descriptor.key, list);
      }
    }
  }
  return [...groups.values()].map(pickDuplicateDescriptor);
}

function walkCodexRollouts(root, diagnostics = []) {
  const out = [];
  const visit = (directory, depth) => {
    if (depth > 3) return;
    let entries;
    try { entries = fs.readdirSync(directory, { withFileTypes: true }); }
    catch (error) { recordDiscoveryError(diagnostics, `Codex directory ${directory}`, error); return; }
    for (const entry of entries) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(full, depth + 1);
      else if (entry.isFile() && entry.name.startsWith('rollout-') && entry.name.endsWith('.jsonl')) out.push(full);
    }
  };
  visit(root, 0);
  return out;
}

function listCodexDescriptors(roots, maps, diagnostics = [], metaCache = null) {
  const groups = new Map();
  for (const root of roots || []) {
    for (const filePath of walkCodexRollouts(root, diagnostics)) {
      let stat;
      try { stat = fs.statSync(filePath); }
      catch (error) { recordDiscoveryError(diagnostics, `Codex rollout ${filePath}`, error); continue; }
      // Codex can leave a zero-byte rollout placeholder after an interrupted
      // startup. It contains no searchable record and is not an index error.
      if (!stat.size) continue;
      const cacheKey = normalizePath(filePath);
      let meta = metaCache?.get(cacheKey, stat);
      if (!meta) {
        meta = readCodexRolloutMeta(filePath);
        metaCache?.set(cacheKey, stat, meta);
      }
      if (!meta) {
        diagnostics.push(`Codex rollout metadata unreadable: ${filePath}`);
        continue;
      }
      if (!isCodexTopLevelRolloutMeta(meta)) continue;
      const sid = String(meta.id || meta.session_id || '').trim();
      if (!sid) continue;
      const hubSession = matchCodexHubSession(filePath, sid, root, maps);
      const provider = providerForHubSession(hubSession) === 'deepseek' ? 'deepseek' : 'codex';
      const scope = shortHash(normalizePath(root));
      const descriptor = {
        type: 'codex', key: `codex:${scope}:${sid}`,
        filePath, root, provider, nativeSessionId: sid, hubSession, codexMeta: meta,
        fileSignature: statSignature(stat), mtime: stat.mtimeMs || 0,
      };
      descriptor.signature = `${descriptor.fileSignature}:${shortHash(normalizePath(filePath))}:${metadataSignature(hubSession)}:semantic-v${CODEX_SEARCH_PROJECTION_VERSION}` + PROJECTION_SUFFIX;
      const list = groups.get(descriptor.key) || [];
      list.push(descriptor);
      groups.set(descriptor.key, list);
    }
  }
  return [...groups.values()].map(pickDuplicateDescriptor);
}

// ── Kimi ─────────────────────────────────────────────────────────────────
// 2026-08-28：此前索引只有 claude / codex / meeting 三个适配器，Kimi 的 45 个
// 会话（43 个磁盘上有真实 transcript）**一条都进不了索引**，正文怎么搜都搜不到。
//
// 磁盘布局：~/.kimi-code/sessions/wd_<slug>_<hash>/session_<uuid>/agents/main/wire.jsonl
// 只取 agents/main —— agents/agent-0 等是子 agent 的分身，内容会与 main 重复。
function walkKimiWires(root, diagnostics = []) {
  const out = [];
  const visit = (directory, depth) => {
    if (depth > 4) return;
    let entries;
    try { entries = fs.readdirSync(directory, { withFileTypes: true }); }
    catch (error) { recordDiscoveryError(diagnostics, `Kimi directory ${directory}`, error); return; }
    for (const entry of entries) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(full, depth + 1);
      else if (entry.isFile() && entry.name === 'wire.jsonl' && /[\\/]agents[\\/]main[\\/]wire\.jsonl$/i.test(full)) out.push(full);
    }
  };
  visit(root, 0);
  return out;
}

function kimiSidFromPath(filePath) {
  const match = String(filePath).match(/session_([0-9a-f-]{8,})/i);
  return match ? match[1] : '';
}

function matchKimiHubSession(filePath, sid, maps) {
  const normalized = normalizePath(filePath);
  const candidates = maps.sessions.filter((session) => {
    if (!session || baseKind(session.kind) !== 'kimi') return false;
    if (session.transcriptPath && normalizePath(session.transcriptPath) === normalized) return true;
    // Hub 里存的是 "session_<uuid>"，路径里是同一个 uuid，两种写法都要认
    const stored = String(session.kimiSid || '').replace(/^session_/i, '');
    return stored && sid && stored === sid;
  });
  return preferredHubSession(candidates);
}

function listKimiDescriptors(roots, maps, diagnostics = []) {
  const groups = new Map();
  for (const root of roots || []) {
    for (const filePath of walkKimiWires(root, diagnostics)) {
      let stat;
      try { stat = fs.statSync(filePath); }
      catch (error) { recordDiscoveryError(diagnostics, `Kimi wire ${filePath}`, error); continue; }
      if (!stat.size) continue;
      const sid = kimiSidFromPath(filePath);
      if (!sid) continue;
      const hubSession = matchKimiHubSession(filePath, sid, maps);
      const descriptor = {
        type: 'kimi', key: `kimi:${sid}`,
        filePath, root, provider: 'kimi', nativeSessionId: sid, hubSession,
        fileSignature: statSignature(stat), mtime: stat.mtimeMs || 0,
      };
      descriptor.signature = `${descriptor.fileSignature}:${shortHash(normalizePath(filePath))}:${metadataSignature(hubSession)}` + PROJECTION_SUFFIX;
      const list = groups.get(descriptor.key) || [];
      list.push(descriptor);
      groups.set(descriptor.key, list);
    }
  }
  return [...groups.values()].map(pickDuplicateDescriptor);
}

// ── Gemini ───────────────────────────────────────────────────────────────
// 磁盘布局：~/.gemini/tmp/<projectHash>/chats/session-<时间>-<短id>.json
// 单文件 JSON：{ sessionId, projectHash, startTime, lastUpdated,
//               messages: [{ id, timestamp, type: 'user'|'gemini', content: [{text}] }] }
//
// 实测（2026-08-28）：磁盘上 1749 个 chat 文件，而 Hub 里 21 个 gemini 会话中
// 有 chatId 的 10 个，**没有一个**能在磁盘上找到对应文件 —— 那些 transcript 已经
// 不在了（Hub 记的 projectHash 是 "you"，磁盘上却是 uuid 目录）。所以：
//   · Hub 的 gemini 会话只能靠 titleOnlySources 留标题
//   · 磁盘上这些孤立 chat 仍然索引，正文可搜、预览可读，但「打开会话」恢复不了
// 小于 2KB 的基本是 "说一句你好" 这类试跑，跳过，别拿噪声撑大索引。
const GEMINI_MIN_CHAT_BYTES = 2048;

function listGeminiDescriptors(roots, maps, diagnostics = []) {
  const groups = new Map();
  for (const root of roots || []) {
    let projectDirs;
    try { projectDirs = fs.readdirSync(root, { withFileTypes: true }); }
    catch (error) { recordDiscoveryError(diagnostics, `Gemini root ${root}`, error); continue; }
    for (const projectDir of projectDirs) {
      if (!projectDir.isDirectory()) continue;
      const chatsDir = path.join(root, projectDir.name, 'chats');
      let files;
      try { files = fs.readdirSync(chatsDir, { withFileTypes: true }); }
      catch (error) { recordDiscoveryError(diagnostics, `Gemini chats ${chatsDir}`, error); continue; }
      for (const entry of files) {
        if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
        const filePath = path.join(chatsDir, entry.name);
        let stat;
        try { stat = fs.statSync(filePath); }
        catch (error) { recordDiscoveryError(diagnostics, `Gemini chat ${filePath}`, error); continue; }
        if (stat.size < GEMINI_MIN_CHAT_BYTES) continue;
        const sid = entry.name.replace(/^session-/, '').replace(/\.json$/i, '');
        // 文件名里只有 uuid 的前 8 位（session-<时间>-<短id>.json），按前缀认
        const shortId = sid.split('-').pop() || '';
        const hubSession = preferredHubSession(maps.sessions.filter((session) => {
          if (!session || baseKind(session.kind) !== 'gemini') return false;
          const chatId = String(session.geminiChatId || '');
          return chatId && (chatId === sid || (shortId.length >= 8 && chatId.startsWith(shortId)));
        }));
        const descriptor = {
          type: 'gemini', key: `gemini:${projectDir.name}:${sid}`,
          filePath, root, provider: 'gemini', nativeSessionId: sid, hubSession,
          geminiProjectHash: projectDir.name,
          fileSignature: statSignature(stat), mtime: stat.mtimeMs || 0,
        };
        descriptor.signature = `${descriptor.fileSignature}:${shortHash(normalizePath(filePath))}:${metadataSignature(hubSession)}` + PROJECTION_SUFFIX;
        const list = groups.get(descriptor.key) || [];
        list.push(descriptor);
        groups.set(descriptor.key, list);
      }
    }
  }
  return [...groups.values()].map(pickDuplicateDescriptor);
}

function listMeetingDescriptors(meetingDir, maps, diagnostics = []) {
  let entries;
  try { entries = fs.readdirSync(meetingDir, { withFileTypes: true }); }
  catch (error) { recordDiscoveryError(diagnostics, `Meeting directory ${meetingDir}`, error); return []; }
  const out = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const filePath = path.join(meetingDir, entry.name);
    const meetingId = entry.name.slice(0, -5);
    let stat;
    try { stat = fs.statSync(filePath); }
    catch (error) { recordDiscoveryError(diagnostics, `Meeting transcript ${filePath}`, error); continue; }
    const meeting = maps.meetings.get(meetingId) || null;
    const memberSignature = stableJsonHash((meeting && meeting.subSessions || []).map((hubId) => {
      const session = maps.sessions.find(row => hubIdOf(row) === String(hubId));
      return session ? [hubIdOf(session), session.title || null, session.kind || null] : [String(hubId), null, null];
    }));
    const descriptor = {
      type: 'meeting', key: `meeting:${meetingId}`, filePath, meetingId, meeting,
      fileSignature: statSignature(stat), mtime: stat.mtimeMs || 0,
    };
    descriptor.signature = `${descriptor.fileSignature}:${shortHash(normalizePath(filePath))}:${metadataSignature(meeting)}:${memberSignature}:workspace-v1` + PROJECTION_SUFFIX;
    out.push(descriptor);
  }
  return out;
}

function addExplicitTranscriptDescriptors(descriptors, maps, diagnostics = []) {
  const knownPaths = new Set(descriptors.map(item => normalizePath(item.filePath)));
  for (const session of maps.sessions) {
    const filePath = session.transcriptPath;
    const provider = providerForHubSession(session);
    if (!filePath || !['claude', 'codex', 'deepseek', 'kimi'].includes(provider)) continue;
    const normalized = normalizePath(filePath);
    if (!normalized || knownPaths.has(normalized)) continue;
    let stat;
    try { stat = fs.statSync(filePath); }
    catch (error) { recordDiscoveryError(diagnostics, `Bound transcript ${filePath}`, error); continue; }
    if (!stat.isFile()) continue;
    // Kimi 的 transcriptPath 直接指向 agents/main/wire.jsonl。归档搬过目录的会话
    // 可能不在默认根下，靠这条兜住。
    if (provider === 'kimi') {
      const sid = kimiSidFromPath(filePath) || String(session.kimiSid || '').replace(/^session_/i, '');
      if (!sid) continue;
      const descriptor = {
        type: 'kimi', key: `kimi:${sid}`, filePath, root: path.dirname(filePath),
        provider: 'kimi', nativeSessionId: sid, hubSession: session,
        fileSignature: statSignature(stat), mtime: stat.mtimeMs || 0,
      };
      descriptor.signature = `${descriptor.fileSignature}:${shortHash(normalized)}:${metadataSignature(session)}` + PROJECTION_SUFFIX;
      descriptors.push(descriptor);
      knownPaths.add(normalized);
      continue;
    }
    const nativeSessionId = session.ccSessionId || session.codexSid || path.basename(filePath, '.jsonl');
    const type = session.codexSid ? 'codex' : 'claude';
    const codexMeta = type === 'codex' ? readCodexRolloutMeta(filePath) : null;
    if (type === 'codex' && !isCodexTopLevelRolloutMeta(codexMeta)) continue;
    const root = type === 'codex' ? (session.codexSessionsRoot || path.dirname(filePath)) : path.dirname(path.dirname(filePath));
    const key = type === 'codex'
      ? `codex:${shortHash(normalizePath(root))}:${nativeSessionId}`
      : `claude:${provider}:${nativeSessionId}`;
    const descriptor = {
      type, key, filePath, root, provider, nativeSessionId, hubSession: session,
      fileSignature: statSignature(stat), mtime: stat.mtimeMs || 0,
      ...(type === 'codex' ? { codexMeta } : {}),
    };
    descriptor.signature = `${descriptor.fileSignature}:${shortHash(normalized)}:${metadataSignature(session)}${type === 'codex' ? `:semantic-v${CODEX_SEARCH_PROJECTION_VERSION}` : ''}` + PROJECTION_SUFFIX;
    descriptors.push(descriptor);
    knownPaths.add(normalized);
  }
}

function collectSourceDescriptors(options = {}, snapshot = {}, metaCache = null) {
  const maps = createMetadataMaps(snapshot);
  const diagnostics = [];
  const descriptors = [
    ...listClaudeDescriptors(options.claudeRoots || [], maps, diagnostics),
    ...listCodexDescriptors(options.codexRoots || [], maps, diagnostics, metaCache),
    ...listKimiDescriptors(options.kimiRoots || [], maps, diagnostics),
    ...listGeminiDescriptors(options.geminiRoots || [], maps, diagnostics),
    ...listMeetingDescriptors(options.meetingDir, maps, diagnostics),
  ];
  addExplicitTranscriptDescriptors(descriptors, maps, diagnostics);
  const deduped = new Map();
  for (const descriptor of descriptors) {
    const existing = deduped.get(descriptor.key);
    if (!existing) deduped.set(descriptor.key, descriptor);
    else deduped.set(descriptor.key, pickDuplicateDescriptor([existing, descriptor]));
  }
  return { descriptors: [...deduped.values()], maps, diagnostics };
}

function deriveTitle(firstUserText, fallback) {
  const cleaned = String(firstUserText || '')
    .replace(/^\s*\/goal(?:\s+|$)/i, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (cleaned) return cleaned.slice(0, 100);
  return String(fallback || '未命名会话').trim() || '未命名会话';
}

function resolveModel(hubSession, turns) {
  if (hubSession && hubSession.currentModel && typeof hubSession.currentModel === 'object') {
    if (hubSession.currentModel.id) return hubSession.currentModel.id;
  }
  if (hubSession && typeof hubSession.model === 'string') return hubSession.model;
  const latest = [...(turns || [])].reverse().find(turn => turn && turn.model);
  return latest ? latest.model : null;
}

function projectLabelFor(meta, cwd) {
  if (meta && meta.workspaceLabel) return String(meta.workspaceLabel);
  if (!cwd) return null;
  const normalized = String(cwd).replace(/[\\/]+$/, '');
  return path.basename(normalized) || normalized;
}

function sessionRecordFromDescriptor(descriptor, turns, extra = {}) {
  const hub = descriptor.hubSession || null;
  const cwd = (hub && hub.cwd) || extra.cwd || null;
  // 取第一句**用户真正说的话**当标题。直接用 turn.text 的话，Codex 那条把
  // AGENTS.md 全文当 user 消息写进来的注入会让标题变成「# AGENTS.md instructions…」。
  let firstUserText = '';
  for (const turn of (turns || [])) {
    if (!turn || turn.role !== 'user' || !turn.text) continue;
    const cleaned = searchableUserText(turn.text);
    if (cleaned) { firstUserText = cleaned; break; }
  }
  const title = (hub && hub.title) || deriveTitle(firstUserText, extra.slug || providerLabel(descriptor.provider));
  const newestTurnAt = (turns || []).reduce((max, turn) => Math.max(max, Number(turn && (turn.tsEnd || turn.ts)) || 0), 0);
  return {
    key: descriptor.key,
    provider: descriptor.provider,
    nativeFamily: descriptor.type,
    kind: (hub && hub.kind) || (descriptor.provider === 'deepseek' ? 'deepseek-resume' : `${descriptor.type}-resume`),
    title,
    cwd,
    projectLabel: projectLabelFor(hub, cwd),
    model: resolveModel(hub, turns),
    // File mtime is only a fallback. Workspace archive/migration can copy an
    // old transcript today; treating that copy time as conversation time makes
    // “最近 7 天” return years-old answers.
    updatedAt: Math.max(newestTurnAt, sessionUpdatedAt(hub)) || descriptor.mtime || 0,
    hubSessionId: hubIdOf(hub) || null,
    nativeSessionId: descriptor.nativeSessionId || null,
    meetingId: hub && hub.meetingId || null,
    transcriptPath: descriptor.filePath || null,
    codexSessionsRoot: descriptor.type === 'codex' ? (hub && hub.codexSessionsRoot || descriptor.root || null) : null,
    codexProfile: hub && hub.codexProfile || null,
    turnCount: (turns || []).length,
  };
}

function titleOnlySourceFromDescriptor(descriptor, options = {}) {
  let session;
  if (descriptor.type === 'meeting') {
    const meeting = descriptor.meeting || {};
    const title = String(meeting.title || '未命名群聊');
    const updatedAt = sessionUpdatedAt(meeting) || Number(descriptor.mtime) || 0;
    session = {
      key: descriptor.key,
      provider: 'meeting', nativeFamily: 'meeting', kind: 'meeting', title,
      cwd: meeting.workspace || null,
      projectLabel: meeting.workspaceLabel || projectLabelFor(null, meeting.workspace),
      model: null, updatedAt,
      hubSessionId: null, nativeSessionId: null,
      meetingId: descriptor.meetingId || null,
      transcriptPath: descriptor.filePath || null,
      codexSessionsRoot: null, codexProfile: null, turnCount: 0,
    };
  } else {
    const meta = descriptor.codexMeta || {};
    session = sessionRecordFromDescriptor(descriptor, [], { cwd: meta.cwd, slug: meta.slug });
  }
  return {
    key: descriptor.key,
    signature: String(options.signature || descriptor.signature || ''),
    stale: options.stale === true,
    searchable: descriptor.type === 'meeting' || !session.meetingId,
    session,
    docs: [{
      id: 'title', eventId: 'title', scope: 'title', role: 'title',
      text: session.title, ordinal: -1, timestamp: session.updatedAt,
    }],
  };
}

// 用户 2026-09-17 明确：只搜自然语言，绝不搜改动代码。工具 doc 因此只保留一行
// 可辨认的元信息（工具名 + 命令/路径开头），既不进全文索引也不再存正文 ——
// 实测它们此前占索引正文的 88%（2.84 亿字符，其中一半是 apply_patch 的文件内容）。
const TOOL_META_CHARS = 120;
function toolMetaText(value) {
  const flat = String(value || '').replace(/\s+/g, ' ').trim();
  return flat.length > TOOL_META_CHARS ? flat.slice(0, TOOL_META_CHARS) : flat;
}

function omitInlineBinary(value) {
  return String(value || '').replace(
    /(data:[^;,\s]+;base64,)[A-Za-z0-9+/_=-]{1024,}/gi,
    (_match, prefix) => `${prefix}[binary payload omitted]`,
  );
}

function toolText(toolCall) {
  if (!toolCall) return '';
  const parts = [];
  if (toolCall.name) parts.push(String(toolCall.name));
  if (toolCall.input != null) {
    try { parts.push(omitInlineBinary(typeof toolCall.input === 'string' ? toolCall.input : JSON.stringify(toolCall.input))); }
    catch { parts.push(String(toolCall.input)); }
  }
  return toolMetaText(parts.join(' '));
}

function docsFromTurns(turns, title, provider) {
  const docs = [{ id: 'title', eventId: 'title', scope: 'title', role: 'title', text: title, ordinal: -1, timestamp: 0 }];
  (turns || []).forEach((turn, ordinal) => {
    if (!turn || !turn.text) return;
    const isUser = turn.role === 'user';
    // 「我的提问」只收用户真正说的话。CLI 会把 AGENTS.md / CLAUDE.md 全文、
    // <system-reminder>、群聊脚手架这些当成 user 消息写进 transcript，搜索命中
    // 它们纯属噪声（用户 2026-08-28 反馈：搜「梦境」命中的是注入的 AGENTS.md 正文）。
    // 复用卡片视图那套判定，保证「搜到的」和「看到的」是同一份文本。
    const text = isUser ? searchableUserText(turn.text) : String(turn.text);
    if (!text) return;
    const eventId = String(turn.id || `${turn.role || 'turn'}-${ordinal}`);
    // Parsers that know source line numbers order text by its last source line.
    const start = Number.isFinite(turn.sourceIndex) ? turn.sourceIndex : ordinal;
    const end = Number.isFinite(turn.sourceEndIndex) ? turn.sourceEndIndex : start;
    docs.push({
      id: eventId, eventId,
      scope: isUser ? 'user' : 'assistant',
      role: isUser ? 'user' : 'assistant',
      speaker: isUser ? '我' : providerLabel(provider),
      text,
      ordinal: end,
      timestamp: Number(turn.tsEnd || turn.ts) || 0,
    });
    if (Array.isArray(turn.toolCalls)) {
      turn.toolCalls.forEach((call, toolIndex) => {
        const text = toolText(call);
        if (!text) return;
        docs.push({
          id: `${eventId}:tool:${toolIndex}`,
          eventId: `${eventId}:tool:${toolIndex}`,
          scope: 'tool', role: 'tool', speaker: providerLabel(provider),
          text, ordinal: start + (toolIndex + 1) / 1000,
          timestamp: Number(turn.tsEnd || turn.ts) || 0,
        });
      });
    }
  });
  return docs;
}

function codexToolDocFromRecord(record, ordinal) {
  const payload = record && record.payload && typeof record.payload === 'object' ? record.payload : null;
  const item = payload && payload.item && typeof payload.item === 'object' ? payload.item : payload;
  const type = String(item && item.type || payload && payload.type || '').toLocaleLowerCase();
  if (!/(tool|function|command|mcp|file|patch)/.test(type)) return null;
  const parts = [];
  for (const key of ['name', 'command', 'cmd', 'path', 'file_path', 'cwd', 'arguments', 'input']) {
    const value = item && item[key];
    if (value == null) continue;
    try { parts.push(omitInlineBinary(typeof value === 'string' ? value : JSON.stringify(value))); }
    catch { parts.push(String(value)); }
  }
  const text = toolMetaText(parts.join(' '));
  if (!text) return null;
  const eventId = `codex-tool-${record.timestamp || ordinal}-${shortHash(text)}`;
  return {
    id: eventId, eventId, scope: 'tool', role: 'tool', speaker: 'Codex',
    text, ordinal,
    timestamp: record.timestamp ? new Date(record.timestamp).getTime() : 0,
  };
}

function codexCommentaryDocFromRecord(record, ordinal) {
  const event = codexAgentMessageEventFromRecord(record);
  if (!event || event.completed || !event.text) return null;
  const eventId = `codex-commentary-${record.timestamp || ordinal}-${shortHash(event.text)}`;
  return {
    id: eventId, eventId, scope: 'assistant', role: 'assistant', speaker: 'Codex · 中间输出',
    text: event.text, ordinal,
    timestamp: event.completedAt || (record.timestamp ? new Date(record.timestamp).getTime() : 0),
  };
}

function streamJsonlRecordsSync(filePath, onRecord, chunkBytes = 1024 * 1024) {
  return streamCodexJsonlRecordsSync(filePath, onRecord, {
    profile: 'search',
    chunkBytes,
  });
}

function parseCodexRolloutStreaming(filePath) {
  const entries = [];
  const toolDocs = [];
  streamJsonlRecordsSync(filePath, (record, lineIndex) => {
    entries.push({ obj: record, index: lineIndex });
    const toolDoc = codexToolDocFromRecord(record, lineIndex + 0.5);
    if (toolDoc) toolDocs.push(toolDoc);
    const commentaryDoc = codexCommentaryDocFromRecord(record, lineIndex + 0.501);
    if (commentaryDoc) toolDocs.push(commentaryDoc);
  });
  return { turns: parseCodexRolloutEntries(entries), toolDocs };
}

// tool_result 行是 Claude transcript 里最大的一类（命令输出、图片 Base64），搜索只
// 索引工具调用本身，所以从信封前缀就丢掉，其余行全部解析。
function claudeSearchLineFilter(prefix, context = {}) {
  if (prefix.includes('"type":"tool_result"')) return false;
  const exhausted = context.final || (Number(context.prefixBytes) || 0) >= (Number(context.maxPrefixBytes) || 0);
  return exhausted ? true : null;
}

function streamJsonlEntriesSync(filePath, lineFilter, chunkBytes = 1024 * 1024) {
  const entries = [];
  const scanner = new JsonlByteScanner(record => entries.push(record), { lineFilter, maxPrefixBytes: 64 * 1024 });
  const fd = fs.openSync(filePath, 'r');
  try {
    const buffer = Buffer.allocUnsafe(chunkBytes);
    let position = 0;
    for (;;) {
      const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, position);
      if (bytesRead <= 0) break;
      scanner.push(bytesRead === buffer.length ? buffer : buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
  } finally {
    fs.closeSync(fd);
  }
  scanner.end({ flushFinal: true });
  return entries;
}

function parseClaudeDescriptor(descriptor, options = {}) {
  const turns = parseClaudeTranscriptEntries(streamJsonlEntriesSync(descriptor.filePath, claudeSearchLineFilter));
  const session = sessionRecordFromDescriptor(descriptor, turns);
  const docs = docsFromTurns(turns, session.title, descriptor.provider);
  if (docs[0]) docs[0].timestamp = session.updatedAt;
  return {
    key: descriptor.key, signature: descriptor.signature, session, docs,
    searchable: !session.meetingId, truncatedByReadGuard: false,
  };
}

function parseCodexDescriptor(descriptor, options = {}) {
  // Codex rollouts can be hundreds of MiB because image and tool output rows
  // embed Base64. Scan the full file once, but retain only dialogue and tool
  // call metadata from the JSON envelope. This preserves complete search
  // history without decoding binary transport rows or imposing a tail-only
  // feature downgrade.
  const streamed = parseCodexRolloutStreaming(descriptor.filePath);
  const turns = streamed.turns;
  const meta = descriptor.codexMeta || readCodexRolloutMeta(descriptor.filePath) || {};
  const session = sessionRecordFromDescriptor(descriptor, turns, { cwd: meta.cwd, slug: meta.slug });
  const docs = docsFromTurns(turns, session.title, descriptor.provider);
  const supplemental = streamed.toolDocs;
  docs.push(...supplemental.map(doc => doc.role === 'assistant'
    ? { ...doc, speaker: `${providerLabel(descriptor.provider)} · 中间输出` }
    : doc));
  if (docs[0]) docs[0].timestamp = session.updatedAt;
  return {
    key: descriptor.key, signature: descriptor.signature, session, docs,
    searchable: !session.meetingId,
    truncatedByReadGuard: false,
  };
}

/**
 * 朴素的 JSONL 分块读取。
 *
 * 不能复用 streamJsonlRecordsSync —— 那个包了 createCodexLineFilter，只认 Codex 的
 * `record_type: event_msg / response_item` 信封。Kimi 的记录是 `type: turn.prompt`
 * 之类，会被整条过滤掉（第一版就是这么写的，结果 11MB 的 wire 只解析出 1 条标题文档）。
 *
 * 超过 maxBytes 时读**尾部**并丢掉开头那半行：搜索关心的是最近的对话。
 */
function streamPlainJsonlSync(filePath, onRecord, maxBytes = 16 * 1024 * 1024) {
  let stat;
  try { stat = fs.statSync(filePath); } catch { return; }
  const start = stat.size > maxBytes ? stat.size - maxBytes : 0;
  const fd = fs.openSync(filePath, 'r');
  let index = 0;
  let carry = '';
  let skipFirstPartial = start > 0;
  try {
    const buffer = Buffer.allocUnsafe(Math.min(1024 * 1024, Math.max(1, stat.size - start)));
    let position = start;
    while (position < stat.size) {
      const bytesRead = fs.readSync(fd, buffer, 0, Math.min(buffer.length, stat.size - position), position);
      if (bytesRead <= 0) break;
      position += bytesRead;
      carry += buffer.subarray(0, bytesRead).toString('utf8');
      let newline = carry.indexOf('\n');
      while (newline >= 0) {
        const line = carry.slice(0, newline);
        carry = carry.slice(newline + 1);
        newline = carry.indexOf('\n');
        if (skipFirstPartial) { skipFirstPartial = false; index += 1; continue; }
        const trimmed = line.trim();
        if (trimmed) {
          let record = null;
          try { record = JSON.parse(trimmed); } catch { record = null; }
          if (record) onRecord(record, index);
        }
        index += 1;
      }
    }
  } finally {
    fs.closeSync(fd);
  }
  const tail = carry.trim();
  if (tail && !skipFirstPartial) {
    try { onRecord(JSON.parse(tail), index); } catch { /* 最后一行可能正在写入 */ }
  }
}

function kimiPromptText(input) {
  if (typeof input === 'string') return input;
  if (!Array.isArray(input)) return '';
  return input
    .map(part => (part && typeof part === 'object' ? (part.text || '') : String(part || '')))
    .filter(Boolean)
    .join('\n')
    .trim();
}

/**
 * Kimi 的 wire.jsonl 是事件流，不是回合数组。取三样东西：
 *   turn.prompt                            → 用户提问（干净的原始输入）
 *   loop_event content.part(type=text)     → AI 回答正文（按 step 聚合成一段）
 *   loop_event tool.call                   → 工具调用
 * 有意不取 context.append_message：那里的 role=user 混了大量 <system-reminder>
 * 注入，搜起来全是噪声。
 */
function parseKimiWire(filePath) {
  const turns = [];
  const toolDocs = [];
  let pending = null;                 // 正在累积的 AI 回合
  const flush = () => {
    if (!pending) return;
    const text = pending.chunks.join('\n').trim();
    if (text) turns.push({ id: pending.id, role: 'assistant', text, ts: pending.ts, tsEnd: pending.tsEnd || pending.ts });
    pending = null;
  };
  streamPlainJsonlSync(filePath, (record, lineIndex) => {
    if (!record || typeof record !== 'object') return;
    const time = Number(record.time || record.created_at) || 0;
    if (record.type === 'turn.prompt') {
      flush();
      const text = kimiPromptText(record.input);
      if (text) turns.push({ id: `prompt-${lineIndex}`, role: 'user', text, ts: time, tsEnd: time });
      return;
    }
    if (record.type !== 'context.append_loop_event' || !record.event) return;
    const event = record.event;
    if (event.type === 'content.part' && event.part && event.part.type === 'text' && event.part.text) {
      if (!pending) pending = { id: `assistant-${lineIndex}`, chunks: [], ts: time, tsEnd: time };
      pending.chunks.push(String(event.part.text));
      pending.tsEnd = time || pending.tsEnd;
      return;
    }
    if (event.type === 'tool.call') {
      const parts = [];
      for (const key of ['name', 'toolName', 'tool', 'command', 'path', 'file_path', 'cwd', 'arguments', 'input', 'args']) {
        const value = event[key] != null ? event[key] : (event.call && event.call[key]);
        if (value == null) continue;
        try { parts.push(omitInlineBinary(typeof value === 'string' ? value : JSON.stringify(value))); }
        catch { parts.push(String(value)); }
      }
      const text = toolMetaText(parts.join(' '));
      if (!text) return;
      const eventId = `kimi-tool-${lineIndex}-${shortHash(text)}`;
      toolDocs.push({
        id: eventId, eventId, scope: 'tool', role: 'tool', speaker: 'Kimi',
        text, ordinal: lineIndex + 0.5, timestamp: time,
      });
      return;
    }
    if (event.type === 'step.end') flush();
  });
  flush();
  return { turns, toolDocs };
}

function parseKimiDescriptor(descriptor) {
  const parsed = parseKimiWire(descriptor.filePath);
  const session = sessionRecordFromDescriptor(descriptor, parsed.turns);
  const docs = docsFromTurns(parsed.turns, session.title, 'kimi');
  docs.push(...parsed.toolDocs);
  if (docs[0]) docs[0].timestamp = session.updatedAt;
  return {
    key: descriptor.key, signature: descriptor.signature, session, docs,
    searchable: !session.meetingId, truncatedByReadGuard: false,
  };
}

function parseGeminiDescriptor(descriptor, options = {}) {
  const maxBytes = Math.max(256 * 1024, Number(options.maxJsonReadBytes) || DEFAULT_JSON_SOURCE_READ_BYTES);
  let data = null;
  try {
    const stat = fs.statSync(descriptor.filePath);
    // 单文件 JSON 没法尾读，超限就退化成只留标题，别把主进程拖住
    if (stat.size <= maxBytes) data = JSON.parse(fs.readFileSync(descriptor.filePath, 'utf8'));
  } catch { data = null; }
  if (!data || !Array.isArray(data.messages)) {
    return titleOnlySourceFromDescriptor(descriptor);
  }
  const turns = [];
  data.messages.forEach((message, index) => {
    if (!message || typeof message !== 'object') return;
    const text = Array.isArray(message.content)
      ? message.content.map(part => (part && part.text) || '').filter(Boolean).join('\n').trim()
      : String(message.content || message.text || '').trim();
    if (!text) return;
    const ts = Date.parse(message.timestamp || '') || 0;
    turns.push({
      id: String(message.id || `gemini-${index}`),
      role: message.type === 'user' ? 'user' : 'assistant',
      text, ts, tsEnd: ts,
    });
  });
  const session = sessionRecordFromDescriptor(descriptor, turns, {
    cwd: (descriptor.hubSession && descriptor.hubSession.geminiProjectRoot) || null,
  });
  if (!session.updatedAt) session.updatedAt = Date.parse(data.lastUpdated || data.startTime || '') || descriptor.mtime || 0;
  const docs = docsFromTurns(turns, session.title, 'gemini');
  if (docs[0]) docs[0].timestamp = session.updatedAt;
  return {
    key: descriptor.key, signature: descriptor.signature, session, docs,
    searchable: !session.meetingId, truncatedByReadGuard: false,
  };
}

function meetingSpeakerMap(data, maps) {
  const out = new Map();
  for (const sid of (Array.isArray(data.subSessions) ? data.subSessions : [])) {
    const session = maps.sessions.find(row => hubIdOf(row) === String(sid));
    if (!session) continue;
    out.set(String(sid), session.title || providerLabel(providerForHubSession(session)));
  }
  return out;
}

function parseMeetingDescriptor(descriptor, maps, options = {}) {
  const maxReadBytes = Math.max(256 * 1024, Number(options.maxJsonReadBytes) || DEFAULT_JSON_SOURCE_READ_BYTES);
  if (fs.statSync(descriptor.filePath).size > maxReadBytes) throw new Error('source_read_limit');
  const raw = JSON.parse(fs.readFileSync(descriptor.filePath, 'utf8'));
  const meta = { ...raw, ...(descriptor.meeting || {}) };
  // Older Hub restoration omitted workspace, then overlaid null onto an intact
  // meeting file. Retain the recorded project when live metadata has none.
  if (!meta.workspace && raw.workspace) meta.workspace = raw.workspace;
  if (!meta.workspaceLabel && raw.workspaceLabel && normalizePath(meta.workspace) === normalizePath(raw.workspace)) meta.workspaceLabel = raw.workspaceLabel;
  const timeline = Array.isArray(raw._timeline) ? raw._timeline : [];
  const title = String(meta.title || '未命名群聊');
  const speakers = meetingSpeakerMap(meta, maps);
  const updatedAt = Math.max(
    Number(meta.lastCompletedAt || meta.lastMessageTime || meta.updatedAt || descriptor.mtime) || 0,
    timeline.reduce((max, turn) => Math.max(max, Number(turn && turn.ts) || 0), 0),
  );
  const session = {
    key: descriptor.key,
    provider: 'meeting', nativeFamily: 'meeting', kind: 'meeting', title,
    cwd: meta.workspace || null,
    projectLabel: meta.workspaceLabel || projectLabelFor(null, meta.workspace),
    model: null, updatedAt,
    hubSessionId: null, nativeSessionId: null,
    meetingId: descriptor.meetingId,
    transcriptPath: descriptor.filePath,
    codexSessionsRoot: null, codexProfile: null,
    turnCount: timeline.length,
  };
  const docs = [{ id: 'title', eventId: 'title', scope: 'title', role: 'title', text: title, ordinal: -1, timestamp: updatedAt }];
  for (const turn of timeline) {
    if (!turn || !turn.text) continue;
    const role = turn.sid === 'user' ? 'user' : 'assistant';
    const eventId = `meeting-${descriptor.meetingId}-${turn.idx}`;
    docs.push({
      id: eventId, eventId,
      scope: role, role,
      speaker: role === 'user' ? '我' : (speakers.get(String(turn.sid)) || 'AI 成员'),
      text: String(turn.text),
      ordinal: Number.isFinite(Number(turn.idx)) ? Number(turn.idx) : docs.length,
      timestamp: Number(turn.ts) || 0,
    });
  }
  return { key: descriptor.key, signature: descriptor.signature, session, docs, searchable: true };
}

function parseSourceDescriptor(descriptor, maps, options = {}) {
  if (descriptor.type === 'claude') return parseClaudeDescriptor(descriptor, options);
  if (descriptor.type === 'codex') return parseCodexDescriptor(descriptor, options);
  if (descriptor.type === 'meeting') return parseMeetingDescriptor(descriptor, maps, options);
  if (descriptor.type === 'kimi') return parseKimiDescriptor(descriptor, options);
  if (descriptor.type === 'gemini') return parseGeminiDescriptor(descriptor, options);
  throw new Error(`Unsupported search source type: ${descriptor.type}`);
}

function isMetadataOnlySignature(signature) {
  // Include persisted signatures from before the complete title projection
  // fingerprint, so unavailable roots cannot make an old fallback hide itself.
  return /^(?:meta:|meta-time-v2:|meeting-meta:|title-only-v1:)/.test(String(signature || ''));
}

function titleOnlySources(maps, representedHubIds, representedMeetingIds) {
  const out = [];
  for (const session of maps.sessions) {
    const hubId = hubIdOf(session);
    const provider = providerForHubSession(session);
    if (!hubId || representedHubIds.has(hubId) || session.meetingId) continue;
    // 已支持的 AI 即使没有历史解析器，也保留标题和已有末段摘要。
    // 这不是完整正文索引；PowerShell 等非 AI 类型不进入模型筛选。
    if (!isAiKind(provider)) continue;
    const title = String(session.title || providerLabel(provider));
    const updatedAt = sessionUpdatedAt(session);
    const docs = [{ id: 'title', eventId: 'title', scope: 'title', role: 'title', text: title, ordinal: -1, timestamp: updatedAt }];
    if (session.lastOutputPreview) {
      docs.push({
        id: 'last-output-preview', eventId: 'last-output-preview',
        scope: 'assistant', role: 'assistant', speaker: providerLabel(provider),
        text: String(session.lastOutputPreview), ordinal: 0, timestamp: 0,
      });
    }
    out.push({
      key: `hub:${hubId}`,
      signature: `meta-time-v2:${metadataSignature(session)}`,
      searchable: true,
      session: {
        key: `hub:${hubId}`, provider,
        nativeFamily: session.ccSessionId ? 'claude' : session.codexSid ? 'codex' : provider,
        kind: session.kind || provider,
        title, cwd: session.cwd || null,
        projectLabel: projectLabelFor(session, session.cwd),
        model: resolveModel(session, []), updatedAt,
        hubSessionId: hubId,
        nativeSessionId: session.ccSessionId || session.codexSid || null,
        meetingId: null,
        transcriptPath: session.transcriptPath || null,
        codexSessionsRoot: session.codexSessionsRoot || null,
        codexProfile: session.codexProfile || null,
        turnCount: docs.length - 1,
      },
      docs,
    });
  }
  for (const [meetingId, meeting] of maps.meetings) {
    if (representedMeetingIds.has(meetingId)) continue;
    const title = String(meeting.title || '未命名群聊');
    const updatedAt = sessionUpdatedAt(meeting);
    out.push({
      key: `meeting:${meetingId}`,
      signature: `meeting-meta:${metadataSignature(meeting)}`,
      searchable: true,
      session: {
        key: `meeting:${meetingId}`, provider: 'meeting', nativeFamily: 'meeting', kind: 'meeting', title,
        cwd: meeting.workspace || null,
        projectLabel: meeting.workspaceLabel || projectLabelFor(null, meeting.workspace),
        model: null, updatedAt,
        hubSessionId: null, nativeSessionId: null, meetingId,
        transcriptPath: null, codexSessionsRoot: null, codexProfile: null, turnCount: 0,
      },
      docs: [{ id: 'title', eventId: 'title', scope: 'title', role: 'title', text: title, ordinal: -1, timestamp: updatedAt }],
    });
  }
  for (const source of out) {
    // A fallback may change without its title/last-message time changing (for
    // example lastOutputPreview). Hash the full searchable projection before
    // allowing a refresh to reuse its existing rows.
    source.signature = `title-only-v1:${stableJsonHash({ session: source.session, docs: source.docs })}`;
  }
  return out;
}

module.exports = {
  isMetadataOnlySignature,
  addExplicitTranscriptDescriptors,
  collectSourceDescriptors,
  createMetadataMaps,
  dedupeHubSessions,
  deriveTitle,
  docsFromTurns,
  metadataSignature,
  matchCodexHubSession,
  normalizePath,
  parseSourceDescriptor,
  parseCodexRolloutStreaming,
  preferredHubSession,
  recordDiscoveryError,
  providerForHubSession,
  providerForClaudeRoot,
  providerLabel,
  readBoundedJsonlTailText,
  statSignature,
  titleOnlySourceFromDescriptor,
  titleOnlySources,
};
