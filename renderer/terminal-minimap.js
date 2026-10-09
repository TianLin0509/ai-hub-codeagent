function createTerminalMinimapFactory(options = {}) {
  const doc = options.document || document;
  const getTerminalCache = typeof options.getTerminalCache === 'function' ? options.getTerminalCache : () => null;
  const ownsTranscript = options.ownsTranscript || (() => false);
  const navigateTranscript = options.navigateTranscript || (() => false);
  const PROMPT_LINE_RE = options.promptLineRe;
  const AI_MARKERS_RE = options.aiMarkersRe;
  const flashPromptLine = typeof options.flashPromptLine === 'function' ? options.flashPromptLine : () => {};
  const raf = typeof options.requestAnimationFrame === 'function'
    ? options.requestAnimationFrame
    : (fn) => setTimeout(fn, 0);

// Minimap: a narrow strip on the right edge of the terminal that shows prompt
// locations + the viewport window. Scans the xterm buffer on-demand (debounced);
// no line-by-line callbacks, so the terminal.write fast path stays untouched.
function mountMinimap(sessionId, termContainer, terminal) {
  const strip = doc.createElement('div');
  strip.className = 'terminal-minimap';
  const viewport = doc.createElement('div');
  viewport.className = 'minimap-viewport';
  const ticksLayer = doc.createElement('div');
  ticksLayer.className = 'minimap-ticks';
  strip.append(ticksLayer, viewport);
  termContainer.appendChild(strip);

  let ticks = []; // [{line, text}]
  let scanTimer = null;
  let maxDebounceTimer = null;
  let disposed = false;

  function scanBuffer() {
    if (disposed) return;
    const buf = terminal.buffer.active;
    const total = buf.length;
    const found = [];
    for (let i = 0; i < total; i++) {
      const line = buf.getLine(i);
      if (!line) continue;
      const text = line.translateToString(true);
      if (!text) continue;
      if (AI_MARKERS_RE.test(text)) continue;
      const m = text.match(PROMPT_LINE_RE);
      if (!m) continue;
      const q = m[1].trim();
      if (q.length < 2) continue;
      let endLine = i;
      while (endLine + 1 < total) {
        const next = buf.getLine(endLine + 1);
        if (!next || !next.isWrapped) break;
        endLine++;
      }
      found.push({ line: i, endLine, text: q });
      i = endLine;
    }
    ticks = found;
    render();
  }

  function invalidate() {
    if (disposed) return;
    if (scanTimer) clearTimeout(scanTimer);
    scanTimer = setTimeout(() => {
      if (maxDebounceTimer) { clearTimeout(maxDebounceTimer); maxDebounceTimer = null; }
      scanBuffer();
    }, 250);
    // Force a scan within 2s even if writes keep coming (prevents starvation
    // during continuous AI streaming).
    if (!maxDebounceTimer) {
      maxDebounceTimer = setTimeout(() => {
        maxDebounceTimer = null;
        if (scanTimer) { clearTimeout(scanTimer); scanTimer = null; }
        scanBuffer();
      }, 2000);
    }
  }

  let promptMarkerLayer = null;
  const initCache = getTerminalCache(sessionId);
  let activeLine = (initCache && typeof initCache._activePromptLine === 'number') ? initCache._activePromptLine : -1;

  function ensureMarkerLayer() {
    if (promptMarkerLayer) return promptMarkerLayer;
    promptMarkerLayer = doc.createElement('div');
    promptMarkerLayer.className = 'prompt-marker-layer';
    termContainer.appendChild(promptMarkerLayer);
    return promptMarkerLayer;
  }

  function render() {
    if (disposed) return;
    const native = ownsTranscript(sessionId, terminal);
    strip.hidden = native;
    if (promptMarkerLayer) promptMarkerLayer.hidden = native;
    if (native) {
      getTerminalCache(sessionId)?._navButtons?.refreshState();
      return;
    }
    const buf = terminal.buffer.active;
    const total = Math.max(1, buf.length);
    const stripH = strip.clientHeight || 1;
    // Ticks
    ticksLayer.innerHTML = '';
    const frag = doc.createDocumentFragment();
    for (const t of ticks) {
      const y = (t.line / total) * stripH;
      const el = doc.createElement('div');
      el.className = 'minimap-tick';
      el.style.top = Math.round(y) + 'px';
      el.title = t.text.slice(0, 80);
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        try { terminal.scrollToLine(t.line); } catch {}
      });
      frag.appendChild(el);
    }
    ticksLayer.appendChild(frag);
    // Viewport box
    const top = (buf.viewportY / total) * stripH;
    const height = Math.max(6, (terminal.rows / total) * stripH);
    viewport.style.top = Math.round(top) + 'px';
    viewport.style.height = Math.round(height) + 'px';

    // Prompt line markers (left bar + background) for visible ticks
    const layer = ensureMarkerLayer();
    layer.innerHTML = '';
    const ren = terminal._core._renderService;
    if (!ren || !ren.dimensions) return;
    const cellH = ren.dimensions.css.cell.height;
    const viewY = isNaN(buf.viewportY) ? buf.baseY : buf.viewportY;
    const rows = terminal.rows;
    const markerFrag = doc.createDocumentFragment();
    for (const t of ticks) {
      const end = t.endLine || t.line;
      if (end < viewY || t.line >= viewY + rows) continue;
      const visStart = Math.max(t.line, viewY);
      const visEnd = Math.min(end, viewY + rows - 1);
      const topPx = (visStart - viewY) * cellH;
      const heightPx = (visEnd - visStart + 1) * cellH;
      const marker = doc.createElement('div');
      marker.className = 'prompt-line-marker' + (t.line === activeLine ? ' prompt-line-marker-active' : '');
      marker.style.top = topPx + 'px';
      marker.style.height = heightPx + 'px';
      markerFrag.appendChild(marker);
    }
    layer.appendChild(markerFrag);

    // Notify any external listeners (e.g. nav buttons) that ticks/active changed.
    const cache = getTerminalCache(sessionId);
    if (cache && cache._navButtons && cache._navButtons.refreshState) {
      cache._navButtons.refreshState();
    }
  }

  // Strip click (outside ticks) → scroll to proportional line.
  strip.addEventListener('click', (e) => {
    e.stopPropagation();
    const rect = strip.getBoundingClientRect();
    const rel = (e.clientY - rect.top) / Math.max(1, rect.height);
    const buf = terminal.buffer.active;
    const target = Math.max(0, Math.min(buf.length - 1, Math.round(rel * buf.length)));
    try { terminal.scrollToLine(target); } catch {}
  });

  // xterm listeners. Keep them disposable.
  const scrollSub = terminal.onScroll(() => render());
  const renderSub = terminal.onRender(() => invalidate());

  // Initial scan (wait a frame so buffer is populated).
  raf(() => { scanBuffer(); render(); });

  // --- nav helpers (shared by Ctrl+Up/Down keyboard and ▲▼ buttons) ---
  function findNavTarget(direction) {
    if (!ticks.length) return null;
    const buf = terminal.buffer.active;
    const hasActive = activeLine >= 0;
    let cur;
    if (hasActive) {
      // If user scrolled far from the last-jumped prompt, fall back to viewport
      // anchor so the next jump starts near where the user is actually looking.
      const viewY = buf.viewportY;
      if (activeLine < viewY || activeLine >= viewY + terminal.rows) {
        cur = direction === 'up' ? viewY + terminal.rows : viewY;
      } else {
        cur = activeLine;
      }
    } else if (direction === 'up') cur = buf.viewportY + terminal.rows;
    else cur = buf.viewportY;
    if (direction === 'up') {
      for (let i = ticks.length - 1; i >= 0; i--) {
        if (ticks[i].line < cur) return ticks[i];
      }
    } else {
      for (let i = 0; i < ticks.length; i++) {
        if (ticks[i].line > cur) return ticks[i];
      }
    }
    return null;
  }

  function navTo(direction) {
    if (navigateTranscript(sessionId, terminal, direction)) return true;
    const target = findNavTarget(direction);
    if (!target) return false;
    try { terminal.scrollToLine(target.line); } catch {}
    activeLine = target.line;
    flashPromptLine(terminal, target.line);
    render();
    // Sync external state field (kept for backward compat with any reader)
    const cache = getTerminalCache(sessionId);
    if (cache) cache._activePromptLine = target.line;
    return true;
  }

  return {
    invalidate,
    getTicks() { return ticks; },
    setActiveLine(line) {
      activeLine = line;
      // Mirror to cache so re-mounts after a session-switch see the same state
      // navTo() writes (single source of truth).
      const cache = getTerminalCache(sessionId);
      if (cache) cache._activePromptLine = line;
      render();
    },
    navPrev() { return navTo('up'); },
    navNext() { return navTo('down'); },
    ownsTranscript() { return ownsTranscript(sessionId, terminal); },
    canNavPrev() { return ownsTranscript(sessionId, terminal) || findNavTarget('up') !== null; },
    canNavNext() { return ownsTranscript(sessionId, terminal) || findNavTarget('down') !== null; },
    dispose() {
      disposed = true;
      if (scanTimer) clearTimeout(scanTimer);
      if (maxDebounceTimer) clearTimeout(maxDebounceTimer);
      try { scrollSub.dispose(); } catch {}
      try { renderSub.dispose(); } catch {}
      if (strip.parentNode) strip.parentNode.removeChild(strip);
      if (promptMarkerLayer && promptMarkerLayer.parentNode) promptMarkerLayer.parentNode.removeChild(promptMarkerLayer);
    },
  };
}

