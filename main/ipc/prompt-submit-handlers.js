'use strict';
// main/ipc/prompt-submit-handlers.js
// 普通会话「下方输入框 → PTY」的闭环发送（2026-09-03）。
//
// 在此之前这条路是**开环**的：renderer 写完 bracketed paste 之后，在 700/900/1100ms
//   三个固定时刻盲发 \r，发完就不管了。长 prompt 时 node-pty 的 inSocket 队列还没排空，
//   三个 \r 全被并进 BP_END 那一块当粘贴尾巴吃掉 —— 内容躺在 CLI 输入框里折叠成
//   [Pasted text +N lines]，没人再按一次回车，也没有任何 UI 提示，用户干等。
//
// 项目里其他调用方早就不走裸 'terminal-input' 了（study-handlers.js 那条注释写得很清楚），
//   agent-league / relay-tool / xresearch / 群聊派发全部走 group-chat-watcher.sendToPty。
//   这里把最后一条裸路径也接进去，普通会话与群聊从此共用同一套：
//     分块投喂 → 体积自适应 settle（等折叠标记出现就提前收工）→ 单发 \r
//     → 等 Claude UserPromptSubmit / Codex task_started 语义确认 → 缺确认才补一次回车
//     → 仍无确认就如实返回 stuck，由前端亮「补发」按钮。
//
// 非 paste-sensitive 的会话（powershell 等宿主 shell）保持原来的 text + '\r' 直写：
//   它们没有 paste-detect，走 sendToPty 只会白白吃掉几秒等待。

const { isPasteSensitive, isClaudeFamily, isCodexCliKind } = require('../../core/ai-kinds.js');
const groupChatWatcher = require('../../core/group-chat-watcher.js');
const { PromptSubmissionReceipts } = require('../../core/prompt-submission-receipts.js');

// 每个会话串行化。用户连按两下回车时两次 sendToPty 会并发写同一个 PTY，
//   分块投喂下两条 payload 会交错成一团乱码 —— 这是分块引入的新风险，入口挡掉。
const _queues = new Map();

function enqueue(sessionId, task) {
  const prev = _queues.get(sessionId) || Promise.resolve();
  // task 内部自己 catch，所以链上不会有 rejection；仍加 catch 兜底防队列断裂。
  const next = prev.then(task);
  const tail = next.catch(() => {});
  _queues.set(sessionId, tail);
  // 队尾还是自己时才摘链，否则会把排在后面的人一起丢掉。
  tail.then(() => {
    if (_queues.get(sessionId) === tail) _queues.delete(sessionId);
  });
  return next;
}

function firstLine(text) {
  const line = String(text || '').split(/\r?\n/).find(x => String(x || '').trim());
  return line ? line.slice(0, 160) : '';
}

function supportsMessageReceipt(kind, text) {
  // Native slash commands need not create a user-message record (e.g. /goal
  // writes a goal update). Keep their existing CLI submission contract.
  return (isClaudeFamily(kind) || isCodexCliKind(kind) || require('../../core/acp-profiles').isAcpKind(kind)) && !String(text).trimStart().startsWith('/');
}

const LATE_LOCAL_ACK_MAX_MS = 10 * 60 * 1000;

