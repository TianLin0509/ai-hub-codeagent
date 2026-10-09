'use strict';
// 中文 Markdown 的加粗宽容处理：CommonMark 规定 `**注意：**这里` 这类「星号内侧是标点、外侧是汉字」的写法不算加粗，
// 结果星号原样露出来。这里把同一行内成对的 **…** 换成不可见的占位符（代码块、行内代码里不动），
// 交给 Markdown 渲染后再由 restoreBold 换回 <strong>。其余原始 HTML 仍按 Hub 全局规则转义，正文不丢字。
const OPEN = '', CLOSE = '';

function tidyBold(line) {
  return line.split(/(`[^`]*`)/).map(part => part.startsWith('`') && part.endsWith('`') && part.length > 1 ? part
    : part.replace(/\*\*(?=\S)([^*\n]+?)(?<=\S)\*\*/g, (_m, inner) => OPEN + inner + CLOSE)).join('');
}

function tidyMarkdown(text) {
  let fenced = false;
  return String(text ?? '').split('\n').map(line => {
    if (/^\s*(```|~~~)/.test(line)) { fenced = !fenced; return line; }
    return fenced ? line : tidyBold(line);
  }).join('\n');
}
const restoreBold = html => String(html).split(OPEN).join('<strong>').split(CLOSE).join('</strong>');
module.exports = { tidyMarkdown, restoreBold, OPEN, CLOSE };
