'use strict';
const W = require('./welink');
const D = require('./data');
const MEETING_PAGE_MAX = 30;
const CALENDAR_MAX = 500;
const meetingPageSize = value => Number.isFinite(Number(value)) ? Math.max(1, Math.min(MEETING_PAGE_MAX, Math.floor(Number(value)))) : MEETING_PAGE_MAX;

function readableError(value, depth = 0) {
  if (typeof value === 'string') return value.trim();
  if (!value || typeof value !== 'object' || depth >= 3) return '';
  // 不把整份错误响应写入界面（可能附带账号/请求上下文），只取明确的错误说明。
  for (const key of ['message', 'msg', 'error_msg', 'description', 'reason', 'detail']) {
    const text = readableError(value[key], depth + 1);
    if (text) return text;
  }
  return '';
}

// 命令执行成功、业务成功、JSON 可读是三个条件。联系人成功码为 0，会议为 200。
async function readJson(run, args) {
  const command = args.slice(0, 2).join(' ');
  let result = await run(args);
  const checkExit = r => {
    if (r.code === null || r.code !== undefined && Number(r.code) !== 0) throw new Error(String(r.stderr || r.stdout || `查询退出码 ${r.code}`).trim());
  };
  checkExit(result);
  // Q-1021-07：仅 calendar list 的成功空结果是纯文本；不接受其他命令或失败退出。
  if (command === 'calendar list' && [0, '0'].includes(result.code) && String(result.stdout || '').trim() === 'No events found.') return [];
  let data = W.parseJsonBig(result.stdout);
  if (data == null && command !== 'calendar list' && !args.includes('--format')) {
    result = await run([...args, '--format', 'json']); checkExit(result); data = W.parseJsonBig(result.stdout);
  }
  if (!data || typeof data !== 'object') throw new Error(String(result.stderr || result.stdout || '查询没有返回 JSON').trim());
  const code = data.code ?? data.resultCode ?? data.error?.error_code;
  // Q-1021-08：会话目录成功码是 IM.0000；仅对该命令接受，不能放开所有 IM 错误。
  const allowed = command === 'contact detail' ? ['0'] : command === 'meeting query-list' ? ['200']
    : command === 'im query-recent-conversation' ? ['0', '200', 'IM.0000'] : ['0', '200'];
  if (code !== undefined && !allowed.includes(String(code))) {
    const detail = [data.message, data.resultContext, data.error?.error_msg].map(x => readableError(x)).find(Boolean);
    throw new Error(`${command} 查询业务码 ${code}${detail ? '：' + detail : ''}`);
  }
  return data;
}

function meetingType(value) {
  const type = String(value);
  if (!['1', '2'].includes(type)) throw new Error('会议查询类型只能为待参加（1）或已结束（2）');
  return type;
}
const meetingTypeLabel = type => type === '2' ? '已结束' : '待参加';

function meetingArgs(now, page = 1, size = MEETING_PAGE_MAX, range = null, type = '1') {
  type = meetingType(type);
  const begin = range?.start ?? Date.parse(D.dayKey(now) + 'T00:00:00+08:00');
  const end = (range?.end ?? begin + 86400000) - 1;
  return ['meeting', 'query-list', '--page', String(page), '--size', String(meetingPageSize(size)), '--meeting-start-time', String(begin), '--meeting-end-time', String(end), '--type', type, '--meeting-sort', 'asc'];
}

