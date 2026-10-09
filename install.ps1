[CmdletBinding()]
param([switch]$NoShortcut, [switch]$Launch, [switch]$CheckOnly)
$ErrorActionPreference = 'Stop'
$repoRoot = $PSScriptRoot
try {
  if (-not (Get-Command node.exe -ErrorAction SilentlyContinue)) { throw 'Node.js 22+ is required: https://nodejs.org/en/download . Reopen PowerShell after installation.' }
  $nodeVersion = & node.exe --version
  $nodeMajor = $nodeVersion.TrimStart('v').Split('.')[0]
  if ($LASTEXITCODE -ne 0 -or [int]$nodeMajor -lt 22) { throw 'Node.js 22+ is required.' }
  if ($CheckOnly) { & node.exe (Join-Path $repoRoot 'scripts\doctor.js'); exit $LASTEXITCODE }
  $modulesPath = Join-Path $repoRoot 'node_modules'
  if (Test-Path -LiteralPath $modulesPath) {
    $modulesItem = Get-Item -LiteralPath $modulesPath -Force
    if ($modulesItem.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Refusing npm installation through a node_modules junction/symlink. Use a standalone checkout.' }
  }
  Push-Location $repoRoot
  try {
    & npm.cmd ci --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) { throw 'npm ci failed. Check the network/proxy and output above; installation is incomplete.' }
    & node.exe scripts\doctor.js
    if ($LASTEXITCODE -ne 0) { throw 'Installation diagnostic failed.' }
  } finally { Pop-Location }
  $electronPath = Join-Path $repoRoot 'node_modules\electron\dist\electron.exe'
  if (-not $NoShortcut) {
    $desktopPath = [Environment]::GetFolderPath('Desktop')
    $wsh = New-Object -ComObject WScript.Shell
    $shortcut = $wsh.CreateShortcut((Join-Path $desktopPath 'AI Hub Community.lnk'))
    $shortcut.TargetPath = $electronPath
    $shortcut.Arguments = '"' + $repoRoot + '"'
    $shortcut.WorkingDirectory = $repoRoot
    $shortcut.IconLocation = (Join-Path $repoRoot 'claude-wx.ico') + ',0'
    $shortcut.Save()
  }
  if ($Launch) { Start-Process -FilePath $electronPath -ArgumentList ('"' + $repoRoot + '"') -WorkingDirectory $repoRoot -WindowStyle Hidden }
  Write-Host 'AI Hub Community installed. Open the desktop shortcut; connect your own AI account in Accounts.'
  exit 0
} catch {
  Write-Error $_ -ErrorAction Continue
  exit 1
}
