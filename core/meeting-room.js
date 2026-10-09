const { v4: uuid } = require('uuid');
const meetingStore = require('./meeting-store');

// scene 白名单 (与 core/group-chat-scenes.js SCENE_REGISTRY keys 同步)
//   2026-05-04 maintainer: 'dev' 加入 (plan-dev-scenario.md MVP)
//   2026-09-30 'writing' 加入：写作 Tab 的「新文章」一键创建写作群聊
const MEETING_MODES = ['general', 'research', 'dev', 'writing'];

// 模式 → 房名前缀。前端 +号菜单点击两模式入口时透传 mode,createMeeting 据此生成
// 自带语义的房名(每模式独立计数,后期允许用户重命名)。未传 mode 时默认 'general' 走
// 通用 AI 群聊路径,保持向后兼容(老调用 createMeeting() 不会炸)。
// 2026-05-05 maintainer：前缀从历史 "X 群聊" 简化为 "X"，避免侧边栏 ~12 字符上限截断编号。
//   协作语义已由群聊标题 + sub session 头像承载。
const MODE_TITLE_PREFIX = {
  general: '通用',
  research: '投研',
  dev: '开发',
  writing: '写作',
};

function cloneSerialWorkflow(workflow) {
  if (!workflow || typeof workflow !== 'object' || Array.isArray(workflow)) return null;
  return JSON.parse(JSON.stringify(workflow));
}

// AI 编排模式（2026-10-04）：只存静态身份与设置；进度账本在 task-docs/<群>/orchestration/。
function cloneOrchestration(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.enabled !== true) return null;
  return JSON.parse(JSON.stringify(value));
}

function ensureStableSlotSpecs(slotSpecs, subSessions) {
  const count = Array.isArray(subSessions) ? subSessions.length : 0;
  const specs = Array.isArray(slotSpecs) ? slotSpecs.map(spec => ({ ...(spec || {}) })) : [];
  const used = new Set();
  let nextMemberNumber = Math.max(0, ...specs.map(spec => {
    const match = /^m(\d+)$/.exec(String(spec && spec.memberId || ''));
    return match ? Number(match[1]) : 0;
  })) + 1;
  for (let index = 0; index < count; index += 1) {
    if (!specs[index]) specs[index] = {};
    let memberId = typeof specs[index].memberId === 'string' ? specs[index].memberId.trim() : '';
    if (!memberId || used.has(memberId)) {
      while (used.has(`m${nextMemberNumber}`)) nextMemberNumber += 1;
      memberId = `m${nextMemberNumber}`;
      nextMemberNumber += 1;
    }
    specs[index].memberId = memberId;
    used.add(memberId);
  }
  return specs;
}

class MeetingRoomManager {
  constructor() {
    this.meetings = new Map();
    // 各模式独立计数,跨模式不共享
    this._counters = { general: 0, research: 0, dev: 0, writing: 0 };
  }

