'use strict';
// 手机 App 直接发给会话的话（App 2.1 session_send）在电脑卡片上标「手机」。
// 原生记录里看不出一句话是从哪来的，所以 Hub 记下手机每次确认送达的原文和时间，
// 渲染用户卡片时按「同一句话 + 时间对得上」认领；只做显示标记，不改记录、不影响去重。
const MAX_PER_SESSION = 50;
const EARLY_MS = 2 * 60000;      // 记录时间可能略早于 Hub 收到回执的时间
const LATE_MS = 3 * 3600000;     // 排队的话最长 2 小时后才发出，留余量

const registry = new Map();

function identity(text) {
  return require('./conversation-display').userTextIdentity(String(text || ''));
}

function remember(sessionId, prompts) {
  if (!sessionId || !Array.isArray(prompts)) return false;
  const list = registry.get(sessionId) || [];
  let changed = false;
  for (const p of prompts) {
    const text = identity(p && p.text);
    const at = Number(p && p.at);
    if (!text || !Number.isFinite(at)) continue;
    if (list.some(x => x.text === text && x.at === at)) continue;
    list.push({ text, at });
    changed = true;
  }
  if (changed) registry.set(sessionId, list.sort((a, b) => a.at - b.at).slice(-MAX_PER_SESSION));
  return changed;
}

function promptsFor(sessionId) { return registry.get(sessionId) || []; }

function matchesPhonePrompt(turn, prompts) {
  if (!turn || turn.role !== 'user' || !Array.isArray(prompts) || !prompts.length) return false;
  const text = identity(turn.assistantContext?.userText ?? turn.text);
  if (!text) return false;
  const ts = Number(turn.ts);
  return prompts.some(p => p.text === text && (!Number.isFinite(ts) || (ts >= p.at - EARLY_MS && ts <= p.at + LATE_MS)));
}

function reset() { registry.clear(); }

module.exports = { remember, promptsFor, matchesPhonePrompt, reset };
