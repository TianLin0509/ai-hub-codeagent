'use strict';
const { displayUserText } = require('./synthetic-user-filter');
const END = new Set(['completed', 'failed', 'interrupted']);

function captureClaudeMessage(record, frame) {
  if (!record.messages) record.messages = new Map();
  if (!record.streams) record.streams = new Map();
  if (frame.type === 'stream_event') {
    const event = frame.event || {};
    const key = frame.parent_tool_use_id || 'root';
    if (event.type === 'message_start') {
      record.streams.set(key, { type: 'assistant', partial: true, uuid: event.message.id,
        parent_tool_use_id: frame.parent_tool_use_id, message: { ...event.message, content: [] } });
    }
    const stream = record.streams.get(key);
    if (!stream) return;
    if (event.type === 'content_block_start') stream.message.content[event.index] = { ...event.content_block };
    const block = stream.message.content[event.index];
    if (event.type === 'content_block_delta' && block) {
      if (event.delta.type === 'text_delta') block.text = (block.text || '') + event.delta.text;
      else if (event.delta.type === 'thinking_delta') block.thinking = (block.thinking || '') + event.delta.thinking;
      else if (event.delta.type === 'input_json_delta') block.partialInput = (block.partialInput || '') + event.delta.partial_json;
    }
    return;
  }
  if (frame.type === 'assistant' || frame.type === 'user') {
    // Cards show a clock per row and a duration per tool call. The engine
    // stamps most frames; anything unstamped is timed on arrival rather than
    // inheriting the turn's start, which would make every row read alike.
    if (!frame.hubObservedAt) frame.hubObservedAt = Date.parse(frame.timestamp || '') || Date.now();
    record.messages.set(frame.uuid || frame.message?.id, frame);
    if (frame.type === 'assistant') {
      for (const [key, stream] of record.streams) {
        if (stream.message.id === frame.message?.id) record.streams.delete(key);
      }
    }
  }
}

// A task-notification turn is the engine resuming work for a background task
// that an earlier human turn started. Codex shows that as more progress rows in
// the same card; Claude used to open a new card per notification and label it
// "后台活动". The activity keeps its own runtime identity (it never settles the
// human submission), but for display it continues the last human turn that had
// already settled when it began. An activity injected while a human turn is
// still running stays standalone: its text must never read as that answer.
const CONTINUATION_ORIGINS = new Set(['task-notification']);
function groupClaudeRecords(records) {
  const groups = [];
  let human = null;
  for (const record of records) {
    if (!record.nativeActivity) { human = { record, continuations: [] }; groups.push(human); continue; }
    const settledBefore = human && END.has(human.record.status)
      && (human.record.completedAt || 0) <= (record.createdAt || 0);
    if (settledBefore && CONTINUATION_ORIGINS.has(record.origin?.kind)) human.continuations.push(record);
    else groups.push({ record, continuations: [] });
  }
  return groups;
}
// The live refresh reads a bounded tail. Slicing raw records could cut a
// continuation from its human turn and make it flicker into a standalone card.
function tailClaudeRecords(records, count) {
  return groupClaudeRecords(records).slice(-count).flatMap(group => [group.record, ...group.continuations]);
}

