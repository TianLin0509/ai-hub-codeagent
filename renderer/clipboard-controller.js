'use strict';

const DEFAULT_RETRY_DELAYS_MS = Object.freeze([0, 30, 110, 260]);

function normalizeClipboardText(value) {
  return String(value == null ? '' : value).replace(/\r\n?/g, '\n');
}

function selectedTextFromInput(element) {
  if (!element || typeof element.value !== 'string') return '';
  const start = Number(element.selectionStart);
  const end = Number(element.selectionEnd);
  if (!Number.isInteger(start) || !Number.isInteger(end) || end <= start) return '';
  return element.value.slice(start, end);
}

function elementForTarget(target) {
  if (!target) return null;
  return target.nodeType === 1 ? target : target.parentElement || null;
}

function readSelectedText(target, win) {
  const element = elementForTarget(target);
  const editable = element && typeof element.closest === 'function'
    ? element.closest('textarea, input')
    : null;
  const inputText = selectedTextFromInput(editable);
  if (inputText) return inputText;

  const selection = win && typeof win.getSelection === 'function' ? win.getSelection() : null;
  if (!selection || selection.rangeCount < 1 || selection.isCollapsed) return '';
  return String(selection.toString() || '');
}

function isTerminalTarget(target) {
  const element = elementForTarget(target);
  return !!(element && typeof element.closest === 'function'
    && element.closest('.xterm, .xterm-helper-textarea'));
}

function countCharacters(value) {
  return Array.from(String(value || '')).length;
}

