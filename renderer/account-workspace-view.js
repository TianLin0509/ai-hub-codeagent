'use strict';
const { companyCards, cliChip } = require('./account-center-view');
const TABS = [{ id: 'ai', name: 'AI 网页' }, { id: 'work', name: '工作平台' }, { id: 'content', name: '内容平台' }, { id: 'cli', name: '命令行授权' }, { id: 'api', name: 'API 与服务' }];
const GROUP = { github: 'work', social: 'content', mediaPublish: 'content' };
const NATIVE = { signed_in: ['已登录', 'ok'], signed_out: ['未登录', 'warn'], unknown: ['登录状态未确认', 'idle'] };
const BINDING = { shared: '共享专属 Chrome', bound: '已连接', changed: '连接配置已变化', pending: '尚未共享登录', native: '独立授权', host: '客户端授权' };
const LOGOS = { chatgpt: 'codex', claude: 'claude', google: 'gemini', deepseek: 'deepseek', kimi: 'kimi', qwen: 'qwen' };
function brandIcon(card, esc, row = false) {
  const logo = LOGOS[card.site];
  return `<span class="ac-company-mark${row ? ' ac-product-mark' : ''}" style="--ac-mark:${card.color}" aria-hidden="true">${logo ? `<img src="assets/ai-logos/${logo}.svg" alt="">` : esc(card.mark)}</span>`;
}
function relativeTime(at, now = Date.now()) {
  if (!Number.isFinite(at) || at <= 0) return '';
  const minutes = Math.max(0, Math.floor((now - at) / 60000));
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return minutes + ' 分钟前';
  if (minutes < 1440) return Math.floor(minutes / 60) + ' 小时前';
  return new Date(at).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' });
}
function usage(activity, now) {
  if (!activity) return { text: '尚无访问或工具使用记录', tone: 'idle', login: false };
  const labels = { opened: '打开过网页', visited: '访问过网页', success: activity.source === 'images' ? '生图成功' : '使用成功', using: '发起过生图',
    login_required: '需要登录', verification_required: '需要验证', rate_limited: '服务限流', quota_exhausted: '额度用完', network_error: '网络连接失败', adapter_changed: '网页适配需更新', failed: '上次使用未完成' };
  const unresolved = activity.issue?.outcome;
  return { text: (relativeTime(activity.at, now) + ' · ' + (labels[activity.outcome] || '使用过')).trim(),
    tone: unresolved ? 'warn' : activity.outcome === 'success' ? 'ok' : ['failed', 'login_required', 'verification_required', 'rate_limited', 'quota_exhausted', 'network_error', 'adapter_changed'].includes(activity.outcome) ? 'warn' : 'idle',
    login: !!unresolved || ['login_required', 'verification_required'].includes(activity.outcome),
    // A check is passed in a clean window (a handoff when the site is paused), not by signing in again.
    verify: (unresolved || activity.outcome) === 'verification_required',
    note: unresolved && unresolved !== activity.outcome ? '最近调用' + labels[unresolved] : activity.lastSuccessAt && activity.outcome !== 'success' ? '上次成功：' + relativeTime(activity.lastSuccessAt, now) : '',
    title: ({ images: '生图 MCP', roundtable: '网页圆桌', website: '网页入口', history: '专属 Chrome 访问记录；不代表当前仍已登录' }[activity.source] || '使用记录') + ' · ' + new Date(activity.at).toLocaleString('zh-CN') };
}
// Which tools use this login and how their last step went (hub-account-activity.js sources).
const TOOL_NAMES = { images: '生图', bridge: '中转', roundtable: '圆桌' };
const TOOL_OUTCOMES = { success: '正常', verification_required: '需验证', login_required: '需登录', rate_limited: '限流', quota_exhausted:'额度用完', network_error:'网络失败', adapter_changed:'适配需更新', failed: '未完成', using: '进行中' };
function toolsNote(entry, now = Date.now()) {
  return Object.entries(entry?.sources || {}).filter(([source]) => TOOL_NAMES[source]).sort((a, b) => b[1].at - a[1].at)
    .map(([source, v]) => TOOL_NAMES[source] + ' ' + relativeTime(v.at, now) + (TOOL_OUTCOMES[v.outcome] || '')).join(' · ');
}
const toolsHtmlLine = (note, esc) => note ? `<small class="ac-tools" title="使用这个账号的网页工具及其最近一次结果">${esc(note)}</small>` : '';
const matches = (values, query) => !query || values.join(' ').toLocaleLowerCase().includes(query.trim().toLocaleLowerCase());
function codexQuotaHtml(state, esc) {
  const rows=(state.clis || []).filter(c=>c.kind==='codex');
  if (!rows.length) return '';
  return `<article class="ac-company ac-codex-quota" aria-label="Codex 用量账号"><header><h2>Codex 用量账号</h2></header><p class="ac-tool-help">切换后，新建、恢复和重启会话使用所选账号额度。已打开的会话继续使用原账号。</p>${rows.map(c=>`<div class="ac-account"><div class="ac-account-title"><strong>${esc(c.label || c.profileId)}</strong><span class="ac-account-name">${esc(c.account || '尚未授权')}</span>${c.isDefault?'<span class="ac-default">后续使用</span>':''}</div><div class="ac-row-actions"><button class="ac-open" data-ac="codex-quota" data-profile="${esc(c.profileId)}" ${c.isDefault?'disabled aria-pressed="true"':'aria-pressed="false"'}>${c.isDefault?'当前用量账号':'使用此账号额度'}</button></div></div>`).join('')}</article>`;
}
function usageHtml(value, esc, tools = '', detail = '') {
  return `<div class="ac-usage ${value.tone}" title="${esc(value.title || '')}"><span>${esc(value.text)}</span>${value.note ? `<small>${esc(value.note)}</small>` : ''}${toolsHtmlLine(tools, esc)}${detail}</div>`;
}
// A person handoff pauses every web tool (core/web-risk-guard.js); say so, so nobody wonders why.
function handoffHtml(risk, esc) {
  const lease = risk?.handoff;
  if (!lease) return '';
  const until = new Date(lease.until).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  return `<p class="ac-connection-notice ac-handoff" role="status">${esc('网页工具已暂停并断开，你正在专属 Chrome 里验证或登录；完成后关闭那个窗口，再复核并继续原任务。接管记录到 ' + until + '，窗口仍开着时工具不会接管。')}</p>`;
}
// The image MCP in one sentence: which route draws right now.
function imageServiceHtml(images, esc) {
  if (!images) return '';
  const enabled = (images.web || []).filter(w => w.enabled);
  const webAble = enabled.some(w => w.able ?? w.ready), codexReady = !!images.codex?.ready;
  const order = images.codex?.preferred ? 'Codex 优先、网页兜底' : '网页优先、Codex 兜底';
  const retryAt = Math.min(...enabled.map(w => w.retryAt || Infinity));
  const retry = Number.isFinite(retryAt) ? '，' + (retryAt <= Date.now() ? '下次有生图任务时' : new Date(retryAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) + ' 后有生图任务时') + '自动再试网页' : '';
  const now = webAble && !(images.codex?.preferred && codexReady) ? '现在走 ChatGPT 网页'
    : codexReady ? '现在走 Codex' + (enabled.length && !webAble ? '（ChatGPT 网页被网站验证拦住' + retry + '）' : '') : '暂时没有可用通道';
  return `<p class="ac-connection-notice ac-image-status" role="status">${esc('生图 MCP：' + order + ' · ' + now)}</p>`;
}
// One line per account: the verdict, then where it came from.
const PROOF = { check: '网页确认已登录', cookie: '本机登录记录有效', images: '生图调用成功', roundtable: '网页圆桌调用成功', bridge: '中转调用成功', opened: '你打开过网页' };
const BY = { check: '网页检查', cookie: '本机登录记录', images: '生图', roundtable: '网页圆桌', bridge: '中转', paused: '网页工具' };
// A verification wall a tool met: a note about the tools, not a task for the person.
function automationNote(wall, now) {
  if (!wall) return '';
  if (wall.by === 'paused') return '网页工具遇到网站验证，自动化暂停到 ' + new Date(wall.until).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) + '；你自己使用不受影响';
  return relativeTime(wall.at, now) + ' ' + BY[wall.by] + '遇到网站验证；你自己使用不受影响';
}
function healthView(health, now = Date.now()) {
  const h = health || { state: 'unknown' };
  const when = at => relativeTime(at, now);
  const note = automationNote(h.automation, now);
  if (h.state === 'attention') {
    const p = h.problem;
    const detail = when(p.at) + ' ' + BY[p.by] + (p.by === 'cookie' ? '已失效' : p.by === 'check' ? '发现已退出登录' : '提示需要登录');
    return { tone: 'warn', text: 'AI 浏览器需要重新登录', detail, action: 'login', button: '给 AI 登录' };
  }
  const synced = h.syncedAt ? when(h.syncedAt) + '同步' : '';
  if (h.state === 'ok') return { tone: 'ok', text: '正常' + (synced ? ' · ' + synced : ''), detail: note || PROOF[h.syncedBy] || '', action: 'open', button: '打开' };
  if (h.state === 'off') return { tone: 'idle', text: 'AI 浏览器未登录', detail: '', action: 'open', button: '打开' };
  return { tone: 'idle', text: '未确认' + (synced ? ' · ' + when(h.syncedAt) + '打开过' : ''), detail: note, action: 'open', button: '打开' };
}
function accountToolHtml(state, card, account, esc) {
  const waiting = account.identity === 'main' ? (state.webTools?.roundtable?.waiting || []).filter(t => t.provider === card.site) : [];
  const html = waiting.length ? `<small class="ac-tools">${esc('网页圆桌有 ' + waiting.length + ' 个任务等这个账号 · ' + (waiting.every(t => t.submitted) ? '只补收原回答' : '保留原任务继续'))}</small>` : '';
  return { waiting, html };
}
function aiHtml(state, query, esc, now = Date.now()) {
  const network = state.chrome?.network;
  const networkHtml = network && !['applied', 'next_launch'].includes(network.state) ? `<p class="ac-connection-notice ac-network" role="status">${esc(network.message)}</p>` : '';
  const progress = state.progress?.status === 'running' ? state.progress : null;
  return networkHtml + imageServiceHtml(state.webTools?.images, esc) + handoffHtml(state.risk, esc) + (companyCards(state).map(card => {
    const accounts = card.accounts.filter(a => matches([card.company, card.product, a.label, a.account], query));
    if (!accounts.length) return '';
    return `<article class="ac-company" data-site="${card.site}"><header>${brandIcon(card, esc)}<h2>${esc(card.company)}</h2><span class="ac-count">${card.accounts.length} 个账号</span><kbd title="账号页内打开默认账号">Alt+${card.shortcut}</kbd></header>
      ${accounts.map(a => {
        const view = healthView(a.health, now), detail = accountToolHtml(state, card, a, esc);
        const checking = progress?.current?.identity === a.identity && progress.current.site === card.site;
        const canRecover = detail.waiting.some(t => t.canResume);
        return `<div class="ac-account" data-identity="${a.identity}"><div class="ac-account-title">${brandIcon(card, esc, true)}<strong>${esc(card.product)}</strong><span class="ac-account-name">${esc(a.account === '账号待确认' ? a.label : a.account)}</span>${a.preferred ? '<span class="ac-default">默认</span>' : ''}</div>
          <div class="ac-usage ${checking ? 'idle' : view.tone}" data-health="${esc(a.health?.state || 'unknown')}"><span>${esc(checking ? '正在后台确认登录…' : view.text)}</span>${view.detail ? `<small>${esc(view.detail)}</small>` : ''}${detail.html}</div><div class="ac-row-actions"><button class="ac-open" data-ac="${view.action}" data-site="${card.site}" data-identity="${a.identity}" aria-label="${esc(view.button)} ${esc(card.product)} ${esc(a.label)}">${view.button} ↗</button>
          ${canRecover ? `<button class="ac-text-btn" data-ac="recover" data-site="${card.site}" data-identity="${a.identity}">复核并继续原任务</button>` : ''}
          <details class="ac-more" data-details="account-${card.site}-${a.identity}"><summary aria-label="${esc(card.product)} ${esc(a.label)}更多操作">···</summary><div><button data-ac="recheck" data-site="${card.site}" data-identity="${a.identity}">立即确认登录</button>${view.action === 'login' ? `<button data-ac="open" data-site="${card.site}" data-identity="${a.identity}">在你的浏览器打开</button>` : `<button data-ac="login" data-site="${card.site}" data-identity="${a.identity}">${a.health?.automation ? '帮 AI 过网站验证' : '给 AI 重新登录'}</button>`}<button data-ac="copy-logins" data-site="${card.site}" data-identity="${a.identity}" title="你在自己的浏览器里重新登录过时用：把登录复制给 AI 浏览器">把我的登录复制给 AI</button>${!a.preferred ? `<button data-ac="preferred" data-site="${card.site}" data-identity="${a.identity}">设为默认账号</button>` : ''}${card.accounts.length < 2 ? `<button data-ac="add" data-site="${card.site}" data-identity="alt">添加第二个账号</button>` : ''}</div></details></div></div>`;
      }).join('')}</article>`;
  }).join('') || '<p class="ac-empty">没有匹配的账号</p>');
}
function cliHtml(state, query, esc) {
  const rows = (state.clis || []).filter(c => matches([c.name, c.label, c.account], query));
  return rows.map(c => `<article class="ac-account ac-standalone"><div class="ac-account-title"><strong>${esc(c.name)}</strong><span class="ac-account-name">${esc(c.account || c.label || '默认账号')}</span></div><div class="ac-usage ${cliChip(c).tone}">${esc(({ authorized: '已有授权记录', missing: '尚未授权', expired: '需要重新授权', unreadable: '授权记录不可读', invalid: '凭据格式错误，需重新授权', api_key: '使用 API Key' })[c.state] || '授权待确认')}</div><div class="ac-row-actions"><button class="ac-open" data-ac="authorize" data-id="${esc(c.id)}">授权 ↗</button><button class="ac-text-btn" data-ac="config" data-id="${esc(c.kind)}">配置</button></div></article>`).join('') || '<p class="ac-empty">没有匹配的命令行账号</p>';
}
function serviceHtml(service, state, esc, now) {
  const value = usage(state.activity?.entries?.['main:' + service.id], now);
  const evidence = service.credential === 'read_error' ? '授权记录读取失败' : service.credential === 'record_found' ? '已有配置记录' : '由原工具管理';
  // 投研数据：显示专属 Chrome 里的登录状态，并能一键检查（2026-09-28）
  const research = GROUP[service.id] === 'research';
  const native = research && service.nativeStatus ? NATIVE[service.nativeStatus.state] : null;
  const nativeHtml = research ? `<div class="ac-usage ${native ? native[1] : 'idle'}" title="${esc(service.nativeStatus?.message || '')}"><span>${esc(native ? native[0] : '还没检查登录')}</span>${service.nativeStatus?.checkedAt ? `<small>${esc(relativeTime(service.nativeStatus.checkedAt, now))}检查</small>` : ''}</div>` : '';
  return `<article class="ac-service" data-account-service="${esc(service.id)}"><div class="ac-account"><div class="ac-account-title"><strong>${esc(service.name)}</strong></div>${research ? nativeHtml : service.website ? usageHtml(value, esc) : `<div class="ac-usage idle">${esc(evidence)}</div>`}<div class="ac-row-actions">${service.website ? `<button class="ac-open" data-ac="external" data-service="${esc(service.id)}" data-operation="open">${research ? '登录 ↗' : '打开 ↗'}</button>` : ''}${research ? `<button class="ac-open" data-ac="external" data-service="${esc(service.id)}" data-operation="check">检查登录</button>` : ''}<details class="ac-more" data-details="service-${esc(service.id)}"><summary aria-label="${esc(service.name)}详情">···</summary><div><span>${esc(BINDING[service.status] || '')}</span><p>${esc(service.help)}</p>${service.canAuthorize ? `<button data-ac="external" data-service="${esc(service.id)}" data-operation="authorize">授权 GitHub CLI ↗</button>` : ''}${(service.consumers || []).map(c => `<span>${esc(c.name)}</span>`).join('')}</div></details></div></div></article>`;
}
function servicesHtml(data, tab, query, state, esc, error, now = Date.now()) {
  if (error) return `<p class="ac-item-error" role="alert">${esc(error)} <button class="ac-text-btn" data-ac="tool-accounts-refresh">重试</button></p>`;
  if (!data) return '<p class="ac-empty" role="status">正在读取账号…</p>';
  const services = data.services.filter(s => !['images', 'bridge', 'roundtable'].includes(s.id) && (GROUP[s.id] || 'api') === tab && matches([s.name, ...(s.consumers || []).map(c => c.name)], query));
  return services.map(s => serviceHtml(s, state, esc, now)).join('') || '<p class="ac-empty">没有匹配的账号</p>';
}
// A tool's latest step on any login it uses, for the connection list.
function lastToolStep(activity, tool, now) {
  const steps = Object.values(activity?.entries || {}).map(e => e.sources?.[tool]).filter(Boolean).sort((a, b) => b.at - a.at);
  return steps.length ? '最近：' + relativeTime(steps[0].at, now) + (TOOL_OUTCOMES[steps[0].outcome] || '') : '';
}
function toolConnections(data, esc, activity, now = Date.now()) {
  if (!data) return '';
  return data.services.filter(s => ['images', 'bridge', 'roundtable'].includes(s.id)).map(s => `<div class="ac-connection"><span>${esc(s.name)}</span><span>${esc(BINDING[s.status])}</span><small>${s.identities.map(i => (i.identity === 'main' ? '账号 1' : '账号 2')).join('、')}${lastToolStep(activity, s.id, now) ? ' · ' + esc(lastToolStep(activity, s.id, now)) : ''}${s.id === 'roundtable' ? ' · 支持 DeepSeek、Kimi、千问；Claude/Codex 新会话选「浏览器」或「全部」加载 MCP，运行中的旧会话需重新创建' : ''}</small></div>`).join('');
}
module.exports = { TABS, relativeTime, usage, toolsNote, healthView, imageServiceHtml, aiHtml, cliHtml, servicesHtml, toolConnections, codexQuotaHtml };