async function collectMeetings(runJson, now, { size = MEETING_PAGE_MAX, maxPages = 30, range = null, type = '1' } = {}) {
  type = meetingType(type);
  size = meetingPageSize(size); // 参数与短页判断必须使用同一个实际页大小。
  const found = new Map(), instances = new Map();
  const coverage = { status: 'partial', reason: 'page-limit', pages: 0, total: null, invalid: 0, instances: 0, versionConflicts: 0, scope: `指定日期范围内${meetingTypeLabel(type)}的 WeLink 会议（type=${type}）`, queryType: type, queryTypes: [type] };
  for (let page = 1; page <= maxPages; page += 1) {
    const raw = await runJson(`${meetingTypeLabel(type)}会议`, meetingArgs(now, page, size, range, type));
    coverage.pages += 1;
    if (!raw) { coverage.reason = 'query-failed'; coverage.status = found.size ? 'partial' : 'failed'; break; }
    // Q-1021-09：成功空页省略列表字段；只接受与本次请求匹配的已核实包络。
    const emptyPage = raw.code === 200 && raw.data && !Array.isArray(raw.data)
      && raw.data.total === 0 && raw.data.page === page && raw.data.size === size
      && !Object.prototype.hasOwnProperty.call(raw.data, 'data');
    if (!Array.isArray(raw.data?.data) && !emptyPage) { coverage.reason = 'invalid-shape'; coverage.status = found.size ? 'partial' : 'failed'; break; }
    const records = emptyPage ? [] : raw.data.data, rows = D.meetings(raw);
    const previous = found.size;
    // 完全相同记录的分页重叠可消除；同编号的不同实例/记录版本全部保留。
    for (const row of rows) {
      found.set(row.sourceId, { ...row, queryTypes: [type] });
      const id = row.occurrenceId || row.sourceId, versions = instances.get(id) || new Set();
      const previousVersions = versions.size;
      versions.add(row.sourceId); instances.set(id, versions);
      if (previousVersions === 1 && versions.size === 2) coverage.versionConflicts += 1;
    }
    coverage.instances = instances.size;
    coverage.invalid += records.length - rows.length;
    coverage.timeUnknown = (coverage.timeUnknown || 0) + rows.filter(D.eventTimeUnknown).length;
    const total = Number(raw.data.total);
    // 越界空页报告 total=0，并不表示前页的正总数消失；取不足时仍须报 early-end。
    if (raw.data.total != null && Number.isFinite(total) && total >= 0
      && !(records.length === 0 && total === 0 && coverage.total > 0)) coverage.total = total;
    if (rows.length && found.size === previous) { coverage.reason = 'repeated-page'; break; }
    // 总数可能包含分页重叠，记录版本数也不是独立实例数；满页继续取到真实边界。
    if (records.length < size) { coverage.reason = 'exhausted'; break; }
  }
  if (coverage.reason === 'exhausted') {
    const fewer = coverage.total !== null && instances.size < coverage.total;
    const more = coverage.total !== null && instances.size > coverage.total;
    coverage.status = coverage.invalid || coverage.timeUnknown || coverage.versionConflicts || fewer || more ? 'partial' : 'complete';
    coverage.reason = coverage.timeUnknown ? 'unknown-time' : coverage.invalid ? 'invalid-record' : coverage.versionConflicts ? 'version-conflict' : fewer ? 'early-end' : more ? 'total-mismatch' : 'exhausted';
  }
  coverage.reasonLabel = { 'page-limit': '会议超过本轮分页上限', 'query-failed': '会议查询失败，日历仍可补充', 'invalid-shape': '会议返回结构与已核对接口不一致',
    'invalid-record': '部分会议缺少时间或编号', 'unknown-time': '部分会议的时间或时区待核对', 'early-end': '会议实例数少于接口报告的总数', 'total-mismatch': '会议实例数超过接口报告的总数，查询期间数据可能变化',
    'version-conflict': `${coverage.versionConflicts} 个会议实例存在不同记录版本，待核对`, 'repeated-page': '会议接口重复返回已取得的记录', exhausted: '会议查询完成' }[coverage.reason];
  if (coverage.versionConflicts && coverage.reason !== 'version-conflict') coverage.reasonLabel += `；${coverage.versionConflicts} 个会议实例存在不同记录版本，待核对`;
  return { meetings: [...found.values()].sort((a, b) => a.start - b.start), coverage };
}

async function collectMeetingAgenda(runJson, now, options = {}) {
  // Q-1021-09：type1 不包含已结束会议；分别查两类，不能把 type4 推断为仅本人。
  const queryTypes = ['1', '2'], found = new Map(), instances = new Map(), byType = {};
  for (const type of queryTypes) {
    const result = await collectMeetings(runJson, now, { ...options, type });
    byType[type] = result.coverage;
    for (const row of result.meetings) {
      const prior = found.get(row.sourceId);
      found.set(row.sourceId, { ...row, queryTypes: [...new Set([...(prior?.queryTypes || []), type])] });
      const id = row.occurrenceId || row.sourceId, versions = instances.get(id) || new Set();
      versions.add(row.sourceId); instances.set(id, versions);
    }
  }
  const meetings = [...found.values()].sort((a, b) => a.start - b.start);
  const parts = Object.values(byType), versionConflicts = [...instances.values()].filter(x => x.size > 1).length;
  const complete = parts.every(x => x.status === 'complete') && !versionConflicts;
  const failed = parts.every(x => x.status === 'failed');
  const queryFailed = parts.every(x => x.reason === 'query-failed');
  const status = complete ? 'complete' : failed ? 'failed' : 'partial';
  return { meetings, coverage: {
    status, reason: versionConflicts ? 'version-conflict' : complete ? 'exhausted' : queryFailed ? 'query-failed' : failed ? 'category-failed' : 'category-incomplete',
    reasonLabel: queryTypes.map(type => `${meetingTypeLabel(type)}：${byType[type].reasonLabel}`).join('；')
      + (versionConflicts ? `；${versionConflicts} 个会议实例存在不同记录版本，待核对` : ''),
    pages: parts.reduce((sum, x) => sum + x.pages, 0),
    // 状态切换时两类可能重叠；总数不能简单相加，各类接口总数留在 byType 中。
    total: complete ? instances.size : null, instances: instances.size,
    invalid: parts.reduce((sum, x) => sum + x.invalid, 0), timeUnknown: meetings.filter(D.eventTimeUnknown).length, versionConflicts,
    scope: '指定日期范围内待参加及已结束的 WeLink 会议（type=1,2）', queryType: queryTypes.join(','), queryTypes, byType,
  } };
}

