'use strict';

// GPT-5.6 Sol advertises a 1,050,000-token API window. Hub requests a round 1M
// for Sol sessions. Codex CLI still owns the effective limit and may clamp this
// request to max_context_window from its current model catalog.
const HUB_CODEX_CONTEXT_WINDOW = 1_000_000;
const MAX_CODEX_CONTEXT_WINDOW = 1_050_000;
const HUB_ONE_MILLION_MODEL = 'gpt-5.6-sol';

function normalizeCodexContextWindow(value) {
  if (value === undefined || value === null || value === '') return null;
  const normalized = Number(value);
  if (!Number.isInteger(normalized) || normalized <= 0 || normalized > MAX_CODEX_CONTEXT_WINDOW) {
    return null;
  }
  return normalized;
}

function defaultCodexContextWindow(modelId) {
  return String(modelId || '').trim().toLowerCase() === HUB_ONE_MILLION_MODEL
    ? HUB_CODEX_CONTEXT_WINDOW
    : null;
}

function resolveCodexContextWindow(modelId, value, catalogOptions = null) {
  const requested = normalizeCodexContextWindow(value) || defaultCodexContextWindow(modelId);
  if (!requested || !catalogOptions) return requested;
  // Bound only a requested override; newer models continue using CLI defaults.
  const tuning = require('./codex-model-catalog').describeCodexModelTuning(modelId, catalogOptions);
  const maximum = Number(tuning.maxContextWindow);
  return tuning.fromCache && Number.isInteger(maximum) && maximum > 0
    ? Math.min(requested, maximum) : requested;
}

function buildCodexContextWindowArg(value) {
  const normalized = normalizeCodexContextWindow(value);
  return normalized ? ` -c 'model_context_window=${normalized}'` : '';
}

module.exports = {
  HUB_CODEX_CONTEXT_WINDOW,
  HUB_ONE_MILLION_MODEL,
  MAX_CODEX_CONTEXT_WINDOW,
  buildCodexContextWindowArg,
  defaultCodexContextWindow,
  normalizeCodexContextWindow,
  resolveCodexContextWindow,
};
