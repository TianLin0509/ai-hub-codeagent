'use strict';

// 全机进程采集。刻意不引第三方依赖（package.json 设了 npmRebuild:false，原生模块
// 会额外增加打包成本，也更容易踩 node_modules 半坏那条铁律），照 system-telemetry.js
// 的老路子走：execFile 拉一次外部命令 + TTL 缓存 + pending 去重。
//
// 实测开销（本机 695 进程）：
//   Get-Process 单独取                  41 ms
//   Win32_Process 含 CommandLine       548 ms   ← 血缘和命令行都靠它，且 CommandLine 免费
//   Win32_PerfRawData_PerfProc_Process 8289 ms  ← 禁用
//   powershell -NoProfile 冷启动        266 ms
// 所以整包约 800 ms：只能按需/慢定时调，绝不能挂到 renderer 那条 3 秒资源心跳上。

const { execFile: execFileCallback } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFileCallback);

const DEFAULT_TTL_MS = 20_000;
const DEFAULT_TIMEOUT_MS = 20_000;
const MAX_BUFFER_BYTES = 32 * 1024 * 1024;

// 一次 CIM 调用拿血缘 + 命令行 + 启动时间，再用 Get-Process 补工作集/窗口/CPU 时间，
// 按 pid 合并后输出一行 JSON。每进程属性都单独 try，个别受保护进程读不到不影响整体。
const PS_SCRIPT = `
$ErrorActionPreference = 'SilentlyContinue'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$live = @{}
foreach ($g in Get-Process) { $live[[int]$g.Id] = $g }

$rows = New-Object System.Collections.ArrayList
foreach ($c in (Get-CimInstance Win32_Process)) {
  $id = [int]$c.ProcessId
  $g = $live[$id]

  $ws = 0; $priv = 0; $win = 0; $title = ''; $cpuMs = -1
  if ($g) {
    try { $ws = [int64]$g.WorkingSet64 } catch {}
    try { $priv = [int64]$g.PrivateMemorySize64 } catch {}
    try { if ($g.MainWindowHandle -ne 0) { $win = 1; $title = [string]$g.MainWindowTitle } } catch {}
    try { $cpuMs = [int64]$g.TotalProcessorTime.TotalMilliseconds } catch {}
  }

  $started = 0
  try { if ($c.CreationDate) { $started = [int64]([System.DateTimeOffset]$c.CreationDate).ToUnixTimeMilliseconds() } } catch {}

  [void]$rows.Add([PSCustomObject]@{
    pid       = $id
    ppid      = [int]$c.ParentProcessId
    name      = [string]$c.Name
    cmd       = [string]$c.CommandLine
    startedAt = $started
    ws        = $ws
    priv      = $priv
    win       = $win
    title     = $title
    cpuMs     = $cpuMs
  })
}

$payload = [PSCustomObject]@{
  sampledAt = [int64]([System.DateTimeOffset]::UtcNow).ToUnixTimeMilliseconds()
  count     = $rows.Count
  processes = @($rows)
}
$payload | ConvertTo-Json -Compress -Depth 4
`;

function encodePowerShellCommand(script) {
  return Buffer.from(script, 'utf16le').toString('base64');
}

function toArray(value) {
  if (Array.isArray(value)) return value;
  if (value == null) return [];
  return [value];
}

function normalizeRow(row) {
  const pid = Number(row && row.pid);
  if (!Number.isFinite(pid) || pid <= 0) return null;
  const ppid = Number(row.ppid);
  const cpuMs = Number(row.cpuMs);
  return {
    pid,
    ppid: Number.isFinite(ppid) && ppid > 0 ? ppid : 0,
    name: String(row.name || ''),
    cmd: String(row.cmd || ''),
    startedAt: Number(row.startedAt) || 0,
    wsBytes: Number(row.ws) || 0,
    privBytes: Number(row.priv) || 0,
    hasWindow: row.win === 1 || row.win === '1' || row.win === true,
    windowTitle: String(row.title || ''),
    cpuMs: Number.isFinite(cpuMs) && cpuMs >= 0 ? cpuMs : null,
  };
}

// PID 会被系统回收复用，所以任何跨采样的比对都必须带上启动时间做联合键，
// 否则「上一轮那个发呆的进程」可能已经换成一个刚起的新程序。
function identityKey(proc) {
  return `${proc.pid}:${proc.startedAt}`;
}

