'use strict';
// 每日简报（2026-10-16 定：简报是关键功能，要做对）。
// 流程：Hub 先用 welink-cli 取原始数据、给每条编出处 → 先出一份按规则排的清单（立刻能看）→
// 再请助理会话里的 CodeAgent 读同一份数据，挑重点写成五栏 → Hub 逐条核对出处，找不到出处的删掉并注明。
// 首屏最多 10 条；空栏不显示；点过「处理了」的条目第二天不再出现。
// 2026-10-18 改：消息取的是回看时间内全部会话（可能上千条）。交给 AI 的提问里只直接写重要的那部分
// （私聊、@ 我的、我说过话的、提到关注词的群消息，再按新近补满预算），完整消息按工具分页或出处读取。
// 「关注群要点」改成「群里和你相关」：不用手动勾群，按 @ 你、关注词、你参与讨论自动挑。
const D = require('./data');
const { createPriorityMatcher, prioritize } = require('./memory-priority');

const SECTIONS = Object.freeze([
  { key: 'meetings', title: '今天的会' },
  { key: 'awaiting', title: '等你回复' },
  { key: 'commitments', title: '你答应过的事' },
  { key: 'groups', title: '群里和你相关' },
  { key: 'mail', title: '重要邮件' },
]);
const FIRST_SCREEN = 10;
const INLINE_CHARS = 4200; // 首次只给紧凑预览，完整范围与原文通过查询工具按需读取。
const lookback = settings => Math.max(1, Number(settings?.lookbackHours) || 36);
const when = at => D.displayTime(at);
const lineOf = (m, full = false) => `[${m.sourceId}] ${m.group ? '群「' + m.convName + '」' : '私聊「' + m.convName + '」'} ${m.mine ? '我' : m.sender}${m.account ? '（账号 ' + m.account + '）' : ''} ${when(m.at)}${m.atMe ? '（@我）' : m.atAll ? '（@所有人）' : ''}：${full ? (m.text || m.preview || '［消息正文为空］') : D.short(m.text || m.preview, 200)}`;
const meetingRows = (snapshot, day) => [...D.todaysMeetings(snapshot, day), ...D.unresolvedMeetings(snapshot)];
function meetingText(m) {
  if (m.displayRange) return `${m.displayRange} ${m.subject}${m.location ? ' · ' + m.location : ''}`;
  const start = Number.isFinite(m.start) ? D.displayTime(m.start) : '日期/时间待核对';
  const end = Number.isFinite(m.end) ? (D.dayKey(m.start) === D.dayKey(m.end) ? D.clock(m.end) : D.displayTime(m.end)) : m.timeEvidence?.end && m.timeEvidence.end.status !== 'missing' ? '结束时间待核对' : '';
  return `${start}${end ? ' – ' + end : ''} ${m.subject}${m.location ? ' · ' + m.location : ''}`;
}
function budgetLines(lines, budget) {
  const kept = []; let used = 0;
  for (const line of lines) { if (used + line.length + 1 > budget) continue; kept.push(line); used += line.length + 1; }
  return { lines: kept, omitted: lines.length - kept.length };
}

