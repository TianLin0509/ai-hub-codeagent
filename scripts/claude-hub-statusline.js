#!/usr/bin/env node
// Silent statusline for claude-session-hub.
// Invoked by Claude Code every ~300ms via stdin JSON. Throttles to 1/min,
// posts {contextPct, usage5h, usage7d} to the hub's hook server, outputs
// empty string (terminal bottom stays blank).
const fs = require('fs');
const path = require('path');
const http = require('http');
const os = require('os');

const THROTTLE_MS = 15 * 1000;
// Honor CLAUDE_HUB_DATA_DIR so isolated test Hubs don't collide with the
// production cache. Hub (session-manager.js) forwards this env var when set.
// Default fallback uses os.homedir() to stay consistent with core/data-dir.js.
const DATA_DIR = process.env.CLAUDE_HUB_DATA_DIR
  || path.join(os.homedir(), '.ai-hub-community');
const CACHE_FILE = path.join(DATA_DIR, 'statusline-cache.json');

let stdin = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => (stdin += c));
process.stdin.on('end', () => {
  try { main(); } catch { /* never let the statusline crash Claude Code */ }
  process.stdout.write(''); // silent
});

function main() {
  const sessionId = process.env.CLAUDE_HUB_SESSION_ID;
  const port = process.env.CLAUDE_HUB_PORT || '3456';
  const token = process.env.CLAUDE_HUB_TOKEN;
  if (!sessionId || !token) return; // not launched from the hub — no-op

  let data;
  try { data = JSON.parse(stdin); } catch { return; }

  const modelId = (data.model && data.model.id) || null;
  const modelDisplay = (data.model && data.model.display_name) || null;
  const sessionName = data.session_name || null;
  const cwd = (data.workspace && data.workspace.current_dir) || null;
  const h5 = data.rate_limits && data.rate_limits.five_hour;
  const d7 = data.rate_limits && data.rate_limits.seven_day;
  const usage5Sig = h5 ? `${h5.used_percentage}:${h5.resets_at}` : '';
  const usage7Sig = d7 ? `${d7.used_percentage}:${d7.resets_at}` : '';

  // Throttle — but bypass throttle when UX-visible state changes (model / cwd /
  // session_name / usage), so /model, cd, /rename and quota changes surface to
  // the Hub immediately.
  let cache = {};
  try { cache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')); } catch {}
  const key = 'session-' + sessionId;
  const entry = typeof cache[key] === 'object'
    ? cache[key]
    : { ts: cache[key] || 0, model: null, cwd: null, name: null, usage5Sig: '', usage7Sig: '' };
  const stateChanged =
    (modelId && entry.model !== modelId) ||
    (cwd && entry.cwd !== cwd) ||
    (sessionName && entry.name !== sessionName) ||
    (usage5Sig && entry.usage5Sig !== usage5Sig) ||
    (usage7Sig && entry.usage7Sig !== usage7Sig);
  if (!stateChanged && Date.now() - entry.ts < THROTTLE_MS) return;

  // Claude Code already computes used_percentage for us — that accounts for
  // input_tokens + cache_read + cache_creation + output. Using it directly
  // avoids us re-doing the math incorrectly.
  const cw = data.context_window || {};
  const cu = cw.current_usage || {};
  const ctxPct = typeof cw.used_percentage === 'number'
    ? Math.round(cw.used_percentage)
    : null;
  const ctxUsed = (cu.input_tokens || 0) + (cu.cache_read_input_tokens || 0) +
                  (cu.cache_creation_input_tokens || 0) + (cu.output_tokens || 0);
  const ctxMax = cw.context_window_size || 0;

  // resets_at is Unix seconds — convert to ms if it looks like seconds
  const toMs = (t) => (typeof t === 'number' && t < 1e12) ? t * 1000 : t;
  const cost = data.cost || {};
  const payload = JSON.stringify({
    sessionId,
    token,
    contextPct: ctxPct,
    contextUsed: ctxUsed,
    contextMax: ctxMax,
    usage5h: h5 ? { pct: h5.used_percentage, resetsAt: toMs(h5.resets_at) } : null,
    usage7d: d7 ? { pct: d7.used_percentage, resetsAt: toMs(d7.resets_at) } : null,
    model: modelId ? { id: modelId, displayName: modelDisplay } : null,
    sessionName,
    cwd,
    apiMs: typeof cost.total_api_duration_ms === 'number' ? cost.total_api_duration_ms : null,
    linesAdded: typeof cost.total_lines_added === 'number' ? cost.total_lines_added : null,
    linesRemoved: typeof cost.total_lines_removed === 'number' ? cost.total_lines_removed : null,
  });

  const req = http.request({
    hostname: '127.0.0.1',
    port: Number(port),
    path: '/api/status',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload),
    },
    timeout: 2000,
  });
  req.on('error', () => {});
  req.on('timeout', () => req.destroy());
  req.write(payload);
  req.end();

  cache[key] = {
    ts: Date.now(),
    model: modelId,
    cwd,
    name: sessionName,
    usage5Sig,
    usage7Sig,
    usage5h: h5 ? { pct: h5.used_percentage, resetsAt: toMs(h5.resets_at) } : null,
    usage7d: d7 ? { pct: d7.used_percentage, resetsAt: toMs(d7.resets_at) } : null,
  };
  try {
    fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
    fs.writeFileSync(CACHE_FILE, JSON.stringify(cache));
  } catch {}
}
