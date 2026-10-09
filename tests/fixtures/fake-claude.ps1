# Minimal stand-in for the Claude Code CLI used by tests/e2e-community-cdp.js.
#
# It behaves like the real CLI towards the Hub: it runs inside the Hub's PTY,
# reads prompts from its terminal, writes a transcript JSONL, and fires the
# hooks registered in ~/.claude/settings.json by executing the configured
# command strings (through Git Bash when present, as Claude Code does on
# Windows). It never talks to a model.
# Keep this file ASCII: Windows PowerShell 5.1 reads BOM-less files as ANSI.
param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Rest)
$ErrorActionPreference = 'Stop'

$sid = $null
for ($i = 0; $i -lt $Rest.Count - 1; $i++) {
  if ($Rest[$i] -eq '--session-id' -or $Rest[$i] -eq '--resume') { $sid = $Rest[$i + 1] }
}
if (-not $sid) { $sid = [guid]::NewGuid().ToString() }

$userHome = $env:USERPROFILE
$settingsPath = Join-Path $userHome '.claude\settings.json'
$cwd = (Get-Location).Path
$slug = $cwd -replace '[^A-Za-z0-9]', '-'
$projectDir = Join-Path $userHome ".claude\projects\$slug"
New-Item -ItemType Directory -Force $projectDir | Out-Null
$transcript = Join-Path $projectDir "$sid.jsonl"
$trace = Join-Path $userHome 'fake-claude-trace.log'
$bash = @("$env:ProgramFiles\Git\bin\bash.exe", "$env:LOCALAPPDATA\Programs\Git\bin\bash.exe") | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
$utf8 = New-Object System.Text.UTF8Encoding($false)

function Write-Trace([string]$text) { [IO.File]::AppendAllText($trace, $text + "`n", $utf8) }

function Invoke-Hook([string]$eventName, $payload) {
  $settings = [IO.File]::ReadAllText($settingsPath, $utf8) | ConvertFrom-Json
  $groups = $settings.hooks.$eventName
  if (-not $groups) { Write-Trace "no hook for $eventName"; return }
  $json = $payload | ConvertTo-Json -Compress -Depth 10
  foreach ($group in @($groups)) {
    foreach ($hook in @($group.hooks)) {
      $script = Join-Path $env:TEMP ("fake-claude-hook-" + [guid]::NewGuid().ToString() + ($(if ($bash) { '.sh' } else { '.cmd' })))
      [IO.File]::WriteAllText($script, $hook.command, $utf8)
      $psi = New-Object System.Diagnostics.ProcessStartInfo
      if ($bash) { $psi.FileName = $bash; $psi.Arguments = '"' + $script + '"' }
      else { $psi.FileName = 'cmd.exe'; $psi.Arguments = '/d /c "' + $script + '"' }
      $psi.UseShellExecute = $false
      $psi.RedirectStandardInput = $true
      $psi.CreateNoWindow = $true
      $process = [System.Diagnostics.Process]::Start($psi)
      $bytes = $utf8.GetBytes($json)
      $process.StandardInput.BaseStream.Write($bytes, 0, $bytes.Length)
      $process.StandardInput.Close()
      $process.WaitForExit(15000) | Out-Null
      Write-Trace "$eventName exit=$($process.ExitCode) via=$(if ($bash) { 'bash' } else { 'cmd' })"
      Remove-Item -LiteralPath $script -Force -ErrorAction SilentlyContinue
    }
  }
}

function Add-Entry($entry) { [IO.File]::AppendAllText($transcript, ($entry | ConvertTo-Json -Compress -Depth 10) + "`n", $utf8) }

# The real CLI reads its terminal as UTF-8; Windows PowerShell 5.1 defaults to the OEM code page.
[Console]::InputEncoding = $utf8
[Console]::OutputEncoding = $utf8
Invoke-Hook 'SessionStart' @{ session_id = $sid; transcript_path = $transcript; cwd = $cwd; hook_event_name = 'SessionStart'; source = 'startup' }
# Same footer text the real CLI shows once its prompt is ready.
Write-Host 'Fake Claude ready  ? for shortcuts'

while ($true) {
  Write-Host -NoNewline '> '
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  $prompt = ($line -replace ([string][char]27 + '\[20[01]~'), '' -replace '\[20[01]~', '').Trim()
  if (-not $prompt) { continue }
  if ($prompt -eq '/exit') { break }
  Write-Trace "prompt: $prompt"
  $now = (Get-Date).ToUniversalTime().ToString('o')
  $userId = [guid]::NewGuid().ToString()
  Add-Entry @{ type = 'user'; uuid = $userId; sessionId = $sid; timestamp = $now; cwd = $cwd; message = @{ role = 'user'; content = $prompt } }
  Invoke-Hook 'UserPromptSubmit' @{ session_id = $sid; transcript_path = $transcript; cwd = $cwd; hook_event_name = 'UserPromptSubmit'; prompt = $prompt }
  Start-Sleep -Milliseconds 300
  $reply = "FAKE-REPLY: $prompt"
  Write-Host $reply
  Add-Entry @{ type = 'assistant'; uuid = [guid]::NewGuid().ToString(); parentUuid = $userId; sessionId = $sid; timestamp = (Get-Date).ToUniversalTime().ToString('o'); cwd = $cwd
    message = @{ id = 'msg_' + [guid]::NewGuid().ToString('N'); type = 'message'; role = 'assistant'; model = 'fake-model'; stop_reason = 'end_turn'
      content = @(@{ type = 'text'; text = $reply }); usage = @{ input_tokens = 1; output_tokens = 1 } } }
  Invoke-Hook 'Stop' @{ session_id = $sid; transcript_path = $transcript; cwd = $cwd; hook_event_name = 'Stop'; last_assistant_message = $reply }
}
Invoke-Hook 'SessionEnd' @{ session_id = $sid; transcript_path = $transcript; cwd = $cwd; hook_event_name = 'SessionEnd'; reason = 'prompt_input_exit' }
