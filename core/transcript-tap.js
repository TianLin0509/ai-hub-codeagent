'use strict';
// core/transcript-tap.js
//
// 统一 Transcript 抽取适配器：从各 CLI（Claude / Codex / Gemini / Kimi）自动落盘的
// 权威 transcript 文件读取最后一轮 AI 回答，替代会议室 SM-START/SM-END 标识符协议。
//
// 路径（已在 2026-04-25 实测确认）：
//   Claude:  ~/.claude/projects/<slug>/<sid>.jsonl        每行 {type:"assistant|user|tool_*"}
//   Codex:   ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl assistant/final item events
//   Gemini:  ~/.gemini/tmp/<dir>/chats/session-*.jsonl    行 type:"gemini" 带 tokens 字段
//
// 完成信号：
//   Claude:  transcript stop_reason 主路径 + Stop hook 快路径
//   Codex:   task_complete (final_answer is a message, not a task receipt)
//   Gemini:  JSONL 新增 type:"gemini" 行且 tokens.total != null（非流式中间态）
//
// Fallback：若任一 Tap 未捕获（hook 未触发 / 文件路径漂移 / CLI 版本不兼容），

const { EventEmitter } = require('events');
const { processLiveTags: devLiveTags } = require('./dev-workbench-feed');
const { isClaudeFamily, isCodexCliKind, isKimiCliKind } = require('./ai-kinds.js');
const fs = require('fs');
const path = require('path');
const os = require('os');
const {
  parseClaudeTranscriptToTurns,
  isClaudeTurnStopReasonTerminal,
  claudeAssistantContentHasAnswerText,
} = require('./claude-transcript-parser');
const {
  codexRolloutMetaMatchesSid,
  isCodexTopLevelRolloutMeta,
  parseCodexRolloutToTurns,
  readCodexRolloutMeta,
} = require('./codex-transcript-parser.js');
const {
  createCodexLineFilter,
  streamCodexJsonlRecordsSync,
} = require('./codex-rollout-reader.js');
const { JsonlTail } = require('./jsonl-tail.js');
const {
  codexAgentMessageEventFromRecord,
  codexTaskErrorEventFromRecord,
  codexTurnIdFromPayload,
  codexUserMessageEventFromRecord,
  timestampToMs,
} = require('./transcript-payload-utils.js');
const { KimiTap } = require('./kimi-transcript-tap.js');

// ---------------------------------------------------------------------------
// JsonlTail — 共用工具：监听 JSONL 文件增长，按行回调 JSON.parse 后的对象
// ---------------------------------------------------------------------------
// 设计：
// - fs.watch 监听文件事件（Windows ConPTY 偶发丢事件，降级 500ms 轮询 mtime）
// - 维护 offset，每次增长从 offset 读到尾，按 \n 切行
// - JsonlByteScanner 保留跨 chunk 的原始字节，完整行才做 UTF-8/JSON 解码
// - onLine 回调异常会记录并丢弃该行，单行失败不影响后续 tail

// ---------------------------------------------------------------------------
// ClaudeTap — prompt 时预绑定 transcript，Stop hook 与 stop_reason 双通道收口
// ---------------------------------------------------------------------------
// Claude Code 的 transcript 由 CC CLI 自己写入；每个 hook 都携带路径。Hub 在
// UserPromptSubmit 时从 EOF 开始监听，终态 stop_reason 可独立闭环；Stop hook 到达时
// 仍会直接读取末轮作为低延迟快路径。

// Card optimization Task 1（2026-05-01）— ClaudeTap 升级流式 tail：
//   旧实现：只在 Stop hook 触发时一次性读 transcript 末尾的 last assistant；renderer 看不到 thinking/tool_use。
//   新实现：prompt hook 首次拿到 transcriptPath 后，启动 JsonlTail；
//          后续每条新 assistant message_id 块（thinking / text / tool_use）累积到 _streamingBuf；
//          getStreamingText / clearStreamingBuf 暴露给上层（main.js groupChatWatcher.extractStreamingText 优先使用）。
//   降级：路径不可用时 main.js 仍走 PTY 观察兜底（既有体验，不回归）。
//
// 2026-05-02 根治升级（Bug "DeepSeek/GLM 卡片不更新"）：
//   旧链路：Stop hook 触发 → notifyStop → emit 'turn-complete' → watcher settle
//   断点：Stop hook 因任何原因没触发（CLI 自我退出 / hook 5s timeout / settings.json 漂移）→ 永不 emit
//         → watcher 无限等待 → 卡片停在上一轮
//   根治：JsonlTail.onLine 看到新 assistant 行时启动 5s idle timer，连续 5s 无新行视为本轮答完，
//         **主动 emit 'turn-complete'**（兜底信号）。Stop hook 仍是快路径：来了立即 emit + 取消 timer。
const _CLAUDE_STREAM_BUF_MAX_BYTES = 50000;
// 2026-05-03 maintainer R3：用 Claude 自带的 message.stop_reason 语义信号判定本轮真结束。
//   原 5s idle 启发式在 tool_use 边界后误触发 — Claude 等 tool_result + 思考可达 27-67s
//   静默（无新 assistant 行），被 hub 当成"本轮答完"主动 emit，导致后续真答案 M2（4647 字）
//   到达 transcript 时 watcher 已 settle 无人监听，卡片永远定格在 M1 首句。
//   R3 主路径：onLine 看到 stop_reason ∈ {end_turn, max_tokens, refusal} 立即（200ms 防抖）emit；
//             "tool_use" / null 不 emit，等下一条 message。
//   90s idle 仅留作"transcript 完全卡死/写入异常"的最终兜底，不再是主路径。
const _CLAUDE_STOP_REASON_DEBOUNCE_MS = 200;
// 2026-05-05 maintainer：从 90s 缩回 15s。R3 之前 5s idle 误触发的根因不是时长，是 readLast
//   会把 tool_use 行的"我先读取..."中间 text 当成本轮答案 emit。现在 _scheduleIdleEmit
//   改用 readLastTerminalAssistantTextFromClaudeTranscript 终态过滤（只接受 stop_reason
//   ∈ {end_turn, max_tokens, refusal}），中间态行被跳过 → 时长可以安全缩短。
//   兜底场景：transcript 写入异常 / Stop hook 没触发 / stop_reason 字段缺失。
//   15s 取舍：足够等待 transcript 异步刷盘 + fs.watch 漂移，又不至于让用户卡得明显。
const _CLAUDE_IDLE_EMIT_MS = 15 * 1000;

// 2026-05-02 Gemini 兜底：与 ClaudeTap 同套 idle-timer 思路。用户血泪反馈：
//   "第一轮 Gemini 子 session 输出后没快速提取，手动提取后流程继续"。
// 根因：GeminiTap.onLine 仅 L1a result_event / L1b message_update / L3 tokens.total
//   三种情况触发 emit。第一轮启动慢时 token 计数延迟到达，三个信号都没到 → 卡片永远
//   停在 streaming，需要用户手动点"一键提取"。
// 兜底：每条带 content 的 gemini 行重置 5s timer，连续 5s 无新行 → 主动 emit
//   turn-complete（signalSource=idle_timer_5s）。L1/L3 抢先时取消 timer。
const _GEMINI_IDLE_EMIT_MS = 5000;

class ClaudeTap extends EventEmitter {
  constructor(opts = {}) {
    super();
    this._parserService = opts.parserService || null;
    this._bound = new Map(); // hubSessionId → { transcriptPath, lastText, _streamingBuf, _tail }
  }

  registerSession(hubSessionId, ctx = {}) {
    if (!this._bound.has(hubSessionId)) {
      this._bound.set(hubSessionId, {
        transcriptPath: null,
        lastText: null,
        lastModel: null,    // T13: 最近一条 assistant message.model
        lastUsage: null,    // T13: 最近一条 assistant message.usage
        _streamingBuf: [],
        _tail: null,
        _idleTimer: null,
        _stopReasonTimer: null,  // R3: stop_reason 终态防抖 timer
        _pendingEmitText: null,
        currentTurnId: null,
      });
    }
    const entry = this._bound.get(hubSessionId);
    if (ctx && typeof ctx.transcriptPath === 'string' && ctx.transcriptPath) {
      entry.transcriptPath = ctx.transcriptPath;
    }
  }

  hasSession(hubSessionId) {
    return this._bound.has(hubSessionId);
  }

  unregisterSession(hubSessionId) {
    const entry = this._bound.get(hubSessionId);
    if (entry?._tail) {
      try { entry._tail.close(); } catch {}
    }
    if (entry?._idleTimer) {
      try { clearTimeout(entry._idleTimer); } catch {}
    }
    if (entry?._stopReasonTimer) {
      try { clearTimeout(entry._stopReasonTimer); } catch {}
    }
    this._bound.delete(hubSessionId);
  }

  getLastAssistantText(hubSessionId) {
    const e = this._bound.get(hubSessionId);
    return e?.lastText || null;
  }

  notePrompt(hubSessionId) {
    const entry = this._bound.get(hubSessionId);
    if (!entry) return;
    // A new Hub dispatch is a real local turn boundary even when the Claude
    // UserPromptSubmit hook is missing. Never let the previous hook turn id be
    // reused by a later stop_reason event.
    entry.currentTurnId = null;
    entry.promptNotedAt = Date.now();
    entry.lastText = null;
    this._cancelIdleEmit(hubSessionId);
    this._cancelStopReasonEmit(hubSessionId);
  }

  // 2026-05-02 Bug 修复：扩展手动提取支持 Claude/DeepSeek/GLM。
  //   旧版本仅 GeminiTap 有 extractLatestGeminiTurn → 用户对 Claude/DeepSeek/GLM 卡片点
  //   "一键提取"永远拿到 null，UI 显"提取失败"——按钮形同虚设。
  //   新版本：复用 parseClaudeTranscriptToTurns 读 transcript 末尾的合并 turn，并按
  //   sincePromptTs 做时间窗下界过滤（见下方 2026-07-20 修复说明）。
  //   返回 { text, source } 与 GeminiTap 同形；transcriptPath 未知（hook/scan 都未拿到）→ null。
  //
  // 2026-05-14 maintainer：切到合并版 readLastAssistantTurnMergedTextFromClaudeTranscript，
  //   修群聊只拿到 [3] recap 段的 bug（plan 段在首条 entry，旧函数只读末条）。
  //
  // 2026-07-20 maintainer [修#1]：补上 sincePromptTs 时间窗下界。旧版忽略该参数 —— AI 卡住
  //   /思考中时 transcript 最后一个完整 turn 是「上一轮」的答案，一键提取会把它抓进
  //   本轮（张冠李戴）。现在末轮完成时间早于本轮 prompt 5s 以上 → 视为旧答案拒绝提取。
  async extractLatestTurn(hubSessionId, sincePromptTs = 0) {
    const entry = this._bound.get(hubSessionId);
    if (!entry || !entry.transcriptPath) return null;
    let last = null;
    try {
      const turns = this._parserService
        ? (await this._parserService.parse('claude', entry.transcriptPath, { limit: 1, fromTail: true })).turns
        : parseClaudeTranscriptToTurns(entry.transcriptPath, { limit: 1, fromTail: true });
      last = turns[turns.length - 1];
    } catch { return null; }
    if (!last || last.role !== 'assistant') return null;
    const turnEndMs = last.tsEnd || last.ts || 0;
    if (sincePromptTs && turnEndMs && turnEndMs < sincePromptTs - 5000) return null;
    const text = typeof last.text === 'string' ? last.text.trim() : '';
    if (!text) return null;
    // 2026-09-06：带上终态证据。手动「一键提取/同步」是用户主动要"现在有什么给我什么"，
    //   拿到 partial_commentary 也照样用；但自动路径（群聊 auto-extract / 重启恢复）
    //   必须只认 final_answer —— 否则 stop_reason='tool_use' 的开场白会被当成最终答案。
    //   词汇与 CodexTap.extractLatestCodexTurn 对齐，调用方两家共用一套判据。
    const isFinal = isClaudeTurnStopReasonTerminal(last.stopReason);
    return {
      text,
      source: 'manual_claude_transcript',
      completedAt: turnEndMs || null,
      stopReason: last.stopReason || null,
      extractMode: isFinal ? 'final_answer' : 'partial_commentary',
    };
  }

  getStreamingText(hubSessionId) {
    const e = this._bound.get(hubSessionId);
    if (!e || !Array.isArray(e._streamingBuf) || e._streamingBuf.length === 0) return null;
    return [...e._streamingBuf];
  }

  clearStreamingBuf(hubSessionId) {
    const e = this._bound.get(hubSessionId);
    if (e) e._streamingBuf = [];
  }

