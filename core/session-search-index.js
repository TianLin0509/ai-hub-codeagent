'use strict';

const { matchesSearchProvider } = require('./session-search-providers');

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;
const MAX_QUERY_LENGTH = 512;
const PREVIEW_TEXT_LIMIT = 12_000;
const MAX_DOCUMENT_TEXT_CHARS = 64 * 1024;
const MAX_KEYS_PER_DOCUMENT = 20_000;
const MAX_UNIQUE_INDEX_KEYS = 500_000;
const MAX_POSTING_ENTRIES = 1_000_000;

const SCOPE_WEIGHTS = Object.freeze({
  title: 18,
  user: 10,
  assistant: 7,
  tool: 4,
});

function normalizeSearchText(value) {
  return String(value == null ? '' : value)
    .normalize('NFKC')
    .toLocaleLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function queryTerms(value) {
  return [...new Set(normalizeSearchText(value).split(/\s+/).filter(Boolean))];
}

function indexKeysForTerm(rawTerm) {
  const term = normalizeSearchText(rawTerm).replace(/\s+/g, '');
  if (!term) return [];
  const chars = Array.from(term);
  const hasCjk = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(term);
  const prefix = hasCjk ? 'c:' : 'a:';
  const width = hasCjk ? 2 : (chars.length >= 3 ? 3 : chars.length);
  if (width <= 0) return [];
  if (chars.length <= width) return [`${prefix}${term}`];
  const out = [];
  for (let i = 0; i <= chars.length - width; i += 1) {
    out.push(`${prefix}${chars.slice(i, i + width).join('')}`);
  }
  return out;
}

function indexKeysForText(value) {
  const text = normalizeSearchText(value);
  if (!text) return [];
  // Keep CJK and alphabetic/path runs in separate segments. Using \p{L} for
  // the second branch also absorbs Han characters, so an identifier followed
  // by Chinese prose (`EADDRINUSE：端口`) was indexed as CJK bigrams while the
  // query used ASCII trigrams and could never match.
  const segments = text.match(
    /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+|[\p{Script=Latin}\p{Script=Cyrillic}\p{Script=Greek}\p{N}_./:\\-]+/gu,
  ) || [];
  const keys = new Set();
  for (const segment of segments) {
    for (const key of indexKeysForTerm(segment)) keys.add(key);
  }
  return [...keys];
}

function countOccurrences(text, term, cap = 8) {
  if (!text || !term) return 0;
  let count = 0;
  let cursor = 0;
  while (count < cap) {
    const hit = text.indexOf(term, cursor);
    if (hit < 0) break;
    count += 1;
    cursor = hit + Math.max(1, term.length);
  }
  return count;
}

function createSnippet(text, terms, maxLength = 300) {
  const raw = String(text || '').replace(/\s+/g, ' ').trim();
  if (raw.length <= maxLength) return raw;
  const lower = normalizeSearchText(raw);
  let firstHit = -1;
  for (const term of terms) {
    const hit = lower.indexOf(term);
    if (hit >= 0 && (firstHit < 0 || hit < firstHit)) firstHit = hit;
  }
  const half = Math.floor(maxLength / 2);
  const start = Math.max(0, firstHit < 0 ? 0 : firstHit - half);
  const end = Math.min(raw.length, start + maxLength);
  return `${start > 0 ? '…' : ''}${raw.slice(start, end)}${end < raw.length ? '…' : ''}`;
}

function normalizeProviderFilter(value) {
  if (!Array.isArray(value)) return null;
  const normalized = value.map(normalizeSearchText).filter(Boolean).filter(item => item !== 'all');
  return normalized.length ? new Set(normalized) : null;
}

function normalizeScopeFilter(value) {
  const known = new Set(Object.keys(SCOPE_WEIGHTS));
  if (!Array.isArray(value)) return null;
  const normalized = value.map(normalizeSearchText).filter(item => known.has(item));
  return normalized.length && normalized.length < known.size ? new Set(normalized) : null;
}

function sinceTimestamp(timeRange, now = Date.now()) {
  const day = 24 * 60 * 60 * 1000;
  if (timeRange === '24h') return now - day;
  if (timeRange === '3d') return now - 3 * day;
  if (timeRange === '7d') return now - 7 * day;
  if (timeRange === '30d') return now - 30 * day;
  if (timeRange === '365d') return now - 365 * day;
  return null;
}

function safeTimestamp(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function trimPreviewText(text, terms) {
  const raw = String(text || '');
  if (raw.length <= PREVIEW_TEXT_LIMIT) return { text: raw, truncated: false };
  const normalized = normalizeSearchText(raw);
  let hit = -1;
  for (const term of terms) {
    const at = normalized.indexOf(term);
    if (at >= 0 && (hit < 0 || at < hit)) hit = at;
  }
  const before = Math.floor(PREVIEW_TEXT_LIMIT * 0.38);
  const start = Math.max(0, hit < 0 ? 0 : hit - before);
  const end = Math.min(raw.length, start + PREVIEW_TEXT_LIMIT);
  return {
    text: `${start > 0 ? '…' : ''}${raw.slice(start, end)}${end < raw.length ? '…' : ''}`,
    truncated: true,
  };
}

function boundDocumentText(value, maxChars = MAX_DOCUMENT_TEXT_CHARS) {
  const text = String(value || '');
  if (text.length <= maxChars) return { text, truncated: false };
  const head = Math.floor(maxChars / 2);
  const tail = maxChars - head;
  return { text: `${text.slice(0, head)}\n…[索引文本已截断]…\n${text.slice(-tail)}`, truncated: true };
}

function selectedIndexKeysForText(value) {
  const text = String(value || '');
  const boundaryKeys = new Set([
    ...indexKeysForText(text.slice(0, 4_096)),
    ...indexKeysForText(text.slice(-4_096)),
  ]);
  const priority = [...boundaryKeys].slice(0, MAX_KEYS_PER_DOCUMENT);
  if (priority.length >= MAX_KEYS_PER_DOCUMENT) return priority;
  const allKeys = indexKeysForText(text);
  if (allKeys.length <= MAX_KEYS_PER_DOCUMENT) return allKeys;
  const selected = new Set(priority);
  const remaining = MAX_KEYS_PER_DOCUMENT - selected.size;
  const head = Math.floor(remaining / 2);
  for (const key of allKeys.slice(0, head)) selected.add(key);
  for (const key of allKeys.slice(-remaining)) {
    if (selected.size >= MAX_KEYS_PER_DOCUMENT) break;
    selected.add(key);
  }
  return [...selected];
}

class SessionSearchIndex {
  constructor(sources = []) {
    this.replaceSources(sources);
  }

  replaceSources(sources = []) {
    this.sources = Array.isArray(sources) ? sources.filter(Boolean) : [];
    this._sourceByKey = new Map();
    this.documents = [];
    this.postings = new Map();
    this.sessionByKey = new Map();
    this.documentIndicesBySession = new Map();
    this.documentIndexByEvent = new Map();
    this.documentIndicesBySource = new Map();
    this.providerSessionCounts = new Map();
    this.inactiveDocumentCount = 0;
    this.postingEntryCount = 0;
    this.guardedDocumentCount = 0;

    for (const source of this.sources) {
      this._addSource(source);
    }

    this._sortSessionDocuments();
  }

  _addSource(source) {
    if (!source || !source.key || source.searchable === false || !source.session || !source.session.key) return;
    const session = { ...source.session };
    this._sourceByKey.set(source.key, source);
    this.sessionByKey.set(session.key, session);
    if (!this.documentIndicesBySession.has(session.key)) this.documentIndicesBySession.set(session.key, []);
    const sourceIndices = [];
    for (const rawDoc of (Array.isArray(source.docs) ? source.docs : [])) {
      if (!rawDoc || !rawDoc.text || !SCOPE_WEIGHTS[rawDoc.scope]) continue;
      const boundedText = boundDocumentText(rawDoc.text);
      const normalizedText = normalizeSearchText(boundedText.text);
      if (!normalizedText) continue;
      const index = this.documents.length;
      const doc = {
        ...rawDoc,
        text: boundedText.text,
        truncated: rawDoc.truncated === true || boundedText.truncated,
        active: true,
        sourceKey: source.key,
        sessionKey: session.key,
        provider: session.provider || 'unknown',
        normalizedText,
        indexGuarded: boundedText.truncated,
        timestamp: safeTimestamp(rawDoc.timestamp, safeTimestamp(session.updatedAt)),
        ordinal: Number.isInteger(rawDoc.ordinal) ? rawDoc.ordinal : index,
      };
      this.documents.push(doc);
      sourceIndices.push(index);
      this.documentIndicesBySession.get(session.key).push(index);
      const eventMapKey = `${session.key}\0${String(doc.eventId || doc.id || '')}`;
      if (!this.documentIndexByEvent.has(eventMapKey)) this.documentIndexByEvent.set(eventMapKey, index);
      if (boundedText.truncated) this.guardedDocumentCount += 1;
      let documentPostingEntries = 0;
      for (const key of selectedIndexKeysForText(doc.text)) {
        if (documentPostingEntries >= MAX_KEYS_PER_DOCUMENT || this.postingEntryCount >= MAX_POSTING_ENTRIES) break;
        if (!this.postings.has(key)) {
          if (this.postings.size >= MAX_UNIQUE_INDEX_KEYS) continue;
          this.postings.set(key, []);
        }
        this.postings.get(key).push(index);
        documentPostingEntries += 1;
        this.postingEntryCount += 1;
      }
    }
    this.documentIndicesBySource.set(source.key, sourceIndices);
    const provider = session.provider || 'unknown';
    this.providerSessionCounts.set(provider, (this.providerSessionCounts.get(provider) || 0) + 1);
  }

  _removeSource(sourceKey) {
    const source = this._sourceByKey.get(sourceKey);
    if (!source || !source.session) return false;
    const sessionKey = source.session.key;
    const provider = source.session.provider || 'unknown';
    for (const index of (this.documentIndicesBySource.get(sourceKey) || [])) {
      const doc = this.documents[index];
      if (!doc || doc.active === false) continue;
      for (const key of selectedIndexKeysForText(doc.text)) {
        const posting = this.postings.get(key);
        if (!posting) continue;
        const position = posting.indexOf(index);
        if (position >= 0) {
          posting.splice(position, 1);
          this.postingEntryCount = Math.max(0, this.postingEntryCount - 1);
        }
        if (posting.length === 0) this.postings.delete(key);
      }
      if (doc.indexGuarded) this.guardedDocumentCount = Math.max(0, this.guardedDocumentCount - 1);
      doc.active = false;
      this.inactiveDocumentCount += 1;
      const eventMapKey = `${sessionKey}\0${String(doc.eventId || doc.id || '')}`;
      if (this.documentIndexByEvent.get(eventMapKey) === index) this.documentIndexByEvent.delete(eventMapKey);
    }
    this.documentIndicesBySource.delete(sourceKey);
    this.documentIndicesBySession.delete(sessionKey);
    this.sessionByKey.delete(sessionKey);
    this._sourceByKey.delete(sourceKey);
    const nextCount = Math.max(0, (this.providerSessionCounts.get(provider) || 1) - 1);
    if (nextCount) this.providerSessionCounts.set(provider, nextCount);
    else this.providerSessionCounts.delete(provider);
    return true;
  }

  _sortSessionDocuments(sessionKeys = null) {
    const keys = sessionKeys || this.documentIndicesBySession.keys();
    for (const sessionKey of keys) {
      const indices = this.documentIndicesBySession.get(sessionKey);
      if (!indices) continue;
      indices.sort((left, right) => {
        const a = this.documents[left];
        const b = this.documents[right];
        return a.ordinal - b.ordinal || a.timestamp - b.timestamp;
      });
    }
  }

  updateSources(changedSources = [], removedSourceKeys = []) {
    const changed = Array.isArray(changedSources) ? changedSources.filter(Boolean) : [];
    const removed = new Set([...(removedSourceKeys || []), ...changed.map(source => source.key)]);
    for (const key of removed) this._removeSource(key);
    for (const source of changed) this._addSource(source);
    this._sortSessionDocuments(changed.map(source => source.session && source.session.key).filter(Boolean));
    this.sources = [...this._sourceByKey.values()];

    const compactThreshold = Math.max(256, Math.floor(this.documents.length * 0.15));
    if (this.inactiveDocumentCount > compactThreshold) {
      const activeSources = this.sources.slice();
      this.replaceSources(activeSources);
      return { compacted: true, changed: changed.length, removed: removedSourceKeys.length };
    }
    return { compacted: false, changed: changed.length, removed: removedSourceKeys.length };
  }

  getStats() {
    return {
      sessions: this.sessionByKey.size,
      documents: this.documents.length - this.inactiveDocumentCount,
      inactiveDocuments: this.inactiveDocumentCount,
      terms: this.postings.size,
      providers: Object.fromEntries(this.providerSessionCounts),
      postingEntries: this.postingEntryCount,
      guardedDocuments: this.guardedDocumentCount,
    };
  }

  _candidateIndices(terms) {
    const keys = [...new Set(terms.flatMap(indexKeysForTerm))];
    if (!keys.length) return this.documents.map((_doc, index) => index);
    const lists = [];
    for (const key of keys) {
      const posting = this.postings.get(key);
      if (!posting || !posting.length) return [];
      lists.push(posting);
    }
    lists.sort((a, b) => a.length - b.length);
    let candidates = new Set(lists[0]);
    for (let i = 1; i < lists.length && candidates.size; i += 1) {
      const allowed = new Set(lists[i]);
      candidates = new Set([...candidates].filter(index => allowed.has(index)));
    }
    return [...candidates];
  }

  _scoreDocument(doc, terms, rawQuery, now) {
    let score = SCOPE_WEIGHTS[doc.scope] || 1;
    const normalizedQuery = normalizeSearchText(rawQuery);
    if (normalizedQuery && doc.normalizedText.includes(normalizedQuery)) score += 12;
    if (doc.scope === 'title' && doc.normalizedText === normalizedQuery) score += 20;
    if (doc.scope === 'title' && doc.normalizedText.startsWith(normalizedQuery)) score += 8;
    for (const term of terms) score += Math.min(8, countOccurrences(doc.normalizedText, term)) * 1.4;
    const ageDays = Math.max(0, now - doc.timestamp) / (24 * 60 * 60 * 1000);
    score += 3 / (1 + ageDays / 120);
    return score;
  }

  search(request = {}) {
    const startedAt = Date.now();
    const rawInput = String(request.query || '');
    if (rawInput.length > MAX_QUERY_LENGTH) {
      return {
        results: [], totalSessions: 0, totalMatches: 0, truncated: false,
        facets: { providers: {}, scopes: {}, projects: [] },
        queryMs: Date.now() - startedAt,
        index: this.getStats(),
        error: `搜索关键词过长（最多 ${MAX_QUERY_LENGTH} 个字符）`,
      };
    }
    const rawQuery = rawInput.trim();
    const terms = queryTerms(rawQuery);
    if (normalizeSearchText(rawQuery).length < 2 || !terms.length) {
      return {
        results: [], totalSessions: 0, totalMatches: 0, truncated: false,
        facets: { providers: {}, scopes: {}, projects: [] },
        queryMs: Date.now() - startedAt,
        index: this.getStats(),
      };
    }

    const providers = normalizeProviderFilter(request.providers);
    const scopes = normalizeScopeFilter(request.scopes);
    const since = sinceTimestamp(request.timeRange, startedAt);
    const project = normalizeSearchText(request.project || '');
    const sort = request.sort === 'recent' ? 'recent' : 'relevance';
    const limit = Math.min(MAX_LIMIT, Math.max(1, Number(request.limit) || DEFAULT_LIMIT));
    const baseGroups = new Map();
    const providerFacet = new Map();
    const scopeFacet = new Map();
    const projectFacet = new Map();
    let totalMatches = 0;

    // “全部内容”按 session 搜索，而不是强迫所有词出现在同一条消息里。
    // 例如标题含“卡片”、回答含“公式”时，查询“卡片 公式”仍应命中该会话；
    // 选择“只搜回答”后则要求所有词都由回答文档覆盖。
    const candidateSet = new Set();
    for (const term of terms) {
      for (const index of this._candidateIndices([term])) candidateSet.add(index);
    }
    for (const index of candidateSet) {
      const doc = this.documents[index];
      if (!doc || doc.active === false) continue;
      const matchedTerms = terms.filter(term => doc.normalizedText.includes(term));
      if (!matchedTerms.length) continue;
      const session = this.sessionByKey.get(doc.sessionKey);
      if (!session) continue;
      if (since !== null && doc.timestamp < since) continue;
      const searchableProject = normalizeSearchText(`${session.projectLabel || ''} ${session.cwd || ''}`);
      if (project && !searchableProject.includes(project)) continue;
      const score = this._scoreDocument(doc, terms, rawQuery, startedAt);
      let group = baseGroups.get(doc.sessionKey);
      if (!group) {
        group = { session, matches: [], matchedTerms: new Set() };
        baseGroups.set(doc.sessionKey, group);
      }
      group.matches.push({ doc, score, matchedTerms });
      for (const term of matchedTerms) group.matchedTerms.add(term);
    }

    const coversAllTerms = matches => {
      const covered = new Set();
      for (const match of matches) for (const term of match.matchedTerms) covered.add(term);
      return terms.every(term => covered.has(term));
    };
    const validBaseGroups = [...baseGroups.values()].filter(group => group.matchedTerms.size === terms.length);
    for (const group of validBaseGroups) {
      const provider = group.session.provider || 'unknown';
      providerFacet.set(provider, (providerFacet.get(provider) || 0) + 1);
      const projectLabel = group.session.projectLabel || group.session.cwd || '';
      if (projectLabel) projectFacet.set(projectLabel, (projectFacet.get(projectLabel) || 0) + 1);
      for (const scope of Object.keys(SCOPE_WEIGHTS)) {
        if (coversAllTerms(group.matches.filter(match => match.doc.scope === scope))) {
          scopeFacet.set(scope, (scopeFacet.get(scope) || 0) + 1);
        }
      }
    }

    const ranked = [];
    for (const baseGroup of validBaseGroups) {
      if (providers && !matchesSearchProvider(baseGroup.session.provider, [...providers])) continue;
      const matches = scopes
        ? baseGroup.matches.filter(match => scopes.has(match.doc.scope))
        : baseGroup.matches.slice();
      if (!coversAllTerms(matches)) continue;
      totalMatches += matches.length;
      const group = {
        session: baseGroup.session,
        matches,
        bestScore: Math.max(...matches.map(match => match.score)),
        newestMatchAt: Math.max(...matches.map(match => match.doc.timestamp)),
      };
      ranked.push(group);
    }
    for (const group of ranked) {
      group.matches.sort((a, b) => b.score - a.score || b.doc.timestamp - a.doc.timestamp);
      group.groupScore = group.bestScore + Math.log2(1 + group.matches.length) * 2;
    }
    ranked.sort((a, b) => sort === 'recent'
      ? b.newestMatchAt - a.newestMatchAt || b.groupScore - a.groupScore
      : b.groupScore - a.groupScore || b.newestMatchAt - a.newestMatchAt);

    const results = ranked.slice(0, limit).map((group) => {
      const best = group.matches[0].doc;
      const session = group.session;
      return {
        sessionKey: session.key,
        provider: session.provider,
        nativeFamily: session.nativeFamily || null,
        kind: session.kind || null,
        title: session.title || '未命名会话',
        cwd: session.cwd || null,
        projectLabel: session.projectLabel || null,
        model: session.model || null,
        updatedAt: safeTimestamp(session.updatedAt, group.newestMatchAt),
        hubSessionId: session.hubSessionId || null,
        nativeSessionId: session.nativeSessionId || null,
        meetingId: session.meetingId || null,
        transcriptPath: session.transcriptPath || null,
        codexSessionsRoot: session.codexSessionsRoot || null,
        codexProfile: session.codexProfile || null,
        turnCount: Number(session.turnCount) || 0,
        matchCount: group.matches.length,
        bestMatch: {
          eventId: best.eventId || best.id || null,
          scope: best.scope,
          role: best.role || null,
          speaker: best.speaker || null,
          timestamp: best.timestamp,
          ordinal: best.ordinal,
          text: createSnippet(best.text, terms),
        },
      };
    });

    const projects = [...projectFacet.entries()]
      .map(([label, count]) => ({ label, count }))
      .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label, 'zh-CN'))
      .slice(0, 40);

    return {
      results,
      totalSessions: ranked.length,
      totalMatches,
      truncated: ranked.length > limit,
      facets: {
        providers: Object.fromEntries(providerFacet),
        scopes: Object.fromEntries(scopeFacet),
        projects,
      },
      queryMs: Date.now() - startedAt,
      index: this.getStats(),
    };
  }

  preview(request = {}) {
    const sessionKey = String(request.sessionKey || '');
    const session = this.sessionByKey.get(sessionKey);
    if (!session) return null;
    const indices = this.documentIndicesBySession.get(sessionKey) || [];
    const allDocs = indices.map(index => this.documents[index]);
    const titleDoc = allDocs.find(doc => doc.scope === 'title') || null;
    const dialogue = allDocs.filter(doc => doc.scope !== 'title');
    const terms = queryTerms(String(request.query || '').slice(0, MAX_QUERY_LENGTH));
    const eventId = String(request.eventId || '');
    const requestedDoc = allDocs.find(doc => String(doc.eventId || doc.id || '') === eventId) || null;
    let contextDocs;
    if (requestedDoc && requestedDoc.scope === 'title' && titleDoc) {
      contextDocs = [titleDoc, ...dialogue.slice(0, 2)];
    } else {
      let targetIndex = dialogue.findIndex(doc => String(doc.eventId || doc.id || '') === eventId);
      if (targetIndex < 0) targetIndex = 0;
      const start = Math.max(0, targetIndex - 1);
      const end = Math.min(dialogue.length, targetIndex + 2);
      contextDocs = dialogue.slice(start, end);
    }
    if (!contextDocs.length && indices.length) contextDocs.push(this.documents[indices[0]]);
    return {
      session: { ...session },
      targetEventId: eventId || (contextDocs[0] && (contextDocs[0].eventId || contextDocs[0].id)) || null,
      context: contextDocs.map((doc) => {
        const trimmed = trimPreviewText(doc.text, terms);
        return {
          eventId: doc.eventId || doc.id || null,
          scope: doc.scope,
          role: doc.role || null,
          speaker: doc.speaker || null,
          timestamp: doc.timestamp,
          ordinal: doc.ordinal,
          text: trimmed.text,
          truncated: trimmed.truncated,
          isMatch: String(doc.eventId || doc.id || '') === eventId,
        };
      }),
    };
  }
}


