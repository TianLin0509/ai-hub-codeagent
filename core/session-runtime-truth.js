'use strict';

const { isNativeSession, nativeRuntimeTruth } = require('./codex-native-runtime.js');
const claudeRuntime = require('./claude-native-runtime');

const {
  ATTENTION_NEEDS_INPUT,
  ATTENTION_REPLY_READY,
  attentionStateOf,
} = require('./session-attention-state.js');

const RUNTIME_STARTING = 'starting';
const RUNTIME_RUNNING = 'running';
const RUNTIME_WAITING = 'waiting';
const RUNTIME_COMPLETED = 'completed';
const RUNTIME_IDLE = 'idle';
const RUNTIME_FAILED = 'failed';
const RUNTIME_DORMANT = 'dormant';
const RUNTIME_UNKNOWN = 'unknown';
const RUNTIME_INTERRUPTED = 'interrupted';

const CONFIDENCE_AUTHORITATIVE = 'authoritative';
const CONFIDENCE_STRONG = 'strong';
const CONFIDENCE_SEMANTIC = 'semantic';
const CONFIDENCE_FALLBACK = 'fallback';
const CONFIDENCE_INFERRED = 'inferred';
const CONFIDENCE_NONE = 'none';

const STARTING_TTL_MS = 15 * 1000;
const FALLBACK_RUNNING_TTL_MS = 3 * 1000;

const VALID_STATES = new Set([
  RUNTIME_STARTING,
  RUNTIME_RUNNING,
  RUNTIME_WAITING,
  RUNTIME_COMPLETED,
  RUNTIME_IDLE,
  RUNTIME_FAILED,
  RUNTIME_DORMANT,
  RUNTIME_UNKNOWN,
  RUNTIME_INTERRUPTED,
]);

const CONFIDENCE_RANK = Object.freeze({
  [CONFIDENCE_NONE]: 0,
  [CONFIDENCE_INFERRED]: 1,
  [CONFIDENCE_FALLBACK]: 2,
  [CONFIDENCE_SEMANTIC]: 3,
  [CONFIDENCE_STRONG]: 4,
  [CONFIDENCE_AUTHORITATIVE]: 5,
});

const ACTIVE_STATES = new Set([RUNTIME_STARTING, RUNTIME_RUNNING]);

function finiteTime(value, fallback = 0) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return Number(fallback) || 0;
  // Runtime producers already normalize provider timestamps at their boundary.
  // Keeping this reducer strictly millisecond-based also makes ordering and
  // short TTL comparisons deterministic.
  return numeric;
}

function normalizeTurnId(value) {
  if (value == null) return null;
  const normalized = String(value).trim();
  return normalized || null;
}

function normalizeConfidence(value) {
  return Object.prototype.hasOwnProperty.call(CONFIDENCE_RANK, value)
    ? value
    : CONFIDENCE_INFERRED;
}

function runtimeLabel(state) {
  return {
    [RUNTIME_STARTING]: '启动中',
    [RUNTIME_RUNNING]: '工作中',
    [RUNTIME_WAITING]: '等待输入',
    [RUNTIME_COMPLETED]: '已完成',
    [RUNTIME_IDLE]: '已就绪',
    [RUNTIME_FAILED]: '运行异常',
    [RUNTIME_DORMANT]: '休眠中',
    [RUNTIME_UNKNOWN]: '状态未知',
    [RUNTIME_INTERRUPTED]: '已中断',
  }[state] || '状态未知';
}

function runtimeConfidenceLabel(confidence) {
  return {
    [CONFIDENCE_AUTHORITATIVE]: '权威事件',
    [CONFIDENCE_STRONG]: '强证据',
    [CONFIDENCE_SEMANTIC]: '语义证据',
    [CONFIDENCE_FALLBACK]: '兜底推断',
    [CONFIDENCE_INFERRED]: '历史推断',
    [CONFIDENCE_NONE]: '待确认',
  }[confidence] || '待确认';
}

