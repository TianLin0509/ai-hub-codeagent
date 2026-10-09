'use strict';

/**
 * 长文本粘贴块（2026-09-26）。
 *
 * 实测：往会话输入框粘贴 500 行（2.5 万字）主线程一次卡 1.15 秒，1000 行以上卡 30 秒以上
 * —— execCommand('insertText') 把每一行都变成 DOM 节点，代价随长度超线性增长。
 * CLI 的做法是只显示 `[Pasted text +N lines]`，原文留在内存里，提交时再展开。这里照做：
 *
 *   - 输入框里只插一个不可编辑的 <span class="fi-paste-chip">，原文存在本模块的 Map 里；
 *   - span 的文字是私用区字符包起来的 id（p1），font-size:0 不可见，
 *     看到的标签来自 ::before { content: attr(data-label) }；
 *   - 所以 innerText 读出来的是「标记」，expandPasteMarkers 把标记换回原文 ——
 *     发送、草稿、复制都经过它，发出去的内容与粘贴的逐字相同。
 */

const MARK_START = '';
const MARK_END = '';
const MARKER_RE = /(p[a-z0-9]+)/g;
const MARKER_TEST_RE = /p[a-z0-9]+/;
const LOST_PLACEHOLDER = '[粘贴内容已丢失]';

// 粘贴时：多于这么多行或字就收成块（CLI 也是多行即收）。
const MIN_LINES = 10;
const MIN_CHARS = 2000;
// 整框替换（历史召回、恢复未发送的消息）时门槛更高：短一些的历史消息仍按原文可编辑，
// 只有足以卡顿的大文本才收成块。
const REPLACE_MIN_LINES = 200;
const REPLACE_MIN_CHARS = 20000;

const PREVIEW_MAX_CHARS = 20000;

const store = new Map();
let seq = 0;

function countLines(value) {
  const text = String(value || '');
  if (!text) return 0;
  let lines = 1;
  for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) lines += 1;
  return text.endsWith('\n') ? lines - 1 : lines;
}

function shouldCollapsePaste(text) {
  const value = String(text || '');
  return value.length >= MIN_CHARS || countLines(value) >= MIN_LINES;
}

function shouldCollapseReplace(text) {
  const value = String(text || '');
  return value.length >= REPLACE_MIN_CHARS || countLines(value) >= REPLACE_MIN_LINES;
}

function registerPaste(text) {
  const value = String(text || '');
  seq += 1;
  const id = 'p' + seq.toString(36) + Math.random().toString(36).slice(2, 6);
  store.set(id, { text: value, lines: countLines(value), chars: value.length });
  return id;
}

function pasteEntry(id) {
  return store.get(String(id || '')) || null;
}

function hasPasteMarkers(text) {
  return MARKER_TEST_RE.test(String(text || ''));
}

// 丢失的块（理论上不会发生：store 与渲染进程同寿命）必须可见，不能静默变成空串发出去。
function expandPasteMarkers(text) {
  const value = String(text == null ? '' : text);
  if (!value.includes(MARK_START)) return value;
  return value.replace(MARKER_RE, (_, id) => {
    const entry = store.get(id);
    return entry ? entry.text : LOST_PLACEHOLDER;
  });
}

function chipLabel(entry, index) {
  return `[粘贴文本 #${index} · ${entry.lines} 行]`;
}

