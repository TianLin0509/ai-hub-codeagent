'use strict';
const INITIAL_CARDS = 8, PAGE_CARDS = 24;
function createCardHistoryPager({ document: doc, activeId, load }) {
  const states = new Map();
  const get = id => { if (!states.has(id)) states.set(id, { limit: INITIAL_CARDS, more: false, busy: false }); return states.get(id); };
  function render(id, container) {
    if (id !== activeId()) return;
    const state = get(id);
    let button = container.querySelector(':scope > .card-history-more');
    if (!state.more) { button?.remove(); return; }
    if (!button) {
      button = doc.createElement('button'); button.type = 'button'; button.className = 'card-history-more';
      button.addEventListener('click', () => { void more(id, container); });
      container.prepend(button);
    }
    button.disabled = state.busy;
    button.textContent = state.busy ? '正在读取更早对话…' : '↑ 加载更早对话';
  }
  async function more(id, container) {
    const state = get(id);
    if (!state.more || state.busy || id !== activeId()) return;
    state.busy = true; render(id, container);
    try { await load(id, { incremental: true, older: true }); }
    catch (error) { console.warn('[card-history] older page failed:', error); }
    finally { state.busy = false; render(id, container); }
  }
  function bind(container) {
    container.addEventListener('wheel', event => {
      if (event.deltaY < 0 && !event.ctrlKey && !event.metaKey && container.scrollTop < 100
          && !event.target.closest?.('pre,textarea,input,[contenteditable="true"]')) void more(activeId(), container);
    }, { passive: true });
  }
  return { get, render, bind, reset(id) { states.delete(id); }, INITIAL_CARDS, PAGE_CARDS };
}
module.exports = { createCardHistoryPager, INITIAL_CARDS, PAGE_CARDS };
