'use strict';
// Quota auto-resume for native Claude sessions.
//
// The Claude CLI used to do this itself: when a turn hit the usage limit, its
// REPL pinned the conversation, armed a timer on the reported reset time, and
// at the reset typed a continuation prompt into its own input box. Measured
// against 2.1.269 the whole mechanism is REPL-shaped -- its own strings say
// "press enter to continue" and "/rate-limit-options", and its cancel reasons
// include `manual_submit` and `desktop_handoff`. Under the Hub's stream-json
// transport there is no input box to type into: the Hub is the writer. So the
// waiting and the typing move here.
//
// This module is the decision half and stays pure: no timers, no I/O, no
// session objects. The host (main/claude-quota-resume.js) supplies clock,
// runtime snapshot and a fresh usage reading, and executes what is decided.
//
// The one design rule everything below follows: **being late is free, being
// wrong is not**. Every gate can only delay a resume, never invent one, and a
// resume is never sent on the clock alone -- the account's own quota reading
// has to confirm the window actually rolled over.

const { classifyProviderFailure } = require('./groupchat-attempt-protocol');

// CLI parity: it stops waiting when the reset is more than a day out
// ("the usage limit now resets more than 24 hours out").
const HORIZON_MS = 24 * 60 * 60 * 1000;
// Never look before this much past the reset. The reset timestamp is the
// server's, our clock is not, and the new window needs a moment to be visible.
const RESET_GRACE_MS = 60 * 1000;
// Armed this long past its reset without the gates ever clearing (Hub was
// closed, session stayed dormant, quota never actually came back) -- stop
// waiting and hand the decision back to the user, the way the CLI degrades to
// "Usage limit has reset · press enter to continue".
const STALE_AFTER_MS = 2 * 60 * 60 * 1000;
// CLI parity: "Automatic continue stopped after repeated usage-limit hits".
const MAX_REARMS = 3;
// A send that is *known* not to have left the Hub may be retried. A send whose
// confirmation never arrived may not -- that is the resend rule, not a tunable.
const MAX_SEND_ATTEMPTS = 3;
// Utilization at or above this counts as "this window is what blocked us",
// but only when the failure text already agrees it was a quota wall.
const EXHAUSTED_PCT = 95;
// Without that agreement the quota reading has to carry the claim alone, so it
// has to be unambiguous. This matters more than it looks: the canonical
// usage-limit message is produced server-side (it is nowhere in the 2.1.269
// binary), so there is no sample to write a reliable pattern against, and a
// text-only trigger would be guessing. The account's own utilization is the
// evidence that cannot drift with upstream wording.
const CONFIRMED_PCT = 99;
// ...and below this counts as "this window is genuinely usable again". The gap
// is deliberate: a value bouncing around the limit must not read as recovered.
const RECOVERED_PCT = 90;
// Poll cadence of the host. Wall-clock comparison per tick, never one long
// timer -- a laptop that slept through the reset has to still wake up correct.
const TICK_MS = 60 * 1000;
// Per-session spread so several waiting seats do not fire the same second.
const JITTER_MAX_MS = 20 * 1000;

// The engine's own continuation wording, copied from the CLI binary so a
// resumed turn reads to the model exactly like a CLI-resumed one did.
const CONTINUATION_PROMPT = 'Your claude.ai usage limit has reset. Continue the '
  + 'task you were working on when the limit was reached; do not repeat work '
  + 'that is already complete.';

const WINDOWS = [{ key: 'usage5h', id: '5h', label: '5 小时' }, { key: 'usage7d', id: '7d', label: '7 天' }];

function windowOf(usage, id) {
  const entry = WINDOWS.find(w => w.id === id);
  return entry && usage ? usage[entry.key] || null : null;
}

// Which window actually blocked this turn: exhausted, and still counting down.
// When two are exhausted the earlier reset is the one worth waiting for, but
// recovery then has to clear both (see verifyRecovered).
function bindingQuotaWindow(usage, now) {
  const exhausted = WINDOWS
    .map(w => ({ ...w, value: usage && usage[w.key] }))
    .filter(w => w.value && Number(w.value.pct) >= EXHAUSTED_PCT && Number(w.value.resetsAt) > now);
  if (!exhausted.length) return null;
  exhausted.sort((a, b) => a.value.resetsAt - b.value.resetsAt);
  const best = exhausted[0];
  return { window: best.id, label: best.label, pct: Number(best.value.pct), resetsAt: Number(best.value.resetsAt) };
}

// Deliberately narrow: only a turn the shared classifier calls `quota_exceeded`
// counts. A 429 (`rate_limited`) is a different animal with no reset time to
// wait for, and a network drop must never be mistaken for a quota wall. This is
// corroboration, not the trigger -- see CONFIRMED_PCT for why.
function isQuotaFailure(failureReason) {
  const failure = classifyProviderFailure({ reason: failureReason });
  return !!failure && failure.code === 'quota_exceeded';
}

