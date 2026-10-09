/**
 * claude-transcript-parser.js
 *
 * Parse a Claude Code transcript JSONL file (e.g.
 *   ~/.claude/projects/<project>/<session>.jsonl)
 * into a normalized array of conversation "turns" (user / assistant only).
 *
 * Filters out:
 *   - tool_result entries (type='user' but content is array of {type:'tool_result',...})
 *   - non user/assistant entries (queue-operation, attachment, last-prompt,
 *     custom-title, agent-name, ...)
 *   - corrupt JSONL lines (skipped, not thrown)
 *
 * Public API (CommonJS):
 *   parseClaudeTranscriptToTurns(jsonlPath, opts)
 *   parseAssistantContent(contentArray)
 *   isToolResultEntry(entry)
 */

const fs = require('node:fs');
const { isSyntheticUserEntry, displayUserText } = require('./synthetic-user-filter.js');

function isToolResultEntry(entry) {
  return !!(
    entry &&
    entry.type === 'user' &&
    entry.message &&
    Array.isArray(entry.message.content) &&
    entry.message.content.some(c => c && c.type === 'tool_result')
  );
}

// === Spec 3 · W9: 提取 tool_result entry 内的 result 列表 ===
// 一个 tool_result entry 的 message.content 可能含多条 tool_result（少见但合规）。
// 每条 tool_result.content 可以是 string 或 array of {type:'text'/'image',...}。
// 卡片视图只关心文本部分（image 暂不显示，留 spec 4+）。
// is_error=true 标记后端错误返回（renderer 渲红色）。
function extractToolResults(entry) {
  const out = [];
  if (!entry || !entry.message || !Array.isArray(entry.message.content)) return out;
  for (const c of entry.message.content) {
    if (!c || c.type !== 'tool_result' || !c.tool_use_id) continue;
    let textContent = '';
    if (typeof c.content === 'string') {
      textContent = c.content;
    } else if (Array.isArray(c.content)) {
      textContent = c.content
        .filter(b => b && b.type === 'text' && typeof b.text === 'string')
        .map(b => b.text)
        .join('\n');
    }
    out.push({
      tool_use_id: c.tool_use_id,
      content: textContent,
      isError: c.is_error === true,
    });
  }
  return out;
}

function parseAssistantContent(contentArray) {
  const result = { thinking: null, text: '', toolCalls: [] };
  if (!Array.isArray(contentArray) || contentArray.length === 0) {
    return result;
  }

  const thinkingParts = [];
  const textParts = [];

  for (const block of contentArray) {
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'thinking' && typeof block.thinking === 'string') {
      thinkingParts.push(block.thinking);
    } else if (block.type === 'text' && typeof block.text === 'string') {
      textParts.push(block.text);
    } else if (block.type === 'tool_use') {
      result.toolCalls.push({
        id: block.id,
        name: block.name,
        input: block.input,
      });
    }
  }

  result.thinking = thinkingParts.length > 0 ? thinkingParts.join('\n\n') : null;
  result.text = textParts.join('\n');
  return result;
}

function toMs(timestamp) {
  if (!timestamp) return null;
  const ms = new Date(timestamp).getTime();
  return Number.isFinite(ms) ? ms : null;
}

// 共用 entry → turn 转换（tool_result/空 entry 已在调用方过滤）。
// 返回 turn 对象或 null（非 user/assistant、空 assistant content）。
// The engine records a background task's completion as an injected user entry
// (origin.kind task-notification, text <task-notification>...) and answers it
// in a fresh assistant run. It is not a prompt; the reply continues the
// previous turn's card, as the live projection does (claude-native-transcript).
function isTaskNotificationText(text) {
  return String(text || '').trimStart().startsWith('<task-notification>');
}

function isTaskNotificationEntry(entry, text) {
  return entry.origin?.kind === 'task-notification' || isTaskNotificationText(text);
}

