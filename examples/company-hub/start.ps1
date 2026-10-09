[CmdletBinding()]
param(
  [Parameter(Mandatory=$true)][string]$Executable,
  [Parameter(Mandatory=$true)][string]$DataDirectory,
  [string]$WorkspaceDirectory,
  [switch]$CheckOnly
)
$ErrorActionPreference='Stop'
try {
  $exe=(Resolve-Path -LiteralPath $Executable).Path
  if(-not (Test-Path -LiteralPath $exe -PathType Leaf) -or [IO.Path]::GetExtension($exe) -ne '.exe'){throw 'Provide the installed AI Hub Community.exe path.'}
  $data=[IO.Path]::GetFullPath($DataDirectory)
  if($data -eq [IO.Path]::GetPathRoot($data)){throw 'Use a dedicated data subdirectory, not a drive root.'}
  $workspace=if($WorkspaceDirectory){[IO.Path]::GetFullPath($WorkspaceDirectory)}else{$null}
  if($CheckOnly){@{executable=$exe;dataDirectory=$data;workspaceDirectory=$workspace;launched=$false} | ConvertTo-Json;exit 0}
  [IO.Directory]::CreateDirectory($data)|Out-Null
  $info=New-Object Diagnostics.ProcessStartInfo
  $info.FileName=$exe;$info.WorkingDirectory=[IO.Path]::GetDirectoryName($exe);$info.UseShellExecute=$false
  $info.WindowStyle=[Diagnostics.ProcessWindowStyle]::Hidden
  foreach($key in @($info.EnvironmentVariables.Keys)) {
    if($key -match '^(CLAUDE_HUB_|ARENA_HUB_)' -or $key -in @('CLAUDECODE','CODEX_THREAD_ID','CODEX_SESSION_ID','AI_TEAM_HUB_CALLBACK_URL','ELECTRON_RUN_AS_NODE')) { $info.EnvironmentVariables.Remove($key) }
  }
  $info.EnvironmentVariables['CLAUDE_HUB_DATA_DIR']=$data
  if($workspace){$info.EnvironmentVariables['AI_HUB_WORKSPACE_ROOT']=$workspace}
  $child=[Diagnostics.Process]::Start($info)
  @{pid=$child.Id;dataDirectory=$data;launchRequested=$true;auth='not_checked'} | ConvertTo-Json
  exit 0
}catch{Write-Error $_ -ErrorAction Continue;exit 1}
