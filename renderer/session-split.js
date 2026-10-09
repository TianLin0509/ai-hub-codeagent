'use strict';

// Layout owns visibility and focus only. SessionManager remains the sole owner
// of native writers, persistence and prompt submission.
function createSessionSplit({ document: doc, window: win, primary, buttons, services: s }) {
  const workspace = doc.createElement('div');
  workspace.className = 'session-workspace';
  primary.before(workspace);
  const left = doc.createElement('section'); left.className = 'session-pane session-pane-left';
  const right = doc.createElement('section'); right.className = 'session-pane session-pane-right';
  const divider = doc.createElement('div'); divider.className = 'session-pane-divider';
  divider.tabIndex = 0; divider.setAttribute('role', 'separator');
  divider.setAttribute('aria-label', '调整左右会话宽度'); divider.setAttribute('aria-orientation', 'vertical');
  const rightPanel = doc.createElement('div');
  rightPanel.className = 'terminal-panel split-secondary card-view-active';
  rightPanel.dataset.splitSecondary = 'true';
  workspace.append(left, divider, right); left.append(primary); right.append(rightPanel);
  let enabled = false, focused = 'left', view = null, opening = null, intent = 0, ratio = 50;
  let previousPrimary = null;
  const pending = new Set();
  function header(side, host) {
    const h = doc.createElement('div'); h.className = 'session-pane-header';
    const label = doc.createElement('span'); label.className = 'session-pane-label'; label.textContent = side === 'left' ? '左屏' : '右屏';
    const select = doc.createElement('select'); select.setAttribute('aria-label', side === 'left' ? '左屏会话' : '右屏会话');
    select.addEventListener('change', () => {
      focus(side);
      if (!select.value) { if (side === 'right') clearRight(); sync(); return; }
      void route(select.value, side).catch(error => s.alert(error.message));
    });
    h.append(label, select); host.prepend(h);
    return select;
  }
  const leftSelect = header('left', left), rightSelect = header('right', right);
  function focus(side) {
    focused = side;
    left.classList.toggle('focused', side === 'left'); right.classList.toggle('focused', side === 'right');
    s.onFocus(focusedId());
  }
  for (const [side, element] of [['left', left], ['right', right]]) {
    element.addEventListener('pointerdown', () => { if (focused !== side) focus(side); }, true);
    element.addEventListener('focusin', () => { if (focused !== side) focus(side); });
  }
  // A fullscreen file preview temporarily hides the panes but still belongs
  // to the focused session. Home/group/other app pages have their own context.
  function isSecondaryFocused() { return enabled && focused === 'right' && !!view && !s.otherView() && !primary.classList.contains('home-active'); }
  function focusedId() { return isSecondaryFocused() ? view.sessionId : s.primaryId(); }
  function empty(message = '从上方选择会话，或点击左侧会话列表') {
    if (view) return;
    rightPanel.replaceChildren();
    const p = doc.createElement('div'); p.className = 'split-empty';
    const title = doc.createElement('strong'); title.textContent = '在右屏打开另一个会话';
    const detail = doc.createElement('p'); detail.textContent = message;
    p.append(title, detail); rightPanel.append(p);
  }
  function clearRight() {
    intent++; opening = null;
    view?.dispose(); view = null; empty();
  }
  function setRatio(value) {
    const width = workspace.clientWidth;
    const min = Math.min(45, 360 / Math.max(1, width) * 100);
    ratio = Math.max(min, Math.min(100 - min, value));
    workspace.style.setProperty('--split-left', ratio + '%');
    divider.setAttribute('aria-valuenow', String(Math.round(ratio)));
    divider.setAttribute('aria-valuemin', String(Math.ceil(min)));
    divider.setAttribute('aria-valuemax', String(Math.floor(100 - min)));
    s.resize(); view?.resize();
  }
  divider.addEventListener('keydown', e => {
    if (!['ArrowLeft', 'ArrowRight', 'Home'].includes(e.key)) return;
    e.preventDefault(); setRatio(e.key === 'Home' ? 50 : ratio + (e.key === 'ArrowLeft' ? -3 : 3));
  });
  divider.addEventListener('pointerdown', e => {
    e.preventDefault(); divider.focus(); divider.setPointerCapture(e.pointerId);
    const bounds = workspace.getBoundingClientRect();
    const move = e => setRatio((e.clientX - bounds.left) / bounds.width * 100);
    const end = () => { divider.removeEventListener('pointermove', move); divider.removeEventListener('pointerup', end); divider.removeEventListener('pointercancel', end); };
    divider.addEventListener('pointermove', move); divider.addEventListener('pointerup', end); divider.addEventListener('pointercancel', end);
  });
  function sync() {
    const active = s.primaryId();
    if (previousPrimary !== active) { previousPrimary = active; if (view?.sessionId === active) clearRight(); }
    const visible = enabled && !s.otherView() && !primary.classList.contains('home-active') && primary.style.display !== 'none';
    // These menus are hidden in single mode and other app views. Reconcile
    // synchronously when shown, so background status events do no menu work.
    if (visible) {
      const rows = s.sessions().filter(session => session.purpose !== 'xresearch-research');
      const label = session => `${session.title || session.kind || '会话'}${session.status === 'dormant' ? ' · 休眠' : ''}`;
      // Only displayed fields invalidate options: running/idle/completed do
      // not change this menu's text and must not rebuild every option.
      const signature = JSON.stringify(rows.map(v => [v.id, label(v)]));
      for (const [select, selected] of [[leftSelect, active], [rightSelect, opening || view?.sessionId]]) {
        if (select.dataset.signature !== signature) {
          select.dataset.signature = signature; select.replaceChildren();
          const emptyOption = doc.createElement('option'); emptyOption.value = ''; emptyOption.textContent = '选择会话…'; select.append(emptyOption);
          for (const session of rows) {
            const option = doc.createElement('option'); option.value = session.id;
            option.textContent = label(session); select.append(option);
          }
        }
        select.value = selected || '';
      }
    }
    workspace.classList.toggle('is-split', visible);
    // Other app views remain siblings of the workspace.
    workspace.hidden = primary.style.display === 'none';
    right.hidden = divider.hidden = !visible;
    buttons.hidden = !active || !!s.otherView();
    buttons.querySelector('[data-session-layout="single"]').setAttribute('aria-pressed', String(!enabled));
    buttons.querySelector('[data-session-layout="two"]').setAttribute('aria-pressed', String(enabled));
    view?.setVisible(visible); view?.updateStatus();
    left.classList.toggle('focused', focused === 'left'); right.classList.toggle('focused', focused === 'right');
  }
  async function setLayout(mode) {
    if (mode === 'two') {
      enabled = true; sync(); setRatio(ratio);
      if (!view) { empty(); focus('right'); }
      return;
    }
    const target = focused === 'right' ? view?.sessionId : null;
    enabled = false; focus('left');
    // Dispose the secondary composer before moving its session into the primary
    // surface, so drafts always have exactly one mounted editor.
    clearRight(); sync();
    if (target && target !== s.primaryId()) await s.selectPrimary(target, { splitBypass: true });
    s.resize();
  }
  async function route(id, side = focused, opts = {}) {
    if (!enabled || side === 'left') {
      if (enabled && view?.sessionId === id) { focus('right'); view.focus(); return; }
      focus('left'); await s.selectPrimary(id, { ...opts, splitBypass: true }); sync(); return;
    }
    if (id === s.primaryId()) { focus('left'); s.focusPrimary(); sync(); return; }
    if (view?.sessionId === id) { intent++; opening = null; focus('right'); view.focus(); sync(); return; }
    const token = ++intent; opening = id; sync();
    try {
      const status = await s.openStatus(id);
      if (token !== intent) return;
      if (!status.available) throw new Error(status.message || '会话已被其他 Hub 占用');
      if (s.session(id)?.status === 'dormant') pending.add(id);
      try { await s.ensureOpen(id); } catch (error) { pending.delete(id); throw error; }
      if (token !== intent || !enabled) return;
      const session = s.session(id);
      if (!session || session.status === 'dormant') throw new Error('会话未能恢复，请重试');
      // Native aliases must not mount a second editor under another Hub card.
      if (id === s.primaryId() || s.sameIdentity(session, s.session(s.primaryId()))) { focus('left'); s.focusPrimary(); return; }
      view?.dispose(); view = null; rightPanel.replaceChildren();
      view = s.createView(id, rightPanel); focus('right'); view.focus();
    } catch (error) {
      if (token === intent) { if (!view) empty(error.message); s.alert(error.message); }
    } finally { if (token === intent) { opening = null; sync(); } }
  }
  buttons.addEventListener('click', e => {
    const button = e.target.closest('[data-session-layout]');
    if (button) void setLayout(button.dataset.sessionLayout).catch(error => s.alert(error.message));
  });
  const resize = new win.ResizeObserver(() => { if (enabled) setRatio(ratio); }); resize.observe(workspace);
  empty(); sync();
  return {
    sync, route, focusedId, setLayout,
    routesSelection: () => enabled && !s.otherView() && primary.style.display !== 'none',
    usePrimary: () => focus('left'),
    secondary: () => view,
    isSecondaryFocused,
    isPrimaryFocused: () => !enabled || focused === 'left' || !!s.otherView() || primary.classList.contains('home-active'),
    isVisible: id => enabled && view?.sessionId === id && !right.hidden,
    handlesCreated: id => pending.delete(id) || opening === id,
    closed(id) {
      if (view?.sessionId === id) { clearRight(); focus('left'); sync(); }
      else if (enabled && id === s.primaryId() && view) {
        // Let the existing close handler finish clearing its primary surface.
        win.queueMicrotask(() => {
          if (!view) return;
          focus('right'); void setLayout('single').catch(error => s.alert(error.message));
        });
      }
    },
  };
}

module.exports = { createSessionSplit };
