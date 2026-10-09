'use strict';

const LEGACY_MODAL_IDS = Object.freeze([
  'search-modal',
  'config-modal',
  'resume-modal',
  'new-session-menu',
  'hub-cmdk-overlay',
  'meeting-create-modal',
  'workflow-config-modal',
  'loop-config-modal',
  'workspace-archive-modal',
  'preview-quick-open',
]);

const MODAL_SELECTOR = [
  '[aria-modal="true"]',
  '.modal-overlay',
  '.config-modal-overlay',
  '.new-session-menu',
  '.hub-cmdk-overlay',
  '[class*="modal-overlay"]',
].join(',');

function isElementOpen(element) {
  if (!element || element.isConnected === false) return false;
  let current = element;
  while (current) {
    if (current.hidden === true) return false;
    if (current.classList && current.classList.contains('hidden')) return false;
    if (current.style && current.style.display === 'none') return false;
    current = current.parentElement || null;
  }
  return true;
}

function isInsideExceptedRoot(element, exceptIds) {
  let current = element;
  while (current) {
    if (exceptIds.has(String(current.id || ''))) return true;
    current = current.parentElement || null;
  }
  return false;
}

function visibleBlockingModals(documentRef, options = {}) {
  if (!documentRef) return [];
  const exceptIds = new Set((options.exceptIds || []).map(String));
  const found = new Set();
  if (typeof documentRef.querySelectorAll === 'function') {
    for (const element of documentRef.querySelectorAll(MODAL_SELECTOR)) found.add(element);
  }
  if (typeof documentRef.getElementById === 'function') {
    for (const id of LEGACY_MODAL_IDS) {
      const element = documentRef.getElementById(id);
      if (element) found.add(element);
    }
  }
  return [...found].filter(element => !isInsideExceptedRoot(element, exceptIds) && isElementOpen(element));
}

function isBlockingModalOpen(documentRef, options = {}) {
  return visibleBlockingModals(documentRef, options).length > 0;
}

module.exports = {
  LEGACY_MODAL_IDS,
  MODAL_SELECTOR,
  isBlockingModalOpen,
  isElementOpen,
  isInsideExceptedRoot,
  visibleBlockingModals,
};
