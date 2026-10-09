'use strict';

const {
  RUNTIME_COMPLETED,
  RUNTIME_DORMANT,
  RUNTIME_FAILED,
  RUNTIME_RUNNING,
  RUNTIME_STARTING,
  RUNTIME_WAITING,
  RUNTIME_UNKNOWN,
  getSessionRuntimeTruth,
} = require('./session-runtime-truth.js');
const { hasStreamDisconnectIssue } = require('./stream-disconnect.js');
const { sessionNeedsUserInput } = require('./session-attention-state.js');
// 问题摘要的截断规则复用问题导航条的那个纯函数，不另写一份。
// （它只导出函数，模块加载时不碰 DOM；本文件也只被渲染进程加载。）
const { normalizeQuestionSummary } = require('../renderer/card-question-navigator.js');

function baseKind(session) {
  return String(session && session.kind || '').replace(/-resume$/i, '').toLowerCase();
}

function sessionModelLabel(session) {
  const model = session && session.currentModel;
  if (!model || typeof model !== 'object') return '';
  return String(model.id || model.displayName || '').trim();
}

function sessionEffortLabel(session) {
  const kind = baseKind(session);
  if (session?.runtimeBackend === 'acp') {
    const { acpThoughtOption, acpThoughtChoices } = require('./acp-model-catalog');
    const current = acpThoughtOption(session)?.currentValue;
    return acpThoughtChoices(session).find(o => o.value === current)?.name || current || '';
  }
  if (!['claude', 'codex', 'deepseek', 'deepseek-claude'].includes(kind)) return '';
  return String(session && session.effort || 'max').trim().toLowerCase();
}

function sessionSpeedLabel(session) {
  const kind = baseKind(session);
  if (session?.runtimeBackend === 'claude-stream-json') return require('./session-speed').speedControl(session).tier;
  if (kind === 'claude' || kind === 'deepseek-claude') {
    return session && session.fastMode === false ? 'standard' : 'fast';
  }
  if (kind === 'codex') {
    return String(session && session.codexSpeedTier || 'fast').trim().toLowerCase();
  }
  if (kind === 'deepseek') {
    const tier = String(session && session.codexSpeedTier || 'inherit').trim().toLowerCase();
    return tier === 'inherit' ? '' : tier;
  }
  return '';
}

function sessionContextLeft(session) {
  if (session?.contextPct == null || session.contextPct === '') return null;
  const used = Number(session && session.contextPct);
  if (!Number.isFinite(used)) return null;
  return Math.max(0, Math.min(100, Math.round(100 - used)));
}

// 通用会话摘要。群聊的成员行要在一行里说清「谁 · 什么模型 · 什么档」，
// 那是它唯一能显示模型名的地方，所以这一份保留 model / cwd 不动。
function buildSessionStatusSummary(session) {
  const model = sessionModelLabel(session);
  const effort = sessionEffortLabel(session);
  const speed = sessionSpeedLabel(session);
  const contextLeft = sessionContextLeft(session);
  const cwd = String(session && session.cwd || '').trim();
  const compact = [model, effort, speed].filter(Boolean).join(' · ');
  return {
    kind: baseKind(session),
    model,
    effort,
    speed,
    contextLeft,
    contextText: contextLeft == null ? '' : `Context ${contextLeft}% left`,
    cwd,
    compact,
    ariaLabel: [compact, contextLeft == null ? '' : `上下文剩余 ${contextLeft}%`, cwd]
      .filter(Boolean).join('，'),
  };
}

// T2 冷杉 v2 · 舞台状态行专用。模型名归 composer 底栏的 chip，工作目录归头部面包屑，
// 这里只留「这一轮跑起来会怎样」的实时量：思考档、速度档、上下文余量。
// 刻意另起一份而不是把字段从上面那份删掉：群聊和舞台是两种读者，共用一个对象
// 只会让下一次改动在两种读者之间赌一把 —— 舞台要瘦，群聊那一行反而必须带模型名。
function buildStageStatusSummary(session) {
  const effort = sessionEffortLabel(session);
  const speed = sessionSpeedLabel(session);
  const contextLeft = sessionContextLeft(session);
  const compact = [effort, speed].filter(Boolean).join(' · ');
  return {
    kind: baseKind(session),
    effort,
    speed,
    contextLeft,
    contextText: contextLeft == null ? '' : `Context ${contextLeft}% left`,
    compact,
    ariaLabel: [compact, contextLeft == null ? '' : `上下文剩余 ${contextLeft}%`]
      .filter(Boolean).join('，'),
  };
}


