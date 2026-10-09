'use strict';

function textFromContent(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((item) => {
      if (!item) return '';
      if (typeof item === 'string') return item;
      if (typeof item.text === 'string') return item.text;
      if (typeof item.content === 'string') return item.content;
      if (Array.isArray(item.content)) return textFromContent(item.content);
      return '';
    }).filter(Boolean).join('\n');
  }
  if (content && typeof content === 'object') {
    if (typeof content.text === 'string') return content.text;
    if (typeof content.content === 'string') return content.content;
    if (Array.isArray(content.content)) return textFromContent(content.content);
  }
  return '';
}

function isSyntheticUserText(text) {
  const t = String(text || '').trimStart();
  if (!t) return false;
  return (
    t.startsWith('<task-notification>') ||
    t.startsWith('<local-command-caveat>') ||
    t.startsWith('<command-name>') ||
    // 斜杠命令的回显（/model、/goal 等）。CLI 把它当 user 消息写进 transcript，
    // 但用户并没有"说"过这段话，卡片视图里出现就是噪音。
    t.startsWith('<local-command-stdout>') ||
    // 用户按 Esc / 打断工具调用时 CLI 自己插入的占位
    t.startsWith('[Request interrupted by user') ||
    t.startsWith('This session is being continued from a previous conversation that ran out of context.') ||
    // 2026-08-28：原来要求带 " for " 后缀，漏掉了 Codex 更常见的那一种 ——
    //   # AGENTS.md instructions\n\n<INSTRUCTIONS>…AGENTS.md 全文…</INSTRUCTIONS>
    //   <environment_context>…</environment_context>
    // 实测这是一条**整条都是注入**的 user 消息（1200 字左右，`</INSTRUCTIONS>`
    // 之后跟的是 environment_context，没有任何用户真话），卡片视图和搜索里
    // 都不该出现。
    t.startsWith('# AGENTS.md instructions') ||
    t.startsWith('<permissions instructions>') ||
    t.startsWith('<environment_context>') ||
    t.startsWith('<skills_instructions>') ||
    t.startsWith('<plugins_instructions>') ||
    t.startsWith('<collaboration_mode>') ||
    // Codex /goal is persisted twice in 0.147: a clean
    // thread_goal_updated.goal.objective plus this injected execution wrapper.
    // The parser renders the former and must hide the latter.
    t.startsWith('<codex_internal_context') ||
    t.startsWith('# Model Set Context') ||
    (t.includes('<INSTRUCTIONS>') && t.includes('CAT-CAFE-GOVERNANCE-START'))
  );
}

