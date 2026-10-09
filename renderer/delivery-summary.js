'use strict';
function _deliveryStatusLabel(status) {
  return { completed: '命令成功', failed: '失败', running: '运行中', pending: '待确认', cancelled: '已取消', unknown: '已运行 · 未判定' }[status] || '待确认';
}

function _deliveryStatusIcon(status) {
  return { completed: '✓', failed: '×', running: '↻', pending: '·', cancelled: '—', unknown: '?' }[status] || '?';
}

function renderDeliveryGlance(delivery, escapeHtml) {
  if (!delivery || !delivery.hasContent) return '';
  const files = Array.isArray(delivery.changedFiles) ? delivery.changedFiles : [];
  const checks = Array.isArray(delivery.checks) ? delivery.checks : [];
  const artifacts = Array.isArray(delivery.artifacts) ? delivery.artifacts : [];
  const rows = [
    files.length && { count: files.length, label: files.some(item => item.status !== 'completed' || item.failedAttempts) ? '文件记录' : '变更文件' },
    checks.length && { count: checks.length, label: '验证记录' },
    artifacts.length && { count: artifacts.length, label: '交付产物' },
    checks.some(item => item.status === 'failed') && { count: checks.filter(item => item.status === 'failed').length, label: '失败记录', failed: true },
  ].filter(Boolean);
  if (!rows.length) return '';
  return `<aside class="turn-result-glance" aria-label="本轮结果概览">
    <span class="turn-result-glance-title">本轮结果</span>
    ${rows.map(row => `<div class="turn-result-glance-row${row.failed ? ' status-failed' : ''}"><strong>${escapeHtml(row.count)}</strong><span>${escapeHtml(row.label)}</span></div>`).join('')}
  </aside>`;
}

function renderDeliverySummary(delivery, escapeHtml) {
  if (!delivery || !delivery.hasContent) return '';
  const files = Array.isArray(delivery.changedFiles) ? delivery.changedFiles : [];
  const checks = Array.isArray(delivery.checks) ? delivery.checks : [];
  const artifacts = Array.isArray(delivery.artifacts) ? delivery.artifacts : [];
  const metrics = [];
  if (files.length) metrics.push(`${files.length} 个${files.some(f => f.status !== 'completed' || f.failedAttempts) ? '文件记录' : '变更文件'}`);
  if (checks.length) metrics.push(`${checks.length} 项验证`);
  if (artifacts.length) metrics.push(`${artifacts.length} 个产物`);
  const fileItems = files.map(item => {
    const state = item.status === 'completed' ? (item.kind === 'delete' ? '已删除' : '已修改')
      : item.status === 'failed' ? '失败 · 变更未确认' : '变更未确认';
    const history = item.status === 'completed' && item.failedAttempts ? ` · 另有 ${item.failedAttempts} 次失败` : '';
    return `<li class="turn-delivery-file status-${escapeHtml(item.status)}"><span class="turn-delivery-icon">Δ</span><a href="#" class="rt-file-link" data-path="${escapeHtml(item.path)}">${escapeHtml(item.path)}</a><em>${escapeHtml(state + history)}</em></li>`;
  }).join('');
  const checkItems = checks.map(item => `<li class="turn-delivery-check status-${escapeHtml(item.status)}"><span class="turn-delivery-icon">${escapeHtml(_deliveryStatusIcon(item.status))}</span><span>${escapeHtml(item.command)}</span><em>${escapeHtml(_deliveryStatusLabel(item.status))}${item.exitCode !== null ? ` · exit ${escapeHtml(item.exitCode)}` : ''}</em></li>`).join('');
  const artifactItems = artifacts.map(item => `<li class="turn-delivery-artifact"><span class="turn-delivery-icon">↗</span><a href="#" class="rt-file-link" data-path="${escapeHtml(item.path)}">${escapeHtml(item.name || item.path)}</a><em>${escapeHtml(item.kind || '')}</em></li>`).join('');
  return `<details class="turn-delivery-summary" data-summary-source="${escapeHtml(delivery.source || 'deterministic')}">
    <summary><span>交付结果</span><small>${escapeHtml(metrics.join(' · '))}</small></summary>
    <div class="turn-delivery-body">
      ${files.length ? `<section><strong>文件</strong><ul>${fileItems}</ul></section>` : ''}
      ${checks.length ? `<section><strong>验证</strong><ul>${checkItems}</ul></section>` : ''}
      ${artifacts.length ? `<section><strong>产物</strong><ul>${artifactItems}</ul></section>` : ''}
    </div>
  </details>`;
}

module.exports = { renderDeliverySummary, renderDeliveryGlance };
