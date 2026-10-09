'use strict';

// Following is user intent, not a measurement recomputed after a card grows.
// Only this controller writes automatic scroll positions for ordinary cards.
function createCardFollowScroll({ element, window: win, document: doc, button: suppliedButton = null }) {
  let sessionId = null, following = true, epoch = 0, frame = 0, pendingTop = null;
  let userDirection = 0, dragging = false, touchY = null;
  const saved = new Map(), observed = new Set();
  element.tabIndex = 0;
  element.setAttribute('aria-label', '会话消息');
  const button = suppliedButton || doc.createElement('button');
  if (!suppliedButton) button.id = 'card-jump-latest'; button.type = 'button'; button.hidden = true;
  button.textContent = '↓ 回到最新'; button.setAttribute('aria-label', '回到最新输出并继续跟随');
  const gap = () => Math.max(0, element.scrollHeight - element.clientHeight - element.scrollTop);
  const visible = () => element.isConnected && element.clientHeight > 0;
  function paint() {
    if (!suppliedButton && element.parentNode && button.parentNode !== element.parentNode) element.parentNode.appendChild(button);
    button.hidden = !visible() || following || gap() <= 3;
    if (suppliedButton) button.classList.toggle('visible', !button.hidden);
    // Browser anchoring helps preserve a reader's visible paragraph. While
    // following, the explicit bottom pin owns positioning instead.
    element.style.overflowAnchor = following ? 'none' : 'auto';
  }
  function request() {
    if (frame) return;
    frame = win.requestAnimationFrame(() => {
      frame = 0;
      if (following && visible()) element.scrollTop = element.scrollHeight;
      paint();
    });
  }
  function pause() { following = false; pendingTop = null; epoch++; paint(); }
  function follow() {
    following = true; pendingTop = null; userDirection = 0; epoch++;
    if (visible()) element.scrollTop = element.scrollHeight;
    request();
  }
  function nestedScroll(target, delta) {
    for (let el = target?.nodeType === 1 ? target : target?.parentElement; el && el !== element; el = el.parentElement) {
      if (el.scrollHeight > el.clientHeight + 1 && /auto|scroll/.test(win.getComputedStyle(el).overflowY)
          && (delta < 0 ? el.scrollTop > 0 : el.scrollTop + el.clientHeight < el.scrollHeight - 1)) return true;
    }
    return false;
  }
  function wheel(event) {
    if (event.ctrlKey || event.metaKey || !event.deltaY || nestedScroll(event.target, event.deltaY)) return;
    userDirection = Math.sign(event.deltaY);
    epoch++;
    if (userDirection < 0) pause();
    else if (gap() <= 3) follow();
  }
  function scroll() {
    if (!following && (userDirection || dragging)) epoch++;
    if (!following && (userDirection > 0 || dragging) && gap() <= 3) follow();
    paint();
  }
  function pointerDown(event) {
    const rect = element.getBoundingClientRect();
    if (event.clientX >= rect.right - Math.max(14, element.offsetWidth - element.clientWidth)) {
      dragging = true; userDirection = 0; pause();
    }
  }
  function pointerUp() { if (dragging && gap() <= 3) follow(); dragging = false; }
  function key(event) {
    if (event.target.closest?.('input,textarea,[contenteditable="true"]')) return;
    if (['ArrowUp','PageUp','Home'].includes(event.key) || (event.key === ' ' && event.shiftKey)) { userDirection = -1; pause(); }
    else if (['ArrowDown','PageDown','End',' '].includes(event.key)) userDirection = 1;
  }
  function disclosure(event) {
    if (event.target.closest?.('summary, .body-expand-btn, [data-action="toggle-body"]')) pause();
  }
  function touchStart(event) { touchY = event.touches[0]?.clientY ?? null; }
  function touchMove(event) {
    const next = event.touches[0]?.clientY;
    if (next == null || touchY == null) return;
    const delta = touchY - next; touchY = next;
    if (nestedScroll(event.target, delta)) return;
    userDirection = Math.sign(delta); if (delta < 0) pause();
  }
  function selection() {
    const selected = win.getSelection();
    if (selected && !selected.isCollapsed && element.contains(selected.anchorNode) && element.contains(selected.focusNode)) pause();
  }
  const resize = new win.ResizeObserver(request);
  resize.observe(element);
  function observeChildren() {
    for (const el of observed) if (el.parentNode !== element) { resize.unobserve(el); observed.delete(el); }
    for (const el of element.children) if (!observed.has(el)) { observed.add(el); resize.observe(el); }
    request();
  }
  const mutations = new win.MutationObserver(observeChildren);
  mutations.observe(element, { childList: true, subtree: true, characterData: true });
  element.addEventListener('wheel', wheel, { passive: true });
  element.addEventListener('scroll', scroll, { passive: true });
  element.addEventListener('pointerdown', pointerDown, { passive: true });
  element.addEventListener('keydown', key);
  element.addEventListener('click', disclosure, true);
  element.addEventListener('touchstart', touchStart, { passive: true });
  element.addEventListener('touchmove', touchMove, { passive: true });
  doc.addEventListener('pointerup', pointerUp);
  doc.addEventListener('selectionchange', selection);
  button.addEventListener('click', follow);
  const api = {
    request, pause, follow, isFollowing: () => following,
    activate(id, { force = false } = {}) {
      if (id !== sessionId) {
        if (sessionId) saved.set(sessionId, { following, top: element.scrollTop });
        const state = saved.get(id);
        sessionId = id; following = state?.following ?? true; pendingTop = state?.top ?? 0;
        userDirection = 0; epoch++;
      }
      if (force) follow();
      paint();
    },
    capture: () => {
      const rect = element.getBoundingClientRect();
      const anchor = following || pendingTop !== null ? null : [...element.children].find(el => el.dataset.turnId && el.getBoundingClientRect().bottom > rect.top);
      return { sessionId, epoch, following, top: pendingTop ?? element.scrollTop,
        anchorId: anchor?.dataset.turnId, anchorOffset: anchor ? anchor.getBoundingClientRect().top - rect.top : 0 };
    },
    restore(snapshot) {
      if (!snapshot || snapshot.sessionId !== sessionId || snapshot.epoch !== epoch) return;
      if (following) { if (visible()) element.scrollTop = element.scrollHeight; request(); }
      else {
        const anchor = snapshot.anchorId && [...element.children].find(el => el.dataset.turnId === snapshot.anchorId);
        element.scrollTop = anchor ? element.scrollTop + anchor.getBoundingClientRect().top - element.getBoundingClientRect().top - snapshot.anchorOffset : snapshot.top;
      }
      pendingTop = null;
      paint();
    },
    dispose() {
      if (frame) win.cancelAnimationFrame(frame);
      resize.disconnect(); mutations.disconnect(); button.remove();
      element.removeEventListener('wheel', wheel); element.removeEventListener('scroll', scroll);
      element.removeEventListener('pointerdown', pointerDown); element.removeEventListener('keydown', key);
      element.removeEventListener('click', disclosure, true);
      element.removeEventListener('touchstart', touchStart); element.removeEventListener('touchmove', touchMove);
      doc.removeEventListener('pointerup', pointerUp); doc.removeEventListener('selectionchange', selection);
      delete element._cardFollowController;
    },
  };
  element._cardFollowController = api; observeChildren();
  return api;
}
module.exports = { createCardFollowScroll };