function _entryToTurn(entry) {
  if (entry.type === 'user') {
    const message = entry.message || {};
    const rawText = typeof message.content === 'string' ? message.content
      : Array.isArray(message.content) ? message.content.filter(c => c && c.type === 'text' && typeof c.text === 'string').map(c => c.text).join('\n') : '';
    if (isTaskNotificationEntry(entry, rawText)) return { role: 'continuation' };
    // displayUserText 负责两件事：滤掉纯系统注入，以及把 AI 群聊脚手架里
    // 用户真正打的那段（`## 用户`）抽出来——卡片只显示用户自己的话。
    if (typeof message.content === 'string') {
      if (isSyntheticUserEntry(entry, message.content)) return null;
      const text = displayUserText(message.content);
      if (!text) return null;
      return {
        id: entry.uuid,
        role: 'user',
        text,
        ts: toMs(entry.timestamp),
      };
    }
    // 数组 content（多模态 / 附件）→ 提取 text blocks 拼接为纯文本
    if (Array.isArray(message.content)) {
      const textBlocks = message.content
        .filter(c => c && c.type === 'text' && typeof c.text === 'string')
        .map(c => c.text);
      if (textBlocks.length) {
        const raw = textBlocks.join('\n');
        if (isSyntheticUserEntry(entry, raw)) return null;
        const text = displayUserText(raw);
        if (!text) return null;
        return {
          id: entry.uuid,
          role: 'user',
          text,
          ts: toMs(entry.timestamp),
        };
      }
    }
    return null;
  }
  if (entry.type === 'assistant') {
    const message = entry.message || {};
    const parsed = parseAssistantContent(message.content);
    const hasContent =
      (parsed.text && parsed.text.length > 0) ||
      (parsed.toolCalls && parsed.toolCalls.length > 0) ||
      (parsed.thinking && parsed.thinking.length > 0);
    if (!hasContent) return null;
    return {
      id: entry.uuid,
      role: 'assistant',
      text: parsed.text,
      ts: toMs(entry.timestamp),
      model: typeof message.model === 'string' ? message.model : undefined,
      stopReason:
        typeof message.stop_reason === 'string' ? message.stop_reason : undefined,
      thinking: parsed.thinking,
      toolCalls: parsed.toolCalls,
      usage: (message.usage && typeof message.usage === 'object') ? message.usage : undefined,
    };
  }
  return null;
}

