'use strict';
// 论坛热帖的 AI 摘要：把要写摘要的帖子编号成 P1、P2……连同标题和正文摘录交给 CodeAgent，
// 让它写「今日看点」和每帖一句话；回来的每一条都要指回一个真实编号，指不回的删掉（写法同助理简报 core/company-assistant/brief.js）。

const EXCERPT_CHARS = 1500;
const short = (s, n) => { s = String(s ?? '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n) + '…' : s; };

// 要写摘要的帖子：两站轮流挑，每站先挑排行靠前的，合计不超过 max 条，同一标题只算一次。
function pickForSummary(snapshot, max = 10) {
  const queues = (snapshot.sites || []).filter(s => s.ok).map(s => s.lists.flatMap(l => l.posts.map(p => ({ site: s.id, siteName: s.name, list: l.label, post: p }))));
  const out = [], seen = new Set();
  for (let round = 0; out.length < max && queues.some(q => q.length); round += 1) {
    for (const q of queues) {
      while (q.length) {
        const item = q.shift();
        const key = item.site + '|' + item.post.title;
        if (seen.has(key)) continue;
        seen.add(key); out.push(item); break;
      }
      if (out.length >= max) break;
    }
  }
  return out.map((x, i) => ({ ...x, source: 'P' + (i + 1) }));
}

function summaryPrompt(picked, { day } = {}) {
  const lines = [
    `今天是 ${day}。下面是公司内部论坛（稼先社区、心声社区）今天的热门帖子，每条带编号。请：`,
    '1. 写「今日看点」3–5 句：大家在讨论什么、有什么值得关注的趋势或争议。依据的编号只写进 sources，句子里不出现编号；只讲帖子内容，不评论摘录多少、数据全不全。',
    '2. 给每条帖子写一句话摘要（40 字以内），说清帖子讲了什么、结论或争议点是什么。只依据下面给出的标题和正文摘录，不补充外部信息；没有正文摘录的，依据标题写，并在摘要末尾加「（据标题）」。',
    '3. 不调用任何工具、不访问网络、不写文件，直接回答。',
    '只输出一段 JSON，不要别的文字：{"overview":[{"text":"一句看点","sources":["P1","P4"]}],"items":[{"source":"P1","summary":"一句话摘要"}]}',
    '',
  ];
  for (const x of picked) {
    const p = x.post, meta = [x.siteName + ' · ' + x.list, p.board, p.views != null ? `阅读 ${p.views}` : '', p.replies != null ? `回复 ${p.replies}` : ''].filter(Boolean).join('，');
    lines.push(`[${x.source}] ${p.title}（${meta}）`);
    if (p.excerpt) lines.push('正文摘录：' + short(p.excerpt, EXCERPT_CHARS));
    lines.push('');
  }
  return lines.join('\n');
}

function jsonIn(text) {
  const s = String(text || '');
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(s);
  const candidates = [fenced && fenced[1], s.slice(s.indexOf('{'), s.lastIndexOf('}') + 1)].filter(Boolean);
  for (const c of candidates) { try { const v = JSON.parse(c); if (v && typeof v === 'object') return v; } catch { /* 下一个 */ } }
  return null;
}

// CodeAgent 的回答 → { overview, items: Map(source → summary), dropped }。读不出来返回 null。
function parseSummary(text, picked) {
  const data = jsonIn(text);
  if (!data) return null;
  const known = new Set(picked.map(x => x.source));
  let dropped = 0;
  const items = {};
  for (const it of Array.isArray(data.items) ? data.items : []) {
    const source = String(it && it.source || '').trim().toUpperCase(), summary = short(it && it.summary, 120);
    if (!summary) continue;
    if (!known.has(source)) { dropped += 1; continue; }
    items[source] = summary;
  }
  const overview = [];
  for (const o of Array.isArray(data.overview) ? data.overview : []) {
    const textOf = short(typeof o === 'string' ? o : o && o.text, 200);
    const sources = [...new Set((Array.isArray(o && o.sources) ? o.sources : String(textOf).match(/P\d+/g) || []).map(s => String(s).trim().toUpperCase()))];
    const good = sources.filter(s => known.has(s));
    if (!textOf) continue;
    if (!good.length) { dropped += 1; continue; }
    // 句子里残留的编号（[P1]、P1、P3）去掉：编号只用来核对出处，页面上用「稼先 1」这样的标签显示。
    const plain = textOf.replace(/\[P\d+\]/g, '').replace(/P\d+(?:\s*[、,，和与及]\s*P\d+)*/g, '').replace(/[（(]\s*[)）]/g, '').replace(/\s+([，。；])/g, '$1').replace(/([一-鿿])\s+(?=[一-鿿])/g, '$1').replace(/\s{2,}/g, ' ').trim();
    if (plain) overview.push({ text: plain, sources: good });
  }
  return { overview: overview.slice(0, 6), items, dropped };
}

module.exports = { pickForSummary, summaryPrompt, parseSummary, jsonIn };
