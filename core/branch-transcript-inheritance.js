'use strict';

// 分支会话的卡片视图必须能看到分支之前的对话。
//
// 各家 CLI 的 fork 语义完全不同（2026-08-28 对 ~/.codex/sessions 与
// ~/.claude/projects 下真实 fork 产物实测）：
//   * Claude `--resume <id> --fork-session`：新 jsonl **整份复制**父会话历史，
//     只把 sessionId 改写成新的 → 卡片视图天然继承。
//   * Codex `codex fork <sid>`：新 rollout 里 **一条父历史都没有**。四个真实
//     fork 文件里「首个 task_started 之前的 response_item/message」全是 0 条，
//     父对话只活在内存与父 rollout 里 → 卡片视图从分支那一刻开始，之前的全丢。
//
// 所以继承必须由 Hub 自己补：沿 branchSourceSessionId 往上找祖先 transcript，
// 取 fork 时间点之前的 turn 拼到前面。对 Claude 也照跑一遍是安全的——签名去重会
// 把已经复制过来的部分全部滤掉，不会出现双份。

const MAX_BRANCH_DEPTH = 6;
const SIGNATURE_TEXT_CHARS = 400;

function normalizeText(value) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
}

// role + 正文前缀。父子两侧的同一条消息可能带不同的 id（Codex 用 rollout 行号做
// id，Claude fork 会重写 uuid），所以不能按 id 去重。
function turnSignature(turn) {
  const role = String((turn && turn.role) || '');
  return `${role}|${normalizeText(turn && turn.text).slice(0, SIGNATURE_TEXT_CHARS)}`;
}

function finiteTs(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : 0;
}

function earliestTurnTs(turns) {
  let earliest = 0;
  for (const turn of Array.isArray(turns) ? turns : []) {
    const ts = finiteTs(turn && turn.ts);
    if (!ts) continue;
    if (!earliest || ts < earliest) earliest = ts;
  }
  return earliest;
}

// fork 发生的时刻。父会话在分支之后可能继续往前跑，那部分不属于这条分支，必须切掉。
// 优先级：活会话的 createdAt（Hub 建会话紧接着就 spawn fork）→ provider 自己写的
// fork 时间戳 → 子会话最早一条 turn。落盘的会话记录没有 createdAt 字段（实测
// sessions/*.json 只有 lastMessageTime/updatedAt/savedAt），所以后两档不是可选项。
function resolveForkTimestamp({ session, childTurns, providerForkAt } = {}) {
  const candidates = [
    finiteTs(session && session.createdAt),
    finiteTs(providerForkAt),
    earliestTurnTs(childTurns),
  ].filter(Boolean);
  if (!candidates.length) return 0;
  return Math.min(...candidates);
}

// 把祖先 turn 标记出来并前置。已经出现在子 transcript 里的（Claude 复制过来的那批）
// 按签名滤掉；fork 之后父会话自己继续产生的那批按时间戳滤掉。
function mergeInheritedTurns(inheritedTurns, childTurns, { forkAt = 0, sourceSessionId = null } = {}) {
  const child = Array.isArray(childTurns) ? childTurns : [];
  const seen = new Set(child.map(turnSignature));
  const cut = finiteTs(forkAt);
  const prefix = [];
  for (const turn of Array.isArray(inheritedTurns) ? inheritedTurns : []) {
    if (!turn || !turn.role) continue;
    const ts = finiteTs(turn.ts);
    if (cut && ts && ts > cut) continue;
    const signature = turnSignature(turn);
    if (!normalizeText(turn.text)) continue;
    if (seen.has(signature)) continue;
    seen.add(signature);
    prefix.push({
      ...turn,
      // id 必须换掉：子会话自己的卡片可能用同一套 id 空间（Codex 的 id 由 rollout
      // 行号推出来），不加前缀会被 mountSessionTurnCard 当成同一张卡去重掉。
      id: `branch-inherited:${String(turn.id || prefix.length)}`,
      inherited: true,
      inheritedFrom: sourceSessionId || (turn.inheritedFrom || null),
    });
  }
  return prefix.concat(child);
}

function applyTailLimit(turns, limit, fromTail) {
  const list = Array.isArray(turns) ? turns : [];
  if (typeof limit !== 'number' || !Number.isFinite(limit) || limit >= list.length) return list;
  return fromTail === false ? list.slice(0, limit) : list.slice(list.length - limit);
}

module.exports = {
  MAX_BRANCH_DEPTH,
  applyTailLimit,
  earliestTurnTs,
  mergeInheritedTurns,
  resolveForkTimestamp,
  turnSignature,
};
