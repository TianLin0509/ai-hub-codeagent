'use strict';

const path = require('path');
const { isGroupChatMemberRunning } = require('../core/groupchat-running-state.js');
const { supportsForkSession } = require('../core/session-capabilities.js');
const {
  sessionHasCompletedUnread,
  sessionNeedsUserInput,
} = require('../core/session-attention-state.js');
const {
  RUNTIME_FAILED,
  RUNTIME_DORMANT,
  getSessionRuntimeTruth,
  sessionRuntimeIsActive,
} = require('../core/session-runtime-truth.js');
const { collectPathCandidates } = require('./path-candidates.js');
const {
  beijingEpoch,
  beijingParts,
  formatBeijingDateTime,
} = require('../core/beijing-time.js');

const RECENT_WINDOW_MS = 24 * 60 * 60 * 1000;
const LONG_TASK_MS = 10 * 60 * 1000;
const STALLED_TASK_MS = 15 * 60 * 1000;
const STALE_OUTPUT_MS = 5 * 60 * 1000;
const CONTEXT_WARNING_PCT = 70;
const CONTEXT_CRITICAL_PCT = 90;
const MAX_INSIGHT_ITEMS = 6;
const MAX_ARTIFACT_ITEMS = 6;

const PROVIDER_LABELS = {
  claude: 'CLAUDE',
  codex: 'CODEX',
  gemini: 'GEMINI',
  deepseek: 'DEEPSEEK',
  kimi: 'KIMI',
  powershell: 'SHELL',
  group: '群聊',
};

