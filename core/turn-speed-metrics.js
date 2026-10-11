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
    includesReasoning: count(turn.usage?.reasoning_output_tokens) && turn.usage.reasoning_output_tokens > 0,
    generation: measureGeneration(turn.generation, elapsedMs) };
}

// Generation speed divides by the time the model itself was busy: each call
// runs from its request (the prompt, or the last tool result it waits for) to
// its last output. Tools, sub-agents and user waits fall outside every call.
// A call still includes queueing and context prefill before the first token,
// so the rate reads slightly below pure decoding. Each provider supplies the
// calls from its own records; anything it cannot time stays unknown.
const GENERATION_METHODS = new Set(['per-call', 'api-duration', 'minus-tools']);
function measureGeneration(generation, elapsedMs = Infinity) {
  const output = generation?.outputTokens, activeMs = generation?.activeMs;
  if (!count(output) || output === 0 || !Number.isFinite(activeMs) || activeMs < 200
      || activeMs > elapsedMs + 1000 || generation.invalid || !GENERATION_METHODS.has(generation.method)) return null;
  return { outputTokens: output, activeMs, tokensPerSecond: output * 1000 / activeMs,
    calls: count(generation.calls) && generation.calls > 0 ? generation.calls : null, method: generation.method };
}

// Adds one more timed call; an untimed call poisons the sum rather than
// letting its tokens borrow another call's time.
function addGenerationCall(generation, { startedAt, endedAt, outputTokens }, method = 'per-call') {
  const next = generation || { outputTokens: 0, activeMs: 0, calls: 0, method };
  if (next.invalid) return next;
  if (!Number.isFinite(startedAt) || !Number.isFinite(endedAt) || endedAt < startedAt || !count(outputTokens))
    return { ...next, invalid: true };
  return { ...next, outputTokens: next.outputTokens + outputTokens, activeMs: next.activeMs + endedAt - startedAt,
    calls: next.calls + 1 };
}

function sumGenerations(a, b) {
  if (!a || !b || a.invalid || b.invalid || a.method !== b.method) return null;
  return { outputTokens: a.outputTokens + b.outputTokens, activeMs: a.activeMs + b.activeMs,
    calls: (a.calls || 0) + (b.calls || 0), method: a.method };
}

// Milliseconds of [from, to] covered by at least one interval. Parallel tools
// overlap; counting each separately would subtract the same second twice.
function coveredMs(intervals, from, to) {
  const spans = intervals.map(([start, end]) => [Math.max(from, start), Math.min(to, end)])
    .filter(([start, end]) => Number.isFinite(start) && Number.isFinite(end) && end > start)
    .sort((x, y) => x[0] - y[0]);
  let covered = 0, start = null, end = null;
  for (const [s, e] of spans) {
    if (end === null || s > end) { if (end !== null) covered += end - start; start = s; end = e; }
    else end = Math.max(end, e);
  }
  return end === null ? covered : covered + end - start;
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

module.exports = { measureTurnSpeed, measureGeneration, addGenerationCall, sumGenerations, coveredMs,
  codexTurnUsage, withTurnSpeed, speedTier };
