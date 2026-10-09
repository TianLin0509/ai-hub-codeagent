'use strict';

// Main owns this snapshot. Renderer consumers may project it, never vote on it.
const BACKEND = 'codex-app-server';
const TERMINAL = new Set(['completed', 'interrupted', 'failed']);
// Codex 默认跑 PTY（2026-09-25），kind 为 codex 不再意味着 App Server。
// 判据：显式的后端；或者没有声明后端、却带着 App Server 快照的旧记录。
// PTY 会话总是带 agentRuntime:'pty' 且 nativeRuntime 为空，不会被误认。
function isCodexSession(session) {
  if (!session) return false;
  if (session.runtimeBackend === BACKEND) return true;
  return !session.runtimeBackend && session.agentRuntime !== 'pty' && !!session.nativeRuntime
    && (session.kind === 'codex' || session.kind === 'codex-resume');
}
function isNativeSession(session) { return isCodexSession(session) || session?.runtimeBackend === 'acp'; }
function createNativeRuntime(epoch = 1, label = 'Codex') {
  return { state:'unknown', connection:'connecting', epoch, revision:0,
    threadId:null, turnId:null, startedAt:0, completedAt:0, observedAt:0,
    requests:[], endedTurns:[], waitingFlags:[], reason:'正在连接 '+label, submission:null };
}
function isUnstartedRuntime(r) {
  return !!r && r.lazyStart === true && r.connection === 'unstarted'
    && !r.threadId && !r.turnId && !r.submission && !r.startedAt && !(r.endedTurns || []).length;
}
function requestSummary(request, label = 'Codex') {
  const p = request && request.params || {};
  return (p.questions || []).map(q => q.question).filter(Boolean).join('\n')
    || p.reason || (Array.isArray(p.command) ? p.command.join(' ') : p.command)
    || p.message || label+' 等待你确认';
}
function nativeRuntimeTruth(session) {
  const r = session && session.nativeRuntime;
  const source = session?.runtimeBackend === 'acp' ? 'acp' : BACKEND;
  const label = require('./native-ui-labels').nativeUiLabel(session);
  if (session && session.status === 'dormant') {
    return { ...r, state:'dormant', source, confidence:'authoritative', expiresAt:0, sequence:r?.revision,
      turnId:r && r.turnId || null, reason:'session-suspended' };
  }
  if (!r) return { state:'unknown', source, confidence:'none', expiresAt:0,
    reason:'unmanaged', evidence:'旧会话尚未接管，请在原进程结束后恢复', requests:[] };
  if (isUnstartedRuntime(r)) return { ...r, state:'idle', source, confidence:'authoritative',
    expiresAt:0, sequence:r.revision, evidence:'尚未开始，收到消息后启动' };
  const connected = r.connection === 'connected';
  const state = !connected && !TERMINAL.has(r.state) ? 'unknown' : r.state;
  return { ...r, state, source, confidence:connected ? 'authoritative' : 'none',
    expiresAt:0, sequence:r.revision,
    evidence:state === 'waiting' ? (r.requests || []).map(request=>requestSummary(request,label)).join('\n') || label+' 正在等待操作'
      : r.reason || null };
}
function nativeUnfinished(session) {
  const r = nativeRuntimeTruth(session);
  return r.state === 'running' || r.state === 'waiting';
}
// File handoff consumers use the same authoritative execution snapshot. A
// transcript's final text is deliberately not evidence that execution ended.
function nativeTurnHasEnded(session, { threadId, turnId } = {}) {
  const r = nativeRuntimeTruth(session);
  if (!threadId || !turnId || r.threadId !== threadId || r.connection !== 'connected'
      || (!TERMINAL.has(r.state) && r.state !== 'idle')
      || ['submitting', 'unknown'].includes(r.submission?.status)) return false;
  return (r.turnId === turnId && TERMINAL.has(r.state)) || (r.endedTurns || []).includes(turnId);
}
function acceptNativeSnapshot(local, incoming) {
  const next = incoming && incoming.nativeRuntime;
  const old = local && local.nativeRuntime;
  if (!next || !local || incoming.id !== local.id) return false;
  if (old && (next.epoch < old.epoch
      || (next.epoch === old.epoch && next.revision < old.revision))) return false;
  local.runtimeBackend = incoming.runtimeBackend || BACKEND;
  if (incoming.runtimeBackend === 'acp') {
    local.acpSid = incoming.acpSid;
    local.acpProfileId = incoming.acpProfileId;
    local.acpCapabilities = incoming.acpCapabilities;
    local.acpConfigOptions = incoming.acpConfigOptions;
  }
  local.nativeRuntime = next;
  if (incoming.codexSharedControl) local.codexSharedControl = incoming.codexSharedControl;
  else if (local.codexSharedControl) delete local.codexSharedControl;
  if (incoming.nativeSharedControl) local.nativeSharedControl = incoming.nativeSharedControl;
  else if (local.nativeSharedControl) delete local.nativeSharedControl;
  local.nativeThreadChoices = incoming.nativeThreadChoices || [];
  local.nativeActionError = incoming.nativeActionError || null;
  local.codexApprovalPolicy = incoming.codexApprovalPolicy;
  local.codexSandbox = incoming.codexSandbox;
  local.status = incoming.status;
  // Compatibility fields are projections only, never additional evidence.
  local.runStartedAt = next.startedAt || null;
  local.connectionIssue = null;
  local.gcWorking = false;
  local.cardWorkingSince = null;
  local._agentWorking = null;
  local._runSource = null;
  local.needsUserInput = next.connection === 'connected' && next.state === 'waiting';
  local.isWaiting = local.needsUserInput;
  local.waitingText = local.needsUserInput ? nativeRuntimeTruth(local).evidence : null;
  return true;
}
function persistNativeRuntime(data) {
  const r = data && data.nativeRuntime;
  if (!isNativeSession(data) || !r) return null;
  if (isUnstartedRuntime(r)) return { ...r, requests:[], waitingFlags:[] };
  // Requests belong to the live transport; never restore approval buttons.
  return { ...r, connection:'disconnected', requests:[], waitingFlags:[],
    state:TERMINAL.has(r.state) ? r.state : 'unknown', lastKnownState:r.state,
    reason:data.runtimeBackend==='acp'?'Hub 已重新启动，等待核对原生 Harness 会话':'Hub 已重新启动，等待核对 Codex 会话' };
}
function same(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
function reduceNativeRuntime(previous, event, label = 'Codex') {
  const p = previous || createNativeRuntime(1,label);
  if (!event || (event.epoch != null && event.epoch !== p.epoch && event.type !== 'connect')) return p;
  const now = event.at || Date.now();
  let n = { ...p, requests:p.requests.slice(), waitingFlags:p.waitingFlags.slice(),
    endedTurns:p.endedTurns.slice() };
  const remember = id => {
    if (id && !n.endedTurns.includes(id)) n.endedTurns = [...n.endedTurns, id].slice(-128);
  };
  const activeState = () => n.requests.some(r => r.method !== 'item/tool/requestUserInput' || r.params?.isBlocking !== false)
    || n.waitingFlags.length ? 'waiting' : 'running';
  const start = turn => {
    if (!turn || !turn.id || n.endedTurns.includes(turn.id)) return false;
    if (n.turnId && n.turnId !== turn.id && !TERMINAL.has(n.state) && n.state !== 'idle' && n.state !== 'unknown') {
      n.state = 'unknown'; n.reason = '收到不同的活跃轮次，需要核对'; return false;
    }
    if (n.turnId !== turn.id) {
      if (n.cancellation) n.cancellation = null;
      n.requests = []; n.waitingFlags = []; n.completedAt = 0;
      n.startedAt = Number.isFinite(turn.startedAt) ? turn.startedAt * 1000 : now;
    }
    n.turnId = turn.id; n.state = activeState(); n.reason = null;
    return true;
  };
  const finish = turn => {
    if (!turn || !turn.id || !TERMINAL.has(turn.status)) return false;
    if (n.endedTurns.includes(turn.id)) return false;
    if (n.turnId && n.turnId !== turn.id) return false;
    n.turnId = turn.id; n.state = turn.status;
    if (n.cancellation) n.cancellation = null;
    n.completedAt = Number.isFinite(turn.completedAt) ? turn.completedAt * 1000 : now;
    n.requests = []; n.waitingFlags = [];
    n.reason = turn.error && turn.error.message || null;
    remember(turn.id);
    return true;
  };
  if (event.type === 'fresh-thread') {
    n = { ...createNativeRuntime(p.epoch), lazyStart:p.lazyStart,
      ...(p.sqliteHome ? {sqliteHome:p.sqliteHome} : {}),
      replacedThreadId:p.threadId || event.previousThreadId || null };
  } else if (event.type === 'connect') {
    if (event.epoch < p.epoch) return p;
    n.epoch = event.epoch; n.connection = 'connecting';
    n.requests = []; n.waitingFlags = [];
    n.reason = '正在核对 '+label+' 会话';
    if (!TERMINAL.has(n.state)) n.state = 'unknown';
  } else if (event.type === 'disconnect') {
    if (n.cancellation) n.cancellation = { ...n.cancellation, status:'unknown' };
    n.connection = 'disconnected';
    n.reason = event.reason || label+' 连接已断开，状态待核对';
    if (!TERMINAL.has(n.state)) n.state = 'unknown';
    n.requests = []; n.waitingFlags = [];
  } else if (event.type === 'history-storage') {
    n.sqliteHome = event.sqliteHome;
  } else if (event.type === 'submission') {
    n.submission = event.submission;
  } else if (event.type === 'empty-recovery') {
    n.emptyRecovery = event.recovery;
  } else if (event.type === 'configuration') {
    n.configurationError = event.error || null;
    if (['plan', 'default'].includes(event.collaborationMode)) n.collaborationMode = event.collaborationMode;
  } else if (event.type === 'snapshot') {
    const thread = event.thread;
    if (!thread || !thread.id || (n.threadId && thread.id !== n.threadId)) return p;
    n.threadId = thread.id;
    n.connection = 'connected';
    n.reason = null;
    const turns = thread.turns || [];
    const last = turns[turns.length - 1];
    const status = thread.status || {};
    if (last && last.status === 'inProgress') {
      if (status.type === 'active') start(last);
      else {
        n.turnId = last.id; n.state = 'unknown';
        n.reason = '历史轮次尚无终态，当前运行实例未确认执行';
      }
    } else if (last && TERMINAL.has(last.status)) {
      // A snapshot response may race a newly started turn; never end that turn.
      if (TERMINAL.has(n.state) && n.turnId !== last.id) n.turnId = null;
      if (!n.turnId || n.turnId === last.id) finish(last);
    }
    if (status.type === 'systemError') {
      n.state = 'unknown'; n.reason = label+' 服务端状态异常';
    } else if (status.type === 'notLoaded') {
      if (!TERMINAL.has(n.state)) n.state = 'unknown';
      n.reason = label+' 会话尚未加载';
    } else if (status.type === 'idle' && !n.turnId) {
      n.state = 'idle';
    } else if (status.type === 'active') {
      n.waitingFlags = status.activeFlags || [];
      if (n.turnId && !TERMINAL.has(n.state)) n.state = activeState();
      else { n.state = 'unknown'; n.reason = '活跃轮次身份待核对'; }
    }
  } else {
    if (event.threadId !== n.threadId || n.connection !== 'connected') return p;
    if (event.type === 'cancelling') {
      if (event.turnId !== n.turnId || TERMINAL.has(n.state)) return p;
      n.cancellation = { turnId:event.turnId, status:'pending', requestedAt:now, deadlineAt:event.deadlineAt,
        requests:n.requests,waitingFlags:n.waitingFlags };
      n.requests = []; n.waitingFlags = [];
    } else if (event.type === 'cancel-unknown') {
      if (event.turnId !== n.turnId || !n.cancellation || TERMINAL.has(n.state)) return p;
      n.cancellation = {...n.cancellation,status:'unknown'};
      n.state = 'unknown'; n.reason = event.reason;
    } else if (event.type === 'cancel-rejected') {
      if (event.turnId !== n.turnId || !n.cancellation || TERMINAL.has(n.state)) return p;
      n.requests = n.cancellation.requests || []; n.waitingFlags = n.cancellation.waitingFlags || [];
      n.state = activeState();
      n.cancellation = null; n.reason = event.reason;
    } else if (event.type === 'started') start(event.turn);
    else if (event.type === 'completed') finish(event.turn);
    else if (event.type === 'status') {
      const status = event.status || {};
      if (status.type === 'active' && n.turnId && !TERMINAL.has(n.state)) {
        n.waitingFlags = status.activeFlags || [];
        // Thread activity lacks a turn ID. Recover uncertainty through a
        // matching turn event or an authoritative thread/read snapshot.
        if (n.state !== 'unknown') { n.state = activeState(); n.reason = null; }
      } else if (status.type === 'systemError' || status.type === 'notLoaded') {
        if (!TERMINAL.has(n.state)) n.state = 'unknown';
        n.reason = status.type === 'systemError' ? label+' 服务端状态异常' : label+' 会话未加载';
      } else if (status.type === 'idle' && !n.turnId) {
        n.state = 'idle'; n.reason = null;
      }
      // Thread idle is not a turn outcome. Completion only comes from the turn.
    } else if (event.type === 'request') {
      const request = event.request;
      const turnId = request && request.params && request.params.turnId;
      if (!request || request.id == null || !n.turnId || TERMINAL.has(n.state) || n.cancellation
          || (request.params?.threadId && request.params.threadId !== n.threadId)
          || (turnId && turnId !== n.turnId)) return p;
      if (!n.requests.some(r => r.id === request.id)) n.requests.push(request);
      // Interaction bookkeeping cannot clear a lifecycle/identity error.
      if (n.state !== 'unknown') n.state = activeState();
    } else if (event.type === 'resolved') {
      const request = n.requests.find(r => r.id === event.requestId);
      if (!request || (request.params?.turnId && request.params.turnId !== n.turnId)
          || (request.params?.threadId && request.params.threadId !== n.threadId)) return p;
      n.requests = n.requests.filter(r => r !== request);
      if (n.state !== 'unknown' && !TERMINAL.has(n.state) && n.turnId) n.state = activeState();
    } else return p;
  }
  // Cancellation is an unfinished execution phase. Keep existing running and
  // group handoff contracts, but never let a tail update reopen waiting UI.
  if (n.cancellation?.status === 'pending' && n.connection === 'connected' && !TERMINAL.has(n.state)) {
    n.state = 'running'; n.requests = []; n.waitingFlags = [];
    n.reason = '正在停止，等待原生 Harness 确认';
  }
  if (same({ ...n, observedAt:p.observedAt, revision:p.revision }, p)) return p;
  n.observedAt = now;
  n.revision = p.revision + 1;
  return n;
}
module.exports = { BACKEND, TERMINAL, isCodexSession, isNativeSession, createNativeRuntime, reduceNativeRuntime,
  nativeRuntimeTruth, nativeUnfinished, nativeTurnHasEnded, requestSummary, acceptNativeSnapshot, persistNativeRuntime, isUnstartedRuntime };