function runtimeSourceLabel(source) {
  const value = String(source || 'unspecified');
  const exact = {
    'codex-app-server': 'Codex 原生执行状态',
    'claude-stream-json': 'Claude 原生执行状态',
    'acp': '原生 Harness 执行状态',
    'claude-user-prompt-submit': 'Claude UserPromptSubmit',
    'claude-stop': 'Claude Stop',
    'claude-transcript-complete': 'Claude transcript stop_reason',
    'claude-stop-failure': 'Claude StopFailure',
    'claude-permission-request': 'Claude PermissionRequest',
    'claude-background-tasks': 'Claude 后台任务',
    'codex-turn-complete': 'Codex task_complete',
    'codex-turn-aborted': 'Codex turn_aborted',
    'gemini-turn-complete': 'Gemini transcript completion',
    'kimi-turn-complete': 'Kimi transcript completion',
    'pty-byte-burst': 'PTY 字节活动',
    'pty-byte-quiet': 'PTY 静默窗口',
    'groupchat-watcher-heartbeat': '群聊调度器心跳',
    'groupchat-watcher-complete': '群聊轮次完成',
  };
  if (exact[value]) return exact[value];
  if (value.startsWith('pty-codex-interrupt')) return 'PTY 当前屏幕：Codex esc to interrupt';
  if (value.startsWith('pty-codex-input-ready')) return 'PTY 当前屏幕：Codex 输入框就绪';
  if (value.startsWith('pty-claude-active') || value.startsWith('pty-claude-interrupt')) return 'PTY 当前屏幕：Claude 活动态';
  if (value.startsWith('pty-claude-input-ready')) return 'PTY 当前屏幕：Claude 输入框就绪';
  if (value === 'claude-tool-start') return 'Claude PreToolUse';
  if (value === 'claude-subagent-start') return 'Claude SubagentStart';
  if (value === 'claude-task-start') return 'Claude TaskCreated';
  if (value.includes('rollout_task_started')) return 'Codex/Kimi task_started';
  if (value.includes('rollout_user_message')) return 'Transcript 用户消息';
  if (value.endsWith('-pty-output-after-submit')) return '提交后 PTY 输出';
  if (value.startsWith('claude-notification-')) return `Claude Notification：${value.slice('claude-notification-'.length)}`;
  if (value.startsWith('expired:')) return `信号过期：${runtimeSourceLabel(value.slice('expired:'.length))}`;
  return value;
}

function defaultExpiry(state, confidence, observedAt) {
  if (state === RUNTIME_STARTING) return observedAt + STARTING_TTL_MS;
  if (state === RUNTIME_RUNNING && confidence === CONFIDENCE_FALLBACK) {
    return observedAt + FALLBACK_RUNNING_TTL_MS;
  }
  return 0;
}

function normalizeObservation(observation = {}, previous = null, now = Date.now()) {
  const state = VALID_STATES.has(observation.state) ? observation.state : RUNTIME_UNKNOWN;
  const confidence = normalizeConfidence(observation.confidence);
  const observedAt = finiteTime(observation.observedAt, now) || Date.now();
  const startedAtInput = finiteTime(observation.startedAt, 0);
  const previousStartedAt = previous && ACTIVE_STATES.has(previous.state)
    ? finiteTime(previous.startedAt, 0)
    : 0;
  const startedAt = ACTIVE_STATES.has(state)
    ? (startedAtInput || previousStartedAt || observedAt)
    : (startedAtInput || previousStartedAt || 0);
  const completedAt = finiteTime(observation.completedAt, state === RUNTIME_COMPLETED ? observedAt : 0);
  const expiresAtInput = finiteTime(observation.expiresAt, 0);
  return {
    state,
    source: String(observation.source || 'unspecified'),
    confidence,
    observedAt,
    startedAt,
    completedAt,
    expiresAt: expiresAtInput || defaultExpiry(state, confidence, observedAt),
    turnId: normalizeTurnId(observation.turnId),
    reason: observation.reason ? String(observation.reason).slice(0, 160) : null,
    evidence: observation.evidence ? String(observation.evidence).trim().slice(0, 240) : null,
  };
}

