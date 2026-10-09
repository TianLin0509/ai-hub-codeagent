'use strict';
// 语音文字的整理与「背景」拼装：
// - cleanFillers：去掉独立的语气词（嗯、呃、啊……），不碰词语里的字（额度、好啊）。
// - 词库：voice-input.json 的 global = { terms（通用热词，所有项目）, personal（个人背景，只给本地模型） }。
// - 动态背景：当前会话最近的对话（Hub 的聊天记录 md 末尾），只给本地模型，不上传云端。
const fs = require('node:fs');

const FILLER = '(?:嗯+|呃+|额+|啊+|唔+|哦+|噢+|欸+|诶+|哎+|呣+)';
const SEP = '[，。！？、；：,.!?;:…\\s]';
// 独立语气词：出现在开头或标点后，且后面紧跟标点或结尾（「好啊」「额度」不受影响）
const STANDALONE = new RegExp(`(^|${SEP})${FILLER}(?=${SEP}|$)${SEP}*`, 'g');
// 「嗯、呃」几乎不作句末语气词：紧跟在词后、后面是标点或结尾时也去掉（「好啊」的「啊」、「金额」的「额」不在此列）
const TRAILING = new RegExp(`(?:嗯+|呃+|唔+|呣+)(?=${SEP}|$)`, 'g');
function cleanFillers(text) {
  let out = String(text || ''), prev;
  do { prev = out; out = out.replace(STANDALONE, '$1').replace(TRAILING, ''); } while (out !== prev);
  return out
    .replace(/^[，。、；：,.;:\s]+/, '')          // 开头残留的标点
    .replace(/([，、；：,;:])\s*(?=[，。！？,.!?])/g, '') // 逗号接句号：留后者
    .replace(/([，。！？])\1+/g, '$1')
    .trim();
}

const LIMITS = { terms: 300, termLength: 60, personal: 2000, dynamic: 1500 };
function normalizeGlobal(value = {}) {
  const terms = [...new Set(String(value.terms || '').split(/[,，;；\n]/).map(t => t.trim()).filter(Boolean))];
  if (terms.length > LIMITS.terms || terms.some(t => t.length > LIMITS.termLength)) throw new Error(`通用热词最多 ${LIMITS.terms} 个，每个不超过 ${LIMITS.termLength} 字`);
  const personal = String(value.personal || '').trim();
  if ([...personal].length > LIMITS.personal) throw new Error(`个人背景最多 ${LIMITS.personal} 字`);
  return { terms: terms.join('\n'), personal };
}
const termList = s => String(s || '').split(/[,，;；\n]/).map(t => t.trim()).filter(Boolean);

// 云端（Token Plan / 实时 API / 按量流式）用的词表：项目术语优先，再补通用热词，最多 80 个；不含个人背景与动态背景。
function cloudProfile(profile = {}, global = {}) {
  const terms = [...new Set([...termList(profile.terms), ...termList(global.terms)])].slice(0, 80);
  return { terms: terms.join('\n'), context: String(profile.context || '') };
}
// 本地模型的背景文本：个人背景 + 全部热词 + 项目说明 + 最近对话（本机处理，不上传）。实测近千字背景不拖慢识别。
function localBackground(profile = {}, global = {}, dynamic = '') {
  const terms = [...new Set([...termList(profile.terms), ...termList(global.terms)])];
  return [String(global.personal || '').trim(), terms.length ? '常用词：' + terms.join('、') : '',
    String(profile.context || '').trim(), dynamic ? '最近的对话：' + dynamic : ''].filter(Boolean).join('\n');
}