// ---------------------------------------------------------------------------
// CJK 短词辅助索引的分词（2026-09-05）
//
// FTS5 的 trigram 分词器**至少要 3 个字符才能走索引**。中文最常用的检索单位恰好是
// 两个字（「圆桌」「索引」「会话」），于是它们全部退化成顺序扫描 —— 真实索引实测
// 「圆桌」837ms，而四字词走 FTS 只要 12ms，差 70 倍。
// 实测也确认 trigram 不支持前缀查询（`MATCH '"圆桌"*'` 返回 0），这条路走不通。
//
// 所以另建一张 unicode61 的辅助表，只喂 CJK 的**一元 + 二元**词元：
//   「信息熵」→ 信 息 熵 信息 息熵
// 这样 1 字查询命中一元、2 字查询命中二元，都是精确词元查找。
// 3 字及以上继续走 trigram，不重复建索引。
//
// 只做 CJK，**不做短拉丁词**：拉丁是子串语义（查 `ai` 要能命中 `openai`），
// 用词元匹配会产生假阴性 —— 那比慢更糟。短拉丁词继续走顺序扫描。
const CJK_RUN_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/gu;
const CJK_CHAR_RE = /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]$/u;

function cjkAuxTokens(value) {
  const text = normalizeSearchText(value);
  if (!text) return '';
  const tokens = new Set();
  for (const run of text.match(CJK_RUN_RE) || []) {
    const chars = [...run];
    for (let i = 0; i < chars.length; i += 1) {
      tokens.add(chars[i]);
      if (i + 1 < chars.length) tokens.add(chars[i] + chars[i + 1]);
    }
  }
  return tokens.size ? [...tokens].join(' ') : '';
}

// 这个词能不能交给 CJK 辅助索引回答：只有 1~2 个字符、且全是 CJK 的词才行。
// 3 字以上 trigram 已经很快；含拉丁的短词有子串语义，词元匹配会漏。
function isCjkAuxTerm(term) {
  const chars = [...String(term || '')];
  if (chars.length < 1 || chars.length > 2) return false;
  // 刻意用独立的非 global 正则：global 正则带 lastIndex 状态，
  // 复用 CJK_RUN_RE 做 test 会因为上一次匹配的位置而时对时错。
  return chars.every(ch => CJK_CHAR_RE.test(ch));
}

module.exports = {
  MAX_DOCUMENT_TEXT_CHARS,
  MAX_KEYS_PER_DOCUMENT,
  MAX_POSTING_ENTRIES,
  MAX_UNIQUE_INDEX_KEYS,
  boundDocumentText,
  selectedIndexKeysForText,
  SessionSearchIndex,
  SCOPE_WEIGHTS,
  MAX_QUERY_LENGTH,
  createSnippet,
  indexKeysForTerm,
  indexKeysForText,
  cjkAuxTokens,
  isCjkAuxTerm,
  normalizeSearchText,
  queryTerms,
  sinceTimestamp,
};
