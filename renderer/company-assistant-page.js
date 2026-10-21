'use strict';
// 公司版「助理」页（2026-10-16 选定设计 B：简报 + 对话）。页面就是和助理会话的对话：
// 今天第一条是简报（默认收起成要点，点开看全文，每条带出处），下面是问答；输入框上方一排常用问题小标签。
// 顶部状态：WeLink 登录（过期时扫码）、邮件和日历是否接入、数据只留本机、下一份简报时间。
// 设置分四页（2026-10-17 起三页，10-18 加「手机」）：简报与提醒 / WeLink 与邮箱 / 手机 / 桌宠。邮箱 Hub 先从 WeLink 账号自动读、自动配好，
// 读不到才在「WeLink 与邮箱」页请用户填一次——不让助理在对话里问。
// 写法同无线页：盖在主区域上的一层，点左侧其他按钮自动关闭。左侧按钮只在公司版（gate.js）插入。
function createCompanyAssistantPage({ document, window, ipcRenderer, openSession, closeOtherPanels = () => {}, showMessage }) {
  const { ASSISTANT_AVATAR_SRC, USER_AVATAR_SRC } = require('./chat-avatar');
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
    page.innerHTML = `<aside class="ca-sidebar" aria-label="助理导航">
        <div class="ca-identity" title="助理 · 只读 WeLink"><img src="${ASSISTANT_AVATAR_SRC}" alt="助理"><div class="ca-side-copy"><h1>助理 <small>v3.1</small></h1><span data-slot="model">工作助理 · 只读 WeLink</span></div></div>
        <div class="ca-side-heading">连接</div>
        <div class="ca-status" aria-label="状态"></div>
        <div class="ca-side-heading">能力</div>
        <nav class="ca-capabilities" aria-label="助理能力"></nav>
        <div class="ca-side-bottom">
          <button type="button" class="ca-side-button" data-ca="settings" title="助理设置"><span class="ca-side-icon">⚙</span><span class="ca-side-copy">设置</span></button>
          <button type="button" class="ca-side-button" data-ca="open-session" title="打开助理会话"><span class="ca-side-icon">↗</span><span class="ca-side-copy">打开会话</span></button>
        </div>
      </aside><main class="ca-main">
      <div class="ca-panel" data-slot="panel" hidden></div>
      <div class="ca-scroll"><div class="ca-convo">
        <div data-slot="setup"></div>
        <div data-slot="coverage"></div>
        <div data-slot="brief"></div>
        <div data-slot="notices"></div>
        <div data-slot="rooms"></div>
        <div data-slot="chat"></div>
      </div></div>
      <footer class="ca-foot">
        <div class="ca-chips" data-slot="chips"></div>
        <form class="ca-input" data-slot="form">
          <textarea rows="2" placeholder="问助理任何事，例如「把某个群今天的讨论整理成三点」（Enter 发送，Shift+Enter 换行）" aria-label="问助理"></textarea>
          <button type="submit" class="ca-btn primary">发送</button>
        </form>
        <div class="ca-foot-note"><span data-slot="job"></span><span>Enter 发送 · Shift+Enter 换行</span></div>
      </footer></main>`;
    document.body.append(page);
    // Esc 关掉盖在上面的设置。
    page.addEventListener('keydown', event => {
      const panel = page.querySelector('[data-slot="panel"]');
      if (event.key === 'Escape' && ['settings', 'source'].includes(panel.dataset.kind) && !panel.hidden) { panel.hidden = true; panel.innerHTML = ''; panel.dataset.kind = 'closed'; }
    });
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
    // 底边按底栏高度算（同云端页）：以前按会话区算，从「规则」切过来时会话区被规则页藏着，量出来高度是 0，页面被压成一条、和规则页叠在一起（2026-10-19 用户）。
    const rail = document.getElementById('scene-rail'), bar = document.getElementById('app-toolbar'), footer = document.getElementById('hub-system-footer');
    const left = rail && rail.offsetParent !== null ? rail.getBoundingClientRect().right : 0;
    const top = bar ? bar.getBoundingClientRect().bottom : 0;
    const bottom = footer ? footer.getBoundingClientRect().height : 0;
    Object.assign(page.style, { left: left + 'px', top: top + 'px', bottom: Math.max(0, bottom) + 'px' });
  }

  function status() {
    const d = data, auth = d.auth || {}, phone = d.phone || {}, p = phone.settings || {};
    const renewing = auth.state === 'renewing';
    const online = d.login?.ok && auth.state !== 'needs-scan';
    const coverages = [['会议', d.meetingCoverage], ['日程', d.calendarCoverage], ['邮件', d.mailCoverage]];
    const mailText = coverages.map(([name, c]) => name + ({ complete: '已查', partial: '未取全', failed: '失败' }[c?.status] || '待查')).join(' · ');
    const loginText = !d.cliFound ? '未找到 welink-cli' : renewing ? '正在自动续期' : online ? (auth.lastRenewAt ? '自动续期 · 上次 ' + clock(auth.lastRenewAt) : '在线 · 自动维护登录') : auth.state === 'needs-scan' ? '自动续期没成功，点这里扫码登录' : auth.error || '正在检查登录';
    const row = (icon, title, detail, color, action, extra = '') => `<div class="ca-connection" title="${esc(title + ' · ' + detail)}"><button type="button" class="ca-connection-main" data-ca="${action}"><span class="ca-side-icon">${icon}<i class="ca-dot ${color}"></i></span><span class="ca-side-copy"><b>${title}</b><small>${esc(detail)}</small></span></button>${extra}</div>`;
    return row('W', 'WeLink', loginText, renewing ? 'run' : online ? 'ok' : 'warn', d.cliFound && auth.state === 'needs-scan' ? 'login' : 'settings-tab:welink',
      !d.cliFound ? '<button class="ca-link ca-side-copy" data-ca="find-cli">查找</button>' : !online && !renewing ? '<button class="ca-link ca-side-copy" data-ca="login">扫码登录</button>' : '')
      + row('✉', '会议、日程与邮件', mailText, coverages.every(([, c]) => c?.status === 'complete') ? 'ok' : coverages.some(([, c]) => ['failed', 'partial'].includes(c?.status)) ? 'warn' : '', 'settings-tab:welink')
      + row('▣', '手机群', !p.groupId ? '填入群 ID 即可接通' : phone.lastError ? phone.lastError : !p.enabled ? '已暂停' : (p.groupName || '群 ' + p.groupId.slice(-6)), p.enabled && p.groupId && !phone.lastError ? 'ok' : '', 'settings-tab:phone')
      + toolsRow(row)
      + row('↻', '数据更新时间', d.refreshing ? '正在刷新…' : d.refreshedAt ? when(d.refreshedAt) : '还没取过数据', d.refreshedAt ? 'ok' : '', 'refresh', '<button class="ca-link ca-side-copy" data-ca="refresh" title="刷新数据">刷新</button>')
      + `<p class="ca-next ca-side-copy">下一份简报 · ${d.nextBriefAt ? when(d.nextBriefAt) : '—'}</p>`;
  }
  // 会话工具（v3.1.1）：助理会话里查、管其他会话的 hub_sessions 接没接上。没接上时写原因猜测，附「重开助理会话」。
  let toolsTimer = null;
  function toolsRow(row) {
    const t = data.tools;
    clearTimeout(toolsTimer);
    if (!t) return '';
    // 「正在接通」到期（会话起来满 90 秒）时重新取一次状态，到点翻成「未接上」。
    if (t.state === 'starting' && t.checkAt) toolsTimer = setTimeout(() => { void load().catch(() => {}); }, Math.max(1000, t.checkAt - (data.now || Date.now()) + 500));
    const color = { linked: 'ok', starting: 'run', missing: 'warn' }[t.state] || '';
    if (t.state !== 'missing') return row('⇄', '会话工具', t.label, color, 'open-session');
    // 原因单独一行（沿用「下一份简报」那行的小字样式），侧栏窄也能读全
    return row('⇄', '会话工具', t.label, color, 'open-session', '<button class="ca-link ca-side-copy" data-ca="reopen-session">重开助理会话</button>')
      + (t.reason ? `<p class="ca-next ca-side-copy ca-tools-reason">原因：${esc(t.reason)}</p>` : '');
  }
  function messageCoverage() {
    const scope = data.scope;
    if (!scope) return null;
    const reasons = [scope.stale ? '最近会话查询失败，显示上次记录' : '', scope.partial ? `${scope.partial} 个会话未取全` : '',
      scope.listFull ? `最近会话返回 ${scope.listed || scope.listCap} 个，可能达到接口上限，未知会话仍可能遗漏` : '', scope.directoryFallback ? '已退回兼容查询，覆盖待核对' : '', scope.limited ? `按设置只查询最近 ${scope.maxConversations} 个会话` : '',
      scope.directoryInvalid ? `${scope.directoryInvalid} 条会话目录记录无法解析` : '', (scope.conversations || []).some(c => c.unknownTime) ? '部分消息缺少时间，无法确认是否覆盖所选时段' : ''].filter(Boolean);
    return { status: reasons.length ? 'partial' : 'complete', reasonLabel: reasons.join('；') };
  }
  function capabilities() {
    const r = data.rooms || {}, p = data.ppt || {};
    return [['▤', '今日简报', data.brief ? '已更新' : '待生成', 'brief'],
      ['◷', '抢会议室', r.running ? '守护中' : r.available ? '可配置' : '待接入', 'rooms'],
      ['▧', 'PPT 素材库', p.indexing?.state === 'indexing' ? `正在更新 · ${p.indexing.scanned || 0} 份` : p.available ? `${p.files ?? 0} 份 / ${p.pages ?? 0} 页` : '选择素材目录', 'ppt'],
      ['▣', '手机对话', data.phone?.settings?.enabled ? '已开启' : '待接通', 'phone']]
      .map(([icon, name, detail, tab]) => `<button class="ca-side-button" data-ca="${tab === 'ppt' ? 'ppt-assist' : 'settings-tab:' + tab}" title="${name} · ${tab === 'ppt' ? '告诉助理你想讲清什么' : detail}"><span class="ca-side-icon">${icon}</span><span class="ca-side-copy">${name}<small>${detail}</small></span></button>`).join('');
  }
  function assistantMessage(html, extra = '') {
    return `<div class="ca-message-row assistant ${extra}"><img class="ca-avatar" src="${ASSISTANT_AVATAR_SRC}" alt="助理"><div class="ca-message-content">${html}</div></div>`;
  }

  // welink-cli 没找到时（2026-10-19）：后台在全盘找就显示进度；找完还没有就给「再找一次」「手动选择…」。
  const CLI_STAGE = { path: '看系统路径', npm: '问 npm 全局目录', disk: '在各个硬盘里找' };
  function cliChip(d) {
    const s = d.cliSearch || {};
    if (s.state === 'searching') return `<span class="ca-chip run">正在查找 welink-cli…${CLI_STAGE[s.stage] ? '（' + CLI_STAGE[s.stage] + '）' : ''}</span>`;
    return '<span class="ca-chip bad">没找到 welink-cli</span><button type="button" class="ca-btn small" data-ca="find-cli">再找一次</button><button type="button" class="ca-btn small" data-ca="pick-cli">手动选择…</button>';
  }
  function loginPanel() {
    const f = data.loginFlow;
    if (!f || f.state === 'ok') return '';
    // 2026-10-22 v3.1.1：真机二维码是字符画，主进程转成 SVG（kind:'blocks'）按原尺寸显示，不缩放免得模块边缘发糊；
    // 登录网页（f.url）不是图片，只做下面那行「在浏览器打开」。
    const p = f.progress || {};
    const failed = f.state === 'failed' || p.phase === 'failed', scanned = !failed && p.phase === 'scanned';
    // 超时或失败后旧二维码已失效、扫码成功后也用不着了，都不再显示。
    let qr = '';
    if (failed || scanned) { /* 不显示 */ } else if (f.qr?.kind === 'blocks') qr = `<img class="ca-qr ca-qr-blocks" src="${esc(f.qr.value)}" width="${Number(f.qr.px) || ''}" height="${Number(f.qr.px) || ''}" alt="WeLink 登录二维码">`;
    else if (f.qr?.kind === 'data') qr = `<img class="ca-qr" src="${esc(f.qr.value)}" alt="WeLink 登录二维码">`;
    else if (f.qr?.kind === 'file') qr = `<img class="ca-qr" src="${esc('file:///' + f.qr.value.replace(/\\/g, '/'))}" alt="WeLink 登录二维码">`;
    const reason = p.phase === 'failed' ? p.reason : f.error;
    const state = failed ? '登录没成功：' + esc(reason || '') : scanned ? '已扫码，正在登录…'
      // 字符画已经输出完（进入等待扫码）却没能还原成二维码：同样提示改用链接，下面附上原样输出备查。
      : { waiting: f.garbled || (!f.qr && p.phase === 'waiting') ? '二维码显示失败，请用下方链接。' : '用手机 WeLink 扫下面的二维码；扫完这里会自动刷新。', finished: '登录命令已结束，正在核对登录状态…', ok: '' }[f.state] || '';
    const tick = f.state === 'waiting' && !failed && p.phase === 'waiting' ? `<p class="ca-qr-status">等待扫码 · ${Number(p.elapsed) || 0} 秒</p>` : '';
    const link = !scanned && /^https:\/\//i.test(f.url || '') ? `<p class="ca-qr-link">二维码扫不出来？<button type="button" class="ca-link" data-ca="open-login-url">在浏览器打开</button></p>` : '';
    // 认不出的输出原样给出来（排查用）；框还在流式输出（obtaining）、判成乱码或已结束时不贴。
    const raw = !f.qr && f.text && !f.garbled && !failed && !scanned && p.phase !== 'obtaining' ?`<pre class="ca-qr-text">${esc(f.text.slice(-3000))}</pre>` : '';
    const retry = failed || (f.state === 'finished' && !scanned) ? '<button type="button" class="ca-btn primary" data-ca="login">重新获取二维码</button>' : '';
    return `<div class="ca-login"><b>扫码登录 WeLink</b><p>${state}</p>${qr}${tick}${link}${raw}<div class="ca-row"><button type="button" class="ca-btn" data-ca="close-panel">收起</button>${retry}</div></div>`;
  }

  // 邮件和日历没接入、WeLink 里也读不到邮箱时，在简报上方请用户填一次（只出现这一处，填完就消失）。
  function setupCard() {
    const d = data;
    if (!d.login?.ok || !d.calendarNeedsSetup) return '';
    const auto = d.mailSetup || {};
    const why = auto.reason === 'no-email' ? 'WeLink 账号信息里没读到你的邮箱。' : auto.email ? `用 ${esc(auto.email)} 自动配置没成功${auto.output ? '（' + esc(auto.output) + '）' : ''}。` : '';
    return `<article class="ca-setup"><b>邮件和日历暂不可用</b><p class="ca-note">${why}</p><button class="ca-link" data-ca="calendar">查看连接设置</button></article>`;
  }

  function briefCard() {
    const b = data.brief;
    if (!b) return `<article class="ca-brief empty"><div class="ca-card-head"><b>助理 · 今日简报</b></div><p class="ca-note">今天的简报还没生成。<button type="button" class="ca-btn small primary" data-ca="brief-now">现在生成</button></p></article>`;
    const counts = b.sections.map(s => `<span class="ca-chip${s.key === 'awaiting' ? ' warn' : ''}">${esc(s.title)} ${s.items.length}</span>`).join('');
    const firstItems = b.sections.flatMap(s => s.items.slice(0, 1).map(i => i.text)).slice(0, 2);
    const complete = [data.meetingCoverage, data.calendarCoverage, data.mailCoverage, messageCoverage()].every(c => c?.status === 'complete');
    const headline = b.by === 'none' ? esc(b.note || '') : firstItems.length ? '📌 ' + esc(firstItems.join('；')) : data.errors?.length || !complete ? '本次数据尚未取全，已取到的内容里没有待处理事项。' : '已查询的范围内没有需要你处理的会议、消息和邮件。';
    const more = b.total > 10 ? `<p class="ca-note">另有 ${b.total - 10} 条在下面「其余」里。</p>` : '';
    const row = i => `<div class="ca-item"><div class="ca-item-text">${esc(i.text)}${i.guess ? '<span class="ca-guess">推测</span>' : ''}${i.due ? `<span class="ca-due">截止 ${esc(i.due)}</span>` : ''}</div>
        ${i.preparation ? `<p class="ca-note ca-preparation">会前准备建议：${esc(i.preparation)}</p>` : ''}
        <div class="ca-src"><button type="button" class="ca-link ca-source-link" data-ca="source:${esc(i.source)}" data-source-day="${esc(b.day || data.day)}" title="查看原文和前后消息">${esc(i.sourceLabel || '查看出处')}</button><button type="button" class="ca-link" data-ca="done:${esc(i.source)}" title="点了以后不再出现在简报里">处理了</button></div></div>`;
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
      ${list.map(n => `<div class="ca-notice" data-notice-id="${esc(n.id)}"><span class="ca-chip">${NAMES[n.kind] || n.kind}</span><b>${esc(n.title)}</b><span class="ca-time">${when(n.at)}</span><div class="ca-notice-text">${esc(n.text).replace(/\n/g, '<br>')}</div>${n.detail?.source ? `<button type="button" class="ca-link" data-ca="source:${esc(n.detail.source)}">查看出处</button>` : ''}</div>`).join('')}</details>`;
  }

  function coverageNote() {
    const s = data.scope, errors = data.errors || [], names = data.nameResolution;
    const queryRows = [['会议', data.meetingCoverage, data.counts?.meetings], ['日程', data.calendarCoverage, data.counts?.calendar], ['未读邮件', data.mailCoverage, data.counts?.mails]];
    if (!s && !errors.length && queryRows.every(([, c]) => !c)) return '';
    const counts = s ? `${s.stale ? '上次数据' : '最近 ' + s.lookbackHours + ' 小时'} · ${s.stale ? s.conversations?.length || 0 : s.fetched} 个会话 · ${s.messages} 条消息` : '采集情况';
    const messageScope = messageCoverage();
    const issues = [messageScope?.status === 'partial' ? '消息范围未取全' : '', errors.length ? `${errors.length} 项查询异常` : '', names?.unresolved ? `${names.unresolved} 个发言人姓名未确认` : ''].filter(Boolean);
    const rows = (s?.conversations || []).map(c => `<li><b>${esc(c.name)}</b> · ${c.status === 'complete' ? '读取完成' : '部分结果'} · ${esc(c.reasonLabel || '')}${c.oldestAt ? ' · 最早 ' + when(c.oldestAt) : ''}${c.newestAt ? '，最新 ' + when(c.newestAt) : ''}${c.unknownTime ? ` · ${c.unknownTime} 条缺少时间` : ''}</li>`).join('');
    const queries = [...queryRows, ['消息', messageScope, data.counts?.messages]].map(([name, c, n]) => `<li><b>${name}</b> · ${({ complete: '查询完成', partial: '部分结果', failed: '查询失败' })[c?.status] || '尚未确认'}${c?.status === 'complete' && Number.isInteger(n) ? ` · ${n} 条` : ''}${c?.reasonLabel ? ' · ' + esc(c.reasonLabel) : ''}</li>`).join('');
    return `<details class="ca-coverage"><summary>${esc(counts)}${issues.length ? ' · ' + esc(issues.join('，')) : ''}</summary><ul>${queries}</ul>${s?.stale ? `<p class="ca-note bad">最近会话查询失败。${s.capturedAt ? '以下消息取自 ' + esc(new Date(s.capturedAt).toLocaleString('zh-CN', { hour12: false })) + '，可能已过期。' : '尚无可复用的当前账号聊天记录。'}</p>` : ''}${s ? `<p class="ca-note">本轮列出 ${s.listed || 0} 个最近会话，结合历史目录共检查 ${s.fetched || 0} 个${s.limited ? '（已按设置限制数量）' : ''}；专用手机群不参与简报。查询失败时保留已取到的内容，未覆盖范围会单独提示。</p>` : ''}${errors.map(e => `<p class="ca-note bad">${esc(e.label)}：${esc(e.text)}</p>`).join('')}${rows ? `<ul>${rows}</ul>` : ''}</details>`;
  }

  async function openSource(source, day) {
    const panel = page.querySelector('[data-slot="panel"]');
    panel.dataset.kind = 'source'; panel.dataset.source = source; panel.hidden = false;
    panel.innerHTML = '<div class="ca-source"><div class="ca-source-head"><h2>查看出处</h2><button class="ca-btn" data-ca="close-panel">关闭</button></div><p>正在读取本机原文…</p></div>';
    try {
      const result = await call('source', { source, day: day || data.day });
      if (panel.dataset.kind !== 'source' || panel.dataset.source !== source) return;
      const fullWhen = at => at ? new Date(at).toLocaleString('zh-CN', { hour12: false }) : '时间未提供';
      let body;
      if (result.entry.kind === 'message') {
        body = result.context.map(m => `<article class="ca-source-message${m.sourceId === source ? ' selected' : ''}">
          <div class="ca-source-meta"><b>${esc(m.sender || m.account)}</b><span>${esc(m.account)}</span><time>${esc(fullWhen(m.at))}</time>${m.sourceId === source ? '<span class="ca-chip">这条出处</span>' : ''}</div>
          ${m.nameStatus && m.nameStatus !== 'resolved' && !m.mine ? '<p class="ca-note">姓名尚未确认，账号已保留。</p>' : ''}
          ${m.contentComplete === false ? '<p class="ca-note bad">这是旧版留下的截断内容，刷新数据后会重新补取。</p>' : ''}
          <pre class="ca-source-text">${esc(m.text || m.preview || '消息正文为空')}</pre>
          ${!m.text && m.content ? `<details><summary>原始消息内容</summary><pre class="ca-source-text">${esc(typeof m.content === 'string' ? m.content : JSON.stringify(m.content, null, 2))}</pre></details>` : ''}</article>`).join('');
      } else {
        const m = result.entry.item;
        body = `<h3>${esc(m.subject || result.entry.label)}</h3><p>${esc(m.from || '')} ${esc(fullWhen(m.start || m.at))}${m.end ? ' — ' + esc(fullWhen(m.end)) : ''}</p><p>${esc(m.location || '')}</p>${m.preview ? `<p class="ca-note">以下为邮件预览，可让助理进一步查询完整邮件。</p><pre class="ca-source-text">${esc(m.preview)}</pre>` : ''}`;
      }
      panel.innerHTML = `<div class="ca-source"><div class="ca-source-head"><h2>查看出处</h2><button class="ca-btn" data-ca="close-panel">关闭</button></div><p class="ca-note">${esc(result.entry.label)} · 采集于 ${esc(fullWhen(result.capturedAt))}</p>${result.coverage?.status && result.coverage.status !== 'complete' ? `<p class="ca-note bad">该会话只取到部分消息：${esc(result.coverage.reasonLabel)}</p>` : ''}${body}<p class="ca-note">${result.entry.kind === 'message' ? '显示本机已获取的原文与前后各两条消息。' : '显示本机已获取的这条记录。'}</p></div>`;
      panel.scrollTop = 0; panel.querySelector('[data-ca="close-panel"]').focus();
    } catch (error) {
      if (panel.dataset.kind === 'source' && panel.dataset.source === source) panel.innerHTML = `<div class="ca-source"><div class="ca-source-head"><h2>查看出处</h2><button class="ca-btn" data-ca="close-panel">关闭</button></div><p>${esc(error.message)}</p></div>`;
    }
  }

  function chatList() {
    return (data.chat || []).map(c => {
      const pptLinks = (c.pptResults || []).map(p => `<div class="ca-ppt-reference"><span>${esc(p.name)} · 第 ${esc(p.page)} 页</span><button type="button" class="ca-link" data-ca="ppt-open:${esc(p.id)}">打开到第 ${esc(p.page)} 页</button></div>`).join('');
      const answer = c.state === 'done' ? `<div class="ca-md">${markdown(c.a)}</div>${pptLinks}`
        : c.state === 'error' ? `<p class="ca-note bad">${esc(c.error || '没答上')}<button type="button" class="ca-link" data-ca="retry:${esc(c.id)}">重问</button></p>`
          : `<p class="ca-note run">${c.state === 'queued' ? '排队中…' : '助理正在查…'}</p>`;
      return `<div class="ca-message-row user"><img class="ca-avatar" src="${USER_AVATAR_SRC}" alt="我"><div class="ca-message-content"><div class="ca-card-head"><b>我</b>${c.via === 'phone' ? '<span class="ca-chip">手机</span>' : ''}<span class="ca-time">${when(c.askedAt)}</span></div><div class="ca-msg user"><div class="ca-body">${esc(c.q).replace(/\n/g, '<br>')}</div></div></div></div>
        ${assistantMessage(`<div class="ca-card-head"><b>助理</b>${c.answeredAt ? `<span class="ca-time">${when(c.answeredAt)}</span>` : ''}</div><div class="ca-msg">${answer}</div>`)}`;
    }).join('');
  }

  function render() {
    if (!page || !data) return;
    page.querySelector('.ca-status').innerHTML = status();
    page.querySelector('.ca-capabilities').innerHTML = capabilities();
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
    setHtml('coverage', coverageNote());
    setHtml('brief', assistantMessage(briefCard(), 'ca-brief-row'));
    setHtml('notices', noticesStrip());
    setHtml('rooms', (data.rooms?.events || []).slice(0, 10).map(e => {
      const r = e.record;
      return assistantMessage(`<article class="ca-msg"><div class="ca-card-head"><b>会议室 · ${esc(r['状态'])}</b><span class="ca-time">${when(e.at)}</span></div><p>${esc(e.slot || `${r['日期'] || ''} ${r['时间'] || ''} · ${r['会议室'] || '未选定'}`)}</p>${r['备注'] ? `<p class="ca-note">${esc(r['备注'])}</p>` : ''}</article>`);
    }).join(''));
    const scroll = page.querySelector('.ca-scroll');
    const atBottom = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 40;
    const chat = page.querySelector('[data-slot="chat"]'), html = chatList();
    if (chat.dataset.html !== html) { chat.innerHTML = html; chat.dataset.html = html; if (atBottom) scroll.scrollTop = scroll.scrollHeight; }
    page.querySelector('[data-slot="chips"]').innerHTML = data.chips.map((c, i) => `<button type="button" class="ca-chip-btn${c.custom ? ' custom' : ''}" data-ca="chip:${i}" title="${esc(c.text)}">${esc(c.label)}</button>`).join('') + '<button type="button" class="ca-chip-btn add" data-ca="save-chip" title="把输入框里的问题存成小标签">＋ 存为常用</button>';
    const job = data.job ? (data.job.type === 'brief' ? '助理正在整理简报…' : '助理正在回答…') + (data.queued ? `（还有 ${data.queued} 个排队）` : '') : data.session ? (data.session.open ? '助理会话已就绪' : '助理会话已休息，提问时自动恢复') : '第一次提问时会打开助理会话';
    page.querySelector('[data-slot="job"]').textContent = job;
    page.querySelectorAll('[data-ca="refresh"]').forEach(b => { b.disabled = !!data.refreshing; });
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
    if (verb === 'source') return openSource(arg, button.dataset.sourceDay);
    if (verb === 'retry') { await call('retry-chat', { id: arg }); await load(); return; }
    if (verb === 'login') { button.disabled = true; const panel = page.querySelector('[data-slot="panel"]'); panel.dataset.kind = 'login'; await call('login'); await load(); return; }
    if (verb === 'open-login-url') { const url = data.loginFlow?.url || ''; if (/^https:\/\//i.test(url)) await require('electron').shell.openExternal(url); return; }
    if (verb === 'close-panel') { const panel = page.querySelector('[data-slot="panel"]'); panel.hidden = true; panel.innerHTML = ''; panel.dataset.kind = 'closed'; return; }
    if (verb === 'calendar') return openSettings('welink');
    if (verb === 'settings') return openSettings();
    if (verb === 'ppt-open') {
      button.disabled = true;
      try { const r = await call('ppt-open', { id: arg }); if (r.pageFocused === false) showMessage?.(`已打开文件，请查看第 ${r.page} 页；当前环境未能自动跳页`); }
      catch (error) { showMessage?.(error.message); }
      finally { button.disabled = false; }
      return;
    }
    if (verb === 'ppt-assist') {
      const panel = page.querySelector('[data-slot="panel"]');
      panel.hidden = true; panel.innerHTML = ''; panel.dataset.kind = 'closed';
      if (!input.value.trim()) input.value = '帮我从已有 PPT 中找几页能讲清楚「」的素材，说明推荐理由并附文件路径和页码。';
      input.focus();
      const at = input.value.indexOf('「」'); if (at >= 0) input.setSelectionRange(at + 1, at + 1);
      input.scrollIntoView({ block: 'nearest' });
      return;
    }
    if (verb === 'setup-mail') return setupMail(page.querySelector('[data-f="setup-email"]'), page.querySelector('[data-f="setup-msg"]'), button);
    if (verb === 'settings-tab') return openSettings(arg);
    if (verb === 'open-session') return window.__companyAssistantOpenSession();
    if (verb === 'reopen-session') { button.disabled = true; showMessage?.('正在重开助理会话…'); await call('reopen-session'); await load(); showMessage?.('助理会话已重开，会话工具接上后这里会显示「已接上」'); return; }
    const reopenSettings = () => { const p = page.querySelector('[data-slot="panel"]'); if (p.dataset.kind === 'settings' && !p.hidden) openSettings(); };
    if (verb === 'find-cli') { button.disabled = true; await call('find-cli'); await load(); reopenSettings(); showMessage?.(data.cliFound ? '找到 welink-cli 了' : '全盘也没找到 welink-cli，可以点「手动选择…」'); return; }
    if (verb === 'pick-cli') { const r = await call('pick-cli'); if (!r.canceled) { showMessage?.('已用 ' + r.path); await load(); reopenSettings(); } return; }
  }

  async function setupMail(input, msg, button) {
    if (button) button.disabled = true;
    if (msg) msg.textContent = '正在配置邮件和日历…';
    try {
      const r = await call('setup-calendar', { email: input ? input.value : '' });
      if (msg) msg.textContent = r.needsSetup ? '还没成功：' + (r.output || '请核对邮箱地址') : '邮箱连接已配置；各项查询状态见下方。';
      await load();
    } catch (error) { if (msg) msg.textContent = '没成功：' + error.message; } finally { if (button) button.disabled = false; }
  }

  const TABS = [['brief', '简报与提醒'], ['welink', 'WeLink 与邮箱'], ['phone', '手机'], ['rooms', '抢会议室'], ['ppt', 'PPT 素材库'], ['pet', '桌宠']];
  let petTab = null, phoneTimer = null, phoneData = null, roomsTimer = null;

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
    const options = ['<option value="">从最近会话选择…</option>', ...groups.map(g => `<option value="${esc(g.id)}" data-name="${esc(g.name)}">${esc(g.name)} · ${esc(g.id)}</option>`)].join('');
    const checkLine = check && check.groupId === st.groupId ? `<span class="ca-chip${check.ok ? ' ok' : ' warn'}">${check.ok ? '成员没问题' : '有其他人'}</span><span class="ca-note">${esc(check.note)}</span>` : '';
    return `<fieldset class="col"><legend>接通状态</legend><div data-slot="phone-live">${phoneLive()}</div></fieldset>
      <fieldset class="col"><legend>助理消息群 ID</legend>
        <p class="ca-note">先在 WeLink 建好专用消息群，把群 ID 填在这里。接通后，欢迎消息会发到这个群，之后直接在群里和助理说话。</p>
        <div class="ca-row"><input class="ca-phone-group" data-f="phone-group" type="text" inputmode="numeric" placeholder="粘贴群 ID" aria-label="助理消息群 ID" value="${esc(st.groupId)}"><button type="button" class="ca-btn primary" data-x="phone-connect">接通</button></div>
        <div data-slot="phone-connect-result" role="status"></div>
        <details><summary class="ca-note">不知道群 ID？从最近会话里找</summary><div class="ca-row"><select data-f="phone-recent">${options}</select><button type="button" class="ca-btn small" data-x="phone-refresh">刷新群列表</button></div></details>
        <div class="ca-row"><button type="button" class="ca-btn small" data-x="phone-check">查看群成员</button><span class="ca-note">群内其他人能看到助理的回答，建议用专用群。</span></div>
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
    const chosen = () => {
      const groupId = groupSel.value.trim(), recent = (phoneData.conversations || []).find(g => g.group && g.id === groupId);
      return { groupId, groupName: recent?.name || (groupId === phoneData.phone.settings.groupId ? phoneData.phone.settings.groupName : '') || '' };
    };
    body.querySelector('[data-f="phone-recent"]').onchange = e => { if (e.target.value) groupSel.value = e.target.value; };
    body.querySelector('[data-x="phone-connect"]').onclick = async e => {
      const g = chosen(), slot = body.querySelector('[data-slot="phone-connect-result"]');
      if (!g.groupId) { slot.textContent = '请先填入群 ID'; return; }
      e.target.disabled = true; slot.textContent = '正在发送欢迎消息…';
      try {
        const r = await call('phone-settings', { ...g, enabled: true });
        if (!r.ok) { slot.innerHTML = `<p class="ca-note bad">${esc(r.error)}</p>`; return; }
        await mountPhoneTab(panel); showMessage?.('手机对话已接通');
      } catch (error) { slot.innerHTML = `<p class="ca-note bad">没有接通：${esc(error.message)}</p>`; }
      finally { e.target.disabled = false; }
    };
    body.querySelector('[data-x="phone-refresh"]').onclick = async e => {
      e.target.disabled = true;
      try { await call('refresh'); await mountPhoneTab(panel); showMessage?.('群列表已刷新'); } catch (error) { e.target.disabled = false; showMessage?.('没刷新：' + error.message); }
    };
    body.querySelector('[data-x="phone-check"]').onclick = async e => {
      const g = chosen(); if (!g.groupId) { showMessage?.('请先填群 ID'); return; }
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
      if (on('enabled') && !g.groupId) { showMessage?.('请先填群 ID'); return; }
      e.target.disabled = true;
      try {
        const r = await call('phone-settings', { ...g, enabled: on('enabled'), pushWatched: on('pushWatched'), pushStuck: on('pushStuck') });
        if (!r.ok) { showMessage?.('没有接通：' + r.error); e.target.disabled = false; return; }
        showMessage?.(r.welcome ? '已接通：欢迎消息已发到手机群' : '手机设置已保存');
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
    const loginLine = !d.cliFound ? cliChip(d) + `<span class="ca-note">${d.cliSearch?.state === 'notfound' ? '全盘也没找到：先安装 npm 全局包 @welink/welink-cli；装在特殊位置的，点「手动选择…」选 welink-cli.exe。' : '会自动在常见位置和各个硬盘里找。'}</span>`
      : login?.ok ? `<span class="ca-chip ok">已登录</span><span class="ca-note">账号 ${esc(login.uid || '')}</span>`
        : `<span class="ca-chip warn">${login?.reason === 'expired' ? '登录已过期' : '没登录'}</span><button type="button" class="ca-btn small primary" data-ca="login">扫码登录</button>`;
    const from = s.emailFrom === 'welink' ? '从 WeLink 账号自动读到' : s.email ? '你填写的' : '';
    const errs = d.errors || [];
    const errOf = label => errs.find(e => e.label === label || e.label.startsWith(label));
    const snapRows = [['会议', d.counts?.meetings, d.meetingCoverage], ['日程', d.counts?.calendar, d.calendarCoverage], ['消息', d.counts?.messages, messageCoverage()], ['未读邮件', d.counts?.mails, d.mailCoverage]].map(([label, n, coverage]) => {
      const e = errOf(label);
      return `<div class="ca-src-row"><span>${label}</span>${e || coverage?.status === 'failed' ? `<span class="ca-chip warn">查询失败</span><span class="ca-note">${esc(e?.text || coverage.reasonLabel)}</span>` : coverage?.status === 'partial' ? `<span class="ca-chip warn">未取全</span><span class="ca-note">${esc(coverage.reasonLabel || '')}</span>` : coverage?.status === 'complete' ? `<span class="ca-chip ok">已取到 ${n ?? 0} 条</span>` : '<span class="ca-note">尚未确认</span>'}</div>`;
    }).join('');
    const VIA = { path: '系统路径里找到的', npm: 'npm 全局目录里找到的', disk: '在硬盘里找到的', manual: '你手动选的' };
    const cliLine = d.cliFound ? `<fieldset class="col"><legend>welink-cli 位置</legend><div class="ca-row"><span class="ca-chip ok">已找到</span><span class="ca-note" title="${esc(d.cliPath)}">${esc(d.cliPath)}${VIA[d.cliSearch?.via] ? '（' + VIA[d.cliSearch.via] + '）' : ''}</span></div>
        <div class="ca-row"><button type="button" class="ca-btn small" data-ca="find-cli">重新查找</button><button type="button" class="ca-btn small" data-ca="pick-cli">手动选择…</button></div></fieldset>` : '';
    return `<fieldset><legend>WeLink 登录</legend><div class="ca-row">${loginLine}</div></fieldset>${cliLine}
      <fieldset class="col"><legend>公司邮箱（邮件和日历要用）</legend>
        <div class="ca-row">${s.emailFrom === 'welink' && s.email ? `<span>邮箱（自动读取）：${esc(s.email)}</span>` : `<input type="email" data-f="email" placeholder="自动读取失败，可补填公司邮箱" value="${esc(s.email || '')}">`}<button type="button" class="ca-btn primary" data-x="mail">${d.calendarNeedsSetup ? '配置邮件和日历' : '重新配置'}</button>${from ? `<span class="ca-note">${from}</span>` : ''}</div>
        <p class="ca-note" data-f="mail-msg">${d.calendarNeedsSetup ? '还没接入。' : '已接入。'}只让 welink-cli 按邮箱找一次公司邮件服务器，不发邮件。</p></fieldset>
      <fieldset class="col"><legend>最近一次取数（${d.refreshedAt ? when(d.refreshedAt) : '还没取过'}）</legend>${snapRows}
        <div class="ca-row"><button type="button" class="ca-btn small" data-ca="refresh">刷新数据</button></div></fieldset>
      <fieldset><legend>我的名字（用来认群里 @我）</legend><input type="text" data-f="myName" value="${esc(s.myName)}" placeholder="WeLink 里的显示名"><button type="button" class="ca-btn small" data-x="name">保存</button></fieldset><p class="ca-note">WeLink 数据只留在本机。</p>`;
  }

  function briefTab() {
    const s = data.settings, sc = data.scope;
    const opts = (list, cur, fmt = x => x) => list.map(x => `<option value="${x}"${String(x) === String(cur) ? ' selected' : ''}>${fmt(x)}</option>`).join('');
    // 2026-10-18：不再手动勾「关注群」，默认取回看时间内所有私聊和群。免打扰、置顶 welink-cli 拿不到（Q-1018-10），不做这两个设置。
    const last = sc ? `上次取到 ${sc.withMessages} 个会话（私聊 ${sc.p2p}、群 ${sc.withMessages - sc.p2p}）共 ${sc.messages} 条消息${sc.limited ? `，按设置只取了最近 ${sc.maxConversations} 个会话` : ''}。` : '还没取过数据：先扫码登录、点「刷新数据」。';
    return `<fieldset class="col"><legend>聊天记录范围（简报、提醒和对话都用这份数据）</legend>
        <div class="ca-row"><label>回看最近<select data-f="lookbackHours">${opts([12, 24, 36, 48, 72], s.lookbackHours, x => x + ' 小时')}</select></label>
          <label>会话个数<select data-f="maxConversations">${opts([0, 10, 20, 30], s.maxConversations, x => (Number(x) ? '最近 ' + x + ' 个' : '全部（默认）'))}</select></label></div>
        <p class="ca-note">默认查询最近 100 个会话，并补查历史已知会话；旧 CLI 会尝试兼容查询。每个会话按回看时间翻页，未取全会显示原因。目录外从未发现的会话仍可能遗漏。WeLink 的免打扰、置顶信息暂不可用。</p>
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
      <fieldset class="col"><legend>助理记忆</legend><div data-slot="assistant-memory"><p class="ca-note">正在读取…</p></div></fieldset>
      <div class="ca-row end"><button type="button" class="ca-btn primary" data-x="save">保存</button></div>`;
  }

  async function mountPptTab(panel) {
    const body = panel.querySelector('.ca-tab-body');
    body.innerHTML = '<p class="ca-note">正在检查本机 PPT 文字索引…</p>';
    let p;
    try { p = (await call('ppt-status')).ppt; }
    catch (error) { if (body.isConnected) body.innerHTML = `<p class="ca-note bad">${esc(error.message)}</p>`; return; }
    if (!body.isConnected || panel.dataset.tab !== 'ppt') return;
    const indexing = p.indexing || {}, busy = indexing.state === 'indexing';
    const scanLine = busy ? `正在更新：已检查 ${indexing.scanned || 0} 份，新增或更新 ${indexing.indexed || 0} 份。` : indexing.completedAt ? `上次更新 ${when(indexing.completedAt)}：新增或更新 ${indexing.indexed || 0} 份，未变化 ${indexing.unchanged || 0} 份，跳过旧版 .ppt ${indexing.skippedPpt || 0} 份${indexing.failed ? `，${indexing.failed} 份读取失败` : ''}。` : '选择目录后会在后台建立文字索引，之后自动检查文件变化。';
    body.innerHTML = `<fieldset class="col"><legend>在我做过的 PPT 里找页</legend><p class="ca-note">${p.available ? `已索引 ${p.files} 份文稿、${p.pages} 页。` : '还没有素材索引。选择自己的 PPT 文件夹即可使用。'}</p>
      ${p.error ? `<p class="ca-note bad">${esc(p.error)}</p>` : ''}<p class="ca-note">在对话里说清用途，助理会扩展查询、读原页并按用途推荐，附文件路径和页码。</p>
      <div class="ca-row"><button class="ca-btn primary" data-ca="ppt-assist">去对话里找素材</button><button class="ca-link" data-x="ppt-refresh">重新检查</button></div>
      <p class="ca-note">例如：帮我找几页适合向新同事讲混合波束成形的材料，重点解释少量射频链怎么配合多天线。</p>
      <p class="ca-note">依据已提取文字检索；图表、版式和可编辑性需要打开原稿核查。</p>
      </fieldset><fieldset class="col"><legend>素材文件夹</legend><p class="ca-note">只检索你选择的 1–3 个文件夹及其子目录，不改动原稿。支持 .pptx；旧版 .ppt 会标明跳过数量。</p>
      ${(p.roots || []).map(root => `<p class="ca-ppt-path">${esc(root)}</p>`).join('')}
      <div class="ca-row"><button class="ca-btn" data-x="ppt-folders"${busy ? ' disabled' : ''}>${p.roots?.length ? '更换素材文件夹…' : '选择素材文件夹…'}</button><button class="ca-btn" data-x="ppt-index"${busy || !p.roots?.length ? ' disabled' : ''}>更新索引</button></div>
      <p class="ca-note${busy ? ' run' : ''}" role="status">${esc(scanLine)}</p>${indexing.error ? `<p class="ca-note bad">${esc(indexing.error)}</p>` : ''}
      ${(indexing.errors || []).length ? `<details><summary>${indexing.errors.length} 项未完成，展开查看原因</summary>${indexing.errors.map(e => `<p class="ca-note bad">${esc(e.path)}：${esc(e.error)}</p>`).join('')}</details>` : ''}
      </fieldset><fieldset class="col"><legend>已有 PPT Doctor 索引（可选）</legend><p class="ca-note">如果本机已有索引，可以一起检索。</p><p class="ca-ppt-path">${esc(p.db)}</p><button class="ca-btn" data-x="ppt-pick">选择已有索引…</button></fieldset>`;
    body.querySelector('[data-x="ppt-pick"]').onclick = async () => { try { await call('ppt-pick-index'); await mountPptTab(panel); await load(); } catch (error) { showMessage?.(error.message); } };
    body.querySelector('[data-x="ppt-refresh"]').onclick = () => { void mountPptTab(panel); };
    for (const [selector, channel] of [['ppt-folders', 'ppt-pick-folders'], ['ppt-index', 'ppt-index']]) {
      body.querySelector(`[data-x="${selector}"]`).onclick = async event => {
        event.currentTarget.disabled = true;
        try { await call(channel); await mountPptTab(panel); await load(); }
        catch (error) { showMessage?.(error.message); if (body.isConnected) await mountPptTab(panel); }
      };
    }
    if (busy) setTimeout(() => { if (body.isConnected && !panel.hidden && panel.dataset.tab === 'ppt') void mountPptTab(panel); }, 1500);
  }

  async function mountRoomsTab(panel) {
    clearInterval(roomsTimer); roomsTimer = null;
    const body = panel.querySelector('.ca-tab-body');
    body.innerHTML = '<p class="ca-note run" role="status">正在准备抢会议室功能，首次可能需要约 2 分钟。可以先使用助理的其他功能。</p>';
    let r;
    try { r = (await call('room-connect')).rooms; }
    catch (error) {
      if (body.isConnected && panel.dataset.tab === 'rooms') {
        body.innerHTML = `<p class="ca-note bad">准备未完成：${esc(error.message)}</p><button class="ca-btn" data-room-retry>重试</button>`;
        body.querySelector('[data-room-retry]').onclick = () => { void mountRoomsTab(panel); };
      }
      return;
    }
    if (!body.isConnected || panel.dataset.tab !== 'rooms') return;
    const rules = r.rules || { '主题': '日常会议', '开始时间': '14:00', '时长小时': 2, '时长分钟': 0, '优先会议室': [], '抢订日': [1, 2, 3, 4, 5] };
    body.innerHTML = `<fieldset class="col"><legend>抢会议室</legend><p data-slot="room-live">${r.preparing ? '正在准备…' : r.connected ? r.running ? '正在守护' : '已就绪' : '暂未准备好'}</p>
      <p class="ca-note">每天开放时抢七天后的同一天。暂不支持指定明天等单次日期。</p>
      ${r.error ? `<p class="ca-note bad">${esc(r.error)}</p>` : ''}</fieldset>
      <fieldset class="col"><legend>抢订规则</legend>
        <label>主题<input type="text" data-room="主题" value="${esc(rules['主题'])}"></label>
        <div class="ca-row"><label>开始时间<input type="time" data-room="开始时间" value="${esc(rules['开始时间'])}"></label><label>时长（小时）<input type="number" min="0.5" max="12" step="0.5" data-room="duration" value="${Number(rules['时长小时']) + Number(rules['时长分钟']) / 60}"></label></div>
        <label>优先会议室<input type="text" data-room="rooms" placeholder="用逗号分隔，先填的优先" value="${esc(rules['优先会议室'].join('，'))}"></label>
        <div class="ca-row">${['一', '二', '三', '四', '五', '六', '日'].map((name, i) => `<label><input type="checkbox" data-room-day="${i + 1}"${rules['抢订日'].includes(i + 1) ? ' checked' : ''}>周${name}</label>`).join('')}</div>
        <p class="ca-note">有任务运行时先暂停，待浏览器退出后再改规则；会后动作沿用现有设置。</p>
      </fieldset><fieldset class="col"><legend>会议室网页登录</legend><p class="ca-note">${r.loginNeeded ? '会议室网页需要重新登录。' : '抢订前会自动检查登录状态。'}它与 WeLink 消息登录相互独立。</p>
        <div class="ca-row"><button class="ca-btn" data-room-op="login"${r.connected && !r.running ? '' : ' disabled'}>打开登录</button><button class="ca-btn" data-room-op="test"${r.connected && !r.running ? '' : ' disabled'}>测试填表（不提交）</button></div></fieldset>
      <p class="ca-note" data-slot="room-msg" aria-live="polite"></p><div class="ca-row end">
        <button class="ca-btn" data-room-op="pause"${r.connected ? '' : ' disabled'}>暂停</button><button class="ca-btn" data-room-op="save"${r.connected && !r.running ? '' : ' disabled'}>保存规则</button><button class="ca-btn primary" data-room-op="start"${r.connected && !r.running ? '' : ' disabled'}>开始守护</button>
      </div>`;
    let acting = false;
    body.onclick = async event => {
      const button = event.target.closest('[data-room-op]'); if (!button) return;
      if (acting) return;
      const op = button.dataset.roomOp, msg = body.querySelector('[data-slot="room-msg"]');
      acting = true; button.disabled = true; msg.textContent = '正在处理…';
      try {
          if (op === 'save' || op === 'start') {
            const v = key => body.querySelector(`[data-room="${key}"]`).value;
            const duration = Number(v('duration'));
            await call('room-command', { op: 'configure', rules: {
              '主题': v('主题'), '开始时间': v('开始时间'), '时长小时': Math.floor(duration), '时长分钟': (duration % 1) * 60,
              '优先会议室': v('rooms').split(/[,，、]/).map(s => s.trim()).filter(Boolean),
              '抢订日': [...body.querySelectorAll('[data-room-day]:checked')].map(e => Number(e.dataset.roomDay)),
            } });
          }
          if (op !== 'save') await call('room-command', { op });
        await mountRoomsTab(panel); await load(); showMessage?.(op === 'pause' ? '已请求暂停，浏览器退出后即可改规则' : '已接收');
      } catch (error) { msg.textContent = error.message; button.disabled = false; }
      finally { acting = false; }
    };
    roomsTimer = setInterval(async () => {
      if (panel.hidden || panel.dataset.tab !== 'rooms' || !body.isConnected) { clearInterval(roomsTimer); roomsTimer = null; return; }
      if (acting) return;
      try {
        const latest = (await call('room-status')).rooms;
        body.querySelector('[data-slot="room-live"]').textContent = latest.error || (latest.preparing ? '正在准备…' : !latest.connected ? '暂未准备好' : latest.running ? '正在守护' : '已就绪');
        for (const b of body.querySelectorAll('[data-room-op]')) {
          if (['save', 'start', 'test', 'login'].includes(b.dataset.roomOp)) b.disabled = !latest.connected || latest.running || latest.loginBusy;
          if (b.dataset.roomOp === 'pause') b.disabled = !latest.connected;
        }
      } catch (error) { body.querySelector('[data-slot="room-msg"]').textContent = '状态刷新失败：' + error.message; }
    }, 3000);
  }

  function openSettings(tab) {
    const panel = page.querySelector('[data-slot="panel"]');
    const current = TABS.some(([k]) => k === tab) ? tab : (panel.dataset.kind === 'settings' && panel.dataset.tab) || 'brief';
    panel.dataset.kind = 'settings'; panel.dataset.tab = current; panel.hidden = false;
    // 面板定位在 ca-main 内，保留侧栏可操作。
    const s = data.settings;
    panel.innerHTML = `<div class="ca-settings" role="dialog" aria-label="助理设置">
      <div class="ca-settings-head"><h3>助理设置</h3><div class="ca-tabs" role="tablist">${TABS.map(([k, label]) => `<button type="button" role="tab" class="ca-tab${k === current ? ' on' : ''}" aria-selected="${k === current}" data-ca="settings-tab:${k}">${label}</button>`).join('')}</div>
        <button type="button" class="ca-btn small" data-ca="close-panel">关闭</button></div>
      <div class="ca-tab-body" data-tab="${current}">${current === 'brief' ? briefTab() : current === 'welink' ? welinkTab() : current === 'pet' ? '<div data-slot="pet-tab"></div>' : ''}</div></div>`;
    if (current !== 'phone') { clearInterval(phoneTimer); phoneTimer = null; }
    if (current !== 'rooms') { clearInterval(roomsTimer); roomsTimer = null; }
    if (current === 'phone') { petTab = null; void mountPhoneTab(panel); return; }
    if (current === 'ppt') { petTab = null; void mountPptTab(panel); return; }
    if (current === 'rooms') { petTab = null; void mountRoomsTab(panel); return; }
    if (current === 'pet') {
      const host = panel.querySelector('[data-slot="pet-tab"]');
      try { petTab = require('./hub-pet/pet-settings-tab.js').mountPetSettingsTab(host, { ipcRenderer, window, document }); }
      catch (error) { host.innerHTML = `<p class="ca-note">桌宠设置没能打开：${esc(error.message)}</p>`; }
      return;
    }
    petTab = null;
    if (current === 'brief') require('./company-assistant-memory').mountMemory(panel.querySelector('[data-slot="assistant-memory"]'), { call, showMessage });
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
    build(); closeOtherPanels(); window.__assistantHide?.(); window.__wirelessHide?.(); window.__companyForumHide?.();
    // 规则、写作、研究等整页面板也关掉（同云端页），不然从这些页切过来会叠在一起。
    for (const name of ['__rulesHide', '__writingHide', '__xresearchHide', '__studyHide', '__ranHide']) window[name]?.(); window.setShellNavActive?.('company-assistant');
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
    clearInterval(timer); timer = null; clearInterval(phoneTimer); phoneTimer = null; clearInterval(roomsTimer); roomsTimer = null; window.removeEventListener('resize', onResize);
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
