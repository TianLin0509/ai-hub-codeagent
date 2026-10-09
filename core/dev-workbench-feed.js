'use strict';
// Materialized at the group-chat write boundary. UPDATE is informational;
// PROGRESS / RESULT retain their existing final-handoff meanings.
//
// 2026-09-06 「人话通道」：维护者不看代码，他要的是三段人话 ——
//   开工前打算怎么做（PLAN）、干到哪了（UPDATE，可累积）、交付时的说明（NOTES），
//   外加一条「需要他拍板」的问题（ASK）。
// 这四个标签允许多行正文；原来的四行机器协议（PROGRESS/VERIFIED/RISK/REPORT 和
// RESULT/BLOCKERS/VERIFIED/NEXT）保持单行不变 —— 循环引擎靠它们判 PASS，
// 一旦让它们吃掉后续段落，「四行之外再写三五句展开」就会被算进字段里。
const listeners = new Set();
const EMPTY = /^(无|none|n\/a|-|—|null)$/i;
const TAG = /^\s{0,3}(UPDATE|PROGRESS|VERIFIED|RISK|REPORT|RESULT|BLOCKERS|NEXT|PLAN|ASK|NOTES)\s*[:：]\s*(.*)$/i;
// 允许带正文段落的标签。别往里加机器协议标签，理由见上。
const MULTILINE_TAGS = new Set(['PLAN', 'ASK', 'NOTES', 'UPDATE']);
// 纪事条数与单条长度的上限。这份摘要会随每次落盘写进 state 并推给渲染层，
// 不设上限的话，一个话多的 agent 能把它撑到几十兆；全文永远在群聊原文里。
const MAX_TIMELINE = 24;
const MAX_TIMELINE_TEXT = 1000;
// 老群聊可能攒了几千条消息。倒着扫，够用就停：纪事满员且两张终稿卡都拿到就收工，
// 再加一道硬上限兜底，免得每次落盘都把整部历史重新解析一遍。
const MAX_SCAN = 500;
// 实时通道认得的三个标签。agent 在一轮**中途**写下的人话只有走这条路才进得了群聊状态：
// 交付时的 PROGRESS / NOTES 由 completeTurn 落盘，而 PLAN 写在开工前、ASK 可能写在任何时候，
// 它们从来没有第二条路。2026-09-06 合并位实测：真实 Claude/Codex transcript 里
// 中途发出的 PLAN 和 ASK 全部丢失，工作台自然显示不出方案和待拍板的问题。
const LIVE_TAGS = ['PLAN', 'UPDATE', 'ASK'];
// 带这两个标签的消息是**最终交接**，走 completeTurn 落盘。实时通道必须整条跳过，
// 否则同一段话会既进过程汇报又进正式答复，纪事里出现两条一模一样的记录。
const FINAL_TAGS = ['PROGRESS', 'RESULT'];
function clean(value, max = 4096) {
  if (typeof value !== 'string') return '';
  const text = value.trim();
  return EMPTY.test(text) ? '' : text.slice(0, max);
}
function fields(text) {
  if (typeof text !== 'string') return {};
  const out = {}; let fence = null; let open = null; let blanks = 0;
  for (const line of text.split('\n')) {
    const marker = /^\s*(`{3,}|~{3,})/.exec(line);
    if (marker) { open = null; if (!fence) fence = marker[1][0]; else if (fence === marker[1][0]) fence = null; continue; }
    if (fence) continue;
    if (/^\s*>/.test(line)) { open = null; continue; }
    const match = TAG.exec(line);
    if (match) {
      const key = match[1].toUpperCase();
      out[key] = match[2].trim();
      open = MULTILINE_TAGS.has(key) ? key : null;
      blanks = 0;
      continue;
    }
    if (!open) continue;
    // 空行照收（段落要靠它分段），但连着两行空就当这段说完了 ——
    // 否则一段 UPDATE 会把它后面整篇不相干的正文都吃进去。
    if (!line.trim()) { if (++blanks >= 2) open = null; else out[open] += '\n'; continue; }
    blanks = 0;
    out[open] = (out[open] ? out[open] + '\n' : '') + line.trim();
  }
  for (const key of Object.keys(out)) out[key] = out[key].trim();
  return out;
}
function source(message, index) {
  return {
    messageId: clean(message.id, 256), sid: clean(message.sid, 256),
    speaker: clean(message.speaker || message.memberId, 100) || 'Agent',
    turnNum: Math.max(0, Number(message.turnNum) || 0),
    at: Number(message.updatedAt || message.createdAt) || 0, index,
    seq: Number(message.seq) || 0, runId: clean(message.runId, 256), attemptId: clean(message.attemptId, 256),
    memberId: clean(message.memberId, 100), providerTurnId: clean(message.providerTurnId, 256),
  };
}
function summarizeGroupState(state) {
  const data = state && typeof state === 'object' ? state : {};
  const summary = { schemaVersion: 3, revision: Number(data.revision) || 0, card: null, review: null, update: null, plan: null, ask: null, timeline: [], lastUserAt: 0, lastUserIndex: -1, currentTurn: Number(data.currentTurn) || 0, truncated: false };
  const run = data.activeRun;
  if (run && typeof run === 'object') summary.execution = {
    runId: clean(run.runId, 256), status: clean(run.status, 80), turnNum: Number(run.turnNum) || 0,
    updatedAt: Number(run.updatedAt || run.startedAt) || 0, hasFailures: !!run.hasFailures,
    attempts: Object.values(data.attempts || {}).filter(a => a && a.runId === run.runId).slice(-32).map(a => ({
      attemptId: clean(a.attemptId, 256), memberId: clean(a.memberId, 100), sid: clean(a.sid, 256),
      status: clean(a.status, 80), providerTurnId: clean(a.providerTurnId, 256),
      updatedAt: Number(a.updatedAt) || 0, failure: a.failure ? { summary: clean(a.failure.summary, 300), action: clean(a.failure.action, 100) } : null,
    })),
  };
  let messages = Array.isArray(data.messages) ? data.messages : [];
  if (!messages.length && Array.isArray(data.turns)) {
    messages = data.turns.flatMap(turn => Object.entries(turn && turn.by || {}).map(([sid, text]) =>
      ({ role: 'assistant', content: text, sid, turnNum: turn.n, createdAt: turn.ts })));
  }
  // 最后一条用户发言的位置：agent 的 ASK 只要排在它后面，就算还没被回应，
  // 工作台据此把这条任务顶进「需要我」。没有它的话，一条老提问会永远挂在那里。
  // 比的是消息顺序而不是时间戳：同一毫秒内落下的两条消息用时间戳分不出先后。
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i] && messages[i].role === 'user') {
      summary.lastUserIndex = i;
      summary.lastUserAt = Number(messages[i].createdAt) || 0;
      break;
    }
  }
  const timeline = [];
  let scanned = 0;
  for (let i = messages.length - 1; i >= 0 && scanned < MAX_SCAN; i--) {
    const message = messages[i];
    if (!message || message.role !== 'assistant') continue;
    scanned++;
    if (message.status === 'progress_update' && message.attemptId && data.attempts?.[message.attemptId]?.status === 'superseded') continue;
    const f = fields(message.content || message.text);
    const meta = source(message, i);
    if (!summary.card && clean(f.PROGRESS)) summary.card = {
      ...meta, progress: clean(f.PROGRESS), verified: clean(f.VERIFIED), risk: clean(f.RISK), report: clean(f.REPORT, 8192),
      notes: clean(f.NOTES),
    };
    if (!summary.review && /^(PASS|FAIL)\b/i.test(f.RESULT || '')) summary.review = {
      ...meta, decision: /^PASS\b/i.test(f.RESULT) ? 'pass' : 'fail',
      blockers: clean(f.BLOCKERS), verified: clean(f.VERIFIED), next: clean(f.NEXT), report: clean(f.REPORT, 8192),
      notes: clean(f.NOTES),
    };
    if (!summary.update && clean(f.UPDATE)) summary.update = { ...meta, text: clean(f.UPDATE) };
    if (!summary.plan && clean(f.PLAN)) summary.plan = { ...meta, text: clean(f.PLAN) };
    // ASK 只认最新一条：上一条提问要么已经被回答，要么已经被这条取代。
    if (!summary.ask && clean(f.ASK)) summary.ask = { ...meta, text: clean(f.ASK) };
    // 纪事：一条消息可能同时带方案和进展，各自成一条，按消息顺序倒着收、最后翻正。
    if (timeline.length < MAX_TIMELINE) {
      for (const [kind, text] of [
        ['review', clean(f.RESULT) && ((/^PASS\b/i.test(f.RESULT) ? '审核通过' : '审核要求修订') + (clean(f.NOTES) ? '\n' + clean(f.NOTES) : clean(f.BLOCKERS) ? '\n' + clean(f.BLOCKERS) : ''))],
        ['handoff', clean(f.PROGRESS) && (clean(f.PROGRESS) + (clean(f.NOTES) ? '\n' + clean(f.NOTES) : ''))],
        ['ask', clean(f.ASK)],
        ['update', clean(f.UPDATE)],
        ['plan', clean(f.PLAN)],
      ]) {
        // 只带渲染纪事真正要用的几个字段：runId/attemptId 那些执行细节留在原摘要里，
        // 24 条各背一份会让这份要落盘的摘要凭空胖一大截。
        if (text) timeline.push({ kind, text: text.slice(0, MAX_TIMELINE_TEXT),
          speaker: meta.speaker, turnNum: meta.turnNum, at: meta.at, messageId: meta.messageId });
      }
    }
    if (Object.entries(f).some(([key, value]) => value.length > (key === 'REPORT' ? 8192 : 4096))) summary.truncated = true;
    if (timeline.length >= MAX_TIMELINE && summary.card && summary.review) break;
  }
  summary.timeline = timeline.slice(0, MAX_TIMELINE).reverse();
  return summary;
}
function publishSaved(hubDataDir, meetingId, summary) {
  for (const listener of listeners) {
    try { listener({ hubDataDir, meetingId, summary }); }
    catch (error) { console.error('[dev-workbench] subscriber failed:', error.message); }
  }
}
function subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); }
/**
 * 从一段实时输出里抠出该落进群聊的人话，按它们在原文里出现的顺序返回。
 * 一条消息里可以同时有 PLAN 和 UPDATE（agent 说完打算就接着报进展），各自成一条。
 */
function processLiveTags(text) {
  const parsed = fields(text);
  if (FINAL_TAGS.some(tag => clean(parsed[tag]))) return [];
  // Object 的键按插入顺序排列，而 fields 是逐行扫的 —— 所以这就是原文顺序。
  return Object.keys(parsed)
    .filter(tag => LIVE_TAGS.includes(tag))
    .map(tag => ({ tag, text: clean(parsed[tag]) }))
    .filter(entry => entry.text);
}
function processUpdate(text) {
  const hit = processLiveTags(text).find(entry => entry.tag === 'UPDATE');
  return hit ? hit.text : '';
}
module.exports = { summarizeGroupState, publishSaved, subscribe, clean, processUpdate, processLiveTags, fields, LIVE_TAGS, MAX_TIMELINE };
