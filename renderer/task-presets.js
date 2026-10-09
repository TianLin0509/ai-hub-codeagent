'use strict';

// Shared task presets for normal Hub sessions.
// The renderer keeps the user's text and the selected constraint separate, then
// composes them only when the user explicitly sends the draft.
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.TaskPresets = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const PRESETS = [
    {
      id: 'safe-resume',
      label: '续跑',
      name: '安全续跑',
      hint: '先校准状态，再继续未完成项',
      constraint: '继续当前任务，不开启新方向。先依据当前会话和工作区证据确认：原目标、已完成且有证据的部分、未完成或未验证的部分，以及现在最应该做的一步。确认后直接执行。不要重复已完成工作；上下文不足时明确缺失信息，不要猜测。最终只报告本轮新增动作、验证结果和剩余阻断。',
    },
    {
      id: 'review-verify',
      label: '审查',
      name: '审查验收',
      hint: '只读检查，输出可行动问题与证据',
      constraint: '保持只读，除非我明确授权修复。只报告可行动问题，按严重度排序；每项给出位置、影响、证据或复现方式，以及需要执行的验证。没有阻断项时明确给出 PASS，并说明实际核验过什么。',
    },
    {
      id: 'feature-delivery',
      label: '功能',
      name: '功能交付',
      hint: '目标、验收、实现、验证闭环',
      constraint: '先确认目标、非目标和验收标准，再实施功能。保持改动聚焦，不顺手重构无关模块；完成后执行与风险相称的真实验证，并按验收标准逐项说明结果、遗留和回退方式。',
    },
    {
      id: 'root-cause-fix',
      label: '修 Bug',
      name: '根因修复',
      hint: '复现、日志、调用链、修复、回归',
      constraint: '按“复现 → 日志与证据 → 调用链 → 确认根因 → 最小修复 → 回归验证”的顺序处理。根因未确认前不要猜测式改代码；不得掩盖症状或扩大修改范围。最终给出根因证据、实际改动、验证结果和剩余风险。',
    },
    {
      id: 'research-decision',
      label: '调研',
      name: '调研决策',
      hint: '核验来源、比较方案、给唯一建议',
      constraint: '优先核验一手和当前来源，明确区分事实、推断与未知。比较候选方案的收益、成本、风险和可逆性，指出最强反证，最后给出唯一推荐、成立条件、待查问题和下一步动作。',
    },
  ];

  function getPreset(presetId) {
    return PRESETS.find(item => item.id === presetId) || null;
  }

  function composePrompt(userText, presetId, constraintOverride) {
    const text = String(userText == null ? '' : userText);
    const preset = getPreset(presetId);
    if (!preset) return text;
    const constraint = String(constraintOverride == null ? preset.constraint : constraintOverride).trim();
    if (!constraint) return text;
    return `${text}\n\n---\n【任务模式：${preset.name}】\n${constraint}`;
  }

  return { PRESETS, getPreset, composePrompt };
});
