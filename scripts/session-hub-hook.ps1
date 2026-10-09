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
