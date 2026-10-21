'use strict';
// Receives rows already checked against complete pages by PPTutor's prepare().
// Scope and file/page attribution come from the host, never the model's summary.
const cell = value => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/`/g, '\\`').replace(/\[/g, '\\[').replace(/\]/g, '\\]').replace(/\r?\n/g, '<br>');
function renderPptReport({ rows, pages, scope, indexing, purpose }) {
  const usable = rows.filter(row => row.relevance !== '条件不符'), excluded = rows.filter(row => row.relevance === '条件不符');
  const lines = [usable.length ? `**为这次用途找到 ${usable.length} 页素材，按下面的顺序使用。**` : '**本轮已读材料中，暂无满足条件的推荐页。**', '', `本次用途：${cell(purpose)}`, ''];
  if (usable.length) {
    lines.push('| 素材与页码 | 用途与推荐理由（助理判断） | 已核对的原文 | 使用判断 |', '|---|---|---|---|');
    for (const row of usable) {
      const page = pages.get(row.id), checks = row.conditions.map(c => `${c.text}：${c.status}`).join('；');
      const freshness = page.source_state === 'metadata_matches_index' ? '' : '；源文件已变化或不可用，需更新索引后核对';
      lines.push(`| ${cell(page.ref.name)} · 第 ${page.ref.page} 页 | ${cell(row.use)}。${cell(row.reason)} | ${cell(row.quote)} | ${cell(row.relevance + (checks ? '；' + checks : '') + freshness)} |`);
    }
    lines.push('');
  }
  if (excluded.length) {
    lines.push('**条件不符的材料：**', '');
    for (const row of excluded) {
      const page = pages.get(row.id);
      lines.push(`- ${cell(page.ref.name)} · 第 ${page.ref.page} 页：${cell(row.conditions.filter(c => c.status === '冲突').map(c => c.text + '：冲突').join('；'))}。原文：“${cell(row.quote)}”。`);
    }
    lines.push('');
  }
  const paths = [...new Set(rows.map(row => pages.get(row.id).ref.path))];
  if (paths.length) lines.push('**文件路径：**', '', ...paths.map(p => '- ' + cell(p)), '');
  const library = Number.isInteger(scope?.files) && Number.isInteger(scope?.pages) ? `当前索引 ${scope.files} 份文稿、${scope.pages} 页；` : '';
  lines.push(`**覆盖范围：** ${library}本轮完整读过 ${pages.size} 页。引文已按每一页的文件与页码核对；用途、推荐理由和条件判定是助理的分析。只核对提取文字，图表、版式尚未检查。`);
  if (indexing?.failed || indexing?.skippedPpt) lines.push(`Hub 素材目录上次更新：${indexing.failed || 0} 份读取失败，${indexing.skippedPpt || 0} 份旧版 .ppt 未提取；这些未提取内容不在本次检索范围内。`);
  if (scope?.error) lines.push(`部分索引尚未读到：${cell(scope.error)}`);
  return lines.join('\n');
}
module.exports = { renderPptReport };
