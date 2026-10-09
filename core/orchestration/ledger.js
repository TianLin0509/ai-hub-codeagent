'use strict';
// AI 编排模式的计划账本（纯函数，便于单测）。
// 账本是界面展示、中断恢复和编排员换班的唯一依据：编排员只能改计划部分，
// 工作段的通过与否只由交付工作流的结果（审核位判定）推进。
// 2026-10-06：用户只和编排员用自然语言对话。计划提交即生效，何时停下来问用户由编排员判断；
// Hub 只保留额度、反复故障、结项证据这几道硬闸，暂停后用户在输入框回话即解除（额度除外）。
const crypto = require('node:crypto');

const DEFAULT_SETTINGS = Object.freeze({ roundCap: 8, timeCapMin: 180, maxMembers: 3, stuckMin: 40 });
// 同一步骤里累计这么多次运行故障后，Hub 暂停并请编排员向用户说明。
const FAILURE_LIMIT = 4;
const PRESETS = ['development', 'filework', 'research', 'roundtable', 'custom'];
const PRESET_LABELS = { development: '开发交付', filework: '文件修改', research: '资料调研', roundtable: '方案圆桌', custom: '自定义' };
// 每段至少占用的轮数（与 countRounds 同口径）：有审核循环的模板按审核次数计，一次通过 = 1 轮、每次返工 +1；
// 线性模板每一步计 1 轮；custom 按计划里写的 steps。
const MIN_ROUNDS = { development: 1, filework: 1, research: 3, roundtable: 3 };
const SEGMENT_LABELS = {
  starting: '启动中', running: '进行中', rework: '返工中', paused: '已暂停', passed: '通过',
  completed: '已完成', cancelled: '已取消', failed: '启动失败', skipped: '已跳过',
};
const HALT_LABELS = {
  budget_rounds: '迭代额度用满', budget_time: '时长额度用满', no_progress: '连续两次没有新进展',
  need_decision: '编排员在等你回复', user_pause: '你已暂停', runtime_error: '运行故障，等待你处理',
  repeated_failure: '同一步骤反复故障',
};
const MAX_EVENTS = 80, MAX_SEEN = 400;

const clampInt = (value, min, max, fallback) => {
  const n = Math.round(Number(value));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};
function normalizeSettings(input = {}) {
  const s = input && typeof input === 'object' ? input : {};
  return {
    roundCap: clampInt(s.roundCap, 1, 30, DEFAULT_SETTINGS.roundCap),
    timeCapMin: clampInt(s.timeCapMin, 15, 24 * 60, DEFAULT_SETTINGS.timeCapMin),
    maxMembers: clampInt(s.maxMembers, 1, 3, DEFAULT_SETTINGS.maxMembers),
    stuckMin: clampInt(s.stuckMin, 5, 240, DEFAULT_SETTINGS.stuckMin),
  };
}

function create(meetingId, settings, now = Date.now()) {
  const s = normalizeSettings(settings);
  return {
    version: 1, meetingId, status: 'planning', halt: null, settings: s,
    budget: { roundsUsed: 0, roundCap: s.roundCap, activeMs: 0, timeCapMs: s.timeCapMin * 60000, grants: 0, lastTickAt: now },
    plan: null, roles: {}, segments: [], asks: [], reports: [],
    notices: [], seen: [], progressSeq: 0, lastWakeSeq: 0, wakesWithoutProgress: 0,
    events: [], createdAt: now, updatedAt: now,
  };
}

function event(ledger, text, now = Date.now()) {
  ledger.events.push({ at: now, text: String(text).slice(0, 400) });
  if (ledger.events.length > MAX_EVENTS) ledger.events.splice(0, ledger.events.length - MAX_EVENTS);
}
function bump(ledger) { ledger.progressSeq += 1; ledger.wakesWithoutProgress = 0; }

