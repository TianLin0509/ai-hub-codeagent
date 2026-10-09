'use strict';

// Claude transcript JSONL → 原生卡片同一套投影。
//
// PTY 跑的 Claude 不经过 stream-json，但它落盘的每一行和 stream-json 的
// assistant / user 帧几乎同形。把磁盘条目按「一次用户提问」分组成
// claude-native-transcript 的 record，交给同一个 claudeTranscriptTurns()，
// PTY 会话的卡片就与原生会话逐项一致：过程/结果分段、工具状态与耗时、
// 模型与用量、后台任务续写、中断与失败的结局。
//
// 结局只从记录本身判断，不猜：
//   end_turn 且带正文的 assistant 帧 → completed
//   "[Request interrupted by user…" → interrupted
//   API 错误条目（isApiErrorMessage）→ failed
//   后面已有新的提问、自己却没有终态 → completed（历史，已经不在跑）
//   最后一组没有终态 → 仍在运行，工具显示 running

const fs = require('node:fs');
const { isSyntheticUserEntry } = require('./synthetic-user-filter.js');
const { claudeTranscriptTurns } = require('./claude-native-transcript.js');
const { isToolResultEntry, claudeAssistantContentHasAnswerText, isClaudeTurnStopReasonTerminal } = require('./claude-transcript-parser.js');

const TAIL_WINDOW_BYTES = 8 * 1024 * 1024;

function toMs(value) {
  const ms = Date.parse(value || '');
  return Number.isFinite(ms) ? ms : null;
}

function userText(message) {
  const content = message && message.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter(block => block && block.type === 'text' && typeof block.text === 'string')
    .map(block => block.text).join('\n');
}

function isTaskNotification(entry, text) {
  return entry.origin?.kind === 'task-notification' || String(text || '').trimStart().startsWith('<task-notification>');
}

function isInterruptMarker(text) {
  return String(text || '').trimStart().startsWith('[Request interrupted by user');
}

function assistantText(message) {
  return (Array.isArray(message?.content) ? message.content : [])
    .filter(block => block && block.type === 'text').map(block => block.text || '').join('\n\n');
}

function newRecord(entry, text, nativeActivity, origin = null) {
  const at = toMs(entry.timestamp) || 0;
  const content = Array.isArray(entry.message?.content) ? entry.message.content : [{ type: 'text', text }];
  return {
    userMessageId: entry.uuid,
    submissionId: null,
    text,
    content,
    createdAt: at,
    completedAt: null,
    status: 'running',
    finalText: '',
    messages: new Map(),
    streams: new Map(),
    nativeActivity,
    origin: origin || (nativeActivity ? { kind: 'task-notification' } : null),
    lastAt: at,
  };
}

function settle(record, status) {
  if (record.status !== 'running') return;
  record.status = status;
  record.completedAt = record.lastAt || record.createdAt;
}

function claudeDiskRecords(entries) {
  const records = [];
  const scheduledFires = new Set();
  let current = null;
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object' || entry.isSidechain) continue;
    const at = toMs(entry.timestamp);
    // A native scheduled wakeup starts an independent background turn. Its
    // meta prompt is not a human question, but its answer must not overwrite
    // the previous human turn's final result.
    if (entry.type === 'system' && entry.subtype === 'scheduled_task_fire') {
      if (entry.uuid) scheduledFires.add(entry.uuid);
      if (current) settle(current, current.finalText ? 'completed' : 'interrupted');
      current = null;
      continue;
    }
    if (entry.type === 'user' && !isToolResultEntry(entry)) {
      const text = userText(entry.message);
      if (isInterruptMarker(text)) {
        if (current) { if (at) current.lastAt = at; settle(current, 'interrupted'); }
        continue;
      }
      const notification = isTaskNotification(entry, text);
      const scheduled = entry.isMeta === true && scheduledFires.has(entry.parentUuid);
      if (!notification && !scheduled && isSyntheticUserEntry(entry, text)) continue;
      if (!notification && !text.trim() && !(entry.message?.content || []).some?.(b => b && b.type === 'image')) continue;
      if (current) settle(current, current.finalText ? 'completed' : 'interrupted');
      current = newRecord(entry, text, notification || scheduled,
        scheduled ? { kind: 'scheduled-task', triggerId: entry.parentUuid } : null);
      records.push(current);
      continue;
    }
    if (!current || (entry.type !== 'assistant' && entry.type !== 'user')) continue;
    if (at) current.lastAt = at;
    const frame = { type: entry.type, uuid: entry.uuid, message: entry.message, parent_tool_use_id: null,
      timestamp: entry.timestamp, hubObservedAt: at || current.lastAt };
    current.messages.set(entry.uuid || entry.message?.id, frame);
    if (entry.type !== 'assistant') continue;
    if (entry.isApiErrorMessage) {
      current.finalText = assistantText(entry.message) || current.finalText;
      settle(current, 'failed');
      continue;
    }
    // 只有「终态 + 自带正文」才算答完；空正文的 end_turn 是交错思考的过程标记。
    if (isClaudeTurnStopReasonTerminal(entry.message?.stop_reason)
        && claudeAssistantContentHasAnswerText(entry.message?.content)) {
      current.finalText = assistantText(entry.message);
      current.status = 'completed';
      current.completedAt = at || current.lastAt;
    } else if (current.status === 'completed') {
      // 终态之后又写了新的 assistant 帧（stop hook 续写等）：本轮其实还在继续。
      current.status = 'running';
      current.completedAt = null;
    }
  }
  return records;
}

function readEntries(file, { fromTail = false } = {}) {
  let raw;
  let partial = false;
  if (fromTail) {
    const size = fs.statSync(file).size;
    if (size > TAIL_WINDOW_BYTES) {
      const fd = fs.openSync(file, 'r');
      try {
        const buffer = Buffer.alloc(TAIL_WINDOW_BYTES);
        fs.readSync(fd, buffer, 0, TAIL_WINDOW_BYTES, size - TAIL_WINDOW_BYTES);
        raw = buffer.toString('utf8');
        raw = raw.slice(raw.indexOf('\n') + 1);
        partial = true;
      } finally { fs.closeSync(fd); }
    }
  }
  if (raw === undefined) raw = fs.readFileSync(file, 'utf8');
  const entries = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try { entries.push(JSON.parse(trimmed)); } catch {}
  }
  return { entries, partial };
}

/**
 * 与 parseClaudeTranscriptToTurns 同样的调用约定（limit / fromTail），
 * 输出原生投影的卡片 turn。
 */
function parseClaudeTranscriptToNativeTurns(file, { limit, fromTail = false } = {}) {
  if (typeof limit === 'number' && limit <= 0) return [];
  let { entries, partial } = readEntries(file, { fromTail: fromTail && typeof limit === 'number' });
  let turns = claudeTranscriptTurns(claudeDiskRecords(entries));
  // 尾部窗口可能从一组提问的中间开始；凑不够就回退整文件，保证卡片 id 稳定。
  if (partial && turns.length <= limit) {
    ({ entries } = readEntries(file));
    turns = claudeTranscriptTurns(claudeDiskRecords(entries));
  } else if (partial) {
    turns = turns.slice(1);
  }
  if (typeof limit === 'number' && limit < turns.length) {
    turns = fromTail ? turns.slice(turns.length - limit) : turns.slice(0, limit);
  }
  return turns.map(turn => ({ ...turn, source: 'claude-transcript' }));
}

module.exports = { claudeDiskRecords, parseClaudeTranscriptToNativeTurns };
