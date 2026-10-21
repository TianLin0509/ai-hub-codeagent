'use strict';
// 休眠 CodeAgent 会话后补杀进程树里的残余（2026-10-21，通道会话膨胀回收）。
// 为什么要补：休眠走 node-pty 的 kill()。Windows ConPTY 下它只结束「挂在这个伪终端上」的进程
// （node_modules/node-pty/lib/windowsPtyAgent.js kill：getConsoleProcessList → 逐个 process.kill，再关伪终端）。
// CodeAgent serve 拉起的 MCP 插件里有带独立 conhost 的（cmd/uvx/python/node 链），它们不在这个伪终端的进程列表里，
// 根结束后会变成孤儿继续占内存（公司真机一会话 92 个进程、4.1–4.8 GB，大头就是这些插件）。
// 做法：休眠前从最近一次进程快照取这棵树（PID + 启动时间），根结束后等几秒重新枚举，
// 还活着、且 PID 和启动时间都对得上的，按 PID 结束；树里的进程在快照之后新派生的孩子也一并算上。
// 只按 PID + 启动时间认人，从不按命令行子串匹配（Windows 会复用 PID，启动时间对不上就跳过）。
const { subtreePids } = require('./process-reclaim');
const { buildChildrenMap } = require('./process-inspector');

const START_TOLERANCE_MS = 2000;
const DEFAULT_SWEEP_DELAY_MS = 8000;

function indexSnapshot(snap) {
  const list = (snap && snap.processes || []).filter(p => p && p.pid > 0);
  const byPid = snap && snap.byPid instanceof Map ? snap.byPid : new Map(list.map(p => [p.pid, p]));
  const children = snap && snap.childrenMap instanceof Map ? snap.childrenMap : buildChildrenMap(list);
  return { list, byPid, children };
}

// 快照 + 会话 PTY 根 PID → 整棵树的成员 [{ pid, startedAt, name }]（含根）。根不在快照里返回空。
function captureTree(snap, rootPid) {
  const { byPid, children } = indexSnapshot(snap);
  const root = Number(rootPid);
  if (!(root > 0) || !byPid.has(root)) return [];
  return [...subtreePids(root, children, byPid)].map(pid => {
    const p = byPid.get(pid) || {};
    return { pid, startedAt: Number(p.startedAt) || 0, name: String(p.name || '') };
  });
}

const sameStart = (a, b) => !(a > 0 && b > 0) || Math.abs(a - b) <= START_TOLERANCE_MS;

// 根结束后的新快照里，哪些进程该补杀：
//   1. 原来那棵树的成员，PID 还在且启动时间对得上；
//   2. 父进程是这棵树的成员（不管父进程还在不在）、且启动不早于父进程的——快照之后才派生的孩子，逐层展开。
// protect：绝不碰的 PID（Hub 自己、其他在运行会话的根）。
function residualTargets(before, after, { protect = [] } = {}) {
  const guard = new Set([...(protect || [])].map(Number).filter(n => n > 0));
  const known = new Map((before || []).map(m => [Number(m.pid), Number(m.startedAt) || 0]));
  if (!known.size) return [];
  const { list, byPid } = indexSnapshot(after);
  const targets = new Map();
  for (const p of list) {
    if (guard.has(p.pid) || !known.has(p.pid)) continue;
    if (sameStart(known.get(p.pid), Number(p.startedAt) || 0)) targets.set(p.pid, p);
  }
  // 树成员（原来的 + 已认定的残余）的启动时间：判断「是不是它的孩子」用
  const parentStart = pid => (targets.has(pid) ? Number(targets.get(pid).startedAt) || 0 : known.get(pid));
  let grew = true;
  while (grew) {
    grew = false;
    for (const p of list) {
      if (targets.has(p.pid) || guard.has(p.pid) || !p.ppid) continue;
      if (!known.has(p.ppid) && !targets.has(p.ppid)) continue;
      // 父进程 PID 已被别的新进程复用时，这个「孩子」不是我们的
      const live = byPid.get(p.ppid);
      if (live && !targets.has(p.ppid)) continue;
      const ps = parentStart(p.ppid) || 0, cs = Number(p.startedAt) || 0;
      if (ps > 0 && cs > 0 && cs + START_TOLERANCE_MS < ps) continue;
      targets.set(p.pid, p); grew = true;
    }
  }
  return [...targets.values()].map(p => ({ pid: p.pid, startedAt: Number(p.startedAt) || 0, name: String(p.name || '') }));
}

// inspector：core/process-inspector.js createProcessInspector 的实例（getCached 同步取最近快照，snapshot({ force }) 重新枚举）。
// kill：按 PID 结束，默认 process.kill（Windows 上是 TerminateProcess）。
function createTreeSweeper({ inspector, kill = pid => process.kill(pid), delayMs = DEFAULT_SWEEP_DELAY_MS, protect = () => [process.pid],
  setTimer = (fn, ms) => { const h = setTimeout(fn, ms); if (h && h.unref) h.unref(); return h; }, log = () => {} } = {}) {
  // 休眠前同步调用：从最近一次快照取这棵树。快照里没有根（还没测过、或太旧）就返回空，之后不补杀。
  function capture(rootPid) {
    try { return captureTree(inspector && inspector.getCached && inspector.getCached(), rootPid); } catch { return []; }
  }
  async function sweep(before, label = '') {
    if (!before || !before.length) return { targets: [], killed: [], failed: [] };
    let after;
    try { after = await inspector.snapshot({ force: true }); }
    catch (error) { log(`残余补杀跳过 ${label}：重新枚举进程失败 ${error && error.message || error}`); return { targets: [], killed: [], failed: [], error: String(error && error.message || error) }; }
    let guard = [];
    try { guard = protect() || []; } catch { /* 拿不到就只靠 PID+启动时间 */ }
    const targets = residualTargets(before, after, { protect: guard });
    const killed = [], failed = [];
    for (const t of targets) {
      try { kill(t.pid); killed.push(t); }
      catch (error) { if (error && error.code === 'ESRCH') continue; failed.push({ ...t, error: String(error && error.message || error) }); }
    }
    if (targets.length) log(`残余补杀 ${label}：原树 ${before.length} 个进程，根结束后还剩 ${targets.length} 个，已结束 ${killed.length} 个${failed.length ? `、失败 ${failed.length} 个` : ''}（${killed.slice(0, 8).map(t => `${t.name}#${t.pid}`).join('、')}${killed.length > 8 ? '…' : ''}）`);
    return { targets, killed, failed };
  }
  // 根已经开始结束之后调用：等 delayMs 让 node-pty 和插件自己退出，再补杀残余。
  function schedule(before, label) {
    if (!before || !before.length) return false;
    setTimer(() => { sweep(before, label).catch(() => {}); }, delayMs);
    return true;
  }
  return { capture, sweep, schedule };
}

module.exports = { captureTree, residualTargets, createTreeSweeper, START_TOLERANCE_MS, DEFAULT_SWEEP_DELAY_MS };