  createMeeting(opts = {}) {
    const id = uuid();
    const mode = MODE_TITLE_PREFIX[opts.mode] ? opts.mode : 'general';
    const titlePrefix = 'AI 群聊';
    const seq = ++this._counters[mode];
    // meeting-create-modal（2026-05-05 maintainer）：用户在 Modal 房名输入框填了非空字符串
    //   则用用户的（trim 后），否则走默认编号 title。modal 留空 = undefined，向后兼容。
    const customTitle = typeof opts.title === 'string' ? opts.title.trim() : '';
    const userRenamed = customTitle ? true : !!opts.userRenamed;
    const meeting = {
      id,
      type: 'meeting',
      title: customTitle || `${titlePrefix} #${seq}`,
      userRenamed,
      autoTitlePending: opts.autoTitlePending !== undefined ? !!opts.autoTitlePending : !userRenamed,
      autoTitleGenerated: !!opts.autoTitleGenerated,
      subSessions: [],
      layout: 'focus',
      focusedSub: null,
      syncContext: false,
      sendTarget: 'all',
      createdAt: Date.now(),
      lastMessageTime: Date.now(),
      lastCompletedAt: null,
      pinned: false,
      bottomed: false,
      status: 'idle',
      lastScene: 'free_discussion',
      scene: MEETING_MODES.includes(mode) ? mode : 'general',
      covenantText: '',
      groupChat: true,
      groupMode: typeof opts.groupMode === 'string' ? opts.groupMode : 'deliberation',
      groupRecentRawN: Number.isInteger(opts.groupRecentRawN) ? opts.groupRecentRawN : 5,
      completionNotificationEnabled: opts.completionNotificationEnabled === true,
      workspace: typeof opts.workspace === 'string' ? opts.workspace : null,
      workspaceLabel: typeof opts.workspaceLabel === 'string' ? opts.workspaceLabel : null,
      // meeting-create-modal（2026-05-01）：用户在 Modal 选定的 slots 列表，
      //   形如 [{ index, kind, model }, ...]。subSessions 数组顺序与 slot index 同步，
      //   slotSpecs 保留 kind/model 是为了"再来一次"或诊断信息。
      slotSpecs: Array.isArray(opts.slotSpecs) ? ensureStableSlotSpecs(opts.slotSpecs, opts.slotSpecs) : null,
      mode: 'free',
      // free-mode（2026-05-04）：自由模式参与者 slot 列表，默认全员勾选
      participants: Array.isArray(opts.participants) ? opts.participants.slice() : [0, 1, 2],
      serialWorkflow: cloneSerialWorkflow(opts.serialWorkflow),
      orchestration: cloneOrchestration(opts.orchestration),
    };
    // Hub Timeline phase 1 (in-memory only)
    meeting._timeline = [];
    meeting._cursors = {};
    meeting._nextIdx = 0;
    this.meetings.set(id, meeting);
    return { ...meeting, slotSpecs: meeting.slotSpecs ? meeting.slotSpecs.slice() : null };
  }

  // free-mode（2026-05-04）：切换 meeting 级模式 'pilot' ⇄ 'free'。
  //   直接写回 Map 原始对象（getMeeting 返回浅拷贝，对其赋值不写回 Map）。
  //   切到 free 且 participants 未初始化 → 默认全选 [0,1,2]。
  setMeetingMode(meetingId, mode) {
    const m = this.meetings.get(meetingId);
    if (!m) return null;
    if (!['pilot', 'free'].includes(mode)) {
      throw new Error(`Invalid meeting mode: ${mode}`);
    }
    m.mode = mode;
    if (mode === 'free' && m.participants === null) {
      m.participants = [0, 1, 2];
    }
    meetingStore.markDirty(meetingId, {
      _timeline: m._timeline, _cursors: m._cursors, _nextIdx: m._nextIdx,
      slotSpecs: m.slotSpecs,
      mode: m.mode, participants: m.participants,
    });
    return { ...m, subSessions: [...m.subSessions], mode: m.mode, participants: Array.isArray(m.participants) ? [...m.participants] : null };
  }

  // free-mode（2026-05-04）：设置自由模式参与者列表。
  //   接受空数组（Q11=A：尊重用户清空）。
  setParticipants(meetingId, participants) {
    const m = this.meetings.get(meetingId);
    if (!m) return null;
    m.participants = Array.isArray(participants) ? participants : null;
    meetingStore.markDirty(meetingId, {
      _timeline: m._timeline, _cursors: m._cursors, _nextIdx: m._nextIdx,
      slotSpecs: m.slotSpecs,
      mode: m.mode, participants: m.participants,
    });
    return { ...m, subSessions: [...m.subSessions], mode: m.mode, participants: Array.isArray(m.participants) ? [...m.participants] : null };
  }

  // meeting-create-modal（2026-05-01）：Modal 创建完所有 slot 后调用，
  //   把 slot 规格写到 meeting + 触发 timeline JSON 落盘。
  setSlotSpecs(meetingId, slotSpecs) {
    const m = this.meetings.get(meetingId);
    if (!m) return null;
    m.slotSpecs = Array.isArray(slotSpecs) ? slotSpecs.slice() : null;
    meetingStore.markDirty(meetingId, {
      _timeline: m._timeline, _cursors: m._cursors, _nextIdx: m._nextIdx,
      slotSpecs: m.slotSpecs,
    });
    return { ...m, subSessions: [...m.subSessions], slotSpecs: m.slotSpecs ? m.slotSpecs.slice() : null };
  }

