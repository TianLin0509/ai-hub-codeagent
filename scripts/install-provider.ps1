[CmdletBinding(SupportsShouldProcess=$true)]
param([Parameter(Mandatory=$true)][ValidateSet('claude','codex','gemini')][string]$Provider)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
function Find-Provider {
  $found = Get-Command ($Provider + '.exe'), ($Provider + '.cmd') -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($found) { return $found.Source }
  $dirs = @((Join-Path $env:USERPROFILE '.local\bin'))
  if ($env:APPDATA) { $dirs += (Join-Path $env:APPDATA 'npm') }
  if ($Provider -eq 'codex') {
    if ($env:CODEX_INSTALL_DIR) { $dirs += $env:CODEX_INSTALL_DIR }
    if ($env:LOCALAPPDATA) { $dirs += (Join-Path $env:LOCALAPPDATA 'Programs\OpenAI\Codex\bin') }
  }
  foreach ($dir in $dirs) { foreach ($ext in @('.exe','.cmd')) {
    $candidate = Join-Path $dir ($Provider + $ext)
    if (Test-Path -LiteralPath $candidate -PathType Leaf) { return $candidate }
  } }
}
try {
  $command = Find-Provider
  if ($command) { Write-Host "$Provider is already installed at $command. Existing installation retained."; exit 0 }
  if ($Provider -eq 'gemini') {
    if (-not $PSCmdlet.ShouldProcess('@google/gemini-cli','npm install --global')) { exit 0 }
    if (-not (Get-Command npm.cmd -ErrorAction SilentlyContinue)) { throw 'Gemini needs Node.js 22+ and npm. Install Node.js LTS from https://nodejs.org/en/download and reopen the terminal.' }
    & npm.cmd install --global '@google/gemini-cli'
    if ($LASTEXITCODE -ne 0) { throw 'Gemini npm installation failed.' }
  } else {
    $uri = if ($Provider -eq 'codex') { 'https://chatgpt.com/codex/install.ps1' } else { 'https://claude.ai/install.ps1' }
    if (-not $PSCmdlet.ShouldProcess($uri,'Download and run official native CLI installer')) { exit 0 }
    $installerPath = Join-Path ([IO.Path]::GetTempPath()) ('ai-hub-provider-' + [guid]::NewGuid() + '.ps1')
    Invoke-WebRequest $uri -UseBasicParsing -TimeoutSec 90 -OutFile $installerPath
    $previous = $env:CODEX_NON_INTERACTIVE
    try {
      if ($Provider -eq 'codex') { $env:CODEX_NON_INTERACTIVE = '1' }
      & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $installerPath
      if ($LASTEXITCODE -ne 0) { throw "$Provider native installation failed. See the official installer output above." }
    } finally { $env:CODEX_NON_INTERACTIVE = $previous }
  }
  $command = Find-Provider
  if (-not $command) { throw 'Installer exited but the CLI could not be found. Reopen the terminal and verify the official installation; not counted as success.' }
  & $command --version
  if ($LASTEXITCODE -ne 0) { throw 'CLI was found but its version check failed.' }
  if ($Provider -eq 'claude') {
    $bash = @("$env:ProgramFiles\Git\bin\bash.exe", "$env:LOCALAPPDATA\Programs\Git\bin\bash.exe") | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
    if (-not $bash) { Write-Warning 'Claude Code on Windows needs Git for Windows (Git Bash) to run tools: https://git-scm.com/download/win' }
  }
  Write-Host 'CLI installation verified. In AI Hub click Refresh, then Accounts to sign in. Model access has not been checked.'
  exit 0
} catch { Write-Error $_ -ErrorAction Continue; exit 1 }
