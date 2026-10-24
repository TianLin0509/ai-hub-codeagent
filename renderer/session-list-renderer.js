// 纯函数：按最新 AI 回答时间年龄分桶。pinned 永远进 recent（置顶不折叠）。
//   recent: <24h（保持现状 UI 置顶）· mid: 24-72h · old: ≥72h
const { isGroupChatMemberRunning } = require('../core/groupchat-running-state.js');
const { getMeetingUnreadMemberIds } = require('./meeting-unread');
const { compareLatestActivityDesc, latestActivityTime } = require('../core/session-recency.js');
const {
  sessionHasCompletedUnread,
} = require('../core/session-attention-state.js');
const { sessionRuntimeIssue } = require('../core/session-runtime-issue.js');
const { KIND_LABELS, ALL_AI_KINDS } = require('../core/ai-kinds.js');
const { sessionDisplayTitle } = require('../core/session-title-guards.js');
// 右下角「国内正常 / 异常」只关 Kimi / DeepSeek 这类直连的国内 AI；发行版里一个都没有（公司纯净版只有 CodeAgent）就不显示
// （2026-10-13 用户要求删掉）。
const DOMESTIC_ROUTE_KINDS = ['kimi', 'deepseek', 'deepseek-acp', 'deepseek-claude'];
function showDomesticRoute(kindAllowed = require('../core/distribution').kindAllowed) {
  return DOMESTIC_ROUTE_KINDS.some(kind => kindAllowed(kind));
}
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
// 各家模型独立筛选；同品牌的不同后端合并，选项随支持的 AI 注册表扩展。
const SESSION_FAMILY_TABS = [
  { key: 'all', label: '模型' },
  ...[...new Set(['claude','codex',...ALL_AI_KINDS].map(familyOfKind))]
    .filter(key=>ALL_AI_KINDS.some(kind=>familyOfKind(kind)===key && require('../core/distribution').kindAllowed(kind)))
    .map(key=>({key,label:KIND_LABELS[key] || key})),
  { key: 'other', label: '其他' },
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
  if (/^deepseek(?:-(?:acp|claude|legacy))?$/.test(base)) return 'deepseek';
  return ALL_AI_KINDS.includes(base) ? base : 'other';
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

function isWirelessSession(item) {
  // Stable purpose survives renaming. The title prefix also covers older
  // workbench records without purpose; unrelated wireless discussions stay.
  return item?.purpose === 'wireless-proposal' || /^无线\s*[·・]/.test(String(item?.title || '').trim());
}

// 公司版（2026-10-17 用户）：侧栏几乎全是 AI特战队通道替家里开的会话，挤掉了自己的会话。
// 「今天 / 3 天」旁边的「无线」在公司版换成「特战」：平时隐藏这些会话，点亮后只看它们。
function isTezhanSession(item) {
  // 2026-10-20 起公司会话名是配对号牌「Q21 · 家「…」· 模型」，换号重做的带「· 重做 N」，同样算特战会话。
  return item?.purpose === 'company-bridge' || /^(?:AI特战队|特战)\s*[·・]|^\d{4}-Q\d+-[a-z0-9]+(?: · 重做 \d+)?$|^Q\d+ · 家「[^」]*」· /.test(String(item?.title || '').trim());
}
// 公司版助理会话常驻侧栏顶部（2026-10-18 用户：「希望助理是以一个常驻会话形式出现在左侧栏」）。
// 公司侧栏有「特战」「置顶」「今天 / 3 天」「项目」「模型」五个筛选，任何一个都可能把助理会话筛掉（他在公司就看不到它）：
// 助理不进普通分组，单独放在最上面的「助理」一栏，不受筛选影响；有多个（换代留下的旧助理）时只放最新的。
const RESIDENT_PURPOSE = 'company-assistant';
function companyAssistantOn() {
  try { return require('../core/company-assistant/gate').companyAssistantEnabled(); } catch { return false; }
}

function isCompanyEdition() {
  try { return require('../core/distribution').target === 'company'; } catch { return false; }
}

function createSessionListRenderer(options = {}) {
  const { detailsHtml } = require('./session-details.js');
  const doc = options.document || document;
  const storage = options.localStorage || localStorage;
  const bridgeBadge = typeof options.bridgeBadge === 'function' ? options.bridgeBadge
    : id => { try { return (typeof window !== 'undefined' && window._bridgeThreads?.badge(id)) || null; } catch { return null; } };
  doc.addEventListener?.('bridge-threads-updated', () => { try { renderSessionList(); } catch (error) { console.warn('[session-list] bridge refresh failed:', error && error.message); } });
  // CodeAgent 会话的账号字母（renderer/session-account-badge.js）：账号表取到或登录变化后重画会话栏。
  const accountBadge = typeof options.accountBadge === 'function' ? options.accountBadge : (() => {
    const ipc = options.ipcRenderer || (typeof process !== 'undefined' && process.type === 'renderer' ? require('electron').ipcRenderer : null);
    if (!ipc || typeof ipc.invoke !== 'function') return () => null;
    const badges = require('./session-account-badge').createAccountBadges({
      invoke: (channel, payload) => ipc.invoke(channel, payload),
      subscribe: typeof ipc.on === 'function' ? fn => ipc.on('codeagent-pool:changed', (_event, change) => fn(change)) : null,
      onChange: () => { try { renderSessionList(); } catch (error) { console.warn('[session-list] account refresh failed:', error && error.message); } },
    });
    return s => { try { return badges.badge(s); } catch { return null; } };
  })();
  const publishSessionViews=createSessionViewPublisher(packet=>{
    const ipc=options.ipcRenderer || (typeof process!=='undefined'&&process.type==='renderer'?require('electron').ipcRenderer:null);
    ipc?.send?.('assistant:session-view',packet);
  });
  const sectionKeys = ['sec-failed', 'sec-active', 'sec-today'];
  let collapsedSections = new Set();
  let recentDays = 1;
  let pinnedOnly = false;
  let modelFilter = 'all';
  let showWireless = false;
  const tezhanMode = typeof options.companyEdition === 'boolean' ? options.companyEdition : isCompanyEdition();
  let tezhanOnly = false;
  try {
    const saved = JSON.parse(storage.getItem('hubSidebarCollapsedSections') || '[]');
    if (Array.isArray(saved)) collapsedSections = new Set(saved.filter(key => sectionKeys.includes(key)));
    const days = Number(storage.getItem('hubSidebarRecentDays'));
    if ([1, 3].includes(days)) recentDays = days;
    pinnedOnly = storage.getItem('hubSidebarRange') === 'pinned';
    const model = storage.getItem('hubSidebarModelFilter');
    if (SESSION_FAMILY_KEYS.includes(model)) modelFilter = model;
    showWireless = storage.getItem('hubSidebarShowWireless') === 'true';
    tezhanOnly = storage.getItem('hubSidebarTezhanOnly') === 'true';
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
  const wirelessControl = doc.getElementById?.('btn-sidebar-wireless');
  if (tezhanMode && wirelessControl) { wirelessControl.textContent = '特战'; wirelessControl.dataset.mode = 'tezhan'; }
  function syncWirelessControl() {
    if (tezhanMode) {
      wirelessControl?.setAttribute('aria-pressed', String(tezhanOnly));
      wirelessControl?.setAttribute('title', tezhanOnly ? '只看 AI特战队会话中；再点一下回到自己的会话' : '只看 AI特战队会话（平时不在列表里占位置）');
      return;
    }
    wirelessControl?.setAttribute('aria-pressed', String(showWireless));
    wirelessControl?.setAttribute('title', showWireless ? '隐藏无线协作会话' : '显示无线协作会话');
  }
  syncWirelessControl();
  wirelessControl?.addEventListener('click', () => {
    if (tezhanMode) {
      tezhanOnly = !tezhanOnly;
      savePreference('hubSidebarTezhanOnly', String(tezhanOnly));
    } else {
      showWireless = !showWireless;
      savePreference('hubSidebarShowWireless', String(showWireless));
    }
    syncWirelessControl(); renderSessionList();
  });
  const sideFilterPasses = item => tezhanMode ? isTezhanSession(item) === tezhanOnly : (showWireless || !isWirelessSession(item));
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
    modelControl.innerHTML = SESSION_FAMILY_TABS.map(tab=>`<option value="${tab.key}">${tab.label}</option>`).join('');
    // 发行版裁掉了某个家族（公司版没有 Claude / Codex）而偏好里还存着它：退回「全部」，免得侧栏空着。
    const options = [...(modelControl.options || [])];
    if (options.length && !options.some(option => option.value === modelFilter && !option.hidden)) modelFilter = 'all';
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

function _logoKind(kind, modelId = '') {
  const k = String(kind || '').replace(/-resume$/, '');
  if (k.startsWith('deepseek')) return 'deepseek'; // deepseek-legacy 复用 DS 图标
  // 公司 CodeAgent 背后可能是 DeepSeek / MiniMax / GLM：按模型挑图标，GLM 和认不出的沿用 CodeAgent 图标。
  if (k === 'codeagent') {
    const family = require('../core/codeagent-models').modelFamily(modelId);
    return ['deepseek', 'minimax', 'qwen'].includes(family) ? family : 'codeagent';
  }
  if (k === 'powershell' || isAiKind(k)) return k;
  return '';
}

// AI mini logo for sidebar sub-session items. Reuses the .ai-logo + .logo-<kind>
// classes already defined in styles.css for the toolbar dropdown.
// 侧栏用标题前的品牌小图标标识 AI，具体型号保留在悬停说明中。
//   扫列表时真正要一眼分辨的只是"哪家 CLI"，具体型号是二级信息 → 退到 tooltip
//   （会话行的无障碍标签也包含完整 displayName）。
//   拿不到图标的 kind 回落成原来的文字列，避免这一列直接消失。
function _sessionKindHtml(kind, modelTxt, state = 'idle', stateTip = '', modelId = '', targetSessionId = '') {
  const k = _logoKind(kind, modelId);
  if (!k) return `<span class="sl-model">${escapeHtml(modelTxt || '')}</span>`;
  const labelKind = String(kind || '').replace(/-resume$/, '') === 'codeagent' ? 'codeagent' : k;
  const label = String(modelTxt || '').startsWith('ChatGPT') ? 'ChatGPT' : (KIND_LABELS[labelKind] || labelKind);
  const tip = label === 'ChatGPT' ? modelTxt : modelTxt ? `${label} · ${modelTxt}` : label;
  const status = stateTip || STATUS_LABELS[state] || STATUS_LABELS.idle;
  const action = targetSessionId ? ' · 点击查看该成员的卡片' : '';
  const navigation = targetSessionId
    ? `role="button" tabindex="0" data-sub-id="${escapeHtml(targetSessionId)}" data-sidebar-control="group-logo-${escapeHtml(targetSessionId)}"`
    : 'role="img"';
  return `<span class="sl-kind ai-logo logo-${k}" data-state="${state}" ${navigation} aria-label="${escapeHtml(label + ' · ' + status + action)}" title="${escapeHtml(tip + ' · ' + status + action)}"></span>`;
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
    const egress = proxy && proxy.egress;
    // Hub 没配代理、但 Windows 系统设置里有代理时（公司办公代理），出口探测走系统代理，这里按「代理」显示；
    // xGate（公司安全终端 SPES5）开着时标「xGate」。xGate 的节点配置是加密的，国家以实测出口为准。
    const systemProxy = egress && egress.proxySource === 'system' ? egress.proxyEndpoint : '';
    const proxyShort = _shortProxy(proxy && proxy.proxy) || _shortProxy(systemProxy);
    const xgate = !!(egress && egress.tunnel && egress.tunnel.xgate);
    const vpnNic = egress && egress.tunnel && egress.tunnel.vpn;
    const routeLabel = vpnNic ? 'VPN' : xgate ? 'xGate' : systemProxy ? '代理' : proxyShort ? 'VPN' : '直连';
    const foreign = egress && egress.foreign;
    const domestic = egress && egress.domestic;
    // 读不出代理地址（自动配置脚本）但 xGate 开着时，主进程照样按系统代理探了出口：探到了就显示它（公司直连本来就出不去）。
    const displayRoute = proxyShort || (xgate && foreign && foreign.ok) ? foreign : domestic;
    const alert = egress && egress.alert;
    const clashDelay = proxyShort && proxy?.clashDelay?.status === 'ok' ? proxy.clashDelay : null;

    const ackAttr = alert && alert.acknowledgeable ? ' data-egress-ack="true"' : '';
    const foreignTitle = [
      vpnNic ? `VPN 已连上：${vpnNic.name}（${vpnNic.address}）` : '',
      xgate ? 'xGate（公司安全终端 SPES5）正在运行；它选的节点读不到，下面是实测出口' : '',
      systemProxy ? '公网经 Windows 系统代理' : proxyShort ? 'Claude / Codex 订阅、Gemini：经 VPN 代理' : '未配置 VPN，显示直连出口',
      systemProxy ? `系统代理：${proxyShort}` : proxyShort ? `本地代理：${proxyShort}` : '本地代理：未配置',
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
    // 本机 IP（2026-10-17）：网速右边显示首选的一个（公司电脑通常是 10 段），悬停列出所有网卡的地址。
    const ips = Array.isArray(network?.ips) ? network.ips : [];
    const ipTitle = ips.length ? '本机 IP：\n' + ips.map(x => `${x.name}：${x.address}`).join('\n') : '';
    const ipChip = ips.length ? `<span class="strip-ip" title="${escapeHtml(ipTitle)}" aria-label="${escapeHtml('本机 IP ' + ips[0].address)}">${escapeHtml(ips[0].address)}</span>` : '';
    const transfer = `<span class="strip-transfer" title="${escapeHtml(networkTitle)}" aria-label="${escapeHtml(networkTitle)}"><span class="strip-download"><span class="strip-transfer-label">↓</span><b>${rate(network?.downloadBps)}</b></span><span class="strip-upload"><span class="strip-transfer-label">↑</span><b>${rate(network?.uploadBps)}</b></span>${ipChip}</span>`;
    const location = displayRoute?.ok
      ? [displayRoute.countryZh || displayRoute.country || '国家未知', displayRoute.cityZh || displayRoute.city || '城市未知'].join(' ')
      : '出口未知';
    const domesticLabel = !egress ? '国内检测中' : domestic?.ok ? '国内正常' : '国内异常';
    const markup =
      '<div class="strip-resources" title="点击 CPU / 内存查看进程，点击硬盘释放空间">' + metric('CPU', cpuPct) + gpuMetric + metric('内存', memoryPct) + diskMetric + '</div>' +
      `<div class="strip-network"><button type="button" class="strip-route-row strip-route-foreign strip-proxy" title="${escapeHtml(foreignTitle)}"${ackAttr}><span class="strip-route-dot ${routeClass(displayRoute, proxyShort ? alert : null)}"></span><span>${routeLabel}</span><span class="strip-location">${escapeHtml(location)}</span>${clashDelay ? `<span class="strip-delay">节点 ${clashDelay.delayMs} ms</span>` : ''}</button>` +
      transfer + (showDomesticRoute() ? `<span class="strip-route-row strip-route-domestic" title="${escapeHtml(domesticTitle)}"><span class="strip-route-dot ${routeClass(domestic)}"></span>${domesticLabel}</span>` : '') + '</div>';
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
  const shortcut = event.target?.closest?.('[data-sub-id]');
  if (shortcut && (event.key === 'Enter' || event.key === ' ')) {
    event.preventDefault(); event.stopPropagation();
    activateNavigationIntent(navigationIntentFromTarget(shortcut));
    return;
  }
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
    .filter(s => !s.meetingId && !memberIds.has(s.id) && s.kind !== 'xresearch-run' && !s.hiddenFromSidebar && s.purpose !== 'xresearch-research'
      // 关掉助理的发行版（公司版）：旧版本留下的助理会话不再出现在侧栏（它跑不起来，只会显示运行异常）。
      && !(s.purpose === 'hub-assistant' && !require('../core/distribution').featureEnabled('assistant')));

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
    return collectSidebarItems(sessionMap).filter(item => item.purpose !== RESIDENT_PURPOSE && sideFilterPasses(item) && projectFilter.matches(item) && (modelFilter === 'all' || sessionFamilies(item, sessionMap).has(modelFilter)));
  }
  // 常驻的助理会话：同用途里最近活动的那个。
  function residentAssistant(sessionMap = getSessions()) {
    const list = collectSidebarItems(sessionMap).filter(item => item.purpose === RESIDENT_PURPOSE);
    return list.sort((a, b) => latestActivityTime(b) - latestActivityTime(a))[0] || null;
  }
  function revealSearchItem(id, memberId = null) {
    const item = collectSidebarItems().find(entry => entry.id === id);
    if (!item) return;
    if (tezhanMode && isTezhanSession(item) !== tezhanOnly) {
      // 只为这次定位切过去，不存：否则刷新后自己的会话整片消失（2026-10-17 审核）。
      tezhanOnly = isTezhanSession(item); syncWirelessControl();
    } else if (!tezhanMode && isWirelessSession(item) && !showWireless) {
      showWireless = true;
      savePreference('hubSidebarShowWireless', 'true'); syncWirelessControl();
    }
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
  if (tezhanMode && wirelessControl) {
    // 藏起来的特战会话里有出错或未读的：按钮上标个数，点亮就能看到（2026-10-17 审核）。
    const hidden = tezhanOnly ? [] : collectSidebarItems(sessionMap).filter(isTezhanSession);
    const failed = hidden.length ? new Set(partitionSidebarSessions(hidden, { now: renderNow, classify, sessionMap }).failed.map(x => x.id)) : new Set();
    const attention = hidden.filter(x => failed.has(x.id) || sidebarItemHasUnread(x, sessionMap)).length;
    const label = attention ? `特战 ${attention}` : '特战';
    if (wirelessControl.textContent !== label) wirelessControl.textContent = label;
    wirelessControl.dataset.attention = attention ? (failed.size ? 'failed' : 'unread') : '';
  }
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
      const meeting = s._meeting;
      const memberIds = meeting.subSessions || [];
      const isActive = getActiveMeetingId() === s.id;
      const isDormant = s.status === 'dormant';
      const unreadMembers = getMeetingUnreadMemberIds(meeting, sessionMap);
      const hasUnread = sidebarItemHasUnread(s, sessionMap);
      const runtime = _meetingRuntimeAggregate(meeting, sessionMap);
      const dotCls = sections.states.get(s.id) || 'idle';
      const group = doc.createElement('div');
      // All rooms keep the same parent row and visible, indented member rows.
      // Unread/runtime/detail preferences change indicators, never the layout.
      group.className = 'sidebar-group'
        + (memberIds.includes(getActiveSessionId()) ? ' has-active-member' : '');
      group.dataset.sidebarGroup = s.id;
      group.dataset.sidebarRenderKey = 'group:' + s.id;
      group.dataset.sidebarRenderTree = 'true';
      target.appendChild(group);
      const div = doc.createElement('div');
      div.className = 'session-item slim meeting gc'
        + (runtime.failed ? ' runtime-error' : '')
        + (runtime.running ? ' running' : '')
        + (isActive ? ' selected' : '')
        + (isDormant ? ' dormant' : '')
        + (hasUnread ? ' need-unread' : '');
      div.dataset.meetingId = s.id;
      div.dataset.sidebarRenderKey = 'meeting:' + s.id;
      div.dataset.state = dotCls;
      div.tabIndex = 0;
      const warning = memberIds.map(id => {
        const member = sessionMap.get(id);
        const text = _sessionWarningText(member);
        return text ? `${member?.title || member?.kind || '成员'}：${text}` : '';
      }).filter(Boolean).join('；');
      const selected = Array.isArray(meeting.participants) ? meeting.participants.length : memberIds.length;
      div.setAttribute('aria-label', [s.title, isDormant ? '休眠中' : '',
        `${selected}/${memberIds.length} 已选`, warning, `${unreadMembers.size} 位未读`].filter(Boolean).join(' · '));
      const logos = memberIds.slice(0, 2).map(id => {
        const member = sessionMap.get(id);
        if (!member) return '';
        let state = partitionSidebarSessions([member], { sessionMap, groupMemberIds: new Set([id]) }).states.get(id) || 'idle';
        if (getSessionRuntimeTruth(member).state === RUNTIME_DORMANT && !member._resumePending && state !== 'error') state = 'dorm';
        return _sessionKindHtml(member.kind, member.currentModel ? modelShort(member.currentModel) : '', state, '', require('../core/codeagent-models').iconModelId(member), id);
      }).join('');
      div.innerHTML = '<div class="sl-line1">'
        + '<span class="sl-group-logos" data-state="' + dotCls + '" aria-label="群聊 · ' + STATUS_LABELS[dotCls] + '">'
        + (logos || `<svg class="sl-kind sl-group-icon" data-state="${dotCls}" role="img" aria-label="群聊" viewBox="0 0 24 24"><path d="M9 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM3 20v-2a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v2M16 5a3 3 0 0 1 0 6m1 3a4 4 0 0 1 4 4v2"/></svg>`) + '</span>'
        + '<span class="sl-title">' + _warningHtml(warning) + escapeHtml(s.title)
        + (meeting.orchestration?.enabled === true ? '<span class="sl-orch-tag" title="负责人模式：用户只和负责人对话">负责人</span>' : '') + '</span>'
        + timeHtml(s, hasUnread ? Math.max(1, unreadMembers.size) : 0) + '</div>';
      div.addEventListener('contextmenu', event => {
        event.preventDefault();
        openContextMenu(s.id, event.clientX, event.clientY);
      });
      group.appendChild(div);
      const children = doc.createElement('div');
      children.className = 'sidebar-group-children';
      children.dataset.sidebarRenderKey = 'members:' + s.id;
      children.dataset.sidebarRenderTree = 'true';
      group.appendChild(children);
      for (const id of memberIds) {
        const member = sessionMap.get(id);
        if (member && (modelFilter === 'all' || familyOfKind(member.kind) === modelFilter)) appendItem(member, true, children);
      }
      return;
    }

    // Compact rows: stateful provider logo, title, and abbreviated activity time.
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
      ? `${['idle-timeout', 'company-bridge-idle'].includes(s.suspendReason) ? '自动休眠' : '休眠中'}${showUnread ? `，有 ${unreadCount} 条未读` : ''}，点击唤醒`
      : '';
    const displayTitle = sessionDisplayTitle(s, KIND_LABELS, getMeetings()[s.meetingId]);
    const account = accountBadge(s);
    const accessibleSummary = [displayTitle,
      account ? account.title : '',
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
    // CodeAgent 会话：标题前一个账号字母（2026-10-20 用户：不再用「池」区分号池，个人号和号池号统一显示工号首字母），
    // 放在标题格里不占列，悬停看代称（个人账号 / 号池 · 号 N）。拿不到字母时不显示。
    const accountHtml = account ? `<span class="sl-acct" title="${escapeHtml(account.title)}">${escapeHtml(account.letter)}</span>` : '';
    // 家里 ⇄ 公司通道：回合状态（已答 / 没答上 / N 轮 / 处理中）不进会话栏（2026-10-20 用户：会话栏要尽可能干净），
    // 挪到会话头部（renderer.js paintCrumbBridge）；会话栏只留「重启打断」这类要用户动手的异常。详细信息模式的第二行照旧。
    const bridge = bridgeBadge(s.id);
    const bridgeHtml = bridge && bridge.role === 'restart' ? `<span class="bt-badge" data-state="${escapeHtml(bridge.state)}" data-role="${escapeHtml(bridge.role || '')}" title="${escapeHtml(bridge.sub)}">${escapeHtml(bridge.chip)}</span>` : '';
    div.innerHTML = _sessionKindHtml(s.kind, modelTxt, isDormant && !isResumePending && !issue ? 'dorm' : dotCls, dormantStateTip || runtimeTruthSummary(runtimeTruth), require('../core/codeagent-models').iconModelId(s))
      + '<span class="sl-title">' + _warningHtml(anyWarning) + accountHtml + bridgeHtml + escapeHtml(displayTitle) + '</span>'
      + timeHtml(s, showUnread ? Math.max(1, unreadCount) : 0);
    if (child) div.className += ' child';
    if (detailsEnabled) {
      div.className += ' has-details';
      div.innerHTML = '<div class="sl-line1">' + div.innerHTML + '</div>'
        + detailsHtml(s, { escapeHtml, modelShort })
        + (bridge ? `<div class="bt-badge-sub" data-state="${escapeHtml(bridge.state)}">⇄ ${escapeHtml(bridge.sub)}${bridge.pin ? ' · ' + escapeHtml(bridge.pin) : ''}</div>` : '');
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
  // 「助理」一栏：常驻最上面，不受筛选影响；会话还没打开时放一行「点击打开」。
  if (companyAssistantOn()) {
    const resident = residentAssistant(sessionMap);
    const h = doc.createElement('div');
    h.className = 'session-sec-header sec-resident';
    h.dataset.sidebarRenderKey = 'section:sec-resident';
    h.innerHTML = '<span>助理</span><span class="sec-rule"></span>';
    renderTarget.appendChild(h);
    if (resident) appendItem(resident);
    else {
      const row = doc.createElement('div');
      row.className = 'session-item slim resident-placeholder';
      row.dataset.sidebarRenderKey = 'resident-placeholder';
      row.tabIndex = 0;
      row.innerHTML = '<span class="sl-title">公司助理</span><span class="sl-time">点击打开</span>';
      row.title = '打开公司助理的 CodeAgent 会话（没开着就恢复或新开一个）';
      row.addEventListener('click', () => { void doc.defaultView?.__companyAssistantOpenSession?.(); });
      renderTarget.appendChild(row);
    }
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
  isWirelessSession,
  isTezhanSession,
  createSessionListRenderer,
  showDomesticRoute,
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
