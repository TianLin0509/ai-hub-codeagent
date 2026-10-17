'use strict';
// 每日简报（2026-10-16 定：简报是关键功能，要做对）。
// 流程：Hub 先用 welink-cli 取原始数据、给每条编出处 → 先出一份按规则排的清单（立刻能看）→
// 再请助理会话里的 CodeAgent 读同一份数据，挑重点写成五栏 → Hub 逐条核对出处，找不到出处的删掉并注明。
// 首屏最多 10 条；空栏不显示；点过「处理了」的条目第二天不再出现。
const D = require('./data');

const SECTIONS = Object.freeze([
  { key: 'meetings', title: '今天的会' },
  { key: 'awaiting', title: '等你回复' },
  { key: 'commitments', title: '你答应过的事' },
  { key: 'groups', title: '关注群要点' },
  { key: 'mail', title: '重要邮件' },
]);
const FIRST_SCREEN = 10;

// 按规则排的清单：AI 不可用或还没整理完时先给这个。
function fallbackBrief(snapshot, { day, now = Date.now(), settings = {}, commitments = [], done = new Set() } = {}) {
  const index = D.sourceIndex(snapshot);
  const item = (source, text, extra = {}) => ({ source, text, sourceLabel: index.get(source)?.label || '', ...extra });
  const meetings = D.todaysMeetings(snapshot, day).map(m => item(m.sourceId, `${D.clock(m.start)}${m.end ? '–' + D.clock(m.end) : ''} ${m.subject}${m.location ? ' · ' + m.location : ''}`));
  const awaiting = D.awaiting(snapshot, settings).map(m => item(m.sourceId, `${m.sender}${m.group ? '（' + m.convName + '）' : ''}等你回复 ${Math.max(1, Math.round((now - m.since) / 3600000))} 小时：${D.short(m.text, 30)}`));
  const watched = new Set((settings.watchGroups || []).map(g => String(g.id)));
  const groups = (snapshot.conversations || []).filter(c => watched.has(c.id)).map(c => {
    const today = ((snapshot.messages || {})[c.id] || []).filter(m => m.at && D.dayKey(m.at) === day);
    return today.length ? item(today[today.length - 1].sourceId, `${c.name}：今天 ${today.length} 条消息，最新是 ${today[today.length - 1].sender}「${D.short(today[today.length - 1].text, 24)}」`) : null;
  }).filter(Boolean);
  const mail = [...(snapshot.mails || [])].sort((a, b) => Number(b.important) - Number(a.important) || (b.at || 0) - (a.at || 0)).slice(0, 5)
    .map(m => item(m.sourceId, `${m.from ? m.from + '：' : ''}${m.subject}`));
  const commits = commitments.filter(c => !c.due || c.due >= day).map(c => ({ ...c }));
  return finish({ day, generatedAt: now, by: 'list', sections: { meetings, awaiting, commitments: commits, groups, mail }, dropped: 0, done });
}

// 给 CodeAgent 的整理请求：原始数据逐条带出处编号；要求只输出 JSON。
function briefPrompt(snapshot, { day, now = Date.now(), settings = {}, commitments = [] } = {}) {
  const lines = [];
  for (const m of D.todaysMeetings(snapshot, day)) lines.push(`[${m.sourceId}] 会议 ${D.clock(m.start)}${m.end ? '-' + D.clock(m.end) : ''} ${m.subject}${m.location ? ' 地点 ' + m.location : ''}${m.attendees ? ' 参会 ' + m.attendees + ' 人' : ''}${m.hasFiles ? ' 有材料' : ''}`);
  const since = now - 36 * 3600000;
  for (const list of Object.values(snapshot.messages || {})) {
    for (const m of list) {
      if (m.at && m.at < since && !m.mine) continue;
      lines.push(`[${m.sourceId}] ${m.group ? '群「' + m.convName + '」' : '单聊「' + m.convName + '」'} ${m.mine ? '我' : m.sender}${m.at ? ' ' + new Date(m.at).toLocaleString('zh-CN', { hour12: false }) : ''}：${D.short(m.text, 200)}`);
    }
  }
  for (const m of snapshot.mails || []) lines.push(`[${m.sourceId}] 未读邮件 ${m.from}：${m.subject}${m.important ? '（标了重要）' : ''}${m.preview ? ' —— ' + D.short(m.preview, 120) : ''}`);
  const carry = commitments.filter(c => !c.due || c.due >= day).map(c => `- ${c.text}（截止 ${c.due || '未定'}，出处 ${c.source}）`);
  return [
    `请帮我整理今天（${day}）的工作简报。下面是从我的 WeLink 里取到的原始数据，每条前面方括号里是出处编号。`,
    '',
    '要求：',
    '1. 只根据下面的数据写，不编造；每条必须带且只带一个出处编号（原样抄方括号里的编号）。',
    '2. 分五栏：meetings 今天的会（时间、主题，会前要准备什么）；awaiting 等我回复的人和事；commitments 我在消息里答应过、还没做完的事（写 due 截止日期 YYYY-MM-DD，推不出就留空）；groups 关注群里和我相关的要点；mail 需要我处理的邮件。',
    '3. 每条一句话，40 字以内，先写最要紧的。五栏合计最多 10 条，没有内容的栏给空数组。是你推断出来、原文没明说的，加 "guess": true。',
    `4. 只输出一个 JSON 代码块，格式：{"meetings":[{"text":"…","source":"…"}],"awaiting":[],"commitments":[{"text":"…","source":"…","due":"${day}"}],"groups":[],"mail":[]}`,
    '',
    carry.length ? '之前记下的、还没到期的承诺（仍未完成就保留，出处照抄）：\n' + carry.join('\n') + '\n' : '',
    '原始数据：',
    lines.length ? lines.join('\n') : '（今天没有取到会议、消息和邮件）',
  ].join('\n');
}

