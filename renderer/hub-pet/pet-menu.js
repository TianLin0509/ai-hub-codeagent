'use strict';
// 桌宠右键菜单的渲染端（2026-10-17，替换系统原生菜单）。内容由主进程推来（hub-pet-menu:state），
// 点了什么回报给主进程（hub-pet-menu:act），由主进程执行并决定是否关菜单。
(function () {
  const api = window.hubPetMenu;
  const $ = id => document.getElementById(id);
  const card = $('card');
  // 线性小图标（16px，描边 1.6），不用表情符号和彩色图标，免得喧宾夺主。
  const P = {
    calendar: '<rect x="3" y="4.5" width="14" height="12" rx="2"/><path d="M3 8.5h14M7 2.8v3.4M13 2.8v3.4"/>',
    prep: '<path d="M6 3.5h8a1.5 1.5 0 0 1 1.5 1.5v11A1.5 1.5 0 0 1 14 17.5H6A1.5 1.5 0 0 1 4.5 16V5A1.5 1.5 0 0 1 6 3.5z"/><path d="M7.5 8h5M7.5 11h5M7.5 14h3"/>',
    reply: '<path d="M4 5.5A1.5 1.5 0 0 1 5.5 4h9A1.5 1.5 0 0 1 16 5.5v6a1.5 1.5 0 0 1-1.5 1.5H9l-3.5 3v-3h0A1.5 1.5 0 0 1 4 11.5z"/>',
    group: '<circle cx="7.5" cy="7.5" r="2.5"/><circle cx="13.5" cy="8.5" r="2"/><path d="M3 16c.6-2.6 2.4-4 4.5-4s3.9 1.4 4.5 4M12 12.3c2-.3 3.8.9 4.5 3.2"/>',
    mail: '<rect x="3" y="5" width="14" height="10.5" rx="1.8"/><path d="M3.5 6l6.5 5 6.5-5"/>',
    report: '<path d="M5 3.5h7l3.5 3.5v9.5A1.5 1.5 0 0 1 14 18H5a1.5 1.5 0 0 1-1.5-1.5V5A1.5 1.5 0 0 1 5 3.5z"/><path d="M12 3.5V7h3.5M7 11.5h6M7 14.5h4"/>',
    moon: '<path d="M15.5 12.5A6 6 0 0 1 7.5 4.5a6 6 0 1 0 8 8z"/>',
    mute: '<path d="M4 8v4h3l4 3.5v-11L7 8z"/><path d="M14 8l3.5 4M17.5 8L14 12"/>',
    gear: '<circle cx="10" cy="10" r="2.6"/><path d="M10 2.8v2M10 15.2v2M2.8 10h2M15.2 10h2M4.9 4.9l1.4 1.4M13.7 13.7l1.4 1.4M4.9 15.1l1.4-1.4M13.7 6.3l1.4-1.4"/>',
    hide: '<path d="M3 10s2.6-5 7-5 7 5 7 5-2.6 5-7 5-7-5-7-5z"/><path d="M4 16L16 4"/>',
  };
  const ACTION_ICON = { 'meetings-today': 'calendar', 'meeting-prep': 'prep', 'awaiting-reply': 'reply', 'group-summary': 'group', 'mail-triage': 'mail', 'weekly-report': 'report' };
  const svg = name => '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">' + (P[name] || '') + '</svg>';
  document.querySelectorAll('[data-i]').forEach(el => { el.innerHTML = svg(el.getAttribute('data-i')); });

  let state = null;

  function button(cls, html, onClick, attrs = {}) {
    const b = document.createElement('button');
    b.type = 'button'; b.className = cls; b.innerHTML = html;
    for (const [k, v] of Object.entries(attrs)) b.setAttribute(k, v);
    b.addEventListener('click', onClick);
    return b;
  }
  const text = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function render(s) {
    state = s;
    $('avatar').src = s.role.preview || '';
    $('name').textContent = s.role.name || '桌宠';
    $('status').textContent = s.status || '';
    const actions = $('actions'); actions.textContent = '';
    for (const a of s.actions || []) actions.appendChild(button('item', '<span class="ico">' + svg(ACTION_ICON[a.action] || 'reply') + '</span><span class="txt">' + text(a.label) + '</span>', () => api.act({ type: 'action', action: a.action }), { role: 'menuitem' }));
    const modes = $('modes'); modes.textContent = '';
    for (const m of s.modes || []) modes.appendChild(button(m.id === s.mode ? 'on' : '', text(m.label), () => api.act({ type: 'mode', mode: m.id }), { role: 'radio', 'aria-checked': String(m.id === s.mode), title: m.hint || '' }));
    $('quiet-hour').classList.toggle('on', !!s.quietHour);
    $('quiet-hour').setAttribute('aria-checked', String(!!s.quietHour));
    $('quiet-hour').querySelector('.txt').textContent = s.quietHour && s.quietUntilText ? '安静到 ' + s.quietUntilText : '安静一小时';
    $('silent-today').classList.toggle('on', !!s.silentToday);
    $('silent-today').setAttribute('aria-checked', String(!!s.silentToday));
    const roles = $('roles'); roles.textContent = '';
    for (const r of s.roles || []) {
      const b = button(r.id === s.role.id ? 'on' : '', '<img alt="">', () => api.act({ type: 'role', role: r.id }), { title: r.name, 'aria-label': '换成' + r.name });
      b.querySelector('img').src = r.preview || '';
      roles.appendChild(b);
    }
    if (s.moreRoles) roles.appendChild(button('more', '更多形象 ›', () => api.act({ type: 'settings', tab: 'pet' }), { title: '在助理设置里下载更多形象' }));
    requestAnimationFrame(() => api.size({ width: Math.ceil(document.body.scrollWidth), height: Math.ceil(card.getBoundingClientRect().bottom + 18) }));
  }

  $('quiet-hour').addEventListener('click', () => api.act({ type: 'quietHour', value: !(state && state.quietHour) }));
  $('silent-today').addEventListener('click', () => api.act({ type: 'silentToday', value: !(state && state.silentToday) }));
  $('open-settings').addEventListener('click', () => api.act({ type: 'settings', tab: 'pet' }));
  $('hide-pet').addEventListener('click', () => api.act({ type: 'hide' }));
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') { api.act({ type: 'close' }); return; }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const items = [...document.querySelectorAll('.item, .seg button, .roles button')];
    const i = items.indexOf(document.activeElement);
    const next = items[(i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length];
    if (next) { next.focus(); e.preventDefault(); }
  });

  api.onState(s => { render(s); });
  api.onOpen(origin => {
    card.style.setProperty('--ox', origin && origin.right ? '100%' : '0');
    card.style.setProperty('--oy', origin && origin.up ? '100%' : '0');
    card.classList.remove('in'); void card.offsetWidth; card.classList.add('in');
  });
  window.__hubPetMenuDebug = () => ({ state, height: card.getBoundingClientRect().height, items: document.querySelectorAll('.item').length });
  api.ready();
})();
