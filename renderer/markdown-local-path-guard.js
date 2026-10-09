const {
  ABS_PATH_RE,
  WINDOWS_FILE_PATH_RE,
  WINDOWS_PATH_TOKEN_RE,
  URL_RE,
} = require('./path-candidates.js');

// Markdown punctuation bounds relative paths; swallowing ` or [label]( breaks
// inline code and links before marked gets a chance to parse them.
// Try once at each token boundary. Without this boundary, a long paragraph
// without a slash retries the whole suffix at every character (quadratic).
const MARKDOWN_REL_PATH_RE = /(?<![^:*?"<>|\r\n\s：`()[\]])[\\/]*(?:[^\\/:*?"<>|\r\n\s：`()[\]]+[\\/]+)+[^\\/:*?"<>|\r\n\s：`()[\]]+\.[A-Za-z0-9]{1,8}(?![A-Za-z0-9])/g;

function _cloneGlobal(re) {
  return new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
}

function _escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function _collectGuardSpans(source) {
  const spans = [];
  const urls = [];
  const fileUrlRe = /\bfile:\/\/\/[A-Za-z]:\/[^\s<>"'`]+/gi;
  let m;
  while ((m = fileUrlRe.exec(source))) {
    const raw = m[0].replace(/[.,;!?)\]]+$/, '');
    spans.push({ start: m.index, end: m.index + raw.length, raw });
  }
  const urlRe = _cloneGlobal(URL_RE);
  while ((m = urlRe.exec(source))) {
    urls.push({ start: m.index, end: m.index + m[0].length });
  }

  for (const baseRe of [WINDOWS_FILE_PATH_RE, WINDOWS_PATH_TOKEN_RE, ABS_PATH_RE, MARKDOWN_REL_PATH_RE]) {
    const re = _cloneGlobal(baseRe);
    while ((m = re.exec(source))) {
      const start = m.index;
      const end = start + m[0].length;
      if (urls.some((u) => start >= u.start && end <= u.end)) continue;
      if (spans.some((s) => !(end <= s.start || start >= s.end))) continue;
      spans.push({ start, end, raw: m[0] });
    }
  }
  return spans.sort((a, b) => a.start - b.start);
}

// marked 会把 Windows 路径里的 \_、\. 等当 Markdown escape；本地路径作为
// href 时又会被编码/清洗。解析前把完整 token 换成安全占位符，sanitize 完成后
// 再以 HTML-escaped 原文恢复，既保留 CLI 原始显示，也不会绕过 HTML 注入防线。
function guardMarkdownLocalPaths(text) {
  const source = String(text || '');
  const spans = _collectGuardSpans(source);
  if (spans.length === 0) return { text: source, entries: [] };

  let salt = 0;
  let prefix = '';
  do {
    prefix = `HUBLOCALPATHGUARD${salt++}X`;
  } while (source.includes(prefix));

  const entries = spans.map((span, index) => ({
    ...span,
    token: `${prefix}${index}Z`,
  }));
  let guarded = '';
  let cursor = 0;
  for (const entry of entries) {
    guarded += source.slice(cursor, entry.start) + entry.token;
    cursor = entry.end;
  }
  guarded += source.slice(cursor);
  return { text: guarded, entries };
}

function restoreMarkdownLocalPaths(html, guard) {
  let out = String(html || '');
  const entries = guard && Array.isArray(guard.entries) ? guard.entries : [];
  for (const entry of entries) {
    out = out.split(entry.token).join(_escapeHtml(entry.raw));
  }
  return out;
}

module.exports = {
  guardMarkdownLocalPaths,
  restoreMarkdownLocalPaths,
  _collectGuardSpans,
};
