'use strict';
// AI特战队会话的收放（2026-10-16 用户定：「不用无脑的固定时间，根据激活状态判断、自适应」，四项按推荐）。
// 设计：D:/AI-Artifacts/20261016-会话管理与AI特战队通道设计-claude1.html。这里只做通道会话（第一步），三件事：
//   1. 保温多久：按这台电脑上家里实际追问的间隔学（答完到下一轮到达的 90% 分位），不写死；样本少时用 45 分钟。
//      家里发问的那个会话还在活动时保温加倍——家里还在用这条线索，追问的可能大。
//   2. 内存紧不紧：可用内存低于 20% 开始收、收到回到 30% 为止，先收最冷的（答完最久、发问方不活跃的）。
//      内存宽裕时只按保温时长收，不提前收。
//   3. 底线：正在干活、你正看着、置顶、群聊成员、这一轮还没收完的，一律不收（由调用方和 suspendSession 共同保证）。
// 每个 CodeAgent 会话占多少内存（并行上限 memCap 与收会话 planRelease 共用一个估计，见文末「会话内存估计」）：
//   优先实测——正在运行的 CodeAgent 会话 PTY 进程树的工作集均值；没有样本或测量失败时用默认 3.8 GB。
//   旧值 1.3 GB 只量了主进程 + serve 子进程刚起来时（Q-1016-01 第 11 轮）；2026-10-20 公司真机工作中的会话
//   （--diag hub 里会话进程树的内存）是 3.7–3.9 GB，按 1.3 GB 算会多开约 3 倍的会话。
const os = require('node:os');

const DEFAULT_KEEP_WARM_MS = 45 * 60000;
const MIN_KEEP_WARM_MS = 10 * 60000;
const MAX_KEEP_WARM_MS = 120 * 60000;
const MIN_SAMPLES = 8;
const LOW_FREE_RATIO = 0.20;
const HIGH_FREE_RATIO = 0.30;
const PARALLEL_MEM_FLOOR = 0.10; // 并行上限的内存保底（收会话的 20%/30% 是另一回事，见上面第 2 条）
const GB = 1024 ** 3;
// 没有实测样本时的保守默认：取公司真机工作中会话 3.7–3.9 GB 的中间值（2026-10-20 用户实测），宁可少开不爆内存。
const SESSION_BYTES = 3.8 * GB;
const SESSION_MEM_TTL_MS = 60000; // 实测结果缓存 60 秒：一次进程枚举约 0.8 秒（core/process-inspector.js 实测），不能每秒跑
const MIN_SESSION_SAMPLE_BYTES = 300 * 1024 ** 2; // 进程树不到 300 MB 的是刚起来、还没加载完的会话，不当样本（会把均值拉低、多开会话）
// 膨胀回收（2026-10-21，Q-1021-05 公司真机三轮只读回执）：CodeAgent CLI 每来一轮追问，serve 就再起一整批 MCP 插件、旧批不关，
// 一个会话从 2.3–2.7 GB 一路涨到 4.1–4.8 GB，32 GB 的公司电脑并行只剩 1 个。CLI 改不了；休眠后追问按编号 --resume 恢复，只剩一批插件。
// 所以：答完空闲 2 分钟、进程树实测 ≥ 3.2 GB（新会话一批插件 2.3–2.7 GB，多一批就 ≥ 3.5 GB）的通道会话，不等保温时长就先收起。
const BLOAT_BYTES = 3.2 * GB;
const BLOAT_MIN_IDLE_MS = 2 * 60000;

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

