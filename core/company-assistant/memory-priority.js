'use strict';
// 只按用户明确的优先关系排序；记住一个名字本身不表示那个人比别人重要。
const normalize = value => String(value ?? '').normalize('NFKC').trim().toLowerCase();
function isPriorityMemory(item) {
  if (!item || item.deletedAt || !['person', 'group'].includes(item.kind) || !normalize(item.key)) return false;
  const text = String(item.text || '').replace(/\s+/g, '');
  const negative = /不(?:要|必|需|用|再|是)?(?:优先|重要|重点|关注)|非(?:重点|重要|负责人|直属领导)|(?:无需|无须|不用|不必|不要)(?:特别|重点|优先)?关注|不是(?:负责人|直属领导)/;
  return !negative.test(text) && /优先|重点|重要|负责人|直属领导/.test(text);
}
function createPriorityMatcher(memory = []) {
  const people = new Set(), groups = new Set();
  for (const item of Array.isArray(memory) ? memory : []) if (isPriorityMemory(item)) (item.kind === 'person' ? people : groups).add(normalize(item.key));
  return row => {
    if (!row || typeof row !== 'object') return 0;
    const personNames = [row.sender, row.senderName, row.account, row.from];
    if (row.group === false) personNames.push(row.convName, row.conv);
    const groupNames = row.group ? [row.convName, row.conv, row.groupName, row.groupId, row.name, row.id] : [];
    return Number(personNames.some(x => people.has(normalize(x))) || groupNames.some(x => groups.has(normalize(x))));
  };
}
function prioritize(items, memory = [], rowOf = row => row) {
  const score = createPriorityMatcher(memory);
  return [...(items || [])].map((item, index) => ({ item, index, priority: score(rowOf(item)) }))
    .sort((a, b) => b.priority - a.priority || a.index - b.index).map(x => x.item);
}
module.exports = { createPriorityMatcher, prioritize, isPriorityMemory };
