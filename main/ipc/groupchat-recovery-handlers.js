'use strict';

const { isCodexCliKind } = require('../../core/ai-kinds.js');

function registerGroupchatRecoveryIpc(ipcMain, deps) {
  const {
    dispatchGroupChatTurn,
    getHubDataDir,
    getActiveWatchers,
    groupchat,
    groupChatWatcher,
    isWorkflowRunning = () => false,
    logger = console,
    meetingManager,
    sendToRenderer,
    sessionManager,
    transcriptTap,
  } = deps;

  ipcMain.handle('groupchat-manual-extract', async (_e, { meetingId, sid, sincePromptTs, turnNum } = {}) => {
    if (!sid) return { ok: false, reason: 'missing_sid' };

    const session = sessionManager.getSession(sid);
    const kind = session?.kind || 'unknown';
    const runtimeKind = session?.transcriptKind || kind;
    const nativeClaude = sessionManager.getNativeClaude?.(sid);
    const isNativeClaude = !!nativeClaude || session?.runtimeBackend === 'claude-stream-json';
    const nativeCodex = sessionManager.getNativeCodex?.(sid);
    const isNativeCodex = !!nativeCodex || session?.runtimeBackend === 'codex-app-server';

    // 2026-07-12 maintainer：轮次窗口改由 orchestrator 状态推导，不再信 renderer 的
    //   _gcTurnStartTs（那是"当前轮"的开始时间，对旧轮重提取完全错位；Hub 重启后是 0）。
    //   u{n}.createdAt 做下界、u{n+1}（该轮之后首条用户消息）做上界。
    const requestedTurn = Number.isFinite(Number(turnNum)) ? Number(turnNum) : null;
    let orch = null;
    let meeting = null;
    if (meetingId) {
      try {
        meeting = meetingManager.getMeeting(meetingId);
        if (meeting) orch = groupchat.getOrchestrator(getHubDataDir(), meetingId);
      } catch (err) {
        logger.warn('[manual-extract] orchestrator load failed:', err && err.message);
      }
      // 二轮加固（多方审查）：群聊调用拿不到 orchestrator 时诚实失败——旧行为会静默
      //   绕过旧轮拒绝/窗口推导，最后走 text_only 假成功（UI"已同步"但气泡不变）。
      if (!orch) {
        return { ok: false, reason: 'meeting_state_unavailable', detail: '群聊状态不可用（meeting 不存在或状态文件读取失败），无法定位轮次写回。' };
      }
    }
    if (orch && require('../../core/dev-file-workflow').enabled(meeting)) {
      const n=requestedTurn || orch.state.currentTurn;
      const receipts=Object.values(orch.state.devChatHistory?.receipts || {});
      const receipt=receipts.find(r=>r.sid===sid && r.turnNum===n);
      const sourcePath=receipt?.sourcePath || session?.transcriptPath
        || (typeof transcriptTap.getCodexRolloutPath==='function' && transcriptTap.getCodexRolloutPath(sid));
      if(!sourcePath)return {ok:false,reason:'source_unavailable',detail:'本轮原始记录尚未绑定，无法可靠重新收录；未重新发送任务。'};
      try {
        await require('../../core/dev-chat-history').recollectHistory({orch,sid,kind:receipt?.kind || runtimeKind,sourcePath,speaker:session?.title || 'Agent'});
        const owned=orch.state.messages.filter(m=>m.sourceMessage && m.sid===sid && Number(m.turnNum)===n);
        if(!owned.length)return {ok:false,reason:'source_identity_unavailable',detail:'没有找到与本轮提问匹配的原始发言；未使用最新回答填充旧轮。'};
        sendToRenderer('dev-workbench:progress',{meetingId,revision:orch.state.revision});
        return {ok:true,text:owned.map(m=>m.content).join('\n\n'),source:'transcript',mode:'dev_history_recollect'};
      } catch(error) { return {ok:false,reason:'extract_failed',detail:error.message}; }
    }
    const readCurrentTurn = () => (orch && Number.isFinite(orch.state.currentTurn) && orch.state.currentTurn > 0
      ? orch.state.currentTurn : null);
    let effectiveSince = Math.max(0, Number(sincePromptTs) || 0);
    let untilTs = null;
    let isLatestTurn = true;
    const orchCurrentTurn = readCurrentTurn();
    if (orch && requestedTurn !== null) {
      const msgs = Array.isArray(orch.state.messages) ? orch.state.messages : [];
      const userMsg = msgs.find(m => m && m.id === `u${requestedTurn}` && m.role === 'user');
      if (userMsg && Number.isFinite(userMsg.createdAt)) effectiveSince = userMsg.createdAt;
      const nextUser = msgs.find(m => m && m.role === 'user' && Number(m.turnNum) > requestedTurn);
      if (nextUser && Number.isFinite(nextUser.createdAt)) untilTs = nextUser.createdAt;
      if (orchCurrentTurn !== null && requestedTurn < orchCurrentTurn) isLatestTurn = false;
      // 二轮加固：要精确重提取"旧轮"但该轮用户消息缺失（被回滚/旧 schema 无 turnNum）
      //   → 无法建立轮次窗口，提取必然错位，诚实拒绝。当前轮保留宽松兜底（语义本就是"抓最新"）。
      if (!isLatestTurn && !userMsg) {
        return {
          ok: false,
          reason: 'turn_window_unavailable',
          detail: `第 ${requestedTurn} 轮的用户消息不在群聊记录中，无法建立提取窗口（可能已被回滚或为旧版本数据）。旧轮内容请点「原文」核对。`,
        };
      }
    }

    // 非 Codex 后端只能读"最新回答"，对旧轮重提取会拿到最新轮内容 → 张冠李戴。
    //   诚实拒绝，提示用户用「原文」核对旧轮，而不是静默写错数据。
    if (!isLatestTurn && !isCodexCliKind(runtimeKind) && !isNativeClaude && !isNativeCodex) {
      return {
        ok: false,
        reason: 'old_turn_resync_unsupported',
        detail: `该 AI（kind=${kind}）的 transcript 只能读取最新一轮回答，无法精确重提取第 ${requestedTurn} 轮（会误拿最新轮内容）。旧轮内容请点「原文」核对。`,
      };
    }

    let extracted = null;
    if (isNativeClaude) {
      if (!nativeClaude) return {ok:false,reason:'native_unavailable',detail:'请先打开该 Claude 成员会话，再核对本轮原生记录。'};
      const nativeTurnNum = requestedTurn || orchCurrentTurn;
      const turn = orch?.state.turns?.find(t=>t.n === nativeTurnNum);
      const submissionId = turn?.attemptIdBy?.[sid] || orch?.state.pendingPrompts?.[nativeTurnNum]?.[sid]?.attemptId;
      const record = submissionId && nativeClaude.records.get(submissionId);
      if (!record) return {ok:false,reason:'native_identity_unavailable',detail:'未找到与本轮派发身份匹配的 Claude 原生提交；请打开成员会话查看历史，不会用最新回答覆盖本轮。'};
      if (record.status !== 'completed') return {ok:false,reason:'native_not_completed',detail:
        nativeClaude.unreconciled ? '该 Claude 提交仍待核对。请打开成员会话查看原生历史，核对后继续；不要重复发送。'
          : 'Claude 本次提交尚无成功完成回执；请打开成员会话查看当前状态，稍后同步。'};
      if (!record.finalText?.trim()) return {ok:false,reason:'native_empty_result',detail:'Claude 本轮已结束，但原生最终回答为空；未使用其他轮次内容填充。'};
      extracted={text:record.finalText,source:'claude-stream-json',extractMode:'native_submission'};
    } else if (isNativeCodex) {
      if (!nativeCodex) return {ok:false,reason:'native_unavailable',detail:'请先打开该 Codex 成员会话，再核对本轮原生记录。'};
      const nativeTurnNum = requestedTurn || orchCurrentTurn;
      const identity = () => {
        const turn = orch?.state.turns?.find(t=>t.n === nativeTurnNum);
        const pending = orch?.state.pendingPrompts?.[nativeTurnNum]?.[sid];
        return {submissionId:turn?.attemptIdBy?.[sid] || pending?.attemptId,
          turnId:turn?.providerTurnIdBy?.[sid] || pending?.providerTurnId};
      };
      const expected = identity(), epoch = nativeCodex.runtime.epoch, threadId = nativeCodex.threadId;
      if (!expected.submissionId) return {ok:false,reason:'native_identity_unavailable',detail:'本轮缺少 Codex 原生提交身份；不会用最新回答覆盖本轮。'};
      try {
        // A late ACK may only be recoverable from thread/read. Reconcile is
        // read-only and validates the original client ID and content digest.
        if (!expected.turnId && nativeCodex.runtime.submission?.id === expected.submissionId) await nativeCodex.reconcile();
        const receipt = nativeCodex.receipts.get(expected.submissionId)?.result;
        const providerTurnId = expected.turnId || (receipt?.clientSubmissionId === expected.submissionId && receipt?.threadId === threadId ? receipt.turnId : null);
        if (!providerTurnId) return {ok:false,reason:'native_identity_unavailable',detail:'尚未找到本轮提交对应的 Codex 原生轮次，请先核对成员会话；未重新发送。'};
        const outcome = await nativeCodex.readOutcome(providerTurnId);
        if (nativeCodex.runtime.epoch !== epoch || nativeCodex.threadId !== threadId || identity().submissionId !== expected.submissionId) {
          return {ok:false,reason:'native_identity_changed',detail:'同步期间会话或派发身份已变化，请重新核对。'};
        }
        if (outcome?.turnId !== providerTurnId || outcome?.threadId !== threadId || outcome.status !== 'completed') {
          return {ok:false,reason:'native_not_completed',detail:'Codex 本次提交尚无成功完成回执，请在成员会话核对；未使用其他轮次内容。'};
        }
        if (!outcome.text?.trim()) return {ok:false,reason:'native_empty_result',detail:'Codex 本轮已结束，但原生最终回答为空。'};
        extracted={text:outcome.text,source:'codex-app-server',extractMode:'native_submission',providerTurnId};
      } catch (error) { return {ok:false,reason:'extract_failed',detail:error.message}; }
    } else {
      try {
        extracted = await transcriptTap.extractLatestTurn(sid, effectiveSince, { untilTs });
      } catch (err) {
        return { ok: false, reason: 'extract_failed', detail: err.message };
      }
      if (!extracted || !extracted.text) {
        // PTY/streaming 兜底只对"最新轮"有意义：旧轮内容早已不在流式缓冲里。
        if (isLatestTurn) {
          try {
            const fromPty = groupChatWatcher.extractStreamingText(sid, runtimeKind);
            if (fromPty && fromPty.text && fromPty.text.trim().length > 0) {
              extracted = {
                text: fromPty.text,
                source: fromPty.source || 'pty_buffer',
                extractMode: 'pty_buffer_fallback',
              };
            }
          } catch (err) {
            logger.warn('[manual-extract] PTY fallback failed:', err && err.message);
          }
        }
      }
    }
    if (!extracted || !extracted.text) {
      const extractMode = extracted?.extractMode || null;
      let detail;
      if (extractMode === 'no_rollout_bound') {
        detail = `Codex rollout 文件尚未绑定（kind=${kind}）。可能原因：（a）当天目录 ~/.codex/sessions/<今日>/ 还没新文件；（b）codex spawn 时的 cwd 与 rollout session_meta.cwd 不一致；（c）timestamp 超出绑定窗口 [-10s, +5min]。建议：等 5-10s（codex 通常 spawn 后才写 rollout 首行），或点"🔧 进 shell"看真实 PTY 输出确认 codex 是否真的启动了。`;
      } else if (extractMode === 'no_task_complete_yet') {
        detail = `Codex 已绑定 rollout 但${isLatestTurn ? '' : `第 ${requestedTurn} 轮窗口内`} task_complete 事件${isLatestTurn ? '尚未写入' : '未找到'}（kind=${kind}）。可能原因：（a）codex 仍在思考；（b）codex 在等 MCP 工具确认弹窗（如 ai-team team_respond），需要进 shell 点"Allow"；（c）codex 多 task 场景含 3s debounce，最后一个 task 完成后才 emit。建议：点"🔧 进 shell"看 codex 当前是否被 confirm 弹窗阻塞。`;
      } else {
        detail = `transcript 中没有可读的 last assistant 内容（kind=${kind}）。可能原因：CLI 还没真正回答 / transcript 路径未绑定 / Stop hook 没触发且 idle-timer 还没到期。建议稍等几秒重试，或点"🔧 进 shell"看真实 PTY 输出。`;
      }
      return {
        ok: false,
        reason: 'no_content',
        extractMode,
        detail,
      };
    }

    // watcher settle 只允许作用于"当前进行中的轮"：用户点旧轮的「重新提取」时，
    //   绝不能把旧轮文本结算进正在飞行的新轮（watcher 劫持 = 新轮答案被旧内容顶掉）。
    // 二轮加固（多方审查）：currentTurn 在 await extractLatestTurn 之后**重读**——
    //   提取期间用户可能已发下一轮（抢占式连发），旧快照会把旧轮文本 settle 进新轮 watcher。
    //   orch 存在但 currentTurn 无效（如投委会 internal 阶段 currentTurn=0）时，带 turnNum
    //   的请求不放行 watcher（internal watcher 不属于任何编号轮），走 patch 路径。
    const watcher = getActiveWatchers().get(sid);
    const freshCurrentTurn = readCurrentTurn();
    const watcherOwnsRequestedTurn = requestedTurn === null
      || (freshCurrentTurn !== null ? requestedTurn === freshCurrentTurn : !orch);
    if (watcher && watcherOwnsRequestedTurn) {
      watcher.manualExtract(extracted.text);
      return { ok: true, text: extracted.text, source: extracted.source, mode: 'watcher_settle', extractMode: extracted.extractMode || null };
    }

    if (meetingId) {
      try {
        if (orch) {
          const turns = Array.isArray(orch.state.turns) ? orch.state.turns : [];
          const targetTurn = requestedTurn !== null
            ? turns.find(t => t && t.n === requestedTurn)
            : turns[turns.length - 1];
          if (targetTurn) {
            const attemptId = targetTurn.attemptIdBy && targetTurn.attemptIdBy[sid];
            const providerTurnId = targetTurn.providerTurnIdBy?.[sid] || extracted.providerTurnId;
            const patched = orch.patchTurnResult(targetTurn.n, sid, {
              text: extracted.text,
              status: 'manual_extracted',
              ...(attemptId ? { attemptId } : {}),
              ...(targetTurn.runId ? { runId: targetTurn.runId } : {}),
              ...(providerTurnId ? { providerTurnId } : {}),
              signalSource: 'manual',
            });
            if (patched) {
              const revision = typeof orch.reserveRevision === 'function'
                ? orch.reserveRevision('manual_result_published', {
                    attemptId, runId: targetTurn.runId, turnNum: targetTurn.n, sid, status: 'manual_extracted',
                  })
                : null;
              sendToRenderer('groupchat-turn-patched', {
                meetingId,
                turnNum: targetTurn.n,
                ...(targetTurn.runId ? { runId: targetTurn.runId } : {}),
                ...(attemptId ? { attemptId } : {}),
                sid,
                charCount: (extracted.text || '').length,
                ...(revision ? { revision } : {}),
              });
              return { ok: true, text: extracted.text, source: extracted.source, mode: 'patch_groupchat_turn', extractMode: extracted.extractMode || null };
            }
          }
          // turns 只在全员结算后创建。当前/中断轮已有用户消息时，直接把成功提取的
          // 文本写入该轮的持久消息，优先保住可用结果，而不是误报“状态文件损坏”。
          const recoverTurnNum = requestedTurn !== null ? requestedTurn : freshCurrentTurn;
          const recoverUserMsg = recoverTurnNum !== null
            ? (orch.state.messages || []).find(m => m && m.role === 'user' && Number(m.turnNum) === Number(recoverTurnNum))
            : null;
          if (recoverUserMsg) {
            const memberIndex = meeting && Array.isArray(meeting.subSessions)
              ? meeting.subSessions.indexOf(sid)
              : -1;
            const memberSpec = memberIndex >= 0 && Array.isArray(meeting.slotSpecs)
              ? meeting.slotSpecs[memberIndex]
              : null;
            const pendingReceipt = orch.state.pendingPrompts
              && orch.state.pendingPrompts[String(recoverTurnNum)]
              && orch.state.pendingPrompts[String(recoverTurnNum)][sid];
            const patched = orch.patchTurnResult(recoverTurnNum, sid, {
              text: extracted.text,
              status: 'manual_extracted',
              memberId: memberIndex >= 0 ? ((memberSpec && memberSpec.memberId) || `m${memberIndex + 1}`) : undefined,
              speaker: session?.title || session?.kind || 'AI',
              ...(pendingReceipt && pendingReceipt.attemptId ? { attemptId: pendingReceipt.attemptId } : {}),
              ...(pendingReceipt && pendingReceipt.runId ? { runId: pendingReceipt.runId } : {}),
              ...(extracted.providerTurnId || extracted.turnId || (pendingReceipt && pendingReceipt.providerTurnId)
                ? { providerTurnId: extracted.providerTurnId || extracted.turnId || pendingReceipt.providerTurnId }
                : {}),
              signalSource: 'manual',
            });
            if (patched) {
              const revision = typeof orch.reserveRevision === 'function'
                ? orch.reserveRevision('manual_result_published', {
                    attemptId: pendingReceipt && pendingReceipt.attemptId,
                    runId: pendingReceipt && pendingReceipt.runId,
                    turnNum: recoverTurnNum,
                    sid,
                    status: 'manual_extracted',
                  })
                : null;
              sendToRenderer('groupchat-turn-patched', {
                meetingId,
                turnNum: recoverTurnNum,
                ...(pendingReceipt && pendingReceipt.runId ? { runId: pendingReceipt.runId } : {}),
                ...(pendingReceipt && pendingReceipt.attemptId ? { attemptId: pendingReceipt.attemptId } : {}),
                sid,
                charCount: (extracted.text || '').length,
                ...(revision ? { revision } : {}),
              });
              return { ok: true, text: extracted.text, source: extracted.source, mode: 'recover_inflight_turn', extractMode: extracted.extractMode || null };
            }
          }
          // 群聊调用（带 meetingId）但目标轮不存在/patch 失败：诚实报错。
          //   旧行为返回 ok:true + mode:'text_only'，UI 显示"已同步"但气泡纹丝不动
          //   ——用户感知就是"重新提取失败/没反应"。
          return {
            ok: false,
            reason: 'turn_not_found',
            detail: `提取到 ${extracted.text.length} 字，但第 ${requestedTurn !== null ? requestedTurn : '(最新)'} 轮不在群聊记录中，无法写回。可能该轮已被回滚或状态文件损坏。`,
          };
        }
      } catch (err) {
        logger.warn('[manual-extract] patch lastTurn failed:', err.message);
        return { ok: false, reason: 'patch_failed', detail: err.message };
      }
    }

    return { ok: true, text: extracted.text, source: extracted.source, mode: 'text_only', extractMode: extracted.extractMode || null };
  });

  ipcMain.handle('groupchat-resend-prompt', async (_e, { meetingId, sid, turnNum: requestedTurnNum } = {}) => {
    if (!meetingId || !sid) return { ok: false, reason: 'invalid_args' };
    const meeting = meetingManager.getMeeting(meetingId);
    if (!meeting || !meeting.groupChat) return { ok: false, reason: 'group_chat_not_found' };
    const orch = groupchat.getOrchestrator(getHubDataDir(), meetingId);
    const parsedTurnNum = Number(requestedTurnNum);
    const turnNum = Number.isInteger(parsedTurnNum) && parsedTurnNum > 0
      ? parsedTurnNum
      : orch.state.currentTurn;
    if (!turnNum) {
      return { ok: false, reason: 'no_turn_yet' };
    }
    const userMsg = (orch.state.messages || []).find(
      m => m && m.id === `u${turnNum}` && m.role === 'user'
    );
    // Prefer the exact durable prompt prepared by the dispatcher (system
    // instructions + incremental context).  A historical
    // settled message also carries sourcePrompt.  Raw user text is only the
    // final legacy fallback; resending it alone silently changes semantics.
    const activePrompt = typeof orch.getActivePrompt === 'function'
      ? orch.getActivePrompt(turnNum, sid)
      : null;
    const assistantMsg = (orch.state.messages || []).find(
      m => m && m.role === 'assistant' && Number(m.turnNum) === Number(turnNum) && m.sid === sid
    );
    const promptText = activePrompt?.prompt || assistantMsg?.sourcePrompt || (userMsg && userMsg.content);
    if (!promptText) {
      return { ok: false, reason: 'no_user_input' };
    }
    const session = sessionManager.getSession(sid);
    const kind = session ? (session.transcriptKind || session.kind) : 'unknown';
    try {
      return await groupChatWatcher.resendCurrentPrompt({
        sid,
        kind,
        prompt: promptText,
        promptHeader: String(promptText).split(/\r?\n/).find(line => line.trim())?.slice(0, 160) || '',
        timing: { ENTER_RETRY_GAP_MS: 150, POST_ENTER_VERIFY_MS: 500 },
      });
    } catch (err) {
      logger.error('[groupchat-resend-prompt] threw:', err);
      return { ok: false, reason: 'exception', detail: err.message };
    }
  });

  ipcMain.handle('groupchat-skip-participant', async (_e, { sid } = {}) => {
    if (!sid) return { ok: false, reason: 'missing sid' };
    const watcher = getActiveWatchers().get(sid);
    if (!watcher) return { ok: false, reason: 'not_active' };
    watcher.skip();
    return { ok: true };
  });

  // Markdown-answer rooms (core/group-answer-files.js): resend this turn's
  // question to one member. It reuses the same turn and answer file, returns
  // once dispatched (the card updates when the file appears), and does not
  // wait for other members. A member that still looks busy needs force.
  ipcMain.handle('groupchat:resend-member', async (_e, { meetingId, sid, turnNum: requestedTurnNum, force = false } = {}) => {
    if (!meetingId || !sid) return { ok: false, reason: 'invalid_args' };
    const meeting = meetingManager.getMeeting(meetingId);
    if (!meeting || !meeting.groupChat) return { ok: false, reason: 'group_chat_not_found' };
    if (!require('../../core/group-answer-files').enabled(meeting)) return { ok: false, reason: 'not_answer_file_room' };
    const memberIndex = Array.isArray(meeting.subSessions) ? meeting.subSessions.indexOf(sid) : -1;
    if (memberIndex < 0) return { ok: false, reason: 'participant_not_in_meeting' };
    const session = sessionManager.getSession(sid);
    const state = session ? require('../../core/session-runtime-truth').getSessionRuntimeTruth(session).state : 'unknown';
    if (!force && ['starting', 'running', 'waiting'].includes(state)) return { ok: false, reason: 'member_busy', state };
    const orch = groupchat.getOrchestrator(getHubDataDir(), meetingId);
    const parsed = Number(requestedTurnNum);
    const turnNum = Number.isInteger(parsed) && parsed > 0 ? parsed : orch.state.currentTurn;
    const userMsg = (orch.state.messages || []).find(m => m && m.role === 'user' && Number(m.turnNum) === Number(turnNum));
    if (!userMsg || !String(userMsg.content || '').trim()) return { ok: false, reason: 'no_user_input' };
    const memberId = (meeting.slotSpecs?.[memberIndex]?.memberId) || `m${memberIndex + 1}`;
    const task = dispatchGroupChatTurn(meetingId, {
      userInput: userMsg.content, targetMemberIds: [memberId], reuseTurnNum: turnNum,
      appendUserMessage: false, dispatchMode: 'retry', turnTimeoutMs: 30 * 60 * 1000,
    });
    Promise.resolve(task).catch(err => logger.error('[groupchat:resend-member] dispatch failed:', err));
    return { ok: true, turnNum, memberId };
  });

  ipcMain.handle('groupchat-resend-participant', async (_e, { meetingId, sid, turnNum: requestedTurnNum } = {}) => {
    if (!meetingId || !sid) return { ok: false, reason: 'invalid_args' };
    if (typeof dispatchGroupChatTurn !== 'function') return { ok: false, reason: 'retry_unavailable' };
    const meeting = meetingManager.getMeeting(meetingId);
    if (!meeting || !meeting.groupChat) return { ok: false, reason: 'group_chat_not_found' };
    if (meeting.scene === 'dev') return {ok:false,reason:'dev_workflow_uses_continue',detail:'开发任务请发送“继续”按当前阶段接续，不能重发历史阶段。'};
    if (isWorkflowRunning(meetingId)) return { ok: false, reason: 'workflow_running' };
    const activeWatcher = getActiveWatchers().get(sid);
    if (activeWatcher && !activeWatcher.isSettled()) return { ok: false, reason: 'participant_still_running' };
    const orch = groupchat.getOrchestrator(getHubDataDir(), meetingId);
    if (orch.state.currentMode && orch.state.currentMode !== 'idle') {
      return { ok: false, reason: 'turn_still_running' };
    }
    const parsedTurnNum = Number(requestedTurnNum);
    const turnNum = Number.isInteger(parsedTurnNum) && parsedTurnNum > 0
      ? parsedTurnNum
      : orch.state.currentTurn;
    const userMsg = (orch.state.messages || []).find(
      m => m && m.role === 'user' && Number(m.turnNum) === Number(turnNum)
    );
    if (!userMsg || !String(userMsg.content || '').trim()) return { ok: false, reason: 'no_user_input' };
    const memberIndex = Array.isArray(meeting.subSessions) ? meeting.subSessions.indexOf(sid) : -1;
    if (memberIndex < 0) return { ok: false, reason: 'participant_not_in_meeting' };
    const memberSpec = Array.isArray(meeting.slotSpecs) ? meeting.slotSpecs[memberIndex] : null;
    const memberId = (memberSpec && memberSpec.memberId) || `m${memberIndex + 1}`;
    try {
      const result = await dispatchGroupChatTurn(meetingId, {
        userInput: userMsg.content,
        targetMemberIds: [memberId],
        reuseTurnNum: turnNum,
        appendUserMessage: false,
        dispatchMode: 'retry',
        turnTimeoutMs: 10 * 60 * 1000,
      });
      const participantResult = result && Array.isArray(result.results)
        ? result.results.find(item => item && item.sid === sid)
        : null;
      const success = !!(result && result.status === 'completed'
        && participantResult
        && ['completed', 'manual_extracted'].includes(participantResult.status)
        && String(participantResult.text || '').trim());
      return {
        ok: success,
        result,
        participant: participantResult,
        ...(success ? {} : { reason: participantResult?.reason || participantResult?.status || result?.reason || result?.status || 'retry_failed' }),
      };
    } catch (err) {
      logger.error('[groupchat-resend-participant] threw:', err);
      return { ok: false, reason: 'exception', detail: err && err.message };
    }
  });
}

module.exports = {
  registerGroupchatRecoveryIpc,
};
