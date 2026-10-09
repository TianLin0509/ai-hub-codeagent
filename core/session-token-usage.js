'use strict';

// Consumption is separate from the context window. Cache/reasoning are subsets
// of input/output; neither is added a second time to the displayed total.
const count = value => Number.isSafeInteger(value) && value >= 0;
const optionalCount = value => value == null ? 0 : (count(value) ? value : null);

function codexUsage(total, source = 'codex', observedAt = Date.now()) {
  if (!total) return null;
  const input = total.inputTokens ?? total.input_tokens;
  const output = total.outputTokens ?? total.output_tokens;
  const tokens = total.totalTokens ?? total.total_tokens;
  const cached = optionalCount(total.cachedInputTokens ?? total.cached_input_tokens);
  const reasoning = optionalCount(total.reasoningOutputTokens ?? total.reasoning_output_tokens);
  if (![input, output, tokens, cached, reasoning].every(count)
      || tokens < input + output || cached > input || reasoning > output) return null;
  return { total: tokens, input, output, cached, cacheWrite: 0, reasoning, source, observedAt };
}

class ClaudeUsageLedger {
  constructor() {
    this.messages = new Map();
    this.sums = { total: 0, input: 0, output: 0, cached: 0, cacheWrite: 0, reasoning: 0 };
    this.partial = false;
  }

  accept(record) {
    if (record?.type !== 'assistant' || record.isSidechain === true || !record.message?.usage) return null;
    const message = record.message;
    const key = message.id || record.requestId;
    if (!key) { this.partial = true; return null; }
    const usage = message.usage;
    const fresh = optionalCount(usage.input_tokens);
    const output = optionalCount(usage.output_tokens);
    const cached = optionalCount(usage.cache_read_input_tokens);
    const cacheWrite = optionalCount(usage.cache_creation_input_tokens);
    if (![fresh, output, cached, cacheWrite].every(count)) { this.partial = true; return null; }
    const old = this.messages.get(key) || { fresh: 0, output: 0, cached: 0, cacheWrite: 0 };
    // Multiple content blocks share the same response id and cumulative usage.
    // Keep the fullest snapshot even when an older block is replayed later.
    const next = Object.fromEntries(Object.entries({ fresh, output, cached, cacheWrite })
      .map(([field, value]) => [field, Math.max(old[field], value)]));
    const inputDelta = next.fresh + next.cached + next.cacheWrite - old.fresh - old.cached - old.cacheWrite;
    this.sums.input += inputDelta;
    this.sums.output += next.output - old.output;
    this.sums.cached += next.cached - old.cached;
    this.sums.cacheWrite += next.cacheWrite - old.cacheWrite;
    this.sums.total = this.sums.input + this.sums.output;
    this.messages.set(key, next);
    return { ...this.sums, source: 'claude-transcript', observedAt: Date.now(), partial: this.partial };
  }
}

module.exports = { codexUsage, ClaudeUsageLedger };
