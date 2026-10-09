'use strict';

function usageSignature(value) {
  return JSON.stringify({
    usage5h: value && value.usage5h || null,
    usage7d: value && value.usage7d || null,
  });
}

function observedAt(value) {
  return Number(value && (value.observedAt || value.ts)) || 0;
}

function didClaudeSnapshotAdvance(before, after) {
  const beforeObservedAt = observedAt(before);
  const afterObservedAt = observedAt(after);
  if (beforeObservedAt > 0 || afterObservedAt > 0) {
    return afterObservedAt > beforeObservedAt;
  }
  return usageSignature(before) !== usageSignature(after);
}

function selectClaudeStatuslineUsage(cache, now = Date.now) {
  const entries = Object.values(cache || {})
    .filter(entry => entry && typeof entry === 'object' && (entry.usage5h || entry.usage7d))
    .sort((a, b) => (Number(b.ts) || 0) - (Number(a.ts) || 0));
  if (entries.length === 0) return null;

  const usage5Entry = entries.find(entry => entry.usage5h);
  const usage7Entry = entries.find(entry => entry.usage7d);
  const selectedTimestamps = [usage5Entry, usage7Entry]
    .filter(Boolean)
    .map(entry => Number(entry.ts) || 0)
    .filter(ts => ts > 0);

  return {
    usage5h: usage5Entry ? usage5Entry.usage5h : null,
    usage7d: usage7Entry ? usage7Entry.usage7d : null,
    // The row contains both selected windows, so its freshness cannot be newer
    // than the older constituent snapshot.
    ts: selectedTimestamps.length > 0 ? Math.min(...selectedTimestamps) : now(),
    source: 'statusline-cache',
  };
}

module.exports = {
  didClaudeSnapshotAdvance,
  selectClaudeStatuslineUsage,
};
