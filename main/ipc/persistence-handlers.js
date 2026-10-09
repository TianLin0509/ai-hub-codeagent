'use strict';

const { isDeepStrictEqual } = require('node:util');

// 注意：memoryLinkWarning **故意不在这个名单里**。这里的语义是「新会话缺该字段就继承旧值」，
// 而 memory link 每次 spawn 都会重新检测——放进来会让警告一旦出现就永久粘住，修好了也删不掉
// （cwdFellBackFrom 能放是因为 healPersistedCwds 里有显式 delete 清除路径，它没有）。
const RESUME_META_FIELDS = [
  'nativeConfig',
  'cwdFellBackFrom',
  'transcriptPath',
  'codexSid',
  'acpSid',
  'acpProfileId',
  'acpCapabilities',
  'runtimeBackend',
  'nativeRuntime',
  'codexApprovalPolicy',
  'codexSandbox',
  'codexSessionsRoot',
  'codexAllowMtimeFallback',
  'codexProfile',
  'codexProfileLabel',
  'mcpProfile',
  'fastMode',
  'autonomous',
  'codexSpeedTier',
  'geminiChatId',
  'geminiProjectHash',
  'geminiProjectRoot',
  'kimiSid',
  'kimiSessionDir',
  'currentModel',
  'effort',
  'contextPct',
  'contextUsed',
  'sessionUsage',
  'contextMax',
  'contextEffectiveMax',
  'contextEffectiveObservedAt',
  'lastCompletedAt',
  'lastRunStartedAt',
  'lastRunDurationMs',
  'recentArtifacts',
  'userRenamed',
  'autoTitleGenerated',
  'branchSourceSessionId',
  'branchIndex',
  'branchAutoTitlePending',
  'purpose',
  'researchSessionId',
  'hiddenFromSidebar',
  'completionNotificationEnabled',
  'bottomed',
  // 已读异常与通知已读同义：renderer reload / Hub restart 后也不能重新播报
  // 同一条历史断连；真正的新失败由 transcript occurrenceId 重新升起。
  '_connectionIssueAck',
];
const PTY_CLEARED_FIELDS = new Set(['runtimeBackend', 'nativeRuntime', 'nativeConfig']);

function withoutVolatileTimestamps(entity) {
  if (!entity || typeof entity !== 'object') return entity;
  const { updatedAt: _updatedAt, savedAt: _savedAt, ...stable } = entity;
  return stable;
}

function persistentEntityEquals(left, right) {
  if (!left || !right) return left === right;
  return isDeepStrictEqual(
    withoutVolatileTimestamps(left),
    withoutVolatileTimestamps(right),
  );
}

function mergeResumeMetaFields(list, previousSessions) {
  const oldByHubId = new Map((previousSessions || []).map(s => [s.hubId, s]));
  for (const newSession of list || []) {
    if (!newSession || !newSession.hubId) continue;
    const oldSession = oldByHubId.get(newSession.hubId);
    if (!oldSession) continue;
    // PTY 会话故意把原生后端与快照置空（isCodexSession 靠它们区分）。原生时代的
    // 会话在 PTY 里恢复后若继承旧值，落盘记录会仍是原生后端，重启后被当成原生会话。
    const ptyOwned = newSession.agentRuntime === 'pty';
    for (const field of RESUME_META_FIELDS) {
      if (ptyOwned && PTY_CLEARED_FIELDS.has(field)) continue;
      if (field === 'userRenamed' && oldSession.userRenamed === true) {
        newSession.userRenamed = true;
        continue;
      }
      if (newSession[field] == null && oldSession[field] != null) {
        newSession[field] = oldSession[field];
      }
    }
  }
  return list;
}