function compactObservation(observation) {
  return {
    state: observation.state,
    source: observation.source,
    confidence: observation.confidence,
    observedAt: observation.observedAt,
    evidence: observation.evidence || null,
  };
}

function addCorroboration(items, observation) {
  const next = Array.isArray(items) ? items.slice() : [];
  const compact = compactObservation(observation);
  const index = next.findIndex(item => item.source === compact.source && item.state === compact.state);
  if (index >= 0) next.splice(index, 1);
  next.push(compact);
  return next.slice(-4);
}

function mirrorLegacyStatus(session, state) {
  if (!session || session.status === 'dormant') return;
  if (state === RUNTIME_STARTING || state === RUNTIME_RUNNING) session.status = 'running';
  else if (state === RUNTIME_FAILED) session.status = 'error';
  else if (state === RUNTIME_DORMANT) session.status = 'dormant';
  else session.status = 'idle';
}

function isSameOrUnknownTurn(previous, next) {
  return !previous.turnId || !next.turnId || previous.turnId === next.turnId;
}

function applySessionRuntimeObservation(session, observation = {}, options = {}) {
  if (isNativeSession(session)) return { applied: false, reason: 'codex-native-only' };
  if (require('./claude-native-runtime').isNativeClaude(session)) {
    return { applied: false, reason: 'native-authority', truth: require('./claude-native-runtime').claudeRuntimeTruth(session) };
  }
  if (!session || typeof session !== 'object') return { applied: false, reason: 'missing-session' };
  const previous = session.runtimeTruth && VALID_STATES.has(session.runtimeTruth.state)
    ? session.runtimeTruth
    : null;
  const next = normalizeObservation(observation, previous, options.now || Date.now());

  if (previous) {
    const previousAt = finiteTime(previous.observedAt, 0);
    if (next.observedAt < previousAt) {
      const enrichesSameState = next.state === previous.state
        && (CONFIDENCE_RANK[next.confidence] || 0) > (CONFIDENCE_RANK[previous.confidence] || 0);
      if (enrichesSameState) next.observedAt = previousAt;
      else return { applied: false, reason: 'stale-observation', previous, next };
    }
    if (next.observedAt === previousAt
        && (CONFIDENCE_RANK[next.confidence] || 0) < (CONFIDENCE_RANK[previous.confidence] || 0)) {
      if (next.state === previous.state && next.source !== previous.source) {
        const truth = {
          ...previous,
          corroborations: addCorroboration(previous.corroborations, next),
          sequence: (Number(previous.sequence) || 0) + 1,
        };
        session.runtimeTruth = truth;
        return { applied: true, corroborated: true, previous, truth };
      }
      return { applied: false, reason: 'lower-confidence-tie', previous, next };
    }
    // rollout user_message may be delivered after task_started. Do not regress
    // the same active turn from a confirmed running state back to starting.
    if (previous.state === RUNTIME_RUNNING && next.state === RUNTIME_STARTING
        && isSameOrUnknownTurn(previous, next)
        && next.startedAt <= previous.observedAt) {
      return { applied: false, reason: 'active-phase-regression', previous, next };
    }
    if ([RUNTIME_COMPLETED, RUNTIME_FAILED].includes(previous.state)
        && ACTIVE_STATES.has(next.state)
        && (CONFIDENCE_RANK[next.confidence] || 0) <= CONFIDENCE_RANK[CONFIDENCE_SEMANTIC]) {
      const sameKnownTurn = previous.turnId && next.turnId && previous.turnId === next.turnId;
      const lacksNewBoundary = (!previous.turnId || !next.turnId) && next.startedAt <= previous.observedAt;
      if (sameKnownTurn || lacksNewBoundary) {
        return { applied: false, reason: 'terminal-state-resurrection', previous, next };
      }
    }
  }

  if (previous && next.state === previous.state && next.source !== previous.source) {
    next.corroborations = addCorroboration(previous.corroborations, previous);
  }
  next.sequence = (Number(previous && previous.sequence) || 0) + 1;
  session.runtimeTruth = next;
  if (options.mirrorLegacy !== false) mirrorLegacyStatus(session, next.state);
  return { applied: true, previous, truth: next };
}

