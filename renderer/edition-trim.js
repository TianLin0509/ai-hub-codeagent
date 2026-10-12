'use strict';
// 发行目标的界面裁剪（公司纯净版：只留 CodeAgent，不要额度条和账号页）。
// 在 index.html 里排在 workspace-controller.js 之前，各控制器初始化时看到的已经是裁剪后的界面。
// 主仓库与公开社区版没有这些设置，这里什么也不做。
(() => {
  const { allowedKinds, kindAllowed, featureEnabled } = require('../core/distribution');
  if (allowedKinds) {
    // 启动中心：只留允许的会话类型；没有可恢复的类型时，连「恢复会话」这一页一起去掉。
    document.querySelectorAll('.new-session-option[data-kind]').forEach(button => { if (!kindAllowed(button.dataset.kind)) button.remove(); });
    document.querySelectorAll('[data-resume-kind]').forEach(button => { if (!kindAllowed(button.dataset.resumeKind)) button.remove(); });
    if (!document.querySelector('[data-resume-kind]')) {
      document.querySelector('[data-launch-intent="resume"]')?.remove();
      document.querySelector('[data-launch-panel="resume"]')?.remove();
    }
    // 会话搜索的提供方筛选：去掉不提供的 AI（「全部」「其他模型」「群聊」不是 AI 名，保留）。
    const { ALL_AI_KINDS } = require('../core/ai-kinds');
    document.querySelectorAll('.session-search-chip[data-provider]').forEach(chip => {
      const provider = chip.dataset.provider;
      if (ALL_AI_KINDS.includes(provider) && !kindAllowed(provider)) chip.remove();
    });
  }
  // 底部状态栏的「余量」：各家 AI 账号的剩余额度，CodeAgent 没有。
  if (!featureEnabled('quotaBar')) document.getElementById('rail-usage')?.remove();
  // 左侧「账号」：各家 AI 网页与命令行账号；按钮留在页面里（别处会程序化点击它来关账号页），只是不显示。
  if (!featureEnabled('accounts')) {
    const button = document.getElementById('btn-rail-accounts');
    if (button) button.style.display = 'none';
  }
})();