// === Spec 3 · W5 合并连续 assistant entries ===
// Claude CLI 在 stop_reason='tool_use' 时把每次 LLM call 写成单独 entry：
// 一个 assistant entry = 1 thinking + 1 tool_use（D3 实测 5196 entries 中 0 或 1 个 tool）。
// 一次 user prompt 实际触发 N 个 assistant entries（中间夹 tool_result entry，已过滤）。
// 用户视角应该看到 1 个 logical turn（聚合所有 thinking/tools/text），而不是 N 张卡片。
//
// 合并规则：连续 assistant entries（之间可能夹 tool_result，已 skip）合为 1 turn，
//   终止于 stop_reason ∈ {end_turn, max_tokens, refusal, stop_sequence} 那条 entry（含）。
//   user 真消息出现 → flush 当前 acc。
//
// 字段合并：
//   id → 第一条 entry uuid（dedup 锚定，streaming 中保持稳定让 mountSessionTurnCard
//        replace 而非新增卡片）
//   text → 各 entry text 用 \n\n 拼接
//   thinking → 各 entry thinking 用 \n\n---\n\n 分隔拼接
//   toolCalls → flatten append（保持顺序）
//   ts → 第一条；tsEnd → 最后一条（用于头部"⏱ X.Ys"耗时 pill）
//   model → 最后一条（极少跨 model 切换；保最新）
//   stopReason → 最后一条（end_turn 表示真完成）
//   usage → 累计 input_tokens/output_tokens（multi-call 累积）
//   mergedCount → 合并的 entry 数（>1 表示发生了合并）
function _mergeConsecutiveAssistantTurns(turns) {
  const merged = [];
  let acc = null;

  const flush = () => {
    if (acc) {
      // thinking 数组 → 字符串
      if (Array.isArray(acc.thinking)) {
        acc.thinking = acc.thinking.length ? acc.thinking.join('\n\n---\n\n') : null;
      }
      merged.push(acc);
      acc = null;
    }
  };

  for (const t of turns) {
    if (t.role === 'boundary') { flush(); continue; }
    if (t.role === 'continuation') {
      // Reopen the settled card so the notification-driven run appends to it;
      // its earlier answer becomes one more progress row.
      const last = merged.at(-1);
      if (!acc && last && last.role === 'assistant') {
        acc = merged.pop();
        acc.thinking = typeof acc.thinking === 'string' ? [acc.thinking] : Array.isArray(acc.thinking) ? acc.thinking : [];
        for (const m of acc.displayMessages || []) if (m.phase === 'final_answer') m.phase = 'commentary';
        acc.continued = (acc.continued || 0) + 1;
      }
      continue;
    }
    if (t.role === 'user') {
      flush();
      merged.push(t);
      continue;
    }
    // assistant
    if (!acc) {
      acc = {
        id: t.id,
        role: 'assistant',
        text: t.text || '',
        ts: t.ts,
        tsEnd: t.ts,
        model: t.model,
        // 同上：无正文的终态 entry 只是过程标记，不能作为这一轮的终态依据。
        stopReason: isClaudeTurnStopReasonTerminal(t.stopReason) && !claudeEntryEndsAssistantTurn(t)
          ? undefined
          : t.stopReason,
        thinking: t.thinking ? [t.thinking] : [],
        toolCalls: Array.isArray(t.toolCalls) ? [...t.toolCalls] : [],
        usage: t.usage
          ? { input_tokens: t.usage.input_tokens || 0, output_tokens: t.usage.output_tokens || 0 }
          : { input_tokens: 0, output_tokens: 0 },
        mergedCount: 1,
        displayMessages: [],
      };
    } else {
      if (t.text) acc.text += (acc.text ? '\n\n' : '') + t.text;
      if (t.thinking) acc.thinking.push(t.thinking);
      if (Array.isArray(t.toolCalls) && t.toolCalls.length) acc.toolCalls.push(...t.toolCalls);
      acc.tsEnd = t.ts;
      // 无正文的终态 entry（交错思考的收尾块）不能把这一轮的 stopReason 改成终态，
      // 否则所有靠 stopReason 判完成的读取方都会以为答复已经写完。
      if (t.stopReason && (!isClaudeTurnStopReasonTerminal(t.stopReason) || claudeEntryEndsAssistantTurn(t))) {
        acc.stopReason = t.stopReason;
      }
      if (t.model) acc.model = t.model;
      if (t.usage) {
        // 多方审查 P0 (Gemini 找到)：Claude API 每次 call 的 input_tokens 是 prompt size，
        // 含完整历史（前面所有 user + assistant + tool_result）。N 次 call 累加 = O(N²)
        // 虚高，导致头部"📊 ctx%" pill 远超真实值（极端 case 100% ctx 但实际只 10%）。
        // 正解：input_tokens 取最后一条（=最大上下文 size）；output_tokens 才是各 call
        // 自己的输出，应累加。
        acc.usage.input_tokens = t.usage.input_tokens || acc.usage.input_tokens;
        acc.usage.output_tokens += t.usage.output_tokens || 0;
      }
      acc.mergedCount += 1;
    }
    if (t.text) acc.displayMessages.push({id:`claude-message-${t.id}`,text:t.text,
      ts:t.ts,phase:claudeEntryEndsAssistantTurn(t)?'final_answer':'commentary'});
    // 终止于「带正文的终态 entry」（一轮真完成）
    if (claudeEntryEndsAssistantTurn(t)) {
      flush();
    }
  }
  flush();

  return merged;
}

const TAIL_WINDOW_INITIAL_BYTES = 8 * 1024 * 1024;

