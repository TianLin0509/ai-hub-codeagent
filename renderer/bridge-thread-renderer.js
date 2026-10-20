'use strict';
// 通道串（2026-10-16 用户选定：B 通道串 + E 进度线，设计稿 D:/AI-Artifacts/20261016-通道界面优化版-claude1.html）。
// 家里 ⇄ 公司通道送进会话的消息（core/bridge-message-kind.js 认出）不按「用户」的消息显示：
//   - 每条先渲染成一张通道卡，自带一块收起的通道串，单独也能看；
//   - applyBridgeThreads 再按编号把同一串归到最新那一张（锚点）上，之前的位置只留一条细线；
//   - 块头的状态、进度线、耗时来自 bridge:status 的线程记录（core/bridge-thread-view.js），没有记录时只用卡片自身。
// 两个方向都认：家里问公司（家里收回执、公司收提问）和公司问家里（公司收家里回复、家里收求助）。
// 「问方」会话里块内是双方每一轮；「答方」会话里块内是对方的提问，自己的回答仍是普通卡片。
const { bridgeMessageKind, bridgeText, receiptHeadInfo } = require('../core/bridge-message-kind');
const view = require('../core/bridge-thread-view');
const pairing = require('../core/company-bridge/pairing-plate');

// 结尾说明前的「——」在 Codex 会话里会被吞成空格（delivery-guard.js 有说明），只剩空行也认。
const FOOTER_RE = /\n[—\s]*\n(?:以上是公司 CodeAgent 的回执|公司那边这一轮没有给出回答|以上是家里|家里这一轮没有给出回答)[\s\S]*$/;
const HEADER_RE = /^## [^\n]*（编号 [^\n]*）[^\n]*\n/m;
// 家里用的 AI 显示名（2026-10-20 修）：以前只认 claude / codex，DeepSeek、GLM 等都被写成「家里 Claude」。
const agentLabel = kind => pairing.modelLabel(kind) || 'Claude';

// 正文：去掉 Hub 加的标题行、规则附注和结尾说明。
function messageBody(text, kind) {
  let s = bridgeText(text).replace(FOOTER_RE, '');
  if (kind === 'company-receipt' || kind === 'home-reply') s = s.replace(/^【[^】]*】\s*/, '');
  if (kind === 'channel-request') {
    const m = s.match(HEADER_RE);
    if (m) s = s.slice(m.index + m[0].length);
    s = s.replace(/\n（规则同前[^\n]*）\s*$/, '');
  }
  return s.trim();
}

// 一条通道消息在本会话里的位置。role：asker（本会话发问）/ answerer（本会话作答）；peer：对端是 company 还是 home。
function describeMessage(text) {
  const kind = bridgeMessageKind(text);
  if (!kind) return null;
  const s = bridgeText(text);
  const base = { thread: kind.thread, round: kind.round, kind: kind.kind };
  // 首行新旧格式、Codex 吞掉「·」的写法都认（core/bridge-message-kind.js receiptHeadInfo）。
  const head = receiptHeadInfo(s);
  if (kind.kind === 'company-receipt') return { ...base, role: 'asker', peer: 'company', who: 'peer', failed: !!head?.failed, topic: head?.topic || '' };
  if (kind.kind === 'home-reply') {
    const tag = head?.tag || '';
    return { ...base, role: 'asker', peer: 'home', who: 'peer', failed: !!head?.failed, agent: /codex/i.test(tag) ? 'codex' : /deepseek/i.test(tag) ? 'deepseek' : /glm|智谱/i.test(tag) ? 'glm' : 'claude' };
  }
  if (kind.kind === 'channel-rewrite') return { ...base, role: 'answerer', peer: 'home', who: 'hub', failed: false };
  const header = (s.match(HEADER_RE) || [''])[0];
  const fromCompany = /## 公司 CodeAgent 的/.test(header);
  const fromTitle = (header.match(/来自公司会话「([^」]*)」/) || [])[1] || '';
  return { ...base, role: 'answerer', peer: fromCompany ? 'company' : 'home', who: 'peer', failed: false, fromTitle };
}

