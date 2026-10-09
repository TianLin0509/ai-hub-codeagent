'use strict';
// Text/code models from the Token Plan personal catalog, verified 2026-09-12.
// https://help.aliyun.com/zh/model-studio/token-plan-personal-overview
const IDS = {
  qwen: ['qwen3.8-max', 'qwen3.8-flash', 'qwen3.7-max', 'qwen3.7-plus', 'qwen3.6-flash'],
  'deepseek-acp': ['deepseek-v4-pro', 'deepseek-v4-pro-0813', 'deepseek-v4-flash-0731'],
  glm: ['glm-5.2'],
};
function acpModelOptions(kind, configuredModel) {
  const ids = [...(IDS[kind] || [])];
  if (configuredModel && !ids.includes(configuredModel)) ids.push(configuredModel);
  return ids.map(id => ({ id, label: id, source: 'token-plan-catalog' }));
}
function acpThoughtOption(session) {
  return session?.acpConfigOptions?.find(o => o.category === 'thought_level' && o.type === 'select');
}
function deepseekReasoningEfforts(model) {
  // Alibaba's V4 chat API: high/max; dated revisions additionally accept low.
  // https://help.aliyun.com/zh/model-studio/deepseek-api
  if (!IDS['deepseek-acp'].includes(model)) return undefined;
  return { ...(model === 'deepseek-v4-pro' ? {} : {low:'low'}), high:'high', max:'max' };
}
function acpThoughtChoices(session) {
  return (acpThoughtOption(session)?.options || []).flatMap(o => o.options || [o]);
}
module.exports = { acpModelOptions, acpThoughtOption, acpThoughtChoices, deepseekReasoningEfforts };