// 聊天记录 md 的末尾若干字：去掉标题、工具行、来源说明，只留对话文字。
function recentFromTranscript(file, maxChars = LIMITS.dynamic) {
  try {
    const stat = fs.statSync(file);
    const fd = fs.openSync(file, 'r');
    const size = Math.min(stat.size, maxChars * 6);
    const buf = Buffer.alloc(size);
    fs.readSync(fd, buf, 0, size, stat.size - size); fs.closeSync(fd);
    const text = buf.toString('utf8').split(/\r?\n/)
      .filter(line => line.trim() && !/^(#|>|- (来源|工作目录|原始记录|Hub 会话|生成)：)/.test(line.trim()))
      .join(' ').replace(/\s+/g, ' ');
    return [...text].slice(-maxChars).join('');
  } catch { return ''; }
}

// 从「识别结果 → 实际发出的文字」里找出被改正的词：只认短词替换（1～6 字改成长度相近的 1～8 字），
// 大段改写视为改主意，不学。返回 [{ wrong, right }]；right 用中文分词把改动处补成 2～4 字的完整词
// （如「雨」→「妤」补成「王思妤」、「铃」→「林」补成「作手林铛」），便于直接当热词。
const STOP = new Set('的了和与让把给在是我你他她它们也就都又用查看说跟对向从被将这那一个吗呢吧啊着过到去来上下中里后前再还很要会能可以及等而或'.split(''));
function expandToWord(text, from, to) {
  const segs = [...new Intl.Segmenter('zh', { granularity: 'word' }).segment(text)];
  const covering = segs.filter(s => s.index < to && s.index + s.segment.length > from);
  if (!covering.length) return null;
  let first = segs.indexOf(covering[0]), last = segs.indexOf(covering.at(-1));
  const len = () => [...segs.slice(first, last + 1).map(s => s.segment).join('')].length;
  const usable = s => s && s.isWordLike && !STOP.has(s.segment) && !/^[A-Za-z0-9]/.test(s.segment);
  const ascii = /^[A-Za-z0-9]/.test(covering[0].segment);
  if (!ascii) {
    // 先并入相邻的单字碎片，再并入相邻的双字词（左侧优先），总长不超过 4 字
    for (let grew = true; grew;) {
      grew = false;
      for (const side of [-1, 1]) {
        const s = segs[side < 0 ? first - 1 : last + 1];
        if (usable(s) && [...s.segment].length === 1 && len() + 1 <= 4) { side < 0 ? first-- : last++; grew = true; }
      }
    }
    for (const side of [-1, 1]) {
      const s = segs[side < 0 ? first - 1 : last + 1];
      if (usable(s) && [...s.segment].length === 2 && len() + 2 <= 4) side < 0 ? first-- : last++;
    }
  }
  const start = segs[first].index, end = segs[last].index + segs[last].segment.length;
  return { start, end, word: text.slice(start, end).trim() };
}
function correctionPairs(original, edited) {
  const a = String(original || '').slice(0, 1500), b = String(edited || '').slice(0, 1500);
  if (!a || !b) return [];
  const n = a.length, m = b.length, dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const spans = []; let i = 0, j = 0, cur = null;
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) { if (cur) { spans.push(cur); cur = null; } i++; j++; continue; }
    cur = cur || { ai: i, aj: i, bi: j, bj: j };
    if (j < m && (i >= n || dp[i][j + 1] >= dp[i + 1][j])) { j++; cur.bj = j; } else { i++; cur.aj = i; }
  }
  if (cur) spans.push(cur);
  const changed = spans.reduce((s, x) => s + Math.max(x.aj - x.ai, x.bj - x.bi), 0);
  if (!spans.length || spans.length > 4 || changed > a.length * 0.4) return [];
  const out = new Map();
  for (const s of spans) {
    const wrong = a.slice(s.ai, s.aj), right = b.slice(s.bi, s.bj);
    if (!right.trim() || wrong.length > 9 || right.length > 9 || Math.abs(wrong.length - right.length) > 3) continue;
    if (!/[一-鿿A-Za-z0-9]/.test(right)) continue;
    const w = expandToWord(b, s.bi, s.bj);
    if (!w || [...w.word].length < 2 || [...w.word].length > 16) continue;
    // 改动之外的字两边相同，按相对位置取出原文里对应的那段
    const origin = a.slice(Math.max(0, s.ai - (s.bi - w.start)), s.aj + (w.end - s.bj)).trim();
    if (origin && origin !== w.word) out.set(w.word, { wrong: origin, right: w.word });
  }
  return [...out.values()];
}

module.exports = { correctionPairs, cleanFillers, normalizeGlobal, cloudProfile, localBackground, recentFromTranscript, LIMITS };
