'use strict';

/**
 * 群聊的分支三件套（2026-09-17）：
 *
 *   groupchat:add-existing-session  把一个已有会话分支进某个群聊
 *   groupchat:create-from-sessions  拿几个已有会话直接开一个新群聊
 *   groupchat:fork-meeting          整个群聊连人带记录一起分支
 *
 * 三个入口共用同一条路：`planSessionFork` 算出分支参数 → `addMeetingSubInternal`
 * 建成员。走后者而不是直接 createSession 是有原因的：群聊成员要的 MCP 注入、
 * DeepSeek 记忆注入、槽位登记、参与者勾选都长在那里，绕过去就会得到一个
 * 「看着在群里、其实没有群聊工具」的成员。
 *
 * 为什么坚持用分支而不是把原会话搬进群聊：MCP 是启动时注入的，跑起来的会话改不了；
 * 而且原会话可能正被另一个 Hub 打开。分支既拿到了原会话的记忆，又是一个全新的、
 * 由本群聊配置出来的进程，两个问题一起绕开。
 */

const { isSafeNativeSessionId, planSessionFork } = require('../../core/session-fork-plan.js');
const {
  nativeSessionIdentity,
  runtimeKindForSession,
  supportsForkSession,
} = require('../../core/session-capabilities.js');

// 群聊入口开放的 runtime。与 renderer/meeting-room.js 的 showAddSubMenu 一致：
// 历史群聊里的 Gemini/Kimi 成员继续可读可跑，只是不再从这里新增。
const GROUP_FORKABLE_KINDS = new Set(['claude', 'codex', 'deepseek', 'qwen', 'deepseek-acp', 'glm']);

function baseKind(kind) {
  return String(kind || '').replace(/-resume$/, '');
}

function meetingTitleBranchIndex(baseTitle, meetings) {
  const prefix = `${baseTitle}（分支`;
  let max = 0;
  for (const meeting of meetings || []) {
    const title = String(meeting && meeting.title || '');
    if (!title.startsWith(prefix)) continue;
    const match = /（分支\s*(\d+)）\s*$/.exec(title);
    max = Math.max(max, match ? Number(match[1]) : 1);
  }
  return max + 1;
}

