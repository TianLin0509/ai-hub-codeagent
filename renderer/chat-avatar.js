'use strict';

const { canonicalAiKind } = require('../core/ai-kinds');

// Artwork is a presentation registry, not another list of supported runtimes.
const ARTWORK = Object.freeze({
  gpt: 'codex', claude: 'claude', gemini: 'gemini', deepseek: 'deepseek',
  // 公司 Code Agent 默认模型是 GLM-5.2，先借用智谱的画像。
  kimi: 'kimi', qwen: 'qwen', glm: 'glm', codeagent: 'glm',
});
const USER_AVATAR_SRC = '../claude-wx.ico';
const ASSISTANT_AVATAR_SRC = 'assets/assistant/penguin.png';

function chatAvatarSrc(kind, { assistant = false } = {}) {
  if (assistant) return ASSISTANT_AVATAR_SRC;
  const family = canonicalAiKind(String(kind || '').toLowerCase().replace(/-resume$/, ''));
  const name = Object.hasOwn(ARTWORK, family) ? ARTWORK[family] : null;
  return name ? `assets/ai-avatars/cel-v2/${name}.png` : null;
}

module.exports = { chatAvatarSrc, USER_AVATAR_SRC, ASSISTANT_AVATAR_SRC };
