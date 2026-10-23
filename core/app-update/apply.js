'use strict';
// 应用增量更新（2026-10-13，公司版）。运行中的程序锁着 app.asar，不能原地替换，所以：
//   1. 解包到暂存目录并逐个核对 sha256；
//   2. 写一份替换计划（plan.json）和一个 PowerShell 小脚本；
//   3. 用户点「立即重启」：主进程隐藏启动小脚本后退出；脚本等这个进程结束 → 备份要替换的文件 →
//      逐个复制新文件 → 再核对 sha256 → 任何一步失败就把备份全部还原 → 重新打开程序；
//   4. 结果写进 last-result.json，下次启动由界面读出来告诉用户（成功 / 失败已回滚 + 原因）。
// Electron 会把名为 *.asar 的文件当成压缩包拦截（写 app.asar 会报 Invalid package），用它提供的原始文件接口。
const fs = (() => { try { return require('original-fs'); } catch (_) { return require('fs'); } })();
const path = require('path');
const { spawn } = require('child_process');
const { unpackPayload } = require('./payload');

const HELPER = String.raw`param([string]$Plan)
$ErrorActionPreference = 'Stop'
$p = Get-Content -LiteralPath $Plan -Raw -Encoding UTF8 | ConvertFrom-Json
function Write-Result($ok, $reason, $rolledBack) {
  $r = [ordered]@{ ok = $ok; version = $p.version; from = $p.from; reason = $reason; rolledBack = $rolledBack; at = (Get-Date).ToString('o') }
  ($r | ConvertTo-Json -Compress) | Set-Content -LiteralPath $p.resultFile -Encoding UTF8
}
function Relaunch {
  if ($p.relaunch -and $p.exe) {
    # Start-Process 用空格拼参数，带空格的要自己加引号。
    $argList = @($p.args | Where-Object { $_ -ne $null -and $_ -ne '' } | ForEach-Object { if ($_ -match '\s') { '"' + $_ + '"' } else { $_ } })
    if ($argList.Count) { Start-Process -FilePath $p.exe -ArgumentList $argList -WorkingDirectory (Split-Path $p.exe) }
    else { Start-Process -FilePath $p.exe -WorkingDirectory (Split-Path $p.exe) }
  }
}
$deadline = (Get-Date).AddSeconds([int]$p.waitSeconds)
while ($p.pid -and (Get-Process -Id ([int]$p.pid) -ErrorAction SilentlyContinue)) {
  if ((Get-Date) -gt $deadline) { Write-Result $false '等待程序退出超时，没有替换任何文件' $false; Relaunch; exit 1 }
  Start-Sleep -Milliseconds 300
}
$backup = Join-Path $p.stagingDir 'backup'
New-Item -ItemType Directory -Force -Path $backup | Out-Null
$done = @()
try {
  foreach ($f in $p.files) {
    $dest = Join-Path $p.resourcesDir $f.path
    $bak = Join-Path $backup $f.path
    $existed = Test-Path -LiteralPath $dest
    if ($existed) { New-Item -ItemType Directory -Force -Path (Split-Path $bak) | Out-Null; Copy-Item -LiteralPath $dest -Destination $bak -Force }
    $done += [pscustomobject]@{ dest = $dest; bak = $bak; existed = $existed }
    New-Item -ItemType Directory -Force -Path (Split-Path $dest) | Out-Null
    $copied = $false
    for ($i = 0; $i -lt 40 -and -not $copied; $i++) {
      try { Copy-Item -LiteralPath (Join-Path $p.newDir $f.path) -Destination $dest -Force; $copied = $true }
      catch { if ($i -eq 39) { throw "替换 $($f.path) 失败：文件被占用（可能另一个窗口还开着）" }; Start-Sleep -Milliseconds 500 }
    }
    $h = (Get-FileHash -LiteralPath $dest -Algorithm SHA256).Hash.ToLower()
    if ($h -ne $f.sha256) { throw "替换后 $($f.path) 校验不一致" }
  }
  if ($p.simulateFailure) { throw $p.simulateFailure }
  Write-Result $true '' $false
  Remove-Item -LiteralPath $p.newDir -Recurse -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $backup -Recurse -Force -ErrorAction SilentlyContinue
} catch {
  $reason = $_.Exception.Message
  $restored = $true
  foreach ($d in $done) {
    try {
      if ($d.existed) { Copy-Item -LiteralPath $d.bak -Destination $d.dest -Force }
      elseif (Test-Path -LiteralPath $d.dest) { Remove-Item -LiteralPath $d.dest -Force }
    } catch { $restored = $false }
  }
  Write-Result $false $reason $restored
}
Relaunch
`;

function stagingPaths(dataDir) {
  const root = path.join(dataDir, 'app-update');
  return { root, downloads: path.join(root, 'downloads'), newDir: path.join(root, 'new'), plan: path.join(root, 'plan.json'),
    helper: path.join(root, 'apply-update.ps1'), result: path.join(root, 'last-result.json') };
}

// 解包并写替换计划；不动安装目录。
function stageIncremental({ dataDir, payloadFile, resourcesDir, version, from, exe, args = [], pid = process.pid, simulateFailure = null, relaunch = true }) {
  const p = stagingPaths(dataDir);
  fs.rmSync(p.newDir, { recursive: true, force: true });
  fs.mkdirSync(p.newDir, { recursive: true });
  const files = unpackPayload(payloadFile, p.newDir, { resourcesDir });
  const plan = { version, from, pid, exe, args, relaunch, waitSeconds: 90, resourcesDir, newDir: p.newDir, stagingDir: p.root,
    resultFile: p.result, files, ...(simulateFailure ? { simulateFailure } : {}) };
  fs.writeFileSync(p.plan, JSON.stringify(plan, null, 2), 'utf8');
  fs.writeFileSync(p.helper, '﻿' + HELPER, 'utf8');
  return { plan, paths: p };
}

// 隐藏启动替换脚本（与本进程脱离，本进程退出后它继续跑）。
// 本机实测（2026-10-13）：直接 detached 启动 powershell.exe 一行都不执行；经 cmd 的 start /b 转一手
// 才能脱离本进程、在本进程退出后继续跑完，且不弹窗。/s 让 cmd 原样保留引号里的路径（可带空格）。
function launchHelper(paths, { env = process.env, spawnImpl = spawn } = {}) {
  const line = `/d /s /c "start "" /b powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "${paths.helper}" -Plan "${paths.plan}""`;
  const child = spawnImpl(process.env.ComSpec || 'cmd.exe', [line], { detached: true, stdio: 'ignore', windowsHide: true, windowsVerbatimArguments: true, env });
  if (child && typeof child.unref === 'function') child.unref();
  return child;
}

// 上次更新的结果：读出来后改名为 .seen，只报告一次。
function takeLastResult(dataDir) {
  const p = stagingPaths(dataDir);
  try {
    const result = JSON.parse(fs.readFileSync(p.result, 'utf8').replace(/^﻿/, ''));
    fs.renameSync(p.result, p.result + '.seen');
    return result;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    return { ok: false, reason: `读取上次更新结果失败：${error.message}` };
  }
}

module.exports = { HELPER, stagingPaths, stageIncremental, launchHelper, takeLastResult };
