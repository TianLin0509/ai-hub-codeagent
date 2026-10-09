'use strict';

const {
  ATTENTION_REPLY_READY,
  attentionStateOf,
} = require('../core/session-attention-state.js');
const {
  RUNTIME_COMPLETED,
  getSessionRuntimeTruth,
} = require('../core/session-runtime-truth.js');

function isDesktopNotificationReady(session) {
  if (!session || typeof session !== 'object' || !session.id) return false;
  if (session.meetingId || session.hiddenFromSidebar || session.purpose === 'xresearch-research') return false;
  if (String(session.status || '').toLowerCase() === 'dormant') return false;
  if (attentionStateOf(session) !== ATTENTION_REPLY_READY) return false;
  if (Math.max(0, Number(session.unreadCount) || 0) < 1) return false;
  return getSessionRuntimeTruth(session).state === RUNTIME_COMPLETED;
}

function notificationTime(session) {
  if (require('../core/native-agent-runtime').isNativeAgent(session)) return Number(session.nativeRuntime?.completedAt) || 0;
  return Math.max(
    Number(session && session.lastCompletedAt) || 0,
    Number(session && session.lastMessageTime) || 0,
    Number(session && session.createdAt) || 0,
  );
}

function notificationPayload(session, readyCount, newCount) {
  const body = String(
    session.replyReadyText
    || session.lastOutputPreview
    || '本轮回答已经完成，点击回到会话查看。',
  ).trim().slice(0, 240);
  return {
    sessionId: String(session.id),
    title: String(session.title || 'AI 会话').trim().slice(0, 100),
    body,
    kind: String(session.kind || '').replace(/-resume$/i, '').slice(0, 32),
    completedAt: notificationTime(session) || Date.now(),
    readyCount: Math.max(1, Number(readyCount) || 1),
    newCount: Math.max(1, Number(newCount) || 1),
  };
}

function createSessionReadyNotifier({ ipcRenderer, getSessions } = {}) {
  if (!ipcRenderer || typeof ipcRenderer.send !== 'function') throw new Error('ipcRenderer.send is required');
  if (typeof getSessions !== 'function') throw new Error('getSessions is required');
  let armed = false;
  const notifiedNativeTurns = new Set();
  const nativeKey = session => require('../core/native-agent-runtime').isNativeAgent(session)
    ? JSON.stringify([session.id,session.nativeRuntime?.threadId || session.nativeRuntime?.providerSessionId,session.nativeRuntime?.turnId]) : null;
  const rememberNative = session => {
    const key=nativeKey(session);if(key)notifiedNativeTurns.add(key);
    while(notifiedNativeTurns.size>2048)notifiedNativeTurns.delete(notifiedNativeTurns.values().next().value);
  };
  let eligibleIds = new Set();
  let notificationCount = 0;
  let lastPayload = null;

  function eligibleSessions() {
    const source = getSessions();
    const values = source && typeof source.values === 'function'
      ? Array.from(source.values())
      : Array.from(source || []);
    return values.filter(isDesktopNotificationReady).sort((a, b) => notificationTime(a) - notificationTime(b));
  }

  function prime() {
    const eligible = eligibleSessions();
    eligibleIds = new Set(eligible.map(session => String(session.id)));
    eligible.forEach(rememberNative);
    armed = true;
    return { armed, readyCount: eligible.length, notified: false };
  }

  function scan() {
    if (!armed) return { armed: false, readyCount: 0, notified: false };
    const eligible = eligibleSessions();
    const nextIds = new Set(eligible.map(session => String(session.id)));
    const entered = eligible.filter(session => nativeKey(session)
      ? !notifiedNativeTurns.has(nativeKey(session)) : !eligibleIds.has(String(session.id)));
    entered.forEach(rememberNative);
    eligibleIds = nextIds;
    if (entered.length === 0) return { armed, readyCount: eligible.length, notified: false };

    const latest = entered[entered.length - 1];
    const payload = notificationPayload(latest, eligible.length, entered.length);
    ipcRenderer.send('desktop-notification:show', payload);
    notificationCount += 1;
    lastPayload = payload;
    return { armed, readyCount: eligible.length, newCount: entered.length, notified: true, payload };
  }

  return {
    getState: () => ({
      armed,
      eligibleIds: Array.from(eligibleIds),
      notificationCount,
      lastPayload: lastPayload ? { ...lastPayload } : null,
    }),
    prime,
    scan,
  };
}

module.exports = {
  createSessionReadyNotifier,
  isDesktopNotificationReady,
  notificationPayload,
  notificationTime,
};
