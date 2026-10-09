'use strict';
// core/group-chat-watcher.js
// 群聊 PTY 通信工具集（2026-05-03 maintainer 阶段丙）。
// 从 main.js 抽出 5 个 helper：waitCliReady / sendToPty / extractStreamingText /
//   cleanBufLen / checkHostShellTakeover。
//
// 不抽：_gcWaitTurnComplete + _activeWatchers Map + dispatchGroupChatTurn。
//   它们闭包依赖太深（meetingManager/scenes/orchestrator/rtTimeline/rtInjection/
//   sendToRenderer...），一次性抽风险高，
//   留下次专项做（backlog）。
//
// 依赖注入（init）：sessionManager / cliReadyDetector / transcriptTap

const fs = require('fs');
const os = require('os');
const path = require('path');
const { detectHostShellTakeover, detectCodexThreadEnded } = require('./host-shell-detector.js');
const { isClaudeFamily, isCodexCliKind, isCodeAgentKind } = require('./ai-kinds.js');
const { stripAnsi } = require('./ansi-utils.js');
const {
  RUNTIME_RUNNING,
  advanceRunningAnimationCandidate,
  classifyTerminalRuntime,
} = require('./terminal-runtime-state.js');

// xterm bracketed paste mode markers（标准协议，claude code TUI 完整识别）。
//   marker 之间的内容被 CLI 视作"一次粘贴"整体处理，无需 paste-detect timing 探测，
//   BP_END 之后的 \r 直接作为提交信号被识别。
//   Windows Codex 还会经过按键粘贴缓冲，正文后用非文本键结束缓冲，再提交。
//   DeepSeek 迁移到 Codex 后也走 Codex 分支。
//   marker 常量与分块/settle 原语都在 core/pty-prompt-submit.js，普通会话走同一套。
//   本文件不再直接拼 BP 帧（writeBracketedPaste 负责），所以只引原语不引常量。
const {
  computeSettleMs,
  writeBracketedPaste,
  waitForPasteSettled,
  echoNeedle,
  snapshotPasteMarker,
  pasteStillInInputBox,
  hasPromptInInputLine,
} = require('./pty-prompt-submit.js');

let _deps = null;

function init(deps) {
  _deps = deps;
}

function resolveRuntimeKind(sessionManager, sid, fallbackKind) {
  if (!sessionManager || typeof sessionManager.getSession !== 'function') return fallbackKind;
  const session = sessionManager.getSession(sid);
  return (session && session.transcriptKind) || fallbackKind;
}

function writeCodexPromptFile(sessionManager, sid, text) {
  const session = typeof sessionManager.getSession === 'function' ? sessionManager.getSession(sid) : null;
  const baseDir = session && session.cwd ? session.cwd : os.tmpdir();
  const dir = path.join(baseDir, '.hub-codex-prompts');
  fs.mkdirSync(dir, { recursive: true });
  const safeSid = String(sid || 'session').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 24) || 'session';
  const fp = path.join(dir, `groupchat-${safeSid}-${Date.now()}.md`);
  fs.writeFileSync(fp, text, 'utf8');
  return fp;
}

async function writePromptToSession(sessionManager, sid, prompt, kind) {
  const text = String(prompt || '');
  if (!isCodexCliKind(kind)) {
    sessionManager.writeToSession(sid, text);
    return text;
  }
  if (/[^\x00-\x7F]/.test(text)) {
    try {
      const fp = writeCodexPromptFile(sessionManager, sid, text);
      const pointerPrompt = [
        `A UTF-8 group-chat prompt has been saved to this file: ${fp}.`,
        'Read that file, follow its instructions exactly, and answer in the language/schema requested inside it.',
        'If it asks for JSON, include the required JSON block exactly.',
        'Do not summarize the prompt file; execute the prompt.',
      ].join(' ');
      sessionManager.writeToSession(sid, pointerPrompt);
      return pointerPrompt;
    } catch (e) {
      console.warn(`[group-chat] failed to write Codex prompt file for ${sid}:`, e && e.message);
    }
  }
  if (text.length <= 8000) {
    sessionManager.writeToSession(sid, text);
    return text;
  }
  const chunkSize = 2048;
  for (let i = 0; i < text.length; i += chunkSize) {
    sessionManager.writeToSession(sid, text.slice(i, i + chunkSize));
    await new Promise(r => setTimeout(r, 12));
  }
  return text;
}

function noteSubmittedPrompt(sid, kind, actualPrompt) {
  if (!isCodexCliKind(kind) && !isClaudeFamily(kind)) return;
  const tap = _deps && _deps.transcriptTap;
  if (!tap || typeof tap.notePrompt !== 'function') return;
  try { tap.notePrompt(sid, kind, actualPrompt); }
  catch (e) { console.warn(`[group-chat] transcriptTap.notePrompt failed for ${kind}(${String(sid).slice(0, 8)}):`, e && e.message); }
}

function observeAgentTurnStart(sessionManager, sid, kind) {
  if (!isCodexCliKind(kind) && !isClaudeFamily(kind)) return null;
  const tap = _deps && _deps.transcriptTap;
  const canObserveSession = sessionManager
    && typeof sessionManager.on === 'function'
    && typeof sessionManager.removeListener === 'function';
  const canObserveTap = isCodexCliKind(kind)
    && tap && typeof tap.on === 'function' && typeof tap.removeListener === 'function';
  if (!canObserveSession && !canObserveTap) return null;
  const baselineSeq = typeof sessionManager.getAgentTurnStartSeq === 'function'
    ? sessionManager.getAgentTurnStartSeq(sid)
    : 0;
  let started = false;
  let acknowledgement = null;
  let resolveStarted = null;
  const startedPromise = new Promise((resolve) => { resolveStarted = resolve; });
  const settle = (event, source) => {
    if (started) return;
    started = true;
    acknowledgement = {
      source: event.signalSource || source,
      observedAt: Number(event.observedAt || event.startedAt) || Date.now(),
      turnId: event.turnId || null,
    };
    resolveStarted(acknowledgement);
  };
  const sessionListener = (event = {}) => {
    if (event.sessionId !== sid) return;
    if (Number(event.seq) && Number(event.seq) <= baselineSeq) return;
    settle(event, 'agent-turn-started');
  };
  const tapListener = (event = {}) => {
    if (event.hubSessionId !== sid) return;
    settle(event, 'task_started');
  };
  if (canObserveSession) sessionManager.on('agent-turn-started', sessionListener);
  if (canObserveTap) tap.on('turn-started', tapListener);
  return {
    get started() { return started; },
    get acknowledgement() { return acknowledgement; },
    async wait(timeoutMs) {
      if (started) return acknowledgement;
      return Promise.race([
        startedPromise,
        new Promise(resolve => setTimeout(() => resolve(null), Math.max(0, Number(timeoutMs) || 0))),
      ]);
    },
    dispose() {
      if (canObserveSession) sessionManager.removeListener('agent-turn-started', sessionListener);
      if (canObserveTap) tap.removeListener('turn-started', tapListener);
    },
  };
}

function probeStrongPtyWorkStart(sessionManager, sid, kind, probeState) {
  if (!sessionManager || typeof sessionManager.getSessionBuffer !== 'function') return null;
  const raw = String(sessionManager.getSessionBuffer(sid) || '');
  const baselineLength = Math.max(0, Number(probeState.baselineLength) || 0);
  // Prefer bytes produced after this send. Ring truncation/reset falls back to
  // the available buffer rather than silently disabling the probe.
  const current = raw.length >= baselineLength ? raw.slice(baselineLength) : raw;
  const clean = stripAnsi(current).replace(/\r/g, '\n');
  const runtime = classifyTerminalRuntime(kind, clean.split(/\n/));
  probeState.lastRingRuntime = runtime;
  probeState.lastRingTail = clean.slice(-1200);
  const advanced = advanceRunningAnimationCandidate(probeState.ringCandidate, runtime, Date.now());
  probeState.ringCandidate = advanced.candidate;
  if (!advanced.confirmed || runtime.state !== RUNTIME_RUNNING) return null;
  return {
    source: `pty-${runtime.reason || 'strong-running'}`,
    observedAt: Date.now(),
    turnId: null,
    evidence: runtime.evidence || null,
  };
}