function projectClaudeRecord(record) {
  const source = 'claude-stream-json';
  const id = record.userMessageId;
  const user = record.nativeActivity ? null : { id, role: 'user', text: displayUserText(record.text), ts: record.createdAt,
    source, clientSubmissionId: record.submissionId, deliveryStatus: record.status, receiptAccepted: record.accepted === true,
    attachments: (record.content || []).filter(block => block.type !== 'text') };
  const frames = [...(record.messages?.values() || []), ...(record.streams?.values() || [])];
  const toolCalls = new Map();
  const results = new Map();
  const text = []; const thinking = [];
  const displayByMessage = new Map();
  for (const frame of frames) {
    if (frame.type === 'assistant' && !frame.parent_tool_use_id) {
      const messageId = frame.message?.id || frame.uuid;
      const body = (frame.message?.content || []).filter(b => b?.type === 'text').map(b => b.text || '').join('\n\n');
      if (messageId && body) {
        const previous = displayByMessage.get(messageId);
        displayByMessage.set(messageId, { id: `${id}:message:${messageId}`, itemId: messageId,
          clientSubmissionId: record.submissionId, userMessageId: id, providerTurnId: null,
          text: previous ? previous.text + '\n\n' + body : body,
          phase: frame.message.stop_reason === 'end_turn' ? 'final_answer' : 'commentary',
          // stop_reason describes engine control, not the value of the prose.
          // Foreground explanations remain readable even before a tool runs.
          // Automatic background commentary still belongs in the process drawer.
          displayVisibility: !record.nativeActivity || frame.message.stop_reason === 'end_turn'
            ? 'body' : 'process',
          // A message is an instant, not an interval: without its own end the
          // row would inherit the turn's and show a meaningless sub-second
          // duration next to the answer.
          ts: frame.hubObservedAt || record.createdAt,
          tsEnd: frame.hubObservedAt || record.createdAt });
      }
    }
    for (const block of frame.message?.content || []) {
      if (!block) continue;
      if (block.type === 'tool_result') results.set(block.tool_use_id, { block, at: frame.hubObservedAt || null });
      if (frame.type !== 'assistant') continue;
      if (block.type === 'text' && !frame.parent_tool_use_id) text.push(block.text || '');
      if (block.type === 'thinking') thinking.push(block.thinking || '');
      if (block.type === 'tool_use') toolCalls.set(block.id, { id: block.id, callId: block.id,
        name: block.name, input: block.partialInput || block.input, startedAt: frame.hubObservedAt || null,
        parentToolUseId: frame.parent_tool_use_id || null, status: END.has(record.status) ? 'unknown' : 'running' });
    }
  }
  for (const [toolId, tool] of toolCalls) {
    const entry = results.get(toolId);
    if (!entry) continue;
    const result = entry.block;
    Object.assign(tool, { output: result.content, isError: result.is_error === true,
      status: result.is_error ? 'failed' : 'completed', completedAt: entry.at,
      ...(tool.startedAt && entry.at && entry.at >= tool.startedAt ? { durationMs: entry.at - tool.startedAt } : {}) });
  }
  const terminal = END.has(record.status);
  const answer = terminal ? record.finalText || '' : text.join('\n\n');
  const displayMessages = [...displayByMessage.values()];
  const finalMessage = terminal && displayMessages.findLast(m => m.text === answer);
  // Each native end_turn reply remains a visible answer, including when the
  // engine later resumes work. Mark a fallback settled answer without
  // demoting already delivered replies into the process drawer.
  if (finalMessage) finalMessage.phase = 'final_answer';
  if (terminal && answer && !displayMessages.some(m => m.text === answer)
      && displayMessages.map(m => m.text).join('\n\n') !== answer) {
    displayMessages.push({ id: `${id}:result`, text: answer, phase: 'final_answer',
      clientSubmissionId: record.submissionId, userMessageId: id, providerTurnId: null,
      ts: record.completedAt || record.createdAt, tsEnd: record.completedAt || record.createdAt });
  }
  const assistant = (answer || thinking.length || toolCalls.size || terminal) ? { id: id + ':assistant',
    role: 'assistant', kind: 'claude', text: answer, thinking: thinking.join('\n\n'),
    toolCalls: [...toolCalls.values()], ts: record.createdAt, tsEnd: record.completedAt || null,
    source, displayMessages, clientSubmissionId: record.submissionId, userMessageId: id,
    ...require('./claude-turn-metrics').claudeTurnMetrics(record, frames),
    nativeActivity: record.nativeActivity || false, nativeOrigin: record.origin || null,
    stopReason: terminal ? record.status : null, nativeOutcome: terminal ? record.status : null } : null;
  return { user, assistant };
}

// All delivered replies keep their phases and ids as background work resumes.
// The compact chat renderer combines these answers in one stable message.
function mergeContinuations(head, continuations) {
  if (!continuations.length) return head;
  const merged = { ...head, displayMessages: [...head.displayMessages], toolCalls: [...head.toolCalls],
    continuations: continuations.map(c => c.record.userMessageId) };
  const thinking = [head.thinking];
  for (const { assistant, record } of continuations) {
    if (!assistant) continue;
    merged.displayMessages.push(...assistant.displayMessages);
    merged.toolCalls.push(...assistant.toolCalls);
    if (assistant.thinking) thinking.push(assistant.thinking);
    if (assistant.model) merged.model = assistant.model;
    if (assistant.usage) {
      merged.usage = { ...assistant.usage,
        input_tokens: (merged.usage?.input_tokens || 0) + assistant.usage.input_tokens,
        output_tokens: (merged.usage?.output_tokens || 0) + assistant.usage.output_tokens };
    }
    merged.outputUsageComplete = merged.outputUsageComplete && assistant.outputUsageComplete;
    if (merged.speedTier !== assistant.speedTier) merged.speedTier = null;
    // A continuation is part of this displayed turn; preserve the elapsed
    // interval rather than retaining only the first query's engine duration.
    delete merged.durationMs;
    const terminal = END.has(record.status);
    if (terminal && assistant.text) merged.text = assistant.text;
    merged.tsEnd = terminal ? record.completedAt || merged.tsEnd : null;
    merged.stopReason = terminal ? record.status : null;
    merged.nativeOutcome = terminal ? record.status : null;
  }
  merged.thinking = thinking.filter(Boolean).join('\n\n');
  return merged;
}

function claudeTranscriptTurns(records) {
  const cards = [];
  for (const group of groupClaudeRecords(records)) {
    const head = projectClaudeRecord(group.record);
    if (head.user) cards.push(head.user);
    const continuations = group.continuations.map(record => ({ record, assistant: projectClaudeRecord(record).assistant }));
    if (head.assistant) cards.push(mergeContinuations(head.assistant, continuations));
    else for (const { assistant } of continuations) if (assistant) cards.push(assistant);
  }
  return cards.map(require('./turn-speed-metrics').withTurnSpeed);
}

function claudeDisplayMessages(record) {
  return record ? require('./conversation-display').displayTurns(claudeTranscriptTurns([record]))
    .filter(m => m.role === 'assistant' && (m.text || m.toolCalls?.length || m.thinking)) : [];
}

module.exports = { CONTINUATION_ORIGINS, captureClaudeMessage, claudeTranscriptTurns, claudeDisplayMessages, groupClaudeRecords, tailClaudeRecords };
