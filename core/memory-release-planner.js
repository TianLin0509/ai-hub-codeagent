'use strict';

// 「释放内存」面板的清单生成（纯函数）。把全机进程按「属于谁」归类，而不是按进程名：
//   - Hub 会话：会话终端进程（pty）整棵子树，标题来自各 Hub 窗口写出的会话清单
//   - Hub 窗口：Hub 主进程树里不属于任何会话的部分（界面、GPU、会话搜索索引等）
//   - 残留：沿用 process-reclaim 的判据（已退出 Hub / 已结束会话留下的已知残留）
//   - 无主 CLI：Hub 已退出、父进程已不在的 claude/codex 会话进程
//   - 其他程序：按程序（脚本宿主按脚本）合并，只展示
// 每项给出档位：safe 可放心结束 / suspend 可休眠会话（保留记录） / info 只展示。

const path = require('path');
const {
  isHubProcess, isElectronHelper, isSystemProcess, realParent, ancestorChain, subtreePids, treeCpuState,
} = require('./process-reclaim.js');

const TIER_ORDER = { safe: 0, suspend: 1, info: 2 };
const DEFAULT_SELECT_IDLE_MS = 60 * 60 * 1000;
const MIN_OTHER_BYTES = 40 * 1024 * 1024;
const MAX_OTHER_ROWS = 12;

const APP_NAMES = {
  'chrome.exe': 'Chrome', 'msedge.exe': 'Edge', 'msedgewebview2.exe': 'Edge WebView（微信、Office 等内嵌网页）',
  'quark.exe': '夸克', 'weixin.exe': '微信', 'wechat.exe': '微信', 'wechatappex.exe': '微信小程序/内置网页',
  'code.exe': 'VS Code', 'explorer.exe': '资源管理器', 'powerpnt.exe': 'PowerPoint', 'winword.exe': 'Word',
  'excel.exe': 'Excel', 'claude.exe': 'Claude Code', 'codex.exe': 'Codex', 'clash-verge.exe': 'Clash Verge',
  'verge-mihomo.exe': 'Clash 内核', 'firefox.exe': 'Firefox', 'qq.exe': 'QQ', 'dingtalk.exe': '钉钉',
};
const SCRIPT_HOSTS = new Set(['python.exe', 'pythonw.exe', 'node.exe', 'powershell.exe', 'pwsh.exe', 'cmd.exe', 'java.exe', 'javaw.exe']);
const CLI_NAMES = new Set(['claude.exe', 'codex.exe']);

function lower(value) { return String(value || '').toLowerCase(); }

function splitArgs(cmd) {
  const out = [];
  const re = /"([^"]*)"|(\S+)/g;
  let m;
  while ((m = re.exec(String(cmd || '')))) out.push(m[1] != null ? m[1] : m[2]);
  return out;
}

function shortPath(file) {
  const parts = String(file || '').split(/[\\/]+/).filter(Boolean);
  return parts.slice(-2).join('/');
}

// 脚本宿主进程显示它跑的是什么，而不是一个光秃秃的 python.exe。
function describeScript(proc) {
  const name = lower(proc.name);
  const args = splitArgs(proc.cmd).slice(1);
  if (name === 'python.exe' || name === 'pythonw.exe') {
    const m = args.indexOf('-m');
    if (m >= 0 && args[m + 1]) return `Python · ${args.slice(m + 1, m + 3).join(' ')}`;
    const script = args.find(a => /\.pyw?$/i.test(a));
    return script ? `Python · ${shortPath(script)}` : 'Python';
  }
  if (name === 'node.exe') {
    const script = args.find(a => /\.(c|m)?js$/i.test(a) && !a.startsWith('-'));
    return script ? `Node · ${shortPath(script)}` : 'Node';
  }
  if (name === 'powershell.exe' || name === 'pwsh.exe') {
    const f = args.findIndex(a => /^-file$/i.test(a));
    return f >= 0 && args[f + 1] ? `PowerShell · ${shortPath(args[f + 1])}` : 'PowerShell';
  }
  if (name === 'java.exe' || name === 'javaw.exe') {
    const jar = args.find(a => /\.jar$/i.test(a));
    return jar ? `Java · ${shortPath(jar)}` : 'Java';
  }
  return 'cmd';
}

