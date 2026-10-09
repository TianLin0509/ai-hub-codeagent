'use strict';

// Compact sidebar labels; full timestamps remain available in the row tooltip.
function sidebarRelativeTime(ts, now = Date.now()) {
  if (!Number.isFinite(Number(ts)) || Number(ts) <= 0) return '—';
  const minutes = Math.max(0, Math.floor((now - Number(ts)) / 60000));
  if (minutes < 1) return 'NOW';
  if (minutes < 60) return `${minutes}M`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)}H`;
  return `${Math.floor(minutes / 1440)}D`;
}

module.exports = { sidebarRelativeTime };