function esc(deps, s) { return deps.escapeHtml(String(s == null ? '' : s)); }
const partyName = (party, agent) => party === 'company' ? '公司 CodeAgent' : `家里 ${agentLabel(agent)}`;
const partyShort = party => party === 'company' ? '公司' : '家里';
const otherParty = party => party === 'company' ? 'home' : 'company';

function avatar(deps, party, agent, model) {
  const kind = party === 'company' ? 'codeagent' : (agent || 'claude');
  const src = deps.avatarSrc ? deps.avatarSrc(kind, model) : null;
  return src ? `<span class="bt-av"><img src="${esc(deps, src)}" alt=""></span>`
    : `<span class="bt-av bt-av-letter">${party === 'company' ? 'C' : 'H'}</span>`;
}

// 线程记录里对端用的 AI（家里作答时是 Claude 或 Codex）。
function peerAgent(record, ctx) {
  if (ctx.agent) return ctx.agent;
  const rounds = record?.rounds || [];
  const last = rounds[rounds.length - 1];
  return last?.meta?.agent || record?.agent || record?.from?.kind || 'claude';
}

// 一行：谁、一句话、时间；点开是全文。
function roundRow(deps, row, ctx) {
  const party = row.who === 'peer' ? ctx.peer : row.who === 'self' ? otherParty(ctx.peer) : 'hub';
  const asks = ctx.role === 'asker' ? row.who === 'self' : row.who === 'peer';
  const name = row.who === 'hub' ? 'Hub 要求改写' : row.failed ? '没答上' : `${partyShort(party)}${asks ? '问' : '答'}`;
  const one = row.failed ? (row.body.split('\n').find(Boolean) || '没答上')
    : asks || row.who === 'hub' ? row.body.replace(/\s+/g, ' ').slice(0, 90) : (view.headline(row.body) || row.body.slice(0, 90));
  const agent = party === 'home' ? (row.who === 'peer' ? ctx.agent : ctx.selfAgent) : null;
  const av = party === 'hub' ? '<span class="bt-av bt-av-letter">⇄</span>' : avatar(deps, party, agent, row.model);
  return `<details class="bt-round party-${party}${row.failed ? ' fail' : ''}" data-round="${row.round}" data-who="${row.who}"><summary>${av}`
    + `<b class="bt-name">${esc(deps, name)}</b><span class="bt-one">${esc(deps, `第 ${row.round} 轮：${one}`)}</span><span class="bt-tm">${esc(deps, row.time || '')}</span><span class="bt-full-hint">全文 ▾</span></summary>`
    + `<div class="bt-full">${deps.renderMarkdown(row.body)}</div></details>`;
}

function stepsHtml(deps, steps) {
  if (!steps || !steps.length) return '';
  return '<div class="bt-steps">' + steps.map(s => `<span class="bt-step ${s.state}">${esc(deps, s.label)}</span>`).join('<i class="bt-arrow"></i>') + '</div>';
}

