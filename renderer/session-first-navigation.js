'use strict';

function installSessionFirstNavigation(doc = globalThis.document) {
  const app = doc?.getElementById('app-container');
  const trigger = doc?.getElementById('rail-edge-trigger');
  const pin = doc?.getElementById('rail-pin');
  const toggle = doc?.getElementById('btn-toggle-navigation');
  const rail = doc?.getElementById('scene-rail');
  if (!app || !trigger || !pin || !rail || app.dataset.navigationInstalled) return;
  app.dataset.navigationInstalled = 'true';
  require('./navigation-artwork').installNavigationArtwork(doc);
  const win = doc.defaultView;
  let storage;
  try { storage = win.localStorage; } catch {}
  const key = 'hub.navigationExpanded';
  let pinned = true, preview = false, inside = false, suppressed = false, returningFocus = false, closeTimer = null;
  try { pinned = storage?.getItem(key) !== 'false'; } catch {}
  const clearClose = () => { win.clearTimeout(closeTimer); closeTimer = null; };
  const render = () => {
    const open = pinned || preview;
    const wasOpen = !app.classList.contains('rail-hidden');
    app.classList.toggle('rail-pinned', pinned);
    app.classList.toggle('rail-preview', !pinned && preview);
    app.classList.toggle('rail-hidden', !open);
    rail.setAttribute('aria-hidden', String(!open));
    rail.inert = !open;
    pin.setAttribute('aria-pressed', String(pinned));
    pin.setAttribute('aria-label', pinned ? '取消固定并收起导航' : '固定功能导航');
    pin.title = pinned ? '取消固定并收起导航' : '固定功能导航';
    toggle?.setAttribute('aria-expanded', String(open));
    toggle?.setAttribute('aria-label', open ? '隐藏功能导航' : '显示并固定功能导航');
    if (toggle) toggle.title = open ? '隐藏功能导航' : '显示并固定功能导航';
    trigger.setAttribute('aria-expanded', String(open));
    if (wasOpen !== open) doc.dispatchEvent(new win.Event('hub:navigation-layout'));
  };
  const setPinned = value => {
    clearClose(); pinned = value; preview = false; suppressed = !value && inside;
    try { storage?.setItem(key, String(value)); } catch {}
    render();
  };
  const showPreview = () => {
    clearClose();
    if (!pinned && !suppressed) { preview = true; render(); }
  };
  const scheduleClose = () => {
    clearClose();
    if (pinned || !preview) return;
    closeTimer = win.setTimeout(() => {
      closeTimer = null;
      const keyboardFocus = rail.contains(doc.activeElement) && doc.activeElement.matches(':focus-visible');
      const popoverOpen = [...rail.querySelectorAll('#theme-menu,#options-menu')]
        .some(el => win.getComputedStyle(el).display !== 'none');
      if (inside || keyboardFocus || popoverOpen || rail.classList.contains('rail-editing')) return;
      preview = false; render();
    }, 180);
  };
  render();
  trigger.addEventListener('pointerenter', () => { inside = true; showPreview(); });
  trigger.addEventListener('pointerleave', () => { inside = false; scheduleClose(); });
  trigger.addEventListener('focus', () => {
    if (returningFocus) return;
    suppressed = false; showPreview();
    if (trigger.matches(':focus-visible')) pin.focus({ preventScroll:true });
  });
  trigger.addEventListener('click', () => setPinned(true));
  rail.addEventListener('pointerenter', () => { inside = true; clearClose(); });
  rail.addEventListener('pointerleave', () => { inside = false; scheduleClose(); });
  rail.addEventListener('focusout', scheduleClose);
  trigger.addEventListener('blur', scheduleClose);
  pin.addEventListener('click', () => setPinned(!pinned));
  toggle?.addEventListener('click', () => setPinned(!(pinned || preview)));
  doc.addEventListener('pointermove', event => {
    if (suppressed && !rail.contains(event.target) && !trigger.contains(event.target)) suppressed = false;
  });
  doc.addEventListener('keydown', event => {
    if (event.key === 'Escape' && preview && !rail.classList.contains('rail-editing')) {
      const popover = rail.querySelector('#theme-menu[style*="block"],#options-menu[style*="block"]');
      if (popover) return;
      event.preventDefault(); preview = false; suppressed = true; clearClose(); render();
      returningFocus = true;
      try { trigger.focus({ preventScroll:true }); } finally { returningFocus = false; }
    }
  });
  // Finishing a drag or closing a menu may be the last event while the pointer is outside.
  new win.MutationObserver(scheduleClose).observe(rail, { subtree:true, attributes:true, attributeFilter:['class','style'] });
  require('./navigation-order').installNavigationOrder(doc);
}

module.exports = { installSessionFirstNavigation };