  getMeeting(id) {
    const m = this.meetings.get(id);
    return m ? {
      ...m,
      subSessions: [...m.subSessions],
      _timeline: [...m._timeline],
      _cursors: { ...m._cursors },
      slotSpecs: Array.isArray(m.slotSpecs) ? m.slotSpecs.slice() : null,
      // 2026-05-05 maintainer：fallback 从 'pilot' 改 'free'（与新建路径一致），主驾入口废弃。
      mode: ['pilot', 'free'].includes(m.mode) ? m.mode : 'free',
      groupChat: !!m.groupChat,
      groupMode: m.groupMode || 'deliberation',
      groupRecentRawN: Number.isInteger(m.groupRecentRawN) ? m.groupRecentRawN : 5,
      userRenamed: !!m.userRenamed,
      autoTitlePending: !!m.autoTitlePending,
      autoTitleGenerated: !!m.autoTitleGenerated,
      participants: Array.isArray(m.participants) ? [...m.participants] : null,
      serialWorkflow: cloneSerialWorkflow(m.serialWorkflow),
      orchestration: cloneOrchestration(m.orchestration),
    } : null;
  }

  getAllMeetings() {
    return Array.from(this.meetings.values()).map(m => ({
      ...m,
      subSessions: [...m.subSessions],
      _timeline: [...m._timeline],
      _cursors: { ...m._cursors },
      slotSpecs: Array.isArray(m.slotSpecs) ? m.slotSpecs.slice() : null,
      // 2026-05-05 maintainer：fallback 从 'pilot' 改 'free'（与新建路径一致），主驾入口废弃。
      mode: ['pilot', 'free'].includes(m.mode) ? m.mode : 'free',
      groupChat: !!m.groupChat,
      groupMode: m.groupMode || 'deliberation',
      groupRecentRawN: Number.isInteger(m.groupRecentRawN) ? m.groupRecentRawN : 5,
      userRenamed: !!m.userRenamed,
      autoTitlePending: !!m.autoTitlePending,
      autoTitleGenerated: !!m.autoTitleGenerated,
      participants: Array.isArray(m.participants) ? [...m.participants] : null,
      serialWorkflow: cloneSerialWorkflow(m.serialWorkflow),
      orchestration: cloneOrchestration(m.orchestration),
    }));
  }

  // Compact, read-only records for the development workbench. Do not copy the
  // full chat timeline into every snapshot, or let an unrelated damaged field
  // make all tasks disappear. Each workflow clone has its own error boundary.
  getDevWorkbenchRecord(id) {
    const m = this.meetings.get(id);
    if (!m || typeof m !== 'object') return null;
    let serialWorkflow = null, metadataError = '';
    try { serialWorkflow = cloneSerialWorkflow(m.serialWorkflow); }
    catch (error) { metadataError = '流程配置无法读取：' + error.message; }
    if (!Array.isArray(m.subSessions)) metadataError ||= '成员记录格式异常，请进入群聊检查';
    return {
      id, title: m.title, scene: m.scene, groupChat: !!m.groupChat,
      workspace: m.workspace, workspaceLabel: m.workspaceLabel,
      createdAt: m.createdAt, lastMessageTime: m.lastMessageTime, lastCompletedAt: m.lastCompletedAt,
      pinned: !!m.pinned, bottomed: !!m.bottomed && !m.pinned,
      slotSpecs: Array.isArray(m.slotSpecs) ? m.slotSpecs.map(s => s && { memberId: s.memberId, kind: s.kind }) : [],
      subSessions: Array.isArray(m.subSessions) ? m.subSessions.slice() : [],
      serialWorkflow, metadataError,
    };
  }

  getDevWorkbenchRecords() {
    return Array.from(this.meetings.keys(), id => this.getDevWorkbenchRecord(id)).filter(Boolean);
  }