function appLabel(proc) {
  const name = lower(proc.name);
  if (name === 'claude.exe' && /--chrome-native-host/.test(proc.cmd)) return 'Claude 浏览器扩展桥接';
  if (SCRIPT_HOSTS.has(name)) return describeScript(proc);
  return APP_NAMES[name] || proc.name.replace(/\.exe$/i, '');
}

// Hub 进程树里的辅助进程归类，让「Hub 窗口」那一行能拆开看。
function hubPartLabel(proc) {
  const cmd = String(proc.cmd || '');
  if (/session-search-child\.js/i.test(cmd)) return '会话搜索索引';
  const type = /--type=([\w-]+)/.exec(cmd);
  if (type) return { renderer: '界面渲染', 'gpu-process': 'GPU 绘制', utility: '网络与工具服务', crashpad: '崩溃上报' }[type[1]] || `Electron ${type[1]}`;
  if (isHubProcess(proc)) return 'Hub 主进程';
  return appLabel(proc);
}

function sessionIdsInCmd(cmd) {
  return String(cmd || '').match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi) || [];
}

function membersOf(pids, byPid) {
  return [...pids].map(pid => byPid.get(pid)).filter(Boolean)
    .map(p => ({ pid: p.pid, startedAt: p.startedAt, name: p.name, wsBytes: p.wsBytes || 0 }))
    .sort((a, b) => b.startedAt - a.startedAt);
}

function sumWs(pids, byPid) {
  let total = 0;
  for (const pid of pids) total += byPid.get(pid)?.wsBytes || 0;
  return total;
}

function formatIdle(ms) {
  const minutes = Math.floor((Number(ms) || 0) / 60_000);
  if (minutes < 1) return '刚刚有活动';
  if (minutes < 60) return `空闲 ${minutes} 分钟`;
  const hours = minutes / 60;
  return hours < 48 ? `空闲 ${hours.toFixed(hours < 10 ? 1 : 0)} 小时` : `空闲 ${Math.round(hours / 24)} 天`;
}

function cliKindLabel(kind) {
  const base = lower(kind).replace(/-resume$/, '');
  return { claude: 'Claude Code', codex: 'Codex', gemini: 'Gemini', kimi: 'Kimi', powershell: 'PowerShell' }[base] || (kind || '会话');
}

function sessionBlockText(session) {
  if (session.running) return '正在回答，不能休眠';
  if (session.focused) return '你正在看的会话';
  if (session.meetingId) return '群聊成员，请在群聊里整体休眠';
  if (session.blockReason === 'recently-active') return '10 分钟内有活动';
  return session.blockMessage || '暂不能休眠';
}