// 按规则排的清单：AI 不可用或还没整理完时先给这个。
function fallbackBrief(snapshot, { day, now = Date.now(), settings = {}, commitments = [], done = new Set(), memory = [] } = {}) {
  const index = D.sourceIndex(snapshot);
  const item = (source, text, extra = {}) => ({ source, text, sourceLabel: index.get(source)?.label || '', ...extra });
  const meetings = meetingRows(snapshot, day).map(m => item(m.sourceId, meetingText(m), { timeStatus: m.timeStatus || (Number.isFinite(m.start) ? 'known' : 'unknown') }));
  const awaiting = D.awaiting(snapshot, settings).map(m => {
    const elapsed = Number.isFinite(m.since) ? `已过 ${Math.max(1, Math.round((now - m.since) / 3600000))} 小时` : '时间待核对';
    return item(m.sourceId, `${m.sender}${m.group ? '（' + m.convName + '）@你，处理情况待核对' : '发来的私聊待回复'}，${elapsed}：${D.short(m.text, 30)}`, { ...(m.needsReplyReview ? { needsReplyReview: true } : {}) });
  });
  const hours = lookback(settings), since = now - hours * 3600000;
  const allMentions = Object.values(snapshot.messages || {}).flat().filter(m => m.group && !m.mine && m.atAll && (!Number.isFinite(m.at) || m.at >= since));
  const groups = allMentions.map(m => item(m.sourceId, `${m.convName}：${m.sender} @所有人，${when(m.at)}：${D.short(m.text, 60)}`, { mandatory: true }));
  groups.push(...D.relatedGroups(snapshot, { keywords: settings.keywords, since }).map(r => {
    const why = [r.atMe ? `@你 ${r.atMe} 次` : '', r.keyword ? `提到关注词 ${r.keyword} 次` : '', r.mine ? '你参与了讨论' : ''].filter(Boolean).join('，');
    return item(r.key.sourceId, `${r.conv.name}：${hours} 小时内 ${r.count} 条，${why}；${r.key.mine ? '你' : r.key.sender}「${D.short(r.key.text, 24)}」`);
  }));
  const mail = prioritize([...(snapshot.mails || [])].sort((a, b) => Number(b.important) - Number(a.important) || (b.at || 0) - (a.at || 0)), memory).slice(0, 5)
    .map(m => item(m.sourceId, `${m.from ? m.from + '：' : ''}${m.subject}`));
  const commits = commitments.filter(c => !c.due || c.due >= day).map(c => ({ ...c }));
  return finish({ day, generatedAt: now, by: 'list', sections: prioritizedSections({ meetings, awaiting, commitments: commits, groups, mail }, index, memory), dropped: 0, done });
}

// 给 CodeAgent 的整理请求：原始数据逐条带出处编号；要求只输出 JSON。
function briefPrompt(snapshot, { day, now = Date.now(), settings = {}, commitments = [], memory = [] } = {}) {
  const meetings = budgetLines(meetingRows(snapshot, day).map(m => `[${m.sourceId}] 会议 ${meetingText(m)}${m.attendees ? ' 参会 ' + m.attendees + ' 人' : ''}${m.hasFiles ? ' 有材料' : ''}`), 1500);
  const picked = inlineMessages(snapshot, { now, settings: { ...settings, day }, memory });
  const mails = budgetLines(prioritize(snapshot.mails || [], memory).map(m => `[${m.sourceId}] 未读邮件 ${m.from}：${m.subject}${m.important ? '（标了重要）' : ''}${m.preview ? ' —— ' + D.short(m.preview, 120) : ''}`), 1000);
  const carry = budgetLines(commitments.filter(c => !c.due || c.due >= day).map(c => `- ${c.text}（截止 ${c.due || '未定'}，出处 ${c.source}）`), 600);
  const lines = [...meetings.lines, ...picked.lines, ...mails.lines];
  return [
    `请整理今天（${day}，上海时间）的工作简报。这是已采集范围内最近 ${lookback(settings)} 小时的紧凑预览，方括号内是出处。`,
    `消息共 ${picked.total} 条，预览 ${picked.lines.length} 条；省略私聊 ${picked.omittedPrivate} 条、群消息 ${picked.omittedGroups} 条。会议省略 ${meetings.omitted} 条，邮件省略 ${mails.omitted} 条，历史承诺省略 ${carry.omitted} 条。预览不是完整清单。`,
    `按需读取：welink_inbox({hours:${lookback(settings)},scope:["私聊","@我","@所有人"]})；用返回的 nextCursor 续页，保留 queryId，关注 coverage。welink_message({ids:["出处编号"],queryId:"查询编号"}) 读取全文和邻近消息。welink_meetings({date:"${day}"}) 查询会议，时间直接抄工具 display。`,
    `消息预览最多 200 字；需要据长消息作判断时先读全文。工具暂不可用时可按出处读取原文文件 ${picked.file}。`,
    snapshot.errors?.length ? `查询有 ${snapshot.errors.length} 项失败或不完整：${D.short(snapshot.errors.map(e => e.label + '：' + e.text).join('；'), 400)}。只说明已获取的范围。` : '',
    '',
    '要求：',
    '1. 只根据下面的数据写，不编造；每条必须带且只带一个出处编号（原样抄方括号里的编号）。',
    '2. meetings 只写 preparation 会前准备建议，时间和主题由 Hub 从结构化事实显示；awaiting 私聊待回与@我（群里回复关联不明时标待核对）；commitments 我答应过但未完成的事（due 为明确的截止日期，否则留空）；groups 群里与我相关的要点；mail 需要处理的邮件。',
    '3. 建议每条 40 字以内，重点优先，推断加 "guess": true。首屏最多显示 10 条，Hub 会补齐已采集的会议和待回/@清单；空栏给空数组。',
    `4. 只输出 JSON 代码块：{"meetings":[{"source":"…","preparation":"…"}],"awaiting":[],"commitments":[{"text":"…","source":"…","due":"${day}"}],"groups":[],"mail":[]}`,
    '',
    carry.lines.length ? '未到期承诺预览（仍未完成就保留，出处照抄）：\n' + carry.lines.join('\n') + '\n' : '',
    '原始数据：',
    lines.length ? lines.join('\n') : '（本次预览没有条目；实际获取范围及完整条目以查询工具为准）',
  ].join('\n');
}

