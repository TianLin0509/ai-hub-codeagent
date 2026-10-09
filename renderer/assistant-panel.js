'use strict';

// An entry into the ordinary session surface. No composer, transcript reader,
// model controls or terminal writer is owned by the assistant navigation.
function createAssistantPanel({ document, ipcRenderer, getSession, getActiveSessionId,
  openSession, closeOtherPanels = () => {}, showMessage }) {
  const nav = document.getElementById('btn-assistant');
  let epoch = 0, opening = null, overview = null, sequence = 0, switching = false;
  // 左侧「助理」打开助理页（用户与助理的对话）；助理会话本身是工作台里的普通会话，从助理页「打开助理会话」进入。
  const page = require('./assistant-page').createAssistantPage({ document, window: document.defaultView, ipcRenderer, showMessage, closeOtherPanels,
    openSession: () => open(),
    onOpenChange: on => { if (on) document.defaultView.setShellNavActive?.('assistant'); setClass(nav, 'active', on || document.body.classList.contains('assistant-session-active')); if (on) nav.setAttribute('aria-current', 'page'); else if (!document.body.classList.contains('assistant-session-active')) nav.removeAttribute('aria-current'); } });
  const setClass = (element, name, value) => { if (element.classList.contains(name) !== value) element.classList.toggle(name, value); };
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const isOpen = () => document.body.classList.contains('assistant-session-active')
    && getSession(getActiveSessionId())?.purpose === 'hub-assistant';
  async function call(channel, args) {
    const result = await ipcRenderer.invoke(channel, args);
    if (!result || result.ok === false) throw new Error(result?.error || '助理暂未连接');
    return result;
  }
  function badge() {
    nav.classList.toggle('assistant-has-unread', !!overview?.unreadCount);
    nav.title = overview?.unreadCount ? `助理 · ${overview.unreadCount} 条关注任务新回复` : '助理 · 进展与下一步';
  }
  function paintNotices() {
    const host = document.querySelector('.assistant-notifications');
    if (!host) return;
    host.querySelector('summary').textContent = overview?.unreadCount ? `新回复 ${overview.unreadCount}` : '关注回复';
    host.querySelector('.assistant-notice-list').innerHTML = (overview?.notifications || []).map(n =>
      `<article><strong>${esc(n.title)}</strong><p>${esc(n.text)}</p><small>${esc(n.source?.ref)}</small>${n.readAt ? '' : `<button type="button" data-assistant-read="${esc(n.id)}">标为已读</button>`}</article>`).join('') || '<p>明确说“有新回复时提醒我”，助理会关注对应任务。</p>';
  }
  async function refresh() {
    const ticket = ++sequence;
    try {
      const result = await call('assistant:get-overview');
      if (ticket !== sequence) return;
      overview = result; badge(); paintNotices();
    } catch (error) { if (isOpen()) showMessage?.(`助理动态暂未同步：${error.message}`); }
  }
  // 手机消息的回答方式：快速回答（API 前台，默认）或全部交给助理会话（CLI）。与手机端同一份设置。
  function paintFrontDesk(button, current) {
    if (!button || !current) return;
    button.dataset.mode = current.mode; button.dataset.model = current.model;
    button.textContent = current.label + ' ▾';
  }
  function frontDeskPicker() {
    const button = document.createElement('button'); button.type = 'button'; button.className = 'assistant-backend assistant-frontdesk';
    button.setAttribute('aria-label', '手机消息回答方式');
    button.title = '手机消息怎么回答：快速回答由 API 前台当场答，难题自动交给助理会话；也可以全部交给助理会话';
    void ipcRenderer.invoke('assistant:front-desk').then(r => paintFrontDesk(button, r?.current)).catch(() => {});
    button.addEventListener('click', async event => {
      event.stopPropagation();
      const old = document.querySelector('.assistant-backend-menu'); if (old) { old.remove(); if (old.classList.contains('assistant-frontdesk-menu')) return; }
      const info = await ipcRenderer.invoke('assistant:front-desk'); if (!info?.current) return;
      const {current, modes, models} = info, mark = on => on ? ' ✓' : '';
      const api = modes.find(m => m.id === 'api'), cli = modes.find(m => m.id === 'cli');
      const menu = document.createElement('div'); menu.className = 'assistant-backend-menu assistant-frontdesk-menu'; menu.setAttribute('role', 'menu');
      menu.innerHTML = `<div class="assistant-menu-title">手机消息怎么回答</div><div class="assistant-menu-caption">${esc(api.label)}</div>`
        + models.map(m => `<button type="button" data-front-mode="api" data-front-model="${esc(m.id)}">${esc(m.label)}${mark(current.mode === 'api' && current.model === m.id)}</button>`).join('')
        + `<div class="assistant-menu-caption">${esc(cli.label)}</div>`
        + `<button type="button" data-front-mode="cli">全部交给助理会话${mark(current.mode === 'cli')}</button>`
        + `<p class="assistant-menu-hint">${esc(current.mode === 'cli' ? cli.hint : api.hint)}</p>`;
      const rect = button.getBoundingClientRect(); menu.style.left = rect.left + 'px'; menu.style.top = rect.bottom + 6 + 'px';
      menu.addEventListener('click', async e => {
        const choice = e.target.closest('[data-front-mode]'); if (!choice) return;
        menu.remove();
        const r = await ipcRenderer.invoke('assistant:set-front-desk', {mode: choice.dataset.frontMode, ...(choice.dataset.frontModel ? {model: choice.dataset.frontModel} : {})});
        if (r?.ok) paintFrontDesk(button, r.frontDesk); else showMessage?.(r?.error || '回答方式未切换');
      });
      document.body.append(menu); menu.querySelector('button')?.focus();
    });
    return button;
  }
  function syncSession(session) {
    const active = session?.purpose === 'hub-assistant';
    setClass(document.body, 'assistant-session-active', active);
    setClass(document.getElementById('terminal-panel'), 'assistant-session', active);
    // 助理页开着时「助理」保持选中（后台预热助理会话会触发这里）。
    const selected = active || page.isOpen();
    setClass(nav, 'active', selected);
    if (selected) nav.setAttribute('aria-current', 'page'); else nav.removeAttribute('aria-current');
    const tools = document.getElementById('toolbar-actions');
    let picker = tools?.querySelector('.assistant-backend:not(.assistant-frontdesk)');
    if (active && tools && !picker) {
      picker = document.createElement('button'); picker.type='button'; picker.className = 'assistant-backend';
      picker.setAttribute('aria-label', '助理 AI 后端');
      picker.title = '切换助理后端；各自历史分别保留，共用工作档案和交接记录';
      picker.addEventListener('click', event => {
        event.stopPropagation();
        const old=document.querySelector('.assistant-backend-menu');if(old){old.remove();return;}
        const menu=document.createElement('div');menu.className='assistant-backend-menu';
        menu.setAttribute('role','menu');
        const {BACKENDS,getKindLabel}=require('../core/hub-assistant/backends');
        menu.innerHTML=BACKENDS.map(kind=>`<button type="button" data-assistant-backend="${esc(kind)}">${esc(getKindLabel(kind))}</button>`).join('');
        const rect=picker.getBoundingClientRect();menu.style.left=rect.left+'px';menu.style.top=rect.bottom+6+'px';
        menu.addEventListener('click', event=>{const choice=event.target.closest('[data-assistant-backend]');if(choice){menu.remove();void switchBackend(choice.dataset.assistantBackend);}});
        document.body.append(menu);
        menu.querySelector('button')?.focus();
      });
      tools.prepend(picker);
    }
    if (picker && active) { picker.dataset.kind = session.kind; picker.textContent = require('../core/ai-kinds').getKindLabel(session.kind)+' ▾'; picker.disabled = switching; }
    if (active && tools && !tools.querySelector('.assistant-frontdesk')) tools.prepend(frontDeskPicker());
    if (!active || !tools || tools.querySelector('.assistant-notifications')) return;
    const notices = document.createElement('details'); notices.className = 'assistant-notifications';
    notices.innerHTML = '<summary>关注回复</summary><div class="assistant-notice-list"></div>';
    notices.addEventListener('toggle', () => { if (notices.open) void refresh(); });
    notices.addEventListener('click', event => {
      const read = event.target.closest('[data-assistant-read]');
      if (read) void call('assistant:mark-notification-read', {id:read.dataset.assistantRead}).then(refresh).catch(error => showMessage?.(error.message));
    });
    const dossier = document.createElement('button'); dossier.type = 'button'; dossier.className = 'btn-zoom assistant-workbench';
    dossier.textContent = '工作档案'; dossier.title = '打开助理的 Markdown 工作档案';
    dossier.addEventListener('click', () => { void call('assistant:open-workbench').catch(error => showMessage?.(error.message)); });
    const phone = document.createElement('button'); phone.type='button'; phone.className='btn-zoom assistant-phone'; phone.textContent='手机连接'; phone.title='文字、图片和语音消息';
    phone.addEventListener('click',()=>require('./assistant-phone').openPhone({document,ipcRenderer}));
    // 手动换班：让当前助理写交接，再换一个干净的新会话（平时由 Hub 在你空闲时自动进行）。
    const fresh = document.createElement('button'); fresh.type='button'; fresh.className='btn-zoom assistant-rotate'; fresh.textContent='新开助理';
    fresh.title='让助理写好交接后换一个新会话：回答更快，旧会话保留可查。平时在你空闲约 2 小时或上下文过长时自动进行。';
    fresh.addEventListener('click',async()=>{fresh.disabled=true;fresh.textContent='交接中…';try{const r=await call('assistant:rotate-now');if(r&&r.ok===false)throw new Error(r.error||'未能新开');showMessage?.('已换成新的助理会话，旧会话保留为「已换班」。');}catch(error){showMessage?.(`新开助理未完成：${error.message}`);}finally{fresh.disabled=false;fresh.textContent='新开助理';}});
    const memory = document.createElement('button'); memory.type='button'; memory.className='btn-zoom assistant-memory'; memory.textContent='助理记忆';
    memory.title='打开助理积累的偏好（USER.md）；同目录的 MEMORY.md 是长期记忆，CHANGES.md 是每次修改记录。可以直接编辑。';
    memory.addEventListener('click',()=>{void call('assistant:open-memory').catch(error=>showMessage?.(error.message));});
    tools.prepend(notices, dossier, memory, phone, fresh); paintNotices();
  }
  function close() {
    epoch++; document.querySelector('.assistant-backend-menu')?.remove(); page.close();
    setClass(document.body, 'assistant-session-active', false);
    setClass(document.getElementById('terminal-panel'), 'assistant-session', false);
    setClass(nav, 'active', false); nav.removeAttribute('aria-current');
  }
  async function switchBackend(kind) {
    if (opening || switching) return;
    const ticket = ++epoch;
    switching = true;
    const picker = document.querySelector('.assistant-backend:not(.assistant-frontdesk)');
    if (picker) { picker.disabled = true; picker.setAttribute('aria-busy','true'); }
    const label = nav.querySelector('.btn-label'); label.textContent = '切换中…';
    try {
      const result = await call('assistant:switch-backend', {kind});
      if (ticket !== epoch) return;
      closeOtherPanels(); await openSession(result.sessionId, result.session); await refresh();
    } catch (error) { showMessage?.(`助理后端未切换：${error.message}`); }
    finally {
      switching = false; label.textContent = '助理';
      if (picker) picker.removeAttribute('aria-busy');
      const displayed = document.querySelector('.assistant-backend:not(.assistant-frontdesk)');
      if (displayed) { displayed.disabled=false; displayed.removeAttribute('aria-busy'); }
      // Native selectSession also advances the navigation epoch. Refresh only
      // when the assistant surface is still visible, using the new toolbar.
      if (isOpen()) syncSession(getSession(getActiveSessionId()));
    }
  }
  async function open() {
    if (switching) return;
    if (opening) return opening;
    const ticket = ++epoch;
    nav.disabled = true; nav.setAttribute('aria-busy', 'true');
    const label = nav.querySelector('.btn-label'); label.textContent = '连接中…';
    opening = (async () => {
      try {
        const result = await call('assistant:ensure-session');
        if (ticket !== epoch) return;
        closeOtherPanels();
        await openSession(result.sessionId, result.session);
        void refresh();
      } catch (error) { if (ticket === epoch) showMessage?.(`助理尚未打开：${error.message}`); }
      finally { nav.disabled = false; nav.removeAttribute('aria-busy'); label.textContent = '助理'; opening = null; }
    })();
    return opening;
  }
  nav.addEventListener('click', () => { void page.open(); });
  document.addEventListener('click', event => { if(!event.target.closest('.assistant-backend-menu,.assistant-backend'))document.querySelector('.assistant-backend-menu')?.remove();if (event.target.closest('#scene-rail button:not(#btn-assistant)')) close(); });
  document.addEventListener('keydown',event=>{if(event.key==='Escape')document.querySelector('.assistant-backend-menu')?.remove();});
  // 助理换班后（上下文用满后新开会话接续），若正停在助理页就切到新会话。
  ipcRenderer.on('assistant:front-desk', (_event, current) => paintFrontDesk(document.querySelector('.assistant-frontdesk'), current));
  ipcRenderer.on('assistant:rotated', () => { if (isOpen()) void open(); else void refresh(); });
  ipcRenderer.on('assistant:notification', (_event, notice) => {
    nav.classList.add('assistant-has-unread'); nav.title = '助理 · 关注任务有新回复';
    if (notice?.kind === 'reminder') showMessage?.(notice.text);
    else if (notice?.text) showMessage?.(`${notice.title || '关注任务'}有新回复，可在助理页查看。`);
    if (isOpen()) void refresh();
  });
  return { open, close, refresh, syncSession, isOpen, switchBackend, openPage: () => page.open(), isPageOpen: () => page.isOpen() };
}
module.exports = { createAssistantPanel };
