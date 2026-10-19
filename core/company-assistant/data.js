'use strict';
// 把 welink-cli 查询结果整理成助理用的统一结构，并给每一条编出处编号（sourceId）。
// 简报和提醒里的每一句话都要能指回这里的一条原始记录：AI 写的条目带的出处在这里找不到，就删掉。
// 字段名依据公司真机回执（Q-1016-19）；历史消息、邮件、日程的字段还没见过真样本，按常见写法多认几种。

const pad = n => String(n).padStart(2, '0');
const dayKey = (at = Date.now()) => { const d = new Date(at); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const clock = at => { const d = new Date(at); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const first = (o, keys) => { for (const k of keys) { const v = o && o[k]; if (v !== undefined && v !== null && v !== '') return v; } return undefined; };
const short = (s, n) => { s = String(s ?? '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n) + '…' : s; };

// 时间：毫秒、秒、ISO 字符串、「2026-10-16 09:30」都认。
function toMs(v) {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v === 'number' || /^\d+$/.test(String(v))) { const n = Number(v); return n < 1e11 ? n * 1000 : n; }
  const t = Date.parse(String(v).replace(/^(\d{4}-\d\d-\d\d) (\d)/, '$1T$2'));
  return Number.isFinite(t) ? t : null;
}
// 回执里第一个对象数组（不同命令把列表放在不同的键下）。
function listIn(obj, keys = []) {
  if (Array.isArray(obj)) return obj;
  if (!obj || typeof obj !== 'object') return [];
  for (const k of keys) if (Array.isArray(obj[k])) return obj[k];
  for (const v of Object.values(obj)) if (Array.isArray(v) && v.some(x => x && typeof x === 'object')) return v;
  for (const v of Object.values(obj)) if (v && typeof v === 'object' && !Array.isArray(v)) { const inner = listIn(v, keys); if (inner.length) return inner; }
  return [];
}
const textOf = v => {
  if (v == null) return '';
  if (typeof v === 'string') { const s = v.trim(); if (/^[{[]/.test(s)) { try { return textOf(JSON.parse(s)); } catch { /* 原样 */ } } return v; }
  if (typeof v === 'object') return String(first(v, ['text', 'content', 'msg', 'title', 'body']) ?? '');
  return String(v);
};

function meetings(raw) {
  return listIn(raw, ['meetings', 'data']).map(m => {
    const id = String(first(m, ['meetingId', 'enMeetingId', 'id', 'confId']) ?? '');
    const start = toMs(first(m, ['meetingStartTime', 'startTime', 'start']));
    const end = toMs(first(m, ['meetingEndTime', 'endTime', 'end']));
    const users = Array.isArray(m.meetingUsers) ? m.meetingUsers : [];
    return { sourceId: 'meeting:' + id, id, subject: String(first(m, ['subject', 'topic', 'title']) ?? '（无主题）'), start, end,
      location: String(first(m, ['location', 'room']) ?? ''), attendees: users.length,
      hasFiles: Array.isArray(m.files) ? m.files.length : 0 };
  }).filter(m => m.id && m.start);
}

function calendarEvents(raw) {
  return listIn(raw, ['events', 'items', 'value', 'calendars']).map((e, i) => {
    const id = String(first(e, ['id', 'eventId', 'itemId', 'uid']) ?? i);
    // 时间可能是值，也可能是 { dateTime } 对象（Exchange 写法）。
    const when = keys => { const v = first(e, keys); return toMs(v && typeof v === 'object' ? first(v, ['dateTime', 'DateTime']) : v); };
    const start = when(['start', 'startTime', 'Start', 'begin']);
    const end = when(['end', 'endTime', 'End']);
    return { sourceId: 'cal:' + id, id, subject: String(first(e, ['subject', 'Subject', 'title', 'summary']) ?? '（无标题）'), start, end, location: textOf(first(e, ['location', 'Location'])) };
  }).filter(e => e.start);
}

// 会话列表（im query-recent-conversation --count 50）：真机每个会话只有 8 个字段，没有最后消息时间、免打扰、置顶、未读数（Q-1018-10），
// welink-cli 的其他命令也查不到免打扰和置顶。单聊的 group_id 是 "0"。
function conversations(raw) {
  return (conversationRecords(raw) || []).map(c => {
    const group = c.recent_conversation_type === 'CHAT_TYPE_GROUP_MSG' || (!!c.group_id && !c.target_account);
    const id = String(group ? c.group_id : (c.target_account || c.group_id || '')) || '';
    return { id, group, name: String(first(c, group ? ['group_name', 'native_name'] : ['native_name', 'staff_name', 'target_account']) ?? id) };
  }).filter(c => c.id);
}

// 账号 → 姓名：单聊会话的对方（target_account → native_name）。
function namesOf(conversations) { return new Map((conversations || []).filter(c => !c.group && c.name && c.name !== c.id).map(c => [c.id, c.name])); }
// 只认消息列表路径；未知结构返回 null，不能把接口变更误报为“没有消息”。
function recordsAt(raw, keys) {
  if (Array.isArray(raw)) return raw.every(m => m && typeof m === 'object' && !Array.isArray(m)) ? raw : null;
  if (!raw || typeof raw !== 'object') return null;
  for (const key of keys) {
    if (Array.isArray(raw[key])) return recordsAt(raw[key], keys);
  }
  for (const key of ['data', 'result', 'payload']) if (raw[key] && typeof raw[key] === 'object') {
    const found = recordsAt(raw[key], keys); if (found !== null) return found;
  }
  return null;
}
const messageRecords = raw => recordsAt(raw, ['chatInfo', 'messages', 'message_list', 'msgList', 'history', 'msgs', 'data']);
const conversationRecords = raw => recordsAt(raw, ['conversation_info', 'conversations', 'data']);
const messageId = m => first(m, ['msgId', 'msg_id', 'message_id', 'messageId', 'id']);

// 一个会话的历史消息。me：本人账号（auth status 的 UID），用来判断「最后一句是不是我说的」「有没有 @ 我」。
// 真机字段（Q-1018-04、Q-1018-10）：列表在 chatInfo 里；msgId（长整数）、sender（账号，和 auth status 的 UID 同格式）、content、contentType、
// serverSendTime（毫秒）、at（这条有没有 @ 人）、atAccountList（被点名 @ 的账号；@所有人 时是空数组）。
// names：账号 → 姓名（真机消息只有账号；单聊对方的姓名从会话列表拿）。自己发的显示「我」。
function messages(raw, conv, me, { myName = '', names = null } = {}) {
  const list = messageRecords(raw) || [];
  return list.map((m, i) => {
    const at = toMs(first(m, ['serverSendTime', 'server_send_time', 'send_time', 'sendTime', 'msg_time', 'msgTime', 'time', 'timestamp', 'create_time', 'createTime']));
    const account = String(first(m, ['sender_account', 'senderAccount', 'from_account', 'fromAccount', 'sender_id', 'senderId', 'sender', 'from', 'account']) ?? '');
    const named = first(m, ['sender_name', 'senderName', 'staff_name', 'native_name', 'nick_name', 'from_name']);
    const key = String(first(m, ['msgId', 'msg_id', 'message_id', 'messageId', 'id']) ?? `${at || 0}-${i}`);
    const mine = m.is_self === true || m.isSelf === true || m.direction === 'send' || (!!me && account === me);
    const sender = mine ? '我' : String(named ?? (names && names.get(account)) ?? account);
    const content = first(m, ['content', 'msg_content', 'msgContent', 'text', 'message', 'body']) ?? '';
    const text = textOf(content);
    const contentType = String(first(m, ['contentType', 'content_type', 'msgType']) ?? '');
    const atList = Array.isArray(m.atAccountList) ? m.atAccountList.map(String) : [];
    const atFlag = m.at === true || m.at === 'true';
    const atMe = !mine && ((!!me && atList.includes(me)) || (!!myName && text.includes('@' + myName)));
    const atAll = !mine && !atMe && atFlag && !atList.length;
    return { sourceId: `msg:${conv.id}:${key}`, conv: conv.id, convName: conv.name, group: conv.group, key, at, sender, account, mine, atMe, atAll, text, content, contentType,
      preview: short(text, 200) || (contentType ? `［非文字消息 · ${contentType}］` : '［消息正文为空］') };
  }).sort((a, b) => (a.at || 0) - (b.at || 0));
}

function mails(raw) {
  return listIn(raw, ['mails', 'messages', 'items', 'value', 'data']).map((m, i) => {
    const id = String(first(m, ['id', 'mailId', 'messageId', 'itemId', 'uid']) ?? i);
    const from = first(m, ['from', 'sender', 'From', 'fromName', 'from_name']);
    return { sourceId: 'mail:' + id, id, subject: String(first(m, ['subject', 'Subject', 'title']) ?? '（无主题）'),
      from: typeof from === 'object' ? String(first(from, ['name', 'Name', 'address', 'email']) ?? '') : String(from ?? ''),
      at: toMs(first(m, ['receivedTime', 'received', 'date', 'time', 'sendTime', 'DateTimeReceived'])),
      preview: short(textOf(first(m, ['preview', 'summary', 'bodyPreview', 'body', 'content'])), 200),
      important: /high|重要|urgent/i.test(String(first(m, ['importance', 'Importance', 'priority']) ?? '')) };
  });
}

// 「等你回复」：单聊里最后一句不是我说的；群里有人 @ 我（atAccountList 里有我的账号，或文字里有「@我的名字」）且我之后没在群里说过话。
function awaiting(snapshot, { myName = '' } = {}) {
  const out = [];
  for (const conv of snapshot.conversations || []) {
    const list = (snapshot.messages || {})[conv.id] || [];
    if (!list.length) continue;
    const last = list[list.length - 1];
    if (!conv.group) { if (!last.mine && last.at) out.push({ ...last, since: last.at }); continue; }
    const lastMine = Math.max(0, ...list.filter(m => m.mine).map(m => m.at || 0));
    const hit = [...list].reverse().find(m => !m.mine && (m.at || 0) > lastMine && (m.atMe || (!!myName && m.text.includes('@' + myName))));
    if (hit && hit.at) out.push({ ...hit, since: hit.at });
  }
  return out.sort((a, b) => a.since - b.since);
}

// 「群里和你相关」：回看时间内有人 @ 你、提到关注词，或者你自己在群里说过话的群（替代原来要手动勾选的「关注群」）。
// 排序：@ 你的次数 → 提到关注词的 → 你参与的 → 消息多的。
function relatedGroups(snapshot, { keywords = [], since = 0 } = {}) {
  const words = (keywords || []).map(w => String(w).trim()).filter(Boolean);
  const rows = [];
  for (const conv of snapshot.conversations || []) {
    if (!conv.group) continue;
    const list = ((snapshot.messages || {})[conv.id] || []).filter(m => !since || !m.at || m.at >= since);
    if (!list.length) continue;
    const atMe = list.filter(m => m.atMe), mine = list.filter(m => m.mine), hits = words.length ? list.filter(m => !m.mine && words.some(w => m.text.includes(w))) : [];
    if (!atMe.length && !mine.length && !hits.length) continue;
    const key = atMe.at(-1) || hits.at(-1) || list.at(-1);
    rows.push({ conv, count: list.length, atMe: atMe.length, mine: mine.length, keyword: hits.length, key });
  }
  return rows.sort((a, b) => b.atMe - a.atMe || b.keyword - a.keyword || b.mine - a.mine || b.count - a.count);
}

// 出处表：sourceId → 这一条原始记录（简报核对与「看出处」都用它）。
function sourceIndex(snapshot) {
  const map = new Map();
  for (const m of snapshot.meetings || []) map.set(m.sourceId, { kind: 'meeting', label: `会议 · ${clock(m.start)} ${m.subject}`, item: m });
  for (const e of snapshot.calendar || []) map.set(e.sourceId, { kind: 'calendar', label: `日程 · ${clock(e.start)} ${e.subject}`, item: e });
  for (const list of Object.values(snapshot.messages || {})) for (const m of list) map.set(m.sourceId, { kind: 'message', label: `${m.group ? '群 ' + m.convName : '单聊'} · ${m.sender}${m.at ? ' ' + clock(m.at) : ''}`, item: m });
  for (const m of snapshot.mails || []) map.set(m.sourceId, { kind: 'mail', label: `邮件 · ${m.from} · ${m.subject}`, item: m });
  return map;
}

// 今天的会（WeLink 会议 + Exchange 日程去重：同一开始时间、同主题的只留会议那条）。
function todaysMeetings(snapshot, day) {
  const inDay = x => x.start && dayKey(x.start) === day;
  const ms = (snapshot.meetings || []).filter(inDay);
  const seen = new Set(ms.map(m => `${m.start}|${m.subject}`));
  const cal = (snapshot.calendar || []).filter(inDay).filter(e => !seen.has(`${e.start}|${e.subject}`));
  return [...ms, ...cal].sort((a, b) => a.start - b.start);
}

module.exports = { dayKey, clock, toMs, listIn, textOf, short, namesOf, messageRecords, conversationRecords, messageId, meetings, calendarEvents, conversations, messages, mails, awaiting, relatedGroups, sourceIndex, todaysMeetings };
