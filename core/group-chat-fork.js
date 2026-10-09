'use strict';

/**
 * 整个群聊分支时，群聊记录怎么搬到新群聊。
 *
 * 分支出来的成员是**新的原生会话**（Claude --fork-session / codex fork），
 * 所以新群聊里每个人的 sid 都变了。群聊状态里到处都是以 sid 为键的账本：
 * 已读游标、成员身份、逐轮结果、统计、补充送达记录。漏掉任何一个，
 * 新群聊要么把历史重灌一遍，要么把成员认成陌生人。
 *
 * 这里是纯函数，不碰磁盘：进来一份源状态 + sid 映射，出去一份新状态。
 *
 * 刻意**不**搬的东西：
 *   - attempts / attemptEvents / pendingPrompts / activeRun：在途投递的账本。
 *     它们指向源群聊那次派发和源会话的原生 turn，搬过去只会让新群聊一启动
 *     就去认领一批永远不会有结果的尝试。
 *   - 消息上的 attemptId / providerTurnId：同理，指向源侧的原生身份。
 *   - devWorkbench / devFilePromptReceipts / devChatHistory：开发群聊有共享
 *     worktree 和交付文件，分支出来的两份会互相改坏，所以开发群聊根本不允许分支
 *     （拦在调用方），这里一并丢掉，免得残留状态误导工作台。
 */

const STATE_VERSION_FIELD = 'schemaVersion';

function _clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function remapSidTable(table, sidMap) {
  const out = {};
  if (!table || typeof table !== 'object') return out;
  for (const [sid, value] of Object.entries(table)) {
    const next = sidMap[sid];
    if (!next) continue; // 源群聊里已经被移除的成员，不带进新群聊的账本
    out[next] = _clone(value);
  }
  return out;
}

/**
 * @param {object} sourceState 源群聊的 orchestrator 状态（getState() 的结果）
 * @param {object} params.meetingId 新群聊 id
 * @param {object} params.sidMap    { 源 sid: 新 sid }
 * @param {function} params.anchorOf (meetingId, messageId) => anchor
 */
function remapForkedGroupState(sourceState, { meetingId, sidMap = {}, anchorOf = null, sourceMeetingId = null, sourceTitle = '' } = {}) {
  const source = sourceState && typeof sourceState === 'object' ? sourceState : {};
  const messages = (Array.isArray(source.messages) ? source.messages : []).map(message => {
    const next = _clone(message);
    if (next.sid && sidMap[next.sid]) next.sid = sidMap[next.sid];
    else if (next.sid) {
      // 分支时已经退群的成员：正文要留着（那是真实发生过的讨论），但 sid 不能原样带过来。
      // 原样留着的话，新群聊里这张卡片指向的是**另一个群聊的会话**——点「打开会话」
      // 会跳到别人的房间里去。加前缀让它明确指向"已经不在了"，而不是指向别人。
      next.sid = `fork-orphan:${next.sid}`;
      next.orphanedFromFork = true;
    }
    delete next.attemptId;
    delete next.providerTurnId;
    // 源群聊那一轮的 run 身份对新群聊没有意义，但它只是个标签，留着不会去认领任何东西。
    if (anchorOf && next.id) next.anchor = anchorOf(meetingId, next.id);
    return next;
  });

  const turns = (Array.isArray(source.turns) ? source.turns : []).map(turn => {
    const next = _clone(turn);
    for (const key of ['by', 'byStatus', 'thinkSecBy', 'tokensBy', 'attemptIdBy', 'providerTurnIdBy', 'failureBy']) {
      if (!next[key] || typeof next[key] !== 'object') continue;
      const table = {};
      for (const [sid, value] of Object.entries(next[key])) {
        // 已退群成员的历史结果保留（它是真实发生过的），但同样不能指向源群聊的会话。
        const mapped = sidMap[sid] || `fork-orphan:${sid}`;
        table[mapped] = value;
      }
      next[key] = table;
    }
    // 这两张表是「哪次尝试产出的」，新群聊没有那些尝试记录。
    delete next.attemptIdBy;
    delete next.providerTurnIdBy;
    return next;
  });

  const supplements = source.userSupplements && typeof source.userSupplements === 'object'
    ? source.userSupplements
    : { pendingBySid: {}, deliveredBySid: {} };

  return {
    [STATE_VERSION_FIELD]: source[STATE_VERSION_FIELD],
    meetingId,
    currentTurn: Number(source.currentTurn) || 0,
    currentMode: 'idle',
    revision: 0,
    activeRun: null,
    messages,
    nextMessageSeq: Math.max(1, Number(source.nextMessageSeq) || (messages.length + 1)),
    lastDeliveredIdx: remapSidTable(source.lastDeliveredIdx, sidMap),
    lastDeliveredSeq: remapSidTable(source.lastDeliveredSeq, sidMap),
    memberIdsBySid: remapSidTable(source.memberIdsBySid, sidMap),
    attempts: {},
    attemptEvents: [],
    pendingPrompts: {},
    userSupplements: {
      pendingBySid: remapSidTable(supplements.pendingBySid, sidMap),
      deliveredBySid: remapSidTable(supplements.deliveredBySid, sidMap),
    },
    turns,
    aiStats: remapSidTable(source.aiStats, sidMap),
    forkedFrom: {
      meetingId: sourceMeetingId || source.meetingId || null,
      title: String(sourceTitle || ''),
      at: Date.now(),
      turnNum: Number(source.currentTurn) || 0,
    },
  };
}

module.exports = { remapForkedGroupState };
