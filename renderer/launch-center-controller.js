'use strict';

const LAUNCH_INTENTS = Object.freeze(['session', 'group', 'resume']);
const INTENT_COPY = Object.freeze({
  session: '选择 AI、模型与工作目录',
  group: '直接配置模板、成员与工作目录',
  resume: '按提供方恢复原生历史会话',
});

function normalizeLaunchIntent(value) {
  return LAUNCH_INTENTS.includes(value) ? value : 'session';
}

function createLaunchCenterController({
  document,
  ipcRenderer,
  openSessionModal,
  closeSessionModal,
  prepareGroupPanel,
  closeGroupPanel,
  resumeSession,
}) {
  if (!document) throw new Error('launch center requires document');
  const menuEl = document.getElementById('new-session-menu');
  const triggerEl = document.getElementById('btn-new');
  const moreEl = document.getElementById('btn-new-more');
  const subtitleEl = document.getElementById('launch-center-subtitle');
  const errorEl = document.getElementById('launch-center-error');
  const groupErrorEl = document.getElementById('launch-center-group-error');
  const resumeCancelButton = document.getElementById('launch-center-resume-cancel');
  const intentButtons = [...document.querySelectorAll('[data-launch-intent]')];
  const panels = [...document.querySelectorAll('[data-launch-panel]')];
  const resumeButtons = [...document.querySelectorAll('[data-resume-kind]')];
  let activeIntent = 'session';
  let groupPrepared = false;
  let returnFocus = null;

  function initializeTrigger() {
    const label = triggerEl && triggerEl.querySelector('.btn-label');
    if (label) label.textContent = '启动';
    if (triggerEl) {
      triggerEl.title = '打开启动中心 (Ctrl+N)';
      triggerEl.setAttribute('aria-haspopup', 'dialog');
      triggerEl.setAttribute('aria-expanded', menuEl && menuEl.style.display !== 'none' ? 'true' : 'false');
    }
  }

  function setOpenState(open) {
    if (moreEl) moreEl.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (triggerEl && triggerEl.getAttribute('aria-haspopup')) triggerEl.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (!open && returnFocus && returnFocus.isConnected && typeof returnFocus.focus === 'function') {
      returnFocus.focus({ preventScroll: true });
      returnFocus = null;
    }
  }

  function clearErrors() {
    for (const element of [errorEl, groupErrorEl]) {
      if (!element) continue;
      element.textContent = '';
      element.hidden = true;
    }
  }

  function setError(message = '', intent = activeIntent) {
    const target = intent === 'group' ? groupErrorEl : errorEl;
    if (!target) return;
    target.textContent = message;
    target.hidden = !message;
  }

  function selectIntent(value, { focus = true } = {}) {
    activeIntent = normalizeLaunchIntent(value);
    clearErrors();
    for (const button of intentButtons) {
      const selected = button.dataset.launchIntent === activeIntent;
      button.classList.toggle('active', selected);
      button.setAttribute('aria-selected', selected ? 'true' : 'false');
      button.tabIndex = selected ? 0 : -1;
    }
    for (const panel of panels) {
      panel.hidden = panel.dataset.launchPanel !== activeIntent;
    }
    if (subtitleEl) subtitleEl.textContent = INTENT_COPY[activeIntent];
    if (activeIntent === 'group' && !groupPrepared && typeof prepareGroupPanel === 'function') {
      try {
        prepareGroupPanel();
        groupPrepared = true;
      } catch (error) {
        setError(`群聊配置加载失败：${error && error.message ? error.message : String(error)}`, 'group');
      }
    }
    if (focus) {
      const selectedButton = intentButtons.find(button => button.dataset.launchIntent === activeIntent);
      if (selectedButton) selectedButton.focus({ preventScroll: true });
    }
    return activeIntent;
  }

  function open(intent = 'session', options = {}) {
    const wasClosed = !menuEl || menuEl.style.display === 'none';
    if (wasClosed) {
      const active = document.activeElement;
      const activeInside = menuEl && active && typeof menuEl.contains === 'function' && menuEl.contains(active);
      returnFocus = activeInside ? triggerEl : active;
      if (groupPrepared && typeof closeGroupPanel === 'function') closeGroupPanel();
      groupPrepared = false;
    }
    if (typeof openSessionModal === 'function') openSessionModal(options);
    setOpenState(true);
    selectIntent(intent, { focus: intent !== 'session' });
  }

  function close() {
    clearErrors();
    if (groupPrepared && typeof closeGroupPanel === 'function') closeGroupPanel();
    groupPrepared = false;
    if (typeof closeSessionModal === 'function') closeSessionModal();
    else if (menuEl) menuEl.style.display = 'none';
    setOpenState(false);
  }

  function toggle() {
    if (menuEl && menuEl.style.display !== 'none') close();
    else open('session');
  }

  for (const button of intentButtons) {
    button.addEventListener('click', () => selectIntent(button.dataset.launchIntent));
    button.addEventListener('keydown', event => {
      if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const current = intentButtons.indexOf(button);
      let next = current;
      if (event.key === 'Home') next = 0;
      else if (event.key === 'End') next = intentButtons.length - 1;
      else next = (current + (event.key === 'ArrowDown' ? 1 : -1) + intentButtons.length) % intentButtons.length;
      selectIntent(intentButtons[next].dataset.launchIntent);
    });
  }

  if (resumeCancelButton) resumeCancelButton.addEventListener('click', close);

  for (const button of resumeButtons) {
    button.addEventListener('click', async () => {
      const kind = button.dataset.resumeKind;
      if (!kind || typeof resumeSession !== 'function') return;
      button.disabled = true;
      button.setAttribute('aria-busy', 'true');
      clearErrors();
      try {
        close();
        await resumeSession(kind);
      } catch (error) {
        open('resume');
        setError(`恢复失败：${error && error.message ? error.message : String(error)}`);
      } finally {
        button.disabled = false;
        button.removeAttribute('aria-busy');
      }
    });
  }

  const view = document.defaultView;
  if (view && typeof view.addEventListener === 'function') {
    view.addEventListener('launch-center:session-opened', () => {
      setOpenState(true);
      selectIntent('session', { focus: false });
    });
    view.addEventListener('launch-center:closed', () => {
      if (groupPrepared && typeof closeGroupPanel === 'function') closeGroupPanel();
      groupPrepared = false;
      clearErrors();
      setOpenState(false);
    });
  }

  if (menuEl) {
    menuEl.addEventListener('keydown', event => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        close();
        return;
      }
      if (event.key !== 'Tab') return;
      const focusable = [...menuEl.querySelectorAll('button:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex="-1"])')]
        .filter(node => !node.hidden && node.getClientRects().length > 0);
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    });
  }

  selectIntent('session', { focus: false });
  ipcRenderer?.on('launch-auth-status',(_event,result)=>{
    if (result?.message && menuEl.style.display!=='none') {
      const target=activeIntent==='session' ? document.getElementById('new-session-error') : activeIntent==='group' ? groupErrorEl : errorEl;
      if (target) {target.textContent=result.message;target.hidden=false;target.scrollIntoView?.({block:'nearest'});}
    }
  });
  initializeTrigger();
  return {
    close,
    getActiveIntent: () => activeIntent,
    open,
    selectIntent,
    toggle,
  };
}

module.exports = {
  INTENT_COPY,
  LAUNCH_INTENTS,
  createLaunchCenterController,
  normalizeLaunchIntent,
};
