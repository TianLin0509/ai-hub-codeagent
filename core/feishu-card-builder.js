'use strict';

const MAX_PRIMARY_CHARS = 1_600;
const MAX_PRIMARY_LINES = 14;
const MAX_SECONDARY_CHARS = 4_800;

function clampPlainText(value, maxLength = 80) {
  const normalized = String(value || '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(1, maxLength - 1))}…`;
}

function stripInternalMetadata(value) {
  return String(value || '')
    .replace(/\u001b(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, '')
    .replace(/<oai-mem-citation>[\s\S]*?<\/oai-mem-citation>/gi, '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/\r\n/g, '\n')
    .trim();
}

// Card markdown supports Feishu-specific HTML tags such as <at>. Model output is
// content, not trusted card markup, so neutralize tag delimiters while preserving
// ordinary Markdown (lists, code fences, emphasis and links).
function escapeCardTags(value) {
  return String(value || '')
    .replace(/&/g, '&#38;')
    .replace(/</g, '&#60;')
    .replace(/>/g, '&#62;');
}

function cleanAnswerMarkdown(value) {
  return escapeCardTags(stripInternalMetadata(value));
}

function escapeMarkdownLiteral(value) {
  return escapeCardTags(clampPlainText(value, 100)).replace(/[\\`*_[\]()~#:]/g, (char) => `&#${char.codePointAt(0)};`);
}

function findBoundary(text, limit, minRatio = 0.55) {
  if (text.length <= limit) return text.length;
  const floor = Math.floor(limit * minRatio);
  const head = text.slice(0, limit + 1);
  for (const marker of ['\n\n', '\n', '。', '！', '？', '. ', ' ']) {
    const index = head.lastIndexOf(marker);
    if (index >= floor) return index + marker.length;
  }
  return limit;
}

function splitAnswer(value) {
  const text = cleanAnswerMarkdown(value);
  if (!text) return { primary: '', secondary: '', truncated: false };

  const lines = text.split('\n');
  let lineLimited = text;
  let lineRemainder = '';
  if (lines.length > MAX_PRIMARY_LINES) {
    lineLimited = lines.slice(0, MAX_PRIMARY_LINES).join('\n');
    lineRemainder = lines.slice(MAX_PRIMARY_LINES).join('\n').trim();
  }

  let primary = lineLimited;
  let remainder = lineRemainder;
  if (primary.length > MAX_PRIMARY_CHARS) {
    const boundary = findBoundary(primary, MAX_PRIMARY_CHARS);
    remainder = `${primary.slice(boundary).trim()}${remainder ? `\n${remainder}` : ''}`.trim();
    primary = primary.slice(0, boundary).trim();
  }

  let truncated = false;
  if (remainder.length > MAX_SECONDARY_CHARS) {
    const boundary = findBoundary(remainder, MAX_SECONDARY_CHARS, 0.8);
    remainder = remainder.slice(0, boundary).trim();
    truncated = true;
  }
  if (!primary && remainder) {
    primary = remainder;
    remainder = '';
  }
  return { primary, secondary: remainder, truncated };
}

function metricColumn(value, label) {
  return {
    tag: 'column',
    width: 'weighted',
    weight: 1,
    padding: '8px',
    vertical_spacing: '2px',
    elements: [
      {
        tag: 'markdown',
        content: `**${escapeMarkdownLiteral(value || '—')}**`,
        text_align: 'center',
      },
      {
        tag: 'markdown',
        content: `<font color='grey'>${escapeMarkdownLiteral(label)}</font>`,
        text_align: 'center',
        text_size: 'notation',
      },
    ],
  };
}

function buildSessionCompletionCard(input = {}) {
  const title = clampPlainText(input.sessionTitle || input.title || 'AI 会话', 80) || 'AI 会话';
  const kind = clampPlainText(input.kind || 'AI', 24) || 'AI';
  const model = clampPlainText(input.model || kind, 40) || kind;
  const duration = clampPlainText(input.durationText || '未记录', 24) || '未记录';
  const completedAt = clampPlainText(input.completedAtText || '', 48);
  const artifacts = Array.isArray(input.artifacts)
    ? input.artifacts.slice(0, 3).map((item) => ({ name: clampPlainText(item && item.name, 100) })).filter(item => item.name)
    : [];
  const includeContent = input.includeContent === true;
  const answer = includeContent ? splitAnswer(input.answerText) : { primary: '', secondary: '', truncated: false };
  const elements = [];

  elements.push({
    tag: 'column_set',
    flex_mode: 'none',
    horizontal_spacing: '8px',
    background_style: 'green-50',
    margin: '0px 0px 12px 0px',
    columns: [
      metricColumn(model, '模型'),
      metricColumn(duration, '耗时'),
      metricColumn(String(artifacts.length), '成果'),
    ],
  });

  if (answer.primary) {
    elements.push({
      tag: 'markdown',
      content: `**本轮结论**\n${answer.primary}`,
      text_size: 'normal',
      margin: '0px 0px 12px 0px',
    });
  } else {
    elements.push({
      tag: 'markdown',
      content: includeContent
        ? '**本轮回答已完成**\n回答正文为空，请打开 AI Hub 查看会话。'
        : '**本轮回答已完成**\n回答与成果快递未开启，请打开 AI Hub 查看完整内容。',
      text_size: 'normal',
      margin: input.imageKey || artifacts.length || answer.secondary ? '0px 0px 12px 0px' : '0px',
    });
  }

  if (input.imageKey) {
    elements.push({
      tag: 'img',
      img_key: String(input.imageKey),
      alt: { tag: 'plain_text', content: 'HTML 成果静态预览' },
      title: { tag: 'plain_text', content: 'HTML 成果预览' },
      scale_type: 'fit_horizontal',
      corner_radius: '8px',
      preview: true,
      margin: artifacts.length || answer.secondary ? '0px 0px 12px 0px' : '0px',
    });
  }

  if (artifacts.length) {
    const names = artifacts.map(item => `- ${escapeMarkdownLiteral(item.name)}`).join('\n');
    elements.push({
      tag: 'markdown',
      content: `**本轮成果**\n${names}\n<font color='grey'>原文件将以随后消息投递。</font>`,
      text_size: 'normal',
      margin: answer.secondary ? '0px 0px 12px 0px' : '0px',
    });
  }

  if (answer.secondary) {
    elements.push({
      tag: 'collapsible_panel',
      expanded: false,
      background_color: 'green-50',
      border: { color: 'green-100', corner_radius: '8px' },
      padding: '8px',
      margin: '0px',
      header: {
        title: { tag: 'plain_text', content: answer.truncated ? '展开更多（卡片内已截断）' : '展开完整细节' },
        background_color: 'green-50',
        width: 'fill',
      },
      elements: [{
        tag: 'markdown',
        content: `${answer.secondary}${answer.truncated ? '\n\n<font color=\'grey\'>内容较长，请在 AI Hub 查看余下部分。</font>' : ''}`,
      }],
    });
  }

  const tags = [{
    tag: 'text_tag',
    text: { tag: 'plain_text', content: '已完成' },
    color: 'green',
  }];
  if (artifacts.length) {
    tags.push({
      tag: 'text_tag',
      text: { tag: 'plain_text', content: `成果 ${artifacts.length}` },
      color: 'turquoise',
    });
  }

  return {
    schema: '2.0',
    config: {
      update_multi: true,
      width_mode: 'default',
      enable_forward: false,
      summary: { content: `AI Hub · ${title} 已完成` },
      style: {
        color: {
          'hub-muted': {
            light_mode: 'rgba(100,106,115,1)',
            dark_mode: 'rgba(150,155,163,1)',
          },
        },
      },
    },
    header: {
      title: { tag: 'plain_text', content: title },
      subtitle: { tag: 'plain_text', content: `AI Hub · ${kind}${completedAt ? ` · ${completedAt}` : ''}` },
      template: 'green',
      icon: { tag: 'standard_icon', token: 'ai-common_colorful' },
      text_tag_list: tags,
    },
    body: {
      direction: 'vertical',
      padding: '12px 12px 20px 12px',
      vertical_spacing: '0px',
      elements,
    },
  };
}

module.exports = {
  MAX_PRIMARY_CHARS,
  MAX_SECONDARY_CHARS,
  buildSessionCompletionCard,
  cleanAnswerMarkdown,
  clampPlainText,
  escapeCardTags,
  splitAnswer,
  stripInternalMetadata,
};
