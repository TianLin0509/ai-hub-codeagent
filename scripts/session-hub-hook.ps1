# AI Hub lifecycle hook relay for machines without Python or Node.
#
# Claude Code / Codex run this for every configured hook event and write the
# event JSON to stdin. The script forwards the raw bytes to the local Hub
# (POST /api/hook-raw/<event>); the Hub extracts the same fields that
# session-hub-hook.py would send (core/hook-payload.js).
#
# Sessions not started by the Hub have no CLAUDE_HUB_SESSION_ID and exit
# immediately, so the user's own terminal sessions are unaffected.
# Keep this file ASCII: Windows PowerShell 5.1 reads BOM-less files as ANSI.
param([string]$HookEvent = 'stop')

# ask-gate: synchronous PreToolUse hook registered only for the question tools
# (core/auto-dispatch-rules.js). Sessions the Hub dispatches automatically carry
# AI_HUB_NO_CHOICE=1; for them the call is refused with exit code 2 and the reason
# (AI_HUB_NO_CHOICE_REASON, written to stderr as UTF-8) goes back to the model.
# Every other session, and any failure here, lets the call through (exit 0).
if ($HookEvent -eq 'ask-gate') {
  if ($env:AI_HUB_NO_CHOICE -ne '1') { exit 0 }
  $deny = $false
  try {
    $stdin = [Console]::OpenStandardInput()
    $buffer = New-Object System.IO.MemoryStream
    $stdin.CopyTo($buffer)
    $payload = [System.Text.Encoding]::UTF8.GetString($buffer.ToArray()) | ConvertFrom-Json
    $tools = @(([string]$env:AI_HUB_NO_CHOICE_TOOLS).Split(',') | ForEach-Object { $_.Trim() } | Where-Object { $_ })
    if ($tools.Count -eq 0) { $tools = @('AskUserQuestion') }
    $deny = $tools -contains [string]$payload.tool_name
  } catch { $deny = $false }
  if (-not $deny) { exit 0 }
  try {
    $reason = [string]$env:AI_HUB_NO_CHOICE_REASON
    if (-not $reason) { $reason = 'This session is dispatched automatically and nobody can answer questions: continue with the most reasonable assumptions and state them in the answer.' }
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($reason)
    $err = [Console]::OpenStandardError()
    $err.Write($bytes, 0, $bytes.Length)
    $err.Flush()
  } catch { }
  exit 2
}

$sessionId = $env:CLAUDE_HUB_SESSION_ID
if (-not $sessionId -or $HookEvent -eq 'tool-use') { exit 0 }

try {
  $port = $env:CLAUDE_HUB_PORT
  if (-not $port) { $port = '3456' }
  $stdin = [Console]::OpenStandardInput()
  $buffer = New-Object System.IO.MemoryStream
  $stdin.CopyTo($buffer)
  $bytes = $buffer.ToArray()

  $request = [System.Net.HttpWebRequest]::Create("http://127.0.0.1:$port/api/hook-raw/$HookEvent")
  $request.Method = 'POST'
  $request.Proxy = $null
  $request.Timeout = 3000
  $request.ReadWriteTimeout = 3000
  $request.ContentType = 'application/json; charset=utf-8'
  $request.Headers.Add('X-Hub-Session', [string]$sessionId)
  $request.Headers.Add('X-Hub-Token', [string]$env:CLAUDE_HUB_TOKEN)
  $request.ContentLength = $bytes.Length
  $out = $request.GetRequestStream()
  $out.Write($bytes, 0, $bytes.Length)
  $out.Close()
  $request.GetResponse().Close()
} catch {
  # The Hub not running is not an error for the CLI.
}
exit 0
