'use strict';
function createAssistantWorkbench({ document, ipcRenderer, onTalk, showMessage }) {
  const el = document.createElement('div'); el.className = 'ap-workbench'; el.hidden = true;
  const esc = s => String(s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const call = async (name, v) => { const r = await ipcRenderer.invoke('assistant:' + name, v); if (r?.ok === false) throw Error(r.error); return r; };
  let data = null;
  function paint() {
    const d = data || {}, p = d.plan, l = d.lesson;
    el.innerHTML = `<div class="aw-head"><div><h2>今天，交给秘书</h2><p>计划 · 学习 · Hub 工作进展</p></div><button data-aw="refresh">刷新状态</button></div>
      <section><h3>${esc(d.config?.morning || '08:00')} 今日计划</h3>${p ? `<p class="aw-text">${esc(p.text)}</p>${p.items.map(i => `<label><input type="checkbox" data-aw-item="${esc(i.id)}" ${i.done ? 'checked' : ''}> ${esc(i.time)} ${esc(i.title)}<small>${esc(i.reason)}</small></label>`).join('')}<button data-aw="confirm">${p.confirmedAt ? '已确认' : '确认计划'}</button> <button data-aw="talk" data-kind="plan" data-id="${esc(d.day)}">调整计划</button>` : '<p>今日计划尚未生成，先记下需要安排的事。</p>'}</section>
      <section><h3>今日一档</h3>${l ? `<h2>${esc(l.title)}</h2><p class="aw-text">${esc(l.oneMinute)}</p><button data-aw="talk" data-kind="lesson" data-id="${esc(d.day)}">追问这一期</button><p>完整口播与阅读稿在手机「学习」；实际时长以合成结果为准。</p>` : '<p>每天一个知识点，目标 10–15 分钟口播，有讲述卡和追问。</p>'}</section>
      <section><h3>Hub 工作进展</h3><p>快照：${d.sessionSnapshotAt ? esc(new Date(d.sessionSnapshotAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })) : '尚未刷新'} · 只读现有状态，不调用模型</p>${(d.sessions || []).map(s => `<div class="aw-session"><div><b>${esc(s.title)}</b><small>${esc(s.kind)} · ${esc(s.label)}${s.updatedAt ? ' · ' + esc(new Date(s.updatedAt).toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hour12: false })) : ''}</small>${s.last ? `<small class="aw-last">${esc(s.last)}</small>` : ''}</div><button data-aw="talk" data-kind="session" data-id="${esc(s.id)}">交给助理</button></div>`).join('') || '<p>点刷新获取当前 Hub 会话。空闲与新回复都不代表业务已完成。</p>'}</section>
      <section><h3>${esc(d.config?.evening || '21:00')} 今日总结</h3><p class="aw-text">${esc(d.summary?.text || '今晚按事实收尾，未完成接到明天。')}</p></section>`;
  }
  async function refresh(force = false) { data = await call('workbench', { refresh: force }); paint(); }
  el.addEventListener('click', async e => {
    const b = e.target.closest('[data-aw]'); if (!b) return; b.disabled = true;
    try {
      if (b.dataset.aw === 'refresh') await refresh(true);
      else if (b.dataset.aw === 'confirm') { data = await call('workbench-action', { action: 'confirm', day: data.day }); paint(); }
      else if (b.dataset.aw === 'talk') { const r = await call('workbench-context', { kind: b.dataset.kind, id: b.dataset.id }); onTalk(r.text); }
    } catch (e) { showMessage?.(e.message); } finally { b.disabled = false; }
  });
  el.addEventListener('change', async e => { const i = e.target.closest('[data-aw-item]'); if (!i) return; i.disabled = true; try { data = await call('workbench-action', { action: i.checked ? 'done' : 'reopen', day: data.day, itemId: i.dataset.awItem }); paint(); } catch (e) { i.checked = !i.checked; showMessage?.(e.message); } finally { i.disabled = false; } });
  return { el, show() { el.hidden = false; void refresh().catch(e => showMessage?.(e.message)); }, hide() { el.hidden = true; } };
}
module.exports = { createAssistantWorkbench };