function createLivePtyRuntimeObserver(sessionManager, sid, kind) {
  if (!sessionManager || typeof sessionManager.on !== 'function' || typeof sessionManager.removeListener !== 'function') return null;
  let Terminal;
  try { ({ Terminal } = require('@xterm/headless')); } catch { return null; }
  let terminal;
  try {
    terminal = new Terminal({
      cols: 120,
      rows: 30,
      scrollback: 2000,
      allowProposedApi: true,
      ...(process.platform === 'win32' ? {
        windowsPty: { backend: 'conpty', buildNumber: parseInt(os.release().split('.').pop(), 10) || 0 },
      } : {}),
    });
  } catch { return null; }
  let disposed = false;
  const queue = new (require('./terminal-write-queue').TerminalWriteQueue)(terminal, error => {
    console.warn('[group-chat] live PTY runtime probe write failed:', error && error.message);
  });
  const enqueue = (data) => {
    if (disposed || !data) return;
    queue.enqueue(data);
  };
  const listener = (event = {}) => {
    if (event.sessionId === sid) enqueue(event.data);
  };
  sessionManager.on('output', listener);
  enqueue(sessionManager.getSessionBuffer(sid) || '');
  return {
    async probe(probeState) {
      if (disposed) return null;
      try { await queue.drain(); } catch { return null; }
      if (disposed) return null;
      const buffer = terminal.buffer && terminal.buffer.active;
      if (!buffer) return null;
      const lines = [];
      const start = Math.max(0, Number(buffer.viewportY) || 0);
      for (let y = start; y < Math.min(buffer.length, start + terminal.rows); y += 1) {
        const line = buffer.getLine(y);
        if (line) lines.push(line.translateToString(true));
      }
      const runtime = classifyTerminalRuntime(kind, lines);
      probeState.lastLiveRuntime = runtime;
      probeState.lastLiveLines = lines.slice(-12);
      probeState.lastLiveScreen = lines;
      const advanced = advanceRunningAnimationCandidate(probeState.liveCandidate, runtime, Date.now());
      probeState.liveCandidate = advanced.candidate;
      if (!advanced.confirmed || runtime.state !== RUNTIME_RUNNING) return null;
      return {
        source: `pty-${runtime.reason || 'strong-running'}`,
        observedAt: Date.now(),
        turnId: null,
        evidence: runtime.evidence || null,
      };
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      sessionManager.removeListener('output', listener);
      queue.dispose();
      try { terminal.dispose(); } catch {}
    },
  };
}

// 最近一次探针是否已经把屏幕读成「正在跑」。这里刻意不要求动画确认帧：
//   waitForAgentWorkStart 只在 confirmed 时才返回，而「未确认但确实在跑」正是
//   最不该补回车的状态。用作补 Enter 的否决条件，而不是开工的肯定证据。
function looksAlreadyRunning(probeState) {
  if (!probeState) return false;
  return (probeState.lastLiveRuntime && probeState.lastLiveRuntime.state === RUNTIME_RUNNING)
    || (probeState.lastRingRuntime && probeState.lastRingRuntime.state === RUNTIME_RUNNING);
}

async function waitForAgentWorkStart(observer, sessionManager, sid, kind, timeoutMs, probeState, livePtyObserver) {
  const deadline = Date.now() + Math.max(0, Number(timeoutMs) || 0);
  while (Date.now() < deadline) {
    if (observer && (observer.started || observer.resolved)) return observer.acknowledgement;
    const pty = (livePtyObserver && await livePtyObserver.probe(probeState))
      || probeStrongPtyWorkStart(sessionManager, sid, kind, probeState);
    if (pty && !observer?.clientSubmissionId) return pty;
    await new Promise(resolve => setTimeout(resolve, Math.min(100, Math.max(1, deadline - Date.now()))));
  }
  if (observer && (observer.started || observer.resolved)) return observer.acknowledgement;
  const pty = (livePtyObserver && await livePtyObserver.probe(probeState))
    || probeStrongPtyWorkStart(sessionManager, sid, kind, probeState);
  if (observer && (observer.started || observer.resolved)) return observer.acknowledgement;
  return observer?.clientSubmissionId ? null : pty;
}

// Codex 的「任务进行中，命令被禁用」提示。TUI 重绘会把旧提示再画一遍，所以不看输出流，
// 只数可见屏幕上的条数：提交后比提交前多了，才是这一次被拒。
const CODEX_BUSY_REJECTION_RE = /is disabled while a task is in progress/i;
async function visibleBusyRejections(livePtyObserver) {
  if (!livePtyObserver) return 0;
  const state = { liveCandidate: null, ringCandidate: null };
  await livePtyObserver.probe(state);
  return (state.lastLiveScreen || []).filter(line => CODEX_BUSY_REJECTION_RE.test(line)).length;
}
async function codexRejectedBusyCommand(livePtyObserver, baseline, waitMs = 1200) {
  const deadline = Date.now() + waitMs;
  for (;;) {
    if (await visibleBusyRejections(livePtyObserver) > baseline) return true;
    if (Date.now() >= deadline) return false;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}

// /new、/clear（可带参数）在 Codex 里都是结束当前线程、开一条新线程。
const CODEX_THREAD_SWITCH_COMMAND_RE = /^\s*\/(?:new|clear)(?:\s|$)/i;
// Codex 在 /new 时不报任何 hook（新线程要到第一次提问才发 SessionStart），CLI 自己的执行
// 证据是它打印的「To continue this session … (<刚结束的线程 id>)」。确认时把结论记在会话上，
// 等新线程的 SessionStart 迟到时，改绑判定不必再从已经滚远的缓冲区里找这句话。
async function waitCodexThreadSwitch(sessionManager, sid, sidBefore, livePtyObserver, busyBaseline, fromMark, timeoutMs = 12000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const now = sessionManager.getSession?.(sid)?.codexSid || null;
    if (now && now !== sidBefore) return 'switched';
    // 缓冲区写满 1MB 后长度不再增长，按长度截取永远是空串：用累计输出标记取新输出。
    const fresh = typeof sessionManager.getSessionOutputSince === 'function'
      ? sessionManager.getSessionOutputSince(sid, fromMark)
      : String(sessionManager.getSessionBuffer?.(sid) || '');
    if (sidBefore && detectCodexThreadEnded(fresh, sidBefore)) {
      sessionManager.noteCodexThreadEnded?.(sid, sidBefore);
      return 'switched';
    }
    if (await visibleBusyRejections(livePtyObserver) > busyBaseline) return 'rejected';
    if (Date.now() >= deadline) return 'timeout';
    await new Promise(resolve => setTimeout(resolve, 150));
  }
}

// 画面上不再有带动画的工作行持续一小段时间，才算收尾结束；最多等 20 秒。
async function waitCodexSettled(livePtyObserver, { quietMs = 1500, maxMs = 20000 } = {}) {
  if (!livePtyObserver) { await new Promise(resolve => setTimeout(resolve, quietMs)); return; }
  const start = Date.now();
  let lastBusyAt = Date.now();
  const state = { liveCandidate: null, ringCandidate: null };
  while (Date.now() - start < maxMs) {
    if (await livePtyObserver.probe(state)) lastBusyAt = Date.now();
    if (Date.now() - lastBusyAt >= quietMs) return;
    await new Promise(resolve => setTimeout(resolve, 150));
  }
}

async function clearCodexInputLine(sessionManager, sid, kind) {
  if (!isCodexCliKind(kind)) return false;
  // Codex can keep an unsubmitted prompt in the input box after zero-echo /
  // timeout. Clear the line before an automatic rewrite so the next prompt
  // does not concatenate with the previous file-pointer prompt.
  sessionManager.writeToSession(sid, '\x15'); // Ctrl+U
  await new Promise(r => setTimeout(r, 80));
  return true;
}

function writeSubmitSignal(sessionManager, sid, kind, attempt = 0) {
  if (!isCodexCliKind(kind)) {
    sessionManager.writeToSession(sid, '\r');
    return 'cr';
  }
  const variants = ['\r', '\n', '\r\n'];
  const signal = variants[Math.max(0, Number(attempt) || 0) % variants.length];
  sessionManager.writeToSession(sid, signal);
  if (signal === '\n') return 'lf';
  if (signal === '\r\n') return 'crlf';
  return 'cr';
}

async function writeSubmitFallbackSignals(sessionManager, sid, kind, tries = 1, gapMs = 150) {
  const total = isCodexCliKind(kind) ? Math.max(1, Number(tries) || 1) : 1;
  for (let i = 0; i < total; i += 1) {
    writeSubmitSignal(sessionManager, sid, kind, i);
    if (i < total - 1) {
      await new Promise(r => setTimeout(r, gapMs));
    }
  }
}