// 一块通道串。ctx：{ threadId, role, peer, agent, selfAgent, record, fromTitle }。
function threadBlock(deps, ctx, rows, now = Date.now(), open = false) {
  const { threadId, role, peer, record } = ctx;
  const summary = record ? (role === 'asker' ? view.threadSummary(record, now) : view.answerSummary(record, now)) : null;
  const lastRow = rows[rows.length - 1] || null;
  const state = summary ? summary.state : lastRow?.failed ? 'failed' : 'done';
  const roundsCount = Math.max(summary?.rounds || 0, new Set(rows.map(r => r.round)).size);
  // 公司用的号（2026-10-20 修）：公司发回前删掉了 poolLabel / account，只留代称 accountAlias；以前取前两个，永远是空的。
  const lastMeta = [...(record?.rounds || [])].reverse().find(r => r?.meta)?.meta || null;
  const account = lastMeta?.accountAlias || record?.company?.accountAlias || lastMeta?.poolLabel || lastMeta?.account || '';
  const title = role === 'asker'
    ? `${threadId} · ${partyName(peer, ctx.agent)}${peer === 'company' && account ? ' · ' + account : ''}`
    : `${peer === 'home' ? '特战任务' : '为' + partyShort(peer) + '办事'} · ${threadId} · ${partyName(peer, ctx.agent)}`;
  const chips = [`<span class="bt-chip">${roundsCount} 轮</span>`];
  if (summary?.lastTotal) chips.push(`<span class="bt-chip">全程 ${esc(deps, summary.lastTotal)}</span>`);
  if (summary?.model) chips.push(`<span class="bt-chip">${esc(deps, summary.model)}</span>`);
  if (role === 'answerer' && summary?.note) chips.push(`<span class="bt-chip">${esc(deps, summary.note)}</span>`);
  // 配对号牌（2026-10-20）：家里看公司那条会话叫什么；公司看对接的是家里哪个会话、本会话由哪个号哪个模型作答。
  const plateName = role === 'asker' && peer === 'company' ? (record?.company?.sessionTitle || record?.companyPlate || record?.plate || '') : '';
  if (plateName) chips.push(`<span class="bt-chip bt-plate" title="公司那边的会话名">会话 ${esc(deps, plateName)}</span>`);
  const homePair = role === 'answerer' && peer === 'home' ? pairing.homePairText(record?.from) : '';
  if (homePair) chips.push(`<span class="bt-chip bt-plate">${esc(deps, homePair)}</span>`);
  const answeredBy = role === 'answerer' && peer === 'home' && record ? pairing.answeredByText(record) : '';
  if (answeredBy) chips.push(`<span class="bt-chip">${esc(deps, answeredBy)}</span>`);
  const answerRow = [...rows].reverse().find(r => !r.failed && (role === 'asker' ? r.who === 'peer' : r.who === 'self'));
  const pin = answerRow && state === 'done' ? view.headline(answerRow.body) : '';
  const failed = state === 'failed';
  const acts = role === 'asker'
    ? `<div class="bt-acts"><button type="button" class="bt-btn" data-bridge-action="followup" data-thread="${esc(deps, threadId)}" title="把追问的开头填进输入框，写完问题发出即可">追问</button>`
      + (peer === 'company' ? `<button type="button" class="bt-btn" data-bridge-action="recollect" data-thread="${esc(deps, threadId)}" title="请公司把最新一轮已经写好的回答直接取回，不重答">补收</button>` : '')
      + (failed ? `<button type="button" class="bt-btn" data-bridge-action="reask" data-thread="${esc(deps, threadId)}" title="把上一轮的问题填进输入框，改好后发出重问">重问</button>` : '') + '</div>'
    : '';
  const waiting = role === 'asker' && (state === 'queued' || state === 'running')
    ? `<div class="bt-wait party-${peer}"><span class="bt-spin"></span>${partyShort(peer)}答 · ${esc(deps, state === 'queued' ? '排队中，等待开工' : '处理中')}……</div>` : '';
  return `<details class="bridge-thread role-${role} peer-${peer} st-${state}"${open ? ' open' : ''} data-thread="${esc(deps, threadId)}"><summary class="bt-sum">`
    + `<div class="bt-head"><span class="bt-icon">⇄</span><b class="bt-title">${esc(deps, title)}</b><span class="bt-state">${view.STATE_LABEL[state]}</span>${chips.join('')}<span class="bt-more"></span></div>`
    + (role === 'asker' && summary ? stepsHtml(deps, summary.steps) : '')
    + (pin ? `<div class="bt-headline">${esc(deps, pin)}</div>` : '') + '</summary>'
    + `<div class="bt-body">${rows.map(r => roundRow(deps, r, ctx)).join('')}${waiting}${acts}</div></details>`;
}

