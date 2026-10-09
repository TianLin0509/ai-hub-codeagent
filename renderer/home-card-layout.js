'use strict';

/**
 * 工作台卡片布局：折叠 / 拖拽排序 / 空卡自动收成一行。
 *
 * 2026-08-27 起工作台是**单栏卡片流**（见 index.html 的 #home-card-stack）。
 * 每张卡带 `data-home-card="<id>"`，这个模块负责三件事：
 *
 *   1. 折叠 —— 点标题行收起／展开，只留标题；状态记住。
 *   2. 排序 —— 从标题行左侧的把手拖动换位；顺序记住。
 *   3. 空卡 —— 卡片内容为空时自动收成一行（打 data-home-empty），
 *      不再让长期为空的卡占着整块地方。这条是**自动的**，不写进用户偏好，
 *      因为它描述的是数据状态而不是意图。
 *
 * 折叠按钮和把手都是 JS 注入的，不写死在 HTML 里：加一张新卡只要在
 * index.html 里给 section 加上 data-home-card，这里自动接管。
 *
 * 偏好存 localStorage 而不是 config.json：这是纯观感偏好，且需要同步读取，
 * 和主题（core/theme-config.js）一个理由。
 */

const STORAGE_KEY = 'hub.homeCards';

function readPrefs(store) {
  if (!store || typeof store.getItem !== 'function') return { order: [], collapsed: {} };
  try {
    const raw = JSON.parse(store.getItem(STORAGE_KEY) || '{}');
    return {
      order: Array.isArray(raw.order) ? raw.order.filter(x => typeof x === 'string') : [],
      collapsed: raw.collapsed && typeof raw.collapsed === 'object' ? raw.collapsed : {},
    };
  } catch {
    return { order: [], collapsed: {} };
  }
}

function writePrefs(store, prefs) {
  if (!store || typeof store.setItem !== 'function') return;
  try {
    store.setItem(STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    // 存不下只影响下次启动的排布，不该拦住这次操作。
  }
}

/** 卡片正文（除标题行以外的部分）是不是没东西了。 */
function isCardEmpty(card) {
  for (const child of card.children) {
    if (child.classList && child.classList.contains('home-section-head')) continue;
    const text = (child.textContent || '').trim();
    if (text) return false;
    // 没有文字但画了图形（进度条之类）也算有内容
    if (child.querySelector && child.querySelector('svg, canvas, img, input, select')) return false;
  }
  return true;
}

function createHomeCardLayout({ document, localStorage } = {}) {
  if (!document) throw new Error('document is required');
  const store = localStorage || null;
  let prefs = readPrefs(store);

  const stack = () => document.getElementById('home-card-stack');
  const cards = () => Array.from(document.querySelectorAll('[data-home-card]'));
  const idOf = (card) => card.getAttribute('data-home-card');

  function persist() {
    prefs.order = cards().map(idOf);
    writePrefs(store, prefs);
  }

  function applyCollapsed(card) {
    const collapsed = prefs.collapsed[idOf(card)] === true;
    card.setAttribute('data-home-collapsed', collapsed ? '1' : '0');
    const btn = card.querySelector('[data-home-collapse]');
    if (btn) {
      btn.setAttribute('aria-expanded', String(!collapsed));
      btn.setAttribute('title', collapsed ? '展开' : '收起');
    }
  }

  function toggle(card) {
    const id = idOf(card);
    prefs.collapsed[id] = !(prefs.collapsed[id] === true);
    applyCollapsed(card);
    writePrefs(store, prefs);
  }

  function decorate(card) {
    const head = card.querySelector('.home-section-head');
    if (!head || head.querySelector('[data-home-collapse]')) return;

    const handle = document.createElement('span');
    handle.className = 'home-card-handle';
    handle.setAttribute('data-home-drag', '1');
    handle.setAttribute('title', '拖动换位置');
    handle.setAttribute('aria-hidden', 'true');
    handle.textContent = '⠿';

    const chevron = document.createElement('button');
    chevron.type = 'button';
    chevron.className = 'home-card-collapse';
    chevron.setAttribute('data-home-collapse', '1');
    chevron.setAttribute('aria-expanded', 'true');
    chevron.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"'
      + ' stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>';

    head.insertBefore(handle, head.firstChild);
    head.appendChild(chevron);

    // 拖拽只从把手发起，卡片里的文字才选得中。
    handle.addEventListener('mousedown', () => { card.draggable = true; });
    handle.addEventListener('mouseup', () => { card.draggable = false; });
    card.addEventListener('dragend', () => { card.draggable = false; card.classList.remove('dragging'); });
    card.addEventListener('dragstart', (e) => {
      card.classList.add('dragging');
      if (e.dataTransfer) {
        e.dataTransfer.effectAllowed = 'move';
        try { e.dataTransfer.setData('text/plain', idOf(card)); } catch { /* noop */ }
      }
    });

    chevron.addEventListener('click', (e) => { e.stopPropagation(); toggle(card); });
    head.addEventListener('click', (e) => {
      // 标题行里本来就有按钮（配置 / 全局搜索…），别把它们的点击也当成折叠。
      if (e.target && typeof e.target.closest === 'function'
          && e.target.closest('button, a, input, select, [data-home-action]')
          && !e.target.closest('[data-home-collapse]')) return;
      toggle(card);
    });
  }

  function afterCard(container, y) {
    const others = Array.from(container.querySelectorAll('[data-home-card]:not(.dragging)'));
    let best = null;
    let bestOffset = Number.NEGATIVE_INFINITY;
    for (const el of others) {
      const box = el.getBoundingClientRect();
      const offset = y - box.top - box.height / 2;
      if (offset < 0 && offset > bestOffset) { bestOffset = offset; best = el; }
    }
    return best;
  }

  function wireStack() {
    const host = stack();
    if (!host || host.dataset.homeLayoutWired === '1') return;
    host.dataset.homeLayoutWired = '1';
    host.addEventListener('dragover', (e) => {
      const dragging = host.querySelector('.dragging');
      if (!dragging) return;
      e.preventDefault();
      const target = afterCard(host, e.clientY);
      if (target) host.insertBefore(dragging, target);
      else host.appendChild(dragging);
    });
    host.addEventListener('drop', (e) => { e.preventDefault(); persist(); });
  }

  /** 每次工作台重绘后调一次：把空卡收成一行。 */
  function syncEmpty() {
    for (const card of cards()) {
      card.setAttribute('data-home-empty', isCardEmpty(card) ? '1' : '0');
    }
  }

  function restoreOrder() {
    const host = stack();
    if (!host || !prefs.order.length) return;
    const byId = new Map(cards().map(c => [idOf(c), c]));
    for (const id of prefs.order) {
      const card = byId.get(id);
      if (card) host.appendChild(card);
    }
  }

  function init() {
    wireStack();
    for (const card of cards()) { decorate(card); applyCollapsed(card); }
    restoreOrder();
    syncEmpty();
  }

  init();
  return { init, syncEmpty, toggle, persist, get prefs() { return prefs; } };
}

module.exports = { STORAGE_KEY, isCardEmpty, readPrefs, writePrefs, createHomeCardLayout };
