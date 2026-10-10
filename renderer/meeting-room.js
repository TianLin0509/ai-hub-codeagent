// renderer/meeting-room.js
// Meeting Room UI — manages the parallel terminal panel.
// Exposes global `MeetingRoom` object consumed by renderer.js.
// T2（2026-05-04 maintainer）：底部 module.exports 暴露 _isPartialUnchanged 给 Node unit test，
//   require 时 typeof document === 'undefined' → IIFE 体内大量 DOM/IPC 引用会爆，故 IIFE 只在 renderer 浏览器环境跑。

const { groupInputTuningFrame } = require('./command-screen-frame');

if (typeof document !== 'undefined') (function () {
  async function copyGroupText(text) {
    const result = await clipboardController.copyText(text,{source:'group-card',silent:true});
    if (!result.ok) throw new Error(result.reason || '复制失败');
  }
  const { ipcRenderer } = require('electron');
  const { speedControl } = require('../core/session-speed.js');
  const { isSlotParticipatingThisTurn } = require('../core/meeting-room.js');
  const { extractVisibleCardText } = require('./visible-card-text.js');
  const { unclaimedPendingUserMessages } = require('../core/groupchat-pending-claim.js');
  const { formatBeijingClock } = require('../core/beijing-time.js');
  const { buildSessionStatusSummary } = require('../core/session-status-summary.js');
  const { buildTurnPresentation, normalizeToolActivity } = require('../core/turn-presentation.js');
  const {
    acceptGroupChatEvent,
    noteGroupChatSnapshot,
    resetGroupChatRevision,
  } = require('./groupchat-event-revision.js');
  const {
    guardMarkdownLocalPaths,
    restoreMarkdownLocalPaths,
  } = require('./markdown-local-path-guard.js');
  const {
    splitDispatchPrompt,
    collapsedTitle: dispatchCollapsedTitle,
    recipientText: dispatchRecipientText,
    attemptText: dispatchAttemptText,
    isDispatchCard,
  } = require('./dispatch-card.js');
  // 开发群聊「先讨论再开工」的阶段判断与收敛文本，和主进程 dispatcher 共用同一份。
  const DevDiscuss = require('../core/dev-discuss.js');
  const DevFile = require('../core/dev-file-workflow.js');
  const GroupAnswers = require('../core/group-answer-files.js');
  const Delivery = require('../core/delivery-workflow.js');
  const DeliveryControls = require('./delivery-workflow-controls.js');
  const Conversation = require('../core/conversation-workflow.js');
  const ConversationControls = require('./conversation-workflow-controls.js');
  const ConversationRelay = require('./conversation-relay.js');
  const OrchUI = require('./orchestration-ui.js');
  OrchUI.init(meetingId => {
    const m = meetingData[meetingId];
    if (!m || activeMeetingId !== meetingId) return;
    _updateInputPreflight(m);
    void refreshGroupChatPanel(m);
  });
  const Recipients = require('../core/groupchat-recipients.js');
  const SourceFinal = require('../core/groupchat-source-final.js');
  const _devFileStates = {}, _devFileRequests = new Set();
  ipcRenderer.on('groupchat-user-supplement',(_e,event)=>{
    const m=meetingData[event?.meetingId];
    if(m && m.id===activeMeetingId)void refreshGroupChatPanel(m);
  });
  ipcRenderer.on('dev-file:changed', (_e, state) => {
    if (!state?.meetingId) return;
    _devFileStates[state.meetingId] = state;
    const m = meetingData[state.meetingId];
    if (m && Array.isArray(state.participants)) m.participants = state.participants;
    if (m && activeMeetingId === m.id) { renderToolbar(m); _updateInputPreflight(m); }
  });
  // isPasteSensitive 不再在本文件用：paste 敏感性的判断已经下沉到主进程的
  //   session:send-prompt 闭环里（main/ipc/prompt-submit-handlers.js）。
  const { kindRegexAlternation, KIND_LABELS, ALL_AI_KINDS, getKindLabel,
          SLOT_IDS, SLOT_DISPLAY, getSlotPromptName, getSlotDisplayLabel,
          slotIdRegexAlternation, slotIdToIndex, slotIndexToId } = require('../core/ai-kinds.js');
  const {
    avatarBySlot: _avatarBySlot,
    avatarFallbackBySlot: _avatarFallbackBySlot,
    avatarFallbackFor: _avatarFallbackFor,
    avatarSrcFor: _avatarSrcFor,
    escapeHtml,
    formatThinkTime: _formatThinkTime,
    formatTokens: _formatTokens,
    ftCtxClass: _ftCtxClass,
  } = require('./meeting-room-format.js');

  let activeMeetingId = null;
  let meetingData = {};
  // Member resume pushes session-created after the room has already rendered
  // dormant avatars. Refresh availability from that authoritative lifecycle,
  // independently of meeting metadata and model/usage notifications.
  for (const channel of ['session-created', 'session-updated', 'session-suspended', 'session-closed']) {
    ipcRenderer.on(channel, (_event, payload) => {
      const sid = payload?.session?.id || payload?.sessionId;
      queueMicrotask(() => { if (sid) refreshSessionMetrics(sid); });
    });
  }
  let memberSplit = null;
  const overviewScroll = new Map();
  const memberRuntimeState = session => session?.agentRuntime === 'pty'
    ? require('../core/session-runtime-truth.js').getSessionRuntimeTruth(session).state
    : session?.nativeRuntime?.state;
  function ensureMemberSplit() {
    if (memberSplit) return memberSplit;
    memberSplit = require('./group-member-split').createGroupMemberSplit({ document,
      host: panelEl(), before: document.getElementById('mr-toolbar'),
      services: {
        members: meeting => _getGcSlots(meeting).filter(Boolean).map(slot => ({ ...slot, label: slot.displayLabel || slot.label || getKindLabel(slot.kind) })),
        session: sid => sessions.get(sid), logo: kind => _groupLogoSrc(kind),
        // PTY 成员没有原生快照：状态与「是否在跑」取权威状态，否则停止按钮永远灰着、状态显示英文原值。
        status: session => session?.status === 'dormant' ? '休眠' : ({ running:'正在输出', starting:'正在开始', waiting:'等待确认', completed:'已完成', failed:'失败', interrupted:'已停止', idle:'待命' }[memberRuntimeState(session)]
          || (session?.agentRuntime === 'pty' ? '待命' : session?.status) || '等待连接'),
        running: session => ['running','waiting'].includes(memberRuntimeState(session)) || session?.status === 'working'
          || (session?.agentRuntime === 'pty' && memberRuntimeState(session) === 'starting'),
        createView: (sid, panel) => createSecondarySessionView(sid, panel, { groupMember: true }),
        async resume(sid) { const result = await window.resumeDormantSession(sid); if (!result) throw new Error('未能恢复成员，请查看占用或连接提示'); },
        async stop(sid) {
          const session = sessions.get(sid);
          if (session?.agentRuntime === 'pty') {
            require('./pty-interrupt').sendPtyAgentInterrupt(session, { state: memberRuntimeState(session),
              send: data => ipcRenderer.send('terminal-input', { sessionId: sid, data }) });
            return;
          }
          if (!isNativeAgent(session)) { ipcRenderer.send('terminal-input', { sessionId: sid, data:'\x03' }); return; }
          const result = session.runtimeBackend === 'claude-stream-json'
            ? await ipcRenderer.invoke('claude-native:interrupt', { sessionId: sid })
            : await ipcRenderer.invoke('codex:native-action', { sessionId: sid, action:'interrupt' });
          if (!result?.ok) throw new Error(result?.error || result?.message || '停止未确认');
        },
        onMode: mode => {
          document.querySelectorAll('[data-group-layout]').forEach(el => el.setAttribute('aria-pressed', String(el.dataset.groupLayout === mode)));
        },
      },
    });
    return memberSplit;
  }
  function setGroupLayout(mode, meeting) {
    if (!meeting?.groupChat || meeting.id !== activeMeetingId) return;
    const split = ensureMemberSplit(), panel = document.getElementById('mr-group-chat-panel');
    if (mode === 'two' && split.mode() !== 'two') overviewScroll.set(meeting.id, _captureGroupChatScroll(panel, meeting));
    split.setMode(mode);
    if (mode === 'overview') {
      _renderActivePanelFromCache(meeting);
      _restoreGroupChatScroll(panel, overviewScroll.get(meeting.id));
    }
  }

  // IF-C1（2026-05-01）：CLI ready 状态 cache（per-sid bool），由 cli-ready-status IPC 1s 轮询填充
  //   驱动 isInitializing 判断（修 P0 阻塞 bug B：原 markerStatus 永远 'none' 导致永久卡"创建中"）
  let _cliReadyCache = {};
  let _cliReadyPollTimer = null;
  let _cliReadyPollInFlight = null;
  // IF-C3（2026-05-01）：banner dismiss 状态记录 — meetingId，dismiss 后同会议不再显示，
  //   关闭会议（closeMeetingPanel）会重置，下次进同会议又显示
  let _bannerDismissedFor = null;
  // IF-C7（2026-05-03）：未 ready 数量上次值，用于"新增未 ready 项时撤销 dismiss"
  let _lastNotReadyCount = 0;
  const _tabState = {};     // { sessionId: 'streaming'|'new-output'|'idle'|'error' }
  const _tabTimers = {};    // { sessionId: silenceTimerId }

  // renderer.js loads before us — its `sessions` and `getOrCreateTerminal`
  // are accessible via the global lexical scope. We access them directly.

  // 所有场景(general/research)在 UI 渲染上完全一致(卡片+CLI)。
  // 与 core/meeting-room.js 的 isGroupChatCapableMeeting 语义一致。
  function _isPanelCapableMeeting(m) {
    return !!(m && m.scene);
  }

  // --- Group chat @command parser ---
  // 摘要功能 2026-05-08 整体下线：原 @summary @<slot> 命令路径已删
  // 现仅支持 @m1 / @all / @<slot>（@<slot> 仅用于剥前缀，仍走 fanout）
  const _RT_SLOT_ALT = slotIdRegexAlternation();
  const _tokenRe = new RegExp('^@(' + _RT_SLOT_ALT + ')\\b\\s*', 'i');
  // --- Group Chat Mode: 持久化 AI 群聊面板（始终显示当前状态 + 历史）---
  // Phase 5(2026-05-05 maintainer): 时光机模式状态 — _gcViewingTurnN[meetingId] = N 表示正在查看第 N 轮历史。
  //   null / undefined = 默认查看最新轮(实时模式), 数字 = 查看第 N 轮(只读历史模式)。
  //   切换由 stepper dot click 触发 → 重渲 panel + _renderSlotCard 拿 turn.by[sid] 渲染历史内容。
  const _gcViewingTurnN = {};

  // _gcPanelState[meetingId] 缓存渲染状态，避免 IPC 频繁调用
  // partialBy: 当前进行中轮次的部分回答 { sid: { text, status } } — 单家完成立即更新
  const _gcPanelState = {};

  // [幕次折叠] meetingId -> Set(actKey) 当前被折叠的幕次（前端临时状态，不持久化；刷新后默认全展开）。
  const _gcCollapsedActs = {};
  const _gcToolsExpanded = {};

  // T3（2026-05-04 maintainer）：抽屉实时订阅状态。打开时设 { sid, mid, kind }，关时清 null。
  //   partial-update handler 命中同 sid + 用户当前 active 的是 live tab 时，更新抽屉内容。
  let _gcTimelineLive = null;
  // T3 fix（2026-05-04 maintainer）：上一次抽屉的清理函数，开新抽屉前先调，避免 escHandler 累积绑定 + 闭包内存泄漏。
  let _gcTimelineCleanup = null;
  // pilot redesign（2026-05-02）：_privateCountCache 已废弃（AI 群聊不再桥接子会话私聊）
  const _thinkStartTs = {};
  let _thinkTimer = null;
  // F0 Phase 1(2026-05-04 maintainer): 卡片聚焦态全局状态。null = 默认态; sid = 该卡聚焦中。
  //   触发: click 任一 .mr-ft → 进入; 再次 click 同卡 / Esc / 点空白 → 退出。
  //   退出后 meeting.focusedSub 不变(主显仍是该 sid)。
  let _gcFocusedCardSid = null;

  // F5 Phase 3(2026-05-04 maintainer / spec F5 简化版): 整轮总耗时
  //   原本 token + 成本估算因 transcript-tap 仅 GeminiTap 提供 token 数据,
  //   Claude/Codex/DeepSeek 等的 token/cost 显示 "--", 用户视觉上无价值。
  //   决定: 仅保留总耗时显示。token/cost 留给后续 transcript-tap 扩展后再启用。

  // F7 Phase 3 全员完成通知（Web Notification + title 闪烁）已废弃。
  //   2026-05-05 maintainer 修3：改用侧栏 unread 机制（renderer.js 监听 turn-complete IPC，
  //   非 active AI 群聊累加 meeting.unreadCount → renderSessionList 渲染 has-unread + ⏸ 等你 badge），
  //   与普通 session 的提醒哲学一致，不再用 Web Notification / title 闪烁打扰用户。

  const _CARD_VIEW_MODE_KEY = 'mr-card-view-mode';
  function _getCardViewMode() {
    try {
      const mode = typeof localStorage !== 'undefined' ? localStorage.getItem(_CARD_VIEW_MODE_KEY) : null;
      return mode === 'tab' ? 'tab' : 'parallel';
    } catch { return 'parallel'; }
  }
  function _isCardTabMode() {
    return _getCardViewMode() === 'tab';
  }
  function _applyCardViewModeClass(mode) {
    document.body.classList.toggle('mr-card-tab-mode', mode === 'tab');
  }
  function _setCardViewMode(mode, meeting) {
    const next = mode === 'tab' ? 'tab' : 'parallel';
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem(_CARD_VIEW_MODE_KEY, next);
      }
    } catch {}
    _applyCardViewModeClass(next);
    if (next === 'tab') {
      _clearCompareSelect();
      _gcFocusedCardSid = null;
      document.body.classList.remove('mr-card-focus-on');
      const m = meeting || (activeMeetingId && meetingData[activeMeetingId]);
      if (m && !m.focusedSub && Array.isArray(m.subSessions) && m.subSessions[0]) {
        m.focusedSub = m.subSessions[0];
      }
    }
    const active = meeting || (activeMeetingId && meetingData[activeMeetingId]);
    if (active && _isPanelCapableMeeting(active)) refreshGroupChatPanel(active);
    if (typeof _relayoutMeetingRoom === 'function') {
      setTimeout(() => _relayoutMeetingRoom(), 260);
    }
  }
  _applyCardViewModeClass(_getCardViewMode());

  const _GROUP_SIDE_STATE_KEY = 'mr-group-chat-side-state';
  function _getGroupSideCollapsed() {
    // 普通聊天优先保证消息阅读宽度；用户显式展开后记住选择。
    try {
      const state = typeof localStorage !== 'undefined' ? localStorage.getItem(_GROUP_SIDE_STATE_KEY) : null;
      return state !== 'expanded';
    } catch { return true; }
  }
  function _setGroupSideCollapsed(collapsed, meeting) {
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem(_GROUP_SIDE_STATE_KEY, collapsed ? 'collapsed' : 'expanded');
      }
    } catch {}
    const active = meeting || (activeMeetingId && meetingData[activeMeetingId]);
    if (active && _isPanelCapableMeeting(active)) refreshGroupChatPanel(active);
    if (typeof _relayoutMeetingRoom === 'function') {
      setTimeout(() => _relayoutMeetingRoom(), 120);
    }
  }

  function _renderActivePanelFromCache(meeting, opts = {}) {
    const active = meeting || (activeMeetingId && meetingData[activeMeetingId]);
    if (!active || active.id !== activeMeetingId || !_isPanelCapableMeeting(active)) return false;
    const state = _gcPanelState[active.id];
    if (!state) return false;
    const panel = _ensureGcPanel();
    const forceGroupChatBottom = !!opts.forceGroupChatBottom && !!active.groupChat;
    const groupScroll = forceGroupChatBottom
      ? { scrollTop: 0, stickToBottom: true }
      : _captureGroupChatScroll(panel, active);
    try {
      _renderGcPanelInto(panel, active, state, {
        scroll: groupScroll,
        restoreOpts: { forceBottom: forceGroupChatBottom },
        forceMeetingBottom: opts.forceMeetingBottom === true,
      });
      return true;
    } catch (e) {
      console.error('[groupchat] cached panel render failed:', e);
      return false;
    }
  }

  function _renderGcPanelInto(panel, meeting, state, opts = {}) {
    if (!panel || !meeting || !state) return false;
    if (meeting.id === activeMeetingId && memberSplit?.mode() === 'two') { memberSplit.refresh(meeting); return true; }
    // Pending and completed articles have different IDs. Bind disclosure to
    // the provider activity item so the same response survives that handoff.
    const activityKey = el => el.closest('.mr-gc-msg')?.dataset.sourceSid + ':'
      + el.querySelector('[data-message-id]')?.dataset.messageId;
    const activityOpen = new Map(panel.__mrGcMeeting?.id === meeting.id
      ? [...panel.querySelectorAll('.conversation-header-activity')].map(el =>
        [activityKey(el), [el, ...el.querySelectorAll('details')].map(d => d.open)]) : []);
    const deliveryOpen = new Map([...panel.querySelectorAll('.mr-gc-msg .turn-delivery-summary')]
      .map(el => [el.closest('.mr-gc-msg').dataset.gcMsgId, el.open]));
    panel.querySelector('.mr-gc-messages')?._cardFollowController?.dispose();
    panel._questionDirectory?.dispose();
    panel.innerHTML = _renderGcPanelHtml(state, meeting);
    for (const el of panel.querySelectorAll('.conversation-header-activity')) {
      const open = activityOpen.get(activityKey(el));
      if (open) [el, ...el.querySelectorAll('details')].forEach((d,i) => { if (i < open.length) d.open = open[i]; });
    }
    for (const el of panel.querySelectorAll('.mr-gc-msg .turn-delivery-summary')) {
      const id = el.closest('.mr-gc-msg').dataset.gcMsgId;
      if (deliveryOpen.has(id)) el.open = deliveryOpen.get(id);
    }
    _bindGcPanelEvents(panel, meeting);
    // 2026-07-20 maintainer [修#5]：后处理四件套统一在此执行（此前只在 refreshGroupChatPanel）。
    _applyLongAnswerCollapse(panel);
    _setupScrollToBottom(panel);
    _setupQuestionDirectory(panel, meeting);
    _enhanceGroupCardContent(panel);
    _enhanceCodeBlocks(panel);
    panel._groupSelection?.sync();
    _setupGcSearch(panel);
    if (opts.scroll) {
      _restoreGroupChatScroll(panel, opts.scroll, opts.restoreOpts || {});
    }
    if (opts.forceMeetingBottom) {
      _scrollMeetingContentToBottom(panel, meeting);
    }
    return true;
  }

  // F3 Phase 2(2026-05-04 maintainer / spec F3): 多卡 Ctrl/Cmd+click 对比模式
  //   状态: Set<sid>。空 = 默认; ≥1 = 对比模式 (body.mr-card-compare-on)
  //   spec §5 状态优先级: compare-selected 与 focus 互斥(进入对比时清 focus)
  //   退出: Esc / 点空白 / 取消最后一张
  //   简化版: 仅视觉描边(蓝色 dashed)+ 邻居淡化, 不动 grid 重分配
  const _gcCompareSlots = new Set();
  function _toggleCompareSelect(sid) {
    if (!sid) return;
    if (_gcFocusedCardSid) {
      _gcFocusedCardSid = null;
      document.body.classList.remove('mr-card-focus-on');
    }
    if (_gcCompareSlots.has(sid)) _gcCompareSlots.delete(sid);
    else _gcCompareSlots.add(sid);
    _applyCompareVisual();
  }
  function _clearCompareSelect() {
    if (_gcCompareSlots.size === 0) return;
    _gcCompareSlots.clear();
    _applyCompareVisual();
  }
  function _applyCompareVisual() {
    document.querySelectorAll('.mr-ft[data-ft-sid]').forEach(card => {
      const cardSid = card.getAttribute('data-ft-sid');
      if (_gcCompareSlots.has(cardSid)) card.classList.add('compare-selected');
      else card.classList.remove('compare-selected');
    });
    if (_gcCompareSlots.size > 0) document.body.classList.add('mr-card-compare-on');
    else document.body.classList.remove('mr-card-compare-on');
  }

  // F6 Phase 3(2026-05-04 maintainer / spec F6): 选中文本引用 chip
  //   流程: mouseup 选中 .mr-ft-bottom 内文本 → 浮按钮 [💎 引用追问] → 加 chip 到输入框上方区
  //   提交时: chips 内容拼到 prompt 头部"基于以下引用追问:\n[💎 第N轮 X: \"...\"]\n用户问题: ..."
  //   清空: 提交后 / 切 meeting 时
  let _gcQuoteChips = [];     // [{ sid, slotIndex, slotLabel, turnN, text }]
  let _gcQuoteFloatBtn = null; // body 级浮按钮 DOM, lazy 创建

  function _renderQuoteChips() {
    const inputRow = document.getElementById('mr-input-row');
    if (!inputRow) return;
    let row = document.getElementById('mr-quote-chips-row');
    if (!row) {
      row = document.createElement('div');
      row.id = 'mr-quote-chips-row';
      row.className = 'mr-quote-chips-row';
      inputRow.parentNode.insertBefore(row, inputRow);
    }
    if (_gcQuoteChips.length === 0) {
      row.style.display = 'none';
      row.innerHTML = '';
      _updateInputPreflight(meetingData[activeMeetingId]);
      return;
    }
    row.style.display = '';
    row.innerHTML = _gcQuoteChips.map((c, i) => {
      const slotCls = (c.slotIndex >= 0 && c.slotIndex < 3) ? `slot-${c.slotIndex + 1}` : '';
      const truncated = c.text.length > 60 ? c.text.slice(0, 60) + '…' : c.text;
      return `<span class="mr-gc-quote-chip ${slotCls}" data-quote-idx="${i}">
        <span class="mr-gc-quote-label">💎 第${c.turnN}轮 ${escapeHtml(c.slotLabel)}</span>
        <span class="mr-gc-quote-text">"${escapeHtml(truncated)}"</span>
        <button class="mr-gc-quote-close" data-quote-close="${i}" title="移除此引用">✕</button>
      </span>`;
    }).join('');
    row.querySelectorAll('[data-quote-close]').forEach(btn => {
      btn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        const idx = parseInt(btn.getAttribute('data-quote-close'), 10);
        if (!isNaN(idx) && idx >= 0 && idx < _gcQuoteChips.length) {
          _gcQuoteChips.splice(idx, 1);
          _renderQuoteChips();
        }
      });
    });
    _updateInputPreflight(meetingData[activeMeetingId]);
  }

  function _addQuoteChip(meeting, sid, text, sourceTurn = null) {
    if (!sid || !text || !text.trim()) return;
    if (_gcQuoteChips.length >= 5) return;  // 最多 5 条引用 (避免 prompt 爆炸)
    const slots = _getGcSlots(meeting);
    const slotIndex = slots.findIndex(s => s && s.sid === sid);
    const slot = (slotIndex >= 0 && slotIndex < slots.length) ? slots[slotIndex] : null;
    if (!slot) return;
    const cached = _gcPanelState[meeting.id];
    const turnsArr = (cached && Array.isArray(cached.turns)) ? cached.turns : [];
    const turnN = Number(sourceTurn) || (turnsArr.length > 0 ? (turnsArr[turnsArr.length - 1].n || turnsArr.length) : 1);
    _gcQuoteChips.push({
      sid, slotIndex,
      slotLabel: slot.label || sid.slice(0, 8),
      turnN,
      text: text.trim(),  // Preserve the complete passage selected by the user.
    });
    _renderQuoteChips();
  }

  function _clearQuoteChips() {
    if (_gcQuoteChips.length === 0) return;
    _gcQuoteChips = [];
    _renderQuoteChips();
  }

  // mouseup 选区检测 + 浮按钮 (IIFE 顶层一次性挂)
  document.addEventListener('mouseup', function _gcQuoteSelHandler(ev) {
    if (!ev.target || typeof ev.target.closest !== 'function') return;
    const card = ev.target.closest('.mr-gc-msg.ai[data-source-sid], .mr-ft[data-ft-sid]');
    const hideBtn = () => { if (_gcQuoteFloatBtn) _gcQuoteFloatBtn.style.display = 'none'; };
    if (!card) { hideBtn(); return; }
    const sel = window.getSelection();
    const selText = sel ? sel.toString().trim() : '';
    if (!selText || selText.length < 2) { hideBtn(); return; }
    // 选区起点必须在卡片 bottom 区(.mr-ft-bottom)内 — 排除 row1/row2 状态文本被误选
    const anchorEl = sel.anchorNode && (sel.anchorNode.nodeType === 1 ? sel.anchorNode : sel.anchorNode.parentElement);
    const body = card.querySelector('.gc-journal-text, .mr-ft-bottom');
    const focusEl = sel.focusNode && (sel.focusNode.nodeType === 1 ? sel.focusNode : sel.focusNode.parentElement);
    if (!body || !body.contains(anchorEl) || !body.contains(focusEl)) { hideBtn(); return; }
    const sid = card.dataset.sourceSid || card.getAttribute('data-ft-sid');
    if (!sid) { hideBtn(); return; }
    let range; try { range = sel.getRangeAt(0); } catch { hideBtn(); return; }
    const rect = range.getBoundingClientRect();
    // lazy 创建浮按钮
    if (!_gcQuoteFloatBtn) {
      _gcQuoteFloatBtn = document.createElement('button');
      _gcQuoteFloatBtn.id = 'mr-gc-quote-float-btn';
      _gcQuoteFloatBtn.className = 'mr-gc-quote-float-btn';
      _gcQuoteFloatBtn.type = 'button';
      _gcQuoteFloatBtn.textContent = '💎 引用追问';
      _gcQuoteFloatBtn.title = '把选中文本作为引用加入下一轮 prompt (Phase 3 F6)';
      document.body.appendChild(_gcQuoteFloatBtn);
      _gcQuoteFloatBtn.addEventListener('mousedown', (e) => e.preventDefault()); // 防失焦清选区
      _gcQuoteFloatBtn.addEventListener('click', () => {
        const fSid = _gcQuoteFloatBtn.dataset.sid;
        const fText = _gcQuoteFloatBtn.dataset.text;
        const mid = activeMeetingId;
        const meeting = meetingData[mid];
        if (fSid && fText && meeting && _gcQuoteFloatBtn.dataset.meetingId === mid) {
          _addQuoteChip(meeting, fSid, fText, _gcQuoteFloatBtn.dataset.turn);
        }
        _gcQuoteFloatBtn.style.display = 'none';
        try { window.getSelection().removeAllRanges(); } catch {}
      });
    }
    _gcQuoteFloatBtn.dataset.meetingId = activeMeetingId;
    _gcQuoteFloatBtn.dataset.turn = card.dataset.readTurn || String(_gcViewingTurnN[activeMeetingId] || "");
    _gcQuoteFloatBtn.dataset.sid = sid;
    _gcQuoteFloatBtn.dataset.text = selText;
    _gcQuoteFloatBtn.style.display = 'inline-flex';
    // 选区右上方 + window scroll 偏移
    _gcQuoteFloatBtn.style.top = `${Math.max(8, rect.top + window.scrollY - 34)}px`;
    _gcQuoteFloatBtn.style.left = `${Math.max(8, Math.min(window.innerWidth - 120, rect.right + window.scrollX - 90))}px`;
  });

  // F0 + F3 Phase 1/2 + Phase 5: 全局 Esc — 退出聚焦/对比/时光机。IIFE 顶层挂载, 只挂一次。
  document.addEventListener('keydown', function _gcFocusEscHandler(ev) {
    if (ev.key !== 'Escape') return;
    // F6: Esc 也关闭引用浮按钮
    if (_gcQuoteFloatBtn && _gcQuoteFloatBtn.style.display !== 'none') {
      _gcQuoteFloatBtn.style.display = 'none';
    }
    if (_gcFocusedCardSid) {
      _gcFocusedCardSid = null;
      document.body.classList.remove('mr-card-focus-on');
    }
    if (_gcCompareSlots.size > 0) _clearCompareSelect();
    // Phase 5: Esc 退出时光机模式(对当前 active meeting)。
    //   meetings 是 plain object(不是 Map), 用 meetings[id] 取
    if (typeof activeMeetingId !== 'undefined' && activeMeetingId && _gcViewingTurnN[activeMeetingId]) {
      delete _gcViewingTurnN[activeMeetingId];
      const m = (typeof meetings !== 'undefined' && meetings) ? meetings[activeMeetingId] : null;
      if (m) refreshGroupChatPanel(m);
    }
  });
  document.addEventListener('click', function _gcFocusBlankClickHandler(ev) {
    if (ev.target && ev.target.closest && ev.target.closest('.mr-ft')) return;
    if (_gcFocusedCardSid) {
      _gcFocusedCardSid = null;
      document.body.classList.remove('mr-card-focus-on');
    }
    if (_gcCompareSlots.size > 0) _clearCompareSelect();
  });

  // 2026-05-05 maintainer：聚焦主卡 Ctrl+滚轮缩放字号。IIFE 顶层挂载只挂一次。
  //   - CSS 变量 --card-font-focus-scale 挂在 body 上，沿 DOM 树继承到 .mr-ft.active
  //     的子元素 calc()，所以这里只 set 一次 body.style 就够，无需 MutationObserver
  //     等 .active 卡渲出来后再写
  //   - handler 内判断 mr-card-focus-on + e.target 在主卡内才响应
  //   - preventDefault 拦掉 Electron 默认整窗 zoom（仅主卡内拦，主卡外仍可整窗 zoom）
  //   - clamp [0.8, 2.0] 步进 0.1，持久化到 localStorage，下次启动沿用
  const CARD_FOCUS_SCALE_KEY = 'mr-card-focus-font-scale';
  const CARD_FOCUS_SCALE_MIN = 0.8;
  const CARD_FOCUS_SCALE_MAX = 2.0;
  const CARD_FOCUS_SCALE_STEP = 0.1;
  const CARD_FOCUS_SCALE_DEFAULT = 1.3;
  let _cardFocusFontScale = (() => {
    const raw = parseFloat(localStorage.getItem(CARD_FOCUS_SCALE_KEY));
    return (Number.isFinite(raw) && raw >= CARD_FOCUS_SCALE_MIN && raw <= CARD_FOCUS_SCALE_MAX) ? raw : CARD_FOCUS_SCALE_DEFAULT;
  })();
  function _applyCardFocusScale(s) {
    _cardFocusFontScale = Math.max(CARD_FOCUS_SCALE_MIN, Math.min(CARD_FOCUS_SCALE_MAX, Math.round(s * 10) / 10));
    document.body.style.setProperty('--card-focus-font-scale', String(_cardFocusFontScale));
    try { localStorage.setItem(CARD_FOCUS_SCALE_KEY, String(_cardFocusFontScale)); } catch {}
  }
  // 启动时把上次/默认 scale 写到 body —— 之后任何 .active 卡渲染都自动继承
  _applyCardFocusScale(_cardFocusFontScale);
  document.body.addEventListener('wheel', function _gcCardFocusWheelHandler(e) {
    if (!e.ctrlKey) return;
    if (!document.body.classList.contains('mr-card-focus-on')) return;
    const inActive = e.target && e.target.closest && e.target.closest('.mr-ft.active');
    if (!inActive) return;
    e.preventDefault();
    e.stopPropagation();
    const dir = e.deltaY < 0 ? +1 : -1;
    _applyCardFocusScale(_cardFocusFontScale + dir * CARD_FOCUS_SCALE_STEP);
  }, { passive: false });
  // Stage 2 容错升级：每轮 prompt 发送时间戳（用于 manual-extract IPC 的 sincePromptTs 参数）
  const _gcTurnStartTs = {};

  // markdown 渲染（用项目已有的 marked + DOMPurify）
  let _markedCache = null;
  let _domPurifyCache = null;

  function _normalizeMarkdownPathBreaks(text) {
    if (typeof window !== 'undefined' && typeof window.normalizeWrappedPathBreaks === 'function') {
      return window.normalizeWrappedPathBreaks(text);
    }
    return String(text || '');
  }

  // 卡片优化（2026-05-03 maintainer）：与 renderer.js 的 ABS_PATH_RE 同源 — 绝对路径
  //   (Windows C:\... / UNC \\server\... / ~ 起始)，扩展名 1-8 ASCII。AI 群聊卡片
  //   场景下 AI 输出多绝对路径；相对路径需 cwd 上下文，本卡片层不易拿到，先不做。
  const _ABS_PATH_RE = /(?:[A-Za-z]:[\\/]|\\\\[^\\/:*?"<>|\r\n\s]+\\|~[\\/])(?:[^\\/:*?"<>|\r\n\s]+[\\/])*[^\\/:*?"<>|\r\n\s]+\.[A-Za-z0-9]{1,8}(?![A-Za-z0-9])/g;

  function _activeMeetingCwd() {
    const meeting = activeMeetingId ? meetingData[activeMeetingId] : null;
    const subs = meeting && Array.isArray(meeting.subSessions) ? meeting.subSessions : [];
    for (const sid of subs) {
      try {
        const s = (typeof sessions !== 'undefined' && sessions && typeof sessions.get === 'function')
          ? sessions.get(sid)
          : null;
        if (s && s.cwd) return s.cwd;
      } catch {}
    }
    return null;
  }

  // marked 渲染后扫描非 <pre> 文本节点的绝对路径，包成
  // <a class="rt-file-link" data-path="..."> 让用户点击进 hub 内置 preview 面板。
  //
  // 不跳过 <code>（单 inline code）：AI 通常用 `\`path\`` 标注路径，理应可点击。
  //   `<code>C:\foo.html</code>` 会被升级成 `<code><a>C:\foo.html</a></code>`
  //   既保留 code 灰底等宽视觉，又得到链接行为。
  // 跳过 <pre>（多行代码块）：bash/python 脚本里的路径是命令参数，识别会误伤
  //   （如 `python C:\script.py --arg` 包路径会让脚本视觉断开）。
  // 2026-05-03 maintainer：从 SKIP 移除 CODE 是用户场景反馈：历史回答面板的路径
  //   出现在 inline code 内，原 skip CODE 让它没有 link。
  function _wrapFilePathsInDom(rootEl, cwd = _activeMeetingCwd()) {
    if (typeof window !== 'undefined' && typeof window.wrapPathLinksInElement === 'function') {
      window.wrapPathLinksInElement(rootEl, { cwd, skipCodeBlocks:true });
      return;
    }
    const SKIP_TAGS = new Set(['PRE', 'A', 'SCRIPT', 'STYLE', 'BUTTON', 'TEXTAREA', 'INPUT', 'SELECT']);
    const walker = document.createTreeWalker(rootEl, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        let p = node.parentNode;
        while (p && p !== rootEl) {
          if (p.nodeType === 1 && SKIP_TAGS.has(p.tagName)) return NodeFilter.FILTER_REJECT;
          p = p.parentNode;
        }
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    const targets = [];
    let n;
    while ((n = walker.nextNode())) {
      _ABS_PATH_RE.lastIndex = 0;
      if (_ABS_PATH_RE.test(n.nodeValue || '')) targets.push(n);
    }
    for (const node of targets) {
      const text = node.nodeValue;
      _ABS_PATH_RE.lastIndex = 0;
      const frag = document.createDocumentFragment();
      let last = 0;
      let m;
      while ((m = _ABS_PATH_RE.exec(text)) !== null) {
        const start = m.index;
        const end = start + m[0].length;
        if (start > last) frag.appendChild(document.createTextNode(text.slice(last, start)));
        const a = document.createElement('a');
        a.className = 'rt-file-link';
        a.setAttribute('data-path', m[0]);
        a.title = m[0];
        a.textContent = m[0];
        frag.appendChild(a);
        last = end;
      }
      if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
      node.parentNode.replaceChild(frag, node);
    }
  }

  // Phase 6(2026-05-05 maintainer): prismjs lazy-load + 常用语言注册 — markdown 代码块语法高亮。
  //   prismjs 已 deps in package.json (^1.30.0), 默认带 markup/css/clike/javascript;
  //   bash/python/typescript/rust/go/json/yaml/sql/markdown 等需单独 require components。
  //   _prismCache: null=未尝试 / Prism object=成功 / false=失败(有 try/catch 兜底)
  let _prismCache = null;
  function _getPrism() {
    if (_prismCache !== null) return _prismCache || null;
    try {
      const Prism = require('prismjs');
      // Prism 默认已含 markup/css/clike/javascript; 显式加载常用扩展语言
      ['bash', 'python', 'typescript', 'jsx', 'tsx', 'rust', 'go', 'json', 'yaml', 'sql', 'markdown'].forEach(lang => {
        try { require('prismjs/components/prism-' + lang); } catch {}
      });
      _prismCache = Prism;
      return Prism;
    } catch (e) {
      _prismCache = false;
      return null;
    }
  }
  function _highlightCodeBlocks(wrapper) {
    const Prism = _getPrism();
    if (!Prism) return;
    wrapper.querySelectorAll('pre code[class*="language-"]').forEach(code => {
      const langClass = Array.from(code.classList).find(c => c.startsWith('language-'));
      if (!langClass) return;
      const lang = langClass.slice('language-'.length);
      if (!Prism.languages[lang]) return;
      try {
        const html = Prism.highlight(code.textContent, Prism.languages[lang], lang);
        code.innerHTML = html;
      } catch {}
    });
  }

  function _renderMarkdownUncached(text, cwd) {
    try {
      if (!_markedCache) _markedCache = require('marked').marked;
      if (!_domPurifyCache) _domPurifyCache = require('dompurify');
      const math = require('./markdown-math-guard');
      const mathGuard = math.guardMarkdownMath(_normalizeMarkdownPathBreaks(text));
      const pathGuard = guardMarkdownLocalPaths(mathGuard.text);
      const html = _markedCache.parse(pathGuard.text, { breaks: true, gfm: true });
      const sanitized = restoreMarkdownLocalPaths(
        _domPurifyCache.sanitize(html, { ADD_ATTR: ['data-path', 'class'] }),
        pathGuard,
      );
      // 后处理：扫文件路径包 <a class="rt-file-link"> 让用户点开预览（卡片优化 2026-05-03）。
      //   注意必须在 sanitize 之后做，因为我们新增的 <a> 元素文本来自 sanitize 后的 textContent
      //   （已 escape），data-path 也是从同一字符串复制，无注入风险。
      const wrapper = document.createElement('div');
      wrapper.innerHTML = math.restoreMarkdownMath(sanitized, mathGuard);
      if (typeof window.renderMathInElement === 'function') window.renderMathInElement(wrapper, {
        delimiters: [{left:'$$',right:'$$',display:true},{left:'\\[',right:'\\]',display:true},{left:'\\(',right:'\\)',display:false},{left:'$',right:'$',display:false}],
        ignoredTags: ['script', 'noscript', 'style', 'textarea', 'pre', 'code', 'option'],
        ignoredClasses: ['katex', 'katex-display'], throwOnError:false, strict:'ignore', trust:false,
      });
      _wrapFilePathsInDom(wrapper, cwd);
      // Phase 6: 代码块语法高亮(prism token classes), CSS 提供 token 颜色
      _highlightCodeBlocks(wrapper);
      return wrapper.innerHTML;
    } catch (e) {
      console.warn("[groupchat] Markdown rendering failed:", e && e.message);
      // 回退到纯文本（escapeHtml）
      return escapeHtml(text).replace(/\n/g, '<br>');
    }
  }
  // #1 流式/重渲性能：_renderMarkdown 对相同文本会被反复调用——chat/full-panel panel 每个
  //   partial tick 重渲所有已完成消息、tab 切换/时光机/soft-alert 亦然。同一 text 经
  //   marked+DOMPurify+Prism 必得同一 HTML（运行期配置稳定），故按 text 做 LRU memo：
  //   稳定内容直接命中缓存，跳过 parse+sanitize+DOM walk+Prism；流式增长中的那条每 tick
  //   text 不同必然 miss（不影响正确性），命中的是其周围大量稳定内容。输出逐字节一致，
  //   零视觉/行为变化。Map 迭代序=插入序，命中即 delete+set 重置到队尾，超上限驱逐最旧。
  const _mdCache = new Map();
  const _MD_CACHE_MAX = 300;
  const _mdStats = { renders: 0, hits: 0 };
  function _renderMarkdown(text, cwd = _activeMeetingCwd()) {
    if (!text) return '';
    const cacheKey = JSON.stringify([cwd, text]);
    const hit = _mdCache.get(cacheKey);
    if (hit !== undefined) {
      _mdCache.delete(cacheKey); _mdCache.set(cacheKey, hit);
      _mdStats.hits++;
      return hit;
    }
    const out = _renderMarkdownUncached(text, cwd);
    _mdStats.renders++;
    _mdCache.set(cacheKey, out);
    if (_mdCache.size > _MD_CACHE_MAX) _mdCache.delete(_mdCache.keys().next().value);
    return out;
  }
  if (typeof window !== 'undefined') {
    // 可观测/E2E seam（同底部 module.exports 暴露 _isPartialUnchanged 之意图）：
    //   供 CDP 度量 memo 命中率、验证相同 text 输出逐字节一致。
    window.__mrMarkdownStats = _mdStats;
    window.__mrRenderMarkdown = _renderMarkdown;
  }

  // 卡片优化（2026-05-03 maintainer）：路径链接 click 使用 document 级委托，但严格
  //   限定在 #meeting-room-panel，避免和普通 session 的委托重复消费同一次点击。
  //   meeting-room.js IIFE 内 setup 一次（IIFE 只运行一次，幂等）。捕获阶段
  //   先于 marked HTML 内任何 a 元素的默认行为，让 .rt-file-link 路由到 hub
  //   内置 preview 面板（renderer.js 全局函数 openPreviewPanel）。
  document.addEventListener('click', (e) => {
    const a = e.target && e.target.closest && e.target.closest('a.rt-file-link');
    if (!a) return;
    if (!a.closest('#meeting-room-panel')) return;
    const path = a.getAttribute('data-path');
    if (!path) return;
    e.preventDefault();
    e.stopPropagation();
    if (typeof window !== 'undefined' && typeof window.openPathInHub === 'function') {
      window.openPathInHub(path, { cwd: a.dataset.cwd || _activeMeetingCwd(), requireExistsForRel: false });
    } else if (typeof openPreviewPanel === 'function') {
      openPreviewPanel(path);
    } else if (typeof window !== 'undefined' && typeof window.openPreviewPanel === 'function') {
      window.openPreviewPanel(path);
    } else {
      console.warn('[mr] openPreviewPanel not found, cannot preview:', path);
    }
  }, true);

  // T7（2026-05-01）：preview blocks 结构化渲染 helper —
  //   transcript-tap 现在直供 { type:'thinking'|'text'|'tool_use', ... } 块数组
  //   thinking → 灰斜体 + 💭 前缀；tool_use → cyan chip 工具调用摘要；text → 复用 _renderMarkdown
  //   工具块上限 8（spec §3.6 R8），超出从前面丢（保留最近）
  function _formatToolUseBlock(block) {
    const name = (block && block.name) || '';
    const input = (block && block.input) || {};
    if (/^(WebSearch|web_search)$/i.test(name)) {
      const q = input.query || input.q || '';
      return `🔍 搜索: "${q}"`;
    }
    if (/^(Read|read_file|read)$/i.test(name)) {
      return `📄 读: ${input.path || input.file || input.file_path || ''}`;
    }
    if (/^(Bash|shell|exec)$/i.test(name)) {
      const cmd = String(input.command || input.cmd || '').slice(0, 60);
      return `⚙ 执行: ${cmd}`;
    }
    if (/^(Edit|Write|edit|write)$/i.test(name)) {
      return `✏ 编辑: ${input.file_path || input.path || ''}`;
    }
    return `🔧 ${name}`;
  }

  function _renderPreviewBlocks(blocks, sid) {
    if (!Array.isArray(blocks) || blocks.length === 0) return '';
    // 工具块只保留最后 8 个，从前面丢（spec §3.6 R8 防 thinking-heavy 卡片膨胀）
    const filtered = [];
    let toolCount = 0;
    for (let i = blocks.length - 1; i >= 0; i--) {
      const b = blocks[i];
      if (!b || typeof b !== 'object') continue;
      if (b.type === 'tool_use') {
        if (toolCount >= 8) continue;
        toolCount++;
      }
      filtered.unshift(b);
    }
    // 2026-05-03 maintainer：移除字符截断（改前 thinking 400 / text 2000）。
    //   卡片本身有 max-height + overflow-y 滚动承载长内容；截断会砍掉答案末尾
    //   的关键信息（如评分总评），用户必须开 shell 才能看到，违反"卡片即结论"原则。
    //   "进 shell"入口仍在卡片头部 escape btn，用户需要时可手动切换。
    const html = [];
    for (const block of filtered) {
      if (block.type === 'thinking') {
        const raw = String(block.text || '');
        html.push(`<div class="mr-ft-think">${escapeHtml(raw)}</div>`);
      } else if (block.type === 'tool_use') {
        const summary = _formatToolUseBlock(block);
        const activity = normalizeToolActivity({
          id: block.id || block.tool_use_id,
          name: block.name,
          input: block.input,
          status: block.status || 'running',
        });
        const statusLabel = activity.status === 'failed' ? '失败'
          : activity.status === 'completed' ? '完成'
            : activity.status === 'pending' ? '等待' : '进行中';
        html.push(`<span class="mr-ft-tool activity-${escapeHtml(activity.status)}"><span>${escapeHtml(summary)}</span><em>${statusLabel}</em></span>`);
      } else if (block.type === 'text') {
        const raw = String(block.text || '');
        html.push(`<div class="mr-ft-md">${_renderMarkdown(raw)}</div>`);
      }
    }
    return html.join('');
  }

  function _renderGroupDelivery(text, cwd, toolCalls = []) {
    if (!text && !toolCalls.length) return '';
    const presentation = buildTurnPresentation({ role:'assistant', text, stopReason:'end_turn', toolCalls }, {cwd});
    return require('./delivery-summary').renderDeliverySummary(presentation.delivery, escapeHtml);
  }

  function _enhanceGroupCardContent(root) {
    if (!root) return;
    const cards = root.matches?.('.mr-gc-msg') ? [root] : [...root.querySelectorAll('.mr-gc-msg')];
    for (const card of cards) {
      const session = typeof sessions !== 'undefined' && sessions.get(card.dataset.sourceSid);
      const cwd = session?.cwd || meetingData[activeMeetingId]?.workspace || _activeMeetingCwd();
      if (typeof window.wrapPathLinksInElement === 'function') window.wrapPathLinksInElement(card, {cwd, skipCodeBlocks:true});
    }
  }

  function _setupQuestionDirectory(panel, meeting) {
    const overlay = panel.querySelector('.mr-gc-messages'), root = panel.querySelector('#mr-question-nav');
    if (!overlay || !root) return;
    const navigator = require('./card-question-navigator').createCardQuestionNavigator({
      document, window, root, overlay, layoutElement:overlay.parentElement,
      getActiveSessionId:()=> 'group:' + meeting.id,
      getCurrentView:()=> 'card',
      getAnswerCards:()=> [...overlay.querySelectorAll('.mr-gc-msg.ai')],
      requestAnimationFrame: callback=>requestAnimationFrame(callback), cancelAnimationFrame:handle=>cancelAnimationFrame(handle),
      getEntries:()=> {
        const messages = _gcPanelState[meeting.id]?.messages || [];
        const byId = new Map(messages.map(m=>[m.id,m])), replies = new Map();
        for (const m of messages) if(m.role==='assistant' && m.sid) { if(!replies.has(m.turnNum)) replies.set(m.turnNum,new Set()); replies.get(m.turnNum).add(m.sid); }
        return [...overlay.querySelectorAll('.mr-gc-msg[data-user-question="true"]')].map(card=>{
          const message = byId.get(card.dataset.gcMsgId);
          const count = replies.get(message?.turnNum)?.size || 0;
          const timestamp = message?.createdAt;
          return {card, text:message?.content || card.querySelector('.conversation-user-text')?.innerText || '',timestamp,
            meta: [timestamp ? _formatGroupChatTime(timestamp) : '', count ? count+' 位成员已回复' : '用户提问'].filter(Boolean).join(' · ')};
        });
      },
    });
    panel._questionDirectory = navigator; navigator.init(); navigator.refresh();
  }

  // 注：顶部 scene toggle（群聊/投研）的 _renderModeToggle/_bindModeToggle 已删除
  //   （2026-05-04 决策：scene 创建时确定，运行时不可切换）。
  //   IPC `switch-scene` handler 保留，避免破坏其它代码路径。

  function _ensureGcPanel() {
    let panel = document.getElementById('mr-group-chat-panel');
    if (!panel) {
      panel = document.createElement('div');
      panel.id = 'mr-group-chat-panel';
      panel.className = 'mr-gc-panel';
      // Arch refactor 2026-05-02: mr-terminals removed. Anchor the cards panel
      // before mr-toolbar so it occupies the main flex area between header and
      // toolbar / input-row.
      const toolbar = document.getElementById('mr-toolbar');
      if (toolbar && toolbar.parentElement) {
        toolbar.parentElement.insertBefore(panel, toolbar);
      } else {
        const mrPanel = document.getElementById('meeting-room-panel');
        if (mrPanel) mrPanel.appendChild(panel);
      }
    }
    if (!panel._groupSelection) panel._groupSelection = require('./group-card-selection').mountGroupCardSelection({
      panel, getMeetingId: () => activeMeetingId,
      extractText: extractVisibleCardText,
      copyText: (text, options) => clipboardController.copyText(text, options),
    });
    return panel;
  }

  function _removeGcPanel() {
    const p = document.getElementById('mr-group-chat-panel');
    p?._groupSelection?.destroy();
    if (p && p.parentElement) p.remove();
  }

  // sub session 信息（kind → {sid, label}）— 用于按 kind 索引找子 session 显示信息。
  // Build a first-session lookup for the active core AI kinds. Duplicate-kind slot semantics are handled by slot specs.
  function _getGcSubInfo(meeting) {
    const subs = {};
    for (const kind of Object.keys(_KIND_LABELS)) subs[kind] = null;
    if (!meeting || !meeting.subSessions) return subs;
    for (const sid of meeting.subSessions) {
      const s = (typeof sessions !== 'undefined' && sessions) ? sessions.get(sid) : null;
      if (!s || !s.kind) continue;
      if (subs[s.kind] === null) {
        subs[s.kind] = { sid, label: s.title || _KIND_LABELS[s.kind] || s.kind };
      }
    }
    return subs;
  }

  // meeting-create-modal（2026-05-01）：按 subSessions 数组顺序还原 slot 数组。
  //   返回 [slot0, slot1, slot2]，每个 slot 是 { sid, kind, slotId, slotIndex, label, displayLabel }
  // Restore slot metadata from subSessions order. slotId is member1/member2/member3.
  function _getGcSlots(meeting) {
    const maxSlots = meeting && meeting.groupChat && Array.isArray(meeting.subSessions)
      ? meeting.subSessions.length
      : 3;
    const slots = Array.from({ length: maxSlots }, () => null);
    if (!meeting || !Array.isArray(meeting.subSessions)) return slots;
    for (let i = 0; i < meeting.subSessions.length && i < maxSlots; i++) {
      const sid = meeting.subSessions[i];
      const s = (typeof sessions !== 'undefined' && sessions) ? sessions.get(sid) : null;
      if (!s) continue;
      const spec = Array.isArray(meeting.slotSpecs) ? (meeting.slotSpecs[i] || {}) : {};
      const slotId = slotIndexToId(i);
      const kindLabel = getKindLabel(s.kind);
      slots[i] = {
        sid,
        kind: s.kind,
        slotId,
        slotIndex: i,
        memberId: spec.memberId || `m${i + 1}`,
        label: meeting.groupChat ? (s.title || `${kindLabel} ${i + 1}`) : (slotId ? getSlotPromptName(slotId) : (s.title || s.kind || `Slot ${i + 1}`)),
        displayLabel: meeting.groupChat ? (s.title || `${kindLabel} ${i + 1}`) : (slotId ? getSlotDisplayLabel(slotId) : (s.title || s.kind || `Slot ${i + 1}`)),
      };
    }
    return slots;
  }

  function _memberIdForSlot(slot) {
    return slot && slot.memberId ? String(slot.memberId) : `m${Number(slot && slot.slotIndex || 0) + 1}`;
  }
  // ai-kinds.js is the single source of truth for supported AI labels.
  const _KIND_LABELS = KIND_LABELS;

  const _DUTY_HAT_PROMPT_MARKER = '## 临时职责帽（本轮有效，不写入长期记忆）';
  const _DUTY_HATS_BY_SCENE = {
    general: [
      {
        id: 'clarifier',
        icon: '❓',
        label: '问题澄清员',
        short: '澄清',
        duty: '负责拆解用户问题、补齐前提、指出会改变答案的关键缺口；不要直接替其他角色下结论。',
        format: '问题拆解 / 已知前提 / 缺失信息 / 关键追问 / 默认假设',
      },
      {
        id: 'fact_check',
        icon: '🔍',
        label: '事实核验员',
        short: '核验',
        duty: '负责核验关键事实、数字、引用、时间点与来源；不确定内容必须明确标注。',
        format: '已确认事实 / 来源与时间 / 不确定项 / 冲突口径 / 需补查',
      },
      {
        id: 'options',
        icon: '🧩',
        label: '方案设计师',
        short: '方案',
        duty: '负责提出可选方案和执行路径，说明每个方案的适用条件，不负责风险挑错。',
        format: '方案 A / 方案 B / 适用条件 / 成本收益 / 推荐前提',
      },
      {
        id: 'critic',
        icon: '⚠️',
        label: '反方挑战者',
        short: '反方',
        duty: '负责寻找遗漏、反例、逻辑跳跃和失败路径；避免复述方案优点。',
        format: '最大风险 / 反例 / 隐含假设 / 失败信号 / 修正建议',
      },
      {
        id: 'judge',
        icon: '🎯',
        label: '综合裁判',
        short: '裁判',
        duty: '负责收敛共识与分歧，给出可执行结论和取舍理由；不做无差别折中。',
        format: '结论 / 取舍理由 / 主要分歧 / 决策条件 / 下一步',
      },
      {
        id: 'action',
        icon: '✅',
        label: '行动拆解员',
        short: '行动',
        duty: '负责把结论拆成下一步动作、负责人、验证方式和截止条件。',
        format: '下一步 / 优先级 / 负责人或角色 / 验证标准 / 截止条件',
      },
    ],
    research: [
      {
        id: 'data',
        icon: '🔍',
        label: '数据核验员',
        short: '核验',
        duty: '只负责核验关键数字、事实、来源与时间点；未查到或未确认的内容必须标注“未核验”。核验前先调 stock_static(symbol) 拿财务/估值/股东/质押底数，对照其 confidence 标签，非 HIGH 字段必须提示口径风险。',
        format: '已核验数据 / 数据来源 / 数据时点 / 未核验项 / 口径或冲突风险',
      },
      {
        id: 'bear',
        icon: '🧨',
        label: '空头审稿人',
        short: '空头',
        duty: '只负责攻击前面观点，寻找反例、逻辑跳跃、过期数据、证伪条件；不要输出综合结论。攻击要落到实据：调 stock_static 查质押/商誉/股东减持等雷点，必要时调 stock_news 反证催化是否已被 price-in；质疑同样标证据强度（strong/medium/weak），weak 级不能单独作为“建议打回”的理由。',
        format: '最大漏洞 / 反例 / 需要补查 / 证伪条件 / 是否建议打回',
      },
      {
        id: 'bull',
        icon: '📈',
        label: '多头论证员',
        short: '多头',
        duty: '负责构建最强看多逻辑链，但必须给出验证条件和失效条件，避免只讲叙事。看多链必须挂在数据上：调 stock_static 验财务/估值底子、stock_news 找催化与一致预期；关键证据标 strong/medium/weak，weak 不得单独支撑高置信。',
        format: '看多主张 / 关键证据 / 验证条件 / 失效条件 / 置信度',
      },
      {
        id: 'judge',
        icon: '🎯',
        label: '综合裁判',
        short: '裁判',
        duty: '负责在其他成员发言后收敛，不负责和稀泥；合并共识与分歧，给出行动前复核清单。原则上不另调数据工具，专注收敛各方已查证据；若有机器基线分/体检卡则以其为量化锚，偏离要说明理由。',
        format: '结论等级 / 置信度 / 主要分歧 / 需要补查的数据 / 行动前复核清单',
      },
      {
        id: 'catalyst',
        icon: '📰',
        label: '消息催化帽',
        short: '催化',
        duty: '负责公告、财报日历、政策、监管、新闻事件与催化剂时间表，区分已发生、已知未兑现和待确认信息。优先调 stock_news(symbol) 拿公告/新闻/快讯；若要看社区情绪、争议焦点、V大观点，再调 stock_sentiment(symbol)。每个催化剂必须带日期与来源，并指出市场已知与可能的预期差。',
        format: '最新事件 / 来源与时间 / 影响路径 / 待兑现节点 / 可靠性',
      },
      {
        id: 'technical',
        icon: '📊',
        label: '技术分析师',
        short: '技术',
        duty: '负责趋势、量价、资金流、融资融券、实时盘口等交易层信号，回答市场现在在做什么。优先调 stock_market(symbol) 拿 K线/RSI/MACD/资金流/融资融券；支撑、压力、止损位必须基于真实指标算，不得凭记忆估。问“历史上类似形态后来怎么走”时再调 kline_similarity(symbol)。',
        format: '趋势方向 / 关键价位 / 量能资金 / 短期风险 / 失效信号',
      },
    ],
    dev: [
      // 前两顶是流水线角色，和 dev-task 工作流的两步一一对应。
      // 后面那些是讨论型角色，用于不跑流程、只想让几个 AI 议一议的时候。
      {
        id: 'worker',
        icon: '🛠️',
        label: '工作位',
        short: '工作',
        duty: '读本仓库 .agents/AUTHOR.md 按它工作：开自己的 worktree、实现、自测、说人话。只做当前这一个任务，不顺手改别的。',
        format: 'PROGRESS / VERIFIED / RISK / REPORT',
      },
      {
        id: 'merger',
        icon: '⚖️',
        label: '合并位',
        short: '合并',
        duty: '读本仓库 .agents/MERGER.md 按它工作：先确认主干有没有被别人推进过，亲自跑验证，PASS 才合。不审自己写的分支。',
        format: 'RESULT / BLOCKERS / VERIFIED / NEXT',
      },
      {
        id: 'requirements',
        icon: '🧭',
        label: '需求澄清员',
        short: '需求',
        duty: '负责确认目标、验收标准、边界条件和用户真实工作流；不急于给实现方案。',
        format: '目标 / 验收标准 / 边界条件 / 待确认问题 / 非目标',
      },
      {
        id: 'architect',
        icon: '🏗️',
        label: '架构设计师',
        short: '架构',
        duty: '负责判断模块边界、数据流、接口契约和可维护性取舍；避免过度设计。',
        format: '影响范围 / 模块边界 / 数据流 / 关键取舍 / 迁移风险',
      },
      {
        id: 'implementer',
        icon: '🛠️',
        label: '实现工程师',
        short: '实现',
        duty: '负责给出最小可落地实现路径、关键文件、伪代码或补丁思路。',
        format: '改动文件 / 实现步骤 / 关键代码点 / 兼容性 / 回滚方式',
      },
      {
        id: 'reviewer',
        icon: '🔎',
        label: '代码审稿人',
        short: '审稿',
        duty: '负责从缺陷、回归、并发、状态一致性和可读性角度挑错；不要重写完整方案。',
        format: '高风险点 / 可能回归 / 可读性问题 / 必改项 / 可缓项',
      },
      {
        id: 'tester',
        icon: '🧪',
        label: '测试守门员',
        short: '测试',
        duty: '负责设计验证路径、红绿测试、手工检查和日志证据；明确哪些无法验证。',
        format: '必测场景 / 自动化测试 / 手工验证 / 日志证据 / 剩余风险',
      },
      {
        id: 'release',
        icon: '🚦',
        label: '发布排障员',
        short: '发布',
        duty: '负责关注配置、构建、部署、回滚、兼容环境和线上排障路径。',
        format: '配置检查 / 构建发布 / 环境依赖 / 回滚方案 / 排障入口',
      },
    ],
  };
  const _dutyHatAssignmentsByMeeting = {};

  // 临时职责帽默认折叠。八行下拉占掉群成员栏一多半高度，而它是「偶尔用一次」的功能：
  // 展开着的代价是每次开群聊都得从它下面翻过去才看得到成员和上下文。
  // 和群成员栏同一套写法：localStorage 记住用户的显式选择，没记录就当折叠。
  const _DUTY_HATS_STATE_KEY = 'mr-duty-hats-state';
  function _getDutyHatsCollapsed() {
    try {
      const state = typeof localStorage !== 'undefined' ? localStorage.getItem(_DUTY_HATS_STATE_KEY) : null;
      return state !== 'expanded';
    } catch { return true; }
  }
  function _setDutyHatsCollapsed(collapsed) {
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem(_DUTY_HATS_STATE_KEY, collapsed ? 'collapsed' : 'expanded');
      }
    } catch {}
  }

  function _getDutyHatScene(meeting) {
    const scene = meeting && typeof meeting.scene === 'string' ? meeting.scene : 'general';
    return _DUTY_HATS_BY_SCENE[scene] ? scene : 'general';
  }

  function _getDutyHats(meeting) {
    return _DUTY_HATS_BY_SCENE[_getDutyHatScene(meeting)];
  }

  function _getDutyHatAssignmentKey(meeting) {
    if (!meeting || !meeting.id) return '';
    return `${meeting.id}:${_getDutyHatScene(meeting)}`;
  }

  function _getDutyHatAssignments(meeting) {
    const key = _getDutyHatAssignmentKey(meeting);
    if (!key) return {};
    if (!_dutyHatAssignmentsByMeeting[key]) _dutyHatAssignmentsByMeeting[key] = {};
    return _dutyHatAssignmentsByMeeting[key];
  }

  function _clearDutyHatAssignments(meeting) {
    const key = _getDutyHatAssignmentKey(meeting);
    if (key) delete _dutyHatAssignmentsByMeeting[key];
  }

  function _memberMentionLabel(slot) {
    if (!slot) return 'AI';
    const label = slot.displayLabel || slot.label || slot.kind || `AI ${slot.slotIndex + 1}`;
    return `${_memberIdForSlot(slot)}（${label}）`;
  }

  function _renderDutyHatPanel(meeting, slots) {
    if (!meeting || !meeting.groupChat || !Array.isArray(slots) || slots.length === 0) return '';
    const dutyHats = _getDutyHats(meeting);
    const assignments = _getDutyHatAssignments(meeting);
    const validSlots = slots.filter(slot => slot && slot.sid);
    const validSids = new Set(validSlots.map(slot => slot.sid));
    const assignedCount = dutyHats.filter(h => assignments[h.id] && validSids.has(assignments[h.id])).length;
    const rows = dutyHats.map(hat => {
      const sid = validSids.has(assignments[hat.id]) ? assignments[hat.id] : '';
      const optionsHtml = validSlots.map(slot => {
        const label = _memberMentionLabel(slot);
        return `<option value="${escapeHtml(slot.sid)}" ${slot.sid === sid ? 'selected' : ''}>${escapeHtml(label)}</option>`;
      }).join('');
      return `
        <label class="mr-duty-hat-row ${sid ? 'assigned' : ''}" title="${escapeHtml(hat.duty)}">
          <span class="mr-duty-hat-label">
            <span class="mr-duty-hat-icon" aria-hidden="true">${hat.icon}</span>
            <span class="mr-duty-hat-text">${escapeHtml(hat.label)}</span>
          </span>
          <select class="mr-duty-hat-select" data-duty-hat-id="${escapeHtml(hat.id)}" aria-label="${escapeHtml(hat.label)}">
            <option value="">未指定</option>
            ${optionsHtml}
          </select>
        </label>
      `;
    }).join('');
    // 折叠时整块正文都不渲染（不是 display:none）——用户要的是「不要出现」，
    // 留在 DOM 里的八个 select 仍然会被 Tab 键走到。
    const collapsed = _getDutyHatsCollapsed();
    const body = collapsed ? '' : `
        <div class="mr-duty-hat-list">${rows}</div>
        <div class="mr-duty-hat-actions">
          <button type="button" class="mr-duty-hat-action primary" data-duty-hat-insert="1" ${assignedCount ? '' : 'disabled'}>更新分工</button>
          <button type="button" class="mr-duty-hat-action" data-duty-hat-clear="1" ${assignedCount ? '' : 'disabled'}>清空</button>
        </div>
        <div class="mr-duty-hat-hint">选择后自动同步到输入框，发送前可编辑。</div>`;
    return `
      <section class="mr-duty-hats ${collapsed ? 'collapsed' : ''}" aria-label="临时职责帽">
        <button type="button" class="mr-duty-hats-head" data-duty-hats-toggle="1"
                aria-expanded="${collapsed ? 'false' : 'true'}" title="${collapsed ? '展开临时职责帽' : '收起临时职责帽'}">
          <span class="mr-duty-hats-caret" aria-hidden="true">${collapsed ? '▸' : '▾'}</span>
          <span class="mr-duty-hats-title">临时职责帽</span>
          <span class="mr-duty-hats-count">${assignedCount}/${dutyHats.length}</span>
        </button>${body}
      </section>
    `;
  }

  function _buildDutyHatPrompt(meeting) {
    if (!meeting) return '';
    const dutyHats = _getDutyHats(meeting);
    const assignments = _getDutyHatAssignments(meeting);
    const slotsBySid = {};
    for (const slot of _getGcSlots(meeting).filter(Boolean)) {
      slotsBySid[slot.sid] = slot;
    }
    const selected = dutyHats
      .map(hat => ({ hat, slot: slotsBySid[assignments[hat.id]] }))
      .filter(item => item.slot);
    if (selected.length === 0) return '';

    const summary = selected
      .map(({ hat, slot }) => `${_memberMentionLabel(slot)}=${hat.short}`)
      .join('；');
    const lines = [
      _DUTY_HAT_PROMPT_MARKER,
      `【本轮完整分工：${summary}】`,
      '所有成员都能看到完整分工；请只按自己的职责发言，不重复他人观点。涉及数字必须说明来源和时间点；无法核验请明确标注“未核验”。',
      '',
    ];
    for (const { hat, slot } of selected) {
      lines.push(`- ${_memberMentionLabel(slot)}：${hat.label}。${hat.duty}`);
      lines.push(`  输出格式：${hat.format}`);
    }
    lines.push('');
    return lines.join('\n');
  }

  function _replaceDutyHatPromptInText(text, prompt) {
    const current = String(text || '').trim();
    const blockRe = new RegExp(`${_DUTY_HAT_PROMPT_MARKER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\S]*?(?=\\n\\n(?!- )|$)`, 'm');
    if (!prompt) return current.replace(blockRe, '').trim();
    if (blockRe.test(current)) return current.replace(blockRe, prompt.trim()).trim();
    return current ? `${prompt.trim()}\n\n${current}` : prompt.trim();
  }

  function _setMeetingInputText(meetingId, text) {
    const input = document.getElementById('mr-input-box');
    if (!input) return;
    _renderComposerRaw(input, text || '');
    _setInputDraft(meetingId, text || '');
    _updateInputPreflight(meetingData[meetingId]);
    input.focus();
    _placeCaretAtEnd(input);
  }

  function _syncDutyHatPromptToInput(meeting) {
    if (!meeting || !meeting.id) return;
    const prompt = _buildDutyHatPrompt(meeting);
    const input = document.getElementById('mr-input-box');
    const currentText = input ? (input.innerText || '') : '';
    const nextText = _replaceDutyHatPromptInText(currentText, prompt);
    _setMeetingInputText(meeting.id, nextText);
  }

  // T1（2026-05-04 maintainer）：抽出单 slot 卡片渲染，让 partial-update IPC handler
  //   能复用同一份模板做局部 patch（不再 panel.innerHTML 全量替换）。
  //   依赖：函数参数（slotIndex, ctx）+ ctx 字段 { state, currentMode, partialBy, meeting,
  //         slots, lastTurn, meetingId, focused }；
  //         IIFE 私有 helper / 全局：_avatarBySlot, _avatarFallbackBySlot, _renderPreviewBlocks,
  //         isSlotParticipatingThisTurn, _ftCtxClass, _formatThinkTime, _formatTokens, _ftHtml,
  //         _thinkStartTs, _cliReadyCache, _tabState, sessions,
  //         _KIND_LABELS, modelShort, modelClass。
  // 返回：{ html, anyThinking }（anyThinking 由调用方累加，不再 mutate 闭包变量）
  // 无回答终态（2026-07-29 maintainer · 群聊运行中可操作）：这些状态一律不再算"进行中"，
  //   气泡/卡片不得继续显示「思考中」「正在发言」。'interrupted' 是用户点「停止本轮」
  //   后的终态（可能带已生成的半截文本）。集中成一个判定，避免各处硬编码列表漏掉新状态
  //   ——历史上「永久思考中」卡死正是漏判造成的。
  const _GC_SETTLED_NO_ANSWER = new Set(['errored', 'absent', 'superseded', 'interrupted', 'handed_off']);
  function _isGcSettledStatus(status) {
    return _GC_SETTLED_NO_ANSWER.has(status);
  }

  function _renderSlotCard(slotIndex, ctx) {
    const { state, currentMode, partialBy, meeting, slots, lastTurn, meetingId, focused } = ctx;
    const slot = slots[slotIndex];
    if (!slot) return { html: '', anyThinking: false };
    const kind = slot.kind;
    const sub = { sid: slot.sid, label: slot.label };
    const partial = partialBy ? partialBy[sub.sid] : null;
    const s = (typeof sessions !== 'undefined' && sessions) ? sessions.get(sub.sid) : null;
    const isInitializing = s && !_cliReadyCache[sub.sid];
    let status = 'idle';
    let preview = '';
    let anyThinking = false;

    if (isInitializing && !partial && !(currentMode && currentMode !== 'idle') && !lastTurn) {
      status = 'initializing';
    } else if (partial) {
      if (partial.status === 'streaming') {
        status = 'streaming';
        preview = partial.text || '';
        anyThinking = true;
      } else if (partial.status === 'absent') {
        status = 'absent';
        preview = '';
      } else if (partial.status === 'superseded') {
        status = 'superseded';
        preview = '';
      } else if (partial.status === 'interrupted') {
        // 用户点了「停止本轮」：保留已生成的半截文本，但明确是终态、不再"思考中"。
        status = 'interrupted';
        preview = partial.text || '';
      } else if (partial.status === 'errored') {
        status = 'errored';
        preview = '';
      } else if (partial.status === 'manual_extracted') {
        status = 'manual_extracted';
        preview = partial.text || '';
      } else if (partial.status === 'soft_alert') {
        status = 'soft_alert';
        preview = partial.text || '';
        anyThinking = true;
      } else if (partial.status === 'awaiting_binding'
          || partial.status === 'awaiting_final_text'
          || partial.status === 'recovering') {
        status = partial.status;
        preview = partial.text || '';
        anyThinking = true;
      } else {
        status = partial.status === 'timeout' ? 'timeout' : 'completed';
        preview = partial.text || '';
      }
    } else if (currentMode && currentMode !== 'idle') {
      // 本轮真正被 dispatch 的 sid 集合（串行工作流每步只发子集）；未设置则 fallback participants
      const activeSids = _gcActiveSids[meetingId];
      const isActiveThisTurn = activeSids
        ? activeSids.has(sub.sid)
        : isSlotParticipatingThisTurn(meeting, slotIndex);
      if (!isActiveThisTurn) {
        status = lastTurn && lastTurn.by && lastTurn.by[sub.sid] ? 'completed' : 'idle';
        preview = lastTurn ? (lastTurn.by[sub.sid] || '') : '';
      } else {
        status = 'thinking';
        anyThinking = true;
      }
    } else if (lastTurn) {
      const lastStatus = lastTurn.byStatus ? lastTurn.byStatus[sub.sid] : null;
      if (lastStatus === 'errored') {
        status = 'errored';
      } else if (lastStatus === 'absent') {
        status = 'absent';
      } else if (lastStatus === 'superseded') {
        status = 'superseded';
      } else if (lastStatus === 'interrupted') {
        status = 'interrupted';
        preview = lastTurn.by[sub.sid] || '';
      } else if (lastStatus === 'manual_extracted') {
        status = 'manual_extracted';
        preview = lastTurn.by[sub.sid] || '';
      } else if (lastTurn.by[sub.sid]) {
        status = 'completed';
        preview = lastTurn.by[sub.sid];
      }
    }

    const isActive = sub.sid === focused;
    const modelName = s && s.currentModel ? (typeof modelShort === 'function' ? modelShort(s.currentModel) : s.currentModel.displayName || '') : '';
    const modelCls = s && s.currentModel && typeof modelClass === 'function' ? modelClass(s.currentModel.id) : '';
    const sessionSummary = buildSessionStatusSummary(s);
    const tuningText = [sessionSummary.effort, sessionSummary.speed].filter(Boolean).join(' · ');
    const ctxPct = s && typeof s.contextPct === 'number' ? s.contextPct : null;
    const ctxCls = _ftCtxClass(ctxPct);
    const labelDisplay = slot.displayLabel;

    let statusForLabel = status;
    if (partial && partial.sendStatus === 'stuck') statusForLabel = 'send_stuck';
    const failure = partial ? partial.failure : lastTurn?.failureBy?.[sub.sid];
    if (status === 'errored' && failure?.code === 'submission_unknown') statusForLabel = 'submission_unknown';
    const statusLabel = {
      idle: '待命',
      initializing: '创建中…',
      thinking: '思考中',
      queued: '排队中',
      accepted: '已收到 · 等待执行',
      waiting: '等待你的回复',
      streaming: '输出中',
      completed: '已答 ✓',
      timeout: '超时',
      manual_extracted: '已答 ✓ 手动',
      absent: '本轮缺席',
      superseded: '已被新问题覆盖',
      soft_alert: '等待中…',
      awaiting_binding: '已开工 · 等待绑定记录',
      awaiting_final_text: '已结束 · 正在收取答案',
      recovering: '正在恢复本轮',
      send_stuck: '⚠ 输入卡顿，请点 📤 发送',
      errored: '错误',
      submission_unknown: '待核对',
      interrupted: '已中断',
      transport_lost: '连接断开',
    }[statusForLabel] || statusForLabel;
    const tabState = _tabState[sub.sid] || 'idle';
    const newBadge = tabState === 'new-output' && !isActive ? '<span class="mr-ft-new">NEW</span>' : '';

    const blocksFromPartial = (partial && Array.isArray(partial.blocks) && partial.blocks.length > 0)
      ? partial.blocks : null;
    const textFromPartial = (partial && typeof partial.text === 'string' && partial.text)
      ? partial.text : null;
    const textFromHistory = (!partial && lastTurn && lastTurn.by && lastTurn.by[sub.sid])
      ? lastTurn.by[sub.sid] : null;
    const displaySequence=partial?.displayMessages
      || state.displayMessagesByAttempt?.[partial?.attemptId || lastTurn?.attemptIdBy?.[sub.sid]];

    let bottomHtml = '';
    if (status === 'thinking') {
      if (!_thinkStartTs[meetingId]) _thinkStartTs[meetingId] = Date.now();
      bottomHtml = `<div class="mr-ft-progress"><div class="mr-ft-progress-bar slot-${slotIndex + 1}"></div></div>`;
    } else if (status === 'streaming') {
      if (!_thinkStartTs[meetingId]) _thinkStartTs[meetingId] = Date.now();
      let inner;
      if (displaySequence?.length) {
        inner=require('./conversation-message-view').renderMessageSequence(displaySequence,{escapeHtml,renderMarkdown:_renderMarkdown});
      } else if (blocksFromPartial) {
        inner = _renderPreviewBlocks(blocksFromPartial, sub.sid);
      } else if (textFromPartial) {
        inner = _renderPreviewBlocks([{ type: 'text', text: textFromPartial }], sub.sid);
      } else {
        const elapsedSec = _thinkStartTs[meetingId]
          ? Math.round((Date.now() - _thinkStartTs[meetingId]) / 1000) : 0;
        const elapsedTxt = _formatThinkTime(elapsedSec);
        const liveLen = (partial && typeof partial.cleanBufLen === 'number') ? partial.cleanBufLen : 0;
        const lenTxt = liveLen > 0 ? ` · 已输出约 ${liveLen} 字` : '';
        inner = `<div class="mr-ft-thinking-placeholder">💭 思考中 ${elapsedTxt}${lenTxt}<br><span class="mr-ft-thinking-hint">详情请点击左侧子 session 查看</span></div>`;
      }
      bottomHtml = `<div class="mr-ft-preview streaming mr-ft-preview-md">${inner}<span class="mr-ft-cursor"></span></div>`;
    } else if (blocksFromPartial || textFromPartial || textFromHistory) {
      let inner;
      if (displaySequence?.length) {
        inner=require('./conversation-message-view').renderMessageSequence(displaySequence,{escapeHtml,renderMarkdown:_renderMarkdown});
      } else if (blocksFromPartial) {
        inner = _renderPreviewBlocks(blocksFromPartial, sub.sid);
      } else if (textFromPartial) {
        inner = _renderPreviewBlocks([{ type: 'text', text: textFromPartial }], sub.sid);
      } else {
        inner = _renderPreviewBlocks([{ type: 'text', text: textFromHistory }], sub.sid);
      }
      const deliveryHtml = (status === 'completed' || status === 'manual_extracted')
        ? _renderGroupDelivery(textFromPartial || textFromHistory || '', s && s.cwd)
        : '';
      bottomHtml = `<div class="mr-ft-preview mr-ft-preview-md">${inner}${deliveryHtml}</div>`;
    } else {
      bottomHtml = '<div class="mr-ft-preview" style="opacity:0.5;font-style:italic">等待…</div>';
    }

    const aiStats = (state.aiStats && (state.aiStats[sub.sid] || state.aiStats[kind]))
      || { totalThinkSec: 0, totalTokens: 0 };
    let thinkCurrentSec = 0;
    let tokensCurrentN = 0;
    if (status === 'thinking' || status === 'streaming') {
      thinkCurrentSec = _thinkStartTs[meetingId]
        ? Math.round((Date.now() - _thinkStartTs[meetingId]) / 1000) : 0;
      if (partial && partial.tokens && typeof partial.tokens.total === 'number') {
        tokensCurrentN = partial.tokens.total;
      }
    } else if (lastTurn && lastTurn.thinkSecBy && lastTurn.thinkSecBy[sub.sid] != null) {
      thinkCurrentSec = lastTurn.thinkSecBy[sub.sid] || 0;
      tokensCurrentN = (lastTurn.tokensBy && lastTurn.tokensBy[sub.sid]) || 0;
    }
    const thinkCurrent = _formatThinkTime(thinkCurrentSec);
    const thinkTotal   = _formatThinkTime(aiStats.totalThinkSec || 0);
    const tokensCurrent = _formatTokens(tokensCurrentN);
    const tokensTotal   = _formatTokens(aiStats.totalTokens || 0);

    const sendStuck = !!(partial && partial.sendStatus === 'stuck');

    // F4 Phase 2(2026-05-04 maintainer / v3 多方审查后修订 2026-05-04): 上一轮注入血缘 chip(渲染层推断式, 不动后端)
    //   语义: "本轮卡片显示的内容"参考了"上一轮"谁的发言。
    //
    //   关键修订(v3): 用 currentMode 作为"运行中 vs idle 回顾态"的判断 (Gemini 多方审查推荐) —
    //     之前用 partial 存在与否, 但 partial 清空 vs turns push 第 N 轮 不是原子操作,
    //     存在时序窗口期内 chip 显示的轮次号会闪烁突变。currentMode 切换是后端原子动作, 更可靠。
    //
    //     场景 A: currentMode !== 'idle' (本轮运行中, 含 thinking/streaming/刚 settle/manual_extracted)
    //       → 卡片渲染本轮内容; turns 还没含本轮; lastTurn 是 N-1 轮 ✓
    //       → lineageRefTurn = lastTurn
    //
    //     场景 B: currentMode === 'idle' (回顾稳定态, 全员答完后)
    //       → 卡片渲染 turns 最后一项(=第 N 轮)的 by 内容; lastTurn 此时 = N (本轮自己)
    //       → "本轮"的"上一轮"是 turns[N-2] ≠ lastTurn ✓
    //
    //   规则: 本轮 sid X 的血缘 = lineageRefTurn.by 中除 X 外的所有 sid (排除 absent/errored)
    //   实现限制: 不点击跳转(避免 _openGcTimeline 加 initialTurnN); chip hover tooltip
    //   spec §F4 同组跳过(pilot→pilot/observer→observer)由后端 prompt 注入决定, UI 仅展示参考
    let lineageHtml = '';
    let lineageRefTurn = null;
    const turnsArr = (state && Array.isArray(state.turns)) ? state.turns : [];
    if (currentMode === 'idle' && (status === 'completed' || status === 'manual_extracted')) {
      // 场景 B: idle 回顾态(稳定) → lineage 来自 turns[N-2]
      if (turnsArr.length >= 2) lineageRefTurn = turnsArr[turnsArr.length - 2];
    } else if (currentMode && currentMode !== 'idle'
               && (status === 'thinking' || status === 'streaming'
                   || status === 'completed' || status === 'manual_extracted')) {
      // 场景 A: 本轮运行中(thinking/streaming/刚 settle 等) → lineage 来自 lastTurn (=N-1)
      lineageRefTurn = lastTurn;
    }
    if (lineageRefTurn && lineageRefTurn.by && typeof lineageRefTurn.n === 'number') {
      const refByMap = lineageRefTurn.by || {};
      const refByStatus = lineageRefTurn.byStatus || {};
      const otherSpeakers = Object.keys(refByMap).filter(s => {
        if (s === sub.sid) return false;
        const st = refByStatus[s];
        if (st === 'absent' || st === 'errored') return false;
        if (!refByMap[s] && st !== 'manual_extracted') return false;
        return true;
      });
      if (otherSpeakers.length > 0) {
        const chips = otherSpeakers.map(spkSid => {
          const spkSlot = slots.findIndex(slot => slot && slot.sid === spkSid);
          // Gemini #4 修订: 加 slots 上界检查 (虽然 findIndex 返回 -1 时已过滤, 但 length 防御深一层更稳)
          const inBounds = spkSlot >= 0 && spkSlot < slots.length && slots[spkSlot];
          const spkSlotCls = inBounds ? `slot-${spkSlot + 1}` : '';
          const spkLabel = inBounds ? slots[spkSlot].label : spkSid.slice(0, 8);
          return `<span class="mr-ft-lineage-chip ${spkSlotCls}" title="本轮内容参考了 ${escapeHtml(spkLabel)} 第 ${lineageRefTurn.n} 轮的发言">↪ ${escapeHtml(spkLabel)} 第${lineageRefTurn.n}轮</span>`;
        }).join('');
        lineageHtml = `<div class="mr-ft-lineage" title="本轮 AI 参考了上一轮谁的发言">${chips}</div>`;
      }
    }

    const html = _ftHtml(
      kind, isActive, sub.sid, labelDisplay, statusLabel, status,
      modelName, modelCls, tuningText, ctxPct, ctxCls, bottomHtml,
      thinkCurrent, thinkTotal, tokensCurrent, tokensTotal, newBadge,
      slotIndex, sendStuck, lineageHtml, !!meeting.groupChat
    );
    return { html, anyThinking };
  }

  function _renderFusedTabs(state, subs, currentMode, partialBy, meeting) {
    const meetingId = meeting && meeting.id;
    // Phase 5(2026-05-05 maintainer): 时光机模式 — viewingTurnN 设置则将 ctx 切换到该历史轮快照,
    //   _renderSlotCard 内部 "已完成轮 → 显示 lastTurn.by[sid]" 分支(line 723-735)直接复用,
    //   纯前端切换。partialBy 设为 null + currentMode 设为 'idle' 避免触发 thinking/streaming 分支。
    const viewN = _gcViewingTurnN[meetingId];
    const isTimeTravel = (typeof viewN === 'number' && viewN >= 1 && viewN <= state.turns.length);
    const effectiveLastTurn = isTimeTravel
      ? state.turns[viewN - 1]
      : (state.turns.length > 0 ? state.turns[state.turns.length - 1] : null);
    const effectivePartialBy = isTimeTravel ? null : partialBy;
    const effectiveCurrentMode = isTimeTravel ? 'idle' : currentMode;

    const tabs = [];
    const focused = (Array.isArray(meeting.subSessions) && meeting.subSessions.includes(meeting.focusedSub))
      ? meeting.focusedSub
      : meeting.subSessions[0];
    let anyThinking = false;
    const slots = _getGcSlots(meeting);
    const ctx = {
      state, currentMode: effectiveCurrentMode, partialBy: effectivePartialBy,
      meeting, slots, lastTurn: effectiveLastTurn, meetingId, focused,
      isTimeTravel,
    };
    for (let slotIndex = 0; slotIndex < slots.length; slotIndex++) {
      const { html, anyThinking: t } = _renderSlotCard(slotIndex, ctx);
      if (html) tabs.push(html);
      if (t) anyThinking = true;
    }
    if (!anyThinking && meetingId) delete _thinkStartTs[meetingId];
    const stripCls = isTimeTravel ? 'mr-ft-strip mr-ft-timetravel' : 'mr-ft-strip';
    return `<div class="${stripCls}">${tabs.join('')}</div>`;
  }

  function _renderCardViewTabs(meeting) {
    if (!_isCardTabMode() || !meeting) return '';
    const slots = _getGcSlots(meeting);
    const focused = (Array.isArray(meeting.subSessions) && meeting.subSessions.includes(meeting.focusedSub))
      ? meeting.focusedSub
      : meeting.subSessions[0];
    const items = [];
    for (let slotIndex = 0; slotIndex < slots.length; slotIndex++) {
      const slot = slots[slotIndex];
      if (!slot || !slot.sid) continue;
      const slotCls = `slot-${slotIndex + 1}`;
      const active = slot.sid === focused;
      const label = slot.label || getKindLabel(slot.kind) || `AI ${slotIndex + 1}`;
      const kind = slot.kind ? getKindLabel(slot.kind) : '';
      items.push(`<button type="button" class="mr-card-view-tab ${slotCls}${active ? ' active' : ''}" data-gc-card-tab-sid="${escapeHtml(slot.sid)}" title="${escapeHtml(kind || label)}">
        <span class="mr-card-view-tab-dot"></span>
        <span class="mr-card-view-tab-label">${escapeHtml(label)}</span>
      </button>`);
    }
    if (!items.length) return '';
    return `<div class="mr-card-view-tabs" role="tablist" aria-label="AI cards">${items.join('')}</div>`;
  }

  function _ftHtml(kind, isActive, sid, name, statusLabel, statusCls, modelName, modelCls, tuningText, ctxPct, ctxCls, bottomHtml,
                   thinkCurrent, thinkTotal, tokensCurrent, tokensTotal, newBadge, slotIndex, sendStuck, lineageHtml, isGroupChat) {
    // AI 群聊主题色按 slot 上色（slot 1/2/3 = 皮卡丘/小火龙/杰尼龟），与 kind 解耦：
    // kind 仍保留为 data-attribute 标识 AI 身份，但 CSS 视觉风格只跟槽位走，
    // 未来加任意 AI 都不需要补 CSS。
    const slotIdx = (typeof slotIndex === 'number' && slotIndex >= 0) ? slotIndex : 0;
    const slotCls = `slot-${slotIdx + 1}`;
    const cls = ['mr-ft', slotCls];
    if (isActive) cls.push('active');
    // Card redesign：thinking-card / streaming-card 触发头像 bounce 动画
    if (statusCls === 'thinking') cls.push('thinking-card');
    else if (statusCls === 'streaming') cls.push('streaming-card');
    // Phase 6(2026-05-05 maintainer): completed-card → 触发头像旁完成打勾动画(0.4s 弹出 + 留显)
    else if (statusCls === 'completed' || statusCls === 'manual_extracted') cls.push('completed-card');
    // T6（2026-05-03）：send-stuck 数据驱动，refreshGroupChatPanel 重渲后保留
    if (sendStuck) cls.push('send-stuck');

    const modelBadge = modelName ? `<span class="mr-ft-model ${slotCls}">${escapeHtml(modelName)}</span>` : '';
    const tuningBadge = tuningText ? `<span class="mr-ft-tuning">${escapeHtml(tuningText)}</span>` : '';
    const ctxBadge = ctxPct !== null ? `<span class="mr-ft-ctx ${ctxCls}">Ctx ${ctxPct}%</span>` : '';

    // AI 群聊卡片头像与 slot 位置绑定（不与 kind 绑定）。
    //   slot 1 永远皮卡丘，slot 2 永远小火龙，slot 3 永远杰尼龟，便于用户视觉识别
    //   "哪一格是哪家"。CSS 主题色亦按 slot 上色（见 .mr-ft.slot-N），kind 仅作 data-attribute。
    const avatarSrc = isGroupChat ? _groupLogoSrc(kind) : _avatarBySlot(slotIdx);
    const avatarFb = _avatarFallbackBySlot(slotIdx);
    const avatarTitle = `打开 ${name || kind || `AI ${slotIdx + 1}`} 的 CLI 会话`;
    const avatarJumpAttrs = `data-gc-open-session="${escapeHtml(sid)}" role="button" tabindex="0" title="${escapeHtml(avatarTitle)}" aria-label="${escapeHtml(avatarTitle)}"`;
    const avatarHtml = avatarSrc
      ? `<div class="mr-ft-avatar mr-session-jump" ${avatarJumpAttrs}><img src="${avatarSrc}" alt="${kind || 'slot' + (slotIdx + 1)}" onerror="this.parentNode.textContent='${avatarFb}'; this.parentNode.style.cssText+=';display:flex;align-items:center;justify-content:center;font-size:30px;'"></div>`
      : `<div class="mr-ft-avatar mr-session-jump" ${avatarJumpAttrs} style="display:flex;align-items:center;justify-content:center;font-size:30px;">${avatarFb}</div>`;

    // Stage 2 容错升级：角标（绝对定位卡片右上角）—— 区分手动提取 / 缺席态
    let cornerBadge = '';
    if (statusCls === 'manual_extracted') cornerBadge = '<span class="mr-ft-corner-badge manual">手动</span>';
    else if (statusCls === 'absent') cornerBadge = '<span class="mr-ft-corner-badge absent">缺席</span>';
    else if (statusCls === 'superseded') cornerBadge = '<span class="mr-ft-corner-badge absent">已覆盖</span>';
    else if (statusCls === 'interrupted') cornerBadge = '<span class="mr-ft-corner-badge absent">已中断</span>';

    // 2026-05-02 修订：逃生按钮**永久常驻**（用户血泪反馈：按钮"莫名其妙消失"
    //   再次发生）。无论卡片状态（idle/completed/thinking/error/...），两大按钮始终
    //   显示，给用户随时可用的兜底口：
    //     [一键提取]    — 任何状态都能从 transcript 直读拼接
    //     [跳过]        — 任何状态都能跳过本轮 / 暂停后续期待
    //   仅 [🔄 重新拉起] 保持仅终态显示（idle 没什么可拉起的，会让用户困惑）。
    //   截断提示链接（.mr-truncated-hint）仍可触发 enter-shell 切到子 session 主区。
    const isTerminalErrorState = statusCls === 'errored' || statusCls === 'absent';
    const relaunchBtn = isTerminalErrorState
      ? `<button class="mr-ft-escape-btn" data-gc-escape="resend" data-gc-sid="${sid}" data-gc-kind="${kind}" title="重新拉起该家：重发本轮 prompt">🔄 重新拉起</button>`
      : '';
    const escapeBar = `
      <div class="mr-ft-escape-bar">
        <button class="mr-ft-escape-btn" data-gc-escape="extract" data-gc-sid="${sid}" data-gc-kind="${kind}" title="从 transcript 直读拼接（卡死时绕过完成检测）">一键提取</button>
        <button class="mr-ft-escape-btn" data-gc-escape="skip" data-gc-sid="${sid}" data-gc-kind="${kind}" title="本轮跳过这家，下游 prompt 不引用">跳过</button>
        <button class="mr-ft-escape-btn" data-gc-escape="resend-prompt" data-gc-sid="${sid}" data-gc-kind="${kind}" title="重发本轮 prompt 给该家（自动判定输入框是否已含 prompt）">📤 发送</button>
        ${relaunchBtn}
      </div>`;

    // T8（2026-05-01）：row3/row4 stats 合并到 row1/row2 末尾（margin-left:auto push to right），
    //   删除 row3/row4 div，让 preview 区多 ~44px 给 markdown 内容。
    //   timeout 着色迁移：原 .mr-ft-row3.timeout .mr-ft-stat-current 高亮，
    //   现统一以 .mr-ft-row1.timeout .mr-ft-stat-inline 着色（CSS 处理）。
    const row1TimeoutCls = statusCls === 'timeout' ? ' timeout' : '';
    const timeStat = `<span class="mr-ft-stat-inline" title="本轮 / 累计 思考时间">⏱ <span class="num">${escapeHtml(thinkCurrent)}</span> · ${escapeHtml(thinkTotal)}</span>`;
    const tokenStat = `<span class="mr-ft-stat-inline" title="本轮 / 累计 token">🪙 <span class="num">${escapeHtml(tokensCurrent)}</span> · ${escapeHtml(tokensTotal)}</span>`;

    // F2 Phase 2(2026-05-04 maintainer / spec F2): hover 卡片浮出快捷操作浮条
    //   位置: 卡片右上, ↗ 按钮左侧(避免冲突)
    //   按钮: 📋 复制全文 / @ 追问 / " 引用入下轮(F6 占位, Phase 3 实施)
    //   交互: hover 卡片 0.25s 浮出, 移出消失。stopPropagation 不触发 F0 focus
    const hoverActionsHtml = `<div class="mr-ft-hover-actions">
        <button data-gc-action="copy" data-gc-sid="${sid}" title="复制本卡内容">📋</button>
        <button data-gc-action="mention" data-gc-sid="${sid}" data-gc-kind="${kind}" title="在输入框插入 @ 该家">@</button>
        <button data-gc-action="quote" data-gc-sid="${sid}" title="引用本卡内容入下一轮(Phase 3)">&ldquo;</button>
      </div>`;

    return `<div class="${cls.join(' ')}" data-ft-sid="${sid}" data-ft-kind="${kind}">
      <button class="mr-ft-expand" data-ft-expand-sid="${sid}" data-ft-expand-kind="${kind}" title="展开详细回答">↗</button>${cornerBadge}
      ${hoverActionsHtml}
      <div class="mr-ft-head">
        ${avatarHtml}
        <div class="mr-ft-info">
          <div class="mr-ft-row1${row1TimeoutCls}">
            <span class="mr-ft-name ${slotCls}">${escapeHtml(name)}</span>
            <span class="mr-ft-status ${statusCls}${sendStuck ? ' send-stuck' : ''}">${statusLabel}</span>${newBadge}
            ${timeStat}
          </div>
          <div class="mr-ft-row2">${modelBadge}${tuningBadge}${ctxBadge}${tokenStat}</div>
          ${lineageHtml || ''}
        </div>
      </div>
      <div class="mr-ft-bottom">${bottomHtml}${escapeBar}</div>
    </div>`;
  }

  // Phase 5(2026-05-05 maintainer): stepper 升级为 progress track mini-map + N/N 当前轮指示。
  //   旧版: 装饰性 dot, 不可交互, 数据来源轻; 底部独立"历史轮次 (N)"按钮折叠列表。
  //   新版: 每轮一个可 click/hover 的 dot(progress track 风, A 方案), mode 配色,
  //         当前轮蓝光圈放大, 末尾 "N/N" 数字直白显示进度。
  //         数据 attr (data-turn-n / data-turn-mode) 支持 click/hover 时光机切换。
  //         旧历史列表已被 mini-map 完全替代。
  function _renderTurnStepper(turns, currentMode, viewingTurnN) {
    const totalTurns = turns.length;
    if (totalTurns === 0 && (!currentMode || currentMode === 'idle')) return '';
    const isActive = currentMode && currentMode !== 'idle';
    // 当前 active 轮号: 非 idle 时 = totalTurns + 1(本轮还在跑); idle 时 = totalTurns(最后一轮已完成)
    const activeTurnN = isActive ? totalTurns + 1 : totalTurns;
    // 当前查看的轮号: viewingTurnN 优先(时光机模式), 否则 = activeTurnN
    const viewN = (typeof viewingTurnN === 'number' && viewingTurnN >= 1) ? viewingTurnN : activeTurnN;

    const dots = turns.map(t => {
      const isCurrent = t.n === viewN;
      const cls = `mr-gc-step-dot ${escapeHtml(t.mode)}${isCurrent ? ' current' : ''}`;
      return `<span class="${cls}" data-turn-n="${t.n}" data-turn-mode="${escapeHtml(t.mode)}" title="第 ${t.n} 轮 · ${escapeHtml(t.mode)}"></span>`;
    }).join('');
    // active(进行中)轮的 placeholder dot
    const activeDot = isActive
      ? `<span class="mr-gc-step-dot ${escapeHtml(currentMode)} active${activeTurnN === viewN ? ' current' : ''}" data-turn-n="${activeTurnN}" data-turn-active="1" title="第 ${activeTurnN} 轮 · ${escapeHtml(currentMode)} (进行中)"></span>`
      : '';
    // N/N 进度数字 — 时光机模式时显示 "viewN/totalDisplay" 蓝色, 默认显示 "current/total" 灰色
    const totalDisplay = isActive ? activeTurnN : totalTurns;
    const isViewingHistory = (typeof viewingTurnN === 'number' && viewingTurnN < activeTurnN);
    const counter = `<span class="mr-gc-step-counter${isViewingHistory ? ' viewing' : ''}">${viewN}/${totalDisplay}</span>`;
    return `<span class="mr-gc-stepper" id="mr-gc-stepper">${dots}${activeDot}${counter}</span>`;
  }

  // 2026-05-05 maintainer：用户提问 banner（A+D 混合：黄色引用条 + 单行紧凑布局）。
  //   三态：
  //     'history' — 时光机模式，蓝色边线 + 第 N 轮 chip
  //     'live'    — 进行中（用户已发但 turn-complete 未到），黄色 + ⏳进行中
  //     'latest'  — 已 idle 看最新一轮，黄色 + 第 N 轮 chip
  //   空提问（纯 debate/summary 无附加输入）→ return ''，不显示。
  function _renderUserQuestionBanner(state, meeting, viewingTurnN) {
    const meetingId = meeting && meeting.id;
    const turns = (state && Array.isArray(state.turns)) ? state.turns : [];
    const currentMode = state && state.currentMode;
    const isTimeTravel = typeof viewingTurnN === 'number' && viewingTurnN >= 1 && viewingTurnN <= turns.length;
    const isLive = !isTimeTravel && currentMode && currentMode !== 'idle';

    let bannerMode, userInput, turnNum, turnLabel;
    const _modeLabelMap = { fanout: '提问', debate: '辩论', summary: '综合' };
    if (isTimeTravel) {
      const turn = turns[viewingTurnN - 1];
      if (!turn) return '';
      userInput = (turn.userInput || '').trim();
      turnNum = viewingTurnN;
      turnLabel = _modeLabelMap[turn.mode] || turn.mode || '';
      bannerMode = 'history';
    } else if (isLive) {
      userInput = (_currentTurnUserInputByMeeting[meetingId] || '').trim();
      turnNum = turns.length + 1;
      turnLabel = '进行中';
      bannerMode = 'live';
    } else if (turns.length > 0) {
      const turn = turns[turns.length - 1];
      userInput = (turn.userInput || '').trim();
      turnNum = turn.n || turns.length;
      turnLabel = _modeLabelMap[turn.mode] || turn.mode || '';
      bannerMode = 'latest';
    } else {
      return '';
    }
    if (!userInput) return '';
    return `
      <div class="mr-gc-userq" data-mode="${bannerMode}">
        <span class="mr-gc-userq-label">💬 你的提问</span>
        <span class="mr-gc-userq-text">${escapeHtml(userInput)}</span>
        <span class="mr-gc-userq-tag">第 ${turnNum} 轮 · ${escapeHtml(turnLabel)}</span>
        <button class="mr-gc-userq-toggle" data-action="userq-toggle" title="展开/折叠全文" aria-label="展开/折叠全文">▾</button>
      </div>
    `;
  }

  function _turnStatusLabel(status) {
    return {
      idle: '待命',
      queued: '待发言',
      accepted: '已收到 · 等待执行',
      waiting: '等待你的回复',
      off: '未选',
      thinking: '思考中',
      streaming: '输出中',
      completed: '已答',
      manual_extracted: '已同步',
      absent: '缺席',
      superseded: '已被新问题覆盖',
      errored: '错误',
      timeout: '超时',
      soft_alert: '等待中',
      awaiting_binding: '等待绑定记录',
      awaiting_final_text: '正在收取答案',
      recovering: '恢复中',
      send_stuck: '输入卡住',
      interrupted: '已中断',
      transport_lost: '连接断开',
    }[status] || status || '待命';
  }

  function _slotTurnStatus(state, meeting, slot, viewingTurnN) {
    const partialBy = state && state._partialBy ? state._partialBy : {};
    const partial = partialBy[slot.sid] || null;
    const turns = (state && Array.isArray(state.turns)) ? state.turns : [];
    const currentMode = (state && state.currentMode) || 'idle';
    const lastTurn = (typeof viewingTurnN === 'number' && turns[viewingTurnN - 1])
      ? turns[viewingTurnN - 1]
      : turns[turns.length - 1];
    const allIndexes = _getGcSlots(meeting).map((s, i) => s ? i : null).filter(i => i !== null);
    const selectedSet = new Set(Array.isArray(meeting.participants) ? meeting.participants : allIndexes);
    const activeSids = _gcActiveSids[meeting.id];
    const isActiveThisTurn = activeSids
      ? activeSids.has(slot.sid)
      : selectedSet.has(slot.slotIndex);

    let status = selectedSet.has(slot.slotIndex) ? 'idle' : 'off';
    if (currentMode && currentMode !== 'idle') {
      if (partial) {
        status = partial.sendStatus === 'stuck' ? 'send_stuck' : (partial.status || 'thinking');
      } else {
        status = isActiveThisTurn ? 'thinking' : 'off';
      }
    } else if (lastTurn) {
      const byStatus = lastTurn.byStatus || {};
      if (byStatus[slot.sid]) status = byStatus[slot.sid];
      else if (lastTurn.by && lastTurn.by[slot.sid]) status = 'completed';
    }
    const failure = currentMode && currentMode !== 'idle' ? partial?.failure : lastTurn?.failureBy?.[slot.sid];
    const unknown = status === 'errored' && failure?.code === 'submission_unknown';
    return {
      status,
      label: unknown ? '待核对' : _turnStatusLabel(status),
      unknown,
      selected: selectedSet.has(slot.slotIndex),
      text: (partial && partial.text) || (lastTurn && lastTurn.by && lastTurn.by[slot.sid]) || '',
    };
  }

  function _turnStatusBucket(status) {
    if (status === 'completed' || status === 'manual_extracted') return 'done';
    if (status === 'thinking' || status === 'streaming' || status === 'soft_alert' || status === 'queued'
        || status === 'awaiting_binding' || status === 'awaiting_final_text' || status === 'recovering') return 'running';
    if (status === 'errored' || status === 'timeout' || status === 'send_stuck' || status === 'transport_lost') return 'warn';
    if (status === 'off' || status === 'absent' || status === 'superseded' || status === 'interrupted') return 'muted';
    return 'idle';
  }

  function _renderTurnProgressLane(state, meeting, viewingTurnN) {
    if (!meeting || !meeting.groupChat) return '';
    const slots = _getGcSlots(meeting).filter(Boolean);
    if (!slots.length) return '';
    const currentMode = (state && state.currentMode) || 'idle';
    const items = slots.map(slot => {
      const st = _slotTurnStatus(state, meeting, slot, viewingTurnN);
      const bucket = _turnStatusBucket(st.status);
      const label = slot.displayLabel || slot.label || slot.kind || `AI ${slot.slotIndex + 1}`;
      const actionHtml = st.unknown
        ? `<span class="mr-turn-lane-actions"><button type="button" data-gc-open-session="${escapeHtml(slot.sid)}">核对消息</button></span>`
        : (bucket === 'warn' || st.status === 'absent')
        ? `<span class="mr-turn-lane-actions">
            <button type="button" data-gc-escape="extract" data-gc-sid="${escapeHtml(slot.sid)}" data-gc-kind="${escapeHtml(slot.kind)}">提取</button>
            <button type="button" data-gc-escape="skip" data-gc-sid="${escapeHtml(slot.sid)}" data-gc-kind="${escapeHtml(slot.kind)}">跳过</button>
          </span>`
        : '';
      return `<div class="mr-turn-lane-item is-${bucket}" data-turn-lane-sid="${escapeHtml(slot.sid)}">
        <img src="${_groupLogoSrc(slot.kind)}" alt="${escapeHtml(label)}" />
        <span class="mr-turn-lane-main">
          <span class="mr-turn-lane-name">${escapeHtml(label)}</span>
          <span class="mr-turn-lane-meta">@${escapeHtml(_memberIdForSlot(slot))} · ${escapeHtml(st.label)}</span>
        </span>
        ${actionHtml}
      </div>`;
    }).join('');
    const expectedSidSet = new Set(_expectedParticipantSids(meeting));
    const expectedSlots = slots.filter(slot => expectedSidSet.has(slot.sid));
    const done = expectedSlots.filter(slot => {
      const status = _slotTurnStatus(state, meeting, slot, viewingTurnN).status;
      return status === 'completed' || status === 'manual_extracted'
        || status === 'absent' || status === 'superseded' || status === 'interrupted';
    }).length;
    const summary = currentMode && currentMode !== 'idle'
      ? `本轮 ${done}/${expectedSlots.length}`
      : `最近 ${done}/${expectedSlots.length}`;
    return `<section class="mr-turn-lane" aria-label="本轮成员进度">
      <div class="mr-turn-lane-head">
        <strong>本轮进度</strong>
        <span>${escapeHtml(summary)}</span>
      </div>
      <div class="mr-turn-lane-grid">${items}</div>
    </section>`;
  }

  function _renderNextActionBar(state, meeting, viewingTurnN) {
    if (!meeting || !meeting.groupChat) return '';
    const turns = (state && Array.isArray(state.turns)) ? state.turns : [];
    const currentMode = (state && state.currentMode) || 'idle';
    const isHistory = typeof viewingTurnN === 'number' && viewingTurnN >= 1 && viewingTurnN < turns.length;
    if (!turns.length || currentMode !== 'idle' || isHistory) return '';
    const last = turns[turns.length - 1] || {};
    const label = last.mode === 'debate' ? '辩论' : (last.mode === 'summary' ? '综合' : '提问');
    return `<section class="mr-next-actions" aria-label="下一步动作">
      <span class="mr-next-actions-label">第 ${escapeHtml(last.n || turns.length)} 轮 ${escapeHtml(label)} 已结束</span>
      <!-- 2026-07-20 maintainer：找回 codex 批改动——删除五个低频操作按钮（综合共识/互相挑错/生成交接/引用焦点卡/复制本轮）。
           03:00 工作区覆盖曾把删除回退；本次仅摘除按钮，点击委托与 _handleNextAction 保留备用。 -->
    </section>`;
  }

  function _renderCardRoster(state, meeting, viewingTurnN) {
    if (!meeting || !meeting.groupChat) return '';
    const slots = _getGcSlots(meeting).filter(Boolean);
    if (!slots.length) return '';
    const selected = new Set(Array.isArray(meeting.participants) ? meeting.participants : slots.map(slot => slot.slotIndex));
    const rows = slots.map(slot => {
      const label = slot.displayLabel || slot.label || slot.kind || `AI ${slot.slotIndex + 1}`;
      const sess = (typeof sessions !== 'undefined' && sessions) ? sessions.get(slot.sid) : null;
      const model = sess && sess.currentModel ? (typeof modelShort === 'function' ? modelShort(sess.currentModel) : sess.currentModel.displayName || sess.currentModel.id || '') : '';
      const compact = model;
      const st = _slotTurnStatus(state, meeting, slot, viewingTurnN);
      return `<button type="button" class="mr-card-roster-member ${selected.has(slot.slotIndex) ? 'selected' : ''}" data-gc-member-idx="${slot.slotIndex}">
        <img src="${_groupLogoSrc(slot.kind)}" alt="${escapeHtml(label)}" />
        <span class="mr-card-roster-main">
          <span class="mr-card-roster-name">${escapeHtml(label)}</span>
          <span class="mr-card-roster-meta">@${escapeHtml(_memberIdForSlot(slot))}${compact ? ` · ${escapeHtml(compact)}` : ''}</span>
        </span>
        <span class="mr-card-roster-side">
          <span class="mr-card-roster-status is-${_turnStatusBucket(st.status)}">${escapeHtml(st.label)}</span>

        </span>
      </button>`;
    }).join('');
    return `<section class="mr-card-roster" aria-label="群聊成员">
      <div class="mr-card-roster-head">
        <strong>成员 roster</strong>
        <span>${selected.size}/${slots.length} 已选 · 点击成员切换发言</span>
      </div>
      <div class="mr-card-roster-grid">${rows}</div>
    </section>`;
  }

  function _renderMobileWorkbench(meeting) {
    if (!meeting || !meeting.groupChat) return '';
    const slots = _getGcSlots(meeting).filter(Boolean);
    const selected = Array.isArray(meeting.participants) ? meeting.participants.length : slots.length;
    return `<nav class="mr-mobile-workbench" aria-label="群聊移动工作台">
      <button type="button" data-gc-mobile-open="members">成员 ${selected}/${slots.length}</button>
      <button type="button" data-gc-mobile-open="history">历史</button>
      <button type="button" data-gc-mobile-open="editor">展开输入</button>
    </nav>`;
  }

  function _appendPromptTemplate(meeting, text) {
    if (!meeting || !meeting.id) return;
    const input = document.getElementById('mr-input-box');
    const cur = input ? (input.innerText || input.textContent || '').trim() : '';
    _setMeetingInputText(meeting.id, cur ? `${cur}\n\n${text}` : text);
  }

  function _handleNextAction(action, meeting) {
    const state = meeting && _gcPanelState[meeting.id];
    const turns = state && Array.isArray(state.turns) ? state.turns : [];
    const last = turns[turns.length - 1] || null;
    if (action === 'synthesize') {
      _appendPromptTemplate(meeting, '请综合上一轮所有成员观点，输出：共识、分歧、建议下一步。');
      return;
    }
    if (action === 'challenge') {
      _appendPromptTemplate(meeting, '请针对上一轮结论互相挑错：每位成员只指出一个最关键风险，并说明证据。');
      return;
    }
    if (action === 'handoff') {
      _appendPromptTemplate(meeting, '请把上一轮讨论整理成 A2A 交接单：What / Why / Tradeoff / Open Questions / Next Action。');
      return;
    }
    if (action === 'quote-latest' && last && last.by) {
      const focused = meeting.focusedSub;
      const slots = _getGcSlots(meeting).filter(Boolean);
      const target = slots.find(slot => slot.sid === focused && last.by[slot.sid]) || slots.find(slot => last.by[slot.sid]);
      if (target) _addQuoteChip(meeting, target.sid, last.by[target.sid]);
    }
    // 2026-06-28 maintainer [改进4]：复制本轮全部回答（markdown：## 成员名 + 内容）
    if (action === 'copy-round' && last && last.by) {
      const slots = _getGcSlots(meeting).filter(Boolean);
      const parts = [];
      for (const slot of slots) {
        const c = last.by[slot.sid];
        if (c) {
          const name = slot.displayLabel || slot.label || slot.kind || ('AI ' + (slot.slotIndex + 1));
          parts.push('## ' + name + '\n\n' + (typeof c === 'string' ? c : (c && c.text) || ''));
        }
      }
      if (parts.length && typeof navigator !== 'undefined' && navigator.clipboard && navigator.clipboard.writeText) {
        copyGroupText(parts.join('\n\n---\n\n')).then(()=>{
          _showGcEscapeNotice('已复制本轮 ' + parts.length + ' 家回答到剪贴板', 'info');
        }).catch(()=>_showGcEscapeNotice('复制失败，请重试', 'error'));
      }
    }
  }

  function _handleMobileWorkbench(action, meeting) {
    if (action === 'members') {
      const roster = document.querySelector('.mr-card-roster, .mr-gc-side');
      if (roster && roster.scrollIntoView) roster.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      return;
    }
    if (action === 'history') {
      const btn = document.getElementById('mr-input-history-btn');
      if (btn) btn.click();
      return;
    }
    if (action === 'editor') {
      _openLongInputEditor(meeting);
      return;
    }
  }

  function _suggestedCmd(turns, currentMode) {
    if (currentMode && currentMode !== 'idle') return '';
    if (turns.length === 0) return 'ask';
    const last = turns[turns.length - 1];
    if (last.mode === 'fanout') return 'debate';
    if (last.mode === 'debate') return 'summary';
    return 'ask';
  }

  // Stage 2 容错升级：当所有参与者都 settled（completed/manual_extracted/absent/errored/interrupted）
  // 即使后端 currentMode 仍为非 idle（在写持久化），UI 也允许用户继续推进，避免 100% 等待。
  const _SETTLED_STATUSES = new Set(['completed', 'manual_extracted', 'absent', 'errored', 'interrupted', 'superseded']);
  // FIX-E（2026-05-01）：必须用"期望 sids 集合"判定，而不是 partialBy 自身的 keys。
  //   旧实现 `Object.keys(partialBy).every(...)` 在某家 watcher 还没 settle（partial 还没推送）
  //   时，partialBy 里压根没有这家的 sid → every 在剩余家都 settled 时直接为 true →
  //   推进按钮提前解锁，用户能在 Codex 卡死时先发下一轮，造成混乱。
  //   现按 expectedSids（meeting.subSessions）严格比对：每个期望 sid 都要有 settled 状态才算齐。
  function _allParticipantsSettled(partialBy, expectedSids) {
    if (!partialBy || !expectedSids || expectedSids.length === 0) return false;
    return expectedSids.every(sid =>
      partialBy[sid] && _SETTLED_STATUSES.has(partialBy[sid].status)
    );
  }

  // 2026-06-21 maintainer：判断某群聊/投研会议「本轮仍在进行且未全员结束」。
  //   与推进解锁同口径：currentMode 活跃 且 未 _allParticipantsSettled 即视为忙碌。
  //   用于发送 guard——本轮没跑完时拦截再次提问（普通群聊无超时，卡死的 AI 会让后端
  //   串行队列无限期挂起、用户第二问凭空消失）。
  function _isGroupTurnBusy(meeting) {
    if (!meeting || !_isPanelCapableMeeting(meeting)) return false;
    const st = _gcPanelState[meeting.id];
    if (!st) return false;
    const mode = st.currentMode;
    if (!mode || mode === 'idle') return false;
    const expected = Array.isArray(meeting.subSessions) ? meeting.subSessions : [];
    if (expected.length === 0) return false;
    return !_allParticipantsSettled(st._partialBy, expected);
  }

  // 2026-07-29 maintainer [群聊运行中可操作]：本轮是否还在跑 —— 决定「⏹ 停止本轮」入口的显隐。
  //   与 _isGroupTurnBusy 的区别：这里只看 currentMode，不要求"还有人没结算"。全员刚
  //   settle、后端还在落盘的窗口里用户依然可能想叫停，而下发 ESC 本身是幂等的。
  //   注意：**不用它做发送拦截**。运行中追加提问是明确支持的能力（后端抢占式结算），
  //   这个函数只负责给出"停止"入口，绝不能再退回到"运行中禁止发送"。
  function _isGroupTurnRunning(meeting) {
    if (!meeting || !_isPanelCapableMeeting(meeting)) return false;
    const st = _gcPanelState[meeting.id];
    const mode = st && st.currentMode;
    return !!(mode && mode !== 'idle');
  }

  // 「停止本轮」：向本轮所有在跑成员下发中断（后端 = watcher 结算 interrupted + PTY 写 ESC），
  //   同时停掉可能在跑的串行/循环工作流。失败诚实报错，不假装已停。
  async function _handleGcStopTurn(meeting) {
    const m = (meeting && meetingData[meeting.id]) || meeting || meetingData[activeMeetingId];
    if (!m || !m.id) return;
    try {
      const r = await ipcRenderer.invoke('groupchat:interrupt', { meetingId: m.id });
      if (!r || r.ok === false) {
        _showGcEscapeNotice('停止本轮失败：' + ((r && r.reason) || '未知'), 'error');
        return;
      }
      const n = Math.max(Array.isArray(r.stopped) ? r.stopped.length : 0, Array.isArray(r.signaled) ? r.signaled.length : 0);
      const nativePending = (m.subSessions || []).some(sid => sessions.get(sid)?.nativeRuntime?.cancellation?.status === 'pending');
      const loopTail = r.loopStopped ? '，工作流已一并停止' : '';
      _showGcEscapeNotice(n > 0
        ? nativePending ? `已发送停止请求：等待原生 Harness 确认${loopTail}` : `已停止本轮：${n} 位 AI 收到中断信号${loopTail}`
        : r.pendingDispatch
          ? `本轮正在发送中，已登记停止；发出后立即中断${loopTail}`
          : `本轮已经没有正在回答的 AI，状态已收回待命${loopTail}`);
    } catch (e) {
      _showGcEscapeNotice('停止本轮异常：' + (e && e.message ? e.message : String(e)), 'error');
    }
  }

  // E3 修复 (2026-05-03)：_renderCmdBar 删除（与 toolbar 重复的 ask/debate/summary 按钮组）。
  // _suggestedCmd / _allParticipantsSettled 仍被其他地方使用（如未来扩展）— 保留 helper 函数，删渲染。

  function _renderOnboarding(meeting) {
    // D1 v2(2026-05-05 maintainer): 删 examples 块 + scene 引用, onboarding 上移到 fusedTabs 之前。
    // 2026-05-03 maintainer精测 C1 修复：欢迎文案原写死 "三家 AI（Claude / Gemini / Codex）"，
    //   3 × claude / 任意混合配置下都显示成 Claude/Gemini/Codex → 用户困惑配置是否生效。
    //   改为按 meeting.subSessions 的实际 kind 动态生成。
    const _OB_LABEL = KIND_LABELS;
    const sids = (meeting && Array.isArray(meeting.subSessions)) ? meeting.subSessions : [];
    const labels = sids.map(sid => {
      const sess = (typeof sessions !== 'undefined' && sessions) ? sessions.get(sid) : null;
      return _OB_LABEL[sess && sess.kind] || (sess && sess.title) || 'AI';
    });
    const cnNum = ['零','一','两','三','四','五','六','七','八','九'][labels.length] || String(labels.length);
    const headText = labels.length > 0 ? `${cnNum}个 AI 已就绪` : 'AI 群聊已就位';
    const subText = labels.length > 0
      ? `${labels.join(' · ')} 等你抛话题`
      : '等你抛话题';

    // D1 Phase 4(2026-05-05 maintainer): AI 群聊角色 PNG 头像 stack(与卡片头像一致)
    // Brand character artwork is shared with ordinary chat cards.
    const slots = _getGcSlots(meeting);
    const avatarsHtml = sids.map((sid, idx) => {
      const slot = slots[idx] || {};
      const src = meeting && meeting.groupChat && slot.kind
        ? _groupLogoSrc(slot.kind)
        : _avatarBySlot(idx);
      const fb = meeting && meeting.groupChat
        ? escapeHtml((slot.displayLabel || slot.kind || `AI ${idx + 1}`).slice(0, 2))
        : _avatarFallbackBySlot(idx);
      const title = `打开 ${slot.displayLabel || slot.label || slot.kind || `AI ${idx + 1}`} 的 CLI 会话`;
      const jumpAttrs = `data-gc-open-session="${escapeHtml(sid)}" role="button" tabindex="0" title="${escapeHtml(title)}" aria-label="${escapeHtml(title)}"`;
      return src
        ? `<img src="${src}" class="mr-gc-ob-avatar mr-session-jump${meeting && meeting.groupChat ? ' group' : ''}" ${jumpAttrs} alt="slot${idx+1}" onerror="this.outerHTML='<span class=\\'mr-gc-ob-avatar-fb\\'>${fb}</span>'" />`
        : `<span class="mr-gc-ob-avatar-fb mr-session-jump" ${jumpAttrs}>${fb}</span>`;
    }).join('');

    // D1 Phase 4: 三步引导卡片 — 群聊去掉固定辩论/总结轮次暗示。
    const stepsHtml = meeting && meeting.groupChat ? `
      <div class="mr-gc-ob-step">
        <div class="mr-gc-ob-step-num">1</div>
        <div class="mr-gc-ob-step-body">
          <div class="mr-gc-ob-step-title">提问</div>
          <div class="mr-gc-ob-step-desc">勾选成员，或用 @m1 / @all 指定发言人</div>
        </div>
      </div>
      <div class="mr-gc-ob-step">
        <div class="mr-gc-ob-step-num">2</div>
        <div class="mr-gc-ob-step-body">
          <div class="mr-gc-ob-step-title">争鸣</div>
          <div class="mr-gc-ob-step-desc">成员基于历史摘要与最近原文独立回答</div>
        </div>
      </div>
      <div class="mr-gc-ob-step">
        <div class="mr-gc-ob-step-num">3</div>
        <div class="mr-gc-ob-step-body">
          <div class="mr-gc-ob-step-title">追问</div>
          <div class="mr-gc-ob-step-desc">继续点名、改勾选，或按 raw anchor 核对原文</div>
        </div>
      </div>
    ` : `
      <div class="mr-gc-ob-step">
        <div class="mr-gc-ob-step-num">1</div>
        <div class="mr-gc-ob-step-body">
          <div class="mr-gc-ob-step-title">提问</div>
          <div class="mr-gc-ob-step-desc">输入框输入问题,${labels.length || 3} 个 AI 同时启动思考</div>
        </div>
      </div>
      <div class="mr-gc-ob-step">
        <div class="mr-gc-ob-step-num">2</div>
        <div class="mr-gc-ob-step-body">
          <div class="mr-gc-ob-step-title">交叉迭代</div>
          <div class="mr-gc-ob-step-desc">他们引用彼此观点, 多轮收敛核心论点</div>
        </div>
      </div>
      <div class="mr-gc-ob-step">
        <div class="mr-gc-ob-step-num">3</div>
        <div class="mr-gc-ob-step-body">
          <div class="mr-gc-ob-step-title">总结</div>
          <div class="mr-gc-ob-step-desc">点输入框左侧 📝 总结, 选一人输出交接单</div>
        </div>
      </div>
    `;

    // D1 v3 Phase 4(2026-05-05 maintainer): head 改为占位 div, 由 _refreshOnboardingHead 动态填充。
    //   启动中(notReady>0) → 黄色启动文字, 全员 ready → 绿色"X 个 AI 已就绪"。
    //   sub 行(label list)隐藏不渲染(信息已在 head 内, 避免重复)。
    //   data-default-* 属性记录默认全员 ready 文案, 让 head refresh 函数能 fallback。
    return `<div class="mr-gc-onboarding">
      <div class="mr-gc-ob-avatars">${avatarsHtml}</div>
      <div class="mr-gc-ob-head" id="mr-gc-ob-head"
           data-default-text="${escapeHtml(headText)}"
           data-default-sub="${escapeHtml(subText)}"></div>
      <div class="mr-gc-ob-steps">${stepsHtml}</div>
    </div>`;
  }

  // H3 Phase 4(2026-05-05 maintainer): 更新 mr-header 的 meta 文字 + 进度条。
  //   meta: "已 N 轮 · ⏱ 总耗时"; 进度条: 本轮已 settled 的 sid 数 / 总人数, 渐变填充。
  //   header 骨架由 renderHeader 一次性 mount, 这里只刷新 #mr-header-meta + #mr-header-progress 内容,
  //   不动其他 listener。每次 _renderGcPanelHtml 时同步调用一次。
  function _expectedParticipantSids(meeting) {
    const subSessions = meeting && Array.isArray(meeting.subSessions) ? meeting.subSessions : [];
    // 2026-07-20 maintainer [修#3c]：进度分母过滤休眠成员——勾选但休眠的 AI 本轮收不到 prompt，
    //   计入分母会让"本轮 2/3"永远等第三家。
    const awake = subSessions.filter(sid => {
      const s = (typeof sessions !== 'undefined' && sessions) ? sessions.get(sid) : null;
      return !(s && s.status === 'dormant');
    });
    const activeSids = meeting && _gcActiveSids[meeting.id];
    if (activeSids) return awake.filter(sid => activeSids.has(sid));
    if (!meeting || !Array.isArray(meeting.participants)) return awake;
    const selected = new Set(meeting.participants);
    const idxOf = new Map(subSessions.map((sid, i) => [sid, i]));
    return awake.filter(sid => selected.has(idxOf.get(sid)));
  }

  function _updateHeaderProgress(meeting, state, mode, totalSec) {
    const metaEl = document.getElementById('mr-header-meta');
    const progEl = document.getElementById('mr-header-progress');
    if (!metaEl && !progEl) return;
    const turnsCount = (state && Array.isArray(state.turns)) ? state.turns.length : 0;
    const totalSecTxt = totalSec > 0 ? _formatThinkTime(totalSec) : null;
    // 进度计算: 非 idle = 本轮 partialBy 中 settled 的数 / 期望家总数
    //          idle    = 0/N (无活跃轮, 进度条灰色 0%)
    const expectedSids = _expectedParticipantSids(meeting);
    const total = expectedSids.length || 0;
    let done = 0;
    let isThinking = false;
    if (mode && mode !== 'idle' && state && state._partialBy) {
      for (const sid of expectedSids) {
        const p = state._partialBy[sid];
        if (p && _SETTLED_STATUSES.has(p.status)) done += 1;
      }
      isThinking = done < total;
    }
    // meta 文字
    if (metaEl) {
      const parts = [];
      if (turnsCount > 0 && !Delivery.enabled(meeting)) parts.push(`已 ${turnsCount} 轮`);
      if (totalSecTxt) parts.push(`⏱ ${totalSecTxt}`);
      if (mode && mode !== 'idle' && total > 0 && !Delivery.enabled(meeting)) {
        parts.push(`<span class="mr-header-meta-active">本轮 ${done}/${total}</span>`);
      }
      metaEl.innerHTML = parts.length ? '· ' + parts.join(' · ') : '';
    }
    // 进度条
    if (progEl) {
      if (total === 0) { progEl.style.display = 'none'; return; }
      progEl.style.display = '';
      const pct = total > 0 ? Math.round((done / total) * 100) : 0;
      progEl.classList.toggle('mr-header-progress-thinking', isThinking);
      progEl.classList.toggle('mr-header-progress-idle', !isThinking && mode === 'idle');
      progEl.innerHTML = `<div class="mr-header-progress-fill" style="width:${pct}%"></div>`;
    }
  }

  function _groupMemberMap(meeting) {
    const map = {};
    for (const slot of _getGcSlots(meeting)) {
      if (!slot || !slot.sid) continue;
      map[slot.sid] = slot;
    }
    return map;
  }

  function _groupLogoSrc(kind) {
    return _avatarSrcFor(kind) || '';
  }

  function _formatGroupChatTime(ts) {
    return ts ? formatBeijingClock(ts) : '';
  }

  function _renderGroupAvatar(slot, isUser) {
    if (isUser) return `<div class="mr-gc-avatar mr-gc-avatar-user"><img src="${require('./chat-avatar').USER_AVATAR_SRC}" alt="你 · AI Hub" /></div>`;
    if (!slot) return '<div class="mr-gc-avatar mr-gc-avatar-fallback">AI</div>';
    const label = slot.displayLabel || slot.label || slot.kind || 'AI';
    const title = `打开 ${label} 的 CLI 会话`;
    return `<div class="mr-gc-avatar mr-session-jump" data-gc-open-session="${escapeHtml(slot.sid || '')}" role="button" tabindex="0" title="${escapeHtml(title)}" aria-label="${escapeHtml(title)}"><img src="${_groupLogoSrc(slot.kind)}" alt="${escapeHtml(label)}" /></div>`;
  }

  // 2026-07-12 maintainer：watcher settle 的失败原因 → 用户能看懂的中文标签。
  //   原因来源：turn-completion-watcher 的 markErrored/markProcessExit（经
  //   orchestrator statusReason 持久化 / partial-update reason 实时透传）。
  function _gcFailReasonLabel(reason, dev = false) {
    const failure = reason && typeof reason === 'object' ? reason : null;
    const r = String((failure && failure.code) || reason || '').trim();
    if (!r) return '';
    if (r === 'submission_unknown') return '本条是否受理或完成尚未确认；请打开会话核对原生历史，Hub 不会自动重发';
    if (dev) {
      const label = { quota_exceeded: '额度已用尽', rate_limited: '请求触发限流',
        network_interrupted: '网络连接中断', provider_unavailable: '服务暂时不可用',
        context_limit: '上下文过长', runtime_exited: 'Agent 已退出',
        response_timeout: '等待回答超时', provider_error: 'Agent 本轮异常结束' }[r];
      if (label) return `${label}；已有发言保留，处理后发送“继续”接续当前阶段`;
    }
    if (r === 'quota_exceeded') return '额度已用尽；其他成员回答已保留，额度恢复或切换账号后可只重试本家';
    if (r === 'rate_limited') return '请求触发限流；请等待后只重试本家，Hub 不会自动重复发送';
    if (r === 'network_interrupted') return '网络连接中断；已保留现有输出，网络恢复后可只重试本家';
    if (r === 'provider_unavailable') return '服务暂时不可用；稍后可只重试本家';
    if (r === 'context_limit') return '上下文过长；精简上下文后可只重试本家';
    if (r === 'runtime_exited') return 'Agent 运行载体已退出；可重新拉起后只重试本家';
    if (r === 'response_timeout') return '等待回答超时；请先查看运行证据，再只重试本家';
    if (r === 'provider_error') return 'Agent 本轮异常结束；请查看运行证据后再重试';
    if (r === 'awaiting_session_resume') return '等待该成员会话唤醒后继续收取结果';
    if (r === 'transcript_binding_pending') return 'Agent 已开工，正在等待 transcript/rollout 绑定';
    if (r === 'auth_required') return '检测到登录失效横幅，可能需要 /login';
    if (/cli_self_exit/i.test(r)) return 'CLI 自行退出，PTY 回到宿主 shell';
    if (/pty exit/i.test(r)) return 'CLI 进程退出';
    if (/promise rejected/i.test(r)) return '内部等待异常';
    return r.length > 60 ? r.slice(0, 60) + '…' : r;
  }

  // Markdown answers (core/group-answer-files.js): a member's card shows the file
  // it wrote, or that it has not handed one in yet. No transcript states here —
  // problems show on the member's session in the sidebar.
  function _renderAnswerCard(message, meeting, memberBySid) {
    // 回答卡片还没有内容、但这一轮已报错：直接写出报错摘要（如模型不存在、额度用尽），旁观时能看懂为什么没交。
    function _gcAnswerFailureText(message) {
      const failure = message && message.failure && typeof message.failure === 'object' ? message.failure : null;
      if (!failure && message?.status !== 'errored') return '';
      const label = _gcFailReasonLabel(failure || message.statusReason) || '本轮异常结束';
      const detail = String(failure?.detail || '').replace(/\s+/g, ' ').trim().slice(0, 200);
      return `这一轮没完成：${label}${detail ? `。报错原文：${detail}` : ''}`;
    }
    const slot = memberBySid[message.sid];
    const session = typeof sessions !== 'undefined' && sessions.get(message.sid);
    // Unregistered messages (history before the switch, legacy fallbacks) keep their stored text;
    // registered members only ever get content from their file.
    const answer = message.answer || null, text = String(message.content || '');
    const badge = !answer ? '' : answer.state === 'draft' ? '草稿' : answer.outcome === 'rework' ? '需返工' : answer.outcome === 'blocked' ? '阻塞' : '';
    const body = text.trim()
      ? `<div class="mr-gc-md">${require('./conversation-message-view').renderMessageBody(text, { isUser: false, escapeHtml,
        renderMarkdown: t => _renderMarkdown(t, session?.cwd || meeting.workspace || _activeMeetingCwd()), foldLong: false })}</div>`
      : `<div class="mr-gc-md mr-gc-empty-placeholder">${escapeHtml(_gcAnswerFailureText(message) || '还没交')}</div>`;
    const journal = require('./groupchat-journal');
    const copy = text.trim() ? '<button type="button" class="mr-gc-copy-btn" data-gc-copy-message="1" title="复制此条消息" aria-label="复制此条消息">📋</button>' : '';
    const prompt = message.sourcePrompt ? `<button type="button" class="mr-gc-prompt-btn" data-gc-view-prompt="${escapeHtml(message.id || '')}" title="查看本轮发给该 AI 的 prompt">查看本轮输入</button>` : '';
    const time = _formatGroupChatTime(answer?.at || message.createdAt);
    const kindCls = slot && slot.kind ? ` ai-name-${slot.kind}` : '';
    // Missing output is not proof of failed submission. Default to inspection;
    // the existing explicit resend for completed answers stays in 更多.
    const resend = message.sid ? `<button type="button" class="mr-gc-retry-btn" data-gc-resend-member="${escapeHtml(message.sid)}" data-gc-retry-turn="${escapeHtml(message.turnNum || '')}" title="把本轮问题重新发给这位成员；它写好回答文件后卡片自动更新">重新发送</button>` : '';
    const inspect = message.sid ? `${message.sourcePrompt ? `<button type="button" data-gc-copy-prompt="${escapeHtml(message.id || '')}">复制本轮 Prompt</button>` : ''}<button type="button" data-gc-open-cli="${escapeHtml(message.sid)}">打开 ${escapeHtml(slot?.displayLabel || slot?.kind || message.speaker || '成员')} CLI</button>` : '';
    const unread = !!text.trim() && answer?.state !== 'draft';
    return `
      <article ${journal.attributes(meeting, message, escapeHtml, { defaultMinimized: OrchUI.defaultMinimized(meeting, message) })} class="mr-gc-msg ai${slot ? ` slot-${(slot.slotIndex || 0) + 1}` : ''}${text.trim() ? '' : ' answer-missing'}" data-gc-msg-id="${escapeHtml(message.id || '')}" data-user-question="false" data-source-sid="${escapeHtml(message.sid || '')}" data-read-turn="${escapeHtml(message.turnNum || '')}" data-unread-answer="${unread}" data-phase="message" data-answer-state="${escapeHtml(answer ? answer.state : 'none')}">
        ${_renderGroupAvatar(slot, false)}
        <div class="mr-gc-msg-body">
          <div class="mr-gc-meta"><span class="mr-gc-name${kindCls}">${escapeHtml(message.speaker || (slot && slot.displayLabel) || 'AI')}</span>${OrchUI.roleBadge(meeting, message, escapeHtml)}${badge ? `<span class="mr-gc-to-badge">${escapeHtml(badge)}</span>` : ''}${time ? `<span>${escapeHtml(time)}</span>` : ''}${OrchUI.peek(meeting, message, escapeHtml)}${journal.actions({ copy, prompt, retry: text.trim() ? resend : '', submit: text.trim() ? '' : inspect, minimize: true })}</div>
          <div class="mr-gc-bubble-row"><div class="mr-gc-bubble"><div class="gc-journal-reading">${journal.disclosure()}<div class="gc-journal-text">${body}</div></div></div></div>
        </div>
      </article>`;
  }

  function _renderGroupChatMessage(message, meeting, memberBySid, opts = {}) {
    if (!OrchUI.messageVisible(meeting, message)) return '';
    const sourceSession = typeof sessions !== 'undefined' && sessions.get(message.sid);
    const renderMarkdown = text => _renderMarkdown(text, sourceSession?.cwd || meeting.workspace || _activeMeetingCwd());
    if (!message) return '';
    if (message.role === 'assistant' && !message.systemNote && !message.supplementReply && !message.committeeAct && GroupAnswers.enabled(meeting)) {
      return _renderAnswerCard(message, meeting, memberBySid);
    }
    // 系统提示（循环自愈的每一次动作都会留一行）：不是谁的发言，不给气泡也不给重发按钮，
    // 只在时间线上留一条居中的细线 —— 但必须看得见，静默重试才是真正的损失。
    if (message.systemNote) {
      const noteTime = _formatGroupChatTime(message.createdAt);
      return `<div class="mr-gc-sysnote mr-gc-sysnote-${escapeHtml(message.noteKind || 'info')}" data-gc-msg-id="${escapeHtml(message.id || '')}">`
        + `<span class="mr-gc-sysnote-text">${escapeHtml(message.content || '')}</span>`
        + (noteTime ? `<span class="mr-gc-sysnote-time">${escapeHtml(noteTime)}</span>` : '')
        + '</div>';
    }
    const isUser = message.role === 'user';
    const slot = isUser ? null : memberBySid[message.sid];
    const slotCls = slot ? ` slot-${(slot.slotIndex || 0) + 1}` : '';
    const label = isUser ? (isDispatchCard(message)?(OrchUI.dispatchLabel(message) || '工作流'):'我') : (message.speaker || (slot && slot.displayLabel) || 'AI');
    // 投委会发言（committeeAct）：幕次 badge + 气泡左侧色条标识（折叠交给通用「长回答折叠」，不重复做）
    const cAct = message.committeeAct || '';
    let actBadge = '';
    if (cAct) {
      let bl = (cAct === '辩论' && message.committeeRound) ? `辩论·第${message.committeeRound}轮` : cAct;
      if (message.committeeSub === '收口') bl += '·收口';
      actBadge = `<span class="mr-gc-act-badge">${escapeHtml(bl)}</span>`;
    }
    const committeeCls = cAct ? ' mr-gc-committee' : '';
    const time = _formatGroupChatTime(message.createdAt);
    const status = opts.status || message.status || '';
    const sendStatus = opts.sendStatus || message.sendStatus || '';
    const sendStuck = sendStatus === 'stuck';
    // 2026-07-12 maintainer：errored 优先于 pending —— 旧逻辑 pending 期 errored 会显示
    //   「正在发言」+失败占位文案并存（截图血泪：状态矛盾）。superseded/absent 也给明确标签。
    //   组件内统一防御：settle 态（errored/absent/superseded）一律不算 pending，
    //   不依赖调用方各自清 pending flag（多方审查加固）。
    const _isSettledStatus = _isGcSettledStatus(status);
    const isPending = !!opts.pending && !_isSettledStatus;
    const cancelling = isPending && sessions.get(message.sid)?.nativeRuntime?.cancellation?.status === 'pending';
    const failureCode = String((message.failure && message.failure.code) || message.statusReason || '');
    const nativeSession=sessions.get(message.sid), nativeRuntime=nativeSession?.nativeRuntime;
    const nativeResultReady=nativeRuntime?.state === 'completed' && !!message.attemptId
      && (nativeSession?.runtimeBackend === 'claude-stream-json'
        ? nativeRuntime.submission?.clientSubmissionId === message.attemptId
        : nativeSession?.runtimeBackend === 'codex-app-server' && nativeRuntime.submission?.id === message.attemptId
          && nativeRuntime.submission?.turnId === nativeRuntime.turnId);
    const failureStatusText = failureCode === 'submission_unknown' ? (nativeResultReady ? '原生已完成 · 待同步' : '本条提交待核对')
      : failureCode === 'quota_exceeded' ? '额度中断'
      : failureCode === 'rate_limited' ? '限流中断'
        : failureCode === 'network_interrupted' ? '网络中断'
          : failureCode === 'auth_required' ? '登录失效'
            : failureCode === 'response_timeout' ? '等待超时'
              : failureCode === 'runtime_exited' ? '运行退出'
                : '本轮失败';
    const statusText = sendStuck ? '输入未提交'
      : status === 'errored' ? failureStatusText
      : cancelling ? '正在停止'
      : status === 'awaiting_binding' ? '已开工 · 等绑定'
      : status === 'awaiting_final_text' ? '已结束 · 收取中'
      : status === 'recovering' ? '恢复中'
      : status === 'queued' ? '排队中'
      : status === 'accepted' ? '已收到 · 等待执行'
      : status === 'waiting' ? '等待你的回复'
      : isPending ? '正在发言'
      : status === 'handed_off' ? '文件已交接'
      : status === 'superseded' ? '被新提问覆盖'
      : status === 'interrupted' ? '已被你停止'
      : status === 'absent' ? '已跳过'
      : '';
    const contentStr = String(message.content || '');
    const hasContent = !!contentStr.trim();
    // 2026-06-21 maintainer：「同步」是 AI 卡住/没抓到回答时手动从 shell/transcript 补抓的逃生入口，
    //   对已 completed/manual_extracted 的回答无意义且误导用户以为"没同步成功"，故仅非成功态渲染。
    // 2026-07-12 收紧：成功态但内容为空（如 PTY 干净退出兜底 settle）仍要给同步入口。
    const _syncSettled = (status === 'completed' || status === 'manual_extracted') && hasContent;
    const syncAction = (failureCode === 'submission_unknown' && !nativeResultReady && !isUser && message.sid)
      ? `<button type="button" class="mr-gc-sync-btn" data-gc-open-session="${escapeHtml(message.sid)}">核对消息</button>`
      : (!isUser && !message.sourceMessage && message.sid && !message.committeeAct && !_syncSettled)
      ? `<button type="button" class="mr-gc-sync-btn" data-gc-sync-answer="${escapeHtml(message.sid)}" data-gc-sync-turn="${escapeHtml(message.turnNum || '')}" title="按本轮身份从该 AI 的原始记录同步回答">同步</button>`
      : '';
    // 2026-07-12 maintainer：空内容的非成功态消息不再渲染成"空气泡+裸图标排"（截图血泪），
    //   按 status 给占位文案 + 失败原因，让用户知道发生了什么、下一步点哪里。
    //   settle 态即使被调用方标了 empty 也不显示"思考中"——已经结束的轮不存在"思考中"。
    let body;
    if (!isUser && Array.isArray(message.displayMessages) && message.displayMessages.length) {
      body = require('./conversation-message-view').renderMessageSequence(message.displayMessages,
        {escapeHtml,renderMarkdown,plainProgress:DevFile.enabled(meeting),activityInHeader:true,foldLong:false});
    } else if (sendStuck && !hasContent) {
      body = '<div class="mr-gc-md mr-gc-empty-placeholder">Prompt 已进入 CLI 输入框，但尚未检测到 agent 开工。Hub 已自动补按 Enter；仍未恢复时可点「再次发送」。</div>';
    } else if (opts.empty && !_isSettledStatus) {
      const waitingText = cancelling ? '正在停止，等待原生 Harness 确认'
        : status === 'queued' ? '本条消息已排队，前一条任务结束后才会发送。'
        : status === 'accepted' ? '引擎已收到本条消息，正在等待执行。'
        : status === 'waiting' ? '需要审批或回答问题，请打开该会话处理。'
        : status === 'awaiting_binding'
        ? 'Agent 已开始工作，正在等待 transcript/rollout 完成绑定；不会自动重复发送 Prompt。'
        : status === 'awaiting_final_text'
          ? '已收到结束信号，正在从 transcript 收取同一轮最终答案。'
          : status === 'recovering'
            ? 'Hub 正在按本轮凭证恢复，不会重复发送 Prompt。'
            : '思考中...';
      body = `<span class="mr-gc-waiting">${escapeHtml(waitingText)}</span>`;
    } else if (!isUser && !hasContent) {
      const reasonTxt = _gcFailReasonLabel(message.failure || message.statusReason, meeting.scene === 'dev');
      const ph = failureCode === 'submission_unknown' ? reasonTxt
        : status === 'errored'
        ? `本轮未收录最终回答${reasonTxt ? `（${reasonTxt}）` : ''}。请打开该成员会话核对状态和原始记录，再点「同步」；提交待核对时不要重复发送。`
        : status === 'handed_off' ? '阶段文件已交付；本阶段的后续发言会继续收录。'
        : status === 'superseded' ? '本轮回答被下一轮提问覆盖，未收录。'
        : status === 'interrupted' ? '你已停止本轮，该 AI 未来得及输出内容。'
        : status === 'absent' ? '本轮已跳过该 AI，无回答。'
        : '本轮未提取到内容。点「同步」从 transcript 重新提取。';
      body = `<div class="mr-gc-md mr-gc-empty-placeholder">${escapeHtml(ph)}</div>`;
    } else if (isUser && isDispatchCard(message) && OrchUI.dispatchLabel(message)) {
      // 编排群：Hub 给编排员的通知、编排员派给成员的问题，默认折叠，点开看原文。
      const notice = message.dispatch.kind === 'orch-notice';
      const firstLine = String(contentStr || '').split(/\r?\n/).map(s => s.trim()).find(s => s && s !== '【Hub 通知】') || '';
      body = `<details class="mr-gc-dispatch-details mr-orch-dispatch"><summary>${escapeHtml(notice ? 'Hub 通知编排员：' : '编排员派给 ' + (message.dispatch.toLabels || []).join('、') + '：')}${escapeHtml(firstLine.replace(/^-\s*/, '').slice(0, 90))}</summary><div class="mr-gc-md conversation-user-text">${escapeHtml(contentStr || '')}</div></details>`;
    } else if (isUser && isDispatchCard(message) && message.dispatch?.kind==='delivery') {
      body=require('./delivery-dispatch-view').render(message,escapeHtml);
    } else if (isUser && isDispatchCard(message)) {
      // 派发卡片：每轮重复的角色抬头默认折叠，本轮真正要看的内容直接展开。
      // 只折显示，不改一个字的下发内容（prompt 由 loop-workflow 负责，这里碰不到）。
      const parts = splitDispatchPrompt(contentStr);
      const headBlock = parts.head
        ? `<details class="mr-gc-dispatch-head"><summary>${escapeHtml(dispatchCollapsedTitle(parts.head))}`
          + `<span class="mr-gc-dispatch-hint">每轮重复，点开看全文</span></summary>`
          + `<div class="mr-gc-md conversation-user-text">${escapeHtml(parts.head)}</div></details>`
        : '';
      const bodyBlock = parts.body ? `<div class="mr-gc-md conversation-user-text">${escapeHtml(parts.body)}</div>` : '';
      body = headBlock + bodyBlock;
    } else {
      body = `<div class="mr-gc-md">${require('./conversation-message-view').renderMessageBody(contentStr,
        {isUser,escapeHtml,renderMarkdown,foldLong:isUser,plainProgress:DevFile.enabled(meeting) && (message.phase==='commentary' || message.status==='progress_update')})}</div>`;
    }
    if (!isUser) body = `<div class="gc-journal-reading">${require('./groupchat-journal').disclosure()}<div class="gc-journal-text">${body}</div></div>`;
    const sequence = message.displayMessages || [];
    const hasFinal = sequence.some(m=>['final','final_answer'].includes(m.phase));
    if (!isUser && !isPending && (hasFinal || ['completed','manual_extracted'].includes(status))
        && !['commentary','activity'].includes(message.phase) && message.status !== 'progress_update') {
      const tools = [...(message.toolCalls || []), ...sequence.flatMap(m=>m.toolCalls || [])];
      const text = sequence.filter(m=>['final','final_answer'].includes(m.phase)).map(m=>m.text || '').join('\n') || contentStr;
      const session = (typeof sessions !== 'undefined' && sessions.get(message.sid)) || null;
      body += _renderGroupDelivery(text, session?.cwd || meeting.workspace, tools);
    }
    const copyAction = `<button type="button" class="mr-gc-copy-btn" data-gc-copy-message="1" title="复制此条消息" aria-label="复制此条消息">📋</button>`;
    const anchorId = escapeHtml(message.id || '');
    // [查看本轮 prompt] 通用群聊功能：仅 AI 气泡 + 有存档 prompt 时显示，点开弹窗看该 AI 实际收到的 prompt。
    const promptAction = (!isUser && message.sourcePrompt)
      ? `<button type="button" class="mr-gc-prompt-btn" data-gc-view-prompt="${escapeHtml(message.id || '')}" title="查看本轮发给该 AI 的 prompt" aria-label="查看本轮 prompt">查看本轮输入</button>`
      : '';
    const attemptAction = (!isUser && message.attemptId)
      ? `<button type="button" class="mr-gc-attempt-btn" data-gc-attempt-details="${escapeHtml(message.attemptId)}" title="查看本轮运行证据与状态变化">运行凭证</button>`
      : '';
    // 2026-06-28 maintainer：每张 AI 气泡 hover 显示「重新提取」(↻) —— 本轮回答提取错/截断时，
    //   手动从该 AI 的 shell/transcript 重新同步。复用 data-gc-sync-answer 处理器
    //   (_handleGcManualSync)，传 turnNum 精确重抓该轮；pending/empty 态不显示（还没答完）。
    const nativeSource = require('../core/codex-native-runtime').isNativeSession(sourceSession)
      || require('../core/claude-native-runtime').isNativeClaude(sourceSession);
    const resyncAction = (!isUser && !nativeSource && !message.sourceMessage && message.sid && !message.committeeAct && !isPending && !(opts.empty && !_isSettledStatus))
      ? `<button type="button" class="mr-gc-resync-btn" data-gc-sync-answer="${escapeHtml(message.sid)}" data-gc-sync-turn="${escapeHtml(message.turnNum || '')}" title="提取错了？从该 AI 的 shell / transcript 重新同步本轮回答" aria-label="重新提取本轮回答">重新提取回答</button>`
      : '';
    const submitAgainAction = (!isUser && message.sid && sendStuck)
      ? `<button type="button" class="mr-gc-retry-btn is-submit" data-gc-escape="resend-prompt" data-gc-sid="${escapeHtml(message.sid)}" data-gc-retry-turn="${escapeHtml(message.turnNum || '')}" title="再次提交已进入 CLI 输入框的完整 prompt">再次发送</button>`
      : '';
    const retryParticipantAction = (failureCode !== 'submission_unknown' && meeting.scene !== 'dev' && !isUser && message.sid && !message.committeeAct && !isPending && !sendStuck)
      ? `<button type="button" class="mr-gc-retry-btn${status === 'completed' || status === 'manual_extracted' ? '' : ' is-failure'}" data-gc-retry-answer="${escapeHtml(message.sid)}" data-gc-retry-turn="${escapeHtml(message.turnNum || '')}" title="让该成员重新回答本轮问题">${status === 'completed' || status === 'manual_extracted' ? '重答' : '重试'}</button>`
      : '';
    // 派发卡片是流程自己发的，不给「作为新一轮重发/放回输入框」——那两个按钮的语义是
    // 「把我提的问题再问一遍」，对着评审指令按下去只会凭空多出一轮。
    const userTurnActions = (isUser && !isDispatchCard(message))
      ? `<button type="button" class="mr-gc-turn-action" data-gc-resend-turn="${anchorId}" title="把这条问题作为新一轮重发">重发这条消息</button><button type="button" class="mr-gc-turn-action" data-gc-edit-turn="${anchorId}" title="放回输入框编辑后再发">编辑重发</button>`
      : '';
    // 2026-06-28 maintainer [改进3]：回答字数标签（仅 AI）；[改进5]：AI 名字按 kind 上品牌色（.ai-name-<kind>）
    const kindCls = (!isUser && slot && slot.kind) ? ` ai-name-${slot.kind}` : '';
    const wordChip = (!isUser && message.content) ? `<span class="mr-gc-wordcount">${message.content.length} 字</span>` : '';
    // 「发给 X」角标：一轮里可能有两张我的卡片（工作位一张、合并位一张），
    // 不标收件人就分不清哪张是哪张。
    const recipient = isUser ? dispatchRecipientText(message) : '';
    const attemptLabel = isUser ? dispatchAttemptText(message) : '';
    const activityHeader = !isUser ? require('./conversation-message-view').renderSequenceActivity(message.displayMessages, escapeHtml) : '';
    const recipientBadge = recipient ? `<span class="mr-gc-to-badge">${escapeHtml(recipient)}</span>` : '';
    const supplementReceipt = isUser && message.supplementDelivery ? `<span class="mr-supplement-receipt">${escapeHtml(require('./supplement-receipt').format(message.supplementDelivery))}</span>` : '';
    const attemptBadge = attemptLabel ? `<span class="mr-gc-to-badge is-retry">${escapeHtml(attemptLabel)}</span>` : '';
    const journal = require('./groupchat-journal');
    const journalActions = journal.actions({copy:copyAction,prompt:isUser ? userTurnActions : promptAction,attempt:attemptAction,resync:resyncAction,retry:retryParticipantAction,submit:submitAgainAction,minimize:!isUser});
    const meta = `<div class="mr-gc-meta"><span class="mr-gc-name${kindCls}">${escapeHtml(label)}</span>${activityHeader}${recipientBadge}${supplementReceipt}${attemptBadge}${actBadge}${time ? `<span>${escapeHtml(time)}</span>` : ''}${isUser && message.interruptedNote ? '<span class="mr-gc-interrupted-note" title="本轮进行中 Hub 重启，回答已被打断">已被重启打断</span>' : ''}${wordChip}${statusText ? `<span>${escapeHtml(statusText)}</span>` : ''}${syncAction}${journalActions}</div>`;
    // 2026-05-15 maintainer 群聊弹顶 bug 修复：article 上加 data-gc-msg-id 作 partial-update
    //   局部 patch 的稳定 anchor。pending 区调用方传入 id='pending-${sid}'；真消息
    //   id 来自 orchestrator（u${n} / a${turnNum}-${sid}）。无 id 时 fallback 到空串
    //   不会阻断渲染。
    return `
      <article ${!isUser ? journal.attributes(meeting,message,escapeHtml) : ''} class="mr-gc-msg ${isUser ? 'mine' : 'ai'}${slotCls}${committeeCls}${isPending ? ' pending' : ''}${sendStuck ? ' send-stuck' : ''}" data-gc-msg-id="${anchorId}" data-user-question="${isUser && !isDispatchCard(message)}" data-source-sid="${escapeHtml(message.sid || '')}" data-read-turn="${escapeHtml(message.turnNum || '')}" data-unread-answer="${!isUser && !isPending && !!message.content && ['', 'completed', 'manual_extracted'].includes(status)}" data-phase="${escapeHtml(message.phase || (message.status === 'progress_update' ? 'commentary' : 'message'))}">
        ${!isUser ? _renderGroupAvatar(slot, false) : ''}
        <div class="mr-gc-msg-body">
          ${meta}
          <div class="mr-gc-bubble-row">
            <div class="mr-gc-bubble">${body}${isPending ? '<span class="mr-ft-cursor"></span>' : ''}</div>
          </div>
        </div>
        ${isUser ? _renderGroupAvatar(null, true) : ''}
      </article>
    `;
  }

  function _renderGroupChatPending(state, meeting, memberBySid) {
    const partialBy = state && state._partialBy ? state._partialBy : {};
    const slots = _getGcSlots(meeting).filter(Boolean);
    const currentTurn = Number(state && state.currentTurn) || 0;
    const answerMode = GroupAnswers.enabled(meeting);
    const persistedSids = new Set((state && Array.isArray(state.messages) ? state.messages : [])
      .filter(m => m && m.role === 'assistant' && Number(m.turnNum) === currentTurn
        && (answerMode ? !m.sourceMessage && m.status !== 'progress_update' && !m.supplementReply
          : (m.status === 'completed' || m.status === 'manual_extracted' || _isGcSettledStatus(m.status))))
      .map(m => m.sid));
    const parts = [];
    for (const slot of slots) {
      // 已持久化的进行中恢复结果会作为正式消息渲染；不要再叠一张“思考中”空气泡。
      if (persistedSids.has(slot.sid)) continue;
      const partial = partialBy[slot.sid];
      // 本轮真正被 dispatch 的 sid 集合（串行工作流每步只发子集）；未设置则 fallback participants。
      // 修复：之前对全员 participating 都显示 thinking 气泡，串行时只 1 个真动却全员"思考中"。
      const activeSids = _gcActiveSids[meeting.id];
      const participating = activeSids
        ? activeSids.has(slot.sid)
        : isSlotParticipatingThisTurn(meeting, slot.slotIndex);
      if (!partial && !participating) continue;
      const text = partial && partial.text ? partial.text : '';
      if (SourceFinal.matches(state?.messages,{sid:slot.sid,attemptId:partial?.attemptId,providerTurnId:partial?.providerTurnId,content:text},state?.attempts)) continue;
      const status = partial && partial.status ? partial.status : (participating ? 'thinking' : 'idle');
      const empty = !text && status !== 'errored';
      // 2026-07-12 maintainer：errored/absent 等已 settle 态不再算 pending（旧逻辑显示
      //   「正在发言」+闪烁光标与失败并存）；errored 空文本交给占位文案统一解释，
      //   并带上 watcher 的失败原因。
      // 2026-07-29 maintainer：'interrupted'（用户停止本轮）并入同一判定，防止中断后气泡
      //   继续闪光标停在"正在发言"。
      const settledPending = _isGcSettledStatus(status);
      parts.push(_renderGroupChatMessage({
        id: `pending-${slot.sid}`,
        role: 'assistant',
        sid: slot.sid,
        turnNum: state.currentTurn || '',
        speaker: slot.displayLabel || slot.label,
        content: text,
        displayMessages: partial?.displayMessages || state.displayMessagesByAttempt?.[partial?.attemptId],
        status,
        sendStatus: partial && partial.sendStatus ? partial.sendStatus : '',
        statusReason: partial && partial.reason ? partial.reason : '',
        failure: partial && partial.failure ? partial.failure : null,
        attemptId: partial && partial.attemptId ? partial.attemptId : null,
      }, meeting, memberBySid, { pending: status !== 'completed' && status !== 'manual_extracted' && !settledPending, empty, status, sendStatus: partial && partial.sendStatus }));
    }
    return parts.join('');
  }

  function _renderGroupChatView(state, meeting, softBanner, totalSecTxt) {
    const originalMessages = Array.isArray(state.messages) ? state.messages : [];
    const messages = originalMessages.map(m=>({...m,
      displayMessages:require('../core/conversation-display').groupDisplayMessages(m,
        state.displayMessagesByAttempt?.[m.attemptId] || m.displayMessages)}));
    const memberBySid = _groupMemberMap(meeting);
    const slots = _getGcSlots(meeting).filter(Boolean);
    const selected = new Set(Array.isArray(meeting.participants) ? meeting.participants : slots.map(slot => slot.slotIndex));
    const summaryCount = Array.isArray(state.summarySegments) ? state.summarySegments.length : 0;
    const rawCount = messages.length;
    const mode = state.currentMode || 'idle';
    const sideCollapsed = _getGroupSideCollapsed();
    // The source collector may recover an old canonical placeholder's final
    // answer after its progress cards. Render that source final once in order.
    // Markdown answers: one card per member per turn; transcript progress stays in the session.
    const answerCardKeys = new Set();
    const renderMessages = GroupAnswers.enabled(meeting)
      ? messages.filter(m => {
        if (m.role !== 'assistant' || m.systemNote || m.supplementReply || m.committeeAct) return true;
        if (m.sourceMessage || m.status === 'progress_update' || m.phase === 'commentary') return false;
        const key = `${m.turnNum}:${m.sid}`;
        if (answerCardKeys.has(key)) return false;
        answerCardKeys.add(key);
        return true;
      })
      : meeting.scene === 'dev' || Delivery.enabled(meeting)
      ? messages.filter(m => m.sourceMessage || m.status === 'progress_update' ? !state.displayMessagesByAttempt?.[m.attemptId]?.length : m.role !== 'assistant'
        || m.displayMessages?.length
        || !SourceFinal.matches(messages,m,state.attempts))
      : messages.slice();
    // 本地那条 pending 提问什么时候可以撤掉：等服务端把**同一条**消息写进权威历史。
    //
    // 2026-09-07：这里原来的判据是「历史里存在轮号大于 pendingUser.afterTurn 的 user 消息」。
    //   首次打开房间时还没有面板缓存，afterTurn 只能算成 0，于是昨天第 7 轮的老提问一被
    //   读回来就满足「7 > 0」，把用户刚发出、还没落盘的那条卡片凭空抹掉（评审实测）。
    //   轮号是顺序，不是身份，用它认领必然张冠李戴。改为按身份认领：内容一致 + 时间不早于发送那一刻。
    //   认领判据与去重都在 core/groupchat-pending-claim.js 里（那边能单测）。
    for (const pendingUser of unclaimedPendingUserMessages(messages, _pendingUserMessages(meeting.id))) {
      renderMessages.push({
        id: 'pending-user-' + pendingUser.clientId,
        role: 'user',
        turnNum: pendingUser.afterTurn + 1,
        content: pendingUser.content,
        createdAt: pendingUser.createdAt,
      });
    }
    // 2026-06-28 maintainer [改进R2-2]：轮次分隔线——相邻消息 turnNum 变化时插「第 N 轮」分隔，长对话结构清晰。
    let _lastTurnSep = null;
    let _lastActSep = null;
    // [幕次折叠] 预扫描各幕消息数（折叠后分隔条显示「N 条已折叠」）；折叠状态存前端临时 Set，不持久化。
    const _actCounts = {};
    for (const _m of messages) {
      if (_m && _m.committeeAct) {
        const _k = `${_m.committeeAct}#${_m.committeeRound || ''}`;
        _actCounts[_k] = (_actCounts[_k] || 0) + 1;
      }
    }
    const _collapsedSet = _gcCollapsedActs[meeting.id] || (_gcCollapsedActs[meeting.id] = new Set());
    const messageHtml = renderMessages.filter(m => OrchUI.messageVisible(meeting, m)).map(m => {
      let sep = '';
      const actKey = (m && m.committeeAct) ? `${m.committeeAct}#${m.committeeRound || ''}` : null;
      if (actKey) {
        // 投委会发言：按幕次分隔（▶ 建库 / ▶ 辩论 · 第 N 轮 / ▶ 收敛）——分隔条可点击折叠本幕全部气泡。
        if (actKey !== _lastActSep) {
          _lastActSep = actKey;
          const lbl = (m.committeeAct === '辩论' && m.committeeRound) ? `辩论 · 第 ${m.committeeRound} 轮` : m.committeeAct;
          const collapsed = _collapsedSet.has(actKey);
          const cnt = _actCounts[actKey] || 0;
          sep = `<div class="mr-gc-act-sep${collapsed ? ' collapsed' : ''}" data-gc-act-toggle="${escapeHtml(actKey)}" role="button" tabindex="0" title="点击折叠/展开本幕发言"><span class="mr-gc-act-sep-icon">${collapsed ? '▶' : '▼'}</span><span class="mr-gc-act-sep-label">${escapeHtml(lbl)}</span>${collapsed && cnt ? `<span class="mr-gc-act-sep-count">${cnt} 条已折叠</span>` : ''}</div>`;
        }
      } else {
        const tn = m && m.turnNum;
        if (tn != null && tn !== _lastTurnSep) {
          _lastTurnSep = tn;
          sep = `<div class="mr-gc-turn-sep"><span>第 ${escapeHtml(String(tn))} 轮</span></div>`;
        }
      }
      // [幕次折叠] 该幕被折叠时只保留分隔条、隐藏本幕气泡本体。
      const hidden = !!(actKey && _collapsedSet.has(actKey));
      return sep + (hidden ? '' : _renderGroupChatMessage(m, meeting, memberBySid));
    }).join('');
    const pendingHtml = mode !== 'idle' ? _renderGroupChatPending(state, meeting, memberBySid) : '';
    const viewingTurnN = _gcViewingTurnN[meeting.id];
    const progressLane = _renderTurnProgressLane(state, meeting, viewingTurnN);
    const nextActions = _renderNextActionBar(state, meeting, viewingTurnN);
    const mobileWorkbench = _renderMobileWorkbench(meeting);

    const emptyHtml = (!messageHtml && !pendingHtml) ? `
      <div class="mr-gc-empty">
        <div class="mr-gc-empty-title">${OrchUI.onlyOrchestrator(meeting) ? '还没有你和编排员的消息' : '还没有群聊消息'}</div>
        <div class="mr-gc-empty-sub">${OrchUI.onlyOrchestrator(meeting) ? '切换到“全员信息”可查看队员消息。' : '直接提问会发给当前勾选成员；输入 @m1、@m2 或 @all 可以指定发言成员。'}</div>
      </div>
    ` : '';
    const dutyHatPanel = _renderDutyHatPanel(meeting, slots);
    const memberRows = slots.map((slot) => {
      const checked = selected.has(slot.slotIndex);
      const label = slot.displayLabel || slot.label || slot.kind || 'AI';
      const s = (typeof sessions !== 'undefined' && sessions) ? sessions.get(slot.sid) : null;
      const model = s && s.currentModel ? (typeof modelShort === 'function' ? modelShort(s.currentModel) : s.currentModel.displayName || '') : '';
      const compact = model;
      const canRemove = slots.length > 1 && mode === 'idle';
      const removeTitle = slots.length <= 1
        ? '群聊至少保留一位成员'
        : mode !== 'idle' ? '本轮回答结束后可移除' : `移除 ${label}`;
      return `
        <div class="mr-gc-member-row">
          <button type="button" class="mr-gc-member ${checked ? 'selected' : ''}" data-gc-member-idx="${slot.slotIndex}">
            <span class="mr-gc-member-logo" aria-hidden="true"><img src="${_groupLogoSrc(slot.kind)}" alt="" /></span>
            <span class="mr-gc-member-main">
              <span class="mr-gc-member-name">${escapeHtml(label)}</span>
              <span class="mr-gc-member-meta">@${escapeHtml(_memberIdForSlot(slot))}${compact ? ` · ${escapeHtml(compact)}` : ''}</span>
            </span>
            <span class="mr-gc-member-side">

              <span class="mr-gc-member-check">${checked ? 'ON' : ''}</span>
            </span>
          </button>
          <button type="button" class="mr-gc-member-remove" data-gc-member-remove-sid="${escapeHtml(slot.sid)}"
                  title="${escapeHtml(removeTitle)}" aria-label="${escapeHtml(removeTitle)}" ${canRemove ? '' : 'disabled'}>移除</button>
        </div>
      `;
    }).join('');

    return `
      ${softBanner}
      <section class="mr-gc-shell ${sideCollapsed ? 'side-collapsed' : ''}" aria-label="AI 群聊">
        <main class="mr-gc-thread">

          <div class="mr-gc-tools" id="mr-gc-tools" ${_gcToolsExpanded[meeting.id] ? '' : 'hidden'}>
            <button type="button" class="gc-journal-collapse-all" data-journal-collapse-all>收起全部长回答</button>
            <div class="mr-gc-search-row"><input type="text" class="mr-gc-search" placeholder="搜索本群聊消息…" aria-label="搜索本群聊消息" /><span class="mr-gc-search-count"></span></div>
            ${progressLane}
            ${mobileWorkbench}
          </div>
          <div class="mr-gc-messages">
            ${emptyHtml}
            ${messageHtml}
            ${pendingHtml}
          </div>
          <nav id="mr-question-nav" class="card-question-nav" aria-label="问题导航" hidden></nav>
          <button type="button" class="mr-gc-scroll-bottom" data-gc-scroll-bottom="1" title="回到最新回答">↓ 最新</button>
        </main>
        <aside class="mr-gc-side" aria-label="群成员">
          <div class="mr-gc-side-head">
            <span>群成员</span>
            <span class="mr-gc-side-actions">
              <button type="button" class="mr-gc-side-add" data-gc-add-member="1" title="添加新的 AI 成员">+ 成员</button>
              <button type="button" class="mr-gc-side-collapse" data-gc-side-toggle="1" title="收起群成员">${selected.size}/${slots.length}</button>
            </span>
          </div>
          <div class="mr-gc-members">${memberRows}</div>
          ${dutyHatPanel}
          <div class="mr-gc-ledger">
            <div class="mr-gc-ledger-title">上下文</div>
            <div>摘要段：${summaryCount}</div>
            <div>原文索引：${rawCount}</div>
          </div>
        </aside>
      </section>
    `;
  }

  function _renderGcPanelHtml(state, meeting) {
    const subs = _getGcSubInfo(meeting);
    const mode = state.currentMode || 'idle';
    const partialBy = state._partialBy || null;
    const fusedTabs = _renderFusedTabs(state, subs, mode, partialBy, meeting);
    const cardViewTabs = _renderCardViewTabs(meeting);
    // 2026-05-05 maintainer：标题统一为轮次视图(不区分 general/research/dev)。
    //   不动 _scenes.getScene().name —— 那个 name 同时给 covenant prompt header 用,改了会污染发给 AI 的 prompt。
    const titleText = meeting.groupChat ? 'AI 群聊' : 'AI 群聊轮次';
    const viewingTurnN = _gcViewingTurnN[meeting.id];
    const stepper = _renderTurnStepper(state.turns, mode, viewingTurnN);
    // Phase 5: 时光机 banner — 仅 viewingTurnN 设置时渲染
    const timeTravelBanner = (typeof viewingTurnN === 'number' && viewingTurnN >= 1)
      ? `<div class="mr-gc-timetravel-banner">
          <span class="mr-gc-tt-icon">⌛</span>
          <span class="mr-gc-tt-text">时光机模式 · 第 <b>${viewingTurnN}</b> 轮 · ${escapeHtml((state.turns[viewingTurnN - 1] && state.turns[viewingTurnN - 1].mode) || '')} (只读历史)</span>
          <button class="mr-gc-tt-exit" id="mr-gc-tt-exit" data-gc-tt-exit="1">回到最新 (Esc)</button>
        </div>`
      : '';

    // F5 Phase 3(2026-05-04 maintainer 简化版): 仅整轮总耗时
    //   token + cost 因 transcript-tap 通路缺失暂不显示, 等后续扩展再启用。
    const slots = _getGcSlots(meeting);
    const aiStats = state.aiStats || {};
    let totalSec = 0;
    for (const slot of slots) {
      if (!slot || !slot.sid) continue;
      const stats = aiStats[slot.sid] || aiStats[slot.kind] || null;
      if (!stats) continue;
      totalSec += stats.totalThinkSec || 0;
    }
    const totalSecTxt = totalSec > 0 ? _formatThinkTime(totalSec) : '--';
    const costBarHtml = `<div class="mr-gc-cost-bar" title="本对话累计总耗时(三家相加)">
      <span class="mr-gc-cost-item"><span class="ico">⏱</span> 总耗时 <span class="num">${escapeHtml(totalSecTxt)}</span></span>
    </div>`;
    // FIX-E（2026-05-01）：cmdBar 推进按钮判定要按"期望家集合"，不是 partialBy 自身的 keys。
    // meeting-create-modal（2026-05-01）：期望家 = meeting.subSessions（按 slot 顺序），
    //   不再硬编码 ['claude','gemini','codex']——多 claude / DeepSeek+GLM 混搭的 AI 群聊也能正确判完成。
    const expectedSids = Array.isArray(meeting.subSessions) ? meeting.subSessions.slice() : [];
    // E3 修复 (2026-05-03)：删除 _renderCmdBar 调用 — panel 顶部按钮组与 toolbar 重复，
    //   toolbar 已覆盖所有功能，删 cmd-bar 单一来源。
    const onboarding = (state.turns.length === 0 && mode === 'idle') ? _renderOnboarding(meeting) : '';
    // Stage 2 容错升级：软提醒 banner 容器
    const softBanner = `<div id="mr-gc-soft-alert-banner" class="mr-gc-soft-alert-banner" style="display:none"></div>`;
    // pilot redesign（2026-05-02）：废弃 pilotRecaps 卡片 + 主驾占位容器（AI 群聊不再桥接子会话私聊）。
    // H3 Phase 4(2026-05-05 maintainer): 同步刷新 header 进度条 + meta(每次 panel re-render)
    _updateHeaderProgress(meeting, state, mode, totalSec);
    // Phase 4 v2(2026-05-05): panel 重渲后 onboarding head 占位空, 异步 microtask 触发 _refreshSoftAlert 填充
    setTimeout(() => { try { _refreshSoftAlert(meeting); } catch {} }, 0);
    if (meeting.groupChat) {
      return _renderGroupChatView(state, meeting, softBanner, totalSecTxt);
    }
    // D1 v2(2026-05-05 maintainer): 欢迎区从 fusedTabs 之后上移到 fusedTabs 之前,
    //   位置在 "AI 群聊" 标题正下方与 3 张 AI 卡片之间, 视觉权重更高 + 更早被注意到。
    // 2026-05-05 maintainer: 用户提问 banner 紧贴 fusedTabs 之上 — 让"标题/stepper → 你的提问 → AI 答复"
    //   形成 Q→A 视觉流。空提问/空 turns 时 banner 自动 return '' 不渲染。
    const userQBanner = _renderUserQuestionBanner(state, meeting, viewingTurnN);
    const progressLane = _renderTurnProgressLane(state, meeting, viewingTurnN);
    const nextActions = _renderNextActionBar(state, meeting, viewingTurnN);
    const cardRoster = _renderCardRoster(state, meeting, viewingTurnN);
    const mobileWorkbench = _renderMobileWorkbench(meeting);
    return `
      <div class="mr-gc-track">
        <div class="mr-gc-track-row">
          <div class="mr-gc-track-title-grp">
            <span class="mr-gc-title">${titleText}</span>
            ${stepper}
          </div>
          ${costBarHtml}
        </div>
      </div>
      ${softBanner}
      ${timeTravelBanner}
      ${onboarding}
      ${userQBanner}
      ${cardRoster}
      <section class="mr-latest-round" aria-label="最新轮回答">
        <div class="mr-latest-round-head">
          <strong>最新轮回答</strong>
          <span>卡片优先展示当前焦点成员，历史轮次从上方进度点回看</span>
        </div>
        ${cardViewTabs}
        ${fusedTabs}
      </section>
      ${mobileWorkbench}
    `;
  }


  // 主渲染：从 IPC 拿最新 state 后重绘。
  // 乐观字段（currentMode）的保留条件：**只有 _gcOptimisticTurn[id] 还在**
  // —— 也就是 IPC 还在飞行中。IPC resolve 后 _gcOptimisticTurn 已被 clearOptimistic 清，
  // 此时 server state 真实状态（含 idle）才被采纳。
  // partialBy 单独保留：轮中单家完成 IPC 推 partial-update，这是轮内增量，独立处理。
  // 2026-05-05 maintainer 修3：cache 与 DOM 解耦的设计原则
  //   旧实现：refreshGroupChatPanel 一手包办"拉 server state + merge cache + 写 DOM"，
  //     调用方必须保证 meeting 是当前 active 才能调，否则 DOM 会被错群聊内容覆盖。
  //     副作用：所有 IPC handler 都用 `meetingId !== activeMeetingId → return` 守卫，
  //     非 active AI 群聊的 cache 永远跟不上 server，切回时 partial 残留 → 卡片状态错乱。
  //   新设计：拆成两个函数 ——
  //     _syncGroupChatCacheFromServer(meeting): 纯 cache 同步，**任何 meeting 都安全调用**
  //       不动 DOM，IPC handler 在守卫之外也可调用
  //     refreshGroupChatPanel(meeting): cache sync + DOM 重渲，**仅 active meeting 调用**
  //       内含 activeMeetingId race guard（修2 内置）
  //   这样所有 AI 群聊的 cache 始终跟 server 同步，切换体验一致，杜绝残留。

  // 拉 server state + merge cache（含 optimistic 与 prev._partialBy 合并），写 _gcPanelState。
  // 不写 DOM 不调 _ensureGcPanel，任何 meeting 都能调。
  // 返回 { state, ok: bool }，ok=false 表示 server state 拉取失败或 meeting 不可 panel。
  async function _syncGroupChatCacheFromServer(meeting) {
    if (!_isPanelCapableMeeting(meeting)) return { state: null, ok: false };
    let state;
    try {
      state = await ipcRenderer.invoke('groupchat:get-state', { meetingId: meeting.id });
    } catch (e) {
      console.error('[groupchat] get-state failed:', e.message);
      return { state: null, ok: false };
    }
    if (!state) return { state: null, ok: false };
    const prev = _gcPanelState[meeting.id];
    const revisionDecision = noteGroupChatSnapshot(meeting.id, state, { consumer: 'meeting-room' });
    if (!revisionDecision.accepted && revisionDecision.reason !== 'run_mismatch' && prev) {
      return { state: prev, ok: true, stale: true };
    }
    const optimistic = _gcOptimisticTurn[meeting.id];
    if (optimistic && (!state.currentMode || state.currentMode === 'idle')) {
      // IPC 飞行期间 + server 还没 begin → 显示乐观态
      state.currentMode = optimistic.mode;
    }
    const recoverableAttempts = Object.values(state.attempts || {})
      .filter(attempt => attempt && Number(attempt.turnNum) === Number(state.currentTurn)
        && !['completed', 'failed', 'interrupted', 'superseded', 'absent'].includes(attempt.status));
    if (recoverableAttempts.length) {
      if (!state.currentMode || state.currentMode === 'idle') state.currentMode = 'recovering';
      state._partialBy = state._partialBy || {};
      for (const attempt of recoverableAttempts) {
        const previousAttempt = state._partialBy[attempt.sid] || {};
        state._partialBy[attempt.sid] = {
          ...previousAttempt,
          status: attempt.status || 'recovering',
          attemptId: attempt.attemptId,
          providerTurnId: attempt.providerTurnId || null,
          reason: attempt.reason || attempt.recoveryReason || null,
          failure: attempt.failure || null,
        };
      }
    }
    // partialBy 合并：本轮还在跑（server currentMode 非 idle）才保留 prev._partialBy 增量；
    //   server 已 idle（本轮已 settle 持久化）→ 丢 prev 残留，让 lastTurn 路径接管渲染。
    //   这条规则替代旧 `meetingId !== activeMeetingId → return` 守卫的副作用 ——
    //   非 active 期间 partial 仍会同步进 cache，但切回时如果 server 已 idle，自然不读残留。
    const serverIdle = !state.currentMode || state.currentMode === 'idle';
    if (prev && prev._partialBy && !serverIdle) {
      state._partialBy = { ...prev._partialBy, ...(state._partialBy || {}) };
    }
    _gcPanelState[meeting.id] = state;
    return { state, ok: true };
  }

  function _captureGroupChatScroll(panel, meeting) {
    if (!panel || !meeting || !meeting.groupChat) return null;
    const el = panel.querySelector('.mr-gc-messages');
    if (!el) return null;
    const maxTop = Math.max(0, el.scrollHeight - el.clientHeight);
    const bottomGap = Math.max(0, maxTop - el.scrollTop);
    return {
      scrollTop: el.scrollTop,
      stickToBottom: el._cardFollowController ? el._cardFollowController.isFollowing() : bottomGap <= 48,
    };
  }

  function _restoreGroupChatScroll(panel, snapshot, opts = {}) {
    if (!panel || !snapshot) return;
    const el = panel.querySelector('.mr-gc-messages');
    if (!el) return;
    const follow = el._cardFollowController;
    if (follow) {
      if (opts.forceBottom || snapshot.stickToBottom) follow.follow();
      else { follow.pause(); follow.restore({...follow.capture(),top:snapshot.scrollTop}); }
    } else el.scrollTop = opts.forceBottom || snapshot.stickToBottom ? el.scrollHeight : snapshot.scrollTop;
  }

  // 用户从左侧栏重新进入群聊时，“打开该会话”与普通 session 一样表示查看最新。
  // 聊天流只有一个消息滚动容器；卡片视图则每家 AI 都有自己的 preview，tab 模式
  // 还可能由外层 bottom 承担滚动，因此两层都置底。后台刷新不传此标记，仍保留阅读位置。
  function _scrollMeetingContentToBottom(panel, meeting) {
    if (!panel || !meeting) return;
    const apply = () => {
      if (meeting.groupChat) {
        const messages = panel.querySelector('.mr-gc-messages');
        if (messages?._cardFollowController) messages._cardFollowController.follow();
        else if (messages) messages.scrollTop = Math.max(0, messages.scrollHeight - messages.clientHeight);
        return;
      }
      panel.querySelectorAll('.mr-ft-preview, .mr-ft-bottom').forEach((el) => {
        el.scrollTop = Math.max(0, el.scrollHeight - el.clientHeight);
      });
    };
    apply();
    // Group follow owns subsequent layout changes. A deferred forced follow
    // would override a Home/wheel/disclosure pause made after this navigation.
    if (meeting.groupChat) return;
    requestAnimationFrame(() => {
      apply();
      requestAnimationFrame(apply);
    });
  }

  // 2026-05-15 maintainer 群聊弹顶 bug 修复：partial-update 局部 patch
  //   旧路径：partial-update 在群聊视图下走"找不到 .mr-ft → panel.innerHTML 全量重渲"
  //     兜底，每次心跳都新建 .mr-gc-messages 容器 → scrollTop 重置 0 → 用户视觉"弹顶"。
  //   新路径：本函数按 data-gc-msg-id="pending-${sid}" 找已渲染的 pending article，
  //     用 partial 最新数据 outerHTML 替换该 article 本身；.mr-gc-messages 容器 +
  //     其他兄弟 article DOM 节点完全不动，scrollTop 自然保留。
  //   返回 true 表示 patch 成功；false 让调用方走 fallback（极少见，如 pending 区
  //     还未首次渲染、参与本轮的成员名单变化等）。
  //   stickToBottom 跟随：patch 前抓底距（bottomGap≤48），patch 后若在底就 scrollTo
  //     底部，保持"用户在底部 → 跟随新内容"的微信式体验；不在底部就完全不动。
  function _patchGroupChatPendingMessage(panel, meeting, sid, state) {
    if (!panel || !meeting || !meeting.groupChat) return false;
    if (!sid || !state) return false;
    // The cache still receives this output. A hidden member needs no DOM work,
    // including the caller's full-render fallback on every streaming chunk.
    if (!OrchUI.messageVisible(meeting, { role: 'assistant', sid })) return true;
    const partial = state._partialBy && state._partialBy[sid];
    if (!partial) return false;
    const messagesEl = panel.querySelector('.mr-gc-messages');
    if (!messagesEl) return false;
    const articleEl = messagesEl.querySelector(`.mr-gc-msg[data-gc-msg-id="pending-${CSS.escape(sid)}"]`);
    if (!articleEl) return false;
    if(SourceFinal.matches(state.messages,{sid,attemptId:partial.attemptId,providerTurnId:partial.providerTurnId,content:partial.text},state.attempts)) {
      // The source final may only be in the new snapshot, not yet in the DOM.
      // Render that snapshot before dropping its temporary mirror.
      const scroll=_captureGroupChatScroll(panel,meeting);_renderGcPanelInto(panel,meeting,state,{scroll});return true;
    }
    const memberBySid = _groupMemberMap(meeting);
    const slot = memberBySid[sid];
    if (!slot) return false;
    const text = partial.text || '';
    const status = partial.status || 'thinking';
    const empty = !text && status !== 'errored';
    // 2026-07-12 maintainer：与 _renderGroupChatPending 同步——settle 态不算 pending，
    //   errored 占位文案由 _renderGroupChatMessage 统一渲染并带失败原因。
    //   2026-07-29 起 'interrupted' 走同一判定（用户停止本轮后不得再显示"正在发言"）。
    const settledPending = _isGcSettledStatus(status);
    const newHtml = _renderGroupChatMessage({
      id: `pending-${sid}`,
      role: 'assistant',
      sid,
      turnNum: state.currentTurn || '',
      speaker: slot.displayLabel || slot.label,
      content: text,
      displayMessages: partial.displayMessages || state.displayMessagesByAttempt?.[partial.attemptId],
      status,
      sendStatus: partial.sendStatus || '',
      statusReason: partial.reason || '',
    }, meeting, memberBySid, { pending: status !== 'completed' && status !== 'manual_extracted' && !settledPending, empty, status, sendStatus: partial.sendStatus });
    const scroll = _captureGroupChatScroll(panel, meeting);
    const replacement=document.createElement('div');
    replacement.innerHTML=newHtml;
    require('./conversation-message-view').patchConversationArticle(articleEl,replacement.firstElementChild);
    require('./groupchat-journal').enhance(panel);
    _enhanceGroupCardContent(articleEl);
    _restoreGroupChatScroll(panel, scroll);
    return true;
  }

  async function refreshGroupChatPanel(meeting, opts = {}) {
    if (!_isPanelCapableMeeting(meeting)) { _removeGcPanel(); return; }
    const { state, ok } = await _syncGroupChatCacheFromServer(meeting);
    if (!ok) return;
    // 修2：async race guard — await 期间用户切走，老 refresh 不写 DOM（避免 panel 被错群聊内容覆盖）
    if (meeting.id !== activeMeetingId) return;
    const panel = _ensureGcPanel();
    const forceMeetingBottom = opts.forceMeetingBottom === true;
    const forceGroupChatBottom = (forceMeetingBottom || !!opts.forceGroupChatBottom)
      && !!meeting.groupChat;
    const groupScroll = forceGroupChatBottom
      ? { scrollTop: 0, stickToBottom: true }
      : _captureGroupChatScroll(panel, meeting);
    _renderGcPanelInto(panel, meeting, state, {
      scroll: groupScroll,
      restoreOpts: { forceBottom: forceGroupChatBottom },
      forceMeetingBottom,
    });
    // 2026-06-28 maintainer：nextActions(综合共识/互相挑错/生成交接/引用焦点卡)已移到作战面板，
    //   轮次状态随每次 refresh 变化，故同步刷新作战面板，让按钮在轮次结束时即时出现/消失。
    _updateInputPreflight(meeting);
  }

  // 2026-06-28 maintainer [改进R2-5]：群聊内消息搜索——实时过滤，匹配正常显示、不匹配淡化，显示计数 + 滚到首个匹配。
  function _setupGcSearch(panel) {
    if (!panel) return;
    const input = panel.querySelector('.mr-gc-search');
    const msgEl = panel.querySelector('.mr-gc-messages');
    if (!input || !msgEl || input.dataset.searchBound) return;
    input.dataset.searchBound = '1';
    input.addEventListener('input', () => {
      const kw = input.value.trim().toLowerCase();
      const msgs = msgEl.querySelectorAll('.mr-gc-msg');
      let hits = 0, first = null;
      msgs.forEach(m => {
        const md = m.querySelector('.mr-gc-md');
        const txt = ((md ? md.textContent : m.textContent) || '').toLowerCase();
        const hit = !kw || txt.indexOf(kw) >= 0;
        m.classList.toggle('mr-gc-search-dim', !!kw && !hit);
        if (kw && hit) { hits++; if (!first) first = m; }
      });
      const cnt = panel.querySelector('.mr-gc-search-count');
      if (cnt) cnt.textContent = kw ? (hits + ' 条匹配') : '';
      if (kw && first) first.scrollIntoView({ block: 'center', behavior: 'smooth' });
    });
  }

  // 2026-06-28 maintainer [改进R2-1]：代码块一键复制——给 AI 回答 markdown 代码块加复制按钮 + 语言标签。
  function _enhanceCodeBlocks(panel) {
    if (!panel) return;
    panel.querySelectorAll('.mr-gc-md pre').forEach(pre => {
      if (pre.dataset.codeEnhanced) return;
      pre.dataset.codeEnhanced = '1';
      const code = pre.querySelector('code');
      const m = code && code.className && code.className.match(/language-([\w-]+)/);
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'mr-gc-code-copy';
      btn.setAttribute('data-gc-copy-code', '1');
      btn.textContent = m ? (m[1] + ' · 复制') : '复制';
      pre.appendChild(btn);
    });
  }

  // 2026-06-28 maintainer [改进2]：回到最新悬浮按钮——群聊滚离底部超 240px 时显示，点击回到最新。
  //   .mr-gc-messages 每次重渲都重绑 scroll（scroll 事件不冒泡，无法委托）。
  function _setupScrollToBottom(panel) {
    const el = panel?.querySelector('.mr-gc-messages'), button = panel?.querySelector('.mr-gc-scroll-bottom');
    if (!el || !button || el._cardFollowController) return;
    const follow = require('./card-follow-scroll').createCardFollowScroll({element:el,window,document,button});
    follow.activate(activeMeetingId);
  }

  // Whole-response journal disclosure also covers native message sequences.
  function _applyLongAnswerCollapse(panel) {
    require('./groupchat-journal').enhance(panel);
  }

  // 绑定 panel 内部所有交互（折叠 / 卡片点击）。每次 innerHTML 重绘后都要重新调用。
  // T2（2026-05-04 maintainer）：单 slot 卡片的事件绑定独立成函数，让 partial-update 局部 patch 后只 rebind 单卡片。
  //   覆盖范围：① 卡片本体 click（focus session）② ↗ 展开按钮 ③ [data-gc-escape] 工具栏按钮组。
  //   不覆盖：soft-alert banner-close / mr-gc-ob-card（这些是 panel 级，由 _bindGcPanelEvents 管）。
  function _showGcEscapeNotice(message, level = 'warn') {
    const banner = document.getElementById('mr-gc-soft-alert-banner');
    if (!banner) return false;
    const cls = level === 'error' ? 'urgent' : 'warn';
    banner.className = `mr-gc-soft-alert-banner ${cls}`;
    banner.innerHTML = `
      <div class="mr-gc-soft-alert-msg">
        <strong>${escapeHtml(level === 'error' ? '操作失败' : '提示')}</strong>
        <span class="mr-gc-soft-alert-hint">${escapeHtml(message || '')}</span>
      </div>
      <button class="mr-gc-soft-alert-close" data-gc-banner-close="1" title="关闭提示">×</button>`;
    banner.style.display = 'flex';
    const close = banner.querySelector('[data-gc-banner-close]');
    if (close) close.addEventListener('click', () => { banner.style.display = 'none'; banner.innerHTML = ''; }, { once: true });
    return true;
  }

  function _bindSlotCardEvents(slotEl, meeting) {
    if (!slotEl) return;
    slotEl.__mrSlotMeeting = meeting || null;
  }

  function _eventTargetEl(target) {
    if (!target) return null;
    return target.nodeType === 1 ? target : target.parentElement;
  }

  function _closestInPanel(target, selector, panel) {
    const start = _eventTargetEl(target);
    const el = start && typeof start.closest === 'function' ? start.closest(selector) : null;
    return el && panel && panel.contains(el) ? el : null;
  }

  function _currentGcPanelMeeting(panel) {
    const meeting = panel && panel.__mrGcMeeting;
    return meeting && meeting.id ? (meetingData[meeting.id] || meeting) : meeting;
  }

  function _openMeetingMemberSession(sid) {
    if (!sid) return false;
    if (typeof window !== 'undefined' && typeof window.openMeetingMemberSession === 'function') {
      return window.openMeetingMemberSession(sid) !== false;
    }
    // Backward-compatible fallback for older renderer shells and focused tests.
    if (typeof selectSession === 'function') {
      void selectSession(sid, { forceScrollBottom: true });
      return true;
    }
    console.warn('[meeting-avatar] session navigation is not available:', sid);
    return false;
  }

  function _handleSlotCardClick(card, ev, meeting) {
    const sid = card.getAttribute('data-ft-sid');
    if (!sid) return;
    _readVisibleMemberCard(meeting, sid);
    if (_isCardTabMode()) return;
    if (ev && (ev.ctrlKey || ev.metaKey)) {
      ev.stopPropagation();
      _toggleCompareSelect(sid);
      return;
    }
    if (_gcCompareSlots.size > 0) _clearCompareSelect();
    if (_gcFocusedCardSid) {
      if (_gcFocusedCardSid !== sid) {
        _gcFocusedCardSid = null;
        document.body.classList.remove('mr-card-focus-on');
      }
      return;
    }
    _focusGroupChatSession(meeting, sid);
    _gcFocusedCardSid = sid;
    document.body.classList.add('mr-card-focus-on');
  }

  async function _handleGcEscapeAction(btn, meeting) {
    if (btn.hasAttribute('disabled')) return;
    const action = btn.getAttribute('data-gc-escape');
    const sid = btn.getAttribute('data-gc-sid');
    const kind = btn.getAttribute('data-gc-kind');
    if (!sid) return;
    btn.disabled = true;
    const oldText = btn.textContent;
    btn.textContent = '...';
    let _btnTextHandledExternally = false;
    try {
      if (action === 'extract') {
        const r = await ipcRenderer.invoke('groupchat-manual-extract', {
          meetingId: meeting.id, sid, sincePromptTs: _gcTurnStartTs[meeting.id] || 0,
        });
        if (!r || !r.ok) {
          console.warn(`[rt-escape] extract failed: ${r?.reason} (${r?.detail || ''})`);
          const detail = r?.detail ? `：${r.detail}` : '';
          _showGcEscapeNotice(`提取失败（${r?.reason || 'unknown'}）${detail}`, 'error');
        } else {
          const charCount = (r.text || '').length;
          console.log(`[rt-escape] extract ok: ${kind} got ${charCount} chars (mode=${r.mode}, source=${r.source})`);
          btn.style.background = '#2da44e';
          btn.style.color = '#fff';
          btn.textContent = `✓ 已同步 ${charCount}字`;
          _btnTextHandledExternally = true;
          setTimeout(() => {
            btn.style.background = '';
            btn.style.color = '';
            btn.textContent = oldText;
            btn.disabled = false;
          }, 1500);
        }
      } else if (action === 'skip') {
        const r = await ipcRenderer.invoke('groupchat-skip-participant', { meetingId: meeting.id, sid });
        if (!r || !r.ok) console.warn(`[rt-escape] skip failed: ${r?.reason}`);
      } else if (action === 'enter-shell') {
        _openMeetingMemberSession(sid);
      } else if (action === 'resend-prompt') {
        const turnRaw = parseInt(btn.getAttribute('data-gc-retry-turn') || '', 10);
        const r = await ipcRenderer.invoke('groupchat-resend-prompt', {
          meetingId: meeting.id,
          sid,
          turnNum: Number.isFinite(turnRaw) ? turnRaw : undefined,
        });
        if (r && r.ok) {
          btn.style.background = '#2da44e';
          btn.style.color = '#fff';
          btn.textContent = `✓ 已重发`;
          _btnTextHandledExternally = true;
          const cachedForResend = _gcPanelState[meeting.id];
          if (cachedForResend && cachedForResend._partialBy && cachedForResend._partialBy[sid]) {
            delete cachedForResend._partialBy[sid].sendStatus;
          }
          refreshGroupChatPanel(meeting);
          setTimeout(() => {
            btn.style.background = '';
            btn.style.color = '';
            btn.textContent = oldText;
            btn.disabled = false;
          }, 1500);
        } else {
          _showGcEscapeNotice(`再次发送失败：${r?.detail || r?.reason || 'unknown'}。可进入该成员 Session 查看 CLI，或先跳过。`, 'error');
        }
      } else if (action === 'resend') {
        const r = await ipcRenderer.invoke('groupchat-resend-participant', { meetingId: meeting.id, sid });
        if (r && r.ok) {
          console.log(`[rt-escape] resend ok: ${kind}`);
        } else {
          _showGcEscapeNotice(`成员重试失败：${r?.detail || r?.reason || 'unknown'}`, 'error');
        }
      }
    } catch (err) {
      console.error(`[rt-escape] ${action} threw:`, err);
      if (action === 'resend-prompt') {
        _showGcEscapeNotice(`再次发送失败：${err && err.message ? err.message : 'unknown'}`, 'error');
      }
    } finally {
      if (!_btnTextHandledExternally) {
        btn.disabled = false;
        btn.textContent = oldText;
      }
    }
  }

  async function _handleSlotHoverAction(btn) {
    const action = btn.getAttribute('data-gc-action');
    const f2Kind = btn.getAttribute('data-gc-kind');
    const card = btn.closest('.mr-ft');
    if (action === 'copy') {
      const previewText = extractVisibleCardText(
        card?.querySelector('.mr-ft-preview') || card?.querySelector('.mr-ft-bottom')
      );
      if (!previewText) {
        const oldT = btn.textContent;
        btn.textContent = '空';
        setTimeout(() => { btn.textContent = oldT; }, 1000);
        return;
      }
      try {
        await copyGroupText(previewText);
        const oldT = btn.textContent;
        btn.textContent = '✓';
        btn.style.background = '#2da44e';
        btn.style.color = '#fff';
        setTimeout(() => {
          btn.textContent = oldT;
          btn.style.background = '';
          btn.style.color = '';
        }, 1200);
      } catch (e) {
        console.warn('[hover-actions] copy failed:', e);
      }
    } else if (action === 'mention') {
      const input = document.getElementById('mr-input-box');
      if (input) {
        const labelEl = card?.querySelector('.mr-ft-name');
        const fullLabel = (labelEl?.textContent || f2Kind || '').trim();
        const cleanLabel = fullLabel.replace(/^[^A-Za-z0-9_一-鿿]+/, '');
        const shortLabel = cleanLabel.split(/[·\s]/)[0] || f2Kind || '';
        const cur = input.innerText || '';
        _renderComposerRaw(input, (cur && !cur.endsWith(' ') ? cur + ' ' : cur) + `@${shortLabel} `);
        input.focus();
        if (typeof _placeCaretAtEnd === 'function') _placeCaretAtEnd(input);
      }
    } else if (action === 'quote') {
      const sid = btn.getAttribute('data-gc-sid');
      const meeting = activeMeetingId ? (meetingData[activeMeetingId] || null) : null;
      const previewText = (card?.querySelector('.mr-ft-preview')?.innerText || card?.querySelector('.mr-ft-bottom')?.innerText || '').trim();
      if (meeting && sid && previewText) {
        _addQuoteChip(meeting, sid, previewText);
        const oldT = btn.textContent;
        btn.textContent = '引';
        btn.classList.add('quoted');
        setTimeout(() => {
          btn.textContent = oldT;
          btn.classList.remove('quoted');
        }, 1000);
      }
    }
  }

  async function _handleGcMessageCopy(btn) {
    const msgEl = btn.closest('.mr-gc-msg');
    const text = extractVisibleCardText(msgEl?.querySelector('.mr-gc-bubble'));
    const oldHtml = btn.innerHTML;
    if (!text) {
      btn.textContent = '空';
      setTimeout(() => { btn.innerHTML = oldHtml; }, 900);
      return;
    }
    try {
      const result = await clipboardController.copyText(text, { source: 'group-card', silent: true });
      if (result?.ok === false) throw new Error(result.reason || 'clipboard-write-failed');
      btn.textContent = '✓';
      btn.classList.add('copied');
      setTimeout(() => {
        btn.innerHTML = oldHtml;
        btn.classList.remove('copied');
      }, 1200);
    } catch (e) {
      console.warn('[groupchat] copy message failed:', e);
      btn.textContent = '复制失败';
      setTimeout(() => { btn.innerHTML = oldHtml; }, 1200);
    }
  }

  // [查看本轮 prompt] 从 _gcPanelState 缓存按 message.id 取该条消息存档的 sourcePrompt，弹窗 markdown 渲染。
  function _handleGcViewPrompt(btn, meeting) {
    const msgId = btn.getAttribute('data-gc-view-prompt');
    const cached = meeting && _gcPanelState[meeting.id];
    const msg = cached && Array.isArray(cached.messages) ? cached.messages.find(m => m && m.id === msgId) : null;
    const prompt = msg && msg.sourcePrompt ? String(msg.sourcePrompt) : '';
    _showGcPromptModal(prompt, msg);
  }

  async function _copyConversationPrompt(meeting, target) {
    // Read fresh evidence, but never regenerate or submit the archived input.
    const state = await ipcRenderer.invoke('groupchat:get-state', { meetingId: meeting.id });
    const current = meetingData[meeting.id];
    const run = current?.serialWorkflow?.serialRunState;
    if (activeMeetingId !== meeting.id || run?.runId !== target.runId
      || Number(run.currentStepIndex ?? run.nextStepIndex ?? 0) !== target.stepIndex) {
      throw new Error('本轮已变化，请重新查看接力状态');
    }
    const latest = ConversationRelay.targets(current, run, state).find(m => m.sid === target.sid);
    if (!latest?.prompt || latest.attemptId !== target.attemptId) throw new Error('本轮完整 Prompt 暂无可用存档，请先查看 CLI');
    await _copyArchivedGroupPrompt(latest.prompt, latest.label, meeting.id);
  }

  async function _copyArchivedGroupPrompt(prompt, label, meetingId) {
    if (!prompt?.trim()) throw new Error('本轮完整 Prompt 暂无可用存档，请先查看 CLI');
    let result;
    try { result = await clipboardController.copyText(prompt, { source: 'group-relay-prompt', silent: true }); }
    catch (error) { result = { ok: false, reason: error.message }; }
    if (activeMeetingId !== meetingId) return;
    if (result?.ok) _showGcEscapeNotice('已复制本轮完整 Prompt；请先核对 CLI，避免重复发送。', 'info');
    else _showGcPromptModal(prompt, { speaker: label }, {
      title: '复制失败 · 可选中下方原文复制', raw: true,
      footer: '这是本轮存档全文，不代表 CLI 已接收；先核对 CLI，手动发送前暂停接力。',
    });
  }

  async function _openConversationCli(meeting, target) {
    if (activeMeetingId !== meeting.id || !meetingData[meeting.id]?.subSessions?.includes(target.sid)) return;
    const result = await window.openMeetingMemberCli?.(target.sid);
    if (!result?.ok) throw new Error(result?.reason || '暂时无法打开该成员 CLI');
  }

  async function _handleGcAttemptDetails(btn, meeting) {
    const attemptId = btn.getAttribute('data-gc-attempt-details');
    await _syncGroupChatCacheFromServer(meeting);
    const state = meeting && _gcPanelState[meeting.id];
    const attempt = state && state.attempts && state.attempts[attemptId];
    const events = state && Array.isArray(state.attemptEvents)
      ? state.attemptEvents.filter(event => event && event.attemptId === attemptId).slice(-40)
      : [];
    const lines = ['## 本轮运行凭证'];
    if (attempt) {
      lines.push(
        `- 状态：${attempt.status || 'unknown'}`,
        `- Attempt：${attempt.attemptId || attemptId}`,
        `- Run：${attempt.runId || '—'}`,
        `- 群聊轮次：${attempt.turnNum || '—'}`,
        `- Provider Turn：${attempt.providerTurnId || '尚未绑定'}`,
        `- 提交依据：${attempt.acknowledgementSource || '尚未确认'}`,
        `- 当前原因：${_gcFailReasonLabel(attempt.failure || attempt.reason || attempt.recoveryReason) || '—'}`,
      );
    } else {
      lines.push('- 这是旧消息，尚无结构化 attempt 记录。');
    }
    lines.push('', '## 最近状态变化');
    if (!events.length) lines.push('- 暂无事件记录');
    for (const event of events) {
      const at = event.at ? _formatGroupChatTime(event.at) : '';
      const detail = [event.status, event.reason, event.source, event.providerTurnId].filter(Boolean).join(' · ');
      lines.push(`- ${at || '—'} · ${event.type || 'event'}${detail ? ` · ${detail}` : ''}`);
    }
    _showGcPromptModal(lines.join('\n'), { speaker: '运行证据' }, {
      title: '本轮运行证据',
      footer: '只记录状态、时间、来源与哈希等元数据，不复制思考过程或完整 Prompt',
    });
  }

  // 自建 DOM overlay（非浏览器原生 dialog，符合禁用 alert/confirm 铁律）。点遮罩 / ✕ / Esc 关闭。
  function _showGcPromptModal(prompt, msg, options = {}) {
    const existing = document.querySelector('.mr-gc-prompt-modal-overlay');
    if (existing) { try { existing.remove(); } catch {} }
    const overlay = document.createElement('div');
    overlay.className = 'mr-gc-prompt-modal-overlay';
    const who = msg && msg.speaker ? escapeHtml(msg.speaker) : 'AI';
    const actLbl = (msg && msg.committeeAct)
      ? `<span class="mr-gc-prompt-modal-act">${escapeHtml(msg.committeeAct)}${msg.committeeRound ? ' 第' + escapeHtml(String(msg.committeeRound)) + '轮' : ''}</span>`
      : '';
    const bodyHtml = prompt
      ? options.raw ? `<textarea class="mr-gc-prompt-raw" readonly aria-label="本轮存档 Prompt 原文">${escapeHtml(prompt)}</textarea>` : `<div class="mr-gc-md">${_renderMarkdown(prompt)}</div>`
      : '<div class="mr-gc-prompt-empty">这条消息没有存档 prompt——通常是「查看 prompt」功能上线前产生的旧消息，重新发起一轮即可记录。</div>';
    overlay.innerHTML = `
      <div class="mr-gc-prompt-modal" role="dialog" aria-modal="true">
        <div class="mr-gc-prompt-modal-head">
          <span class="mr-gc-prompt-modal-title">${options.title ? escapeHtml(options.title) : `📥 ${who} 本轮存档的 prompt`}</span>
          ${actLbl}
          <span class="mr-gc-prompt-modal-spacer"></span>
          <button type="button" class="mr-gc-prompt-modal-copy" title="复制 prompt 原文">复制</button>
          <button type="button" class="mr-gc-prompt-modal-close" title="关闭 (Esc)" aria-label="关闭">✕</button>
        </div>
        <div class="mr-gc-prompt-modal-body">${bodyHtml}</div>
        <div class="mr-gc-prompt-modal-foot">${options.footer ? escapeHtml(options.footer) : (prompt ? prompt.length + ' 字 · 本轮准备发送的完整输入，接收状态以 CLI 为准' : '')}</div>
      </div>`;
    document.body.appendChild(overlay);
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    const close = () => { try { overlay.remove(); } catch {} document.removeEventListener('keydown', onKey); };
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
    const closeBtn = overlay.querySelector('.mr-gc-prompt-modal-close');
    if (closeBtn) closeBtn.addEventListener('click', close);
    const copyBtn = overlay.querySelector('.mr-gc-prompt-modal-copy');
    if (copyBtn) copyBtn.disabled = !prompt;
    if (copyBtn) copyBtn.addEventListener('click', async () => {
      let result;
      try { result = await clipboardController.copyText(prompt, { source: 'group-prompt', silent: true }); }
      catch (error) { result = { ok: false, reason: error.message }; }
      copyBtn.textContent = result?.ok ? '已复制 ✓' : '复制失败';
      setTimeout(() => { try { copyBtn.textContent = '复制'; } catch {} }, 1200);
    });
    document.addEventListener('keydown', onKey);
  }

  async function _handleGcManualSync(btn, meeting) {
    if (btn.disabled) return;
    const sid = btn.getAttribute('data-gc-sync-answer');
    const turnRaw = parseInt(btn.getAttribute('data-gc-sync-turn') || '', 10);
    if (!sid) return;
    const oldText = btn.textContent;
    btn.disabled = true;
    btn.textContent = '同步中';
    try {
      const payload = {
        meetingId: meeting.id,
        sid,
        turnNum: Number.isFinite(turnRaw) ? turnRaw : undefined,
        sincePromptTs: _gcTurnStartTs[meeting.id] || 0,
      };
      const r = await ipcRenderer.invoke('groupchat-manual-extract', payload);
      if (!r || !r.ok) {
        const detail = r && (r.detail || r.reason) ? (r.detail || r.reason) : 'unknown';
        _showGcEscapeNotice(`同步失败：${detail}`, 'error');
        // 2026-07-12：按钮短暂文案写全「同步失败」——旧文案裸「失败」出现在
        //   "正在发言"旁边时被误读成 AI 回答失败（截图血泪）。
        btn.textContent = '同步失败';
        setTimeout(() => { btn.textContent = oldText; btn.disabled = false; }, 1500);
        return;
      }
      btn.textContent = '已同步';
      btn.classList.add('ok');
      await refreshGroupChatPanel(meeting);
      setTimeout(() => {
        btn.textContent = oldText;
        btn.classList.remove('ok');
        btn.disabled = false;
      }, 1200);
    } catch (e) {
      _showGcEscapeNotice(`同步失败：${e && e.message ? e.message : String(e)}`, 'error');
      btn.textContent = '同步失败';
      setTimeout(() => { btn.textContent = oldText; btn.disabled = false; }, 1500);
    }
  }

  function _groupMessageById(meeting, messageId) {
    const cached = meeting && _gcPanelState[meeting.id];
    return cached && Array.isArray(cached.messages)
      ? cached.messages.find(message => message && message.id === messageId)
      : null;
  }

  async function _handleGcUserTurnAction(btn, meeting, editOnly) {
    const attr = editOnly ? 'data-gc-edit-turn' : 'data-gc-resend-turn';
    const message = _groupMessageById(meeting, btn.getAttribute(attr));
    const text = message && String(message.content || '').trim();
    if (!text) {
      _showGcEscapeNotice('这条问题没有可重发的正文', 'error');
      return;
    }
    if (editOnly) {
      const recovery = _restoreQuestionAndPreserveDraft(meeting.id, text);
      _showGcEscapeNotice(recovery.mergedWithDraft
        ? '问题已放回输入框，并保留了你当前的草稿'
        : '问题已放回输入框，可编辑后发送', 'info');
      return;
    }
    btn.disabled = true;
    try {
      await handleMeetingSend(text, meeting);
      _showGcEscapeNotice('已作为新一轮重发', 'info');
    } catch (error) {
      _restoreQuestionAndPreserveDraft(meeting.id, text);
      _showGcEscapeNotice(`重发失败：${error && error.message ? error.message : String(error)}；问题已恢复到输入框`, 'error');
    } finally {
      btn.disabled = false;
    }
  }

  // Markdown-answer rooms: resend this turn to one member. Workflow rooms go
  // through the delivery engine, which re-prompts members that have not delivered.
  async function _handleGcResendMember(btn, meeting) {
    if (btn.disabled) return;
    const sid = btn.getAttribute('data-gc-resend-member');
    const turnNum = parseInt(btn.getAttribute('data-gc-retry-turn') || '', 10);
    btn.disabled = true;
    try {
      let result;
      if (Delivery.enabled(meeting) && meeting.serialWorkflow.enabled) {
        result = await ipcRenderer.invoke('delivery:continue', { meetingId: meeting.id });
        if (!result?.ok) throw new Error(result?.error || '补发失败');
      } else {
        const args = { meetingId: meeting.id, sid, turnNum: Number.isFinite(turnNum) ? turnNum : undefined };
        result = await ipcRenderer.invoke('groupchat:resend-member', args);
        if (result?.reason === 'member_busy') {
          if (!window.confirm('这位成员仍在运行或等待确认，再发一次可能让它重复做。确定重新发送本轮问题吗？')) return;
          result = await ipcRenderer.invoke('groupchat:resend-member', { ...args, force: true });
        }
        if (!result?.ok) throw new Error(result?.reason || '重新发送失败');
      }
      _showGcEscapeNotice('已重新发送；它写好回答文件后卡片会自动更新', 'info');
    } catch (error) {
      _showGcEscapeNotice('重新发送失败：' + (error && error.message ? error.message : String(error)), 'error');
    } finally { btn.disabled = false; }
  }

  async function _handleGcRetryParticipant(btn, meeting) {
    if (btn.disabled) return;
    const sid = btn.getAttribute('data-gc-retry-answer');
    const turnNum = parseInt(btn.getAttribute('data-gc-retry-turn') || '', 10);
    if (!sid) return;
    const oldText = btn.textContent;
    btn.disabled = true;
    btn.textContent = '重试中';
    try {
      const result = await ipcRenderer.invoke('groupchat-resend-participant', {
        meetingId: meeting.id,
        sid,
        turnNum: Number.isFinite(turnNum) ? turnNum : undefined,
      });
      if (!result || !result.ok) {
        const reason = result && (result.detail || result.reason) || 'unknown';
        throw new Error(reason === 'turn_still_running' ? '请等本轮其他成员结束后再重试' : reason);
      }
      btn.textContent = '已完成';
      btn.classList.add('ok');
      await refreshGroupChatPanel(meeting);
      _showGcEscapeNotice('该成员已重新回答本轮问题', 'info');
    } catch (error) {
      btn.textContent = '重试失败';
      _showGcEscapeNotice(`成员重试失败：${error && error.message ? error.message : String(error)}`, 'error');
    } finally {
      setTimeout(() => {
        try {
          btn.textContent = oldText;
          btn.classList.remove('ok');
          btn.disabled = false;
        } catch {}
      }, 1400);
    }
  }

  async function _setMeetingParticipants(meeting, participants) {
    const response = await ipcRenderer.invoke('groupchat:set-participants', {
      meetingId: meeting.id,
      participants,
    });
    if (!response || !response.ok || !response.meeting) {
      throw new Error((response && response.reason) || '参与者状态未保存');
    }
    meetingData[meeting.id] = response.meeting;
    return response.meeting;
  }

  async function _handleGcMemberToggle(btn, meeting) {
    const latestMeeting = meetingData[meeting.id] || meeting;
    const idx = parseInt(btn.getAttribute('data-gc-member-idx') || '-1', 10);
    const sid = Array.isArray(latestMeeting.subSessions) ? latestMeeting.subSessions[idx] : null;
    if (!sid) return;
    const allIndexes = latestMeeting.subSessions.map((_, i) => i);
    const current = Array.isArray(latestMeeting.participants) ? latestMeeting.participants.slice() : allIndexes;
    const set = new Set(current);
    if (set.has(idx)) set.delete(idx);
    else set.add(idx);
    const next = allIndexes.filter(i => set.has(i));
    try {
      await _setMeetingParticipants(latestMeeting, next);
    } catch (err) {
      console.error('[groupchat] set participants failed:', err);
      _showGcEscapeNotice('成员选择保存失败：' + (err && err.message ? err.message : String(err)), 'error');
    }
    renderToolbar(meetingData[latestMeeting.id] || latestMeeting);
    refreshGroupChatPanel(meetingData[latestMeeting.id] || latestMeeting);
  }

  async function _handleDutyHatChange(select, meeting) {
    const latestMeeting = meetingData[meeting.id] || meeting;
    const hatId = select.getAttribute('data-duty-hat-id');
    const sid = select.value || '';
    const assignments = _getDutyHatAssignments(latestMeeting);
    const validSids = new Set((latestMeeting.subSessions || []).filter(Boolean));
    if (sid && validSids.has(sid)) assignments[hatId] = sid;
    else delete assignments[hatId];
    if (sid && validSids.has(sid)) {
      const slotIdx = (latestMeeting.subSessions || []).indexOf(sid);
      const allIndexes = (latestMeeting.subSessions || []).map((_, i) => i);
      const current = Array.isArray(latestMeeting.participants) ? latestMeeting.participants.slice() : allIndexes;
      if (slotIdx >= 0 && !current.includes(slotIdx)) {
        const next = allIndexes.filter(i => current.includes(i) || i === slotIdx);
        try {
          await _setMeetingParticipants(latestMeeting, next);
        } catch (err) {
          console.error('[groupchat] set participants for duty hat failed:', err);
        }
      }
    }
    const refreshedMeeting = meetingData[latestMeeting.id] || latestMeeting;
    _syncDutyHatPromptToInput(refreshedMeeting);
    refreshGroupChatPanel(refreshedMeeting);
  }

  function _memberRemoveErrorText(reason) {
    return {
      last_member: '群聊至少需要保留一位成员',
      turn_in_progress: '本轮回答进行中，请在本轮结束后移除成员',
      turn_state_unavailable: '暂时无法确认本轮是否结束，为避免误删成员已取消操作',
      not_member: '该成员已不在当前群聊中',
      meeting_not_found: '当前群聊已不存在',
    }[reason] || '成员移除失败';
  }

  async function _handleGcMemberRemove(btn, meeting) {
    if (!btn || btn.disabled) return;
    const latestMeeting = meetingData[meeting.id] || meeting;
    const sid = btn.getAttribute('data-gc-member-remove-sid');
    const index = Array.isArray(latestMeeting.subSessions) ? latestMeeting.subSessions.indexOf(sid) : -1;
    if (index < 0) return;
    const slot = _getGcSlots(latestMeeting)[index] || {};
    const label = slot.displayLabel || slot.label || slot.kind || ('成员 ' + (index + 1));
    if (!await require('./ui-feedback').confirmHubAction('移除“' + label + '”并关闭它的会话？', { title: '移除这位成员？', acceptLabel: '移除成员', danger: true })) return;

    btn.disabled = true;
    const oldText = btn.textContent;
    btn.textContent = '移除中';
    try {
      const response = await ipcRenderer.invoke('remove-meeting-sub', {
        meetingId: latestMeeting.id,
        sessionId: sid,
      });
      if (!response || !response.ok || !response.meeting) {
        throw new Error(_memberRemoveErrorText(response && response.reason));
      }
      meetingData[latestMeeting.id] = response.meeting;
      // 2026-07-20 maintainer [修#3e]：被移除成员同步从"等你 N"集合剔除（否则侧栏把删了的人也算上）
      try {
        const m0 = (typeof meetings !== 'undefined') && meetings[latestMeeting.id];
        if (m0 && m0.unreadAnswered instanceof Set) m0.unreadAnswered.delete(sid);
      } catch {}
      delete _cliReadyCache[sid];
      const assignments = _getDutyHatAssignments(response.meeting);
      for (const [hatId, assignedSid] of Object.entries(assignments)) {
        if (assignedSid === sid) delete assignments[hatId];
      }
      renderHeader(response.meeting);
      renderToolbar(response.meeting);
      setupInput(response.meeting);
      await refreshGroupChatPanel(response.meeting);
    } catch (err) {
      console.error('[groupchat] remove member failed:', err);
      _showGcEscapeNotice(err && err.message ? err.message : String(err), 'error');
      btn.disabled = false;
      btn.textContent = oldText;
    }
  }

  async function _handleGcPanelClick(ev, panel) {
    const meeting = _currentGcPanelMeeting(panel);
    if (!meeting) return;
    const bubble = _closestInPanel(ev.target, '.mr-gc-msg[data-unread-answer="true"] .mr-gc-bubble', panel);
    if (bubble && !_gcViewingTurnN[meeting.id] && document.hasFocus() && !document.hidden) {
      const article = bubble.closest('[data-source-sid]');
      const sid = article.dataset.sourceSid;
      const replies = panel.querySelectorAll(`.mr-gc-msg[data-unread-answer="true"][data-source-sid="${CSS.escape(sid)}"]`);
      if (sid && replies[replies.length - 1] === article) window.markMeetingMemberRead?.(meeting.id, sid, { turnNum: article.dataset.readTurn });
    }

    const sessionJump = _closestInPanel(ev.target, '[data-gc-open-session]', panel);
    if (sessionJump) {
      ev.preventDefault();
      ev.stopPropagation();
      _openMeetingMemberSession(sessionJump.getAttribute('data-gc-open-session'));
      return;
    }

    const addMemberBtn = _closestInPanel(ev.target, '[data-gc-add-member]', panel);
    if (addMemberBtn) {
      ev.stopPropagation();
      showAddSubMenu(meeting.id, addMemberBtn);
      return;
    }

    const removeMemberBtn = _closestInPanel(ev.target, '[data-gc-member-remove-sid]', panel);
    if (removeMemberBtn) {
      ev.stopPropagation();
      await _handleGcMemberRemove(removeMemberBtn, meeting);
      return;
    }

    if (require('./groupchat-journal').handle(ev,panel)) return;

    // 2026-06-28 maintainer [改进2]：回到最新
    const scrollBtn = _closestInPanel(ev.target, '[data-gc-scroll-bottom]', panel);
    if (scrollBtn) {
      ev.stopPropagation();
      const el = panel.querySelector('.mr-gc-messages');
      if (el?._cardFollowController) el._cardFollowController.follow();
      else if (el) el.scrollTop = el.scrollHeight;
      return;
    }

    // 2026-06-28 maintainer [改进R2-1]：代码块复制
    const codeCopyBtn = _closestInPanel(ev.target, '[data-gc-copy-code]', panel);
    if (codeCopyBtn) {
      ev.stopPropagation();
      const pre = codeCopyBtn.closest('pre');
      const code = pre && pre.querySelector('code');
      if (code && typeof navigator !== 'undefined' && navigator.clipboard) {
        const old = codeCopyBtn.textContent;
        copyGroupText(code.textContent || '').then(()=>{codeCopyBtn.textContent = '已复制 ✓';})
          .catch(()=>{codeCopyBtn.textContent = '复制失败';})
          .finally(()=>setTimeout(() => { try { codeCopyBtn.textContent = old; } catch {} }, 1500));
      }
      return;
    }

    // [幕次折叠] 点击投委会幕次分隔条 → toggle 折叠状态 → 重渲染（前端临时状态，不持久化）。
    const actToggle = _closestInPanel(ev.target, '[data-gc-act-toggle]', panel);
    if (actToggle) {
      ev.stopPropagation();
      const key = actToggle.getAttribute('data-gc-act-toggle');
      const set = _gcCollapsedActs[meeting.id] || (_gcCollapsedActs[meeting.id] = new Set());
      if (set.has(key)) set.delete(key); else set.add(key);
      refreshGroupChatPanel(meeting);
      return;
    }

    const stepDot = _closestInPanel(ev.target, '.mr-gc-step-dot[data-turn-n]', panel);
    if (stepDot) {
      ev.stopPropagation();
      const n = parseInt(stepDot.getAttribute('data-turn-n'), 10);
      if (!Number.isFinite(n) || n < 1) return;
      const cached = _gcPanelState[meeting.id];
      const totalTurns = cached && Array.isArray(cached.turns) ? cached.turns.length : 0;
      const isActive = cached && cached.currentMode && cached.currentMode !== 'idle';
      const latestN = isActive ? totalTurns + 1 : totalTurns;
      if (n === latestN || stepDot.hasAttribute('data-turn-active')) {
        delete _gcViewingTurnN[meeting.id];
      } else {
        _gcViewingTurnN[meeting.id] = n;
      }
      refreshGroupChatPanel(meeting);
      return;
    }

    const cardTab = _closestInPanel(ev.target, '[data-gc-card-tab-sid]', panel);
    if (cardTab) {
      ev.stopPropagation();
      const sid = cardTab.getAttribute('data-gc-card-tab-sid');
      if (sid) {
        _focusGroupChatSession(meeting, sid);
        _readVisibleMemberCard(meeting, sid);
      }
      return;
    }

    if (_closestInPanel(ev.target, '[data-committee-open]', panel)) {
      ev.stopPropagation();
      if (window.committeeUI && window.committeeUI.showModal) window.committeeUI.showModal(meeting);
      return;
    }
    if (_closestInPanel(ev.target, '[data-committee-history]', panel)) {
      ev.stopPropagation();
      if (window.committeeUI && window.committeeUI.showHistory) window.committeeUI.showHistory(meeting);
      return;
    }
    if (_closestInPanel(ev.target, '[data-committee-screener]', panel)) {
      ev.stopPropagation();
      if (window.committeeUI && window.committeeUI.showScreenerHint) window.committeeUI.showScreenerHint(meeting);
      return;
    }

    if (_closestInPanel(ev.target, '[data-gc-side-toggle]', panel)) {
      ev.stopPropagation();
      _setGroupSideCollapsed(!_getGroupSideCollapsed(), meeting);
      return;
    }

    const nextActionBtn = _closestInPanel(ev.target, '[data-gc-next-action]', panel);
    if (nextActionBtn) {
      ev.preventDefault();
      ev.stopPropagation();
      _handleNextAction(nextActionBtn.getAttribute('data-gc-next-action'), meetingData[meeting.id] || meeting);
      return;
    }

    const mobileBtn = _closestInPanel(ev.target, '[data-gc-mobile-open]', panel);
    if (mobileBtn) {
      ev.preventDefault();
      ev.stopPropagation();
      _handleMobileWorkbench(mobileBtn.getAttribute('data-gc-mobile-open'), meetingData[meeting.id] || meeting);
      return;
    }

    const viewPromptBtn = _closestInPanel(ev.target, '[data-gc-view-prompt]', panel);
    if (viewPromptBtn) {
      ev.preventDefault();
      ev.stopPropagation();
      _handleGcViewPrompt(viewPromptBtn, meeting);
      return;
    }

    const attemptDetailsBtn = _closestInPanel(ev.target, '[data-gc-attempt-details]', panel);
    if (attemptDetailsBtn) {
      ev.preventDefault();
      ev.stopPropagation();
      await _handleGcAttemptDetails(attemptDetailsBtn, meeting);
      return;
    }

    const resendTurnBtn = _closestInPanel(ev.target, '[data-gc-resend-turn]', panel);
    if (resendTurnBtn) {
      ev.preventDefault();
      ev.stopPropagation();
      await _handleGcUserTurnAction(resendTurnBtn, meeting, false);
      return;
    }

    const editTurnBtn = _closestInPanel(ev.target, '[data-gc-edit-turn]', panel);
    if (editTurnBtn) {
      ev.preventDefault();
      ev.stopPropagation();
      await _handleGcUserTurnAction(editTurnBtn, meeting, true);
      return;
    }

    const cliBtn = _closestInPanel(ev.target, '[data-gc-open-cli]', panel);
    if (cliBtn) {
      ev.preventDefault(); ev.stopPropagation();
      try { await _openConversationCli(meeting, { sid: cliBtn.getAttribute('data-gc-open-cli') }); }
      catch (error) { _showGcEscapeNotice(error.message, 'error'); }
      return;
    }
    const promptCopyBtn = _closestInPanel(ev.target, '[data-gc-copy-prompt]', panel);
    if (promptCopyBtn) {
      ev.preventDefault(); ev.stopPropagation();
      try {
        const state = await ipcRenderer.invoke('groupchat:get-state', { meetingId: meeting.id });
        if (activeMeetingId !== meeting.id) return;
        const message = state.messages?.find(m => m.id === promptCopyBtn.getAttribute('data-gc-copy-prompt') && m.role === 'assistant');
        await _copyArchivedGroupPrompt(message?.sourcePrompt, message?.speaker, meeting.id);
      } catch (error) { _showGcEscapeNotice(error.message, 'error'); }
      return;
    }
    const resendMemberBtn = _closestInPanel(ev.target, '[data-gc-resend-member]', panel);
    if (resendMemberBtn) {
      ev.preventDefault();
      ev.stopPropagation();
      await _handleGcResendMember(resendMemberBtn, meeting);
      return;
    }
    const retryAnswerBtn = _closestInPanel(ev.target, '[data-gc-retry-answer]', panel);
    if (retryAnswerBtn) {
      ev.preventDefault();
      ev.stopPropagation();
      await _handleGcRetryParticipant(retryAnswerBtn, meeting);
      return;
    }

    const copyBtn = _closestInPanel(ev.target, '[data-gc-copy-message]', panel);
    if (copyBtn) {
      ev.preventDefault();
      ev.stopPropagation();
      await _handleGcMessageCopy(copyBtn);
      return;
    }

    const syncBtn = _closestInPanel(ev.target, '[data-gc-sync-answer]', panel);
    if (syncBtn) {
      ev.preventDefault();
      ev.stopPropagation();
      await _handleGcManualSync(syncBtn, meeting);
      return;
    }

    const memberBtn = _closestInPanel(ev.target, '[data-gc-member-idx]', panel);
    if (memberBtn) {
      ev.stopPropagation();
      await _handleGcMemberToggle(memberBtn, meeting);
      return;
    }

    if (_closestInPanel(ev.target, '[data-duty-hats-toggle]', panel)) {
      ev.stopPropagation();
      _setDutyHatsCollapsed(!_getDutyHatsCollapsed());
      refreshGroupChatPanel(meetingData[meeting.id] || meeting);
      return;
    }

    if (_closestInPanel(ev.target, '[data-duty-hat-insert]', panel)) {
      ev.stopPropagation();
      _syncDutyHatPromptToInput(meetingData[meeting.id] || meeting);
      return;
    }

    if (_closestInPanel(ev.target, '[data-duty-hat-clear]', panel)) {
      ev.stopPropagation();
      const latestMeeting = meetingData[meeting.id] || meeting;
      _clearDutyHatAssignments(latestMeeting);
      const input = document.getElementById('mr-input-box');
      const currentText = input ? (input.innerText || '') : '';
      const nextText = _replaceDutyHatPromptInText(currentText, '');
      _setMeetingInputText(latestMeeting.id, nextText);
      refreshGroupChatPanel(latestMeeting);
      return;
    }

    if (_closestInPanel(ev.target, '[data-gc-tt-exit]', panel)) {
      ev.stopPropagation();
      delete _gcViewingTurnN[meeting.id];
      refreshGroupChatPanel(meeting);
      return;
    }

    const userqToggle = _closestInPanel(ev.target, '[data-action="userq-toggle"]', panel);
    if (userqToggle) {
      ev.stopPropagation();
      const banner = userqToggle.closest('.mr-gc-userq');
      if (banner) banner.classList.toggle('expanded');
      return;
    }

    const obCard = _closestInPanel(ev.target, '.mr-gc-ob-card[data-ob-q]', panel);
    if (obCard) {
      const q = obCard.getAttribute('data-ob-q');
      const input = document.getElementById('mr-input-box');
      if (input && q && !(input.innerText || '').trim()) {
        input.textContent = q; input.focus(); _placeCaretAtEnd(input);
      }
      return;
    }

    const bannerClose = _closestInPanel(ev.target, '[data-gc-banner-close]', panel);
    if (bannerClose) {
      const banner = bannerClose.closest('#mr-gc-soft-alert-banner');
      if (banner) {
        banner.style.display = 'none';
        banner.innerHTML = '';
      }
      return;
    }

    const expandBtn = _closestInPanel(ev.target, '.mr-ft-expand[data-ft-expand-sid]', panel);
    if (expandBtn) {
      ev.stopPropagation();
      const sid = expandBtn.getAttribute('data-ft-expand-sid');
      const kind = expandBtn.getAttribute('data-ft-expand-kind');
      _openGcTimeline(meeting, sid, kind);
      return;
    }

    const escapeBtn = _closestInPanel(ev.target, '[data-gc-escape]', panel);
    if (escapeBtn) {
      ev.stopPropagation();
      await _handleGcEscapeAction(escapeBtn, meeting);
      return;
    }

    const hoverBtn = _closestInPanel(ev.target, '.mr-ft-hover-actions button', panel);
    if (hoverBtn) {
      ev.stopPropagation();
      await _handleSlotHoverAction(hoverBtn);
      return;
    }

    const card = _closestInPanel(ev.target, '.mr-ft[data-ft-sid]', panel);
    if (card) {
      _handleSlotCardClick(card, ev, meeting);
    }
  }

  function _handleGcPanelChange(ev, panel) {
    const meeting = _currentGcPanelMeeting(panel);
    if (!meeting) return;
    const dutyHatSelect = _closestInPanel(ev.target, '[data-duty-hat-id]', panel);
    if (dutyHatSelect) {
      ev.stopPropagation();
      void _handleDutyHatChange(dutyHatSelect, meeting).catch(err => {
        console.error('[groupchat] duty hat change failed:', err);
      });
    }
  }

  function _syncGcPanelTransientState(panel, meeting) {
    const inputBox = document.getElementById('mr-input-box');
    const sendBtn = document.getElementById('mr-send-btn');
    const inputRow = document.getElementById('mr-input-row');
    const isTT = !!_gcViewingTurnN[meeting.id];
    if (inputBox) {
      inputBox.setAttribute('contenteditable', isTT ? 'false' : 'true');
      inputBox.setAttribute('data-placeholder', isTT
        ? '⌛ 时光机模式 — 点 stepper 最新轮 / Esc 退出后才能发送'
        : (inputBox.getAttribute('data-placeholder-orig') || inputBox.getAttribute('data-placeholder') || ''));
    }
    if (sendBtn) sendBtn.disabled = isTT;
    if (inputRow) inputRow.classList.toggle('mr-input-row-tt', isTT);
    // 2026-07-29 maintainer [群聊运行中可操作]：面板每次重渲都同步一次作战面板行，
    //   让「⏹ 停止本轮」入口跟着 currentMode 实时出现/消失（此前只有输入/勾选等
    //   用户动作才会刷新这一行，运行状态变化时看不到入口）。
    try { _updateInputPreflight(meeting); } catch (e) { console.warn('[groupchat] preflight sync failed:', e && e.message); }

    const hasThinking = panel.querySelector('.mr-gc-think-elapsed');
    if (hasThinking && !_thinkTimer) {
      const mid = meeting.id;
      _thinkTimer = setInterval(() => {
        const ts = _thinkStartTs[mid];
        if (!ts) { clearInterval(_thinkTimer); _thinkTimer = null; return; }
        const els = document.querySelectorAll('.mr-gc-think-elapsed');
        if (els.length === 0) { clearInterval(_thinkTimer); _thinkTimer = null; return; }
        const sec = Math.round((Date.now() - ts) / 1000);
        els.forEach(el => { el.textContent = `已 ${sec}s`; });
      }, 1000);
    } else if (!hasThinking && _thinkTimer) {
      clearInterval(_thinkTimer); _thinkTimer = null;
    }
  }

  function _bindGcPanelEvents(panel, meeting) {
    if (!panel || !meeting) return;
    panel.__mrGcMeeting = meeting;
    if (!panel.__mrGcDelegated) {
      panel.addEventListener('click', (ev) => {
        void _handleGcPanelClick(ev, panel).catch(err => {
          console.error('[groupchat] delegated click failed:', err);
        });
      });
      panel.addEventListener('keydown', (ev) => {
        if (ev.key !== 'Enter' && ev.key !== ' ') return;
        const sessionJump = _closestInPanel(ev.target, '[data-gc-open-session]', panel);
        if (!sessionJump) return;
        ev.preventDefault();
        ev.stopPropagation();
        _openMeetingMemberSession(sessionJump.getAttribute('data-gc-open-session'));
      });
      panel.addEventListener('change', (ev) => {
        _handleGcPanelChange(ev, panel);
      });
      panel.__mrGcDelegated = true;
    }
    _syncGcPanelTransientState(panel, meeting);
  }

  function _placeCaretAtEnd(el) {
    const range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(false);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  }

  // ---- AI 时间线浮层 ----------------------------------------------------
  // 点击任意卡片 → 打开右侧抽屉，顶部 Tab 列轮次（最新在最左 = 默认 active），点 Tab 切换内容。
  // T3（2026-05-04 maintainer）：合并 _partialBy[sid] 作为「实时」虚拟轮次（如果有内容）；
  //   抽屉打开期间订阅 partial-update 实时更新内容（修复 B1 看不到本轮 partial）。
  function _openGcTimeline(meeting, sid, kind) {
    // T3 fix（2026-05-04 maintainer）：开新抽屉前先清掉上一次的 escHandler + 订阅状态。
    if (_gcTimelineCleanup) { _gcTimelineCleanup(); _gcTimelineCleanup = null; }
    const state = _gcPanelState[meeting.id];
    if (!state || !Array.isArray(state.turns)) return;

    const labelDisplay = _KIND_LABELS[kind] || kind;
    const subs = _getGcSubInfo(meeting);
    const sub = subs[kind];
    const headerLabel = sub && sub.label ? sub.label : labelDisplay;
    const slotIdxTl = (meeting && Array.isArray(meeting.subSessions))
      ? Math.max(0, meeting.subSessions.indexOf(sid))
      : 0;
    const slotClsTl = `slot-${slotIdxTl + 1}`;

    // 收集该 sid 有回答的轮次，按 turn n 倒序（最新在最左）
    const historyTurns = state.turns
      .filter(t => (t.by || {})[sid])
      .sort((a, b) => b.n - a.n);

    // T3：本轮 partial 合并（皮卡丘 settled 但小火龙未完时，本轮没 turn-complete → 用户在抽屉看不到本轮内容）
    const partial = (state._partialBy || {})[sid];
    const liveText = (partial && (partial.text || (Array.isArray(partial.blocks) && partial.blocks.length > 0)))
      ? (partial.text || '') : null;
    const turnsWithAns = [...historyTurns];
    let liveTurn = null;
    if (liveText !== null) {
      const baseTurnN = (historyTurns[0] && historyTurns[0].n) || (state.turnNum || 0);
      liveTurn = {
        n: baseTurnN + 1,
        mode: state.currentMode || 'fanout',
        by: { [sid]: liveText },
        userInput: '',  // partial 阶段没有标准化的 userInput；留空避免 stale
        _live: true,
        _partialStatus: partial.status,
        _partialBlocks: Array.isArray(partial.blocks) ? partial.blocks : null,
      };
      turnsWithAns.unshift(liveTurn);
    }

    let overlay = document.getElementById('mr-gc-timeline-overlay');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'mr-gc-timeline-overlay';
      overlay.className = 'mr-gc-tl-overlay';
      document.body.appendChild(overlay);
    }

    const renderTurnBody = (turn) => {
      if (!turn) return '<div class="mr-gc-tl-empty">该 AI 还没有可显示的历史回答。</div>';
      // T3：_live 走 partial blocks（如有）→ markdown text → 占位
      let bodyHtml;
      const sequence=turn._live ? partial?.displayMessages
        : state.displayMessagesByAttempt?.[turn.attemptIdBy?.[sid]];
      if(sequence?.length) {
        bodyHtml=require('./conversation-message-view').renderMessageSequence(sequence,{escapeHtml,renderMarkdown:_renderMarkdown});
      } else if (turn._live) {
        if (turn._partialBlocks && turn._partialBlocks.length > 0) {
          bodyHtml = _renderPreviewBlocks(turn._partialBlocks, sid);
        } else if (turn.by[sid]) {
          bodyHtml = _renderMarkdown(turn.by[sid]);
        } else {
          bodyHtml = '<div class="mr-gc-tl-empty" style="opacity:.6">💭 思考中…等待 AI 输出</div>';
        }
        // 加流式光标
        bodyHtml += '<span class="mr-ft-cursor"></span>';
      } else {
        const text = (turn.by || {})[sid] || '';
        bodyHtml = _renderMarkdown(text);
      }
      const userIn = (turn.userInput || '').trim();
      const userBlock = userIn
        ? `<div class="mr-gc-tl-user">用户输入：${require('./conversation-message-view').renderMessageBody(userIn,
          {isUser:true,escapeHtml,renderMarkdown:_renderMarkdown})}</div>`
        : '';
      const decisionTag = turn.decisionTitle
        ? `<div class="mr-gc-tl-decision-row">📌 决策标题：${escapeHtml(turn.decisionTitle)}</div>`
        : '';
      return `${decisionTag}${userBlock}<div class="mr-gc-tl-body">${bodyHtml}</div>`;
    };

    const tabsHtml = turnsWithAns.map((t, i) => {
      const modeLabel = { fanout: '提问', debate: '辩论', summary: '综合' }[t.mode] || t.mode;
      const isLatest = i === 0;
      const liveTag = t._live ? '<span class="mr-gc-tl-tab-latest" style="background:#22863a">实时</span>' : '';
      const latestTag = (isLatest && !t._live) ? '<span class="mr-gc-tl-tab-latest">最新</span>' : '';
      return `<button type="button" class="mr-gc-tl-tab ${isLatest ? 'active' : ''}" data-tab-idx="${i}" data-tab-live="${t._live ? '1' : '0'}" title="第 ${t.n} 轮 · ${escapeHtml(modeLabel)}">
        <span class="mr-gc-tl-tab-turn">第 ${t.n} 轮</span>
        <span class="mr-gc-tl-tab-mode ${escapeHtml(t.mode)}">${escapeHtml(modeLabel)}</span>
        ${liveTag}${latestTag}
      </button>`;
    }).join('');

    const hasAnyTab = turnsWithAns.length > 0;

    overlay.innerHTML = `
      <div class="mr-gc-tl-backdrop" data-gc-tl-close="1"></div>
      <aside class="mr-gc-tl-drawer mr-gc-tl-${slotClsTl}" role="dialog" aria-label="${escapeHtml(headerLabel)} 时间线">
        <header class="mr-gc-tl-drawer-head">
          <span class="mr-gc-tl-drawer-title">${escapeHtml(headerLabel)} · 历史回答</span>
          <span class="mr-gc-tl-drawer-meta">共 ${turnsWithAns.length} 轮</span>
          <button type="button" class="mr-gc-tl-close" data-gc-tl-close="1" aria-label="关闭">×</button>
        </header>
        ${hasAnyTab ? `<nav class="mr-gc-tl-tabs" role="tablist">${tabsHtml}</nav>` : ''}
        <div class="mr-gc-tl-content" id="mr-gc-tl-content">${renderTurnBody(turnsWithAns[0])}</div>
      </aside>
    `;
    overlay.style.display = 'block';

    // 2026-05-05 maintainer：抽屉字号 scale —— 打开时从 localStorage 读上次值（默认 1.2，正文从
    //   13px 提升到 ~16px），Ctrl+滚轮 ±0.1 调整，clamp [0.8, 2.0]，preventDefault 拦掉
    //   Electron 默认整窗 zoom（仅抽屉内拦，抽屉外仍可整窗 zoom）。CSS 通过 --drawer-font-scale
    //   缩放 .mr-gc-tl-content 内的正文；header/tab 不受影响。
    const _drawerEl = overlay.querySelector('.mr-gc-tl-drawer');
    const FONT_SCALE_KEY = 'mr-drawer-font-scale';
    const FONT_SCALE_MIN = 0.8;
    const FONT_SCALE_MAX = 2.0;
    const FONT_SCALE_STEP = 0.1;
    const FONT_SCALE_DEFAULT = 1.2;
    let _drawerFontScale = (() => {
      const raw = parseFloat(localStorage.getItem(FONT_SCALE_KEY));
      return (Number.isFinite(raw) && raw >= FONT_SCALE_MIN && raw <= FONT_SCALE_MAX) ? raw : FONT_SCALE_DEFAULT;
    })();
    const _applyDrawerScale = (s) => {
      _drawerFontScale = Math.max(FONT_SCALE_MIN, Math.min(FONT_SCALE_MAX, Math.round(s * 10) / 10));
      if (_drawerEl) _drawerEl.style.setProperty('--drawer-font-scale', String(_drawerFontScale));
      try { localStorage.setItem(FONT_SCALE_KEY, String(_drawerFontScale)); } catch {}
    };
    _applyDrawerScale(_drawerFontScale);
    if (_drawerEl) {
      _drawerEl.addEventListener('wheel', (e) => {
        if (!e.ctrlKey) return;
        e.preventDefault();
        e.stopPropagation();
        const dir = e.deltaY < 0 ? +1 : -1;
        _applyDrawerScale(_drawerFontScale + dir * FONT_SCALE_STEP);
      }, { passive: false });
    }

    // T3：注册 live 订阅（仅当有 liveTurn 且默认 active 是它时）
    _gcTimelineLive = (liveTurn && turnsWithAns[0] && turnsWithAns[0]._live)
      ? { sid, mid: meeting.id, kind } : null;

    const contentEl = overlay.querySelector('#mr-gc-tl-content');
    overlay.querySelectorAll('.mr-gc-tl-tab').forEach(btn => {
      btn.addEventListener('click', () => {
        overlay.querySelectorAll('.mr-gc-tl-tab').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        const idx = parseInt(btn.getAttribute('data-tab-idx') || '0', 10);
        const isLive = btn.getAttribute('data-tab-live') === '1';
        if (contentEl) {
          contentEl.innerHTML = renderTurnBody(turnsWithAns[idx]);
          contentEl.scrollTop = 0;
        }
        // T3：用户切走 live tab → 解订阅；切回 live tab → 重订阅
        _gcTimelineLive = (isLive && liveTurn) ? { sid, mid: meeting.id, kind } : null;
      });
    });

    const closeAll = () => {
      overlay.style.display = 'none';
      document.removeEventListener('keydown', escHandler);
      _gcTimelineLive = null;  // T3：关抽屉清订阅
      _gcTimelineCleanup = null;  // T3 fix：清掉自身指针，避免下次开抽屉重复 cleanup
    };
    const escHandler = (ev) => { if (ev.key === 'Escape') closeAll(); };
    overlay.querySelectorAll('[data-gc-tl-close]').forEach(el => {
      el.addEventListener('click', closeAll);
    });
    document.addEventListener('keydown', escHandler);
    // T3 fix（2026-05-04 maintainer）：把本次 closeAll 注册为模块级清理函数。
    //   下次 _openGcTimeline 调用时会先调它，避免 escHandler 累积。
    _gcTimelineCleanup = closeAll;
  }

  // 乐观态生命周期：renderer 在 IPC 飞行期间用 _gcOptimisticTurn 标记自己写的乐观字段，
  // 一旦 IPC resolve / reject 或 server 推 turn-complete，就清掉这个标记 —— 之后 refresh
  const _gcOptimisticTurn = {}; // { [meetingId]: { mode, t, gen } }
  // 抢占式连发代际（2026-06-24 maintainer）：每个 meeting 每次发送自增，clearOptimistic 只认
  //   最新代际，防「连发时旧轮 invoke 先返回」误清新轮的乐观思考态。
  const _gcSendGen = {}; // { [meetingId]: int }
  // 本轮/本步真正被 dispatch 的 sid 集合（串行工作流每步只发子集）。渲染 thinking 时用它过滤；
  // 未设置时 fallback 到 meeting.participants（普通群聊全员），保持原行为。
  const _gcActiveSids = {}; // { [meetingId]: Set<sid> }
  const _gcAttemptIdsBySid = {}; // { [meetingId]: { [sid]: attemptId } }

  function _acceptGcPush(payload, options = {}) {
    if (!payload || !payload.meetingId) return false;
    const decision = acceptGroupChatEvent(payload, { consumer: 'meeting-room', ...options });
    if (!decision.accepted) {
      console.debug('[groupchat] ignored stale push', payload.meetingId, decision.reason,
        payload.turnNum, payload.revision);
      return false;
    }
    return true;
  }

  function triggerGroupChat(meeting, opts = {}) {
    const mid = meeting.id;
    const cached = _gcPanelState[mid];
    _gcTurnStartTs[mid] = Date.now();
    // 抢占式连发代际：每次发送自增；clearOptimistic 只认最新代际，避免连发时「旧轮 invoke
    //   先返回」把新轮乐观思考态误清（旧 invoke resolve 时 gen 已不是最新 → 直接跳过）。
    const myGen = (_gcSendGen[mid] = (_gcSendGen[mid] || 0) + 1);
    _gcOptimisticTurn[mid] = { mode: 'group', t: Date.now(), gen: myGen };
    _gcActiveSids[mid] = new Set(_expectedParticipantSids(meeting));

    if (cached) {
      cached.currentMode = 'group';
      cached._partialBy = null;
    }
    refreshGroupChatPanel(meeting, { forceGroupChatBottom: true });
    renderToolbar(meeting);

    const clearOptimistic = () => {
      if (_gcSendGen[mid] !== myGen) return;
      delete _gcOptimisticTurn[mid];
      const c = _gcPanelState[mid];
      if (c) c.currentMode = null;
      refreshGroupChatPanel(meeting);
      renderToolbar(meeting);
    };

    const restoreFailedSend = (reason) => {
      const isLatest = _gcSendGen[mid] === myGen;
      if (isLatest) delete _gcActiveSids[mid];
      _discardPendingUserMessage(mid, { clientId: opts.pendingClientId });
      clearOptimistic();
      const recovery = _restoreQuestionAndPreserveDraft(mid, opts.userInput);
      const recoveryText = recovery.mergedWithDraft
        ? '；失败问题与当前草稿均已保留在输入框'
        : recovery.restored ? '；问题已恢复到输入框' : '';
      _showGcEscapeNotice((reason || 'AI 群聊发送失败') + recoveryText, 'error');
    };

    ipcRenderer.invoke('groupchat:turn', {
      meetingId: meeting.id,
      userInput: opts.userInput || '',
      recipientSids: opts.recipientSids,
      // 本次发送的身份。服务端把它写进权威 user 消息，渲染层据此撤掉本地那条 pending
      // 气泡 —— 内容和时间都认不出「是不是同一条」，只有这个 id 能（见
      // core/groupchat-pending-claim.js 顶部两次被推翻的判据）。
      clientMessageId: opts.pendingClientId || '',
    }).then((result) => {
      console.log('[groupchat] turn IPC resolved:', result && result.status, 'turn=', result && result.turnNum);
      if (result && result.status === 'completed') clearOptimistic();
      else restoreFailedSend((result && result.reason) || `AI 群聊发送失败（${(result && result.status) || 'unknown'}）`);
    }).catch((e) => {
      console.error('[groupchat] turn IPC failed:', e.message);
      restoreFailedSend(`AI 群聊发送异常：${e && e.message ? e.message : String(e)}`);
    });
    meeting.lastMessageTime = Date.now();
    ipcRenderer.send('update-meeting', { meetingId: meeting.id, fields: { lastMessageTime: meeting.lastMessageTime } });
  }

  // === 串行工作流（2026-06-17 maintainer）===
  // 复用 groupchat:turn（已透传 targetMemberIds）逐步派发：每步换一组 AI、await 串行；
  // 步内多 AI 由 dispatcher 的 Promise.all 并行；跨步上下文靠 orchestrator delta 机制自动透传
  //（后说话的 AI 首次参与时 delta 会补齐它没看过的前序发言），故后端零改动，这里只是驱动循环。
  function _buildWorkflowMembers(meeting) {
    const subSids = (meeting && Array.isArray(meeting.subSessions)) ? meeting.subSessions : [];
    const out = [];
    for (let i = 0; i < subSids.length; i++) {
      const sid = subSids[i];
      const s = (typeof sessions !== 'undefined' && sessions) ? sessions.get(sid) : null;
      if (!s) continue;
      const kind = s.kind || 'claude';
      const title = s.title || (typeof _KIND_LABELS !== 'undefined' && _KIND_LABELS[kind]) || kind || `AI ${i + 1}`;
      const spec = Array.isArray(meeting.slotSpecs) ? (meeting.slotSpecs[i] || {}) : {};
      out.push({ memberId: spec.memberId || `m${i + 1}`, kind, title });
    }
    return out;
  }

  async function _ensureWorkflowMembersReady(meeting, targetMemberIds) {
    const ids = Array.isArray(targetMemberIds) ? targetMemberIds : [];
    const wakeTasks = ids.map(async (memberId) => {
      const specs = Array.isArray(meeting.slotSpecs) ? meeting.slotSpecs : [];
      const index = specs.findIndex((spec, i) => String(spec && spec.memberId || `m${i + 1}`) === String(memberId));
      const sid = Number.isInteger(index) && index >= 0 ? (meeting.subSessions || [])[index] : null;
      if (!sid) throw new Error(`工作流成员 ${memberId} 不存在`);
      const session = (typeof sessions !== 'undefined' && sessions) ? sessions.get(sid) : null;
      if (!session) throw new Error(`工作流成员 ${memberId} 会话不存在`);
      if (session.status !== 'dormant') return session;
      if (typeof window.resumeDormantSession !== 'function') {
        throw new Error(`工作流成员 ${memberId} 无法唤醒`);
      }
      const resumed = await window.resumeDormantSession(sid);
      if (!resumed) throw new Error(`工作流成员 ${memberId} 唤醒失败`);
      return resumed;
    });
    return Promise.all(wakeTasks);
  }

  function _updateWorkflowBtnState(meeting) {
    const btn = document.getElementById('mr-workflow-btn');
    if (!btn) return;
    // File workflows use the same settings entry; their protocol stays attached.
    // 2026-07-20 maintainer [修#7d]：非群聊会议隐藏 workflow 按钮。
    btn.style.display = (meeting && meeting.groupChat) ? '' : 'none';
    const controls = document.getElementById('mr-workflow-controls');
    if (controls) controls.hidden = !(meeting && meeting.groupChat);
    if (!(meeting && meeting.groupChat)) {
      const toggle = document.getElementById('mr-workflow-switch');
      if (toggle) toggle.hidden = true;
    }
    if (!(meeting && meeting.groupChat)) return;
    const badge = document.getElementById('mr-workflow-badge');
    const wf = meeting && meeting.serialWorkflow;
    const on = !!(wf && wf.enabled && Array.isArray(wf.steps) && wf.steps.length);
    const toggle = document.getElementById('mr-workflow-switch');
    if (toggle) {
      toggle.hidden = !(meeting?.groupChat && Array.isArray(wf?.steps) && wf.steps.length);
      toggle.setAttribute('aria-checked', String(on));
      toggle.setAttribute('aria-label', on ? '关闭工作流' : '启用工作流');
      toggle.title = on ? '工作流生效中 · 点击关闭' : '工作流已关闭 · 点击启用';
    }
    const workflowApi = window.WorkflowTemplates;
    const presetMeta = on && workflowApi && typeof workflowApi.getTemplateMeta === 'function'
      ? workflowApi.getTemplateMeta(wf.templateId)
      : null;
    const workflowLabel = require('../core/workflow-settings').PRESETS.find(p=>p.id===wf?.settingsPreset)?.name || presetMeta?.name || '工作流';
    btn.classList.toggle('active', on);
    const roundCount = DevFile.enabled(meeting) && !DevFile.isSolo(meeting) ? 3 : wf?.steps?.length || 0;
    if (badge) badge.textContent = on ? String(roundCount) : '';
    btn.title = on ? `${workflowLabel}：${roundCount} 轮（点击修改）` : '工作流设置';
    btn.setAttribute('aria-label', on ? `${workflowLabel}，${roundCount} 轮，点击修改` : '工作流设置');
  }

  async function runSerialWorkflow(meeting, userInput) {
    const m = meetingData[meeting.id] || meeting;
    const trimmed = String(userInput || '').trim();
    const pendingUser = trimmed ? _rememberPendingUserMessage(m, trimmed) : null;
    try {
      // Timeline remains the human-facing original goal; internal step prompts
      // are produced and checkpointed by the main-process workflow engine.
      await ipcRenderer.invoke('meeting-append-user-turn', { meetingId: m.id, text: trimmed });
      const result = await ipcRenderer.invoke('serial:start', {
        meetingId: m.id,
        userInput: trimmed,
      });
      if (!result || !result.ok) {
        throw new Error(result && result.reason || 'serial_start_failed');
      }
      _showGcEscapeNotice(Conversation.enabled(m) ? '已按保存的顺序发言' : '串行工作流已启动；刷新或 Hub 重启后会从持久检查点继续', 'info');
    } catch (error) {
      _discardPendingUserMessage(m.id, { clientId: pendingUser && pendingUser.clientId });
      const recovery = _restoreQuestionAndPreserveDraft(m.id, trimmed);
      const suffix = recovery.mergedWithDraft
        ? '；原问题与当前草稿均已保留'
        : recovery.restored ? '；原问题已恢复到输入框' : '';
      _showGcEscapeNotice(`串行工作流启动失败：${error && error.message ? error.message : String(error)}${suffix}`, 'error');
    }
    m.lastMessageTime = Date.now();
    ipcRenderer.send('update-meeting', { meetingId: m.id, fields: { lastMessageTime: m.lastMessageTime } });
  }
  // Loop/repeat execution intentionally lives only in the main-process
  // workflow engine.  The former renderer driver duplicated the state machine,
  // could be killed by a page reload, and raced main-process boot resume.
  function findSessionByKind(meeting, kind) {
    if (!meeting || !meeting.subSessions) return null;
    for (const sid of meeting.subSessions) {
      const s = (typeof sessions !== 'undefined' && sessions) ? sessions.get(sid) : null;
      if (s && s.kind === kind && s.status !== 'dormant') return sid;
    }
    return null;
  }

  // Group chat 轮次完成：清掉 partialBy + 乐观标记（防止 turn-complete 比 IPC.then 更早），
  // 从 IPC 拉最终 state（含 turn N 已持久化）
  // 2026-05-05 maintainer 修3：cache 清理对所有 meeting 都做（含非 active），DOM 重渲仅 active 做。
  //   之前的 `meetingId === activeMeetingId` 守卫导致非 active AI 群聊 _partialBy 残留，
  //   切回时 cached.currentMode!=idle 但实际 server 已 idle → 卡片显示 streaming 假象。
  ipcRenderer.on('groupchat-turn-complete', (_event, payload = {}) => {
    if (!_acceptGcPush(payload)) return;
    const { meetingId, turnNum, superseded } = payload;
    const meeting = meetingData[meetingId];
    if (!_isPanelCapableMeeting(meeting)) return;
    // 抢占式连发（2026-06-24 maintainer）：被新一轮抢占结算的「旧轮」完成通知 —— 新轮已在
    //   triggerGroupChat 乐观置 currentMode='group'+清 partialBy；这里若再清乐观态/
    //   currentMode 会把新轮思考态抹成 idle。旧轮 superseded 结果已持久化进 state.turns，
    //   回看历史可见，无需此刻刷新。
    if (superseded) {
      _discardPendingUserMessage(meetingId, { throughTurn: turnNum });
      return;
    }
    // === Phase 1: cache 清理（所有 meeting 都做）===
    delete _gcOptimisticTurn[meetingId];
    delete _gcActiveSids[meetingId];
    delete _gcAttemptIdsBySid[meetingId];
    // 2026-05-05 maintainer：本轮已 settle,state.turns[N].userInput 接管,清掉进行中缓存。
    _discardPendingUserMessage(meetingId, { throughTurn: turnNum });
    const cached = _gcPanelState[meetingId];
    if (cached) {
      cached._partialBy = null;
      cached.currentMode = null;
    }
    // === Phase 2: DOM 重渲（仅 active meeting）===
    //   非 active AI 群聊的全员完成通知由 renderer.js 监听同 IPC 累加 meeting.unreadCount
    //   触发侧栏 has-unread + ⏸ 等你 badge，不在此处理。
    if (meetingId !== activeMeetingId) return;
    refreshGroupChatPanel(meeting);
    if (cached) renderToolbar(meeting);
  });

  // 2026-07-29 maintainer [群聊运行中可操作]：用户点「停止本轮」后主进程的确认广播。
  //   真正的状态收敛仍由随后的 groupchat-turn-complete 完成（interrupted 结算会让
  //   dispatcher 的 allSettled 立即 resolve）；这里只做「没有 watcher 可停」的兜底：
  //   后端已把 orchestrator 收回 idle，前端也要同步清乐观思考态，否则卡片会一直转。
  ipcRenderer.on('groupchat-turn-interrupted', (_event, payload = {}) => {
    if (!_acceptGcPush(payload)) return;
    const { meetingId, stopped, pendingDispatch } = payload;
    if (!meetingId) return;
    if (Array.isArray(stopped) && stopped.length > 0) return; // 走正常 turn-complete 收敛
    if (pendingDispatch) return; // 有轮正卡在发送中，它自己会以 interrupted 收敛，别抢着清
    delete _gcOptimisticTurn[meetingId];
    delete _gcActiveSids[meetingId];
    delete _gcAttemptIdsBySid[meetingId];
    const cached = _gcPanelState[meetingId];
    if (cached) {
      cached._partialBy = null;
      cached.currentMode = null;
    }
    if (meetingId !== activeMeetingId) return;
    const meeting = meetingData[meetingId];
    if (!_isPanelCapableMeeting(meeting)) return;
    refreshGroupChatPanel(meeting);
    renderToolbar(meeting);
  });

  // pilot redesign（2026-05-02）：timeline-append / timeline-update / _updatePilotPlaceholder 整体废弃
  //   （pilot recap 卡片不再生成，AI 群聊 timeline 只保留 fanout/debate/summary 公开发言记录）。

  // T2（2026-05-04 maintainer）：partial diff 短路 — 内容完全没变就不动 DOM，
  //   修复 B2「皮卡丘已 settled 后小火龙心跳仍打回皮卡丘卡片滚动条」。
  function _isPartialUnchanged(prev, next) {
    if (!prev && !next) return true;
    if (!prev || !next) return false;
    if (prev.text !== next.text) return false;
    if (prev.status !== next.status) return false;
    if (prev.cleanBufLen !== next.cleanBufLen) return false;
    if (prev.sendStatus !== next.sendStatus) return false;
    if (prev.attemptId !== next.attemptId) return false;
    if (prev.providerTurnId !== next.providerTurnId) return false;
    if (JSON.stringify(prev.displayMessages) !== JSON.stringify(next.displayMessages)) return false;
    if (prev.reason !== next.reason) return false;
    if ((prev.failure && prev.failure.code) !== (next.failure && next.failure.code)) return false;
    const pt = prev.tokens && prev.tokens.total;
    const nt = next.tokens && next.tokens.total;
    if (pt !== nt) return false;
    const pb = Array.isArray(prev.blocks) ? prev.blocks : null;
    const nb = Array.isArray(next.blocks) ? next.blocks : null;
    if (!pb && !nb) return true;
    if (!pb || !nb) return false;
    if (pb.length !== nb.length) return false;
    if (pb.length === 0) return true;
    const last = pb.length - 1;
    if (pb[last].type !== nb[last].type) return false;
    if ((pb[last].text || '') !== (nb[last].text || '')) return false;
    return true;
  }

  // Group chat 单家 partial-update：T2（2026-05-04 maintainer）局部 patch + diff 短路 + scrollTop 保留
  //   修复 B2 滚动条弹回：旧版 panel.innerHTML 全量重渲，三家卡片 DOM 全销毁→
  //   皮卡丘 settled 后小火龙心跳仍把皮卡丘 .mr-ft-preview 的 scrollTop 拍回 0。
  // 2026-05-05 maintainer 修3：cache 同步与 DOM 解耦 ——
  //   旧版 `meetingId !== activeMeetingId → return` 让非 active AI 群聊的 cache 永远跟不上 server，
  //   切回时残留 streaming partial → 卡片显示错状态。新版 cache 同步对所有 meeting 都做，
  //   DOM 操作仅 active 时执行。
  // 2026-07-21 maintainer [修思考中口径]：后端实际发送目标 → 覆盖乐观猜测的 _gcActiveSids，
  //   思考中气泡/进度分母立即与真实发言一致（_expectedParticipantSids 优先读 _gcActiveSids）。
  ipcRenderer.on('groupchat-turn-targets', (_event, payload = {}) => {
    if (!_acceptGcPush(payload, { allowRunReplacement: true })) return;
    const { meetingId, sids, attemptIdsBySid } = payload;
    if (!meetingId || !Array.isArray(sids)) return;
    _gcActiveSids[meetingId] = new Set(sids);
    _gcAttemptIdsBySid[meetingId] = attemptIdsBySid && typeof attemptIdsBySid === 'object'
      ? { ...attemptIdsBySid }
      : {};
    if (meetingId === activeMeetingId) {
      const m0 = meetingData[meetingId] || (typeof meetings !== 'undefined' && meetings[meetingId]);
      if (m0) refreshGroupChatPanel(m0);
    }
  });

  // Canonical lifecycle projection shared with the sidebar. Content still
  // arrives through partial-update, but only this attempt-scoped event decides
  // whether a member is running, reconciling, completed, or failed.
  ipcRenderer.on('groupchat-attempt-changed', (_event, payload = {}) => {
    if (!_acceptGcPush(payload, {
      allowRunReplacement: payload.status === 'prepared' || payload.status === 'submitting',
    })) return;
    const { meetingId, turnNum, sid, attemptId, status, failure, reason, providerTurnId } = payload;
    const meeting = meetingData[meetingId];
    if (!_isPanelCapableMeeting(meeting) || !sid) return;
    const uiStatus = {
      prepared: 'thinking',
      submitting: 'thinking',
      queued: 'queued',
      accepted: payload.signalSource === 'claude-stream-json' ? 'accepted' : 'streaming',
      waiting: 'waiting',
      running: 'streaming',
      awaiting_binding: 'awaiting_binding',
      awaiting_final_text: 'awaiting_final_text',
      recovering: 'recovering',
      completed: 'completed',
      failed: 'errored',
      interrupted: 'interrupted',
      superseded: 'superseded',
      absent: 'absent',
    }[status] || status || 'thinking';
    const cached = _gcPanelState[meetingId] || (_gcPanelState[meetingId] = {
      currentMode: 'group', currentTurn: Number(turnNum) || 0,
      messages: [], turns: [], aiStats: {}, _partialBy: {},
    });
    if (Number(turnNum) > Number(cached.currentTurn || 0)) cached.currentTurn = Number(turnNum);
    if (!cached._partialBy) cached._partialBy = {};
    const previous = cached._partialBy[sid] || {};
    cached._partialBy[sid] = {
      ...previous,
      status: uiStatus,
      attemptId: attemptId || previous.attemptId,
      providerTurnId: providerTurnId || previous.providerTurnId,
      reason: (failure && failure.code) || reason || previous.reason,
      failure: failure || previous.failure,
    };
    if (!_gcAttemptIdsBySid[meetingId]) _gcAttemptIdsBySid[meetingId] = {};
    if (attemptId) _gcAttemptIdsBySid[meetingId][sid] = attemptId;
    if (meetingId !== activeMeetingId) return;
    _renderActivePanelFromCache(meeting);
    renderToolbar(meeting);
  });

  ipcRenderer.on('groupchat-partial-update', (_event, payload = {}) => {
    if (!_acceptGcPush(payload)) return;
    const { meetingId, turnNum, sid, status, text, thinkSec, tokens, blocks, source, cleanBufLen, reason, failure, attemptId, providerTurnId } = payload;
    const { displayMessages } = payload;
    const meeting = meetingData[meetingId];
    if (!_isPanelCapableMeeting(meeting)) return;
    // === Phase 1: cache 同步（任何 meeting 都做，含非 active）===
    let cached = _gcPanelState[meetingId];
    if (!cached) {
      // Do not drop the first/only event. A send exception may emit exactly one
      // errored partial while another member keeps the turn open; waiting for a
      // second heartbeat left the failed member invisible for minutes.
      cached = _gcPanelState[meetingId] = {
        currentMode: 'group', currentTurn: Number(turnNum) || 0,
        messages: [], turns: [], aiStats: {}, _partialBy: {},
      };
      _syncGroupChatCacheFromServer(meeting).then(({ ok }) => {
        if (ok && meetingId === activeMeetingId) refreshGroupChatPanel(meeting);
      });
    }
    if (!cached.currentTurn && Number(turnNum)) cached.currentTurn = Number(turnNum);
    if (!cached._partialBy) cached._partialBy = {};
    const next = {
      text: text || '',
      status: status || 'completed',
      thinkSec: typeof thinkSec === 'number' ? thinkSec : undefined,
      tokens: tokens || undefined,
      blocks: Array.isArray(blocks) ? blocks : undefined,
      displayMessages: Array.isArray(displayMessages) ? displayMessages : undefined,
      source: source || undefined,
      cleanBufLen: typeof cleanBufLen === 'number' ? cleanBufLen : undefined,
      // errored settle 带失败原因，占位文案用它解释"为什么失败"（2026-07-12）
      reason: reason || undefined,
      failure: failure || undefined,
      attemptId: attemptId || undefined,
      providerTurnId: providerTurnId || undefined,
    };
    const prev = cached._partialBy[sid];
    // T2（2026-05-04 maintainer）：先把 sendStatus 从 prev 抄到 next，再做 diff —— 否则 stuck 心跳每次都误判变化，短路失效。
    next.sendStatus = prev && prev.sendStatus;
    // 2026-05-05 fix（虚警）：streaming/completed/manual_extracted 物理上否定 stuck 状态
    //   （\r 提交已生效），强清 sendStatus。否则 1A verify 误判 stuck 后即使后续真
    //   streaming 750 字进来，UI 仍显示"⚠ 输入卡顿"误导用户。
    if (next.sendStatus === 'stuck' && (status === 'streaming' || status === 'completed' || status === 'manual_extracted')) {
      delete next.sendStatus;
    }
    // T2 short-circuit：内容完全无变化（高频心跳常见）→ 直接 return，0 DOM 操作
    if (_isPartialUnchanged(prev, next)) return;
    cached._partialBy[sid] = next;  // ← cache 写入完成（无论 active 与否都做）

    // === Phase 2: DOM 更新（仅 active meeting 做）===
    if (meetingId !== activeMeetingId) return;
    // 2026-05-05 maintainer：时光机模式短路 — 用户在看第 N 轮历史快照时，partial-update
    //   不应该把卡片 outerHTML 替换为最新 streaming 内容（否则用户感知"被强制跳回最新轮"）。
    //   cache 已经在上面更新（保持一致性，用户退出时光机后即可看到最新态），仅跳过 DOM patch。
    //   refreshGroupChatPanel 全量路径走 _renderFusedTabs 已有 isTimeTravel 分支，不受影响。
    if (typeof _gcViewingTurnN[meetingId] === 'number') return;

    // 2026-05-15 maintainer 群聊弹顶 bug 修复：群聊视图（聊天流模式）走专属局部 patch
    //   旧路径下群聊视图 DOM 没有 .mr-ft 元素 → 必走下面的 fallback 全量重渲 →
    //   每次 partial 都重建 .mr-gc-messages 容器 → scrollTop 丢失。新路径优先
    //   走 _patchGroupChatPendingMessage 只替换单条 pending article。patch 失败
    //   （DOM 节点找不到等）才退到全量重渲兜底。
    const panel = _ensureGcPanel();
    if (meeting.groupChat) {
      if (_patchGroupChatPendingMessage(panel, meeting, sid, cached)) return;
      // patch 失败：可能 pending 区还没首次渲染（meeting 刚切换、cache 刚同步），
      //   走下方 fallback 全量重渲（仍带 capture+restore 保护 scrollTop）
      const groupScroll = _captureGroupChatScroll(panel, meeting);
      try {
        _renderGcPanelInto(panel, meeting, cached, { scroll: groupScroll });
      } catch (e) {
        console.error('[groupchat] partial-update fallback rebuild failed:', e);
      }
      return;
    }
    // T2 局部 patch：找到该 sid 的 slot DOM，outerHTML 替换；其他两个 slot 完全不动
    const slotEl = panel.querySelector(`.mr-ft[data-ft-sid="${sid}"]`);
    if (!slotEl) {
      // 兜底：DOM 找不到该 slot（panel 还没渲染过）→ 全量重渲
      // silent-failure-hunter L1（2026-05-04 maintainer）：并发场景（partial-update 在 turn-complete
      //   之后到、cached 字段意外 null）下 _renderGcPanelHtml 可能抛 TypeError，
      //   原版无 try/catch → 整个 IPC 回调崩溃，panel 残破。包一层让回调能 return。
      const groupScroll = _captureGroupChatScroll(panel, meeting);
      try {
        _renderGcPanelInto(panel, meeting, cached, { scroll: groupScroll });
      } catch (e) {
    console.error('[groupchat] partial-update fallback rebuild failed:', e);
      }
      return;
    }
    // T2 scrollTop 保留：替换前记录 .mr-ft-preview 的滚动位置（即使是流式增长的家自己，也尽量保留）
    const prevPreview = slotEl.querySelector('.mr-ft-preview');
    const savedScrollTop = prevPreview ? prevPreview.scrollTop : 0;
    // 计算新 HTML
    const slots = _getGcSlots(meeting);
    const slotIndex = slots.findIndex(slot => slot && slot.sid === sid);
    if (slotIndex < 0) return;
    const lastTurn = cached.turns.length > 0 ? cached.turns[cached.turns.length - 1] : null;
    const focused = meeting.focusedSub || meeting.subSessions[0];
    const ctx = {
      state: cached, currentMode: cached.currentMode || 'idle', partialBy: cached._partialBy,
      meeting, slots, lastTurn, meetingId: meeting.id, focused,
    };
    const { html } = _renderSlotCard(slotIndex, ctx);
    if (!html) return;
    // outerHTML 替换该 slot（其他卡片 DOM 节点完全不被打扰）
    slotEl.outerHTML = html;
    // 重新查找新节点（outerHTML 替换后旧引用已失效）
    const newSlotEl = panel.querySelector(`.mr-ft[data-ft-sid="${sid}"]`);
    if (newSlotEl) {
      _bindSlotCardEvents(newSlotEl, meeting);
      // 恢复 scrollTop
      const newPreview = newSlotEl.querySelector('.mr-ft-preview');
      if (newPreview && savedScrollTop > 0) newPreview.scrollTop = savedScrollTop;
    }
    // T3（2026-05-04 maintainer）：抽屉实时订阅 — 用户打开 ↗ 看本 sid 的实时 tab 时，
    //   不重建 overlay，仅 mutate `.mr-gc-tl-body` innerHTML，保留用户的滚动位置。
    if (_gcTimelineLive && _gcTimelineLive.sid === sid && _gcTimelineLive.mid === meetingId) {
      const overlay = document.getElementById('mr-gc-timeline-overlay');
      if (overlay && overlay.style.display !== 'none') {
        const tlBody = overlay.querySelector('.mr-gc-tl-body');
        if (tlBody) {
          let inner;
          if (Array.isArray(next.blocks) && next.blocks.length > 0) {
            inner = _renderPreviewBlocks(next.blocks, sid);
          } else if (next.text) {
            inner = _renderMarkdown(next.text);
          } else {
            inner = '<div class="mr-gc-tl-empty" style="opacity:.6">💭 思考中…等待 AI 输出</div>';
          }
          // T3 滚动保留：mutate innerHTML 时记录旧 scrollTop，在父容器（.mr-gc-tl-content）层面恢复
          const tlContent = overlay.querySelector('#mr-gc-tl-content');
          const savedScroll = tlContent ? tlContent.scrollTop : 0;
          tlBody.innerHTML = inner;
          if (tlContent && savedScroll > 0) tlContent.scrollTop = savedScroll;
        }
      }
    }
  });

  // Stage 2 容错升级：软提醒 banner —— watcher 在 T1=90s/T2=180s 触发，UI 弹非阻塞 banner
  // 提示用户"还在等"，提供"一键提取/跳过/继续等"操作。永不阻塞按钮（按钮 disabled
  // 由 _allParticipantsSettled 决定，与本 banner 无关）。
  ipcRenderer.on('groupchat-soft-alert', (_event, payload = {}) => {
    if (!_acceptGcPush(payload)) return;
    const { meetingId, sid, label, level, mode, turnNum } = payload;
    const meeting = meetingData[meetingId];
    if (!_isPanelCapableMeeting(meeting)) return;

    // 2026-05-05 maintainer 修3：cache 同步对所有 meeting 都做（写 _partialBy[sid].status='soft_alert'），
    //   切回该 AI 群聊时卡片自动显示"等待中…"状态。
    //   banner DOM 仅 active 时弹（跨 meeting 弹 banner 文案"XX 已等待"会让用户混乱当前看的不是这个 AI 群聊）。
    //   非 active AI 群聊的 soft-alert 不接入侧栏 unread —— 这是"AI 慢响应"信号，
    //   语义跟"全员完成"不同，混入侧栏会让"⏸ 等你"badge 含义模糊。
    const cached = _gcPanelState[meetingId];
    if (cached) {
      if (!cached._partialBy) cached._partialBy = {};
      const existing = cached._partialBy[sid] || {};
      cached._partialBy[sid] = { ...existing, status: 'soft_alert' };
    }
    // === Phase 2: banner DOM 与 panel 重渲（仅 active）===
    if (meetingId !== activeMeetingId) return;
    _updateInputPreflight(meeting);
    const banner = document.getElementById('mr-gc-soft-alert-banner');
    if (banner) {
      const levelLabel = level === 't2' ? '3 分钟' : '90 秒';
      const hint = '尚未收到本轮结束确认，状态可能过期；请先查看对应 CLI，避免重复发送。';
      banner.className = 'mr-gc-soft-alert-banner';
      banner.innerHTML = `
        <div class="mr-gc-soft-alert-msg">
          <strong>${escapeHtml(label || sid.slice(0, 8))}</strong> 已等待 <strong>${levelLabel}</strong>。
          <span class="mr-gc-soft-alert-hint">${hint}</span>
        </div>
        <button class="mr-gc-soft-alert-close" data-gc-banner-close="1" title="关闭提示">×</button>
      `;
      banner.style.display = 'flex';
      banner.querySelectorAll('[data-gc-banner-close]').forEach(b => {
        b.addEventListener('click', () => { banner.style.display = 'none'; banner.innerHTML = ''; }, { once: true });
      });
    }
    if (cached) {
      const panel = _ensureGcPanel();
      // 群聊弹顶 bug 修复（2026-06-05 maintainer）：soft-alert 90s/180s 触发时全量重渲
      //   过去无 capture/restore → .mr-gc-messages 容器 scrollTop 被拍回 0,视觉弹顶。
      const groupScroll = _captureGroupChatScroll(panel, meeting);
      _renderGcPanelInto(panel, meeting, cached, { scroll: groupScroll });
    }
  });

  // T6（2026-05-03）：send-stuck 事件 → 数据驱动写 _partialBy[sid].sendStatus='stuck'，
  //   再 refreshGroupChatPanel 重渲——这样 innerHTML 重渲后状态也能保留（H2 数据驱动方案）。
  //   H1 修复：补 activeMeetingId 守卫，与其他 groupchat-* 监听器保持一致。
  ipcRenderer.on('groupchat-send-stuck', (_e, payload = {}) => {
    if (!_acceptGcPush(payload)) return;
    const { meetingId, sid } = payload;
    const meeting = meetingData[meetingId];
    if (!_isPanelCapableMeeting(meeting)) return;

    // 2026-05-05 maintainer 修3：cache 同步对所有 meeting 都做（写 sendStatus='stuck'），
    //   切回该 AI 群聊时卡片自动显示"⚠ 输入卡顿"状态 + [📤 发送] 按钮亮起。
    //   panel DOM 重渲仅 active 做。
    const cached = _gcPanelState[meetingId] || (_gcPanelState[meetingId] = {
      currentMode: 'group', currentTurn: 0, messages: [], turns: [], aiStats: {}, _partialBy: {},
    });
    if (!cached._partialBy) cached._partialBy = {};
    const existing = cached._partialBy[sid] || {};
    // 保留已有 text/status/blocks，仅追加 sendStatus='stuck'
    cached._partialBy[sid] = { ...existing, sendStatus: 'stuck' };
    console.warn(`[renderer] groupchat-send-stuck meeting=${meetingId} sid=${sid.slice(0,8)}`);
    if (meetingId !== activeMeetingId) return;
    if (cached) {
      const panel = _ensureGcPanel();
      // 群聊弹顶 bug 修复（2026-06-05 maintainer）：send-stuck 在用户提问瞬间常触发,
      //   过去无 capture/restore → 整个 panel 重渲后 scrollTop=0,用户视觉"弹顶"。
      const groupScroll = _captureGroupChatScroll(panel, meeting);
      _renderGcPanelInto(panel, meeting, cached, { scroll: groupScroll });
    }
  });

  // T6（2026-05-03）：turn-patched 事件 → 卡片右上角浮"自动补全 +N 字"角标 + 触发刷新
  //   H1 修复：补 activeMeetingId 守卫。
  //   M2 修复（最小化方案）：先 await refreshGroupChatPanel 拿最新 turn meta 重渲，
  //     再追加 badge 到新 DOM 节点上（旧节点已被 innerHTML 替换），避免 badge 被立即抹掉。
  ipcRenderer.on('groupchat-history-updated', async (_e, payload = {}) => {
    if (!_acceptGcPush(payload)) return;
    const meeting=meetingData[payload.meetingId];
    if(!meeting)return;
    const {state,ok}=await _syncGroupChatCacheFromServer(meeting);
    if(!ok || meeting.id!==activeMeetingId)return;
    const panel=document.getElementById('meeting-room-panel');
    if(!panel)return;
    const members=_groupMemberMap(meeting),scroll=_captureGroupChatScroll(panel,meeting);
    for(const m of state.messages || []) {
      if(m.sid!==payload.sid || m.sourceMessage || m.status==='progress_update')continue;
      const displayMessages=require('../core/conversation-display').groupDisplayMessages(m,state.displayMessagesByAttempt?.[m.attemptId]);
      if(!displayMessages?.length)continue;
      const old=panel.querySelector(`[data-gc-msg-id="${CSS.escape(m.id)}"]`);
      if(!old)continue;
      const temp=document.createElement('div');
      temp.innerHTML=_renderGroupChatMessage({...m,displayMessages},meeting,members);
      require('./conversation-message-view').patchConversationArticle(old,temp.firstElementChild);
    }
    _patchGroupChatPendingMessage(panel,meeting,payload.sid,state);
    require('./groupchat-journal').enhance(panel);
    _enhanceGroupCardContent(panel);
    _restoreGroupChatScroll(panel,scroll);
  });

  // A member's answer file changed (main/groupchat/answer-file-monitor.js).
  ipcRenderer.on('groupchat:answer-file', (_e, payload = {}) => {
    if (!_acceptGcPush(payload)) return;
    const meeting = meetingData[payload.meetingId];
    if (meeting && payload.meetingId === activeMeetingId) {
      refreshGroupChatPanel(meeting).catch(error => console.warn('[answer-files] refresh failed:', error.message));
    }
  });

  ipcRenderer.on('dev-workbench:progress', (_e, payload = {}) => {
    if (!_acceptGcPush(payload)) return;
    const meeting = meetingData[payload.meetingId];
    if (meeting && payload.meetingId === activeMeetingId && (meeting.scene === 'dev' || Delivery.enabled(meeting))) {
      refreshGroupChatPanel(meeting).catch(error => console.warn('[dev-workbench] group progress refresh failed:', error.message));
    }
  });

  ipcRenderer.on('groupchat-turn-patched', async (_e, payload = {}) => {
    if (!_acceptGcPush(payload)) return;
    const { meetingId, turnNum, sid, charCount } = payload;
    const meeting = meetingData[meetingId];
    if (!_isPanelCapableMeeting(meeting)) return;
    // 2026-05-05 maintainer 修3：cache 同步（拉 server state 拿到 patch 后的 lastTurn.by）对所有 meeting 都做，
    //   切回该 AI 群聊时 lastTurn 自动是 patch 后的最新文本。
    //   "自动补全 +N 字"badge 是 3s 浮动动画，仅 active 时追加（跨切换语义弱，非 active 期间错过没影响）。
    if (meetingId === activeMeetingId) {
      // active：先重渲拿最新 turn meta，badge 在新 DOM 上追加
      await refreshGroupChatPanel(meeting);
      const card = document.querySelector(`.mr-ft[data-ft-sid="${sid}"]`);
      if (card) {
        let badge = card.querySelector('.mr-ft-auto-patched-badge');
        if (!badge) {
          badge = document.createElement('span');
          badge.className = 'mr-ft-auto-patched-badge';
          card.appendChild(badge);
        }
        badge.textContent = `自动补全 +${charCount}字`;
        badge.classList.remove('fade-out');
        void badge.offsetWidth;  // 强制 reflow 让 fade-out 动画从头开始
        badge.classList.add('fade-out');
        setTimeout(() => { try { badge.remove(); } catch {} }, 3000);
      }
    } else {
      // 非 active：仅 cache 同步（不动 DOM）
      _syncGroupChatCacheFromServer(meeting);
    }
    console.log(`[renderer] groupchat-turn-patched turn=${turnNum} sid=${sid.slice(0,8)} +${charCount} chars`);
  });

  const panelEl = () => document.getElementById('meeting-room-panel');
  const headerEl = () => document.getElementById('mr-header');
  const terminalsEl = () => document.getElementById('mr-terminals');
  const toolbarEl = () => document.getElementById('mr-toolbar');
  const inputBoxEl = () => document.getElementById('mr-input-box');
  const sendBtnEl = () => document.getElementById('mr-send-btn');

  const _INPUT_DRAFTS_STORAGE_KEY = 'mr-input-drafts-v1';
  const _INPUT_HISTORY_STORAGE_KEY = 'mr-input-history-v1';
  const _INPUT_HISTORY_LIMIT = 20;
  const _LONG_INPUT_CHAR_THRESHOLD = 1200;

  function _readJsonStorage(key, fallback) {
    try {
      if (typeof localStorage === 'undefined') return fallback;
      const raw = localStorage.getItem(key);
      if (!raw) return fallback;
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? parsed : fallback;
    } catch {
      return fallback;
    }
  }

  function _writeJsonStorage(key, value) {
    try {
      if (typeof localStorage === 'undefined') return;
      localStorage.setItem(key, JSON.stringify(value || {}));
    } catch (err) {
      console.warn('[meeting-room] input storage write failed:', err && err.message ? err.message : err);
    }
  }

  // 2026-05-05 maintainer：输入框草稿 per meeting 独立。2026-06-20: 升级为本地持久化，
  //   避免 Hub 重启、误刷新或切会时未发送 prompt 丢失。
  const _inputDraftByMeeting = _readJsonStorage(_INPUT_DRAFTS_STORAGE_KEY, {});
  let _inputHistoryMenuEl = null;

  // 2026-07-20 maintainer [修#10]：草稿落盘 debounce 500ms——此前每击键全量 JSON.stringify 写 localStorage
  const _inputDraftWriteTimers = {};

  // 群聊输入框的长文本粘贴块（与会话输入框同一套，见 composer-paste-chips.js）。
  // 「原始文本」= 输入框 innerText，粘贴块在里面是内部标记；写回输入框一律走 _renderComposerRaw
  // 把标记还原成块 —— 直接赋 textContent 会把块变成一串可见的 id。发送和交给外部的文字才展开。
  // 持久化草稿存展开后的原文（标记跨重启无意义）；内存里另记原始文本，切回群聊时按原样还原块。
  const _pasteChips = require('./composer-paste-chips.js');
  const _rawDraftByMeeting = {};
  function _renderComposerRaw(el, raw) {
    _pasteChips.renderComposerValue(el, raw, { document });
  }
  function _restoreDraftIntoInput(meetingId, inp) {
    const text = _inputDraftByMeeting[meetingId] || '';
    const raw = _rawDraftByMeeting[meetingId];
    _renderComposerRaw(inp, raw && raw.text === text ? raw.raw : text);
  }

  function _setInputDraft(meetingId, text) {
    if (!meetingId) return;
    const raw = String(text || '');
    const normalized = _pasteChips.expandPasteMarkers(raw);
    if (_pasteChips.hasPasteMarkers(raw)) _rawDraftByMeeting[meetingId] = { raw, text: normalized };
    else delete _rawDraftByMeeting[meetingId];
    if (normalized.trim()) _inputDraftByMeeting[meetingId] = normalized;
    else delete _inputDraftByMeeting[meetingId];
    clearTimeout(_inputDraftWriteTimers[meetingId]);
    _inputDraftWriteTimers[meetingId] = setTimeout(() => {
      delete _inputDraftWriteTimers[meetingId];
      _writeJsonStorage(_INPUT_DRAFTS_STORAGE_KEY, _inputDraftByMeeting);
    }, 500);
  }

  function _clearInputDraft(meetingId) {
    if (!meetingId) return;
    clearTimeout(_inputDraftWriteTimers[meetingId]);
    delete _inputDraftWriteTimers[meetingId];
    delete _inputDraftByMeeting[meetingId];
    delete _rawDraftByMeeting[meetingId];
    _writeJsonStorage(_INPUT_DRAFTS_STORAGE_KEY, _inputDraftByMeeting);
  }

  function _getPromptHistory(meetingId) {
    const all = _readJsonStorage(_INPUT_HISTORY_STORAGE_KEY, {});
    const items = meetingId && Array.isArray(all[meetingId]) ? all[meetingId] : [];
    return items.filter(item => typeof item === 'string' && item.trim());
  }

  function _pushPromptHistory(meetingId, text) {
    const normalized = String(text || '').trim();
    if (!meetingId || !normalized) return;
    const all = _readJsonStorage(_INPUT_HISTORY_STORAGE_KEY, {});
    const prev = Array.isArray(all[meetingId]) ? all[meetingId] : [];
    all[meetingId] = [normalized, ...prev.filter(item => item !== normalized)].slice(0, _INPUT_HISTORY_LIMIT);
    _writeJsonStorage(_INPUT_HISTORY_STORAGE_KEY, all);
  }

  function _compactInputLine(text, maxLen = 72) {
    const oneLine = String(text || '').replace(/\s+/g, ' ').trim();
    return oneLine.length > maxLen ? oneLine.slice(0, maxLen - 1) + '…' : oneLine;
  }

  function _ensureInputPreflightRow() {
    const inputRow = document.getElementById('mr-input-row');
    if (!inputRow || !inputRow.parentNode) return null;
    let row = document.getElementById('mr-input-preflight');
    if (!row) {
      row = document.createElement('div');
      row.id = 'mr-input-preflight';
      row.className = 'mr-input-preflight';
      inputRow.parentNode.insertBefore(row, inputRow);
      // 2026-06-28 maintainer：作战面板 row 不在群聊委托容器(mr-group-chat-panel)内，
      // 故在此单独绑定 nextActions 点击委托（综合共识/互相挑错/生成交接/引用焦点卡）。
      row.addEventListener('click', (ev) => {
        const btn = ev.target && ev.target.closest ? ev.target.closest('[data-gc-next-action]') : null;
        if (!btn || !row.contains(btn)) return;
        ev.preventDefault();
        ev.stopPropagation();
        const m = activeMeetingId ? meetingData[activeMeetingId] : null;
        if (m) _handleNextAction(btn.getAttribute('data-gc-next-action'), m);
      });
    }
    // Keep the existing nodes and listeners: only their layout parent changes.
    const avatars = document.getElementById('mr-free-avatars-row');
    let head = document.getElementById('mr-composer-head');
    if (inputRow.classList.contains('mr-group-composer')) {
      if (!head) {
        head = document.createElement('div');
        head.id = 'mr-composer-head';
        head.className = 'mr-composer-head';
        inputRow.prepend(head);
      }
      if (avatars && avatars.parentNode !== head) head.prepend(avatars);
      if (row.parentNode !== head) head.append(row);
    } else if (head) {
      if (avatars) inputRow.prepend(avatars);
      inputRow.parentNode.insertBefore(row, inputRow);
      head.remove();
    }
    return row;
  }

  let _inputModelUi = null;
  let _inputModelSessionId = null;
  let _taskFilesMeetingId = null;

  function _getInputModelUi() {
    if (!_inputModelUi) _inputModelUi = createModelUiController({
      document, ipcRenderer, sessions, terminalPanelEl, escapeHtml,
      getActiveSessionId: () => _inputModelSessionId,
      refreshModelCatalog: (kind, session) => window.WorkspaceController.loadModelCatalog(kind, {
        codexProfile: session && session.codexProfile,
      }),
      openCommandScreen: sessionId => require('./command-screen').openCommandScreen(ipcRenderer, sessionId),
      // A group member need not have an opened terminal tab. Read the same hydrated
      // xterm buffer without opening a tab or resizing its PTY.
      getTerminalScreenText: sessionId => {
        const cached = terminalCache.get(sessionId);
        if (!cached?._hydrated) return '';
        const terminal = cached.terminal, buffer = terminal.buffer.active;
        const lines = [];
        for (let i = buffer.baseY; i < buffer.baseY + terminal.rows; i++) {
          lines.push(buffer.getLine(i)?.translateToString(true) || '');
        }
        return groupInputTuningFrame(lines.join('\n'));
      },
      isSessionBusy: session => sessionRuntimeIsActive(session),
      repaintActiveComposer: () => _updateInputTuning(meetingData[activeMeetingId]),
    });
    return _inputModelUi;
  }

  async function _openInputTuning(button, sessionId, kind) {
    const meetingId = activeMeetingId;
    button.disabled = true;
    try {
      if (activeMeetingId !== meetingId || !button.isConnected) return;
      _inputModelSessionId = sessionId;
      modelUi.closeModelPicker();
      const ui = _getInputModelUi();
      if (kind === 'effort') {
        const rail = buildComposerRailModel(sessions.get(sessionId), {
          supportedEfforts: composerSupportedEfforts(sessions.get(sessionId)),
        });
        ui.showEffortPicker(button, sessionId, { efforts: rail.thinking.options });
      } else if (kind === 'speed') await ui.showSpeedPicker(button, sessionId);
      else await ui.showModelPicker(button, sessionId);
    } catch (error) {
      _showGcEscapeNotice('成员设置打开失败：' + error.message, 'error');
    } finally { button.disabled = false; }
  }

  function _updateInputTuning(meeting) {
    const rail = document.getElementById('mr-input-tuning');
    if (!rail || !meeting?.groupChat || meeting.id !== activeMeetingId) return;
    const members = rail.querySelector('.mr-input-tuning-members');
    const slots = _getGcSlots(meeting).filter(Boolean);
    const key = JSON.stringify([meeting.id, slots.map(slot => slot.sid)]);
    rail._compactMenus?.update(meeting.id, slots.length);
    if (members.dataset.key !== key) {
      _inputModelUi?.closeModelPicker();
      members.dataset.key = key;
      members.replaceChildren();
      for (const slot of slots) {
        const pair = document.createElement('div');
        pair.className = 'mr-input-member-tuning';
        pair.dataset.sid = slot.sid;
        pair.innerHTML = '<span class="mr-input-member-label"></span><button type="button" class="composer-chip composer-model"><span class="composer-model-logo"></span><span class="composer-chip-label"></span><span class="composer-chip-caret">▾</span></button><button type="button" class="composer-chip composer-thinking"><span aria-hidden="true">ϟ</span><span class="composer-chip-label"></span><span class="composer-chip-caret">▾</span></button>';
        pair.querySelector('.composer-model').addEventListener('click', event => {
          event.stopPropagation(); void _openInputTuning(event.currentTarget, slot.sid, 'model');
        });
        pair.querySelector('.composer-thinking').addEventListener('click', event => {
          event.stopPropagation(); void _openInputTuning(event.currentTarget, slot.sid, 'effort');
        });
        const speedButton = document.createElement('button');
        speedButton.type = 'button'; speedButton.className = 'composer-chip composer-speed';
        speedButton.addEventListener('click',event=>{
          event.stopPropagation(); void _openInputTuning(speedButton,slot.sid,'speed');
        });
        pair.appendChild(speedButton);
        pair._contextBudget = require('./composer-context').createComposerContext(document);
        pair.appendChild(pair._contextBudget.element);
        members.appendChild(pair);
      }
    }
    for (const pair of members.children) {
      const session = sessions.get(pair.dataset.sid);
      const slot = slots.find(item => item.sid === pair.dataset.sid);
      const model = buildComposerRailModel(session, { supportedEfforts: composerSupportedEfforts(session) });
      pair.querySelector('.mr-input-member-label').textContent = slot.displayLabel;
      const modelButton = pair.querySelector('.composer-model');
      modelButton.hidden = !model.model.visible;
      modelButton.querySelector('.composer-chip-label').textContent = model.model.pending
        ? `${model.model.label} → ${model.model.pending}` : model.model.label;
      modelButton.title = `${slot.displayLabel} · 点击切换模型`;
      const logo = modelButton.querySelector('.composer-model-logo');
      logo.className = `composer-model-logo ${modelClass(session?.currentModel?.id || '')}`;
      logo.textContent = (model.model.label || '?').trim().charAt(0).toUpperCase();
      const effortButton = pair.querySelector('.composer-thinking');
      effortButton.hidden = !model.thinking.visible;
      effortButton.disabled = !model.thinking.interactive;
      effortButton.querySelector('.composer-chip-label').textContent = '推理 · ' + require('./ui-labels').effortLabel(model.thinking.label);
      effortButton.querySelector('.composer-chip-caret').hidden = !model.thinking.interactive;
      effortButton.title = model.thinking.interactive
        ? `${slot.displayLabel} · 点击选择思考深度`
        : `${slot.displayLabel} · 该 CLI 不支持会话内改档`;
      const speed = speedControl(session,window.WorkspaceController?.codexModelTuning(session?.currentModel?.id));
      const speedButton = pair.querySelector('.composer-speed');
      speedButton.hidden = !speed.visible;
      speedButton.textContent = '速度 · ' + speed.label;
      speedButton.setAttribute('aria-label',`${slot.displayLabel} · 速度：${speed.label}`);
      speedButton.setAttribute('aria-pressed',String(speed.tier === 'fast'));
      speedButton.title = `${slot.displayLabel} · ${speed.reason || '标准 / 快速；快速会增加用量或费用'}`;
      pair._contextBudget.update(model.context, slot.displayLabel);
    }
    rail._compactMenus?.refreshModels();
  }

  function _ensureInputTools(meeting) {
    const inputBox = document.getElementById('mr-input-box');
    if (!inputBox || !inputBox.parentNode) return;
    const row = inputBox.parentNode;
    row.classList.toggle('mr-group-composer', !!meeting?.groupChat);
    row.classList.toggle('composer', !!meeting?.groupChat);
    let tuning = document.getElementById('mr-input-tuning');
    if (tuning) tuning.hidden = !meeting?.groupChat;
    if (meeting?.groupChat) {
      document.getElementById('mr-input-history-btn')?.remove();
      document.getElementById('mr-input-expand-btn')?.remove();
      if (!tuning) {
        tuning = document.createElement('div');
        tuning.id = 'mr-input-tuning';
        tuning.className = 'composer-rail';
        tuning.innerHTML = '<div class="fi-bridge-toolbar"></div><div class="mr-input-tuning-members"></div>';
        require('./group-composer-tools').mountGroupComposerTools({
          toolbar: tuning.querySelector('.fi-bridge-toolbar'), input: inputBox,
          getMeeting: () => meetingData[activeMeetingId],
          referenceSession: referenceSessionIntoInput,
          appendText: appendToContenteditable, droppedFilePath,
          formatFilePaths: formatPastedFilePaths,
          onDraft: id => _setInputDraft(id, inputBox.innerText || ''),
          onHistory: button => _togglePromptHistoryMenu(button, meetingData[activeMeetingId]),
          onExpand: () => _openLongInputEditor(meetingData[activeMeetingId]),
        });
        row.appendChild(tuning);
        tuning._compactMenus = require('./group-composer-popovers').mountGroupComposerPopovers(tuning);
      }
      _updateInputTuning(meeting);
      return;
    }
    let historyBtn = document.getElementById('mr-input-history-btn');
    if (!historyBtn) {
      historyBtn = document.createElement('button');
      historyBtn.id = 'mr-input-history-btn';
      historyBtn.type = 'button';
      historyBtn.className = 'mr-input-tool-btn';
      historyBtn.title = '最近输入';
      historyBtn.setAttribute('aria-label', '最近输入');
      historyBtn.textContent = '↺';
      inputBox.parentNode.insertBefore(historyBtn, inputBox.nextSibling);
    }
    if (!historyBtn.dataset.bound) {
      historyBtn.dataset.bound = '1';
      historyBtn.addEventListener('click', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        _togglePromptHistoryMenu(historyBtn, meetingData[activeMeetingId]);
      });
    }

    let expandBtn = document.getElementById('mr-input-expand-btn');
    if (!expandBtn) {
      expandBtn = document.createElement('button');
      expandBtn.id = 'mr-input-expand-btn';
      expandBtn.type = 'button';
      expandBtn.className = 'mr-input-tool-btn';
      expandBtn.title = '展开编辑';
      expandBtn.setAttribute('aria-label', '展开编辑');
      expandBtn.textContent = '⤢';
      inputBox.parentNode.insertBefore(expandBtn, historyBtn.nextSibling);
    }
    if (!expandBtn.dataset.bound) {
      expandBtn.dataset.bound = '1';
      expandBtn.addEventListener('click', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        _openLongInputEditor(meetingData[activeMeetingId]);
      });
    }
  }

  function _updateInputHistoryButton(meeting) {
    const btn = document.getElementById('mr-input-history-btn');
    if (!btn) return;
    const count = _getPromptHistory(meeting && meeting.id).length;
    btn.disabled = count === 0;
    btn.title = count ? `最近输入 (${count})` : '最近输入为空';
  }

  // 原始文本：粘贴块是内部标记，用于改写后再经 _renderComposerRaw 写回（保住块）。
  function _getInputRawText() {
    const input = document.getElementById('mr-input-box');
    return input ? (input.innerText || input.textContent || '') : '';
  }
  // 展开后的原文：字数统计、放大编辑这类面向「内容本身」的地方用它。
  function _getInputText() {
    return _pasteChips.expandPasteMarkers(_getInputRawText());
  }

  function _renderInputChip(label, value, cls = '') {
    return `<span class="mr-input-preflight-chip ${cls}"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></span>`;
  }

  // 2026-07-20 maintainer [修#8]：循环工作流运行状态跟踪——main 的 loop:progress 一直在发，
  //   renderer 此前不监听（运行中无进度、无停止入口、可误改配置）。
  const _loopStateByMeeting = {};
  const _workflowStateByMeeting = {};
  ipcRenderer.on('loop:progress', (_e, payload) => {
    if (!payload || !payload.meetingId) return;
    _loopStateByMeeting[payload.meetingId] = payload;
    _updateInputPreflight(meetingData[payload.meetingId]);
  });
  ipcRenderer.on('workflow:progress', (_e, payload) => {
    if (!payload || !payload.meetingId) return;
    _workflowStateByMeeting[payload.meetingId] = payload;
    const meeting = meetingData[payload.meetingId];
    if (meeting && meeting.serialWorkflow) {
      meeting.serialWorkflow.serialRunState = {
        ...(meeting.serialWorkflow.serialRunState || {}),
        ...payload,
      };
    }
    _updateInputPreflight(meeting);
    if (payload.status === 'done') _showGcEscapeNotice(Conversation.enabled(meeting) ? '本次发言已完成；下一条输入仍按同一顺序回答' : '串行工作流已完成全部步骤', 'info');
    else if (payload.status === 'paused') {
      if (Conversation.enabled(meeting)) {
        // A late/missing receipt cannot put an already-dispatched question
        // back into the composer or advertise a blind resend as continuation.
        if (activeMeetingId === meeting.id) {
          const view = ConversationRelay.presentation({ ...payload, running: false },
            ConversationRelay.targets(meeting, payload, _gcPanelState[meeting.id]), []);
          _showGcEscapeNotice(view.resume ? '接力已暂停；可继续发言。' : '接力状态待核对；请先查看对应 CLI。', 'info');
        }
        return;
      }
      if (!payload.currentTurnNum && !payload.completedStepCount && payload.goal) {
        _discardPendingUserMessage(payload.meetingId);
        _restoreQuestionAndPreserveDraft(payload.meetingId, payload.goal);
      }
      _showGcEscapeNotice(`串行工作流已暂停：${payload.error && payload.error.reason || '步骤失败'}。可点击作战面板中的「继续」。`, 'error');
    }
  });

  function _renderDevFileControls(row, current) {
    const state = _devFileStates[current.id];
    if (!state && !_devFileRequests.has(current.id)) {
      _devFileRequests.add(current.id);
      ipcRenderer.invoke('dev-file:status', { meetingId: current.id }).then(s => {
        _devFileStates[current.id] = s || { error: '文件工作流未就绪', label: '状态不可用' };
      }).catch(error => {
        _devFileStates[current.id] = { error: error.message, label: '状态读取失败' };
      }).finally(() => {
        _devFileRequests.delete(current.id);
        if (activeMeetingId === current.id) _updateInputPreflight(meetingData[current.id]);
      });
    }
    const s = state || { phase: 'discuss', label: '读取文件进度…' };
    if (s.limitReached && !s.done && !s.running) s.label = `已完成 ${s.reviewLimit || 3} 轮审查仍需返工 · 现场已保留`;
    // Hub decides the next owner from the task files; the button only asks it to continue.
    const canContinue = !!s.paused && !s.running && !s.done && !s.error && !!s.next && !s.next.error;
    const continueTitle = s.next?.error ? `无法继续：${s.next.error}`
      : s.next ? `交给 ${s.next.label}${s.limitReached ? `；再给 ${s.reviewLimit || 3} 轮审查额度` : ''}。已交付的不重做` : '';
    const solo = DevFile.isSolo(current);
    const phases = solo ? [] : [['discuss', '讨论'], ['kickoff', '开题'], ['build', '施工'], ['merge', '合并']];
    const selected = _getGcSlots(current).filter(slot => slot && (!Array.isArray(current.participants) || current.participants.includes(slot.slotIndex)));
    const names = selected.map(slot => slot.displayLabel || slot.label || slot.kind).join(' / ');
    const running = !!s.running || _isGroupTurnRunning(current);
    row.innerHTML = `<div class="mr-file-flow" data-file-phase="${escapeHtml(s.phase || '')}">
      <div class="mr-file-steps">${phases.map(([key, label], i) => `<span class="${s.phase === key ? 'active' : ''}"><b>${i + 1}</b>${label}</span>`).join('<i>›</i>')}</div>
      <div class="mr-file-detail" title="${escapeHtml([s.label || '文件状态未知', s.paused ? '已暂停，点「继续」由 Hub 接续' : s.done ? '本任务已完成' : '', s.error || s.dispatchError || ''].filter(Boolean).join(' · '))}"><strong>${escapeHtml(s.label || '文件状态未知')}</strong>${s.paused ? ' · 已暂停' : s.done ? ' · 本任务已完成' : ''}
        ${s.error || s.dispatchError ? `<span class="mr-file-error">${escapeHtml(s.error || s.dispatchError)}</span>` : ''}</div>
      <div class="mr-file-actions">
        ${['discuss', 'kickoff'].includes(s.phase) && !s.error ? '<button type="button" data-file-prep title="把项目接入提示词填入输入框；检查后自行发送">立项</button>' : ''}
        ${!solo && ['discuss', 'kickoff'].includes(s.phase) && !s.error ? '<button type="button" data-file-kickoff title="把开题提示词追加到输入框，并选择负责开题的成员；检查后按 Enter 发送">开题</button>' : ''}
        ${canContinue ? `<button type="button" class="continue" data-file-continue title="${escapeHtml(continueTitle)}">继续<small>${escapeHtml(s.next.label)}</small></button>` : ''}
        <button type="button" data-file-docs>任务文件</button>
        ${running || (!s.paused && s.phase !== 'discuss' && !s.done) ? '<button type="button" class="stop" data-file-stop>停止</button>' : ''}
      </div><small class="mr-file-recipients">${escapeHtml(names ? `发送给 ${names}` : '请点亮至少一位成员')}</small></div>`;
    row.querySelector('[data-file-prep]')?.addEventListener('click', () => {
      const box = document.getElementById('mr-input-box');
      if (!box || activeMeetingId !== current.id) return;
      _renderComposerRaw(box, DevFile.appendProjectPrep(box.innerText));
      _setInputDraft(current.id, box.innerText);
      box.dispatchEvent(new Event('input', { bubbles: true }));
      box.focus();
      const range = document.createRange(); range.selectNodeContents(box); range.collapse(false);
      const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
    });
    row.querySelector('[data-file-docs]')?.addEventListener('click', async () => {
      try {
        const state = await ipcRenderer.invoke('dev-file:status', { meetingId: current.id });
        if (activeMeetingId !== current.id) return;
        if (!state?.dir) throw new Error('任务目录不可用');
        if (!window.FileManagerPanel) throw new Error('内部文件管理尚未就绪');
        await require('fs').promises.mkdir(state.dir, { recursive: true });
        if (activeMeetingId !== current.id) return;
        _taskFilesMeetingId = current.id;
        const result = await window.FileManagerPanel.open({ cwd: state.dir, label: '任务文件' });
        if (!result?.ok) throw new Error(result?.error || '任务目录读取失败');
      } catch (error) { _showGcEscapeNotice('打开任务文件失败：' + error.message, 'error'); }
    });
    row.querySelector('[data-file-stop]')?.addEventListener('click', () => { void _handleGcStopTurn(current); });
    row.querySelector('[data-file-continue]')?.addEventListener('click', async event => {
      const button = event.currentTarget;
      button.disabled = true;
      button.classList.add('is-busy');
      try {
        const result = await ipcRenderer.invoke('dev-file:continue', { meetingId: current.id });
        if (!result?.ok) throw new Error(result?.error || '继续失败');
        if (result.status) _devFileStates[current.id] = result.status;
      } catch (error) { _showGcEscapeNotice('继续失败：' + error.message, 'error'); }
      finally { if (activeMeetingId === current.id) _updateInputPreflight(meetingData[current.id]); }
    });
    row.querySelector('[data-file-kickoff]')?.addEventListener('click', async event => {
      const button = event.currentTarget;
      button.disabled = true;
      try {
        const preset = await ipcRenderer.invoke('dev-file:kickoff-preset', { meetingId: current.id });
        if (activeMeetingId !== current.id) return;
        const fresh = await _setMeetingParticipants(meetingData[current.id] || current, [preset.slot]);
        const box = document.getElementById('mr-input-box');
        if (!box || activeMeetingId !== current.id) return;
        _renderComposerRaw(box, DevFile.appendKickoff(box.innerText, preset.prompt));
        _setInputDraft(current.id, box.innerText);
        box.dispatchEvent(new Event('input', { bubbles: true }));
        renderToolbar(fresh);
        box.focus();
        const range = document.createRange(); range.selectNodeContents(box); range.collapse(false);
        const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
        _updateInputPreflight(fresh);
      } catch (error) { _showGcEscapeNotice('开题提示词准备失败：' + error.message, 'error'); }
      finally { button.disabled = false; }
    });
  }

  function _updateInputPreflight(meeting) {
    _updateInputTuning(meeting);
    const row = _ensureInputPreflightRow();
    if (!row) return;
    const current = meeting || meetingData[activeMeetingId];
    row.dataset.deliveryMeeting=current?.id || '';
    if (!current) {
      row.style.display = 'none';
      return;
    }
    row.style.display = '';
    if (OrchUI.enabled(current)) {
      OrchUI.renderStrip(row, current, { escapeHtml, onError: message => _showGcEscapeNotice(message, 'error') });
      _updateInputHistoryButton(current);
      return;
    }
    if (Delivery.enabled(current) && current.serialWorkflow.enabled) {
      DeliveryControls.render(row,current,id=>{if(activeMeetingId===id)_updateInputPreflight(meetingData[id]);},message=>_showGcEscapeNotice(message,'error'));
      _updateInputHistoryButton(current);
      return;
    }
    if (Conversation.enabled(current) && current.serialWorkflow.enabled) {
      ConversationControls.render(row,current,id=>{if(activeMeetingId===id)_updateInputPreflight(meetingData[id]);},message=>_showGcEscapeNotice(message,'error'),{
        groupState:_gcPanelState[current.id],
        onCopy:target=>_copyConversationPrompt(current,target),
        onOpen:target=>_openConversationCli(current,target),
      });
      _updateInputHistoryButton(current);
      return;
    }
    if (DevFile.enabled(current)) {
      _renderDevFileControls(row, current);
      _updateInputHistoryButton(current);
      return;
    }
    const raw = _getInputText();
    const charCount = raw.length;
    const chips = [];
    let panelTitle = '发送检查';
    let panelDetail = '准备发送';
    if (_isPanelCapableMeeting(current)) {
      const slots = _getGcSlots(current).filter(Boolean);
      // 2026-07-20 maintainer [修#3b]：目标计数过滤休眠成员（否则"目标 3/3"实际只发 2 家）
      const awakeSlots = slots.filter(slot => {
        const sess = (typeof sessions !== 'undefined' && sessions) ? sessions.get(slot.sid) : null;
        return !(sess && sess.status === 'dormant');
      });
      const dormantSlotsN = slots.length - awakeSlots.length;
      const total = awakeSlots.length || (Array.isArray(current.subSessions) ? current.subSessions.length : 0);
      const selectedSet0 = new Set(Array.isArray(current.participants) ? current.participants : slots.map(slot => slot.slotIndex));
      const selected = awakeSlots.filter(slot => selectedSet0.has(slot.slotIndex)).length || (Array.isArray(current.participants) ? 0 : total);
      const selectedSet = new Set(Array.isArray(current.participants) ? current.participants : awakeSlots.map(slot => slot.slotIndex));
      const selectedNames = slots
        .filter(slot => selectedSet.has(slot.slotIndex))
        .map(slot => slot.displayLabel || slot.label || slot.kind || `AI ${slot.slotIndex + 1}`)
        .slice(0, 3);
      const workflowSteps = current.serialWorkflow && Array.isArray(current.serialWorkflow.steps)
        ? current.serialWorkflow.steps.length
        : 0;
      panelTitle = '作战面板';
      panelDetail = selected === 0
        ? '未选择成员，发送前需要至少勾选 1 位'
        : `发送给 ${selectedNames.join(' / ')}${selected > selectedNames.length ? ` 等 ${selected} 位` : ''}`;
      if (dormantSlotsN > 0) panelDetail += `· ${dormantSlotsN} 位休眠不计入`;
      if (DevDiscuss.isKickingOff(current)) {
        // 开题中：指定的那一位在写任务书。这里**不给**「开工」入口 ——
        // 报告被接收后自动开工，多一个按钮只会让人以为还要再确认一次。
        chips.push(_renderInputChip('阶段', '开题中 · 等任务书交付', 'warn'));
        chips.push(`<span class="mr-input-preflight-chip clickable" data-dev-redispatch="1" title="不重置任务、不重开轮次，只把当前阶段的职责和文档入口再发一次给原执笔者"><span>本轮</span><strong>↻ 重发</strong></span>`);
        panelDetail += ' · 开题阶段，这里发的话会作为补充送给执笔者';
      } else if (DevDiscuss.isDiscussing(current)) {
        // 建好房先自由讨论；聊清楚了点「开题」，指定一位执笔者把需求写成任务书。
        // 需求本来就明确时也不用多聊几轮 —— 直接点「开题」即可。
        chips.push(_renderInputChip('阶段', '讨论中 · 不改代码', 'warn'));
        chips.push(`<span class="mr-input-preflight-chip saved clickable" data-dev-kickoff="1" title="指定一位执笔者把需求写成任务书（目标 / 非目标 / 验收标准 / 风险与回退），写完存进本群任务目录并改名交付。报告完成后自动开工。"><span>开题</span><strong>▶ 指定执笔者</strong></span>`);
        panelDetail += ' · 讨论阶段，发送走普通群聊';
      } else if (current.serialWorkflow && current.serialWorkflow.enabled && workflowSteps > 0) {
        const workflowApi = window.WorkflowTemplates;
        const presetMeta = workflowApi && typeof workflowApi.getTemplateMeta === 'function'
          ? workflowApi.getTemplateMeta(current.serialWorkflow.templateId)
          : null;
        const workflowLabel = presetMeta ? presetMeta.name : '工作流';
        chips.push(_renderInputChip('发送', `${workflowLabel} · ${workflowSteps} 步`, 'accent'));
        panelDetail += ` · ${workflowLabel}串行工作流 ${workflowSteps} 步`;
        // 开发群聊开工后仍可退回讨论：需求在实现中露出坑、或返工用尽要重新收敛时用。
        // 循环运行中不给这个入口，先停再切，避免阶段字段和引擎状态打架。
        const loopStNow = _loopStateByMeeting[current.id]
          || (current.serialWorkflow && current.serialWorkflow.loopState) || null;
        if (current.scene === 'dev' && current.groupChat && !(loopStNow && loopStNow.status === 'running')) {
          chips.push(`<span class="mr-input-preflight-chip clickable" data-dev-discuss="1" title="回到讨论阶段：之后发送走普通群聊、两位不改代码，直到你再次点「开工」"><span>阶段</span><strong>回到讨论</strong></span>`);
        }
      } else {
        chips.push(_renderInputChip('目标', `${selected}/${total || selected || 0}`, selected === 0 ? 'warn' : ''));
      }
    } else {
      const sel = document.getElementById('mr-input-target');
      const targetLabel = sel && sel.selectedOptions && sel.selectedOptions[0]
        ? sel.selectedOptions[0].textContent
        : '全部';
      panelDetail = `发送给 ${targetLabel || '全部'}`;
      chips.push(_renderInputChip('目标', targetLabel || '全部'));
    }
    // 2026-07-20 maintainer [修#10]：空态降噪——引用 0 / 字数 0 不渲染 chip
    if (_gcQuoteChips.length) chips.push(_renderInputChip('引用', `${_gcQuoteChips.length}`, 'accent'));
    if (charCount) chips.push(_renderInputChip('字数', `${charCount}`, charCount > _LONG_INPUT_CHAR_THRESHOLD ? 'warn' : ''));
    if (_inputDraftByMeeting[current.id]) chips.push(_renderInputChip('草稿', '已保存', 'saved'));
    // 2026-07-29 maintainer [群聊运行中可操作]：本轮有 AI 在跑 → 常驻一个明确的「停止本轮」入口。
    //   等价于用户在单 session 终端里按 ESC，只是一次批量下发给本轮所有在跑成员。
    //   输入框/发送按钮**不因此禁用**：运行中追加提问是支持的（后端抢占式结算）。
    const cancellingMembers = (current.subSessions || []).filter(sid => sessions.get(sid)?.nativeRuntime?.cancellation?.status === 'pending');
    if (cancellingMembers.length) {
      chips.push(`<span class="mr-input-preflight-chip stop" data-gc-cancelling="1"><span>本轮</span><strong>${cancellingMembers.length} 位正在停止 · 等待确认</strong></span>`);
    } else if (_isGroupTurnRunning(current)) {
      chips.push(`<span class="mr-input-preflight-chip stop clickable" data-gc-stop-turn="1" title="停止本轮：向所有还在回答的 AI 下发中断（等同你在终端按 ESC）。想直接追问就继续在下面输入，不必先停。"><span>本轮</span><strong>进行中 ⏹ 停止</strong></span>`);
    }
    // 2026-07-20 maintainer [修#8]：循环状态 chip——运行中显示轮次·阶段，点击停止
    const loopSt = _loopStateByMeeting[current.id]
      || (current.serialWorkflow && current.serialWorkflow.loopState)
      || null;
    // 讨论阶段不露「已暂停 · 继续」：它恢复的是旧目标，会绕过「开工」那一步的任务说明确认
    // （2026-09-06 合并位在隔离实例复现）。主进程 loop:resume 同样拦，这里只是不给入口。
    const discussingNow = DevDiscuss.isDiscussing(current);
    if (loopSt && loopSt.status === 'running') {
      chips.push(`<span class="mr-input-preflight-chip warn clickable" data-workflow-stop="1" title="循环工作流运行中（第 ${escapeHtml(String(loopSt.round || 1))} 轮 · ${escapeHtml(loopSt.phase || loopSt.stage || '进行中')}），点击停止"><span>循环</span><strong>R${escapeHtml(String(loopSt.round || 1))}·${escapeHtml(loopSt.phase || loopSt.stage || '进行中')} ⏹</strong></span>`);
    } else if (loopSt && loopSt.status === 'paused' && discussingNow) {
      chips.push(_renderInputChip('闭环', '旧循环已暂停 · 讨论中不可恢复，请「开工」', ''));
    } else if (loopSt && loopSt.status === 'paused') {
      const pauseWhy = _devPauseReasonText(loopSt.error || loopSt.lastError);
      chips.push(`<span class="mr-input-preflight-chip warn clickable" data-loop-resume="1" title="${escapeHtml(pauseWhy)}；点击从持久检查点继续"><span>闭环</span><strong>已暂停 · 继续</strong></span>`);
      // 停在等交付时，「继续」是重新核对现场，「重发」是把当前职责和文档入口再说一遍。
      // 两个都不重置任务、不重开轮次。
      chips.push(`<span class="mr-input-preflight-chip clickable" data-dev-redispatch="1" title="${escapeHtml(pauseWhy)}；重发只补当前阶段的职责和文档入口，不重置任务、不重做已完成的部分"><span>本轮</span><strong>↻ 重发</strong></span>`);
    }
    const serialSt = _workflowStateByMeeting[current.id]
      || (current.serialWorkflow && current.serialWorkflow.serialRunState)
      || null;
    if (serialSt && serialSt.status === 'running') {
      const rawStepIndex = serialSt.currentStepIndex !== null && serialSt.currentStepIndex !== undefined
        ? Number(serialSt.currentStepIndex)
        : Number(serialSt.nextStepIndex);
      const currentStep = Number.isFinite(rawStepIndex) ? rawStepIndex + 1 : 1;
      const totalSteps = Number(serialSt.totalSteps) || workflowSteps || 1;
      chips.push(`<span class="mr-input-preflight-chip warn clickable" data-workflow-stop="1" title="串行工作流正在第 ${currentStep}/${totalSteps} 步，点击停止"><span>串行</span><strong>${currentStep}/${totalSteps} ⏹</strong></span>`);
    } else if (serialSt && serialSt.status === 'paused' && !discussingNow) {
      const reason = serialSt.error && serialSt.error.reason || serialSt.lastError && serialSt.lastError.reason || '步骤失败';
      chips.push(`<span class="mr-input-preflight-chip warn clickable" data-serial-resume="1" title="${escapeHtml(reason)}；点击从持久检查点继续"><span>串行</span><strong>已暂停 · 继续</strong></span>`);
    }
    // 2026-06-28 maintainer：把"第N轮已结束 + 综合共识/互相挑错/生成交接/引用焦点卡"融入作战面板这一行，
    //   省掉聊天区里独占的一行。仅群聊、idle、非历史时 _renderNextActionBar 才返回非空。
    const _gcState = _gcPanelState[current.id] || {};
    const nextActionsHtml = current.groupChat ? _renderNextActionBar(_gcState, current, _gcViewingTurnN[current.id]) : '';
    row.innerHTML = `
      ${current.groupChat ? '' : `<span class="mr-input-battle-label">${escapeHtml(panelTitle)}</span>`}
      <span class="mr-input-battle-detail">${escapeHtml(panelDetail)}</span>
      <span class="mr-input-battle-chips">${chips.join('')}</span>
      ${nextActionsHtml}
    `;

    row.querySelectorAll('[data-workflow-stop]').forEach(stopChip => stopChip.addEventListener('click', () => {
      ipcRenderer.invoke('workflow:stop', { meetingId: current.id });
    }));
    const serialResumeChip = row.querySelector('[data-serial-resume]');
    if (serialResumeChip) serialResumeChip.addEventListener('click', async () => {
      const result = await ipcRenderer.invoke('serial:resume', { meetingId: current.id });
      if (!result || !result.ok) _showGcEscapeNotice(`串行工作流继续失败：${result && result.reason || 'unknown'}`, 'error');
    });
    const loopResumeChip = row.querySelector('[data-loop-resume]');
    if (loopResumeChip) loopResumeChip.addEventListener('click', async () => {
      const result = await ipcRenderer.invoke('loop:resume', { meetingId: current.id });
      if (!result || !result.ok) _showGcEscapeNotice(`循环工作流继续失败：${result && result.reason || 'unknown'}`, 'error');
    });
    const redispatchChip = row.querySelector('[data-dev-redispatch]');
    if (redispatchChip) redispatchChip.addEventListener('click', async () => {
      redispatchChip.classList.add('is-busy');
      let result = null;
      try { result = await ipcRenderer.invoke('dev:redispatch', { meetingId: current.id }); }
      catch (error) { console.error('[dev-redispatch] IPC failed:', error && error.message); }
      redispatchChip.classList.remove('is-busy');
      if (!result || !result.ok) {
        _showGcEscapeNotice('重发失败：' + ((result && result.reason) || '未知') + '（现场保留，没有重复启动任何东西）', 'error');
        return;
      }
      _showGcEscapeNotice('已按当前阶段重发一次；不会重开轮次，也不会重做已完成的部分', 'info');
    });
    const kickoffChip = row.querySelector('[data-dev-kickoff]');
    if (kickoffChip) kickoffChip.addEventListener('click', () => { void _openDevKickoffDialog(meetingData[current.id]); });
    const backToDiscussChip = row.querySelector('[data-dev-discuss]');
    if (backToDiscussChip) backToDiscussChip.addEventListener('click', async () => {
      const m = meetingData[current.id];
      if (!m) return;
      if (_isGroupTurnRunning(m)) { _showGcEscapeNotice('本轮还有成员在回答，等它结束或先停止再切换阶段', 'error'); return; }
      const ok = await _setDevPhase(m, DevDiscuss.PHASE_DISCUSS);
      if (ok) _showGcEscapeNotice('已回到讨论阶段：之后发送走普通群聊，两位不改代码', 'info');
    });
    const stopTurnChip = row.querySelector('[data-gc-stop-turn]');
    if (stopTurnChip) stopTurnChip.addEventListener('click', () => {
      void _handleGcStopTurn(current);
    });
    const expandBtn = document.getElementById('mr-input-expand-btn');
    if (expandBtn) expandBtn.classList.toggle('attention', charCount > _LONG_INPUT_CHAR_THRESHOLD);
    _updateInputHistoryButton(current);
  }

  function _closePromptHistoryMenu() {
    if (_inputHistoryMenuEl) {
      _inputHistoryMenuEl.remove();
      _inputHistoryMenuEl = null;
    }
    document.removeEventListener('mousedown', _handlePromptHistoryOutside);
    document.removeEventListener('keydown', _handlePromptHistoryKeydown);
  }

  function _handlePromptHistoryOutside(ev) {
    const btn = document.querySelector('.mr-composer-history') || document.getElementById('mr-input-history-btn');
    if (_inputHistoryMenuEl && !_inputHistoryMenuEl.contains(ev.target) && ev.target !== btn) {
      _closePromptHistoryMenu();
    }
  }

  function _handlePromptHistoryKeydown(ev) {
    if (ev.key === 'Escape') _closePromptHistoryMenu();
  }

  function _togglePromptHistoryMenu(anchor, meeting) {
    if (_inputHistoryMenuEl) {
      _closePromptHistoryMenu();
      return;
    }
    const items = _getPromptHistory(meeting && meeting.id);
    const rect = anchor.getBoundingClientRect();
    const menu = document.createElement('div');
    menu.id = 'mr-input-history-menu';
    menu.className = 'mr-input-history-menu';
    menu.style.left = `${Math.max(12, Math.min(rect.left, window.innerWidth - 360))}px`;
    menu.style.bottom = `${Math.max(64, window.innerHeight - rect.top + 6)}px`;
    if (!items.length) {
      const empty = document.createElement('div');
      empty.className = 'mr-input-history-empty';
      empty.textContent = '暂无历史输入';
      menu.appendChild(empty);
    } else {
      items.forEach((item, idx) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'mr-input-history-item';
        btn.innerHTML = `<span>${escapeHtml(_compactInputLine(item))}</span><small>${idx + 1}</small>`;
        btn.addEventListener('click', () => {
          _setMeetingInputText(meeting.id, item);
          _closePromptHistoryMenu();
        });
        menu.appendChild(btn);
      });
    }
    document.body.appendChild(menu);
    _inputHistoryMenuEl = menu;
    setTimeout(() => {
      document.addEventListener('mousedown', _handlePromptHistoryOutside);
      document.addEventListener('keydown', _handlePromptHistoryKeydown);
    }, 0);
  }

  // ── 开发群聊 · 讨论 ⇄ 开工 ────────────────────────────────────────────────
  // 由 setupInput 赋值：发送三岔路的实现。「开工」弹窗和「收敛」按钮借它发文本，
  // 保证和用户按回车走的是同一条路（包括循环启动失败时把问题恢复到输入框）。
  let _dispatchMeetingInputImpl = null;

  // 阶段字段住在 serialWorkflow 里（meeting-store 只持久化它整体）。用同步 IPC 写，
  // 写成功再启动循环：否则 loop:start 可能读到旧阶段。
  // 循环停下来的原因翻成人话。MD 交接那几种停法尤其要说清楚「缺的是哪个文件」，
  // 否则维护者看到的只有 handoff_pending 这种词，根本不知道该找谁。
  function _devPauseReasonText(err) {
    if (!err || typeof err !== 'object') return '步骤失败，循环已暂停';
    const doc = err.doc ? `「${err.doc}」` : '本阶段完成文件';
    const who = err.stage === 'reviewer' ? '合并位' : err.stage === 'builder' ? '工作位' : '这一位';
    switch (err.reason) {
      case 'handoff_pending':
        return `还没收到${doc}：${who}可能还在写，也可能是写完了忘了改名`;
      case 'handoff_incomplete':
        return `${doc}收到了，但少了必需字段：${(err.missing || []).join('、') || '未知'}`;
      case 'handoff_changed_after_accept':
        return `${doc}已经接收过，之后又被改动了 —— 停下来等你核对，不覆盖已接收的那一版`;
      case 'handoff_reread_failed':
        return `${doc}这次读不出来（${err.detail || '原因未知'}），保留当前阶段等重读`;
      case 'verdict_conflict':
        return err.detail || '合并手册和群聊里的裁决对不上，停下来等你核对';
      case 'project_root_unverified':
        return `项目现场没核实过（${err.detail || '细节未知'}）—— 先确认要动的是哪个仓库，再让它开工`;
      case 'state_record_damaged':
        return `这个群聊的流程记录被写坏了（${err.detail || '细节未知'}）—— 停下来等你处理，不按目录里最大的阶段号瞎猜`;
      case 'kickoff_dispatch_failed':
        return `开题任务没能送进 CLI（${err.detail || '原因未知'}）—— 它一个字都没收到，点「重发」再来一次`;
      case 'reviewer_unavailable':
        return '审查那一位干不了活（额度/限流/登录），换个人或稍后再来，这不是代码问题';
      default:
        return err.reason || '步骤失败，循环已暂停';
    }
  }

  async function _setDevPhase(meeting, phase) {
    const m = meetingData[meeting.id] || meeting;
    if (!m || !m.serialWorkflow) { _showGcEscapeNotice('这个群还没有开发工作流配置，先点工作流按钮配一下', 'error'); return false; }
    const next = { ...m.serialWorkflow, devPhase: phase === DevDiscuss.PHASE_DISCUSS ? DevDiscuss.PHASE_DISCUSS : DevDiscuss.PHASE_BUILD };
    try {
      const ok = await ipcRenderer.invoke('update-meeting-sync', { meetingId: m.id, fields: { serialWorkflow: next } });
      if (!ok) throw new Error('主进程未接受更新');
    } catch (e) {
      _showGcEscapeNotice('切换阶段失败：' + (e && e.message ? e.message : String(e)), 'error');
      return false;
    }
    m.serialWorkflow = next;
    if (typeof window.schedulePersist === 'function') window.schedulePersist();
    _updateWorkflowBtnState(m);
    setupInput(m);
    _updateInputPreflight(m);
    return true;
  }

  // 「开题」：讨论到此收口，指定一位执笔者把需求写成任务书（写进本群任务目录的
  // 开题报告.md，写完改名成「已完成-开题报告.md」）。只派一个人 —— 两位一起写会写重。
  //
  // 点这一下就已经包含了后续正常开发流程的授权：报告被 Hub 接收后自动开工，
  // 不再有第二个确认弹窗，正常 PASS 也不需要维护者审批。
  async function _openDevKickoffDialog(meeting) {
    const current = meeting || meetingData[activeMeetingId];
    if (!current || !DevDiscuss.isDiscussing(current)) return;
    if (_isGroupTurnRunning(current)) {
      _showGcEscapeNotice('本轮还有成员在回答，等这一轮讨论结束再开题（不要强停 CLI）', 'error');
      return;
    }
    const members = _buildWorkflowMembers(current);
    if (!members.length) { _showGcEscapeNotice('群里还没有可用的成员', 'error'); return; }
    const steps = (current.serialWorkflow && Array.isArray(current.serialWorkflow.steps)) ? current.serialWorkflow.steps : [];
    const defaultAuthor = (steps[0] || [])[0] || members[0].memberId;
    const existing = document.getElementById('mr-dev-kickoff-overlay');
    if (existing) existing.remove();
    const overlay = document.createElement('div');
    overlay.id = 'mr-dev-kickoff-overlay';
    overlay.className = 'mr-input-editor-overlay';
    const roleOf = (memberId) => (DevDiscuss.devRoleOf(current.serialWorkflow, memberId) === 'merger' ? '合并位' : '工作位');
    overlay.innerHTML = `
      <div class="mr-input-editor" role="dialog" aria-modal="true" aria-label="开题：指定执笔者">
        <div class="mr-input-editor-head"><strong>开题 · 指定执笔者</strong></div>
        <div class="mr-dev-kickoff-hint">
          只给指定的这一位派开题任务，另一位不写，避免两人写重。<br>
          他会把需求写成一份自包含的任务书（目标 / 非目标 / 验收标准 / 风险与回退），
          存进本群的任务目录并改名交付。<strong>报告完成后自动开工</strong>，不需要你再确认一次。
        </div>
        <div class="mcm-workspace-choices" role="radiogroup" aria-label="开题执笔者">
          ${members.map(member => `
            <button type="button" class="mcm-workspace-choice${member.memberId === defaultAuthor ? ' selected' : ''}"
              data-kickoff-author="${escapeHtml(member.memberId)}" role="radio"
              aria-checked="${member.memberId === defaultAuthor ? 'true' : 'false'}">
              <strong>${escapeHtml(member.title)}</strong><small>${escapeHtml(roleOf(member.memberId))}${member.memberId === defaultAuthor ? ' · 默认执笔' : ''}</small>
            </button>`).join('')}
        </div>
        <div class="mr-input-editor-actions">
          <button type="button" class="mr-input-editor-btn" data-action="cancel">取消</button>
          <button type="button" class="mr-input-editor-btn send" data-action="kickoff">开题 ▶</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    let author = defaultAuthor;
    const close = () => { overlay.remove(); document.removeEventListener('keydown', onKeydown); };
    const onKeydown = (ev) => { if (ev.key === 'Escape') close(); };
    overlay.querySelectorAll('[data-kickoff-author]').forEach((button) => {
      button.addEventListener('click', () => {
        author = button.getAttribute('data-kickoff-author');
        overlay.querySelectorAll('[data-kickoff-author]').forEach((other) => {
          const on = other === button;
          other.classList.toggle('selected', on);
          other.setAttribute('aria-checked', on ? 'true' : 'false');
        });
      });
    });
    overlay.querySelector('[data-action="cancel"]').addEventListener('click', close);
    const startBtn = overlay.querySelector('[data-action="kickoff"]');
    startBtn.addEventListener('click', async () => {
      // 双击防护在主进程（引擎的 running map）也有一道；这里只是不让按钮连点。
      startBtn.disabled = true;
      const m = meetingData[current.id];
      if (!m) { close(); return; }
      let result = null;
      try { result = await ipcRenderer.invoke('dev:kickoff', { meetingId: m.id, authorMemberId: author }); }
      catch (error) { console.error('[dev-kickoff] IPC failed:', error && error.message); }
      if (!result || !result.ok) {
        startBtn.disabled = false;
        _showGcEscapeNotice('开题没能开始：' + ((result && result.reason) || '未知'), 'error');
        return;
      }
      close();
      _showGcEscapeNotice('已进入开题：等它写完任务书并交付，Hub 接收后自动开工', 'info');
      const refreshed = meetingData[current.id];
      if (refreshed) _updateInputPreflight(refreshed);
    });
    overlay.addEventListener('mousedown', (ev) => { if (ev.target === overlay) close(); });
    document.addEventListener('keydown', onKeydown);
  }

  function _openLongInputEditor(meeting) {
    const current = meeting || meetingData[activeMeetingId];
    if (!current) return;
    const existing = document.getElementById('mr-input-editor-overlay');
    if (existing) existing.remove();
    const overlay = document.createElement('div');
    overlay.id = 'mr-input-editor-overlay';
    overlay.className = 'mr-input-editor-overlay';
    overlay.innerHTML = `
      <div class="mr-input-editor" role="dialog" aria-modal="true" aria-label="展开编辑">
        <div class="mr-input-editor-head">
          <strong>展开编辑</strong>
          <span id="mr-input-editor-count">0 字</span>
        </div>
        <textarea id="mr-input-editor-textarea" class="mr-input-editor-textarea" spellcheck="false"></textarea>
        <div class="mr-input-editor-actions">
          <button type="button" class="mr-input-editor-btn" data-action="cancel">取消</button>
          <button type="button" class="mr-input-editor-btn primary" data-action="apply">应用</button>
          <button type="button" class="mr-input-editor-btn send" data-action="send">发送</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    const textarea = overlay.querySelector('#mr-input-editor-textarea');
    const countEl = overlay.querySelector('#mr-input-editor-count');
    const updateCount = () => {
      if (countEl) countEl.textContent = `${textarea.value.length} 字`;
    };
    const applyText = () => {
      _setMeetingInputText(current.id, textarea.value);
      _updateInputPreflight(current);
    };
    const close = () => {
      overlay.remove();
      document.removeEventListener('keydown', onKeydown);
    };
    const onKeydown = (ev) => {
      if (ev.key === 'Escape') close();
    };
    textarea.value = _getInputText();
    updateCount();
    textarea.addEventListener('input', updateCount);
    overlay.querySelectorAll('[data-action]').forEach(btn => {
      btn.addEventListener('click', () => {
        const action = btn.getAttribute('data-action');
        if (action === 'cancel') {
          close();
          return;
        }
        applyText();
        close();
        if (action === 'send') {
          const sendBtn = document.getElementById('mr-send-btn');
          if (sendBtn) sendBtn.click();
        }
      });
    });
    overlay.addEventListener('mousedown', (ev) => {
      if (ev.target === overlay) close();
    });
    document.addEventListener('keydown', onKeydown);
    setTimeout(() => textarea.focus(), 0);
  }

  // 2026-05-05 maintainer：用户提问 banner 的"进行中轮"缓存。
  //   handleMeetingSend 入口写入 → turn-complete 清空 → state.turns[N].userInput 接管。
  //   这样从用户点发送 → server 推 turn-complete 之间(数秒到数分钟),banner 就能立即显示
  //   "你刚发的提问 + 进行中"标签,不必等本轮 settle 才出现。
  const _currentTurnUserInputByMeeting = {};
  const _gcPendingUserMessageByMeeting = {};
  function _pendingUserMessages(meetingId) {
    const pending = _gcPendingUserMessageByMeeting[meetingId];
    return Array.isArray(pending) ? pending : [];
  }
  // 「还没有面板缓存」时用的最小可渲染状态：空历史 + idle。
  //   刻意**不写进 _gcPanelState** —— 那份缓存是服务端快照的归属地，塞一个空壳进去，
  //   _syncGroupChatCacheFromServer 的 stale 分支（!accepted && prev）就会把这个空壳
  //   当成"上一份快照"返回，真历史反而回不来。这里只是画一帧，不是建缓存。
  function _pendingOnlyPanelState() {
    return { messages: [], turns: [], summarySegments: [], attempts: {}, currentTurn: 0, currentMode: 'idle' };
  }

  // 首次打开房间（或历史查询还在飞）时，把用户刚发的那条 pending 提问就地画出来。
  // 这里绝对不能等 refreshGroupChatPanel：它要先 await `groupchat:get-state`。
  // 实测把历史拖到 2.5 秒，用户按下发送、输入框已经清空，气泡要 2.1 秒才出现
  // （见 tests/e2e-groupchat-first-send-card-cdp.js）。
  function _paintPendingUserMessageWithoutHistory(meeting) {
    if (!meeting || meeting.id !== activeMeetingId || !_isPanelCapableMeeting(meeting)) return false;
    // 有缓存就该走正常路径，这条兜底只负责"一份缓存都没有"的那一帧。
    if (_gcPanelState[meeting.id]) return false;
    try {
      return _renderGcPanelInto(_ensureGcPanel(), meeting, _pendingOnlyPanelState(), {
        scroll: { scrollTop: 0, stickToBottom: true },
        restoreOpts: { forceBottom: true },
        forceMeetingBottom: true,
      });
    } catch (error) {
      console.warn('[meeting-room] 本地 pending 气泡渲染失败:', error && error.message);
      return false;
    }
  }

  function _rememberPendingUserMessage(meeting, text) {
    const content = String(text || '').trim();
    if (!meeting || !meeting.id || !content) return null;
    const state = _gcPanelState[meeting.id] || {};
    const turns = Array.isArray(state.turns) ? state.turns : [];
    const latestSettledTurn = turns.reduce((max, turn) => Math.max(max, Number(turn && turn.n) || 0), 0);
    const pendingMessages = _pendingUserMessages(meeting.id).slice();
    const previousPending = pendingMessages[pendingMessages.length - 1];
    const pendingBaseTurn = previousPending ? previousPending.afterTurn + 1 : 0;
    const afterTurn = Math.max(Number(state.currentTurn) || 0, latestSettledTurn, pendingBaseTurn);
    _currentTurnUserInputByMeeting[meeting.id] = content;
    const pending = {
      content,
      afterTurn,
      createdAt: Date.now(),
      clientId: String(Date.now()) + '-' + Math.random().toString(36).slice(2, 8),
    };
    pendingMessages.push(pending);
    _gcPendingUserMessageByMeeting[meeting.id] = pendingMessages;
    if (meeting.id === activeMeetingId) {
      const painted = _renderActivePanelFromCache(meetingData[meeting.id] || meeting, {
        forceGroupChatBottom: true,
        forceMeetingBottom: true,
      });
      // 缓存态还没建起来（首次打开房间、刚从休眠唤醒、历史查询还在飞）时上面这条
      // 直接 return false。此时先本地画一帧，让用户立刻看见自己那条；真历史随后
      // 由 refreshGroupChatPanel 整体接管——那一步是异步的，不能挡在出卡前面。
      if (!painted) {
        _paintPendingUserMessageWithoutHistory(meetingData[meeting.id] || meeting);
        Promise.resolve(refreshGroupChatPanel(meetingData[meeting.id] || meeting, {
          forceGroupChatBottom: true,
          forceMeetingBottom: true,
        })).catch(error => console.warn('[meeting-room] pending user bubble refresh failed:', error && error.message));
      }
    }
    return pending;
  }
  function _discardPendingUserMessage(meetingId, opts = {}) {
    let remaining = _pendingUserMessages(meetingId);
    if (opts.clientId) {
      remaining = remaining.filter(pending => pending.clientId !== opts.clientId);
    } else if (Number.isInteger(Number(opts.throughTurn)) && Number(opts.throughTurn) > 0) {
      const throughTurn = Number(opts.throughTurn);
      remaining = remaining.filter(pending => pending.afterTurn + 1 > throughTurn);
    } else {
      remaining = [];
    }
    if (remaining.length > 0) {
      _gcPendingUserMessageByMeeting[meetingId] = remaining;
      _currentTurnUserInputByMeeting[meetingId] = remaining[remaining.length - 1].content;
    } else {
      delete _currentTurnUserInputByMeeting[meetingId];
      delete _gcPendingUserMessageByMeeting[meetingId];
    }
  }
  function _restoreQuestionAndPreserveDraft(meetingId, text) {
    const restoredText = String(text || '').trim();
    if (!restoredText) return { restored: false, mergedWithDraft: false };
    const inp = meetingId === activeMeetingId ? document.getElementById('mr-input-box') : null;
    const liveDraft = inp ? String(inp.innerText || '').trim() : '';
    const storedDraft = String(_inputDraftByMeeting[meetingId] || '').trim();
    const existingDraft = liveDraft || storedDraft;
    const mergedWithDraft = !!existingDraft && !existingDraft.includes(restoredText);
    const merged = mergedWithDraft ? `${restoredText}\n\n${existingDraft}` : (existingDraft || restoredText);
    _setInputDraft(meetingId, merged);
    if (inp) {
      _renderComposerRaw(inp, merged);
      _placeCaretAtEnd(inp);
    }
    return { restored: true, mergedWithDraft };
  }
  function _saveInputDraft() {
    if (!activeMeetingId) return;
    const inp = document.getElementById('mr-input-box');
    if (!inp) return;
    const text = inp.innerText || '';
    _setInputDraft(activeMeetingId, text);
    _updateInputPreflight(meetingData[activeMeetingId]);
  }
  function _restoreInputDraft(meetingId) {
    const inp = document.getElementById('mr-input-box');
    if (!inp) return;
    _restoreDraftIntoInput(meetingId, inp);
    _updateInputPreflight(meetingData[meetingId]);
  }

  function init() {
    // no-op — kept for backward compat; refs resolved lazily
  }

  function openMeeting(meetingId, meeting, opts = {}) {
    if (activeMeetingId !== meetingId) {
      document.getElementById('mr-group-chat-panel')?._groupSelection?.hide();
      if (_gcQuoteFloatBtn) _gcQuoteFloatBtn.style.display = 'none';
      _closePromptHistoryMenu();
      document.querySelector('#mr-input-editor-overlay [data-action="apply"]')?.click();
      _inputModelUi?.closeModelPicker();
      _taskFilesMeetingId = null;
    }
    // 切换前先保存上一个 meeting 的草稿（如果有）；切换到同一个 meeting 不存。
    if (activeMeetingId && activeMeetingId !== meetingId) _saveInputDraft();
    activeMeetingId = meetingId;
    meetingData[meetingId] = meeting;
    // [投委会浮窗绑定 session] 告知 committee-ui 现在看的是哪个 meeting → 只显示属于本 session 的浮窗、隐藏别的。
    try { if (window.committeeUI && window.committeeUI.syncActiveMeeting) window.committeeUI.syncActiveMeeting(meetingId); } catch {}

    // 2026-06-21 maintainer：mr-card-tab-mode 是「非群聊会议」的并列/Tab 全局态，会误伤群聊
    //   卡片视图（CSS 隐藏非 active 卡 + 头部 + 逃生栏 + 提问横幅）且群聊内无切回入口，
    //   造成跨会议污染。进群聊时清除该 body class；进非群聊会议时按 localStorage 恢复。
    if (meeting && meeting.groupChat) {
      document.body.classList.remove('mr-card-tab-mode');
    } else {
      _applyCardViewModeClass(_getCardViewMode());
    }

    const panel = panelEl();
    panel.style.display = 'flex';

    if (meeting.groupChat) ensureMemberSplit().open(meeting);
    else memberSplit?.close();
    renderHeader(meeting);
    renderTerminals(meeting);
    renderToolbar(meeting);
    setupInput(meeting);
    // setupInput 在 _inputBound=true 时直接 return,不会更新 textContent。
    // 这里兜底恢复草稿:无论 setupInput 内是首次绑定路径还是 bypass 路径,都保证
    // 切换 meeting 后 inputBox 显示当前 meeting 的草稿。
    _restoreInputDraft(meetingId);
    // IF-C1：开启 CLI ready 轮询，驱动卡片"创建中→待命"切换。
    // IF-C6（多方审查 medium 修复）：拿首次 poll 的 promise，等它返回后再 refresh panel
    //   避免首屏闪烁——一次 IPC < 100ms，对用户感知近乎瞬间。
    const firstPoll = startCliReadyPoll();

    // 两模式(通用/投研)进入会议室即刷新持久化面板
    // 先做一次同步渲染（保持响应不阻塞），await 首次 poll 后再 refresh 一次（修首屏闪烁）
    if (_isPanelCapableMeeting(meeting)) {
      refreshGroupChatPanel(meeting, {
        forceMeetingBottom: opts.forceScrollBottom === true,
      });
      // 异步等首次 poll 后再 refresh 一次（poll 内部已会重渲，这里只是兜底，不阻塞 UI）
      if (firstPoll && typeof firstPoll.then === 'function') {
        firstPoll.then(() => {
          if (activeMeetingId === meetingId) {
            try { _refreshSoftAlert(meeting); } catch {}
          }
        }).catch(() => {});
      }
    } else {
      _removeGcPanel();
    }

    // IF-C3（2026-05-01）：进会议室立即刷一次软提醒 banner（AI 未 ready 时提示用户）
    try { _refreshSoftAlert(meeting); } catch {}

    // Card optimization Task 10（2026-05-01）：开启 ResizeObserver 防溢出兜底（Task 10 提供）
    if (typeof _setupMeetingResizeObserver === 'function') _setupMeetingResizeObserver();

    // IF-C2（2026-05-01）：auto-focus 输入框 — defer 到本轮渲染稳定后再 focus，
    //   让用户进会议室立即可键盘输入。
    setTimeout(() => {
      const inputBox = document.getElementById('mr-input-box');
      if (inputBox && document.activeElement !== inputBox) {
        inputBox.focus();
      }
    }, 50);
  }

  function closeMeetingPanel() {
    document.getElementById('mr-group-chat-panel')?._groupSelection?.hide();
    if (_gcQuoteFloatBtn) _gcQuoteFloatBtn.style.display = 'none';
    _closePromptHistoryMenu();
    document.querySelector('#mr-input-editor-overlay [data-action="apply"]')?.click();
    memberSplit?.close();
    _inputModelUi?.closeModelPicker();
    _taskFilesMeetingId = null;
    // 离开 AI 群聊前先保存草稿，下次重新进入时恢复。
    _saveInputDraft();
    activeMeetingId = null;
    _inputBound = false;
    // [投委会浮窗绑定 session] 离开群聊 → 通知 committee-ui 隐藏浮窗（进度仍在后台累积，重进即恢复）。
    try { if (window.committeeUI && window.committeeUI.syncActiveMeeting) window.committeeUI.syncActiveMeeting(null); } catch {}
    // IF-C1：关闭轮询并清空 ready cache，下次 openMeeting 重新检测
    stopCliReadyPoll();
    _cliReadyCache = {};
    // IF-C3：清空 banner dismiss 状态 + 隐藏 banner，下次进同会议再显示一次
    _bannerDismissedFor = null;
    _lastNotReadyCount = 0;
    const _banner = document.getElementById('mr-input-soft-alert');
    if (_banner) { _banner.style.display = 'none'; _banner.innerHTML = ''; }
    // Card optimization Task 10（2026-05-01）：拆 ResizeObserver / window resize 监听，避免 panel 隐藏后还触发 fit
    if (typeof _teardownMeetingResizeObserver === 'function') _teardownMeetingResizeObserver();
    // F6 Phase 3: 切 meeting 清引用 chips, 避免跨 meeting 误带
    if (typeof _clearQuoteChips === 'function') _clearQuoteChips();
    if (_gcQuoteFloatBtn) _gcQuoteFloatBtn.style.display = 'none';
    const panel = panelEl();
    if (panel) { panel.querySelector('.mr-gc-messages')?._cardFollowController?.dispose(); panel.querySelector('#mr-group-chat-panel')?._questionDirectory?.dispose(); panel.style.display = 'none'; }
    const el = terminalsEl();
    if (el) { el.querySelector('.mr-gc-messages')?._cardFollowController?.dispose(); el.querySelector('#mr-group-chat-panel')?._questionDirectory?.dispose(); el.innerHTML = ''; }
  }

  // Card optimization Task 10（2026-05-01）— 动态重排兜底：
  //   触发场景：窗口 resize / 沉浸切换 / 历史面板展开 / preview markdown 长度跳变 /
  //             session 加减 / devtools 开关
  //   策略：ResizeObserver 监 #meeting-room-panel 尺寸 + window 'resize' →
  //         debounce 100ms → 强制 reflow + 刷新历史面板高度。
  //   2026-06-18：AI 群聊内嵌 xterm 已下线，移除旧 fit 兼容路径。
  function _debounce(fn, wait) {
    let t = null;
    return function (...args) {
      if (t) clearTimeout(t);
      t = setTimeout(() => fn.apply(this, args), wait);
    };
  }

  let _meetingResizeObserver = null;
  let _windowResizeHandler = null;
  let _lastLayoutW = 0;
  let _lastLayoutH = 0;

  function _relayoutMeetingRoom() {
    const panel = document.getElementById('meeting-room-panel');
    if (!panel || panel.style.display === 'none') return;

    // 强制 reflow（避免延迟到下次 paint）
    void panel.offsetHeight;

    // history panel 高度（如展开）— 当前 DOM 暂未引入 #mr-history-panel，保留兜底以防未来加入
    const hp = document.getElementById('mr-history-panel');
    if (hp && hp.classList.contains('expanded')) {
      hp.style.maxHeight = `${hp.scrollHeight}px`;
    }
  }

  function _setupMeetingResizeObserver() {
    if (_meetingResizeObserver) return;
    const panel = document.getElementById('meeting-room-panel');
    if (!panel) return;

    const debouncedRelayout = _debounce((entries) => {
      const e = entries && entries[0];
      if (!e) { _relayoutMeetingRoom(); return; }
      const { width, height } = e.contentRect;
      // 抖动过滤：宽高变化 <4px 视为噪声（典型滚动条出现/消失边缘）
      if (Math.abs(width - _lastLayoutW) < 4 && Math.abs(height - _lastLayoutH) < 4) return;
      _lastLayoutW = width;
      _lastLayoutH = height;
      _relayoutMeetingRoom();
    }, 100);

    _meetingResizeObserver = new ResizeObserver(debouncedRelayout);
    _meetingResizeObserver.observe(panel);

    // window resize（cover devtools 开关、窗口拖拽尺寸）
    _windowResizeHandler = _debounce(() => _relayoutMeetingRoom(), 100);
    window.addEventListener('resize', _windowResizeHandler);
  }

  function _teardownMeetingResizeObserver() {
    if (_meetingResizeObserver) {
      try { _meetingResizeObserver.disconnect(); } catch (_) {}
      _meetingResizeObserver = null;
    }
    if (_windowResizeHandler) {
      try { window.removeEventListener('resize', _windowResizeHandler); } catch (_) {}
      _windowResizeHandler = null;
    }
    _lastLayoutW = 0; _lastLayoutH = 0;
  }

  function getActiveMeetingId() {
    return activeMeetingId;
  }

  function getMeetingData(meetingId) {
    return meetingData[meetingId] || null;
  }

  // Context/model status arrives independently from meeting state. Update only
  // the active member row so a CLI status tick cannot leave the room at Ctx --
  // until some unrelated group-chat event happens to trigger a full render.
  function refreshSessionMetrics(sessionId) {
    const meeting = activeMeetingId ? meetingData[activeMeetingId] : null;
    _updateInputTuning(meeting);
    if (!meeting || !Array.isArray(meeting.subSessions)) return false;
    const slot = _getGcSlots(meeting).find(item => item && item.sid === sessionId);
    if (!slot) return false;
    const avatar = document.querySelector(`.mr-free-avatar-chk[data-slot-idx="${slot.slotIndex}"]`);
    const dormant = sessions.get(sessionId)?.status === 'dormant';
    if (avatar && (avatar.classList.contains('disabled') !== dormant || avatar.querySelector('input')?.disabled !== dormant)) {
      renderToolbar(meeting);
      _updateInputPreflight(meeting);
    }
    memberSplit?.refresh(meeting);
    const panel = document.getElementById('mr-group-chat-panel');
    if (!panel) return false;

    const session = (typeof sessions !== 'undefined' && sessions) ? sessions.get(sessionId) : null;
    const model = session && session.currentModel
      ? (typeof modelShort === 'function' ? modelShort(session.currentModel) : session.currentModel.displayName || session.currentModel.id || '')
      : '';
    const compact = model;
    const memberLabel = `@${_memberIdForSlot(slot)}${compact ? ` · ${compact}` : ''}`;
    let changed = false;

    const rows = panel.querySelectorAll(`[data-gc-member-idx="${slot.slotIndex}"]`);
    rows.forEach((row) => {
      const meta = row.querySelector('.mr-gc-member-meta, .mr-card-roster-meta');
      if (meta) {
        meta.textContent = memberLabel;
        changed = true;
      }
    });
    return changed;
  }

  function refreshNativeCancellation(sessionId) {
    const meeting = activeMeetingId && meetingData[activeMeetingId];
    if (!meeting?.subSessions?.includes(sessionId)) return;
    _renderActivePanelFromCache(meeting);
    _updateInputPreflight(meeting);
  }

  let _updating = false;
  function updateMeetingData(meetingId, updated) {
    if (_updating) return;
    _updating = true;
    try {
      const prev = meetingData[meetingId];
      meetingData[meetingId] = updated;
      if (activeMeetingId === meetingId) {
        renderHeader(updated);
        renderToolbar(updated);
        // 模式切换时同步刷新面板与终端容器可见性（E2E 修复）
        if (_isPanelCapableMeeting(updated)) {
          refreshGroupChatPanel(updated);
        } else {
          _removeGcPanel();
        }
        const prevSubs = prev ? prev.subSessions.join(',') : '';
        const newSubs = updated.subSessions ? updated.subSessions.join(',') : '';
        const modeChanged = prev && (prev.scene !== updated.scene);
        // T7 fix（2026-05-04）：free 模式下 participants 变化（尤其 0 人→非0）需重刷 setupInput
        // 以同步 sendBtn.disabled 和 inputBox placeholder/readonly 状态。
        const prevParts = prev && Array.isArray(prev.participants) ? prev.participants.join(',') : 'null';
        const newParts = Array.isArray(updated.participants) ? updated.participants.join(',') : 'null';
        const participantsChanged = prevParts !== newParts;
        const modeModeChanged = prev && (prev.mode !== updated.mode);
        if (prevSubs !== newSubs || modeChanged || participantsChanged || modeModeChanged) {
          renderTerminals(updated);
        }
        // Workflow/config updates can arrive independently of member changes.
        // setupInput refreshes controls before its binding guard, preserving drafts.
        setupInput(updated);
      }
    } catch (e) {
      console.error('[meeting-room] updateMeetingData error:', e);
      // 注：故意不清 _inputBound，保留上次绑定避免 setupInput 重渲后 listener 丢失
    } finally {
      _updating = false;
    }
  }

  // --- Header ---

  function renderHeader(meeting) {
    const el = headerEl();
    if (!el) return;
    const showLayoutButtons = !_isPanelCapableMeeting(meeting);
    const layoutButtonsHtml = showLayoutButtons ? `
        <button class="mr-header-btn ${meeting.layout === 'focus' ? 'active' : ''}" id="mr-btn-focus">Focus</button>` : '';

    // Arch refactor 2026-05-02: 沉浸/调试切换按钮已删除。AI 群聊界面只有一种
    // 视图（永远纯卡片），shell 沉到子 session 主区。
    // Group overview and member transcripts share the same group composer and
    // running sessions. This layout selection is local to the current window.
    const viewToggleHtml = meeting.groupChat ? `<div class="session-layout-buttons" role="group" aria-label="群聊布局">
        <button type="button" class="session-layout-button" data-group-layout="overview" title="群聊总览" aria-label="群聊总览" aria-pressed="${memberSplit?.mode() !== 'two'}"><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><rect x="2" y="3" width="16" height="14" rx="2"/><path d="M5 7h10M5 10h7M5 13h10"/></svg></button>
        <button type="button" class="session-layout-button" data-group-layout="two" title="成员双屏" aria-label="成员双屏" aria-pressed="${memberSplit?.mode() === 'two'}"><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><rect x="2" y="3" width="16" height="14" rx="2"/><path d="M10 3v14"/></svg></button>
      </div>` : `
        <div class="mr-view-toggle" role="group" aria-label="Card view mode">
          <button class="mr-header-btn mr-view-btn ${!_isCardTabMode() ? 'active' : ''}" id="mr-btn-view-parallel" title="并列显示 3 张 AI 卡片">并列</button>
          <button class="mr-header-btn mr-view-btn ${_isCardTabMode() ? 'active' : ''}" id="mr-btn-view-tab" title="Tab 模式：主界面只显示当前 AI 卡片">Tab</button>
        </div>`;

    // 2026-06-28 maintainer：群成员按钮从群聊 topbar 移到 header（放在 聊天/卡片 切换的左边）。
    // header 不在群聊委托容器内，故下方单独绑定点击事件（不能依赖 data-gc-side-toggle 委托）。
    const gcMembersBtnHtml = meeting.groupChat ? (() => {
      const gcSlots = _getGcSlots(meeting).filter(Boolean);
      const collapsed = _getGroupSideCollapsed();
      return `<button class="mr-header-btn mr-view-btn ${collapsed ? '' : 'active'}" id="mr-btn-group-members" title="${collapsed ? '展开群成员栏' : '收起群成员栏'}">群成员 ${gcSlots.length}</button>`;
    })() : '';
    const gcMessageScopeHtml = OrchUI.enabled(meeting)
      ? `<button type="button" class="mr-header-btn${OrchUI.onlyOrchestrator(meeting) ? ' active' : ''}" id="mr-btn-message-scope" aria-pressed="${OrchUI.onlyOrchestrator(meeting)}" title="${OrchUI.onlyOrchestrator(meeting) ? '当前只显示你和编排员的消息，点击查看全员信息' : '点击只看你和编排员的消息'}">${OrchUI.onlyOrchestrator(meeting) ? '只看编排' : '全员信息'}</button>` : '';

    el.innerHTML = `
      <div class="mr-header-left">
        <span class="mr-header-title" id="mr-title">${escapeHtml(meeting.title)}</span>${OrchUI.headerTag(meeting)}
        <span class="mr-header-meta" id="mr-header-meta"></span>
        ${meeting.workspace ? `<button type="button" class="mr-workspace-chip" id="mr-workspace-chip" title="在文件管理中打开 · ${escapeHtml(meeting.workspace)}"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M1.8 4.4A1.4 1.4 0 0 1 3.2 3h3l1.3 1.4h5.3a1.4 1.4 0 0 1 1.4 1.4v6a1.4 1.4 0 0 1-1.4 1.4H3.2a1.4 1.4 0 0 1-1.4-1.4Z"/></svg><span>${meeting.workspaceLabel ? `${escapeHtml(meeting.workspaceLabel)} · ` : ''}${escapeHtml(meeting.workspace)}</span></button>` : ''}
      </div>
      <!-- 2026-06-28 maintainer：删 header 进度条（与标题旁 meta 的"已N轮·本轮N/M"文字信息重叠），保留 meta。_updateHeaderProgress 的 progEl 分支会因元素缺失自动跳过。 -->
      <div class="mr-header-right">
        ${layoutButtonsHtml ? `<div class="mr-header-primary-actions">${layoutButtonsHtml}</div>` : ''}
        <div class="mr-header-primary-actions">${gcMembersBtnHtml}${gcMessageScopeHtml}${meeting.groupChat ? `<button type="button" class="mr-header-btn${_gcToolsExpanded[meeting.id] ? ' active' : ''}" id="mr-btn-group-tools" aria-expanded="${!!_gcToolsExpanded[meeting.id]}" aria-controls="mr-gc-tools" title="展开或收起搜索与本轮进度">群聊工具</button>` : ''}${viewToggleHtml}</div>
        <div class="mr-header-secondary-actions" aria-label="会议工具">
          <button class="mr-header-btn" id="mr-btn-add-sub" title="${meeting.groupChat ? '添加新的 AI 成员' : '添加子会话'}">${meeting.groupChat ? '+ 成员' : '+ 添加'}</button>
          ${meeting.workspace ? `<button class="btn-zoom btn-file-manager-toggle" id="mr-btn-files" title="打开当前工作目录的文件管理" aria-label="打开当前工作目录的文件管理" aria-pressed="false"><svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M1.8 4.4A1.4 1.4 0 0 1 3.2 3h3l1.3 1.4h5.3a1.4 1.4 0 0 1 1.4 1.4v6a1.4 1.4 0 0 1-1.4 1.4H3.2a1.4 1.4 0 0 1-1.4-1.4Z"/><path d="M5 7.2h6M5 9.5h4"/></svg></button>` : ''}
          <button class="btn-zoom" id="mr-btn-zoom-out" title="Shrink UI">A−</button>
          <button class="btn-zoom" id="mr-btn-zoom-in" title="Enlarge UI">A+</button>
          <button class="btn-close-session" id="mr-btn-close" title="关闭会议室" aria-label="Close meeting"><svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" fill="none"/></svg></button>
        </div>
      </div>
    `;

    el.querySelectorAll('[data-group-layout]').forEach(button => button.addEventListener('click', () => setGroupLayout(button.dataset.groupLayout, meetingData[meeting.id] || meeting)));
    memberSplit?.refresh(meeting);
    const focusBtn = document.getElementById('mr-btn-focus');
    const workspaceChip = document.getElementById('mr-workspace-chip');
    if (workspaceChip) {
      // 归档提示挂在这个 chip 上，而不是自动弹全局模态（2026-07-29 用户要求）：
      // 有待归档建议时 chip 显示一个轻标记，点击才打开归档框；没有建议时
      // 直接在 Hub 文件管理中打开工作目录。用户不点就不打扰。
      // 2026-07-29 P1-2：同一套交互独立会话 header 也要有，已抽到
      // WorkspaceController.attachArchiveHint，两处共用，杜绝「只改一边」。
      const wc = window.WorkspaceController;
      const openWorkspace = () => {
        if (typeof window.openPathInHub === 'function') {
          void window.openPathInHub(meeting.workspace, { cwd: meeting.workspace, requireExistsForRel: false });
        }
      };
      const attached = !!(wc && typeof wc.attachArchiveHint === 'function'
        && wc.attachArchiveHint(workspaceChip, 'meeting', meeting.id, {
          hintTitle: '这个任务还在临时区 · 点击归档到正式项目目录',
          idleTitle: `在文件管理中打开 · ${meeting.workspace}`,
          onFallback: openWorkspace,
        }));
      if (!attached) workspaceChip.addEventListener('click', openWorkspace);
    }
    if (focusBtn) focusBtn.addEventListener('click', () => setLayout(meeting.id, 'focus'));
    const parallelBtn = document.getElementById('mr-btn-view-parallel');
    const tabBtn = document.getElementById('mr-btn-view-tab');
    if (parallelBtn) parallelBtn.addEventListener('click', () => {
      _setCardViewMode('parallel', meeting);
      renderHeader(meeting);
    });
    if (tabBtn) tabBtn.addEventListener('click', () => {
      _setCardViewMode('tab', meeting);
      renderHeader(meeting);
    });
    // 2026-06-28 maintainer：header 群成员按钮 → toggle 右侧群成员栏（替代原 topbar 里的 data-gc-side-toggle）。
    const groupMembersBtn = document.getElementById('mr-btn-group-members');
    document.getElementById('mr-btn-message-scope')?.addEventListener('click', () => {
      OrchUI.toggleMessageScope(meeting);
      if (memberSplit?.mode() === 'two') setGroupLayout('overview', meeting);
      const panel = _ensureGcPanel();
      const scroll = _captureGroupChatScroll(panel, meeting);
      const state = _gcPanelState[meeting.id];
      if (state) _renderGcPanelInto(panel, meeting, state, { scroll });
      renderHeader(meeting);
    });
    const groupToolsBtn = document.getElementById('mr-btn-group-tools');
    if (groupToolsBtn) groupToolsBtn.addEventListener('click', () => {
      if (memberSplit?.mode() === 'two') setGroupLayout('overview', meeting);
      const open = !_gcToolsExpanded[meeting.id];
      _gcToolsExpanded[meeting.id] = open;
      const tools = document.getElementById('mr-gc-tools');
      if (tools) {
        tools.hidden = !open;
        const search = tools.querySelector('.mr-gc-search');
        if (open) search?.focus();
        else if (search?.value) {
          search.value = '';
          search.dispatchEvent(new Event('input', { bubbles: true }));
        }
      }
      groupToolsBtn.setAttribute('aria-expanded', String(open));
      groupToolsBtn.classList.toggle('active', open);
    });
    if (groupMembersBtn) groupMembersBtn.addEventListener('click', () => {
      if (memberSplit?.mode() === 'two') setGroupLayout('overview', meeting);
      _setGroupSideCollapsed(!_getGroupSideCollapsed(), meeting);
      renderHeader(meeting);
    });
    document.getElementById('mr-btn-add-sub').addEventListener('click', () => showAddSubMenu(meeting.id));
    const filesBtn = document.getElementById('mr-btn-files');
    if (filesBtn && window.FileManagerPanel) {
      filesBtn.dataset.root = meeting.workspace || '';
      filesBtn.classList.toggle('active', window.FileManagerPanel.isOpenFor(meeting.workspace));
      filesBtn.setAttribute('aria-pressed', String(window.FileManagerPanel.isOpenFor(meeting.workspace)));
      filesBtn.addEventListener('click', () => {
        _taskFilesMeetingId = null;
        void window.FileManagerPanel.toggle({ cwd: meeting.workspace, label: meeting.workspaceLabel });
      });
      if (window.FileManagerPanel.isOpen() && _taskFilesMeetingId !== meeting.id) {
        void window.FileManagerPanel.syncContext({ cwd: meeting.workspace, label: meeting.workspaceLabel });
      }
    }
    // 注：顶部 scene toggle（群聊/投研）已删除（2026-05-04 决策：scene 创建时确定，运行时不可切换）。
    // Arch refactor 2026-05-02: 沉浸/调试 toggle 删除，无需 binding。
    document.getElementById('mr-btn-zoom-out').addEventListener('click', () => { if (typeof applyZoom === 'function') applyZoom(currentZoom - 1); });
    document.getElementById('mr-btn-zoom-in').addEventListener('click', () => { if (typeof applyZoom === 'function') applyZoom(currentZoom + 1); });
    document.getElementById('mr-btn-close').addEventListener('click', async () => {
      const result = await ipcRenderer.invoke('close-meeting', meeting.id);
      if (result !== true) {
        alert(result?.message || '删除会议室失败，请稍后重试。');
        return;
      }
      closeMeetingPanel();
    });

    const titleSpan = document.getElementById('mr-title');
    titleSpan.addEventListener('dblclick', () => {
      const input = document.createElement('input');
      input.type = 'text';
      input.value = meeting.title;
      input.className = 'mr-header-title';
      input.style.cssText = 'border:1px solid var(--accent);border-radius:4px;padding:2px 6px;background:var(--bg-primary);color:var(--text-primary);font-size:14px;font-weight:600;outline:none;';
      titleSpan.replaceWith(input);
      input.focus();
      input.select();
      const finish = () => {
        const trimmed = input.value.trim();
        if (trimmed && trimmed !== meeting.title) {
          meeting.title = trimmed;
          ipcRenderer.send('update-meeting', { meetingId: meeting.id, fields: { title: trimmed } });
        }
        const newSpan = document.createElement('span');
        newSpan.className = 'mr-header-title';
        newSpan.id = 'mr-title';
        newSpan.textContent = meeting.title;
        input.replaceWith(newSpan);
      };
      input.addEventListener('blur', finish);
      input.addEventListener('keydown', (e) => {
        if (e.isComposing || e.keyCode === 229) return;
        if (e.key === 'Enter') input.blur();
        if (e.key === 'Escape') { input.value = meeting.title; input.blur(); }
      });
    });
  }

  // --- Add Sub-Session Menu ---

  function showAddSubMenu(meetingId, anchorEl = null) {
    const meeting = meetingData[meetingId];
    // 3 人上限只对非群聊的多标签会议生效；群聊不限人数（实际基本停在 3 人，但那是用户的选择）。
    if (!meeting || (!meeting.groupChat && meeting.subSessions.length >= 3)) return;

    const btn = anchorEl || document.getElementById('mr-btn-add-sub');
    if (!btn) return;
    const rect = btn.getBoundingClientRect();

    const old = document.getElementById('mr-add-sub-menu');
    if (old) old.remove();

    const menu = document.createElement('div');
    menu.id = 'mr-add-sub-menu';
    menu.className = 'mr-quote-menu';
    menu.style.top = rect.bottom + 4 + 'px';
    menu.style.left = rect.left + 'px';

    // 群聊入口只提供 Claude / Codex / DeepSeek 三种 runtime（主力矩阵）。
    // 但不去重、不封顶：同一种 AI 可以加多个（两个 Claude 跑不同模型/角色是有效用法）。
    // 历史会议里的 Gemini/Kimi 等成员继续可读可运行，只是不再从群聊入口新增。
    const _CLI_SUFFIX = { claude: 'Claude Code', gemini: 'Gemini CLI', codex: 'Codex CLI', deepseek: 'DeepSeek · Codex', kimi: 'Kimi Code' };
    const availableKinds = meeting.groupChat
      ? ['claude', 'codex', 'deepseek', 'qwen', 'deepseek-acp', 'glm']
      : ALL_AI_KINDS;
    const kinds = availableKinds.map(k => ({
      kind: k,
      label: _CLI_SUFFIX[k] || getKindLabel(k),
    }));
    if (!meeting.groupChat) kinds.push({ kind: 'powershell', label: 'PowerShell' });

    for (const { kind, label } of kinds) {
      const item = document.createElement('button');
      item.className = 'mr-quote-menu-item';
      item.textContent = label;
      item.dataset.addKind = kind;
      item.addEventListener('click', async () => {
        menu.remove();
        try {
          _showGcEscapeNotice('正在添加成员…');
          await window.WorkspaceController.loadSessionDefaults();
          const opts = window.WorkspaceController.buildSessionTuningOpts(kind);
          const result = await ipcRenderer.invoke('add-meeting-sub', { meetingId, kind, opts });
          if (!result || !result.meeting) throw new Error('新成员会话创建失败');
          if (result.session && typeof sessions !== 'undefined' && sessions) {
            sessions.set(result.session.id, result.session);
          }
          meetingData[meetingId] = result.meeting;
          if (activeMeetingId !== meetingId) return;
          renderHeader(result.meeting);
          renderTerminals(result.meeting);
          renderToolbar(result.meeting);
          setupInput(result.meeting);
          await refreshGroupChatPanel(result.meeting);
        } catch (err) {
          console.error('[groupchat] add member failed:', err);
          _showGcEscapeNotice('添加成员失败：' + (err && err.message ? err.message : String(err)), 'error');
        }
      });
      menu.appendChild(item);
    }

    // 从已有会话分支一个成员进来（2026-09-17）。分支而不是搬进来：MCP 是启动时注入的，
    // 跑起来的会话改不了；分支既继承了原会话的上下文，又是一个由本群聊配置出来的新进程。
    if (meeting.groupChat) {
      const existing = document.createElement('button');
      existing.className = 'mr-quote-menu-item';
      existing.type = 'button';
      existing.textContent = '从已有会话分支…';
      existing.style.borderTop = '1px solid var(--border, var(--border-mid))';
      existing.addEventListener('click', async () => {
        menu.remove();
        await _groupChatForkUi().addExistingSessionToMeeting(meetingId, async (result) => {
          if (result.session && typeof sessions !== 'undefined' && sessions) {
            sessions.set(result.session.id, result.session);
          }
          meetingData[meetingId] = result.meeting;
          renderHeader(result.meeting);
          renderToolbar(result.meeting);
          setupInput(result.meeting);
          await refreshGroupChatPanel(result.meeting);
        });
      });
      menu.appendChild(existing);
    }

    document.body.appendChild(menu);
    const dismiss = (e) => {
      if (!menu.contains(e.target)) {
        menu.remove();
        document.removeEventListener('mousedown', dismiss);
      }
    };
    setTimeout(() => document.addEventListener('mousedown', dismiss), 0);
  }

  let _gcForkUi = null;
  function _groupChatForkUi() {
    if (!_gcForkUi) {
      _gcForkUi = require('./groupchat-fork-ui.js').createGroupChatForkUi({
        document,
        ipcRenderer,
        // 失败必须看得见：群聊横幅不在时（弹窗独立于房间渲染）退回到对话框，
        // 不能让一条错误消息掉进地板。
        notify: (message, level) => {
          const shown = _showGcEscapeNotice(message, level || 'info');
          if (!shown && level === 'error') require('./ui-feedback').showHubAlert(message, { document });
        },
        getMeetings: () => meetingData,
        selectMeeting: null,
      });
    }
    return _gcForkUi;
  }

  // Arch refactor 2026-05-02: AI 群聊界面去 shell。子 session shell 只在主区挂载
  // （renderer.js: showTerminal）。保留 renderTerminals 兼容旧调用点，body 为 no-op。
  function renderTerminals(_meeting) { /* removed: shell moved to sub-session view */ }

  function startCliReadyPoll() {
    if (_cliReadyPollTimer) return;
    const pollOnceImpl = async () => {
      if (!activeMeetingId) return;
      // 2026-05-05 maintainer：activeMeetingId 快照 + race guard。
      //   原版在 await invoke 后用全局 activeMeetingId 拿 cached、用 T0 闭包的 meeting 写 panel —
      //   用户在 await 期间切到 B 时，cached=cachedB + meeting=meetingA 混渲（标题来自 A 但 stepper/
      //   turns 来自 B）。同样可能让 panel 在用户感知"未操作"瞬间显示错群聊内容。
      const startActiveMeetingId = activeMeetingId;
      const meeting = meetingData[startActiveMeetingId];
      if (!meeting || !Array.isArray(meeting.subSessions)) return;
      let changed = false;
      let needRefresh = false;
      for (const sid of meeting.subSessions) {
        if (_cliReadyCache[sid]) continue; // 已 ready 不重查（CLI exit 时由 'session-closed' 清缓存触发重查）
        try {
          const ready = await ipcRenderer.invoke('cli-ready-status', sid);
          if (ready) {
            _cliReadyCache[sid] = true;
            changed = true;
            needRefresh = true;
          }
        } catch {}
      }
      // race guard：await 期间 activeMeetingId 已变（用户切走/会议关闭）→ 不写 panel
      if (activeMeetingId !== startActiveMeetingId) return;
      if (needRefresh && _isPanelCapableMeeting(meeting)) {
        // 触发 panel 重渲染让 isInitializing 立即生效（卡片切到"待命"）
        const cached = _gcPanelState[startActiveMeetingId];
        if (cached) {
          const panel = _ensureGcPanel();
          // 群聊弹顶 bug 修复（2026-06-05 maintainer）：CLI ready poll 每秒触发,
          //   首次 AI 思考期间从"创建中→待命"切换时会重渲,过去无 capture/restore → 弹顶。
          const groupScroll = _captureGroupChatScroll(panel, meeting);
          _renderGcPanelInto(panel, meeting, cached, { scroll: groupScroll });
        }
      }
      // 软提醒 banner（IF-C3 实装后会调），保护性调用——不存在时静默
      if (changed && typeof _refreshSoftAlert === 'function') {
        try { _refreshSoftAlert(meeting); } catch {}
      }
    };
    const pollOnce = () => {
      if (_cliReadyPollInFlight) return _cliReadyPollInFlight;
      const task = pollOnceImpl();
      _cliReadyPollInFlight = task.finally(() => {
        if (_cliReadyPollInFlight === task || _cliReadyPollInFlight === tracked) {
          _cliReadyPollInFlight = null;
        }
      });
      const tracked = _cliReadyPollInFlight;
      return tracked;
    };
    // IF-C6（首屏闪烁修复 2026-05-01）：返回首次 pollOnce 的 promise，让 openMeeting 可以
    //   await 它再继续后续渲染（一次 IPC < 100ms，远低于人眼可感知的 200ms 阈值）。
    //   避免 panel 首次渲染时 _cliReadyCache 还空 → 全部判 isInitializing → 闪一下"创建中"。
    // IF-C7（2026-05-03）：首次 pollOnce 后强制刷一次 banner。原 _refreshSoftAlert 仅在
    //   pollOnce 检测 changed=true 时被调，全员未 ready 时 cache 始终空 → 不变更 → banner
    //   一次都不显示，输入框上方静默——本 fix 让首屏立刻反映"XX 启动中"提示。
    const firstPollPromise = pollOnce().then(() => {
      try { _refreshSoftAlert(meeting); } catch {}
    });
    _cliReadyPollTimer = setInterval(pollOnce, 1000);
    return firstPollPromise;
  }

  function stopCliReadyPoll() {
    if (_cliReadyPollTimer) { clearInterval(_cliReadyPollTimer); _cliReadyPollTimer = null; }
    _cliReadyPollInFlight = null;
  }

  // IF-C3（2026-05-01）：软提醒 banner — 进会议室时若 AI 还在启动，显示哪几家未 ready
  //   提示用户"等几秒再发送"，避免输入早于 CLI ready 而被吞。
  //   一旦全部 ready 自动消失。用户点 × dismiss 后同会议不再显示（_bannerDismissedFor 记录），
  //   关闭会议 → 重置，下次进同会议又显示。
  //
  // 2026-05-03 maintainer精测 Bug #1+#2 修复（关键 P0 用户铁律）：banner 用「DOM + cache
  //   取并集」的悲观策略 — 任一数据源说某家未 ready，banner 就提示该家启动中。
  //   原 filter(meeting.subSessions, sid => !_cliReadyCache[sid]) 有两个问题：
  //   #1: 装配中途 meeting.subSessions 还不完整 → notReady 数字偏小（如 2/3 而非 3/3）
  //   #2: _cliReadyCache 比卡片 DOM 早更新 1s → banner 早消失，用户以为 ready 实际还没
  //   并集策略保证：DOM 卡片仍"创建中" 或 cache 未 ready，任一为真即在 banner 内提示，
  //   彻底杜绝"卡片创建中但 banner 消失"的误导（用户铁律 P0 禁忌）。
  // Phase 4 v2(2026-05-05 maintainer): _refreshSoftAlert 改造为更新 onboarding head 的动态状态。
  //   旧策略: 在底部 mr-input-soft-alert banner 显示启动中文字 + dismiss × 按钮。
  //   新策略(用户决策): banner DOM 已删, head 文字上移到欢迎区。AI 启动中(notReady>0) 显示黄色
  //     "X / Y / Z 启动中, 建议等到状态变'待命'再发送"; 全员 ready 显示绿色 "N 个 AI 已就绪"。
  //   notReady 算法不变(DOM "创建中"+ cliReadyCache 并集 + slotSpecs 装配中补齐)。
  //   dismiss 语义删除(欢迎区 head 是动态的, ready 后自然变绿无需用户关闭)。
  //
  // 函数名保持 _refreshSoftAlert 兼容现有调用点(避免大面积改 ipc handler), 实际行为变了。
  function _refreshSoftAlert(meeting) {
    const head = document.getElementById('mr-gc-ob-head');
    if (!head || !meeting || !Array.isArray(meeting.subSessions)) return;

    const labelOf = sid => {
      const sess = (typeof sessions !== 'undefined' && sessions) ? sessions.get(sid) : null;
      const kind = sess && sess.kind;
      return KIND_LABELS[kind] || (sess && sess.title) || sid.slice(0, 6);
    };
    // 数据源 A：DOM 卡片状态文字含"创建中"的 sid（跟用户所见同源）
    const domNotReadySids = new Set();
    document.querySelectorAll('.mr-ft').forEach(card => {
      const status = (card.querySelector('.mr-ft-status')?.textContent || '').trim();
      if (status && status.includes('创建中')) {
        const sid = card.querySelector('[data-gc-sid]')?.dataset?.gcSid;
        if (sid) domNotReadySids.add(sid);
      }
    });
    // 数据源 B：cli-ready cache 未 ready 的 sid（覆盖 panel 还没渲染时的首屏）
    const cacheNotReadySids = new Set(meeting.subSessions.filter(sid => !_cliReadyCache[sid]));
    // 并集（悲观策略）：任一源说未 ready → 提示
    const unionSids = new Set([...domNotReadySids, ...cacheNotReadySids]);
    const notReady = meeting.subSessions.filter(sid => unionSids.has(sid)).map(labelOf);
    // 装配中途补齐(slotSpecs.length > subSessions.length 时, 差额按 slotSpecs[i].kind 算未 ready)
    if (Array.isArray(meeting.slotSpecs) && meeting.slotSpecs.length > meeting.subSessions.length) {
      for (let i = meeting.subSessions.length; i < meeting.slotSpecs.length; i++) {
        const spec = meeting.slotSpecs[i];
        notReady.push(KIND_LABELS[spec?.kind] || 'AI');
      }
    }

    // notReady>0 → 黄色启动中; notReady===0 → 绿色全员 ready
    if (notReady.length > 0) {
      head.classList.remove('ready');
      head.classList.add('loading');
      head.innerHTML = `
        <span class="mr-gc-ob-head-icon">⏳</span>
        <span><strong>${notReady.join(' / ')}</strong> 启动中, 建议等到状态变 <strong>"待命"</strong> 再发送(避免输入丢失)</span>
      `;
    } else {
      head.classList.remove('loading');
      head.classList.add('ready');
      const defaultText = head.getAttribute('data-default-text') || 'AI 群聊已就位';
      const defaultSub = head.getAttribute('data-default-sub') || '等你抛话题';
      head.innerHTML = `
        <span class="mr-gc-ob-head-icon">✓</span>
        <span><strong>${escapeHtml(defaultText)}</strong> · ${escapeHtml(defaultSub)}</span>
      `;
    }
  }

  function switchFocusTab(_meeting, _newSid) { /* removed: embedded xterm tabs no longer exist */ }

  // --- Layout Toggle ---

  function setLayout(meetingId, layout) {
    const meeting = meetingData[meetingId];
    if (!meeting) return;
    meeting.layout = layout;
    if (layout === 'focus' && !meeting.focusedSub) {
      meeting.focusedSub = meeting.subSessions[0] || null;
    }
    ipcRenderer.send('update-meeting', { meetingId, fields: { layout, focusedSub: meeting.focusedSub } });
    renderHeader(meeting);
    renderTerminals(meeting);
  }

  // pilot-mode Task 3（2026-05-01）：主驾按钮事件绑定 + 卡片视觉切换。
  //   按钮点击展开 dropdown；选 slot 0/1/2 → 调 IPC 开主驾；选 -1 关主驾。
  //   IPC 返回后由 'meeting-updated' 事件触发 renderToolbar 重渲（按钮 active + 卡片 dim）。
  // pilot redesign v4（2026-05-02）：卡片只保留"角色层"红框，删除 dispatch 视觉特效。
  //   设计准则：副驾发言时主驾卡片保持原状，主驾发言时副驾同理。卡片自然反映真实 PTY
  //            状态（thinking/done/idle）即可——dispatch 视觉特效是"多此一举"，反而
  //            会和真实 PTY 状态打架（出现"灰化但又部分动"的怪异中间态）。
  //   dispatchMode 仍保留参数：仅用于输入框 placeholder 的文本提示。
  // --- Toolbar ---

  function renderToolbar(meeting) {
    const el = toolbarEl();
    if (!el) return;
    if (!_isPanelCapableMeeting(meeting)) {
      el.innerHTML = '';
      return;
    }

    const slotsArr = _getGcSlots(meeting);
    const cached = _gcPanelState[meeting.id];
    const inProgress = cached && cached.currentMode && cached.currentMode !== 'idle';
    const isGroupChat = !!meeting.groupChat;
    const participantIndexes = isGroupChat
      ? slotsArr.map((s, idx) => s ? idx : null).filter(idx => idx !== null)
      : [0, 1, 2];

    const slotDisplayLabel = (idx) => {
      const slot = slotsArr[idx];
      if (!slot) return `AI ${idx + 1}`;
      return slot.displayLabel || slot.label || slot.kind || `AI ${idx + 1}`;
    };
    const slotAvatarSrc = (idx) => {
      const slot = slotsArr[idx] || {};
      // *-resume 复用基础 kind 的 svg；此处的 <img> 无 onerror 兜底，404 会直接破图
      return _groupLogoSrc(slot.kind);
    };

    el.innerHTML = '';
    const avatarsRow = document.getElementById('mr-free-avatars-row');
    if (avatarsRow) {
      const participants = Array.isArray(meeting.participants) ? meeting.participants : participantIndexes;
      const partSet = new Set(participants);
      avatarsRow.innerHTML = participantIndexes.map(idx => {
        const checked = partSet.has(idx);
        // 2026-07-20 maintainer [修#3a]：休眠成员灰显禁勾（后端 dispatcher 本就跳过 dormant，勾上只会"永远等它"）
        // 2026-07-29 maintainer [群聊运行中可操作]：**运行中不再禁勾**。此前 `inProgress` 也进
        //   disabled，只要有一位 AI 在思考，整排成员头像就全灰、用户什么都改不了——这正是
        //   用户反馈的"UI 都是灰的"。勾选只影响**下一轮**的派发目标（后端在 dispatch 那一刻
        //   才读 meeting.participants），改它对正在跑的这轮零副作用，没有任何禁用的理由。
        const slot0 = slotsArr[idx] || {};
        const sess0 = (typeof sessions !== 'undefined' && sessions && slot0.sid) ? sessions.get(slot0.sid) : null;
        const isDormant0 = !!(sess0 && sess0.status === 'dormant');
        const disabledAttr = isDormant0 ? 'disabled' : '';
        const label = slotDisplayLabel(idx);
        const runningHint = (inProgress && !isDormant0) ? '（正在执行，也可接收补充；勾选决定下一条消息发给谁）' : '（勾选决定下一条消息发给谁）';
        return `
          <label class="mr-free-avatar-chk ${isGroupChat ? 'group' : ''} ${checked ? 'checked' : ''} ${disabledAttr}${isDormant0 ? ' dormant' : ''}"
                 role="checkbox" tabindex="${isDormant0?'-1':'0'}" aria-label="发送给 ${escapeHtml(label)}" aria-checked="${checked}" aria-disabled="${isDormant0}"
                 data-slot-idx="${idx}" title="${escapeHtml(label)}${isDormant0 ? '（休眠中，先在侧栏唤醒）' : runningHint}">
            <input type="checkbox" class="mr-free-slot-cb" data-slot-idx="${idx}" ${checked ? 'checked' : ''} ${disabledAttr} />
            <img src="${slotAvatarSrc(idx)}" alt="${escapeHtml(label)}" />
            <span class="mr-free-avatar-chk-mark">OK</span>
          </label>
        `;
      }).join('');
    }

    let updating = false;
    document.querySelectorAll('.mr-free-avatar-chk[data-slot-idx]').forEach(label => {
      label.addEventListener('keydown',ev=>{
        if(ev.key===' ' || ev.key==='Enter'){ev.preventDefault();label.click();}
      });
      label.addEventListener('click', async (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        if (label.classList.contains('disabled') || updating) return;
        updating = true;
        const slotIdx = parseInt(label.getAttribute('data-slot-idx'), 10);
        const restoreFocus=document.activeElement===label;
        const latestMeeting = meetingData[meeting.id] || meeting;
        const allIndexes = Array.isArray(latestMeeting.subSessions)
          ? latestMeeting.subSessions.map((_sid, index) => index)
          : [];
        const current = Array.isArray(latestMeeting.participants) ? [...latestMeeting.participants] : allIndexes;
        const wasChecked = current.includes(slotIdx);
        const next = wasChecked ? current.filter(x => x !== slotIdx) : [...current, slotIdx];
        next.sort((a, b) => a - b);
        try {
          const updated = await _setMeetingParticipants(latestMeeting, next);
          renderToolbar(updated);
          if(restoreFocus)document.querySelector(`.mr-free-avatar-chk[data-slot-idx="${slotIdx}"]`)?.focus();
          _updateInputPreflight(updated);
        } catch (err) {
          console.error('[set-participants] failed:', err);
          _showGcEscapeNotice('成员选择保存失败：' + (err && err.message ? err.message : String(err)), 'error');
        } finally {
          updating = false;
        }
      });
    });
  }

  // --- Input & Broadcasting ---

  let _inputBound = false;
  let _gcMentionActiveIndex = 0;

  // meeting-create-modal（2026-05-01）：mention 列表按当前 meeting 动态构建，
  // Mention list supports core AI kinds, repeated kinds, and precise @m1/@m2/@m3 slot mentions.
  //   当 meeting 内某个 kind 唯一出现时，额外注册 @<kind> 别名（向后兼容老 prompt）；
  //   重复 kind 时该 kind 的 @<kind> 别名不注册（避免歧义）。
  function buildGcMentionItems(meeting) {
    const items = [];
    const subSids = (meeting && Array.isArray(meeting.subSessions)) ? meeting.subSessions : [];
    const isGroupChat = !!(meeting && meeting.groupChat);
    const sidKind = {};
    const kindCount = {};
    for (const sid of subSids) {
      const s = (typeof sessions !== 'undefined' && sessions) ? sessions.get(sid) : null;
      if (s && s.kind) {
        sidKind[sid] = s.kind;
        kindCount[s.kind] = (kindCount[s.kind] || 0) + 1;
      }
    }
    // slot mentions（主项）
    for (let i = 0; i < subSids.length; i++) {
      const sid = subSids[i];
      const k = sidKind[sid] || null;
      const kindLabel = k ? (_KIND_LABELS[k] || k) : '';
      const session = (typeof sessions !== 'undefined' && sessions) ? sessions.get(sid) : null;
      const title = session ? (session.title || kindLabel || `AI ${i + 1}`) : (kindLabel || `AI ${i + 1}`);
      const spec = Array.isArray(meeting.slotSpecs) ? (meeting.slotSpecs[i] || {}) : {};
      const memberId = spec.memberId || `m${i + 1}`;
      items.push({
        value: isGroupChat ? `@${memberId}` : `@slot${i + 1}`,
        label: isGroupChat ? `${memberId} · ${title}` : `Slot ${i + 1}${kindLabel ? ' · ' + kindLabel : ''}`,
        hint: isGroupChat ? 'group target' : 'private ask',
        sid,
        kind: k,
        slotIndex: i,
      });
    }
    // kind alias（仅 kind 唯一时注册，避免歧义）
    for (const sid of subSids) {
      const k = sidKind[sid];
      if (k && kindCount[k] === 1) {
        items.push({
          value: `@${k}`,
          label: _KIND_LABELS[k] || k,
          hint: 'private ask · 别名',
          sid, kind: k,
        });
      }
    }
    if (isGroupChat) {
      items.unshift({ value: '@all', label: '@all · 全体成员', hint: 'group target' });
    } else {
    }
    return items;
  }

  function _getGcMentionMenu() {
    let menu = document.getElementById('mr-gc-mention-menu');
    if (!menu) {
      menu = document.createElement('div');
      menu.id = 'mr-gc-mention-menu';
      menu.className = 'mr-gc-mention-menu';
      menu.setAttribute('role', 'listbox');
      menu.style.display = 'none';
      const row = document.getElementById('mr-input-row');
      if (row) row.appendChild(menu);
    }
    return menu;
  }

  function _hideGcMentionMenu() {
    const menu = document.getElementById('mr-gc-mention-menu');
    if (menu) {
      menu.style.display = 'none';
      menu.innerHTML = '';
    }
    _gcMentionActiveIndex = 0;
  }

  function _getTextCaretOffset(el) {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return el.innerText.length;
    const range = sel.getRangeAt(0);
    if (!el.contains(range.endContainer)) return el.innerText.length;
    const pre = range.cloneRange();
    pre.selectNodeContents(el);
    pre.setEnd(range.endContainer, range.endOffset);
    return pre.toString().length;
  }

  function _placeCaretAtTextOffset(el, offset) {
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null);
    let node;
    let remaining = offset;
    while ((node = walker.nextNode())) {
      if (remaining <= node.nodeValue.length) {
        const range = document.createRange();
        range.setStart(node, remaining);
        range.collapse(true);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
        return;
      }
      remaining -= node.nodeValue.length;
    }
    _placeCaretAtEnd(el);
  }

  function _getGcMentionMatch(inputBox) {
    const text = inputBox.innerText || '';
    const caret = _getTextCaretOffset(inputBox);
    const beforeCaret = text.slice(0, caret);
    const at = beforeCaret.lastIndexOf('@');
    if (at < 0) return null;
    const query = beforeCaret.slice(at + 1);
    if (/\s/.test(query)) return null;
    return { text, caret, start: at, query: query.toLowerCase() };
  }

  function _insertGcMention(inputBox, item, meeting) {
    const match = _getGcMentionMatch(inputBox);
    if (!match) return;
    const suffix = match.text.slice(match.caret);
    const spacer = suffix.startsWith(' ') || suffix.length === 0 ? '' : ' ';
    const inserted = `${item.value} `;
    if (inputBox.id === 'mr-input-box') _renderComposerRaw(inputBox, match.text.slice(0, match.start) + inserted + spacer + suffix);
    else inputBox.textContent = match.text.slice(0, match.start) + inserted + spacer + suffix;
    inputBox.focus();
    _placeCaretAtTextOffset(inputBox, match.start + inserted.length);
    _hideGcMentionMenu();
    if (meeting && meeting.groupChat) return;
    // meeting-create-modal：slot mentions 优先按 sid focus（精确指向 slot）；
    //   kind alias 走老 _focusGroupChatKind（kind 唯一时才注册此别名，确定不歧义）。
    if (item.sid) _focusGroupChatSession(meeting, item.sid);
    else if (item.kind) _focusGroupChatKind(meeting, item.kind);
  }

  function _updateGcMentionMenu(inputBox, meeting) {
    if (!_isPanelCapableMeeting(meeting)) {
      _hideGcMentionMenu();
      return;
    }
    const match = _getGcMentionMatch(inputBox);
    if (!match) {
      _hideGcMentionMenu();
      return;
    }
    const items = buildGcMentionItems(meeting).filter(item => {
      const haystack = `${item.value} ${item.label}`.toLowerCase().replace(/^@/, '');
      return haystack.includes(match.query);
    });
    if (items.length === 0) {
      _hideGcMentionMenu();
      return;
    }
    if (_gcMentionActiveIndex >= items.length) _gcMentionActiveIndex = 0;
    const menu = _getGcMentionMenu();
    menu.style.left = `${inputBox.offsetLeft}px`;
    menu.style.minWidth = `${Math.min(Math.max(inputBox.offsetWidth, 260), 420)}px`;
    menu.innerHTML = items.map((item, index) => `
      <button type="button" class="mr-gc-mention-item${index === _gcMentionActiveIndex ? ' active' : ''}" data-mention-index="${index}" role="option" aria-selected="${index === _gcMentionActiveIndex ? 'true' : 'false'}">
        <span class="mr-gc-mention-label">${escapeHtml(item.label)}</span>
        <span class="mr-gc-mention-value">${escapeHtml(item.value)}</span>
        <span class="mr-gc-mention-hint">${escapeHtml(item.hint)}</span>
      </button>
    `).join('');
    menu.style.display = 'block';
    menu.querySelectorAll('.mr-gc-mention-item').forEach(btn => {
      btn.addEventListener('mousedown', (e) => {
        e.preventDefault();
        const index = Number(btn.getAttribute('data-mention-index'));
        _insertGcMention(inputBox, items[index], meeting);
      });
    });
  }

  function _focusGroupChatSession(meeting, sid) {
    if (!meeting || !sid || !Array.isArray(meeting.subSessions) || !meeting.subSessions.includes(sid)) return false;
    const focused = meeting.focusedSub || meeting.subSessions[0];
    if (sid === focused) return true;
    _tabState[sid] = 'idle';
    if (_tabTimers[sid]) { clearTimeout(_tabTimers[sid]); delete _tabTimers[sid]; }
    meeting.focusedSub = sid;
    ipcRenderer.send('update-meeting', { meetingId: meeting.id, fields: { focusedSub: sid } });
    switchFocusTab(meeting, sid);
    refreshGroupChatPanel(meeting);
    renderHeader(meeting);
    return true;
  }

  // An explicit card click can acknowledge its completed answer; opening the
  // room, mentioning a member, or inspecting a historical round cannot.
  function _readVisibleMemberCard(meeting, sid) {
    if (_gcViewingTurnN[meeting.id] || !document.hasFocus() || document.hidden) return;
    const card = document.querySelector(`.mr-ft[data-ft-sid="${CSS.escape(sid)}"]`);
    if (!card || !card.getClientRects().length || !card.querySelector('.mr-ft-status.completed, .mr-ft-status.manual_extracted')) return;
    window.markMeetingMemberRead?.(meeting.id, sid);
  }

  function _focusGroupChatKind(meeting, kind) {
    const sid = findSessionByKind(meeting, kind);
    if (!sid) return false;
    return _focusGroupChatSession(meeting, sid);
  }

  function _handleGcMentionKeydown(e, inputBox, meeting) {
    const menu = document.getElementById('mr-gc-mention-menu');
    const isOpen = menu && menu.style.display !== 'none';
    if (!isOpen) return false;
    const items = buildGcMentionItems(meeting).filter(item => {
      const match = _getGcMentionMatch(inputBox);
      if (!match) return false;
      const haystack = `${item.value} ${item.label}`.toLowerCase().replace(/^@/, '');
      return haystack.includes(match.query);
    });
    if (items.length === 0) return false;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      _gcMentionActiveIndex = (_gcMentionActiveIndex + 1) % items.length;
      _updateGcMentionMenu(inputBox, meeting);
      return true;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      _gcMentionActiveIndex = (_gcMentionActiveIndex + items.length - 1) % items.length;
      _updateGcMentionMenu(inputBox, meeting);
      return true;
    }
    if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault();
      _insertGcMention(inputBox, items[_gcMentionActiveIndex], meeting);
      return true;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      _hideGcMentionMenu();
      return true;
    }
    return false;
  }

  function setupInput(meeting) {
    const inputBox = document.getElementById('mr-input-box');
    const sendBtn = document.getElementById('mr-send-btn');
    const targetSelect = document.getElementById('mr-input-target');
    if (!inputBox || !sendBtn) return;

    // IF-C2（2026-05-01）：placeholder 每次都更新（meeting 切换时场景可能变）；
    // 但 textContent 擦除只在首次（_inputBound=false）做——避免每次重渲染擦掉
    // 用户已输入但还没发送的内容（P1 体验断裂 bug A）。
    // T7: free 模式 0 人勾选时灰态保护
    // 2026-05-05 maintainer：主驾入口废弃，fallback 'pilot' → 'free'（与 core 一致）。
    const _curMeetingMode = (meeting.mode === 'free' || meeting.mode === 'pilot') ? meeting.mode : 'free';
    const zeroParticipantsSelected = (_curMeetingMode === 'free') &&
      (Array.isArray(meeting.participants) && meeting.participants.length === 0);
    const isFreeZeroSelected = zeroParticipantsSelected && !meeting.groupChat;
    if (meeting.scene) {
      inputBox.dataset.placeholder = isFreeZeroSelected
        ? '请先勾选至少一位发言人'
        : 'AI 群聊：发普通文本启动一轮 / @<slot> 单聊';
    } else {
      inputBox.dataset.placeholder = '输入消息...';
    }
    if (meeting.scene && meeting.groupChat) {
      inputBox.dataset.placeholder = zeroParticipantsSelected
        ? 'AI 群聊：请先点亮至少一位成员头像'
        : 'AI 群聊：发送给点亮头像的成员，执行中也可补充';
    }
    if (DevFile.enabled(meeting)) {
      inputBox.dataset.placeholder = DevFile.isSolo(meeting)
        ? '输入任务；点“独立开工”填入提示词，检查后 Enter 发送。'
        : '输入任务或补充；点“开题”填入提示词，检查后 Enter 发送。暂停后点上方「继续」接续。';
    } else if (DevDiscuss.isDiscussing(meeting)) {
      inputBox.dataset.placeholder = '讨论阶段：先把需求聊清楚（不改代码）；想收口就点上方「收敛」，定了就点「开工」';
    }
    if(Delivery.enabled(meeting))inputBox.dataset.placeholder='输入任务，Hub 按工作流安排各步骤成员推进；运行中可补充要求，暂停后点上方「继续」';
    if(OrchUI.active(meeting))inputBox.dataset.placeholder='发给编排员：说目标、改要求或问进展（@成员 可直接点名）';
    // 灰态：readonly + class 切换
    if (isFreeZeroSelected) {
      inputBox.setAttribute('readonly', '');
      inputBox.classList.add('mr-gc-input-disabled');
      sendBtn.disabled = true;
    } else {
      inputBox.removeAttribute('readonly');
      inputBox.classList.remove('mr-gc-input-disabled');
      sendBtn.disabled = false;
    }

    // 串行工作流按钮状态随 meeting 切换刷新（active 高亮 + 步数角标）
    _updateWorkflowBtnState(meeting);

    // 卡片优化（2026-05-03 maintainer）：粘贴图片支持。绑一次（idempotent guard 在 helper 内）。
    //   helper 由 renderer.js 暴露为 window.attachContenteditablePasteImage（先于 meeting-room.js 加载）。
    if (typeof window.attachContenteditablePasteImage === 'function') {
      // 长文本收成粘贴块：本文件读写输入框的地方已按「原始文本 / 展开原文」收口。
      window.attachContenteditablePasteImage(inputBox, { collapseLongText: true });
    }
    _pasteChips.attachPasteChipBehaviors(inputBox, { document, window });
    _ensureInputPreflightRow();
    _ensureInputTools(meeting);
    _updateInputPreflight(meeting);
    if (targetSelect) {
      if (_isPanelCapableMeeting(meeting)) {
        targetSelect.style.display = 'none';
      } else {
        targetSelect.style.display = '';
        targetSelect.style.opacity = '';
        targetSelect.style.pointerEvents = '';
      }
    }

    if (targetSelect && !_isPanelCapableMeeting(meeting)) {
      targetSelect.innerHTML = '<option value="all">全部</option>';
      for (const sid of meeting.subSessions) {
        const session = sessions ? sessions.get(sid) : null;
        const label = session ? (session.title || session.kind || sid) : sid;
        const opt = document.createElement('option');
        opt.value = sid;
        opt.textContent = label;
        if (meeting.sendTarget === sid) opt.selected = true;
        targetSelect.appendChild(opt);
      }
      targetSelect.value = meeting.sendTarget || 'all';
    }

    if (_inputBound) return;
    _inputBound = true;
    // IF-C2：仅首次绑定时设内容（避免后续重渲染 setupInput 擦掉用户已输入未发送内容）。
    // 2026-05-05 maintainer：从清空改为按 meeting.id 恢复草稿 — 切换不同 AI 群聊时各自独立。
    _restoreDraftIntoInput(meeting.id, inputBox);
    _updateInputPreflight(meeting);

    if (targetSelect) {
      targetSelect.addEventListener('change', (e) => {
        const mid = activeMeetingId;
        const m = meetingData[mid];
        if (m) {
          m.sendTarget = e.target.value;
          ipcRenderer.send('update-meeting', { meetingId: m.id, fields: { sendTarget: m.sendTarget } });
          _updateInputPreflight(m);
        }
      });
    }

    const doSend = () => {
      const box = document.getElementById('mr-input-box');
      // 粘贴块在这里展开成原文：发给 AI 的必须是完整内容。
      const userText = box ? readContenteditablePlainText(box).trim() : '';
      // F6 Phase 3: 既无 text 又无 quote chips → 不发
      if (!userText && _gcQuoteChips.length === 0) return;
      const mid = activeMeetingId;
      const m = meetingData[mid];
      if (!m) return;
      let recipientSids;
      if(m.groupChat){
        try{recipientSids=Recipients.resolveRecipients(m);}
        catch(error){_showGcEscapeNotice(error.message,'error');return;}
      }
      // free-mode（2026-05-04）：0 人勾选时拒绝发送
      // CSS readonly 对 contenteditable 无效，必须 JS 二次防御，防 race 导致按钮意外还原
      if (m.mode === 'free' && !m.groupChat) {
        const parts = Array.isArray(m.participants) ? m.participants : [];
        if (parts.length === 0) {
          require('./ui-feedback').showHubAlert('请先勾选至少一位发言人');
          return;
        }
      }
      // 2026-06-24 maintainer：点发送即放行 —— 不再因「本轮未结束」拦截。后端会抢占式结算
      //   上一轮没答完的 AI（标 superseded），本轮 prompt 立即组装分发；没答完的 AI 也会
      //   收到追加 prompt（现代 CLI 支持回答中接新问题）。原 _isGroupTurnBusy 拦截已移除。
      if (!m.scene) {
        const sel = document.getElementById('mr-input-target');
        if (sel) m.sendTarget = sel.value;
      } else {
        m.sendTarget = 'all';
      }
      // F6 Phase 3: 拼接引用 chips 到 prompt 头部, 让 AI 知道用户基于哪些片段追问
      let finalText = userText;
      if (_gcQuoteChips.length > 0) {
        const quoteSection = '基于以下引用追问:\n' + _gcQuoteChips.map(c =>
          `[💎 第${c.turnN}轮 ${c.slotLabel}: "${c.text}"]`
        ).join('\n');
        finalText = userText
          ? `${quoteSection}\n\n用户问题: ${userText}`
          : `${quoteSection}\n\n(请就以上引用展开评论或继续讨论)`;
      }
      _dispatchMeetingInput(m, finalText, recipientSids);
      _pushPromptHistory(m.id, userText || finalText);
      if (box) box.textContent = '';
      _clearInputDraft(m.id);
      _clearQuoteChips();
      _updateInputPreflight(m);
    };

    // 发送三岔路。抽成独立函数是为了让「开工」弹窗能带着任务说明走完全相同的一条路，
    // 而不是往输入框里塞文本再模拟点击。
    // 开发群聊处于讨论阶段时，循环配置虽然在，也只走普通群聊 —— 这是「先讨论再开工」的全部机制。
    function _dispatchMeetingInput(m, finalText, recipientSids=Recipients.selectedSids(m)) {
      // AI 编排模式：默认只发给编排员；@成员 时直接发给被点名的成员并抄送编排员。
      if (OrchUI.active(m)) {
        const route = OrchUI.resolveRecipients(m, finalText, sid => (typeof sessions !== 'undefined' && sessions.get(sid)?.title) || '');
        if (!route.sids.length) { _restoreQuestionAndPreserveDraft(m.id, finalText); _showGcEscapeNotice('编排员会话不可用，消息未发送', 'error'); return; }
        void OrchUI.noteUserMessage(m, finalText, route.direct);
        handleMeetingSend(finalText, m, { recipientSids: route.sids });
        return;
      }
      // 循环工作流（评审 gate + 自动重来）→ main 进程驱动（崩溃续跑）；串行 → renderer 驱动；否则普通群聊单轮
      if (Delivery.enabled(m) && m.serialWorkflow.enabled) {
        void DeliveryControls.submit(m,finalText,recipientSids).then(result=>{
          if(result.plain)return handleMeetingSend(finalText, m, { recipientSids });
          if(result.supplement)return _presentUserSupplement(m,result);
        }).catch(error=>{
          _restoreQuestionAndPreserveDraft(m.id,finalText);
          _showGcEscapeNotice(error.message,'error');
        });
      } else if (DevFile.enabled(m) || DevDiscuss.isDiscussing(m)) {
        handleMeetingSend(finalText, m, { recipientSids });
      } else if (m.scene && m.serialWorkflow && m.serialWorkflow.enabled !== false && m.serialWorkflow.loop && m.serialWorkflow.loop.enabled &&
          Array.isArray(m.serialWorkflow.steps) && m.serialWorkflow.steps.length) {
        // 循环已经在跑时，这句话的语义是「给当前任务补一句」，不是「开一个新任务」。
        // 以前这里照样调 loop:start，主进程以 already_running 拒绝，消息被退回输入框 ——
        // 用户以为说了，其实一个字都没送出去。现在先问主进程「循环在跑吗」（不信 renderer
        // 缓存），在跑就走插话闭环：落盘 + 当前执行者即时收到 + 待命者记账下次补。
        void _routeLoopInput(m, finalText, recipientSids);
      } else if (m.serialWorkflow && m.serialWorkflow.enabled &&
          Array.isArray(m.serialWorkflow.steps) && m.serialWorkflow.steps.length) {
        void _routeSerialInput(m, finalText, recipientSids);
      } else {
        handleMeetingSend(finalText, m, { recipientSids });
      }
    }

    async function _routeSerialInput(m, finalText, recipientSids) {
      try {
        const status = await ipcRenderer.invoke('loop:status', {meetingId:m.id});
        if (status?.running) await _sendUserSupplement(m, finalText, recipientSids);
        else runSerialWorkflow(m, finalText);
      } catch (error) {
        _restoreQuestionAndPreserveDraft(m.id, finalText);
        _showGcEscapeNotice('无法核对工作流状态，补充内容已恢复到输入框：' + error.message, 'error');
      }
    }

    async function _routeLoopInput(m, finalText, recipientSids) {
      let running = false;
      try {
        const status = await ipcRenderer.invoke('loop:status', { meetingId: m.id });
        running = !!(status && status.running);
      } catch (e) {
        console.warn('[loop] status probe failed, treating as not running:', e && e.message);
      }
      if (running) { await _sendUserSupplement(m, finalText, recipientSids); return; }
      _startLoopWithGoal(m, finalText);
    }

    // 插话：不开新一轮、不抢占当前步骤、不重置返工预算。
    // 主进程返回「谁即时收到了、谁要等下次运行」，这里如实说给用户听 ——
    // 待命者没收到不是失败，但真发不出去必须让用户看见。
    async function _sendUserSupplement(m, finalText, recipientSids) {
      let result = null;
      try {
        result = await ipcRenderer.invoke('groupchat:user-supplement', { meetingId: m.id, text: finalText, recipientSids });
      } catch (e) {
        console.error('[loop] supplement IPC failed:', e && e.message);
      }
      if (!result || !result.ok) {
        const recovery = _restoreQuestionAndPreserveDraft(m.id, finalText);
        const tail = recovery.restored ? '；这句话已恢复到输入框' : '';
        _showGcEscapeNotice('这句话没能送出去：' + ((result && result.reason) || '未知') + tail, 'error');
        return;
      }
      await _presentUserSupplement(m,result);
    }
    async function _presentUserSupplement(m,result) {
      const nowCount = (result.deliveredNow || []).length;
      const queuedCount = (result.queuedSids || []).length;
      const waitCount = (result.pendingSids || []).length;
      const failed = (result.failures || []).length;
      const parts = [];
      if (nowCount) parts.push(`${nowCount} 位已确认收到`);
      if (queuedCount) parts.push(`${queuedCount} 位已排队，当前任务结束后处理`);
      if (waitCount) parts.push(`${waitCount} 位待送达，下次派工时补送`);
      if (failed) parts.push(`${failed} 位发送未确认，请查看成员会话，不会自动重发`);
      const refreshed = meetingData[m.id];
      if (refreshed && refreshed.id === activeMeetingId) {
        await refreshGroupChatPanel(refreshed);
        // Refresh rebuilds the banner node: publish the delivery notice after
        // that render, otherwise the confirmation vanishes in the same tick.
        if (activeMeetingId === m.id) _showGcEscapeNotice('发给 '+(result.toLabels || []).join('、')+'：' + (parts.join('；') || '已保存'), failed ? 'error' : 'info');
      }
    }

    function _startLoopWithGoal(m, finalText) {
      const pendingLoopQuestion = _rememberPendingUserMessage(m, finalText);
      const restoreLoopStartFailure = (reason) => {
        _discardPendingUserMessage(m.id, { clientId: pendingLoopQuestion && pendingLoopQuestion.clientId });
        const recovery = _restoreQuestionAndPreserveDraft(m.id, finalText);
        const recoveryText = recovery.mergedWithDraft
          ? '；失败问题与当前草稿均已保留在输入框'
          : recovery.restored ? '；问题已恢复到输入框' : '';
        _showGcEscapeNotice('循环启动失败：' + (reason || '未知') + recoveryText, 'error');
      };
      // 先把原始目标作为独立用户消息落 timeline，再启动 main 驱动的内部步骤。
      // timeline 写入失败不阻断执行，但会明确记录日志；避免内部 builder prompt 冒充原问题。
      ipcRenderer.invoke('meeting-append-user-turn', { meetingId: m.id, text: finalText })
        .catch((e) => console.warn('[loop] append original goal failed:', e && e.message))
        .then(() => ipcRenderer.invoke('loop:start', { meetingId: m.id, userInput: finalText }))
        .then((r) => {
          if (!r || !r.ok) {
            console.warn('[loop] start failed:', r && r.reason);
            restoreLoopStartFailure((r && r.reason) || '未知');
          }
        }).catch((e) => {
          console.error('[loop] start IPC failed:', e && e.message);
          restoreLoopStartFailure(e && e.message);
        });
    }
    _dispatchMeetingInputImpl = _dispatchMeetingInput;

    sendBtn.addEventListener('click', doSend);

    const workflowSwitch = document.getElementById('mr-workflow-switch');
    if (workflowSwitch) workflowSwitch.addEventListener('click', async () => {
      const m = meetingData[activeMeetingId];
      if (!m?.groupChat || workflowSwitch.disabled) return;
      workflowSwitch.disabled = true;
      try {
        const result = await ipcRenderer.invoke('workflow:set-enabled', {meetingId:m.id, enabled:!m.serialWorkflow?.enabled, expectedRevision:m.serialWorkflow?.settingsRevision || 0});
        if (!result?.ok) throw new Error(result?.reason || '开关未切换');
        m.serialWorkflow = result.config;
        DeliveryControls.clear(m.id); ConversationControls.clear(m.id);
        if (activeMeetingId === m.id) {
          _updateWorkflowBtnState(m); _updateInputPreflight(m);
          _showGcEscapeNotice(result.config.enabled ? '工作流已开启，下一条新输入按保存的顺序执行' : '工作流已关闭，之后按普通群聊回答；原设置保留', 'info');
        }
        if (typeof window.schedulePersist === 'function') window.schedulePersist();
      } catch(error) { if (activeMeetingId === m.id) _showGcEscapeNotice(error.message, 'error'); }
      finally { workflowSwitch.disabled = false; }
    });
    const workflowBtn = document.getElementById('mr-workflow-btn');
    if (workflowBtn) {
      workflowBtn.addEventListener('click', async () => {
        const m = meetingData[activeMeetingId];
        if (!m || !m.groupChat) return;
        // Creation emits intermediate seat snapshots; settings must bind to the
        // completed main-process identities, including on the very first open.
        try {
          const latest = (await ipcRenderer.invoke('get-meetings')).find(item => item.id === m.id);
          if (!latest || activeMeetingId !== m.id) return;
          m.slotSpecs = latest.slotSpecs; m.subSessions = latest.subSessions; m.serialWorkflow = latest.serialWorkflow;
        } catch (error) { _showGcEscapeNotice('读取工作流设置失败：'+error.message, 'error'); return; }
        // 2026-07-20 maintainer [修#8]：循环运行中禁改配置（本次运行按旧 steps 跑，改了也不生效还误导）
        const loopSt0 = _loopStateByMeeting[m.id]
          || (m.serialWorkflow && m.serialWorkflow.loopState)
          || null;
        const serialSt0 = _workflowStateByMeeting[m.id]
          || (m.serialWorkflow && m.serialWorkflow.serialRunState)
          || null;
        let conversationRunning = null;
        if (Conversation.enabled(m)) {
          try {
            const status = await ipcRenderer.invoke('loop:status',{meetingId:m.id});
            if (status?.error) throw new Error(status.error);
            conversationRunning = !!status?.running;
          } catch(error) {
            _showGcEscapeNotice(`无法读取发言进度：${error.message}`, 'error');
            return;
          }
          if (activeMeetingId !== m.id) return;
        }
        if ((loopSt0 && loopSt0.status === 'running') || (Conversation.enabled(m) ? conversationRunning : serialSt0 && serialSt0.status === 'running')) {
          _showGcEscapeNotice('工作流运行中，停止后才能修改配置', 'error');
          return;
        }
        const members = _buildWorkflowMembers(m);
        if (!members.length) { require('./ui-feedback').showHubAlert('群里还没有可用的 AI 成员，先添加成员再配置工作流'); return; }
        const settingsRevision = m.serialWorkflow?.settingsRevision || 0;
        window.openWorkflowConfigModal({
          members,
          config: m.serialWorkflow || null,
          meeting: m,
          taskDir: _devFileStates[m.id]?.dir,
          legacyTaskFiles: !!_devFileStates[m.id]?.files?.length,
          onSave: async (_config, draft) => {
            const result = await ipcRenderer.invoke('workflow:configure', { meetingId: m.id, draft, expectedRevision: settingsRevision });
            if (!result?.ok) throw new Error(result?.reason || '工作流设置未保存');
            m.serialWorkflow = result.config;
            DeliveryControls.clear(m.id);
            ConversationControls.clear(m.id);
            delete _workflowStateByMeeting[m.id];
            _updateWorkflowBtnState(m);
            _updateInputPreflight(m);
            // 主动落 state.json（boot 恢复源），不赌 schedulePersist 时机
            if (typeof window.schedulePersist === 'function') window.schedulePersist();
          },
        });
      });
    }

    inputBox.addEventListener('keydown', (e) => {
      // IME composition (中/日/韩) 中, 回车/方向键是给候选词用的, 不是给应用层。
      // 不放行就会出现:中文按回车选词被当作"发送"+清空输入框,或方向键被 mention 菜单吃掉。
      if (e.isComposing || e.keyCode === 229) return;
      const mid = activeMeetingId;
      const currentMeeting = meetingData[mid] || meeting;
      if (_handleGcMentionKeydown(e, inputBox, currentMeeting)) return;
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        doSend();
      }
    });

    inputBox.addEventListener('input', () => {
      const mid = activeMeetingId;
      _saveInputDraft();
      _updateGcMentionMenu(inputBox, meetingData[mid] || meeting);
    });
    inputBox.addEventListener('keyup', (e) => {
      if (['ArrowDown', 'ArrowUp', 'Enter', 'Tab', 'Escape'].includes(e.key)) return;
      const mid = activeMeetingId;
      _updateGcMentionMenu(inputBox, meetingData[mid] || meeting);
    });
    inputBox.addEventListener('click', () => {
      const mid = activeMeetingId;
      _updateGcMentionMenu(inputBox, meetingData[mid] || meeting);
    });
    inputBox.addEventListener('blur', () => {
      setTimeout(_hideGcMentionMenu, 120);
    });
  }

  async function handleMeetingSend(text, meeting, opts = {}) {
    const current = meetingData[meeting.id] || meeting;

    // AI 群聊统一路由。
    if (current.scene) {
      const _userInputForBanner = text.trim();
      const pendingUser = _userInputForBanner
        ? _rememberPendingUserMessage(current, _userInputForBanner)
        : null;
      try {
        await ipcRenderer.invoke('meeting-append-user-turn', { meetingId: meeting.id, text });
      } catch (e) { console.warn('[meeting-room] append-user-turn failed:', e.message); }
      triggerGroupChat(current, {
        userInput: text,
        pendingClientId: pendingUser && pendingUser.clientId,
        recipientSids: opts.recipientSids,
      });
      return;
    }

    const targets = current.sendTarget === 'all' ? current.subSessions : [current.sendTarget];

    // Single defensive filter: only sub-sessions still in the meeting and not dormant.
    const validTargets = targets.filter(sid => {
      if (!current.subSessions.includes(sid)) return false;
      const s = sessions ? sessions.get(sid) : null;
      return s && s.status !== 'dormant';
    });

    // Phase B: append user turn to timeline. Always do this (even when no valid
    // targets) so Feed UI history is complete.
    await ipcRenderer.invoke('meeting-append-user-turn', { meetingId: meeting.id, text });

    const contextBySid = {};

    if (validTargets.length === 0) {
      console.warn('[meeting-room] handleMeetingSend: no valid targets, message recorded in timeline only');
      meeting.lastMessageTime = Date.now();
      ipcRenderer.send('update-meeting', { meetingId: meeting.id, fields: { lastMessageTime: meeting.lastMessageTime } });
      return;
    }

    // --- Normal mode: Phase C send to each target ---
    // 2026-09-03：这里原本是「裸写 payload + 400~900ms 后盲发一个 \r」。
    //   sizeDelay 封顶 500ms，意味着 5KB 和 50KB 的 payload 等的时间一样长 ——
    //   会议成员越多、上下文越长，\r 越容易还在 node-pty 的写队列里就被并进
    //   paste 块吞掉，消息卡在 CLI 输入框不提交。改走与浮动输入框、群聊派发
    //   同一条闭环（分块投喂 + 自适应 settle + 语义确认 + 有界补回车）。
    //   各会话之间仍并行，闭环内部按会话串行。
    for (const sessionId of validTargets) {
      const payload = (contextBySid[sessionId] || '') + text;
      ipcRenderer.invoke('session:send-prompt', { sessionId, text: payload })
        .then((result) => {
          if (result && result.ok && result.sendStatus !== 'stuck') return;
          console.warn(`[meeting-room] prompt not acknowledged for ${String(sessionId).slice(0, 8)}:`,
            (result && (result.error || result.sendStatus)) || 'unknown');
        })
        .catch(err => console.warn('[meeting-room] send-prompt failed:', err && err.message));
    }

    meeting.lastMessageTime = Date.now();
    ipcRenderer.send('update-meeting', { meetingId: meeting.id, fields: { lastMessageTime: meeting.lastMessageTime } });
  }

  // Format incremental-context turns as a clear "meeting sync" prefix the AI can
  // recognize as not being from the user. Format:
  //   [会议室协作同步]
  //   【你】Q2 follow-up
  //   【Codex】R2_X content...
  //   ---
  function formatIncrementalContext(turns, sessions) {
    const lines = ['[会议室协作同步]'];
    for (const t of turns) {
      let label;
      if (t.sid === 'user') {
        label = '你';
      } else {
        const s = sessions ? sessions.get(t.sid) : null;
        label = s ? (s.title || s.kind || 'AI') : 'AI';
      }
      lines.push(`【${label}】${t.text}`);
    }
    lines.push('---', '');
    return lines.join('\n');
  }

  async function buildContextSummary(meeting, excludeSessionId) {
    const others = meeting.subSessions.filter(id => id !== excludeSessionId);
    if (others.length === 0) return '';

    const lines = [];
    for (const id of others) {
      const session = sessions ? sessions.get(id) : null;
      const label = session ? (session.kind || 'session') : 'session';

      const raw = await ipcRenderer.invoke('get-ring-buffer', id);
      let content = raw ? (raw.length > 1000 ? raw.slice(-1000) : raw) : '';
      if (!content) continue;

      lines.push(`【${label}】${content}`);
    }

    if (lines.length === 0) return '';
    return `[会议室协作同步]\n${lines.join('\n')}\n---\n`;
  }

  // --- Helpers ---

  // --- Tab output state tracking ---
  function _handleTerminalActivity(sessionId) {
    if (!activeMeetingId) return;
    const meeting = meetingData[activeMeetingId];
    if (!meeting || !meeting.subSessions.includes(sessionId)) return;
    const focused = meeting.focusedSub || meeting.subSessions[0];
    if (sessionId === focused) return;

    _tabState[sessionId] = 'streaming';
    updateTabIndicator(sessionId);

    if (_tabTimers[sessionId]) clearTimeout(_tabTimers[sessionId]);
    _tabTimers[sessionId] = setTimeout(() => {
      if (_tabState[sessionId] === 'streaming') {
        _tabState[sessionId] = 'new-output';
        updateTabIndicator(sessionId);
      }
    }, 2000);
  }
  ipcRenderer.on('terminal-data', (_e, { sessionId }) => _handleTerminalActivity(sessionId));
  ipcRenderer.on('meeting-terminal-activity', (_e, { sessionId }) => _handleTerminalActivity(sessionId));

  // 归档建议到达时立刻把 chip 点亮，否则要等下一次 header 渲染才看得见。
  // 只重画 header，不弹任何东西 —— 是否归档由用户点 chip 决定。
  window.addEventListener('workspace-archive-suggestion', (event) => {
    const detail = event && event.detail;
    if (!detail || detail.scope !== 'meeting') return;
    if (!activeMeetingId || detail.id !== activeMeetingId) return;
    const meeting = meetingData[activeMeetingId];
    if (meeting) renderHeader(meeting);
  });

  ipcRenderer.on('session-closed', (_e, { sessionId }) => {
    if (_tabState[sessionId] !== undefined) {
      _tabState[sessionId] = 'error';
      updateTabIndicator(sessionId);
    }
    // IF-C6（多方审查 high 修复 2026-05-01）：CLI 进程退出后清 _cliReadyCache，
    //   避免单调递增——一旦 ready=true 永不复查导致卡片错误显示"已就绪"。
    //   清后下个 cliReady poll tick 会重新查 IPC 拿到 false（getSession 找不到 sid 即返回 false）。
    if (_cliReadyCache[sessionId] !== undefined) {
      delete _cliReadyCache[sessionId];
      if (activeMeetingId && _isPanelCapableMeeting(meetingData[activeMeetingId])) {
        const cached = _gcPanelState[activeMeetingId];
        if (cached) {
          const panel = _ensureGcPanel();
          // 群聊弹顶 bug 修复（2026-06-05 maintainer）：session-closed 在 CLI 崩溃时触发全量重渲,
          //   过去无 capture/restore → scrollTop=0,刚崩溃用户视觉"弹顶"信息找不回。
          const meeting = meetingData[activeMeetingId];
          const groupScroll = _captureGroupChatScroll(panel, meeting);
          _renderGcPanelInto(panel, meeting, cached, { scroll: groupScroll });
        }
      }
    }
  });

  window.addEventListener('hub-session-suspended', (event) => {
    const sessionId = event && event.detail && event.detail.sessionId;
    if (!sessionId) return;
    if (_tabState[sessionId] !== undefined) {
      _tabState[sessionId] = 'idle';
      updateTabIndicator(sessionId);
    }
    delete _cliReadyCache[sessionId];
    if (activeMeetingId && _isPanelCapableMeeting(meetingData[activeMeetingId])) {
      const cached = _gcPanelState[activeMeetingId];
      if (cached) {
        const panel = _ensureGcPanel();
        const meeting = meetingData[activeMeetingId];
        const groupScroll = _captureGroupChatScroll(panel, meeting);
        _renderGcPanelInto(panel, meeting, cached, { scroll: groupScroll });
      }
    }
  });

  function updateTabIndicator(sessionId) {
    const tab = document.querySelector(`.mr-tab[data-sid="${sessionId}"]`);
    if (!tab) return;
    const state = _tabState[sessionId] || 'idle';
    let dot = tab.querySelector('.mr-tab-status');
    if (!dot) {
      dot = document.createElement('span');
      dot.className = 'mr-tab-status';
      tab.prepend(dot);
    }
    dot.className = `mr-tab-status ${state}`;
    let badge = tab.querySelector('.new-badge');
    if (state === 'new-output') {
      if (!badge) {
        badge = document.createElement('span');
        badge.className = 'new-badge';
        badge.textContent = 'NEW';
        tab.appendChild(badge);
      }
      tab.classList.add('has-new');
    } else {
      if (badge) badge.remove();
      tab.classList.remove('has-new');
    }
  }

  // --- Expose global ---

  function focusSearchHit(hit = {}) {
    const panel = document.getElementById('mr-gc-panel');
    if (!panel || panel.style.display === 'none') return false;
    const normalize = value => String(value || '').normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();
    const fullNeedle = normalize(hit.text);
    const needle = fullNeedle.length > 90 ? fullNeedle.slice(0, 90) : fullNeedle;
    if (!needle) return false;
    const messages = [...panel.querySelectorAll('.mr-gc-msg')];
    const target = messages.find(message => normalize(message.textContent).includes(needle))
      || messages.find(message => {
        const words = needle.split(/\s+/).filter(word => word.length >= 2).slice(0, 4);
        const hay = normalize(message.textContent);
        return words.length > 0 && words.every(word => hay.includes(word));
      });
    if (!target) return false;
    target.classList.add('global-search-focus');
    target.scrollIntoView({ block: 'center', behavior: 'smooth' });
    setTimeout(() => { if (target.isConnected) target.classList.remove('global-search-focus'); }, 1500);
    return true;
  }

  const meetingRoomApi = {
    appendFilePaths(paths) {
      const input = document.getElementById('mr-input-box');
      if (!activeMeetingId || !input || input.getAttribute('contenteditable') === 'false') throw new Error('请先打开可编辑的群聊输入框');
      const current = _getInputRawText();
      _setMeetingInputText(activeMeetingId, `${current}${current.trim() ? '\n\n' : ''}${paths.join('\n')}`);
      _saveInputDraft();
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.focus();
      return true;
    },
    init,
    openMeeting,
    closeMeetingPanel,
    getActiveMeetingId,
    getMeetingData,
    refreshSessionMetrics,
    refreshNativeCancellation,
    focusSearchHit,
    updateMeetingData,
  };
  const voiceBox = document.getElementById('mr-input-box');
  const voiceRail = document.getElementById('mr-input-row');
  if (voiceBox && voiceRail) require('./voice-input').attachVoiceInput({
    input: voiceBox, rail: voiceRail,
    getStatusHost: () => document.getElementById('mr-composer-head') || document.getElementById('mr-input-preflight'),
    getTarget: () => ({ id: activeMeetingId, project: meetingData[activeMeetingId]?.workspace || '' }),
    isActive: target => activeMeetingId === target.id && voiceBox.getClientRects().length > 0,
  });
  if (voiceBox && voiceRail) require('./prompt-polish').attachPromptPolish({
    input: voiceBox, rail: voiceRail, before: document.getElementById('mr-send-btn'), ipcRenderer,
    getTarget: () => ({ id: activeMeetingId }),
    isActive: id => activeMeetingId === id && voiceBox.getClientRects().length > 0,
    writeText: text => _setMeetingInputText(activeMeetingId, text),
  });
  require('./composer-collapse').mountComposerCollapse({ document, host: voiceRail,
    before: document.getElementById('mr-send-btn'), input: voiceBox });
  if (process && process.env && process.env.CLAUDE_HUB_E2E === '1') {
    // 走真实 handleMeetingSend，但**不 await** —— e2e 要量的正是「按下发送那一刻
    // 到看见自己那张气泡」的间隔，await 会把这个间隔藏起来。
    meetingRoomApi.debugSendGroupChat = function debugSendGroupChat(meetingId, text) {
      const meeting = meetingData[meetingId];
      if (!meeting || !_isPanelCapableMeeting(meeting)) return { ok: false, reason: 'meeting_not_found' };
      Promise.resolve(handleMeetingSend(String(text || ''), meeting))
        .catch(error => console.warn('[e2e] debugSendGroupChat failed:', error && error.message));
      return { ok: true };
    };
    meetingRoomApi.debugRenderGroupChatState = function debugRenderGroupChatState(meetingId, state) {
      const meeting = meetingData[meetingId];
      if (!meeting || !_isPanelCapableMeeting(meeting)) return { ok: false, reason: 'meeting_not_found' };
      const panel = _ensureGcPanel();
      _gcPanelState[meetingId] = state || {};
      _renderGcPanelInto(panel, meeting, _gcPanelState[meetingId]);
      return { ok: true, text: panel.innerText || '' };
    };
  }
  window.MeetingRoom = meetingRoomApi;

})();

// Node 测试环境兼容（renderer 真实运行时为 IIFE 浏览器环境，typeof module 为 undefined 走不到这）
if (typeof module !== 'undefined' && module.exports) {
  // 让 unit test 能 require 到 _isPartialUnchanged。这种"双模兼容"模式同 group-chat modules。
  // 双份函数体看起来 DRY 违反，但 IIFE 内部变量（document、ipcRenderer）在 Node require 时不存在 →
  // 把整个 IIFE 移出来代价巨大。_isPartialUnchanged 是纯函数无外部依赖 → 复制一份是最低成本路径。
  module.exports = {
    groupInputTuningFrame,
    _isPartialUnchanged: function _isPartialUnchanged(prev, next) {
      if (!prev && !next) return true;
      if (!prev || !next) return false;
      if (prev.text !== next.text) return false;
      if (prev.status !== next.status) return false;
      if (prev.cleanBufLen !== next.cleanBufLen) return false;
      if (prev.sendStatus !== next.sendStatus) return false;
      if (prev.attemptId !== next.attemptId) return false;
      if (prev.providerTurnId !== next.providerTurnId) return false;
      if (prev.reason !== next.reason) return false;
      if ((prev.failure && prev.failure.code) !== (next.failure && next.failure.code)) return false;
      const pt = prev.tokens && prev.tokens.total;
      const nt = next.tokens && next.tokens.total;
      if (pt !== nt) return false;
      const pb = Array.isArray(prev.blocks) ? prev.blocks : null;
      const nb = Array.isArray(next.blocks) ? next.blocks : null;
      if (!pb && !nb) return true;
      if (!pb || !nb) return false;
      if (pb.length !== nb.length) return false;
      if (pb.length === 0) return true;
      const last = pb.length - 1;
      if (pb[last].type !== nb[last].type) return false;
      if ((pb[last].text || '') !== (nb[last].text || '')) return false;
      return true;
    },
  };
}
