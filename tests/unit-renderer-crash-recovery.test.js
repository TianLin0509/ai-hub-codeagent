'use strict';
// core/renderer-crash-recovery.js：崩溃后自动重新载入（防循环上限）、卡住时取调用栈、只给主页面补响应头。
const assert = require('assert/strict');
const { EventEmitter } = require('events');
const path = require('path');
const url = require('url');
const {
  installRendererCrashRecovery, installHangStackOptIn, shortenStack,
  RECOVER_MAX, RECOVER_WINDOW_MS, STALL_MS, RESCUE_STALL_MS, HEARTBEAT_CHANNEL, HANG_STACK_POLICY,
} = require('../core/renderer-crash-recovery.js');

function fakeWindow() {
  const win = new EventEmitter();
  const contents = new EventEmitter();
  contents.loaded = [];
  contents.loadURL = u => contents.loaded.push(u);
  contents.getOSProcessId = () => 42;
  contents.isCrashed = () => false;
  contents.killed = 0;
  contents.forcefullyCrashRenderer = () => { contents.killed += 1; };
  contents.mainFrame = { collectJavaScriptCallStack: async () => '\n    at renderCard (file:///C:/Users/x/AppData/Local/Programs/AI%20Hub/resources/app.asar/renderer/renderer.js:12:3)' };
  win.webContents = contents;
  win.isDestroyed = () => false;
  win.isVisible = () => true;
  win.isMinimized = () => false;
  return win;
}

function harness(opts = {}) {
  const win = fakeWindow();
  const ipcMain = new EventEmitter();
  const logs = [];
  const reloads = [];
  const timers = [];
  const intervals = [];
  let t = 1_000_000;
  const app = { getAppMetrics: () => [{ pid: 42, memory: { workingSetSize: 2100 * 1024, privateBytes: 1800 * 1024 } }] };
  installRendererCrashRecovery(win, {
    app, ipcMain,
    log: (event, detail) => logs.push({ event, detail }),
    reload: info => reloads.push(info),
    now: () => t,
    setTimeoutFn: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    setIntervalFn: (fn, ms) => { intervals.push({ fn, ms }); return { unref() {} }; },
    clearIntervalFn: () => {},
    ...opts,
  });
  const runTimers = () => { while (timers.length) timers.shift().fn(); };
  return { win, ipcMain, logs, reloads, timers, intervals, runTimers, advance: ms => { t += ms; }, get now() { return t; } };
}

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('crash reloads the page once after a delay, not inside the event', () => {
  const h = harness();
  h.win.webContents.emit('render-process-gone', {}, { reason: 'oom', exitCode: -536870904 });
  assert.equal(h.reloads.length, 0, 'not synchronous');
  assert.equal(h.timers.length, 1);
  assert.ok(h.timers[0].ms >= 500);
  h.runTimers();
  assert.deepEqual(h.reloads.map(r => r.reason), ['oom']);
  assert.ok(h.logs.some(l => l.event === 'renderer-memory-at-gone' && l.detail.exitCode === -536870904));
  assert.ok(h.logs.some(l => l.event === 'renderer-recover'));
});

test('crashed -36861 (company record) is recovered too; clean exit and launch failure are not', () => {
  const h = harness();
  h.win.webContents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: -36861 });
  h.runTimers();
  h.win.webContents.emit('render-process-gone', {}, { reason: 'clean-exit', exitCode: 0 });
  h.win.webContents.emit('render-process-gone', {}, { reason: 'launch-failed', exitCode: 57 });
  h.runTimers();
  assert.equal(h.reloads.length, 1);
});

test(`at most ${RECOVER_MAX} recoveries in 10 minutes, then a static page instead of a loop`, () => {
  const h = harness();
  for (let i = 0; i < RECOVER_MAX; i++) {
    h.win.webContents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: -36861 });
    h.runTimers();
    h.advance(30_000);
  }
  assert.equal(h.reloads.length, RECOVER_MAX);
  h.win.webContents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: -36861 });
  h.runTimers();
  assert.equal(h.reloads.length, RECOVER_MAX, 'no further reload');
  assert.equal(h.win.webContents.loaded.length, 1);
  assert.match(decodeURIComponent(h.win.webContents.loaded[0]), /界面连续崩溃/);
  assert.ok(h.logs.some(l => l.event === 'renderer-recover-gave-up'));
  // 窗口期过了以后又能自动恢复
  h.advance(RECOVER_WINDOW_MS);
  h.win.webContents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: -36861 });
  h.runTimers();
  assert.equal(h.reloads.length, RECOVER_MAX + 1);
});

