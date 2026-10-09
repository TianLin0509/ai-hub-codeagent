'use strict';
// Per-CLI model lists — single source of truth for the single-session top-bar
// model picker (renderer.js) and round-table create modal (meeting-create-modal.js).
//
// Model picker options used by the renderer config modal.
//
// Claude accepts `/model <id>\r`. Codex uses a two-step interactive `/model`
// picker (model, then effort), so it is switchable in-session but is not an
// inline-argument command. Keep those strategies distinct: sending
// `/model gpt-5.5` to Codex 0.151 is an ordinary model prompt, not a switch.

const { isChatgptWebModel } = require('./chatgpt-web-models');
const MODEL_OPTIONS_BY_KIND = {
  chatgpt: [],
  qwen: require('./acp-model-catalog').acpModelOptions('qwen'),
  'deepseek-acp': require('./acp-model-catalog').acpModelOptions('deepseek-acp'),
  glm: require('./acp-model-catalog').acpModelOptions('glm'),
  claude: [
    { id: 'claude-opus-5-5[1m]', label: 'Opus 5.5 (1M context)' },
    { id: 'claude-opus-5-5',     label: 'Opus 5.5' },
    { id: 'claude-sonnet-5-5',   label: 'Sonnet 5.5' },
    { id: 'claude-opus-5[1m]',   label: 'Opus 5 (1M context)' },
    { id: 'claude-fable-5-1[1m]', label: 'Fable 5.1 (1M context)' },
    { id: 'claude-fable-5-1',     label: 'Fable 5.1' },
    { id: 'claude-opus-5',       label: 'Opus 5' },
    { id: 'claude-sonnet-5',     label: 'Sonnet 5' },
    { id: 'claude-fable-5',      label: 'Fable 5' },
    { id: 'claude-opus-4-8[1m]', label: 'Opus 4.8 (1M context)' },
    { id: 'claude-opus-4-8',     label: 'Opus 4.8' },
    { id: 'claude-opus-4-7[1m]', label: 'Opus 4.7 (1M context)' },
    { id: 'claude-opus-4-7',     label: 'Opus 4.7' },
    { id: 'claude-opus-4-6[1m]', label: 'Opus 4.6 (1M context)' },
    { id: 'claude-opus-4-6',     label: 'Opus 4.6' },
    { id: 'claude-sonnet-4-6',   label: 'Sonnet 4.6' },
    { id: 'claude-sonnet-4-5',   label: 'Sonnet 4.5' },
    { id: 'claude-haiku-4-5',    label: 'Haiku 4.5' },
    // Claude Code owns these aliases and resolves them to the latest model the
    // signed-in account can use. They are the non-stale escape hatch when a new
    // minor model ships before Hub's exact-ID fallback table is updated.
    { id: 'fable',               label: 'Fable · 最新可用版本' },
    { id: 'opus',                label: 'Opus · 最新可用版本' },
    { id: 'sonnet',              label: 'Sonnet · 最新可用版本' },
    { id: 'haiku',               label: 'Haiku · 最新可用版本' },
  ],
  gemini: [
    { id: 'gemini-3-pro-preview', label: 'Gemini 3.1 Pro' },
    { id: 'gemini-2.5-pro',       label: 'Gemini 2.5 Pro' },
    { id: 'gemini-2.5-flash',     label: 'Gemini 2.5 Flash' },
  ],
  codex: [
    { id: 'gpt-6-astra',   label: 'GPT-6 Astra' },
    { id: 'gpt-6.1-sol',   label: 'GPT-6.1 Sol' },
    { id: 'gpt-6-sol',     label: 'GPT-6 Sol' },
    { id: 'gpt-6-luna',    label: 'GPT-6 Luna' },
    { id: 'gpt-5.6-sol',   label: 'GPT-5.6 Sol · 1M 请求' },
    { id: 'gpt-5.5',       label: 'GPT-5.5' },
    { id: 'gpt-5.4',       label: 'GPT-5.4' },
    { id: 'gpt-5.3-codex', label: 'GPT-5.3 Codex' },
  ],
  deepseek: [
    { id: 'deepseek-v4-pro',   label: 'DeepSeek V4 Pro · Codex (1M)' },
    { id: 'deepseek-v4-flash', label: 'DeepSeek V4 Flash · Codex (1M)' },
  ],
  kimi: [
    { id: 'kimi-code/k3', label: 'Kimi K3' },
  ],
  // 公司内部 Code Agent（core/codeagent-config.js）；Auto 由 CLI 自动在大小模型间分流。
  codeagent: [
    { id: 'GLM-5.2-WX-Auto', label: 'GLM-5.2 Auto' },
    { id: 'MiniMax-M2.7', label: 'MiniMax M2.7' },
  ],
};