function readTailWindowText(jsonlPath, bytes) {
  const stat = fs.statSync(jsonlPath);
  const size = stat.size;
  const start = Math.max(0, size - bytes);
  const len = size - start;
  const fd = fs.openSync(jsonlPath, 'r');
  try {
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, start);
    let raw = buf.toString('utf8');
    if (start > 0) {
      const firstNewline = raw.indexOf('\n');
      raw = firstNewline >= 0 ? raw.slice(firstNewline + 1) : '';
    }
    return { raw, size, start };
  } finally {
    fs.closeSync(fd);
  }
}

function parseClaudeTranscriptText(raw, opts = {}) {
  const entries = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try { entries.push(JSON.parse(trimmed)); } catch { /* 损坏行 skip */ }
  }
  return parseClaudeTranscriptEntries(entries, opts);
}

// 与 parseClaudeTranscriptText 同一套规则，输入是已解析的 entry。
// 搜索索引用它流式读完整文件，不必先把整个 transcript 拼成一个字符串。
function parseClaudeTranscriptEntries(entries, opts = {}) {
  const rawTurns = [];
  // Spec 3 · W9：tool_use_id → result 映射，用于关联 stdout 到 toolCall
  const toolResultMap = new Map();
  const excludeEntryIds = new Set(opts.excludeEntryIds || []);
  const excludeMessageIds = new Set(opts.excludeMessageIds || []);

  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue;
    if (excludeEntryIds.has(entry.uuid) || excludeMessageIds.has(entry.message?.id)) {
      // Keep the conversational boundary even when the live projection already
      // renders this input. Later provider entries may not have reached Hub's
      // journal before a disconnect; they must remain readable.
      if (entry.type === 'user' && !isToolResultEntry(entry)) rawTurns.push({ role: 'boundary' });
      continue;
    }

    // tool_result entry：提取后存映射，不作为 turn
    if (isToolResultEntry(entry)) {
      const results = extractToolResults(entry);
      for (const r of results) {
        toolResultMap.set(r.tool_use_id, { content: r.content, isError: r.isError });
      }
      continue;
    }

    const turn = _entryToTurn(entry);
    if (turn) rawTurns.push(turn);
  }

  // Spec 3 · W9：把 result 关联到对应 toolCall（必须在 merge 之前 — merge 后 toolCalls flatten 不丢 id）
  for (const t of rawTurns) {
    if (t.role !== 'assistant' || !Array.isArray(t.toolCalls)) continue;
    for (const tc of t.toolCalls) {
      const r = tc && tc.id ? toolResultMap.get(tc.id) : null;
      if (r) {
        tc.result = r.content;
        tc.isError = r.isError;
      }
    }
  }

  // Spec 3 · W5：合并连续 assistant entries
  const merged = _mergeConsecutiveAssistantTurns(rawTurns);

  return merged;
}

function applyTurnLimit(turns, limit, fromTail) {
  if (typeof limit === 'number' && limit < turns.length) {
    return fromTail
      ? turns.slice(turns.length - limit)
      : turns.slice(0, limit);
  }
  return turns;
}

// A fixed byte tail can begin in the middle of one logical assistant turn.
// Parsing that suffix is dangerous: Claude's consecutive assistant records are
// merged by the first visible UUID, so the same answer receives a different id
// (and loses its earlier text/tools) than a full parse.  The tail is safe when
// it starts at a real user boundary, or when the incomplete leading turn is
// outside the requested slice and will be discarded.
/**
 * 这一轮 Claude 是否真的结束了 —— 唯一判据是 stop_reason。
 *
 * 'tool_use' = 还要接着干（正文往往只是「我先读 X，再改 Y」这种开场白）；
 * null/undefined = 还在流式写入，尚未 finalize。
 * 只有 end_turn / max_tokens / refusal / stop_sequence 这类终态才算答完。
 *
 * 上面 _mergeConsecutiveAssistantTurns 的合并规则就是靠它切轮的，所以合并后
 * turn 的 stopReason 一定是最后一条 entry 的值 —— 拿它判终态是自洽的。
 *
 * 2026-09-06：抽成导出函数，是因为群聊的自动提取曾经**完全不看 stop_reason**，
 * 只要 transcript 末尾有比本轮 prompt 新的文本就当最终答案。实测把
 * stop_reason='tool_use' 的开场白当成了 Claude 的最终回答，串行工作流因此提前
 * 放行下一步。判据必须只有一处，不能让调用方各自再猜一遍。
 */
