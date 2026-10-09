'use strict';

// 卡片多选复制（微信「多选 → 逐条转发」的等价物）。
//
// 为什么不是「近 X 轮」的加强版：近 X 轮只能从尾部整段切，想挑第 2 轮的问题 +
// 第 7 轮的回答就只能复制两次再手工拼。多选把「选哪几条」交给用户，一次复制成型。
//
// 关键约束：卡片会被 patchTurnCardInPlace 原地重渲染 —— 它会先清掉卡片上除
// data-session-id 外的全部属性（class 也没了）再换掉子节点。所以勾选状态绝不能
// 只存在 DOM 上，必须以 turnId 集合为准，DOM 只是投影，重渲染后由 syncDom 重贴。
const { assistantSender, normalizeCopiedText } = require('./recent-turn-copy.js');

/**
 * 把选中的若干条消息拼成「逐条转发」式纯文本。
 * 与「近 X 轮」的按轮分组不同，这里保持卡片顺序、一条一块，条与条之间不做配对。
 */
function formatSelectedMessages(entries) {
  const list = (Array.isArray(entries) ? entries : [])
    .filter(entry => entry && (entry.role === 'user' || entry.role === 'assistant'))
    .map(entry => ({ ...entry, text: normalizeCopiedText(entry.text) }))
    .filter(entry => entry.text);

  if (!list.length) return { text: '', copiedCount: 0 };

  const blocks = list.map((entry, index) => {
    const who = entry.sender || (entry.role === 'user' ? '我' : assistantSender(entry));
    const time = String(entry.time || '').trim();
    return `【${index + 1}】${who}${time ? ` · ${time}` : ''}\n${entry.text}`;
  });

  return {
    text: `===== 转发 ${list.length} 条消息 =====\n\n${blocks.join('\n\n')}`,
    copiedCount: list.length,
  };
}

