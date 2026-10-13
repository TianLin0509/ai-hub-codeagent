'use strict';

const { canonicalAiKind } = require('../core/ai-kinds');

// Artwork is a presentation registry, not another list of supported runtimes.
const ARTWORK = Object.freeze({
  gpt: 'codex', claude: 'claude', gemini: 'gemini', deepseek: 'deepseek',
  // 公司 Code Agent 默认模型是 GLM-5.2，没认出模型时用智谱的画像。
  kimi: 'kimi', qwen: 'qwen', glm: 'glm', codeagent: 'glm', minimax: 'minimax',
});
// 公司 CodeAgent 背后的模型可能是 GLM / DeepSeek / MiniMax（2026-10-13）：按这条回答的模型挑画像，
// 这几张随 CodeAgent 一起发行（公司版 target.json 不丢它们）。
const CODEAGENT_MODEL_ARTWORK = Object.freeze({ glm: 'glm', deepseek: 'deepseek', minimax: 'minimax', qwen: 'qwen' });
const USER_AVATAR_SRC = '../claude-wx.ico';
const ASSISTANT_AVATAR_SRC = 'assets/assistant/penguin.png';

const artworkSrc = family => Object.hasOwn(ARTWORK, family) ? `assets/ai-avatars/cel-v2/${ARTWORK[family]}.png` : null;

// 只留部分 AI 的发行版（公司纯净版）不带其他 AI 的画像；万一遇到不在名单里的 kind，
// 用名单里第一个 AI 的画像，不显示破图。kind 可能是原名（codex）也可能是归类名（gpt）。
function makeChatAvatarSrc({ allowedKinds, kindAllowed }) {
  return function chatAvatarSrc(kind, { assistant = false, model = '' } = {}) {
    if (assistant) return ASSISTANT_AVATAR_SRC;
    const raw = String(kind || '').toLowerCase().replace(/-resume$/, '');
    const family = canonicalAiKind(raw);
    if (family === 'codeagent') {
      const modelFamily = require('../core/codeagent-models').modelFamily(model);
      if (CODEAGENT_MODEL_ARTWORK[modelFamily]) return artworkSrc(CODEAGENT_MODEL_ARTWORK[modelFamily]);
    }
    const shipped = !allowedKinds || kindAllowed(raw) || kindAllowed(family) || (family === 'gpt' && kindAllowed('codex'));
    if (shipped || !artworkSrc(family)) return artworkSrc(family);
    return artworkSrc(canonicalAiKind(allowedKinds[0]));
  };
}

const chatAvatarSrc = makeChatAvatarSrc(require('../core/distribution'));

module.exports = { chatAvatarSrc, makeChatAvatarSrc, USER_AVATAR_SRC, ASSISTANT_AVATAR_SRC };
