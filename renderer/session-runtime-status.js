'use strict';

const { isNativeSession } = require('../core/codex-native-runtime.js');

const {
  RUNTIME_STARTING,
  RUNTIME_RUNNING,
  RUNTIME_WAITING,
  RUNTIME_COMPLETED,
  RUNTIME_IDLE,
  RUNTIME_FAILED,
  RUNTIME_DORMANT,
  RUNTIME_UNKNOWN,
  getSessionRuntimeTruth,
  runtimeConfidenceLabel,
  runtimeLabel,
  runtimeSourceLabel,
} = require('../core/session-runtime-truth.js');

function providerLabel(session) {
  if(session?.runtimeBackend==='acp')return require('../core/native-ui-labels').nativeUiLabel(session);
  if (require('../core/chatgpt-web-models').isChatgptWebModel(session?.currentModel?.id)) return 'ChatGPT Web';
  const kind = String(session && session.kind || '').replace(/-resume$/i, '').toLowerCase();
  if (kind === 'codex' || kind === 'deepseek') return kind === 'codex' ? 'Codex' : 'DeepSeek';
  if (kind === 'claude') return 'Claude';
  if (kind === 'kimi') return 'Kimi';
  if (kind === 'gemini') return 'Gemini';
  if (kind === 'powershell') return 'PowerShell';
  return 'AI';
}

function formatRuntimeDuration(value) {
  const totalSeconds = Math.max(0, Math.floor((Number(value) || 0) / 1000));
  const seconds = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const minutes = totalMinutes % 60;
  const hours = Math.floor(totalMinutes / 60);
  const pad = number => String(number).padStart(2, '0');
  return hours > 0
    ? `${hours}:${pad(minutes)}:${pad(seconds)}`
    : `${pad(totalMinutes)}:${pad(seconds)}`;
}

function formatCompletionAge(completedAt, now = Date.now()) {
  const ageMs = Math.max(0, (Number(now) || Date.now()) - (Number(completedAt) || 0));
  if (!completedAt || ageMs < 60_000) return '刚刚';
  if (ageMs < 60 * 60_000) return `${Math.floor(ageMs / 60_000)} 分钟前`;
  if (ageMs < 24 * 60 * 60_000) return `${Math.floor(ageMs / (60 * 60_000))} 小时前`;
  return `${Math.floor(ageMs / (24 * 60 * 60_000))} 天前`;
}

function legacyRunningStartedAt(session) {
  for (const value of [
    session && session.runStartedAt,
    session && session.cardWorkingSince,
    session && session._ptyFallbackArmedAt,
    session && session._ptyRuntimeObservedAt,
  ]) {
    const numeric = Number(value) || 0;
    if (numeric > 0) return numeric;
  }
  return 0;
}

