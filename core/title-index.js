'use strict';

const { matchesSearchProvider } = require('./session-search-providers');

/**
 * 标题即时检索层。
 *
 * 2026-08-28：用户的诉求是「侧栏这 682 个标题，随便搜什么都要 1 秒内出来」。
 * 这 682 个标题加起来只有 **10 KB**，而且渲染层本来就把它们放在内存里
 * （renderer.js 的 sessions Map + meetings）。所以标题检索：
 *
 *   - 不需要索引：682 次 indexOf 是微秒级
 *   - 不需要 IPC：数据就在渲染进程里，不用往主进程跑一趟
 *   - 不需要等 SQLite 全文索引建好：冷启动第一秒就能用
 *
 * 全文检索（正文 / 工具输出，686MB）仍然走 core/session-search-sqlite-index.js，
 * 那一层是异步的、可能还在建索引。两层合并的策略见
 * renderer/global-session-search.js：标题层先出，全文层回来再合。
 *
 * 放在 core/ 而不是塞进 renderer 是为了能单测。
 */

const FULL_MATCH_SCORE = 1000;
const PREFIX_SCORE = 500;
const SUBSTRING_SCORE = 200;
const TERM_SCORE = 60;
const TERM_HEAD_BONUS = 30;
const DEFAULT_LIMIT = 50;
const { documentRank, compareResults, normalizeSort, rankReason } = require('./session-search-ranking');

function normalizeTitleText(value) {
  return String(value == null ? '' : value)
    .normalize('NFKC')
    .toLocaleLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function titleQueryTerms(value) {
  return [...new Set(normalizeTitleText(value).split(' ').filter(Boolean))];
}

/**
 * entries: [{ key, title, provider, cwd, projectLabel, updatedAt, hubSessionId, meetingId, kind }]
 * 只做一次归一化，之后每次按键都复用。
 */
function buildTitleIndex(entries) {
  const out = [];
  const seen = new Set();
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (!entry || typeof entry !== 'object') continue;
    const title = String(entry.title || '').trim();
    if (!title) continue;
    // key 缺失时用 hubSessionId / meetingId 兜底，保证去重和后续能打开
    const key = String(entry.key || entry.hubSessionId || entry.meetingId || '');
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push({
      ...entry,
      key,
      title,
      normalizedTitle: normalizeTitleText(title),
    });
  }
  return out;
}

/** 命中则返回分数，未命中返回 -1（要求所有词都出现，与全文检索的 AND 语义一致）。 */
function scoreTitle(normalizedTitle, terms, normalizedQuery) {
  if (!normalizedTitle) return -1;
  let score = 0;
  for (const term of terms) {
    const at = normalizedTitle.indexOf(term);
    if (at < 0) return -1;
    score += TERM_SCORE;
    if (at === 0) score += TERM_HEAD_BONUS;
    // 越靠前越相关，但衰减很快，别让长标题里的偶然位置主导排序
    score += Math.max(0, 20 - at);
  }
  if (normalizedQuery) {
    if (normalizedTitle === normalizedQuery) score += FULL_MATCH_SCORE;
    else if (normalizedTitle.startsWith(normalizedQuery)) score += PREFIX_SCORE;
    else if (normalizedTitle.includes(normalizedQuery)) score += SUBSTRING_SCORE;
  }
  // 同样命中时短标题更可能是用户想要的那个
  score += Math.max(0, 40 - normalizedTitle.length) / 4;
  return score;
}

/**
 * 返回与全文检索结果同形状的条目，好让 UI 用同一套渲染。
 * 单字查询也支持 —— 682 条数据没有任何理由要求最少两个字。
 */
function searchTitles(index, query, options = {}) {
  const limit = Math.max(1, Number(options.limit) || DEFAULT_LIMIT);
  const normalizedQuery = normalizeTitleText(query);
  const terms = titleQueryTerms(query);
  if (!terms.length) return [];
  const providers = Array.isArray(options.providers) ? options.providers.map(String) : [];
  const since = Number.isFinite(options.since) && options.since > 0 ? options.since : null;

  const hits = [];
  for (const entry of Array.isArray(index) ? index : []) {
    if (!matchesSearchProvider(entry.provider, providers)) continue;
    const updatedAt = Number(entry.updatedAt) || 0;
    if (since !== null && updatedAt < since) continue;
    const score = scoreTitle(entry.normalizedTitle, terms, normalizedQuery);
    if (score < 0) continue;
    hits.push({ entry, score, updatedAt });
  }
  hits.sort((left, right) => right.score - left.score || right.updatedAt - left.updatedAt);

  const sort = normalizeSort(options.sort, query);
  const direction = options.direction || (options.sort === 'title' ? 'asc' : 'desc');
  return hits.map(({ entry, updatedAt }) => {
    // Ranking also normalizes and scans the title. The explanatory label uses
    // that same rank; computing it again doubles this work on every keypress.
    const rank = documentRank({ scope: 'title', text: entry.title }, normalizedQuery, terms);
    return {
    key: entry.key,
    sessionKey: entry.key,
    hubSessionId: entry.hubSessionId || null,
    meetingId: entry.meetingId || null,
    provider: entry.provider || 'unknown',
    kind: entry.kind || null,
    title: entry.title,
    cwd: entry.cwd || null,
    projectLabel: entry.projectLabel || null,
    updatedAt,
    lastConversationAt: Number(entry.lastConversationAt || entry.lastMessageTime || entry.lastCompletedAt) || null,
    newestMatchedEventAt: null,
    rank,
    matchReasons: rankReason(rank, true),
    matchCount: 1,
    titleOnly: true,
    bestMatch: {
      eventId: null,
      scope: 'title',
      role: 'title',
      speaker: null,
      timestamp: null,
      ordinal: 0,
      text: entry.title,
    },
    };
  }).sort((a,b) => compareResults(a,b,sort,direction)).slice(0,limit);
}

/** 两条结果指的是不是同一个会话。全文层与标题层合并时去重用。 */
function sameSession(left, right) {
  if (!left || !right) return false;
  if (left.hubSessionId && right.hubSessionId) return String(left.hubSessionId) === String(right.hubSessionId);
  if (left.meetingId && right.meetingId) return String(left.meetingId) === String(right.meetingId);
  if (left.sessionKey && right.sessionKey) return String(left.sessionKey) === String(right.sessionKey);
  return false;
}

/**
 * 全文结果在前（信息更丰富），标题层里全文没覆盖到的补在后面。
 * 冷启动时全文层可能是空的，这时整张列表就是标题层 —— 用户照样立刻有结果。
 */
function mergeTitleHits(fullTextResults, titleHits, limit = DEFAULT_LIMIT) {
  const merged = Array.isArray(fullTextResults) ? fullTextResults.slice() : [];
  const extras = [];
  for (const hit of Array.isArray(titleHits) ? titleHits : []) {
    if (merged.some(existing => sameSession(existing, hit))) continue;
    if (extras.some(existing => sameSession(existing, hit))) continue;
    extras.push(hit);
  }
  return { results: merged.concat(extras).slice(0, limit), titleOnlyCount: extras.length };
}

module.exports = {
  DEFAULT_LIMIT,
  buildTitleIndex,
  mergeTitleHits,
  normalizeTitleText,
  sameSession,
  scoreTitle,
  searchTitles,
  titleQueryTerms,
};
