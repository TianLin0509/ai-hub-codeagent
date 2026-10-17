'use strict';
// 助理的 6 条主动提醒（2026-10-16 定：6 条都要）。这里只算「现在该发哪些」，发不发、发几条由服务按限流决定：
//   会前准备卡（开会前 N 分钟）、等你回复太久、答应的事快到期（前一天傍晚、当天上午）、会议排太满、下班前小结、关注词。
// 每条提醒的 id 固定（同一件事只提醒一次）；每小时最多几条（默认 3），超出的下一轮再算、顺延发出。
const D = require('./data');

const PRIORITY = { 'meeting-prep': 0, overbooked: 1, 'commitment-due': 2, 'awaiting-reply': 3, keyword: 4, 'day-summary': 5, brief: 0 };
const minutesOf = hhmm => { const [h, m] = String(hhmm || '').split(':').map(Number); return (Number(h) || 0) * 60 + (Number(m) || 0); };
const nowMinutes = now => { const d = new Date(now); return d.getHours() * 60 + d.getMinutes(); };
const isWorkday = (now, settings) => (settings.workdays || [1, 2, 3, 4, 5]).includes(new Date(now).getDay());

// 会议排太满：有重叠，或首尾相接（间隔不超过 15 分钟）连着开满 3 小时。
function overbooked(list, { blockHours = 3, gapMinutes = 15 } = {}) {
  const ms = list.filter(m => m.start && m.end && m.end > m.start).sort((a, b) => a.start - b.start);
  const overlaps = [];
  let block = null, longest = null;
  for (let i = 0; i < ms.length; i += 1) {
    const m = ms[i];
    if (i > 0 && m.start < ms[i - 1].end) overlaps.push([ms[i - 1], m]);
    if (block && m.start - block.end <= gapMinutes * 60000) { block.end = Math.max(block.end, m.end); block.items.push(m); }
    else block = { start: m.start, end: m.end, items: [m] };
    if (!longest || block.end - block.start > longest.end - longest.start) longest = { ...block, items: [...block.items] };
  }
  const long = longest && longest.end - longest.start >= blockHours * 3600000 && longest.items.length > 1 ? longest : null;
  return overlaps.length || long ? { overlaps, long } : null;
}