function deriveSessionRuntimeStatus(session, options = {}) {
  const native = require('../core/native-agent-runtime').isNativeAgent(session);
  const now = Number(options.now) || Date.now();
  const provider = providerLabel(session);
  let truth = getSessionRuntimeTruth(session, { now });
  const closedPtyTurn = session?.agentRuntime === 'pty' && truth.confidence === 'authoritative'
    && [RUNTIME_IDLE, RUNTIME_COMPLETED, RUNTIME_FAILED, 'interrupted'].includes(truth.state);
  if (!native && !closedPtyTurn && options.isRunning === true && [RUNTIME_IDLE, RUNTIME_COMPLETED, RUNTIME_UNKNOWN].includes(truth.state)) {
    truth = {
      ...truth,
      state: RUNTIME_RUNNING,
      source: session && (session.cardWorkingSource || session._runSource) || 'legacy-card-working',
      startedAt: legacyRunningStartedAt(session) || now,
      evidence: session && session._ptyRuntimeEvidence || truth.evidence || null,
    };
  }
  const state = truth.state;
  const cancelling = truth.cancellation?.status === 'pending' && truth.connection === 'connected';
  const label = cancelling ? '正在停止' : runtimeLabel(state);
  let meta = '';
  let detail = '';

  if (state === RUNTIME_DORMANT) {
    detail = '点击会话可恢复原生 CLI';
  } else if (state === RUNTIME_FAILED) {
    detail = String(truth.evidence || session && (session.lastError || session.error) || '').trim();
  } else if (state === RUNTIME_WAITING) {
    meta = '需要操作';
    detail = String(truth.evidence || session && session.waitingText || '').trim();
  } else if (state === RUNTIME_STARTING || state === RUNTIME_RUNNING) {
    const startedAt = Number(truth.startedAt) || (native ? 0 : legacyRunningStartedAt(session));
    if (startedAt > 0 && now >= startedAt) meta = formatRuntimeDuration(now - startedAt);
    detail = String(
      cancelling && truth.evidence
      || session && session.currentCardActivity && session.currentCardActivity.label
      || truth.evidence
      || !native && session && session._ptyRuntimeEvidence
      || '',
    ).trim();
  } else if (state === RUNTIME_COMPLETED) {
    const completedAt = Number(truth.completedAt) || (native ? 0 : Number(session && session.lastCompletedAt)) || 0;
    meta = formatCompletionAge(completedAt, now);
    const durationMs = native ? (truth.startedAt && truth.completedAt ? truth.completedAt - truth.startedAt : 0)
      : Number(session && session.lastRunDurationMs) || 0;
    detail = durationMs > 0 ? `本轮用时 ${formatRuntimeDuration(durationMs)}` : '';
  } else if (state === RUNTIME_UNKNOWN) {
    detail = truth.reason === 'observation-expired'
      ? '最近的运行信号已过期，等待新的语义事件或 PTY 证据'
      : String(truth.evidence || '').trim();
  }

  const visibleText = meta ? `${label} · ${meta}` : label;
  const contentAge = require('../core/native-feedback').nativeContentAge(session, now);
  if (contentAge) detail = [detail, contentAge].filter(Boolean).join(' · ');
  const compactDetail = detail.replace(/\s+/g, ' ');
  const visibleDetail = [RUNTIME_STARTING, RUNTIME_RUNNING, RUNTIME_WAITING, RUNTIME_FAILED, RUNTIME_UNKNOWN].includes(state)
    ? contentAge && compactDetail.length > 180
      ? `${compactDetail.slice(0, 177 - contentAge.length)}… · ${contentAge}`
      : compactDetail.slice(0, 180)
    : '';
  const ariaLabel = `${provider} ${label}`;
  const titleParts = [ariaLabel];
  if (meta) titleParts.push(meta);
  if (detail) titleParts.push(detail);
  if (truth.source) {
    titleParts.push(`判断依据：${runtimeSourceLabel(truth.source)} · ${runtimeConfidenceLabel(truth.confidence)}`);
  }
  if (Array.isArray(truth.corroborations) && truth.corroborations.length) {
    titleParts.push(`交叉验证：${truth.corroborations.map(item => runtimeSourceLabel(item.source)).join('、')}`);
  }

  return {
    state,
    label,
    meta,
    detail,
    visibleDetail,
    provider,
    source: truth.source,
    confidence: truth.confidence,
    observedAt: truth.observedAt,
    ...(native ? {threadId:truth.threadId,turnId:truth.turnId,revision:truth.revision,epoch:truth.epoch,connection:truth.connection,
      userMessageId:truth.userMessageId,providerSessionId:truth.providerSessionId} : {}),
    visibleText,
    ariaLabel,
    title: titleParts.join('\n'),
  };
}

module.exports = {
  RUNTIME_STATUS_STARTING: RUNTIME_STARTING,
  RUNTIME_STATUS_RUNNING: RUNTIME_RUNNING,
  RUNTIME_STATUS_WAITING: RUNTIME_WAITING,
  RUNTIME_STATUS_COMPLETED: RUNTIME_COMPLETED,
  RUNTIME_STATUS_IDLE: RUNTIME_IDLE,
  RUNTIME_STATUS_FAILED: RUNTIME_FAILED,
  RUNTIME_STATUS_DORMANT: RUNTIME_DORMANT,
  RUNTIME_STATUS_UNKNOWN: RUNTIME_UNKNOWN,
  deriveSessionRuntimeStatus,
  formatCompletionAge,
  formatRuntimeDuration,
  providerLabel,
};
