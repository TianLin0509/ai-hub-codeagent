'use strict';
// 昨日之我第一次全量建索引等电脑空闲再开始；没建好期间的阶段变化交给主进程写日志（core/session-search-first-build.js）。
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const firstBuild = require('../core/session-search-first-build.js');
const { SessionSearchService } = require('../core/session-search-service.js');

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('marker: missing until the first build is marked done', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'search-first-build-'));
  assert.equal(firstBuild.firstBuildDone(dir), false);
  assert.equal(firstBuild.markFirstBuildDone(dir, { sessions: 3 }), true);
  assert.equal(firstBuild.firstBuildDone(dir), true);
  assert.equal(JSON.parse(fs.readFileSync(firstBuild.markerPath(dir), 'utf8')).sessions, 3);
});

test('idle setting: default 3 minutes, 0 means no wait, junk falls back', () => {
  assert.equal(firstBuild.idleSecondsSetting({}), 180);
  assert.equal(firstBuild.idleSecondsSetting({ HUB_SESSION_SEARCH_FIRST_BUILD_IDLE_SEC: '0' }), 0);
  assert.equal(firstBuild.idleSecondsSetting({ HUB_SESSION_SEARCH_FIRST_BUILD_IDLE_SEC: ' 60 ' }), 60);
  assert.equal(firstBuild.idleSecondsSetting({ HUB_SESSION_SEARCH_FIRST_BUILD_IDLE_SEC: 'abc' }), 180);
});

test('waitForUserIdle polls until the machine has been idle long enough', async () => {
  const idle = [5, 40, 179, 200];
  const delays = [];
  const result = await firstBuild.waitForUserIdle({ getIdleSeconds: () => idle.shift(), idleSec: 180, pollMs: 15000, delay: async ms => { delays.push(ms); } });
  assert.equal(result.idleSec, 200);
  assert.deepEqual(delays, [15000, 15000, 15000]);
});

test('waitForUserIdle stops early when released elsewhere, and does not wait without an idle reading', async () => {
  let stop = false;
  const r1 = await firstBuild.waitForUserIdle({ getIdleSeconds: () => 1, idleSec: 180, delay: async () => { stop = true; }, shouldStop: () => stop });
  assert.equal(r1.stopped, true);
  const r2 = await firstBuild.waitForUserIdle({ getIdleSeconds: () => { throw new Error('no powerMonitor'); }, idleSec: 180, delay: async () => assert.fail('should not wait') });
  assert.equal(r2.idleSec, null);
});

function fakeService(options = {}) {
  const sent = [];
  const fork = () => {
    const child = new EventEmitter();
    child.pid = 1; child.connected = true;
    child.send = (message, cb) => { sent.push(message); cb && cb(); };
    child.kill = () => {};
    return child;
  };
  const service = new SessionSearchService({ fork, syncMinIntervalMs: 0, prewarmEnabled: true, ...options });
  return { service, sent };
}

test('held service queues background syncs without starting the child; release flushes them', async () => {
  const { service, sent } = fakeService({ holdBackground: true });
  assert.equal(service.backgroundHeld, true);
  service.queueRefresh({ sessions: [] }, 'turn-complete');
  await new Promise(r => setTimeout(r, 600));
  assert.equal(sent.length, 0, 'nothing sent while held');
  service.releaseBackground();
  assert.equal(service.backgroundHeld, false);
  await new Promise(r => setTimeout(r, 600));
  assert.ok(sent.some(m => m.type === 'refresh'), 'queued sync runs after release');
  service._closed = true;
});

test('hold is ignored on Hubs that do not prewarm (isolated test Hubs)', () => {
  const { service } = fakeService({ holdBackground: true, prewarmEnabled: false });
  assert.equal(service.backgroundHeld, false);
  service._closed = true;
});

test('explicit search still goes through while held', async () => {
  const { service, sent } = fakeService({ holdBackground: true });
  service.search({ query: 'x' }, {}).catch(() => {});
  assert.ok(sent.some(m => m.type === 'search'));
  service._closed = true;
});

test('status callback: phase changes before ready, the ready moment, not every incremental sync afterwards', () => {
  const seen = [];
  const { service } = fakeService({ onStatusChange: status => seen.push(firstBuild.statusLogDetail(status)) });
  const push = status => service._handleMessage({ type: 'status', status });
  push({ phase: 'indexing', ready: false, refreshing: true, index: { sessions: 10, documents: 100 } });
  push({ phase: 'indexing', ready: false, refreshing: true, index: { sessions: 20, documents: 200 } });
  push({ phase: 'ready', ready: true, refreshing: false, index: { sessions: 30, documents: 300 } });
  push({ phase: 'ready', ready: true, refreshing: true, index: { sessions: 31, documents: 310 } });
  push({ phase: 'ready', ready: true, refreshing: false, index: { sessions: 31, documents: 310 } });
  assert.deepEqual(seen.map(s => [s.phase, s.ready, s.sessions]), [['indexing', false, 10], ['ready', true, 30]]);
  service._closed = true;
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