// Floating ▲▼ buttons at the terminal's lower-right edge. Shares lifecycle
// with mountMinimap: created by attachTerminalToPanel after mountMinimap,
// disposed when the terminalCache entry's _minimap is disposed (we attach
// our dispose to the same chain via the returned object).
//
// `sessionId` is reserved for symmetry with mountMinimap and potential future
// use (e.g., per-session button state); not currently used in the body.
function mountPromptNavButtons(sessionId, termContainer, minimap) {
  const wrap = doc.createElement('div');
  wrap.className = 'prompt-nav-buttons';

  const btnUp = doc.createElement('button');
  btnUp.className = 'prompt-nav-btn';
  btnUp.setAttribute('data-dir', 'up');
  btnUp.title = '上一个问题 (Ctrl+↑)';
  btnUp.textContent = '▲';

  const btnDown = doc.createElement('button');
  btnDown.className = 'prompt-nav-btn';
  btnDown.setAttribute('data-dir', 'down');
  btnDown.title = '下一个问题 (Ctrl+↓)';
  btnDown.textContent = '▼';

  wrap.appendChild(btnUp);
  wrap.appendChild(btnDown);
  termContainer.appendChild(wrap);

  const latest = doc.createElement('button');
  latest.type = 'button';
  latest.className = 'pty-jump-latest';
  latest.textContent = '↓ 回到最新';
  latest.setAttribute('aria-label', '回到最新输出并继续跟随');
  termContainer.appendChild(latest);
  latest.addEventListener('click', (event) => {
    event.stopPropagation();
    const cached = getTerminalCache(sessionId);
    if (!cached?.terminal) return;
    // The explicit click supersedes delayed events from the previous wheel.
    cached._codexUserScrollIntentUntil = 0;
    cached._codexUserScrollCanAttach = true;
    cached._codexFollowBottom = true;
    if (!navigateTranscript(sessionId, cached.terminal, 'bottom')) {
      cached.terminal.scrollToBottom();
    }
    refreshState();
  });

  function refreshState() {
    btnUp.title = minimap.ownsTranscript?.() ? '上翻一页 (PageUp)' : '上一个问题 (Ctrl+↑)';
    btnDown.title = minimap.ownsTranscript?.() ? '下翻一页 (PageDown)' : '下一个问题 (Ctrl+↓)';
    btnUp.disabled = !minimap.canNavPrev();
    btnDown.disabled = !minimap.canNavNext();
    const buffer = getTerminalCache(sessionId)?.terminal?.buffer?.active;
    // Full-screen Codex owns its history and exposes no xterm scroll offset;
    // keep its escape-to-latest action available even when baseY is zero.
    latest.hidden = !minimap.ownsTranscript?.() && !(buffer && buffer.viewportY < buffer.baseY);
  }

  btnUp.addEventListener('click', (e) => {
    // stopPropagation: prevent termContainer's focus-on-click listener from firing
    e.stopPropagation();
    minimap.navPrev();
    refreshState();
    const c = getTerminalCache(sessionId);
    if (c && c.terminal) c.terminal.focus();
  });
  btnDown.addEventListener('click', (e) => {
    e.stopPropagation();
    minimap.navNext();
    refreshState();
    const c = getTerminalCache(sessionId);
    if (c && c.terminal) c.terminal.focus();
  });

  // Initial call: ticks array is empty until the rAF scan in mountMinimap
  // completes, so buttons start disabled. mountMinimap's render() then calls
  // refreshState() after the first scan and will re-enable them.
  refreshState();

  return {
    refreshState,
    dispose() {
      if (wrap.parentNode) wrap.parentNode.removeChild(wrap);
      latest.remove();
    },
  };
}



  return { mountMinimap, mountPromptNavButtons };
}

module.exports = { createTerminalMinimapFactory };
