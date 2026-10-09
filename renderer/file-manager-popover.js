'use strict';

// 文件管理头部的锚定弹出菜单：同一时间只开一个，点外部 / Esc 关闭，↑↓ 在可聚焦项间移动。

function createPopover({ document: d, window: w, anchor, className, label, build, onClose }) {
  let box = null;

  function focusables() {
    return box ? [...box.querySelectorAll('button:not(:disabled), input:not(:disabled)')] : [];
  }
  function place() {
    if (!box || !anchor.isConnected) return;
    const rect = anchor.getBoundingClientRect();
    const width = box.offsetWidth;
    const left = className.includes('fm-popover-end') ? rect.right - width : rect.left;
    box.style.left = `${Math.max(6, Math.min(left, w.innerWidth - width - 6))}px`;
    box.style.top = `${Math.min(rect.bottom + 4, Math.max(6, w.innerHeight - box.offsetHeight - 6))}px`;
  }
  function onPointer(event) {
    if (box && !box.contains(event.target) && !anchor.contains(event.target)) close();
  }
  function onKey(event) {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); anchor.focus(); return; }
    if (event.target.matches('input')) { event.stopPropagation(); return; }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const list = focusables();
      const index = list.indexOf(d.activeElement);
      list[(index + (event.key === 'ArrowDown' ? 1 : list.length - 1)) % list.length]?.focus();
    }
  }
  function render() {
    if (!box) return;
    box.replaceChildren();
    build(box, { close, render });
    place();
  }
  function open() {
    if (box) return;
    box = d.createElement('div');
    box.className = `fm-popover ${className}`;
    box.setAttribute('role', 'menu');
    box.setAttribute('aria-label', label);
    d.body.append(box);
    anchor.setAttribute('aria-expanded', 'true');
    box.addEventListener('keydown', onKey);
    d.addEventListener('pointerdown', onPointer, true);
    render();
    (box.querySelector('[aria-checked="true"], button:not(:disabled)') || box).focus?.();
  }
  function close() {
    if (!box) return;
    d.removeEventListener('pointerdown', onPointer, true);
    box.remove();
    box = null;
    anchor.setAttribute('aria-expanded', 'false');
    if (onClose) onClose();
  }
  return {
    open,
    close,
    render,
    toggle: () => (box ? close() : open()),
    isOpen: () => !!box,
  };
}

// 菜单里的一行分组标题与按钮。
function menuSection(d, parent, title) {
  const section = d.createElement('div');
  section.className = 'fm-popover-section';
  if (title) {
    const heading = d.createElement('div');
    heading.className = 'fm-popover-heading';
    heading.textContent = title;
    section.append(heading);
  }
  parent.append(section);
  return section;
}

function menuButton(d, parent, text, action, options = {}) {
  const button = d.createElement('button');
  button.type = 'button';
  button.className = options.className || 'fm-popover-item';
  button.setAttribute('role', options.role || 'menuitem');
  if (options.checked !== undefined) button.setAttribute('aria-checked', String(!!options.checked));
  if (options.title) button.title = options.title;
  if (options.disabled) button.disabled = true;
  for (const [key, value] of Object.entries(options.data || {})) button.dataset[key] = value;
  button.textContent = text;
  button.addEventListener('click', action);
  parent.append(button);
  return button;
}

module.exports = { createPopover, menuButton, menuSection };
