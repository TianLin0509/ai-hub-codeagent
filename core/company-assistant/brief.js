'use strict';
// 每日简报（2026-10-16 定：简报是关键功能，要做对）。
// 流程：Hub 先用 welink-cli 取原始数据、给每条编出处 → 先出一份按规则排的清单（立刻能看）→
// 再请助理会话里的 CodeAgent 读同一份数据，挑重点写成五栏 → Hub 逐条核对出处，找不到出处的删掉并注明。
// 首屏最多 10 条；空栏不显示；点过「处理了」的条目第二天不再出现。
// 2026-10-18 改：消息取的是回看时间内全部会话（可能上千条）。交给 AI 的提问里只直接写重要的那部分
// （单聊、@ 我的、我说过话的、提到关注词的群消息，再按新近补满预算），全部消息另存成 data/brief-input-<日期>.md 让它需要时去读。
// 「关注群要点」改成「群里和你相关」：不用手动勾群，按 @ 你、关注词、你参与讨论自动挑。
const D = require('./data');

const SECTIONS = Object.freeze([
  { key: 'meetings', title: '今天的会' },
  { key: 'awaiting', title: '等你回复' },
  { key: 'commitments', title: '你答应过的事' },
  { key: 'groups', title: '群里和你相关' },
  { key: 'mail', title: '重要邮件' },
]);
const FIRST_SCREEN = 10;
const INLINE_CHARS = 40000; // 直接写进提问的消息原文上限（提问是贴进 CodeAgent 终端的，太长不稳）
const lookback = settings => Math.max(1, Number(settings?.lookbackHours) || 36);
const when = at => (at ? new Date(at).toLocaleString('zh-CN', { hour12: false }) : '');
const lineOf = (m, full = false) => `[${m.sourceId}] ${m.group ? '群「' + m.convName + '」' : '单聊「' + m.convName + '」'} ${m.mine ? '我' : m.sender}${m.account ? '（账号 ' + m.account + '）' : ''}${m.at ? ' ' + when(m.at) : ''}${m.atMe ? '（@我）' : m.atAll ? '（@所有人）' : ''}：${full ? (m.text || m.preview || '［消息正文为空］') : D.short(m.text || m.preview, 200)}`;

// 按规则排的清单：AI 不可用或还没整理完时先给这个。
function fallbackBrief(snapshot, { day, now = Date.now(), settings = {}, commitments = [], done = new Set() } = {}) {
  const index = D.sourceIndex(snapshot);
  const item = (source, text, extra = {}) => ({ source, text, sourceLabel: index.get(source)?.label || '', ...extra });
  const meetings = D.todaysMeetings(snapshot, day).map(m => item(m.sourceId, `${D.clock(m.start)}${m.end ? '–' + D.clock(m.end) : ''} ${m.subject}${m.location ? ' · ' + m.location : ''}`));
  const awaiting = D.awaiting(snapshot, settings).map(m => item(m.sourceId, `${m.sender}${m.group ? '（' + m.convName + '）' : ''}等你回复 ${Math.max(1, Math.round((now - m.since) / 3600000))} 小时：${D.short(m.text, 30)}`));
  const hours = lookback(settings), since = now - hours * 3600000;
  const groups = D.relatedGroups(snapshot, { keywords: settings.keywords, since }).map(r => {
    const why = [r.atMe ? `@你 ${r.atMe} 次` : '', r.keyword ? `提到关注词 ${r.keyword} 次` : '', r.mine ? '你参与了讨论' : ''].filter(Boolean).join('，');
    return item(r.key.sourceId, `${r.conv.name}：${hours} 小时内 ${r.count} 条，${why}；${r.key.mine ? '你' : r.key.sender}「${D.short(r.key.text, 24)}」`);
  });
  const mail = [...(snapshot.mails || [])].sort((a, b) => Number(b.important) - Number(a.important) || (b.at || 0) - (a.at || 0)).slice(0, 5)
    .map(m => item(m.sourceId, `${m.from ? m.from + '：' : ''}${m.subject}`));
  const commits = commitments.filter(c => !c.due || c.due >= day).map(c => ({ ...c }));
  return finish({ day, generatedAt: now, by: 'list', sections: { meetings, awaiting, commitments: commits, groups, mail }, dropped: 0, done });
}