/**
 * Decide whether a failed turn should start a wait.
 * @returns {{ok:true, record:object}|{ok:false, code:string, message:string}}
 */
function armQuotaWait({ sessionId, userMessageId, reason, usage, usageObservedAt, now, rearms = 0 }) {
  if (rearms >= MAX_REARMS) {
    return { ok: false, code: 'rearm_cap', message: `连续 ${MAX_REARMS} 次撞到额度上限，已停止自动继续` };
  }
  // No quota reading means no way to verify recovery later. Refusing to arm is
  // the honest outcome: the host turns this into a visible manual button
  // instead of a wait that could never prove itself right.
  if (!usage || !usageObservedAt) {
    return { ok: false, code: 'usage_unavailable', message: '读不到账号额度，无法确认恢复时间' };
  }
  const binding = bindingQuotaWindow(usage, now);
  if (!binding) return { ok: false, code: 'no_exhausted_window', message: '账号额度未显示任何窗口已耗尽' };
  const corroborated = isQuotaFailure(reason);
  if (!corroborated && binding.pct < CONFIRMED_PCT) {
    return { ok: false, code: 'not_quota_failure', message: '这一轮的失败不像是额度耗尽' };
  }
  if (binding.resetsAt - now > HORIZON_MS) {
    return { ok: false, code: 'horizon_exceeded', message: '额度重置在 24 小时以外，不等待' };
  }
  return {
    ok: true,
    record: {
      sessionId,
      status: 'armed',
      userMessageId: userMessageId || null,
      reason: String(reason || '').slice(0, 400),
      evidence: corroborated ? 'message+quota' : 'quota',
      window: binding.window,
      windowLabel: binding.label,
      armedPct: binding.pct,
      resetsAt: binding.resetsAt,
      armedAt: now,
      // Frozen at arm time: anything the session runs after this is the user
      // talking, and the user talking cancels the wait.
      baselineStartedAt: 0,
      rearms,
      sendAttempts: 0,
      jitterMs: Math.floor(Math.random() * JITTER_MAX_MS),
      lastCheckedAt: 0,
      note: 'waiting_for_reset',
      message: '',
    },
  };
}

// The load-bearing check. A reading taken before the reset proves nothing about
// after it, so freshness is measured against the reset instant, not against
// "recent". Then the window must have actually rolled to a later one -- a
// utilization number alone can drop for unrelated reasons.
function verifyRecovered(record, usage, usageObservedAt, now) {
  if (!usage || !usageObservedAt) return { ok: false, note: 'usage_unverified' };
  if (usageObservedAt < record.resetsAt) return { ok: false, note: 'usage_predates_reset' };
  const current = windowOf(usage, record.window);
  if (!current) return { ok: false, note: 'usage_window_missing' };
  if (!(Number(current.resetsAt) > record.resetsAt)) return { ok: false, note: 'window_not_rolled' };
  if (Number(current.pct) >= RECOVERED_PCT) return { ok: false, note: 'quota_still_high' };
  // The window we waited on rolled, but the other one can still be the wall --
  // resuming into it would just burn the turn and re-arm.
  const other = WINDOWS.find(w => w.id !== record.window);
  const otherValue = other && usage[other.key];
  if (otherValue && Number(otherValue.pct) >= EXHAUSTED_PCT && Number(otherValue.resetsAt) > now) {
    return { ok: false, note: 'other_window_exhausted' };
  }
  return { ok: true, note: 'verified' };
}

/**
 * One tick's decision for one armed record.
 *
 * @param {object} record            armed record (see armQuotaWait)
 * @param {object} ctx
 * @param {number} ctx.now
 * @param {boolean} ctx.enabled      Hub-level switch
 * @param {object|null} ctx.runtime  {present, dormant, connection, state, pendingRequests,
 *                                    cancelling, unreconciled, backgroundBusy, startedAt}
 * @param {object|null} ctx.usage    latest account usage reading
 * @param {number} ctx.usageObservedAt
 * @returns {{action:'hold'|'fire'|'stale'|'cancel', note:string, needsUsage?:boolean}}
 */
