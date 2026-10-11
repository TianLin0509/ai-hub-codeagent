'use strict';

const fs = require('node:fs');
const { JsonlByteScanner } = require('./jsonl-byte-scanner.js');

const DEFAULT_CHUNK_BYTES = 1024 * 1024;
const DEFAULT_PREFIX_BYTES = 64 * 1024;
const MAX_CARD_ACTIVITY_LINE_BYTES = 256 * 1024;

const TURN_EVENT_TYPES = new Set([
  'user_message',
  'thread_goal_updated',
  'task_started',
  'agent_message',
  'task_complete',
  // 卡片要显示「本轮已中断」，与原生卡片的 nativeOutcome 对齐。
  'turn_aborted',
]);
const LIVE_EVENT_TYPES = new Set([
  ...TURN_EVENT_TYPES,
  'token_count',
  'turn_aborted',
]);

function normalizeType(value) {
  return String(value || '').replace(/[_-]/g, '').toLowerCase();
}

function firstStringField(text, field, startAt = 0) {
  const escaped = String(field).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`"${escaped}"\\s*:\\s*"([^"]+)"`).exec(String(text || '').slice(startAt));
  return match ? match[1] : null;
}

function objectStart(text, field, startAt = 0) {
  const escaped = String(field).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`"${escaped}"\\s*:\\s*\\{`).exec(String(text || '').slice(startAt));
  return match ? startAt + match.index + match[0].length : -1;
}

function inspectCodexEnvelope(prefix) {
  const text = String(prefix || '');
  const recordType = firstStringField(text, 'type');
  const payloadAt = objectStart(text, 'payload');
  const payloadType = payloadAt >= 0 ? firstStringField(text, 'type', payloadAt) : null;
  const itemAt = payloadAt >= 0 ? objectStart(text, 'item', payloadAt) : -1;
  const itemType = itemAt >= 0 ? firstStringField(text, 'type', itemAt) : null;
  const role = payloadAt >= 0 ? firstStringField(text, 'role', payloadAt) : null;
  return { recordType, payloadAt, payloadType, itemAt, itemType, role };
}

function isTurnItemType(value) {
  const normalized = normalizeType(value);
  return normalized === 'usermessage' || normalized === 'agentmessage';
}

function isCardActivityItemType(value) {
  const normalized = normalizeType(value);
  if (!normalized || isTurnItemType(normalized)) return false;
  return normalized === 'customtoolcall'
    || normalized === 'customtoolcalloutput'
    || normalized === 'functioncall'
    || normalized === 'functioncalloutput'
    || normalized === 'commandexecution'
    || normalized === 'filechange'
    || normalized === 'mcptoolcall'
    || normalized === 'websearch'
    || normalized === 'websearchcall'
    || normalized === 'dynamictoolcall';
}

function boundedActivityDecision(context = {}, prefixExhausted = false) {
  const bytes = Math.max(Number(context.lineBytes) || 0, Number(context.prefixBytes) || 0);
  if (bytes > MAX_CARD_ACTIVITY_LINE_BYTES) return false;
  if (prefixExhausted) return true;
  // Do not commit to retaining the row from its small envelope alone: command
  // stdout/tool output can make one JSONL record arbitrarily large. Hold only
  // a bounded prefix and keep the row iff it closes within the cap.
  return null;
}

function isSearchableToolCallType(value) {
  const normalized = normalizeType(value);
  if (!normalized || !/(tool|function|command|mcp|file|patch)/.test(normalized)) return false;
  // Output/result/end records are the dominant Base64 and raw tool-payload
  // carriers. Search indexes the corresponding call metadata, not its binary
  // transport body.
  return !/(output|result|(?:end|completed)$)/.test(normalized);
}

/**
 * Decide from the stable JSON envelope whether a Codex record is semantically
 * useful to a consumer. Returning false here lets the byte scanner discard a
 * multi-megabyte Base64 line without ever decoding or retaining its body.
 */
