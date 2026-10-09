'use strict';
// 给快答的 Hub 只读状态摘要：哪些会话在跑或等用户、最近 24 小时各会话的最新结果、关注的任务、待提醒。
// 快答据此当场回答「仿真跑完没」「今天有啥进展」这类问题；要读原文、分析或动手仍交给助理会话。
// 只放摘录（每条最多约 140 字），总长控制在约 1500 字，保证快答仍在 2～3 秒内。
const TZ = 'Asia/Shanghai';
const hm = at => new Date(at).toLocaleTimeString('zh-CN', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false });
const md = at => new Date(at).toLocaleDateString('zh-CN', { timeZone: TZ, month: 'numeric', day: 'numeric' });
const when = (at, now) => (md(at) === md(now) ? '今天' : md(at)) + ' ' + hm(at);
const clip = (s, n) => { const t = String(s || '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n) + '…' : t; };
const STATUS = { running: '运行中', waiting: '等你回复', idle: '空闲', closed: '已关闭' };

function buildStatusDigest({ sessions = [], ledger = [], followed = [], reminders = [], memos = null, now = Date.now(), maxChars = 1500 } = {}) {
  const lines = [`现在是北京时间 ${when(now, now)}。以下是 AI Hub 的只读状态摘要。`];
  const work = sessions.filter(s => s.purpose !== 'hub-assistant');
  const active = work.filter(s => ['running', 'waiting'].includes(s.status));
  lines.push(active.length ? '正在运行或等你回复的会话：' + active.slice(0, 8).map(s => `「${clip(s.title || s.name, 24)}」${s.kind || ''}·${STATUS[s.status]}`).join('；') : '当前没有正在运行的会话。');
  // 备忘清单（编号与各端一致）：快答据此回答「还有几条」「明天要干啥」，改清单仍交给助理会话。
  if (memos) lines.push(memos.length ? `备忘清单共 ${memos.length} 条待办（编号与手机和助理页一致）：\n` + memos.slice(0, 15).map(m => `${m.no}. ${clip(m.title, 24)}（${m.dueLabel || '没定时间'}）`).join('\n') + (memos.length > 15 ? `\n……另有 ${memos.length - 15} 条` : '') : '备忘清单是空的。');
  // 最近 24 小时：每个会话只取最新一条最终答复。
  const latest = new Map();
  for (const e of ledger) if (now - e.at < 86400000 && (!latest.has(e.sessionId) || latest.get(e.sessionId).at < e.at)) latest.set(e.sessionId, e);
  const recent = [...latest.values()].sort((a, b) => b.at - a.at).slice(0, 8);
  if (recent.length) { lines.push('最近 24 小时各会话的最新结果（摘录，全文以原会话为准）：'); for (const e of recent) lines.push(`- ${when(e.at, now)}「${clip(e.title, 24)}」（${e.kind || '会话'}）：${clip(e.text, 140)}`); }
  else lines.push('最近 24 小时没有会话产出新结果。');
  if (followed.length) lines.push('关注中的任务：' + followed.slice(0, 6).map(w => `「${clip(w.title, 24)}」`).join('、'));
  const upcoming = reminders.filter(r => !r.firedAt && r.at > now).sort((a, b) => a.at - b.at).slice(0, 5);
  const REP = { daily: '（每天）', weekdays: '（每个工作日）', weekly: '（每周）' };
  if (upcoming.length) lines.push('待提醒：' + upcoming.map(r => `${when(r.at, now)} ${clip(r.text, 30)}${REP[r.repeat] || ''}`).join('；'));
  let text = lines.join('\n');
  if (text.length > maxChars) text = text.slice(0, maxChars) + '…';
  return text;
}
module.exports = { buildStatusDigest };