function registerPromptSubmitIpc(ipcMain, deps) {
  const {
    sessionManager,
    transcriptTap,
    sendToRenderer = () => {},
    logger = console,
  } = deps;

  let nativeDraftStore;
  for (const operation of ['read', 'save']) {
    ipcMain.handle('native-draft:' + operation, (_event, request = {}) => {
      const session = sessionManager.getSession(request.sessionId);
      // 草稿按 Hub 会话 id 持久化：原生会话与 PTY 的 Claude/Codex 会话共用同一份，
      // 原生时代存下的草稿在改走 PTY 后照样读得回来。
      if (!['claude-stream-json', 'codex-app-server', 'acp'].includes(session?.runtimeBackend)
          && !require('../../core/agent-runtime-mode').isPtyAgentSession(session)) {
        return { ok: false, error: '当前会话不支持草稿持久化' };
      }
      try {
        nativeDraftStore ||= new (require('../../core/native-draft-store').NativeDraftStore)();
        const record = operation === 'read' ? nativeDraftStore.read(request.sessionId)
          : nativeDraftStore.save(request.sessionId, request.text, request.revision);
        return { ok: true, record };
      } catch (error) {
        return { ok: false, error: error.message, code: error.code || null };
      }
    });
  }

  ipcMain.handle('claude-native:set-model', async (_event, request = {}) => {
    const native = sessionManager.getNativeClaude?.(request.sessionId);
    if (!native || !require('../../core/model-options').isClaudeModelSelection(request.modelId)) {
      return { ok: false, error: '无法为当前 Claude 会话选择该模型' };
    }
    try {
      await native.setModel(request.modelId);
      const currentModel = { id: request.modelId, displayName: request.modelId };
      const updated = sessionManager.updateSessionMeta(request.sessionId, { currentModel });
      if (!updated) throw new Error('模型已切换，但 Hub 元数据保存失败');
      sendToRenderer('session-updated', { session: updated });
      return { ok: true, model: currentModel };
    } catch (error) { return { ok: false, error: error.message }; }
  });

  // The thinking chip: the engine confirms the level, then Hub metadata follows.
  ipcMain.handle('claude-native:set-effort', async (_event, request = {}) => {
    const native = sessionManager.getNativeClaude?.(request.sessionId);
    if (!native) return { ok: false, error: 'Claude 原生连接不存在' };
    try {
      const result = await native.setEffort(request.effort);
      const updated = sessionManager.updateSessionMeta(request.sessionId, { effort: result.effort });
      if (!updated) throw new Error('思考档已切换，但 Hub 元数据保存失败');
      sendToRenderer('session-updated', { session: updated });
      return { ok: true, result };
    } catch (error) { return { ok: false, error: error.message }; }
  });

  // Plan-mode banner: the same "切回默认模式" Codex offers, over Claude's own
  // permission-mode control frame.
  ipcMain.handle('claude-native:set-permission-mode', async (_event, request = {}) => {
    const native = sessionManager.getNativeClaude?.(request.sessionId);
    if (!native) return { ok: false, error: 'Claude 原生连接不存在' };
    try { return { ok: true, result: await native.setPermissionMode(request.mode) }; }
    catch (error) { return { ok: false, error: error.message }; }
  });

  for (const action of ['respond', 'interrupt']) {
    ipcMain.handle('claude-native:' + action, async (_event, request = {}) => {
      const native = sessionManager.getNativeClaude?.(request.sessionId);
      if (!native) return { ok: false, error: 'Claude 原生连接不存在' };
      try {
        const result = action === 'respond' ? await native.respond(request.requestId, request.decision,
          { epoch: request.epoch, submissionId: request.submissionId })
          : await native.interrupt();
        return { ok: true, result };
      } catch (error) { return { ok: false, error: error.message }; }
    });
  }

  for (const action of ['reconnect', 'inspect-recovery', 'reconcile', 'reconcile-history']) {
    ipcMain.handle('claude-native:' + action, async (_event, request = {}) => {
      const native = sessionManager.getNativeClaude?.(request.sessionId);
      if (!native) return { ok: false, error: 'Claude 原生连接不存在' };
      try {
        if (action === 'reconnect') await native.reconnect();
        if (action === 'reconcile') await native.reconcile(request.identity || {});
        // 输入框上那个「核对上次任务」按钮：和连上后的自动核对同一条路，
        // 只读原生历史、只登记不重发。群聊席位的人工关卡就靠这一条解开。
        if (action === 'reconcile-history') await native.reconcileFromHistory({ source: 'user' });
        return { ok: true, runtime: native.runtime, records: native.recoveryRecords() };
      } catch (error) { return { ok: false, error: error.message }; }
    });
  }

  // 「补发」按钮要重放原文，所以记住每个会话最后一次提交的 prompt。
  //   每会话只留最后一条，且只在内存里 —— 不做持久化，prompt 可能含敏感内容。
  const lastPromptBySid = new Map();
  const latestRequestBySid = new Map();
  const receipts = new PromptSubmissionReceipts(payload => {
    try { sendToRenderer('session:prompt-receipt', payload); }
    catch (error) { logger.warn('[prompt-submit] receipt broadcast failed:', error && error.message); }
    try { deps.onPromptReceipt?.(payload); }
    catch (error) { logger.warn('[prompt-submit] receipt observer failed:', error && error.message); }
  });
  const normalizeAssistantReceipt = event => {
    const session=sessionManager.getSession(event.sessionId||event.hubSessionId);
    if(session?.kind!=='claude'||session.purpose!=='hub-assistant')return event;
    return {...event,text:require('../../core/assistant-context-display').assistantSubmissionText(event.text,session.purpose)};
  };
  const observePrompt = event => {
    // Literal user-authored tags must still match as submitted. Only after raw
    // matching fails, and only for a bound Claude session, try its native paste
    // envelope against the exact pending body. Whitespace loss stays a mismatch.
    if (receipts.observe(normalizeAssistantReceipt(event))) return true;
    const session = sessionManager.getSession(event.sessionId || event.hubSessionId);
    if (!/^claude(?:-resume)?$/.test(session?.transcriptKind || session?.kind || '')) return false;
    const { unwrapClaudePasteEnvelope } = require('../../core/prompt-submission-receipts');
    const text = unwrapClaudePasteEnvelope(event.text);
    return text !== event.text && receipts.observe({ ...event, text });
  };
  const onTranscriptPrompt = event => observePrompt(event);
  const onProviderPrompt = event => {
    // Native UserPromptSubmit carries the actual body. Codex can write its
    // matching rollout UserMessage much later than the bounded submit wait.
    if (!['claude-user-prompt-submit', 'codex-user-prompt-submit'].includes(event?.signalSource)) return;
    observePrompt({ ...event, text: event.prompt });
  };
  transcriptTap?.on('prompt-submitted', onTranscriptPrompt);
  sessionManager.on?.('agent-turn-started', onProviderPrompt);

  // sessionManager 没有 close/exit 事件（只 emit output / session-updated /
  //   agent-turn-started / managed-launch），所以不挂监听，改成每次发送时顺手扫一遍：
  //   getSession 返回 null 的就是已经没了的会话。会话数是几十量级，代价可忽略。
  function pruneClosedSessions() {
    for (const sid of lastPromptBySid.keys()) {
      if (!sessionManager.getSession(sid)) {
        lastPromptBySid.delete(sid);
        latestRequestBySid.delete(sid);
      }
    }
    receipts.prune(sid => !!sessionManager.getSession(sid));
  }

  function resolveKind(sessionId) {
    const session = sessionManager.getSession(sessionId);
    if (!session) return null;
    return session.transcriptKind || session.kind || null;
  }

  // 梦境索引只随用户亲手输入的消息附带（renderer 显式传 memoryIndex:true）；
  //   群聊派发、会议、扩展投研、定时任务等自动 prompt 一律原样发送。
  function sendWithMemory(request, sessionId, text, kind, options) {
    const memory = sessionManager.memoryService;
    const send = body => groupChatWatcher.sendToPty(sessionId, body, kind, options);
    if (request.memoryIndex !== true || !memory) return send(text);
    return memory.withIndex(sessionId, text, kind, options, send);
  }

  const sendPrompt = async (_event, request = {}) => {
    const sessionId = typeof request.sessionId === 'string' ? request.sessionId : '';
    let text = typeof request.text === 'string' ? request.text : '';
    if (!sessionId || !text) return { ok: false, error: 'bad-request' };
    const kind = resolveKind(sessionId);
    if (!kind) return { ok: false, error: 'no-session' };
    // Host-provided context preparation happens before receipt fingerprints and
    // before the first PTY write, for both the UI and assistant tool callers.
    // Local commands retain their native meaning and do not receive context.
    if (typeof deps.preparePrompt === 'function' && !text.trimStart().startsWith('/')) {
      try {
        const prepared = await deps.preparePrompt(request, sessionManager.getSession(sessionId));
        if (prepared) request = { ...request, ...prepared, sessionId };
        text = request.text;
        if (typeof text !== 'string' || !text.trim()) throw new Error('准备后的消息为空');
      } catch (error) {
        return { ok: false, notSent: true, error: 'prompt-context-failed', message: error.message };
      }
    }

    if (sessionManager.getNativeClaude?.(sessionId)) {
      return enqueue(sessionId, async () => {
        const native = sessionManager.getNativeClaude(sessionId);
        try {
          await native.prepareForNewPrompt?.();
          if (sessionManager.getNativeClaude(sessionId) !== native) throw new Error('会话已变化，未发送');
        }
        catch (error) { return {ok:false,notSent:true,error:'native-recovery-failed',message:error.message}; }
        try {
          return await sendWithMemory(request, sessionId, text, kind, {
            clientSubmissionId: request.clientSubmissionId, attachments: request.attachments,
          });
        } catch (error) {
          // A write that reached the engine but lost its confirmation is not a
          // failed send: it may be running, and Main publishes the late receipt.
          const record = request.clientSubmissionId ? native.records?.get(request.clientSubmissionId) : null;
          const unconfirmed = record?.writeStarted === true && !['rejected', 'content-mismatch'].includes(record.status);
          return { ok: false, error: error.code || 'native-send-failed', message: error.message,
            ...(unconfirmed ? { unconfirmed: true } : {}) };
        }
      });
    }

    // 宿主 shell：没有 paste-detect，直写最快也最准。
    if (!isPasteSensitive(kind) && !sessionManager.getNativeSession?.(sessionId)) {
      sessionManager.writeToSession(sessionId, `${text}\r`);
      return { ok: true, sendStatus: 'ok', mode: 'plain-shell', kind };
    }

    pruneClosedSessions();
    const clientSubmissionId = typeof request.clientSubmissionId === 'string'
      ? request.clientSubmissionId.slice(0, 160) : '';
    latestRequestBySid.set(sessionId, clientSubmissionId);
    lastPromptBySid.set(sessionId, text);
    return enqueue(sessionId, async () => {
      const native = sessionManager.getNativeCodex?.(sessionId);
      try {
        await native?.prepareForNewPrompt?.();
        if (native && sessionManager.getNativeCodex(sessionId) !== native) throw new Error('会话已变化，未发送');
      }
      catch (error) { return { ok:false, notSent:true, error:error.code || 'native-recovery-failed', message:error.message }; }
      const receipt = clientSubmissionId && supportsMessageReceipt(kind, text)
        ? receipts.begin(sessionId, clientSubmissionId, text, Date.now(), {nativeOnly:!!(sessionManager.getNativeSession?.(sessionId) || sessionManager.getNativeCodex?.(sessionId))}) : null;
      // PTY Claude 的 /clear、/compact：以各自的确认事件收尾，而不是等一个永远不会来的开工信号。
      const identitySwitch = require('../../core/claude-identity-switch');
      const localCommand = /^claude/.test(String(kind)) ? identitySwitch.claudeLocalCommand(text) : null;
      const clearObserver = localCommand
        && require('../../core/agent-runtime-mode').isPtyAgentSession(sessionManager.getSession(sessionId))
        ? identitySwitch.observeClaudeLocalCommand(sessionManager, sessionId, localCommand,
          require('../../core/claude-local-command-acks').parseLocalCommand(text).args) : null;
      let awaitLateLocalAck = false;
      try {
        // requireReady:false —— 输入框就摆在用户面前，CLI 已经在跑；
        //   再走一次 60s 冷启动 ready 轮询会把「打完字立刻发」变成有时干等几十秒。
        const result = await sendWithMemory(request, sessionId, text, kind, {
          requireReady: request.waitForCliReady === true || sessionManager.getSession(sessionId)?.purpose === 'hub-assistant', submissionReceipt: receipt,
          clientSubmissionId, attachments:request.attachments,
          ...(clearObserver ? { localCommandObserver: clearObserver } : {}),
        });
        if (receipt) receipts.finish(receipt, result || { ok: false });
        if (!result || result === false) {
          return { ok: false, error: 'send-failed', kind };
        }
        const sendStatus = (result && result.sendStatus) || 'ok';
        // /clear、/compact 的确认在期限内没来：回车已经写进去了，结果是「未知」而不是「失败」。
        // 观察者不销毁，转入迟到确认：/compact 期间提交的 /clear 要等压缩结束才执行。
        const localAckPending = !!clearObserver && result.acknowledgementSource === 'local-command' && result.ok === false;
        awaitLateLocalAck = localAckPending && !!clientSubmissionId;
        if (sendStatus === 'stuck') {
          logger.warn(`[prompt-submit] ${kind}(${sessionId.slice(0, 8)}) prompt not acknowledged; renderer will offer manual resend`);
        }
        return {
          ...(localAckPending ? { unconfirmed: true } : {}),
          ok: result.ok !== false && sendStatus !== 'content-mismatch',
          kind,
          sendStatus,
          mode: result.mode || 'closed-loop',
          enterAttempts: result.enterAttempts ?? null,
          acknowledgementSource: result.acknowledgementSource || null,
          ...(typeof result.commandOutput === 'string' ? { commandOutput: result.commandOutput } : {}),
          ...(result.message ? {message:result.message} : {}),
          ...(result.error ? {error:result.error} : {}),
          // 明确没执行（例如 Codex 收尾中拒绝斜杠命令）：渲染层据此退回原文、不亮「补发」。
          ...(result.notSent ? {notSent:true} : {}),
          // 千问 / GLM 超时报 {ok:false,unconfirmed:true}：结果未知，不能被渲染层当成失败。
          ...(result.unconfirmed ? {unconfirmed:true} : {}),
          ...(result.threadId ? {threadId:result.threadId,turnId:result.turnId} : {}),
          ...(receipt ? { receipt: receipts.snapshot(receipt) } : {}),
        };
      } catch (error) {
        if (receipt) receipts.finish(receipt, { ok: false });
        logger.warn('[prompt-submit] send threw:', error && error.message);
        return { ok: false, error: 'send-threw', message: error && error.message, kind, ...(error?.notSent ? {notSent:true} : {}) };
      } finally {
        if (awaitLateLocalAck) armLateLocalCommandAck(clearObserver, sessionId, clientSubmissionId, localCommand);
        else clearObserver?.dispose();
      }
    });
  };

  // 迟到确认只收敛这一条提交：renderer 按 clientSubmissionId 匹配回执，之后另一条真正
  // 失败的提交不受影响。从不自动重发。最长等 10 分钟。
  function armLateLocalCommandAck(observer, sessionId, clientSubmissionId, command) {
    const expire = setTimeout(() => observer.dispose(), LATE_LOCAL_ACK_MAX_MS);
    expire.unref?.();
    observer.onConfirm(() => setTimeout(() => {
      clearTimeout(expire);
      observer.dispose();
      logger.log?.(`[prompt-submit] late /${command} confirmation for ${sessionId.slice(0, 8)}; clearing its resend prompt`);
      try { sendToRenderer('session:prompt-receipt', { sessionId, clientSubmissionId, status: 'confirmed', source: 'late-local-command-ack' }); }
      catch (error) { logger.warn('[prompt-submit] late receipt broadcast failed:', error && error.message); }
      try {
        const store = deps.commandTranscriptStore || require('../../core/command-transcript-store').commandTranscriptStore();
        store.finish(sessionId, clientSubmissionId, { ok: true, sendStatus: 'ok', mode: 'closed-loop', acknowledgementSource: 'late-local-command' });
        sendToRenderer('session:command-updated', { sessionId });
      } catch (error) { logger.warn('[prompt-submit] late command history update failed:', error && error.message); }
    }, 0));
  }

  const assistantSubmissions = new Set();
  const submitPrompt = async (event, request = {}) => {
    const session = sessionManager.getSession(request.sessionId);
    const native = session && (['codex-app-server', 'claude-stream-json', 'acp'].includes(session.runtimeBackend)
      || sessionManager.getNativeSession?.(request.sessionId) || sessionManager.getNativeCodex?.(request.sessionId)
      || sessionManager.getNativeClaude?.(request.sessionId));
    const aiSession = native || (session && isPasteSensitive(session.transcriptKind || session.kind));
    if (!aiSession || typeof request.text !== 'string' || !request.text.trimStart().startsWith('/')) {
      if (session?.purpose !== 'hub-assistant') return sendPrompt(event, request);
      // Reserve before any async context work. A second submit must not replace
      // the first request's tool authority while its PTY receipt is pending.
      if (assistantSubmissions.has(request.sessionId)) return { ok: false, notSent: true,
        error: 'assistant-submission-pending', message: '助理正在提交上一条消息，草稿已保留' };
      assistantSubmissions.add(request.sessionId);
      try { return await sendPrompt(event, request); }
      finally { assistantSubmissions.delete(request.sessionId); }
    }
    const id = typeof request.clientSubmissionId === 'string' && request.clientSubmissionId
      ? request.clientSubmissionId.slice(0,160) : require('crypto').randomUUID();
    let store;
    try {
      store = deps.commandTranscriptStore || require('../../core/command-transcript-store').commandTranscriptStore();
      const record = store.begin(request.sessionId, id, request.text);
      if (record.duplicate) return record.result || { ok: false, sendStatus: 'stuck', message: '命令提交结果待确认，未重复执行' };
    } catch (error) { return { ok: false, error: 'command-history-failed', message: '命令未发送：' + error.message }; }
    const notify = () => {
      try { sendToRenderer('session:command-updated', { sessionId: request.sessionId }); }
      catch (error) { logger.warn('[command-history] broadcast failed:', error.message); }
    };
    notify();
    let result;
    try { result = await sendPrompt(event, { ...request, clientSubmissionId: id }); }
    catch (error) { result = { ok: false, error: 'command-failed', message: error.message }; }
    try { store.finish(request.sessionId, id, result); }
    catch (error) { result = { ...result, ok: false, message: '命令已提交，但结果保存失败；请核对后再操作：' + error.message }; }
    notify();
    return result;
  };
  ipcMain.handle('session:send-prompt', submitPrompt);

  // 「⚠ 未提交 · 补发」按钮。复用群聊那条手动补发路径：它会先用 prompt 首行指纹
  //   判断原文是否还留在输入框里 —— 在 → 只补回车；不在 → 整条重写再提交。
  //   直接盲发回车会在「原文其实没进去」时提交一个空输入框。
  ipcMain.handle('session:resend-prompt', async (_event, request = {}) => {
    const sessionId = typeof request.sessionId === 'string' ? request.sessionId : '';
    if (!sessionId) return { ok: false, error: 'bad-request' };
    if (sessionManager.getNativeClaude?.(sessionId)) {
      return { ok: false, error: 'native-reconciliation-required', message: '请先核对原生会话记录；不会通过补回车重发' };
    }
    const kind = resolveKind(sessionId);
    if (!kind) return { ok: false, error: 'no-session' };
    const prompt = lastPromptBySid.get(sessionId);
    if (!prompt) return { ok: false, error: 'no-prompt' };
    return enqueue(sessionId, async () => {
      try {
        if (request.clientSubmissionId && supportsMessageReceipt(kind, prompt)) {
          const receipt = receipts.get(sessionId);
          if (!receipt || receipt.clientSubmissionId !== request.clientSubmissionId
              || latestRequestBySid.get(sessionId) !== request.clientSubmissionId) {
            return { ok: false, error: 'superseded-submission' };
          }
          if (receipt.status === 'content-mismatch') return { ok: false, mode: 'none',
            reason: 'content-mismatch', receipt: receipts.snapshot(receipt) };
          if (receipt.started) return { ok: true, mode: 'already-submitted', receipt: receipts.snapshot(receipt) };
          const result = await groupChatWatcher.resendCurrentPrompt({
            sid: sessionId, prompt, kind, promptHeader: firstLine(prompt), submissionReceipt: receipt,
          });
          receipts.finish(receipt, result || { ok: false });
          return { ok: receipt.started, mode: result?.mode || 'closed-loop',
            reason: receipt.started ? null : (result?.reason || 'unconfirmed'),
            receipt: receipts.snapshot(receipt), kind };
        }
        const result = await groupChatWatcher.resendCurrentPrompt({
          sid: sessionId,
          kind,
          prompt,
          promptHeader: firstLine(prompt),
        });
        return { ...result, kind };
      } catch (error) {
        logger.warn('[prompt-submit] resend threw:', error && error.message);
        return { ok: false, error: 'resend-threw', message: error && error.message, kind };
      }
    });
  });

  return {
    submitPrompt,
    isAssistantSubmissionPending:sessionId=>assistantSubmissions.has(sessionId),
    dispose() {
      nativeDraftStore?.close();
      transcriptTap?.removeListener('prompt-submitted', onTranscriptPrompt);
      sessionManager.removeListener?.('agent-turn-started', onProviderPrompt);
      receipts.prune(() => false);
      lastPromptBySid.clear();
      latestRequestBySid.clear();
      assistantSubmissions.clear();
    },
    _test: { lastPromptBySid, firstLine, enqueue, pruneClosedSessions },
  };
}

module.exports = { registerPromptSubmitIpc };
