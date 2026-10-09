'use strict';

// Shared by the SQLite reader and the immediate title layer. Popularity never
// crosses a text-quality tier; explicit field sorts bypass relevance entirely.
const RANK_VERSION = 'structure-v1';
const FIELD_ORDER = { title: 0, user: 1, assistant: 2, tool: 3 };
const SORTS = new Set(['relevance', 'conversationTime', 'matchTime', 'title']);
const normalize = value => String(value ?? '').normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
const termsFor = value => [...new Set(normalize(value).split(' ').filter(Boolean))];
function normalizeSort(sort, query = '') {
  if (sort === 'recent') return 'matchTime'; // Existing API compatibility.
  return SORTS.has(sort) ? sort : (query ? 'relevance' : 'conversationTime');
}
function documentRank(doc, query, terms) {
  const text = doc.normalized_text ?? normalize(doc.text);
  const positions = terms.map(term => text.indexOf(term));
  const covered = positions.map((p, i) => p >= 0 ? i : -1).filter(i => i >= 0);
  const all = covered.length === terms.length;
  const phrase = !!query && text.includes(query);
  const tier = doc.scope === 'title' && text === query ? 0 : phrase ? 1 : all ? 2 : 4;
  let distance=Number.MAX_SAFE_INTEGER;
  if(all) {
    // Heap sweep: advance only the earliest occurrence, without repeatedly
    // spreading/scanning all query terms. Different first code units cannot
    // occupy the same position, which also gives a safe optimality bound.
    const heap=positions.map((position,term)=>({position,term})).sort((a,b)=>a.position-b.position);
    let high=Math.max(...positions);
    const lowerBound=new Set(terms.map(term=>term[0])).size-1;
    while(heap.length) {
      const first=heap[0];distance=Math.min(distance,high-first.position);
      if(distance<=lowerBound) break;
      const next=text.indexOf(terms[first.term],first.position+1);
      if(next<0) break;
      high=Math.max(high,next);heap[0]={position:next,term:first.term};
      let parent=0;
      while(parent*2+1<heap.length) {
        let child=parent*2+1;
        if(child+1<heap.length && heap[child+1].position<heap[child].position) child++;
        if(heap[parent].position<=heap[child].position) break;
        [heap[parent],heap[child]]=[heap[child],heap[parent]];parent=child;
      }
    }
  }
  return { tier, field: FIELD_ORDER[doc.scope] ?? 4,
    distance,
    covered };
}
function compareRank(a, b) {
  return a.tier - b.tier || a.distance - b.distance || a.field - b.field;
}
function compareResults(a, b, sort = 'relevance', direction = 'desc') {
  const stable = String(a.sessionKey || a.key).localeCompare(String(b.sessionKey || b.key), 'en');
  if (sort === 'title') return (direction === 'desc' ? -1 : 1) * normalize(a.title).localeCompare(normalize(b.title), 'zh-CN', { numeric: true }) || stable;
  if (sort === 'matchTime' || sort === 'recent' || sort === 'conversationTime') {
    const field = sort === 'conversationTime' ? 'lastConversationAt' : 'newestMatchedEventAt';
    const x = Number(a[field]) || 0, y = Number(b[field]) || 0;
    if (!x || !y) return (x ? -1 : y ? 1 : 0) || stable;
    return (direction === 'asc' ? x-y : y-x) || stable;
  }
  return compareRank(a.rank || {tier:5,distance:0,field:0}, b.rank || {tier:5,distance:0,field:0})
    || (Number(b.lastConversationAt)||0)-(Number(a.lastConversationAt)||0) || stable;
}
function rankReason(rank, titleOnly, timed = false) {
  const labels = ['标题完全匹配', '包含完整短语', '全部关键词在同一标题或消息', '全部关键词在同一轮问答', '关键词分散在多轮对话', '扩展匹配'];
  return [labels[rank.tier] || labels[4], ...(titleOnly && timed ? ['标题命中 · 范围内有对话'] : [])];
}
module.exports = { RANK_VERSION, FIELD_ORDER, normalize, termsFor, normalizeSort, documentRank, compareRank, compareResults, rankReason };
