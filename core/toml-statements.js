'use strict';

// 只读的 TOML 语句扫描器：把文本切成「表头 / 数组表头 / 键值」三种语句，
// 给出每条语句的完整键路径和所在行范围，供调用方做最小文本改动。
//
// 它不求值，只认结构：键支持裸键、"basic"（含转义）和 'literal' 三种写法及
// 点号两侧的空白；值只负责正确跳过（多行字符串、数组、内联表、注释）。
// 遇到不认识的写法就抛错 —— 调用方据此放弃改写，而不是猜着写。

class TomlScanError extends Error {}

function scanTomlStatements(text) {
  const src = String(text || '');
  const lineStarts = [0];
  for (let i = 0; i < src.length; i += 1) if (src[i] === '\n') lineStarts.push(i + 1);
  const lineOf = offset => {
    let lo = 0, hi = lineStarts.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (lineStarts[mid] <= offset) lo = mid; else hi = mid - 1; }
    return lo;
  };
  let pos = 0;
  const fail = message => { throw new TomlScanError(`${message}（第 ${lineOf(pos) + 1} 行）`); };
  const peek = (n = 0) => src[pos + n];
  const skipSpaces = () => { while (peek() === ' ' || peek() === '\t') pos += 1; };
  const skipComment = () => { if (peek() === '#') while (pos < src.length && peek() !== '\n') pos += 1; };
  const skipBlank = () => {
    for (;;) {
      skipSpaces(); skipComment();
      if (peek() === '\r' && peek(1) === '\n') pos += 2;
      else if (peek() === '\n') pos += 1;
      else return;
    }
  };
  const endOfLine = () => {
    skipSpaces(); skipComment();
    if (pos >= src.length) return;
    if (peek() === '\r' && peek(1) === '\n') { pos += 2; return; }
    if (peek() === '\n') { pos += 1; return; }
    fail('语句后有多余内容');
  };

  function basicString() {
    pos += 1;
    let out = '';
    for (;;) {
      const ch = peek();
      if (ch === undefined || ch === '\n') fail('字符串未闭合');
      pos += 1;
      if (ch === '"') return out;
      if (ch !== '\\') { out += ch; continue; }
      const esc = peek(); pos += 1;
      const simple = { b: '\b', t: '\t', n: '\n', f: '\f', r: '\r', e: '\x1b', '"': '"', '\\': '\\' };
      if (esc in simple) { out += simple[esc]; continue; }
      const width = esc === 'u' ? 4 : esc === 'U' ? 8 : esc === 'x' ? 2 : 0;
      const hex = width ? src.slice(pos, pos + width) : '';
      if (!width || !new RegExp(`^[0-9a-fA-F]{${width}}$`).test(hex)) fail('非法转义');
      pos += width;
      out += String.fromCodePoint(parseInt(hex, 16));
    }
  }
  function literalString() {
    const close = src.indexOf("'", pos + 1);
    const nl = src.indexOf('\n', pos + 1);
    if (close < 0 || (nl >= 0 && nl < close)) fail('字符串未闭合');
    const out = src.slice(pos + 1, close);
    pos = close + 1;
    return out;
  }
  function keyPath() {
    const keys = [];
    for (;;) {
      skipSpaces();
      const ch = peek();
      if (ch === '"') keys.push(basicString());
      else if (ch === "'") keys.push(literalString());
      else {
        const match = /^[A-Za-z0-9_-]+/.exec(src.slice(pos, pos + 256));
        if (!match) fail('无法识别的键');
        keys.push(match[0]); pos += match[0].length;
      }
      skipSpaces();
      if (peek() !== '.') return keys;
      pos += 1;
    }
  }
  function multiline(quote) {
    const fence = quote.repeat(3);
    pos += 3;
    for (;;) {
      if (pos >= src.length) fail('多行字符串未闭合');
      if (quote === '"' && peek() === '\\') { pos += 2; continue; }
      if (src.startsWith(fence, pos)) {
        pos += 3;
        let extra = 0;
        while (peek() === quote && extra < 2) { pos += 1; extra += 1; }
        return;
      }
      pos += 1;
    }
  }
  function value() {
    const ch = peek();
    if (src.startsWith('"""', pos)) return multiline('"');
    if (src.startsWith("'''", pos)) return multiline("'");
    if (ch === '"') { basicString(); return; }
    if (ch === "'") { literalString(); return; }
    if (ch === '[') {
      pos += 1;
      for (;;) {
        skipBlank();
        if (peek() === ']') { pos += 1; return; }
        value();
        skipBlank();
        if (peek() === ',') { pos += 1; continue; }
        if (peek() === ']') { pos += 1; return; }
        fail('数组格式不对');
      }
    }
    if (ch === '{') {
      pos += 1;
      for (;;) {
        skipBlank();
        if (peek() === '}') { pos += 1; return; }
        keyPath();
        if (peek() !== '=') fail('内联表缺少 =');
        pos += 1; skipSpaces();
        value();
        skipBlank();
        if (peek() === ',') { pos += 1; continue; }
        if (peek() === '}') { pos += 1; return; }
        fail('内联表格式不对');
      }
    }
    const match = /^[^,\]}#\r\n]+/.exec(src.slice(pos, pos + 256));
    if (!match || !match[0].trim()) fail('缺少值');
    pos += match[0].replace(/[ \t]+$/, '').length;
  }

  const statements = [];
  let table = [];
  for (;;) {
    skipBlank();
    if (pos >= src.length) break;
    const start = pos;
    if (peek() === '[') {
      const array = peek(1) === '[';
      pos += array ? 2 : 1;
      const keys = keyPath();
      const close = array ? ']]' : ']';
      if (!src.startsWith(close, pos)) fail('表头未闭合');
      pos += close.length;
      const endAt = pos;
      endOfLine();
      table = keys;
      statements.push({ kind: array ? 'array-table' : 'table', path: keys,
        startLine: lineOf(start), endLine: lineOf(endAt - 1) });
      continue;
    }
    const keys = keyPath();
    if (peek() !== '=') fail('键后缺少 =');
    pos += 1; skipSpaces();
    const valueStart = pos;
    value();
    const valueEnd = pos;
    endOfLine();
    statements.push({ kind: 'kv', key: keys, path: table.concat(keys), table,
      startLine: lineOf(start), endLine: lineOf(valueEnd - 1),
      valueText: src.slice(valueStart, valueEnd) });
  }
  return { statements, lineCount: lineStarts.length };
}

// 一个键写进表头时的文本形式：优先 literal，含单引号或控制字符时用 basic。
function tomlKey(key) {
  const text = String(key);
  if (/^[A-Za-z0-9_-]+$/.test(text)) return text;
  if (!text.includes("'") && !/[\x00-\x1f\x7f]/.test(text)) return `'${text}'`;
  return JSON.stringify(text);
}

// 不含转义的单行字符串值的内容；其他写法返回 null（调用方按"不相等"处理，
// 重写成等价的简单形式即可，写盘前还有语义校验兜底）。
function simpleStringValue(valueText) {
  const text = String(valueText || '').trim();
  if (/^'[^'\n]*'$/.test(text)) return text.slice(1, -1);
  if (/^"[^"\\\n]*"$/.test(text)) return text.slice(1, -1);
  return null;
}

const samePath = (a, b) => a.length === b.length && a.every((part, index) => part === b[index]);
const isPrefix = (prefix, full) => prefix.length <= full.length && prefix.every((part, index) => part === full[index]);

module.exports = { TomlScanError, scanTomlStatements, tomlKey, simpleStringValue, samePath, isPrefix };
