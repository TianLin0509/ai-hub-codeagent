'use strict';

// 「释放内存」面板的 IPC：扫描生成清单、按用户勾选执行。
// 执行前一定重新扫描并重新分类：只有此刻仍是「可放心结束 / 可休眠」的项才动手，
// 进程逐个核对 PID + 启动时间（防 PID 复用），会话休眠走会话管理器自己的闸门。

const os = require('os');
const path = require('path');

const { createProcessInspector } = require('../../core/process-inspector.js');
const { readHubInstances, classifyInstances } = require('../../core/hub-instance-registry.js');
const { buildReclaimReport, isHubProcess } = require('../../core/process-reclaim.js');
const { buildMemoryReleasePlan } = require('../../core/memory-release-planner.js');
const { createSessionManifestExchange } = require('../../core/session-manifest-exchange.js');
const { MEMORY_RELEASE_SUSPEND_OPTIONS } = require('../../core/session-manager.js');

const BASELINE_GAP_MS = 1_200;
const SETTLE_MS = 2_500;

function registerMemoryReleaseIpc(ipcMain, deps = {}) {
  const logger = deps.logger || console;
  const inspector = deps.inspector || createProcessInspector({ logger, ttlMs: 2_000 });
  const getSessionManager = typeof deps.getSessionManager === 'function' ? deps.getSessionManager : () => null;
  const dataDir = deps.dataDir;
  const osApi = deps.os || os;
  const processRef = deps.processRef || process;
  const now = deps.now || Date.now;
  const delay = deps.delay || (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const killProcess = deps.killProcess || (pid => processRef.kill(pid));
  const diagnosticsDir = path.join(dataDir, 'diagnostics');

  const suspendOwnSession = sessionId => {
    const sessionManager = getSessionManager();
    if (!sessionManager) return { ok: false, error: 'no-session-manager' };
    return sessionManager.suspendSession(sessionId, { ...MEMORY_RELEASE_SUSPEND_OPTIONS, now: now() });
  };
  const exchange = deps.exchange || createSessionManifestExchange({
    diagnosticsDir,
    pid: processRef.pid,
    appVersion: deps.appVersion,
    describeSessions: () => getSessionManager()?.describeSessionsForMemory?.({ now: now() }) || [],
    suspendSession: suspendOwnSession,
  });
  if (!deps.exchange) {
    exchange.start();
    deps.app?.on?.('will-quit', () => exchange.stop());
  }

  let hasBaseline = false;

  async function scan() {
    await inspector.snapshot({ force: true });
    if (!hasBaseline) {
      // 第一次要连采两次才有 CPU 增量，判断残留是否「几乎不动」。
      await delay(BASELINE_GAP_MS);
      hasBaseline = true;
    }
    const snapshot = await inspector.snapshot({ force: true });
    const { instances } = readHubInstances({ dataDir });
    const { alive, dead } = classifyInstances(instances, { byPid: snapshot.byPid, isHubProcess, now: now() });
    const sessionManager = getSessionManager();
    const liveSessionsKnown = !!(sessionManager && typeof sessionManager.listLivePtyPids === 'function');
    const reclaimReport = buildReclaimReport({
      snapshot, aliveHubs: alive, deadHubs: dead, selfPid: processRef.pid,
      liveSessionPids: liveSessionsKnown ? sessionManager.listLivePtyPids() : [], liveSessionsKnown, now: now(),
    });
    // 自己这一份用实时数据，不等 10 秒一次的落盘。
    exchange.writeManifest();
    const manifests = exchange.readManifests();
    manifests.set(processRef.pid, exchange.snapshot());
    return buildMemoryReleasePlan({
      snapshot, reclaimReport, manifests, selfPid: processRef.pid, now: now(),
      memory: { totalBytes: osApi.totalmem(), freeBytes: osApi.freemem() },
    });
  }

  function killMembers(item, byPid) {
    let killed = 0; let skipped = 0;
    for (const member of item.members || []) {
      const current = byPid.get(member.pid);
      if (!current || current.startedAt !== member.startedAt) { skipped += 1; continue; }
      try { killProcess(member.pid); killed += 1; } catch { skipped += 1; }
    }
    return { ok: killed > 0, killed, skipped };
  }

  async function execute(requested) {
    const wanted = new Set((requested || []).map(String));
    const freeBefore = osApi.freemem();
    const plan = await scan();
    const snapshot = await inspector.snapshot();
    const results = [];
    for (const key of wanted) {
      const item = plan.items.find(entry => entry.key === key);
      if (!item || (item.tier !== 'safe' && item.tier !== 'suspend')) {
        results.push({ key, ok: false, message: '状态已变化（可能已在使用或已关闭），本次未处理' });
        continue;
      }
      let outcome;
      if (item.tier === 'safe') outcome = killMembers(item, snapshot.byPid);
      else if (item.hubPid === processRef.pid) outcome = suspendOwnSession(item.sessionId);
      else outcome = await exchange.requestRemoteSuspend(item.hubPid, item.sessionId);
      results.push({
        key, title: item.title, action: item.tier === 'safe' ? 'end' : 'suspend', wsBytes: item.wsBytes,
        ok: !!(outcome && outcome.ok), message: outcome && !outcome.ok ? (outcome.message || outcome.error || '未成功') : '',
      });
    }
    await delay(SETTLE_MS);
    const freeAfter = osApi.freemem();
    return {
      ok: true,
      results,
      freeBefore,
      freeAfter,
      freedBytes: Math.max(0, freeAfter - freeBefore),
      totalBytes: osApi.totalmem(),
    };
  }

  ipcMain.handle('get-memory-release-plan', async () => {
    try { return await scan(); } catch (error) {
      logger.warn('[群聊] 内存释放清单扫描失败:', error && error.message);
      return { ok: false, error: String(error && error.message || error), items: [] };
    }
  });

  ipcMain.handle('execute-memory-release', async (_event, options = {}) => {
    try { return await execute(options && options.keys); } catch (error) {
      logger.warn('[群聊] 内存释放执行失败:', error && error.message);
      return { ok: false, error: String(error && error.message || error), results: [] };
    }
  });

  return { scan, execute, exchange };
}

module.exports = { registerMemoryReleaseIpc };
