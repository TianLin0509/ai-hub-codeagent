'use strict';

// Provider-aware classifier for the *live PTY screen*.
//
// Raw byte activity is not a reliable AI-running signal: both Claude Code and
// Codex repaint idle footers/cursors. Conversely, transcript hooks can be late
// or missing while the terminal already shows that the CLI returned to its
// input box. This module only accepts strong, current-screen UI markers and is
// intentionally conservative when the frame is ambiguous.

const RUNTIME_RUNNING = 'running';
const RUNTIME_IDLE = 'idle';
const RUNTIME_WAITING = 'waiting';
const RUNTIME_UNKNOWN = 'unknown';
const RUNNING_ANIMATION_CONFIRM_MIN_MS = 200;
const RUNNING_ANIMATION_CONFIRM_MAX_MS = 3000;

// Treat only Codex's structured live status row as authoritative running
// evidence. A prose answer or documentation snippet may quote "esc to
// interrupt"; matching that text anywhere on screen would resurrect an idle
// session incorrectly. The active row is rendered with a provider marker and
// a small, known family of work verbs.
const CODEX_RUNNING_RE = /^\s*[\u2022\u23fa\u25cf\u25c9\u25d0-\u25d5]\s*(?:Working|Thinking|Running|Searching|Reading|Writing|Editing|Exploring|Generating|Pursuing\s+goal)\b.*\besc to interrupt\b/i;
// 0.157 fullscreen renders the status without a leading bullet. Require its
// elapsed timer and interrupt hint together, so ordinary prose is not work.
const CODEX_FULLSCREEN_RUNNING_RE = /^\s*(?:Working|Thinking|Running|Searching|Reading|Writing|Editing|Exploring|Generating|Pursuing\s+goal)\s+\((?:\d+[hms]\s*)+[•·]\s*esc to interrupt\)(?:\s+·.*)?\s*$/i;
const CODEX_PROMPT_RE = /^\s*[\u203a>]\s*(?:$|\S)/;
const CODEX_CONTEXT_RE = /\bContext\s+(?:\d+(?:\.\d+)?%\s*(?:left)?|window|left)/i;

