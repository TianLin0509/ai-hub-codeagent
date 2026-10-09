# tools/hub-escape-foreground.ps1
# 救援鼠标所在 Hub 窗口 —— maintainer 2026-05-21 v2
#
# 用法（一般通过桌面快捷方式 Ctrl+Alt+H 触发，跑在 Hidden PS 窗口）：
#   .\tools\hub-escape-foreground.ps1
#
# 工作流：
#   把鼠标移到要救的 Hub 窗口上方（不用点击/不用切焦点，悬停即可）-> 按 Ctrl+Alt+H
#
# 原理：
#   1. WindowFromPoint(GetCursorPos()) 拿鼠标下窗口 hwnd
#   2. GetAncestor(hwnd, GA_ROOT) 找 top-level window（避免拿到 child control）
#   3. GetWindowThreadProcessId -> 上溯 ParentProcessId 收集祖先 PID 集
#   4. 扫 <DataDir>/control/*.json，obj.pid 在祖先集 -> 精确救该 Hub
#   5. 鼠标不在任何 Hub 上 -> 全员 fallback：对所有活 Hub 都调一次 escape-home
#      （escape-home 对正常 Hub 也安全：只关预览/清选中/展 sidebar）
#
# 为啥不用 GetForegroundWindow：
#   webview 锁死 Hub 时焦点切不进 Hub，前台是 explorer/桌面，会救错；
#   鼠标可以自由移动，悬停定位不依赖焦点。
#
# 诊断日志：~\hub-escape-fg.log（每次调用追加一行）

param(
  [string]$DataDir = "$env:USERPROFILE\.ai-hub-community"
)

$ErrorActionPreference = 'Stop'
$scriptDir = Split-Path $MyInvocation.MyCommand.Path -Parent
$coreScript = Join-Path $scriptDir 'hub-escape.ps1'
if (-not (Test-Path $coreScript)) {
  Write-Error "core script missing: $coreScript"
  exit 1
}

$logPath = Join-Path $env:USERPROFILE 'hub-escape-fg.log'
function Log-Line($msg) {
  $ts = Get-Date -Format 'yyyy-MM-dd HH:mm:ss.fff'
  Add-Content -Path $logPath -Value "[$ts] $msg" -Encoding utf8
}
Log-Line "=== invoked PSPID=$PID ==="

# --- 1. Win32 API ---
if (-not ('Win32Hub' -as [type])) {
  Add-Type @"
using System;
using System.Runtime.InteropServices;
public struct POINT { public int X; public int Y; }
public class Win32Hub {
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT lpPoint);
  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT pt);
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr hwnd, uint flags);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
}
"@
}

# --- 2. helpers ---
function Get-AncestorPids([uint32]$startPid) {
  $set = New-Object System.Collections.Generic.HashSet[uint32]
  $cur = $startPid
  $null = "$cur"  # PS 5.1 parser nudge (see git history)
  $depth = 0
  while ($cur -gt 0 -and $depth -lt 20) {
    [void]$set.Add($cur)
    try {
      $proc = Get-CimInstance Win32_Process -Filter "ProcessId=$cur" -ErrorAction Stop
      if (-not $proc) { break }
      $parent = [uint32]$proc.ParentProcessId
      if ($parent -eq $cur -or $parent -eq 0) { break }
      $cur = $parent
    } catch { break }
    $depth++
  }
  return ,$set  # comma forces single-element array wrap so caller gets the HashSet
}

function Get-AllHubs($controlDir) {
  $list = @()
  if (-not (Test-Path $controlDir)) { return ,$list }
  Get-ChildItem -Path $controlDir -Filter '*.json' | ForEach-Object {
    try {
      $obj = Get-Content $_.FullName -Raw -Encoding utf8 | ConvertFrom-Json
      # alive test
      $alive = $false
      try { Get-Process -Id $obj.pid -ErrorAction Stop | Out-Null; $alive = $true }
      catch [Microsoft.PowerShell.Commands.ProcessCommandException] { $alive = $false }
      catch { $alive = $true }
      if ($alive) {
        $list += [pscustomobject]@{
          Pid       = [uint32]$obj.pid
          HookPort  = [int]$obj.hookPort
          Token     = [string]$obj.token
          StartedAt = [DateTimeOffset]::FromUnixTimeMilliseconds([int64]$obj.startedAt).LocalDateTime
        }
      }
    } catch { }
  }
  return ,$list
}

function Invoke-Escape($hub) {
  $uri = "http://127.0.0.1:$($hub.HookPort)/api/escape-home"
  $body = @{ token = $hub.Token } | ConvertTo-Json
  try {
    $resp = Invoke-RestMethod -Uri $uri -Method POST -Body $body -ContentType 'application/json' -TimeoutSec 5
    Log-Line "  POST $uri -> OK $($resp | ConvertTo-Json -Compress)"
    return $true
  } catch {
    $status = $null
    if ($_.Exception.Response) { $status = $_.Exception.Response.StatusCode.value__ }
    Log-Line "  POST $uri -> FAIL status=$status msg=$($_.Exception.Message)"
    return $false
  }
}

# --- 3. cursor -> hwnd -> top-level -> PID ---
$pt = New-Object POINT
[void][Win32Hub]::GetCursorPos([ref]$pt)
Log-Line "cursor=($($pt.X),$($pt.Y))"

$hwnd = [Win32Hub]::WindowFromPoint($pt)
Log-Line "hwnd-at-cursor=$hwnd"

$rootHwnd = if ($hwnd -ne [IntPtr]::Zero) { [Win32Hub]::GetAncestor($hwnd, 2) } else { [IntPtr]::Zero }
Log-Line "root-hwnd=$rootHwnd"

[uint32]$cursorPid = 0
if ($rootHwnd -ne [IntPtr]::Zero) {
  [void][Win32Hub]::GetWindowThreadProcessId($rootHwnd, [ref]$cursorPid)
}
$cursorProc = try { (Get-Process -Id $cursorPid -ErrorAction Stop).ProcessName } catch { '<unknown>' }
Log-Line "cursorPid=$cursorPid proc=$cursorProc"

# --- 4. collect ancestors + load hub list ---
$controlDir = Join-Path $DataDir 'control'
$hubs = Get-AllHubs $controlDir
Log-Line "alive-hubs=[$($hubs.Pid -join ',')]"

if ($hubs.Count -eq 0) {
  Log-Line "ABORT: no alive Hub"
  exit 1
}

$matched = $null
if ($cursorPid -gt 0) {
  $ancestors = Get-AncestorPids $cursorPid
  Log-Line "ancestors=[$($ancestors -join ',')]"
  foreach ($h in $hubs) {
    if ($ancestors.Contains($h.Pid)) { $matched = $h; break }
  }
}

# --- 5. dispatch ---
if ($matched) {
  Log-Line "RESCUE-PRECISE Hub PID=$($matched.Pid) port=$($matched.HookPort)"
  [void](Invoke-Escape $matched)
} else {
  Log-Line "RESCUE-ALL fallback: $($hubs.Count) hubs"
  foreach ($h in $hubs) {
    Log-Line "  trying PID=$($h.Pid) port=$($h.HookPort)"
    [void](Invoke-Escape $h)
  }
}
Log-Line "=== done ==="
