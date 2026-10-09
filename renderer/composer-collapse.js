'use strict';

// Hide the mounted controls in place. Their draft, selections and send owner
// remain unchanged; the state belongs to this mounted composer, not localStorage.
function mountComposerCollapse({ document, host, before, input, onResize = () => {} }) {
  if (!host || !before || host.querySelector('.composer-collapse')) return;
  const collapse = document.createElement('button');
  collapse.type = 'button';
  collapse.className = 'composer-collapse';
  collapse.title = '收起输入框，腾出阅读空间';
  collapse.setAttribute('aria-label', '收起输入框');
  const collapsed = host.classList.contains('composer-is-collapsed');
  collapse.setAttribute('aria-expanded', String(!collapsed));
  collapse.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m7 10 5 5 5-5M5 19h14"/></svg>';
  const expand = document.createElement('button');
  expand.type = 'button';
  expand.className = 'composer-expand';
  expand.textContent = '展开输入框';
  expand.setAttribute('aria-expanded', 'false');
  expand.hidden = !collapsed;
  if (host.id === 'mr-input-row' && before.parentNode === host) {
    const actions = document.createElement('div');
    actions.className = 'mr-send-actions';
    host.insertBefore(actions, before);
    actions.append(before);
  }
  before.parentNode.insertBefore(collapse, before);
  host.append(expand);
  function setCollapsed(value) {
    host.classList.toggle('composer-is-collapsed', value);
    expand.hidden = !value;
    collapse.setAttribute('aria-expanded', String(!value));
    if (value) expand.focus({ preventScroll: true });
    else input?.focus({ preventScroll: true });
    onResize();
  }
  collapse.addEventListener('click', event => { event.preventDefault(); event.stopPropagation(); setCollapsed(true); });
  expand.addEventListener('click', event => { event.preventDefault(); event.stopPropagation(); setCollapsed(false); });
  return { expand: () => setCollapsed(false) };
}

module.exports = { mountComposerCollapse };