  // Search indexing needs meeting metadata but must not clone every timeline
  // onto Electron's main thread for each query. The worker reads authoritative
  // timeline files itself; this compact snapshot only overlays live titles,
  // workspace labels and member identities.
  getSearchMetadata() {
    return Array.from(this.meetings.values()).map(m => ({
      id: m.id,
      title: m.title,
      scene: m.scene,
      workspace: m.workspace || null,
      workspaceLabel: m.workspaceLabel || null,
      subSessions: Array.isArray(m.subSessions) ? m.subSessions.slice() : [],
      slotSpecs: Array.isArray(m.slotSpecs) ? m.slotSpecs.slice() : null,
      groupChat: !!m.groupChat,
      lastMessageTime: typeof m.lastMessageTime === 'number' ? m.lastMessageTime : null,
      lastCompletedAt: typeof m.lastCompletedAt === 'number' ? m.lastCompletedAt : null,
      updatedAt: typeof m.updatedAt === 'number' ? m.updatedAt : null,
    }));
  }

  addSubSession(meetingId, sessionId) {
    const m = this.meetings.get(meetingId);
    if (!m) return null;
    if (m.subSessions.includes(sessionId)) {
      // Already a member: idempotent, cursor preserved (regardless of capacity)
      return { ...m, subSessions: [...m.subSessions], _timeline: [...m._timeline], _cursors: { ...m._cursors } };
    }
    if (!m.groupChat && m.subSessions.length >= 3) return null;
    m.subSessions.push(sessionId);
    if (!(sessionId in m._cursors)) {
      m._cursors[sessionId] = 0; // new join: see full history
    }
    m.lastMessageTime = Date.now();
    // T11 fix: persist cursor change so membership/cursors survive restart.
    meetingStore.markDirty(meetingId, m);
    return { ...m, subSessions: [...m.subSessions], _timeline: [...m._timeline], _cursors: { ...m._cursors } };
  }

  removeSubSession(meetingId, sessionId) {
    const m = this.meetings.get(meetingId);
    if (!m) return null;
    m.subSessions = m.subSessions.filter(id => id !== sessionId);
    delete m._cursors[sessionId];
    if (m.focusedSub === sessionId) m.focusedSub = m.subSessions[0] || null;
    if (m.sendTarget === sessionId) m.sendTarget = 'all';
    // T11 fix: persist cursor removal so stale cursors don't reappear after restart.
    meetingStore.markDirty(meetingId, m);
    return { ...m, subSessions: [...m.subSessions], _timeline: [...m._timeline], _cursors: { ...m._cursors } };
  }

  updateMeeting(meetingId, fields) {
    const m = this.meetings.get(meetingId);
    if (!m) return null;
    if (fields.scene && !MEETING_MODES.includes(fields.scene)) {
      throw new Error(`Invalid scene value: '${fields.scene}'. Allowed: ${MEETING_MODES.join(', ')}`);
    }
    const allowed = [
      'title', 'layout', 'focusedSub', 'syncContext', 'sendTarget', 'pinned', 'bottomed',
      'lastMessageTime', 'lastCompletedAt', 'status', 'lastScene', 'scene', 'covenantText',
      'userRenamed', 'autoTitlePending', 'autoTitleGenerated',
      'serialWorkflow', 'workspace', 'workspaceLabel',
      'completionNotificationEnabled', 'orchestration',
    ];
    for (const key of allowed) {
      if (key in fields) {
        m[key] = key === 'serialWorkflow' ? cloneSerialWorkflow(fields[key])
          : key === 'orchestration' ? cloneOrchestration(fields[key]) : fields[key];
      }
    }
    // Placement is a three-state choice: top / normal / bottom.  Normalize at
    // the authoritative manager too, so non-renderer callers cannot persist an
    // impossible meeting that is both pinned and bottomed.
    if (fields.pinned === true) m.bottomed = false;
    else if (fields.bottomed === true) m.pinned = false;
    // 串行工作流配置变更必须落盘（updateMeeting 默认不 markDirty）；传完整 meeting 快照，
    //   避免新群聊首次 markDirty 时 prev 残缺导致 title/subSessions 被默认值覆盖。
    if ('serialWorkflow' in fields || 'workspace' in fields || 'workspaceLabel' in fields
        || 'lastMessageTime' in fields || 'lastCompletedAt' in fields
        || 'completionNotificationEnabled' in fields || 'orchestration' in fields
        || 'pinned' in fields || 'bottomed' in fields) {
      meetingStore.markDirty(meetingId, m);
    }
    return {
      ...m,
      subSessions: [...m.subSessions],
      serialWorkflow: cloneSerialWorkflow(m.serialWorkflow),
      orchestration: cloneOrchestration(m.orchestration),
    };
  }

