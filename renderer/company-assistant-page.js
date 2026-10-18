'use strict';
// 公司版「助理」页（2026-10-16 选定设计 B：简报 + 对话）。页面就是和助理会话的对话：
// 今天第一条是简报（默认收起成要点，点开看全文，每条带出处），下面是问答；输入框上方一排常用问题小标签。
// 顶部状态：WeLink 登录（过期时扫码）、邮件和日历是否接入、数据只留本机、下一份简报时间。
// 设置分四页（2026-10-17 起三页，10-18 加「手机」）：简报与提醒 / WeLink 与邮箱 / 手机 / 桌宠。邮箱 Hub 先从 WeLink 账号自动读、自动配好，
// 读不到才在「WeLink 与邮箱」页请用户填一次——不让助理在对话里问。
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
        <div data-slot="setup"></div>
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
    if (login?.ok) chips.push(d.calendarNeedsSetup ? '<span class="ca-chip warn">邮件和日历未接入</span><button type="button" class="ca-btn small primary" data-ca="calendar">填邮箱</button>' : `<span class="ca-chip" title="${esc(d.settings.email || '')}">邮件和日历已接入</span>`);
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

  // 邮件和日历没接入、WeLink 里也读不到邮箱时，在简报上方请用户填一次（只出现这一处，填完就消失）。
  function setupCard() {
    const d = data;
    if (!d.login?.ok || !d.calendarNeedsSetup) return '';
    const auto = d.mailSetup || {};
    const why = auto.reason === 'no-email' ? 'WeLink 账号信息里没读到你的邮箱。' : auto.email ? `用 ${esc(auto.email)} 自动配置没成功${auto.output ? '（' + esc(auto.output) + '）' : ''}。` : '';
    return `<article class="ca-setup"><b>填一次公司邮箱，邮件和日历就能用</b><p class="ca-note">${why}只用来让 welink-cli 找到公司邮件服务器，不发邮件，数据只留在这台电脑。</p>
      <div class="ca-row"><input type="email" data-f="setup-email" placeholder="公司邮箱地址" value="${esc(d.settings.email || auto.email || '')}"><button type="button" class="ca-btn primary" data-ca="setup-mail">配置</button></div><p class="ca-note" data-f="setup-msg"></p></article>`;
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
      return `<div class="ca-msg user"><div class="ca-card-head"><b>我</b>${c.via === 'phone' ? '<span class="ca-chip">手机</span>' : ''}<span class="ca-time">${when(c.askedAt)}</span></div><div class="ca-body">${esc(c.q).replace(/\n/g, '<br>')}</div></div>
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
    setHtml('setup', setupCard());
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
    // 桌宠右键「桌宠设置…」「更多形象…」：直接打开设置的对应分页。
    if (detail.settingsTab) { openSettings(String(detail.settingsTab)); return; }
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
    if (verb === 'calendar') return openSettings('welink');
    if (verb === 'settings') return openSettings();
    if (verb === 'setup-mail') return setupMail(page.querySelector('[data-f="setup-email"]'), page.querySelector('[data-f="setup-msg"]'), button);
    if (verb === 'settings-tab') return openSettings(arg);
    if (verb === 'open-session') return window.__companyAssistantOpenSession();
  }

  async function setupMail(input, msg, button) {
    if (button) button.disabled = true;
    if (msg) msg.textContent = '正在配置邮件和日历…';
    try {
      const r = await call('setup-calendar', { email: input ? input.value : '' });
      if (msg) msg.textContent = r.needsSetup ? '还没成功：' + (r.output || '请核对邮箱地址') : '邮件和日历已接入。';
      await load();
    } catch (error) { if (msg) msg.textContent = '没成功：' + error.message; } finally { if (button) button.disabled = false; }
  }

  const TABS = [['brief', '简报与提醒'], ['welink', 'WeLink 与邮箱'], ['phone', '手机'], ['pet', '桌宠']];
  let petTab = null, phoneTimer = null, phoneData = null;

  // 「手机」页（2026-10-18）：在手机 WeLink 的专用群里和助理对话。群由用户自己在手机上建，这里只选群、开关和看往来。
  const KIND_TAG = { other: '别人发的', stale: '过期没执行', throttled: '太快没处理', unsupported: '不是文字', failed: '没发出去', ack: '回执', done: '会话答完', stuck: '会话卡住', welcome: '接通', test: '测试', error: '没答上', info: '提示' };
  function phoneLive() {
    const p = phoneData.phone, st = p.settings;
    const line = !st.groupId ? '<span class="ca-chip">还没选群</span>' : !st.enabled ? '<span class="ca-chip">没开启</span>'
      : p.lastError ? `<span class="ca-chip warn">出错</span><span class="ca-note">${esc(p.lastError)}</span>`
        : p.lastOkAt ? `<span class="ca-chip ok">已接通</span><span class="ca-note">每 3 秒查一次群消息，上次 ${clock(p.lastOkAt)}${p.pending ? ` · 正在答 ${p.pending} 条` : ''}</span>` : '<span class="ca-chip run">正在接通…</span>';
    const watching = p.watching.length ? `<p class="ca-note">正在盯 ${p.watching.length} 个会话：${p.watching.map(w => esc(w.title || w.id)).join('、')}（答完或卡住时推到手机）</p>` : '';
    const log = p.log.length ? p.log.map(x => `<div class="ca-src-row ca-phone-row"><span>${clock(x.at)} ${x.dir === 'in' ? '手机→' : '→手机'}</span>${x.kind && KIND_TAG[x.kind] ? `<span class="ca-chip${['failed', 'stale', 'throttled'].includes(x.kind) ? ' warn' : ''}">${KIND_TAG[x.kind]}</span>` : ''}<span class="ca-note" title="${esc(x.text)}">${esc(x.text)}</span></div>`).join('')
      : '<p class="ca-note">还没有往来。</p>';
    return `<div class="ca-row">${line}</div>${watching}<div class="ca-sec small">最近往来</div>${log}`;
  }
  function phoneTab() {
    const st = phoneData.phone.settings, check = phoneData.phone.groupCheck;
    const groups = (phoneData.conversations || []).filter(c => c.group);
    if (st.groupId && !groups.some(g => g.id === st.groupId)) groups.unshift({ id: st.groupId, name: st.groupName || st.groupId, group: true });
    const options = ['<option value="">— 选一个群 —</option>', ...groups.map(g => `<option value="${esc(g.id)}" data-name="${esc(g.name)}"${g.id === st.groupId ? ' selected' : ''}>${esc(g.name)}</option>`)].join('');
    const checkLine = check && check.groupId === st.groupId ? `<span class="ca-chip${check.ok ? ' ok' : ' warn'}">${check.ok ? '成员没问题' : '有其他人'}</span><span class="ca-note">${esc(check.note)}</span>` : '';
    return `<fieldset class="col"><legend>接通状态</legend><div data-slot="phone-live">${phoneLive()}</div></fieldset>
      <fieldset class="col"><legend>第一次用：在手机上建一个只有你和小微助手的群</legend>
        <ol class="ca-steps"><li>手机 WeLink 里发起群聊，拉上「小微助手」和一位同事（建群至少要 3 人）。</li>
          <li>建好后在群设置里把这位同事移出，群里只剩你和小微助手。</li>
          <li>群名改成「助理 CodeAgent」，在群里随便说一句，再点下面「刷新群列表」，选中这个群。</li>
          <li>勾上「开启手机对话」并保存：Hub 会在群里发一句「已接通」，之后在群里直接跟助理说话。</li></ol>
        <p class="ca-note">Hub 只认这个群里你本人发的文字，只往这个群发消息，回答以「【助理】」开头。超过 2 分钟的旧消息不执行，每分钟最多 20 条。</p></fieldset>
      <fieldset class="col"><legend>选群</legend>
        <div class="ca-row"><select data-f="phone-group">${options}</select><button type="button" class="ca-btn small" data-x="phone-refresh">刷新群列表</button><button type="button" class="ca-btn small" data-x="phone-check">检查群成员</button></div>
        <div class="ca-row" data-slot="phone-check">${checkLine}</div></fieldset>
      <fieldset class="col"><legend>开关与推送</legend>
        <label><input type="checkbox" data-f="phone-enabled"${st.enabled ? ' checked' : ''}>开启手机对话</label>
        <label><input type="checkbox" data-f="phone-pushWatched"${st.pushWatched ? ' checked' : ''}>助理派出的、让它盯着的会话答完或卡住时，推到手机</label>
        <label><input type="checkbox" data-f="phone-pushStuck"${st.pushStuck ? ' checked' : ''}>其他会话卡住等你时也推到手机（电脑前 5 分钟内有人操作就不推）</label></fieldset>
      <div class="ca-row end"><button type="button" class="ca-btn" data-x="phone-test"${st.groupId ? '' : ' disabled'}>发一条测试消息</button><button type="button" class="ca-btn primary" data-x="phone-save">保存</button></div>`;
  }
  async function mountPhoneTab(panel) {
    const body = panel.querySelector('.ca-tab-body');
    if (!body.innerHTML.trim()) body.innerHTML = '<p class="ca-note">正在读取…</p>';
    try { phoneData = await call('phone-status'); } catch (error) { body.innerHTML = `<p class="ca-note bad">手机设置没能打开：${esc(error.message)}</p>`; return; }
    if (panel.dataset.tab !== 'phone' || !body.isConnected) return;
    body.innerHTML = phoneTab();
    const groupSel = body.querySelector('[data-f="phone-group"]');
    const chosen = () => { const o = groupSel.selectedOptions[0]; return { groupId: groupSel.value, groupName: o?.dataset.name || '' }; };
    body.querySelector('[data-x="phone-refresh"]').onclick = async e => {
      e.target.disabled = true;
      try { await call('refresh'); await mountPhoneTab(panel); showMessage?.('群列表已刷新'); } catch (error) { e.target.disabled = false; showMessage?.('没刷新：' + error.message); }
    };
    body.querySelector('[data-x="phone-check"]').onclick = async e => {
      const g = chosen(); if (!g.groupId) { showMessage?.('先选一个群'); return; }
      e.target.disabled = true;
      const slot = body.querySelector('[data-slot="phone-check"]');
      try { const r = await call('phone-check-group', { groupId: g.groupId }); slot.innerHTML = `<span class="ca-chip${r.ok ? ' ok' : ' warn'}">${r.ok ? '成员没问题' : '有其他人'}</span><span class="ca-note">${esc(r.note)}</span>`; }
      catch (error) { slot.innerHTML = `<span class="ca-note bad">没查到：${esc(error.message)}</span>`; } finally { e.target.disabled = false; }
    };
    body.querySelector('[data-x="phone-test"]').onclick = async e => {
      e.target.disabled = true;
      try { const r = await call('phone-test'); showMessage?.(r.ok ? '测试消息已发到群里，去手机上看看' : '没发出去，原因见「最近往来」'); } catch (error) { showMessage?.('没发出去：' + error.message); } finally { e.target.disabled = false; }
    };
    body.querySelector('[data-x="phone-save"]').onclick = async e => {
      const g = chosen(), on = f => body.querySelector(`[data-f="phone-${f}"]`).checked;
      if (on('enabled') && !g.groupId) { showMessage?.('先选一个群再开启'); return; }
      e.target.disabled = true;
      try {
        const r = await call('phone-settings', { ...g, enabled: on('enabled'), pushWatched: on('pushWatched'), pushStuck: on('pushStuck') });
        showMessage?.(r.welcome === false ? '已保存，但「已接通」那句没发进群里，原因见「最近往来」' : r.welcome ? '已接通：去手机上看看群里那句「已接通」' : '手机设置已保存');
        await mountPhoneTab(panel);
      } catch (error) { e.target.disabled = false; showMessage?.('没有保存：' + error.message); }
    };
    // 开着这页时每 3 秒刷新状态和往来（只换这一块，不打断正在改的选项）。
    clearInterval(phoneTimer);
    phoneTimer = setInterval(async () => {
      if (panel.hidden || panel.dataset.tab !== 'phone' || !body.isConnected) { clearInterval(phoneTimer); phoneTimer = null; return; }
      try { phoneData = await call('phone-status'); const live = body.querySelector('[data-slot="phone-live"]'); if (live) live.innerHTML = phoneLive(); } catch { /* 下次再刷 */ }
    }, 3000);
  }

  function welinkTab() {
    const d = data, s = d.settings, login = d.login;
    const loginLine = !d.cliFound ? '<span class="ca-chip bad">没找到 welink-cli</span><span class="ca-note">公司电脑上需先安装 npm 全局包 @welink/welink-cli</span>'
      : login?.ok ? `<span class="ca-chip ok">已登录</span><span class="ca-note">账号 ${esc(login.uid || '')}</span>`
        : `<span class="ca-chip warn">${login?.reason === 'expired' ? '登录已过期' : '没登录'}</span><button type="button" class="ca-btn small primary" data-ca="login">扫码登录</button>`;
    const from = s.emailFrom === 'welink' ? '从 WeLink 账号自动读到' : s.email ? '你填写的' : '';
    const errs = d.errors || [];
    const errOf = label => errs.find(e => e.label === label || e.label.startsWith(label));
    const snapRows = [['会议', d.counts?.meetings], ['日程', d.counts?.calendar], ['消息', d.counts?.messages], ['未读邮件', d.counts?.mails]].map(([label, n]) => {
      const e = errOf(label);
      return `<div class="ca-src-row"><span>${label}</span>${e ? `<span class="ca-chip warn" title="${esc(e.text)}">没取到</span><span class="ca-note">${esc(e.text)}</span>` : login?.ok && d.refreshedAt ? `<span class="ca-chip ok">已取到 ${n ?? 0} 条</span>` : '<span class="ca-note">—</span>'}</div>`;
    }).join('');
    return `<fieldset><legend>WeLink 登录</legend><div class="ca-row">${loginLine}</div></fieldset>
      <fieldset class="col"><legend>公司邮箱（邮件和日历要用）</legend>
        <div class="ca-row"><input type="email" data-f="email" placeholder="公司邮箱地址" value="${esc(s.email || '')}"><button type="button" class="ca-btn primary" data-x="mail">${d.calendarNeedsSetup ? '配置邮件和日历' : '重新配置'}</button>${from ? `<span class="ca-note">${from}</span>` : ''}</div>
        <p class="ca-note" data-f="mail-msg">${d.calendarNeedsSetup ? '还没接入。' : '已接入。'}只让 welink-cli 按邮箱找一次公司邮件服务器，不发邮件。</p></fieldset>
      <fieldset class="col"><legend>最近一次取数（${d.refreshedAt ? when(d.refreshedAt) : '还没取过'}）</legend>${snapRows}
        <div class="ca-row"><button type="button" class="ca-btn small" data-ca="refresh">刷新数据</button></div></fieldset>
      <fieldset><legend>我的名字（用来认群里 @我）</legend><input type="text" data-f="myName" value="${esc(s.myName)}" placeholder="WeLink 里的显示名"><button type="button" class="ca-btn small" data-x="name">保存</button></fieldset>`;
  }

  function briefTab() {
    const s = data.settings, sc = data.scope;
    const opts = (list, cur, fmt = x => x) => list.map(x => `<option value="${x}"${String(x) === String(cur) ? ' selected' : ''}>${fmt(x)}</option>`).join('');
    // 2026-10-18：不再手动勾「关注群」，默认取回看时间内所有单聊和群。免打扰、置顶 welink-cli 拿不到（Q-1018-10），不做这两个设置。
    const last = sc ? `上次取到 ${sc.withMessages} 个会话（单聊 ${sc.p2p}、群 ${sc.withMessages - sc.p2p}）共 ${sc.messages} 条消息${sc.limited ? `，按设置只取了最近 ${sc.maxConversations} 个会话` : ''}。` : '还没取过数据：先扫码登录、点「刷新数据」。';
    return `<fieldset class="col"><legend>聊天记录范围（简报、提醒和对话都用这份数据）</legend>
        <div class="ca-row"><label>回看最近<select data-f="lookbackHours">${opts([12, 24, 36, 48, 72], s.lookbackHours, x => x + ' 小时')}</select></label>
          <label>会话个数<select data-f="maxConversations">${opts([0, 10, 20, 30], s.maxConversations, x => (Number(x) ? '最近 ' + x + ' 个' : '全部（默认）'))}</select></label></div>
        <p class="ca-note">「全部」是 WeLink 最近会话里排前 50 个（welink-cli 一次最多列 50 个）中，回看时间内有消息的单聊和群，每个都取全部消息。WeLink 的免打扰、置顶信息 welink-cli 拿不到，所以没有这两项设置。</p>
        <p class="ca-note">${last}</p></fieldset>
      <fieldset><legend>提醒</legend>
        <label>关注词（逗号分隔）<input type="text" data-f="keywords" value="${esc(s.keywords.join('，'))}"></label>
        <label>等你回复超过<select data-f="waitHours">${opts([1, 2, 3, 4, 6, 8, 12, 24], s.waitHours, x => x + ' 小时')}</select>提醒</label>
        <label>开会前<select data-f="prepMinutes">${opts([5, 10, 15, 20, 30], s.prepMinutes, x => x + ' 分钟')}</select>出准备卡</label>
        <label>每小时最多<select data-f="maxPerHour">${opts([1, 2, 3, 4, 5], s.maxPerHour, x => x + ' 条')}</select></label></fieldset>
      <fieldset><legend>时间</legend>
        <label>简报（工作日）<input type="time" data-f="briefTime" value="${esc(s.briefTime)}"></label>
        <label>下班前小结<input type="time" data-f="summaryTime" value="${esc(s.summaryTime)}"></label>
        <label>自动取数据间隔<select data-f="refreshMinutes">${opts([5, 10, 15, 30], s.refreshMinutes, x => x + ' 分钟')}</select></label></fieldset>
      ${s.chips.length ? `<fieldset><legend>存过的常用问题</legend>${s.chips.map((c, i) => `<label><input type="checkbox" data-chip="${i}" checked>${esc(c.label)}</label>`).join('')}</fieldset>` : ''}
      <div class="ca-row end"><button type="button" class="ca-btn primary" data-x="save">保存</button></div>`;
  }

  function openSettings(tab) {
    const panel = page.querySelector('[data-slot="panel"]');
    const current = TABS.some(([k]) => k === tab) ? tab : (panel.dataset.kind === 'settings' && panel.dataset.tab) || 'brief';
    panel.dataset.kind = 'settings'; panel.dataset.tab = current; panel.hidden = false;
    const s = data.settings;
    panel.innerHTML = `<div class="ca-settings" role="dialog" aria-label="助理设置">
      <div class="ca-settings-head"><h3>助理设置</h3><div class="ca-tabs" role="tablist">${TABS.map(([k, label]) => `<button type="button" role="tab" class="ca-tab${k === current ? ' on' : ''}" aria-selected="${k === current}" data-ca="settings-tab:${k}">${label}</button>`).join('')}</div>
        <button type="button" class="ca-btn small" data-ca="close-panel">关闭</button></div>
      <div class="ca-tab-body" data-tab="${current}">${current === 'brief' ? briefTab() : current === 'welink' ? welinkTab() : current === 'phone' ? '' : '<div data-slot="pet-tab"></div>'}</div></div>`;
    if (current !== 'phone') { clearInterval(phoneTimer); phoneTimer = null; }
    if (current === 'phone') { petTab = null; void mountPhoneTab(panel); return; }
    if (current === 'pet') {
      const host = panel.querySelector('[data-slot="pet-tab"]');
      try { petTab = require('./hub-pet/pet-settings-tab.js').mountPetSettingsTab(host, { ipcRenderer, window, document }); }
      catch (error) { host.innerHTML = `<p class="ca-note">桌宠设置没能打开：${esc(error.message)}</p>`; }
      return;
    }
    petTab = null;
    if (current === 'welink') {
      panel.querySelector('[data-x="mail"]').onclick = e => setupMail(panel.querySelector('[data-f="email"]'), panel.querySelector('[data-f="mail-msg"]'), e.target).then(() => { if (panel.dataset.tab === 'welink') openSettings('welink'); });
      panel.querySelector('[data-x="name"]').onclick = async () => { try { await call('set-settings', { myName: panel.querySelector('[data-f="myName"]').value }); await load(); showMessage?.('名字已保存'); } catch (error) { showMessage?.('没有保存：' + error.message); } };
      return;
    }
    panel.querySelector('[data-x="save"]').onclick = async e => {
      const v = f => panel.querySelector(`[data-f="${f}"]`).value;
      e.target.disabled = true;
      try {
        await call('set-settings', {
          lookbackHours: Number(v('lookbackHours')), maxConversations: Number(v('maxConversations')),
          keywords: v('keywords'), waitHours: Number(v('waitHours')), prepMinutes: Number(v('prepMinutes')), maxPerHour: Number(v('maxPerHour')),
          briefTime: v('briefTime'), summaryTime: v('summaryTime'), refreshMinutes: Number(v('refreshMinutes')),
          chips: s.chips.filter((_, i) => panel.querySelector(`[data-chip="${i}"]`)?.checked !== false),
        });
        panel.hidden = true; panel.innerHTML = ''; panel.dataset.kind = ''; await load(); showMessage?.('助理设置已保存');
      } catch (error) { e.target.disabled = false; showMessage?.('没有保存：' + error.message); }
    };
  }

  const onResize = () => place();
  async function open() {
    build(); closeOtherPanels(); window.__assistantHide?.(); window.__wirelessHide?.(); window.__companyForumHide?.(); window.setShellNavActive?.('company-assistant');
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
  // 侧栏「助理」一栏的占位行（助理会话还没打开时）点进来：恢复或新开助理会话，再选中它。
  window.__companyAssistantOpenSession = async () => {
    try { const r = await call('open-session'); close(); await openSession(r.sessionId); }
    catch (error) { showMessage?.('助理会话没能打开：' + error.message); }
  };
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
