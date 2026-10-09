'use strict';
const { companyCards } = require('./account-center-view');
const { TABS, aiHtml, cliHtml, servicesHtml, toolConnections, codexQuotaHtml } = require('./account-workspace-view');
function createAccountCenterPanel({ document, ipcRenderer, escapeHtml: esc, configModal, closeOtherPanels = () => {} }) {
  const page = document.getElementById('account-page'), body = page.querySelector('.ac-content');
  let tab = 'ai';
  const search = page.querySelector('.ac-search'), tabs = page.querySelector('.ac-tabs');
  let state = null, signature = '', view = 'list', error = '', notice = '', busy = '', timer, previousFocus, epoch = 0, request = 0;
  let toolGroups = null;
  // Sidebar badge: accounts whose login or human check needs the person (main process count).
  function setBadge(n) {
    const count = document.getElementById('accounts-attention');
    if (!count || !Number.isInteger(n)) return;
    count.textContent = n; count.hidden = !n;
    count.title = n ? n + ' 个账号需要重新登录或验证' : '';
  }
  let toolAccounts = null, toolAccountsError = '', toolAccountsFlight = null;
  const toolChoices = {};
  function selectTab(id) {
    if (!TABS.some(t => t.id === id)) return;
    tab = id; search.value = ''; error = ''; notice = ''; body.scrollTop = 0; render();
    tabs.querySelector('[aria-selected="true"]')?.focus();
  }
  function footerHtml() {
    return `<footer class="ac-footnote"><span>「打开」用你自己的浏览器（AI 不碰它）；状态显示 AI 浏览器的登录，生图、中转、圆桌用的是它</span><details class="ac-connections" data-details="connections"><summary>工具连接</summary>${toolConnections(toolAccounts, esc, state?.activity)}${toolAccountsError ? `<p class="ac-item-error">${esc(toolAccountsError)}</p>` : ''}${toolsHtml()}</details></footer>`;
  }
  async function call(action, args) {
    const r = await ipcRenderer.invoke('hub-accounts:' + action, args);
    if (!r?.ok) throw Error(r?.error || '账号服务未响应');
    return r.data;
  }
  function renderStatus() {
    const el = page.querySelector('.ac-status'), text = error || notice;
    el.textContent = text; el.hidden = !text; el.classList.toggle('error', !!error);
    // A background login check never disables 打开: clicking makes the check yield.
    for (const b of page.querySelectorAll('[data-ac="open"],[data-ac="login"],[data-ac="add"],[data-ac="preferred"],[data-ac="authorize"],[data-ac="external"]')) b.disabled = !!busy || state?.setupProgress?.status === 'running';
    for (const b of page.querySelectorAll('[data-ac="recover"],[data-ac="recheck"],[data-ac="copy-logins"],[data-ac="tools"],[data-ac="tools-connect"]')) b.disabled = !!busy || state?.setupProgress?.status === 'running' || state?.progress?.status === 'running';
    for (const b of page.querySelectorAll('[data-ac="codex-quota"]')) b.disabled=!!busy || !!state?.clis?.find(c=>c.kind==='codex' && c.profileId===b.dataset.profile)?.isDefault;
  }
  function toolsHtml() {
    const progress = state?.setupProgress;
    const status = progress ? `<p class="ac-tool-help" role="status">${esc(progress.error || progress.stage)}</p>` : '';
    if (!toolGroups) return `<button class="ac-btn" data-ac="tools">管理已有工具连接</button>${status}`;
    const options = (state.identities || []).map(i => ({ id: i.id, label: (i.id === 'main' ? '账号 1' : '账号 2') + ' · ' + (i.account || '身份待确认') }));
    return `<div class="ac-tool-setup"><p>为工具选择它原来使用的 ChatGPT 账号。接入会等待工具空闲，保留任务、历史和旧登录资料。</p>${toolGroups.map(g => `<label><span>${esc(g.name)}${g.labels?.length ? ' · ' + esc(g.labels.join(' / ')) : ''}<small>${g.lanes} 个工作页面</small></span><select data-tool-choice="${esc(g.id)}"><option value="">请选择对应账号</option>${options.map(o => `<option value="${o.id}" ${toolChoices[g.id] === o.id ? 'selected' : ''}>${esc(o.label)}</option>`).join('')}</select></label>`).join('')}<button class="ac-btn" data-ac="tools-connect" ${progress?.status === 'running' ? 'disabled' : ''}>保存并接入</button>${status}</div>`;
  }
  function render() {
    if (page.hidden) return;
    position();
    if (state) setBadge(state.attention);
    document.getElementById('account-editor').hidden = view !== 'config'; body.hidden = view === 'config';
    page.querySelector('[data-ac="back"]').hidden = view !== 'config';
    tabs.hidden = search.hidden = view === 'config';
    if (view === 'config') return renderStatus();
    tabs.innerHTML = TABS.map(t => `<button role="tab" id="ac-tab-${t.id}" aria-selected="${tab === t.id}" aria-controls="ac-list-panel" tabindex="${tab === t.id ? 0 : -1}" data-ac="tab" data-tab="${t.id}">${t.name}</button>`).join('');
    body.setAttribute('aria-labelledby', 'ac-tab-' + tab);
    if (!state) { body.innerHTML = '<p class="ac-empty">正在读取账号…</p>'; return renderStatus(); }
    const expanded = [...body.querySelectorAll('details[open]')].map(d => d.dataset.details);
    body.innerHTML = tab === 'ai' ? aiHtml(state, search.value, esc) : tab === 'cli' ? cliHtml(state, search.value, esc) : servicesHtml(toolAccounts, tab, search.value, state, esc, toolAccountsError);
    if (['ai','cli'].includes(tab) && !search.value) body.innerHTML=codexQuotaHtml(state,esc)+body.innerHTML;
    if (tab === 'ai' && state.tools?.some(tool => tool.tool === 'images' && tool.state === 'changed')) {
      body.innerHTML = '<p class="ac-connection-notice" role="status">生图工具连接配置已变化，生图记录暂不能归入共享账号。请在下方「工具连接」核对。</p>' + body.innerHTML;
    }
    if (tab === 'ai' && !search.value) body.innerHTML += footerHtml();
    if (state.activity?.warnings?.length) body.innerHTML += `<p class="ac-item-error">${esc(state.activity.warnings.join(' / '))}</p>`;
    if (tab === 'ai' && (state.webTools?.images?.readError || state.webTools?.roundtable?.recoveryError)) body.innerHTML += '<p class="ac-item-error">部分网页工具状态读取失败；请在原会话查看任务结果。</p>';
    if (state.progress?.status === 'running') body.innerHTML += `<p class="ac-connection-notice" role="status">${esc('正在后台确认登录（' + state.progress.done + '/' + state.progress.total + '），不影响打开网页')}</p>`;
    else if (!state.progress?.auto && (state.progress?.error || state.progress?.warnings?.length)) body.innerHTML += `<p class="ac-item-error">${esc(state.progress.error || state.progress.warnings.join(' / '))}</p>`;
    for (const d of body.querySelectorAll('details')) d.open = expanded.includes(d.dataset.details);
    renderStatus();
  }
  function apply(next) {
    const sig = Math.floor(Date.now() / 60000) + ':' + JSON.stringify(next);
    if (sig === signature) return renderStatus();
    const top = body.scrollTop, focus = page.contains(document.activeElement) ? { ...document.activeElement.dataset } : null;
    state = next; signature = sig; render();
    if (focus && Object.keys(focus).length) [...page.querySelectorAll('button')].find(b => Object.entries(focus).every(([k, v]) => b.dataset[k] === v))?.focus({ preventScroll: true });
    body.scrollTop = top;
  }
  function renderTools() {
    const top = body.scrollTop, focus = page.contains(document.activeElement) ? { ...document.activeElement.dataset } : null;
    render();
    if (focus && Object.keys(focus).length) [...page.querySelectorAll('button,select')].find(b => Object.entries(focus).every(([k, v]) => b.dataset[k] === v))?.focus({ preventScroll: true });
    body.scrollTop = top;
  }
  function position() {
    const rail = document.getElementById('scene-rail')?.getBoundingClientRect();
    if (rail) {
      const sessionEdge = document.getElementById('session-sidebar')?.getBoundingClientRect().left;
      page.style.left = (sessionEdge ?? rail.right) + 'px';
      page.style.top = rail.top + 'px';
    }
  }
  function schedule() {
    clearTimeout(timer);
    if (!page.hidden && view === 'list') timer = setTimeout(() => void refresh(), state?.setupProgress?.status === 'running' ? 800 : 5000);
  }
  async function refresh() {
    const ticket = epoch, seq = ++request;
    try { const next = await call('state'); if (ticket === epoch && seq === request && !page.hidden) {
      const newlyConnected = next.setupProgress?.status === 'complete' && state?.setupProgress?.status !== 'complete';
      apply(next); if (newlyConnected) void refreshToolAccounts();
    } }
    catch (e) { if (ticket === epoch && !page.hidden) { error = e.message; renderStatus(); } }
    finally { schedule(); }
  }
  async function refreshToolAccounts(force = false) {
    if (toolAccountsFlight) return toolAccountsFlight;
    const ticket = epoch;
    toolAccountsError = '';
    toolAccountsFlight = call('tool-accounts', { refresh: force }).then(data => {
      if (ticket === epoch && !page.hidden) { toolAccounts = data; renderTools(); }
    }).catch(e => { if (ticket === epoch && !page.hidden) { toolAccountsError = e.message; renderTools(); } })
      .finally(() => { toolAccountsFlight = null; if (ticket !== epoch && !page.hidden) void refreshToolAccounts(); });
    return toolAccountsFlight;
  }
  async function action(name, args) {
    if (busy) return;
    busy = name; error = ''; notice = ''; renderStatus();
    if (['external', 'open', 'login'].includes(name)) { notice = '正在打开官方入口…'; renderStatus(); }
    if (name === 'copy-logins') { notice = '正在把你的登录复制给 AI 浏览器…'; renderStatus(); }
    const ticket = epoch; ++request;
    try {
      const result = await call(name, args);
      if (ticket !== epoch) return;
      if (name === 'tools') { toolGroups = result.groups; if (!toolGroups.length) notice = '未发现需要接入的生图或中转工具'; render(); }
      else if (name === 'tools-connect') { state.setupProgress = result; render(); }
      else if (name === 'external') { notice = result.message; await refresh(); await refreshToolAccounts(); }
      else if (name === 'open' || name === 'login') { notice = result.message; await refresh(); }
      else if (name === 'copy-logins') { notice = result.message; apply(result); }
      else apply(result);
    } catch (e) { if (ticket === epoch) error = e.message; }
    finally { busy = ''; if (ticket === epoch) renderStatus(); schedule(); }
  }
  async function authorize(id) {
    if (busy) return;
    busy = 'authorize'; error = ''; notice = ''; renderStatus();
    const ticket = epoch;
    try {
      const nativeId = id.startsWith('codex:') ? id.replace('codex:', 'codex-') : ({ gemini: 'gemini-cli' }[id] || id);
      const r = await ipcRenderer.invoke('accounts:login', { id: nativeId });
      if (!r?.ok) throw Error(r?.error || '授权入口未打开');
      if (ticket === epoch) notice = r.data?.message || '已打开官方授权入口';
    } catch (e) { if (ticket === epoch) error = e.message; }
    finally { busy = ''; if (ticket === epoch) renderStatus(); }
  }
  async function switchCodexQuota(profileId) {
    if (busy) return;
    busy='codex-quota';error='';notice='正在切换后续会话的用量账号…';renderStatus();
    const ticket=epoch;
    try {
      const result=await ipcRenderer.invoke('codex:set-global-account',{profileId,scope:'launch'});
      if (!result?.ok) throw Error(result?.error || '用量账号切换失败');
      if (ticket!==epoch) return;
      notice='已切换后续会话的用量账号。已打开的会话保持原账号，新建、恢复和重启使用新账号。';
      await refresh();
    } catch (e) {if(ticket===epoch)error=e.message;}
    finally {busy='';if(ticket===epoch)renderStatus();}
  }
  async function configure(provider = 'codex') {
    try { await configModal.openAccountConfig(provider); if (!page.hidden) { view = 'config'; clearTimeout(timer); render(); } }
    catch (e) { error = e.message; renderStatus(); }
  }
  function close() {
    if (page.hidden) return;
    page.hidden = true; epoch++; clearTimeout(timer);
    document.body.classList.remove('accounts-open');
    document.getElementById('btn-rail-accounts')?.setAttribute('aria-expanded', 'false');
    if (previousFocus?.isConnected) previousFocus.focus();
  }
  async function open(provider) {
    closeOtherPanels(); configModal.close();
    epoch++; clearTimeout(timer); previousFocus = document.activeElement;
    page.hidden = false; document.body.classList.add('accounts-open');
    document.getElementById('btn-rail-accounts')?.setAttribute('aria-expanded', 'true');
    view = 'list'; error = ''; notice = ''; render(); await refresh();
    void refreshToolAccounts();
    if (provider && !page.hidden) await configure(provider);
  }
  page.addEventListener('click', e => {
    const currentMenu = e.target.closest('.ac-more');
    for (const menu of page.querySelectorAll('.ac-more[open]')) if (menu !== currentMenu) menu.open = false;
    const b = e.target.closest('button'); if (!b || b.disabled) return;
    if (currentMenu) currentMenu.open = false;
    const a = b.dataset.ac, args = { site: b.dataset.site, identity: b.dataset.identity };
    if (a === 'close') close();
    else if (a === 'back') { view = 'list'; render(); void refresh(); }
    else if (a === 'tab') selectTab(b.dataset.tab);
    else if (a === 'open') void action('open', args);
    else if (a === 'login') void action('login', args);
    else if (a === 'recover') void action('check-start', { ...args, live: true });
    else if (a === 'recheck') void action('check-start', args);
    else if (a === 'copy-logins') void action('copy-logins', args);
    else if (a === 'check-cancel') void action('check-cancel', {});
    else if (a === 'add' || a === 'preferred') void action('preference', { ...args, add: a === 'add' });
    else if (a === 'authorize') void authorize(b.dataset.id);
    else if (a === 'codex-quota') void switchCodexQuota(b.dataset.profile);
    else if (a === 'config') void configure(b.dataset.id);
    else if (a === 'tools') void action('tools');
    else if (a === 'external') void action('external', { service: b.dataset.service, action: b.dataset.operation });
    else if (a === 'tool-accounts-refresh') void refreshToolAccounts(true);
    else if (a === 'tools-connect') {
      const choices = Object.fromEntries(Object.entries(toolChoices).filter(([, value]) => value));
      if (!Object.keys(choices).length) { error = '请先选择工具对应的 ChatGPT 账号'; renderStatus(); }
      else void action('tools-connect', { choices });
    }
  });
  search.addEventListener('input', renderTools);
  tabs.addEventListener('keydown', e => { const i = TABS.findIndex(t => t.id === tab); const next = ({ArrowRight: (i+1)%TABS.length, ArrowLeft: (i+TABS.length-1)%TABS.length, Home: 0, End: TABS.length-1})[e.key]; if (next !== undefined) { e.preventDefault(); selectTab(TABS[next].id); } });
  page.addEventListener('change', e => { if (e.target.dataset.toolChoice) toolChoices[e.target.dataset.toolChoice] = e.target.value; });
  document.addEventListener('click', e => {
    if (e.target.closest('#btn-rail-accounts')) { if (page.hidden) void open(); else close(); }
    else if (e.target.closest('#scene-rail button') && !page.hidden) close();
    if (e.target.closest('#btn-config-accounts')) void open();
  });
  document.addEventListener('keydown', e => {
    if (page.hidden || view !== 'list' || e.isComposing || e.repeat) return;
    if (e.key === 'Escape' && !page.querySelector('dialog[open]')) { e.preventDefault(); const expanded = page.querySelector('details[open]'); if (expanded) expanded.open = false; else close(); return; }
    if (tab !== 'ai' || !e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || busy || e.target.closest('input,textarea,select,[contenteditable="true"]')) return;
    const n = Number(e.key), card = state && companyCards(state)[n - 1];
    if (card && n >= 1 && n <= 7) { e.preventDefault(); void action('open', { site: card.site }); }
  });
  document.addEventListener('hub-account-config-saved', () => { notice = '接入配置已保存。'; void refresh(); });
  ipcRenderer.on('codex-global-account-changed',()=>{if(!page.hidden)void refresh();});
  ipcRenderer.on('hub-accounts:attention', (_event, n) => setBadge(n));
  void ipcRenderer.invoke('hub-accounts:attention').then(r => { if (r?.ok) setBadge(r.data); }).catch(() => {});
  ipcRenderer.on('launch-auth-status',(_event,result)=>{if(!page.hidden){notice=result.message;void refresh();}});
  window.addEventListener('resize', position);
  return { open, close, refresh };
}
module.exports = { createAccountCenterPanel };
