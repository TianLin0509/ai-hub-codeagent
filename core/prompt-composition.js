'use strict';
// 卡片上「发送内容」面板的数据：一条用户消息发出去时，请求里依次有哪几块（2026-10-13 用户要求，
// 类似 Claude Code 的 /context）。每块给出大小和粗估 token，正文可展开。
//
// 三组，按请求里的先后顺序：
//   系统提示：CLI 内置部分（Hub 拿不到原文，只标注）+ Hub 启动时写进系统提示的规则文件；
//   会话开头自动带上的规则与记忆：CLAUDE.md / AGENTS.md 链和 MEMORY.md，按当前磁盘还原
//            （core/prompt-inspect.js 的拼装结果），不保证和发这条消息那一刻完全一样；
//   这条消息：Hub 附在正文前面的块（规则、工作区规则、记忆索引，见 synthetic-user-filter 的
//            splitHubEnvelopes）+ 用户自己输入的正文。前两组每轮都作为缓存前缀复用，
//            第三组里的附带块只在这一条出现一次。
const { UNAVAILABLE_PARTS } = require('./prompt-inspect');

// 粗估：中日韩字符约 0.8 token/字，其余约 3.8 字符/token。只用来比较各块的相对体量。
function estimateTokens(text) {
  const s = String(text || '');
  const cjk = (s.match(/[⺀-鿿가-힯豈-﫿＀-￯]/g) || []).length;
  return Math.round(cjk * 0.8 + (s.length - cjk) / 3.8);
}

function part(fields) {
  const text = typeof fields.text === 'string' ? fields.text : null;
  return { ...fields, text, chars: text == null ? null : text.length, tokens: text == null ? null : estimateTokens(text) };
}

function buildComposition({ turn = {}, kind = '', systemRules = null, assembly = null, assemblyError = null } = {}) {
  const groups = [];

  const system = [part({ id: 'cli-builtin', title: 'CLI 内置系统提示词和工具定义', unavailable: true,
    note: UNAVAILABLE_PARTS.slice(0, 3).map(p => `${p.label}：${p.why}`).join('\n') })];
  if (systemRules) {
    system.push(systemRules.text == null
      ? part({ id: 'hub-rules-system', title: `Hub 规则（${systemRules.label || '启动时写入'}）`, unavailable: true,
        note: '会话启动时写进了系统提示，但那一版的规则文件已被清理，看不到原文。' })
      : part({ id: 'hub-rules-system', title: `Hub 规则（${systemRules.label || '启动时写入'}）`, text: systemRules.text,
        note: '会话启动时写进系统提示，之后每轮都在，压缩上下文也不丢。' }));
  }
  groups.push({ id: 'system', title: '系统提示', note: '每次请求都在最前面，作为缓存前缀复用。', parts: system });

  const startup = [];
  for (const seg of (assembly && assembly.segments) || []) {
    if (seg.missing || seg.duplicateOf) continue;
    const truncated = seg.textOmitted || seg.textTruncated;
    startup.push(part({ id: `file:${seg.id}`, title: seg.label, path: seg.path, text: seg.textOmitted ? null : seg.text,
      bytes: seg.bytes, truncated, unavailable: !!seg.textOmitted,
      note: [seg.orderTruth === 'approx' ? '插入位置是近似的' : '', truncated ? `正文较长，这里只显示前 ${seg.textBytes || 0} / ${seg.bytes} 字节` : '']
        .filter(Boolean).join('；') || null }));
  }
  groups.push({ id: 'startup', title: '会话开头自动带上的规则与记忆',
    note: assemblyError ? `还原失败：${assemblyError}` : '由 CLI 在会话开始时读取；这里按当前磁盘内容还原，期间改过文件会有出入。',
    parts: startup });

  const message = [];
  for (const block of turn.hubAttached || []) {
    message.push(part({ id: `attached:${block.kind}:${block.ref || message.length}`, title: block.label, text: block.content,
      note: '由 Hub 放在正文前面；同一版每个会话只带一次，换版或上下文压缩后再带。' }));
  }
  const userText = turn.assistantContext?.userText ?? turn.text ?? '';
  message.push(part({ id: 'user', title: '你输入的内容', text: String(userText) }));
  groups.push({ id: 'message', title: '这条消息', note: turn.hubAttached?.length ? null : '这条消息没有附带 Hub 的规则或记忆。', parts: message });

  for (const g of groups) g.tokens = g.parts.reduce((n, p) => n + (p.tokens || 0), 0);
  return { kind, groups, tokens: groups.reduce((n, g) => n + g.tokens, 0) };
}

module.exports = { buildComposition, estimateTokens };