// Renderer-side catalogs can be refreshed from each CLI's own account cache.
// Main/session-manager processes keep the static table; they validate model IDs
// independently and receive the selected ID explicitly from renderer IPC.
const RUNTIME_MODEL_OPTIONS_BY_KIND = new Map();

function normalizeRuntimeModelOption(option) {
  if (!option || typeof option !== 'object') return null;
  const id = String(option.id || '').trim();
  if (!id || id.length > 160 || /[\0\r\n]/.test(id)) return null;
  const label = String(option.label || option.displayName || id).replace(/[\0\r\n]+/g, ' ').trim().slice(0, 120) || id;
  const description = String(option.description || '').replace(/[\0\r\n]+/g, ' ').trim().slice(0, 280);
  return {
    ...option,
    id,
    label,
    ...(description ? { description } : {}),
  };
}

function setRuntimeModelOptions(kind, options) {
  const base = String(kind || '').replace(/-resume$/, '');
  if (!base) return [];
  const normalized = [];
  const seen = new Set();
  for (const raw of Array.isArray(options) ? options : []) {
    const option = normalizeRuntimeModelOption(raw);
    if (!option || seen.has(option.id.toLowerCase())) continue;
    seen.add(option.id.toLowerCase());
    normalized.push(option);
  }
  if (normalized.length) RUNTIME_MODEL_OPTIONS_BY_KIND.set(base, normalized);
  else RUNTIME_MODEL_OPTIONS_BY_KIND.delete(base);
  return normalized.map(option => ({ ...option }));
}

function clearRuntimeModelOptions(kind) {
  const base = String(kind || '').replace(/-resume$/, '');
  return RUNTIME_MODEL_OPTIONS_BY_KIND.delete(base);
}

const DEFAULT_MODEL_BY_KIND = {
  qwen: 'qwen3.8-max',
  'deepseek-acp': 'deepseek-v4-pro',
  glm: 'glm-5.2',
  claude: 'claude-opus-5[1m]',
  gemini: 'gemini-3-pro-preview',
  codex: 'gpt-6-astra',
  deepseek: 'deepseek-v4-flash',
  kimi: 'kimi-code/k3',
  codeagent: 'GLM-5.2-WX-Auto',
};

// PTY output can contain tool/backend model names such as gpt-image-gen2.
// Those are not valid conversation models for `codex resume/fork --model` and
// must never replace the model selected for the Hub session.
const CODEX_NON_CONVERSATION_MODEL_RE = /(?:^|[-_.])(?:image(?:gen)?|audio|tts|whisper|embedding|moderation|realtime)(?:$|[-_.])/i;

function isCodexConversationModelId(modelId) {
  if (isChatgptWebModel(modelId)) return true;
  const raw = String(modelId || '').trim();
  if (!/^(?:gpt-[\w.-]+|o\d[\w.-]*)$/i.test(raw)) return false;
  return !CODEX_NON_CONVERSATION_MODEL_RE.test(raw);
}

function normalizeCodexSessionModel(modelId) {
  const raw = String(modelId || '').trim();
  // The TUI footer uses display casing (GPT-6-Astra). OpenAI's request model
  // identifiers are case-sensitive. Keep display labels out of saved launch
  // parameters, including old snapshots already contaminated by the footer.
  if (isChatgptWebModel(raw)) return raw;
  return isCodexConversationModelId(raw) ? raw.toLowerCase() : DEFAULT_MODEL_BY_KIND.codex;
}

