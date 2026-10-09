'use strict';

// 活实例登记表。Hub 本来就在 <dataDir>/diagnostics/ 下每 10 秒写一次心跳
// （见 core/process-lifecycle-journal.js），多实例共用同一个数据目录，
// 所以这些文件天然就是一张「本机有哪些 Hub、哪些还活着」的名册，白捡的。
//
// 这张表撑起了整个回收功能里最硬的一条判据：
//   心跳文件在、进程没了 => 那个 Hub 已经退出 => 它名下还在跑的东西全是垃圾。
//
// 判死必须极其保守。「心跳很久没更新」不算死——Hub 卡住时心跳也会停，
// 但它的会话还在跑，误判成死的就会杀掉用户正在干的活。只有进程真的不在了，
// 或者那个 PID 已经被别的程序复用了，才算死。

const fs = require('fs');
const path = require('path');
const os = require('os');

const HEARTBEAT_SUFFIX = '.heartbeat.json';
const HEARTBEAT_PREFIX = 'process-lifecycle-';
const DEFAULT_SCHEDULER_HEARTBEAT_MAX_AGE_MS = 35_000;

function parseHubVersion(value) {
  const raw = String(value || '').trim().replace(/^v/i, '');
  const match = raw.match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/);
  if (!match) return null;
  return {
    raw,
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: String(match[4] || ''),
  };
}

function comparePrerelease(left, right) {
  if (!left && !right) return 0;
  if (!left) return 1;
  if (!right) return -1;
  const a = left.split('.');
  const b = right.split('.');
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    if (a[index] == null) return -1;
    if (b[index] == null) return 1;
    const aNumeric = /^\d+$/.test(a[index]);
    const bNumeric = /^\d+$/.test(b[index]);
    if (aNumeric && bNumeric) {
      const diff = Number(a[index]) - Number(b[index]);
      if (diff) return diff;
      continue;
    }
    if (aNumeric !== bNumeric) return aNumeric ? -1 : 1;
    const diff = a[index].localeCompare(b[index]);
    if (diff) return diff;
  }
  return 0;
}

function compareHubVersions(left, right) {
  const a = parseHubVersion(left);
  const b = parseHubVersion(right);
  if (!a && !b) return String(left || '').localeCompare(String(right || ''));
  if (!a) return -1;
  if (!b) return 1;
  for (const key of ['major', 'minor', 'patch']) {
    const diff = a[key] - b[key];
    if (diff) return diff;
  }
  return comparePrerelease(a.prerelease, b.prerelease);
}

function compareHubPriority(left, right) {
  const versionDiff = compareHubVersions(left && left.appVersion, right && right.appVersion);
  if (versionDiff) return versionDiff;
  return Number(left && left.pid || 0) - Number(right && right.pid || 0);
}

function resolveDataDir(options = {}) {
  const env = (options.env || process.env) || {};
  return path.resolve(
    options.dataDir
      || env.CLAUDE_HUB_DATA_DIR
      || path.join((options.homedir || os.homedir)(), '.ai-hub-community'),
  );
}

function parseHeartbeatFile(fsRef, filePath) {
  let raw;
  try {
    raw = fsRef.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    // 心跳是「读-改-写」的小文件，正好读到写一半是正常的，跳过这轮即可。
    return null;
  }
  const pid = Number(data && data.pid);
  if (!Number.isFinite(pid) || pid <= 0) return null;

  const epochMs = Number(data.epochMs) || Date.parse(data.ts || '') || 0;
  return {
    pid,
    ppid: Number(data.ppid) || 0,
    appVersion: String(data.appVersion || ''),
    lastBeatAt: epochMs,
    lastBeatIso: String(data.ts || ''),
    event: String(data.event || ''),
    phase: String(data.phase || ''),
    cleanExit: data.cleanExit === true,
    windowCount: Number(data.windowCount) || 0,
    uptimeSec: Number(data.uptimeSec) || 0,
    // 自报的退出：event=app-quit / phase=quit。这类是干净退出，
    // 留下的残留最典型（Hub 走了，孙辈进程没人管）。
    selfReportedQuit: String(data.event || '') === 'app-quit' || String(data.phase || '') === 'quit',
    file: filePath,
  };
}

function readLifecycleVersion(fsRef, heartbeatPath) {
  const journalPath = heartbeatPath.slice(0, -HEARTBEAT_SUFFIX.length) + '.jsonl';
  let raw;
  try { raw = fsRef.readFileSync(journalPath, 'utf8'); }
  catch { return ''; }
  for (const line of String(raw || '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      if (row && row.appVersion) return String(row.appVersion);
    } catch {}
  }
  return '';
}

