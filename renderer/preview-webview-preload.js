'use strict';

const { ipcRenderer } = require('electron');
// Sandboxed guests may require Electron, but cannot require local CommonJS modules.
window.addEventListener('keydown', (event) => {
  if (!event.isTrusted) return;
  const key = String(event.key || '').toLowerCase();
  if (event.key === 'F3') {
    event.preventDefault();
    event.stopImmediatePropagation();
    ipcRenderer.sendToHost('preview-shortcut', 'find-next', event.shiftKey ? -1 : 1);
    return;
  }
  if (event.key === 'Escape') {
    ipcRenderer.sendToHost('preview-shortcut', 'escape');
    return;
  }
  if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey) return;
  const action = key === 'f' ? 'find' : key === 'o' ? 'open-path' : null;
  if (!action) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  ipcRenderer.sendToHost('preview-shortcut', action);
}, true);

// Ctrl + wheel zooms the whole preview, as on the Hub's own preview content;
// the host adds the deltas up into 10% steps.
window.addEventListener('wheel', (event) => {
  if (!event.isTrusted || !(event.ctrlKey || event.metaKey) || !event.deltaY) return;
  event.preventDefault();
  const delta = event.deltaMode === 1 ? event.deltaY * 33 : event.deltaMode === 2 ? event.deltaY * 800 : event.deltaY;
  ipcRenderer.sendToHost('preview-shortcut', 'wheel-zoom', delta);
}, { capture: true, passive: false });

let copySequence = 0;
function selectedText(target) {
  const input = target?.closest?.('input, textarea');
  if (input && typeof input.selectionStart === 'number' && input.selectionEnd > input.selectionStart) {
    return input.value.slice(input.selectionStart, input.selectionEnd);
  }
  return String(window.getSelection()?.toString() || '');
}
async function copySelection(event) {
  const text = selectedText(event.target);
  if (!text) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  const sequence = ++copySequence;
  let html;
  const selection = window.getSelection();
  if (!event.target?.closest?.('input, textarea') && selection?.rangeCount) {
    const fragment = document.createElement('div');
    fragment.appendChild(selection.getRangeAt(0).cloneContents());
    html = fragment.innerHTML;
  }
  let result;
  try { result = await ipcRenderer.invoke('clipboard:write-text', text, html ? { html } : undefined); }
  catch (error) { result = { ok: false, reason: error.message }; }
  if (sequence !== copySequence || result?.reason === 'superseded') return;
  ipcRenderer.sendToHost('preview-copy-feedback', {
    ...result, ok: result?.ok === true, length: Array.from(text).length, source: 'preview-selection',
  });
}
window.addEventListener('keydown', event => {
  if (!event.isTrusted || event.isComposing || event.altKey || !(event.ctrlKey || event.metaKey)) return;
  if (String(event.key).toLowerCase() === 'c' || event.code === 'KeyC') void copySelection(event);
}, true);
window.addEventListener('copy', event => { if (event.isTrusted && !event.defaultPrevented) void copySelection(event); }, true);
window.addEventListener('contextmenu', event => {
  if (!event.isTrusted) return;
  const text = selectedText(event.target);
  if (!text) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  ipcRenderer.sendToHost('preview-selection-menu', { text, x:event.clientX, y:event.clientY, width:innerWidth, height:innerHeight });
}, true);
