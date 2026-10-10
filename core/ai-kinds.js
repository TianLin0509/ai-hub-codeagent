'use strict';
// core/ai-kinds.js — AI kind 单一真理源
//
// 背景（2026-05-02 用户血泪反馈）：
//   项目最早只支持 claude/gemini/codex 三家，后加了 deepseek（最初跑在 Claude CLI 上），
//   但许多分支判断当时硬编码 ['claude', 'gemini', 'codex'] 三家，导致：
//     - 一键提取按钮对 DS 永远失败（"按钮假的"）
//     - DS 卡片不更新（依赖 Claude Stop hook，但分支没接通）
//     - DS 子 session 无法自动获取标题
//     - DS 普通发送可能卡输入框（缺 paste-detect 延迟补偿）
//     - DS aiStats 迁移失败（_isLegacyKindKeyed 白名单不全）
//     - BASE_RULES 系统 prompt 告诉 DS"你是 Claude/Gemini/Codex 三家之一"
//
// 解决：把所有"AI 列表 / 家族判定 / 标志位"集中到本文件，**所有调用方必须 require 这里的常量
//   和 helper**，禁止再写 ['claude', 'gemini', 'codex'] 字面量。
//   单测 unit-ai-kinds-no-hardcode.test.js 用 grep 兜底防回归。

// ---------------------------------------------------------------------------
// 全部支持的 AI kind（群聊可参与的）。
//   新增 AI 时只需追加这个数组 + 补 KIND_LABELS。
//   不含 'powershell' 等非 AI 类型。
// ---------------------------------------------------------------------------
const ALL_AI_KINDS = ['claude', 'gemini', 'codex', 'deepseek', 'kimi', 'qwen', 'deepseek-acp', 'glm', 'codeagent'];
// Offered by the group-creation and writing-member pickers.
const GROUP_MEMBER_KINDS = ['claude', 'codex', 'deepseek', 'qwen', 'deepseek-acp', 'glm', 'codeagent'];
const WEB_STYLE_KINDS = [];
// DeepSeek V4 Pro / Flash 原生支持 Responses API，并适配 Codex 0.144.0+。
// 新 DeepSeek 会话因此也属于 Codex CLI runtime；老会话恢复时
// 仍可用下面的 deepseek-legacy 内部 kind 回到 Claude transcript。
const CODEX_CLI_KINDS = ['codex', 'codex-resume', 'deepseek', 'deepseek-resume'];
const CODEX_SESSION_KINDS = [...CODEX_CLI_KINDS];
const KIMI_CLI_KINDS = ['kimi', 'kimi-resume'];
// 公司内部 Code Agent CLI：界面、配置、记录与 hook 都是 Claude Code 形态，所以归入 Claude 家族；
// 与 Claude 的差异（不认 --session-id / --settings、命令名与配置目录不同）见 core/codeagent-config.js。
const CODEAGENT_KINDS = ['codeagent', 'codeagent-resume'];
const CLAUDE_WEB_KINDS = [];
const CODEX_WEB_KINDS = [];

// ---------------------------------------------------------------------------
// 显示标签（UI 各处显示家族短名用）。
//   新增 AI 时同步追加。
// ---------------------------------------------------------------------------
const KIND_LABELS = {
  claude: 'Claude',
  gemini: 'Gemini',
  codex: 'Codex',
  deepseek: 'DeepSeek',
  kimi: 'Kimi',
  qwen: '千问',
  'deepseek-acp': 'DeepSeek 原生',
  glm: '智谱',
  codeagent: 'CodeAgent',
};

// Initial titles used by provider harnesses, shared with auto-title eligibility.
const HARNESS_LABELS = { qwen: '千问 · Qwen Code', 'deepseek-acp': 'DeepSeek · 原生 Harness', glm: '智谱 · ZCode' };

// ---------------------------------------------------------------------------
// Claude 家族（共享 Claude Code CLI 引擎）：
//   - claude         主 Claude（~/.claude）
//   - claude-resume  resume 路径（同主）
//   - deepseek-legacy / deepseek-legacy-resume
//                    仅用于恢复 2026-08-09 以前的 DeepSeek Claude transcript
// 共享：transcript JSONL shape / Stop hook / OSC title 协议 / system prompt 注入参数 (--append-system-prompt)
// ---------------------------------------------------------------------------
const CLAUDE_FAMILY = ['claude', 'claude-resume', 'deepseek-legacy', 'deepseek-legacy-resume', ...CODEAGENT_KINDS];