function registerGroupChatForkIpc(ipcMain, deps) {
  const {
    addMeetingSubInternal,
    getHubDataDir,
    getImmersiveByMeeting = () => ({}),
    getLastPersistedSessions = () => [],
    getPersistedSessions = () => [],
    groupchat,
    logger = console,
    meetingManager,
    sendToRenderer,
    sessionManager,
    sessionStore,
    stateStore,
  } = deps;

  function siblingPool() {
    const persisted = getPersistedSessions();
    return [
      ...(typeof sessionManager.getAllSessions === 'function' ? sessionManager.getAllSessions() : []),
      ...(Array.isArray(persisted) ? persisted : []),
    ];
  }

  function persistState(label) {
    try {
      stateStore.save({
        version: 1,
        cleanShutdown: false,
        sessions: getLastPersistedSessions(),
        meetings: meetingManager.getAllMeetings(),
        immersiveByMeeting: getImmersiveByMeeting(),
      });
      return null;
    } catch (error) {
      logger.warn(`[groupchat-fork] ${label} persist failed:`, error && error.message);
      return `state.json persist failed: ${error.message}`;
    }
  }

  /** 这个会话现在能不能被分支进群聊。拒绝要说清楚原因，不能只给一句“不行”。 */
  function forkabilityOf(session) {
    if (!session) return { ok: false, error: 'session-not-found', message: '会话不存在或尚未启动' };
    if (!GROUP_FORKABLE_KINDS.has(baseKind(session.kind))) {
      return {
        ok: false,
        error: 'unsupported-kind',
        message: `群聊暂不支持 ${session.kind} 成员（可用：Claude / Codex / DeepSeek / Qwen / GLM）`,
      };
    }
    if (!supportsForkSession(session)) {
      return { ok: false, error: 'unsupported-kind', message: '这种会话没有分支能力' };
    }
    const identity = nativeSessionIdentity(session);
    if (!isSafeNativeSessionId(identity && identity.value)) {
      return {
        ok: false,
        error: 'native-session-id-missing',
        message: '这个会话还没绑定原生会话 ID（通常是一次都还没对话过），等它答完一轮再试',
      };
    }
    return { ok: true };
  }

  async function forkSessionIntoMeeting(meetingId, source, overrides = {}) {
    const sourceMeeting = source.meetingId && typeof meetingManager.getMeeting === 'function'
      ? meetingManager.getMeeting(source.meetingId)
      : null;
    const plan = planSessionFork({
      source,
      siblingPool: siblingPool(),
      meeting: sourceMeeting,
      rendererTitle: source.title || '',
      runtimeKind: runtimeKindForSession(source),
      overrides,
    });
    if (!plan.ok) return plan;
    if (plan.needsAcpFork) {
      const native = typeof sessionManager.getNativeSession === 'function'
        ? sessionManager.getNativeSession(source.id)
        : null;
      if (!native || typeof native.fork !== 'function') {
        return {
          ok: false,
          error: 'acp-fork-unavailable',
          message: `「${source.title || source.kind}」需要先打开会话才能分支`,
        };
      }
      try { plan.opts.acpFork = await native.fork(); }
      catch (error) { return { ok: false, error: 'acp-fork-failed', message: error.message }; }
    }
    if (plan.kind === 'codex' && plan.opts.codexForkSid && sessionManager.prepareCodexFork) {
      try { plan.opts = await sessionManager.prepareCodexFork(plan.opts); }
      catch (error) { return { ok: false, error: 'codex-fork-failed', message: error.message }; }
    }
    let result;
    try { result = await addMeetingSubInternal(meetingId, plan.kind, plan.opts); }
    catch (error) { return { ok: false, error: 'member-create-failed', message: error.message }; }
    if (!result || !result.session) {
      return { ok: false, error: 'member-create-failed', message: '成员会话创建失败' };
    }
    return { ok: true, session: result.session, meeting: result.meeting, sourceSessionId: source.id };
  }

  function destroyMeeting(meetingId) {
    try {
      const subIds = meetingManager.closeMeeting(meetingId) || [];
      for (const sid of subIds) {
        try { sessionManager.closeSession(sid); } catch {}
        stateStore.markRemovedSession?.(sid);
        sessionStore?.deleteSessionFile?.(sid);
        sessionStore?.cancelDirty?.(sid);
      }
      groupchat.cleanup?.(getHubDataDir(), meetingId);
      stateStore.markRemovedMeeting?.(meetingId);
      sendToRenderer('meeting-closed', { meetingId });
    } catch (error) {
      logger.warn('[groupchat-fork] rollback failed:', error && error.message);
    }
  }

  // ── 可分支会话清单（给「从已有会话…」选择器） ────────────────────────────
  ipcMain.handle('groupchat:forkable-sessions', (_e, { meetingId = null } = {}) => {
    const meeting = meetingId && typeof meetingManager.getMeeting === 'function'
      ? meetingManager.getMeeting(meetingId)
      : null;
    const already = new Set(meeting && Array.isArray(meeting.subSessions) ? meeting.subSessions : []);
    const sessions = typeof sessionManager.getAllSessions === 'function' ? sessionManager.getAllSessions() : [];
    return sessions
      .filter(session => session && !already.has(session.id))
      .filter(session => session.purpose !== 'xresearch-research' && !session.hiddenFromSidebar)
      .filter(session => forkabilityOf(session).ok)
      .map(session => {
        const owner = session.meetingId && typeof meetingManager.getMeeting === 'function'
          ? meetingManager.getMeeting(session.meetingId)
          : null;
        return {
          id: session.id,
          title: session.title || '',
          kind: session.kind,
          status: session.status || '',
          cwd: session.cwd || '',
          model: (session.currentModel && session.currentModel.id) || null,
          meetingId: session.meetingId || null,
          meetingTitle: owner ? owner.title : null,
          lastMessageTime: Number(session.lastMessageTime) || Number(session.createdAt) || 0,
        };
      })
      .sort((a, b) => b.lastMessageTime - a.lastMessageTime);
  });

  // ── 把一个已有会话分支进群聊 ──────────────────────────────────────────────
  ipcMain.handle('groupchat:add-existing-session', async (_e, { meetingId, sessionId } = {}) => {
    const meeting = meetingId ? meetingManager.getMeeting(meetingId) : null;
    if (!meeting) return { ok: false, error: 'meeting-not-found', message: '群聊不存在' };
    if (!meeting.groupChat) return { ok: false, error: 'not-group-chat', message: '这不是 AI 群聊' };
    const source = typeof sessionId === 'string' ? sessionManager.getSession(sessionId) : null;
    const forkable = forkabilityOf(source);
    if (!forkable.ok) return forkable;
    if ((meeting.subSessions || []).includes(sessionId)) {
      return { ok: false, error: 'already-member', message: '这个会话已经在本群聊里了' };
    }

    const result = await forkSessionIntoMeeting(meetingId, source);
    if (!result.ok) return result;

    // 让群里其他人和用户都看得见「谁进来了」。系统提示不进任何成员的上下文，
    // 纯粹是记录——新成员自己会在第一条 prompt 里拿到群聊历史。
    try {
      const orch = groupchat.getOrchestrator(getHubDataDir(), meetingId);
      const turnNum = Number(orch.state.currentTurn) || 0;
      if (turnNum > 0) {
        orch.appendSystemNote(turnNum, `「${result.session.title}」从已有会话分支加入群聊，已带着原会话的上下文。`, { kind: 'info' });
      }
    } catch (error) {
      logger.warn('[groupchat-fork] join note failed:', error && error.message);
    }

    const persistWarning = persistState('add-existing-session');
    return {
      ok: true,
      session: result.session,
      meeting: meetingManager.getMeeting(meetingId) || result.meeting,
      ...(persistWarning ? { persistWarning } : {}),
    };
  });

  // ── 拿几个已有会话开一个新群聊 ────────────────────────────────────────────
  ipcMain.handle('groupchat:create-from-sessions', async (_e, { sessionIds, title = '', scene = 'general' } = {}) => {
    const ids = Array.isArray(sessionIds) ? sessionIds.filter(id => typeof id === 'string' && id) : [];
    if (ids.length === 0) return { ok: false, error: 'no-sessions', message: '请先选择至少一个会话' };

    // 先全部体检再动手：建到一半失败还要回滚，不如提前说清楚哪一个不行。
    const sources = [];
    for (const id of ids) {
      const session = sessionManager.getSession(id);
      const forkable = forkabilityOf(session);
      if (!forkable.ok) {
        return { ...forkable, message: `「${(session && session.title) || id}」不能分支：${forkable.message}` };
      }
      sources.push(session);
    }

    // 所有来源在同一个目录时沿用它，否则留空交给群聊自己的工作区逻辑。
    const cwds = new Set(sources.map(s => s.cwd || ''));
    const workspace = cwds.size === 1 ? [...cwds][0] || null : null;
    const hasTitle = typeof title === 'string' && title.trim().length > 0;
    const meeting = meetingManager.createMeeting({
      groupChat: true,
      mode: scene === 'research' ? 'research' : 'general',
      title: hasTitle ? title.trim() : '',
      autoTitlePending: !hasTitle,
      userRenamed: hasTitle,
      workspace,
      participants: [],
    });

    const created = [];
    for (const source of sources) {
      const result = await forkSessionIntoMeeting(meeting.id, source);
      if (!result.ok) {
        destroyMeeting(meeting.id);
        return { ...result, message: `「${source.title || source.kind}」分支失败：${result.message}` };
      }
      created.push(result);
    }

    const fresh = meetingManager.getMeeting(meeting.id);
    const persistWarning = persistState('create-from-sessions');
    sendToRenderer('meeting-created', { meeting: fresh });
    return {
      ok: true,
      meeting: fresh,
      sessions: created.map(item => item.session),
      ...(persistWarning ? { persistWarning } : {}),
    };
  });

  // ── 整个群聊一起分支 ──────────────────────────────────────────────────────
  ipcMain.handle('groupchat:fork-meeting', async (_e, { meetingId, title = '' } = {}) => {
    const meeting = meetingId ? meetingManager.getMeeting(meetingId) : null;
    if (!meeting) return { ok: false, error: 'meeting-not-found', message: '群聊不存在' };
    if (!meeting.groupChat) return { ok: false, error: 'not-group-chat', message: '这不是 AI 群聊' };
    // 开发群聊共用 worktree 和交付文件，分支出来的两份会互相改坏。先不开放。
    if (meeting.mode === 'dev' || meeting.scene === 'dev' || (meeting.serialWorkflow && meeting.serialWorkflow.enabled)) {
      return {
        ok: false,
        error: 'dev-meeting-unsupported',
        message: '开发群聊（含串行工作流）暂不支持分支：两个分支会共用同一个工作目录和交付文件。',
      };
    }
    const subSessions = Array.isArray(meeting.subSessions) ? meeting.subSessions : [];
    if (subSessions.length === 0) return { ok: false, error: 'empty-meeting', message: '这个群聊还没有成员' };

    const hubDataDir = getHubDataDir();
    const sourceOrch = groupchat.getOrchestrator(hubDataDir, meetingId);
    const sourceState = sourceOrch.getState();
    if (sourceState.currentMode && sourceState.currentMode !== 'idle') {
      return { ok: false, error: 'turn-in-progress', message: '本轮还在进行中，等这一轮结束再分支' };
    }
    if (sourceState.activeRun && !['completed', 'errored', 'failed', 'interrupted', 'superseded', 'absent', 'handed_off'].includes(sourceState.activeRun.status)) {
      return { ok: false, error: 'turn-in-progress', message: '还有未结算的发送，等它结束再分支' };
    }

    // 全员体检。有人不能分支就整体拒绝——少一个人的群聊不是这个群聊的分支。
    const spoke = new Set((sourceState.messages || []).map(m => m && m.sid).filter(Boolean));
    const plansBySid = new Map();
    for (const sid of subSessions) {
      const session = sessionManager.getSession(sid);
      if (!session) {
        return { ok: false, error: 'member-missing', message: '有成员会话找不到了，先在群聊里清理一下再分支' };
      }
      const forkable = forkabilityOf(session);
      if (forkable.ok) { plansBySid.set(sid, { session, mode: 'fork' }); continue; }
      // 一次都没发过言的席位没有原生会话可分支，但它也没有任何上下文要继承，
      // 按同样的配置新建一个就等价。发过言却拿不到原生 ID 的必须拒绝，
      // 否则分支出来的群聊会凭空丢掉这个人的历史。
      if (!spoke.has(sid) && GROUP_FORKABLE_KINDS.has(baseKind(session.kind))) {
        plansBySid.set(sid, { session, mode: 'fresh' });
        continue;
      }
      return { ...forkable, message: `成员「${session.title || session.kind}」不能分支：${forkable.message}` };
    }

    const baseTitle = String(meeting.title || 'AI 群聊').replace(/（分支\s*\d+）\s*$/, '');
    const hasTitle = typeof title === 'string' && title.trim().length > 0;
    const branchIndex = meetingTitleBranchIndex(baseTitle, meetingManager.getAllMeetings());
    const forked = meetingManager.createMeeting({
      groupChat: true,
      mode: ['general', 'research', 'dev', 'writing'].includes(meeting.scene) ? meeting.scene : 'general',
      title: hasTitle ? title.trim() : `${baseTitle}（分支${branchIndex}）`,
      userRenamed: true,
      autoTitlePending: false,
      workspace: meeting.workspace || null,
      workspaceLabel: meeting.workspaceLabel || null,
      groupMode: meeting.groupMode,
      groupRecentRawN: meeting.groupRecentRawN,
      completionNotificationEnabled: meeting.completionNotificationEnabled === true,
      participants: [],
    });

    const sidMap = {};
    const slotSpecs = Array.isArray(meeting.slotSpecs) ? meeting.slotSpecs : [];
    for (let index = 0; index < subSessions.length; index += 1) {
      const sid = subSessions[index];
      const { session, mode } = plansBySid.get(sid);
      const memberId = (slotSpecs[index] && slotSpecs[index].memberId) || undefined;
      let result;
      if (mode === 'fork') {
        // 成员保留原名。分支标题（「分支1: X」）对单个会话是有用的身份，但整群分支时
        // 每位成员的原名多半是「Codex 1」这类通用名，会一起回落到群聊标题上 ——
        // 结果是分支群聊里所有人重名，@ 点名和卡片都分不出谁是谁（2026-09-17 真机验证发现）。
        // 群聊标题已经写了「（分支N）」，成员身份就该沿用原来的那一套。
        result = await forkSessionIntoMeeting(forked.id, session, {
          memberId,
          title: session.title || undefined,
          autoTitleGenerated: true,
          branchAutoTitlePending: null,
          branchSourceSessionId: null,
          branchIndex: null,
        });
      } else {
        const opts = {
          title: session.title || undefined,
          memberId,
          cwd: session.cwd || meeting.workspace || undefined,
          ...(session.currentModel && session.currentModel.id ? { model: session.currentModel.id } : {}),
          ...(session.effort ? { effort: session.effort } : {}),
          ...(session.mcpProfile ? { mcpProfile: session.mcpProfile } : {}),
          ...(session.fastMode === false ? { fastMode: false } : {}),
          ...(session.codexSpeedTier ? { codexSpeedTier: session.codexSpeedTier } : {}),
        };
        try {
          const created = await addMeetingSubInternal(forked.id, baseKind(session.kind), opts);
          result = created && created.session
            ? { ok: true, session: created.session }
            : { ok: false, error: 'member-create-failed', message: '成员会话创建失败' };
        } catch (error) {
          result = { ok: false, error: 'member-create-failed', message: error.message };
        }
      }
      if (!result.ok) {
        destroyMeeting(forked.id);
        return { ...result, message: `成员「${session.title || session.kind}」分支失败：${result.message}` };
      }
      sidMap[sid] = result.session.id;
    }

    // 成员齐了才搬记录。搬早了，中途失败回滚就会留下一份指向已删会话的记录。
    try {
      const targetOrch = groupchat.getOrchestrator(hubDataDir, forked.id);
      targetOrch.importForkedState(sourceState, {
        sidMap,
        sourceMeetingId: meetingId,
        sourceTitle: meeting.title || '',
      });
      const turnNum = Number(sourceState.currentTurn) || 0;
      if (turnNum > 0) {
        targetOrch.appendSystemNote(turnNum, `本群聊分支自「${meeting.title}」，上面的记录是分支时点的历史；从这里开始两边互不影响。`, { kind: 'info' });
      }
      targetOrch.setMeetingTitle(forked.title);
      targetOrch.syncTranscriptFile({ force: true });
    } catch (error) {
      destroyMeeting(forked.id);
      return { ok: false, error: 'state-import-failed', message: `群聊记录复制失败：${error.message}` };
    }

    if (Array.isArray(meeting.participants)) {
      meetingManager.setParticipants(forked.id, meeting.participants.slice());
    }
    if (meeting.covenantText) {
      try { meetingManager.updateMeeting(forked.id, { covenantText: meeting.covenantText, scene: meeting.scene }); }
      catch (error) { logger.warn('[groupchat-fork] covenant copy failed:', error && error.message); }
    }

    const fresh = meetingManager.getMeeting(forked.id);
    const persistWarning = persistState('fork-meeting');
    sendToRenderer('meeting-created', { meeting: fresh });
    sendToRenderer('meeting-updated', { meeting: fresh });
    return {
      ok: true,
      meeting: fresh,
      sidMap,
      ...(persistWarning ? { persistWarning } : {}),
    };
  });

  return { forkabilityOf, forkSessionIntoMeeting };
}

module.exports = { GROUP_FORKABLE_KINDS, meetingTitleBranchIndex, registerGroupChatForkIpc };