function createCardMultiSelectController(options = {}) {
  const doc = options.document || (typeof document !== 'undefined' ? document : null);
  const win = options.window || (typeof window !== 'undefined' ? window : null);
  const nav = options.navigator || (win && win.navigator) || {};
  const getActiveSessionId = typeof options.getActiveSessionId === 'function'
    ? options.getActiveSessionId
    : () => null;
  const getTurnById = typeof options.getTurnById === 'function'
    ? options.getTurnById
    : (turnId) => win && win._sessionTurns && win._sessionTurns.get(turnId);
  const extractVisibleCardText = typeof options.extractVisibleCardText === 'function'
    ? options.extractVisibleCardText
    : (root) => String((root && (root.innerText || root.textContent)) || '').trim();
  // 单一剪贴板写入方：和「复制对话」/ Ctrl+C 共用 Electron 原生路径（写后读回校验）。
  // 混用 navigator.clipboard 会让 Chromium 继续持有剪贴板，粘贴拿到旧缓存。
  const writeClipboardText = typeof options.copyText === 'function'
    ? (text) => options.copyText(text, { source: 'card-multi-select', silent: true })
    : async (text) => {
      if (!nav.clipboard || typeof nav.clipboard.writeText !== 'function') {
        throw new Error('clipboard unavailable');
      }
      await Promise.resolve(nav.clipboard.writeText(text));
      return { ok: true, source: 'navigator-fallback' };
    };

  const cardSelector = options.cardSelector || '.turn-card';
  const cardId = options.getCardId || (card => String(card.dataset.turnId || ''));
  const selected = new Set();
  let active = false;
  let modeSessionId = null;
  let visible = false;
  let bar = null;
  let countEl = null;
  let selectAllBtn = null;
  let copyBtn = null;
  let exitBtn = null;
  let cardObserver = null;
  let resetTimer = null;
  let syncScheduled = false;

  function overlay() {
    return options.container || (doc && doc.getElementById('msg-overlay'));
  }

  function cardsInOrder() {
    const root = overlay();
    if (!root || typeof root.querySelectorAll !== 'function') return [];
    if (options.getCards) return options.getCards(root);
    const activeSessionId = String(getActiveSessionId() || '');
    return Array.from(root.querySelectorAll(':scope > .turn-card[data-turn-id]'))
      .filter(card => {
        const cardSessionId = String((card.dataset && card.dataset.sessionId) || '');
        return !cardSessionId || !activeSessionId || cardSessionId === activeSessionId;
      });
  }

  function cardTime(card) {
    const meta = card && typeof card.querySelector === 'function'
      ? card.querySelector('.turn-head .turn-meta')
      : null;
    return String((meta && (meta.textContent || '')) || '').trim();
  }

  function collectSelectedEntries() {
    return cardsInOrder()
      .filter(card => selected.has(cardId(card)))
      .map(card => {
        if (options.getEntry) return options.getEntry(card);
        // 乐观 user 卡片（pending-user-*，用户刚按下回车、transcript 还没落盘）
        // 压根不进 _sessionTurns。以前这里直接 return null 丢掉它 ——
        // 结果是操作条写着「已选 2 条」、剪贴板里只有 1 条，静默少一条。
        // 卡片自己已经带着角色（.user class）和正文，退回读 DOM 就够了。
        const turn = getTurnById(card.dataset.turnId);
        const role = turn && (turn.role === 'user' || turn.role === 'assistant')
          ? turn.role
          : (card.classList && card.classList.contains('user') ? 'user' : 'assistant');
        return {
          role,
          text: extractVisibleCardText(card.querySelector('.turn-body')),
          kind: turn ? turn.kind : undefined,
          model: turn ? turn.model : undefined,
          time: cardTime(card),
        };
      })
      .filter(Boolean);
  }

  function restoreCopyButton() {
    if (!copyBtn) return;
    copyBtn.textContent = copyBtn.dataset.defaultLabel || '一键复制';
    copyBtn.classList.remove('copied', 'copy-empty', 'copy-error');
  }

  function showFeedback(label, className) {
    if (!copyBtn) return;
    if (resetTimer) clearTimeout(resetTimer);
    copyBtn.textContent = label;
    copyBtn.classList.remove('copied', 'copy-empty', 'copy-error');
    if (className) copyBtn.classList.add(className);
    resetTimer = setTimeout(restoreCopyButton, 1800);
  }

  // 操作条上的数字必须等于「点复制会拿到几条」，所以它数的是**当前真在 DOM 里**
  // 的勾选卡片，而不是 selected 集合的大小。两者在历史重载的空窗期会短暂不一致。
  function updateBar(totalCards, presentSelected) {
    if (bar) bar.hidden = !active;
    if (countEl) countEl.textContent = `已选 ${presentSelected} 条`;
    if (copyBtn) copyBtn.disabled = presentSelected === 0;
    if (selectAllBtn) {
      const allChecked = totalCards > 0 && presentSelected >= totalCards;
      selectAllBtn.textContent = allChecked ? '取消全选' : '全选';
      selectAllBtn.dataset.mode = allChecked ? 'clear' : 'all';
      selectAllBtn.disabled = totalCards === 0;
    }
  }

  /**
   * DOM 只是勾选状态的投影：卡片重渲染会抹掉 class，这里按 turnId 集合重贴。
   *
   * 这里**不能**按「turnId 现在不在 DOM 里」就把它从 selected 里删掉。
   * loadSessionHistoryToOverlay 的非增量路径是先同步 innerHTML='' 再 await 一次
   * 真 IPC + 读盘解析，中间有几百毫秒 overlay 里一张卡都没有；而这条路径会被
   * session-meta-updated、Codex 历史重试、turn-complete backfill 被动触发。
   * 老写法在那一帧就把整个勾选集合清空了 —— 用户勾了 5 条正要点复制，勾勾自己
   * 全没了，还没有任何提示。所以 selected 只由「用户点击」和「退出多选」改动，
   * 卡片暂时不在 DOM 里只是不计数、不复制，回来了自动重新亮起。
   */
  function syncDom() {
    syncScheduled = false;
    const root = overlay();
    if (!root) return;
    if (active && modeSessionId && String(getActiveSessionId() || '') !== String(modeSessionId)) {
      // 会话换了，勾选的 turnId 属于上一个会话，留着只会误复制。
      exit();
      return;
    }
    if (root.classList) root.classList.toggle('multi-select-active', active);
    const cards = cardsInOrder();
    let presentSelected = 0;
    for (const card of cards) {
      const turnId = cardId(card);
      const checked = active && selected.has(turnId);
      if (checked) presentSelected += 1;
      if (card.classList) card.classList.toggle('multi-selected', checked);
      if (active) {
        // aria-checked 必须配一个能接受它的 role，否则读屏软件直接忽略。
        card.setAttribute('role', 'checkbox');
        card.setAttribute('aria-checked', checked ? 'true' : 'false');
      } else {
        card.removeAttribute('role');
        card.removeAttribute('aria-checked');
      }
    }
    updateBar(cards.length, presentSelected);
  }

  function scheduleSync() {
    if (syncScheduled) return;
    syncScheduled = true;
    const raf = win && typeof win.requestAnimationFrame === 'function'
      ? win.requestAnimationFrame.bind(win)
      : (fn) => setTimeout(fn, 16);
    raf(() => syncDom());
  }

  function startObserving() {
    const root = overlay();
    const ObserverCtor = (win && win.MutationObserver)
      || (typeof MutationObserver === 'function' ? MutationObserver : null);
    if (!root || !ObserverCtor || cardObserver) return;
    // 只在多选模式下观察，平时零开销。attributeFilter 盯 data-patch-count ——
    // patchTurnCardInPlace 每次原地重渲染都会 +1，正是勾选 class 被抹掉的那一刻。
    cardObserver = new ObserverCtor(() => scheduleSync());
    cardObserver.observe(root, { childList: true, subtree: true, attributeFilter: ['data-patch-count'] });
  }

  function stopObserving() {
    if (cardObserver) { cardObserver.disconnect(); cardObserver = null; }
  }

  function enter(turnId) {
    if (!visible) return false;
    active = true;
    modeSessionId = String(getActiveSessionId() || '') || null;
    selected.clear();
    const seed = String(turnId || '');
    if (seed) selected.add(seed);
    restoreCopyButton();
    startObserving();
    syncDom();
    return true;
  }

  function exit() {
    if (!active) {
      selected.clear();
      return false;
    }
    active = false;
    modeSessionId = null;
    selected.clear();
    stopObserving();
    if (resetTimer) { clearTimeout(resetTimer); resetTimer = null; }
    restoreCopyButton();
    const root = overlay();
    if (root && root.classList) root.classList.remove('multi-select-active');
    for (const card of cardsInOrder()) {
      if (card.classList) card.classList.remove('multi-selected');
      card.removeAttribute('role');
      card.removeAttribute('aria-checked');
    }
    updateBar(0, 0);
    return true;
  }

  function toggle(turnId) {
    if (!active) return false;
    const id = String(turnId || '');
    if (!id) return false;
    if (selected.has(id)) selected.delete(id);
    else selected.add(id);
    syncDom();
    return selected.has(id);
  }

  function selectAll() {
    if (!active) return 0;
    for (const card of cardsInOrder()) selected.add(cardId(card));
    selected.delete('');
    syncDom();
    return selected.size;
  }

  function clearSelection() {
    if (!active) return 0;
    selected.clear();
    syncDom();
    return 0;
  }

  async function copySelected() {
    const result = formatSelectedMessages(collectSelectedEntries());
    if (!result.text) {
      showFeedback('未选中内容', 'copy-empty');
      return result;
    }
    try {
      const outcome = await writeClipboardText(result.text);
      if (outcome && outcome.ok === false) throw new Error(outcome.reason || 'clipboard-write-failed');
      showFeedback(`已复制 ${result.copiedCount} 条`, 'copied');
      return result;
    } catch (error) {
      showFeedback('复制失败', 'copy-error');
      return { ...result, error: error && error.message ? error.message : String(error) };
    }
  }

  // 多选模式下，卡片区的点击一律被拦成「勾选 / 取消勾选」：链接、代码块复制按钮、
  // 卡片操作按钮全部让位，和微信一致。捕获阶段 stopPropagation 才能挡住
  // renderer.js 挂在 document 上的 .ta-btn 冒泡处理器。
  function onOverlayClickCapture(event) {
    if (!active) return;
    if (typeof event.preventDefault === 'function') event.preventDefault();
    if (typeof event.stopPropagation === 'function') event.stopPropagation();
    const target = event.target;
    const card = target && typeof target.closest === 'function' ? target.closest(cardSelector) : null;
    if (!card || !cardsInOrder().includes(card) || !cardId(card)) return;
    toggle(cardId(card));
  }

  // Esc 是全 app 最挤的一个键。这里挂的是 document 捕获阶段，抢在所有人前面，
  // 所以必须主动让路，否则多选态下第一下 Esc 会去关一个用户根本看不见的东西：
  //   - isComposing：中文输入法候选窗里的 Esc 是取消候选，不是退出多选
  //     （clipboard-controller.js 的 handleKeydown 第一行就是这个判断，沿用惯例）；
  //   - 已经被别人 preventDefault 过：说明更上层已经处理了这一下。
  // 不按「焦点在输入框」让路：卡片视图下焦点默认就落在浮动输入框里，那样等于
  // Esc 在最常见的情形下直接失灵（实测被 CDP 验收当场抓到）。多选是用户刚进入的
  // 模态状态，此时 Esc 归它管才符合直觉。
  function onKeyDown(event) {
    if (!active || !event || event.key !== 'Escape') return;
    if (event.isComposing || event.defaultPrevented) return;
    if (typeof event.preventDefault === 'function') event.preventDefault();
    if (typeof event.stopPropagation === 'function') event.stopPropagation();
    exit();
  }

  function onSelectAllClick() {
    if (selectAllBtn && selectAllBtn.dataset.mode === 'clear') clearSelection();
    else selectAll();
  }

  function onExitClick() {
    exit();
  }

  function init() {
    if (!doc) return false;
    bar = options.elements?.bar || doc.getElementById('card-multi-select-bar');
    countEl = options.elements?.count || doc.getElementById('card-multi-select-count');
    selectAllBtn = options.elements?.all || doc.getElementById('card-multi-select-all');
    copyBtn = options.elements?.copy || doc.getElementById('card-multi-select-copy');
    exitBtn = options.elements?.exit || doc.getElementById('card-multi-select-exit');
    if (!bar || !countEl || !selectAllBtn || !copyBtn || !exitBtn) return false;
    copyBtn.dataset.defaultLabel = copyBtn.textContent || '一键复制';
    selectAllBtn.addEventListener('click', onSelectAllClick);
    copyBtn.addEventListener('click', copySelected);
    exitBtn.addEventListener('click', onExitClick);
    const root = overlay();
    if (root) root.addEventListener('click', onOverlayClickCapture, true);
    doc.addEventListener('keydown', onKeyDown, true);
    updateBar(0, 0);
    return true;
  }

  // 只在卡片视图 + 有激活会话时可用；离开就退出多选，别留下一个悬空的勾选集合。
  function setVisible(next) {
    visible = !!next;
    if (!visible) exit();
  }

  function destroy() {
    stopObserving();
    if (resetTimer) clearTimeout(resetTimer);
    if (selectAllBtn) selectAllBtn.removeEventListener('click', onSelectAllClick);
    if (copyBtn) copyBtn.removeEventListener('click', copySelected);
    if (exitBtn) exitBtn.removeEventListener('click', onExitClick);
    const root = overlay();
    if (root) root.removeEventListener('click', onOverlayClickCapture, true);
    if (doc) doc.removeEventListener('keydown', onKeyDown, true);
  }

  return {
    clearSelection,
    collectSelectedEntries,
    copySelected,
    destroy,
    enter,
    exit,
    init,
    isActive: () => active,
    selectAll,
    selectedCount: () => selected.size,
    selectedTurnIds: () => Array.from(selected),
    setVisible,
    syncDom,
    toggle,
  };
}

module.exports = {
  createCardMultiSelectController,
  formatSelectedMessages,
};
