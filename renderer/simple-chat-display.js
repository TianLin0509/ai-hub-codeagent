'use strict';

const { displayTurns } = require('../core/conversation-display');

// Ordinary chat is a presentation of provider records, never a rewrite of the
// transcript, delivery evidence or runtime state. Steering user items and
// explicit response identities remain boundaries.
function sameReply(a, b) {
  return a?.role === 'assistant' && b?.role === 'assistant'
    && !!a.logicalTurnId && a.logicalTurnId === b.logicalTurnId
    && a.kind === b.kind && a.sessionId === b.sessionId
    && a.inherited === b.inherited;
}

function mergeReply(group) {
  const first = group[0];
  const finals = group.filter(m => ['final', 'final_answer'].includes(m.phase) && m.text);
  const body = group.filter(m => m.text &&
    (m.displayVisibility === 'body' || ['final', 'final_answer'].includes(m.phase)));
  const progress = group.filter(m => m.phase === 'commentary' && m.text && !body.includes(m));
  const result = finals.at(-1) || group.findLast(m => m.phase !== 'activity') || first;
  const activity = group.findLast(m => m.phase === 'activity');
  const owner = group.findLast(m => m.deliveryContext) || result;
  const tools = new Map();
  for (const m of group) for (const tool of m.toolCalls || []) {
    const key = tool.id || tool.toolCallId || tool.callId || tool;
    tools.set(key, tool);
  }
  return {
    ...first, ...result,
    // The same anchor survives a tools-only start, progress and the final reply.
    id: first.logicalTurnId,
    text: body.length ? body.map(m => m.text).join('\n\n') : result.text || '',
    phase: finals.length ? 'final_answer' : result.phase,
    simpleChat: true,
    chatProcessMessages: body.length ? progress : progress.filter(m => m !== result),
    deliveryContext: owner.deliveryContext,
    toolCalls: [...tools.values()],
    thinking: group.map(m => m.thinking).filter(Boolean).join('\n\n') || null,
    nativeOutcome: activity?.nativeOutcome || result.nativeOutcome,
    usage: result.usage || activity?.usage,
    durationMs: result.durationMs ?? activity?.durationMs,
    ts: first.ts,
    tsEnd: result.tsEnd || activity?.tsEnd,
  };
}

function displayChatTurns(turns) {
  const messages = displayTurns(turns);
  const result = [];
  const replySegments = new Set();
  for (let start = 0; start < messages.length;) {
    let end = start + 1;
    while (end < messages.length && sameReply(messages[start], messages[end])) end++;
    const group = messages.slice(start, end);
    if (group[0].role === 'assistant' && group[0].logicalTurnId) {
      const merged = mergeReply(group);
      if (replySegments.has(merged.id)) merged.id = `${merged.id}:chat:${group[0].id}`;
      replySegments.add(group[0].logicalTurnId);
      result.push(merged);
    } else result.push({ ...group[0], simpleChat: true });
    start = end;
  }
  return result;
}

module.exports = { displayChatTurns };
