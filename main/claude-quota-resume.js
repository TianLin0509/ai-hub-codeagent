'use strict';
// Host half of the native-Claude quota watchdog. The decisions live in
// core/claude-quota-watchdog.js; everything with a side effect lives here:
// the tick, the `get_usage` control call, the closed-loop send, the persisted
// record and the two IPC actions behind the composer buttons.
//
// Three rules this file exists to keep:
//   1. A resume is only ever sent through the same closed loop a user prompt
//      uses (`groupChatWatcher.sendToPty` → `native.submit`). No bare writes,
//      no blind Enter -- see the prompt-submit iron rule in CLAUDE.md.
//   2. A send whose confirmation never arrived is never retried. Only a send
//      that provably did not leave the Hub may be attempted again.
//   3. A wait is always visible. Every record is published onto the session's
//      runtime snapshot, and a wait that cannot proceed ends as `stale` with a
//      button rather than dissolving quietly.

const fs = require('fs');
const path = require('path');
const {
  TICK_MS,
  CONTINUATION_PROMPT,
  MAX_SEND_ATTEMPTS,
  NOTE_TEXT,
  armQuotaWait,
  decideQuotaResume,
  isQuotaFailure,
} = require('../core/claude-quota-watchdog');

// Errors that prove the prompt never reached the engine. Anything else -- above
// all CLAUDE_SUBMISSION_UNKNOWN / _TIMEOUT -- means the fate of that write is
// unknown, and unknown writes are reconciled by a human, not retried by us.
const NOT_SENT_CODES = new Set([
  'CLAUDE_CANCELLING',
  'CLAUDE_RECONNECTING',
  'CLAUDE_CLOSED',
  'CLAUDE_CONFIGURATION_UNKNOWN',
  'CLAUDE_CONTENT_MISMATCH',
  'CLAUDE_SUBMISSION_CANCELLED',
]);

// How long a "this failure was not a quota wall" answer is reused. Quota does
// not move in seconds, and a seat failing in a loop must not turn into a
// `get_usage` control call per failure.
const NOT_QUOTA_CACHE_MS = 30_000;

function readRecords(statePath) {
  try {
    const value = JSON.parse(fs.readFileSync(statePath, 'utf8').replace(/^\uFEFF/, ''));
    const list = value && Array.isArray(value.waits) ? value.waits : [];
    // `stale` records carry no reset time -- they are a button, not a wait --
    // but they still deserve to survive a restart.
    return list.filter(record => record && typeof record.sessionId === 'string'
      && (Number(record.resetsAt) > 0 || record.status === 'stale'));
  } catch (error) {
    if (error && error.code !== 'ENOENT') {
      console.warn('[claude-quota] state unreadable, starting empty:', error.message);
    }
    return [];
  }
}

function writeRecords(statePath, records) {
  const temporary = `${statePath}.${process.pid}-${Date.now()}.tmp`;
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(temporary, JSON.stringify({ schemaVersion: 1, waits: records }, null, 2) + '\n', 'utf8');
  fs.renameSync(temporary, statePath);
}

