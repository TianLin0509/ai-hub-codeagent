// 纯函数：按最新 AI 回答时间年龄分桶。pinned 永远进 recent（置顶不折叠）。
//   recent: <24h（保持现状 UI 置顶）· mid: 24-72h · old: ≥72h
const { isGroupChatMemberRunning } = require('../core/groupchat-running-state.js');
const { getMeetingUnreadMemberIds } = require('./meeting-unread');
const { compareLatestActivityDesc, latestActivityTime } = require('../core/session-recency.js');
const {
  sessionHasCompletedUnread,
} = require('../core/session-attention-state.js');
const { sessionRuntimeIssue } = require('../core/session-runtime-issue.js');
const { KIND_LABELS } = require('../core/ai-kinds.js');
const {compareSidebarPlacement,sortBySidebarPlacement,sidebarItemClassification,isPinnedToBottom,sidebarItemHasUnread,isSidebarMemberWorking,partitionSidebarSessions,_meetingRuntimeAggregate,buildSidebarView}=require('../core/session-sidebar-state');
const {sidebarRelativeTime}=require('./sidebar-relative-time');
const {createSessionViewPublisher}=require('../core/hub-assistant/session-state');
const {reconcileSidebarDom}=require('./sidebar-dom-reconciler');
const {
  RUNTIME_STARTING,
  RUNTIME_RUNNING,
  RUNTIME_WAITING,
  RUNTIME_DORMANT,
  RUNTIME_UNKNOWN,
  getSessionRuntimeTruth,
  runtimeTruthSummary,
  sessionRuntimeIsActive,
} = require('../core/session-runtime-truth.js');

function partitionSessionsByAge(items, now) {
  const DAY = 86400000;
  const recent = [], mid = [], old = [];
  for (const s of items || []) {
    const t = latestActivityTime(s, now);
    const age = now - t;
    if (s.pinned || age < DAY) recent.push(s);
    else if (age < 3 * DAY) mid.push(s);
    else old.push(s);
  }
  return { recent, mid, old };
}

// --- 侧栏 AI 家族筛选 ---
// 家族由 kind（哪个 CLI）决定，模型只是家族内部的选择：Opus / Fable / Sonnet 都是
// Claude CLI 起的会话，GPT 各版本都是 Codex CLI 起的。所以按 kind 分族，与用户
// 心里的「这是 Claude 还是 Codex」完全对得上，不需要再解析 currentModel。
// DeepSeek 现在由 Codex CLI + Responses API 启动，但品牌仍是独立的一家，归「其他」。
const SESSION_FAMILY_TABS = [
  { key: 'all', label: '全部', hint: '所有会话与群聊' },
  { key: 'claude', label: 'Claude', hint: 'Claude Code（Opus / Fable / Sonnet / Haiku）' },
  { key: 'codex', label: 'Codex', hint: 'Codex CLI（GPT 各版本）' },
  { key: 'other', label: '其他', hint: 'Gemini / DeepSeek / Kimi / PowerShell' },
];
const SESSION_FAMILY_KEYS = SESSION_FAMILY_TABS.map(tab => tab.key);

// --- Agent 自建会话的分组收纳 ---------------------------------------------
// 学习教练、投研联赛选手这类会话是**机器创建**的：数量随功能增加而膨胀，而且
// 用户平时不需要在列表里逐个看到它们（要用时点开一个就够）。混在人工会话里
// 会把「最近」那一段挤没，侧栏就失去了可读性。
//
// 按 purpose 分组，加新的 Agent 系统时只在这张表里加一行，不改渲染逻辑。
// 注意 xresearch-research 不在这里：它在下面的基础过滤里本来就被完全排除，
// 属于「永远不进侧栏」，而不是「可收可展」。
const AGENT_SESSION_GROUPS = [
  { key: 'study', label: '学习', purposes: ['study-companion'] },
  { key: 'league', label: '投研', purposes: ['agent-league', 'agent-league-virtual'] },
];
const AGENT_GROUP_KEYS = AGENT_SESSION_GROUPS.map(g => g.key);
const AGENT_PURPOSE_TO_GROUP = new Map();
for (const g of AGENT_SESSION_GROUPS) {
  for (const p of g.purposes) AGENT_PURPOSE_TO_GROUP.set(p, g.key);
}
function agentGroupOf(session) {
  return AGENT_PURPOSE_TO_GROUP.get(String(session && session.purpose || '')) || '';
}

function familyOfKind(kind) {
  const base = String(kind || '').replace(/-resume$/, '');
  if (base === 'claude') return 'claude';
  if (base === 'codex') return 'codex';
  return 'other';
}

// 返回条目所属的家族集合。群聊按成员归属，可以同时属于多个家族——混合群聊只算
// 一个家族的话，切到另一个页签时它会凭空消失，而它确实有那边的成员在跑。
function sessionFamilies(item, sessionMap) {
  if (!item) return new Set();
  if (!item._isMeeting) return new Set([familyOfKind(item.kind)]);
  const ids = (item._meeting && item._meeting.subSessions) || [];
  const families = new Set();
  for (const id of ids) {
    const sub = sessionMap && typeof sessionMap.get === 'function' ? sessionMap.get(id) : null;
    if (sub) families.add(familyOfKind(sub.kind));
  }
  // 成员还没同步进 map 的新群聊不能凭空消失，落到「其他」保底可见。
  if (families.size === 0) families.add('other');
  return families;
}

// Search reads the sidebar's live catalogue, scoped to its document.
const sidebarSources = new WeakMap();
function getSidebarSearchEntries(doc) {
  return sidebarSources.get(doc)?.() || [];
}