// Migration-only default. It is deliberately separate from the new-session
// default above: an old V4 Pro Claude transcript must not be silently resumed
// on Flash merely because new DeepSeek sessions now use Codex Responses.
const LEGACY_DEEPSEEK_CLAUDE_DEFAULT_MODEL = 'deepseek-v4-pro[1m]';

function normalizeDeepSeekModel(modelId) {
  const raw = String(modelId || '').trim().replace(/\[1m\]$/i, '');
  // DeepSeek 的 Responses API 当前同时支持 V4 Pro / Flash。只接受 Hub
  // catalog 已公开的两个 id；旧别名和未知值仍安全回落到默认 Flash。
  return MODEL_OPTIONS_BY_KIND.deepseek.some(option => option.id === raw)
    ? raw
    : DEFAULT_MODEL_BY_KIND.deepseek;
}

function normalizeLegacyDeepSeekClaudeModel(modelId) {
  const raw = String(modelId || LEGACY_DEEPSEEK_CLAUDE_DEFAULT_MODEL).trim();
  if (!raw) return LEGACY_DEEPSEEK_CLAUDE_DEFAULT_MODEL;
  if (/^deepseek-/i.test(raw) && !/\[1m\]$/i.test(raw)) return `${raw}[1m]`;
  return raw;
}

function legacyDeepSeekClaudeDisplayName(modelId) {
  const normalized = normalizeLegacyDeepSeekClaudeModel(modelId);
  const base = normalized.replace(/\[1m\]$/i, '');
  if (base === 'deepseek-v4-pro') return 'DS V4 Pro 1M · Legacy Claude';
  if (base === 'deepseek-v4-flash') return 'DS V4 Flash 1M · Legacy Claude';
  return normalized;
}

function deepseekDisplayName(modelId) {
  const normalized = normalizeDeepSeekModel(modelId);
  if (normalized === 'deepseek-v4-pro') return 'DS V4 Pro · Codex 1M';
  if (normalized === 'deepseek-v4-flash') return 'DS V4 Flash · Codex 1M';
  return normalized;
}

// `<base>-resume` kinds 复用对应 base kind 清单（claude-resume → claude，等）。
function modelOptionsFor(kind) {
  if (!kind) return [];
  const base = String(kind).replace(/-resume$/, '');
  return RUNTIME_MODEL_OPTIONS_BY_KIND.get(base) || MODEL_OPTIONS_BY_KIND[base] || [];
}

const MODEL_SWITCH_STRATEGY_BY_KIND = Object.freeze({
  claude: 'claude-inline',
  codex: 'codex-picker',
  deepseek: 'codex-picker',
  qwen: 'acp-native',
  'deepseek-acp': 'acp-native',
  glm: 'acp-native',
});

function modelSwitchStrategy(kind) {
  const base = String(kind || '').replace(/-resume$/, '');
  return MODEL_SWITCH_STRATEGY_BY_KIND[base] || null;
}

function canSwitchInline(kind) {
  return modelSwitchStrategy(kind) === 'claude-inline';
}

function canSwitchInSession(kind) {
  return !!modelSwitchStrategy(kind);
}

function isClaudeModelSelection(modelId) {
  const value = String(modelId || '').trim();
  return /^(?:(?:claude-[a-z0-9][a-z0-9-]*|fable|opus|sonnet|haiku)(?:\[1m\])?)$/i.test(value);
}

module.exports = {
  LEGACY_DEEPSEEK_CLAUDE_DEFAULT_MODEL,
  MODEL_OPTIONS_BY_KIND,
  DEFAULT_MODEL_BY_KIND,
  CODEX_NON_CONVERSATION_MODEL_RE,
  MODEL_SWITCH_STRATEGY_BY_KIND,
  canSwitchInSession,
  clearRuntimeModelOptions,
  modelOptionsFor,
  modelSwitchStrategy,
  isCodexConversationModelId,
  isClaudeModelSelection,
  normalizeCodexSessionModel,
  canSwitchInline,
  setRuntimeModelOptions,
  normalizeDeepSeekModel,
  normalizeLegacyDeepSeekClaudeModel,
  legacyDeepSeekClaudeDisplayName,
  deepseekDisplayName,
};