// ---------------------------------------------------------------------------
// TUI alt-screen 程序（paste-sensitive）：
//   把紧贴到达的字符当"粘贴"事件，紧贴的 \r 不会被识别为 Enter。
//   AI CLI 都是 TUI alt-screen；powershell 等普通 shell 不是。
//   普通模式发送 prompt 时这些 kind 需要 ≥400ms 延迟才能让 paste-detect 完成。
// ---------------------------------------------------------------------------
const PASTE_SENSITIVE_KINDS = ['claude', 'claude-resume', 'gemini', 'codex', 'codex-resume', 'deepseek', 'deepseek-resume', 'kimi', 'kimi-resume', ...CODEAGENT_KINDS];

// ---------------------------------------------------------------------------
// 跑在 Claude CLI 上、复用 Stop hook + transcript JSONL 的 kind。
//   ClaudeTap 用此判定。CLAUDE_FAMILY 的别名（语义相同），保留两个名字让调用点更可读。
// ---------------------------------------------------------------------------
const CLAUDE_HOOK_BACKED = CLAUDE_FAMILY;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function isClaudeFamily(kind) {
  return CLAUDE_FAMILY.includes(kind);
}

function isPasteSensitive(kind) {
  return PASTE_SENSITIVE_KINDS.includes(kind);
}

function isAiKind(kind) {
  return ALL_AI_KINDS.includes(kind) || WEB_STYLE_KINDS.includes(kind);
}

function isCodexCliKind(kind) {
  return CODEX_CLI_KINDS.includes(kind);
}

function isCodexSessionKind(kind) {
  return CODEX_SESSION_KINDS.includes(kind);
}

function isKimiCliKind(kind) {
  return KIMI_CLI_KINDS.includes(kind);
}

function isCodeAgentKind(kind) {
  return CODEAGENT_KINDS.includes(kind);
}

function isClaudeWebKind(kind) {
  return CLAUDE_WEB_KINDS.includes(kind);
}

function isCodexWebKind(kind) {
  return CODEX_WEB_KINDS.includes(kind);
}

function isWebStyleKind(kind) {
  return isClaudeWebKind(kind) || isCodexWebKind(kind);
}

function getKindLabel(kind) {
  if (kind === 'deepseek-legacy' || kind === 'deepseek-legacy-resume') return KIND_LABELS.deepseek;
  return KIND_LABELS[kind] || kind || 'AI';
}

// listKindsForPrompt 已删除（2026-05-08）：刻意不向 AI prompt 注入家族枚举，
// 避免 LLM 对其他 AI 模型形成 stereotype 先验。

// 正则字符类，用于 @<who> 等命令解析。
// 返回类似 "claude|gemini|codex|deepseek"。
function kindRegexAlternation() {
  return ALL_AI_KINDS.join('|');
}

// ---------------------------------------------------------------------------
// Phase 4 family canonical 映射（群聊记忆系统按家族存储）
//   - 'codex' (Codex CLI) 是 OpenAI 家族 → 归并到 'gpt'
//   - 'claude-resume' 是 Claude resume 路径（语义同 'claude'）→ 归为 'claude'
//   - 其他 kind 各自独立家族
//   返回家族字符串：claude / gemini / gpt / deepseek
// ---------------------------------------------------------------------------
// 群聊记忆系统的家族存储 key 集合（去重 canonical 后）
const FAMILY_KINDS = ['claude', 'gemini', 'gpt', 'deepseek', 'kimi', 'qwen', 'glm', 'codeagent'];
const _FAMILY_SET = new Set(FAMILY_KINDS);

