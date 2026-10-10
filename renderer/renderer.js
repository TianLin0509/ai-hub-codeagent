// webUtils.getPathForFile 是 Electron 32+ 取代 File.path 的唯一入口（41 里 File.path
// 已经是 undefined）。粘贴剪贴板文件要靠它拿绝对路径。
const { ipcRenderer, clipboard, nativeImage, shell, webFrame, webUtils } = require('electron');
// Isolated E2E only: keep test copies/pastes off the user's system clipboard.
if (process.env.CLAUDE_HUB_E2E_FAKE_CLIPBOARD_ACTIVE === '1') {
  require('./e2e-fake-clipboard.js').installRendererFakeClipboard({ electron: require('electron'), navigator });
}
const fs = require('fs');
const { isCodexSession, isNativeSession, acceptNativeSnapshot } = require('../core/codex-native-runtime.js');
const { isNativeAgent } = require('../core/native-agent-runtime.js');
const { isPtyAgentSession } = require('../core/agent-runtime-mode.js');
// 草稿写进 Main 的草稿库：原生会话和 PTY 的 Claude/Codex 会话都算（同一个 Hub 会话 id）。
const hasDurableDraft = session => isNativeAgent(session) || isPtyAgentSession(session);
const { recordNativeContent, promptReceipt } = require('../core/native-feedback.js');
const { createCodexNativeControls } = require('./codex-native-controls.js');
const pasteChips = require('./composer-paste-chips.js');
const { createCodexBackstage } = require('./codex-backstage.js');
const path = require('path');
const { isClaudeFamily, isAiKind, isPasteSensitive, isCodexSessionKind: isCodexKind, isKimiCliKind } = require('../core/ai-kinds.js');
const {
  buildSessionResumeMeta,
  sessionModelId,
  supportsForkSession,
  supportsRecoverableSession,
} = require('../core/session-capabilities.js');
const {
  buildComposerRailModel,
  buildComposerStatusModel,
} = require('../core/session-status-summary.js');
const {
  formatAbsoluteTime,
  formatBeijingMonthDay,
} = require('./format-time.js');
const { marked } = require('marked');
const DOMPurify = require('dompurify');
const { fileURLToPath } = require('url');
const { extractVisibleCardText } = require('./visible-card-text.js');
const { applyCardDisplaySettings } = require('./card-display-settings.js');
const {
  GC_WORKING_FRESH_MS,
  isGroupChatMemberRunning,
} = require('../core/groupchat-running-state.js');
const { acceptGroupChatEvent } = require('./groupchat-event-revision.js');
const applyHubCardDisplaySettings = (config) => applyCardDisplaySettings(document, config);
applyHubCardDisplaySettings();
ipcRenderer.invoke('get-hub-config-raw')
  .then(applyHubCardDisplaySettings)
  .catch(() => {});
// ── Bug 修复（2026-06-21 maintainer）：marked 默认透传裸 HTML，AI/用户消息正文里的字面
//    <script>/<style>/未闭合 <tag>（含数学 a<b、泛型 List<String>）会被浏览器 HTML
//    解析器当成元素、把后续内容当作其文本吞掉，再被 DOMPurify 整段删除 → 消息正文
//    静默截断/丢失（群聊真实消息 u4 实测 615 字只剩 152 字，丢 75%）。
//    这里把裸 HTML token 统一转义为可见文本：代码块/粗体/链接/列表等正常 markdown 不受
//    影响，DOMPurify 仍作安全兜底。marked 单例被群聊(meeting-room)、会话卡片
//    (turn-card-renderer)、文件预览共用，一处配置即全覆盖。已用真实 marked+DOMPurify
//    管线做 before/after 实测（tools/_gc_render_test）：修复后内容零丢失。
marked.use({
  renderer: {
    html(token) {
      const raw = typeof token === 'string' ? token : (token && (token.text ?? token.raw)) || '';
      return String(raw)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    },
  },
});
const { installScrollDebug } = require('./scroll-debug.js');
const { createMemoPanel } = require('./memo-panel.js');
const { installSessionFirstNavigation } = require('./session-first-navigation.js');
installSessionFirstNavigation();
require('./coldwhite-shell.js').installColdwhiteShell();
const { createTerminalSearch } = require('./terminal-search.js');
const { mountTerminalPresentation } = require('./terminal-presentation.js');
const {
  createSessionContextMenuController,
  createTerminalContextMenuController,
  supportsRecoverableSessionKind,
} = require('./context-menus.js');
const { createPathLinkContextMenuController } = require('./path-link-context-menu.js');
const { createCardSelectionContextMenuController } = require('./card-selection-context-menu.js');
// 中转工具不随社区版发行；保留同一接口，状态提示改走普通 toast。
const createChatgptBridgeController = () => ({
  init() {},
  pushText: async () => ({ ok: false }),
  pullForInput: async () => false,
  showStatus: (message, tone) => showToast(message, tone),
});
const { resolveXtermOptions, createThemeController } = require('./theme-controller.js');
const {
  forgetViewMode,
  readCardViewSessions,
  rememberViewMode,
  selectionViewModeFor,
  writeCardViewSessions,
} = require('../core/session-view-mode.js');
const {
  createTerminalInputController,
  formatPastedFilePaths,
  isTerminalProtocolReply,
  isCodexOwnedTranscript,
  navigateCodexTranscript,
} = require('./terminal-input-controller.js');
const { createAccountUsageController } = require('./account-usage-controller.js');
const { createMemoryPanel } = require('./memory-panel.js');
const { createCapabilityPanel } = require('./capability-panel.js');
const { createFileManagerPanel } = require('./file-manager-panel.js');
const { modelClass, modelShort, createModelUiController } = require('./model-ui.js');
const { speedControl } = require('../core/session-speed.js');
const { describeCodexModelTuning } = require('../core/codex-model-catalog.js');
const { createTerminalLinkRegistrar } = require('./terminal-link-provider.js');
const { createPreviewPanelController } = require('./preview-panel-controller.js');
const { createClipboardController } = require('./clipboard-controller.js');
const { createSessionReadyNotifier } = require('./session-ready-notifier.js');
const { createTerminalActivityMonitor } = require('./terminal-activity-monitor.js');
const { deriveSessionRuntimeStatus } = require('./session-runtime-status.js');
const { isTurnComplete, normalizeToolActivity } = require('../core/turn-presentation.js');
const {
  advanceRunningAnimationCandidate,
  classifyTerminalRuntime,
} = require('../core/terminal-runtime-state.js');
const {
  appendStreamDisconnectChunk,
  detectStreamDisconnect,
  markStreamDisconnectAcknowledged,
  shouldRaiseStreamDisconnect,
} = require('../core/stream-disconnect.js');
const { createPastSessionModals, collapseDormantNativeDuplicates } = require('./past-session-modals.js');
const { createKeyboardShortcuts } = require('./keyboard-shortcuts.js');
const { createShellController } = require('./shell-controller.js');
const { createHomeWorkbench } = require('./home-workbench.js');
const { createRenderCoalescer } = require('./render-coalescer.js');
const { createLaunchCenterController } = require('./launch-center-controller.js');
const {
  applyPromptSubmitted,
  applyReplyCompleted,
  applyTurnAborted,
  clearSessionAttention,
  clearSessionCompletedUnread,
  markSessionNeedsUserInput,
  normalizeEventTime,
  sessionNeedsUserInput,
} = require('../core/session-attention-state.js');
const {
  RUNTIME_STARTING,
  RUNTIME_RUNNING,
  RUNTIME_WAITING,
  RUNTIME_COMPLETED,
  RUNTIME_IDLE,
  RUNTIME_FAILED,
  RUNTIME_DORMANT,
  RUNTIME_UNKNOWN,
  CONFIDENCE_AUTHORITATIVE,
  CONFIDENCE_STRONG,
  CONFIDENCE_SEMANTIC,
  CONFIDENCE_FALLBACK,
  CONFIDENCE_INFERRED,
  CONFIDENCE_NONE,
  applySessionRuntimeObservation,
  getSessionRuntimeTruth,
  runtimeTruthSummary,
  sessionRuntimeIsActive,
} = require('../core/session-runtime-truth.js');
const {
  PREVIEW_PATH_RE,
  HUB_IMG_PATH_RE,
  collectPathCandidates,
  classifyLocalPathHref,
  _cleanPathCandidate,
  _normalizeLocalPathForOpen,
  _isDirectoryPathAsync,
  onNetworkPathResolved,
} = require('./path-candidates.js');
// Elements that mentioned a share path not known yet. Re-wrapping only adds
// links to text that is still plain; existing links are skipped.
const _networkPendingWraps = new Map();
const { isCodexConversationModelId, modelOptionsFor } = require('../core/model-options.js');
const {
  isStableSessionTitle,
  migrateLegacyBranchSessionMeta,
  normalizeLegacyBranchSessionTitle,
  shouldAcceptExternalSessionTitle,
} = require('../core/session-title-guards.js');
const RENDER_STARTUP_TRACE = process.env.HUB_STARTUP_TRACE === '1';
const RENDER_STARTUP_T0 = performance.now();
function traceRendererStartup(msg) {
  if (!RENDER_STARTUP_TRACE) return;
  console.log(`[renderer-startup +${Math.round(performance.now() - RENDER_STARTUP_T0)}ms] ${msg}`);
}
traceRendererStartup('renderer.js start');
const { Terminal } = require('@xterm/xterm');

// DEBUG ONLY. Toggle in DevTools: __scrollDebug.on() / .off().
installScrollDebug(window, __dirname);

const { FitAddon } = require('@xterm/addon-fit');
const { Unicode11Addon } = require('@xterm/addon-unicode11');
const { SearchAddon } = require('@xterm/addon-search');
const { WebglAddon } = require('@xterm/addon-webgl');
const { CanvasAddon } = require('@xterm/addon-canvas');

// --- Shared transcript patterns ---
// Claude Code's user-input prompt line, e.g. "❯ text", "│ ❯ text │", or "> text".
// Includes ASCII '>' because Claude Code v2.1.119 switched the prompt prefix
// from '❯' to plain '>'. Trade-off: assistant markdown blockquotes ("> ...")
// also match — accepted as a known false-positive (rare in practice; AI_MARKERS_RE
// filters reply lines that contain progress glyphs).
const PROMPT_LINE_RE = /^[\s│╭─╮╰╯]*[❯›>]\s+(.+?)(?:\s*[│╯╰╭╮]+\s*)?$/;
// Just the prompt prefix — no capture group. Used when we only need to skip
// prompt lines rather than parse them.
const PROMPT_PREFIX_RE = /^[\s│╭─╮╰╯]*[❯›>]\s+/;
// Emoji Claude Code uses at the start of an AI-reply block. A safety net: if
// we ever mis-match a user prompt line, this filters out lines that are
// clearly assistant output.
const AI_MARKERS_RE = /[⏺●◉◐◑◒◓◔◕]/;
// --- State ---
const sessions = new Map();
const nativeSessionBootstrap = require('./native-session-bootstrap').createNativeSessionBootstrap();
const _runtimeTruthExpiryTimers = new Map();
let activeSessionId = null;
let sessionSplit = null;
function getFocusedSessionId() { return sessionSplit?.focusedId() || activeSessionId; }
let completionNotificationToggle = null;
let systemResourceUsage = null;
let homeWorkbench = null;
let fileManagerPanel = null;
// 侧栏常驻显示海外代理 + 国产直连的真实公网出口。
// proxy 仍保留配置值，egress 由 main 进程强制分别经代理/直连探测。
let hubProxyInfo = null;
// 2026-05-24 maintainer：DeepSeek 自动命名启用标志。启用时让 DeepSeek 中文标题独占 Claude family
//   session，OSC title（"Greeting in Chinese" 这种 Claude 自带英文摘要）仅作影子记录、不落地。
//   在启动 get-hub-config-raw 回调里根据 cfg.deepseekApiKey 设置。
let _deepseekAutoTitleEnabled = false;
let _cardHistoryHydratedSid = null; // 已完成全量历史卡片加载的 sessionId
const cardHistoryViews = require('./card-history-views').createCardHistoryViews({
  document, getTurns: () => window._sessionTurns,
  setTurns: turns => { window._sessionTurns = turns; },
  clearSignatures: () => turnCardRenderer.clearTurnRenderSignatures(),
});
const _turnCompleteBackfillTimers = new Map(); // sid -> Promise; in-flight guard 防止并发 backfill (2026-05-24 maintainer：原 timer-debounce 改为立即 trigger)
const terminalCache = new Map();
const clipboardController = createClipboardController({ document, window, clipboard, expandText: pasteChips.expandPasteMarkers });
clipboardController.init();
// xterms are created lazily, then live for exactly as long as their live Hub
// sessions. Switching sessions must not dispose a still-running CLI: doing so
// turns ordinary navigation into a snapshot-replay path and can lose the
// authoritative full-screen TUI frame. Dormant/closed sessions already call
// disposeCachedTerminal, so automatic suspend remains the resource boundary.
const TERMINAL_CACHE_POLICY = 'session-lifecycle';
const MAX_PENDING_TERMINAL_BYTES = 64 * 1024;
const terminalInputController = createTerminalInputController({
  document,
  window,
  ipcRenderer,
  clipboard,
  terminalCache,
  webUtils,
});
const handlePasteForSession = terminalInputController.handlePasteForSession;
const attachContenteditablePasteImage = terminalInputController.attachContenteditablePasteImage;
const setupImageHover = terminalInputController.setupImageHover;
const getTerminalCoords = terminalInputController.getTerminalCoords;
const getInputLineSelection = terminalInputController.getInputLineSelection;
const deleteInputSelection = terminalInputController.deleteInputSelection;
const floatingInputDrafts = new Map();
// sessionId -> { raw, text }：含粘贴块标记的原始草稿。重挂输入框时若草稿没变，按原样把块还原回来，
// 而不是把几千行原文重新铺进 DOM。持久化的草稿仍是展开后的原文（标记跨重启无意义）。
const rawComposerDrafts = new Map();
const nativeDraftControllers = new Map();
const CODEX_BOTTOM_LOCK_EPSILON = 24;
const CODEX_SCROLL_INTENT_MS = 1500;
const CODEX_PROGRAMMATIC_SCROLL_SUPPRESS_MS = 120;
const AI_PTY_FALLBACK_ARM_MS = 45 * 60 * 1000;
const AI_PTY_FALLBACK_COOLDOWN_MS = 5 * 1000;
const PTY_RUNTIME_SUBMIT_PENDING_MS = 15 * 1000;
// Codex briefly exposes its persistent prompt/context footer between commentary
// and the next tool call. A single such frame is not proof of completion. Hold
// input-ready for a second current-screen observation before closing a turn.
const PTY_INPUT_READY_STABLE_MS = 2 * 1000;

function isTranscriptCliKind(kind) {
  const base = String(kind || '').replace(/-resume$/i, '').toLowerCase();
  return isCodexKind(kind) || isKimiCliKind(kind) || require('../core/acp-profiles').isAcpKind(kind) || base === 'gemini';
}

function isLegacyDeepSeekSession(session) {
  return !!(session && session.kind === 'deepseek' && session.ccSessionId && !session.codexSid);
}

function isClaudeRuntimeSession(session) {
  return !!(session && (isClaudeFamily(session.kind) || isLegacyDeepSeekSession(session)));
}

function isAiRuntimeSession(session) {
  return !!(session && (
    isAiKind(session.kind)
    || isPasteSensitive(session.kind)
    || isClaudeRuntimeSession(session)
  ));
}

function clearPtyInputReadyCandidate(session) {
  if (!session) return;
  if (session._ptyInputReadyTimer) {
    clearTimeout(session._ptyInputReadyTimer);
    session._ptyInputReadyTimer = null;
  }
  session._ptyInputReadyCandidate = null;
}

function clearPtyRunningAnimationCandidate(session) {
  if (session) session._ptyRunningAnimationCandidate = null;
}

function schedulePtyInputReadyConfirmation(session, candidate, observedAt) {
  if (!session || !candidate || session._ptyInputReadyTimer) return;
  const delay = Math.max(25, candidate.confirmAt - (Number(observedAt) || Date.now()));
  session._ptyInputReadyTimer = setTimeout(() => {
    session._ptyInputReadyTimer = null;
    const latest = sessions.get(session.id);
    if (!latest || latest !== session || latest._ptyInputReadyCandidate !== candidate) return;
    if (typeof terminalActivityMonitor !== 'undefined') {
      terminalActivityMonitor.observeRuntimeState(session.id, Date.now());
    }
  }, delay);
}

function ptyInputReadyIsStable(session, runtime, observedAt) {
  const at = Number(observedAt) || Date.now();
  const outputAt = Number(session && session._lastOutputTs) || 0;
  const key = `${runtime.reason || 'idle'}\n${runtime.evidence || ''}`;
  let candidate = session._ptyInputReadyCandidate;
  if (!candidate || candidate.key !== key || candidate.outputAt !== outputAt) {
    clearPtyInputReadyCandidate(session);
    candidate = {
      key,
      outputAt,
      firstObservedAt: at,
      confirmAt: at + PTY_INPUT_READY_STABLE_MS,
    };
    session._ptyInputReadyCandidate = candidate;
    schedulePtyInputReadyConfirmation(session, candidate, at);
    return false;
  }
  if (at < candidate.confirmAt) {
    schedulePtyInputReadyConfirmation(session, candidate, at);
    return false;
  }
  clearPtyInputReadyCandidate(session);
  return true;
}

// PTY bytes are a last-resort running signal for AI CLIs. Arm that fallback
// only when Hub has evidence that the user really submitted a prompt; idle TUI
// animations and layout repaints otherwise cannot move a session to 运行中.
function armPtyBurstFallback(sessionId, submittedAt = Date.now()) {
  if (isNativeSession(sessions.get(sessionId))) return;
  const session = sessions.get(sessionId);
  if (session?.runtimeBackend === 'claude-stream-json') return;
  if (!isAiRuntimeSession(session)) return;
  const at = Number(submittedAt) || Date.now();
  session._ptyFallbackArmedAt = at;
  session._ptyFallbackArmedUntil = at + AI_PTY_FALLBACK_ARM_MS;
  session._ptyBurstCooldownUntil = 0;
  session._ptyRuntimeSawRunning = false;
  session._ptyRuntimeState = null;
  session._ptyRuntimeReason = null;
  session._ptyRuntimeEvidence = null;
  clearPtyInputReadyCandidate(session);
  clearPtyRunningAnimationCandidate(session);
  if (session._ptyRuntimePendingTimer) clearTimeout(session._ptyRuntimePendingTimer);
  session._ptyRuntimePendingTimer = setTimeout(() => {
    session._ptyRuntimePendingTimer = null;
    const latest = sessions.get(sessionId);
    if (!latest || latest !== session || latest.status !== 'running' || latest._ptyRuntimeSawRunning) return;
    if (typeof terminalActivityMonitor !== 'undefined') {
      terminalActivityMonitor.observeRuntimeState(sessionId, Date.now());
    }
  }, PTY_RUNTIME_SUBMIT_PENDING_MS);
}

function disarmPtyBurstFallback(sessionOrId, settledAt = Date.now()) {
  const session = typeof sessionOrId === 'string' ? sessions.get(sessionOrId) : sessionOrId;
  if (!isAiRuntimeSession(session)) return;
  clearPtyInputReadyCandidate(session);
  clearPtyRunningAnimationCandidate(session);
  // Delayed transcript/hook delivery may carry an older completion timestamp;
  // cooldown starts when Hub actually observes the transition, not in the past.
  const at = Math.max(Number(settledAt) || 0, Date.now());
  if (session._ptyRuntimePendingTimer) {
    clearTimeout(session._ptyRuntimePendingTimer);
    session._ptyRuntimePendingTimer = null;
  }
  session._ptyFallbackArmedUntil = 0;
  session._ptyFallbackArmedAt = 0;
  session._ptyBurstCooldownUntil = at + AI_PTY_FALLBACK_COOLDOWN_MS;
  session._ptyRuntimeSawRunning = false;
  if (session._ptyRuntimeState === 'running') {
    session._ptyRuntimeState = null;
    session._ptyRuntimeReason = null;
    session._ptyRuntimeEvidence = null;
  }
}

function canUsePtyBurstFallback(session, now = Date.now()) {
  if (isNativeSession(session)) return false;
  if (!isAiRuntimeSession(session)) return true;
  const at = Number(now) || Date.now();
  return at >= (Number(session._ptyBurstCooldownUntil) || 0)
    && at <= (Number(session._ptyFallbackArmedUntil) || 0);
}

function trackPtyPromptInput(sessionId, data) {
  const session = sessions.get(sessionId);
  if (isNativeSession(session)) return;
  if (!isAiRuntimeSession(session)) return;
  const chunk = String(data || '');
  const printable = chunk
    .replace(/\x1b(?:\[[0-?]*[ -/]*[@-~]|O.)/g, '')
    .replace(/[\x00-\x1f\x7f]/g, '');
  if (printable.trim()) session._ptyDraftInputSeen = true;
  // Newlines inside a bracketed/multiline paste are draft content, not the
  // user's submit key. xterm emits the actual Enter key as its own CR/LF chunk.
  if (/^(?:\r|\n|\r\n)$/.test(chunk)) {
    if (session._ptyDraftInputSeen) armPtyBurstFallback(sessionId);
    session._ptyDraftInputSeen = false;
  }
}

// 原始内容：粘贴块在这里是 id 标记（见 composer-paste-chips.js）。
function readContenteditableRawText(el) {
  if (!el) return '';
  return typeof el.innerText === 'string' ? el.innerText : (el.textContent || '');
}

// 输入框里「用户真正要发的文字」：粘贴块展开成原文。发送、草稿、历史都读这个。
function readContenteditablePlainText(el) {
  return pasteChips.expandPasteMarkers(readContenteditableRawText(el));
}

// Emptiness only. innerText is layout-dependent, so reading it forces a
// synchronous style+layout pass over the whole window; textContent does not.
// paintComposer runs on every session update and keydown runs per keystroke,
// so these checks used to force layout while cards were streaming.
function contenteditableHasText(el) {
  return !!el && /\S/.test(el.textContent || '');
}

// contenteditable 的撤销栈只认 execCommand / 用户输入这类"编辑动作"。
// 以前发送后直接 `inputBox.textContent = ''`，那是纯 DOM 赋值，浏览器不记账，
// 撤销栈当场清空 —— 按 Ctrl+Z 什么也回不来。误发 / 发完想改的时候只能重打一遍。
// 走 selectAll + insertText/delete 就能让原生 Ctrl+Z / Ctrl+Y 正常工作，
// 不用自己维护一套 undo 栈（自己写的那套还得处理 IME、粘贴、拼写纠正）。
function replaceContenteditableText(el, text) {
  if (!el) return;
  const next = String(text == null ? '' : text);
  let applied = false;
  try {
    el.focus();
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(el);
    selection.removeAllRanges();
    selection.addRange(range);
    // 大文本（历史召回、恢复未发送的长消息）逐行进 DOM 会卡几十秒，收成一个粘贴块。
    if (next && el.dataset.pasteChipsBound === '1' && pasteChips.shouldCollapseReplace(next)) {
      document.execCommand('delete');
      pasteChips.insertPasteChip(el, next, { document, window });
      applied = true;
    } else {
      applied = next
        ? document.execCommand('insertText', false, next)
        : document.execCommand('delete');
    }
  } catch {
    applied = false;
  }
  // 兜底比撤销栈重要得多：清空失败会让下一次回车把同一条消息再发一遍。
  const after = readContenteditablePlainText(el);
  const wrong = next === '' ? after !== '' : after.trim() !== next.trim();
  if (!applied || wrong) el.textContent = next;
}

// 在输入框末尾另起一段追加文字。只追加、不整框替换：已有的粘贴块保持原样（整框替换会先把它们
// 展开成原文再写回），撤销栈也保留。追加的内容本身够长时同样收成粘贴块。
function appendToContenteditable(el, text) {
  const incoming = String(text || '');
  if (!el || !incoming) return;
  const current = readContenteditablePlainText(el);
  const separator = current.trim() ? (current.endsWith('\n') ? '\n' : '\n\n') : '';
  el.focus();
  placeCaretAtContenteditableEnd(el);
  if (el.dataset.pasteChipsBound === '1' && pasteChips.shouldCollapsePaste(incoming)) {
    if (separator) document.execCommand('insertText', false, separator);
    pasteChips.insertPasteChip(el, incoming, { document, window });
    return;
  }
  if (!document.execCommand('insertText', false, separator + incoming)) {
    el.appendChild(document.createTextNode(separator + incoming));
  }
}

function placeCaretAtContenteditableEnd(el) {
  if (!el) return;
  try {
    const range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(false);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  } catch {}
}

// ↑ 是"召回上一条"还是"在多行里上移一行"，取决于光标是不是已经在最开头。
function isCaretAtContenteditableStart(el) {
  if (!el) return true;
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) return true;
  const caret = selection.getRangeAt(0);
  if (!selection.isCollapsed) return false;
  if (!el.contains(caret.startContainer)) return false;
  try {
    const before = document.createRange();
    before.selectNodeContents(el);
    before.setEnd(caret.startContainer, caret.startOffset);
    return before.toString().length === 0;
  } catch {
    return false;
  }
}

function attachNativeDraft(sessionId, inputBox) {
  if (!hasDurableDraft(sessions.get(sessionId))) return null;
  if (inputBox._nativeDraftController) return inputBox._nativeDraftController;
  const view = {
    onRestore(text) {
      restoreComposerText(sessionId, inputBox, text);
      if (text) floatingInputDrafts.set(sessionId, text); else floatingInputDrafts.delete(sessionId);
      if (document.activeElement === inputBox) placeCaretAtContenteditableEnd(inputBox);
    },
    onStatus(error, state) {
      inputBox.dataset.draftState = error ? 'failed' : state.saving ? 'saving' : 'saved';
      let message = inputBox.parentElement?.querySelector('.native-draft-error');
      if (error && !message && inputBox.parentElement) {
        message = document.createElement('div'); message.className = 'native-draft-error'; message.setAttribute('role', 'alert');
        inputBox.parentElement.append(message);
      }
      if (message) {
        message.textContent = error ? '草稿未保存，请先复制保留：' + error.message : '';
        message.hidden = !error;
      }
    },
  };
  let controller = nativeDraftControllers.get(sessionId);
  if (controller) controller.attach(view);
  else {
    controller = require('./native-draft-controller').createNativeDraftController({
      sessionId, initialText: readContenteditablePlainText(inputBox),
      invoke: (channel, request) => ipcRenderer.invoke(channel, request), ...view,
    });
    nativeDraftControllers.set(sessionId, controller);
  }
  inputBox._nativeDraftController = controller;
  return controller;
}

// 把草稿放回输入框。框里已经是这份内容就不动（别把粘贴块冲成原文、也别挪光标）；
// 草稿与上次记下的原始内容一致时按原样还原粘贴块。
function restoreComposerText(sessionId, inputBox, text) {
  if (readContenteditablePlainText(inputBox) === text) return;
  const raw = rawComposerDrafts.get(sessionId);
  // 没有原始记录（例如重启后）且草稿够大时，整段收成一个块，别把几千行铺回 DOM。
  pasteChips.renderComposerValue(inputBox, raw && raw.text === text ? raw.raw : text, { document });
}

function saveFloatingInputDraft(sessionId, inputBox) {
  if (!sessionId || !inputBox) return;
  const raw = readContenteditableRawText(inputBox);
  const text = pasteChips.expandPasteMarkers(raw);
  if (pasteChips.hasPasteMarkers(raw)) rawComposerDrafts.set(sessionId, { raw, text });
  else rawComposerDrafts.delete(sessionId);
  if (text) floatingInputDrafts.set(sessionId, text);
  else floatingInputDrafts.delete(sessionId);
  if (sessions.get(sessionId)?.status === 'dormant') return;
  attachNativeDraft(sessionId, inputBox)?.change(text);
}

function clearFloatingInputDraft(sessionId) {
  if (sessionId) floatingInputDrafts.delete(sessionId);
  if (sessionId) rawComposerDrafts.delete(sessionId);
  nativeDraftControllers.get(sessionId)?.change('');
  if (sessionId && (isNativeSession(sessions.get(sessionId)) || isPtyAgentSession(sessions.get(sessionId)))) {
    try { localStorage.removeItem('codex-native-draft:'+sessionId); }
    catch(error){console.warn('[codex-draft] clear failed:',error.message);}
  }
  if (sessionId) {
    try { localStorage.removeItem('hub.claude-native.draft.v1:' + sessionId); }
    catch (error) { showToast('草稿清理失败：' + error.message, 'error'); }
  }
}

function getTerminalViewport(cached) {
  return cached && cached.container ? cached.container.querySelector('.xterm-viewport') : null;
}

function isTerminalViewportAtBottom(cached, epsilon = CODEX_BOTTOM_LOCK_EPSILON) {
  const vp = getTerminalViewport(cached);
  if (!vp) return true;
  return (vp.scrollHeight - vp.scrollTop - vp.clientHeight) <= epsilon;
}

function shouldAutoPinCodexTerminal(sessionId, cached) {
  const session = sessions.get(sessionId);
  if (!session || !(isNativeAgent(session) || isCodexKind(session.kind)) || !cached || !cached.opened) return false;
  if (!cached.container || !cached.container.offsetWidth) return false;
  if (cached._codexUserScrollIntentUntil && performance.now() < cached._codexUserScrollIntentUntil && cached._codexFollowBottom === false) return false;
  return cached._codexFollowBottom !== false;
}

function pinTerminalViewportToBottom(cached) {
  if (!cached || !cached.terminal) return;
  cached._codexProgrammaticScrollUntil = performance.now() + CODEX_PROGRAMMATIC_SCROLL_SUPPRESS_MS;
  try { cached.terminal.scrollToBottom(); } catch {}
  const vp = getTerminalViewport(cached);
  if (vp) vp.scrollTop = vp.scrollHeight;
}

function scheduleCodexBottomPin(sessionId, cached) {
  if (!shouldAutoPinCodexTerminal(sessionId, cached)) return;
  if (cached._codexBottomPinRaf) return;
  pinTerminalViewportToBottom(cached);
  cached._codexBottomPinRaf = requestAnimationFrame(() => {
    cached._codexBottomPinRaf = 0;
    if (shouldAutoPinCodexTerminal(sessionId, cached)) pinTerminalViewportToBottom(cached);
  });
}

function updateCodexFollowBottomFromUserScroll(sessionId, cached) {
  const session = sessions.get(sessionId);
  if (!session || !(isNativeAgent(session) || isCodexKind(session.kind)) || !cached) return;
  requestAnimationFrame(() => {
    const now = performance.now();
    // This helper is only scheduled from a real wheel gesture. User intent
    // must win even if an automatic pin happened in the preceding 120 ms;
    // otherwise a streaming Codex TUI can keep the suppression window alive
    // and make upward scrolling feel as if it hits an invisible wall.
    if (!cached._codexUserScrollIntentUntil || now > cached._codexUserScrollIntentUntil) return;
    // The compositor may not have applied an upward wheel yet. A stale
    // bottom position must not reattach a reader during snapshot replay.
    cached._codexFollowBottom = cached._codexUserScrollCanAttach !== false && isTerminalViewportAtBottom(cached);
  });
}

function markCodexUserScrollIntent(sessionId, cached, opts = {}) {
  const session = sessions.get(sessionId);
  if (!session || !(isNativeAgent(session) || isCodexKind(session.kind)) || !cached) return;
  cached._codexUserScrollIntentUntil = performance.now() + CODEX_SCROLL_INTENT_MS;
  cached._codexUserScrollCanAttach = opts.detachFromBottom !== true;
  if (opts.detachFromBottom) cached._codexFollowBottom = false;
  if (opts.attachToBottom) cached._codexFollowBottom = true;
}

function setupCodexViewportScrollTracker(sessionId, cached) {
  const session = sessions.get(sessionId);
  if (!session || !(isNativeAgent(session) || isCodexKind(session.kind)) || !cached) return;
  const vp = getTerminalViewport(cached);
  if (!vp || cached._codexTrackedViewport === vp) return;
  if (cached._codexTrackedViewport && cached._codexViewportScrollHandler) {
    try { cached._codexTrackedViewport.removeEventListener('scroll', cached._codexViewportScrollHandler); } catch {}
  }
  cached._codexTrackedViewport = vp;
  cached._codexViewportScrollHandler = () => {
    const now = performance.now();
    if (!cached._codexUserScrollIntentUntil || now > cached._codexUserScrollIntentUntil) return;
    // A pointer-down followed by a viewport scroll is a real scrollbar drag.
    // Do not discard it merely because a streaming write just performed an
    // automatic scrollToBottom. The user's resulting viewport position is the
    // source of truth; subsequent writes stay detached until they return to
    // the bottom or explicitly click the sidebar item again.
    cached._codexFollowBottom = cached._codexUserScrollCanAttach !== false && isTerminalViewportAtBottom(cached);
  };
  vp.addEventListener('scroll', cached._codexViewportScrollHandler, { passive: true });
}

function fitAndResizeTerminal(sessionId, cached, opts = {}) {
  if (!sessionId || !cached || !cached.opened || !cached.container) return false;
  // The primary terminal can have nonzero geometry behind the opaque card
  // overlay. Geometry alone is not evidence that the user opened backstage.
  if (cached.container.closest('.terminal-panel') === terminalPanelEl && currentView !== 'pty') return false;
  const rect = cached.container.getBoundingClientRect();
  if (rect.width < 4 || rect.height < 4 || !cached.container.offsetWidth) return false;
  // 之前只有 Codex 会话在 fit 之后回到底部（shouldAutoPinCodexTerminal 里就写死了
  // isCodexKind），而 showTerminal 的 pinOnShow 又恰好把 Codex 排除掉 —— 两条置底路径
  // 互补但都不覆盖"Claude 会话被 resize"。结果是：只要终端行数变过，xterm 重排后
  // 视口可能停在旧位置，正文上方留一大片空白，而且再也不会自己回正。
  // 这里补上与 CLI 无关的通用规则：fit 之前贴着底的终端，fit 之后必须还贴着底。
  const wasAtBottom = isTerminalViewportAtBottom(cached);
  const pinAfterFit = shouldAutoPinCodexTerminal(sessionId, cached);
  const boxSig = [
    Math.round(rect.width),
    Math.round(rect.height),
    cached.terminal.options.fontSize,
    currentZoom,
  ].join('x');
  if (!opts.force && cached._lastFitBoxSig === boxSig) return false;
  cached._lastFitBoxSig = boxSig;
  try { cached.fitAddon.fit(); } catch (_) { return false; }
  // 注意：这里曾试过对 PTY resize 做防抖（拖窗口时 rAF 节流后仍是每秒 ~60 次
  // terminal-resize，每次都让 TUI 收到 SIGWINCH 并 \x1b[2J 清屏重画）。改动已回退——
  // Windows 上无法用合成 TUI 验证：经 .cmd 包一层的 node 子进程收不到 PTY 的
  // SIGWINCH，process.stdout.on('resize') 从不触发，对照组和实验组读数都是 0。
  // 未经验证就上防抖的风险是吞掉收尾那次 resize，让 CLI 永久停在错误宽度，
  // 比现状更糟。要动这里必须先有能真正接收 SIGWINCH 的验证手段。
  const resizeSig = `${cached.terminal.cols}x${cached.terminal.rows}`;
  const forcePtyResize = opts.forcePtyResize === true;
  // A newly created xterm is empty while its main-process snapshot is being
  // replayed. Sending PTY resizes during that window makes a full-screen CLI
  // redraw concurrently with the old ANSI stream; the two streams can be
  // interleaved/deduplicated into a half frame or a completely blank surface.
  // Fit the local xterm now, but defer the live PTY resize until hydration has
  // reached its exact sequence barrier. hydrateTerminalFromSnapshot then sends
  // one forced final-size resize so Codex/Kimi/Claude paints a fresh frame.
  if (cached._hydrating && !forcePtyResize) {
    cached._deferredResizeSig = resizeSig;
  } else if (forcePtyResize || cached._lastResizeSig !== resizeSig) {
    cached._lastResizeSig = resizeSig;
    cached._deferredResizeSig = null;
    // Full-screen CLIs repaint after SIGWINCH. Mark renderer-originated resize
    // output so the activity monitor does not mistake that repaint for a new
    // AI turn (for example when a multiline floating draft changes height).
    cached._lastPtyResizeAt = Date.now();
    ipcRenderer.send('terminal-resize', {
      sessionId,
      cols: cached.terminal.cols,
      rows: cached.terminal.rows,
      force: forcePtyResize,
    });
  }
  if (cached._minimap) cached._minimap.invalidate();
  if (pinAfterFit) scheduleCodexBottomPin(sessionId, cached);
  else if (wasAtBottom && !(isNativeAgent(sessions.get(sessionId)) || isCodexKind(sessions.get(sessionId)?.kind))) {
    // xterm 的 reflow 在下一帧才落定，隔一帧再贴一次才稳。
    pinTerminalViewportToBottom(cached);
    requestAnimationFrame(() => {
      if (cached.opened && cached.container && cached.container.offsetWidth) {
        pinTerminalViewportToBottom(cached);
      }
    });
  }
  return true;
}

function scheduleFitAndResizeTerminal(sessionId, cached, opts = {}) {
  if (!sessionId || !cached) return;
  if (cached._fitRaf) cancelAnimationFrame(cached._fitRaf);
  cached._fitRaf = requestAnimationFrame(() => {
    cached._fitRaf = 0;
    fitAndResizeTerminal(sessionId, cached, opts);
  });
}

function refreshTerminalRendererSurface(cached) {
  if (!cached || !cached.opened || !cached.terminal) return false;
  const lastRow = Math.max(0, Number(cached.terminal.rows || 1) - 1);
  try {
    // Moving a cached xterm through display:none or into a new parent does not
    // necessarily resize it. In that case FitAddon is a no-op and Canvas/WebGL
    // keeps the old (or partially evicted) frame. Force a complete repaint so
    // a restored PTY cannot come back as a black surface with scattered glyphs.
    cached.terminal.refresh(0, lastRow);
    cached._surfaceRefreshCount = (cached._surfaceRefreshCount || 0) + 1;
    return true;
  } catch (_) {
    return false;
  }
}

// A cached xterm can keep a complete logical buffer while Chromium discards
// its Canvas/WebGL pixels after card view, display:none, DOM re-parenting, or a
// resumed session being opened behind another surface. FitAddon only renders
// when geometry changes, so an unchanged grid can remain black forever.
// Recover on two visible animation frames: the first restores geometry and
// paints, the second covers delayed layout/compositor attachment.
function scheduleVisibleTerminalRecovery(sessionId, cached, opts = {}) {
  if (!sessionId || !cached) return;
  if (cached._surfaceRecoveryRaf) cancelAnimationFrame(cached._surfaceRecoveryRaf);
  const recover = (secondPass = false) => {
    cached._surfaceRecoveryRaf = 0;
    if (terminalCache.get(sessionId) !== cached || !cached.opened || !cached.container) return;
    if (!cached.container.isConnected) return;
    if (cached.container.closest('.terminal-panel') === terminalPanelEl && currentView !== 'pty') return;
    if (!cached.container.offsetWidth || !cached.container.offsetHeight) {
      if (!secondPass) {
        cached._surfaceRecoveryRaf = requestAnimationFrame(() => recover(true));
      }
      return;
    }
    const forcePtyResize = cached._hydrated && cached._needsPtyRedraw;
    if (fitAndResizeTerminal(sessionId, cached, { force: true, forcePtyResize }) && forcePtyResize) cached._needsPtyRedraw = false;
    refreshTerminalRendererSurface(cached);
    if (opts.pinBottom) {
      try { cached.terminal.scrollToBottom(); } catch {}
      const viewport = getTerminalViewport(cached);
      if (viewport) viewport.scrollTop = viewport.scrollHeight;
    }
    if (!secondPass) {
      cached._surfaceRecoveryRaf = requestAnimationFrame(() => recover(true));
    }
  };
  cached._surfaceRecoveryRaf = requestAnimationFrame(() => recover(false));
}

// --- DOM refs ---
const sessionListEl = document.getElementById('session-list');
const terminalPanelEl = document.getElementById('terminal-panel');
const emptyStateEl = document.getElementById('empty-state');
const operationsReviewModalEl = document.getElementById('operations-review-modal');

// The review cockpit is a viewport-level modal, not terminal content. Keep it
// outside #terminal-panel so fullscreen previews can hide the source surface
// without also hiding the modal or letting its shortcuts fall through.
if (operationsReviewModalEl && operationsReviewModalEl.parentElement === terminalPanelEl) {
  document.body.appendChild(operationsReviewModalEl);
}


// Spec 2 preserve helper — both showTerminal AND session-closed handler clear
// terminalPanelEl.innerHTML, which would obliterate spec 1/2 elements (view-toggle,
// notification toggle, msg-overlay) declared statically in index.html. Without preserve they vanish forever
// after the first session close → no card view + no view toggle button.
function preserveAndClearTerminalPanel() {
  const preserved = [
    document.getElementById('msg-overlay'),
    document.getElementById('card-session-status'),
    document.getElementById('card-question-nav'),
    document.getElementById('completion-notification-toggle'),
    document.getElementById('card-multi-select-bar'),
  ].filter(Boolean);
  terminalPanelEl.innerHTML = '';
  // Detached composers no longer own the replacement panel's layout.
  terminalPanelEl.style.setProperty('--fi-bar-h', '0px');
  terminalPanelEl.style.setProperty('--term-header-h', '0px');
  preserved.forEach(el => terminalPanelEl.appendChild(el));
}
const btnNew = document.getElementById('btn-new');
const menuEl = document.getElementById('new-session-menu');
const wrapperEl = document.getElementById('new-session-wrapper');
const btnHome = document.getElementById('btn-home');
const btnResearch = document.getElementById('btn-research');
const contextMenuEl = document.getElementById('context-menu');
const termCtxMenuEl = document.getElementById('terminal-context-menu');
const appContainerEl = document.getElementById('app-container');
// btn-collapse-sidebar 已删除 (v0.8.4) — 用 Ctrl+B 折叠;展开按钮 btn-expand-sidebar 在折叠态仍提供
const btnExpandEl = document.getElementById('btn-expand-sidebar');

const modelUi = createModelUiController({
  document,
  ipcRenderer,
  sessions,
  terminalPanelEl,
  getActiveSessionId: () => activeSessionId,
  escapeHtml,
  refreshModelCatalog: (kind, session) => window.WorkspaceController.loadModelCatalog(kind, {
    codexProfile: session && session.codexProfile,
  }),
  getTerminalScreenText: sessionId => terminalActivityMonitor.extractLiveScreenLines(sessionId).join('\n'),
  openCommandScreen: sessionId => require('./command-screen').openCommandScreen(ipcRenderer, sessionId),
  isSessionBusy: session => sessionRuntimeIsActive(session),
  // 头部徽章 T2 删了，模型名只剩 composer 底栏那个 chip。模型切换的每一步
  // （发起 / 确认 / 超时回滚）都要让它重画一次，否则会停在切换前的名字上。
  repaintActiveComposer: () => updateFloatingBarState(),
});
const attachModelPickerHandler = modelUi.attachModelPickerHandler;
const updateActiveModelChip = modelUi.updateActiveModelChip;

// Font size — shared across all terminals, persisted
const FONT_SIZE_KEY = 'claude-hub-font-size';
const FONT_SIZE_MIN = 10;
const FONT_SIZE_MAX = 28;
let displayPresets = null;
let currentFontSize = parseInt(localStorage.getItem(FONT_SIZE_KEY), 10);
if (!currentFontSize || isNaN(currentFontSize)) currentFontSize = 16;
let currentTerminalFontSize = currentFontSize;

function setFontSize(size) {
  size = Math.max(FONT_SIZE_MIN, Math.min(FONT_SIZE_MAX, size));
  if (size === currentFontSize) return;
  currentFontSize = size;
  if (!displayPresets || displayPresets.mode === 'desktop') localStorage.setItem(FONT_SIZE_KEY, String(size));
  displayPresets?.record('fontSize',size);
  // 2026-05-09 主区 zoom 联动：卡片视图 / 启动器 / AI 群聊 fullscreen 等通过 CSS calc(... * --main-zoom) 跟随
  // 写到 :root（documentElement），让 AI 群聊（#meeting-room-panel，#terminal-panel 的兄弟节点）也能继承
  document.documentElement.style.setProperty('--main-zoom', (size / 16).toFixed(3));
}

function setTerminalFontSize(size) {
  size = Math.max(FONT_SIZE_MIN, Math.min(FONT_SIZE_MAX, size));
  currentTerminalFontSize = size;
  displayPresets?.record('terminalFontSize',size);
  for (const [sid, c] of terminalCache) {
    c.terminal.options.fontSize = size;
    if (c.opened) {
      scheduleFitAndResizeTerminal(sid, c, { force: true });
    }
  }
}

// 启动时初始化 --main-zoom（首次 setFontSize 才设变量，启动时手动设一次到 :root）
document.documentElement.style.setProperty('--main-zoom', (currentFontSize / 16).toFixed(3));

// --- Global UI zoom (Electron webFrame) ---
// Scales the entire renderer: sidebar, buttons, xterm cells, modals. Used
// mainly to bump everything up for dense displays vs. shrink for
// desktop. Distinct from setFontSize, which only touches the xterm font.
// Level is an integer; each step is ~20% per Electron's zoom curve. 0 = 100%.
const ZOOM_KEY = 'claude-hub-zoom-level';
const ZOOM_MIN = -3;
const ZOOM_MAX = 5;
let currentZoom = parseInt(localStorage.getItem(ZOOM_KEY), 10);
if (isNaN(currentZoom)) currentZoom = 0;

function applyZoom(level) {
  level = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, level));
  currentZoom = level;
  webFrame.setZoomLevel(level);
  if (!displayPresets || displayPresets.mode === 'desktop') localStorage.setItem(ZOOM_KEY, String(level));
  displayPresets?.record('zoomLevel',level);
  // Re-fit the active xterm so terminal cols/rows match the new render size.
  const active = activeSessionId && terminalCache.get(activeSessionId);
  if (active && active.opened) {
    scheduleFitAndResizeTerminal(activeSessionId, active, { force: true });
  }
}

// Restore persisted zoom on boot.
applyZoom(currentZoom);

displayPresets = require('./display-presets').createDisplayPresets({
  document,storage:localStorage,fontSize:currentFontSize,zoomLevel:currentZoom,
  applyFont:setFontSize,applyTerminalFont:setTerminalFontSize,applyZoom,
  onLayoutChange:()=>{
    for (const [sid,c] of terminalCache) if (c.opened) scheduleFitAndResizeTerminal(sid,c,{force:true});
  },
});
displayPresets.init();

// --- Global Memo Panel ---
const memoPanel = createMemoPanel({
  baseDir: __dirname,
  clipboard,
  document,
  getActiveSessionId: getFocusedSessionId,
  getActiveTerminal: () => terminalCache.get(getFocusedSessionId()),
  localStorage,
  scheduleRefit: scheduleFitAndResizeTerminal,
});
memoPanel.init();
// --- Helpers ---
// 侧栏统一按活动距今显示；不影响历史正文与其他面板的绝对时间。
function formatTime(ts) {
  if (!Number.isFinite(Number(ts)) || Number(ts) <= 0) return '—';
  const diff = Date.now() - ts;
  if (diff < 60000) return '刚刚';
  if (diff < 3600000) return `${Math.floor(diff / 60000)}分钟前`;
  if (diff < 24 * 3600000) return `${Math.floor(diff / 3600000)}小时前`;
  return `${Math.floor(diff / 86400000)}天前`;
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function normalizeMarkdownPathBreaks(text) {
  if (typeof window !== 'undefined' && typeof window.normalizeWrappedPathBreaks === 'function') {
    return window.normalizeWrappedPathBreaks(text);
  }
  return String(text || '');
}

const { createSessionListRenderer } = require('./session-list-renderer.js');
const meetingUnread = require('./meeting-unread.js');
const sessionListRenderer = createSessionListRenderer({
  requestSessionUsage: ids => ipcRenderer.send('session-usage:watch', ids),
  document,
  localStorage,
  sessionListEl,
  getSessions: () => sessions,
  getMeetings: () => meetings,
  getActiveSessionId: () => activeSessionId,
  getActiveMeetingId: () => activeMeetingId,
  isAiKind,
  modelShort,
  modelClass,
  escapeHtml,
  formatTime,
  pctClass: (pct) => pctClass(pct),
  getResourceUsage: () => systemResourceUsage,
  getProxyInfo: () => hubProxyInfo,
  selectSession: (id, opts) => selectSession(id, opts),
  selectMeeting: (id, opts) => selectMeeting(id, opts),
  openContextMenu: (id, x, y) => openContextMenu(id, x, y),
  markAllSessionsRead: () => markAllSessionsRead(),
  markMeetingRead: id => markMeetingRead(id),
  // The sidebar DOM was just rebuilt; painting the composer here read layout
  // (panelIsVisible) and forced a full synchronous relayout after every
  // sidebar render. In the next frame that layout is shared with the paint.
  afterRender: () => { scheduleFloatingBarState(); },
});
const renderSessionListNow = sessionListRenderer.renderSessionList;
const renderSidebarStrip = sessionListRenderer.renderSidebarStrip;
const sidebarInsights = require('./sidebar-insights').createSidebarInsights({
  document, storage: localStorage,
  onExpand: () => { void refreshSystemResourceUsage(true); },
});
require('./resource-process-tooltip').attachResourceProcessTooltip({
  document, escapeHtml,
  request: () => ipcRenderer.invoke('get-resource-top-processes'),
});
require('./desktop-organizer-panel').attachDesktopOrganizerPanel({ document, escapeHtml, invoke: (channel, options) => ipcRenderer.invoke(channel, options) });
let diskReleasePanel = null;
const memoryReleasePanel = require('./memory-release-panel').attachMemoryReleasePanel({
  document, escapeHtml,
  onOpen: () => diskReleasePanel?.close(),
  request: () => ipcRenderer.invoke('get-memory-release-plan'),
  execute: keys => ipcRenderer.invoke('execute-memory-release', { keys }),
});
diskReleasePanel = require('./disk-release-panel').attachDiskReleasePanel({
  document, escapeHtml,
  onOpen: () => memoryReleasePanel?.close(),
  onComplete: () => { void refreshSystemResourceUsage(true); },
  request: () => ipcRenderer.invoke('get-disk-release-plan'),
  analyzeUsage: () => ipcRenderer.invoke('get-disk-usage-analysis'),
  execute: options => ipcRenderer.invoke('execute-disk-release', options),
  getStatus: () => ipcRenderer.invoke('get-disk-release-status'),
  cancelScan: () => ipcRenderer.invoke('cancel-disk-release-scan'),
  subscribeProgress: callback => {
    const listener = (_event, progress) => callback(progress);
    ipcRenderer.on('disk-release-progress', listener);
    return () => ipcRenderer.removeListener('disk-release-progress', listener);
  },
});
require('./vpn-traffic-panel').attachVpnTrafficPanel({
  document, escapeHtml,
  request: range => ipcRenderer.invoke('get-vpn-traffic-report', { range }),
  getAlert: () => hubProxyInfo?.egress?.alert || null,
  acknowledge: async () => {
    const result = await ipcRenderer.invoke('acknowledge-network-egress-change').catch(() => null);
    if (result && result.status) {
      hubProxyInfo = { ...(hubProxyInfo || {}), egress: result.status };
      renderSidebarStrip();
      if (homeWorkbench) homeWorkbench.render();
    }
    return result;
  },
});

// 「已完成未读」组头上的「全部已读」：一次把所有会话和群聊的"答完了还没看"清掉。
// 三层都要落，少一层就会复活：
//   渲染层内存 → 侧栏立刻消失；state.json → 重启后不再回来；
//   主进程 sessionManager → 活会话的下一次 session-updated 广播不会把 unreadCount 推回来。
// 刻意不碰 needs-input：CLI 真卡在等用户输入时把它标成已读，等于替用户撒谎。
function markMeetingMemberRead(meetingId, sid, readContext = null) {
  const meeting = meetings[meetingId];
  const result = meetingUnread.readMeetingMember(meeting, sid, sessions, readContext);
  if (!result.changed) return false;
  if (result.sessionRead) {
    ipcRenderer.send('mark-sessions-read', { sessionIds: [sid] });
    schedulePersist();
  }
  scheduleSessionListRender();
  return true;
}
window.markMeetingMemberRead = markMeetingMemberRead;

function markMeetingRead(meetingId) {
  for (const sid of meetings[meetingId]?.subSessions || []) markMeetingMemberRead(meetingId, sid);
}

function markAllSessionsRead() {
  const clearedSessionIds = [];
  for (const session of sessions.values()) {
    if (session && clearSessionCompletedUnread(session)) clearedSessionIds.push(session.id);
  }
  let clearedMeeting = false;
  for (const meeting of Object.values(meetings || {})) {
    if (!meeting) continue;
    if (Math.max(0, Number(meeting.unreadCount) || 0) > 0) {
      meeting.unreadCount = 0;
      clearedMeeting = true;
    }
    if (meeting.unreadAnswered instanceof Set && meeting.unreadAnswered.size > 0) {
      meeting.unreadAnswered.clear();
      clearedMeeting = true;
    }
  }
  if (!clearedSessionIds.length && !clearedMeeting) return { ok: true, cleared: 0 };
  if (clearedSessionIds.length) {
    ipcRenderer.send('mark-sessions-read', { sessionIds: clearedSessionIds });
    schedulePersist();
  }
  scheduleSessionListRender();
  if (homeWorkbench) homeWorkbench.render();
  return { ok: true, cleared: clearedSessionIds.length };
}
const sessionReadyNotifier = createSessionReadyNotifier({
  ipcRenderer,
  getSessions: () => sessions,
});
function renderSessionSurfacesNow() {
  sessionReadyNotifier.scan();
  renderSessionListNow();
  if (homeWorkbench) homeWorkbench.render();
}
// 150 ms still reads as live, and halves full sidebar rebuilds while many
// agents stream status at once.
const sidebarRenderCoalescer = createRenderCoalescer(renderSessionSurfacesNow, { delayMs: 150 });
function renderSessionList() {
  sidebarRenderCoalescer.cancel();
  renderSessionSurfacesNow();
}
function scheduleSessionListRender() {
  sidebarRenderCoalescer.schedule();
}

// 画面停刷的现场记录（写进 <数据目录>/logs/window-events.log，见 core/window-keep-rendering.js）：
// 页面被判成可见/不可见时记一笔；页面可见却超过 3 秒没出一帧，也记一笔（带当前视图与会话数），
// 用来区分「窗口被当成看不见」和「真的画不动」。每秒只排一次 requestAnimationFrame，开销可忽略。
(() => {
  const report = (event, extra = {}) => {
    try { ipcRenderer.send('hub:page-window-event', { event, view: typeof currentView === 'string' ? currentView : null, sessions: typeof sessions !== 'undefined' ? sessions.size : null, ...extra }); } catch {}
  };
  document.addEventListener('visibilitychange', () => report('visibility', { state: document.visibilityState }));
  let pendingSince = 0;
  let stalled = false;
  setInterval(() => {
    if (document.visibilityState !== 'visible') { pendingSince = 0; return; }
    const now = performance.now();
    if (pendingSince) {
      if (!stalled && now - pendingSince > 3000) { stalled = true; report('frame-stall', { ms: Math.round(now - pendingSince) }); }
      return;
    }
    pendingSince = now;
    requestAnimationFrame(() => {
      if (stalled) report('frame-resume', { ms: Math.round(performance.now() - pendingSince) });
      stalled = false;
      pendingSince = 0;
    });
  }, 1000);
})();

ipcRenderer.on('desktop-notification:open-session', (_event, payload = {}) => {
  const sessionId = String(payload.sessionId || '');
  if (!sessionId || !sessions.has(sessionId)) return;
  void selectSession(sessionId, { forceScrollBottom: true });
});

let networkTransferPending = false;
async function refreshNetworkTransferUsage() {
  if (networkTransferPending) return;
  networkTransferPending = true;
  try {
    const network = await ipcRenderer.invoke('get-network-transfer-usage');
    systemResourceUsage = { ...systemResourceUsage, network };
  } catch {
    systemResourceUsage = { ...systemResourceUsage, network: { status: 'unavailable' } };
  } finally {
    networkTransferPending = false;
    renderSidebarStrip();
  }
}
async function refreshSystemResourceUsage(force = false) {
  if (document.hidden && force !== true) return;
  void refreshNetworkTransferUsage();
  try {
    const next = await ipcRenderer.invoke('get-system-resource-usage', { force: force === true, extended: false });
    if (!next || (!Number.isFinite(next.cpuPct) && !Number.isFinite(next.memoryPct))) return;
    systemResourceUsage = { ...systemResourceUsage, ...next };
    renderSidebarStrip();
    if (homeWorkbench) homeWorkbench.render();
  } catch {}
}

// 配置与真实出口一起刷新。main 进程对外网探测有缓存，renderer
// 可以频繁读 IPC 而不会频繁请求地理服务。
async function refreshHubProxyInfo(options = {}) {
  if (document.hidden && options.force !== true) return;
  try {
    const [configResult, egressResult, notificationHealthResult, delayResult] = await Promise.allSettled([
      ipcRenderer.invoke('get-hub-config-raw'),
      ipcRenderer.invoke('get-network-egress-status', { force: options.force === true }),
      ipcRenderer.invoke('get-completion-notification-health'),
      ipcRenderer.invoke('get-clash-proxy-delay'),
    ]);
    const cfg = configResult.status === 'fulfilled' ? configResult.value : null;
    const egress = egressResult.status === 'fulfilled' ? egressResult.value : null;
    const notificationHealth = notificationHealthResult.status === 'fulfilled'
      ? notificationHealthResult.value
      : null;
    const clashDelay = delayResult.status === 'fulfilled' ? delayResult.value : { status: 'unavailable' };
    const next = {
      proxy: (cfg && cfg.proxy) || (hubProxyInfo && hubProxyInfo.proxy) || (egress && egress.proxyEndpoint) || '',
      notificationConfigured: cfg
        ? !!(cfg.notificationConfigured || cfg.feishuTargetSet || String(cfg.feishuTarget || '').trim())
        : !!(hubProxyInfo && hubProxyInfo.notificationConfigured),
      deepseekApiKeySet: cfg
        ? !!String(cfg.deepseekApiKey || '').trim()
        : !!(hubProxyInfo && hubProxyInfo.deepseekApiKeySet),
      egress: egress || (hubProxyInfo && hubProxyInfo.egress) || null,
      notificationHealth: notificationHealth || (hubProxyInfo && hubProxyInfo.notificationHealth) || null,
      clashDelay,
    };
    if (hubProxyInfo
        && hubProxyInfo.proxy === next.proxy
        && hubProxyInfo.notificationConfigured === next.notificationConfigured
        && hubProxyInfo.deepseekApiKeySet === next.deepseekApiKeySet
        && String(hubProxyInfo.clashDelay?.delayMs ?? '') === String(next.clashDelay?.delayMs ?? '')
        && hubProxyInfo.clashDelay?.status === next.clashDelay?.status
        && Number(hubProxyInfo.egress && hubProxyInfo.egress.checkedAt) === Number(next.egress && next.egress.checkedAt)
        && String(hubProxyInfo.egress && hubProxyInfo.egress.alert && hubProxyInfo.egress.alert.type || '')
          === String(next.egress && next.egress.alert && next.egress.alert.type || '')
        && Number(hubProxyInfo.notificationHealth && hubProxyInfo.notificationHealth.lastDelivery && hubProxyInfo.notificationHealth.lastDelivery.timestamp)
          === Number(next.notificationHealth && next.notificationHealth.lastDelivery && next.notificationHealth.lastDelivery.timestamp)
        && String(hubProxyInfo.notificationHealth && hubProxyInfo.notificationHealth.lastDelivery && hubProxyInfo.notificationHealth.lastDelivery.status || '')
          === String(next.notificationHealth && next.notificationHealth.lastDelivery && next.notificationHealth.lastDelivery.status || '')) return;
    hubProxyInfo = next;
    renderSidebarStrip();
    if (homeWorkbench) homeWorkbench.render();
  } catch {}
}
let activeMeetingId = null;
let meetings = {};

function formatRelativeTime(ts) {
  if (!ts) return '';
  const now = Math.floor(Date.now() / 1000);
  const diff = now - parseInt(ts);
  if (diff < 60) return '刚刚';
  if (diff < 3600) return Math.floor(diff / 60) + '分钟前';
  if (diff < 86400) return Math.floor(diff / 3600) + '小时前';
  if (diff < 604800) return Math.floor(diff / 86400) + '天前';
  return formatBeijingMonthDay(parseInt(ts) * 1000);
}

function paintSidebarActiveTarget({ sessionId = null, meetingId = null } = {}) {
  if (!sessionListEl) return;
  sessionListEl.querySelectorAll('.session-item.selected').forEach(row => row.classList.remove('selected'));
  const selector = sessionId
    ? `[data-session-id="${CSS.escape(String(sessionId))}"]`
    : (meetingId ? `[data-meeting-id="${CSS.escape(String(meetingId))}"]` : '');
  if (!selector) return;
  const row = sessionListEl.querySelector(selector);
  if (row) row.classList.add('selected');
}

function paintSidebarResumePending(sessionId, pending) {
  if (!sessionListEl || !sessionId) return;
  const row = sessionListEl.querySelector(`[data-session-id="${CSS.escape(String(sessionId))}"]`);
  if (!row) return;
  row.classList.toggle('resuming', pending === true);
  if (pending === true) {
    row.title = '正在唤醒会话';
    const time = row.querySelector('.sl-time');
    if (time) time.textContent = '唤醒中…';
  }
}

function showDormantResumePlaceholder(session, error = null, { checking = false } = {}) {
  if (!terminalPanelEl || !session) return;
  suspendInactiveTerminalRenderers(null);
  terminalPanelEl.classList.remove('home-active');
  preserveAndClearTerminalPanel();
  const overlay = document.getElementById('msg-overlay');
  if (overlay) overlay.classList.add('hidden');
  if (emptyStateEl) emptyStateEl.style.display = 'none';
  const panel = document.createElement('div');
  panel.className = `session-resume-pending${error ? ' failed' : ''}`;
  const spinner = document.createElement('span');
  spinner.className = 'session-resume-spinner';
  spinner.setAttribute('aria-hidden', 'true');
  const copy = document.createElement('div');
  const title = document.createElement('strong');
  title.textContent = error ? '会话唤醒失败' : checking ? '正在检查会话…' : '正在唤醒会话…';
  const detail = document.createElement('span');
  detail.textContent = error
    ? `${String(error && error.message || error)}。再次点击左侧会话可重试。`
    : `${session.title || 'Session'} · ${checking ? '正在确认会话可用' : '正在恢复原生 CLI 与历史上下文'}`;
  copy.append(title, detail);
  panel.append(spinner, copy);
  terminalPanelEl.appendChild(panel);
}


const wakeDormantMeetingMembers = require('./meeting-member-wake.js').createMeetingMemberWake({
  getSession: id => sessions.get(id),
  resumeSession: id => resumeDormantSession(id),
});

async function selectMeeting(meetingId, opts = {}) {
  window.hubWorkspaces?.close();
  void savePreviewState({ nonBlocking: true });
  activeSessionId = null;
  suspendInactiveTerminalRenderers(null);
  if (typeof cardMultiSelectController !== 'undefined') cardMultiSelectController.setVisible(false);
  activeMeetingId = meetingId;
  if (completionNotificationToggle) completionNotificationToggle.refreshTarget();
  // Stop background meeting PTY redraws at the main-process boundary. The room
  // renders transcript/card state, not xterm output; an individual member shell
  // will set focus again via selectSession when the user explicitly opens it.
  ipcRenderer.send('focus-session', { sessionId: null });

  if (terminalPanelEl) terminalPanelEl.style.display = 'none';
  if (terminalPanelEl) terminalPanelEl.classList.remove('home-active');
  if (window.__xresearchHide) window.__xresearchHide(); // 2026-07-23 投研面板互斥
  if (window.__studyHide) window.__studyHide(); // 2026-09-01 学习面板互斥
  if (window.__assistantHide) window.__assistantHide();
  if (window.__writingHide) window.__writingHide(); // 2026-09-30 写作面板互斥
  if (window.__ranHide) window.__ranHide(); // 2026-09-04 RAN 工作台面板互斥
  setShellNavActive(null);
  if (emptyStateEl) emptyStateEl.style.display = 'none';
  clearPreviewUI();

  let meeting = meetings[meetingId];
  // Opening the room is navigation, not proof that every member was read.
  // Member answers are acknowledged by explicit member/card navigation.
  if (meeting) {
    let acknowledgedFailure = false;
    for (const sid of meeting.subSessions || []) {
      acknowledgedFailure = acknowledgeSessionFailureState(sid, { render: false }) || acknowledgedFailure;
    }
    if (acknowledgedFailure) schedulePersist();
  }
  paintSidebarActiveTarget({ meetingId });
  scheduleSessionListRender();
  // Opening a large room rebuilds the complete meeting surface and can take a
  // noticeable frame after a long run of terminal switches. Yield once after
  // painting the selected row so the first click always produces visible
  // feedback. The bounded timer keeps programmatic/background navigation from
  // waiting on Chromium's throttled rAF.
  await new Promise(resolve => {
    let settled = false;
    let paintTimer = null;
    const done = () => {
      if (settled) return;
      settled = true;
      clearTimeout(fallbackTimer);
      if (paintTimer) clearTimeout(paintTimer);
      resolve();
    };
    const fallbackTimer = setTimeout(done, 50);
    // A promise resolved directly inside rAF continues in a microtask before
    // Chromium paints. Hop through a zero-delay task so the selected row is
    // actually composited before room construction starts.
    requestAnimationFrame(() => { paintTimer = setTimeout(done, 0); });
  });
  if (activeMeetingId !== meetingId || activeSessionId !== null) return;
  // Creation/member updates can finish while the paint yield is pending.
  // Opening the captured partial snapshot would overwrite the completed room.
  meeting = meetings[meetingId];
  if (meeting && typeof MeetingRoom !== 'undefined') {
    let shouldWakeMembers = opts.wakeDormantMembers === true;
    if (meeting.status === 'dormant') {
      meeting.status = 'idle';
      // 2026-07-20 maintainer [修#2]：唤醒状态同步落后端——否则下一次 meeting-updated
      //   （发消息/auto-title 必触发）又把 dormant 覆盖回来，侧栏"等你 N"与
      //   respond pill 对该会议永久失声。后端 updateMeeting 的 allowed 字段含 status。
      ipcRenderer.send('update-meeting', { meetingId: meeting.id, fields: { status: 'idle' } });
      const workflow = meeting.serialWorkflow;
      const usesLazySerialWake = !!(
        workflow && workflow.enabled && !workflow.loop?.enabled
        && Array.isArray(workflow.steps) && workflow.steps.length
      );
      // Background navigation retains lazy serial wake. Explicit sidebar opening
      // wakes every dormant member, including unselected workflow participants.
      shouldWakeMembers ||= !usesLazySerialWake;
    }
    if (shouldWakeMembers) {
      void wakeDormantMeetingMembers(meeting).catch(error => {
        require('./ui-feedback').showHubAlert(`群聊“${meeting.title || meeting.id}”部分成员唤醒失败：\n${error.message}`);
      });
    }
    MeetingRoom.openMeeting(meetingId, meeting, {
      forceScrollBottom: opts.forceScrollBottom === true,
    });
  }

  await restorePreviewForContext(`meeting:${meetingId}`);
}

// --- Terminal management ---
// Load GPU renderer. Default is Canvas (stable + GPU-accelerated 2D). WebGL
// is faster but on some GPU/driver combos it leaves cursor ghosting artifacts
// in Claude Code's TUI redraw, so it's opt-in only.
// Override via localStorage: setItem('hub.renderer', 'canvas' | 'webgl' | 'dom')
function _loadCanvasRenderer(cached) {
  try {
    const canvas = new CanvasAddon();
    cached.terminal.loadAddon(canvas);
    cached._rendererAddon = canvas;
    cached._rendererMode = 'canvas';
    cached._gpuLoaded = true;
    return true;
  } catch (_) {
    cached._rendererAddon = null;
    cached._rendererMode = null;
    cached._gpuLoaded = false;
    return false;
  }
}

function loadGpuRenderer(cached) {
  if (cached._backstageReadable) return;
  if (cached._gpuLoaded) return;
  // 关闭了显卡加速时默认用 DOM：公司真机（2026-10-09）上 Canvas 在软件渲染下会让整个页面停止重绘，
  // 点「后台」后界面卡死、切回卡片也不恢复；DOM 渲染不依赖显卡。手动设置的 hub.renderer 仍然优先。
  const gpuDisabled = Array.isArray(process.argv) && process.argv.includes('--ai-hub-gpu-disabled');
  const pref = localStorage.getItem('hub.renderer') || (gpuDisabled ? 'dom' : 'canvas');
  if (pref === 'dom') {
    cached._rendererAddon = null;
    cached._rendererMode = 'dom';
    cached._gpuLoaded = true;
    return;
  }
  if (pref === 'webgl') {
    try {
      const webgl = new WebglAddon();
      webgl.onContextLoss(() => {
        if (cached._rendererAddon !== webgl) return;
        try { webgl.dispose(); } catch {}
        cached._rendererAddon = null;
        cached._rendererMode = null;
        cached._gpuLoaded = false;
        // Only recreate a surface for the visible terminal. Hidden xterms keep
        // parsing into their buffers without holding compositor resources.
        if (cached.container && cached.container.style.display !== 'none') {
          _loadCanvasRenderer(cached);
        }
      });
      cached.terminal.loadAddon(webgl);
      cached._rendererAddon = webgl;
      cached._rendererMode = 'webgl';
      cached._gpuLoaded = true;
      return;
    } catch (_) { /* fall through to canvas */ }
  }
  _loadCanvasRenderer(cached);
}

function unloadGpuRenderer(cached) {
  if (!cached) return false;
  const addon = cached._rendererAddon;
  if (addon) {
    try { addon.dispose(); } catch {}
  }
  const changed = !!addon || !!cached._gpuLoaded;
  cached._rendererAddon = null;
  cached._rendererMode = null;
  cached._gpuLoaded = false;
  return changed;
}

// The primary panel's terminal is covered by the card overlay in card view.
function setCardHiddenTerminal(cached, hidden) {
  if (!cached || !cached.container || cached.container.closest('.terminal-panel') !== terminalPanelEl) return;
  cached.container.style.display = hidden ? 'none' : 'block';
}

function suspendInactiveTerminalRenderers(activeId) {
  for (const [sessionId, cached] of terminalCache) {
    if (activeId && sessionId === activeId) continue;
    if (sessionSplit?.isVisible(sessionId)) continue;
    if (cached && cached.container) cached.container.style.display = 'none';
    if (cached._ptyPresentation) { cached._ptyPresentation.dispose(); cached._ptyPresentation = null; }
    unloadGpuRenderer(cached);
  }
}

function disposeCachedTerminal(sessionId) {
  const cached = terminalCache.get(sessionId);
  if (!cached) return false;
  cached._codexBackstage?.dispose();
  if (cached._ptyPresentation) { cached._ptyPresentation.dispose(); cached._ptyPresentation = null; }
  if (cached._ro) cached._ro.disconnect();
  if (cached._resizeHandler) window.removeEventListener('resize', cached._resizeHandler);
  if (cached._overflowDocHandler) document.removeEventListener('click', cached._overflowDocHandler);
  if (cached._fitRaf) cancelAnimationFrame(cached._fitRaf);
  if (cached._surfaceRecoveryRaf) cancelAnimationFrame(cached._surfaceRecoveryRaf);
  if (cached._codexBottomPinRaf) cancelAnimationFrame(cached._codexBottomPinRaf);
  if (cached._minimap) { try { cached._minimap.dispose(); } catch {} cached._minimap = null; }
  if (cached._codexAnswerAccent) { cached._codexAnswerAccent.dispose(); cached._codexAnswerAccent = null; }
  if (cached._navButtons) { try { cached._navButtons.dispose(); } catch {} cached._navButtons = null; }
  if (cached._floatingInput) { try { cached._floatingInput.dispose(); } catch {} cached._floatingInput = null; }
  if (cached._localPathLinkProvider) {
    try { cached._localPathLinkProvider.dispose(); } catch {}
    cached._localPathLinkProvider = null;
  }
  unloadGpuRenderer(cached);
  try { cached.terminal.dispose(); } catch {}
  try { cached.container.remove(); } catch {}
  terminalCache.delete(sessionId);
  return true;
}

async function closeSessionAsSleep(sessionId) {
  try {
    await nativeDraftControllers.get(sessionId)?.flush();
    const result = await ipcRenderer.invoke('close-session', sessionId);
    if (!result || !result.ok) {
      require('./ui-feedback').showHubAlert((result && result.message) || '关闭休眠失败，请稍后重试。');
    }
    return result || null;
  } catch (error) {
    require('./ui-feedback').showHubAlert(`关闭休眠失败：${error && error.message ? error.message : String(error)}`);
    return null;
  }
}

function getOrCreateTerminal(sessionId) {
  if (terminalCache.has(sessionId)) {
    return terminalCache.get(sessionId);
  }
  const terminal = new Terminal({
    // 主题从 DOM 上现读，避免和 themeController 的构造顺序耦合。
    ...resolveXtermOptions(document.documentElement.getAttribute('data-theme'), sessions.get(sessionId)?.kind),
    fontSize: currentTerminalFontSize,
    lineHeight: isNativeAgent(sessions.get(sessionId)) ? 1.16 : 1.04,
    fontFamily: "'Cascadia Code', 'Consolas', 'Courier New', monospace",
    fontWeight: isCodexKind(sessions.get(sessionId)?.kind) ? '500' : 'normal',
    cursorBlink: true,
    scrollback: 10000,
    allowProposedApi: true,
    // Tells xterm the PTY backend is conpty so it parses native wrap sequences
    // (Windows 11 build >= 21376) and sets isWrapped correctly. Without this
    // xterm sees conpty's already-laid-out lines as separate explicit lines
    // and our path-link wrap-stitching breaks on long paths.
    ...(process.platform === 'win32' ? {
      windowsPty: {
        backend: 'conpty',
        buildNumber: parseInt(require('os').release().split('.').pop(), 10) || 0,
      },
    } : {}),
  });

  const fitAddon = new FitAddon();
  const searchAddon = new SearchAddon();
  terminal.loadAddon(fitAddon);
  terminal.loadAddon(new Unicode11Addon());
  terminal.loadAddon(searchAddon);
  // HTTP(S), file:// and local paths deliberately share one Hub link provider.
  // A separate xterm URL provider used to race this provider and made PTY clicks
  // behave differently from identical links in card view.
  const localPathLinkProvider = registerLocalPathLinks(terminal, sessionId);
  terminal.unicode.activeVersion = '11';

  terminal.onData((data) => {
    if (sessions.get(sessionId)?.runtimeBackend === 'claude-stream-json') return;
    if (!isTerminalProtocolReply(data)) {
      if (data) clearSessionWaitingState(sessionId);
      trackPtyPromptInput(sessionId, data);
    }
    ipcRenderer.send('terminal-input', { sessionId, data });
  });
  terminal.onBinary((data) => {
    if (sessions.get(sessionId)?.runtimeBackend === 'claude-stream-json') return;
    ipcRenderer.send('terminal-input', { sessionId, data });
  });

  // Claude Code emits an OSC set-title escape sequence once near the start of a
  // conversation with an AI-generated short summary (e.g. "Greeting in Chinese").
  // xterm fires onTitleChange for it. We capture that as the session title
  // unless the user already renamed in Hub (userRenamed wins). Only for Claude
  // kinds — PowerShell emits title sequences on every prompt, which we don't want.
  // Migration-only DeepSeek sessions still run on Claude CLI. New DeepSeek
  // sessions use Codex and are titled by Hub's transcript-based auto-title path.
  const session = sessions.get(sessionId);
  const isClaudeKind = isClaudeRuntimeSession(session);
  if (isClaudeKind) {
    terminal.onTitleChange((newTitle) => {
      const s = sessions.get(sessionId);
      if (!s) return;
      if (s.userRenamed || s.autoTitleGenerated) return; // user's Hub rename / Hub auto-title is authoritative
      // 公司 Code Agent 的窗口标题是「🟡/🟢 + 用户刚发的那句话」或「opentui: 路径」，不是会话摘要，
      // 交给 Hub 自己的自动起名（2026-10-08 公司实测录屏）。
      if (String(s.kind || '').startsWith('codeagent')) return;
      // slot 化（2026-05-03 maintainer）：AI 群聊 sub session title 永久绑定 slot 名
      //   （Pikachu/Charmander/Squirtle），不接受 OSC 自动覆盖。
      //   主桌单 session（meetingId === null）仍走 OSC 自动命名（Claude 给的简短摘要）。
      if (s.meetingId) return;
      const clean = String(newTitle || '').trim();
      if (!shouldAcceptExternalSessionTitle(s, clean)) return;
      // 2026-05-24 maintainer：DeepSeek 中文自动命名启用时，OSC 是抢跑赛道（PTY 同步、~ms 内到达），
      //   会先于 DeepSeek HTTP（~数百 ms—秒）落地 s.title，导致 auto-title-manager 的
      //   isGenericAutoSessionTitle 检查失败、DeepSeek 中文结果被丢弃 → 用户全英文。
      //   解决：DeepSeek 启用时 OSC 仅记影子字段不动 s.title；让 DeepSeek 独占主标题。
      //   DeepSeek API 失败时 auto-title-manager 自己有 fallbackSessionTitleFromPrompt 兜底（中文）。
      if (_deepseekAutoTitleEnabled && s.kind === 'deepseek') {
        s.claudeAutoTitle = clean;
        return;
      }
      if (clean === s.title) return;
      s.title = clean;
      s.claudeAutoTitle = clean;
      // Persist server-side so reloads / session-updated echoes stay consistent.
      ipcRenderer.invoke('rename-session', { sessionId, title: clean, userRenamed: false });
    });
  }

  // Intercept Ctrl/Cmd+V ourselves (both text and image) — Electron's Chromium
  // doesn't fire paste events on xterm's helper textarea for real keystrokes.
  terminal.attachCustomKeyEventHandler((e) => {
    if (e.type !== 'keydown') return true;
    if (['PageUp', 'PageDown', 'Home', 'End'].includes(e.key)) {
      markCodexUserScrollIntent(sessionId, terminalCache.get(sessionId), {
        detachFromBottom: e.key === 'PageUp' || e.key === 'Home',
        attachToBottom: e.key === 'End',
      });
    }

    // --- Word-like selection editing on the input line ---
    if (terminal.hasSelection()) {
      const inputSel = getInputLineSelection(terminal);
      if (inputSel && inputSel.text.length > 0) {
        if (e.key === 'Backspace' || e.key === 'Delete') {
          e.preventDefault();
          deleteInputSelection(terminal, sessionId);
          return false;
        }
        if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && (e.key === 'x' || e.key === 'X')) {
          e.preventDefault();
          void clipboardController.copyText(inputSel.text,{source:'terminal-cut'}).then(result=>{
            if (result.ok && getInputLineSelection(terminal)?.text === inputSel.text) deleteInputSelection(terminal, sessionId);
          });
          return false;
        }
        if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && (e.key === 'v' || e.key === 'V')) {
          e.preventDefault();
          handlePasteForSession(sessionId,{beforePaste:()=>deleteInputSelection(terminal,sessionId)});
          return false;
        }
        if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
          e.preventDefault();
          deleteInputSelection(terminal, sessionId, e.key);
          return false;
        }
      }
    }

    const mod = e.ctrlKey || e.metaKey;
    if (!mod || e.altKey) return true;

    // Ctrl+Up / Ctrl+Down — jump between user prompts
    if (!e.shiftKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      const c = terminalCache.get(sessionId);
      if (!c || !c._minimap) return true;
      if (isCodexOwnedTranscript(sessions.get(sessionId), terminal)) return true;
      const moved = e.key === 'ArrowUp' ? c._minimap.navPrev() : c._minimap.navNext();
      if (moved) {
        e.preventDefault();
        return false;
      }
      return true;
    }

    // Ctrl+V — paste (text or image)
    if (!e.shiftKey && (e.key === 'v' || e.key === 'V')) {
      e.preventDefault();
      handlePasteForSession(sessionId);
      return false;
    }
    // Ctrl+Shift+C — always copy selection (VSCode/Windows Terminal style)
    if (e.shiftKey && (e.key === 'C' || e.key === 'c')) {
      if (terminal.hasSelection()) {
        void clipboardController.copyText(terminal.getSelection(), { source: 'terminal' });
        e.preventDefault();
        return false;
      }
      return true;
    }
    // Ctrl+C — copy if there's a selection, else interrupt the current turn.
    if (!e.shiftKey && (e.key === 'c' || e.key === 'C')) {
      if (terminal.hasSelection()) {
        void clipboardController.copyText(terminal.getSelection(), { source: 'terminal' });
        e.preventDefault();
        return false;
      }
      // Native Claude has no PTY to send \x03 down: terminal.onData returns
      // early for this backend, so before this branch the key was swallowed in
      // the renderer and Ctrl+C did nothing at all -- no interrupt, no error.
      // Route it to the same control the ■ button uses. Codex native already
      // does the equivalent inside its own session (codex-native-session.js).
      if (sessions.get(sessionId)?.runtimeBackend === 'claude-stream-json') {
        e.preventDefault();
        void interruptNativeClaudeSession(sessionId);
        return false;
      }
      return true; // PTY sessions: xterm still sends it as SIGINT.
    }
    return true;
  });

  const container = document.createElement('div');
  container.style.cssText = 'width:100%;height:100%;display:none';

  const routeCodexTranscriptWheel = require('./codex-transcript-wheel').createCodexTranscriptWheelRouter({
    terminal,
    ownsTranscript: () => isCodexOwnedTranscript(sessions.get(sessionId), terminal),
    WheelEvent: window.WheelEvent,
  });
  require('./codex-transcript-touch').attachCodexTranscriptTouch({
    container, terminal,
    ownsTranscript: () => isCodexOwnedTranscript(sessions.get(sessionId), terminal),
    WheelEvent: window.WheelEvent,
  });
  terminal.attachCustomWheelEventHandler((event) => {
    if (routeCodexTranscriptWheel(event)) return false;
    if (!isNativeAgent(sessions.get(sessionId)) || event.ctrlKey || event.metaKey) return true;
    const viewport = terminal._core?.viewport;
    if (!viewport?.getLinesScrolled) return true;
    // Native backends display a plain output log. Scroll its logical buffer
    // directly: xterm's deferred DOM scroll event can be swallowed by a
    // concurrent replay/viewport sync and leave the reader pinned at the end.
    const lines = viewport.getLinesScrolled(event);
    if (!lines) return true;
    markCodexUserScrollIntent(sessionId, terminalCache.get(sessionId), { detachFromBottom: lines < 0 });
    terminal.scrollLines(lines);
    event.preventDefault();
    return false;
  });

  // Drag-and-drop: dropping a file/folder into the terminal inserts its path(s).
  container.addEventListener('dragover', (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; });
  container.addEventListener('drop', (e) => {
    e.preventDefault();
    const files = Array.from(e.dataTransfer.files || []);
    if (files.length === 0) return;
    const quoted = files.map(f => {
      const p = f.path;
      return /\s/.test(p) ? `"${p}"` : p;
    }).join(' ');
    terminal.paste(quoted);
  });

  // Ctrl+wheel zoom — passive so xterm's own wheel-scroll stays on the
  // compositor thread. Chromium still lets us observe the event; we just
  // can't preventDefault. The browser's page-zoom on Ctrl+wheel is already
  // disabled globally in Electron for non-text areas.
  container.addEventListener('wheel', (e) => {
    if (window.__scrollDebug && window.__scrollDebug.isOn()) {
      window.__scrollDebug.log('wheel:before', { deltaY: e.deltaY, mode: e.deltaMode, ctrl: !!e.ctrlKey, ...window.__scrollDebug.snap(terminal, sessionId) });
      requestAnimationFrame(() => {
        window.__scrollDebug.log('wheel:after-raf', window.__scrollDebug.snap(terminal, sessionId));
      });
    }
    if (!e.ctrlKey && !e.metaKey) {
      const c = terminalCache.get(sessionId);
      markCodexUserScrollIntent(sessionId, c, { detachFromBottom: e.deltaY < 0 });
      updateCodexFollowBottomFromUserScroll(sessionId, c);
      return;
    }
    const delta = e.deltaY < 0 ? 1 : -1;
    setTerminalFontSize(currentTerminalFontSize + delta);
  }, { passive: true });

  container.addEventListener('pointerdown', () => {
    markCodexUserScrollIntent(sessionId, terminalCache.get(sessionId));
  }, { passive: true });

  container.addEventListener('mousedown', () => {
    markCodexUserScrollIntent(sessionId, terminalCache.get(sessionId));
  }, { passive: true });

  container.addEventListener('touchstart', () => {
    markCodexUserScrollIntent(sessionId, terminalCache.get(sessionId));
  }, { passive: true });

  // Click-to-position: clicking on the cursor's row sends arrow-key
  // sequences so the PTY moves the cursor to the clicked column.
  // We track where we last sent the cursor so rapid successive clicks
  // don't misfire when the PTY is still redrawing the input line
  // (cursorX briefly passes through 0 during redraws).
  let sentCursorCol = null;
  let sentCursorTimer = null;

  container.addEventListener('click', (e) => {
    if (terminal.hasSelection()) return;
    const coords = getTerminalCoords(terminal, container, e);
    if (!coords) return;

    const buf = terminal.buffer.active;
    const cursorAbsRow = buf.baseY + buf.cursorY;
    if (coords.row !== cursorAbsRow) return;

    const cursorCol = sentCursorCol ?? buf.cursorX;
    const diff = coords.col - cursorCol;
    if (diff === 0) { sentCursorCol = null; return; }

    sentCursorCol = coords.col;
    clearTimeout(sentCursorTimer);
    sentCursorTimer = setTimeout(() => { sentCursorCol = null; }, 300);

    const arrow = diff > 0 ? '\x1b[C' : '\x1b[D';
    const seq = arrow.repeat(Math.abs(diff));
    ipcRenderer.send('terminal-input', { sessionId, data: seq });
  });

  // Right-click: show "Preview" option when text is selected
  container.addEventListener('contextmenu', (e) => {
    const sel = terminal.getSelection().trim();
    if (!sel) return;
    e.preventDefault();
    openTerminalContextMenu(sel, e.clientX, e.clientY);
  });

  const cached = {
    terminal, fitAddon, searchAddon, container, opened: false,
    // 换主题时按会话种类重选终端配色（见 theme-controller.resolveXtermOptions）。
    kind: sessions.get(sessionId)?.kind || '',
    _codexFollowBottom: true,
    _hydrated: false,
    _hydrating: false,
    _hydratedSeq: 0,
    _pendingOutput: [],
    _pendingOutputBytes: 0,
    _localPathLinkProvider: localPathLinkProvider,
    _deferredResizeSig: null,
    _needsPtyRedraw: false,
  };
  terminalCache.set(sessionId, cached);
  return cached;
}

// ── T6 冷杉 v2 · 统一工具栏 ────────────────────────────────────────────────
// 原生标题栏隐掉之后，#app-toolbar 就是窗口最顶上那 44px：它既是标题栏
// （可拖动、双击最大化），也是 T2 那条舞台头部的常驻版。舞台从此没有头部，
// 终端直接顶到卡片顶边。
//
// 为什么面包屑要「按屏幕反推」而不是「谁切视图谁通知」：主页 / 投研 / 学习 /
// 开发 / 群聊的切换分散在 shell-controller、study.js、ran.js、xresearch.js、
// meeting-room.js 好几处。逐个插一行刷新调用，只要将来有人新增一个视图忘了插，
// 工具栏就会停在上一个会话上 —— 那种 bug 不会有人报，只会让人觉得界面「有点不对」。
// 所以这里只认一件事实：现在屏幕上哪块主面板是可见的。
const toolbarCrumbEl = document.getElementById('toolbar-crumb');
const toolbarActionsEl = document.getElementById('toolbar-actions');
const backstageButton = document.getElementById('btn-backstage');
const turnSpeedDisplay = require('./turn-speed-display').createTurnSpeedDisplay(document,
  id => sessions.get(id), () => sessionSplit?.focusedId() || activeSessionId);
let sessionImmersive = null;
function syncBackstageButton(visible = !currentAppToolbarView() && !!activeSessionId) {
  sessionImmersive?.sync(!!getReadingSurface());
  if (!backstageButton) return;
  const mode = sessionSplit?.isSecondaryFocused() ? sessionSplit.secondary().mode() : currentView;
  backstageButton.hidden = !visible;
  backstageButton.setAttribute('aria-pressed', String(mode === 'pty'));
  backstageButton.title = mode === 'pty' ? '返回卡片视图' : '查看后台输出';
  turnSpeedDisplay.paint(visible);
}

const appToolbarEl = document.getElementById('app-toolbar');

// 面板 → 视图名。预览面板之类的附属层不参与，只看主区那几块。
const APP_TOOLBAR_VIEWS = [
  { id: 'xresearch-panel', label: '投研' },
  { id: 'study-panel', label: '学习' },
  { id: 'ran-panel', label: '开发' },
  { id: 'writing-panel', label: '写作' },
  { id: 'meeting-room-panel', label: '群聊' },
];

function getReadingSurface() {
  // Detached full-page tabs are above the session stage. Keep their mounted
  // controls and content instead of copying them into a fullscreen shell.
  for (const id of ['assistant-page', 'account-page', 'hub-workspace', 'memo-panel', ...APP_TOOLBAR_VIEWS.map(v => v.id)]) {
    const panel = document.getElementById(id);
    if (panelIsVisible(panel)) return panel;
  }
  return sessionSplit?.isSecondaryFocused() ? document.querySelector('.split-secondary') : terminalPanelEl;
}
function getReadingIdentity() {
  const surface = getReadingSurface();
  return surface === terminalPanelEl || surface?.classList.contains('split-secondary')
    ? getFocusedSessionId() || 'home' : surface?.id;
}

function panelIsVisible(el) {
  if (!el) return false;
  if (el.hidden) return false;
  if (el.style && el.style.display === 'none') return false;
  // study / ran 的骨架是脚本自建的，没内容时就是个空 div —— 空的不算「在看它」。
  return el.offsetParent !== null || el.getBoundingClientRect().height > 0;
}

// 非会话视图：面包屑只写视图名，动作区整块收起来 —— 文件 / 记忆 / ⋯ / 关闭会话
// 这四个动作全都是对「某一个会话」做的，主页上没有会话可做。
function paintAppToolbarForView(label) {
  if (label !== '助理') window.__assistantHide?.();
  if (!toolbarCrumbEl || !toolbarActionsEl) return;
  toolbarCrumbEl.dataset.mode = 'view';
  toolbarCrumbEl.title = '';
  toolbarActionsEl.replaceChildren();
  toolbarActionsEl.hidden = true;
  syncBackstageButton(false);
  const researchVersion = label === '投研' ? (window.__xresearchVersionInfo || {}) : null;
  const signature = 'view:' + label + (researchVersion ? JSON.stringify(researchVersion) : '');
  if (toolbarCrumbEl.dataset.signature === signature) return;
  toolbarCrumbEl.dataset.signature = signature;
  toolbarCrumbEl.replaceChildren();
  const name = document.createElement('span');
  name.className = 'crumb-view-name';
  name.textContent = label;
  toolbarCrumbEl.appendChild(name);
  if (researchVersion) {
    const version = document.createElement('button');
    version.type = 'button';
    version.className = 'cx-ui-version';
    version.textContent = researchVersion.loaded ? 'UI ' + researchVersion.loaded : '版本待确认';
    if (researchVersion.available && researchVersion.available !== researchVersion.loaded) {
      version.textContent += ' · 更新至 ' + researchVersion.available;
    }
    version.title = '点击刷新投研页面，保留当前栏目。' + (researchVersion.error || '');
    version.setAttribute('aria-label', version.textContent + '，点击刷新投研页面');
    version.addEventListener('click', () => window.__xresearchRefresh?.());
    toolbarCrumbEl.appendChild(version);
  }
}

// 会话视图。下面这一整段就是 T2 的舞台头部原样搬上来的：面包屑三段 + 状态点、
// ⋯ 溢出菜单、文件 / 记忆 / ⋯ / 关闭四个动作。改的只是「填进哪两个常驻节点」。
function paintAppToolbarForSession(sessionId, session, cached) {
  if (!toolbarCrumbEl || !toolbarActionsEl) return;
  syncBackstageButton(true);
  toolbarCrumbEl.dataset.signature = 'session:' + sessionId;
  // T2 冷杉 v2 · 面包屑：头部只回答「我在哪、看什么、能做什么」。
  // 工作区 › 会话标题 + 6px 状态点，整条 hover 给完整 cwd。
  const crumb = toolbarCrumbEl;
  crumb.replaceChildren();
  crumb.dataset.mode = 'session';
  crumb.title = session.cwd || '';

  const workspaceBtn = document.createElement('button');
  workspaceBtn.type = 'button';
  workspaceBtn.className = 'crumb-workspace';
  paintCrumbWorkspace(workspaceBtn, session);

  const crumbSep = document.createElement('span');
  crumbSep.className = 'crumb-sep';
  crumbSep.textContent = '›';
  crumbSep.setAttribute('aria-hidden', 'true');

  const titleSpan = document.createElement('span');
  titleSpan.className = 'terminal-title';
  titleSpan.textContent = session.title;
  // title 属性刻意留空：HTML tooltip 会往上找祖先，空着才轮得到 .terminal-crumb
  // 那条「完整 cwd」。重命名这件事改用 aria-label + hover 虚下划线表达。
  const titleReadOnly = session.readOnly;
  titleSpan.setAttribute('aria-label', titleReadOnly ? '同步查看会话' : `${session.title} · 点击重命名`);
  if (titleReadOnly) titleSpan.classList.add('is-readonly');
  if (!titleReadOnly) titleSpan.addEventListener('click', () => startRename(sessionId, titleSpan));

  // 状态点：runtime truth 的四色（绿 / 琥珀 / 红 / 灰），title 给 runtimeLabel。
  const statusDot = document.createElement('span');
  statusDot.className = 'terminal-crumb-dot';
  statusDot.setAttribute('role', 'status');
  statusDot.setAttribute('aria-live', 'polite');
  statusDot.setAttribute('aria-atomic', 'false');
  paintTerminalRuntimeStatus(statusDot, session);

  crumb.append(workspaceBtn, crumbSep, titleSpan, statusDot);

  // 2026-07-19 maintainer · 方案C：A−/A+ 低频缩放折叠进 ⋯ 溢出菜单（顶栏 8 控件 → 5 个）
  const overflowWrap = document.createElement('div');
  overflowWrap.className = 'header-overflow-wrap';
  const overflowBtn = document.createElement('button');
  overflowBtn.className = 'btn-zoom';
  overflowBtn.textContent = '⋯';
  overflowBtn.title = '更多（界面缩放）';
  overflowBtn.setAttribute('aria-label', '更多操作');
  const overflowMenu = document.createElement('div');
  overflowMenu.className = 'header-overflow-menu';
  overflowMenu.style.display = 'none';
  const mkOverflowItem = (label, key, fn) => {
    const b = document.createElement('button');
    const lbl = document.createElement('span');
    lbl.textContent = label;
    const kbd = document.createElement('span');
    kbd.className = 'ho-key';
    kbd.textContent = key;
    b.append(lbl, kbd);
    b._hoKey = kbd;
    b.addEventListener('click', (ev) => {
      ev.stopPropagation();
      overflowMenu.style.display = 'none';
      fn();
    });
    return b;
  };
  // 完成通知：开关逻辑仍然只有 completion-notification-toggle 一个作者，
  // 菜单项只镜像它的 data-state 并转发点击；浮层节点本身由 CSS 隐藏。
  // 复制一份 IPC 判据 = 两处迟早说出互相矛盾的开关状态。
  const notificationToggleEl = document.getElementById('completion-notification-toggle');
  const notifyItem = mkOverflowItem('完成通知', '', () => {
    if (notificationToggleEl) notificationToggleEl.click();
  });
  notifyItem.className = 'ho-notify';
  notifyItem.setAttribute('role', 'menuitemcheckbox');
  const syncNotifyItem = () => {
    const state = notificationToggleEl
      ? String(notificationToggleEl.dataset.state || 'unconfigured')
      : 'unavailable';
    notifyItem.dataset.state = state;
    notifyItem.setAttribute('aria-checked', String(state === 'enabled'));
    notifyItem._hoKey.textContent = state === 'enabled'
      ? '开'
      : (state === 'disabled' ? '关' : (state === 'unavailable' ? '不可用' : '未配'));
    notifyItem.title = (notificationToggleEl && notificationToggleEl.title) || '';
  };
  syncNotifyItem();
  overflowMenu.append(
    mkOverflowItem('放大界面', 'A+', () => applyZoom(currentZoom + 1)),
    mkOverflowItem('缩小界面', 'A−', () => applyZoom(currentZoom - 1)),
    mkOverflowItem('重置缩放', '1:1', () => applyZoom(0)),
    notifyItem,
  );
  overflowBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const opening = overflowMenu.style.display === 'none';
    // 开菜单那一刻才读开关状态：通知配置随时可能被设置页改掉，
    // 菜单常年挂在 DOM 上，不重读就会展示一个过期的「开」。
    if (opening) syncNotifyItem();
    overflowMenu.style.display = opening ? 'block' : 'none';
  });
  if (cached._overflowDocHandler) document.removeEventListener('click', cached._overflowDocHandler);
  cached._overflowDocHandler = () => { overflowMenu.style.display = 'none'; };
  document.addEventListener('click', cached._overflowDocHandler);
  overflowWrap.append(overflowBtn, overflowMenu);

  const closeBtn = document.createElement('button');
  closeBtn.className = 'btn-close-session';
  const closeLabel = supportsRecoverableSessionKind(session) ? '关闭并休眠' : '关闭';
  closeBtn.title = `${closeLabel}（Ctrl+W）`;
  closeBtn.setAttribute('aria-label', closeLabel);
  closeBtn.innerHTML = '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" fill="none"/></svg>';
  closeBtn.addEventListener('click', () => { void closeSessionAsSleep(sessionId); });

  const headerActions = toolbarActionsEl;
  headerActions.replaceChildren();
  headerActions.hidden = false;

  const filesBtn = document.createElement('button');
  filesBtn.className = 'btn-zoom btn-header-tool btn-file-manager-toggle';
  filesBtn.dataset.root = session.cwd || '';
  filesBtn.disabled = !session.cwd;
  filesBtn.setAttribute('aria-pressed', String(!!(fileManagerPanel && fileManagerPanel.isOpenFor(session.cwd))));
  filesBtn.setAttribute('aria-label', '打开当前工作目录的文件管理');
  filesBtn.title = session.cwd ? `文件管理 · ${session.cwd}` : '当前会话没有工作目录';
  // 图标按钮：文字标签 T2 去掉（面包屑已经把「在哪」说清楚了），只留 28px 图标。
  filesBtn.innerHTML = '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M1.8 4.4A1.4 1.4 0 0 1 3.2 3h3l1.3 1.4h5.3a1.4 1.4 0 0 1 1.4 1.4v6a1.4 1.4 0 0 1-1.4 1.4H3.2a1.4 1.4 0 0 1-1.4-1.4Z"/><path d="M5 7.2h6M5 9.5h4"/></svg>';
  filesBtn.addEventListener('click', () => openSessionFilePanel(session));

  headerActions.append(filesBtn, overflowWrap, closeBtn);
  window.__assistantSync?.(session);
}

function currentAppToolbarView() {
  for (const [id, label] of [['assistant-page', '助理'], ['account-page', '账号'], ['hub-workspace', '资源与回顾'], ['memo-panel', '速记']]) {
    if (panelIsVisible(document.getElementById(id))) return label;
  }
  for (const view of APP_TOOLBAR_VIEWS) {
    if (panelIsVisible(document.getElementById(view.id))) return view.label;
  }
  if (terminalPanelEl && terminalPanelEl.classList.contains('home-active')) return '主页';
  return null;
}

// 工具栏的唯一入口：先看是不是某个非会话视图，不是才当会话视图画。
function refreshAppToolbar() {
  if (!toolbarCrumbEl) return;
  sessionSplit?.sync();
  const viewLabel = currentAppToolbarView();
  if (viewLabel) { paintAppToolbarForView(viewLabel); return; }
  const focusedId = sessionSplit?.focusedId() || activeSessionId;
  const session = focusedId ? sessions.get(focusedId) : null;
  const cached = focusedId ? terminalCache.get(focusedId) : null;
  // 会话还没建好终端时不硬画一个半成品头部，按主页处理，等 showTerminal 补上。
  if (!session || !cached) { paintAppToolbarForView('主页'); return; }
  paintAppToolbarForSession(focusedId, session, cached);
}

let _appToolbarRefreshRaf = null;
window.addEventListener('xresearch-version-changed', scheduleAppToolbarRefresh);
function scheduleAppToolbarRefresh() {
  if (_appToolbarRefreshRaf) return;
  _appToolbarRefreshRaf = requestAnimationFrame(() => {
    _appToolbarRefreshRaf = null;
    try { refreshAppToolbar(); } catch (error) {
      console.warn('[app-toolbar] refresh failed:', error && error.message);
    }
  });
}

// 面板的 display / class 一变就重算。合并到一帧里：切视图那一瞬间几块面板会
// 连着改好几次属性，不合并等于同一帧内重画七八遍。
if (typeof MutationObserver === 'function') {
  const _appToolbarObserver = new MutationObserver(scheduleAppToolbarRefresh);
  for (const el of [terminalPanelEl, ...APP_TOOLBAR_VIEWS.map(v => document.getElementById(v.id))]) {
    if (el) _appToolbarObserver.observe(el, { attributes: true, attributeFilter: ['style', 'class', 'hidden'] });
  }
  // These tabs mount outside app-body. Watch only their own visibility, never
  // streamed text or every descendant mutation.
  const watchReadingTabs = () => {
    for (const id of ['assistant-page', 'account-page', 'hub-workspace', 'memo-panel']) {
      const el = document.getElementById(id);
      if (el) _appToolbarObserver.observe(el, { attributes: true, attributeFilter: ['style', 'class', 'hidden'] });
    }
    scheduleAppToolbarRefresh();
  };
  new MutationObserver(watchReadingTabs).observe(document.body, { childList: true });
  watchReadingTabs();
}

// Header logo opens another independent Hub process, like the taskbar task.
const btnNewHub = document.getElementById('btn-new-hub');
btnNewHub.addEventListener('click', async (event) => {
  if (btnNewHub.disabled || event.detail > 1) return;
  btnNewHub.disabled = true;
  btnNewHub.setAttribute('aria-busy', 'true');
  try {
    await ipcRenderer.invoke('hub:new-instance');
  } catch (error) {
    console.error('[hub-instance] launch failed:', error);
    require('./ui-feedback').showHubAlert(`新建 AI Hub 失败：${error.message || error}`);
  } finally {
    btnNewHub.disabled = false;
    btnNewHub.removeAttribute('aria-busy');
  }
});

// 双击工具栏空白处最大化 / 还原。控件上的双击不改变窗口大小。
if (appToolbarEl) {
  appToolbarEl.addEventListener('dblclick', (event) => {
    if (event.target.closest('button, a, input, select, .terminal-crumb, .view-toggle')) return;
    void ipcRenderer.invoke('hub:toggle-maximize').catch(() => {});
  });
}

// 窗口按钮区的底色 / 符号色跟着皮肤走。颜色在这里读**当前皮肤真实算出来的值**
// 再发给主进程，主进程不另存一份调色板 —— 否则加一套皮肤要改两个地方，
// 而那两个地方没有任何机制保证它们一致。
function syncTitleBarOverlayColors() {
  try {
    const probe = getComputedStyle(document.documentElement);
    const pick = (...names) => {
      for (const name of names) {
        const value = String(probe.getPropertyValue(name) || '').trim();
        if (/^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(value)) return value;
      }
      return '';
    };
    ipcRenderer.send('hub:titlebar-overlay', {
      color: pick('--surface-raised', '--bg-secondary'),
      symbolColor: pick('--fg-muted', '--text-secondary'),
    });
  } catch (error) {
    console.warn('[app-toolbar] titlebar overlay sync failed:', error && error.message);
  }
}

if (typeof MutationObserver === 'function') {
  // theme-controller.js 只负责把 data-theme 写到 <html> 上（本轮不能改它），
  // 所以这里盯那个属性，而不是去它内部挂回调。
  new MutationObserver(syncTitleBarOverlayColors)
    .observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
}

// 原生标题栏逃生口：渲染进程开着 nodeIntegration，直接读同一个 env 就够了，
// 不必为一个布尔值再走一趟 IPC。
if (process && process.env && process.env.CLAUDE_HUB_NATIVE_TITLEBAR === '1') {
  appContainerEl.classList.add('native-titlebar');
}

// 最大化状态由主进程给（渲染层自己量不准：窗口比屏幕大出的那一圈在页面坐标里
// 是看不见的）。补偿量落在 CSS 变量上，量出来不需要补时它就是 0。
ipcRenderer.on('hub:window-state', (_event, state) => {
  const maximized = !!(state && state.maximized);
  appContainerEl.classList.toggle('window-maximized', maximized);
  document.getElementById('hub-version').textContent = state?.version ? 'v' + state.version : '';
  document.getElementById('hub-pid').textContent = Number.isInteger(state?.pid) ? 'PID: ' + state.pid : '';
});
ipcRenderer.on('codex-focus-session', (_event, payload = {}) => {
  const sessionId = typeof payload.sessionId === 'string' ? payload.sessionId : '';
  if (sessionId && sessions.has(sessionId)) void selectSession(sessionId, { forceScrollBottom:true });
});

// 系统窗口按钮到底占多宽，Windows 自己最清楚：WCO 报得出就用真值，
// 用户改过系统缩放或将来按钮数量变了都不用回来改常量。
// 但只认「像那么回事」的数：CDP 改过设备尺寸时窗口坐标和页面坐标不是一回事，
// 算出来会是 376 这种离谱值 —— 宁可用回默认的 138px，也不要一条测出来的布局
// 和用户看到的不是同一个。
function syncWindowControlsWidth() {
  const wco = typeof navigator !== 'undefined' ? navigator.windowControlsOverlay : null;
  if (!wco || !wco.visible || typeof wco.getTitlebarAreaRect !== 'function') return;
  const rect = wco.getTitlebarAreaRect();
  const width = Math.round(window.innerWidth - rect.width - rect.x);
  if (!Number.isFinite(width) || width < 100 || width > 220) return;
  appContainerEl.style.setProperty('--app-window-controls-w', `${width}px`);
}
if (typeof navigator !== 'undefined' && navigator.windowControlsOverlay
    && typeof navigator.windowControlsOverlay.addEventListener === 'function') {
  navigator.windowControlsOverlay.addEventListener('geometrychange', syncWindowControlsWidth);
}
syncWindowControlsWidth();
syncTitleBarOverlayColors();
scheduleAppToolbarRefresh();

function showTerminal(sessionId, opts = { focus: true }) {
  for (const [sid, entry] of terminalCache) if (sid !== sessionId && !sessionSplit?.isVisible(sid)) entry._codexBackstage?.setVisible(false);
  suspendInactiveTerminalRenderers(sessionId);

  const session = sessions.get(sessionId);
  if (!session) return;
  const existingInput = terminalPanelEl.querySelector('.floating-input-bar');
  if (opts.reuseCardHistory && !opts.mountTarget && currentView === 'card'
      && existingInput?.dataset.sessionId === sessionId && cardHistoryViews.ready(session)) {
    if (opts.forceScrollBottom) cardFollowScroll.follow();
    if (opts.focus) existingInput.querySelector('.floating-input-box')?.focus();
    return;
  }

  const cached = getOrCreateTerminal(sessionId);
  const mountTarget = opts && opts.mountTarget ? opts.mountTarget : terminalPanelEl;
  const embedded = mountTarget !== terminalPanelEl;
  if (embedded) { cached._codexBackstage?.setVisible(false);cached._backstageReadable=false; }
  if (cached._ptyPresentation) { cached._ptyPresentation.dispose(); cached._ptyPresentation = null; }
  if (!embedded) terminalPanelEl.classList.remove('home-active');
  if (!embedded) cardFollowScroll.activate(sessionId, { force: !!opts.forceScrollBottom });
  // Save the outgoing cards before rebuilding the composer. Keeping thousands
  // of old Markdown nodes attached makes every chrome measurement lay out the
  // old conversation again. The history cache retains their DOM/disclosures;
  // the normal history load restores the selected view after chrome is ready.
  if (!embedded && !cardHistoryViews.ready(session)) cardHistoryViews.suspend();

  // Preserve spec 1/2 elements that live inside #terminal-panel (view-toggle, msg-overlay)
  // before innerHTML clear obliterates them; re-attach after.
  if (embedded) mountTarget.replaceChildren();
  else preserveAndClearTerminalPanel();

  // T6：舞台不再自己画头部 —— 面包屑和四个动作都在窗口顶部那条常驻工具栏上。
  // 嵌入模式（扩展投研把同一套 xterm 挂到别的容器里）没有工具栏可填，跳过。
  if (!embedded) paintAppToolbarForSession(sessionId, session, cached);

  // 普通 Session 的用量归 composer；嵌入式投研仍保留自己的指标。
  if (embedded) {
    const metricsOverlay = document.createElement('div');
    metricsOverlay.className = 'terminal-metrics';
    renderMetricsRow(metricsOverlay, session);
    mountTarget.append(metricsOverlay);
  }

  const termContainer = document.createElement('div');
  termContainer.className = 'terminal-container';
  termContainer.addEventListener('click', () => cached.terminal.focus());

  mountTarget.append(termContainer);
  if (!embedded && fileManagerPanel) {
    void fileManagerPanel.syncContext({ cwd: session.cwd, label: session.workspaceLabel, sessionStartedAt: Number(session.spawnedAt) || 0 });
  }
  if (!embedded) emptyStateEl.style.display = 'none';

  if (!termContainer.contains(cached.container)) {
    termContainer.appendChild(cached.container);
  }
  cached.container.style.display = 'block';

  if (!cached.opened) {
    cached.terminal.open(cached.container);
    cached.opened = true;
    setupImageHover(cached.terminal, cached.container);
    void hydrateTerminalFromSnapshot(sessionId, cached);
  }
  // Card navigation does not display xterm. Recreating its Canvas/WebGL
  // surface here costs a frame and can stall Windows compositor commits.
  if (embedded || currentView === 'pty') loadGpuRenderer(cached);
  else unloadGpuRenderer(cached);
  // Behind the opaque cards a visible xterm still paints with its DOM fallback
  // renderer and measures every new glyph: on 2026-10-08 one click on a
  // CJK-heavy Claude session froze the window for 993 ms in xterm _measure.
  // Hide it exactly like inactive terminals; it keeps parsing output into its
  // buffer, and applyViewMode('pty') shows it and runs the visible recovery.
  // It is opened (and measured) above while still displayed.
  if (!embedded) setCardHiddenTerminal(cached, currentView !== 'pty');
  if (isCodexKind(session.kind) && !isNativeAgent(session)) {
    cached._codexAnswerAccent ||= require('./codex-answer-accent').mountCodexAnswerAccent(cached.terminal, document);
    cached._codexAnswerAccent.refresh();
  }
  setupCodexViewportScrollTracker(sessionId, cached);

  if (!embedded) {
    cached._ptyPresentation = mountTerminalPresentation({
      document, host: termContainer, cached, native: isNativeAgent(session), readOnly: session.readOnly,
      openingBanner: require('../core/native-ui-labels').nativeOpeningBanner(session),
      engine: require('../core/native-ui-labels').nativeUiLabel(session),
      focusComposer: () => mountTarget.querySelector('.floating-input-box')?.focus(),
    });
    if ((isNativeSession(session) && ['codex','codex-resume'].includes(session.kind)) || ['claude-stream-json','acp'].includes(session.runtimeBackend)) {
      cached._codexBackstage ||= createCodexBackstage({ document, ipcRenderer, sessionId,
        getSession:() => sessions.get(sessionId),
        renderProse:text => DOMPurify.sanitize(marked.parse(text, {async:false}), {FORBID_TAGS:['img','video','audio','iframe']}),
        onModeChange:mode => { cached._backstageReadable=mode!=='legacy';if(cached._backstageReadable || currentView !== 'pty')unloadGpuRenderer(cached);else loadGpuRenderer(cached); },
        focusComposer:() => mountTarget.querySelector('.floating-input-box')?.focus() });
      cached._codexBackstage.mount(termContainer);
      cached._codexBackstage.setVisible(currentView === 'pty', {force:!!opts.forceScrollBottom});
    }
  }

  requestAnimationFrame(() => {
    // Card navigation must not fit/redraw an invisible CLI, or resize a
    // session which a later click has already unmounted. Entering backstage
    // runs scheduleVisibleTerminalRecovery with the final visible geometry.
    if (!termContainer.isConnected || (!embedded && (activeSessionId !== sessionId || currentView !== 'pty'))) return;
    const dbg = window.__scrollDebug;
    if (dbg && dbg.isOn()) dbg.log('show:raf-enter', { focus: opts.focus, ...dbg.snap(cached.terminal, sessionId) });
    const forcePtyResize = cached._hydrated && cached._needsPtyRedraw;
    fitAndResizeTerminal(sessionId, cached, { force: true, forcePtyResize });
    if (forcePtyResize) cached._needsPtyRedraw = false;
    refreshTerminalRendererSurface(cached);
    if (dbg && dbg.isOn()) dbg.log('show:after-fit', dbg.snap(cached.terminal, sessionId));
    const nativeKind = isNativeAgent(session) || isCodexKind(session.kind);
    const pinOnShow = !!opts.forceScrollBottom || (!nativeKind && !!opts.focus);
    if (pinOnShow || opts.focus) {
      if (opts.forceScrollBottom) cached._codexFollowBottom = true;
      if (pinOnShow) cached.terminal.scrollToBottom();
      if (dbg && dbg.isOn()) dbg.log('show:after-stb', dbg.snap(cached.terminal, sessionId));
      // A delayed layout frame must not take focus from a card selection or
      // its composer after the user has switched away from the PTY surface.
      if (opts.focus && (embedded || currentView === 'pty')) cached.terminal.focus();
      const vp = cached.container.querySelector('.xterm-viewport');
      if (pinOnShow && vp) vp.scrollTop = vp.scrollHeight;
      if (dbg && dbg.isOn()) dbg.log('show:after-vp1', dbg.snap(cached.terminal, sessionId));

      // Ask xterm's Viewport to sync its inner .xterm-scroll-area height with
      // the buffer length. Without this, a session that grew while display:none
      // can have a stale (short) scrollHeight, causing wheel to max out before
      // the real buffer tail. The instance lives at `_core.viewport` in xterm
      // 5.5 (the previous attempt used `_viewport` which doesn't exist).
      // Do NOT manually set .xterm-scroll-area's height — _charSizeService.height
      // is character height, not line height (line-height multiplier missing),
      // so manual recomputation undershoots and breaks scrollHeight further.
      try {
        const vpInst = cached.terminal && cached.terminal._core && cached.terminal._core.viewport;
        if (vpInst && typeof vpInst.syncScrollArea === 'function') {
          vpInst.syncScrollArea(true);
        }
      } catch {}
      if (dbg && dbg.isOn()) dbg.log('show:after-refresh', dbg.snap(cached.terminal, sessionId));
      requestAnimationFrame(() => {
        if (pinOnShow && vp) vp.scrollTop = vp.scrollHeight;
        // Re-pin xterm's logical viewport too (scrollToBottom may have been
        // a no-op the first time when scrollArea was still stale).
        if (pinOnShow) {
          try { cached.terminal.scrollToBottom(); } catch {}
        }
        if (dbg && dbg.isOn()) dbg.log('show:raf2-final', dbg.snap(cached.terminal, sessionId));
      });
    }
  });
  scheduleVisibleTerminalRecovery(sessionId, cached, {
    pinBottom: !!opts.forceScrollBottom,
  });

  if (cached._ro) cached._ro.disconnect();
  if (cached._resizeHandler) window.removeEventListener('resize', cached._resizeHandler);
  const handleResize = () => {
    // Guard: ResizeObserver/resize can fire while the terminal's parent panel
    // is display:none (e.g. another workspace panel is active). Fitting against a zero-width
    // container collapses xterm to the minimum 1 col and the canvas stays
    // squeezed even after the panel re-opens.
    scheduleFitAndResizeTerminal(sessionId, cached);
  };
  cached._resizeHandler = handleResize;
  window.addEventListener('resize', handleResize);
  cached._ro = new ResizeObserver(handleResize);
  cached._ro.observe(cached.container);

  // Previous minimap (from a prior showTerminal call on any session) gets
  // disposed so xterm onScroll/onRender listeners don't pile up. The new
  // minimap's DOM was already removed when terminalPanelEl.innerHTML cleared.
  if (cached._minimap) { try { cached._minimap.dispose(); } catch {} cached._minimap = null; }
  if (cached._navButtons) { try { cached._navButtons.dispose(); } catch {} cached._navButtons = null; }
  cached._minimap = mountMinimap(sessionId, termContainer, cached.terminal);
  cached._navButtons = mountPromptNavButtons(sessionId, termContainer, cached._minimap);
  if (cached._floatingInput) { try { cached._floatingInput.dispose(); } catch {} cached._floatingInput = null; }
  cached._floatingInput = session.readOnly
    ? null
    : mountFloatingInput(sessionId, termContainer, cached.terminal);
  updateFloatingBarState();

  // === Spec 2 · S7: 切换 session 时加载真实历史卡片 ===
  if (!embedded && currentView === 'card') {
    // loadSessionHistoryToOverlay handles its own clear + Map.clear + placeholder
    // for empty/error/non-Claude cases. Don't pre-clear here.
    if (!cardHistoryViews.ready(session)) _cardHistoryHydratedSid = null;
    if (typeof loadSessionHistoryToOverlay === 'function'
        && (!opts.reuseCardHistory || !cardHistoryViews.ready(session))) {
      // 卡片视图切换 session 时也跳到最新对话，与上方 PTY 的 pinOnShow focus 兜底对称：
      // 切到不同 session 时靠 opts.focus；重复点击当前侧栏项时靠显式 forceScrollBottom。
      // view 切换（PTY↔卡片）走 applyViewMode 不经此处、不传 forceScrollBottom，保持阅读位置不受影响。
      loadSessionHistoryToOverlay(sessionId, { forceScrollBottom: !!opts.forceScrollBottom }).catch(err => {
        console.warn('[showTerminal] loadSessionHistoryToOverlay failed:', err);
      });
    }
  } else if (!embedded) {
    // PTY view: just clear msg-overlay (don't load cards user can't see)
    const overlay = document.getElementById('msg-overlay');
    if (overlay) {
      cardHistoryViews.suspend();
      overlay.innerHTML = '';
      if (window._sessionTurns) window._sessionTurns.clear();
    }
    _cardHistoryHydratedSid = null;
  }
  // Spec 3 · W15：切 session 时清旧 indicator + 按新 active session 状态重建
  if (typeof _updateStreamingIndicator === 'function') {
    _updateStreamingIndicator(sessionId);
  }
}

// 扩展投研复用同一套 xterm/PTY，不创建镜像终端。研究 Session 只改变挂载位置，
// 生命周期、输入、工具调用与 transcript 仍由 Hub 原生 SessionManager 管理。
const _xresearchRequestedSessionViews = new Map();
window.__xresearchSessionBridge = {
  async open(sessionId, view = 'card', preparedSession = null) {
    const requestedView = view === 'pty' ? 'pty' : 'card';
    _xresearchRequestedSessionViews.set(sessionId, requestedView);
    setTimeout(() => {
      if (_xresearchRequestedSessionViews.get(sessionId) === requestedView) {
        _xresearchRequestedSessionViews.delete(sessionId);
      }
    }, 5000);
    let session = sessions.get(sessionId);
    // Agent League ensures the live process in main before opening a surface.
    // The IPC reply and session-created push are independent messages, so the
    // local Map can briefly retain the old dormant shell. Adopt the authoritative
    // reply immediately and never race into a second generic dormant resume/picker.
    if (preparedSession && preparedSession.id === sessionId && preparedSession.status !== 'dormant') {
      const previous = session || {};
      sessions.set(sessionId, {
        ...previous,
        ...preparedSession,
        pinned: previous.pinned || preparedSession.pinned || false,
        bottomed: !(previous.pinned || preparedSession.pinned)
          && !!(previous.bottomed || preparedSession.bottomed),
        unreadCount: previous.unreadCount || 0,
        suspendedAt: null,
        suspendReason: null,
      });
      session = sessions.get(sessionId);
      scheduleSessionListRender();
    }
    if (!session) {
      _xresearchRequestedSessionViews.delete(sessionId);
      return { ok: false, error: 'session-missing' };
    }
    if (session.status === 'dormant') {
      await resumeDormantSession(sessionId, { forceScrollBottom: true });
      session = sessions.get(sessionId) || session;
    }
    await selectSession(sessionId, { forceScrollBottom: true });
    applyViewMode(requestedView);
    return { ok: true, session: sessions.get(sessionId) || session, view: requestedView };
  },
  async mount(sessionId, hostEl) {
    if (!hostEl) return { ok: false, error: 'host-missing' };
    const session = sessions.get(sessionId);
    if (!session) return { ok: false, error: 'session-missing' };
    activeMeetingId = null;
    activeSessionId = sessionId;
    clearSessionAttention(session, { clearUnread: true });
    ipcRenderer.send('focus-session', { sessionId });
    hostEl.classList.add('terminal-panel', 'cx-native-terminal-mounted');
    showTerminal(sessionId, { focus: false, forceScrollBottom: true, mountTarget: hostEl });
    renderSessionList();
    return { ok: true, session };
  },
  clear(hostEl) {
    if (!hostEl) return;
    hostEl.replaceChildren();
    const empty = document.createElement('div');
    empty.className = 'cx-terminal-empty';
    empty.textContent = '选择已有 Session，或发起任务后在这里查看原生 CLI。';
    hostEl.appendChild(empty);
  },
  list() {
    return Array.from(sessions.values()).filter((row) => row && ['xresearch-research', 'agent-league', 'agent-league-virtual'].includes(row.purpose));
  },
  get(sessionId) {
    return sessions.get(sessionId) || null;
  },
};

const { createTerminalMinimapFactory } = require('./terminal-minimap.js');
const terminalMinimapFactory = createTerminalMinimapFactory({
  document,
  getTerminalCache: (sessionId) => terminalCache.get(sessionId),
  ownsTranscript: (sessionId, terminal) => isCodexOwnedTranscript(sessions.get(sessionId), terminal),
  navigateTranscript: (sessionId, terminal, direction) => navigateCodexTranscript(sessions.get(sessionId), terminal, direction),
  promptLineRe: PROMPT_LINE_RE,
  aiMarkersRe: AI_MARKERS_RE,
  flashPromptLine: (terminal, lineNumber) => flashPromptLine(terminal, lineNumber),
  requestAnimationFrame: (fn) => requestAnimationFrame(fn),
});
const { mountMinimap, mountPromptNavButtons } = terminalMinimapFactory;
const { createTurnCardRenderer } = require('./turn-card-renderer.js');
function syncTurnPresentationToSession(sessionId, presentation, turn) {
  turnSpeedDisplay.observe(sessionId, turn);
  const session = sessions.get(sessionId);
  if (!session || !presentation || !turn || turn.role !== 'assistant') return;
  if (isNativeSession(session)) {
    if (!sessionRuntimeIsActive(session)) { session.currentCardActivity=null; return; }
    if (!turn.id?.includes(':'+session.nativeRuntime?.turnId+':')) return;
  }
  if (session.runtimeBackend === 'claude-stream-json') {
    if (!sessionRuntimeIsActive(session)) { session.currentCardActivity=null; return; }
    const runtime = session.nativeRuntime || {};
    if (turn.userMessageId !== runtime.userMessageId
        && !(runtime.backgroundActivities || []).some(activity => activity.id === turn.userMessageId)) return;
  }
  const current = presentation.currentActivity;
  const activities = Array.isArray(presentation.activities) ? presentation.activities : [];
  const lastActivity = activities.length ? activities[activities.length - 1] : null;
  let adoptedLiveActivities = false;
  if (!session.livePresentationCardId && Array.isArray(session.liveToolActivities) && session.liveToolActivities.length
      && sessionRuntimeIsActive(session)
      && !(presentation.delivery && presentation.delivery.complete)) {
    session.livePresentationCardId = turn.id || null;
    adoptedLiveActivities = !!session.livePresentationCardId;
  }
  if (current) {
    session.currentCardActivity = {
      turnId: turn.id || null,
      activityId: current.id || null,
      status: current.status,
      label: [current.title, current.detail].filter(Boolean).join('：'),
      observedAt: Date.now(),
    };
  } else if (presentation.delivery && presentation.delivery.complete) {
    const runtimeActive = sessionRuntimeIsActive(session);
    const ownsLivePresentation = !!turn.id && session.livePresentationCardId === turn.id;
    // A full-history refresh also visits old completed turns. Do not let one of
    // those cards erase the in-flight activity that belongs to the new turn.
    if (!runtimeActive || ownsLivePresentation) {
      if (!session.currentCardActivity || !session.currentCardActivity.turnId
          || session.currentCardActivity.turnId === turn.id) session.currentCardActivity = null;
      session.liveToolActivities = [];
      session.livePresentationCardId = null;
    }
  } else if (sessionRuntimeIsActive(session) && lastActivity) {
    session.currentCardActivity = {
      turnId: turn.id || null,
      activityId: lastActivity.id || null,
      status: lastActivity.status,
      label: `刚完成：${[lastActivity.title, lastActivity.detail].filter(Boolean).join('：')}`,
      observedAt: Date.now(),
    };
  }
  if (sessionId !== activeSessionId) return;
  const target = toolbarCrumbEl && toolbarCrumbEl.querySelector('.terminal-crumb-dot');
  if (target) paintTerminalRuntimeStatus(target, session);
  if (adoptedLiveActivities) queueMicrotask(() => rerenderTurn(turn.id));
}
const { createCardFollowScroll } = require('./card-follow-scroll');
const cardFollowScroll = createCardFollowScroll({ element: document.getElementById('msg-overlay'), window, document });
const turnCardRenderer = createTurnCardRenderer({
  document,
  window,
  navigator,
  copyText: (text, options) => clipboardController.copyText(text, options),
  CSS,
  marked,
  DOMPurify,
  formatAbsoluteTime,
  normalizeMarkdownPathBreaks,
  escapeHtml,
  wrapPathLinksInElement: (rootEl, opts) => wrapPathLinksInElement(rootEl, opts),
  getActiveSessionId: () => activeSessionId,
  getSessionContext: (sessionId) => sessions.get(sessionId) || null,
  openAttachment: (target, opts) => openPathInHub(target, opts),
  readToolResult: reference => ipcRenderer.invoke(reference.source==='claude-stream-json'?'claude-native:tool-result':reference.source==='claude-transcript-file'?'claude-transcript:tool-result':reference.source==='codex-app-server'?'codex-native:tool-result':'acp:tool-result', reference),
  onTurnPresentation: syncTurnPresentationToSession,
  updateStreamingIndicator: (sessionId) => _updateStreamingIndicator(sessionId),
  renderMathInElement: window.renderMathInElement,
});
const {
  renderTurnCard,
  rerenderTurn,
  mountTurnCard,
  mountOptimisticUserCard,
  turnRenderSignature,
  mountSessionTurnCard,
  isCardOverlayAtBottom: _isCardOverlayAtBottom,
} = turnCardRenderer;
const { formatRecentConversation } = require('./recent-turn-copy.js');
const { createCardMultiSelectController } = require('./card-multi-select.js');
// 微信式多选：卡片头部「多选」按钮进入，逐条勾选后一次性复制。
// 剪贴板走同一个写入方（clipboardController），不碰 navigator.clipboard。
const cardMultiSelectController = createCardMultiSelectController({
  document,
  window,
  navigator,
  copyText: (text, options) => clipboardController.copyText(text, options),
  getActiveSessionId: () => activeSessionId,
  getTurnById: (turnId) => window._sessionTurns && window._sessionTurns.get(turnId),
  extractVisibleCardText,
});
// init 失败（index.html 漂移、操作条节点没了）必须出声：否则圆圈画得出来、
// 点了没反应，用户只会觉得"卡了"。
if (!cardMultiSelectController.init()) {
  console.warn('[card-multi-select] 操作条节点缺失，多选功能未接线');
}
const chatgptBridgeController = createChatgptBridgeController({
  document,
  window,
  ipcRenderer,
  getActiveSessionId: getFocusedSessionId,
  getLatestAssistantText: async () => {
    const sessionId = getFocusedSessionId();
    const overlay = sessionSplit?.isSecondaryFocused() ? sessionSplit.secondary().overlay : document.getElementById('msg-overlay');
    const cards = [...overlay.querySelectorAll(':scope > .turn-card:not(.user)')];
    const card = cards[cards.length - 1];
    const visibleText = card ? extractVisibleCardText(card.querySelector('.turn-body')) : '';
    if (visibleText.trim()) return visibleText;
    if (!sessionId) return '';
    const transcriptText = await ipcRenderer.invoke('get-last-assistant-text', sessionId);
    return typeof transcriptText === 'string' ? transcriptText : '';
  },
});
chatgptBridgeController.init();

async function copyRecentTurnsForSession(sessionId, count = 3) {
  const session = sessions.get(sessionId);
  if (!session) return { text: '', copiedRounds: 0, availableRounds: 0, requestedRounds: count };
  const result = await ipcRenderer.invoke('parse-session-transcript', {
    hubSessionId: sessionId,
    ccSessionId: session.ccSessionId || null,
    transcriptPath: session.transcriptPath || null,
    kind: session.kind || null,
    opts: { limit: 30, fromTail: true },
  });
  const entries = result && Array.isArray(result.turns)
    ? result.turns.map(turn => ({
      role: turn.role,
      text: turn.text,
      kind: turn.kind || session.kind,
      model: turn.model,
    }))
    : [];
  const formatted = formatRecentConversation(entries, count);
  if (!formatted.text) return formatted;
  const copied = await clipboardController.copyText(formatted.text,{source:'recent-conversation',silent:true});
  if (!copied.ok) throw new Error(copied.reason || '复制失败');
  return formatted;
}

function recordSessionArtifacts(session, text, timestamp = Date.now()) {
  if (!session || !text) return false;
  const existing = Array.isArray(session.recentArtifacts) ? session.recentArtifacts.slice(-8) : [];
  const additions = [];
  const normalized = normalizeMarkdownPathBreaks(String(text).slice(-120_000));
  const pathCandidates = collectPathCandidates(normalized, session.cwd || null, { includeDirectories: false }).slice(-24);
  for (const candidate of pathCandidates) {
    if (!candidate || candidate.isUrl || !candidate.openPath) continue;
    try {
      if (!fs.statSync(candidate.openPath).isFile()) continue;
    } catch {
      continue;
    }
    additions.push({ path: candidate.openPath, timestamp: Number(timestamp) || Date.now() });
  }
  if (!additions.length) return false;
  const byPath = new Map();
  for (const artifact of existing.concat(additions)) {
    if (!artifact || !artifact.path) continue;
    let key;
    try { key = path.resolve(artifact.path).toLowerCase(); }
    catch { key = String(artifact.path).toLowerCase(); }
    byPath.set(key, artifact);
  }
  session.recentArtifacts = Array.from(byPath.values())
    .sort((a, b) => Number(a.timestamp || 0) - Number(b.timestamp || 0))
    .slice(-8);
  return true;
}
function scheduleCodexHistoryRetry(sessionId, attempt = 0, opts = {}) {
  if (!sessionId || attempt >= 6) return;
  if (!window._codexHistoryRetryState) window._codexHistoryRetryState = new Map();
  const prev = window._codexHistoryRetryState.get(sessionId);
  if (prev && prev.timer) {
    try { clearTimeout(prev.timer); } catch {}
  }
  const delay = Math.min(1000 + attempt * 500, 3000);
  const timer = setTimeout(() => {
    window._codexHistoryRetryState.delete(sessionId);
    if (sessionId !== activeSessionId || currentView !== 'card') return;
    loadSessionHistoryToOverlay(sessionId, {
      codexRetryAttempt: attempt + 1,
      incremental: opts.incremental === true,
    }).catch(err => {
      console.warn('[codex-history-retry] reload failed:', err);
    });
  }, delay);
  window._codexHistoryRetryState.set(sessionId, { timer, attempt });
}

// === Spec 2 v1.0.0 · S5 loadSessionHistoryToOverlay ===
// Load historical turns for a session and mount them as cards into #msg-overlay.
//
// Used by:
//   - showTerminal (S7) when switching to a Claude/Codex/Kimi session in card view
//   - User explicit "reload history" action (future)
//
// Workflow:
//   1. Resolve container = #msg-overlay; missing → warn + bail
//   2. Clear container + clear _sessionTurns Map (multi-session safety)
//   3. Look up session via existing `sessions` Map (showTerminal pattern, line ~1080)
//   4. unsupported kind (outside Claude/Codex/Kimi families) → friendly placeholder, skip IPC
//   5. invoke('parse-session-transcript', { hubSessionId, ccSessionId, opts })
//   6. Handle result:
//      - turns.length === 0 → placeholder ("会话尚未产生历史" or error text)
//      - turns.length > 0   → loop mountSessionTurnCard, then ONE bottom-scroll
//        (don't autoScroll per mount — would jitter and force N reflows)
//   7. Return { mounted, error }
//
// Boundary notes:
//   * Does NOT touch showTerminal — S7 will integrate
//   * Does NOT register IPC listeners for turn-complete-event — that's S6
//   * Falls back to ipcRenderer.invoke even if `sessions.get` returns null;
//     main.js handler does its own session lookup and returns
//     'transcript not found' for unknown ids — we display that as the error.
// 2026-09-26：全量加载先把卡片挂进离屏 staging（分批让出主线程），最后才整体插入；
// 增量刷新只在页面容器里查重，看不到 staging。PTY 会话一打开，CLI 恢复时的终端输出
// 就会触发增量刷新，把最新一整轮再挂一遍 → 同一批卡两份、结果夹在进展中间。
// 同一会话的增量 / 更早页一律排在进行中的全量之后，与全量互斥。
async function loadSessionHistoryToOverlay(sessionId, opts = {}) {
  if (!window._cardFullLoadBySid) window._cardFullLoadBySid = new Map();
  const fullLoads = window._cardFullLoadBySid;
  if (opts.incremental === true || opts.older) {
    const pending = fullLoads.get(sessionId);
    if (pending) await pending.catch(() => {});
    return loadSessionHistoryToOverlayUnserialized(sessionId, opts);
  }
  const run = loadSessionHistoryToOverlayUnserialized(sessionId, opts);
  fullLoads.set(sessionId, run);
  try { return await run; }
  finally { if (fullLoads.get(sessionId) === run) fullLoads.delete(sessionId); }
}

async function loadSessionHistoryToOverlayUnserialized(sessionId, opts = {}) {
  // Spec 3 · B1 增量 mount：opts.incremental=true 时不清 container/Map，
  // 依赖 mountSessionTurnCard 内的 turnId dedup 自动跳过已 mount 的 turn。
  // 用于 throttle reload（同 sessionId 反复）— 把"全清重建"压成"只 append 新增"。
  // 切 session 时调用方传默认（incremental=false）走全量。
  const forceScrollBottom = opts.forceScrollBottom === true;

  // 1. resolve container
  const container = document.getElementById('msg-overlay');
  if (!container) {
    console.warn('[loadSessionHistoryToOverlay] container not found (msg-overlay missing)');
    return { mounted: 0, error: 'container missing' };
  }
  if (sessionId !== activeSessionId || currentView !== 'card') return {mounted: 0, error: 'stale load'};
  const viewSession = sessions.get(sessionId) || {id: sessionId};
  const view = cardHistoryViews.activate(viewSession);
  const incremental = opts.incremental === true || view.hydrated;
  if (view.changed && !view.hydrated && !opts.older) cardHistoryPager.reset(sessionId);
  const pageState = cardHistoryPager.get(sessionId);
  const paged = !opts.parseOpts || opts.older;
  const pageLimit = opts.older ? pageState.limit + cardHistoryPager.PAGE_CARDS : cardHistoryPager.INITIAL_CARDS;
  if (view.hydrated) _cardHistoryHydratedSid = sessionId;
  const overlayScrollBeforeLoad = {
    top: container.scrollTop,
    wasAtBottom: forceScrollBottom || _isCardOverlayAtBottom(container),
  };
  if (forceScrollBottom) cardFollowScroll.follow();
  const followSnapshot = cardFollowScroll.capture();

  // 2. clear container + Map (avoid stale turns from previous session)
  if (!incremental) {
    container.innerHTML = '';
    if (!window._sessionTurns) window._sessionTurns = new Map();
    window._sessionTurns.clear();
    turnCardRenderer.clearTurnRenderSignatures();
  } else if (!window._sessionTurns) {
    window._sessionTurns = new Map();
  }

  // helper: render a placeholder line inside the cleared container.
  // Incremental refreshes must never call this: a transient empty/error result
  // is not evidence that already-rendered authoritative turns disappeared.
  const showPlaceholder = (html) => {
    container.innerHTML =
      '<div class="msg-overlay-placeholder">' + html + '</div>';
  };

  // 3. look up session info — same pattern as showTerminal (line ~1080)
  let session = null;
  try {
    if (typeof sessions !== 'undefined' && sessions && typeof sessions.get === 'function') {
      session = sessions.get(sessionId) || null;
    }
  } catch (err) {
    console.warn('[loadSessionHistoryToOverlay] sessions.get threw:', err);
  }
  const ccSessionId = session ? (session.ccSessionId || null) : null;
  const transcriptPath = session ? (session.transcriptPath || null) : null;
  const kind = session ? (session.kind || null) : null;

  // 4. kind gate — all transcript-backed coding CLIs share the card experience.
  const supportsCardHistory = kind && (isNativeSession(session) || isClaudeFamily(kind) || isTranscriptCliKind(kind));
  if (kind && !supportsCardHistory) {
    showPlaceholder(
      '该会话没有结构化历史 — '
      + '<a href="#" data-action="switch-to-pty">切到 PTY 视图</a>'
    );
    return { mounted: 0, error: null };
  }

  // Full hydration and streaming incremental refreshes are independent lanes.
  // A terminal-data refresh can start while the initial full-history parse is
  // still running. If both lanes share one generation, the cheap limit:1
  // refresh invalidates the authoritative full result and leaves the overlay
  // stuck at "loading" with only the newest assistant card. Keep newest-wins
  // semantics within each lane while preserving the session/view ownership
  // guards shared by both.
  const loadLane = opts.older ? 'older' : incremental ? 'incremental' : 'full';
  const loadSeq = Date.now() + ':' + Math.random().toString(36).slice(2);
  if (!window._cardLoadSeqBySid) window._cardLoadSeqBySid = new Map();
  const previousLoadSeqs = window._cardLoadSeqBySid.get(sessionId);
  const loadSeqs = previousLoadSeqs && typeof previousLoadSeqs === 'object'
    ? { ...previousLoadSeqs }
    : {};
  // 在本次之后开始的全量加载会清空容器、重建权威快照；在它之前发出的增量 /
  // 更早页结果已经过期，再挂就会落在它的 staging 之外，成为重复卡。
  const fullSeqAtStart = loadSeqs.full;
  loadSeqs[loadLane] = loadSeq;
  window._cardLoadSeqBySid.set(sessionId, loadSeqs);
  const isStaleLoad = () => (
    sessionId !== activeSessionId
    || currentView !== 'card'
    || !window._cardLoadSeqBySid.get(sessionId)
    || window._cardLoadSeqBySid.get(sessionId)[loadLane] !== loadSeq
    || (loadLane !== 'full' && window._cardLoadSeqBySid.get(sessionId).full !== fullSeqAtStart)
  );
  if (!incremental) {
    container.innerHTML = require('./card-history-views').loadingMarkup();
  }

  const showRefreshError = message => {
    let status = container.querySelector(':scope > .card-history-status');
    if (!status) {
      status = document.createElement('div'); status.className = 'card-history-status';
      status.setAttribute('role', 'status'); container.appendChild(status);
    }
    const retry = document.createElement('button'); retry.type = 'button'; retry.textContent = '重试';
    retry.addEventListener('click', () => {
      if (sessionId !== activeSessionId || currentView !== 'card') return;
      retry.disabled = true;
      loadSessionHistoryToOverlay(sessionId).catch(error => console.warn('[card-history retry]', error));
    });
    status.replaceChildren(document.createTextNode('历史同步暂未完成：' + message + ' '), retry);
  };

  // 5. invoke IPC (let main.js apply default opts: limit:50, fromTail:true)
  const refreshTurnIds=view.changed && view.hydrated && session?.runtimeBackend==='codex-app-server'
    ? [...new Set([...window._sessionTurns.values()].map(turn=>turn.providerTurnId
      || (turn.displayTurnKey?.startsWith(session.codexSid+':')?turn.displayTurnKey.slice((session.codexSid+':').length):null)).filter(Boolean))] : [];
  let result;
  try {
    result = await ipcRenderer.invoke('parse-session-transcript', {
      hubSessionId: sessionId,
      ccSessionId,
      transcriptPath,
      kind,
      opts: paged ? { limit: pageLimit + 1, fromTail: true, includeBranchHistory: true,refreshTurnIds,
        refreshDisplayIds:refreshTurnIds.length?[...window._sessionTurns.keys()]:[] } : opts.parseOpts,
    });
  } catch (err) {
    if (isStaleLoad()) return { mounted: 0, error: 'stale load' };
    const msg = (err && err.message) ? err.message : String(err);
    console.warn('[loadSessionHistoryToOverlay] IPC invoke threw:', err);
    if (!incremental) {
      showPlaceholder(
        '加载历史失败：' + msg + ' — '
        + '<a href="#" data-action="switch-to-pty">切到 PTY 视图查看终端</a>'
      );
    } else showRefreshError(msg);
    return { mounted: 0, error: msg };
  }
  if (isStaleLoad()) return { mounted: 0, error: 'stale load' };
  container.querySelector(':scope > .card-history-status')?.remove();
  if (result && result.transcriptPath && session && session.transcriptPath !== result.transcriptPath) {
    session.transcriptPath = result.transcriptPath;
    if (typeof schedulePersist === 'function') schedulePersist();
  }
  if (result && typeof result.parseMs === 'number' && result.parseMs > 150) {
    console.warn('[loadSessionHistoryToOverlay] slow parse', {
      sessionId,
      parseMs: result.parseMs,
      transcriptPath: result.transcriptPath || transcriptPath || null,
      incremental,
    });
  }

  let turns = require('./simple-chat-display').displayChatTurns(
    (result && Array.isArray(result.turns)) ? result.turns : []);
  let nextPageState=null;
  if (paged && !result?.error) {
    if (opts.older || !incremental || view.changed) {
      nextPageState={more:turns.length > pageLimit || (result?.turns?.length || 0) > pageLimit,limit:pageLimit};
    }
    turns = turns.slice(-pageLimit);
  }
  if(result?.refreshedTurns?.length) {
    const refreshed=require('./simple-chat-display').displayChatTurns(result.refreshedTurns);
    const latestIds=new Set(turns.map(turn=>turn.id));
    turns=refreshed.filter(turn=>!latestIds.has(turn.id)).concat(turns);
  }
  const ipcError = (result && result.error) ? result.error : null;
  // A streaming incremental result can land while this full parse is in
  // flight. Those cards are newer than the full snapshot and must survive the
  // authoritative history rebuild even when that snapshot does not contain
  // them yet.
  const concurrentFullCards = !incremental
    ? Array.from(container.querySelectorAll(':scope > .turn-card'))
    : [];
  const removeLoadingPlaceholder = () => {
    const placeholder = container.querySelector(':scope > .msg-overlay-placeholder');
    if (placeholder) placeholder.remove();
  };

  // 6a. error AND no turns → friendly placeholder (don't silent fail)
  if (turns.length === 0 && ipcError) {
    const transcriptPending = /(?:ENOENT|transcript (?:not found|尚未)|rollout (?:not found|尚未))/i.test(String(ipcError))
      && session && sessionRuntimeIsActive(session);
    if (transcriptPending) {
      // A newly-created Claude/Codex session can publish its transcript path
      // before the first JSONL file is physically created. That is a normal
      // startup state, not a user-actionable history failure. Terminal output
      // and finite settle retries will refresh this projection once the file
      // exists; never expose the temporary absolute path as a scary error.
      if (!incremental && concurrentFullCards.length === 0) {
        showPlaceholder(`${isCodexKind(kind) ? 'Codex' : 'Claude'} 正在准备首个结构化内容…`);
      } else if (!incremental) {
        removeLoadingPlaceholder();
      }
      return { mounted: concurrentFullCards.length, error: null, pending: true };
    }
    // Spec 3 · W11：transcript not found 通常是 session 创建后从未发过消息（无 ccSessionId 写入）。
    // 不是 bug，是 expected。文案明示让 user 不再误以为"卡片视图坏了"。
    let txt;
    if (ipcError === 'transcript not found') {
      const ccSid = ccSessionId || (session && session.ccSessionId);
      txt = ccSid
        ? `会话尚未产生历史（transcript 文件可能已被移走或删除：${ccSid.slice(0, 8)}…）`
        : '此会话从未发送过消息，无对话历史可显示';
    } else if (isCodexKind(kind) && ipcError === 'codex rollout not found') {
      const attempt = Number.isInteger(opts.codexRetryAttempt) ? opts.codexRetryAttempt : 0;
      if (attempt < 6) {
        scheduleCodexHistoryRetry(sessionId, attempt, { incremental });
        txt = '正在绑定 Codex 历史（resume 后通常需要几秒）';
      } else {
        txt = '加载历史失败：Codex rollout 尚未绑定或已被移动';
      }
    } else {
      txt = '加载历史失败：' + ipcError;
    }
    if (!incremental && concurrentFullCards.length === 0) {
      showPlaceholder(
        txt + ' — '
        + '<a href="#" data-action="switch-to-pty">切到 PTY 视图查看终端</a>'
      );
    } else if (!incremental) {
      removeLoadingPlaceholder();
    }
    if (incremental) showRefreshError(ipcError);
    return { mounted: 0, error: ipcError };
  }

  // 6b. no turns, no error → fresh session
  if (turns.length === 0) {
    if (window._codexHistoryRetryState) {
      const st = window._codexHistoryRetryState.get(sessionId);
      if (st && st.timer) { try { clearTimeout(st.timer); } catch {} }
      window._codexHistoryRetryState.delete(sessionId);
    }
    // A successful empty refresh can recover an earlier startup placeholder.
    // Leave an already-rendered welcome and all optimistic/live cards intact.
    if (!incremental || container.querySelector(':scope > .msg-overlay-placeholder:not(.session-welcome)')) {
      if (!container.querySelector(':scope > .turn-card')) {
        container.innerHTML = require('./session-welcome').renderSessionWelcome(session, escapeHtml);
      } else {
        removeLoadingPlaceholder();
      }
    }
    // 空 session 也算 hydrated:已经确认"历史为空",后续 turn-complete 走增量
    // 挂卡 + 250ms 补全 reload 即可,不必再触发全量。否则首条消息发出后,
    // mountOptimisticUserCard 把 placeholder 隐藏,turn-complete 又看到 hydrated=null
    // 反而触发全量 reload → 闪烁。
    if (!incremental) _cardHistoryHydratedSid = sessionId;
    if (!opts.incremental || view.hydrated) cardHistoryViews.markHydrated(sessions.get(sessionId) || viewSession);
    return { mounted: concurrentFullCards.length, error: null };
  }

  // 6c. mount each turn; pass kind through opts so renderTurnCard picks it up.
  if (window._codexHistoryRetryState) {
    const st = window._codexHistoryRetryState.get(sessionId);
    if (st && st.timer) { try { clearTimeout(st.timer); } catch {} }
    window._codexHistoryRetryState.delete(sessionId);
  }
  // Use a default kind 'claude' if session lookup failed but main.js still
  // returned turns — they came from a Claude transcript by definition.
  const mountKind = kind || 'claude';
  const fullTurnIds = !incremental ? new Set(turns.map(turn => turn && turn.id).filter(Boolean)) : null;
  const concurrentExtraCards = !incremental
    ? concurrentFullCards.filter(card => !fullTurnIds.has(card.dataset.turnId))
    : [];
  if (incremental) removeLoadingPlaceholder();
  // 2026-05-06 maintainer scroll-respect-user (Codex 多方审查发现):
  //   incremental=true 路径(streaming partial-update throttle)反复触发本函数,
  //   末尾的 batch scrollIntoView 没 guard → 用户上翻历史时仍被拍回底部。
  //   incremental=false(切 session): line 2179 已清 container.innerHTML='' →
  //     scrollTop=0/scrollHeight=0 → helper 自然返回 true → 初次加载行为不退化。
  //   incremental=true(throttle reload): container 保留旧内容 → 反映用户真实位置。
  const _batchWasAtBottom = forceScrollBottom || (incremental ? _isCardOverlayAtBottom(container) : overlayScrollBeforeLoad.wasAtBottom);
  let mounted = 0;
  let lastCardEl = null;
  let batchStarted = performance.now();
  const turnsBeforeMount = new Map(window._sessionTurns);
  const cardIdsBeforeMount = incremental && !opts.older
    ? new Set(Array.from(container.querySelectorAll(':scope > .turn-card'), card => card.dataset.turnId))
    : null;
  const staging = !incremental || opts.older ? document.createElement('div') : null;
  const mountTurns = turns;
  for (const turn of mountTurns) {
    // Loading older pages must not overwrite a newer streaming card which
    // arrived while the history request was in flight.
    if(opts.older && window._sessionTurns.has(turn.id))continue;
    if (!incremental && window._sessionTurns.has(turn.id)
        && window._sessionTurns.get(turn.id) !== turnsBeforeMount.get(turn.id)) continue;
    const existing = staging && container.querySelector(`:scope > .turn-card[data-turn-id="${CSS.escape(turn.id)}"]`);
    const cardEl = mountSessionTurnCard(sessionId, turn, { kind: mountKind, container: existing ? container : staging || container });
    if (cardEl) {
      mounted++;
      lastCardEl = cardEl;
    }
    // Yield between complete cards, preserving all Markdown and tool content.
    // Check ownership after every yield so rapid navigation cannot append an
    // old session's remaining cards into the newly selected conversation.
    if (staging && performance.now() - batchStarted >= 12) {
      await new Promise(resolve => {
        let frame;
        const timer = setTimeout(() => { cancelAnimationFrame(frame); resolve(); }, 40);
        frame = requestAnimationFrame(() => { clearTimeout(timer); setTimeout(resolve, 0); });
      });
      if (isStaleLoad()) return {mounted, error: 'stale load'};
      batchStarted = performance.now();
    }
  }
  if (staging) {
    const fragment = document.createDocumentFragment(); fragment.append(...staging.children);
    container.insertBefore(fragment, container.querySelector(':scope > .turn-card,:scope > .streaming-indicator'));
    removeLoadingPlaceholder();
  }
  if(nextPageState)Object.assign(pageState,nextPageState);
  cardHistoryPager.render(sessionId, container);

  if (!incremental || opts.older || session?.runtimeBackend === 'claude-stream-json') {
    // Mounting dedups existing concurrent cards but may leave them ahead of old
    // history. Reorder the authoritative full snapshot first, then append only
    // genuinely newer concurrent cards. Cards removed by optimistic/provisional
    // dedup are intentionally skipped here.
    const desiredCards=turns.map(turn=>turn?.id && container.querySelector(
      `:scope > .turn-card[data-turn-id="${CSS.escape(turn.id)}"]`)).filter(Boolean)
      .concat(concurrentExtraCards.filter(card=>card.parentNode===container));
    const currentCards=Array.from(container.querySelectorAll(':scope > .turn-card'));
    const alreadyOrdered=desiredCards.length===currentCards.length && desiredCards.every((card,i)=>card===currentCards[i]);
    const selection=window.getSelection();
    const savedSelection=selection?.rangeCount && container.contains(selection.anchorNode) && container.contains(selection.focusNode)
      ? {anchor:selection.anchorNode,anchorOffset:selection.anchorOffset,focus:selection.focusNode,focusOffset:selection.focusOffset} : null;
    const streamingTail = container.querySelector(':scope > .streaming-indicator');
    const placeBeforeStreamingTail = (card) => {
      if(alreadyOrdered)return;
      if (!card || card.parentNode !== container) return;
      if (streamingTail && streamingTail.parentNode === container) {
        container.insertBefore(card, streamingTail);
      } else {
        container.appendChild(card);
      }
    };
    for (const turn of turns) {
      if (!turn || !turn.id) continue;
      placeBeforeStreamingTail(container.querySelector(
        `:scope > .turn-card[data-turn-id="${CSS.escape(turn.id)}"]`
      ));
    }
    let lastConcurrentCard = null;
    for (const card of concurrentExtraCards) {
      placeBeforeStreamingTail(card);
      if (card.parentNode === container) lastConcurrentCard = card;
    }
    if (lastConcurrentCard) lastCardEl = lastConcurrentCard;
    if(savedSelection && savedSelection.anchor.isConnected && savedSelection.focus.isConnected) {
      selection.setBaseAndExtent(savedSelection.anchor,savedSelection.anchorOffset,savedSelection.focus,savedSelection.focusOffset);
    }
  }

  if(incremental && session?.runtimeBackend==='acp' && turns.length) {
    // ACP can acknowledge on its first delta. A full-history hydration may
    // therefore overlap a live user card. Reconcile the native snapshot order
    // instead of leaving the replaced optimistic card behind its answer.
    const ids=new Set(turns.map(t=>t.id));
    const current=Array.from(container.querySelectorAll(':scope > .turn-card'));
    const firstAt=Math.min(...turns.map(t=>Number(t.ts)).filter(t=>t>0));
    const extras=current.filter(card=>!ids.has(card.dataset.turnId));
    const before=extras.filter(card=>Number(window._sessionTurns?.get(card.dataset.turnId)?.ts)<firstAt);
    const after=extras.filter(card=>!before.includes(card));
    const byId=new Map(current.map(card=>[card.dataset.turnId,card]));
    const ordered=before.concat(turns.map(t=>byId.get(t.id)).filter(Boolean),after);
    if(ordered.some((card,i)=>card!==current[i])) {
      const selection=window.getSelection();
      const saved=selection?.rangeCount && container.contains(selection.anchorNode) && container.contains(selection.focusNode)
        ? {a:selection.anchorNode,ao:selection.anchorOffset,f:selection.focusNode,fo:selection.focusOffset}:null;
      const tail=container.querySelector(':scope > .streaming-indicator');
      for(const card of ordered)container.insertBefore(card,tail);
      if(saved && saved.a.isConnected && saved.f.isConnected)selection.setBaseAndExtent(saved.a,saved.ao,saved.f,saved.fo);
    }
  }

  // 2026-09-26：首屏只挂一轮的最后几张卡（最近几条进展 + 结果），实时刷新拿回的是
  // 整轮。本轮更早的进展是新卡，一律追加就会落到结果下面。新卡按快照顺序插到
  // 下一张已在页面上的卡之前；只有真正更新的卡才留在末尾。已有卡的位置不动。
  if (cardIdsBeforeMount && cardIdsBeforeMount.size && turns.length) {
    require('./card-snapshot-order').placeNewCardsInSnapshotOrder(container, turns.map(turn => turn && turn.id),
      cardIdsBeforeMount, id => container.querySelector(`:scope > .turn-card[data-turn-id="${CSS.escape(id)}"]`));
  }

  require('./conversation-message-view').syncResponseGroups(container);
  // Single bottom-scroll AFTER loop (don't autoScroll per mount — N reflows = jitter)
  // — 仅当 batch 开始前用户在底部才滚(scroll-respect-user)
  if (container._cardFollowController) {
    cardFollowScroll.restore(followSnapshot);
  } else if (lastCardEl && _batchWasAtBottom) {
    try {
      lastCardEl.scrollIntoView({ behavior: 'auto', block: 'end' });
    } catch {
      container.scrollTop = container.scrollHeight;
    }
    // scrollIntoView(block:end) 会把最后一张卡对齐，却不包含 overlay 的底部 padding，
    // 显式侧栏导航仍会留下约 20px 缝隙。强制请求要贴到真正的 scrollHeight 尾端；
    // 下一帧再钉一次，覆盖 markdown/KaTeX 在首帧完成后的轻微高度变化。
    if (forceScrollBottom) {
      const pinOverlayToBottom = () => { container.scrollTop = container.scrollHeight; };
      pinOverlayToBottom();
      requestAnimationFrame(pinOverlayToBottom);
    }
  } else if (!incremental && !_batchWasAtBottom) {
    container.scrollTop = Math.min(
      overlayScrollBeforeLoad.top,
      Math.max(0, container.scrollHeight - container.clientHeight),
    );
  }

  // Mark history as hydrated for this session (non-incremental full load only)
  if (!incremental && mounted > 0) {
    _cardHistoryHydratedSid = sessionId;
  }
  if (mounted > 0 && (!opts.incremental || view.hydrated)) cardHistoryViews.markHydrated(sessions.get(sessionId) || viewSession);

  _updateStreamingIndicator(sessionId);
  return { mounted, error: null };
}
window._loadSessionHistoryToOverlay = loadSessionHistoryToOverlay;
const cardHistoryPager = require('./card-history-pager').createCardHistoryPager({
  document, activeId: () => activeSessionId, load: loadSessionHistoryToOverlay,
});
cardHistoryPager.bind(document.getElementById('msg-overlay'));

ipcRenderer.on('prompt-submitted-event', (_event, payload) => {
  onPromptSubmittedFromTranscriptEvent(payload);
});

ipcRenderer.on('turn-started-event', (_event, payload) => {
  // Reuse the ordered prompt/completion reducer, but keep the transport event
  // distinct: task_started may represent an automatic /goal continuation and
  // therefore has no user-authored preview text.
  onPromptSubmittedFromTranscriptEvent({
    ...(payload || {}),
    text: '',
    submittedAt: payload && payload.startedAt,
  });
});

ipcRenderer.on('turn-aborted-event', (_event, payload) => {
  const { hubSessionId, abortedAt, turnId, kind } = payload || {};
  const session = sessions.get(hubSessionId);
  // PTY Claude 的 Esc 中断只能从 transcript 的中断标记得知（没有 Stop hook）。
  const ptyClaude = !!session && isClaudeRuntimeSession(session) && session.runtimeBackend !== 'claude-stream-json';
  if (!hubSessionId || (!isTranscriptCliKind(kind) && !ptyClaude)) return;
  if (!session || session.status === 'dormant') return;
  const transition = applyTurnAborted(session, { abortedAt, turnId });
  if (!transition.applied) return;
  clearCodexCardWorking(hubSessionId);
  if (ptyClaude) {
    session._agentWorking = null;
    session._runSource = null;
    session._claudeBackgroundTasks = [];
    session.currentCardActivity = null;
    disarmPtyBurstFallback(session, transition.at);
  }
  observeSessionRuntime(session, {
    state: RUNTIME_IDLE,
    source: 'codex-turn-aborted',
    confidence: CONFIDENCE_AUTHORITATIVE,
    // 观察时刻取收到事件的时间：事件本身的时刻常早于终端输出触发的弱观察，按它算会被判成过期。
    observedAt: Math.max(transition.at, Date.now()),
    turnId,
    reason: 'turn-aborted',
  });
  if (typeof _updateStreamingIndicator === 'function') _updateStreamingIndicator(hubSessionId);
  scheduleSessionListRender();
  schedulePersist();
});

ipcRenderer.on('turn-failed-event', (_event, payload) => {
  const { hubSessionId, failedAt, turnId, kind, message, occurrenceId } = payload || {};
  if (!hubSessionId || !isTranscriptCliKind(kind)) return;
  const session = sessions.get(hubSessionId);
  if (!session || session.status === 'dormant') return;
  const normalized = detectStreamDisconnect(message);
  if (normalized) {
    raiseStreamDisconnectFailure(hubSessionId, {
      ...normalized,
      occurrenceId: occurrenceId || `${turnId || 'unknown-turn'}:${failedAt || Date.now()}`,
      turnId: turnId || null,
    }, {
      observedAt: failedAt,
      authoritative: true,
    });
    return;
  }

  const failureOccurrenceId = occurrenceId || `${turnId || 'unknown-turn'}:${failedAt || Date.now()}`;
  if (session._lastTranscriptFailureOccurrenceId === failureOccurrenceId) return;
  session._lastTranscriptFailureOccurrenceId = failureOccurrenceId;
  const at = Number(failedAt) || Date.now();
  const runStartedAt = Number(session.runStartedAt) || 0;
  if (runStartedAt > 0 && at >= runStartedAt) {
    session.lastRunStartedAt = runStartedAt;
    session.lastRunDurationMs = at - runStartedAt;
  }
  session.runStartedAt = null;
  session.lastError = String(message || 'Codex turn failed').slice(0, 1000);
  clearSessionAttention(session);
  if (isCodexKind(session.kind)) clearCodexCardWorking(hubSessionId);
  observeSessionRuntime(session, {
    state: RUNTIME_FAILED,
    source: 'codex-task-complete-error',
    confidence: CONFIDENCE_AUTHORITATIVE,
    observedAt: at,
    startedAt: runStartedAt,
    completedAt: at,
    turnId,
    reason: payload.errorInfo || 'codex-turn-error',
    evidence: session.lastError,
  });
  _updateStreamingIndicator(hubSessionId);
  scheduleSessionListRender();
  schedulePersist();
});

ipcRenderer.on('background-work-event', (_event, payload) => {
  onKimiBackgroundWorkEvent(payload);
});

// === Spec 2 v1.0.0 · S6 turn-complete-event listener ===
// main.js (S3) broadcasts 'turn-complete-event' whenever an assistant turn
// finishes streaming. Append the just-completed turn as a card to #msg-overlay
// for the active Claude/Codex session in card view.
//
// Skip conditions (each is a multi-instance / multi-view safety guard):
//   - meetingId truthy → AI 群聊 has its own card pipeline (renderer/meeting-room.js)
//   - hubSessionId !== activeSessionId → other sessions' new turns shouldn't pop
//     up under the active session's overlay
//   - currentView !== 'card' → PTY view doesn't use the overlay; building DOM
//     nobody sees is wasteful
//
// Why re-invoke parse-session-transcript instead of trusting payload.text:
//   The S3 payload only carries plain text. The structured turn (thinking,
//   toolCalls, model, stopReason, usage, id, ts) lives in the JSONL transcript
//   and is parsed by S1's parse-session-transcript. Calling it with limit:1
//   fromTail:true returns the just-completed turn fully structured. Fallback to
//   payload-only turn on IPC error keeps the user from seeing nothing.
ipcRenderer.on('turn-complete-event', async (_event, payload) => {
  const {
    hubSessionId,
    transcriptPath,
    text,
    completedAt,
    meetingId,
    kind,
    durationMs,
  } = payload || {};

  onReplyCompleteFromTranscriptEvent(payload);

  if (!meetingId && window.WorkspaceController) {
    void window.WorkspaceController.maybePromptSessionArchive(hubSessionId);
  }

  // 1. AI 群聊 path — meeting-room.js handles its own card rendering
  if (meetingId) return;

  // 2. multi-session safety — only render for currently active session
  if (hubSessionId !== activeSessionId) return;

  // 3. only render in card view (PTY view doesn't use msg-overlay)
  if (currentView !== 'card') {
    // The visible CLI still needs the completed turn's measurement. Read
    // one structured reply on this existing event; no timer or card mount.
    try {
      const result = await ipcRenderer.invoke('parse-session-transcript', {
        hubSessionId, transcriptPath, kind: kind || sessions.get(hubSessionId)?.kind,
        opts: { limit: 1, fromTail: true },
      });
      if (!result?.error) for (const turn of result?.turns || []) turnSpeedDisplay.observe(hubSessionId, turn);
    } catch (error) { console.warn('[turn-speed] completed measurement unavailable:', error.message); }
    return;
  }

  // 4. If history was never fully hydrated for this session, trigger backfill
  //    before appending the single new turn. Use explicit state flag instead of
  //    DOM placeholder detection — placeholder can be removed by optimistic card
  //    (mountOptimisticUserCard) before we get here, breaking the old check.
  if (_cardHistoryHydratedSid !== hubSessionId) {
    if (typeof loadSessionHistoryToOverlay === 'function') {
      try {
        const r = await loadSessionHistoryToOverlay(hubSessionId);
        if (r && r.mounted > 0) {
          _cardHistoryHydratedSid = hubSessionId;
          // 全量 reload 已经把最新 turn 也挂上去了(fromTail+limit:50 含末条),
          // 不必再走下面的 limit:1 IPC + mount(dedup 会跳过,但浪费一次 IPC)。
          return;
        }
      } catch (err) {
        console.warn('[turn-complete-event] history backfill failed:', err);
      }
    }
  }

  // 5. 挂完 limit:1 增量卡后,立即 trigger incremental reload 兜底:
  //    2026-05-24 maintainer — 原版 setTimeout 350ms debounce 被 race 失效（隔离 Hub
  //    stress-3 实测：禁用 setTimeout 后 cards 卡在残缺数量持久化）。改成立即
  //    触发 + Promise 级 in-flight guard：每 turn-complete 至多 1 个 backfill
  //    在跑且必定执行，不再被 timer cancel/clear 取消。incremental=true 时
  //    mountSessionTurnCard 内 dedup 保证不重复挂卡,只把增量分支漏掉的旧 turn
  //    补回来。
  const scheduleBackfill = () => {
    if (_turnCompleteBackfillTimers.has(hubSessionId)) return; // in-flight guard
    if (hubSessionId !== activeSessionId || currentView !== 'card') return;
    if (typeof loadSessionHistoryToOverlay !== 'function') return;
    const p = loadSessionHistoryToOverlay(hubSessionId, { incremental: true })
      .catch(err => console.warn('[turn-complete backfill] incremental reload failed:', err))
      .finally(() => _turnCompleteBackfillTimers.delete(hubSessionId));
    _turnCompleteBackfillTimers.set(hubSessionId, p);
  };

  try {
    const r = await ipcRenderer.invoke('parse-session-transcript', {
      hubSessionId,
      transcriptPath,
      opts: { limit: 1, fromTail: true },
    });
    if (hubSessionId !== activeSessionId || currentView !== 'card') return;
    // 全量加载还挂在离屏 staging 里时，直接挂卡看不到它们；交给排队的增量回填。
    if (window._cardFullLoadBySid?.has(hubSessionId)) { scheduleBackfill(); return; }

    if (r && !r.error && Array.isArray(r.turns) && r.turns.length > 0) {
      // got the structured turn from S1 parser
      const turn = r.turns[0];
      // turn-complete should always be assistant; defend against future broadcast scope changes
      if (turn.role !== 'assistant') return;
      // Dedup: skip if turn already mounted (race with loadSessionHistoryToOverlay)
      if (window._sessionTurns && window._sessionTurns.has(turn.id)) {
        scheduleBackfill();
        return;
      }
      if (document.querySelector('.turn-card[data-turn-id="' + CSS.escape(turn.id) + '"]')) {
        scheduleBackfill();
        return;
      }
      mountSessionTurnCard(hubSessionId, turn, { kind, autoScroll: true });
      scheduleBackfill();
      return;
    }

    // transcript 还没落盘（Codex rollout 尤其常见）时的兜底卡。
    // 它的 id 是合成的 `turn-<时间戳>`，与 transcript 里真实 turn 的 id 毫无关系——
    // 紧接着 scheduleBackfill 重新解析、用真实 id 再挂一次，dedup 拦不住，
    // 于是同一条回答出现两遍（用户反馈的"回答卡片重复"）。
    // 解法与 optimistic user card 同款：打上 provisional 标记，真卡到达时顶掉它。
    const fallbackTurn = {
      id: 'turn-' + (completedAt || Date.now()),
      role: 'assistant',
      text: text || '',
      ts: completedAt || Date.now(),
      tsEnd: completedAt || Date.now(),
      kind,
      stopReason: isCodexKind(kind) ? 'task_complete' : 'end_turn',
      durationMs: Number.isFinite(Number(durationMs)) ? Number(durationMs) : undefined,
      toolCalls: (() => {
        const active = sessions.get(hubSessionId);
        return active && Array.isArray(active.liveToolActivities)
          ? active.liveToolActivities.slice(-24)
          : [];
      })(),
    };
    // Dedup: skip if turn already mounted (race with loadSessionHistoryToOverlay)
    if (window._sessionTurns && window._sessionTurns.has(fallbackTurn.id)) {
      scheduleBackfill();
      return;
    }
    if (document.querySelector('.turn-card[data-turn-id="' + CSS.escape(fallbackTurn.id) + '"]')) {
      scheduleBackfill();
      return;
    }
    const fallbackEl = mountSessionTurnCard(hubSessionId, fallbackTurn, { kind, autoScroll: true });
    if (fallbackEl) {
      fallbackEl.dataset.provisional = 'true';
      fallbackEl.dataset.provisionalText = fallbackTurn.text || '';
    }
    scheduleBackfill();
  } catch (err) {
    console.warn('[turn-complete-event] failed to render new turn:', err);
  }
});

function wrapPathLinksInElement(rootEl, opts = {}) {
  if (!rootEl) return;
  const cwd = opts.cwd || getSessionCwd(opts.sessionId || activeSessionId) || null;
  // marked 已经生成的 <a> 过去会被下面的 TreeWalker 故意跳过，因此
  // [报告](C:\path\report.md) 只剩“报告”文字，且点击绕过 Hub。本地 href
  // 先升级成统一 rt-file-link；网页 URL 仍保持标准 Markdown 链接语义。
  for (const a of rootEl.querySelectorAll('a[href]:not(.rt-file-link)')) {
    if (a.closest('button, textarea, input, select')) continue;
    const local = classifyLocalPathHref(a.getAttribute('href') || '', cwd);
    if (!local) continue;
    a.classList.add('rt-file-link');
    a.setAttribute('data-path', local.openPath);
    if (cwd) a.setAttribute('data-cwd', cwd);
    a.setAttribute('href', '#');
    a.title = local.openPath === local.displayPath
      ? local.openPath
      : `打开 ${local.openPath}（CLI 原文：${local.displayPath}）`;
    // 本地路径不能像网页 URL 那样只显示描述文字，否则卡片会丢失 CLI 中
    // 真正的路径信息。显示原始 destination，data-path 则使用纠错后的路径。
    a.textContent = local.displayPath;
  }
  const SKIP_TAGS = new Set(['A', 'SCRIPT', 'STYLE', 'BUTTON', 'TEXTAREA', 'INPUT', 'SELECT']);
  if (opts.skipCodeBlocks) SKIP_TAGS.add('PRE');
  const walker = document.createTreeWalker(rootEl, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      let p = node.parentNode;
      while (p && p !== rootEl) {
        if (p.nodeType === 1 && SKIP_TAGS.has(p.tagName)) return NodeFilter.FILTER_REJECT;
        p = p.parentNode;
      }
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  const targets = [];
  let node;
  // Share paths are resolved in the background (see path-candidates.js); this
  // element is wrapped again once one of them turns out to exist.
  const pathOpts = { onNetworkPending: () => _networkPendingWraps.set(rootEl, opts) };
  while ((node = walker.nextNode())) {
    const text = normalizeMarkdownPathBreaks(node.nodeValue);
    const candidates = collectPathCandidates(text, cwd, pathOpts);
    if (candidates.length > 0) targets.push({ textNode: node, text, candidates });
  }
  for (const { textNode, text, candidates } of targets) {
    const frag = document.createDocumentFragment();
    let last = 0;
    for (const c of candidates) {
      if (c.start < last) continue;
      if (c.start > last) frag.appendChild(document.createTextNode(text.slice(last, c.start)));
      const a = document.createElement('a');
      a.className = 'rt-file-link';
      a.setAttribute('data-path', c.openPath);
      if (cwd) a.setAttribute('data-cwd', cwd);
      a.title = c.openPath;
      a.textContent = text.slice(c.start, c.end + 1);
      frag.appendChild(a);
      last = c.end + 1;
    }
    if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
    textNode.parentNode.replaceChild(frag, textNode);
  }
}
window.wrapPathLinksInElement = wrapPathLinksInElement;
onNetworkPathResolved(() => {
  const pending = [..._networkPendingWraps];
  _networkPendingWraps.clear();
  for (const [element, wrapOpts] of pending) {
    if (element.isConnected) wrapPathLinksInElement(element, wrapOpts);
  }
});

// rt-file-link click → openPreviewPanel (only for cards inside .msg-overlay,
// don't conflict with meeting-room.js handler which targets its own scope)
document.addEventListener('click', (e) => {
  const a = e.target.closest && e.target.closest('a.rt-file-link');
  if (!a) return;
  if (!a.closest('.msg-overlay')) return;
  e.preventDefault();
  e.stopPropagation();
  const path = a.dataset.path;
  const ownerCwd = a.dataset.cwd || getSessionCwd(activeSessionId);
  if (path) openPathInHub(path, { cwd: ownerCwd, requireExistsForRel: false });
}, true);

// === Spec 1 v0.9.0 · D5 操作按钮 click ===
function getTurnFromCard(cardEl) {
  const memberView = cardEl?.closest('[data-group-member]')?._memberView;
  if (memberView) return memberView.turns.get(cardEl.dataset.turnId) || null;
  if (cardEl?.closest('[data-split-secondary]')) return sessionSplit?.secondary()?.turns.get(cardEl.dataset.turnId) || null;
  if (!cardEl || !window._sessionTurns) return null;
  return window._sessionTurns.get(cardEl.dataset.turnId);
}

// 卡片上的操作必须作用于「这张卡片所属的会话」，而不是全局激活的那个。
//
// 2026-07-28 串台事故：用户在群聊 A 里单独打开 Kimi 的卡片视图、对着一张历史
// 卡片重发提问，消息却发到了群聊 B 的 Claude —— 因为 resend / regen /
// prompt-inspect 三处都直接取全局 activeSessionId。只要用户上一次交互把焦点
// 落在别的会话上，卡片操作就会打到错误的 CLI，而且两边界面都看不出异常。
//
// turn-card-renderer 早就把 sessionId 存进了 cardEl.dataset.sessionId
// （见该文件 rerenderTurn 附近的注释），这里以它为准；只有实在拿不到才退回
// 全局值。
function getCardSessionId(cardEl) {
  const own = cardEl && cardEl.dataset && cardEl.dataset.sessionId;
  if (own) return own;
  return (typeof activeSessionId !== 'undefined' && activeSessionId)
    || (typeof currentSessionId !== 'undefined' && currentSessionId)
    || null;
}

document.addEventListener('click', async (e) => {
  const btn = e.target.closest('.ta-btn');
  if (!btn) return;
  const card = btn.closest('.turn-card');
  if (!card || !card.closest('.msg-overlay')) return;
  const turn = getTurnFromCard(card);
  if (!turn) return;
  const action = btn.dataset.action;

  if (action === 'copy') {
    // 复制用户实际看到的回答正文，不复制 markdown 围栏、toolCalls 原始块，
    // 也不把 hover 出来的 Copy/Bash/展开按钮混进剪贴板。
    const visibleText = extractVisibleCardText(card.querySelector('.turn-body'));
    if (btn.disabled) return;
    const orig = btn.textContent;
    btn.disabled = true;
    btn.textContent = '复制中…';
    try {
      const result = await clipboardController.copyText(visibleText, { source: 'card', silent: true });
      btn.textContent = result.ok ? '✓' : '复制失败';
      if (!result.ok) clipboardController.showFeedback(result);
    } catch (error) {
      btn.textContent = '复制失败';
      clipboardController.showFeedback({ ok: false, reason: error.message, source: 'card' });
    } finally {
      btn.disabled = false;
      setTimeout(() => { btn.textContent = orig; }, 1500);
    }
    return;
  }

  if (action === 'multi-select') {
    // 微信式多选：以点中的这张卡片为起点进入，随后整片卡片区的点击都变成勾选。
    if (card.closest('[data-group-member]')) card.closest('[data-group-member]')._memberView?.multiSelect.enter(card.dataset.turnId);
    else if (card.closest('[data-split-secondary]')) sessionSplit?.secondary()?.multiSelect.enter(card.dataset.turnId);
    else cardMultiSelectController.enter(card.dataset.turnId);
    return;
  }


  if (action === 'prompt-inspect') {
    const sid = getCardSessionId(card);
    if (typeof window.togglePromptInspector === 'function') {
      window.togglePromptInspector(card, sid);
    }
    return;
  }

  if (action === 'resend' || action === 'regen') {
    // Resend = same user prompt; regen = find prior user prompt then resend
    let promptText = null;
    if (action === 'resend') {
      promptText = turn.assistantContext?.userText ?? turn.text;
    } else {
      // regen: walk DOM up looking for prior user .turn-card
      const owner = getCardSessionId(card);
      const cards = [...card.closest('.msg-overlay').querySelectorAll('.turn-card')]
        .filter(item => getCardSessionId(item) === owner);
      const myIdx = cards.indexOf(card);
      for (let i = myIdx - 1; i >= 0; i--) {
        if (cards[i].classList.contains('user')) {
          const userTurn = getTurnFromCard(cards[i]);
          if (userTurn) promptText = userTurn.assistantContext?.userText ?? userTurn.text;
          break;
        }
      }
    }
    if (!promptText) return;
    // 复用 terminal-input IPC，不新增 channel。
    // sid 必须取自这张卡片（getCardSessionId），不能用全局 activeSessionId ——
    // 否则在 A 会话的卡片上点重发，消息会打进当时恰好激活的 B 会话。
    const sid = getCardSessionId(card);
    if (action === 'regen') {
      if (['commentary', 'activity'].includes(turn.phase)) return;
      const target = sessions.get(sid);
      const confirmed = await turnCardRenderer.confirmCardResend({
        text: promptText, sessionLabel: (target?.name || target?.title || target?.kind || '会话') + ' · ' + sid,
      });
      if (!confirmed) return;
      if (!sessions.has(sid)) { showPreviewNotice('目标会话已关闭，未重发。', 'error'); return; }
    }
    if (!sid || !sessions.has(sid)) { showPreviewNotice('目标会话已关闭，未重发。', 'error'); return; }
    const original = btn.textContent;
    let error = card.querySelector('.native-card-send-error');
    if (!error) { error = document.createElement('div'); error.className = 'native-card-send-error'; error.setAttribute('role', 'alert'); card.append(error); }
    error.textContent = ''; btn.disabled = true; btn.textContent = '提交中';
    if (!isNativeSession(sessions.get(sid))) armPtyBurstFallback(sid);
    ipcRenderer.invoke('session:send-prompt', { sessionId: sid, text: promptText, clientSubmissionId: require('node:crypto').randomUUID() })
      .then(result => {
        if (!result?.ok || result?.notSent) throw new Error(result?.message || '消息未能发送，请查看终端后重试');
      })
      .catch(problem => { error.textContent = problem.message; })
      .finally(() => { btn.disabled = false; btn.textContent = original; });
    return;
  }

  if (action === 'edit-resend') {
    // Hub uses contenteditable div for input (not textarea):
    // - Single session: `<div class="floating-input-box" contenteditable>`
    // - Group chat: `<div id="mr-input-box" contenteditable>`
    // 输入框是按会话挂载的（mountFloatingInput 闭包绑定 sessionId），而这里用
    // document.querySelector 全局取第一个 —— 命中的很可能是另一个会话的框，
    // 文本填进去、用户一回车就发去了错误的 CLI。卡片不属于当前激活会话时直接
    // 拒绝，宁可少一次便利也不要串台（2026-07-28）。
    const cardSid = getCardSessionId(card);
    const groupMember = card.closest('[data-group-member]');
    const liveSid = groupMember ? groupMember.dataset.groupMember : card.closest('[data-split-secondary]') ? sessionSplit?.secondary()?.sessionId
      : (typeof activeSessionId !== 'undefined' && activeSessionId) || null;
    if (cardSid && liveSid && String(cardSid) !== String(liveSid)) {
      console.warn('[edit-resend] 卡片属于会话', cardSid, '，当前激活的是', liveSid,
        '——已跳过填入，避免把内容写进别的会话的输入框');
      return;
    }
    const inputEl = card.closest('.terminal-panel')?.querySelector('.floating-input-box')
      || document.getElementById('mr-input-box');
    if (inputEl) {
      // 2026-05-09 maintainer：用户原则 — 输入框只能由"发送 / 手动编辑"改动；
      // 已有内容时 edit-resend 不再覆盖（避免吞掉用户正在写的内容）。
      const cur = (inputEl.innerText || '').trim();
      if (cur) {
        console.warn('[edit-resend] 输入框已有内容，跳过自动填入历史消息');
        return;
      }
      const group = groupMember ? MeetingRoom.getMeetingData(MeetingRoom.getActiveMeetingId()) : null;
      const memberIndex = group?.subSessions.indexOf(cardSid);
      const mention = group ? '@' + (group.slotSpecs?.[memberIndex]?.memberId || 'm' + (memberIndex + 1)) + ' ' : '';
      inputEl.textContent = mention + (turn.assistantContext?.userText ?? turn.text ?? '');
      inputEl.dispatchEvent(new Event('input', { bubbles:true }));
      inputEl.focus();
      // Place cursor at end (contenteditable doesn't have setSelectionRange)
      try {
        const range = document.createRange();
        range.selectNodeContents(inputEl);
        range.collapse(false);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
      } catch {}
    }
    return;
  }
});

// === Spec 1 v0.9.0 · 视图切换 ===
// AI 会话默认卡片；后台仅由当前查看期间的显式操作打开。
let currentView = 'card'; // 'card' | 'pty'
let _cardViewBottomRestoreRaf = null;
const _cardOverlayFollowBottomBySession = new Map();

// Legacy view choices remain compatible with explicit tools; ordinary navigation
// always starts with cards, independently of the underlying CLI runtime.
const cardViewSessions = readCardViewSessions(localStorage);
function selectionViewModeForSession(sessionId, session) {
  const cardCapable = !!session && session.kind !== 'powershell';
  return selectionViewModeFor(cardViewSessions, sessionId, { cardCapable });
}
function rememberViewModeForSession(sessionId, mode) {
  if (rememberViewMode(cardViewSessions, sessionId, mode)) writeCardViewSessions(localStorage, cardViewSessions);
}
function forgetViewModeForSession(sessionId) {
  if (memberCardDefaults.delete(sessionId)) {
    writeCardViewSessions(localStorage, memberCardDefaults, MEMBER_VIEW_DEFAULTS_KEY);
  }
  _cardOverlayFollowBottomBySession.delete(sessionId);
  if (forgetViewMode(cardViewSessions, sessionId)) writeCardViewSessions(localStorage, cardViewSessions);
}
let _terminalRuntimeStatusTicker = null;
const { createCardQuestionNavigator } = require('./card-question-navigator.js');
const cardQuestionNavigator = createCardQuestionNavigator({
  document,
  window,
  overlay: document.getElementById('msg-overlay'),
  root: document.getElementById('card-question-nav'),
  getCurrentView: () => currentView,
  getActiveSessionId: () => activeSessionId,
  getTurnById: (turnId) => window._sessionTurns && window._sessionTurns.get(turnId),
  requestAnimationFrame: callback => requestAnimationFrame(callback),
  cancelAnimationFrame: handle => cancelAnimationFrame(handle),
});
cardQuestionNavigator.init();

// === Spec 3 · W15+W16: streaming indicator ===
// RuntimeTruth 的 starting/running 同时驱动 header、侧栏与卡片内提示；原始 PTY
// 字节突发只是最低置信度兜底，不能再单独定义“agent 还在干活”。
//
// W16 改进：
// (1) 防 flash 延迟移除：assistant 一轮完成（end_turn）→ 短暂 silence → status=idle，
//     接着可能又有下一轮 → status=running。中间 gap 让 indicator 闪烁，不友好。
//     status idle 时延迟 1.5s 才移除（gap < 1.5s 时 indicator 视觉上保持显示）。
// (2) 文案动态：0 卡时显示"Claude 正在思考…"（首响应等待）；
//     ≥1 卡时显示"Claude 还在生成更多回复…"（暗示后续还有，user 关心的核心）。
const _W16_DELAYED_REMOVE_MS = 1500;
const _w16RemoveTimers = new Map(); // sessionId → setTimeout id
const _codexSubmitPendingTimers = new Map(); // sessionId -> setTimeout id
const _kimiBackgroundFinishTimers = new Map(); // sessionId -> setTimeout id
const _CODEX_CARD_SUBMIT_PENDING_MS = 15 * 1000;
const _CODEX_CARD_WORK_MAX_MS = 45 * 60 * 1000;
const _KIMI_BACKGROUND_FINISH_GRACE_MS = 30 * 1000;

function markCodexCardWorking(sessionId, source = 'prompt', runtimeOptions = {}) {
  const session = sessions.get(sessionId);
  if (isNativeAgent(session)) return;
  if (!session || !isTranscriptCliKind(session.kind) || session.status === 'dormant') return;
  if (_codexSubmitPendingTimers.has(sessionId)) {
    clearTimeout(_codexSubmitPendingTimers.get(sessionId));
    _codexSubmitPendingTimers.delete(sessionId);
  }
  if (source === 'floating_input') {
    applyPromptSubmitted(session, { submittedAt: Date.now() });
  } else {
    clearSessionAttention(session);
  }
  const observedAt = Number(runtimeOptions.observedAt) || Date.now();
  const confirmedRunning = source === 'task_started'
    || source === 'rollout_task_started'
    || source === 'kimi_background_agent';
  const runtimeState = confirmedRunning ? RUNTIME_RUNNING : RUNTIME_STARTING;
  const confidence = source === 'task_started' || source === 'rollout_task_started'
    ? CONFIDENCE_AUTHORITATIVE
    : CONFIDENCE_SEMANTIC;
  session.cardWorkingSince = observedAt;
  if (!session.runStartedAt) session.runStartedAt = session.cardWorkingSince;
  session.cardWorkingSource = source;
  session._agentWorking = 'card';
  session._runSource = 'semantic';
  session._lastOutputTs = observedAt;
  const provider = isKimiCliKind(session.kind)
    ? 'kimi'
    : String(session.kind || '').replace(/-resume$/i, '').toLowerCase() === 'gemini'
      ? 'gemini'
      : 'codex';
  observeSessionRuntime(session, {
    state: runtimeState,
    source: `${provider}-${source}`,
    confidence,
    observedAt,
    startedAt: Number(runtimeOptions.startedAt) || session.runStartedAt || observedAt,
    turnId: runtimeOptions.turnId || null,
    evidence: runtimeOptions.evidence || null,
  });
  if (typeof _updateStreamingIndicator === 'function') _updateStreamingIndicator(sessionId);
  if (source === 'floating_input') {
    const timer = setTimeout(() => {
      _codexSubmitPendingTimers.delete(sessionId);
      const latest = sessions.get(sessionId);
      if (!latest || latest.cardWorkingSource !== 'floating_input') return;
      latest.cardWorkingSince = null;
      latest.cardWorkingSource = null;
      latest._agentWorking = null;
      latest._runSource = null;
      latest.runStartedAt = null;
      observeSessionRuntime(latest, {
        state: RUNTIME_UNKNOWN,
        source: 'codex-submit-timeout',
        confidence: CONFIDENCE_INFERRED,
        observedAt: Date.now(),
        reason: 'no-task-started-or-pty-running-evidence',
      });
      disarmPtyBurstFallback(latest);
      if (typeof _updateStreamingIndicator === 'function') _updateStreamingIndicator(sessionId);
      scheduleSessionListRender();
    }, _CODEX_CARD_SUBMIT_PENDING_MS);
    _codexSubmitPendingTimers.set(sessionId, timer);
  }
}

function clearCodexCardWorking(sessionId) {
  const session = sessions.get(sessionId);
  if (!session) return;
  if (_codexSubmitPendingTimers.has(sessionId)) {
    clearTimeout(_codexSubmitPendingTimers.get(sessionId));
    _codexSubmitPendingTimers.delete(sessionId);
  }
  session.cardWorkingSince = null;
  session.cardWorkingSource = null;
  session._agentWorking = null;
  session._runSource = null;
  disarmPtyBurstFallback(session);
}

function hasKimiBackgroundWork(session) {
  return !!(
    session
    && session._kimiBackgroundJobs instanceof Set
    && session._kimiBackgroundJobs.size > 0
  );
}

function clearKimiBackgroundFinishTimer(sessionId) {
  const timer = _kimiBackgroundFinishTimers.get(sessionId);
  if (!timer) return;
  clearTimeout(timer);
  _kimiBackgroundFinishTimers.delete(sessionId);
}

function onKimiBackgroundWorkEvent(payload) {
  const { hubSessionId, phase, jobId } = payload || {};
  if (!hubSessionId || !jobId) return;
  const session = sessions.get(hubSessionId);
  if (!session || !isKimiCliKind(session.kind) || session.status === 'dormant') return;
  if (!(session._kimiBackgroundJobs instanceof Set)) session._kimiBackgroundJobs = new Set();

  if (phase === 'started') {
    clearKimiBackgroundFinishTimer(hubSessionId);
    session._kimiBackgroundJobs.add(String(jobId));
    markCodexCardWorking(hubSessionId, 'kimi_background_agent', { observedAt: Date.now() });
    scheduleSessionListRender();
    schedulePersist();
    return;
  }

  if (phase !== 'finished') return;
  session._kimiBackgroundJobs.delete(String(jobId));
  if (hasKimiBackgroundWork(session)) {
    markCodexCardWorking(hubSessionId, 'kimi_background_agent', { observedAt: Date.now() });
    scheduleSessionListRender();
    return;
  }

  // tool.result is normally followed by Kimi's final step.end, which clears the
  // working state through the existing turn-complete path. If that record is
  // missing, stop showing a stale green light after a short grace period.
  clearKimiBackgroundFinishTimer(hubSessionId);
  const timer = setTimeout(() => {
    _kimiBackgroundFinishTimers.delete(hubSessionId);
    const latest = sessions.get(hubSessionId);
    if (!latest || hasKimiBackgroundWork(latest)) return;
    if (latest.cardWorkingSource !== 'kimi_background_agent') return;
    clearCodexCardWorking(hubSessionId);
    observeSessionRuntime(latest, {
      state: RUNTIME_UNKNOWN,
      source: 'kimi-background-finished-no-turn-complete',
      confidence: CONFIDENCE_INFERRED,
      observedAt: Date.now(),
      reason: 'background-finished-without-authoritative-turn-complete',
    });
    if (typeof _updateStreamingIndicator === 'function') _updateStreamingIndicator(hubSessionId);
    scheduleSessionListRender();
    schedulePersist();
  }, _KIMI_BACKGROUND_FINISH_GRACE_MS);
  _kimiBackgroundFinishTimers.set(hubSessionId, timer);
}

function hasSemanticCardWorking(session) {
  if (!session) return false;
  if (!isTranscriptCliKind(session.kind) || sessionNeedsUserInput(session) || !session.cardWorkingSince) return false;
  const maxAge = session.cardWorkingSource === 'floating_input'
    ? _CODEX_CARD_SUBMIT_PENDING_MS
    : _CODEX_CARD_WORK_MAX_MS;
  if (Date.now() - session.cardWorkingSince > maxAge) {
    session.cardWorkingSince = null;
    session.cardWorkingSource = null;
    return false;
  }
  return true;
}

function isSessionCardWorking(session) {
  if (!session) return false;
  return sessionRuntimeIsActive(session);
}

function cardWorkingLabel(session) {
  if (!session) return 'AI';
  const base = isCodexKind(session.kind) ? 'Codex' : isKimiCliKind(session.kind) ? 'Kimi' : (session.kind || 'AI');
  return base.charAt(0).toUpperCase() + base.slice(1).replace(/-resume$/i, '');
}

function _updateStreamingIndicator(sessionId) {
  if (sessionId !== activeSessionId) return;
  const overlay = document.getElementById('msg-overlay');
  if (!overlay) return;
  const sess = sessions.get(sessionId);
  const isRunning = isSessionCardWorking(sess);
  // 多方审查 P1 (DeepSeek + Claude 共识)：querySelector 不带 dataset 过滤会拿到
  // 别 session 残留的 indicator（1.5s 延迟移除期间），快速切 session 时新 session
  // 会"接管"旧 indicator 导致显示错乱或 timer 触发时误删新 session 的 indicator。
  // 加 [data-session-id] 过滤强 session 隔离。
  const sidStr = String(sessionId);
  let indicator = overlay.querySelector(`.streaming-indicator[data-session-id="${CSS.escape(sidStr)}"]`);
  // 任何状态变化先取消 pending 延迟移除（如 idle→running 在 gap 期间，要立刻取消移除）
  if (_w16RemoveTimers.has(sessionId)) {
    clearTimeout(_w16RemoveTimers.get(sessionId));
    _w16RemoveTimers.delete(sessionId);
  }
  if (isRunning && currentView === 'card') {
    // Own the status at the stream tail. Activity cards may be hidden and
    // progress headers may be folded; neither can own live runtime feedback.
    const targetParent = overlay;

    if (!indicator) {
      // 2026-05-06 maintainer scroll-respect-user:append 前记录是否在底部,仅满足条件才滚
      //   (status running↔idle 反复切换时频繁触发的强制 scroll 是历史 bug 主因之一)
      const wasAtBottom = _isCardOverlayAtBottom(overlay);
      indicator = document.createElement('span');
      indicator.className = 'streaming-indicator';
      indicator.dataset.sessionId = String(sessionId);
      indicator.innerHTML = '<span class="spinner-icon" aria-hidden="true"></span>';
      targetParent.appendChild(indicator);
      if (wasAtBottom && targetParent === overlay) cardFollowScroll.request();
    } else if (indicator.parentElement !== targetParent || overlay.lastElementChild !== indicator) {
      targetParent.appendChild(indicator);
    }
    // 卡片内常驻短文案；完整上下文仍放 title，header 胶囊显示精确持续时长。
    const cardCount = overlay.querySelectorAll('.turn-card[data-turn-id]').length;
    const label = cardWorkingLabel(sess);
    const pendingSubmit = sess && sess.cardWorkingSource === 'floating_input';
    const runtimeTruth = getSessionRuntimeTruth(sess);
    const starting = runtimeTruth.state === RUNTIME_STARTING;
    indicator.title = pendingSubmit || starting
      ? `${label} 正在接收输入…`
      : (cardCount === 0 ? `${label} 正在工作…` : `${label} 仍在工作，可能还会更新卡片`);
    indicator.setAttribute('aria-label', indicator.title);
    indicator.dataset.label = cardCount === 0
      ? (pendingSubmit || starting ? `${label} 启动中` : `${label} 工作中`)
      : (pendingSubmit || starting ? '启动中' : '工作中');
  } else if (!isRunning && indicator) {
    const runtimeTruth = getSessionRuntimeTruth(sess);
    if (isNativeAgent(sess) || [RUNTIME_WAITING, RUNTIME_COMPLETED, RUNTIME_FAILED, RUNTIME_DORMANT].includes(runtimeTruth.state)) {
      indicator.remove();
      return;
    }
    // 延迟 1.5s 移除（防 silence gap 闪烁）
    const timer = setTimeout(() => {
      _w16RemoveTimers.delete(sessionId);
      const ov = document.getElementById('msg-overlay');
      if (!ov) return;
      // 多方审查 P1：同样按 data-session-id 过滤，只 remove 自己 session 的 indicator
      const cur = ov.querySelector(`.streaming-indicator[data-session-id="${CSS.escape(sidStr)}"]`);
      if (!cur) return;
      // 二次确认：1.5s 后状态仍非 running 才真正移除
      const sess2 = sessions.get(sessionId);
      if (sessionId !== activeSessionId || !sess2 || sess2.status !== 'running' || currentView !== 'card') {
        cur.remove();
      }
    }, _W16_DELAYED_REMOVE_MS);
    _w16RemoveTimers.set(sessionId, timer);
  } else if (currentView !== 'card' && indicator) {
    // 不在卡片视图 → 立即移除（不延迟，因为根本看不见）
    indicator.remove();
  }
}

// remember=false 用于「按会话恢复视图」这种回放场景：那不是用户在表达偏好，
// 不该反过来覆盖记忆。用户点切换按钮走默认的 remember=true。
function applyViewMode(mode, { remember = true, skipPreviousCardCapture = false } = {}) {
  // A native Claude session has a read-only backstage like Codex: engine output
  // is delivered to its terminal, input still goes through the composer
  // (terminal.onData ignores it). Forcing card view here made the 后台 button
  // do nothing.
  const previousView = currentView;
  const overlay = document.getElementById('msg-overlay');
  if (mode !== 'card' && _cardViewBottomRestoreRaf) {
    cancelAnimationFrame(_cardViewBottomRestoreRaf);
    _cardViewBottomRestoreRaf = null;
  }
  if (overlay && activeSessionId && !skipPreviousCardCapture
      && previousView === 'card' && mode !== 'card') {
    _cardOverlayFollowBottomBySession.set(activeSessionId, _isCardOverlayAtBottom(overlay));
  }
  currentView = mode;
  terminalCache.get(activeSessionId)?._codexBackstage?.setVisible(mode === 'pty');
  if (remember) rememberViewModeForSession(activeSessionId, mode);
  if (terminalPanelEl) terminalPanelEl.classList.toggle('card-view-active', mode === 'card');
  if (overlay) overlay.classList.toggle('hidden', mode !== 'card');
  // Selection mounts a new history view next. Measuring the outgoing cards
  // under the new session identity forces an unnecessary synchronous layout.
  if (!skipPreviousCardCapture) cardQuestionNavigator.refresh();
  cardMultiSelectController.setVisible(mode === 'card' && !!activeSessionId);
  syncBackstageButton(skipPreviousCardCapture ? !!activeSessionId : undefined);
  // 切到 PTY 时 refit xterm
  if (mode === 'pty' && typeof terminalCache !== 'undefined') {
    const cached = terminalCache.get(activeSessionId);
    if (cached && cached.fitAddon) {
      setCardHiddenTerminal(cached, false);
      loadGpuRenderer(cached);
      scheduleVisibleTerminalRecovery(activeSessionId, cached, { pinBottom: false });
    }
  }
  if (mode === 'card' && typeof terminalCache !== 'undefined') {
    unloadGpuRenderer(terminalCache.get(activeSessionId));
    setCardHiddenTerminal(terminalCache.get(activeSessionId), true);
  }
  // Spec 3 · W3 resume bug fix (b)：切到卡片时若历史从未全量加载过，
  // 主动 trigger load — 用 _cardHistoryHydratedSid 状态标记而非 DOM 检测，
  // 因为 turn-complete-event 可能已在 overlay 留了单张卡但历史并未 hydrate。
  if (mode === 'card' && overlay && typeof loadSessionHistoryToOverlay === 'function' && activeSessionId && !skipPreviousCardCapture) {
    if (_cardHistoryHydratedSid !== activeSessionId || previousView !== 'card') {
      // PTY output does not update the hidden card DOM. Refresh on return,
      // preserving existing cards and the user's scroll intent.
      loadSessionHistoryToOverlay(activeSessionId, { incremental: _cardHistoryHydratedSid === activeSessionId }).then(r => {
        if (r && r.mounted > 0) _cardHistoryHydratedSid = activeSessionId;
      }).catch(err => {
        console.warn('[applyViewMode card] auto-load failed:', err);
      });
    }
  }
  // Spec 3 · W15：切到 card 立即 sync streaming indicator（active session 可能正在 running）；
  // 切到 PTY 立即移除（_updateStreamingIndicator 内部 currentView !== 'card' 分支处理）。
  if (activeSessionId && typeof _updateStreamingIndicator === 'function') {
    _updateStreamingIndicator(activeSessionId);
  }
  if (!skipPreviousCardCapture) updateFloatingBarState();
  if (overlay && mode === 'card' && previousView !== 'card'
      && _cardOverlayFollowBottomBySession.get(activeSessionId) === true) {
    // updateFloatingBarState re-enables the 31px card footer. That shrinks the
    // message viewport after the old scrollTop was restored and otherwise
    // leaves the newest question partially behind the footer. Preserve user
    // intent: only re-pin when they were already following the bottom before
    // leaving card view; a reader who scrolled up stays exactly where they were.
    const pinBottom = () => cardFollowScroll.request();
    const restoreSessionId = activeSessionId;
    pinBottom();
    if (_cardViewBottomRestoreRaf) cancelAnimationFrame(_cardViewBottomRestoreRaf);
    _cardViewBottomRestoreRaf = requestAnimationFrame(() => {
      _cardViewBottomRestoreRaf = null;
      if (currentView === 'card' && activeSessionId === restoreSessionId) pinBottom();
    });
  }
}

function clearRuntimeTruthExpiryTimer(sessionId) {
  const timer = _runtimeTruthExpiryTimers.get(sessionId);
  if (!timer) return;
  clearTimeout(timer);
  _runtimeTruthExpiryTimers.delete(sessionId);
}

function observeSessionRuntime(sessionOrId, observation, options = {}) {
  const session = typeof sessionOrId === 'string' ? sessions.get(sessionOrId) : sessionOrId;
  if (!session) return { applied: false, reason: 'missing-session' };
  const result = applySessionRuntimeObservation(session, observation, options);
  if (!result.applied) return result;
  clearRuntimeTruthExpiryTimer(session.id);
  if (!result.truth || !result.truth.expiresAt) return result;
  const sequence = result.truth.sequence;
  const delay = Math.max(0, result.truth.expiresAt - Date.now() + 5);
  const timer = setTimeout(() => {
    _runtimeTruthExpiryTimers.delete(session.id);
    const latest = sessions.get(session.id);
    if (!latest || latest !== session || !latest.runtimeTruth || latest.runtimeTruth.sequence !== sequence) return;
    if (Date.now() < Number(latest.runtimeTruth.expiresAt || 0)) return;
    const expiredSource = latest.runtimeTruth.source || 'runtime-observation';
    latest._agentWorking = null;
    latest._runSource = null;
    latest.cardWorkingSince = null;
    latest.cardWorkingSource = null;
    latest.runStartedAt = null;
    applySessionRuntimeObservation(latest, {
      state: RUNTIME_UNKNOWN,
      source: `expired:${expiredSource}`,
      confidence: CONFIDENCE_NONE,
      observedAt: Date.now(),
      reason: 'observation-expired',
    });
    if (typeof _updateStreamingIndicator === 'function') _updateStreamingIndicator(latest.id);
    scheduleSessionListRender();
  }, delay);
  _runtimeTruthExpiryTimers.set(session.id, timer);
  return result;
}

function recoverVisibleActiveTerminalSurface() {
  // Chromium can evict an xterm Canvas/WebGL surface while the Hub window is
  // hidden without changing the terminal's geometry. ResizeObserver therefore
  // has nothing to report when the window returns, even though the logical
  // buffer is still complete. Repaint only the visible PTY; do not move the
  // user's scroll position.
  if (currentView !== 'pty' || activeMeetingId || !activeSessionId) return false;
  const cached = terminalCache.get(activeSessionId);
  if (!cached || !cached.fitAddon) return false;
  scheduleVisibleTerminalRecovery(activeSessionId, cached, { pinBottom: false });
  return true;
}

document.addEventListener('click', (e) => {
  const btn = e.target.closest('#btn-backstage');
  if (btn && !btn.hidden && sessionSplit?.isSecondaryFocused()) {
    sessionSplit.secondary().toggleMode();
    btn.setAttribute('aria-pressed', String(sessionSplit.secondary().mode() === 'pty'));
    return;
  }
  if (btn && !btn.hidden && activeSessionId && !currentAppToolbarView()) {
    applyViewMode(currentView === 'pty' ? 'card' : 'pty');
  }
});

// T10 placeholder: "切到 PTY 视图" link
document.addEventListener('click', (e) => {
  const starter = e.target.closest && e.target.closest('[data-welcome-prompt]');
  if (starter) {
    const box = starter.closest('.terminal-panel')?.querySelector('.floating-input-box');
    if (box) {
      if (!box.textContent.trim() && !box.querySelector('img, [data-file-path]')) {
        box.textContent = starter.dataset.welcomePrompt;
        box.dispatchEvent(new Event('input', { bubbles: true }));
      }
      box.focus();
      const range = document.createRange();
      range.selectNodeContents(box); range.collapse(false);
      const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
    }
    return;
  }
  const a = e.target.closest && e.target.closest('[data-action="switch-to-pty"]');
  if (!a) return;
  e.preventDefault();
  if (typeof applyViewMode === 'function') applyViewMode('pty');
});

// 卡片层要按 header / 输入栏的**实测**高度让位，不能写死常量。
// 详见 styles/card-view.css 里 .msg-overlay 的注释。
function measureFloatingBarVisualHeight(bar) {
  if (!bar || bar.classList.contains('composer-is-collapsed')) return 0;
  const barRect = bar.getBoundingClientRect();
  let top = barRect.top;
  let bottom = barRect.bottom;
  for (const child of bar.children) {
    if (getComputedStyle(child).display === 'none') continue;
    const rect = child.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) continue;
    top = Math.min(top, rect.top);
    bottom = Math.max(bottom, rect.bottom);
  }
  return Math.ceil(Math.max(0, bottom - top));
}

// 「消息没提交」必须看得见（2026-09-03）。
//   闭环发送已经把静默卡死的概率压到很低，但只要还有残余概率，就不能让它无声无息 ——
//   用户上一次的体验就是"以为发出去了，几十秒后才发现 AI 根本没动"。
//   这里不自动重发：能否安全重发取决于原文还在不在 CLI 输入框里，
//   那个判断在主进程的 resendCurrentPrompt 里做（含指纹比对），点按钮才触发。
const { beginPromptDelivery, applyPromptReceipt } = require('./prompt-delivery-state.js');
const floatingPromptDeliveries = new Map();

function updateFloatingPromptReceipt(receipt) {
  if (!receipt?.sessionId) return;
  const state = floatingPromptDeliveries.get(receipt.sessionId);
  if (!applyPromptReceipt(state, receipt)) return;
  paintNativePromptReceipts(receipt.sessionId);
  if (state.status === 'content-mismatch' && !state.dismissed) notifyPromptContentMismatch(state);
  for (const bar of document.querySelectorAll('.floating-input-bar')) {
    if (bar.dataset.sessionId !== receipt.sessionId) continue;
    if (['confirmed', 'delivered', 'queued'].includes(state.status)) clearFloatingInputStuck(bar);
    else if (!state.dismissed) {
      if (state.status === 'content-mismatch') clearFloatingInputStuck(bar);
      markFloatingInputStuck(bar, receipt.sessionId);
    }
  }
}

ipcRenderer.on('session:prompt-receipt', (_event, receipt) => updateFloatingPromptReceipt(receipt));

ipcRenderer.on('session:command-updated', (_event, event) => {
  requestCardIncrementalRefresh(event.sessionId, { reason: 'command' });
});

ipcRenderer.on('native-agent-item', (_event, event) => {
  if (event.source === 'claude-stream-json') {
    recordNativeContent(sessions.get(event.sessionId), event);
    requestCardIncrementalRefresh(event.sessionId, { reason: 'native-item' });
  }
});

function paintNativePromptReceipts(sessionId) {
  const session = sessions.get(sessionId);
  if (!['codex-app-server', 'claude-stream-json'].includes(session?.runtimeBackend)) return;
  const local = floatingPromptDeliveries.get(sessionId);
  for (const card of document.querySelectorAll('.turn-card.user[data-submission-id]')) {
    if (card.dataset.sessionId !== sessionId) continue;
    const id = card.dataset.submissionId;
    const target = card.querySelector('.turn-prompt-receipt');
    if (!target) continue;
    const text = promptReceipt(session, id, { authoritative: card.dataset.receiptAuthoritative === 'true',
      deliveryStatus: card.dataset.deliveryStatus,
      local: local?.clientSubmissionId === id ? local : null });
    if (target.textContent !== text) target.textContent = text;
  }
}

function clearFloatingInputStuck(bar) {
  if (!bar) return;
  const existing = bar.querySelector('.fi-stuck');
  if (existing) existing.remove();
}

// 当前项目规则要求未确认结果可见。补发绑定本次提交身份，由主进程
// 核对回执和当前输入行；不能把上一轮运行或未知结果当作已经收到。
function markFloatingInputStuck(bar, sessionId) {
  const delivery = floatingPromptDeliveries.get(sessionId);
  if (!bar || !delivery || delivery.dismissed || ['pending', 'confirmed', 'delivered', 'queued'].includes(delivery.status)) {
    clearFloatingInputStuck(bar); return;
  }
  let row = bar.querySelector('.fi-stuck');
  if (row?.dataset.submissionId !== delivery.clientSubmissionId) { clearFloatingInputStuck(bar); row = null; }
  if (!row) {
    row = document.createElement('div'); row.className = 'fi-stuck';
    row.dataset.submissionId = delivery.clientSubmissionId;
    const label = document.createElement('span'); label.className = 'fi-stuck-label';
    const resend = document.createElement('button'); resend.type = 'button';
    resend.className = 'fi-stuck-resend'; resend.textContent = '补发';
    resend.title = '先核对本次接收回执和 CLI 输入行，再决定是否补回车';
    resend.addEventListener('click', async (event) => {
      event.stopPropagation();
      if (floatingPromptDeliveries.get(sessionId) !== delivery || delivery.status === 'content-mismatch' || row.dataset.busy === 'true') return;
      row.dataset.busy = 'true';
      resend.disabled = true; resend.textContent = '核对中…';
      try {
        const result = await ipcRenderer.invoke('session:resend-prompt', { sessionId, clientSubmissionId: delivery.clientSubmissionId });
        if (floatingPromptDeliveries.get(sessionId) !== delivery) return;
        if (result?.receipt) updateFloatingPromptReceipt(result.receipt);
        if (delivery.status === 'confirmed' || result?.mode === 'already-submitted') { clearFloatingInputStuck(bar); return; }
        if (row.isConnected) label.textContent = result?.message || '仍未确认，请到后台核对是否收到；未重复发送正文';
      } catch (error) {
        if (row.isConnected) label.textContent = '核对未完成，请到后台查看是否收到';
      } finally {
        delete row.dataset.busy;
        if (row.isConnected) { resend.textContent = '补发'; resend.disabled = delivery.status === 'content-mismatch' || isNativeAgent(sessions.get(sessionId)); }
      }
    });
    const dismiss = document.createElement('button'); dismiss.type = 'button';
    dismiss.className = 'fi-stuck-dismiss'; dismiss.textContent = '忽略';
    dismiss.addEventListener('click', (event) => {
      event.stopPropagation(); delivery.dismissed = true;
      for (const other of document.querySelectorAll('.floating-input-bar')) if (other.dataset.sessionId === sessionId) clearFloatingInputStuck(other);
    });
    row.append(label, resend, dismiss);
    const stack = bar.querySelector('.fi-content-stack') || bar;
    stack.insertBefore(row, stack.firstChild);
  }
  row.querySelector('.fi-stuck-label').textContent = delivery.status === 'content-mismatch'
    ? '接收内容与原文的换行或空白不同，请到后台核对'
    : '暂未确认 agent 收到消息，请核对后台或点击补发';
  row.querySelector('.fi-stuck-resend').disabled = row.dataset.busy === 'true' || delivery.status === 'content-mismatch' || isNativeAgent(sessions.get(sessionId));
}

// 明确失败还要归还原文并解释原因，不能仅显示未确认状态。
function reportFloatingSendFailure(sessionId, inputBox, text, reason) {
  const restored = !!inputBox && !readContenteditablePlainText(inputBox) && !!text;
  if (restored) { replaceContenteditableText(inputBox, text); saveFloatingInputDraft(sessionId, inputBox); }
  showToast(`发送失败：${reason}。${restored ? '原文已放回输入框；' : ''}请先在终端核对是否已收到，再决定是否重发`, 'error');
}

function notifyPromptContentMismatch(delivery) {
  if (!delivery || delivery._mismatchNotified) return;
  delivery._mismatchNotified = true;
  showToast('终端收到的内容与原文在换行或空白上不一致，请在终端核对；不会自动补发', 'error');
}

function lockFloatingInputBarGeometry(bar) {
  if (!bar) return 0;
  const height = Math.ceil(bar.getBoundingClientRect().height || bar.offsetHeight || 0);
  if (height <= 0) return 0;
  bar.style.setProperty('--fi-layout-h', `${height}px`);
  bar.classList.add('geometry-locked');
  return height;
}

function observeTerminalPanelChrome(panel, bar) {
  if (!panel) return null;
  const header = panel.querySelector('.terminal-header');
  const apply = () => {
    // ResizeObserver can deliver an old session's callback after a switch.
    if (bar && bar.parentNode !== panel) return;
    // offsetHeight 含 border，正是 overlay 需要让开的实际占位。
    // 输入栏 display:none（只读会话）时自然是 0，overlay 就能铺到底。
    panel.style.setProperty('--term-header-h', `${header ? header.offsetHeight : 0}px`);
    panel.style.setProperty('--fi-bar-h', `${measureFloatingBarVisualHeight(bar)}px`);
  };
  apply();
  if (typeof ResizeObserver !== 'function') return { disconnect() {} };
  const observer = new ResizeObserver(apply);
  if (header) observer.observe(header);
  if (bar) {
    observer.observe(bar);
    for (const child of bar.children) observer.observe(child);
  }
  return observer;
}

// ── T1 冷杉 v2 · composer 的几个共用小工具 ──────────────────────────────────

// CLI 的输入框以下全是 TUI 装饰（Codex 会在提示符下面再画一行
// 「<模型> <档位> · Context N% left · <cwd>」，Claude 有快捷键提示），
// 它们不是 AI 说的话。2026-09-07 实测：Codex 真问出「你选择 A 还是 B？」时，
// isWaitingForUser 从末尾往回找到的第一句「有意义的话」是那行状态栏，
// 于是判定 waiting=false —— 检测器本身没错，是喂给它的尾巴里混进了装饰。
// 这里在**输入框那一行**把尾巴切断，只把它上面的输出交给同一个检测器。
const COMPOSER_EMPTY_PROMPT_RE = /^[\s│╭─╮╰╯]*[❯›>]\s*$/;
function tailAboveCliPrompt(lines) {
  let cut = -1;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i] || '';
    if (PROMPT_PREFIX_RE.test(line) || COMPOSER_EMPTY_PROMPT_RE.test(line)) { cut = i; break; }
  }
  return cut < 0 ? lines : lines.slice(0, cut);
}

// 「等你回答」的第二个证据来源。
//
// 会话级的 attention 信号（sessionNeedsUserInput 读取）目前
// **只有 Claude 的回合结束路径会点亮**：onReplyCompleteFromHook 里跑一次
// isWaitingForUser。Codex 那条 transcript 完成路径不调用它，所以 Codex 真的问了
// 「你选择 A 还是 B？」时，会话状态只是「已完成未读」，composer 只能说「已就绪」
// （2026-09-07 评审实测复现）。
//
// 修 attention 管线要动 Codex 的回合完成路径，那在本车道的文件边界之外；
// 这里在 composer 自己这一层，对**当前终端画面**跑同一个现成检测器
// （terminal-activity-monitor 的 isWaitingForUser，认 y/N 确认、编号选择题、
// 问号结尾三种），只影响 composer 显示，不改会话的全局 attention 状态。
// 侧栏因此仍不会为 Codex 的提问亮灯 —— 那是另一张卡的事。
function detectComposerLiveQuestion(session, runtime) {
  if (isNativeAgent(session)) return null;
  if (!session || !runtime) return null;
  // 已经被权威信号标成「等你输入」的，用不着再猜。
  if (sessionNeedsUserInput(session)) return null;
  // 只在「这一轮已经结束」的状态下探测：跑着的时候屏幕上的问号多半是它自己在思考。
  if (![RUNTIME_COMPLETED, RUNTIME_IDLE, RUNTIME_UNKNOWN].includes(runtime.state)) return null;
  if (!isAiRuntimeSession(session)) return null;
  try {
    const tail = tailAboveCliPrompt(extractTailLines(session.id, 40));
    if (!tail.length) return null;
    const verdict = isWaitingForUser(tail);
    if (!verdict || !verdict.waiting) return null;
    // An idle, unused CLI can display a suggested question in its welcome
    // screen. Keep real startup confirmations/choices, but don't call that
    // suggestion an assistant reply awaiting an answer.
    if (verdict.reason === 'question'
        && require('../core/session-history-state').isFreshSession(session)) return null;
    return {
      waiting: true,
      reason: verdict.reason || null,
      // Codex 用 • 起句，它不在检测器的 AI 标记集合里，会跟着进摘要。
      text: String(verdict.text || '').replace(/^[•·‣▪◦]+\s*/, ''),
      // 只有检测器自己判定是「选择题」时才去解析编号选项；问号结尾那种情况下
      // 屏幕尾巴上的数字多半是正文，解析出来会变成点了会答错的按钮。
      screen: verdict.reason === 'choice' ? tail.slice(-12).join('\n') : '',
    };
  } catch (error) {
    console.warn('[composer] live question probe failed:', error && error.message);
    return null;
  }
}

// 「查看上一轮 ↑」：卡片视图滚到最后一张卡，PTY 视图回到终端底部。
function scrollToLatestTurn(terminal) {
  const overlay = document.getElementById('msg-overlay');
  if (currentView === 'card' && overlay && !overlay.classList.contains('hidden')) {
    const cards = overlay.querySelectorAll(':scope > .turn-card');
    const last = cards[cards.length - 1];
    if (last) {
      cardFollowScroll.pause();
      const reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      last.scrollIntoView({ block: 'start', behavior: reduced ? 'auto' : 'smooth' });
      return true;
    }
  }
  if (terminal && typeof terminal.scrollToBottom === 'function') {
    if (navigateCodexTranscript(sessions.get(activeSessionId), terminal, 'bottom')) return true;
    terminal.scrollToBottom();
    return true;
  }
  return false;
}

// 「重连」：复用右键菜单那条恢复动作，休眠走唤醒、其余走 restart-session。
// 这里不新造第三条恢复路径 —— 多一条就多一处会和主进程对不上的状态机。
async function reconnectSession(sessionId) {
  const session = sessions.get(sessionId);
  if (!session) return;
  // 绝不弹 alert：模态弹窗会把渲染进程整个冻住，连后续的重试都点不了。
  // 失败信息直接写回状态行，用户就地能看到、也能再点一次。
  const failed = (message) => {
    const base = (session._processLost && session._processLost.reason) || 'CLI 进程已退出';
    session._processLost = { reason: `${base}；重连失败：${message}`, at: Date.now() };
    if (typeof updateFloatingBarState === 'function') updateFloatingBarState();
    scheduleSessionListRender();
  };
  try {
    if (session.status === 'dormant') {
      const resumed = await resumeDormantSession(sessionId, { forceScrollBottom: true });
      if (!resumed) { failed('会话唤醒没有返回结果'); return; }
      // 唤醒成功：把“进程丢了”这笔销掉，否则它会随着会话对象一直带着，
      // 下一次真休眠时输入框会拿一条陈年的退出码当原因念出来。
      const revived = sessions.get(sessionId);
      if (revived) delete revived._processLost;
      if (typeof updateFloatingBarState === 'function') updateFloatingBarState();
      return;
    }
    const result = await ipcRenderer.invoke('restart-session', sessionId);
    if (result && result.ok === false) failed(result.message || '会话重启失败');
  } catch (error) {
    failed(error && error.message ? error.message : String(error));
  }
}

// 「引用会话」：选会话或群聊 → 主进程返回它的聊天记录 md（落后于原始记录才先刷新）→ 在输入框末尾追加一行引用。
// 失败走 showHubAlert 挡住人，不能静默；成功只给轻提示，且绝不替用户按发送。
async function referenceSessionIntoInput(sessionId, inputBox, button, options = {}) {
  const isCurrent = options.isCurrent || (() => inputBox.isConnected);
  const saveDraft = options.saveDraft || (() => saveFloatingInputDraft(sessionId, inputBox));
  const { openSessionPicker, showForkToast } = require('./groupchat-fork-ui.js');
  const { buildReferenceText } = require('../core/session-reference.js');
  const alertError = message => require('./ui-feedback').showHubAlert(message, { document });
  let rows;
  try {
    rows = await ipcRenderer.invoke('session-reference:list', {
      excludeSessionId: sessionId,
      excludeMeetingId: options.excludeMeetingId || '',
    });
  } catch (error) {
    alertError('读取会话清单失败：' + error.message);
    return;
  }
  if (!isCurrent()) return;
  openSessionPicker({
    document,
    rows: Array.isArray(rows) ? rows : [],
    title: '引用会话 / 群聊',
    hint: '把所选会话或群聊的聊天记录路径插入输入框，接收消息的 AI 会自己去读；可跨 Claude / Codex，不会自动发送。',
    emptyLabel: '没有其他会话或群聊可引用。',
    onPick: async (row) => {
      if (!isCurrent()) return;
      if (button) { button.disabled = true; button.textContent = '引用中…'; }
      try {
        const result = await ipcRenderer.invoke('session-reference:resolve', row.kind === 'meeting'
          ? { meetingId: row.meetingId }
          : { sessionId: row.id });
        if (!result?.ok) { alertError('引用失败：' + (result?.message || result?.error || '未知原因')); return; }
        if (!inputBox.isConnected || !isCurrent()) return;
        const line = buildReferenceText({ title: row.title || result.title, kind: row.kind, path: result.path });
        appendToContenteditable(inputBox, `${line}\n`);
        saveDraft();
        inputBox.dispatchEvent(new Event('input', { bubbles: true }));
        inputBox.focus();
        showForkToast(document, result.fresh
          ? `已引用「${row.title || result.title || (row.kind === 'meeting' ? '未命名群聊' : '未命名会话')}」，补充你的要求后发送`
          : '已引用；源会话最新的内容可能还没写进记录（例如正在回答中）');
      } catch (error) {
        alertError('引用失败：' + error.message);
      } finally {
        if (button) { button.disabled = false; button.textContent = '引用会话'; }
      }
    },
  });
}

// Single interrupt path for native Claude seats: the ■ button, the terminal's
// Ctrl+C and the group-member stop all have to mean the same thing. Only the
// engine's terminal_reason confirms an interrupt, so a rejected *request* is
// the only thing worth reporting here.
async function interruptNativeClaudeSession(sessionId) {
  try {
    const result = await ipcRenderer.invoke('claude-native:interrupt', { sessionId });
    if (!result?.ok) throw new Error(result?.error || result?.message || '停止请求未确认');
    return true;
  } catch (error) {
    showToast('停止失败：' + error.message, 'error');
    return false;
  }
}

// Electron 41 起 File.path 被删，拖拽也要走 webUtils.getPathForFile。
function droppedFilePath(file) {
  if (!file) return '';
  if (webUtils && typeof webUtils.getPathForFile === 'function') {
    try {
      const resolved = webUtils.getPathForFile(file) || '';
      if (resolved) return resolved;
    } catch { /* 落回 file.path */ }
  }
  return String(file.path || '');
}

// 停止键的可见性判据与改版前一字不差：PTY 字节活动是个有用的状态兜底，
// 但不足以给一个 AI 会话亮出破坏性的 Ctrl+C，必须有权威/强/语义证据。
function composerStopAllowed(session, runtimeTruth) {
  if (!session) return false;
  const truth = runtimeTruth || getSessionRuntimeTruth(session);
  const confidence = truth && truth.confidence;
  return !isAiRuntimeSession(session)
    || [CONFIDENCE_AUTHORITATIVE, CONFIDENCE_STRONG, CONFIDENCE_SEMANTIC].includes(confidence);
}

// 思考档的可选项按**模型**取，不写死一份：codex 的 models_cache.json 里
// gpt-5.6-sol 到 ultra、gpt-5.5 只到 xhigh。目录几乎不变，按 slug 记一份就够。
const _codexEffortCache = new Map();
// Levels the engine itself accepts for /effort, measured on Claude Code 2.1.269.
const CLAUDE_COMPOSER_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max', 'ultracode', 'auto'];

function composerSupportedEfforts(session) {
  if (session?.runtimeBackend === 'acp') return require('../core/acp-model-catalog').acpThoughtChoices(session).map(o => o.value);
  const kind = String((session && session.kind) || '').replace(/-resume$/i, '').toLowerCase();
  // A native Claude session changes effort over its own command channel, so the
  // chip is live there; a PTY session still cannot and stays static.
  if (session?.runtimeBackend === 'claude-stream-json') return CLAUDE_COMPOSER_EFFORTS;
  if (kind !== 'codex') return null;
  const slug = String((session.currentModel && session.currentModel.id) || '').trim();
  if (!slug) return null;
  const webRoute = require('../core/chatgpt-web-models').chatgptWebRoute(slug);
  if (webRoute) return [webRoute.effort];
  if (_codexEffortCache.has(slug)) return _codexEffortCache.get(slug);
  let efforts = null;
  try { efforts = describeCodexModelTuning(slug).efforts || null; }
  catch (error) { console.warn('[composer] codex effort catalog unavailable:', error && error.message); }
  _codexEffortCache.set(slug, efforts);
  return efforts;
}

function mountFloatingInput(sessionId, termContainer, terminal, pane = {}) {
  const bar = document.createElement('div');
  bar.className = 'floating-input-bar';
  const commandFeedback = require('./codex-command-feedback').createCodexCommandFeedback(document, bar);
  let commandFeedbackSequence = 0;
  bar.dataset.sessionId = sessionId;
  const codexControls = createCodexNativeControls({
    sessionId, invoke: (channel, payload) => ipcRenderer.invoke(channel, payload),
    openExternal: url => shell.openExternal(url),
  });
  bar.append(codexControls.element);
  if (isNativeAgent(sessions.get(sessionId))) terminal.options.disableStdin = true;

  // ↑/↓ 召回发过的消息。模块缺席（脚本没加载）时整块功能静默关闭，
  // 输入框其余行为一字不变 —— 历史是增强，不该成为新的单点故障。
  const historyApi = (typeof window !== 'undefined' && window.FloatingInputHistory) || null;
  const inputHistory = historyApi
    ? historyApi.createFloatingInputHistory({ storage: window.localStorage })
    : null;
  const historyCursor = inputHistory
    ? inputHistory.createCursor(sessionId)
    : { isBrowsing: () => false, older: () => null, newer: () => null, reset() {}, invalidate() {} };
  let applyingHistory = false;
  function applyHistoryText(text) {
    applyingHistory = true;
    try {
      replaceContenteditableText(inputBox, text);
      placeCaretAtContenteditableEnd(inputBox);
      saveFloatingInputDraft(sessionId, inputBox);
    } finally {
      applyingHistory = false;
    }
  }

  const inputBox = document.createElement('div');
  inputBox.className = 'floating-input-box';
  inputBox.contentEditable = 'true';
  inputBox.setAttribute('data-placeholder', '输入消息…');
  if ((isNativeSession(sessions.get(sessionId)) || isPtyAgentSession(sessions.get(sessionId))) && !floatingInputDrafts.has(sessionId)) {
    try { const saved=localStorage.getItem('codex-native-draft:'+sessionId);if(saved)floatingInputDrafts.set(sessionId,saved); }
    catch(error){console.warn('[codex-draft] read failed:',error.message);}
  }
  if (!floatingInputDrafts.has(sessionId) && (sessions.get(sessionId)?.runtimeBackend === 'claude-stream-json' || isPtyAgentSession(sessions.get(sessionId)))) {
    try {
      const saved = localStorage.getItem('hub.claude-native.draft.v1:' + sessionId);
      if (saved) floatingInputDrafts.set(sessionId, saved);
    } catch (error) { showToast('草稿读取失败：' + error.message, 'error'); }
  }
  if (floatingInputDrafts.has(sessionId)) {
    restoreComposerText(sessionId, inputBox, floatingInputDrafts.get(sessionId));
  }

  const bridgeToolbar = document.createElement('div');
  bridgeToolbar.className = 'fi-bridge-toolbar';
  bridgeToolbar.setAttribute('aria-label', '会话工具');
  const toolbarSession = sessions.get(sessionId);
  if (toolbarSession && supportsForkSession(toolbarSession)) {
    const branchBtn = document.createElement('button');
    branchBtn.type = 'button';
    branchBtn.className = 'fi-bridge-fork';
    branchBtn.textContent = '分支';
    branchBtn.title = '创建继承当前上下文的独立会话 (Ctrl+Shift+B)';
    branchBtn.setAttribute('aria-label', '创建当前会话分支');
    branchBtn.addEventListener('click', (event) => {
      event.stopPropagation();
      void keyboardShortcuts.forkSession(sessionId);
    });
    bridgeToolbar.appendChild(branchBtn);
  }
  // 引用会话：跨 CLI（Claude ↔ Codex）拿另一个会话的上下文。只往输入框写一行
  // 聊天记录 md 的路径，由目标 agent 自己去读；不自动发送。见 core/session-reference.js。
  const referenceBtn = document.createElement('button');
  referenceBtn.type = 'button';
  referenceBtn.className = 'fi-bridge-reference';
  referenceBtn.textContent = '引用会话';
  referenceBtn.title = '选一个会话或群聊，把它的聊天记录路径插入输入框，让当前 AI 读取其上下文（可跨 Claude / Codex）';
  referenceBtn.setAttribute('aria-label', '引用其他会话或群聊的上下文');
  referenceBtn.addEventListener('click', (event) => {
    event.stopPropagation();
    void referenceSessionIntoInput(sessionId, inputBox, referenceBtn);
  });
  bridgeToolbar.appendChild(referenceBtn);

  // ── T1 冷杉 v2 · composer 状态行 ─────────────────────────────────────────
  // 舞台头部的状态徽章和这一行说的是同一件事，所以两者共用
  // buildComposerStatusModel 的同一个结论（见 session-runtime-status.js）。
  // 复制一份判据 = 两个地方迟早说出互相矛盾的话。
  const statusRow = document.createElement('div');
  statusRow.className = 'composer-status';
  const statusDot = document.createElement('span');
  statusDot.className = 'composer-status-dot';
  statusDot.setAttribute('aria-hidden', 'true');
  const statusText = document.createElement('span');
  statusText.className = 'composer-status-text';
  const statusDetail = document.createElement('span');
  statusDetail.className = 'composer-status-detail';
  statusDetail.hidden = true;
  const statusAction = document.createElement('button');
  statusAction.type = 'button';
  statusAction.className = 'composer-status-action';
  statusAction.hidden = true;
  statusAction.addEventListener('click', (event) => {
    event.stopPropagation();
    const kind = statusAction.dataset.actionKind || '';
    if (kind === 'scroll-latest') { if (pane.history) pane.history(); else scrollToLatestTurn(terminal); return; }
    if (kind === 'reconnect') { void reconnectSession(sessionId); return; }
    if (kind === 'quota-resume-now') {
      statusAction.disabled = true;
      void ipcRenderer.invoke('claude-native:quota-resume-now', { sessionId })
        .then(result => { if (!result?.ok) showToast('继续失败：' + (result?.message || result?.error || '未确认'), 'error'); })
        .catch(error => showToast('继续失败：' + error.message, 'error'))
        .finally(() => { statusAction.disabled = false; });
      return;
    }
    // 「核对上次任务」：只读原生历史，登记「不重发」。旧任务不会被重发，
    // 也不会被说成成功；失败就弹出来，不允许静默。
    if (kind === 'claude-reconcile') {
      statusAction.disabled = true;
      void ipcRenderer.invoke('claude-native:reconcile-history', { sessionId })
        .then(result => { if (!result?.ok) showToast('核对失败：' + (result?.message || result?.error || '未确认'), 'error'); })
        .catch(error => showToast('核对失败：' + error.message, 'error'))
        .finally(() => { statusAction.disabled = false; });
    }
  });
  statusRow.append(statusDot, statusText, statusDetail, statusAction);

  // 快捷答复只把文本填进输入框并聚焦，**绝不自动发送** —— 替用户按下发送
  // 是这个界面最不该做的事：解析错一次就等于替他答错一次。
  const quickReplyRow = document.createElement('div');
  quickReplyRow.className = 'composer-quick-replies';
  quickReplyRow.hidden = true;
  quickReplyRow.addEventListener('click', (event) => {
    const chip = event.target && event.target.closest && event.target.closest('.composer-quick-reply');
    if (!chip) return;
    event.stopPropagation();
    replaceContenteditableText(inputBox, chip.dataset.reply || '');
    placeCaretAtContenteditableEnd(inputBox);
    saveFloatingInputDraft(sessionId, inputBox);
    inputBox.dispatchEvent(new Event('input', { bubbles: true }));
    inputBox.focus();
  });

  // 附件：仓库现有的文件对话框只会选目录（workspace:pick），没有「选文件插入路径」
  // 这条能力，而本卡不许动 main.js。所以按钮先不显示，只保留 composer 的拖拽落区 ——
  // 拖进来的文件沿用粘贴文件那条 formatPastedFilePaths，行为与粘贴完全一致。
  const attachBtn = document.createElement('button');
  attachBtn.type = 'button';
  attachBtn.className = 'composer-chip composer-chip-icon composer-attach';
  attachBtn.title = '添加附件';
  attachBtn.setAttribute('aria-label', '添加附件');
  attachBtn.innerHTML = '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 11.5 12.5 20a5 5 0 0 1-7-7l8.5-8.5a3.5 3.5 0 0 1 5 5L10.5 18"/></svg>';
  attachBtn.hidden = true;

  // 模型 chip：不重造选择器，直接把现有的挂载函数接到它上面。
  // 头部徽章本卡先保留（T2 才删），两处指向同一个 controller。
  const modelChip = document.createElement('button');
  modelChip.type = 'button';
  modelChip.className = 'composer-chip composer-model';
  modelChip.hidden = true;
  const modelChipLogo = document.createElement('span');
  modelChipLogo.className = 'composer-model-logo';
  modelChipLogo.setAttribute('aria-hidden', 'true');
  const modelChipLabel = document.createElement('span');
  modelChipLabel.className = 'composer-chip-label';
  const modelChipCaret = document.createElement('span');
  modelChipCaret.className = 'composer-chip-caret';
  modelChipCaret.setAttribute('aria-hidden', 'true');
  modelChipCaret.textContent = '▾';
  modelChip.append(modelChipLogo, modelChipLabel, modelChipCaret);
  attachModelPickerHandler(modelChip, sessionId);

  // 思考档 chip：只对**实测**支持的 CLI 渲染，判据在 composerThinkingChip。
  // Codex 的档位和模型在同一个原生面板里选，所以点它复用同一个选择器；
  // 原生 Claude 走 claude-native:set-effort；PTY Claude 没有会话内改档的通路，
  // 只显示不可点，不新造写 PTY 的路径。
  const thinkingChip = document.createElement('button');
  thinkingChip.type = 'button';
  thinkingChip.className = 'composer-chip composer-thinking';
  thinkingChip.hidden = true;
  const thinkingChipLabel = document.createElement('span');
  thinkingChipLabel.className = 'composer-chip-label';
  const thinkingChipCaret = document.createElement('span');
  thinkingChipCaret.className = 'composer-chip-caret';
  thinkingChipCaret.setAttribute('aria-hidden', 'true');
  thinkingChipCaret.textContent = '▾';
  thinkingChip.innerHTML = '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M13 2 4 14h7l-1 8 9-12h-7z"/></svg>';
  thinkingChip.append(thinkingChipLabel, thinkingChipCaret);
  thinkingChip.addEventListener('click', (event) => {
    event.stopPropagation();
    if (require('../core/chatgpt-web-models').isChatgptWebModel(sessions.get(sessionId)?.currentModel?.id)) {
      void modelUi.showModelPicker(thinkingChip, sessionId);
      return;
    }
    if (thinkingChip.dataset.interactive !== '1') return;
    const efforts = composerSupportedEfforts(sessions.get(sessionId));
    if (!efforts || !efforts.length) return;
    modelUi.showEffortPicker(thinkingChip, sessionId, { efforts });
  });

  // 2026-07-19 maintainer · 方案C：ctx chip（发送前看到成本）+ 运行中红色中断钮（发 \x03=SIGINT）
  const speedChip = document.createElement('button');
  speedChip.type = 'button';
  speedChip.className = 'composer-chip composer-speed';
  speedChip.addEventListener('click',event=>{
    event.stopPropagation(); void modelUi.showSpeedPicker(speedChip,sessionId);
  });
  // Shared remaining percentage + usage ring, using the existing contextPct source.
  const contextBudget = require('./composer-context').createComposerContext(document);

  const sendHint = document.createElement('span');
  sendHint.className = 'composer-hint';
  sendHint.textContent = 'Enter 发送';
  sendHint.title = 'Enter 或 Ctrl+Enter 发送 · Shift+Enter 换行';
  sendHint.hidden = true;

  const stopBtn = document.createElement('button');
  stopBtn.className = 'floating-input-stop';
  stopBtn.title = '中断当前 AI';
  stopBtn.setAttribute('aria-label', '中断当前 AI');
  stopBtn.innerHTML = '<svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>';
  stopBtn.addEventListener('click', async (e) => {
    e.stopPropagation();
    // While a quota wait is armed nothing is running, so the stop button means
    // "don't continue on your own" (see buildComposerStatusModel's stopIntent).
    if (stopBtn.dataset.intent === 'quota-cancel') {
      const result = await ipcRenderer.invoke('claude-native:quota-cancel', { sessionId }).catch(error => ({ ok: false, message: error.message }));
      if (!result?.ok && result?.error !== 'no-wait') showToast('取消自动继续失败：' + (result?.message || '未确认'), 'error');
      inputBox.focus();
      return;
    }
    if (sessions.get(sessionId)?.runtimeBackend === 'claude-stream-json') {
      await interruptNativeClaudeSession(sessionId);
      inputBox.focus();
      return;
    }
    const stopTarget = sessions.get(sessionId);
    if (stopTarget?.agentRuntime === 'pty' && (isClaudeFamily(stopTarget.kind) || isCodexKind(stopTarget.kind) || require('../core/acp-profiles').isAcpKind(stopTarget.kind))) {
      // Ctrl+C 连点会让 CLI 退出；PTY Claude / Codex 用 Esc，只在运行时发一次（见 pty-interrupt.js）。
      require('./pty-interrupt').sendPtyAgentInterrupt(stopTarget, { state: getSessionRuntimeTruth(stopTarget).state,
        send: data => ipcRenderer.send('terminal-input', { sessionId, data }) });
      terminal.focus();
      return;
    }
    ipcRenderer.send('terminal-input', { sessionId, data: '\x03' });
    terminal.focus();
  });

  const sendBtn = document.createElement('button');
  sendBtn.className = 'floating-input-send';
  sendBtn.title = '发送 (Enter) · Shift+Enter 换行';
  sendBtn.setAttribute('aria-label', '发送');
  sendBtn.innerHTML = '<svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor" aria-hidden="true"><path d="M12 4l7 7h-4v9h-6v-9H5z"/></svg>';

  const railSpacer = document.createElement('span');
  railSpacer.className = 'composer-rail-spacer';
  const composerRail = document.createElement('div');
  composerRail.className = 'composer-rail';
  composerRail.append(
    attachBtn, modelChip, thinkingChip, speedChip,
    railSpacer, contextBudget.element, sendHint, stopBtn, sendBtn,
  );

  const composerRow = document.createElement('div');
  composerRow.className = 'fi-composer-row';
  composerRow.append(inputBox);

  const composer = document.createElement('div');
  composer.className = 'composer';
  composer.dataset.state = 'ready';
  const startActions = document.createElement('div');
  startActions.className = 'composer-start-actions';
  // Group members use the group's own dispatch controls, even in session view.
  startActions.hidden = !!sessions.get(sessionId)?.meetingId
    || Object.values(meetings).some(m => m?.subSessions?.includes(sessionId));
  const startButton = document.createElement('button');
  startButton.type = 'button';
  startButton.className = 'composer-one-click-start';
  startButton.textContent = '一键开工';
  startButton.title = '追加自主实现、验证与合并的提示词；可编辑，发送后授权执行';
  startButton.addEventListener('click', () => {
    const suffix = require('./one-click-start').suffix(readContenteditablePlainText(inputBox));
    inputBox.focus();
    placeCaretAtContenteditableEnd(inputBox);
    if (suffix) {
      // Append at the end instead of replacing the draft, preserving attachments
      // and the browser undo history. The existing send path remains unchanged.
      const html = escapeHtml(suffix).replace(/\n/g, '<br>');
      if (!document.execCommand('insertHTML', false, html)) inputBox.appendChild(document.createTextNode(suffix));
      saveFloatingInputDraft(sessionId, inputBox);
      inputBox.dispatchEvent(new Event('input', { bubbles: true }));
      placeCaretAtContenteditableEnd(inputBox);
    }
  });
  startActions.appendChild(startButton);
  const secondaryActions = document.createElement('div');
  secondaryActions.className = 'composer-secondary-actions';
  secondaryActions.append(bridgeToolbar, startActions);
  const tuningControls = document.createElement('div');
  tuningControls.className = 'composer-tuning-controls';
  tuningControls.append(attachBtn, secondaryActions, modelChip, thinkingChip, speedChip);
  composerRail.prepend(tuningControls);
  if (termContainer.closest('.terminal-panel') === terminalPanelEl) {
    composer.classList.add('has-backend-update-notice');
  }
  composer.append(statusRow, quickReplyRow, composerRow, composerRail);
  const composerTools = require('./composer-tools-menu').mountComposerToolsMenu({composer, tuningControls, bridgeToolbar});
  const voiceInput = require('./voice-input').attachVoiceInput({
    input: inputBox, rail: composerRail, getStatusHost: () => statusRow,
    getTarget: () => ({ id: sessionId, project: sessions.get(sessionId)?.cwd || '' }),
    isActive: () => (sessionSplit?.focusedId() || activeSessionId) === sessionId,
  });
  const promptPolish = require('./prompt-polish').attachPromptPolish({
    input: inputBox, rail: composerRail, before: sendBtn, ipcRenderer,
    getTarget: () => ({ id: sessionId }),
    isActive: () => (sessionSplit?.focusedId() || activeSessionId) === sessionId && inputBox.getClientRects().length > 0,
    writeText: text => {
      restoreComposerText(sessionId, inputBox, text);
      saveFloatingInputDraft(sessionId, inputBox);
      placeCaretAtContenteditableEnd(inputBox);
    },
  });

  // 拖拽落区：拖进来的文件按绝对路径写进文本框。走的是粘贴文件那条
  // formatPastedFilePaths（多文件换行分隔 —— 路径里可以有空格，空格分隔会被 CLI 拆断）。
  const dragCarriesFiles = (event) => {
    const types = event && event.dataTransfer && event.dataTransfer.types;
    return !!types && Array.from(types).includes('Files');
  };
  composer.addEventListener('dragover', (event) => {
    if (!dragCarriesFiles(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
    composer.classList.add('drop-active');
  });
  composer.addEventListener('dragleave', (event) => {
    if (event.target === composer) composer.classList.remove('drop-active');
  });
  composer.addEventListener('drop', (event) => {
    composer.classList.remove('drop-active');
    if (!dragCarriesFiles(event)) return;
    event.preventDefault();
    const paths = Array.from(event.dataTransfer.files || [])
      .map(file => droppedFilePath(file))
      .filter(Boolean);
    if (!paths.length) return;
    const current = readContenteditablePlainText(inputBox);
    const separator = current.trim() ? (current.endsWith('\n') ? '' : '\n') : '';
    replaceContenteditableText(inputBox, `${current}${separator}${formatPastedFilePaths(paths)}`);
    placeCaretAtContenteditableEnd(inputBox);
    saveFloatingInputDraft(sessionId, inputBox);
    inputBox.dispatchEvent(new Event('input', { bubbles: true }));
    inputBox.focus();
  });

  const contentStack = document.createElement('div');
  contentStack.className = 'fi-content-stack';
  const nativeControls = require('./claude-native-controls').createClaudeNativeControls({ sessionId, ipcRenderer,
    onHistory: () => pane.history ? pane.history() : loadSessionHistoryToOverlay(sessionId, { forceScrollBottom: true }),
    onRestoreDraft: record => {
      if ((record.content || []).some(block => block.type !== 'text')) throw new Error('本条含附件，请从历史核对附件后重新添加');
      if (readContenteditablePlainText(inputBox)) throw new Error('输入框已有草稿，请先保存或发送');
      replaceContenteditableText(inputBox, record.text);
      saveFloatingInputDraft(sessionId, inputBox); inputBox.focus();
    },
  });
  // PTY 会话等人操作时的提示条：只指路，不代答。
  const ptyAttention = require('./pty-attention-controls').createPtyAttentionControls({
    onOpenTerminal: () => {
      if (pane.openTerminal) pane.openTerminal();
      else if (activeSessionId === sessionId) applyViewMode('pty');
    },
  });
  contentStack.append(nativeControls.element, ptyAttention.element, composer);
  bar.append(contentStack);
  bar.classList.add('visible');
  require('./composer-collapse').mountComposerCollapse({ document, host: bar, before: sendBtn, input: inputBox,
    onResize: () => { refitActiveTerminalFromPreview(); sessionSplit?.secondary()?.resize(); } });

  // composer 上所有随会话状态变化的东西都在这里画完一遍：状态行、快捷答复、
  // 底栏三个 chip、预算环、发送/停止。updateFloatingBarState 与每秒一次的
  // ticker 都调它，所以「工作中 · 38s」这类计时文案不需要各自再算一遍。
  let composerClockSignature=null;
  function paintComposer(session, now = Date.now(), clockOnly = false) {
    if (!session) return;

    const runtime = deriveSessionRuntimeStatus(session, {
      now,
      isRunning: isSessionCardWorking(session),
    });
    const status = buildComposerStatusModel(session, {
      now,
      runtime,
      liveQuestion: detectComposerLiveQuestion(session, runtime),
    });
    if (composer.dataset.state !== status.state) composer.dataset.state = status.state;
    if (statusText.textContent !== status.text) statusText.textContent = status.text;
    const localHealth = ['codex-app-server','claude-stream-json'].includes(session.runtimeBackend)
      && ['starting','running'].includes(session.nativeRuntime?.state)
      ? require('./hub-feedback-health').healthText(now) : '';
    // hook 部署失败时状态只能靠落盘记录和屏幕，必须让用户看见，而不是静默降级。
    const hookWarning = session.hookIntegrationWarning ? '状态信号降级（hook 未部署）：' + session.hookIntegrationWarning : '';
    const detailText = [localHealth, status.detail, hookWarning].filter(Boolean).join(' · ');
    const detail = detailText ? `· ${detailText}` : '';
    if (statusDetail.textContent !== detail) statusDetail.textContent = detail;
    statusDetail.hidden = !detail;
    if (status.action) {
      statusAction.hidden = false;
      if (statusAction.textContent !== status.action.label) statusAction.textContent = status.action.label;
      statusAction.dataset.actionKind = status.action.kind;
    } else {
      statusAction.hidden = true;
      statusAction.dataset.actionKind = '';
    }
    if (statusRow.title !== status.runtime.title) statusRow.title = status.runtime.title;
    ptyAttention.update(session, runtime);

    // Keep the exact second-level status/question/connection checks. A clock
    // tick does not need to repaint model/effort/speed/draft controls. Any
    // structural status change falls through to the complete existing paint.
    const signature=JSON.stringify([status.state,status.canStop,status.stopIntent,status.action,status.quickReplies,
      runtime.state,runtime.source,runtime.confidence,runtime.connection,runtime.turnId,runtime.epoch,
      session.nativeRuntime?.cancellation?.status]);
    if(clockOnly&&signature===composerClockSignature)return;
    composerClockSignature=signature;
    paintNativePromptReceipts(sessionId);
    attachNativeDraft(sessionId, inputBox);
    codexControls.update(session);
    nativeControls.update(session);

    const replySignature = status.quickReplies.join('');
    if (quickReplyRow.dataset.signature !== replySignature) {
      quickReplyRow.dataset.signature = replySignature;
      quickReplyRow.replaceChildren();
      for (const reply of status.quickReplies) {
        const chip = document.createElement('button');
        chip.type = 'button';
        chip.className = 'composer-quick-reply';
        chip.dataset.reply = reply;
        chip.textContent = reply;
        quickReplyRow.appendChild(chip);
      }
    }
    quickReplyRow.hidden = status.quickReplies.length === 0;

    // 停止键沿用既有的中断按钮，判据也沿用既有那条：PTY 字节活动不足以
    // 给一个 AI 会话亮出破坏性的 Ctrl+C，必须有权威/强/语义证据。
    // A quota wait is not a running turn, so composerStopAllowed (which demands
    // authoritative evidence of work in flight) must not gate cancelling it.
    const quotaCancel = status.stopIntent === 'quota-cancel' && status.canStop;
    const canStop = quotaCancel || (status.canStop && composerStopAllowed(session, status.runtime));
    stopBtn.classList.toggle('visible', canStop);
    stopBtn.dataset.intent = quotaCancel ? 'quota-cancel' : 'interrupt';
    stopBtn.title = quotaCancel ? '取消额度恢复后自动继续' : '中断当前 AI';
    stopBtn.setAttribute('aria-label', stopBtn.title);
    stopBtn.disabled = !quotaCancel && session.nativeRuntime?.cancellation?.status === 'pending';
    sendBtn.hidden = false;
    sendBtn.title = canStop && session.runtimeBackend === 'acp'
      ? '加入待发送队列 · 当前轮结束后发送'
      : canStop ? '补充消息 (Enter) · 工作中也可发送' : '发送 (Enter) · Shift+Enter 换行';
    sendBtn.setAttribute('aria-label', canStop ? '补充消息' : '发送');

    const rail = buildComposerRailModel(session, {
      supportedEfforts: composerSupportedEfforts(session),
    });
    const webRoute = require('../core/chatgpt-web-models').chatgptWebRoute(session?.currentModel?.id);
    modelChip.hidden = !rail.model.visible;
    if (rail.model.visible) {
      const label = rail.model.pending
        ? `${rail.model.label} → ${rail.model.pending}`
        : webRoute ? webRoute.label.replace('ChatGPT ·', 'ChatGPT Web ·') : rail.model.label;
      if (modelChipLabel.textContent !== label) modelChipLabel.textContent = label;
      modelChip.classList.toggle('switching', !!rail.model.pending);
      modelChip.title = webRoute
        ? '通过 ChatGPT 网页回答，本地 Codex 执行工具。点击调整网页档位或打开专用设置。'
        : `${rail.model.id || rail.model.label} — 点击切换模型`;
      modelChip.disabled = false;
      const logoClass = `composer-model-logo ${modelClass(rail.model.id)}`.trim();
      if (modelChipLogo.className !== logoClass) modelChipLogo.className = logoClass;
      const initial = (rail.model.label || '?').trim().charAt(0).toUpperCase();
      if (modelChipLogo.textContent !== initial) modelChipLogo.textContent = initial;
    }

    thinkingChip.hidden = !rail.thinking.visible;
    if (rail.thinking.visible) {
      if (thinkingChipLabel.textContent !== '推理 · ' + require('./ui-labels').effortLabel(rail.thinking.label)) {
        thinkingChipLabel.textContent = '推理 · ' + require('./ui-labels').effortLabel(rail.thinking.label);
      }
      thinkingChip.dataset.interactive = rail.thinking.interactive || webRoute ? '1' : '0';
      thinkingChipCaret.hidden = !(rail.thinking.interactive || webRoute);
      thinkingChip.classList.toggle('is-static', !(rail.thinking.interactive || webRoute));
      thinkingChip.title = webRoute ? '思考强度随网页档位变化；点击选择 Medium、High、Pro 等档位，下一轮生效。' : rail.thinking.interactive
        ? `思考档 ${rail.thinking.label} · 可选 ${rail.thinking.options.join(' / ')}（与模型在同一面板里选）`
        : `思考档 ${rail.thinking.label} · 该 CLI 不支持会话内改档`;
      thinkingChip.disabled = false;
    }

    const speed = speedControl(session,window.WorkspaceController?.codexModelTuning(session?.currentModel?.id));
    speedChip.hidden = !!webRoute || !speed.visible;
    speedChip.textContent = '速度 · ' + speed.label;
    speedChip.setAttribute('aria-label',`速度：${speed.label}`);
    speedChip.setAttribute('aria-pressed',String(speed.tier === 'fast'));
    speedChip.title = speed.reason || '选择标准 / 快速；快速会增加用量或费用';
    if (sessionId === (sessionSplit?.focusedId() || activeSessionId)) turnSpeedDisplay.paint();

    contextBudget.update(rail.context);

    sendBtn.disabled = false;
    sendHint.hidden = canStop || !contenteditableHasText(inputBox);
  }
  bar._paintComposer = paintComposer;
  bar._paintComposerClock = (session,now) => paintComposer(session,now,true);
  paintComposer(sessions.get(sessionId));
  inputBox.addEventListener('input', () => {
    sendHint.hidden = bar.dataset.sharedRole === 'viewer' || stopBtn.classList.contains('visible')
      || !contenteditableHasText(inputBox);
  });

  const panel = termContainer.closest('.terminal-panel');
  if (panel) panel.appendChild(bar);
  else termContainer.appendChild(bar);

  // The external composer is not part of the CLI terminal. Lock its flex
  // footprint at the collapsed height, then let multiline/preset content grow
  // upward as a visual overlay. Otherwise every draft line changes xterm rows,
  // sends ConPTY resize, and makes full-screen CLIs clear/repaint from row 1.
  lockFloatingInputBarGeometry(bar);

  // 卡片层（.msg-overlay）是 absolute + z-index:50 + 不透明底色，靠 top/bottom 给
  // header 和输入栏让位。这两个值以前写死 43px/60px，而输入栏随任务预设 chips、
  // 预设预览、输入框增高能长到 220px —— 超出 60px 的部分就被卡片层盖住且点不到，
  // 用户看到的就是"卡片视图下输入框只剩两行"。这里把实测高度写回 CSS 变量。
  const chromeObserver = observeTerminalPanelChrome(panel, bar);

  // paste-sensitive TUI（claude/gemini/codex 等 9 家 AI CLI）会把紧贴到达的字符
  //   当成 paste 事件 — 紧贴的 \r 被当作 paste 内容吞掉，消息卡在输入框不提交
  //   （2026-05-10 用户反馈：按 Enter 后内容进了 shell 输入框但不发送）。
  //   bracketed paste 的写入、settle 与提交确认现在全在主进程
  //   （main/ipc/prompt-submit-handlers.js → core/group-chat-watcher.sendToPty），
  //   与群聊派发同一条实现；渲染进程只负责清 UI 和展示"没提交"这件事。

  function sendInput() {
    const userText = readContenteditablePlainText(inputBox);
    if (!userText || !userText.trim()) return;
    const acpSession=sessions.get(sessionId);
    if(acpSession?.runtimeBackend==='acp') {
      try {const {imagePaths,validateImages}=require('../core/acp-attachments');
        validateImages(imagePaths(userText),acpSession.currentModel?.id,acpSession.acpCapabilities);
      }catch(error){commandFeedback.show('图片未发送',error.message,true);return;}
    }
    const text = userText;
    // Every native backend answers slash commands on its own command channel.
    const nativeCommand = isNativeAgent(sessions.get(sessionId)) && text.trimStart().startsWith('/');
    const feedbackSequence = ++commandFeedbackSequence;
    commandFeedback.clear();
    if (nativeCommand) commandFeedback.show(text.trim(), '正在执行…');

    // 立即清 UI；原生会话继续在 Hub 输入框接收下一条消息。
    // 清空必须走 replaceContenteditableText（execCommand）：直接赋 textContent 会
    // 清掉原生撤销栈，误发之后 Ctrl+Z 拿不回原文。
    let session, kind, wasRunning;
    const clientSubmissionId = require('node:crypto').randomUUID();
    try {
      if (inputHistory) {
        inputHistory.push(sessionId, userText);
        historyCursor.reset();
      }
      replaceContenteditableText(inputBox, '');
      clearFloatingInputDraft(sessionId);
      terminal.scrollToBottom();
      session = (typeof sessions !== 'undefined' && sessions && typeof sessions.get === 'function')
        ? sessions.get(sessionId) : null;
      if (isNativeAgent(session)) inputBox.focus();
      else terminal.focus();
      kind = session && session.kind ? session.kind : null;
      wasRunning = session && getSessionRuntimeTruth(session).state === RUNTIME_RUNNING;
      // PTY 会话里的斜杠命令（/compact、/model…）是 CLI 本地命令，不一定开新的一轮，
      // 也就没有完成信号来收尾。乐观地标「运行中」会一直挂着（2026-09-25 真机：Codex /compact
      // 卡运行 3 分钟）。真开了一轮时 hook / rollout 会自己把状态推到运行。
      const ptyCommand = !nativeCommand && session?.agentRuntime === 'pty' && text.trimStart().startsWith('/');
      if (!nativeCommand && !ptyCommand) {
        clearSessionWaitingState(sessionId);
        if (!wasRunning) armPtyBurstFallback(sessionId);
      }
      if (!nativeCommand && !ptyCommand && isTranscriptCliKind(kind) && !wasRunning) markCodexCardWorking(sessionId, 'floating_input');
      // PTY Claude 与 Codex 对齐：点下发送就显示「开始」。首条消息要先等 CLI 就绪才粘贴，
      // 这段时间不能看起来毫无反应；STARTING 有 15s TTL，没有 hook 确认会自行过期。
      else if (!nativeCommand && !ptyCommand && !wasRunning && session?.agentRuntime === 'pty' && isClaudeRuntimeSession(session)) {
        const submittedAt = Date.now();
        notePtyTurnBoundary(session);
        observeSessionRuntime(session, { state: RUNTIME_STARTING, source: 'pty-local-submit',
          confidence: CONFIDENCE_SEMANTIC, observedAt: submittedAt, startedAt: submittedAt });
        scheduleSessionListRender();
      }

      // optimistic user-card：卡片视图下立即弹气泡，不等 transcript 写盘 + 250ms throttle reload。
      //   2026-05-10 用户反馈：在卡片视图按 Enter 后约 5 秒才看到自己的气泡卡。根因是 user 气泡
      //   也走 transcript reload 路径，但 Claude CLI 通常等 LLM call 启动才把 user entry append
      //   到 JSONL（实测 1-3s 滞后）。聊天 app 标准做法是发出即 mount，待权威 entry 到时 dedup。
      // 2026-09-07：这里原来逐家列 claude / codex / kimi，把 Gemini 漏在外面 —— Gemini 同样
      //   有卡片视图（isTranscriptCliKind 包含它），发出去却要等 transcript 落盘才冒出气泡。
      //   凡是卡片视图能渲染的 kind 都该立刻出卡，判据统一走这两个 helper。
      const cardCapableKind = !!kind && (isClaudeFamily(kind) || isTranscriptCliKind(kind));
      const acpQueueing = session?.runtimeBackend === 'acp' && ['running','waiting'].includes(session.nativeRuntime?.state);
      const optimisticReceipt = isNativeAgent(session) || (session?.purpose === 'hub-assistant' && !nativeCommand && !ptyCommand)
        ? { clientSubmissionId } : {};
      if ((pane.isCard ? pane.isCard() : currentView === 'card') && cardCapableKind && !acpQueueing && typeof mountOptimisticUserCard === 'function') {
        try {
          if (pane.optimistic) pane.optimistic(text, kind, optimisticReceipt);
          else mountOptimisticUserCard(sessionId, text, kind, optimisticReceipt);
        } catch (err) {
          console.warn('[optimistic user-card] mount failed:', err);
        }
      }

      // 2026-09-03：这里以前是开环的 —— 写完 paste 就按 700/900/1100ms 盲发三次 \r，
      //   发完不管。长 prompt 时 node-pty 的 inSocket 队列还没排空，三个 \r 全被并进
      //   BP_END 那一块当粘贴尾巴吃掉，内容折叠成 [Pasted text +N lines] 躺在输入框里，
      //   没人再按回车、也没有任何提示。现在整条交给主进程闭环：
      //   分块投喂 → 体积自适应 settle → 单发 \r → 等 UserPromptSubmit / task_started
      //   语义确认 → 缺确认才补一次回车 → 仍无确认就亮「补发」按钮。
      clearFloatingInputStuck(bar);
    } catch (error) {
      // History and optimistic UI precede dispatch. A synchronous error here
      // must not leave a cleared composer looking like a completed send.
      console.warn('[floating-input] preparation failed before dispatch:', error);
      if (!readContenteditablePlainText(inputBox)) {
        floatingInputDrafts.set(sessionId, text);
        try { replaceContenteditableText(inputBox, text); saveFloatingInputDraft(sessionId, inputBox); }
        catch (restoreError) { inputBox.textContent = text; console.warn('[floating-input] draft restore failed:', restoreError); }
      }
      showToast('消息未发送：' + (error.message || '界面准备异常') + '。原文保留在输入框，可重试', 'error');
      return;
    }
    const delivery = nativeCommand ? null : beginPromptDelivery(clientSubmissionId);
    if (delivery) floatingPromptDeliveries.set(sessionId, delivery);
    Promise.resolve().then(() => ipcRenderer.invoke('session:send-prompt', { sessionId, text, clientSubmissionId, memoryIndex: true })).then((result) => {
      if (nativeCommand) {
        if (feedbackSequence !== commandFeedbackSequence) return;
        const failed = !result?.ok || result.sendStatus === 'stuck';
        requestCardIncrementalRefresh(sessionId, { reason: 'command-result' });
        commandFeedback.show(text.trim(), failed ? (result?.message || result?.error || '命令未执行，请重试')
          : (result.commandOutput || (['native-command','acp-command'].includes(result.mode) ? '命令已执行。' : '已提交给引擎，执行进度见卡片。')), failed);
        return;
      }
      if (floatingPromptDeliveries.get(sessionId) !== delivery) {
        if (delivery.status !== 'confirmed' && result?.receipt?.status !== 'confirmed' && !result?.ok && !result?.unconfirmed) {
          const excerpt = text.replace(/\s+/g, ' ').slice(0, 32);
          showToast(`较早的消息${result?.notSent ? '未发送' : '发送未完成'}（${excerpt}）：${result?.message || result?.error || '发送失败'}。可按↑找回原文${result?.notSent ? '' : '，请先到后台核对'}`, 'error');
        }
        return;
      }
      if (result?.ok && result.mode === 'native-command') {
        updateFloatingPromptReceipt({sessionId,clientSubmissionId,status:'confirmed'});
        showToast('原生命令已完成', 'success');
        return;
      }
      if (result?.receipt) updateFloatingPromptReceipt(result.receipt);
      if (delivery.status === 'confirmed' || delivery.status === 'content-mismatch') return;
      if (result && result.ok && result.sendStatus !== 'stuck') return;
      if (result?.sendStatus === 'content-mismatch') { notifyPromptContentMismatch(delivery); return; }
      // PTY 会话明确「未发送」（例如 CLI 启动选择框还挂着）：原文放回输入框、说明原因，
      // 不亮「补发」——补发只会把同一段文字塞进同一个选择框。主进程的失败回执可能
      // 比这里先到、已在本会话的各个输入栏亮起提示，这里一并清掉。
      if (!result?.ok && result?.notSent && session?.agentRuntime === 'pty') {
        delivery.dismissed = true;
        updateFloatingPromptReceipt({ sessionId, clientSubmissionId, status: 'failed' });
        if (!readContenteditablePlainText(inputBox)) { replaceContenteditableText(inputBox, text); saveFloatingInputDraft(sessionId, inputBox); }
        showToast('消息未发送：' + (result.message || 'CLI 暂时不能接收输入'), 'error');
        for (const other of document.querySelectorAll('.floating-input-bar')) {
          if (other.dataset.sessionId === sessionId) clearFloatingInputStuck(other);
        }
        return;
      }
      const reason = result && result.ok ? 'no-ack' : (result && result.error) || 'send-failed';
      console.warn(`[floating-input] prompt not acknowledged for ${sessionId.slice(0, 8)}: ${reason}`);
      // 明确「未发送」：先标成已处理，否则下面这条失败回执会在同一会话的所有输入栏
      // （含分屏里的另一栏）点亮「补发」——没发出去的东西不存在补发。
      if (result?.notSent && (isNativeAgent(session) || session?.agentRuntime === 'pty')) delivery.dismissed = true;
      updateFloatingPromptReceipt({ sessionId, clientSubmissionId, status: result?.ok || result?.unconfirmed ? 'unconfirmed' : 'failed' });
      // PTY 会话也可能明确「未发送」（例如 CLI 启动选择框还挂着）：原文放回输入框，
      // 提示原因，不亮「补发」——补发会把同一段文字塞进同一个选择框。
      if ((isNativeAgent(session) || session?.agentRuntime === 'pty') && !result?.ok && !result?.unconfirmed) {
        // A failed new send remains actionable, without a manual-reconciliation
        // panel. Only an explicitly unsent prompt can safely return to draft.
        if (result?.notSent && !readContenteditablePlainText(inputBox)) {
          replaceContenteditableText(inputBox, text); saveFloatingInputDraft(sessionId, inputBox);
        }
        if (result?.notSent) {
          showToast('消息未发送：' + (result.message || '连接暂不可用'), 'error');
          for (const other of document.querySelectorAll('.floating-input-bar')) {
            if (other.dataset.sessionId === sessionId) clearFloatingInputStuck(other);
          }
          return;
        }
      }
      // 明确的失败不能只显示未确认横幅：输入框在发送前已清空，
      // 这里说明原因并把原文放回（可能已部分写进终端，所以提示先核对，不自动重发）。
      if (!result?.ok && !result?.unconfirmed) {
        reportFloatingSendFailure(sessionId, inputBox, text, result?.message || result?.error || '发送失败');
        return;
      }
      markFloatingInputStuck(bar, sessionId);
    }).catch((err) => {
      if (nativeCommand) {
        if (feedbackSequence === commandFeedbackSequence) commandFeedback.show(text.trim(), err.message || '命令提交失败', true);
        return;
      }
      if (floatingPromptDeliveries.get(sessionId) !== delivery) {
        if (delivery.status !== 'confirmed') showToast(`较早的消息提交未确认（${text.replace(/\s+/g, ' ').slice(0, 32)}）：${err.message || '发送通道异常'}。请到后台核对，可按↑找回原文`, 'error');
        return;
      }
      if (delivery.status === 'confirmed' || delivery.status === 'content-mismatch') return;
      console.warn('[floating-input] send-prompt IPC failed:', err && err.message);
      if (isNativeAgent(session)) showToast('发送未完成：' + err.message, 'error');
      else reportFloatingSendFailure(sessionId, inputBox, text, err && err.message || '发送通道异常');
      updateFloatingPromptReceipt({ sessionId, clientSubmissionId, status: 'failed' });
      markFloatingInputStuck(bar, sessionId);
    });
  }

  inputBox.addEventListener('keydown', (e) => {
    // IME composition (中/日/韩) 中, 回车是给候选词用的, 不是给应用层。
    // 不放行就会出现:中文按回车选词被当作"发送"+清空输入框,数字纯 ASCII 不受影响。
    // ↑/↓ 同理：候选词翻页也用方向键，抢过来会让中文输入没法选词。
    if (e.isComposing || e.keyCode === 229) return;
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendInput();
      return;
    }
    if (inputHistory) {
      const hasModifier = e.ctrlKey || e.metaKey || e.altKey || e.shiftKey;
      const ctx = {
        key: e.key,
        hasModifier,
        isBrowsing: historyCursor.isBrowsing(),
        isEmpty: !contenteditableHasText(inputBox),
        caretAtStart: isCaretAtContenteditableStart(inputBox),
      };
      const hit = historyApi.shouldRecallOlder(ctx)
        ? historyCursor.older(readContenteditablePlainText(inputBox))
        : (historyApi.shouldRecallNewer(ctx) ? historyCursor.newer() : null);
      // hit 为 null（已经翻到底）时什么都不做，让 ↑/↓ 保持原生行为，别把草稿吃掉。
      if (hit) {
        e.preventDefault();
        applyHistoryText(hit.text);
        return;
      }
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      // 浏览历史时 Esc 先退出浏览态并还原草稿，第二下才把焦点交回终端。
      if (inputHistory && historyCursor.isBrowsing()) {
        let restored = historyCursor.newer();
        while (restored && !restored.restoredDraft) restored = historyCursor.newer();
        if (restored) applyHistoryText(restored.text);
        historyCursor.reset();
        return;
      }
      if (!isNativeAgent(sessions.get(sessionId))) terminal.focus();
    }
  });

  inputBox.addEventListener('input', () => {
    // 用户自己动手改了内容就退出浏览态：下一次 ↑ 从最新一条重新开始，
    // 而不是接着上次的下标往上翻（那样会跳过刚改出来的这条）。
    // 历史召回本身也是 execCommand，同样会触发 input —— 用 applyingHistory 挡掉，
    // 否则连按两下 ↑ 只会在第一条上原地打转。
    if (inputHistory && !applyingHistory && historyCursor.isBrowsing()) historyCursor.reset();
    saveFloatingInputDraft(sessionId, inputBox);
  });

  // 卡片优化（2026-05-03）：粘贴图片到浮动输入框 → save-clipboard-image
  //   IPC 取得绝对路径 → execCommand('insertText') 插入到 caret 位置。
  //   语义与 xterm 的 handlePasteForSession 一致（用户粘图后路径文字流到 PTY）。
  attachContenteditablePasteImage(inputBox, { collapseLongText: true });
  // 长文本粘贴块：悬停预览原文，复制/剪切时写出原文。
  pasteChips.attachPasteChipBehaviors(inputBox, { document, window });

  sendBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    sendInput();
  });

  bar.addEventListener('wheel', (e) => {
    if (e.ctrlKey || e.metaKey) return;

    const targetInput = e.target && e.target.closest && e.target.closest('.floating-input-box');
    if (targetInput && targetInput.scrollHeight > targetInput.clientHeight) {
      const maxTop = Math.max(0, targetInput.scrollHeight - targetInput.clientHeight);
      const canScrollInput = (e.deltaY < 0 && targetInput.scrollTop > 0)
        || (e.deltaY > 0 && targetInput.scrollTop < maxTop);
      if (canScrollInput) return;
    }

    const cached = terminalCache.get(sessionId);
    const vp = getTerminalViewport(cached);
    if (!vp) return;

    e.preventDefault();
    markCodexUserScrollIntent(sessionId, cached, { detachFromBottom: e.deltaY < 0 });
    // The floating composer is outside the native screen. Codex fullscreen
    // routes wheel input by coordinates; a synthetic event at (0,0) hits its
    // sticky heading and does nothing. Forward over the transcript instead.
    const screen = cached.terminal.element?.querySelector('.xterm-screen') || vp;
    const rect = screen.getBoundingClientRect();
    vp.dispatchEvent(new WheelEvent('wheel', {
      bubbles: true,
      cancelable: true,
      clientX: rect.left + rect.width / 2,
      clientY: rect.top + rect.height / 2,
      deltaX: e.deltaX,
      deltaY: e.deltaY,
      deltaMode: e.deltaMode,
      ctrlKey: e.ctrlKey,
      metaKey: e.metaKey,
      shiftKey: e.shiftKey,
      altKey: e.altKey,
    }));
    updateCodexFollowBottomFromUserScroll(sessionId, cached);
  }, { passive: false });

  bar.addEventListener('click', (e) => e.stopPropagation());
  bar.addEventListener('mousedown', (e) => e.stopPropagation());

  const restoredDelivery = floatingPromptDeliveries.get(sessionId);
  if (restoredDelivery && ['unconfirmed', 'failed', 'content-mismatch'].includes(restoredDelivery.status)) {
    markFloatingInputStuck(bar, sessionId);
  }

  return {
    dispose() {
      // A hidden contenteditable's innerText collapses to textContent, losing
      // DIV/BR line breaks. Input events already saved the visible draft.
      if (inputBox.getClientRects().length) saveFloatingInputDraft(sessionId, inputBox);
      voiceInput.dispose();
      composerTools.dispose();
      promptPolish.dispose();
      if (chromeObserver) chromeObserver.disconnect();
      // 输入栏拆掉后变量必须归零，否则卡片层会一直给一条不存在的栏留空白。
      if (panel && bar.parentNode === panel) panel.style.setProperty('--fi-bar-h', '0px');
      if (bar.parentNode) bar.parentNode.removeChild(bar);
    },
  };
}

// T2：头部的状态药丸收成面包屑末尾的一个 6px 点。文案（工作中 / 在等你回答 /
// 已断开）由 composer 的状态行负责念——那里正对着输入框，是用户真正在看的地方；
// 头部只保留「这个会话现在活不活」这一位信息，颜色说完即可。
function paintTerminalRuntimeStatus(element, session, now = Date.now()) {
  if (!element || !session) return null;
  const runtime = deriveSessionRuntimeStatus(session, {
    now,
    isRunning: isSessionCardWorking(session),
  });

  const nextClassName = `terminal-crumb-dot ${runtime.state}`;
  if (element.className !== nextClassName) element.className = nextClassName;
  if (element.dataset.runtimeState !== runtime.state) element.dataset.runtimeState = runtime.state;
  if (element.dataset.provider !== runtime.provider) element.dataset.provider = runtime.provider;
  if (element.title !== runtime.visibleText) element.title = runtime.visibleText;
  if (element.getAttribute('aria-label') !== runtime.ariaLabel) {
    element.setAttribute('aria-label', runtime.ariaLabel);
  }
  return runtime;
}

function stopTerminalRuntimeStatusTicker() {
  if (!_terminalRuntimeStatusTicker) return;
  clearInterval(_terminalRuntimeStatusTicker);
  _terminalRuntimeStatusTicker = null;
}

function composerBarForTicker() {
  const bar = document.querySelector('.terminal-panel .floating-input-bar');
  return bar && typeof bar._paintComposer === 'function' ? bar : null;
}

function syncTerminalRuntimeStatusTicker(session) {
  const statusElement = toolbarCrumbEl && toolbarCrumbEl.querySelector('.terminal-crumb-dot');
  // composer 的状态行有「正在工作 · 38s」和「N 分钟前完成上一轮」两句会自己走的文案，
  // 所以只要输入栏在，秒表就得走 —— 不再只在卡片视图下跳。
  // 面包屑的状态点 T2 起在两个视图里都挂在头部，所以它也不再按视图分叉。
  const shouldTick = !!session && (!!statusElement || !!composerBarForTicker());
  if (!shouldTick) {
    stopTerminalRuntimeStatusTicker();
    return;
  }
  if (_terminalRuntimeStatusTicker) return;
  _terminalRuntimeStatusTicker = setInterval(() => {
    if (document.hidden) return;
    if (!activeSessionId) {
      stopTerminalRuntimeStatusTicker();
      return;
    }
    const active = sessions.get(activeSessionId);
    const target = toolbarCrumbEl && toolbarCrumbEl.querySelector('.terminal-crumb-dot');
    const bar = composerBarForTicker();
    if (!active || (!target && !bar)) {
      stopTerminalRuntimeStatusTicker();
      return;
    }
    const now = Date.now();
    if (target) paintTerminalRuntimeStatus(target, sessions.get(sessionSplit?.focusedId()) || active, now);
    if (bar) bar._paintComposerClock(active, now);
    sessionSplit?.secondary()?.updateStatus({clockOnly:true,now});
  }, 1000);
}

// 2026-07-19 maintainer · 方案C：刷新浮动输入栏的 ctx chip 与中断钮（跟随 active session 状态）。
//   调用时机：mountFloatingInput 后 + 每次 renderSessionList（status 事件驱动）。
// session-updated arrives several times a second for every running agent, yet
// only the focused composer is painted, and each paint re-syncs the split
// selector over all sessions. Paint at most once per frame for those events.
let floatingBarStateFrame = null;
function scheduleFloatingBarState() {
  if (floatingBarStateFrame) return;
  floatingBarStateFrame = requestAnimationFrame(() => {
    floatingBarStateFrame = null;
    updateFloatingBarState();
  });
}

function updateFloatingBarState() {
  sessionSplit?.sync();
  if (!activeSessionId) {
    syncTerminalRuntimeStatusTicker(null);
    return;
  }
  const s = sessions.get(activeSessionId);
  if (!s) {
    syncTerminalRuntimeStatusTicker(null);
    return;
  }
  terminalCache.get(activeSessionId)?._codexBackstage?.updateStatus();

  // The header used to be a one-time snapshot from showTerminal(), while the
  // sidebar and composer followed live state. Keep all three surfaces aligned.
  const status = toolbarCrumbEl && toolbarCrumbEl.querySelector('.terminal-crumb-dot');
  if (status) paintTerminalRuntimeStatus(status, sessions.get(sessionSplit?.focusedId()) || s);
  syncTerminalRuntimeStatusTicker(s);

  const bar = document.querySelector('.terminal-panel .floating-input-bar');
  if (!bar) return;
  // ctx 环、模型 / 思考档 chip、状态行、发送与停止全部由 composer 自己那一处画完。
  // 以前这里另算一份 ctx 文案和一份停止键判据，等于同一件事有两个作者。
  if (typeof bar._paintComposer === 'function') bar._paintComposer(s);
}

// 2026-07-21 maintainer [修进行中误判]：周期性兜底回收"卡死的进行中"。
//   此前回收路径都有洞：hook 系（claude）stop hook 丢失/hook server 掉线/事件错过时
//   无任何回收 → 实测卡在运行中 4 小时；card 系的 45min maxAge 只在静默计时器里
//   检查（完全无输出时永远不会触发）；gcWorking 在 watcher 卡死且无 turn-complete 时
//   永久置位。规则：
//   - card 系：hasSemanticCardWorking 的 45min maxAge（每次扫都真正执行）
//   - hook 系：45min 无任何 PTY 输出判卡死（_lastOutputTs 由 onTerminalOutput/语义起点维护）
//   - gcWorking：8s 无任何 partial-update（活着的 watcher 每 1.5s 必有 streaming）
function sweepStaleRunning() {
  const now = Date.now();
  let dirty = false;
  for (const s of sessions.values()) {
    if (isNativeAgent(s)) continue;
    if (s.status === 'running' && (s._runSource === 'semantic' || s._runSource === 'pty-semantic')) {
      if (s._agentWorking === 'card' && !hasSemanticCardWorking(s)) {
        const truth = getSessionRuntimeTruth(s, { now });
        const freshStrongPty = truth.state === RUNTIME_RUNNING
          && truth.confidence === CONFIDENCE_STRONG
          && now - Number(truth.observedAt || 0) <= 10 * 1000;
        if (freshStrongPty) {
          s._runSource = 'pty-semantic';
          s._agentWorking = 'pty';
        } else {
          s._runSource = null;
          s._agentWorking = null;
          observeSessionRuntime(s, {
            state: RUNTIME_UNKNOWN,
            source: 'stale-card-runtime',
            confidence: CONFIDENCE_INFERRED,
            observedAt: now,
            reason: 'missing-turn-complete',
          });
        }
        dirty = true;
      } else if (s._agentWorking === 'hook' && s._lastOutputTs && now - s._lastOutputTs > 45 * 60 * 1000) {
        s._runSource = null;
        s._agentWorking = null;
        observeSessionRuntime(s, {
          state: RUNTIME_UNKNOWN,
          source: 'stale-claude-hook-runtime',
          confidence: CONFIDENCE_INFERRED,
          observedAt: now,
          reason: 'missing-stop-or-pty-evidence',
        });
        dirty = true;
      } else if (s._agentWorking === 'pty' && s._lastOutputTs && now - s._lastOutputTs > 45 * 60 * 1000) {
        s._runSource = null;
        s._agentWorking = null;
        observeSessionRuntime(s, {
          state: RUNTIME_UNKNOWN,
          source: 'stale-pty-runtime',
          confidence: CONFIDENCE_INFERRED,
          observedAt: now,
          reason: 'no-current-runtime-evidence',
        });
        dirty = true;
      }
    }
    if (s.gcWorking && s._gcWorkingLastTs && now - s._gcWorkingLastTs > GC_WORKING_FRESH_MS) {
      s.gcWorking = false;
      dirty = true;
    }
  }
  if (dirty) scheduleSessionListRender();
}
setInterval(sweepStaleRunning, 60 * 1000);
// Even fully idle sessions age across minute/day and dormant-window boundaries.
setInterval(scheduleSessionListRender, 60 * 1000);
function flashPromptLine(terminal, lineNumber) {
  const container = terminal.element && terminal.element.closest('.terminal-container');
  if (!container) return;
  const renderer = terminal._core._renderService;
  if (!renderer || !renderer.dimensions) return;
  const cellH = renderer.dimensions.css.cell.height;
  const viewY = terminal.buffer.active.viewportY;
  const padTop = parseFloat(getComputedStyle(container).paddingTop) || 0;
  const topPx = (lineNumber - viewY) * cellH + padTop;
  let highlight = container.querySelector('.prompt-highlight');
  if (!highlight) {
    highlight = document.createElement('div');
    highlight.className = 'prompt-highlight';
    container.appendChild(highlight);
  }
  highlight.style.top = topPx + 'px';
  highlight.style.height = cellH + 'px';
  highlight.style.display = 'block';
  highlight.style.animation = 'none';
  highlight.offsetHeight;
  highlight.style.animation = 'prompt-flash 0.8s ease-out forwards';
}

// Hub → Claude /rename uses the same serialized submission path as the composer.
// A busy session keeps only the latest name; completion rechecks its live state.
function syncRenameToClaude(sessionId, title) {
  const session = sessions.get(sessionId);
  if (!session) return;
  if (session.runtimeBackend === 'claude-stream-json') {
    session._pendingRename = null;
    return;
  }
  const clean = String(title).replace(/[\r\n]/g, ' ').trim().slice(0, 80);
  if (!clean) return;
  session._pendingRename = clean;
  flushRenameToClaude(sessionId);
}

function flushRenameToClaude(sessionId) {
  const session = sessions.get(sessionId);
  if (!session?._pendingRename || session.runtimeBackend || session.status === 'dormant') return;
  if (['running', 'starting', 'waiting'].includes(getSessionRuntimeTruth(session).state)) return;
  const title = session._pendingRename;
  session._pendingRename = null;
  ipcRenderer.invoke('session:send-prompt', { sessionId, text: '/rename ' + title })
    .then(result => {
      if (!result?.ok || result.notSent) throw new Error(result?.message || 'CLI 未接受改名');
    })
    .catch(error => showPreviewNotice('Hub 名称已保存，CLI 名称未同步：' + error.message, 'error'));
}

// --- Inline rename ---
function startRename(sessionId, titleSpan) {
  const session = sessions.get(sessionId);
  if (!session) return;

  const input = document.createElement('input');
  input.className = 'terminal-title-input';
  input.value = session.title;

  const finish = async () => {
    const trimmed = input.value.trim();
    const changed = !!trimmed && trimmed !== session.title;
    if (changed) {
      // 本地必须自己落地，不能等 session-updated 的回声：那个 handler 的守卫是
      // `if (!local.userRenamed && session.title) local.title = session.title`，
      // 用来挡自动改名（OSC / auto-title）覆盖用户手动改的名字。但我们上一行刚把
      // userRenamed 置成 true，回声就被自己的守卫挡掉了 —— 改名于是只落到主进程，
      // 侧栏和顶栏还是旧名字，看起来像「点了没反应」。
      // 只有 dormant 分支原本歪打正着写了本地 title，所以休眠会话改名一直是好的，
      // 活着的会话（codex / codex-resume / 分支都属此列）一直是坏的。
      session.userRenamed = true;
      session.title = trimmed;
      // titleSpan 是进入改名前捕获的那个节点，下面会被放回 DOM。不同步刷新它，
      // 顶栏就会一直显示旧标题，直到切走再切回来触发 showTerminal 重建。
      titleSpan.textContent = trimmed;
    }
    input.replaceWith(titleSpan);
    if (!changed) return;
    renderSessionList();
    schedulePersist();
    // 休眠会话没有 PTY，也没有主进程侧的 session 对象要同步，到此为止。
    if (session.status === 'dormant') return;
    const renamed = await ipcRenderer.invoke('rename-session', { sessionId, title: trimmed, userRenamed: true });
    if (renamed?.nativeRename?.status === 'failed') showToast('Hub 名称已保存；Claude 历史同步失败：' + renamed.nativeRename.message, 'warning');
    if (session.kind === 'claude' || session.kind === 'claude-resume') {
      syncRenameToClaude(sessionId, trimmed);
    }
  };

  input.addEventListener('blur', finish);
  input.addEventListener('keydown', (e) => {
    if (e.isComposing || e.keyCode === 229) return;
    if (e.key === 'Enter') input.blur();
    if (e.key === 'Escape') { input.value = session.title; input.blur(); }
  });

  titleSpan.replaceWith(input);
  input.focus();
  input.select();
}

// --- Session selection ---
let sessionOpenIntent = 0;
ipcRenderer.on('session-persistence-error', (_event, error) => {
  require('./ui-feedback').showHubAlert('会话信息未保存：' + error.message);
});
async function selectSession(id, opts = {}) {
  window.hubWorkspaces?.close();
  if (!opts.splitBypass && sessionSplit?.routesSelection()) return sessionSplit.route(id, undefined, opts);
  sessionSplit?.usePrimary();
  const intent = ++sessionOpenIntent;
  const reuseCardHistory = activeSessionId === id && !activeMeetingId && currentView === 'card'
    && terminalPanelEl.style.display !== 'none' && !terminalPanelEl.classList.contains('home-active');
  void savePreviewState({ nonBlocking: true });
  activeMeetingId = null;
  // Hiding the meeting DOM alone leaves meeting-room.js believing the room is
  // still active (pollers, draft state, and event guards keep running).  This
  // matters especially for avatar -> child-session navigation, but the same
  // lifecycle cleanup is required for every sidebar session switch.
  if (typeof MeetingRoom !== 'undefined'
      && typeof MeetingRoom.getActiveMeetingId === 'function'
      && MeetingRoom.getActiveMeetingId()
      && typeof MeetingRoom.closeMeetingPanel === 'function') {
    MeetingRoom.closeMeetingPanel();
  }
  if (window.__xresearchHide) window.__xresearchHide(); // 2026-07-23 投研面板互斥
  if (window.__studyHide) window.__studyHide(); // 2026-09-01 学习面板互斥
  if (window.__assistantHide) window.__assistantHide();
  if (window.__writingHide) window.__writingHide(); // 2026-09-30 写作面板互斥
  if (window.__ranHide) window.__ranHide(); // 2026-09-04 RAN 工作台面板互斥
  setShellNavActive(null);
  const mrp = document.getElementById('meeting-room-panel');
  if (mrp) mrp.style.display = 'none';
  clearPreviewUI();
  const tp = document.getElementById('terminal-panel');
  if (tp) tp.style.display = '';

  const session = sessions.get(id);
  if (!session) return;
  const switching = activeSessionId !== id;
  if (switching && activeSessionId && currentView === 'card') {
    const previousOverlay = document.getElementById('msg-overlay');
    if (previousOverlay) {
      _cardOverlayFollowBottomBySession.set(activeSessionId, _isCardOverlayAtBottom(previousOverlay));
    }
  }
  const cachedBeforeSelect = terminalCache.get(id);
  const requestedBottomPin = opts && opts.forceScrollBottom === true;
  // 左侧栏的显式“跳到最新”适用于所有 CLI；Codex 仍保留首次打开自动置底，
  // 修复卡片视图里重复点击当前 Claude/Kimi 会话时请求被 kind 过滤掉的问题。
  const forceScrollBottom = requestedBottomPin
    || !!(isCodexKind(session.kind) && (!cachedBeforeSelect || !cachedBeforeSelect.opened));
  // 视图按会话记忆：先算出这个会话该用哪个视图，再决定要不要把焦点给终端
  // （卡片视图下抢终端焦点是错的）。
  const targetView = opts.inspectOnly ? 'pty' : selectionViewModeForSession(id, session);
  const shouldFocusTerminal = switching || targetView === 'pty';
  activeSessionId = id;
  // showTerminal owns the history request (and the cached-view fast path).
  // Selecting a session must not start a second load through applyViewMode.
  applyViewMode(targetView, { remember: false, skipPreviousCardCapture: true });
  if (completionNotificationToggle) completionNotificationToggle.refreshTarget();
  cardMultiSelectController.setVisible(currentView === 'card' && !!activeSessionId);
  paintSidebarActiveTarget({ sessionId: id });

  // Dormant session: clicking wakes it via resume-session IPC. Don't render
  // terminal now — session-created handler below will take over once PTY is up.
  // Still switch selection and paint a pending surface immediately so a real
  // CLI restart never looks like a dropped click.
  if (session.status === 'dormant') {
    if (opts.inspectOnly) return;
    // Paint navigation before the main process checks ownership. No CLI or
    // transcript is opened until that check succeeds; an occupied session
    // stays on the placeholder, and a newer selection cancels this intent.
    session._resumePending = true;
    session._openStatusIntent = intent;
    paintSidebarResumePending(id, true);
    ipcRenderer.send('focus-session', { sessionId: null });
    showDormantResumePlaceholder(session, null, { checking: true });
    scheduleSessionListRender();
    const clearChecking = () => {
      if (session._openStatusIntent !== intent) return;
      delete session._openStatusIntent;
      if (!_pendingDormantResumes.has(id)) session._resumePending = false;
      const current = sessions.get(id);
      if (current?._openStatusIntent === intent) {
        delete current._openStatusIntent;
        if (!_pendingDormantResumes.has(id)) current._resumePending = false;
      }
      paintSidebarResumePending(id, !!current?._resumePending);
      scheduleSessionListRender();
    };
    let opening;
    try { opening = await ipcRenderer.invoke('session:open-status', id); }
    catch (error) { opening = { available: false, message: error.message || String(error) }; }
    if (intent !== sessionOpenIntent || activeSessionId !== id) { clearChecking(); return; }
    if (!opening?.available) {
      clearChecking();
      showDormantResumePlaceholder(session, new Error(opening?.message || '会话占用状态暂时无法确认'));
      return;
    }
    // session-created may have completed an existing wake while this check
    // was in flight. Render that live session instead of leaving a placeholder
    // waiting for an event which has already arrived.
    if (sessions.get(id)?.status !== 'dormant') { clearChecking(); return selectSession(id, opts); }
    delete session._openStatusIntent;
    // A dormant row can still carry the last run's disconnect alert. Record it
    // as read before resume replaces the dormant object; otherwise the first
    // full-screen repaint can replay the old error without an acknowledgement
    // signature and put the session straight back under “运行异常”.
    const acknowledgedFailure = acknowledgeSessionFailureState(session, { render: false });
    if (acknowledgedFailure) schedulePersist();
    session._resumePending = true;
    paintSidebarResumePending(id, true);
    ipcRenderer.send('focus-session', { sessionId: null });
    showDormantResumePlaceholder(session);
    scheduleSessionListRender();
    void resumeDormantSession(id, opts).catch((error) => {
      console.warn('[resume-session] dormant wake failed:', error);
      if (activeSessionId === id) showDormantResumePlaceholder(session, error);
      require('./ui-feedback').showHubAlert(`会话恢复失败：${error && error.message ? error.message : String(error)}`);
    });
    return;
  }
  // Reading a reply must not dismiss a still-pending request for input.
  clearSessionCompletedUnread(session);
  // 2026-08-27：「运行异常/断连」是一个**提醒**信号，用户点开看过就算处理过了。
  // 原来 clearSessionConnectionIssue 只在提交提问或回答完成时调用，所以只是点开
  // 看一眼的话，那条断连会一直挂在侧栏「运行异常」组里下不去。
  // 2026-08-28 补齐：只清 connectionIssue 不够 —— 断连同时把 runtimeTruth 打成了
  // RUNTIME_FAILED（终态），且 TUI 重绘会把同一段报错文本再喂一遍。要一起降级
  // 终态 + 记住已确认签名，提醒才真的只提醒一次。
  if (!opts.inspectOnly) acknowledgeSessionFailureState(session);
  ipcRenderer.send('focus-session', { sessionId: id });
  showTerminal(id, { focus: shouldFocusTerminal, forceScrollBottom, reuseCardHistory });
  for (const meeting of Object.values(meetings)) {
    if (meeting.subSessions?.includes(id)) markMeetingMemberRead(meeting.id, id);
  }
  scheduleSessionListRender();
  // Snapshot the current question signature as "read" AFTER showTerminal —
  // on first selection that's when cached.opened flips to true, and
  // getQuestionsSignature needs an opened buffer to read. Calling before
  // showTerminal always returned '' on first click, which then made the very
  // first AI reply after opening the session never bump unread.
  session.readSignature = getQuestionsSignature(id);
  // auto-focus 浮动输入框 — 与群聊 openMeeting (meeting-room.js IF-C2) 对称：
  //   点进 session 后用户可直接键盘输入，无需先点输入框。defer 50ms 让 xterm
  //   open + robustFit 的 rAF 链先跑完，避免被它抢焦点回去。
  setTimeout(() => {
    if (activeSessionId !== id) return; // 50ms 内用户又切走了
    if (sessionSplit && !sessionSplit.isPrimaryFocused()) return;
    const inputBox = document.querySelector('.terminal-panel .floating-input-box');
    if (inputBox && document.activeElement !== inputBox) {
      inputBox.focus();
      // caret 移到内容末尾（保留草稿 caret 体验）
      const sel = window.getSelection();
      if (sel) {
        const range = document.createRange();
        range.selectNodeContents(inputBox);
        range.collapse(false);
        sel.removeAllRanges();
        sel.addRange(range);
      }
    }
  }, 50);
  await restorePreviewForContext(`session:${id}`);
}

function setShellNavActive(value) {
  for (const [button, key] of [[btnHome, 'home'], [btnResearch, 'research']]) {
    if (!button) continue;
    const active = value === key;
    button.classList.toggle('active', active);
    if (active) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  }
}

const launchCenter = createLaunchCenterController({
  document,
  ipcRenderer,
  openSessionModal: options => window.WorkspaceController.openNewSessionModal(options),
  closeSessionModal: () => window.WorkspaceController.closeNewSessionModal(),
  prepareGroupPanel: () => {
    const host = document.getElementById('launch-center-group-host');
    if (!host) throw new Error('launch-center-group-host missing');
    createMeetingByMode('group', {
      embedded: true,
      host,
      onCreated: () => launchCenter.close(),
    });
  },
  closeGroupPanel: () => {
    if (typeof window.closeMeetingCreateModal === 'function') window.closeMeetingCreateModal();
  },
  resumeSession: kind => ipcRenderer.invoke('create-session', kind),
});
window.LaunchCenter = launchCenter;

// --- Unified launch center ---
btnNew.addEventListener('click', () => launchCenter.open('session'));
document.getElementById('btn-new-more').addEventListener('click', () => launchCenter.open('session'));
document.getElementById('acp-settings-open')?.addEventListener('click', () => {
  require('./acp-settings').openAcpSettings({ document, invoke:(...args)=>ipcRenderer.invoke(...args) })
    .catch(error => require('./ui-feedback').showHubAlert('ACP 配置未打开：' + error.message));
});

document.addEventListener('mousedown', (e) => {
  if (!wrapperEl.contains(e.target) && menuEl.style.display !== 'none') launchCenter.close();
});

// v1.5.1：弹窗升级为居中 modal 后，遮罩(::before)铺满 viewport，
// 点击遮罩区会落到弹窗元素本身（e.target === menuEl）→ 关闭。
// 点击内部 option/按钮 → e.target 是子元素，不关闭。
menuEl.addEventListener('mousedown', (e) => {
  if (e.target === menuEl) launchCenter.close();
});

// ESC 关闭任意打开的侧栏 modal
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (menuEl && menuEl.style.display !== 'none') launchCenter.close();
});

// --- Launcher (启动面板 v0.8.3 · 三精灵海报) ---
// 主 CTA 召集 AI 群聊;底部超链接 1v1 单聊(走 create-session)。
// 静态 DOM,无最近会话,无磁盘 IO,无 IPC 启动开销。
for (const cta of document.querySelectorAll('.launcher-cta')) {
  cta.addEventListener('click', () => {
    if (cta.dataset.launcherAction === 'group') {
      createMeetingByMode('group');
    }
  });
}
for (const link of document.querySelectorAll('.launcher-link')) {
  link.addEventListener('click', () => {
    const kind = link.dataset.launcherKind;
    if (kind) launchCenter.open('session', { kind });
  });
}

// --- Meeting buttons ---
if (btnHome) {
  btnHome.addEventListener('click', () => escapeToHome());
}
// --- Create Meeting ---
function createMeetingByMode(mode, options = {}) {
  if (typeof window.openMeetingCreateModal === 'function') {
    window.openMeetingCreateModal('group', options);
  } else {
    console.error('[createMeetingByMode] meeting-create-modal not loaded');
  }
}

// --- Resume/search past session modals ---
function normalizeSearchHitPath(value) {
  if (!value) return '';
  try { return path.resolve(String(value)).replace(/\\/g, '/').toLowerCase(); }
  catch { return String(value).replace(/\\/g, '/').toLowerCase(); }
}

function findExistingSessionForSearchHit(hit) {
  if (!hit) return null;
  if (hit.hubSessionId && sessions.has(hit.hubSessionId)) return sessions.get(hit.hubSessionId);
  if (!hit.nativeSessionId) return null;
  const matches = [];
  for (const session of sessions.values()) {
    if (!session || session.meetingId) continue;
    if (hit.nativeFamily === 'claude' && session.ccSessionId === hit.nativeSessionId) matches.push(session);
    if (hit.nativeFamily === 'codex' && session.codexSid === hit.nativeSessionId) {
      const hitRoot = normalizeSearchHitPath(hit.codexSessionsRoot);
      const sessionRoot = normalizeSearchHitPath(session.codexSessionsRoot);
      if (!hitRoot || !sessionRoot || hitRoot === sessionRoot) matches.push(session);
    }
  }
  matches.sort((a, b) => {
    const aLive = a.status !== 'dormant' ? 1 : 0;
    const bLive = b.status !== 'dormant' ? 1 : 0;
    if (aLive !== bLive) return bLive - aLive;
    const bAt = Number(b.lastCompletedAt || b.lastMessageTime || b.updatedAt || 0);
    const aAt = Number(a.lastCompletedAt || a.lastMessageTime || a.updatedAt || 0);
    return bAt - aAt;
  });
  return matches[0] || null;
}

async function waitForRendererSession(sessionId, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const session = sessions.get(sessionId);
    if (session) return session;
    await new Promise(resolve => setTimeout(resolve, 40));
  }
  return sessions.get(sessionId) || null;
}

function focusOrdinarySearchHit(hit, preview) {
  const overlay = document.getElementById('msg-overlay');
  if (!overlay) return false;
  const eventId = hit && hit.bestMatch && hit.bestMatch.eventId;
  let card = null;
  if (eventId && eventId !== 'title') {
    try { card = overlay.querySelector(`.turn-card[data-turn-id="${CSS.escape(String(eventId))}"]`); }
    catch {}
    // Claude history exposes each assistant message under the parser's display
    // ID, while the search index retains the underlying transcript entry ID.
    if (!card && hit.nativeFamily === 'claude') {
      card = overlay.querySelector(`.turn-card[data-turn-id="${CSS.escape('claude-message-' + String(eventId))}"]`);
    }
  }
  if (card) {
    cardFollowScroll.pause();
    card.classList.add('global-search-focus');
    card.scrollIntoView({ block: 'center', behavior: 'smooth' });
    setTimeout(() => { if (card.isConnected) card.classList.remove('global-search-focus'); }, 1500);
    return true;
  }

  const match = preview && Array.isArray(preview.context)
    ? (preview.context.find(item => item && item.isMatch) || preview.context[0])
    : null;
  const text = match && match.text || hit && hit.bestMatch && hit.bestMatch.text || '';
  if (!text) return false;
  const existing = overlay.querySelector('.global-search-history-focus');
  if (existing) existing.remove();
  const notice = document.createElement('section');
  notice.className = 'global-search-history-focus';
  const title = document.createElement('strong');
  title.textContent = eventId === 'title'
    ? '昨日之我 · 命中会话标题'
    : '昨日之我 · 命中较早历史（当前卡片窗口之外）';
  const body = document.createElement('p');
  body.textContent = text;
  notice.append(title, body);
  cardFollowScroll.pause();
  overlay.prepend(notice);
  notice.scrollIntoView({ block: 'start', behavior: 'smooth' });
  return true;
}

async function createSessionFromSearchHit(hit) {
  if (!hit || !hit.nativeSessionId) return null;
  const opts = {
    title: hit.title || undefined,
    cwd: hit.cwd || undefined,
    resumeTranscriptPath: hit.transcriptPath || undefined,
    autoTitleGenerated: !!hit.title,
  };
  let kind;
  if (hit.nativeFamily === 'claude') {
    kind = hit.provider === 'deepseek' ? 'deepseek-resume' : 'claude-resume';
    opts.resumeCCSessionId = hit.nativeSessionId;
    if (hit.provider === 'deepseek') opts.deepseekLegacyClaude = true;
  } else if (hit.nativeFamily === 'codex') {
    kind = hit.provider === 'deepseek' ? 'deepseek-resume' : 'codex-resume';
    opts.useResume = true;
    opts.codexSid = hit.nativeSessionId;
    if (hit.codexSessionsRoot) opts.codexSessionsRoot = hit.codexSessionsRoot;
    if (hit.codexProfile) opts.codexProfile = hit.codexProfile;
  } else {
    return null;
  }
  return ipcRenderer.invoke('create-session', { kind, opts });
}

async function openGlobalSearchHit(hit, opts = {}) {
  if (!hit) return null;
  if (hit.provider === 'meeting' || hit.meetingId) {
    const meetingId = hit.meetingId;
    if (!meetingId || !meetings[meetingId]) throw new Error('群聊记录已不存在');
    await selectMeeting(meetingId, { forceScrollBottom: false });
    const openedAt = Date.now();
    const saved = await ipcRenderer.invoke('update-meeting-sync', { meetingId, fields: { lastMessageTime: openedAt } });
    if (!saved) throw new Error('群聊已打开，但侧栏活动时间保存失败');
    meetings[meetingId].lastMessageTime = openedAt;
    schedulePersist();
    sessionListRenderer.revealSearchItem(meetingId);
    if (opts.focus && typeof MeetingRoom !== 'undefined' && typeof MeetingRoom.focusSearchHit === 'function') {
      const target = opts.preview && Array.isArray(opts.preview.context)
        ? (opts.preview.context.find(item => item && item.isMatch) || opts.preview.context[0])
        : null;
      requestAnimationFrame(() => MeetingRoom.focusSearchHit({
        eventId: hit.bestMatch && hit.bestMatch.eventId,
        text: target && target.text || hit.bestMatch && hit.bestMatch.text || '',
      }));
    }
    return { type: 'meeting', id: meetingId };
  }

  let target = findExistingSessionForSearchHit(hit);
  if (target && target.status === 'dormant') {
    await resumeDormantSession(target.id, { forceScrollBottom: false });
    target = sessions.get(target.id) || target;
  }
  if (!target) {
    const created = await createSessionFromSearchHit(hit);
    if (!created || !created.id) throw new Error('无法恢复这个原生会话');
    target = await waitForRendererSession(created.id) || created;
  }
  if (!target || !target.id) throw new Error('会话记录已不存在');
  await selectSession(target.id, { forceScrollBottom: !opts.focus });
  const recorded = await ipcRenderer.invoke('session:record-history-open', { sessionId: target.id });
  if (!recorded?.ok) throw new Error(recorded?.message || '会话已打开，但侧栏活动时间保存失败');
  const openedSession = sessions.get(target.id);
  if (openedSession) {
    openedSession.lastMessageTime = Math.max(openedSession.lastMessageTime || 0, recorded.at);
    openedSession.hiddenFromSidebar = false;
  }
  // 群聊成员仍从原群聊入口进入，避免复制成一个普通会话。
  const parentId = openedSession?.meetingId || Object.values(meetings).find(m => m.subSessions?.includes(target.id))?.id;
  if (parentId && meetings[parentId]) {
    const saved = await ipcRenderer.invoke('update-meeting-sync', { meetingId: parentId, fields: { lastMessageTime: recorded.at } });
    if (!saved) throw new Error('会话已打开，但所属群聊的活动时间保存失败');
    meetings[parentId].lastMessageTime = recorded.at;
  }
  schedulePersist();
  sessionListRenderer.revealSearchItem(parentId || target.id, target.id);

  if (opts.focus) {
    // 搜索命中要在卡片视图里看，但这是导航副作用而非用户的视图偏好，不写记忆。
    applyViewMode('card', { remember: false });
    const loaded = await loadSessionHistoryToOverlay(target.id, { forceScrollBottom: false });
    if (loaded && loaded.mounted > 0) _cardHistoryHydratedSid = target.id;
    focusOrdinarySearchHit(hit, opts.preview);
  }
  return { type: 'session', id: target.id };
}

// 侧栏这些标题（会话 + 群聊）本来就在内存里，一共约 10KB。交给搜索弹窗做
// 「输入即出」的即时层，不走 IPC、不等 SQLite 全文索引 —— 见 core/title-index.js。
// hubSessionId / meetingId 必须带上：openGlobalSearchHit 靠它们找回真正的会话。
function collectLocalSearchTitles() {
  const out = [];
  for (const session of sessions.values()) {
    // 渲染层的会话对象用的是 `id`（`hubId` 只是落盘时的字段名，见 :6090 的 hubId: s.id）。
    if (!session || !session.id || session.hiddenFromSidebar) continue;
    if (session.meetingId) continue;              // 群聊子会话挂在群聊下面，不单列
    if (session.purpose === 'xresearch-research') continue;
    const kind = String(session.kind || '');
    const provider = isClaudeFamily(kind) ? 'claude'
      : isCodexKind(kind) ? 'codex'
        : kind.startsWith('deepseek') ? 'deepseek' : 'claude';
    out.push({
      key: `live-session:${session.id}`,
      hubSessionId: session.id,
      title: session.title,
      provider,
      kind,
      cwd: session.cwd || null,
      projectLabel: session.workspaceLabel || null,
      updatedAt: Number(session.lastMessageTime || session.lastCompletedAt || session.updatedAt || 0) || 0,
    });
  }
  for (const meeting of Object.values(meetings || {})) {
    if (!meeting || !meeting.id) continue;
    out.push({
      key: `live-meeting:${meeting.id}`,
      meetingId: meeting.id,
      title: meeting.title,
      provider: 'meeting',
      kind: 'meeting',
      cwd: meeting.workspace || null,
      projectLabel: meeting.workspaceLabel || null,
      updatedAt: Number(meeting.lastMessageTime || meeting.lastCompletedAt || meeting.createdAt || 0) || 0,
    });
  }
  return out;
}

const pastSessionModals = createPastSessionModals({
  document,
  window,
  ipcRenderer,
  clipboard,
  escapeHtml,
  getSessions: () => sessions,
  getLocalTitles: collectLocalSearchTitles,
  selectSession: (sessionId, opts) => selectSession(sessionId, opts),
  openSearchHit: (hit, opts) => openGlobalSearchHit(hit, opts),
  searchCardRenderer: turnCardRenderer,
  openSearchPath: (filePath, opts) => openPathInHub(filePath, { ...opts, throwOnError: true }),
});
const { openResumeModal, openSearchModal } = pastSessionModals;
// One ordinary click opens HTTP(S), file:// and local paths through the same
// Hub provider used by card view. Relative paths are resolved against the
// owning session cwd. Previewable files and directories stay inside Hub;
// unsupported file formats continue to use their system application.
//
async function openPathInHub(filePath, opts = {}) {
  const fail = (message, target, detail) => {
    const error = new Error(detail ? `${message}：${detail}` : message);
    console.warn('[hub] path open failed:', target || filePath, '->', error.message);
    if (typeof showPreviewNotice === 'function') showPreviewNotice(error.message, 'error');
    if (opts.throwOnError) throw error;
    return { ok: false, path: target || null, error: error.message };
  };
  const cwd = opts.cwd || null;
  const previewOptions = {
    pinned: opts.pinned === true,
    preview: opts.pinned === true ? false : opts.preview !== false,
  };
  if (typeof opts.fullscreen === 'boolean') previewOptions.fullscreen = opts.fullscreen;
  const raw = _cleanPathCandidate(filePath);
  if (!raw) return fail('路径为空或无法识别', null);
  if (/^https?:\/\//i.test(raw)) {
    await openPreviewPanel(raw, previewOptions);
    return { ok: true, path: raw, type: 'preview' };
  }
  const fullPath = _normalizeLocalPathForOpen(raw, cwd, opts.requireExistsForRel !== false);
  if (!fullPath) return fail('路径不存在或无法解析', raw);
  // A share path is checked off the main thread: an unreachable server would
  // otherwise freeze the window until the SMB timeout on a single click.
  if (await _isDirectoryPathAsync(fullPath)) {
    const manager = fileManagerPanel || window.FileManagerPanel;
    if (!manager || typeof manager.openDirectory !== 'function') {
      return fail('文件管理尚未就绪', fullPath);
    }
    const activeContext = typeof getActiveFileManagerContext === 'function'
      ? getActiveFileManagerContext()
      : null;
    const requestedRoot = cwd || (activeContext && activeContext.cwd) || fullPath;
    const context = {
      cwd: requestedRoot,
      label: opts.workspaceLabel
        || (activeContext && normalizeSearchHitPath(activeContext.cwd) === normalizeSearchHitPath(requestedRoot)
          ? activeContext.label
          : ''),
    };
    let opened;
    try { opened = await manager.openDirectory(fullPath, context); }
    catch (error) { return fail('文件管理打开失败', fullPath, String(error && error.message || error)); }
    if (!opened || opened.ok !== true) {
      return fail('文件管理打开失败', fullPath, opened && opened.error);
    }
    return { ok: true, path: fullPath, root: opened.root || fullPath, type: 'file-manager' };
  }
  if (PREVIEW_PATH_RE.test(fullPath)) {
    await openPreviewPanel(fullPath, previewOptions);
    return { ok: true, path: fullPath, type: 'preview' };
  }
  let err;
  try { err = await ipcRenderer.invoke('open-path', fullPath); }
  catch (error) { return fail('文件打开失败', fullPath, String(error && error.message || error)); }
  if (err) return fail('文件打开失败', fullPath, err);
  return { ok: true, path: fullPath, type: 'external' };
}
window.openPathInHub = openPathInHub;

window.collectPathCandidates = collectPathCandidates;

function getSessionCwd(sessionId) {
  try { return (sessions.get(sessionId) || {}).cwd || null; } catch { return null; }
}

function getActivePreviewCwd() {
  const focusedId = getFocusedSessionId();
  if (focusedId) return getSessionCwd(focusedId);
  const meeting = activeMeetingId ? meetings[activeMeetingId] : null;
  const subSessions = meeting && Array.isArray(meeting.subSessions) ? meeting.subSessions : [];
  for (const sessionId of subSessions) {
    const cwd = getSessionCwd(sessionId);
    if (cwd) return cwd;
  }
  return null;
}

const registerLocalPathLinks = createTerminalLinkRegistrar({
  getCwd: getSessionCwd,
  openPathInHub: (target, opts) => openPathInHub(target, { ...opts, throwOnError: true }),
  onError: message => showPreviewNotice(message, 'error'),
  onContextMenu: (rawPath, x, y) => {
    // pathLinkContextMenu is initialized later in this file; callback body
    // runs only when user right-clicks, by then it's been assigned.
    if (typeof pathLinkContextMenu !== 'undefined' && pathLinkContextMenu) {
      pathLinkContextMenu.open(rawPath, x, y);
    }
  },
});

// Strip artifacts we ourselves injected into the user's prompt before
// forming the sidebar preview. Today that's just clipboard-image paths:
// Ctrl+V on an image calls save-clipboard-image and pastes the resulting
// absolute path into the terminal, so CC's transcript records the path
// immediately before the user's typed text. Without this the 60-char
// preview is pure path and the real question is truncated away.
function buildPreviewFromUserMessage(raw) {
  let clean = String(raw).replace(HUB_IMG_PATH_RE, ' ').replace(/\s+/g, ' ').trim();
  if (!clean) return '';
  return clean.length > 60 ? clean.substring(0, 58) + '…' : clean;
}

// --- File Preview Panel ---
function refitActiveTerminalFromPreview() {
  const sid = activeSessionId;
  if (!sid) return;
  const cached = terminalCache.get(sid);
  if (!cached || !cached.opened) return;
  requestAnimationFrame(() => {
    if (!cached.container.offsetWidth) return;
    fitAndResizeTerminal(sid, cached, { force: true });
  });
}

const previewClipboard = process.env.CLAUDE_HUB_E2E === '1'
    && process.env.CLAUDE_HUB_E2E_FAKE_CLIPBOARD === '1'
  ? {
      writeText(value) {
        window.__hubE2EPreviewClipboardText = String(value);
      },
    }
  : clipboard;
const previewPanel = createPreviewPanelController({
  document,
  onBeforeOpen: () => sessionImmersive?.exit(),
  ipcRenderer,
  shell,
  clipboard: previewClipboard,
  fs,
  marked,
  DOMPurify,
  getActiveSessionId: getFocusedSessionId,
  getActiveMeetingId: () => activeMeetingId,
  getActiveCwd: getActivePreviewCwd,
  openPath: (filePath, openOptions = {}) => openPathInHub(filePath, {
    cwd: getActivePreviewCwd(),
    requireExistsForRel: false,
    throwOnError: true,
    ...openOptions,
  }),
  refitActiveTerminal: refitActiveTerminalFromPreview,
  onReturnToConversation: (key) => {
    // Resume the existing follow controller after the source becomes visible;
    // it also owns subsequent resize/layout changes and respects manual scrolling.
    if (key.startsWith('meeting:')) {
      document.querySelector('#meeting-room-panel .mr-gc-messages')?._cardFollowController?.follow();
      return;
    }
    if (!key.startsWith('session:')) return;
    const sid = key.slice('session:'.length);
    const overlay = sessionSplit?.isSecondaryFocused()
      ? sessionSplit.secondary().overlay : document.getElementById('msg-overlay');
    overlay?._cardFollowController?.follow();
    const cached = terminalCache.get(sid);
    if (cached) {
      cached._codexFollowBottom = true;
      cached._codexUserScrollIntentUntil = 0;
      pinTerminalViewportToBottom(cached);
      scheduleCodexBottomPin(sid, cached);
    }
  },
  onCopyFeedback: feedback => clipboardController.showFeedback(feedback),
});
const {
  openPreviewPanel,
  closePreviewPanel,
  savePreviewState,
  clearPreviewUI,
  restorePreviewForContext,
  openQuickOpen: openPreviewQuickOpen,
  dropPreviewContext,
  showPreviewNotice,
} = previewPanel;
// P0.6+: 暴露给 meeting-room.js 的"📖 记忆"按钮使用
window.openPreviewPanel = openPreviewPanel;
window.openPreviewQuickOpen = openPreviewQuickOpen;

function getActiveFileManagerContext() {
  const focusedId = getFocusedSessionId();
  if (focusedId) {
    const session = sessions.get(focusedId);
    // sessionStartedAt 供文件面板「本会话改动」使用；取不到时为 0，面板不显示该区。
    return session ? {
      cwd: session.cwd || '',
      label: session.workspaceLabel || '',
      sessionStartedAt: Number(session.spawnedAt) || 0,
    } : null;
  }
  const meeting = activeMeetingId ? meetings[activeMeetingId] : null;
  if (!meeting) return null;
  return {
    cwd: meeting.workspace || getActivePreviewCwd() || '',
    label: meeting.workspaceLabel || '',
  };
}

function addFilePathsToConversation(paths, targetId) {
  const id = targetId || getFocusedSessionId();
  if (!id) {
    if (window.MeetingRoom?.appendFilePaths) return window.MeetingRoom.appendFilePaths(paths);
    throw new Error('请先打开一个会话');
  }
  const bar = [...document.querySelectorAll('.floating-input-bar')].find(node => node.dataset.sessionId === id);
  const box = bar?.querySelector('.floating-input-box');
  if (!box || sessions.get(id)?.readOnly || box.getAttribute('contenteditable') === 'false') throw new Error('目标会话输入框不可用，请先打开会话');
  const current = readContenteditablePlainText(box);
  replaceContenteditableText(box, `${current}${current.trim() ? '\n\n' : ''}${paths.join('\n')}`);
  placeCaretAtContenteditableEnd(box);
  saveFloatingInputDraft(id, box);
  box.dispatchEvent(new Event('input', { bubbles: true }));
  box.focus();
  return true;
}

// Only consume drags originating from the file manager; native file-drop routing stays intact.
document.addEventListener('dragover', event => {
  if (event.dataTransfer?.types.includes('application/x-hub-files') && event.target.closest('.floating-input-box, #mr-input-box')) {
    event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = 'copy';
  }
}, true);
document.addEventListener('drop', event => {
  const incoming = event.dataTransfer?.getData('application/x-hub-files');
  const box = event.target.closest('.floating-input-box, #mr-input-box');
  if (!incoming || !box) return;
  event.preventDefault(); event.stopImmediatePropagation();
  try {
    const paths = JSON.parse(incoming);
    if (!Array.isArray(paths) || !paths.length || !paths.every(value => typeof value === 'string' && path.isAbsolute(value))) throw new Error('无效的文件路径');
    if (box.id === 'mr-input-box') window.MeetingRoom.appendFilePaths(paths);
    else addFilePathsToConversation(paths, box.closest('.floating-input-bar').dataset.sessionId);
  } catch (error) { chatgptBridgeController.showStatus(error.message, 'error'); }
}, true);

fileManagerPanel = createFileManagerPanel({
  document,
  window,
  ipcRenderer,
  getActiveContext: getActiveFileManagerContext,
  addToConversation: addFilePathsToConversation,
  listConversationTargets: () => [...document.querySelectorAll('.floating-input-bar')]
    .map(node => sessions.get(node.dataset.sessionId)).filter(session => session && !session.readOnly)
    .map(session => ({ id: session.id, label: session.title || session.id })),
  openPathInHub: (filePath, openOptions = {}) => openPathInHub(filePath, {
    cwd: getActivePreviewCwd(),
    requireExistsForRel: false,
    ...openOptions,
  }),
  onLayoutChange: refitActiveTerminalFromPreview,
});
fileManagerPanel.init();
window.FileManagerPanel = fileManagerPanel;

// main.js 的最后一道导航保护：若某个未接线/第三方生成的 file:// 链接试图替换 Hub
// 主页面，main 会阻止整页导航并把本地路径送回这里，仍按统一规则打开预览面板。
ipcRenderer.on('preview-local-file', (_event, filePath) => {
  openPathInHub(filePath, {
    cwd: getActivePreviewCwd(),
    requireExistsForRel: false,
  });
});

// 2026-05-23 maintainer：补全 main.js nav-guard 副作用 — 群聊/会议消息中 marked 渲染
//   出的 <a href="http(s)://..."> 若不在 capture 阶段截走，会触发主 webContents
//   will-navigate / setWindowOpenHandler，被 nav-guard 一律 shell.openExternal
//   弹到系统浏览器，绕过 in-app 预览。preview-body 内由 controller 自己处理，
//   rt-file-link 由 meeting-room.js 处理，其余 http(s) / 原始 file:// 链接统一走预览面板。
document.addEventListener('click', (e) => {
  const a = e.target && e.target.closest && e.target.closest('a[href]');
  if (!a) return;
  if (a.closest('#preview-body')) return;
  if (a.classList.contains('rt-file-link')) return;
  const href = a.getAttribute('href') || '';
  const isWebUrl = /^https?:\/\//i.test(href);
  const isLocalFileUrl = /^file:/i.test(href);
  if (!isWebUrl && !isLocalFileUrl) return;
  e.preventDefault();
  e.stopPropagation();
  if (isLocalFileUrl) {
    try {
      openPathInHub(fileURLToPath(href), {
        cwd: getActivePreviewCwd(),
        requireExistsForRel: false,
      });
    } catch (error) {
      console.warn('[hub] invalid local file link blocked:', href, error && error.message);
    }
    return;
  }
  openPreviewPanel(href, { preview: true });
}, true);

// --- Terminal buffer reading and activity monitor ---
function classifySessionRuntimeFrame(session, lines) {
  if (isNativeSession(session)) return { state: 'unknown', confidence: 'none', reason: 'native-only' };
  if (isClaudeRuntimeSession(session)) return classifyTerminalRuntime('claude', lines);
  if (session && isCodexKind(session.kind)) return classifyTerminalRuntime('codex', lines);
  return { state: 'unknown', confidence: 'none', reason: 'unsupported-runtime', evidence: '' };
}

function clearSessionConnectionIssue(sessionOrId, options = {}) {
  const session = typeof sessionOrId === 'string' ? sessions.get(sessionOrId) : sessionOrId;
  if (!session || !session.connectionIssue) return false;
  const issueMessage = String(session.connectionIssue.message || '');
  // 记下被清掉的那条签名。TUI（尤其 Codex）会把整屏反复重绘，同一段报错文本会
  // 一次次重新流过 PTY；不记签名的话，用户点进来清掉的下一帧就又被判成断连，
  // 「运行异常」永远下不去 —— 这正是 2026-08-28 用户反馈的现象。
  if (options.acknowledged !== false) markStreamDisconnectAcknowledged(session);
  session.connectionIssue = null;
  session._streamDisconnectTail = '';
  if (issueMessage && session.lastError === issueMessage) session.lastError = null;
  if (options.render !== false) {
    scheduleSessionListRender();
    schedulePersist();
  }
  return true;
}

// 用户点进会话 = 看过这条提醒了。与「等你响应」「已完成未读」同一套语义：
// 提醒只提醒一次，处理过就撤掉，除非它再次发生。
// 除了清 connectionIssue，还必须把 RUNTIME_FAILED 降下来 —— 它是终态，
// session-runtime-truth 的 terminal-state-resurrection 守卫会挡住后续的弱证据，
// 光清 connectionIssue 的话会话照样挂在「⚠ 运行异常」分区里。
function acknowledgeSessionFailureState(sessionOrId, options = {}) {
  const session = typeof sessionOrId === 'string' ? sessions.get(sessionOrId) : sessionOrId;
  if (!session) return false;
  let changed = clearSessionConnectionIssue(session, { render: false });
  if (getSessionRuntimeTruth(session).state === RUNTIME_FAILED) {
    const applied = observeSessionRuntime(session, {
      state: RUNTIME_IDLE,
      source: 'user-acknowledged-failure',
      // 用户亲眼看过，是这条时间线上最强的证据；低一档会被存量 FAILED 压住。
      confidence: CONFIDENCE_AUTHORITATIVE,
      observedAt: Date.now(),
      reason: 'user-opened-session-after-failure',
    });
    if (applied && applied.applied) changed = true;
  }
  if (changed && options.render !== false) {
    scheduleSessionListRender();
    schedulePersist();
  }
  return changed;
}

function raiseStreamDisconnectFailure(sessionId, issue, options = {}) {
  const session = sessions.get(sessionId);
  if (!isAiRuntimeSession(session) || session.status === 'dormant' || !issue) return false;
  const observedAt = Number(options.observedAt) || Date.now();
  issue = { ...issue, observedAt };
  if (!shouldRaiseStreamDisconnect(session, issue)) return false;

  session._connectionIssueAck = null;
  session.connectionIssue = {
    type: issue.type,
    message: issue.message,
    signature: issue.signature,
    observedAt,
    occurrenceId: issue.occurrenceId || null,
    turnId: issue.turnId || null,
  };
  session.lastError = issue.message;
  clearSessionAttention(session);
  const runStartedAt = Number(session.runStartedAt) || 0;
  if (runStartedAt > 0 && observedAt >= runStartedAt) {
    session.lastRunStartedAt = runStartedAt;
    session.lastRunDurationMs = observedAt - runStartedAt;
  }
  session.runStartedAt = null;
  if (isCodexKind(session.kind)) clearCodexCardWorking(sessionId);
  else {
    session._agentWorking = null;
    session._runSource = null;
    disarmPtyBurstFallback(session, observedAt);
  }
  observeSessionRuntime(session, {
    state: RUNTIME_FAILED,
    source: options.authoritative ? 'codex-task-complete-error' : 'pty-stream-disconnected',
    confidence: options.authoritative ? CONFIDENCE_AUTHORITATIVE : CONFIDENCE_STRONG,
    observedAt,
    startedAt: runStartedAt,
    completedAt: observedAt,
    turnId: issue.turnId || null,
    reason: 'network-stream-disconnected',
    evidence: issue.message,
  });
  _updateStreamingIndicator(sessionId);
  scheduleSessionListRender();
  schedulePersist();
  return true;
}

function noteStreamDisconnect(sessionId, data) {
  if (isNativeSession(sessions.get(sessionId))) return false;
  const session = sessions.get(sessionId);
  if (!isAiRuntimeSession(session) || session.status === 'dormant') return false;
  const tracked = appendStreamDisconnectChunk(session._streamDisconnectTail, data);
  session._streamDisconnectTail = tracked.tail;
  if (!tracked.issue) return false;
  return raiseStreamDisconnectFailure(sessionId, tracked.issue);
}

// PTY 跑的 Claude / Codex：这一轮是否已被 hook / transcript / rollout 权威地结束。
// 所有「凭终端画面写运行中」的入口都先问它：结束了的一轮，只能由 UserPromptSubmit、
// task_started 这类新的边界重新开启，屏幕上的旧帧（包括 Stop hook 运行时的状态行）不行。
function ptyTurnClosedAuthoritatively(session, truth = getSessionRuntimeTruth(session)) {
  return !!session && session.agentRuntime === 'pty' && !!truth
    && [RUNTIME_COMPLETED, RUNTIME_IDLE, 'interrupted', RUNTIME_FAILED].includes(truth.state)
    && truth.confidence === CONFIDENCE_AUTHORITATIVE;
}

// hook 子进程是各自独立完成的，到达顺序不保证：一轮已经关闭后，还可能收到它的
// PreToolUse / SubagentStart、提问工具的 PostToolUse、PermissionRequest。这些迟到事件
// 只能留作历史，不能把关闭的一轮重新打开（审查 R5：Codex Esc 中断 0.4s 后被迟到的
// tool-start 改回运行，60s 不收尾）。中断在 renderer 里记为权威 IDLE
// （codex-turn-aborted / claude 中断标记），会话刚建好时的空闲不是权威的，不算关闭。
// 新一轮一定先经过 UserPromptSubmit / 本地提交 / task_started，此后状态不再是关闭态。
function hookTurnClosed(session, truth = session ? getSessionRuntimeTruth(session) : null) {
  if (!session || !truth || sessionRuntimeIsActive(session)) return false;
  if ([RUNTIME_COMPLETED, RUNTIME_FAILED, 'interrupted'].includes(truth.state)) return true;
  return truth.state === RUNTIME_IDLE && truth.confidence === CONFIDENCE_AUTHORITATIVE;
}

// Stop 先于 transcript 终态到达、画面又确实在跑 Stop hook 时，运行状态暂时保留，
// 但必须有能结束它的真实证据（2026-09-25 审查：旧帧让会话 182 秒停在运行中）：
//   · transcript 终态到达 → 权威完成覆盖（不经过这里）；
//   · 画面不再有运行标记，连续两次确认 → 收尾；
//   · 运行标记还在，但那一行文字 30 秒没变 → 那是停住的旧帧（Claude 真在跑 hook 时
//     状态行的秒数每秒都在刷新），收尾。
// 不依赖用户切回这个会话，也不依赖终端再有新输出。
const CLAUDE_STOP_HOOK_RESOLVE_MS = 1000;
// 新一轮的边界：本地提交或 UserPromptSubmit。Stop hook 收尾检查只认挂起时的那一轮。
function notePtyTurnBoundary(session) {
  if (!session) return;
  session._ptyTurnSeq = (session._ptyTurnSeq || 0) + 1;
  session._claudeStopHookHold = null;
}
const CLAUDE_STOP_HOOK_STALE_FRAME_MS = 30 * 1000;
function scheduleClaudeStopHookResolution(sessionId, stopAt) {
  const session = sessions.get(sessionId);
  if (!session) return;
  if (session._claudeStopHookTimer) clearTimeout(session._claudeStopHookTimer);
  const hold = { stopAt, quietChecks: 0, turnSeq: session._ptyTurnSeq || 0 };
  session._claudeStopHookHold = hold;
  const tick = () => {
    const latest = sessions.get(sessionId);
    if (!latest || latest._claudeStopHookHold !== hold) return;
    latest._claudeStopHookTimer = null;
    const truth = getSessionRuntimeTruth(latest);
    // 已经不在运行、已由语义事件接管，或者 Stop 之后已经开始了新一轮：都不归这里管。
    if (latest.status === 'dormant' || ![RUNTIME_RUNNING, RUNTIME_STARTING].includes(truth.state)
        || !String(truth.source || '').startsWith('pty-')
        || (latest._ptyTurnSeq || 0) !== hold.turnSeq) {
      latest._claudeStopHookHold = null;
      return;
    }
    let frame = null;
    try { frame = classifySessionRuntimeFrame(latest, terminalActivityMonitor.extractLiveScreenLines(sessionId)); } catch {}
    const now = Date.now();
    let finished = null;
    if (frame && frame.state === 'running') {
      hold.quietChecks = 0;
      // 真在跑 hook 时，状态行里的秒数每秒都在变。同一行文字 30 秒纹丝不动，就是停住的
      // 旧帧。不看 _lastOutputTs：周期巡检每次重读同一帧都会把它刷新，旧帧就能无限续命。
      const evidence = String(frame.evidence || '');
      if (evidence !== hold.evidence) { hold.evidence = evidence; hold.evidenceSince = now; }
      if (now - (hold.evidenceSince || now) >= CLAUDE_STOP_HOOK_STALE_FRAME_MS) finished = 'claude-stop-hooks-stale-frame';
    } else {
      hold.quietChecks += 1;
      if (hold.quietChecks >= 2) finished = 'claude-stop-hooks-finished';
    }
    if (!finished) {
      latest._claudeStopHookTimer = setTimeout(tick, CLAUDE_STOP_HOOK_RESOLVE_MS);
      return;
    }
    latest._claudeStopHookHold = null;
    latest._agentWorking = null;
    latest._runSource = null;
    latest.runStartedAt = null;
    disarmPtyBurstFallback(latest, now);
    // Stop 本身就是这一轮的权威结束，这里只是补上当时被 Stop hook 推迟的那一步。
    observeSessionRuntime(latest, {
      state: RUNTIME_COMPLETED,
      source: finished,
      confidence: CONFIDENCE_AUTHORITATIVE,
      observedAt: now,
      completedAt: now,
      startedAt: latest.lastRunStartedAt || 0,
      evidence: frame && frame.evidence || null,
    });
    if (typeof _updateStreamingIndicator === 'function') _updateStreamingIndicator(sessionId);
    updateFloatingBarState();
    scheduleSessionListRender();
    schedulePersist();
  };
  session._claudeStopHookTimer = setTimeout(tick, CLAUDE_STOP_HOOK_RESOLVE_MS);
}

// What a PTY runtime observation can change that the sidebar (or anything it
// re-renders) displays. A running TUI repaints its status line several times a
// second; each repaint renews the truth's observedAt/expiresAt heartbeat but
// usually changes nothing visible. On the live Hub (2026-10-08) 41 of 50
// full sidebar rebuilds in 15 s were such heartbeats. The effective truth at
// `at` is included so a renewal of an expired observation still repaints.
function ptyObservationSidebarSignature(session, at) {
  const truth = session.runtimeTruth || {};
  const effective = getSessionRuntimeTruth(session, { now: at });
  return JSON.stringify([session.status, effective.state, effective.source, effective.confidence, effective.evidence,
    truth.state, truth.source, truth.confidence, truth.evidence, truth.reason, truth.turnId, truth.startedAt, truth.completedAt,
    (truth.corroborations || []).map(item => [item.source, item.state]),
    session.runStartedAt, session.lastRunStartedAt, session.lastRunDurationMs, session.lastCompletedAt, session.lastMessageTime,
    session.unreadCount, session.needsUserInput, session.replyReady, session.isWaiting, session.attentionState,
    session.waitingReason, session.waitingText, session.replyReadyText,
    session._agentWorking, session._runSource, session._ptyRuntimeState, session._ptyRuntimeReason, session._ptyRuntimeEvidence]);
}

function applyPtyRuntimeObservation(session, runtime, observedAt = Date.now()) {
  if (isNativeSession(session)) return false;
  if (!session || !runtime || session.status === 'dormant') return false;
  if (!isClaudeRuntimeSession(session) && !isCodexKind(session.kind)) return false;

  const at = Number(observedAt) || Date.now();
  const sidebarBefore = ptyObservationSidebarSignature(session, at);
  const truthBefore = getSessionRuntimeTruth(session, { now: at });
  // Codex keeps the composer visible while a task runs, and its fullscreen
  // history view can hide Working entirely. Input-ready pixels do not close a
  // native turn: task_complete / turn_aborted / failure own that transition.
  if (session.agentRuntime === 'pty' && isCodexKind(session.kind)
      && (runtime.state === 'idle' || (runtime.state === 'running'
        && truthBefore.state === RUNTIME_RUNNING && truthBefore.confidence === CONFIDENCE_AUTHORITATIVE))) {
    clearPtyInputReadyCandidate(session);
    return false;
  }
  const wasRunning = [RUNTIME_STARTING, RUNTIME_RUNNING].includes(truthBefore.state)
    || session.status === 'running';
  const fallbackArmed = canUsePtyBurstFallback(session, at);
  let changed = false;

  if (runtime.state === 'running' && ptyTurnClosedAuthoritatively(session, truthBefore)) {
    // PTY 跑的 Claude / Codex 有 hook 与 transcript 作为权威生命周期：一轮由它们判定结束后，
    // 屏幕上残留的旧状态行（Codex 内联界面的旧帧留在缓冲区里）不能把会话拽回「运行中」。
    // 新一轮必须由 UserPromptSubmit / task_started 这类新的边界开启（2026-09-25 真机：
    // 每次完成约一秒后都被 codex-interrupt-footer 改回运行）。
    clearPtyRunningAnimationCandidate(session);
    return false;
  }
  if (runtime.state === 'running') {
    // Do not let an idle TUI animation start a task from nothing. A local Enter
    // arms the PTY fallback, while hook/rollout lifecycle events set running
    // independently. The screen classifier upgrades either weak path once it
    // sees an actual provider running marker.
    // "esc to interrupt" / provider active rows are strong current-screen
    // evidence, not generic byte activity. They must be able to repair a
    // prematurely completed status even after the submit fallback was disarmed.
    const strongCurrentScreen = runtime.confidence === CONFIDENCE_STRONG;
    if (!wasRunning && !fallbackArmed && !strongCurrentScreen) {
      clearPtyRunningAnimationCandidate(session);
      return false;
    }
    // A failed turn can leave its last animated frame on screen. Do not erase
    // an authoritative error merely because that stale frame repainted; a new
    // prompt/task_started boundary will make `wasRunning` or `fallbackArmed`
    // true and legitimately allow the next turn through.
    if (truthBefore.state === RUNTIME_FAILED && !wasRunning && !fallbackArmed) {
      clearPtyRunningAnimationCandidate(session);
      return false;
    }
    if (!wasRunning && !fallbackArmed) {
      const animation = advanceRunningAnimationCandidate(
        session._ptyRunningAnimationCandidate,
        runtime,
        at,
      );
      session._ptyRunningAnimationCandidate = animation.candidate;
      if (!animation.confirmed) return false;
    } else {
      clearPtyRunningAnimationCandidate(session);
    }
    clearPtyInputReadyCandidate(session);
    session._ptyRuntimeSawRunning = true;
    if (session._ptyRuntimePendingTimer) {
      clearTimeout(session._ptyRuntimePendingTimer);
      session._ptyRuntimePendingTimer = null;
    }
    session._ptyRuntimeState = runtime.state;
    session._ptyRuntimeReason = runtime.reason || null;
    session._ptyRuntimeEvidence = runtime.evidence || null;
    session._ptyRuntimeObservedAt = at;
    if (!session.runStartedAt) {
      session.runStartedAt = at;
      changed = true;
    }
    if (!session._runSource || session._runSource === 'burst') {
      session._runSource = 'pty-semantic';
      changed = true;
    }
    if (!session._agentWorking) {
      session._agentWorking = 'pty';
      changed = true;
    }
    if (sessionNeedsUserInput(session)) clearSessionAttention(session);
    session._lastOutputTs = at;
    const transition = observeSessionRuntime(session, {
      state: RUNTIME_RUNNING,
      source: `pty-${runtime.reason || 'active-frame'}`,
      confidence: CONFIDENCE_STRONG,
      observedAt: at,
      startedAt: session.runStartedAt || at,
      evidence: runtime.evidence || null,
    });
    if (transition.applied) changed = true;
  } else if (runtime.state === 'idle' || runtime.state === 'waiting') {
    clearPtyRunningAnimationCandidate(session);
    // An input-ready frame is the missing-completion escape hatch. It does not
    // fabricate transcript text or unread counts; a delayed authoritative Stop
    // hook/task_complete can still enrich the card afterwards.
    if (!wasRunning) return false;
    if (runtime.state === 'idle'
        && Array.isArray(session._claudeBackgroundTasks)
        && session._claudeBackgroundTasks.length > 0) {
      return false;
    }
    if (runtime.state === 'idle' && !ptyInputReadyIsStable(session, runtime, at)) return false;
    if (runtime.state === 'waiting') clearPtyInputReadyCandidate(session);
    const runStartedAt = Number(session.runStartedAt) || Number(session._ptyFallbackArmedAt) || 0;
    if (runtime.state === 'idle'
        && !session._ptyRuntimeSawRunning
        && (!runStartedAt || at - runStartedAt < PTY_RUNTIME_SUBMIT_PENDING_MS)) {
      return false;
    }
    if (runStartedAt > 0 && at >= runStartedAt) {
      session.lastRunStartedAt = runStartedAt;
      session.lastRunDurationMs = at - runStartedAt;
    }
    session.runStartedAt = null;
    if (runtime.state === 'waiting') {
      // A live confirmation overlay is stronger than transcript silence: the
      // provider has stopped generating and is explicitly blocked on the user.
      // Keep this lightweight so a delayed authoritative Stop/task_complete can
      // still record the completed turn and unread notification exactly once.
      markSessionNeedsUserInput(session, {
        reason: runtime.reason || 'pty-interactive-confirmation',
        text: runtime.evidence || null,
      });
    } else if (sessionNeedsUserInput(session)) {
      clearSessionAttention(session);
    }
    if (isCodexKind(session.kind)) {
      clearCodexCardWorking(session.id);
    } else {
      session._agentWorking = null;
      session._runSource = null;
      disarmPtyBurstFallback(session, at);
    }
    const transition = observeSessionRuntime(session, {
      state: runtime.state === 'waiting' ? RUNTIME_WAITING : RUNTIME_COMPLETED,
      source: `pty-${runtime.reason || runtime.state}`,
      confidence: CONFIDENCE_STRONG,
      observedAt: at,
      startedAt: runStartedAt,
      completedAt: runtime.state === 'idle' ? at : 0,
      reason: runtime.reason || null,
      evidence: runtime.evidence || null,
    });
    if (transition.applied) changed = true;
  }

  if (!changed) return false;
  session._ptyRuntimeState = runtime.state;
  session._ptyRuntimeReason = runtime.reason || null;
  session._ptyRuntimeEvidence = runtime.evidence || null;
  session._ptyRuntimeObservedAt = at;
  if (typeof _updateStreamingIndicator === 'function') _updateStreamingIndicator(session.id);
  if (ptyObservationSidebarSignature(session, at) !== sidebarBefore) scheduleSessionListRender();
  schedulePersist();
  return true;
}

const terminalActivityMonitor = createTerminalActivityMonitor({
  sessions,
  terminalCache,
  getActiveSessionId: () => activeSessionId,
  // PTY output can update preview/running/idle several times in one burst.
  // Route those state changes through the same coalescer as semantic events so
  // a classification change never rebuilds the sidebar for every chunk.
  renderSessionList: scheduleSessionListRender,
  schedulePersist,
  updateStreamingIndicator: (sessionId) => {
    if (typeof _updateStreamingIndicator === 'function') _updateStreamingIndicator(sessionId);
  },
  hasSemanticCardWorking,
  // Only suppress PTY fallback while an authoritative semantic signal is
  // actually active. The old predicate returned true merely because the
  // session *kind* was Claude/Codex/Kimi. When settings.json lost the Hub
  // UserPromptSubmit hook, Claude could work for minutes while status stayed
  // idle because its PTY bytes were permanently ignored. The fallback below
  // remains available, but only after an explicit local prompt arms it.
  hasSemanticWorking: (s) => {
    if (!s) return false;
    const truth = getSessionRuntimeTruth(s);
    if (truth.state !== RUNTIME_RUNNING) return false;
    return (isClaudeRuntimeSession(s) && s._agentWorking === 'hook')
      || (isTranscriptCliKind(s.kind) && hasSemanticCardWorking(s))
      || (s._runSource === 'pty-semantic' && s._agentWorking === 'pty');
  },
  needsPtyBurstUpgrade: (s) => {
    const state = getSessionRuntimeTruth(s).state;
    return state === RUNTIME_STARTING || state === RUNTIME_UNKNOWN;
  },
  canUsePtyBurstFallback,
  onPtyBurstStarted: (session, observedAt) => {
    const previousTruth = getSessionRuntimeTruth(session, { now: observedAt });
    const semanticUpgrade = isTranscriptCliKind(session.kind)
      && (previousTruth.state === RUNTIME_STARTING || previousTruth.state === RUNTIME_UNKNOWN);
    const provider = String(session.kind || 'terminal').replace(/-resume$/i, '').toLowerCase();
    observeSessionRuntime(session, {
      state: RUNTIME_RUNNING,
      source: semanticUpgrade ? `${provider}-pty-output-after-submit` : 'pty-byte-burst',
      confidence: semanticUpgrade ? CONFIDENCE_SEMANTIC : CONFIDENCE_FALLBACK,
      observedAt,
      startedAt: session.runStartedAt || session._ptyFallbackArmedAt || observedAt,
      expiresAt: semanticUpgrade ? observedAt + _CODEX_CARD_WORK_MAX_MS : 0,
      evidence: `${session.kind || 'terminal'} PTY output burst`,
    });
  },
  onPtyBurstSettled: (session, settledAt) => {
    disarmPtyBurstFallback(session, settledAt);
    const currentTruth = getSessionRuntimeTruth(session, { now: settledAt });
    if (String(currentTruth.source || '').endsWith('-pty-output-after-submit')) {
      // Silence is not completion for transcript-backed agents. Keep the
      // semantic turn alive until task_complete/Stop, a strong input-ready
      // frame, or the long missing-completion expiry.
      session.status = 'running';
      return;
    }
    observeSessionRuntime(session, {
      state: RUNTIME_IDLE,
      source: 'pty-byte-quiet',
      confidence: CONFIDENCE_FALLBACK,
      observedAt: settledAt,
      reason: 'burst-silence-window',
    });
  },
  onSemanticWorkExpired: (session, observedAt) => {
    observeSessionRuntime(session, {
      state: RUNTIME_UNKNOWN,
      source: 'semantic-work-expired',
      confidence: CONFIDENCE_INFERRED,
      observedAt,
      reason: 'missing-authoritative-completion',
    });
  },
  classifyRuntimeState: classifySessionRuntimeFrame,
  onRuntimeState: applyPtyRuntimeObservation,
  canObserveRuntimeState: (session) => isClaudeRuntimeSession(session) || !!(session && isCodexKind(session.kind)),
});
const {
  getQuestionsSignature,
  readTerminalPreview,
  extractTailLines,
  isWaitingForUser,
  onTerminalOutput,
  clearSession: clearTerminalActivitySession,
} = terminalActivityMonitor;
// --- IPC event handlers ---
function writeTerminalChunk(sessionId, cached, data) {
  if (!cached || !data) return;
  const sess = sessions.get(sessionId);
  if (sess && isCodexKind(sess.kind)) {
    const pinAfterWrite = shouldAutoPinCodexTerminal(sessionId, cached);
    // Preserve native text and cursor visibility, including user text which
    // happens to match a historical placeholder. The CLI owns its TUI frames.
    cached.terminal.write(data);
    if (pinAfterWrite) scheduleCodexBottomPin(sessionId, cached);
  } else {
    cached.terminal.write(data);
  }
}

// Meeting-room used to switch an embedded xterm tab when an AI avatar was
// clicked. Embedded terminals were removed in v1.6.1, so expose the current
// architecture's equivalent: leave the meeting and open that child session in
// the main session surface. Keep the bridge explicit instead of relying on a
// top-level function accidentally becoming a Window property.
window.openMeetingMemberSession = function openMeetingMemberSession(sessionId) {
  if (!sessionId || !sessions.has(sessionId)) return false;
  void selectSession(sessionId, { forceScrollBottom: true });
  return true;
};

// This explicit shortcut inspects a live terminal without waking a dormant
// writer, dismissing its runtime failure or sending any input.
window.openMeetingMemberCli = async function openMeetingMemberCli(sessionId) {
  const session = sessions.get(sessionId);
  if (!session) return { ok: false, reason: '该成员会话暂不可用' };
  if (session.status === 'dormant') return { ok: false, reason: '该成员 CLI 已关闭；请从会话列表自行恢复后查看' };
  await selectSession(sessionId, { forceScrollBottom: true, inspectOnly: true, splitBypass: true });
  if (activeSessionId !== sessionId) return { ok: false, reason: '当前已切换到其他会话' };
  return { ok: true };
};

const XTERM_REPLAY_CHUNK_CHARS = 64 * 1024;

async function writeXtermAndWait(terminal, data) {
  if (!terminal || !data) return;
  const source = String(data);
  for (let start = 0; start < source.length;) {
    let end = Math.min(source.length, start + XTERM_REPLAY_CHUNK_CHARS);
    if (end < source.length) {
      const last = source.charCodeAt(end - 1);
      if (last >= 0xD800 && last <= 0xDBFF) end += 1;
    }
    await new Promise((resolve) => {
      try { terminal.write(source.slice(start, end), resolve); } catch { resolve(); }
    });
    start = end;
    // Snapshot hydration is recovery work, not a reason to block input/paint.
    // Yield between chunks while preserving the exact byte/order stream.
    if (start < source.length) await new Promise(resolve => setTimeout(resolve, 0));
  }
}

async function replayTerminalSnapshot(cached, snapshot) {
  if (!cached || !cached.terminal || !snapshot) return;
  const operations = Array.isArray(snapshot.operations) ? snapshot.operations : null;
  const snapshotText = typeof snapshot === 'object'
    ? String(snapshot.text || '')
    : (typeof snapshot === 'string' ? snapshot : '');

  if (!operations) {
    await writeXtermAndWait(cached.terminal, snapshotText);
    return;
  }

  // Structured snapshots preserve resize boundaries without making the main
  // process build a headless framebuffer for every opened/resumed session.
  // Start the serialized base at the geometry it was captured with, then apply
  // ordered writes/resizes. The normal fit pass below restores current UI size.
  const baseCols = Math.max(2, Number(snapshot.baseCols) || cached.terminal.cols);
  const baseRows = Math.max(1, Number(snapshot.baseRows) || cached.terminal.rows);
  try {
    if (cached.terminal.cols !== baseCols || cached.terminal.rows !== baseRows) {
      cached.terminal.resize(baseCols, baseRows);
    }
  } catch {}
  await writeXtermAndWait(cached.terminal, snapshotText);
  for (const operation of operations) {
    if (!operation || typeof operation !== 'object') continue;
    if (operation.type === 'resize') {
      const cols = Math.max(2, Number(operation.cols) || cached.terminal.cols);
      const rows = Math.max(1, Number(operation.rows) || cached.terminal.rows);
      try {
        if (cached.terminal.cols !== cols || cached.terminal.rows !== rows) {
          cached.terminal.resize(cols, rows);
        }
      } catch {}
    } else if (operation.type === 'write') {
      await writeXtermAndWait(cached.terminal, String(operation.data || ''));
    }
  }
}

async function hydrateTerminalFromSnapshot(sessionId, cached) {
  if (!cached || cached._hydrated || cached._hydrating) return;
  cached._hydrating = true;
  let snapshot = null;
  try {
    snapshot = await ipcRenderer.invoke('get-session-buffer-snapshot', sessionId);
  } catch (err) {
    console.warn('[terminal] snapshot hydrate failed:', err && err.message);
  }
  if (terminalCache.get(sessionId) !== cached) return;
  const snapshotSeq = snapshot && Number.isFinite(Number(snapshot.seq)) ? Number(snapshot.seq) : 0;
  await replayTerminalSnapshot(cached, snapshot);
  if (terminalCache.get(sessionId) !== cached) return;
  cached._hydratedSeq = snapshotSeq;

  // Keep live IPC output queued until the snapshot parser has really finished,
  // then drain until stable. Previously `_hydrated` flipped immediately after
  // terminal.write(), while xterm was still parsing a megabyte-scale snapshot;
  // fit/refresh ran against an empty buffer and some Canvas surfaces stayed
  // visually blank even though later data existed.
  while (cached._pendingOutput.length) {
    const pending = cached._pendingOutput.splice(0);
    cached._pendingOutputBytes = 0;
    for (const item of pending) {
      const itemSeq = Number(item.seq);
      if (Number.isFinite(itemSeq) && itemSeq <= cached._hydratedSeq) continue;
      const data = String(item.data || '');
      await writeXtermAndWait(cached.terminal, data);
      if (Number.isFinite(itemSeq)) cached._hydratedSeq = Math.max(cached._hydratedSeq, itemSeq);
      onTerminalOutput(sessionId, String(item.data || '').length);
      noteCardTerminalOutput(sessionId);
    }
  }
  cached._hydrated = true;
  cached._hydrating = false;
  // Snapshot replay reconstructs history, but the live CLI remains the
  // authority for its current full-screen frame. Force one final-size redraw
  // after the replay barrier. This also self-heals any partial ANSI frame that
  // was captured while a long Codex session was actively painting.
  cached._needsPtyRedraw = true;
  // showTerminal 里 hydrate 是 void 调用，紧跟其后的 rAF 会在快照还没回来时就
  // fitAndResizeTerminal —— 也就是说那次 fit 作用在一个空终端上，而真正的内容是之后
  // 才写进来的，此后再没有任何一次 fit/pin。内容量一变（尤其带绝对定位的 TUI 帧），
  // 布局就可能停在按空终端算出来的状态。回灌完成后补一次 fit + 置底。
  if (sessionId === activeSessionId
      && (currentView === 'pty' || cached.container.closest('.terminal-panel') !== terminalPanelEl)) {
    fitAndResizeTerminal(sessionId, cached, { force: true, forcePtyResize: true });
    cached._needsPtyRedraw = false;
    refreshTerminalRendererSurface(cached);
    const native = isNativeAgent(sessions.get(sessionId)) || isCodexKind(sessions.get(sessionId)?.kind);
    if (!native || shouldAutoPinCodexTerminal(sessionId, cached)) pinTerminalViewportToBottom(cached);
    requestAnimationFrame(() => {
      if (terminalCache.get(sessionId) !== cached) return;
      if (!cached.opened || !cached.container || !cached.container.offsetWidth) return;
      fitAndResizeTerminal(sessionId, cached, { force: true });
      refreshTerminalRendererSurface(cached);
      if (!native || shouldAutoPinCodexTerminal(sessionId, cached)) pinTerminalViewportToBottom(cached);
    });
  }
}

// Tool block folding 已废弃（2026-04-28）：之前 Claude session 的 ● tool 块下方
// 非 tool 行被改写成 "⋯ N lines" + xterm decoration 弹窗，长会话 buffer 滚动 +
// Codex/Gemini 路径不一致会渲染叠字错位。所有 kind 的 terminal-data 现在统一直写。

const CARD_STREAM_SETTLE_RETRY_MS = [1000, 2500, 6000];
const nativeLocalHealth = require('./hub-feedback-health').start({
  ping: () => ipcRenderer.invoke('hub:feedback-ping'),
  enabled: () => !document.hidden && [...sessions.values()].some(session => session.status !== 'dormant'
    && ['codex-app-server','claude-stream-json'].includes(session.runtimeBackend)
    && ['starting','running'].includes(session.nativeRuntime?.state)),
});
window.addEventListener('unload', () => nativeLocalHealth.dispose(), {once:true});

function cardSessionSupportsLiveRefresh(session) {
  if (!session) return false;
  return isNativeSession(session) || isClaudeFamily(session.kind) || isCodexKind(session.kind) || isKimiCliKind(session.kind);
}

function clearCardSettleRefresh(sessionId) {
  if (!window._cardStopFallbackBySid) return;
  const state = window._cardStopFallbackBySid.get(sessionId);
  if (state && state.timer) {
    try { clearTimeout(state.timer); } catch {}
  } else if (state) {
    // Compatibility with the previous single-timeout map shape.
    try { clearTimeout(state); } catch {}
  }
  window._cardStopFallbackBySid.delete(sessionId);
}

function clearCardLiveRefreshState(sessionId) {
  clearCardSettleRefresh(sessionId);
  if (!window._cardReloadState || !window._cardReloadState.has(sessionId)) return;
  const state = window._cardReloadState.get(sessionId);
  if (state && state.pendingTimer) {
    try { clearTimeout(state.pendingTimer); } catch {}
  }
  window._cardReloadState.delete(sessionId);
}

function requestCardIncrementalRefresh(sessionId, options = {}) {
  if (document.hidden || sessionId !== activeSessionId || currentView !== 'card'
      || typeof loadSessionHistoryToOverlay !== 'function') return false;
  const session = sessions.get(sessionId);
  if (!cardSessionSupportsLiveRefresh(session)) return false;

  if (!window._cardReloadState) window._cardReloadState = new Map();
  let state = window._cardReloadState.get(sessionId);
  if (!state) {
    state = {
      lastReloadAt: 0,
      pendingTimer: null,
      inProgress: false,
      queued: false,
      lastReason: null,
    };
    window._cardReloadState.set(sessionId, state);
  }
  state.lastReason = options.reason || 'terminal-output';

  if (state.inProgress) {
    state.queued = true;
    return true;
  }
  if (state.pendingTimer) {
    if (!options.force) return true;
    try { clearTimeout(state.pendingTimer); } catch {}
    state.pendingTimer = null;
  }

  const delay = require('./native-card-refresh').refreshDelay(session, state, Date.now(), options.force);
  state.pendingTimer = setTimeout(() => {
    state.pendingTimer = null;
    if (document.hidden || sessionId !== activeSessionId || currentView !== 'card') return;
    if (!cardSessionSupportsLiveRefresh(sessions.get(sessionId))) return;
    if (state.inProgress) {
      state.queued = true;
      return;
    }
    state.inProgress = true;
    state.lastReloadAt = Date.now();
    const refreshStarted = performance.now();
    const refreshOptions = {
      incremental: true,
      parseOpts: isNativeSession(sessions.get(sessionId))
        ? { limit: Infinity, latestTurn: true, turnId: sessions.get(sessionId)?.nativeRuntime?.turnId }
        : { limit: 1, fromTail: true },
    };
    if (sessions.get(sessionId)?.runtimeBackend === 'claude-stream-json') refreshOptions.parseOpts = { nativeLive: true };
    loadSessionHistoryToOverlay(sessionId, refreshOptions)
      .catch(error => console.warn('[card live-refresh:' + state.lastReason + '] failed:', error))
      .finally(() => {
        state.lastDurationMs = performance.now() - refreshStarted;
        state.inProgress = false;
        if (!state.queued) return;
        state.queued = false;
        requestCardIncrementalRefresh(sessionId, {
          reason: 'queued-after-inflight',
        });
      });
  }, delay);
  return true;
}

function scheduleCardSettleRefresh(sessionId) {
  clearCardSettleRefresh(sessionId);
  if (sessionId !== activeSessionId || currentView !== 'card'
      || !cardSessionSupportsLiveRefresh(sessions.get(sessionId))) return false;
  if (!window._cardStopFallbackBySid) window._cardStopFallbackBySid = new Map();

  const state = { index: 0, timer: null };
  const scheduleNext = () => {
    const index = state.index;
    const previousDelay = index > 0 ? CARD_STREAM_SETTLE_RETRY_MS[index - 1] : 0;
    const delay = CARD_STREAM_SETTLE_RETRY_MS[index] - previousDelay;
    state.timer = setTimeout(() => {
      if (window._cardStopFallbackBySid.get(sessionId) !== state) return;
      if (!requestCardIncrementalRefresh(sessionId, {
        force: true,
        reason: 'stream-settle-' + CARD_STREAM_SETTLE_RETRY_MS[index] + 'ms',
      })) {
        window._cardStopFallbackBySid.delete(sessionId);
        return;
      }
      state.index += 1;
      if (state.index >= CARD_STREAM_SETTLE_RETRY_MS.length) {
        window._cardStopFallbackBySid.delete(sessionId);
        return;
      }
      scheduleNext();
    }, delay);
  };
  window._cardStopFallbackBySid.set(sessionId, state);
  scheduleNext();
  return true;
}

function noteCardTerminalOutput(sessionId) {
  if(isNativeAgent(sessions.get(sessionId)))return false;
  if (!requestCardIncrementalRefresh(sessionId, { reason: 'terminal-output' })) return false;
  if (isNativeSession(sessions.get(sessionId))) return true;
  scheduleCardSettleRefresh(sessionId);
  return true;
}

document.addEventListener('visibilitychange', () => {
  if (!document.hidden && activeSessionId) requestCardIncrementalRefresh(activeSessionId, { force: true, reason: 'visible-again' });
});

ipcRenderer.on('codex-content-updated', (_e, event) => {
  const {sessionId} = event;
  recordNativeContent(sessions.get(sessionId), event);
  requestCardIncrementalRefresh(sessionId,{reason:'app-server-item'});
});

ipcRenderer.on('codex-backstage-updated', (_event, event) => {
  terminalCache.get(event.sessionId)?._codexBackstage?.notify(event);
});
ipcRenderer.on('terminal-data', (_e, { sessionId, data, seq }) => {
  noteStreamDisconnect(sessionId, data);
  const cached = terminalCache.get(sessionId);
  if (!cached) return;
  if (!cached._hydrated) {
    const item = { data: String(data || ''), seq };
    cached._pendingOutput.push(item);
    cached._pendingOutputBytes += item.data.length;
    while (cached._pendingOutputBytes > MAX_PENDING_TERMINAL_BYTES && cached._pendingOutput.length > 1) {
      const dropped = cached._pendingOutput.shift();
      cached._pendingOutputBytes -= dropped.data.length;
    }
    return;
  }
  const numericSeq = Number(seq);
  if (Number.isFinite(numericSeq) && numericSeq <= cached._hydratedSeq) return;
  if (Number.isFinite(numericSeq)) cached._hydratedSeq = numericSeq;
  writeTerminalChunk(sessionId, cached, data);
  onTerminalOutput(sessionId, data.length);
  // PTY output is only a wake-up signal. The refresh parses the bounded
  // transcript tail off the renderer thread, so card mode stays live without
  // duplicating ANSI/TUI text. One leading refresh plus three finite settle
  // retries cover late transcript writeback without permanent polling.
  noteCardTerminalOutput(sessionId);
});

// Status updates from our custom statusline script.
// Carries contextPct / cwd / api time / session_name per session + account-wide usage5h/usage7d.
const providerModes = {
  claude: 'subscription',
  gemini: 'subscription',
  codex: 'subscription',
  kimi: 'subscription',
  deepseek: 'api',
};
const accountUsageController = createAccountUsageController({
  document,
  ipcRenderer,
  sessions,
  escapeHtml,
  isMemoOpen: () => memoPanel.isOpen(),
});
const renderAccountUsage = accountUsageController.render;
// 欢迎页只提供创建入口；项目数据按需由现有创建面板加载。
homeWorkbench = createHomeWorkbench({
  document,
  onCreate: intent => launchCenter.open(intent),
});
homeWorkbench.render();
// 记忆页由左侧第六个功能按钮打开，当前上下文跟随当前聚焦的 session。
const memoryPanel = createMemoryPanel({
  document,
  ipcRenderer,
  escapeHtml,
  openSession: (id) => selectSession(id, { forceScrollBottom: true }),
  getActiveSessionInfo: () => {
    if (window.MeetingRoom?.getActiveMeetingId()) return null;
    const s = sessions.get(getFocusedSessionId());
    return s ? {
      id: s.id,
      cwd: s.cwd,
      kind: s.kind,
      runtimeKind: s.transcriptKind || s.kind,
      title: s.title,
      codexSessionsRoot: s.codexSessionsRoot || null,
      codexProfile: s.codexProfile || null,
      meetingId: s.meetingId || null,
    } : null;
  },
});
const capabilityPanel = createCapabilityPanel({document,ipcRenderer,escapeHtml,
  getActiveSessionId:()=>getFocusedSessionId()});
function pctClass(pct) { return accountUsageController.pctClass(pct); }
if (typeof window !== 'undefined') window.pctClass = pctClass;

ipcRenderer.on('session-usage-updated', (_e, { sessionId, usage }) => {
  const session = sessions.get(sessionId);
  if (!session) return;
  session.sessionUsage = usage;
  scheduleSessionListRender();
  schedulePersist();
});

ipcRenderer.on('status-event', (_e, payload) => {
  const session = sessions.get(payload.sessionId);
  if (session) {
    let persistModel = false;
    if (Object.prototype.hasOwnProperty.call(payload, 'contextPct')) session.contextPct = payload.contextPct;
    if (Object.prototype.hasOwnProperty.call(payload, 'contextUsed')) session.contextUsed = payload.contextUsed;
    if (Object.prototype.hasOwnProperty.call(payload, 'contextMax')) session.contextMax = payload.contextMax;
    if (Object.prototype.hasOwnProperty.call(payload, 'contextEffectiveMax')) {
      session.contextEffectiveMax = payload.contextEffectiveMax;
    }
    if (Object.prototype.hasOwnProperty.call(payload, 'contextEffectiveObservedAt')) {
      session.contextEffectiveObservedAt = payload.contextEffectiveObservedAt;
    }
    if (typeof payload.contextUsed === 'number') {
      accountUsageController.recordSessionContextSample(session, payload.contextUsed);
    }
    // cwd is write-once: only record it if we don't have one yet. Statusline
    // fires repeatedly and the user's `cd` during the session would otherwise
    // corrupt the saved cwd, breaking future `claude --resume` (CC scopes
    // resume to the transcript's original project slug = original cwd).
    if (payload.cwd && !session.cwd) session.cwd = payload.cwd;
    if (typeof payload.apiMs === 'number') session.apiMs = payload.apiMs;
    if (typeof payload.linesAdded === 'number') session.linesAdded = payload.linesAdded;
    if (typeof payload.linesRemoved === 'number') session.linesRemoved = payload.linesRemoved;
    if (payload.model && payload.model.id) {
      const baseKind = String(session.kind || '').replace(/-resume$/i, '').toLowerCase();
      const allowed = baseKind === 'codex'
        ? isCodexConversationModelId(payload.model.id)
        : baseKind === 'deepseek'
          ? /^deepseek-v4-(?:pro|flash)$/i.test(String(payload.model.id))
          : true;
      if (allowed) {
        const previousModelId = session.currentModel && session.currentModel.id;
        session.currentModel = payload.model;
        persistModel = previousModelId !== payload.model.id;
        if (payload.sessionId === activeSessionId) updateActiveModelChip();
      }
    }
    // Claude → Hub title sync: only overlay if user hasn't explicitly renamed in Hub.
    // The /rename we inject comes back via this same field — the guard below prevents loops.
    // Meeting room subs keep their default "Claude N" name — auto-rename produces
    // long titles that clutter the narrow tab headers.
    const cleanSessionName = typeof payload.sessionName === 'string' ? payload.sessionName.trim() : '';
    if (shouldAcceptExternalSessionTitle(session, cleanSessionName) && session.title !== cleanSessionName) {
      session.title = cleanSessionName;
      session.claudeSessionName = cleanSessionName;
      if (payload.sessionId === activeSessionId) {
        const el = toolbarCrumbEl && toolbarCrumbEl.querySelector('.terminal-title');
        if (el) el.textContent = cleanSessionName;
      }
    }
    if (payload.sessionId === activeSessionId) updateActiveMetricsRow();
    if (typeof MeetingRoom !== 'undefined' && MeetingRoom.refreshSessionMetrics) {
      MeetingRoom.refreshSessionMetrics(payload.sessionId);
    }
    if (persistModel) schedulePersist();
  }
  accountUsageController.recordStatusUsage(payload);
  scheduleSessionListRender();
});

ipcRenderer.on('agent-usage', (_e, totals) => {
  accountUsageController.recordAgentUsage(totals);
  if (homeWorkbench) homeWorkbench.render();
});

// Compact "3m20s" / "1h5m" — used for api duration in the header metrics row.
function formatDuration(ms) {
  if (typeof ms !== 'number' || !isFinite(ms) || ms < 0) return '';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${s % 60 ? (s % 60) + 's' : ''}`;
  const h = Math.floor(m / 60);
  return `${h}h${m % 60 ? (m % 60) + 'm' : ''}`;
}

// "128k" / "4.2k" / "860" — 覆盖层要在 10px 字号里放得下，所以 token 数走紧凑写法。
function formatTokenCount(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return '';
  if (n < 1000) return String(Math.round(n));
  const k = n / 1000;
  return `${k >= 10 ? Math.round(k) : k.toFixed(1)}k`;
}

// T2：终端卡右上角的实时量覆盖层 —— ctx% · N tok · ⏱ Ns。
// 工作目录不在这里了（它是面包屑的第一段），模型名也不在（T1 已经进 composer）。
// 这一层只放「随着这一轮跑动而变的数」，卡片视图与 PTY 视图都显示。
function renderMetricsRow(el, session) {
  if (!el || !session) return;
  const parts = [];
  const titleParts = [];
  // 会话刚起来、或者 CLI 状态栏还没被读到时，contextPct 是 null（不是 0）。
  // Number(null) === 0 且 Number.isFinite(0) 为真 —— 只写 Number() 就会把
  // 「还不知道」显示成一个确定的 ctx 0%。那比不显示更糟：用户会据此以为
  // 上下文还空着，然后往里灌一个其实塞不下的大 prompt。不知道就别说。
  const rawPct = typeof session.contextPct === 'number' ? session.contextPct : NaN;
  if (Number.isFinite(rawPct)) {
    const pct = Math.max(0, Math.min(100, Math.round(rawPct)));
    parts.push(`ctx ${pct}%`);
    titleParts.push(`上下文已用 ${pct}%`);
  }
  const tokens = formatTokenCount(session.contextUsed);
  if (tokens) {
    parts.push(`${tokens} tok`);
    titleParts.push(`约 ${Number(session.contextUsed).toLocaleString()} tokens`);
  }
  if (typeof session.apiMs === 'number' && session.apiMs > 0) {
    parts.push('⏱ ' + formatDuration(session.apiMs));
    titleParts.push('AI 实际工作总时长');
  }
  const text = parts.join(' · ');
  if (el.textContent !== text) el.textContent = text;
  const title = titleParts.join('，');
  if (el.title !== title) el.title = title;
  el.hidden = !text;
}

function updateActiveMetricsRow() {
  const session = activeSessionId ? sessions.get(activeSessionId) : null;
  if (!session) return;
  const row = terminalPanelEl.querySelector('.terminal-metrics');
  if (row) renderMetricsRow(row, session);
}

// 面包屑的工作区段：标签 + 归档提示 + 点击打开文件面板（与「文件」按钮同一条逻辑）。
// 归档提示原来挂在 header 的 📁 路径 chip 上，那条 chip T2 删了；不搬过来的话，
// 独立会话的归档建议又会退回成「进了没人读的 Map」。
const CRUMB_ARCHIVE_HINT_TITLE = '这个任务还在临时区 · 点击归档到正式项目目录';

function openSessionFilePanel(session) {
  if (!session || !fileManagerPanel) return;
  void fileManagerPanel.toggle({ cwd: session.cwd, label: session.workspaceLabel, sessionStartedAt: Number(session.spawnedAt) || 0 });
}

function crumbWorkspaceLabel(session) {
  const explicit = String(session && session.workspaceLabel || '').trim();
  if (explicit) return explicit;
  const cwd = String(session && session.cwd || '').trim();
  if (!cwd) return '未设目录';
  const tail = cwd.split(/[\\/]/).filter(Boolean).pop();
  return tail || cwd;
}

function paintCrumbWorkspace(btn, session) {
  if (!btn || !session) return;
  const label = crumbWorkspaceLabel(session);
  if (btn.textContent !== label) btn.textContent = label;
  btn.dataset.root = session.cwd || '';
  btn.disabled = !session.cwd;
  const idleTitle = session.cwd ? `文件管理 · ${session.cwd}` : '当前会话没有工作目录';
  const controller = window.WorkspaceController;
  const hasHint = !!(controller
    && typeof controller.hasArchiveSuggestion === 'function'
    && controller.hasArchiveSuggestion('session', session.id));
  btn.classList.toggle('has-archive-hint', hasHint);
  btn.title = hasHint ? CRUMB_ARCHIVE_HINT_TITLE : idleTitle;
  // attachArchiveHint 每次调用都会再挂一个 click 监听，所以只在按钮新建时绑一次，
  // 之后的重画只更新提示态。按钮随 showTerminal 重建，一个按钮只服务一个会话。
  if (btn._crumbBound) return;
  btn._crumbBound = true;
  const attached = !!(controller
    && typeof controller.attachArchiveHint === 'function'
    && controller.attachArchiveHint(btn, 'session', session.id, {
      hintTitle: CRUMB_ARCHIVE_HINT_TITLE,
      idleTitle,
      onFallback: () => openSessionFilePanel(session),
    }));
  if (!attached) btn.addEventListener('click', () => openSessionFilePanel(session));
}

function updateActiveCrumbWorkspace() {
  const session = activeSessionId ? sessions.get(activeSessionId) : null;
  if (!session || !terminalPanelEl) return;
  const btn = toolbarCrumbEl && toolbarCrumbEl.querySelector('.crumb-workspace');
  if (btn) paintCrumbWorkspace(btn, session);
}

// 归档建议到达时立刻重画面包屑的工作区段，否则要等下一个 status-event
// 才看得见提示态。和 AI 群聊那侧的监听对称（meeting-room.js 只处理 meeting scope）。
// 只重画，不弹任何东西——是否归档由用户点它决定。
window.addEventListener('workspace-archive-suggestion', (event) => {
  const detail = event && event.detail;
  if (!detail || detail.scope !== 'session') return;
  if (!activeSessionId || detail.id !== activeSessionId) return;
  updateActiveCrumbWorkspace();
});

function _latestAssistantCardForSession(sessionId) {
  const cards = Array.from(document.querySelectorAll(
    `#msg-overlay > .turn-card[data-session-id="${CSS.escape(String(sessionId || ''))}"]:not(.user)`,
  )).filter(card => {
    const turn = window._sessionTurns && window._sessionTurns.get(card.dataset.turnId);
    return turn && !isTurnComplete(turn);
  });
  return cards.length ? cards[cards.length - 1] : null;
}

function _upsertLiveHookActivity(session, payload) {
  if (!session || !payload) return null;
  const event = String(payload.event || '');
  const isTool = event === 'tool-start' || event === 'tool-complete' || event === 'tool-failed';
  const isSubagent = event === 'subagent-start' || event === 'subagent-stop';
  const isTask = event === 'task-start' || event === 'task-complete';
  if (!isTool && !isSubagent && !isTask) return null;
  const status = event.endsWith('-failed') ? 'failed'
    : event.endsWith('-complete') || event.endsWith('-stop') ? 'completed'
      : 'running';
  const id = String(
    payload.toolCallId
    || payload.agentId
    || payload.taskId
    || `${event}:${payload.toolName || payload.agentType || payload.taskSubject || Date.now()}`,
  );
  const name = isSubagent
    ? `Subagent${payload.agentType ? ` · ${payload.agentType}` : ''}`
    : isTask
      ? 'Task'
      : (payload.toolName || 'Tool');
  const input = isSubagent || isTask
    ? { description: payload.taskSubject || payload.agentType || name }
    : (payload.toolInput ?? {});
  const activity = {
    id,
    callId: payload.toolCallId || null,
    name,
    input,
    status,
    ...(status === 'running' ? { startedAt: Number(payload.eventAt) || Date.now() } : {
      completedAt: Number(payload.eventAt) || Date.now(),
      result: String(payload.toolResult || payload.errorDetails || payload.error || ''),
      isError: status === 'failed',
    }),
    turnId: payload.turnId || null,
    source: `claude-hook-${event}`,
  };
  if (!Array.isArray(session.liveToolActivities)) session.liveToolActivities = [];
  let index = session.liveToolActivities.findIndex(item => item && item.id === id);
  if (index < 0 && status !== 'running') {
    for (let i = session.liveToolActivities.length - 1; i >= 0; i--) {
      const candidate = session.liveToolActivities[i];
      if (candidate && candidate.status === 'running' && candidate.name === name) { index = i; break; }
    }
  }
  if (index >= 0) {
    const previous = session.liveToolActivities[index];
    if (status === 'running' && ['completed', 'failed', 'cancelled'].includes(previous.status)) {
      // Async observer hooks may finish out of order. Once the matching call is
      // terminal, a delayed start record can enrich nothing and must not regress it.
      return normalizeToolActivity(previous);
    }
    const hasFreshInput = typeof activity.input === 'string'
      ? activity.input.trim().length > 0
      : activity.input && typeof activity.input === 'object' && Object.keys(activity.input).length > 0;
    const inferredDuration = status !== 'running' && previous.startedAt && activity.completedAt
      ? Math.max(0, activity.completedAt - previous.startedAt)
      : null;
    session.liveToolActivities[index] = {
      ...previous,
      ...activity,
      id: previous.id || activity.id,
      input: hasFreshInput ? activity.input : previous.input,
      durationMs: activity.durationMs ?? previous.durationMs ?? inferredDuration,
    };
  } else {
    session.liveToolActivities.push(activity);
    session.liveToolActivities = session.liveToolActivities.slice(-24);
  }

  const card = _latestAssistantCardForSession(session.id);
  if (card && card.dataset.turnId) {
    session.livePresentationCardId = card.dataset.turnId;
    rerenderTurn(card.dataset.turnId);
  }
  const stored = session.liveToolActivities[index >= 0 ? index : session.liveToolActivities.length - 1];
  const normalized = normalizeToolActivity(stored);
  if (status === 'running') {
    session.currentCardActivity = {
      turnId: payload.turnId || null,
      activityId: normalized.id,
      status: normalized.status,
      label: [normalized.title, normalized.detail].filter(Boolean).join('：'),
      observedAt: Number(payload.eventAt) || Date.now(),
    };
  } else {
    const stillRunning = [...session.liveToolActivities].reverse().find(item => item && item.status === 'running');
    const next = stillRunning ? normalizeToolActivity(stillRunning) : normalized;
    session.currentCardActivity = {
      turnId: payload.turnId || null,
      activityId: next.id,
      status: next.status,
      label: stillRunning
        ? [next.title, next.detail].filter(Boolean).join('：')
        : `刚完成：${[next.title, next.detail].filter(Boolean).join('：')}`,
      observedAt: Number(payload.eventAt) || Date.now(),
    };
  }
  return normalized;
}

// Claude Code hooks drive the session state.
// - 'prompt' (UserPromptSubmit): fires the moment user presses Enter.
//   Immediately flag the session as running — faster & more precise than
//   the 200-byte PTY heuristic.
// - 'stop' (Stop): fires when the agent loop finishes. Triggers unread/time bump.
ipcRenderer.on('hook-event', (_e, payload = {}) => {
  const {
    event,
    eventAt,
    sessionId,
    claudeSessionId,
    cwd,
    latestUserMessage,
    backgroundTasks,
    injectedContinuation,
    sessionCrons,
    error,
    errorDetails,
    lastAssistantMessage,
    notificationType,
    message,
    title,
    toolName,
    toolCallId,
    turnId,
    toolInput,
    toolResult,
    agentId,
    agentType,
    taskId,
    taskSubject,
  } = payload;
  const s = sessions.get(sessionId);
  let hookIdentityConflict = false;
  if (s) {
    const boundClaudeSessionId = String(s.ccSessionId || '');
    const incomingClaudeSessionId = String(claudeSessionId || '');
    let initialCwdMismatch = false;
    if (!boundClaudeSessionId && cwd && s.cwd) {
      try { initialCwdMismatch = path.resolve(cwd).toLowerCase() !== path.resolve(s.cwd).toLowerCase(); }
      catch {}
    }
    hookIdentityConflict = (boundClaudeSessionId && incomingClaudeSessionId
      && boundClaudeSessionId !== incomingClaudeSessionId) || initialCwdMismatch;
  }
  if (hookIdentityConflict) return;
  if (s) {
    // Persist CC session id + cwd the first time we learn them so resumes work.
    if (!agentId && claudeSessionId && s.ccSessionId !== claudeSessionId) {
      s.ccSessionId = claudeSessionId;
      const collapsed = collapseDormantNativeDuplicates(sessions);
      if (collapsed.length) scheduleSessionListRender();
      schedulePersist();
    }
    // Only capture cwd ONCE (first hook). Updating on every hook lets a later
    // user `cd` mutate the saved value, which then breaks `claude --resume` on
    // next launch — CC stores transcripts under a project slug derived from
    // the cwd at CREATE time, so resume must spawn in that same cwd.
    if (!agentId && cwd && !s.cwd) {
      s.cwd = cwd;
      schedulePersist();
    }
    // Authoritative preview: CC's own transcript JSONL. Wins over any regex
    // extraction from the xterm buffer — no more "assistant content misread
    // as user question" false positives.
    if (!agentId && latestUserMessage) {
      const preview = buildPreviewFromUserMessage(latestUserMessage);
      if (preview && preview !== s.lastOutputPreview) {
        s.lastOutputPreview = preview;
        s._previewFromTranscript = true;
        // Sync lastMessageTime with the preview change. Previously time only
        // updated on Stop (via onReplyCompleteFromHook), so if Stop missed or
        // only UserPromptSubmit fired, the sidebar showed fresh text next to a
        // stale timestamp. Keep text and time in lockstep — a preview change
        // IS a message event regardless of event type.
        s.lastMessageTime = Date.now();
        scheduleSessionListRender();
        schedulePersist();
      }
    }
  }
  if (event === 'stop') {
    const outcome = onReplyCompleteFromHook(sessionId, eventAt, {
      backgroundTasks,
      sessionCrons,
      lastAssistantMessage,
    });
    if (outcome?.completed) flushRenameToClaude(sessionId);
    // A new turn landed — ask minimap to rescan for any new prompt ticks.
    const cached = terminalCache.get(sessionId);
    if (cached && cached._minimap) cached._minimap.invalidate();
  }
  else if (['tool-start', 'tool-complete', 'tool-failed', 'subagent-start', 'subagent-stop', 'task-start', 'task-complete'].includes(event)) {
    const truthBeforeActivity = s ? getSessionRuntimeTruth(s) : null;
    const turnClosed = hookTurnClosed(s, truthBeforeActivity);
    const isLateStartAfterTerminal = event.endsWith('-start') && turnClosed;
    // Hook subprocesses can finish out of order. A late PreToolUse/SubagentStart
    // from the closed turn must not resurrect an already completed/failed card;
    // the next real turn is armed by UserPromptSubmit before its tools run.
    const activity = isLateStartAfterTerminal ? null : _upsertLiveHookActivity(s, {
      event, eventAt, toolName, toolCallId, turnId, toolInput, toolResult,
      error, errorDetails, agentId, agentType, taskId, taskSubject,
    });
    const questionText = event === 'tool-start' && !isLateStartAfterTerminal ? ptyToolQuestionText(toolName, toolInput) : '';
    if (questionText) {
      // 提问类工具一开始就是在等人：PTY 会话没有结构化请求，只能靠 PreToolUse 知道。
      onClaudeNeedsInput(sessionId, eventAt, { reason: 'pty-ask-user', text: questionText });
    } else if (s && event === 'tool-complete' && isPtyQuestionTool(toolName) && !turnClosed) {
      // 用户已在终端里答完，CLI 继续往下跑。
      clearSessionWaitingState(sessionId);
      observeSessionRuntime(s, { state: RUNTIME_RUNNING, source: 'pty-question-answered',
        confidence: CONFIDENCE_AUTHORITATIVE, observedAt: eventAt, turnId, evidence: null });
    } else if (activity && event.endsWith('-start') && activity.status === 'running') {
      observeSessionRuntime(s, {
        state: RUNTIME_RUNNING,
        source: `${payload.provider === 'codex' ? 'codex' : 'claude'}-${event}`,
        confidence: CONFIDENCE_AUTHORITATIVE,
        observedAt: eventAt,
        turnId,
        evidence: [activity.title, activity.detail].filter(Boolean).join('：'),
      });
    }
    updateFloatingBarState();
    scheduleSessionListRender();
  }
  else if (event === 'prompt') onPromptSubmittedFromHook(sessionId, eventAt, { provider: payload.provider, turnId, injected: injectedContinuation === true });
  else if (event === 'stop-failure') onClaudeStopFailure(sessionId, eventAt, {
    error,
    errorDetails,
    lastAssistantMessage,
  });
  else if (event === 'permission-request' && !hookTurnClosed(s)) onClaudeNeedsInput(sessionId, eventAt, {
    reason: 'claude-permission-request',
    text: ptyPermissionEvidence(s, toolName, toolInput)
      || (payload.provider === 'codex' ? 'Codex 等待权限确认' : 'Claude Code 等待权限确认'),
  });
  else if (event === 'notification') onClaudeNotification(sessionId, eventAt, {
    notificationType,
    message,
    title,
  });
});

// Claude AskUserQuestion / ExitPlanMode、Codex request_user_input：工具一开始就在等人。
const PTY_QUESTION_TOOLS = new Set(['AskUserQuestion', 'ExitPlanMode', 'request_user_input']);
function isPtyQuestionTool(toolName) {
  return PTY_QUESTION_TOOLS.has(String(toolName || ''));
}
function ptyToolQuestionText(toolName, toolInput) {
  if (!isPtyQuestionTool(toolName)) return '';
  let input = toolInput;
  if (typeof input === 'string') { try { input = JSON.parse(input); } catch { input = null; } }
  if (toolName === 'ExitPlanMode') {
    const plan = String(input && input.plan || '').trim();
    return '确认计划后继续' + (plan ? '：\n' + (plan.length > 600 ? plan.slice(0, 598) + '…' : plan) : '');
  }
  const questions = Array.isArray(input && input.questions) ? input.questions : [];
  const lines = questions.map(question => {
    const options = (Array.isArray(question && question.options) ? question.options : [])
      .map(option => option && (option.label || option)).filter(value => typeof value === 'string' && value);
    return [question && (question.question || question.header) || '', options.length ? '选项：' + options.join(' / ') : '']
      .filter(Boolean).join('\n');
  }).filter(Boolean);
  return lines.join('\n\n') || '请在终端回答问题';
}

// renderer 里有 14 处调用 showToast，却一直没有定义（调用即 ReferenceError，
// 之前只在少见的原生分支里，没人撞上）。复用群聊分叉已有的轻提示。
function showToast(message, level) {
  require('./groupchat-fork-ui.js').showForkToast(document, String(message || ''), level === 'error' ? 'error' : 'info');
}

// PermissionRequest 不带工具参数（hook 边界的既有约定）；同一次调用的 PreToolUse
// 刚刚把有界参数带了过来，从那条运行中的活动里取「批的是什么」。
function ptyPermissionEvidence(session, toolName, toolInput) {
  const pending = session && Array.isArray(session.liveToolActivities)
    ? [...session.liveToolActivities].reverse().find(item => item && item.status === 'running' && item.name === toolName) : null;
  const input = toolInput ?? (pending ? pending.input : null);
  return ptyToolQuestionText(toolName, input) || ptyPermissionText(toolName, input);
}

// 授权提示带上具体要做的事：命令、文件或地址，用户不用切到终端就知道在批什么。
function ptyPermissionText(toolName, toolInput) {
  if (!toolName) return '';
  let input = toolInput;
  if (typeof input === 'string') { try { input = JSON.parse(input); } catch { input = { command: input }; } }
  const target = input && (input.command || input.cmd || input.file_path || input.path || input.url || input.pattern);
  const detail = Array.isArray(target) ? target.join(' ') : String(target || '').trim();
  return `等待授权：${toolName}` + (detail ? '\n' + (detail.length > 400 ? detail.slice(0, 398) + '…' : detail) : '');
}

function onPromptSubmittedFromHook(sessionId, submittedAt = Date.now(), options = {}) {
  const session = sessions.get(sessionId);
  if (!session) return;
  notePtyTurnBoundary(session);
  // Claude Code 在后台任务结束或 Monitor 产生事件时，会自己注入一条
  // <task-notification> 续跑一轮，并照样发 UserPromptSubmit。这不是用户发言：
  // 未读要留着，后台任务清单也要留到这一轮的 Stop 带来新清单为止。
  const injected = options.injected === true;
  const transition = applyPromptSubmitted(session, { submittedAt, turnId: options.turnId, acknowledgesReply: !injected });
  if (!transition.applied) return;
  session.currentCardActivity = null;
  session.liveToolActivities = [];
  session.livePresentationCardId = null;
  clearSessionConnectionIssue(session, { render: false });
  armPtyBurstFallback(sessionId, transition.at);
  // 2026-07-20 maintainer：hook prompt = claude 语义工作开始（与 stop hook 配对收尾）
  session._agentWorking = 'hook';
  session._runSource = 'semantic';
  session._lastOutputTs = transition.at;
  session.lastError = null;
  if (!injected) session._claudeBackgroundTasks = [];
  observeSessionRuntime(session, {
    state: RUNTIME_STARTING,
    source: options.provider === 'codex' ? 'codex-user-prompt-submit' : 'claude-user-prompt-submit',
    confidence: CONFIDENCE_SEMANTIC,
    observedAt: transition.at,
    startedAt: transition.at,
    turnId: options.turnId,
  });
  if (typeof _updateStreamingIndicator === 'function') _updateStreamingIndicator(sessionId);
  scheduleSessionListRender();
}

// v0.13 · P0 #1: 跟踪窗口最近一次获得 focus 的时间，用于 onReplyCompleteFromHook
// 的 seenByUser 判断加 500ms 缓冲（alt-tab 切回瞬间 document.hasFocus() 还未更新
// 的窗口期会误判 → 错弹红点）。
let _lastWindowFocusAt = Date.now();
window.addEventListener('focus', () => {
  _lastWindowFocusAt = Date.now();
  recoverVisibleActiveTerminalSurface();
});
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    recoverVisibleActiveTerminalSurface();
    void refreshSystemResourceUsage(); void refreshHubProxyInfo();
  }
});

function buildReplyReadyPreview(text, fallback = 'Codex 回复完成，等你继续') {
  const raw = String(text || '').replace(/\s+/g, ' ').trim();
  if (!raw) return fallback;
  return raw.length > 120 ? raw.slice(0, 118) + '…' : raw;
}

function clearSessionWaitingState(sessionId, options = {}) {
  const session = sessions.get(sessionId);
  if (!session || !clearSessionAttention(session, options)) return;
  scheduleSessionListRender();
  schedulePersist();
}

function onReplyCompleteFromTranscriptEvent(payload) {
  const { hubSessionId, text, completedAt, meetingId, kind, turnId } = payload || {};
  if (!hubSessionId) return;

  const session = sessions.get(hubSessionId);
  if (!session) return;
  if (session.status === 'dormant') return;
  const isClaudeTranscriptRuntime = isClaudeRuntimeSession(session);
  if (!isTranscriptCliKind(kind) && !isClaudeTranscriptRuntime) return;
  const backgroundActive = isKimiCliKind(session.kind) && hasKimiBackgroundWork(session);
  if (isKimiCliKind(session.kind) && !backgroundActive) {
    clearKimiBackgroundFinishTimer(hubSessionId);
  }

  const preview = buildReplyReadyPreview(text, `${cardWorkingLabel(session)} 回复完成，等你继续`);
  const sig = `${turnId || ''}:${completedAt || ''}:${preview}`;
  if (session._lastTranscriptReadySig === sig) return;
  if (isClaudeTranscriptRuntime && session.runtimeBackend !== 'claude-stream-json') {
    // Legacy PTY Claude closes attention/unread through Stop. The authoritative
    // terminal transcript is an independent runtime fallback: it must close a
    // stuck "running" state without replaying applyReplyCompleted and double
    // counting unread when Stop arrives as well. Native stream-json has no Stop
    // hook and must use the ordered completion reducer below.
    const at = normalizeEventTime(completedAt, Date.now());
    // 这一轮的文字写完了，但 Stop 报告后台还有 Shell / Monitor 在跑：Claude 等它们
    // 有动静还会自己续跑，会话仍是活跃的。只记下这条回复，不关这一轮。
    if (activeClaudeBackgroundTasks(session._claudeBackgroundTasks).length > 0) {
      session._lastTranscriptReadySig = sig;
      session.lastMessageTime = Math.max(Number(session.lastMessageTime) || 0, at);
      session.lastOutputPreview = preview;
      recordSessionArtifacts(session, text || preview, at);
      scheduleSessionListRender();
      schedulePersist();
      return;
    }
    const startedAt = Number(session.runStartedAt) || Number(session.lastRunStartedAt) || 0;
    if (startedAt > 0 && at >= startedAt) {
      session.lastRunStartedAt = startedAt;
      session.lastRunDurationMs = at - startedAt;
    }
    session.runStartedAt = null;
    session._agentWorking = null;
    session._runSource = null;
    disarmPtyBurstFallback(session, at);
    clearSessionConnectionIssue(session, { render: false });
    session._lastTranscriptReadySig = sig;
    session.lastMessageTime = at;
    session.lastCompletedAt = Math.max(Number(session.lastCompletedAt) || 0, at);
    session.lastOutputPreview = preview;
    recordSessionArtifacts(session, text || preview, at);
    observeSessionRuntime(session, {
      state: RUNTIME_COMPLETED,
      source: 'claude-transcript-complete',
      confidence: CONFIDENCE_AUTHORITATIVE,
      observedAt: Math.max(at, Date.now()),
      completedAt: at,
      startedAt: session.lastRunStartedAt || 0,
      turnId,
      evidence: preview,
    });
    if (typeof _updateStreamingIndicator === 'function') _updateStreamingIndicator(hubSessionId);
    updateFloatingBarState();
    scheduleSessionListRender();
    schedulePersist();
    return;
  }
  const isActive = hubSessionId === activeSessionId;
  const focusOk = document.hasFocus() || (Date.now() - _lastWindowFocusAt < 500);
  const seenByUser = isActive && focusOk;
  // A group member can be prompted directly in its CLI without a dispatcher
  // round. Membership alone is not proof that its reply was read. Meeting
  // badges union member IDs, so the later dispatcher event cannot double it.
  const transition = applyReplyCompleted(session, {
    completedAt,
    turnId,
    text: preview,
    seenByUser: backgroundActive || seenByUser,
    incrementUnread: !backgroundActive,
    keepRunning: backgroundActive,
  });
  if (!transition.applied) return;
  clearSessionConnectionIssue(session, { render: false });
  session._lastTranscriptReadySig = sig;
  session.lastMessageTime = transition.at;
  recordSessionArtifacts(session, text || preview, transition.at);
  if (backgroundActive) {
    markCodexCardWorking(hubSessionId, 'kimi_background_agent', {
      observedAt: transition.at,
      startedAt: session.runStartedAt || transition.at,
      turnId,
    });
  } else {
    clearCodexCardWorking(hubSessionId);
    observeSessionRuntime(session, {
      state: RUNTIME_COMPLETED,
      source: `${isKimiCliKind(session.kind)
        ? 'kimi'
        : String(session.kind || '').replace(/-resume$/i, '').toLowerCase() === 'gemini'
          ? 'gemini'
          : 'codex'}-turn-complete`,
      confidence: CONFIDENCE_AUTHORITATIVE,
      // 完成事件经 400ms 防抖才到；期间终端输出记下的「运行」观察时间更晚，
      // 用完成时刻当观察时刻会让这条权威结论被当成过期丢掉（2026-09-25 真机）。
      observedAt: Math.max(transition.at, Date.now()),
      completedAt: transition.at,
      startedAt: session.lastRunStartedAt || 0,
      turnId,
      evidence: preview,
    });
  }

  // 与 onPromptSubmittedFromTranscriptEvent 的开工标记配对：群聊成员干完活要收尾，
  // 否则状态灯会一直卡在运行中，只能等 45 分钟的 maxAge 兜底。群聊的未读仍由
  // meeting-room 管理；这里只用同一有序 reducer 防旧 completion 覆盖新 prompt。
  if (meetingId) {
    if (typeof _updateStreamingIndicator === 'function') _updateStreamingIndicator(hubSessionId);
    scheduleSessionListRender();
    schedulePersist();
    return;
  }

  session.lastOutputPreview = preview;
  if (typeof _updateStreamingIndicator === 'function') _updateStreamingIndicator(hubSessionId);
  scheduleSessionListRender();
  schedulePersist();
}

function onPromptSubmittedFromTranscriptEvent(payload) {
  const { hubSessionId, text, submittedAt, meetingId, kind, turnId, signalSource } = payload || {};
  if (!hubSessionId) return;
  const session = sessions.get(hubSessionId);
  if (!session) return;
  if (!isTranscriptCliKind(kind) && session.runtimeBackend !== 'claude-stream-json') return;
  if (session.status === 'dormant') return;

  const transition = applyPromptSubmitted(session, { submittedAt, turnId });
  if (!transition.applied) return;
  session.currentCardActivity = null;
  session.liveToolActivities = [];
  session.livePresentationCardId = null;
  clearSessionConnectionIssue(session, { render: false });
  armPtyBurstFallback(hubSessionId, transition.at);
  session.lastError = null;

  // 2026-07-28 用户反馈：群聊里直接点进 Codex 的 CLI 布置任务，Codex 明明在跑，
  //   状态灯却一直是绿色（就绪），群聊也进不了侧栏的"运行中"分区。
  //   根因就是这里原本第一行就 `if (meetingId) return`——群聊成员的开工信号被整条丢掉。
  //   codex/kimi 的 running 只能由 transcript 事件驱动（byte-burst 对它们是关掉的，
  //   见 terminal-activity-monitor.js），所以这条一早退，就再没有别的东西会标记它在跑。
  //   claude 走 hook 路径本来就没有这层早退，这也是为什么之前只有 codex/kimi 不亮灯。
  // 卡片/预览/未读仍然归 meeting-room.js 那条流水线管，这里只认领"会话自身在不在干活"。
  const workingSource = signalSource === 'task_started'
    ? 'rollout_task_started'
    : 'rollout_user_message';

  if (meetingId) {
    markCodexCardWorking(hubSessionId, workingSource, {
      observedAt: transition.at,
      startedAt: transition.at,
      turnId,
    });
    scheduleSessionListRender();
    return;
  }

  const preview = buildPreviewFromUserMessage(text);
  const sig = `${turnId || ''}:${submittedAt || ''}:${preview}`;
  if (preview && session._lastTranscriptPromptSig === sig) return;
  session._lastTranscriptPromptSig = sig;

  if (preview) {
    session.lastOutputPreview = preview;
    session._previewFromTranscript = true;
  }
  markCodexCardWorking(hubSessionId, workingSource, {
    observedAt: transition.at,
    startedAt: transition.at,
    turnId,
    evidence: preview || null,
  });
  session.lastMessageTime = transition.at;
  if (typeof _updateStreamingIndicator === 'function') _updateStreamingIndicator(hubSessionId);
  scheduleSessionListRender();
  schedulePersist();
}

// Hook-server health indicator (banner in sidebar when down)
let hookUp = true;
ipcRenderer.on('hook-status', (_e, { up }) => {
  const wasUp = hookUp;
  hookUp = up;
  renderHookStatus();
  // Hook going down: re-enable the regex-based preview/unread fallback by
  // clearing the "hook is authoritative" flag on every session. Without this
  // the previous successful hook pinned readTerminalPreview into short-circuit
  // forever — so if CC's hook plumbing broke mid-day, the sidebar would go
  // silent with no visible cause. When hook comes back, the next hook-event
  // sets the flag again on the session it touches.
  if (wasUp && !up) {
    for (const s of sessions.values()) {
      if (s._previewFromTranscript) s._previewFromTranscript = false;
    }
  }
});

function renderHookStatus() {
  let banner = document.getElementById('hook-status-banner');
  if (hookUp) {
    if (banner) banner.remove();
    return;
  }
  if (!banner) {
    banner = document.createElement('div');
    banner.id = 'hook-status-banner';
    banner.className = 'hook-status-banner';
    banner.textContent = 'Hook server offline — unread notifications may be delayed (silence fallback active)';
    document.querySelector('.session-sidebar').prepend(banner);
  }
}

function activeClaudeBackgroundTasks(tasks) {
  if (!Array.isArray(tasks)) return [];
  return tasks.filter((task) => {
    const status = String(task && task.status || '').toLowerCase();
    return task && !['completed', 'complete', 'done', 'failed', 'error', 'cancelled', 'canceled', 'stopped'].includes(status);
  });
}

function onReplyCompleteFromHook(sessionId, completedAt = Date.now(), options = {}) {
  const session = sessions.get(sessionId);
  if (!session) return null;
  if (session.status === 'dormant') return null;

  // v0.13 · P1 #5: Stop hook 500ms 去重窗口。CC 在 agent 子任务 / streaming
  // 抖动场景下偶尔会发两次 Stop，无去重导致 unread 计数加倍。
  const now = Date.now();
  if (session._lastStopHookTs && now - session._lastStopHookTs < 500) return null;

  // Fallback preview from xterm buffer — only matters when hook didn't supply
  // a transcript-sourced preview (very rare). Primary preview is written by
  // the hook-event handler directly from CC's JSONL.
  readTerminalPreview(sessionId);

  // "Claude is waiting for your input" — classify the tail of the AI's output.
  const w = isWaitingForUser(extractTailLines(sessionId, 40));

  // Stop hook IS the "AI finished replying" signal — fires once per Q&A turn.
  // Bump unread when the user hasn't actually seen the message: either this
  // session isn't the active one, OR the Hub window is unfocused (user alt-
  // tabbed away). The old check `sessionId !== activeSessionId` alone missed
  // the "focus lost, active-session reply lands, user returns with no badge"
  // case — matches the intermittent "有时候不提示" report.
  const isActive = sessionId === activeSessionId;
  // v0.13 · P0 #1: alt-tab 切回 Hub 的 0~500ms 窗口里 hasFocus() 仍是 false，
  // 但用户明明已经在看 → 不应弹红点。用 _lastWindowFocusAt 时间戳补缓冲。
  const focusOk = document.hasFocus() || (Date.now() - _lastWindowFocusAt < 500);
  const seenByUser = isActive && focusOk;
  const preview = buildReplyReadyPreview(
    options.lastAssistantMessage || w.text || session.lastOutputPreview,
    'Claude 回复完成，等你继续',
  );
  const backgroundTasks = activeClaudeBackgroundTasks(options.backgroundTasks);
  const needsInput = !!w.waiting;
  const backgroundActive = backgroundTasks.length > 0 && !needsInput;
  let liveRuntime = null;
  try {
    liveRuntime = terminalActivityMonitor
      ? classifySessionRuntimeFrame(session, terminalActivityMonitor.extractLiveScreenLines(sessionId))
      : null;
  } catch {}
  // Stop fires while Claude is still executing Stop hooks. If the current PTY
  // frame says “running stop hooks…”, that live strong evidence must beat the
  // foreground-response completion until the input-ready frame appears.
  // PTY：transcript 已经权威结束这一轮时，Stop hook 的状态行只是这轮的尾声，不能把它
  // 重新打开（审查 R4：多工具「完成 → 运行 → 完成」闪烁、授权场景 182 秒停在运行中）。
  const stopHooksActive = !needsInput && !backgroundActive
    && liveRuntime && liveRuntime.state === 'running'
    && !ptyTurnClosedAuthoritatively(session);
  const keepRuntimeActive = backgroundActive || stopHooksActive;
  const transition = applyReplyCompleted(session, {
    completedAt,
    text: preview,
    seenByUser,
    needsUserInput: needsInput,
    reason: w.reason,
    keepRunning: keepRuntimeActive,
  });
  if (!transition.applied) return null;
  clearSessionConnectionIssue(session, { render: false });
  session._lastStopHookTs = now;
  session._claudeBackgroundTasks = backgroundTasks;
  session._claudeSessionCrons = Array.isArray(options.sessionCrons) ? options.sessionCrons.slice(0, 20) : [];
  recordSessionArtifacts(session, options.lastAssistantMessage || w.text || session.lastOutputPreview || preview, transition.at);

  if (needsInput) {
    session._agentWorking = null;
    session._runSource = null;
    disarmPtyBurstFallback(session, transition.at);
    observeSessionRuntime(session, {
      state: RUNTIME_WAITING,
      source: 'claude-stop-needs-input',
      confidence: CONFIDENCE_STRONG,
      observedAt: transition.at,
      startedAt: session.lastRunStartedAt || 0,
      reason: w.reason || 'question',
      evidence: w.text || preview,
    });
  } else if (backgroundActive) {
    session._agentWorking = 'hook';
    session._runSource = 'semantic';
    observeSessionRuntime(session, {
      state: RUNTIME_RUNNING,
      source: 'claude-background-tasks',
      confidence: CONFIDENCE_AUTHORITATIVE,
      // transcript 的终态可能先到一步，并以处理时刻记成「完成」。Stop 带来的后台任务
      // 清单是更新的事实，用处理时刻记，才不会被那条更早的完成当成过期观察丢掉。
      observedAt: Math.max(transition.at, Date.now()),
      startedAt: session.runStartedAt || session.lastRunStartedAt || transition.at,
      evidence: backgroundTasks.map(task => task.description || task.type || task.id).filter(Boolean).join('；'),
    });
  } else if (stopHooksActive) {
    session._agentWorking = 'pty';
    session._runSource = 'pty-semantic';
    observeSessionRuntime(session, {
      state: RUNTIME_RUNNING,
      source: `pty-${liveRuntime.reason || 'claude-stop-hooks'}`,
      confidence: CONFIDENCE_STRONG,
      observedAt: transition.at,
      startedAt: session.runStartedAt || session.lastRunStartedAt || transition.at,
      evidence: liveRuntime.evidence || 'Claude Code is still running Stop hooks',
    });
    if (session.agentRuntime === 'pty') scheduleClaudeStopHookResolution(sessionId, transition.at);
  } else {
    // Official Stop is the authoritative end of the foreground turn.
    session._agentWorking = null;
    session._runSource = null;
    disarmPtyBurstFallback(session, transition.at);
    observeSessionRuntime(session, {
      state: RUNTIME_COMPLETED,
      source: 'claude-stop',
      confidence: CONFIDENCE_AUTHORITATIVE,
      observedAt: transition.at,
      completedAt: transition.at,
      startedAt: session.lastRunStartedAt || 0,
      evidence: preview,
    });
  }
  session.lastMessageTime = transition.at;
  if (typeof _updateStreamingIndicator === 'function') _updateStreamingIndicator(sessionId);
  scheduleSessionListRender();
  schedulePersist();
  return {
    completed: !needsInput && !backgroundActive && !stopHooksActive,
    waiting: needsInput,
    backgroundActive,
    stopHooksActive,
  };
}

function onClaudeNeedsInput(sessionId, observedAt = Date.now(), options = {}) {
  const session = sessions.get(sessionId);
  if (!session || session.status === 'dormant') return false;
  markSessionNeedsUserInput(session, {
    reason: options.reason || 'claude-needs-input',
    text: options.text || null,
  });
  session._agentWorking = null;
  session._runSource = null;
  const transition = observeSessionRuntime(session, {
    state: RUNTIME_WAITING,
    source: options.reason || 'claude-needs-input',
    confidence: CONFIDENCE_AUTHORITATIVE,
    observedAt,
    startedAt: session.runStartedAt || 0,
    reason: options.reason || null,
    evidence: options.text || null,
  });
  if (typeof _updateStreamingIndicator === 'function') _updateStreamingIndicator(sessionId);
  scheduleSessionListRender();
  schedulePersist();
  return transition.applied;
}

function onClaudeStopFailure(sessionId, observedAt = Date.now(), options = {}) {
  const session = sessions.get(sessionId);
  if (!session || session.status === 'dormant') return false;
  const at = Number(observedAt) || Date.now();
  const runStartedAt = Number(session.runStartedAt) || 0;
  if (runStartedAt > 0 && at >= runStartedAt) {
    session.lastRunStartedAt = runStartedAt;
    session.lastRunDurationMs = at - runStartedAt;
  }
  session.runStartedAt = null;
  session._agentWorking = null;
  session._runSource = null;
  session._claudeBackgroundTasks = [];
  clearSessionAttention(session);
  disarmPtyBurstFallback(session, at);
  const detail = String(options.errorDetails || options.lastAssistantMessage || options.error || 'Claude Code turn failed');
  session.lastError = detail.slice(0, 1000);
  session.lastMessageTime = at;
  const transition = observeSessionRuntime(session, {
    state: RUNTIME_FAILED,
    source: 'claude-stop-failure',
    confidence: CONFIDENCE_AUTHORITATIVE,
    observedAt: at,
    startedAt: runStartedAt,
    completedAt: at,
    reason: options.error || 'unknown',
    evidence: detail,
  });
  if (typeof _updateStreamingIndicator === 'function') _updateStreamingIndicator(sessionId);
  scheduleSessionListRender();
  schedulePersist();
  return transition.applied;
}

function onClaudeNotification(sessionId, observedAt = Date.now(), options = {}) {
  const type = String(options.notificationType || '');
  const text = [options.title, options.message].filter(Boolean).join('：') || type;
  if (['permission_prompt', 'agent_needs_input', 'elicitation_dialog', 'elicitation_url_dialog', 'quota_auto_resume_stale'].includes(type)) {
    // PermissionRequest / 提问工具先到时已经带着具体的工具和命令；随后这条通用通知
    // （"Claude needs your permission"）不能把它冲掉。
    const current = sessions.get(sessionId);
    const truth = current ? getSessionRuntimeTruth(current) : null;
    if (truth && truth.state === RUNTIME_WAITING
        && ['claude-permission-request', 'pty-ask-user'].includes(truth.source) && truth.evidence) {
      return false;
    }
    return onClaudeNeedsInput(sessionId, observedAt, {
      reason: `claude-notification-${type}`,
      text,
    });
  }
  const session = sessions.get(sessionId);
  if (!session || session.status === 'dormant') return false;
  if (type === 'agent_completed' && Array.isArray(session._claudeBackgroundTasks)
      && session._claudeBackgroundTasks.length > 0) {
    session._claudeBackgroundTasks = [];
    return !!onReplyCompleteFromHook(sessionId, observedAt, {
      backgroundTasks: [],
      lastAssistantMessage: options.message || 'Claude 后台任务已完成',
    });
  }
  if (type === 'quota_auto_resume_fired') {
    clearSessionAttention(session);
    session._agentWorking = 'hook';
    session._runSource = 'semantic';
    const transition = observeSessionRuntime(session, {
      state: RUNTIME_STARTING,
      source: 'claude-quota-auto-resume',
      confidence: CONFIDENCE_AUTHORITATIVE,
      observedAt,
      startedAt: observedAt,
      evidence: text,
    });
    scheduleSessionListRender();
    return transition.applied;
  }
  if (type === 'quota_auto_resume_disabled') {
    const transition = observeSessionRuntime(session, {
      state: RUNTIME_IDLE,
      source: 'claude-quota-auto-resume-disabled',
      confidence: CONFIDENCE_AUTHORITATIVE,
      observedAt,
      evidence: text,
    });
    scheduleSessionListRender();
    return transition.applied;
  }
  return false;
}

// --- Keyboard shortcuts ---
const terminalFontShortcutActive = () => !!document.activeElement?.closest('.xterm,.codex-backstage');
const keyboardShortcuts = createKeyboardShortcuts({
  document,
  ipcRenderer,
  clipboard,
  sessions,
  terminalCache,
  getActiveSessionId: () => sessionSplit?.focusedId() || activeSessionId,
  getCurrentFontSize: () => terminalFontShortcutActive() ? currentTerminalFontSize : currentFontSize,
  selectSession,
  escapeToHome,
  toggleSidebar,
  openTerminalSearch: () => openTerminalSearch(),
  openPreviewQuickOpen: () => openPreviewQuickOpen(),
  setFontSize: size => terminalFontShortcutActive() ? setTerminalFontSize(size) : setFontSize(size),
  closeSession: closeSessionAsSleep,
  createWorkspaceSession: (kind) => launchCenter.open('session', { kind }),
  copyText: text => clipboardController.copyText(text, { source: 'terminal-shortcut' }),
});
keyboardShortcuts.init();
// --- Context menus ---
const sessionContextMenu = createSessionContextMenuController({
  document,
  window,
  contextMenuEl,
  sessions,
  meetings,
  ipcRenderer,
  getActiveSessionId: () => activeSessionId,
  setActiveSessionId: (value) => { activeSessionId = value; },
  getActiveMeetingId: () => activeMeetingId,
  setActiveMeetingId: (value) => { activeMeetingId = value; },
  closeMeetingPanel: () => { if (typeof MeetingRoom !== 'undefined') MeetingRoom.closeMeetingPanel(); },
  emptyStateEl,
  renderSessionList: scheduleSessionListRender,
  schedulePersist,
  wakeDormantSession: (sessionId) => resumeDormantSession(sessionId, { forceScrollBottom: true }),
  // 群聊分支建出新群聊/新成员后，直接把用户带到那间房里。
  selectMeeting: (meetingId) => { void selectMeeting(meetingId); },
});
sessionContextMenu.init();
const openContextMenu = sessionContextMenu.open;
const closeContextMenu = sessionContextMenu.close;

const terminalContextMenu = createTerminalContextMenuController({
  document,
  window,
  termCtxMenuEl,
  openPreviewPanel: (target) => openPathInHub(target, {
    cwd: getSessionCwd(activeSessionId),
    requireExistsForRel: false,
  }).catch((error) => {
    showPreviewNotice(`预览失败：${String(error && error.message || error)}`, 'error');
  }),
});
terminalContextMenu.init();
const openTerminalContextMenu = terminalContextMenu.open;
const closeTerminalContextMenu = terminalContextMenu.close;

const cardSelectionContextMenu = createCardSelectionContextMenuController({
  document,
  window,
  menuEl: document.getElementById('card-selection-context-menu'),
  clipboard,
});
cardSelectionContextMenu.init();

const pathLinkContextMenu = createPathLinkContextMenuController({
  document,
  window,
  menuEl: document.getElementById('path-link-context-menu'),
  clipboard,
  shell,
  ipcRenderer,
  normalizeLocalPathForOpen: _normalizeLocalPathForOpen,
  getSessionCwd,
  getActiveSessionId: () => activeSessionId,
  getActiveCwd: () => getActiveFileManagerContext()?.cwd || getActivePreviewCwd(),
  openFileManager: async (target, cwd) => {
    const stat = await fs.promises.stat(target);
    const directory = stat.isDirectory() ? target : require('path').dirname(target);
    return openPathInHub(directory, { cwd, requireExistsForRel: false, throwOnError: true });
  },
});
pathLinkContextMenu.init();

// --- Terminal in-buffer search (Ctrl+F) ---
const terminalSearch = createTerminalSearch({
  document,
  getActiveSessionId: () => sessionSplit?.focusedId() || activeSessionId,
  getTerminalCache: () => terminalCache,
  getTranscriptRoot: () => {
    if (activeMeetingId) return document.querySelector('#meeting-room-panel .mr-gc-messages');
    if (sessionSplit?.isSecondaryFocused()) {
      const pane = sessionSplit.secondary();
      return pane.mode() === 'card' ? pane.overlay : document.querySelector('.split-secondary .cb-viewport');
    }
    if (!activeSessionId) return null;
    return currentView === 'card' ? document.getElementById('msg-overlay') : document.querySelector('#terminal-panel .cb-viewport');
  },
});
terminalSearch.init();
const openTerminalSearch = terminalSearch.open;
const closeTerminalSearch = terminalSearch.close;
// --- Sidebar collapse ---
const SIDEBAR_KEY = 'claude-hub-sidebar-collapsed';
function applySidebarCollapsed(collapsed) {
  appContainerEl.classList.toggle('sidebar-collapsed', collapsed);
  // 箭头方向：折叠态 ❯（朝右暗示展开），展开态 ❮（朝左暗示折叠回去）
  if (btnExpandEl) btnExpandEl.textContent = collapsed ? '❯' : '❮';
  // After CSS transition, refit active xterm so it claims the new width.
  setTimeout(() => {
    const cached = terminalCache.get(activeSessionId);
    if (!cached) return;
    scheduleFitAndResizeTerminal(activeSessionId, cached, { force: true });
  }, 200);
}
const initialCollapsed = localStorage.getItem(SIDEBAR_KEY) === '1';
applySidebarCollapsed(initialCollapsed);
function toggleSidebar() {
  const next = !appContainerEl.classList.contains('sidebar-collapsed');
  localStorage.setItem(SIDEBAR_KEY, next ? '1' : '0');
  applySidebarCollapsed(next);
}
btnExpandEl.addEventListener('click', toggleSidebar);
// 整区面板（投研）打开时临时折叠 session 列表、离开时恢复：只改外观，不写 localStorage，
// 所以不会改掉你自己设的「折叠 / 展开」偏好（2026-09-27 用户：打开投研时左侧 session 列表应当折叠）。
window.__hubSidebar = {
  collapseForPanel: () => applySidebarCollapsed(true),
  restore: () => applySidebarCollapsed(localStorage.getItem(SIDEBAR_KEY) === '1'),
};

const shellController = createShellController({
  document,
  menuEl,
  resumeMenuEl: null,
  contextMenuEl,
  termCtxMenuEl,
  terminalCache,
  terminalPanelEl,
  emptyStateEl,
  closeTerminalSearch: () => closeTerminalSearch(),
  closePreviewPanel: () => closePreviewPanel(),
  closeMeetingPanel: () => { if (typeof MeetingRoom !== 'undefined') MeetingRoom.closeMeetingPanel(); },
  setActiveSessionId: (value) => { activeSessionId = value; },
  setActiveMeetingId: (value) => { activeMeetingId = value; },
  applySidebarCollapsed,
  preserveAndClearTerminalPanel,
  applyViewMode,
  renderSessionList,
  suspendTerminalRenderer: (cached) => unloadGpuRenderer(cached),
});
function escapeToHome() {
  window.hubWorkspaces?.close();
  if (window.__xresearchHide) window.__xresearchHide();
  if (window.__studyHide) window.__studyHide();
  if (window.__assistantHide) window.__assistantHide();
  if (window.__writingHide) window.__writingHide(); // 2026-09-30 写作面板互斥
  if (window.__ranHide) window.__ranHide(); // 2026-09-04 RAN 工作台面板互斥
  if (fileManagerPanel) fileManagerPanel.close();
  shellController.escapeToHome();
  setShellNavActive('home');
  if (completionNotificationToggle) completionNotificationToggle.refreshTarget();
  if (homeWorkbench) homeWorkbench.render({ force: true });
}
// 2026-05-16 maintainer：外部 HTTP 救援入口 — main.js POST /api/escape-home 通过这个 IPC 触发
// （右下角可见的 🏠 按钮已于 2026-06-28 移除，仅保留此救援后门 + Ctrl+Alt+Home 快捷键）
ipcRenderer.on('escape-home', escapeToHome);

const { createConfigModalController } = require('./config-modal.js');
function getActiveCompletionNotificationTarget() {
  const focusedId = getFocusedSessionId();
  if (focusedId) {
    const session = sessions.get(focusedId);
    return session ? { type: 'session', ...session } : null;
  }
  if (activeMeetingId) {
    const meeting = meetings[activeMeetingId];
    return meeting ? { type: 'meeting', ...meeting } : null;
  }
  return null;
}
const configModal = createConfigModalController({
  document,
  ipcRenderer,
  providerModes,
  renderAccountUsage,
  applyCardDisplaySettings: applyHubCardDisplaySettings,
  getNotificationTarget: getActiveCompletionNotificationTarget,
});
const accountCenterPanel = require('./account-center-panel').createAccountCenterPanel({
  document, ipcRenderer, escapeHtml, configModal, closeOtherPanels: () => { window.hubWorkspaces?.close(); memoryPanel.close(); capabilityPanel.close(); },
});
window.hubWorkspaces = require('./hub-workspaces').createHubWorkspaces({
  document, window, memory: memoryPanel, capabilities: capabilityPanel, memo: memoPanel,
  beforeOpen: () => { accountCenterPanel.close(); window.__assistantHide?.(); },
  search: { open: pastSessionModals.openSearchModal, close: pastSessionModals.closeSearchModal },
});
const assistantPanel = require('./assistant-panel').createAssistantPanel({
  document, ipcRenderer,
  closeOtherPanels: () => { window.hubWorkspaces?.close(); memoryPanel.close(); capabilityPanel.close(); accountCenterPanel.close(); },
  getSession: sessionId => sessions.get(sessionId),
  getActiveSessionId: () => activeSessionId,
  showMessage: message => showToast(message),
  openSession: async (sessionId, session) => {
    if (!sessions.has(sessionId)) {
      const current = session || (await ipcRenderer.invoke('get-sessions')).find(item => item.id === sessionId);
      if (!current) throw new Error('助理会话暂未出现在当前 Hub，请刷新后重试');
      sessions.set(sessionId, current); renderSessionList();
    }
    // Carry a draft from the retired assistant composer into the ordinary one.
    // Persist the combined text before dropping its old key.
    try {
      const old = localStorage.getItem('hub.assistant.chat-draft');
      if (old) {
        const current = floatingInputDrafts.get(sessionId) || localStorage.getItem('codex-native-draft:'+sessionId) || '';
        const combined = current === old || current.endsWith('\n\n' + old) ? current : current ? current + '\n\n' + old : old;
        localStorage.setItem('codex-native-draft:'+sessionId, combined);
        floatingInputDrafts.set(sessionId, combined);
        localStorage.removeItem('hub.assistant.chat-draft');
      }
    } catch (error) {
      showToast('旧助理草稿尚未迁移，原内容已保留：' + error.message);
    }
    await selectSession(sessionId, { forceScrollBottom: true, splitBypass: true });
  },
});
window.__assistantHide = () => assistantPanel.close();
// 发行目标关掉了助理（公司版）：左侧「助理」入口不显示，主进程也没有启动助理服务。
if (!require('../core/distribution').featureEnabled('assistant')) {
  const assistantNav = document.getElementById('btn-assistant');
  if (assistantNav) assistantNav.style.display = 'none';
}
window.__assistantSync = session => assistantPanel.syncSession(session);
const openConfigModal = configModal.open;
const setCodexProfileForm = configModal.setCodexProfileForm;
document.addEventListener('hub-config-saved', () => {
  void refreshHubProxyInfo({ force: true });
  if (homeWorkbench) homeWorkbench.render();
});

const { createCompletionNotificationToggle } = require('./completion-notification-toggle.js');
completionNotificationToggle = createCompletionNotificationToggle({
  document,
  ipcRenderer,
  getNotificationTarget: getActiveCompletionNotificationTarget,
  openNotificationSettings: configModal.openNotificationSetup,
});
completionNotificationToggle.init();
ipcRenderer.on('completion-notification-config-changed', () => {
  void refreshHubProxyInfo();
});

const themeController = createThemeController({
  document,
  localStorage,
  terminalCache,
  openConfigModal,
  onThemeApplied: theme => ipcRenderer.send('hub:ui-theme', theme),
});

const suspendIdleItem = document.getElementById('options-suspend-idle');
if (suspendIdleItem) {
  suspendIdleItem.addEventListener('click', async (event) => {
    event.stopPropagation();
    const optionsMenu = document.getElementById('options-menu');
    if (optionsMenu) optionsMenu.style.display = 'none';
    // 先预演再确认。以前这里只弹一句「已请求休眠 N 个」，skipped 的原因被直接
    // 丢掉，所以没人看得出自己的会话到底会不会被休眠、卡在哪一关——
    // 「某某 CLI 好像没有自动休眠」的错觉就是这么产生的。
    suspendIdleItem.setAttribute('aria-busy', 'true');
    let preview = null;
    try {
      preview = await ipcRenderer.invoke('preview-auto-suspend');
    } catch { preview = null; }
    suspendIdleItem.removeAttribute('aria-busy');

    const hours = ms => `${(Number(ms) / 3600000).toFixed(1)} 小时`;
    const lines = [];
    if (preview && preview.ok) {
      lines.push(`后台自动巡检：每 ${Math.round(preview.checkIntervalMs / 60000)} 分钟一次，`
        + `闲置满 ${hours(preview.idleMs)} 休眠${preview.schedulerRunning ? '（运行中）' : '（未启动）'}`);
      lines.push('');

      const kinds = Object.entries(preview.byKind || {}).sort((a, b) => b[1].total - a[1].total);
      if (kinds.length > 0) {
        lines.push(`当前 ${preview.total} 个活跃会话，按 CLI 分：`);
        for (const [kind, stat] of kinds) {
          lines.push(`  ${kind} ${stat.total} 个 · ${stat.eligible} 个已够钟`);
        }
        lines.push('');
      }

      const eligible = (preview.items || []).filter(item => item.eligible);
      if (eligible.length > 0) {
        lines.push(`会被休眠的 ${eligible.length} 个：`);
        for (const item of eligible.slice(0, 8)) {
          lines.push(`  · ${String(item.kind || '?').replace(/-resume$/, '')} · `
            + `${(item.title || '未命名').slice(0, 20)}（已闲置 ${hours(item.idleMs)}）`);
        }
        if (eligible.length > 8) lines.push(`  … 另有 ${eligible.length - 8} 个`);
        lines.push('');
      }

      const blocked = (preview.items || []).filter(item => !item.eligible);
      if (blocked.length > 0) {
        lines.push(`不会被休眠的 ${blocked.length} 个，原因：`);
        const grouped = new Map();
        for (const item of blocked) {
          const key = item.message || item.reason || '未知';
          if (!grouped.has(key)) grouped.set(key, []);
          grouped.get(key).push(item);
        }
        for (const [message, group] of [...grouped.entries()].sort((a, b) => b[1].length - a[1].length)) {
          const soonest = group
            .filter(item => item.remainingMs > 0)
            .sort((a, b) => a.remainingMs - b.remainingMs)[0];
          lines.push(`  · ${message} × ${group.length}`
            + (soonest ? `（最近的还差 ${hours(soonest.remainingMs)}）` : ''));
        }
        lines.push('');
      }
    } else {
      lines.push('（预演不可用，直接执行）', '');
    }

    lines.push('现在立即执行一次手动巡检吗？');
    lines.push('手动这次会额外跳过全部群聊成员；会话卡片、未读标记和历史都会保留。');

    if (!await require('./ui-feedback').confirmHubAction(lines.join('\n'), { title: '巡检长期闲置会话？', acceptLabel: '开始巡检' })) return;

    suspendIdleItem.setAttribute('aria-busy', 'true');
    try {
      const result = await ipcRenderer.invoke('suspend-idle-sessions', { idleMs: 5 * 60 * 60 * 1000 });
      if (!result || !result.ok) {
        require('./ui-feedback').showHubAlert((result && result.message) || '批量休眠失败，请稍后重试。');
        return;
      }
      const skipped = Object.entries(result.skipped || {});
      const detail = skipped.length > 0
        ? `\n\n跳过 ${skipped.reduce((sum, [, n]) => sum + n, 0)} 个：\n`
          + skipped.sort((a, b) => b[1] - a[1]).map(([reason, n]) => `  · ${reason} × ${n}`).join('\n')
        : '';
      require('./ui-feedback').showHubAlert((result.count > 0
        ? `已请求休眠 ${result.count} 个长期闲置会话；内存会在对应 CLI 退出后释放。`
        : '没有符合条件的长期闲置会话。') + detail);
    } catch (error) {
      require('./ui-feedback').showHubAlert(`批量休眠失败：${error && error.message ? error.message : String(error)}`);
    } finally {
      suspendIdleItem.removeAttribute('aria-busy');
    }
  });
}

if (typeof MeetingRoom !== 'undefined') {
  MeetingRoom.init(sessions, getOrCreateTerminal);
}

const _pendingDormantResumes = new Map();

ipcRenderer.on('session-created', async (_e, { session }) => {
  nativeSessionBootstrap.record(session, { created: true });
  // When resuming a dormant session, the hubId matches an existing dormant
  // entry. Merge live PTY info on top of the dormant metadata so title /
  // preview / unread / pinned aren't wiped.
  const existing = sessions.get(session.id);
  const pendingResume = _pendingDormantResumes.get(session.id) || null;
  const wasDormant = !!pendingResume || !!(existing && existing.status === 'dormant');
  if (pendingResume) _pendingDormantResumes.delete(session.id);
  paintSidebarResumePending(session.id, false);
  if (wasDormant) {
    sessions.set(session.id, {
      ...existing,
      ...session,
      status: 'idle',
      _resumePending: false,
      // preserve persisted UX state
      pinned: !!existing.pinned,
      bottomed: !!existing.bottomed && !existing.pinned,
      unreadCount: existing.unreadCount || 0,
      suspendedAt: null,
      suspendReason: null,
      // Main reconciles provider-native ids/paths during resume.  Its fresh
      // binding must replace stale dormant metadata, not the other way around.
      ccSessionId: session.ccSessionId || existing.ccSessionId,
      transcriptPath: session.transcriptPath || existing.transcriptPath,
      lastOutputPreview: existing.lastOutputPreview,
    });
  } else {
    sessions.set(session.id, session);
  }
  const createdRuntimeSession = sessions.get(session.id);
  if (createdRuntimeSession) {
    observeSessionRuntime(createdRuntimeSession, {
      state: RUNTIME_IDLE,
      source: wasDormant ? 'session-resumed' : 'session-created',
      confidence: CONFIDENCE_AUTHORITATIVE,
      observedAt: Date.now(),
    });
  }
  if (sessionSplit?.handlesCreated(session.id)) {
    scheduleSessionListRender();
    return;
  }
  // 原生投研 PTY 由扩展投研面板内嵌挂载；不抢占主终端，也不进入左栏。
  if (session.purpose === 'xresearch-research') {
    scheduleSessionListRender();
    window.dispatchEvent(new CustomEvent('xresearch-session-created', { detail: session }));
    return;
  }
  if (session.purpose === 'hub-assistant') {
    scheduleSessionListRender();
    return;
  }
  // Delegated work must not replace the conversation or the draft currently
  // being written in the assistant. Users open the target explicitly.
  if (assistantPanel.isOpen()) {
    scheduleSessionListRender();
    void assistantPanel.refresh();
    return;
  }
  if (session.purpose === 'memory-dream' && !wasDormant) {
    scheduleSessionListRender();
    void savePreviewState({ nonBlocking: true });
    return;
  }
  // Meeting room no longer mounts embedded xterms. Keep only the lightweight
  // session metadata here; an xterm is created and hydrated on explicit shell
  // selection, otherwise dozens of invisible 10k-line buffers accumulate.
  if (session.meetingId) {
    // A member explicitly opened while dormant needs its standalone surface
    // mounted after resume. Background group wakes must never steal selection.
    if (wasDormant && activeSessionId === session.id) {
      await selectSession(session.id, { forceScrollBottom: pendingResume?.forceScrollBottom === true });
    }
    scheduleSessionListRender();
    return;
  }
  // 普通会话的唤醒流程会直接把终端展示给用户，此刻才算真正“已读”。群聊成员
  // 的后台/工作流唤醒会在上面的 meeting 分支返回，因此仍保留休眠前的未读标记。
  const activatedSession = sessions.get(session.id);
  if (activatedSession) clearSessionAttention(activatedSession, { clearUnread: true });
  void savePreviewState({ nonBlocking: true });
  clearPreviewUI();
  activeSessionId = session.id;
  activeMeetingId = null;
  completionNotificationToggle.refreshTarget();
  const mrp = document.getElementById('meeting-room-panel');
  if (mrp) mrp.style.display = 'none';
  // 2026-09-02：session-created 会直接亮出终端面板，但此前只隐藏了群聊面板。
  // 主区是 flex 容器，学习面板若还开着就会和终端并排各占一半。
  if (window.__studyHide) window.__studyHide();
  if (window.__assistantHide) window.__assistantHide();
  if (window.__writingHide) window.__writingHide(); // 2026-09-30 写作面板互斥
  if (window.__ranHide) window.__ranHide(); // 2026-09-04 RAN 工作台面板互斥
  if (terminalPanelEl) terminalPanelEl.style.display = '';
  ipcRenderer.send('focus-session', { sessionId: session.id });
  paintSidebarActiveTarget({ sessionId: session.id });
  // A league shortcut may have requested card/PTY before this asynchronous
  // event arrived. Honor that last explicit intent; otherwise a late create
  // event makes the card button intermittently bounce back to PTY.
  const requestedView = _xresearchRequestedSessionViews.get(session.id);
  if (requestedView) _xresearchRequestedSessionViews.delete(session.id);
  // New sessions and resumed sessions share the same card-first default.
  // Backstage remains an explicit action during the current viewing period.
  applyViewMode(
    requestedView || selectionViewModeForSession(session.id, session),
    { remember: false, skipPreviousCardCapture: true },
  );
  showTerminal(session.id, {
    forceScrollBottom: !!(pendingResume && pendingResume.forceScrollBottom),
  });
  scheduleSessionListRender();
  await restorePreviewForContext(`session:${session.id}`);
});

// Spec 3 · W12：transcript-tap session-bound 触发的 IPC，内存 sessions Map 同步
// codex/gemini 的 resume meta（之前只落盘 lastPersistedSessions，renderer 内存
// 拿不到 → reboot 才生效）。Claude/claude-resume 不走这条（ccSessionId 走 hook-event）。
ipcRenderer.on('session-meta-updated', (_e, ev) => {
  if (!ev || !ev.hubSessionId) return;
  const s = sessions.get(ev.hubSessionId);
  if (!s) return;
  if (ev.ccSessionId) s.ccSessionId = ev.ccSessionId;
  if (ev.transcriptPath) s.transcriptPath = ev.transcriptPath;
  if (ev.codexSid) s.codexSid = ev.codexSid;
  if (ev.codexSessionsRoot) s.codexSessionsRoot = ev.codexSessionsRoot;
  if (ev.codexAllowMtimeFallback) s.codexAllowMtimeFallback = true;
  if (ev.geminiChatId) s.geminiChatId = ev.geminiChatId;
  if (ev.geminiProjectHash) s.geminiProjectHash = ev.geminiProjectHash;
  if (ev.geminiProjectRoot) s.geminiProjectRoot = ev.geminiProjectRoot;
  if (ev.kimiSid) s.kimiSid = ev.kimiSid;
  if (ev.kimiSessionDir) s.kimiSessionDir = ev.kimiSessionDir;
  // 归档会搬运整个 workspace：dormant 条目的 cwd 也要跟着走，否则唤醒时指向已不存在的目录。
  if (ev.cwd) s.cwd = ev.cwd;
  const collapsed = (ev.ccSessionId || ev.codexSid || ev.geminiChatId || ev.kimiSid)
    ? collapseDormantNativeDuplicates(sessions)
    : [];
  if (ev.ccSessionId || ev.transcriptPath || ev.codexSid || ev.codexSessionsRoot || ev.codexAllowMtimeFallback || ev.geminiChatId || ev.geminiProjectHash || ev.geminiProjectRoot || ev.kimiSid || ev.kimiSessionDir || ev.cwd) {
    schedulePersist();
  }
  if (collapsed.length) scheduleSessionListRender();
  if (ev.hubSessionId === activeSessionId && currentView === 'card' && typeof loadSessionHistoryToOverlay === 'function') {
    loadSessionHistoryToOverlay(ev.hubSessionId).catch(err => {
      console.warn('[session-meta-updated] card reload failed:', err);
    });
  }
});

// Spec 3 · W13：清理 _cardReloadState 的 session 条目，防 Map 长期累积。
// session-closed 触发，确保即使 inProgress 异常残留也不影响新生命周期同 sessionId 的 session。
ipcRenderer.on('session-suspended', (_e, { sessionId, session }) => {
  const booting = nativeSessionBootstrap.remove(sessionId);
  // An explicit suspension can also overtake the initial list. Keep its
  // historical entry while preventing that list from reviving a live writer.
  if (booting && session && !sessions.has(sessionId)) {
    sessions.set(sessionId, { ...session, id: sessionId, status: 'dormant' });
  }
  sessionSplit?.closed(sessionId);
  const local = sessions.get(sessionId);
  if (!local) return;
  if (window._cardLoadSeqBySid) window._cardLoadSeqBySid.delete(sessionId);
  clearCardLiveRefreshState(sessionId);
  if (window._codexHistoryRetryState && window._codexHistoryRetryState.has(sessionId)) {
    const state = window._codexHistoryRetryState.get(sessionId);
    if (state && state.timer) { try { clearTimeout(state.timer); } catch {} }
    window._codexHistoryRetryState.delete(sessionId);
  }
  if (_codexSubmitPendingTimers.has(sessionId)) {
    clearTimeout(_codexSubmitPendingTimers.get(sessionId));
    _codexSubmitPendingTimers.delete(sessionId);
  }
  if (_turnCompleteBackfillTimers.has(sessionId)) {
    try { clearTimeout(_turnCompleteBackfillTimers.get(sessionId)); } catch {}
    _turnCompleteBackfillTimers.delete(sessionId);
  }
  if (typeof _w16RemoveTimers !== 'undefined' && _w16RemoveTimers.has(sessionId)) {
    try { clearTimeout(_w16RemoveTimers.get(sessionId)); } catch {}
    _w16RemoveTimers.delete(sessionId);
  }
  if (typeof _groupChatWorkingExpiryTimers !== 'undefined' && _groupChatWorkingExpiryTimers.has(sessionId)) {
    try { clearTimeout(_groupChatWorkingExpiryTimers.get(sessionId)); } catch {}
    _groupChatWorkingExpiryTimers.delete(sessionId);
  }
  if (_cardHistoryHydratedSid === sessionId) _cardHistoryHydratedSid = null;

  const pinned = !!local.pinned;
  const bottomed = !!local.bottomed && !pinned;
  const unreadCount = local.unreadCount;
  Object.assign(local, session || {}, {
    id: sessionId,
    status: 'dormant',
    pinned,
    bottomed,
    unreadCount,
    _agentWorking: false,
    gcWorking: false,
  });
  observeSessionRuntime(local, {
    state: RUNTIME_DORMANT,
    source: 'session-suspended',
    confidence: CONFIDENCE_AUTHORITATIVE,
    observedAt: Date.now(),
  }, { mirrorLegacy: false });
  clearRuntimeTruthExpiryTimer(sessionId);
  clearTerminalActivitySession(sessionId);
  disposeCachedTerminal(sessionId);
  nativeDraftControllers.delete(sessionId);
  if (activeSessionId === sessionId) {
    activeSessionId = null;
    if (fileManagerPanel) fileManagerPanel.close();
    completionNotificationToggle.refreshTarget();
    cardMultiSelectController.setVisible(false);
    preserveAndClearTerminalPanel();
    terminalPanelEl.appendChild(emptyStateEl);
    emptyStateEl.style.display = '';
    terminalPanelEl.classList.add('home-active');
  }
  renderSessionList();
  schedulePersist();
  window.dispatchEvent(new CustomEvent('hub-session-suspended', { detail: { sessionId, session: local } }));
});

// CLI 进程自己死了（不是用户删 / 重启 / 工作区迁移）。
//
// 2026-09-07 评审实测：结束 PTY 后会话和输入框一起消失，界面凭空回到空状态，
// 用户既看不到“它断了”，也没有任何重连入口。这里不删记录，而是把它落成
// “可唤醒”：
//   - 为什么是 dormant 而不是 error：重启那条接口要求主进程那边还留着会话记录，
//     而 PTY 退出时它已经被删了——只有休眠唤醒那条路只依赖渲染层自己保存的元数据，
//     能真的把会话拉回来。标成 error 会得到一个按了没反应的“重连”按钮。
//   - _processLost 单独记一笔“进程是怎么没的”，好让输入框说“CLI 进程退出码 1”
//     而不是笼统的“会话已休眠”。
// 不可恢复的 CLI（如宙主 shell）没有可唤醒的东西，仍走原来的删除路径。
function describePtyExit(exitInfo) {
  const signal = exitInfo && exitInfo.signal ? String(exitInfo.signal).trim() : '';
  if (signal) return `CLI 进程被信号 ${signal} 结束`;
  const code = Number(exitInfo && exitInfo.exitCode);
  if (Number.isFinite(code)) return `CLI 进程退出码 ${code}`;
  return 'CLI 进程已退出';
}

function markSessionProcessLost(sessionId, exitInfo) {
  const session = sessions.get(sessionId);
  if (!session) return false;
  const reason = describePtyExit(exitInfo);
  const now = Date.now();
  session.status = 'dormant';
  session._processLost = { reason, at: now };
  session.lastError = reason;
  session._agentWorking = null;
  session._runSource = null;
  session.runStartedAt = null;
  session.cardWorkingSince = null;
  session.gcWorking = false;
  session._resumePending = false;
  clearSessionAttention(session);
  observeSessionRuntime(session, {
    state: RUNTIME_DORMANT,
    source: 'pty-exit-unrequested',
    confidence: CONFIDENCE_AUTHORITATIVE,
    observedAt: now,
    evidence: reason,
  }, { mirrorLegacy: false });
  clearRuntimeTruthExpiryTimer(sessionId);
  clearTerminalActivitySession(sessionId);
  // 草稿存着（重连后还在输入框里），终端缓存也存着（最后一屏就是现场）。
  if (activeSessionId === sessionId && typeof updateFloatingBarState === 'function') {
    updateFloatingBarState();
  }
  scheduleSessionListRender();
  schedulePersist();
  return true;
}

ipcRenderer.on('session-closed', (_e, { sessionId, exitInfo, requested }) => {
  nativeSessionBootstrap.remove(sessionId);
  sessionSplit?.closed(sessionId);
  cardHistoryViews.drop(sessionId);
  floatingPromptDeliveries.delete(sessionId);
  const closing = sessions.get(sessionId);
  // 只管普通会话：群聊成员会话的生命周期由会议室自己管，把它们一并留下
  // 会改变群聊的行为，而那是本卡完全无关的地盘。
  if (!requested && closing && !closing.meetingId
      && closing.status !== 'dormant' && supportsRecoverableSession(closing)) {
    markSessionProcessLost(sessionId, exitInfo);
    return;
  }
  dropPreviewContext(`session:${sessionId}`);
  const wasXresearchResearch = !!(closing && closing.purpose === 'xresearch-research');
  if (window._cardLoadSeqBySid) window._cardLoadSeqBySid.delete(sessionId);
  clearCardLiveRefreshState(sessionId);
  if (window._codexHistoryRetryState && window._codexHistoryRetryState.has(sessionId)) {
    const st = window._codexHistoryRetryState.get(sessionId);
    if (st && st.timer) { try { clearTimeout(st.timer); } catch {} }
    window._codexHistoryRetryState.delete(sessionId);
  }
  if (_codexSubmitPendingTimers.has(sessionId)) {
    clearTimeout(_codexSubmitPendingTimers.get(sessionId));
    _codexSubmitPendingTimers.delete(sessionId);
  }
  clearFloatingInputDraft(sessionId);
  nativeDraftControllers.delete(sessionId);
  if (_cardHistoryHydratedSid === sessionId) _cardHistoryHydratedSid = null;
  if (_turnCompleteBackfillTimers.has(sessionId)) {
    try { clearTimeout(_turnCompleteBackfillTimers.get(sessionId)); } catch {}
    _turnCompleteBackfillTimers.delete(sessionId);
  }
  // 多方审查 P1 (Claude 共识)：W16 _w16RemoveTimers 也要在 session-closed 时清理，
  // 否则 1.5s 后 timer 触发时 sessions.get(sessionId) === undefined → 走 .remove() 分支，
  // 加上未做 dataset 过滤前会误删别 session 的 indicator。即使加了 dataset 过滤，timer
  // 残留也是 leak。一起清。
  if (typeof _w16RemoveTimers !== 'undefined' && _w16RemoveTimers.has(sessionId)) {
    try { clearTimeout(_w16RemoveTimers.get(sessionId)); } catch {}
    _w16RemoveTimers.delete(sessionId);
  }
  sessions.delete(sessionId);
  forgetViewModeForSession(sessionId);
  clearRuntimeTruthExpiryTimer(sessionId);
  clearTerminalActivitySession(sessionId);
  disposeCachedTerminal(sessionId);
  if (activeSessionId === sessionId) {
    activeSessionId = null;
    if (fileManagerPanel) fileManagerPanel.close();
    completionNotificationToggle.refreshTarget();
    cardMultiSelectController.setVisible(false);
    preserveAndClearTerminalPanel();
    terminalPanelEl.appendChild(emptyStateEl);
    emptyStateEl.style.display = '';
    terminalPanelEl.classList.add('home-active');
  }
  renderSessionList();
  if (wasXresearchResearch) {
    window.dispatchEvent(new CustomEvent('xresearch-session-closed', { detail: { sessionId } }));
  }
});

ipcRenderer.on('session-updated', (_e, { session }) => {
  nativeSessionBootstrap.record(session);
  if (!sessions.has(session.id)) return;
  const local = sessions.get(session.id);
  if (session.runtimeBackend === 'claude-stream-json') {
    const old = local.nativeRuntime;
    const next = session.nativeRuntime;
    if (old && next && (next.epoch < old.epoch || (next.epoch === old.epoch && next.revision < old.revision))) return;
    // Read acknowledgement belongs to this window. Main runtime/usage snapshots
    // still carry their initial unreadCount and must not erase a received reply.
    const unreadCount = local.unreadCount;
    Object.assign(local, session, { unreadCount });
    if (old?.cancellation?.status !== next?.cancellation?.status) window.MeetingRoom?.refreshNativeCancellation?.(local.id);
    if (session.nativeMigrationDraft && local._importedNativeDraft !== session.nativeMigrationDraft) {
      local._importedNativeDraft = session.nativeMigrationDraft;
      const input = [...document.querySelectorAll('.floating-input-bar')].find(bar => bar.dataset.sessionId === local.id)?.querySelector('.floating-input-box');
      if (!floatingInputDrafts.has(local.id) && (!input || !readContenteditablePlainText(input))) {
        floatingInputDrafts.set(local.id, session.nativeMigrationDraft);
        if (input) { input.textContent = session.nativeMigrationDraft; saveFloatingInputDraft(local.id, input); }
        else {
          try { localStorage.setItem('hub.claude-native.draft.v1:' + local.id, session.nativeMigrationDraft); }
          catch (error) { showToast('迁移草稿保存失败：' + error.message, 'error'); }
        }
      }
    }
    local.needsUserInput = next?.state === 'waiting';
    local.gcWorking = false;
    _updateStreamingIndicator(local.id);
    scheduleSessionListRender();
    scheduleFloatingBarState();
    window.dispatchEvent(new CustomEvent('xresearch-session-updated', { detail: local }));
    return;
  }
  if (isNativeSession(local) && session.nativeRuntime) {
    const cancellationStatus = local.nativeRuntime?.cancellation?.status;
    if (!acceptNativeSnapshot(local, session)) return;
    if (cancellationStatus !== local.nativeRuntime?.cancellation?.status) {
      window.MeetingRoom?.refreshNativeCancellation?.(local.id);
    }
    if (session.nativeMigrationDraft && local._importedNativeDraft!==session.nativeMigrationDraft) {
      local._importedNativeDraft=session.nativeMigrationDraft;
      const input=[...document.querySelectorAll('.floating-input-bar')].find(bar=>bar.dataset.sessionId===local.id)?.querySelector('.floating-input-box');
      if(!floatingInputDrafts.has(local.id) && (!input || !readContenteditablePlainText(input))) {
        floatingInputDrafts.set(local.id,session.nativeMigrationDraft);
        if(input){input.textContent=session.nativeMigrationDraft;saveFloatingInputDraft(local.id,input);}
        else {try{localStorage.setItem('codex-native-draft:'+local.id,session.nativeMigrationDraft);}catch(error){console.warn('[codex-draft] migration save failed:',error.message);}}
      }
    }
    clearRuntimeTruthExpiryTimer(local.id);
    clearPtyRunningAnimationCandidate(local);
    _updateStreamingIndicator(local.id);
    scheduleFloatingBarState();
  }
  if (local.purpose === 'xresearch-research' || session.purpose === 'xresearch-research') {
    Object.assign(local, session);
    scheduleSessionListRender();
    window.dispatchEvent(new CustomEvent('xresearch-session-updated', { detail: local }));
    return;
  }
  // Merge server updates but keep local preview/status (managed by renderer)
  if (session.meetingId) local.meetingId = session.meetingId;
  if (!local.userRenamed && session.title) local.title = session.title;
  if (session.ccSessionId) local.ccSessionId = session.ccSessionId;
  if (session.transcriptPath) local.transcriptPath = session.transcriptPath;
  if (session.codexSid) local.codexSid = session.codexSid;
  if (session.acpSid) local.acpSid = session.acpSid;
  if (session.acpProfileId) local.acpProfileId = session.acpProfileId;
  if (session.acpCapabilities) local.acpCapabilities = session.acpCapabilities;
  if (Object.hasOwn(session,'cliRuntime')) local.cliRuntime = session.cliRuntime;
  if (session.codexSessionsRoot) local.codexSessionsRoot = session.codexSessionsRoot;
  if (session.codexAllowMtimeFallback) local.codexAllowMtimeFallback = true;
  if (session.codexProfile) local.codexProfile = session.codexProfile;
  if (session.codexProfileLabel) local.codexProfileLabel = session.codexProfileLabel;
  if (session.mcpProfile) local.mcpProfile = session.mcpProfile;
  if (typeof session.fastMode === 'boolean') local.fastMode = session.fastMode;
  if (session.codexSpeedTier) local.codexSpeedTier = session.codexSpeedTier;
  if (session.kimiSid) local.kimiSid = session.kimiSid;
  if (session.kimiSessionDir) local.kimiSessionDir = session.kimiSessionDir;
  if (session.effort) local.effort = session.effort;
  if (session.sessionUsage) local.sessionUsage = session.sessionUsage;
  let persistModel = false;
  if (session.currentModel && session.currentModel.id) {
    const previousModelId = local.currentModel && local.currentModel.id;
    local.currentModel = { ...session.currentModel };
    persistModel = previousModelId !== local.currentModel.id;
  }
  if (session.userRenamed) local.userRenamed = true;
  if (session.autoTitleGenerated) local.autoTitleGenerated = true;
  if (session.branchSourceSessionId !== undefined) local.branchSourceSessionId = session.branchSourceSessionId;
  if (Number.isInteger(Number(session.branchIndex)) && Number(session.branchIndex) > 0) {
    local.branchIndex = Number(session.branchIndex);
  }
  if (typeof session.branchAutoTitlePending === 'boolean') {
    local.branchAutoTitlePending = session.branchAutoTitlePending;
  }
  if (typeof session.workspaceLabel === 'string') local.workspaceLabel = session.workspaceLabel;
  if (typeof session.contextPct === 'number') local.contextPct = session.contextPct;
  if (typeof session.contextUsed === 'number') local.contextUsed = session.contextUsed;
  if (typeof session.contextMax === 'number') local.contextMax = session.contextMax;
  let persistRuntimeContext = false;
  if (typeof session.contextEffectiveMax === 'number'
      && local.contextEffectiveMax !== session.contextEffectiveMax) {
    local.contextEffectiveMax = session.contextEffectiveMax;
    persistRuntimeContext = true;
  }
  if (typeof session.contextEffectiveObservedAt === 'number'
      && local.contextEffectiveObservedAt !== session.contextEffectiveObservedAt) {
    local.contextEffectiveObservedAt = session.contextEffectiveObservedAt;
    persistRuntimeContext = true;
  }
  if (typeof session.lastCompletedAt === 'number'
      && session.lastCompletedAt >= (Number(local.lastCompletedAt) || 0)) {
    local.lastCompletedAt = session.lastCompletedAt;
  }
  if (typeof session.completionNotificationEnabled === 'boolean') {
    local.completionNotificationEnabled = session.completionNotificationEnabled;
  }
  if (session.id === activeSessionId) {
    // Auto-title and external rename updates already refresh the sidebar, but
    // the active terminal header used to keep the placeholder (for example
    // "Codex 1") until the user switched away and back. Keep both views on the
    // same authoritative session title without disturbing an in-progress
    // inline rename (the span is absent while its input is mounted).
    const activeTitle = toolbarCrumbEl && toolbarCrumbEl.querySelector('.terminal-title');
    if (activeTitle && activeTitle.textContent !== local.title) activeTitle.textContent = local.title;
    // 工作区标签也是 main 会在首轮之后改写的字段（临时区的名字换成正式项目名）。
    // T2 之前它长在 metrics 的目录 chip 上，靠下面那行 updateActiveMetricsRow 顺带
    // 刷新；搬进面包屑之后就得自己刷，否则用户会一直看着首轮之前那个旧名字。
    updateActiveCrumbWorkspace();
    updateActiveMetricsRow();
    if (persistModel) updateActiveModelChip();
    completionNotificationToggle.refreshTarget();
  }
  if (persistRuntimeContext || persistModel) schedulePersist();
  scheduleSessionListRender();
});

// --- Session persistence (dormant restore) ---
// Provider-native AI sessions persist across app restarts; PowerShell remains
// ephemeral. Dormant cards have no PTY and wake through the shared exact-resume
// contract (`ccSessionId`, `codexSid`, `geminiChatId` or `kimiSid`).
// The payload is every kept session (1400+ in real use, ~2.8 MB structured
// clone) and Main deep-compares all of it on arrival. While agents stream,
// something changes every second, so send 400 ms after the first change and
// then at most every 2 s. The timer reads the live sessions Map when it fires,
// so the newest state always goes out; flush callers bypass the wait.
const PERSIST_DELAY_MS = 400;
const PERSIST_MIN_INTERVAL_MS = 2000;
let persistDebounceTimer = null;
let lastPersistSentAt = 0;
function schedulePersist() {
  if (persistDebounceTimer) return;
  const delay = Math.max(PERSIST_DELAY_MS, lastPersistSentAt + PERSIST_MIN_INTERVAL_MS - Date.now());
  persistDebounceTimer = setTimeout(() => { persistDebounceTimer=null; persistWorkscene(); }, delay);
}
function persistWorkscene(flush = false) {
    if (flush && persistDebounceTimer) { clearTimeout(persistDebounceTimer);persistDebounceTimer=null; }
    lastPersistSentAt = Date.now();
    const list = [];
    for (const s of sessions.values()) {
      // 持久化白名单：AI 群聊会议 + 所有 AI kind（含 -resume 变体）。新增 AI 由 ai-kinds.js 单一真理源覆盖。
      if (!s.meetingId && !isAiKind(s.kind) && s.kind !== 'claude-resume' && !(typeof s.kind === 'string' && s.kind.endsWith('-resume'))) continue;
      list.push({
        hubId: s.id,
        title: s.title,
        kind: s.kind,
        cwd: s.cwd || null,
        cwdFellBackFrom: s.cwdFellBackFrom || null,
        memoryLinkWarning: s.memoryLinkWarning || null,
        workspaceLabel: s.workspaceLabel || null,
        pinned: !!s.pinned,
        bottomed: !!s.bottomed && !s.pinned,
        ccSessionId: s.ccSessionId || null,
        ...(s.runtimeBackend === 'claude-stream-json' ? { nativeConfig: s.nativeConfig } : {}),
        transcriptPath: s.transcriptPath || null,
        meetingId: s.meetingId || null,
        lastMessageTime: s.lastMessageTime || Date.now(),
        lastOutputPreview: s.lastOutputPreview || '',
        unreadCount: s.unreadCount || 0,
        attentionState: s.attentionState || null,
        needsUserInput: !!s.needsUserInput,
        replyReady: !!s.replyReady,
        waitingReason: s.waitingReason || null,
        waitingText: s.waitingText || null,
        replyReadyText: s.replyReadyText || null,
        runStartedAt: typeof s.runStartedAt === 'number' ? s.runStartedAt : null,
        lastCompletedAt: typeof s.lastCompletedAt === 'number' ? s.lastCompletedAt : null,
        lastRunStartedAt: typeof s.lastRunStartedAt === 'number' ? s.lastRunStartedAt : null,
        lastRunDurationMs: typeof s.lastRunDurationMs === 'number' ? s.lastRunDurationMs : null,
        recentArtifacts: Array.isArray(s.recentArtifacts) ? s.recentArtifacts.slice(-8) : null,
        suspendedAt: s.suspendedAt || null,
        suspendReason: s.suspendReason || null,
        connectionIssue: s.connectionIssue && typeof s.connectionIssue === 'object'
          ? { ...s.connectionIssue }
          : null,
        _connectionIssueAck: s._connectionIssueAck && typeof s._connectionIssueAck === 'object'
          ? { ...s._connectionIssueAck }
          : null,
        currentModel: s.currentModel || null,
        effort: s.effort || null,
        contextPct: typeof s.contextPct === 'number' ? s.contextPct : null,
        contextUsed: typeof s.contextUsed === 'number' ? s.contextUsed : null,
        sessionUsage: s.sessionUsage || null,
        contextMax: typeof s.contextMax === 'number' ? s.contextMax : null,
        contextEffectiveMax: typeof s.contextEffectiveMax === 'number' ? s.contextEffectiveMax : null,
        contextEffectiveObservedAt: typeof s.contextEffectiveObservedAt === 'number'
          ? s.contextEffectiveObservedAt
          : null,
        userRenamed: !!s.userRenamed,
        autoTitleGenerated: !!s.autoTitleGenerated,
        branchSourceSessionId: s.branchSourceSessionId || null,
        branchIndex: Number.isInteger(Number(s.branchIndex)) && Number(s.branchIndex) > 0
          ? Number(s.branchIndex)
          : null,
        branchAutoTitlePending: !!s.branchAutoTitlePending,
        // T10: include resume-meta in persist payload so main.js merge has the latest
        codexSid: s.codexSid || null,
        acpSid:s.acpSid || null,acpProfileId:s.acpProfileId || null,acpCapabilities:s.acpCapabilities || null,
        runtimeBackend: s.runtimeBackend || null,
        nativeRuntime: s.nativeRuntime || null,
        // PTY 会话的原生后端与快照是故意置空的；带上标记，落盘时才不会继承原生时代的旧值。
        agentRuntime: s.agentRuntime === 'pty' ? 'pty' : null,
        codexApprovalPolicy: s.codexApprovalPolicy || null,
        codexSandbox: s.codexSandbox || null,
        codexSessionsRoot: s.codexSessionsRoot || null,
        codexAllowMtimeFallback: !!s.codexAllowMtimeFallback,
        codexProfile: s.codexProfile || null,
        codexProfileLabel: s.codexProfileLabel || null,
        mcpProfile: s.mcpProfile || null,
        fastMode: typeof s.fastMode === 'boolean' ? s.fastMode : null,
        codexSpeedTier: s.codexSpeedTier || null,
        geminiChatId: s.geminiChatId || null,
        geminiProjectHash: s.geminiProjectHash || null,
        geminiProjectRoot: s.geminiProjectRoot || null,
        kimiSid: s.kimiSid || null,
        kimiSessionDir: s.kimiSessionDir || null,
        purpose: s.purpose || null,
        researchSessionId: s.researchSessionId || null,
        hiddenFromSidebar: !!s.hiddenFromSidebar,
        completionNotificationEnabled: s.completionNotificationEnabled === true,
      });
    }
        //   slotSpecs/covenantText 全被剥掉 → 写残 state.json → 重启后 restoreMeeting fallback
    //   scene='general'，所有 AI 群聊退化为通用场景（投研 ResearchAgent MCP 不挂入）。
    //   修：补全所有 createMeeting 写入 + setMeetingContext 维护的持久化字段。
    //   main.js persist-sessions handler 端加了 fallback 兜底，但渲染端先把字段补全是第一道防线。
    const meetingList = Object.values(meetings).map(m => ({
      id: m.id, type: 'meeting', title: m.title, subSessions: m.subSessions,
      layout: m.layout, focusedSub: m.focusedSub, syncContext: m.syncContext,
      sendTarget: m.sendTarget, createdAt: m.createdAt, lastMessageTime: m.lastMessageTime,
      lastCompletedAt: typeof m.lastCompletedAt === 'number' ? m.lastCompletedAt : null,
      pinned: !!m.pinned, bottomed: !!m.bottomed && !m.pinned, lastScene: m.lastScene || null,
      scene: m.scene, mode: m.mode,
      userRenamed: !!m.userRenamed,
      autoTitlePending: !!m.autoTitlePending,
      autoTitleGenerated: !!m.autoTitleGenerated,
      workspace: m.workspace || null,
      workspaceLabel: m.workspaceLabel || null,
      participants: Array.isArray(m.participants) ? m.participants : null,
      slotSpecs: Array.isArray(m.slotSpecs) ? m.slotSpecs : null,
      covenantText: m.covenantText || '',
      serialWorkflow: (m.serialWorkflow && typeof m.serialWorkflow === 'object') ? m.serialWorkflow : null,
      orchestration: (m.orchestration && typeof m.orchestration === 'object') ? m.orchestration : null,
      completionNotificationEnabled: m.completionNotificationEnabled === true,
    }));
    if (flush) return ipcRenderer.invoke('persist-sessions:flush', list, meetingList);
    ipcRenderer.send('persist-sessions', list, meetingList);
}
// 暴露给 meeting-room.js 等 renderer 子模块：配置变更后可主动落 state.json
window.schedulePersist = schedulePersist;
// Hub shutdown: send the newest workscene immediately instead of waiting out
// the persist throttle, so the final save carries the last few seconds.
// The ack goes out after persist-sessions on the same channel order, so Main
// knows the workscene arrived before it runs the final save.
ipcRenderer.on('hub:flush-workscene', (_event, { requestId } = {}) => {
  if (persistDebounceTimer) { clearTimeout(persistDebounceTimer); persistDebounceTimer = null; }
  try { persistWorkscene(); }
  finally { ipcRenderer.send('hub:flush-workscene:done', requestId); }
});

const restartController = require('./hub-restart-controller').createHubRestartController({document,ipcRenderer,
  flush:async () => {
    await Promise.all([...nativeDraftControllers.values()].map(controller=>controller.flush()));
    await persistWorkscene(true);
  },
  getView:() => ({activeSessionId,meetingId:MeetingRoom.getActiveMeetingId?.() || null,
    waitingSessionIds:[...sessions.values()].filter(s=>getSessionRuntimeTruth(s).state===RUNTIME_WAITING).map(s=>s.id)}),
  restoreView:async view => {
    if (view.meetingId && meetings[view.meetingId]) {
      await MeetingRoom.openMeeting(view.meetingId,meetings[view.meetingId]);
    } else if (view.activeSessionId && sessions.has(view.activeSessionId) && sessions.get(view.activeSessionId).status !== 'dormant') await selectSession(view.activeSessionId);
  },
});

// Wake a dormant session: call main to spawn PTY with --resume, then wait for
// session-created which will replace the dormant entry.
async function resumeDormantSession(hubId, opts = {}) {
  const existingPending = _pendingDormantResumes.get(hubId);
  if (existingPending) {
    if (opts.forceScrollBottom === true) existingPending.forceScrollBottom = true;
    return existingPending.promise || null;
  }
  const dormant = sessions.get(hubId);
  if (!dormant || dormant.status !== 'dormant') return dormant || null;
  const pendingResume = {
    forceScrollBottom: opts.forceScrollBottom === true,
    promise: null,
  };
  _pendingDormantResumes.set(hubId, pendingResume);
  dormant._resumePending = true;
  paintSidebarResumePending(hubId, true);
  scheduleSessionListRender();
  // Keep title / pinned / preview so UI stays stable through the resume.
  let resumed;
  try {
    // Dormant wake, workspace archive and right-click Restart share one exact
    // provider-native metadata contract.  This prevents Codex-only fields such
    // as profile / MCP policy / rollout root from disappearing on one path.
    pendingResume.promise = ipcRenderer.invoke('resume-session', buildSessionResumeMeta(dormant));
    resumed = await pendingResume.promise;
  } catch (error) {
    if (_pendingDormantResumes.get(hubId) === pendingResume) {
      _pendingDormantResumes.delete(hubId);
    }
    dormant._resumePending = false;
    paintSidebarResumePending(hubId, false);
    scheduleSessionListRender();
    throw error;
  }
  if (resumed && resumed.cwdFellBackFrom) {
    require('./ui-feedback').showHubAlert(`原工作目录已不存在：\n${resumed.cwdFellBackFrom}\n\n会话已回落到：\n${resumed.cwd}\n\n请先重定位或归档 workspace；不要在聚合根继续写文件。`);
  }
  // v0.13 · P0 #2: 不再反向清零 dormant 累积的 unread。睡前积压的对话用户还
  // 没看 → 应保留到真正进入终端；普通会话由 session-created 展示终端时清零，
  // 群聊成员的后台唤醒则等用户 selectSession 后再清零。
  const s = sessions.get(hubId);
  // ipcRenderer.invoke 的响应与 session-created 推送是两条消息；响应极快时
  // 推送未必已经更新本地 Map。先用返回值做幂等合并，防止紧邻的下一步
  // 仍把同一 hubId 当 dormant 再启动一次 PTY。
  if (s && resumed && s.status === 'dormant') {
    sessions.set(hubId, {
      ...s,
      ...resumed,
      status: 'idle',
      _resumePending: false,
      pinned: !!s.pinned,
      bottomed: !!s.bottomed && !s.pinned,
      unreadCount: s.unreadCount || 0,
      suspendedAt: null,
      suspendReason: null,
      ccSessionId: resumed.ccSessionId || s.ccSessionId,
      transcriptPath: resumed.transcriptPath || s.transcriptPath,
      lastOutputPreview: s.lastOutputPreview,
    });
  }
  if (s) scheduleSessionListRender();
  return resumed || null;
}
window.resumeDormantSession = resumeDormantSession;

function createSecondarySessionView(sessionId, panel, options = {}) {
  const session = sessions.get(sessionId);
  return require('./split-session-view').createSplitSessionView({
    document, window, sessionId, panel,
    rendererOptions: {
      navigator, CSS, marked, DOMPurify, formatAbsoluteTime, normalizeMarkdownPathBreaks, escapeHtml,
      copyText: (text, options) => clipboardController.copyText(text, options),
      wrapPathLinksInElement, getSessionContext: id => sessions.get(id),
      openAttachment: (target, opts) => openPathInHub(target, opts),
      readToolResult: reference => ipcRenderer.invoke(reference.source === 'claude-stream-json' ? 'claude-native:tool-result' : reference.source === 'claude-transcript-file' ? 'claude-transcript:tool-result' : reference.source === 'codex-app-server' ? 'codex-native:tool-result' : 'acp:tool-result', reference),
      renderMathInElement: window.renderMathInElement,
    },
    services: {
      ipc: ipcRenderer,
      session: () => sessions.get(sessionId),
      initialMode: () => options.groupMember ? 'card' : selectionViewModeForSession(sessionId, session),
      parse: payload => ipcRenderer.invoke('parse-session-transcript', payload),
      welcome: value => options.groupMember ? '<div class="split-empty"><strong>等待成员回复</strong><p>在下方群聊输入框提问，此处显示该成员的完整记录。</p></div>' : require('./session-welcome').renderSessionWelcome(value, escapeHtml),
      mountTerminal(host, pane) {
        const cached = getOrCreateTerminal(sessionId);
        const container = document.createElement('div'); container.className = 'terminal-container';
        host.prepend(container); container.append(cached.container); cached.container.style.display = 'block';
        if (!cached.opened) {
          cached.terminal.open(cached.container); cached.opened = true;
          setupImageHover(cached.terminal, cached.container);
          void hydrateTerminalFromSnapshot(sessionId, cached);
        }
        if (cached._floatingInput) { cached._floatingInput.dispose(); cached._floatingInput = null; }
        const input = session.readOnly || options.groupMember ? null : mountFloatingInput(sessionId, container, cached.terminal, pane);
        cached._floatingInput = input;
        const memberControls = options.groupMember ? createCodexNativeControls({ document, sessionId,
          invoke: (channel, payload) => ipcRenderer.invoke(channel, payload), openExternal: url => shell.openExternal(url) }) : null;
        const memberClaudeControls = options.groupMember ? require('./claude-native-controls').createClaudeNativeControls({ sessionId, ipcRenderer,
          onHistory: pane.history,
          onRestoreDraft: record => {
            if ((record.content || []).some(block => block.type !== 'text')) throw new Error('请从成员历史核对并恢复附件');
            const box = document.getElementById('mr-input-box');
            if (box.textContent.trim()) throw new Error('群聊输入框已有草稿，请先保存或发送');
            const m = MeetingRoom.getMeetingData(MeetingRoom.getActiveMeetingId());
            const index = m.subSessions.indexOf(sessionId);
            box.textContent = '@' + (m.slotSpecs?.[index]?.memberId || 'm' + (index + 1)) + ' ' + record.text;
            box.dispatchEvent(new Event('input', { bubbles:true })); box.focus();
          } }) : null;
        for (const control of [memberControls, memberClaudeControls]) if (control) { host.append(control.element); control.update(sessions.get(sessionId)); }
        if (isNativeAgent(session)) {
          cached._codexBackstage ||= createCodexBackstage({ document, ipcRenderer, sessionId,
            getSession: () => sessions.get(sessionId),
            renderProse: text => DOMPurify.sanitize(marked.parse(text, { async: false }), { FORBID_TAGS: ['img', 'video', 'audio', 'iframe'] }),
            onModeChange: mode => { cached._backstageReadable = mode !== 'legacy'; },
            focusComposer: () => host.querySelector('.floating-input-box')?.focus(),
          });
          cached._codexBackstage.mount(container);
        }
        let shown = true, viewMode = 'card';
        const resize = () => {
          if (!shown || !cached.container.isConnected) return;
          scheduleFitAndResizeTerminal(sessionId, cached);
        };
        const observer = new ResizeObserver(resize); observer.observe(container);
        return {
          resize,
          setMode(mode, visible) {
            viewMode = mode; shown = visible;
            cached._codexBackstage?.setVisible(visible && mode === 'pty');
            if (visible && mode === 'pty' && !cached._backstageReadable) loadGpuRenderer(cached); else unloadGpuRenderer(cached);
            resize();
          },
          updateStatus({clockOnly=false,now=Date.now()}={}) {
            const current = sessions.get(sessionId);
            if (current) memberControls?.update(current);
            if (current) memberClaudeControls?.update(current);
            const bar = host.querySelector('.floating-input-bar');
            if (current) {
              if(clockOnly)bar?._paintComposerClock?.(current,now);
              else bar?._paintComposer?.(current,now);
            }
            if (viewMode === 'pty') cached._codexBackstage?.updateStatus();
          },
          dispose() {
            observer.disconnect(); input?.dispose();
            memberControls?.element.remove();
            memberClaudeControls?.element.remove();
            if (cached._floatingInput === input) cached._floatingInput = null;
            cached._codexBackstage?.setVisible(false); unloadGpuRenderer(cached);
            cached.container.remove();
          },
        };
      },
    },
  });
}

sessionSplit = require('./session-split').createSessionSplit({
  document, window, primary: terminalPanelEl, buttons: document.getElementById('session-layout-buttons'),
  services: {
    primaryId: () => activeSessionId,
    sessions: () => [...sessions.values()], session: id => sessions.get(id),
    otherView: () => currentAppToolbarView(),
    selectPrimary: (id, opts) => selectSession(id, opts),
    focusPrimary: () => terminalPanelEl.querySelector('.floating-input-box')?.focus(),
    openStatus: id => ipcRenderer.invoke('session:open-status', id),
    ensureOpen: id => resumeDormantSession(id),
    createView: createSecondarySessionView,
    sameIdentity: (a, b) => !!(a && b && ((a.codexSid && a.codexSid === b.codexSid) || (a.ccSessionId && a.ccSessionId === b.ccSessionId))),
    alert: message => require('./ui-feedback').showHubAlert(message),
    onFocus: id => {
      ipcRenderer.send('focus-session', { sessionId: id });
      completionNotificationToggle?.refreshTarget();
      scheduleAppToolbarRefresh();
    },
    resize: () => {
      const cached = terminalCache.get(activeSessionId);
      if (cached) scheduleFitAndResizeTerminal(activeSessionId, cached);
    },
  },
});

// --- Init ---
sessionImmersive = require('./session-immersive').createSessionImmersiveController({
  document, ipcRenderer,
  getSurface: getReadingSurface,
  getSessionId: getReadingIdentity,
  refit: () => { refitActiveTerminalFromPreview(); sessionSplit.secondary()?.resize(); },
  onError: message => showToast(`沉浸模式切换失败：${message}`, 'error'),
});
(async () => {
  traceRendererStartup('init ipc start');
  const [existing, persisted, dormantMeetings] = await Promise.all([
    ipcRenderer.invoke('get-sessions').catch(() => []),
    ipcRenderer.invoke('get-dormant-sessions').catch(() => null),
    ipcRenderer.invoke('get-dormant-meetings').catch(() => null),
  ]);
  traceRendererStartup(`init ipc done existing=${existing.length} persisted=${persisted && Array.isArray(persisted.sessions) ? persisted.sessions.length : 0} meetings=${Array.isArray(dormantMeetings) ? dormantMeetings.length : 0}`);

  let migratedLegacyBranchTitles = 0;
  let healedUnsafeSessionModels = 0;
  for (const s of existing) {
    const migrated = migrateLegacyBranchSessionMeta(s);
    if (migrated !== s) migratedLegacyBranchTitles += 1;
    const current = nativeSessionBootstrap.merge(migrated, sessions.get(migrated.id));
    if (current) sessions.set(migrated.id, current);
  }

  if (persisted && Array.isArray(persisted.sessions)) {
    for (const meta of persisted.sessions) {
      const migratedMeta = migrateLegacyBranchSessionMeta(meta);
      if (migratedMeta !== meta) {
        Object.assign(meta, migratedMeta);
        migratedLegacyBranchTitles += 1;
      }
      if (sessions.has(meta.hubId) || nativeSessionBootstrap.removed(meta.hubId)) continue;
      // 2026-05-05 dormant 加载 fallback：state.json 里历史 dormant session 的
      // currentModel 大量为 null（main.js:2694 RESUME_META_FIELDS 字段名拼错导致
      // 一旦写入 null 就永久污染，已在同次提交修）。这里给老污染数据按 kind 推断
      // 一个合理默认（model-options.js 清单首项），避免唤醒时 spawn 用最离谱的默认。
      let resolvedModel = meta.currentModel || null;
      const safePersistedModel = sessionModelId(meta);
      if (safePersistedModel && (!resolvedModel || resolvedModel.id !== safePersistedModel)) {
        const option = modelOptionsFor(meta.kind || 'claude').find(item => item.id === safePersistedModel);
        resolvedModel = { id: safePersistedModel, displayName: option ? option.label : safePersistedModel };
        meta.currentModel = resolvedModel;
        healedUnsafeSessionModels += 1;
      }
      if (!resolvedModel || !resolvedModel.id) {
        const opts = modelOptionsFor(meta.kind || 'claude');
        if (opts.length > 0) {
          resolvedModel = { id: opts[0].id, displayName: opts[0].label };
        }
      }
      sessions.set(meta.hubId, {
        id: meta.hubId,
        kind: meta.kind || 'claude',
        title: normalizeLegacyBranchSessionTitle(meta.title) || 'Claude',
        status: 'dormant',
        lastMessageTime: meta.lastMessageTime || Date.now(),
        lastOutputPreview: meta.lastOutputPreview || '',
        unreadCount: meta.unreadCount || 0,
        suspendedAt: meta.suspendedAt || null,
        suspendReason: meta.suspendReason || null,
        connectionIssue: meta.connectionIssue && typeof meta.connectionIssue === 'object'
          ? { ...meta.connectionIssue }
          : null,
        _connectionIssueAck: meta._connectionIssueAck && typeof meta._connectionIssueAck === 'object'
          ? { ...meta._connectionIssueAck }
          : null,
        createdAt: meta.lastMessageTime || Date.now(),
        cwd: meta.cwd || null,
        cwdFellBackFrom: meta.cwdFellBackFrom || null,
        memoryLinkWarning: meta.memoryLinkWarning || null,
        workspaceLabel: meta.workspaceLabel || null,
        pinned: !!meta.pinned,
        bottomed: !!meta.bottomed && !meta.pinned,
        ccSessionId: meta.ccSessionId || null,
        ...(meta.runtimeBackend === 'claude-stream-json' ? { nativeConfig: meta.nativeConfig } : {}),
        transcriptPath: meta.transcriptPath || null,
        meetingId: meta.meetingId || null,
        currentModel: resolvedModel,
        effort: meta.effort || null,
        contextPct: typeof meta.contextPct === 'number' ? meta.contextPct : null,
        contextUsed: typeof meta.contextUsed === 'number' ? meta.contextUsed : null,
        sessionUsage: meta.sessionUsage || null,
        contextMax: typeof meta.contextMax === 'number' ? meta.contextMax : null,
        contextEffectiveMax: typeof meta.contextEffectiveMax === 'number' ? meta.contextEffectiveMax : null,
        contextEffectiveObservedAt: typeof meta.contextEffectiveObservedAt === 'number'
          ? meta.contextEffectiveObservedAt
          : null,
        runStartedAt: null,
        lastCompletedAt: typeof meta.lastCompletedAt === 'number' ? meta.lastCompletedAt : null,
        lastRunStartedAt: typeof meta.lastRunStartedAt === 'number' ? meta.lastRunStartedAt : null,
        lastRunDurationMs: typeof meta.lastRunDurationMs === 'number' ? meta.lastRunDurationMs : null,
        recentArtifacts: Array.isArray(meta.recentArtifacts) ? meta.recentArtifacts.slice(-8) : [],
        userRenamed: !!meta.userRenamed,
        autoTitleGenerated: !meta.branchAutoTitlePending
          && (!!meta.autoTitleGenerated || isStableSessionTitle(meta.title, meta.kind)),
        branchSourceSessionId: meta.branchSourceSessionId || null,
        branchIndex: Number.isInteger(Number(meta.branchIndex)) && Number(meta.branchIndex) > 0
          ? Number(meta.branchIndex)
          : null,
        branchAutoTitlePending: !!meta.branchAutoTitlePending,
        // T10: preserve resume-meta for precise resume (codex/gemini)
        codexSid: meta.codexSid || null,
        acpSid:meta.acpSid || null,acpProfileId:meta.acpProfileId || null,acpCapabilities:meta.acpCapabilities || null,
        runtimeBackend: meta.runtimeBackend || null,
        nativeRuntime: require('../core/native-agent-runtime.js').persistNativeRuntime(meta),
        codexApprovalPolicy: meta.codexApprovalPolicy || null,
        codexSandbox: meta.codexSandbox || null,
        codexSessionsRoot: meta.codexSessionsRoot || null,
        codexAllowMtimeFallback: !!meta.codexAllowMtimeFallback,
        codexProfile: meta.codexProfile || null,
        codexProfileLabel: meta.codexProfileLabel || null,
        mcpProfile: meta.mcpProfile || null,
        fastMode: typeof meta.fastMode === 'boolean' ? meta.fastMode : null,
        codexSpeedTier: meta.codexSpeedTier || null,
        geminiChatId: meta.geminiChatId || null,
        geminiProjectHash: meta.geminiProjectHash || null,
        geminiProjectRoot: meta.geminiProjectRoot || null,
        kimiSid: meta.kimiSid || null,
        kimiSessionDir: meta.kimiSessionDir || null,
        purpose: meta.purpose || null,
        researchSessionId: meta.researchSessionId || null,
        hiddenFromSidebar: !!meta.hiddenFromSidebar,
        completionNotificationEnabled: meta.completionNotificationEnabled === true,
      });
    }
  }

  nativeSessionBootstrap.finish();
  if (migratedLegacyBranchTitles > 0 || healedUnsafeSessionModels > 0) {
    if (migratedLegacyBranchTitles > 0) {
      console.info(`[session-title] migrated ${migratedLegacyBranchTitles} legacy branch title(s)`);
    }
    if (healedUnsafeSessionModels > 0) {
      console.info(`[session-model] healed ${healedUnsafeSessionModels} unsafe persisted model value(s)`);
    }
    schedulePersist();
  }

  if (Array.isArray(dormantMeetings)) {
    for (const m of dormantMeetings) {
      if (m.layout === 'split') m.layout = 'focus';
      meetings[m.id] = m;
    }
  }

  const collapsedNativeSessions = collapseDormantNativeDuplicates(sessions);
  if (collapsedNativeSessions.length) {
    console.info(`[resume] consolidated ${collapsedNativeSessions.length} duplicate dormant transcript shell(s)`);
    schedulePersist();
  }

  traceRendererStartup('renderSessionList start');
  // Existing unread sessions belong to a previous app lifetime. Prime them as
  // the baseline so boot never replays a wall of stale desktop notifications.
  sessionReadyNotifier.prime();
  renderSessionList();
  if (homeWorkbench) homeWorkbench.render();
  refreshSystemResourceUsage();
  setInterval(refreshSystemResourceUsage, 5000);
  refreshHubProxyInfo();
  setInterval(refreshHubProxyInfo, 15000);
  traceRendererStartup('renderSessionList done');
  ipcRenderer.send('renderer-sidebar-ready');
  traceRendererStartup('renderer-sidebar-ready sent');

  ipcRenderer.invoke('get-hub-config-raw').then((cfg) => {
    if (!cfg) return;
    _deepseekAutoTitleEnabled = !!cfg.deepseekApiKey;
    providerModes.codex = cfg.codexBackend === 'api' ? 'api' : 'subscription';
    setCodexProfileForm(cfg.codexSubscriptionProfiles, cfg.codexSubscriptionProfile);
    turnCardRenderer.setCodeFoldThreshold(cfg.uiCodeFoldThreshold);
    // Usage rows are rendered from the cache promise below.
    traceRendererStartup('hub config loaded');
  }).catch(() => {});

  ipcRenderer.invoke('get-usage-cache').then((cached) => {
    accountUsageController.applyUsageCache(cached);
    if (homeWorkbench) homeWorkbench.render();
    traceRendererStartup('usage cache loaded');
  }).catch(() => { renderAccountUsage(); });
  // 启动兜底默认。必须 remember:false —— 此刻可能已恢复上次的 active 会话，
  // 写记忆会把它自己记住的卡片视图抹掉。
  applyViewMode('pty', { remember: false });
  // 普通启动从工作台进入。初始化期间若用户已经亲手切到别处，不用默认值抢回焦点；
  // 显式的「重启并继续任务」随后仍可恢复原视图。
  const startupView = currentAppToolbarView();
  if (sessionOpenIntent === 0 && !activeMeetingId && (!startupView || startupView === '主页')) escapeToHome();
  await restartController.restore();
})();

// Persist on relevant changes — listen at renderer-level for mutations that
// touch persistable fields. Debounced.
for (const ch of ['session-created', 'session-closed', 'session-suspended', 'session-updated', 'meeting-created', 'meeting-updated', 'meeting-closed']) {
  ipcRenderer.on(ch, () => schedulePersist());
}

// --- Meeting Room IPC events ---
const _groupChatWorkingExpiryTimers = new Map();

function _acceptSidebarGroupChatEvent(payload, options = {}) {
  const decision = acceptGroupChatEvent(payload || {}, { consumer: 'sidebar', ...options });
  return decision.accepted;
}

function _setGroupChatMemberWorking(session, working, now = Date.now(), runtimeOptions = {}) {
  if (isNativeSession(session)) return false;
  if (!session) return false;
  const sid = String(session.id || '');
  const oldTimer = _groupChatWorkingExpiryTimers.get(sid);
  if (oldTimer) clearTimeout(oldTimer);
  _groupChatWorkingExpiryTimers.delete(sid);

  const wasRunning = isGroupChatMemberRunning(session, now);
  if (!working) {
    session.gcWorking = false;
    session._gcWorkingLastTs = null;
    const truth = getSessionRuntimeTruth(session, { now });
    if (String(truth.source || '').startsWith('groupchat-') && truth.state !== RUNTIME_FAILED) {
      observeSessionRuntime(session, {
        state: RUNTIME_COMPLETED,
        source: 'groupchat-watcher-complete',
        confidence: CONFIDENCE_STRONG,
        observedAt: now,
        completedAt: now,
        startedAt: truth.startedAt || 0,
        turnId: truth.turnId || runtimeOptions.turnId || null,
      });
    }
    return wasRunning !== isGroupChatMemberRunning(session, now);
  }

  session.gcWorking = true;
  session._gcWorkingLastTs = now;
  const currentTruth = getSessionRuntimeTruth(session, { now });
  const currentActive = currentTruth.state === RUNTIME_STARTING || currentTruth.state === RUNTIME_RUNNING;
  observeSessionRuntime(session, {
    state: RUNTIME_RUNNING,
    source: 'groupchat-watcher-heartbeat',
    confidence: CONFIDENCE_SEMANTIC,
    observedAt: now,
    startedAt: currentActive ? (currentTruth.startedAt || session.runStartedAt || now) : now,
    expiresAt: now + GC_WORKING_FRESH_MS + 50,
    turnId: runtimeOptions.turnId || null,
  });
  const heartbeatTs = now;
  const timer = setTimeout(() => {
    _groupChatWorkingExpiryTimers.delete(sid);
    if (!session.gcWorking || session._gcWorkingLastTs !== heartbeatTs) return;
    const beforeExpiry = isGroupChatMemberRunning(session, heartbeatTs);
    session.gcWorking = false;
    session._gcWorkingLastTs = null;
    const truth = getSessionRuntimeTruth(session, { now: Date.now() });
    if (String(truth.source || '').startsWith('groupchat-')) {
      observeSessionRuntime(session, {
        state: RUNTIME_UNKNOWN,
        source: 'groupchat-watcher-expired',
        confidence: CONFIDENCE_INFERRED,
        observedAt: Date.now(),
        reason: 'missing-groupchat-terminal-event',
      });
    }
    if (beforeExpiry !== isGroupChatMemberRunning(session, Date.now())) {
      scheduleSessionListRender();
    }
  }, GC_WORKING_FRESH_MS + 50);
  _groupChatWorkingExpiryTimers.set(sid, timer);
  return wasRunning !== isGroupChatMemberRunning(session, now);
}

ipcRenderer.on('meeting-created', (_e, { meeting }) => {
  meetings[meeting.id] = meeting;
  if (activeMeetingId === meeting.id && typeof MeetingRoom !== 'undefined') {
    MeetingRoom.updateMeetingData(meeting.id, meeting);
  }
  // 2026-05-05 maintainer：新 AI 群聊默认折叠（白名单未命中=折叠）。折叠态侧边栏已显示 3 个迷你
  //   slot 头像跳转按钮，用户能直接点头像进 sub session，不必展开看 slot 列表。
  renderSessionList();
});

ipcRenderer.on('meeting-updated', (_e, { meeting }) => {
  // Unread attention belongs to this window. Backend metadata updates (including
  // the reply's completion timestamp) must not acknowledge unread answers.
  const previous = meetings[meeting.id];
  meetingUnread.preserveMeetingAttention(previous, meeting);
  meetings[meeting.id] = meeting;
  if (meeting.id === activeMeetingId) completionNotificationToggle.refreshTarget();
  if (typeof MeetingRoom !== 'undefined') {
    MeetingRoom.updateMeetingData(meeting.id, meeting);
  }
  scheduleSessionListRender();
});

// 调度器在 prompt 真正发出后立刻公布本轮目标。先据此点亮目标成员，避免等到
// 第一段 streaming 心跳才显示运行中；没被点名的成员同时清掉上一轮残留。
ipcRenderer.on('groupchat-turn-targets', (_event, payload = {}) => {
  if (!_acceptSidebarGroupChatEvent(payload, { allowRunReplacement: true })) return;
  const { meetingId, turnNum, sids } = payload;
  if (!meetingId || !Array.isArray(sids)) return;
  const meeting = meetings[meetingId];
  const targetSids = new Set(sids.map(String));
  const memberSids = new Set([
    ...((meeting && meeting.subSessions) || []).map(String),
    ...targetSids,
  ]);
  let dirty = false;
  for (const sid of memberSids) {
    const sub = sessions.get(sid);
    if (sub) dirty = _setGroupChatMemberWorking(sub, targetSids.has(sid), Date.now(), { turnId: turnNum != null ? String(turnNum) : null }) || dirty;
  }
  if (dirty) scheduleSessionListRender();
});

ipcRenderer.on('groupchat-attempt-changed', (_event, payload = {}) => {
  if (!_acceptSidebarGroupChatEvent(payload, {
    allowRunReplacement: payload.status === 'prepared' || payload.status === 'submitting',
  })) return;
  const { sid, status, providerTurnId, turnNum, failure, updatedAt } = payload;
  if (!sid) return;
  const session = sessions.get(sid);
  if (!session) return;
  const active = ['prepared', 'submitting', 'accepted', 'running', 'awaiting_binding', 'awaiting_final_text', 'recovering'].includes(status);
  const changed = _setGroupChatMemberWorking(session, active, Number(updatedAt) || Date.now(), {
    turnId: providerTurnId || (turnNum != null ? String(turnNum) : null),
  });
  if (status === 'failed' && failure) {
    observeSessionRuntime(session, {
      state: RUNTIME_FAILED,
      source: `groupchat-${failure.code || 'provider-error'}`,
      confidence: CONFIDENCE_AUTHORITATIVE,
      observedAt: Number(updatedAt) || Date.now(),
      turnId: providerTurnId || null,
      reason: failure.code || 'provider_error',
      evidence: failure.summary || failure.detail || null,
    });
  }
  if (changed || status === 'failed') scheduleSessionListRender();
});

// Unread survives round changes and room selection. Only a visible member's
// latest answer or an explicit read action acknowledges that member.
ipcRenderer.on('groupchat-partial-update', (_event, payload = {}) => {
  if (!_acceptSidebarGroupChatEvent(payload)) return;
  const { meetingId, turnNum, sid, status } = payload;
  if (!meetingId || !sid) return;
  // 2026-07-21 maintainer [修状态灯]：群聊成员的"运行中"权威信号取 dispatcher 的 watcher
  //   生命周期（streaming=未结算，终态=已结算），不依赖子会话自己的 hook/transcript
  //   running 管线——避免管线未绑定时 AI 明明在跑、状态灯却常绿。
  const sub = sessions.get(sid);
  if (sub) {
    const nextWorking = status === 'streaming' || status === 'thinking' || status === 'soft_alert';
    if (_setGroupChatMemberWorking(sub, nextWorking, Date.now(), { turnId: turnNum != null ? String(turnNum) : null })) scheduleSessionListRender();
  }
  if (status !== 'completed' && status !== 'manual_extracted') return;
  const meeting = meetings[meetingId];
  if (!meeting) return;
  const overlay = document.getElementById('msg-overlay');
  const seenByUser = activeSessionId === sid && document.hasFocus() && !document.hidden
    && (currentView === 'pty' || (overlay && _isCardOverlayAtBottom(overlay)));
  meetingUnread.recordMeetingAnswer(meeting, payload, { seenByUser });
  scheduleSessionListRender();
});

// 2026-05-05 maintainer 修3：AI 群聊 turn-complete IPC → 触发侧栏排序刷新（最新答完的 AI 群聊靠前）。
//   2026-05-31 maintainer：旧版在这里 unreadCount++ 作"轮粒度未读"，已被 partial-update 聚合的"本轮已答 AI 数"取代。
//   同 IPC 在 meeting-room.js 里也有监听器（cache 同步 + DOM 重渲），与本监听器职责正交。
ipcRenderer.on('groupchat-turn-complete', (_event, payload = {}) => {
  if (!_acceptSidebarGroupChatEvent(payload)) return;
  const { meetingId, turnNum, completedAt } = payload;
  if (!meetingId) return;
  const meeting = meetings[meetingId];
  if (!meeting) return;
  if (window.WorkspaceController) void window.WorkspaceController.maybePromptMeetingArchive(meetingId);
  const answerAt = normalizeEventTime(completedAt, Date.now());
  meeting.lastCompletedAt = Math.max(Number(meeting.lastCompletedAt) || 0, answerAt);
  meeting.lastMessageTime = meeting.lastCompletedAt;
  ipcRenderer.send('update-meeting', {
    meetingId,
    fields: { lastMessageTime: meeting.lastMessageTime, lastCompletedAt: meeting.lastCompletedAt },
  });
  // 2026-07-21 maintainer [修状态灯]：轮次收尾兜底清 gcWorking（覆盖 superseded 等
  //   不经 partial-update 终态的路径，防止状态灯卡在黄灯）。
  for (const sid of meeting.subSessions || []) {
    const s = sessions.get(sid);
    if (s) _setGroupChatMemberWorking(s, false, answerAt, { turnId: turnNum != null ? String(turnNum) : null });
  }
  scheduleSessionListRender();
  schedulePersist();
});

ipcRenderer.on('meeting-closed', (_e, { meetingId }) => {
  dropPreviewContext(`meeting:${meetingId}`);
  delete meetings[meetingId];
  if (_expandedMeetings.has(meetingId)) {
    _expandedMeetings.delete(meetingId);
    _persistExpandedMeetings();
  }
  if (activeMeetingId === meetingId) {
    activeMeetingId = null;
    if (fileManagerPanel) fileManagerPanel.close();
    if (typeof MeetingRoom !== 'undefined') MeetingRoom.closeMeetingPanel();
    if (emptyStateEl) emptyStateEl.style.display = '';
    if (terminalPanelEl) terminalPanelEl.classList.add('home-active');
  }
  renderSessionList();
});

if (process && process.env && process.env.CLAUDE_HUB_E2E === '1') {
  const provideTerminalLinksForE2E = (sessionId, lineNumber) => new Promise((resolve) => {
    const cached = terminalCache.get(sessionId);
    const provider = cached && cached._localPathLinkProvider;
    if (!provider || typeof provider.provideLinks !== 'function') { resolve([]); return; }
    provider.provideLinks(lineNumber, links => resolve(Array.isArray(links) ? links : []));
  });
  // Feature modules register their own isolated E2E bridges before this late
  // renderer block. Merge instead of replacing the namespace, otherwise a
  // perfectly working module (for example global session search) disappears
  // only in tests and makes the real UI impossible to drive end-to-end.
  window.__hubE2E = {
    ...(window.__hubE2E || {}),
    selectMeeting: (meetingId, opts) => selectMeeting(meetingId, opts),
    selectSession: (sessionId, opts) => selectSession(sessionId, opts),
    getActiveMeetingId: () => activeMeetingId,
    getMeeting: (meetingId) => meetings[meetingId] || null,
    terminalCacheStats: () => ({
      size: terminalCache.size,
      ids: [...terminalCache.keys()],
      max: null,
      policy: TERMINAL_CACHE_POLICY,
      opened: [...terminalCache.values()].filter(item => item.opened).length,
      rendererSurfaces: [...terminalCache.values()].filter(item => !!item._rendererAddon).length,
      rendererModes: [...terminalCache.values()].reduce((acc, item) => {
        const mode = item._rendererMode || 'suspended';
        acc[mode] = (acc[mode] || 0) + 1;
        return acc;
      }, {}),
    }),
    // Snapshot recovery still needs direct coverage even though production no
    // longer evicts live sessions by count. This hook exists only in isolated
    // CLAUDE_HUB_E2E renderers and cannot affect the production Hub.
    disposeTerminal: (sessionId) => disposeCachedTerminal(sessionId),
    terminalBufferText: (sessionId, maxLines = 120) => {
      const cached = terminalCache.get(sessionId);
      if (!cached || !cached.terminal || !cached.terminal.buffer) return '';
      const buffer = cached.terminal.buffer.active;
      const end = Math.min(buffer.length, buffer.baseY + buffer.cursorY + 1);
      const start = Math.max(0, end - Math.max(1, Number(maxLines) || 120));
      const lines = [];
      for (let index = start; index < end; index += 1) {
        const line = buffer.getLine(index);
        if (line) lines.push(line.translateToString(true));
      }
      return lines.join('\n');
    },
    terminalFindLine: (sessionId, needle) => {
      const cached = terminalCache.get(sessionId);
      if (!cached || !cached.terminal) return 0;
      const buffer = cached.terminal.buffer.active;
      for (let index = 0; index < buffer.length; index += 1) {
        const text = buffer.getLine(index)?.translateToString(true) || '';
        if (text.includes(String(needle || ''))) return index + 1;
      }
      return 0;
    },
    terminalFindLastLine: (sessionId, needle) => {
      const cached = terminalCache.get(sessionId);
      if (!cached || !cached.terminal) return 0;
      const buffer = cached.terminal.buffer.active;
      for (let index = buffer.length - 1; index >= 0; index -= 1) {
        const text = buffer.getLine(index)?.translateToString(true) || '';
        if (text.includes(String(needle || ''))) return index + 1;
      }
      return 0;
    },
    terminalLinks: async (sessionId, lineNumber) => {
      const links = await provideTerminalLinksForE2E(sessionId, lineNumber);
      return links.map(link => ({ text: link.text, range: link.range }));
    },
    activateTerminalLink: async (sessionId, lineNumber, linkIndex = 0) => {
      const links = await provideTerminalLinksForE2E(sessionId, lineNumber);
      const link = links[linkIndex];
      if (!link) return null;
      await link.activate({ button: 0, clientX: 0, clientY: 0 });
      return { text: link.text, range: link.range };
    },
    terminalLinkGeometry: async (sessionId, lineNumber, linkIndex = 0) => {
      const cached = terminalCache.get(sessionId);
      if (!cached || !cached.terminal) return null;
      const links = await provideTerminalLinksForE2E(sessionId, lineNumber);
      const link = links[linkIndex];
      const screen = cached.container.querySelector('.xterm-screen');
      const dimensions = cached.terminal._core?._renderService?.dimensions?.css?.cell;
      if (!link || !screen || !dimensions) return null;
      const rect = screen.getBoundingClientRect();
      const buffer = cached.terminal.buffer.active;
      let viewportY = buffer.viewportY;
      let row = link.range.start.y - 1 - viewportY;
      if (row < 0 || row >= cached.terminal.rows) {
        try { cached.terminal.scrollToLine(link.range.start.y - 1); } catch {}
        viewportY = buffer.viewportY;
        row = link.range.start.y - 1 - viewportY;
      }
      return {
        text: link.text,
        range: link.range,
        viewportY,
        row,
        x: rect.left + (((link.range.start.x + link.range.end.x) / 2) - 0.5) * dimensions.width,
        y: rect.top + (row + 0.5) * dimensions.height,
      };
    },
    terminalLinkActivationStats: (sessionId) => {
      const provider = terminalCache.get(sessionId)?._localPathLinkProvider;
      return provider && typeof provider.getActivationStats === 'function'
        ? provider.getActivationStats()
        : null;
    },
    previewWorkbench: {
      state: key => previewPanel.getPreviewState(key),
      watchStats: () => previewPanel.getFileWatchStats(),
      findState: () => previewPanel.getPreviewFindState(),
    },
    clipboard: {
      copyText: text => clipboardController.copyText(text, { source: 'e2e' }),
      feedbackText: () => document.getElementById('hub-copy-feedback')?.innerText || '',
    },
    desktopNotifications: {
      state: () => sessionReadyNotifier.getState(),
      scan: () => sessionReadyNotifier.scan(),
    },
    cardLiveRefresh: {
      noteOutput: sessionId => noteCardTerminalOutput(sessionId),
      dispose: sessionId => clearCardLiveRefreshState(sessionId),
      state: sessionId => {
        const reload = window._cardReloadState && window._cardReloadState.get(sessionId);
        const settle = window._cardStopFallbackBySid && window._cardStopFallbackBySid.get(sessionId);
        return {
          reload: reload ? {
            lastReloadAt: reload.lastReloadAt || 0,
            pending: !!reload.pendingTimer,
            inProgress: !!reload.inProgress,
            queued: !!reload.queued,
            lastReason: reload.lastReason || null,
          } : null,
          settle: settle ? {
            index: Number(settle.index) || 0,
            pending: !!settle.timer,
          } : null,
        };
      },
    },
    terminalLiveScreenText: (sessionId) => terminalActivityMonitor.extractLiveScreenLines(sessionId).join('\n'),
    cardQuestionNavigator: {
      refresh: () => cardQuestionNavigator.refresh(),
      state: () => cardQuestionNavigator.getState(),
      update: () => cardQuestionNavigator.updateActive(),
      scrollTo: index => cardQuestionNavigator.scrollToQuestion(index),
      mountFixture: ({ sessionId = 'card-question-nav-e2e', start = 1, count = 6, clear = true } = {}) => {
        if (clear) {
          sessions.set(sessionId, {
            id: sessionId,
            kind: 'codex',
            title: '问题导航 E2E',
            status: 'idle',
            createdAt: Date.now(),
            lastMessageTime: Date.now(),
          });
          activeMeetingId = null;
          activeSessionId = sessionId;
          currentView = 'card';
          _cardHistoryHydratedSid = sessionId;
          if (window.__studyHide) window.__studyHide();   // 同上：别和学习面板并排
          if (window.__assistantHide) window.__assistantHide();
          if (window.__writingHide) window.__writingHide(); // 2026-09-30 写作面板互斥
          if (window.__ranHide) window.__ranHide(); // 2026-09-04 RAN 工作台面板互斥
          terminalPanelEl.style.display = '';
          terminalPanelEl.classList.remove('home-active');
          emptyStateEl.style.display = 'none';
          const overlay = document.getElementById('msg-overlay');
          overlay.innerHTML = '';
          overlay.classList.remove('hidden');
          window._sessionTurns.clear();
        }
        const answerParagraph = '这是用于拉开卡片距离的回答段落，保持真实 Markdown 卡片的高度和滚动行为。';
        for (let offset = 0; offset < count; offset += 1) {
          const index = start + offset;
          window._mountSessionTurnCard(sessionId, {
            id: `question-${index}`,
            role: 'user',
            kind: 'codex',
            text: index === 7
              ? '问题 7：这是实时追加的新问题，导航轨应自动出现新节点。'
              : `问题 ${index}：请分析第 ${index} 个方案的收益、风险与下一步。`,
            ts: Date.now() + offset * 2,
          }, { kind: 'codex' });
          window._mountSessionTurnCard(sessionId, {
            id: `answer-${index}`,
            role: 'assistant',
            kind: 'codex',
            text: `### 回答 ${index}\n\n${Array(7).fill(answerParagraph).join('\n\n')}`,
            ts: Date.now() + offset * 2 + 1,
          }, { kind: 'codex' });
        }
        const overlay = document.getElementById('msg-overlay');
        if (clear) overlay.scrollTop = 0;
        const navStartedAt = performance.now();
        const state = cardQuestionNavigator.refresh();
        return {
          sid: sessionId,
          state,
          navRefreshMs: performance.now() - navStartedAt,
          scrollHeight: overlay.scrollHeight,
          clientHeight: overlay.clientHeight,
        };
      },
      setViewMode: mode => applyViewMode(mode),
      preservePanel: () => preserveAndClearTerminalPanel(),
    },
    probeTerminalReplayResponsiveness: async () => {
      const terminal = new Terminal({ cols: 200, rows: 40, scrollback: 10000, allowProposedApi: true });
      const line = `REPLAY-LINE ${'x'.repeat(186)}\r\n`;
      const text = `\x1b[2J\x1b[H${line.repeat(12000)}`;
      const delays = [];
      let expected = performance.now() + 10;
      const timer = setInterval(() => {
        const now = performance.now();
        delays.push(Math.max(0, now - expected));
        expected = now + 10;
      }, 10);
      const startedAt = performance.now();
      try {
        await replayTerminalSnapshot({ terminal }, { text, operations: null });
        await new Promise(resolve => setTimeout(resolve, 40));
        return {
          bytes: text.length,
          elapsedMs: performance.now() - startedAt,
          heartbeatCount: delays.length,
          maxHeartbeatDelayMs: Math.max(0, ...delays),
        };
      } finally {
        clearInterval(timer);
        try { terminal.dispose(); } catch {}
      }
    },
    applyTerminalRuntimeFrame: (sessionId, lines, observedAt = Date.now()) => {
      const session = sessions.get(sessionId);
      if (!session) return null;
      const runtime = classifySessionRuntimeFrame(session, Array.isArray(lines) ? lines : []);
      const changed = applyPtyRuntimeObservation(session, runtime, observedAt);
      return {
        changed,
        runtime,
        status: session.status,
        runSource: session._runSource || null,
        agentWorking: session._agentWorking || null,
      };
    },
    applyStreamFailure: (sessionId, message, options = {}) => {
      const detected = detectStreamDisconnect(message);
      if (!detected) return { raised: false, issue: null };
      const issue = {
        ...detected,
        occurrenceId: options.occurrenceId || null,
        turnId: options.turnId || null,
      };
      const raised = raiseStreamDisconnectFailure(sessionId, issue, options);
      const session = sessions.get(sessionId);
      return {
        raised,
        issue: session && session.connectionIssue ? { ...session.connectionIssue } : null,
        runtime: session ? getSessionRuntimeTruth(session) : null,
      };
    },
    acknowledgeSessionFailure: (sessionId) => acknowledgeSessionFailureState(sessionId),
    sidebarRenderCoalescerStats: () => sidebarRenderCoalescer.stats(),
    sidebarRenderStats: () => sessionListRenderer.getRenderStats(),
    // 侧栏时间分组 E2E：注入指定 lastMessageTime 的测试会话并重渲，读分组 DOM。
    addFakeSession: (s) => {
      const id = s && s.id; if (!id) return;
      sessions.set(id, Object.assign(
        { id, kind: 'claude', title: id, status: 'idle', lastMessageTime: Date.now(), createdAt: Date.now() }, s));
      renderSessionList();
    },
    addFakeSessions: (items) => {
      for (const s of Array.isArray(items) ? items : []) {
        const id = s && s.id;
        if (!id) continue;
        sessions.set(id, Object.assign(
          { id, kind: 'claude', title: id, status: 'idle', lastMessageTime: Date.now(), createdAt: Date.now() }, s));
      }
      const startedAt = performance.now();
      renderSessionList();
      return { count: sessions.size, renderMs: performance.now() - startedAt };
    },
    clearSessions: () => { sessions.clear(); renderSessionList(); },
    sidebarGroups: () => Array.prototype.map.call(
      document.querySelectorAll('.session-time-group-header'),
      (h) => ({ key: h.dataset.timeGroup, expanded: h.classList.contains('expanded'), count: (h.querySelector('.stg-count') || {}).textContent })),
    sidebarTopItemCount: () => document.querySelectorAll('#session-list .session-item:not(.child)').length,
    clickTimeGroup: (key) => { const h = document.querySelector('.session-time-group-header[data-time-group="' + key + '"]'); if (h) h.click(); },
  };
}