// 挑出直接写进提问的消息：先放私聊、@我、我说的、提到关注词的，再按新近补满预算；不把预览宣称为全部私聊。
function inlineMessages(snapshot, { now = Date.now(), settings = {}, memory = [] } = {}) {
  const since = now - lookback(settings) * 3600000, words = (settings.keywords || []).map(w => String(w).trim()).filter(Boolean);
  const all = Object.values(snapshot.messages || {}).flat().filter(m => !m.at || m.at >= since || m.mine);
  const priority = createPriorityMatcher(memory);
  const must = m => priority(m) || !m.group || m.mine || m.atMe || m.atAll || words.some(w => String(m.text || '').includes(w));
  const chosen = new Set();
  let used = 0;
  const take = m => { const n = lineOf(m).length + 1; if (used + n > INLINE_CHARS) return false; chosen.add(m); used += n; return true; };
  for (const m of all.filter(must).sort((a, b) => priority(b) - priority(a) || (b.at || 0) - (a.at || 0))) take(m);
  for (const m of all.filter(m => !must(m)).sort((a, b) => (b.at || 0) - (a.at || 0))) take(m);
  const order = new Map(Object.keys(snapshot.messages || {}).map((id, i) => [id, i]));
  const lines = [...chosen].sort((a, b) => (order.get(a.conv) - order.get(b.conv)) || (a.at || 0) - (b.at || 0)).map(m => lineOf(m));
  const omitted = all.filter(m => !chosen.has(m));
  return { lines, omitted: omitted.length, omittedPrivate: omitted.filter(m => !m.group).length, omittedGroups: omitted.filter(m => m.group).length, total: all.length, file: inputFileName(settings.day) };
}
const inputFileName = day => `data/brief-input${day ? '-' + day : ''}.md`;
// 全部消息的原文（给助理会话按需读）：按会话分节，每条带出处编号。
function briefInputFile(snapshot, { day, now = Date.now(), settings = {} } = {}) {
  const since = now - lookback(settings) * 3600000, convs = new Map((snapshot.conversations || []).map(c => [c.id, c]));
  const parts = [`# ${day} 最近 ${lookback(settings)} 小时的 WeLink 消息（出处编号在方括号里）`, ''];
  for (const [id, list] of Object.entries(snapshot.messages || {})) {
    const rows = list.filter(m => !m.at || m.at >= since || m.mine);
    if (!rows.length) continue;
    const c = convs.get(id) || {};
    parts.push(`## ${c.group ? '群' : '私聊'}「${c.name || id}」（${rows.length} 条）`, ...rows.map(m => lineOf(m, true) + (!m.text && m.content ? '\n原始内容：' + (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)) : '')), '');
  }
  return parts.join('\n');
}

