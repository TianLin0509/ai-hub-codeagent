'use strict';

const groupChatWatcher = require('../../core/group-chat-watcher.js');
const { createTurnCompletionWatcher } = require('../../core/turn-completion-watcher.js');
const pasteTrappedDetector = require('../../core/paste-trapped-detector.js');
const { createAuthBannerMonitor } = require('../../core/host-shell-detector.js');
const DevDiscuss = require('../../core/dev-discuss.js');
const DevFile = require('../../core/dev-file-workflow');
const OrchestrationRules = require('../../core/orchestration/rules');
const GroupAnswers = require('../../core/group-answer-files');
const { isNativeSession, nativeTurnHasEnded } = require('../../core/codex-native-runtime');
const { isClaudeFamily } = require('../../core/ai-kinds.js');
const { nativeUnknownOutcome } = require('../../core/native-groupchat-outcome');
const {
  ATTEMPT_AWAITING_BINDING,
  ATTEMPT_AWAITING_FINAL_TEXT,
  ATTEMPT_RUNNING,
  classifyProviderFailure,
  createRunId,
  isTerminalAttemptStatus,
  promptFingerprint,
} = require('../../core/groupchat-attempt-protocol.js');

const RT_TRANSITIONAL_HARD_TIMEOUT_MS = 5 * 60 * 1000;
const PASTE_TRAPPED_TICK_MS = 3000;
const PASTE_TRAPPED_HARD_TIMEOUT_MS = 60_000;
const PASTE_TRAPPED_CODEX_ENTER_RETRIES = 3;
const HOST_SHELL_HEARTBEAT_MS = 10 * 1000;
const HOST_SHELL_CONSECUTIVE_HITS = 2;
const CODEX_AUTO_EXTRACT_DELAY_MS = 3 * 1000;
const CODEX_AUTO_EXTRACT_INTERVAL_MS = 2 * 1000;
const CODEX_PROMPT_SUBMIT_VERIFY_MS = 25 * 1000;
const CODEX_TRANSCRIPT_BIND_GRACE_MS = 90 * 1000;
const CODEX_PROMPT_SUBMIT_RETRY_MAX = 1;
const CODEX_PROMPT_SUBMIT_WAIT_MAX_MS = 16 * 60 * 1000;
const CODEX_PROMPT_SUBMIT_WAIT_EXTEND_MS = 60 * 1000;
const HARD_TIMEOUT_ACTIVE_GRACE_MS = 150 * 1000;
const HARD_TIMEOUT_ACTIVE_EXTEND_MS = 180 * 1000;
const HARD_TIMEOUT_ACTIVE_MAX_EXTRA_MS = 8 * 60 * 1000;
// 中断键：与用户在单 session 终端里按 ESC 完全同一条路径（xterm onData → 'terminal-input'
//   IPC → sessionManager.writeToSession）。claude / codex / gemini 三家 TUI 都用 ESC 取消
//   当前回答；不用 Ctrl+C（codex 连按两次会直接退出 CLI，属于误伤）。
const INTERRUPT_KEY = '\x1b';
const INTERRUPT_KEY_REPEAT = 2;      // 部分 TUI 首个 ESC 只是收起 UI 面板，补一次更稳
const INTERRUPT_KEY_GAP_MS = 120;
// AUTH_FAILURE_RE 已移到 core/host-shell-detector.js 的 createAuthBannerMonitor：
//   旧实现对整个 ring buffer 裸测，AI 回答里提到 "not logged in" 就误杀（2026-07-12）。
const AUTH_DETECT_WINDOW_MS = 120 * 1000;

function parseGroupTargets(userInput, members, participants) {
  const selected = Array.isArray(participants) ? participants : [];
  const selectedMembers = members.filter(m => selected.includes(m.index));
  const mentionRe = /@([A-Za-z0-9_\-\u4e00-\u9fff]+)/g;
  const mentioned = [];
  let m;
  while ((m = mentionRe.exec(userInput || '')) !== null) {
    const token = String(m[1] || '').toLowerCase();
    if (token === 'all' || token === '全部' || token === '所有人') {
      return { targets: members, mentions: ['all'] };
    }
    const hits = members.filter(mem => {
      const keys = [mem.memberId, mem.displayName, mem.kind, ...(mem.aliases || [])]
        .filter(Boolean).map(x => String(x).toLowerCase());
      return keys.includes(token);
    });
    const hit = hits.length === 1 ? hits[0] : null;
    if (hit && !mentioned.some(x => x.sid === hit.sid)) mentioned.push(hit);
  }
  if (mentioned.length > 0) return { targets: mentioned, mentions: mentioned.map(x => x.memberId) };
  return { targets: selectedMembers, mentions: [] };
}