function escapeAttr(value) {
  return String(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function chipHtml(id, index) {
  const entry = pasteEntry(id);
  return `<span class="fi-paste-chip" contenteditable="false" data-paste-id="${escapeAttr(id)}" data-paste-index="${index}"`
    + ` data-label="${escapeAttr(chipLabel(entry, index))}">${MARK_START}${id}${MARK_END}</span>`;
}

function createChipElement(document, id, index) {
  const entry = pasteEntry(id);
  const chip = document.createElement('span');
  chip.className = 'fi-paste-chip';
  chip.contentEditable = 'false';
  chip.dataset.pasteId = id;
  chip.dataset.pasteIndex = String(index);
  chip.dataset.label = chipLabel(entry, index);
  chip.textContent = `${MARK_START}${id}${MARK_END}`;
  return chip;
}

function nextChipIndex(inputEl) {
  return inputEl.querySelectorAll('.fi-paste-chip').length + 1;
}

/**
 * 在光标处插入一个粘贴块。走 execCommand('insertHTML') 以保留原生撤销栈；
 * 若浏览器剥掉了块的属性（没找到对应元素），退回 Range 直接插入。
 */
function insertPasteChip(inputEl, text, { document, window }) {
  const id = registerPaste(text);
  const index = nextChipIndex(inputEl);
  let inserted = false;
  try {
    inserted = document.execCommand('insertHTML', false, chipHtml(id, index));
  } catch {
    inserted = false;
  }
  let chip = inserted ? inputEl.querySelector(`.fi-paste-chip[data-paste-id="${id}"]`) : null;
  if (!chip) {
    chip = createChipElement(document, id, index);
    const selection = window.getSelection();
    const range = selection && selection.rangeCount && inputEl.contains(selection.getRangeAt(0).startContainer)
      ? selection.getRangeAt(0)
      : null;
    if (range) {
      range.deleteContents();
      range.insertNode(chip);
    } else {
      inputEl.appendChild(chip);
    }
  }
  placeCaretAfter(chip, window);
  return id;
}

// insertHTML 之后 Chromium 会把光标留在不可编辑的块里面，接着打的字直接丢失。
// 显式放到块后面；块后面没有文字节点时补一个空文本节点给光标落脚。
function placeCaretAfter(chip, window) {
  try {
    const document = chip.ownerDocument;
    let next = chip.nextSibling;
    if (!next || next.nodeType !== 3) {
      next = document.createTextNode('');
      chip.parentNode.insertBefore(next, chip.nextSibling);
    }
    const range = document.createRange();
    range.setStart(next, 0);
    range.collapse(true);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  } catch {}
}

/** 把含标记的原始文本渲染回输入框（恢复草稿用）。纯 DOM 赋值，和原来的 textContent 恢复同级。 */
function renderRawComposerText(inputEl, raw, { document }) {
  inputEl.textContent = '';
  const value = String(raw || '');
  let last = 0;
  let index = 0;
  for (const match of value.matchAll(MARKER_RE)) {
    if (match.index > last) inputEl.appendChild(document.createTextNode(value.slice(last, match.index)));
    const entry = pasteEntry(match[1]);
    if (entry) {
      index += 1;
      inputEl.appendChild(createChipElement(document, match[1], index));
    } else {
      inputEl.appendChild(document.createTextNode(LOST_PLACEHOLDER));
    }
    last = match.index + match[0].length;
  }
  if (last < value.length) inputEl.appendChild(document.createTextNode(value.slice(last)));
}

// 预览浮层全局只有一个，状态也只能有一份：绑在某个输入框闭包里的话，那个输入框销毁后，
// 别的输入框里「移进预览滚动」会被旧计时器收起。
let hideTimer = null;
let activeChip = null;
function cancelHide() { if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; } }
function popover(document) {
  let el = document.querySelector('.fi-paste-preview');
  if (el) return el;
  el = document.createElement('div');
  el.className = 'fi-paste-preview';
  el.setAttribute('role', 'tooltip');
  el.hidden = true;
  const head = document.createElement('div');
  head.className = 'fi-paste-preview-head';
  const title = document.createElement('strong');
  const meta = document.createElement('span');
  head.append(title, meta);
  const body = document.createElement('pre');
  body.className = 'fi-paste-preview-body';
  const foot = document.createElement('div');
  foot.className = 'fi-paste-preview-foot';
  el.append(head, body, foot);
  // 允许把鼠标移进预览里滚动查看；离开预览再收起。
  el.addEventListener('mouseenter', cancelHide);
  el.addEventListener('mouseleave', () => scheduleHide(document));
  document.body.appendChild(el);
  return el;
}
function hide(document) {
  cancelHide();
  activeChip = null;
  const el = document.querySelector('.fi-paste-preview');
  if (el) el.hidden = true;
}
function scheduleHide(document) {
  cancelHide();
  hideTimer = setTimeout(() => hide(document), 180);
}
function show(chip, { document, window }) {
  cancelHide();
  if (activeChip === chip) return;
  const entry = pasteEntry(chip.dataset.pasteId);
  if (!entry) return;
  activeChip = chip;
  const el = popover(document);
  el.querySelector('.fi-paste-preview-head strong').textContent = `粘贴文本 #${chip.dataset.pasteIndex || '?'}`;
  el.querySelector('.fi-paste-preview-head span').textContent = `${entry.lines} 行 · ${entry.chars.toLocaleString()} 字`;
  const shown = entry.text.length > PREVIEW_MAX_CHARS ? entry.text.slice(0, PREVIEW_MAX_CHARS) : entry.text;
  el.querySelector('.fi-paste-preview-body').textContent = shown;
  const hiddenLines = entry.lines - countLines(shown);
  el.querySelector('.fi-paste-preview-foot').textContent = (hiddenLines > 0 ? `… 另有 ${hiddenLines} 行未显示 · ` : '')
    + '发送时自动展开为原文 · 退格可整块删除';
  el.hidden = false;
  el.scrollTop = 0;
  el.querySelector('.fi-paste-preview-body').scrollTop = 0;
  // 输入框在窗口底部：预览放在块的上方，左右夹在视口内。
  const rect = chip.getBoundingClientRect();
  const box = el.getBoundingClientRect();
  const left = Math.max(8, Math.min(rect.left, window.innerWidth - box.width - 8));
  const above = rect.top - box.height - 8;
  const top = above >= 8 ? above : Math.min(rect.bottom + 8, window.innerHeight - box.height - 8);
  el.style.left = `${Math.round(left)}px`;
  el.style.top = `${Math.round(Math.max(8, top))}px`;
}

/**
 * 把一段文字放进输入框：含标记的按标记还原块；不含标记但足以卡顿的大段纯文本
 * （发送失败退回、历史召回、重启后恢复的长草稿）整段收成一个块，不再铺满 DOM。
 */
function renderComposerValue(inputEl, value, { document }) {
  let raw = String(value || '');
  if (!hasPasteMarkers(raw) && shouldCollapseReplace(raw)) raw = MARK_START + registerPaste(raw) + MARK_END;
  renderRawComposerText(inputEl, raw, { document });
}

function selectionTextWithin(inputEl, window) {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount < 1 || selection.isCollapsed) return '';
  const range = selection.getRangeAt(0);
  if (!inputEl.contains(range.commonAncestorContainer)) return '';
  return String(selection.toString() || '');
}

