'use strict';
// 助理页（左侧「助理」）：用户与助理这个个体之间的全部往来——电脑或手机说的话、千问/DeepSeek 快答、
// 助理会话（Claude 等）的回答、提醒——都在这一条对话里。助理会话内部过程留在工作台的会话里，这里只放结论。
// 2026-10-04 用户确认：助理 Tab 是虚拟的「助理」，不是某个 CLI 会话的另一个视图。
function createAssistantPage({ document, window, ipcRenderer, openSession, closeOtherPanels = () => {}, showMessage, onOpenChange = () => {} }) {
  let page = null, entries = [], desk = null, frontDesk = null, profile = null, sending = false, forceAssistant = false, statusOpen = false, memoView = null, workView = null, view = 'chat';
  const TZ = 'Asia/Shanghai';
  const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const time = at => new Date(at).toLocaleTimeString('zh-CN', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false });
  const ymd = at => Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: 'numeric', day: 'numeric' }).formatToParts(new Date(at)).map(x => [x.type, +x.value]));
  const day = at => {
    const d = ymd(at), t = ymd(Date.now()), diff = Math.round((Date.UTC(t.year, t.month - 1, t.day) - Date.UTC(d.year, d.month - 1, d.day)) / 86400000);
    return diff === 0 ? '今天' : diff === 1 ? '昨天' : `${d.month}月${d.day}日`;
  };
  // 助理的回答按 Markdown 渲染（与会话卡片同一套 marked + DOMPurify），中文加粗先宽容处理。
  let md = null;
  const markdown = text => {
    // 与 Hub 全局同一套 marked（原始 HTML 一律转义）+ DOMPurify；中文宽容加粗经占位符渲染后换回 <strong>。
    if (!md) { const { marked } = require('marked'), purify = require('dompurify'), { tidyMarkdown, restoreBold } = require('../core/hub-assistant/markdown-tidy'); md = t => purify.sanitize(restoreBold(marked.parse(tidyMarkdown(t), { breaks: true, gfm: true }))); }
    try { return md(text); } catch { return esc(text); }
  };
  const seconds = ms => ms == null ? '' : ms < 10000 ? (ms / 1000).toFixed(1) + ' 秒' : Math.round(ms / 1000) + ' 秒';
  const call = async (channel, payload) => { const r = await ipcRenderer.invoke(channel, payload); if (r && r.ok === false) throw new Error(r.error || '操作未完成'); return r; };

  function build() {
    if (page) return;
    page = document.createElement('section'); page.className = 'assistant-page'; page.id = 'assistant-page'; page.hidden = true; page.setAttribute('aria-label', '助理');
    page.innerHTML = `<header class="ap-head">
        <img class="ap-avatar" src="assets/assistant/penguin.png" alt="">
        <div class="ap-title"><h1>助理</h1><p class="ap-sub"></p></div>
        <nav class="ap-tabs" aria-label="助理页视图"><button type="button" data-ap="view-today" aria-pressed="false">今日</button><button type="button" data-ap="view-chat" aria-pressed="true">对话</button><button type="button" data-ap="view-memos" aria-pressed="false">备忘<b class="ap-memo-count"></b></button></nav>
        <button type="button" class="ap-chip" data-ap="front" aria-label="回答方式"></button>
        <button type="button" class="ap-chip" data-ap="engine" aria-label="助理会话设置"></button>
        <button type="button" class="ap-chip ap-status-toggle" data-ap="status" aria-label="助理状态" aria-pressed="false">状态</button>
        <button type="button" class="ap-more" data-ap="more" aria-label="更多">···</button>
      </header>
      <div class="ap-body"><div class="ap-main">
        <div class="ap-scroll"><div class="ap-list"></div></div>
        <form class="ap-composer"><button type="button" class="ap-route" data-ap="route" aria-pressed="false" title="这条交给谁：自动（简单的快答，难的交给助理会话），或直接交给助理会话">自动</button><textarea rows="1" placeholder="和助理说…（Enter 发送，Shift+Enter 换行）" aria-label="和助理说"></textarea><button type="submit" class="ap-send" aria-label="发送">发送</button></form>
      </div><aside class="ap-status" hidden aria-label="助理状态"></aside></div>`;
    document.body.append(page);
    // 备忘视图与对话共用底部输入框：看着清单也能直接说「记一下……」「第 2 条办完了」。
    memoView = require('./assistant-memos').createMemoView({ document, ipcRenderer, showMessage: m => showMessage?.(m),
      onCount: n => { const b = page.querySelector('.ap-memo-count'); b.textContent = n ? String(n) : ''; } });
    page.querySelector('.ap-main').prepend(memoView.el);
    workView = require('./assistant-workbench').createAssistantWorkbench({document,ipcRenderer,showMessage,onTalk:text=>{setView('chat');page.querySelector('textarea').value=text;forceAssistant=true;paintRoute();page.querySelector('textarea').focus();}});
    page.querySelector('.ap-main').prepend(workView.el);
    require('./composer-collapse').mountComposerCollapse({ document, host: page.querySelector('.ap-composer'),
      before: page.querySelector('.ap-send'), input: page.querySelector('textarea') });
    page.addEventListener('click', event => {
      const link = event.target.closest('.ap-md a[href]');
      if (link) { event.preventDefault(); const href = link.getAttribute('href') || ''; if (/^https?:\/\//i.test(href)) void ipcRenderer.invoke('open-external-url', href); else { const file = decodeURI(href.replace(/^file:\/\/\/?/i, '')); if (/^[A-Za-z]:[\\/]/.test(file)) void ipcRenderer.invoke('open-path', file); } return; }
      const again = event.target.closest('[data-again]');
      if (again) { const q = entries.find(x => x.id === again.dataset.again && x.role === 'user'); if (q) { again.disabled = true; void call('assistant:ask', { text: q.text, to: 'assistant', again: q.id }).catch(e => showMessage?.(e.message)); } return; }
      const b = event.target.closest('[data-ap]'); if (b) void action(b.dataset.ap, b).catch(e => showMessage?.(e.message));
    });
    const input = page.querySelector('textarea');
    input.addEventListener('input', () => { input.style.height = 'auto'; input.style.height = Math.min(160, input.scrollHeight) + 'px'; });
    input.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); page.querySelector('form').requestSubmit(); } });
    page.querySelector('form').addEventListener('submit', async e => {
      e.preventDefault(); const text = input.value.trim(); if (!text || sending) return;
      sending = true; input.value = ''; input.style.height = 'auto'; paintComposer();
      const to = forceAssistant ? 'assistant' : 'auto'; forceAssistant = false; paintRoute();
      try { await call('assistant:ask', { text, to }); } catch (error) { input.value = text; showMessage?.('没有发出去：' + error.message); }
      finally { sending = false; paintComposer(); void refreshDesk(); }
    });
  }
  function place() {
    if (!page || page.hidden) return;
    const rail = document.getElementById('scene-rail'), bar = document.getElementById('app-toolbar'), panel = document.getElementById('terminal-panel');
    const left = rail && rail.offsetParent !== null ? rail.getBoundingClientRect().right : 0;
    const top = bar ? bar.getBoundingClientRect().bottom : 0;
    const bottom = panel ? window.innerHeight - panel.getBoundingClientRect().bottom : 0;
    Object.assign(page.style, { left: left + 'px', top: top + 'px', bottom: Math.max(0, bottom) + 'px' });
  }
  function paintHead() {
    if (!page) return;
    const fd = frontDesk, p = profile;
    const engine = p ? [p.kindLabel, p.label].filter(Boolean).join(' ') : '助理会话';
    page.querySelector('[data-ap="front"]').textContent = (fd ? fd.label : '回答方式') + ' ▾';
    page.querySelector('[data-ap="engine"]').textContent = engine + ' ▾';
    page.querySelector('.ap-sub').textContent = fd?.mode === 'cli' ? `每条都交给助理会话（${engine}）` : `简单问题${fd ? fd.modelLabel : '快答'}当场答，工作和难题交给 ${engine}`;
  }
  function paintComposer() { if (page) page.querySelector('.ap-send').disabled = sending; }
  function paintRoute() {
    const b = page?.querySelector('.ap-route'); if (!b) return;
    b.textContent = forceAssistant ? '交给助理会话' : '自动'; b.setAttribute('aria-pressed', String(forceAssistant)); b.classList.toggle('on', forceAssistant);
  }
  // 每条消息交给了谁：快答直接看回答；交给助理会话看转交记录（route）。
  function routeOf(id) {
    const fast = entries.find(e => e.id === id && e.role === 'assistant' && e.lane === 'fast');
    if (fast) return '⚡ ' + (fast.by || '快答');
    const route = entries.find(e => e.id === id && e.role === 'route');
    return route ? '助理会话 · ' + (route.by || '') : '';
  }
  function render() {
    if (!page) return;
    const list = page.querySelector('.ap-list'), scroll = page.querySelector('.ap-scroll');
    const atBottom = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 60;
    const answered = new Set(entries.filter(e => e.role === 'assistant' || e.role === 'system').map(e => e.id));
    if (!entries.length) {
      list.innerHTML = `<div class="ap-empty"><img src="assets/assistant/penguin.png" alt=""><h2>用户，我在。</h2><p>电脑上在下面输入，或用手机找我。我们之间的对话都会留在这里。</p></div>`;
      return;
    }
    let lastDay = '', html = '';
    for (const e of entries) {
      const d = day(e.at); if (d !== lastDay) { html += `<div class="ap-day">${esc(d)}</div>`; lastDay = d; }
      if (e.role === 'user') {
        const from = e.source === 'hub' ? '电脑' : e.input === 'voice' ? '手机语音' + (e.durationMs ? ' ' + Math.round(e.durationMs / 1000) + '″' : '') : '手机';
        const to = routeOf(e.id), pending = !answered.has(e.id);
        html += `<div class="ap-msg me"><div class="ap-bubble">${esc(e.text)}</div><div class="ap-cap">${esc(from)} · ${time(e.at)}${to ? ` <span class="ap-to">→ ${esc(to)}${pending ? ' 处理中' : ''}</span>` : e.forced ? ' <span class="ap-to">→ 助理会话</span>' : ''}</div></div>`;
      } else if (e.role === 'assistant') {
        const who = e.lane === 'notice' ? '提醒 · ' + (e.by || '') : (e.by || '') + (e.ms != null ? ' · ' + seconds(e.ms) : '');
        // 快答不满意：一键让助理会话再答（带上原问题）。
        const again = e.lane === 'fast' && entries.some(x => x.id === e.id && x.role === 'user') && !entries.some(x => x.again === e.id) ? ` · <button type="button" class="ap-again" data-again="${esc(e.id)}">让助理会话再答</button>` : '';
        html += `<div class="ap-msg ai ${e.lane === 'fast' ? 'fast' : e.lane === 'notice' ? 'notice' : 'session'}"><div class="ap-bubble ap-md">${markdown(e.text)}</div><div class="ap-cap">${esc(who)} · ${time(e.at)}${again}</div></div>`;
      } else if (e.role === 'system') html += `<div class="ap-note">${esc(e.text)}</div>`;
    }
    const waiting = entries.filter(e => e.role === 'user' && !answered.has(e.id) && Date.now() - e.at < 1800000);
    if (waiting.length) html += `<div class="ap-msg ai typing"><div class="ap-bubble"><span></span><span></span><span></span></div><div class="ap-cap">${esc(desk?.waiting || desk?.queued ? '助理会话处理中' : '正在回答')}</div></div>`;
    list.innerHTML = html;
    if (atBottom || !list.dataset.painted) { scroll.scrollTop = scroll.scrollHeight; list.dataset.painted = '1'; }
  }
  const ago = at => { if (!at) return ''; const m = Math.round((Date.now() - at) / 60000); return m < 1 ? '刚刚' : m < 60 ? m + ' 分钟前' : m < 1440 ? Math.round(m / 60) + ' 小时前' : Math.round(m / 1440) + ' 天前'; };
  const STATES = { idle: '空闲', running: '处理中', waiting: '等待中', 'not-created': '未启动' };
  async function paintStatus() {
    const box = page?.querySelector('.ap-status'); if (!box || !statusOpen) return;
    const [st, phone] = await Promise.all([call('assistant:page-status'), ipcRenderer.invoke('assistant:phone-status').catch(() => null)]);
    const c = st.context, pct = c.tokens && c.cap ? Math.min(100, Math.round(c.tokens / c.cap * 100)) : null;
    const memName = { user: '偏好（USER.md）', memory: '长期记忆（MEMORY.md）' };
    box.innerHTML = `<section><h3>助理会话</h3><p class="ap-kv"><b>${esc(st.session.label)}</b><span>${esc(STATES[st.session.status] || st.session.status || '')}</span></p>
        <p class="ap-dim">${c.tokens ? '上下文 ' + Math.round(c.tokens / 1000) + 'k' + (c.cap ? ' / ' + Math.round(c.cap / 1000) + 'k' : '') + '，满了由 CLI 自动压缩' : '上下文用量在第一轮对话后显示'}</p>
        ${pct != null ? `<div class="ap-bar"><i style="width:${pct}%"></i></div>` : ''}
        <p class="ap-dim">${c.lastRotation ? '上次换班 ' + ago(c.lastRotation.at) + (c.lastRotation.reason ? '（' + esc(c.lastRotation.reason) + '）' : '') : '还没换过班'}</p>
        <div class="ap-row"><button type="button" data-ap="session">打开会话</button><button type="button" data-ap="rotate">新开助理</button></div></section>
      <section><h3>记忆</h3>${st.memory.map(m => `<div class="ap-mem"><p class="ap-kv"><b>${memName[m.kind]}</b><span>${m.count} 条</span></p>${m.recent.map(r => `<p class="ap-line">${esc(r)}</p>`).join('') || '<p class="ap-dim">暂无</p>'}${m.count && m.updatedAt ? `<p class="ap-dim">更新于 ${ago(m.updatedAt)}</p>` : ''}</div>`).join('')}
        <div class="ap-row"><button type="button" data-ap="memory">打开记忆</button><button type="button" data-ap="workbench">工作档案</button></div></section>
      <section><h3>待提醒</h3>${(st.reminders||[]).length ? st.reminders.map(r => `<p class="ap-line">${esc(new Date(r.at).toLocaleString('zh-CN', { timeZone: TZ, month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }))} ${esc(r.text)}</p>`).join('') : '<p class="ap-dim">没有。对助理说「下午三点提醒我开会」即可。</p>'}</section>
      <section><h3>关注的任务</h3>${st.followed.length ? st.followed.map(w => `<p class="ap-line">${esc(w.title)}${w.state ? ` <span class="ap-dim">${esc(w.state)}</span>` : ''}</p>`).join('') : '<p class="ap-dim">没有。对助理说「帮我盯着…」即可关注。</p>'}</section>
      <section><h3>手机</h3><p class="ap-kv"><b>${phone?.ok === false || !phone ? '未连接' : phone.connected ? '已连接' : phone.enabled ? '连接中' : '未开启'}</b><span>${phone?.phoneApp ? 'App ' + esc(phone.phoneApp) : ''}</span></p>
        <div class="ap-row"><button type="button" data-ap="phone">手机连接</button></div></section>`;
  }
  async function refreshDesk() { try { desk = (await call('assistant:dialog-log', { limit: 1 })).desk; } catch {} render(); }
  async function load() {
    const [log, fd, prof] = await Promise.all([call('assistant:dialog-log', { limit: 300 }), call('assistant:front-desk'), call('assistant:phone-profile').catch(() => null)]);
    entries = log.entries || []; desk = log.desk; frontDesk = fd.current; setProfile(prof);
    paintHead(); render(); void paintStatus().catch(() => {});
  }
  function setProfile(prof) {
    if (!prof?.current) return;
    const kind = (prof.kinds || []).find(k => k.kind === prof.current.kind);
    profile = { ...prof.current, kindLabel: kind?.label || prof.current.kind, catalog: prof.kinds || [] };
  }
  // 小菜单：回答方式、助理会话设置、更多。同一时间只开一个。
  function menu(anchor, html, onPick) {
    document.querySelector('.ap-menu')?.remove();
    const m = document.createElement('div'); m.className = 'ap-menu'; m.dataset.for = anchor.dataset.ap || ''; m.innerHTML = html;
    const r = anchor.getBoundingClientRect(); m.style.top = r.bottom + 6 + 'px'; m.style.right = Math.max(8, window.innerWidth - r.right) + 'px';
    m.addEventListener('click', e => { const b = e.target.closest('[data-pick]'); if (b) { e.stopPropagation(); void onPick(b.dataset.pick, m).catch(err => showMessage?.(err.message)); } });
    document.body.append(m); return m;
  }
  function setView(next) {
    view = ['memos','today'].includes(next) ? next : 'chat';
    try { localStorage.setItem('hub.assistant.view', view); } catch {}
    page.querySelector('[data-ap="view-chat"]').setAttribute('aria-pressed', String(view === 'chat'));
    page.querySelector('[data-ap="view-memos"]').setAttribute('aria-pressed', String(view === 'memos'));
    page.querySelector('[data-ap="view-today"]').setAttribute('aria-pressed',String(view==='today'));
    page.querySelector('.ap-scroll').hidden = view !== 'chat';
    if(view==='today')workView.show();else workView.hide();
    if (view === 'memos') memoView.show(); else { memoView.hide(); render(); }
  }
  async function action(name, button) {
    if (['view-chat','view-memos','view-today'].includes(name)) { setView(name.slice(5)); return; }
    if (name === 'route') { forceAssistant = !forceAssistant; paintRoute(); page.querySelector('textarea').focus(); return; }
    if (name === 'status') { statusOpen = !statusOpen; page.querySelector('.ap-status').hidden = !statusOpen; button.setAttribute('aria-pressed', String(statusOpen)); try { localStorage.setItem('hub.assistant.statusOpen', statusOpen ? '1' : '0'); } catch {} if (statusOpen) await paintStatus(); return; }
    if (name === 'session') return openSession();
    if (name === 'rotate') { await call('assistant:rotate-now'); showMessage?.('已换成新的助理会话，旧会话保留为「已换班」。'); return paintStatus(); }
    if (name === 'memory') return call('assistant:open-memory');
    if (name === 'workbench') return call('assistant:open-workbench');
    if (name === 'phone') return require('./assistant-phone').openPhone({ document, ipcRenderer });
    // 再点同一个按钮收起菜单。
    const opened = document.querySelector('.ap-menu'); if (opened && opened.dataset.for === name) { opened.remove(); return; }
    if (name === 'front') {
      const info = await call('assistant:front-desk'); const c = info.current, mark = on => on ? '<i>✓</i>' : '';
      menu(button, `<div class="ap-menu-title">回答方式</div>`
        + info.models.map(x => `<button type="button" data-pick="api|${esc(x.id)}">快速回答 · ${esc(x.label)}${mark(c.mode === 'api' && c.model === x.id)}</button>`).join('')
        + `<button type="button" data-pick="cli|">全部交给助理会话${mark(c.mode === 'cli')}</button><p class="ap-menu-hint">${esc(info.modes.find(x => x.id === c.mode)?.hint || '')}</p>`,
        async (pick, m) => { const [mode, model] = pick.split('|'); m.remove(); const r = await call('assistant:set-front-desk', { mode, ...(model ? { model } : {}) }); frontDesk = r.frontDesk; paintHead(); });
    } else if (name === 'engine') {
      if (!profile) setProfile(await call('assistant:phone-profile'));
      const p = profile, opts = (list, cur, label = x => x) => list.map(x => `<option value="${esc(x.id ?? x)}"${(x.id ?? x) === cur ? ' selected' : ''}>${esc(label(x))}</option>`).join('');
      const EFF = { low: '低', medium: '中', high: '高', xhigh: '超高', max: '最高', minimal: '最低', none: '不思考', ultra: '极限' };
      const m = menu(button, `<div class="ap-menu-title">助理会话</div><p class="ap-menu-hint">难题、工作和 Hub 状态由它处理</p>
        <label>引擎<select data-f="kind">${opts(p.catalog.map(k => ({ id: k.kind, label: k.label })), p.kind, x => x.label)}</select></label>
        <label>模型<select data-f="model"></select></label><label>思考深度<select data-f="effort"></select></label>
        <div class="ap-menu-row"><button type="button" data-pick="session">打开助理会话</button><button type="button" class="primary" data-pick="save">保存</button></div>`,
        async (pick, menuEl) => {
          if (pick === 'session') { menuEl.remove(); await openSession(); return; }
          const v = f => menuEl.querySelector(`[data-f="${f}"]`).value;
          const btn = menuEl.querySelector('.primary'); btn.disabled = true; btn.textContent = '切换中…';
          try { await call('assistant:set-profile', { kind: v('kind'), model: v('model'), ...(v('effort') ? { effort: v('effort') } : {}) }); setProfile(await call('assistant:phone-profile')); paintHead(); menuEl.remove(); }
          catch (error) { btn.disabled = false; btn.textContent = '保存'; throw error; }
        });
      const fill = keep => {
        const k = p.catalog.find(x => x.kind === m.querySelector('[data-f="kind"]').value) || p.catalog[0];
        const models = (k?.models || []).map(x => typeof x === 'string' ? { id: x, label: x } : x);
        const model = keep && models.some(x => x.id === p.model) ? p.model : (models.some(x => x.id === k?.defaultModel) ? k.defaultModel : models[0]?.id);
        m.querySelector('[data-f="model"]').innerHTML = opts(models, model, x => x.label || x.id);
        const effs = () => { const mm = models.find(x => x.id === m.querySelector('[data-f="model"]').value); return mm?.efforts || k?.efforts || []; };
        const paintEff = keepEff => { const list = effs(), cur = keepEff && list.includes(p.effort) ? p.effort : list.includes(k?.defaultEffort) ? k.defaultEffort : list[0]; const sel = m.querySelector('[data-f="effort"]'); sel.innerHTML = opts(list, cur, x => EFF[x] || x); sel.closest('label').hidden = !list.length; };
        paintEff(keep); m.querySelector('[data-f="model"]').onchange = () => paintEff(false);
      };
      fill(true); m.querySelector('[data-f="kind"]').onchange = () => fill(false);
    } else if (name === 'more') {
      menu(button, `<button type="button" data-pick="session">打开助理会话（工作台）</button><button type="button" data-pick="phone">手机连接</button><button type="button" data-pick="memory">助理记忆</button><button type="button" data-pick="workbench">工作档案</button><button type="button" data-pick="rotate">新开助理（换班）</button>`,
        async (pick, m) => {
          m.remove();
          if (pick === 'session') return openSession();
          if (pick === 'phone') return require('./assistant-phone').openPhone({ document, ipcRenderer });
          if (pick === 'memory') return call('assistant:open-memory');
          if (pick === 'workbench') return call('assistant:open-workbench');
          if (pick === 'rotate') { await call('assistant:rotate-now'); showMessage?.('已换成新的助理会话，旧会话保留为「已换班」。'); }
        });
    }
  }
  const onResize = () => place();
  async function open() {
    build(); closeOtherPanels(); window.__assistantHide?.();
    page.hidden = false; document.body.classList.add('assistant-page-open'); onOpenChange(true); place();
    try { statusOpen = localStorage.getItem('hub.assistant.statusOpen') === '1'; } catch {}
    page.querySelector('.ap-status').hidden = !statusOpen; page.querySelector('[data-ap="status"]').setAttribute('aria-pressed', String(statusOpen));
    try { view = localStorage.getItem('hub.assistant.view') === 'memos' ? 'memos' : 'chat'; } catch {}
    setView(view); void memoView.refresh();
    document.getElementById('btn-assistant')?.classList.remove('assistant-has-unread');
    window.addEventListener('resize', onResize);
    // 后台预热助理会话：第一条难题交过去时不用再等它冷启动。不切换当前画面。
    void ipcRenderer.invoke('assistant:ensure-session').catch(() => {});
    try { await load(); } catch (error) { showMessage?.('助理记录读取失败：' + error.message); }
    page.querySelector('textarea').focus();
  }
  function close() {
    if (!page || page.hidden) return;
    page.hidden = true; document.body.classList.remove('assistant-page-open'); document.querySelector('.ap-menu')?.remove();
    window.removeEventListener('resize', onResize); onOpenChange(false);
  }
  document.addEventListener('click', e => { if (!e.target.closest('.ap-menu,[data-ap]')) document.querySelector('.ap-menu')?.remove(); if (page && !page.hidden && e.target.closest('#scene-rail button:not(#btn-assistant)')) close(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') document.querySelector('.ap-menu')?.remove(); });
  ipcRenderer.on('assistant:dialog', (_e, entry) => {
    if (!entry) return; entries.push(entry);
    if (page && !page.hidden) { if (entry.role === 'assistant') void paintStatus().catch(() => {}); if (entry.role !== 'user') void refreshDesk(); else render(); }
    else if (entry.role === 'assistant') document.getElementById('btn-assistant')?.classList.add('assistant-has-unread');
  });
  ipcRenderer.on('assistant:front-desk', (_e, current) => { frontDesk = current; paintHead(); });
  return { open, close, isOpen: () => !!page && !page.hidden, showMemos: () => { void open().then(() => setView('memos')); } };
}
module.exports = { createAssistantPage };
