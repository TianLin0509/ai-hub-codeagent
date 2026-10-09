'use strict';

// 多个 Hub 窗口共用一个数据目录，但各自的会话只在自己内存里。「释放内存」面板要看全
// 所有窗口的会话，所以每个 Hub 定时把自己的会话清单写成一个小文件；别的窗口要休眠
// 不属于自己的会话时，往目标 Hub 的收件箱放一个请求文件，由目标 Hub 用自己的闸门执行。
//
//   <dataDir>/diagnostics/session-manifest-<pid>.json   会话清单（每 10 秒刷新）
//   <dataDir>/diagnostics/memory-release-inbox/<pid>/    发给某个 Hub 的休眠请求
//   <dataDir>/diagnostics/memory-release-inbox/results/  执行结果

const fs = require('fs');
const path = require('path');

const MANIFEST_PREFIX = 'session-manifest-';
const MANIFEST_FRESH_MS = 35_000;
const REQUEST_FRESH_MS = 30_000;

function manifestPath(diagnosticsDir, pid) {
  return path.join(diagnosticsDir, `${MANIFEST_PREFIX}${pid}.json`);
}

function readManifests(diagnosticsDir, { now = Date.now(), fsApi = fs } = {}) {
  const manifests = new Map();
  let entries = [];
  try { entries = fsApi.readdirSync(diagnosticsDir); } catch { return manifests; }
  for (const name of entries) {
    const match = name.match(/^session-manifest-(\d+)\.json$/);
    if (!match) continue;
    try {
      const data = JSON.parse(fsApi.readFileSync(path.join(diagnosticsDir, name), 'utf8'));
      const pid = Number(data && data.pid);
      if (pid !== Number(match[1]) || !Array.isArray(data.sessions)) continue;
      if (now - (Number(data.writtenAt) || 0) > MANIFEST_FRESH_MS) continue;
      manifests.set(pid, data);
    } catch { /* 正好读到写一半，跳过这轮 */ }
  }
  return manifests;
}

function createSessionManifestExchange(options = {}) {
  const diagnosticsDir = options.diagnosticsDir;
  if (!diagnosticsDir) throw new Error('diagnosticsDir required');
  const fsApi = options.fs || fs;
  const pid = Number(options.pid) || process.pid;
  const now = options.now || Date.now;
  const appVersion = String(options.appVersion || '');
  const describeSessions = options.describeSessions || (() => []);
  const suspendSession = options.suspendSession || (() => ({ ok: false, error: 'unsupported' }));
  const manifestMs = Math.max(1_000, Number(options.manifestMs) || 10_000);
  const inboxMs = Math.max(250, Number(options.inboxMs) || 2_000);
  const inboxRoot = path.join(diagnosticsDir, 'memory-release-inbox');
  const ownInbox = path.join(inboxRoot, String(pid));
  const resultsDir = path.join(inboxRoot, 'results');
  let manifestTimer = null;
  let inboxTimer = null;

  function writeAtomic(file, text) {
    fsApi.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${pid}.tmp`;
    fsApi.writeFileSync(tmp, text);
    fsApi.renameSync(tmp, file);
  }

  function snapshot() {
    return { pid, appVersion, writtenAt: now(), sessions: describeSessions() };
  }

  function writeManifest() {
    try { writeAtomic(manifestPath(diagnosticsDir, pid), JSON.stringify(snapshot())); } catch { /* 下一轮再写 */ }
  }

  function processInbox() {
    let entries = [];
    try { entries = fsApi.readdirSync(ownInbox); } catch { return; }
    for (const name of entries) {
      if (!name.endsWith('.json')) continue;
      const file = path.join(ownInbox, name);
      let request = null;
      try { request = JSON.parse(fsApi.readFileSync(file, 'utf8')); } catch { /* 写一半或损坏 */ }
      try { fsApi.unlinkSync(file); } catch { /* 另一轮已处理 */ }
      if (!request || !request.requestId || !request.sessionId) continue;
      let result;
      if (now() - (Number(request.requestedAt) || 0) > REQUEST_FRESH_MS) result = { ok: false, error: 'request-expired', message: '请求已过期' };
      else {
        try { result = suspendSession(String(request.sessionId)) || { ok: false, error: 'unknown' }; }
        catch (error) { result = { ok: false, error: 'suspend-threw', message: error.message }; }
      }
      try {
        writeAtomic(path.join(resultsDir, `${String(request.requestId).replace(/[^\w-]/g, '')}.json`),
          JSON.stringify({ ...result, sessionId: request.sessionId, handledBy: pid, handledAt: now() }));
      } catch { /* 请求方会超时 */ }
    }
    if (entries.length) writeManifest();
  }

  async function requestRemoteSuspend(targetPid, sessionId, { timeoutMs = 8_000, pollMs = 250 } = {}) {
    const requestId = `${pid}-${now()}-${Math.random().toString(36).slice(2, 8)}`;
    try {
      writeAtomic(path.join(inboxRoot, String(targetPid), `${requestId}.json`),
        JSON.stringify({ requestId, sessionId, fromPid: pid, requestedAt: now() }));
    } catch (error) { return { ok: false, error: 'request-write-failed', message: error.message }; }
    const resultFile = path.join(resultsDir, `${requestId}.json`);
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, pollMs));
      try {
        const result = JSON.parse(fsApi.readFileSync(resultFile, 'utf8'));
        try { fsApi.unlinkSync(resultFile); } catch { /* ignore */ }
        return result;
      } catch { /* 还没处理 */ }
    }
    return { ok: false, error: 'remote-timeout', message: '另一个 Hub 窗口没有响应' };
  }

  function start() {
    writeManifest();
    manifestTimer = setInterval(writeManifest, manifestMs);
    inboxTimer = setInterval(processInbox, inboxMs);
    manifestTimer.unref?.();
    inboxTimer.unref?.();
  }

  function stop() {
    clearInterval(manifestTimer);
    clearInterval(inboxTimer);
    try { fsApi.unlinkSync(manifestPath(diagnosticsDir, pid)); } catch { /* ignore */ }
  }

  return { start, stop, snapshot, writeManifest, processInbox, requestRemoteSuspend, readManifests: () => readManifests(diagnosticsDir, { now: now(), fsApi }) };
}

module.exports = { createSessionManifestExchange, readManifests, manifestPath, MANIFEST_FRESH_MS };
