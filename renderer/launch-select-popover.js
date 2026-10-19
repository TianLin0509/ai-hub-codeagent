'use strict';
// 启动中心的下拉选项列表画在页面里（2026-10-19 用户公司真机 v2.1.15：选账号时选项框不在控件正下方，跑到窗口中间）。
//
// 原生 <select> 点开后的选项框是系统弹层，位置由 Chromium 按「窗口在屏幕上的位置 × 缩放比例」换算。公司电脑的窗口事件日志里，
// Hub 每次启动后窗口按 100% 缩放报尺寸（最大化 2578×1398），最小化再还原或显示设置变化后才按 125% 报（2064×1120）：
// 同一块屏幕两种比例，系统弹层就按错的比例算位置，偏到窗口中间。2.1.15 是更新后自动重启的，正好落在「启动后」这种状态。
// 启动中心的代码和样式从 2.1.8 起没改过，所以不是样式改坏的；这里让列表不再依赖系统弹层：
//   - 仍是同一个 <select>：取值、change 事件、关着时用方向键切换，都和原来一样，现有逻辑不用改；
//   - 鼠标点开（或 Alt+↓ / F4 / 空格 / 回车）时不弹系统选项框，改在控件正下方画一个列表（下方放不下才翻到上方）；
//   - 列表开着时：↑↓ / Home / End 移动，回车或空格选中，Esc / Tab / 点别处关闭（Esc 只关列表，不关启动中心）。
// 列表挂在 <body> 上、position: fixed，按控件的 getBoundingClientRect 定位，不受启动中心的居中位移影响。

const GAP = 4;
const MARGIN = 8;