  // 由 main.js 的 /api/hook/stop 路由调用。transcriptPath 是 CC 原生给的
  // ~/.claude/projects/<slug>/<ccSessionId>.jsonl。
  async notifyStop(hubSessionId, transcriptPath, options = {}) {
    if (!transcriptPath || !hubSessionId) return;
    if (!this._bound.has(hubSessionId)) {
      this._bound.set(hubSessionId, {
        transcriptPath: null, lastText: null,
        lastModel: null, lastUsage: null,    // T13
        _streamingBuf: [], _tail: null,
        _idleTimer: null, _stopReasonTimer: null, _pendingEmitText: null,
        currentTurnId: null,
      });
    }
    const entry = this._bound.get(hubSessionId);
    if (options.newTurn === true) {
      entry.currentTurnId = options.turnId ? String(options.turnId) : null;
      entry.lastText = null;
      this._cancelIdleEmit(hubSessionId);
      this._cancelStopReasonEmit(hubSessionId);
    }
    else if (options.turnId) entry.currentTurnId = String(options.turnId);
    const boundPathChanged = entry.transcriptPath !== transcriptPath;
    if (boundPathChanged && entry._tail) {
      // A legitimate resume can move to a new transcript. Never leave a tail
      // watching path A while terminal detection reads path B.
      try { entry._tail.close(); } catch {}
      entry._tail = null;
      entry._streamingBuf = [];
      this._cancelIdleEmit(hubSessionId);
      this._cancelStopReasonEmit(hubSessionId);
    }
    entry.transcriptPath = transcriptPath;

    // Claude 过去只在 turn-complete 里带回文本，从不 emit session-bound —— 于是
    // ccSessionId 只能等调用方自己去 sessionManager 里捞。对 Agent 联赛这种无人值守
    // 场景后果很实在：一轮中途失败就没人落 ccSessionId，第二天只能开一个全新会话，
    // Agent 的历史与记忆连续性断在这里。路径变化时补一条，与 codex/kimi 对齐。
    if (boundPathChanged) {
      const ccSessionId = path.basename(String(transcriptPath)).replace(/\.jsonl$/i, '');
      if (ccSessionId) {
        this.emit('session-bound', { hubSessionId, kind: 'claude', ccSessionId, transcriptPath });
      }
    }

    // 首次拿到路径 → 启动 JsonlTail，让后续轮也能流式
    if (!entry._tail) {
      const onLine = (obj) => {
        // Esc 中断时 Claude 不发 Stop hook，只在 transcript 里写一条
        // "[Request interrupted by user…]" 的 user 记录。这是中断唯一的语义证据，
        // 漏掉它会让 Hub 一直显示「正在工作」。
        if (obj?.type === 'user' && !obj.isSidechain) {
          const content = obj.message?.content;
          const text = typeof content === 'string' ? content
            : Array.isArray(content) ? content.filter(block => block && block.type === 'text').map(block => block.text || '').join('\n') : '';
          if (String(text).trimStart().startsWith('[Request interrupted by user')) {
            this._cancelIdleEmit(hubSessionId);
            this._cancelStopReasonEmit(hubSessionId);
            this.emit('turn-aborted', {
              hubSessionId,
              transcriptPath: entry.transcriptPath,
              abortedAt: timestampToMs(obj.timestamp) || Date.now(),
              turnId: entry.currentTurnId || null,
              signalSource: 'claude-interrupt-marker',
            });
          }
          return;
        }
        if (obj?.type !== 'assistant' || !obj.message?.content) return;
        const content = obj.message.content;
        if (!Array.isArray(content)) return;
        // 一条消息里可能同时有 PLAN / UPDATE / ASK，按原文顺序各发一条 ——
        // 只取 UPDATE 的老写法把 agent 开工前写的方案和中途的提问整段丢掉了。
        const liveTags = devLiveTags(content.filter(block => block && block.type === 'text').map(block => block.text || '').join('\n'));
        if (liveTags.length) { const liveAt = timestampToMs(obj.timestamp) || Date.now();
          for (const item of liveTags) this.emit('progress-update', { hubSessionId, tag: item.tag, text: item.text, at: liveAt }); }
        // T13（2026-06-08）：抽 message.model + message.usage 缓存到 entry，turn emit 时附给卡片视图。
        //   transcript 每行 assistant message 都带这两个字段（CC CLI 包装 anthropic API 响应原样落盘）。
        //   model 形如 "claude-opus-4-7" / "claude-sonnet-4-5"；usage 含 input/output/cache_read/cache_creation。
        //   tool_use 中间行的 usage 是"到目前为止"的累积值（API 行为），所以无脑覆盖到 terminal 行
        //   就是本轮最终值，符合卡片视图"显示本轮消耗"的语义。
        if (typeof obj.message.model === 'string' && obj.message.model) {
          entry.lastModel = obj.message.model;
        }
        if (obj.message.usage && typeof obj.message.usage === 'object') {
          const u = obj.message.usage;
          entry.lastUsage = {
            input_tokens: u.input_tokens || 0,
            output_tokens: u.output_tokens || 0,
            cache_read_input_tokens: u.cache_read_input_tokens || 0,
            cache_creation_input_tokens: u.cache_creation_input_tokens || 0,
          };
        }
        for (const block of content) {
          if (!block || typeof block !== 'object') continue;
          if (block.type === 'text' && typeof block.text === 'string') {
            entry._streamingBuf.push({ type: 'text', text: block.text });
          } else if (block.type === 'thinking' && typeof block.thinking === 'string') {
            entry._streamingBuf.push({ type: 'thinking', text: block.thinking });
          } else if (block.type === 'tool_use' && block.name) {
            entry._streamingBuf.push({
              type: 'tool_use',
              name: block.name,
              input: block.input || {},
            });
          }
        }
        // 50KB 头部截断：从尾部累计，直到超出预算就把更早的丢掉
        let totalLen = 0;
        for (let i = entry._streamingBuf.length - 1; i >= 0; i--) {
          const b = entry._streamingBuf[i];
          const blen = (b.text != null) ? String(b.text).length : JSON.stringify(b.input || {}).length;
          totalLen += blen;
          if (totalLen > _CLAUDE_STREAM_BUF_MAX_BYTES) {
            entry._streamingBuf = entry._streamingBuf.slice(i + 1);
            break;
          }
        }

        // 2026-05-03 maintainer R3：用 Claude 自带的 message.stop_reason 语义信号判定本轮真结束。
        //   终态值 {end_turn, max_tokens, refusal} 是 Claude 主动标的"本轮真完结"，立即（200ms 防抖）emit。
        //   "tool_use" 表明还要等 tool_result + 后续 assistant message，不 emit。
        //   null 表示流式中间态（未 finalize），不 emit。
        //   90s idle timer 仅作 transcript 完全卡死的最终兜底，不再是主路径。
        //   2026-09-06：终态还要求这条 entry 自己带正文。实测 Claude Code 会把交错思考
        //   单独写成一条 assistant entry（只有 thinking 块、thinking 文本还是空串），
        //   stop_reason 已经是 end_turn，而真正的答复 23 秒后才落盘 —— 只看 stop_reason
        //   会把上一句「我先读取一下这个文件」当成最终答复提前送出去。
        const stopReason = obj.message.stop_reason;
        const isTerminal = (stopReason === 'end_turn' || stopReason === 'max_tokens' || stopReason === 'refusal')
          && claudeAssistantContentHasAnswerText(content);
        if (isTerminal) {
          this._scheduleStopReasonEmit(hubSessionId);
        } else {
          // tool_use / null：取消任何 pending stop_reason emit，启动 90s 兜底 idle
          this._cancelStopReasonEmit(hubSessionId);
          this._scheduleIdleEmit(hubSessionId);
        }
      };
      // notifyStop already parses the latest completed turn below.  Replaying
      // an entire long transcript here only rebuilds historical streaming
      // state on Electron's main thread, so watch from EOF for future turns.
      entry._tail = new JsonlTail(transcriptPath, onLine, { startAtEnd: true });
      await entry._tail.start();
    }

    // UserPromptSubmit/tool hooks can bind the authoritative transcript before
    // the answer starts. That lets stop_reason close the card even when Claude
    // Code drops or delays its Stop hook. Watching must not parse the existing
    // tail, otherwise a previous answer would be emitted as the new turn.
    if (options.watchOnly) return;

    // Stop hook 触发 → 取消 idle timer + stop_reason timer，走快路径直接读 transcript 末尾立即 emit
    // 2026-05-14 maintainer：用合并版读，避免群聊丢失 [1] plan 段（多 entry 合并 bug 修复）
    this._cancelIdleEmit(hubSessionId);
    this._cancelStopReasonEmit(hubSessionId);
    const text = await readLastAssistantTurnMergedTextFromClaudeTranscript(transcriptPath);
    if (text && text !== entry.lastText) {
      entry.lastText = text;
      this.emit('turn-complete', {
        hubSessionId,
        text,
        completedAt: Date.now(),
        signalSource: 'stop_hook',
        // T13: 附带 model + usage 给卡片视图显示真实模型名 + token chip
        modelId: entry.lastModel || null,
        usage: entry.lastUsage || null,
        turnId: options.turnId || entry.currentTurnId || null,
      });
    }
  }

  notifyError(hubSessionId, error = {}) {
    if (!hubSessionId) return false;
    this._cancelIdleEmit(hubSessionId);
    this._cancelStopReasonEmit(hubSessionId);
    const message = String(error.message || error.error || error.reason || 'Claude turn failed').trim();
    this.emit('turn-error', {
      hubSessionId,
      message,
      reason: message,
      errorInfo: error.errorDetails || error.details || null,
      completedAt: Number(error.completedAt) || Date.now(),
      turnId: error.turnId || null,
      signalSource: error.signalSource || 'stop_failure',
    });
    return true;
  }

  async watchTranscript(hubSessionId, transcriptPath, options = {}) {
    return this.notifyStop(hubSessionId, transcriptPath, { ...options, watchOnly: true });
  }

  // 内部：每条新 assistant 行调用一次，重置 idle timer。
  //   timer 触发时（连续 N 秒无新行）从 transcript 末尾读 last assistant 主动 emit。
  //   防重复：emit 前比对 lastText，相同则不再重复 emit。
  // 2026-05-05 maintainer：兜底 emit 增加 stop_reason 终态过滤 — 历史 R3 修了"5s idle 拿到
  //   tool_use 行的中间 text 误 emit settle"的 bug，但代价是把 idle 时间拉到 90s，
  //   transcript 写入异常 / stop_reason 字段缺失场景下卡片要等 90s 才更新。
  //   现在让兜底也用 stop_reason 过滤：只在 transcript 末尾真有 terminal 行（end_turn/
  //   max_tokens/refusal）时才 emit，否则视为"还在 thinking/tool_use 中"不 emit。
  //   这样既保留 R3 的防误读，又能把兜底时间安全压到合理范围。
  _scheduleIdleEmit(hubSessionId) {
    const entry = this._bound.get(hubSessionId);
    if (!entry) return;
    if (entry._idleTimer) clearTimeout(entry._idleTimer);
    entry._idleTimer = setTimeout(async () => {
      entry._idleTimer = null;
      if (!entry.transcriptPath) return;
      try {
        // 终态过滤：transcript 末尾必须有 terminal stop_reason 行才 emit
        const result = await readLastTerminalAssistantTextFromClaudeTranscript(entry.transcriptPath);
        if (!result || !result.text || !result.text.trim()) return;
        if (result.text === entry.lastText) return; // 已 emit 过相同内容
        entry.lastText = result.text;
        this.emit('turn-complete', {
          hubSessionId,
          text: result.text,
          completedAt: Date.now(),
          signalSource: 'idle_timer_terminal',
          // T13: 附带 model + usage 给卡片视图显示真实模型名 + token chip
          modelId: entry.lastModel || null,
          usage: entry.lastUsage || null,
          turnId: entry.currentTurnId || null,
        });
      } catch (e) {
        console.warn('[claude-tap] idle-emit read failed:', e.message);
      }
    }, _CLAUDE_IDLE_EMIT_MS);
    entry._idleTimer.unref?.();
  }

  _cancelIdleEmit(hubSessionId) {
    const entry = this._bound.get(hubSessionId);
    if (entry?._idleTimer) {
      clearTimeout(entry._idleTimer);
      entry._idleTimer = null;
    }
  }

  // R3（2026-05-03 maintainer）：stop_reason 终态信号触发的延迟 emit。
  //   onLine 看到 stop_reason ∈ {end_turn, max_tokens, refusal} 时调，200ms 防抖窗口
  //   兼容罕见的"end_turn 后还有续 chunk 落盘"场景。emit 时取消 idle timer 不再兜底。
  _scheduleStopReasonEmit(hubSessionId) {
    const entry = this._bound.get(hubSessionId);
    if (!entry) return;
    // 语义信号优先，取消 idle 兜底
    this._cancelIdleEmit(hubSessionId);
    if (entry._stopReasonTimer) clearTimeout(entry._stopReasonTimer);
    entry._stopReasonTimer = setTimeout(async () => {
      entry._stopReasonTimer = null;
      if (!entry.transcriptPath) return;
      try {
        // 2026-05-14 maintainer：用合并版（多 entry 合并 bug 修复）
        // 2026-09-06：改用带终态过滤的读取 —— 与 idle 兜底同一套判据。防抖这 200ms 里
        //   Claude 可能又写了一条 stop_reason='tool_use'，此时本轮并没有结束，
        //   不带过滤的读取会把中间正文当成最终答复送出去。
        const result = await readLastTerminalAssistantTextFromClaudeTranscript(entry.transcriptPath);
        const text = result && result.text;
        if (!text || !text.trim()) return;
        if (text === entry.lastText) return; // 已 emit 过相同内容（如 Stop hook 抢先）
        entry.lastText = text;
        this.emit('turn-complete', {
          hubSessionId,
          text,
          completedAt: Date.now(),
          signalSource: 'stop_reason_terminal',
          // T13: 附带 model + usage 给卡片视图显示真实模型名 + token chip
          modelId: entry.lastModel || null,
          usage: entry.lastUsage || null,
          turnId: entry.currentTurnId || null,
        });
      } catch (e) {
        console.warn('[claude-tap] stop_reason emit read failed:', e.message);
      }
    }, _CLAUDE_STOP_REASON_DEBOUNCE_MS);
    entry._stopReasonTimer.unref?.();
  }

  _cancelStopReasonEmit(hubSessionId) {
    const entry = this._bound.get(hubSessionId);
    if (entry?._stopReasonTimer) {
      clearTimeout(entry._stopReasonTimer);
      entry._stopReasonTimer = null;
    }
  }
}

async function readCodexUserMessageEvents(rolloutPath) {
  const out = [];
  try {
    streamCodexJsonlRecordsSync(rolloutPath, (obj) => {
      const event = codexUserMessageEventFromRecord(obj);
      if (!event) return;
      out.push({
        text: event.text,
        submittedAt: event.submittedAt || 0,
        turnId: event.turnId || null,
        signalSource: event.signalSource,
      });
    }, { profile: 'user' });
  } catch (error) {
    console.warn('[codex-tap] safe user-message scan failed:', error && error.message, '| file:', rolloutPath);
    return [];
  }
  return out;
}

function normalizePromptForCompare(text) {
  return String(text || '').replace(/\r\n/g, '\n').trim();
}

function canonicalizeLongPromptForTuiCompare(text) {
  // Codex TUI 0.144 can drop presentation-only Unicode characters while a
  // bracketed paste crosses the Windows PTY boundary (observed: em dashes and
  // circled list numbers). Keep semantic letters + decimal digits so a long
  // group-chat prompt still binds to its rollout without weakening matching
  // for short prompts where punctuation may be meaningful.
  return normalizePromptForCompare(text)
    .normalize('NFC')
    .replace(/[^\p{L}\p{Nd}]+/gu, '')
    .toLowerCase();
}

function codexPromptMatchesExpected(userMessage, expectedPrompt) {
  const msg = normalizePromptForCompare(userMessage);
  const expected = normalizePromptForCompare(expectedPrompt);
  if (!msg || !expected) return false;
  if (msg === expected) return true;
  // Codex 0.147 records `/goal objective` as thread_goal_updated with only the
  // objective text. Treat that authoritative record as the same submitted
  // prompt so same-cwd sessions still bind to the correct rollout.
  const goalMatch = expected.match(/^\/goal(?:\s+)([\s\S]+)$/i);
  if (goalMatch) {
    const goalExpected = normalizePromptForCompare(goalMatch[1]);
    if (msg === goalExpected) return true;
    const goalCanonical = canonicalizeLongPromptForTuiCompare(goalExpected);
    if (goalCanonical.length >= 80
        && canonicalizeLongPromptForTuiCompare(msg) === goalCanonical) return true;
  }
  if (expected.includes('A UTF-8 group-chat prompt has been saved to this file:')) {
    return msg.includes(expected);
  }
  const expectedCanonical = canonicalizeLongPromptForTuiCompare(expected);
  if (expectedCanonical.length < 80) return false;
  return canonicalizeLongPromptForTuiCompare(msg) === expectedCanonical;
}

