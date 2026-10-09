'use strict';

// VPN 流量记账：轮询 Clash Verge (mihomo) 的 /connections，把每条连接两次采样间的
// 字节增量记到「程序 / 域名 / 节点 / 小时」上，按本地日期每天落一个 JSON。
// Clash 只在内存里保留当前连接，不留历史，所以只有 Hub 开着时才有记录；
// 每天的 recordedMs 记录覆盖时长，界面据此说明数据是否完整。
//
// 多个 Hub 实例共享数据目录（main-bootstrap 不装单实例锁），用租约文件保证
// 同一时刻只有一个实例在记账，其他实例只读文件。

const fs = require('fs');
const http = require('http');
const path = require('path');
const { execFile } = require('child_process');
const { yamlScalar, controllerPipeCandidates, listVergeMihomoPipes } = require('./clash-verge-delay.js');
const { sharedOffMainExecFile } = require('./off-main-exec.js');

const FILE_VERSION = 1;
const MAX_HOSTS = 600;
const MAX_APP_HOSTS = 1200;
const OTHER_KEY = '(其他)';
const UNKNOWN_APP = '(未识别)';
const RETENTION_DAYS = 400;
const LEASE_STALE_MS = 20_000;

function localDateKey(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function emptyDay(date) {
  return {
    version: FILE_VERSION,
    date,
    proxied: { up: 0, down: 0 },
    direct: { up: 0, down: 0 },
    unattributed: { up: 0, down: 0 },
    estimated: { up: 0, down: 0 },
    byApp: {},
    byHost: {},
    byAppHost: {},
    byNode: {},
    byHour: Array.from({ length: 24 }, () => ({ up: 0, down: 0 })),
    recordedMs: 0,
    firstAt: null,
    lastAt: null,
  };
}

function addPair(map, key, up, down, cap) {
  let row = map[key];
  if (!row) {
    if (cap && Object.keys(map).length >= cap) key = OTHER_KEY;
    row = map[key] || (map[key] = { up: 0, down: 0 });
  }
  row.up += up;
  row.down += down;
}

function normalizeAppName(raw) {
  const name = path.win32.basename(String(raw || '').trim());
  return name || null;
}

function parseNetstatOwners(text, proxyPort) {
  // netstat -ano -p TCP 行：TCP  127.0.0.1:53123  127.0.0.1:7890  ESTABLISHED  1234
  const owners = new Map();
  const suffix = `:${proxyPort}`;
  for (const line of String(text || '').split(/\r?\n/)) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 5 || cols[0] !== 'TCP' || !cols[2].endsWith(suffix)) continue;
    const local = cols[1].slice(cols[1].lastIndexOf(':') + 1);
    const pid = Number(cols[4]);
    if (local && pid > 0) owners.set(local, pid);
  }
  return owners;
}

function parseTasklist(text) {
  const names = new Map();
  for (const line of String(text || '').split(/\r?\n/)) {
    const cells = line.trim().replace(/^"|"$/g, '').split('","');
    const pid = Number(cells[1]);
    if (cells.length > 1 && pid > 0) names.set(pid, cells[0]);
  }
  return names;
}

function requestJson(httpApi, socketPath, secret, urlPath, timeoutMs = 2_500) {
  return new Promise((resolve, reject) => {
    const request = httpApi.request({
      socketPath, path: urlPath, method: 'GET', timeout: timeoutMs,
      headers: secret ? { Authorization: `Bearer ${secret}` } : {},
    }, response => {
      if (response.statusCode !== 200) { response.resume(); reject(new Error('controller-unavailable')); return; }
      let body = '';
      response.setEncoding?.('utf8');
      response.on('data', chunk => {
        body += chunk;
        if (body.length > 8_000_000) request.destroy(new Error('response-too-large'));
      });
      response.on('end', () => { try { resolve(JSON.parse(body)); } catch (error) { reject(error); } });
      response.on('error', reject);
    });
    request.on('timeout', () => request.destroy(new Error('controller-timeout')));
    request.on('error', reject);
    request.end();
  });
}