// renderTurnCard 遇到通道消息时调用；不是通道消息返回 null。
function renderBridgeCard(turn, deps) {
  if (!turn || turn.role !== 'user') return null;
  const info = describeMessage(turn.text);
  if (!info) return null;
  const body = messageBody(turn.text, info.kind);
  const time = turn.ts ? view.clock(turn.ts) : ''; // 和线程记录里的时间同一种写法（时:分）
  const row = { round: info.round, who: info.who, failed: info.failed, body, time };
  const ctx = { threadId: info.thread, role: info.role, peer: info.peer, agent: info.agent || '', record: null, fromTitle: info.fromTitle || '' };
  const src = `<template class="bt-src" data-round="${row.round}" data-who="${row.who}" data-failed="${row.failed ? 1 : 0}" data-time="${esc(deps, time)}"`
    + ` data-ts="${Number(turn.ts) || 0}" data-agent="${esc(deps, info.agent || '')}" data-from-title="${esc(deps, info.fromTitle || '')}">${esc(deps, body)}</template>`;
  return `<div class="turn-card bridge-msg" data-turn-id="${esc(deps, turn.id || '')}" data-phase="message" data-bridge-thread="${esc(deps, info.thread)}"`
    + ` data-bridge-round="${row.round}" data-bridge-kind="${info.kind}" data-bridge-role="${info.role}" data-bridge-peer="${info.peer}">`
    + `<div class="bt-merged"><span class="bt-icon">⇄</span>${esc(deps, info.thread)} 第 ${row.round} 轮 · 已并入下方通道串 ↓</div>`
    + `<div class="bt-slot">${threadBlock(deps, ctx, [row])}</div>${src}</div>`;
}

// 同一轮、同一方有多张卡（失败后补收、重复投递）：成功的盖过失败的，同为成功取后到的。
function pickRow(prev, next) {
  if (!prev) return next;
  if (prev.failed && !next.failed) return next;
  if (!prev.failed && next.failed) return prev;
  return next;
}

// 把卡片 + 线程记录合成一串的各行，按轮次排好。
function collectRows(cards, ctx) {
  const byKey = new Map();
  const put = row => { const key = `${row.round}:${row.who}`; byKey.set(key, pickRow(byKey.get(key), row)); };
  const record = ctx.record;
  // 问方：提问只在线程记录里（发问是会话里的 AI 调工具发出的，会话里没有这条消息）；回答优先用会话里的卡。
  if (record) {
    for (const r of record.rounds || []) {
      const at = ctx.role === 'asker' ? r.sentAt : r.receivedAt;
      if (r.question && ctx.role === 'asker') put({ round: r.round, who: 'self', failed: false, body: String(r.question), time: at ? view.clock(at) : '' });
      if (r.question && ctx.role === 'answerer') put({ round: r.round, who: 'peer', failed: false, body: String(r.question), time: at ? view.clock(at) : '' });
      const answerer = ctx.role === 'asker' ? 'peer' : 'self';
      if (r.reply) put({ round: r.round, who: answerer, failed: false, body: String(r.reply), time: r.replyAt ? view.clock(r.replyAt) : '', model: r.meta?.model || '' });
      else if (r.error) put({ round: r.round, who: answerer, failed: true, body: String(r.error), time: r.errorAt || r.failedAt ? view.clock(r.errorAt || r.failedAt) : '' });
    }
  }
  for (const card of cards) {
    const t = card.querySelector('template.bt-src');
    if (!t) continue;
    const body = t.content ? t.content.textContent : t.textContent;
    const row = { round: Number(t.dataset.round), who: t.dataset.who, failed: t.dataset.failed === '1', time: t.dataset.time, body };
    // 卡片是真正送到会话里的那一条，同一轮同一方时以卡片为准（失败卡不盖记录里的成功回答）。
    const key = `${row.round}:${row.who}`;
    const prev = byKey.get(key);
    byKey.set(key, prev && !prev.failed && row.failed ? prev : row);
  }
  const order = { self: 0, peer: 1, hub: 2 };
  const first = ctx.role === 'asker' ? 'self' : 'peer';
  return [...byKey.values()].sort((a, b) => a.round - b.round
    || (a.who === first ? -1 : b.who === first ? 1 : order[a.who] - order[b.who]));
}