function createGroupChatDispatcher(deps) {
  const {
    cliReadyDetector,
    getHubDataDir,
    groupchat,
    isCodexBaseKind,
    kindLabels = {},
    logger = console,
    maybeAutoTitleMeetingFromPrompt,
    meetingManager,
    onGroupChatComplete,
    sendToRenderer,
    sessionManager,
    transcriptTap,
    recoverLaunchAuth,
  } = deps;

  groupChatWatcher.init({
    sessionManager,
    cliReadyDetector,
    transcriptTap,
    enableSendDiagnostics: process.env.HUB_GROUPCHAT_SEND_DIAGNOSTICS === '1',
  });

  const groupChatTurnQueue = new Map();
  const patchListenersBySid = new Map();
  const activeWatchers = new Map();
  const activeWatchersByAttempt = new Map();
  const pasteTrappedMonitors = new Map();
  // 抢占式连发（2026-06-24 maintainer）：每个 meeting 的派发序号，单调递增。runGroupChatTurn
  //   完成时比对，若已有更新的轮号 → 自己是被抢占的旧轮，给前端的 turn-complete 带 superseded。
  const meetingDispatchSeq = new Map();
  const meetingHandoffSeq = new Map();
  // 运行中中断（2026-07-29 maintainer）：每个 meeting 的中断代际，单调递增。
  //   用于关掉「用户在 sendToPty 还没跑完时就点了停止」的竞态窗口——此刻 activeWatchers
  //   里还没有 watcher 可以结算，如果不记代际，这一轮会在中断之后才开始等待，卡片
  //   永久停在"思考中"（正是 ae64983 修过的那类卡死）。
  const meetingInterruptSeq = new Map();
  // 每个 meeting 当前在飞的真实用户轮数量。中断时用它区分「真的没人在跑」和
  //   「有轮正卡在 sendToPty、watcher 还没建」——后者不能提前把 orchestrator 收回
  //   idle（那一轮马上会自己以 interrupted 收敛），否则 UI 会先闪一下待命再跳回。
  const meetingInFlightTurns = new Map();
  const recoveryBySid = new Map();

  function warn(...args) {
    if (logger && typeof logger.warn === 'function') logger.warn(...args);
  }

  function log(...args) {
    if (logger && typeof logger.log === 'function') logger.log(...args);
  }

  function orchestratorFor(meetingId) {
    return groupchat.getOrchestrator(getHubDataDir(), meetingId);
  }

  function projectNativeOutcome(result, target) {
    return nativeUnknownOutcome(result, { claude: sessionManager.getNativeClaude?.(target.sid),
      codex: sessionManager.getNativeCodex?.(target.sid), submissionId: target.attemptId,
      providerTurnId: target.providerTurnId || target.attempt?.providerTurnId });
  }

  function emitGroupChat(channel, payload = {}, options = {}) {
    const meetingId = payload.meetingId;
    let revision = Number(payload.revision) || null;
    if (!revision && meetingId) {
      try {
        const orch = orchestratorFor(meetingId);
        revision = orch.reserveRevision(options.eventType || null, options.details || payload);
      } catch (error) {
        warn(`[groupchat] reserve revision failed for ${channel}:`, error && error.message);
      }
    }
    const event = revision ? { ...payload, revision } : payload;
    sendToRenderer(channel, event);
    return event;
  }

  function publishAttempt(meetingId, orch, attempt, extra = {}) {
    if (!meetingId || !attempt) return null;
    const revision = orch.reserveRevision('attempt_published', {
      attemptId: attempt.attemptId,
      runId: attempt.runId,
      turnNum: attempt.turnNum,
      sid: attempt.sid,
      memberId: attempt.memberId,
      status: attempt.status,
      reason: attempt.reason,
      providerTurnId: attempt.providerTurnId,
      failure: attempt.failure,
    });
    const event = {
      meetingId,
      turnNum: attempt.turnNum,
      runId: attempt.runId,
      attemptId: attempt.attemptId,
      memberId: attempt.memberId,
      sid: attempt.sid,
      kind: attempt.kind,
      status: attempt.status,
      providerTurnId: attempt.providerTurnId || null,
      acknowledgementSource: attempt.acknowledgementSource || null,
      userMessageId: attempt.userMessageId || null,
      signalSource: attempt.signalSource || null,
      reason: attempt.reason || null,
      failure: attempt.failure || null,
      updatedAt: attempt.updatedAt || Date.now(),
      revision,
      ...extra,
    };
    sendToRenderer('groupchat-attempt-changed', event);
    return event;
  }

  function notifyGroupChatComplete(event, meeting) {
    if (typeof onGroupChatComplete !== 'function') return;
    Promise.resolve(onGroupChatComplete(event, meeting)).catch(error => {
      warn('[group-chat] completion notification failed:', error && error.message);
    });
  }

  function registerPatchListener(sid, watcher) {
    if (!patchListenersBySid.has(sid)) patchListenersBySid.set(sid, new Set());
    patchListenersBySid.get(sid).add(watcher);
  }

  function cancelPatchListenersForSid(sid) {
    const set = patchListenersBySid.get(sid);
    if (!set) return;
    for (const w of set) {
      try { w.cancelPatch?.(); } catch (e) { warn('[patch] cancelPatch threw:', e && e.message); }
    }
    set.clear();
  }

  function unregisterPatchListener(sid, watcher) {
    const set = patchListenersBySid.get(sid);
    if (set) set.delete(watcher);
  }

  function stopPasteTrappedMonitor(sid) {
    const entry = pasteTrappedMonitors.get(sid);
    const intervalId = entry && typeof entry === 'object' ? entry.intervalId : entry;
    if (intervalId) {
      clearInterval(intervalId);
      pasteTrappedMonitors.delete(sid);
    }
    try { pasteTrappedDetector.stop(sid); }
    catch (error) { warn('[paste-trapped] stop failed:', error && error.message); }
  }

  function promptHeaderForRetry(prompt) {
    const lines = String(prompt || '').split(/\r?\n/).map(line => line.trim());
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      if (lines[index] !== '## 用户') continue;
      const userLine = lines.slice(index + 1).find(line => line && line !== '请发言。');
      if (userLine) return userLine.slice(0, 160);
    }
    const distinctive = lines.find(line => line.length >= 12 && !/^#{1,6}\s/.test(line) && line !== '请发言。');
    return distinctive ? distinctive.slice(0, 160) : '';
  }

  function runtimeKindForSession(sid, fallbackKind) {
    const session = sessionManager.getSession(sid);
    return (session && session.transcriptKind) || fallbackKind;
  }

  function hasBoundCodexTranscript(session) {
    return !!(session && (session.transcriptPath || session.codexSid));
  }

  function startPasteTrappedMonitor(sid, kind, meetingId, context = {}) {
    if (sessionManager.getNativeSession?.(sid) || sessionManager.getNativeCodex?.(sid) || sessionManager.getNativeClaude?.(sid)) return;
    const existingMonitor = pasteTrappedMonitors.get(sid);
    if (existingMonitor && existingMonitor.attemptId === context.attemptId) return;
    if (existingMonitor) stopPasteTrappedMonitor(sid);
    pasteTrappedDetector.start(sid, Date.now());
    const runtimeKind = runtimeKindForSession(sid, kind);
    const startedAt = Date.now();
    const monitor = {
      intervalId: null,
      enterRetries: 0,
      attemptId: context.attemptId || null,
      runId: context.runId || null,
      turnNum: Number(context.turnNum) || null,
    };
    const intervalId = setInterval(() => {
      try {
        if (Date.now() - startedAt >= PASTE_TRAPPED_HARD_TIMEOUT_MS) {
          stopPasteTrappedMonitor(sid);
          return;
        }
        if (monitor.attemptId) {
          const current = orchestratorFor(meetingId).getAttempt(monitor.attemptId);
          if (!current || ['completed', 'failed', 'interrupted', 'superseded', 'absent'].includes(current.status)) {
            stopPasteTrappedMonitor(sid);
            return;
          }
        }
        const buf = sessionManager.getSessionBuffer(sid) || '';
        // The detector needs a monotonic byte counter.  Passing the legacy
        // last-output timestamp made every harmless Codex cursor repaint look
        // like a large streaming delta, so a visibly stable `[Pasted …]`
        // marker could remain "unknown" forever.
        const outputBytes = typeof sessionManager.getGroupChatOutputBytes === 'function'
          ? sessionManager.getGroupChatOutputBytes(sid)
          : sessionManager.getGroupChatLastActivity(sid);
        const r = pasteTrappedDetector.tick(sid, buf, outputBytes);
        if (r === 'stuck') {
          if (isCodexBaseKind(runtimeKind) && monitor.enterRetries < PASTE_TRAPPED_CODEX_ENTER_RETRIES) {
            monitor.enterRetries += 1;
            warn(`[paste-trapped] codex(${sid.slice(0,8)}) paste marker stable; sending retry Enter #${monitor.enterRetries}`);
            try {
              groupChatWatcher._private.writeSubmitSignal(sessionManager, sid, runtimeKind, monitor.enterRetries);
              const meeting = meetingManager.getMeeting(meetingId);
              if (meeting && meeting.groupChat) {
                const orch = groupchat.getOrchestrator(getHubDataDir(), meetingId);
                const turnNum = monitor.turnNum || (orch && orch.state && orch.state.currentTurn);
                if (turnNum) orch.setSendStatus(turnNum, sid, 'enter_retry', { attemptId: monitor.attemptId });
              }
            } catch (e) {
              warn('[paste-trapped] codex retry Enter threw:', e && e.message);
            }
            pasteTrappedDetector.start(sid, Date.now());
            return;
          }
          warn(`[paste-trapped] confirmed stuck for ${kind}(${sid.slice(0,8)}) - pushing groupchat-send-stuck IPC`);
          try {
            const meeting = meetingManager.getMeeting(meetingId);
            if (meeting && meeting.groupChat) {
              const orch = groupchat.getOrchestrator(getHubDataDir(), meetingId);
              const turnNum = monitor.turnNum || (orch && orch.state && orch.state.currentTurn);
              if (turnNum) orch.setSendStatus(turnNum, sid, 'stuck', { attemptId: monitor.attemptId });
            }
          } catch (e) { warn('[paste-trapped] setSendStatus threw:', e && e.message); }
          emitGroupChat('groupchat-send-stuck', {
            meetingId, turnNum: monitor.turnNum, runId: monitor.runId,
            attemptId: monitor.attemptId, sid, kind,
          });
          stopPasteTrappedMonitor(sid);
        } else if (r === 'ok') {
          stopPasteTrappedMonitor(sid);
        }
      } catch (e) {
        warn('[paste-trapped] tick threw:', e && e.message);
      }
    }, PASTE_TRAPPED_TICK_MS);
    intervalId.unref?.();
    monitor.intervalId = intervalId;
    pasteTrappedMonitors.set(sid, monitor);
  }

  function waitNativeClaude(sid, label, opts) {
    const native = sessionManager.getNativeClaude(sid);
    const watcher = require('../../core/claude-native-watcher').createClaudeNativeWatcher(native, {
      sid, label, submissionId: opts.attemptId, attemptId: opts.attemptId, runId: opts.runId, onPartial: opts.onPartial,
      onProgress: progress => {
        if (!opts.meetingId || !opts.attemptId) return;
        const orch = orchestratorFor(opts.meetingId);
        const attempt = orch.updateAttempt(opts.attemptId, progress, 'native_attempt_progress');
        if (!opts.silent) publishAttempt(opts.meetingId, orch, attempt);
      },
    });
    activeWatchers.set(sid, watcher);
    activeWatchersByAttempt.set(opts.attemptId, watcher);
    const startedAt = Date.now();
    return watcher.wait().then(result => {
      result = projectNativeOutcome(result, { ...opts, sid });
      result.thinkSec = Math.round((Date.now() - startedAt) / 100) / 10;
      if (!opts.silent && opts.meetingId && opts.turnNum) {
        const orch = orchestratorFor(opts.meetingId);
        if (result.displayMessages?.length) orch.recordDisplayMessages(opts.attemptId, result.displayMessages);
        orch.patchTurnResult(opts.turnNum, sid, { ...result, memberId: opts.memberId,
          speaker: opts.speaker || label, sourcePrompt: opts.prompt, statusReason: result.reason });
        publishAttempt(opts.meetingId, orch, orch.getAttempt(opts.attemptId));
      }
      if (typeof opts.onPartial === 'function') opts.onPartial(result);
      return result;
    }).finally(() => {
      if (activeWatchers.get(sid) === watcher) activeWatchers.delete(sid);
      if (activeWatchersByAttempt.get(opts.attemptId) === watcher) activeWatchersByAttempt.delete(opts.attemptId);
    });
  }

  function waitTurnComplete(sid, label, opts = {}) {
    if (sessionManager.getNativeClaude?.(sid)) return waitNativeClaude(sid, label, opts);
    const { meetingId, mode, turnNum, onPartial } = opts;
    const silent = opts.silent === true;
    const disableHardTimeout = opts.disableHardTimeout === true;
    const hardTimeoutMs = Number(opts.hardTimeoutMs) > 0 ? Number(opts.hardTimeoutMs) : RT_TRANSITIONAL_HARD_TIMEOUT_MS;
    const allowActiveExtend = opts.allowActiveExtend !== false;
    const startTs = Date.now();
    const waitSession = sessionManager.getSession(sid);
    const native = (sessionManager.getNativeSession?.(sid) || sessionManager.getNativeCodex?.(sid));
    const waitKind = waitSession?.transcriptKind || opts.kind || waitSession?.kind || 'unknown';
    const orch = meetingId ? orchestratorFor(meetingId) : null;
    const attempt = opts.attempt || (orch && opts.attemptId ? orch.getAttempt(opts.attemptId) : null);
    const promptSubmitSinceTs = Math.max(0, Number(opts.promptSubmitSinceTs) || (startTs - 1000));
    const captureDisplayMessages = () => {
      if(silent || !orch || !opts.attemptId)return [];
      const activeSession=sessionManager.getSession(sid);
      const messages=require('../../core/conversation-capture').captureConversationMessages({
        native,kind:waitKind,sourcePath:activeSession?.transcriptPath,
        providerTurnId:opts.providerTurnId || attempt?.providerTurnId,clientSubmissionId:opts.attemptId,
        prompt:opts.prompt,since:opts.promptSubmittedAt || promptSubmitSinceTs,
      });
      orch.recordDisplayMessages(opts.attemptId,messages);
      return messages;
    };
    let codexPromptSubmitted = false;
    let codexPromptSubmittedAt = 0;
    try { transcriptTap.clearLastTokens(sid); }
    catch (error) { warn('[group-chat] clearLastTokens failed:', error && error.message); }

    const watcher = createTurnCompletionWatcher({
      transcriptTap,
      hubSessionId: sid,
      label,
      kind: waitKind,
      nativeOnly: !!native,
      attempt,
      onSoftAlert: (level) => {
        try {
          if (!silent) {
            emitGroupChat('groupchat-soft-alert', {
              meetingId, turnNum, runId: opts.runId, attemptId: opts.attemptId,
              mode, sid, label, level,
            });
          }
        } catch (error) {
          warn('[group-chat] soft alert delivery failed:', error && error.message);
        }
      },
      onEventRejected: ({ type, reason, event }) => {
        if (!orch || !opts.attemptId) return;
        try {
          orch.updateAttempt(opts.attemptId, {
            lastRejectedEvent: type,
            lastRejectedReason: reason,
            lastRejectedAt: Date.now(),
            lastRejectedProviderTurnId: event && event.turnId || null,
          }, 'attempt_event_rejected');
        } catch (error) {
          warn('[group-chat] persist rejected lifecycle event failed:', error && error.message);
        }
      },
      onAwaitingFinalText: ({ reason }) => {
        if (!orch || !opts.attemptId) return;
        try {
          const next = orch.updateAttempt(opts.attemptId, {
            status: ATTEMPT_AWAITING_FINAL_TEXT,
            reason: reason || 'terminal_without_final_text',
          }, 'attempt_awaiting_final_text');
          if (!silent) publishAttempt(meetingId, orch, next);
        } catch (error) {
          warn('[group-chat] persist awaiting-final-text failed:', error && error.message);
        }
      },
      onTurnPatched: ({ sid: patchedSid, text, status, attemptId, runId, providerTurnId, failure, signalSource, finality }) => {
        try {
          if (silent) return;
          const turn = orch.state.turns.find(t => t.n === turnNum);
          const currentStatus = turn?.byStatus?.[patchedSid];
          const finalStatus = (currentStatus === 'manual_extracted') ? 'manual_extracted' : status;
          orch.patchTurnResult(turnNum, patchedSid, {
            text, status: finalStatus, attemptId, runId, providerTurnId,
            failure, signalSource, finality,
          });
          if (attemptId) publishAttempt(meetingId, orch, orch.getAttempt(attemptId), { patched: true });
          emitGroupChat('groupchat-turn-patched', {
            meetingId, turnNum, runId, attemptId, sid: patchedSid, charCount: (text || '').length,
          });
        } catch (e) {
          warn('[patch] onTurnPatched threw:', e && e.message);
        }
      },
    });
    activeWatchers.set(sid, watcher);
    if (opts.attemptId) activeWatchersByAttempt.set(opts.attemptId, watcher);
    registerPatchListener(sid, watcher);

    let streamTimer = null;
    if (!native && typeof onPartial === 'function') {
      streamTimer = setInterval(() => {
        if (watcher.isSettled()) { clearInterval(streamTimer); streamTimer = null; return; }
        const session = sessionManager.getSession(sid);
        const kind = session?.transcriptKind || session?.kind || 'unknown';
        const result = groupChatWatcher.extractStreamingText(sid, kind);
        const hasContent = result.text.length > 10 || result.blocks.length > 0;
        const buf = sessionManager.getSessionBuffer(sid) || '';
        const cleanBufLen = groupChatWatcher.cleanBufLen(buf);
        if (hasContent) {
          let displayMessages;
          try { displayMessages=captureDisplayMessages(); }
          catch(error) { warn('[conversation] progress message capture failed:',error.message); }
          try {
            onPartial({
              sid, label, status: 'streaming',
              displayMessages,
              blocks: result.blocks, source: result.source, text: result.text,
              cleanBufLen,
            });
          } catch (error) {
            warn('[group-chat] streaming partial delivery failed:', error && error.message);
          }
        } else {
          try {
            onPartial({
              sid, label, status: 'streaming',
              blocks: [], source: 'placeholder', text: '',
              cleanBufLen,
            });
          } catch (error) {
            warn('[group-chat] placeholder partial delivery failed:', error && error.message);
          }
        }
      }, 1500);
    }

    let hardTimeout = null;
    if (!disableHardTimeout && !native) {
      const maxHardTimeoutMs = hardTimeoutMs + HARD_TIMEOUT_ACTIVE_MAX_EXTRA_MS;
      const armHardTimeout = (delayMs) => {
        hardTimeout = setTimeout(async () => {
          if (watcher.isSettled()) return;
          if (isCodexBaseKind(waitKind) && opts.prompt) {
            const currentWaitSession = sessionManager.getSession(sid) || waitSession;
            if (hasBoundCodexTranscript(currentWaitSession)) {
              if (!codexPromptSubmitted && transcriptTap && typeof transcriptTap.hasCodexUserMessageSince === 'function') {
                try {
                  codexPromptSubmitted = await transcriptTap.hasCodexUserMessageSince(sid, promptSubmitSinceTs);
                  if (codexPromptSubmitted && !codexPromptSubmittedAt) codexPromptSubmittedAt = Date.now();
                } catch (e) {
                  warn('[group-chat] codex hard-timeout submit probe failed:', e && e.message);
                }
              }
              if (!codexPromptSubmitted) {
                const submitWaitMs = Date.now() - startTs;
                if (submitWaitMs < CODEX_PROMPT_SUBMIT_WAIT_MAX_MS) {
                  const nextDelay = Math.min(CODEX_PROMPT_SUBMIT_WAIT_EXTEND_MS, CODEX_PROMPT_SUBMIT_WAIT_MAX_MS - submitWaitMs);
                  warn(`[group-chat] hard timeout reached for ${label}(${sid.slice(0, 8)}) but Codex prompt submission is not observed yet; extending submit wait ${Math.round(nextDelay / 1000)}s`);
                  armHardTimeout(nextDelay);
                  return;
                }
              } else if (codexPromptSubmittedAt > startTs) {
                const elapsedAfterSubmit = Date.now() - codexPromptSubmittedAt;
                if (elapsedAfterSubmit < hardTimeoutMs) {
                  const nextDelay = Math.min(hardTimeoutMs - elapsedAfterSubmit, HARD_TIMEOUT_ACTIVE_EXTEND_MS);
                  warn(`[group-chat] hard timeout reached for ${label}(${sid.slice(0, 8)}) but Codex prompt was submitted only ${Math.round(elapsedAfterSubmit / 1000)}s ago; extending answer wait ${Math.round(nextDelay / 1000)}s`);
                  armHardTimeout(nextDelay);
                  return;
                }
              }
            } else {
              const submitWaitMs = Date.now() - startTs;
              if (submitWaitMs < CODEX_PROMPT_SUBMIT_WAIT_MAX_MS) {
                const nextDelay = Math.min(CODEX_PROMPT_SUBMIT_WAIT_EXTEND_MS, CODEX_PROMPT_SUBMIT_WAIT_MAX_MS - submitWaitMs);
                warn(`[group-chat] hard timeout reached for ${label}(${sid.slice(0, 8)}) but Codex transcript is not bound yet; extending unbound submit wait ${Math.round(nextDelay / 1000)}s`);
                armHardTimeout(nextDelay);
                return;
              }
            }
          }
          const elapsed = Date.now() - startTs;
          const lastActivity = sessionManager.getGroupChatLastActivity(sid);
          const recentlyActive = lastActivity > startTs && (Date.now() - lastActivity) <= HARD_TIMEOUT_ACTIVE_GRACE_MS;
          if (allowActiveExtend && recentlyActive && elapsed < maxHardTimeoutMs) {
            const nextDelay = Math.min(HARD_TIMEOUT_ACTIVE_EXTEND_MS, maxHardTimeoutMs - elapsed);
            warn(`[group-chat] hard timeout reached for ${label}(${sid.slice(0, 8)}) but PTY was active ${Math.round((Date.now() - lastActivity) / 1000)}s ago; extending ${Math.round(nextDelay / 1000)}s`);
            armHardTimeout(nextDelay);
            return;
          }
          warn(`[group-chat] transitional hard timeout (${Math.round(elapsed / 60000)}min) hit for ${label}(${sid.slice(0, 8)}), forcing skip`);
          watcher.markTimedOut('response_timeout');
        }, delayMs);
        hardTimeout.unref?.();
      };
      armHardTimeout(hardTimeoutMs);
    }

    let hostShellHits = 0;
    const authBannerMonitor = createAuthBannerMonitor();
    const hostShellHeartbeat = native ? null : setInterval(() => {
      if (watcher.isSettled()) { clearInterval(hostShellHeartbeat); return; }
      const buf = sessionManager.getSessionBuffer(sid) || '';
      // 登录失效判定收紧（2026-07-12）：tail + 连续 2 次命中 + 期间 PTY 静默才 confirmed，
      //   防 AI 回答/gh CLI 输出里提到 "not logged in" 等字样时误杀正常回答。
      // 二轮加固（多方审查）：真登录横幅必然出现在 prompt 提交后早期（CLI 拒答即静止）；
      //   轮次开跑 AUTH_DETECT_WINDOW_MS 之后出现的 auth 字样几乎必是回答内容/工具输出，
      //   不再检测——消灭"回答末尾提到 login 短语 + settle 信号迟到"竞态窗口的误杀。
      //   代价：>2min 后才真失效的会话不自动 errored，由 T1/T2 soft-alert 人工兜底。
      if (Date.now() - startTs < AUTH_DETECT_WINDOW_MS
        && authBannerMonitor.tick(buf, sessionManager.getGroupChatLastActivity(sid)) === 'confirmed') {
        warn(`[group-chat] auth failure banner confirmed for ${label}(${sid.slice(0, 8)}) - marking errored`);
        try { watcher.markErrored('auth_required'); }
        catch (e) { warn('[group-chat] markErrored auth_required threw:', e && e.message); }
        const session=sessionManager.getSession(sid);
        if (session && recoverLaunchAuth) void Promise.resolve(recoverLaunchAuth(session,{code:'auth_required'})).catch(()=>{});
        return;
      }
      if (groupChatWatcher.checkHostShellTakeover(sid)) {
        hostShellHits += 1;
        if (hostShellHits >= HOST_SHELL_CONSECUTIVE_HITS) {
          warn(`[group-chat] host shell prompt detected for ${label}(${sid.slice(0, 8)}) on hit #${hostShellHits} - CLI self-exited, marking errored`);
          try { watcher.markProcessExit({ code: -1, signal: 'cli_self_exit' }); }
          catch (e) { warn('[group-chat] markProcessExit (heartbeat) threw:', e.message); }
        }
      } else {
        hostShellHits = 0;
      }
    }, HOST_SHELL_HEARTBEAT_MS);
    hostShellHeartbeat?.unref?.();

    let codexAutoExtractTimer = null;
    let codexPromptSubmitTimer = null;
    let codexPromptSubmitRetries = 0;
    let onCodexPromptSubmitted = null;
    let onAgentTurnStartedForExtract = null;
    if (!native && (isCodexBaseKind(waitKind) || isClaudeFamily(waitKind))) {
      const sincePromptTs = promptSubmitSinceTs;
      // promptSubmitSinceTs 故意比真实发送时刻早 1s，用来容忍 CLI 侧写 rollout 文件的
      //   时钟偏差——那个松弛只能用于「找本轮的用户消息」。判定「这条回答属于本轮」
      //   必须用真实提交时刻：上一轮若在这 1s 松弛内完成，transcript 末轮就会被认成
      //   本轮答案（串行工作流第 N 步刚结束就派发第 N+1 步，正好落在窗口里）。
      const promptSubmittedAt = Number(opts.promptSubmittedAt) || startTs;
      // 更强的下界：拿到本轮的语义开工信号后，只认此刻之后完成的 turn。
      //   hook 未部署时该值保持 0，自动退回 promptSubmittedAt 下界。
      let agentTurnStartedAt = 0;
      if (sessionManager && typeof sessionManager.on === 'function') {
        onAgentTurnStartedForExtract = (ev) => {
          if (!ev || ev.sessionId !== sid || agentTurnStartedAt) return;
          const at = Number(ev.observedAt) || Date.now();
          if (at >= sincePromptTs) {
            agentTurnStartedAt = at;
            if (attempt) {
              attempt.startedAt = at;
              if (ev.turnId) attempt.providerTurnId = String(ev.turnId);
            }
            if (orch && opts.attemptId) {
              try {
                const next = orch.updateAttempt(opts.attemptId, {
                  status: ATTEMPT_RUNNING,
                  startedAt: at,
                  providerTurnId: ev.turnId || null,
                  signalSource: ev.signalSource || 'provider_turn_started',
                }, 'attempt_started');
                if (!silent) publishAttempt(meetingId, orch, next);
              } catch (error) {
                warn('[group-chat] persist provider start failed:', error && error.message);
              }
            }
          }
        };
        try { sessionManager.on('agent-turn-started', onAgentTurnStartedForExtract); }
        catch (error) {
          warn('[group-chat] auto-extract turn-start listener registration failed:', error && error.message);
          onAgentTurnStartedForExtract = null;
        }
      }
      let autoExtractBusy = false;
      codexAutoExtractTimer = setInterval(async () => {
        if (watcher.isSettled()) {
          clearInterval(codexAutoExtractTimer);
          codexAutoExtractTimer = null;
          return;
        }
        if (Date.now() - startTs < CODEX_AUTO_EXTRACT_DELAY_MS) return;
        if (autoExtractBusy) return;
        autoExtractBusy = true;
        try {
          const extracted = await transcriptTap.extractLatestTurn(sid, sincePromptTs);
          const isCodexFinal = isCodexBaseKind(waitKind)
            && extracted?.extractMode === 'final_answer';
          const claudeAnswerFloor = Math.max(promptSubmittedAt, agentTurnStartedAt);
          // 2026-09-06：必须要求 extractMode === 'final_answer'（= transcript 里
          //   stop_reason 已是终态）。此前只校验「时间比本轮 prompt 新」，于是 Claude
          //   刚写完「我先读 X 再改 Y」这种开场白（stop_reason='tool_use'）就被结算成
          //   最终答案 —— 串行工作流因此在 Claude 还没干活时就放行了下一步。
          //   时间下界只能证明「这段文字属于本轮」，永远证明不了「本轮已经结束」。
          const isClaudeFinal = isClaudeFamily(waitKind)
            && extracted?.source === 'manual_claude_transcript'
            && extracted.extractMode === 'final_answer'
            && Number(extracted.completedAt) >= claudeAnswerFloor;
          if ((isCodexFinal || isClaudeFinal) && extracted.text) {
            const signalSource = isCodexFinal
              ? 'codex_auto_extract_final_answer'
              : 'claude_auto_extract_final_answer';
            log(`[group-chat] ${waitKind} auto-extract final answer for ${label}(${sid.slice(0, 8)}) ${extracted.text.length} chars`);
            watcher.completeFromTranscript(extracted.text, signalSource, {
              completedAt: extracted.completedAt || Date.now(),
              turnId: extracted.turnId || extracted.providerTurnId || (attempt && attempt.providerTurnId) || null,
              attemptId: opts.attemptId || null,
            });
          }
        } catch (e) {
          warn('[group-chat] codex auto-extract failed:', e && e.message);
        } finally {
          autoExtractBusy = false;
        }
      }, CODEX_AUTO_EXTRACT_INTERVAL_MS);
      codexAutoExtractTimer.unref?.();

      if (isCodexBaseKind(waitKind) && opts.prompt && transcriptTap && typeof transcriptTap.on === 'function') {
        onCodexPromptSubmitted = (ev) => {
          if (!ev || ev.hubSessionId !== sid) return;
          const submittedAt = Number(ev.submittedAt) || Date.now();
          const promptMatches = !opts.prompt || !ev.text
            || promptFingerprint(ev.text) === promptFingerprint(opts.prompt);
          if (submittedAt >= sincePromptTs && promptMatches) {
            codexPromptSubmitted = true;
            codexPromptSubmittedAt = submittedAt;
            if (attempt && ev.turnId) attempt.providerTurnId = String(ev.turnId);
            if (orch && opts.attemptId) {
              try {
                const next = orch.updateAttempt(opts.attemptId, {
                  status: ATTEMPT_RUNNING,
                  acceptedAt: submittedAt,
                  providerTurnId: ev.turnId || null,
                  signalSource: ev.signalSource || 'prompt_submitted',
                }, 'attempt_prompt_observed');
                if (!silent) publishAttempt(meetingId, orch, next);
              } catch (error) {
                warn('[group-chat] persist prompt observation failed:', error && error.message);
              }
            }
          }
        };
        try { transcriptTap.on('prompt-submitted', onCodexPromptSubmitted); }
        catch (error) { warn('[group-chat] prompt-submitted listener registration failed:', error && error.message); }
        const armCodexPromptSubmitCheck = (delayMs) => {
          if (codexPromptSubmitTimer) clearTimeout(codexPromptSubmitTimer);
          codexPromptSubmitTimer = setTimeout(verifyPromptSubmitted, delayMs);
          codexPromptSubmitTimer.unref?.();
        };
        const verifyPromptSubmitted = async () => {
          if (watcher.isSettled() || codexPromptSubmitted) return;
          // File workflows are continued by the user. Missing output never
          // authorizes another prompt submission or a timed recovery action.
          if (DevFile.enabled(meetingManager.getMeeting(meetingId)) || require('../../core/delivery-workflow').enabled(meetingManager.getMeeting(meetingId))) return;
          const currentWaitSession = sessionManager.getSession(sid) || waitSession;
          const boundNow = hasBoundCodexTranscript(currentWaitSession);
          if (!boundNow) {
            const elapsed = Date.now() - startTs;
            if (elapsed < CODEX_TRANSCRIPT_BIND_GRACE_MS) {
              armCodexPromptSubmitCheck(CODEX_TRANSCRIPT_BIND_GRACE_MS - elapsed);
              return;
            }
          }
          // Missing transcript evidence is not proof that the prompt was never
          // submitted. A semantic/strong-screen acknowledgement or a later
          // provider start forbids automatic full-prompt replay.
          if (opts.submissionAcknowledged || agentTurnStartedAt) {
            if (orch && opts.attemptId) {
              const next = orch.updateAttempt(opts.attemptId, {
                status: boundNow ? ATTEMPT_RUNNING : ATTEMPT_AWAITING_BINDING,
                reason: boundNow ? null : 'transcript_binding_pending',
              }, 'attempt_resend_suppressed');
              if (!silent) publishAttempt(meetingId, orch, next, { resendSuppressed: true });
            }
            return;
          }
          if (boundNow && transcriptTap && typeof transcriptTap.hasCodexUserMessageSince === 'function') {
            try {
              codexPromptSubmitted = await transcriptTap.hasCodexUserMessageSince(sid, sincePromptTs);
              if (codexPromptSubmitted && !codexPromptSubmittedAt) codexPromptSubmittedAt = Date.now();
              if (codexPromptSubmitted) return;
            } catch (e) {
              warn('[group-chat] codex prompt submit verification read failed:', e && e.message);
            }
          }
          if (codexPromptSubmitRetries >= CODEX_PROMPT_SUBMIT_RETRY_MAX) return;
          const submissionState = typeof groupChatWatcher.inspectPromptSubmissionState === 'function'
            ? groupChatWatcher.inspectPromptSubmissionState({
                sid, kind: waitKind, promptHeader: promptHeaderForRetry(opts.prompt),
              })
            : { state: 'unknown' };
          if (submissionState.state !== 'input_pending') {
            if (orch && opts.attemptId) {
              const next = orch.updateAttempt(opts.attemptId, {
                status: boundNow ? ATTEMPT_RUNNING : ATTEMPT_AWAITING_BINDING,
                reason: `submission_unconfirmed_${submissionState.state}`,
              }, 'attempt_resend_suppressed');
              if (!silent) publishAttempt(meetingId, orch, next, { resendSuppressed: true });
            }
            warn(`[group-chat] codex submit remains unconfirmed for ${label}(${sid.slice(0, 8)}), but screen evidence is ${submissionState.state}; refusing automatic full-prompt replay`);
            return;
          }
          codexPromptSubmitRetries += 1;
          const reason = boundNow ? 'prompt submit not observed' : 'transcript not bound';
          const retryElapsedMs = Date.now() - startTs;
          warn(`[group-chat] codex ${reason} for ${label}(${sid.slice(0, 8)}) after ${Math.round(retryElapsedMs / 1000)}s (bindGrace=${Math.round(CODEX_TRANSCRIPT_BIND_GRACE_MS / 1000)}s); retrying prompt submit #${codexPromptSubmitRetries}`);
          try {
            const retry = await groupChatWatcher.resendCurrentPrompt({
              sid,
              kind: waitKind,
              prompt: opts.prompt,
              promptHeader: promptHeaderForRetry(opts.prompt),
              allowRewrite: false,
            });
            try {
              const meeting = meetingManager.getMeeting(meetingId);
              if (meeting && meeting.groupChat) {
                const orch = groupchat.getOrchestrator(getHubDataDir(), meetingId);
                orch.setSendStatus(turnNum, sid, retry?.ok ? 'submit_retry' : 'submit_retry_failed');
              }
            } catch (e) { warn('[group-chat] codex prompt submit retry status threw:', e && e.message); }
          } catch (e) {
            warn('[group-chat] codex prompt submit retry threw:', e && e.message);
          }
        };
        armCodexPromptSubmitCheck(CODEX_PROMPT_SUBMIT_VERIFY_MS);
      }
    }

    const cleanupWaitResources = () => {
      if (native && nativeStateListener) native.off('state',nativeStateListener);
      if (native && nativeItemsListener) native.off('items',nativeItemsListener);
      if (hardTimeout) clearTimeout(hardTimeout);
      clearInterval(hostShellHeartbeat);
      if (codexAutoExtractTimer) clearInterval(codexAutoExtractTimer);
      if (codexPromptSubmitTimer) clearTimeout(codexPromptSubmitTimer);
      if (onCodexPromptSubmitted && transcriptTap && typeof transcriptTap.removeListener === 'function') {
        try { transcriptTap.removeListener('prompt-submitted', onCodexPromptSubmitted); }
        catch (error) { warn('[group-chat] prompt-submitted listener cleanup failed:', error && error.message); }
      }
      if (onAgentTurnStartedForExtract && sessionManager && typeof sessionManager.removeListener === 'function') {
        try { sessionManager.removeListener('agent-turn-started', onAgentTurnStartedForExtract); }
        catch (error) { warn('[group-chat] auto-extract turn-start listener cleanup failed:', error && error.message); }
      }
      if (streamTimer) clearInterval(streamTimer);
      if (activeWatchers.get(sid) === watcher) activeWatchers.delete(sid);
      if (opts.attemptId && activeWatchersByAttempt.get(opts.attemptId) === watcher) {
        activeWatchersByAttempt.delete(opts.attemptId);
      }
      const pasteMonitor = pasteTrappedMonitors.get(sid);
      if (!pasteMonitor || !opts.attemptId || pasteMonitor.attemptId === opts.attemptId) stopPasteTrappedMonitor(sid);
    };

    let nativeStateListener = null;
    let nativeItemsListener = null;
    const waiting = watcher.wait();
    if (native) {
      let reading = false;
      let readAgain = false;
      let lastProgress = '';
      const publishNativeProgress = (includeOutput = false) => {
        if (watcher.isSettled()) return;
        const runtime = native.runtime;
        const expectedTurnId = opts.providerTurnId || attempt?.providerTurnId;
        if (!expectedTurnId || runtime.turnId !== expectedTurnId || runtime.connection !== 'connected'
            || !['running', 'waiting'].includes(runtime.state)) return;
        try {
          const key = [runtime.epoch, expectedTurnId, runtime.state].join(':');
          if (key !== lastProgress && orch && opts.attemptId) {
            const progress = orch.updateAttempt(opts.attemptId, { status: runtime.state,
              providerTurnId: expectedTurnId, signalSource: 'codex-app-server',
              nativeEpoch: runtime.epoch, nativeRevision: runtime.revision }, 'native_attempt_progress');
            if (!silent) publishAttempt(meetingId, orch, progress);
            lastProgress = key;
          }
          if (includeOutput && typeof onPartial === 'function') {
            // This accessor reads native items only; no terminal scan or timer.
            const output = groupChatWatcher.extractStreamingText(sid, 'codex');
            if (output.text || output.blocks.length) onPartial({ sid, label,
              status: runtime.state === 'waiting' ? 'waiting' : 'streaming',
              attemptId: opts.attemptId, runId: opts.runId, providerTurnId: expectedTurnId,
              source: 'codex-app-server', text: output.text, blocks: output.blocks,
              cleanBufLen: output.text.length });
          }
        } catch (error) {
          watcher.markErrored('native_progress_delivery_failed: ' + error.message);
          native.emit('action-error', '群聊状态保存失败：' + error.message);
        }
      };
      const replay = async () => {
        publishNativeProgress();
        if (watcher.isSettled()) return;
        if (native.runtime.connection !== 'connected') {
          const unknown = projectNativeOutcome({ status: 'errored' }, { ...opts, sid, attempt });
          if (unknown.failure?.code === 'submission_unknown') {
            watcher.markErrored('submission_unknown');
            return;
          }
          if (orch && opts.attemptId) {
            const pending = orch.updateAttempt(opts.attemptId,{status:'recovering',reason:'native_connection_unknown'},'native_disconnected');
            if (!silent) publishAttempt(meetingId,orch,pending);
          }
          return;
        }
        if (reading) { readAgain = true; return; }
        reading = true;
        readAgain = false;
        try {
          const outcome = await native.readOutcome(opts.providerTurnId || attempt?.providerTurnId);
          if (outcome) watcher.observeNativeOutcome(outcome);
        } catch (error) { warn('[codex-native] group outcome read failed:',error.message); }
        finally {
          reading = false;
          // A terminal event can arrive before an older read response. Coalesce
          // that observed event into one further read; never lose the wake-up.
          if (readAgain && !watcher.isSettled()) void replay();
        }
      };
      nativeStateListener = () => { void replay(); };
      nativeItemsListener = () => publishNativeProgress(true);
      native.on('state',nativeStateListener);
      native.on('items',nativeItemsListener);
      // The engine may have completed before turn/start responded. Read its
      // exact stored outcome after subscribing; never infer from final text.
      void replay();
      publishNativeProgress(true);
      watcher.interrupt = () => {
        native.interrupt().catch(error=>warn('[codex-native] group interrupt failed:',error.message));
      };
    }
    return waiting.then(result => {
      result = projectNativeOutcome(result, { ...opts, sid, attempt });
      cleanupWaitResources();
      try { result.displayMessages=captureDisplayMessages(); }
      catch(error) { warn('[conversation] final message capture failed:',error.message); }
      if (!native) setTimeout(() => {
        try { unregisterPatchListener(sid, watcher); }
        catch (e) { warn('[patch] unregisterPatchListener throw:', e && e.message); }
      }, 305_000).unref?.();

      const elapsedMs = Date.now() - startTs;
      result.thinkSec = Math.round(elapsedMs / 100) / 10;
      try { result.tokens = transcriptTap.getLastTokens(sid) || null; }
      catch { result.tokens = null; }

      // 不再等最慢成员才持久化整轮：单个 AI 一结算就先把可用结果写进 messages。
      // 这样后续成员卡住、Hub 崩溃/重启或用户立即点“同步”时，已得到的答案都不会丢。
      if (!silent && meetingId && turnNum) {
        try {
          orch.patchTurnResult(turnNum, sid, {
            text: result.text,
            status: result.status,
            thinkSec: result.thinkSec,
            tokens: result.tokens,
            memberId: opts.memberId,
            speaker: opts.speaker || label,
            sourcePrompt: opts.prompt,
            statusReason: result.reason,
            attemptId: opts.attemptId,
            runId: opts.runId,
            providerTurnId: result.providerTurnId || (attempt && attempt.providerTurnId) || null,
            failure: result.failure || null,
            signalSource: result.signalSource,
            finality: result.finality,
            completedAt: result.completedAt,
          });
          const settledAttempt = opts.attemptId ? orch.getAttempt(opts.attemptId) : null;
          if (!silent && settledAttempt) publishAttempt(meetingId, orch, settledAttempt);
        } catch (e) {
          // 持久化失败不能反向卡死 watcher/整轮；最终 completeTurn 仍有一次落盘机会。
          warn('[group-chat] persist settled participant failed:', e && e.message);
        }
      }

      if (typeof onPartial === 'function') {
        try { onPartial(result); } catch (e) { warn('[group-chat] onPartial error:', e.message); }
      }
      return result;
    }, err => {
      cleanupWaitResources();
      throw err;
    });
  }

  // 与梦境索引/工作区规则的压缩检测同源：session 上由 statusline / rollout 维护的已用上下文。
  function memberContextUsed(sid) {
    const s = sessionManager.getSession(sid);
    return s && typeof s.contextUsed === 'number' ? s.contextUsed : null;
  }

  function groupMembersForMeeting(meeting, { includeDormant = false } = {}) {
    const subSids = Array.isArray(meeting && meeting.subSessions) ? meeting.subSessions : [];
    const specs = Array.isArray(meeting && meeting.slotSpecs) ? meeting.slotSpecs : [];
    const kindCounts = {};
    for (const sid of subSids) {
      const s = sessionManager.getSession(sid);
      if (!s) continue;
      kindCounts[s.kind] = (kindCounts[s.kind] || 0) + 1;
    }
    const seenKind = {};
    const orch = meeting && meeting.id ? orchestratorFor(meeting.id) : null;
    return subSids.map((sid, idx) => {
      const s = sessionManager.getSession(sid);
      if (!s || (!includeDormant && s.status === 'dormant')) return null;
      const spec = specs[idx] || {};
      const kind = s.kind || spec.kind || 'ai';
      seenKind[kind] = (seenKind[kind] || 0) + 1;
      const kindLabel = kindLabels[kind] || kind || 'AI';
      const dupSuffix = kindCounts[kind] > 1 ? String(seenKind[kind]) : '';
      const displayName = s.title || `${kindLabel}${dupSuffix ? ' ' + dupSuffix : ''}`;
      const memberId = orch
        ? orch.ensureMemberIdentity(sid, spec.memberId || `m${idx + 1}`, { source: spec.memberId ? 'slot_spec' : 'legacy_slot' })
        : (spec.memberId || `m${idx + 1}`);
      const model = (s.currentModel && s.currentModel.id) || spec.model || null;
      const aliases = [
        memberId,
        displayName,
        kindLabel,
        kind,
        `${kindLabel}${seenKind[kind]}`,
        `${kind}${seenKind[kind]}`,
      ].filter(Boolean);
      return {
        sid,
        index: idx,
        memberId,
        kind,
        model,
        displayName,
        aliases: [...new Set(aliases.map(x => String(x)))],
      };
    }).filter(Boolean);
  }

  async function dispatchInternalPrompt(meetingId, meeting, targetMembers, userInput, turnTimeoutMs, workflowRun = null) {
    for (const member of targetMembers) {
      try { transcriptTap.clearStreamingBuf(member.sid); }
      catch (error) { warn('[groupchat] internal clearStreamingBuf failed:', error && error.message); }
      cancelPatchListenersForSid(member.sid);
    }
    const _orch = groupchat.getOrchestrator(getHubDataDir(), meetingId);
    const runId = createRunId(meetingId, 0);
    // [全量注入] 记录本幕发言前的位置——markDeliveredSilent 用它把各委员「已读位置」停在本幕发言前，
    //   使下一幕 buildDelta 能带上本幕全部委员发言（群聊式全量注入，复用自由群聊 deliveredIdx 机制）。
    const deliveredIdx = _orch.state.messages.length - 1;
    const deliveredMessage = _orch.state.messages[deliveredIdx];
    const deliveredSeq = deliveredMessage && Number.isInteger(deliveredMessage.seq) ? deliveredMessage.seq : 0;
    const targets = targetMembers.map(member => {
      const systemPromptText = groupchat.buildSystemPromptText(member.displayName, meeting.scene, {
        kind: member.kind,
      });
      return {
        sid: member.sid,
        kind: member.kind,
        label: member.displayName,
        member,
        deliveredIdx,
        deliveredSeq,
        runId,
        // 点2：首次带 systemPrompt(整套规则)、之后只发增量。[全量注入] includeCommitteeMid:true —— 把
        //   上一幕委员发言全文注入本幕，每个 AI 看到队友调研全文（点评看建库、辩论看点评），不再瞎猜。
        prompt: _orch.buildFirstDelta(member.sid, userInput || '', systemPromptText, {
          currentUserMessageAppended: false,
          includeCommitteeMid: true,
          contextUsed: memberContextUsed(member.sid),
        }),
      };
    });
    for (const target of targets) {
      const receipt = _orch.recordTurnPrompt(0, target.sid, target.prompt, {
        runId,
        workflowRun,
        memberId: target.member && target.member.memberId,
        kind: target.kind,
        mode: 'internal',
      });
      target.attemptId = receipt && receipt.attemptId;
      target.attempt = target.attemptId ? _orch.getAttempt(target.attemptId) : null;
    }
    const sentTargets = [];
    const sendFailures = [];
    await Promise.all(targets.map(async (t) => {
      try {
        const sendStartedAt = Date.now();
        if (t.attemptId) _orch.updateAttempt(t.attemptId, { status: 'submitting', dispatchAt: sendStartedAt }, 'attempt_submitting');
        const sendResult = await groupChatWatcher.sendToPty(t.sid, t.prompt, t.kind, {
          clientSubmissionId: t.attemptId, metadata: { attemptId: t.attemptId, runId, meetingId },
        });
        if (sendResult && sendResult.ok) {
          t.promptSubmitSinceTs = Math.max(0, sendStartedAt - 1000);
          t.promptSubmittedAt = sendStartedAt;
          t.submissionAcknowledged = !!sendResult.acknowledgementSource;
          t.providerTurnId = sendResult.acknowledgementTurnId || null;
          _orch.setSendStatus(0, t.sid, sendResult.sendStatus || 'submitted', {
            acknowledgementSource: sendResult.acknowledgementSource,
            providerTurnId: sendResult.acknowledgementTurnId,
            userMessageId: sendResult.userMessageId,
            nativePromptFingerprint: sendResult.promptFingerprint,
            attemptId: t.attemptId,
          });
          t.attempt = t.attemptId ? _orch.getAttempt(t.attemptId) : t.attempt;
          sentTargets.push(t);
        } else {
          const failure = classifyProviderFailure({ reason: sendResult && sendResult.reason || 'cli_not_ready', force: true });
          const result = projectNativeOutcome({
            sid: t.sid, label: t.label, status: 'errored', text: '',
            reason: failure.code, failure, runId, attemptId: t.attemptId,
            deliveredIdx: t.deliveredIdx, deliveredSeq: t.deliveredSeq,
            promptDelivered: false,
          }, t);
          if (t.attemptId) _orch.settleAttempt(t.attemptId, result);
          sendFailures.push(result);
        }
      } catch (e) {
        const failure = classifyProviderFailure({ code:e?.code, uncertain:e?.uncertain, reason: e && e.message || 'send_exception', force: true });
        const result = projectNativeOutcome({
          sid: t.sid, label: t.label, status: 'errored', text: '',
          reason: failure.code, failure, runId, attemptId: t.attemptId,
          deliveredIdx: t.deliveredIdx, deliveredSeq: t.deliveredSeq,
          promptDelivered: false,
        }, t);
        if (t.attemptId) _orch.settleAttempt(t.attemptId, result);
        sendFailures.push(result);
        warn(`[groupchat] internal sendToPty threw for ${t.kind}(${t.sid.slice(0,8)}):`, e && e.message);
      }
    }));
    if (sentTargets.length === 0) {
      _orch.completeInternalRun(runId, sendFailures);
      return { status: 'completed', turnNum: null, results: sendFailures, meta: { dispatchMode: 'internal' } };
    }
    const settled = await Promise.allSettled(sentTargets.map(t =>
      waitTurnComplete(t.sid, t.label, {
        meetingId,
        mode: 'internal',
        turnNum: 0,
        kind: t.kind,
        prompt: t.prompt,
        promptSubmitSinceTs: t.promptSubmitSinceTs,
        promptSubmittedAt: t.promptSubmittedAt,
        runId,
        attemptId: t.attemptId,
        attempt: t.attempt,
        providerTurnId: t.providerTurnId,
        submissionAcknowledged: t.submissionAcknowledged,
        disableHardTimeout: !(Number(turnTimeoutMs) > 0),
        hardTimeoutMs: Number(turnTimeoutMs) > 0 ? Number(turnTimeoutMs) : undefined,
        silent: true,
        allowActiveExtend: false,
      })
    ));
    const results = settled.map((s, i) => {
      // [查看本轮 prompt] 把该委员本幕实际收到的 prompt 带进 result，供 conductor→appendSpeeches 落进消息。
      const _srcPrompt = (sentTargets[i] && sentTargets[i].prompt) || '';
      // [全量注入] 带出 deliveredIdx → markDeliveredSilent 把「已读位置」停在本幕发言前，下一幕看得到本幕发言。
      const _deliveredIdx = sentTargets[i] && sentTargets[i].deliveredIdx;
      return s.status === 'fulfilled'
        ? { ...s.value, sourcePrompt: _srcPrompt, deliveredIdx: _deliveredIdx, deliveredSeq: sentTargets[i] && sentTargets[i].deliveredSeq }
        : { sid: sentTargets[i].sid, label: sentTargets[i].label, status: 'errored', text: '', reason: s.reason?.message || 'Promise rejected', sourcePrompt: _srcPrompt, deliveredIdx: _deliveredIdx, deliveredSeq: sentTargets[i] && sentTargets[i].deliveredSeq, runId, attemptId: sentTargets[i] && sentTargets[i].attemptId };
    }).concat(sendFailures);
    // 点2：标记这些委员已收过 systemPrompt → 下一幕 buildFirstDelta 走增量、不再重发整套规则。
    try { _orch.markDeliveredSilent(results); } catch (e) { warn('[committee] markDeliveredSilent threw:', e && e.message); }
    try { _orch.completeInternalRun(runId, results); } catch (e) { warn('[committee] completeInternalRun threw:', e && e.message); }
    return { status: 'completed', turnNum: null, results, meta: { dispatchMode: 'internal' } };
  }

  // 抢占式结算（2026-06-24 maintainer）：用户点发送即放行的核心。新一轮进来时，把这个
  //   meeting 当前所有还在等待回答的 AI（上一轮没答完的）立即结算为 superseded，让它们的
  //   waitTurnComplete Promise 立刻 resolve → 上一轮 runGroupChatTurn 的 Promise.allSettled
  //   立即完成 → 串行队列放行新轮，不再被卡死的 AI 无限期挂起。
  //   只结算属于本 meeting 的 watcher（activeWatchers 以 sid 为键，跨 meeting 不共享 sid）。
  function supersedeActiveWatchersForMeeting(meetingId, fileHandoff = false) {
    const meeting = meetingManager.getMeeting(meetingId);
    const sids = meeting && Array.isArray(meeting.subSessions) ? meeting.subSessions : [];
    let count = 0;
    for (const sid of sids) {
      const watcher = activeWatchers.get(sid);
      if (watcher && !watcher.isSettled()) {
        try {
          if (fileHandoff && typeof watcher.handoff === 'function') {
            const orch = groupchat.getOrchestrator(getHubDataDir(), meetingId);
            const receipt = Object.values(orch.state.devChatHistory?.receipts || {}).find(r =>
              r.sid === sid && r.attemptId === orch.state.pendingPrompts?.[String(orch.state.currentTurn)]?.[sid]?.attemptId);
            if (receipt) { receipt.handedOffAt=Date.now(); orch._saveState('dev_chat_handoff',{sid,attemptId:receipt.attemptId}); }
            watcher.handoff();
          } else watcher.supersede();
          count += 1;
        }
        catch (e) { warn('[groupchat] supersede watcher threw:', e && e.message); }
      }
    }
    if (count > 0) log(`[groupchat] preempted ${count} in-flight AI(s) for meeting ${meetingId} — user sent next turn`);
    return count;
  }

  function handoffMeetingTurn(meetingId) {
    const key=String(meetingId || ''),seq=(meetingDispatchSeq.get(key) || 0)+1;
    meetingDispatchSeq.set(key,seq);
    meetingHandoffSeq.set(key,seq);
    // Files can arrive while sendToPty is still awaiting acceptance. Advancing
    // the generation also hands off watchers registered after this call.
    return supersedeActiveWatchersForMeeting(meetingId,true);
  }

  // 运行中中断（2026-07-29 maintainer）：把「用户在单 session 里按 ESC」这件事批量下发给
  //   本轮所有在跑的成员。顺序刻意是「先结算、再发 ESC」：
  //     ① 先 watcher.interrupt(partialText) —— 状态机立刻收敛到确定态（interrupted），
  //        不依赖 CLI 是否回吐 stop 信号。CLI 挂了 / 不认 ESC 也不会留下永久"思考中"。
  //     ② 再向 PTY 写 ESC —— 让 CLI 真的停下别继续烧 token。
  //   已经流出的半截文本一并落盘（extractStreamingText），中断不等于丢内容。
  function interruptMeetingTurn(meetingId, opts = {}) {
    const key = String(meetingId || '');
    const reason = opts.reason || 'user_interrupt';
    const meeting = meetingManager.getMeeting(meetingId);
    if (!meeting || !meeting.groupChat) {
      return { ok: false, reason: 'not_group_chat_meeting', stopped: [], signaled: [], turnNum: null };
    }
    // 代际先自增：即使此刻还没有 watcher（send 与 wait 之间），正在跑的
    //   runGroupChatTurn 也能在开等之前看到「我已经被中断了」。
    meetingInterruptSeq.set(key, (meetingInterruptSeq.get(key) || 0) + 1);

    const sids = Array.isArray(meeting.subSessions) ? meeting.subSessions : [];
    const stopped = [];
    const stoppedAttemptIds = [];
    for (const sid of sids) {
      const watcher = activeWatchers.get(sid);
      if (!watcher || watcher.isSettled()) continue;
      const session = sessionManager.getSession(sid);
      const kind = (session && session.kind) || 'unknown';
      let partialText = '';
      try {
        const streamed = groupChatWatcher.extractStreamingText(sid, kind);
        if (streamed && streamed.text) partialText = String(streamed.text);
      } catch (e) {
        warn('[groupchat] interrupt extractStreamingText threw:', e && e.message);
      }
      try {
        const identity = watcher.getAttemptIdentity && watcher.getAttemptIdentity();
        watcher.interrupt(partialText, reason);
        stopped.push(sid);
        if (identity && identity.attemptId) stoppedAttemptIds.push(identity.attemptId);
      } catch (e) {
        warn('[groupchat] interrupt watcher threw:', e && e.message);
      }
    }

    // File handoff can precede the old reply's final event. Interrupt the bound executor even
    // when that late event already settled its chat watcher; membership still limits the target.
    const explicit = (Array.isArray(opts.targetSids) ? opts.targetSids : []).filter(sid => sids.includes(sid));
    const signalTargets = explicit.length ? [...new Set([...stopped, ...explicit])]
      : stopped.length > 0 ? stopped : sidsStillBusy(sids);
    const signaled = signalInterruptToPty(signalTargets);

    // 有轮正卡在 sendToPty（watcher 还没建）时不要抢着收 idle：那一轮马上会在
    //   开等之前读到中断代际并自己以 interrupted 收敛，这里插一脚只会让 UI 闪。
    const pendingDispatch = (meetingInFlightTurns.get(key) || 0) > 0;
    let turnNum = null;
    try {
      const orch = groupchat.getOrchestrator(getHubDataDir(), meetingId);
      turnNum = orch.state.currentTurn || null;
      // 兜底收敛：既没有在跑 watcher、也没有在飞的派发（Hub 重启残留 / 状态悬空）时，
      //   仍把 orchestrator 的进行中轮收回 idle，绝不留"永久思考中"。
      if (stopped.length === 0 && !pendingDispatch && orch.state.currentMode !== 'idle' && turnNum) {
        orch.clearTurnInProgress(turnNum, orch.state.activeRun && orch.state.activeRun.runId);
      }
    } catch (e) {
      warn('[groupchat] interrupt orchestrator sync threw:', e && e.message);
    }

    log(`[groupchat] user interrupted meeting ${meetingId}: settled ${stopped.length} in-flight AI(s), ESC sent to ${signaled.length}, pendingDispatch=${pendingDispatch}`);
    try {
      const orch = orchestratorFor(meetingId);
      emitGroupChat('groupchat-turn-interrupted', {
        meetingId,
        turnNum,
        runId: orch.state.activeRun && orch.state.activeRun.runId || null,
        stopped,
        stoppedAttemptIds,
        signaled,
        reason,
        pendingDispatch,
      });
    } catch (e) {
      warn('[groupchat] interrupt sendToRenderer threw:', e && e.message);
    }
    const failedExplicit = explicit.filter(sid => !signaled.includes(sid));
    return { ok: !failedExplicit.length, ...(failedExplicit.length ? { reason: '执行席位的中断信号未送达；自动派工已暂停' } : {}), stopped, stoppedAttemptIds, signaled, turnNum, pendingDispatch };
  }

  // 没有 watcher 但 PTY 可能仍在跑（send 与 wait 之间被叫停）：对本 meeting 里
  //   groupChatReady 过的成员一律补一发 ESC，宁可多按一次也不留失控的 CLI。
  function sidsStillBusy(sids) {
    const out = [];
    for (const sid of sids) {
      try {
        if (sessionManager.getGroupChatReady && sessionManager.getGroupChatReady(sid)) out.push(sid);
      } catch { /* 会话已关闭 */ }
    }
    return out;
  }

  function signalInterruptToPty(sids) {
    const signaled = [];
    for (const sid of sids || []) {
      try {
        const native = sessionManager.getNativeClaude?.(sid)
          || sessionManager.getNativeSession?.(sid) || sessionManager.getNativeCodex?.(sid);
        if (native) {
          native.interrupt().catch(error => native.emit('action-error', error.message));
          signaled.push(sid);
          continue;
        }
        sessionManager.writeToSession(sid, INTERRUPT_KEY);
        signaled.push(sid);
        for (let i = 1; i < INTERRUPT_KEY_REPEAT; i += 1) {
          const t = setTimeout(() => {
            try { sessionManager.writeToSession(sid, INTERRUPT_KEY); }
            catch (e) { warn('[groupchat] interrupt repeat write threw:', e && e.message); }
          }, INTERRUPT_KEY_GAP_MS * i);
          t.unref?.();
        }
      } catch (e) {
        warn(`[groupchat] interrupt write to ${String(sid).slice(0, 8)} threw:`, e && e.message);
      }
    }
    return signaled;
  }

  async function dispatchGroupChatTurn(meetingId, args = {}) {
    const key = String(meetingId || '');
    // 真实用户发送（非 silent 内部编排）进来时，先抢占结算上一轮没答完的 AI，再排队 ——
    //   这样上一轮立刻收尾、本轮几乎零延迟开跑。dispatchSeq 供 runGroupChatTurn 判断
    //   自己完成时是否已被更新的轮抢占（决定给前端的 superseded flag）。
    let dispatchSeq = null;
    if (!args.silent) {
      dispatchSeq = (meetingDispatchSeq.get(key) || 0) + 1;
      meetingDispatchSeq.set(key, dispatchSeq);
      // 编排群总是按文件交接：任何一轮新派发都不把在干活的成员标成「被抢占」。
      const fileHandoff=(args.fileHandoff === true && (DevFile.enabled(meetingManager.getMeeting(meetingId)) || require('../../core/delivery-workflow').enabled(meetingManager.getMeeting(meetingId))))
        || OrchestrationRules.enabled(meetingManager.getMeeting(meetingId));
      if(fileHandoff)meetingHandoffSeq.set(key,dispatchSeq);else meetingHandoffSeq.delete(key);
      try { supersedeActiveWatchersForMeeting(meetingId, fileHandoff); }
      catch (e) { warn('[groupchat] preempt supersede threw:', e && e.message); }
    }
    const previous = groupChatTurnQueue.get(key) || Promise.resolve();
    const task = previous.catch(() => {}).then(() => runGroupChatTurn(meetingId, { ...args, _dispatchSeq: dispatchSeq }));
    groupChatTurnQueue.set(key, task);
    task.finally(() => {
      if (groupChatTurnQueue.get(key) === task) groupChatTurnQueue.delete(key);
    }).catch(() => {});
    return task;
  }

  async function runGroupChatTurn(meetingId, {
    userInput,
    turnTimeoutMs,
    targetMemberIds,
    recipientSids,
    silent,
    allowActiveExtend,
    appendUserMessage,
    reuseTurnNum,
    dispatchMode,
    displayUserInput,
    dispatchPresentation,
    workflowRun,
    clientMessageId,
    _dispatchSeq,
    shouldDispatch,
    onSubmission,
  } = {}) {
    if (shouldDispatch && !shouldDispatch()) return { status: 'error', reason: '文件进度已变化或用户已停止', turnNum: null };
    const turnStartedAt = Date.now();
    // 在飞派发计数（2026-07-29 maintainer）：给 interruptMeetingTurn 区分「真没人在跑」
    //   和「有轮正卡在 sendToPty」。silent 内部编排不计入（不属于用户可见轮）。
    const inFlightKey = String(meetingId || '');
    if (!silent) meetingInFlightTurns.set(inFlightKey, (meetingInFlightTurns.get(inFlightKey) || 0) + 1);
    try {
      const meeting = meetingManager.getMeeting(meetingId);
      if (!meeting || !meeting.groupChat) {
        return { status: 'error', reason: 'not group chat meeting', turnNum: null };
      }
      // 运行中中断的竞态门（2026-07-29 maintainer）：记下本轮开跑时的中断代际。
      //   sendToPty 可能要跑几秒，用户在这段窗口点「停止」时 activeWatchers 里还没有
      //   本轮 watcher，中断会落空 → 本轮随后开始等待、永远等不到 → 永久"思考中"。
      const interruptKey = String(meetingId || '');
      const interruptSeqAtStart = meetingInterruptSeq.get(interruptKey) || 0;
      const interruptedSinceStart = () => (meetingInterruptSeq.get(interruptKey) || 0) !== interruptSeqAtStart;
      const members = groupMembersForMeeting(meeting);
      if (members.length === 0) return { status: 'no_subs', turnNum: null };
      if(recipientSids!==undefined)targetMemberIds=require('../../core/groupchat-recipients').memberIds(meeting,recipientSids);
      const explicitTargetIds = Array.isArray(targetMemberIds)
        ? targetMemberIds.map(x => String(x || '').toLowerCase()).filter(Boolean)
        : [];
      const routed = explicitTargetIds.length
        ? {
            targets: members.filter(m => explicitTargetIds.includes(String(m.memberId || '').toLowerCase())),
            mentions: explicitTargetIds,
          }
        : parseGroupTargets(userInput || '', members, meeting.participants);
      const targetMembers = routed.targets || [];
      if (DevFile.enabled(meeting) || require('../../core/delivery-workflow').enabled(meeting)) {
        const historyOrch=groupchat.getOrchestrator(getHubDataDir(),meetingId);
        const waiting=()=>{
          const receipts=Object.values(historyOrch.state.devChatHistory?.receipts || {});
          const attempts=Object.values(historyOrch.state.attempts || {});
          return targetMembers.filter(member=>{
            const session=sessionManager.getSession(member.sid);
            // Only the latest dispatched attempt can occupy this seat. Older
            // receipts remain collectable without becoming extra send gates.
            const attempt=attempts.filter(a=>a.sid===member.sid).at(-1);
            if (!isNativeSession(session)) {
              const receipt=attempt ? receipts.find(r=>r.sid===member.sid && r.attemptId===attempt.attemptId)
                : receipts.filter(r=>r.sid===member.sid).at(-1);
              return !!(receipt?.handedOffAt && !receipt.sourceCompletedAt);
            }
            if (!attempt || !(attempt.status==='handed_off' || receipts.some(r=>r.attemptId===attempt.attemptId && r.handedOffAt))) return false;
            const native=(sessionManager.getNativeSession?.(member.sid) || sessionManager.getNativeCodex?.(member.sid));
            if (!native) return true;
            const r=native.runtime || {};
            let threadId=attempt.providerThreadId, turnId=attempt.providerTurnId;
            // Older receipts may predate the persisted thread binding. Recover
            // it only from this exact native submission, never the latest turn.
            if (!threadId || !turnId) {
              const submitted=native.receipts?.get(attempt.attemptId)?.result;
              if (submitted?.clientSubmissionId===attempt.attemptId && (!turnId || turnId===submitted.turnId)
                  && (!threadId || threadId===submitted.threadId)) {
                threadId=submitted.threadId; turnId=submitted.turnId;
              } else if (r.submission?.id===attempt.attemptId && r.submission.status==='accepted'
                  && (!turnId || turnId===r.submission.turnId) && (!threadId || threadId===r.threadId)) {
                threadId=r.threadId; turnId=r.submission.turnId;
              }
            }
            return !nativeTurnHasEnded({...session,nativeRuntime:r},{threadId,turnId});
          });
        };
        const waitStart=Date.now();
        if(waiting().length) {
          historyOrch.appendSystemNote(historyOrch.state.currentTurn,'文件已交付，正在等待该席位上一轮 CLI 收尾后接续；已有消息会保留。');
          emitGroupChat('dev-workbench:progress',{meetingId,revision:historyOrch.state.revision});
        }
        // The delivered file already proves the previous stage is done; this only
        // lets the CLI finish its closing words. If the transcript/hook signal
        // never arrives (binding hiccup), proceed after a bounded wait instead of
        // stalling the workflow — the TUI queues a prompt sent while it is busy.
        // Native sessions report their turn state authoritatively and allow one
        // writer only, so they keep the strict wait; the bounded bypass is for
        // PTY seats whose signal comes from transcript binding.
        const SEAT_WAIT_MS=Math.min(Number(turnTimeoutMs) || 90_000,90_000);
        while(waiting().length) {
          if(interruptedSinceStart() || (shouldDispatch && !shouldDispatch()))
            return {status:'error',reason:'文件进度已变化或用户已停止',turnNum:null};
          const nativeWaiting=waiting().some(member=>isNativeSession(sessionManager.getSession(member.sid)));
          if(nativeWaiting) {
            if(Date.now()-waitStart > (Number(turnTimeoutMs) || 30*60_000))
              return {status:'error',reason:'等待上一轮 CLI 收尾超时；请查看原文，确认后继续',turnNum:null};
          } else if(Date.now()-waitStart > SEAT_WAIT_MS) {
            historyOrch.appendSystemNote(historyOrch.state.currentTurn,'未收到该席位上一轮 CLI 的收尾信号，已等待 90 秒，按已交付文件继续派发。');
            emitGroupChat('dev-workbench:progress',{meetingId,revision:historyOrch.state.revision});
            break;
          }
          await new Promise(resolve=>setTimeout(resolve,100));
        }
        // Stop can race the terminal event that made waiting() become false.
        if(interruptedSinceStart() || (shouldDispatch && !shouldDispatch()))
          return {status:'error',reason:'文件进度已变化或用户已停止',turnNum:null};
      }
      // 2026-07-20 maintainer [修#3d]：被勾选但 dormant/不可达的成员以 absent 合入本轮，
      //   不再静默消失（此前卡片全程"思考中"、轮末查无此人）。仅整组发送时统计；
      //   @ 点名/显式 targetMemberIds 时，未被点到的不算缺席。
      const isRoutedSubset = explicitTargetIds.length > 0 || (routed.mentions && routed.mentions.length > 0);
      let absentMembers = [];
      if (!isRoutedSubset && !silent) {
        const targetSidSet = new Set(targetMembers.map(m => m.sid));
        const checkedIdx = new Set(Array.isArray(meeting.participants) ? meeting.participants : (meeting.subSessions || []).map((_s, i) => i));
        absentMembers = (meeting.subSessions || []).map((sid, idx) => ({ sid, idx }))
          .filter(({ sid, idx }) => checkedIdx.has(idx) && !targetSidSet.has(sid))
          .map(({ sid, idx }) => {
            const s = sessionManager.getSession(sid);
            return { sid, label: (s && (s.title || s.kind)) || `AI ${idx + 1}`, status: 'absent', text: '', reason: 'session_not_ready', deliveredIdx: null, promptDelivered: false };
          });
      }
      if (targetMembers.length === 0 && absentMembers.length === 0) {
        return { status: 'error', reason: '请先勾选至少一位 AI 成员，或用 @ 指定成员', turnNum: null };
      }
      if (silent) {
        return await dispatchInternalPrompt(meetingId, meeting, targetMembers, userInput || '', turnTimeoutMs, workflowRun);
      }
      if (!silent) maybeAutoTitleMeetingFromPrompt(meetingId, userInput || '');

      for (const member of members) {
        try { transcriptTap.clearStreamingBuf(member.sid); }
        catch (error) { warn('[groupchat] clearStreamingBuf failed:', error && error.message); }
      }

      const hubDataDir = getHubDataDir();
      const orch = groupchat.getOrchestrator(hubDataDir, meetingId);
      // md 存档的表头用群聊标题；改名后下一轮自动跟上。
      orch.setMeetingTitle(meeting.title);
      const requestedTurnNum = Number(reuseTurnNum);
      const isReusedTurn = Number.isInteger(requestedTurnNum) && requestedTurnNum > 0;
      // 每一次逻辑派发都要有一张可追溯的卡片，身份 = run + 步骤 + 尝试 + 收件人。
      // 工作位那一步走 beginTurn 追加 u{n}；评审那一步复用同一轮，必须单独补一张，
      // 否则它收到的指令根本不进消息流（群聊窗口里看不到，2026-09-06 维护者报的就是这个）。
      const dispatchMeta = workflowRun && Number.isInteger(Number(workflowRun.stepIndex))
        ? {
            kind: String(workflowRun.kind || 'workflow'),
            stepIndex: Number(workflowRun.stepIndex),
            attempt: Number(workflowRun.attempt) || 1,
            runId: workflowRun.runId || null,
            toMemberIds: targetMembers.map(m => m.memberId).filter(Boolean),
            toLabels: targetMembers.map(m => m.displayName).filter(Boolean),
            ...(workflowRun.kind==='delivery' && dispatchPresentation ? {
              goal:dispatchPresentation.goal,stageName:dispatchPresentation.stageName,
            } : {}),
          }
        : null;
      const begin = orch.beginTurn(displayUserInput === undefined ? userInput || '' : displayUserInput, {
        turnNum: isReusedTurn ? requestedTurnNum : undefined,
        appendUserMessage: appendUserMessage !== false,
        dispatchMode: dispatchMode || 'group',
        dispatch: dispatchMeta?.kind === 'conversation' ? null : dispatchMeta,
        // 渲染层本地气泡的身份，原样带进权威 user 消息；内部编排（循环/串行）不带。
        // 与上面的 dispatch 元数据互不相干：一个回答「这次派发是谁的第几步」，
        // 一个回答「服务端接手的是不是用户刚按下的那一条」，两者都要留在消息上。
        clientMessageId,
      });
      const { turnNum, runId } = begin;
      if (dispatchMeta && dispatchMeta.kind !== 'conversation' && !begin.didAppendUserMessage) {
        try { orch.appendDispatchMessage(turnNum, userInput || '', dispatchMeta); }
        catch (e) { warn('[groupchat] dispatch card append failed:', e && e.message); }
      }
      // deliveredIdx 必须在补卡之后取：它是「这位成员已经看到这里」的游标，
      // 补卡是 role==='user'（buildDelta 会过滤掉），游标越过它不改变任何人看到的内容。
      const deliveredIdx = orch.state.messages.length - 1;
      // Max, not last: a message renumbered by a changed answer file may sit earlier in the list.
      const deliveredSeq = orch.state.messages.reduce((max, m) => Number.isInteger(m && m.seq) && m.seq > max ? m.seq : max, 0);
      const fileMembers = DevFile.enabled(meeting) ? groupMembersForMeeting(meeting, { includeDormant: true }) : [];
      const fileProtocolKey = DevFile.enabled(meeting) ? DevFile.protocolKey(meeting, fileMembers) : null;
      // 群成员名单按群聊成员身份算（含暂时 dormant 的），只给名字 + CLI/模型。
      // 用「本轮是否在线」算会让成员一休眠就被报成「已离开」。
      const roster = groupMembersForMeeting(meeting, { includeDormant: true })
        .map(m => ({ sid: m.sid, name: m.displayName, kind: m.kind, model: m.model }));
      const targets = targetMembers.map(member => {
        const systemPromptText = groupchat.buildSystemPromptText(member.displayName, meeting.scene, {
          kind: member.kind,
          // 产物写进本群聊的 workspace，而不是 home 下的公共 artifacts 目录。
          workspace: meeting.workspace || null,
          extraRules: OrchestrationRules.rulesFor(getHubDataDir(), meeting, member.memberId),
        });
        // File protocol is sent once per actual session and role/name binding,
        // and only acknowledged after successful delivery. Ordinary messages
        // keep the existing conversation delta, including manual "continue".
        const needsFileProtocol = fileProtocolKey && orch.state.devFilePromptReceipts?.[member.sid]?.key !== fileProtocolKey;
        const basePrompt = DevDiscuss.appendDiscussBlock(
          orch.buildFirstDelta(member.sid, userInput || '', systemPromptText, {
            currentUserMessageAppended: begin.didAppendUserMessage,
            roster,
            contextUsed: memberContextUsed(member.sid),
          }),
          DevFile.enabled(meeting)
            ? (needsFileProtocol ? DevFile.common(meeting, DevFile.directory(getHubDataDir(), meeting.id), fileMembers) : '')
            : DevDiscuss.discussBlockFor(meeting, member.memberId),
        );
        // 这位成员还没确认收到的维护者插话，逐条补进本次 prompt。
        // 只有 sendToPty 真的成功之后才标已读（见下方 markUserSupplementsDelivered），
        // 失败就继续挂着待确认，不提前标、也不盲目重发。
        const pendingSupplements = orch.pendingUserSupplementsFor(member.sid);
        const supplementBlock = pendingSupplements.length ? orch.buildUserSupplementBlock(member.sid) : '';
        return {
          sid: member.sid,
          kind: member.kind,
          label: member.displayName,
          member,
          deliveredIdx,
          deliveredSeq,
          supplementSeqs: pendingSupplements.map(item => item.seq),
          fileProtocolKey: needsFileProtocol ? fileProtocolKey : null,
          runId,
          prompt: supplementBlock ? `${basePrompt}\n\n${supplementBlock}` : basePrompt,
        };
      });

      // Markdown answers: the card shows what each member writes to its file.
      if (!silent && GroupAnswers.enabled(meeting)) {
        for (const t of targets) {
          try {
            const entry = GroupAnswers.entryFor({ dataDir: getHubDataDir(), meetingId, turnNum, memberId: t.member?.memberId || t.sid, speaker: t.label, workflowRun });
            require('node:fs').mkdirSync(entry.dir, { recursive: true });
            orch.registerAnswerFile(turnNum, t.sid, entry);
            const note = GroupAnswers.instruction(entry);
            if (note) t.prompt = `${t.prompt}\n\n${note}`;
          } catch (e) { warn('[groupchat] answer file registration failed:', e && e.message); }
        }
      }

      for (const t of targets) {
        cancelPatchListenersForSid(t.sid);
        try {
          const receipt = orch.recordTurnPrompt(turnNum, t.sid, t.prompt, {
            workflowRun,
            runId,
            memberId: t.member && t.member.memberId,
            kind: t.kind,
            mode: 'group',
            dispatchAt: turnStartedAt,
          });
          t.attemptId = receipt && receipt.attemptId;
          if (DevFile.enabled(meeting) || require('../../core/delivery-workflow').enabled(meeting)) require('../../core/dev-chat-history').rememberPrompt(orch,t.sid,receipt);
          t.attempt = t.attemptId ? orch.getAttempt(t.attemptId) : null;
          if (t.attempt && !silent) publishAttempt(meetingId, orch, t.attempt);
        }
        catch (e) { warn('[groupchat] recordTurnPrompt threw:', e && e.message); }
      }

      const sentTargets = [];
      const sendFailures = [];
      await Promise.all(targets.map(async (t) => {
        try {
          const sendStartedAt = Date.now();
          if (t.attemptId) {
            const submitting = orch.updateAttempt(t.attemptId, {
              status: 'submitting',
              dispatchAt: sendStartedAt,
            }, 'attempt_submitting');
            t.attempt = submitting;
            if (!silent) publishAttempt(meetingId, orch, submitting);
          }
          const sendResult = await groupChatWatcher.sendToPty(t.sid, t.prompt, t.kind, {
            clientSubmissionId: t.attemptId, metadata: { attemptId: t.attemptId, runId, meetingId, turnNum },
            shouldSubmit:()=>!interruptedSinceStart() && (!shouldDispatch || shouldDispatch()),
          });
          const ok = sendResult && sendResult.ok;
          const sendStatus = sendResult && sendResult.sendStatus;
          if (onSubmission) onSubmission({memberId:t.member.memberId,sid:t.sid,attemptId:t.attemptId,ok:!!ok && sendStatus!=='stuck',sendStatus,reason:sendResult?.reason,at:Date.now()});
          try {
            orch.setSendStatus(turnNum, t.sid, sendStatus || (ok ? 'submitted' : 'send_failed'), {
              acknowledgementSource: sendResult && sendResult.acknowledgementSource,
              providerTurnId: sendResult && sendResult.acknowledgementTurnId,
              userMessageId: sendResult && sendResult.userMessageId,
              nativePromptFingerprint: sendResult && sendResult.promptFingerprint,
              providerThreadId: sendResult?.clientSubmissionId===t.attemptId ? sendResult.threadId : null,
              attemptId: t.attemptId,
            });
          } catch (e) {
            if (sessionManager.getNativeClaude?.(t.sid) || sessionManager.getNativeCodex?.(t.sid)) throw e;
            warn('[groupchat] persist send receipt failed:', e && e.message);
          }
          if (!silent && ok) {
            try {
              emitGroupChat('groupchat-send-ack', {
                meetingId,
                turnNum,
                runId,
                attemptId: t.attemptId,
                sid: t.sid,
                kind: t.kind,
                sendStatus: sendStatus || 'ok',
                acknowledgementSource: sendResult && sendResult.acknowledgementSource || null,
                enterAttempts: Number(sendResult && sendResult.enterAttempts) || null,
                providerTurnId: sendResult && sendResult.acknowledgementTurnId || null,
                userMessageId: sendResult && sendResult.userMessageId || null,
                ...(sendResult && sendResult.probeDiagnostics ? { probeDiagnostics: sendResult.probeDiagnostics } : {}),
              });
            } catch (e) { warn('[groupchat] send ack telemetry failed:', e && e.message); }
          }
          // The semantic submit watchdog has already sent bounded late Enter
          // recoveries. Surface the escape action immediately for every
          // provider (including Codex); the marker monitor may continue trying
          // in the background, and a later streaming heartbeat clears the UI.
          if (!silent && sendStatus === 'stuck') {
            emitGroupChat('groupchat-send-stuck', {
              meetingId, turnNum, runId, attemptId: t.attemptId, sid: t.sid, kind: t.kind,
            });
          }
          if (ok) {
            if (t.fileProtocolKey) {
              orch.state.devFilePromptReceipts ||= {};
              orch.state.devFilePromptReceipts[t.sid] = { key: t.fileProtocolKey, memberId: t.member.memberId, attemptId: t.attemptId };
              orch._saveState('dev_file_protocol_delivered', { sid: t.sid, attemptId: t.attemptId });
            }
            // 送达确认了才记「这位收到过这几条插话」。发送失败走 else 分支，账本原样留着。
            if (t.supplementSeqs && t.supplementSeqs.length) {
              try { orch.markUserSupplementsDelivered(t.sid, t.supplementSeqs, {queued:sendStatus==='queued'}); }
              catch (e) { warn('[groupchat] mark user supplement delivered failed:', e && e.message); }
            }
            t.promptSubmitSinceTs = Math.max(0, sendStartedAt - 1000);
            t.promptSubmittedAt = sendStartedAt;
            t.submissionAcknowledged = !!(sendResult && sendResult.acknowledgementSource);
            t.providerTurnId = sendResult && sendResult.acknowledgementTurnId || null;
            t.attempt = t.attemptId ? orch.getAttempt(t.attemptId) : t.attempt;
            if (t.attempt && !silent) publishAttempt(meetingId, orch, t.attempt);
            sentTargets.push(t);
            const submitAcknowledged = !!(sendResult && sendResult.acknowledgementSource);
            // A semantic or strong-current-screen acknowledgement proves the
            // paste was submitted. Continuing to scan historical paste markers
            // after that produced false `send-stuck` banners during real work.
            if (!silent && (!submitAcknowledged || sendStatus === 'stuck')) {
              startPasteTrappedMonitor(t.sid, t.kind, meetingId, {
                turnNum, runId, attemptId: t.attemptId,
              });
            }
          } else {
            const failed = projectNativeOutcome({
              sid: t.sid,
              label: t.label,
              status: 'errored',
              text: '',
              reason: sendResult && sendResult.reason || 'cli_not_ready',
              deliveredIdx: t.deliveredIdx,
              deliveredSeq: t.deliveredSeq,
              // 没送进 CLI：completeTurn 不得推进它的已读游标（下一轮要补上这段）。
              promptDelivered: false,
              runId,
              attemptId: t.attemptId,
              failure: classifyProviderFailure({
                reason: sendResult && sendResult.reason || 'cli_not_ready', force: true,
              }),
              sourcePrompt: t.prompt,
            }, t);
            sendFailures.push(failed);
            if (t.attemptId) {
              orch.settleAttempt(t.attemptId, failed);
              if (!silent) publishAttempt(meetingId, orch, orch.getAttempt(t.attemptId));
            }
            if (!silent) emitGroupChat('groupchat-partial-update', { meetingId, turnNum, runId, attemptId: t.attemptId, mode: 'group', ...failed });
          }
        } catch (e) {
          try { orch.setSendStatus(turnNum, t.sid, 'send_exception', { reason: e && e.message, attemptId: t.attemptId }); }
          catch (receiptError) { warn('[groupchat] persist send exception receipt failed:', receiptError && receiptError.message); }
          const failed = projectNativeOutcome({
            sid: t.sid,
            label: t.label,
            status: 'errored',
            text: '',
            reason: e && e.message || 'send_exception',
            deliveredIdx: t.deliveredIdx,
            deliveredSeq: t.deliveredSeq,
            promptDelivered: false,
            runId,
            attemptId: t.attemptId,
            failure: classifyProviderFailure({ code:e?.code, uncertain:e?.uncertain, reason: e && e.message || 'send_exception', force: true }),
            sourcePrompt: t.prompt,
          }, t);
          sendFailures.push(failed);
          if (t.attemptId) {
            orch.settleAttempt(t.attemptId, failed);
            if (!silent) publishAttempt(meetingId, orch, orch.getAttempt(t.attemptId));
          }
          if (!silent) emitGroupChat('groupchat-partial-update', { meetingId, turnNum, runId, attemptId: t.attemptId, mode: 'group', ...failed });
          warn(`[groupchat] turn ${turnNum} sendToPty threw for ${t.kind}(${t.sid.slice(0,8)}):`, e && e.message);
        }
      }));

      if (sentTargets.length === 0) {
        // 2026-07-20 maintainer [修#3d 边界]：全部被勾选成员都 dormant/不可达时，仍以 absent
        //   落轮——让用户看到"缺席"占位，而不是问题发出后整轮凭空回滚消失。
        const immediateFailures = absentMembers.concat(sendFailures);
        if (immediateFailures.length > 0 && !silent) {
          const memberBySid0 = {};
          for (const m of members) memberBySid0[m.sid] = m;
          const turnRecord0 = orch.completeTurn(turnNum, userInput || '', immediateFailures, memberBySid0, {}, {
            dispatchMode: dispatchMode || 'group',
            workflowRun,
            runId,
          });
          const meta0 = (turnRecord0 && turnRecord0.meta) || { dispatchMode: 'group' };
          emitGroupChat('groupchat-turn-complete', { meetingId, turnNum, runId, mode: 'group', results: immediateFailures, meta: meta0, superseded: false, completedAt: Date.now() });
          notifyGroupChatComplete({
            meetingId,
            turnNum,
            runId,
            results: immediateFailures,
            meta: meta0,
            durationMs: Date.now() - turnStartedAt,
            superseded: false,
            interrupted: false,
          }, meeting);
          return { status: 'completed', turnNum, results: immediateFailures, meta: meta0 };
        }
        if (isReusedTurn) orch.clearTurnInProgress(turnNum, runId);
        else orch.rollbackTurn(turnNum, runId);
        return { status: 'no_sent', turnNum };
      }

      // 2026-07-21 maintainer [修思考中口径]：把本轮真正发出 prompt 的 sid 列表告诉 renderer——
      //   此前 renderer 用"勾选成员"乐观猜测（triggerGroupChat 的 _gcActiveSids），
      //   @ 点名/部分勾选时没收到提问的 AI 也显示"思考中"。
      if (!silent) {
        try {
          emitGroupChat('groupchat-turn-targets', {
            meetingId,
            turnNum,
            runId,
            sids: sentTargets.map(t => t.sid),
            attemptIdsBySid: Object.fromEntries(sentTargets.map(t => [t.sid, t.attemptId || null])),
          });
        } catch (error) {
          warn('[groupchat] turn target delivery failed:', error && error.message);
        }
      }

      // 内部编排式调用可传 turnTimeoutMs：卡住的成员到点强制 skip，
      // 不阻塞整轮（防 paste-trapped 无限等待）。普通群聊保持无硬超时。
      // 注意：下面的 .map 是同步的，所有 watcher 在 await 之前就已注册进 activeWatchers，
      //   所以「send 期间被中断」可以在这里补一次结算（见 interruptedSinceStart）。
      const settledPromise = Promise.allSettled(sentTargets.map(t =>
        waitTurnComplete(t.sid, t.label, {
          meetingId, mode: 'group', turnNum, kind: t.kind, prompt: t.prompt, promptSubmitSinceTs: t.promptSubmitSinceTs,
          promptSubmittedAt: t.promptSubmittedAt,
          runId,
          attemptId: t.attemptId,
          attempt: t.attempt,
          providerTurnId: t.providerTurnId,
          submissionAcknowledged: t.submissionAcknowledged,
          memberId: t.member && t.member.memberId,
          speaker: t.label,
          disableHardTimeout: !(Number(turnTimeoutMs) > 0),
          hardTimeoutMs: Number(turnTimeoutMs) > 0 ? Number(turnTimeoutMs) : undefined,
          allowActiveExtend,
          silent,
          onPartial: silent ? null : (partial) => {
            // 抢占结算的 superseded 是内部信号，不推 partial-update：此刻新一轮已乐观清空
            //   partialBy，推过去会让被抢占的卡片闪一下「已被覆盖」再跳回思考中。旧轮的
            //   superseded 已随 turn-complete 持久化进 state.turns，历史回看可见。
            if (partial.status === 'superseded') return;
            emitGroupChat('groupchat-partial-update', {
              meetingId, turnNum, runId, attemptId: t.attemptId, mode: 'group',
              sid: partial.sid, label: partial.label,
              status: partial.status,
              text: partial.text,
              blocks: partial.blocks,
              displayMessages: partial.displayMessages,
              source: partial.source,
              thinkSec: partial.thinkSec, tokens: partial.tokens,
              cleanBufLen: partial.cleanBufLen,
              // errored settle 也走 onPartial：带上失败原因，让气泡占位文案能解释"为什么失败"
              reason: partial.reason,
              failure: partial.failure || null,
              providerTurnId: partial.providerTurnId || t.providerTurnId || null,
            });
          },
        })
      ));

      // send 期间被中断：watcher 刚同步注册完，立刻补一次结算，否则本轮会开始
      //   等一个已经被用户叫停的回答，卡片永久停在"思考中"。
      if (!silent && interruptedSinceStart()) {
        try { interruptMeetingTurn(meetingId, { reason: 'user_interrupt_during_send' }); }
        catch (e) { warn('[groupchat] late interrupt settle threw:', e && e.message); }
      } else if (!silent && _dispatchSeq != null && meetingDispatchSeq.get(interruptKey) !== _dispatchSeq) {
        // send 期间被下一问抢占（2026-07-29 maintainer）：dispatchGroupChatTurn 里的抢占发生在
        //   「本轮还在 sendToPty、activeWatchers 还是空」的窗口时会落空，新一问就要被串行
        //   队列扣到本轮成员自然结算为止（CLI 卡死时可能是几分钟——用户感知就是"追问石沉大海"）。
        //   watcher 刚同步注册完，这里补一次抢占，让追加的提问立刻开跑。
        try { supersedeActiveWatchersForMeeting(meetingId, meetingHandoffSeq.get(interruptKey) === meetingDispatchSeq.get(interruptKey)); }
        catch (e) { warn('[groupchat] late preempt supersede threw:', e && e.message); }
      }
      const settled = await settledPromise;

      const results = settled.map((s, i) => s.status === 'fulfilled' ? s.value : {
        sid: sentTargets[i].sid,
        label: sentTargets[i].label,
        status: 'errored',
        text: '',
        reason: s.reason?.message || 'Promise rejected',
      }).map((r, i) => ({
        ...r,
        deliveredIdx: sentTargets[i] && sentTargets[i].deliveredIdx,
        deliveredSeq: sentTargets[i] && sentTargets[i].deliveredSeq,
        runId: r.runId || runId,
        attemptId: r.attemptId || (sentTargets[i] && sentTargets[i].attemptId),
        providerTurnId: r.providerTurnId || (sentTargets[i] && sentTargets[i].providerTurnId) || null,
      })).concat(absentMembers, sendFailures);
      const memberBySid = {};
      for (const m of members) memberBySid[m.sid] = m;
      if (silent) {
        orch.rollbackTurn(turnNum, runId);
        // 标记已投递：后续幕 buildFirstDelta 走增量，不再每幕重发完整 systemPrompt（含战法规则）。点2。
        try { orch.markDeliveredSilent(results); } catch (e) { warn('[group-chat] markDeliveredSilent threw:', e && e.message); }
        return { status: 'completed', turnNum: null, results, meta: { dispatchMode: 'silent' } };
      }
      const turnRecord = orch.completeTurn(turnNum, userInput || '', results, memberBySid, {}, {
        dispatchMode: dispatchMode || 'group',
        workflowRun,
        runId,
      });
      const meta = turnRecord.meta || { dispatchMode: 'group' };
      // 被抢占判定：完成时若 meeting 的最新派发序号已超过自己 → 用户已发更新的轮，
      //   本轮是被 supersede 的旧轮。前端据此跳过「清 currentMode」避免抹掉新轮思考态。
      const wasSuperseded = _dispatchSeq != null && meetingDispatchSeq.get(String(meetingId || '')) !== _dispatchSeq;
      // 用户中断判定：本轮任一成员被叫停即视为整轮被中断。串行工作流 / 循环引擎靠
      //   这个返回值决定「不要继续往下一步跑」——否则下一步会拿着空结果继续编排。
      const wasInterrupted = interruptedSinceStart()
        || results.some(r => r && r.status === 'interrupted');
      emitGroupChat('groupchat-turn-complete', { meetingId, turnNum, runId, mode: 'group', results, meta, superseded: wasSuperseded, interrupted: wasInterrupted, completedAt: Date.now() });
      notifyGroupChatComplete({
        meetingId,
        turnNum,
        runId,
        results,
        meta,
        durationMs: Date.now() - turnStartedAt,
        superseded: wasSuperseded,
        interrupted: wasInterrupted,
      }, meeting);
      return { status: 'completed', turnNum, runId, results, meta, superseded: wasSuperseded, interrupted: wasInterrupted };
    } finally {
      if (!silent) {
        const left = (meetingInFlightTurns.get(inFlightKey) || 1) - 1;
        if (left > 0) meetingInFlightTurns.set(inFlightKey, left);
        else meetingInFlightTurns.delete(inFlightKey);
      }
    }
  }

  function resultFromPersistedAttempt(orch, attempt) {
    const message = (orch.state.messages || []).find(item => item
      && item.role === 'assistant'
      && item.attemptId === attempt.attemptId);
    const status = attempt.status === 'completed' ? 'completed'
      : attempt.status === 'failed' ? 'errored'
        : attempt.status;
    return {
      sid: attempt.sid,
      status,
      text: message && message.content || '',
      reason: attempt.reason || null,
      failure: attempt.failure || null,
      attemptId: attempt.attemptId,
      runId: attempt.runId,
      providerTurnId: attempt.providerTurnId || null,
      completedAt: attempt.completedAt || Date.now(),
      ...(attempt.promptDelivered === false ? { promptDelivered: false } : {}),
    };
  }

  async function recoverPendingAttempts(options = {}) {
    const meetings = options.meetingId
      ? [meetingManager.getMeeting(options.meetingId)].filter(Boolean)
      : ((meetingManager.getAllMeetings && meetingManager.getAllMeetings()) || []);
    const summary = { checked: 0, recovered: 0, pending: 0, finalizedRuns: 0, errors: [] };
    for (const meeting of meetings) {
      if (!meeting || !meeting.groupChat) continue;
      const orch = orchestratorFor(meeting.id);
      const recoverable = orch.listRecoverableAttempts({ sid: options.sid || null, recoveryOnly: true });
      const touchedRuns = new Set();
      const restartRunId = orch.state.activeRun && orch.state.activeRun.status === 'recovering'
        ? orch.state.activeRun.runId
        : null;
      for (const attempt of Object.values(orch.state.attempts || {})) {
        if (!attempt || !attempt.runId || !Number(attempt.turnNum)) continue;
        if (options.sid && attempt.sid !== options.sid) continue;
        if (attempt.recoveryReason !== 'hub_restart' && attempt.runId !== restartRunId) continue;
        const alreadyFinalized = (orch.state.turns || []).some(turn => turn && turn.runId === attempt.runId);
        if (!alreadyFinalized) touchedRuns.add(attempt.runId);
      }
      for (const receipt of recoverable) {
        summary.checked += 1;
        touchedRuns.add(receipt.runId);
        const liveSession = sessionManager.getSession(receipt.sid);
        if (!liveSession) {
          const waiting = orch.updateAttempt(receipt.attemptId, {
            status: 'recovering',
            reason: 'awaiting_session_resume',
          }, 'attempt_recovery_waiting');
          publishAttempt(meeting.id, orch, waiting, { recovery: true });
          summary.pending += 1;
          continue;
        }
        try {
          const floor = Math.max(Number(receipt.startedAt) || 0, Number(receipt.acceptedAt) || 0, Number(receipt.dispatchAt) || 0);
          if (require('../../core/codex-native-runtime').isNativeSession(liveSession)) {
            const nativeSession = (sessionManager.getNativeSession?.(receipt.sid) || sessionManager.getNativeCodex?.(receipt.sid));
            if (nativeSession) await nativeSession.start();
            const outcome = nativeSession && await nativeSession.readOutcome(receipt.providerTurnId);
            if (outcome) {
              orch.patchTurnResult(receipt.turnNum,receipt.sid,{
                ...outcome,status:outcome.status === 'failed' ? 'errored' : outcome.status,
                attemptId:receipt.attemptId,runId:receipt.runId,memberId:receipt.memberId,
                providerTurnId:outcome.turnId,speaker:liveSession.title || 'Codex',
              });
              publishAttempt(meeting.id,orch,orch.getAttempt(receipt.attemptId),{recovery:true});
              summary.recovered += 1;
            } else {
              const pending = orch.updateAttempt(receipt.attemptId,{
                status:ATTEMPT_AWAITING_BINDING,reason:'native_outcome_unconfirmed',
              },'native_recovery_pending');
              publishAttempt(meeting.id,orch,pending,{recovery:true});
              summary.pending += 1;
            }
            continue;
          }
          if (liveSession.runtimeBackend === 'claude-stream-json') {
            const nativeSession = sessionManager.getNativeClaude?.(receipt.sid);
            const record = nativeSession?.records.get(receipt.attemptId);
            const matches = record && receipt.userMessageId === record.userMessageId
              && receipt.nativePromptFingerprint === record.fingerprint;
            if (matches && ['completed', 'failed', 'interrupted'].includes(record.status)) {
              orch.patchTurnResult(receipt.turnNum, receipt.sid, {
                text: record.finalText || '', status: record.status === 'failed' ? 'errored' : record.status,
                attemptId: receipt.attemptId, runId: receipt.runId, memberId: receipt.memberId,
                userMessageId: record.userMessageId, providerTurnId: null,
                signalSource: 'claude-stream-json', completedAt: record.completedAt,
                speaker: liveSession.title || 'Claude', finality: record.status === 'completed' ? 'provider_final' : record.status,
              });
              publishAttempt(meeting.id, orch, orch.getAttempt(receipt.attemptId), { recovery: true });
              summary.recovered += 1;
            } else {
              const pending = orch.updateAttempt(receipt.attemptId, {
                status: ATTEMPT_AWAITING_BINDING, reason: 'native_outcome_unconfirmed',
              }, 'native_recovery_pending');
              publishAttempt(meeting.id, orch, pending, { recovery: true });
              summary.pending += 1;
            }
            continue;
          }
          const extracted = await transcriptTap.extractLatestTurn(receipt.sid, floor);
          const codexFinal = isCodexBaseKind(receipt.kind) && extracted && extracted.extractMode === 'final_answer';
          // 与上面 auto-extract 同一条判据：恢复路径同样不能把未完成的开场白
          //   写成本轮最终答案（重启后它还会顺带 completeTurn 整轮）。
          const claudeFinal = isClaudeFamily(receipt.kind) && extracted
            && extracted.source === 'manual_claude_transcript'
            && extracted.extractMode === 'final_answer'
            && (!floor || Number(extracted.completedAt) >= floor);
          const providerTurnMatches = !receipt.providerTurnId || !extracted || !extracted.turnId
            || String(receipt.providerTurnId) === String(extracted.turnId);
          if (extracted && extracted.text && (codexFinal || claudeFinal) && providerTurnMatches) {
            const member = groupMembersForMeeting(meeting).find(item => item.sid === receipt.sid) || {};
            orch.patchTurnResult(receipt.turnNum, receipt.sid, {
              text: extracted.text,
              status: 'completed',
              memberId: receipt.memberId || member.memberId,
              speaker: member.displayName || liveSession.title || liveSession.kind || 'AI',
              attemptId: receipt.attemptId,
              runId: receipt.runId,
              providerTurnId: extracted.turnId || receipt.providerTurnId || null,
              signalSource: isCodexBaseKind(receipt.kind)
                ? 'codex_auto_extract_final_answer'
                : 'claude_auto_extract_final_answer',
              finality: 'provider_final',
              completedAt: extracted.completedAt || Date.now(),
            });
            const recovered = orch.getAttempt(receipt.attemptId);
            publishAttempt(meeting.id, orch, recovered, { recovery: true });
            summary.recovered += 1;
          } else {
            const waiting = orch.updateAttempt(receipt.attemptId, {
              status: extracted && extracted.extractMode === 'partial_commentary'
                ? ATTEMPT_RUNNING
                : ATTEMPT_AWAITING_BINDING,
              reason: extracted && extracted.extractMode || 'final_not_persisted_yet',
            }, 'attempt_recovery_pending');
            publishAttempt(meeting.id, orch, waiting, { recovery: true });
            summary.pending += 1;
          }
        } catch (error) {
          summary.errors.push({ meetingId: meeting.id, attemptId: receipt.attemptId, message: error && error.message });
          const waiting = orch.updateAttempt(receipt.attemptId, {
            status: ATTEMPT_AWAITING_BINDING,
            reason: 'recovery_read_failed',
          }, 'attempt_recovery_failed');
          publishAttempt(meeting.id, orch, waiting, { recovery: true });
          summary.pending += 1;
        }
      }

      for (const runId of touchedRuns) {
        const attempts = Object.values(orch.state.attempts || {}).filter(item => item && item.runId === runId);
        if (!attempts.length || attempts.some(item => !isTerminalAttemptStatus(item.status))) continue;
        const turnNum = Number(attempts[0].turnNum) || 0;
        if (!turnNum || (orch.state.turns || []).some(turn => turn && turn.runId === runId)) continue;
        const userMessage = (orch.state.messages || []).find(item => item && item.role === 'user' && Number(item.turnNum) === turnNum);
        const members = groupMembersForMeeting(meeting);
        const memberBySid = Object.fromEntries(members.map(member => [member.sid, member]));
        const results = attempts.map(attempt => resultFromPersistedAttempt(orch, attempt));
        orch.completeTurn(turnNum, userMessage && userMessage.content || '', results, memberBySid, {}, {
          dispatchMode: 'recovery', runId,
        });
        emitGroupChat('groupchat-turn-complete', {
          meetingId: meeting.id,
          turnNum,
          runId,
          mode: 'group',
          results,
          meta: { dispatchMode: 'recovery' },
          superseded: false,
          interrupted: results.some(item => item.status === 'interrupted'),
          completedAt: Date.now(),
          recovered: true,
        });
        summary.finalizedRuns += 1;
      }
    }
    return summary;
  }

  async function runRecoveryForSession(sessionId) {
    const session = sessionManager.getSession(sessionId);
    if (!session || !session.meetingId) return { checked: 0, recovered: 0, pending: 0, finalizedRuns: 0, errors: [] };
    const delays = [0, 1000, 2000, 4000, 8000, 16000];
    let aggregate = { checked: 0, recovered: 0, pending: 0, finalizedRuns: 0, errors: [] };
    for (const delayMs of delays) {
      if (delayMs) {
        await new Promise(resolve => {
          const timer = setTimeout(resolve, delayMs);
          timer.unref?.();
        });
      }
      const current = await recoverPendingAttempts({ meetingId: session.meetingId, sid: sessionId });
      aggregate = {
        checked: aggregate.checked + current.checked,
        recovered: aggregate.recovered + current.recovered,
        pending: current.pending,
        finalizedRuns: aggregate.finalizedRuns + current.finalizedRuns,
        errors: aggregate.errors.concat(current.errors || []),
      };
      if (current.pending === 0) break;
    }
    return aggregate;
  }

  function recoverSession(sessionId) {
    const key = String(sessionId || '');
    if (!key) return Promise.resolve({ checked: 0, recovered: 0, pending: 0, finalizedRuns: 0, errors: [] });
    if (recoveryBySid.has(key)) return recoveryBySid.get(key);
    const task = runRecoveryForSession(key).finally(() => {
      if (recoveryBySid.get(key) === task) recoveryBySid.delete(key);
    });
    recoveryBySid.set(key, task);
    return task;
  }

  function markProcessExitForSession(sessionId, exitInfo) {
    const watcher = activeWatchers.get(sessionId);
    if (!watcher) return false;
    const adapted = exitInfo
      ? { code: typeof exitInfo.exitCode === 'number' ? exitInfo.exitCode : null, signal: exitInfo.signal }
      : { code: null };
    log(`[group-chat] PTY exit detected for sid=${sessionId.slice(0, 8)} (code=${adapted.code} signal=${adapted.signal || 'none'}), notifying watcher`);
    try { watcher.markProcessExit(adapted); } catch (e) {
      warn('[group-chat] markProcessExit threw:', e.message);
    }
    return true;
  }

  return {
    dispatchGroupChatTurn,
    handoffMeetingTurn,
    interruptMeetingTurn,
    groupMembersForMeeting,
    getActiveWatchers: () => activeWatchers,
    getActiveWatchersByAttempt: () => activeWatchersByAttempt,
    getGroupChatWatcher: () => groupChatWatcher,
    markProcessExitForSession,
    recoverPendingAttempts,
    recoverSession,
  };
}

module.exports = {
  CODEX_AUTO_EXTRACT_DELAY_MS,
  INTERRUPT_KEY,
  createGroupChatDispatcher,
  _parseGroupTargets: parseGroupTargets,
};