function codexLineFilter(prefix, context = {}, profile = 'turns') {
  const { final = false } = context;
  const prefixExhausted = final
    || (Number(context.prefixBytes) || 0) >= (Number(context.maxPrefixBytes) || DEFAULT_PREFIX_BYTES);
  const envelope = inspectCodexEnvelope(prefix);
  const recordType = envelope.recordType;
  if (!recordType) return prefixExhausted ? false : null;
  if (profile === 'turns' && recordType === 'token_usage_record') return boundedActivityDecision(context, prefixExhausted);

  if ((profile === 'live' || profile === 'turns') && recordType === 'turn_context'
      || profile === 'live' && recordType === 'turn_aborted') {
    return true;
  }

  if (recordType === 'event_msg') {
    const payloadType = envelope.payloadType;
    if (!payloadType) return prefixExhausted ? false : null;
    if (payloadType === 'item_completed') {
      if (!envelope.itemType) return prefixExhausted ? false : null;
      if (isTurnItemType(envelope.itemType)) return true;
      if (profile === 'turns' && isCardActivityItemType(envelope.itemType)) {
        return boundedActivityDecision(context, prefixExhausted);
      }
      return false;
    }
    if (profile === 'user') {
      return payloadType === 'user_message' || payloadType === 'thread_goal_updated';
    }
    if (profile === 'live') return LIVE_EVENT_TYPES.has(payloadType);
    if (profile === 'turns' && payloadType === 'token_count') return boundedActivityDecision(context, prefixExhausted);
    if (TURN_EVENT_TYPES.has(payloadType)) return true;
    if (profile === 'search' && isSearchableToolCallType(payloadType)) return true;
    return false;
  }

  if (recordType === 'response_item') {
    if (profile === 'live' || profile === 'user') return false;
    if (String(envelope.role || '').toLowerCase() === 'user') return true;
    if (profile === 'turns' && isCardActivityItemType(envelope.payloadType || envelope.itemType)) {
      return boundedActivityDecision(context, prefixExhausted);
    }
    if (profile === 'search') {
      const toolType = envelope.itemType || envelope.payloadType;
      // A read chunk can end between `"type":"message"` and `"role":"user"`.
      // Rejecting then would drop a user prompt depending on where the 1 MB
      // chunk (or an incremental scan's start) happened to fall.
      if (!envelope.role && normalizeType(toolType) === 'message' && !prefixExhausted) return null;
      if (toolType) return isSearchableToolCallType(toolType);
      return prefixExhausted ? false : null;
    }
    return false;
  }

  return false;
}

function createCodexLineFilter(profile = 'turns') {
  return (prefix, context) => codexLineFilter(prefix, context, profile);
}

function streamCodexJsonlRecordsSync(filePath, onRecord, opts = {}) {
  const stat = fs.statSync(filePath);
  const startOffset = Math.max(0, Math.min(stat.size, Number(opts.startOffset) || 0));
  const endOffset = Math.max(startOffset, Math.min(
    stat.size,
    Number.isFinite(Number(opts.endOffset)) ? Number(opts.endOffset) : stat.size,
  ));
  const chunkBytes = Math.max(64 * 1024, Number(opts.chunkBytes) || DEFAULT_CHUNK_BYTES);
  const scanner = new JsonlByteScanner(onRecord, {
    lineFilter: createCodexLineFilter(opts.profile || 'turns'),
    maxPrefixBytes: Math.max(8 * 1024, Number(opts.maxPrefixBytes) || DEFAULT_PREFIX_BYTES),
    startOffset,
    startLineIndex: Math.max(0, Number(opts.startLineIndex) || 0),
    discardLeadingPartialLine: opts.discardLeadingPartialLine === true,
  });
  const fd = fs.openSync(filePath, 'r');
  let position = startOffset;
  try {
    const buffer = Buffer.allocUnsafe(Math.min(chunkBytes, Math.max(1, endOffset - startOffset)));
    while (position < endOffset) {
      const wanted = Math.min(buffer.length, endOffset - position);
      const bytesRead = fs.readSync(fd, buffer, 0, wanted, position);
      if (bytesRead <= 0) break;
      scanner.push(bytesRead === buffer.length ? buffer : buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
  } finally {
    fs.closeSync(fd);
  }
  const result = scanner.end({ flushFinal: opts.flushFinal !== false });
  return {
    ...result,
    fileSize: stat.size,
    startOffset,
    endOffset: position,
    profile: opts.profile || 'turns',
  };
}

function readCodexSemanticRecordsSync(filePath, opts = {}) {
  const entries = [];
  const stats = streamCodexJsonlRecordsSync(filePath, (obj, index, meta) => {
    entries.push({ obj, index, meta });
  }, opts);
  return { entries, stats };
}

module.exports = {
  DEFAULT_CHUNK_BYTES,
  DEFAULT_PREFIX_BYTES,
  MAX_CARD_ACTIVITY_LINE_BYTES,
  codexLineFilter,
  createCodexLineFilter,
  inspectCodexEnvelope,
  isCardActivityItemType,
  isSearchableToolCallType,
  readCodexSemanticRecordsSync,
  streamCodexJsonlRecordsSync,
};
