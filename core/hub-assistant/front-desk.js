'use strict';
// 手机消息的回答方式（2026-10-04 用户确认）：
// - api（默认）：前台用百炼 API 快模型当场答简单问题，工作、Hub 状态、难题和「交给助理」的话转给专属助理会话；
// - cli：每条都直接交给专属助理会话（默认 Claude Code Sonnet），由它自己研究或在 Hub 里新建会话。
// 两个 API 模型均经 Token Plan 套餐实测（24 题 × 3 轮判断全对）；千问更快，为默认。
const MODES = ['api', 'cli'];
const MODELS = [
  { id: 'qwen3.8-flash', label: '千问 3.8 Flash', short: '千问' },
  { id: 'deepseek-v4.1-flash', label: 'DeepSeek V4.1 Flash', short: 'DeepSeek' },
];
const DEFAULT_MODEL = MODELS[0].id;

function defaultModel(env = process.env) {
  return MODELS.some(m => m.id === env.HUB_ASSISTANT_FAST_LANE_MODEL) ? env.HUB_ASSISTANT_FAST_LANE_MODEL : DEFAULT_MODEL;
}
// 存储值 → 完整描述。旧版只有 fastLaneDisabled 开关，true 视为 cli。
function describe(saved, { legacyDisabled = false, env = process.env } = {}) {
  const mode = MODES.includes(saved?.mode) ? saved.mode : (legacyDisabled ? 'cli' : 'api');
  const model = MODELS.some(m => m.id === saved?.model) ? saved.model : defaultModel(env);
  const info = MODELS.find(m => m.id === model);
  return { mode, model, label: mode === 'cli' ? '助理会话直答' : info.short + '快答', modelLabel: info.label };
}
function validate({ mode, model } = {}) {
  if (!MODES.includes(mode)) throw new Error('回答方式只能是 api 或 cli');
  if (model !== undefined && !MODELS.some(m => m.id === model)) throw new Error('不支持的快答模型：' + model);
  return { mode, ...(model ? { model } : {}) };
}
// 手机与电脑面板的选项表。
function catalog(current) {
  return { current, modes: [
    { id: 'api', label: '快速回答', hint: '简单问题几秒内答；工作和难题自动交给助理会话' },
    { id: 'cli', label: '助理会话', hint: '每条都交给助理会话，适合较难的任务，约 10～20 秒' },
  ], models: MODELS.map(({ id, label }) => ({ id, label })) };
}
module.exports = { MODES, MODELS, DEFAULT_MODEL, describe, validate, catalog, defaultModel };
