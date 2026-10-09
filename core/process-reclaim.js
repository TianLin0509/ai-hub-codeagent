'use strict';

// 全机残留分类。核心立场：**只对认得出来的东西下结论**。
//
// 任何「可回收」的判定都必须命中下面的白名单形态之一，而不是靠某种通用启发式
// 去猜一个进程该不该死。市面上那类内存优化工具的做法（工作集清零、按无响应
// 关程序、按父进程已死判僵尸）本机全部实测证伪，一条都不采用：
//   · 工作集清零：实测 WS 77.3MB→0.1MB 而私有提交 362.9MB 纹丝不动，
//     内存没释放只是推去了页面文件，且会骗过 Hub 自己的内存表盘。
//   · 按 Responding=false 关程序：本机命中的 2 个全是 UWP 正常挂起
//     （全部线程 WaitReason=Suspended），恰恰是最省内存的一批。
//   · 按父进程已死判僵尸：本机误报 56/694（explorer/conhost 都是正常形态），
//     而真正该清的 agent 外壳父进程全都还活着，一个都抓不到。
//
// 分组顺序刻意按「证据有多硬」排，不按占多少内存排——用户要的是
// 「我能放心关哪些」，不是「谁最占地方」。

const GROUP_DEAD_HUB = 'deadHub';
const GROUP_ENDED_SESSION = 'endedSession';
const GROUP_UNATTRIBUTED = 'unattributed';
const GROUP_BIG_CONSUMER = 'bigConsumer';

// 进入「无需确认」那两组之前，CPU 必须基本不动。
const IDLE_REQUIRED_MS = 0;
// 占全机 CPU 低于这个百分比就算「几乎不动」。残留浏览器的后台定时器
// 实测在 0.1% 量级，真正在干活的进程会高出一到两个数量级。
const IDLE_CPU_PCT = 0.5;
// 认不出主人那组还要额外满足「活得够久」，避免把刚起来的东西当残留。
const UNATTRIBUTED_MIN_AGE_MS = 30 * 60 * 1000;

const HUB_EXE_NAME = 'aigroupchathub.exe';
const HUB_SOURCE_HINT = 'claude-session-hub';

// 系统与外壳进程：只用于把它们排除出「大户」展示，不作为可操作对象。
// 真正的安全靠白名单——不在白名单里的东西本来就没有任何按钮能碰。
const SYSTEM_PROCESS_NAMES = new Set([
  'system', 'system idle process', 'registry', 'memcompression', 'memory compression',
  'smss.exe', 'csrss.exe', 'wininit.exe', 'winlogon.exe', 'services.exe', 'lsass.exe',
  'svchost.exe', 'fontdrvhost.exe', 'dwm.exe', 'explorer.exe', 'conhost.exe',
  'sihost.exe', 'taskhostw.exe', 'ctfmon.exe', 'runtimebroker.exe', 'dllhost.exe',
  'wmiprvse.exe', 'audiodg.exe', 'spoolsv.exe', 'searchhost.exe', 'searchindexer.exe',
  'startmenuexperiencehost.exe', 'shellexperiencehost.exe', 'textinputhost.exe',
  'applicationframehost.exe', 'lsaiso.exe', 'securityhealthservice.exe',
  'msmpeng.exe', 'nissrv.exe', 'wudfhost.exe', 'backgroundtaskhost.exe',
]);

