// 识别正文里的文件路径 / URL，返回 [{ path, start, end, kind }]
// 支持: .html .htm .md .markdown .json .py .js .ts .css .png .jpg .pdf 等常见后缀
// 支持: 相对路径(docs/foo.md), Windows 绝对(C:\..), POSIX 绝对(/usr/..), URL(http(s)://)
// 注意: 变量名加 _PL_ 前缀，避免与 renderer.js 的全局 const URL_RE / FILE_EXT_RE 冲突
const _PL_FILE_EXT_RE = /(?<![\w:./\\-])[\w:./\\\-]+\.(html?|markdown|md|json|py|jsx?|tsx?|css|scss|png|jpg|jpeg|gif|svg|pdf|txt|log|yaml|yml|toml|sh|ps1|bat)\b/gi;
const _PL_URL_RE = /\bhttps?:\/\/[^\s<>'"]+/gi;
const _PL_PATH_TOKEN_BREAK_RE = /(?<![^\s"'`<>|])([^\s"'`<>|]+)\r?\n[ \t]*([^\s"'`<>|]+)/g;

function _looksLikeWrappedPathToken(left, right) {
  const combined = String(left || '') + String(right || '');
  const startsLikeLocalPath = /^(?:[A-Za-z]:[\\/]|\\\\[^\\/:*?"<>|\r\n\s]+\\|~[\\/]|\.{1,2}[\\/]|[^\\/:*?"<>|\r\n\s]+[\\/])/.test(combined);
  if (!startsLikeLocalPath) return false;
  if (!/\.(?:html?|markdown|md|json|py|jsx?|tsx?|css|scss|png|jpg|jpeg|gif|svg|pdf|txt|log|yaml|yml|toml|sh|ps1|bat)(?:[.,;:!?)\]}>'"]*)?$/i.test(combined)) return false;
  return /^[^\\/:*?"<>|\r\n\s]+/.test(String(right || ''));
}

function normalizeWrappedPathBreaks(text) {
  let out = String(text || '');
  if (!out.includes('\n')) return out;
  for (let i = 0; i < 20; i++) {
    let changed = false;
    out = out.replace(_PL_PATH_TOKEN_BREAK_RE, (full, left, right) => {
      if (!_looksLikeWrappedPathToken(left, right)) return full;
      changed = true;
      return left + right;
    });
    if (!changed) break;
  }
  return out;
}

function extractPathLinks(text) {
  if (!text) return [];
  text = normalizeWrappedPathBreaks(text);
  const out = [];
  let m;
  // URL 优先(避免 URL 里的 .html 被当文件路径)
  _PL_URL_RE.lastIndex = 0;
  while ((m = _PL_URL_RE.exec(text)) !== null) {
    let url = m[0];
    // Strip common trailing punctuation that's almost never part of URL
    // (period/comma/semicolon/colon/exclam/question/closing brackets/quotes)
    const stripped = url.replace(/[.,;:!?)\]}>'"]+$/, '');
    if (stripped.length >= 8) { // at least "http://x"
      out.push({ path: stripped, start: m.index, end: m.index + stripped.length, kind: 'url' });
    }
  }
  // file paths
  _PL_FILE_EXT_RE.lastIndex = 0;
  while ((m = _PL_FILE_EXT_RE.exec(text)) !== null) {
    const overlap = out.some(o => m.index >= o.start && m.index < o.end);
    if (!overlap) out.push({ path: m[0], start: m.index, end: m.index + m[0].length, kind: 'file' });
  }
  out.sort((a, b) => a.start - b.start);
  return out;
}

// DOM 后处理: 给元素内文本里的路径包 <a class="rt-file-link"> 让 click 路由到 openPreviewPanel
function wrapPathLinksInElement(rootEl) {
  if (!rootEl) return 0;
  let wrapped = 0;
  const walker = document.createTreeWalker(rootEl, NodeFilter.SHOW_TEXT, {
    acceptNode(n) {
      const p = n.parentElement;
      if (!p) return NodeFilter.FILTER_REJECT;
      if (p.tagName === 'A' || p.tagName === 'PRE' || p.tagName === 'CODE') return NodeFilter.FILTER_REJECT;
      if (p.closest('.code-block-wrap, .tc, .rt-file-link')) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    }
  });
  const nodes = [];
  let n;
  while ((n = walker.nextNode())) nodes.push(n);
  for (const node of nodes) {
    const text = normalizeWrappedPathBreaks(node.nodeValue);
    const links = extractPathLinks(text);
    if (!links.length) continue;
    const frag = document.createDocumentFragment();
    let cursor = 0;
    for (const lk of links) {
      if (lk.start > cursor) frag.appendChild(document.createTextNode(text.slice(cursor, lk.start)));
      const a = document.createElement('a');
      a.className = 'rt-file-link';
      a.href = '#';
      a.dataset.path = lk.path;
      a.textContent = lk.path;
      frag.appendChild(a);
      wrapped++;
      cursor = lk.end;
    }
    if (cursor < text.length) frag.appendChild(document.createTextNode(text.slice(cursor)));
    node.parentNode.replaceChild(frag, node);
  }
  return wrapped;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { extractPathLinks, wrapPathLinksInElement, normalizeWrappedPathBreaks };
}
if (typeof window !== 'undefined') {
  window.normalizeWrappedPathBreaks = normalizeWrappedPathBreaks;
  window.extractPathLinks = extractPathLinks;
  window.wrapPathLinksInElement = wrapPathLinksInElement;
}