// ---------------------------------------------------------------------------
// waitCliReady — 群聊发送 prompt 前的等待轮询。判定逻辑独立到
//   core/group-chat-cli-ready-detector.js（marker + buffer 静默双门 + monotonic guard）。
//   timeout 提到 60s 兜底（Claude Opus 1M 启动 + 配置加载在慢机可能 30s+）。
async function waitCliReady(sid, kind, maxMs = 60000) {
  const { sessionManager, cliReadyDetector } = _deps;
  const native = (sessionManager.getNativeSession?.(sid) || sessionManager.getNativeCodex?.(sid));
  if (native) {
    try { await native.start(); return native.runtime.connection === 'connected'; }
    catch (error) { console.warn('[codex-native] ready failed:', error.message); return false; }
  }
  const nativeClaude = sessionManager.getNativeClaude?.(sid);
  if (nativeClaude) {
    await nativeClaude.start();
    return nativeClaude.runtime.connection === 'connected' && !nativeClaude.unreconciled;
  }
  const start = Date.now();
  const readyKind=isCodexCliKind(kind) ? 'codex' : isCodeAgentKind(kind) ? 'codeagent' : isClaudeFamily(kind) ? 'claude' : String(kind).replace(/-resume$/,'');
  while (Date.now() - start < maxMs) {
    const buf = sessionManager.getSessionBuffer(sid) || '';
    // Time the CLI has already been silent counts toward the stable window.
    if (cliReadyDetector.isReady(sid, readyKind, buf, { lastOutputAt: sessionManager.getGroupChatLastActivity?.(sid) || 0 })) return true;
    await new Promise(r => setTimeout(r, 100));
  }
  return false;
}

