'use strict';
// 把 welink-cli 查询结果整理成助理用的统一结构，并给每一条编出处编号（sourceId）。
// 简报和提醒里的每一句话都要能指回这里的一条原始记录：AI 写的条目带的出处在这里找不到，就删掉。
// 已核对字段见各函数注释；兼容字段与合成边界测试不代表新的公司接口契约已获验证。

const { createHash } = require('node:crypto');
const pad = n => String(n).padStart(2, '0');
const DISPLAY_ZONE = 'Asia/Shanghai';
const formatters = new Map();
function dateParts(at, timeZone = DISPLAY_ZONE) {
  if (!Number.isFinite(at)) return null;
  if (!formatters.has(timeZone)) formatters.set(timeZone, new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }));
  return Object.fromEntries(formatters.get(timeZone).formatToParts(at).filter(p => p.type !== 'literal').map(p => [p.type, Number(p.value)]));
}
const dayKey = (at = Date.now()) => { const d = dateParts(at); return d ? `${d.year}-${pad(d.month)}-${pad(d.day)}` : ''; };
const clock = at => { const d = dateParts(at); return d ? `${pad(d.hour)}:${pad(d.minute)}` : '时间待核对'; };
const weekdayOfDate = date => ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][new Date(`${date}T00:00:00Z`).getUTCDay()] || '';
const displayTime = at => { const d = dateParts(at); return d ? `${dayKey(at)} ${clock(at)}:${pad(d.second)}（${weekdayOfDate(dayKey(at))}，上海 UTC+08:00）` : '时间待核对'; };
const first = (o, keys) => { for (const k of keys) { const v = o && o[k]; if (v !== undefined && v !== null && v !== '') return v; } return undefined; };
const short = (s, n) => { s = String(s ?? '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n) + '…' : s; };

const ZONE_ALIASES = { 'China Standard Time': DISPLAY_ZONE, 'Pacific Standard Time': 'America/Los_Angeles', 'Eastern Standard Time': 'America/New_York', 'GMT Standard Time': 'Europe/London', UTC: 'UTC', GMT: 'UTC', 'Etc/UTC': 'UTC' };
function offsetMinutes(zone) {
  if (/^(?:Z|UTC|GMT)$/i.test(zone)) return 0;
  const m = String(zone).match(/^(?:UTC|GMT)?([+-])(\d{2}):?(\d{2})$/i);
  return m && Number(m[2]) <= 23 && Number(m[3]) <= 59 ? (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])) : null;
}
// 明确的 epoch/offset/timeZone 才能转换为瞬间。无时区的墙上时间不借用宿主时区猜测。
// DST 重复与缺失小时同样待核对；原始值留作出处，不静默丢弃。
function timeValue(raw, inheritedZone = '') {
  const object = raw && typeof raw === 'object';
  const value = object ? first(raw, ['dateTime', 'DateTime', 'date', 'Date']) : raw;
  const zone = String((object && first(raw, ['timeZone', 'TimeZone', 'timezone', 'time_zone', 'offset'])) || inheritedZone || '').trim();
  const result = (at, status, reason = '', sourceTimeZone = zone || null) => ({ at, status, reason, sourceTimeZone, raw: raw ?? null });
  if (value === undefined || value === null || value === '') return result(null, 'missing', 'missing-time');
  if (typeof value === 'number' || /^\d+$/.test(String(value))) {
    const n = Number(value), at = n < 1e11 ? n * 1000 : n;
    return Number.isFinite(at) && Number.isFinite(new Date(at).getTime()) ? result(at, 'known', '', 'epoch') : result(null, 'invalid', 'invalid-epoch');
  }
  const m = String(value).trim().match(/^(\d{4})-(\d\d)-(\d\d)[T ](\d\d):(\d\d)(?::(\d\d)(?:\.(\d{1,9}))?)?(Z|[+-]\d\d:?\d\d)?$/i);
  if (!m) return result(null, 'unknown', 'unrecognized-time');
  const parts = m.slice(1, 7).map(x => Number(x || 0)), ms = Number((m[7] || '').padEnd(3, '0').slice(0, 3));
  const [year, month, day, hour, minute, second] = parts;
  const wall = Date.UTC(year, month - 1, day, hour, minute, second, ms), check = new Date(wall);
  if (year < 100 || check.getUTCFullYear() !== year || check.getUTCMonth() + 1 !== month || check.getUTCDate() !== day || check.getUTCHours() !== hour || check.getUTCMinutes() !== minute || check.getUTCSeconds() !== second) return result(null, 'invalid', 'invalid-date');
  const explicitOffset = m[8], fixedOffset = offsetMinutes(explicitOffset || zone);
  if (explicitOffset || fixedOffset !== null) {
    if (fixedOffset === null) return result(null, 'invalid', 'invalid-offset');
    return result(wall - fixedOffset * 60000, 'known', '', explicitOffset || zone);
  }
  if (!zone) return result(null, 'unknown', 'missing-time-zone');
  const canonical = ZONE_ALIASES[zone] || zone;
  // Abbreviations such as CST are ambiguous, even when ICU accepts one meaning.
  if (canonical !== 'UTC' && !canonical.includes('/')) return result(null, 'unknown', 'unknown-time-zone');
  const matches = at => {
    const p = dateParts(at, canonical);
    return p.year === year && p.month === month && p.day === day && p.hour === hour && p.minute === minute && p.second === second;
  };
  try {
    const candidates = new Set();
    for (const delta of [-36, -12, 0, 12, 36]) {
      const sample = wall + delta * 3600000, p = dateParts(sample, canonical);
      const offset = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second, ms) - sample;
      const candidate = wall - offset;
      if (matches(candidate)) candidates.add(candidate);
    }
    if (candidates.size === 1) return result([...candidates][0], 'known', '', canonical);
    return result(null, 'unknown', candidates.size ? 'ambiguous-time' : 'nonexistent-time', canonical);
  } catch { return result(null, 'unknown', 'unknown-time-zone'); }
}
const toMs = (v, zone) => timeValue(v, zone).at;
function dateValue(raw) {
  const text = String(raw && typeof raw === 'object' ? first(raw, ['date', 'Date', 'dateTime', 'DateTime']) || '' : raw || '');
  const match = /^(\d{4}-\d\d-\d\d)(?:$|[ T])/.exec(text), date = match?.[1];
  if (!date) return null;
  const at = Date.parse(date + 'T00:00:00Z');
  return Number.isFinite(at) && new Date(at).toISOString().slice(0, 10) === date ? date : null;
}
const rawDateOnly = raw => /^\d{4}-\d\d-\d\d$/.test(String(raw && typeof raw === 'object' ? first(raw, ['date', 'Date', 'dateTime', 'DateTime']) || '' : raw || ''));
const zoneOf = (raw, inherited) => String((raw && typeof raw === 'object' && first(raw, ['timeZone', 'TimeZone', 'timezone', 'time_zone', 'offset'])) || inherited || '').trim();
const shiftDate = (date, days) => new Date(Date.parse(date + 'T00:00:00Z') + days * 86400000).toISOString().slice(0, 10);
function timedRange(start, end, endStatus = 'missing') {
  if (!Number.isFinite(start)) return '日期/时间待核对';
  const left = `${dayKey(start)}（${weekdayOfDate(dayKey(start))}）${clock(start)}`;
  if (endStatus === 'invalid' || endStatus === 'unknown') return `${left} – 结束时间待核对（上海 UTC+08:00）`;
  const right = Number.isFinite(end) ? (dayKey(end) === dayKey(start) ? clock(end) : `${dayKey(end)}（${weekdayOfDate(dayKey(end))}）${clock(end)}`) : '';
  return `${left}${right ? ' – ' + right : ''}（上海 UTC+08:00）`;
}
function eventTimes(e, startKeys, endKeys) {
  const zone = first(e, ['timeZone', 'TimeZone', 'timezone', 'time_zone']), startRaw = first(e, startKeys), endRaw = first(e, endKeys);
  const allDay = explicitBoolean(first(e, ['isAllDay', 'allDay', 'IsAllDay', 'is_all_day'])) || rawDateOnly(startRaw);
  const startDate = allDay ? dateValue(startRaw) : null, endDate = allDay ? dateValue(endRaw) : null;
  const startZone = zoneOf(startRaw, zone), endZone = zoneOf(endRaw, zone || startZone);
  const dateTime = (raw, inherited) => rawDateOnly(raw) && inherited ? { ...timeValue({ dateTime: dateValue(raw) + 'T00:00:00', timeZone: inherited }), raw } : timeValue(raw, inherited);
  let start = dateTime(startRaw, startZone), end = dateTime(endRaw, endZone);
  // 明确源时区的单个全天日期覆盖该源日历整天；下一午夜可能相隔 23/25 小时，不能简单加 24h。
  let endDerived = false;
  if (allDay && rawDateOnly(startRaw) && startDate && startZone && start.status === 'known' && end.status === 'missing') {
    end = { ...timeValue({ dateTime: shiftDate(startDate, 1) + 'T00:00:00', timeZone: startZone }), raw: null, derived: true, derivedFrom: 'all-day-next-local-midnight' };
    endDerived = true;
  }
  const dateOnly = allDay && startDate && !startZone && start.status !== 'known' && !/(?:Z|[+-]\d\d:?\d\d)$/i.test(String(startRaw && typeof startRaw === 'object' ? first(startRaw, ['dateTime', 'DateTime']) || '' : startRaw || ''));
  // 全天且未给时区时保留日历日期，不造出宿主时区的午夜瞬间。
  if (dateOnly) {
    start = { ...start, status: 'date-only', reason: '', date: startDate };
    if (endDate) end = { ...end, status: 'date-only', reason: '', date: endDate };
  }
  const reversed = Number.isFinite(start.at) && Number.isFinite(end.at) && end.at < start.at || dateOnly && endDate && endDate < startDate;
  if (reversed) end = { ...end, at: null, status: 'invalid', reason: 'end-before-start' };
  const dateEndExclusive = e.endExclusive === true || e.end_exclusive === true ? true : e.endExclusive === false || e.end_exclusive === false ? false : null;
  const known = start.status === 'known' && (end.status === 'known' || end.status === 'missing');
  const timeStatus = known ? 'known' : dateOnly && !reversed && (end.status === 'date-only' || end.status === 'missing') ? 'date-only' : 'unknown';
  let displayRange = timedRange(start.at, end.at, end.status);
  if (allDay && startDate) {
    const sourceDates = `${startDate} 全天（${weekdayOfDate(startDate)}）`;
    if (dateOnly) {
      if (!endDate || endDate === startDate || dateEndExclusive === true && endDate === shiftDate(startDate, 1)) displayRange = sourceDates + '；日历日期，时区未提供';
      else if (dateEndExclusive === true && !reversed) displayRange = `${startDate} 至 ${shiftDate(endDate, -1)} 全天；日历日期，时区未提供`;
      else displayRange = `${sourceDates}；结束日期 ${endDate}${dateEndExclusive === false ? '（含当日）' : '（是否含当日待核对）'}；时区未提供`;
      if (reversed) displayRange += '；结束早于开始，待核对';
      else if (!endDate && end.status !== 'missing') displayRange += '；结束日期/时间待核对';
    } else if (known) {
      const isShanghaiDay = clock(start.at) === '00:00' && (!Number.isFinite(end.at) || clock(end.at) === '00:00');
      const last = Number.isFinite(end.at) && end.at > start.at ? dayKey(end.at - 1) : dayKey(start.at);
      displayRange = isShanghaiDay ? `${dayKey(start.at)}${last !== dayKey(start.at) ? ' 至 ' + last : ''} 全天（${weekdayOfDate(dayKey(start.at))}${last !== dayKey(start.at) ? '至' + weekdayOfDate(last) : ''}，上海 UTC+08:00）` : `${sourceDates}；上海显示范围：${timedRange(start.at, end.at, end.status)}`;
    }
  }
  if (endDerived) displayRange += '；结束边界按全天日期推导';
  return { start: start.at, end: end.at, startDisplay: dateOnly ? `${startDate} 全天（${weekdayOfDate(startDate)}；日历日期）` : displayTime(start.at), endDisplay: end.status === 'missing' ? '' : dateOnly && endDate ? `${endDate}（日历日期）` : displayTime(end.at),
    displayTimeZone: dateOnly ? null : DISPLAY_ZONE, timeStatus, timeEvidence: { start, end }, displayRange,
    ...(allDay ? { allDay: true, startDate, endDate, dateEndExclusive } : {}), ...(endDerived ? { endDerived: true } : {}) };
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

// 出处代表具体记录版本：循环会议共用 ID、同 ID 冲突和跨源同名都不能互相覆盖。
// 对象键排序，避免接口仅调整键顺序就产生一条“新记录”。
function recordHash(value) {
  const canonical = v => Array.isArray(v) ? v.map(canonical) : v && typeof v === 'object'
    ? Object.fromEntries(Object.keys(v).sort().map(k => [k, canonical(v[k])])) : v;
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex').slice(0, 32);
}
function eventSource(base, raw, startEvidence) {
  return { sourceId: `${base}:r${recordHash(raw)}`, sourceBaseId: base,
    occurrenceId: `${base}:t${recordHash(Number.isFinite(startEvidence.at) ? startEvidence.at : startEvidence)}` };
}
function meetings(raw) {
  return listIn(raw, ['meetings', 'data']).map(m => {
    const id = String(first(m, ['meetingId', 'enMeetingId', 'id', 'confId']) ?? '');
    const times = eventTimes(m, ['meetingStartTime', 'startTime', 'start'], ['meetingEndTime', 'endTime', 'end']);
    const users = Array.isArray(m.meetingUsers) ? m.meetingUsers : [];
    return { ...eventSource('meeting:' + id, m, times.timeEvidence.start), id, subject: String(first(m, ['subject', 'topic', 'title']) ?? '（无主题）'), ...times,
      location: String(first(m, ['location', 'room']) ?? ''), attendees: users.length,
      hasFiles: Array.isArray(m.files) ? m.files.length : 0 };
  }).filter(m => m.id);
}

function calendarEvents(raw) {
  const anonymous = new Map();
  return listIn(raw, ['events', 'items', 'value', 'calendars']).map((e, i) => {
    const stableId = first(e, ['id', 'eventId', 'itemId', 'uid']);
    const id = String(stableId ?? i), hash = recordHash(e);
    // 无编号时不把数组下标当作跨刷新身份，也不合并两条内容相同的记录。
    const ordinal = (anonymous.get(hash) || 0) + 1; anonymous.set(hash, ordinal);
    const base = stableId != null ? 'cal:' + id : `cal:anon:${hash}:${ordinal}`;
    const times = eventTimes(e, ['start', 'startTime', 'Start', 'begin'], ['end', 'endTime', 'End']);
    return { ...eventSource(base, e, times.timeEvidence.start), id, subject: String(first(e, ['subject', 'Subject', 'title', 'summary']) ?? '（无标题）'), ...times, location: textOf(first(e, ['location', 'Location'])) };
  });
}

// 会话列表（im query-recent-conversation --count 50）：真机每个会话只有 8 个字段，没有最后消息时间、免打扰、置顶、未读数（Q-1018-10），
// welink-cli 的其他命令也查不到免打扰和置顶。私聊的 group_id 是 "0"。
function conversations(raw) {
  return (conversationRecords(raw) || []).map(c => {
    const groupId = c.group_id != null && String(c.group_id) !== '0' ? String(c.group_id) : '';
    const group = c.recent_conversation_type !== 'CHAT_TYPE_P2P_MSG' && (c.recent_conversation_type === 'CHAT_TYPE_GROUP_MSG' || (!!groupId && !c.target_account));
    const id = String(group ? groupId : (c.target_account || ''));
    return { id, group, name: String(first(c, group ? ['group_name', 'native_name'] : ['native_name', 'staff_name', 'target_account']) ?? id) };
  }).filter(c => c.id);
}

// 账号 → 姓名：私聊会话的对方（target_account → native_name）。
function namesOf(conversations) { return new Map((conversations || []).filter(c => !c.group && c.name && c.name !== c.id).map(c => [c.id, c.name])); }
// 只认消息列表路径；未知结构返回 null，不能把接口变更误报为“没有消息”。
function recordsAt(raw, keys) {
  if (Array.isArray(raw)) return raw.every(m => m && typeof m === 'object' && !Array.isArray(m)) ? raw : null;
  if (!raw || typeof raw !== 'object') return null;
  for (const key of keys) {
    if (Array.isArray(raw[key])) return recordsAt(raw[key], keys);
  }
  for (const key of ['data', 'result', 'payload', 'respData']) if (raw[key] && typeof raw[key] === 'object') {
    const found = recordsAt(raw[key], keys); if (found !== null) return found;
  }
  return null;
}
const messageRecords = raw => recordsAt(raw, ['chatInfo', 'messages', 'message_list', 'msgList', 'history', 'msgs', 'data']);
const conversationRecords = raw => recordsAt(raw, ['conversation_info', 'conversations', 'data']);
const messageId = m => first(m, ['msgId', 'msg_id', 'message_id', 'messageId', 'id']);
const explicitBoolean = v => v === true || v === 1 || (typeof v === 'string' && /^(true|1)$/i.test(v.trim()));

// 一个会话的历史消息。me：本人账号（auth status 的 UID），用来判断「最后一句是不是我说的」「有没有 @ 我」。
// 真机字段（Q-1018-04、Q-1018-10）：列表在 chatInfo 里；msgId（长整数）、sender（账号，和 auth status 的 UID 同格式）、content、contentType、
// serverSendTime（毫秒）、at（这条有没有 @ 人）、atAccountList（被点名 @ 的账号；@所有人 时是空数组）。
// names：账号 → 姓名（真机消息只有账号；私聊对方的姓名从会话列表拿）。自己发的显示「我」。
function messages(raw, conv, me, { myName = '', names = null } = {}) {
  const list = messageRecords(raw) || [];
  return list.map((m, i) => {
    const time = timeValue(first(m, ['serverSendTime', 'server_send_time', 'send_time', 'sendTime', 'msg_time', 'msgTime', 'time', 'timestamp', 'create_time', 'createTime']), first(m, ['timeZone', 'TimeZone']));
    const at = time.at;
    const account = String(first(m, ['sender_account', 'senderAccount', 'from_account', 'fromAccount', 'sender_id', 'senderId', 'sender', 'from', 'account']) ?? '');
    const named = first(m, ['sender_name', 'senderName', 'staff_name', 'native_name', 'nick_name', 'from_name']);
    const key = String(first(m, ['msgId', 'msg_id', 'message_id', 'messageId', 'id']) ?? `${at || 0}-${i}`);
    const mine = explicitBoolean(m.is_self) || explicitBoolean(m.isSelf) || m.direction === 'send' || (!!me && account === String(me));
    const sender = mine ? '我' : String(named ?? (names && names.get(account)) ?? account);
    const content = first(m, ['content', 'msg_content', 'msgContent', 'text', 'message', 'body']) ?? '';
    const text = textOf(content);
    const contentType = String(first(m, ['contentType', 'content_type', 'msgType']) ?? '');
    const atList = Array.isArray(m.atAccountList) ? m.atAccountList.map(String) : [];
    const atFlag = explicitBoolean(m.at), atSelf = first(m, ['atself', 'atSelf', 'at_self']);
    const atMe = !mine && (explicitBoolean(atSelf) || (!!me && atList.includes(String(me))) || (!!myName && text.includes('@' + myName)));
    const atAll = !mine && !atMe && (explicitBoolean(first(m, ['atall', 'atAll', 'at_all'])) || atFlag && !atList.length);
    return { sourceId: `msg:${conv.id}:${key}`, conv: conv.id, convName: conv.name, group: conv.group, key, at, sender, account, mine, atMe, atAll, text, content, contentType,
      displayTime: displayTime(at), timeStatus: time.status === 'known' ? 'known' : 'unknown', timeEvidence: time,
      mentionEvidence: { at: m.at ?? null, atself: atSelf ?? null, atAccountList: atList },
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

// 私聊最后一句由别人发送；群内@缺少与回复的可靠关联，保留待核对，不能因任意本人发言自动结案。
function awaiting(snapshot, { myName = '' } = {}) {
  const out = [];
  for (const conv of snapshot.conversations || []) {
    const list = (snapshot.messages || {})[conv.id] || [];
    if (!list.length) continue;
    const last = list[list.length - 1];
    if (!conv.group) { if (!last.mine) out.push({ ...last, since: last.at }); continue; }
    for (const hit of list.filter(m => !m.mine && (m.atMe || (!!myName && m.text.includes('@' + myName))))) {
      out.push({ ...hit, since: hit.at, needsReplyReview: true });
    }
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
  for (const m of snapshot.meetings || []) map.set(m.sourceId, { kind: 'meeting', label: `会议 · ${m.allDay ? m.displayRange : clock(m.start)} ${m.subject}`, item: m });
  for (const e of snapshot.calendar || []) map.set(e.sourceId, { kind: 'calendar', label: `日程 · ${e.allDay ? e.displayRange : clock(e.start)} ${e.subject}`, item: e });
  for (const list of Object.values(snapshot.messages || {})) for (const m of list) map.set(m.sourceId, { kind: 'message', label: `${m.group ? '群 ' + m.convName : '私聊'} · ${m.sender}${m.at ? ' ' + clock(m.at) : ''}`, item: m });
  for (const m of snapshot.mails || []) map.set(m.sourceId, { kind: 'mail', label: `邮件 · ${m.from} · ${m.subject}`, item: m });
  return map;
}

// 今天的会议记录。两源没有已核实的共享事件身份，不能凭标题/时段删除另一条。
function todaysMeetings(snapshot, day) {
  const dayStart = Date.parse(day + 'T00:00:00+08:00'), range = { start: dayStart, end: dayStart + 86400000 };
  const inDay = x => Number.isFinite(x.start) ? eventInRange(x, range) : x.allDay && x.timeStatus === 'date-only' && (x.startDate === day || x.endDate && x.dateEndExclusive !== null && x.startDate <= day && (x.dateEndExclusive ? day < x.endDate : day <= x.endDate));
  return [...(snapshot.meetings || []), ...(snapshot.calendar || [])].filter(inDay).sort((a, b) => (a.start || 0) - (b.start || 0));
}
function unresolvedMeetings(snapshot) {
  return [...(snapshot.meetings || []), ...(snapshot.calendar || [])].filter(m => !Number.isFinite(m.start) && !(m.allDay && m.timeStatus === 'date-only' && m.startDate));
}
// 日期型全天日程不伪装成瞬间；未知时间仍留在查询里并由 coverage 提示待核对。
function eventTimeUnknown(m) {
  if (m.timeStatus === 'unknown') return true;
  if (m.allDay && m.timeStatus === 'date-only' && m.startDate) return !!(m.endDate && m.endDate !== m.startDate && m.dateEndExclusive === null);
  return !Number.isFinite(m.start);
}
function eventInRange(m, range) {
  if (Number.isFinite(m.start)) return m.start < range.end && (Number.isFinite(m.end) ? m.end > range.start : m.start >= range.start);
  if (m.allDay && m.timeStatus === 'date-only' && m.startDate) {
    const last = m.endDate && m.endDate >= m.startDate ? (m.dateEndExclusive === true ? shiftDate(m.endDate, -1) : m.endDate) : m.startDate;
    return m.startDate <= dayKey(range.end - 1) && last >= dayKey(range.start);
  }
  return true;
}

module.exports = { DISPLAY_ZONE, dayKey, clock, displayTime, dateParts, timeValue, toMs, explicitBoolean, listIn, textOf, short, namesOf, messageRecords, conversationRecords, messageId, meetings, calendarEvents, conversations, messages, mails, awaiting, relatedGroups, sourceIndex, todaysMeetings, unresolvedMeetings, eventTimeUnknown, eventInRange };