// 把差额按权重分给一组连接；权重全为 0 时平均分。
function splitResidual(amount, entries, weightOf) {
  if (!(amount > 0) || !entries.length) return entries.map(() => 0);
  const weights = entries.map(weightOf);
  const total = weights.reduce((sum, w) => sum + w, 0);
  return weights.map(w => (total > 0 ? amount * w / total : amount / entries.length));
}

// 把一次 /connections 快照与上一次比较，返回本次增量。纯函数，便于单测。
// state: { totals:{up,down}|null, conns: Map<id,{up,down,conn,rateUp,rateDown}> }
//
// 核心总量的增量 = 快照里连接的增量 + 本轮消失连接的尾部流量 + 两次采样之间开始又结束的短连接。
// 后两部分快照里看不到，把差额按上一轮速率分给本轮消失的连接（它们的尾部通常是主体）；
// 没有消失连接时留作「未归属」。
function diffSnapshot(state, snapshot) {
  const connections = Array.isArray(snapshot?.connections) ? snapshot.connections : [];
  const totals = { up: Number(snapshot?.uploadTotal) || 0, down: Number(snapshot?.downloadTotal) || 0 };
  const first = !state.totals;
  const coreRestarted = !first && (totals.up < state.totals.up || totals.down < state.totals.down);
  const deltas = [];
  const nextConns = new Map();
  for (const conn of connections) {
    const id = conn && conn.id;
    if (!id) continue;
    const up = Number(conn.upload) || 0;
    const down = Number(conn.download) || 0;
    // 首次采样时已有的连接，其字节发生在开始记账之前，只作基线。
    const prev = first || coreRestarted ? null : state.conns.get(id);
    const dUp = first ? 0 : Math.max(0, up - (prev ? prev.up : 0));
    const dDown = first ? 0 : Math.max(0, down - (prev ? prev.down : 0));
    nextConns.set(id, { up, down, conn, rateUp: dUp, rateDown: dDown });
    if (dUp || dDown) deltas.push({ conn, up: dUp, down: dDown });
  }
  let coreDelta = { up: 0, down: 0 };
  if (!first) {
    coreDelta = coreRestarted ? totals : { up: totals.up - state.totals.up, down: totals.down - state.totals.down };
  }
  const attributed = deltas.reduce((sum, d) => ({ up: sum.up + d.up, down: sum.down + d.down }), { up: 0, down: 0 });
  let residual = {
    up: Math.max(0, coreDelta.up - attributed.up),
    down: Math.max(0, coreDelta.down - attributed.down),
  };
  let estimated = { up: 0, down: 0 };
  if (!first && !coreRestarted) {
    const vanished = [...state.conns.entries()].filter(([id, entry]) => !nextConns.has(id) && entry.conn).map(([, entry]) => entry);
    if (vanished.length) {
      const ups = splitResidual(residual.up, vanished, entry => entry.rateUp || 0);
      const downs = splitResidual(residual.down, vanished, entry => entry.rateDown || 0);
      vanished.forEach((entry, i) => {
        if (ups[i] || downs[i]) deltas.push({ conn: entry.conn, up: ups[i], down: downs[i], estimated: true });
      });
      estimated = residual;
      residual = { up: 0, down: 0 };
    }
  }
  return {
    first,
    coreRestarted,
    deltas,
    estimated,
    unattributed: residual,
    nextState: { totals, conns: nextConns },
  };
}

function classifyConnection(conn) {
  const chains = Array.isArray(conn?.chains) ? conn.chains : [];
  const node = chains[0] || '';
  if (/^(REJECT|REJECT-DROP)$/i.test(node)) return { route: 'reject', node };
  if (!node || /^DIRECT$/i.test(node)) return { route: 'direct', node: 'DIRECT' };
  return { route: 'proxy', node };
}

