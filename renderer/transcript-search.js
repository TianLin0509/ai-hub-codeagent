'use strict';

// DOM ranges preserve Markdown, copy handlers and streaming card identity.
function collectTranscriptMatches(root, query) {
  if (!root || !query) return [];
  const doc = root.ownerDocument, win = doc.defaultView;
  const records = [];
  let text = '', previousBlock;
  const walker = doc.createTreeWalker(root, win.NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;
      if (!node.nodeValue || !parent || parent.closest('script,style,button,textarea,[hidden],.turn-meta,.turn-toolbar,.body-fold-toggle,.conversation-long-preview')) return win.NodeFilter.FILTER_REJECT;
      for (let p = parent; p && p !== root; p = p.parentElement) {
        if (win.getComputedStyle(p).display === 'none') return win.NodeFilter.FILTER_REJECT;
      }
      return win.NodeFilter.FILTER_ACCEPT;
    },
  });
  let node;
  while ((node = walker.nextNode())) {
    let block = node.parentElement;
    while (block !== root && ['inline', 'contents'].includes(win.getComputedStyle(block).display)) block = block.parentElement;
    if (records.length && previousBlock !== block) text += '\n';
    const start = text.length;
    text += node.nodeValue;
    records.push({ node, start, end: text.length });
    previousBlock = block;
  }
  const pattern = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'giu');
  const ranges = [];
  let match, cursor = 0;
  while ((match = pattern.exec(text))) {
    const end = match.index + match[0].length;
    while (cursor < records.length && records[cursor].end <= match.index) cursor++;
    const startNode = records[cursor];
    let last = cursor;
    while (last < records.length && records[last].end < end) last++;
    const endNode = records[last];
    if (!startNode || !endNode) continue;
    const range = doc.createRange();
    range.setStart(startNode.node, match.index - startNode.start);
    range.setEnd(endNode.node, end - endNode.start);
    ranges.push(range);
  }
  return ranges;
}

function createTranscriptSearch(document) {
  const win = document.defaultView || {};
  let root = null, query = '', matches = [], index = -1;
  function clear() {
    win.CSS?.highlights?.delete('session-find-all');
    win.CSS?.highlights?.delete('session-find-current');
    root = null; query = ''; matches = []; index = -1;
  }
  function find(nextRoot, nextQuery, direction = 1, advance = true) {
    const previous = matches[index];
    const changed = root !== nextRoot || query !== nextQuery;
    root = nextRoot; query = nextQuery;
    matches = collectTranscriptMatches(root, query);
    const attachedIndex = changed ? -1 : matches.findIndex(r => previous && r.startContainer === previous.startContainer && r.startOffset === previous.startOffset);
    // History hydration can replace a card between keystrokes. Keep the ordinal
    // when its Range detached instead of jumping back to the first result.
    const priorIndex = changed ? -1 : attachedIndex >= 0 ? attachedIndex : Math.min(index, matches.length - 1);
    index = matches.length ? (priorIndex < 0 ? (direction < 0 ? matches.length - 1 : 0)
      : (priorIndex + (advance ? direction : 0) + matches.length) % matches.length) : -1;
    win.CSS?.highlights?.delete('session-find-all');
    win.CSS?.highlights?.delete('session-find-current');
    if (index >= 0) {
      const current = matches[index];
      let parent = current.startContainer.parentElement;
      const article = parent.closest('.mr-gc-msg.gc-journal-long');
      if (article && article.dataset.journalExpanded !== 'true') article.querySelector('.gc-journal-expand')?.click();
      for (let el = parent; el && el !== root; el = el.parentElement) {
        if (el.tagName === 'DETAILS') el.open = true;
        if (el.classList.contains('folded')) {
          el.closest('.turn-card')?.querySelector('[data-action="body-expand"]')?.click();
        }
      }
      if (win.CSS?.highlights && win.Highlight) {
        win.CSS.highlights.set('session-find-all', new win.Highlight(...matches));
        win.CSS.highlights.set('session-find-current', new win.Highlight(current));
      }
      root._cardFollowController?.pause();
      const rect = current.getBoundingClientRect(), bounds = root.getBoundingClientRect();
      if (rect.top < bounds.top + 8 || rect.bottom > bounds.bottom - 8) root.scrollTop += rect.top - bounds.top - root.clientHeight * .4;
    }
    return { index: index + 1, total: matches.length };
  }
  return { clear, find };
}
module.exports = { collectTranscriptMatches, createTranscriptSearch };