// ---------------------------------------------------------------------------
// sendToPty — 发送 prompt 到 PTY 并回车。
// 设计：CLI 初始化是持久状态，只需做一次。session-manager 的 groupChatReady 缓存
//       让第 2-N 轮跳过冷启动等待，直接走快路径。
// **关键约束（历史 bug 重现于 2026-04-30）**：Claude/Gemini/Codex 三家都是 TUI alt-screen 程序，
//   把紧贴到达的字符当"粘贴"事件 → 粘贴里的 '\r' 被当文本换行符而不是 Enter 提交。
//   所以 prompt 和 '\r' **必须分两次 write**，中间留 TUI 消化窗口；不能合并 `prompt + '\r'`。
// options.requireReady=false：跳过冷启动 waitCliReady（2026-09-03）。
//   普通会话的输入框就摆在用户面前，CLI 显然已经在跑；再等一次 60s 的 ready 轮询
//   只会把"打完字立刻发出去"变成有时要等几十秒。群聊派发默认仍为 true。
const promptSubmissionQueues = new Map();
async function sendToPty(sid, prompt, kind, options = {}) {
  // Serialize submission, not the model's answer. Workflow dispatch and user
  // interjections share this boundary so their paste chunks cannot interleave.
  const previous=promptSubmissionQueues.get(sid);
  // Enter the first submission synchronously so native cancellation registers
  // its intent before a caller can close the session in this same tick.
  const task=previous ? previous.catch(()=>{}).then(()=>sendToPtyImpl(sid,prompt,kind,options))
    : sendToPtyImpl(sid,prompt,kind,options);
  promptSubmissionQueues.set(sid,task);
  try{return await task;}
  finally{if(promptSubmissionQueues.get(sid)===task)promptSubmissionQueues.delete(sid);}
}
async function sendToPtyImpl(sid, prompt, kind, options = {}) {
  if(options.shouldSubmit && !options.shouldSubmit())return {ok:false,notSent:true,reason:'派工已暂停或取消，本条未发送'};
  if (require('./session-speed').pendingSpeedSwitches.has(sid) && !options.localCommandObserver) {
    throw new Error('正在确认当前会话的速度设置，请完成后再发送');
  }
  const { sessionManager } = _deps;
  if (sessionManager.restartPending) throw Object.assign(new Error('Hub 正在重启，未发送新任务'), {notSent:true});
  if (!options.workspaceRulesPrepared && sessionManager.memoryService?.withWorkspaceRules) {
    return sessionManager.memoryService.withWorkspaceRules(sid,prompt,kind,options,
      text=>sendToPtyImpl(sid,text,kind,{...options,workspaceRulesPrepared:true}));
  }
  const native = (sessionManager.getNativeSession?.(sid) || sessionManager.getNativeCodex?.(sid));
  if (native) return native.send(prompt, {
    ...options, clientSubmissionId:options.clientSubmissionId || options.submissionReceipt?.clientSubmissionId,
  });
  const session = sessionManager.getSession?.(sid);
  // 原生 Codex 断了连接时不能退回 PTY 粘贴；PTY Codex 正常走下面的提交闭环。
  if (session && session.runtimeBackend === 'codex-app-server') {
    throw new Error('Codex 原生连接不可用，消息未发送');
  }
  const nativeClaude = sessionManager.getNativeClaude?.(sid);
  if (nativeClaude) {
    // Slash commands are a command channel, not a prompt: the driver reports the
    // engine's own output so the composer can show the result.
    if (String(prompt).trimStart().startsWith('/') && !(options.attachments || []).length) {
      return nativeClaude.slash(prompt, options);
    }
    const { claudeNativeReceipt } = require('./claude-native-binding');
    return claudeNativeReceipt(await nativeClaude.submit(prompt, options));
  }
  if (sessionManager.getSession?.(sid)?.runtimeBackend === 'claude-stream-json') {
    throw new Error('Claude 原生连接不可用，消息未发送');
  }
  const alreadySubmitted = () => ({ ok: options.submissionReceipt?.status !== 'content-mismatch',
    sendStatus: options.submissionReceipt?.status === 'content-mismatch' ? 'content-mismatch' : 'ok', enterAttempts: 0,
    acknowledgementSource: options.submissionReceipt?.acknowledgement?.source || 'prompt-submitted' });
  if (options.submissionReceipt?.resolved) return alreadySubmitted();
  const requireReady = options.requireReady !== false;
  kind = resolveRuntimeKind(sessionManager, sid, kind);
  const FAST_PATH_QUIET_MS = 250;       // 连续 250ms 无 PTY 数据 → 视为 paste 接收完
  const FAST_PATH_MAX_WAIT_MS = 3000;   // 上限：极大 prompt 也不无限等
  const FAST_PATH_POLL_MS = 50;
  const ENTER_RETRY_TRIES = 3;          // legacy 非协议路径的有界提交兜底
  const ENTER_RETRY_GAP_MS = 150;       // 兜底 \r 之间间隔
  const POST_ENTER_VERIFY_MS = 500;     // 提交后再观察一次活性，确认没卡
  // bug A 修复（2026-05-03 maintainer）：turn 间 race condition
  //   stop_hook / stop_reason 触发时 Claude 逻辑层已结束本轮，但 PTY 终端
  //   仍在异步喷收尾字符（清 spinner / 重画 prompt /TUI 装饰）。Hub 立刻 type
  //   下一轮 prompt 会撞上 PTY 余响，prompt 被 throbbing 状态吃掉、单个 \r
  //   不触发提交 → sub 表面"sent"但 jsonl 没收到 user msg → 5min 硬超时
  //   才标 absent。修：写 prompt 前等 PTY 真正静默 N ms。
  const PRE_PROMPT_QUIET_MS = 1500;     // 至少 1.5s PTY 无新字符
  const PRE_PROMPT_MAX_WAIT_MS = 8000;  // 上限：避免持续 spinner 死等

  // 普通会话的第一条（2026-09-25 真机实测）：CLI 刚画出提示符、输入还没真正就绪时粘贴，
  //   Codex 只收到最后一个字，Claude 整条丢失。requireReady=false 的调用方也要在
  //   **第一次**发送前等一次就绪；最多 20s，超时照旧发送并留痕（闭环会把没提交如实报 stuck）。
  //   只对刚启动一分钟内的会话生效：早已在跑的会话，输入框就摆在用户面前，不能再让人干等。
  const createdAt = Number(sessionManager.getSession?.(sid)?.createdAt) || 0;
  const freshlySpawned = createdAt > 0 && Date.now() - createdAt < 60000;
  if (!requireReady && freshlySpawned && !sessionManager.getGroupChatReady(sid)
      && (isClaudeFamily(kind) || isCodexCliKind(kind)) && _deps.cliReadyDetector) {
    if (await waitCliReady(sid, kind, Number(_deps.firstPromptReadyMs) || 20000)) sessionManager.setGroupChatReady(sid, true);
    else {
      const readyKind = isCodexCliKind(kind) ? 'codex' : isCodeAgentKind(kind) ? 'codeagent' : 'claude';
      // 选择框还挂着时粘贴会被吞掉，回车还会替用户选默认项：宁可不发，也不能替人做选择。
      if (_deps.cliReadyDetector.isChoiceDialogVisible?.(readyKind, sessionManager.getSessionBuffer(sid) || '')) {
        throw Object.assign(new Error('CLI 正在等你在终端里做选择（例如启动提示），消息未发送；处理完后再发送'),
          { notSent: true, code: 'cli-choice-pending' });
      }
      console.warn(`[group-chat] ${kind}(${sid.slice(0, 8)}) first prompt: CLI ready markers not seen in 20s; sending anyway`);
    }
  }

  // 冷启动：仅首次或 ready 被重置后（requireReady=false 的调用方整段跳过）
  if (requireReady && !sessionManager.getGroupChatReady(sid)) {
    const ready = await waitCliReady(sid, kind, 60000);
    // CLI 完全没启动 → prompt 都没写，可以正当放弃
    if (!ready) {
      const buf = sessionManager.getSessionBuffer(sid) || '';
      console.warn(`[group-chat] cli not ready for ${kind}(${sid.slice(0, 8)}) after 60s; bufLen=${buf.length}; tail=${JSON.stringify(buf.slice(-160))}`);
      return {ok:false,notSent:true,sendStatus:'rejected',error:'cli-not-ready',message:'助理启动尚未完成，本条消息未发送；稍后再发送即可。'};
    }
    sessionManager.setGroupChatReady(sid, true);
  }

  // The TUI can exit after readiness was cached (for example a failed resume).
  // A normal card prompt must never become a PowerShell command.
  if (require('./ai-kinds').isAiKind(String(kind).replace(/-resume$/, ''))
      && detectHostShellTakeover(sessionManager.getSessionBuffer(sid) || '')) {
    sessionManager.setGroupChatReady(sid, false);
    throw Object.assign(new Error('CLI 已退出到系统终端，消息未发送；请先重启会话'),
      { notSent:true, code:'cli-exited' });
  }

  if ((options.restartContinuation || sessionManager.restartContinuationSessions?.has(sid)) && ['kimi','kimi-resume','gemini','gemini-resume','deepseek','deepseek-resume'].includes(kind)) {
    const receipt=require('./hub-restart-legacy').observeLegacyPrompt(_deps.transcriptTap,sid,prompt,
      20000+Math.ceil(String(prompt).length/2048)*12+computeSettleMs(String(prompt).length));
    const record=result=>{
      if(result.ok){
        sessionManager.restartContinuationReceipts ||= new Map();
        sessionManager.restartContinuationReceipts.set(sid,{id:options.clientSubmissionId || require('crypto').randomUUID(),status:'accepted'});
      }
      return result;
    };
    try {
      const baselineMarker=snapshotPasteMarker(sessionManager,sid);
      const text=String(prompt);
      if(isCodexCliKind(kind))await writeBracketedPaste(sessionManager,sid,text);
      else for(let offset=0;offset<text.length;offset+=2048){
        sessionManager.writeToSession(sid,text.slice(offset,offset+2048));
        await new Promise(resolve=>setTimeout(resolve,12));
      }
      require('./codex-pty-input').flushCodexPasteInput(sessionManager,sid,kind,text);
      await waitForPasteSettled({sessionManager,sid,settleMs:computeSettleMs(text.length),baselineMarker});
      writeSubmitSignal(sessionManager,sid,kind,0);
      const first=await receipt.wait(7000);
      if(first)return record(first);
      if(!receipt.confirmed)writeSubmitSignal(sessionManager,sid,kind,1);
      return record(await receipt.promise);
    } finally {receipt.dispose();sessionManager.restartContinuationSessions?.delete(sid);}
  }

  // ===========================================================================
  // 1A fast-path：claude family 走 xterm bracketed paste，跳过 PRE_PROMPT_QUIET
  // / paste-detect 静默等待（最多省 4-5s）。
  //   旧主路径用 timing 探测（PTY 静默 1.5s + paste-detect 静默 250ms）来近似
  //   "CLI paste 缓冲已收完"，但 Ink TUI 持续重渲染（spinner/cursor blink）让静默
  //   信号失真，timing 经常上限超时硬冲、\r 被吃掉、prompt 留输入框没提交。
  //   bracketed paste markers 是显式协议，CLI 一看到 BP_END 就明确"粘贴结束"，
  //   无需任何 timing 探测。claude family 实测稳定通过。
  //   2026-06-18 maintainer 实测：codex 0.137 也已支持 BP 协议（BP 包裹中文立即提交、不进
  //     [Pasted Content] 粘贴态、不卡输入框）→ codex 改走此 fast-path，一并解决"卡输入框
  //     未提交"(Bug B) + "中文走 .md 文件中转嵌入"(Bug C：BP 直接发中文，不再经 writePromptToSession)。
  //   gemini 协议仍不识别（marker 被吃但 \r 不提交），保留旧主路径。
  if (isClaudeFamily(kind) || isCodexCliKind(kind)) {
    // Capture the provider lifecycle cursor before typing.  Claude
    // UserPromptSubmit and Codex task_started are the same authoritative
    // "agent really began work" signal that drives ordinary-session status.
    const turnStart = options.submissionReceipt || observeAgentTurnStart(sessionManager, sid, kind);
    const livePtyObserver = createLivePtyRuntimeObserver(sessionManager, sid, kind);
    try {
    const codexBusyBaseline = isCodexCliKind(kind) && /^\s*\//.test(String(prompt || ''))
      ? await visibleBusyRejections(livePtyObserver) : 0;
    const codexThreadSwitch = isCodexCliKind(kind) && CODEX_THREAD_SWITCH_COMMAND_RE.test(String(prompt || ''));
    const codexSidBefore = codexThreadSwitch ? (sessionManager.getSession?.(sid)?.codexSid || null) : null;
    const outputMarkBefore = typeof sessionManager.getSessionOutputMark === 'function' ? sessionManager.getSessionOutputMark(sid) : 0;
    if (options.submissionReceipt?.resolved) return alreadySubmitted();
    // The native editor replaces the entire draft and preserves multi-line
    // content. Do not clear first: a failed editor handoff must keep the draft.
    const usedCodexEditorInput = isCodexCliKind(kind)
      && await sessionManager.tryLoadCodexEditorInput?.(sid, prompt, { attachments: options.attachments || [] });
    if (!usedCodexEditorInput) await clearCodexInputLine(sessionManager, sid, kind);
    if (options.submissionReceipt?.resolved) return alreadySubmitted();
    const beforeBufferLength = String(sessionManager.getSessionBuffer(sid) || '').length;
    const beforeWrite = sessionManager.getGroupChatLastActivity(sid);
    // 分块投喂（2026-09-03）：单次 write 几十 KB 会把 node-pty 的 inSocket 队列灌满，
    //   随后那个 \r 被追加进同一条队列，很可能与 BP_END 落进 CLI 的同一个 stdin chunk
    //   被当粘贴尾巴吃掉。分片写让队列在最后一片写完时接近空，\r 才可能独立成块。
    const baselineMarker = snapshotPasteMarker(sessionManager, sid);
    if (!usedCodexEditorInput) await writeBracketedPaste(sessionManager, sid, prompt, {
      inlinePieces: isClaudeFamily(kind), // 不让 Claude 把整段标成 <pasted_content>（见 pty-prompt-submit）
      chunkSize: Number(_deps && _deps.bracketedPasteChunkSize) || undefined,
      gapMs: Number(_deps && _deps.bracketedPasteChunkGapMs) || undefined,
    });
    const codexPasteFlushed = usedCodexEditorInput || require('./codex-pty-input').flushCodexPasteInput(sessionManager,sid,kind,prompt);
    noteSubmittedPrompt(sid, kind, prompt); // codex 记录原始 prompt 供 transcript 提交校验（claude no-op）
    // BP_END 紧贴 \r 时 Ink 把 \r 当 paste 尾巴忽略，所以必须隔开再发。
    //   隔多久以前写死 500ms —— 短 prompt 够用，长 prompt 必然还在消化窗口内，
    //   于是"输入越长越容易卡输入框"。改成两条：
    //     1) settle 上限随体积走（computeSettleMs）
    //     2) 屏幕上出现新的折叠标记就提前收工（正向信号，不再干等）
    //   bracketedPasteSettleMs 显式配置时仍按固定值走，保留测试与应急旁路。
    const configuredSettleMs = Number(_deps && _deps.bracketedPasteSettleMs);
    const pasteSettleMs = Number.isFinite(configuredSettleMs) && configuredSettleMs > 0
      ? configuredSettleMs
      // On Windows Codex, End flushes the native paste state before the Enter
      // queued behind it. The ordered key boundary replaces a guessed delay;
      // the task-start acknowledgement and bounded recovery below still apply.
      : codexPasteFlushed ? 0 : computeSettleMs(String(prompt || '').length, {
        minMs: Number(_deps && _deps.bracketedPasteSettleMinMs) || undefined,
        maxMs: Number(_deps && _deps.bracketedPasteSettleMaxMs) || undefined,
      });
    // The CLI drawing the end of this message is the earliest proof it consumed
    // the paste; the size-based settle stays as the ceiling when it never shows.
    await waitForPasteSettled({ sessionManager, sid, settleMs: pasteSettleMs, baselineMarker,
      echoNeedle: usedCodexEditorInput ? null : echoNeedle(prompt),
      readOutputSince: typeof sessionManager.getSessionOutputSince === 'function'
        ? () => sessionManager.getSessionOutputSince(sid, outputMarkBefore) : null });
    if (options.shouldSubmit && !options.shouldSubmit()) return {ok:false,notSent:true,reason:'派工已暂停或取消，本条未提交'};
    if (options.submissionReceipt?.resolved) return alreadySubmitted();
    // One Enter first.  Extra Enters are conditional on the absence of a
    // semantic work-start acknowledgement, rather than being fired blindly.
    // This mirrors the normal-session runtime truth and avoids accidental
    // empty submissions after a prompt already started.
    sessionManager.writeToSession(sid, '\r');
    let enterAttempts = 1;
    const modelCommand = require('./cli-model-command').modelCommandType(kind, String(prompt || ''));
    if (modelCommand) {
      const deadline = Date.now() + 12000;
      const probe = {};
      while (Date.now() < deadline) {
        await livePtyObserver?.probe(probe);
        const fresh = stripAnsi(sessionManager.getSessionOutputSince?.(sid, outputMarkBefore) || '');
        if (require('./cli-model-command').modelCommandAcknowledged(modelCommand, (probe.lastLiveScreen || []).join('\n'), fresh)) {
          return { ok: true, sendStatus: 'ok', enterAttempts, acknowledgementSource: 'cli-model-command' };
        }
        if (require('./host-shell-detector').detectHostShellTakeover(sessionManager.getSessionBuffer(sid))) {
          return { ok: false, notSent: true, sendStatus: 'rejected', enterAttempts, message: 'CLI 已退出，请重启会话后再切换模型' };
        }
        if (modelCommand === 'codex-picker' && await codexRejectedBusyCommand(livePtyObserver, codexBusyBaseline)) {
          return { ok: false, notSent: true, sendStatus: 'rejected', enterAttempts, message: 'Codex 仍在处理上一轮，模型命令未执行' };
        }
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      // A local menu never starts a model turn. An extra Enter could select
      // its highlighted model, so uncertainty cannot trigger Enter recovery.
      return { ok: true, sendStatus: 'stuck', enterAttempts, acknowledgementSource: null,
        message: '模型命令尚未确认，请查看终端；未自动补发回车' };
    }
    // Local settings commands do not start an agent turn. Their own explicit
    // acknowledgement must decide success; a TUI repaint is not confirmation.
    if (options.localCommandObserver) {
      const confirmation = await options.localCommandObserver.wait();
      return {ok:confirmation.ok,sendStatus:confirmation.ok ? 'ok' : 'stuck',
        message:confirmation.message,enterAttempts,acknowledgementSource:'local-command'};
    }
    // Codex 的 /new、/clear 不触发提交 hook，也不开工；它的确认就是「Hub 跟上了新线程」
    // （新线程的 SessionStart 改绑了 codexSid）。不等开工信号、不补回车，否则既白等十几秒，
    // 又会亮出「补发」——一点就再开一条线程。明确被拒则等空闲后只再提交一次。
    if (codexThreadSwitch) {
      const outcome = await waitCodexThreadSwitch(sessionManager, sid, codexSidBefore, livePtyObserver, codexBusyBaseline, outputMarkBefore);
      if (outcome === 'switched') {
        return { ok: true, sendStatus: 'ok', enterAttempts, acknowledgementSource: 'codex-thread-switch',
          acknowledgementObservedAt: Date.now(), acknowledgementTurnId: null };
      }
      if (outcome === 'rejected') {
        if (!options.retriedAfterBusyReject) {
          console.warn(`[group-chat] codex(${sid.slice(0, 8)}) rejected ${String(prompt).trim()} while its previous task was still finishing; submitting once more after it settles`);
          await waitCodexSettled(livePtyObserver);
          return await sendToPtyImpl(sid, prompt, kind, { ...options, retriedAfterBusyReject: true, workspaceRulesPrepared: true });
        }
        return { ok: false, notSent: true, sendStatus: 'rejected', error: 'cli-busy-rejected', enterAttempts, acknowledgementSource: null,
          message: 'Codex 仍在处理上一轮，命令被拒绝、没有执行；请稍后再发' };
      }
      console.warn(`[group-chat] codex(${sid.slice(0, 8)}) ${String(prompt).trim()} not confirmed by a thread switch`);
      return { ok: true, sendStatus: 'stuck', enterAttempts, acknowledgementSource: null };
    }

    // 2026-05-05 fix（虚警 bug）：单点 500ms 后查一次 lastActivity 变化，对 claude
    //   慢启动场景误判 stuck（实测：\r 后 claude TUI 渲染 user message + 启 streaming
    //   延迟在 200-1500ms 间，500ms 单点窗口边缘 case 失败率高 → 卡片显示"输入卡顿"
    //   但实际 25s 内已输出 750 字）。改成轮询窗口：activity 一变就早 break，
    //   仅真 stuck 时跑满 1500ms 才标。正常情况 dispatch 净延迟仍 < 1s。
    let sendStatus = 'ok';
    let acknowledgement = null;
    let probeState = null;
    if (turnStart) {
      // Large bracketed pastes need time to leave the TUI input state.
      // 实测（20260831，Codex CLI 0.151.0，222 行 / 14,061 字）：从提交到 task_started
      //   稳定落在 4708-4847ms。窗口若取 4000ms，这条"有条件"的补 Enter 就变成每次必发，
      //   3 次试验里还多打出过一个 Codex turn。取 9s 留约 2 倍余量：宁可晚 5 秒报 stuck，
      //   也不要在 agent 已经开工后再补一次回车。
      const firstAckMs = Math.max(20, Number(_deps && (_deps.agentTurnStartAckMs || _deps.codexTurnStartAckMs) || 9000));
      const recoveryAckMs = Math.max(20, Number(_deps && (_deps.agentTurnStartRecoveryMs || _deps.codexTurnStartRecoveryMs) || 6000));
      const configuredRetryMax = Number(_deps && _deps.agentTurnStartRetryMax);
      const retryMax = Number.isFinite(configuredRetryMax)
        ? Math.max(0, Math.min(2, configuredRetryMax))
        : 1;
      probeState = { baselineLength: beforeBufferLength, liveCandidate: null, ringCandidate: null };
      acknowledgement = await waitForAgentWorkStart(turnStart, sessionManager, sid, kind, firstAckMs, probeState, livePtyObserver);
      let recoveryAttempts = 0;
      // PTY activity alone is not proof of submission: Codex redraws the input
      // box while a `[Pasted Content …]` block is still waiting for Enter. A
      // provider lifecycle event is the semantic acknowledgement. If absent,
      // send a late isolated Enter only then, exactly as the user would.
      // 「屏幕在跑」到底该不该补回车，取决于**输入框里还有没有没提交的粘贴内容**
      //   （2026-09-03，实测逼出来的）。
      //   旧写法只看 looksAlreadyRunning：命中就 continue，而 retryMax=1 时那个 continue
      //   直接把 attempt 推到上限、循环结束 —— **补发回车一次都没发**却报了 stuck。
      //   实测现场（Codex 普通会话 220 行）正是如此：上一轮答案还在收尾，屏幕被读成"在跑"，
      //   于是 220 行 prompt 以 `› [Pasted Content 10377 chars]` 永远留在输入框里，
      //   enterAttempts 停在 1，用户干等。
      //
      //   两种情形都真实存在，区分它们的不是预算而是正向证据：
      //     - 屏幕末尾还挂着折叠标记 → 这次粘贴**没提交**，补回车是唯一救援，必须发；
      //     - 屏幕在跑且输入框是空的 → prompt 已经进去了，确认只是慢，补回车才会多起一轮
      //       （那正是 unit-groupchat-redundant-enter-guard 锁住的实测教训）。
      //   注意只看可见屏幕末尾行：ring buffer 是只增历史，提交成功后标记依然留在里面。
      const maxRunningExtends = Math.max(0, Number(_deps && _deps.agentTurnStartRunningExtends) || 2);
      let runningExtends = 0;
      // 记下「看到屏幕在跑、且输入框里没有未提交的折叠粘贴」这个观察，
      //   循环结束后用它把"确认迟到"和"真的卡住"分开。
      let observedRunningWithClearInput = false;
      let cliExitedDuringAck = false;
      for (let attempt = 0; !acknowledgement && attempt < retryMax;) {
        // A slash command or CLI crash can return to PowerShell during the
        // acknowledgement wait. Recovery Enter must never reach that shell.
        if (require('./host-shell-detector').detectHostShellTakeover(sessionManager.getSessionBuffer(sid))) { cliExitedDuringAck = true; break; }
        if (turnStart.started || turnStart.resolved) {
          acknowledgement = turnStart.acknowledgement;
          break;
        }
        const pasteStillPending = pasteStillInInputBox(probeState, prompt);
        if (!pasteStillPending && looksAlreadyRunning(probeState)) {
          observedRunningWithClearInput = true;
          if (runningExtends >= maxRunningExtends) {
            console.warn(`[group-chat] ${kind} work-start still unconfirmed for ${sid.slice(0, 8)}, but the input box is clear and the screen reads running; not pressing Enter`);
            break;
          }
          runningExtends += 1;
          console.warn(`[group-chat] ${kind} work-start unconfirmed for ${sid.slice(0, 8)} but the screen already reads running; extending the wait ${runningExtends}/${maxRunningExtends} instead of pressing Enter`);
          acknowledgement = await waitForAgentWorkStart(turnStart, sessionManager, sid, kind, recoveryAckMs, probeState, livePtyObserver);
          continue;
        }
        attempt += 1;
        recoveryAttempts += 1;
        enterAttempts += 1;
        console.warn(`[group-chat] ${kind} prompt has no agent work-start acknowledgement for ${sid.slice(0, 8)}${pasteStillPending ? ' and pending text is still sitting in the input box' : ''}; sending late Enter recovery ${attempt}/${retryMax}`);
        sessionManager.writeToSession(sid, '\r');
        acknowledgement = await waitForAgentWorkStart(turnStart, sessionManager, sid, kind, recoveryAckMs, probeState, livePtyObserver);
      }
      // 「屏幕跑过 + 输入框是空的」本身就是提交成功的证据（2026-09-03）。
      //   实测现场：新建 Codex 会话的**第一轮**，rollout 还没绑定所以 task_started 迟到，
      //   而答案又短到 running footer 没撑够确认帧 —— 于是没有任何 lifecycle 确认。
      //   但屏幕上答案已经打出来了、输入框空着。此时报 stuck 是自相矛盾的：
      //   stuck 的含义是「prompt 还躺在输入框里没提交」，而我们明明观察到它离开了输入框。
      //   照报不误的话，用户会在一次完全正常的发送上看到「⚠ 消息可能没提交」。
      //   注意这只在**从未按过补发回车**的路径上成立；真正卡住的那条路输入框里有折叠标记，
      //   走的是上面补回车的分支，拿不到确认仍然如实报 stuck。
      if (!acknowledgement && observedRunningWithClearInput && !options.submissionReceipt) {
        console.warn(`[group-chat] ${kind} prompt has no lifecycle acknowledgement for ${sid.slice(0, 8)}, but the screen ran with a clear input box; treating it as submitted`);
        acknowledgement = { source: 'pty-running-input-clear', observedAt: Date.now(), turnId: null };
      }
      // 等确认期间 CLI 退回了命令行：明确报失败（不是 notSent，退出前正文可能已写进 CLI）。
      if (!acknowledgement && cliExitedDuringAck) {
        return { ok: false, sendStatus: 'cli-exited', error: 'cli-exited', enterAttempts, acknowledgementSource: null,
          message: 'CLI 已退出到命令行，消息可能没有被接收，未补回车' };
      }
      if (!acknowledgement) {
        console.warn(`[group-chat] ${kind} prompt submission not acknowledged for ${sid.slice(0, 8)} after late Enter recovery`);
        sendStatus = 'stuck';
      } else if (recoveryAttempts > 0) {
        sendStatus = 'auto_recovered';
      }
    } else {
      // Compatibility fallback for lightweight test/mocked managers without a
      // lifecycle event bus.  A repaint is weaker evidence, but still better
      // than reporting success after total silence.
      await new Promise(r => setTimeout(r, 1500));
      if (sessionManager.getGroupChatLastActivity(sid) === beforeWrite) sendStatus = 'stuck';
    }
    if (options.submissionReceipt?.status === 'content-mismatch') sendStatus = 'content-mismatch';
    // Codex 写完 task_complete 后还要收尾（Stop hook 等），这段时间 TUI 仍算「任务进行中」：
    // 普通提问会被排队，斜杠命令却被直接拒绝（'/new' is disabled while a task is in progress），
    // 而收尾中的工作行又会被上面当成「已开工」。明确被拒 = 没有执行，等空闲后只再提交一次。
    if (isCodexCliKind(kind) && /^\s*\//.test(String(prompt || ''))
        && await codexRejectedBusyCommand(livePtyObserver, codexBusyBaseline)) {
      if (!options.retriedAfterBusyReject) {
        console.warn(`[group-chat] codex(${sid.slice(0, 8)}) rejected a slash command while its previous task was still finishing; submitting once more after it settles`);
        await waitCodexSettled(livePtyObserver);
        return await sendToPtyImpl(sid, prompt, kind, { ...options, retriedAfterBusyReject: true, workspaceRulesPrepared: true });
      }
      return { ok: false, notSent: true, sendStatus: 'rejected', error: 'cli-busy-rejected', enterAttempts, acknowledgementSource: null,
        message: 'Codex 仍在处理上一轮，命令被拒绝、没有执行；请稍后再发' };
    }
    return {
      ok: sendStatus !== 'content-mismatch',
      sendStatus,
      ...(usedCodexEditorInput ? { mode: 'codex-editor' } : {}),
      acknowledgementSource: acknowledgement && acknowledgement.source || null,
      acknowledgementObservedAt: acknowledgement && acknowledgement.observedAt || null,
      acknowledgementTurnId: acknowledgement && acknowledgement.turnId || null,
      enterAttempts,
      ...(_deps && _deps.enableSendDiagnostics ? {
        probeDiagnostics: {
          lastLiveRuntime: probeState && probeState.lastLiveRuntime || null,
          lastLiveLines: probeState && probeState.lastLiveLines || null,
          lastRingRuntime: probeState && probeState.lastRingRuntime || null,
          lastRingTail: probeState && probeState.lastRingTail || null,
        },
      } : {}),
    };
    } finally {
      // PTY writes and transcript readers are external boundaries. Any throw
      // along the path must still release the semantic acknowledgement hook.
      if (turnStart) turnStart.dispose();
      if (livePtyObserver) livePtyObserver.dispose();
    }
  }
  // ===========================================================================

  // bug A 修复：发 prompt 前等 PTY 静默（不依赖 cold-start 路径）。
  //   语义层信号（stop_hook/stop_reason）触发 ≠ 设备层 PTY 静止；前者是
  //   "Claude 答完最后一个字"，后者是"终端扩音器关掉"。
  {
    const startQuiet = Date.now();
    let lastSeenPre = sessionManager.getGroupChatLastActivity(sid);
    let lastChangePre = Date.now();
    while (Date.now() - startQuiet < PRE_PROMPT_MAX_WAIT_MS) {
      await new Promise(r => setTimeout(r, FAST_PATH_POLL_MS));
      const cur = sessionManager.getGroupChatLastActivity(sid);
      if (cur !== lastSeenPre) {
        lastSeenPre = cur;
        lastChangePre = Date.now();
      }
      if (Date.now() - lastChangePre >= PRE_PROMPT_QUIET_MS) break;
    }
    const totalWait = Date.now() - startQuiet;
    if (totalWait >= PRE_PROMPT_MAX_WAIT_MS) {
      console.warn(`[group-chat] pre-prompt PTY never quiet for ${kind}(${sid.slice(0,8)}); proceeded after ${totalWait}ms ceiling`);
    }
  }

  // 第 1 次 write：仅 prompt（不带 '\r'）
  const beforeWrite = sessionManager.getGroupChatLastActivity(sid);
  await clearCodexInputLine(sessionManager, sid, kind);
  const actualPrompt = await writePromptToSession(sessionManager, sid, prompt, kind);
  noteSubmittedPrompt(sid, kind, actualPrompt);

  // 自适应安静期等待：每 50ms 检查 lastActivity，
  //   连续 250ms 无变化 → CLI paste-detect timer 已 fire，安全发 Enter
  //   一直在抖动 → 等到 MAX，仍发 \r（best effort，与老 300ms 行为同等保守）
  const startWait = Date.now();
  let lastSeen = beforeWrite;
  let lastChange = Date.now();
  while (Date.now() - startWait < FAST_PATH_MAX_WAIT_MS) {
    await new Promise(r => setTimeout(r, FAST_PATH_POLL_MS));
    const cur = sessionManager.getGroupChatLastActivity(sid);
    if (cur !== lastSeen) {
      lastSeen = cur;
      lastChange = Date.now();
    }
    if (Date.now() - lastChange >= FAST_PATH_QUIET_MS) break;
  }

  // 关键修复（2026-05-02 血泪教训第 N 次）：prompt 字符已经在 PTY stdin 里，
  //   **`\r` 必须发出去**。旧逻辑在零 echo 时直接 return false 不发 \r，导致用户的
  //   prompt 卡在 CLI 输入框需要手按 Enter — 这是用户反复反馈的核心 bug。
  //
  // 为什么 \r 多发是安全的（与"prompt 不能重发"对比）：
  //   - prompt 重发 → 输入框出现 prompt+prompt → 提交后内容污染（旧注释正确警告了这点）
  //   - \r 多发    → 输入框有 prompt 时首个 \r 触发提交，后续 \r 落入空输入框被
  //                  CLI 忽略（PowerShell 也只是显示空提示符）；不污染 prompt 内容
  //
  // 决策：echo 正常 → 发 1 次 \r；零 echo → 发 3 次 \r（间隔 150ms），让 paste-end
  //   状态机被卡在 throbbing/工具调用中的 CLI 也能"看见" Enter。
  const echoSeen = lastSeen !== beforeWrite;
  if (isCodexCliKind(kind)) {
    await writeSubmitFallbackSignals(sessionManager, sid, kind, ENTER_RETRY_TRIES, ENTER_RETRY_GAP_MS);
  } else if (echoSeen) {
    writeSubmitSignal(sessionManager, sid, kind, 0);
  } else {
    console.warn(`[group-chat] zero-echo for ${kind}(${sid.slice(0, 8)}) — sending ${ENTER_RETRY_TRIES} submit fallback signals (prompt already in PTY stdin, MUST commit)`);
    for (let i = 0; i < ENTER_RETRY_TRIES; i++) {
      writeSubmitSignal(sessionManager, sid, kind, i);
      if (i < ENTER_RETRY_TRIES - 1) {
        await new Promise(r => setTimeout(r, ENTER_RETRY_GAP_MS));
      }
    }
    // ready 重置：下轮走冷启动重新 align（本轮 prompt 已经尽力提交了）
    sessionManager.setGroupChatReady(sid, false);
  }

  // 提交后活性二次确认：再等 500ms 看 PTY 有无新输出。
  //   有 → 正常被 CLI 接住；无 → 标记 suspect（仅日志，不阻塞 turn-completion-watcher）。
  //   不在这里 return false：prompt 已发，应让 watcher 走完整流程（含 host-shell 心跳兜底）。
  await new Promise(r => setTimeout(r, POST_ENTER_VERIFY_MS));
  const afterEnter = sessionManager.getGroupChatLastActivity(sid);
  let sendStatus = 'ok';
  if (afterEnter === lastSeen) {
    console.warn(`[group-chat] post-Enter still zero-echo for ${kind}(${sid.slice(0, 8)}) — trying _autoRecoverSend`);
    const recovered = await _autoRecoverSend({
      sid, kind, prompt, echoSeen,
      timing: { ENTER_RETRY_GAP_MS, POST_ENTER_VERIFY_MS },
    });
    if (recovered) {
      console.log(`[group-chat] _autoRecoverSend recovered ${kind}(${sid.slice(0, 8)}) mode=${echoSeen ? 'enter_only' : 'rewrite_full'}`);
      sendStatus = 'auto_recovered';
    } else {
      console.warn(`[group-chat] _autoRecoverSend failed for ${kind}(${sid.slice(0, 8)}); upgrading to send_stuck`);
      sendStatus = 'stuck';
    }
  }
  return { ok: true, sendStatus };  // 兼容老调用方（boolean truthy）
}

// ---------------------------------------------------------------------------
// extractStreamingText — Card optimization Task 5+6+12（2026-05-01）
//   流式预览净化（方案 C：tap 优先 + placeholder 兜底）。
//   v1（T5/T6）：tap 没数据时退到 PTY ringBuffer + ANSI 剥离 + 行级黑名单。
//   v2（fix）：用户多方审查反馈——PTY 流式期本质不可信（Claude TUI throbbing
//             "thinking with xhigh effort"/"Waddling..." 装饰行 + Codex prompt echo
//             残片 "W/Wo/or" 都进过 preview）。三家审查（Gemini/Codex/DeepSeek V4-pro）
//             一致推荐方案 C：放弃 PTY 兜底，没 tap 数据就显示空 + renderer 端"💭 思考中…"
//             占位，承认 streaming 阶段 PTY 内容不可信。
//   返回 { source: 'tap'|'placeholder', blocks: Array<Block>, text: string }
//   kind 参数保留为 API 稳定性（未使用）。
function extractStreamingText(sid, _kind) {
  const native = (_deps.sessionManager.getNativeSession?.(sid) || _deps.sessionManager.getNativeCodex?.(sid));
  if (native) {
    const blocks = native.blocks();
    return {source:native.isCliProvider ? 'provider-cli' : native.options?.kind && require('./acp-profiles').isAcpKind(native.options.kind) ? 'acp' : 'codex-app-server',blocks,text:blocks.map(b=>b.text).join('').slice(-500)};
  }
  const { transcriptTap } = _deps;
  const nativeClaude = _deps.sessionManager?.getNativeClaude?.(sid);
  if (nativeClaude) {
    const record = nativeClaude.active;
    const answer = record && nativeClaude.transcript().find(item => item.id === record.userMessageId + ':assistant');
    const text = answer?.text || '';
    return { source: 'claude-stream-json', text, blocks: text ? [{ type: 'text', text }] : [] };
  }
  const tapBlocks = transcriptTap.getStreamingText(sid);
  if (Array.isArray(tapBlocks) && tapBlocks.length > 0) {
    const text = tapBlocks
      .filter(b => b.type === 'text' && typeof b.text === 'string')
      .map(b => b.text)
      .join('')
      .slice(-500);
    return { source: 'tap', blocks: tapBlocks, text };
  }

  // 没有结构化 tap 数据（Claude streaming 期 Stop hook 未触发 / Codex spike FAIL 永远走兜底）
  //   → 返回空，renderer 显示"💭 思考中…"占位。**不再回退 PTY ringBuffer。**
  return { source: 'placeholder', blocks: [], text: '' };
}

// ---------------------------------------------------------------------------
// cleanBufLen — 心跳指示器 - PTY buffer 剥 ANSI/spinner 后的"可读字符数"
//   用途：streaming 期间推 partial.cleanBufLen，卡片显示"已输出约 N 字"心跳
//   精度：含 CLI 自身状态条文案（"Computing..." "Brewed for 1m"），是活跃度近似值
function cleanBufLen(buf) {
  if (!buf) return 0;
  const cleaned = String(buf)
    .replace(/\[[0-9;?]*[A-Za-z]/g, '')   // ANSI CSI
    .replace(/\][^]*/g, '')   // OSC
    .replace(/[()][\w]/g, '')              // charset
    .replace(/[\b\r]/g, '')                       // backspace + CR
    .replace(/[✻✶✽✢●·*⏺⠁⠂⠄⠈⠐⠠⡀⢀]/g, '');     // spinner symbols
  return cleaned.length;
}

// ---------------------------------------------------------------------------
// _autoRecoverSend — sendToPty verify 失败时的单次自动恢复（2026-05-03）
// 决策依据：echoSeen 物理标志位（不依赖任何字符串匹配/魔数）
//   echoSeen=true  → prompt 已在输入框，仅 \r 没生效 → 补 1x \r
//   echoSeen=false → prompt 完全未进 PTY        → 重写 prompt + 1x \r
// 返回 true=verify 通过；false=仍未恢复，调用方应升级 send_stuck。
async function _autoRecoverSend({ sid, kind, prompt, echoSeen, timing }) {
  const { sessionManager } = _deps;
  const before = sessionManager.getGroupChatLastActivity(sid);
  if (echoSeen) {
    writeSubmitSignal(sessionManager, sid, kind, 1);
  } else {
    await clearCodexInputLine(sessionManager, sid, kind);
    const actualPrompt = await writePromptToSession(sessionManager, sid, prompt, kind);
    noteSubmittedPrompt(sid, kind, actualPrompt);
    await new Promise(r => setTimeout(r, (timing && timing.ENTER_RETRY_GAP_MS) || 150));
    writeSubmitSignal(sessionManager, sid, kind, 1);
  }
  await new Promise(r => setTimeout(r, (timing && timing.POST_ENTER_VERIFY_MS) || 500));
  const after = sessionManager.getGroupChatLastActivity(sid);
  // void kind: 保留参数名以便日志使用
  void kind;
  return after !== before;
}

// ---------------------------------------------------------------------------
// resendCurrentPrompt — 手动 [📤 发送] 按钮的后端入口（2026-05-03）
// 与 _autoRecoverSend 不同的是：手动按钮 caller 没有 dispatchPromptToSub 当时的
// echoSeen 上下文（dispatch 已经结束很久了），所以用 ring-buffer 末尾 grep prompt
// 第一行（promptHeader 指纹）来判定输入框是否还含 prompt。
// 返回 { ok, mode, reason? }，mode ∈ 'enter_only' | 'rewrite_full'。
function inspectPromptSubmissionState({ sid, kind, promptHeader }) {
  const { sessionManager } = _deps;
  kind = resolveRuntimeKind(sessionManager, sid, kind);
  const buf = String(sessionManager.getSessionBuffer(sid) || '');
  const tail = buf.slice(-2048);
  const visible = stripAnsi(tail).replace(/\r/g, '\n');
  const lines = visible.split('\n').slice(-80);
  const collapsedPaste = /\[(?:Pasted (?:Content|text)[^\]]*)\]/i.test(lines.slice(-12).join('\n'));
  const headerVisible = !!(promptHeader && lines.slice(-12).join('\n').includes(promptHeader));
  if (headerVisible) return { state: 'input_pending', evidence: 'prompt_header_visible' };
  // Ring history is append-only: a collapsed marker can remain after a prompt
  // was successfully submitted. Treat it as diagnostic evidence only; the
  // live paste-trapped monitor owns bounded Enter recovery for that marker.
  if (collapsedPaste) return { state: 'possible_input_pending', evidence: 'collapsed_paste_marker' };
  const runtime = classifyTerminalRuntime(kind, lines);
  if (runtime.state === RUNTIME_RUNNING) {
    return { state: 'running_clear', evidence: runtime.reason || 'provider_running' };
  }
  if (runtime.state === 'idle') return { state: 'input_clear_idle', evidence: runtime.reason || 'provider_idle' };
  return { state: 'unknown', evidence: runtime.reason || 'ambiguous_screen' };
}

