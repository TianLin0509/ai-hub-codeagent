'use strict';

const { readSelectedText } = require('./clipboard-controller.js');

function createCardSelectionContextMenuController({
  document,
  window,
  menuEl,
  clipboard,
  copyText,
  expandText = text => text,
  pushToChatgpt,
  requestAnimationFrameFn = requestAnimationFrame,
}) {
  let selectedText = '';

  function nodeElement(node) {
    if (!node) return null;
    return node.nodeType === 1 ? node : node.parentElement;
  }

  function readCardSelection() {
    const selection = window.getSelection && window.getSelection();
    const overlay = document.getElementById('msg-overlay');
    if (!selection || !overlay || selection.rangeCount < 1 || selection.isCollapsed) return '';
    const anchor = nodeElement(selection.anchorNode);
    const focus = nodeElement(selection.focusNode);
    if (!anchor || !focus || !overlay.contains(anchor) || !overlay.contains(focus)) return '';
    const value = String(selection.toString() || '');
    return value.trim() ? value : '';
  }

  function open(text, x, y) {
    if (!text || !String(text).trim()) return false;
    selectedText = String(text);
    menuEl.style.display = 'block';
    menuEl.style.left = `${x}px`;
    menuEl.style.top = `${y}px`;
    requestAnimationFrameFn(() => {
      const rect = menuEl.getBoundingClientRect();
      if (rect.right > window.innerWidth) menuEl.style.left = `${x - rect.width}px`;
      if (rect.bottom > window.innerHeight) menuEl.style.top = `${y - rect.height}px`;
    });
    return true;
  }

  function close() {
    menuEl.style.display = 'none';
    selectedText = '';
  }

  async function runAction(action, text = selectedText) {
    const value = expandText(String(text || ''));
    if (!value.trim()) return { ok: false, error: '没有选中文字。' };
    if (action === 'copy') {
      if (typeof copyText === 'function') {
        const result = await copyText(value, { source: 'card-context-menu' });
        return { ...result, copied: result?.ok === true };
      }
      await Promise.resolve(clipboard.writeText(value));
      const ok = typeof clipboard.readText === 'function' && clipboard.readText() === value;
      return { ok, copied: ok };
    }
    if (action === 'sync-chatgpt' && typeof pushToChatgpt === 'function') {
      return pushToChatgpt(value, '卡片选中文字');
    }
    return { ok: false, error: '未知操作。' };
  }

  function init() {
    document.addEventListener('contextmenu', (event) => {
      if (!event.target?.closest || event.target.closest('.xterm')) return;
      if (!event.target.closest('.turn-card, #preview-body, input, textarea, [contenteditable="true"]')) return;
      const value = readSelectedText(event.target, window);
      if (!value || !open(value, event.clientX, event.clientY)) return;
      event.preventDefault();
      if (typeof event.stopImmediatePropagation === 'function') event.stopImmediatePropagation();
      else event.stopPropagation();
    }, true);

    document.addEventListener('mousedown', (event) => {
      if (menuEl.style.display === 'block' && !menuEl.contains(event.target)) close();
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && menuEl.style.display === 'block') close();
    });
    document.addEventListener('scroll', () => {
      if (menuEl.style.display === 'block') close();
    }, true);

    for (const button of menuEl.querySelectorAll('.context-menu-item')) {
      button.addEventListener('click', async () => {
        const action = button.dataset.action;
        const value = selectedText;
        close();
        await runAction(action, value);
      });
    }
    return true;
  }

  return { init, open, close, readCardSelection, runAction };
}

module.exports = { createCardSelectionContextMenuController };
