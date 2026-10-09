'use strict';

const fs = require('fs');
const path = require('path');
const { formatAbsoluteTime } = require('../core/beijing-time.js');

const MEMO_OPEN_KEY = 'claude-hub-memo-open';

function createMemoPanel(deps) {
  const {
    baseDir,
    clipboard,
    document,
    getActiveSessionId,
    getActiveTerminal,
    localStorage,
    scheduleRefit,
  } = deps;

  const memoFile = path.join(baseDir, '..', 'memo.json');

  function escapeMemoHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  function loadItems() {
    try { return JSON.parse(fs.readFileSync(memoFile, 'utf8')); } catch { return []; }
  }

  function saveItems(items) {
    try { fs.writeFileSync(memoFile, JSON.stringify(items, null, 2)); } catch {}
  }

  function formatMemoTime(ts) {
    return formatAbsoluteTime(ts);
  }

  function renderList() {
    const listEl = document.getElementById('memo-list');
    if (!listEl) return;
    const items = loadItems();
    if (!items.length) {
      listEl.innerHTML = '<div class="memo-empty">暂无备忘</div>';
      return;
    }
    listEl.innerHTML = items.map(item => `
    <div class="memo-item" data-id="${item.id}">
      <div class="memo-item-time">${formatMemoTime(item.ts)}</div>
      <div class="memo-item-body">
        <span class="memo-item-text">${escapeMemoHtml(item.text)}</span>
        <span class="memo-item-actions">
          <button class="memo-item-btn memo-copy-btn" title="复制">复制</button>
          <button class="memo-item-btn memo-del-btn" title="删除">删除</button>
        </span>
      </div>
    </div>
  `).join('');
  }

  function addItem(text) {
    const t = String(text || '').trim();
    if (!t) return false;
    const items = loadItems();
    items.unshift({ id: Date.now().toString(36), text: t, ts: Date.now() });
    saveItems(items);
    renderList();
    return true;
  }

  function deleteItem(id) {
    const items = loadItems().filter(i => i.id !== id);
    saveItems(items);
    renderList();
  }

  function clearAll() {
    saveItems([]);
    renderList();
  }

  function isOpen() {
    return localStorage.getItem(MEMO_OPEN_KEY) === 'true';
  }

  function syncToggleButtons(open) {
    document.querySelectorAll('.btn-memo-toggle').forEach(btn => {
      btn.classList.toggle('active', open);
      btn.setAttribute('aria-expanded', String(open));
    });
  }

  function refitActiveTerminal() {
    const active = getActiveTerminal && getActiveTerminal();
    if (active && active.opened) {
      const sessionId = getActiveSessionId && getActiveSessionId();
      setTimeout(() => scheduleRefit(sessionId, active, { force: true }), 50);
    }
  }

  function toggle() {
    const panel = document.getElementById('memo-panel');
    if (!panel) return;
    const open = panel.style.display === 'none';
    if (open) {
      const EventCtor = document.defaultView && document.defaultView.CustomEvent;
      if (typeof EventCtor === 'function') {
        document.dispatchEvent(new EventCtor('hub-side-panel-opening', { detail: { panel: 'memo' } }));
      }
    }
    panel.style.display = open ? 'flex' : 'none';
    localStorage.setItem(MEMO_OPEN_KEY, String(open));
    syncToggleButtons(open);
    if (open) renderList();
    refitActiveTerminal();
    if (!open) document.defaultView?.hubWorkspaces?.panelClosed('memo');
  }

  function open() {
    const panel = document.getElementById('memo-panel');
    if (!panel) return;
    panel.style.display = 'flex';
    localStorage.setItem(MEMO_OPEN_KEY, 'true');
    syncToggleButtons(true);
    renderList();
  }

  function close() {
    const panel = document.getElementById('memo-panel');
    if (!panel || panel.style.display === 'none') return false;
    panel.style.display = 'none';
    localStorage.setItem(MEMO_OPEN_KEY, 'false');
    syncToggleButtons(false);
    refitActiveTerminal();
    document.defaultView?.hubWorkspaces?.panelClosed('memo');
    return true;
  }

  function init() {
    const addBtn = document.getElementById('memo-add-btn');
    const input = document.getElementById('memo-input');
    const clearBtn = document.getElementById('memo-clear-btn');
    const listEl = document.getElementById('memo-list');
    if (!addBtn || !input || !clearBtn || !listEl) return;

    document.addEventListener('click', e => {
      if (e.target.closest && e.target.closest('[data-action="open-memo"]')) toggle();
    });
    document.addEventListener('hub-side-panel-opening', e => {
      if (e && e.detail && e.detail.panel !== 'memo') close();
    });

    input.addEventListener('keydown', e => e.stopPropagation());
    input.addEventListener('keypress', e => e.stopPropagation());
    input.addEventListener('keyup', e => e.stopPropagation());

    addBtn.addEventListener('click', () => {
      addItem(input.value);
      input.value = '';
      input.focus();
    });

    input.addEventListener('keydown', e => {
      if (e.isComposing || e.keyCode === 229) return;
      if (e.key === 'Enter') {
        e.preventDefault();
        addItem(input.value);
        input.value = '';
      }
    });

    clearBtn.addEventListener('click', () => toggle());

    listEl.addEventListener('click', e => {
      const copyBtn = e.target.closest('.memo-copy-btn');
      if (copyBtn) {
        const item = copyBtn.closest('.memo-item');
        const text = item.querySelector('.memo-item-text').textContent;
        clipboard.writeText(text);
        copyBtn.textContent = '✓';
        setTimeout(() => { copyBtn.textContent = '复制'; }, 1200);
        return;
      }
      const delBtn = e.target.closest('.memo-del-btn');
      if (delBtn) {
        const item = delBtn.closest('.memo-item');
        deleteItem(item.dataset.id);
      }
    });

    if (isOpen()) {
      const panel = document.getElementById('memo-panel');
      if (panel) {
        panel.style.display = 'flex';
        renderList();
        syncToggleButtons(true);
      }
    }
  }

  return {
    open,
    addItem,
    clearAll,
    close,
    deleteItem,
    init,
    isOpen,
    loadItems,
    renderList,
    saveItems,
    toggle,
  };
}

module.exports = {
  MEMO_OPEN_KEY,
  createMemoPanel,
};