function createClaudeQuotaResume(deps = {}) {
  const {
    sessionManager,
    statePath,
    isEnabled = () => true,
    sendToPty = (...args) => require('../core/group-chat-watcher').sendToPty(...args),
    onRecordChanged = () => {},
    logger = console,
    now = Date.now,
    tickMs = TICK_MS,
  } = deps;
  if (!sessionManager) throw new Error('claude-quota-resume requires the session manager');

  /** @type {Map<string, object>} active waits (armed / resuming / stale) */
  const records = new Map();
  /** @type {Map<string, {rearms:number, updatedAt:number}>} per-session episode accounting */
  const episodes = new Map();
  const usageReads = new Map();
  let timer = null;
  let stopped = false;

  // A record persisted as `resuming` means the Hub died between the send and
  // its receipt: that write's fate is unknown, which is precisely the state
  // that must never be retried. Restore it as the user's decision instead of
  // leaving it parked forever in a status `evaluate` deliberately skips.
  for (const record of readRecords(statePath || '')) {
    records.set(record.sessionId, record.status === 'resuming'
      ? { ...record, status: 'stale', message: '上次自动继续的结果未确认（Hub 在发送途中退出），不会重发' }
      : record);
  }
  /** @type {Map<string, number>} sessions whose last failure was demonstrably not a quota wall */
  const notQuotaUntil = new Map();

  function persist() {
    if (!statePath) return;
    try { writeRecords(statePath, [...records.values()]); }
    catch (error) { logger.warn('[claude-quota] state write failed:', error.message); }
  }

  // The wait rides on the runtime snapshot, which is what the composer already
  // reads. A driver that has gone away simply has nothing to publish onto.
  function publish(sessionId) {
    const native = sessionManager.getNativeClaude?.(sessionId);
    const record = records.get(sessionId) || null;
    try { native?.setQuotaWait?.(record); }
    catch (error) { logger.warn('[claude-quota] publish failed:', error.message); }
    try { onRecordChanged({ sessionId, record }); }
    catch (error) { logger.warn('[claude-quota] notify failed:', error.message); }
  }

  function setRecord(sessionId, record) {
    if (record) records.set(sessionId, record);
    else records.delete(sessionId);
    persist();
    publish(sessionId);
  }

  function runtimeSnapshot(sessionId) {
    const session = sessionManager.getSession?.(sessionId);
    const native = sessionManager.getNativeClaude?.(sessionId);
    if (!session || session.runtimeBackend !== 'claude-stream-json') return { present: false };
    // A dormant seat has no driver. That is a reason to park the wait, not to
    // drop it, so report presence from the session and dormancy separately.
    if (!native) return { present: true, dormant: true };
    const runtime = native.runtime || {};
    return {
      present: true,
      dormant: session.status === 'dormant',
      connection: runtime.connection,
      state: runtime.state,
      pendingRequests: (runtime.requests || []).length,
      cancelling: runtime.cancellation?.status === 'pending',
      unreconciled: !!native.unreconciled,
      backgroundBusy: (runtime.backgroundTasks || []).length > 0 || (runtime.backgroundActivities || []).length > 0,
      startedAt: Number(runtime.startedAt) || 0,
    };
  }

  // One fresh account reading, de-duplicated per session so a tick storm cannot
  // turn into a control-call storm. A failure is reported as "no reading",
  // which can only make the watchdog wait longer.
  async function readUsage(sessionId) {
    if (usageReads.has(sessionId)) return usageReads.get(sessionId);
    const native = sessionManager.getNativeClaude?.(sessionId);
    if (!native?.readAccountUsage) return { usage: null, observedAt: 0 };
    const flight = Promise.resolve()
      .then(() => native.readAccountUsage())
      .then(usage => (usage ? { usage, observedAt: Number(usage.observedAt) || now() } : { usage: null, observedAt: 0 }))
      .catch(error => {
        logger.warn(`[claude-quota] usage read failed for ${sessionId.slice(0, 8)}:`, error.message);
        return { usage: null, observedAt: 0 };
      })
      .finally(() => { usageReads.delete(sessionId); });
    usageReads.set(sessionId, flight);
    return flight;
  }

  function markStale(sessionId, record, message) {
    setRecord(sessionId, { ...record, status: 'stale', note: record.note, message, staleAt: now() });
    logger.log(`[claude-quota] ${sessionId.slice(0, 8)} wait ended without resuming: ${message}`);
  }

  async function fire(sessionId, record) {
    const session = sessionManager.getSession?.(sessionId);
    const native = sessionManager.getNativeClaude?.(sessionId);
    if (!session || !native) return;
    const attempt = { ...record, status: 'resuming', sendAttempts: Number(record.sendAttempts || 0) + 1, firedAt: now() };
    setRecord(sessionId, attempt);
    try {
      await native.prepareForNewPrompt?.();
      if (sessionManager.getNativeClaude?.(sessionId) !== native) throw Object.assign(new Error('会话已变化，未发送'), { code: 'CLAUDE_CLOSED' });
      const receipt = await sendToPty(sessionId, CONTINUATION_PROMPT, session.kind, {
        requireReady: false,
        clientSubmissionId: `quota-resume-${attempt.armedAt}-${attempt.sendAttempts}`,
      });
      if (!receipt || receipt.ok === false || ['unknown', 'content-mismatch', 'rejected'].includes(receipt.status)) {
        markStale(sessionId, attempt, '自动继续已提交但未获确认，请核对后手动继续');
        return;
      }
      // Sent and acknowledged. The episode stays on the books only for rearm
      // accounting; a successful turn clears it in onTurnComplete.
      episodes.set(sessionId, { rearms: Number(attempt.rearms || 0) + 1, updatedAt: now() });
      setRecord(sessionId, null);
      logger.log(`[claude-quota] ${sessionId.slice(0, 8)} resumed after quota reset`);
    } catch (error) {
      const code = error && error.code;
      if (NOT_SENT_CODES.has(code) && attempt.sendAttempts < MAX_SEND_ATTEMPTS) {
        // Provably not sent: it is safe to come back next tick.
        setRecord(sessionId, { ...attempt, status: 'armed', note: 'send_retry', message: error.message });
        return;
      }
      if (NOT_SENT_CODES.has(code)) {
        markStale(sessionId, attempt, '自动继续多次未能送达：' + error.message);
        return;
      }
      markStale(sessionId, attempt, '自动继续的结果无法确认，不会重发：' + error.message);
    }
  }

  async function evaluate(sessionId) {
    const record = records.get(sessionId);
    if (!record || record.status === 'resuming') return;
    const runtime = runtimeSnapshot(sessionId);
    let usage = null, usageObservedAt = 0;
    let decision = decideQuotaResume(record, { now: now(), enabled: isEnabled(), runtime, usage, usageObservedAt });
    if (decision.needsUsage) {
      const reading = await readUsage(sessionId);
      if (records.get(sessionId) !== record) return;
      usage = reading.usage; usageObservedAt = reading.observedAt;
      decision = decideQuotaResume(record, { now: now(), enabled: isEnabled(), runtime, usage, usageObservedAt });
    }
    if (decision.action === 'cancel') {
      logger.log(`[claude-quota] ${sessionId.slice(0, 8)} wait cancelled: ${decision.note}`);
      setRecord(sessionId, null);
      return;
    }
    if (decision.action === 'stale') {
      markStale(sessionId, record, NOTE_TEXT[decision.note] || decision.note);
      return;
    }
    if (decision.action === 'hold') {
      if (record.note !== decision.note || !record.lastCheckedAt) {
        setRecord(sessionId, { ...record, note: decision.note, lastCheckedAt: now() });
      } else records.set(sessionId, { ...record, lastCheckedAt: now() });
      return;
    }
    if (decision.action === 'fire') await fire(sessionId, record);
  }

  async function tick() {
    if (stopped) return;
    for (const sessionId of [...records.keys()]) {
      try { await evaluate(sessionId); }
      catch (error) { logger.warn(`[claude-quota] tick failed for ${sessionId.slice(0, 8)}:`, error.message); }
    }
  }

  // A failed turn is the only thing that arms a wait, and it arms one only on a
  // reading taken *after* the failure -- a cached number from minutes ago may
  // predate the wall we just hit.
  async function onTurnComplete({ sessionId, status }) {
    if (status === 'completed') { episodes.delete(sessionId); notQuotaUntil.delete(sessionId); return; }
    if (status !== 'failed' || !isEnabled()) return;
    const existing = records.get(sessionId);
    if (existing && existing.status !== 'stale') return;
    const native = sessionManager.getNativeClaude?.(sessionId);
    if (!native) return;
    // A seat failing in a loop for some unrelated reason would otherwise issue
    // one `get_usage` control per failure. Quota does not move that fast, so a
    // recent "not a quota wall" answer is reused for a short while.
    if (Number(notQuotaUntil.get(sessionId)) > now()) return;
    const reason = native.runtime?.reason || '';
    // Stamped before the await, not after. Reading the account takes real time,
    // and a prompt the user sends inside that window would otherwise start a
    // turn *earlier* than `armedAt` -- which is exactly the comparison
    // decideQuotaResume uses to notice the user spoke first. Arming on a later
    // stamp would hide their turn and let us continue on top of it.
    const armAt = now();
    // Same reason: this has to be the failed turn's start, read before the
    // await. Reading it afterwards could capture a turn the user started in
    // the meantime and quietly raise the bar past their own work.
    const failedTurnStartedAt = Number(native.runtime?.startedAt) || 0;
    const { usage, observedAt } = await readUsage(sessionId);
    const rearms = Number(episodes.get(sessionId)?.rearms || 0);
    const armed = armQuotaWait({
      sessionId, reason, usage, usageObservedAt: observedAt, now: armAt, rearms,
      userMessageId: native.runtime?.userMessageId || null,
    });
    if (!armed.ok) {
      // A quota wall we cannot time is still worth surfacing: the user gets a
      // "继续" button instead of a wait that could never verify itself.
      if (armed.code === 'usage_unavailable' && isQuotaFailure(reason)) {
        setRecord(sessionId, { sessionId, status: 'stale', note: 'awaiting_user', message: armed.message,
          armedAt: now(), resetsAt: 0, rearms, sendAttempts: 0 });
        return;
      }
      if (['rearm_cap', 'horizon_exceeded'].includes(armed.code)) {
        setRecord(sessionId, { sessionId, status: 'stale', note: 'awaiting_user', message: armed.message,
          armedAt: now(), resetsAt: 0, rearms, sendAttempts: 0 });
        return;
      }
      // The account itself says this was not a quota wall, so the next few
      // failures of the same seat need not ask again.
      if (['not_quota_failure', 'no_exhausted_window'].includes(armed.code)) {
        notQuotaUntil.set(sessionId, now() + NOT_QUOTA_CACHE_MS);
      }
      return;
    }
    const record = { ...armed.record, baselineStartedAt: failedTurnStartedAt };
    setRecord(sessionId, record);
    logger.log(`[claude-quota] ${sessionId.slice(0, 8)} armed; ${record.windowLabel} window resets at `
      + new Date(record.resetsAt).toISOString() + ` (evidence: ${record.evidence})`);
  }

  return {
    start() {
      if (timer || stopped) return;
      for (const sessionId of records.keys()) publish(sessionId);
      timer = setInterval(() => { void tick(); }, tickMs);
      if (timer.unref) timer.unref();
    },
    stop() {
      stopped = true;
      if (timer) { clearInterval(timer); timer = null; }
    },
    onTurnComplete,
    tick,
    snapshot: sessionId => records.get(sessionId) || null,
    all: () => [...records.values()],
    // User pressed 「现在继续」. They have decided; skip the clock and the quota
    // verification, but keep the closed loop and the visible outcome.
    async resumeNow(sessionId) {
      const record = records.get(sessionId);
      if (!record) return { ok: false, error: 'no-wait', message: '当前没有等待中的额度续跑' };
      const runtime = runtimeSnapshot(sessionId);
      if (!runtime.present || runtime.dormant) return { ok: false, error: 'session-unavailable', message: '会话不可用，请先打开会话' };
      if (runtime.connection !== 'connected') return { ok: false, error: 'not-connected', message: '会话未连接' };
      if (runtime.unreconciled) return { ok: false, error: 'needs-reconciliation', message: '上一条提交待核对，不会自动继续' };
      if (['starting', 'running', 'waiting'].includes(runtime.state)) return { ok: false, error: 'busy', message: '会话正忙' };
      await fire(sessionId, { ...record, status: 'armed', sendAttempts: 0 });
      const after = records.get(sessionId);
      return after?.status === 'stale'
        ? { ok: false, error: 'resume-unconfirmed', message: after.message }
        : { ok: true };
    },
    cancel(sessionId) {
      if (!records.has(sessionId)) return { ok: false, error: 'no-wait' };
      setRecord(sessionId, null);
      return { ok: true };
    },
    // A session that closes for good should not leave a wait behind.
    forget(sessionId) { if (records.has(sessionId)) setRecord(sessionId, null); },
  };
}

// Two actions, both of them a user decision about a wait they can see.
// Neither creates a wait; only a failed turn does that.
function registerClaudeQuotaIpc(ipcMain, controller) {
  ipcMain.handle('claude-native:quota-resume-now', async (_event, request = {}) => {
    const sessionId = typeof request.sessionId === 'string' ? request.sessionId : '';
    if (!sessionId) return { ok: false, error: 'bad-request' };
    try { return await controller.resumeNow(sessionId); }
    catch (error) { return { ok: false, error: 'resume-threw', message: error.message }; }
  });
  ipcMain.handle('claude-native:quota-cancel', (_event, request = {}) => {
    const sessionId = typeof request.sessionId === 'string' ? request.sessionId : '';
    if (!sessionId) return { ok: false, error: 'bad-request' };
    try { return controller.cancel(sessionId); }
    catch (error) { return { ok: false, error: 'cancel-threw', message: error.message }; }
  });
}

module.exports = { createClaudeQuotaResume, registerClaudeQuotaIpc, NOT_SENT_CODES };