// ---- 计划 ----
const text = (value, max) => String(value == null ? '' : value).trim().slice(0, max);
function proposePlan(ledger, input = {}, now = Date.now()) {
  if (ledger.status === 'ended') throw new Error('编排已结束，用户恢复编排后才能提交计划');
  if (ledger.status === 'finished') ledger.status = 'running';
  const summary = text(input.summary, 4000);
  if (!summary) throw new Error('计划需要 summary：一段白话说明目标、队伍和步骤');
  const team = (Array.isArray(input.team) ? input.team : []).map(t => ({
    memberId: text(t && t.memberId, 40),
    role: text(t && t.role, 40), kind: text(t && t.kind, 20), model: text(t && t.model, 80),
    effort: text(t && t.effort, 20), tier: text(t && t.tier, 20), reason: text(t && t.reason, 300),
  })).filter(t => t.role);
  if (team.length > ledger.settings.maxMembers) throw new Error(`队伍最多 ${ledger.settings.maxMembers} 位成员（不含编排员）`);
  const segments = (Array.isArray(input.segments) ? input.segments : []).map(seg => {
    const preset = PRESETS.includes(seg && seg.preset) ? seg.preset : 'custom';
    const out = { name: text(seg && seg.name, 80), preset, goal: text(seg && seg.goal, 2000), acceptance: text(seg && seg.acceptance, 2000) };
    if (preset === 'custom' && seg && seg.steps != null) out.steps = clampInt(seg.steps, 1, 6, 1);
    return out;
  }).filter(seg => seg.name);
  if (!segments.length) throw new Error('计划至少要有一段工作（segments），每段写清 name、preset、goal、acceptance');
  if (segments.length > 8) throw new Error('计划最多 8 段工作');
  const missing = segments.filter(seg => !seg.acceptance).map(seg => seg.name);
  if (missing.length) throw new Error('每段工作都要写验收标准（acceptance）：' + missing.join('、'));
  if(new Set(segments.map(s=>s.name)).size!==segments.length)throw Error('计划工作段名称必须唯一');
  for(const seg of segments)seg.id=crypto.createHash('sha256').update(JSON.stringify([seg.name,seg.preset,seg.goal,seg.acceptance])).digest('hex').slice(0,16);
  const version = (ledger.plan?.version || 0) + 1;
  ledger.plan = { version, summary, team, segments, budget: input.budget || null, estimateRounds: clampInt(input.estimateRounds, 0, 99, 0), proposedAt: now };
  event(ledger, `编排员提交计划 v${version}`, now);
  activatePlan(ledger, now);
  return ledger.plan;
}
// 计划提交即生效：额度与角色随计划更新；暂停中的群保持暂停，等用户回话。
function activatePlan(ledger, now = Date.now()) {
  const plan = ledger.plan;
  if (plan.budget) { ledger.budget.roundCap = plan.budget.roundCap; ledger.budget.timeCapMs = plan.budget.timeCapMin * 60000; }
  for (const member of plan.team || []) if (member.memberId) ledger.roles[member.memberId] = { role: member.role, kind: member.kind };
  if (['planning', 'awaiting_confirm'].includes(ledger.status)) ledger.status = 'running';
  // 额度暂停中按用户新说的额度改了计划、额度已够：随计划恢复，不必再追加。
  if (ledger.status === 'halted' && /^budget_/.test(ledger.halt?.reason || '') && withinBudget(ledger)) {
    ledger.status = 'running'; ledger.halt = null;
    event(ledger, '新计划的额度已够，额度暂停解除', now);
  }
  ledger.budget.lastTickAt = now;
  bump(ledger);
}
function withinBudget(ledger) { return ledger.budget.roundsUsed < ledger.budget.roundCap && ledger.budget.activeMs < ledger.budget.timeCapMs; }
// 旧账本（计划须经用户确认的年代）：待确认的计划直接生效。
function migrate(ledger, now = Date.now()) {
  if (!ledger) return false;
  let changed = false;
  if (ledger.settings && 'requireConfirm' in ledger.settings) { delete ledger.settings.requireConfirm; changed = true; }
  if (ledger.status === 'awaiting_confirm') {
    if (ledger.plan) activatePlan(ledger, now); else ledger.status = 'planning';
    event(ledger, '计划改为提交即生效', now);
    changed = true;
  }
  // 暂停中提交、尚未确认的旧版计划：角色与额度随迁移生效（暂停状态保持）。
  if (ledger.plan && 'confirmedVersion' in ledger.plan) {
    const pending = ledger.plan.confirmedVersion !== ledger.plan.version;
    delete ledger.plan.confirmedVersion; delete ledger.plan.confirmedAt;
    if (pending) activatePlan(ledger, now);
    changed = true;
  }
  return changed;
}
// 计划额度核算：未完成的计划段至少要多少轮，对比可用的剩余轮数。只提示不拦截，额度不够时编排员向用户说明。
function segmentMinRounds(seg) {
  if (!seg) return 0;
  if (seg.preset === 'custom') return clampInt(seg.steps, 1, 6, 1);
  return MIN_ROUNDS[seg.preset] || 1;
}
function segmentDone(ledger, planned) {
  return ledger.segments.some(s => (s.planSegmentId ? s.planSegmentId === planned.id : s.name === planned.name)
    && ['passed', 'completed'].includes(s.status) && s.verdict?.decision !== '需返工');
}
function budgetCheck(ledger) {
  const plan = ledger.plan;
  if (!plan) return null;
  const pending = plan.segments.filter(seg => !segmentDone(ledger, seg));
  const minRounds = pending.reduce((sum, seg) => sum + segmentMinRounds(seg), 0);
  const cap = plan.budget?.roundCap || ledger.budget.roundCap;
  const available = Math.max(0, cap - ledger.budget.roundsUsed);
  const ok = minRounds <= available;
  const detail = pending.map(seg => `${seg.name}（${PRESET_LABELS[seg.preset] || seg.preset}）${segmentMinRounds(seg)} 轮`).join('、');
  const tight = ok && minRounds === available && pending.some(seg => MIN_ROUNDS[seg.preset] === 1);
  const message = `Hub 核算：剩余 ${pending.length} 段至少 ${minRounds} 轮${detail ? '（' + detail + '）' : ''}，额度剩 ${available} 轮`
    + (ok ? (tight ? '，没有返工余量。' : '。') : `，不够；建议额度至少 ${ledger.budget.roundsUsed + minRounds} 轮，或缩减计划。`);
  return { minRounds, available, ok, text: message };
}
// 能否派活：未暂停、未结束。查询类工具不受影响；派工还要匹配当前计划（见 service.startWorkflow）。
function canDispatch(ledger) {
  if (ledger.status === 'ended') return { ok: false, reason: '编排已结束；用户恢复编排前不能派活' };
  if (ledger.status === 'finished') return { ok: false, reason: '任务已结项；用户提出新要求后再提交新计划' };
  if (ledger.status === 'halted') {
    const budget = /^budget_/.test(ledger.halt?.reason || '');
    return { ok: false, reason: `已暂停（${HALT_LABELS[ledger.halt?.reason] || '等待用户'}）：` + (budget
      ? '向用户说明并推荐追加额度，他同意后用 orch_grant_budget 引用他的原话追加'
      : '向用户说明现状与建议；他在输入框回话后暂停自动解除') };
  }
  return { ok: true };
}