function completionIsLatest(session) {
  const completedAt = finiteTime(session && session.lastCompletedAt, 0);
  const promptAt = finiteTime(session && session._attentionClock && session._attentionClock.lastPromptAt, 0);
  return completedAt > 0 && (!promptAt || completedAt >= promptAt);
}

function legacyRuntimeTruth(session, now = Date.now()) {
  const status = String(session && session.status || 'idle').toLowerCase();
  const attention = attentionStateOf(session);
  if (status === 'dormant') {
    return normalizeObservation({ state: RUNTIME_DORMANT, source: 'legacy-dormant', confidence: CONFIDENCE_AUTHORITATIVE }, null, now);
  }
  if (status === 'error' || status === 'errored' || status === 'failed') {
    return normalizeObservation({
      state: RUNTIME_FAILED,
      source: 'legacy-error',
      confidence: CONFIDENCE_SEMANTIC,
      evidence: session.lastError || session.error || session.spawnError || null,
    }, null, now);
  }
  if (attention === ATTENTION_NEEDS_INPUT) {
    return normalizeObservation({
      state: RUNTIME_WAITING,
      source: session.waitingReason || 'attention-needs-input',
      confidence: CONFIDENCE_STRONG,
      evidence: session.waitingText || null,
    }, null, now);
  }
  if (status === 'running') {
    const source = String(session._runSource || session.cardWorkingSource || 'legacy-running');
    const confidence = source === 'pty-semantic'
      ? CONFIDENCE_STRONG
      : source === 'semantic'
        ? CONFIDENCE_SEMANTIC
        : CONFIDENCE_FALLBACK;
    return normalizeObservation({
      state: RUNTIME_RUNNING,
      source,
      confidence,
      observedAt: session._ptyRuntimeObservedAt || session._lastOutputTs || session.runStartedAt || now,
      startedAt: session.runStartedAt || session.cardWorkingSince || session._ptyFallbackArmedAt || now,
      evidence: session._ptyRuntimeEvidence || null,
    }, null, now);
  }
  if (attention === ATTENTION_REPLY_READY || completionIsLatest(session)) {
    return normalizeObservation({
      state: RUNTIME_COMPLETED,
      source: 'legacy-completion',
      confidence: CONFIDENCE_INFERRED,
      observedAt: session.lastCompletedAt || now,
      completedAt: session.lastCompletedAt || now,
      startedAt: session.lastRunStartedAt || 0,
    }, null, now);
  }
  return normalizeObservation({ state: RUNTIME_IDLE, source: 'legacy-idle', confidence: CONFIDENCE_INFERRED }, null, now);
}