function buildMeetingsForState(meetingList, meetingManager) {
  if (!Array.isArray(meetingList)) {
    return meetingManager.getAllMeetings();
  }
  return meetingList.map(rendererMeeting => {
    if (!rendererMeeting || !rendererMeeting.id) return rendererMeeting;
    const authoritative = meetingManager.getMeeting(rendererMeeting.id);
    if (!authoritative) return rendererMeeting;
    return {
      ...rendererMeeting,
      scene: rendererMeeting.scene || authoritative.scene,
      mode: rendererMeeting.mode || authoritative.mode,
      groupChat: typeof rendererMeeting.groupChat === 'boolean'
        ? rendererMeeting.groupChat
        : !!authoritative.groupChat,
      groupMode: rendererMeeting.groupMode || authoritative.groupMode || 'deliberation',
      groupRecentRawN: Number.isInteger(rendererMeeting.groupRecentRawN)
        ? rendererMeeting.groupRecentRawN
        : (Number.isInteger(authoritative.groupRecentRawN) ? authoritative.groupRecentRawN : 5),
      userRenamed: typeof rendererMeeting.userRenamed === 'boolean'
        ? rendererMeeting.userRenamed
        : !!authoritative.userRenamed,
      autoTitlePending: typeof rendererMeeting.autoTitlePending === 'boolean'
        ? rendererMeeting.autoTitlePending
        : !!authoritative.autoTitlePending,
      autoTitleGenerated: typeof rendererMeeting.autoTitleGenerated === 'boolean'
        ? rendererMeeting.autoTitleGenerated
        : !!authoritative.autoTitleGenerated,
      completionNotificationEnabled: typeof rendererMeeting.completionNotificationEnabled === 'boolean'
        ? rendererMeeting.completionNotificationEnabled
        : !!authoritative.completionNotificationEnabled,
      bottomed: typeof rendererMeeting.bottomed === 'boolean'
        ? rendererMeeting.bottomed
        : !!authoritative.bottomed,
      lastCompletedAt: typeof rendererMeeting.lastCompletedAt === 'number'
        ? rendererMeeting.lastCompletedAt
        : (typeof authoritative.lastCompletedAt === 'number' ? authoritative.lastCompletedAt : null),
      participants: Array.isArray(rendererMeeting.participants)
        ? rendererMeeting.participants
        : (Array.isArray(authoritative.participants) ? authoritative.participants : null),
      slotSpecs: Array.isArray(rendererMeeting.slotSpecs)
        ? rendererMeeting.slotSpecs
        : (Array.isArray(authoritative.slotSpecs) ? authoritative.slotSpecs : null),
      covenantText: (typeof rendererMeeting.covenantText === 'string' && rendererMeeting.covenantText)
        ? rendererMeeting.covenantText
        : (authoritative.covenantText || ''),
      // 串行工作流配置（2026-06-17 maintainer）：state.json 是 boot 恢复源，必须带上；
      //   优先 renderer 值，兜底后端权威（update-meeting 已写入 authoritative）
      serialWorkflow: (rendererMeeting.serialWorkflow && typeof rendererMeeting.serialWorkflow === 'object')
        ? rendererMeeting.serialWorkflow
        : (authoritative.serialWorkflow || null),
      // 编排身份由主进程权威维护（成员由编排员动态加入），先取主进程值。
      orchestration: authoritative.orchestration || rendererMeeting.orchestration || null,
    };
  });
}

