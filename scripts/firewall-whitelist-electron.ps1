# Permanently configure Windows Firewall + Defender so Electron Hub runs silently.
# Run as Administrator. Idempotent — safe to re-run.
#
# Applies:
#   1. Clean up duplicate / stale pytest-path "electron.exe" firewall rules
#   2. Create two permanent Allow rules (Inbound + Outbound, Any profile, Any protocol)
#      targeting the main source electron.exe by program path
#   3. Add Windows Defender exclusions for Hub folder + electron.exe
#   4. Disable NotifyOnListen on all firewall profiles so Windows stops prompting
#      when a new program (e.g. pytest-spawned Hub at a fresh temp path) tries to listen
#
# Background: pytest E2E tests copy the Hub into AppData\Local\Temp\pytest-of-<user>\
# pytest-NNN\... every run. Each new path is "unknown" to Firewall, so without (4) a
# prompt pops up repeatedly. Disabling NotifyOnListen does NOT change the default-block
# behavior for unknown inbound listeners on external interfaces — loopback 127.0.0.1
# stays allowed (kernel-level), which is all E2E tests need.

$ErrorActionPreference = 'Stop'

$isAdmin = ([Security.Principal.WindowsPrincipal] `
    [Security.Principal.WindowsIdentity]::GetCurrent()
  ).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
  Write-Error "Must run as Administrator. Right-click PowerShell -> Run as Administrator."
  exit 1
}

# Resolve Hub root from this script's location (scripts/ → ..)
$HubDir      = Split-Path -Parent $PSScriptRoot
$ElectronExe = Join-Path $HubDir 'node_modules\electron\dist\electron.exe'
# 桌面快捷方式现在指向品牌化副本 AIHubCommunity.exe（任务栏图标根治，见
# core/hub-exe-branding.js）。对防火墙来说那是一个全新的程序路径，不一起放行
# 就会在下次启动时弹一次"是否允许…"。副本不存在时静默跳过。
$BrandedExe  = Join-Path $HubDir 'node_modules\electron\dist\AIHubCommunity.exe'

if (-not (Test-Path $ElectronExe)) {
  Write-Error "electron.exe not found at $ElectronExe - run npm install first."
  exit 1
}
$HubExes = @($ElectronExe)
if (Test-Path $BrandedExe) { $HubExes += $BrandedExe } else { Write-Host "  (AIHubCommunity.exe not built yet - skipping)" }

Write-Host "=== 1. Remove stale electron.exe + pytest-path firewall rules ==="
Get-NetFirewallRule -DisplayName 'electron.exe' -ErrorAction SilentlyContinue |
  Remove-NetFirewallRule -ErrorAction SilentlyContinue
Get-NetFirewallRule -DisplayName 'Electron - Claude Hub*' -ErrorAction SilentlyContinue |
  Remove-NetFirewallRule -ErrorAction SilentlyContinue
$pytestApps = Get-NetFirewallApplicationFilter -ErrorAction SilentlyContinue |
  Where-Object { $_.Program -match 'pytest-of-[^\\\\]+|pytest-\d+' }
if ($pytestApps) {
  foreach ($a in $pytestApps) { ($a | Get-NetFirewallRule) | Remove-NetFirewallRule -ErrorAction SilentlyContinue }
  Write-Host ("  removed " + ($pytestApps | Measure-Object).Count + " pytest-path rule(s)")
}

Write-Host "=== 2. Create permanent allow rules (Any direction/profile/protocol) ==="
foreach ($exe in $HubExes) {
  $tag = [System.IO.Path]::GetFileNameWithoutExtension($exe)
  New-NetFirewallRule `
    -DisplayName "Electron - Claude Hub ($tag Inbound)" `
    -Direction Inbound -Action Allow -Program $exe `
    -Profile Any -Protocol Any -Enabled True | Out-Null
  New-NetFirewallRule `
    -DisplayName "Electron - Claude Hub ($tag Outbound)" `
    -Direction Outbound -Action Allow -Program $exe `
    -Profile Any -Protocol Any -Enabled True | Out-Null
  Write-Host "  allowed $exe"
}

Write-Host "=== 3. Add Windows Defender exclusions (if Defender is active) ==="
try {
  Add-MpPreference -ExclusionPath $HubDir -ErrorAction Stop
  foreach ($exe in $HubExes) { Add-MpPreference -ExclusionProcess $exe -ErrorAction Stop }
  Write-Host "  Defender exclusions added"
} catch {
  Write-Host "  Defender unavailable (service stopped or managed by 3rd-party AV) - skipping"
}

Write-Host "=== 4. Disable firewall prompts for unknown listeners ==="
Set-NetFirewallProfile -Profile Domain,Private,Public -NotifyOnListen False
Write-Host "  NotifyOnListen = False on all profiles"

Write-Host ""
Write-Host "=== Final state ==="
Get-NetFirewallRule -DisplayName 'Electron - Claude Hub*' |
  Select-Object DisplayName,Enabled,Direction,Action,Profile |
  Format-Table -AutoSize
Get-NetFirewallProfile -Profile Domain,Private,Public |
  Select-Object Name,NotifyOnListen,DefaultInboundAction,DefaultOutboundAction |
  Format-Table -AutoSize
