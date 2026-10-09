'use strict';

const BEIJING_TIME_ZONE = 'Asia/Shanghai';
const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000;

function timestampOf(value) {
  if (value instanceof Date) return value.getTime();
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return numeric;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return NaN;
}

function beijingParts(value = Date.now()) {
  const timestamp = timestampOf(value);
  if (!Number.isFinite(timestamp)) return null;
  const shifted = new Date(timestamp + BEIJING_OFFSET_MS);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
    second: shifted.getUTCSeconds(),
    millisecond: shifted.getUTCMilliseconds(),
  };
}

function beijingEpoch(parts = {}) {
  return Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour) || 0,
    Number(parts.minute) || 0,
    Number(parts.second) || 0,
    Number(parts.millisecond) || 0,
  ) - BEIJING_OFFSET_MS;
}

function pad2(value) {
  return String(Number(value) || 0).padStart(2, '0');
}

function beijingDateKey(value) {
  const parts = beijingParts(value);
  return parts ? `${parts.year}-${pad2(parts.month)}-${pad2(parts.day)}` : '';
}

function sameBeijingDay(left, right) {
  const a = beijingParts(left);
  const b = beijingParts(right);
  return !!a && !!b && a.year === b.year && a.month === b.month && a.day === b.day;
}

function formatBeijingClock(value, { seconds = false } = {}) {
  const parts = beijingParts(value);
  if (!parts) return '';
  return `${pad2(parts.hour)}:${pad2(parts.minute)}${seconds ? `:${pad2(parts.second)}` : ''}`;
}

function formatBeijingMonthDay(value, { includeYear = false, separator = '/' } = {}) {
  const parts = beijingParts(value);
  if (!parts) return '';
  const body = `${parts.month}${separator}${parts.day}`;
  return includeYear ? `${parts.year}${separator}${body}` : body;
}

function formatBeijingDateTime(value, { seconds = true } = {}) {
  const parts = beijingParts(value);
  if (!parts) return '';
  return `${parts.year}-${pad2(parts.month)}-${pad2(parts.day)} ${formatBeijingClock(value, { seconds })}`;
}

function formatAbsoluteTime(value, now = Date.now()) {
  const parts = beijingParts(value);
  const current = beijingParts(now);
  if (!parts || !current) return '';
  const clock = `${pad2(parts.hour)}:${pad2(parts.minute)}`;
  const sameYear = parts.year === current.year;
  const sameDay = sameYear && parts.month === current.month && parts.day === current.day;
  if (sameDay) return clock;
  if (sameYear) return `${parts.month}月${parts.day}日 ${clock}`;
  return `${parts.year}年${parts.month}月${parts.day}日 ${clock}`;
}

module.exports = {
  BEIJING_TIME_ZONE,
  BEIJING_OFFSET_MS,
  beijingDateKey,
  beijingEpoch,
  beijingParts,
  formatAbsoluteTime,
  formatBeijingClock,
  formatBeijingDateTime,
  formatBeijingMonthDay,
  sameBeijingDay,
};
