$ErrorActionPreference='Stop'
$root=Join-Path ([IO.Path]::GetTempPath()) ('hub installer tests '+[guid]::NewGuid())
$source=Join-Path $root 'source'
New-Item -ItemType Directory -Path (Join-Path $source 'resources') -Force | Out-Null
Add-Type -TypeDefinition @'
using System;
using System.IO;
public class HubInstallerProbe {
  public static void Main() {
    string value = Environment.GetEnvironmentVariable("CLAUDE_HUB_DATA_DIR") == null
      && Environment.GetEnvironmentVariable("CLAUDE_HUB_TOKEN") == null
      && Environment.GetEnvironmentVariable("CODEX_THREAD_ID") == null
      && Environment.GetEnvironmentVariable("ELECTRON_RUN_AS_NODE") == null
      && Environment.GetEnvironmentVariable("CLAUDE_CODE_GIT_BASH_PATH") == "fixture-bash" ? "clean" : "inherited";
    File.WriteAllText(Environment.GetEnvironmentVariable("HUB_INSTALL_LAUNCH_PROBE"), value);
  }
}
'@ -OutputAssembly (Join-Path $source 'AI Hub Community.exe') -OutputType ConsoleApplication
[IO.File]::WriteAllText((Join-Path $source 'resources\app.asar'),'synthetic app archive')
$version='v0.0.0-test'
$archive=Join-Path $root 'AIHubCommunity-0.0.0-test-win-x64.zip'
Compress-Archive -Path (Join-Path $source '*') -DestinationPath $archive
$manifest=Join-Path $root 'SHA256SUMS.txt'
$hash=(Get-FileHash -LiteralPath $archive).Hash
[IO.File]::WriteAllText($manifest,($hash+'  '+[IO.Path]::GetFileName($archive)))
$installer=Join-Path $PSScriptRoot '..\scripts\install-release.ps1'
$receipt=Join-Path $root 'result.json'
$destination=Join-Path $root 'installed app'
function Run-Install([string]$dest=$destination,[string]$checksums=$manifest,[switch]$Launch) {
  $options=@('-NoProfile','-ExecutionPolicy','Bypass','-File',$installer,'-Version',$version,'-Destination',$dest,'-PackagePath',$archive,'-ChecksumPath',$checksums,'-NoShortcut','-ResultPath',$receipt)
  if(-not $Launch){$options+='-NoLaunch'}
  & powershell.exe @options | Out-Null
  $code=$LASTEXITCODE
  return @{code=$code;result=(Get-Content -LiteralPath $receipt -Raw -Encoding UTF8 | ConvertFrom-Json)}
}
function Expect($condition,[string]$message) { if(-not $condition){throw $message} }
$first=Run-Install
Expect ($first.code -eq 0 -and $first.result.ok -and -not $first.result.reused) 'Fresh install failed'
Expect (-not $first.result.launchRequested -and $first.result.auth -eq 'not_checked') 'Installer must not claim authenticated readiness'
$again=Run-Install
Expect ($again.code -eq 0 -and $again.result.reused) 'Repeat installation is not idempotent'
$probe=Join-Path $root 'launch-probe.txt'
$env:HUB_INSTALL_LAUNCH_PROBE=$probe
$savedData=$env:CLAUDE_HUB_DATA_DIR;$savedToken=$env:CLAUDE_HUB_TOKEN;$savedThread=$env:CODEX_THREAD_ID
$savedElectron=$env:ELECTRON_RUN_AS_NODE;$savedBash=$env:CLAUDE_CODE_GIT_BASH_PATH
try {
  $env:CLAUDE_HUB_DATA_DIR='fixture-parent-data';$env:CLAUDE_HUB_TOKEN='fixture-parent-token';$env:CODEX_THREAD_ID='fixture-parent-thread'
  $env:ELECTRON_RUN_AS_NODE='1';$env:CLAUDE_CODE_GIT_BASH_PATH='fixture-bash'
  $launched=Run-Install -Launch
  Expect ($launched.code -eq 0 -and $launched.result.launchRequested) 'Launch request failed'
  $deadline=[DateTime]::UtcNow.AddSeconds(10)
  while(-not (Test-Path -LiteralPath $probe) -and [DateTime]::UtcNow -lt $deadline){Start-Sleep -Milliseconds 100}
  Expect ((Get-Content -LiteralPath $probe) -eq 'clean') 'Parent Hub data or identity leaked into installed application'
}finally{$env:CLAUDE_HUB_DATA_DIR=$savedData;$env:CLAUDE_HUB_TOKEN=$savedToken;$env:CODEX_THREAD_ID=$savedThread;$env:ELECTRON_RUN_AS_NODE=$savedElectron;$env:CLAUDE_CODE_GIT_BASH_PATH=$savedBash;Remove-Item Env:HUB_INSTALL_LAUNCH_PROBE}
$bad=Join-Path $root 'bad.txt'
[IO.File]::WriteAllText($bad,('0'*64+'  '+[IO.Path]::GetFileName($archive)))
$failed=Run-Install -dest (Join-Path $root 'bad-install') -checksums $bad
Expect ($failed.code -ne 0 -and $failed.result.error -match 'SHA256 mismatch') 'Corrupt archive not rejected'
Expect (-not (Test-Path -LiteralPath (Join-Path $root 'bad-install\v0.0.0-test'))) 'Corrupt archive installed files'
$unknown=Join-Path $root 'unknown'
New-Item -ItemType Directory -Path (Join-Path $unknown $version) -Force | Out-Null
[IO.File]::WriteAllText((Join-Path $unknown "$version\keep.txt"),'preserve me')
$failed=Run-Install -dest $unknown
Expect ($failed.code -ne 0 -and $failed.result.error -match 'unrecognized') 'Unknown destination overwritten'
Expect ((Get-Content -LiteralPath (Join-Path $unknown "$version\keep.txt")) -eq 'preserve me') 'Existing files changed'
[IO.File]::WriteAllText((Join-Path $destination "$version\resources\app.asar"),'changed')
$failed=Run-Install
Expect ($failed.code -ne 0 -and $failed.result.error -match 'changed') 'Modified installed app not detected'
Add-Type -AssemblyName System.IO.Compression.FileSystem
$evilDir=Join-Path $root 'evil';New-Item -ItemType Directory -Path $evilDir|Out-Null
$evilArchive=Join-Path $evilDir ([IO.Path]::GetFileName($archive))
$zip=[IO.Compression.ZipFile]::Open($evilArchive,[IO.Compression.ZipArchiveMode]::Create)
try{$entry=$zip.CreateEntry('../escape.txt');$writer=New-Object IO.StreamWriter($entry.Open());$writer.Write('bad');$writer.Dispose()}finally{$zip.Dispose()}
$archive=$evilArchive
[IO.File]::WriteAllText($manifest,((Get-FileHash -LiteralPath $archive).Hash+'  '+[IO.Path]::GetFileName($archive)))
$failed=Run-Install -dest (Join-Path $root 'traversal')
Expect ($failed.code -ne 0 -and $failed.result.error -match 'Unsafe archive entry') 'Archive traversal not rejected'
Write-Host 'PASS: fresh spaced-path install, repeat install, checksum rejection, existing-directory preservation, changed-app rejection.'
Write-Host 'PASS: archive path traversal rejected before extraction.'
Write-Host 'PASS: launched stub receives no parent Hub data, token or native identity.'
Write-Host "Synthetic files retained at $root; only the local probe executable was launched; no Hub, shortcut or provider was launched."