function applyDeltas(day, { deltas, unattributed }, resolveApp, nowMs) {
  const hour = new Date(nowMs).getHours();
  for (const { conn, up, down, estimated } of deltas) {
    const { route, node } = classifyConnection(conn);
    if (route === 'reject') continue;
    const meta = conn.metadata || {};
    const host = String(meta.host || meta.destinationIP || '?').toLowerCase();
    if (route === 'direct') { day.direct.up += up; day.direct.down += down; continue; }
    const app = resolveApp(conn) || UNKNOWN_APP;
    day.proxied.up += up; day.proxied.down += down;
    if (estimated) { day.estimated.up += up; day.estimated.down += down; }
    day.byHour[hour].up += up; day.byHour[hour].down += down;
    addPair(day.byApp, app, up, down);
    addPair(day.byHost, host, up, down, MAX_HOSTS);
    addPair(day.byAppHost, `${app}\t${host}`, up, down, MAX_APP_HOSTS);
    addPair(day.byNode, node, up, down);
  }
  day.unattributed.up += unattributed.up;
  day.unattributed.down += unattributed.down;
}

function mergePairMaps(target, source) {
  for (const [key, row] of Object.entries(source || {})) addPair(target, key, Number(row.up) || 0, Number(row.down) || 0);
}

function sumPair(a, b) { return { up: a.up + (Number(b?.up) || 0), down: a.down + (Number(b?.down) || 0) }; }

function topRows(map, limit, totalKey = null) {
  return Object.entries(map)
    .map(([key, row]) => ({ key, up: row.up, down: row.down, total: row.up + row.down }))
    .filter(row => row.key !== totalKey)
    .sort((a, b) => b.total - a.total)
    .slice(0, limit);
}

function aggregateDays(days, { limit = 15 } = {}) {
  const sum = { proxied: { up: 0, down: 0 }, direct: { up: 0, down: 0 }, unattributed: { up: 0, down: 0 }, estimated: { up: 0, down: 0 } };
  const byApp = {}; const byHost = {}; const byAppHost = {}; const byNode = {};
  const byHour = Array.from({ length: 24 }, () => ({ up: 0, down: 0 }));
  let recordedMs = 0; let firstAt = null; let lastAt = null;
  const daily = [];
  for (const day of days) {
    sum.proxied = sumPair(sum.proxied, day.proxied);
    sum.direct = sumPair(sum.direct, day.direct);
    sum.unattributed = sumPair(sum.unattributed, day.unattributed);
    sum.estimated = sumPair(sum.estimated, day.estimated);
    mergePairMaps(byApp, day.byApp); mergePairMaps(byHost, day.byHost);
    mergePairMaps(byAppHost, day.byAppHost); mergePairMaps(byNode, day.byNode);
    (day.byHour || []).forEach((row, i) => { if (byHour[i]) { byHour[i].up += row.up || 0; byHour[i].down += row.down || 0; } });
    recordedMs += Number(day.recordedMs) || 0;
    if (day.firstAt && (!firstAt || day.firstAt < firstAt)) firstAt = day.firstAt;
    if (day.lastAt && (!lastAt || day.lastAt > lastAt)) lastAt = day.lastAt;
    daily.push({ date: day.date, up: day.proxied?.up || 0, down: day.proxied?.down || 0, recordedMs: Number(day.recordedMs) || 0 });
  }
  const apps = topRows(byApp, limit).map(row => ({
    ...row,
    hosts: topRows(Object.fromEntries(Object.entries(byAppHost)
      .filter(([key]) => key.startsWith(`${row.key}\t`))
      .map(([key, value]) => [key.slice(row.key.length + 1), value])), 5),
  }));
  return {
    ...sum,
    apps,
    hosts: topRows(byHost, limit),
    nodes: topRows(byNode, 8),
    byHour,
    daily,
    recordedMs,
    firstAt,
    lastAt,
  };
}

function rangeDates(range, nowMs) {
  const today = new Date(nowMs);
  const keys = [];
  if (range === 'month') {
    for (let d = 1; d <= today.getDate(); d += 1) keys.push(localDateKey(new Date(today.getFullYear(), today.getMonth(), d).getTime()));
    return keys;
  }
  const count = range === '7d' ? 7 : range === '30d' ? 30 : 1;
  for (let i = count - 1; i >= 0; i -= 1) keys.push(localDateKey(new Date(today.getFullYear(), today.getMonth(), today.getDate() - i).getTime()));
  return keys;
}

