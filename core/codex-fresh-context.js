'use strict';
// core/codex-fresh-context.js
//
// Phase 3 B3.6 — codex resume 第三档"fresh + ctx"注入路径。
//
// 语义（Spec S5 第三档）：
//   sid 失效 → --last 失效 → fresh+ctx
//   "fresh" = 普通 spawn 一个新 codex（不走 resume），不继承任何 sid
//   "ctx"   = 从 meeting orchestrator 取最近 N=3 轮会议历史，拼成 markdown
//             instructions 文本，通过 -c model_instructions_file=<file>
//             在 spawn 时注入（session-manager.js:660-662 已支持 codexInstructionFile）
//
// **B3.0 SPIKE 已落定**：codex 0.125.0 主交互模式 `-c key=value` 任意 TOML 路径覆盖
//   有效，Hub 现状已在用 model_instructions_file 注入首次 spawn 的 system prompt
//   （session-manager.js:660）。本 helper 写一个**临时 ctx 文件**让同一通道注入会议历史。
//
// 决策：
//   - **不动 session-manager / main.js**：现状 codexInstructionFile 入口已通；本 helper
//     只产出 instructions 文本与文件路径，由 caller 决定何时调用（手动入口或自动 fallback）。
//   - **不解析结构化字段**：直接拼 raw `turn.by[sid]` 文本（截断到 800 字防 prompt 爆炸）。
//   - **取最近 N 轮历史**：摘要功能 2026-05-08 整体下线后，所有轮次仅 fanout / debate；
//     按时间倒序取 maxTurns 最近轮次即可。

const fs = require('fs');
const path = require('path');

const DEFAULT_MAX_TURNS = 3;
const DEFAULT_PER_AI_BUDGET = 800;       // 单家文本最多多少字
const DEFAULT_USER_INPUT_BUDGET = 500;   // userInput 截断长度

/**
 * 从 orchestrator 取最近 N 轮历史，拼成 markdown instructions 文本。
 * @param {object} orchestrator           群聊 orchestrator 实例（必须有 getState()）
 * @param {object} [opts]
 * @param {number} [opts.maxTurns=3]      最多取多少轮
 * @param {number} [opts.perAiBudget=800] 单家文本截断长度
 * @param {number} [opts.userInputBudget=500] userInput 截断长度
 * @param {boolean}[opts.includeUserInput=true] 是否含 userInput 段
 * @param {function}[opts.sidLabelFn]     sid → label（如 '皮卡丘'），缺省用 sid 前 8 位
 * @returns {string}                      markdown 文本；无可用历史时返回 ''
 */
function buildContextInstructions(orchestrator, opts = {}) {
  if (!orchestrator || typeof orchestrator.getState !== 'function') return '';

  const {
    maxTurns = DEFAULT_MAX_TURNS,
    perAiBudget = DEFAULT_PER_AI_BUDGET,
    userInputBudget = DEFAULT_USER_INPUT_BUDGET,
    includeUserInput = true,
    sidLabelFn = null,
  } = opts;

  const state = orchestrator.getState();
  const turns = Array.isArray(state && state.turns) ? state.turns : [];
  if (turns.length === 0) return '';

  // 摘要功能 2026-05-08 整体下线：按时间倒序取最近 maxTurns 轮（仅 fanout / debate）
  const picked = turns.slice(-maxTurns);

  const sections = [];
  sections.push('# 历史会议上下文（fresh + ctx 注入）');
  sections.push('');
  sections.push('你正在通过 fresh-with-context 模式恢复一个 AI 群聊。原 codex sid 已不可用，');
  sections.push('以下是最近若干轮的会议历史，作为你继续讨论的背景。请基于此理解上下文，');
  sections.push('然后等待用户的下一轮 prompt。');
  sections.push('');

  for (const turn of picked) {
    if (!turn || typeof turn !== 'object') continue;
    sections.push(`## Turn ${turn.n || '?'} (mode=${turn.mode || 'unknown'})`);
    if (includeUserInput && turn.userInput) {
      const ui = String(turn.userInput).slice(0, userInputBudget);
      sections.push(`**用户输入**：${ui}${turn.userInput.length > userInputBudget ? '...(truncated)' : ''}`);
    }
    const byEntries = turn.by && typeof turn.by === 'object' ? turn.by : {};
    const sids = Object.keys(byEntries);
    if (sids.length === 0) {
      sections.push('_(本轮无可用回答)_');
    } else {
      for (const sid of sids) {
        const rawText = byEntries[sid];
        if (typeof rawText !== 'string' || !rawText.trim()) continue;
        const label = sidLabelFn ? (sidLabelFn(sid) || _shortSid(sid)) : _shortSid(sid);
        const truncated = rawText.slice(0, perAiBudget);
        sections.push(`**${label}**：`);
        sections.push(truncated + (rawText.length > perAiBudget ? '\n...(truncated)' : ''));
      }
    }
    sections.push('');
  }

  sections.push('---');
  sections.push('以上为历史上下文。请保持一致的角色定位，等待用户下一轮 prompt。');

  return sections.join('\n');
}

/**
 * 把 buildContextInstructions 的输出写到 instructions 文件，返回绝对路径。
 * 文件命名 codex-ctx-<meetingId>-<timestamp>.md，方便后续 cleanup。
 *
 * @param {object} orchestrator
 * @param {object} opts
 * @param {string} opts.outDir            输出目录（必填）
 * @param {string} [opts.meetingId='unknown']  用于文件名前缀
 * @param {string} [opts.fileName]        显式文件名（覆盖 meetingId+timestamp 命名）
 * @returns {Promise<string|null>}        文件路径；无可用历史时 null
 */
async function writeContextInstructionsFile(orchestrator, opts = {}) {
  const { outDir, meetingId = 'unknown', fileName, ...rest } = opts;
  if (!outDir) throw new Error('writeContextInstructionsFile: opts.outDir required');

  const text = buildContextInstructions(orchestrator, rest);
  if (!text) return null;

  const finalName = fileName || `codex-ctx-${_safeFileSegment(meetingId)}-${Date.now()}.md`;
  const fullPath = path.join(outDir, finalName);

  await fs.promises.mkdir(outDir, { recursive: true });
  await fs.promises.writeFile(fullPath, text, 'utf8');
  return fullPath;
}

// ---------- internal helpers ----------

function _shortSid(sid) {
  if (typeof sid !== 'string' || sid.length === 0) return 'AI';
  return `AI(${sid.slice(0, 8)})`;
}

function _safeFileSegment(s) {
  return String(s || 'unknown').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 32);
}

module.exports = {
  buildContextInstructions,
  writeContextInstructionsFile,
  // 暴露常量便于测试 / 调用方调参
  DEFAULT_MAX_TURNS,
  DEFAULT_PER_AI_BUDGET,
  DEFAULT_USER_INPUT_BUDGET,
};
