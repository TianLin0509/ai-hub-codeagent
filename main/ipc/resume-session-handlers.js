'use strict';

const { isStableSessionTitle } = require('../../core/session-title-guards.js');
const { isKimiCliKind } = require('../../core/ai-kinds.js');
const { lookupKimiSession: defaultLookupKimiSession } = require('../../core/kimi-session-migrator.js');
const { sessionModelId } = require('../../core/session-capabilities.js');

function createResumeSessionHandler(deps) {
  const {
    defaultCodexSessionsRoot,
    findCodexRolloutBySid,
    findTranscriptByCCSessionId,
    fs,
    getHookPort,
    getHubDataDir,
    hookToken,
    isClaudeFamily,
    isCodexBaseKind,
    isCodexSubagentRolloutPath = () => false,
    lookupKimiSession = defaultLookupKimiSession,
    logger = console,
    meetingManager,
    os,
    path,
    readCodexRolloutMeta = () => null,
    readTranscriptTail,
    registerSessionForTap,
    resolveCodexSessionsRoot = null,
    scenes,
    sendToRenderer,
    sessionManager,
    slotIds,
    ensureLaunchAuth,
  } = deps;

  function addCodexMcpEntry(resumeOpts, entry) {
    if (!entry) return;
    resumeOpts.codexMcpEntries = [...(resumeOpts.codexMcpEntries || []), entry];
  }

  return async function resumeSession(meta) {
    if (!meta || !meta.hubId) return null;
    const reservedId=meta.hubId;
    // Login may wait on an official CLI/browser. Do this before taking the
    // writer reservation, so the dormant card remains editable during login.
    if (ensureLaunchAuth) {
      const authMeta=require('../../core/session-store').loadSessionFile(reservedId,{strict:true}) || meta;
      await ensureLaunchAuth(authMeta.kind || 'claude',{...authMeta,model:sessionModelId(authMeta)});
    }
    const reservation=sessionManager.reserveSessionOpen?.(reservedId);
    try {
    // This window may have been idle since before another Hub's last turn.
    // Resume the persisted authoritative identity, never its boot-time copy.
    const saved = require('../../core/session-store').loadSessionFile(meta.hubId,{strict:true});
    if (saved) meta = {...meta, ...saved, hubId:meta.hubId};
    // 显式的启动覆盖（助理切换模型/深度）在磁盘记录之后生效，否则会被旧记录里的型号盖回去。
    if (meta.launchOverrides) {
      const { model, ...rest } = meta.launchOverrides;
      meta = { ...meta, ...rest, ...(model ? { model, currentModel: { id: model, displayName: model } } : {}) };
      delete meta.launchOverrides;
    }

    require('../../core/session-meeting-membership.js').restoreMissingMeetingIds(
      [meta], meetingManager.getAllMeetings?.() || []);
    const isGemini = meta.kind === 'gemini' || meta.kind === 'gemini-resume';
    const isDeepSeek = meta.kind === 'deepseek' || meta.kind === 'deepseek-resume';
    const isLegacyDeepSeek = isDeepSeek && !!meta.ccSessionId && !meta.codexSid;
    const isClaudeCliResumable = isClaudeFamily(meta.kind) || isLegacyDeepSeek;
    const isCodexRuntime = isCodexBaseKind(meta.kind) && !isLegacyDeepSeek;
    const isKimi = isKimiCliKind(meta.kind);
    const isNativeResumeKind = (isGemini || isCodexRuntime || isKimi);
    let effectiveCodexSid = isCodexRuntime ? (meta.codexSid || null) : null;
    let effectiveCodexSessionsRoot = isCodexRuntime ? (meta.codexSessionsRoot || null) : null;
    if (isCodexRuntime && !effectiveCodexSessionsRoot && typeof resolveCodexSessionsRoot === 'function') {
      try {
        effectiveCodexSessionsRoot = resolveCodexSessionsRoot(meta) || null;
      } catch (error) {
        logger.warn('[resume-session] failed to resolve Codex profile sessions root:', error && error.message);
      }
    }
    if (isCodexRuntime && !effectiveCodexSessionsRoot) {
      effectiveCodexSessionsRoot = defaultCodexSessionsRoot;
    }
    const hookPort = getHookPort();
    // 剥离范围只能包住联赛自己的代码：社区版恢复逻辑后面还会读 isAgentLeague，
    // 也需要助理与编排员的恢复配置（2026-10-08 真机验收：剥掉后所有会话恢复都报 isAgentLeague is not defined）。
    const isAgentLeague = false;

    let resumeOpts = {};
    if (meta.purpose === 'hub-assistant') {
      if (!require('../../core/hub-assistant/backends').BACKENDS.includes(meta.kind) || typeof deps.prepareAssistantResume !== 'function') {
        throw new Error('助理恢复配置不可用，未启动替代会话');
      }
      resumeOpts = await deps.prepareAssistantResume(meta);
    }
    // AI 编排员：恢复时重新挂上编排工具（同一会话身份）。
    if (meta.purpose === 'hub-orchestrator' && typeof deps.prepareOrchestratorResume === 'function') {
      resumeOpts = { ...resumeOpts, ...(deps.prepareOrchestratorResume(meta) || {}) };
    }
    if (meta.meetingId) {
      const meeting = meetingManager.getMeeting(meta.meetingId);
      if (meeting && meeting.groupChat) resumeOpts.noInheritCursor = true;
      let promptFile = null;
      if (meeting && meeting.scene && !meeting.groupChat) {
        const hubDataDir = getHubDataDir();
        const covenantText = (typeof meeting.covenantText === 'string' && meeting.covenantText.length > 0)
          ? meeting.covenantText
          : scenes.readCovenantSnapshot(hubDataDir, meta.meetingId);
        let slotId = null;
        if (Array.isArray(meeting.subSessions)) {
          const idx = meeting.subSessions.indexOf(meta.hubId);
          if (idx >= 0 && idx < slotIds.length) slotId = slotIds[idx];
        }
        promptFile = scenes.writePromptFile(hubDataDir, meta.meetingId, meeting.scene, covenantText, slotId);
      }
      if (promptFile) {
        if (isClaudeCliResumable) {
          resumeOpts.appendSystemPromptFile = promptFile;
        } else if (isGemini) {
          resumeOpts.extraEnv = { GEMINI_SYSTEM_MD: promptFile };
        } else if (isCodexRuntime) {
          resumeOpts.codexInstructionFile = promptFile;
        }
      }
      const codexMcpEnabled = meta.mcpProfile !== 'none';
      if (meeting && meeting.groupChat && isCodexRuntime && codexMcpEnabled && scenes.buildAiTeamMcpEntryForCodex) {
        addCodexMcpEntry(resumeOpts, scenes.buildAiTeamMcpEntryForCodex(meta.meetingId, meta.kind || 'codex'));
      }
    }

    let resumeTranscriptPath = meta.transcriptPath || null;
    if (isCodexRuntime && resumeTranscriptPath && isCodexSubagentRolloutPath(resumeTranscriptPath)) {
      // Older Hub builds could persist the active Codex subagent rollout as if
      // it were the top-level PTY session. Recover the parent native SID when
      // the rollout records it; otherwise keep the old safe picker fallback.
      let parentCodexSid = null;
      let subagentCodexSid = null;
      try {
        const rolloutMeta = readCodexRolloutMeta(resumeTranscriptPath);
        subagentCodexSid = rolloutMeta && (rolloutMeta.id || rolloutMeta.session_id) || null;
        parentCodexSid = rolloutMeta && (
          rolloutMeta.parent_thread_id
          || rolloutMeta.source?.subagent?.thread_spawn?.parent_thread_id
          || rolloutMeta.source?.subagent?.parent_thread_id
        ) || null;
      } catch {}
      resumeTranscriptPath = null;
      if (parentCodexSid) {
        effectiveCodexSid = parentCodexSid;
        logger.warn(`[resume-session] repaired subagent binding to parent Codex session ${String(parentCodexSid).slice(0, 8)}`);
      } else if (!effectiveCodexSid || !subagentCodexSid || effectiveCodexSid === subagentCodexSid) {
        effectiveCodexSid = null;
        logger.warn(`[resume-session] rejected subagent rollout binding for Hub session ${String(meta.hubId).slice(0, 8)}`);
      }
    }
    // Resume metadata may point at a pre-archive path.  Provider-native ids are
    // the authority: when discovery succeeds, prefer it even if a persisted
    // transcriptPath is present instead of letting an old card source win.
    if (isClaudeCliResumable && meta.ccSessionId) {
      try {
        const discovered = findTranscriptByCCSessionId(meta.ccSessionId);
        if (discovered) resumeTranscriptPath = discovered;
      } catch {}
    }
    if (isCodexRuntime && effectiveCodexSid) {
      try {
        const discovered = findCodexRolloutBySid(effectiveCodexSid, effectiveCodexSessionsRoot);
        if (discovered) resumeTranscriptPath = discovered;
      } catch {}
    }
    // 一轮都没跑过的 Codex 会话（原生时代建的，或 PTY 下开了没聊），改走 PTY 恢复时
    // 没有任何可恢复的历史：要么没有 thread id，要么 App Server 只建了 thread、rollout
    // 从未落盘。此时 `codex resume` 只会停在「Resume a previous session」选择框，还会
    // 吞掉第一条消息。同一个 Hub id 直接新开；跑出第一轮后 hook 会绑定原生身份。
    // 只认正面证据：原生快照没有任何轮次，且 Hub 从未记录过开始/完成/记录路径。
    // 跑过但没绑上 id 的老会话仍走选择框，那是绑定失败时唯一不丢历史的兜底。
    // 用户主动选的「Codex Resume」（kind=codex-resume）本来就要选择框，不受影响。
    const nativeSnapshot = meta.nativeRuntime;
    const codexNeverRan = isCodexRuntime && !isDeepSeek && (meta.kind || 'codex') === 'codex'
      && require('../../core/agent-runtime-mode').usesPtyAgentRuntime('codex')
      && (!nativeSnapshot || (!nativeSnapshot.turnId && !nativeSnapshot.submission && !nativeSnapshot.startedAt
        && !(nativeSnapshot.endedTurns || []).length))
      && !meta.lastRunStartedAt && !meta.lastCompletedAt && !meta.transcriptPath
      && (!effectiveCodexSid || !resumeTranscriptPath);
    if (codexNeverRan) {
      logger.log(`[resume-session] Codex session ${String(meta.hubId).slice(0, 8)} never ran a turn; starting fresh under PTY`);
      effectiveCodexSid = null;
    }
    const codexMissingSid = (isCodexRuntime && !effectiveCodexSid);
    // A persisted Agent League shell may not have completed its first provider
    // turn yet. In that state there is no native conversation to resume. Every
    // provider must start fresh under the same Hub id; otherwise Claude can
    // continue an unrelated conversation and Codex/Kimi can open a picker that
    // consumes the automation prompt.
    const managedMeeting = meta.meetingId && meetingManager.getMeeting(meta.meetingId);
    const unstartedCodex = isCodexRuntime && require('../../core/codex-native-runtime').isUnstartedRuntime(meta.nativeRuntime)
      && !effectiveCodexSid;
    const isDevSeat = !!managedMeeting?.groupChat
      && (managedMeeting.mode === 'dev' || managedMeeting.scene === 'dev');
    const lazyCodex = !isDeepSeek && isCodexRuntime && isDevSeat;
    // Same for a native Claude dev seat: it keeps its Hub-assigned session ID and
    // only spawns the engine when the room actually dispatches to it.
    const lazyClaude = meta.runtimeBackend === 'claude-stream-json'
      && (isDevSeat || meta.nativeRuntime?.connection === 'unstarted');
    const isFileFlowMember = require('../../core/dev-file-workflow').enabled(managedMeeting)
      && managedMeeting.subSessions?.includes(meta.hubId);
    const freshUnboundAgentLeague = unstartedCodex || codexNeverRan || (isAgentLeague || isFileFlowMember) && (
      codexMissingSid
      || (isClaudeCliResumable && !meta.ccSessionId)
      || (isGemini && !meta.geminiChatId)
      || (isKimi && !meta.kimiSid)
    );

    // Kimi 会话绑死 cwd 且 CLI 会校验。归档搬目录后，renderer 持久化的 cwd /
    // kimiSessionDir 可能还是旧路径（休眠会话不在归档时的运行列表里），直接用会在
    // CLI 侧 "created under a different directory" 退出、Hub 只看到一个死终端。
    // 以 kimi 自己的 session_index.jsonl 为准对账：索引里的 workDir 存在就用它。
    if (isKimi && meta.kimiSid) {
      try {
        const indexed = lookupKimiSession(meta.kimiSid);
        if (indexed && indexed.workDir && fs.existsSync(indexed.workDir)) {
          const staleCwd = !meta.cwd
            || !fs.existsSync(meta.cwd)
            || path.resolve(meta.cwd) !== path.resolve(indexed.workDir);
          if (staleCwd) {
            logger.log(`[resume-session] kimi cwd reconciled via session_index: ${meta.cwd || '(empty)'} -> ${indexed.workDir}`);
            meta.cwd = indexed.workDir;
          }
          // cwd can already be correct while the persisted sessionDir/wire path
          // is stale or absent.  Reconcile the binding independently; otherwise
          // a resumed card view keeps reading the old file forever.
          if (indexed.sessionDir) {
            const indexedWire = path.join(indexed.sessionDir, 'agents', 'main', 'wire.jsonl');
            const staleBinding = !meta.kimiSessionDir
              || path.resolve(meta.kimiSessionDir) !== path.resolve(indexed.sessionDir)
              || !meta.transcriptPath
              || path.resolve(meta.transcriptPath) !== path.resolve(indexedWire);
            if (staleBinding) {
              logger.log(`[resume-session] kimi transcript reconciled via session_index: ${meta.transcriptPath || '(empty)'} -> ${indexedWire}`);
            }
            meta.kimiSessionDir = indexed.sessionDir;
            meta.transcriptPath = indexedWire;
            resumeTranscriptPath = indexedWire;
          }
        }
      } catch (error) {
        logger.warn('[resume-session] kimi index reconcile failed:', error && error.message);
      }
    }

    const safeResumeModel = sessionModelId(meta);
    const createdSession = sessionManager.createSession(meta.kind || 'claude', {
      ...(reservation ? {_openLeaseNonce:reservation} : {}),
      id: meta.hubId,
      title: meta.title,
      cwd: (isGemini && meta.geminiProjectRoot) ? meta.geminiProjectRoot : meta.cwd,
      ...(meta.cwdFellBackFrom ? { cwdFellBackFrom: meta.cwdFellBackFrom } : {}),
      ...(meta.workspaceLabel ? { workspaceLabel: meta.workspaceLabel } : {}),
      meetingId: meta.meetingId || null,
      completionNotificationEnabled: meta.completionNotificationEnabled === true,
      model: safeResumeModel || undefined,
      ...(meta.effort ? { effort: meta.effort } : {}),
      ...(isLegacyDeepSeek ? { deepseekLegacyClaude: true } : {}),
      resumeCCSessionId: isClaudeCliResumable ? (meta.ccSessionId || undefined) : undefined,
      ...(meta.runtimeBackend === 'claude-stream-json' ? { ...meta.nativeConfig, nativeRuntime: meta.nativeRuntime } : {}),
      resumeTranscriptPath: resumeTranscriptPath || undefined,
      // Code Agent 没有身份时从头开：--continue 会接上这个目录里最近的别的对话（它不认 --session-id，身份只能等 hook）。
      useContinue: isClaudeCliResumable && !meta.ccSessionId && !freshUnboundAgentLeague
        && !String(meta.kind || '').startsWith('codeagent'),
      // Agent 联赛的空壳 Session 从未产生过原生 turn，没有历史可选。
      // 进入通用 picker 会让自动 Prompt 落到“Resume a previous session”界面。
      // 保留 Hub ID fresh start；一旦首次 turn 生成 codexSid，后续仍精确 resume。
      useResume: isNativeResumeKind && !freshUnboundAgentLeague,
      codexResumePicker: codexMissingSid && !freshUnboundAgentLeague,
        codexSid: effectiveCodexSid,
        ...(meta.acpSid ? { acpSid: meta.acpSid } : {}),
      ...(meta.nativeRuntime ? {nativeRuntime:meta.nativeRuntime} : {}),
      ...((lazyCodex || unstartedCodex || lazyClaude) ? {lazyStart:true} : {}),
      ...(meta.codexApprovalPolicy ? {approvalPolicy:meta.codexApprovalPolicy} : {}),
      ...(meta.codexSandbox ? {sandbox:meta.codexSandbox} : {}),
      codexProfile: isCodexRuntime ? (meta.codexProfile || null) : null,
      ...(isCodexRuntime ? {codexSessionsRoot:effectiveCodexSessionsRoot} : {}),
      // MCP 档位现在 Claude 家族也有（core/claude-mcp-profile.js），不能再只给
      // codex runtime 继承 —— 否则 resume 出来的 Claude 会话会从用户选的 Lean
      // 悄悄变回 Full，一次多起七个 MCP 进程。
      ...(meta.mcpProfile ? { mcpProfile: meta.mcpProfile } : {}),
      ...(meta.fastMode === false ? { fastMode: false } : {}),
      // autonomous 会话恢复后仍然没有人在终端前：权限旁路、plugin 隔离和 strict
      // MCP 必须一起带回来，缺一项下一次自动 Prompt 就会停在弹窗上等到超时。
      ...(meta.autonomous === true ? { autonomous: true } : {}),
      ...(meta.codexSpeedTier ? { codexSpeedTier: meta.codexSpeedTier } : {}),
      geminiChatId: isGemini ? (meta.geminiChatId || null) : null,
      ...(isGemini && meta.geminiProjectHash ? { geminiProjectHash: meta.geminiProjectHash } : {}),
      geminiProjectRoot: isGemini ? (meta.geminiProjectRoot || null) : null,
      ...(isKimi ? {
        kimiSid: meta.kimiSid || null,
        kimiSessionDir: meta.kimiSessionDir || null,
        kimiResumePicker: !meta.kimiSid && !freshUnboundAgentLeague,
      } : {}),
      userRenamed: !!meta.userRenamed,
      autoTitleGenerated: !meta.branchAutoTitlePending
        && (!!meta.autoTitleGenerated || isStableSessionTitle(meta.title, meta.kind)),
      ...(meta.branchSourceSessionId ? { branchSourceSessionId: meta.branchSourceSessionId } : {}),
      ...(Number.isInteger(Number(meta.branchIndex)) && Number(meta.branchIndex) > 0
        ? { branchIndex: Number(meta.branchIndex) }
        : {}),
      ...(typeof meta.branchAutoTitlePending === 'boolean'
        ? { branchAutoTitlePending: meta.branchAutoTitlePending }
        : {}),
      ...(meta.pinned ? { pinned: true } : {}),
      ...(meta.bottomed ? { bottomed: true } : {}),
      lastMessageTime: meta.lastMessageTime,
      lastOutputPreview: meta.lastOutputPreview,
      ...(typeof meta.contextPct === 'number' ? { contextPct: meta.contextPct } : {}),
      ...(typeof meta.contextUsed === 'number' ? { contextUsed: meta.contextUsed } : {}),
      ...(meta.sessionUsage ? { sessionUsage: meta.sessionUsage } : {}),
      ...(typeof meta.contextMax === 'number' ? { contextMax: meta.contextMax } : {}),
      ...(typeof meta.contextEffectiveMax === 'number'
        ? { contextEffectiveMax: meta.contextEffectiveMax }
        : {}),
      ...(typeof meta.contextEffectiveObservedAt === 'number'
        ? { contextEffectiveObservedAt: meta.contextEffectiveObservedAt }
        : {}),
      ...(meta.purpose ? { purpose: meta.purpose } : {}),
      ...(meta.researchSessionId ? { researchSessionId: meta.researchSessionId } : {}),
      ...(meta.hiddenFromSidebar ? { hiddenFromSidebar: true } : {}),
      ...resumeOpts,
    });
    registerSessionForTap(createdSession);
    // CodexTap can synchronously discover and publish a persisted rollout
    // while registerSessionForTap is still on the stack. Always send/return the
    // authoritative SessionManager copy so that freshly repaired SID/path/root
    // metadata is not overwritten by the stale createSession return value.
    const session = sessionManager.getSession(createdSession.id) || createdSession;
    sendToRenderer('session-created', { session });

    const needsLevel3 = !freshUnboundAgentLeague && (
      (isCodexRuntime && !effectiveCodexSid) ||
      (isGemini && !meta.geminiChatId)
    );

    if (needsLevel3) {
      let sourcePath = null;
      if (isGemini && meta.geminiProjectHash && meta.geminiChatId) {
        try {
          const dir = path.join(os.homedir(), '.gemini', 'tmp', meta.geminiProjectHash, 'chats');
          const f = fs.readdirSync(dir).find(n => n.includes(meta.geminiChatId));
          if (f) sourcePath = path.join(dir, f);
        } catch {}
      }

      if (sourcePath) {
        readTranscriptTail(meta.kind, sourcePath, 10).then(tail => {
          if (!tail) return;
          const msg = `[CONTEXT FROM PREVIOUS SESSION]\n${tail}\n\n[END CONTEXT]\n`;
          setTimeout(() => {
            try {
              const sess = sessionManager.getSession(session.id);
              if (!sess || sess.status === 'dormant') {
                logger.warn(`[群聊] Level 3 inject skipped: session ${session.id.slice(0, 8)} no longer active`);
                return;
              }
              sessionManager.writeToSession(session.id, msg);
              logger.log(`[群聊] Level 3 fallback: injected ${tail.length}-char transcript tail to ${meta.kind} session ${session.id.slice(0, 8)}`);
            } catch (err) {
              logger.warn(`[群聊] Level 3 inject failed:`, err.message);
            }
          }, 5000);
        }).catch(err => logger.warn('[群聊] Level 3 fallback error:', err.message));
      }
    }

    return session;
    } finally { sessionManager.cancelReservedOpen?.(reservedId,reservation); }
  };
}

function registerResumeSessionIpc(ipcMain, deps) {
  const resumeSession = typeof deps.resumeSession === 'function'
    ? deps.resumeSession
    : createResumeSessionHandler(deps);
  ipcMain.handle('resume-session', (_event, meta) => resumeSession(meta));
  return { resumeSession };
}

module.exports = {
  createResumeSessionHandler,
  registerResumeSessionIpc,
};