function installSelectPopover({ document, window, root }) {
  if (!document || !window || !root || typeof root.addEventListener !== 'function') return null;
  let pop = null; // { select, el, items, active, observer }

  // 只接管下拉式的 <select>：多选、列表式（size > 1）本来就画在页面里，不动。
  const dropdown = select => !select.multiple && !(Number(select.size) > 1);

  function visibleOptions(select) {
    return [...select.options].filter(option => !option.hidden);
  }

  function place() {
    if (!pop) return;
    const rect = pop.select.getBoundingClientRect();
    const el = pop.el;
    el.style.minWidth = Math.round(rect.width) + 'px';
    el.style.maxHeight = '';
    const height = el.offsetHeight;
    const below = window.innerHeight - rect.bottom - GAP - MARGIN;
    const above = rect.top - GAP - MARGIN;
    const flip = height > below && above > below;
    const room = Math.max(120, flip ? above : below);
    if (height > room) el.style.maxHeight = room + 'px';
    const finalHeight = Math.min(height, room);
    const width = el.offsetWidth;
    const left = Math.max(MARGIN, Math.min(rect.left, window.innerWidth - width - MARGIN));
    el.style.left = Math.round(left) + 'px';
    el.style.top = Math.round(flip ? rect.top - GAP - finalHeight : rect.bottom + GAP) + 'px';
    el.dataset.placement = flip ? 'above' : 'below';
  }

  function paintActive() {
    if (!pop) return;
    pop.items.forEach((item, index) => item.classList.toggle('active', index === pop.active));
    const item = pop.items[pop.active];
    // 焦点一直在 <select> 上：高亮项的引用写在它身上，读屏才跟得上（审核 2026-10-19）
    if (item) {
      pop.select.setAttribute('aria-activedescendant', item.id);
      item.scrollIntoView({ block: 'nearest' });
    } else pop.select.removeAttribute('aria-activedescendant');
  }

  function build() {
    if (!pop) return;
    const { select, el } = pop;
    el.textContent = '';
    pop.items = [];
    const options = visibleOptions(select);
    options.forEach((option, index) => {
      const item = document.createElement('div');
      item.className = 'launch-select-option';
      item.id = `${el.id}-opt-${index}`;
      item.setAttribute('role', 'option');
      item.dataset.value = option.value;
      item.textContent = option.textContent;
      if (option.title) item.title = option.title;
      const selected = option.value === select.value;
      item.setAttribute('aria-selected', String(selected));
      if (selected) item.classList.add('selected');
      if (option.disabled) { item.setAttribute('aria-disabled', 'true'); item.classList.add('disabled'); }
      el.appendChild(item);
      pop.items.push(item);
    });
    const current = pop.items.findIndex(item => item.dataset.value === select.value);
    pop.active = current >= 0 ? current : pop.items.findIndex(item => !item.classList.contains('disabled'));
    paintActive();
    place();
  }

  function close({ refocus = false } = {}) {
    if (!pop) return;
    const { select, el, observer } = pop;
    pop = null;
    try { observer.disconnect(); } catch { /* 已断开 */ }
    el.remove();
    select.setAttribute('aria-expanded', 'false');
    select.removeAttribute('aria-activedescendant');
    if (refocus && select.isConnected) select.focus({ preventScroll: true });
  }

  function choose(index) {
    if (!pop) return;
    const item = pop.items[index];
    if (!item || item.classList.contains('disabled')) return;
    const { select } = pop;
    if (select.disabled) { close(); return; } // 列表开着时控件被禁用（比如正在创建会话）：不改值
    const value = item.dataset.value;
    close({ refocus: true });
    if (select.value === value) return;
    select.value = value;
    select.dispatchEvent(new window.Event('input', { bubbles: true }));
    select.dispatchEvent(new window.Event('change', { bubbles: true }));
  }

  function open(select) {
    close();
    const el = document.createElement('div');
    el.className = 'launch-select-popover';
    el.id = `launch-select-popover-${select.id || 'select'}`;
    el.setAttribute('role', 'listbox');
    el.dataset.for = select.id || '';
    const label = select.closest('label')?.querySelector('span')?.textContent || select.getAttribute('aria-label') || '';
    if (label) el.setAttribute('aria-label', label);
    el.style.position = 'fixed';
    el.style.left = '0px';
    el.style.top = '0px';
    document.body.appendChild(el);
    // 选项是异步填进来的（模型清单、号池账号）：列表开着时选项变了就重画。
    // 控件被禁用时收起列表。
    const observer = new window.MutationObserver(() => { if (!pop || pop.select !== select) return; if (select.disabled) close(); else build(); });
    observer.observe(select, { childList: true, subtree: true, attributes: true, attributeFilter: ['disabled', 'hidden', 'label'] });
    pop = { select, el, items: [], active: -1, observer, typed: '', typedAt: 0 };
    select.setAttribute('aria-expanded', 'true');
    select.setAttribute('aria-controls', el.id);
    build();
  }

  function move(delta) {
    if (!pop || !pop.items.length) return;
    let index = pop.active;
    for (let step = 0; step < pop.items.length; step += 1) {
      index = Math.max(0, Math.min(pop.items.length - 1, index + delta));
      if (!pop.items[index].classList.contains('disabled')) break;
      if (index === 0 || index === pop.items.length - 1) break;
    }
    if (!pop.items[index].classList.contains('disabled')) pop.active = index;
    paintActive();
  }

  // 按字母找项（同原生下拉）：只移动高亮，不改值，回车或点击才算选中（审核 2026-10-19）。
  // 0.8 秒内连续敲的字拼起来找；只敲一个字时从当前高亮的下一项开始找，重复敲同一个字母依次跳过同首字母的项。
  function typeahead(ch) {
    if (!pop || !pop.items.length) return;
    const now = Date.now();
    pop.typed = now - pop.typedAt > 800 ? ch : pop.typed + ch;
    pop.typedAt = now;
    const want = pop.typed.toLowerCase();
    const repeat = want.length > 1 && [...want].every(c => c === want[0]);
    const prefix = repeat ? want[0] : want;
    const start = want.length === 1 || repeat ? pop.active + 1 : Math.max(0, pop.active);
    for (let step = 0; step < pop.items.length; step += 1) {
      const index = (start + step) % pop.items.length;
      const item = pop.items[index];
      if (item.classList.contains('disabled')) continue;
      if (item.textContent.trim().toLowerCase().startsWith(prefix)) { pop.active = index; paintActive(); return; }
    }
  }

  root.addEventListener('mousedown', event => {
    const select = event.target && event.target.closest ? event.target.closest('select') : null;
    if (!select || !root.contains(select) || event.button !== 0 || !dropdown(select)) return;
    event.preventDefault(); // 不弹系统选项框
    if (select.disabled) return;
    select.focus({ preventScroll: true });
    if (pop && pop.select === select) close();
    else open(select);
  }, true);

  root.addEventListener('keydown', event => {
    const select = event.target && event.target.tagName === 'SELECT' ? event.target : null;
    if (pop && select === pop.select) {
      const keys = { ArrowDown: () => move(1), ArrowUp: () => move(-1), Home: () => { pop.active = 0; move(0); }, End: () => { pop.active = pop.items.length - 1; move(0); },
        Enter: () => choose(pop.active), ' ': () => choose(pop.active), Escape: () => close({ refocus: true }) };
      if (keys[event.key]) {
        event.preventDefault();
        event.stopPropagation(); // Esc 只关列表；回车不触发启动中心的其他按键
        keys[event.key]();
        return;
      }
      if (event.key === 'PageDown' || event.key === 'PageUp') { event.preventDefault(); event.stopPropagation(); move(event.key === 'PageDown' ? 5 : -5); return; }
      // 可打印字符：拦下（不让原生下拉按字母改值），只移动高亮
      if (event.key.length === 1 && !event.ctrlKey && !event.altKey && !event.metaKey) { event.preventDefault(); event.stopPropagation(); typeahead(event.key); return; }
      if (event.key === 'Tab') close();
      return;
    }
    if (!select || !root.contains(select) || select.disabled || !dropdown(select)) return;
    if (event.key === 'F4' || (event.altKey && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) || event.key === ' ' || event.key === 'Enter') {
      event.preventDefault();
      event.stopPropagation();
      open(select);
    }
  }, true);

  document.addEventListener('mousedown', event => {
    if (!pop) return;
    if (pop.el.contains(event.target)) {
      // 列表挂在 <body> 上、在启动中心外面：拦住这次按下，免得启动中心「点外面就关」把自己关掉
      event.preventDefault();
      event.stopPropagation();
      const item = event.target.closest ? event.target.closest('.launch-select-option') : null;
      if (item) choose(pop.items.indexOf(item));
      return;
    }
    if (event.target === pop.select) return;
    close();
  }, true);
  document.addEventListener('mousemove', event => {
    if (!pop) return;
    const item = event.target && event.target.closest ? event.target.closest('.launch-select-option') : null;
    const index = item ? pop.items.indexOf(item) : -1;
    if (index >= 0 && index !== pop.active && !item.classList.contains('disabled')) { pop.active = index; paintActive(); }
  });
  // 启动中心里滚动、窗口大小变化：跟着控件走；启动中心关掉、控件被藏起来：收起。
  root.addEventListener('scroll', () => { if (pop) { if (pop.select.getClientRects().length) place(); else close(); } }, true);
  window.addEventListener('resize', () => close());
  window.addEventListener('blur', () => close());
  window.addEventListener('launch-center:closed', () => close());
  new window.MutationObserver(() => { if (pop && (root.style.display === 'none' || !pop.select.getClientRects().length)) close(); })
    .observe(root, { attributes: true, attributeFilter: ['style', 'hidden'], subtree: true });

  return { close, isOpen: () => !!pop, current: () => (pop ? pop.select : null) };
}

module.exports = { installSelectPopover };