function createSessionListRenderer(options = {}) {
  const { detailsHtml } = require('./session-details.js');
  const doc = options.document || document;
  const storage = options.localStorage || localStorage;
  const publishSessionViews=createSessionViewPublisher(packet=>{
    const ipc=options.ipcRenderer || (typeof process!=='undefined'&&process.type==='renderer'?require('electron').ipcRenderer:null);
    ipc?.send?.('assistant:session-view',packet);
  });
  const sectionKeys = ['sec-failed', 'sec-active', 'sec-today'];
  let collapsedSections = new Set();
  let recentDays = 1;
  let pinnedOnly = false;
  let modelFilter = 'all';
  try {
    const saved = JSON.parse(storage.getItem('hubSidebarCollapsedSections') || '[]');
    if (Array.isArray(saved)) collapsedSections = new Set(saved.filter(key => sectionKeys.includes(key)));
    const days = Number(storage.getItem('hubSidebarRecentDays'));
    if ([1, 3].includes(days)) recentDays = days;
    pinnedOnly = storage.getItem('hubSidebarRange') === 'pinned';
    const model = storage.getItem('hubSidebarModelFilter');
    if (SESSION_FAMILY_KEYS.includes(model)) modelFilter = model;
  } catch (error) { console.warn('[sidebar] preferences could not be read:', error.message); }
  function savePreference(key, value) {
    try { storage.setItem(key, value); }
    catch (error) { console.warn('[sidebar] preference could not be saved:', error.message); }
  }
  const rangeControls = [...(doc.querySelectorAll?.('[data-session-days]') || [])];
  function syncRangeControls() {
    for (const button of rangeControls) button.setAttribute('aria-pressed', String(pinnedOnly ? button.dataset.sessionDays === 'pinned' : Number(button.dataset.sessionDays) === recentDays));
  }
  syncRangeControls();
  for (const button of rangeControls) button.addEventListener('click', () => {
    pinnedOnly = button.dataset.sessionDays === 'pinned';
    if (!pinnedOnly) recentDays = Number(button.dataset.sessionDays) === 3 ? 3 : 1;
    savePreference('hubSidebarRange',pinnedOnly ? 'pinned' : String(recentDays));
    savePreference('hubSidebarRecentDays', String(recentDays));
    syncRangeControls(); renderSessionList();
  });
  function sidebarView(items, sessionMap = getSessions(), days = recentDays, { now = Date.now(), classify = null } = {}) {
    const parts = partitionSidebarSessions(items, { now, classify, sessionMap, activeSessionId: getActiveSessionId(), activeMeetingId: getActiveMeetingId() });
    return buildSidebarView(parts, { now, days, pinnedOnly, excludePinned: !pinnedOnly, sessionMap, hasUnread: sidebarItemHasUnread });
  }
  const modelControl = doc.getElementById?.('session-model-filter');
  if (modelControl) {
    modelControl.value = modelFilter;
    modelControl.addEventListener('change', () => {
      modelFilter = SESSION_FAMILY_KEYS.includes(modelControl.value) ? modelControl.value : 'all';
      savePreference('hubSidebarModelFilter', modelFilter);
      renderSessionList();
    });
  }
  const { createSidebarProjectFilter } = require('./sidebar-project-filter');
  const projectFilter = createSidebarProjectFilter({
    document: doc, storage,
    ipcRenderer: options.ipcRenderer || (doc.getElementById?.('session-project-filter') ? require('electron').ipcRenderer : null),
    onChange: () => renderSessionList(),
  });
  let detailsEnabled = false;
  try { detailsEnabled = storage.getItem('hubSessionDetails') === 'true'; } catch {}
  const collapsedDetailsMeetings = new Set();
  let hoveredMeetingId = null;
  let hoverPoint = null;
  const detailsButton = doc.getElementById?.('btn-session-details');
  const syncDetailsButton = () => detailsButton?.setAttribute?.('aria-pressed', String(detailsEnabled));
  syncDetailsButton();
  detailsButton?.addEventListener('click', () => {
    detailsEnabled = !detailsEnabled;
    try { storage.setItem('hubSessionDetails', String(detailsEnabled)); }
    catch (error) { console.warn('[sidebar] detail preference could not be saved:', error.message); }
    syncDetailsButton();
    renderSessionList();
  });
  const sessionListEl = options.sessionListEl;
  const getSessions = typeof options.getSessions === 'function' ? options.getSessions : () => new Map();
  const getMeetings = typeof options.getMeetings === 'function' ? options.getMeetings : () => ({});
  const getActiveSessionId = typeof options.getActiveSessionId === 'function' ? options.getActiveSessionId : () => null;
  const getActiveMeetingId = typeof options.getActiveMeetingId === 'function' ? options.getActiveMeetingId : () => null;
  const isAiKind = options.isAiKind;
  const modelShort = options.modelShort;
  const escapeHtml = options.escapeHtml;
  const formatTime = options.formatTime;
  function timeHtml(session, unreadCount = 0) {
    const ts = latestActivityTime(session);
    const full = [formatTime?.(ts), Number(ts) > 0 ? new Date(Number(ts)).toLocaleString('zh-CN') : '', unreadCount ? `${unreadCount} 条未读` : ''].filter(Boolean).join(' · ');
    return `<span class="sl-time${unreadCount ? ' has-unread' : ''}" title="${escapeHtml(full)}" aria-label="${escapeHtml(full)}">${sidebarRelativeTime(ts)}</span>`;
  }
  const pctClass = options.pctClass;
  const getResourceUsage = typeof options.getResourceUsage === 'function' ? options.getResourceUsage : () => null;
  const getProxyInfo = typeof options.getProxyInfo === 'function' ? options.getProxyInfo : () => null;
  const selectSession = options.selectSession;
  const selectMeeting = options.selectMeeting;
  const openContextMenu = options.openContextMenu;
  const markMeetingRead = options.markMeetingRead;
  // 「已完成未读」组头上的一键已读。渲染层只负责按钮，真正清状态由 renderer.js 注入。
  const markAllSessionsRead = typeof options.markAllSessionsRead === 'function'
    ? options.markAllSessionsRead
    : null;
  // 2026-07-19 方案C：列表渲染完成后的回调（renderer 用来刷新 ctx chip/中断钮/等你响应浮动条）
  const afterRender = typeof options.afterRender === 'function' ? options.afterRender : null;
  const renderStats = { renders: 0, slowRenders: 0, lastMs: 0, maxMs: 0 };
  let sidebarPhaseInitialized=false;
  const nowMs = typeof options.nowMs === 'function'
    ? options.nowMs
    : () => (typeof performance !== 'undefined' && typeof performance.now === 'function'
      ? performance.now()
      : Date.now());

// --- Sidebar tree state: which meeting entries are expanded to show their sub-sessions ---
// Persists across reloads. Default = collapsed (白名单未命中即折叠)；用户点 ▶ 后才进
// _expandedMeetings 集合并落盘。2026-05-05 maintainer改：新 AI 群聊不再默认展开，折叠态本来
// 就有 3 个迷你头像跳转按钮可用。
const _expandedMeetings = (() => {
  try {
    const raw = storage.getItem('hubExpandedMeetings');
    return new Set(raw ? JSON.parse(raw) : []);
  } catch { return new Set(); }
})();
function _persistExpandedMeetings() {
  try {
    storage.setItem('hubExpandedMeetings', JSON.stringify([..._expandedMeetings]));
  } catch {}
}
function toggleMeetingExpand(meetingId) {
  if (detailsEnabled && getMeetings()[meetingId]?.groupChat) {
    if (collapsedDetailsMeetings.has(meetingId)) collapsedDetailsMeetings.delete(meetingId);
    else collapsedDetailsMeetings.add(meetingId);
    renderSessionList();
    return;
  }
  if (_expandedMeetings.has(meetingId)) _expandedMeetings.delete(meetingId);
  else _expandedMeetings.add(meetingId);
  _persistExpandedMeetings();
  renderSessionList();
}

function _logoKind(kind) {
  const k = String(kind || '').replace(/-resume$/, '');
  if (k.startsWith('deepseek')) return 'deepseek'; // deepseek-legacy 复用 DS 图标
  if (k === 'powershell' || isAiKind(k)) return k;
  return '';
}

// AI mini logo for sidebar sub-session items. Reuses the .ai-logo + .logo-<kind>
// classes already defined in styles.css for the toolbar dropdown.
// 2026-09-01 · 侧栏瘦身：时间左边的「Opus 5 / gpt-5.6-sol」字串换成一枚品牌小图标。
//   扫列表时真正要一眼分辨的只是"哪家 CLI"，具体型号是二级信息 → 退到 tooltip
//   （会话行的无障碍标签也包含完整 displayName）。
//   拿不到图标的 kind 回落成原来的文字列，避免这一列直接消失。
function _sessionKindHtml(kind, modelTxt, state = 'idle', stateTip = '') {
  const k = _logoKind(kind);
  if (!k) return `<span class="sl-model">${escapeHtml(modelTxt || '')}</span>`;
  const label = String(modelTxt || '').startsWith('ChatGPT') ? 'ChatGPT' : (KIND_LABELS[k] || k);
  const tip = label === 'ChatGPT' ? modelTxt : modelTxt ? `${label} · ${modelTxt}` : label;
  const status = stateTip || STATUS_LABELS[state] || STATUS_LABELS.idle;
  return `<span class="sl-kind ai-logo logo-${k}" data-state="${state}" role="img" aria-label="${escapeHtml(label + ' · ' + status)}" title="${escapeHtml(tip + ' · ' + status)}"></span>`;
}

const STATUS_LABELS = { wait: '等你响应', error: '运行异常', run: '运行中', start: '唤醒中', unread: '未读', dorm: '休眠', idle: '就绪', unknown: '状态未知' };
function _warningHtml(message) {
  return message ? `<svg class="sl-warning" viewBox="0 0 24 24" role="img" aria-label="${escapeHtml(message)}"><title>${escapeHtml(message)}</title><path d="M12 3 2 21h20L12 3Zm0 6v5m0 3v1" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>` : '';
}

function _subIsRunning(sub) {
  return isGroupChatMemberRunning(sub);
}


function _sessionWarningText(session) {
  if (!session) return '';
  const warnings = [];
  if (session.cwdFellBackFrom) {
    warnings.push(`原目录失效：${session.cwdFellBackFrom}；当前回落到：${session.cwd || '(unknown)'}`);
  }
  if (session.memoryLinkWarning) {
    warnings.push(`记忆未接入规范库：${session.memoryLinkWarning}`);
  }
  const issue = sessionRuntimeIssue(session);
  if (issue) warnings.push(`${issue.label}：${issue.message}`);
  return warnings.join('；');
}

  function _meetingAnySubRunning(meeting, sessionMap) {
    const aggregate = _meetingRuntimeAggregate(meeting, sessionMap);
    return aggregate.running && !aggregate.disconnected;
  }

  // 代理配置只用于 tooltip；可见文案必须是 main 进程实测的公网 IP + 城市。
  // 只显示 host:port，隐去可能带凭据的 user:pass@ 部分。
  function _shortProxy(raw) {
    const s = String(raw || '').trim();
    if (!s) return null;
    try {
      const u = new URL(s.includes('://') ? s : `http://${s}`);
      return u.port ? `${u.hostname}:${u.port}` : u.hostname;
    } catch {
      return s.replace(/^[a-z0-9+.-]+:\/\//i, '').replace(/^[^@/]*@/, '').split('/')[0] || null;
    }
  }

  function renderSidebarStrip(sessionMap = getSessions()) {
    const stripEl = doc.getElementById('sidebar-strip');
    if (!stripEl) return;

    const usage = getResourceUsage() || {};
    const cpuPct = Number.isFinite(usage.cpuPct) ? Math.round(usage.cpuPct) : null;
    const gpuPct = Number.isFinite(usage.gpu?.usagePct) ? Math.round(usage.gpu.usagePct) : null;
    const memoryPct = Number.isFinite(usage.memoryPct) ? Math.round(usage.memoryPct) : null;
    const diskPct = Number.isFinite(usage.disk?.usagePct) ? Math.round(usage.disk.usagePct) : null;
    const diskRoot = usage.disk?.root || '本机磁盘';
    const metricClass = value => value != null && value >= 90 ? ' strip-resource-high strip-resource-critical'
      : value != null && value >= 85 ? ' strip-resource-high' : '';
    const proxy = typeof getProxyInfo === 'function' ? getProxyInfo() : null;
    const proxyShort = _shortProxy(proxy && proxy.proxy);
    const egress = proxy && proxy.egress;
    const foreign = egress && egress.foreign;
    const domestic = egress && egress.domestic;
    const displayRoute = proxyShort ? foreign : domestic;
    const alert = egress && egress.alert;
    const clashDelay = proxyShort && proxy?.clashDelay?.status === 'ok' ? proxy.clashDelay : null;

    const ackAttr = alert && alert.acknowledgeable ? ' data-egress-ack="true"' : '';
    const foreignTitle = [
      proxyShort ? 'Claude / Codex 订阅、Gemini：经 VPN 代理' : '未配置 VPN，显示直连出口',
      proxyShort ? `本地代理：${proxyShort}` : '本地代理：未配置',
      displayRoute && displayRoute.ok ? `出口地区：${displayRoute.locationLabel || '未知地区'}` : `状态：${displayRoute && displayRoute.error || '检测中'}`,
      clashDelay ? `Clash 节点健康检查：${clashDelay.nodeName} · ${clashDelay.delayMs} ms（${new Date(clashDelay.measuredAt).toLocaleString('zh-CN')}）；这是探测请求延时，不能代表下载速度或 AI 网页加载耗时` : '',
      alert ? `${alert.title || '节点异常'}：${alert.message || ''}` : '',
      alert && alert.acknowledgeable ? '点击打开流量详情，在里面确认当前节点' : '点击查看 VPN 流量：哪个程序、哪个网站用得最多',
    ].filter(Boolean).join('\n');
    const domesticTitle = [
      'Kimi / DeepSeek：清空 HTTP(S)_PROXY 后直连',
      domestic && domestic.ok ? `出口地区：${domestic.locationLabel || '未知地区'}` : `状态：${domestic && domestic.error || '检测中'}`,
    ].join('\n');

    const routeClass = (route, warning) => !egress ? 'pending' : warning || !route?.ok ? 'warning' : 'ok';
    const metric = (label, value) => `<span class="strip-resource${metricClass(value)}" tabindex="0" data-resource-kind="${label === 'CPU' ? 'cpu' : 'memory'}" aria-label="${label} ${value == null ? '检测中' : value + '%'}，悬停查看占用 Top 3" title="${label} ${value == null ? '检测中' : value + '%'}">${label}<b>${value == null ? '—' : value + '%'}</b><span class="strip-mini-track"><i style="width:${value == null ? 0 : Math.max(0, Math.min(100, value))}%"></i></span></span>`;
    const gpuTitle = gpuPct == null ? 'GPU 占用率暂不可用' : `${usage.gpu.name || 'GPU'} · 占用 ${gpuPct}% · 每 10 秒采样`;
    const gpuMetric = `<span class="strip-resource strip-gpu${metricClass(gpuPct)}" tabindex="0" title="${escapeHtml(gpuTitle)}" aria-label="${escapeHtml(gpuTitle)}">GPU<b>${gpuPct == null ? '—' : gpuPct + '%'}</b></span>`;
    const diskMetric = `<span class="strip-resource strip-disk${metricClass(diskPct)}" role="button" tabindex="0" aria-haspopup="dialog" title="${escapeHtml(`${diskRoot} 已用 ${diskPct == null ? '检测中' : diskPct + '%'}${Number.isFinite(usage.disk?.totalBytes) ? ` · 总容量 ${(usage.disk.totalBytes / 1024 ** 3).toFixed(0)} GB` : ''} · 点击释放硬盘空间`)}" aria-label="${escapeHtml(`${diskRoot} 已用 ${diskPct == null ? '检测中' : diskPct + '%'}，点击打开硬盘释放`)}">硬盘<b>${diskPct == null ? '—' : diskPct + '%'}</b><span class="strip-mini-track"><i style="width:${diskPct == null ? 0 : Math.max(0, Math.min(100, diskPct))}%"></i></span></span>`;
    const network = usage.network;
    const rate = value => {
      if (network?.status !== 'ok' || !Number.isFinite(value)) return '—';
      if (value >= 1024 ** 3) return `${(value / 1024 ** 3).toFixed(1)}<small>G</small>`;
      if (value >= 1024 ** 2) return `${(value / 1024 ** 2).toFixed(1)}<small>M</small>`;
      return `${Math.round(value / 1024)}<small>K</small>`;
    };
    const networkTitle = network?.status === 'ok'
      ? `本机物理网卡合计：${(network.adapters || []).join('、')}\n下行 ${(network.downloadBps / 1024).toFixed(1)} KB/s · 上行 ${(network.uploadBps / 1024).toFixed(1)} KB/s\n最近 ${(network.windowMs / 1000).toFixed(1)} 秒均值；含所有应用，非 VPN 专属流量；K/M/G 表示 KB/s、MB/s、GB/s，按 1024 换算`
      : network?.status === 'unavailable' ? '网速暂不可用' : network?.status === 'disconnected' ? '没有已连接的物理网卡' : '网速采样中';
    const transfer = `<span class="strip-transfer" title="${escapeHtml(networkTitle)}" aria-label="${escapeHtml(networkTitle)}"><span class="strip-download"><span class="strip-transfer-label">↓</span><b>${rate(network?.downloadBps)}</b></span><span class="strip-upload"><span class="strip-transfer-label">↑</span><b>${rate(network?.uploadBps)}</b></span></span>`;
    const location = displayRoute?.ok
      ? [displayRoute.countryZh || displayRoute.country || '国家未知', displayRoute.cityZh || displayRoute.city || '城市未知'].join(' ')
      : '出口未知';
    const domesticLabel = !egress ? '国内检测中' : domestic?.ok ? '国内正常' : '国内异常';
    const markup =
      '<div class="strip-resources" title="点击 CPU / 内存查看进程，点击硬盘释放空间">' + metric('CPU', cpuPct) + gpuMetric + metric('内存', memoryPct) + diskMetric + '</div>' +
      `<div class="strip-network"><button type="button" class="strip-route-row strip-route-foreign strip-proxy" title="${escapeHtml(foreignTitle)}"${ackAttr}><span class="strip-route-dot ${routeClass(displayRoute, proxyShort ? alert : null)}"></span><span>${proxyShort ? 'VPN' : '直连'}</span><span class="strip-location">${escapeHtml(location)}</span>${clashDelay ? `<span class="strip-delay">节点 ${clashDelay.delayMs} ms</span>` : ''}</button>` +
      transfer + `<span class="strip-route-row strip-route-domestic" title="${escapeHtml(domesticTitle)}"><span class="strip-route-dot ${routeClass(domestic)}"></span>${domesticLabel}</span></div>`;
    if (stripEl._resourceMarkup === markup) return;
    stripEl._resourceMarkup = markup;
    // Keep focused/hovered resource anchors alive during the telemetry heartbeat.
    if (stripEl.querySelector('[data-resource-kind]')) {
      const template = doc.createElement('template');
      template.innerHTML = markup;
      for (const kind of ['cpu', 'memory']) {
        const current = stripEl.querySelector(`[data-resource-kind="${kind}"]`);
        const next = template.content.querySelector(`[data-resource-kind="${kind}"]`);
        current.className = next.className;
        current.title = next.title;
        current.setAttribute('aria-label', next.getAttribute('aria-label'));
        current.querySelector('b').textContent = next.querySelector('b').textContent;
        current.querySelector('i').style.width = next.querySelector('i').style.width;
      }
      const currentGpu = stripEl.querySelector('.strip-gpu');
      const nextGpu = template.content.querySelector('.strip-gpu');
      if (currentGpu && nextGpu) {
        currentGpu.className = nextGpu.className;
        currentGpu.title = nextGpu.title;
        currentGpu.setAttribute('aria-label', nextGpu.getAttribute('aria-label'));
        currentGpu.querySelector('b').textContent = nextGpu.querySelector('b').textContent;
      }
      const currentDisk = stripEl.querySelector('.strip-disk');
      const nextDisk = template.content.querySelector('.strip-disk');
      if (currentDisk && nextDisk) {
        currentDisk.className = nextDisk.className;
        currentDisk.title = nextDisk.title;
        currentDisk.setAttribute('aria-label', nextDisk.getAttribute('aria-label'));
        currentDisk.querySelector('b').textContent = nextDisk.querySelector('b').textContent;
        currentDisk.querySelector('i').style.width = nextDisk.querySelector('i').style.width;
      }
      stripEl.querySelector('.strip-network').innerHTML = template.content.querySelector('.strip-network').innerHTML;
    } else stripEl.innerHTML = markup;
    stripEl.title = '';
    stripEl.style.display = 'flex';
    // 点击 VPN 行打开流量详情（renderer/vpn-traffic-panel.js），节点变化的确认在弹层里完成。
  }

  // Session rows are rebuilt wholesale whenever status/recency changes. With
  // hundreds of rows, a rebuild can land between pointer-down and pointer-up;
  // a click listener attached to the removed row then never fires. Capture the
  // navigation intent on the stable list container and finish it on pointer-up.
  const POINTER_NAV_MAX_MOVE_PX = 8;
  const POINTER_CLICK_SUPPRESS_MS = 750;
  const POINTER_REPEAT_INTENT_MS = 500;
  let pendingPointerNavigation = null;
  let lastPointerNavigationAt = 0;
  let lastPointerActivation = null;
  // Editing another pane ends a physical double-click gesture. A later click
  // on a reordered row must use that row, not the prior sidebar target.
  doc.addEventListener?.('pointerdown', event => {
    if (!sessionListEl.contains?.(event.target)) lastPointerActivation = null;
  }, true);

  function navigationIntentFromTarget(target) {
    if (!target || typeof target.closest !== 'function') return null;
    const read = target.closest('[data-action="mark-meeting-read"]');
    if (read) return { type: 'read-meeting', id: read.closest('[data-meeting-id]')?.dataset.meetingId };
    const usage = target.closest('[data-usage-id]');
    if (usage) return { type: 'usage', id: usage.getAttribute('data-usage-id') };
    const jump = target.closest('[data-sub-id]');
    if (jump) return { type: 'session', id: jump.getAttribute('data-sub-id'), latest: true };
    const toggle = target.closest('[data-action="toggle-expand"]');
    if (toggle) {
      const meeting = toggle.closest('[data-meeting-id]');
      return meeting ? { type: 'toggle-meeting', id: meeting.getAttribute('data-meeting-id') } : null;
    }
    const meeting = target.closest('[data-meeting-id]');
    if (meeting) return { type: 'meeting', id: meeting.getAttribute('data-meeting-id') };
    const session = target.closest('[data-session-id]');
    if (session) return { type: 'session', id: session.getAttribute('data-session-id') };
    return null;
  }

  function activateNavigationIntent(intent) {
    if (!intent || !intent.id) return false;
    try {
      if (intent.type === 'read-meeting') {
        markMeetingRead?.(intent.id);
        return true;
      }
      if (intent.type === 'usage') {
        // Usage details live in the hover tooltip. Consume the click so it
        // does not activate or resume the surrounding session row.
        return true;
      }
      if (intent.type === 'toggle-meeting') {
        toggleMeetingExpand(intent.id);
        return true;
      }
      const forceScrollBottom = !!intent.latest || intent.id === getActiveSessionId()
        || sessionHasCompletedUnread(getSessions().get(intent.id))
        || Object.values(getMeetings()).some(m => getMeetingUnreadMemberIds(m, getSessions()).has(intent.id));
      const action = intent.type === 'meeting'
        ? selectMeeting(intent.id, { forceScrollBottom: true, wakeDormantMembers: true })
        : selectSession(intent.id, { forceScrollBottom });
      Promise.resolve(action).catch(error => console.warn('[sidebar] navigation failed:', error));
      return true;
    } catch (error) {
      console.warn('[sidebar] navigation failed:', error);
      return false;
    }
  }

  sessionListEl.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    const rawIntent = navigationIntentFromTarget(event.target);
    const now = Date.now();
    const x = Number(event.clientX) || 0;
    const y = Number(event.clientY) || 0;
    // A first click can immediately reorder the selected/resuming row. The
    // second half of a physical double-click then lands on whatever row moved
    // into the old coordinates, even though the user's intent did not change.
    // Keep the first intent for a same-position repeat inside the native
    // double-click window; a deliberate click elsewhere still uses its row.
    const repeatedAtSamePoint = lastPointerActivation
      && now - lastPointerActivation.at <= POINTER_REPEAT_INTENT_MS
      && Math.hypot(x - lastPointerActivation.x, y - lastPointerActivation.y) <= POINTER_NAV_MAX_MOVE_PX;
    const intent = rawIntent && repeatedAtSamePoint ? lastPointerActivation.intent : rawIntent;
    if (!intent || !intent.id) return;
    pendingPointerNavigation = {
      intent,
      pointerId: event.pointerId,
      x,
      y,
    };
    try { sessionListEl.setPointerCapture?.(event.pointerId); } catch {}
  });

  sessionListEl.addEventListener('pointerup', (event) => {
    const pending = pendingPointerNavigation;
    if (!pending || pending.pointerId !== event.pointerId) return;
    pendingPointerNavigation = null;
    try { sessionListEl.releasePointerCapture?.(event.pointerId); } catch {}
    const moved = Math.hypot(
      (Number(event.clientX) || 0) - pending.x,
      (Number(event.clientY) || 0) - pending.y,
    );
    lastPointerNavigationAt = Date.now();
    if (moved > POINTER_NAV_MAX_MOVE_PX) return;
    lastPointerActivation = {
      intent: pending.intent,
      x: pending.x,
      y: pending.y,
      at: Date.now(),
    };
    event.preventDefault();
    event.stopPropagation();
    activateNavigationIntent(pending.intent);
  });

  sessionListEl.addEventListener('pointercancel', (event) => {
    if (pendingPointerNavigation && pendingPointerNavigation.pointerId === event.pointerId) {
      pendingPointerNavigation = null;
    }
  });

  // Keyboard activation and older PointerEvent fallbacks still arrive as
  // click. Suppress the synthetic click that follows a handled pointer-up.
  sessionListEl.addEventListener('click', (event) => {
    const intent = navigationIntentFromTarget(event.target);
    if (!intent || !intent.id) return;
    // A wholesale rebuild may put a *different* row under the pointer before
    // Chromium emits its compatibility click. The pointer-up already honored
    // the captured intent, so suppress any immediately following mouse click,
    // not only one whose new DOM target happens to have the same id. Keyboard
    // and programmatic activation use detail=0 and remain available.
    const duplicate = lastPointerNavigationAt > 0
      && event.detail !== 0
      && Date.now() - lastPointerNavigationAt <= POINTER_CLICK_SUPPRESS_MS;
    event.preventDefault();
    event.stopPropagation();
    if (!duplicate) activateNavigationIntent(intent);
  });