// ---- 工作段 ----
function newId(prefix) { return prefix + '-' + crypto.randomBytes(5).toString('hex'); }
function startSegment(ledger, seg, now = Date.now()) {
  const record = {
    id: newId('seg'), runId: null, name: text(seg.name, 80) || PRESET_LABELS[seg.preset] || '工作段',
    preset: seg.preset, goal: text(seg.goal, 4000), acceptance: text(seg.acceptance, 2000),
    members: seg.members || [], status: 'starting', rounds: 0, steps: 0, verdict: null, verdictPath: '',
    planSegmentId: seg.planSegmentId || '',
    error: '', missing: [], stuckNotified: '', startedAt: now, endedAt: null,
  };
  ledger.segments.push(record);
  event(ledger, `启动工作段「${record.name}」（${PRESET_LABELS[record.preset] || record.preset}）`, now);
  bump(ledger);
  return record;
}
function activeSegment(ledger) {
  return [...ledger.segments].reverse().find(s => ['starting', 'running', 'rework', 'paused'].includes(s.status)) || null;
}

// 计次规则：有审核循环（某步 after=review，如开发交付、文件修改）的按「审核」计，一轮实现→审核 = 1；
// 其余串行模板每完成一步计 1。
function hasReview(run) { return run?.kind === 'file' || (Array.isArray(run?.stages) && run.stages.some(s => s?.after === 'review')); }
function countRounds(run) {
  if (!run || !Array.isArray(run.steps)) return 0;
  const review = hasReview(run);
  return run.steps.filter(step => {
    const stage = run.stages?.[step.index];
    if (review && stage?.after !== 'review') return false;
    const members = Array.isArray(step.members) ? step.members : [];
    return members.length > 0 && members.every(m => step.deliveries && step.deliveries[m]);
  }).length;
}
// 收口结论写在交付正文里：「收口结论：通过 / 需返工 / 暂不能判断」。审核循环以交付状态为准（需返工文件 = 需返工）。
function parseDecision(body) {
  const m = String(body || '').match(/收口结论\s*[:：]\s*\**\s*(通过|需返工|暂不能判断)/);
  return m ? m[1] : '';
}
function reviewVerdict(run, readText = null) {
  if (!run || !Array.isArray(run.steps)) return null;
  const review = hasReview(run);
  for (let i = run.steps.length - 1; i >= 0; i -= 1) {
    const step = run.steps[i];
    const stage = run.stages?.[step.index];
    const lead = step.members?.[0];
    const delivery = lead && step.deliveries?.[lead];
    if (!delivery) continue;
    if (review ? stage?.after === 'review' : (stage?.after === 'end' || i === run.steps.length - 1)) {
      let decision = delivery.outcome === 'rework' ? '需返工' : '';
      if (!decision && readText && delivery.path) { try { decision = parseDecision(readText(delivery.path)); } catch {} }
      if (!decision && review && delivery.outcome === 'ready') decision = '通过';
      return { outcome: delivery.outcome, decision, path: delivery.path || '', memberId: lead, stage: stage?.name || '' };
    }
  }
  return null;
}
function decisionText(decision) {
  if (decision === '通过') return '收口结论：通过';
  if (decision === '需返工') return '收口结论：需返工（本段不算通过，请按收口意见安排返工，或向用户说明）';
  if (decision === '暂不能判断') return '收口结论：暂不能判断（按收口文件说明缺口，必要时请用户决定）';
  return '收口成员没有写明「收口结论」，请读最后交付，自行核对是否满足验收';
}

