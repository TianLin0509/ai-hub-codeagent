'use strict';

// 群聊「本地 pending 提问」什么时候可以撤掉。
//
// 背景：用户在群聊里按下发送后，渲染层立刻画一条本地气泡（不等服务端），等服务端把
// 这条消息写进权威历史再撤掉本地那条。判断「服务端已经接手了」必须按**身份**。
//
// 这个判据被推翻过两次，两次都是因为拿「像不像」当「是不是」：
//
//   1. 按轮号：历史里存在轮号大于 pendingUser.afterTurn 的 user 消息就算确认。
//      首次打开房间时还没有面板缓存，afterTurn 只能算成 0，昨天第 7 轮的老提问满足
//      「7 > 0」，把刚发出的卡片抹掉了。轮号是顺序，不是身份。
//
//   2. 按内容 + 时间窗：内容一致且写盘时间不早于按下发送那一刻（留 5 秒余量）。
//      缓存里已经有一条一秒前的同文提问时，再发一次同样的话，那条老的照样落在窗口内，
//      新 pending 又被吃掉。时间窗只能表达「够不够近」，永远表达不了「是不是同一条」。
//
// 现在用真身份：渲染层生成 pending 时就带一个 clientId，这个 id 随
// `groupchat:turn` 一路传到 orchestrator，写进那条权威 user 消息的 clientMessageId。
// 认领只认 id 相等 —— 内容和时间都不再参与判定，老历史天然没有这个 id，认领不了。
//
// 认不上会怎样：pending 会一直留到本轮结束、由 turn-complete 按轮次清掉，
// 也就是「短暂重复显示」。这是刻意的取舍——重复看得见、可自愈，凭空消失不可自愈。
//
// 放在 core/ 而不是塞在 meeting-room.js 里，是为了能单测 —— meeting-room.js 是个
// 只在浏览器环境跑的大 IIFE，里面的东西测不到（同 core/session-view-mode.js 的理由）。

function pendingClaimToken(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/** 一条权威 user 消息能不能认领这条本地 pending：只看这次发送的身份。 */
function authoritativeUserMessageClaims(message, pendingUser) {
  if (!message || !pendingUser) return false;
  if (message.role !== 'user') return false;
  const claimId = pendingClaimToken(message.clientMessageId);
  if (!claimId) return false;
  return claimId === pendingClaimToken(pendingUser.clientId);
}

/**
 * 返回**还需要本地渲染**的 pending 列表（已被权威历史接手的不再返回）。
 *
 * 一条权威消息只能认领一条 pending。正常情况下 clientId 本来就是唯一的，
 * 这里保留一对一消费是为了「万一 id 重复」时不会一条把多条一起抹掉。
 */
function unclaimedPendingUserMessages(messages, pendings) {
  const pendingList = Array.isArray(pendings) ? pendings : [];
  if (!pendingList.length) return [];
  const authoritativeUsers = (Array.isArray(messages) ? messages : [])
    .filter(message => message && message.role === 'user');
  const claimedIndexes = new Set();
  const unclaimed = [];
  for (const pendingUser of pendingList) {
    const claimIndex = authoritativeUsers.findIndex((message, index) =>
      !claimedIndexes.has(index) && authoritativeUserMessageClaims(message, pendingUser));
    if (claimIndex >= 0) claimedIndexes.add(claimIndex);
    else unclaimed.push(pendingUser);
  }
  return unclaimed;
}

module.exports = {
  authoritativeUserMessageClaims,
  pendingClaimToken,
  unclaimedPendingUserMessages,
};
