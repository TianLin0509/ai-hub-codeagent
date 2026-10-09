/**
 * Parse Codex CLI rollout JSONL files into the same normalized turn shape used
 * by the card view renderer.
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const {
  codexLineFilter,
  streamCodexJsonlRecordsSync,
} = require('./codex-rollout-reader.js');
const { isSyntheticUserEntry, isSyntheticUserText, displayUserText } = require('./synthetic-user-filter.js');
const {
  codexAgentMessageEventFromRecord,
  codexToolActivityEventFromRecord,
  codexUserMessageEventFromRecord,
  normalizeCodexItemType,
} = require('./transcript-payload-utils.js');
const { activityDetail, activityKind } = require('./turn-presentation.js');

const DEFAULT_CODEX_SESSIONS_ROOT = path.join(os.homedir(), '.codex', 'sessions');
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_TARGETED_DATE_DIRS = 7;
const MAX_SEMANTIC_CACHE_ENTRIES = 8;
const semanticCache = new Map();

function normalizePathForCompare(p) {
  if (!p) return '';
  try { return path.resolve(p).replace(/\\/g, '/').toLowerCase(); }
  catch { return String(p).replace(/\\/g, '/').toLowerCase(); }
}

function codexDateDir(sessionsRoot, atMs) {
  const date = new Date(atMs);
  if (!Number.isFinite(date.getTime())) return null;
  return path.join(
    sessionsRoot,
    String(date.getFullYear()),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
  );
}

function codexDateDirsForRange(sessionsRoot, startMs, endMs, paddingDays = 1) {
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return [];
  const start = new Date(Math.min(startMs, endMs) - paddingDays * DAY_MS);
  const end = new Date(Math.max(startMs, endMs) + paddingDays * DAY_MS);
  start.setHours(0, 0, 0, 0);
  end.setHours(0, 0, 0, 0);
  const count = Math.round((end.getTime() - start.getTime()) / DAY_MS) + 1;
  if (count < 1 || count > MAX_TARGETED_DATE_DIRS) return [];
  const dirs = [];
  for (let at = start.getTime(); at <= end.getTime(); at += DAY_MS) {
    const dir = codexDateDir(sessionsRoot, at);
    if (dir) dirs.push(dir);
  }
  return dirs;
}

function uuidV7Timestamp(uuid) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(uuid || ''))) {
    return null;
  }
  const timestamp = Number.parseInt(String(uuid).replace(/-/g, '').slice(0, 12), 16);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function readFirstLineSync(filePath, maxBytes = 512 * 1024) {
  let fd;
  try {
    fd = fs.openSync(filePath, 'r');
    const chunks = [];
    let total = 0;
    const buf = Buffer.alloc(64 * 1024);
    while (total < maxBytes) {
      const n = fs.readSync(fd, buf, 0, Math.min(buf.length, maxBytes - total), total);
      if (n <= 0) break;
      const slice = buf.subarray(0, n);
      const nl = slice.indexOf(0x0a);
      if (nl >= 0) {
        chunks.push(slice.subarray(0, nl));
        break;
      }
      chunks.push(Buffer.from(slice));
      total += n;
      // All metadata fields consumed by Hub are serialized before this large,
      // redundant prompt body. Stop reading as soon as its key is present;
      // projectCodexRolloutMetaFromPrefix does not require the JSON row to be
      // complete.
      const prefix = Buffer.concat(chunks, total);
      if (prefix.indexOf(Buffer.from('"base_instructions"')) >= 0) {
        return prefix.toString('utf8').replace(/\r$/, '');
      }
    }
    return Buffer.concat(chunks).toString('utf8').replace(/\r$/, '');
  } catch {
    return '';
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch {}
    }
  }
}

function extractJsonFieldValue(text, field, startAt = 0) {
  const escaped = String(field).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`"${escaped}"\\s*:`).exec(String(text || '').slice(startAt));
  if (!match) return undefined;
  let index = startAt + match.index + match[0].length;
  const source = String(text || '');
  while (index < source.length && /\s/.test(source[index])) index += 1;
  if (index >= source.length) return undefined;
  const first = source[index];
  let end = index;
  if (first === '"') {
    end += 1;
    let escapedChar = false;
    while (end < source.length) {
      const char = source[end];
      if (escapedChar) escapedChar = false;
      else if (char === '\\') escapedChar = true;
      else if (char === '"') { end += 1; break; }
      end += 1;
    }
  } else if (first === '{' || first === '[') {
    const close = first === '{' ? '}' : ']';
    let depth = 0;
    let inString = false;
    let escapedChar = false;
    while (end < source.length) {
      const char = source[end];
      if (inString) {
        if (escapedChar) escapedChar = false;
        else if (char === '\\') escapedChar = true;
        else if (char === '"') inString = false;
      } else if (char === '"') inString = true;
      else if (char === first) depth += 1;
      else if (char === close && --depth === 0) { end += 1; break; }
      end += 1;
    }
  } else {
    while (end < source.length && source[end] !== ',' && source[end] !== '}') end += 1;
  }
  if (end <= index || end > source.length) return undefined;
  try { return JSON.parse(source.slice(index, end)); } catch { return undefined; }
}

function projectCodexRolloutMetaFromPrefix(firstLinePrefix) {
  const recordType = extractJsonFieldValue(firstLinePrefix, 'type');
  if (recordType !== 'session_meta') return null;
  const payloadMarker = /"payload"\s*:\s*\{/.exec(firstLinePrefix);
  if (!payloadMarker) return null;
  const payloadAt = payloadMarker.index + payloadMarker[0].length;
  const baseInstructionsAt = firstLinePrefix.indexOf('"base_instructions"', payloadAt);
  const header = firstLinePrefix.slice(
    payloadAt,
    baseInstructionsAt >= 0 ? baseInstructionsAt : firstLinePrefix.length,
  );
  const meta = {};
  for (const field of [
    'session_id', 'id', 'forked_from_id', 'timestamp', 'cwd', 'originator',
    'cli_version', 'source', 'thread_source', 'model_provider', 'agent_path',
    'slug', 'parent_thread_id',
  ]) {
    const value = extractJsonFieldValue(header, field);
    if (value !== undefined) meta[field] = value;
  }
  return (meta.id || meta.session_id || meta.cwd) ? meta : null;
}

function readCodexRolloutMeta(filePath) {
  const first = readFirstLineSync(filePath);
  if (!first) return null;
  const projected = projectCodexRolloutMetaFromPrefix(first);
  if (projected) return projected;
  try {
    const record = JSON.parse(first);
    if (record?.type !== 'session_meta' || !record.payload || typeof record.payload !== 'object') return null;
    return record.payload;
  } catch {
    // A session_meta row may contain megabytes of base_instructions. The
    // identity/cwd/source fields are written before that payload, so project
    // only those fields from the bounded prefix instead of reading the line to
    // completion or rejecting an otherwise valid session.
    return null;
  }
}

function isCodexSubagentRolloutMeta(meta) {
  if (!meta || typeof meta !== 'object') return false;
  if (String(meta.thread_source || '').toLowerCase() === 'subagent') return true;
  if (meta.agent_path) return true;
  return !!(meta.source && typeof meta.source === 'object' && meta.source.subagent);
}

function isCodexTopLevelRolloutMeta(meta) {
  return !!meta && !isCodexSubagentRolloutMeta(meta);
}

function codexRolloutMetaMatchesSid(meta, codexSid) {
  if (!meta || !codexSid) return false;
  const expected = String(codexSid);
  return String(meta.id || '') === expected || String(meta.session_id || '') === expected;
}

function isUsableCodexRolloutPath(filePath, codexSid = null) {
  const meta = readCodexRolloutMeta(filePath);
  if (!isCodexTopLevelRolloutMeta(meta)) return false;
  return !codexSid || codexRolloutMetaMatchesSid(meta, codexSid);
}

function isCodexSubagentRolloutPath(filePath) {
  return isCodexSubagentRolloutMeta(readCodexRolloutMeta(filePath));
}

function toMs(timestamp) {
  if (!timestamp) return null;
  const ms = new Date(timestamp).getTime();
  return Number.isFinite(ms) ? ms : null;
}

function textFromContent(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((item) => {
      if (!item) return '';
      if (typeof item === 'string') return item;
      if (typeof item.text === 'string') return item.text;
      if (typeof item.content === 'string') return item.content;
      return '';
    }).filter(Boolean).join('\n');
  }
  if (content && typeof content === 'object') {
    if (typeof content.text === 'string') return content.text;
    if (typeof content.content === 'string') return content.content;
    if (Array.isArray(content.content)) return textFromContent(content.content);
  }
  return '';
}

function textFromPayload(payload) {
  if (!payload || typeof payload !== 'object') return '';
  return (
    textFromContent(payload.message) ||
    textFromContent(payload.text) ||
    textFromContent(payload.content) ||
    textFromContent(payload.input) ||
    textFromContent(payload.prompt)
  );
}

function _recordId(obj) {
  const payload = obj && obj.payload && typeof obj.payload === 'object' ? obj.payload : null;
  const candidates = [
    obj && obj.id,
    payload && payload.id,
    payload && payload.item && payload.item.id,
  ];
  for (const value of candidates) {
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return null;
}

function _stableRecordHash(obj) {
  // Card rendering de-duplicates by turn.id. A tail-window parse starts line
  // numbering at zero, so line indexes are not stable as a growing rollout's
  // 8 MB window moves. Hash semantic record data instead; identical records
  // now keep the same id in full, tail and later incremental parses.
  const payload = obj && obj.payload && typeof obj.payload === 'object' ? obj.payload : null;
  const raw = JSON.stringify([
    obj && obj.timestamp ? String(obj.timestamp) : '',
    obj && obj.type ? String(obj.type) : '',
    payload && payload.type ? String(payload.type) : '',
    payload && payload.item && payload.item.type ? String(payload.item.type) : '',
    payload && payload.item && payload.item.phase ? String(payload.item.phase) : '',
    payload && payload.turn_id ? String(payload.turn_id) : '',
    payload && payload.internal_chat_message_metadata_passthrough
      ? String(payload.internal_chat_message_metadata_passthrough.turn_id || '')
      : '',
    textFromPayload(payload),
    payload ? textFromContent(payload.last_agent_message) : '',
  ]);
  return crypto.createHash('sha256').update(raw).digest('hex').slice(0, 16);
}

function _makeTurnId(prefix, obj, index) {
  // A Codex turn_id can intentionally span multiple user steering messages
  // and multiple assistant commentary segments. It is therefore not a card
  // id. Prefer record-level ids; otherwise use timestamp + semantic hash.
  const recordId = _recordId(obj);
  if (recordId) return `${prefix}-${recordId}`;
  const ts = obj && obj.timestamp ? String(obj.timestamp) : 'no-ts';
  const hash = obj ? _stableRecordHash(obj) : `line-${index}`;
  return `${prefix}-${ts}-${hash}`;
}

function isInjectedContextText(text) {
  return isSyntheticUserText(text);
}

function hasNearbyEventUserDuplicate(entries, entryIndex, text) {
  const normalized = normalizeUserDuplicateText(text);
  if (!normalized) return false;
  const maxLookahead = Math.min(entries.length, entryIndex + 6);
  const sourceAt=toMs(entries[entryIndex]?.obj?.timestamp);
  for (let i = entryIndex + 1; i < maxLookahead; i++) {
    const obj = entries[i] && entries[i].obj;
    if(obj?.type==='response_item' && obj.payload?.role==='user') {
      if(isSyntheticUserEntry(obj,textFromPayload(obj.payload)))continue;
      break;
    }
    if(obj?.type==='event_msg' && ['task_started','agent_message','task_complete'].includes(obj.payload?.type))break;
    const userEvent = codexUserMessageEventFromRecord(obj);
    if (!userEvent) continue;
    if(isSyntheticUserEntry(obj,userEvent.text))continue;
    // Only the next user event can mirror this record. Never scan past a
    // different submission and accidentally claim a later repeated prompt.
    const near=!sourceAt || !userEvent.submittedAt || Math.abs(userEvent.submittedAt-sourceAt)<=2000;
    return near && normalizeUserDuplicateText(userEvent.text) === normalized;
  }
  return false;
}

function normalizeUserDuplicateText(text) {
  return require('./conversation-display').userTextIdentity(text);
}

function parseCodexRolloutEntries(entries) {
  const turns = [];
  let pendingAssistant = null;
  let totalUsage = null;

  // sourceIndex/sourceEndIndex are rollout line numbers, so search docs built
  // from turns share one ordering scale with per-record tool docs.
  const ensurePendingAssistant = (index) => {
    if (!pendingAssistant) {
      pendingAssistant = {
        sourceIndex: Number.isFinite(index) ? index : null,
        sourceEndIndex: null,
        id: null,
        ts: null,
        taskStartedAt: null,
        tsEnd: null,
        text: '',
        finalText: '',
        completed: false,
        durationMs: null,
        usageBaseline: totalUsage,
        usageInfo: null,
        context: null,
        hasTaskStart: false,
        agentMessages: [],
        displayMessages: [],
        toolCalls: [],
      };
    }
    if (Number.isFinite(index)) pendingAssistant.sourceEndIndex = index;
    return pendingAssistant;
  };

  const flushAssistant = () => {
    if (!pendingAssistant) return;
    const text = (pendingAssistant.finalText || pendingAssistant.agentMessages.join('\n\n') || '').trim();
    if (text || pendingAssistant.toolCalls.length) {
      if (pendingAssistant.completed) {
        pendingAssistant.toolCalls = pendingAssistant.toolCalls.map(tool => (
          tool.status === 'running' || tool.status === 'pending'
            ? { ...tool, status: 'completed', inferred: true }
            : tool
        ));
      }
      const usage = pendingAssistant.hasTaskStart && !pendingAssistant.usageInvalid
        ? require('./turn-speed-metrics').codexTurnUsage(
          pendingAssistant.turnUsage ? { input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0 } : pendingAssistant.usageBaseline,
          pendingAssistant.turnUsage ? { total_token_usage: pendingAssistant.turnUsage } : pendingAssistant.usageInfo) : null;
      turns.push(require('./turn-speed-metrics').withTurnSpeed({
        id: pendingAssistant.id || `codex-assistant-${turns.length}`,
        role: 'assistant',
        text,
        ts: pendingAssistant.ts,
        speedStartedAt: pendingAssistant.taskStartedAt,
        tsEnd: pendingAssistant.tsEnd || pendingAssistant.ts,
        stopReason: pendingAssistant.completed ? 'task_complete' : 'partial_commentary',
        // 与原生卡片同一字段：卡片据此显示「本轮已完成 / 已中断」。仍在进行的一轮留空。
        nativeOutcome: pendingAssistant.aborted ? 'interrupted' : pendingAssistant.completed ? 'completed' : null,
        durationMs: pendingAssistant.durationMs || undefined,
        ...(usage ? { usage } : {}),
        model: pendingAssistant.context?.model,
        providerTurnId: pendingAssistant.providerTurnId,
        speedTier: require('./turn-speed-metrics').speedTier(pendingAssistant.context?.service_tier),
        toolCalls: pendingAssistant.toolCalls,
        displayMessages: pendingAssistant.displayMessages,
        source: pendingAssistant.completed ? 'codex_rollout' : 'codex_rollout_streaming',
        sourceIndex: pendingAssistant.sourceIndex,
        sourceEndIndex: pendingAssistant.sourceEndIndex,
      }));
    }
    pendingAssistant = null;
  };

  const upsertTool = (pending, event) => {
    if (!pending || !event) return;
    const eventDetail = activityDetail(event.name, event.input);
    let index = pending.toolCalls.findIndex(tool => (
      (event.callId && (tool.callId === event.callId || tool.id === event.callId))
      || (event.id && tool.id === event.id)
    ));
    if (index < 0 && event.status !== 'running') {
      const sameKindCandidates = [];
      for (let i = pending.toolCalls.length - 1; i >= 0; i--) {
        const candidate = pending.toolCalls[i];
        if (!['running', 'pending'].includes(candidate.status)) continue;
        const candidateDetail = activityDetail(candidate.name, candidate.input);
        if ((eventDetail && candidateDetail === eventDetail)
            || (!eventDetail && normalizeCodexItemType(candidate.name) === normalizeCodexItemType(event.name))) {
          index = i;
          break;
        }
        if (activityKind(candidate.name, candidate.input) === activityKind(event.name, event.input)) {
          sameKindCandidates.push(i);
        }
      }
      // Unified exec records use different ids/names for the request and the
      // eventual CommandExecution item. When exactly one same-kind call is in
      // flight, it is the only safe correlation candidate.
      if (index < 0 && sameKindCandidates.length === 1) index = sameKindCandidates[0];
    }
    if (index >= 0) {
      const previous = pending.toolCalls[index];
      pending.toolCalls[index] = {
        ...previous,
        ...event,
        id: previous.id || event.id,
        callId: previous.callId || event.callId || null,
        name: event.name && event.name !== 'Tool' ? event.name : previous.name,
        input: event.input && (typeof event.input !== 'object' || Object.keys(event.input).length)
          ? event.input
          : previous.input,
      };
      return;
    }
    pending.toolCalls.push(event);
  };

  entries.forEach(({ obj, index }, entryIndex) => {
    if (obj.type === 'turn_context') {
      if (pendingAssistant && (!obj.payload?.turn_id || obj.payload.turn_id === pendingAssistant.providerTurnId))
        pendingAssistant.context = obj.payload || null;
      return;
    }
    if (obj.type === 'token_usage_record') {
      if (pendingAssistant?.hasTaskStart && obj.payload?.turn_id === pendingAssistant.providerTurnId
          && obj.payload?.turn_token_usage) pendingAssistant.turnUsage = obj.payload.turn_token_usage;
      return;
    }
    const toolEvent = codexToolActivityEventFromRecord(obj, index);
    if (toolEvent) {
      const pending = ensurePendingAssistant(index);
      pending.id = pending.id || _makeTurnId('codex-assistant', obj, index);
      pending.ts = pending.ts || toolEvent.startedAt || toMs(obj.timestamp);
      pending.tsEnd = toolEvent.completedAt || toMs(obj.timestamp) || pending.tsEnd;
      upsertTool(pending, toolEvent);
      return;
    }
    if (obj.type === 'event_msg') {
      const payload = obj.payload || {};
      const eventType = payload.type;
      if (eventType === 'token_count') {
        const info = payload.info;
        if (info?.total_token_usage) {
          if (pendingAssistant) {
            if (!pendingAssistant.usageBaseline && require('./turn-speed-metrics').codexTurnUsage(null, info)) {
              pendingAssistant.usageBaseline = { input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0 };
            }
            if (pendingAssistant.usageInfo && !require('./turn-speed-metrics').codexTurnUsage(
              pendingAssistant.usageInfo.total_token_usage, info)) pendingAssistant.usageInvalid = true;
            pendingAssistant.usageInfo = info;
          }
          totalUsage = info.total_token_usage;
        }
        return;
      }
      const userEvent = codexUserMessageEventFromRecord(obj);
      if (userEvent) {
        // Recent CLI starts a task before its user item. Retain that empty
        // task's timing/counter boundary rather than dropping it on receipt.
        if (!pendingAssistant?.hasTaskStart || pendingAssistant.agentMessages.length || pendingAssistant.toolCalls.length)
          flushAssistant();
        else { pendingAssistant.id = null; pendingAssistant.ts = null; }
        const raw = userEvent.text.trim();
        const text = raw && !isSyntheticUserEntry(obj, raw) ? displayUserText(raw) : null;
        if (text) {
          turns.push({
            id: _makeTurnId('codex-user', obj, index),
            role: 'user',
            text,
            ts: userEvent.submittedAt || toMs(obj.timestamp),
            sourceIndex: index,
          });
        }
        return;
      }
      if (eventType === 'task_started') {
        if (pendingAssistant && (pendingAssistant.finalText || pendingAssistant.agentMessages.length)) {
          flushAssistant();
        }
        const pending = ensurePendingAssistant(index);
        pending.id = pending.id || _makeTurnId('codex-assistant', obj, index);
        pending.ts = pending.ts || toMs(obj.timestamp);
        pending.hasTaskStart = true;
        pending.taskStartedAt = toMs(obj.timestamp);
        pending.providerTurnId = payload.turn_id || payload.turnId || null;
        return;
      }
      if (eventType === 'turn_aborted') {
        if (pendingAssistant) pendingAssistant.aborted = true;
        return;
      }
      if (eventType === 'task_complete' && pendingAssistant && !payload.error) {
        // Empty receipts still close the task and retain its last answer.
        pendingAssistant.completed = true;
        pendingAssistant.tsEnd = toMs(obj.timestamp);
        if (Number.isFinite(Number(payload.duration_ms))) pendingAssistant.durationMs = Number(payload.duration_ms);
      }
      const agentEvent = codexAgentMessageEventFromRecord(obj);
      if (agentEvent) {
        const pending = ensurePendingAssistant(index);
        pending.id = pending.id || _makeTurnId('codex-assistant', obj, index);
        pending.ts = pending.ts || toMs(obj.timestamp);
        pending.tsEnd = agentEvent.completedAt || toMs(obj.timestamp);
        const last = pending.displayMessages.at(-1);
        // task_complete is a receipt that can echo the preceding item. It is
        // not another message. Distinct provider items with identical text
        // are deliberately retained.
        const mirror = payload.type === 'task_complete' && last && last.text === agentEvent.text;
        const id = mirror ? last.id : _makeTurnId('codex-message', obj, index);
        const message = {id, text:agentEvent.text, phase:agentEvent.phase || 'message',
          providerTurnId:agentEvent.turnId,ts:toMs(obj.timestamp),tsEnd:agentEvent.completedAt};
        const found = pending.displayMessages.findIndex(m=>m.id===id);
        if(found < 0) pending.displayMessages.push(message);
        else pending.displayMessages[found] = {...message,ts:pending.displayMessages[found].ts};
        if (agentEvent.completed && payload.type === 'task_complete') pending.completed = true;
        if (agentEvent.phase === 'final_answer') pending.finalText = agentEvent.text;
        else pending.agentMessages.push(agentEvent.text);
        if (Number.isFinite(agentEvent.durationMs)) pending.durationMs = agentEvent.durationMs;
        return;
      }
    }

    if (obj.type === 'response_item' && obj.payload && obj.payload.role === 'user') {
      const raw = textFromPayload(obj.payload).trim();
      // 群聊里 Hub 发给成员的是一整段脚手架，用户真正打的字在 `## 用户` 段里，
      // 只显示那一段（displayUserText 同时兜住纯系统注入）。
      const text = raw && !isSyntheticUserEntry(obj, raw) ? displayUserText(raw) : null;
      if (text && !hasNearbyEventUserDuplicate(entries, entryIndex, text)) {
        if (!pendingAssistant?.hasTaskStart || pendingAssistant.agentMessages.length || pendingAssistant.toolCalls.length)
          flushAssistant();
        else { pendingAssistant.id = null; pendingAssistant.ts = null; }
        turns.push({
          id: _makeTurnId('codex-user', obj, index),
          role: 'user',
          text,
          ts: toMs(obj.timestamp),
          sourceIndex: index,
        });
      }
    }
  });

  flushAssistant();
  return turns;
}

function parseCodexRolloutText(raw) {
  const lines = raw.split(/\r?\n/);
  const entries = [];
  lines.forEach((line, index) => {
    const trimmed = line.trim();
    if (!trimmed || codexLineFilter(trimmed, { final: true }, 'turns') !== true) return;
    try {
      const obj = JSON.parse(trimmed);
      if (obj && typeof obj === 'object') entries.push({ obj, index });
    } catch {}
  });
  return parseCodexRolloutEntries(entries);
}

function applyTurnLimit(turns, limit, fromTail) {
  if (typeof limit === 'number' && limit < turns.length) {
    return fromTail ? turns.slice(turns.length - limit) : turns.slice(0, limit);
  }
  return turns;
}

function fileIdentity(stat) {
  return `${Number(stat && stat.dev) || 0}:${Number(stat && stat.ino) || 0}:${Math.round(Number(stat && stat.birthtimeMs) || 0)}`;
}

function touchSemanticCache(jsonlPath, value) {
  semanticCache.delete(jsonlPath);
  semanticCache.set(jsonlPath, value);
  while (semanticCache.size > MAX_SEMANTIC_CACHE_ENTRIES) {
    semanticCache.delete(semanticCache.keys().next().value);
  }
}

function scanSemanticEntries(jsonlPath, opts = {}) {
  const entries = [];
  const stats = streamCodexJsonlRecordsSync(jsonlPath, (obj, index) => {
    entries.push({ obj, index });
  }, {
    profile: 'turns',
    maxPrefixBytes: 256 * 1024,
    startOffset: opts.startOffset || 0,
    startLineIndex: opts.startLineIndex || 0,
  });
  return { entries, stats };
}

function loadSemanticTranscript(jsonlPath) {
  const stat = fs.statSync(jsonlPath);
  const identity = fileIdentity(stat);
  const previous = semanticCache.get(jsonlPath);
  if (previous
      && previous.identity === identity
      && previous.fileSize === stat.size
      && previous.mtimeMs === stat.mtimeMs) {
    touchSemanticCache(jsonlPath, previous);
    return previous;
  }

  let next;
  const appendOnlyGrowth = previous
    && previous.identity === identity
    && stat.size > previous.fileSize
    && previous.safeOffset <= previous.fileSize;
  if (appendOnlyGrowth) {
    const delta = scanSemanticEntries(jsonlPath, {
      startOffset: previous.safeOffset,
      startLineIndex: previous.nextLineIndex,
    });
    const entries = previous.entries.concat(delta.entries);
    next = {
      identity,
      fileSize: delta.stats.endOffset,
      mtimeMs: stat.mtimeMs,
      safeOffset: delta.stats.safeOffset,
      nextLineIndex: delta.stats.nextLineIndex,
      entries,
      turns: parseCodexRolloutEntries(entries),
      scanMode: 'incremental',
      scanStats: delta.stats,
      fullScans: previous.fullScans,
      incrementalScans: previous.incrementalScans + 1,
    };
  } else {
    const full = scanSemanticEntries(jsonlPath);
    next = {
      identity,
      fileSize: full.stats.endOffset,
      mtimeMs: stat.mtimeMs,
      safeOffset: full.stats.safeOffset,
      nextLineIndex: full.stats.nextLineIndex,
      entries: full.entries,
      turns: parseCodexRolloutEntries(full.entries),
      scanMode: 'full',
      scanStats: full.stats,
      fullScans: (previous ? previous.fullScans : 0) + 1,
      incrementalScans: previous ? previous.incrementalScans : 0,
    };
  }
  touchSemanticCache(jsonlPath, next);
  return next;
}

function parseCodexRolloutToTurns(jsonlPath, opts = {}) {
  const { limit, fromTail = false } = opts;
  if (typeof limit === 'number' && limit <= 0) return [];
  return applyTurnLimit(loadSemanticTranscript(jsonlPath).turns, limit, fromTail);
}

function clearCodexSemanticCache(jsonlPath = null) {
  if (jsonlPath) semanticCache.delete(jsonlPath);
  else semanticCache.clear();
}

function getCodexSemanticCacheStats(jsonlPath) {
  const entry = semanticCache.get(jsonlPath);
  if (!entry) return null;
  return {
    fileSize: entry.fileSize,
    safeOffset: entry.safeOffset,
    nextLineIndex: entry.nextLineIndex,
    semanticRecords: entry.entries.length,
    turns: entry.turns.length,
    scanMode: entry.scanMode,
    scanStats: { ...entry.scanStats },
    fullScans: entry.fullScans,
    incrementalScans: entry.incrementalScans,
  };
}

function findCodexRolloutBySid(codexSid, sessionsRoot = DEFAULT_CODEX_SESSIONS_ROOT) {
  if (!codexSid || !sessionsRoot) return null;
  const suffix = `-${codexSid}.jsonl`;
  let best = null;
  const visit = (dir, depth, maxDepth) => {
    if (depth > maxDepth) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        visit(full, depth + 1, maxDepth);
      } else if (ent.isFile() && ent.name.startsWith('rollout-') && ent.name.endsWith(suffix)) {
        if (!isUsableCodexRolloutPath(full, codexSid)) continue;
        let mtime = 0;
        try { mtime = fs.statSync(full).mtimeMs; } catch {}
        if (!best || mtime > best.mtime) best = { path: full, mtime };
      }
    }
  };
  const sidTimestamp = uuidV7Timestamp(codexSid);
  if (sidTimestamp !== null) {
    const dateDirs = codexDateDirsForRange(sessionsRoot, sidTimestamp, sidTimestamp, 1);
    for (const dir of dateDirs) visit(dir, 0, 0);
    if (best) return best.path;
  }
  // Compatibility fallback for custom/legacy roots whose files are not stored
  // in Codex's YYYY/MM/DD layout, or for malformed historical UUID metadata.
  visit(sessionsRoot, 0, 3);
  return best ? best.path : null;
}

function findCodexRolloutByCwd(cwd, sessionsRoot = DEFAULT_CODEX_SESSIONS_ROOT, opts = {}) {
  const targetCwd = normalizePathForCompare(cwd);
  if (!targetCwd || !sessionsRoot) return null;
  const sinceMs = Number.isFinite(opts.sinceMs) ? opts.sinceMs : null;
  const beforeMs = Number.isFinite(opts.beforeMs) ? opts.beforeMs : 10000;
  const afterMs = Number.isFinite(opts.afterMs) ? opts.afterMs : 300000;
  let best = null;
  const visit = (dir, depth, maxDepth) => {
    if (depth > maxDepth) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        visit(full, depth + 1, maxDepth);
        continue;
      }
      if (!ent.isFile() || !ent.name.startsWith('rollout-') || !ent.name.endsWith('.jsonl')) continue;
      let stat;
      try { stat = fs.statSync(full); } catch { continue; }
      const mtime = stat.mtimeMs || 0;
      if (sinceMs !== null && (mtime < sinceMs - beforeMs || mtime > sinceMs + afterMs)) continue;
      const meta = readCodexRolloutMeta(full);
      if (!isCodexTopLevelRolloutMeta(meta) || normalizePathForCompare(meta.cwd || '') !== targetCwd) continue;
      const distance = sinceMs === null ? null : Math.abs(mtime - sinceMs);
      if (!best
        || (distance !== null && (best.distance === null || distance < best.distance))
        || (distance !== null && distance === best.distance && mtime > best.mtime)
        || (distance === null && mtime > best.mtime)) {
        best = { path: full, mtime, distance };
      }
    }
  };
  if (sinceMs !== null) {
    const dateDirs = codexDateDirsForRange(
      sessionsRoot,
      sinceMs - beforeMs,
      sinceMs + afterMs,
      1,
    );
    let hasStructuredDateDir = false;
    for (const dir of dateDirs) {
      if (!fs.existsSync(dir)) continue;
      hasStructuredDateDir = true;
      visit(dir, 0, 0);
    }
    // When the standard date layout exists, every candidate in the requested
    // spawn-time window is confined to these day directories. A full-root
    // negative scan only blocks Electron's main thread without finding more.
    if (hasStructuredDateDir) return best ? best.path : null;
  }
  visit(sessionsRoot, 0, 3);
  return best ? best.path : null;
}

module.exports = {
  DEFAULT_CODEX_SESSIONS_ROOT,
  // codex-session-migrator 判定 alreadyCurrent 要用同一套路径比较口径，
  // 不导出的话那边只会再写一份不一致的实现。
  normalizePathForCompare,
  parseCodexRolloutToTurns,
  parseCodexRolloutText,
  parseCodexRolloutEntries,
  clearCodexSemanticCache,
  getCodexSemanticCacheStats,
  findCodexRolloutBySid,
  findCodexRolloutByCwd,
  readCodexRolloutMeta,
  isCodexSubagentRolloutMeta,
  isCodexTopLevelRolloutMeta,
  codexRolloutMetaMatchesSid,
  isUsableCodexRolloutPath,
  isCodexSubagentRolloutPath,
  textFromContent,
  isInjectedContextText,
};