// 2026-05-14 maintainer：多 entry 合并版 — 修群聊只拿到 [3] recap 段的 bug。
//   Claude CLI 把"1 个 user prompt + N 次工具调用"拆成 N+1 条 assistant entry，
//   中间 stop_reason='tool_use'、末条 stop_reason='end_turn'。旧版
//   readLastAssistantMessageFromClaudeTranscript 只读末条，导致首条 entry 的 text
//   （三段式输出里就是 [1] plan）丢失。
//   复用 parseClaudeTranscriptToTurns 的 _mergeConsecutiveAssistantTurns 把 N+1 条
//   合并成 1 个 logical turn 后取 text。limit=1 + fromTail 让 parser 只解析末尾窗口，
//   避免大 transcript 全量读。
//   未完成轮（stop_reason 一直 'tool_use'）→ 合并器 acc 不 flush → turns 为空或末轮
//   不存在 → 返回 null，与旧函数 null 兜底语义一致（不向群聊 emit 半截内容）。
//   返回纯字符串（与旧函数同形），便于 4 处出口直接替换。
async function readLastAssistantTurnMergedTextFromClaudeTranscript(transcriptPath) {
  try {
    const turns = parseClaudeTranscriptToTurns(transcriptPath, { limit: 1, fromTail: true });
    const last = turns[turns.length - 1];
    if (!last || last.role !== 'assistant') return null;
    const text = typeof last.text === 'string' ? last.text.trim() : '';
    return text || null;
  } catch {
    return null;
  }
}

// 2026-05-05 maintainer：终态 stop_reason 过滤版本 — 用于 idle 兜底 emit。
// 从尾部向前扫，找第一个 stop_reason ∈ {end_turn, max_tokens, refusal} 且 content
// 含 text 块的 assistant message。
// 与 readLastAssistantMessageFromClaudeTranscript 的区别：本函数会跳过 stop_reason='tool_use'
// 等中间态行（这些行的 text 块是工具调用前的"我先读取..."类中间输出，不是本轮真答案）。
// 返回 { text, stopReason } 或 null（找不到 terminal 行）。
//
// 2026-05-14 maintainer 升级：上述老版本只读末条 entry → 群聊丢 [1] plan。改为复用合并版
// readLastAssistantTurnMergedTextFromClaudeTranscript 取整段 turn，stopReason 从
// 合并后的 turn 取（_mergeConsecutiveAssistantTurns 已保证末条决定 stopReason）。
// 终态过滤语义保留：未 flush 的 turn（stop_reason 一直 'tool_use'）合并器返回为空，
// 这里的 null 兜底等价于"还没到终态"。
const _CLAUDE_TERMINAL_STOP_REASONS = new Set(['end_turn', 'max_tokens', 'refusal']);
async function readLastTerminalAssistantTextFromClaudeTranscript(transcriptPath) {
  try {
    const turns = parseClaudeTranscriptToTurns(transcriptPath, { limit: 1, fromTail: true });
    const last = turns[turns.length - 1];
    if (!last || last.role !== 'assistant') return null;
    // _mergeConsecutiveAssistantTurns 已经按 stopReason !== 'tool_use' 终止 flush，
    // 末轮 stopReason 必是 terminal 或末轮根本没 flush 进 turns。这里再 double-check
    // 一次终态过滤保住对老语义的契约（防 parser 未来改 flush 规则误放行 tool_use）。
    if (!_CLAUDE_TERMINAL_STOP_REASONS.has(last.stopReason)) return null;
    const text = typeof last.text === 'string' ? last.text.trim() : '';
    if (!text) return null;
    return { text, stopReason: last.stopReason };
  } catch {
    return null;
  }
}

// Claude transcript JSONL 末尾读取。模式对称于 main.js:readLastUserMessage —
// 从尾部 64KB 切块扫，找第一个完整 type:"assistant" 条目（最近一条），合并
// message.content 里所有 text 块。
async function readLastAssistantMessageFromClaudeTranscript(transcriptPath) {
  const CHUNK = 65536;
  let fh;
  try {
    fh = await fs.promises.open(transcriptPath, 'r');
    const { size } = await fh.stat();
    let pos = size;
    let tail = '';
    while (pos > 0) {
      const readLen = Math.min(CHUNK, pos);
      pos -= readLen;
      const buf = Buffer.alloc(readLen);
      await fh.read(buf, 0, readLen, pos);
      tail = buf.toString('utf8') + tail;
      const lines = tail.split('\n');
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i].trim();
        if (!line) continue;
        let obj;
        try { obj = JSON.parse(line); } catch { continue; }
        if (obj?.type === 'assistant' && obj.message) {
          const content = obj.message.content;
          if (Array.isArray(content)) {
            const parts = [];
            for (const p of content) {
              if (p && typeof p === 'object' && p.type === 'text' && typeof p.text === 'string') {
                parts.push(p.text);
              }
            }
            const joined = parts.join('').trim();
            if (joined) return joined;
          } else if (typeof content === 'string') {
            if (content.trim()) return content.trim();
          }
        }
      }
      if (pos === 0) break;
      tail = lines[0] || '';
    }
    return null;
  } catch {
    return null;
  } finally {
    try { await fh?.close(); } catch {}
  }
}

// ---------------------------------------------------------------------------
// CodexTap — 监听 ~/.codex/sessions/<今日>/ 下新 rollout-*.jsonl 创建，
// 按 (cwd, timestamp) 就近绑定到 Hub session，tail 到 task_complete 触发
// ---------------------------------------------------------------------------
// 挑战：Codex CLI 自己生成 sid，Hub 预先不知道 rollout 文件名。
// 策略：spawn 前记下 (hubSessionId, cwd, spawnTime)，fs.watch 当日目录。
// 新文件创建时读首行 session_meta，匹配 cwd 相同 && timestamp ∈ [spawnTime-5s, spawnTime+60s]
// 的 pending 条目，按 |delta| 最小就近绑定。

const CODEX_SESSIONS_ROOT = path.join(os.homedir(), '.codex', 'sessions');

// 扫描自愈参数：单个 rollout 的绑定尝试最多占用多久，以及整轮扫描卡多久算「焊死」。
// 两者都必须有界 —— 无界的那个版本实测会让绑定机制整体静默停摆。
const TRY_BIND_TIMEOUT_MS = 15_000;
const SCAN_STUCK_RESET_MS = 45_000;
// 看门狗巡检间隔。只比时间戳，开销可忽略；比扫描间隔慢一个量级即可。
const WATCHDOG_INTERVAL_MS = 15_000;
// hook 报来 rollout 路径但文件还没落盘时，单独盯这一个文件的间隔与上限。
const EXPECTED_ROLLOUT_POLL_MS = 250;
const EXPECTED_ROLLOUT_POLL_MAX_MS = 10 * 60_000;

function withTimeout(promise, ms) {
  let timer = null;
  return Promise.race([
    Promise.resolve(promise).finally(() => { if (timer) clearTimeout(timer); }),
    new Promise((_, reject) => {
      // 刻意不 unref：被包住的那个 promise 如果永远不 resolve，它自己是不保活事件循环的，
      // 定时器再 unref 掉，超时就永远不会触发 —— 这个保护会变成摆设（实测踩到过）。
      // 计时器在 promise 落定时立即清除，所以最坏也只多留 ms 毫秒。
      timer = setTimeout(() => reject(new Error(`timeout after ${ms}ms`)), ms);
    }),
  ]);
}

class CodexTap extends EventEmitter {
  /**
   * @param {object} [opts]
   * @param {string} [opts.sessionsRoot]    rollout 扫描根目录（默认 ~/.codex/sessions）
   *                                        2026-05-04 codex equiv 引入：单测注入 tmp 目录隔离
   * @param {number} [opts.pollIntervalMs]  scan 间隔（默认 1000ms）
   *                                        2026-05-04 codex equiv 引入：单测压到 50-100ms 加快
   */
  constructor(opts = {}) {
    super();
    this._parserService = opts.parserService || null;
    // 多 sessionsRoot：默认含 ~/.codex/sessions（订阅模式）；API 模式 sub session
    // 走 isolated CODEX_HOME（hubDataDir/codex-api-profile/sessions），registerSession
    // 时按需加入。Set 自动去重。
    this._sessionsRoots = new Set([opts.sessionsRoot || CODEX_SESSIONS_ROOT]);
    this._pollIntervalMs = opts.pollIntervalMs || 1000;
    this._pending = new Map(); // hubSessionId → { cwd, spawnTime }
    this._bound = new Map();   // hubSessionId → { rolloutPath, tail, lastText }
    this._pollTimer = null;
    this._seen = new Set();    // rollout paths we've already processed
    this._scanning = false;    // re-entry guard: setInterval may fire while
                               // a slow scan is still in flight; without this
                               // two scans could both pass _seen.has() then
                               // both _tryBind() and double-bind a file.
  }

  registerSession(hubSessionId, {
    cwd,
    sessionsRoot,
    codexSid,
    transcriptPath,
    allowMtimeFallback = false,
    requirePromptMatch = false,
  } = {}) {
    const normCwd = normalizePathForCompare(cwd || process.cwd());
    if (sessionsRoot) this._sessionsRoots.add(sessionsRoot);
    this._pending.set(hubSessionId, {
      cwd: normCwd,
      spawnTime: Date.now(),
      allowMtimeFallback: !!allowMtimeFallback,
      requirePromptMatch: !!requirePromptMatch,
      expectedPrompt: null,
      expectedPromptAt: null,
    });
    this._ensureWatcherAlive();
    this._ensureWatchdog();
    if (transcriptPath) {
      // A persisted rollout path is only a fast path. It can go stale after a
      // profile switch/archive, or (in old Hub state) point at a subagent file.
      // Never let that prevent the provider-native SID from repairing the bind.
      (async () => {
        let bound = false;
        try {
          bound = await this._bindRolloutToHubSession(hubSessionId, transcriptPath, codexSid || null);
        } catch (e) {
          console.warn('[codex-tap] bind by transcriptPath failed:', e.message);
        }
        if (bound) {
          this._pending.delete(hubSessionId);
          this._markSeen(transcriptPath, 'bound_by_transcript_path');
          return;
        }
        if (!codexSid) return;
        try {
          await this._bindByCodexSid(hubSessionId, codexSid, sessionsRoot || null);
        } catch (e) {
          console.warn('[codex-tap] fallback bind by codexSid failed:', e.message);
        }
      })();
      return;
    }
    if (codexSid) {
      this._bindByCodexSid(hubSessionId, codexSid, sessionsRoot || null).catch((e) => {
        console.warn('[codex-tap] bind by codexSid failed:', e.message);
      });
    }
  }

  hasSession(hubSessionId) {
    return this._pending.has(hubSessionId) || this._bound.has(hubSessionId);
  }

  // Codex hook 上报的 session_id + transcript_path 是这条会话的权威身份，
  // 比 cwd + 时间窗推断可靠，可覆盖扫描器的猜测（rebind 仅用于 SessionStart：
  // 同一个终端里 /new、重新启动 Codex 会换成新线程）。
  // Codex 在首个 turn 才落盘 rollout：文件还不存在时先把期望路径钉在 pending 上，
  // 扫描器看到它就直接绑定，并且不再为这条会话猜别的文件。
  async bindFromHook(hubSessionId, { codexSid = null, transcriptPath = null, sessionsRoot = null, rebind = false } = {}) {
    if (!hubSessionId || !transcriptPath) return false;
    const wanted = normalizePathForCompare(transcriptPath);
    const current = this._bound.get(hubSessionId);
    if (current && normalizePathForCompare(current.rolloutPath) === wanted) return true;
    if (current && !rebind) return false;
    if (sessionsRoot) this._sessionsRoots.add(sessionsRoot);
    let exists = false;
    try { exists = fs.statSync(transcriptPath).isFile(); } catch {}
    if (current) this._dropBinding(hubSessionId);
    if (!exists) {
      const pending = this._pending.get(hubSessionId) || {
        cwd: null, spawnTime: Date.now(), allowMtimeFallback: false, requirePromptMatch: false,
        expectedPrompt: null, expectedPromptAt: null,
      };
      pending.expectedRolloutPath = wanted;
      pending.expectedCodexSid = codexSid || null;
      this._pending.set(hubSessionId, pending);
      this._ensureWatcherAlive();
      this._ensureWatchdog();
      this._pollExpectedRollout(hubSessionId, { codexSid, transcriptPath, sessionsRoot });
      return false;
    }
    const pending = this._pending.get(hubSessionId);
    if (pending) { pending.expectedRolloutPath = wanted; pending.expectedCodexSid = codexSid || null; }
    const ok = await this._bindRolloutToHubSession(hubSessionId, transcriptPath, codexSid || null);
    if (ok) {
      this._pending.delete(hubSessionId);
      this._markSeen(transcriptPath, 'bound_by_hook');
    }
    return ok;
  }

  // hook 报来的 rollout 路径是确定的，只是 Codex 首轮开始后才落盘。只盯这一个文件，
  // 不再依赖全目录扫描器：终轮矩阵里扫描器在高负载下反复「heartbeat stale」，群聊的
  // Codex 成员答完了却迟迟没绑上，完成事件就一直等不到。绑定后 tail 会回放已写内容，
  // 晚绑也不漏这一轮的完成。
  _pollExpectedRollout(hubSessionId, options) {
    this._expectedPolls ||= new Map();
    const previous = this._expectedPolls.get(hubSessionId);
    if (previous) clearInterval(previous);
    const wanted = normalizePathForCompare(options.transcriptPath);
    const startedAt = Date.now();
    const stop = () => { clearInterval(timer); if (this._expectedPolls.get(hubSessionId) === timer) this._expectedPolls.delete(hubSessionId); };
    const timer = setInterval(() => {
      const pending = this._pending.get(hubSessionId);
      if (this._bound.has(hubSessionId) || !pending || pending.expectedRolloutPath !== wanted
          || Date.now() - startedAt > EXPECTED_ROLLOUT_POLL_MAX_MS) { stop(); return; }
      let exists = false;
      try { exists = fs.statSync(options.transcriptPath).isFile(); } catch {}
      if (!exists) return;
      stop();
      this.bindFromHook(hubSessionId, options).catch(error => console.warn('[codex-tap] expected rollout bind failed:', error.message));
    }, EXPECTED_ROLLOUT_POLL_MS);
    timer.unref?.();
    this._expectedPolls.set(hubSessionId, timer);
  }

  _dropBinding(hubSessionId) {
    const bound = this._bound.get(hubSessionId);
    if (!bound) return;
    try { bound.tail?.close(); } catch {}
    if (bound._pendingEmitTimer) { try { clearTimeout(bound._pendingEmitTimer); } catch {} }
    this._bound.delete(hubSessionId);
  }

  notePrompt(hubSessionId, prompt) {
    if (!hubSessionId || typeof prompt !== 'string') return;
    const entry = this._pending.get(hubSessionId);
    if (!entry) return;
    entry.expectedPrompt = normalizePromptForCompare(prompt);
    entry.expectedPromptAt = Date.now();
    // 每次派 prompt 都顺手体检一次心跳 —— 这是最靠近「新会话要开始输出了」的时刻，
    // 也是最需要扫描器活着的时刻。
    this._ensureWatcherAlive();
  }

