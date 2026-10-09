'use strict';

function normalizeQuestionSummary(value, maxLength = 72) {
  const limit = Math.max(12, Number(maxLength) || 72);
  const text = String(value || '')
    .replace(/```[\s\S]*?```/g, ' [代码] ')
    .replace(/[A-Za-z]:[\\/][^\r\n<>"`]*?\.(?:png|jpe?g|webp|gif)\b/gi, '[图片附件]')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/^\s{0,3}(?:#{1,6}|>|[-*+]\s)\s*/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return '（空问题）';
  return text.length > limit ? `${text.slice(0, limit - 1).trimEnd()}…` : text;
}

function activeQuestionIndexFromTops(tops, anchor, atBottom = false) {
  if (!Array.isArray(tops) || tops.length === 0) return -1;
  if (atBottom) return tops.length - 1;
  let active = 0;
  for (let index = 0; index < tops.length; index += 1) {
    if (Number(tops[index]) <= Number(anchor)) active = index;
    else break;
  }
  return active;
}

function answerTargetFromTops(tops, scrollTop, maxScroll, direction) {
  const targets = tops.map(top => Math.max(0, Math.min(maxScroll, top)));
  return direction === 'up'
    ? targets.findLastIndex(top => top < scrollTop - 2)
    : targets.findIndex(top => top > scrollTop + 2);
}

function createCardQuestionNavigator(options = {}) {
  const doc = options.document || document;
  const win = options.window || window;
  const overlay = options.overlay || doc.getElementById('msg-overlay');
  const root = options.root || doc.getElementById('card-question-nav');
  if (root) root.innerHTML = `<header class="question-directory-head"><strong>问题目录 <span class="question-directory-count"></span></strong><button type="button" class="question-directory-toggle" aria-label="折叠问题目录" title="折叠问题目录"></button></header><div class="card-question-nav-track"></div><footer class="question-directory-actions">${[['top','到顶部','M5 4h14M6 15l6-6 6 6M12 9v11'],['up','上一个回答','M6 14l6-6 6 6'],['down','下一个回答','M6 10l6 6 6-6'],['latest','回到最新','M5 20h14M6 9l6 6 6-6M12 4v11']].map(([action,label,d])=>`<button type="button" data-directory-action="${action}" title="${label}" aria-label="${label}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="${d}"/></svg></button>`).join('')}</footer><div class="card-question-nav-tooltip" role="tooltip" hidden><span class="card-question-nav-tooltip-index"></span><span class="card-question-nav-tooltip-summary"></span></div>`;
  const track = root && root.querySelector('.card-question-nav-track');
  const tooltip = root && root.querySelector('.card-question-nav-tooltip');
  const tooltipIndex = tooltip && tooltip.querySelector('.card-question-nav-tooltip-index');
  const tooltipSummary = tooltip && tooltip.querySelector('.card-question-nav-tooltip-summary');
  const getCurrentView = typeof options.getCurrentView === 'function' ? options.getCurrentView : () => 'card';
  const getActiveSessionId = typeof options.getActiveSessionId === 'function' ? options.getActiveSessionId : () => null;
  const getTurnById = typeof options.getTurnById === 'function' ? options.getTurnById : () => null;
  const raf = typeof options.requestAnimationFrame === 'function'
    ? options.requestAnimationFrame
    : (callback) => setTimeout(callback, 0);
  const cancelRaf = typeof options.cancelAnimationFrame === 'function'
    ? options.cancelAnimationFrame
    : clearTimeout;

  let entries = [];
  let activeIndex = -1;
  let refreshFrame = null;
  let scrollFrame = null;
  let observer = null;
  let highlightedCard = null;
  let highlightTimer = null;
  let disposed = false;
  let resizeObserver = null, narrow = false, narrowOverride = null, preferenceKey = '';
  let hovered = false, hoverSuppressed = false, reservedExpanded = null;
  let layoutWidth = null, navigationAnchor = null, anchorFrame = null;
  const layout = options.layoutElement || overlay?.parentElement;
  function rememberNavigation(card) {
    navigationAnchor = card ? {card, sessionId:getActiveSessionId(), epoch:overlay._cardFollowController?.capture().epoch} : null;
  }
  function clearNavigationAnchor() { navigationAnchor = null; }
  function restoreNavigationAfterLayout() {
    if (!navigationAnchor || anchorFrame !== null) return;
    anchorFrame = raf(() => {
      anchorFrame = null;
      const anchor = navigationAnchor, follow = overlay._cardFollowController;
      if (!anchor || !anchor.card.isConnected || anchor.sessionId !== getActiveSessionId()
          || follow?.isFollowing() || anchor.epoch !== follow?.capture().epoch) return;
      const top = overlay.scrollTop + anchor.card.getBoundingClientRect().top - overlay.getBoundingClientRect().top - 10;
      // Browser anchoring may select a descendant of the preceding response.
      // A deliberate answer/question jump keeps its own anchor across reflow,
      // until the reader scrolls or otherwise changes navigation intent.
      overlay.scrollTo({top:Math.max(0, top), behavior:'instant'});
      updateActive();
    });
  }
  function storedExpanded() {
    try { return win.localStorage.getItem(preferenceKey) === 'expanded'; }
    catch { return false; }
  }
  function updateLayout() {
    if (!root || !overlay || !layout) return;
    // The old key stored an open-by-default preference; start the pin mode cleanly.
    const key = 'hub.questionDirectoryPinned.v2.' + String(getActiveSessionId() || '');
    const nextNarrow = layout.clientWidth < 820;
    if (key !== preferenceKey || narrow !== nextNarrow) narrowOverride = null;
    preferenceKey = key; narrow = nextNarrow;
    const pinnedExpanded = narrow ? (narrowOverride ?? false) : storedExpanded();
    const collapsed = !(pinnedExpanded || hovered);
    const reflow = layoutWidth !== layout.clientWidth || reservedExpanded !== pinnedExpanded;
    layoutWidth = layout.clientWidth;
    reservedExpanded = pinnedExpanded;
    root.classList.toggle('directory-collapsed', collapsed);
    root.classList.toggle('directory-pinned', pinnedExpanded);
    root.classList.toggle('directory-hover-open', hovered && !pinnedExpanded);
    root.classList.toggle('directory-auto-collapsed', !pinnedExpanded && !hovered);
    overlay.style.setProperty('--question-directory-space', pinnedExpanded ? '252px' : '54px');
    if (options.layoutElement) layout.style.setProperty('--question-directory-space', pinnedExpanded ? '252px' : '54px');
    const toggle = root.querySelector('.question-directory-toggle');
    toggle.setAttribute('aria-expanded', String(!collapsed));
    toggle.setAttribute('aria-pressed', String(pinnedExpanded));
    toggle.setAttribute('aria-label', pinnedExpanded ? '取消固定问题目录' : '固定展开问题目录');
    toggle.title = pinnedExpanded ? '取消固定问题目录' : '固定展开问题目录';
    toggle.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M15 4v16m${collapsed ? '-6-11-3 3 3 3' : '-6-11 3 3-3 3'}"/></svg>`;
    if (reflow) { overlay._cardFollowController?.request(); restoreNavigationAfterLayout(); }
  }
  function toggleDirectory() {
    const pinnedExpanded = !root.classList.contains('directory-pinned');
    if (narrow) narrowOverride = pinnedExpanded;
    else { try { win.localStorage.setItem(preferenceKey, pinnedExpanded ? 'expanded' : 'collapsed'); } catch (e) { console.warn('[question-directory] preference could not be saved:', e.message); } }
    if (!pinnedExpanded) { hovered = false; hoverSuppressed = true; }
    hideTooltip(); updateLayout();
  }
  function onMouseEnter() {
    if (!hoverSuppressed && !root.classList.contains('directory-pinned')) { hovered = true; updateLayout(); }
  }
  function onMouseLeave() {
    hovered = false;
    hoverSuppressed = false;
    hideTooltip();
    updateLayout();
  }
  function navigate(action) {
    hideTooltip();
    clearNavigationAnchor();
    const follow = overlay._cardFollowController;
    if (action === 'latest') { if (follow) follow.follow(); else overlay.scrollTop = overlay.scrollHeight; }
    else {
      follow?.pause();
      if (action === 'top') overlay.scrollTo({top: 0, behavior:'auto'});
      else {
        const {cards, tops, index} = answerTarget(action);
        if (index < 0) return;
        rememberNavigation(cards[index]);
        overlay.scrollTo({top: tops[index], behavior:'auto'});
        flashCard(cards[index]);
      }
    }
    updateActive();
  }

  function answerTarget(direction) {
    const sessionId = String(getActiveSessionId() || '');
    const candidates = options.getAnswerCards ? options.getAnswerCards()
      : [...overlay.querySelectorAll(':scope > .turn-card.assistant')].filter(card =>
        !card.dataset.sessionId || card.dataset.sessionId === sessionId);
    const seen = new Set();
    const cards = candidates.filter(card => {
      if (!card.getClientRects().length || card.dataset.phase === 'activity') return false;
      // Progress and result items from one native response share one anchor.
      const key = card.dataset.responseId && JSON.stringify([card.dataset.sessionId,
        card.dataset.responseId, card.dataset.responseAgent, card.dataset.inherited]);
      if (key && seen.has(key)) return false;
      if (key) seen.add(key);
      return true;
    });
    const origin = overlay.getBoundingClientRect().top;
    const tops = cards.map(card => overlay.scrollTop + card.getBoundingClientRect().top - origin - 10);
    return {cards, tops, index: answerTargetFromTops(tops, overlay.scrollTop,
      Math.max(0, overlay.scrollHeight - overlay.clientHeight), direction)};
  }

  function prefersReducedMotion() {
    try { return !!win.matchMedia?.('(prefers-reduced-motion: reduce)').matches; }
    catch { return false; }
  }

  function hideTooltip() {
    if (tooltip) tooltip.hidden = true;
  }

  function showTooltip(entry, button) {
    if (!tooltip || !entry || !button || !root) return;
    if (tooltipIndex) tooltipIndex.textContent = `问题 ${entry.index + 1} / ${entries.length}`;
    if (tooltipSummary) tooltipSummary.textContent = entry.summary;
    const rootRect = root.getBoundingClientRect();
    const buttonRect = button.getBoundingClientRect();
    const desired = buttonRect.top - rootRect.top + buttonRect.height / 2;
    tooltip.hidden = false;
    const tooltipHeight = tooltip.getBoundingClientRect().height || 0;
    const half = tooltipHeight / 2;
    const minCenter = Math.max(10, half + 4);
    const maxCenter = Math.max(minCenter, rootRect.height - half - 4);
    tooltip.style.top = `${Math.max(minCenter, Math.min(maxCenter, desired))}px`;
  }

  function setVisible(visible) {
    if (!root || !overlay) return;
    root.hidden = !visible;
    overlay.classList.toggle('question-nav-visible', visible);
    if (!visible) { hovered = false; hoverSuppressed = false; hideTooltip(); }
    updateLayout();
  }

  function keepActiveButtonVisible(button) {
    if (!track || !button) return;
    const top = button.offsetTop;
    const bottom = top + button.offsetHeight;
    if (top < track.scrollTop) track.scrollTop = top;
    else if (bottom > track.scrollTop + track.clientHeight) {
      track.scrollTop = Math.max(0, bottom - track.clientHeight);
    }
  }

  function updateActive({ keepMarkerVisible = true } = {}) {
    if (!overlay || entries.length === 0 || root?.hidden) return -1;
    const overlayRect = overlay.getBoundingClientRect();
    const anchor = overlayRect.top + Math.min(180, overlayRect.height * 0.28);
    const atBottom = overlay.scrollHeight - overlay.scrollTop - overlay.clientHeight < 4;
    const next = activeQuestionIndexFromTops(
      entries.map(entry => entry.card.getBoundingClientRect().top),
      anchor,
      atBottom,
    );
    if (next < 0) return next;
    const changed = activeIndex !== next;
    activeIndex = next;
    entries.forEach((entry, index) => {
      const active = index === activeIndex;
      entry.button.classList.toggle('active', active);
      entry.button.tabIndex = active ? 0 : -1;
      if (active) entry.button.setAttribute('aria-current', 'true');
      else entry.button.removeAttribute('aria-current');
    });
    const counter = root.querySelector('.question-directory-count');
    if (counter) counter.textContent = `${activeIndex + 1}/${entries.length}`;
    for (const b of root.querySelectorAll('[data-directory-action]')) {
      const action = b.dataset.directoryAction;
      b.disabled = action === 'top' ? overlay.scrollTop < 2 : action === 'latest' ? atBottom : answerTarget(action).index < 0;
    }
    if (changed && keepMarkerVisible) keepActiveButtonVisible(entries[activeIndex]?.button);
    return activeIndex;
  }

  function flashCard(card) {
    if (!card) return;
    if (highlightTimer) clearTimeout(highlightTimer);
    if (highlightedCard && highlightedCard !== card) highlightedCard.classList.remove('question-jump-highlight');
    highlightedCard = card;
    card.classList.remove('question-jump-highlight');
    // Restart the short visual confirmation even when clicking the same marker.
    void card.offsetWidth;
    card.classList.add('question-jump-highlight');
    highlightTimer = setTimeout(() => {
      card.classList.remove('question-jump-highlight');
      if (highlightedCard === card) highlightedCard = null;
      highlightTimer = null;
    }, prefersReducedMotion() ? 120 : 700);
  }

  function scrollToQuestion(index, { focusMarker = false } = {}) {
    const entry = entries[index];
    if (!entry || !overlay) return false;
    overlay._cardFollowController?.pause();
    rememberNavigation(entry.card);
    const overlayRect = overlay.getBoundingClientRect();
    const cardRect = entry.card.getBoundingClientRect();
    const targetTop = Math.max(0, overlay.scrollTop + cardRect.top - overlayRect.top - 10);
    const behavior = prefersReducedMotion() ? 'auto' : 'smooth';
    try { overlay.scrollTo({ top: targetTop, behavior }); }
    catch { overlay.scrollTop = targetTop; }
    activeIndex = index;
    entries.forEach((item, itemIndex) => {
      const active = itemIndex === index;
      item.button.classList.toggle('active', active);
      item.button.tabIndex = active ? 0 : -1;
      if (active) item.button.setAttribute('aria-current', 'true');
      else item.button.removeAttribute('aria-current');
    });
    keepActiveButtonVisible(entry.button);
    flashCard(entry.card);
    if (focusMarker) entry.button.focus();
    return true;
  }

  function markerKeydown(event, index) {
    let target = null;
    if (event.key === 'ArrowUp') target = Math.max(0, index - 1);
    else if (event.key === 'ArrowDown') target = Math.min(entries.length - 1, index + 1);
    else if (event.key === 'Home') target = 0;
    else if (event.key === 'End') target = entries.length - 1;
    if (target === null || target === index) return;
    event.preventDefault();
    scrollToQuestion(target, { focusMarker: true });
  }

  function questionTextForCard(card) {
    const turnId = card.dataset.turnId || '';
    const turn = turnId ? getTurnById(turnId) : null;
    if (turn && typeof turn.text === 'string') return turn.assistantContext?.userText ?? turn.text;
    return card.querySelector('.turn-body')?.innerText || '';
  }

  function refresh() {
    if (disposed || !root || !track || !overlay) return { count: 0, activeIndex: -1, visible: false };
    refreshFrame = null;
    const sessionId = String(getActiveSessionId() || '');
    const cardViewVisible = getCurrentView() === 'card' && !!sessionId && !overlay.classList.contains('hidden');
    const customEntries = cardViewVisible && options.getEntries ? options.getEntries() : null;
    const cards = customEntries ? customEntries.map(entry => entry.card) : cardViewVisible
      ? Array.from(overlay.querySelectorAll(':scope > .turn-card.user')).filter(card => (
        !card.dataset.sessionId || card.dataset.sessionId === sessionId
      ))
      : [];

    track.replaceChildren();
    entries = [];
    activeIndex = -1;
    root.classList.toggle('dense', cards.length > 12);
    root.classList.toggle('very-dense', cards.length > 28);
    if (cards.length < 1) {
      setVisible(false);
      return { count: cards.length, activeIndex, visible: false };
    }

    const fragment = doc.createDocumentFragment();
    cards.forEach((card, index) => {
      const raw = customEntries?.[index]?.text ?? questionTextForCard(card);
      const summary = normalizeQuestionSummary(raw);
      const turn = getTurnById(card.dataset.turnId || '');
      const timestamp = customEntries?.[index]?.timestamp || turn?.ts || turn?.timestamp;
      const time = timestamp ? require('../core/beijing-time').formatBeijingClock(timestamp) : '';
      const meta = customEntries?.[index]?.meta || time || '用户提问';
      const button = doc.createElement('button');
      button.type = 'button';
      button.className = 'card-question-nav-item';
      button.tabIndex = -1;
      button.dataset.questionIndex = String(index);
      button.setAttribute('aria-label', `跳转到问题 ${index + 1}：${summary}`);
      button.title = `问题 ${index + 1}：${summary}`;
      const dot = doc.createElement('span');
      dot.className = 'card-question-nav-dot';
      dot.setAttribute('aria-hidden', 'true');
      const label = doc.createElement('span');
      label.className = 'card-question-nav-label';
      label.textContent = `Q${index + 1}`;
      const title = doc.createElement('span'); title.className = 'question-directory-title'; title.textContent = summary;
      const detail = doc.createElement('small'); detail.textContent = meta; title.appendChild(detail);
      button.append(dot, label, title);
      const entry = { index, card, button, summary };
      button.addEventListener('click', () => scrollToQuestion(index));
      button.addEventListener('keydown', event => markerKeydown(event, index));
      button.addEventListener('mouseenter', () => showTooltip(entry, button));
      button.addEventListener('mouseleave', hideTooltip);
      button.addEventListener('focus', () => showTooltip(entry, button));
      button.addEventListener('blur', hideTooltip);
      entries.push(entry);
      fragment.appendChild(button);
    });
    track.appendChild(fragment);
    setVisible(true);
    updateActive({ keepMarkerVisible: false });
    return { count: entries.length, activeIndex, visible: true };
  }

  function scheduleRefresh() {
    if (disposed || refreshFrame !== null) return;
    refreshFrame = raf(refresh);
  }

  function onScroll() {
    if (disposed || scrollFrame !== null) return;
    scrollFrame = raf(() => {
      scrollFrame = null;
      updateActive();
    });
  }

  function init() {
    if (!root || !track || !overlay) return false;
    overlay.addEventListener('scroll', onScroll, { passive: true });
    for (const type of ['wheel','touchstart','pointerdown','keydown']) overlay.addEventListener(type, clearNavigationAnchor, {passive:true});
    if (typeof win.MutationObserver === 'function') {
      observer = new win.MutationObserver(records => {
        if (records.some(r=>r.target === overlay || r.target.closest?.('.mr-gc-msg') || r.addedNodes.length || r.removedNodes.length)) scheduleRefresh();
      });
      observer.observe(overlay, { childList: true, subtree: !!options.getEntries });
    }
    root.querySelector('.question-directory-toggle').addEventListener('click', toggleDirectory);
    root.addEventListener('mouseenter', onMouseEnter);
    root.addEventListener('mouseleave', onMouseLeave);
    root.querySelectorAll('[data-directory-action]').forEach(b => b.addEventListener('click', () => navigate(b.dataset.directoryAction)));
    if (typeof win.ResizeObserver === 'function' && layout) { resizeObserver = new win.ResizeObserver(updateLayout); resizeObserver.observe(layout); }
    scheduleRefresh();
    return true;
  }

  function dispose() {
    disposed = true;
    if (refreshFrame !== null) cancelRaf(refreshFrame);
    if (scrollFrame !== null) cancelRaf(scrollFrame);
    if (anchorFrame !== null) cancelRaf(anchorFrame);
    if (highlightTimer) clearTimeout(highlightTimer);
    observer?.disconnect(); resizeObserver?.disconnect();
    root?.removeEventListener('mouseenter', onMouseEnter);
    root?.removeEventListener('mouseleave', onMouseLeave);
    overlay?.removeEventListener('scroll', onScroll);
    for (const type of ['wheel','touchstart','pointerdown','keydown']) overlay?.removeEventListener(type, clearNavigationAnchor);
    if (highlightedCard) highlightedCard.classList.remove('question-jump-highlight');
    entries = [];
    setVisible(false);
  }

  return {
    dispose,
    init,
    refresh,
    scheduleRefresh,
    scrollToQuestion,
    updateActive,
    updateLayout,
    getState: () => ({
      count: entries.length,
      activeIndex,
      visible: !!root && !root.hidden,
      collapsed: root?.classList.contains('directory-collapsed'),
      autoCollapsed: root?.classList.contains('directory-auto-collapsed'),
      summaries: entries.map(entry => entry.summary),
    }),
  };
}

module.exports = {
  answerTargetFromTops,
  activeQuestionIndexFromTops,
  createCardQuestionNavigator,
  normalizeQuestionSummary,
};
