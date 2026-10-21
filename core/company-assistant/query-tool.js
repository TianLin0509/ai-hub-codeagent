'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const D = require('./data');
const { createPriorityMatcher, prioritize } = require('./memory-priority');
const HOUR = 3600000;
const TTL = HOUR;
function queryRange(args, now) {
  const period = args.period || (args.kind === 'meetings' ? 'today' : 'last24h');
  const day = D.dayKey(now), midnight = Date.parse(day + 'T00:00:00+08:00');
  let start, end;
  if (period === 'today') { start = midnight; end = midnight + 24 * HOUR; }
  else if (period === 'yesterday') { start = midnight - 24 * HOUR; end = midnight; }
  else if (period === 'last24h') { start = now - 24 * HOUR; end = now; }
  else if (period === 'custom') {
    const parse = x => typeof x === 'string' && /(?:Z|[+-]\d\d:\d\d)$/.test(x) ? D.timeValue(x).at : NaN;
    start = parse(args.start); end = parse(args.end);
  } else throw new Error('period 只能是 today/last24h/yesterday/custom');
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || end - start > 7 * 24 * HOUR) throw new Error('查询范围必须带时区、起点早于终点，单次最多 7 天');
  return { start, end, timeZone: 'Asia/Shanghai', startDisplay: D.displayTime(start), endDisplay: D.displayTime(end), endExclusive: true, period };
}
class AssistantQuery {
  constructor(assistant) { this.a = assistant; this.dir = path.join(assistant.dir, 'queries'); this.pending = null; this.activeTask = null; this.taskCoverage = new Map(); }
  beginTask(id) { this.activeTask = id; this.taskCoverage.clear(); }
  captureCoverage(queryId, lines) {
    if (this.activeTask && this.a.job?.id === this.activeTask) this.taskCoverage.set(queryId, lines);
  }
  finishAnswer(id, text = '') {
    if (this.activeTask !== id) return { text, coverage: [] };
    const coverage = [...this.taskCoverage.values()].flat();
    this.activeTask = null; this.taskCoverage.clear();
    // This prefix is produced from actual collection results, shared by desktop
    // and phone replies. Scope remains visible even if a model omits it.
    return { text: coverage.length ? ['> **Hub 核实的查询范围**', ...coverage.map(line => '> ' + line), '', text].join('\n') : text, coverage };
  }
  file(id) { if (!/^[a-f0-9-]{36}$/.test(String(id))) throw new Error('查询编号无效'); return path.join(this.dir, id + '.json'); }
  owner() { return this.a.auth ? this.a.auth.status()?.login?.uid || null : this.a.snapshot()?.login?.uid || null; }
  ownSnapshot() {
    const snap = this.a.snapshot();
    if (!snap?.login?.uid || snap.login.uid !== this.owner()) throw new Error('快照登录身份与当前账号不一致，请先重新查询');
    return snap;
  }
  load(id) {
    let data; try { data = JSON.parse(fs.readFileSync(this.file(id), 'utf8')); } catch { throw new Error('查询记录不存在，请重新查询'); }
    if (data.expiresAt <= this.a.now()) throw new Error('查询分页已过期，请重新查询以取得一致的数据');
    const owner = this.owner();
    if (!data.owner || !owner || owner !== data.owner) throw new Error('WeLink 登录身份已改变或尚未核实，请重新查询');
    return data;
  }
  save(data) {
    fs.mkdirSync(this.dir, { recursive: true });
    fs.writeFileSync(this.file(data.id), JSON.stringify(data), 'utf8');
    for (const name of fs.readdirSync(this.dir)) {
      if (!/^[a-f0-9-]{36}\.json$/.test(name)) continue;
      const file = path.join(this.dir, name);
      try { if (fs.statSync(file).mtimeMs < Date.now() - TTL) fs.unlinkSync(file); } catch { /* 不影响查询 */ }
    }
  }
  page(data, offset, limit) {
    const items = data.items.slice(offset, offset + limit).map(row => {
      if (data.kind !== 'messages') return row;
      const { content, text, ...small } = row;
      return { ...small, preview: D.short(text || row.preview, 180), textLength: String(text || '').length, readRequired: String(text || '').length > 180 || !text };
    });
    const next = offset + items.length;
    return { queryId: data.id, kind: data.kind, scope: data.scope, range: data.range, capturedAt: data.capturedAt,
      coverage: data.coverage, counts: data.counts, total: data.items.length, offset, items,
      nextCursor: next < data.items.length ? `${data.id}:${next}` : null,
      note: 'nextCursor 非空须继续翻页；total 是本次已取到的条数，是否查全以 coverage 为准。会议时间照 startDisplay/endDisplay 引用；长消息用 read。' };
  }
  async execute(args = {}) {
    const op = args.op || 'list';
    if (op === 'read') {
      const data = args.queryId ? this.load(args.queryId) : null;
      const row = data ? [...data.items, ...(data.context || [])].find(x => x.sourceId === args.sourceId) : D.sourceIndex(this.ownSnapshot()).get(String(args.sourceId))?.item;
      if (!row) throw new Error('这条出处不存在或不属于这次查询；先 list 后用返回的 queryId/sourceId 读取');
      if (!row.sourceId.startsWith('msg:')) return { item: row, note: '时间来自原始字段的统一换算，不自行换算或重写。' };
      const offset = Math.max(0, Math.floor(Number(args.offset) || 0)), text = String(row.text || (typeof row.content === 'string' ? row.content : JSON.stringify(row.content || '')));
      const { content, ...item } = row;
      return { item: { ...item, text: text.slice(offset, offset + 6000) }, offset, textLength: text.length, nextOffset: offset + 6000 < text.length ? offset + 6000 : null };
    }
    if (op !== 'list') throw new Error('查询操作只能是 list/read');
    const limit = Math.max(1, Math.min(50, Math.floor(Number(args.limit) || 20)));
    if (args.cursor) {
      const m = /^([a-f0-9-]{36}):(\d+)$/.exec(String(args.cursor));
      if (!m) throw new Error('分页游标无效，请原样使用 nextCursor');
      return this.page(this.load(m[1]), Number(m[2]), limit);
    }
    const kind = args.kind || 'messages';
    if (!['messages', 'meetings'].includes(kind)) throw new Error('kind 只能是 messages/meetings');
    const scope = args.scope || 'private_mentions';
    if (!['all', 'private_mentions', 'private', 'mentions'].includes(scope)) throw new Error('scope 无效');
    const range = queryRange({ ...args, kind }, this.a.now());
    // 多次工具调用顺序取数，避免同一个 CLI/缓存出现并发写入。
    const previous = this.pending, initialOwner = this.owner();
    const work = (async () => { if (previous) await previous.catch(() => {}); return this.a.collectQuery(kind, range); })();
    this.pending = work;
    let snap; try { snap = await work; } finally { if (this.pending === work) this.pending = null; }
    if (snap.login?.ok && (!snap.login.uid || snap.login.uid !== this.owner() || initialOwner && initialOwner !== snap.login.uid))
      throw new Error('取数期间 WeLink 登录身份改变或尚未核实，请重新查询');
    const inRange = at => Number.isFinite(at) && at >= range.start && at < range.end;
    let items, counts, coverage;
    if (kind === 'messages') {
      const all = Object.values(snap.messages || {}).flat().filter(x => inRange(x.at));
      const match = (query, values) => !query || values.some(x => String(x || '').toLowerCase().includes(String(query).toLowerCase()));
      const selected = all.filter(x => scope === 'all' || scope === 'private' && !x.group || scope === 'mentions' && x.group && (x.atMe || x.atAll) || scope === 'private_mentions' && (!x.group || x.atMe || x.atAll))
        .filter(x => !args.categories || !x.group && args.categories.includes('私聊') || x.group && (args.categories.includes('全部群消息') || x.atMe && args.categories.includes('@我') || x.atAll && args.categories.includes('@所有人')))
        .filter(x => match(args.person, [x.sender, x.senderName, x.account, !x.group && x.convName]) && match(args.group, [x.group && x.conv, x.group && x.convName]));
      const memories = this.a.memory?.active() || [], priority = createPriorityMatcher(memories);
      items = prioritize(selected.sort((a, b) => a.at - b.at || a.sourceId.localeCompare(b.sourceId)), memories)
        .map(x => ({ ...x, priority: priority(x), timeDisplay: D.displayTime(x.at) }));
      counts = { all: all.length, private: all.filter(x => !x.group).length, atMe: all.filter(x => x.group && x.atMe).length, atAll: all.filter(x => x.group && x.atAll).length };
      const sc = snap.scope || {}, unknownTime = (sc.conversations || []).reduce((n, c) => n + (c.unknownTime || 0), 0);
      const complete = snap.login?.ok && !sc.partial && !sc.listFull && !sc.limited && !sc.stale && !sc.directoryInvalid && !sc.directoryFallback && !unknownTime;
      coverage = { status: complete ? 'complete' : 'partial', discovery: sc.listFull ? 'recent-list-capped' : sc.stale ? 'failed' : 'available-conversations',
        knownConversations: sc.known || sc.listed || 0, scanned: sc.fetched || 0, unknownTime, partialConversations: sc.partial || 0, directoryInvalid: sc.directoryInvalid || 0,
        limitation: (sc.listFull ? `本轮最近会话返回 ${sc.listed || sc.listCap} 个，可能达到接口上限；已补查历史已知会话，但从未发现的会话无法保证覆盖。` : '')
          + (sc.directoryFallback ? '较大范围查询失败，已退回兼容查询，覆盖仍待核对。' : '')
          + (sc.directoryInvalid ? `${sc.directoryInvalid} 条会话目录记录无法识别，未覆盖对应会话。` : ''),
        details: sc.conversations || [], errors: snap.errors || [] };
    } else {
      const meetings = (snap.meetings || []).filter(x => D.eventInRange(x, range)), calendar = (snap.calendar || []).filter(x => D.eventInRange(x, range));
      items = [...meetings, ...calendar]
        .sort((a, b) => (a.start || Infinity) - (b.start || Infinity));
      const unknownTime = items.filter(D.eventTimeUnknown).length;
      counts = { meetings: meetings.length, calendar: calendar.length, unknownTime };
      coverage = { status: snap.login?.ok && snap.meetingCoverage?.status === 'complete' && snap.calendarCoverage?.status === 'complete' && !unknownTime ? 'complete' : 'partial',
        meeting: snap.meetingCoverage || { status: 'failed' }, calendar: snap.calendarCoverage || { status: 'failed' }, unknownTime, errors: snap.errors || [],
        note: 'WeLink 会议与邮箱日程分别查询；一个源成功不等于另一个源成功。两源记录可能对应同一场会，未证实共享身份前分别保留。日期/时间待核对项不认作确定在此范围内。' };
    }
    const data = { id: randomUUID(), owner: snap.login?.uid || null, capturedAt: this.a.now(), expiresAt: this.a.now() + TTL, kind, scope, range, items, counts, coverage,
      context: kind === 'messages' ? Object.values(snap.messages || {}).flat() : undefined };
    this.save(data);
    return this.page(data, 0, limit);
  }
  localTime(value) {
    const text = String(value || '').trim();
    if (/^\d{4}-\d\d-\d\d(?:[ T]\d\d:\d\d(?::\d\d)?)?$/.test(text)) return text.slice(0, 10) + 'T' + (text.slice(11) || '00:00:00') + '+08:00';
    return text;
  }
  async inbox(args = {}) {
    let scope = 'private_mentions';
    const scopes = Array.isArray(args.scope) ? args.scope : ['私聊', '@我', '@所有人'];
    if (scopes.includes('全部群消息')) scope = 'all';
    else if (!scopes.includes('私聊')) scope = 'mentions';
    else if (!scopes.includes('@我') && !scopes.includes('@所有人')) scope = 'private';
    const now = this.a.now(), hours = Number(args.hours ?? 24);
    if (!Number.isFinite(hours) || hours <= 0 || hours > 168) throw new Error('hours 必须在 0 到 168 之间');
    const end = args.until ? this.localTime(args.until) : new Date(now).toISOString(), endAt = D.timeValue(end).at;
    if (!Number.isFinite(endAt)) throw new Error('查询结束时间无效，请使用实际日期和上海时间');
    const page = await this.execute({ ...args, op: 'list', kind: 'messages', scope, categories: scopes, period: 'custom',
      start: args.since ? this.localTime(args.since) : new Date(endAt - hours * HOUR).toISOString(), end });
    const { coverage: c, range: r } = page;
    const header = `覆盖：${r.startDisplay} 至 ${r.endDisplay}（终点不含，上海时间）；已查 ${c.scanned} 个会话；${c.status === 'complete' ? '可发现会话的消息已翻页覆盖' : '可能不全'}。${c.limitation || ''}${c.partialConversations ? ` ${c.partialConversations} 个会话未取全。` : ''}${c.unknownTime ? ` ${c.unknownTime} 条时间未确认。` : ''}`;
    this.captureCoverage(page.queryId, [header, `本次筛选已取到 ${page.total} 条；私聊 ${page.counts.private} 条，群 @我 ${page.counts.atMe} 条，@所有人 ${page.counts.atAll} 条。`]);
    const priority = row => row.priority ? '★ ' : '';
    const lines = page.items.map(m => `${priority(m)}${m.group ? (m.atMe ? '群 @我' : m.atAll ? '群 @所有人' : '群聊') : '私聊'}「${m.convName}」 ${m.timeDisplay} ${m.sender}：${m.preview} [${m.sourceId}]${m.readRequired ? '（需读全文）' : ''}`);
    this.a.memory?.touch(JSON.stringify({ person: args.person, group: args.group }));
    return { text: [header, `已取到：私聊 ${page.counts.private} 条，群 @我 ${page.counts.atMe} 条、@所有人 ${page.counts.atAll} 条；本次筛选共 ${page.total} 条，本页 ${page.items.length} 条。`, ...lines, ...c.errors.map(e => `取数问题：${e.label} ${e.text}`)].join('\n'),
      queryId: page.queryId, nextCursor: page.nextCursor, total: page.total, note: page.note };
  }
  async meetings(args = {}) {
    const date = args.date || '今天', today = D.dayKey(this.a.now());
    const day = date === '今天' ? today : date === '明天' ? D.dayKey(Date.parse(today + 'T00:00:00+08:00') + 24 * HOUR) : date;
    const start = this.localTime(args.from || day), startMs = D.timeValue(start).at;
    if (!Number.isFinite(startMs)) throw new Error('会议查询日期无效，请使用今天、明天或实际 YYYY-MM-DD 日期');
    const end = args.to ? this.localTime(args.to) : new Date(startMs + 24 * HOUR).toISOString();
    const page = await this.execute({ ...args, op: 'list', kind: 'meetings', period: 'custom', start, end });
    const c = page.coverage;
    const sourceStatus = (label, value) => `${label}：${value.status === 'complete' ? '已完成当前条件下的查询' : '未取全'}${value.reasonLabel ? '（' + value.reasonLabel + '）' : ''}${value.queryType ? `；查询类型=${value.queryType}` : ''}`;
    const queryTypes = c.meeting.queryTypes || String(c.meeting.queryType || '').split(',').filter(Boolean);
    const category = type => ({ '1': '待参加', '2': '已结束' })[type] || `类型 ${type}`;
    const meetingSource = m => {
      const types = m.queryTypes || queryTypes;
      return types.length ? `WeLink ${types.map(category).join('及')}会议` : 'WeLink 会议';
    };
    const lines = page.items.map(m => `${m.displayRange || m.display || `${m.startDisplay || '时间待核对'} – ${m.endDisplay || '结束时间待核对'}`} · ${m.subject} · ${m.location || '地点未提供'} · ${m.sourceId.startsWith('cal:') ? 'Exchange 日程' : meetingSource(m)} [${m.sourceId}]`);
    const summary = [`覆盖：${page.range.startDisplay} 至 ${page.range.endDisplay}（上海时间）；${sourceStatus('WeLink 会议', c.meeting)}；${sourceStatus('Exchange 日程', c.calendar)}。`,
      `范围说明：WeLink 当前${queryTypes.length ? '只查询' + queryTypes.map(category).join('及') + '会议（类型 ' + queryTypes.join('、') + '）' : '查询类型未确认'}，其他会议类型未纳入本次查询；下列数量仅代表本次查询已取到的记录。`,
      `在本次查询范围内找到 ${page.total} 条记录：WeLink ${page.counts.meetings} 条、Exchange ${page.counts.calendar} 条${c.unknownTime ? `，其中 ${c.unknownTime} 条时间待核对` : ''}。两源可能记录同一场会，尚无共享身份依据，分别保留。`];
    this.captureCoverage(page.queryId, summary);
    return { text: [...summary, ...lines, ...c.errors.map(e => `取数问题：${e.label} ${e.text}`)].join('\n'),
      queryId: page.queryId, nextCursor: page.nextCursor, total: page.total, note: '先写“在本次查询范围内找到 N 条会议/日程记录”，分别列 WeLink 和 Exchange 条数，并保留覆盖与范围说明。每条记录将上面的“完整时间范围 · 主题 · 地点 · 来源 [出处]”整行原样引用，起止时间保持在同一行；分析另起一段。合计按记录计数；跨源同名可能是同一场。请翻完 nextCursor；失败、时间未知的条目单列待核对。' };
  }
  async message(args = {}) {
    const ids = Array.isArray(args.ids) ? args.ids.map(String) : [];
    if (!ids.length || ids.length > 10) throw new Error('每次读取 1 到 10 条消息');
    const data = args.queryId ? this.load(args.queryId) : null;
    const rows = data?.context || data?.items || Object.values(this.ownSnapshot().messages || {}).flat();
    const parts = [];
    for (const sourceId of ids) {
      const found = await this.execute({ op: 'read', sourceId, queryId: args.queryId, offset: args.offset });
      const row = found.item, same = rows.filter(x => x.conv === row.conv).sort((a, b) => a.at - b.at), ix = same.findIndex(x => x.sourceId === sourceId);
      const adjacent = ix < 0 ? [] : same.slice(Math.max(0, ix - 3), ix + 4).filter(x => x.sourceId !== sourceId);
      parts.push({ sourceId, text: `${D.displayTime(row.at)} ${row.sender}：${row.text}`, nextOffset: found.nextOffset,
        context: adjacent.map(x => `${D.displayTime(x.at)} ${x.sender}：${D.short(x.text || x.preview, 200)} [${x.sourceId}]`), note: '上下文为同次查询已取到的相邻消息；不足三条时不编造。' });
    }
    return { items: parts };
  }
}
module.exports = { AssistantQuery, queryRange, TTL };
