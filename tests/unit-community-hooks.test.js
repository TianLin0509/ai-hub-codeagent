'use strict';
// The PowerShell hook relay forwards the CLI's hook payload byte for byte, and
// the Hub extracts the fields it needs. Runs without Python or Node on PATH.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');
const { normalizeHookPayload } = require('../core/hook-payload');

const RELAY = path.join(__dirname, '..', 'scripts', 'session-hub-hook.ps1');
const SYSTEM_PATH = [path.join(process.env.SystemRoot || 'C:\\Windows', 'System32'),
  path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0')].join(';');

function capture() {
  const received = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => { received.push({ url: req.url, headers: req.headers, body: Buffer.concat(chunks) }); res.end('{}'); });
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ server, received, port: server.address().port })));
}

function relay(event, stdin, env) {
  return new Promise((resolve, reject) => {
    const child = spawn('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', RELAY, event],
      { env, windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', c => { stderr += c; });
    child.on('error', reject);
    child.on('exit', code => (code === 0 ? resolve() : reject(new Error(`relay exit ${code}: ${stderr}`))));
    child.stdin.end(stdin);
  });
}

test('relay forwards raw payloads and the Hub extracts the hook fields', { skip: process.platform !== 'win32' }, async () => {
  const hub = await capture();
  const pathKey = Object.keys(process.env).find(k => k.toLowerCase() === 'path') || 'PATH';
  const env = { ...process.env, [pathKey]: SYSTEM_PATH, CLAUDE_HUB_SESSION_ID: 'hub-1', CLAUDE_HUB_TOKEN: 'tok', CLAUDE_HUB_PORT: String(hub.port) };
  try {
    const payload = { session_id: 'cc-1', prompt: '你好，继续 😀', transcript_path: 'C:\\t\\a.jsonl', cwd: 'C:\\work' };
    const raw = Buffer.from(JSON.stringify(payload), 'utf8');
    await relay('prompt', raw, env);
    assert.equal(hub.received.length, 1);
    const [request] = hub.received;
    assert.equal(request.url, '/api/hook-raw/prompt');
    assert.ok(request.body.equals(raw), 'payload bytes are unchanged');
    const body = normalizeHookPayload('prompt', request.body, { sessionId: request.headers['x-hub-session'], token: request.headers['x-hub-token'] });
    assert.deepEqual(body, { sessionId: 'hub-1', token: 'tok', claudeSessionId: 'cc-1', cwd: 'C:\\work',
      transcriptPath: 'C:\\t\\a.jsonl', prompt: '你好，继续 😀', backgroundTasks: [], sessionCrons: [] });
  } finally { hub.server.close(); }
});

test('large tool output is truncated like the original hook', () => {
  const body = normalizeHookPayload('tool-complete', JSON.stringify({ tool_name: 'Read', tool_response: '中'.repeat(5000) }), { sessionId: 's', token: 't' });
  assert.ok(Buffer.byteLength(body.toolResult, 'utf8') <= 6000);
  assert.ok(body.toolResult.endsWith('…'));
  assert.equal(normalizeHookPayload('tool-use', '{}', { sessionId: 's' }), null);
});
