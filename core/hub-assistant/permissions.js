'use strict';

// Hub grants management tools to one persisted assistant entity. Neither the
// model's tool arguments nor a purpose label can designate another assistant.
function isAssistantSession(store, sessionId, session) {
  return !!sessionId && sessionId === store.get('sessionId') &&
    session?.id === sessionId && session.purpose === 'hub-assistant';
}

function requireManagerCaller(store, current, callerSessionId, session) {
  if (!isAssistantSession(store, callerSessionId, session) ||
      current?.sessionId !== callerSessionId) {
    throw new Error('调用方不是本轮绑定的固定助理会话，未授予会话管理权限');
  }
  return true;
}

module.exports = { isAssistantSession, requireManagerCaller };
