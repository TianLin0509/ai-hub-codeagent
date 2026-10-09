'use strict';

const count = value => Number.isSafeInteger(value) && value >= 0;
function speedTier(value) {
  const tiers = { fast: 'fast', priority: 'fast', standard: 'standard', default: 'standard', flex: 'flex' };
  return Object.hasOwn(tiers, value) ? tiers[value] : null;
}

// This measures a complete agent turn, including waiting and tools. It is
// deliberately not an estimate of the provider's pure decoding throughput.
function measureTurnSpeed(turn) {
  if (turn?.role !== 'assistant' || turn.nativeOutcome !== 'completed' || turn.outputUsageComplete === false) return null;
  const output = turn.usage?.output_tokens;
  const startedAt = Object.hasOwn(turn, 'speedStartedAt') ? turn.speedStartedAt : turn.ts, endedAt = turn.tsEnd;
  if (!count(output) || output === 0 || !Number.isFinite(startedAt) || startedAt <= 0
      || !Number.isFinite(endedAt) || endedAt <= startedAt) return null;
  const elapsedMs = endedAt - startedAt;
  const tokensPerSecond = output * 1000 / elapsedMs;
  if (!Number.isFinite(tokensPerSecond)) return null;
  return { outputTokens: output, elapsedMs, startedAt, endedAt, tokensPerSecond,
    speedTier: speedTier(turn.speedTier),
    includesReasoning: count(turn.usage?.reasoning_output_tokens) && turn.usage.reasoning_output_tokens > 0 };
}

// Codex's last usage is one model call, not the entire agent turn. Subtract
// session counters at the two boundaries; never pair last-call tokens with
// the whole turn's duration. A truncated history without a baseline is unknown.
function codexTurnUsage(baseline, info) {
  const total = info?.total_token_usage || info?.total;
  const last = info?.last_token_usage || info?.last;
  if (!total) return null;
  const get = (value, field, camel) => value?.[field] ?? value?.[camel];
  const fields = [['input_tokens', 'inputTokens'], ['output_tokens', 'outputTokens'],
    ['reasoning_output_tokens', 'reasoningOutputTokens']];
  if (!baseline) {
    // Only a verified first call can establish a zero baseline.
    if (!last || !fields.every(([field, camel]) => {
      const a = get(total, field, camel) ?? (field === 'reasoning_output_tokens' ? 0 : undefined);
      const b = get(last, field, camel) ?? (field === 'reasoning_output_tokens' ? 0 : undefined);
      return count(a) && a === b;
    })) return null;
    baseline = { input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0 };
  }
  const usage = {};
  for (const [field, camel] of fields) {
    const end = get(total, field, camel) ?? (field === 'reasoning_output_tokens' ? 0 : undefined);
    const start = get(baseline, field, camel) ?? (field === 'reasoning_output_tokens' ? 0 : undefined);
    if (!count(end) || !count(start) || end < start) return null;
    usage[field] = end - start;
  }
  if (usage.reasoning_output_tokens > usage.output_tokens) return null;
  return usage;
}

function withTurnSpeed(turn) {
  const metric = measureTurnSpeed(turn);
  return metric ? { ...turn, turnSpeed: metric } : turn;
}

module.exports = { measureTurnSpeed, codexTurnUsage, withTurnSpeed, speedTier };