async function resendCurrentPrompt({ sid, kind, prompt, promptHeader, timing, allowRewrite = true, submissionReceipt }) {
  const native = (_deps.sessionManager.getNativeSession?.(sid) || _deps.sessionManager.getNativeCodex?.(sid));
  if (native) {
    await native.reconcile();
    return {ok:false,mode:'none',reason:'native-resend-requires-review',
      message:'已核对 Codex 原生状态；不会自动重发结果不明的消息，请检查当前轮次。'};
  }
  const { sessionManager } = _deps;
  if (sessionManager.getNativeClaude?.(sid)
      || sessionManager.getSession?.(sid)?.runtimeBackend === 'claude-stream-json') {
    return { ok: false, mode: 'none', reason: 'native-reconciliation-required' };
  }
  kind = resolveRuntimeKind(sessionManager, sid, kind);
  if (!prompt) return { ok: false, reason: 'no_prompt' };
  if (submissionReceipt) {
    if (submissionReceipt.status === 'content-mismatch') return { ok: false, mode: 'none', reason: 'content-mismatch' };
    if (submissionReceipt.started) return { ok: true, mode: 'already-submitted' };
    const live = createLivePtyRuntimeObserver(sessionManager, sid, kind);
    const probe = { baselineLength: 0, liveCandidate: null, ringCandidate: null };
    try {
      if (!live) return { ok: false, mode: 'none', reason: 'input-state-unavailable' };
      await live.probe(probe);
      if (submissionReceipt.status === 'content-mismatch') return { ok: false, mode: 'none', reason: 'content-mismatch' };
      if (submissionReceipt.started) return { ok: true, mode: 'already-submitted' };
      const promptLine = hasPromptInInputLine(probe.lastLiveScreen || probe.lastLiveLines, prompt);
      // Rewriting an uncertain input can duplicate a submitted message or
      // append another copy in Claude. Only recover a visible pending input.
      // A collapsed marker hides the text; matching its size alone cannot
      // distinguish another draft. Leave ambiguous/multiline input to the user.
      if (!promptLine) {
        return { ok: false, mode: 'none', reason: 'input-state-unconfirmed' };
      }
      sessionManager.writeToSession(sid, '\r');
      const ackMs = Math.max(20, Number(_deps.agentTurnStartRecoveryMs) || 6000);
      await waitForAgentWorkStart(submissionReceipt, sessionManager, sid, kind, ackMs, probe, live);
      return { ok: submissionReceipt.started, mode: 'enter_only',
        ...(submissionReceipt.started ? {} : { reason: submissionReceipt.status === 'content-mismatch'
          ? 'content-mismatch' : 'unconfirmed' }) };
    } finally { live?.dispose(); }
  }
  const buf = sessionManager.getSessionBuffer(sid) || '';
  // 仅取最近 ~1024 字符（约一屏 PTY 输出，覆盖 CLI 输入框；
  //   太大会包含上一轮 Claude 回答里复述的 promptHeader → 误判 enter_only 发空 \r）
  const tail = buf.slice(-1024);
  const inInputBox = !!(promptHeader && promptHeader.length > 0 && tail.includes(promptHeader));

  const before = sessionManager.getGroupChatLastActivity(sid);
  let mode;
  const submitTries = isCodexCliKind(kind) ? 3 : 1;
  const rewriteSettleMs = isCodexCliKind(kind) ? 500 : ((timing && timing.ENTER_RETRY_GAP_MS) || 150);
  if (inInputBox) {
    mode = 'enter_only';
    await writeSubmitFallbackSignals(sessionManager, sid, kind, submitTries, (timing && timing.ENTER_RETRY_GAP_MS) || 150);
  } else {
    if (!allowRewrite) return { ok: false, mode: 'none', reason: 'rewrite_not_authorized' };
    mode = 'rewrite_full';
    await clearCodexInputLine(sessionManager, sid, kind);
    if (isClaudeFamily(kind) || isCodexCliKind(kind)) {
      // 2026-09-03：这条以前走 writePromptToSession —— 对 Claude 就是"裸写整段 +
      //   150ms + \r"，正是本次要修掉的那套开环时序。补发是这个 bug 的**恢复路径**，
      //   它自己再踩一次同一个坑就毫无意义，所以改走与主路径同一套分块 + 自适应 settle。
      const baselineMarker = snapshotPasteMarker(sessionManager, sid);
      await writeBracketedPaste(sessionManager, sid, prompt, { inlinePieces: isClaudeFamily(kind) });
      require('./codex-pty-input').flushCodexPasteInput(sessionManager,sid,kind,prompt);
      noteSubmittedPrompt(sid, kind, prompt);
      await waitForPasteSettled({
        sessionManager,
        sid,
        settleMs: computeSettleMs(String(prompt || '').length),
        baselineMarker,
      });
    } else {
      const actualPrompt = await writePromptToSession(sessionManager, sid, prompt, kind);
      noteSubmittedPrompt(sid, kind, actualPrompt);
      await new Promise(r => setTimeout(r, rewriteSettleMs));
    }
    await writeSubmitFallbackSignals(sessionManager, sid, kind, submitTries, (timing && timing.ENTER_RETRY_GAP_MS) || 150);
  }
  await new Promise(r => setTimeout(r, isCodexCliKind(kind) ? 1500 : ((timing && timing.POST_ENTER_VERIFY_MS) || 500)));
  const after = sessionManager.getGroupChatLastActivity(sid);
  const verified = after !== before;
  void kind;
  return { ok: verified, mode, ...(verified ? {} : { reason: 'verify_failed' }) };
}