function buildChildrenMap(processes) {
  const children = new Map();
  for (const proc of processes) {
    if (!proc.ppid) continue;
    if (!children.has(proc.ppid)) children.set(proc.ppid, []);
    children.get(proc.ppid).push(proc.pid);
  }
  return children;
}

// 广度优先收集整棵子树（含根）。带 seen 防环——Windows 上 PID 复用可能造出假环。
function collectTree(rootPid, childrenMap) {
  const seen = new Set();
  const queue = [Number(rootPid)];
  while (queue.length > 0) {
    const current = queue.shift();
    if (seen.has(current)) continue;
    seen.add(current);
    const kids = childrenMap.get(current);
    if (kids) for (const kid of kids) queue.push(kid);
  }
  return seen;
}

function createProcessInspector(options = {}) {
  const execFile = options.execFile || execFileAsync;
  const now = options.now || Date.now;
  const logger = options.logger || console;
  const ttlMs = Math.max(2_000, Number(options.ttlMs) || DEFAULT_TTL_MS);
  const timeoutMs = Math.max(3_000, Number(options.timeoutMs) || DEFAULT_TIMEOUT_MS);
  const powershellPath = options.powershellPath || 'powershell.exe';

  const cpuCount = Math.max(1, Number(options.cpuCount) || require('os').cpus().length || 1);

  let cache = null;
  let pending = null;
  // 上一轮的 CPU 累计时间，用来判断「这进程到底还在不在干活」。
  let previousCpu = new Map();
  let previousSampledAt = 0;

  async function runOnce() {
    const encoded = encodePowerShellCommand(PS_SCRIPT);
    const result = await execFile(powershellPath, [
      '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded,
    ], {
      windowsHide: true,
      timeout: timeoutMs,
      maxBuffer: MAX_BUFFER_BYTES,
      encoding: 'utf8',
    });

    const stdout = String((result && result.stdout) || '').trim();
    if (!stdout) throw new Error('process enumeration returned empty output');

    const parsed = JSON.parse(stdout);
    const processes = toArray(parsed && parsed.processes)
      .map(normalizeRow)
      .filter(Boolean);
    if (processes.length === 0) throw new Error('process enumeration returned no rows');

    const sampledAt = now();
    const nextCpu = new Map();
    for (const proc of processes) {
      const key = identityKey(proc);
      if (proc.cpuMs != null) nextCpu.set(key, proc.cpuMs);
      const before = previousCpu.get(key);
      // cpuDeltaMs === null 表示「这是第一次见到它」，判不了忙闲；
      // === 0 才是实打实的两次采样之间一点 CPU 都没用。
      proc.cpuDeltaMs = (before != null && proc.cpuMs != null)
        ? Math.max(0, proc.cpuMs - before)
        : null;
    }
    previousCpu = nextCpu;

    // 两次采样的间隔。有了它才能把 cpuDeltaMs 换算成「占了多少 CPU」，
    // 否则只能给出「动过 / 没动过」这种二值判断——而残留浏览器的后台定时器
    // 总会让它落到「动过」，看上去像还在干活，其实占用可以忽略。
    const cpuWindowMs = previousSampledAt > 0 ? Math.max(1, sampledAt - previousSampledAt) : null;
    previousSampledAt = sampledAt;

    const byPid = new Map(processes.map(proc => [proc.pid, proc]));
    return {
      sampledAt,
      cpuWindowMs,
      cpuCount,
      totalProcesses: processes.length,
      processes,
      byPid,
      childrenMap: buildChildrenMap(processes),
    };
  }

  async function snapshot(sampleOptions = {}) {
    const force = sampleOptions.force === true;
    const at = now();
    if (!force && cache && at - cache.sampledAt < ttlMs) return cache;
    if (pending) return pending;
    pending = (async () => {
      try {
        const value = await runOnce();
        cache = value;
        return value;
      } catch (err) {
        logger.warn('[群聊] process-inspector 采集失败:', err && err.message);
        // 采集失败时宁可回上一轮的旧数据，也不要把「空快照」当成「全机没进程」——
        // 后者会让分类器把所有东西都算成已消失，是个危险的误判方向。
        if (cache) return cache;
        throw err;
      }
    })().finally(() => { pending = null; });
    return pending;
  }

  return {
    snapshot,
    getCached: () => cache,
    resetCpuBaseline: () => { previousCpu = new Map(); },
  };
}

module.exports = {
  DEFAULT_TTL_MS,
  PS_SCRIPT,
  buildChildrenMap,
  collectTree,
  createProcessInspector,
  encodePowerShellCommand,
  identityKey,
  normalizeRow,
};
