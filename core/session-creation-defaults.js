'use strict';
// Shared with the ordinary new-session UI. Assistant-created work must not
// acquire a second, drifting table of model/effort/tool/speed defaults.
const DEFAULT_EFFORT = 'max';
const DEFAULT_EFFORT_BY_KIND = { claude: 'high', codex: 'high', codeagent: 'high' };
// Code Agent 默认沿用使用者自己配好的 MCP（公司代码检索等），所以是 full。
const DEFAULT_MCP_BY_KIND = { claude: 'none', codex: 'none', deepseek: 'none', codeagent: 'full' };
const DEFAULT_CODEX_SPEED_BY_KIND = { codex: 'standard', deepseek: 'inherit' };
function defaultEffortFor(kind) { return DEFAULT_EFFORT_BY_KIND[kind] || DEFAULT_EFFORT; }
function creationDefaults(kind, config = {}) {
  const model = require('./default-model-preference').resolveDefaultModel(kind, config);
  const opts = { model, effort: defaultEffortFor(kind), mcpProfile: DEFAULT_MCP_BY_KIND[kind] || 'none' };
  if (DEFAULT_CODEX_SPEED_BY_KIND[kind]) opts.codexSpeedTier = DEFAULT_CODEX_SPEED_BY_KIND[kind];
  if (kind === 'codex') {
    const contextMax = require('./codex-context-window').defaultCodexContextWindow(model);
    if (typeof contextMax === 'number') opts.contextMax = contextMax;
    if (config.codexSubscriptionProfile) opts.codexProfile = config.codexSubscriptionProfile;
  }
  return opts;
}
module.exports = { DEFAULT_EFFORT, DEFAULT_EFFORT_BY_KIND, DEFAULT_MCP_BY_KIND, DEFAULT_CODEX_SPEED_BY_KIND, defaultEffortFor, creationDefaults };
