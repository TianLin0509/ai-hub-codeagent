'use strict';
// Per-session readable chat log derived from the search parse. The native
// transcript and the SQLite index stay the sources of truth; this file is a
// rebuildable export for sharing and for agents that read Markdown.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const TOOL_SUMMARY_CHARS = 160;

// The name depends only on the source key, so a shared path survives renames.
function transcriptMdPath(transcriptDir, key) {
  if (!transcriptDir || !key) return null;
  const name = crypto.createHash('sha256').update(String(key)).digest('hex').slice(0, 16);
  return path.join(transcriptDir, name + '.md');
}

function formatTime(ms) {
  const value = Number(ms) || 0;
  if (!value) return '';
  const d = new Date(value);
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function toolSummary(text) {
  const flat = String(text || '').replace(/\s+/g, ' ').trim();
  return flat.length > TOOL_SUMMARY_CHARS ? flat.slice(0, TOOL_SUMMARY_CHARS) + '…' : flat;
}

// A heading line inside a message would break the per-message structure.
function quoteHeadings(text) {
  return String(text || '').replace(/^(#{1,6}\s)/gm, '\\$1');
}

function renderTranscriptMarkdown(source) {
  const session = source.session || {};
  const docs = (source.docs || [])
    .filter(d => d && d.scope !== 'title' && d.text)
    .slice()
    .sort((a, b) => (Number(a.ordinal) || 0) - (Number(b.ordinal) || 0));
  const lines = [
    `# ${String(session.title || '未命名会话').replace(/\s+/g, ' ')}`,
    '',
    `- 来源：${session.provider || session.kind || '未知'}${session.model ? ' · ' + session.model : ''}`,
    session.cwd ? `- 工作目录：${session.cwd}` : null,
    session.transcriptPath ? `- 原始记录：${session.transcriptPath}` : null,
    session.hubSessionId ? `- Hub 会话：${session.hubSessionId}` : null,
    `- 生成：${formatTime(Date.now())}，由 AI Hub 从原始记录生成；只含对话，工具调用每条一行摘要，不含工具输出。`,
    '',
  ].filter(line => line !== null);
  for (const doc of docs) {
    if (doc.scope === 'tool') {
      lines.push(`> 工具 · ${toolSummary(doc.text)}`, '');
      continue;
    }
    const speaker = doc.scope === 'user' ? '我' : (doc.speaker || 'AI');
    const time = formatTime(doc.timestamp);
    lines.push(`## ${speaker}${time ? ' · ' + time : ''}`, '', quoteHeadings(doc.text).trim(), '');
  }
  return lines.join('\n');
}

function writeTranscriptMarkdown(transcriptDir, source) {
  const file = transcriptMdPath(transcriptDir, source && source.key);
  if (!file) return null;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(tmp, renderTranscriptMarkdown(source), 'utf8');
  fs.renameSync(tmp, file);
  return file;
}

module.exports = { transcriptMdPath, renderTranscriptMarkdown, writeTranscriptMarkdown, formatTime, toolSummary, quoteHeadings };
