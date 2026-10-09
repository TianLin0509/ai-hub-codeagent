'use strict';

// Ordinary and group composers share the same remaining/used presentation.
// The ring continues to show usage; its adjacent number shows the space left.
function createComposerContext(document) {
  const element = document.createElement('span');
  element.className = 'composer-context-budget';
  element.hidden = true;
  const value = document.createElement('span');
  value.className = 'composer-context-value';
  const ring = document.createElement('span');
  ring.className = 'composer-ctx';
  ring.setAttribute('aria-hidden', 'true');
  ring.appendChild(document.createElement('i'));
  element.append(value, ring);
  return {
    element,
    update(context, label = '') {
      element.hidden = !context?.visible || !Number.isFinite(context.percent);
      if (element.hidden) {
        value.textContent = '';
        element.removeAttribute('title');
        element.removeAttribute('aria-label');
        return;
      }
      const remaining = 100 - context.percent;
      value.textContent = `${remaining}%`;
      ring.dataset.level = context.level;
      ring.style.setProperty('--composer-ctx-pct', `${context.percent}%`);
      element.title = `${label ? label + ' · ' : ''}上下文剩余 ${remaining}%；${context.title}`;
      element.setAttribute('aria-label', `${label ? label + '，' : ''}上下文剩余 ${remaining}%`);
    },
  };
}

module.exports = { createComposerContext };
