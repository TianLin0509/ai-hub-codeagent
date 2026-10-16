'use strict';
// AI特战队会话的收放（2026-10-16 用户定：「不用无脑的固定时间，根据激活状态判断、自适应」，四项按推荐）。
// 设计：D:/AI-Artifacts/20261016-会话管理与AI特战队通道设计-claude1.html。这里只做通道会话（第一步），三件事：
//   1. 保温多久：按这台电脑上家里实际追问的间隔学（答完到下一轮到达的 90% 分位），不写死；样本少时用 45 分钟。
//      家里发问的那个会话还在活动时保温加倍——家里还在用这条线索，追问的可能大。
//   2. 内存紧不紧：可用内存低于 20% 开始收、收到回到 30% 为止，先收最冷的（答完最久、发问方不活跃的）。
//      内存宽裕时只按保温时长收，不提前收。
//   3. 底线：正在干活、你正看着、置顶、群聊成员、这一轮还没收完的，一律不收（由调用方和 suspendSession 共同保证）。
// 公司真机实测每个 CodeAgent 会话 = 主进程 + serve 子进程 ≈ 1.3 GB（Q-1016-01 第 11 轮），用来估算收一个能腾出多少。
const os = require('node:os');

const DEFAULT_KEEP_WARM_MS = 45 * 60000;
const MIN_KEEP_WARM_MS = 10 * 60000;
const MAX_KEEP_WARM_MS = 120 * 60000;
const MIN_SAMPLES = 8;
const LOW_FREE_RATIO = 0.20;
const HIGH_FREE_RATIO = 0.30;
const SESSION_BYTES = 1.3 * 1024 ** 3;

function quantile(values, q) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
}

// 每条线索里「这一轮回答送出 → 下一轮到达」的间隔。
function followupGaps(threads) {
  const gaps = [];
  for (const t of threads || []) {
    const rounds = (t.rounds || []).slice().sort((a, b) => a.round - b.round);
    for (let i = 0; i + 1 < rounds.length; i += 1) {
      const end = rounds[i].replyAt || rounds[i].failedAt;
      const next = rounds[i + 1].receivedAt;
      if (end && next && next > end) gaps.push(next - end);
    }
  }
  return gaps;
}

function learnKeepWarm(threads) {
  const gaps = followupGaps(threads);
  if (gaps.length < MIN_SAMPLES) return { ms: DEFAULT_KEEP_WARM_MS, samples: gaps.length, learned: false };
  const p90 = quantile(gaps, 0.9);
  return { ms: Math.min(MAX_KEEP_WARM_MS, Math.max(MIN_KEEP_WARM_MS, p90)), samples: gaps.length, learned: true };
}

function memoryNow(osModule = os) {
  const total = osModule.totalmem(), free = osModule.freemem();
  return { total, free, ratio: total > 0 ? free / total : 1 };
}

// candidates：[{ sessionId, threadId, idleSince, askerActive }]，调用方已排除在途、正在干活的。
// 返回 [{ sessionId, threadId, reason }]，reason 是写进日志、给人看的一句话。
function planRelease({ candidates, keepWarmMs, now, memory, sessionBytes = SESSION_BYTES }) {
  const out = [], kept = [];
  for (const c of candidates || []) {
    const idle = now - c.idleSince;
    const limit = c.askerActive ? keepWarmMs * 2 : keepWarmMs;
    if (idle >= limit) out.push({ ...c, reason: `答完 ${Math.round(idle / 60000)} 分钟没人追问（保温 ${Math.round(limit / 60000)} 分钟${c.askerActive ? '，家里发问方仍活跃已加倍' : ''}）` });
    else kept.push({ ...c, idle });
  }
  if (memory && memory.total > 0) {
    let free = memory.free + out.length * sessionBytes;
    if (free / memory.total < LOW_FREE_RATIO) {
      // 先收最冷的：发问方不活跃的在前，同类里答完越久越冷。
      kept.sort((a, b) => (a.askerActive === b.askerActive ? b.idle - a.idle : a.askerActive ? 1 : -1));
      for (const c of kept) {
        if (free / memory.total >= HIGH_FREE_RATIO) break;
        out.push({ ...c, reason: `内存紧（可用 ${Math.round(memory.free / memory.total * 100)}%），先收最冷的：答完 ${Math.round(c.idle / 60000)} 分钟` });
        free += sessionBytes;
      }
    }
  }
  return out;
}

module.exports = {
  learnKeepWarm, followupGaps, memoryNow, planRelease, quantile,
  DEFAULT_KEEP_WARM_MS, MIN_KEEP_WARM_MS, MAX_KEEP_WARM_MS, LOW_FREE_RATIO, HIGH_FREE_RATIO, SESSION_BYTES,
};
