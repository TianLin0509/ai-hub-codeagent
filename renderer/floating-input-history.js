'use strict';

/**
 * 普通 session 底部输入框的「发过的消息」历史（↑/↓ 召回）。
 *
 * 群聊那边（meeting-room.js 的 _pushPromptHistory / _togglePromptHistoryMenu）早就有
 * 一套，但它是下拉菜单式的、和 meeting 生命周期绑死，搬不过来。这里重做成纯逻辑 +
 * 可注入 storage，键盘游标的状态机单独可测——踩过的坑基本都在游标上：
 *   - ↑ 到底之后不能把草稿吃掉；
 *   - ↓ 回到底部要还原用户"正在写但没发"的那段草稿（哪怕是空串）；
 *   - 中途改了字就退出浏览态，下一次 ↑ 要从头开始而不是接着上次的下标。
 *
 * 存储形如 { [sessionId]: string[] }（新的在前）。session 数量有上限，
 * 否则每开一个 session 就往 localStorage 里加一条，永不回收。
 */

const DEFAULT_STORAGE_KEY = 'fi-input-history-v1';
const DEFAULT_LIMIT = 30;
const DEFAULT_SESSION_LIMIT = 40;

function createFloatingInputHistory({
  storage = null,
  storageKey = DEFAULT_STORAGE_KEY,
  limit = DEFAULT_LIMIT,
  sessionLimit = DEFAULT_SESSION_LIMIT,
} = {}) {
  function readAll() {
    if (!storage) return {};
    try {
      const parsed = JSON.parse(storage.getItem(storageKey) || '{}');
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }

  function writeAll(map) {
    if (!storage) return;
    try {
      storage.setItem(storageKey, JSON.stringify(map));
    } catch {
      // localStorage 满了/被禁：历史是锦上添花，绝不能因此让发送流程炸掉。
    }
  }

  function list(sessionId) {
    if (!sessionId) return [];
    const entries = readAll()[sessionId];
    return Array.isArray(entries) ? entries.filter(item => typeof item === 'string') : [];
  }

  function push(sessionId, text) {
    if (!sessionId) return [];
    const value = String(text == null ? '' : text);
    if (!value.trim()) return list(sessionId);
    const map = readAll();
    const previous = Array.isArray(map[sessionId]) ? map[sessionId].filter(i => typeof i === 'string') : [];
    // 连发同一句（重试/催一下）不该在历史里堆成一串同样的东西。
    const deduped = previous.filter(item => item !== value);
    const next = [value, ...deduped].slice(0, limit);
    map[sessionId] = next;

    const keys = Object.keys(map);
    if (keys.length > sessionLimit) {
      // 刚写过的这个必须留下；其余按 Object key 顺序（≈ 插入顺序）砍最老的。
      const doomed = keys.filter(key => key !== sessionId).slice(0, keys.length - sessionLimit);
      for (const key of doomed) delete map[key];
    }
    writeAll(map);
    return next;
  }

  function clear(sessionId) {
    const map = readAll();
    if (sessionId) delete map[sessionId];
    writeAll(map);
  }

  /**
   * 键盘游标。index === -1 表示"没在浏览历史，正在写自己的草稿"。
   */
  function createCursor(sessionId) {
    let index = -1;
    let stashedDraft = null;
    let entries = null;

    function load() {
      if (entries === null) entries = list(sessionId);
      return entries;
    }

    return {
      isBrowsing() { return index >= 0; },
      get index() { return index; },

      /** ↑：往更早翻。返回 null 表示已经到底，调用方不要动输入框。 */
      older(currentText) {
        const items = load();
        if (!items.length) return null;
        if (index === -1) stashedDraft = String(currentText == null ? '' : currentText);
        if (index + 1 >= items.length) return null;
        index += 1;
        return { text: items[index], index };
      },

      /** ↓：往更近翻。翻到底回到进入浏览前的草稿（空串也照还原）。 */
      newer() {
        if (index < 0) return null;
        const items = load();
        index -= 1;
        if (index < 0) {
          const draft = stashedDraft == null ? '' : stashedDraft;
          stashedDraft = null;
          return { text: draft, index: -1, restoredDraft: true };
        }
        return { text: items[index], index };
      },

      /** 用户自己敲了字、发送了、或切走了：退出浏览态。 */
      reset() {
        index = -1;
        stashedDraft = null;
        entries = null;
      },

      /** push 之后缓存的 entries 就旧了。 */
      invalidate() { entries = null; },
    };
  }

  return { list, push, clear, createCursor, storageKey, limit };
}

/**
 * ↑ 该召回历史还是该在多行文本里上移一行？
 *
 * 规矩取 shell / Slack 的共识：只有"光标已经在最开头"或"框是空的"才召回。
 * 否则用户在一段多行 prompt 中间按 ↑ 想上移一行，结果整段被历史顶掉——
 * 这种手感事故比没有历史更糟。
 */
function shouldRecallOlder({ key, isEmpty, caretAtStart, isBrowsing, hasModifier }) {
  if (key !== 'ArrowUp' || hasModifier) return false;
  return !!(isEmpty || caretAtStart || isBrowsing);
}

function shouldRecallNewer({ key, isBrowsing, hasModifier }) {
  // ↓ 只在浏览历史时接管；平时它就是普通的下移一行。
  return key === 'ArrowDown' && !hasModifier && !!isBrowsing;
}

const api = {
  DEFAULT_LIMIT,
  DEFAULT_SESSION_LIMIT,
  DEFAULT_STORAGE_KEY,
  createFloatingInputHistory,
  shouldRecallNewer,
  shouldRecallOlder,
};

if (typeof module !== 'undefined' && module.exports) module.exports = api;
if (typeof window !== 'undefined') window.FloatingInputHistory = api;