function createClipboardController({
  document,
  window,
  clipboard,
  retryDelaysMs = DEFAULT_RETRY_DELAYS_MS,
  wait = ms => new Promise(resolve => setTimeout(resolve, ms)),
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
  onFeedback = null,
  renderFeedback = true,
  // 选区文字的最后一道转换：会话输入框的粘贴块在 DOM 里是内部标记，复制时要换回原文。
  expandText = text => text,
} = {}) {
  const delays = Array.from(retryDelaysMs || DEFAULT_RETRY_DELAYS_MS)
    .map(value => Math.max(0, Number(value) || 0));
  let feedbackTimer = null;
  let initialized = false;

  function ensureFeedbackElement() {
    if (!renderFeedback || !document || !document.body) return null;
    let root = document.getElementById('hub-copy-feedback');
    if (root) return root;
    root = document.createElement('div');
    root.id = 'hub-copy-feedback';
    root.className = 'hub-copy-feedback';
    root.setAttribute('role', 'status');
    root.setAttribute('aria-live', 'polite');
    root.setAttribute('aria-atomic', 'true');

    const icon = document.createElement('span');
    icon.className = 'hub-copy-feedback-icon';
    icon.setAttribute('aria-hidden', 'true');
    const copy = document.createElement('span');
    copy.className = 'hub-copy-feedback-copy';
    const title = document.createElement('strong');
    const detail = document.createElement('small');
    copy.append(title, detail);
    root.append(icon, copy);
    document.body.appendChild(root);
    return root;
  }

  function showFeedback(feedback = {}) {
    const ok = feedback.ok === true;
    const length = Math.max(0, Number(feedback.length) || 0);
    const attempts = Math.max(1, Number(feedback.attempts) || 1);
    const payload = {
      ...feedback,
      ok,
      length,
      attempts,
      message: feedback.message || (ok ? `已复制 · ${length} 字` : '复制失败 · 剪贴板暂时不可用'),
    };
    if (typeof onFeedback === 'function') {
      try { onFeedback(payload); } catch (_) {}
    }

    const root = ensureFeedbackElement();
    if (!root) return payload;
    const icon = root.querySelector('.hub-copy-feedback-icon');
    const title = root.querySelector('strong');
    const detail = root.querySelector('small');
    if (icon) icon.textContent = ok ? '✓' : '!';
    if (title) title.textContent = ok ? '已复制' : '复制失败';
    if (detail) {
      detail.textContent = ok
        ? `${length} 字 · 已校验${attempts > 1 ? ` · 自动重试 ${attempts - 1} 次` : ''}`
        : '剪贴板可能正被其他程序占用，请重试';
    }
    root.dataset.state = ok ? 'success' : 'error';
    root.classList.remove('visible');
    // Restart the transition even when two copies happen in quick succession.
    void root.offsetWidth;
    root.classList.add('visible');
    if (feedbackTimer) clearTimeoutFn(feedbackTimer);
    feedbackTimer = setTimeoutFn(() => root.classList.remove('visible'), ok ? 1600 : 2800);
    return payload;
  }

  function clipboardMatches(expected) {
    if (!clipboard || typeof clipboard.readText !== 'function') return true;
    return normalizeClipboardText(clipboard.readText()) === normalizeClipboardText(expected);
  }

  // options.silent：只写不弹浮层。给自带反馈的调用方用（如「复制对话」按钮，
  //   它把结果显示在按钮上），避免同一次复制弹两处提示。
  async function copyText(value, options = {}) {
    const text = String(value == null ? '' : value);
    const report = options.silent ? (payload => payload) : showFeedback;
    if (!text) return { ok: false, reason: 'empty', attempts: 0, length: 0 };
    if (!clipboard || typeof clipboard.writeText !== 'function') {
      return report({ ok: false, reason: 'clipboard-unavailable', attempts: 1, length: countCharacters(text), source: options.source });
    }

    let lastError = null;
    const attempts = delays.length > 0 ? delays.length : 1;
    for (let index = 0; index < attempts; index += 1) {
      const delay = delays[index] || 0;
      if (delay > 0) await wait(delay);
      try {
        await Promise.resolve(clipboard.writeText(text));
        if (clipboardMatches(text)) {
          const result = {
            ok: true,
            attempts: index + 1,
            length: countCharacters(text),
            source: options.source || 'selection',
          };
          report(result);
          return result;
        }
        lastError = new Error('clipboard verification mismatch');
      } catch (error) {
        lastError = error;
      }
    }

    return report({
      ok: false,
      reason: lastError && lastError.message ? lastError.message : 'clipboard-write-failed',
      attempts,
      length: countCharacters(text),
      source: options.source || 'selection',
    });
  }

  function handleKeydown(event) {
    if (!event || event.isComposing || event.altKey || !(event.ctrlKey || event.metaKey)) return false;
    const key = String(event.key || '').toLowerCase();
    if (key !== 'c' && event.code !== 'KeyC') return false;
    // xterm deliberately keeps bare Ctrl+C as SIGINT when it has no selection.
    // Its selected-text path calls copyText() directly from renderer.js.
    if (isTerminalTarget(event.target)) return false;
    const text = expandText(readSelectedText(event.target, window));
    if (!text) return false;
    event.preventDefault?.();
    event.stopImmediatePropagation?.();
    event.stopPropagation?.();
    void copyText(text, { source: 'keyboard-selection' });
    return true;
  }

  function handleNativeCopy(event) {
    // Covers menu/context-menu copy paths that do not pass through keydown.
    // Let Chromium preserve rich formats first, then verify plain text and repair
    // only if the native clipboard write was lost.
    if (!event || event.defaultPrevented) return;
    const text = expandText(readSelectedText(event.target, window));
    if (!text) return;
    setTimeoutFn(() => {
      try {
        if (clipboardMatches(text)) {
          showFeedback({ ok: true, attempts: 1, length: countCharacters(text), source: 'native-copy' });
          return;
        }
      } catch (_) {}
      void copyText(text, { source: 'native-copy-repair' });
    }, 0);
  }

  function init() {
    if (initialized || !document || typeof document.addEventListener !== 'function') return false;
    initialized = true;
    document.addEventListener('keydown', handleKeydown, true);
    document.addEventListener('copy', handleNativeCopy, true);
    return true;
  }

  function destroy() {
    if (!initialized || !document || typeof document.removeEventListener !== 'function') return;
    initialized = false;
    document.removeEventListener('keydown', handleKeydown, true);
    document.removeEventListener('copy', handleNativeCopy, true);
    if (feedbackTimer) clearTimeoutFn(feedbackTimer);
    feedbackTimer = null;
  }

  return {
    copyText,
    destroy,
    handleKeydown,
    handleNativeCopy,
    init,
    showFeedback,
  };
}

module.exports = {
  DEFAULT_RETRY_DELAYS_MS,
  createClipboardController,
  isTerminalTarget,
  normalizeClipboardText,
  readSelectedText,
  selectedTextFromInput,
};
