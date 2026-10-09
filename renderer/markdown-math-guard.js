'use strict';

// marked parses backslash delimiters as Markdown escapes and turns newlines
// inside display math into <br>/paragraph/heading nodes. KaTeX auto-render can
// only match delimiters inside contiguous text nodes, so protect the complete
// expression before Markdown and restore it as escaped text afterwards.
const GUARDED_MATH_DELIMITERS = Object.freeze([
  Object.freeze({ left: '$$', right: '$$' }),
  Object.freeze({ left: '\\[', right: '\\]' }),
  Object.freeze({ left: '\\(', right: '\\)' }),
]);

function _escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function _isEscaped(source, index) {
  let slashCount = 0;
  for (let i = index - 1; i >= 0 && source[i] === '\\'; i -= 1) slashCount += 1;
  return slashCount % 2 === 1;
}

function _lineEnd(source, start) {
  const newline = source.indexOf('\n', start);
  return newline < 0 ? source.length : newline;
}

function _backtickRunLength(source, start) {
  let end = start;
  while (end < source.length && source[end] === '`') end += 1;
  return end - start;
}

function _findInlineCodeEnd(source, start, runLength) {
  let cursor = start;
  while (cursor < source.length) {
    const tick = source.indexOf('`', cursor);
    if (tick < 0) return -1;
    const length = _backtickRunLength(source, tick);
    if (length === runLength) return tick + length;
    cursor = tick + length;
  }
  return -1;
}

function _collectMarkdownCodeSpans(text) {
  const source = String(text || '');
  const spans = [];
  let cursor = 0;

  while (cursor < source.length) {
    const atLineStart = cursor === 0 || source[cursor - 1] === '\n';
    if (atLineStart) {
      const openingLineEnd = _lineEnd(source, cursor);
      const openingLine = source.slice(cursor, openingLineEnd).replace(/\r$/, '');
      const opening = openingLine.match(/^[ \t]{0,3}(`{3,}|~{3,})/);
      if (opening) {
        const fenceChar = opening[1][0];
        const fenceLength = opening[1].length;
        let lineStart = openingLineEnd < source.length ? openingLineEnd + 1 : source.length;
        let spanEnd = source.length;
        while (lineStart < source.length) {
          const closingLineEnd = _lineEnd(source, lineStart);
          const closingLine = source.slice(lineStart, closingLineEnd).replace(/\r$/, '');
          const closing = closingLine.match(/^[ \t]{0,3}(`+|~+)[ \t]*$/);
          if (closing && closing[1][0] === fenceChar && closing[1].length >= fenceLength) {
            spanEnd = closingLineEnd < source.length ? closingLineEnd + 1 : closingLineEnd;
            break;
          }
          lineStart = closingLineEnd < source.length ? closingLineEnd + 1 : source.length;
        }
        spans.push({ start: cursor, end: spanEnd });
        cursor = spanEnd;
        continue;
      }
    }

    if (source[cursor] === '`') {
      const runLength = _backtickRunLength(source, cursor);
      const end = _findInlineCodeEnd(source, cursor + runLength, runLength);
      if (end >= 0) {
        spans.push({ start: cursor, end });
        cursor = end;
        continue;
      }
      cursor += runLength;
      continue;
    }
    cursor += 1;
  }
  return spans;
}

function _findOutsideSpans(source, needle, from, excludedSpans) {
  let cursor = from;
  while (cursor < source.length) {
    const index = source.indexOf(needle, cursor);
    if (index < 0) return -1;
    const excluded = excludedSpans.find(span => index >= span.start && index < span.end);
    if (excluded) {
      cursor = excluded.end;
      continue;
    }
    if (_isEscaped(source, index)) {
      cursor = index + 1;
      continue;
    }
    return index;
  }
  return -1;
}

function _findNextOpening(source, from, excludedSpans) {
  let found = null;
  for (const delimiter of GUARDED_MATH_DELIMITERS) {
    const index = _findOutsideSpans(source, delimiter.left, from, excludedSpans);
    if (index < 0) continue;
    if (!found || index < found.index || (index === found.index && delimiter.left.length > found.delimiter.left.length)) {
      found = { index, delimiter };
    }
  }
  return found;
}

function _collectMathSpans(source) {
  const excludedSpans = _collectMarkdownCodeSpans(source);
  const spans = [];
  let cursor = 0;
  while (cursor < source.length) {
    const opening = _findNextOpening(source, cursor, excludedSpans);
    if (!opening) break;
    const contentStart = opening.index + opening.delimiter.left.length;
    const closing = _findOutsideSpans(source, opening.delimiter.right, contentStart, excludedSpans);
    if (closing < 0) {
      cursor = contentStart;
      continue;
    }
    if (opening.delimiter.left !== opening.delimiter.right) {
      const nestedOpening = _findOutsideSpans(source, opening.delimiter.left, contentStart, excludedSpans);
      if (nestedOpening >= 0 && nestedOpening < closing) {
        cursor = nestedOpening;
        continue;
      }
    }
    spans.push({
      start: opening.index,
      end: closing + opening.delimiter.right.length,
      raw: source.slice(opening.index, closing + opening.delimiter.right.length),
    });
    cursor = closing + opening.delimiter.right.length;
  }
  return spans;
}

function guardMarkdownMath(text) {
  const source = String(text || '');
  const spans = _collectMathSpans(source);
  if (spans.length === 0) return { text: source, entries: [] };

  let salt = 0;
  let prefix = '';
  do {
    prefix = `HUBMARKDOWNMATHGUARD${salt++}X`;
  } while (source.includes(prefix));

  const entries = spans.map((span, index) => ({
    ...span,
    token: `${prefix}${index}Z`,
  }));
  let guarded = '';
  let cursor = 0;
  for (const entry of entries) {
    guarded += source.slice(cursor, entry.start) + entry.token;
    cursor = entry.end;
  }
  guarded += source.slice(cursor);
  return { text: guarded, entries };
}

function restoreMarkdownMath(html, guard) {
  let out = String(html || '');
  const entries = guard && Array.isArray(guard.entries) ? guard.entries : [];
  for (const entry of entries) {
    out = out.split(entry.token).join(_escapeHtml(entry.raw));
  }
  return out;
}

module.exports = {
  GUARDED_MATH_DELIMITERS,
  guardMarkdownMath,
  restoreMarkdownMath,
  _collectMarkdownCodeSpans,
  _collectMathSpans,
};