test('disabled: logs the crash but does not reload', () => {
  const h = harness({ enabled: false });
  h.win.webContents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: -36861 });
  h.runTimers();
  assert.equal(h.reloads.length, 0);
  assert.ok(h.logs.some(l => l.event === 'renderer-memory-at-gone'));
});

test('memory samples cross 1/2 GB marks once and ride along with the hang record', async () => {
  const h = harness();
  const sampler = h.intervals[0];
  sampler.fn(); sampler.fn();
  const marks = h.logs.filter(l => l.event === 'renderer-memory').map(l => l.detail.overMB);
  assert.deepEqual(marks, [1024, 2048]);
  h.win.emit('unresponsive');
  const hang = h.logs.find(l => l.event === 'renderer-memory-at-hang');
  assert.equal(hang.detail.source, 'unresponsive');
  assert.equal(hang.detail.recent.length, 2);
  assert.equal(hang.detail.now.workingSetMB, 2100);
});

test('unresponsive captures the running JS stack without local paths', async () => {
  const h = harness();
  h.win.emit('unresponsive');
  await new Promise(r => setImmediate(r));
  const stack = h.logs.find(l => l.event === 'renderer-hang-stack');
  assert.ok(stack, 'stack logged');
  assert.match(stack.detail.stack, /renderCard \(renderer\/renderer\.js:12:3\)/);
  assert.doesNotMatch(stack.detail.stack, /Users|file:/);
});

test(`heartbeat silent > ${STALL_MS / 1000}s while visible counts as a hang; hidden or minimized does not`, async () => {
  const h = harness();
  const stall = h.intervals.find(i => i.ms === 2000);
  const beat = state => h.ipcMain.emit(HEARTBEAT_CHANNEL, { sender: h.win.webContents }, state);
  beat('hidden');
  h.advance(STALL_MS + 1000); stall.fn();
  assert.ok(!h.logs.some(l => l.event === 'renderer-memory-at-hang'), 'hidden page is not a hang');
  beat('visible');
  h.win.isMinimized = () => true;
  h.advance(STALL_MS + 1000); stall.fn();
  assert.ok(!h.logs.some(l => l.event === 'renderer-memory-at-hang'), 'minimized window is not a hang');
  h.win.isMinimized = () => false;
  beat('visible');
  h.advance(STALL_MS - 1000); stall.fn();
  assert.ok(!h.logs.some(l => l.event === 'renderer-memory-at-hang'), 'below threshold');
  h.advance(2000); stall.fn();
  await new Promise(r => setImmediate(r));
  const hang = h.logs.find(l => l.event === 'renderer-memory-at-hang');
  assert.equal(hang.detail.source, 'heartbeat');
  assert.ok(h.logs.some(l => l.event === 'renderer-hang-stack'));
  beat('visible');
  assert.ok(h.logs.some(l => l.event === 'renderer-stall-end'));
  // 别的窗口的心跳不算
  h.ipcMain.emit(HEARTBEAT_CHANNEL, { sender: {} }, 'visible');
});

test(`stall rescue: heartbeat silent ${RESCUE_STALL_MS / 1000}s ends the stuck renderer and reloads it as "stall"`, async () => {
  const h = harness();
  const stall = h.intervals.find(i => i.ms === 2000);
  const beat = state => h.ipcMain.emit(HEARTBEAT_CHANNEL, { sender: h.win.webContents }, state);
  const tick = ms => { for (let left = ms; left > 0; left -= 2000) { h.advance(Math.min(2000, left)); stall.fn(); } };
  beat('visible');
  tick(STALL_MS + 2000);
  assert.ok(h.logs.some(l => l.event === 'renderer-memory-at-hang'), 'hang noticed first');
  assert.equal(h.win.webContents.killed, 0, 'not rescued at the hang threshold');
  // 卡住以后用户最小化窗口，照样计时
  h.win.isMinimized = () => true;
  tick(RESCUE_STALL_MS - STALL_MS - 4000);
  assert.equal(h.win.webContents.killed, 0, 'still waiting below the rescue threshold');
  tick(4000);
  assert.equal(h.win.webContents.killed, 1, 'stuck renderer ended');
  assert.ok(h.logs.some(l => l.event === 'renderer-stall-rescue' && l.detail.silentMs >= RESCUE_STALL_MS));
  tick(4000);
  assert.equal(h.win.webContents.killed, 1, 'only once');
  h.win.webContents.emit('render-process-gone', {}, { reason: 'killed', exitCode: 1 });
  h.runTimers();
  assert.deepEqual(h.reloads.map(r => r.reason), ['stall']);
  assert.ok(h.logs.some(l => l.event === 'renderer-memory-at-gone' && l.detail.reason === 'stall' && l.detail.gone === 'killed'));
});