// 按编号把同一串归到最新一张卡上。records：{ [编号]: 线程记录 }。返回处理的串数。
function applyBridgeThreads(container, deps, records = {}, now = Date.now()) {
  if (!container) return 0;
  const cards = [...container.querySelectorAll(':scope > .turn-card.bridge-msg')];
  const byThread = new Map();
  for (const card of cards) {
    const id = card.dataset.bridgeThread;
    if (!byThread.has(id)) byThread.set(id, []);
    byThread.get(id).push(card);
  }
  let banner = null;
  for (const [threadId, list] of byThread) {
    const anchor = list[list.length - 1];
    const record = records[threadId] || null;
    const srcs = list.map(c => c.querySelector('template.bt-src')).filter(Boolean);
    const ctx = { threadId, role: anchor.dataset.bridgeRole, peer: anchor.dataset.bridgePeer, record,
      agent: srcs.map(t => t.dataset.agent).filter(Boolean).pop() || '', selfAgent: deps.selfAgent || '' };
    if (!ctx.agent) ctx.agent = ctx.peer === 'home' ? peerAgent(record, ctx) : '';
    ctx.fromTitle = record?.from?.title || srcs.map(t => t.dataset.fromTitle).filter(Boolean).pop() || '';
    const rows = collectRows(list, ctx);
    for (const card of list) {
      card.classList.toggle('bt-merged-card', card !== anchor);
      card.classList.toggle('bt-anchor', card === anchor);
      const line = card.querySelector('.bt-merged');
      const round = card.dataset.bridgeRound;
      if (line) line.innerHTML = `<span class="bt-icon">⇄</span>${esc(deps, threadId)} 第 ${esc(deps, round)} 轮 · 已并入下方通道串 ↓`;
    }
    const slot = anchor.querySelector('.bt-slot');
    if (slot) {
      const prev = slot.querySelector('details.bridge-thread');
      const open = !!prev?.open;
      const openRows = new Set([...slot.querySelectorAll('details.bt-round[open]')].map(d => `${d.dataset.round}:${d.dataset.who}`));
      slot.innerHTML = threadBlock(deps, ctx, rows, now, open);
      slot.querySelectorAll('details.bt-round').forEach(d => { if (openRows.has(`${d.dataset.round}:${d.dataset.who}`)) d.open = true; });
      if (typeof deps.postProcess === 'function') { try { deps.postProcess(slot); } catch {} }
    }
    if (ctx.role === 'answerer') banner = { threadId, peer: ctx.peer, title: ctx.fromTitle, agent: ctx.agent, record };
  }
  // 答方会话顶部一条「特战任务：<发问会话标题>」（公司一端；家里一端替公司作答时写「为公司办事」）。一个答方会话只服务一个编号，取最新那串。
  let bar = container.querySelector(':scope > .bt-banner');
  if (banner) {
    if (!bar) { bar = container.ownerDocument.createElement('div'); bar.className = 'bt-banner'; container.insertBefore(bar, container.firstChild); }
    bar.dataset.peer = banner.peer;
    // 公司一端（2026-10-20）：横条另写「家里 <会话名 #短码> · <家里模型>」和「本会话由 <号> · <模型> 作答」；老版本家里没带短码时照旧。
    const homePair = banner.peer === 'home' ? pairing.homePairText(banner.record?.from) : '';
    const answeredBy = banner.peer === 'home' && banner.record ? pairing.answeredByText(banner.record) : '';
    bar.innerHTML = `<span class="bt-icon">⇄</span><b>${banner.peer === 'home' ? '特战任务' : '为' + partyShort(banner.peer) + '办事'}：</b><span>${esc(deps, banner.title || banner.threadId)}</span>`
      + `<span class="bt-banner-id">${esc(deps, banner.threadId)} · ${esc(deps, homePair || partyName(banner.peer, banner.agent))}</span>`
      + (answeredBy ? `<span class="bt-banner-id bt-banner-by">${esc(deps, answeredBy)}</span>` : '');
  } else if (bar) bar.remove();
  return byThread.size;
}