// ── 残留形态白名单 ──────────────────────────────────────────────
// 每一条都对应一类**确定由 agent 任务派生、任务结束后本该退出**的进程。
// label / whatYouLose 直接给用户看，所以写白话。
const LEFTOVER_PATTERNS = [
  {
    id: 'playwright-daemon',
    label: 'Playwright 浏览器守护进程',
    whatYouLose: '不会失去任何东西。它是 agent 做网页自动化时开的后台浏览器，任务早结束了，屏幕上也看不见它。',
    test: proc => /playwright-core[\\/].*cliDaemon\.js/i.test(proc.cmd),
    // 命令行末尾带着当时的任务名，抽出来给用户当身份标识用。
    detail: proc => {
      const match = /cliDaemon\.js\s+([^\s-][^\s]*)/i.exec(proc.cmd);
      return match ? `任务「${match[1]}」` : '';
    },
  },
  {
    id: 'mcporter-daemon',
    label: 'mcporter 后台进程',
    whatYouLose: '不会失去任何东西。它是 MCP 工具的常驻守护进程，对应的会话已经没了。',
    test: proc => /mcporter[\\/].*\bdaemon\b/i.test(proc.cmd),
  },
  {
    id: 'agent-shell',
    label: 'Agent 会话外壳',
    whatYouLose: '如果它确实不属于任何在跑的会话，关掉没有影响；它只是一个空着的 PowerShell 壳子。',
    // session-manager.js:1008 就是用 ['-NoProfile','-NoLogo'] 起的裸壳，
    // 后面再把 CLI 命令 write 进去，所以命令行永远是这个形状。
    test: proc => proc.name.toLowerCase() === 'powershell.exe'
      && /-NoProfile\s+-NoLogo\s*$/i.test(proc.cmd.trim()),
  },
  {
    id: 'npx-mcp-server',
    label: 'npx 启动的 MCP 服务',
    whatYouLose: '不会失去任何东西。它是某次会话临时装起来的工具服务，那次会话已经结束了。',
    test: proc => proc.name.toLowerCase() === 'node.exe'
      && /[\\/]_npx[\\/]/i.test(proc.cmd)
      && !/playwright-core[\\/].*cliDaemon\.js/i.test(proc.cmd),
  },
];

function isHubProcess(proc) {
  if (!proc) return false;
  const name = String(proc.name || '').toLowerCase();
  if (name === HUB_EXE_NAME) return true;
  // 源码模式跑的是原装 electron.exe，得靠命令行里的仓库路径认出来，
  // 否则会把用户装的其他 Electron 应用一起算进 Hub。
  if (name === 'electron.exe') return String(proc.cmd || '').toLowerCase().includes(HUB_SOURCE_HINT);
  return false;
}

// Electron 的 renderer/gpu/utility 子进程都带 --type=，它们是 Hub 自己的零件，
// 不是会话派生物。
function isElectronHelper(proc) {
  return /--type=/.test(String(proc.cmd || ''));
}

function isSystemProcess(proc) {
  return SYSTEM_PROCESS_NAMES.has(String(proc.name || '').toLowerCase());
}

function matchLeftoverPattern(proc) {
  for (const pattern of LEFTOVER_PATTERNS) {
    try {
      if (pattern.test(proc)) return pattern;
    } catch { /* 单条规则炸了不影响其它规则 */ }
  }
  return null;
}

// 真实的父子关系。PID 会被回收复用，如果「父进程」的启动时间反而晚于子进程，
// 那它根本不是父进程，只是碰巧占了同一个号——此时应当按孤儿处理。
function realParent(proc, byPid) {
  if (!proc || !proc.ppid) return null;
  const parent = byPid.get(proc.ppid);
  if (!parent) return null;
  if (parent.startedAt && proc.startedAt && parent.startedAt > proc.startedAt + 1_000) return null;
  return parent;
}

function ancestorChain(proc, byPid, maxDepth = 64) {
  const chain = [];
  let current = proc;
  let depth = 0;
  const seen = new Set([proc.pid]);
  while (depth < maxDepth) {
    const parent = realParent(current, byPid);
    if (!parent || seen.has(parent.pid)) break;
    chain.push(parent);
    seen.add(parent.pid);
    current = parent;
    depth += 1;
  }
  return chain;
}

function subtreePids(rootPid, childrenMap, byPid, maxNodes = 4096) {
  const seen = new Set();
  const queue = [Number(rootPid)];
  while (queue.length > 0 && seen.size < maxNodes) {
    const current = queue.shift();
    if (seen.has(current)) continue;
    seen.add(current);
    const kids = childrenMap.get(current) || [];
    for (const kid of kids) {
      const child = byPid.get(kid);
      // 同样要防 PID 复用：一个启动时间早于「父」的进程不可能是它的孩子。
      if (child && realParent(child, byPid) && realParent(child, byPid).pid === current) queue.push(kid);
    }
  }
  return seen;
}

