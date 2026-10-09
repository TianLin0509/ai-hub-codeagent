'use strict';

const { planSessionFork } = require('../../core/session-fork-plan.js');
const {
  buildSessionResumeMeta,
  nativeSessionIdentity,
  runtimeKindForSession,
  sessionModelId,
  supportsRecoverableSession,
} = require('../../core/session-capabilities.js');
const {
  isClaudeModelSelection,
  isCodexConversationModelId,
} = require('../../core/model-options.js');
const {
  captureClaudeModelPreference,
  restoreClaudeModelPreference,
} = require('../../core/claude-model-preference-guard.js');

const NATIVE_SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CODEX_MODEL_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max', 'ultra']);

function isSafeNativeSessionId(value) {
  return typeof value === 'string' && NATIVE_SESSION_ID_RE.test(value);
}

// 旧 PTY 的退出回调把会话从 SessionManager 里删掉，才算收尾完成（归属已释放）。
function waitForSessionGone(sessionManager, sessionId, { timeoutMs = 15000, intervalMs = 50 } = {}) {
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs;
    const check = () => {
      if (!sessionManager.getSession(sessionId)) return resolve(true);
      if (Date.now() >= deadline) return resolve(false);
      setTimeout(check, intervalMs);
    };
    check();
  });
}

function registerSessionIpc(ipcMain, deps) {
  const {
    registerSessionForTap = () => {},
    sendToRenderer,
    sessionManager,
    meetingManager,
    workspaceService,
    resumeSession,
    getTerminalOutputBatchStats = () => null,
    getPersistedSessions = () => [],
    ensureLaunchAuth,
  } = deps;
  require('./codex-backstage-handlers').registerCodexBackstageIpc(ipcMain, { sessionManager });
  require('../../core/codex-fast-command').registerCodexSpeedIpc(ipcMain,{sessionManager,sendToRenderer});
  ipcMain.on('hub:ui-theme', (_event, theme) => sessionManager.setPresentationTheme?.(theme));

  const lastResizeBySid = new Map();
  ipcMain.handle('hub:feedback-ping', () => ({ok:true}));
  ipcMain.handle('session:open-status', (_event, sessionId) => {
    const owner = sessionManager._openOwners?.()?.owner(sessionId, true);
    if (!owner || (owner.pid === process.pid && sessionManager.getSession(sessionId))) return {available:true};
    return {available:false, message:require('../../core/session-open-ownership').occupied(owner).message};
  });
  const claudeModelPreferenceGuards = new Map();
  let claudeFastQueue = Promise.resolve();

  ipcMain.handle('session:set-fast', (_event, payload = {}) => {
    const task = async () => {
      const {sessionId,enabled} = payload;
      const session = sessionManager.getSession(sessionId);
      if (typeof enabled !== 'boolean' || !session) return {ok:false,message:'会话或速度设置无效'};
      const {claudeSupportsFast,pendingSpeedSwitches} = require('../../core/session-speed');
      // A connected native engine already said whether it serves Fast. Trusting
      // only the model table would refuse to turn Fast back off on a model the
      // table does not know yet.
      const engineServesFast = session.nativeRuntime?.fastMode === true;
      if (String(session.kind).replace(/-resume$/, '') !== 'claude'
          || !(claudeSupportsFast(session.currentModel?.id) || engineServesFast)) {
        return {ok:false,message:'当前 Claude 型号未确认支持 Fast，请先选择明确的受支持型号'};
      }
      if (require('../../core/session-runtime-truth').sessionRuntimeIsActive(session) || session.status === 'running' || session.autonomous || process.env.CLAUDE_HUB_NO_FAST === '1') {
        return {ok:false,message:'请在会话空闲且允许 Fast 时切换'};
      }
      // Native sessions carry a protocol control for this. They have no
      // terminal to type `/fast` into, and apply_flag_settings never touches
      // the user's settings files, so the restore dance below is not needed.
      const nativeClaude = sessionManager.getNativeClaude?.(sessionId);
      if (nativeClaude) {
        pendingSpeedSwitches.add(sessionId);
        try {
          const result = await nativeClaude.setFastMode(enabled);
          const updated = sessionManager.updateSessionMeta(sessionId,{fastMode:enabled});
          if (!updated) return {ok:false,message:'Claude 已切换，但会话信息保存失败'};
          sendToRenderer('session-updated',{session:updated});
          return {ok:true,result:{fastMode:enabled},...(result?.warning ? {warning:result.warning} : {})};
        } catch (error) {
          return {ok:false,message:error.message};
        } finally { pendingSpeedSwitches.delete(sessionId); }
      }
      const {claudeSettingsPath,readJsonObject,writeJsonAtomic} = require('../../core/claude-model-preference-guard');
      const file = claudeSettingsPath();
      const previous = readJsonObject(file);
      const observer = require('../../core/claude-fast-command').observeClaudeFastCommand(sessionManager,sessionId,enabled);
      pendingSpeedSwitches.add(sessionId);
      try {
        const result = await require('../../core/group-chat-watcher').sendToPty(sessionId,`/fast ${enabled ? 'on' : 'off'}`,session.kind,
          {requireReady:false,localCommandObserver:observer});
        if (!result?.ok) return {ok:false,message:result?.message || 'Claude 未确认速度切换'};
        const updated = sessionManager.updateSessionMeta(sessionId,{fastMode:enabled});
        if (!updated) return {ok:false,message:'Claude 已切换，但会话信息保存失败'};
        sendToRenderer('session-updated',{session:updated});
        return {ok:true,result:{fastMode:enabled}};
      } finally {
        pendingSpeedSwitches.delete(sessionId);
        observer.dispose();
        // /fast persists a user default. Restore only our field, preserving
        // unrelated concurrent edits, just like the existing model guard.
        const current = readJsonObject(file);
        if (current.fastMode === enabled && previous.fastMode !== enabled) {
          if (Object.hasOwn(previous,'fastMode')) current.fastMode = previous.fastMode;
          else delete current.fastMode;
          writeJsonAtomic(file,current);
        }
      }
    };
    const pending = claudeFastQueue.then(task).catch(error=>({ok:false,message:error.message}));
    claudeFastQueue = pending;
    return pending;
  });

  const web = require('../../core/chatgpt-web-integration');
  ipcMain.handle('chatgpt-web:status', () => web.webStatus());
  ipcMain.handle('chatgpt-web:settings', () => web.openWebSettings());
  const createSession = (arg) => {
    // Back-compat: legacy callers pass just a kind string; newer callers pass { kind, opts }.
    let kind;
    let opts;
    if (typeof arg === 'string') {
      kind = arg;
      opts = {};
    } else if (arg && typeof arg === 'object') {
      kind = arg.kind;
      opts = { ...(arg.opts || {}) };
    } else {
      kind = 'powershell';
      opts = {};
    }
    if (kind === 'chatgpt') {
      if (!require('../../core/chatgpt-web-models').isChatgptWebModel(opts.model)) throw new Error('请选择可用的 ChatGPT 模型');
      kind = 'codex';
    }
    if (require('../../core/chatgpt-web-models').isChatgptWebModel(opts.model)) {
      web.requireWebTools(opts.model);
      return require('../../core/chatgpt-web-startup').ensureWebReady(opts.model).then(() => {
        return createResolvedSession(kind, opts);
      });
    }
    if (ensureLaunchAuth) return ensureLaunchAuth(kind,opts).then(()=>createResolvedSession(kind,opts));
    return createResolvedSession(kind, opts);
  };
  ipcMain.handle('create-session', (_e, arg) => createSession(arg));

  function createResolvedSession(kind, opts) {
    const isResumePicker = typeof kind === 'string' && kind.endsWith('-resume');
    // Native resume pickers must start in their historical/default scope when
    // the caller has no known cwd. Creating a fresh scratch here makes the CLI
    // picker unable to see the sessions it is supposed to resume.
    if (workspaceService && !opts.meetingId && (!isResumePicker || opts.cwd)) {
      const workspaceMeta = { label: opts.workspaceLabel, select: false };
      if (typeof opts.workspaceDraft === 'boolean') workspaceMeta.draft = opts.workspaceDraft;
      const workspace = workspaceService.resolveForSession(opts.cwd, workspaceMeta);
      opts.cwd = workspace.path;
    }
    const session = sessionManager.createSession(kind, opts);
    registerSessionForTap(session);
    sendToRenderer('session-created', { session });
    return session;
  }

  // 分支编号要看「现存 + 已持久化」两边，否则重启后分支序号会从头再来一遍。
  function forkSiblingPool() {
    const persistedSessions = getPersistedSessions();
    return [
      ...(typeof sessionManager.getAllSessions === 'function' ? sessionManager.getAllSessions() : []),
      ...(Array.isArray(persistedSessions) ? persistedSessions : []),
    ];
  }

  ipcMain.handle('fork-session', (_e, request) => {
    const sourceSessionId = request && typeof request === 'object'
      ? request.sourceSessionId
      : request;
    const rendererTitle = request && typeof request === 'object'
      ? request.sourceTitle
      : null;
    const source = typeof sourceSessionId === 'string'
      ? sessionManager.getSession(sourceSessionId)
      : null;
    const plan = planSessionFork({
      source,
      siblingPool: forkSiblingPool(),
      meeting: source && source.meetingId && meetingManager && typeof meetingManager.getMeeting === 'function'
        ? meetingManager.getMeeting(source.meetingId)
        : null,
      rendererTitle,
      runtimeKind: source ? runtimeKindForSession(source) : '',
    });
    if (!plan.ok) return plan;

    const { kind, opts } = plan;
    const createFork = (preparedOpts = opts) => {
      const session = sessionManager.createSession(kind, preparedOpts);
      registerSessionForTap(session);
      sendToRenderer('session-created', { session });
      return { ok: true, session };
    };
    if (plan.needsAcpFork) {
      return sessionManager.getNativeSession(source.id).fork()
        .then(fork => { opts.acpFork = fork; return createFork(); })
        .catch(error => ({ ok: false, error: 'acp-fork-failed', message: error.message }));
    }
    if (kind === 'codex' && opts.codexForkSid && sessionManager.prepareCodexFork) {
      return sessionManager.prepareCodexFork(opts).then(createFork)
        .catch(error => ({ ok: false, error: 'codex-fork-failed', message: error.message }));
    }
    return createFork();
  });

  ipcMain.handle('close-session', async (_e, sessionId) => {
    if (typeof sessionId !== 'string' || !sessionId) {
      return { ok: false, error: 'invalid-session-id', message: '缺少会话 ID' };
    }
    const result = await sessionManager.closeSessionRecoverably(sessionId, { reason: 'user-close' });
    if (result && result.ok) lastResizeBySid.delete(sessionId);
    return result;
  });

  // “关闭”在用户语义上等同于可恢复休眠。真正移除卡片/历史入口必须走
  // 明确命名的永久删除，内部 restart/workspace 迁移仍可直接调用 closeSession。
  ipcMain.handle('delete-session', (_e, sessionId) => {
    if (typeof sessionId !== 'string' || !sessionId) {
      return { ok: false, error: 'invalid-session-id', message: '缺少会话 ID' };
    }
    try {
      const edit = () => {
        lastResizeBySid.delete(sessionId);
        sessionManager.closeSession(sessionId);
        return { ok: true, sessionId, action: 'deleted' };
      };
      const owners = sessionManager._openOwners?.();
      return owners ? owners.editSessions([sessionId], edit, { allowOwn: true }) : edit();
    } catch (error) {
      return { ok: false, error: error.code || 'session-edit-failed', message: error.message };
    }
  });

  ipcMain.handle('suspend-session', (_e, arg) => {
    const sessionId = arg && typeof arg === 'object' ? arg.sessionId : arg;
    if (typeof sessionId !== 'string' || !sessionId) {
      return { ok: false, error: 'invalid-session-id', message: '缺少会话 ID' };
    }
    const result = sessionManager.suspendSession(sessionId, { reason: 'user-suspend' });
    if (result && result.ok) lastResizeBySid.delete(sessionId);
    return result;
  });

  ipcMain.handle('suspend-idle-sessions', (_e, arg = {}) => {
    const idleMs = arg && typeof arg === 'object' ? arg.idleMs : undefined;
    const result = sessionManager.suspendIdleSessions({ idleMs });
    for (const sessionId of (result && result.requested) || []) lastResizeBySid.delete(sessionId);
    return result;
  });

  ipcMain.on('terminal-input', (_e, { sessionId, data }) => {
    const native = sessionManager.getNativeClaude?.(sessionId);
    if (native) {
      native.emit('action-error', '原生 Claude 会话请通过 Hub 输入框发送消息或停止按钮操作');
      return;
    }
    sessionManager.writeToSession(sessionId, data);
  });

  ipcMain.handle('codex:native-action', async (_event, payload = {}) => {
    const native = sessionManager.getNativeSession?.(payload.sessionId) || sessionManager.getNativeCodex?.(payload.sessionId);
    if (!native) return {ok:false,message:'该 Codex 会话尚未接管'};
    try {
      let result;
      if (payload.action === 'reply') result = await native.reply(payload.requestId,payload.result,payload.epoch);
      else if (payload.action === 'choose-thread') result = await native.chooseThread(payload.threadId);
      else if (payload.action === 'reconnect') result = await native.reconnect();
      else if (payload.action === 'restart-empty') result = await native.restartEmpty(payload);
      else if (payload.action === 'interrupt') result = await native.interrupt();
      else if (payload.action === 'configure') result = await native.configure(payload);
      else if (payload.action === 'collaboration-mode') result = await native.configureMode(payload.mode, payload.epoch);
      else if (payload.action === 'snapshot') result = native.runtime;
      else if (payload.action === 'review-submission') result = await Promise.resolve(native.reviewUnknownSubmission(payload.submissionId,payload.epoch));
      else return {ok:false,message:'不支持的 Codex 操作'};
      return {ok:true,result};
    } catch (error) {
      return {ok:false,message:error.message};
    }
  });

  ipcMain.on('terminal-resize', (_e, { sessionId, cols, rows, force }) => {
    if (typeof sessionId !== 'string' || typeof cols !== 'number' || typeof rows !== 'number') return;
    if (cols <= 0 || rows <= 0) return;
    const last = lastResizeBySid.get(sessionId);
    // Normal ResizeObserver chatter remains deduplicated. Snapshot hydration is
    // the one intentional exception: a same-size ConPTY resize asks a live TUI
    // to repaint a complete authoritative frame after historical ANSI replay.
    if (!force && last && last.cols === cols && last.rows === rows) return;
    lastResizeBySid.set(sessionId, { cols, rows });
    sessionManager.resizeSession(sessionId, cols, rows);
  });

  ipcMain.on('focus-session', (_e, { sessionId }) => {
    sessionManager.setFocusedSession(sessionId);
    sessionManager.markRead(sessionId);
  });

  // 侧栏「全部已读」。刻意不复用 focus-session：那条会顺带改 focusedSessionId，
  // 而批量标已读不该把焦点挪到列表里最后一个会话上（焦点还决定谁不被批量休眠）。
  ipcMain.on('mark-sessions-read', (_e, payload = {}) => {
    const ids = Array.isArray(payload && payload.sessionIds) ? payload.sessionIds : [];
    for (const sessionId of ids) {
      if (typeof sessionId === 'string' && sessionId) sessionManager.markRead(sessionId);
    }
  });

  ipcMain.handle('prepare-session-model-switch', async (_event, payload = {}) => {
    const sessionId = typeof payload.sessionId === 'string' ? payload.sessionId : '';
    const targetModel = typeof payload.modelId === 'string' ? payload.modelId.trim() : '';
    const session = sessionId ? sessionManager.getSession(sessionId) : null;
    const kind = String(session && session.kind || '').replace(/-resume$/, '').toLowerCase();
    if (!session || kind !== 'claude' || !isClaudeModelSelection(targetModel)) {
      return { ok: false, error: 'invalid-claude-switch', message: '无法为当前会话准备 Claude 模型切换' };
    }
    try {
      if (claudeModelPreferenceGuards.has(sessionId)) {
        await restoreClaudePreferenceGuard(sessionId, { waitForWrite: false });
      }
      const snapshot = captureClaudeModelPreference(targetModel);
      const timer = setTimeout(() => {
        void restoreClaudePreferenceGuard(sessionId).then(restored => {
          if (restored && restored.status === 'restore-failed') {
            console.warn('[model-switch] timed Claude default restoration failed:', restored.error);
          }
        });
      }, 20_000);
      timer.unref?.();
      claudeModelPreferenceGuards.set(sessionId, { snapshot, timer });
      return { ok: true };
    } catch (error) {
      return { ok: false, error: 'preference-snapshot-failed', message: `无法保护 Claude 默认模型：${error.message}` };
    }
  });

  async function restoreClaudePreferenceGuard(sessionId, options = {}) {
    const entry = claudeModelPreferenceGuards.get(sessionId);
    if (!entry) return { restored: false, status: 'missing-snapshot' };
    if (entry.timer) clearTimeout(entry.timer);
    const waitForWrite = options.waitForWrite !== false;
    const deadline = Date.now() + (waitForWrite ? 2500 : 0);
    while (true) {
      let result;
      try { result = restoreClaudeModelPreference(entry.snapshot); }
      catch (error) {
        claudeModelPreferenceGuards.delete(sessionId);
        return { restored: false, status: 'restore-failed', error: error.message };
      }
      if (result.restored || result.status !== 'changed-externally') {
        claudeModelPreferenceGuards.delete(sessionId);
        return result;
      }
      const original = entry.snapshot.hadModel ? entry.snapshot.previousModel : undefined;
      if (result.currentModel !== original) {
        claudeModelPreferenceGuards.delete(sessionId);
        return result;
      }
      if (!waitForWrite || Date.now() >= deadline) {
        claudeModelPreferenceGuards.delete(sessionId);
        return { restored: true, status: 'unchanged' };
      }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }

  ipcMain.handle('cancel-session-model-switch', async (_event, payload = {}) => {
    const sessionId = typeof payload.sessionId === 'string' ? payload.sessionId : '';
    return { ok: true, preference: await restoreClaudePreferenceGuard(sessionId, { waitForWrite: false }) };
  });

  // Renderer calls this only after the provider-owned TUI confirms the switch.
  // Keeping metadata confirmation separate from terminal-input prevents a
  // failed picker interaction from making Hub claim a model that never became active.
  ipcMain.handle('confirm-session-model-switch', async (_event, payload = {}) => {
    const sessionId = typeof payload.sessionId === 'string' ? payload.sessionId : '';
    let modelId = typeof payload.modelId === 'string' ? payload.modelId.trim() : '';
    const session = sessionId ? sessionManager.getSession(sessionId) : null;
    if (!session) return { ok: false, error: 'session-not-found', message: '会话不存在或已经休眠' };
    if (['codex-app-server','acp'].includes(session.runtimeBackend)) {
      const current = session.currentModel || {};
      if (current.id !== modelId || (payload.effort && payload.effort !== session.effort)) {
        return {ok:false,message:'原生会话尚未确认该模型或思考档'};
      }
      return {ok:true,model:current,effort:session.effort};
    }
    const kind = String(session.kind || '').replace(/-resume$/, '').toLowerCase();
    const valid = kind === 'codex'
      ? isCodexConversationModelId(modelId)
      : kind === 'claude'
        ? isClaudeModelSelection(modelId)
        : kind==='deepseek'&&!session.deepseekLegacyClaude
          ? require('../../core/deepseek-codex-profile').DEEPSEEK_CODEX_MODELS.includes(modelId)
        : false;
    if (!valid) return { ok: false, error: 'invalid-model', message: '该模型不属于当前 CLI 的会话模型目录' };
    if (kind === 'codex') modelId = require('../../core/model-options').normalizeCodexSessionModel(modelId);

    const displayName = String(payload.displayName || modelId)
      .replace(/[\0\r\n]+/g, ' ')
      .trim()
      .slice(0, 120) || modelId;
    const fields = { currentModel: { id: modelId, displayName } };
    const effort = String(payload.effort || '').toLowerCase();
    if (['codex','deepseek'].includes(kind) && CODEX_MODEL_EFFORTS.has(effort)) fields.effort = effort;
    const updated = sessionManager.updateSessionMeta(sessionId, fields);
    if (!updated) {
      if (kind === 'claude') await restoreClaudePreferenceGuard(sessionId);
      return { ok: false, error: 'update-failed', message: '模型已切换，但 Hub 元数据更新失败' };
    }
    sendToRenderer('session-updated', { session: updated });
    const preference = kind === 'claude' ? await restoreClaudePreferenceGuard(sessionId) : null;
    return {
      ok: true,
      model: fields.currentModel,
      effort: fields.effort || updated.effort || null,
      ...(preference ? { preference } : {}),
    };
  });

  // Sidebar placement lives in renderer state for dormant cards, but a live
  // SessionManager must learn it immediately too. Restart and the bulk-idle
  // guard read this authority before the debounced state.json write completes.
  ipcMain.on('update-session-placement', (_e, payload = {}) => {
    const sessionId = typeof payload.sessionId === 'string' ? payload.sessionId : '';
    if (!sessionId || typeof sessionManager.updateSessionMeta !== 'function') return;
    const pinned = payload.pinned === true;
    sessionManager.updateSessionMeta(sessionId, {
      pinned,
      bottomed: payload.bottomed === true && !pinned,
    });
  });

  ipcMain.handle('rename-session', (_e, { sessionId, title, userRenamed }) => {
    const codexNative = sessionManager.getNativeCodex?.(sessionId) || sessionManager.getNativeClaude?.(sessionId);
    if (codexNative?.control?.shared && codexNative.control.role !== 'controller') return null;
    const session = sessionManager.renameSession(sessionId, title, { userRenamed: !!userRenamed });
    const claudeNative = sessionManager.getNativeClaude?.(sessionId);
    const finish = () => {
      if (session) sendToRenderer('session-updated', { session });
      return session;
    };
    if (claudeNative && userRenamed && session) {
      return (async () => {
        try { session.nativeRename = await claudeNative.rename(title); }
        catch (error) {
          claudeNative.emit('action-error', 'Hub 名称已保存；Claude 历史同步失败：' + error.message);
          session.nativeRename = { status: 'failed', message: error.message };
        }
        return finish();
      })();
    }
    return finish();
  });

  // Only explicit history navigation calls this. Previewing search results
  // must not manufacture activity or a completed model response.
  ipcMain.handle('session:record-history-open', (_e, { sessionId } = {}) => {
    const session = sessionManager.getSession(sessionId);
    if (!session) return { ok: false, message: '会话不存在或未成功恢复' };
    const at = Math.max(Date.now(), Number(session.lastMessageTime) || 0);
    const updated = sessionManager.updateSessionMeta(sessionId, { lastMessageTime: at, hiddenFromSidebar: false });
    if (!updated) return { ok: false, message: '侧栏活动时间更新失败' };
    return { ok: true, at };
  });

  ipcMain.handle('get-sessions', () => {
    return sessionManager.getAllSessions();
  });

  // 公司电脑上装了 CodeAgent 时，新建会话 / 群聊默认用它（只查文件是否存在，不代表已登录）。
  ipcMain.handle('codeagent:available', () => {
    try { return { installed: require('../../core/codeagent-config').isCodeAgentInstalled() }; }
    catch (error) { return { installed: false, error: error.message }; }
  });

  ipcMain.handle('debug:get-session-buffer', (_e, sessionId) => {
    return sessionManager.getSessionBuffer(sessionId);
  });

  ipcMain.handle('get-session-buffer-snapshot', (_e, sessionId) => {
    if (typeof sessionManager.getSessionBufferSnapshot === 'function') {
      return sessionManager.getSessionBufferSnapshot(sessionId);
    }
    return { text: sessionManager.getSessionBuffer(sessionId) || '', seq: 0 };
  });

  ipcMain.handle('debug:get-last-session-write', () => {
    return typeof sessionManager.getLastWrite === 'function' ? sessionManager.getLastWrite() : null;
  });

  ipcMain.handle('debug:get-terminal-output-batch-stats', () => getTerminalOutputBatchStats());

  ipcMain.handle('restart-session', (_e, sessionId) => restartSession(sessionId));

  // overrides 只用于 PTY 原生会话的「按新模型/深度重启并接着原会话历史」（助理切换模型）。
  function restartSession(sessionId, overrides = null) {
    if (ensureLaunchAuth) {
      const old=sessionManager.getSession(sessionId);
      if (old) return ensureLaunchAuth(old.kind,{...old,...overrides,model:sessionModelId(old)})
        .then(()=>restartAuthorizedSession(sessionId,overrides))
        .catch(error=>({ok:false,error:error.code || 'restart-failed',message:error.message}));
    }
    return restartAuthorizedSession(sessionId,overrides);
  }
  function restartAuthorizedSession(sessionId, overrides = null) {
    const old = sessionManager.getSession(sessionId);
    if (!old) {
      return { ok: false, error: 'session-not-found', message: '会话不存在或已经休眠' };
    }
    const nativeCodex = sessionManager.getNativeSession?.(sessionId) || sessionManager.getNativeCodex?.(sessionId);
    // PTY 跑的 Codex 与 Claude 一样按原生会话 id 恢复；只有 App Server 会话在这里重连。
    if (overrides && (old.runtimeBackend === 'codex-app-server' || old.runtimeBackend === 'claude-stream-json' || (nativeCodex && !nativeCodex.isCliProvider) || sessionManager.getNativeClaude?.(sessionId))) {
      return { ok: false, error: 'restart-overrides-unsupported', message: '原生后端会话不支持按新模型重启' };
    }
    if (old.purpose !== 'xresearch-research' && (old.runtimeBackend === 'codex-app-server' || (nativeCodex && !nativeCodex.isCliProvider))) {
      const native = nativeCodex;
      if (!native) return {ok:false,error:'unmanaged-codex',message:'旧 Codex 进程尚未接管；请先在原会话结束工作并关闭，再恢复'};
      return native.reconnect({useLaunchAccount:true}).then(()=>sessionManager.getSession(sessionId))
        .catch(error=>({ok:false,message:error.message}));
    }
    if (old.purpose === 'xresearch-research') {
      return { ok: false, error: 'protected-session', message: '扩展投研任务不能从这里重启' };
    }
    const native = sessionManager.getNativeClaude?.(sessionId);
    if (native) {
      return native.reconnect({ stopActive: true }).then(() => sessionManager.getSession(sessionId))
        .catch(error => ({ ok: false, error: 'native-reconnect-failed', message: error.message }));
    }

    if (supportsRecoverableSession(old)) {
      const identity = nativeSessionIdentity(old);
      if (!identity) {
        return {
          ok: false,
          error: 'native-session-id-missing',
          message: '当前会话尚未绑定原生会话 ID，不能安全重启；请等待本轮回答完成后重试',
        };
      }
      if (typeof resumeSession !== 'function') {
        return { ok: false, error: 'resume-handler-unavailable', message: '会话恢复服务尚未就绪' };
      }

      const resumeMeta = buildSessionResumeMeta(old, overrides ? { launchOverrides: overrides } : {});
      lastResizeBySid.delete(sessionId);
      // 2026-09-26：kill 只是发信号，旧 PTY 的收尾（保存记录、停 writer、释放归属）在
      // 退出回调里。以前 close 后立刻 resume，撞上「该会话已在本 Hub 打开」而失败；
      // 随后旧进程退出又按「用户关闭」发出 session-closed，会话连卡片带记录一起被抹掉。
      // 改走休眠：群聊成员身份与卡片都保留，等收尾完成再按原会话恢复。
      const suspended = sessionManager.suspendSession(sessionId, { reason: 'restart' });
      if (!suspended || !suspended.ok) {
        return { ok: false, error: suspended?.error || 'restart-suspend-failed',
          message: `会话重启失败：${suspended?.message || '无法停止旧进程'}` };
      }
      return waitForSessionGone(sessionManager, sessionId).then((gone) => {
        if (!gone) return { ok: false, error: 'restart-exit-timeout', message: '会话重启失败：旧进程迟迟未退出，稍后可从休眠恢复' };
        return Promise.resolve(resumeSession(resumeMeta)).then((fresh) => (
          fresh || { ok: false, error: 'resume-failed', message: '原生会话恢复失败' }
        ));
      }).catch((error) => ({
        ok: false,
        error: 'resume-failed',
        message: `会话重启失败：${error && error.message ? error.message : String(error)}`,
      }));
    }

    if (overrides) return { ok: false, error: 'restart-overrides-unsupported', message: '该会话没有可恢复的原生历史，不能按新模型重启' };
    // PowerShell has no provider-native thread.  Restarting it intentionally
    // creates a fresh shell while retaining the Hub card's UX metadata.
    sessionManager.closeSession(sessionId);
    const fresh = sessionManager.createSession(old.kind, {
      id: old.id,
      ...(old.title ? { title: old.title } : {}),
      cwd: old.cwd,
      meetingId: old.meetingId || undefined,
      ...(old.workspaceLabel ? { workspaceLabel: old.workspaceLabel } : {}),
      ...(old.pinned ? { pinned: true } : {}),
      ...(old.bottomed ? { bottomed: true } : {}),
      ...(typeof old.lastMessageTime === 'number' ? { lastMessageTime: old.lastMessageTime } : {}),
      ...(typeof old.lastOutputPreview === 'string' ? { lastOutputPreview: old.lastOutputPreview } : {}),
      ...(sessionModelId(old) ? { model: sessionModelId(old) } : {}),
      ...(old.effort ? { effort: old.effort } : {}),
      ...(old.codexProfile ? { codexProfile: old.codexProfile } : {}),
      ...(old.mcpProfile ? { mcpProfile: old.mcpProfile } : {}),
      ...(old.fastMode === false ? { fastMode: false } : {}),
      ...(old.codexSpeedTier ? { codexSpeedTier: old.codexSpeedTier } : {}),
      ...(typeof old.contextMax === 'number' ? { contextMax: old.contextMax } : {}),
      completionNotificationEnabled: old.completionNotificationEnabled === true,
    });
    registerSessionForTap(fresh);
    sendToRenderer('session-created', { session: fresh });
    return fresh;
  }

  return { lastResizeBySid, createSession, restartSession };
}

module.exports = {
  isSafeNativeSessionId,
  waitForSessionGone,
  registerSessionIpc,
};
