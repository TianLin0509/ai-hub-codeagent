'use strict';

const count = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
function inputTokens(usage) {
  return count(usage?.input_tokens) + count(usage?.cache_read_input_tokens) + count(usage?.cache_creation_input_tokens);
}
// One API call per message id: it starts when its request could be sent (the
// prompt, or the latest tool result before it) and ends at its last frame.
// Frames keep transcript order, so tool results between calls advance the
// start; sub-agent frames carry their parent tool id and stay outside.
function claudeGeneration(record, frames) {
  const { addGenerationCall } = require('./turn-speed-metrics');
  const calls = new Map();
  let mark = record.createdAt;
  for (const frame of frames) {
    const at = frame.hubObservedAt;
    if (!Number.isFinite(at) || frame.partial || frame.parent_tool_use_id) continue;
    if (frame.type === 'user') {
      if ((frame.message?.content || []).some?.(block => block?.type === 'tool_result')) mark = Math.max(mark, at);
      continue;
    }
    const id = frame.type === 'assistant' && frame.message?.id;
    if (!id) continue;
    const call = calls.get(id) || { startedAt: mark, endedAt: at, outputTokens: 0 };
    call.endedAt = Math.max(call.endedAt, at);
    call.outputTokens = Math.max(call.outputTokens, frame.message.usage?.output_tokens ?? -1);
    calls.set(id, call);
    mark = Math.max(mark, at);
  }
  let generation = null;
  for (const call of calls.values()) generation = addGenerationCall(generation, call);
  return generation && !generation.invalid ? generation : null;
}

// Result usage is the sum of API calls; the last assistant call describes
// context occupancy. Never present the summed inputs as a context percentage.
function claudeTurnMetrics(record, frames) {
  const messages = new Map();
  for (const frame of frames) {
    if (frame.type === 'assistant' && !frame.parent_tool_use_id && frame.message?.id) {
      const old = messages.get(frame.message.id);
      const message = frame.message;
      messages.set(message.id, old?.usage && (!message.usage
        || count(old.usage.output_tokens) > count(message.usage.output_tokens))
        ? { ...message, usage: old.usage } : message);
    }
  }
  const calls = [...messages.values()];
  const last = calls.findLast(message => message.usage);
  const model = record.model || calls.findLast(message => message.model)?.model;
  const result = record.result || {};
  const usage = record.usage || result.usage;
  const contextWindow = result.modelUsage?.[model]?.contextWindow;
  const duration = record.durationMs ?? result.duration_ms;
  const modes = new Set(calls.map(message => require('./turn-speed-metrics').speedTier(message.usage?.speed)));
  return {
    speedTier: require('./turn-speed-metrics').speedTier(record.speedTier)
      || (modes.size === 1 ? [...modes][0] : null),
    outputUsageComplete: usage ? Number.isSafeInteger(usage.output_tokens) && usage.output_tokens >= 0
      : calls.length > 0 && calls.every(message => Number.isSafeInteger(message.usage?.output_tokens) && message.usage.output_tokens >= 0),
    ...(model ? { model } : {}),
    ...(usage || last ? { usage: {
      input_tokens: usage ? inputTokens(usage) : calls.reduce((sum, message) => sum + inputTokens(message.usage), 0),
      output_tokens: usage ? count(usage.output_tokens) : calls.reduce((sum, message) => sum + count(message.usage?.output_tokens), 0),
      context_tokens: last ? inputTokens(last.usage) : null,
      ...(count(contextWindow) > 0 ? { context_window: contextWindow } : {}),
    } } : {}),
    ...(typeof duration === 'number' && Number.isFinite(duration) && duration >= 0 ? { durationMs: duration } : {}),
    generation: claudeGeneration(record, frames),
  };
}

module.exports = { claudeTurnMetrics, inputTokens };
