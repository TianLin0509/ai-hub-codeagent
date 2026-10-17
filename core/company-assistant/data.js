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

function conversations(raw) {
  return listIn(raw, ['conversation_info', 'conversations']).map(c => {
    const group = c.recent_conversation_type === 'CHAT_TYPE_GROUP_MSG' || (!!c.group_id && !c.target_account);
    const id = String(group ? c.group_id : (c.target_account || c.group_id || '')) || '';
    return { id, group, name: String(first(c, group ? ['group_name', 'native_name'] : ['staff_name', 'native_name', 'target_account']) ?? id) };
  }).filter(c => c.id);
}

// 一个会话的历史消息。me：本人账号（auth status 的 UID），用来判断「最后一句是不是我说的」。
function messages(raw, conv, me) {
  const list = listIn(raw, ['messages', 'message_list', 'history', 'msgs', 'data']);
  return list.map((m, i) => {
    const at = toMs(first(m, ['send_time', 'sendTime', 'msg_time', 'msgTime', 'time', 'timestamp', 'create_time', 'createTime']));
    const account = String(first(m, ['sender_account', 'senderAccount', 'from_account', 'fromAccount', 'sender_id', 'senderId', 'from', 'account']) ?? '');
    const sender = String(first(m, ['sender_name', 'senderName', 'staff_name', 'native_name', 'nick_name', 'sender', 'from_name']) ?? account);
    const key = String(first(m, ['msg_id', 'msgId', 'message_id', 'messageId', 'id']) ?? `${at || 0}-${i}`);
    const mine = m.is_self === true || m.isSelf === true || m.direction === 'send' || (!!me && (account === me || sender === me));
    return { sourceId: `msg:${conv.id}:${key}`, conv: conv.id, convName: conv.name, group: conv.group, key, at, sender, account, mine,
      text: short(textOf(first(m, ['content', 'msg_content', 'msgContent', 'text', 'message', 'body'])), 400) };
  }).filter(m => m.text).sort((a, b) => (a.at || 0) - (b.at || 0));
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

// 「等你回复」：单聊里最后一句不是我说的；群里有人 @ 我（设置里填了我的名字时）且我之后没在群里说过话。
function awaiting(snapshot, { myName = '' } = {}) {
  const out = [];
  for (const conv of snapshot.conversations || []) {
    const list = (snapshot.messages || {})[conv.id] || [];
    if (!list.length) continue;
    const last = list[list.length - 1];
    if (!conv.group) { if (!last.mine && last.at) out.push({ ...last, since: last.at }); continue; }
    if (!myName) continue;
    const lastMine = Math.max(0, ...list.filter(m => m.mine).map(m => m.at || 0));
    const hit = [...list].reverse().find(m => !m.mine && (m.at || 0) > lastMine && m.text.includes('@' + myName));
    if (hit && hit.at) out.push({ ...hit, since: hit.at });
  }
  return out.sort((a, b) => a.since - b.since);
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

module.exports = { dayKey, clock, toMs, listIn, textOf, short, meetings, calendarEvents, conversations, messages, mails, awaiting, sourceIndex, todaysMeetings };
