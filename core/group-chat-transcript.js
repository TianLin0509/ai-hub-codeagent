'use strict';

/**
 * 群聊记录的 Markdown 存档。
 *
 * 为什么要有这个文件（2026-09-17 用户提的）：群聊给每位 AI 的 prompt 一直是
 * 「你上次发言之后别人说了什么」的增量。增量本身是对的、也最省 token，但有两种
 * 情况它撑不住：
 *
 *   1. 新成员 / 分支进来的成员 —— 它的游标是 0，于是「增量」等于全部历史，
 *      一次性灌进第一条 prompt，长群聊里能直接把上下文顶爆。
 *   2. 有人想回看很早以前的讨论 —— prompt 里早就没有了，谁也捞不回来。
 *
 * 所以把权威消息流投影成一份人和 AI 都能读的 md：超预算的部分不再硬塞进 prompt，
 * 改成给出这个文件的路径 + 消息序号，让 AI 自己去读。
 *
 * 它**只是投影**：真理源始终是 orchestrator 的 state.messages。删掉这个 md 不丢
 * 任何东西，下一次保存会重新生成。所以这里不做任何 markDirty / 事务，写失败只告警。
 */

const fs = require('fs');
const path = require('path');

const ORIGIN_USER = 'user';
const ORIGIN_HUB = 'hub';
const ORIGIN_SYSTEM = 'system';
const PROGRESS_UPDATE_STATUS = 'progress_update';

const NEWLINE = String.fromCharCode(10);

function transcriptPath(hubDataDir, meetingId) {
  return path.join(hubDataDir, 'arena-prompts', `${meetingId}-transcript.md`);
}

function isProgressUpdateMessage(message) {
  return !!message && message.status === PROGRESS_UPDATE_STATUS;
}

/**
 * 「这条 role==='user' 的消息是不是维护者真的说的话」。
 *
 * 群聊里 role==='user' 有四种来源：用户打进去的问题、用户中途的插话（supplement）、
 * Hub 自己的阶段派工卡片（origin==='hub'）、以及自愈系统提示（systemNote）。
 * 只有前两种该进任何 AI 的上下文。老状态文件没有 origin 字段，只能靠
 * dispatch 元数据反推——派工卡片一定带 dispatch。
 */
function isUserSpeech(message) {
  if (!message || message.role !== 'user') return false;
  if (message.systemNote) return false;
  if (message.origin === ORIGIN_HUB || message.origin === ORIGIN_SYSTEM) return false;
  if (message.origin === ORIGIN_USER) return true;
  return !message.dispatch;
}

function isAssistantSpeech(message) {
  return !!message && message.role === 'assistant' && !isProgressUpdateMessage(message);
}

function speakerOf(message) {
  if (!message) return 'AI';
  if (message.speaker) return String(message.speaker);
  return message.role === 'user' ? '你' : 'AI';
}

const STATUS_LABELS = {
  errored: '失败',
  absent: '缺席',
  interrupted: '中断',
  manual_extracted: '手动同步',
  progress_update: '过程汇报',
};

function formatTime(ms) {
  const at = Number(ms);
  if (!Number.isFinite(at) || at <= 0) return '';
  const d = new Date(at);
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function turnHeading(message) {
  const n = Number(message && message.turnNum);
  if (Number.isInteger(n) && n > 0) return `## 第 ${n} 轮`;
  // 投委会幕间发言不挂在任何一轮上（appendCommitteeSpeeches 不写 turnNum）。
  return '## 场外发言';
}

/**
 * 把消息流渲染成 md。**不截断任何正文** —— 截断是 prompt 那一侧的事，
 * 这里是那一侧兜底的去处，自己再砍一刀就没有全文可查了。
 */
function renderTranscriptMarkdown(state, opts = {}) {
  const messages = Array.isArray(state && state.messages) ? state.messages : [];
  const kept = messages.filter(m => m && !isProgressUpdateMessage(m)
    && (isUserSpeech(m) || isAssistantSpeech(m) || m.systemNote));
  const first = kept.length ? kept[0] : null;
  const last = kept.length ? kept[kept.length - 1] : null;
  const title = String(opts.title || '').trim();
  const lines = [
    `# 群聊记录${title ? '：' + title : ''}`,
    '',
    `- 群聊 ID：${(state && state.meetingId) || ''}`,
    `- 消息数：${kept.length}${first && last ? `（#${first.seq} – #${last.seq}）` : ''}`,
    `- 生成时间：${formatTime(Date.now())}`,
    '',
    '> 本文件由 AI Hub Community 自动生成，每次群聊状态保存后刷新；手工修改会被覆盖。',
    '> 引用历史发言请用 `#序号`。过程汇报（UPDATE）不收录，只留正式发言。',
    '',
  ];
  let currentHeading = null;
  for (const message of kept) {
    const heading = turnHeading(message);
    if (heading !== currentHeading) {
      currentHeading = heading;
      lines.push(heading, '');
    }
    const tags = [];
    if (message.systemNote) tags.push('系统提示');
    if (message.supplement) tags.push('中途补充');
    if (message.committeeAct) tags.push(`投委会·${message.committeeAct}`);
    const statusLabel = STATUS_LABELS[message.status];
    if (statusLabel) tags.push(statusLabel);
    const time = formatTime(message.createdAt);
    const meta = [time, ...tags].filter(Boolean).join(' · ');
    lines.push(`### #${message.seq} ${speakerOf(message)}${meta ? ` · ${meta}` : ''}`, '');
    const body = String(message.content == null ? '' : message.content);
    lines.push(body.length ? body : '（空）', '');
  }
  if (!kept.length) lines.push('（还没有发言）', '');
  return lines.join(NEWLINE);
}

/**
 * 只有内容真的变了才写盘。群聊状态每轮要保存很多次（每位成员结算一次、
 * 过程汇报一次），md 是全量重写，盲写会把一次群聊变成几十次整文件 IO。
 */
function transcriptSignature(state) {
  const messages = Array.isArray(state && state.messages) ? state.messages : [];
  let count = 0;
  let length = 0;
  for (const message of messages) {
    if (!message || isProgressUpdateMessage(message)) continue;
    count += 1;
    length += String(message.content == null ? '' : message.content).length;
    length += String(message.status || '').length;
  }
  return `${count}:${length}:${(state && state.nextMessageSeq) || 0}`;
}

function writeTranscriptFile(hubDataDir, meetingId, state, opts = {}) {
  const filePath = transcriptPath(hubDataDir, meetingId);
  const text = renderTranscriptMarkdown(state, opts);
  const writeFile = typeof opts.writeFile === 'function' ? opts.writeFile : null;
  if (writeFile) writeFile(filePath, text);
  else {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, text, 'utf8');
  }
  return filePath;
}

function cleanupTranscript(hubDataDir, meetingId) {
  const filePath = transcriptPath(hubDataDir, meetingId);
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch {}
}

module.exports = {
  ORIGIN_USER,
  ORIGIN_HUB,
  ORIGIN_SYSTEM,
  PROGRESS_UPDATE_STATUS,
  cleanupTranscript,
  isAssistantSpeech,
  isProgressUpdateMessage,
  isUserSpeech,
  renderTranscriptMarkdown,
  speakerOf,
  transcriptPath,
  transcriptSignature,
  writeTranscriptFile,
};
