'use strict';

// Whether a main-area panel is on screen, without forcing a style recalc when
// nothing that decides it has changed.
//
// The toolbar, backstage button and split view ask this for ten panels several
// times per session switch, each time after other DOM writes, so every round
// forced a fresh style recalc and layout (~5 per switch, 20–40 ms on a 4× slower
// CPU; 2026-10-14). A panel's display is decided by its own and its ancestors'
// attributes (hidden, class, inline style, data-*), the stylesheets and the
// viewport size; the answer is reused while all of those read the same. Reading
// attributes does not touch layout. Hub stylesheets all live in <head>; the
// terminals' own <style> tags in <body> come and go on every switch and only
// style their terminal, so they are left out of the key.
function createPanelVisibility({ win = globalThis.window, env = globalThis.process?.env || {} } = {}) {
  const memo = new WeakMap();
  const disabled = env.HUB_DISABLE_PANEL_VISIBILITY_MEMO === '1';

  function measure(el) {
    return el.offsetParent !== null || el.getBoundingClientRect().height > 0;
  }

  function stateKey(el) {
    // An empty fixed panel measures 0 px tall; its first child changes that.
    let key = `${win?.innerWidth}x${win?.innerHeight}|${el.ownerDocument?.head?.childElementCount}|${el.childElementCount}`;
    for (let node = el; node; node = node.parentElement) {
      key += '\n' + node.tagName;
      const attrs = node.attributes;
      for (let i = 0; i < attrs.length; i++) key += ' ' + attrs[i].name + '=' + attrs[i].value;
    }
    return key;
  }

  function panelIsVisible(el) {
    if (!el) return false;
    if (el.hidden) return false;
    if (el.style && el.style.display === 'none') return false;
    if (disabled) return measure(el);
    const key = stateKey(el);
    const known = memo.get(el);
    if (known && known.key === key) return known.visible;
    const visible = measure(el);
    memo.set(el, { key, visible });
    return visible;
  }

  // Tests compare the remembered answer with a fresh measurement.
  panelIsVisible.measure = el => !!el && !el.hidden && !(el.style && el.style.display === 'none') && measure(el);
  return panelIsVisible;
}

module.exports = { createPanelVisibility };
