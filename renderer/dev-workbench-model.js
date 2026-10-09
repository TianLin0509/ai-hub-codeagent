'use strict';
// Pure projection of already-published facts. No IO or inferred completion.
const historyKeys = new Set(['passed', 'stoppedUser', 'stopped']);
function isHistory(row) { return historyKeys.has(row.stage?.key); }
function projectKey(row) {
  const raw = typeof row.workspace === 'string' ? row.workspace.trim() : '';
  if (!raw) return 'unbound';
  return /^[a-z]:[\\/]|^\\\\/i.test(raw)
    ? raw.replace(/\\/g, '/').replace(/\/+$/, '').toLocaleLowerCase() : raw.replace(/\/+$/, '') || '/';
}
function projectName(row) {
  return (typeof row.project === 'string' && row.project) || (typeof row.workspace === 'string' && row.workspace.replace(/[\\/]+$/, '').split(/[\\/]/).pop()) || '未绑定项目';
}
function sortRows(rows, order = 'updated-desc') {
  const field = order.startsWith('created') ? 'createdAt' : 'activityAt', direction = order.endsWith('asc') ? 1 : -1;
  const rank = r => r.pinned ? 0 : r.bottomed ? 2 : 1;
  const time = r => Number(r[field]) || Number(r.createdAt) || 0;
  return [...rows].sort((a, b) => rank(a) - rank(b) || direction * (time(a) - time(b)) || String(a.id).localeCompare(String(b.id)));
}
function readingOrder(rows, order, previous) {
  const sorted = sortRows(rows, order);
  if (!previous?.length) return sorted;
  const positions = new Map(previous.map((id, index) => [id, index]));
  const rank = row => row.pinned ? 0 : row.bottomed ? 2 : 1;
  return sorted.sort((a, b) => rank(a) - rank(b)
    || (positions.get(a.id) ?? Infinity) - (positions.get(b.id) ?? Infinity));
}
function groupProjects(rows, order, previousTasks, previousProjects) {
  const groups = new Map();
  for (const row of readingOrder(rows, order, previousTasks)) {
    const key = projectKey(row);
    if (!groups.has(key)) groups.set(key, { key, name: projectName(row), workspace: row.workspace || '', current: [], history: [], activityAt: 0, createdAt: 0 });
    const group = groups.get(key);
    group[isHistory(row) ? 'history' : 'current'].push(row);
    group.activityAt = Math.max(group.activityAt, Number(row.activityAt) || Number(row.createdAt) || 0);
    group.createdAt = Math.max(group.createdAt, Number(row.createdAt) || 0);
  }
  return readingOrder([...groups.values()].map(g => ({ ...g, id: g.key })), order, previousProjects);
}
function flowSteps(row) {
  const flow = row.flow || {}, key = row.stage?.key;
  // '通过' only comes from the current engine state, never an older PASS message.
  const done = key === 'passed';
  const hasGoal = !!row.goal;
  let active = done ? 3 : flow.currentStep === 'reviewer' ? 2 : hasGoal ? 1 : 0;
  if (['chatting', 'recovering', 'manual', 'chatFailed'].includes(key) && flow.status === 'done') active = -1;
  // 讨论阶段永远停在「目标」这一格：旧一轮留下的 goal 不代表当前这件事已经布置下去。
  if (key === 'discussing' || flow.phase === 'discuss') active = 0;
  return ['目标', '实现', '审核', '通过'].map((label, index) => ({ label, state: index === active ? 'current' : active >= 0 && index < active ? 'complete' : 'pending' }));
}
module.exports = { isHistory, projectKey, projectName, sortRows, readingOrder, groupProjects, flowSteps };
