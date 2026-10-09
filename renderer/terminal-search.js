'use strict';

const SEARCH_OPTS = {
  decorations: {
    matchBackground: '#58a6ff66',
    matchBorder: '#58a6ff',
    matchOverviewRuler: '#58a6ff',
    activeMatchBackground: '#f0883e88',
    activeMatchBorder: '#f0883e',
    activeMatchColorOverviewRuler: '#f0883e',
  },
};

function createTerminalSearch(deps) {
  const {
    document,
    getActiveSessionId,
    getTerminalCache,
    getTranscriptRoot = () => null,
  } = deps;
  const transcript = require('./transcript-search').createTranscriptSearch(document);

  const el = document.getElementById('terminal-search');
  const input = document.getElementById('terminal-search-input');
  const count = document.getElementById('terminal-search-count');
  const prev = document.getElementById('terminal-search-prev');
  const next = document.getElementById('terminal-search-next');
  const closeBtn = document.getElementById('terminal-search-close');

  function getCached() {
    const cache = getTerminalCache();
    return cache && cache.get(getActiveSessionId());
  }

  function open() {
    if (!el || !input) return;
    el.style.display = 'flex';
    input.placeholder = getTranscriptRoot() ? '查找当前已加载的对话…' : '查找终端…';
    input.focus();
    input.select();
    run(1, false);
  }

  function close() {
    if (!el) return;
    el.style.display = 'none';
    transcript.clear();
    const cached = getCached();
    if (cached && cached.searchAddon) cached.searchAddon.clearDecorations();
    if (cached && !getTranscriptRoot()) cached.terminal.focus();
  }

  function run(direction, advance = true) {
    if (!input || !count) return;
    const root = getTranscriptRoot();
    if (root) {
      const result = transcript.find(root, input.value, direction, advance);
      count.textContent = input.value ? `${result.index} / ${result.total}` : '';
      return;
    }
    transcript.clear();
    const cached = getCached();
    if (!cached || !cached.searchAddon || !input || !count) return;
    const q = input.value;
    if (!q) {
      cached.searchAddon.clearDecorations();
      count.textContent = '';
      return;
    }
    const found = direction >= 0
      ? cached.searchAddon.findNext(q, SEARCH_OPTS)
      : cached.searchAddon.findPrevious(q, SEARCH_OPTS);
    count.textContent = found ? '' : 'no match';
  }

  function init() {
    if (!el || !input || !count || !prev || !next || !closeBtn) return;
    input.addEventListener('input', () => run(1, false));
    input.addEventListener('keydown', (e) => {
      if (e.isComposing || e.keyCode === 229) return;
      if (e.key === 'Enter') { e.preventDefault(); run(e.shiftKey ? -1 : 1); }
      else if (e.key === 'Escape') { e.preventDefault(); close(); }
    });
    prev.addEventListener('click', () => run(-1));
    next.addEventListener('click', () => run(1));
    closeBtn.addEventListener('click', close);
  }

  return {
    close,
    init,
    open,
    run,
  };
}

module.exports = {
  SEARCH_OPTS,
  createTerminalSearch,
};
