'use strict';

function cleanHeadingText(value) {
  return String(value || '')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/[\x60*_~]/g, '')
    .replace(/\\([\\\x60*_[\]{}()#+.!~-])/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

function createHeadingSlug(value, used = new Map()) {
  const base = String(value || '')
    .normalize('NFKC')
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-') || 'section';
  const count = Number(used.get(base)) || 0;
  used.set(base, count + 1);
  return count === 0 ? base : base + '-' + count;
}

function extractMarkdownOutline(source, tokens = [], { includeEmpty = false } = {}) {
  const rawSource = String(source || '');
  const outline = [];
  const used = new Map();

  const lineAtOffset = (offset) => (
    rawSource.slice(0, Math.max(0, offset)).split(/\r\n?|\n/).length
  );

  const locate = (containerRaw, tokenRaw, cursor) => {
    if (!tokenRaw) return Math.max(0, cursor);
    let found = containerRaw.indexOf(tokenRaw, Math.max(0, cursor));
    if (found >= 0) return found;
    const trimmed = tokenRaw.replace(/\s+$/, '');
    found = trimmed ? containerRaw.indexOf(trimmed, Math.max(0, cursor)) : -1;
    return found >= 0 ? found : Math.max(0, cursor);
  };

  const walk = (tokenList, containerRaw, baseOffset = 0) => {
    if (!Array.isArray(tokenList)) return;
    let cursor = 0;
    for (const token of tokenList) {
      if (!token || typeof token !== 'object') continue;
      const tokenRaw = String(token.raw || '');
      const localOffset = locate(containerRaw, tokenRaw, cursor);
      const absoluteOffset = baseOffset + localOffset;
      if (token.type === 'heading') {
        const text = cleanHeadingText(token.text);
        if (text || includeEmpty) {
          outline.push({
            level: Math.max(1, Math.min(6, Number(token.depth) || 1)),
            text,
            line: lineAtOffset(absoluteOffset),
            anchor: text ? createHeadingSlug(text, used) : null,
          });
        }
      } else if (Array.isArray(token.items)) {
        let itemCursor = 0;
        for (const item of token.items) {
          const itemRaw = String(item && item.raw || '');
          const itemOffset = locate(tokenRaw, itemRaw, itemCursor);
          walk(item && item.tokens, itemRaw || tokenRaw, absoluteOffset + itemOffset);
          itemCursor = itemOffset + itemRaw.length;
        }
      } else if (Array.isArray(token.tokens)) {
        walk(token.tokens, tokenRaw || containerRaw, absoluteOffset);
      }
      cursor = Math.max(cursor, localOffset + tokenRaw.length);
    }
  };

  walk(tokens, rawSource, 0);
  return outline;
}

function formatPreviewReference(target, { line = 0, anchor = '' } = {}) {
  const cleanedTarget = String(target || '').trim();
  if (!cleanedTarget) return '';
  const normalizedAnchor = String(anchor || '').replace(/^#+/, '').trim();
  if (/^https?:\/\//i.test(cleanedTarget)) {
    const withoutHash = cleanedTarget.split('#')[0];
    return normalizedAnchor ? withoutHash + '#' + normalizedAnchor : withoutHash;
  }
  const lineSuffix = Number.isInteger(Number(line)) && Number(line) > 0
    ? ':' + Number(line)
    : '';
  const anchorSuffix = normalizedAnchor ? '#' + normalizedAnchor : '';
  return cleanedTarget + lineSuffix + anchorSuffix;
}

module.exports = {
  cleanHeadingText,
  createHeadingSlug,
  extractMarkdownOutline,
  formatPreviewReference,
};