// candidates：[{ sessionId, threadId, idleSince, askerActive, bytes? }]，调用方已排除在途、正在干活的。
//   bytes：这个会话进程树的实测工作集（字节），测不到就不带；带了才参与「膨胀」规则和「收一个腾出多少」的累加。
// 返回 [{ sessionId, threadId, reason, rule }]：reason 是写进日志、给人看的一句话；rule 是 keep-warm / bloat / memory。
const validBytes = b => Number.isFinite(b) && b > 0;
const gbText = b => `${(b / GB).toFixed(1)} GB`;
function planRelease({ candidates, keepWarmMs, now, memory, sessionBytes = SESSION_BYTES, bloatBytes = BLOAT_BYTES, bloatMinIdleMs = BLOAT_MIN_IDLE_MS }) {
  const out = [], kept = [];
  for (const c of candidates || []) {
    const idle = now - c.idleSince;
    const limit = c.askerActive ? keepWarmMs * 2 : keepWarmMs;
    if (idle >= limit) out.push({ ...c, rule: 'keep-warm', reason: `答完 ${Math.round(idle / 60000)} 分钟没人追问（保温 ${Math.round(limit / 60000)} 分钟${c.askerActive ? '，家里发问方仍活跃已加倍' : ''}）` });
    else if (validBytes(c.bytes) && c.bytes >= bloatBytes && idle >= bloatMinIdleMs) {
      out.push({ ...c, rule: 'bloat', reason: `进程树 ${gbText(c.bytes)}（CodeAgent 每轮追问多起一批插件、旧的不关），答完 ${Math.round(idle / 60000)} 分钟空闲，先收起，追问时自动续上` });
    } else kept.push({ ...c, idle });
  }
  // 收一个腾出多少：有实测按它自己的进程树，没有才按每会话估计值。
  const freed = c => (validBytes(c.bytes) ? c.bytes : sessionBytes);
  if (memory && memory.total > 0) {
    let free = memory.free + out.reduce((sum, c) => sum + freed(c), 0);
    if (free / memory.total < LOW_FREE_RATIO) {
      // 先收最冷的：发问方不活跃的在前，同类里答完越久越冷。
      kept.sort((a, b) => (a.askerActive === b.askerActive ? b.idle - a.idle : a.askerActive ? 1 : -1));
      for (const c of kept) {
        if (free / memory.total >= HIGH_FREE_RATIO) break;
        out.push({ ...c, rule: 'memory', reason: `内存紧（可用 ${Math.round(memory.free / memory.total * 100)}%），先收最冷的：答完 ${Math.round(c.idle / 60000)} 分钟${validBytes(c.bytes) ? `，进程树 ${gbText(c.bytes)}` : ''}` });
        free += freed(c);
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------- 并行上限（2026-10-16 用户：「白天算力紧张，晚上尤其周末几乎不受限」，
// 并「把号池考虑到通道里，加速双向通信」）。三者取最小、至少 1：
//   时段：工作日忙时用成员设的上限（默认 3）；其余时间放宽到闲时上限（默认 6）；
//   账号：每个可用账号（个人 + 号池里能用的号）忙时最多 perAccountPeak 个（默认 3）、闲时 perAccountIdle 个（默认 6）；
//   内存：再开一个会话后可用内存仍不低于 memFloor（默认 10%；每个会话占多少按 sessionBytes，调用方传实测估计，默认 3.8 GB）。
//   2026-10-17 用户：忙时 3 个、内存保底 10%，这些数字都在设置里可调。
const DEFAULT_BUSY_HOURS = '08:30-12:00,13:30-17:30';
function parseHours(spec) {
  return String(spec || '').split(/[,，\s]+/).map(part => part.match(/^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})$/)).filter(Boolean)
    .map(m => [Number(m[1]) * 60 + Number(m[2]), Number(m[3]) * 60 + Number(m[4])]).filter(([a, b]) => a < b && b <= 24 * 60);
}
function isPeak(date, spec = DEFAULT_BUSY_HOURS) {
  const day = date.getDay();
  if (day === 0 || day === 6) return false;
  const minute = date.getHours() * 60 + date.getMinutes();
  return parseHours(spec).some(([a, b]) => minute >= a && minute < b);
}
function parallelCap({ date, busyHours = DEFAULT_BUSY_HOURS, peakCap = 3, idleCap = 6, perAccountPeak = 3, perAccountIdle = 6, memFloor = PARALLEL_MEM_FLOOR,
  lanes = 1, working = 0, memory = null, sessionBytes = SESSION_BYTES }) {
  const peak = isPeak(date, busyHours);
  const timeCap = peak ? peakCap : Math.max(peakCap, idleCap);
  const laneCap = Math.max(1, lanes) * (peak ? perAccountPeak : perAccountIdle);
  let memCap = Infinity;
  if (memory && memory.total > 0) memCap = working + Math.max(0, Math.floor((memory.free - memFloor * memory.total) / sessionBytes));
  const cap = Math.max(1, Math.min(timeCap, laneCap, memCap));
  const limitedBy = cap === timeCap ? (peak ? '工作日忙时上限' : '闲时上限') : cap === laneCap ? `可用账号数（${lanes} 个）` : cap === memCap ? '内存余量' : '最少保留 1 个';
  return { cap, peak, timeCap, laneCap, memCap: Number.isFinite(memCap) ? memCap : null, limitedBy };
}

// ---------------------------------------------------------------- 会话内存估计（2026-10-20 用户：「5 个号了，理论上只剩下内存瓶颈」）
// 每个 CodeAgent 会话按多少内存算：正在运行的会话进程树工作集的均值（实测）；没有样本、测量失败时用默认 3.8 GB。
// parallelCap（还能再开几个）和 planRelease（收一个腾出多少）都读 current() 的同一个值。
// 测量要便宜：结果缓存 ttlMs（默认 60 秒），过期后下一次读取才在后台重测，读取本身同步、从不等测量、从不抛错。

// 进程快照 + 会话 PTY 根 PID → 每个会话进程树的工作集（字节）。同一进程只算给第一个认领它的会话。纯函数，单测直接喂夹具。
function sessionTreeBytes(snap, roots) {
  const { subtreePids } = require('../process-reclaim');
  const list = (snap && snap.processes || []).filter(p => p && p.pid > 0);
  const byPid = snap && snap.byPid instanceof Map ? snap.byPid : new Map(list.map(p => [p.pid, p]));
  const children = snap && snap.childrenMap instanceof Map ? snap.childrenMap : require('../process-inspector').buildChildrenMap(list);
  const owned = new Set(), out = [];
  for (const { id, pid } of roots || []) {
    if (!id || !byPid.has(Number(pid))) continue;
    let bytes = 0, processes = 0;
    for (const x of subtreePids(Number(pid), children, byPid)) {
      if (owned.has(x)) continue;
      owned.add(x);
      bytes += Number(byPid.get(x)?.wsBytes) || 0; processes += 1;
    }
    out.push({ id, bytes, processes });
  }
  return out;
}

// SessionManager.sessions 的条目（[id, { info, pty }]）→ 正在运行的 CodeAgent 会话的 PTY 根 PID；休眠、关闭、没有终端进程的不算。
function codeagentSessionRoots(entries) {
  const out = [];
  for (const [id, s] of entries || []) {
    const info = (s && s.info) || {};
    if (!/^codeagent(?:-resume)?$/.test(String(info.kind || ''))) continue;
    if (info.status === 'dormant' || info.status === 'closed') continue;
    const pid = Number(s.pty && s.pty.pid);
    if (pid > 0) out.push({ id, pid });
  }
  return out;
}

function sessionMemNote(est) {
  const gb = `${(est.bytes / GB).toFixed(1)} GB`;
  if (est.source === 'measured') return `按每个会话约 ${gb} 估算（实测 ${est.samples} 个在运行的 CodeAgent 会话的平均）`;
  const why = est.reason === 'failed' ? `测量失败${est.error ? `：${String(est.error).slice(0, 80)}` : ''}` : est.reason === 'no-samples' ? (est.seen ? `在运行的 ${est.seen} 个 CodeAgent 会话都还不到 300 MB、像是没加载完，不当样本` : '现在没有在运行的 CodeAgent 会话可测') : '还没测';
  return `按每个会话约 ${gb} 估算（${why}，用默认值）`;
}

// 给设置页、--diag hub、排队说明看的字段：按多少 GB/会话、来源（measured 实测 / default 默认）、样本数、一句话说明。
function sessionMemView(est) {
  return { sessionGB: Math.round(est.bytes / GB * 10) / 10, sessionMemSource: est.source === 'measured' ? 'measured' : 'default',
    sessionMemSamples: est.samples || 0, sessionMemNote: est.note || sessionMemNote(est) };
}

// measure：async () => [{ id, bytes }] 或 [bytes]，每个在运行的会话一项；不给就一直用默认值。
// 除均值外还留着最近一次测到的每会话字节数（byId / bytesOf(id)），收会话的「膨胀」规则按它判断；测量失败时为空。
function createSessionMemEstimator({ measure = null, now = Date.now, ttlMs = SESSION_MEM_TTL_MS, defaultBytes = SESSION_BYTES, minSampleBytes = MIN_SESSION_SAMPLE_BYTES } = {}) {
  const fallback = (reason, error) => ({ bytes: defaultBytes, source: 'default', samples: 0, reason, ...(error ? { error } : {}), at: now() });
  let state = { ...fallback(measure ? 'not-yet' : 'no-measure'), at: 0 };
  let byId = {};
  let checkedAt = -Infinity, pending = null;
  function settle(list) {
    const items = Array.isArray(list) ? list : [];
    const nextById = {};
    for (const x of items) {
      const b = Number(x && typeof x === 'object' ? x.bytes : NaN);
      if (x && typeof x === 'object' && x.id && Number.isFinite(b)) nextById[String(x.id)] = b;
    }
    byId = nextById;
    const all = items.map(x => Number(x && typeof x === 'object' ? x.bytes : x)).filter(Number.isFinite);
    const bytes = all.filter(b => b >= minSampleBytes);
    if (!bytes.length) return { ...fallback('no-samples'), seen: all.length };
    return { bytes: Math.round(bytes.reduce((a, b) => a + b, 0) / bytes.length), source: 'measured', samples: bytes.length, at: now() };
  }
  function refresh() {
    if (!measure) return Promise.resolve(state);
    if (pending) return pending;
    checkedAt = now();
    pending = (async () => {
      try { state = settle(await measure()); } catch (error) { byId = {}; state = fallback('failed', error && error.message || String(error)); }
      return state;
    })().finally(() => { pending = null; });
    return pending;
  }
  // 同步读当前估计；缓存过期就在后台重测（这一次仍返回上一次的结果）。
  function current() {
    if (measure && !pending && now() - checkedAt >= ttlMs) void refresh();
    return { ...state, byId: { ...byId }, note: sessionMemNote(state) };
  }
  // 某个会话最近一次实测的进程树字节数；没测到返回 null。
  function bytesOf(id) {
    const b = byId[String(id)];
    return Number.isFinite(b) ? b : null;
  }
  return { current, refresh, bytesOf };
}

module.exports = {
  isPeak, parseHours, parallelCap, DEFAULT_BUSY_HOURS,
  learnKeepWarm, followupGaps, memoryNow, planRelease, quantile,
  sessionTreeBytes, codeagentSessionRoots, sessionMemNote, sessionMemView, createSessionMemEstimator,
  DEFAULT_KEEP_WARM_MS, MIN_KEEP_WARM_MS, MAX_KEEP_WARM_MS, LOW_FREE_RATIO, HIGH_FREE_RATIO, PARALLEL_MEM_FLOOR, SESSION_BYTES,
  SESSION_MEM_TTL_MS, MIN_SESSION_SAMPLE_BYTES, BLOAT_BYTES, BLOAT_MIN_IDLE_MS,
};
