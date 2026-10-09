'use strict';

// Reading preferences only. Runtime/submission truth remains owned by Main.
const preferences = new Map();
const colors = new Map();
let warned = false;
function read(key, fallback) {
  try { return typeof localStorage === 'undefined' ? fallback : JSON.parse(localStorage.getItem(key) || 'null') || fallback; }
  catch (error) { warn(error); return fallback; }
}
function warn(error) {
  if (!warned) { warned = true; console.warn('[groupchat-journal] reading preferences unavailable:', error.message); }
}
function save(key, value) {
  try { if (typeof localStorage !== 'undefined') localStorage.setItem(key, JSON.stringify(value)); }
  catch (error) { warn(error); }
}
function key(meeting, message) {
  // Keep manual disclosure through pending -> durable answer handoff.
  const act = message.committeeAct ? `${message.committeeAct}#${message.committeeRound || ''}` : '';
  return JSON.stringify([meeting.id, message.sid, message.sourceMessage || message.turnNum || message.id, act]);
}
// All new answers are readable immediately. Stored choices are explicit actions.
function preference(id, defaults = null) {
  if (!preferences.has(id)) {
    const stored=read('gc-journal:'+id, null);
    preferences.set(id, stored && typeof stored === 'object'
      ? {expanded:stored.expanded===true,minimized:stored.minimized===true}
      : {expanded:true,minimized:false});
  }
  return preferences.get(id);
}
function memberColor(meeting, sid) {
  const id = 'gc-journal-colors:'+meeting.id;
  if (!colors.has(id)) { const stored=read(id, []); colors.set(id,Array.isArray(stored)?stored.filter(x=>typeof x==='string'):[]); }
  const list = colors.get(id);
  if (!list.includes(sid)) { list.push(sid); save(id, list); }
  return list.indexOf(sid) % 8;
}
const paths = {
  fold:'<path d="m7 9 5-5 5 5M7 15l5 5 5-5"/>',
};
function icon(name) { return `<svg viewBox="0 0 24 24" aria-hidden="true">${paths[name]}</svg>`; }
function attributes(meeting, message, escapeHtml, { defaultMinimized = false } = {}) {
  const id = key(meeting,message), p = preference(id, { minimized: defaultMinimized });
  return `data-journal-key="${escapeHtml(id)}" data-journal-color="${memberColor(meeting,message.sid)}" data-journal-expanded="${!!p.expanded}" data-journal-minimized="${!!p.minimized}"`;
}
function actions({copy = '', prompt = '', attempt = '', resync = '', retry = '', submit = '', minimize = true}) {
  const secondary = '<button type="button" data-gc-multi-select>多选</button>' + prompt + retry;
  const diagnostic = attempt + resync;
  return `<div class="gc-journal-actions" data-copy-exclude>${copy.replace('📋','复制')}`
    + ((secondary || diagnostic) ? `<details class="gc-journal-menu"><summary aria-label="更多回答操作" title="更多回答操作">更多</summary><div class="gc-journal-menu-body">${secondary}${diagnostic ? `<div class="gc-journal-menu-label">运行诊断</div>${diagnostic}` : ''}</div></details>` : '')
    + submit + (minimize ? `<button type="button" class="gc-journal-minimize" data-journal-action="minimize" aria-label="折叠整张回答" title="折叠整张回答">${icon('fold')}</button>` : '') + '</div>';
}
function disclosure() { return '<button type="button" class="gc-journal-expand" data-copy-exclude data-journal-action="expand" aria-expanded="false" hidden>展开全文</button>'; }
function enhance(panel) {
  if (!panel) return;
  require('./message-disclosure-state').restore(panel);
  for (const article of panel.querySelectorAll('[data-journal-key]')) {
    const text = article.querySelector('.gc-journal-text');
    if (!text) continue;
    const p = preference(article.dataset.journalKey);
    article.dataset.journalExpanded = String(!!p.expanded);
    article.dataset.journalMinimized = String(!!p.minimized);
    // Apply visibility before measuring a restored card; a hidden text box is 0px.
    const long = text.scrollHeight > 260;
    article.classList.toggle('gc-journal-long', long);
    const expand = article.querySelector('.gc-journal-expand');
    if (expand) { expand.hidden = !long; expand.textContent = p.expanded ? '收起全文' : `长消息 · ${(text.textContent || '').length.toLocaleString('zh-CN')} 字 · 展开全文`; expand.setAttribute('aria-expanded',String(!!p.expanded)); }
    const minimize = article.querySelector('.gc-journal-minimize');
    if (minimize) { const label=p.minimized ? '展开回答卡片' : '折叠整张回答'; minimize.title=label; minimize.setAttribute('aria-label',label); minimize.setAttribute('aria-expanded',String(!p.minimized)); }
  }
  if (!panel.__journalBound) {
    panel.__journalBound = true;
    panel.addEventListener('click',event=>{
      if (event.target.closest('.gc-journal-menu-body button')) event.target.closest('.gc-journal-menu').open=false;
      for (const menu of panel.querySelectorAll('.gc-journal-menu[open]')) if(!menu.contains(event.target))menu.open=false;
    });
    panel.addEventListener('keydown',event=>{
      const menu=event.target.closest('.gc-journal-menu[open]');
      if(!menu)return;
      if(event.key==='Escape'){event.preventDefault();event.stopPropagation();menu.open=false;menu.querySelector('summary').focus();}
      if(['ArrowDown','ArrowUp'].includes(event.key)){
        event.preventDefault();const buttons=[...menu.querySelectorAll('button:not(:disabled)')];
        if(buttons.length)buttons[(buttons.indexOf(event.target)+(event.key==='ArrowDown'?1:-1)+buttons.length)%buttons.length].focus();
      }
    });
    panel.addEventListener('toggle',event=>{
      const menu=event.target;
      if(!menu.matches('.gc-journal-menu[open]'))return;
      const body=menu.querySelector('.gc-journal-menu-body'),r=menu.querySelector('summary').getBoundingClientRect();
      body.style.left=Math.max(8,Math.min(r.right-200,window.innerWidth-208))+'px';
      body.style.top=Math.max(8,Math.min(r.bottom+5,window.innerHeight-body.offsetHeight-8))+'px';
    },true);
    panel.addEventListener('focusin',event=>{
      const text=event.target.closest('.gc-journal-text'),article=text?.closest('[data-journal-key]');
      if(article?.dataset.journalExpanded==='false' && event.target.getBoundingClientRect().bottom>text.getBoundingClientRect().bottom){
        const p=preference(article.dataset.journalKey);p.expanded=true;save('gc-journal:'+article.dataset.journalKey,p);enhance(panel);
      }
    });
  }
}
function handle(event,panel) {
  if(event.target.closest('[data-journal-collapse-all]')){
    event.preventDefault();event.stopPropagation();
    const scroll=panel.querySelector('.mr-gc-messages');scroll?._cardFollowController?.pause();
    for(const article of panel.querySelectorAll('[data-journal-key]')){
      const p=preference(article.dataset.journalKey);p.expanded=false;p.minimized=false;save('gc-journal:'+article.dataset.journalKey,p);
    }
    enhance(panel);return true;
  }
  const button=event.target.closest('[data-journal-action]');
  if(!button || !panel.contains(button))return false;
  const article=button.closest('[data-journal-key]');
  if(!article)return false;
  event.preventDefault();event.stopPropagation();
  const scroll=panel.querySelector('.mr-gc-messages');
  // User chose to read this card. Stop follow-latest before changing its height.
  scroll?._cardFollowController?.pause();
  const before=article.getBoundingClientRect().top, oldTop=scroll?.scrollTop;
  const p=preference(article.dataset.journalKey);
  if(button.dataset.journalAction==='minimize')p.minimized=!p.minimized;
  else {p.expanded=!p.expanded;p.minimized=false;}
  save('gc-journal:'+article.dataset.journalKey,p);
  enhance(panel);
  if(scroll){scroll.scrollTop=oldTop+article.getBoundingClientRect().top-before;if(article.getBoundingClientRect().bottom<scroll.getBoundingClientRect().top+50)article.scrollIntoView({block:'start'});}
  return true;
}
module.exports={attributes,actions,disclosure,enhance,handle};