function isClaudeTurnStopReasonTerminal(stopReason) {
  return typeof stopReason === 'string' && stopReason !== '' && stopReason !== 'tool_use';
}

/**
 * 这条 assistant content 里有没有「给用户看的正文」。
 *
 * thinking 与 tool_use 都不算：它们是过程，不是答复。
 */
function claudeAssistantContentHasAnswerText(content) {
  if (typeof content === 'string') return content.trim() !== '';
  if (!Array.isArray(content)) return false;
  return content.some(block => block
    && block.type === 'text'
    && typeof block.text === 'string'
    && block.text.trim() !== '');
}

/**
 * 这条 entry 是不是「本轮到此为止」。
 *
 * 只看 stop_reason 不够。2026-09-06 在真实 transcript 里实测到：Claude Code 会把
 * 一段交错思考单独落成一条 assistant entry —— content 只有一个 thinking 块（signature
 * 有值、thinking 文本是空串），stop_reason 却已经是 'end_turn'，而真正的答复在 23 秒
 * 之后才写进来。只认 stop_reason 的话，这条 entry 会把本轮判成已完成，把之前那句
 * 「我先读取一下这个文件」当成最终答复送出去。
 *
 * 判据补一条：终态 entry 必须自己带正文。没有正文的终态 entry 是过程标记，本轮继续。
 */
function claudeEntryEndsAssistantTurn(turn) {
  return !!turn
    && isClaudeTurnStopReasonTerminal(turn.stopReason)
    && typeof turn.text === 'string'
    && turn.text.trim() !== '';
}

function isTailTurnSliceComplete(turns, limit) {
  if (!Array.isArray(turns) || turns.length < limit) return false;
  if (turns.length > limit) return true;
  return turns.length > 0 && turns[0].role === 'user';
}

function parseClaudeTranscriptToTurns(jsonlPath, opts = {}) {
  const { limit, fromTail = false } = opts;
  if (typeof limit === 'number' && limit <= 0) return [];

  if (fromTail && typeof limit === 'number') {
    const stat = fs.statSync(jsonlPath);
    if (stat.size > TAIL_WINDOW_INITIAL_BYTES) {
      // Read the small tail once.  The previous 8 -> 16 -> 32 MB expansion
      // reparsed every earlier window before finally reading the whole file;
      // a 46 MB transcript therefore caused ~105 MB of synchronous IO per
      // request.  If the tail cannot satisfy the requested turn count, jump
      // directly to one full read instead of replaying overlapping windows.
      const { raw } = readTailWindowText(jsonlPath, TAIL_WINDOW_INITIAL_BYTES);
      const tailTurns = parseClaudeTranscriptText(raw, opts);
      if (isTailTurnSliceComplete(tailTurns, limit)) {
        return applyTurnLimit(tailTurns, limit, true);
      }
    }
  }

  const raw = fs.readFileSync(jsonlPath, 'utf8');
  return applyTurnLimit(parseClaudeTranscriptText(raw, opts), limit, fromTail);
}

module.exports = {
  parseClaudeTranscriptToTurns,
  isClaudeTurnStopReasonTerminal,
  claudeAssistantContentHasAnswerText,
  claudeEntryEndsAssistantTurn,
  parseAssistantContent,
  isToolResultEntry,
  extractToolResults,
  parseClaudeTranscriptText,
  parseClaudeTranscriptEntries,
  isTaskNotificationText,
};
