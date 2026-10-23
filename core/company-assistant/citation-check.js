'use strict';
// Hub 自动核对回答里的出处（v3.1.2）。
// 模型没有走 ppt_library op=report 时，回答里仍可能写「文件名.pptx · 第 N 页」；
// Hub 按素材索引里的文件和页数核对这类引用，只回答“这份文稿有没有这一页”，
// 不判断页面内容是否支持结论（内容判断仍以 report 的逐页原文核对为准）。
const FILE = /"([^"\r\n]+\.pptx?)"|`([^`\r\n]+\.pptx?)`|((?:[A-Za-z]:[\\/])?[^\s|,，。；：、（）()【】\[\]<>《》「」“”"'`*]+\.pptx?)/gi;
const PAGE = /第\s*(\d{1,4})\s*页|[Pp]\s*(\d{1,4})\b/;
// 同一行里文件后 60 字内出现页码才算一处引用；跨行的「文件 + 页码」不合并，避免把正文数字当页码。
const LOOKAHEAD = 60;
const baseName = value => String(value || '').replace(/\\/g, '/').split('/').pop().trim();
const normalize = value => baseName(value).toLowerCase();
const normalizePath = value => String(value || '').trim().replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

function extractCitations(text) {
  const seen = new Set(), out = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const matches = [...line.matchAll(FILE)];
    for (let i = 0; i < matches.length; i += 1) {
      const match = matches[i];
      const file = match[1] || match[2] || match[3];
      const name = baseName(file);
      if (!name) continue;
      const end = match.index + match[0].length;
      const page = PAGE.exec(line.slice(end, Math.min(end + LOOKAHEAD, matches[i + 1]?.index ?? line.length)));
      if (!page) continue;
      const pageNo = Number(page[1] || page[2]);
      if (!Number.isInteger(pageNo) || pageNo < 1) continue;
      const filePath = /[\\/]/.test(file) ? file : null;
      const key = normalizePath(filePath || name) + ':' + pageNo;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ name, ...(filePath ? { path: filePath } : {}), page: pageNo });
    }
  }
  return out;
}

// documents: Map（规范化路径 → { name, path, pages }）或同样的普通对象值数组。
function checkCitations(citations, documents) {
  const values = documents instanceof Map ? [...documents.values()] : Array.isArray(documents) ? documents : [];
  const byName = new Map(), byPath = new Map();
  for (const doc of values) {
    const name = normalize(doc.name || doc.path);
    if (!name) continue;
    if (!byName.has(name)) byName.set(name, []);
    byName.get(name).push(doc);
    if (doc.path) {
      const full = normalizePath(doc.path);
      if (!byPath.has(full)) byPath.set(full, []);
      byPath.get(full).push(doc);
    }
  }
  const problems = [];
  let verified = 0;
  for (const cite of citations) {
    const want = normalize(cite.name);
    // 回答里可能多写了前后缀（文件夹名、编号、说明词），按包含关系再认一次；太短的名字不模糊匹配，防止误认。
    const explicitPath = cite.path || (/[\\/]/.test(cite.name) ? cite.name : null);
    const candidates = explicitPath ? (byPath.get(normalizePath(explicitPath)) || []) : byName.get(want) || (want.length >= 8 ? values.filter(d => {
      const name = normalize(d.name || d.path);
      return name.length >= 8 && (name.endsWith(want) || want.endsWith(name));
    }) : []);
    if (candidates.length > 1) { problems.push({ ...cite, reason: 'ambiguous' }); continue; }
    const doc = candidates[0];
    if (!doc) { problems.push({ ...cite, reason: 'missing' }); continue; }
    const pages = Number(doc.pages ?? doc.page_count ?? 0);
    if (!Number.isInteger(pages) || pages <= 0) { problems.push({ ...cite, reason: 'unknown-pages' }); continue; }
    if (!Number.isInteger(cite.page) || cite.page < 1) { problems.push({ ...cite, reason: 'invalid-page' }); continue; }
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
      : p.reason === 'ambiguous' ? `- ${p.name} · 第 ${p.page} 页：索引里有多份同名文稿，请提供完整路径后核对。`
      : p.reason === 'unknown-pages' ? `- ${p.name} · 第 ${p.page} 页：索引中页数未知，暂时无法核对。`
      : p.reason === 'invalid-page' ? `- ${p.name}：引用页码无效。`
      : `- ${p.name} · 第 ${p.page} 页：本次索引里没有这份文稿（可能不在已选的素材文件夹里）。`);
  }
  lines.push('只核对了文件与页码是否存在，没有判断页面内容是否支持结论。');
  return lines.join('\n');
}

module.exports = { extractCitations, checkCitations, renderCitationCheck, normalize };
