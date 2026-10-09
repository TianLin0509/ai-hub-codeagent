'use strict';
/*
 * 循环工作流 · main 进程驱动引擎（Phase 2b 进阶，2026-06-29 maintainer）
 * ──────────────────────────────────────────────────────────────
 * 把「开发→评审→gate→推进→打磨→终止」循环驱动放在 main 进程，复用现有 dispatcher。
 * renderer 崩溃不中断循环（turn 级容错）；每轮持久化 loopState，Hub 重启自动续跑。
 * 纯判定逻辑复用 renderer/loop-workflow.js（UMD：node 环境取 module.exports）。
 *
 * 依赖注入（便于单测 mock）：
 *   getDispatcher() → { dispatchGroupChatTurn(meetingId,args) }
 *   meetingManager  → getMeeting(id) / updateMeeting(id, fields)
 *   sessionManager  → getSession(sid) / createSession(kind,opts)
 *   sendToRenderer(channel, data)
 *   writeReport(html) → string|null（可选，写晨报，返回路径）
 *   logger
 */
const LC = require('../../renderer/loop-workflow.js'); // UMD → node 下为纯逻辑 module.exports
const { suspendMeetingRoom: suspendMeetingRoomImpl } = require('../../core/meeting-room-suspend.js');
const WT = require('../../renderer/workflow-templates.js');
const Conversation = require('../../core/conversation-workflow');
const DOCS = require('../../core/dev-task-docs.js');
const DevDiscuss = require('../../core/dev-discuss.js');
const LOCATOR = require('../../core/dev-project-locator.js');
const NEWLINE = String.fromCharCode(10);
const fsx = require('fs');
const path = require('path');
const { formatBeijingDateTime } = require('../../core/beijing-time.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// 开机自动续跑串行工作流的年龄上限：超过这个时长没动静的，只做提示不自动派发。
const SERIAL_BOOT_RESUME_MAX_IDLE_MS = 6 * 60 * 60 * 1000;

function createLoopEngine(deps) {
  const {
    getDispatcher, getOrchestrator, meetingManager, resumeSession, sessionManager,
    sendToRenderer = () => {}, writeReport = () => null, logger = console,
    suspendMeetingRoom = suspendMeetingRoomImpl,
  } = deps || {};
  const running = new Map(); // meetingId → { abort, mode, runId, startedAt }

  function runId(prefix) {
    return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
  }

  function logError(message, error) {
    const fn = logger && (logger.error || logger.warn || logger.log);
    if (typeof fn === 'function') fn.call(logger, message, error && error.message ? error.message : error || '');
  }

  function sidOf(meeting, memberId) {
    const specs = Array.isArray(meeting && meeting.slotSpecs) ? meeting.slotSpecs : [];
    let index = specs.findIndex((spec, i) => String(spec && spec.memberId || `m${i + 1}`) === String(memberId));
    if (index < 0) {
      const legacy = /^m(\d+)$/.exec(String(memberId || ''));
      index = legacy ? Number(legacy[1]) - 1 : -1;
    }
    return (index >= 0 && Array.isArray(meeting.subSessions)) ? (meeting.subSessions[index] || null) : null;
  }
  function labelOf(meeting, memberId) {
    const sid = sidOf(meeting, memberId);
    const s = sid && sessionManager ? sessionManager.getSession(sid) : null;
    return (s && s.title) || memberId;
  }
  function textFrom(results, sid) {
    const r = (results || []).find((x) => x && x.sid === sid);
    return r ? (r.text || '') : '';
  }

  // ── 评审裁决的取文本路径（2026-09-05 修）────────────────────────────────────
  //
  // 症状：合并位明明跑完了全套验证、也给了 RESULT: PASS，引擎却当它「没给裁决」，
  //       保守判 fail、白烧一轮；连烧三轮报 stopped_max。代码其实已经正确合入了。
  //
  // 根因：ClaudeTap 有 idle timer —— 转录静默一段时间就主动 emit turn-complete。
  //       评审说完「现在开始验证」就去跑测试 / git 了，转录随之静默，计时器提前触发，
  //       watcher 拿当时那段开场白结算并 resolve。真正的完整回答稍后才通过
  //       patch-after-settle 补进转录（5 分钟窗口），**而引擎早已用短文本判完了**。
  //       更糟的是引擎以为评审结束、把下一步派给了工作位，于是工作位收到
  //       「评审没给裁决」这种它根本修不了的阻断项。
  //
  // 修法：不动 idle timer（它是为「首轮卡住不出卡」兜底的，动它会伤别的链路）。
  //       改在真正需要裁决的这一层等：结算文本与已持久化转录取更长的那个，
  //       解析不出裁决时就继续等——**只要文本还在长就一直等**（说明 agent 还在干活），
  //       连续 QUIET 毫秒不长才认定它是真没给裁决，另设硬上限兜底。
  // 等待预算可由 deps 注入 —— 生产用安全的默认值，单测注入毫秒级避免每轮空转。
  // （不注入的话，mock 出来的 agent 永远不会补文本，每一步都要白等满静默期。）
  const _w = (deps && deps.stepTextWait) || {};
  const VERDICT_QUIET_MS = Number(_w.verdictQuietMs) > 0 ? Number(_w.verdictQuietMs) : 60_000;
  const VERDICT_WAIT_CAP_MS = Number(_w.verdictCapMs) > 0 ? Number(_w.verdictCapMs) : 8 * 60_000;
  // 工作位的预算小一个量级：PROGRESS 缺了不影响流程正确性，不值得每轮白等一分钟。
  const BUILDER_QUIET_MS = Number(_w.builderQuietMs) > 0 ? Number(_w.builderQuietMs) : 10_000;
  const BUILDER_WAIT_CAP_MS = Number(_w.builderCapMs) > 0 ? Number(_w.builderCapMs) : 4 * 60_000;

  function persistedTurnText(meetingId, turnNum, sid) {
    if (typeof getOrchestrator !== 'function' || !turnNum || !sid) return '';
    try {
      const orchestrator = getOrchestrator(meetingId);
      const state = orchestrator && typeof orchestrator.getState === 'function'
        ? orchestrator.getState()
        : orchestrator && orchestrator.state;
      const turn = ((state && state.turns) || []).find(t => t && Number(t.n) === Number(turnNum));
      return (turn && turn.by && turn.by[sid]) || '';
    } catch (error) {
      return '';
    }
  }

  /** 取这一步「最完整」的文本：结算文本 vs 转录里已补丁的文本，谁长用谁。 */
  function bestTextSoFar(meetingId, turnNum, sid, settledText) {
    const settled = settledText || '';
    const persisted = persistedTurnText(meetingId, turnNum, sid);
    return persisted.length > settled.length ? persisted : settled;
  }

  /**
   * 等这一步真的「说完」。
   * isDone(text) 给出「已经拿到想要的东西」的判据，拿到就立刻走，不空等；
   * 拿不到就看文本还长不长 —— 还在长说明 agent 还在干活，继续等。
   */
  async function awaitStepText(meetingId, turnNum, sid, settledText, isDone, opts = {}) {
    const quietMs = Number(opts.quietMs) > 0 ? Number(opts.quietMs) : VERDICT_QUIET_MS;
    const capMs = Number(opts.capMs) > 0 ? Number(opts.capMs) : VERDICT_WAIT_CAP_MS;
    const tick = Number(opts.tickMs) > 0 ? Number(opts.tickMs) : 3000;
    const isAborted = typeof opts.isAborted === 'function' ? opts.isAborted : () => false;
    const done = typeof isDone === 'function' ? isDone : () => true;

    let best = bestTextSoFar(meetingId, turnNum, sid, settledText);
    if (done(best)) return best;

    let lastLen = best.length;
    let lastGrowthAt = Date.now();
    const deadline = Date.now() + capMs;

    while (Date.now() < deadline && !isAborted()) {
      await sleep(tick);
      const now = bestTextSoFar(meetingId, turnNum, sid, settledText);
      if (now.length > lastLen) {
        best = now; lastLen = now.length; lastGrowthAt = Date.now();
      }
      if (done(best)) return best;                         // 拿到就走，不空等
      if (Date.now() - lastGrowthAt >= quietMs) break;      // 真的不再输出了
    }
    return best;
  }

  // 评审：等到能解析出 RESULT 裁决
  const hasVerdict = (t) => !!LC.parseVerdict(t);
  // 工作位：等到它按合同交出 PROGRESS 那一行。
  // 不等的话，引擎会在工作位还在改文件时就把审查派出去 —— 评审看到的是半成品分支。
  const hasProgressCard = (t) => /(?:^|\n)\s*PROGRESS\s*[:：]/i.test(String(t || ''));

  const awaitVerdictText = (meetingId, turnNum, sid, settledText, opts) =>
    awaitStepText(meetingId, turnNum, sid, settledText, hasVerdict, opts);

  // ── MD 交接闸门（2026-09-08）────────────────────────────────────────────
  //
  // 「某次 CLI 回复结束」不再等于「本开发步骤完成」。允许维护者随时插话之后，一步里会有
  // 很多次回复：它答「收到」、中途报 UPDATE、跑测试时转录静默被 idle timer 提前结算……
  // 任何一次都可能被误读成交付。
  //
  // 所以交付换成一个 agent 明确做出、Hub 能独立核验的动作：把本阶段草稿改名成「已完成-…」。
  // 引擎在这里只回答两个分开的问题：
  //   A 交付成立了吗 —— 预期完成文件在不在、读得完整吗、最少字段够不够；
  //   B 现在能派下一位吗 —— A 成立、用户没喊停、且这一步没有已确认的派发。
  // A 成立而 B 还不成立时显示「已交付，等待执行结束」，不回退业务阶段。
  const DOC_POLL_MS = Number(_w.docPollMs) > 0 ? Number(_w.docPollMs) : 4000;
  const DOC_WAIT_CAP_MS = Number(_w.docCapMs) > 0 ? Number(_w.docCapMs) : 5 * 60_000;

  // ── 用户的停止意图（2026-09-08 合并位复现的阻断）──────────────────────────
  //
  // 原来「停止」只写在内存里那条 running 记录上（entry.abort）。两个后果：
  //   1. 迟到的完成文件照样能推进 —— 用户点停止的那一刻，文件可能正好在同一次重读里
  //      被判成「已接收」，于是开题接收后照常自动开工、循环照常派下一位；
  //   2. Hub 一重启，abort 就没了，开机重扫又会把它捡起来接着跑。
  //
  // 任务书说得很直接：「用户明确『停止』的意图优先，不能被迟到文件或重启覆盖。」
  // 所以它必须落盘，并且只由**用户自己**的明确动作清掉（点开始 / 继续 / 重发）。
  // 停止不删除任何成果：已接收的交付凭据、文档、会话全部留着，人回来接着走。

  /**
   * 此刻还该不该把活派出去。
   *
   * 2026-09-08 第六轮合并位复现：判断原来放在 ensureMemberReady() **之前**，
   * 而它在席位休眠时会 await（恢复会话最长 30 秒）。停止落在那段等待里就被漏掉，
   * 开题 / 实现 / 审查三处照样各派一次。判断必须贴着真正的派发调用做。
   */
  function shouldNotDispatch(meetingId, entry) {
    return !!((entry && entry.abort) || stopIntentOf(meetingId));
  }

  function stopIntentOf(meetingId) {
    const workflow = (meetingManager.getMeeting(meetingId) || {}).serialWorkflow || {};
    return workflow.stopRequested || null;
  }

  function writeStopIntent(meetingId, value) {
    try {
      const workflow = (meetingManager.getMeeting(meetingId) || {}).serialWorkflow || {};
      meetingManager.updateMeeting(meetingId, {
        serialWorkflow: Object.assign({}, workflow, { stopRequested: value }),
      });
      return true;
    } catch (error) {
      logError('[loop-engine] 停止意图落盘失败:', error);
      return false;
    }
  }

  /** 用户明确要求继续（loop:start / loop:resume / dev:kickoff / dev:redispatch）时调。 */
  function clearStopIntent(meetingId) {
    if (!stopIntentOf(meetingId)) return;
    writeStopIntent(meetingId, null);
  }

  function hubDataDir() {
    if (typeof deps.getHubDataDir === 'function') return deps.getHubDataDir();
    return require('../../core/data-dir.js').getHubDataDir();
  }

  /**
   * 这个群该不该走 MD 交接。只对**新建的**双席位开发群聊生效：
   * 老房间没有这个字段，行为一字不改；极简单席位保留原流程（任务书明确要求）。
   * 多评审时不启用 —— 一份合并手册说不清是谁的裁决，宁可不用也不要猜。
   */
  function docsEnabled(meeting, reviewerIds) {
    const wf = meeting && meeting.serialWorkflow;
    return !!(meeting && meeting.scene === 'dev' && meeting.groupChat
      && wf && wf.mdHandoff === true
      && Array.isArray(reviewerIds) && reviewerIds.length === 1);
  }

  function taskDirFor(meetingId) {
    return DOCS.ensureTaskDocsDir(hubDataDir(), meetingId);
  }

  function readDocLedger(meetingId, dir) {
    const wf = (meetingManager.getMeeting(meetingId) || {}).serialWorkflow || {};
    return DOCS.normalizeLedger(wf.taskDocs, dir);
  }

  function saveDocLedger(meetingId, ledger) {
    const wf = (meetingManager.getMeeting(meetingId) || {}).serialWorkflow || {};
    meetingManager.updateMeeting(meetingId, { serialWorkflow: Object.assign({}, wf, { taskDocs: ledger }) });
  }

  /**
   * 读一次预期完成文件并与账本对账。接收成功就**立刻落盘**接收凭据 ——
   * 「已接收」这个事实不能只活在内存里，否则崩在这里会让上一位白干一遍。
   */
  function checkDeliveryOnce(meetingId, dir, pos) {
    const spec = DOCS.docSpecForPos(pos);
    if (!spec) return { status: 'pending', reason: 'bad_pos' };
    const ledger = readDocLedger(meetingId, dir);
    const delivery = DOCS.readDelivery(dir, spec.done);
    const outcome = DOCS.reconcileDelivery(ledger, pos, delivery, spec.kind);
    if (outcome.status === 'accepted') {
      try { saveDocLedger(meetingId, DOCS.withAccepted(ledger, pos, outcome.record)); }
      catch (error) { logError('[loop-engine] 接收凭据落盘失败:', error); return { status: 'pending', reason: 'accept_persist_failed' }; }
    }
    return Object.assign({ spec, delivery }, outcome);
  }

  /**
   * 预扫结果里，哪些是「必须先让人看一眼」而不是「继续派工」的。
   *
   * 2026-09-08 合并位提的阻断：已接收的完成文件被人事后改过时，引擎原来先照常派一次工
   * （真实 CLI 转一整轮），等到闸门那一步才报「待核对」。既白烧一轮，也给 agent 一个
   * 它根本无从下手的任务。判据在派发之前就已经拿到了，就该在派发之前用。
   */
  function needsHumanBeforeDispatch(outcome) {
    return !!outcome && outcome.status === 'changed_after_accept';
  }

  function deliveryAccepted(outcome) {
    return !!outcome && (outcome.status === 'accepted' || outcome.status === 'duplicate');
  }

  /**
   * 等这一阶段的完成文件出现。文件监听事件只是唤醒提示，这里靠**重读**兜底 ——
   * 丢事件、重启后文件其实已经在了，都不该让流程永久卡死（任务书 B04）。
   * 等不到不是任务失败，是「还不能接收」，调用方保留阶段并说明具体原因。
   */
  async function awaitDelivery(meetingId, dir, pos, opts = {}) {
    const isAborted = typeof opts.isAborted === 'function' ? opts.isAborted : () => false;
    const capMs = Number(opts.capMs) > 0 ? Number(opts.capMs) : DOC_WAIT_CAP_MS;
    const tick = Number(opts.pollMs) > 0 ? Number(opts.pollMs) : DOC_POLL_MS;
    const deadline = Date.now() + capMs;
    let last = checkDeliveryOnce(meetingId, dir, pos);
    while (!deliveryAccepted(last)) {
      // 已接收的文件后来又被改动：不覆盖已接收版本，也不继续等，停在待核对。
      if (last.status === 'changed_after_accept') return last;
      if (isAborted() || Date.now() >= deadline) return last;
      await sleep(tick);
      last = checkDeliveryOnce(meetingId, dir, pos);
    }
    return last;
  }

  /**
   * 一次**新**的循环运行该从哪个实现位起步。
   *
   * 为什么需要它：账本按 pos 记「哪一阶段已经交付过」。续跑要复用这些凭据（崩在派发前
   * 不能让上一位白干一遍）；但维护者在暂停后重新发一句话，那是一个**新目标**，
   * 不能把上一轮的阶段交付当成这一轮的。所以新运行从「还没被接收过的下一个实现位」开始，
   * 旧轮的完成文件原样留着当对照，也就不会去覆盖任何已有的完成文件。
   */
  function nextFreePosBase(meetingId, dir) {
    const ledger = readDocLedger(meetingId, dir);
    const maxAccepted = Object.keys(ledger.accepted || {})
      .map(Number).filter(Number.isInteger)
      .reduce((a, b) => Math.max(a, b), 0);
    // 实现位永远是奇数（1、3、5…）：0 是开题，偶数是审查。
    return maxAccepted % 2 === 1 ? maxAccepted + 2 : maxAccepted + 1;
  }

  /** 已接收的上游文档绝对路径，按 pos 从小到大，给下一位当阅读入口。 */
  function acceptedDocPaths(meetingId, dir, uptoPos) {
    const ledger = readDocLedger(meetingId, dir);
    return Object.keys(ledger.accepted || {})
      .map(Number)
      .filter(pos => Number.isInteger(pos) && pos < uptoPos)
      .sort((a, b) => a - b)
      .map(pos => (ledger.accepted[String(pos)] || {}).path)
      .filter(Boolean);
  }

  function withDocBlock(prompt, dir, pos, inputDocs) {
    const block = dir ? DOCS.buildDocBlock({ dir, pos, inputDocs }) : '';
    return block ? `${prompt}\n\n${block}` : prompt;
  }

  /** 交付已按文档接收、这一步不需要再派人时，用它顶掉一次派发结果。 */
  function deliveredWithoutDispatch(meeting, memberIds, turnNum, note) {
    return {
      status: 'completed',
      turnNum: turnNum || null,
      results: memberIds.map(memberId => ({
        sid: sidOf(meeting, memberId), status: 'completed', text: note, recovered: true,
      })),
      recovered: true,
    };
  }


  // Dormant members must resume through the same provider-native path as a
  // normal Session.  Recreating with only {id,title} silently lost cwd/model/
  // tuning/MCP and was a major source of workflow-only failures.
  async function ensureMemberReady(meeting, memberId) {
    const sid = sidOf(meeting, memberId);
    if (!sid || !sessionManager) throw new Error(`workflow member ${memberId} is missing`);
    let session = sessionManager.getSession(sid);
    if (!session && (Conversation.enabled(meeting) || require('../../core/dev-file-workflow').enabled(meeting) || require('../../core/delivery-workflow').enabled(meeting)) && typeof deps.loadSessionMeta === 'function') {
      const meta = deps.loadSessionMeta(sid);
      if (meta && meta.hubId === sid && meta.meetingId === meeting.id) {
        if (typeof resumeSession !== 'function' || !await resumeSession(meta)) throw new Error(`workflow member ${memberId} could not restore its saved session`);
        session = sessionManager.getSession(sid);
      }
    }
    // Boot resume can race renderer/session restoration. Wait for the persisted
    // session to materialize before declaring the workflow broken.
    for (let i = 0; !session && i < 60; i += 1) {
      await sleep(500);
      session = sessionManager.getSession(sid);
    }
    if (!session) throw new Error(`workflow session ${memberId} (${sid}) is missing after restore grace`);
    if (session.status !== 'dormant') return session;
    if (typeof resumeSession !== 'function') throw new Error(`workflow member ${memberId} cannot resume`);
    logger.log('[workflow-engine] resuming dormant member', sid);
    const resumed = await resumeSession({ ...session, hubId: session.id || sid, meetingId: meeting.id });
    if (!resumed) throw new Error(`workflow member ${memberId} resume failed`);
    for (let i = 0; i < 60; i += 1) {
      session = sessionManager.getSession(sid);
      if (session && session.status !== 'dormant') return session;
      await sleep(500);
    }
    throw new Error(`workflow member ${memberId} resume timed out`);
  }

  function buildConfig(loopCfg) {
    const c = LC.defaultConfig();
    // v2: one clean review pass is enough; suggestions never create an implicit polish phase.
    c.gate = { consecutivePass: 1 };
    c.polish = { enabled: false };
    c.stop = {
      maxRounds: Math.max(1, Math.min(10, (loopCfg && loopCfg.maxRounds) || 3)),
      deadlineTs: (loopCfg && loopCfg.deadlineTs) || null,
      noProgressRounds: (loopCfg && loopCfg.noProgressRounds) || 2,
    };
    c.cwd = (loopCfg && loopCfg.cwd) || null;
    return c;
  }

  function persist(meetingId, state, config) {
    try {
      const cur = (meetingManager.getMeeting(meetingId) || {}).serialWorkflow || {};
      meetingManager.updateMeeting(meetingId, {
        serialWorkflow: Object.assign({}, cur, {
          loopState: {
            runId: state.runId || null,
            goal: state.goal, status: state.status, phase: state.phase, round: state.round,
            consecutiveGreen: state.consecutiveGreen, suggestionPool: state.suggestionPool,
            history: state.history, _lastBlockerSig: state._lastBlockerSig, _noProgress: state._noProgress,
            deadlineTs: config.stop.deadlineTs, driver: 'main',
            currentStep: state.currentStep || null, attempt: state.attempt || (state.round + 1),
            currentTurnNum: state.currentTurnNum || null,
            stepAttempt: Number(state.stepAttempt) || 0,
            // 本次运行的阶段文件起点。续跑必须沿用它，否则会去找别的轮次的文件。
            posBase: Number(state.posBase) > 0 ? Number(state.posBase) : null,
            // 损坏标记跟着每次落盘走：正常跑的时候它就是 null，
            // 这样「记录被写坏过」不会永远粘在这个群上。
            damaged: state.damaged || null,
            lastError: state.lastError || null,
          },
        }),
      });
      return true;
    } catch (e) {
      logError('[loop-engine] persist failed:', e);
      return false;
    }
  }

  function validateSerial(meetingId) {
    const meeting = meetingManager.getMeeting(meetingId);
    if (require('../../core/dev-file-workflow').enabled(meeting)) return { ok: false, reason: 'dev_file_workflow_uses_composer' };
    if (!meeting || !meeting.groupChat) return { ok: false, reason: 'group_chat_not_found' };
    const workflow = meeting.serialWorkflow || {};
    const steps = Array.isArray(workflow.steps) ? workflow.steps : [];
    if (!workflow.enabled || !steps.length) return { ok: false, reason: 'serial_workflow_not_enabled' };
    if (steps.some(step => !Array.isArray(step) || !step.filter(Boolean).length)) {
      return { ok: false, reason: 'serial_workflow_has_empty_step' };
    }
    if (workflow.settingsVersion === 1 && (steps.length > 6 || steps.some(step => step.length > 3 || new Set(step).size !== step.length))) return {ok:false,reason:'工作流最多 6 轮，每轮 1–3 位不同成员'};
    return { ok: true, meeting, workflow, steps };
  }

  // 开发群聊「讨论阶段」：循环既不能新起也不能恢复。恢复的是旧目标，会绕过「开工」那一步的
  // 任务说明确认（2026-09-06 合并位在隔离实例复现：旧循环暂停 → 回到讨论 → 点继续 → 后端照跑）。
  // 前端不露入口只是礼貌，这里才是闸门：loop:start / loop:resume / 工作台恢复三条路都经过 runLoop。
  function discussPhaseBlock(meeting) {
    if (require('../../core/dev-file-workflow').enabled(meeting)) return { ok: false, reason: 'dev_file_workflow_uses_composer' };
    const wf = meeting && meeting.serialWorkflow;
    if (!meeting || meeting.scene !== 'dev' || !wf) return null;
    // 开题阶段同样不许起循环：任务书还没被接收，开工就是绕过它。
    if (wf.devPhase === 'discuss') return { ok: false, reason: 'dev_discuss_phase' };
    if (wf.devPhase === 'kickoff') return { ok: false, reason: 'dev_kickoff_phase' };
    return null;
  }

  /**
   * 续跑前先看一眼这份持久记录本身是不是可信的。
   *
   * 2026-09-08 I 层复现：把 loopState.round 写成 -3、posBase 写成 'NaN-ish'，
   * 引擎照单全收 —— 算出来的阶段位置是负的，预期文件名直接变成 undefined。
   * 任务书对这种情况写得很直白：「状态记录丢失/损坏：不能按目录里最大的阶段号盲目继续；
   * 先核对可恢复记录与现场，不明则人工处理。」所以这里只做判断，不做修复：
   * 记录不可信就停下来让人看，不猜一个「大概是第几轮」接着跑。
   */
  function describeLoopStateDamage(persisted) {
    if (!persisted || typeof persisted !== 'object') return null;
    const problems = [];
    const round = persisted.round;
    if (round !== undefined && round !== null
      && (!Number.isSafeInteger(Number(round)) || Number(round) < 0)) {
      problems.push(`round=${JSON.stringify(round)}`);
    }
    const posBase = persisted.posBase;
    if (posBase !== undefined && posBase !== null
      && (!Number.isSafeInteger(Number(posBase)) || Number(posBase) < 1)) {
      problems.push(`posBase=${JSON.stringify(posBase)}`);
    }
    const attempt = persisted.stepAttempt;
    if (attempt !== undefined && attempt !== null
      && (!Number.isSafeInteger(Number(attempt)) || Number(attempt) < 0)) {
      problems.push(`stepAttempt=${JSON.stringify(attempt)}`);
    }
    return problems.length ? problems.join('，') : null;
  }

  function validateResume(meetingId) {
    const meeting = meetingManager.getMeeting(meetingId);
    if (!meeting) return { ok: false, reason: 'group_chat_not_found' };
    return discussPhaseBlock(meeting) || { ok: true };
  }

  function validateLoop(meetingId) {
    const meeting = meetingManager.getMeeting(meetingId);
    if (!meeting || !meeting.groupChat) return { ok: false, reason: 'group_chat_not_found' };
    const blocked = discussPhaseBlock(meeting);
    if (blocked) return blocked;
    const workflow = meeting.serialWorkflow || {};
    const steps = Array.isArray(workflow.steps) ? workflow.steps : [];
    const builderId = (steps[0] || [])[0];
    const reviewers = Array.from(new Set([].concat(...steps.slice(1)).filter(Boolean)));
    if (!(workflow.loop && workflow.loop.enabled)) return { ok: false, reason: 'loop_workflow_not_enabled' };
    if (!builderId || !reviewers.length) return { ok: false, reason: 'loop_requires_builder_and_reviewer' };
    return { ok: true, meeting, workflow, steps };
  }

  function persistSerial(meetingId, state) {
    const meeting = meetingManager.getMeeting(meetingId);
    if (!meeting) throw new Error('meeting disappeared while persisting serial workflow');
    const current = meeting.serialWorkflow || {};
    meetingManager.updateMeeting(meetingId, {
      serialWorkflow: {
        ...current,
        serialRunState: {
          schemaVersion: 1,
          driver: 'main',
          kind: 'serial',
          runId: state.runId,
          goal: state.goal,
          status: state.status,
          nextStepIndex: state.nextStepIndex,
          currentStepIndex: state.currentStepIndex,
          currentTurnNum: state.currentTurnNum,
          attemptsByStep: { ...(state.attemptsByStep || {}) },
          executedRounds: Number(state.executedRounds) || 0,
          budgetStart: Number(state.budgetStart) || 0,
          completedSteps: Array.isArray(state.completedSteps) ? state.completedSteps.slice(-100) : [],
          startedAt: state.startedAt,
          updatedAt: Date.now(),
          lastError: state.lastError || null,
        },
      },
    });
  }

  function stepEvidence(meetingId, runIdValue, stepIndex) {
    if (typeof getOrchestrator !== 'function') return null;
    try {
      const orchestrator = getOrchestrator(meetingId);
      const state = orchestrator && typeof orchestrator.getState === 'function'
        ? orchestrator.getState()
        : orchestrator && orchestrator.state;
      for (const turn of (state && state.turns) || []) {
        const entries = turn && turn.meta && Array.isArray(turn.meta.workflowSteps)
          ? turn.meta.workflowSteps
          : [];
        const entry = entries.find(item => item
          && item.runId === runIdValue
          && Number(item.stepIndex) === Number(stepIndex));
        if (entry) return { entry, turnNum: turn.n, turn, attempts:state.attempts || {} };
      }
    } catch (error) {
      logError('[workflow-engine] failed to inspect durable step evidence:', error);
    }
    return null;
  }

  function pendingStepTurn(meetingId, runIdValue, stepIndex) {
    if (typeof getOrchestrator !== 'function') return null;
    try {
      const orchestrator = getOrchestrator(meetingId);
      const state = orchestrator && typeof orchestrator.getState === 'function'
        ? orchestrator.getState()
        : orchestrator && orchestrator.state;
      for (const [turnNum, bySid] of Object.entries(state && state.pendingPrompts || {})) {
        for (const entry of Object.values(bySid || {})) {
          const workflowRun = entry && entry.workflowRun;
          if (workflowRun
            && workflowRun.runId === runIdValue
            && Number(workflowRun.stepIndex) === Number(stepIndex)) {
            const parsed = Number(turnNum);
            return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
          }
        }
      }
    } catch (error) {
      logError('[workflow-engine] failed to inspect pending step receipt:', error);
    }
    return null;
  }

  function resultIsSuccessful(result) {
    return !!(result
      && (!result.status || ['completed', 'manual_extracted'].includes(result.status))
      && String(result.text || '').trim());
  }

  function validateStepResult(meeting, targetMemberIds, dispatchResult) {
    if (!dispatchResult || dispatchResult.status !== 'completed') {
      return { ok: false, reason: dispatchResult && (dispatchResult.reason || dispatchResult.status) || 'step_not_completed' };
    }
    if (dispatchResult.interrupted || dispatchResult.superseded) {
      return { ok: false, takenOver: true, reason: dispatchResult.interrupted ? 'interrupted' : 'superseded' };
    }
    const expectedSids = targetMemberIds.map(id => sidOf(meeting, id)).filter(Boolean);
    const results = Array.isArray(dispatchResult.results) ? dispatchResult.results : [];
    const failed = expectedSids.map(sid => results.find(item => item && item.sid === sid))
      .filter(item => !resultIsSuccessful(item));
    if (expectedSids.length !== targetMemberIds.length) return { ok: false, reason: 'workflow_member_missing' };
    if (failed.length) {
      const first = failed[0];
      return { ok: false, reason: first && (first.reason || first.status) || 'participant_result_missing',
        reconciliationRequired:failed.some(item=>item?.failure?.category === 'reconciliation' || item?.reason === 'submission_unknown'),
        autoRetryAllowed:failed.every(item=>item?.failure?.autoRetry !== false) };
    }
    return { ok: true };
  }

  function evidenceIsSuccessful(evidence, targetCount) {
    const results = evidence && evidence.entry && Array.isArray(evidence.entry.results)
      ? evidence.entry.results
      : [];
    return results.length >= targetCount && results.slice(0, targetCount).every(result => {
      if (result && (!result.status || ['completed', 'manual_extracted'].includes(result.status)) && Number(result.textLength) > 0) return true;
      const sid=result?.sid, turn=evidence.turn, attempt=evidence.attempts?.[turn?.attemptIdBy?.[sid]];
      // An explicit sync can complete a previously uncertain step. Its exact
      // workflow attempt must match; another step's answer cannot skip this one.
      return !!(attempt && attempt.workflowRun?.runId === evidence.entry.runId
        && Number(attempt.workflowRun.stepIndex) === Number(evidence.entry.stepIndex)
        && turn?.byStatus?.[sid] === 'manual_extracted' && String(turn.by?.[sid] || '').trim());
    });
  }

  function dispatchResultFromEvidence(meeting, targetMemberIds, evidence) {
    const turn = evidence && evidence.turn || {};
    return {
      status: 'completed',
      turnNum: evidence && evidence.turnNum || null,
      results: targetMemberIds.map(memberId => {
        const sid = sidOf(meeting, memberId);
        return {
          sid,
          status: turn.byStatus && turn.byStatus[sid] || 'completed',
          text: turn.by && turn.by[sid] || '',
          recovered: true,
        };
      }),
      recovered: true,
    };
  }

  async function runSerial(meetingId, userInput, persistedState, runOptions = {}) {
    if (running.has(meetingId)) return null;
    const validation = validateSerial(meetingId);
    if (!validation.ok) return { status: 'paused', lastError: { reason: validation.reason, at: Date.now() } };
    const { meeting, workflow, steps } = validation;
    const conversation = Conversation.enabled(meeting);
    const stepConfigs = WT.normalizeStepConfigs(steps, workflow.stepConfigs);
    const maxAttempts = conversation ? 1 : Math.max(1, Math.min(3, Number(workflow.maxAttemptsPerStep) || 2));
    const state = persistedState && persistedState.status === 'running'
      ? {
          ...persistedState,
          attemptsByStep: { ...(persistedState.attemptsByStep || {}) },
          completedSteps: Array.isArray(persistedState.completedSteps) ? persistedState.completedSteps.slice() : [],
        }
      : {
          runId: runId('serial'),
          goal: String(userInput || '').trim(),
          status: 'running',
          nextStepIndex: 0,
          currentStepIndex: null,
          currentTurnNum: null,
          attemptsByStep: {},
          completedSteps: [],
          startedAt: Date.now(),
          lastError: null,
        };
    if (!state.goal) state.goal = String(userInput || '').trim();
    const entry = { abort: false, mode: 'serial', runId: state.runId, startedAt: Date.now() };
    running.set(meetingId, entry);
    const progress = (extra = {}) => {
      try {
        sendToRenderer('workflow:progress', {
          meetingId,
          kind: 'serial',
          runId: state.runId,
          goal: state.goal,
          status: state.status,
          nextStepIndex: state.nextStepIndex,
          currentStepIndex: state.currentStepIndex,
          currentTurnNum: state.currentTurnNum,
          totalSteps: steps.length,
          ...extra,
        });
      } catch (error) {
        logError('[workflow-engine] progress delivery failed:', error);
      }
    };
    try {
      persistSerial(meetingId, state);
      progress({ stage: 'start' });
      while (state.status === 'running' && state.nextStepIndex < steps.length) {
        if (entry.abort) { state.status = 'stopped_user'; break; }
        const index = state.currentStepIndex != null ? Number(state.currentStepIndex) : Number(state.nextStepIndex);
        const targetMemberIds = (steps[index] || []).filter(Boolean);

        // Crash window closure: dispatcher persists this evidence before its
        // Promise resolves. If Hub died after the provider answered but before
        // serialRunState advanced, do not execute the step twice.
        const recovered = stepEvidence(meetingId, state.runId, index);
        if (recovered && evidenceIsSuccessful(recovered, targetMemberIds.length)) {
          state.currentTurnNum = state.currentTurnNum || recovered.turnNum || null;
          if (!state.completedSteps.some(item => Number(item.stepIndex) === index)) {
            state.completedSteps.push({ stepIndex: index, completedAt: recovered.entry.completedAt || Date.now(), recovered: true });
          }
          state.nextStepIndex = stepConfigs[index]?.after === 'end' ? steps.length : index + 1;
          state.currentStepIndex = null;
          if (conversation) state.currentTurnNum = null;
          state.lastError = null;
          persistSerial(meetingId, state);
          progress({ stage: 'recovered-step', completedStepIndex: index });
          continue;
        }
        if (!state.currentTurnNum) {
          state.currentTurnNum = pendingStepTurn(meetingId, state.runId, index) || null;
        }

        const previousAttempts = Number(state.attemptsByStep[index]) || 0;
        const continuingStep = !!runOptions.restartContinuation && persistedState?.currentStepIndex === index;
        if (previousAttempts >= maxAttempts && !continuingStep) {
          state.status = 'paused';
          state.lastError = state.lastError || { stage: 'serial', stepIndex: index, reason: 'attempts_exhausted', at: Date.now() };
          break;
        }
        const attempt = previousAttempts + 1;
        state.currentStepIndex = index;
        state.attemptsByStep[index] = attempt;
        state.lastError = null;
        persistSerial(meetingId, state);
        progress({ stage: 'step', stepIndex: index, attempt });

        let dispatchResult = null;
        let failureReason = null;
        let reconciliationRequired = false;
        let autoRetryAllowed = true;
        try {
          for (const memberId of targetMemberIds) await ensureMemberReady(meeting, memberId);
          if (shouldNotDispatch(meetingId, entry)) { state.status = 'stopped_user'; break; }
          if (!conversation && !continuingStep && workflow.settingsVersion === 1 && Number(state.executedRounds || 0) - Number(state.budgetStart || 0) >= 6) {
            state.status = 'paused'; state.lastError = {reason:'已达 6 轮执行上限，保留现场并暂停',at:Date.now()}; break;
          }
          // Ordinary answer files remain editable; refresh them before a later
          // speaker receives context. No delivery hash or task gate is involved.
          if (conversation && typeof getOrchestrator === 'function') {
            require('../../core/group-answer-files').reconcile(getOrchestrator(meetingId));
          }
          let stepPrompt = conversation ? Conversation.prompt(state.goal,stepConfigs[index],index,steps.length) : WT.buildSerialStepPrompt(state.goal, stepConfigs[index], index, steps.length);
          if (!conversation && workflow.settingsVersion === 1) stepPrompt = require('../../core/workflow-settings').GENERAL + '\n\n' + stepPrompt;
          if (runOptions.restartContinuation) {
            stepPrompt = runOptions.restartContinuation + '\n\n' + stepPrompt;
            runOptions = {...runOptions,restartContinuation:null};
          }
          const timeoutMs = Math.max(60_000, Math.min(30 * 60_000, Number(stepConfigs[index] && stepConfigs[index].timeoutMs) || 10 * 60_000));
          state.executedRounds = Number(state.executedRounds || 0) + (continuingStep ? 0 : 1);
          persistSerial(meetingId, state);
          dispatchResult = await getDispatcher().dispatchGroupChatTurn(meetingId, {
            userInput: stepPrompt,
            targetMemberIds,
            reuseTurnNum: state.currentTurnNum || null,
            appendUserMessage: conversation ? index === 0 && !state.currentTurnNum : !state.currentTurnNum,
            displayUserInput: conversation ? state.goal : undefined,
            dispatchMode: conversation ? 'conversation' : 'serial',
            turnTimeoutMs: conversation ? undefined : timeoutMs,
            allowActiveExtend: false,
            workflowRun: {
              runId: state.runId,
              kind: conversation ? 'conversation' : 'serial',
              stepIndex: index,
              attempt,
              targetMemberIds,
            },
          });
          if (dispatchResult && dispatchResult.turnNum) state.currentTurnNum = dispatchResult.turnNum;
          const checked = validateStepResult(meeting, targetMemberIds, dispatchResult);
          if (checked.takenOver) {
            state.status = 'stopped_user';
            state.lastError = { stage: 'serial', stepIndex: index, reason: checked.reason, at: Date.now() };
            break;
          }
          if (!checked.ok) {failureReason = checked.reason;reconciliationRequired=checked.reconciliationRequired;autoRetryAllowed=checked.autoRetryAllowed !== false;}
        } catch (error) {
          failureReason = error && error.message || 'serial_step_exception';
          autoRetryAllowed = false;
          logError(`[workflow-engine] serial step ${index + 1} failed:`, error);
        }

        if (!failureReason) {
          state.completedSteps.push({ stepIndex: index, completedAt: Date.now(), attempt });
          state.nextStepIndex = stepConfigs[index]?.after === 'end' ? steps.length : index + 1;
          state.currentStepIndex = null;
          if (conversation) state.currentTurnNum = null;
          state.lastError = null;
          persistSerial(meetingId, state);
          progress({ stage: 'step-complete', completedStepIndex: index, attempt });
          continue;
        }

        state.lastError = { stage: 'serial', stepIndex: index, reason: failureReason, attempt, at: Date.now() };
        persistSerial(meetingId, state);
        if (attempt < maxAttempts && !entry.abort && !reconciliationRequired && autoRetryAllowed) {
          progress({ stage: 'step-retry', stepIndex: index, attempt, error: state.lastError });
          await sleep(500);
          continue;
        }
        state.status = entry.abort ? 'stopped_user' : 'paused';
      }

      if (conversation && state.status === 'stopped_user') state.status = 'paused';
      if (state.status === 'running' && state.nextStepIndex >= steps.length) state.status = 'done';
      state.currentStepIndex = null;
      persistSerial(meetingId, state);
      progress({ stage: state.status === 'done' ? 'done' : state.status, error: state.lastError });
      return state;
    } catch (error) {
      state.status = entry.abort ? 'stopped_user' : 'paused';
      state.lastError = { stage: 'serial-engine', reason: error && error.message || 'internal_error', at: Date.now() };
      try { persistSerial(meetingId, state); } catch (persistError) { logError('[workflow-engine] serial fatal persist failed:', persistError); }
      progress({ stage: 'paused', error: state.lastError });
      return state;
    } finally {
      if (running.get(meetingId) === entry) running.delete(meetingId);
    }
  }

  async function runLoop(meetingId, userInput, persistedLoopState, runOptions = {}) {
    if (running.has(meetingId)) { logger.log('[loop-engine] already running for ' + meetingId); return null; }
    let entry = null;
    let state = null;
    let config = null;
    try {
      const meeting = meetingManager.getMeeting(meetingId);
      if (!meeting) { logger.log('[loop-engine] meeting not found ' + meetingId); return null; }
      if (discussPhaseBlock(meeting)) { logger.log('[loop-engine] refuse to run: dev group is in discuss phase ' + meetingId); return null; }
      const wf = meeting.serialWorkflow || {};
      const steps = Array.isArray(wf.steps) ? wf.steps : [];
      const builderId = (steps[0] || [])[0];
      const reviewerIds = Array.from(new Set([].concat(...steps.slice(1)).filter(Boolean)));
      if (!builderId || !reviewerIds.length) { logger.log('[loop-engine] need builder + reviewer(s)'); return null; }
      config = buildConfig(wf.loop);

      let prevMerge = null, goal, resuming = false;
      // 用户明确开新一轮（给了新目标、没有沿用旧检查点）= 人工决定，损坏标记到此为止。
      const startingFresh = !persistedLoopState && String(userInput || '').trim();
      if (startingFresh) {
        const current = (meetingManager.getMeeting(meetingId) || {}).serialWorkflow || {};
        if (current.loopState && current.loopState.damaged) {
          try {
            meetingManager.updateMeeting(meetingId, {
              serialWorkflow: Object.assign({}, current, {
                loopState: Object.assign({}, current.loopState, { damaged: null }),
              }),
            });
          } catch (error) { logError('[loop-engine] 清除损坏标记失败:', error); }
        }
      }
      // 损坏标记是**持久**的：第一次暂停时如果把 round 归零再落盘，第二次点重发
      // 记录就已经「干净」了，于是照常派工 —— 这正是第四轮合并位复现的那条。
      // 所以既看这次传进来的记录，也看盘上留着的标记，两者任一命中就拒绝。
      const persistedDamage = ((meetingManager.getMeeting(meetingId) || {}).serialWorkflow || {}).loopState;
      const damage = describeLoopStateDamage(persistedLoopState)
        || (!startingFresh && persistedDamage && persistedDamage.damaged ? persistedDamage.damaged.detail : null);
      if (damage) {
        const damagedState = {
          status: 'paused', round: 0, phase: 'reaching', currentStep: null,
          // 原始的损坏值不覆盖、不修正，只加一个持久标记 —— 它是给人看的证据。
          damaged: { detail: damage, at: Date.now() },
          lastError: { stage: 'loop-engine', reason: 'state_record_damaged', detail: damage, at: Date.now() },
        };
        logger.log('[loop-engine] 持久状态不可信，停下来等人处理：' + damage);
        try {
          meetingManager.updateMeeting(meetingId, {
            serialWorkflow: Object.assign({}, meeting.serialWorkflow || {}, {
              loopState: Object.assign({}, persistedLoopState, damagedState),
            }),
          });
        } catch (error) { logError('[loop-engine] 损坏状态落盘失败:', error); }
        try { sendToRenderer('loop:progress', { meetingId, status: 'paused', stage: 'paused', error: damagedState.lastError }); }
        catch (error) { logError('[loop-engine] 损坏状态进度推送失败:', error); }
        return damagedState;
      }
      if (persistedLoopState && persistedLoopState.status === 'running') {
        const r = LC.resumeState(persistedLoopState); state = r.state; prevMerge = r.prevMerge; goal = state.goal || (userInput || '').trim(); resuming = true;
      } else { goal = (userInput || '').trim(); state = LC.newLoopState(); state.goal = goal; }
      state.runId = state.runId || runId('loop');
      state.currentTurnNum = state.currentTurnNum || null;
      entry = { abort: false, mode: 'loop', runId: state.runId, startedAt: Date.now() };
      running.set(meetingId, entry);
      // v2 migration: a legacy run that already entered polishing has passed its gate.
      // Do not revive the old self-refilling suggestion loop after restart.
      if (state.phase === 'polishing' && !config.polish.enabled) {
        state.phase = 'reaching';
        state.status = 'done';
        state.suggestionPool = [];
      }

      const stepConfigs = Array.isArray(wf.stepConfigs) ? wf.stepConfigs : [];
      const builderRolePrompt = (stepConfigs[0] && stepConfigs[0].prompt) || '';
      const reviewerRolePrompt = (stepConfigs[1] && stepConfigs[1].prompt) || '';
      const builderTimeoutMs = Math.max(60_000, Math.min(30 * 60_000,
        Number(stepConfigs[0] && stepConfigs[0].timeoutMs) || 10 * 60_000));
      // 回落值必须够跑两遍全量单测：合同要求评审 dry-run 一次、正式合并再一次，
      // 本机闲机一遍就 117 秒，机器忙时更长，还可能先在单测总入口的排队锁上等。
      // 老的 5 分钟连一遍都不够，缺配的群聊必然被误判成「评审没给裁决」。
      const reviewerTimeoutMs = Math.max(60_000, Math.min(30 * 60_000,
        Number(stepConfigs[1] && stepConfigs[1].timeoutMs) || 25 * 60_000));

      const originalDispatcher = getDispatcher();
      let restartContinuation = runOptions.restartContinuation;
      const dispatcher = restartContinuation ? {
        ...originalDispatcher,
        dispatchGroupChatTurn(id,args) {
          if (restartContinuation) {
            args={...args,userInput:restartContinuation+'\n\n'+args.userInput};
            restartContinuation=null;
          }
          return originalDispatcher.dispatchGroupChatTurn(id,args);
        },
      } : originalDispatcher;
      // MD 交接只对新建的双席位开发群聊启用；老房间和极简单席位一字不改。
      const useDocs = docsEnabled(meeting, reviewerIds);
      let docsDir = null;
      let docsDirError = null;
      if (useDocs) {
        try { docsDir = taskDirFor(meetingId); }
        catch (error) { docsDirError = error; logError('[loop-engine] 任务目录建不出来:', error); }
      }
      // 2026-09-08 合并位复现的阻断：这里原来是「建不出来就回落到聊天判定」——
      // 那是一次静默降级：交接闸门整个关掉，一份 MD 都没有也能把任务判成完成。
      // 开了 MD 交接就必须靠 MD 交接。目录出问题是环境问题，如实暂停等人处理。
      if (useDocs && !docsDir) {
        const stalled = {
          status: 'paused',
          currentStep: null,
          lastError: {
            stage: 'task-docs', reason: 'task_dir_unavailable',
            detail: (docsDirError && docsDirError.message) || '', at: Date.now(),
          },
        };
        logger.log('[loop-engine] 任务目录不可用，拒绝退回聊天判定 ' + meetingId);
        try {
          state.status = stalled.status;
          state.lastError = stalled.lastError;
          persist(meetingId, state, config);
          sendToRenderer('loop:progress', { meetingId, round: state.round, phase: state.phase, status: state.status, stage: 'paused', error: state.lastError });
        } catch (error) { logError('[loop-engine] 任务目录故障落盘失败:', error); }
        return state;
      }
      const docsOn = !!(useDocs && docsDir);
      if (docsOn) {
        const carried = Number(resuming ? persistedLoopState.posBase : state.posBase);
        state.posBase = Number.isInteger(carried) && carried > 0 ? carried : nextFreePosBase(meetingId, docsDir);
      }
      const progress = (extra) => {
        try { sendToRenderer('loop:progress', Object.assign({ meetingId, round: state.round, phase: state.phase, status: state.status }, extra || {})); }
        catch (error) { logError('[loop-engine] progress delivery failed:', error); }
      };
      const persistOrPause = () => {
        if (persist(meetingId, state, config)) return true;
        state.status = 'paused';
        state.lastError = { stage: 'persist', reason: 'workflow_state_persist_failed', at: Date.now() };
        progress({ stage: 'paused', error: state.lastError });
        return false;
      };
      logger.log('[loop-engine] ' + (resuming ? 'resume' : 'start') + ' meeting=' + meetingId + ' round=' + state.round + ' goal=' + goal);
      if (!persistOrPause()) return state;
      progress({ stage: 'start' });

      while (state.status === 'running') {
        // 停止意图落了盘，所以「运行中点停止」和「上次点了停止之后 Hub 重启」是同一回事。
        if (entry.abort || stopIntentOf(meetingId)) { state.status = 'stopped_user'; break; }
        if (state.round > config.stop.maxRounds + 2) { state.status = 'stopped_max'; break; } // 本地兜底

        const taskInfo = LC.builderTaskText(state, prevMerge, config);
        const posBase = Number(state.posBase) > 0 ? Number(state.posBase) : 1;
        const builderPos = posBase + state.round * 2;
        const reviewerPos = builderPos + 1;
        const builderPrompt = withLocator(withDocBlock(
          LC.PROMPTS.builder({ goal, cwd: config.cwd, firstRound: taskInfo.firstRound, phase: taskInfo.phase, taskText: taskInfo.taskText, rolePrompt: builderRolePrompt }),
          docsOn ? docsDir : null, builderPos,
          docsOn ? acceptedDocPaths(meetingId, docsDir, builderPos) : [],
        ), meeting, userTaskTextOf(meetingId, goal));
        state.currentStep = 'builder'; state.attempt = state.round + 1; state.lastError = null;
        if (!persistOrPause()) break;
        progress({ stage: 'builder', round: state.round + 1 });
        let bRes = null;
        const builderStepIndex = state.round * 2;
        // 派发前先重扫一次预期完成文件：丢事件、Hub 重启后文件其实已经在了，
        // 都靠这一次重读认出来 —— 不要求 agent 再改一次名，也不重复派工（B04 / D02 / D03）。
        const builderPreAccepted = docsOn ? checkDeliveryOnce(meetingId, docsDir, builderPos) : null;
        if (needsHumanBeforeDispatch(builderPreAccepted)) {
          const spec = DOCS.docSpecForPos(builderPos) || {};
          state.status = 'paused';
          state.currentStep = 'builder';
          state.lastError = {
            stage: 'builder', reason: 'handoff_' + builderPreAccepted.status,
            detail: builderPreAccepted.reason || '', doc: spec.done || '', dir: docsDir, at: Date.now(),
          };
          logger.log('[loop-engine] 已接收的协作手册被改动，派发前停在待核对');
          persistOrPause();
          break;
        }
        const builderEvidence = deliveryAccepted(builderPreAccepted)
          ? null : stepEvidence(meetingId, state.runId, builderStepIndex);
        if (deliveryAccepted(builderPreAccepted)) {
          bRes = deliveredWithoutDispatch(meeting, [builderId], state.currentTurnNum, '（本阶段协作手册已接收，不重复派工）');
          progress({ stage: 'builder-delivered', round: state.round + 1 });
        } else if (builderEvidence && evidenceIsSuccessful(builderEvidence, 1)) {
          bRes = dispatchResultFromEvidence(meeting, [builderId], builderEvidence);
          state.currentTurnNum = bRes.turnNum;
          progress({ stage: 'builder-recovered', round: state.round + 1 });
        } else {
          if (!state.currentTurnNum) state.currentTurnNum = pendingStepTurn(meetingId, state.runId, builderStepIndex) || null;
          const restartLimit = restartContinuation && persistedLoopState?.currentStep === 'builder' && persistedLoopState.round === state.round
            ? Math.max(2, (Number(state.stepAttempt) || 0) + 1) : 2;
          for (let transportAttempt = Math.max(0, Number(state.stepAttempt) || 0) + 1; transportAttempt <= restartLimit; transportAttempt += 1) {
            state.stepAttempt = transportAttempt;
            if (!persistOrPause()) break;
            // 停止可能正好落在上一次重试的等待窗口里 —— 判断要贴着派发这一刻做（第五轮阻断）。
            if (shouldNotDispatch(meetingId, entry)) break;
            try {
              await ensureMemberReady(meeting, builderId);
              if (shouldNotDispatch(meetingId, entry)) break;
              bRes = await dispatcher.dispatchGroupChatTurn(meetingId, {
                userInput: builderPrompt,
                targetMemberIds: [builderId],
                reuseTurnNum: state.currentTurnNum || null,
                appendUserMessage: !state.currentTurnNum,
                dispatchMode: 'serial',
                turnTimeoutMs: builderTimeoutMs,
                // PTY 还在输出 = agent 还在干活（多半正在跑测试或等排队锁）。
                // 到点强杀会把「在验证」误判成「没给结果」。延期由 dispatcher 封顶
                //（最近 150 秒内有输出才延，总共最多 +8 分钟），不会拖成永久等待。
                allowActiveExtend: true,
                workflowRun: { runId: state.runId, kind: 'loop', stepIndex: builderStepIndex, attempt: transportAttempt, targetMemberIds: [builderId] },
              });
              if (bRes && bRes.turnNum) state.currentTurnNum = bRes.turnNum;
              const checked = validateStepResult(meeting, [builderId], bRes);
              if (checked.takenOver) break;
              if (checked.ok) break;
              state.lastError = { stage: 'builder', reason: checked.reason, attempt: transportAttempt, at: Date.now() };
              if (checked.reconciliationRequired || checked.autoRetryAllowed === false) break;
            } catch (e) {
              state.lastError = { stage: 'builder', reason: (e && e.message) || 'builder_error', attempt: transportAttempt, at: Date.now() };
              logError('[loop-engine] builder turn failed:', e);
              break; // No receipt proves this exception is safe to replay.
            }
            if (!persistOrPause()) break;
            if (transportAttempt < 2 && !entry.abort) {
              progress({ stage: 'builder-retry', round: state.round + 1, attempt: transportAttempt, error: state.lastError });
              await sleep(500);
            }
          }
        }
        // 停止是在重试等待窗口里到的：跳出重试后要落成「用户停止」，
        // 而不是让下面的结果校验把它记成一次「步骤失败」。
        // 但停止只挡「派下一位」，不挡「接收交付」—— 盘上已经躺着的交付要照常收下，
        // 否则用户点一次停止就把 agent 已经交出来的东西作废了（任务书 4.1 两段式）。
        if (entry.abort || stopIntentOf(meetingId)) {
          if (docsOn) checkDeliveryOnce(meetingId, docsDir, builderPos);
          state.status = 'stopped_user';
          state.currentStep = null;
          persistOrPause();
          break;
        }
        const builderChecked = validateStepResult(meeting, [builderId], bRes);
        if (!builderChecked.ok && !builderChecked.takenOver) {
          state.status = 'paused';
          state.lastError = state.lastError || { stage: 'builder', reason: builderChecked.reason, at: Date.now() };
          logger.log('[loop-engine] builder not completed: ' + state.lastError.reason); break;
        }
        // 运行中被用户接管（2026-07-29 maintainer）：用户点「停止本轮」(interrupted) 或直接
        //   追问下一题把本步抢占掉 (superseded) —— 语义明确定为「中断整个循环」，不是
        //   「排到下一步」：后续步骤的 prompt 依赖本步产出，本步已经作废，再往下跑只会
        //   拿空结果编排出垃圾。用户接管后由用户自己决定要不要重启循环。
        if (bRes.interrupted || bRes.superseded) {
          state.status = 'stopped_user';
          state.currentStep = null;
          logger.log('[loop-engine] builder turn taken over by user (' + (bRes.interrupted ? 'interrupted' : 'superseded') + '), stopping loop');
          break;
        }
        const turnNum = bRes.turnNum;
        state.currentTurnNum = turnNum;
        state.stepAttempt = 0;

        // 工作位这一步也可能被 idle timer 提前结算（它跑测试时转录同样是静默的）。
        // 不等它把 PROGRESS 交出来就派审查，评审看到的会是还在改的半成品分支。
        //
        // 但这里的等待预算比评审那边小一个量级，理由是两边的性质不同：
        //   评审的裁决是闸门必需品，拿不到就没法判 —— 值得等满。
        //   工作位的 PROGRESS 只是给人看的汇报，缺了不影响流程正确性 ——
        //   万一它就是没按合同输出，不该让每一轮都白等一分钟。
        // 10 秒足以跨过一次工具调用造成的静默，这才是这个等待真正要解决的问题。
        // 没走 MD 交接的房间保留原判定：等它把 PROGRESS 交出来再派审查。
        // 走 MD 交接的房间下面那道文件闸门更硬，这一等就纯属浪费，跳过。
        if (!docsOn) {
          await awaitStepText(meetingId, turnNum, sidOf(meeting, builderId),
            textFrom(bRes.results, sidOf(meeting, builderId)), hasProgressCard,
            { isAborted: () => !!entry.abort, quietMs: BUILDER_QUIET_MS, capMs: BUILDER_WAIT_CAP_MS });
        }

        // ── 交付闸门 A：本阶段协作手册被接收了吗 ──
        // 「回复结束」不算。接收不了就保留当前阶段、写清具体原因，不判代码 FAIL、
        // 不重开一轮 —— 维护者点「继续」时从这里接着走，成果和文档都还在。
        if (docsOn) {
          const outcome = deliveryAccepted(builderPreAccepted)
            ? builderPreAccepted
            : await awaitDelivery(meetingId, docsDir, builderPos, { isAborted: () => !!entry.abort });
          if (!deliveryAccepted(outcome)) {
            const spec = DOCS.docSpecForPos(builderPos) || {};
            state.status = 'paused';
            state.currentStep = 'builder';
            state.lastError = {
              stage: 'builder', reason: 'handoff_' + (outcome.status || 'pending'),
              detail: outcome.reason || '', missing: outcome.missing || null,
              doc: spec.done || '', dir: docsDir, at: Date.now(),
            };
            logger.log('[loop-engine] 协作手册尚未接收：' + state.lastError.reason + ' → ' + state.lastError.doc);
            persistOrPause();
            break;
          }
        }

        // 「交付接收成立」和「现在能不能派下一位」是两件事。用户在等文件的这段时间里
        // 点了停止，迟到的文件不许把审查派出去 —— 交付凭据留着，人回来接着走（任务书 D06）。
        if (entry.abort || stopIntentOf(meetingId)) {
          state.status = 'stopped_user';
          state.currentStep = null;
          logger.log('[loop-engine] 用户已停止，交付保留但不派下一位 ' + meetingId);
          persistOrPause();
          break;
        }

        const reviewerPrompt = withLocator(withDocBlock(
          LC.PROMPTS.reviewer({ goal, cwd: config.cwd, rolePrompt: reviewerRolePrompt }),
          docsOn ? docsDir : null, reviewerPos,
          docsOn ? acceptedDocPaths(meetingId, docsDir, reviewerPos) : [],
        ), meeting, userTaskTextOf(meetingId, goal));
        // 【同席位必须另起一轮】评审这一步平时复用工作位那一轮（同一轮里两批不同成员，
        // 各占各的格子）。但「极简」是同一个人先实现再自审 —— 一轮里每位成员只有一格
        // （orchestrator 的 by[sid]），复用就等于让评审的回答顶掉刚落盘的实现报告：
        // 群聊里那条 PROGRESS/VERIFIED 消失，工作台的交付卡也跟着没了，而流程还显示成功。
        // 判据是身份不是模板：只要评审名单里出现工作位自己，就换成新的一轮。
        const reviewerReusesBuilderTurn = !reviewerIds.includes(builderId);
        // 传输重试要落回同一轮：第一次尝试已经开了一轮，第二次再开一轮只会在群聊里
        // 多出一条空壳。拿到真实轮号后就钉住它。
        let reviewerTurnNum = reviewerReusesBuilderTurn ? turnNum : null;
        state.currentStep = 'reviewer'; state.lastError = null;
        if (!persistOrPause()) break;
        progress({ stage: 'reviewer', round: state.round + 1 });
        let rRes = null;
        const reviewerStepIndex = state.round * 2 + 1;
        const reviewerPreAccepted = docsOn ? checkDeliveryOnce(meetingId, docsDir, reviewerPos) : null;
        if (needsHumanBeforeDispatch(reviewerPreAccepted)) {
          const spec = DOCS.docSpecForPos(reviewerPos) || {};
          state.status = 'paused';
          state.currentStep = 'reviewer';
          state.lastError = {
            stage: 'reviewer', reason: 'handoff_' + reviewerPreAccepted.status,
            detail: reviewerPreAccepted.reason || '', doc: spec.done || '', dir: docsDir, at: Date.now(),
          };
          logger.log('[loop-engine] 已接收的合并手册被改动，派发前停在待核对');
          persistOrPause();
          break;
        }
        const reviewerEvidence = deliveryAccepted(reviewerPreAccepted)
          ? null : stepEvidence(meetingId, state.runId, reviewerStepIndex);
        if (deliveryAccepted(reviewerPreAccepted)) {
          rRes = deliveredWithoutDispatch(meeting, reviewerIds, reviewerTurnNum, '（本阶段合并手册已接收，不重复派工）');
          progress({ stage: 'reviewer-delivered', round: state.round + 1 });
        } else if (reviewerEvidence && evidenceIsSuccessful(reviewerEvidence, reviewerIds.length)) {
          rRes = dispatchResultFromEvidence(meeting, reviewerIds, reviewerEvidence);
          progress({ stage: 'reviewer-recovered', round: state.round + 1 });
        } else {
          const restartLimit = restartContinuation && persistedLoopState?.currentStep === 'reviewer' && persistedLoopState.round === state.round
            ? Math.max(2, (Number(state.stepAttempt) || 0) + 1) : 2;
          for (let transportAttempt = Math.max(0, Number(state.stepAttempt) || 0) + 1; transportAttempt <= restartLimit; transportAttempt += 1) {
            state.stepAttempt = transportAttempt;
            if (!persistOrPause()) break;
            // 同上：等待窗口里点的停止同样算数。
            if (shouldNotDispatch(meetingId, entry)) break;
            try {
              for (const rid of reviewerIds) await ensureMemberReady(meeting, rid);
              if (shouldNotDispatch(meetingId, entry)) break;
              rRes = await dispatcher.dispatchGroupChatTurn(meetingId, {
                userInput: reviewerPrompt,
                targetMemberIds: reviewerIds,
                reuseTurnNum: reviewerTurnNum,
                appendUserMessage: false,
                dispatchMode: 'serial',
                turnTimeoutMs: reviewerTimeoutMs,
                // 同上：评审跑两遍全量时转录会长时间只有工具输出，不能按死墙钟砍。
                allowActiveExtend: true,
                workflowRun: { runId: state.runId, kind: 'loop', stepIndex: reviewerStepIndex, attempt: transportAttempt, targetMemberIds: reviewerIds },
              });
              if (rRes && rRes.turnNum) reviewerTurnNum = rRes.turnNum;
              const checked = validateStepResult(meeting, reviewerIds, rRes);
              if (checked.takenOver) break;
              if (checked.ok) break;
              state.lastError = { stage: 'reviewer', reason: checked.reason, attempt: transportAttempt, at: Date.now() };
              if (checked.reconciliationRequired || checked.autoRetryAllowed === false) break;
            } catch (e) {
              state.lastError = { stage: 'reviewer', reason: (e && e.message) || 'reviewer_error', attempt: transportAttempt, at: Date.now() };
              logError('[loop-engine] reviewer turn failed:', e);
              break; // No receipt proves this exception is safe to replay.
            }
            if (!persistOrPause()) break;
            if (transportAttempt < 2 && !entry.abort) {
              progress({ stage: 'reviewer-retry', round: state.round + 1, attempt: transportAttempt, error: state.lastError });
              await sleep(500);
            }
          }
        }
        if (entry.abort || stopIntentOf(meetingId)) {
          if (docsOn) checkDeliveryOnce(meetingId, docsDir, reviewerPos);
          state.status = 'stopped_user';
          state.currentStep = null;
          persistOrPause();
          break;
        }
        const reviewerChecked = validateStepResult(meeting, reviewerIds, rRes);
        if (!reviewerChecked.ok && !reviewerChecked.takenOver) {
          state.status = 'paused';
          state.lastError = state.lastError || { stage: 'reviewer', reason: reviewerChecked.reason, at: Date.now() };
          logger.log('[loop-engine] reviewer not completed: ' + state.lastError.reason); break;
        }
        // 同 builder：评审步被中断/被新提问抢占 → 停整个循环，不拿空 verdict 推进 gate。
        if (rRes.interrupted || rRes.superseded) {
          state.status = 'stopped_user';
          state.currentStep = null;
          logger.log('[loop-engine] reviewer turn taken over by user (' + (rRes.interrupted ? 'interrupted' : 'superseded') + '), stopping loop');
          break;
        }

        // 结算文本可能是 idle timer 提前触发时抓到的开场白（见上方 awaitVerdictText 注释）。
        // 判裁决前先等文本真的不再增长，避免把「还在验证」误读成「没给裁决」。
        const verdictTurnNum = rRes.turnNum || turnNum;
        const reviews = [];
        if (docsOn) {
          // ── 交付闸门 B：本阶段合并手册被接收了吗 ──
          // 裁决以已接收的合并手册为权威依据。群聊回执缺失不卡流程（任务书 B07），
          // 但两者**明确矛盾**时不猜，停在待核对（B08）。
          const outcome = deliveryAccepted(reviewerPreAccepted)
            ? reviewerPreAccepted
            : await awaitDelivery(meetingId, docsDir, reviewerPos, { isAborted: () => !!entry.abort });
          const spec = DOCS.docSpecForPos(reviewerPos) || {};
          if (!deliveryAccepted(outcome)) {
            state.status = 'paused';
            state.currentStep = 'reviewer';
            state.lastError = {
              stage: 'reviewer', reason: 'handoff_' + (outcome.status || 'pending'),
              detail: outcome.reason || '', missing: outcome.missing || null,
              doc: spec.done || '', dir: docsDir, at: Date.now(),
            };
            logger.log('[loop-engine] 合并手册尚未接收：' + state.lastError.reason + ' → ' + state.lastError.doc);
            persistOrPause();
            break;
          }
          const docRead = DOCS.readDelivery(docsDir, spec.done);
          if (docRead.status !== 'ok') {
            state.status = 'paused';
            state.currentStep = 'reviewer';
            state.lastError = { stage: 'reviewer', reason: 'handoff_reread_failed', detail: docRead.reason || '', doc: spec.done || '', dir: docsDir, at: Date.now() };
            persistOrPause();
            break;
          }
          const rid = reviewerIds[0];
          const docVerdict = LC.parseVerdict(docRead.content);
          const chatVerdict = LC.parseVerdict(textFrom(rRes.results, sidOf(meeting, rid)));
          // 2026-09-08 合并位复现的阻断：矛盾原来只在内存里判一次。用户点「继续」时
          // 这一步已经接收过、不再重新派发，聊天文本变成占位符，矛盾就凭空消失、
          // 任务直接变成完成 —— 期间没人改过文档，也没人重新审查过。
          // 所以矛盾要连同**当时那份手册的指纹**一起记进账本：指纹没变就说明这份交付
          // 一个字没动，矛盾自然还在，再点多少次继续都还是待核对。
          const freshConflict = (chatVerdict && docVerdict && chatVerdict.decision !== docVerdict.decision)
            ? {
                fingerprint: docRead.fingerprint,
                docDecision: docVerdict.decision, chatDecision: chatVerdict.decision, at: Date.now(),
              }
            : null;
          const priorConflict = DOCS.unresolvedConflictAt(readDocLedger(meetingId, docsDir), reviewerPos, docRead.fingerprint);
          const conflict = freshConflict || priorConflict;
          if (conflict) {
            if (freshConflict) {
              try { saveDocLedger(meetingId, DOCS.withConflict(readDocLedger(meetingId, docsDir), reviewerPos, freshConflict)); }
              catch (error) { logError('[loop-engine] 裁决矛盾落盘失败:', error); }
            }
            state.status = 'paused';
            state.currentStep = 'reviewer';
            state.lastError = {
              stage: 'reviewer', reason: 'verdict_conflict',
              detail: '合并手册判 ' + String(conflict.docDecision).toUpperCase()
                + '，群聊里说的是 ' + String(conflict.chatDecision).toUpperCase()
                + '；这份手册一个字没改过，需要你来定',
              doc: spec.done || '', dir: docsDir, at: Date.now(),
            };
            logger.log('[loop-engine] 手册与群聊裁决矛盾，停在待核对'
              + (freshConflict ? '' : '（这是上次就记下的，文档没有变化）'));
            persistOrPause();
            break;
          }
          reviews.push({ from: labelOf(meeting, rid), verdict: docVerdict, raw: docRead.content, source: 'doc' });
        } else {
          for (const rid of reviewerIds) {
            const sid = sidOf(meeting, rid);
            const raw = await awaitVerdictText(meetingId, verdictTurnNum, sid, textFrom(rRes.results, sid), {
              isAborted: () => !!entry.abort,
            });
            reviews.push({ from: labelOf(meeting, rid), verdict: LC.parseVerdict(raw), raw });
          }
        }
        // 评审席位根本没能力干活（额度用尽 / 被限流 / 掉登录），不是「答了但没给裁决」。
        // 这两者对用户的意义完全不同：前者换个人就好，后者才是任务本身的问题。
        // 不区分的话，引擎会把它当 fail 再派工作位重做 —— 而工作位每轮都只能回答
        // 「阻断项是评审没出裁决，我改不了」，白烧满 3 轮，最后报「返工用尽」，
        // 维护者看到的却是「任务太难」。实测就是这么烧掉两轮的。
        const unavailable = reviews.filter(r => !r.verdict && LC.looksUnavailable(r.raw));
        if (unavailable.length === reviews.length && reviews.length > 0) {
          state.status = 'reviewer_unavailable';
          state.currentStep = null;
          state.lastError = {
            stage: 'reviewer', reason: 'reviewer_unavailable',
            detail: (unavailable[0].raw || '').slice(0, 200), at: Date.now(),
          };
          logger.log('[loop-engine] reviewer unavailable, stopping instead of burning rounds: '
            + (unavailable[0].raw || '').slice(0, 120));
          persistOrPause();
          break;
        }

        const merge = LC.mergeVerdicts(reviews); prevMerge = merge;
        LC.advanceLoopState(state, merge, config, Date.now());
        state.currentStep = null; state.currentTurnNum = null; state.stepAttempt = 0; state.lastError = null;
        logger.log('[loop-engine] round=' + state.round + ' phase=' + state.phase + ' pass=' + merge.pass + ' status=' + state.status);
        if (!persistOrPause()) break;
        progress({ stage: 'advanced' });
      }

      persistOrPause();
      try {
        const html = LC.buildReportHtml(goal, state, config, { builderLabel: labelOf(meeting, builderId), reviewerLabels: reviewerIds.map((r) => labelOf(meeting, r)).join('+'), finishedAt: formatBeijingDateTime(Date.now()) });
        const p = writeReport(html); if (p) logger.log('[loop-engine] report → ' + p);
      } catch (e) { logger.log('[loop-engine] report err: ' + (e && e.message)); }
      progress({ stage: state.status === 'paused' ? (state.currentStep || 'paused') : 'done', status: state.status, error: state.lastError || null });
      logger.log('[loop-engine] finished ' + meetingId + ' status=' + state.status + ' rounds=' + state.round);
      // 'done' 是唯一「评审给了 pass、gate 也过了」的收尾状态；stopped_max / stopped_stuck /
      //   paused / reviewer_unavailable 都是没做完，那些房间要留着让维护者进去看现场。
      //   顺利完成的房间没人再需要它的 PTY，主动整间收走，别等 5 小时闲置巡检一个个来收。
      if (state.status === 'done') {
        try {
          suspendMeetingRoom(meetingId, {
            meetingManager, sessionManager, sendToRenderer, logger, reason: 'loop-passed',
          });
        } catch (error) { logError('[loop-engine] 整间休眠失败:', error); }
      }
      return state;
    } catch (error) {
      logError('[loop-engine] unhandled runtime failure:', error);
      if (!state) {
        return { status: 'paused', lastError: { stage: 'loop-engine', reason: error && error.message || 'internal_error', at: Date.now() } };
      }
      state.status = entry && entry.abort ? 'stopped_user' : 'paused';
      state.lastError = { stage: 'loop-engine', reason: error && error.message || 'internal_error', at: Date.now() };
      if (config) persist(meetingId, state, config);
      try { sendToRenderer('loop:progress', { meetingId, round: state.round, phase: state.phase, status: state.status, stage: state.status, error: state.lastError }); }
      catch (progressError) { logError('[loop-engine] fatal progress delivery failed:', progressError); }
      return state;
    } finally {
      if (entry && running.get(meetingId) === entry) running.delete(meetingId);
    }
  }

  // ── 项目定位（任务书第七节 / E01–E04）────────────────────────────────────
  //
  // 界面上那个工作目录不是真相。它可能是默认工作根、可能压根不存在、也可能指着
  // 另一个同样有效但不相干的仓库。这里做两件事：给每一步的 prompt 附上一段
  // 「先核实现场」的说明（含唯一确认 / 多候选只问一个问题 / worktree 也算数 /
  // 不许全盘扫），以及在开题报告被接收后，把它声明的项目根**绑到这个群**，
  // 让实现位和审查位之后用的是同一个已核实路径。

  /**
   * 「任务原文」= 维护者自己说过的话。定位要靠它去比对项目库，
   * 所以不能只拿调用方顺手传的字符串 —— 开题那一步压根没有别的来源。
   * 只取 origin==='user' 的消息：Hub 自己生成的阶段指令不是任务线索。
   */
  function userTaskTextOf(meetingId, fallback) {
    const parts = [];
    try {
      const orchestrator = typeof getOrchestrator === 'function' ? getOrchestrator(meetingId) : null;
      const messages = (orchestrator && orchestrator.state && orchestrator.state.messages) || [];
      for (const message of messages) {
        if (!message || message.role !== 'user' || message.origin !== 'user') continue;
        const text = String(message.content || '').trim();
        if (text) parts.push(text);
      }
    } catch (error) { logError('[loop-engine] 读取任务原文失败:', error); }
    const tail = parts.slice(-5).join(NEWLINE);
    return [String(fallback || '').trim(), tail].filter(Boolean).join(NEWLINE);
  }

  function locatorBlockFor(meeting, taskText) {
    try {
      const workflow = (meeting && meeting.serialWorkflow) || {};
      const launch = LOCATOR.resolveLaunchDir(meeting && meeting.workspace, workflow.workRootPath || null);
      return LOCATOR.buildLocatorBlock({
        taskText,
        projects: new (require('../../core/prepared-project-registry').PreparedProjectRegistry)({ dataDir: hubDataDir() }).list().items,
        launch: launch.dir ? launch : { ...launch, dir: (meeting && meeting.workspace) || '' },
        atWorkRoot: workflow.workRoot === true,
      });
    } catch (error) {
      logError('[loop-engine] 定位说明生成失败:', error);
      return '正式项目库读取失败：' + error.message + '。不要使用旧项目快照或按同名副本猜选；明确的用户项目路径仍需只读核实。';
    }
  }

  function withLocator(prompt, meeting, taskText) {
    const block = locatorBlockFor(meeting, taskText);
    return block ? `${prompt}\n\n${block}` : prompt;
  }

  /**
   * 开题报告里那一行「项目根：<绝对路径>」。核实通过就把群聊的工作现场绑过去。
   * 核实不过（目录不在 / 是聚合根 / 不是仓库）就**不动**原设置，只记一条原因 ——
   * 猜错的代价是在错仓库里动手。
   */
  function bindProjectRootFromReport(meetingId, reportPath) {
    try {
      if (!reportPath || !fsx.existsSync(reportPath)) return null;
      const declared = LOCATOR.extractDeclaredProjectRoot(fsx.readFileSync(reportPath, 'utf8'));
      if (!declared) return { ok: false, reason: 'not_declared' };
      const verified = LOCATOR.verifyDeclaredProjectRoot(declared);
      if (!verified.ok) {
        logger.log('[loop-engine] 开题报告声明的项目根没通过核实：' + declared + ' → ' + verified.reason);
        return verified;
      }
      const meeting = meetingManager.getMeeting(meetingId);
      const current = meeting && meeting.workspace ? String(meeting.workspace) : '';
      if (path.resolve(current || '') === verified.path) return { ok: true, path: verified.path, unchanged: true };
      meetingManager.updateMeeting(meetingId, { workspace: verified.path });
      logger.log('[loop-engine] 项目现场已绑定到已核实路径：' + verified.path);
      return { ok: true, path: verified.path, previous: current };
    } catch (error) {
      logError('[loop-engine] 绑定项目根失败:', error);
      return { ok: false, reason: (error && error.message) || 'bind_failed' };
    }
  }

  // ── 开题（步骤位置 0）───────────────────────────────────────────────────
  //
  // 普通开发群聊建好后先自由讨论；维护者点「开题」时指定一位执笔者，
  // 只给他派活（两个人一起写会写重）。报告改名成「已完成-开题报告.md」被接收后
  // **自动开工**，不再要维护者点第二次 —— 点「开题」那一下就已经包含了这份授权。
  //
  // 这里不做自动恢复 prompt：Hub 重启后只重新读一次文件（dispatch:false），
  // 认出已经交付就接着开工，认不出就保留在开题阶段等维护者点「重发本轮」。

  function kickoffAuthorOf(workflow, requested) {
    const steps = Array.isArray(workflow && workflow.steps) ? workflow.steps : [];
    const builderId = (steps[0] || [])[0] || null;
    const known = new Set([].concat(...steps).filter(Boolean).map(String));
    const asked = String(requested || '').trim();
    // 指定的人必须真的在这个工作流里，否则回落到工作位（默认执笔者）。
    return asked && known.has(asked) ? asked : builderId;
  }

  async function _kickoffPhase(meetingId, options = {}) {
    if (running.has(meetingId)) return { ok: false, reason: 'already_running' };
    const meeting = meetingManager.getMeeting(meetingId);
    if (!meeting || !meeting.groupChat || meeting.scene !== 'dev') {
      return { ok: false, reason: 'group_chat_not_found' };
    }
    const workflow = meeting.serialWorkflow || {};
    const authorId = kickoffAuthorOf(workflow, options.authorMemberId);
    if (!authorId) return { ok: false, reason: 'no_author' };
    let dir = null;
    try { dir = taskDirFor(meetingId); }
    catch (error) { logError('[loop-engine] 开题任务目录建不出来:', error); return { ok: false, reason: 'task_dir_unavailable' }; }

    const entry = { abort: false, mode: 'kickoff', runId: runId('kickoff'), startedAt: Date.now() };
    running.set(meetingId, entry);
    const emit = (stage, extra) => {
      try { sendToRenderer('loop:progress', Object.assign({ meetingId, kind: 'kickoff', stage, status: 'running' }, extra || {})); }
      catch (error) { logError('[loop-engine] kickoff progress delivery failed:', error); }
    };
    const saveKickoff = (patch) => {
      const current = (meetingManager.getMeeting(meetingId) || {}).serialWorkflow || {};
      meetingManager.updateMeeting(meetingId, {
        serialWorkflow: Object.assign({}, current, {
          devPhase: patch.devPhase || current.devPhase,
          kickoff: Object.assign({}, current.kickoff, patch.kickoff || {}),
        }),
      });
    };
    try {
      // 派发前先看一眼：报告可能已经在了（丢事件、上次被停住、用户手动放好）。
      // 已经能接收就别再派一次开题 —— 那等于让它把同一份任务书重写一遍。
      const preAccepted = checkDeliveryOnce(meetingId, dir, 0);
      const shouldDispatch = options.dispatch !== false && !deliveryAccepted(preAccepted);
      if (shouldDispatch) {
        saveKickoff({
          devPhase: 'kickoff',
          kickoff: { status: 'running', authorMemberId: authorId, runId: entry.runId, startedAt: Date.now() },
        });
        emit('kickoff-dispatch', { authorMemberId: authorId });
        const prompt = options.restartContinuation || withLocator(withDocBlock(
          DevDiscuss.buildKickoffPrompt({ locator: '' }),
          dir, 0, [],
        ), meeting, userTaskTextOf(meetingId, options.taskText));
        // 2026-09-08 合并位在真实 CLI 上撞到的：CLI 还没起来，派发以 cli_not_ready 失败，
        // 而这里原来只 await、从不看结果 —— 于是界面显示「正在等开题报告」，
        // 实际上一个字都没送进 CLI，用户完全看不出区别。
        // 修法和循环那两步一致：有界传输重试 + 结果校验；仍然失败就明说是派发失败，
        // 把真实原因带出来，不含混地等。
        let dispatchFailure = null;
        let dispatchStopped = false;
        for (let transportAttempt = 1; transportAttempt <= 2; transportAttempt += 1) {
          dispatchFailure = null;
          // 2026-09-08 第五轮：这两个判断原来放在 sleep(500) **之前**，
          // 于是「停止」或「报告」正好落在那 500ms 等待窗口里就被漏掉，照样派第二次。
          // 判断必须贴着派发这一刻做 —— 等待期间发生的事同样算数。
          if (transportAttempt > 1) {
            if (shouldNotDispatch(meetingId, entry)) {
              logger.log('[loop-engine] 用户已停止，开题不再重试派发');
              dispatchStopped = true;
              break;
            }
            if (deliveryAccepted(checkDeliveryOnce(meetingId, dir, 0))) {
              logger.log('[loop-engine] 开题报告其实已经交付，回执丢了也不重派');
              dispatchFailure = null;
              break;
            }
          }
          try {
            await ensureMemberReady(meeting, authorId);
            // 恢复会话可能等了很久，停止就发生在这段等待里 —— 派之前再问一次。
            if (shouldNotDispatch(meetingId, entry)) { dispatchStopped = true; break; }
            const dispatched = await getDispatcher().dispatchGroupChatTurn(meetingId, {
              userInput: prompt,
              targetMemberIds: [authorId],
              appendUserMessage: true,
              dispatchMode: 'serial',
              turnTimeoutMs: 20 * 60_000,
              allowActiveExtend: true,
              workflowRun: { runId: entry.runId, kind: 'kickoff', stepIndex: 0, attempt: transportAttempt, targetMemberIds: [authorId] },
            });
            const checked = validateStepResult(meeting, [authorId], dispatched);
            if (checked.ok || checked.takenOver) break;
            dispatchFailure = checked.reason || 'kickoff_dispatch_failed';
          } catch (error) {
            dispatchFailure = (error && error.message) || 'kickoff_dispatch_exception';
          }
          if (!dispatchFailure || transportAttempt >= 2) continue;
          logger.log('[loop-engine] 开题派发失败，重试一次：' + dispatchFailure);
          await sleep(500);
        }
        if (dispatchStopped) {
          saveKickoff({ kickoff: { status: 'awaiting_report', lastReason: 'user_stop', updatedAt: Date.now() } });
          return { ok: false, reason: 'stopped_by_user', authorMemberId: authorId };
        }
        if (dispatchFailure) {
          // 回执丢了不等于没送到：先看一眼报告是不是其实已经交了（任务书 D04）。
          const salvaged = checkDeliveryOnce(meetingId, dir, 0);
          if (!deliveryAccepted(salvaged)) {
            saveKickoff({ kickoff: { status: 'dispatch_failed', lastReason: dispatchFailure, updatedAt: Date.now() } });
            emit('kickoff-dispatch-failed', { reason: dispatchFailure, authorMemberId: authorId });
            logger.log('[loop-engine] 开题 prompt 没能送进 CLI：' + dispatchFailure);
            return { ok: false, reason: 'kickoff_dispatch_failed', detail: dispatchFailure, authorMemberId: authorId };
          }
          logger.log('[loop-engine] 开题派发回执丢失，但报告已交付，按成果继续');
        }
      }

      // 只重扫时给一次读取的预算就够：开机不为每个开题房间挂五分钟的轮询。
      const outcome = deliveryAccepted(preAccepted) ? preAccepted : await awaitDelivery(meetingId, dir, 0, {
        isAborted: () => !!entry.abort,
        capMs: shouldDispatch ? undefined : 1,
      });
      if (!deliveryAccepted(outcome)) {
        const spec = DOCS.docSpecForPos(0) || {};
        saveKickoff({ kickoff: { status: 'awaiting_report', lastReason: outcome.status || 'pending', updatedAt: Date.now() } });
        emit('kickoff-awaiting', { reason: outcome.status, missing: outcome.missing || null, doc: spec.done });
        return {
          ok: false, reason: 'kickoff_report_not_delivered',
          detail: outcome.reason || '', missing: outcome.missing || null,
          doc: spec.done, dir,
        };
      }

      const reportPath = (outcome.record && outcome.record.path) || '';
      // 报告里声明的项目根通过核实就绑到本群：之后实现位和审查位用的是同一个已核实现场（E01/E04）。
      const bound = bindProjectRootFromReport(meetingId, reportPath);
      if (bound && bound.ok && !bound.unchanged) emit('project-root-bound', { path: bound.path, previous: bound.previous });
      // 2026-09-08 第四轮阻断：核实失败以前只记一行日志就照常开工 —— 那等于让实现位
      // 在一个没人核实过的现场动手。现在分两种：
      //   · 报告声明了项目根但核实不过（目录不在 / 不是仓库 / 是聚合根）→ 停；
      //   · 报告没声明，而当前工作目录本身也不是有效仓库现场 → 同样停。
      // 只有「声明并核实通过」或「本来就在有效现场」才允许进实现。
      if (!bound || !bound.ok) {
        const currentWorkspace = (meetingManager.getMeeting(meetingId) || {}).workspace || '';
        const siteOk = !!currentWorkspace && LOCATOR.classifyRepo(currentWorkspace).valid
          && !LOCATOR.isAggregateRoot(currentWorkspace);
        // 报告**声明了**项目根却核实不过 → 一律停：它断言了一件假的事，
        // 这时候退回界面上那个目录继续跑，等于用一个没人核实的现场掩盖掉这个信号。
        // 报告**没声明** → 才退一步看当前现场本身是否成立。
        const declaredButBad = bound && bound.reason && bound.reason !== 'not_declared';
        if (declaredButBad || !siteOk) {
          const detail = bound && bound.reason === 'not_declared'
            ? '报告里没有「项目根：<绝对路径>」这一行，当前工作目录也不是有效仓库现场'
            : `报告声明的项目根没通过核实（${(bound && bound.reason) || '未知'}${bound && bound.path ? '：' + bound.path : ''}）`;
          saveKickoff({ kickoff: { status: 'project_root_unverified', lastReason: detail, reportPath, updatedAt: Date.now() } });
          emit('kickoff-project-root-unverified', { detail, reportPath });
          logger.log('[loop-engine] 项目现场没核实过，不进实现：' + detail);
          return { ok: false, reason: 'project_root_unverified', detail, reportPath };
        }
      }
      // 报告接收成立，但用户在这期间点了停止 → 只记下交付，不翻阶段、不自动开工。
      // 迟到的完成文件不能覆盖明确的停止意图（任务书 D06）。
      if (entry.abort || stopIntentOf(meetingId)) {
        saveKickoff({ kickoff: { status: 'accepted_stopped', reportPath, acceptedAt: Date.now() } });
        emit('kickoff-accepted-stopped', { reportPath });
        logger.log('[loop-engine] 开题报告已接收，但用户已停止，不自动开工 ' + meetingId);
        return { ok: true, autoStart: false, stopped: true, reportPath };
      }
      saveKickoff({ devPhase: 'build', kickoff: { status: 'accepted', reportPath, acceptedAt: Date.now() } });
      try {
        const orchestrator = typeof getOrchestrator === 'function' ? getOrchestrator(meetingId) : null;
        if (orchestrator && typeof orchestrator.appendSystemNote === 'function') {
          orchestrator.appendSystemNote(orchestrator.state.currentTurn || 1,
            '开题报告已接收，现在自动进入实现阶段。任务书全文：' + reportPath, { kind: 'kickoff' });
        }
      } catch (error) { logError('[loop-engine] 开题接收提示写不进群聊:', error); }
      emit('kickoff-accepted', { reportPath });
      return { ok: true, autoStart: true, goal: '按已接收的开题报告实施。任务书全文（绝对路径）：' + reportPath, reportPath };
    } catch (error) {
      logError('[loop-engine] 开题阶段失败:', error);
      saveKickoff({ kickoff: { status: 'failed', lastReason: (error && error.message) || 'kickoff_error', updatedAt: Date.now() } });
      return { ok: false, reason: (error && error.message) || 'kickoff_error' };
    } finally {
      if (running.get(meetingId) === entry) running.delete(meetingId);
    }
  }

  /** 开题入口。接收成功就直接开工 —— 这一步的授权在维护者点「开题」那一下就给过了。 */
  async function runKickoff(meetingId, options = {}) {
    if (require('../../core/dev-file-workflow').enabled(meetingManager.getMeeting(meetingId))) return { ok: false, reason: 'dev_file_workflow_uses_composer' };
    const outcome = await _kickoffPhase(meetingId, options);
    if (outcome && outcome.ok && outcome.autoStart) {
      runLoop(meetingId, outcome.goal, null)
        .catch(error => logError('[loop-engine] 开题后自动开工失败:', error));
    }
    return outcome;
  }

  function stopLoop(meetingId, options = {}) {
    // 先落盘再谈中断：用户点了停止，这个事实不能因为「当前没有在跑的运行」
    // 或者随后的进程退出而丢失。
    writeStopIntent(meetingId, { at: Date.now(), reason: options.reason || 'user_stop' });
    const r = running.get(meetingId);
    if (!r) return false;
    r.abort = true;
    if (options.interrupt !== false) {
      try { getDispatcher().interruptMeetingTurn(meetingId, { reason: 'workflow_stop' }); }
      catch (error) { logError('[workflow-engine] interrupt on stop failed:', error); }
    }
    return true;
  }
  function isRunning(meetingId) { return running.has(meetingId); }
  function getStatus(meetingId) {
    const active = running.get(meetingId);
    if (active) return { running: true, mode: active.mode, runId: active.runId, startedAt: active.startedAt };
    const meeting = meetingManager.getMeeting(meetingId);
    const workflow = meeting && meeting.serialWorkflow || {};
    return {
      running: false,
      conversation: Conversation.enabled(meeting),
      serialRunState: workflow.serialRunState || null,
      loopState: workflow.loopState || null,
      // 开题记录和 MD 交付账本：前端要靠它们说清「现在停在哪一步、缺的是哪个文件」。
      kickoff: workflow.kickoff || null,
      taskDocs: workflow.taskDocs || null,
      devPhase: DevDiscuss.phaseOf(workflow),
    };
  }

  // Hub boot：扫描所有 meeting，未完成的循环自动续跑
  function resumePending() {
    try {
      const all = (meetingManager.getAllMeetings && meetingManager.getAllMeetings()) || [];
      for (const mt of all) {
        if (require('../../core/dev-file-workflow').enabled(mt)) continue;
        const sw = mt && mt.serialWorkflow; const ls = sw && sw.loopState;
        // Reopening the Hub must not speak into an old conversation by itself.
        // The saved order remains available for each new user input.
        if (Conversation.enabled(mt)) continue;
        const serialState = sw && sw.serialRunState;
        // 用户上次明确停过 → 开机不许自作主张接着跑。清掉它是用户点「继续/重发」的事。
        if (sw && sw.stopRequested) {
          logger.log('[loop-engine] skip boot resume for ' + mt.id + ': user stop intent is on record');
          continue;
        }
        // 开题中被打断：**只重新读一次文件**，不重新派开题任务、不发恢复 prompt。
        // 认出已交付就接着自动开工；认不出就留在开题阶段，等维护者点「重发本轮」。
        if (sw && sw.kickoff && ['running', 'awaiting_report'].includes(sw.kickoff.status)
          && DevDiscuss.phaseOf(sw) === DevDiscuss.PHASE_KICKOFF) {
          logger.log('[loop-engine] boot rescan kickoff ' + mt.id);
          runKickoff(mt.id, { authorMemberId: sw.kickoff.authorMemberId, dispatch: false })
            .catch(error => logError('[loop-engine] boot kickoff rescan failed:', error));
          continue;
        }
        if (sw && sw.enabled && !(sw.loop && sw.loop.enabled)
          && serialState && serialState.status === 'running') {
          // 循环工作流有 deadlineTs 兜底，串行没有。没有年龄下限的话，几天前被打断的
          //   一次串行会在下次开 Hub 时静默地重新向 CLI 发指令。超龄的留给用户手点
          //   serial:resume（IPC 已存在），不在启动时自作主张。
          const idleMs = Date.now() - (Number(serialState.updatedAt) || Number(serialState.startedAt) || 0);
          if (idleMs > SERIAL_BOOT_RESUME_MAX_IDLE_MS) {
            logger.log('[workflow-engine] skip stale serial resume for ' + mt.id
              + ' (idle ' + Math.round(idleMs / 3600000) + 'h); use serial:resume to continue manually');
            continue;
          }
          logger.log('[workflow-engine] boot resume serial ' + mt.id + ' from step ' + serialState.nextStepIndex);
          runSerial(mt.id, null, serialState).catch(error => logError('[workflow-engine] boot serial resume failed:', error));
        } else if (sw && sw.loop && sw.loop.enabled && ls && ls.status === 'running' && !(ls.deadlineTs && Date.now() >= ls.deadlineTs)) {
          logger.log('[loop-engine] boot resume ' + mt.id + ' from round ' + ls.round);
          runLoop(mt.id, null, ls).catch(error => logError('[loop-engine] boot loop resume failed:', error)); // 不 await，后台续跑
        }
      }
    } catch (e) { logger.log('[loop-engine] resumePending err: ' + (e && e.message)); }
  }

  return {
    getStatus, isRunning, resumePending, runKickoff, runLoop, runSerial, stopLoop, clearStopIntent, stopIntentOf,
    describeLoopStateDamage, bindProjectRootFromReport, locatorBlockFor,
    validateLoop, validateResume, validateSerial, ensureMemberReady,
    // 仅供单测：裁决取文本这条路径是「代码合对了但引擎判失败」的根因所在，
    // 必须能脱离真实 CLI 会话单独验证。见 unit-loop-verdict-capture.test.js。
    __test: { awaitVerdictText, awaitStepText, hasVerdict, hasProgressCard,
              persistedTurnText, bestTextSoFar, VERDICT_QUIET_MS, VERDICT_WAIT_CAP_MS },
  };
}

module.exports = { createLoopEngine };
