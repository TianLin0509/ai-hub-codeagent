'use strict';
// 公司版「论坛」页（2026-10-18）：稼先社区、心声社区今天的热门帖子 + AI 摘要（core/company-forum/）。
// 布局：顶部状态（同步时间、下一次同步、刷新、设置）→「今日看点」（AI 写的 3–5 句，每句能点到依据的帖子）→ 两站并排的热帖列表，
// 每条：名次、标题（点开用系统浏览器打开原帖）、板块 · 阅读 · 回复 · 时间、一句话摘要。心声分「24小时点击 / 24小时回复」两个榜。
// 某个站没登录时，在它那一栏显示「登录」按钮（弹出 Hub 自己的浏览器窗口，登录一次以后自动同步）。
// 写法同助理页：盖在主区域上的一层，点左侧其他按钮自动关闭。左侧按钮只在公司版（gate.js）插入。
function createCompanyForumPage({ document, window, ipcRenderer, closeOtherPanels = () => {}, showMessage }) {
  let page = null, data = null, timer = null, panelOpen = false;
  const tab = {}; // 每个站当前看哪个榜
  const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const pad = n => String(n).padStart(2, '0');
  const clock = at => { const d = new Date(at); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
  const when = at => {
    if (!at) return '—';
    const d = new Date(at), t = new Date();
    if (d.toDateString() === t.toDateString()) return '今天 ' + clock(at);
    const y = new Date(t.getFullYear(), t.getMonth(), t.getDate() - 1), m = new Date(t.getFullYear(), t.getMonth(), t.getDate() + 1);
    if (d.toDateString() === y.toDateString()) return '昨天 ' + clock(at);
    if (d.toDateString() === m.toDateString()) return '明天 ' + clock(at);
    return `${d.getMonth() + 1}-${d.getDate()} ${clock(at)}`;
  };
  const num = n => n == null ? '' : n >= 10000 ? (n / 10000).toFixed(n >= 100000 ? 0 : 1) + '万' : String(n);
  const call = async (channel, payload) => { const r = await ipcRenderer.invoke('company-forum:' + channel, payload); if (r && r.ok === false) throw new Error(r.error || '操作未完成'); return r; };

  function nav() {
    let btn = document.getElementById('btn-company-forum');
    if (btn) return btn;
    const anchor = document.getElementById('btn-company-assistant') || document.getElementById('btn-rules') || document.getElementById('btn-home');
    if (!anchor) return null;
    btn = document.createElement('button');
    btn.type = 'button'; btn.className = 'btn-shell-nav'; btn.id = 'btn-company-forum';
    btn.title = '论坛 · 稼先社区、心声社区今天的热帖与摘要（数据只留本机）'; btn.setAttribute('aria-label', '论坛');
    btn.innerHTML = '<span class="btn-icon" aria-hidden="true"><svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 5.5h11a1.5 1.5 0 0 1 1.5 1.5v6a1.5 1.5 0 0 1-1.5 1.5H9l-3.5 3v-3H4A1.5 1.5 0 0 1 2.5 13V7A1.5 1.5 0 0 1 4 5.5z"/><path d="M19.5 9h.5A1.5 1.5 0 0 1 21.5 10.5v5A1.5 1.5 0 0 1 20 17h-1v2.5L16 17h-3.5"/><path d="M6.5 9.5h6M6.5 11.5h4"/></svg></span><span class="btn-label">论坛</span>';
    anchor.after(btn);
    btn.addEventListener('click', () => { void open(); });
    return btn;
  }

  function build() {
    if (page) return;
    page = document.createElement('section'); page.className = 'company-forum-page'; page.id = 'company-forum-page'; page.hidden = true; page.setAttribute('aria-label', '论坛');
    page.innerHTML = `<header class="cf-head">
        <div class="cf-title"><h1>论坛</h1><span class="cf-sub">今天的热帖</span></div>
        <div class="cf-status" data-slot="status"></div>
        <button type="button" class="cf-btn" data-cf="sync" title="现在重新打开两个站点取一次">刷新</button>
        <button type="button" class="cf-btn" data-cf="settings">设置</button>
      </header>
      <div class="cf-panel" data-slot="panel" hidden></div>
      <div class="cf-scroll"><div class="cf-body">
        <div data-slot="overview"></div>
        <div class="cf-grid" data-slot="sites"></div>
        <p class="cf-foot">数据只留在这台电脑 · 点标题用系统浏览器打开原帖 · 摘要由 CodeAgent 依据标题和正文摘录写成，每条都对过帖子出处</p>
      </div></div>`;
    document.body.append(page);
    page.addEventListener('click', event => {
      const b = event.target.closest('[data-cf]');
      if (b) { event.preventDefault(); void action(b.dataset.cf, b).catch(e => showMessage?.(e.message)); }
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

  function statusHtml() {
    const d = data, snap = d.snapshot, chips = [];
    if (d.syncing) chips.push(`<span class="cf-chip run">${esc(d.progress || '正在同步…')}</span>`);
    else if (snap) chips.push(`<span class="cf-chip">${d.today ? '同步于 ' : '上次同步 '}${when(snap.at)}</span>`);
    else chips.push('<span class="cf-chip">还没同步过</span>');
    if (snap?.summarizing || d.job) chips.push('<span class="cf-chip run">AI 正在写摘要</span>');
    chips.push('<span class="cf-sp"></span>');
    chips.push(`<span class="cf-chip">下一次同步：${d.settings.enabled ? when(d.nextSyncAt) : '已关闭自动同步'}</span>`);
    return chips.join('');
  }
  const postKey = (site, title) => site + '|' + title;
  function overviewHtml() {
    const snap = data.snapshot;
    if (!snap) return `<article class="cf-overview empty">${data.syncing ? '正在打开两个站点取今天的热帖，第一次大约需要一分钟。' : data.domain ? '今天还没同步。点右上角「刷新」开始。' : '先在「设置」里填一次公司站点的域名（一般就是公司邮箱 @ 后面那段）。'}</article>`;
    const items = (snap.overview || []).map(o => `<li>${esc(o.text)}${(o.refs || []).map(r => `<button type="button" class="cf-ref" data-cf="jump" data-key="${esc(postKey(r.site, r.title))}" title="${esc(r.title)}">${esc(refLabel(r))}</button>`).join('')}</li>`).join('');
    const note = snap.summaryNote && !snap.summarizing ? `<p class="cf-note">${esc(snap.summaryNote)}</p>` : '';
    const redo = !snap.summarizing && !data.job && (snap.picked || []).length ? '<button type="button" class="cf-link" data-cf="summarize">重新整理</button>' : '';
    return `<article class="cf-overview"><div class="cf-ov-head"><b>今日看点</b>${snap.summaryAt ? `<span class="cf-time">AI 整理于 ${when(snap.summaryAt)}</span>` : ''}<span class="cf-sp"></span>${redo}</div>
      ${items ? `<ol>${items}</ol>` : snap.summarizing ? '<p class="cf-note run">AI 正在读帖子、写看点…</p>' : '<p class="cf-note">还没有 AI 看点。</p>'}${note}</article>`;
  }
  function siteShort(id) { return (data.sites.find(s => s.id === id) || {}).short || id; }
  // 出处标签：「稼先 1」= 稼先热点第 1 名；心声在回复榜的写「心声回复 3」。
  function refLabel(r) {
    const entry = data.snapshot?.sites?.find(s => s.id === r.site);
    const lists = entry?.lists || [];
    const i = lists.findIndex(l => l.posts.some(p => p.title === r.title));
    const post = i >= 0 ? lists[i].posts.find(p => p.title === r.title) : null;
    return siteShort(r.site) + (i > 0 ? lists[i].label.replace(/^24小时/, '') : '') + (post ? ' ' + post.rank : '');
  }
  function siteHtml(site) {
    const snap = data.snapshot, entry = snap?.sites?.find(x => x.id === site.id);
    const lists = entry?.lists || [];
    const cur = lists.find(l => l.key === tab[site.id]) || lists.find(l => l.posts.length) || lists[0];
    const tabs = lists.length > 1 ? `<div class="cf-tabs" role="tablist">${lists.map(l => `<button type="button" role="tab" class="cf-tab${l === cur ? ' on' : ''}" data-cf="tab" data-site="${site.id}" data-list="${l.key}">${esc(l.label)}<span>${l.posts.length || ''}</span></button>`).join('')}</div>` : lists[0] ? `<span class="cf-list-label">${esc(lists[0].label)}</span>` : '';
    let body = '';
    if (!entry) body = `<p class="cf-note">${data.syncing ? '正在取…' : '还没同步。'}</p>`;
    else if (entry.needsLogin) {
      const waiting = site.login === 'waiting';
      body = `<div class="cf-login"><p>${esc(entry.error)}</p><button type="button" class="cf-btn primary" data-cf="login" data-site="${site.id}"${waiting ? ' disabled' : ''}>${waiting ? '登录窗口已打开…' : '登录' + esc(site.name)}</button></div>`;
    } else if (!entry.ok) body = `<p class="cf-note bad">${esc(entry.error || '没取到')}</p>`;
    else body = `<ol class="cf-posts">${(cur?.posts || []).map(p => postHtml(site, p)).join('')}</ol>`;
    return `<section class="cf-site" data-site="${site.id}"><div class="cf-site-head"><b>${esc(site.name)}</b>${tabs}<span class="cf-sp"></span>${entry?.at ? `<span class="cf-time">${when(entry.at)}</span>` : ''}</div>${body}</section>`;
  }
  function postHtml(site, p) {
    const meta = [p.board, p.views != null ? '阅读 ' + num(p.views) : '', p.replies != null ? '回复 ' + num(p.replies) : '', p.likes != null ? '赞 ' + num(p.likes) : '', p.author, p.time ? when(p.time) : ''].filter(Boolean).map(esc).join(' · ');
    const title = p.url ? `<a href="#" class="cf-post-title" data-cf="open" data-url="${esc(p.url)}" title="用系统浏览器打开原帖">${esc(p.title)}</a>` : `<span class="cf-post-title plain" title="没取到帖子链接">${esc(p.title)}</span>`;
    return `<li class="cf-post" data-key="${esc(postKey(site.id, p.title))}"><span class="cf-rank${p.rank <= 3 ? ' top' : ''}">${p.rank}</span><div class="cf-post-main">${title}${meta ? `<div class="cf-meta">${meta}</div>` : ''}${p.summary ? `<div class="cf-sum">${esc(p.summary)}</div>` : ''}</div></li>`;
  }
  function panelHtml() {
    const s = data.settings;
    const from = { settings: '设置里填的', email: '取自你的公司邮箱' }[data.domainFrom] || '还不知道';
    return `<div class="cf-set"><b>论坛设置</b>
      <label>公司站点域名 <input data-f="domain" value="${esc(s.domain || data.domain || '')}" placeholder="例如 corp.example.com"><span class="cf-note">当前：${esc(data.domain || '—')}（${from}）。两个站点是 jx.域名 和 xinsheng.域名。</span></label>
      <label><input type="checkbox" data-f="enabled"${s.enabled ? ' checked' : ''}> 工作日自动同步，时间 <input type="time" data-f="syncTime" value="${esc(s.syncTime)}"></label>
      <label>每个榜取 <input type="number" min="5" max="30" data-f="perList" value="${s.perList}"> 条，AI 摘要写前 <input type="number" min="0" max="20" data-f="summarize" value="${s.summarize}"> 条</label>
      <div class="cf-row"><button type="button" class="cf-btn primary" data-cf="save">保存</button><button type="button" class="cf-btn" data-cf="close-panel">取消</button><span class="cf-sp"></span><button type="button" class="cf-link" data-cf="open-session">打开整理会话</button><button type="button" class="cf-link" data-cf="clear-login" title="清掉 Hub 论坛窗口里的登录状态">退出论坛登录</button></div></div>`;
  }
  function render() {
    if (!page || !data) return;
    page.querySelector('[data-slot="status"]').innerHTML = statusHtml();
    page.querySelector('[data-slot="overview"]').innerHTML = overviewHtml();
    page.querySelector('[data-slot="sites"]').innerHTML = data.sites.map(siteHtml).join('');
    const panel = page.querySelector('[data-slot="panel"]');
    if (panelOpen && !panel.dataset.open) { panel.innerHTML = panelHtml(); panel.dataset.open = '1'; }
    panel.hidden = !panelOpen;
    if (!panelOpen) { panel.innerHTML = ''; panel.dataset.open = ''; }
    page.querySelector('[data-cf="sync"]').disabled = !!data.syncing;
  }
  async function load() { data = await call('status'); render(); return data; }

  async function action(name, el) {
    if (name === 'sync') { el.disabled = true; data = { ...data, syncing: true, progress: '正在同步…' }; render(); await call('sync'); await load(); return; }
    if (name === 'settings') { panelOpen = !panelOpen; render(); return; }
    if (name === 'close-panel') { panelOpen = false; render(); return; }
    if (name === 'save') {
      const panel = page.querySelector('[data-slot="panel"]'), v = k => panel.querySelector(`[data-f="${k}"]`);
      await call('set-settings', { domain: v('domain').value, enabled: v('enabled').checked, syncTime: v('syncTime').value, perList: Number(v('perList').value), summarize: Number(v('summarize').value) });
      panelOpen = false; await load(); showMessage?.('论坛设置已保存');
      if (data.domain && !data.today && !data.syncing) void call('ensure-today').then(load).catch(() => {});
      return;
    }
    if (name === 'tab') { tab[el.dataset.site] = el.dataset.list; render(); return; }
    if (name === 'open') { await call('open-url', { url: el.dataset.url }); return; }
    if (name === 'login') { el.disabled = true; await call('login', { site: el.dataset.site }); await load(); return; }
    if (name === 'summarize') { await call('summarize'); await load(); return; }
    if (name === 'jump') {
      const li = [...page.querySelectorAll('.cf-post')].find(x => x.dataset.key === el.dataset.key);
      if (!li) { // 在另一个榜里：切过去再找
        const [site] = el.dataset.key.split('|');
        const list = data.snapshot?.sites?.find(s => s.id === site)?.lists.find(l => l.posts.some(p => postKey(site, p.title) === el.dataset.key));
        if (list) { tab[site] = list.key; render(); }
      }
      const target = [...page.querySelectorAll('.cf-post')].find(x => x.dataset.key === el.dataset.key);
      if (target) { target.scrollIntoView({ block: 'center', behavior: 'smooth' }); target.classList.add('flash'); setTimeout(() => target.classList.remove('flash'), 1600); }
      return;
    }
    if (name === 'open-session') { const r = await call('open-session'); window.__hubOpenSession?.(r.sessionId); close(); return; }
    if (name === 'clear-login') { await call('clear-login'); showMessage?.('已退出论坛登录，下次同步时会提示重新登录'); }
  }

  const onResize = () => place();
  async function open() {
    build(); closeOtherPanels(); window.__assistantHide?.(); window.__wirelessHide?.(); window.__companyAssistantHide?.(); window.setShellNavActive?.('company-forum');
    page.hidden = false; document.body.classList.add('company-forum-page-open'); place();
    nav()?.classList.add('active');
    window.addEventListener('resize', onResize);
    clearInterval(timer); timer = setInterval(() => { void load().catch(() => {}); }, 15000);
    try { data = await call('ensure-today'); render(); } catch (error) { showMessage?.('论坛状态读取失败：' + error.message); }
  }
  function close() {
    if (!page || page.hidden) return;
    page.hidden = true; document.body.classList.remove('company-forum-page-open');
    document.getElementById('btn-company-forum')?.classList.remove('active');
    clearInterval(timer); timer = null; window.removeEventListener('resize', onResize);
  }
  nav();
  document.addEventListener('click', e => { if (page && !page.hidden && e.target.closest('#scene-rail button:not(#btn-company-forum)')) close(); });
  ipcRenderer.on('company-forum:changed', () => { if (page && !page.hidden) void load().catch(() => {}); });
  return { open, close, isOpen: () => !!page && !page.hidden };
}
module.exports = { createCompanyForumPage };