function createVpnTrafficRecorder(options = {}) {
  const dir = options.dir;
  if (!dir) throw new Error('vpn traffic dir required');
  const fsApi = options.fs || fs;
  const httpApi = options.http || http;
  const now = options.now || Date.now;
  const pid = options.pid || process.pid;
  const intervalMs = Math.max(500, Number(options.intervalMs) || 2_000);
  const flushMs = Math.max(1_000, Number(options.flushMs) || 60_000);
  const configPath = options.configPath || path.join(process.env.APPDATA || '', 'io.github.clash-verge-rev.clash-verge-rev', 'clash-verge.yaml');
  // netstat / tasklist start from a worker thread: creating the process blocks
  // the calling thread on Windows (measured 751 ms on the live Hub, see
  // core/off-main-exec.js). Same programs, arguments and output.
  const offMain = options.offMain === false ? null : sharedOffMainExecFile();
  const run = options.execFile || ((file, args) => {
    const execOptions = { windowsHide: true, timeout: 5_000, maxBuffer: 8 * 1024 * 1024 };
    if (offMain) return offMain(file, args, execOptions).then(result => result.stdout);
    return new Promise((resolve, reject) => {
      execFile(file, args, execOptions, (error, stdout) => (error ? reject(error) : resolve(stdout)));
    });
  });
  const isPidAlive = options.isPidAlive || (target => { try { process.kill(target, 0); return true; } catch (error) { return error.code === 'EPERM'; } });
  const listPipes = options.listPipes || listVergeMihomoPipes;
  const lockPath = path.join(dir, 'recorder.lock');

  let timer = null;
  let stopped = true;
  // stop() 之后不再取租约或写盘，即使有一轮采样还在途中。
  let disposed = false;
  let holding = false;
  let day = null;
  let dirty = false;
  let lastFlushAt = 0;
  let lastLeaseAt = 0;
  let snapState = { totals: null, conns: new Map() };
  let lastSampleAt = 0;
  let lastError = null;
  let liveRate = null;
  let controller = null;
  let controllerReadAt = 0;
  const portOwners = new Map();
  const pidNames = new Map();
  // 连接结束后它的本地端口会从 netstat 消失，所以按连接 id 记住已识别的程序。
  let appByConn = new Map();
  let ownerAttempted = new Set();
  let ownersRefreshedAt = 0;
  let ownersPending = null;

  const dayPath = date => path.join(dir, `${date}.json`);

  function readDay(date) {
    try {
      const parsed = JSON.parse(fsApi.readFileSync(dayPath(date), 'utf8'));
      if (parsed && parsed.version === FILE_VERSION && parsed.date === date) return { ...emptyDay(date), ...parsed };
    } catch { /* 缺失或损坏的一天按空处理 */ }
    return null;
  }

  function writeAtomic(file, text) {
    fsApi.mkdirSync(dir, { recursive: true });
    const tmp = `${file}.${pid}.tmp`;
    fsApi.writeFileSync(tmp, text);
    fsApi.renameSync(tmp, file);
  }

  function flush(force = false) {
    if (!day || !dirty) return;
    if (!force && now() - lastFlushAt < flushMs) return;
    try {
      writeAtomic(dayPath(day.date), JSON.stringify(day));
      dirty = false;
      lastFlushAt = now();
    } catch (error) { lastError = `write-failed: ${error.message}`; }
  }

  function readLease() {
    try { return JSON.parse(fsApi.readFileSync(lockPath, 'utf8')); } catch { return null; }
  }

  function tryHoldLease() {
    const t = now();
    const lease = readLease();
    const ownedByOther = lease && lease.pid !== pid && t - (Number(lease.heartbeatAt) || 0) < LEASE_STALE_MS && isPidAlive(lease.pid);
    if (ownedByOther) {
      if (holding) releaseHolding();
      return false;
    }
    try {
      writeAtomic(lockPath, JSON.stringify({ pid, heartbeatAt: t }));
      const check = readLease();
      if (!check || check.pid !== pid) { if (holding) releaseHolding(); return false; }
    } catch { return holding; }
    lastLeaseAt = t;
    if (!holding) {
      holding = true;
      snapState = { totals: null, conns: new Map() };
    }
    return true;
  }

  function releaseHolding() {
    flush(true);
    holding = false;
    day = null;
    liveRate = null;
  }

  async function readController() {
    if (controller && now() - controllerReadAt < 60_000) return controller;
    const config = await fsApi.promises.readFile(configPath, 'utf8');
    // 只连 Clash Verge 自己的命名管道，不连配置里的任意地址。
    const candidates = controllerPipeCandidates(config, listPipes);
    if (!candidates.length) throw new Error('controller-pipe-missing');
    controller = {
      candidates,
      socketPath: controller && candidates.includes(controller.socketPath) ? controller.socketPath : candidates[0],
      secret: yamlScalar(config, 'secret'),
      proxyPort: Number(yamlScalar(config, 'mixed-port')) || Number(yamlScalar(config, 'port')) || 7890,
    };
    controllerReadAt = now();
    return controller;
  }

  async function readConnections(ctl) {
    const order = [ctl.socketPath, ...ctl.candidates.filter(pipe => pipe !== ctl.socketPath)];
    let lastFailure = null;
    for (const socketPath of order) {
      try {
        const snapshot = await requestJson(httpApi, socketPath, ctl.secret, '/connections');
        ctl.socketPath = socketPath;
        return snapshot;
      } catch (error) { lastFailure = error; }
    }
    throw lastFailure || new Error('controller-unavailable');
  }

  async function refreshOwners(proxyPort) {
    if (ownersPending) return ownersPending;
    ownersPending = (async () => {
      try {
        const owners = parseNetstatOwners(await run('netstat', ['-ano', '-p', 'TCP']), proxyPort);
        if (portOwners.size > 4_000) portOwners.clear();
        for (const [port, owner] of owners) portOwners.set(port, owner);
        if ([...owners.values()].some(owner => !pidNames.has(owner))) {
          const names = parseTasklist(await run('tasklist', ['/fo', 'csv', '/nh']));
          for (const [owner, name] of names) pidNames.set(owner, name);
        }
      } catch { /* 拿不到端口归属就记为未识别 */ }
      ownersRefreshedAt = now();
    })().finally(() => { ownersPending = null; });
    return ownersPending;
  }

  function resolveApp(conn) {
    if (appByConn.has(conn.id)) return appByConn.get(conn.id);
    const meta = conn.metadata || {};
    const fromClash = normalizeAppName(meta.process || meta.processPath);
    if (fromClash) return fromClash;
    const owner = portOwners.get(String(meta.sourcePort || ''));
    return owner ? normalizeAppName(pidNames.get(owner)) || `PID ${owner}` : null;
  }

  async function tick() {
    if (disposed) return;
    const t = now();
    if (t - lastLeaseAt > 5_000 || !holding) {
      if (!tryHoldLease()) return;
    }
    let ctl;
    let snapshot;
    try {
      ctl = await readController();
      snapshot = await readConnections(ctl);
    } catch (error) {
      controller = null;
      lastError = error.message || 'controller-unavailable';
      snapState = { totals: null, conns: new Map() };
      liveRate = null;
      return;
    }
    if (disposed) return;
    lastError = null;
    const result = diffSnapshot(snapState, snapshot);
    const sampleAt = now();

    // 只为「还没尝试识别过」的新连接跑 netstat，避免对认不出的连接每轮反复启动子进程。
    const unseen = (snapshot.connections || []).filter(c => c && c.id && !appByConn.has(c.id) && !ownerAttempted.has(c.id)
      && !normalizeAppName(c.metadata?.process || c.metadata?.processPath)
      && !portOwners.has(String(c.metadata?.sourcePort || '')));
    if (unseen.length && sampleAt - ownersRefreshedAt > 3_000) {
      await refreshOwners(ctl.proxyPort);
      if (disposed) return;
      for (const c of unseen) ownerAttempted.add(c.id);
    }

    const nextAppByConn = new Map();
    for (const conn of snapshot.connections || []) {
      const app = conn && conn.id ? resolveApp(conn) : null;
      if (app) nextAppByConn.set(conn.id, app);
    }
    const date = localDateKey(sampleAt);
    if (!day || day.date !== date) {
      flush(true);
      day = readDay(date) || emptyDay(date);
    }
    if (!result.first) {
      applyDeltas(day, result, resolveApp, sampleAt);
      const elapsed = sampleAt - lastSampleAt;
      // 采样间隔过长（休眠、卡顿）只记增量，不把空档算进覆盖时长。
      if (elapsed > 0 && elapsed < intervalMs * 5) day.recordedMs += elapsed;
      if (elapsed > 0) {
        let up = 0; let down = 0;
        for (const d of result.deltas) if (classifyConnection(d.conn).route === 'proxy') { up += d.up; down += d.down; }
        liveRate = { upBps: up * 1000 / elapsed, downBps: down * 1000 / elapsed, at: sampleAt };
      }
    }
    day.firstAt = day.firstAt || sampleAt;
    day.lastAt = sampleAt;
    dirty = true;
    lastSampleAt = sampleAt;
    snapState = result.nextState;
    appByConn = nextAppByConn;
    const liveIds = new Set((snapshot.connections || []).map(c => c && c.id));
    ownerAttempted = new Set([...ownerAttempted].filter(id => liveIds.has(id)));
    flush(false);
  }

  function schedule() {
    if (stopped) return;
    timer = setTimeout(async () => {
      try { await tick(); } catch (error) { lastError = error.message; }
      schedule();
    }, intervalMs);
    timer.unref?.();
  }

  function pruneOldFiles() {
    try {
      const cutoff = localDateKey(now() - RETENTION_DAYS * 86_400_000);
      for (const name of fsApi.readdirSync(dir)) {
        const match = name.match(/^(\d{4}-\d{2}-\d{2})\.json$/);
        if (match && match[1] < cutoff) fsApi.unlinkSync(path.join(dir, name));
      }
    } catch { /* 目录还不存在 */ }
  }

  function start() {
    if (!stopped) return;
    stopped = false;
    disposed = false;
    pruneOldFiles();
    schedule();
  }

  function stop() {
    stopped = true;
    disposed = true;
    clearTimeout(timer);
    if (holding) {
      flush(true);
      const lease = readLease();
      if (lease && lease.pid === pid) { try { fsApi.unlinkSync(lockPath); } catch { /* ignore */ } }
      holding = false;
    }
  }

  function loadDays(dates) {
    return dates.map(date => (holding && day && day.date === date ? day : readDay(date))).filter(Boolean);
  }

  function report(range = 'today') {
    const safeRange = ['today', '7d', 'month', '30d'].includes(range) ? range : 'today';
    const t = now();
    const dates = rangeDates(safeRange, t);
    const summary = aggregateDays(loadDays(dates));
    let earliest = null;
    try {
      earliest = fsApi.readdirSync(dir).map(name => name.match(/^(\d{4}-\d{2}-\d{2})\.json$/)?.[1]).filter(Boolean).sort()[0] || null;
    } catch { /* none yet */ }
    const lease = readLease();
    const recorderAlive = holding || (lease && t - (Number(lease.heartbeatAt) || 0) < LEASE_STALE_MS && isPidAlive(lease.pid));
    return {
      range: safeRange,
      dates,
      generatedAt: t,
      ...summary,
      status: {
        recording: !!recorderAlive,
        holder: holding ? 'self' : recorderAlive ? 'other' : 'none',
        holderPid: holding ? pid : lease?.pid || null,
        lastSampleAt: holding ? lastSampleAt || null : null,
        error: holding ? lastError : null,
        earliestDate: earliest,
        liveRate: holding && liveRate && t - liveRate.at < intervalMs * 3 ? liveRate : null,
      },
    };
  }

  return { start, stop, report, tick, flush: () => flush(true), _state: () => ({ holding, day }) };
}

module.exports = {
  createVpnTrafficRecorder,
  diffSnapshot,
  applyDeltas,
  aggregateDays,
  classifyConnection,
  parseNetstatOwners,
  parseTasklist,
  rangeDates,
  localDateKey,
  emptyDay,
};