// 用交付工作流的 run.json 推进账本里对应的段；返回需要告诉编排员的通知。
// readText(path) 读最后交付正文以提取收口结论；不传则只看交付状态。
function applyRun(ledger, run, now = Date.now(), { readText = null } = {}) {
  const notices = [];
  if (!run || !run.id) return notices;
  const seg = ledger.segments.find(s => s.runId === run.id);
  if (!seg) return notices;
  const before = JSON.stringify([seg.status, seg.rounds, seg.steps, seg.error, seg.verdict?.outcome, seg.verdict?.decision, seg.verdictPath]);
  const prevRounds = seg.rounds || 0;
  const review = hasReview(run);
  seg.steps = Array.isArray(run.steps) ? run.steps.length : 0;
  seg.rounds = countRounds(run);
  const verdict = reviewVerdict(run, readText);
  const last = run.steps?.at(-1);
  seg.missing = last ? (last.members || []).filter(m => !last.deliveries?.[m]) : [];
  if (verdict) { seg.verdict = verdict; seg.verdictPath = verdict.path; }
  let status = seg.status;
  if (run.status === 'done') status = review ? 'passed' : 'completed';
  else if (run.status === 'cancelled') status = 'cancelled';
  else if (run.status === 'paused') status = 'paused';
  else if (run.status === 'running') status = verdict?.outcome === 'rework' && review && seg.rounds > 0 ? 'rework' : 'running';
  seg.error = run.status === 'paused' ? text(run.error, 600) : '';
  const prevStatus = seg.status;
  if (status === 'paused' && prevStatus !== 'paused') seg.pauses = (seg.pauses || 0) + 1;
  seg.status = status;
  if (['passed', 'completed', 'cancelled'].includes(status) && !seg.endedAt) seg.endedAt = now;
  ledger.budget.roundsUsed = ledger.segments.reduce((sum, s) => sum + (s.rounds || 0), 0);
  const after = JSON.stringify([seg.status, seg.rounds, seg.steps, seg.error, seg.verdict?.outcome, seg.verdict?.decision, seg.verdictPath]);
  if (before === after) return notices;
  bump(ledger);
  const key = `${seg.id}:${seg.rounds}:${status}:${seg.verdict?.outcome || ''}:${status === 'paused' ? 'p' + (seg.pauses || 0) : ''}`;
  if (status !== prevStatus || (status === 'rework' && seg.rounds !== prevRounds)) {
    if (status === 'passed') notices.push({ key, text: `工作段「${seg.name}」审核通过。审核结论：${seg.verdictPath}` });
    else if (status === 'completed') notices.push({ key, text: `工作段「${seg.name}」已完成，${decisionText(seg.verdict?.decision)}。最后交付：${seg.verdictPath}` });
    else if (status === 'rework') notices.push({ key, text: `工作段「${seg.name}」审核判定需返工（已用 ${seg.rounds} 轮），工作流已自动开始下一轮实现。审核结论：${seg.verdictPath}` });
    else if (status === 'paused') notices.push({ key, text: `工作段「${seg.name}」已暂停：${seg.error || '原因未知'}。由你判断怎么处理：orch_control_workflow 的 continue（续跑）、remind（提醒未交付成员）、skip（跳过某位成员）、cancel（取消后改计划重派），成员会话出错可先 orch_restart_member 再续跑。` });
    else if (status === 'cancelled') notices.push({ key, text: `工作段「${seg.name}」已取消。` });
  }
  if (notices.length) event(ledger, notices.map(n => n.text).join('；'), now);
  return notices;
}