test('stall rescue ignores time the main process itself was not running (sleep / main busy)', () => {
  const h = harness();
  const stall = h.intervals.find(i => i.ms === 2000);
  h.ipcMain.emit(HEARTBEAT_CHANNEL, { sender: h.win.webContents }, 'visible');
  stall.fn();
  h.advance(10 * 60 * 1000); stall.fn();   // 电脑睡了 10 分钟，醒来第一次计时
  h.advance(2000); stall.fn();
  assert.ok(!h.logs.some(l => l.event === 'renderer-memory-at-hang'), 'no hang right after resume');
  assert.equal(h.win.webContents.killed, 0);
});

test('stall rescue can be switched off; a normal crash still says "crashed"', () => {
  const h = harness({ rescueStallMs: 0 });
  const stall = h.intervals.find(i => i.ms === 2000);
  h.ipcMain.emit(HEARTBEAT_CHANNEL, { sender: h.win.webContents }, 'visible');
  for (let i = 0; i < 60; i++) { h.advance(2000); stall.fn(); }
  assert.equal(h.win.webContents.killed, 0);
  h.win.webContents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: -36861 });
  h.runTimers();
  assert.deepEqual(h.reloads.map(r => r.reason), ['crashed']);
});

test('hang stacks can be switched off', async () => {
  const h = harness({ hangStacks: false });
  h.win.emit('unresponsive');
  await new Promise(r => setImmediate(r));
  assert.ok(h.logs.some(l => l.event === 'renderer-memory-at-hang'));
  assert.ok(!h.logs.some(l => l.event === 'renderer-hang-stack'));
});

test('shortenStack keeps code-relative paths only', () => {
  assert.equal(shortenStack('at f (file:///D:/AIWork/x/renderer/meeting-room.js:5:1)'), 'at f (renderer/meeting-room.js:5:1)');
  assert.equal(shortenStack('at g (file:///E:/Apps/page.html:2:3)'), 'at g (page.html:2:3)');
  assert.equal(shortenStack(undefined), '(空)');
  assert.ok(shortenStack('x'.repeat(10000)).length <= 4000);
});

test('protocol opt-in: armed only until the main index.html is served, header only on it', async () => {
  let handler = null;
  let unhandled = 0;
  const protocol = { handle: (scheme, fn) => { assert.equal(scheme, 'file'); handler = fn; }, unhandle: scheme => { assert.equal(scheme, 'file'); handler = null; unhandled += 1; } };
  const fetched = [];
  const net = { fetch: async (request, opts) => { fetched.push({ url: request.url, opts }); return new Response('body', { status: 200, headers: { 'Content-Type': 'text/html' } }); } };
  const indexPath = path.resolve('C:/app/renderer/index.html');
  const optIn = installHangStackOptIn({ protocol, net, indexPath, env: {} });
  assert.ok(optIn && optIn.arm(), 'armed');
  const before = await handler(new Request(url.pathToFileURL(path.resolve('C:/app/renderer/styles/a.css')).href));
  assert.equal(before.headers.get('Document-Policy'), null, 'other files untouched');
  assert.ok(optIn.armed, 'still armed until index is served');
  const index = await handler(new Request(url.pathToFileURL(indexPath).href + '?recovered=oom'));
  assert.equal(index.headers.get('Document-Policy'), HANG_STACK_POLICY);
  assert.equal(await index.text(), 'body');
  assert.equal(handler, null, 'disarmed right after the main page');
  assert.equal(unhandled, 1);
  assert.ok(!optIn.armed);
  assert.ok(fetched.every(f => f.opts && f.opts.bypassCustomProtocolHandlers === true), 'falls through to the built-in file handler');
  assert.ok(optIn.arm() && handler, 're-armed before a recovery reload');
  assert.equal(installHangStackOptIn({ protocol, net, indexPath, env: { AI_HUB_HANG_STACKS: '0 ' } }), null);
});

(async () => {
  let failed = 0;
  for (const { name, fn } of tests) {
    try { await fn(); console.log('  ✓ ' + name); }
    catch (error) { failed += 1; console.error('  ✗ ' + name + '\n' + (error && error.stack || error)); }
  }
  if (failed) { console.error(`${failed} failed`); process.exit(1); }
  console.log(`PASS ${tests.length}`);
})();
