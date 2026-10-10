# Windows PowerShell 5.1+. No Node, Git, admin rights or existing Hub required.
[CmdletBinding()]
param(
  [ValidatePattern('^v?\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$')][string]$Version = 'v0.5.5',
  [string]$Destination = (Join-Path $env:LOCALAPPDATA 'Programs\AIHubCommunity'),
  [string]$PackagePath,
  [string]$ChecksumPath,
  [ValidateSet('existing','claude','codex','gemini')][string]$Provider = 'existing',
  [switch]$NoLaunch,
  [switch]$NoShortcut,
  # Compatibility rendering for machines where the GPU path shows a black window: writes
  # gpu-disabled.json into the Hub data folder (delete it to use the GPU again).
  [switch]$DisableGpu,
  [string]$ResultPath
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$repo = 'TianLin0509/ai-hub-codeagent'
$tag = 'v' + $Version.TrimStart('v')
$asset = 'AIHubCommunity-' + $tag.Substring(1) + '-win-x64.zip'
$stage = $null
$success = $false
function Write-Receipt($value) {
  $json = $value | ConvertTo-Json -Depth 5
  if ($ResultPath) {
    $receiptPath = [IO.Path]::GetFullPath($ResultPath)
    [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($receiptPath)) | Out-Null
    [IO.File]::WriteAllText($receiptPath, $json, (New-Object Text.UTF8Encoding($false)))
  }
  Write-Output $json
}
function Reject-ReparseAncestors([string]$candidate) {
  $entry = $candidate
  while ($entry) {
    if (Test-Path -LiteralPath $entry) {
      if ((Get-Item -LiteralPath $entry -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Installation path contains a junction/symlink: $entry" }
    }
    $parent = Split-Path -Parent $entry
    if ($parent -eq $entry) { break }; $entry = $parent
  }
}
try {
  if (-not [Environment]::Is64BitOperatingSystem -or $env:PROCESSOR_ARCHITECTURE -eq 'ARM64' -or $env:PROCESSOR_ARCHITEW6432 -eq 'ARM64') { throw 'This release supports Windows x64 only.' }
  if ([bool]$PackagePath -ne [bool]$ChecksumPath) { throw 'Offline installation requires both -PackagePath and -ChecksumPath.' }
  $base = [IO.Path]::GetFullPath($Destination)
  Reject-ReparseAncestors $base
  [IO.Directory]::CreateDirectory($base) | Out-Null
  $stage = Join-Path $base ('.install-' + [guid]::NewGuid())
  [IO.Directory]::CreateDirectory($stage) | Out-Null
  if (-not $PackagePath) {
    $releaseUrl = "https://github.com/$repo/releases/download/$tag"
    $PackagePath = Join-Path $stage $asset
    $ChecksumPath = Join-Path $stage 'SHA256SUMS.txt'
    Write-Host "Downloading $tag. Existing versions and user data are retained."
    Invoke-WebRequest "$releaseUrl/$asset" -UseBasicParsing -TimeoutSec 600 -OutFile $PackagePath
    Invoke-WebRequest "$releaseUrl/SHA256SUMS.txt" -UseBasicParsing -TimeoutSec 90 -OutFile $ChecksumPath
  }
  $archive = (Resolve-Path -LiteralPath $PackagePath).Path
  if ([IO.Path]::GetFileName($archive) -ne $asset) { throw "Expected archive named $asset" }
  $entries = @(Get-Content -LiteralPath $ChecksumPath | Where-Object { $_ -match ('^[A-Fa-f0-9]{64}\s+\*?' + [regex]::Escape($asset) + '$') })
  if ($entries.Count -ne 1) { throw 'Checksum manifest must contain exactly one entry for the requested archive.' }
  $expected = ($entries[0] -split '\s+')[0].ToLowerInvariant()
  $actual = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actual -ne $expected) { throw 'SHA256 mismatch. No application was installed or launched.' }
  $target = Join-Path $base $tag
  Reject-ReparseAncestors $target
  $reused = $false
  if (Test-Path -LiteralPath $target) {
    $oldReceipt = Join-Path $target 'installation.json'
    if (-not (Test-Path -LiteralPath $oldReceipt -PathType Leaf)) { throw "Refusing to overwrite unrecognized directory: $target" }
    $old = Get-Content -LiteralPath $oldReceipt -Raw -Encoding UTF8 | ConvertFrom-Json
    $exe = Join-Path $target 'AI Hub Community.exe'
    $asar = Join-Path $target 'resources\app.asar'
    if ($old.archiveSha256 -ne $actual -or $old.version -ne $tag -or -not (Test-Path -LiteralPath $exe) -or -not (Test-Path -LiteralPath $asar)) { throw 'Existing version differs from this release. Use a new Destination; no files were overwritten.' }
    if ((Get-FileHash -LiteralPath $exe).Hash -ne $old.executableSha256 -or (Get-FileHash -LiteralPath $asar).Hash -ne $old.applicationSha256) { throw 'Existing executable/application changed. Use a new Destination; no files were overwritten.' }
    if (-not $old.files -or $old.files.Count -lt 2) { throw 'Existing installation has no file inventory. Use a new Destination.' }
    foreach ($file in $old.files) {
      if ([IO.Path]::IsPathRooted($file.path) -or $file.path.Contains(':') -or ($file.path.Replace('\','/').Split('/') -contains '..')) { throw 'Invalid installation inventory path.' }
      $installedFile=Join-Path $target $file.path
      if (-not (Test-Path -LiteralPath $installedFile -PathType Leaf) -or (Get-FileHash -LiteralPath $installedFile).Hash -ne $file.sha256) { throw "Installed file changed or missing: $($file.path). Use a new Destination." }
    }
    $reused = $true
  } else {
    $unpacked = Join-Path $stage 'app'
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $zip = [IO.Compression.ZipFile]::OpenRead($archive)
    $longest = 0
    try { foreach ($entry in $zip.Entries) {
      $name = $entry.FullName.Replace('\','/')
      if ($name.Length -gt $longest) { $longest = $name.Length }
      if ($name.StartsWith('/') -or $name.Contains(':') -or ($name.Split('/') -contains '..') -or (($entry.ExternalAttributes -shr 16) -band 0xF000) -eq 0xA000) { throw "Unsafe archive entry: $name" }
    } } finally { $zip.Dispose() }
    # Windows PowerShell extraction is limited to 260-character paths; say so before extracting.
    if (($unpacked.Length + 1 + $longest) -ge 260) { throw "Installation path is too long for Windows ($($unpacked.Length + 1 + $longest) characters). Choose a shorter -Destination." }
    Expand-Archive -LiteralPath $archive -DestinationPath $unpacked
    $exe = Join-Path $unpacked 'AI Hub Community.exe'
    $asar = Join-Path $unpacked 'resources\app.asar'
    if (-not (Test-Path -LiteralPath $exe -PathType Leaf) -or -not (Test-Path -LiteralPath $asar -PathType Leaf)) { throw 'Archive is not an AI Hub Community portable application.' }
    $inventory=@(Get-ChildItem -LiteralPath $unpacked -File -Recurse | ForEach-Object { @{path=$_.FullName.Substring($unpacked.Length+1);sha256=(Get-FileHash -LiteralPath $_.FullName).Hash} })
    $install = @{ schemaVersion=1; version=$tag; archiveSha256=$actual; executableSha256=(Get-FileHash -LiteralPath $exe).Hash; applicationSha256=(Get-FileHash -LiteralPath $asar).Hash; files=$inventory; installedAt=[DateTime]::UtcNow.ToString('o') }
    [IO.File]::WriteAllText((Join-Path $unpacked 'installation.json'), ($install | ConvertTo-Json -Depth 5), (New-Object Text.UTF8Encoding($false)))
    # Both absolute paths must stay within this invocation's installation root.
    if (-not [IO.Path]::GetFullPath($unpacked).StartsWith($base.TrimEnd('\')+'\',[StringComparison]::OrdinalIgnoreCase) -or -not [IO.Path]::GetFullPath($target).StartsWith($base.TrimEnd('\')+'\',[StringComparison]::OrdinalIgnoreCase)) { throw 'Installation path escaped destination.' }
    Move-Item -LiteralPath $unpacked -Destination $target
  }
  $exe = Join-Path $target 'AI Hub Community.exe'
  if ($Provider -ne 'existing') {
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $target 'resources\scripts\install-provider.ps1') -Provider $Provider
    if ($LASTEXITCODE -ne 0) { throw "Hub files installed in $target, but $Provider setup failed. Resolve the CLI error, then rerun; not counted as ready." }
  }
  $gpuArgs = ''
  if ($DisableGpu) {
    $dataRoot = Join-Path $env:USERPROFILE '.ai-hub-community'
    [IO.Directory]::CreateDirectory($dataRoot) | Out-Null
    [IO.File]::WriteAllText((Join-Path $dataRoot 'gpu-disabled.json'), '{"reason":"install-release -DisableGpu"}', (New-Object Text.UTF8Encoding($false)))
    $gpuArgs = '--disable-gpu --disable-gpu-compositing'
  }
  if (-not $NoShortcut) {
    $desktop = [Environment]::GetFolderPath('Desktop')
    $shortcut = (New-Object -ComObject WScript.Shell).CreateShortcut((Join-Path $desktop 'AI Hub Community.lnk'))
    $shortcut.TargetPath=$exe; $shortcut.WorkingDirectory=$target; if ($gpuArgs) { $shortcut.Arguments=$gpuArgs }; $shortcut.Save()
  }
  $launched = $false
  if (-not $NoLaunch) {
    $launch=New-Object Diagnostics.ProcessStartInfo
    $launch.FileName=$exe; $launch.WorkingDirectory=$target; $launch.UseShellExecute=$false
    if ($gpuArgs) { $launch.Arguments=$gpuArgs }
    $launch.WindowStyle=[Diagnostics.ProcessWindowStyle]::Hidden
    # An agent may run this installer from another Hub. Never inherit its data
    # root, test fixtures, hook credentials or native session identity.
    foreach($key in @($launch.EnvironmentVariables.Keys)) {
      if($key -match '^(CLAUDE_HUB_|ARENA_HUB_|CODEAGENT_HUB_)' -or $key -in @('CODEAGENT3_LAUNCHER_PID','CODEAGENT3_X_AUTH_TOKEN','CLAUDECODE','CODEX_THREAD_ID','CODEX_SESSION_ID','AI_TEAM_HUB_CALLBACK_URL','ELECTRON_RUN_AS_NODE')) { $launch.EnvironmentVariables.Remove($key) }
    }
    [Diagnostics.Process]::Start($launch) | Out-Null
    $launched=$true
  }
  Write-Receipt @{ schemaVersion=1; ok=$true; version=$tag; directory=$target; executable=$exe; archiveSha256=$actual; reused=$reused; launchRequested=$launched; gpu=$(if ($DisableGpu) { 'disabled' } else { 'default' }); auth='not_checked'; model='not_checked'; next='In Hub, refresh CLI detection, open Accounts, complete official login, and send one test message.' }
  $success = $true
  exit 0
} catch {
  Write-Receipt @{schemaVersion=1;ok=$false;version=$tag;error=$_.Exception.Message;stagingDirectory=$stage}
  exit 1
} finally {
  # Delete only this invocation's checked staging directory after success.
  # Failed stages remain for diagnosis. Never delete a user's installation.
  if ($success -and $stage -and (Test-Path -LiteralPath $stage)) {
    $resolvedStage = (Resolve-Path -LiteralPath $stage).Path
    if ($resolvedStage.StartsWith($base.TrimEnd('\')+'\',[StringComparison]::OrdinalIgnoreCase) -and [IO.Path]::GetFileName($resolvedStage).StartsWith('.install-')) {
      Remove-Item -LiteralPath $resolvedStage -Recurse -Force -ErrorAction Continue
    }
  }
}