// 给 CodeAgent 的整理请求：原始数据逐条带出处编号；要求只输出 JSON。
function briefPrompt(snapshot, { day, now = Date.now(), settings = {}, commitments = [] } = {}) {
  const lines = [];
  for (const m of D.todaysMeetings(snapshot, day)) lines.push(`[${m.sourceId}] 会议 ${D.clock(m.start)}${m.end ? '-' + D.clock(m.end) : ''} ${m.subject}${m.location ? ' 地点 ' + m.location : ''}${m.attendees ? ' 参会 ' + m.attendees + ' 人' : ''}${m.hasFiles ? ' 有材料' : ''}`);
  const picked = inlineMessages(snapshot, { now, settings: { ...settings, day } });
  lines.push(...picked.lines);
  for (const m of snapshot.mails || []) lines.push(`[${m.sourceId}] 未读邮件 ${m.from}：${m.subject}${m.important ? '（标了重要）' : ''}${m.preview ? ' —— ' + D.short(m.preview, 120) : ''}`);
  const carry = commitments.filter(c => !c.due || c.due >= day).map(c => `- ${c.text}（截止 ${c.due || '未定'}，出处 ${c.source}）`);
  return [
    `请帮我整理今天（${day}）的工作简报。下面是从我的 WeLink 里取到的原始数据（最近 ${lookback(settings)} 小时），每条前面方括号里是出处编号。`,
    picked.omitted ? `下面列出了单聊、@我的、@所有人的、我说过话的和提到关注词的群消息，以及最新的一部分群消息；另有 ${picked.omitted} 条群消息没有列出，全部消息（同样带出处编号）在当前目录 ${picked.file}，判断群里有没有和我相关的事时可以去读。` : '',
    `下面的消息是最多 200 字的预览；完整原文保存在当前目录 ${picked.file}，长消息的结论需读全文核对。非文字消息的原始内容在 data/today.json。`,
    snapshot.errors?.length ? `有 ${snapshot.errors.length} 项查询失败或不完整：${snapshot.errors.map(e => e.label + '：' + e.text).join('；')}。没取到不等于没有，请在简报中说明影响。` : '',
    '',
    '要求：',
    '1. 只根据下面的数据写，不编造；每条必须带且只带一个出处编号（原样抄方括号里的编号）。',
    '2. 分五栏：meetings 今天的会（时间、主题，会前要准备什么）；awaiting 等我回复的人和事；commitments 我在消息里答应过、还没做完的事（写 due 截止日期 YYYY-MM-DD，推不出就留空）；groups 群里和我相关的要点（@我的、要我拿主意或跟进的、和我手上工作有关的）；mail 需要我处理的邮件。',
    '3. 每条一句话，40 字以内，先写最要紧的。五栏合计最多 10 条，没有内容的栏给空数组。是你推断出来、原文没明说的，加 "guess": true。',
    `4. 只输出一个 JSON 代码块，格式：{"meetings":[{"text":"…","source":"…"}],"awaiting":[],"commitments":[{"text":"…","source":"…","due":"${day}"}],"groups":[],"mail":[]}`,
    '',
    carry.length ? '之前记下的、还没到期的承诺（仍未完成就保留，出处照抄）：\n' + carry.join('\n') + '\n' : '',
    '原始数据：',
    lines.length ? lines.join('\n') : '（今天没有取到会议、消息和邮件）',
  ].join('\n');
}

// 挑出直接写进提问的消息：先放必看的（单聊、@我、我说的、提到关注词的），再按新近补满预算；按会话、时间排好。
function inlineMessages(snapshot, { now = Date.now(), settings = {} } = {}) {
  const since = now - lookback(settings) * 3600000, words = (settings.keywords || []).map(w => String(w).trim()).filter(Boolean);
  const all = Object.values(snapshot.messages || {}).flat().filter(m => !m.at || m.at >= since || m.mine);
  const must = m => !m.group || m.mine || m.atMe || m.atAll || words.some(w => m.text.includes(w));
  const chosen = new Set();
  let used = 0;
  const take = m => { const n = lineOf(m).length + 1; if (used + n > INLINE_CHARS && chosen.size) return false; chosen.add(m); used += n; return true; };
  for (const m of all.filter(must).sort((a, b) => (b.at || 0) - (a.at || 0))) if (!take(m)) break;
  for (const m of all.filter(m => !must(m)).sort((a, b) => (b.at || 0) - (a.at || 0))) if (!take(m)) break;
  const order = new Map(Object.keys(snapshot.messages || {}).map((id, i) => [id, i]));
  const lines = [...chosen].sort((a, b) => (order.get(a.conv) - order.get(b.conv)) || (a.at || 0) - (b.at || 0)).map(m => lineOf(m));
  return { lines, omitted: all.length - chosen.size, total: all.length, file: inputFileName(settings.day) };
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
    parts.push(`## ${c.group ? '群' : '单聊'}「${c.name || id}」（${rows.length} 条）`, ...rows.map(m => lineOf(m, true) + (!m.text && m.content ? '\n原始内容：' + (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)) : '')), '');
  }
  return parts.join('\n');
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

module.exports = { SECTIONS, FIRST_SCREEN, INLINE_CHARS, fallbackBrief, briefPrompt, briefInputFile, inlineMessages, inputFileName, parseAgentBrief, mergeCommitments };