// Claude 2.1.28x 的底栏随权限模式变化：默认模式是「⏸ manual mode on · ← for agents」，
// 不再带 shift+tab 提示。漏认它，就绪画面就一直是 ambiguous，Stop 时留下的旧运行帧
// 永远收不了尾（2026-09-25 审查现场：Stop 后 182 秒仍显示运行中）。
const CLAUDE_FOOTER_RE = /shift\+tab to cycle|\? for shortcuts|bypass permissions on|\b(?:manual|plan|auto) mode on\b|accept edits on|← for agents/i;
// Claude 2.1.251 may render either an empty prompt, a “Try …” placeholder, or
// the literal `<no suggestion>` after a completed turn.  All three are input
// ready when paired with the persistent footer; running markers still win
// because classifyClaude checks them first.
const CLAUDE_PROMPT_RE = /^\s*[>\u276f]\s*(?:$|Try\s+["\u201c]|<no suggestion>\s*$)/i;
const CLAUDE_ACTIVE_STATUS_RE = /^\s*[\u2722\u2731-\u273d\u00b7*]\s+[A-Za-z][A-Za-z0-9 '/&+.-]{0,60}(?:\u2026|\.\.\.)(?:\s*\([^)]*\))?\s*$/;
const CLAUDE_ACTIVE_TOOL_RE = /^\s*[\u25cf\u23fa]\s+(?:Reading|Running|Searching|Writing|Editing|Fetching|Calling|Thinking|Exploring|Generating)\b.*(?:\u2026|\.\.\.)/i;

const WAITING_PATTERNS = [
  // \u7ed3\u5c3e\u4e0d\u4e00\u5b9a\u662f "cancel"\uff1aClaude \u7684 Chrome \u6269\u5c55\u63d0\u793a\u662f "Esc to keep browser tools off"\u3002
  /Enter to confirm\s*[\u00b7|]\s*Esc to\b/i,
  /\[(?:y\/N|Y\/n)\]/,
  /Press Enter to confirm/i,
];

function normalizeLines(lines) {
  if (!Array.isArray(lines)) return [];
  return lines
    .map(line => String(line == null ? '' : line).replace(/\u00a0/g, ' ').replace(/[ \t]+$/g, ''))
    .filter(line => line.length > 0)
    .slice(-80);
}

function observation(state, reason, evidence = '') {
  return {
    state,
    confidence: state === RUNTIME_UNKNOWN ? 'none' : 'strong',
    reason,
    evidence: String(evidence || '').trim().slice(0, 200),
  };
}

function firstMatchingLine(lines, matcher) {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (matcher.test(lines[index])) return lines[index];
  }
  return '';
}

function waitingObservation(lines) {
  // Confirmation overlays live at the bottom of the current frame. Restricting
  // this search prevents an old trust/setup prompt that still occupies an
  // untouched row near the top from misclassifying a later completed turn.
  lines = lines.slice(-4);
  for (const pattern of WAITING_PATTERNS) {
    const hit = firstMatchingLine(lines, pattern);
    if (hit) return observation(RUNTIME_WAITING, 'interactive-confirmation', hit);
  }
  return null;
}

function classifyCodex(lines) {
  // A bottom-of-screen confirmation is even more specific than a working row:
  // the provider is blocked on the user, not actively generating. Check that
  // first, then let a structured live work row outrank the persistent prompt.
  const waiting = waitingObservation(lines);
  if (waiting) return waiting;

  const runningLine = firstMatchingLine(lines.slice(-12), CODEX_RUNNING_RE)
    || firstMatchingLine(lines.slice(-12), CODEX_FULLSCREEN_RUNNING_RE);
  if (runningLine) return observation(RUNTIME_RUNNING, 'codex-interrupt-footer', runningLine);

  const promptLine = firstMatchingLine(lines, CODEX_PROMPT_RE);
  const contextLine = firstMatchingLine(lines, CODEX_CONTEXT_RE);
  if (promptLine && contextLine) {
    return observation(RUNTIME_IDLE, 'codex-input-ready', `${promptLine} | ${contextLine}`);
  }
  return observation(RUNTIME_UNKNOWN, 'codex-frame-ambiguous');
}

function classifyClaude(lines) {
  const waiting = waitingObservation(lines);
  if (waiting) return waiting;

  const liveTail = lines.slice(-12);
  const interruptLine = firstMatchingLine(liveTail, /\besc to interrupt\b|ctrl\+b to run in background|running stop hooks/i);
  if (interruptLine) return observation(RUNTIME_RUNNING, 'claude-interrupt-footer', interruptLine);

  const statusLine = firstMatchingLine(liveTail, CLAUDE_ACTIVE_STATUS_RE)
    || firstMatchingLine(liveTail, CLAUDE_ACTIVE_TOOL_RE);
  if (statusLine) return observation(RUNTIME_RUNNING, 'claude-active-status', statusLine);

  const footerLine = firstMatchingLine(lines, CLAUDE_FOOTER_RE);
  const promptLine = firstMatchingLine(lines, CLAUDE_PROMPT_RE);
  if (footerLine && promptLine) {
    return observation(RUNTIME_IDLE, 'claude-input-ready', `${promptLine} | ${footerLine}`);
  }
  return observation(RUNTIME_UNKNOWN, 'claude-frame-ambiguous');
}

// 公司 Code Agent（opentui 界面，2026-10-08 公司实测录屏）：执行中显示「⠋ Running…」（盲文点阵转圈），
// 输入框占位变成「补充指令（Enter 排队等待发送）...」；空闲时占位是「Anything I can assist you with?」，
// 底栏「Bypass (Cycle shift+tab) | <模型>」。认不出时按 Claude 的规则判（测试替身跑的是 Claude 界面）。
function classifyCodeAgent(lines) {
  const waiting = waitingObservation(lines);
  if (waiting) return waiting;
  const liveTail = lines.slice(-16);
  const running = firstMatchingLine(liveTail, /[⠀-⣿]\s*Running/)
    || firstMatchingLine(liveTail, /补充指令（Enter 排队/);
  if (running) return observation(RUNTIME_RUNNING, 'codeagent-running', running);
  const prompt = firstMatchingLine(lines, /Anything I can assist you with/);
  const footer = firstMatchingLine(lines, /Cycle shift\+tab/);
  if (prompt && footer) return observation(RUNTIME_IDLE, 'codeagent-input-ready', `${prompt} | ${footer}`);
  return classifyClaude(lines);
}

function classifyTerminalRuntime(kind, lines) {
  const normalized = normalizeLines(lines);
  const runtimeKind = String(kind || '').toLowerCase();
  if (runtimeKind === 'codex' || runtimeKind === 'codex-resume' || runtimeKind === 'deepseek') {
    return classifyCodex(normalized);
  }
  if (runtimeKind === 'codeagent' || runtimeKind === 'codeagent-resume') return classifyCodeAgent(normalized);
  if (runtimeKind === 'claude' || runtimeKind === 'claude-resume' || runtimeKind === 'deepseek-claude') {
    return classifyClaude(normalized);
  }
  return observation(RUNTIME_UNKNOWN, 'unsupported-runtime');
}

// Confirm that a provider's active status row is actually animating instead of
// being a static leftover frame. Callers keep the tiny returned candidate on
// the session object; no polling, screenshots, or scrollback scans are needed.
function advanceRunningAnimationCandidate(candidate, runtime, observedAt = Date.now()) {
  const at = Number(observedAt) || Date.now();
  const reason = String(runtime && runtime.reason || '').trim();
  const evidence = String(runtime && runtime.evidence || '').trim();
  const isStrongRunning = runtime
    && runtime.state === RUNTIME_RUNNING
    && runtime.confidence === 'strong'
    && reason
    && evidence;
  if (!isStrongRunning) return { confirmed: false, candidate: null };

  const previous = candidate && typeof candidate === 'object' ? candidate : null;
  const previousAt = Number(previous && previous.firstObservedAt) || 0;
  const sameAnimation = previous
    && previous.reason === reason
    && at >= previousAt
    && at - previousAt <= RUNNING_ANIMATION_CONFIRM_MAX_MS;
  if (!sameAnimation) {
    return {
      confirmed: false,
      candidate: {
        reason,
        evidence,
        firstObservedAt: at,
        lastObservedAt: at,
      },
    };
  }

  const elapsed = at - previousAt;
  const frameChanged = evidence !== previous.evidence;
  if (frameChanged && elapsed >= RUNNING_ANIMATION_CONFIRM_MIN_MS) {
    return { confirmed: true, candidate: null };
  }
  return {
    confirmed: false,
    candidate: {
      ...previous,
      lastObservedAt: at,
    },
  };
}

module.exports = {
  RUNTIME_RUNNING,
  RUNTIME_IDLE,
  RUNTIME_WAITING,
  RUNTIME_UNKNOWN,
  RUNNING_ANIMATION_CONFIRM_MIN_MS,
  RUNNING_ANIMATION_CONFIRM_MAX_MS,
  advanceRunningAnimationCandidate,
  classifyTerminalRuntime,
  normalizeLines,
};