function sumBytes(pids, byPid) {
  let ws = 0;
  let priv = 0;
  for (const pid of pids) {
    const proc = byPid.get(pid);
    if (!proc) continue;
    ws += proc.wsBytes || 0;
    priv += proc.privBytes || 0;
  }
  return { wsBytes: ws, privBytes: priv };
}

function treeHasWindow(pids, byPid) {
  for (const pid of pids) {
    const proc = byPid.get(pid);
    if (proc && proc.hasWindow) return true;
  }
  return false;
}

// 整棵树在两次采样之间用掉多少 CPU。
//
// 这里刻意不做「动过就算在用」的二值判断：残留的 Playwright 浏览器树里
// 总有后台定时器在跳，cpuDeltaMs 永远 > 0，二值判断会把 14 棵早就没用的
// 浏览器全标成「仍在用 CPU」——看上去像还在干活，实际占用可以忽略不计。
// 换算成占全机 CPU 的百分比，低于 IDLE_CPU_PCT 的按「几乎不动」呈现。
function treeCpuState(pids, byPid, cpuWindowMs, cpuCount) {
  let known = false;
  let deltaMs = 0;
  for (const pid of pids) {
    const proc = byPid.get(pid);
    if (!proc || proc.cpuDeltaMs == null) continue;
    known = true;
    deltaMs += proc.cpuDeltaMs;
  }
  if (!known) return { known: false, idle: false, cpuPct: null, deltaMs: 0 };

  const capacityMs = Number(cpuWindowMs) > 0 ? Number(cpuWindowMs) * Math.max(1, Number(cpuCount) || 1) : 0;
  const cpuPct = capacityMs > 0 ? Math.max(0, (deltaMs / capacityMs) * 100) : null;
  const idle = deltaMs <= IDLE_REQUIRED_MS || (cpuPct != null && cpuPct < IDLE_CPU_PCT);
  return { known: true, idle, cpuPct, deltaMs };
}

function buildCandidate(rootProc, pattern, childrenMap, byPid, now, cpuWindowMs, cpuCount) {
  const pids = subtreePids(rootProc.pid, childrenMap, byPid);
  const bytes = sumBytes(pids, byPid);
  const idleState = treeCpuState(pids, byPid, cpuWindowMs, cpuCount);
  const ageMs = rootProc.startedAt ? Math.max(0, now - rootProc.startedAt) : null;
  const detail = typeof pattern.detail === 'function' ? (pattern.detail(rootProc) || '') : '';

  return {
    rootPid: rootProc.pid,
    // 带上启动时间，执行阶段用 pid+startedAt 双重校验，杜绝 PID 复用误杀。
    rootStartedAt: rootProc.startedAt,
    patternId: pattern.id,
    label: pattern.label,
    detail,
    whatYouLose: pattern.whatYouLose,
    processCount: pids.size,
    pids: Array.from(pids),
    // 每个成员都记下启动时间：执行阶段必须 pid + startedAt 双重核对，
    // 光凭 PID 会在系统回收复用号段时误杀一个刚起来的无关程序。
    members: Array.from(pids)
      .map(pid => byPid.get(pid))
      .filter(Boolean)
      .map(proc => ({
        pid: proc.pid,
        startedAt: proc.startedAt,
        name: proc.name,
        wsBytes: proc.wsBytes,
      }))
      // 先子后父，避免杀掉父进程后子进程被重新挂到别处。
      .sort((a, b) => b.startedAt - a.startedAt),
    wsBytes: bytes.wsBytes,
    privBytes: bytes.privBytes,
    ageMs,
    hasWindow: treeHasWindow(pids, byPid),
    idleKnown: idleState.known,
    idle: idleState.idle,
    cpuPct: idleState.cpuPct,
    commandLine: rootProc.cmd,
  };
}