// 读 CodeAgent 的回答：取 JSON，逐条核对出处；出处不在原始数据里的删掉并计数。
function parseAgentBrief(text, snapshot, { day, now = Date.now(), done = new Set(), commitments = [], settings = {}, memory = [] } = {}) {
  const fenced = String(text || '').match(/```(?:json)?\s*([\s\S]*?)```/i);
  const parsed = require('./welink').parseJson(fenced ? fenced[1] : text);
  if (!parsed || typeof parsed !== 'object') return null;
  const index = D.sourceIndex(snapshot);
  for (const c of commitments) if (c.source && !index.has(c.source)) index.set(c.source, { kind: 'commitment', label: c.sourceLabel || '之前记下的承诺' });
  let dropped = 0;
  const sections = {};
  const facts = fallbackBrief(snapshot, { day, now, settings, commitments, done, memory });
  const factsBySection = new Map(facts.sections.map(s => [s.key, s.items]));
  const meetingsBySource = new Map((factsBySection.get('meetings') || []).map(x => [x.source, x]));
  const preparation = new Map();
  for (const { key } of SECTIONS) {
    const list = Array.isArray(parsed[key]) ? parsed[key] : [];
    sections[key] = list.map(x => {
      const source = String(x?.source || '').replace(/^\[|\]$/g, '').trim();
      if (key === 'meetings') {
        const sourceInfo = index.get(source), fact = meetingsBySource.get(source);
        if (!sourceInfo || !['meeting', 'calendar'].includes(sourceInfo.kind) || (!fact && !done.has(source))) { dropped += 1; return null; }
        if (typeof x?.preparation === 'string' && x.preparation.trim()) preparation.set(source, D.short(x.preparation, 160));
        return null; // 时间与主题只取事实；旧版本 AI 的 text 也不会覆盖会议。
      }
      const textOk = typeof x?.text === 'string' && x.text.trim();
      if (!textOk || !index.has(source)) { dropped += 1; return null; }
      const due = key === 'commitments' && /^\d{4}-\d\d-\d\d$/.test(String(x.due || '')) ? x.due : undefined;
      return { source, text: D.short(x.text, 80), sourceLabel: index.get(source).label, ...(due ? { due } : {}), ...(x.guess === true ? { guess: true } : {}) };
    }).filter(Boolean);
  }
  sections.meetings = [...meetingsBySource.values()].map(m => ({ ...m, ...(preparation.has(m.source) ? { preparation: preparation.get(m.source) } : {}) }));
  // 确定性必备项不依赖 AI 是否挑中；事实放前，finish 去重并保留用户的「处理了」。
  sections.awaiting = [...(factsBySection.get('awaiting') || []), ...sections.awaiting];
  sections.groups = [...(factsBySection.get('groups') || []).filter(x => x.mandatory), ...sections.groups];
  sections.commitments = [...sections.commitments, ...(factsBySection.get('commitments') || [])];
  return finish({ day, generatedAt: now, by: 'ai', sections: prioritizedSections(sections, index, memory), dropped, done });
}

function prioritizedSections(sections, index, memory) {
  return Object.fromEntries(Object.entries(sections).map(([key, items]) => [key, key === 'meetings' ? items : prioritize(items, memory, x => index.get(x.source)?.item)]));
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
  const cutoff = D.dayKey(new Date(`${day}T12:00:00+08:00`).getTime() - 2 * 86400000);
  return [...map.values()].filter(c => !c.due || c.due >= cutoff);
}

module.exports = { SECTIONS, FIRST_SCREEN, INLINE_CHARS, fallbackBrief, briefPrompt, briefInputFile, inlineMessages, inputFileName, parseAgentBrief, mergeCommitments };
