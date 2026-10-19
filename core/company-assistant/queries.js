'use strict';
const W = require('./welink');
const D = require('./data');

// 命令执行成功、业务成功、JSON 可读是三个条件。联系人成功码为 0，会议为 200。
async function readJson(run, args) {
  let result = await run(args);
  const checkExit = r => {
    if (r.code === null || r.code !== undefined && Number(r.code) !== 0) throw new Error(String(r.stderr || r.stdout || `查询退出码 ${r.code}`).trim());
  };
  checkExit(result);
  let data = W.parseJsonBig(result.stdout);
  if (data == null && !args.includes('--format')) {
    result = await run([...args, '--format', 'json']); checkExit(result); data = W.parseJsonBig(result.stdout);
  }
  if (!data || typeof data !== 'object') throw new Error(String(result.stderr || result.stdout || '查询没有返回 JSON').trim());
  const command = args.slice(0, 2).join(' ');
  const code = data.code ?? data.resultCode ?? data.error?.error_code;
  const allowed = command === 'contact detail' ? ['0'] : command === 'meeting query-list' ? ['200'] : ['0', '200'];
  if (code !== undefined && !allowed.includes(String(code))) throw new Error(String(data.message || data.resultContext || data.error?.error_msg || `查询业务码 ${code}`));
  return data;
}

function meetingArgs(now, page = 1, size = 100) {
  const date = new Date(now), begin = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const end = new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1).getTime() - 1;
  return ['meeting', 'query-list', '--page', String(page), '--size', String(size), '--meeting-start-time', String(begin), '--meeting-end-time', String(end), '--type', '1', '--meeting-sort', 'asc'];
}

async function collectMeetings(runJson, now, { size = 100, maxPages = 30 } = {}) {
  const found = new Map();
  const coverage = { status: 'partial', reason: 'page-limit', pages: 0, total: null, invalid: 0, scope: '今天待参加的 WeLink 会议' };
  let received = 0;
  for (let page = 1; page <= maxPages; page += 1) {
    const raw = await runJson('会议', meetingArgs(now, page, size));
    coverage.pages += 1;
    if (!raw) { coverage.reason = 'query-failed'; coverage.status = found.size ? 'partial' : 'failed'; break; }
    if (!Array.isArray(raw.data?.data)) { coverage.reason = 'invalid-shape'; coverage.status = found.size ? 'partial' : 'failed'; break; }
    const records = raw.data.data, rows = D.meetings(raw);
    const previous = found.size;
    for (const row of rows) found.set(row.id, row);
    coverage.invalid += records.length - rows.length;
    received += records.length;
    const total = Number(raw.data.total);
    if (raw.data.total != null && Number.isFinite(total) && total >= 0) coverage.total = total;
    if (coverage.total !== null && received >= coverage.total || records.length < size) {
      coverage.status = coverage.invalid || coverage.total !== null && found.size < coverage.total ? 'partial' : 'complete';
      coverage.reason = coverage.invalid ? 'invalid-record' : coverage.status === 'partial' ? 'early-end' : 'exhausted'; break;
    }
    if (records.length && found.size === previous) { coverage.reason = 'repeated-page'; break; }
  }
  coverage.reasonLabel = { 'page-limit': '会议超过本轮分页上限', 'query-failed': '会议查询失败，日历仍可补充', 'invalid-shape': '会议返回结构与已核对接口不一致',
    'invalid-record': '部分会议缺少时间或编号', 'early-end': '会议列表少于接口报告的总数', 'repeated-page': '会议接口重复返回同一页', exhausted: '会议查询完成' }[coverage.reason];
  return { meetings: [...found.values()].sort((a, b) => a.start - b.start), coverage };
}

module.exports = { readJson, meetingArgs, collectMeetings };
