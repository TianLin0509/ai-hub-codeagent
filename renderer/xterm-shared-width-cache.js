'use strict';
// 终端测字宽的两处浪费（2026-10-13 侧栏切换卡顿取证）。
//
// 生产实测：在侧栏点会话，每次 0.9–1.9 秒长任务，约 2/3 在 xterm 的 WidthCache._measure。
// 调用链：切换会话 → 上一个会话卸掉 Canvas 绘制层（unloadGpuRenderer，只给当前会话留一层）→ xterm 新建
// DOM 渲染器 → handleResize → 整屏 renderRows → 每个字查字宽。_measure 把字重复 32 遍塞进隐藏元素再读
// offsetWidth，每次都强制排版一次。
//   1. 那个终端此刻是 display:none（已经切走了），量出来全是 0，0 不进表，于是整屏几百个不同的字
//      每个都强制排版一次，换来的结果还是 0。→ 同一段同步代码里先看一次测量容器有没有被渲染
//      （getClientRects），没有就直接返回 0：结果与原来完全相同，只是不再白白排版。终端重新显示时
//      xterm 会照常重画、照常测量。
//   2. 每个 DOM 渲染器自带一份新的空字宽表，卸一次绘制层就新建一次。同一字体、字号、粗细、粗/斜体与
//      屏幕缩放下，一个字的宽度与哪个终端无关 → 加一份全局表，量到大于 0 的宽度写进去，其他终端直接用。
// 只在 WidthCache 原型上装一次（所有终端共用同一份 xterm 代码）；字段对不上（xterm 升级后结构变了）
// 就不装，行为退回原样。HUB_DISABLE_SHARED_WIDTH_CACHE=1 可关。
const SHARED = new Map();
const LIMIT = 20000;
const stats = { hits: 0, measured: 0, skippedHidden: 0 };
let installed = false;

// 「同一段同步代码」的编号：第一次用到时排一个微任务，当前这段代码跑完就换号。
let epoch = 0, epochScheduled = false;
function currentEpoch() {
  if (!epochScheduled) { epochScheduled = true; queueMicrotask(() => { epoch++; epochScheduled = false; }); }
  return epoch;
}

function containerHidden(cache) {
  const e = currentEpoch();
  if (cache.__hubHiddenEpoch !== e) {
    cache.__hubHiddenEpoch = e;
    const el = cache._container;
    cache.__hubHidden = !!el && (!el.isConnected || el.getClientRects().length === 0);
  }
  return cache.__hubHidden;
}

function keyOf(cache, text, variant) {
  const dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
  return `${dpr}|${cache._font}|${cache._fontSize}|${cache._weight}|${cache._weightBold}|${variant}|${text}`;
}

function widthCachePrototype(terminal) {
  const renderer = terminal && terminal._core && terminal._core._renderService && terminal._core._renderService._renderer;
  const dom = renderer && (renderer.value || renderer._value);
  const cache = dom && dom._widthCache;
  return cache ? Object.getPrototypeOf(cache) : null;
}

function installSharedWidthCache(terminal, env = process.env) {
  if (installed || env.HUB_DISABLE_SHARED_WIDTH_CACHE === '1') return installed;
  const proto = widthCachePrototype(terminal);
  if (!proto || typeof proto._measure !== 'function' || proto.__hubSharedWidth) return false;
  const original = proto._measure;
  proto._measure = function sharedMeasure(text, variant) {
    if (typeof this._font !== 'string' || typeof this._fontSize !== 'number') return original.call(this, text, variant);
    const key = keyOf(this, text, variant);
    const hit = SHARED.get(key);
    if (hit !== undefined) { stats.hits++; return hit; }
    if (containerHidden(this)) { stats.skippedHidden++; return 0; }
    const width = original.call(this, text, variant);
    stats.measured++;
    if (width > 0) {
      if (SHARED.size >= LIMIT) SHARED.clear();
      SHARED.set(key, width);
    }
    return width;
  };
  proto.__hubSharedWidth = true;
  installed = true;
  return true;
}

// 批量预量（2026-10-13，配合 xterm-card-pause）：终端暂停绘制期间出现的新字，恢复时补画会逐个去量，
// 每个字强制排版一次（公司条件实测点后台 0.4–1.6 秒）。补画前先把这一屏里没量过的字一次性摆进测量区，
// 只排一次版就读出全部宽度，写进共享表；随后的补画全部命中。
function widthCacheOf(terminal) {
  const renderer = terminal && terminal._core && terminal._core._renderService && terminal._core._renderService._renderer;
  const dom = renderer && (renderer.value || renderer._value);
  return dom && dom._widthCache && dom._widthCache._measureElements ? dom._widthCache : null;
}

function prewarmViewportWidths(terminal) {
  const cache = installed ? widthCacheOf(terminal) : null;
  if (!cache || !cache._container || containerHidden(cache)) return 0;
  const buffer = terminal.buffer && terminal.buffer.active;
  if (!buffer || typeof buffer.getLine !== 'function') return 0;
  const want = new Map();
  let cell;
  for (let y = 0; y < terminal.rows; y++) {
    const line = buffer.getLine(buffer.viewportY + y);
    if (!line) continue;
    for (let x = 0; x < line.length; x++) {
      cell = line.getCell(x, cell);
      if (!cell || cell.getWidth() === 0) continue;
      const text = cell.getChars() || ' ';
      const variant = (cell.isBold() ? 1 : 0) | (cell.isItalic() ? 2 : 0);
      const key = keyOf(cache, text, variant);
      if (!SHARED.has(key) && !want.has(key)) want.set(key, { text, variant });
    }
  }
  if (!want.size) return 0;
  const spans = [];
  for (const [key, item] of want) {
    const span = cache._measureElements[item.variant].cloneNode(false);
    span.textContent = item.text.repeat(32);
    cache._container.appendChild(span);
    spans.push([key, span]);
  }
  let stored = 0;
  for (const [key, span] of spans) {
    const width = span.offsetWidth / 32;
    if (width > 0) { SHARED.set(key, width); stored++; }
  }
  for (const [, span] of spans) span.remove();
  stats.prewarmed = (stats.prewarmed || 0) + stored;
  return stored;
}

function sharedWidthCacheStats() { return { ...stats, size: SHARED.size, installed }; }

module.exports = { installSharedWidthCache, prewarmViewportWidths, sharedWidthCacheStats };