function decideQuotaResume(record, ctx = {}) {
  const now = Number(ctx.now) || Date.now();
  if (!record || record.status === 'stale') return { action: 'hold', note: 'awaiting_user' };
  if (!ctx.enabled) return { action: 'cancel', note: 'setting_off' };

  const runtime = ctx.runtime;
  // The session is gone for good -- nothing to continue into.
  if (!runtime || !runtime.present) return { action: 'cancel', note: 'session_gone' };
  // The user ran something after we armed. Their turn supersedes ours, exactly
  // as `manual_submit` cancels the CLI's wait.
  if (Number(runtime.startedAt) > Math.max(record.armedAt, record.baselineStartedAt || 0)) {
    return { action: 'cancel', note: 'manual_submit' };
  }

  const expired = now > record.resetsAt + STALE_AFTER_MS;
  // Everything below can only be a reason to wait longer. Once the wait has run
  // this far past its reset, stop waiting silently and surface a button: a
  // wait nobody can see is indistinguishable from a bug.
  const hold = note => (expired ? { action: 'stale', note } : { action: 'hold', note });

  // A dormant seat is a history entry. Waking one up to continue a task the
  // user walked away from is exactly the kind of surprise this feature must not
  // produce, so the wait simply parks until the user opens it again.
  if (runtime.dormant) return hold('session_dormant');
  if (runtime.connection !== 'connected') return hold('not_connected');
  // Unreconciled means an earlier submission's fate is unknown. Sending into
  // that is how a Hub ends up double-submitting; the repo's rule is to stop.
  if (runtime.unreconciled) return hold('needs_reconciliation');
  if (runtime.cancelling) return hold('cancelling');
  if (Number(runtime.pendingRequests) > 0) return hold('awaiting_permission');
  if (['starting', 'running', 'waiting'].includes(runtime.state) || runtime.backgroundBusy) {
    return hold('session_busy');
  }
  if (now < record.resetsAt + RESET_GRACE_MS + (record.jitterMs || 0)) return hold('waiting_for_reset');

  const verified = verifyRecovered(record, ctx.usage, Number(ctx.usageObservedAt) || 0, now);
  if (!verified.ok) {
    const decision = hold(verified.note);
    // Tell the host a fresh reading is what is missing, so it goes and asks the
    // engine rather than sitting on a cached number until the record goes stale.
    // Only worth asking while we are still holding -- a record that already
    // went stale is the user's call, not another control call.
    if (decision.action === 'hold' && ['usage_unverified', 'usage_predates_reset'].includes(verified.note)) {
      decision.needsUsage = true;
    }
    return decision;
  }
  if (Number(record.sendAttempts) >= MAX_SEND_ATTEMPTS) return { action: 'stale', note: 'send_attempts_exhausted' };
  return { action: 'fire', note: 'verified' };
}

const NOTE_TEXT = {
  waiting_for_reset: '等待额度重置',
  usage_unverified: '正在核对账号额度',
  usage_predates_reset: '正在核对账号额度',
  usage_window_missing: '账号额度暂时读不到该窗口',
  window_not_rolled: '额度窗口尚未翻页，继续等待',
  quota_still_high: '额度仍接近上限，继续等待',
  other_window_exhausted: '另一个额度窗口仍已耗尽，继续等待',
  session_busy: '会话正忙，稍后再继续',
  session_dormant: '会话已休眠，打开后才会继续',
  not_connected: '会话未连接，连上后才会继续',
  needs_reconciliation: '上一条提交待核对，不会自动继续',
  awaiting_permission: '有待确认的操作，不会自动继续',
  cancelling: '正在停止，暂不继续',
  send_attempts_exhausted: '自动继续多次未能送达',
  awaiting_user: '等待你确认后继续',
};

function formatClock(ts) {
  const date = new Date(Number(ts) || 0);
  if (!Number.isFinite(date.getTime())) return '';
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

// One line for the composer. States what is being waited on and when, because
// "等额度" without a time is the same silence this feature exists to remove.
function describeQuotaWait(record, now = Date.now()) {
  if (!record) return null;
  if (record.status === 'stale') {
    return { text: '额度等待已结束，未自动继续', detail: record.message || NOTE_TEXT[record.note] || '', canResume: true, canCancel: true };
  }
  if (record.status === 'resuming') {
    return { text: '额度已恢复，正在继续上一轮', detail: '', canResume: false, canCancel: true };
  }
  const remaining = record.resetsAt - now;
  const detail = NOTE_TEXT[record.note] || '';
  const when = formatClock(record.resetsAt);
  const text = remaining > 0
    ? `等 ${record.windowLabel || ''}额度恢复 · 预计 ${when} 继续`.replace(/\s+/g, ' ').trim()
    : '额度应已恢复，正在核对后继续';
  return { text, detail, canResume: true, canCancel: true };
}

module.exports = {
  HORIZON_MS,
  RESET_GRACE_MS,
  STALE_AFTER_MS,
  MAX_REARMS,
  MAX_SEND_ATTEMPTS,
  EXHAUSTED_PCT,
  CONFIRMED_PCT,
  RECOVERED_PCT,
  TICK_MS,
  CONTINUATION_PROMPT,
  NOTE_TEXT,
  bindingQuotaWindow,
  isQuotaFailure,
  armQuotaWait,
  verifyRecovered,
  decideQuotaResume,
  describeQuotaWait,
};
