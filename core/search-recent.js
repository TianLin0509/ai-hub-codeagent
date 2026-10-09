'use strict';

/**
 * 「昨日之我」全局搜索的最近查询。
 *
 * 2026-08-27 新增：工作台上要显示「常用搜索 · 最近命中」，但搜索模块此前
 * 完全没有留痕，每次都得重新敲关键词。这里只做一件事——把跑过的查询按
 * 「最近 + 命中过」记下来，纯函数，方便测。
 *
 * 存 localStorage（键 hub.searchRecent），和主题、卡片布局同一个理由：
 * 纯观感/习惯偏好，且要同步读。
 */

const STORAGE_KEY = 'hub.searchRecent';
const MAX_ENTRIES = 8;
const MIN_QUERY_LENGTH = 2;

function normalizeQuery(value) {
  return String(value == null ? '' : value).normalize('NFKC').trim().replace(/\s+/g, ' ');
}

function sanitizeEntry(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const query = normalizeQuery(raw.query);
  if (query.length < MIN_QUERY_LENGTH) return null;
  const sessions = Number(raw.sessions);
  const matches = Number(raw.matches);
  const at = Number(raw.at);
  return {
    query,
    sessions: Number.isFinite(sessions) && sessions >= 0 ? Math.round(sessions) : 0,
    matches: Number.isFinite(matches) && matches >= 0 ? Math.round(matches) : 0,
    at: Number.isFinite(at) && at > 0 ? at : 0,
    uses: Number.isFinite(Number(raw.uses)) && Number(raw.uses) > 0 ? Math.round(Number(raw.uses)) : 1,
  };
}

function readRecent(store) {
  if (!store || typeof store.getItem !== 'function') return [];
  let raw;
  try {
    raw = JSON.parse(store.getItem(STORAGE_KEY) || '[]');
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];
  return raw.map(sanitizeEntry).filter(Boolean).slice(0, MAX_ENTRIES);
}

function writeRecent(store, entries) {
  if (!store || typeof store.setItem !== 'function') return;
  try {
    store.setItem(STORAGE_KEY, JSON.stringify(entries.slice(0, MAX_ENTRIES)));
  } catch {
    // 存不下只影响下次的建议列表，不该拦住搜索本身。
  }
}

/**
 * 记一次查询。零命中的不记——记下来只会让工作台上摆着一堆搜不到东西的词。
 * 同一个查询再跑一次不新增条目，只更新命中数、时间并把 uses 加一，然后提到最前。
 */
function recordSearch(store, { query, sessions = 0, matches = 0, now = Date.now() } = {}) {
  const normalized = normalizeQuery(query);
  if (normalized.length < MIN_QUERY_LENGTH) return readRecent(store);
  if (!(Number(sessions) > 0 || Number(matches) > 0)) return readRecent(store);

  const existing = readRecent(store);
  const prior = existing.find(e => e.query === normalized);
  const entry = sanitizeEntry({
    query: normalized,
    sessions,
    matches,
    at: now,
    uses: prior ? prior.uses + 1 : 1,
  });
  const next = [entry].concat(existing.filter(e => e.query !== normalized)).slice(0, MAX_ENTRIES);
  writeRecent(store, next);
  return next;
}

function clearRecent(store) {
  writeRecent(store, []);
  return [];
}

module.exports = {
  STORAGE_KEY,
  MAX_ENTRIES,
  MIN_QUERY_LENGTH,
  normalizeQuery,
  readRecent,
  writeRecent,
  recordSearch,
  clearRecent,
};
