'use strict';
// 资料口播 · 正文提取：把 agent 产出的 HTML / Markdown 拆成章节，每章一份「手机阅读版」Markdown 和一份给写稿用的纯文本。
// HTML 在 Electron 隐藏窗口里打开（页面脚本照常运行、折叠块全部展开），按真实 DOM 顺序取标题、段落、列表、表格，
// 比直接剥标签可靠：很多手册的正文是脚本渲染出来的。
const fs = require('node:fs');
const path = require('node:path');

// 在页面里执行：按文档顺序遍历可见文字，归到它所在的块（段落、卡片、列表项、表格行、标题），
// 卡片式、网格式排版里的 div 文字也能拿到。导航、按钮、隐藏元素不要。
const DOM_SCRIPT = `(() => {
  document.querySelectorAll('details').forEach(d => { d.open = true; });
  document.querySelectorAll('[role="tabpanel"][hidden]').forEach(e => e.removeAttribute('hidden'));
  // 可见与否只看是否真的占位置：打印样式常把带 hidden 的面板强制显示出来。
  const SKIP = 'nav,script,style,noscript,button,select,option,input,textarea,svg,[aria-hidden="true"],.skip-link';
  const blockOf = n => { let e = n.parentElement;
    while (e && e !== document.body) { if (e.tagName === 'TR' || /^H[1-4]$/.test(e.tagName) || e.tagName === 'LI') return e;
      const d = getComputedStyle(e).display; if (!d.startsWith('inline') && d !== 'contents') return e; e = e.parentElement; }
    return document.body; };
  const kind = e => /^H[1-4]$/.test(e.tagName) ? e.tagName.toLowerCase() : e.tagName === 'LI' ? 'li' : e.closest('blockquote') ? 'blockquote' : e.tagName === 'PRE' ? 'pre' : 'p';
  const out = [], seen = new Set(); let cur = null;
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const text = n.nodeValue.replace(/\\s+/g, ' '); if (!text.trim()) continue;
    const p = n.parentElement; if (!p || p.closest(SKIP) || !p.getClientRects().length) continue;
    const b = blockOf(n);
    if (b.tagName === 'TR') { if (!seen.has(b)) { seen.add(b); const cells = [...b.children].map(c => c.innerText.replace(/\\s+/g, ' ').trim()); if (cells.some(Boolean)) out.push({ t: 'tr', head: !!b.querySelector('th'), cells }); } cur = null; continue; }
    if (b.closest('tr')) continue;
    if (cur && cur.el === b) { cur.s += text; continue; }
    cur = { el: b, t: kind(b), s: text }; out.push(cur);
  }
  return { title: document.title || '', blocks: out.map(({ el, ...x }) => x.t === 'tr' ? x : { t: x.t, s: x.s.trim() }).filter(x => x.t === 'tr' || x.s) };
})()`;

