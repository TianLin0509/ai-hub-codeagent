'use strict';

/**
 * 卡片 / PTY 视图模式的按会话记忆。
 *
 * 历史版本会记住每个会话上次停在卡片还是后台。现在普通导航统一从卡片开始，
 * 这份存储只保留给显式工具和旧数据兼容，不能再决定下一次点击的默认视图。
 *
 * 旧格式只记住**处于卡片视图**的会话 id，继续按原格式读写以兼容已有数据；
 * 标准 session 点击与恢复不会再读取它来决定初始视图。
 *
 * 放在 core/ 而不是塞在 renderer.js 里，是为了能单测——renderer.js 是个几千行的
 * 非模块化文件，里面的东西测不到。
 */

const STORAGE_KEY = 'hub.cardViewSessions';
const CARD = 'card';
const PTY = 'pty';
const LIMIT = 300;

function readCardViewSessions(store, storageKey = STORAGE_KEY) {
  if (!store || typeof store.getItem !== 'function') return new Set();
  try {
    const raw = JSON.parse(store.getItem(storageKey) || '[]');
    if (!Array.isArray(raw)) return new Set();
    return new Set(raw.filter(id => typeof id === 'string' && id));
  } catch {
    return new Set();
  }
}

function writeCardViewSessions(store, set, storageKey = STORAGE_KEY) {
  if (!store || typeof store.setItem !== 'function') return false;
  try {
    // 超上限时丢**最早**加入的，保留最近用过的那些。
    store.setItem(storageKey, JSON.stringify([...set].slice(-LIMIT)));
    return true;
  } catch {
    // 存不下只影响下次启动时的视图记忆，不该拦住这次切换。
    return false;
  }
}

function normalizeViewMode(mode) {
  return mode === CARD ? CARD : PTY;
}

function viewModeFor(set, sessionId) {
  return sessionId && set && set.has(sessionId) ? CARD : PTY;
}

/** 返回集合是否真的变了，调用方据此决定要不要落盘。 */
function rememberViewMode(set, sessionId, mode) {
  if (!set || !sessionId) return false;
  const had = set.has(sessionId);
  if (normalizeViewMode(mode) === CARD) set.add(sessionId);
  else set.delete(sessionId);
  return set.has(sessionId) !== had;
}

function forgetViewMode(set, sessionId) {
  return !!(set && sessionId && set.delete(sessionId));
}

/**
 * 点开一个会话时该用哪个视图。
 *
 * 普通 AI 会话每次打开都从卡片开始。后台是当前查看期间的显式操作，不跨点击、
 * resume 或页面恢复继承。PowerShell 没有结构化卡片，因此仍进入 PTY。
 */
function selectionViewModeFor(set, sessionId, { cardCapable = false } = {}) {
  // The runtime can stay PTY while the initial presentation is always cards.
  return cardCapable ? CARD : PTY;
}

module.exports = {
  CARD,
  PTY,
  LIMIT,
  STORAGE_KEY,
  forgetViewMode,
  normalizeViewMode,
  readCardViewSessions,
  rememberViewMode,
  selectionViewModeFor,
  viewModeFor,
  writeCardViewSessions,
};
