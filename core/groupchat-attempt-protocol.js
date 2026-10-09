'use strict';

const crypto = require('node:crypto');

const ATTEMPT_PREPARED = 'prepared';
const ATTEMPT_SUBMITTING = 'submitting';
const ATTEMPT_ACCEPTED = 'accepted';
const ATTEMPT_RUNNING = 'running';
const ATTEMPT_AWAITING_BINDING = 'awaiting_binding';
const ATTEMPT_AWAITING_FINAL_TEXT = 'awaiting_final_text';
const ATTEMPT_RECOVERING = 'recovering';
const ATTEMPT_COMPLETED = 'completed';
const ATTEMPT_FAILED = 'failed';
const ATTEMPT_INTERRUPTED = 'interrupted';
const ATTEMPT_SUPERSEDED = 'superseded';
const ATTEMPT_ABSENT = 'absent';
const ATTEMPT_HANDED_OFF = 'handed_off';

const TERMINAL_ATTEMPT_STATES = new Set([
  ATTEMPT_COMPLETED,
  ATTEMPT_FAILED,
  ATTEMPT_INTERRUPTED,
  ATTEMPT_SUPERSEDED,
  ATTEMPT_ABSENT,
  ATTEMPT_HANDED_OFF,
]);

const CLAUDE_FINAL_SOURCES = new Set([
  'stop_hook',
  'stop_reason_terminal',
  'idle_timer_terminal',
  'claude_auto_extract_final_answer',
]);

const CODEX_FINAL_SOURCES = new Set([
  'codex-app-server',
  'task_complete',
  'item_completed_agent_message_final_answer',
  'codex_auto_extract_final_answer',
]);

