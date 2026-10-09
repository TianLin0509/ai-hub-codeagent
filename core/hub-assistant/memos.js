'use strict';
// 备忘清单（2026-10-05 用户：助理 Tab 的核心功能）。用户对助理说的突发待办、碎片灵感，由助理会话调用 add_memo 写入；
// 清单给用户看：一行一个 AI 提炼的标题，点开是当时原话与记录时间。
// 设计依据（artifacts/20261005-备忘调研-claude1.md）：
// - 原话由 Hub 取自用户那条消息，原样保留，不让模型改写（AudioPen 只留整理稿被诟病改错人名数字）。
// - 状态只有 open（待办）/ done（完成）/ dropped（不做了）；「推迟」是动作：改到具体时间，或移到「以后」（Things 的 Someday）。
// - 分组：今天（今天到期与已过期，过期不标红、注明原定）/ 即将 / 随时 / 以后；已完成默认收起。
// - 有明确时间的同时设到点提醒（与提醒模块联动），完成或不做了就取消提醒。
// - 每晚 21:00（北京时间）推一次清单，清单为空不推；待办按统一编号，「第 2 条推到周五」在各端指同一条。
const { randomUUID } = require('node:crypto');
const { parseWhen } = require('./reminders');
const TZ = 'Asia/Shanghai', DAY = 86400000, BJ = 8 * 3600000;
const KINDS = { todo: '待办', idea: '灵感' };
const STATUS = { open: '待办', done: '已完成', dropped: '不做了' };
const GROUPS = [['today', '今天'], ['soon', '即将'], ['anytime', '随时'], ['later', '以后']];
const bjDay = ms => Math.floor((ms + BJ) / DAY);
const clip = (s, n) => { const t = String(s || '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n) + '…' : t; };
function whenLabel(at, now) {
  const d = bjDay(at) - bjDay(now), hm = new Date(at).toLocaleTimeString('zh-CN', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false });
  if (d === 0) return '今天 ' + hm; if (d === 1) return '明天 ' + hm; if (d === -1) return '昨天 ' + hm;
  if (d > 1 && d < 7) return '周' + '日一二三四五六'[new Date(at + BJ).getUTCDay()] + ' ' + hm;
  return new Date(at).toLocaleDateString('zh-CN', { timeZone: TZ, month: 'numeric', day: 'numeric' }) + ' ' + hm;
}
// 下一个北京时间 hh:mm（严格晚于 now）。
function nextBeijing(now, hour, minute = 0) {
  let t = (bjDay(now)) * DAY - BJ + hour * 3600000 + minute * 60000;
  while (t <= now) t += DAY;
  return t;
}

class AssistantMemos {
  constructor({ store, reminders = null, now = () => Date.now(), isOwner = () => true, onChange = () => {}, onDigest = () => {}, digestHour = 21 }) {
    this.store = store; this.reminders = reminders; this.now = now; this.isOwner = isOwner; this.onChange = onChange; this.onDigest = onDigest; this.digestHour = digestHour; this.timer = null;
  }
  all() { return (this.store.get('memos') || []).slice(); }
  save(rows, changed) {
    // 已完成 / 不做了的保留 30 天可查，之后清掉，清单不会越积越长。
    const now = this.now();
    this.store.set('memos', rows.filter(m => m.status === 'open' || now - (m.closedAt || m.updatedAt || 0) < 30 * DAY));
    try { this.onChange(changed); } catch (e) { console.warn('[assistant] memo change', e.message); }
  }
  group(m, now = this.now()) {
    if (m.status !== 'open') return 'closed';
    if (m.later) return 'later';
    if (m.due) return bjDay(m.due) <= bjDay(now) ? 'today' : 'soon';
    return 'anytime';
  }
  // 待办按「今天 → 即将 → 随时 → 以后」排好并编号；各端与助理工具都用这个顺序，编号一致。
  openList(now = this.now()) {
    const order = Object.fromEntries(GROUPS.map(([k], i) => [k, i]));
    const rows = this.all().filter(m => m.status === 'open').map(m => ({ ...m, group: this.group(m, now) }));
    rows.sort((a, b) => order[a.group] - order[b.group] || (a.due || 0) - (b.due || 0) || a.createdAt - b.createdAt);
    return rows.map((m, i) => ({ ...m, no: i + 1 }));
  }
  closedList() { return this.all().filter(m => m.status !== 'open').sort((a, b) => (b.closedAt || 0) - (a.closedAt || 0)); }
  find(ref) {
    const rows = this.all(), key = String(ref ?? '').trim();
    const byNo = /^\d+$/.test(key) ? this.openList().find(m => m.no === Number(key)) : null;
    const hit = byNo ? rows.find(m => m.id === byNo.id) : rows.find(m => m.id === key || (key.length >= 6 && m.id.startsWith(key)));
    if (!hit) throw new Error('没有找到这条备忘（用 list_memos 查看编号或 id）');
    return hit;
  }
  add({ title, raw, due = '', kind = 'todo', source = '' }) {
    const name = clip(title, 40);
    if (!name) throw new Error('请给备忘写一个简短标题');
    if (!(kind in KINDS)) throw new Error('kind 只能是 todo（待办）或 idea（灵感）');
    const now = this.now(), at = due ? parseWhen(due, now) : null;
    const memo = { id: randomUUID(), title: name, raw: String(raw || '').trim().slice(0, 2000), kind, source: String(source || '').slice(0, 20), status: 'open', createdAt: now, updatedAt: now, snoozes: 0, ...(at ? { due: at } : {}) };
    if (at) memo.reminderId = this.setReminder(memo);
    this.save([...this.all(), memo], memo);
    return memo;
  }
  setReminder(memo) {
    if (!this.reminders || !memo.due || memo.due <= this.now()) return undefined;
    const when = new Date(memo.due + BJ).toISOString().slice(0, 16).replace('T', ' ');
    return this.reminders.add({ when, text: memo.title, source: 'memo:' + memo.id }).id;
  }
  clearReminder(memo) {
    if (!this.reminders || !memo.reminderId) return null;
    try { const r = this.reminders.cancel(memo.reminderId); delete memo.reminderId; return r; } catch { delete memo.reminderId; return null; }
  }
  // action：done 完成 / drop 不做了 / reopen 恢复 / snooze 推迟（until 写北京时间；until=later 移到「以后」）/ rename 改标题
  update(ref, { action, until = '', title = '' } = {}) {
    const rows = this.all(), memo = rows.find(m => m.id === this.find(ref).id), now = this.now();
    const changes = { reminderCancelled: null, reminderSet: null };
    if (action === 'done' || action === 'drop') {
      memo.status = action === 'done' ? 'done' : 'dropped'; memo.closedAt = now; changes.reminderCancelled = this.clearReminder(memo);
    } else if (action === 'reopen') {
      memo.status = 'open'; delete memo.closedAt;
    } else if (action === 'snooze') {
      changes.reminderCancelled = this.clearReminder(memo);
      if (String(until).trim() === 'later') { memo.later = true; delete memo.due; }
      else { memo.due = parseWhen(until, now); delete memo.later; memo.reminderId = this.setReminder(memo); changes.reminderSet = memo.reminderId || null; }
      memo.snoozes = (memo.snoozes || 0) + 1; memo.status = 'open'; delete memo.closedAt;
    } else if (action === 'rename') {
      const name = clip(title, 40); if (!name) throw new Error('新标题不能为空'); memo.title = name;
    } else throw new Error('action 只能是 done、drop、reopen、snooze、rename');
    memo.updatedAt = now;
    this.save(rows, memo);
    return { memo, ...changes };
  }
  // 提醒模块那边提醒响过：备忘仍是待办（用户说办完才算完），只是不再挂着提醒 id。
  reminderFired(reminder) {
    const id = String(reminder?.source || '').replace(/^memo:/, ''); if (!id || id === reminder?.source) return;
    const rows = this.all(), memo = rows.find(m => m.id === id); if (!memo || memo.reminderId !== reminder.id) return;
    delete memo.reminderId; this.store.set('memos', rows);
  }
  // 给手机与助理页的精简视图：待办全部 + 最近 7 天关掉的（最多 30 条）。
  view(now = this.now()) {
    const short = m => ({ id: m.id, no: m.no, title: m.title, raw: m.raw, kind: m.kind, status: m.status, group: m.group || this.group(m, now), createdAt: m.createdAt, due: m.due || null, dueLabel: m.due ? whenLabel(m.due, now) : '', later: !!m.later, source: m.source || '', snoozes: m.snoozes || 0, closedAt: m.closedAt || null });
    return { open: this.openList(now).map(short), closed: this.closedList().filter(m => now - (m.closedAt || 0) < 7 * DAY).slice(0, 30).map(short), groups: Object.fromEntries(GROUPS) };
  }
  signature() { return JSON.stringify(this.all().map(m => [m.id, m.status, m.title, m.due, m.later, m.updatedAt])) + ':' + bjDay(this.now()); }
  // 晚间清单：编号与各端一致；放了一周以上、没有日期的单独点出来，由用户决定还要不要。
  digest(now = this.now()) {
    const open = this.openList(now); if (!open.length) return '';
    const lines = [`用户，今天的备忘清单（${open.length} 条待办）：`];
    for (const [key, label] of GROUPS) {
      const rows = open.filter(m => m.group === key); if (!rows.length) continue;
      lines.push(`**${label}**`);
      for (const m of rows) lines.push(`${m.no}. ${m.kind === 'idea' ? '💡 ' : ''}${m.title}${m.due ? '（' + (bjDay(m.due) < bjDay(now) ? '原定 ' : '') + whenLabel(m.due, now) + '）' : ''}`);
    }
    const stale = open.filter(m => !m.due && now - m.createdAt > 7 * DAY);
    if (stale.length) lines.push(`其中 ${stale.map(m => m.no).join('、')} 号放了一周以上，不需要的可以说「第 N 条不做了」。`);
    lines.push('可以直接回我「第 2 条办完了」「第 3 条推到周五」。');
    return lines.join('\n');
  }
  // 每晚 21:00 推一次；Hub 当时没开，当晚 24 点前启动会补推，过了就不补。
  fireDigest() {
    if (!this.isOwner() || this.store.get('workbench.config')?.enabled === true) return null;
    const now = this.now(), today = bjDay(now), slot = today * DAY - BJ + this.digestHour * 3600000;
    if (now < slot || this.store.get('memoDigestDay') === today) return null;
    this.store.set('memoDigestDay', today);
    const text = this.digest(now); if (!text) return null;
    try { this.onDigest({ id: 'memo-digest:' + today, text }); } catch (e) { console.warn('[assistant] memo digest', e.message); }
    return text;
  }
  schedule() {
    clearTimeout(this.timer); if (this.stopped) return;
    try { this.fireDigest(); } catch (e) { console.warn('[assistant] memo digest', e.message); }
    const wait = Math.max(1000, Math.min(nextBeijing(this.now(), this.digestHour) - this.now() + 1000, 30 * 60000));
    this.timer = setTimeout(() => this.schedule(), wait); this.timer.unref?.();
  }
  stop() { this.stopped = true; clearTimeout(this.timer); }
}
module.exports = { AssistantMemos, KINDS, STATUS, GROUPS, whenLabel, nextBeijing };