// ---- 预算 ----
function tick(ledger, now = Date.now(), { working = false } = {}) {
  const delta = Math.max(0, Math.min(now - (ledger.budget.lastTickAt || now), 60000));
  ledger.budget.lastTickAt = now;
  if (ledger.status === 'running' && working) ledger.budget.activeMs += delta;
}
function overBudget(ledger) {
  if (ledger.status !== 'running') return null;
  if (ledger.budget.roundsUsed >= ledger.budget.roundCap) return 'budget_rounds';
  if (ledger.budget.activeMs >= ledger.budget.timeCapMs) return 'budget_time';
  return null;
}
function halt(ledger, reason, message = '', now = Date.now()) {
  ledger.status = 'halted';
  ledger.halt = { reason, at: now, message: text(message, 1000), reported: false };
  event(ledger, `暂停：${HALT_LABELS[reason] || reason}${message ? '（' + text(message, 200) + '）' : ''}`, now);
}
function grant(ledger, { rounds = 0, minutes = 0 } = {}, now = Date.now()) {
  const r = clampInt(rounds, 0, 30, 0), m = clampInt(minutes, 0, 24 * 60, 0);
  if (r) ledger.budget.roundCap = Math.max(ledger.budget.roundCap, ledger.budget.roundsUsed) + r;
  if (m) ledger.budget.timeCapMs = Math.max(ledger.budget.timeCapMs, ledger.budget.activeMs) + m * 60000;
  // 追加后的额度就是用户最新的意思：之后改计划沿用它，不被早先说的上限拉回去。
  if (ledger.budgetIntent && (r || m)) ledger.budgetIntent = { ...ledger.budgetIntent, ...(r ? { roundCap: ledger.budget.roundCap } : {}), ...(m ? { timeCapMin: ledger.budget.timeCapMs / 60000 } : {}) };
  ledger.budget.grants += 1;
  // 追加额度只解除额度暂停；用户暂停、等他回话等其他暂停不受影响。不带数额 = 恢复编排，解除任何暂停。
  const wasHalted = ledger.status === 'halted' && (!(r || m) || /^budget_/.test(ledger.halt?.reason || ''));
  if (wasHalted) { ledger.status = 'running'; ledger.halt = null; }
  ledger.wakesWithoutProgress = 0;
  ledger.budget.lastTickAt = now;
  event(ledger, `用户追加额度：${r ? r + ' 轮' : ''}${r && m ? '、' : ''}${m ? m + ' 分钟' : ''}${!r && !m ? '恢复编排' : ''}`, now);
  bump(ledger);
  return wasHalted;
}
function resume(ledger, now = Date.now()) { return grant(ledger, {}, now); }

