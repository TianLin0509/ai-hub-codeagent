'use strict';
// 界面进程卡住 / 崩溃的真实链路（core/renderer-crash-recovery.js，2026-10-14 公司真机「先卡顿、后黑屏」）。
//   1. 界面线程被一段长时间运行的代码卡住（页面心跳停了）→ window-events.log 记下当时正在跑的
//      代码（调用栈里能看到那个函数名）和界面进程内存。
//   2. 界面内存涨满崩溃（公司记录的 crashed / -36861 就是这种崩溃，打开崩溃转储后记成 oom）→ 约 1 秒后自动重新载入界面，
//      在跑的 PowerShell 会话还在、还能接着输入，页面提示「界面刚才崩溃」，本机留下崩溃转储。
//   3. 卡死自救：界面被一段永远不结束的代码卡死 → 心跳停够秒数后主进程结束界面进程、重新载入，提示「卡住太久」；
//      14 秒、12 秒这种会自己缓过来的卡顿不触发自救。
// 隔离实例、后台窗口；不碰生产 Hub。
const assert = require('assert/strict');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { launchIsolatedHub, gracefulQuit, _waitMs } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');

const j = JSON.stringify;
const freePort = () => new Promise((resolve, reject) => {
  const server = net.createServer();
  server.on('error', reject);
  server.listen(0, '127.0.0.1', () => { const { port } = server.address(); server.close(() => resolve(port)); });
});

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-crash-recovery-'));
  const dataDir = path.join(root, 'data');
  const logFile = path.join(dataDir, 'logs', 'window-events.log');
  const readLog = () => { try { return fs.readFileSync(logFile, 'utf8'); } catch { return ''; } };
  const waitLog = async (re, label, ms) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { const m = readLog().match(re); if (m) return m; await _waitMs(250); }
    throw new Error(`timeout: ${label}\n${readLog().slice(-3000)}`);
  };
  let hub = null;
  let c = null;
  const passed = [];
  const ok = (cond, label, detail) => { assert.ok(cond, label + (detail === undefined ? '' : ' ' + j(detail))); passed.push(label); console.log('  ✓ ' + label); };
  try {
    hub = await launchIsolatedHub({ dataDir, port: await freePort(), label: 'crash-recovery', windowMode: 'background',
      extraEnv: { CLAUDE_HUB_HOME_DIR: path.join(root, 'home'), DEEPSEEK_API_KEY: '', AI_HUB_STALL_RESCUE_SEC: '20' } });
    c = await connectFirstPage(hub);
    const until = async (expr, label, ms = 30000) => {
      const end = Date.now() + ms;
      while (Date.now() < end) { try { if (await c.eval(expr)) return; } catch {} await _waitMs(250); }
      throw new Error('timeout: ' + label);
    };
    await until('typeof sessions !== "undefined" && document.readyState === "complete"', 'renderer ready', 60000);

    const created = await c.eval(`ipcRenderer.invoke('create-session',{kind:'powershell',opts:{cwd:${j(root)}}})`);
    const sid = created.id;
    await until(`sessions.has(${j(sid)})`, 'session in renderer');
    await _waitMs(2500);

    // 1. 卡住：一段跑 14 秒的同步代码。页面心跳停了 6 秒，主进程就去抓调用栈（不依赖键鼠输入）。
    c.send('Runtime.evaluate', { expression: 'setTimeout(function hubProbeStuckRender(){ const t = Date.now(); while (Date.now() - t < 14000) {} }, 50); 1' }).catch(() => {});
    const stackLine = (await waitLog(/ renderer-hang-stack ({.*})/, 'hang stack logged', 30000))[1];
    const stack = JSON.parse(stackLine);
    ok(/hubProbeStuckRender/.test(stack.stack || ''), '卡住时记下界面正在跑的代码（调用栈里有卡住的函数）', stack);
    ok(!/[A-Za-z]:\\|file:\/\/\//.test(stack.stack || ''), '调用栈里不带本机路径', stack.stack);
    const memAtHang = JSON.parse(readLog().match(/ renderer-memory-at-hang (\{.*\})/)[1]);
    ok(memAtHang.now && memAtHang.now.workingSetMB > 0, '卡住时记下界面进程内存', memAtHang.now);
    await waitLog(/ renderer-stall-end /, 'heartbeat resumes', 30000);
    ok(true, '卡住结束后恢复响应');

    // 2. 内存涨满：与公司记录同一种崩溃。
    const before = await c.eval('location.href');
    c.send('Runtime.evaluate', { expression: 'setTimeout(function hubProbeRunawayMemory(){ const keep = []; while (true) keep.push(new Array(1e5).fill(Math.random())); }, 50); 1' }).catch(() => {});
    const gone = JSON.parse((await waitLog(/ render-process-gone (\{.*\})/, 'renderer gone', 60000))[1]);
    // 打开崩溃转储后 Chromium 能认出这是内存耗尽（oom / 0xE0000008）；没开时同一种崩溃记成 crashed / -36861（公司记录）。
    ok(gone.reason === 'oom' && gone.exitCode === -536870904, '内存涨满后界面进程崩溃，日志认出是内存耗尽（oom）', gone);
    await waitLog(/ renderer-recover \{/, 'auto recover', 15000);
    try { c.close(); } catch {}
    c = null;
    const end = Date.now() + 60000;
    for (;;) {
      try { c = await connectFirstPage(hub); if (await c.eval('typeof sessions !== "undefined" && document.readyState === "complete"')) break; } catch {}
      try { c && c.close(); } catch {}
      c = null;
      if (Date.now() > end) throw new Error('page did not come back');
      await _waitMs(500);
    }
    const after = await c.eval('location.href');
    ok(/[?&]recovered=(oom|crashed)/.test(after) && after.split('?')[0] === before.split('?')[0], '崩溃约 1 秒后自动重新载入同一个界面', { before, after });
    await until(`sessions.has(${j(sid)})`, 'session restored', 30000);
    const restored = await c.eval(`(() => { const s = sessions.get(${j(sid)}); return { kind: s.kind, status: s.status }; })()`);
    ok(restored.kind === 'powershell' && restored.status !== 'dormant' && restored.status !== 'ended', '在跑的 PowerShell 会话还在（没有变成休眠）', restored);
    const main = await c.eval(`ipcRenderer.invoke('get-sessions').then(list => list.some(s => s.id === ${j(sid)}))`);
    ok(main, '主进程里的会话没有受影响');
    await until(`(document.getElementById('gc-fork-toast')?.textContent || '').includes('界面刚才崩溃')`, 'toast', 15000);
    ok(true, '页面提示「界面刚才崩溃，已自动重新载入」');

    // 崩溃后会话还能接着用：打开会话、输入命令、在终端里看到输出。
    await c.eval(`selectSession(${j(sid)})`);
    await _waitMs(800);
    await c.eval(`ipcRenderer.send('terminal-input',{sessionId:${j(sid)},data:'echo AFTER-CRASH-OK\\r'})`);
    await until(`(() => { const t = terminalCache.get(${j(sid)})?.terminal; if (!t) return false; const b = t.buffer.active; let s = ''; for (let i = 0; i < b.length; i++) s += b.getLine(i)?.translateToString(true) + '\\n'; return /AFTER-CRASH-OK\\s*\\n.*AFTER-CRASH-OK/s.test(s) || (s.match(/AFTER-CRASH-OK/g) || []).length >= 2; })()`, 'terminal echo after recover', 20000);
    ok(true, '恢复后会话能接着输入，终端里看到输出');

    // 重新载入后的页面照样能抓到卡住时的代码（主进程在重新载入前重新补了页面声明）。
    c.send('Runtime.evaluate', { expression: 'setTimeout(function hubProbeStuckAfterRecover(){ const t = Date.now(); while (Date.now() - t < 12000) {} }, 50); 1' }).catch(() => {});
    await waitLog(/ renderer-hang-stack \{[^\n]*hubProbeStuckAfterRecover/, 'hang stack after recover', 30000);
    ok(true, '恢复后的界面卡住时同样能记下正在跑的代码');
    await waitLog(/ renderer-stall-end [\s\S]* renderer-stall-end /, 'second stall end', 30000);
    ok(!/ renderer-stall-rescue /.test(readLog()), '14 秒、12 秒自己缓过来的卡顿没有触发自救');

    // 3. 卡死：永远不结束的代码。心跳停 20 秒（测试里调短）后主进程结束界面进程并重新载入。
    const stuckAt = Date.now();
    c.send('Runtime.evaluate', { expression: 'setTimeout(function hubProbeStuckForever(){ for(;;){} }, 50); 1' }).catch(() => {});
    const rescue = JSON.parse((await waitLog(/ renderer-stall-rescue (\{.*\})/, 'stall rescue', 60000))[1]);
    ok(rescue.silentMs >= 20000 && Date.now() - stuckAt < 40000, '卡死约 20 秒后主进程出手自救', { rescue, waitedMs: Date.now() - stuckAt });
    ok(/ renderer-hang-stack \{[^\n]*hubProbeStuckForever/.test(readLog()), '自救前先记下了卡死的代码');
    await waitLog(/ renderer-recover \{"reason":"stall"/, 'recover as stall', 15000);
    try { c.close(); } catch {}
    c = null;
    const end2 = Date.now() + 60000;
    for (;;) {
      try { c = await connectFirstPage(hub); if (await c.eval('typeof sessions !== "undefined" && document.readyState === "complete" && location.search.includes("recovered=stall")')) break; } catch {}
      try { c && c.close(); } catch {}
      c = null;
      if (Date.now() > end2) throw new Error('page did not come back after stall rescue');
      await _waitMs(500);
    }
    await until(`sessions.has(${j(sid)}) && sessions.get(${j(sid)}).status !== 'dormant'`, 'session after stall rescue', 30000);
    await until(`(document.getElementById('gc-fork-toast')?.textContent || '').includes('卡住太久')`, 'stall toast', 15000);
    ok(true, '卡死自救后界面回来了，会话还在，提示「界面卡住太久没有响应」');

    const memAtGone = JSON.parse(readLog().match(/ renderer-memory-at-gone (\{.*\})/)[1]);
    ok(Array.isArray(memAtGone.recent), '崩溃时记下最近的界面内存记录', memAtGone);
    const reports = path.join(dataDir, 'electron-userdata', 'Crashpad', 'reports');
    const dumpEnd = Date.now() + 15000;
    let dumps = [];
    while (Date.now() < dumpEnd) { try { dumps = fs.readdirSync(reports).filter(f => f.endsWith('.dmp')); } catch {} if (dumps.length) break; await _waitMs(500); }
    ok(dumps.length > 0, '本机留下崩溃转储（不上传）', { reports, dumps });
    console.log(`\nPASS ${passed.length} checks`);
  } catch (error) {
    console.error('FAIL', error && error.stack || error);
    process.exitCode = 1;
  } finally {
    try { c && c.close(); } catch {}
    if (hub) await gracefulQuit(hub, { allowAlreadyExited: true }).catch(error => console.warn('quit:', error.message));
  }
})();
