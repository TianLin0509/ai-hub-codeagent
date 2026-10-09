# tools/hub-escape.ps1
# 一键 Hub 防卡死救援脚本 — maintainer 2026-05-16
#
# 用法：
#   .\tools\hub-escape.ps1                       # 救最新启动的 Hub
#   .\tools\hub-escape.ps1 -HubPid 81164         # 救指定 PID
#   .\tools\hub-escape.ps1 -DataDir C:\temp\x    # 指定隔离 Hub 的 dataDir
#   .\tools\hub-escape.ps1 -List                 # 列出所有活着的 Hub
#
# 原理：读 <dataDir>/control/<pid>.json -> curl POST /api/escape-home
#       -> Hub 内部 sendToRenderer('escape-home') -> renderer escapeToHome()
#       关预览面板 + 清 activeSession/Meeting + 展开 sidebar。
#
# Spec: docs/superpowers/specs/2026-05-16-hub-escape-backdoors-design.md

param(
  [int]$HubPid = 0,
  [string]$DataDir = "$env:USERPROFILE\.ai-hub-community",
  [switch]$List
)

$ErrorActionPreference = 'Stop'

$controlDir = Join-Path $DataDir 'control'
if (-not (Test-Path $controlDir)) {
  Write-Error "control 目录不存在: $controlDir`n该 dataDir 当前没有 Hub 在跑（或 Hub 启动还没写控制文件）"
  exit 1
}

# 列出所有 control 文件，过滤活进程
$entries = @()
Get-ChildItem -Path $controlDir -Filter '*.json' | ForEach-Object {
  try {
    $obj = Get-Content $_.FullName -Raw -Encoding utf8 | ConvertFrom-Json
    # 测活：区分"进程不存在"（ProcessCommandException → 真死）与"无权限查询"（其他异常 → 视为活）
    # 防止 UAC 隔离环境下把活 Hub 误判成死的，导致救援脚本找不到目标。
    $alive = $false
    try {
      Get-Process -Id $obj.pid -ErrorAction Stop | Out-Null
      $alive = $true
    } catch [Microsoft.PowerShell.Commands.ProcessCommandException] {
      $alive = $false
    } catch {
      $alive = $true
      Write-Warning "pid $($obj.pid) 测活异常（视为活，可能权限隔离）: $($_.Exception.Message)"
    }
    if ($alive) {
      $entries += [pscustomobject]@{
        Pid       = $obj.pid
        HookPort  = $obj.hookPort
        CdpPort   = $obj.cdpPort
        Token     = $obj.token
        DataDir   = $obj.dataDir
        StartedAt = [DateTimeOffset]::FromUnixTimeMilliseconds([int64]$obj.startedAt).LocalDateTime
        File      = $_.FullName
      }
    }
  } catch {
    Write-Warning "skip $($_.Name): $_"
  }
}

if ($List) {
  if ($entries.Count -eq 0) { Write-Output "没有活着的 Hub"; exit 0 }
  $entries | Select-Object Pid, HookPort, CdpPort, StartedAt, DataDir | Format-Table -AutoSize
  exit 0
}

if ($entries.Count -eq 0) {
  Write-Error "没有活着的 Hub（control 目录里没有匹配的活进程）"
  exit 1
}

# 选目标
if ($HubPid -gt 0) {
  $target = $entries | Where-Object { $_.Pid -eq $HubPid } | Select-Object -First 1
  if (-not $target) {
    Write-Error "PID $HubPid 没找到活着的 Hub。当前活着的 PID: $($entries.Pid -join ', ')"
    exit 1
  }
} else {
  # 默认取最新启动的
  $target = $entries | Sort-Object StartedAt -Descending | Select-Object -First 1
  Write-Output "未指定 PID，自动选最新启动的 Hub: PID=$($target.Pid) StartedAt=$($target.StartedAt)"
}

# 发请求
$uri = "http://127.0.0.1:$($target.HookPort)/api/escape-home"
$body = @{ token = $target.Token } | ConvertTo-Json
Write-Output "-> POST $uri"
try {
  $resp = Invoke-RestMethod -Uri $uri -Method POST -Body $body -ContentType 'application/json' -TimeoutSec 5
  Write-Output "OK: $($resp | ConvertTo-Json -Compress)"
} catch {
  $statusCode = $null
  if ($_.Exception.Response) { $statusCode = $_.Exception.Response.StatusCode.value__ }
  if ($statusCode -eq 503) {
    Write-Error "Hub renderer 不可达（已 crash 或被 destroy）。HTTP 救援无效，需手动重启 Hub（会丢 session）。"
  } elseif ($statusCode -eq 403) {
    Write-Error "token 鉴权失败。control 文件可能过期 — 重新读控制文件或确认 Hub 未重启。"
  } else {
    Write-Error "调用失败: $($_.Exception.Message)"
  }
  exit 1
}