function finiteNumber(value) {
  if (value == null || value === '' || typeof value === 'boolean') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function baseKind(kind) {
  const value = String(kind || '').replace(/-(?:resume|api)$/i, '').toLowerCase();
  return Object.prototype.hasOwnProperty.call(PROVIDER_LABELS, value) ? value : 'group';
}

function numberFromUnreadAnswered(value) {
  if (value instanceof Set) return value.size;
  if (Array.isArray(value)) return value.length;
  if (Number.isFinite(value)) return Math.max(0, Number(value));
  return 0;
}

function itemTime(item) {
  return Number(item.lastMessageTime || item.updatedAt || item.createdAt || 0);
}

function runStartedAtOf(session, now = Date.now()) {
  const runtime = getSessionRuntimeTruth(session, { now });
  if (require('../core/native-agent-runtime').isNativeAgent(session)) return finiteNumber(runtime.startedAt) || 0;
  return finiteNumber(runtime.startedAt || session && (session.runStartedAt || session.cardWorkingSince)) || 0;
}

function makeSessionItem(session, now = Date.now()) {
  const unreadCount = Math.max(0, Number(session.unreadCount || 0));
  const kind = baseKind(session.kind);
  const runtime = getSessionRuntimeTruth(session, { now });
  const running = sessionRuntimeIsActive(session, { now }) || isGroupChatMemberRunning(session, now);
  const runStartedAt = running ? runStartedAtOf(session, now) : 0;
  const lastActivityAt = Math.max(itemTime(session), finiteNumber(session._lastOutputTs) || 0);
  const elapsedMs = running && runStartedAt > 0 ? Math.max(0, now - runStartedAt) : null;
  const contextPct = finiteNumber(session.contextPct);
  return {
    id: String(session.id || session.hubId || ''),
    type: 'session',
    title: String(session.title || PROVIDER_LABELS[kind] || 'Session'),
    kind,
    providerLabel: PROVIDER_LABELS[kind] || 'AI',
    preview: String(session.waitingText || session.replyReadyText || session.lastOutputPreview || session.workspaceLabel || session.cwd || ''),
    cwd: typeof session.cwd === 'string' ? session.cwd : '',
    lastMessageTime: itemTime(session),
    lastActivityAt,
    lastCompletedAt: finiteNumber(session.lastCompletedAt) || 0,
    lastRunDurationMs: finiteNumber(session.lastRunDurationMs),
    runStartedAt,
    elapsedMs,
    longRunning: elapsedMs != null && elapsedMs >= LONG_TASK_MS,
    status: runtime.state,
    runtimeSource: runtime.source || '',
    runtimeConfidence: runtime.confidence || '',
    errorText: String(runtime.state === RUNTIME_FAILED && runtime.evidence
      ? runtime.evidence
      : session.lastError || session.error || session.spawnError || ''),
    running,
    waiting: runtime.state === 'waiting' || sessionNeedsUserInput(session),
    completedUnread: sessionHasCompletedUnread(session),
    unreadCount,
    contextPct,
    supportsFork: supportsForkSession(session),
    dormant: runtime.state === RUNTIME_DORMANT,
  };
}

function makeMeetingItem(meeting, sessionMap, now = Date.now()) {
  const childIds = Array.isArray(meeting.subSessions) ? meeting.subSessions : [];
  const activeChildren = childIds
    .map(id => sessionMap.get(id))
    .filter(child => child && getSessionRuntimeTruth(child, { now }).state !== RUNTIME_DORMANT);
  const childTruths = activeChildren.map(child => ({ child, truth: getSessionRuntimeTruth(child, { now }) }));
  const waiting = childTruths.some(item => item.truth.state === 'waiting');
  const failedChild = childTruths.find(item => item.truth.state === RUNTIME_FAILED) || null;
  const running = (!meeting.groupChat && meeting.status === 'running')
    || activeChildren.some(child => isGroupChatMemberRunning(child));
  const answered = numberFromUnreadAnswered(meeting.unreadAnswered);
  const unreadCount = Math.max(answered, Number(meeting.unreadCount || 0));
  const runStarts = activeChildren
    .filter(child => isGroupChatMemberRunning(child))
    .map(runStartedAtOf)
    .filter(Boolean);
  const runStartedAt = finiteNumber(meeting.runStartedAt)
    || (runStarts.length ? Math.min(...runStarts) : 0);
  const elapsedMs = running && runStartedAt > 0 ? Math.max(0, now - runStartedAt) : null;
  return {
    id: String(meeting.id || ''),
    type: 'meeting',
    title: String(meeting.title || 'AI 群聊'),
    kind: 'group',
    providerLabel: '群聊',
    preview: String(meeting.lastOutputPreview || `${childIds.length} 位 AI 成员`),
    lastMessageTime: itemTime(meeting),
    lastActivityAt: Math.max(itemTime(meeting), ...activeChildren.map(itemTime), 0),
    lastCompletedAt: finiteNumber(meeting.lastCompletedAt) || 0,
    lastRunDurationMs: finiteNumber(meeting.lastRunDurationMs),
    runStartedAt,
    elapsedMs,
    longRunning: elapsedMs != null && elapsedMs >= LONG_TASK_MS,
    status: waiting ? 'waiting' : running ? 'running' : failedChild ? RUNTIME_FAILED : (meeting.status || 'idle'),
    errorText: String(failedChild && failedChild.truth.evidence
      || meeting.lastError || meeting.error || ''),
    running,
    waiting,
    completedUnread: unreadCount > 0,
    unreadCount,
    contextPct: null,
    supportsFork: false,
    dormant: meeting.status === 'dormant',
  };
}

function buildNightWindow(now = Date.now()) {
  const current = beijingParts(now);
  const hour = current.hour;
  let start;
  let end = now;
  let label;

  if (hour >= 20) {
    start = beijingEpoch({ ...current, hour: 20, minute: 0, second: 0, millisecond: 0 });
    label = '今晚 20:00 至现在';
  } else {
    start = beijingEpoch({ ...current, day: current.day - 1, hour: 20, minute: 0, second: 0, millisecond: 0 });
    if (hour < 8) {
      label = '昨晚 20:00 至现在';
    } else {
      end = beijingEpoch({ ...current, hour: 8, minute: 0, second: 0, millisecond: 0 });
      label = '昨晚 20:00 至今早 08:00';
    }
  }

  return {
    start,
    end,
    label,
  };
}

function buildNightSummary(items, now = Date.now()) {
  const window = buildNightWindow(now);
  const inWindow = timestamp => timestamp >= window.start && timestamp <= window.end;
  const failedStatus = item => /^(?:error|failed|crashed|exited)$/i.test(item.status);
  const completedItems = items
    // A completed session may already have been auto-suspended by morning.
    // Dormancy is a resource state, not evidence that its overnight result
    // should disappear from the digest.
    .filter(item => !item.running && !item.waiting && !failedStatus(item))
    .map(item => ({
      ...item,
      completionAt: item.lastCompletedAt || (item.completedUnread ? item.lastMessageTime : 0),
    }))
    .filter(item => item.completionAt > 0 && inWindow(item.completionAt))
    .sort((a, b) => b.completionAt - a.completionAt);
  const failedItems = items.filter(item => failedStatus(item) && inWindow(item.lastMessageTime));
  const waitingItems = items.filter(item => item.waiting && inWindow(item.lastMessageTime));
  return {
    ...window,
    completed: completedItems.length,
    failed: failedItems.length,
    waiting: waitingItems.length,
    totalDurationMs: completedItems.reduce((total, item) => total + Math.max(0, item.lastRunDurationMs || 0), 0),
    items: completedItems.slice(0, 4),
  };
}

function deriveRecentArtifacts(sessionMap, options = {}) {
  const now = finiteNumber(options.now) || Date.now();
  const pathExists = typeof options.pathExists === 'function' ? options.pathExists : () => true;
  const candidates = [];
  const sessions = Array.from(sessionMap.values())
    // Keep recent outputs visible after automatic session suspension.
    .filter(session => session && session.purpose !== 'xresearch-research')
    .sort((a, b) => itemTime(b) - itemTime(a))
    .slice(0, 30);

  for (const session of sessions) {
    const sessionId = String(session.id || session.hubId || '');
    const kind = baseKind(session.kind);
    const stored = Array.isArray(session.recentArtifacts) ? session.recentArtifacts : [];
    for (const artifact of stored.slice(-8)) {
      if (!artifact || typeof artifact.path !== 'string') continue;
      candidates.push({
        path: artifact.path,
        timestamp: finiteNumber(artifact.timestamp || artifact.ts) || itemTime(session) || now,
        sessionId,
        sessionTitle: String(session.title || PROVIDER_LABELS[kind] || 'Session'),
        kind,
      });
    }

    // Backward-compatible seed for sessions created before recentArtifacts was
    // persisted. Only inspect short sidebar previews; never scan transcripts.
    const preview = String(session.replyReadyText || session.lastOutputPreview || '');
    for (const match of collectPathCandidates(preview, session.cwd || null, { includeDirectories: false })) {
      if (match.isUrl) continue;
      candidates.push({
        path: match.openPath,
        timestamp: finiteNumber(session.lastCompletedAt) || itemTime(session) || now,
        sessionId,
        sessionTitle: String(session.title || PROVIDER_LABELS[kind] || 'Session'),
        kind,
      });
    }
  }

  const seen = new Set();
  return candidates
    .sort((a, b) => b.timestamp - a.timestamp)
    // Runtime defers existence validation to the asynchronous open action.
    // Tests may inject pathExists, but Home never statSyncs a stale network
    // path during render (a previous source of visible UI stalls).
    .slice(0, 24)
    .filter(artifact => {
      if (!artifact.path || !path.extname(artifact.path)) return false;
      let key;
      try { key = path.resolve(artifact.path).toLowerCase(); } catch { key = artifact.path.toLowerCase(); }
      if (seen.has(key) || !pathExists(artifact.path)) return false;
      seen.add(key);
      artifact.name = path.basename(artifact.path);
      return true;
    })
    .slice(0, MAX_ARTIFACT_ITEMS);
}

function buildExceptions(items, options = {}) {
  const now = finiteNumber(options.now) || Date.now();
  const resourceUsage = options.resourceUsage || {};
  const hubConfig = options.hubConfig || {};
  const usageSnapshot = options.usageSnapshot || {};
  const refreshError = String(options.refreshError || '');
  const exceptions = [];
  const seen = new Set();
  const add = (entry) => {
    if (!entry || !entry.id || seen.has(entry.id)) return;
    seen.add(entry.id);
    exceptions.push(entry);
  };

  for (const item of items) {
    if (item.dormant) continue;
    if (/^(?:error|failed|crashed|exited)$/i.test(item.status) || item.errorText) {
      add({
        id: `session-error:${item.id}`,
        severity: 'critical',
        title: `${item.title} 执行异常`,
        detail: item.errorText || `状态：${item.status}`,
        type: item.type,
        targetId: item.id,
        timestamp: item.lastMessageTime,
      });
      continue;
    }
    if (item.running && item.elapsedMs >= STALLED_TASK_MS
        && now - item.lastActivityAt >= STALE_OUTPUT_MS) {
      add({
        id: `session-stalled:${item.id}`,
        severity: 'warning',
        title: `${item.title} 可能卡住`,
        detail: `已运行 ${formatDurationShort(item.elapsedMs)}，${formatDurationShort(now - item.lastActivityAt)}没有新输出`,
        type: item.type,
        targetId: item.id,
        timestamp: item.lastActivityAt,
      });
    }
    if (item.contextPct != null && item.contextPct >= CONTEXT_CRITICAL_PCT) {
      add({
        id: `session-context:${item.id}`,
        severity: 'warning',
        title: `${item.title} 上下文临界`,
        detail: `已使用 ${Math.round(item.contextPct)}%，建议复制近 3 轮后开分支`,
        type: item.type,
        targetId: item.id,
        timestamp: item.lastMessageTime,
      });
    }
  }

  const egressAlert = hubConfig.egress && hubConfig.egress.alert;
  if (egressAlert) {
    add({
      id: `system-egress:${egressAlert.type || 'alert'}`,
      severity: egressAlert.severity === 'critical' ? 'critical' : 'warning',
      title: egressAlert.title || '网络出口异常',
      detail: egressAlert.message || '请检查当前代理出口',
      type: 'system',
      action: 'refresh',
      timestamp: finiteNumber(hubConfig.egress.checkedAt) || now,
    });
  }

  const cpu = finiteNumber(resourceUsage.cpuPct);
  const memory = finiteNumber(resourceUsage.memoryPct);
  if ((cpu != null && cpu >= 90) || (memory != null && memory >= 90)) {
    add({
      id: 'system-resource-pressure',
      severity: 'warning',
      title: '本机负载过高',
      detail: `CPU ${cpu == null ? '--' : `${Math.round(cpu)}%`} · 内存 ${memory == null ? '--' : `${Math.round(memory)}%`}`,
      type: 'system',
      action: 'refresh',
      timestamp: now,
    });
  }

  for (const provider of ['claude', 'codex', 'kimi']) {
    const pct = finiteNumber(usageSnapshot[provider] && usageSnapshot[provider].usage5h && usageSnapshot[provider].usage5h.pct);
    if (pct != null && pct >= 95) {
      add({
        id: `quota:${provider}`,
        severity: 'warning',
        title: `${PROVIDER_LABELS[provider]} 5h 配额接近耗尽`,
        detail: `当前已使用 ${Math.round(pct)}%`,
        type: 'system',
        action: 'refresh',
        timestamp: now,
      });
    }
  }

  const deepseek = usageSnapshot.deepseek;
  const deepseekBalance = finiteNumber(deepseek && deepseek.totalBalance);
  if (hubConfig.deepseekApiKeySet === true && deepseek && deepseek.available === false) {
    add({
      id: 'quota:deepseek-unavailable',
      severity: 'critical',
      title: 'DEEPSEEK API 余额不可用',
      detail: '官方余额接口返回账号不可用',
      type: 'system',
      action: 'refresh',
      timestamp: finiteNumber(deepseek.observedAt) || now,
    });
  } else if (deepseekBalance != null && deepseekBalance < 10) {
    add({
      id: 'quota:deepseek-low',
      severity: 'warning',
      title: 'DEEPSEEK 余额偏低',
      detail: `当前余额 ¥${deepseekBalance.toFixed(2)}`,
      type: 'system',
      action: 'refresh',
      timestamp: finiteNumber(deepseek.observedAt) || now,
    });
  }

  const lastDelivery = hubConfig.notificationHealth && hubConfig.notificationHealth.lastDelivery;
  const deliveryAt = finiteNumber(lastDelivery && lastDelivery.timestamp);
  const notificationAuditReadError = hubConfig.notificationHealth && hubConfig.notificationHealth.auditReadError;
  const notificationAuditWriteError = hubConfig.notificationHealth && hubConfig.notificationHealth.auditWriteError;
  const notificationAuditError = notificationAuditWriteError || notificationAuditReadError;
  if (notificationAuditError) {
    add({
      id: notificationAuditWriteError ? 'notification:audit-write-failed' : 'notification:audit-read-failed',
      severity: 'warning',
      title: notificationAuditWriteError ? '飞书通知审计写入失败' : '飞书通知审计不可读',
      detail: `错误：${notificationAuditError} · 重启后的持久去重保护已降级`,
      type: 'system',
      action: 'refresh',
      timestamp: now,
    });
  }
  if (lastDelivery && lastDelivery.status === 'failed' && deliveryAt && now - deliveryAt <= RECENT_WINDOW_MS) {
    add({
      id: 'notification:last-failed',
      severity: 'warning',
      title: '飞书通知最近发送失败',
      detail: `错误：${lastDelivery.errorCode || 'unknown_error'} · 可点击刷新后重试任务`,
      type: 'system',
      action: 'refresh',
      timestamp: deliveryAt,
    });
  }

  if (refreshError) {
    add({
      id: 'system:refresh-failed',
      severity: 'warning',
      title: '工作台部分状态刷新失败',
      detail: refreshError,
      type: 'system',
      action: 'refresh',
      timestamp: now,
    });
  }

  const severityRank = { critical: 0, warning: 1, info: 2 };
  return exceptions
    .sort((a, b) => (severityRank[a.severity] ?? 9) - (severityRank[b.severity] ?? 9) || b.timestamp - a.timestamp)
    .slice(0, MAX_INSIGHT_ITEMS);
}

function buildHomeSnapshot(options = {}) {
  const sessionMap = options.sessions instanceof Map ? options.sessions : new Map();
  const meetings = options.meetings && typeof options.meetings === 'object' ? options.meetings : {};
  const now = Number(options.now || Date.now());

  const regularItems = Array.from(sessionMap.values())
    .filter(session => session
      && !session.meetingId
      && !session.hiddenFromSidebar
      && session.kind !== 'xresearch-run'
      // 投研任务席位（xresearch-research）是在投研 Tab 自己的终端里驱动的，不进侧边栏。
      // 作手林铛的每日决策会话不一样：它就是一次完整的对话，用户要在侧边栏点开接着追问。
      && session.purpose !== 'xresearch-research')
    .map(session => makeSessionItem(session, now));
  const meetingItems = Object.values(meetings)
    .filter(Boolean)
    .map(meeting => makeMeetingItem(meeting, sessionMap, now));
  const items = regularItems.concat(meetingItems)
    .filter(item => item.id)
    .sort((a, b) => b.lastMessageTime - a.lastMessageTime);

  const waiting = items.filter(item => item.waiting && !item.dormant);
  const running = items.filter(item => item.running && !item.waiting && !item.dormant);
  const delivered = items.filter((item) => {
    if (item.waiting || item.running || item.dormant) return false;
    return item.completedUnread || (item.lastMessageTime > 0 && now - item.lastMessageTime <= RECENT_WINDOW_MS);
  });
  const contextRisk = regularItems
    .filter(item => !item.dormant && item.contextPct != null && item.contextPct >= CONTEXT_WARNING_PCT)
    .sort((a, b) => b.contextPct - a.contextPct || b.lastMessageTime - a.lastMessageTime)
    .slice(0, MAX_INSIGHT_ITEMS);

  const allSessions = Array.from(sessionMap.values()).filter(Boolean);
  const providerActive = { claude: 0, codex: 0, gemini: 0, deepseek: 0, kimi: 0, powershell: 0 };
  for (const session of allSessions) {
    if (getSessionRuntimeTruth(session, { now }).state === RUNTIME_DORMANT) continue;
    const kind = baseKind(session.kind);
    if (Object.prototype.hasOwnProperty.call(providerActive, kind)) providerActive[kind] += 1;
  }

  const exceptions = buildExceptions(items, {
    now,
    resourceUsage: options.resourceUsage,
    hubConfig: options.hubConfig,
    usageSnapshot: options.usageSnapshot,
    refreshError: options.refreshError,
  });
  const artifacts = deriveRecentArtifacts(sessionMap, {
    now,
    pathExists: options.pathExists,
  });
  const night = buildNightSummary(items, now);

  // 「今天该续哪个」：休眠会话有 674 个，给一个数字等于没给。这里挑真正值得
  // 回去的——有未读回复的排最前，其次是最近还动过的；只留 4 条。
  const resumeCandidates = items
    .filter(item => item.dormant && item.lastMessageTime > 0)
    .map(item => ({
      ...item,
      resumeScore: (item.unreadCount > 0 ? 1e15 : 0) + item.lastMessageTime,
    }))
    .sort((a, b) => b.resumeScore - a.resumeScore)
    .slice(0, 4);

  return {
    generatedAt: now,
    items,
    lanes: { waiting, running, delivered },
    contextRisk,
    resumeCandidates,
    exceptions,
    artifacts,
    night,
    metrics: {
      active: allSessions.filter(session => session.status !== 'dormant').length,
      waiting: waiting.length,
      unread: items.filter(item => item.unreadCount > 0).length,
      dormant: items.filter(item => item.dormant).length,
    },
    providerActive,
  };
}

function formatDurationShort(ms) {
  const totalMinutes = Math.max(0, Math.round((Number(ms) || 0) / 60_000));
  if (totalMinutes < 1) return '不到 1 分钟';
  if (totalMinutes < 60) return `${totalMinutes} 分钟`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${hours} 小时${minutes ? ` ${minutes} 分钟` : ''}`;
}

// Snapshot helpers above remain available to runtime consumers. The welcome page
// does not build snapshots, read project files, scan Git, or start polling.
function createHomeWorkbench({ document: doc, onCreate } = {}) {
  const root = doc && doc.getElementById('empty-state');
  if (!root) throw new Error('Welcome page root missing');
  if (typeof onCreate !== 'function') throw new TypeError('Welcome page requires a creation handler');

  function isVisible() {
    return root.isConnected !== false && root.style.display !== 'none';
  }

  function render() {
    if (!isVisible()) return;
    // The same notification control is shared with the session header.
    const slot = doc.getElementById('home-notification-slot');
    const toggle = doc.getElementById('completion-notification-toggle');
    if (slot && toggle && toggle.parentElement !== slot) slot.appendChild(toggle);
    root.dataset.homeReady = 'true';
  }

  async function handleClick(event) {
    const button = event.target && event.target.closest && event.target.closest('[data-home-create]');
    if (!button || !root.contains(button) || button.disabled) return;
    const intent = button.dataset.homeCreate;
    if (intent !== 'session' && intent !== 'group') return;
    event.preventDefault();
    event.stopPropagation();
    const errorEl = doc.getElementById('home-welcome-error');
    if (errorEl) { errorEl.hidden = true; errorEl.textContent = ''; }
    try {
      // Let the launcher capture the focused trigger before disabling it;
      // otherwise closing the dialog cannot restore keyboard focus.
      const opening = onCreate(intent);
      button.disabled = true;
      await opening;
    } catch (error) {
      console.error('[home-welcome] creation failed:', error);
      if (errorEl) {
        errorEl.textContent = `创建面板打开失败：${error && error.message ? error.message : String(error)}`;
        errorEl.hidden = false;
      }
    } finally {
      button.disabled = false;
    }
  }

  root.addEventListener('click', handleClick);
  return { render, isVisible, dispose: () => root.removeEventListener('click', handleClick) };
}

module.exports = {
  CONTEXT_CRITICAL_PCT,
  CONTEXT_WARNING_PCT,
  LONG_TASK_MS,
  RECENT_WINDOW_MS,
  baseKind,
  buildHomeSnapshot,
  buildNightSummary,
  buildNightWindow,
  createHomeWorkbench,
  deriveRecentArtifacts,
  formatDurationShort,
};
