'use strict';

// Tuning defaults are explicit snapshots; the quota account is shared globally.
// Model IDs remain in models.defaults for existing callers and older configurations.
const { MODEL_OPTIONS_BY_KIND } = require('./model-options');
const { withDefaultModelInJson } = require('./default-model-preference');
const EFFORT = {
  claude: ['low', 'medium', 'high', 'xhigh', 'max'],
  codex: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
  deepseek: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
  'deepseek-claude': ['low', 'medium', 'high', 'xhigh', 'max'],
  codeagent: ['low', 'medium', 'high', 'max'],
};
const MCP = ['none', 'lean', 'browser', 'wireless', 'full'];
const SPEED = ['standard', 'inherit', 'fast', 'flex'];
const plain = value => value && typeof value === 'object' && !Array.isArray(value);
const baseKind = kind => String(kind || '').replace(/-resume$/, '');

function normalizeLaunchDefaults(kind, value, { strict = false } = {}) {
  const base = baseKind(kind);
  if (!plain(value)) { if (strict) throw new Error('启动配置格式无效'); return {}; }
  const result = {};
  const take = (key, allowed) => {
    if (!Object.prototype.hasOwnProperty.call(value, key)) return;
    if (allowed(value[key])) result[key] = value[key];
    else if (strict) throw new Error(`启动配置 ${key} 不可用，请重新选择`);
  };
  if (EFFORT[base]) {
    take('effort', v => EFFORT[base].includes(v));
    take('mcpProfile', v => MCP.includes(v));
  }
  if (base === 'claude') take('fastMode', v => typeof v === 'boolean');
  if (base === 'codex' || base === 'deepseek') take('codexSpeedTier', v => SPEED.includes(v));
  // Ignore legacy account snapshots, including payloads from an older dialog.
  // Only providers.codex.subscription_profile selects the quota account.
  if (['deepseek-claude', 'deepseek-acp'].includes(base)) take('deepseekRoute', v => ['tokenplan', 'api'].includes(v));
  return result;
}

function readLaunchDefaults(config) {
  const raw = config && config.launchDefaults;
  if (!plain(raw)) return {};
  const result = {};
  for (const [kind, value] of Object.entries(raw)) {
    if (!Object.prototype.hasOwnProperty.call(MODEL_OPTIONS_BY_KIND, kind) || !plain(value)) continue;
    result[kind] = normalizeLaunchDefaults(kind, value);
  }
  return result;
}

function withLaunchDefaultsInJson(raw, kind, selection, options = {}) {
  const base = baseKind(kind);
  if (!Object.prototype.hasOwnProperty.call(MODEL_OPTIONS_BY_KIND, base) || base === 'powershell') {
    throw new Error('该类型没有可保存的启动配置');
  }
  if (!plain(selection) || !selection.model) throw new Error('请选择模型后再保存');
  const tuning = normalizeLaunchDefaults(base, selection, { ...options, strict: true });
  const next = withDefaultModelInJson(raw, base, selection.model, options);
  const launch = plain(next.launch) ? next.launch : {};
  return { ...next, launch: { ...launch, defaults: { ...(plain(launch.defaults) ? launch.defaults : {}), [base]: tuning } } };
}

module.exports = { normalizeLaunchDefaults, readLaunchDefaults, withLaunchDefaultsInJson };