function getSessionRuntimeTruth(session, options = {}) {
  if (session?.agentRuntime === 'pty' && session.cliRuntime && session.status !== 'dormant') {
    const r=session.cliRuntime;
    return { ...r, state:r.connection==='disconnected'?'unknown':r.state,
      confidence:r.connection==='connected'?'authoritative':'none',source:'provider-cli',expiresAt:0,
      evidence:r.reason||null,requests:r.requests||[] };
  }
  if (isNativeSession(session)) return nativeRuntimeTruth(session);
  if (claudeRuntime.isNativeClaude(session)) {
    return claudeRuntime.claudeRuntimeTruth(session);
  }
  const now = Number(options.now) || Date.now();
  if (!session || typeof session !== 'object') {
    return normalizeObservation({ state: RUNTIME_UNKNOWN, source: 'missing-session', confidence: CONFIDENCE_NONE }, null, now);
  }

  const truth = session.runtimeTruth && VALID_STATES.has(session.runtimeTruth.state)
    ? { ...session.runtimeTruth }
    : null;
  // Hard current facts always beat a stale stored observation.
  if (session.status === 'dormant') return legacyRuntimeTruth(session, now);
  if (['error', 'errored', 'failed'].includes(String(session.status || '').toLowerCase())
      && (!truth || truth.state !== RUNTIME_FAILED)) {
    return legacyRuntimeTruth(session, now);
  }
  if (attentionStateOf(session) === ATTENTION_NEEDS_INPUT) {
    return truth && truth.state === RUNTIME_WAITING ? truth : legacyRuntimeTruth(session, now);
  }
  if (attentionStateOf(session) === ATTENTION_REPLY_READY && completionIsLatest(session)) {
    const completedAt = finiteTime(session.lastCompletedAt, 0);
    // A foreground reply can become readable while Claude still has background
    // agents / Stop hooks running.  Keep the reply-ready attention marker, but
    // do not let it overwrite a newer active runtime observation.  This also
    // makes the result independent of whether the hidden/background Hub window
    // happened to have focus when the Stop hook arrived.
    const activeTruthIsCurrent = truth
      && ACTIVE_STATES.has(truth.state)
      && finiteTime(truth.observedAt, 0) >= completedAt
      && (!truth.expiresAt || now <= finiteTime(truth.expiresAt, 0));
    if (activeTruthIsCurrent) return truth;
    if (!truth || truth.state !== RUNTIME_COMPLETED || completedAt >= finiteTime(truth.observedAt, 0)) {
      return truth && truth.state === RUNTIME_COMPLETED ? truth : legacyRuntimeTruth(session, now);
    }
  }
  if (!truth) return legacyRuntimeTruth(session, now);

  const runStartedAt = finiteTime(session.runStartedAt, 0);
  if (session.status === 'running' && runStartedAt > finiteTime(truth.observedAt, 0)) {
    return legacyRuntimeTruth(session, now);
  }
  if (truth.expiresAt && now > truth.expiresAt) {
    return {
      ...truth,
      state: RUNTIME_UNKNOWN,
      source: `expired:${truth.source}`,
      confidence: CONFIDENCE_NONE,
      observedAt: truth.expiresAt,
      expiresAt: 0,
      reason: 'observation-expired',
    };
  }
  return truth;
}

function sessionRuntimeIsActive(session, options = {}) {
  return ACTIVE_STATES.has(getSessionRuntimeTruth(session, options).state);
}

function sessionRuntimeNeedsInput(session, options = {}) {
  return getSessionRuntimeTruth(session, options).state === RUNTIME_WAITING;
}

function sessionRuntimeIsCompleted(session, options = {}) {
  return getSessionRuntimeTruth(session, options).state === RUNTIME_COMPLETED;
}

function runtimeTruthSummary(truth) {
  if (!truth) return '状态未知';
  const parts = [runtimeLabel(truth.state)];
  if (truth.source) parts.push(`依据 ${runtimeSourceLabel(truth.source)}`);
  if (truth.confidence) parts.push(runtimeConfidenceLabel(truth.confidence));
  if (truth.evidence) parts.push(truth.evidence);
  if (Array.isArray(truth.corroborations) && truth.corroborations.length) {
    parts.push(`交叉验证 ${truth.corroborations.map(item => runtimeSourceLabel(item.source)).join('、')}`);
  }
  return parts.join(' · ');
}

module.exports = {
  RUNTIME_INTERRUPTED,
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
  STARTING_TTL_MS,
  FALLBACK_RUNNING_TTL_MS,
  applySessionRuntimeObservation,
  getSessionRuntimeTruth,
  legacyRuntimeTruth,
  normalizeObservation,
  runtimeLabel,
  runtimeConfidenceLabel,
  runtimeSourceLabel,
  runtimeTruthSummary,
  sessionRuntimeIsActive,
  sessionRuntimeNeedsInput,
  sessionRuntimeIsCompleted,
};
