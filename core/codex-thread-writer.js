'use strict';

// Codex thread writer 占用探测（2026-09-04）。
//
// Codex 对每个 thread 只允许一个活写者，锁落在
// `<CODEX_HOME>/thread-writer-locks/<thread-id>.lock`（0 字节，纯 OS 建议锁，
// 进程一死自动释放，所以磁盘上留着的 .lock 文件本身不代表还被占用）。
// 撞上时 `codex resume <sid>` 直接失败：
//   thread <sid> already has an active writer (code -32600)
//
// 这个错误对 Agent 联赛特别贵：席位起不来 → 等满 120 秒就绪预算 → 判技术弃权，
// 整整一天的决策白掉，而且每天重复（2026-09-02/03/04 连续三天，6 个 Codex 席位
// 6 次全挂在 draft 阶段）。
//
// 为什么按进程查而不是探锁文件：Node 没有 Windows FileShare 语义，唯一能判断
// 「锁是不是还被持有」的文件级手段是 unlink/rename 试探，而那是破坏性的。
// 枚举进程是只读的，还能顺带告诉用户是哪个 PID 占着 —— 报错能落到可操作的层面。
//
// 判不出来时一律当作「没被占用」：多试一次 resume 最多退回今天的行为，
// 而误判成占用会把本可以续上的会话无谓地降级成 fresh，丢掉上下文。

const { execFile: execFileCallback } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFileCallback);

const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_BUFFER_BYTES = 8 * 1024 * 1024;

// 只查 codex.exe：真正持有 writer 锁的是它，node 包装层不持锁。
// 在 CIM 层用 -Filter 过滤，全机进程枚举那 800ms 的开销就不用付了。
const PS_SCRIPT = `
$ErrorActionPreference = 'SilentlyContinue'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$rows = New-Object System.Collections.ArrayList
foreach ($c in (Get-CimInstance Win32_Process -Filter "Name='codex.exe'")) {
  [void]$rows.Add([PSCustomObject]@{
    pid = [int]$c.ProcessId
    cmd = [string]$c.CommandLine
  })
}
ConvertTo-Json -Depth 3 -Compress @{ processes = @($rows) }
`;

function encodePowerShellCommand(script) {
  return Buffer.from(String(script), 'utf16le').toString('base64');
}

function toArray(value) {
  if (Array.isArray(value)) return value;
  return value == null ? [] : [value];
}

function normalizeSid(value) {
  return String(value || '').trim().toLowerCase();
}

/**
 * 找出哪些 Codex thread 正被活着的进程占着写者位。
 *
 * @param {string[]} sids                    要查的 thread id
 * @param {object}   [options]
 * @param {number[]} [options.excludePids]   忽略这些 PID（例如本 Hub 自己刚起的进程）
 * @param {Function} [options.execFile]      注入用；默认 promisify(child_process.execFile)
 * @param {object}   [options.logger]
 * @returns {Promise<Map<string, Array<{pid:number, cmd:string}>>>} 只含真的被占用的 sid
 */
async function findCodexThreadWriters(sids, options = {}) {
  const wanted = [...new Set(toArray(sids).map(normalizeSid).filter(Boolean))];
  const occupied = new Map();
  if (!wanted.length) return occupied;
  if (process.platform !== 'win32') return occupied;

  const execFile = options.execFile || execFileAsync;
  const logger = options.logger || console;
  const exclude = new Set(toArray(options.excludePids).map(Number).filter((pid) => Number.isFinite(pid) && pid > 0));

  let processes;
  try {
    const result = await execFile(options.powershellPath || 'powershell.exe', [
      '-NoProfile', '-NonInteractive', '-EncodedCommand', encodePowerShellCommand(PS_SCRIPT),
    ], {
      windowsHide: true,
      timeout: Math.max(2_000, Number(options.timeoutMs) || DEFAULT_TIMEOUT_MS),
      maxBuffer: MAX_BUFFER_BYTES,
      encoding: 'utf8',
    });
    const stdout = String((result && result.stdout) || '').trim();
    if (!stdout) return occupied;
    processes = toArray(JSON.parse(stdout).processes);
  } catch (error) {
    // 查不到就当没占用 —— 见文件头「判不出来时」那一段。
    logger.warn('[codex-thread-writer] 进程枚举失败，按未占用处理：', error && error.message);
    return occupied;
  }

  for (const row of processes) {
    const pid = Number(row && row.pid);
    if (!Number.isFinite(pid) || pid <= 0 || exclude.has(pid)) continue;
    const cmd = String((row && row.cmd) || '');
    if (!cmd) continue;
    const haystack = cmd.toLowerCase();
    for (const sid of wanted) {
      if (!haystack.includes(sid)) continue;
      if (!occupied.has(sid)) occupied.set(sid, []);
      occupied.get(sid).push({ pid, cmd });
    }
  }
  return occupied;
}

function describeWriters(writers) {
  return toArray(writers).map((row) => `PID ${row.pid}`).join(' / ');
}

module.exports = {
  PS_SCRIPT,
  describeWriters,
  encodePowerShellCommand,
  findCodexThreadWriters,
};