function canonicalAiKind(rawKind) {
  if (rawKind === 'deepseek-acp' || rawKind === 'deepseek-acp-resume') return 'deepseek';
  if (rawKind === 'qwen-resume') return 'qwen';
  if (rawKind === 'glm-resume') return 'glm';
  if (rawKind === 'codex') return 'gpt';
  if (rawKind === 'claude-resume') return 'claude';
  if (rawKind === 'deepseek-resume' || rawKind === 'deepseek-legacy' || rawKind === 'deepseek-legacy-resume') return 'deepseek';
  if (rawKind === 'kimi-resume') return 'kimi';
  if (rawKind === 'codeagent-resume') return 'codeagent';
  const out = rawKind || 'unknown';
  // [Phase 4 silent-failure-hunt] 静默 fall-through 会让未来新加的 kind（如 'mistral'）
  //   生成预期外的 .md 文件，且 _runLegacyMigration 不会归档它（因为不在 FAMILY_SET）。
  //   warn 一次即可让维护者知道补 FAMILY_KINDS。
  if (!_FAMILY_SET.has(out) && out !== 'unknown') {
    console.warn(`[ai-kinds] canonicalAiKind: unknown kind '${rawKind}', treating as-is — 请补 FAMILY_KINDS`);
  }
  return out;
}

// ---------------------------------------------------------------------------
// 群聊席位（slot）单一真理源 — 2026-05-03 maintainer
//   背景：群聊允许 5 选 3 + 同 kind 多份（如 3 claude），按 kind 区分总结人/@对象
//     不可行（dropdown 只显 1 个 Claude，sidByKind 永远返回首匹配）。改为按 slot 索引
//     绑定 stable id，@解析、prompt、归档全用 slot id。
//   命名：内部 id 走 ASCII（让正则 \b 边界正常工作），UI 显示中英双语方便用户识别。
// ---------------------------------------------------------------------------
const SLOT_IDS = ['member1', 'member2', 'member3'];

const SLOT_DISPLAY = {
  member1: { en: 'Member 1', zh: '一号位', icon: '1' },
  member2: { en: 'Member 2', zh: '二号位', icon: '2' },
  member3: { en: 'Member 3', zh: '三号位', icon: '3' },
};

// 给 prompt 用的中文名（AI 上下文用，亲切感优先；id 仍走英文 ASCII 在别处保留）。
function getSlotPromptName(slotIdOrIndex) {
  const id = typeof slotIdOrIndex === 'number' ? SLOT_IDS[slotIdOrIndex] : slotIdOrIndex;
  return SLOT_DISPLAY[id]?.zh || 'AI';
}

// 给 UI 卡片显示用的双语标签。
function getSlotDisplayLabel(slotIdOrIndex) {
  const id = typeof slotIdOrIndex === 'number' ? SLOT_IDS[slotIdOrIndex] : slotIdOrIndex;
  const d = SLOT_DISPLAY[id];
  return d ? `${d.icon} ${d.en} · ${d.zh}` : 'AI';
}

// 正则字符类，用于 @<slot> / @summary @<slot> 命令解析。返回 "member1|member2|member3"。
function slotIdRegexAlternation() {
  return SLOT_IDS.join('|');
}

// slot id ↔ slot index 双向映射 helper。
function slotIdToIndex(slotId) {
  return SLOT_IDS.indexOf(slotId);
}
function slotIndexToId(idx) {
  return SLOT_IDS[idx] || null;
}

module.exports = {
  ALL_AI_KINDS,
  GROUP_MEMBER_KINDS,
  WEB_STYLE_KINDS,
  CODEX_CLI_KINDS,
  CODEX_SESSION_KINDS,
  KIMI_CLI_KINDS,
  CODEAGENT_KINDS,
  CLAUDE_WEB_KINDS,
  CODEX_WEB_KINDS,
  KIND_LABELS,
  HARNESS_LABELS,
  CLAUDE_FAMILY,
  CLAUDE_HOOK_BACKED,
  PASTE_SENSITIVE_KINDS,
  isClaudeFamily,
  isPasteSensitive,
  isAiKind,
  isCodexCliKind,
  isCodexSessionKind,
  isKimiCliKind,
  isCodeAgentKind,
  isClaudeWebKind,
  isCodexWebKind,
  isWebStyleKind,
  getKindLabel,
  kindRegexAlternation,
  // Phase 4 群聊记忆家族级共享
  canonicalAiKind,
  FAMILY_KINDS,
  // slot 单一真理源
  SLOT_IDS,
  SLOT_DISPLAY,
  getSlotPromptName,
  getSlotDisplayLabel,
  slotIdRegexAlternation,
  slotIdToIndex,
  slotIndexToId,
};