// AI 群聊里，Hub 发给每个成员的其实是一整段脚手架（group-chat-orchestrator.js
// buildSystemPromptText / buildDelta 拼的）：
//     ## 规则           ← Hub 注入的角色设定
//     ## 输出
//     ## 新增发言       ← 其他成员的发言转述
//     ## 用户
//     <用户真正打的字>
//     请发言。
// 整段都会以 user 消息落进各成员的 transcript。原样渲染就变成"我的 prompt 是一大坨
// 规则"，实测这是卡片视图里最大的一类误显示（扫 101 份 transcript，78 次）。
// 但也不能整条丢掉——用户真正的输入就藏在 `## 用户` 里，丢了就什么都看不到。
// 所以只把那一段抽出来。
function extractGroupChatUserInput(text) {
  const t = String(text || '');
  const marker = /(^|\n)##[ \t]*用户[ \t]*\r?\n/g;
  let last = null;
  let m;
  while ((m = marker.exec(t)) !== null) last = m;
  if (!last) return null;
  // 只在确认是群聊脚手架时才动手，避免误伤正文里恰好写了 "## 用户" 的普通提问
  // 「## 群成员」：首轮群规则之后的成员名单；老成员补发名单时它可能是唯一的外壳标记。
  if (!/(^|\n)##[ \t]*(?:规则|新增发言|群成员)/.test(t)) return null;
  let body = t.slice(last.index + last[0].length);
  body = body.replace(/\r?\n+[ \t]*请发言。[ \t]*\r?\n*$/, '');
  return body.trim();
}

// 卡片视图该显示什么：null = 这条压根不该出现；否则返回应显示的文本。
function displayUserText(text) {
  if (isSyntheticUserText(text)) return null;
  const groupChat = extractGroupChatUserInput(text);
  if (groupChat === null) return String(text || '');
  // 纯转述轮（用户这一轮没说话，只是让 AI 接着聊）不该冒出一张空的"你"卡片
  return groupChat || null;
}

function isSyntheticUserEntry(entry, text) {
  if (!entry || typeof entry !== 'object') return false;
  const candidate = text !== undefined ? text : textFromContent(entry.message?.content ?? entry.payload?.content ?? entry.payload?.message);
  if (entry.isMeta === true || entry.isCompactSummary === true || entry.isVisibleInTranscriptOnly === true) return true;
  if (entry.origin && entry.origin.kind === 'task-notification') return true;
  if (entry.promptSource === 'system' && (entry.origin || isSyntheticUserText(candidate))) return true;
  return isSyntheticUserText(candidate);
}

// 运行期注入的成块内容。它们可能挂在一条**真**用户消息的前后（不像上面那些
// 是整条注入），所以只能就地剪掉，不能整条丢。
const INJECTED_BLOCKS = [
  /<INSTRUCTIONS>[\s\S]*?<\/INSTRUCTIONS>/gi,
  /<system-reminder>[\s\S]*?<\/system-reminder>/gi,
  /<environment_context>[\s\S]*?<\/environment_context>/gi,
  /<recommended_plugins>[\s\S]*?<\/recommended_plugins>/gi,
  /<user-prompt-submit-hook>[\s\S]*?<\/user-prompt-submit-hook>/gi,
  /<skills_instructions>[\s\S]*?<\/skills_instructions>/gi,
  /<plugins_instructions>[\s\S]*?<\/plugins_instructions>/gi,
  /<permissions instructions>[\s\S]*?<\/permissions instructions>/gi,
  /<ai-hub-workspace-rules\b[^>]*>[\s\S]*?<\/ai-hub-workspace-rules>/gi,
  // Hub 附加的梦境索引：搜索和造梦素材都不收，否则下一轮造梦会读回自己的索引。
  /<ai-hub-dream-index\b[^>]*>[\s\S]*?<\/ai-hub-dream-index>/gi,
];

function stripInjectedBlocks(text) {
  let out = String(text || '');
  for (const pattern of INJECTED_BLOCKS) out = out.replace(pattern, ' ');
  return out.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * 建搜索索引时，一条 user 消息里到底哪些字算"用户说的话"。
 *
 * 2026-08-28：用户反馈搜索会命中自动注入的系统提示词（截图里"我的提问"整屏
 * 都是 AGENTS.md 正文），要求"搜索文本和卡片视图的问答内容一样"。所以直接复用
 * 卡片视图那套判定（displayUserText），再把可能夹在真话前后的注入块剪掉。
 *
 * 返回 null 表示这条整条都是注入，不该进索引。
 */
function searchableUserText(text) {
  let current = displayUserText(text);
  if (current === null) return null;
  // 剪完注入块之后，**剩下的残渣可能本身又是一条注入标记**。
  // 2026-08-28 在真实 Codex rollout 上抓到的形态（原文 1687 字）：
  //     <recommended_plugins> …一大段… </recommended_plugins>
  //     # AGENTS.md instructions for C:\Users\you\xresearch-research
  // 剪掉前一块后剩下后一行，第一版就这么原样入库了，搜索里照样能命中。
  // 所以剪一轮就重新判一次，直到稳定。
  for (let round = 0; round < 3; round += 1) {
    const stripped = stripInjectedBlocks(current);
    if (!stripped) return null;
    if (isSyntheticUserText(stripped)) return null;
    if (stripped === current) break;
    current = stripped;
  }
  return current || null;
}

module.exports = {
  textFromContent,
  isSyntheticUserText,
  isSyntheticUserEntry,
  extractGroupChatUserInput,
  displayUserText,
  searchableUserText,
  stripInjectedBlocks,
};
