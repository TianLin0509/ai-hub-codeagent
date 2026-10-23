'use strict';

const TEAM_TABS = [['today', '今日关注'], ['members', '成员'], ['weekly', '周报'], ['commitments', '分工与承诺'], ['tools', '工具']];
const TEAM_TOOLS = [
  ['captain', '员工晴雨表', '整理团队关注与一对一沟通'],
  ['weekly', '团队周报', '查看既有周报与提交入口'],
  ['ai-team', 'AI 特战队', '团队进展与协作'],
  ['reports', '工作汇报', '已有汇报与归档'],
  ['style', '工作风格地图', '了解协作偏好'],
  ['tools', '管理工具台', '浏览全部管理工具'],
];
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const when = value => { if (!value) return '时间未知'; const d = new Date(value); return Number.isNaN(d.getTime()) ? String(value) : d.toLocaleString('zh-CN', { hour12: false }); };

function createTeamPage({ document, window, ipcRenderer, closeOtherPanels = () => {}, showMessage }) {
  let page, content, data, tab = 'today', busy = '', error = '', notice = '', resolution = null;
  let webId = null, webStatus = '', webEpoch = 0, loadEpoch = 0, observer;
  let editingCommitment = null;
  let verifyingIdentity = false;
  let scopeDirty = false, preparingMember = null;
  const drafts = { memberInput: '', commitmentTitle: '', commitmentMember: '', commitmentEdit: '', commitmentSources: [], scope: 'all', weekly: {} };
  const isOpen = () => !!page && !page.hidden;
  const memberName = id => data?.members?.find(m => m.id === id)?.name || '未指定成员';
  const btn = (action, label, attrs = '') => `<button type="button" class="tp-btn${attrs.includes('data-primary') ? ' primary' : ''}" data-team="${esc(action)}" ${attrs}>${label}</button>`;
  const empty = text => `<p class="tp-empty">${esc(text)}</p>`;
  const disabled = () => busy || data?.busy || !data?.available || verifyingIdentity ? 'disabled' : '';
  const canRead = () => !!data?.available && !busy && !data?.busy && !verifyingIdentity;
  async function call(channel, payload) {
    const result = await ipcRenderer.invoke(channel, payload);
    if (!result || result.ok === false) throw new Error(result?.error || '没有收到结果，请重试。');
    return result;
  }
  function acceptState(next) {
    if (!data || data.owner !== next.owner) { scopeDirty = false; preparingMember = null; }
    if (data && data.owner !== next.owner) {
      resolution = null; editingCommitment = null;
      drafts.memberInput = ''; drafts.commitmentTitle = ''; drafts.commitmentMember = ''; drafts.commitmentEdit = ''; drafts.commitmentSources = []; drafts.weekly = {};
    }
    data = next;
    verifyingIdentity = false;
    if (!scopeDirty) drafts.scope = next.settings?.scope || 'all';
  }
  function build() {
    if (page) return;
    page = document.createElement('section'); page.id = 'team-page'; page.className = 'team-page'; page.hidden = true;
    page.setAttribute('aria-label', '团队');
    page.innerHTML = `<header class="tp-head"><div><h1>团队</h1><p>从工作事实出发，关注成员，跟进承诺</p></div><div class="tp-head-actions">${btn('assistant', '打开助理')}${btn('reload', '刷新状态')}</div></header>
      <div class="tp-layout"><nav class="tp-nav" aria-label="团队功能">${TEAM_TABS.map(([id, title]) => btn('tab', esc(title), `data-tab="${id}"`)).join('')}<p>个人管理空间<br>聊天与分析保留本机</p></nav><div class="tp-main"><div class="tp-status" aria-live="polite"></div><div class="tp-feedback" role="status" aria-live="polite"></div><main class="tp-content"></main></div></div>`;
    content = page.querySelector('.tp-content'); document.body.append(page);
    page.addEventListener('click', event => {
      const button = event.target.closest('[data-team]');
      if (button && !button.disabled) void action(button).catch(e => { error = e.message; render(); });
    });
    page.addEventListener('input', event => {
      const input = event.target;
      if (input.dataset.draft) drafts[input.dataset.draft] = input.value;
      if (input.dataset.draft === 'scope') scopeDirty = true;
      if (input.dataset.weekly) drafts.weekly[input.dataset.weekly] = input.value;
    });
    page.addEventListener('change', event => { if (event.target.dataset.draft) drafts[event.target.dataset.draft] = event.target.value; if (event.target.dataset.draft === 'scope') scopeDirty = true; });
    if (window.ResizeObserver) { observer = new window.ResizeObserver(() => { place(); syncBounds(); }); observer.observe(document.body); observer.observe(content); }
    window.addEventListener('resize', onResize);
  }
  function place() {
    if (!isOpen()) return;
    const rail = document.getElementById('scene-rail'), toolbar = document.getElementById('app-toolbar');
    const left = rail && rail.getBoundingClientRect().width > 0 ? rail.getBoundingClientRect().right : 0;
    const top = toolbar ? toolbar.getBoundingClientRect().bottom : 0;
    const bodyRect = document.getElementById('app-body')?.getBoundingClientRect();
    const bottom = bodyRect?.height > 0 ? Math.max(0, window.innerHeight - bodyRect.bottom) : 0;
    Object.assign(page.style, { left: `${Math.max(0, left)}px`, top: `${Math.max(0, top)}px`, bottom: `${bottom}px` });
  }
  function onResize() { place(); syncBounds(); }
  function bounds() {
    const rect = page?.querySelector('.tp-web-slot')?.getBoundingClientRect();
    if (!rect || rect.width < 1 || rect.height < 1) return null;
    return { x: Math.round(rect.left), y: Math.round(rect.top), width: Math.round(rect.width), height: Math.round(rect.height) };
  }
  function syncBounds() {
    if (!isOpen() || !webId) return;
    const b = bounds(); if (b) void call('team:web-bounds', { bounds: b }).catch(e => { webStatus = e.message; renderWebStatus(); });
  }
  function stopWeb() {
    ++webEpoch; webId = null; webStatus = '';
    void call('team:web-close').catch(e => { if (isOpen()) { error = '关闭工具页面失败：' + e.message; render(); } });
  }
  async function openWeb(id, { reload = false } = {}) {
    if (!TEAM_TOOLS.some(t => t[0] === id)) return;
    stopWeb(); const epoch = ++webEpoch;
    webId = id; webStatus = '正在打开管理工具…'; content.innerHTML = ''; render();
    const b = bounds();
    if (!b) { webId = null; throw new Error('工具区域还未就绪，请重试。'); }
    try { const result = await call('team:web-open', { id, bounds: b, reload }); if (epoch === webEpoch && result.phase) onWebState(null, result); }
    catch (e) { if (epoch === webEpoch) { webStatus = e.message; renderWebStatus(); } }
  }
  function renderWebStatus() { const el = page?.querySelector('.tp-web-status'); if (el) el.textContent = webStatus; }
  function coverage(c) {
    if (!c) return '<p class="tp-warning">尚未采集，不能判断成员状态。</p>';
    const reasons = [...(Array.isArray(c.reasons) ? c.reasons : []), ...[...(Array.isArray(c.failures) ? c.failures : []), ...(Array.isArray(c.errors) ? c.errors : [])].map(f => typeof f === 'string' ? f : f.error || f.reason || f.message || '部分会话采集失败')];
    return `<div class="tp-coverage ${c.status === 'complete' ? '' : 'tp-warning'}"><strong>${c.status === 'complete' ? '本次采集已完成，仍只覆盖当前账号可见范围' : '覆盖不完整：请先核对缺口，不作总体判断'}</strong>${reasons.length ? `<ul>${reasons.map(r => `<li>${esc(r)}</li>`).join('')}</ul>` : ''}${c.note || c.limitation ? `<p>${esc(c.note || c.limitation)}</p>` : ''}${c.scanned != null ? `<p class="tp-meta">已扫描 ${esc(c.scanned)} 个会话${c.knownConversations != null ? ' / 已知 ' + esc(c.knownConversations) + ' 个' : ''}${c.unknownTime ? '；时间未知 ' + esc(c.unknownTime) + ' 条' : ''}</p>` : ''}${Array.isArray(c.details) && c.details.length ? `<details><summary>查看覆盖明细</summary><ul>${c.details.map(d => `<li>${esc(typeof d === 'string' ? d : JSON.stringify(d))}</li>`).join('')}</ul></details>` : ''}</div>`;
  }
  function facts(list, allowFollowup = true) {
    if (!list.length) return empty('当前范围没有可展示的原文；这不代表成员没有困难。');
    return list.map(e => `<article class="tp-fact"><div class="tp-row"><strong>${esc(e.sender || memberName(e.memberId))}</strong><span class="tp-meta">${esc(e.convName || '来源会话')} · ${esc(e.timeDisplay || when(e.at))}</span></div><blockquote>${esc(e.text)}</blockquote><details><summary>出处与相邻上下文</summary><p class="tp-meta">消息标识：${esc(e.sourceId)}</p>${(e.context || []).map(c => `<p class="tp-context">${esc(typeof c === 'string' ? c : `${c.sender || ''} ${c.timeDisplay || when(c.at)}\n${c.text || ''}`)}</p>`).join('') || '<p class="tp-meta">未提供相邻上下文，请谨慎解读单条原文。</p>'}</details>${allowFollowup ? btn('fact.prepare', '据此记录跟进', `data-source="${esc(e.sourceId)}" ${disabled()}`) : ''}</article>`).join('');
  }
  function analyses(list) {
    if (!list.length) return empty('尚未生成分析。采集后可生成基于原文的工作关注建议。');
    return list.map(a => `<article class="tp-analysis"><div class="tp-row"><strong>${a.historical ? '历史 AI 分析 · ' : 'AI 分析 · '}${esc((a.memberIds || []).map(memberName).join('、') || '团队')}</strong><span class="tp-meta">${esc(({ queued: '等待分析', running: '分析中', done: '已生成，待你核实', error: '分析失败' })[a.state] || a.state)} · ${esc(when(a.createdAt))}</span></div>${a.historical ? '<p class="tp-warning">历史采集的分析，仅供回看，不代表当前状态。</p>' : ''}${coverage(a.coverage)}${a.error ? `<p class="tp-warning">${esc(a.error)}</p>` : ''}${a.text ? `<pre>${esc(a.text)}</pre>` : '<p class="tp-meta">分析在独立会话中进行，点击“读取分析结果”更新进展。</p>'}<details><summary>依据原文（${(a.sourceIds || []).length} 条）</summary>${facts((a.evidence || data.evidence || []).filter(e => (a.sourceIds || []).includes(e.sourceId)), !a.historical)}</details><p class="tp-meta">分析是待核实的建议，不是事实或人员评价。</p></article>`).join('');
  }
  function today() {
    const active = (data.members || []).filter(m => m.active !== false), open = (data.commitments || []).filter(c => c.status === 'open');
    return `<div class="tp-title"><div><h2>今日关注</h2><p>把求助与阻塞变成可跟进的行动，也记住自己答应协调的事。</p></div>${btn('refresh', '采集最近 7 天', canRead() ? 'data-primary' : 'disabled')}</div>
      <div class="tp-metrics"><div><strong>${active.length}</strong><span>关注成员</span></div><div><strong>${open.length}</strong><span>待跟进承诺</span></div><div><strong>${(data.evidence || []).length}</strong><span>本次保留原文</span></div></div>
      <section class="tp-section"><div class="tp-row"><h3>采集范围与缺口</h3><span class="tp-meta">${data.lastRefresh ? '最近采集 ' + esc(when(data.lastRefresh.at)) : '还未采集'}</span></div>${coverage(data.lastRefresh?.coverage)}<p class="tp-meta">仅整理当前 WeLink 账号有权查看的会话。发言少、没有回复或零条消息，都不能用于判断情绪。</p></section>
      <section class="tp-section"><div class="tp-row"><h3>需要你核实的线索</h3><div class="tp-actions">${btn('analyze', '生成分析', canRead() && active.length ? '' : 'disabled')}${btn('analysis.sync', '读取分析结果', disabled())}</div></div>${analyses((data.analyses || []).filter(a => !a.historical).slice(-8).reverse())}</section>
      <section class="tp-section"><div class="tp-row"><h3>未完成的承诺</h3>${btn('tab', '查看全部', 'data-tab="commitments"')}</div>${open.length ? open.slice(0, 8).map(c => `<div class="tp-list-row"><div><strong>${esc(c.title)}</strong><p class="tp-meta">${esc(memberName(c.memberId))}</p></div>${btn('commitment.done', '标记完成', `data-id="${esc(c.id)}" ${disabled()}`)}</div>`).join('') : empty('没有已确认的待跟进事项。')}</section>`;
  }
  function preparation(member) {
    const ownEvidence = (data.evidence || []).filter(e => e.memberId === member.id && e.account === member.account);
    const open = (data.commitments || []).filter(c => c.memberId === member.id && c.status === 'open');
    // Multi-person analyses have no finding-level member IDs. Do not assign
    // their conclusions to one person merely because they were in the batch.
    const latest = (data.analyses || []).filter(a => !a.historical && a.state === 'done' && a.memberIds?.length === 1 && a.memberIds[0] === member.id).slice(-1);
    const memberCoverage = ownEvidence.length ? data.lastRefresh?.coverage : { status: 'partial', reasons: ['本次没有该成员可引用的原文，无法据此判断成员状态。'] };
    return `<div class="tp-title"><div><h2>${esc(member.name)} · 沟通准备</h2><p>先看还未兑现的承诺，再核对交流中的具体问题。</p></div>${btn('member.back', '← 返回成员')}</div>
      <div class="tp-prep-summary"><span>账号：${esc(member.account)}</span><span>最近采集：${esc(when(data.lastRefresh?.at))}</span><span>${open.length} 项未完成承诺 · ${ownEvidence.length} 条本人原文</span></div>
      ${coverage(memberCoverage)}<p class="tp-meta">仅汇总当前成员已有资料；不发起 AI 分析，不发送消息。历史分析和多人分析不纳入本页。</p>
      <section class="tp-section"><div class="tp-row"><h3>还需要跟进的承诺</h3>${btn('tab', '查看分工与承诺', 'data-tab="commitments"')}</div>${open.length ? open.map(c => `<article class="tp-prep-commitment"><div class="tp-list-row"><div><strong>${esc(c.title)}</strong><p class="tp-meta">更新于 ${esc(when(c.updatedAt || c.createdAt))}</p></div>${btn('commitment.done', '标记完成', `data-id="${esc(c.id)}" ${disabled()}`)}</div>${(c.sourceIds || []).length ? `<details><summary>关联原文 · 确认时的记录</summary>${facts((c.evidence || []).filter(e => e.memberId === member.id && e.account === member.account && c.sourceIds.includes(e.sourceId)), false)}</details>` : '<p class="tp-meta">人工记录，未关联聊天出处。</p>'}</article>`).join('') : empty('当前没有该成员的未完成承诺。')}</section>
      <section class="tp-section"><h3>最近一次单人分析 · 待你核实</h3>${latest.length ? analyses(latest) : empty('还没有本次采集对应的单人分析；可以先看原文，回成员页后按需发起分析。')}</section>
      <section class="tp-section"><h3>当前采集的本人原文</h3><p class="tp-meta">相邻上下文可能包含其他人的发言，保留说话人和时间，不当作该成员的表态。</p><details><summary>展开 ${ownEvidence.length} 条原文与出处</summary>${facts(ownEvidence)}</details></section>`;
  }
  function members() {
    const selected = (data.members || []).find(m => m.id === preparingMember);
    if (selected) return preparation(selected);
    return `<div class="tp-title"><div><h2>成员</h2><p>先核对账号，再关注；同名联系人不会自动合并。</p></div></div><div class="tp-form"><label>组员 ID / 账号<input data-draft="memberInput" value="${esc(drafts.memberInput)}" placeholder="输入工号或 WeLink 账号" autocomplete="off"></label>${btn('resolve', '查找成员', canRead() ? 'data-primary' : 'disabled')}</div>
      ${resolution ? `<section class="tp-section"><h3>请确认对应的成员账号</h3>${(resolution.candidates || []).length ? resolution.candidates.map(c => `<div class="tp-list-row"><div><strong>${esc(c.name)}</strong><p class="tp-meta">账号：${esc(c.account)}${c.workId ? ' · 工号：' + esc(c.workId) : ''}</p></div>${btn('follow', '确认并关注', `data-account="${esc(c.account)}" ${disabled()}`)}</div>`).join('') : empty('没有找到可确认的成员，请核对输入或稍后重试。')}</section>` : ''}
      <section class="tp-section"><h3>已关注成员</h3>${(data.members || []).length ? (data.members || []).map(m => `<article class="tp-member"><div class="tp-row"><div><strong>${esc(m.name)}</strong><span class="tp-meta">${m.active === false ? ' · 已暂停关注' : ''}</span><p class="tp-meta">账号：${esc(m.account)}${m.workId ? ' · 工号：' + esc(m.workId) : ''}</p></div><div class="tp-actions">${btn('member.prepare', '沟通准备', `data-id="${esc(m.id)}" ${disabled()}`)}${m.active === false ? btn('restore', '恢复关注', `data-id="${esc(m.id)}" ${disabled()}`) : btn('analyze', '分析近期交流', `data-id="${esc(m.id)}" ${canRead() ? '' : 'disabled'}`) + btn('unfollow', '暂停关注', `data-id="${esc(m.id)}" ${disabled()}`)}</div></div><details><summary>工作原文与分析</summary>${analyses((data.analyses || []).filter(a => (a.memberIds || []).includes(m.id)).slice(-1))}<h4>采集原文</h4>${facts((data.evidence || []).filter(e => e.memberId === m.id))}</details></article>`).join('') : empty('还没有关注成员。输入 ID，核对账号后开始。')}</section>
      <section class="tp-section"><h3>采集设置</h3><div class="tp-form"><label>本次采集范围<select data-draft="scope"><option value="all"${drafts.scope === 'all' ? ' selected' : ''}>当前账号可见会话</option><option value="private"${drafts.scope === 'private' ? ' selected' : ''}>仅私聊</option></select></label>${btn('settings.scope', '保存为默认', disabled())}${btn('refresh', '立即采集', canRead() ? '' : 'disabled')}</div><div class="tp-actions">${btn('settings.auto', data.settings?.autoRefresh ? '关闭定时采集' : '开启每日采集', disabled())}<span class="tp-meta">${data.settings?.autoRefresh ? '每 ' + esc(data.settings.intervalHours || 24) + ' 小时采集一次' : '当前仅在手动点击时采集'}</span></div></section>`;
  }
  function weekly() {
    return `<div class="tp-title"><div><h2>周报草稿</h2><p>由已确认的工作事项整理，修改后保存；不会自动提交到云端。</p></div><div class="tp-actions">${btn('weekly.draft', '生成草稿', disabled())}${btn('web', '打开团队周报', 'data-tool="weekly"')}</div></div>${(data.weeklyDrafts || []).length ? (data.weeklyDrafts || []).slice().reverse().map(d => `<section class="tp-section"><div class="tp-row"><h3>草稿 · ${esc(when(d.createdAt))}</h3>${btn('weekly.save', '保存修改', `data-id="${esc(d.id)}" ${disabled()}`)}</div><label class="tp-sr" for="tp-weekly-${esc(d.id)}">周报草稿正文</label><textarea id="tp-weekly-${esc(d.id)}" class="tp-weekly-editor" data-weekly="${esc(d.id)}">${esc(drafts.weekly[d.id] ?? d.text)}</textarea><p class="tp-meta">仅保存到本机；请在既有周报页自行确认提交。</p></section>`).join('') : empty('还没有周报草稿。先在“分工与承诺”里确认工作事项，再生成。')}`;
  }
  function commitments() {
    return `<div class="tp-title"><div><h2>分工与承诺</h2><p>记录成员待办，也记录你答应解决的困难。只有明确确认的事项进入周报。</p></div></div><div class="tp-form tp-commitment-form"><label class="tp-grow">已确认的工作事项<input data-draft="commitmentTitle" value="${esc(drafts.commitmentTitle)}" placeholder="例如：周五前协调接口联调窗口" maxlength="1000"></label><label>关联成员<select data-draft="commitmentMember"><option value="">未指定</option>${(data.members || []).map(m => `<option value="${esc(m.id)}"${drafts.commitmentMember === m.id ? ' selected' : ''}>${esc(m.name)}</option>`).join('')}</select></label>${btn('commitment.add', '确认并记录', disabled())}</div>
      <section class="tp-section">${(data.commitments || []).length ? data.commitments.slice().reverse().map(c => `<article class="tp-commitment"><div class="tp-row"><div><span class="tp-tag">${esc(({ open: '待跟进', done: '已完成', cancelled: '已取消' })[c.status] || c.status)}</span><strong>${esc(c.title)}</strong><p class="tp-meta">${esc(memberName(c.memberId))} · 更新于 ${esc(when(c.updatedAt || c.createdAt))}</p></div><div class="tp-actions">${btn('commitment.edit', '编辑', `data-id="${esc(c.id)}" ${disabled()}`)}${btn(c.status === 'open' ? 'commitment.done' : 'commitment.reopen', c.status === 'open' ? '标记完成' : '重新跟进', `data-id="${esc(c.id)}" ${disabled()}`)}</div></div>${editingCommitment === c.id ? `<div class="tp-form"><label class="tp-grow">修改事项<input data-draft="commitmentEdit" value="${esc(drafts.commitmentEdit)}" maxlength="1000"></label>${btn('commitment.save', '保存', `data-id="${esc(c.id)}" ${disabled()}`)}${btn('commitment.cancelEdit', '取消')}</div>` : ''}${(c.sourceIds || []).length ? `<details><summary>关联原文</summary>${facts((c.evidence || data.evidence || []).filter(e => c.sourceIds.includes(e.sourceId)), false)}</details>` : ''}</article>`).join('') : empty('还没有已确认的事项。AI 分析不会自动创建承诺。')}</section>`;
  }
  function toolsPanel() {
    return `<div class="tp-title"><div><h2>管理工具</h2><p>在 Hub 内打开已有工具，沿用各站自己的登录状态和数据。</p></div></div><div class="tp-tools">${TEAM_TOOLS.map(([id, title, desc]) => `<button type="button" class="tp-tool" data-team="web" data-tool="${id}"><strong>${esc(title)}</strong><span>${esc(desc)}</span><span class="tp-tool-open">打开 →</span></button>`).join('')}</div><p class="tp-meta">原文和个人分析不会自动上传到管理工具。网页内的保存与提交，由你确认执行。</p>`;
  }
  function render() {
    if (!page) return;
    for (const button of page.querySelectorAll('[data-tab]')) { const active = button.dataset.tab === tab; button.classList.toggle('active', active); button.setAttribute('aria-current', active ? 'page' : 'false'); }
    page.querySelector('.tp-status').innerHTML = verifyingIdentity ? '正在核实当前 WeLink 账号，团队资料暂时隐藏…' : data ? `<span class="tp-dot ${data.available ? '' : 'unavailable'}"></span><strong>${data.available ? 'WeLink 已连接' : 'WeLink 暂不可用'}</strong><span>${esc(data.reason || (data.available ? '当前账号的可见工作信息' : '先到助理页扫码登录，再刷新状态。'))}</span>${data.owner ? `<span class="tp-owner">当前账号：${esc(data.owner)}</span>` : ''}` : '正在读取团队空间…';
    page.querySelector('.tp-feedback').innerHTML = error ? `<span class="tp-warning">${esc(error)}</span> ${btn('reload', '重试')}` : esc(busy || (data?.busy ? '后台正在更新团队资料，请稍候…' : '') || notice);
    page.querySelector('.tp-feedback').hidden = !error && !busy && !data?.busy && !notice;
    if (webId) {
      if (!page.querySelector('.tp-web-slot')) content.innerHTML = `<div class="tp-web-toolbar">${btn('web.close', '← 返回团队')}<strong>${esc(TEAM_TOOLS.find(t => t[0] === webId)?.[1])}</strong>${btn('web.retry', '重新加载')}<span class="tp-web-status"></span></div><div class="tp-web-slot" aria-label="管理工具网页区域"></div>`;
      content.classList.add('tp-web-content'); renderWebStatus(); return;
    }
    content.classList.remove('tp-web-content');
    content.innerHTML = !data || verifyingIdentity ? empty(error ? '读取失败，已隐藏团队资料。点击重试核实当前账号。' : '正在核实并读取团队资料…') : ({ today, members, weekly, commitments, tools: toolsPanel })[tab]();
    if (!verifyingIdentity && tab === 'commitments' && drafts.commitmentSources.length) content.querySelector('.tp-commitment-form')?.insertAdjacentHTML('afterend', `<p class="tp-meta">将关联 ${drafts.commitmentSources.length} 条原文；填写你已核实的事项后再确认。${btn('fact.clear', '取消关联')}</p>`);
  }
  async function load() {
    const epoch = ++loadEpoch;
    try { const next = await call('team:state'); if (epoch === loadEpoch) { const changed = verifyingIdentity || error || JSON.stringify(next) !== JSON.stringify(data); acceptState(next); error = ''; if (changed) render(); } }
    catch (e) { if (epoch === loadEpoch) { error = e.message; render(); } }
  }
  async function mutate(op, payload = {}, label = '正在处理…') {
    if (busy) return null;
    if (!data?.owner || verifyingIdentity) { error = '请先核实当前 WeLink 账号后再操作。'; render(); return null; }
    const expectedOwner = data.owner;
    ++loadEpoch; busy = label; error = ''; notice = ''; render();
    try { const result = await call('team:call', { op, ...payload, expectedOwner }); ++loadEpoch; if (op === 'resolve') { const latest = await call('team:state'); acceptState(latest); if (latest.owner !== expectedOwner) throw new Error('WeLink 账号已改变，请重新查找成员。'); resolution = result; } else acceptState(result); return result; }
    catch (e) { error = e.message; return null; }
    finally { busy = ''; render(); }
  }
  async function action(button) {
    const op = button.dataset.team, id = button.dataset.id;
    if (op === 'tab') { if (webId) stopWeb(); tab = button.dataset.tab; render(); return; }
    if (op === 'assistant') { close(); (document.getElementById('btn-company-assistant') || document.getElementById('btn-assistant'))?.click(); return; }
    if (op === 'reload') { if (!busy) await load(); return; }
    if (op === 'web') { await openWeb(button.dataset.tool); return; }
    if (op === 'web.close') { stopWeb(); render(); return; }
    if (op === 'web.retry') { await openWeb(webId, { reload: true }); return; }
    if (busy) return;
    if (op === 'member.prepare') { if (!data?.members?.some(m => m.id === id)) throw new Error('成员已变更，请刷新后重新选择。'); preparingMember = id; tab = 'members'; render(); content.scrollTop = 0; return; }
    if (op === 'member.back') { preparingMember = null; render(); content.scrollTop = 0; return; }
    if (op === 'resolve') { if (!drafts.memberInput.trim()) throw new Error('请先输入组员 ID 或账号。'); resolution = null; await mutate('resolve', { input: drafts.memberInput.trim() }, '正在核对成员账号…'); }
    else if (op === 'follow') { if (!resolution) throw new Error('请重新查找并确认成员账号。'); if (await mutate('follow', { resolutionId: resolution.resolutionId, account: button.dataset.account, confirmed: true }, '正在保存关注成员…')) { resolution = null; notice = '已确认并关注。可采集近期交流。'; render(); } }
    else if (op === 'unfollow' || op === 'restore') await mutate(op, { memberId: id, confirmed: true });
    else if (op === 'refresh') await mutate('refresh', { scope: drafts.scope }, '正在采集最近 7 天可见会话，通常需要几分钟…');
    else if (op === 'analyze') await mutate('analyze', id ? { memberId: id } : {}, '正在创建分析会话…');
    else if (op === 'analysis.sync') await mutate(op, {}, '正在读取分析结果…');
    else if (op === 'settings.scope') {
      const savedScope = drafts.scope, savedOwner = data.owner;
      const result = await mutate('settings', { scope: savedScope });
      if (result && data.owner === savedOwner && drafts.scope === savedScope) { scopeDirty = false; drafts.scope = result.settings?.scope || 'all'; notice = '采集范围已保存。'; render(); }
    }
    else if (op === 'settings.auto') await mutate('settings', { autoRefresh: !data.settings?.autoRefresh, intervalHours: 24 });
    else if (op === 'weekly.draft') await mutate(op, {}, '正在整理周报草稿…');
    else if (op === 'weekly.save') { const d = data.weeklyDrafts.find(d => d.id === id); if (await mutate('weekly.update', { id, text: drafts.weekly[id] ?? d?.text ?? '' })) { delete drafts.weekly[id]; notice = '草稿已保存到本机，尚未提交。'; render(); } }
    else if (op === 'fact.prepare') { const fact = data.evidence.find(e => e.sourceId === button.dataset.source); if (!fact) throw new Error('该原文已更新，请刷新后核对。'); drafts.commitmentSources = [fact.sourceId]; drafts.commitmentMember = fact.memberId; tab = 'commitments'; notice = '已关联原文，请填写核实后的工作事项。'; render(); }
    else if (op === 'fact.clear') { drafts.commitmentSources = []; render(); }
    else if (op === 'commitment.add') { if (!drafts.commitmentTitle.trim()) throw new Error('请先填写已确认的工作事项。'); if (await mutate(op, { title: drafts.commitmentTitle.trim(), memberId: drafts.commitmentMember || undefined, sourceIds: drafts.commitmentSources, confirmed: true })) { drafts.commitmentTitle = ''; drafts.commitmentSources = []; render(); } }
    else if (op === 'commitment.edit') { editingCommitment = id; drafts.commitmentEdit = data.commitments.find(c => c.id === id)?.title || ''; render(); }
    else if (op === 'commitment.cancelEdit') { editingCommitment = null; render(); }
    else if (op === 'commitment.save') { if (!drafts.commitmentEdit.trim()) throw new Error('事项内容不能为空。'); if (await mutate('commitment.update', { id, title: drafts.commitmentEdit.trim() })) { editingCommitment = null; render(); } }
    else if (op === 'commitment.done' || op === 'commitment.reopen') await mutate('commitment.update', { id, status: op === 'commitment.done' ? 'done' : 'open' });
  }
  function open() {
    build(); closeOtherPanels(); verifyingIdentity = true; page.hidden = false;
    document.body.classList.add('team-page-open'); document.getElementById('btn-team')?.classList.add('active');
    window.setShellNavActive?.('team'); place(); render(); if (!busy) void load();
  }
  function close() {
    if (!page) return;
    page.hidden = true; stopWeb(); document.body.classList.remove('team-page-open'); document.getElementById('btn-team')?.classList.remove('active');
  }
  const onWebState = (_event, state) => {
    if (!webId || (state?.id && state.id !== webId)) return;
    webStatus = state?.error || state?.message || ({ loading: '网页加载中…', ready: '网页已打开', loaded: '网页已打开', error: '网页加载失败，可重新加载。', failed: '网页加载失败，可重新加载。' })[state?.phase || state?.state] || '';
    renderWebStatus();
  };
  ipcRenderer.on?.('team:web-state', onWebState);
  const onTeamChanged = () => { if (isOpen() && !busy) void load(); };
  // Assistant notifications currently contain no verified identity. Hide the
  // previous owner's material synchronously until team:state revalidates it.
  const onAssistantChanged = () => { verifyingIdentity = true; if (isOpen()) { render(); void load(); } };
  ipcRenderer.on?.('team:changed', onTeamChanged);
  ipcRenderer.on?.('company-assistant:changed', onAssistantChanged);
  return { open, close, isOpen, destroy() { close(); observer?.disconnect(); window.removeEventListener('resize', onResize); ipcRenderer.removeListener?.('team:web-state', onWebState); ipcRenderer.removeListener?.('team:changed', onTeamChanged); ipcRenderer.removeListener?.('company-assistant:changed', onAssistantChanged); page?.remove(); page = null; } };
}

module.exports = { createTeamPage };