// Electron 隐藏窗口加载 HTML，取内容块（main.js 注入 electron）。
async function domBlocks({ BrowserWindow }, file) {
  const win = new BrowserWindow({ show: false, frame: false, width: 1200, height: 900, skipTaskbar: true,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
  try {
    await win.loadFile(file);
    // 按打印模式渲染：手册类网页的打印样式通常会展开全部标签面板与卡片、隐藏按钮和目录，正好是要读的全文。
    try { win.webContents.debugger.attach('1.3'); await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { media: 'print' }); } catch {}
    await new Promise(r => setTimeout(r, 1200));
    return await win.webContents.executeJavaScript(DOM_SCRIPT);
  } finally { win.destroy(); }
}

// Markdown 资料：按二级标题拆块，一级标题作书名。
function markdownBlocks(text) {
  const blocks = []; let title = '';
  for (const line of String(text).replace(/\r/g, '').split('\n')) {
    const h = line.match(/^(#{1,4})\s+(.+)/);
    if (h) { if (h[1].length === 1 && !title) title = h[2].trim(); blocks.push({ t: 'h' + h[1].length, s: h[2].trim() }); }
    else if (/^\s*[-*+]\s+/.test(line)) blocks.push({ t: 'li', s: line.replace(/^\s*[-*+]\s+/, '').trim() });
    else if (line.trim()) blocks.push({ t: 'p', s: line.trim() });
  }
  return { title, blocks };
}

// 参考文献、出处、链接类章节只放进阅读版，不做口播。
const READ_ONLY = /资料|参考|引用|链接|附录|阅读路径|延伸阅读|来源|出处|哪里来|文献/;
const LONG = 7000, PART = 5500;
// 太长的章（如十六型图谱）在靠近等分点的小标题处拆成几集，每集讲得从容。
function split(c) {
  const len = c.blocks.reduce((s, b) => s + (b.s || (b.cells || []).join('')).length, 0); if (len <= LONG) return [c];
  const parts = Math.ceil(len / PART), out = []; let cur = [], acc = 0, k = 1;
  for (const b of c.blocks) {
    const size = (b.s || (b.cells || []).join('')).length;
    if (k < parts && acc >= (len / parts) * k && /^h[3-4]$/.test(b.t) && cur.length) { out.push(cur); cur = []; k++; }
    cur.push(b); acc += size;
  }
  if (cur.length) out.push(cur);
  const names = out.length === 2 ? ['（上）', '（下）'] : out.map((_, i) => `（${i + 1}/${out.length}）`);
  return out.map((blocks, i) => ({ title: c.title + names[i], blocks }));
}
// 章节：用出现两次以上的最高一级标题切分；切分标题之前的内容作「导读」。
function chapters({ title, blocks }, fallbackTitle = '') {
  const level = ['h2', 'h1', 'h3'].find(h => blocks.filter(b => b.t === h).length >= 2) || null;
  const list = []; let cur = { title: '导读', blocks: [] };
  for (const b of blocks) {
    if (level && b.t === level) { if (cur.blocks.length) list.push(cur); cur = { title: b.s.split('\n')[0].slice(0, 60), blocks: [] }; continue; }
    cur.blocks.push(b);
  }
  if (cur.blocks.length) list.push(cur);
  const book = (title || fallbackTitle || list[0]?.title || '资料').replace(/\s*[·|｜-]\s*v?\d[\d.]*\s*$/, '').trim();
  return { title: book, chapters: list.flatMap(split).map((c, i) => ({ n: i + 1, title: c.title, markdown: toMarkdown(c), text: toText(c), readOnly: READ_ONLY.test(c.title) }))
    .filter(c => c.text.length >= 120 || (c.n === 1 && c.text.length >= 40)) };
}
function toMarkdown(c) {
  const out = ['## ' + c.title]; let table = [];
  const flush = () => { if (!table.length) return; const w = Math.max(...table.map(r => r.cells.length)); const row = r => '| ' + [...r.cells, ...Array(w - r.cells.length).fill('')].map(x => x.replace(/\|/g, '/')).join(' | ') + ' |';
    out.push('', row(table[0]), '| ' + Array(w).fill('---').join(' | ') + ' |', ...table.slice(1).map(row), ''); table = []; };
  for (const b of c.blocks) {
    if (b.t === 'tr') { table.push(b); continue; } flush();
    if (/^h[1-4]$/.test(b.t)) out.push('', '#'.repeat(Math.min(4, +b.t[1] + 1)) + ' ' + b.s.split('\n')[0]);
    else if (b.t === 'li' || b.t === 'dd') out.push('- ' + b.s.replace(/\n+/g, ' '));
    else if (b.t === 'dt') out.push('', '**' + b.s.replace(/\n+/g, ' ') + '**');
    else if (b.t === 'blockquote') out.push('', '> ' + b.s.replace(/\n+/g, ' '), '');
    else if (b.t === 'pre') out.push('', '```', b.s, '```', '');
    else out.push('', b.s);
  }
  flush();
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}
function toText(c) {
  return c.blocks.map(b => b.t === 'tr' ? (b.head ? '表头：' : '') + b.cells.join('；') : b.s).join('\n').replace(/\n{2,}/g, '\n').trim();
}
// 统一入口：返回 { title, chapters:[{n,title,markdown,text,readOnly}] }。
async function extract(file, { electron } = {}) {
  const ext = path.extname(file).toLowerCase(), name = path.basename(file, ext).replace(/^\d{8}-/, '').replace(/-(claude|codex)\d*$/, '');
  if (ext === '.md' || ext === '.txt') return chapters(markdownBlocks(fs.readFileSync(file, 'utf8')), name);
  if (ext === '.html' || ext === '.htm') { if (!electron) throw new Error('HTML 需要在 Hub 里提取'); return chapters(await domBlocks(electron, file), name); }
  throw new Error('目前支持 HTML 和 Markdown 资料');
}
module.exports = { extract, chapters, markdownBlocks, toMarkdown, DOM_SCRIPT, domBlocks };
