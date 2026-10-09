// Filters Claude account-usage updates.
//
// 5h is a FIXED window — rate_limits.primary.used_percent rises monotonically
// inside the window and resets at the boundary. A stale low-pct snapshot from a
// freshly-launched / long-idle session must not overwrite the true peak from a
// heavy session, so we keep a monotonic guard: same-window updates are accepted
// only when pct >= last accepted pct; a resetsAt jump (>60s) marks a new window.
//
// 7d is a ROLLING window — Anthropic's weekly limit drops as old consumption
// rolls out of the 7-day horizon. resetsAt stays roughly constant in rolling
// mode (always "7 days from now"), so the monotonic guard would pin Hub to the
// historical peak forever and diverge from /usage. For rolling windows we
// accept every non-null update.
function shouldAcceptUsage(prev, next, opts = {}) {
  if (!next) return false;
  if (opts.isRolling) return true;
  if (!prev) return true;
  if (Math.abs((next.resetsAt || 0) - (prev.resetsAt || 0)) > 60_000) return true;
  return (next.pct || 0) >= (prev.pct || 0);
}

function createUsageFilter() {
  const accepted = { usage5h: null, usage7d: null };

  return {
    seed(cached) {
      if (!cached) return;
      if (cached.usage5h) accepted.usage5h = cached.usage5h;
      if (cached.usage7d) accepted.usage7d = cached.usage7d;
    },
    filter(rawUsage5h, rawUsage7d) {
      const ok5 = shouldAcceptUsage(accepted.usage5h, rawUsage5h);
      const ok7 = shouldAcceptUsage(accepted.usage7d, rawUsage7d, { isRolling: true });
      if (ok5) accepted.usage5h = rawUsage5h;
      if (ok7) accepted.usage7d = rawUsage7d;
      return {
        usage5h: ok5 ? rawUsage5h : null,
        usage7d: ok7 ? rawUsage7d : null,
        anyAccepted: ok5 || ok7,
      };
    },
    snapshot() {
      return { usage5h: accepted.usage5h, usage7d: accepted.usage7d };
    },
  };
}

module.exports = { shouldAcceptUsage, createUsageFilter };
