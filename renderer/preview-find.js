'use strict';

function findAllOffsets(text, query) {
  const source = String(text || '');
  const needle = String(query || '');
  if (!needle) return [];
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const matcher = new RegExp(escaped, 'giu');
  const offsets = [];
  let match;
  while ((match = matcher.exec(source))) {
    offsets.push({ start: match.index, end: match.index + match[0].length });
    if (!match[0].length) matcher.lastIndex += 1;
  }
  return offsets;
}

function createPreviewFindController({
  document,
  previewBody,
  getWebview = () => previewBody.querySelector('webview'),
  debounceMs = 70,
  webviewTimeoutMs = 2500,
} = {}) {
  const bar = document.getElementById('preview-find-bar');
  const input = document.getElementById('preview-find-input');
  const count = document.getElementById('preview-find-count');
  const previousButton = document.getElementById('preview-find-previous');
  const nextButton = document.getElementById('preview-find-next');
  const closeButton = document.getElementById('preview-find-close');
  const toggleButton = document.getElementById('preview-find-toggle');
  let matches = [];
  let activeIndex = -1;
  let query = '';
  let timer = null;
  let returnFocus = null;
  let attachedWebview = null;
  let webviewMatchCount = 0;
  let webviewSearchToken = 0;
  let webviewActiveQuery = '';
  let webviewFindQueue = Promise.resolve();
  let focusToken = 0;
  let focusTimer = null;
  let restoreFocusTimer = null;

  function cancelFocusTimers() {
    focusToken += 1;
    if (focusTimer) clearTimeout(focusTimer);
    if (restoreFocusTimer) clearTimeout(restoreFocusTimer);
    focusTimer = null;
    restoreFocusTimer = null;
  }

  function registry() {
    return document.defaultView?.CSS?.highlights || globalThis.CSS?.highlights || null;
  }

  function HighlightCtor() {
    return document.defaultView?.Highlight || globalThis.Highlight || null;
  }

  function updateCount(total = matches.length, index = activeIndex) {
    if (!count) return;
    count.textContent = total > 0 ? `${index >= 0 ? index + 1 : 0} / ${total}` : '0 / 0';
    count.dataset.empty = total > 0 ? 'false' : 'true';
    count.dataset.error = 'false';
    count.title = attachedWebview ? '查找当前页面主文档；不包含内嵌 iframe' : '';
  }

  function setFindError(message) {
    matches = [];
    webviewMatchCount = 0;
    activeIndex = -1;
    if (!count) return;
    count.textContent = '查找不可用';
    count.dataset.empty = 'true';
    count.dataset.error = 'true';
    count.title = String(message || '查找失败');
  }

  function clearDomHighlights() {
    const highlights = registry();
    highlights?.delete('preview-find-all');
    highlights?.delete('preview-find-current');
    const selection = document.getSelection?.();
    if (selection && !selection.isCollapsed) selection.removeAllRanges();
  }

  function stopWebviewFind() {
    webviewSearchToken += 1;
    webviewActiveQuery = '';
    const webview = attachedWebview || getWebview();
    if (webview && typeof webview.executeJavaScript === 'function') {
      try {
        const result = webview.executeJavaScript('window.getSelection()?.removeAllRanges(); true;');
        if (result && typeof result.catch === 'function') {
          void result.catch(error => console.debug('[preview-find] clear guest selection skipped:', error && error.message));
        }
      } catch (error) {
        console.debug('[preview-find] clear guest selection skipped:', error && error.message);
      }
    }
    webviewMatchCount = 0;
  }

  function detachWebview() {
    webviewSearchToken += 1;
    webviewActiveQuery = '';
    attachedWebview = null;
    webviewMatchCount = 0;
    input?.removeAttribute('aria-description');
  }

  function attachWebview(webview) {
    if (!webview || attachedWebview === webview) return;
    detachWebview();
    attachedWebview = webview;
    input?.setAttribute('aria-description', '查找当前页面主文档；不包含内嵌 iframe');
  }

  function scrollRangeIntoView(range) {
    if (!range || typeof range.getBoundingClientRect !== 'function') return;
    const rect = range.getBoundingClientRect();
    const bodyRect = previewBody.getBoundingClientRect();
    if (rect.top < bodyRect.top + 8 || rect.bottom > bodyRect.bottom - 8) {
      previewBody.scrollTop += rect.top - bodyRect.top - previewBody.clientHeight * 0.42;
    }
    if (rect.left < bodyRect.left + 8 || rect.right > bodyRect.right - 8) {
      previewBody.scrollLeft += rect.left - bodyRect.left - previewBody.clientWidth * 0.25;
    }
  }

  function paintDomMatches() {
    clearDomHighlights();
    if (matches.length === 0 || activeIndex < 0) {
      updateCount(0, -1);
      return;
    }
    const highlights = registry();
    const Constructor = HighlightCtor();
    const current = matches[activeIndex];
    if (highlights && Constructor) {
      highlights.set('preview-find-all', new Constructor(...matches.filter((_, index) => index !== activeIndex)));
      highlights.set('preview-find-current', new Constructor(current));
    } else {
      const selection = document.getSelection?.();
      selection?.removeAllRanges();
      selection?.addRange(current);
    }
    updateCount(matches.length, activeIndex);
    scrollRangeIntoView(current);
  }

  function collectDomMatches(nextQuery) {
    const offsetsQuery = String(nextQuery || '');
    if (!offsetsQuery || !document.createTreeWalker) return [];
    const NodeFilterCtor = document.defaultView?.NodeFilter || globalThis.NodeFilter;
    if (!NodeFilterCtor) return [];
    const walker = document.createTreeWalker(previewBody, NodeFilterCtor.SHOW_TEXT, {
      acceptNode(node) {
        const parent = node.parentElement;
        if (!node.nodeValue || !parent) return NodeFilterCtor.FILTER_REJECT;
        if (parent.closest?.('.preview-line-num, script, style')) return NodeFilterCtor.FILTER_REJECT;
        return NodeFilterCtor.FILTER_ACCEPT;
      },
    });
    const records = [];
    let combined = '';
    let previousBlock = null;
    const blockForNode = (textNode) => {
      let element = textNode.parentElement;
      while (element && element !== previewBody) {
        const display = document.defaultView?.getComputedStyle?.(element).display || '';
        if (display && display !== 'inline' && display !== 'contents') return element;
        element = element.parentElement;
      }
      return previewBody;
    };
    let node;
    while ((node = walker.nextNode())) {
      const block = blockForNode(node);
      if (records.length > 0 && block !== previousBlock) combined += '\n';
      const start = combined.length;
      combined += node.nodeValue;
      records.push({ node, start, end: combined.length });
      previousBlock = block;
    }
    const ranges = [];
    const recordAt = (position, endExclusive = false) => {
      const target = endExclusive ? position - 1 : position;
      let low = 0;
      let high = records.length - 1;
      let candidate = null;
      while (low <= high) {
        const middle = (low + high) >> 1;
        if (records[middle].start <= target) {
          candidate = records[middle];
          low = middle + 1;
        } else {
          high = middle - 1;
        }
      }
      if (!candidate) return null;
      return endExclusive
        ? (candidate.start < position && position <= candidate.end ? candidate : null)
        : (candidate.start <= position && position < candidate.end ? candidate : null);
    };
    for (const offset of findAllOffsets(combined, offsetsQuery)) {
      const startRecord = recordAt(offset.start);
      const endRecord = recordAt(offset.end, true);
      if (!startRecord || !endRecord) continue;
      const startOffset = offset.start - startRecord.start;
      const endOffset = offset.end - endRecord.start;
      if (startOffset < 0 || endOffset < 0
          || startOffset > startRecord.node.nodeValue.length
          || endOffset > endRecord.node.nodeValue.length) continue;
      const range = document.createRange();
      range.setStart(startRecord.node, startOffset);
      range.setEnd(endRecord.node, endOffset);
      ranges.push(range);
      if (ranges.length >= 2000) return ranges;
    }
    return ranges;
  }

  function runWebviewFind(nextQuery, { forward = true, findNext = false } = {}) {
    const webview = getWebview();
    if (!webview || typeof webview.executeJavaScript !== 'function') return false;
    attachWebview(webview);
    if (!nextQuery) {
      stopWebviewFind();
      updateCount(0, -1);
      return true;
    }
    const normalizedQuery = String(nextQuery);
    const queryChanged = normalizedQuery !== webviewActiveQuery;
    if (queryChanged || !findNext) webviewSearchToken += 1;
    const token = webviewSearchToken;
    webviewActiveQuery = normalizedQuery;
    const resetSelection = queryChanged || !findNext;
    const guestScript = `(() => {
      const query = ${JSON.stringify(String(nextQuery))};
      if (${JSON.stringify(resetSelection)}) window.getSelection()?.removeAllRanges();
      const text = String(document.body?.innerText || '').toLocaleLowerCase();
      const needle = query.toLocaleLowerCase();
      let matches = 0;
      let from = 0;
      while (needle && from <= text.length - needle.length) {
        const index = text.indexOf(needle, from);
        if (index < 0) break;
        matches += 1;
        from = index + Math.max(1, needle.length);
      }
      const found = typeof window.find === 'function'
        ? window.find(query, false, ${JSON.stringify(!forward)}, true, false, false, false)
        : false;
      return { matches, found };
    })()`;
    webviewFindQueue = webviewFindQueue
      .catch(() => null)
      .then(async () => {
        if (token !== webviewSearchToken || attachedWebview !== webview) return;
        let timeoutId = null;
        try {
          const result = await Promise.race([
            Promise.resolve(webview.executeJavaScript(guestScript)),
            new Promise((_, reject) => {
              timeoutId = setTimeout(() => reject(new Error('guest find timed out')), webviewTimeoutMs);
            }),
          ]);
          if (token !== webviewSearchToken || attachedWebview !== webview) return;
          webviewMatchCount = Math.max(0, Number(result && result.matches) || 0);
          if (webviewMatchCount === 0 || !result?.found) activeIndex = -1;
          else if (resetSelection) activeIndex = forward ? 0 : webviewMatchCount - 1;
          else activeIndex = (activeIndex + (forward ? 1 : -1) + webviewMatchCount) % webviewMatchCount;
          updateCount(webviewMatchCount, activeIndex);
        } finally {
          if (timeoutId) clearTimeout(timeoutId);
        }
      })
      .catch(error => {
        if (token !== webviewSearchToken) return;
        console.debug('[preview-find] guest find skipped:', error && error.message);
        setFindError(error && error.message || error);
      });
    return true;
  }

  function run(nextQuery = input?.value || '', { direction = 1, findNext = false } = {}) {
    const normalized = String(nextQuery || '');
    const queryChanged = normalized !== query;
    query = normalized;
    if (runWebviewFind(query, { forward: direction >= 0, findNext: findNext && !queryChanged })) return;
    stopWebviewFind();
    detachWebview();
    if (queryChanged || !findNext) {
      try { matches = collectDomMatches(query); }
      catch (error) {
        console.debug('[preview-find] DOM find skipped:', error && error.message);
        setFindError(error && error.message || error);
        return;
      }
      activeIndex = matches.length > 0 ? 0 : -1;
    } else if (matches.length > 0) {
      activeIndex = (activeIndex + direction + matches.length) % matches.length;
    }
    paintDomMatches();
  }

  function scheduleRun() {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      run(input?.value || '');
    }, Math.max(0, Number(debounceMs) || 0));
  }

  function next(direction = 1) {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    run(input?.value || '', { direction, findNext: true });
  }

  function open() {
    if (!bar || !input) return false;
    cancelFocusTimers();
    const token = focusToken;
    if (bar.hidden) returnFocus = document.activeElement || null;
    bar.hidden = false;
    toggleButton?.setAttribute('aria-expanded', 'true');
    focusTimer = setTimeout(() => {
      focusTimer = null;
      if (token !== focusToken || bar.hidden) return;
      input.focus();
      input.select();
      if (input.value) run(input.value);
    }, 0);
    return true;
  }

  function close({ restoreFocus = true, keepQuery = true } = {}) {
    cancelFocusTimers();
    const token = focusToken;
    if (timer) { clearTimeout(timer); timer = null; }
    if (bar) bar.hidden = true;
    toggleButton?.setAttribute('aria-expanded', 'false');
    clearDomHighlights();
    stopWebviewFind();
    detachWebview();
    matches = [];
    activeIndex = -1;
    query = '';
    updateCount(0, -1);
    if (!keepQuery && input) input.value = '';
    const target = returnFocus;
    returnFocus = null;
    if (restoreFocus && target && target.isConnected !== false && typeof target.focus === 'function') {
      restoreFocusTimer = setTimeout(() => {
        restoreFocusTimer = null;
        if (token !== focusToken || !bar?.hidden) return;
        try { target.focus(); } catch (_) {}
      }, 0);
    }
  }

  function clearForRender() {
    if (bar?.hidden) cancelFocusTimers();
    clearDomHighlights();
    stopWebviewFind();
    detachWebview();
    matches = [];
    activeIndex = -1;
    updateCount(0, -1);
  }

  function refresh() {
    if (!bar || bar.hidden || !input?.value) return;
    run(input.value);
  }

  input?.addEventListener('input', scheduleRun);
  input?.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      next(event.shiftKey ? -1 : 1);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      close();
    }
  });
  previousButton?.addEventListener('click', () => next(-1));
  nextButton?.addEventListener('click', () => next(1));
  closeButton?.addEventListener('click', () => close());
  toggleButton?.setAttribute('aria-expanded', bar && !bar.hidden ? 'true' : 'false');
  updateCount(0, -1);

  return {
    open,
    close,
    next,
    refresh,
    clearForRender,
    attachWebview,
    isOpen: () => !!bar && !bar.hidden,
    getState: () => ({
      query,
      matches: attachedWebview ? webviewMatchCount : matches.length,
      activeIndex,
      webview: !!attachedWebview,
    }),
  };
}

module.exports = {
  createPreviewFindController,
  findAllOffsets,
};
