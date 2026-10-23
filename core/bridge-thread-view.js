'use strict';
// 通道串（家里 ⇄ 公司）的展示数据（2026-10-16 用户选定：B 通道串 + E 进度线，设计稿
// D:/AI-Artifacts/20261016-通道界面优化版-claude1.html）。纯函数：给线程记录与当前时间，算出块头状态和进度线。
// 线程记录来自 bridge:status（家里：core/company-bridge/home.js；公司：company.js），字段缺失时只显示能算的段。

function fmtDur(ms) {
  if (!(ms >= 0)) return '';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} 秒`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} 分`;
  const h = Math.floor(m / 60);
  return `${h} 小时${m % 60 ? ` ${m % 60} 分` : ''}`;
}
function clock(at) {
  if (!at) return '';
  return require('./beijing-time').formatBeijingClock(at);
}

// 一轮的状态：queued（发出，公司还没开始）、running、done、failed。
function roundState(round) {
  if (!round) return 'queued';
  if (round.reply) return 'done';
  if (round.error) return 'failed';
  if (round.status === 'running') return 'running';
  return 'queued';
}

const STATE_LABEL = { queued: '排队中', running: '处理中', done: '已回执', failed: '没答上' };

// 进度线：发出 → 公司收到 → 排队 → 处理 → 回执。每段 { label, state: done|current|pending|failed }。
function roundSteps(round, now = Date.now()) {
  const st = roundState(round);
  const sentAt = round?.sentAt || null, ackAt = round?.ackAt || null, startedAt = round?.startedAt || null;
  const end = round?.replyAt || round?.errorAt || null;
  const steps = [];
  steps.push({ label: sentAt ? `发出 ${clock(sentAt)}` : '发出', state: 'done' });
  if (ackAt) steps.push({ label: `公司收到 +${fmtDur(ackAt - (sentAt || ackAt))}`, state: 'done' });
  else steps.push({ label: '公司收到', state: st === 'queued' ? 'current' : 'done' });
  if (st === 'queued') {
    const waited = ackAt ? fmtDur(now - ackAt) : '';
    const note = round?.note && /排队/.test(round.note) ? round.note : '';
    steps.push({ label: note || (waited ? `排队中 · 已 ${waited}` : '排队中'), state: ackAt ? 'current' : 'pending' });
    steps.push({ label: '处理', state: 'pending' });
    steps.push({ label: '回执', state: 'pending' });
    return steps;
  }
  const queueMs = startedAt && ackAt ? startedAt - ackAt : null;
  steps.push({ label: queueMs != null ? `排队 ${fmtDur(queueMs)}` : '排队', state: 'done' });
  if (st === 'running') {
    steps.push({ label: `处理中${startedAt ? ` · 已 ${fmtDur(now - startedAt)}` : ''}`, state: 'current' });
    steps.push({ label: '回执', state: 'pending' });
    return steps;
  }
  const workMs = end && startedAt ? end - startedAt : (round?.meta?.elapsedSec ? round.meta.elapsedSec * 1000 : null);
  if (st === 'failed') {
    const why = String(round.error || '').split(/[\n。（(]/)[0].trim();
    steps.push({ label: why ? (why.length > 28 ? why.slice(0, 28) + '…' : why) : '没答上', state: 'failed' });
    steps.push({ label: '—', state: 'pending' });
    return steps;
  }
  steps.push({ label: workMs != null ? `处理 ${fmtDur(workMs)}` : '处理', state: 'done' });
  steps.push({ label: `回执 ${clock(end)}`, state: 'done' });
  return steps;
}

// 块头：最后一轮决定状态；全程耗时从第一轮发出到最后一轮回执。
function threadSummary(thread, now = Date.now()) {
  const rounds = Array.isArray(thread?.rounds) ? thread.rounds : [];
  const last = rounds[rounds.length - 1] || null;
  const state = roundState(last);
  const total = last && (last.replyAt || last.errorAt) && last.sentAt ? (last.replyAt || last.errorAt) - last.sentAt : null;
  return { state, label: STATE_LABEL[state], rounds: rounds.length, lastRound: last ? last.round : null,
    lastTotal: state === 'done' && total != null ? fmtDur(total) : '', steps: last ? roundSteps(last, now) : [],
    note: last?.note || '', model: last?.meta?.actualModel || last?.meta?.model || thread?.model || '' };
}

// 答方（公司替家里办事、家里替公司办事）的线程记录：receivedAt 收到，sentAt 已送进会话开始处理，reply/error 结束。
function answerState(round) {
  if (!round) return 'queued';
  if (round.reply) return 'done';
  if (round.error) return 'failed';
  return round.sentAt ? 'running' : 'queued';
}
function answerSummary(thread, now = Date.now()) {
  const rounds = Array.isArray(thread?.rounds) ? thread.rounds : [];
  const last = rounds[rounds.length - 1] || null;
  const state = answerState(last);
  const start = last?.receivedAt || null;
  const total = state === 'done' && start && last.replyAt ? fmtDur(last.replyAt - start) : '';
  const since = state === 'running' && (last.firstSentAt || last.sentAt) ? fmtDur(now - (last.firstSentAt || last.sentAt)) : '';
  return { state, label: STATE_LABEL[state], rounds: rounds.length, lastRound: last ? last.round : null, lastTotal: total,
    steps: [], note: since ? `处理中 · 已 ${since}` : '', model: last?.meta?.actualModel || last?.meta?.model || thread?.model || '' };
}

// 结论一行：回答正文里第一处 📌 那一行，没有就取第一行非空文字。
function headline(text) {
  const lines = String(text || '').split(/\r?\n/).map(l => l.replace(/^\s*[#>*\-]+\s*/, '').replace(/\*\*/g, '').trim()).filter(Boolean);
  return lines.find(l => l.startsWith('📌')) || lines.find(l => !/^【.*】$/.test(l)) || '';
}

module.exports = { fmtDur, clock, roundState, roundSteps, threadSummary, answerState, answerSummary, headline, STATE_LABEL };