// ---------------------------------------------------------------------------
// checkHostShellTakeover — host-shell prompt 心跳检测
//   FIX-D（2026-05-01）：CLI 自我退出（Codex 自动更新 / Gemini OAuth 异常 /
//     Claude 内部 panic 等）后 PTY 控制权回到宿主 shell（PowerShell / bash），但 PTY 进程
//     本身没退，markProcessExit 不会触发。watcher 因此只能等 5min 硬 timeout。
//   解决：每 10s 检查 PTY ring buffer 末尾是否回到宿主 shell prompt，连续 2 次命中视为
//     CLI 已死，立即 markProcessExit。核心检测函数已抽到 core/host-shell-detector.js
//     方便单测。
function checkHostShellTakeover(sid) {
  if (_deps.sessionManager.getNativeClaude?.(sid)) return false;
  const { sessionManager } = _deps;
  return detectHostShellTakeover(sessionManager.getSessionBuffer(sid));
}

module.exports = {
  init,
  waitCliReady,
  sendToPty,
  extractStreamingText,
  cleanBufLen,
  checkHostShellTakeover,
  _private: { writePromptToSession, writeSubmitSignal, clearCodexInputLine },
  _autoRecoverSend,           // 新增（测试 + 同模块调用）
  inspectPromptSubmissionState,
  resendCurrentPrompt,         // 新增（main.js IPC handler 调用）
};
