'use strict';
// Account-level usage for native Claude sessions.
//
// The Hub used to read the 5h/7d figures out of the statusline cache, but the
// status line is a terminal-UI feature: measured against Claude Code 2.1.269 it
// never runs in the stream-json transport the Hub now uses, so that cache stops
// advancing once every Claude session is native. The engine answers the same
// numbers over its own `get_usage` control, which is also the figure `/usage`
// shows, so read them there instead of leaving a frozen ring on screen.

function toResetMs(value) {
  const at = Date.parse(String(value || ''));
  return Number.isFinite(at) ? at : 0;
}

function toWindow(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const raw = entry.utilization;
  if (raw === null || raw === undefined || typeof raw === 'boolean' || String(raw).trim() === '') return null;
  const pct = Number(raw);
  // A missing utilization is not "0% used": publishing that would wipe a real
  // reading out of the monotonic filter.
  if (!Number.isFinite(pct) || pct < 0 || pct > 100) return null;
  return { pct, resetsAt: toResetMs(entry.resets_at) };
}

function claudeAccountUsageFromControl(response, now = Date.now()) {
  const limits = response && response.rate_limits;
  if (!response || response.rate_limits_available === false || !limits || typeof limits !== 'object') return null;
  const usage5h = toWindow(limits.five_hour);
  const usage7d = toWindow(limits.seven_day);
  if (!usage5h && !usage7d) return null;
  return { usage5h, usage7d, observedAt: now,
    ...(typeof response.subscription_type === 'string' ? { subscriptionType: response.subscription_type } : {}) };
}

module.exports = { claudeAccountUsageFromControl };