function cleanPart(value, fallback) {
  const text = String(value == null ? '' : value)
    .trim()
    .replace(/[^a-zA-Z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return text || fallback;
}

function randomId() {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return crypto.randomBytes(16).toString('hex');
}

function createRunId(meetingId, turnNum) {
  return `gcr-${cleanPart(meetingId, 'meeting')}-${Math.max(0, Number(turnNum) || 0)}-${randomId()}`;
}

function createAttemptId(runId, memberId) {
  return `gca-${cleanPart(memberId, 'member')}-${cleanPart(runId, 'run').slice(-20)}-${randomId()}`;
}

function promptFingerprint(prompt) {
  return crypto.createHash('sha256').update(String(prompt || '').replace(/\r\n/g, '\n').trim()).digest('hex');
}

function normalizeProviderFamily(kind) {
  const value = String(kind || '').trim().toLowerCase();
  // Resume kinds are persisted verbatim on the session (kind='deepseek-resume'
  // etc.). Missing one here silently drops the whole attempt gate back to the
  // permissive legacy path for that member, so keep both variants listed.
  if (require('./acp-profiles').isAcpKind(value)) return value.replace(/-resume$/, '');
  if (value === 'claude' || value === 'claude-resume'
      || value === 'deepseek-legacy' || value === 'deepseek-legacy-resume'
      || value === 'codeagent' || value === 'codeagent-resume') return 'claude';
  if (value === 'codex' || value === 'codex-resume'
      || value === 'deepseek' || value === 'deepseek-resume') return 'codex';
  if (value === 'kimi' || value === 'kimi-resume') return 'kimi';
  if (value === 'gemini' || value === 'gemini-resume') return 'gemini';
  return value || 'unknown';
}

function isTerminalAttemptStatus(status) {
  return TERMINAL_ATTEMPT_STATES.has(String(status || ''));
}

function normalizeEventTime(event = {}) {
  for (const key of ['completedAt', 'failedAt', 'abortedAt', 'startedAt', 'submittedAt', 'observedAt']) {
    const value = Number(event[key]);
    if (Number.isFinite(value) && value > 0) return value;
  }
  return 0;
}

function isAuthoritativeFinalSignal(kind, signalSource) {
  const family = normalizeProviderFamily(kind);
  const source = String(signalSource || '').trim();
  if (require('./acp-profiles').isAcpKind(kind)) return source === 'acp';
  if (family === 'claude') return CLAUDE_FINAL_SOURCES.has(source);
  if (family === 'codex') return CODEX_FINAL_SOURCES.has(source);
  // Gemini/Kimi taps emit turn-complete only after their provider-specific
  // parser has declared a terminal row. Preserve that existing contract while
  // Claude/Codex use the stricter source allowlists above.
  return !!source;
}

function compactRaw(value, max = 240) {
  const text = String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
  return text ? text.slice(0, max) : '';
}

function classifyProviderFailure(input = {}) {
  const rawValues = [input.reason, input.message, input.errorInfo, input.text]
    .map(value => String(value == null ? '' : value).replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  const rawLength = rawValues.reduce((total, value) => total + value.length, 0);
  const raw = rawValues
    .map(value => compactRaw(value, 600))
    .filter(Boolean)
    .join(' · ');
  if (!raw && !input.code && !input.uncertain) return null;
  // A provider refusal is often delivered as a short assistant message rather
  // than an error event. Keep this detector deliberately narrow so a real
  // technical answer discussing rate limits is never reclassified as failure.
  if (input.fromAssistantText === true && rawLength > 600) return null;

  const definitions = [
    {
      code:'submission_unknown', category:'reconciliation', retryable:false, autoRetry:false,
      action:'reconcile_native_history', summary:'本条提交待核对',
      patterns:[/CLAUDE_SUBMISSION_(?:UNKNOWN|TIMEOUT)/, /Claude submission requires reconciliation/i,
        /Claude 未确认本条输入.*提交状态待核对/, /Codex 请求超时：turn\/(?:start|steer).*结果待核对/,
        /ACP 未在期限内返回执行证据.*消息结果待核对/],
    },
    {
      code: 'quota_exceeded', category: 'quota', retryable: true, autoRetry: false,
      action: 'wait_or_switch_account', summary: '额度已用尽',
      assistantText: true,
      patterns: [
        /^you'?ve hit your (?:session|usage) limit\b/i,
        /^(?:error[:：\s-]*)?(?:usage|session) limit (?:reached|exceeded)\b/i,
        /^(?:error[:：\s-]*)?quota (?:exceeded|exhausted)\b/i,
        /^(?:error[:：\s-]*)?insufficient (?:quota|credit)\b/i,
        /^(?:错误[:：\s-]*)?(?:额度|配额)(?:已)?(?:用尽|耗尽|不足)/,
      ],
    },
    {
      code: 'rate_limited', category: 'quota', retryable: true, autoRetry: false,
      action: 'wait_then_retry', summary: '请求触发限流',
      assistantText: true,
      patterns: [/^(?:error[:：\s-]*)?(?:rate.?limit (?:reached|exceeded)|too many requests)\b/i, /^rate[_-]?limit[_-]?(?:reached|exceeded)$/i, /^(?:error[:：\s-]*)?429\b/i, /^(?:错误[:：\s-]*)?(?:请求过于频繁|触发限流)/],
    },
    {
      code: 'auth_required', category: 'auth', retryable: true, autoRetry: false,
      action: 'login_then_retry', summary: '登录或授权已失效',
      assistantText: true,
      patterns: [/^auth_required$/i, /^authentication[_-](?:failed|required)$/i, /^(?:error[:：\s-]*)?(?:401|403).*(?:unauthorized|forbidden)/i, /^please (?:run )?\/login/i, /^(?:you are )?not (?:logged in|authenticated)/i, /^authentication (?:failed|required)/i, /^(?:错误[:：\s-]*)?(?:登录失效|需要登录|鉴权失败)/],
    },
    {
      code: 'network_interrupted', category: 'network', retryable: true, autoRetry: false,
      action: 'restore_network_then_retry', summary: '网络连接中断',
      patterns: [/ECONN(?:RESET|REFUSED|ABORTED)/i, /ENETUNREACH/i, /ETIMEDOUT/i, /network (?:error|unreachable|disconnected)/i, /stream disconnected/i, /connection (?:reset|closed|lost|failed)/i, /网络(?:中断|断开|不可达|错误)/],
    },
    {
      code: 'provider_unavailable', category: 'provider', retryable: true, autoRetry: false,
      action: 'wait_then_retry', summary: '服务暂时不可用',
      assistantText: true,
      patterns: [/^(?:error[:：\s-]*)?(?:service unavailable|temporarily unavailable|provider overloaded|capacity exhausted)\b/i, /^(?:error[:：\s-]*)?50[234]\b/i, /^(?:错误[:：\s-]*)?(?:服务暂时不可用|服务过载)/],
    },
    {
      code: 'context_limit', category: 'input', retryable: true, autoRetry: false,
      action: 'shorten_context_then_retry', summary: '上下文长度超限',
      patterns: [/context (?:length|window).*(?:exceed|limit|too long)/i, /maximum context/i, /prompt (?:is )?too long/i, /上下文.*(?:超限|过长)/],
    },
    {
      code: 'runtime_exited', category: 'runtime', retryable: true, autoRetry: false,
      action: 'resume_or_relaunch_then_retry', summary: 'Agent 运行载体已退出',
      patterns: [/pty exit/i, /cli_self_exit/i, /process[_ ]exit/i, /runtime exited/i, /会话.*退出|CLI.*退出/i],
    },
    {
      code: 'response_timeout', category: 'runtime', retryable: true, autoRetry: false,
      action: 'inspect_then_retry', summary: '等待回答超时',
      patterns: [/response_timeout/i, /hard timeout/i, /等待回答超时/],
    },
  ];

  for (const definition of definitions) {
    if (input.fromAssistantText === true && definition.assistantText !== true) continue;
    if (!(definition.code === 'submission_unknown' && (input.uncertain === true
        || /^CLAUDE_SUBMISSION_(UNKNOWN|TIMEOUT)$/.test(input.code || '')))
        && !definition.patterns.some(pattern => pattern.test(raw))) continue;
    const { patterns: _patterns, assistantText: _assistantText, ...failure } = definition;
    return { ...failure, detail: compactRaw(raw, 300) };
  }
  if (input.force === true) {
    return {
      code: 'provider_error',
      category: 'provider',
      retryable: true,
      autoRetry: false,
      action: 'inspect_then_retry',
      summary: 'Agent 本轮异常结束',
      detail: compactRaw(raw, 300),
    };
  }
  return null;
}

function attemptEventMatches(attempt, event = {}, options = {}) {
  if (!attempt || typeof attempt !== 'object') return { ok: true, legacy: true };
  const expectedSid = String(attempt.sid || '');
  const actualSid = String(event.hubSessionId || event.sessionId || event.sid || '');
  if (expectedSid && actualSid && expectedSid !== actualSid) {
    return { ok: false, reason: 'session_mismatch' };
  }
  if (event.attemptId && attempt.attemptId && String(event.attemptId) !== String(attempt.attemptId)) {
    return { ok: false, reason: 'attempt_mismatch' };
  }

  const expectedTurn = String(attempt.providerTurnId || '').trim();
  const actualTurn = String(event.turnId || event.providerTurnId || '').trim();
  if (expectedTurn && actualTurn && expectedTurn !== actualTurn) {
    return { ok: false, reason: 'provider_turn_mismatch', expectedTurn, actualTurn };
  }

  const family = normalizeProviderFamily(attempt.kind || options.kind);
  const acp = require('./acp-profiles').isAcpKind(attempt.kind || options.kind);
  const eventAt = normalizeEventTime(event);
  const floor = Math.max(
    Number(attempt.startedAt) || 0,
    Number(attempt.acceptedAt) || 0,
    Number(attempt.dispatchAt) || 0,
  );
  const toleranceMs = Math.max(0, Number(options.clockToleranceMs) || 250);
  if ((family === 'claude' || family === 'codex' || acp || options.enforceTimeBoundary === true)
      && eventAt && floor && eventAt + toleranceMs < floor) {
    return { ok: false, reason: 'before_attempt_boundary', eventAt, floor };
  }

  if ((family === 'codex' || acp) && expectedTurn && !actualTurn && options.requireProviderTurn !== false) {
    return { ok: false, reason: 'missing_provider_turn_id', expectedTurn };
  }

  return {
    ok: true,
    legacy: !expectedTurn && !actualTurn,
    providerTurnId: actualTurn || expectedTurn || null,
  };
}

module.exports = {
  ATTEMPT_HANDED_OFF,
  ATTEMPT_PREPARED,
  ATTEMPT_SUBMITTING,
  ATTEMPT_ACCEPTED,
  ATTEMPT_RUNNING,
  ATTEMPT_AWAITING_BINDING,
  ATTEMPT_AWAITING_FINAL_TEXT,
  ATTEMPT_RECOVERING,
  ATTEMPT_COMPLETED,
  ATTEMPT_FAILED,
  ATTEMPT_INTERRUPTED,
  ATTEMPT_SUPERSEDED,
  ATTEMPT_ABSENT,
  TERMINAL_ATTEMPT_STATES,
  attemptEventMatches,
  classifyProviderFailure,
  createAttemptId,
  createRunId,
  isAuthoritativeFinalSignal,
  isTerminalAttemptStatus,
  normalizeEventTime,
  normalizeProviderFamily,
  promptFingerprint,
};