function dueNotices({ snapshot, settings, now, commitments = [], sessionId = null }) {
  if (!snapshot || !isWorkday(now, settings)) return [];
  const day = D.dayKey(now), minute = nowMinutes(now), out = [];
  const add = n => out.push({ sessionId, at: now, ...n });
  const meetings = D.todaysMeetings(snapshot, day);
  // 1. 会前准备卡
  const prepMs = (Number(settings.prepMinutes) || 15) * 60000;
  for (const m of meetings) {
    const left = m.start - now;
    if (left > 0 && left <= prepMs) {
      add({ id: `prep:${m.sourceId}:${day}`, kind: 'meeting-prep', title: `${Math.max(1, Math.round(left / 60000))} 分钟后开会：${D.short(m.subject, 40)}`,
        text: [`${D.clock(m.start)}${m.end ? '–' + D.clock(m.end) : ''} ${m.subject}`, m.location ? '地点：' + m.location : '', m.attendees ? `参会 ${m.attendees} 人${m.hasFiles ? '，会议附了材料' : ''}` : '',
          '在助理页点「下午会前准备」，助理会把相关消息、邮件和材料整理成要点。'].filter(Boolean).join('\n'), detail: { source: m.sourceId } });
    }
  }
  // 2. 会议排太满（简报时间之后、最后一场会结束前）
  const busy = overbooked(meetings);
  if (busy && minute >= minutesOf(settings.briefTime || '08:20') && meetings.some(m => (m.end || m.start) > now)) {
    const parts = [];
    if (busy.long) parts.push(`${D.clock(busy.long.start)}–${D.clock(busy.long.end)} 连着 ${busy.long.items.length} 场会、${(Math.round((busy.long.end - busy.long.start) / 360000) / 10)} 小时`);
    for (const [a, b] of busy.overlaps.slice(0, 3)) parts.push(`「${D.short(a.subject, 16)}」和「${D.short(b.subject, 16)}」时间重叠`);
    add({ id: `overbooked:${day}`, kind: 'overbooked', title: '今天会议排得太满', text: parts.join('\n') + '\n可以考虑推掉或请人代参加其中一场。' });
  }
  // 3. 答应的事快到期：前一天 17:00 后提醒一次，当天 09:00 后再提醒一次
  const tomorrow = D.dayKey(now + 86400000);
  for (const c of commitments) {
    if (!c.due) continue;
    if (c.due === tomorrow && minute >= 17 * 60) add({ id: `commit:${c.source}:${c.due}:eve`, kind: 'commitment-due', title: '明天到期：' + D.short(c.text, 40), text: c.text + (c.sourceLabel ? '\n出处：' + c.sourceLabel : '') });
    if (c.due === day && minute >= 9 * 60) add({ id: `commit:${c.source}:${c.due}:day`, kind: 'commitment-due', title: '今天到期：' + D.short(c.text, 40), text: c.text + (c.sourceLabel ? '\n出处：' + c.sourceLabel : '') });
  }
  // 4. 等你回复太久（上班时间里才提醒）
  const waitMs = (Number(settings.waitHours) || 4) * 3600000;
  if (minute >= 9 * 60 && minute < 20 * 60) {
    for (const m of D.awaiting(snapshot, settings)) {
      if (now - m.since < waitMs) continue;
      add({ id: `await:${m.conv}:${m.key}`, kind: 'awaiting-reply', title: `${D.short(m.sender, 12)} 等你回复 ${Math.round((now - m.since) / 3600000)} 小时`,
        text: `${m.group ? '群「' + m.convName + '」' : '单聊'} ${D.clock(m.since)}：${D.short(m.text, 120)}`, detail: { source: m.sourceId } });
    }
  }
  // 5. 关注词：别人新说的话里出现关注词（keywordSince 之前的旧消息不算）
  const words = (settings.keywords || []).map(w => String(w).trim()).filter(Boolean);
  if (words.length) {
    const since = Number(settings.keywordSince) || 0;
    for (const list of Object.values(snapshot.messages || {})) for (const m of list) {
      if (m.mine || !m.at || m.at <= since) continue;
      const hit = words.find(w => m.text.includes(w));
      if (hit) add({ id: `kw:${m.conv}:${m.key}`, kind: 'keyword', title: `关注词「${D.short(hit, 10)}」：${D.short(m.sender, 10)}${m.group ? ' 在 ' + D.short(m.convName, 12) : ''}`, text: D.short(m.text, 200), detail: { source: m.sourceId } });
    }
  }
  // 6. 下班前小结
  if (minute >= minutesOf(settings.summaryTime || '18:00')) {
    const waiting = D.awaiting(snapshot, settings).length;
    const dueTomorrow = commitments.filter(c => c.due === tomorrow).length;
    const done = meetings.filter(m => (m.end || m.start) <= now).length;
    add({ id: `summary:${day}`, kind: 'day-summary', title: '下班前小结',
      text: [`今天 ${meetings.length} 场会，已开完 ${done} 场。`, waiting ? `还有 ${waiting} 人在等你回复。` : '没有人在等你回复。', dueTomorrow ? `明天到期 ${dueTomorrow} 件答应过的事。` : '', '想要详细版就在助理页问「今天做了什么、明天要准备什么」。'].filter(Boolean).join('\n') });
  }
  return out.sort((a, b) => PRIORITY[a.kind] - PRIORITY[b.kind]);
}

// 每小时最多 max 条：sentAt 是已发提醒的时间。返回这一轮还能发几条。
function quota(sentAt, now, max = 3) { return Math.max(0, max - sentAt.filter(t => now - t < 3600000).length); }

module.exports = { dueNotices, overbooked, quota, minutesOf, isWorkday };