function buildMemoryReleasePlan(input = {}) {
  const snapshot = input.snapshot;
  const now = Number(input.now) || Date.now();
  const selfPid = Number(input.selfPid) || 0;
  const manifests = input.manifests instanceof Map ? input.manifests : new Map();
  const reclaim = input.reclaimReport || null;
  const memory = input.memory || {};
  if (!snapshot || !snapshot.byPid) return { ok: false, error: 'no-snapshot', items: [] };
  const { byPid, childrenMap, processes } = snapshot;
  const assigned = new Set();
  const items = [];
  const take = pids => { const out = new Set(); for (const pid of pids) if (!assigned.has(pid)) { out.add(pid); assigned.add(pid); } return out; };

  // ① 已知残留（沿用 process-reclaim 的判据与安全护栏）
  const leftovers = reclaim && reclaim.ok
    ? [...(reclaim.groups?.deadHub || []).flatMap(b => b.items || []), ...(reclaim.groups?.endedSession || [])]
    : [];
  for (const c of leftovers) {
    const pids = take(c.pids || []);
    if (!pids.size) continue;
    items.push({
      key: `leftover:${c.rootPid}:${c.rootStartedAt}`,
      kind: 'leftover',
      tier: c.eligible ? 'safe' : 'info',
      title: `${c.label}${c.detail ? ` ${c.detail}` : ''}`,
      subtitle: c.ownerLabel || '',
      note: c.eligible ? (c.whatYouLose || '') : '还在使用 CPU，暂不建议结束',
      wsBytes: sumWs(pids, byPid),
      processCount: pids.size,
      members: membersOf(pids, byPid),
      selected: !!c.eligible,
    });
  }

  // ② Hub 窗口与其会话
  // 认 Hub 窗口：按路径特征，或它就是本进程 / 写了会话清单的进程（开发副本不在生产路径下）。
  const looksLikeHub = p => !!p && (isHubProcess(p) || p.pid === selfPid || manifests.has(p.pid)) && !isElectronHelper(p);
  const hubRoots = processes.filter(p => looksLikeHub(p) && !looksLikeHub(realParent(p, byPid)));
  for (const hub of hubRoots) {
    const hubTree = subtreePids(hub.pid, childrenMap, byPid);
    const manifest = manifests.get(hub.pid);
    const isSelf = hub.pid === selfPid;
    const hubName = isSelf ? '当前 Hub 窗口' : `另一个 Hub 窗口 PID ${hub.pid}`;
    if (manifest) {
      const sessionsByNative = new Map();
      for (const s of manifest.sessions) if (s.nativeId) sessionsByNative.set(lower(s.nativeId), s);
      const claimed = new Map();
      for (const s of manifest.sessions) {
        if (s.ptyPid && hubTree.has(s.ptyPid)) claimed.set(s.id, { session: s, pids: subtreePids(s.ptyPid, childrenMap, byPid) });
      }
      // 终端 PID 对不上时，按命令行里的会话编号认领 CLI 进程。
      for (const pid of hubTree) {
        const proc = byPid.get(pid);
        if (!proc || !CLI_NAMES.has(lower(proc.name))) continue;
        if ([...claimed.values()].some(entry => entry.pids.has(pid))) continue;
        const s = sessionIdsInCmd(proc.cmd).map(id => sessionsByNative.get(lower(id))).find(Boolean);
        if (s && !claimed.has(s.id)) claimed.set(s.id, { session: s, pids: subtreePids(pid, childrenMap, byPid) });
      }
      for (const { session: s, pids: tree } of claimed.values()) {
        const pids = take(tree);
        if (!pids.size) continue;
        const suspendable = s.suspendable === true;
        items.push({
          key: `session:${hub.pid}:${s.id}`,
          kind: 'session',
          tier: suspendable ? 'suspend' : 'info',
          title: s.title || '未命名会话',
          subtitle: [cliKindLabel(s.kind), s.nativeId ? `会话 ${String(s.nativeId).slice(0, 8)}` : '', hubName].filter(Boolean).join(' · '),
          status: suspendable ? formatIdle(s.idleMs) : sessionBlockText(s),
          note: suspendable ? '休眠：关掉进程、保留聊天记录，点这个会话即可恢复' : '',
          hubPid: hub.pid,
          sessionId: s.id,
          idleMs: s.idleMs,
          pinned: s.pinned === true,
          wsBytes: sumWs(pids, byPid),
          processCount: pids.size,
          members: membersOf(pids, byPid),
          selected: suspendable && !s.pinned && Number(s.idleMs) >= DEFAULT_SELECT_IDLE_MS,
        });
      }
    }
    const rest = take(hubTree);
    if (!rest.size) continue;
    const parts = new Map();
    for (const pid of rest) {
      const proc = byPid.get(pid);
      const label = hubPartLabel(proc);
      parts.set(label, (parts.get(label) || 0) + (proc.wsBytes || 0));
    }
    items.push({
      key: `hub:${hub.pid}:${hub.startedAt}`,
      kind: 'hub',
      tier: 'info',
      title: manifest ? `AI Hub · ${hubName}` : `AI Hub · ${hubName}（看不到会话状态）`,
      subtitle: manifest?.appVersion ? `v${manifest.appVersion}` : (manifest ? '' : '旧版本或使用了其他数据目录，会话合并显示在这一行'),
      status: isSelf ? '你正在用的窗口' : '',
      parts: [...parts.entries()].map(([label, wsBytes]) => ({ label, wsBytes })).sort((a, b) => b.wsBytes - a.wsBytes).slice(0, 6),
      wsBytes: sumWs(rest, byPid),
      processCount: rest.size,
      selected: false,
    });
  }

  // ③ 无主 CLI：父进程已不在、也不在任何 Hub 树下的 claude/codex 会话进程。
  for (const proc of processes) {
    if (assigned.has(proc.pid) || !CLI_NAMES.has(lower(proc.name))) continue;
    if (/--chrome-native-host/.test(proc.cmd) || realParent(proc, byPid)) continue;
    if (ancestorChain(proc, byPid).some(isHubProcess)) continue;
    // 只认带会话编号、整棵树没有窗口的 CLI 会话进程：Claude/Codex 桌面版同名，
    // 资源管理器重启后它们的父进程也会「不在」，但它们有窗口、命令行里没有会话编号。
    const tree = subtreePids(proc.pid, childrenMap, byPid);
    if (!sessionIdsInCmd(proc.cmd).length || [...tree].some(pid => byPid.get(pid)?.hasWindow)) continue;
    const pids = take(tree);
    const cpu = treeCpuState(pids, byPid, snapshot.cpuWindowMs, snapshot.cpuCount);
    const idle = cpu.known && cpu.idle;
    const ids = sessionIdsInCmd(proc.cmd);
    items.push({
      key: `orphan:${proc.pid}:${proc.startedAt}`,
      kind: 'orphan',
      tier: idle ? 'safe' : 'info',
      title: `无人接管的 ${APP_NAMES[lower(proc.name)]} 进程`,
      subtitle: ids[0] ? `会话 ${ids[0].slice(0, 8)} · 启动它的窗口已关闭` : '启动它的窗口已关闭',
      note: idle ? '没有任何窗口能再操作它；会话记录在磁盘上，可在 Hub 里重新打开' : '仍在使用 CPU，可能还在执行，暂不建议结束',
      wsBytes: sumWs(pids, byPid),
      processCount: pids.size,
      members: membersOf(pids, byPid),
      selected: idle,
    });
  }

  // ④ 其他程序：只展示。
  const others = new Map();
  for (const proc of processes) {
    if (assigned.has(proc.pid) || isSystemProcess(proc)) continue;
    const label = appLabel(proc);
    const row = others.get(label) || { label, wsBytes: 0, count: 0 };
    row.wsBytes += proc.wsBytes || 0;
    row.count += 1;
    others.set(label, row);
  }
  [...others.values()].filter(r => r.wsBytes >= MIN_OTHER_BYTES).sort((a, b) => b.wsBytes - a.wsBytes).slice(0, MAX_OTHER_ROWS)
    .forEach(r => items.push({
      key: `app:${r.label}`, kind: 'app', tier: 'info', title: r.label,
      subtitle: r.count > 1 ? `${r.count} 个进程` : '', status: '不由 Hub 管理', wsBytes: r.wsBytes, processCount: r.count, selected: false,
    }));

  items.sort((a, b) => (TIER_ORDER[a.tier] - TIER_ORDER[b.tier]) || (b.wsBytes - a.wsBytes));
  const totalBytes = Number(memory.totalBytes) || 0;
  const freeBytes = Number(memory.freeBytes) || 0;
  const sumTier = tier => items.filter(i => i.tier === tier).reduce((s, i) => s + i.wsBytes, 0);
  return {
    ok: true,
    sampledAt: snapshot.sampledAt || now,
    memory: { totalBytes, freeBytes, usedBytes: Math.max(0, totalBytes - freeBytes), usedPct: totalBytes ? Math.round((1 - freeBytes / totalBytes) * 100) : null },
    totals: {
      safeBytes: sumTier('safe'),
      suspendBytes: sumTier('suspend'),
      selectedBytes: items.filter(i => i.selected).reduce((s, i) => s + i.wsBytes, 0),
      hubWindows: hubRoots.length,
      hubWindowsWithoutManifest: hubRoots.filter(h => !manifests.has(h.pid)).length,
    },
    items,
  };
}

module.exports = { buildMemoryReleasePlan, describeScript, appLabel, sessionIdsInCmd, formatIdle, DEFAULT_SELECT_IDLE_MS };
