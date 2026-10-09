'use strict';
// 助理页「备忘」视图（2026-10-05 用户选定方案 C「今日聚焦与详情」）。
// 左边：顶部筛选（全部 / 今天 / 即将 / 随时 / 以后，带数量）+ 紧凑清单（勾选框、编号、标题、时间），最近完成可折叠；
// 右边：选中那条的详情——大标题、时间、当时原话、记录时间线，以及 办完了 / 推到明天 / 推到下周一 / 以后再说 / 不做了。
// 备忘由助理在对话里写入；编号与手机、晚间清单一致。数据与规则在 core/hub-assistant/memos.js。
const TZ = 'Asia/Shanghai';
const CLOCK = '<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><circle cx="12" cy="12" r="8.5" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M12 7.5V12l3 2" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';
function createMemoView({ document, ipcRenderer, showMessage = () => {}, onCount = () => {} }) {
  const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const stamp = at => { const p = Object.fromEntries(new Intl.DateTimeFormat('zh-CN', { timeZone: TZ, month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(new Date(at)).map(x => [x.type, x.value])); return `${p.month}月${p.day}日 ${p.hour}:${p.minute}`; };
  // 北京时间的「明天 9 点」「下周一 9 点」，写成 memos 能解析的「YYYY-MM-DD HH:MM」。
  const bjDate = (offsetDays, hour = 9) => { const d = new Date(Date.now() + 8 * 3600000 + offsetDays * 86400000); return d.toISOString().slice(0, 10) + ' ' + String(hour).padStart(2, '0') + ':00'; };
  const nextMonday = () => { const wd = new Date(Date.now() + 8 * 3600000).getUTCDay(); return bjDate(((8 - wd) % 7) || 7); };
  let data = { open: [], closed: [], groups: {} }, selected = null, filter = 'all', showClosed = false;
  const el = document.createElement('div'); el.className = 'ap-memos'; el.hidden = true; el.setAttribute('aria-label', '备忘清单');
  const call = async (channel, payload) => { const r = await ipcRenderer.invoke(channel, payload); if (r && r.ok === false) throw new Error(r.error || '操作未完成'); return r; };
  const all = () => [...data.open, ...data.closed];
  const overdue = m => m.status === 'open' && m.due && m.due < Date.now() - 60000;
  const whenText = m => m.status !== 'open' ? (m.status === 'dropped' ? '不做了' : '已完成') : m.dueLabel ? (overdue(m) ? '原定 ' + m.dueLabel : m.dueLabel) : m.later ? '以后' : stamp(m.createdAt).replace(/ .*/, '') + ' 记';

  function row(m) {
    const closed = m.status !== 'open';
    return `<li class="apm-row${closed ? ' closed' : ''}${selected === m.id ? ' sel' : ''}${m.group === 'today' && !closed ? ' today' : ''}" data-memo="${esc(m.id)}">
      <button type="button" class="apm-check" data-memo-act="${closed ? 'reopen' : 'done'}" aria-label="${closed ? '恢复为待办' : '办完了'}：${esc(m.title)}">${closed ? '✓' : ''}</button>
      <button type="button" class="apm-main" data-memo-pick="${esc(m.id)}" aria-pressed="${selected === m.id}">
        <span class="apm-no">${m.no || ''}</span><span class="apm-title">${m.kind === 'idea' ? '💡 ' : ''}${esc(m.title)}</span><span class="apm-when">${esc(whenText(m))}</span>
      </button></li>`;
  }
  function timeline(m) {
    // 每行：左列时间（已发生的写具体时刻，提醒写「周三 09:00」），右列发生了什么。
    const rows = [[stamp(m.createdAt), (m.source || '') + '记录', true]];
    if (m.snoozes) rows.push(['推迟', `推迟过 ${m.snoozes} 次`, true]);
    if (m.status === 'open' && m.dueLabel) rows.push([(overdue(m) ? '原定 ' : '') + m.dueLabel, '提醒', false]);
    if (m.status !== 'open' && m.closedAt) rows.push([stamp(m.closedAt), m.status === 'dropped' ? '不做了' : '办完了', true]);
    return `<ol class="apm-line">${rows.map(([at, text, done]) => `<li class="${done ? 'done' : ''}"><b>${esc(at)}</b><span>${esc(text)}</span></li>`).join('')}</ol>`;
  }
  function detail(m) {
    if (!m) return `<div class="apm-none">选一条备忘，在这里看原话和处理。</div>`;
    const closed = m.status !== 'open', group = data.groups?.[m.group] || '';
    return `<div class="apm-dhead"><span>备忘详情</span></div>
      <h2 class="apm-dtitle">${m.kind === 'idea' ? '💡 ' : ''}${esc(m.title)}</h2>
      <p class="apm-dmeta">${m.no ? `第 ${m.no} 条 · ` : ''}${closed ? (m.status === 'dropped' ? '不做了' : '已完成') : esc(group)}${m.kind === 'idea' ? ' · 灵感' : ''}</p>
      <div class="apm-due${overdue(m) ? ' late' : ''}">${CLOCK}<span>${esc(m.status === 'open' ? (m.dueLabel ? (overdue(m) ? '原定 ' : '') + m.dueLabel : m.later ? '以后再说' : '没定时间') : whenText(m))}</span></div>
      <blockquote class="apm-quote"><small>当时原话</small>${esc(m.raw || '（没有记录原话）')}</blockquote>
      <p class="apm-rec">记录于 ${esc(stamp(m.createdAt))}${m.source ? ' · ' + esc(m.source) : ''}</p>
      ${timeline(m)}
      <div class="apm-acts-label">操作</div>
      <div class="apm-acts">${closed ? `<button type="button" class="primary" data-memo-act="reopen">恢复为待办</button>`
        : `<button type="button" class="primary" data-memo-act="done">办完了</button><button type="button" data-memo-act="snooze" data-until="${bjDate(1)}">推到明天</button><button type="button" data-memo-act="snooze" data-until="${nextMonday()}">推到下周一</button><button type="button" data-memo-act="snooze" data-until="later">以后再说</button><button type="button" class="quiet" data-memo-act="drop">不做了</button>`}</div>`;
  }
  function render() {
    if (!data.open.length && !data.closed.length) { el.innerHTML = `<div class="apm-empty"><h2>备忘清单是空的</h2><p>对助理说「记一下……」，突发的事、碎片灵感都会记在这里。<br>说了时间的到点提醒；每晚 9 点把清单发你一次。</p></div>`; return; }
    const groups = Object.entries(data.groups || {}), count = k => data.open.filter(m => m.group === k).length;
    const chips = [['all', '全部', data.open.length], ...groups.map(([k, label]) => [k, label, count(k)])];
    let list = '';
    for (const [key, label] of groups) {
      if (filter !== 'all' && filter !== key) continue;
      const rows = data.open.filter(m => m.group === key); if (!rows.length) continue;
      list += `<section class="apm-group"><h3>${esc(label)} <span>${rows.length}</span></h3><ul>${rows.map(row).join('')}</ul></section>`;
    }
    if (!list) list = `<p class="apm-blank">这一组没有待办。</p>`;
    if (data.closed.length) list += `<section class="apm-group done"><h3><button type="button" data-memo-closed aria-expanded="${showClosed}">${showClosed ? '▾' : '▸'} 最近完成 <span>${data.closed.length}</span></button></h3>${showClosed ? `<ul>${data.closed.map(row).join('')}</ul>` : ''}</section>`;
    el.innerHTML = `<div class="apm">
      <div class="apm-left"><div class="apm-filters" role="tablist">${chips.map(([k, label, n]) => `<button type="button" role="tab" data-memo-filter="${k}" aria-selected="${filter === k}">${esc(label)}<b>${n}</b></button>`).join('')}</div>
        <div class="apm-list">${list}</div></div>
      <aside class="apm-detail" aria-label="备忘详情">${detail(all().find(m => m.id === selected))}</aside></div>`;
  }
  // 选中项消失（办完、被助理删改）时，自动选当前筛选下的第一条待办。
  function ensureSelection() {
    const visible = data.open.filter(m => filter === 'all' || m.group === filter);
    if (!selected || !all().some(m => m.id === selected)) selected = visible[0]?.id || data.open[0]?.id || null;
  }
  async function refresh() {
    try { data = await call('assistant:memos'); } catch (error) { showMessage('备忘读取失败：' + error.message); return; }
    ensureSelection(); onCount(data.open.length); if (!el.hidden) render();
  }
  el.addEventListener('click', async event => {
    const f = event.target.closest('[data-memo-filter]'); if (f) { filter = f.dataset.memoFilter; selected = null; ensureSelection(); render(); return; }
    const closedToggle = event.target.closest('[data-memo-closed]'); if (closedToggle) { showClosed = !showClosed; render(); return; }
    const pick = event.target.closest('[data-memo-pick]'); if (pick) { selected = pick.dataset.memoPick; render(); return; }
    const act = event.target.closest('[data-memo-act]'); if (!act) return;
    const id = act.closest('[data-memo]')?.dataset.memo || selected; if (!id) return;
    const order = data.open.map(m => m.id), at = order.indexOf(id);
    act.disabled = true;
    try {
      await call('assistant:memo-action', { ref: id, action: act.dataset.memoAct, ...(act.dataset.until ? { until: act.dataset.until } : {}) });
      // 办完或不做了：选中顺移到下一条，方便连着处理。
      if (selected === id && ['done', 'drop'].includes(act.dataset.memoAct)) selected = order[at + 1] || order[at - 1] || null;
      await refresh();
    } catch (error) { act.disabled = false; showMessage('没改成：' + error.message); }
  });
  ipcRenderer.on('assistant:memos-changed', () => { void refresh(); });
  return { el, refresh, show() { el.hidden = false; render(); void refresh(); }, hide() { el.hidden = true; }, count: () => data.open.length };
}
module.exports = { createMemoView };