// ── Composer 底栏模型（T1 冷杉 v2）─────────────────────────────────────────
// 底栏三个「这条 prompt 怎么发」的决定：用什么模型、用多深的思考档、还剩多少预算。
// 全部是纯函数：渲染层只负责把结果画出来，判据在这里一处可测。

const COMPOSER_CTX_WARN_AT = 70;
const COMPOSER_CTX_DANGER_AT = 90;

// 上下文预算环。percent 是**已用**百分比（与 status-event 下发的 contextPct 同义），
// 与 card-session-status 的 ctx 读同一个字段，不另起一套算法。
function composerContextRing(session) {
  const raw = session?.contextPct == null || session.contextPct === '' ? NaN : Number(session.contextPct);
  if (!Number.isFinite(raw)) {
    return { visible: false, percent: null, level: 'ok', title: '', ariaLabel: '' };
  }
  const percent = Math.max(0, Math.min(100, Math.round(raw)));
  const level = percent > COMPOSER_CTX_DANGER_AT
    ? 'danger'
    : (percent >= COMPOSER_CTX_WARN_AT ? 'warn' : 'ok');
  const parts = [`上下文已用 ${percent}%`];
  const used = Number(session && session.contextUsed);
  if (Number.isFinite(used) && used > 0) parts.push(`约 ${used.toLocaleString()} tokens`);
  const effective = Number(session && session.contextEffectiveMax);
  if (Number.isFinite(effective) && effective > 0) {
    parts.push(`运行时有效窗口 ${effective.toLocaleString()} tokens`);
  }
  const requested = Number(session && session.contextMax);
  if (Number.isFinite(requested) && requested > 0) {
    parts.push(`Hub 启动请求 ${requested.toLocaleString()} tokens`);
  }
  return {
    visible: true,
    percent,
    level,
    title: parts.join('，'),
    ariaLabel: `上下文预算已用 ${percent}%`,
  };
}

function composerModelChip(session) {
  const model = session && typeof session.currentModel === 'object' ? session.currentModel : null;
  const id = model ? String(model.id || '').trim() : '';
  const displayName = model ? String(model.displayName || '').trim() : '';
  // 徽章一直用 displayName 优先、id 兜底；chip 沿用同一口径，避免两处显示不同的名字。
  const label = displayName || id;
  const pending = session && session._modelSwitchPending
    ? String(session._modelSwitchPending.label || session._modelSwitchPending.id || '').trim()
    : '';
  return { visible: !!label, label, id, pending };
}

// 思考档 chip 只对**实测**支持该能力的 CLI 渲染。
//   - Codex 系：档位按模型走，由调用方读 ~/.codex/models_cache.json 后传进来
//     （core/codex-model-catalog.js 的 describeCodexModelTuning）。写死一份必然
//     给某些模型多出或少掉档位 —— gpt-5.6-sol 到 ultra，gpt-5.5 只到 xhigh。
//   - Claude 系：原生 stream-json 会话有自己的 /effort 命令通道
//     （claude-native:set-effort），档位由调用方传入，和 Codex 一样可点；
//     PTY 会话没有这条通路，只显示不可点，不新造一条写 PTY 的路径。
//   - DeepSeek 走的是 Codex 运行时但另一套模型目录，本轮按只读处理，不假装能改。
//   - Gemini / Kimi / PowerShell：没有这个概念，直接不渲染。
function composerThinkingChip(session, options = {}) {
  const kind = baseKind(session);
  const label = sessionEffortLabel(session);
  const hidden = { visible: false, label: '', interactive: false, options: [] };
  if (session?.runtimeBackend === 'acp') {
    const choices = require('./acp-model-catalog').acpThoughtChoices(session);
    return choices.length ? { visible: true, label: label || '模型默认', interactive: true, options: choices.map(o => o.value) } : hidden;
  }
  if (!label) return hidden;
  if (kind === 'codex' || session?.runtimeBackend === 'claude-stream-json') {
    const supported = Array.isArray(options.supportedEfforts)
      ? options.supportedEfforts.map(value => String(value || '').trim().toLowerCase()).filter(Boolean)
      : [];
    if (!supported.length) return hidden;
    return { visible: true, label, interactive: true, options: supported };
  }
  return { visible: true, label, interactive: false, options: [] };
}