sessionListEl.addEventListener('keydown', event => {
  if (event.altKey || event.ctrlKey || event.metaKey || event.isComposing) return;
  const row = event.target?.closest?.('.session-item');
  if (!row) return;
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    const rows = [...sessionListEl.querySelectorAll('.session-item')]
      .filter(el => !el.getClientRects || el.getClientRects().length > 0);
    const index = rows.indexOf(row);
    const next = rows[Math.max(0, Math.min(rows.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)))];
    event.preventDefault(); event.stopPropagation(); next?.focus();
  } else if (event.key === 'Enter' && event.target === row) {
    event.preventDefault(); event.stopPropagation();
    activateNavigationIntent(navigationIntentFromTarget(row));
  }
});

// --- Session list rendering ---
// Sort: pinned sessions first, ordinary/group sessions by latest activity, and
// explicit bottomed sessions last.  The final render also gives bottomed items
// their own literal last section so age/status buckets cannot move below them.
// Tree shape: meeting entries optionally expand to show their child sub-sessions.
// Top-level regular sessions (no meetingId) sit alongside meetings in the same sort order.
  function collectSidebarItems(sessionMap = getSessions()) {
    const memberIds = new Set(Object.values(getMeetings()).flatMap(m => m.subSessions || []));
    const regularSessions = Array.from(sessionMap.values())
    .filter(s => !s.meetingId && !memberIds.has(s.id) && s.kind !== 'xresearch-run' && !s.hiddenFromSidebar && s.purpose !== 'xresearch-research');

  const meetingItems = Object.values(getMeetings()).map(m => ({
    id: m.id,
    title: m.title,
    lastMessageTime: m.lastMessageTime,
    lastCompletedAt: m.lastCompletedAt,
    createdAt: m.createdAt,
    lastOutputPreview: m.groupChat
      ? `AI 群聊 · ${(m.participants || m.subSessions || []).length}/${(m.subSessions || []).length} 已选`
      : `${m.subSessions.length} 个子会话`,
    status: m.status || 'idle',
    unreadAnsweredSize: getMeetingUnreadMemberIds(m, sessionMap).size,
    pinned: m.pinned,
    bottomed: m.bottomed,
    _isMeeting: true,
    _meeting: m,
  }));

  const all = regularSessions.concat(meetingItems);

  const sorted = sortBySidebarPlacement(all);

  // Hide any leftover legacy background PTY sessions from the removed room path.
  const everything = sorted.filter(s => !s.title || !s.title.startsWith('[Team] '));

    return everything;
  }
  sidebarSources.set(doc, () => {
    const sessionMap = getSessions();
    const items = collectSidebarItems(sessionMap);
    const parts = sidebarView(items, sessionMap);
    const archived = new Set(parts.archive.map(s => s.id));
    return items.map(s => ({ ...s,
      key: (s._isMeeting ? 'live-meeting:' : 'live-session:') + s.id,
      hubSessionId: s._isMeeting ? null : s.id, meetingId: s._isMeeting ? s.id : null,
      provider: s._isMeeting ? 'meeting' : String(s.kind || '').replace(/-resume$/, '').replace(/^deepseek.*$/, 'deepseek'),
      archived: archived.has(s.id), agentGroup: agentGroupOf(s),
      updatedAt: latestActivityTime(s),
      cwd: s._isMeeting ? s._meeting.workspace : s.cwd,
      projectLabel: s._isMeeting ? s._meeting.workspaceLabel : s.workspaceLabel,
    }));
  });
  function openSearch(detail) {
    if (typeof options.openSearch === 'function') return options.openSearch(detail);
    doc.dispatchEvent(new doc.defaultView.CustomEvent('sidebar:open-search', { detail }));
  }
  function filteredSidebarItems(sessionMap = getSessions()) {
    return collectSidebarItems(sessionMap).filter(item => projectFilter.matches(item) && (modelFilter === 'all' || sessionFamilies(item, sessionMap).has(modelFilter)));
  }
  function revealSearchItem(id, memberId = null) {
    const item = collectSidebarItems().find(entry => entry.id === id);
    if (!item) return;
    if (pinnedOnly !== !!item.pinned) {
      pinnedOnly = !!item.pinned;
      savePreference('hubSidebarRange',pinnedOnly ? 'pinned' : String(recentDays)); syncRangeControls();
    }
    projectFilter.reveal(item);
    const member = memberId && item._meeting?.subSessions?.includes(memberId) ? getSessions().get(memberId) : null;
    if (modelFilter !== 'all' && !(member ? sessionFamilies(member, getSessions()) : sessionFamilies(item, getSessions())).has(modelFilter)) {
      modelFilter = 'all';
      if (modelControl) modelControl.value = modelFilter;
      savePreference('hubSidebarModelFilter', modelFilter);
    }
    if (member) {
      collapsedDetailsMeetings.delete(id);
      _expandedMeetings.add(id);
      _persistExpandedMeetings();
    }
    if (!pinnedOnly && Date.now() - latestActivityTime(item) >= recentDays * 86400000) {
      recentDays = 3;
      savePreference('hubSidebarRecentDays', '3'); syncRangeControls();
    }
    const parts = sidebarView([item]);
    const key = parts.failed.length ? 'sec-failed' : parts.active.length ? 'sec-active' : 'sec-today';
    collapsedSections.delete(key);
    savePreference('hubSidebarCollapsedSections', JSON.stringify([...collapsedSections]));
    renderSessionList();
  }
  doc.addEventListener?.('sidebar:manage-pin', event => {
    if (!collectSidebarItems().some(item => item.id === event.detail?.id && item.pinned)) return;
    openContextMenu(event.detail.id, event.detail.x, event.detail.y);
  });
  let archivingToday = false;
  async function archiveToday() {
    if (archivingToday) return;
    archivingToday = true;
    const failures = [];
    try {
      const ipc = options.ipcRenderer || require('electron').ipcRenderer;
      const current = sidebarView(filteredSidebarItems());
      for (const item of current.today.filter(item => !item.pinned && !sidebarItemHasUnread(item, getSessions()))) {
        try {
          const members = item._isMeeting ? (item._meeting.subSessions || []) : [item.id];
          for (const id of members) {
            if (getSessions().get(id)?.status === 'dormant') continue;
            const result = await ipc.invoke('suspend-session', { sessionId: id });
            if (!result?.ok) throw new Error(result?.message || result?.error || '休眠失败');
          }
          if (item._isMeeting) {
            const updated = await ipc.invoke('update-meeting-sync', { meetingId: item.id, fields: { status: 'dormant' } });
            if (!updated) throw new Error('群聊归档状态保存失败');
          }
        } catch (error) { failures.push((item.title || item.id) + '：' + error.message); }
      }
    } catch (error) { failures.push(error.message); }
    finally { archivingToday = false; renderSessionList(); }
    if (failures.length) {
      const message = '部分会话未归档，仍保留原入口：\n' + failures.join('\n');
      console.warn('[sidebar] archive:', message);
      if (options.notify) options.notify(message);
      else require('./ui-feedback').showHubAlert(message, { document: doc });
    }
  }

  function renderSessionList() {
    // One clock and one classification per item for the whole render: the
    // assistant snapshot and the sidebar sections used to classify all
    // sessions separately, three times a second.
    const renderNow = Date.now();
    const renderSessions = getSessions();
    const classifications = new Map();
    const classify = item => {
      let result = classifications.get(item);
      if (!result) { result = sidebarItemClassification(item, { now: renderNow, sessionMap: renderSessions }); classifications.set(item, result); }
      return result;
    };
  publishSessionViews([...renderSessions.values()], { now: renderNow, classify });
    const renderStartedAt = nowMs();
    // Rebuilt rows join the same clock instead of restarting their pulse on
    // every runtime delta (which can otherwise make a busy logo look static).
    if(!sidebarPhaseInitialized){
      sessionListEl.style?.setProperty('--sidebar-work-phase', `${-(Date.now() % 24000)}ms`);
      sidebarPhaseInitialized=true;
    }
    const sessionMap = renderSessions;
  const visible = filteredSidebarItems(sessionMap);
  const sections = sidebarView(visible, sessionMap, recentDays, { now: renderNow, classify });
  // Preserve scroll position across rebuilds — without this, any re-render
  // (every status-event, silence-timer, or session-updated) snaps the list
  // back to the top, which feels like the sidebar is "fighting" the user.
  const savedScrollTop = sessionListEl.scrollTop;
  const focused = doc.activeElement;
  const focusId = focused?.dataset?.sessionId || focused?.dataset?.meetingId;
  const focusControl = focused?.dataset?.sidebarControl;
  const hadListFocus = focused && sessionListEl.contains?.(focused);
  // Build the entire status reclassification off-DOM, then commit once. A
  // running -> needs-input transition used to clear and repopulate the live
  // sidebar one node at a time, forcing repeated style/layout work and making
  // the window look frozen exactly when categories jumped.
  const fragment = typeof doc.createDocumentFragment === 'function'
    ? doc.createDocumentFragment()
    : null;
  const renderTarget = fragment || sessionListEl;
  if (!fragment) sessionListEl.innerHTML = '';

  // 单条渲染（会话/会议），供「置顶 recent + 时间组」复用。
  const detailSessionIds = new Set();
  const unreadMemberIds = new Set(Object.values(getMeetings()).flatMap(m => [...getMeetingUnreadMemberIds(m, sessionMap)]));
  function appendItem(s, child = false, target = renderTarget) {
    if (s._isMeeting) {
      const isActive = getActiveMeetingId() === s.id;
      const isGroupChat = !!s._meeting.groupChat;
      // Compact groups reveal members on hover/focus; detail mode has an
      // explicit collapse arrow. Legacy meeting expansion stays unchanged.
      const canExpand = !isGroupChat || detailsEnabled;
      const isExpanded = isGroupChat && detailsEnabled
        ? !collapsedDetailsMeetings.has(s.id) : canExpand && _expandedMeetings.has(s.id);
      const groupContainer = isGroupChat ? doc.createElement('div') : null;
      if (groupContainer) {
        groupContainer.className = 'sidebar-group' + (detailsEnabled ? ' detailed-group' : ' compact-group')
          + (s._meeting.subSessions?.includes(getActiveSessionId()) ? ' has-active-member' : '')
          + (hoveredMeetingId === s.id ? ' hover-open' : '');
        groupContainer.dataset.sidebarGroup = s.id;
        groupContainer.dataset.sidebarRenderKey='group:'+s.id;
        groupContainer.dataset.sidebarRenderTree='true';
        target.appendChild(groupContainer);
      }
      const div = doc.createElement('div');
      // 2026-07-19 maintainer · 方案C：群聊两行卡（行1 状态+标题+时间，行2 成员 mini-jump），
      //   不再渲染 badge pill（等你/休眠进 sl-state，已选数进行2 末尾）。
      const isDormantMeeting = s.status === 'dormant';
      const unreadMembers = getMeetingUnreadMemberIds(s._meeting, sessionMap);
      const hasUnread = sidebarItemHasUnread(s, sessionMap);
      // 2026-07-20 maintainer：群聊运行中 = 任一成员 agent 在运行（成员 running 已语义化）
      const meetingRuntime = _meetingRuntimeAggregate(s._meeting, sessionMap);
      const anySubRunning = meetingRuntime.running;
      const anySubWaiting = meetingRuntime.waiting;
      const anySubFailed = meetingRuntime.failed;
      div.className = 'session-item slim meeting' + (isGroupChat ? ' gc' : '')
        + (anySubFailed ? ' runtime-error' : '')
        + (anySubRunning ? ' running' : '')
        + (detailsEnabled ? ' has-session-details' : '')
        + (isActive ? ' selected' : '')
        + (isExpanded ? ' expanded' : '') + (isDormantMeeting ? ' dormant' : '')
        + (hasUnread ? ' need-unread' : '');
      div.dataset.meetingId = s.id;
      div.dataset.sidebarRenderKey='meeting:'+s.id;
      div.tabIndex = 0;
      const SLOT_LABELS_M = ['一号位', '二号位', '三号位'];
      const miniSids = isGroupChat ? (s._meeting.subSessions || []) : (s._meeting.subSessions || []).slice(0, 3);
      const memberTotal = (s._meeting.subSessions || []).length;
      const memberSelected = isGroupChat
        ? (Array.isArray(s._meeting.participants) ? s._meeting.participants.length : memberTotal)
        : memberTotal;
      div.setAttribute('aria-label', isDormantMeeting ? `${s.title} · 休眠中 · ${memberSelected}/${memberTotal} 已选 · 点击打开群聊` : s.title);
      // 群聊子会话默认折叠，若只在普通 session 行画告警，Claude/DeepSeek 成员的
      // memory link 错误在最常用的群聊视图里仍然不可见。父行聚合显示，mini-jump
      // tooltip 再指出具体成员。
      const meetingWarning = miniSids.map((subId, idx) => {
        const sub = sessionMap.get(subId);
        const warning = _sessionWarningText(sub);
        if (!warning) return '';
        return `${(sub && (sub.title || sub.kind)) || `AI ${idx + 1}`}：${warning}`;
      }).filter(Boolean).join('；');
      const miniJumpsHtml = isGroupChat ? '' : miniSids.map((subId, idx) => {
        const sub = sessionMap.get(subId);
        const label = isGroupChat
          ? ((sub && (sub.title || sub.kind)) || `AI ${idx + 1}`)
          : (SLOT_LABELS_M[idx] || `Slot ${idx + 1}`);
        const avatarSrc = sub && sub.kind
          // *-resume 没有专属 svg，归一到基础 kind 头像（assets 只有 5+1 个基础 logo）
          ? `assets/ai-logos/${String(sub.kind).replace(/-resume$/, '')}.svg`
          : '';
        const modelLabel = sub && sub.currentModel ? (typeof modelShort === 'function' ? modelShort(sub.currentModel) : sub.currentModel.id) : '';
        const subRuntime = sub ? getSessionRuntimeTruth(sub) : null;
        let statusCls = 'mini-st-ready';
        if (!sub) statusCls = 'mini-st-init';
        else if (subRuntime.state === RUNTIME_DORMANT) statusCls = 'mini-st-dormant';
        else if (sessionRuntimeIssue(sub, subRuntime)) statusCls = 'mini-st-error';
        else if (subRuntime.state === RUNTIME_WAITING) statusCls = 'mini-st-waiting';
        else if (_subIsRunning(sub)) statusCls = 'mini-st-thinking';
        else if (subRuntime.state === RUNTIME_UNKNOWN) statusCls = 'mini-st-unknown';
        const isActiveChild = subId === getActiveSessionId();
        const ctxPct = isGroupChat && sub && typeof sub.contextPct === 'number' ? sub.contextPct : null;
        const ctxCls = ctxPct != null && typeof pctClass === 'function' ? pctClass(ctxPct) : '';
        const ctxLabelHtml = ctxPct != null
          ? `<span class="mini-jump-ctx ${ctxCls}" title="Context ${ctxPct}%">${ctxPct}%</span>`
          : '';
        const subWarning = _sessionWarningText(sub);
        const runtimeTip = subRuntime ? runtimeTruthSummary(subRuntime) : '尚未初始化';
        const tooltip = `${label}${modelLabel ? ' · ' + modelLabel : ''}${ctxPct != null ? ' · Ctx ' + ctxPct + '%' : ''} · ${runtimeTip}${subWarning ? ' · ⚠ ' + subWarning : ''} (点击跳转)`;
        const avatarHtml = isGroupChat
          ? `<span class="mini-jump-text">${escapeHtml(sub && sub.kind ? sub.kind : ('AI' + (idx + 1)))}</span>`
          : (avatarSrc
            ? `<img src="${avatarSrc}" alt="${escapeHtml(label)}" />`
            : `<span class="mini-jump-letter">${escapeHtml(String(idx + 1))}</span>`);
        return `<span class="mini-jump-cell">
          <button class="mini-jump-btn slot-${idx + 1}${isGroupChat ? ' group' : ''}${isActiveChild ? ' active' : ''}" data-sub-id="${subId}" title="${escapeHtml(tooltip)}">
            ${avatarHtml}
            <span class="mini-jump-status-dot ${statusCls}"></span>
          </button>${ctxLabelHtml}
        </span>`;
      }).join('');
      // 异常先提醒；其他成员的实际运行状态仍由各成员行展示。
      const dotCls = sections.states.get(s.id) || 'idle';
      div.dataset.state = dotCls;
      const logos = (s._meeting.subSessions || []).slice(0, 2).map(id => {
        const member = sessionMap.get(id);
        if (!member) return '';
        let state = partitionSidebarSessions([member], { sessionMap, groupMemberIds: new Set([id]) }).states.get(id) || 'idle';
        if (getSessionRuntimeTruth(member).state === RUNTIME_DORMANT && !member._resumePending && state !== 'error') state = 'dorm';
        return _sessionKindHtml(member.kind, member.currentModel ? modelShort(member.currentModel) : '', state);
      }).join('');
      const answered = s._meeting.answeredThisTurn?.size || 0;
      const progress = memberTotal ? Math.min(100, answered / memberTotal * 100) : 0;
      const unreadChips = isGroupChat && hasUnread ? (s._meeting.subSessions || []).map(sid => {
        const sub = sessionMap.get(sid);
        const unread = unreadMembers.has(sid);
        const runtime = sub ? getSessionRuntimeTruth(sub) : null;
        const state = runtime?.state === RUNTIME_WAITING ? 'wait' : _subIsRunning(sub) ? 'run' : '';
        const label = sub?.title || KIND_LABELS[_logoKind(sub?.kind)] || '成员';
        return `<button type="button" class="mini-jump-btn sl-unread-member${unread ? ' has-unread' : ''}" data-sub-id="${escapeHtml(sid)}" title="${escapeHtml(label)} · ${unread ? '有未读，查看最新回答' : '查看成员'}"><span class="sl-member-name">${escapeHtml(label)}</span>${state ? `<span class="sl-member-runtime ${state}">${state === 'wait' ? '待输入' : '运行中'}</span>` : ''}${unread ? '<span class="sl-member-unread-dot" aria-label="未读"></span>' : ''}</button>`;
      }).join('') : '';
      div.innerHTML = [
        '<div class="sl-line1' + (canExpand ? ' with-arrow' : '') + '">',
        canExpand ? '<span class="expand-arrow" data-action="toggle-expand" title="展开成员">▸</span>' : '',
        '<span class="sl-title" aria-label="' + escapeHtml([s.title, meetingWarning, unreadMembers.size + ' 位未读'].filter(Boolean).join(' · ')) + '">' + _warningHtml(meetingWarning) + escapeHtml(s.title) + (s._meeting?.orchestration?.enabled === true ? '<span class="sl-orch-tag" title="AI 编排模式">编排</span>' : '') + '</span>',
        '<span class="sl-group-logos" data-state="' + dotCls + '" aria-label="群聊 · ' + STATUS_LABELS[dotCls] + '">' + (logos || `<svg class="sl-kind sl-group-icon" data-state="${dotCls}" role="img" aria-label="群聊 · ${STATUS_LABELS[dotCls]}" viewBox="0 0 24 24"><path d="M9 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM3 20v-2a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v2M16 5a3 3 0 0 1 0 6m1 3a4 4 0 0 1 4 4v2"/></svg>`) + '</span>',
        timeHtml(s, hasUnread ? unreadMembers.size : 0) + '</div>',
        hasUnread ? '<div class="sl-group-actions">' + (unreadChips ? '<div class="sl-unread-members">' + unreadChips + '</div>' : '')
          + (markMeetingRead ? '<button type="button" class="sl-meeting-read" data-action="mark-meeting-read" data-sidebar-control="read-' + escapeHtml(s.id) + '">整组已读</button>' : '') + '</div>' : '',
        isGroupChat ? '' : '<div class="session-mini-jumps">' + miniJumpsHtml + '<span class="sl-members-hint">' + memberSelected + '/' + memberTotal + ' 已选</span></div>',
        isGroupChat ? '<span class="sl-group-progress" title="本轮已答 ' + answered + '/' + memberTotal + '"><i style="width:' + progress + '%"></i></span>' : '',
      ].join('');
      div.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        const member = e.target.closest('.mini-jump-btn[data-sub-id]');
        openContextMenu(member ? member.dataset.subId : s.id, e.clientX, e.clientY);
      });
      (groupContainer || target).appendChild(div);

      if (isGroupChat) {
        if (!detailsEnabled || isExpanded) {
          const children = doc.createElement('div');
          children.className = 'sidebar-group-children';
          children.dataset.sidebarRenderKey='members:'+s.id;
          children.dataset.sidebarRenderTree='true';
          groupContainer.appendChild(children);
          for (const id of s._meeting.subSessions || []) {
            const member = sessionMap.get(id);
            if (member && (modelFilter === 'all' || familyOfKind(member.kind) === modelFilter)) appendItem(member, true, children);
          }
        }
        return;
      }

      // Expanded members use the same compact row and default-card navigation.
      if (isExpanded) {
        for (const subId of s._meeting.subSessions) {
          const sub = sessionMap.get(subId);
          if (!sub) continue;
          if (modelFilter !== 'all' && familyOfKind(sub.kind) !== modelFilter) continue;
          appendItem(sub, true, target);
        }
      }
      return;
    }

    // Compact rows: title, stateful provider logo, and abbreviated activity time.
    // Runtime/context/unread details remain available through accessible labels.
    const isActive = s.id === getActiveSessionId();
    const runtimeTruth = getSessionRuntimeTruth(s, { now: Date.now() });
    const div = doc.createElement('div');
    div.tabIndex = 0;
    div.dataset.sessionId = s.id;
    div.dataset.sidebarRenderKey='session:'+s.id;
    div.dataset.runtimeState = runtimeTruth.state;
    div.dataset.runtimeSource = runtimeTruth.source || '';
    div.dataset.runtimeConfidence = runtimeTruth.confidence || '';
    const isDormant = runtimeTruth.state === RUNTIME_DORMANT;
    const isResumePending = s._resumePending === true;
    const issue = sessionRuntimeIssue(s, runtimeTruth);
    const isDisconnected = issue?.label === '连接异常';
    const dormantCls = isDormant ? ' dormant' : '';
    const showWaiting = runtimeTruth.state === RUNTIME_WAITING;
    const unreadCount = Math.max(0, Number(s.unreadCount) || 0);
    const showUnread = sessionHasCompletedUnread(s) || unreadMemberIds.has(s.id);
    // 已确认异常和待核对断连优先，不能被未读或选中状态掩盖。
    const dotCls = issue ? 'error' : s._resumePending ? 'start' : (child
      ? partitionSidebarSessions([s], { sessionMap, activeSessionId: getActiveSessionId(), groupMemberIds: new Set([s.id]) }).states.get(s.id)
      : sections.states.get(s.id)) || 'idle';
    const showRunning = dotCls === 'run' || dotCls === 'start';
    div.className = 'session-item slim' + (isActive ? ' selected' : '')
      + (showWaiting ? ' need-wait' : '') + (showUnread ? ' need-unread' : '') + dormantCls
      + (showRunning ? ' running' : '')
      + (isResumePending ? ' resuming' : '')
      + (issue ? ' runtime-error' : '')
      + (isDisconnected ? ' disconnected' : '');
    const ctxPct = typeof s.contextPct === 'number' ? s.contextPct : null;
    const modelTxt = s.currentModel ? modelShort(s.currentModel) : '';
    const anyWarning = _sessionWarningText(s);
    const dormantStateTip = isResumePending
      ? '正在唤醒原生 CLI 与历史上下文'
      : isDormant
      ? `${s.suspendReason === 'idle-timeout' ? '自动休眠' : '休眠中'}${showUnread ? `，有 ${unreadCount} 条未读` : ''}，点击唤醒`
      : '';
    const accessibleSummary = [s.title,
      s.currentModel ? (s.currentModel.displayName || s.currentModel.id) : '',
      ctxPct != null ? `Ctx ${ctxPct}%` : '',
      anyWarning,
      isDisconnected ? '连接已断开，点击进入核对' : '',
      runtimeTruthSummary(runtimeTruth),
      dormantStateTip || (showWaiting
        ? (s.waitingText || '等你输入')
        : (showUnread ? (s.replyReadyText || s.lastOutputPreview || '有完成结果尚未查看') : '')),
    ].filter(Boolean).join(' · ');
    div.setAttribute('aria-label', accessibleSummary);
    div.innerHTML = '<span class="sl-title">' + _warningHtml(anyWarning) + escapeHtml(s.title) + '</span>'
      + _sessionKindHtml(s.kind, modelTxt, isDormant && !isResumePending && !issue ? 'dorm' : dotCls, dormantStateTip || runtimeTruthSummary(runtimeTruth))
      + timeHtml(s, showUnread ? Math.max(1, unreadCount) : 0);
    if (child) div.className += ' child';
    if (detailsEnabled) {
      div.className += ' has-details';
      div.innerHTML = '<div class="sl-line1">' + div.innerHTML + '</div>'
        + detailsHtml(s, { escapeHtml, modelShort });
      detailSessionIds.add(s.id);
    }
    div.addEventListener('contextmenu', (e) => { e.preventDefault(); openContextMenu(s.id, e.clientX, e.clientY); });
    target.appendChild(div);
  }

  function appendSecHeader(label, items, cls, action, onAction) {
    const collapsed = collapsedSections.has(cls);
    const h = doc.createElement('div');
    h.className = 'session-sec-header ' + cls;
    h.dataset.sidebarRenderKey='section:'+cls;
    h.innerHTML = '<button type="button" class="sec-collapse" data-sidebar-control="' + cls + '" aria-label="' + (collapsed ? '展开' : '折叠') + label + '" aria-expanded="' + !collapsed + '">' + (collapsed ? '▸' : '▾') + '</button><span>' + label + '</span><span class="sec-count">' + items.length + '</span><span class="sec-rule"></span>'
      + (action ? '<button type="button" class="sec-action ' + (cls === 'sec-unread' ? 'sec-mark-all-read' : '') + '">' + action + '</button>' : '');
    h.addEventListener('click', event => {
      if (event.target?.closest?.('.sec-collapse') || /sec-collapse/.test(event.target?.className || '')) {
        event.preventDefault(); event.stopPropagation();
        if (collapsedSections.has(cls)) collapsedSections.delete(cls); else collapsedSections.add(cls);
        savePreference('hubSidebarCollapsedSections', JSON.stringify([...collapsedSections]));
        renderSessionList();
        return;
      }
      if (!event.target?.closest?.('.sec-action') && !/sec-action|sec-mark-all-read/.test(event.target?.className || '')) return;
      event.preventDefault(); event.stopPropagation();
      return onAction?.();
    });
    renderTarget.appendChild(h);
    if (!collapsed) for (const item of items) appendItem(item);
  }
  if (sections.failed.length) appendSecHeader('异常', sections.failed, 'sec-failed');
  if (sections.active.length) appendSecHeader('活跃', sections.active, 'sec-active');
  appendSecHeader(pinnedOnly ? '置顶' : recentDays === 3 ? '3 天内' : '今天', sections.today, 'sec-today', !pinnedOnly && sections.today.length ? '休眠' : '', archiveToday);
  if (markAllSessionsRead && visible.some(item => sidebarItemHasUnread(item, sessionMap))) {
    const read = doc.createElement('button'); read.type = 'button'; read.className = 'sidebar-mark-read';
    read.textContent = '全部已读'; read.addEventListener('click', markAllSessionsRead); renderTarget.appendChild(read);
    read.dataset.sidebarRenderKey='mark-all-read';
  }
  const archive = doc.createElement('button');
  archive.type = 'button';
  archive.className = 'session-archive-entry';
  archive.dataset.sidebarRenderKey='archive';
  archive.innerHTML = '<span>归档</span><span class="archive-count">' + sections.archiveCount + '</span><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 5 7 7-7 7" fill="none" stroke="currentColor" stroke-width="1.8"/></svg>';
  archive.addEventListener('click', () => openSearch({ scope: 'dormant' }));
  renderTarget.appendChild(archive);

  if (fragment) {
    if (typeof sessionListEl.replaceChildren === 'function') reconcileSidebarDom(sessionListEl,fragment);
    else {
      sessionListEl.innerHTML = '';
      sessionListEl.appendChild(fragment);
    }
  }

  renderSidebarStrip(sessionMap);

  if (afterRender) afterRender();
  if (detailsEnabled && options.requestSessionUsage) options.requestSessionUsage([...detailSessionIds]);

  sessionListEl.scrollTop = savedScrollTop;
  // Whole-list updates must preserve a stationary pointer's expanded group.
  // If sorting moved that group away, release it at its new geometry.
  if (hoverPoint && hoveredMeetingId && sessionListEl.querySelectorAll) {
    const group = [...sessionListEl.querySelectorAll('.sidebar-group')].find(el => el.dataset.sidebarGroup === hoveredMeetingId);
    const rect = group?.getBoundingClientRect();
    if (!rect || hoverPoint.x < rect.left || hoverPoint.x > rect.right || hoverPoint.y < rect.top || hoverPoint.y > rect.bottom) {
      hoveredMeetingId = null;
      group?.classList.remove('hover-open');
    }
  }
  if (hadListFocus && focusId) {
    const replacement = [...sessionListEl.querySelectorAll('.session-item')].find(row => (row.dataset.sessionId || row.dataset.meetingId) === focusId);
    replacement?.focus({ preventScroll: true });
  }
  if (hadListFocus && focusControl) {
    [...sessionListEl.querySelectorAll('[data-sidebar-control]')].find(control => control.dataset.sidebarControl === focusControl)?.focus({ preventScroll: true });
  }
  const elapsed = Math.max(0, nowMs() - renderStartedAt);
  renderStats.renders += 1;
  renderStats.lastMs = elapsed;
  renderStats.maxMs = Math.max(renderStats.maxMs, elapsed);
  if (elapsed >= 50) renderStats.slowRenders += 1;
}