// 线程记录：bridge:status 里各个列表按编号合在一起，并记下本机在这串里是问方还是答方、对端是谁。
//   家里：threads 是家里问公司，consults 是家里替公司作答；公司：threads 是公司替家里作答，askHome 是公司问家里。
function recordsFromStatus(status) {
  const out = {};
  if (!status || status.ok === false || !status.role) return out;
  const home = status.role === 'home';
  const lists = home
    ? [[status.threads, 'asker', 'company'], [status.consults, 'answerer', 'company']]
    : [[status.threads, 'answerer', 'home'], [status.askHome, 'asker', 'home']];
  for (const [list, role, peer] of lists) {
    for (const t of Array.isArray(list) ? list : []) {
      if (t && t.id && !String(t.id).includes('#')) out[t.id] = { ...t, bridgeRole: role, bridgePeer: peer };
    }
  }
  return out;
}

// 公司 Hub 远程重启前被中断、重启后没能自动恢复的本机会话（core/company-bridge/hub-admin.js resumeIssues，2026-10-17）。
function restartIssuesFromStatus(status) {
  const out = {};
  if (!status || status.ok === false || status.role !== 'company') return out;
  for (const x of Array.isArray(status.hubAdmin?.resumeIssues) ? status.hubAdmin.resumeIssues : []) if (x && x.sessionId) out[x.sessionId] = x;
  return out;
}
// 侧栏标记：「重启打断」，悬停看原因。通道轮次的失败走通道串自己的「没答上」，这里只有本机会话。
function restartBadge(sessionId, issues) {
  const x = sessionId && issues && issues[sessionId];
  if (!x) return null;
  return { chip: '重启打断', sub: '重启打断，未能自动恢复' + (x.note ? '：' + x.note : '') + '；打开会话看一眼，需要的话自己发「继续」', pin: '', state: 'failed', role: 'restart', thread: null };
}