/**
 * 复制/剪切含块的选区时写入原文；悬停块时显示预览。
 * Ctrl+C 由全局 clipboard-controller 接管（它同样经过 expandPasteMarkers），
 * 这里兜住右键菜单复制和 Ctrl+X。
 */
function attachPasteChipBehaviors(inputEl, { document, window }) {
  if (!inputEl || inputEl.dataset.pasteChipsBound === '1') return;
  inputEl.dataset.pasteChipsBound = '1';

  const onCopyOrCut = (event) => {
    const raw = selectionTextWithin(inputEl, window);
    if (!raw || !hasPasteMarkers(raw) || !event.clipboardData) return;
    event.preventDefault();
    event.clipboardData.setData('text/plain', expandPasteMarkers(raw));
    if (event.type === 'cut') document.execCommand('delete');
  };
  inputEl.addEventListener('copy', onCopyOrCut);
  inputEl.addEventListener('cut', onCopyOrCut);

  inputEl.addEventListener('mouseover', (event) => {
    const chip = event.target && event.target.closest ? event.target.closest('.fi-paste-chip') : null;
    if (chip && inputEl.contains(chip)) show(chip, { document, window });
  });
  inputEl.addEventListener('mouseout', (event) => {
    const chip = event.target && event.target.closest ? event.target.closest('.fi-paste-chip') : null;
    if (!chip) return;
    const to = event.relatedTarget;
    if (to && (chip.contains(to) || (to.closest && to.closest('.fi-paste-preview')))) return;
    scheduleHide(document);
  });
  // 块被删掉、输入框被清空或发送后，别留一个悬空的预览。
  inputEl.addEventListener('input', () => {
    if (activeChip && !activeChip.isConnected) hide(document);
  });
}

module.exports = {
  MARK_END,
  MARK_START,
  attachPasteChipBehaviors,
  countLines,
  expandPasteMarkers,
  hasPasteMarkers,
  insertPasteChip,
  pasteEntry,
  registerPaste,
  renderComposerValue,
  renderRawComposerText,
  shouldCollapsePaste,
  shouldCollapseReplace,
};