  unregisterSession(hubSessionId) {
    this._pending.delete(hubSessionId);
    const bound = this._bound.get(hubSessionId);
    if (bound) {
      try { bound.tail?.close(); } catch {}
      // P2-1 清理 task_complete debounce 的 pending timer，防 memory leak / unhandled emit
      if (bound._pendingEmitTimer) {
        try { clearTimeout(bound._pendingEmitTimer); } catch {}
      }
      this._bound.delete(hubSessionId);
    }
    if (this._pending.size === 0 && this._bound.size === 0) {
      this._stopWatcher();
    }
  }

  getLastAssistantText(hubSessionId) {
    return this._bound.get(hubSessionId)?.lastText || null;
  }

  getRolloutPath(hubSessionId) {
    return this._bound.get(hubSessionId)?.rolloutPath || null;
  }

  /**
   * 读 rollout 里的用户消息。
   *
   * opts.raw = true 时**跳过语义解析服务**，只用本地原样解析。
   *
   * 为什么必须能跳过：解析服务会把群聊外壳（「## 规则 / ## 输出 / ## 用户」和结尾的
   * 「请发言。」）剥掉，只留内层任务文本 —— 用于展示是对的，用于**绑定就是灾难**。
   * 实测同一个 rollout：本地解析读出 647 字符（与实际发出的 prompt 逐字相同），
   * 解析服务读出 406 字符。而 notePrompt 记的是 647，
   * 于是指纹永远对不上，**每一个 codex 群聊会话都必然绑不上**。
   * 这正是「codex 答完了、Hub 一直转」的真正根因（也解释了为什么离线重放能绑上 ——
   * 离线走的是本地解析这条路）。
   */
  async _readUserMessageEvents(rolloutPath, opts = {}) {
    if (!opts.raw && this._parserService) {
      try {
        const { turns } = await this._parserService.parse('codex', rolloutPath, { fromTail: false });
        return (turns || []).filter(turn => turn && turn.role === 'user').map(turn => ({
          text: turn.text,
          submittedAt: Number(turn.ts) || 0,
          turnId: null,
          signalSource: 'semantic_transcript_parser',
        }));
      } catch (error) {
        console.warn('[codex-tap] parser worker user-message scan failed; using local semantic scan:', error && error.message);
      }
    }
    return readCodexUserMessageEvents(rolloutPath);
  }

  async hasUserMessageSince(hubSessionId, sincePromptTs = 0) {
    const rolloutPath = this.getRolloutPath(hubSessionId);
    if (!rolloutPath) return false;
    const threshold = Math.max(0, Number(sincePromptTs) || 0);
    const events = await this._readUserMessageEvents(rolloutPath);
    return events.some(ev => (Number(ev.submittedAt) || 0) >= threshold);
  }

  // 2026-05-04 codex equiv extract-failure debug —— 给运行时排查"为什么没 bind"用。
  //   不暴露 timer / tail object / EventEmitter listeners 等内部句柄；
  //   返回值必须 JSON 可序列化（IPC 跨进程边界）。
  getDebugSnapshot() {
    const now = Date.now();
    const pending = [];
    for (const [hubSessionId, entry] of this._pending) {
      pending.push({
        hubSessionId,
        cwd: entry.cwd,
        spawnTime: entry.spawnTime,
        ageMs: now - entry.spawnTime,
        hasExpectedPrompt: !!entry.expectedPrompt,
        expectedPromptAt: entry.expectedPromptAt || null,
      });
    }
    const bound = [];
    for (const [hubSessionId, entry] of this._bound) {
      bound.push({
        hubSessionId,
        rolloutPath: entry.rolloutPath,
        hasLastText: !!entry.lastText,
      });
    }
    return {
      sessionsRoots: Array.from(this._sessionsRoots),
      pending,
      bound,
      seen: Array.from(this._seen),
    };
  }

  // 2026-05-02 Bug 修复：手动提取支持 Codex（同 ClaudeTap.extractLatestTurn 设计）。
  //   优先读 rollout 末尾的 task_complete.last_agent_message。
  //   降级：本轮还在 streaming（task_complete 未写）时拼接 sincePromptTs 之后所有
  //   agent_message.message — codex 一个 turn 内会写多条 commentary phase + 最后一条
  //   final phase 的 agent_message，task_complete 才写在末尾。
  //
  // 2026-05-04 codex equiv（Spec S2）：返回值新增 `extractMode` 字段，4 态契约：
  //   - final_answer          ← rollout 末尾命中 task_complete（含 last_agent_message）
  //   - partial_commentary    ← 仅 agent_message，无 task_complete
  //   - no_task_complete_yet  ← 已绑定但 agent_message 全部为空（罕见，think-only 阶段）
  //   - no_rollout_bound      ← _bound.get(hubSessionId).rolloutPath 不存在
  //   返回值始终是对象（不再返回 null），text='' 时由调用方按 extractMode 区分原因。
  //   `source` 字段（manual_codex_rollout / manual_codex_rollout_streaming）保留用于日志追溯。
  // 2026-07-12 maintainer：新增 opts.untilTs —— 轮次窗口上界（开区间）。
  //   「重新提取」旧轮时，调用方传该轮用户消息时间做 sincePromptTs、下一轮用户消息
  //   时间做 untilTs，把提取严格框在该轮内；否则"从尾向前扫最新 task_complete"
  //   永远拿到最新轮的答案，patch 回旧轮 = 内容张冠李戴。untilTs 缺省 null = 原行为。
  async extractLatestTurn(hubSessionId, sincePromptTs = 0, opts = {}) {
    const entry = this._bound.get(hubSessionId);
    if (!entry || !entry.rolloutPath) {
      return { text: '', extractMode: 'no_rollout_bound', source: null };
    }
    let turns;
    try {
      if (this._parserService) {
        ({ turns } = await this._parserService.parse('codex', entry.rolloutPath, { fromTail: false }));
      } else {
        turns = parseCodexRolloutToTurns(entry.rolloutPath, { fromTail: false });
      }
    } catch (error) {
      console.warn('[codex-tap] extractLatestTurn semantic parse failed:', error && error.message, '| file:', entry.rolloutPath);
      return { text: '', extractMode: 'no_rollout_bound', source: null };
    }
    const untilTs = Number.isFinite(Number(opts.untilTs)) && Number(opts.untilTs) > 0 ? Number(opts.untilTs) : null;
    let effectiveSinceTs = Math.max(0, Number(sincePromptTs) || 0);
    for (const turn of turns || []) {
      const ts = Number(turn && (turn.tsEnd || turn.ts)) || 0;
      if (turn && turn.role === 'user' && ts >= effectiveSinceTs && (untilTs === null || ts < untilTs)) {
        effectiveSinceTs = ts;
      }
    }
    const candidates = (turns || []).filter((turn) => {
      if (!turn || turn.role !== 'assistant') return false;
      const ts = Number(turn.tsEnd || turn.ts) || 0;
      if (effectiveSinceTs && ts && ts < effectiveSinceTs) return false;
      if (untilTs !== null && (!ts || ts >= untilTs)) return false;
      return typeof turn.text === 'string' && turn.text.trim();
    });
    const latest = candidates[candidates.length - 1];
    if (!latest) return { text: '', extractMode: 'no_task_complete_yet', source: null };
    const isFinal = latest.stopReason === 'task_complete';
    return {
      text: latest.text.trim(),
      extractMode: isFinal ? 'final_answer' : 'partial_commentary',
      source: isFinal ? 'manual_codex_rollout' : 'manual_codex_rollout_streaming',
      completedAt: Number(latest.tsEnd || latest.ts) || null,
      // The semantic parser currently omits provider turn ids. The live tap
      // tracks task_started on the bound top-level rollout, which is the exact
      // identity used by the completion watcher for the active attempt.
      turnId: entry._currentTurnId || null,
    };
  }

  /**
   * 确认扫描心跳还在跳；停了就重启。
   *
   * 为什么不能只靠 `_ensureWatcher` 的 `if (this._pollTimer) return;`：
   * 实测出现过「pending=2 但扫描循环已经不跑了」—— 定时器句柄还在（所以
   * _ensureWatcher 直接 return），但实际上再没扫过一次，新会话的 rollout
   * 永远等不到绑定。根因没锁死，但这类「静默停摆」不该靠找出每一条成因来防。
   *
   * 所以改成看**心跳时间**而不是看句柄有没有：只要还有会话在等绑定，
   * 而上次扫描已经是好几个周期之前，就无条件重启。
   * 任何碰到 tap 的入口（注册会话、记录 prompt）都顺手调一下，代价可以忽略。
   */
  /**
   * 独立看门狗：只看时间戳、不做任何 I/O，所以不可能被卡住的扫描拖累。
   *
   * 为什么还要多一个定时器：实测发现扫描循环会在**循环工作流启动那一刻**
   * 整个停掉（日志里 `[loop-engine] start` 之后再没有一条 codex-tap 输出），
   * 而 pending 仍是 2。上一版把心跳检查挂在 registerSession / notePrompt 上，
   * 但 agent 干活期间根本不会再触发这两个入口 —— 死了也没人发现。
   *
   * 两个独立定时器同时哑掉的概率，远低于一个。
   */
  _ensureWatchdog() {
    if (this._watchdogTimer) return;
    this._watchdogTimer = setInterval(() => {
      try {
        if (this._pending.size === 0) {
          clearInterval(this._watchdogTimer);
          this._watchdogTimer = null;
          return;
        }
        this._ensureWatcherAlive();
      } catch (e) {
        console.warn('[codex-tap] watchdog error:', e && e.message);
      }
    }, WATCHDOG_INTERVAL_MS);
    this._watchdogTimer.unref?.();
  }

  _ensureWatcherAlive() {
    if (this._pending.size === 0) return;
    const stale = Date.now() - (this._lastScanAt || 0) > Math.max(5000, this._pollIntervalMs * 5);
    if (this._pollTimer && !stale) return;
    if (this._pollTimer) {
      console.warn('[codex-tap] scan heartbeat stale, restarting watcher'
        + ` (pending=${this._pending.size}, lastScan=${this._lastScanAt ? new Date(this._lastScanAt).toISOString() : 'never'})`);
      try { clearInterval(this._pollTimer); } catch (e) {}
      this._pollTimer = null;
    }
    this._ensureWatcher();
  }

  _ensureWatcher() {
    if (this._pollTimer) return;
    this._scanOnce().catch((e) => console.warn('[codex-tap] scan error:', e.message));
    this._pollTimer = setInterval(() => this._scanOnce().catch((e) => console.warn('[codex-tap] scan error:', e.message)), this._pollIntervalMs);
    this._pollTimer.unref?.();
  }

  _stopWatcher() {
    try { clearInterval(this._pollTimer); } catch {}
    this._pollTimer = null;
    // 看门狗也一起收 —— 没有会话在等绑定时它没有存在意义，
    // 留着只会在每次巡检时白跑一遍。下次 registerSession 会重新起。
    try { clearInterval(this._watchdogTimer); } catch {}
    this._watchdogTimer = null;
  }

  _candidateDirs() {
    // Scan today + yesterday across all known sessionsRoots. A Codex session
    // started at 23:55 keeps appending to yesterday's rollout file across midnight;
    // the old +1 direction (tomorrow) would never see a real file.
    // Multi-root: 订阅模式（~/.codex/sessions）+ API 模式（hubDataDir/codex-api-profile/sessions）
    // 共存时都要扫。
    const now = new Date();
    const dirs = [];
    for (const root of this._sessionsRoots) {
      for (const offset of [0, -86400000]) {
        const d = new Date(now.getTime() + offset);
        dirs.push(path.join(
          root,
          String(d.getFullYear()),
          String(d.getMonth() + 1).padStart(2, '0'),
          String(d.getDate()).padStart(2, '0'),
        ));
      }
    }
    return dirs;
  }

  async _scanOnce() {
    if (this._pending.size === 0) return;
    // `_scanning` 是个只进不出的闸：一次扫描里任何一个 await 挂住，
    // 后续每一轮都会在这里直接 return，**整个绑定机制从此静默失效**，
    // 而 pending 里的会话会永远等下去（用户看到的就是「Codex 答了，Hub 一直转」）。
    // 实测见过：扫描跑了 32 轮后停住，17 秒后新会话的 rollout 出生，再没人看它一眼。
    // 所以这里不能只看布尔量，还要看它卡了多久 —— 超时就强行放行并留证。
    if (this._scanning) {
      const stuckMs = Date.now() - (this._scanStartedAt || 0);
      if (stuckMs < SCAN_STUCK_RESET_MS) return;
      console.warn(`[codex-tap] scan stuck for ${Math.round(stuckMs / 1000)}s, force-resetting`
        + ` (pending=${this._pending.size}) —— 上一轮扫描没能结束，绑定已停摆，强制重来`);
    }
    this._scanning = true;
    this._scanStartedAt = Date.now();
    this._lastScanAt = Date.now();      // 心跳：给 _ensureWatcherAlive 判断循环还活着
    try {
      for (const dir of this._candidateDirs()) {
        let files;
        try { files = await fs.promises.readdir(dir); } catch { continue; }
        for (const fname of files) {
          if (!fname.startsWith('rollout-') || !fname.endsWith('.jsonl')) continue;
          const full = path.join(dir, fname);
          if (this._seen.has(full)) continue;
          // 单个文件卡住不能拖垮整轮扫描 —— 这正是上面那个闸被焊死的成因。
          try {
            await withTimeout(this._tryBind(full), TRY_BIND_TIMEOUT_MS);
          } catch (e) {
            if (process.env.CODEX_TAP_DEBUG) {
              console.warn(`[codex-tap][bind-timeout] ${fname} :: ${e && e.message}`);
            }
          }
        }
      }
    } finally {
      this._scanning = false;
      this._scanStartedAt = 0;
    }
  }

  async _bindByCodexSid(hubSessionId, codexSid, preferredSessionsRoot = null) {
    if (!hubSessionId || !codexSid || this._bound.has(hubSessionId)) return false;
    const rolloutPath = await this._findRolloutByCodexSid(codexSid, preferredSessionsRoot);
    if (!rolloutPath) return false;
    const bound = await this._bindRolloutToHubSession(hubSessionId, rolloutPath, codexSid);
    if (!bound) return false;
    this._pending.delete(hubSessionId);
    this._markSeen(rolloutPath, 'bound_by_codex_sid');
    return true;
  }

