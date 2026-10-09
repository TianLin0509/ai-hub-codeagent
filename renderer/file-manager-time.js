'use strict';

// 文件管理行尾的相对时间与「新鲜度」判断。纯函数，便于单测。

const FRESH_WINDOW_MS = 10 * 60 * 1000;
const pad = value => String(value).padStart(2, '0');

function startOfDay(ms) {
  const date = new Date(ms);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

// 刚刚 / N 分钟前 / 今天 HH:MM / 昨天 HH:MM / N 天前 / MM/DD（跨年时带年份）
function formatRelativeTime(ms, now = Date.now()) {
  if (!Number.isFinite(ms) || ms <= 0) return '—';
  const date = new Date(ms);
  const hm = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  const diff = now - ms;
  if (diff < 60 * 1000 && diff > -60 * 1000) return '刚刚';
  if (diff > 0 && diff < 60 * 60 * 1000) return `${Math.floor(diff / 60000)} 分钟前`;
  const days = Math.round((startOfDay(now) - startOfDay(ms)) / 86400000);
  if (days === 0) return `今天 ${hm}`;
  if (days === 1) return `昨天 ${hm}`;
  if (days > 1 && days < 7) return `${days} 天前`;
  const md = `${pad(date.getMonth() + 1)}/${pad(date.getDate())}`;
  return date.getFullYear() === new Date(now).getFullYear() ? md : `${date.getFullYear()}/${md}`;
}

function formatFullTime(ms) {
  return Number.isFinite(ms) && ms > 0 ? new Date(ms).toLocaleString('zh-CN', { hour12: false }) : '';
}

function isFresh(ms, now = Date.now(), windowMs = FRESH_WINDOW_MS) {
  return Number.isFinite(ms) && ms > 0 && now - ms >= -60 * 1000 && now - ms < windowMs;
}

module.exports = { FRESH_WINDOW_MS, formatFullTime, formatRelativeTime, isFresh };
