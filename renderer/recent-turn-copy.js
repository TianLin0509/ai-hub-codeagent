'use strict';

// 轮数上限原来写死成 {1,2,3}，超出一律回落 1 —— 想复制整段对话只能点三次再手动拼。
// 现在上限跟着"当前卡片里能凑出的完整轮数"走，这里的常量只是防呆天花板
// （卡片视图本身也只从 transcript 尾部拉 50 条 turn，见 transcript-handlers 的 limit:50，
//  所以实际可选上限 = 已挂载卡片的轮数，不是会话史上的总轮数）。
const MAX_COPY_ROUND_COUNT = 200;

function normalizeRoundCount(value, max = MAX_COPY_ROUND_COUNT) {
  const count = Number.parseInt(value, 10);
  const ceiling = Math.max(1, Number.isFinite(Number(max)) ? Math.floor(Number(max)) : MAX_COPY_ROUND_COUNT);
  if (!Number.isFinite(count) || count < 1) return 1;
  return Math.min(count, ceiling);
}

function normalizeCopiedText(value) {
  return String(value || '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function assistantSender(entry = {}) {
  const kindLabels = {
    claude: 'Claude',
    codex: 'Codex',
    deepseek: 'DeepSeek',
    gemini: 'Gemini',
    kimi: 'Kimi',
  };
  const baseKind = String(entry.kind || '')
    .toLowerCase()
    .replace(/-resume$/, '')
    .replace(/-api$/, '');
  const kind = kindLabels[baseKind] || '';
  const model = String(entry.model || '').trim();
  const details = [];
  if (kind) details.push(kind);
  if (model && !details.some(item => item.toLowerCase() === model.toLowerCase())) details.push(model);
  return details.length ? `AI（${details.join(' · ')}）` : 'AI';
}

// One round is one user question plus every assistant card that follows it up
// to the next user question. Incomplete trailing questions are intentionally
// omitted: "copy 1 round" must always contain both sender sides.
function collectCompleteConversationRounds(entries) {
  const rounds = [];
  let current = null;

  for (const raw of Array.isArray(entries) ? entries : []) {
    if (!raw || (raw.role !== 'user' && raw.role !== 'assistant')) continue;
    const entry = { ...raw, text: normalizeCopiedText(raw.text) };
    if (!entry.text) continue;

    if (entry.role === 'user') {
      if (current && current.user && current.assistants.length) rounds.push(current);
      current = { user: entry, assistants: [] };
      continue;
    }

    if (!current || !current.user) continue;
    const sender = assistantSender(entry);
    const previous = current.assistants[current.assistants.length - 1];
    if (previous && previous.text === entry.text && assistantSender(previous) === sender) continue;
    current.assistants.push(entry);
  }

  if (current && current.user && current.assistants.length) rounds.push(current);
  return rounds;
}

function formatRecentConversation(entries, requestedCount) {
  const rounds = collectCompleteConversationRounds(entries);
  // 请求超过实际轮数时按实际轮数处理，而不是回落到 1 —— "复制全部"应该真的给全部。
  const count = normalizeRoundCount(requestedCount, Math.max(1, rounds.length));
  const selected = rounds.slice(-count);
  const text = selected.map((round, index) => {
    const blocks = [
      `===== 第 ${index + 1} 轮 =====`,
      '我：',
      round.user.text,
    ];
    for (const reply of round.assistants) {
      blocks.push('', `${assistantSender(reply)}：`, reply.text);
    }
    return blocks.join('\n');
  }).join('\n\n');

  return {
    text,
    copiedRounds: selected.length,
    availableRounds: rounds.length,
    requestedRounds: count,
  };
}

function createRecentTurnCopyController(options = {}) {
  const doc = options.document || (typeof document !== 'undefined' ? document : null);
  const win = options.window || (typeof window !== 'undefined' ? window : null);
  const nav = options.navigator || (win && win.navigator) || {};
  const storage = options.storage || (win && win.localStorage) || null;
  const getActiveSessionId = typeof options.getActiveSessionId === 'function'
    ? options.getActiveSessionId
    : () => null;
  const getTurnById = typeof options.getTurnById === 'function'
    ? options.getTurnById
    : (turnId) => win && win._sessionTurns && win._sessionTurns.get(turnId);
  const extractVisibleCardText = typeof options.extractVisibleCardText === 'function'
    ? options.extractVisibleCardText
    : (root) => String((root && (root.innerText || root.textContent)) || '').trim();
  const storageKey = options.storageKey || 'hub-card-copy-round-count';
  // 单一剪贴板写入方。renderer 注入 clipboardController.copyText（Electron 原生 +
  //   写后读回校验）；未注入时退回 navigator.clipboard，仅为让本模块可独立使用。
  const writeClipboardText = typeof options.copyText === 'function'
    ? (text) => options.copyText(text, { source: 'recent-turn-copy', silent: true })
    : async (text) => {
      if (!nav.clipboard || typeof nav.clipboard.writeText !== 'function') {
        throw new Error('clipboard unavailable');
      }
      await Promise.resolve(nav.clipboard.writeText(text));
      return { ok: true, source: 'navigator-fallback' };
    };

  let root = null;
  let countSelect = null;
  let copyButton = null;
  let resetTimer = null;
  let renderedMax = 0;
  let cardObserver = null;
  // 用户"想要几轮"必须独立于下拉框当前的值。卡片是异步挂载的，工具条初始化时
  // 往往一轮都还没有，此时若直接把选中值夹到 1 并写回，用户存的偏好（比如 8 轮）
  // 就被永久抹掉了 —— 等卡片到齐再点复制，只会复制 1 轮且毫无提示。
  let desiredCount = 1;
  const countTextCache = new WeakMap();

  function collectVisibleEntries({ countOnly = false } = {}) {
    const overlay = doc && doc.getElementById('msg-overlay');
    const activeSessionId = String(getActiveSessionId() || '');
    if (!overlay || !activeSessionId) return [];

    return Array.from(overlay.querySelectorAll(':scope > .turn-card[data-turn-id]'))
      .map(card => {
        const cardSessionId = String((card.dataset && card.dataset.sessionId) || '');
        if (cardSessionId && cardSessionId !== activeSessionId) return null;
        const turn = getTurnById(card.dataset.turnId);
        if (!turn || (turn.role !== 'user' && turn.role !== 'assistant')) return null;
        const body = card.querySelector('.turn-body');
        // Counting rounds must not clone/layout every unchanged answer on
        // every navigation or card mutation. Actual copy always reads afresh.
        const html = countOnly && body && typeof body.innerHTML === 'string' ? body.innerHTML : null;
        const cached = html !== null ? countTextCache.get(body) : null;
        const text = cached?.html === html && cached ? cached.text : extractVisibleCardText(body);
        if (html !== null && cached?.html !== html) countTextCache.set(body, {html, text});
        return {
          role: turn.role,
          text,
          kind: turn.kind,
          model: turn.model,
        };
      })
      .filter(Boolean);
  }

  function availableRoundCount() {
    return collectCompleteConversationRounds(collectVisibleEntries({ countOnly: true })).length;
  }

  function selectedCount() {
    return normalizeRoundCount(countSelect && countSelect.value, Math.max(1, renderedMax || MAX_COPY_ROUND_COUNT));
  }

  /**
   * 按当前卡片里真实存在的轮数重建下拉项。
   *
   * 时机上不跟卡片渲染管线耦合：setVisible(true) 时刷一次，用户点开下拉之前
   * （focus / mousedown）再刷一次。卡片是异步挂载的，只挂 setVisible 会让刚开
   * 会话时上限停在 0/1；而 focus 那一刻的数字必然是最新的。
   */
  function refreshRoundOptions() {
    if (!countSelect) return 0;
    const total = availableRoundCount();
    const max = Math.max(1, Math.min(total, MAX_COPY_ROUND_COUNT));

    if (renderedMax !== max) {
      const options = [];
      for (let n = 1; n <= max; n += 1) {
        // 最后一项标出"全部"，省得用户为了确认有没有漏而去数。
        options.push(`<option value="${n}">${n} 轮${n === max && max > 1 ? ' · 全部' : ''}</option>`);
      }
      countSelect.innerHTML = options.join('');
      renderedMax = max;
    }
    // 显示值 = min(想要的, 现在最多能给的)。desiredCount 本身不动，
    // 所以对话变长之后会自动回到用户原本要的轮数。
    countSelect.value = String(Math.min(desiredCount, max));

    if (countSelect) countSelect.disabled = total === 0;
    return total;
  }

  function refreshAccessibleLabel() {
    if (!copyButton) return;
    const total = renderedMax;
    copyButton.title = `按“我 / AI”角色复制最近 ${selectedCount()} 个完整问答轮次（纯文本）`
      + (total ? `；当前最多可复制 ${total} 轮` : '');
  }

  function restoreButton() {
    if (!copyButton) return;
    copyButton.textContent = copyButton.dataset.defaultLabel || '复制对话';
    copyButton.classList.remove('copied', 'copy-empty', 'copy-error');
  }

  function showFeedback(label, className) {
    if (!copyButton) return;
    if (resetTimer) clearTimeout(resetTimer);
    copyButton.textContent = label;
    copyButton.classList.remove('copied', 'copy-empty', 'copy-error');
    if (className) copyButton.classList.add(className);
    resetTimer = setTimeout(restoreButton, 1800);
  }

  async function copyRecent() {
    // 点按钮的一刻再刷一次上限：这中间可能又来了新回合。
    // 但用户如果刚刚手动改过下拉框（还没触发 change / 或程序化赋值），
    // 以下拉框当前值为准，别被刷新覆盖回 desiredCount。
    const shown = normalizeRoundCount(countSelect && countSelect.value, MAX_COPY_ROUND_COUNT);
    if (shown !== Math.min(desiredCount, Math.max(1, renderedMax))) desiredCount = shown;
    refreshRoundOptions();
    const result = formatRecentConversation(collectVisibleEntries(), selectedCount());
    if (!result.text) {
      showFeedback('暂无完整轮次', 'copy-empty');
      return result;
    }
    try {
      // 2026-09-04：这里以前直接调 navigator.clipboard.writeText，而 Ctrl+C 走的是
      //   Electron 原生 clipboard.writeText —— 全 app 出现了两个剪贴板写入方。
      //   navigator.clipboard 是渲染进程（Chromium）自己的异步剪贴板，写完之后
      //   Chromium 仍认为自己持有剪贴板；随后主进程侧的原生写入不会让它作废，
      //   于是「点完复制对话 → 再 Ctrl+C 复制一小段 → Ctrl+V 粘出来还是那段对话」：
      //   浮层报的是原生剪贴板（确实已更新），而浮动输入框的原生粘贴拿的是 Chromium 旧缓存。
      //   修法是收敛成单一写入方：走注入的 copyText（renderer 传 clipboardController
      //   的实现，带写后读回校验 + 有界重试）。
      const outcome = await writeClipboardText(result.text);
      if (outcome && outcome.ok === false) {
        throw new Error(outcome.reason || 'clipboard-write-failed');
      }
      showFeedback(`已复制 ${result.copiedRounds} 轮`, 'copied');
      return result;
    } catch (error) {
      showFeedback('复制失败', 'copy-error');
      return { ...result, error: error && error.message ? error.message : String(error) };
    }
  }

  function onCountChanged() {
    const count = selectedCount();
    desiredCount = count;
    if (countSelect) countSelect.value = String(count);
    try { if (storage) storage.setItem(storageKey, String(count)); } catch {}
    refreshAccessibleLabel();
  }

  function onSelectOpened() {
    refreshRoundOptions();
    refreshAccessibleLabel();
  }

  function init() {
    if (!doc) return false;
    root = doc.getElementById('recent-turn-copy');
    countSelect = doc.getElementById('recent-turn-copy-count');
    copyButton = doc.getElementById('recent-turn-copy-button');
    if (!root || !countSelect || !copyButton) return false;
    copyButton.dataset.defaultLabel = copyButton.textContent || '复制对话';
    // 记住的偏好只写进 desiredCount，不直接写下拉框 —— 此刻卡片多半还没挂载，
    // 写进去会被立刻夹到 1 并覆盖掉。
    try { desiredCount = normalizeRoundCount(storage && storage.getItem(storageKey), MAX_COPY_ROUND_COUNT); } catch {}
    countSelect.addEventListener('change', onCountChanged);
    countSelect.addEventListener('focus', onSelectOpened);
    countSelect.addEventListener('mousedown', onSelectOpened);
    copyButton.addEventListener('click', copyRecent);
    // 卡片是异步、分批挂载的。盯着 #msg-overlay 的子节点变化重建选项，
    // 比在渲染管线里到处插调用点可靠，也不会和卡片渲染耦合。
    const overlay = doc.getElementById('msg-overlay');
    const ObserverCtor = (win && win.MutationObserver) || (typeof MutationObserver === 'function' ? MutationObserver : null);
    if (overlay && ObserverCtor) {
      cardObserver = new ObserverCtor(() => {
        if (root && root.hidden) return;
        refreshRoundOptions();
        refreshAccessibleLabel();
      });
      cardObserver.observe(overlay, { childList: true });
    }
    refreshRoundOptions();
    refreshAccessibleLabel();
    return true;
  }

  function setVisible(visible) {
    if (root) root.hidden = !visible;
    if (visible) {
      refreshRoundOptions();
      refreshAccessibleLabel();
    }
  }

  function destroy() {
    if (resetTimer) clearTimeout(resetTimer);
    if (cardObserver) { cardObserver.disconnect(); cardObserver = null; }
    if (countSelect) {
      countSelect.removeEventListener('change', onCountChanged);
      countSelect.removeEventListener('focus', onSelectOpened);
      countSelect.removeEventListener('mousedown', onSelectOpened);
    }
    if (copyButton) copyButton.removeEventListener('click', copyRecent);
  }

  return {
    availableRoundCount,
    collectVisibleEntries,
    copyRecent,
    destroy,
    init,
    refreshRoundOptions,
    setVisible,
  };
}

module.exports = {
  MAX_COPY_ROUND_COUNT,
  assistantSender,
  collectCompleteConversationRounds,
  createRecentTurnCopyController,
  formatRecentConversation,
  normalizeCopiedText,
  normalizeRoundCount,
};
