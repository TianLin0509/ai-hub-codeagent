'use strict';
// 窗口在屏幕上就一直出帧 + 窗口事件日志（公司真机「点后台冻住、半分钟后黑屏」，2026-10-10）。
// 真实窗口行为见 tests/e2e-window-occlusion-keeps-rendering.js；这里锁住开关判定、日志与主进程接线。
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { shouldKeepRendering, createWindowEventLog, installWindowKeepRendering, LOG_LIMIT_BYTES } = require('../core/window-keep-rendering');

let passed = 0;
function test(name, fn) { fn(); passed++; console.log(`  ok ${name}`); }

test('社区版默认开启，主仓库默认关闭；环境变量可强制', () => {
  assert.strictEqual(shouldKeepRendering({ env: {}, community: true }), true);
  assert.strictEqual(shouldKeepRendering({ env: {}, community: false }), false);
  assert.strictEqual(shouldKeepRendering({ env: { AI_HUB_KEEP_RENDERING: '1' }, community: false }), true);
  assert.strictEqual(shouldKeepRendering({ env: { AI_HUB_KEEP_RENDERING: '0' }, community: true }), false);
});

function fakeWindow() {
  const win = new EventEmitter();
  win.webContents = new EventEmitter();
  win.webContents.throttling = [];
  win.webContents.setBackgroundThrottling = v => win.webContents.throttling.push(v);
  win.isMinimized = () => false; win.isVisible = () => true; win.isFocused = () => true;
  win.getBounds = () => ({ x: 0, y: 0, width: 800, height: 600 });
  win.isDestroyed = () => false;
  return win;
}

test('开启时关掉后台节流，并把窗口与页面事件写进 logs/window-events.log', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-render-'));
  const win = fakeWindow(); const app = new EventEmitter(); const ipcMain = new EventEmitter();
  installWindowKeepRendering(win, { app, ipcMain, dataDir: dir, enabled: true, logger: {} });
  assert.deepStrictEqual(win.webContents.throttling, [false]);
  win.emit('minimize'); win.emit('restore'); win.emit('unresponsive');
  win.webContents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 1 });
  app.emit('child-process-gone', {}, { type: 'GPU', reason: 'crashed', exitCode: 2 });
  ipcMain.emit('hub:page-window-event', { sender: win.webContents }, { event: 'visibility', state: 'hidden', view: 'pty', sessions: 3 });
  ipcMain.emit('hub:page-window-event', { sender: {} }, { event: 'visibility', state: 'hidden' }); // 别的窗口发来的不记
  const log = fs.readFileSync(path.join(dir, 'logs', 'window-events.log'), 'utf8');
  for (const word of ['start', 'minimize', 'restore', 'unresponsive', 'render-process-gone', 'child-process-gone', 'page-visibility']) assert.ok(log.includes(` ${word} `), word);
  assert.strictEqual((log.match(/page-visibility/g) || []).length, 1);
  assert.ok(/"state":"hidden","view":"pty","sessions":3/.test(log));
  win.emit('closed');
  assert.strictEqual(app.listenerCount('child-process-gone'), 0);
  assert.strictEqual(ipcMain.listenerCount('hub:page-window-event'), 0);
});

test('关闭时不动节流，只记日志', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-render-'));
  const win = fakeWindow();
  installWindowKeepRendering(win, { dataDir: dir, enabled: false, logger: {} });
  assert.deepStrictEqual(win.webContents.throttling, []);
  assert.ok(fs.readFileSync(path.join(dir, 'logs', 'window-events.log'), 'utf8').includes('"keepRendering":false'));
});

test('日志超过上限时轮转，不无限增长', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-render-'));
  const file = path.join(dir, 'logs', 'window-events.log');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, 'x'.repeat(LOG_LIMIT_BYTES + 10));
  createWindowEventLog(file, { logger: {} })('restore', {});
  assert.ok(fs.statSync(file).size < 1000);
  assert.ok(fs.existsSync(file + '.1'));
});

test('主进程接线：主窗口创建后安装，社区版判定来自 distribution', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  assert.ok(/installWindowKeepRendering\(mainWindow, \{/.test(main));
  assert.ok(/shouldKeepRendering\(\{ community: require\('\.\/core\/distribution'\)\.community \}\)/.test(main));
  const renderer = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'renderer.js'), 'utf8');
  assert.ok(renderer.includes("report('visibility'") && renderer.includes("report('frame-stall'"));
});

console.log(`unit-window-keep-rendering: ${passed} passed`);