function readHubInstances(options = {}) {
  const fsRef = options.fsRef || fs;
  const dataDir = resolveDataDir(options);
  const diagnosticsDir = path.join(dataDir, 'diagnostics');
  const minLastBeatAt = Math.max(0, Number(options.minLastBeatAt) || 0);

  let entries;
  try {
    entries = fsRef.readdirSync(diagnosticsDir);
  } catch {
    return { dataDir, diagnosticsDir, instances: [] };
  }

  const instances = [];
  for (const entry of entries) {
    if (!entry.startsWith(HEARTBEAT_PREFIX) || !entry.endsWith(HEARTBEAT_SUFFIX)) continue;
    const heartbeatPath = path.join(diagnosticsDir, entry);
    const record = parseHeartbeatFile(fsRef, heartbeatPath);
    if (record) {
      if (minLastBeatAt && record.lastBeatAt < minLastBeatAt) continue;
      // v1.6.45 and earlier only wrote appVersion into the append-only
      // lifecycle journal. Keep those already-running Hubs electable while new
      // versions put the same field directly in the cheap heartbeat file.
      if (!record.appVersion) record.appVersion = readLifecycleVersion(fsRef, heartbeatPath);
      instances.push(record);
    }
  }

  instances.sort((a, b) => b.lastBeatAt - a.lastBeatAt);
  return { dataDir, diagnosticsDir, instances };
}

function selectPreferredHub(records, options = {}) {
  // Scheduler eligibility is deliberately stricter than process reclamation:
  // a stale heartbeat is enough to stop assigning *new* work, but never enough
  // for classifyInstances() to declare a process dead or safe to terminate.
  const now = Number(options.now) || Date.now();
  const maxHeartbeatAgeMs = Math.max(1, Number(options.maxHeartbeatAgeMs) || DEFAULT_SCHEDULER_HEARTBEAT_MAX_AGE_MS);
  const byPid = new Map();
  for (const source of [...(records || []), ...(options.self ? [options.self] : [])]) {
    const pid = Number(source && source.pid);
    if (!Number.isFinite(pid) || pid <= 0) continue;
    const record = {
      ...source,
      pid,
      appVersion: String(source && source.appVersion || ''),
      lastBeatAt: Number(source && source.lastBeatAt) || 0,
    };
    const previous = byPid.get(pid);
    if (!previous || record.lastBeatAt >= previous.lastBeatAt) byPid.set(pid, record);
  }

  const candidates = [];
  const excluded = [];
  for (const record of byPid.values()) {
    const beatAgeMs = record.lastBeatAt > 0 ? Math.max(0, now - record.lastBeatAt) : Number.POSITIVE_INFINITY;
    const retiring = record.selfReportedQuit || /(?:before-quit|will-quit|quit|disposed|process-exit)/i.test(String(record.phase || record.event || ''));
    const reason = record.cleanExit || retiring
      ? 'exited'
      : !parseHubVersion(record.appVersion)
        ? 'version-unknown'
        : beatAgeMs > maxHeartbeatAgeMs
          ? 'heartbeat-stale'
          : '';
    const item = { ...record, beatAgeMs };
    if (reason) excluded.push({ ...item, exclusionReason: reason });
    else candidates.push(item);
  }
  candidates.sort((left, right) => compareHubPriority(right, left));
  excluded.sort((left, right) => Number(right.lastBeatAt || 0) - Number(left.lastBeatAt || 0));
  return { preferred: candidates[0] || null, candidates, excluded, observedAt: now, maxHeartbeatAgeMs };
}

// 把心跳记录和「现在真正在跑的进程」对上号。
//
// isHubProcess 由调用方注入：光看 PID 存不存在不够，PID 是会被系统回收复用的，
// 必须确认占着这个 PID 的确实还是一个 Hub 进程，否则会把某个刚启动的无关程序
// 误认成「Hub 还活着」，进而把真正该回收的东西一路保护起来。
function classifyInstances(records, options = {}) {
  const byPid = options.byPid || new Map();
  const isHubProcess = typeof options.isHubProcess === 'function' ? options.isHubProcess : () => false;
  const now = Number(options.now) || Date.now();

  const alive = [];
  const dead = [];

  for (const record of records) {
    const proc = byPid.get(record.pid);
    const stillHub = !!proc && isHubProcess(proc);
    // 进程启动时间晚于最后一次心跳 => 这个 PID 已经被复用了，原实例早没了。
    const pidReused = !!proc && record.lastBeatAt > 0 && proc.startedAt > record.lastBeatAt + 5_000;

    if (stillHub && !pidReused) {
      alive.push({
        ...record,
        alive: true,
        startedAt: proc.startedAt,
        beatAgeMs: record.lastBeatAt > 0 ? Math.max(0, now - record.lastBeatAt) : null,
      });
    } else {
      dead.push({
        ...record,
        alive: false,
        pidReused,
        // 说明为什么判它死了，界面上要原样展示给用户看。
        deadReason: pidReused
          ? 'pid-reused'
          : (record.selfReportedQuit ? 'self-reported-quit' : 'process-gone'),
        goneForMs: record.lastBeatAt > 0 ? Math.max(0, now - record.lastBeatAt) : null,
      });
    }
  }

  return { alive, dead };
}

module.exports = {
  DEFAULT_SCHEDULER_HEARTBEAT_MAX_AGE_MS,
  HEARTBEAT_PREFIX,
  HEARTBEAT_SUFFIX,
  classifyInstances,
  compareHubPriority,
  compareHubVersions,
  parseHeartbeatFile,
  parseHubVersion,
  readHubInstances,
  readLifecycleVersion,
  resolveDataDir,
  selectPreferredHub,
};