// ---- 通知队列（不丢不重：queued → sending → sent；重启时 sending 标为可能已送达）----
function enqueue(ledger, key, body, now = Date.now()) {
  const k = String(key || '');
  if (k && ledger.seen.includes(k)) return false;
  if (k) { ledger.seen.push(k); if (ledger.seen.length > MAX_SEEN) ledger.seen.splice(0, ledger.seen.length - MAX_SEEN); }
  ledger.notices.push({ id: newId('n'), key: k, text: text(body, 2000), at: now, state: 'queued', attempts: 0 });
  return true;
}
function pendingNotices(ledger) { return ledger.notices.filter(n => n.state === 'queued' || n.state === 'uncertain'); }
function markSending(ledger, ids, now = Date.now()) {
  for (const n of ledger.notices) if (ids.includes(n.id)) { n.state = 'sending'; n.attempts += 1; n.sentAt = now; }
}
function markSent(ledger, ids) {
  ledger.notices = ledger.notices.filter(n => !ids.includes(n.id));
}
function markRetry(ledger, ids, now = Date.now()) {
  for (const n of ledger.notices) if (ids.includes(n.id)) n.state = n.attempts >= 3 ? 'failed' : 'queued';
  const failed = ledger.notices.filter(n => n.state === 'failed');
  if (failed.length) {
    event(ledger, `有 ${failed.length} 条通知连续 3 次没送达编排员，已放弃：` + failed.map(n => n.text.slice(0, 60)).join('；'), now);
    ledger.notices = ledger.notices.filter(n => n.state !== 'failed');
  }
}
// Hub 重启后，发送中但没有回执的通知可能已送达：不静默重发，标注后随下一批说明。
function recoverAfterRestart(ledger) {
  let count = 0;
  for (const n of ledger.notices) if (n.state === 'sending') { n.state = 'uncertain'; count += 1; }
  return count;
}

// 自动唤醒（不含用户亲自发言）前调用：两次唤醒之间账本没前进 → 计一次「没进展」。
function noteWake(ledger) {
  if (ledger.progressSeq === ledger.lastWakeSeq) ledger.wakesWithoutProgress += 1;
  else ledger.wakesWithoutProgress = 0;
  ledger.lastWakeSeq = ledger.progressSeq;
  return ledger.wakesWithoutProgress;
}
function noteUserMessage(ledger) { ledger.wakesWithoutProgress = 0; ledger.lastWakeSeq = ledger.progressSeq; }

// ---- 汇报与结项 ----
function finalGate(ledger) {
  if(!ledger.plan?.segments?.length)return {ok:false,reason:'缺少完整计划，不能结项'};
  const missing=ledger.plan.segments.filter(p=>!ledger.segments.some(s=>(s.planSegmentId===p.id || (!s.planSegmentId && s.name===p.name && s.preset===p.preset && s.goal===p.goal && s.acceptance===p.acceptance)) && ['passed','completed'].includes(s.status) && s.verdictPath && s.verdict?.decision!=='需返工'));
  if(missing.length)return {ok:false,reason:'计划工作段未完成或缺审核证据：'+missing.map(s=>s.name).join('、')};
  if (!ledger.segments.length) return { ok: false, reason: '还没有任何工作段，不能结项' };
  const open = ledger.segments.filter(s => !['passed', 'completed', 'cancelled', 'skipped', 'failed'].includes(s.status));
  if (open.length) return { ok: false, reason: '还有工作段没结束：' + open.map(s => `「${s.name}」${SEGMENT_LABELS[s.status] || s.status}`).join('、') };
  const done = ledger.segments.filter(s => ['passed', 'completed'].includes(s.status));
  if (!done.length) return { ok: false, reason: '没有任何工作段通过审核，不能报完成；请用 need_decision 向用户说明' };
  const noEvidence = done.filter(s => !s.verdictPath);
  if (noEvidence.length) return { ok: false, reason: '以下工作段缺审核结论文件：' + noEvidence.map(s => s.name).join('、') };
  return { ok: true };
}
function addReport(ledger, kind, summary, now = Date.now()) {
  const report = { at: now, kind, summary: text(summary, 6000) };
  ledger.reports.push(report);
  if (ledger.reports.length > 30) ledger.reports.splice(0, ledger.reports.length - 30);
  if (ledger.status === 'halted' && ledger.halt) ledger.halt.reported = true;
  event(ledger, `编排员汇报（${kind}）`, now);
  return report;
}