function buildComposerRailModel(session, options = {}) {
  return {
    kind: baseKind(session),
    model: composerModelChip(session),
    thinking: composerThinkingChip(session, options),
    context: composerContextRing(session),
  };
}

// ── Composer 状态行（T1 冷杉 v2）──────────────────────────────────────────
// 舞台头部的状态徽章和 composer 状态行说的是同一件事，所以 runtime 结论由渲染层
// 用 deriveSessionRuntimeStatus 算**一次**再传进来，这里只负责把它折成四档展示态。
// 复制一份判据 = 两个地方迟早说出互相矛盾的话，这里刻意不那么做。

const COMPOSER_STATUS_READY = 'ready';
const COMPOSER_STATUS_WORKING = 'working';
const COMPOSER_STATUS_WAITING = 'waiting';
const COMPOSER_STATUS_DEAD = 'dead';

// 状态行要的是「38s」这种口语时长，不是头部徽章的 mm:ss 计时器。
function formatRuntimeSeconds(value) {
  const totalSeconds = Math.max(0, Math.floor((Number(value) || 0) / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  if (minutes < 60) {
    const seconds = totalSeconds % 60;
    return seconds ? `${minutes}m${String(seconds).padStart(2, '0')}s` : `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  return `${hours}h${String(minutes % 60).padStart(2, '0')}m`;
}

// CLI 把选项摆成编号行时（「1. 是，继续 / 2. 先看 diff」）解析成快捷答复。
// 解析不出来就返回空数组 —— 宁可不给 chip，也不要造一个用户点了会答错的按钮。
// 只有一条候选不算选择题，同样不渲染。
function parseQuickReplyOptions(text, { max = 4, maxLength = 18 } = {}) {
  const seen = new Set();
  const options = [];
  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const match = rawLine.match(/^\s*(?:[>›❯▶*-]\s*)?(\d{1,2})\s*[.)、．]\s*(.+?)\s*$/);
    if (!match) continue;
    const label = String(match[2])
      .replace(/\s*\(default\)\s*$/i, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!label || label.length > maxLength) continue;
    const key = label.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    options.push(label);
    if (options.length >= max) break;
  }
  return options.length >= 2 ? options : [];
}

// 把编号选项行从问题正文里摘掉，剩下的才是「AI 到底在问什么」。
function stripQuickReplyLines(text) {
  return String(text || '')
    .split(/\r?\n/)
    .filter(line => !/^\s*(?:[>›❯▶*-]\s*)?\d{1,2}\s*[.)、．]\s+\S/.test(line))
    .join('\n')
    .trim();
}

function composerStateFor(runtimeState, { needsRespond = false, disconnected = false } = {}) {
  // 断开优先于一切：休眠会话上残留的 waitingText 不该冒充「在等你回答」，
  // 那会让用户对着一个收不到消息的会话打字。
  if (disconnected || runtimeState === RUNTIME_DORMANT || runtimeState === RUNTIME_FAILED) {
    return COMPOSER_STATUS_DEAD;
  }
  if (needsRespond || runtimeState === RUNTIME_WAITING) return COMPOSER_STATUS_WAITING;
  if (runtimeState === RUNTIME_STARTING || runtimeState === RUNTIME_RUNNING) return COMPOSER_STATUS_WORKING;
  return COMPOSER_STATUS_READY;
}

function composerRunStartedAt(session, truth) {
  return Number(truth && truth.startedAt)
    || Number(session && session.runStartedAt)
    || Number(session && session.cardWorkingSince)
    || 0;
}

/**
 * Composer 状态行的展示模型。纯函数：同样的输入永远给同样的结果。
 *
 * @param {object} session
 * @param {object} options
 * @param {object} options.runtime  渲染层 deriveSessionRuntimeStatus 的结果（必填，
 *   保证 composer 和舞台头部读的是同一个结论）。
 * @param {{waiting:boolean, reason?:string, text?:string}|null} options.liveQuestion
 *   现有问题检测（terminal-activity-monitor 的 isWaitingForUser）在当前终端画面上的结果。
 *   会话级的 attention 信号目前只有 Claude 会点亮，Codex 那条路径不调用它，
 *   所以 composer 额外接受一份**当前画面**的检测结果作为补充证据。
 * @returns {{ state, text, detail, quickReplies, action, canStop, runtime }}
 */
function buildComposerStatusModel(session, options = {}) {
  const native = require('./codex-native-runtime.js').isNativeSession(session);
  const now = Number(options.now) || Date.now();
  const runtime = options.runtime;
  if (!runtime || typeof runtime !== 'object') {
    throw new Error('buildComposerStatusModel requires the derived runtime status');
  }
  const truth = getSessionRuntimeTruth(session, { now });
  if(session?.runtimeBackend==='codex-app-server' && session.nativeRuntime?.connection==='disconnected'
      && session.nativeRuntime.observation?.state==='reconnecting') {
    const prolonged=now-session.nativeRuntime.observation.since>=30000;
    return {state:prolonged?COMPOSER_STATUS_WAITING:'syncing',text:prolonged?'同步连接暂不可用':'正在恢复同步',
      detail:'',quickReplies:[],canStop:false,runtime,
      action:prolonged?{kind:'reconnect',label:'核对连接'}:null};
  }
  if (session?.runtimeBackend === 'claude-stream-json') {
    const snapshot = session.nativeRuntime || {};
    // A quota wait outranks the `failed` line it grew out of: the turn did fail,
    // but what the user needs to know is that it is scheduled to continue and
    // when. A wait nobody can see is the failure mode this feature exists to
    // avoid, so it gets the status line and its own two buttons.
    if (snapshot.quotaWait) {
      const wait = require('./claude-quota-watchdog').describeQuotaWait(snapshot.quotaWait, now);
      if (wait) {
        // The ■ button doubles as "取消自动继续" here. Stopping something that
        // is about to happen is the same gesture as stopping something running,
        // and reusing it keeps one stop affordance instead of two.
        return { state: snapshot.quotaWait.status === 'stale' ? COMPOSER_STATUS_DEAD : COMPOSER_STATUS_WAITING,
          text: wait.text, detail: wait.detail, quickReplies: [],
          action: wait.canResume ? { kind: 'quota-resume-now', label: '现在继续' } : null,
          canStop: wait.canCancel, stopIntent: 'quota-cancel', runtime };
      }
    }
    // Work in flight (starting/running) takes the shared working line, the same
    // "Claude 正在工作 · 12s" Codex shows. Only states that need the user or
    // report a result get a Claude-specific message here.
    // reason 是 Hub 的连接状态说明，不代表 Claude 提供了历史读取进度。
    const connecting = snapshot.connection !== 'disconnected' && snapshot.connection !== 'connected';
    const loadingText = connecting && snapshot.reason ? String(snapshot.reason) : '';
    // 连上了却仍是 unknown，说的是「上一轮提交没有结论」，不是连接没回应。
    // 2026-09-22 实测：一个 20.1 MB 的会话 2388 ms 就 initialize 完成，界面却一直
    // 念「等待连接响应」，detail 还被清空 —— 用户只能干等一个永远不会变的字。
    // 这里把真实原因念出来并给一个按钮，剩下的自动核对在 ClaudeNativeSession 里做。
    const stalled = snapshot.state === 'unknown' && snapshot.connection === 'connected';
    // 一条提交拿不到「收到」证据、写入者却还活着：直接发下一条，Main 会自动恢复，
    // 用不着人核对（2026-09-24 用户决定不再为此弹提示）。只说事实，不给按钮、不亮警示色。
    const unconfirmedSend = stalled && !snapshot.cancellation
      && (snapshot.submission?.sendStatus || snapshot.submission?.status) === 'unknown';
    const labels = { unknown: snapshot.connection === 'disconnected' ? '连接已断开'
        : unconfirmedSend ? 'Claude 未确认收到上一条，可直接继续发送'
        : stalled ? '上次任务状态待核对' : (loadingText || '等待连接响应'),
      waiting: 'Claude 在等你回答', failed: '本轮执行失败', interrupted: '已停止' };
    if (labels[snapshot.state]) {
      // New composer sends recover in Main; no manual receipt-review action.
      return { state: snapshot.state === 'interrupted' || unconfirmedSend ? COMPOSER_STATUS_READY
          : snapshot.state === 'failed' ? COMPOSER_STATUS_DEAD : COMPOSER_STATUS_WAITING,
        text: labels[snapshot.state],
        detail: snapshot.state === 'waiting'
          ? (snapshot.requests || []).map(require('./claude-native-runtime').claudeRequestSummary).join('; ') || snapshot.reason || ''
          : unconfirmedSend ? ''
          : stalled ? snapshot.reason || ''
            : snapshot.state === 'unknown' ? '' : snapshot.reason || '',
        quickReplies: [],
        // 核对只读原生历史、只做「不重发」的登记，所以可以是一个按钮；
        // 它不会替用户重发旧消息，也不会把旧任务说成成功。剩下需要它的只有
        // 群聊/无人值守席位的关卡和一次没确认的停止。
        action: stalled && !unconfirmedSend ? { kind: 'claude-reconcile', label: '核对上次任务' } : null,
        canStop: snapshot.connection === 'connected' && (snapshot.state === 'waiting' || unconfirmedSend), runtime };
    }
  }
  const liveQuestion = !native && session?.runtimeBackend !== 'claude-stream-json' && options.liveQuestion && options.liveQuestion.waiting
    ? options.liveQuestion
    : null;
  // 「等你响应」的判据与 respond-pill 完全一致（sessionNeedsUserInput），
  // 区别只在 pill 会跳过当前会话 —— composer 说的就是当前会话，所以不跳过。
  // liveQuestion 是同一件事的第二个证据来源，两者取或。
  const needsRespond = sessionNeedsUserInput(session) || !!liveQuestion;
  const disconnected = native ? truth.state === 'unknown' || truth.connection === 'disconnected' : hasStreamDisconnectIssue(session);
  // A failed provider turn does not terminate a PTY. Its prompt remains usable;
  // only process loss / a transport issue warrants a reconnect action.
  const livePtyFailure = session?.agentRuntime === 'pty' && !session._processLost
    && session.status !== 'dormant' && truth.state === 'failed';
  const state = (native || livePtyFailure) && truth.state === 'failed' && !disconnected
    ? COMPOSER_STATUS_READY : composerStateFor(runtime.state, { needsRespond, disconnected });
  const provider = runtime.provider || 'AI';

  if (state === COMPOSER_STATUS_WORKING) {
    if (truth.cancellation?.status === 'pending') return {
      state, text:`${provider} 正在停止`, detail:truth.evidence || '',
      quickReplies:[], action:null, canStop:false, runtime,
    };
    const startedAt = composerRunStartedAt(session, truth);
    const elapsed = startedAt > 0 && now >= startedAt ? formatRuntimeSeconds(now - startedAt) : '';
    const apiRetry = session?.runtimeBackend === 'claude-stream-json'
      ? require('./claude-native-runtime').claudeApiRetrySummary(session.nativeRuntime) : '';
    // Before the model streams there is no startedAt; the wait the user feels
    // runs from the send, so count from there.
    const submittedAt = Number(session?.nativeRuntime?.submission?.submittedAt) || 0;
    const waited = apiRetry && !elapsed && submittedAt > 0 && now >= submittedAt ? formatRuntimeSeconds(now - submittedAt) : '';
    return {
      state,
      text: apiRetry ? `${apiRetry}${elapsed || waited ? ' · 已等 '+(elapsed || waited) : ''}`
        : truth.state === 'starting' && ['codex-app-server','claude-stream-json'].includes(session?.runtimeBackend)
        ? `${provider} ${['accepted','confirmed'].includes(session.nativeRuntime?.submission?.status || session.nativeRuntime?.submission?.sendStatus) ? '已收到 · 等待输出' : '正在提交'}${elapsed ? ' · '+elapsed : ''}`
        : elapsed ? `${provider} 正在工作 · ${elapsed}` : `${provider} 正在工作`,
      detail: runtime.visibleDetail || '',
      quickReplies: [],
      action: null,
      canStop: true,
      runtime,
    };
  }

  if (state === COMPOSER_STATUS_WAITING) {
    const raw = String(
      (native ? truth.evidence : (session && session.waitingText) || (liveQuestion && liveQuestion.text)) || runtime.detail || '',
    ).trim();
    const quickReplies = native ? [] : parseQuickReplyOptions(liveQuestion ? liveQuestion.screen || raw : raw);
    // 选项行属于「快捷答复」那一行，不该再挤进问题摘要里念一遍。
    const question = quickReplies.length ? stripQuickReplyLines(raw) : raw;
    const summary = question ? normalizeQuestionSummary(question, 48) : '';
    return {
      state,
      text: summary ? `${provider} 在等你回答：「${summary}」` : `${provider} 在等你回答`,
      detail: '',
      quickReplies,
      action: null,
      canStop: native,
      runtime,
    };
  }

  if (state === COMPOSER_STATUS_DEAD) {
    if (session?.runtimeBackend === 'codex-app-server' && runtime.state !== RUNTIME_DORMANT) return {
      state, text: truth.connection === 'disconnected' ? '连接已断开' : '等待连接响应',
      detail:'',quickReplies:[],canStop:false,runtime,action:null,
    };
    if (native && runtime.state !== RUNTIME_DORMANT) return {
      state, text: truth.state === 'unknown' ? `${provider} 状态待核对` : `${provider} 连接已断开`,
      detail: truth.evidence || '', quickReplies: [], canStop: false, runtime,
      action: ['codex-app-server','acp','claude-stream-json'].includes(session.runtimeBackend) ? { kind:'reconnect', label:'核对连接' } : null,
    };
    const issue = session && session.connectionIssue;
    const lost = session && session._processLost;
    const reason = String(
      // CLI 进程真的没了是最具体的一条事实，优先念它；否则会被
      // 笼统的“会话已休眠”盖掉，用户分不清是自己收的还是崩的。
      (lost && lost.reason)
      || (disconnected && issue && (issue.reason || issue.detail))
      // 休眠不是故障，它的 detail 是一句操作提示（「点击会话可恢复原生 CLI」），
      // 拿来当断开原因念出来是答非所问。
      || (runtime.state === RUNTIME_DORMANT ? '会话已休眠' : '')
      || runtime.detail
      || (session && (session.lastError || session.error || session.spawnError))
      || '',
    ).replace(/\s+/g, ' ').trim().slice(0, 60);
    return {
      state,
      text: reason
        ? `会话已断开（${reason}）· 重连后可继续`
        : '会话已断开 · 重连后可继续',
      detail: '',
      quickReplies: [],
      action: { kind: 'reconnect', label: '重连' },
      canStop: false,
      runtime,
    };
  }

  if (runtime.state === RUNTIME_UNKNOWN) return {
    state: 'unknown', text: '状态未知', detail: '', quickReplies: [],
    action: null, canStop: false, runtime,
  };
  // 就绪：runtime.meta 在 COMPLETED 下就是 formatCompletionAge 的结果（「2 分钟前」）。
  const age = runtime.state === RUNTIME_COMPLETED ? String(runtime.meta || '').trim() : '';
  return {
    state: COMPOSER_STATUS_READY,
    text: native && truth.state === 'interrupted' ? '上一轮已中断 · 可继续发送'
      : (native || livePtyFailure) && truth.state === 'failed' ? '上一轮执行失败 · 可继续发送'
      : age ? `已就绪 · ${age}完成上一轮` : '已就绪',
    detail: (native || livePtyFailure) && truth.state === 'failed' ? truth.evidence || session.lastError || '' : '',
    quickReplies: [],
    action: age ? { kind: 'scroll-latest', label: '查看上一轮 ↑' } : null,
    canStop: false,
    runtime,
  };
}

module.exports = {
  COMPOSER_CTX_DANGER_AT,
  COMPOSER_CTX_WARN_AT,
  COMPOSER_STATUS_DEAD,
  COMPOSER_STATUS_READY,
  COMPOSER_STATUS_WAITING,
  COMPOSER_STATUS_WORKING,
  baseKind,
  buildComposerRailModel,
  buildComposerStatusModel,
  buildSessionStatusSummary,
  buildStageStatusSummary,
  composerContextRing,
  composerModelChip,
  composerStateFor,
  composerThinkingChip,
  formatRuntimeSeconds,
  parseQuickReplyOptions,
  sessionContextLeft,
  sessionEffortLabel,
  sessionModelLabel,
  sessionSpeedLabel,
};