// 证据链。界面上原样展示，用户不用信我，看这几条自己判断。
function evidenceFor(candidate, ownerLabel) {
  return [
    { ok: true, text: `归属：${ownerLabel}` },
    { ok: !candidate.hasWindow, text: candidate.hasWindow ? '整棵进程树里有可见窗口' : '整棵进程树里没有可见窗口' },
    { ok: true, text: `形态匹配：${candidate.label}` },
    {
      ok: candidate.idleKnown && candidate.idle,
      text: !candidate.idleKnown
        ? '只采了一次样，忙闲未知（再扫一次即可确认）'
        : candidate.cpuPct == null
          ? (candidate.idle ? 'CPU 时间零增长' : '仍在占用 CPU')
          : candidate.idle
            ? `几乎不占 CPU（两次采样之间 ${candidate.cpuPct.toFixed(2)}%）`
            : `仍在占用 CPU（${candidate.cpuPct.toFixed(1)}%），关掉前请确认它不是在干活`,
    },
  ];
}

function buildReclaimReport(input = {}) {
  const snapshot = input.snapshot;
  const now = Number(input.now) || Date.now();
  const aliveHubs = Array.isArray(input.aliveHubs) ? input.aliveHubs : [];
  const deadHubs = Array.isArray(input.deadHubs) ? input.deadHubs : [];
  const selfPid = Number(input.selfPid) || 0;
  // 本实例活跃会话的 pty 顶层 PID。只有当前这个 Hub 报得出来——
  // 别的 Hub 的会话在它们自己内存里，我们看不见，所以下面一律整棵树保护。
  const liveSessionPids = new Set((input.liveSessionPids || []).map(Number).filter(Boolean));
  const liveSessionsKnown = input.liveSessionsKnown === true;

  if (!snapshot || !snapshot.byPid) {
    return {
      ok: false,
      error: 'no-snapshot',
      sampledAt: now,
      groups: { deadHub: [], endedSession: [], unattributed: [], bigConsumer: [] },
    };
  }

  const { byPid, childrenMap, processes } = snapshot;
  const deadHubPids = new Set(deadHubs.map(item => Number(item.pid)).filter(Boolean));

  // 活着的 Hub 必须**从进程表直接认**，不能只信心跳登记表。
  //
  // 心跳文件是按数据目录分的：一个用了 --data-dir 或 CLAUDE_HUB_DATA_DIR 的
  // 实例（开发实例、测试实例）在别的目录下写心跳，当前实例根本读不到它。
  // 如果只按心跳判「谁活着」，那些 Hub 的整棵进程树就会失去保护，
  // 它们的会话外壳会被当成残留列出来——E2E 实测过这个漏洞：
  // 隔离实例跑扫描时保护数从 199 掉到 11，可回收从 112 暴涨到 268。
  //
  // 进程表是全机的，认不出的情况不存在。心跳表只用来判「谁死了」。
  const aliveHubPids = new Set(aliveHubs.map(item => Number(item.pid)).filter(Boolean));
  const aliveHubRoots = [];
  for (const proc of processes) {
    if (!isHubProcess(proc)) continue;
    if (isElectronHelper(proc)) continue;
    // 只取每棵 Hub 树的根，子进程会随整树保护一起覆盖。
    const parent = realParent(proc, byPid);
    if (parent && isHubProcess(parent)) continue;
    aliveHubPids.add(proc.pid);
    aliveHubRoots.push(proc);
  }
  // 心跳里登记为「活」但进程已经不在的，不算数（PID 复用防护在 registry 里做过）。
  for (const pid of Array.from(aliveHubPids)) {
    if (!byPid.has(pid)) aliveHubPids.delete(pid);
  }
  const aliveHubList = Array.from(aliveHubPids).map(pid => {
    const known = aliveHubs.find(item => Number(item.pid) === pid);
    return known || { pid, alive: true, discoveredFrom: 'process-table' };
  });

  // ── 保护区 ─────────────────────────────────────────────────
  const protectedPids = new Set();
  const protectionReasons = new Map();

  function protect(pids, reason) {
    for (const pid of pids) {
      protectedPids.add(pid);
      if (!protectionReasons.has(reason)) protectionReasons.set(reason, new Set());
      protectionReasons.get(reason).add(pid);
    }
  }

  // 自己整棵树，任何情况下都不碰。
  if (selfPid && byPid.has(selfPid)) {
    protect(subtreePids(selfPid, childrenMap, byPid), '当前 Hub 自身');
  }

  for (const hub of aliveHubList) {
    const hubPid = Number(hub.pid);
    if (!byPid.has(hubPid)) continue;
    const tree = subtreePids(hubPid, childrenMap, byPid);
    if (hubPid === selfPid) {
      // 自己这个实例：Hub 零件保护，会话外壳按「是不是活跃会话」区别对待。
      for (const pid of tree) {
        const proc = byPid.get(pid);
        if (!proc) continue;
        if (isHubProcess(proc) || isElectronHelper(proc)) protectedPids.add(pid);
      }
      for (const ptyPid of liveSessionPids) {
        if (byPid.has(ptyPid)) protect(subtreePids(ptyPid, childrenMap, byPid), '本实例活跃会话');
      }
    } else {
      // 别的 Hub：拿不到它的会话名单，无法区分哪个外壳是活的，
      // 所以整棵树一律保护。宁可漏清，不可误杀。
      protect(tree, '其它运行中的 Hub（无法核实其会话，整体保护）');
    }
  }

  // ── 候选残留 ───────────────────────────────────────────────
  const candidatesByRoot = new Map();
  for (const proc of processes) {
    if (protectedPids.has(proc.pid)) continue;
    const pattern = matchLeftoverPattern(proc);
    if (!pattern) continue;
    candidatesByRoot.set(proc.pid, buildCandidate(
      proc, pattern, childrenMap, byPid, now, snapshot.cpuWindowMs, snapshot.cpuCount,
    ));
  }

  // 去重：一个候选如果落在另一个候选的子树里，只保留最外层那个，
  // 免得 Playwright 守护进程和它开的浏览器被拆成两条重复计数。
  const nestedPids = new Set();
  for (const candidate of candidatesByRoot.values()) {
    for (const pid of candidate.pids) {
      if (pid !== candidate.rootPid && candidatesByRoot.has(pid)) nestedPids.add(pid);
    }
  }
  for (const pid of nestedPids) candidatesByRoot.delete(pid);

  // ── 归属判定与分组 ─────────────────────────────────────────
  const groups = { deadHub: [], endedSession: [], unattributed: [], bigConsumer: [] };
  const deadHubBuckets = new Map();

  for (const candidate of candidatesByRoot.values()) {
    if (candidate.hasWindow) continue; // 有窗口的一律不进任何可操作分组

    const rootProc = byPid.get(candidate.rootPid);
    const chain = ancestorChain(rootProc, byPid);
    const chainPids = [rootProc.pid, ...chain.map(item => item.pid)];

    const aliveHubAncestor = chainPids.find(pid => aliveHubPids.has(pid));
    // 孤儿的 ppid 仍然指向已经退出的那个 Hub，靠这个把它认领回去。
    const topMost = chain.length > 0 ? chain[chain.length - 1] : rootProc;
    const deadHubAncestor = [rootProc.ppid, topMost.ppid].find(pid => deadHubPids.has(pid));

    if (aliveHubAncestor === selfPid && liveSessionsKnown) {
      // 归当前实例，且已确认不在活跃会话名单里 → 会话结束没关干净。
      groups.endedSession.push({
        ...candidate,
        group: GROUP_ENDED_SESSION,
        ownerLabel: '当前 Hub，但不属于任何活跃会话',
        evidence: evidenceFor(candidate, '当前 Hub，但不属于任何活跃会话'),
        eligible: candidate.idleKnown && candidate.idle,
      });
      continue;
    }

    if (deadHubAncestor) {
      const hub = deadHubs.find(item => Number(item.pid) === deadHubAncestor);
      if (!deadHubBuckets.has(deadHubAncestor)) {
        deadHubBuckets.set(deadHubAncestor, {
          hubPid: deadHubAncestor,
          lastBeatAt: hub ? hub.lastBeatAt : 0,
          deadReason: hub ? hub.deadReason : 'process-gone',
          items: [],
        });
      }
      const ownerLabel = `已退出的 Hub #${deadHubAncestor}`;
      deadHubBuckets.get(deadHubAncestor).items.push({
        ...candidate,
        group: GROUP_DEAD_HUB,
        ownerLabel,
        evidence: evidenceFor(candidate, ownerLabel),
        eligible: candidate.idleKnown && candidate.idle,
      });
      continue;
    }

    if (!aliveHubAncestor) {
      // 追不到任何在跑的 Hub：要么是记账之前留下的历史遗留，要么派生它的
      // CLI 早退出了。够老才算数，避免把刚起来的东西当垃圾。
      if (candidate.ageMs != null && candidate.ageMs < UNATTRIBUTED_MIN_AGE_MS) continue;
      const ownerLabel = '认不出主人（派生它的会话已无法追溯）';
      groups.unattributed.push({
        ...candidate,
        group: GROUP_UNATTRIBUTED,
        ownerLabel,
        evidence: evidenceFor(candidate, ownerLabel),
        // 这一组永远要用户勾选，不给自动执行资格。
        eligible: false,
      });
    }
  }

  groups.deadHub = Array.from(deadHubBuckets.values())
    .map(bucket => ({
      ...bucket,
      processCount: bucket.items.reduce((sum, item) => sum + item.processCount, 0),
      wsBytes: bucket.items.reduce((sum, item) => sum + item.wsBytes, 0),
    }))
    .sort((a, b) => b.wsBytes - a.wsBytes);
  groups.endedSession.sort((a, b) => b.wsBytes - a.wsBytes);
  groups.unattributed.sort((a, b) => b.wsBytes - a.wsBytes);

  // ── ④ 大户：只展示，永远没有按钮 ───────────────────────────
  const consumerBuckets = new Map();
  for (const proc of processes) {
    if (isSystemProcess(proc)) continue;
    const key = proc.name.toLowerCase();
    if (!consumerBuckets.has(key)) {
      consumerBuckets.set(key, { name: proc.name, count: 0, wsBytes: 0, privBytes: 0, isHub: false });
    }
    const bucket = consumerBuckets.get(key);
    bucket.count += 1;
    bucket.wsBytes += proc.wsBytes || 0;
    bucket.privBytes += proc.privBytes || 0;
    if (isHubProcess(proc)) bucket.isHub = true;
  }
  groups.bigConsumer = Array.from(consumerBuckets.values())
    .sort((a, b) => Math.max(b.wsBytes, b.privBytes) - Math.max(a.wsBytes, a.privBytes))
    .slice(0, 10);

  // ── 汇总 ───────────────────────────────────────────────────
  const reclaimableItems = [
    ...groups.deadHub.flatMap(bucket => bucket.items),
    ...groups.endedSession,
    ...groups.unattributed,
  ];
  const reclaimableBytes = reclaimableItems.reduce((sum, item) => sum + item.wsBytes, 0);
  const reclaimableCount = reclaimableItems.reduce((sum, item) => sum + item.processCount, 0);

  return {
    ok: true,
    sampledAt: snapshot.sampledAt || now,
    totals: {
      processes: snapshot.totalProcesses || processes.length,
      hubAlive: aliveHubList.length,
      hubDead: deadHubs.length,
      protectedCount: protectedPids.size,
      reclaimableBytes,
      reclaimableCount,
      groupCounts: {
        deadHub: groups.deadHub.reduce((sum, bucket) => sum + bucket.items.length, 0),
        endedSession: groups.endedSession.length,
        unattributed: groups.unattributed.length,
      },
    },
    liveSessionsKnown,
    groups,
    protection: {
      count: protectedPids.size,
      reasons: Array.from(protectionReasons.entries())
        .map(([reason, pids]) => ({ reason, count: pids.size }))
        .sort((a, b) => b.count - a.count),
    },
  };
}

module.exports = {
  GROUP_BIG_CONSUMER,
  GROUP_DEAD_HUB,
  GROUP_ENDED_SESSION,
  GROUP_UNATTRIBUTED,
  IDLE_CPU_PCT,
  LEFTOVER_PATTERNS,
  SYSTEM_PROCESS_NAMES,
  UNATTRIBUTED_MIN_AGE_MS,
  ancestorChain,
  treeCpuState,
  buildReclaimReport,
  isElectronHelper,
  isHubProcess,
  isSystemProcess,
  matchLeftoverPattern,
  realParent,
  subtreePids,
};
