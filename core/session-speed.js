'use strict';
const pendingSpeedSwitches = new Set();

// Explicit model ids only: /fast on can promote an unsupported Claude model.
function claudeSupportsFast(model) {
  return /^(?:claude-)?opus-(?:5(?:[.-]5)?|4[.-]8)(?:-\d{8})?(?:\[1m\])?$/i.test(String(model || ''));
}

// Why the engine refuses Fast, in the user's words. `sdk_opt_in_required` is
// deliberately absent: the Hub's own switch is exactly that opt-in, so treating
// it as a block would hide a button that works.
const CLAUDE_FAST_BLOCKED_REASONS = {
  free: 'Fast 需要付费订阅',
  preference: '账号设置里关闭了 Fast',
  extra_usage_disabled: '账号未开启额外用量',
  network_error: '暂时无法确认 Fast 可用性',
  not_first_party: '当前接入方式不支持 Fast',
  disabled_by_env: '本机环境禁用了 Fast',
  model_not_allowed: '当前模型不在组织允许的 Fast 模型内',
  pending: '正在确认 Fast 可用性',
  unknown: 'Fast 当前不可用',
};

function speedControl(session, tuning) {
  const kind = String(session?.kind || '').replace(/-resume$/, '');
  const native = kind === 'codex';
  const nativeClaude = session?.runtimeBackend === 'claude-stream-json';
  const runtime = (nativeClaude && session.nativeRuntime) || {};
  // The native engine states its own fast-mode truth; the model table is only
  // the fallback for a session that has not connected yet.
  const blocked = nativeClaude && runtime.fastModeBlocked && runtime.fastModeBlocked !== 'sdk_opt_in_required'
    ? (CLAUDE_FAST_BLOCKED_REASONS[runtime.fastModeBlocked] || CLAUDE_FAST_BLOCKED_REASONS.unknown)
    : null;
  const claude = kind === 'claude' && (runtime.fastMode === true || claudeSupportsFast(session.currentModel?.id));
  const supported = native && tuning?.fromCache && tuning.supportsFast;
  const visible = !!(supported || claude || (native && (!tuning?.fromCache || session.codexSpeedTier === 'fast')));
  const tier = native ? session.codexSpeedTier
    : nativeClaude && typeof runtime.fastMode === 'boolean' ? (runtime.fastMode ? 'fast' : 'standard')
    : session?.fastMode === false ? 'standard' : 'fast';
  const label = {fast:'快速',standard:'标准',inherit:'跟随配置',flex:'Flex'}[tier] || '速度';
  return {visible, label, tier, kind, interactive:!!((supported || claude) && !blocked), ...(blocked ? {reason:blocked} : {})};
}
module.exports = {claudeSupportsFast, speedControl, pendingSpeedSwitches};