  closeMeeting(meetingId) {
    const m = this.meetings.get(meetingId);
    if (!m) return null;
    const subIds = [...m.subSessions];
    this.meetings.delete(meetingId);
    // T12 fix: cancel any pending dirty flush before deleting file,
    // otherwise the 5s timer would resurrect the deleted file as a "ghost"
    meetingStore.cancelDirty(meetingId);
    meetingStore.deleteMeetingFile(meetingId);
    return subIds;
  }

  restoreMeeting(meetingData) {
    if (!meetingData || !meetingData.id) return;
    // 向后兼容：从旧的 researchMode/legacy meeting 字段推断 scene
    let scene = meetingData.scene;
    if (!scene) {
      if (meetingData.researchMode) {
        scene = 'research';
      } else if (typeof meetingData.title === 'string') {
        // 2026-05-05 maintainer：title 兜底推断 — 历史 bug：renderer schedulePersist 漏 scene
        //   字段写残 state.json，重启后所有 AI 群聊退化为 general（含投研，丢 ResearchAgent MCP）。
        //   schedulePersist 已修但既有 state.json 字段已丢，按 title 前缀推断兜底。
        //   匹配新前缀 "投研" / "开发" / "通用" 与历史前缀。
          if (meetingData.title.includes('开发')) scene = 'dev';
        else scene = 'general';
      } else {
        scene = 'general';
      }
    } else if (scene === 'general' && typeof meetingData.title === 'string') {
      // 2026-05-05 maintainer：scene-title 不一致检测 — 上次 fix（line 上方）的 title 兜底
      //   只在 scene 字段缺失时生效，但用户既存 state.json 里 scene 已被旧版错写为 'general'，
      //   兜底救不到。补一道：scene='general' 但 title 含 '投研'/'开发' 视为旧版数据迁移
      //   遗留的不一致 → 强制按 title 修正。新建 AI 群聊不会触发（title 由 createMeeting 按
      //   scene 一致生成）；用户极罕见地把通用群聊起名"投研笔记"会被误判，但权衡正确率优先。
      if (meetingData.title.includes('开发')) scene = 'dev';
    }
    // 标记 mutate 入参，让调用方（main.js boot 时 stateStore.save(bootMeetings)）写盘的
    //   meetings 数组也带上修正后的 scene —— 否则 boot 时 save 用原始 bootMeetings 会把
    //   修正前的 'general' 写回 state.json，下次重启又重复迁移、永不收敛。
    meetingData.scene = scene;
    meetingData.slotSpecs = ensureStableSlotSpecs(meetingData.slotSpecs, meetingData.subSessions || []);
    const restoredTitle = meetingData.title || '会议室';
    const restoredUserRenamed = !!meetingData.userRenamed;
    const restoredAutoTitleGenerated = !!meetingData.autoTitleGenerated;
    const restoredAutoTitlePending = meetingData.autoTitlePending !== undefined
      ? !!meetingData.autoTitlePending
      : (!restoredUserRenamed && !restoredAutoTitleGenerated && /^(?:通用|投研|开发|AI 群聊) #\d+$/.test(restoredTitle));
    this.meetings.set(meetingData.id, {
      id: meetingData.id,
      type: 'meeting',
      title: restoredTitle,
      workspace: typeof meetingData.workspace === 'string' ? meetingData.workspace : null,
      workspaceLabel: typeof meetingData.workspaceLabel === 'string' ? meetingData.workspaceLabel : null,
      userRenamed: restoredUserRenamed,
      autoTitlePending: restoredAutoTitlePending,
      autoTitleGenerated: restoredAutoTitleGenerated,
      subSessions: meetingData.subSessions || [],
      layout: meetingData.layout || 'focus',
      focusedSub: meetingData.focusedSub || null,
      syncContext: !!meetingData.syncContext,
      sendTarget: meetingData.sendTarget || 'all',
      createdAt: meetingData.createdAt || Date.now(),
      lastMessageTime: meetingData.lastMessageTime || Date.now(),
      lastCompletedAt: typeof meetingData.lastCompletedAt === 'number'
        ? meetingData.lastCompletedAt
        : null,
      pinned: !!meetingData.pinned,
      bottomed: !!meetingData.bottomed && !meetingData.pinned,
      status: 'dormant',
      lastScene: meetingData.lastScene || 'free_discussion',
      scene,
      covenantText: meetingData.covenantText || meetingData['general' + 'Round' + 'tableCovenant'] || '',
      groupChat: true,
      groupMode: meetingData.groupMode || 'deliberation',
      groupRecentRawN: Number.isInteger(meetingData.groupRecentRawN) ? meetingData.groupRecentRawN : 5,
      completionNotificationEnabled: meetingData.completionNotificationEnabled === true,
      // meeting-create-modal（2026-05-01）：从 state.json 还原 slot 规格；
      //   老 meeting 没有此字段时为 null，渲染逻辑会按 subSessions 顺序兜底分配 slot。
      slotSpecs: meetingData.slotSpecs.slice(),
      // 2026-05-05 maintainer：BUG fix —— 旧版兜底 'pilot' 导致 free 模式 AI 群聊重启后被错误改成主驾。
      //   主驾入口已废弃，所有未识别 mode 一律 fallback 'free'。同时强制把老 meeting 的 mode='pilot'
      mode: 'free',
      // free-mode（2026-05-04）：null=首次未初始化，空数组=用户已清空（Q11=A）
      participants: Array.isArray(meetingData.participants) ? meetingData.participants : null,
      // 串行工作流配置（2026-06-17 maintainer）：重启恢复
      serialWorkflow: cloneSerialWorkflow(meetingData.serialWorkflow),
      orchestration: cloneOrchestration(meetingData.orchestration),
      _timeline: [],
      _cursors: {},
      _nextIdx: 0,
    });
    // 按 scene + title 末尾 #N 数字推断恢复到哪个 counter,避免新建撞号。
    // 老格式 "会议室-N" / "主驾会议 #N" 不匹配新规则,跳过。
    const restoredMode = scene;
    const seqMatch = (meetingData.title || '').match(/#(\d+)\s*$/);
    const seq = seqMatch ? parseInt(seqMatch[1], 10) : 0;
    if (restoredMode && seq > 0 && seq > this._counters[restoredMode]) {
      this._counters[restoredMode] = seq;
    }
  }

  loadTimelineLazy(meetingId) {
    const m = this.meetings.get(meetingId);
    if (!m) return false;
    // Already loaded?
    if (m._timeline.length > 0 || m._nextIdx > 0) return true;
    const data = meetingStore.loadMeetingFile(meetingId);
    if (!data) return false;
    m._timeline = Array.isArray(data._timeline) ? data._timeline : [];
    m._cursors = (data._cursors && typeof data._cursors === 'object') ? data._cursors : {};
    m._nextIdx = typeof data._nextIdx === 'number' ? data._nextIdx : m._timeline.length;
    // 兜底回填 slotSpecs（state.json 已写过的不覆盖）
    if (!Array.isArray(m.slotSpecs) && Array.isArray(data.slotSpecs)) {
      m.slotSpecs = data.slotSpecs.slice();
    }
    // free-mode 兜底回填（2026-05-04）：per-meeting JSON 备份 mode/participants
    if (!['pilot', 'free'].includes(m.mode) && ['pilot', 'free'].includes(data.mode)) {
      m.mode = data.mode;
    }
    if (!Array.isArray(m.participants) && Array.isArray(data.participants)) {
      m.participants = data.participants;
    }
    if (!m.serialWorkflow && data.serialWorkflow && typeof data.serialWorkflow === 'object') {
      m.serialWorkflow = cloneSerialWorkflow(data.serialWorkflow);
    }
    if (!m.orchestration && data.orchestration && typeof data.orchestration === 'object') {
      m.orchestration = cloneOrchestration(data.orchestration);
    }
    return true;
  }

  appendTurn(meetingId, sid, text, ts) {
    const m = this.meetings.get(meetingId);
    if (!m) return null;
    if (typeof text !== 'string' || !text) return null;

    // Cap at 100KB to prevent OOM from runaway AI output
    const MAX = 100 * 1024;
    let safeText = text;
    if (safeText.length > MAX) {
      safeText = safeText.slice(0, MAX) + '...[truncated]';
    }

    // Dedupe: same sid+text within 2s = duplicate event from tap
    const lastTurn = m._timeline[m._timeline.length - 1];
    if (lastTurn && lastTurn.sid === sid && lastTurn.text === safeText
        && (ts - lastTurn.ts) < 2000) {
      return null;
    }

    const resolvedTs = ts != null ? ts : Date.now();
    const turn = { idx: m._nextIdx++, sid, text: safeText, ts: resolvedTs };
    m._timeline.push(turn);
    m.lastMessageTime = resolvedTs;
    m.lastCompletedAt = Math.max(Number(m.lastCompletedAt) || 0, resolvedTs);
    meetingStore.markDirty(meetingId, {
      _timeline: m._timeline,
      _cursors: m._cursors,
      _nextIdx: m._nextIdx,
      lastMessageTime: m.lastMessageTime,
      lastCompletedAt: m.lastCompletedAt,
    });
    return { ...turn };
  }

  getTimeline(meetingId) {
    const m = this.meetings.get(meetingId);
    if (!m) return [];
    return m._timeline.map(t => ({ ...t }));
  }

  getCursor(meetingId, sid) {
    const m = this.meetings.get(meetingId);
    if (!m) return null;
    if (!(sid in m._cursors)) return null;
    return m._cursors[sid];
  }

  advanceCursor(meetingId, sid, newPos) {
    const m = this.meetings.get(meetingId);
    if (!m) return false;
    if (!(sid in m._cursors)) return false;
    if (newPos < m._cursors[sid]) return false; // monotonic
    if (newPos > m._timeline.length) newPos = m._timeline.length;
    m._cursors[sid] = newPos;
    meetingStore.markDirty(meetingId, { _timeline: m._timeline, _cursors: m._cursors, _nextIdx: m._nextIdx });
    return true;
  }

  incrementalContext(meetingId, targetSid) {
    const m = this.meetings.get(meetingId);
    if (!m || !(targetSid in m._cursors)) {
      return { turns: [], advancedTo: 0 };
    }
    const fromIdx = m._cursors[targetSid];
    const newTurns = m._timeline
      .slice(fromIdx)
      // 'user' is a reserved literal sid; hubSessionIds are UUIDs — no collision
      // possible, so filtering on sid !== targetSid correctly excludes only the
      // target's own AI turns and never accidentally drops user turns.
      .filter(t => t.sid !== targetSid)
      .map(t => ({ ...t }));
    m._cursors[targetSid] = m._timeline.length;
    meetingStore.markDirty(meetingId, { _timeline: m._timeline, _cursors: m._cursors, _nextIdx: m._nextIdx });
    return { turns: newTurns, advancedTo: m._cursors[targetSid] };
  }
}

function isGroupChatCapableMeeting(meeting) {
  return !!(meeting && meeting.scene);
}

function isSlotParticipatingThisTurn(meeting, slotIndex) {
  if (!meeting) return true;
  if (!Array.isArray(meeting.participants)) return true;
  return meeting.participants.includes(slotIndex);
}

module.exports = {
  MeetingRoomManager,
  ensureStableSlotSpecs,
  isGroupChatCapableMeeting,
  isSlotParticipatingThisTurn,
  MEETING_MODES,
};