// 会话列表与卡片网格上的「⇄」标签：按会话找它参与的最新一串。返回 { chip, sub, state, thread } 或 null。
function sessionBadge(sessionId, records, now = Date.now()) {
  if (!sessionId) return null;
  let best = null;
  const mine = [];
  for (const t of Object.values(records || {})) {
    if (t.sessionId !== sessionId) continue;
    mine.push(t);
    const last = t.rounds?.[t.rounds.length - 1];
    const at = last?.sentAt || last?.receivedAt || t.createdAt || 0;
    if (!best || at > best.at) best = { t, at };
  }
  if (!best) return null;
  const t = best.t;
  if (t.bridgeRole === 'asker') {
    const result = askerBadge(t, now);
    // 对端（2026-10-20）：「→ 公司 号 1 · GLM-5 · 会话 <公司会话号牌>」；本会话有多个在途编号时全列出（lines），最新的放在最前。
    if (t.bridgePeer === 'company') {
      const inFlight = mine.filter(x => x.bridgeRole === 'asker' && x.bridgePeer === 'company' && ['queued', 'running'].includes(view.threadSummary(x, now).state));
      const list = [t, ...inFlight.filter(x => x !== t)];
      const lines = list.map(x => `${x.id} ${pairing.companyPairText(x) || '→ 公司'}`);
      const peer = inFlight.length > 1
        ? `→ 公司 ${inFlight.length} 个在途：` + inFlight.map(x => `${pairing.threadShort(x.id)} ${pairing.companyPairText(x, { withPlate: false }).replace(/^→ 公司 ?/, '') || '排队中'}`).join('｜')
        : pairing.companyPairText(t);
      if (peer) Object.assign(result, { peer, lines });
    }
    return result;
  }
  return answererBadge(t, now);
}
function askerBadge(t, now) {
  const s = view.threadSummary(t, now);
  const last = t.rounds[t.rounds.length - 1] || {};
  const since = s.state === 'running' ? last.startedAt : s.state === 'queued' ? last.sentAt : null;
  const elapsed = since ? view.fmtDur(now - since) : '';
  const chip = s.state === 'done' ? `⇄ ${s.rounds} 轮` : `⇄ ${s.label}${elapsed ? ' · ' + elapsed : ''}`;
  const step = s.steps.find(x => x.state === 'current' || x.state === 'failed');
  const sub = s.state === 'done' ? `${t.id} · 第 ${s.lastRound} 轮已回执${s.lastTotal ? ' · ' + s.lastTotal : ''}`
    : `${t.id} · 第 ${s.lastRound} 轮 · ${step ? step.label : s.label}`;
  const pin = s.state === 'done' ? view.headline(last.reply || '') : '';
  return { chip, sub, pin, state: s.state, role: 'asker', thread: t.id };
}
function answererBadge(t, now) {
  const s = view.answerSummary(t, now);
  // 公司一端替家里作答（2026-10-17 用户）：会话名已以「特战」开头，侧栏不再写「家里」，标签只放这一轮到哪了。
  const tezhan = t.bridgePeer === 'home';
  const progress = s.state === 'done' ? `第 ${s.lastRound} 轮已答` : s.state === 'failed' ? '没答上' : s.note || s.label;
  const sub = tezhan ? `特战任务 · ${t.id} · ${progress}` : `为${partyShort(t.bridgePeer)}办事 · ${t.id} · ${progress}`;
  const chip = tezhan ? `⇄ ${s.state === 'done' ? '已答' : s.state === 'failed' ? '没答上' : s.label}` : `⇄ ${partyShort(t.bridgePeer)}`;
  const out = { chip, sub, pin: '', state: s.state, role: 'answerer', thread: t.id };
  // 公司一端（2026-10-20）：对接的是家里哪个会话、本会话由哪个号哪个模型作答；老版本家里没带短码时不加。
  const homePair = tezhan ? pairing.homePairText(t.from) : '';
  if (homePair) { const by = pairing.answeredByText(t); out.peer = homePair + (by ? ' · ' + by : ''); out.lines = [`${t.id} ${out.peer}`]; }
  return out;
}

// 按钮的两种做法（2026-10-16 取舍）：「补收」直接调 bridge:recollect（只是请对端取回已写好的回答，不需要会话里的 AI 动脑）；
// 「追问」「重问」要写新问题，把开头填进本会话输入框，由用户写完发出、会话里的 AI 调 followup 工具发出去——
// 这样问题文字经过他确认，也和 AI 平时追问走同一条路。输入框里已有内容时不覆盖。
function composerText(action, threadId, role, peer, lastQuestion) {
  const tool = peer === 'company' ? 'followup_company' : 'followup_home';
  if (action === 'reask') return `用 ${tool} 就编号 ${threadId} 换个问法重问上一轮：\n${lastQuestion || ''}`;
  return `用 ${tool} 就编号 ${threadId} 追问${partyShort(peer)}：`;
}

