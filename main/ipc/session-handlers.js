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
    prepareLaunchAuth,
    // 登录窗口打开后多久看一次凭证（单测可缩短）；获取模型权限的实现（单测可替换）。
    codeagentLoginPollMs = 3000,
    codeagentProbeModels = null,
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
  ipcMain.handle('session:prepare-launch-auth', async (_event, request = {}) => {
    await prepareLaunchAuth?.(request.kind, { launchProfile: request.launchProfile });
    return { ok: true };
  });
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
    // 分支沿用源会话的场景（core/session-scenes.js）：同一份系统提示，接着同一段对话
    if (source && require('../../core/session-scenes').isScenePurpose(source.purpose)) plan.opts.purpose = source.purpose;

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
    if (['codex-app-server','acp'].includes(session.runtimeBackend)
      || session.agentRuntime === 'pty' && /^deepseek-acp(?:-resume)?$/.test(session.kind)) {
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
        : kind === 'deepseek-claude'
          ? require('../../core/deepseek-claude-profile').isKnownModel(modelId)
        // agy slugs; the CLI itself already accepted it with "Model set to".
        : kind === 'gemini'
          ? /^(?:gemini|claude|gpt-oss)[\w.-]+$/.test(modelId)
        : false;
    if (!valid) return { ok: false, error: 'invalid-model', message: '该模型不属于当前 CLI 的会话模型目录' };
    if (kind === 'codex') modelId = require('../../core/model-options').normalizeCodexSessionModel(modelId);
    // DeepSeek on Claude Code：终端里切的是接入方式对应的真实模型名，Hub 记显示用的 id。
    if (kind === 'deepseek-claude') {
      const profile = require('../../core/deepseek-claude-profile');
      modelId = profile.normalizeModel(modelId);
      payload = { ...payload, displayName: profile.displayName(modelId, session.deepseekActiveRoute || session.deepseekRoute) };
    }

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
  // CodeAgent 模型菜单：已知模型 + 本机回答里实际出现过的模型（core/codeagent-models.js）。
  ipcMain.handle('codeagent:models', (_event, payload) => {
    try {
      const { getHubDataDir } = require('../../core/data-dir');
      const pool = require('../../core/codeagent-pool');
      const asOptions = ids => ids.map(id => ({ id, label: require('../../core/codeagent-models').modelLabel(id), source: 'account' }));
      // defaultModel：不选具体模型时这个号启动会用的模型（启动中心把「沿用」那一项标成它，2026-10-19 用户：选了号就默认选中该号的默认模型）。
      // 号池号 = 启动前同步配置会定下的模型（plannedModel，和 syncSharedConfig 同一口径：为通道切过模型、号上没有会话时按切之前的）；个人账号 = 纠正后的默认模型（不确定时为空，界面仍写「沿用 CodeAgent 当前模型」）。
      const sameCase = (list, id) => (list || []).find(m => String(m).toLowerCase() === String(id || '').toLowerCase()) || '';
      if (payload && payload.account === 'pool' && payload.poolAccount) {
        const account = codeagentPoolAccounts().find(a => a.id === payload.poolAccount);
        if (!account) return { options: [] };
        return { options: asOptions(account.models), defaultModel: sameCase(account.models, pool.plannedModel(account.dir, { idle: !account.activeSessions })) };
      }
      if (payload && payload.account === 'pool') {
        // 自动挑号：各个可用号的默认模型都一样时才能说定
        const usable = codeagentPoolAccounts().filter(a => a.state === 'ready' && !a.sameAsPersonal && !a.duplicateOf);
        const defaults = [...new Set(usable.map(a => sameCase(a.models, pool.plannedModel(a.dir, { idle: !a.activeSessions }))))];
        return { options: pool.poolModelOptions(getHubDataDir(), usable), defaultModel: defaults.length === 1 ? defaults[0] : '' };
      }
      const personalDir = require('../../core/codeagent-config').resolveCodeAgentConfig(process.env).configDir;
      let defaultModel = '';
      // single：权限清单权威且只有一个模型时，不选具体模型启动就走它（core/codeagent-pool.js personalDefaultModel 的例外）。
      // 2026-10-22 起手动新建的会话也按这个模型启动（session-manager 的启动核对），所以这里和启动口径一致地把「默认」那一项写成它，
      // 用户开之前就能看到会用什么模型；清单有多个或未知时仍为空，界面照旧写「沿用 CodeAgent 当前模型」。
      try { defaultModel = require('../../core/codeagent-model-route').personalModels({ dataDir: getHubDataDir(), personalDir, single: true }).defaultModel || ''; } catch { defaultModel = ''; }
      // 个人账号：一键获取过模型权限就用读到的菜单，否则沿用原来的清单
      const probed = require('../../core/codeagent-model-probe').readProbed(pool.personalModelsFile(getHubDataDir()));
      if (probed) return { options: asOptions(probed.models), defaultModel: sameCase(probed.models, defaultModel) };
      const options = require('../../core/codeagent-config').localModelOptions(getHubDataDir());
      return { options, defaultModel: sameCase(options.map(o => o.id), defaultModel) };
    } catch (error) { return { options: [], error: error.message }; }
  });
  // CodeAgent 号池（core/codeagent-pool.js）：列表、添加（开登录窗口）、重新登录、备注、移出。
  function codeagentPoolAccounts() {
    const { getHubDataDir } = require('../../core/data-dir');
    const pool = require('../../core/codeagent-pool');
    const personalDir = require('../../core/codeagent-config').resolveCodeAgentConfig(process.env).configDir;
    return pool.listAccounts(getHubDataDir(), { activeCounts: sessionManager.codeagentPoolActiveCounts(),
      personalAccountId: pool.readCredentials(personalDir).accountId });
  }
  function codeagentPoolStatus() {
    const { getHubDataDir } = require('../../core/data-dir');
    const pool = require('../../core/codeagent-pool');
    const personalDir = require('../../core/codeagent-config').resolveCodeAgentConfig(process.env).configDir;
    const personal = pool.readCredentials(personalDir);
    const personalModels = pool.accountModels(personalDir, undefined, pool.personalModelsFile(getHubDataDir()));
    const accounts = codeagentPoolAccounts().map(({ dir, ...rest }) => rest);
    // 本机各账号进行中的 CodeAgent 会话数（休眠的不算）：个人账号 = 没有号池标记的 CodeAgent 会话
    const personalActive = sessionManager.getAllSessions().filter(s => /^codeagent(?:-resume)?$/.test(String(s.kind || ''))
      && !s.codeagentPoolAccount && s.status !== 'dormant' && s.status !== 'closed').length;
    // 额度感知（2026-10-18，core/codeagent-quota.js）：每个号的避让状态（原因、预计恢复）与最近的 Credit 读数，页签上显示并可手动暂停 / 恢复。
    const quota = require('../../core/codeagent-quota');
    let avoid = {}, credit = {}, rules = null;
    try { avoid = quota.activeAvoid(getHubDataDir()); credit = quota.creditReadings(getHubDataDir()); } catch { /* 读不到就都按可用显示 */ }
    // 默认模型和权限不符（个人账号）：只显示，不改 settings.json
    let personalCheck = null;
    try { personalCheck = require('../../core/codeagent-model-route').personalModels({ dataDir: getHubDataDir(), personalDir }); } catch { personalCheck = null; }
    // 模型配置避让（2026-10-19）：整号没在避让时，显示和这个号此刻会请求的模型对得上的那条（含已到试探时间的）；
    // 配置已改成别的模型、或只是某个会话里临时换过的不显示（审核 2026-10-19）
    try {
      const all = quota.modelAvoidAll(getHubDataDir());
      const configModelOf = key => {
        if (key === 'personal') return personalCheck ? (personalCheck.written || personalCheck.defaultModel || '') : '';
        const a = codeagentPoolAccounts().find(x => x.id === key);
        // 账号即模型（切号开关关着）：号此刻会请求的就是它自己写的值，不推断
        return a ? (require('../../core/codeagent-model-route').routeSwitchEnabled() ? pool.effectiveModel(a.dir) : pool.readSettingsModel(a.dir)) : null;
      };
      for (const key of Object.keys(all)) {
        if (avoid[key]) continue;
        const cm = configModelOf(key);
        if (cm == null) continue;
        const e = quota.modelAvoidEntry(all, key, cm);
        if (e) avoid[key] = e;
      }
    } catch { /* 读不到就按可用显示 */ }
    try { const loaded = quota.loadRules(getHubDataDir()); rules = { count: loaded.rules.length, file: loaded.file, errors: loaded.errors }; } catch { rules = null; }
    const quotaOf = key => ({ avoid: avoid[key] ? { ...avoid[key], label: quota.describeAvoid(avoid[key]) } : null, credit: credit[key] || null });
    return { ok: true, accounts: accounts.map(a => ({ ...a, ...quotaOf(a.id) })), checkedAt: new Date().toISOString(),
      usable: accounts.filter(a => a.state === 'ready' && !a.sameAsPersonal && !a.duplicateOf).length, quotaRules: rules,
      personal: { accountLabel: pool.maskAccountId(personal.accountId), method: personal.method || null, present: !!personal.present,
        // 登录状态（2026-10-19）：ready / expired / login-required / unreadable；启动中心据此提示「个人账号要重新登录」
        state: pool.accountState(personal), expiresAt: personal.expiresAt || null, ...(personal.detail ? { credentialsNote: personal.detail } : {}),
        activeSessions: personalActive, models: personalModels.models, modelsProbedAt: personalModels.probedAt || null, ...quotaOf('personal'),
        ...(personalCheck && personalCheck.configMismatch ? { configNote: require('../../core/codeagent-model-route').describeMismatch(personalCheck.configMismatch) } : {}) } };
  }
  // 一键获取模型权限：后台起这个账号的 CodeAgent 读 /model 菜单（core/codeagent-model-probe.js），一次只跑一个。
  // v2.1.6（2026-10-16 用户「按计划推进」）：新添加的号登录完成、导入本机已登录的号、以及从没获取过的号（含个人账号），
  // Hub 自动在后台获取一次，不用手动点；每个号每次运行 Hub 只自动试一次，失败了仍可手动点「获取」。
  let codeagentProbeChain = Promise.resolve();
  const codeagentProbing = new Set();
  const codeagentAutoTried = new Set();
  function probeCodeAgentAccount(id) {
    const run = async () => {
      codeagentProbing.add(id);
      try {
        const { getHubDataDir } = require('../../core/data-dir');
        const pool = require('../../core/codeagent-pool');
        const probe = require('../../core/codeagent-model-probe');
        const config = require('../../core/codeagent-config').resolveCodeAgentConfig(process.env);
        const dataDir = getHubDataDir();
        let configDir, file;
        if (id === 'personal') { configDir = config.configDir; file = pool.personalModelsFile(dataDir); }
        else {
          const account = codeagentPoolAccounts().find(a => a.id === id);
          if (!account) throw new Error('号池里没有这个账号');
          if (account.state !== 'ready') throw new Error('这个号需要先重新登录');
          configDir = account.dir; file = require('path').join(account.dir, probe.MODELS_FILE);
        }
        const result = await (codeagentProbeModels || probe.probeModels)({ command: config.command, configDirEnv: config.configDirEnv, configDir, cwd: pool.probeCwd(dataDir) });
        if (!result.ok) throw new Error(result.error);
        probe.writeProbed(file, result);
        return result.models;
      } finally { codeagentProbing.delete(id); }
    };
    const next = codeagentProbeChain.then(run, run);
    codeagentProbeChain = next.catch(() => {});
    return next;
  }
  function autoProbeCodeAgentAccount(id) {
    if (codeagentAutoTried.has(id) || codeagentProbing.has(id)) return;
    codeagentAutoTried.add(id);
    codeagentProbing.add(id);
    sendToRenderer('codeagent-pool:changed', { id, probing: true });
    probeCodeAgentAccount(id)
      .then(models => sendToRenderer('codeagent-pool:changed', { id, ok: true, models, auto: true }))
      .catch(error => sendToRenderer('codeagent-pool:changed', { id, ok: false, error: error.message, auto: true }));
  }
  // 号主在登录窗口里登录完成前凭证文件还不存在：每 3 秒看一次，最多 10 分钟，出现了就自动获取模型权限。
  // id = 'personal' 时看个人账号的配置目录（个人账号重新登录，2026-10-19）。
  function autoProbeAfterLogin(id) {
    codeagentAutoTried.delete(id);
    const deadline = Date.now() + 10 * 60 * 1000;
    const stateOf = () => {
      if (id !== 'personal') { const account = codeagentPoolAccounts().find(a => a.id === id); return account ? account.state : null; }
      const pool = require('../../core/codeagent-pool');
      return pool.accountState(pool.readCredentials(require('../../core/codeagent-config').resolveCodeAgentConfig(process.env).configDir));
    };
    const tick = () => {
      let state = null;
      try { state = stateOf(); } catch { return; }
      if (!state) return;
      if (state === 'ready') { sendToRenderer('codeagent-pool:changed', { id, loggedIn: true }); autoProbeCodeAgentAccount(id); return; }
      if (Date.now() < deadline) setTimeout(tick, codeagentLoginPollMs).unref?.();
    };
    setTimeout(tick, codeagentLoginPollMs).unref?.();
  }
  // 列表里从没获取过模型权限的号（含个人账号）自动补一次。
  function autoProbeMissing(status) {
    if (!status || status.ok === false) return;
    if (status.personal && status.personal.present && !status.personal.modelsProbedAt) autoProbeCodeAgentAccount('personal');
    for (const a of status.accounts || []) {
      if (a.state === 'ready' && !a.sameAsPersonal && !a.duplicateOf && !a.modelsProbedAt) autoProbeCodeAgentAccount(a.id);
    }
  }
  ipcMain.handle('codeagent-pool:probe', (_event, payload) => {
    const id = payload?.id;
    return probeCodeAgentAccount(id)
      .then(models => ({ ...codeagentPoolStatus(), probed: { id, models } }))
      .catch(error => ({ ok: false, error: error.message }));
  });
  ipcMain.handle('codeagent-pool:list', () => {
    try { const status = codeagentPoolStatus(); autoProbeMissing(status); return { ...status, probing: [...codeagentProbing] }; }
    catch (error) { return { ok: false, error: error.message }; }
  });
  // 会话栏的账号字母与代称（core/codeagent-account-badge.js）：只读凭证元数据，不触发获取模型权限。
  ipcMain.handle('codeagent-pool:badges', () => {
    try {
      const { getHubDataDir } = require('../../core/data-dir');
      const personalDir = require('../../core/codeagent-config').resolveCodeAgentConfig(process.env).configDir;
      return { ok: true, ...require('../../core/codeagent-account-badge').accountBadges({ dataDir: getHubDataDir(), personalDir }) };
    } catch (error) { return { ok: false, error: error.message }; }
  });
  ipcMain.handle('codeagent-pool:add', (_event, payload) => {
    try {
      const { getHubDataDir } = require('../../core/data-dir');
      const pool = require('../../core/codeagent-pool');
      const id = pool.addAccount(getHubDataDir(), { note: payload && payload.note });
      pool.openLoginWindow(getHubDataDir(), id, require('../../core/codeagent-config').resolveCodeAgentConfig(process.env));
      autoProbeAfterLogin(id);
      return { ...codeagentPoolStatus(), added: id };
    } catch (error) { return { ok: false, error: error.message }; }
  });
  ipcMain.handle('codeagent-pool:local', () => {
    try {
      const { getHubDataDir } = require('../../core/data-dir');
      const personalDir = require('../../core/codeagent-config').resolveCodeAgentConfig(process.env).configDir;
      return { ok: true, candidates: require('../../core/codeagent-pool').localCandidates(getHubDataDir(), { personalDir }) };
    } catch (error) { return { ok: false, error: error.message }; }
  });
  ipcMain.handle('codeagent-pool:import', (_event, payload) => {
    try {
      const { getHubDataDir } = require('../../core/data-dir');
      const personalDir = require('../../core/codeagent-config').resolveCodeAgentConfig(process.env).configDir;
      const id = require('../../core/codeagent-pool').importLocal(getHubDataDir(), payload?.dir, { note: payload?.note, personalDir });
      autoProbeCodeAgentAccount(id);
      return { ...codeagentPoolStatus(), added: id, probing: [...codeagentProbing] };
    } catch (error) { return { ok: false, error: error.message }; }
  });
  ipcMain.handle('codeagent-pool:login', (_event, payload) => {
    try {
      const { getHubDataDir } = require('../../core/data-dir');
      const pool = require('../../core/codeagent-pool');
      if (!pool.readRegistry(getHubDataDir()).accounts.some(a => a.id === payload?.id)) throw new Error('号池里没有这个账号');
      pool.openLoginWindow(getHubDataDir(), payload.id, require('../../core/codeagent-config').resolveCodeAgentConfig(process.env));
      autoProbeAfterLogin(payload.id);
      return codeagentPoolStatus();
    } catch (error) { return { ok: false, error: error.message }; }
  });
  // 个人账号重新登录（2026-10-19）：登录过期、凭证读不懂时，开同样的登录窗口，目录是个人账号的配置目录。
  ipcMain.handle('codeagent-pool:personal-login', () => {
    try {
      const { getHubDataDir } = require('../../core/data-dir');
      require('../../core/codeagent-pool').openLoginWindow(getHubDataDir(), 'personal', require('../../core/codeagent-config').resolveCodeAgentConfig(process.env), { personal: true });
      // 凭证出现后推送 codeagent-pool:changed（账号与号池、启动中心据此刷新），并重新获取模型权限
      autoProbeAfterLogin('personal');
      return codeagentPoolStatus();
    } catch (error) { return { ok: false, error: error.message }; }
  });
  ipcMain.handle('codeagent-pool:note', (_event, payload) => {
    try {
      const { getHubDataDir } = require('../../core/data-dir');
      require('../../core/codeagent-pool').setNote(getHubDataDir(), payload?.id, payload?.note);
      return codeagentPoolStatus();
    } catch (error) { return { ok: false, error: error.message }; }
  });
  // 手动暂停 / 恢复派活给一个号（额度感知，2026-10-18）：暂停 = 标「避让中」（hours 小时后自动恢复，不填 = 直到手动恢复）；
  // 恢复 = 解除避让（含自动识别到额度报错的）。通道下一轮挑号就按新状态。
  ipcMain.handle('codeagent-pool:pause', (_event, payload) => {
    try {
      const { getHubDataDir } = require('../../core/data-dir');
      const id = String(payload?.id || '');
      if (id !== 'personal' && !require('../../core/codeagent-pool').readRegistry(getHubDataDir()).accounts.some(a => a.id === id)) throw new Error('没有这个账号');
      const hours = payload?.hours == null || payload.hours === '' ? null : Number(payload.hours);
      if (hours != null && !(hours >= 0.25 && hours <= 72)) throw new Error('暂停时长只能是 0.25–72 小时');
      require('../../core/codeagent-quota').markAvoid(getHubDataDir(), id, { source: 'manual', reason: '在这台电脑上手动暂停', until: hours ? Date.now() + hours * 3600000 : null });
      sendToRenderer('bridge:changed', {});
      return codeagentPoolStatus();
    } catch (error) { return { ok: false, error: error.message }; }
  });
  ipcMain.handle('codeagent-pool:resume', (_event, payload) => {
    try {
      const { getHubDataDir } = require('../../core/data-dir');
      require('../../core/codeagent-quota').clearAvoid(getHubDataDir(), String(payload?.id || ''), { by: 'local' });
      sendToRenderer('bridge:changed', {});
      return codeagentPoolStatus();
    } catch (error) { return { ok: false, error: error.message }; }
  });
  ipcMain.handle('codeagent-pool:remove', (_event, payload) => {
    try {
      const { getHubDataDir } = require('../../core/data-dir');
      const active = sessionManager.codeagentPoolActiveCounts()[payload?.id] || 0;
      if (active) throw new Error(`还有 ${active} 个会话在用这个号，先关掉或让它们休眠再移出`);
      require('../../core/codeagent-pool').removeAccount(getHubDataDir(), payload?.id);
      return codeagentPoolStatus();
    } catch (error) { return { ok: false, error: error.message }; }
  });
  // CodeAgent 换模型：在它自己的 /model 菜单里选（core/codeagent-model-picker.js）。交互模式不认 --model，
  // 以前「带 --model 重开」在公司真机上不生效（2026-10-14 同事反馈选了 MiniMax 仍是 GLM）。
  const codeagentPicker = require('../../core/codeagent-model-picker');
  const codeagentModels = require('../../core/codeagent-models');
  async function runCodeAgentPick(sessionId, modelId, reason) {
    const session = sessionManager.getSession(sessionId);
    if (!session) return { ok: false, message: '会话已经关闭' };
    const { getHubDataDir } = require('../../core/data-dir');
    const dataDir = getHubDataDir();
    const guard = require('../../core/codeagent-default-model-guard');
    // 自动会话（通道、公司助理、论坛）只在启动和原地重拉时由 Hub 选成这个号该用的模型（2026-10-20 用户：照真人从启动中心新建），
    // 会话中途不切换（2026-10-19 账号即模型）；例外只有一个 model-config-fix（2026-10-22 用户）：通道的会话报出「模型配置有误」后，
    // 当场在同一个会话里用 /model 切到清单里的模型再把这一轮重发一次。
    if (['company-bridge', 'company-assistant', 'company-forum'].includes(session.purpose)
      && reason !== 'launch' && reason !== 'relaunch' && reason !== 'model-config-fix') {
      codeagentModels.appendModelLog(dataDir, { event: 'pick', session: String(sessionId).slice(0, 8), reason, model: modelId, ok: false, error: 'automatic-session' });
      return { ok: false, inputReady: true, message: '自动会话用账号自己的默认模型，不切换模型' };
    }
    // 菜单回车会写这个会话的 CodeAgent 实际用的配置目录：启动时记下的那个，规范化后快照、改回、核对都用它。
    const configDir = codeagentPicker.normalizeConfigDir(guard.sessionConfigDir(session, { dataDir }));
    const account = guard.accountOf(session, dataDir).alias;
    const permitted = guard.permittedModels(session, configDir, { dataDir });
    let before = '';
    try { before = String(JSON.parse(require('fs').readFileSync(require('path').join(configDir, 'settings.json'), 'utf8')).model || ''); } catch { before = ''; }
    // 菜单回车（CodeAgent 写）和改回原值（Hub 写）都是这次选择引起的：先登记，看护看到时认得出来源，这里自己记日志。
    guard.noteHubWrite(configDir, before, `picker-restore:${reason}`, { logged: true, session: String(sessionId).slice(0, 8) });
    // 开一次模型菜单选中 want（同一个会话可能要开两次：第一次的目标不在权限清单里时改选清单里的模型，见下面的兜底）
    const driveMenu = async want => {
      guard.noteHubWrite(configDir, want, `codeagent-menu-enter:${reason}`, { logged: true, session: String(sessionId).slice(0, 8) });
      try {
        return await codeagentPicker.pickModel({ manager: sessionManager, sid: sessionId, kind: session.kind, modelId: want,
          configDir, allowedModels: permitted.authoritative ? permitted.models : null,
          // 启动和原地重拉：等 CLI 画出普通输入框再敲 /model（太早敲回车会丢，见 pickModel 的 readyFirstMs）
          readyFirstMs: reason === 'launch' || reason === 'relaunch' ? 45000 : 0,
          onDefaultChange: change => guard.recordChange(dataDir, { account, session: String(sessionId).slice(0, 8), before: change.restoredTo || '', after: change.written || '',
            source: `codeagent-menu-enter:${reason}`, extra: { file: change.file, restoredTo: change.restoredTo || '(空)', restoreOk: change.ok, ...(change.error ? { restoreError: change.error } : {}) } }, { persist: false }),
          sendToPty: require('../../core/group-chat-watcher').sendToPty });
      } catch (error) { return { ok: false, message: error && error.message ? error.message : String(error) }; }
    };
    let result = await driveMenu(modelId);
    let picked = modelId;
    const automatic = ['company-bridge', 'company-assistant', 'company-forum'].includes(session.purpose);
    // 兜底（2026-10-22）：发第一条问题之前，核对这次会用的模型在这个号的权限清单里；不在清单里就开菜单改选清单里的模型，
    // 不再只是记一行日志照发（2026-10-22 用户：明明是 DeepSeek 号却按 GLM 起来、请求没权限的模型）。
    // 2026-10-22 起手动新建/重拉的会话也核（reason=launch / relaunch）：手动会话是同一个病根的另一条路（启动中心不带模型、按配置里写的起）。
    // 用户在界面上明确的切换（switch）不在这里改选：那一路菜单本身只列清单里的模型（pickModel 的 allowedModels），选不出没权限的。
    // 改选只在菜单这次确实能用（result.ok）时做：菜单本来就选不动时再开一次只会更耽误这一轮，照旧走「能发就发、报错后修正」。
    const atLaunch = automatic || reason === 'launch' || reason === 'relaunch';
    const willUse = result.ok ? modelId : before;
    const offPermission = atLaunch && permitted.authoritative && permitted.models.length && willUse
      && !permitted.models.some(m => String(m).toLowerCase() === String(willUse).toLowerCase());
    if (offPermission && result.ok) {
      // 清单里的第一个（号池的号通常只有一个模型）。菜单里的实际条目以 permitted.models 为准，不按配置里的默认模型猜。
      const target = String(permitted.models[0]);
      codeagentModels.appendModelLog(dataDir, { event: 'pick', session: String(sessionId).slice(0, 8), account: account.replace(/\s+/g, ''), reason, model: modelId,
        ok: false, error: `off-permission：${modelId} 不在这个号的权限清单里，改选清单里的 ${target}` });
      const again = await driveMenu(target);
      if (again.ok) { result = again; picked = target; }
      else { result = { ...again, offPermissionPicked: target, message: `${again.message || '没选上'}（本来是 ${modelId}，不在这个号的权限清单里）` }; }
    }
    if (offPermission && !result.ok) {
      // 菜单这次没能用上（上面的改选也没成）：照旧发，只是记一行诊断。后面谁来收拾不一样：自动会话有通道的当场修正（号池号）
      // 或避让（个人号），手动会话没人自动修——用户在界面上看到报错后自己 /model 切一次（启动中心建的会话现在还会先按清单选一次，
      // 选不上才会走到这里）。日志里如实写清楚，排查时不用猜。
      codeagentModels.appendModelLog(dataDir, { event: 'pick', session: String(sessionId).slice(0, 8), account: account.replace(/\s+/g, ''), reason, model: willUse,
        ok: false, error: `off-permission：会请求的模型不在权限清单里，菜单没能用上，照旧发出，${automatic ? '交给报错后的配置修正 / 避让' : '手动会话没人自动修，等用户在 /model 里自己切'}`,
        fallback: automatic ? (session.codeagentPoolAccount ? 'pool-model-fix' : 'model-config-avoid') : 'user-pick' });
    }
    // 自动选模型的熔断计数（core/codeagent-auto-pick.js）：自动会话启动时菜单没选成记一次失败；这个号上任何一次选成就清零。
    // 不在权限清单里（没开菜单）不算菜单失败。
    const breakerAccount = session.codeagentPoolAccount || 'personal';
    let breaker = null;
    if (result.ok || (automatic && !result.notAllowed)) {
      try { breaker = require('../../core/codeagent-auto-pick').record(dataDir, breakerAccount, !!result.ok, { error: result.message || '' }); } catch { /* 计数失败不影响这一轮 */ }
    }
    if (breaker && breaker.opened) {
      codeagentModels.appendModelLog(dataDir, { event: 'pick-breaker-open', session: String(sessionId).slice(0, 8), account: account.replace(/\s+/g, ''),
        failures: breaker.failures, until: new Date(breaker.until).toISOString(), note: '连续自动选模型没成功，4 小时内这个号的自动会话不开模型菜单、直接发问题' });
    }
    // 自动会话没人守着：菜单没选上，但菜单已关、输入行可以用（认得出普通输入框，或旧版画面认不出、但已没有菜单和「/model」残留），
    // 就按 CLI 当前模型照常把问题发出去，失败只记在 pick 日志里，不卡住这一轮；回执里的模型按实际作答的模型（company.js 读原生记录）。
    const fallback = !result.ok && automatic && (result.inputReady || result.inputUsable);
    if (!result.ok && automatic && !fallback) {
      result = { ...result, message: `自动选模型没成功，模型菜单也没能关掉，为了不把问题打进菜单，这一轮没有发出去（原因：${result.message || '未知'}）` };
    }
    if (result.defaults) {
      guard.recordChange(dataDir, { account, session: String(sessionId).slice(0, 8), before: result.defaults.before || '', after: result.defaults.after || '',
        source: `picker:${reason}`, extra: { verified: result.defaults.verified, changes: result.defaults.changes.length } }, { persist: account === '个人' && result.defaults.changes.length > 0 });
      // 看守结束仍没改回：单独记一行，直查和排查一眼能看到这个号的默认模型停在了菜单改后的值
      if (!result.defaults.verified) codeagentModels.appendModelLog(dataDir, { event: 'default-model-restore-failed', session: String(sessionId).slice(0, 8), account: account.replace(/\s+/g, ''),
        want: result.defaults.before || '(空)', now: result.defaults.after || '(空)', reason });
    }
    codeagentModels.appendModelLog(dataDir, { event: 'pick', session: String(sessionId).slice(0, 8), account: account.replace(/\s+/g, ''), reason, model: picked,
      ok: result.ok, mode: result.mode, confirmed: result.confirmed, restored: (result.restored || []).join('+'), menu: (result.menu || []).join('+'), error: result.ok ? '' : result.message,
      fallback: fallback ? 'send-with-cli-model' : '', failures: breaker && !result.ok ? breaker.failures : '' });
    // 菜单里实际能选的模型：新建会话的模型下拉以它为准（core/codeagent-models.js 的 modelOptions）。
    if (result.menu) { try { codeagentModels.recordMenu(getHubDataDir(), result.menu); } catch { /* 只影响下次的模型下拉，不影响本次选择 */ } }
    if (!result.ok && Array.isArray(result.screen)) {
      try {
        const file = require('path').join(getHubDataDir(), 'logs', 'codeagent-model-picker-last.txt');
        require('fs').mkdirSync(require('path').dirname(file), { recursive: true });
        require('fs').writeFileSync(file, `${new Date().toISOString()} ${reason} ${modelId}：${result.message}\n\n${result.screen.join('\n')}\n`, 'utf8');
      } catch { /* 只是排查用的附件 */ }
    }
    // 自动会话没人守着：菜单没选上但普通输入框已恢复时，照旧按 CLI 当前模型把活发出去（和改动前一样），失败只记在上面的 pick 日志里，不卡住这一轮。
    if (fallback) {
      return { ...result, ok: true, fallback: 'cli-default-model' };
    }
    if (result.ok) {
      const updated = sessionManager.updateSessionMeta(sessionId, { currentModel: { id: picked, displayName: codeagentModels.modelLabel(picked) }, codeagentRequestedModel: undefined, codeagentModelPick: false,
        // 用户明确选中过的模型：CLI 自己退出、Hub 原地重拉时据此再选一次（core/session-manager.js 的 relaunch）。
        codeagentUserModel: picked });
      if (updated) sendToRenderer('session-updated', { session: updated });
    }
    return { ...result, model: result.ok ? picked : result.model };
  }
  // 通道的模型兜底（2026-10-22 用户）：会话里报出「模型配置有误」之后，在同一个会话里用 /model 切到这个号权限清单里的模型，
  // 切成了通道把这一轮重发一次（core/company-bridge/company.js 的 fixModelInSession），不必换号新开会话。
  // 目标是清单里第一个不是刚报错那个的模型；清单以 Hub 探测到的为准（guard.permittedModels），不按配置里写的猜。
  async function fixCodeAgentModel(sessionId, { avoidModel = '' } = {}) {
    const session = sessionManager.getSession(sessionId);
    if (!session) return { ok: false, error: 'session-closed', message: '会话已经关闭' };
    if (codeagentPicker.isPicking(sessionId)) return { ok: false, error: 'busy', message: '正在切换模型，请稍候' };
    const { getHubDataDir } = require('../../core/data-dir');
    const dataDir = getHubDataDir();
    const guard = require('../../core/codeagent-default-model-guard');
    const configDir = codeagentPicker.normalizeConfigDir(guard.sessionConfigDir(session, { dataDir }));
    const permitted = guard.permittedModels(session, configDir, { dataDir });
    const list = permitted.authoritative ? permitted.models : [];
    const target = list.find(m => String(m).toLowerCase() !== String(avoidModel).toLowerCase()) || '';
    if (!target) {
      const message = list.length ? `这个号的权限清单里只有刚报错的 ${avoidModel || '（未知）'}，没有可换的模型` : '读不到这个号的权限清单';
      return { ok: false, error: 'no-model', message };
    }
    const result = await codeagentPicker.schedulePick(sessionId, () => runCodeAgentPick(sessionId, target, 'model-config-fix'));
    // result.fallback：菜单没选上、只是没把问题挡住（自动会话「能发就发」的老兜底）。这一条路不能算切成了——
    // 会话还是原来的模型，通道据此重发只会再撞同一条报错。
    if (!result || !result.ok || result.fallback) {
      const why = (result && result.message) || '没能在 CodeAgent 里切到清单里的模型';
      return { ok: false, error: 'pick-failed', model: target,
        message: result && result.fallback ? `${why}；模型菜单没能用上，会话还是当前模型` : why };
    }
    return { ok: true, model: result.model || target, mode: result.mode, confirmed: !!result.confirmed };
  }
  if (typeof sessionManager.on === 'function') sessionManager.on('codeagent-model-pick', ({ sessionId, modelId, reason } = {}) => {
    if (!sessionId || !modelId) return;
    // 同步登记：随后到达的第一条消息会等这一步做完（group-chat-watcher 的 sendToPty）。
    codeagentPicker.schedulePick(sessionId, async () => {
      const result = await runCodeAgentPick(sessionId, modelId, reason);
      if (!result.ok) {
        sendToRenderer('session-notice', { sessionId, level: 'warning',
          message: `没能在 CodeAgent 里切到 ${codeagentModels.modelLabel(modelId)}：${result.message}。`
            + (result.inputReady ? '普通输入框已恢复；如有待发送正文会保留，确认沿用当前模型后再发送，或重新选择模型。'
              : '尚未确认退出模型菜单，正文不会写入；请点“后台”退出菜单后再发送，或重新选择模型。') });
      }
      return result;
    });
  });
  ipcMain.handle('codeagent:switch-model', async (_e, payload = {}) => {
    const sessionId = typeof payload.sessionId === 'string' ? payload.sessionId : '';
    const session = sessionId ? sessionManager.getSession(sessionId) : null;
    if (!session) return { ok: false, error: 'session-not-found', message: '会话不存在或已经休眠，先打开它再切换' };
    if (!/^codeagent(?:-resume)?$/.test(String(session.kind || ''))) return { ok: false, error: 'not-codeagent', message: '只有 CodeAgent 会话走这条切换' };
    const models = require('../../core/codeagent-models');
    const requested = typeof payload.modelId === 'string' ? payload.modelId.trim() : '';
    const modelId = models.normalizeModel(requested);
    if (!requested || modelId.toLowerCase() !== requested.toLowerCase()) return { ok: false, error: 'invalid-model', message: `模型名不能用：${requested}` };
    if (session.status === 'running') return { ok: false, error: 'busy', message: '当前回答仍在运行，请结束后再切换' };
    if (codeagentPicker.isPicking(sessionId)) return { ok: false, error: 'busy', message: '正在切换模型，请稍候' };
    const result = await codeagentPicker.schedulePick(sessionId, () => runCodeAgentPick(sessionId, modelId, 'switch'));
    if (!result || !result.ok) return { ok: false, error: 'pick-failed', message: (result && result.message) || 'CodeAgent 没能切换模型' };
    // 回执：菜单关掉了；看到「Set model to …」时 confirmed=true。下一条回答再核对实际模型。
    return { ok: true, model: { id: modelId, displayName: models.modelLabel(modelId) }, mode: result.mode, confirmed: !!result.confirmed };
  });
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
  // options.relaunch：ACP 会话不原地重连，而是休眠后按原会话重新启动，让启动参数重新计算
  //   （Token Plan 额度用完时改走 DeepSeek API 靠这个，见 main/token-plan-fallback-controller.js）。
  function restartSession(sessionId, overrides = null, options = {}) {
    if (ensureLaunchAuth) {
      const old=sessionManager.getSession(sessionId);
      if (old) return ensureLaunchAuth(old.kind,{...old,...overrides,model:sessionModelId(old)})
        .then(()=>restartAuthorizedSession(sessionId,overrides,options))
        .catch(error=>({ok:false,error:error.code || 'restart-failed',message:error.message}));
    }
    return restartAuthorizedSession(sessionId,overrides,options);
  }
  function restartAuthorizedSession(sessionId, overrides = null, options = {}) {
    const old = sessionManager.getSession(sessionId);
    if (!old) {
      return { ok: false, error: 'session-not-found', message: '会话不存在或已经休眠' };
    }
    const nativeCodex = sessionManager.getNativeSession?.(sessionId) || sessionManager.getNativeCodex?.(sessionId);
    // PTY 跑的 Codex 与 Claude 一样按原生会话 id 恢复；只有 App Server 会话在这里重连。
    if (overrides && (old.runtimeBackend === 'codex-app-server' || old.runtimeBackend === 'claude-stream-json' || (nativeCodex && !nativeCodex.isCliProvider) || sessionManager.getNativeClaude?.(sessionId))) {
      return { ok: false, error: 'restart-overrides-unsupported', message: '原生后端会话不支持按新模型重启' };
    }
    const relaunchAcp = options.relaunch === true && old.runtimeBackend === 'acp';
    if (old.purpose !== 'xresearch-research' && !relaunchAcp && (old.runtimeBackend === 'codex-app-server' || (nativeCodex && !nativeCodex.isCliProvider))) {
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

  return { lastResizeBySid, createSession, restartSession, fixCodeAgentModel };
}

module.exports = {
  isSafeNativeSessionId,
  waitForSessionGone,
  registerSessionIpc,
};
