'use strict';
// 公司版「助理」页（2026-10-16 选定设计 B：简报 + 对话）。页面就是和助理会话的对话：
// 今天第一条是简报（默认收起成要点，点开看全文，每条带出处），下面是问答；输入框上方一排常用问题小标签。
// 顶部状态：WeLink 登录（过期时扫码）、日历初始化、数据只留本机、下一份简报时间。
// 写法同无线页：盖在主区域上的一层，点左侧其他按钮自动关闭。左侧按钮只在公司版（gate.js）插入。
function createCompanyAssistantPage({ document, window, ipcRenderer, openSession, closeOtherPanels = () => {}, showMessage }) {
  let page = null, data = null, timer = null, briefOpen = false, sending = false;
  const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const pad = n => String(n).padStart(2, '0');
  const clock = at => { if (!at) return '—'; const d = new Date(at); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
  const when = at => {
    if (!at) return '';
    const d = new Date(at), t = new Date();
    if (d.toDateString() === t.toDateString()) return clock(at);
    const tomorrow = new Date(t.getFullYear(), t.getMonth(), t.getDate() + 1);
    if (d.toDateString() === tomorrow.toDateString()) return '明天 ' + clock(at);
    return `${d.getMonth() + 1}-${d.getDate()} ${clock(at)}`;
  };
  const call = async (channel, payload) => { const r = await ipcRenderer.invoke('company-assistant:' + channel, payload); if (r && r.ok === false) throw new Error(r.error || '操作未完成'); return r; };
  let md = null;
  const markdown = text => {
    try {
      if (!md) md = { marked: require('marked').marked, purify: require('dompurify') };
      return md.purify.sanitize(md.marked.parse(String(text || ''), { breaks: true, gfm: true }));
    } catch { return esc(text).replace(/\n/g, '<br>'); }
  };

  function nav() {
    let btn = document.getElementById('btn-company-assistant');
    if (btn) return btn;
    const anchor = document.getElementById('btn-rules') || document.getElementById('btn-home');
    if (!anchor) return null;
    btn = document.createElement('button');
    btn.type = 'button'; btn.className = 'btn-shell-nav'; btn.id = 'btn-company-assistant';
    btn.title = '助理 · 每日简报与对话（只读 WeLink，数据只留本机）'; btn.setAttribute('aria-label', '助理');
    btn.innerHTML = '<span class="btn-icon" aria-hidden="true"><img src="assets/assistant/penguin.png" alt="" /></span><span class="btn-label">助理</span>';
    anchor.after(btn);
    btn.addEventListener('click', () => { void open(); });
    return btn;
  }

  function build() {
    if (page) return;
    page = document.createElement('section'); page.className = 'company-assistant-page'; page.id = 'company-assistant-page'; page.hidden = true; page.setAttribute('aria-label', '助理');
    page.innerHTML = `<header class="ca-head">
        <div class="ca-title"><h1>助理</h1></div>
        <div class="ca-status" aria-label="状态"></div>
        <button type="button" class="ca-btn" data-ca="refresh" title="重新从 WeLink 取一次数据">刷新数据</button>
        <button type="button" class="ca-btn" data-ca="settings">设置</button>
      </header>
      <div class="ca-panel" data-slot="panel" hidden></div>
      <div class="ca-scroll"><div class="ca-convo">
        <div data-slot="brief"></div>
        <div data-slot="notices"></div>
        <div data-slot="chat"></div>
      </div></div>
      <footer class="ca-foot">
        <div class="ca-chips" data-slot="chips"></div>
        <form class="ca-input" data-slot="form">
          <textarea rows="2" placeholder="问助理任何事，例如「把某个群今天的讨论整理成三点」（Enter 发送，Shift+Enter 换行）" aria-label="问助理"></textarea>
          <button type="submit" class="ca-btn primary">发送</button>
        </form>
        <div class="ca-foot-note"><span data-slot="job"></span><button type="button" class="ca-link" data-ca="open-session">打开会话</button></div>
      </footer>`;
    document.body.append(page);
    page.addEventListener('click', event => {
      const b = event.target.closest('[data-ca]');
      if (b) { event.preventDefault(); void action(b.dataset.ca, b).catch(e => showMessage?.(e.message)); }
    });
    const form = page.querySelector('[data-slot="form"]'), input = form.querySelector('textarea');
    form.addEventListener('submit', e => { e.preventDefault(); void send(input.value); });
    input.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); void send(input.value); } });
  }
  function place() {
    if (!page || page.hidden) return;
    const rail = document.getElementById('scene-rail'), bar = document.getElementById('app-toolbar'), panel = document.getElementById('terminal-panel');
    const left = rail && rail.offsetParent !== null ? rail.getBoundingClientRect().right : 0;
    const top = bar ? bar.getBoundingClientRect().bottom : 0;
    const bottom = panel ? window.innerHeight - panel.getBoundingClientRect().bottom : 0;
    Object.assign(page.style, { left: left + 'px', top: top + 'px', bottom: Math.max(0, bottom) + 'px' });
  }

  function status() {
    const d = data, chips = [];
    const login = d.login;
    if (!d.cliFound) chips.push('<span class="ca-chip bad">没找到 welink-cli</span>');
    else if (!login) chips.push('<span class="ca-chip">WeLink 状态还没查</span>');
    else if (login.ok) chips.push('<span class="ca-chip ok">WeLink 已登录</span>');
    else chips.push(`<span class="ca-chip warn">${login.reason === 'expired' ? 'WeLink 登录已过期' : 'WeLink 没登录'}</span><button type="button" class="ca-btn small primary" data-ca="login">扫码登录</button>`);
    if (login?.ok) chips.push(d.calendarNeedsSetup ? '<span class="ca-chip warn">日历未初始化</span><button type="button" class="ca-btn small" data-ca="calendar">初始化日历</button>' : '<span class="ca-chip">日历已接入</span>');
    chips.push('<span class="ca-chip">数据只留在本机</span>');
    chips.push(`<span class="ca-chip">${d.refreshing ? '正在取数据…' : d.refreshedAt ? '数据更新于 ' + when(d.refreshedAt) : '还没取过数据'}</span>`);
    chips.push('<span class="ca-sp"></span>');
    chips.push(`<span class="ca-chip">下一份简报：${d.nextBriefAt ? when(d.nextBriefAt) : '—'}</span>`);
    return chips.join('');
  }

  function loginPanel() {
    const f = data.loginFlow;
    if (!f || f.state === 'ok') return '';
    let qr = '';
    if (f.qr?.kind === 'data' || f.qr?.kind === 'url') qr = `<img class="ca-qr" src="${esc(f.qr.value)}" alt="WeLink 登录二维码">`;
    else if (f.qr?.kind === 'file') qr = `<img class="ca-qr" src="${esc('file:///' + f.qr.value.replace(/\\/g, '/'))}" alt="WeLink 登录二维码">`;
    const state = { waiting: '用手机 WeLink 扫下面的二维码；扫完这里会自动刷新。', finished: '登录命令已结束，正在核对登录状态…', failed: '登录没成功：' + esc(f.error || ''), ok: '' }[f.state] || '';
    const raw = !f.qr && f.text ? `<pre class="ca-qr-text">${esc(f.text.slice(-3000))}</pre>` : '';
    return `<div class="ca-login"><b>扫码登录 WeLink</b><p>${state}</p>${qr}${raw}<div class="ca-row"><button type="button" class="ca-btn" data-ca="close-panel">收起</button>${f.state === 'failed' || f.state === 'finished' ? '<button type="button" class="ca-btn primary" data-ca="login">再试一次</button>' : ''}</div></div>`;
  }

  function briefCard() {
    const b = data.brief;
    if (!b) return `<article class="ca-brief empty"><div class="ca-card-head"><b>助理 · 今日简报</b></div><p class="ca-note">今天的简报还没生成。<button type="button" class="ca-btn small primary" data-ca="brief-now">现在生成</button></p></article>`;
    const counts = b.sections.map(s => `<span class="ca-chip${s.key === 'awaiting' ? ' warn' : ''}">${esc(s.title)} ${s.items.length}</span>`).join('');
    const firstItems = b.sections.flatMap(s => s.items.slice(0, 1).map(i => i.text)).slice(0, 2);
    const headline = b.by === 'none' ? esc(b.note || '') : firstItems.length ? '📌 ' + esc(firstItems.join('；')) : '今天没有需要你处理的会议、消息和邮件。';
    const more = b.total > 10 ? `<p class="ca-note">另有 ${b.total - 10} 条在下面「其余」里。</p>` : '';
    const row = i => `<div class="ca-item"><div class="ca-item-text">${esc(i.text)}${i.guess ? '<span class="ca-guess">推测</span>' : ''}${i.due ? `<span class="ca-due">截止 ${esc(i.due)}</span>` : ''}</div>
        <div class="ca-src">${esc(i.sourceLabel || i.source)}<button type="button" class="ca-link" data-ca="done:${esc(i.source)}" title="点了以后不再出现在简报里">处理了</button></div></div>`;
    const top = b.sections.map(s => { const items = s.items.filter(i => i.top); return items.length ? `<div class="ca-sec">${esc(s.title)}（${s.items.length}）</div>${items.map(row).join('')}` : ''; }).join('');
    const rest = b.sections.flatMap(s => s.items.filter(i => !i.top).map(i => ({ ...i, title: s.title })));
    const restHtml = rest.length ? `<details class="ca-rest"><summary>其余 ${rest.length} 条</summary>${rest.map(i => `<div class="ca-sec small">${esc(i.title)}</div>${row(i)}`).join('')}</details>` : '';
    const tag = b.by === 'ai' ? '助理整理' : b.by === 'list' ? '按规则排的清单' : '';
    return `<article class="ca-brief${briefOpen ? ' open' : ''}">
        <button type="button" class="ca-brief-sum" data-ca="toggle-brief" aria-expanded="${briefOpen}">
          <div class="ca-card-head"><b>助理 · 今日简报</b><span class="ca-time">${clock(b.generatedAt)}</span>${tag ? `<span class="ca-chip">${tag}</span>` : ''}${b.organizing ? '<span class="ca-chip run">AI 正在挑重点…</span>' : ''}${counts}</div>
          <div class="ca-headline">${headline}</div>
          ${b.total ? `<span class="ca-more">${briefOpen ? '收起 ▴' : '展开全文 ▾'}</span>` : ''}
        </button>
        <div class="ca-brief-full"${briefOpen ? '' : ' hidden'}>${b.note && b.by !== 'none' ? `<p class="ca-note">${esc(b.note)}</p>` : ''}${top}${more}${restHtml}
          <div class="ca-row"><button type="button" class="ca-btn small" data-ca="brief-now">重新生成</button></div></div>
      </article>`;
  }

  function noticesStrip() {
    const list = data.notices || [];
    if (!list.length) return '';
    const NAMES = { brief: '简报', 'meeting-prep': '会前准备', 'awaiting-reply': '等你回复', 'commitment-due': '答应的事', overbooked: '会议太满', 'day-summary': '下班小结', keyword: '关注词' };
    return `<details class="ca-notices"><summary>今天的提醒 ${list.length} 条 · 最新：${esc(list[0].title)}</summary>
      ${list.map(n => `<div class="ca-notice" data-notice-id="${esc(n.id)}"><span class="ca-chip">${NAMES[n.kind] || n.kind}</span><b>${esc(n.title)}</b><span class="ca-time">${when(n.at)}</span><div class="ca-notice-text">${esc(n.text).replace(/\n/g, '<br>')}</div></div>`).join('')}</details>`;
  }

  function chatList() {
    return (data.chat || []).map(c => {
      const answer = c.state === 'done' ? `<div class="ca-md">${markdown(c.a)}</div>`
        : c.state === 'error' ? `<p class="ca-note bad">${esc(c.error || '没答上')}<button type="button" class="ca-link" data-ca="retry:${esc(c.id)}">重问</button></p>`
          : `<p class="ca-note run">${c.state === 'queued' ? '排队中…' : '助理正在查…'}</p>`;
      return `<div class="ca-msg user"><div class="ca-card-head"><b>我</b><span class="ca-time">${when(c.askedAt)}</span></div><div class="ca-body">${esc(c.q).replace(/\n/g, '<br>')}</div></div>
        <div class="ca-msg"><div class="ca-card-head"><b>助理</b>${c.answeredAt ? `<span class="ca-time">${when(c.answeredAt)}</span>` : ''}</div>${answer}</div>`;
    }).join('');
  }

  function render() {
    if (!page || !data) return;
    page.querySelector('.ca-status').innerHTML = status();
    const panel = page.querySelector('[data-slot="panel"]');
    if (!panel.dataset.kind || panel.dataset.kind === 'login') { const html = loginPanel(); panel.innerHTML = html; panel.hidden = !html; panel.dataset.kind = html ? 'login' : ''; }
    // 内容没变就不重画；重画时保留折叠块（其余条目、提醒列表）的展开状态。
    const setHtml = (slot, html) => {
      const el = page.querySelector(`[data-slot="${slot}"]`);
      if (el.dataset.html === html) return;
      const opened = [...el.querySelectorAll('details')].map(d => d.open);
      el.innerHTML = html; el.dataset.html = html;
      el.querySelectorAll('details').forEach((d, i) => { if (opened[i]) d.open = true; });
    };
    setHtml('brief', briefCard());
    setHtml('notices', noticesStrip());
    const scroll = page.querySelector('.ca-scroll');
    const atBottom = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 40;
    const chat = page.querySelector('[data-slot="chat"]'), html = chatList();
    if (chat.dataset.html !== html) { chat.innerHTML = html; chat.dataset.html = html; if (atBottom) scroll.scrollTop = scroll.scrollHeight; }
    page.querySelector('[data-slot="chips"]').innerHTML = data.chips.map((c, i) => `<button type="button" class="ca-chip-btn${c.custom ? ' custom' : ''}" data-ca="chip:${i}" title="${esc(c.text)}">${esc(c.label)}</button>`).join('') + '<button type="button" class="ca-chip-btn add" data-ca="save-chip" title="把输入框里的问题存成小标签">＋ 存为常用</button>';
    const job = data.job ? (data.job.type === 'brief' ? '助理正在整理简报…' : '助理正在回答…') + (data.queued ? `（还有 ${data.queued} 个排队）` : '') : data.session ? (data.session.open ? '助理会话已就绪' : '助理会话已休息，提问时自动恢复') : '第一次提问时会打开助理会话';
    page.querySelector('[data-slot="job"]').textContent = job;
    page.querySelector('[data-ca="refresh"]').disabled = !!data.refreshing;
  }
  async function load() { data = await call('status'); render(); }

  async function send(text) {
    const q = String(text || '').trim();
    if (!q || sending) return;
    sending = true;
    try {
      await call('ask', { text: q });
      page.querySelector('[data-slot="form"] textarea').value = '';
      await load();
      const scroll = page.querySelector('.ca-scroll'); scroll.scrollTop = scroll.scrollHeight;
    } catch (error) { showMessage?.('没发出去：' + error.message); } finally { sending = false; }
  }

  // 点小标签：要补内容的（汇总某个群…）只填进输入框，其余直接发出。
  function useChip(c) {
    if (!c) return;
    const input = page.querySelector('[data-slot="form"] textarea');
    if (c.fill) { input.value = c.text; input.focus(); const at = c.text.indexOf('「」'); if (at >= 0) input.setSelectionRange(at + 1, at + 1); return; }
    return send(c.text);
  }
  // 桌宠（hub-pet，2026-10-16）：点桌宠或右键里的事项，在 window 上发 hub-pet:open-assistant，
  // detail = { source, action?, prompt?, noticeId?, sessionId? }。打开助理页；action 对上小标签就等于点那个标签，
  // 否则把 prompt 填进输入框（输入框里已有内容不覆盖）；noticeId 对应的提醒展开并滚到眼前。
  async function fromPet(detail = {}) {
    await open();
    const input = page.querySelector('[data-slot="form"] textarea');
    const chip = detail.action ? (data?.chips || []).find(c => c.action === detail.action) : null;
    if (chip && !(chip.fill && input.value.trim())) await useChip(chip);
    else if (detail.prompt && !input.value.trim()) { input.value = String(detail.prompt); input.focus(); }
    if (detail.noticeId) {
      const box = page.querySelector('.ca-notices');
      const row = [...page.querySelectorAll('.ca-notice')].find(n => n.dataset.noticeId === String(detail.noticeId));
      if (box) box.open = true;
      if (row) { row.classList.add('focus'); row.scrollIntoView({ block: 'center' }); setTimeout(() => row.classList.remove('focus'), 3000); }
    }
  }

  async function action(name, button) {
    const input = page.querySelector('[data-slot="form"] textarea');
    const [verb, arg] = name.split(/:(.*)/s);
    if (verb === 'toggle-brief') { briefOpen = !briefOpen; render(); return; }
    if (verb === 'chip') return useChip(data.chips[Number(arg)]);
    if (verb === 'save-chip') {
      const text = input.value.trim(); if (!text) { showMessage?.('先在输入框里写好要存的问题'); return; }
      const label = text.replace(/\s+/g, ' ').slice(0, 10);
      await call('set-settings', { chips: [...data.settings.chips, { label, text }] }); showMessage?.('已存为常用：' + label); await load(); return;
    }
    if (verb === 'refresh') { button.disabled = true; data = await call('refresh'); render(); if (data.errors?.length) showMessage?.('有 ' + data.errors.length + ' 项没取到：' + data.errors.map(e => e.label).join('、')); return; }
    if (verb === 'brief-now') { button.disabled = true; briefOpen = true; data = await call('brief-now'); render(); return; }
    if (verb === 'done') { await call('mark-done', { source: arg }); await load(); return; }
    if (verb === 'retry') { await call('retry-chat', { id: arg }); await load(); return; }
    if (verb === 'login') { button.disabled = true; const panel = page.querySelector('[data-slot="panel"]'); panel.dataset.kind = 'login'; await call('login'); await load(); return; }
    if (verb === 'close-panel') { const panel = page.querySelector('[data-slot="panel"]'); panel.hidden = true; panel.innerHTML = ''; panel.dataset.kind = 'closed'; return; }
    if (verb === 'calendar') return openCalendar();
    if (verb === 'settings') return openSettings();
    if (verb === 'open-session') { const r = await call('open-session'); close(); await openSession(r.sessionId); }
  }

  function openCalendar() {
    const panel = page.querySelector('[data-slot="panel"]');
    panel.dataset.kind = 'calendar'; panel.hidden = false;
    panel.innerHTML = `<div class="ca-login"><b>初始化日历</b><p>welink-cli 读 Exchange 日历前要先按你的公司邮箱找一次邮件服务器（只写 welink-cli 自己的本地配置，不发邮件）。</p>
      <div class="ca-row"><input type="email" data-f="email" placeholder="公司邮箱" value="${esc(data.settings.email || '')}"><button type="button" class="ca-btn primary" data-x="go">初始化</button><button type="button" class="ca-btn" data-ca="close-panel">取消</button></div><p class="ca-note" data-f="msg"></p></div>`;
    panel.querySelector('[data-x="go"]').onclick = async e => {
      e.target.disabled = true; const msg = panel.querySelector('[data-f="msg"]'); msg.textContent = '正在初始化…';
      try { const r = await call('setup-calendar', { email: panel.querySelector('[data-f="email"]').value }); msg.textContent = r.needsSetup ? '还没成功：' + (r.output || '') : '日历已接入。'; await load(); }
      catch (error) { msg.textContent = '没成功：' + error.message; } finally { e.target.disabled = false; }
    };
  }

  function openSettings() {
    const panel = page.querySelector('[data-slot="panel"]');
    const s = data.settings, watched = new Set(s.watchGroups.map(g => g.id));
    const groups = (data.conversations || []).filter(c => c.group);
    const known = new Set(groups.map(g => g.id));
    const extra = s.watchGroups.filter(g => !known.has(g.id)).map(g => ({ ...g, group: true }));
    const opts = (list, cur, fmt = x => x) => list.map(x => `<option value="${x}"${String(x) === String(cur) ? ' selected' : ''}>${fmt(x)}</option>`).join('');
    panel.dataset.kind = 'settings'; panel.hidden = false;
    panel.innerHTML = `<div class="ca-settings" role="dialog" aria-label="助理设置"><h3>助理设置</h3>
      <fieldset><legend>关注的群（简报里出「关注群要点」，关注词也在这些群里找）</legend>
        <div class="ca-groups">${[...groups, ...extra].map(g => `<label><input type="checkbox" data-group="${esc(g.id)}" data-name="${esc(g.name)}"${watched.has(g.id) ? ' checked' : ''}>${esc(g.name)}</label>`).join('') || '<span class="ca-note">还没取到最近会话：先扫码登录、点「刷新数据」。</span>'}</div></fieldset>
      <fieldset><legend>提醒</legend>
        <label>关注词（逗号分隔）<input type="text" data-f="keywords" value="${esc(s.keywords.join('，'))}"></label>
        <label>我的名字（用来认群里 @我）<input type="text" data-f="myName" value="${esc(s.myName)}"></label>
        <label>等你回复超过<select data-f="waitHours">${opts([1, 2, 3, 4, 6, 8, 12, 24], s.waitHours, x => x + ' 小时')}</select>提醒</label>
        <label>开会前<select data-f="prepMinutes">${opts([5, 10, 15, 20, 30], s.prepMinutes, x => x + ' 分钟')}</select>出准备卡</label>
        <label>每小时最多<select data-f="maxPerHour">${opts([1, 2, 3, 4, 5], s.maxPerHour, x => x + ' 条')}</select></label></fieldset>
      <fieldset><legend>时间</legend>
        <label>简报（工作日）<input type="time" data-f="briefTime" value="${esc(s.briefTime)}"></label>
        <label>下班前小结<input type="time" data-f="summaryTime" value="${esc(s.summaryTime)}"></label>
        <label>自动取数据间隔<select data-f="refreshMinutes">${opts([5, 10, 15, 30], s.refreshMinutes, x => x + ' 分钟')}</select></label></fieldset>
      ${s.chips.length ? `<fieldset><legend>存过的常用问题</legend>${s.chips.map((c, i) => `<label><input type="checkbox" data-chip="${i}" checked>${esc(c.label)}</label>`).join('')}</fieldset>` : ''}
      <div class="ca-row"><button type="button" class="ca-btn" data-ca="close-panel">取消</button><button type="button" class="ca-btn primary" data-x="save">保存</button></div></div>`;
    panel.querySelector('[data-x="save"]').onclick = async e => {
      const v = f => panel.querySelector(`[data-f="${f}"]`).value;
      e.target.disabled = true;
      try {
        await call('set-settings', {
          watchGroups: [...panel.querySelectorAll('[data-group]:checked')].map(x => ({ id: x.dataset.group, name: x.dataset.name })),
          keywords: v('keywords'), myName: v('myName'), waitHours: Number(v('waitHours')), prepMinutes: Number(v('prepMinutes')), maxPerHour: Number(v('maxPerHour')),
          briefTime: v('briefTime'), summaryTime: v('summaryTime'), refreshMinutes: Number(v('refreshMinutes')),
          chips: s.chips.filter((_, i) => panel.querySelector(`[data-chip="${i}"]`)?.checked !== false),
        });
        panel.hidden = true; panel.innerHTML = ''; panel.dataset.kind = ''; await load(); showMessage?.('助理设置已保存');
      } catch (error) { e.target.disabled = false; showMessage?.('没有保存：' + error.message); }
    };
  }

  const onResize = () => place();
  async function open() {
    build(); closeOtherPanels(); window.__assistantHide?.(); window.__wirelessHide?.(); window.setShellNavActive?.('company-assistant');
    page.hidden = false; document.body.classList.add('company-assistant-page-open'); place();
    const btn = nav(); btn?.classList.add('active'); btn?.classList.remove('has-unread');
    window.addEventListener('resize', onResize);
    clearInterval(timer); timer = setInterval(() => { void load().catch(() => {}); }, 20000);
    try {
      await load();
      // 打开页面时今天还没有简报：当场生成（工作日、非工作日都可以手动看）。
      if (!data.brief && data.login?.ok !== false) { data = await call('brief-now'); briefOpen = true; render(); }
    } catch (error) { showMessage?.('助理状态读取失败：' + error.message); }
  }
  function close() {
    if (!page || page.hidden) return;
    page.hidden = true; document.body.classList.remove('company-assistant-page-open');
    document.getElementById('btn-company-assistant')?.classList.remove('active');
    clearInterval(timer); timer = null; window.removeEventListener('resize', onResize);
  }
  nav();
  document.addEventListener('click', e => { if (page && !page.hidden && e.target.closest('#scene-rail button:not(#btn-company-assistant)')) close(); });
  ipcRenderer.on('company-assistant:changed', () => { if (page && !page.hidden) void load().catch(() => {}); });
  ipcRenderer.on('company-assistant:notice', (_e, notice) => {
    if (notice?.title) showMessage?.(notice.title);
    if (!page || page.hidden) document.getElementById('btn-company-assistant')?.classList.add('has-unread');
  });
  // 点桌面通知：打开助理页（主进程用固定编号 company-assistant）。
  ipcRenderer.on('desktop-notification:open-session', (_e, payload) => { if (payload?.sessionId === 'company-assistant') void open(); });
  window.addEventListener('hub-pet:open-assistant', e => { void fromPet(e.detail || {}).catch(error => showMessage?.(error.message)); });
  return { open, close, isOpen: () => !!page && !page.hidden };
}
module.exports = { createCompanyAssistantPage };
