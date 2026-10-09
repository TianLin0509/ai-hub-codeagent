'use strict';

// Codex does not expose a prose color setting. Read only the xterm viewport and
// draw faint answer and semantic-line accents above its canvas; PTY bytes and xterm cells remain
// untouched. This is a visual cue, never a source of session/runtime truth.
function findAnswerRanges(lines, viewY, rows) {
  const visibleEnd = Math.min(lines.length, viewY + rows);
  const scanStart = Math.max(0, viewY - 200);
  const ranges = [];
  let start = -1;
  const close = end => {
    if (start < 0 || end <= start) return;
    const first = Math.max(start, viewY);
    const last = Math.min(end, visibleEnd);
    if (last > first) ranges.push({ first: first - viewY, rows: last - first });
    start = -1;
  };
  for (let y = scanStart; y < visibleEnd; y++) {
    const raw = String(lines[y] || '');
    const text = raw.trim();
    if (/^[•●]\s+\S/u.test(raw)) {
      close(y);
      start = y;
    } else if (start >= 0 && (/^›(?:\s|$)/u.test(text)
        || /^\d{1,2}:\d{2}(?:\s*(?:AM|PM))?$/i.test(text)
        || /^Warnings\s*·/i.test(text))) {
      close(y);
    }
  }
  close(visibleEnd);
  return ranges;
}

function accentLines(lines, viewY, ranges) {
  const result = [];
  for (const range of ranges) {
    const diffRows = new Set();
    for (let row = range.first; row < range.first + range.rows;) {
      const text = String(lines[viewY + row] || '').trim();
      if (!/^[+-](?![+-])\s*\S/.test(text)) { row++; continue; }
      const start = row;
      let added = false;
      let removed = false;
      while (row < range.first + range.rows) {
        const candidate = String(lines[viewY + row] || '').trim();
        if (!/^[+-](?![+-])\s*\S/.test(candidate)) break;
        if (candidate[0] === '+') added = true;
        else removed = true;
        row++;
      }
      if (added && removed) for (let diffRow = start; diffRow < row; diffRow++) diffRows.add(diffRow);
    }
    for (let row = range.first; row < range.first + range.rows; row++) {
      const text = String(lines[viewY + row] || '').trim();
      let color = null;
      if (/^[•●]\s+\S/u.test(text)) color = '#e6bb7c';
      else if (diffRows.has(row)) color = text[0] === '+' ? '#86cda5' : '#dc8585';
      else if (/^(?:#{1,3}\s+|(?:[-*]|\d+\.)\s+)\S/u.test(text)) color = '#d6ae77';
      else if (/^\/\//.test(text)) color = '#80c6c1';
      else if (/^(?:function|class|const|let|return|import|export)\b/.test(text)) color = '#9cc9e7';
      if (color) result.push({ row, color });
    }
  }
  return result;
}

function mountCodexAnswerAccent(terminal, document) {
  let disposed = false;
  let timer = null;
  let layer = null;
  let lastSignature = null;

  function render() {
    timer = null;
    if (disposed || !terminal.element || !terminal.element.offsetWidth) return;
    const screen = terminal.element.querySelector('.xterm-screen');
    const cellH = terminal._core?._renderService?.dimensions?.css?.cell?.height;
    if (!screen || !Number.isFinite(cellH) || cellH <= 0) return;
    if (!layer) {
      layer = document.createElement('div');
      layer.className = 'codex-answer-accent-layer';
    }
    if (layer.parentElement !== screen) screen.appendChild(layer);
    const buffer = terminal.buffer.active;
    const viewY = Number.isFinite(buffer.viewportY) ? buffer.viewportY : buffer.baseY;
    const lines = [];
    const first = Math.max(0, viewY - 200);
    for (let y = first; y < Math.min(buffer.length, viewY + terminal.rows); y++) {
      lines[y] = buffer.getLine(y)?.translateToString(true) || '';
    }
    const ranges = findAnswerRanges(lines, viewY, terminal.rows);
    const colored = accentLines(lines, viewY, ranges);
    const signature = JSON.stringify({ viewY, cols: terminal.cols, cellH, ranges, colored,
      text: ranges.map(range => Array.from({ length: range.rows }, (_, row) => lines[viewY + range.first + row])) });
    if (signature === lastSignature) return;
    lastSignature = signature;
    const fragment = document.createDocumentFragment();
    for (const range of ranges) {
      const band = document.createElement('div');
      band.className = 'codex-answer-accent-band';
      band.style.top = `${range.first * cellH}px`;
      band.style.height = `${range.rows * cellH}px`;
      fragment.appendChild(band);
    }
    for (const { row, color } of colored) {
      const tint = document.createElement('div');
      tint.className = 'codex-answer-line-tint';
      tint.style.top = `${row * cellH}px`;
      tint.style.height = `${cellH}px`;
      tint.style.background = `linear-gradient(90deg, ${color}20, transparent 75%)`;
      tint.style.boxShadow = `inset 3px 0 ${color}`;
      fragment.appendChild(tint);
    }
    layer.replaceChildren(fragment);
    layer.dataset.tintedRows = String(colored.length);
  }

  function refresh() {
    if (disposed || timer) return;
    timer = setTimeout(render, 80);
  }
  const subscriptions = [terminal.onRender(refresh), terminal.onScroll(refresh), terminal.onResize(refresh)];
  refresh();
  return {
    refresh,
    dispose() {
      disposed = true;
      if (timer) clearTimeout(timer);
      for (const subscription of subscriptions) subscription.dispose();
      layer?.remove();
    },
  };
}

module.exports = { findAnswerRanges, accentLines, mountCodexAnswerAccent };
