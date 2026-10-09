'use strict';

const fs = require('fs');

const KIMI_TAIL_WINDOW_INITIAL_BYTES = 8 * 1024 * 1024;

function blocksText(blocks) {
  if (!Array.isArray(blocks)) return '';
  return blocks
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('');
}

function toMs(record) {
  const value = record && (record.timestamp || record.time || record.createdAt || record.created_at);
  if (typeof value === 'number' && Number.isFinite(value)) return value < 1e12 ? value * 1000 : value;
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function isToolFinish(reason) {
  return ['tool_calls', 'tool_call', 'tool_use'].includes(String(reason || '').toLowerCase());
}

function canonicalKimiModel(value) {
  const model = String(value || '').trim();
  if (!model) return null;
  if (/\bk3\b/i.test(model)) return 'kimi-code/k3';
  return model;
}

function kimiStepUsage(value) {
  if (!value || typeof value !== 'object') return null;
  const number = (key) => Number.isFinite(Number(value[key])) ? Number(value[key]) : 0;
  const inputTokens = number('inputOther') + number('inputCacheRead') + number('inputCacheCreation');
  const outputTokens = number('output');
  if (inputTokens <= 0 && outputTokens <= 0) return null;
  return { inputTokens, outputTokens };
}

function stableKimiRecordKey(record, fallback) {
  const candidates = [
    record && record.turnId,
    record && record.turn_id,
    record && record.id,
    record && record.uuid,
    record && record.time,
    record && record.timestamp,
  ];
  for (const value of candidates) {
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return String(fallback);
}

function coalesceKimiTurnCards(turns) {
  const out = [];
  const positions = new Map();
  for (const turn of turns) {
    if (turn && positions.has(turn.id)) {
      // A single Kimi prompt can emit more than one terminal step.end (notably
      // after a background agent reports and the parent writes its final
      // answer).  They are one logical assistant card; the later authoritative
      // snapshot should replace the earlier parser record in place.
      out[positions.get(turn.id)] = turn;
      continue;
    }
    if (turn) positions.set(turn.id, out.length);
    out.push(turn);
  }
  return out;
}

function parseKimiWireRecords(records) {
  const turns = [];
  let turnIndex = 0;
  let currentTurnKey = null;
  let turnText = '';
  let lastUserText = '';
  let currentAssistantTs = null;
  let currentPromptTs = null;
  let currentModel = null;
  let turnInputTokens = 0;
  let turnOutputTokens = 0;
  let turnContextTokens = 0;
  let outputUsageComplete = true;
  let toolCalls = [];
  const steps = new Map();

  for (const record of records) {
    if (!record || typeof record !== 'object') continue;
    if (record.type === 'config.update') {
      currentModel = canonicalKimiModel(record.modelAlias || record.model) || currentModel;
      continue;
    }
    if (record.type === 'usage.record') {
      currentModel = canonicalKimiModel(record.model) || currentModel;
      continue;
    }
    if (record.type === 'context.append_message' && record.message) {
      const text = blocksText(record.message.content).trim();
      if (record.message.role === 'user' && text) lastUserText = text;
      continue;
    }
    if (record.type === 'turn.prompt') {
      turnIndex += 1;
      currentTurnKey = stableKimiRecordKey(record, turnIndex);
      turnText = '';
      toolCalls = [];
      steps.clear();
      currentAssistantTs = null;
      currentPromptTs = toMs(record);
      turnInputTokens = 0;
      turnOutputTokens = 0;
      turnContextTokens = 0;
      outputUsageComplete = true;
      const text = (blocksText(record.input) || lastUserText).trim();
      if (text && (!record.origin || record.origin.kind === 'user')) {
        turns.push({
          id: `kimi-user-${currentTurnKey}`,
          role: 'user',
          text,
          ts: toMs(record),
          source: 'kimi_wire',
        });
      }
      continue;
    }
    if (record.type !== 'context.append_loop_event' || !record.event) continue;
    const event = record.event;
    // Kimi's native turnId restarts after some resume flows, even though the
    // same wire.jsonl keeps growing.  Do not overwrite the prompt-derived key
    // or a later resumed answer can replace an older card with the same turnId.
    // An event key is only a fallback for a tail fragment that lacks its prompt;
    // the tail-completeness guard below will force a full read before returning
    // such a fragment as a card.
    if (currentTurnKey == null && event.turnId !== undefined && event.turnId !== null) {
      currentTurnKey = stableKimiRecordKey(event, currentTurnKey || turnIndex);
    }
    const fallbackKey = `${event.turnId || turnIndex}:${event.step || ''}`;
    if (event.type === 'step.begin') {
      steps.set(event.uuid || fallbackKey, { text: '', hadTool: false });
      if (currentAssistantTs == null) currentAssistantTs = toMs(record);
      continue;
    }
    const stepKey = event.stepUuid || event.uuid || fallbackKey;
    const step = steps.get(stepKey) || { text: '', hadTool: false };
    if (event.type === 'content.part' && event.part && event.part.type === 'text' && typeof event.part.text === 'string') {
      step.text += event.part.text;
      steps.set(stepKey, step);
      continue;
    }
    if (event.type === 'tool.call') {
      step.hadTool = true;
      steps.set(stepKey, step);
      toolCalls.push({
        id: event.toolCallId || event.uuid || null,
        name: event.name || 'tool',
        input: event.args || {},
      });
      continue;
    }
    if (event.type === 'tool.result') {
      const call = toolCalls.find((item) => item.id && item.id === event.toolCallId);
      if (call) call.result = event.result;
      continue;
    }
    if (event.type !== 'step.end') continue;
    const ended = steps.get(event.uuid || stepKey) || step;
    const stepUsage = kimiStepUsage(event.usage);
    if (!event.usage || !Number.isSafeInteger(event.usage.output) || event.usage.output < 0) outputUsageComplete = false;
    if (stepUsage) {
      turnInputTokens += Math.max(0, stepUsage.inputTokens - (ended.usage?.inputTokens || 0));
      turnOutputTokens += Math.max(0, stepUsage.outputTokens - (ended.usage?.outputTokens || 0));
      turnContextTokens = stepUsage.inputTokens;
      ended.usage = stepUsage;
      steps.set(event.uuid || stepKey, ended);
    }
    if (ended.text) turnText += ended.text;
    if (isToolFinish(event.finishReason) || ended.hadTool) continue;
    const text = (ended.text || turnText).trim();
    if (!text && toolCalls.length === 0) continue;
    turns.push({
      id: `kimi-assistant-${currentTurnKey || stableKimiRecordKey(event, turnIndex)}`,
      role: 'assistant',
      text,
      ts: currentAssistantTs,
      speedStartedAt: currentPromptTs,
      tsEnd: toMs(record),
      stopReason: event.finishReason || 'completed',
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      model: currentModel || undefined,
      outputUsageComplete,
      usage: (turnInputTokens > 0 || turnOutputTokens > 0) ? {
        input_tokens: turnInputTokens,
        output_tokens: turnOutputTokens,
        context_tokens: turnContextTokens,
        context_window: currentModel === 'kimi-code/k3' ? 1_048_576 : undefined,
      } : undefined,
      source: 'kimi_wire',
    });
  }
  return coalesceKimiTurnCards(turns).map(turn => {
    const turnSpeed = ['stop', 'completed', 'end_turn'].includes(turn.stopReason)
      ? require('./turn-speed-metrics').measureTurnSpeed({ ...turn, nativeOutcome: 'completed' }) : null;
    return turnSpeed ? { ...turn, turnSpeed } : turn;
  });
}

function parseKimiWireText(text) {
  const records = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try { records.push(JSON.parse(line)); } catch {}
  }
  return parseKimiWireRecords(records);
}

function readKimiTailWindowText(wirePath, maxBytes) {
  const stat = fs.statSync(wirePath);
  if (stat.size <= maxBytes) return fs.readFileSync(wirePath, 'utf8');
  const start = stat.size - maxBytes;
  const fd = fs.openSync(wirePath, 'r');
  try {
    const buffer = Buffer.alloc(maxBytes);
    fs.readSync(fd, buffer, 0, buffer.length, start);
    const text = buffer.toString('utf8');
    const newline = text.indexOf('\n');
    return newline >= 0 ? text.slice(newline + 1) : '';
  } finally {
    fs.closeSync(fd);
  }
}

function applyKimiLimit(turns, opts) {
  const limit = Number(opts.limit);
  if (!Number.isFinite(limit) || limit <= 0 || turns.length <= limit) return turns;
  return opts.fromTail === false ? turns.slice(0, limit) : turns.slice(turns.length - limit);
}

// Kimi wire files can also exceed the byte window within one long tool/agent
// turn.  If the first parsed item is an assistant suffix, returning it would
// replace the already-rendered full card with truncated text after resume.
// Only trust a boundary-aligned tail, or a tail whose incomplete first turn is
// guaranteed to be sliced away.
function isKimiTailSliceComplete(turns, limit) {
  if (!Array.isArray(turns) || turns.length < limit) return false;
  if (turns.length > limit) return true;
  return turns.length > 0 && turns[0].role === 'user';
}

function parseKimiWireToTurns(wirePath, opts = {}) {
  const limit = Number(opts.limit);
  if (opts.fromTail !== false && Number.isFinite(limit) && limit > 0) {
    const stat = fs.statSync(wirePath);
    if (stat.size > KIMI_TAIL_WINDOW_INITIAL_BYTES) {
      const tailTurns = parseKimiWireText(readKimiTailWindowText(wirePath, KIMI_TAIL_WINDOW_INITIAL_BYTES));
      if (isKimiTailSliceComplete(tailTurns, limit)) return applyKimiLimit(tailTurns, opts);
    }
  }
  return applyKimiLimit(parseKimiWireText(fs.readFileSync(wirePath, 'utf8')), opts);
}

module.exports = {
  KIMI_TAIL_WINDOW_INITIAL_BYTES,
  parseKimiWireText,
  parseKimiWireRecords,
  parseKimiWireToTurns,
};
