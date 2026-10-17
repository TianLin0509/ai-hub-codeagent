'use strict';

// One persistent menu keeps display controls reachable from sessions and views.
function initToolbarMore({ document, zoom }) {
  const button = document.getElementById('btn-toolbar-more');
  const menu = document.getElementById('toolbar-more-menu');
  const actions = document.getElementById('toolbar-more-actions');
  const notification = () => document.getElementById('completion-notification-toggle');
  const close = () => { menu.hidden = true; button.setAttribute('aria-expanded', 'false'); };
  function item(label, key, run) {
    const control = document.createElement('button');
    control.type = 'button';
    const text = document.createElement('span'); text.textContent = label;
    const hint = document.createElement('span'); hint.className = 'ho-key'; hint.textContent = key;
    control.append(text, hint);
    control.addEventListener('click', run);
    actions.appendChild(control);
    return { control, hint };
  }
  item('放大界面', 'A+', () => zoom(1));
  item('缩小界面', 'A−', () => zoom(-1));
  item('重置缩放', '1:1', () => zoom(0));
  const notify = item('完成通知', '', () => notification()?.click());
  notify.control.className = 'ho-notify';
  notify.control.setAttribute('role', 'menuitemcheckbox');
  function syncNotification() {
    const toggle = notification();
    const state = toggle ? toggle.dataset.state || 'unconfigured' : 'unavailable';
    notify.control.dataset.state = state;
    notify.control.setAttribute('aria-checked', String(state === 'enabled'));
    notify.hint.textContent = state === 'enabled' ? '开' : state === 'disabled' ? '关' : state === 'unavailable' ? '不可用' : '未配';
    notify.control.title = toggle?.title || '';
  }
  button.addEventListener('click', event => {
    event.stopPropagation();
    menu.hidden = !menu.hidden;
    button.setAttribute('aria-expanded', String(!menu.hidden));
    if (!menu.hidden) syncNotification();
  });
  menu.addEventListener('click', event => { if (event.target.closest('button')) close(); });
  document.addEventListener('click', event => { if (!menu.contains(event.target)) close(); });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !menu.hidden) { close(); button.focus(); }
  });
}

module.exports = { initToolbarMore };