// 读 CodeAgent 的回答：取 JSON，逐条核对出处；出处不在原始数据里的删掉并计数。
function parseAgentBrief(text, snapshot, { day, now = Date.now(), done = new Set(), commitments = [] } = {}) {
  const fenced = String(text || '').match(/```(?:json)?\s*([\s\S]*?)```/i);
  const parsed = require('./welink').parseJson(fenced ? fenced[1] : text);
  if (!parsed || typeof parsed !== 'object') return null;
  const index = D.sourceIndex(snapshot);
  for (const c of commitments) if (c.source && !index.has(c.source)) index.set(c.source, { kind: 'commitment', label: c.sourceLabel || '之前记下的承诺' });
  let dropped = 0;
  const sections = {};
  for (const { key } of SECTIONS) {
    const list = Array.isArray(parsed[key]) ? parsed[key] : [];
    sections[key] = list.map(x => {
      const source = String(x?.source || '').replace(/^\[|\]$/g, '').trim();
      const textOk = typeof x?.text === 'string' && x.text.trim();
      if (!textOk || !index.has(source)) { dropped += 1; return null; }
      const due = key === 'commitments' && /^\d{4}-\d\d-\d\d$/.test(String(x.due || '')) ? x.due : undefined;
      return { source, text: D.short(x.text, 80), sourceLabel: index.get(source).label, ...(due ? { due } : {}), ...(x.guess === true ? { guess: true } : {}) };
    }).filter(Boolean);
  }
  return finish({ day, generatedAt: now, by: 'ai', sections, dropped, done });
}

// 去掉点过「处理了」的；同一出处只留一条；标出首屏（前 10 条）。
function finish({ day, generatedAt, by, sections, dropped, done }) {
  const seen = new Set();
  let shown = 0;
  const out = SECTIONS.map(({ key, title }) => {
    const items = [];
    for (const x of sections[key] || []) {
      const id = key + '|' + (x && x.source);
      if (!x || done.has(x.source) || seen.has(id)) continue;
      seen.add(id);
      items.push({ ...x, id, top: shown++ < FIRST_SCREEN });
    }
    return { key, title, items };
  }).filter(s => s.items.length);
  return { day, generatedAt, by, sections: out, dropped, total: shown };
}

// 简报里新出现的承诺并入长期清单（按出处去重，过期两天后清掉）。
function mergeCommitments(previous, brief, day) {
  const map = new Map((previous || []).map(c => [c.source, c]));
  for (const s of brief?.sections || []) if (s.key === 'commitments') for (const c of s.items) map.set(c.source, { source: c.source, text: c.text, due: c.due || null, sourceLabel: c.sourceLabel, addedAt: map.get(c.source)?.addedAt || brief.generatedAt });
  const cutoff = D.dayKey(new Date(`${day}T12:00:00`).getTime() - 2 * 86400000);
  return [...map.values()].filter(c => !c.due || c.due >= cutoff);
}

module.exports = { SECTIONS, FIRST_SCREEN, fallbackBrief, briefPrompt, parseAgentBrief, mergeCommitments };