// --- Session card hover light-tracking + click ripple (event delegation) ---
sessionListEl.addEventListener('mousemove', (e) => {
  const group = e.target.closest('.sidebar-group');
  hoveredMeetingId = group?.dataset.sidebarGroup || null;
  hoverPoint = { x: e.clientX, y: e.clientY };
  for (const wrapper of sessionListEl.querySelectorAll('.sidebar-group')) {
    wrapper.classList.toggle('hover-open', wrapper.dataset.sidebarGroup === hoveredMeetingId);
  }
  const item = e.target.closest('.session-item');
  if (!item) return;
  const rect = item.getBoundingClientRect();
  item.style.setProperty('--mx', ((e.clientX - rect.left) / rect.width * 100) + '%');
  item.style.setProperty('--my', ((e.clientY - rect.top) / rect.height * 100) + '%');
});
sessionListEl.addEventListener('mouseleave', () => {
  hoveredMeetingId = null;
  hoverPoint = null;
  for (const wrapper of sessionListEl.querySelectorAll('.sidebar-group')) wrapper.classList.remove('hover-open');
});
sessionListEl.addEventListener('mousedown', (e) => {
  const item = e.target.closest('.session-item');
  if (!item) return;
  const rect = item.getBoundingClientRect();
  const size = Math.max(rect.width, rect.height);
  const r = doc.createElement('span');
  r.className = 'ripple-fx';
  r.style.width = r.style.height = size + 'px';
  r.style.left = (e.clientX - rect.left - size / 2) + 'px';
  r.style.top = (e.clientY - rect.top - size / 2) + 'px';
  item.appendChild(r);
  setTimeout(() => r.remove(), 450);
});



  queueMicrotask(() => projectFilter.refresh());

  return {
    renderSessionList,
    revealSearchItem,
    renderSidebarStrip,
    getRenderStats: () => ({ ...renderStats }),
  };
}

module.exports = {
  createSessionListRenderer,
  compareLatestActivityDesc,
  compareSidebarPlacement,
  isPinnedToBottom,
  partitionSessionsByAge,
  latestActivityTime,
  familyOfKind,
  sessionFamilies,
  SESSION_FAMILY_TABS,
  AGENT_SESSION_GROUPS,
  agentGroupOf,
  partitionSidebarSessions,
  getSidebarSearchEntries,
};
