'use strict';

// CLI 压缩上下文时不会给出跨供应商的统一信号。唯一中立的证据是「已用上下文
// 从观测峰值掉到一半以下」—— 这时早先随消息发过的附加内容（梦境索引、工作区
// 规则、群规则）很可能已被摘要掉，需要重发一次。
//
// 这里只放判定本身，状态（峰值记在哪、何时清零）由调用方各自保存：
// hub-memory-service 记在回执文件里，群聊 orchestrator 记在群聊状态里。
const COMPACTION_MIN_PEAK = 40000;
const COMPACTION_RATIO = 0.5;

/**
 * @param {number} peakContext 上次发送后观测到的最大已用上下文
 * @param {number|null} contextUsed 当前已用上下文；拿不到就是 null
 * @returns {{ compacted: boolean, peak: number }} peak 为更新后的峰值（未压缩时取较大值）
 */
function checkCompaction(peakContext, contextUsed) {
  const peak = Number(peakContext) || 0;
  const used = typeof contextUsed === 'number' && Number.isFinite(contextUsed) ? contextUsed : null;
  if (used === null) return { compacted: false, peak };
  if (peak >= COMPACTION_MIN_PEAK && used < peak * COMPACTION_RATIO) return { compacted: true, peak };
  return { compacted: false, peak: Math.max(peak, used) };
}

module.exports = { COMPACTION_MIN_PEAK, COMPACTION_RATIO, checkCompaction };
