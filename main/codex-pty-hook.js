'use strict';

// PTY Codex 的 hook：身份绑定 + 生命周期。卡片正文与完成事件仍以 rollout 为准
// （CodexTap），hook 负责三件 rollout 做不好的事：
//   1. 第一时间告诉我们确切的 rollout 路径，杜绝按 cwd + 时间去猜；
//   2. UserPromptSubmit 作为 PTY 提交闭环的语义确认；
//   3. PreToolUse / PermissionRequest 让「运行中 / 等你确认」立刻可见。
// 子代理事件带 agent_id，嵌套在终端里跑的另一个 codex 进程带着不同的 session_id，
// 两者都不能改动这条会话的绑定。

function isPtyCodexSession(session) {
  return !!session && session.agentRuntime === 'pty' && !session.runtimeBackend
    && require('../core/ai-kinds').isCodexCliKind(session.transcriptKind || session.kind);
}

function createCodexPtyHookHandler({
  sessionManager,
  transcriptTap,
  sendToRenderer,
  maybeAutoTitleSessionFromPrompt = () => {},
  readCodexRolloutMeta,
  isCodexTopLevelRolloutMeta,
  logger = console,
  now = () => Date.now(),
}) {
  return async function handleCodexPtyHook(session, event, parsed = {}) {
    const eventAt = now();
    const hubSessionId = session.id;
    if (parsed.agentId) return { ignored: 'subagent' };
    const incomingSid = String(parsed.claudeSessionId || '');
    const boundSid = String(session.codexSid || '');
    const rolloutPath = typeof parsed.transcriptPath === 'string' && parsed.transcriptPath ? parsed.transcriptPath : null;
    if (rolloutPath) {
      let meta = null;
      try { meta = readCodexRolloutMeta(rolloutPath); } catch {}
      if (meta && !isCodexTopLevelRolloutMeta(meta)) return { ignored: 'subagent' };
    }
    // 同一个终端里换线程只有三种正当来源：/new（clear）、/resume、fork；
    // startup 只在 CLI 已退回宿主 shell 后重新拉起，或 TUI 自己刚结束了已绑定线程
    // （Codex 0.153 的 /new 报的是 startup）时才算，否则就是 CLI 里嵌套跑的另一个 codex。
    const source = String(parsed.source || '');
    const newThread = event === 'session-start' && !!boundSid && !!incomingSid && boundSid !== incomingSid
      && (['clear', 'resume', 'fork'].includes(source)
        || (source === 'startup' && (!!sessionManager.isHostShellActive?.(hubSessionId)
          || !!sessionManager.isCodexThreadEnded?.(hubSessionId, boundSid))));
    if (boundSid && incomingSid && boundSid !== incomingSid && !newThread) {
      logger.warn?.(`[codex hook] ignored foreign ${event} for ${String(hubSessionId).slice(0, 8)} (${source || 'no-source'})`);
      return { ignored: 'foreign-session' };
    }
    if (incomingSid && rolloutPath) {
      if (incomingSid !== boundSid || session.transcriptPath !== rolloutPath) {
        const updated = sessionManager.updateSessionMeta(hubSessionId, { codexSid: incomingSid, transcriptPath: rolloutPath });
        if (incomingSid !== boundSid) sessionManager.noteCodexThreadBound?.(hubSessionId);
        if (updated) {
          sendToRenderer('session-updated', { session: updated });
          sendToRenderer('session-meta-updated', { hubSessionId, codexSid: incomingSid, transcriptPath: rolloutPath });
        }
        try { sessionManager._refreshOpenIdentity?.(hubSessionId); } catch (error) {
          logger.warn?.('[codex hook] ownership refresh failed:', error && error.message);
        }
      }
      await transcriptTap.bindCodexFromHook(hubSessionId, { codexSid: incomingSid, transcriptPath: rolloutPath,
        sessionsRoot: session.codexSessionsRoot || null, rebind: newThread });
    }
    const prompt = typeof parsed.prompt === 'string' && parsed.prompt.trim() ? parsed.prompt : null;
    if (event === 'prompt') {
      if (prompt) transcriptTap.notePrompt(hubSessionId, session.kind, prompt);
      sessionManager.noteAgentTurnStarted(hubSessionId, { startedAt: eventAt, signalSource: 'codex-user-prompt-submit',
        prompt, turnId: parsed.turnId || null });
      if (prompt) maybeAutoTitleSessionFromPrompt({ hubSessionId, text: prompt, submittedAt: eventAt, signalSource: 'hook_prompt' });
    }
    // stop 不转给 renderer：完成事件由 rollout 的 task_complete 带着正文和 turnId 发出，
    // 两路都发会让未读翻倍。rollout 还没绑上时才用 hook 兜底。
    if (event === 'stop') {
      if (!transcriptTap.getCodexRolloutPath(hubSessionId)) {
        transcriptTap.emit('turn-complete', { hubSessionId, kind: session.kind, text: parsed.lastAssistantMessage || '',
          completedAt: eventAt, turnId: parsed.turnId || null, transcriptPath: rolloutPath, signalSource: 'codex-stop-hook' });
      }
      return { ok: true };
    }
    if (!['prompt', 'tool-start', 'tool-complete', 'permission-request'].includes(event)) return { ok: true };
    sessionManager.noteCodexHookActivity?.(hubSessionId, event, parsed, eventAt);
    sendToRenderer('hook-event', {
      event, eventAt, sessionId: hubSessionId, provider: 'codex',
      // 不带 claudeSessionId：renderer 会把它当 Claude 会话 id 落盘。
      claudeSessionId: null, cwd: parsed.cwd || null, latestUserMessage: prompt,
      backgroundTasks: [], sessionCrons: [], error: null, errorDetails: null, lastAssistantMessage: null,
      notificationType: null, message: null, title: null,
      toolName: parsed.toolName || null, toolCallId: parsed.toolCallId || null, turnId: parsed.turnId || null,
      toolInput: parsed.toolInput ?? null, toolResult: parsed.toolResult ?? null,
      agentId: null, agentType: null, taskId: null, taskSubject: null,
    });
    return { ok: true };
  };
}

module.exports = { isPtyCodexSession, createCodexPtyHookHandler };
