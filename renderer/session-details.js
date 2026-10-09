'use strict';

function compactCount(value) {
  if (!Number.isFinite(value) || value < 0) return '—';
  if (value >= 1e6) return `${Number((value / 1e6).toFixed(2))}M`;
  if (value >= 1e3) return `${Number((value / 1e3).toFixed(1))}k`;
  return String(Math.round(value));
}

function modelEffort(session, modelShort) {
  const model = session.currentModel;
  const raw = model?.id || model?.displayName || '';
  const name = /astra/i.test(raw) ? 'Astra' : (model ? modelShort(model) : '模型 —');
  const effort = session.effort ? String(session.effort) : '';
  const label = ({ low: 'Low', medium: 'Medium', high: 'High', xhigh: 'XHigh', max: 'Max', ultra: 'Ultra', minimal: 'Minimal', none: 'None' })[effort.toLowerCase()] || effort;
  return `${name}${label ? ' ' + label : ''}`;
}

function usageText(session) {
  const usage = session.sessionUsage;
  if (!usage) return '尚未取得会话累计用量';
  const number = value => Number.isFinite(value) ? value.toLocaleString() : '—';
  return [
    `累计 ${number(usage.total)} / 输出 ${number(usage.output)}`,
    `输入（含缓存）${number(usage.input)}`,
    `其中缓存读取 ${number(usage.cached)}，缓存写入 ${number(usage.cacheWrite)}`,
    `其中推理输出 ${usage.source?.startsWith('claude') ? '未单独提供' : number(usage.reasoning)}`,
    '累计包含输入与输出；缓存和推理为子项，不重复相加。',
    '统计当前 CLI 会话，不合计其内部子代理；不代表订阅扣费。',
    usage.observedAt ? `更新于 ${new Date(usage.observedAt).toLocaleString()}` : '',
    usage.stale ? '读取失败，显示上次已知值。' : '',
    usage.partial ? '部分记录缺少响应标识或有效计数，仅显示已确认部分。' : '',
  ].filter(Boolean).join('\n');
}

function detailsHtml(session, { escapeHtml, modelShort }) {
  const usage = session.sessionUsage;
  const model = modelEffort(session, modelShort);
  const ctx = Number.isFinite(session.contextPct) ? `${Math.round(session.contextPct)}%` : '—';
  return '<div class="sl-details">'
    + `<span class="sl-usage" data-usage-id="${escapeHtml(session.id)}" title="${escapeHtml(usageText(session))}">累计 ${compactCount(usage?.total)}/${compactCount(usage?.output)}${usage?.stale || usage?.partial ? ' *' : ''}</span>`
    + `<span class="sl-detail-model" title="${escapeHtml(model)}">${escapeHtml(model)}</span>`
    + `<span class="sl-detail-context" title="上下文占用 ${ctx}">上下文 ${ctx}</span></div>`;
}

module.exports = { compactCount, modelEffort, usageText, detailsHtml };
