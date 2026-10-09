'use strict';
// Catalog coverage is configuration evidence, never a runtime success claim.
const UNSCANNED = new Set(['glm', 'deepseek-acp']);
function coverage(row, agent) {
  const sources = (row.sources || []).filter(s => s.agent === agent);
  if (!sources.length) return {state: 'unknown', label: UNSCANNED.has(agent) ? '未接入盘点' : '未发现', tone: 'muted'};
  const present = sources.filter(s => !s.missing);
  if (!present.length) return {state: 'missing', label: '待核对安装', tone: 'warn'};
  const enabled = present.filter(s => s.enabled !== false);
  if (!enabled.length) return {state: 'disabled', label: '配置禁用', tone: 'muted'};
  if (row.type === 'skill' && new Set(present.map(s => s.hash).filter(Boolean)).size > 1)
    return {state: 'variant', label: '多份正文', tone: 'warn'};
  if (present.some(s => s.enabled === false)) return {state: 'mixed', label: '范围有差异', tone: 'warn'};
  const sharedPaths = new Set((row.sources || []).filter(s => s.scope === 'shared').map(s => s.realPath));
  if (enabled.some(s => s.scope === 'shared' || (s.realPath && sharedPaths.has(s.realPath))))
    return {state: 'shared', label: '共享入口', tone: 'shared'};
  return {state: 'registered', label: row.type === 'skill' ? '独立入口' : '已登记', tone: ''};
}
// Headline counts and the default list only include rows with at least one installed, enabled entry;
// disabled leftovers and flag-only plugins stay reachable through the explicit scope filters.
function isActive(row) {
  return (row.sources || []).some(s => !s.missing && s.enabled !== false);
}
function related(rows, row) {
  if (row.type === 'plugin') return rows.filter(r => r.sources?.some(s => s.plugin === row.name && row.agents.includes(s.agent)));
  const parents = new Set((row.sources || []).map(s => s.plugin).filter(Boolean));
  return rows.filter(r => r.type === 'plugin' && parents.has(r.name));
}
module.exports = {coverage, related, isActive};
