'use strict';
// Hub 自动核对回答里的出处（v3.1.2）。
// 模型没有走 ppt_library op=report 时，回答里仍可能写「文件名.pptx · 第 N 页」；
// Hub 按素材索引里的文件和页数核对这类引用，只回答“这份文稿有没有这一页”，
// 不判断页面内容是否支持结论（内容判断仍以 report 的逐页原文核对为准）。
const FILE = /([^\s|,，。；：、（）()【】\[\]<>《》「」“”"'`*]+\.pptx?)/gi;
const PAGE = /第\s*(\d{1,4})\s*页|[Pp]\s*(\d{1,4})\b/;
// 同一行里文件后 60 字内出现页码才算一处引用；跨行的「文件 + 页码」不合并，避免把正文数字当页码。
const LOOKAHEAD = 60;
const baseName = value => String(value || '').replace(/\\/g, '/').split('/').pop().trim();
const normalize = value => baseName(value).toLowerCase();

function extractCitations(text) {
  const seen = new Set(), out = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    FILE.lastIndex = 0;
    let match;
    while ((match = FILE.exec(line))) {
      const name = baseName(match[1]);
      if (!name) continue;
      const page = PAGE.exec(line.slice(match.index + match[0].length, match.index + match[0].length + LOOKAHEAD));
      if (!page) continue;
      const pageNo = Number(page[1] || page[2]);
      if (!Number.isInteger(pageNo) || pageNo < 1) continue;
      const key = normalize(name) + ':' + pageNo;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ name, page: pageNo });
    }
  }
  return out;
}

// documents: Map（规范化路径 → { name, path, pages }）或同样的普通对象值数组。
function checkCitations(citations, documents) {
  const values = documents instanceof Map ? [...documents.values()] : Array.isArray(documents) ? documents : [];
  const byName = new Map();
  for (const doc of values) {
    const name = normalize(doc.name || doc.path);
    if (!name) continue;
    if (!byName.has(name)) byName.set(name, doc);
  }
  const problems = [];
  let verified = 0;
  for (const cite of citations) {
    const want = normalize(cite.name);
    // 回答里可能多写了前后缀（文件夹名、编号、说明词），按包含关系再认一次；太短的名字不模糊匹配，防止误认。
    const doc = byName.get(want) || (want.length >= 8 ? values.find(d => {
      const name = normalize(d.name || d.path);
      return name.length >= 8 && (name.endsWith(want) || want.endsWith(name));
    }) : null);
    if (!doc) { problems.push({ ...cite, reason: 'missing' }); continue; }
    const pages = Number(doc.pages ?? doc.page_count ?? 0);
    if (Number.isInteger(pages) && pages > 0 && cite.page > pages) { problems.push({ ...cite, reason: 'out-of-range', pageCount: pages }); continue; }
    verified += 1;
  }
  return { total: citations.length, verified, problems };
}

function renderCitationCheck(result) {
  const { total, verified, problems } = result || {};
  if (!total) return '';
  const lines = [`**Hub 自动核对出处：** 回答里引用了 ${total} 页，其中 ${verified} 页和素材索引对得上。`];
  for (const p of problems || []) {
    lines.push(p.reason === 'out-of-range'
      ? `- ${p.name} · 第 ${p.page} 页：索引里这份文稿只有 ${p.pageCount} 页。`
      : `- ${p.name} · 第 ${p.page} 页：本次索引里没有这份文稿（可能不在已选的素材文件夹里）。`);
  }
  lines.push('只核对了文件与页码是否存在，没有判断页面内容是否支持结论。');
  return lines.join('\n');
}

module.exports = { extractCitations, checkCitations, renderCitationCheck, normalize };