// 渲染层的接线：拉线程记录、bridge:changed 时刷新、合并调度、按钮。
function createBridgeThreadController({ doc, scope = doc, deps, invoke = null, subscribe = null, toast = null, autoload = false, now = () => Date.now() }) {
  let records = {};
  let restartIssues = {};
  let loaded = null;
  const pending = new Set();
  let timer = null;
  const containers = () => new Set([...scope.querySelectorAll('.turn-card.bridge-msg')].map(c => c.parentElement).filter(Boolean));
  function flush() {
    timer = null;
    const list = [...pending];
    pending.clear();
    for (const c of list) if (c.isConnected !== false) { try { applyBridgeThreads(c, deps, records, now()); } catch (error) { console.warn('[bridge-thread] apply failed:', error && error.message); } }
  }
  function schedule(container) {
    if (!container) return;
    pending.add(container);
    if (!loaded) void load();
    if (!timer) timer = setTimeout(flush, 0);
  }
  async function load() {
    if (!invoke) { loaded = Promise.resolve(); return; }
    loaded = (async () => {
      try { const st = await invoke('bridge:status'); records = recordsFromStatus(st); restartIssues = restartIssuesFromStatus(st); } catch { records = {}; restartIssues = {}; }
      for (const c of containers()) pending.add(c);
      if (!timer) timer = setTimeout(flush, 0);
      try { doc.dispatchEvent(new (doc.defaultView?.CustomEvent || CustomEvent)('bridge-threads-updated')); } catch {}
    })();
    return loaded;
  }
  if (typeof subscribe === 'function') subscribe(() => { void load(); });
  if (autoload && invoke) void load();
  // 在途的串（排队中、处理中）每分钟重算一次「已 N 分」，不等下一次状态变化。
  if (autoload && invoke) {
    const inFlight = () => Object.values(records).some(t => { const st = t.bridgeRole === 'asker' ? view.roundState(t.rounds?.[t.rounds.length - 1]) : view.answerState(t.rounds?.[t.rounds.length - 1]); return st === 'queued' || st === 'running'; });
    const tick = setInterval(() => {
      if (!inFlight()) return;
      for (const c of containers()) pending.add(c);
      if (!timer) timer = setTimeout(flush, 0);
      try { doc.dispatchEvent(new (doc.defaultView?.CustomEvent || CustomEvent)('bridge-threads-updated')); } catch {}
    }, 60000);
    tick.unref?.();
  }
  async function act(button) {
    const action = button.dataset.bridgeAction;
    const threadId = button.dataset.thread;
    const card = button.closest('.turn-card.bridge-msg');
    const sessionId = card?.dataset.sessionId || '';
    const block = button.closest('.bridge-thread');
    const role = card?.dataset.bridgeRole, peer = card?.dataset.bridgePeer;
    if (action === 'recollect') {
      if (!invoke) return;
      button.disabled = true;
      try {
        const r = await invoke('bridge:recollect', { sessionId, thread: threadId });
        if (r && r.ok === false) throw new Error(r.error || '补收失败');
        toast?.(`已请${partyShort(peer)}补收 ${threadId} 第 ${r?.round || ''} 轮，回答到了会作为新消息送进本会话`);
      } catch (error) { toast?.('补收没发出：' + error.message, 'error'); }
      finally { button.disabled = false; }
      return;
    }
    const record = records[threadId];
    const lastQuestion = record?.rounds?.[record.rounds.length - 1]?.question
      || [...(block?.querySelectorAll('details.bt-round[data-who="self"] .bt-full') || [])].pop()?.textContent || '';
    const bar = [...doc.querySelectorAll('.floating-input-bar')].find(b => b.dataset.sessionId === sessionId);
    const input = bar?.querySelector('.floating-input-box') || button.closest('.terminal-panel')?.querySelector('.floating-input-box');
    if (!input) { toast?.('没找到这个会话的输入框', 'error'); return; }
    if ((input.innerText || input.textContent || '').trim()) { toast?.('输入框里已有内容，先发出或清空再点', 'warning'); return; }
    input.textContent = composerText(action, threadId, role, peer, String(lastQuestion).trim());
    input.dispatchEvent(new (doc.defaultView?.Event || Event)('input', { bubbles: true }));
    input.focus?.();
    try {
      const range = doc.createRange(); range.selectNodeContents(input); range.collapse(false);
      const sel = doc.defaultView.getSelection(); sel.removeAllRanges(); sel.addRange(range);
    } catch {}
  }
  return { schedule, load, act, records: () => records, badge: (sessionId, at) => restartBadge(sessionId, restartIssues) || sessionBadge(sessionId, records, at || now()) };
}

module.exports = { renderBridgeCard, applyBridgeThreads, threadBlock, messageBody, describeMessage, collectRows, recordsFromStatus, sessionBadge,
  restartIssuesFromStatus, restartBadge,
  composerText, createBridgeThreadController };