function handlePersistSessions(list, meetingList, deps) {
  if (!Array.isArray(list)) return false;

  const {
    getImmersiveByMeeting,
    getLastPersistedMeetingIds,
    getLastPersistedMeetings = () => [],
    getLastPersistedSessionIds,
    getLastPersistedSessions,
    meetingManager,
    meetingStore,
    sessionStore,
    setLastPersistedMeetingIds,
    setLastPersistedMeetings = () => {},
    setLastPersistedSessionIds,
    setLastPersistedSessions,
    stateStore,
  } = deps;

  const previousSessions = getLastPersistedSessions();
  const sharedViewerIds = new Set();
  const previousSessionsById = new Map(
    (previousSessions || []).filter(Boolean).map(session => [session.hubId, session]),
  );
  // Closed copies in another Hub are navigation entries, not writers.
  // Keep unchanged entries without disk polling. Explicit edits and resume read
  // the current file under ownership protection instead of rewriting snapshots.
  const owners = deps.sessionManager?._openOwners?.();
  const uiFields = ['title','userRenamed','pinned','bottomed','completionNotificationEnabled','_connectionIssueAck'];
  const uiSnapshots = deps.sessionManager ? (deps.sessionManager._persistedUiInputs ||= new Map()) : new Map();
  let closedMetadataChanges = 0;

  if (owners) list = list.map(session => {
    if (!session?.hubId || deps.sessionManager.getSession(session.hubId)) return session;
    const lastInput = uiSnapshots.get(session.hubId) || previousSessionsById.get(session.hubId) || {};
    const edits = {};
    for (const field of uiFields) if (Object.hasOwn(session,field) && !isDeepStrictEqual(session[field],lastInput[field])) edits[field]=session[field];
    const accept = value => {uiSnapshots.set(session.hubId, Object.fromEntries(uiFields.map(field=>[field,session[field]])));return value;};
    const previous = previousSessionsById.get(session.hubId);
    if (previous && !Object.keys(edits).length) {
      sharedViewerIds.add(session.hubId);
      return accept({ ...previous });
    }
    const owner = owners.owner(session.hubId);
    const saved = sessionStore.loadSessionFile(session.hubId,{strict:true});
    if (owner && owner.pid !== process.pid) {
      sharedViewerIds.add(session.hubId);
      return accept(saved || session);
    }
    if (!saved) return accept(session);
    sharedViewerIds.add(session.hubId);
    if (!Object.keys(edits).length) return accept(saved);
    return owners.editClosed(session.hubId, () => {
      const latest=sessionStore.loadSessionFile(session.hubId,{strict:true}) || saved;
      const next={...latest,...edits,updatedAt:Date.now()};
      sessionStore.saveSessionFile(session.hubId,next);
      closedMetadataChanges++;
      return accept(next);
    });
  });
  mergeResumeMetaFields(list, previousSessions);
  require('../../core/session-meeting-membership.js').restoreMissingMeetingIds(
    list, meetingManager.getAllMeetings?.() || []);
  for (const session of list) {
    const live = deps.getLiveSession?.(session.hubId);
    // Renderer persistence can race the latest usage event. The main-process
    // snapshot owns accounting; never replace it with an older renderer copy.
    const authoritativeUsage = live?.sessionUsage || previousSessionsById.get(session.hubId)?.sessionUsage;
    if (authoritativeUsage) session.sessionUsage = authoritativeUsage;
    if (live && ['codex-app-server','acp'].includes(live.runtimeBackend)) {
      session.runtimeBackend = live.runtimeBackend;
      session.nativeRuntime = require('../../core/codex-native-runtime.js').persistNativeRuntime(live);
      session.codexSid = live.codexSid;
      session.codexApprovalPolicy = live.codexApprovalPolicy;
      session.codexSandbox = live.codexSandbox;
      if(live.runtimeBackend==='acp') {
        session.acpSid=live.acpSid;session.acpProfileId=live.acpProfileId;session.acpCapabilities=live.acpCapabilities;
      }
      if (live.codexSharedControl?.role === 'viewer') sharedViewerIds.add(session.hubId);
    }
  }

  const nowTs = Date.now();
  let changedSessions = closedMetadataChanges;
  let changedMeetings = 0;
  let removedEntities = 0;

  const newSessionIds = new Set(list.map(session => session && session.hubId).filter(Boolean));
  for (const oldId of getLastPersistedSessionIds()) {
    if (!newSessionIds.has(oldId)) {
      const remove = () => {
        stateStore.markRemovedSession(oldId);
        sessionStore.deleteSessionFile(oldId);
        sessionStore.cancelDirty(oldId);
        removedEntities += 1;
      };
      try {
        if (owners) owners.editSessions([oldId], remove, { allowOwn: true });
        else remove();
      } catch (error) {
        if (error.code !== 'SESSION_OCCUPIED') throw error;
        const saved = sessionStore.loadSessionFile(oldId,{strict:true}) || previousSessionsById.get(oldId);
        sharedViewerIds.add(oldId);
        if (saved) { list.push(saved); newSessionIds.add(oldId); }
      }
    }
  }
  setLastPersistedSessionIds(newSessionIds);

  for (const session of list) {
    if (!session || !session.hubId) continue;
    const authoritative = deps.sessionManager?.getSession(session.hubId);
    if (authoritative?.runtimeBackend === 'claude-stream-json') {
      session.runtimeBackend = authoritative.runtimeBackend;
      session.nativeRuntime = authoritative.nativeRuntime;
      session.nativeConfig = authoritative.nativeConfig;
      session.ccSessionId = authoritative.ccSessionId;
    }
    const previous = previousSessionsById.get(session.hubId);
    const changed = !previous
      || typeof previous.updatedAt !== 'number'
      || !persistentEntityEquals(session, previous);
    if (changed) {
      if (sharedViewerIds.has(session.hubId)) {
        session.updatedAt = typeof previous?.updatedAt === 'number' ? previous.updatedAt : nowTs;
        continue;
      }
      session.updatedAt = nowTs;
      sessionStore.markDirty(session.hubId, session);
      changedSessions += 1;
    } else {
      session.updatedAt = previous.updatedAt;
    }
  }

  setLastPersistedSessions(list);

  const meetingsForState = buildMeetingsForState(meetingList, meetingManager);
  const previousMeetings = getLastPersistedMeetings();
  const previousMeetingsById = new Map(
    (previousMeetings || []).filter(Boolean).map(meeting => [meeting.id, meeting]),
  );

  const newMeetingIds = new Set(meetingsForState.map(meeting => meeting && meeting.id).filter(Boolean));
  for (const oldId of getLastPersistedMeetingIds()) {
    if (!newMeetingIds.has(oldId)) {
      stateStore.markRemovedMeeting(oldId);
      meetingStore.deleteMeetingFile(oldId);
      meetingStore.cancelDirty(oldId);
      removedEntities += 1;
    }
  }
  setLastPersistedMeetingIds(newMeetingIds);

  const immersiveByMeeting = getImmersiveByMeeting();
  for (const meeting of meetingsForState) {
    if (meeting && meeting.id) {
      const immersive = immersiveByMeeting[meeting.id];
      if (typeof immersive === 'boolean') meeting.immersive = immersive;
      const previous = previousMeetingsById.get(meeting.id);
      const changed = !previous
        || typeof previous.updatedAt !== 'number'
        || !persistentEntityEquals(meeting, previous);
      if (changed) {
        meeting.updatedAt = nowTs;
        meetingStore.markDirty(meeting.id, meeting);
        changedMeetings += 1;
      } else {
        meeting.updatedAt = previous.updatedAt;
      }
    }
  }

  setLastPersistedMeetings(meetingsForState);

  if (changedSessions > 0 || changedMeetings > 0 || removedEntities > 0) {
    stateStore.save({
      version: 1,
      cleanShutdown: false,
      sessions: list,
      meetings: meetingsForState,
      immersiveByMeeting,
    });
  }

  return true;
}

function registerPersistenceIpc(ipcMain, deps) {
  ipcMain.handle('persist-sessions:flush', async (_e, list, meetingList) => {
    if (!handlePersistSessions(list, meetingList, deps)) throw new Error('工作现场无效，未保存');
    await deps.stateStore.flushPending();
    return { ok: true };
  });
  ipcMain.handle('get-dormant-sessions', () => ({
    sessions: deps.getLastPersistedSessions(),
    wasCleanShutdown: deps.bootWasClean,
  }));

  ipcMain.on('persist-sessions', (_e, list, meetingList) => {
    try { handlePersistSessions(list, meetingList, deps); }
    catch(error) {
      console.error('[session-persistence] save rejected:',error);
      _e.sender?.send('session-persistence-error', {message:error.message});
    }
  });
}

module.exports = {
  RESUME_META_FIELDS,
  buildMeetingsForState,
  handlePersistSessions,
  mergeResumeMetaFields,
  persistentEntityEquals,
  registerPersistenceIpc,
};
