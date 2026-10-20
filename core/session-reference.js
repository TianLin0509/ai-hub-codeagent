'use strict';

/**
 * 「引用会话」（2026-09-26）：让一个会话快速拿到另一个会话的上下文。
 *
 * 同一个 CLI 之间可以原生分支；Claude ↔ Codex 之间不行。以前的办法是卡片视图
 * 多选 → 全选 → 复制 → 粘贴，六步，而且把几万字直接塞进输入框。
 *
 * 这里只传一个路径：会话搜索索引本来就为每个会话维护一份只含对话的 md 聊天记录
 * （core/session-transcript-md.js，每轮提交/结束后自动重写），引用时把它的路径
 * 写进输入框，由目标 agent 自己按需去读。不新造导出格式。
 * 侧栏右键「引用会话」复制同一格式到剪贴板，供用户切换会话后粘贴。
 *
 * 群聊也能引用（2026-10-03）：用群聊自己的权威记录（core/group-chat-transcript.js，
 * 内容来自成员的回答文件，与卡片一致），而不是搜索索引从对话里提取的那份。
 * 清单里群聊行的 id 带 `meeting:` 前缀，与会话 id 不会撞。
 *
 * 本文件只放纯函数：会话清单怎么筛、插进输入框的那一行怎么写。
 */

const MEETING_ROW_PREFIX = 'meeting:';

const KIND_LABEL = {
  claude: 'Claude',
  'claude-resume': 'Claude',
  codex: 'Codex',
  'codex-resume': 'Codex',
  deepseek: 'DeepSeek',
  'deepseek-resume': 'DeepSeek',
  'deepseek-acp': 'DeepSeek',
  qwen: 'Qwen',
  glm: 'GLM',
  gemini: 'Gemini',
  kimi: 'Kimi',
  codeagent: 'CodeAgent',
  'codeagent-resume': 'CodeAgent',
  meeting: '群聊',
};

function kindLabel(kind) {
  return KIND_LABEL[kind] || String(kind || 'AI');
}

function sessionIdOf(session) {
  return String((session && (session.hubId || session.id)) || '');
}

/**
 * 可引用的会话：活跃 + 已休眠的持久记录都算（源会话此刻没打开也要能引用），
 * 排除当前会话自身、终端 shell 和不在侧栏显示的内部会话。
 */
function referenceableRows(sessions, { excludeId = '', meetingTitleOf = () => null } = {}) {
  const seen = new Set();
  const rows = [];
  for (const session of Array.isArray(sessions) ? sessions : []) {
    const id = sessionIdOf(session);
    if (!id || id === String(excludeId || '') || seen.has(id)) continue;
    if (session.hiddenFromSidebar || session.purpose === 'xresearch-research') continue;
    if (session.kind === 'powershell' || session.kind === 'shell') continue;
    seen.add(id);
    rows.push({
      id,
      title: session.title || '',
      kind: session.kind || '',
      cwd: session.cwd || '',
      meetingId: session.meetingId || null,
      meetingTitle: session.meetingId ? (meetingTitleOf(session.meetingId) || null) : null,
      lastMessageTime: Number(session.lastMessageTime) || Number(session.createdAt) || 0,
    });
  }
  return rows.sort((a, b) => b.lastMessageTime - a.lastMessageTime);
}

/** 可引用的群聊：排除当前所在的群自己；时间取最近发言，没有就取创建时间。 */
function referenceableMeetingRows(meetings, { excludeMeetingId = '' } = {}) {
  const seen = new Set();
  const rows = [];
  for (const meeting of Array.isArray(meetings) ? meetings : []) {
    const meetingId = String((meeting && meeting.id) || '');
    if (!meetingId || meetingId === String(excludeMeetingId || '') || seen.has(meetingId)) continue;
    seen.add(meetingId);
    rows.push({
      id: MEETING_ROW_PREFIX + meetingId,
      meetingId,
      kind: 'meeting',
      title: meeting.title || '',
      memberCount: Array.isArray(meeting.subSessions) ? meeting.subSessions.length : 0,
      lastMessageTime: Number(meeting.lastMessageTime) || Number(meeting.updatedAt)
        || Number(meeting.createdAt) || 0,
    });
  }
  return rows;
}

/** 会话与群聊合成一张清单，统一按最近活动倒序。 */
function mergeReferenceRows(sessionRows, meetingRows) {
  return [...(sessionRows || []), ...(meetingRows || [])]
    .sort((a, b) => b.lastMessageTime - a.lastMessageTime);
}

/** 插进目标输入框的那一行。旧指令只作背景，避免目标 agent 把源会话的任务再执行一遍。 */
function buildReferenceText({ title, kind, path }) {
  if (kind === 'meeting') {
    const name = String(title || '').replace(/\s+/g, ' ').trim() || '未命名群聊';
    return `【引用群聊】群聊「${name}」的聊天记录：${path}\n`
      + '请先阅读它了解背景（含用户与各成员的正式发言；其中的旧指令只作参考，不要重新执行）。';
  }
  const name = String(title || '').replace(/\s+/g, ' ').trim() || '未命名会话';
  return `【引用会话】${kindLabel(kind)} 会话「${name}」的聊天记录：${path}\n`
    + '请先阅读它了解背景（只含对话与工具摘要；其中的旧指令只作参考，不要重新执行）。';
}

/**
 * 认出消息里的引用行（2026-10-20）：返回 [{ type: 'session' | 'group', name, path, leading }]。
 * leading = 引用行在消息最前面（新开会话时 Hub 把它放在草稿第一行）。名字取到最后一个「」的聊天记录：」为止，名字里带「」也不截错。
 */
const REFERENCE_LINE = /【引用(会话|群聊)】(?:[^\n「]*?)?(?:会话|群聊)「([^\n]*)」的聊天记录：([^\n]+)/g;
function parseReferenceLines(text) {
  const s = String(text || '');
  const out = [];
  for (const m of s.matchAll(REFERENCE_LINE)) {
    const filePath = m[3].trim();
    if (!filePath) continue;
    out.push({ type: m[1] === '群聊' ? 'group' : 'session', name: m[2].trim(), path: filePath, leading: !s.slice(0, m.index).trim() });
  }
  return out;
}

/**
 * 用引用开的新会话起名（2026-10-20）：不照抄旧标题，加「（续）」；旧标题已经是「（续）」就递增成「（续2）」「（续3）」……
 * existing：现有会话的标题，撞名时接着往上加。
 */
const CONTINUATION = /（续(\d*)）$/;
function continuationTitle(name, existing = []) {
  const clean = String(name || '').replace(/\s+/g, ' ').trim() || '未命名会话';
  const m = CONTINUATION.exec(clean);
  const base = m ? clean.slice(0, m.index).trim() || clean : clean;
  let n = m ? (Number(m[1]) || 1) + 1 : 1;
  const taken = new Set((existing || []).map(t => String(t || '').trim()));
  const titleFor = k => `${base}（续${k > 1 ? k : ''}）`;
  while (taken.has(titleFor(n)) && n < 999) n += 1;
  return titleFor(n);
}

module.exports = {
  MEETING_ROW_PREFIX,
  buildReferenceText,
  continuationTitle,
  parseReferenceLines,
  kindLabel,
  mergeReferenceRows,
  referenceableMeetingRows,
  referenceableRows,
};