  async _findRolloutByCodexSid(codexSid, preferredSessionsRoot = null) {
    const suffix = `-${codexSid}.jsonl`;
    // A SID can be copied between subscription profiles. When registration
    // names a profile-specific root, searching any other account is an
    // identity violation rather than a useful fallback.
    const roots = preferredSessionsRoot
      ? [preferredSessionsRoot]
      : Array.from(this._sessionsRoots);
    let best = null;
    const visit = async (dir, depth) => {
      if (depth > 3 || best) return;
      let entries;
      try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); }
      catch { return; }
      for (const ent of entries) {
        const full = path.join(dir, ent.name);
        if (ent.isDirectory()) {
          await visit(full, depth + 1);
          if (best) return;
        } else if (ent.isFile() && ent.name.startsWith('rollout-') && ent.name.endsWith(suffix)) {
          best = full;
          return;
        }
      }
    };
    for (const root of roots) {
      await visit(root, 0);
      if (best) break;
    }
    return best;
  }

  /**
   * 绑定被拒时留一行取证日志。
   *
   * 为什么必须有：`_tryBind` 原先在每条拒绝路径上都是静默 return，
   * 于是「Codex 明明答了、Hub 却一直转」这个既有问题只能靠猜
   * （见 docs/bug-report/20260903-codex-groupchat-first-turn-not-bound.md，
   * 那份取证把七种怀疑逐个排除后，结论就是"缺拒因日志，查不下去"）。
   * 绑不上的代价很实在：dispatcher 判定没送到 → 整条 prompt 重发 →
   * 白烧一轮 token，而那一轮的答案 Hub 仍然收不走，循环就此挂住。
   *
   * 只在 CODEX_TAP_DEBUG=1 时输出，避免正常运行刷屏。
   */
  /**
   * 把 rollout 加进「永久跳过」名单。
   *
   * 这是最危险的一步：`_scanOnce` 里 `if (this._seen.has(full)) continue;`
   * 是无条件的，进了名单的文件在本进程生命周期内**再也不会被检查**。
   * 如果一个刚出生的 rollout 在会话注册之前被扫到并拉黑，那个会话就永远绑不上 ——
   * 表现就是「Codex 明明答了、Hub 一直转」。所以每次拉黑都要留证。
   */
  _markSeen(rolloutPath, why) {
    this._seen.add(rolloutPath);
    if (!process.env.CODEX_TAP_DEBUG) return;
    const tail = String(rolloutPath).split(/[\/]/).pop();
    console.warn(`[codex-tap][seen-add] ${why} :: ${tail} :: pending=${this._pending.size}`);
  }

  _bindReject(rolloutPath, reason, detail) {
    if (!process.env.CODEX_TAP_DEBUG) return;
    const tail = String(rolloutPath).split(/[\\/]/).pop();
    console.warn(`[codex-tap][bind-reject] ${reason} :: ${tail}`
      + (detail ? ` :: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''));
  }

  async _tryBind(rolloutPath) {
    // readCodexRolloutMeta reads only a bounded first-line prefix. A malformed
    // file can therefore never turn binding into an unbounded string load.
    const meta = readCodexRolloutMeta(rolloutPath);
    if (!meta) { this._bindReject(rolloutPath, 'no_meta（首行还没 flush 完，下次扫描重试）'); return; }

    // Hub sessions own top-level Codex TUI threads. Codex subagents write
    // sibling rollout files in the same cwd and often within the same second;
    // accepting one here permanently cross-wires card history and PTY state.
    if (!isCodexTopLevelRolloutMeta(meta)) {
      this._bindReject(rolloutPath, 'subagent（不是顶层线程，永久跳过）');
      this._markSeen(rolloutPath, 'subagent');
      return;
    }

    // hook 已经告诉了我们确切的文件：命中就直接绑定，其余会话不参与猜测。
    const wantedPath = normalizePathForCompare(rolloutPath);
    for (const [hubSessionId, entry] of this._pending) {
      if (entry.expectedRolloutPath !== wantedPath) continue;
      if (await this._bindRolloutToHubSession(hubSessionId, rolloutPath, entry.expectedCodexSid || null)) {
        this._pending.delete(hubSessionId);
        this._markSeen(rolloutPath, 'bound_by_hook_path');
      }
      return;
    }

    const metaCwd = normalizePathForCompare(meta.cwd || '');
    const metaTs = Date.parse(meta.timestamp || '');
    if (!metaCwd) { console.warn(`[codex-tap] rollout has no cwd: ${rolloutPath}`); return; }

    // Fallback: if meta.timestamp is missing/malformed, use file mtime as a
    // best-effort proxy for session start time.
    let statMtime = null;
    try { statMtime = (await fs.promises.stat(rolloutPath)).mtimeMs; } catch {}
    let effectiveTs = Number.isFinite(metaTs) ? metaTs : null;
    if (effectiveTs == null) effectiveTs = statMtime;

    const candidates = [];
    let normalizedUserMessages = null;
    let sawMatchingPendingCwd = false;
    const rejects = [];
    for (const [hubSessionId, entry] of this._pending) {
      if (entry.expectedRolloutPath) continue;
      if (entry.cwd !== metaCwd) {
        rejects.push({ sid: hubSessionId.slice(0, 8), why: 'cwd_mismatch', want: metaCwd, got: entry.cwd });
        continue;
      }
      sawMatchingPendingCwd = true;
      let delta = null;
      if (effectiveTs != null) {
        const metaDelta = effectiveTs - entry.spawnTime;
        if (metaDelta >= -10000 && metaDelta <= 300000) delta = metaDelta;
      }
      if (delta == null && statMtime != null && entry.allowMtimeFallback) {
        // Resume can append to an old rollout whose session_meta timestamp is
        // hours old. mtime is the only fresh signal for `codex resume --last`.
        const mtimeDelta = statMtime - entry.spawnTime;
        if (mtimeDelta >= -10000 && mtimeDelta <= 300000) delta = mtimeDelta;
      }
      if (delta == null && effectiveTs == null && candidates.length === 0) {
        delta = 0;
      }
      if (delta == null) {
        // 最常见的一种：rollout 比会话注册早太多（codex 一起来就写文件，
        // Hub 要等 PTY 就绪才注册）。机器一忙这个间隔就会超过 -10s 下界。
        rejects.push({ sid: hubSessionId.slice(0, 8), why: 'out_of_time_window',
          deltaSec: effectiveTs != null ? ((effectiveTs - entry.spawnTime) / 1000).toFixed(1) : 'n/a',
          window: '[-10s, +300s]' });
        continue;
      }
      if (entry.requirePromptMatch) {
        if (!entry.expectedPrompt) {
          rejects.push({ sid: hubSessionId.slice(0, 8), why: 'no_expected_prompt' });
          continue;
        }
        if (normalizedUserMessages === null) {
          // 绑定要的是「和发出去的那条逐字相同」，所以必须包含原样解析的结果。
          // 两种都收进来取并集：语义解析的留着兼容旧格式，原样解析的保证保真。
          const [semantic, raw] = await Promise.all([
            this._readUserMessageEvents(rolloutPath),
            this._readUserMessageEvents(rolloutPath, { raw: true }),
          ]);
          normalizedUserMessages = [...semantic, ...raw]
            .map(ev => normalizePromptForCompare(ev.text))
            .filter(Boolean);
        }
        if (!normalizedUserMessages.some(msg => codexPromptMatchesExpected(msg, entry.expectedPrompt))) {
          rejects.push({ sid: hubSessionId.slice(0, 8), why: 'prompt_fingerprint_mismatch',
            userMsgs: normalizedUserMessages.length });
          continue;
        }
      }
      candidates.push({ hubSessionId, entry, delta });
    }
    let best = null;
    if (candidates.length === 1) {
      best = candidates[0];
    } else if (candidates.length > 1) {
      const promptCandidates = candidates.filter(c => c.entry.expectedPrompt);
      if (promptCandidates.length === 0) return;
      const userMessages = normalizedUserMessages || await (async () => {
        const [semantic, raw] = await Promise.all([
          this._readUserMessageEvents(rolloutPath),
          this._readUserMessageEvents(rolloutPath, { raw: true }),
        ]);
        return [...semantic, ...raw].map(ev => normalizePromptForCompare(ev.text)).filter(Boolean);
      })();
      if (userMessages.length === 0) return;
      const matched = promptCandidates.filter(c =>
        userMessages.some(msg => codexPromptMatchesExpected(msg, c.entry.expectedPrompt))
      );
      if (matched.length === 1) {
        best = matched[0];
      } else if (matched.length > 1) {
        matched.sort((a, b) => Math.abs(a.delta) - Math.abs(b.delta));
        best = matched[0];
      } else {
        return;
      }
    }
    if (!best) {
      this._bindReject(rolloutPath, 'no_candidate（本轮没选出会话）',
        { pending: this._pending.size, sawMatchingPendingCwd, rejects: rejects.slice(0, 4) });
      if (sawMatchingPendingCwd) {
        // Do not mark same-cwd old rollout files as permanently seen while a
        // pending Codex session exists. A resumed CLI may append to one of
        // them seconds later, refreshing mtime into the bind window.
        return;
      }
      // Rollout outside any pending window — mark seen to skip on future scans.
      this._markSeen(rolloutPath, 'no_matching_pending_cwd');
      return;
    }

    this._markSeen(rolloutPath, 'bound_ok');
    this._pending.delete(best.hubSessionId);
    await this._bindRolloutToHubSession(best.hubSessionId, rolloutPath);
  }

  async _bindRolloutToHubSession(hubSessionId, rolloutPath, expectedCodexSid = null) {
    const existing = this._bound.get(hubSessionId);
    if (existing) return existing.rolloutPath === rolloutPath;
    const pending = this._pending.get(hubSessionId);
    const liveBoundaryAt = Number(pending && pending.spawnTime) || Date.now();
    const meta = readCodexRolloutMeta(rolloutPath);
    if (!isCodexTopLevelRolloutMeta(meta)) {
      this._markSeen(rolloutPath, 'subagent_on_bind');
      return false;
    }
    // The SID is the resume authority. A valid top-level rollout belonging to
    // another session must not overwrite this Hub session's identity.
    if (expectedCodexSid && !codexRolloutMetaMatchesSid(meta, expectedCodexSid)) {
      return false;
    }
    // Emit session-bound so main.js can persist codexSid for future resume.
    const codexSid = extractCodexSidFromRolloutPath(rolloutPath);
    this.emit('session-bound', { hubSessionId, kind: 'codex', codexSid, rolloutPath });

    // Stage 2 P2-1：Codex 多 turn 加固 — task_complete 后短 debounce 防误判。
    //   场景：codex 一次 prompt 内可能跑多个 task（think → search → think 再 task_complete），
    //   每个 task 都会写一条 task_complete 事件。我们要的是"全部 task 完成后的最终消息"。
    //   策略：task_complete 触发后启动 timer 暂存 pendingText；
    //         若 timer 内观察到新的 task_started 事件（明确表示又起新 task），
    //         取消 pending 并丢弃旧 text，等下一次 task_complete；
    //         静默后才真 emit 'turn-complete'。
    //
    // 2026-06-07 maintainer：原 3000ms 拖累卡片同步体验。每个简单 prompt（如"你好"、"1+1"）codex 只产生
    //   1 个 task_complete，3s debounce 是纯 dead time。多 task 场景下 codex 写下一条
    //   task_started 间隔通常 50-200ms（核心 event loop 同步），400ms 足够防误判。
    //   对比 ClaudeTap stop_reason 终态 emit 只用 200ms debounce。
    const TASK_COMPLETE_DEBOUNCE_MS = 400;
    const onLine = (obj) => {
      // T13（2026-06-08）：turn_context 不是 event_msg，单独分发，提早抽 model 字段。
      //   Codex CLI 每次切模型/起新 turn 都写一条 turn_context 行，含 payload.model（如 "gpt-5.5"）。
      //   不命中 event_msg guard → 必须提前 short-circuit 单独处理。
      if (obj?.type === 'turn_context' && obj.payload?.model) {
        const entry2 = this._bound.get(hubSessionId);
        if (entry2 && typeof obj.payload.model === 'string') {
          entry2.lastModel = obj.payload.model;
        }
        return;
      }
      // Resume hydrates an old suffix. Fence the entire lifecycle, not only
      // completions: replaying an old start while suppressing its end leaves
      // renderer/group scheduling working until their expiry turns it unknown.
      // Context/usage above/below remain useful metadata; cards read history
      // independently. New events retain the existing short bind grace.
      const liveEntry = this._bound.get(hubSessionId);
      const recordAt = timestampToMs(obj?.timestamp);
      if (liveEntry && recordAt && recordAt + 5000 < liveEntry._liveBoundaryAt
          && (obj?.type === 'turn_aborted'
            || (obj?.type === 'event_msg' && obj.payload?.type !== 'token_count'))) return;
      // Codex 0.147 writes aborts as event_msg(payload.type=turn_aborted).
      // Older/fixture rollouts may use a top-level turn_aborted record, so keep
      // both shapes. Missing the event_msg form leaves the Hub stuck running
      // after Esc even though the TUI has already returned to its prompt.
      const isTurnAborted = obj?.type === 'turn_aborted'
        || (obj?.type === 'event_msg' && obj?.payload?.type === 'turn_aborted');
      if (isTurnAborted && obj.payload) {
        const entry2 = this._bound.get(hubSessionId);
        if (!entry2) return;
        if (entry2._pendingEmitTimer) clearTimeout(entry2._pendingEmitTimer);
        entry2._pendingEmitTimer = null;
        entry2._pendingText = null;
        entry2._pendingDurationMs = null;
        entry2._pendingCompletedAt = null;
        entry2._pendingTurnId = null;
        entry2._pendingSignalSource = null;
        entry2._answerCandidate = null;
        const turnId = codexTurnIdFromPayload(obj.payload) || entry2._currentTurnId || null;
        const rawCompletedAt = Number(obj.payload.completed_at);
        const payloadCompletedAt = Number.isFinite(rawCompletedAt) && rawCompletedAt > 0
          ? (rawCompletedAt < 100_000_000_000 ? rawCompletedAt * 1000 : rawCompletedAt)
          : null;
        const abortedAt = timestampToMs(obj.timestamp) || payloadCompletedAt || Date.now();
        const abortSig = `${turnId || ''}:${abortedAt}`;
        if (entry2._lastAbortSig !== abortSig) {
          entry2._lastAbortSig = abortSig;
          this.emit('turn-aborted', {
            hubSessionId,
            transcriptPath: entry2.rolloutPath,
            abortedAt,
            turnId,
            signalSource: 'turn_aborted',
          });
        }
        return;
      }
      if (obj?.type !== 'event_msg' || !obj.payload) return;
      const entry = this._bound.get(hubSessionId);
      if (!entry) return;
      const eventType = obj.payload.type;
      const eventTurnId = codexTurnIdFromPayload(obj.payload);

      const taskError = codexTaskErrorEventFromRecord(obj);
      if (taskError) {
        // JsonlTail hydrates a bounded historical suffix on bind. Old failures
        // are transcript history, not new notifications; only errors at/after
        // this Hub registration belong to the live lifecycle. Keep a small
        // clock/bind grace so an immediate failure written just before fs.watch
        // attaches is not lost.
        if (taskError.completedAt && taskError.completedAt + 5000 < entry._liveBoundaryAt) return;
        if (entry._pendingEmitTimer) clearTimeout(entry._pendingEmitTimer);
        entry._pendingEmitTimer = null;
        entry._pendingText = null;
        entry._pendingDurationMs = null;
        entry._pendingCompletedAt = null;
        entry._pendingTurnId = null;
        entry._pendingSignalSource = null;
        entry._answerCandidate = null;
        if (entry._lastErrorOccurrenceId !== taskError.occurrenceId) {
          entry._lastErrorOccurrenceId = taskError.occurrenceId;
          this.emit('turn-error', {
            hubSessionId,
            transcriptPath: entry.rolloutPath,
            ...taskError,
          });
        }
        return;
      }

      // T13: token_count 事件含 last_token_usage（本轮）+ total_token_usage（累计）
      //   Codex 一个 turn 内可能写多次 token_count（每个 task 完成都写），last_token_usage 是
      //   最近一次 task 的 token，不是整 turn 累加；total_token_usage 是 session 起算的累计。
      //   卡片视图"本轮消耗"语义 → 用最后一条 token_count 的 last_token_usage（最后 task 的实际值，
      //   也是最贴近"本轮回复"的语义）。多 task 时各自的 token 看不到，但首屏体验已经足够。
      if (eventType === 'token_count' && obj.payload.info) {
        const info = obj.payload.info;
        const contextEffectiveMax = Number(info.model_context_window);
        if (Number.isInteger(contextEffectiveMax) && contextEffectiveMax > 0
            && entry.lastContextEffectiveMax !== contextEffectiveMax) {
          entry.lastContextEffectiveMax = contextEffectiveMax;
          this.emit('context-window-observed', {
            hubSessionId,
            transcriptPath: entry.rolloutPath,
            contextEffectiveMax,
            observedAt: timestampToMs(obj.timestamp) || Date.now(),
            signalSource: 'token_count.model_context_window',
          });
        }
        const lastU = info.last_token_usage;
        if (lastU && typeof lastU === 'object') {
          entry.lastUsage = {
            input_tokens: lastU.input_tokens || 0,
            output_tokens: lastU.output_tokens || 0,
            cache_read_input_tokens: lastU.cached_input_tokens || 0,
            cache_creation_input_tokens: 0,    // Codex 不区分 5m/1h，统一塞 0
            reasoning_output_tokens: lastU.reasoning_output_tokens || 0,
          };
        }
      }

      const userEvent = codexUserMessageEventFromRecord(obj);
      if (userEvent) {
        const turnId = userEvent.turnId || eventTurnId || entry._currentTurnId || null;
        // Prefer turn identity so a transitional CLI that writes both the old
        // and new user-message records cannot double-submit the same prompt.
        const sig = turnId
          ? `${turnId}:${userEvent.text}`
          : `${userEvent.submittedAt || obj.timestamp || ''}:${userEvent.text}`;
        if (entry._lastPromptSig !== sig) {
          entry._lastPromptSig = sig;
          this.emit('prompt-submitted', {
            hubSessionId,
            text: userEvent.text,
            transcriptPath: entry.rolloutPath,
            submittedAt: userEvent.submittedAt || Date.now(),
            turnId,
            signalSource: userEvent.signalSource,
          });
        }
      }

      // 新 task 开始 → 取消 pending emit（视为"还在进行"，丢弃上一次的 pendingText）
      if (eventType === 'task_started') {
        if (eventTurnId) entry._currentTurnId = eventTurnId;
        entry._lastCompletedTurnId = null;
        if (entry._pendingEmitTimer) clearTimeout(entry._pendingEmitTimer);
        entry._pendingEmitTimer = null;
        entry._pendingText = null;
        entry._pendingDurationMs = null;
        entry._pendingCompletedAt = null;
        entry._pendingTurnId = null;
        entry._pendingSignalSource = null;
        entry._answerCandidate = null;

        // Codex goal continuation / automatic follow-up turns can start with
        // task_started directly and have no ordinary user_message record. The
        // sidebar previously stayed idle for the whole turn even while Codex
        // visibly showed "Working / Pursuing goal". task_started is an
        // authoritative lifecycle signal (unlike PTY repaint bytes), so expose
        // it separately without pretending that a new user prompt was sent.
        const startedAt = timestampToMs(obj.timestamp) || Date.now();
        const startSig = `${eventTurnId || ''}:${startedAt}`;
        if (entry._lastStartSig !== startSig) {
          entry._lastStartSig = startSig;
          this.emit('turn-started', {
            hubSessionId,
            transcriptPath: entry.rolloutPath,
            startedAt,
            turnId: eventTurnId || entry._currentTurnId || null,
            signalSource: 'task_started',
          });
        }
      }

      let completedAgent = codexAgentMessageEventFromRecord(obj);
      if (completedAgent && eventType !== 'task_complete' && completedAgent.phase === 'final_answer') {
        // Store text for an empty task receipt, but do not close the live turn.
        // Async questions can emit final_answer and then continue using tools.
        const turnId = completedAgent.turnId || eventTurnId || entry._currentTurnId || null;
        if (!entry._currentTurnId || !turnId || turnId === entry._currentTurnId) {
          entry._answerCandidate = { text: completedAgent.text, turnId };
        }
      }
      // /compact 等没有回答的任务：task_complete 的 last_agent_message 为空，解析器返回 null。
      // 仍然要收尾这一轮，否则状态永远停在运行中（2026-09-25 真机 Codex /compact）。
      if (!completedAgent && eventType === 'task_complete') {
        const payloadDuration = Number(obj.payload && obj.payload.duration_ms);
        completedAgent = { text: '', phase: 'final_answer', completed: true, signalSource: 'task_complete',
          completedAt: timestampToMs(obj.timestamp) || Date.now(), turnId: eventTurnId || null,
          durationMs: Number.isFinite(payloadDuration) ? payloadDuration : null };
      }
      if (completedAgent && completedAgent.completedAt >= entry._liveBoundaryAt) {
        const liveTags = devLiveTags(completedAgent.text);
        if (liveTags.length) { const liveTurnId = completedAgent.turnId || eventTurnId || entry._currentTurnId || null;
          for (const item of liveTags) this.emit('progress-update', { hubSessionId, tag: item.tag, text: item.text, at: completedAgent.completedAt, turnId: liveTurnId }); }
      }
      if (completedAgent && completedAgent.completed && eventType === 'task_complete') {
        // JsonlTail hydrates an existing rollout suffix when a dormant Codex
        // session resumes. A historical task_complete/final_answer is history,
        // not the completion of the prompt that is about to be submitted by
        // this Hub registration. task errors already use the same live-boundary
        // rule above; successful completions must be fenced identically.
        const completionAt = Number(completedAgent.completedAt)
          || timestampToMs(obj.timestamp)
          || 0;
        if (completionAt && completionAt + 5000 < entry._liveBoundaryAt) return;
        const completedTurnId = completedAgent.turnId || eventTurnId || entry._currentTurnId || null;
        // 同一轮先到的 final_answer 正文不能被随后 last_agent_message 为空的 task_complete 冲掉。
        const text = completedAgent.text
          || (entry._answerCandidate?.turnId === completedTurnId ? entry._answerCandidate?.text : null)
          || (entry._pendingTurnId && entry._pendingTurnId === completedTurnId ? entry._pendingText : null);
        // Only task receipts schedule completion. Multiple receipts share the
        // existing debounce; message phase alone must never end a live turn.
        if (entry._pendingEmitTimer) clearTimeout(entry._pendingEmitTimer);
        entry._pendingText = text;
        entry._pendingDurationMs = completedAgent.durationMs;
        entry._pendingCompletedAt = completionAt || Date.now();
        entry._pendingTurnId = completedAgent.turnId || eventTurnId || entry._currentTurnId || null;
        entry._pendingSignalSource = completedAgent.signalSource;
        entry._pendingEmitTimer = setTimeout(() => {
          entry._pendingEmitTimer = null;
          const finalText = entry._pendingText;
          const finalDuration = entry._pendingDurationMs;
          const finalCompletedAt = entry._pendingCompletedAt;
          const finalTurnId = entry._pendingTurnId;
          const finalSignalSource = entry._pendingSignalSource;
          entry._pendingText = null;
          entry._pendingDurationMs = null;
          entry._pendingCompletedAt = null;
          entry._pendingTurnId = null;
          entry._pendingSignalSource = null;
          if (!finalText) {
            // /compact 这类没有回答的任务也会写 task_complete（last_agent_message 为空）。
            // 它不是新回答（不出卡、不加未读），但这一轮确实结束了：不发信号，Hub 会一直显示运行中。
            this.emit('turn-aborted', {
              hubSessionId,
              transcriptPath: entry.rolloutPath,
              abortedAt: finalCompletedAt || Date.now(),
              turnId: finalTurnId,
              signalSource: 'task_complete_without_answer',
            });
            return;
          }
          // final_answer 与随后约一秒的 task_complete 属于同一轮：只报一次完成。
          // 新的 task_started 会重置 _lastCompletedTurnId。
          if (finalTurnId && entry._lastCompletedTurnId === finalTurnId && entry.lastText === finalText) return;
          entry._lastCompletedTurnId = finalTurnId || null;
          entry.lastText = finalText;
          this.emit('turn-complete', {
            hubSessionId,
            text: finalText,
            transcriptPath: entry.rolloutPath,
            completedAt: finalCompletedAt || Date.now(),
            durationMs: finalDuration,
            turnId: finalTurnId,
            signalSource: finalSignalSource || 'task_complete',
            // T13: 附带 model + usage 给卡片视图显示真实模型名 + token chip
            modelId: entry.lastModel || null,
            usage: entry.lastUsage || null,
          });
        }, TASK_COMPLETE_DEBOUNCE_MS);
      }
    };

    const tail = new JsonlTail(rolloutPath, onLine, {
      maxInitialBytes: 8 * 1024 * 1024,
      lineFilter: createCodexLineFilter('live'),
    });
    this._bound.set(hubSessionId, {
      rolloutPath, tail, lastText: null,
      lastModel: null, lastUsage: null, lastContextEffectiveMax: null,    // T13 + runtime context observation
      _pendingEmitTimer: null, _pendingText: null, _pendingDurationMs: null,
      _pendingCompletedAt: null, _pendingTurnId: null, _currentTurnId: null,
      _pendingSignalSource: null,
      _answerCandidate: null,
      _lastPromptSig: null, _lastStartSig: null, _lastAbortSig: null,
      _lastErrorOccurrenceId: null, _liveBoundaryAt: liveBoundaryAt,
    });
    await tail.start();
    return true;
  }
}

// ---------------------------------------------------------------------------
// GeminiTap — 扫 ~/.gemini/tmp/*/.project_root 反查 cwd → 匹配 chats/ 目录，
// fs.watch 等待 session-*.jsonl 创建，tail 到 type:"gemini" 且 tokens 完整触发
// ---------------------------------------------------------------------------
// 注意 Gemini 0.39+ 改用 JSONL，0.38 及以前是单 JSON 整覆盖。
// JSONL 路径为主；若 chats/ 下只有 .json 不带 jsonl，退化为整文件读 + 防抖。

const GEMINI_TMP_ROOT = path.join(process.env.CLAUDE_HUB_HOME_DIR || os.homedir(), '.gemini', 'tmp');
const geminiMessageText=content=>typeof content==='string' ? content : Array.isArray(content)
  ? content.filter(part=>typeof part?.text==='string').map(part=>part.text).join('') : '';

class GeminiTap extends EventEmitter {
  constructor(opts = {}) {
    super();
    // 2026-05-04 gemini equiv：opts.tmpRoot 让单测把 fake session 写到 tmpdir，
    // 不污染真实 ~/.gemini/tmp。生产路径不传 opts → 默认走 GEMINI_TMP_ROOT。
    this._tmpRoot = opts.tmpRoot || GEMINI_TMP_ROOT;
    this._pending = new Map(); // hubSessionId → { cwd, spawnTime, projectDir }
    this._bound = new Map();   // hubSessionId → { sessionPath, tail, lastText, isJsonl, debounceTimer }
    this._pollTimer = null;
    this._seen = new Set();    // session file paths we've already bound
    this._scanning = false;    // re-entry guard (see CodexTap for rationale)
  }

  // 2026-05-04 gemini equiv extract-failure debug —— 暴露 _pending / _bound / _seen 当前状态。
  // main.js 的 groupchat-gemini-debug-state IPC handler 转发此快照给 renderer，
  // 用户报告"gemini 已回答但卡片提取不到"时排查为什么没 bind / 已 bind 但未 emit。
  // 不暴露 timer / tail object / EventEmitter listeners 等内部句柄；JSON 可序列化。
  getDebugSnapshot() {
    const now = Date.now();
    const pending = [];
    for (const [hubSessionId, entry] of this._pending) {
      pending.push({
        hubSessionId,
        cwd: entry.cwd,
        spawnTime: entry.spawnTime,
        ageMs: now - entry.spawnTime,
        projectDir: entry.projectDir || null,
      });
    }
    const bound = [];
    for (const [hubSessionId, entry] of this._bound) {
      bound.push({
        hubSessionId,
        sessionPath: entry.sessionPath,
        isJsonl: !!entry.isJsonl,
        hasLastText: !!entry.lastText,
      });
    }
    return {
      tmpRoot: this._tmpRoot,
      pending,
      bound,
      seen: Array.from(this._seen),
    };
  }

  registerSession(hubSessionId, { cwd } = {}) {
    const resolvedCwd = normalizePathForCompare(cwd || process.cwd());
    this._pending.set(hubSessionId, {
      cwd: resolvedCwd,
      spawnTime: Date.now(),
      projectDir: null,
    });
    this._ensureWatcher();
  }

  hasSession(hubSessionId) {
    return this._pending.has(hubSessionId) || this._bound.has(hubSessionId);
  }

  unregisterSession(hubSessionId) {
    this._pending.delete(hubSessionId);
    const bound = this._bound.get(hubSessionId);
    if (bound) {
      try { bound.tail?.close(); } catch {}
      try { clearTimeout(bound.debounceTimer); } catch {}
      // 2026-05-02：清 idle-timer 防 leak（用户血泪场景兜底新增的 timer）
      if (bound._idleTimer) { try { clearTimeout(bound._idleTimer); } catch {} }
      this._bound.delete(hubSessionId);
    }
    if (this._pending.size === 0 && this._bound.size === 0) {
      this._stopWatcher();
    }
  }

  getLastAssistantText(hubSessionId) {
    return this._bound.get(hubSessionId)?.lastText || null;
  }

  // Card redesign（2026-05-01）— 最新 token 计数缓存：
  //   GeminiTap onLine 看到 obj.tokens.total 时调 this._recordTokens(sid, obj.tokens) 缓存。
  //   _gcWaitTurnComplete 在 watcher settle 时调 this.getLastTokens(sid) 拿到最新值，
  //   附到 result.tokens 上传给 renderer 卡片 row4 显示"本轮 X tokens · 累计 Y tokens"。
  _recordTokens(hubSessionId, tokens) {
    if (!hubSessionId || !tokens || typeof tokens.total !== 'number') return;
    const entry = this._bound.get(hubSessionId);
    if (entry) entry.lastTokens = { ...tokens };
  }

  getLastTokens(hubSessionId) {
    const entry = this._bound.get(hubSessionId);
    return entry?.lastTokens || null;
  }

  // 每轮发新 prompt 前清空，避免上一轮的 token 数据被本轮用作"本轮"统计
  clearLastTokens(hubSessionId) {
    const entry = this._bound.get(hubSessionId);
    if (entry) entry.lastTokens = null;
  }

  // Card optimization Task 2（2026-05-01）— 流式 streamingBuf 接口。
  //   onLine 累积逻辑见 _bindSession 的 onLine（type:"gemini" 分支）。
  //   返回数组 Array<Block> | null，与 ClaudeTap 同形（main.js groupChatWatcher.extractStreamingText 统一处理）。
  getStreamingText(hubSessionId) {
    const entry = this._bound.get(hubSessionId);
    if (!entry || !Array.isArray(entry._streamingBuf) || entry._streamingBuf.length === 0) return null;
    return [...entry._streamingBuf];
  }

  clearStreamingBuf(hubSessionId) {
    const entry = this._bound.get(hubSessionId);
    if (entry) entry._streamingBuf = [];
  }

  // Stage 2 容错升级（2026-05-01）— 手动提取兜底：
  //   当 Gemini 永不 emit L1/L3 完成信号时（OAuth 异常 / 限流 / 卡死），
  //   用户在 UI 点"一键提取"会调本方法，直接读 JSONL 拼接 sincePromptTs 之后的所有
  //   type:"gemini" 行 content，绕过完成检测。
  //   返回 { text, lineCount, source: 'manual' }；JSONL 不可读 / 无匹配行返回 null。
  async extractLatestGeminiTurn(hubSessionId, sincePromptTs) {
    const entry = this._bound.get(hubSessionId);
    if (!entry || !entry.sessionPath || !entry.isJsonl) return null;
    let raw;
    try { raw = await fs.promises.readFile(entry.sessionPath, 'utf8'); }
    catch { return null; }
    const lines = raw.split('\n');
    const collected = [];
    for (const line of lines) {
      if (!line.trim()) continue;
      let obj;
      try { obj = JSON.parse(line); } catch { continue; }
      if (obj?.type !== 'gemini') continue;
      // 2026-05-04 gemini-equiv Bug 2 修复：gemini 0.40.1 jsonl 写的 timestamp 是
      //   ISO 字符串（"2026-05-04T13:38:21.867Z"），旧代码只识 number → 全部置 null
      //   → ts < sincePromptTs 过滤被绕过，一键提取拿到整个 jsonl 历史多轮 content。
      //   现接受 ISO 字符串 + number 两种格式；解析失败置 null（保留旧"无 ts 不过滤"行为）。
      let ts = null;
      if (typeof obj.timestamp === 'number') ts = obj.timestamp;
      else if (typeof obj.timestamp === 'string') {
        const parsed = Date.parse(obj.timestamp);
        if (!Number.isNaN(parsed)) ts = parsed;
      } else if (typeof obj.ts === 'number') ts = obj.ts;
      if (ts !== null && ts < sincePromptTs) continue;
      if (typeof obj.content !== 'string') continue;
      const piece = obj.content;
      if (!piece.trim()) continue;
      // 去重：Gemini 某些版本流式输出末尾会出现连续重复 chunk。
      if (collected.length && collected[collected.length - 1] === piece) continue;
      collected.push(piece);
    }
    if (collected.length === 0) return null;
    const text = collected.join('').trim();
    if (!text) return null;
    return { text, lineCount: collected.length, source: 'manual' };
  }

  _ensureWatcher() {
    if (this._pollTimer) return;
    this._scanOnce().catch((e) => console.warn('[gemini-tap] scan error:', e && e.message));
    this._pollTimer = setInterval(() => this._scanOnce().catch((e) => console.warn('[gemini-tap] scan error:', e && e.message)), 1000);
    this._pollTimer.unref?.();
  }

  _stopWatcher() {
    try { clearInterval(this._pollTimer); } catch {}
    this._pollTimer = null;
  }

  async _scanOnce() {
    if (this._pending.size === 0) return;
    if (this._scanning) return;
    this._scanning = true;
    try {
      let tmpDirs;
      try { tmpDirs = await fs.promises.readdir(this._tmpRoot); } catch { return; }

      // Phase 1: resolve projectDir for pending entries without one
      for (const [, entry] of this._pending) {
        if (entry.projectDir) continue;
        for (const sub of tmpDirs) {
          const projectRootFile = path.join(this._tmpRoot, sub, '.project_root');
          let content;
          try { content = await fs.promises.readFile(projectRootFile, 'utf8'); }
          catch { continue; }
          if (normalizePathForCompare(content.trim()) === entry.cwd) {
            entry.projectDir = path.join(this._tmpRoot, sub);
            break;
          }
        }
      }

      // Phase 2: look for new session-*.jsonl files with mtime ≥ spawnTime-2s
      for (const [hubSessionId, entry] of this._pending) {
        if (!entry.projectDir) continue;
        const chatsDir = path.join(entry.projectDir, 'chats');
        let files;
        try { files = await fs.promises.readdir(chatsDir); } catch { continue; }
        const candidates = [];
        for (const f of files) {
          if (!f.startsWith('session-')) continue;
          if (!f.endsWith('.jsonl') && !f.endsWith('.json')) continue;
          const full = path.join(chatsDir, f);
          if (this._seen.has(full)) continue;
          let stat;
          try { stat = await fs.promises.stat(full); } catch { continue; }
          if (stat.mtimeMs < entry.spawnTime - 2000) continue;
          candidates.push({ full, mtime: stat.mtimeMs, isJsonl: f.endsWith('.jsonl') });
        }
        if (candidates.length === 0) continue;
        candidates.sort((a, b) => a.mtime - b.mtime);
        const pick = candidates[0];
        this._seen.add(pick.full);
        this._pending.delete(hubSessionId);
        await this._bindSession(hubSessionId, pick.full, pick.isJsonl);
      }
    } finally {
      this._scanning = false;
    }
  }

  async _bindSession(hubSessionId, sessionPath, isJsonl) {
    // Card optimization Task 2（2026-05-01）— streamingBuf 累积流式 chunk，让 main.js groupChatWatcher.extractStreamingText
    //   优先用 tap 的 blocks 数组渲染（替代 PTY ringBuffer 过滤），preview 区不再有 throbbing 字符。
    // 2026-05-02 加 _idleTimer 字段：用户反馈"Gemini 第一轮没快速提取"，token 信号
    //   延迟到达时三层 emit 都不触发；idle-timer 兜底见 _scheduleGeminiIdleEmit。
    const boundEntry = { sessionPath, tail: null, lastText: null, isJsonl, debounceTimer: null, _streamingBuf: [], _idleTimer: null };
    this._bound.set(hubSessionId, boundEntry);

    // Emit session-bound for main.js to persist resume meta.
    // sessionPath is `<projectDir>/chats/session-...`. Walk up 2 levels for projectDir.
    const projectDir = path.dirname(path.dirname(sessionPath));
    let projectRoot = null;
    try {
      projectRoot = (await fs.promises.readFile(path.join(projectDir, '.project_root'), 'utf8')).trim();
    } catch {}

    // Read full sessionId UUID from first line of JSONL (authoritative).
    // Falls back to 8charId from filename if read fails.
    let geminiChatId = extractGeminiChatIdFromSessionPath(sessionPath);
    try {
      const raw = await fs.promises.readFile(sessionPath, 'utf8');
      const firstLine = raw.split('\n')[0];
      const meta = JSON.parse(firstLine);
      if (meta.sessionId && /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(meta.sessionId)) {
        geminiChatId = meta.sessionId;
      }
    } catch {}

    this.emit('session-bound', {
      hubSessionId,
      kind: 'gemini',
      geminiChatId,
      geminiProjectHash: extractGeminiProjectHashFromDir(projectDir),
      geminiProjectRoot: projectRoot,
      sessionPath,
    });

    // Stage 2 容错升级（2026-05-01）：emit payload 增加 signalSource 字段，
    //   让下游 turn-completion-watcher 区分 L1（result/message_update）/ L3（tokens_total）信号。
    //   向后兼容——既有调用方（main.js _gcWaitTurnComplete）忽略此字段不影响。
    // 2026-05-02：emit 时取消 idle timer（避免重复 emit）。
    const emitIfComplete = (content, meta = {}) => {
      const text = (content || '').trim();
      if (!text) return;
      if (text === boundEntry.lastText) return;
      boundEntry.lastText = text;
      // L1/L3 抢先 → 取消 idle timer
      if (boundEntry._idleTimer) {
        clearTimeout(boundEntry._idleTimer);
        boundEntry._idleTimer = null;
      }
      this.emit('turn-complete', {
        hubSessionId,
        text,
        completedAt: Date.now(),
        signalSource: meta.signalSource || 'tokens_total',
        restartStillWorking: meta.restartStillWorking === true,
      });
    };

    // 2026-05-02 idle-timer 兜底：每条新 content 行重置 5s timer，
    //   连续 5s 无新行 → 把 streamingBuf 拼成完整 text 主动 emit。
    //   防止"第一轮 token 延迟到达"导致卡片永远 streaming（用户血泪反馈）。
    const _scheduleGeminiIdleEmit = () => {
      if (boundEntry._idleTimer) clearTimeout(boundEntry._idleTimer);
      boundEntry._idleTimer = setTimeout(() => {
        boundEntry._idleTimer = null;
        // 拼 streamingBuf 内容；过滤 type:'text' 块（Gemini 只 push text 块）
        const text = boundEntry._streamingBuf
          .filter(b => b && b.type === 'text' && typeof b.text === 'string')
          .map(b => b.text).join('').trim();
        if (!text) return;
        if (text === boundEntry.lastText) return;
        boundEntry.lastText = text;
        this.emit('turn-complete', {
          hubSessionId,
          text,
          completedAt: Date.now(),
          signalSource: 'idle_timer_5s',
        });
      }, _GEMINI_IDLE_EMIT_MS);
      boundEntry._idleTimer.unref?.();
    };

    if (isJsonl) {
      // Gemini 0.39+ JSONL: 三层完成信号识别（按可靠度优先匹配）：
      //   L1a result_event: type:"result"（headless --output-format stream-json 模式）
      //   L1b message_update: type:"message_update" + status:"finalized"（TUI fallback）
      //   L3  tokens_total:  type:"gemini" + tokens.total（启发式，慢/限流时不可靠）
      // Card optimization Task 2（2026-05-01）— 同步累积流式 content 到 _streamingBuf：
      //   只要看到带 content 的 gemini/result/message_update 行就 push（无视 token 是否到位），
      //   让 preview 区在 token 到达之前就能显示流式中间态。50KB tail-preserving 截断防内存膨胀。
      const _STREAM_BUF_MAX_BYTES = 50000;
      const _pushStreamBlock = (text) => {
        if (typeof text !== 'string' || text.length === 0) return;
        boundEntry._streamingBuf.push({ type: 'text', text });
        // 50KB 头部截断，保留尾部
        let totalLen = 0;
        for (let i = boundEntry._streamingBuf.length - 1; i >= 0; i--) {
          totalLen += String(boundEntry._streamingBuf[i].text || '').length;
          if (totalLen > _STREAM_BUF_MAX_BYTES) {
            boundEntry._streamingBuf = boundEntry._streamingBuf.slice(i + 1);
            break;
          }
        }
      };

      const onLine = (obj) => {
        // Current Gemini JSONL also persists full message snapshots as $set.
        // Only the latest turn can change runtime; older snapshots are history.
        if(Array.isArray(obj?.$set?.messages)){
          const messages=obj.$set.messages;
          const lastUserIndex=messages.findLastIndex(m=>m?.type==='user');
          for(const message of messages.slice(Math.max(0,lastUserIndex)))onLine(message);
          return;
        }
        if(obj?.type==='user') {
          const text=geminiMessageText(obj.content);
          const submittedAt=typeof obj.timestamp==='number' ? obj.timestamp : Date.parse(obj.timestamp);
          const key=JSON.stringify([obj.id,obj.timestamp,text]);
          if(key===boundEntry.lastUser)return;
          boundEntry.lastUser=key;
          clearTimeout(boundEntry._idleTimer);boundEntry._idleTimer=null;boundEntry._streamingBuf=[];
          if(text && Number.isFinite(submittedAt))this.emit('prompt-submitted',{hubSessionId,text,submittedAt,
            turnId:obj.id || obj.messageId || null,transcriptPath:sessionPath,signalSource:'gemini_user_message'});
          return;
        }
        // M2.4 修复 (2026-05-03)：把 idle_timer_5s 提升为"所有路径的 catch-all 兜底"。
        //   旧版只在 line 963 分支（type:"gemini" + content + 无 tokens）schedule timer，
        //   导致以下用户血泪场景永不触发 turn-complete：
        //   - Gemini 写 type:"gemini" + content + tokens.total=null（限流 / 流式中断）
        //   - 主路径 emitIfComplete 因 lastText 去重提前返回但下一行有新 content
        //   - 真实 jsonl 完全无 type:"result" / "message_update"（只有 type:"gemini"）
        //   现在策略：任何 type:"gemini"/"result"/"message_update" 的有 content 行都
        //   schedule timer。emitIfComplete 已用 lastText 去重，5s 后兜底 emit 安全。
        const isContentLine = (
          (obj?.type === 'gemini' || obj?.type === 'result' || obj?.type === 'message_update')
          && typeof obj?.content === 'string'
          && obj.content.trim().length > 0
        );
        if (isContentLine) _scheduleGeminiIdleEmit();

        // L1a — 协议级 result 事件（最可靠）
        if (obj?.type === 'result' && typeof obj.content === 'string' && obj.content.trim().length > 0) {
          _pushStreamBlock(obj.content);
          emitIfComplete(obj.content, { signalSource: 'result_event' });
          return;
        }
        // L1b — message_update finalized（TUI 模式 fallback）
        if (obj?.type === 'message_update' && obj.status === 'finalized'
            && typeof obj.content === 'string' && obj.content.trim().length > 0) {
          _pushStreamBlock(obj.content);
          emitIfComplete(obj.content, { signalSource: 'message_update' });
          return;
        }
        // L3 — tokens.total 启发式（保留向后兼容；慢响应/限流时永不写入）
        if (obj?.type === 'gemini' && obj.tokens && obj.tokens.total != null
            && typeof obj.content === 'string' && obj.content.trim().length > 0) {
          // Card redesign（2026-05-01）：缓存最新 token 计数，让 _gcWaitTurnComplete 在 settle
          //   时把数据透传给 watcher.wait() 的 result.tokens。卡片 row4 显示"本轮 X tokens"。
          this._recordTokens(hubSessionId, obj.tokens);
          _pushStreamBlock(obj.content);
          emitIfComplete(obj.content, { signalSource: 'tokens_total',restartStillWorking:!!obj.toolCalls?.length });
        } else if (obj?.type === 'gemini' && obj.tokens && obj.tokens.total != null) {
          // 仅缓存 token，不触发 emit（content 为空时 token 信息仍有用：streaming 中实时更新）
          this._recordTokens(hubSessionId, obj.tokens);
        } else if (obj?.type === 'gemini' && typeof obj.content === 'string' && obj.content.trim().length > 0) {
          // Task 2（2026-05-01）— 流式中间态：content 已到、token 未到，仍累积让 preview 显示
          _pushStreamBlock(obj.content);
          // M2.4 修复：idle timer 已在 onLine 顶部统一 schedule，此处不再重复
        }
      };
      const tail = new JsonlTail(sessionPath, onLine, { maxInitialBytes: 8 * 1024 * 1024 });
      boundEntry.tail = tail;
      await tail.start();
    } else {
      // Gemini 0.38 and older: single-file JSON overwritten each turn.
      // Poll mtime; when it settles (>400ms idle), read whole file,
      // take last messages[] entry with type:"gemini".
      let lastMtime = 0;
      const poll = async () => {
        let stat;
        try { stat = await fs.promises.stat(sessionPath); } catch { return; }
        if (stat.mtimeMs === lastMtime) return;
        lastMtime = stat.mtimeMs;
        if (boundEntry.debounceTimer) clearTimeout(boundEntry.debounceTimer);
        boundEntry.debounceTimer = setTimeout(async () => {
          try {
            const raw = await fs.promises.readFile(sessionPath, 'utf8');
            const parsed = JSON.parse(raw);
            const msgs = parsed?.messages || [];
            const lastUser=msgs.findLast(m=>m?.type==='user');
            if(lastUser) {
              const key=JSON.stringify(lastUser);
              if(key!==boundEntry.lastUser){
                boundEntry.lastUser=key;
                const submittedAt=typeof lastUser.timestamp==='number' ? lastUser.timestamp : Date.parse(lastUser.timestamp);
                const text=geminiMessageText(lastUser.content);
                if(text && Number.isFinite(submittedAt))this.emit('prompt-submitted',{hubSessionId,text,submittedAt,
                  turnId:lastUser.id || null,transcriptPath:sessionPath,signalSource:'gemini_user_message'});
              }
            }
            for (let i = msgs.length - 1; i >= 0; i--) {
              const m = msgs[i];
              if(m?.type==='user')break;
              if (m?.type === 'gemini' && typeof m.content === 'string') {
                emitIfComplete(m.content,{restartStillWorking:!!m.toolCalls?.length});
                break;
              }
            }
          } catch {}
        }, 400);
      };
      const timer = setInterval(poll, 500);
      timer.unref?.();
      boundEntry.tail = { close: () => clearInterval(timer) };
    }
  }
}

// ---------------------------------------------------------------------------
// TranscriptTap — 外部入口，组合各 CLI transcript 后端
// ---------------------------------------------------------------------------

class TranscriptTap extends EventEmitter {
  constructor(opts = {}) {
    super();
    this._claude = new ClaudeTap({ parserService: opts.parserService });
    this._codex = new CodexTap({ parserService: opts.parserService });
    this._gemini = new GeminiTap();
    this._kimi = new KimiTap({ parserService: opts.parserService });
    for (const b of [this._claude, this._codex, this._gemini, this._kimi]) {
      b.on('turn-complete', (ev) => this.emit('turn-complete', ev));
      b.on('progress-update', (ev) => this.emit('progress-update', ev));
      b.on('turn-started', (ev) => this.emit('turn-started', ev));
      b.on('turn-aborted', (ev) => this.emit('turn-aborted', ev));
      b.on('turn-error', (ev) => this.emit('turn-error', ev));
      b.on('session-bound', (ev) => this.emit('session-bound', ev));
      b.on('prompt-submitted', (ev) => this.emit('prompt-submitted', ev));
      b.on('background-work-changed', (ev) => this.emit('background-work-changed', ev));
      b.on('context-window-observed', (ev) => this.emit('context-window-observed', ev));
    }
  }

  dispose() {
    const ids = new Set();
    for (const backend of [this._claude, this._codex, this._gemini, this._kimi]) {
      for (const mapName of ['_bound', '_pending']) {
        const map = backend && backend[mapName];
        if (map && typeof map.keys === 'function') {
          for (const id of map.keys()) ids.add(id);
        }
      }
    }
    for (const id of ids) this.unregisterSession(id);
    try { this._kimi.dispose(); } catch {}
    this.removeAllListeners();
  }

  hasSession(hubSessionId) {
    return (
      this._claude.hasSession(hubSessionId) ||
      this._codex.hasSession(hubSessionId) ||
      this._gemini.hasSession(hubSessionId) ||
      this._kimi.hasSession(hubSessionId)
    );
  }

  // kind: 'claude' | 'claude-resume' | 'codex' | 'gemini' | 'kimi'
  // ctx: { cwd }
  registerSession(hubSessionId, kind, ctx = {}) {
    if (!hubSessionId || !kind) return;
    const backend = this._backendFor(kind);
    if (!backend) return;
    try { backend.registerSession(hubSessionId, { ...ctx, kind, allowExistingSession: ctx.allowExistingSession || kind === 'kimi-resume' }); }
    catch (e) { console.warn(`[transcript-tap] registerSession(${kind}) failed:`, e.message); }
  }

  notePrompt(hubSessionId, kind, prompt) {
    if (!hubSessionId || !kind || typeof prompt !== 'string') return;
    // A migrated legacy DeepSeek session is publicly still kind=deepseek, but it
    // is registered on ClaudeTap. Prefer the backend that already owns the sid.
    const backend = [this._claude, this._codex, this._gemini, this._kimi]
      .find(candidate => candidate.hasSession(hubSessionId)) || this._backendFor(kind);
    if (!backend || typeof backend.notePrompt !== 'function') return;
    try { backend.notePrompt(hubSessionId, prompt); }
    catch (e) { console.warn(`[transcript-tap] notePrompt(${kind}) failed:`, e.message); }
  }

  unregisterSession(hubSessionId) {
    for (const b of [this._claude, this._codex, this._gemini, this._kimi]) {
      try { b.unregisterSession(hubSessionId); } catch {}
    }
  }

  getLastAssistantText(hubSessionId) {
    return (
      this._claude.getLastAssistantText(hubSessionId) ||
      this._codex.getLastAssistantText(hubSessionId) ||
      this._gemini.getLastAssistantText(hubSessionId) ||
      this._kimi.getLastAssistantText(hubSessionId) ||
      null
    );
  }

  // Card optimization Task 3（2026-05-01）— 顶层流式聚合代理。
  //   按 claude → gemini → codex 顺序代理（codex 在 spike FAIL 后无 streamingBuf，可选链回退 null）。
  //   返回 Array<Block> | null，调用方拿到 null 时走 PTY 兜底。
  getStreamingText(hubSessionId) {
    return (
      this._claude.getStreamingText(hubSessionId) ||
      this._gemini.getStreamingText(hubSessionId) ||
      this._kimi.getStreamingText(hubSessionId) ||
      (this._codex.getStreamingText ? this._codex.getStreamingText(hubSessionId) : null) ||
      null
    );
  }

  clearStreamingBuf(hubSessionId) {
    for (const b of [this._claude, this._gemini, this._codex, this._kimi]) {
      try {
        if (typeof b.clearStreamingBuf === 'function') b.clearStreamingBuf(hubSessionId);
      } catch {}
    }
  }

  // Stage 2 容错升级（2026-05-01）— 委托到 GeminiTap，让外部 IPC handler 用统一的
  //   transcriptTap.extractLatestGeminiTurn(...) 入口，不必感知 _gemini 子实例。
  async extractLatestGeminiTurn(hubSessionId, sincePromptTs) {
    return this._gemini.extractLatestGeminiTurn(hubSessionId, sincePromptTs);
  }

  // 2026-05-02 Bug 修复：统一手动提取入口，按 backend 路由。
  //   Claude / legacy DeepSeek → ClaudeTap（读 transcript 末 last assistant）
  //   Codex / current DeepSeek → CodexTap（读 rollout 末 task_complete）
  //   Gemini              → GeminiTap.extractLatestGeminiTurn（既有实现，过滤 sincePromptTs）
  //   旧 IPC handler 只调 extractLatestGeminiTurn，对 Claude/DeepSeek/Codex 永远返回 null
  //   → 用户报告"提取按钮假的"。统一入口后所有 backend 都能真正工作。
  //   返回 { text, source } 或 null。调用方应顺序尝试三个 backend，因为同一 sid 只在一个里。
  // opts.untilTs（2026-07-12）：轮次窗口上界，仅 Codex 后端支持（rollout 事件带时间戳，
  //   可精确框定旧轮）；Claude/Gemini 后端只能读"最新回答"，忽略该参数——调用方
  //   （groupchat-recovery-handlers）对非 Codex 的旧轮重提取会提前拒绝，不会静默错位。
  async extractLatestTurn(hubSessionId, sincePromptTs = 0, opts = {}) {
    // 一个 sid 只属于一个 backend。按注册归属路由，避免 Claude 未绑定
    // transcriptPath 时继续落到 Codex 并返回 no_rollout_bound 空结果。
    if (this._claude.hasSession(hubSessionId)) {
      try { return await this._claude.extractLatestTurn(hubSessionId, sincePromptTs); } catch { return null; }
    }
    if (this._gemini.hasSession(hubSessionId)) {
      try { return await this._gemini.extractLatestGeminiTurn(hubSessionId, sincePromptTs); } catch { return null; }
    }
    if (this._codex.hasSession(hubSessionId)) {
      let r = null;
      try { r = await this._codex.extractLatestTurn(hubSessionId, sincePromptTs, opts); } catch {}
      if (r && r.text) return r;
      // 2026-05-04 codex equiv：codex 4 态契约——即便 text='' 也要把 extractMode 透传给 IPC
      // （承载 'no_task_complete_yet' / 'no_rollout_bound'，让 UI 区分原因，不再笼统 no_content）
      if (r && r.extractMode) return r;
      return null;
    }
    if (this._kimi.hasSession(hubSessionId)) {
      try { return await this._kimi.extractLatestTurn(hubSessionId, sincePromptTs); } catch { return null; }
    }
    // 2026-05-04 codex equiv：codex 4 态契约——即便 text='' 也要把 extractMode 透传给 IPC
    // （承载 'no_task_complete_yet' / 'no_rollout_bound'，让 UI 区分原因，不再笼统 no_content）
    return null;
  }

  // Card redesign（2026-05-01）— 最新 token 计数代理。
  //   目前仅 Gemini 提供 obj.tokens.total（Claude/Codex 无此通道），
  //   外部调用方收到 null 时按"未上报"处理（卡片 row4 显示 "-"）。
  getLastTokens(hubSessionId) {
    return this._gemini.getLastTokens(hubSessionId);
  }

  clearLastTokens(hubSessionId) {
    this._gemini.clearLastTokens(hubSessionId);
  }

  async notifyClaudeStop(hubSessionId, transcriptPath, options = {}) {
    try { await this._claude.notifyStop(hubSessionId, transcriptPath, options); }
    catch (e) { console.warn('[transcript-tap] notifyClaudeStop failed:', e.message); }
  }

  notifyClaudeError(hubSessionId, error = {}) {
    try { return this._claude.notifyError(hubSessionId, error); }
    catch (e) {
      console.warn('[transcript-tap] notifyClaudeError failed:', e.message);
      return false;
    }
  }

  async watchClaudeTranscript(hubSessionId, transcriptPath, options = {}) {
    try { await this._claude.watchTranscript(hubSessionId, transcriptPath, options); }
    catch (e) { console.warn('[transcript-tap] watchClaudeTranscript failed:', e.message); }
  }

  // 2026-05-04 codex equiv extract-failure debug —— TranscriptTap 转发 CodexTap 调试快照
  // 给 main.js 的 groupchat-codex-debug-state IPC handler 用，
  // renderer 可以拿到当前 _bound / _pending / _seen 状态排查为什么 manual-extract 拿不到。
  getCodexDebugSnapshot() {
    return this._codex.getDebugSnapshot();
  }

  getCodexRolloutPath(hubSessionId) {
    return this._codex.getRolloutPath(hubSessionId);
  }

  async bindCodexFromHook(hubSessionId, options = {}) {
    try { return await this._codex.bindFromHook(hubSessionId, options); }
    catch (e) {
      console.warn('[transcript-tap] bindCodexFromHook failed:', e.message);
      return false;
    }
  }

  async hasCodexUserMessageSince(hubSessionId, sincePromptTs = 0) {
    if (!this._codex.hasSession(hubSessionId)) return false;
    return this._codex.hasUserMessageSince(hubSessionId, sincePromptTs);
  }

  // 2026-05-04 gemini equiv：与 codex 镜像，给 groupchat-gemini-debug-state IPC handler 用。
  getGeminiDebugSnapshot() {
    return this._gemini.getDebugSnapshot();
  }

  getKimiDebugSnapshot() {
    return this._kimi.getDebugSnapshot();
  }

  _backendFor(kind) {
    // Current DeepSeek is part of CODEX_CLI_KINDS. Only the internal
    // deepseek-legacy kind remains in CLAUDE_FAMILY for old transcript recovery.
    if (isClaudeFamily(kind)) {
      return this._claude;
    }
    if (isCodexCliKind(kind)) return this._codex;
    if (kind === 'gemini') return this._gemini;
    if (isKimiCliKind(kind)) return this._kimi;
    return null;
  }
}

// ---------------------------------------------------------------------------
// Path normalization helper — Windows paths are case-insensitive and can
// use / or \. Normalize both into lower-case forward-slash form for compare.
// ---------------------------------------------------------------------------
function normalizePathForCompare(p) {
  if (!p || typeof p !== 'string') return '';
  let n = p.replace(/\\/g, '/');
  if (n.length > 3 && n.endsWith('/')) n = n.slice(0, -1);
  if (process.platform === 'win32') n = n.toLowerCase();
  return n;
}

function extractCodexSidFromRolloutPath(rolloutPath) {
  const base = path.basename(rolloutPath, '.jsonl');
  if (base.length < 36) return null;
  const sid = base.slice(-36);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sid)) return null;
  return sid;
}

function extractGeminiChatIdFromSessionPath(sessionPath) {
  const base = path.basename(sessionPath).replace(/\.(jsonl?|json)$/, '');
  if (!base.startsWith('session-')) return null;
  const parts = base.split('-');
  const last = parts[parts.length - 1];
  if (last && /^[0-9a-f]{8}$/i.test(last)) return last;
  return null;
}

function extractGeminiProjectHashFromDir(projectDir) {
  if (!projectDir) return null;
  return path.basename(projectDir);
}

module.exports = {
  TranscriptTap,
  CodexTap,           // 2026-05-04 codex equiv：单测注入 sessionsRoot 直测 4 态 extractMode
  GeminiTap,          // 2026-05-04 gemini equiv：单测注入 tmpRoot 直测 _bound 字段
  JsonlTail,
  readLastAssistantMessageFromClaudeTranscript,
  readLastTerminalAssistantTextFromClaudeTranscript,
  readCodexUserMessageEvents,
  extractCodexSidFromRolloutPath,
  extractGeminiChatIdFromSessionPath,
  extractGeminiProjectHashFromDir,
};
