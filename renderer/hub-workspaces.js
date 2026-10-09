'use strict';

// Navigation and layout only. Existing controllers still own their data, actions,
// request epochs, and timers. Moving their DOM keeps event handlers and drafts.
function createHubWorkspaces({ document, window, memory, capabilities, memo, search, beforeOpen = () => {} }) {
  const root = document.createElement('section');
  root.id = 'hub-workspace';
  root.hidden = true;
  root.innerHTML = '<header class="hw-head"><div><h1></h1><p></p></div><button type="button" class="hw-button" data-hw-close>返回</button></header><nav class="hw-tabs" aria-label="工作空间分区"></nav><nav class="hw-context-tabs" aria-label="当前会话内容" hidden></nav><div class="hw-content"></div>';
  document.body.appendChild(root);
  const content = root.querySelector('.hw-content');
  let area = '', section = '', current = '', changing = false;
  const last = { resources: 'tools', review: 'memo' };
  const origins = new Map();
  const controllers = { memory, capabilities, memo, search };
  const paneIds = { memory: 'memory-page', capabilities: 'capability-page', memo: 'memo-panel', search: 'search-modal' };

  function mount(name) {
    const pane = document.getElementById(paneIds[name]);
    if (!pane) return;
    if (!origins.has(pane)) origins.set(pane, { parent: pane.parentNode, next: pane.nextSibling });
    content.appendChild(pane);
    pane.classList.add('hw-embedded');
    if (name === 'search') { pane.setAttribute('role', 'region'); pane.removeAttribute('aria-modal'); }
  }
  function unmount() {
    for (const [pane, origin] of origins) {
      pane.classList.remove('hw-embedded');
      origin.parent.insertBefore(pane, origin.next?.parentNode === origin.parent ? origin.next : null);
      if (pane.id === 'search-modal') { pane.setAttribute('role', 'dialog'); pane.setAttribute('aria-modal', 'true'); }
    }
    origins.clear();
  }
  function stopPane() {
    if (!current) return;
    const name = current;
    current = '';
    if (name === 'search') search.close({ restoreFocus: false });
    else controllers[name].close();
  }
  function paint() {
    const resource = area === 'resources';
    root.dataset.area = area;
    root.dataset.section = section;
    root.querySelector('h1').textContent = resource ? '资源' : '回顾';
    root.querySelector('.hw-head p').textContent = resource ? '工具、记忆，以及当前会话的使用证据。' : '记下当下，找回聊过的事。';
    root.setAttribute('aria-label', resource ? '资源' : '回顾');
    const options = resource ? [['tools', '工具'], ['memory', '记忆'], ['context', '当前会话']] : [['memo', '备忘'], ['history', '昨日之我']];
    root.querySelector('.hw-tabs').innerHTML = options.map(([key, name]) => `<button type="button" data-hw-tab="${key}" aria-pressed="${section === key}">${name}</button>`).join('');
    const secondary = root.querySelector('.hw-context-tabs');
    secondary.hidden = section !== 'context';
    secondary.innerHTML = [['memory', '上下文'], ['capabilities', '工具回执']].map(([key, name]) => `<button type="button" data-hw-context="${key}" aria-pressed="${current === key}">${name}</button>`).join('');
    for (const [id, active] of [['btn-rail-capabilities', resource], ['btn-rail-memo', !resource]]) {
      const button = document.getElementById(id);
      button?.classList.toggle('hw-active', active);
      button?.setAttribute('aria-expanded', String(active));
      if (active) button?.setAttribute('aria-current', 'page'); else button?.removeAttribute('aria-current');
    }
  }
  function open(nextArea, nextSection, options = {}) {
    if (!['resources', 'review'].includes(nextArea)) return;
    nextSection = nextSection || last[nextArea];
    const name = nextArea === 'review' ? (nextSection === 'memo' ? 'memo' : 'search')
      : nextSection === 'tools' ? 'capabilities' : nextSection === 'context' && options.runtime ? 'capabilities' : 'memory';
    // Do not tear down a page just because its selected rail entry is clicked.
    if (!root.hidden && area === nextArea && section === nextSection && current === name && !options.query && !options.scope) return;
    changing = true;
    try {
      beforeOpen();
      stopPane();
      // Close floating quick-note / standalone panels before docking.
      memo.close(); memory.close(); capabilities.close();
      area = nextArea; section = nextSection; last[area] = section;
      current = name;
      document.body.classList.add('hub-workspace-open');
      root.hidden = false;
      paint();
      let pending;
      if (name === 'memory') pending = memory.open({ tab: section === 'context' ? 'context' : undefined, preserve: true });
      else if (name === 'capabilities') pending = capabilities.open({ tab: section === 'context' ? 'runtime' : undefined });
      else if (name === 'search') search.open({ ...options, embedded: true });
      else memo.open();
      mount(name);
      // Each controller guards its own stale requests. Report genuine errors in
      // the existing feedback UI, without routing an old response to a new page.
      if (pending?.catch) pending.catch(error => require('./ui-feedback').showHubAlert(error.message || String(error)));
    } finally { changing = false; }
  }
  function close() {
    if (root.hidden || changing) return;
    changing = true;
    try {
      stopPane(); unmount(); root.hidden = true;
      document.body.classList.remove('hub-workspace-open');
      for (const id of ['btn-rail-capabilities', 'btn-rail-memo']) {
        const button = document.getElementById(id);
        button?.classList.remove('hw-active');
        button?.setAttribute('aria-expanded', 'false');
        button?.removeAttribute('aria-current');
      }
    } finally { changing = false; }
  }
  function panelClosed(name) { if (!changing && current === name && !root.hidden) close(); }
  root.addEventListener('click', event => {
    const button = event.target.closest('button');
    if (!button) return;
    if (button.hasAttribute('data-hw-close')) close();
    else if (button.dataset.hwTab) {
      const tab = button.dataset.hwTab;
      open(area, tab);
      root.querySelector(`[data-hw-tab="${tab}"]`)?.focus();
    } else if (button.dataset.hwContext) {
      const context = button.dataset.hwContext;
      open('resources', 'context', { runtime: context === 'capabilities' });
      root.querySelector(`[data-hw-context="${context}"]`)?.focus();
    }
  });
  // Capture only the two merged entries; leave all other rail behavior intact.
  document.addEventListener('click', event => {
    const button = event.target.closest('#scene-rail button');
    if (!button) return;
    if (button.id === 'btn-rail-capabilities' || button.id === 'btn-rail-memo' || button.id === 'btn-rail-memory') {
      event.preventDefault(); event.stopImmediatePropagation();
      const targetArea = button.id === 'btn-rail-memo' ? 'review' : 'resources';
      open(targetArea, button.id === 'btn-rail-memory' ? 'memory' : undefined);
    } else if (!['rail-pin', 'rail-edge-trigger', 'nav-edit-done'].includes(button.id)) close();
  }, true);
  document.addEventListener('keydown', event => {
    // Search owns Escape while reading history; dialogs and editors keep their
    // native key handling. Context/library controllers notify panelClosed.
    if (event.key === 'Escape' && !root.hidden && current === 'memo' && !document.querySelector('dialog[open], .hub-feedback-overlay')) close();
  });
  const position = () => {
    const top = document.getElementById('app-toolbar')?.getBoundingClientRect().bottom || 58;
    document.documentElement.style.setProperty('--hw-top', `${top}px`);
  };
  position(); window.addEventListener('resize', position);
  return { open, close, panelClosed, isOpen: () => !root.hidden };
}

module.exports = { createHubWorkspaces };
