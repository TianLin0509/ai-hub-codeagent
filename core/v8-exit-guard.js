'use strict';
// 退出时避开 Node 平台关闭的竞态（2026-10-18，v2.1.9 升级验收里关闭后崩溃 0x80000003 的根因）。
//
// 崩溃转储（34 MB，Electron 41.2.0 官方符号）里两条线程：
//   主线程   ~JavascriptEnvironment → ~NodePlatform → NodePlatform::Shutdown → WorkerThreadsTaskRunner::Shutdown（等后台线程退出）
//   V8Worker MemoryPool::ReleasePooledChunksTask → PostDelayedReleaseTask → NodePlatform::PostDelayedTaskOnWorkerThread
//            → DelayedTaskScheduler::PostDelayedTask → uv_async_send → uv_fatal_error → 断点
// 即：V8 销毁主 isolate 时把整堆的页放进「内存池」，若距上次排过「8 秒后归还内存」任务已超过 12 秒，就立刻排一个；
// 后台线程跑这个任务时又排下一个，而这时 Node 的延时任务调度线程已经停了、事件循环已关 → libuv 致命错误。
// 这是 Node 的已知缺陷（nodejs/node#56645，修复 nodejs/node#61999：Stop 之后的 PostDelayedTask 直接丢弃），
// Electron 41.2.0 带的 Node 24.14.0 还没有这个修复；换运行时之前在应用这边绕开。
//
// 做法：退出前（JS 还活着、平台还在）主动让内存池「刚排过任务」——分配一个只活一瞬的大对象再做一次新生代 GC，
// 它的页会被放进内存池；若计时已过期就当场排任务，这个任务在平台关闭前早已跑完。之后 12 秒内销毁 isolate 时，
// V8 看到计时还新鲜，就不会在关闭途中再排任务，竞态窗口随之消失。只是一次很小的 GC（毫秒级），不改任何数据。
const v8 = require('v8');
const vm = require('vm');

// 超过 V8 普通对象上限（128 KB）的数组会进新生代大对象空间；它死后的页在 GC 时进内存池并触发「需要时排任务」。
const LARGE_ELEMENTS = 96 * 1024;

let gcFn = null;
function resolveGc({ v8Ref = v8, vmRef = vm, globalRef = globalThis } = {}) {
  if (gcFn) return gcFn;
  if (typeof globalRef.gc === 'function') { gcFn = globalRef.gc; return gcFn; }
  try {
    // Electron 主进程带 --no-freeze-flags-after-init，运行时打开 expose-gc 是允许的；只对之后新建的上下文生效。
    v8Ref.setFlagsFromString('--expose-gc');
    const fn = vmRef.runInNewContext('gc');
    if (typeof fn === 'function') gcFn = fn;
  } catch (_) { gcFn = null; }
  return gcFn;
}

// 返回 { ok, ms, error? }。任何失败都只记一笔，不挡退出。
function primeV8MemoryPoolForExit({ gc = null, now = () => Date.now(), elements = LARGE_ELEMENTS } = {}) {
  const started = now();
  const run = gc || resolveGc();
  if (typeof run !== 'function') return { ok: false, ms: 0, error: 'gc unavailable' };
  try {
    let scratch = new Array(elements).fill(0);
    scratch[0] = scratch.length;
    scratch = null;
    try { run({ type: 'minor', execution: 'sync' }); }
    catch (_) { run(); }
    return { ok: true, ms: now() - started };
  } catch (error) {
    return { ok: false, ms: now() - started, error: String(error && error.message || error).slice(0, 200) };
  }
}

module.exports = { LARGE_ELEMENTS, primeV8MemoryPoolForExit, resolveGc, _reset: () => { gcFn = null; } };
