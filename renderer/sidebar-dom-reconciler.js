'use strict';

// Only renderer-owned keyed nodes are reused. Their handlers use stable IDs;
// the sidebar's delegated navigation continues reading current session data.
function syncAttributes(target, source) {
  for (const attr of [...target.attributes]) {
    if (!source.hasAttribute(attr.name)) target.removeAttribute(attr.name);
  }
  for (const attr of [...source.attributes]) {
    if (target.getAttribute(attr.name) !== attr.value) target.setAttribute(attr.name, attr.value);
  }
}
function reconcileSidebarDom(parent, fresh) {
  if (!parent.children || !parent.insertBefore) {
    parent.replaceChildren(fresh);
    return;
  }
  const previous = new Map([...parent.children]
    .filter(n => n.dataset.sidebarRenderKey)
    .map(n => [n.dataset.sidebarRenderKey, n]));
  const keep = new Set();
  let cursor = parent.firstElementChild;
  for (const next of [...fresh.children]) {
    const old = previous.get(next.dataset.sidebarRenderKey);
    let node = next;
    if (old && old.tagName === next.tagName) {
      node = old;
      syncAttributes(old, next);
      if (next.dataset.sidebarRenderTree === 'true') reconcileSidebarDom(old, next);
      else if (old.innerHTML !== next.innerHTML) old.innerHTML = next.innerHTML;
    }
    keep.add(node);
    if (node !== cursor) parent.insertBefore(node, cursor);
    cursor = node.nextElementSibling;
  }
  for (const node of [...parent.childNodes]) {
    if (!keep.has(node)) node.remove();
  }
}
module.exports = { reconcileSidebarDom };