// ---- 展示 ----
function fmtMin(ms) { return Math.round((ms || 0) / 60000); }
function progressRows(ledger) {
  return ledger.segments.map(s => ({
    id: s.id, name: s.name, preset: s.preset, presetLabel: PRESET_LABELS[s.preset] || s.preset,
    status: s.status, statusLabel: SEGMENT_LABELS[s.status] || s.status, rounds: s.rounds,
    members: s.members, verdict: s.verdict?.outcome || '', decision: s.verdict?.decision || '', verdictPath: s.verdictPath || '', error: s.error || '',
    missing: s.missing || [],
  }));
}
function view(ledger) {
  if (!ledger) return null;
  const pendingAsks = ledger.asks.filter(a => a.status === 'pending');
  return {
    meetingId: ledger.meetingId, status: ledger.status,
    halt: ledger.halt ? { ...ledger.halt, label: HALT_LABELS[ledger.halt.reason] || ledger.halt.reason } : null,
    settings: ledger.settings,
    budget: { roundsUsed: ledger.budget.roundsUsed, roundCap: ledger.budget.roundCap,
      minutesUsed: fmtMin(ledger.budget.activeMs), minutesCap: fmtMin(ledger.budget.timeCapMs) },
    plan: ledger.plan ? { version: ledger.plan.version, summary: ledger.plan.summary,
      segments: ledger.plan.segments, team: ledger.plan.team, budget: ledger.plan.budget, budgetCheck: budgetCheck(ledger) } : null,
    roles: ledger.roles, segments: progressRows(ledger),
    asks: ledger.asks.slice(-10).map(a => ({ id: a.id, memberId: a.memberId, status: a.status, answerPath: a.answerPath || '' })),
    pendingAsks: pendingAsks.length,
    lastReport: ledger.reports.at(-1) || null,
    events: ledger.events.slice(-12),
    updatedAt: ledger.updatedAt,
  };
}
function cell(value) { return String(value == null ? '' : value).replace(/\|/g, '/').replace(/\r?\n/g, ' '); }
function markdownTable(ledger) {
  const rows = progressRows(ledger);
  if (!rows.length) return '（还没有工作段）';
  return ['| 段 | 模板 | 负责人 | 状态 | 已用轮次 | 审核结论 | 备注 |', '|---|---|---|---|---|---|---|',
    ...rows.map(r => `| ${cell(r.name)} | ${cell(r.presetLabel)} | ${cell((r.members || []).join(' / '))} | ${cell(r.statusLabel)} | ${r.rounds} | ${cell(r.verdictPath ? `${r.decision || '未写结论'}：${r.verdictPath}` : '—')} | ${cell(r.error || (r.missing.length ? '待交付：' + r.missing.join('、') : ''))} |`)].join('\n');
}
function renderMarkdown(ledger) {
  const v = view(ledger);
  const lines = [`# 计划账本`, '', `- 状态：${v.status}${v.halt ? '（' + v.halt.label + '）' : ''}`,
    `- 额度：工作流 ${v.budget.roundsUsed}/${v.budget.roundCap} 轮 · ${v.budget.minutesUsed}/${v.budget.minutesCap} 分钟（每完成一步计 1 轮，审核循环按审核次数计）`, ''];
  if (ledger.plan) lines.push(`## 计划 v${ledger.plan.version}`, '', ledger.plan.summary, '', ...(v.plan.budgetCheck ? [`> ${v.plan.budgetCheck.text}`, ''] : []));
  lines.push('## 工作段', '', markdownTable(ledger), '');
  if (Object.keys(ledger.roles).length) lines.push('## 队伍', '', ...Object.entries(ledger.roles).map(([id, r]) => `- ${id}：${r.role}（${r.label || r.kind || ''}）`), '');
  if (ledger.asks.length) lines.push('## 单独提问', '', ...ledger.asks.slice(-10).map(a => `- ${a.memberId}：${a.status === 'answered' ? '已回答 ' + a.answerPath : '待回答'}`), '');
  lines.push('## 最近事件', '', ...ledger.events.slice(-15).map(e => `- ${new Date(e.at).toISOString()} ${e.text}`), '');
  return lines.join('\n');
}

module.exports = {
  DEFAULT_SETTINGS, PRESETS, PRESET_LABELS, SEGMENT_LABELS, HALT_LABELS, MIN_ROUNDS,
  FAILURE_LIMIT, normalizeSettings, create, migrate, event, proposePlan, canDispatch, startSegment, activeSegment,
  segmentMinRounds, budgetCheck, hasReview, parseDecision, countRounds, reviewVerdict, applyRun, tick, overBudget, halt, grant, resume,
  enqueue, pendingNotices, markSending, markSent, markRetry, recoverAfterRestart, noteWake, noteUserMessage,
  finalGate, addReport, progressRows, view, markdownTable, renderMarkdown, newId,
};