async function collectCalendar(runJson, range) {
  // calendar list 使用日期边界，至少覆盖到下一天；最终按精确窗口过滤。
  const start = D.dayKey(range.start), endDay = D.dayKey(range.end);
  const end = Date.parse(endDay + 'T00:00:00+08:00') < range.end ? D.dayKey(range.end + 86400000) : endDay;
  const raw = await runJson('日程', ['calendar', 'list', '--start', start, '--end', end, '--max', String(CALENDAR_MAX)]);
  if (!raw) return { events: [], coverage: { status: 'failed', reason: 'query-failed', reasonLabel: 'Exchange 日程查询失败' } };
  const records = D.recordsAt ? D.recordsAt(raw, ['events', 'items', 'value', 'calendars', 'data']) : recordsAt(raw);
  if (records === null) return { events: [], coverage: { status: 'failed', reason: 'invalid-shape', reasonLabel: '无法识别日程结构；不能当作没有日程' } };
  const all = D.calendarEvents(raw), invalid = records.length - all.length;
  const unknownTime = all.filter(D.eventTimeUnknown).length;
  const envelopes = [raw, raw.data, raw.result, raw.data?.result].filter(x => x && typeof x === 'object');
  const total = envelopes.map(x => x.total ?? x.count).find(x => x != null);
  const flag = x => x === true || x === 'true' || x === 1;
  const hasMore = envelopes.some(x => flag(x.hasMore) || flag(x.has_more) || x.nextLink || x.next_link || x.next_cursor || x['@odata.nextLink'])
    || total != null && (!Number.isFinite(Number(total)) || Number(total) > records.length);
  const limited = records.length >= CALENDAR_MAX;
  const coverage = { status: invalid || unknownTime || hasMore || limited ? 'partial' : 'complete', records: records.length, invalid, unknownTime, limited, limit: CALENDAR_MAX,
    reason: hasMore ? 'more-records' : limited ? 'result-limit' : invalid ? 'invalid-record' : unknownTime ? 'unknown-time' : 'exhausted',
    reasonLabel: hasMore ? '接口还有日程，分页协议尚未核实' : limited ? `已达到日程 ${CALENDAR_MAX} 条返回上限，可能还有记录；分页协议尚未核实` : invalid ? `${invalid} 条日程无法解析` : unknownTime ? `${unknownTime} 条日程时间待核对` : '日程查询完成' };
  return { events: all.filter(x => D.eventInRange(x, range)), coverage };
}
function recordsAt(raw) {
  if (Array.isArray(raw)) return raw.every(x => x && typeof x === 'object') ? raw : null;
  if (!raw || typeof raw !== 'object') return null;
  for (const key of ['events', 'items', 'value', 'calendars', 'data']) if (raw[key] !== undefined) { const found = recordsAt(raw[key]); if (found !== null) return found; }
  return null;
}
function mailResult(raw) {
  if (!raw) return { mails: [], coverage: { status: 'failed', reason: 'query-failed', reasonLabel: '未读邮件查询失败' } };
  const locate = x => {
    if (Array.isArray(x)) return x;
    if (!x || typeof x !== 'object') return null;
    for (const key of ['mails', 'messages', 'items', 'value', 'data']) if (x[key] !== undefined) { const found = locate(x[key]); if (found !== null) return found; }
    return null;
  };
  const records = locate(raw);
  if (records === null) return { mails: [], coverage: { status: 'failed', reason: 'invalid-shape', reasonLabel: '未读邮件结构无法识别' } };
  const mails = D.mails(raw), total = raw.total ?? raw.data?.total;
  const limited = records.length >= 20 || raw.hasMore === true || raw.data?.hasMore === true || total != null && Number(total) > records.length;
  return { mails, coverage: { status: limited ? 'partial' : 'complete', records: records.length, limit: 20,
    reason: limited ? 'preview-limit' : 'exhausted', reasonLabel: limited ? `已取 ${records.length} 封；当前为未读预览，不能视为全部未读` : `取到 ${records.length} 封未读邮件` } };
}

module.exports = { readJson, meetingArgs, collectMeetings, collectMeetingAgenda, collectCalendar, mailResult };
