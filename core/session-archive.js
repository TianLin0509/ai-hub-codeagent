/**
 * Scanner for Claude Code's per-session JSONL transcripts.
 *
 * Claude Code persists every session as one JSONL file under
 * ~/.claude/projects/<sanitized-cwd>/<sessionId>.jsonl (one event per line).
 * We surface those sessions to the Hub's "Resume" picker.
 *
 * Scope kept tight: list recent + extract headline metadata for display.
 * Full-text search lives in a separate module.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');
// DeepSeek 跑的是同一个 claude CLI，只是 CLAUDE_CONFIG_DIR 指向 ~/.claude-deepseek，
// transcript 落在那边的 projects/ 下。Ctrl+Shift+F 的全局搜索原先只扫 ~/.claude，
// DeepSeek 会话一条都搜不到——会话散到多目录之后这个盲区尤其明显。
const { claudeProjectRoots } = require('./claude-transcript-locator.js');
const CACHE_TTL_MS = 30 * 1000;

let _cache = { at: 0, key: null, items: null };

async function listAllJsonls() {
  const out = [];
  const seen = new Set();
  for (const projectsDir of claudeProjectRoots()) {
    let entries;
    try { entries = await fs.promises.readdir(projectsDir); } catch { continue; }
    for (const proj of entries) {
      const projDir = path.join(projectsDir, proj);
      let stat;
      try { stat = await fs.promises.stat(projDir); } catch { continue; }
      if (!stat.isDirectory()) continue;
      let files;
      try { files = await fs.promises.readdir(projDir); } catch { continue; }
      for (const f of files) {
        if (!f.endsWith('.jsonl')) continue;
        const full = path.join(projDir, f);
        if (seen.has(full)) continue;
        seen.add(full);
        try {
          const s = await fs.promises.stat(full);
          out.push({ path: full, mtime: s.mtimeMs, size: s.size, sessionId: f.slice(0, -6) });
        } catch {}
      }
    }
  }
  return out;
}

// Strip Claude Code's internal wrapper tags so slash commands display as
// "/commit" instead of the raw `<local-command-caveat>...</local-command-caveat>`
// envelope that CC wraps around them.
function cleanUserMessage(text) {
  if (!text) return null;
  let t = String(text);
  t = t.replace(/<local-command-caveat>[\s\S]*?<\/local-command-caveat>/g, '');
  t = t.replace(/<local-command-stdout>[\s\S]*?<\/local-command-stdout>/g, '');
  t = t.replace(/<local-command-stderr>[\s\S]*?<\/local-command-stderr>/g, '');
  t = t.replace(/<command-name>([^<]*)<\/command-name>/g, '$1 ');
  t = t.replace(/<command-message>[^<]*<\/command-message>/g, '');
  t = t.replace(/<command-args>([^<]*)<\/command-args>/g, ' $1');
  t = t.replace(/<[a-z][a-z0-9-]*>|<\/[a-z][a-z0-9-]*>/gi, '');
  t = t.replace(/\s+/g, ' ').trim();
  return t || null;
}

function extractUserText(message) {
  if (!message) return null;
  let raw = null;
  if (typeof message === 'string') raw = message;
  else if (typeof message.content === 'string') raw = message.content;
  else if (Array.isArray(message.content)) {
    // Skip tool_result blocks — those are from the agent loop, not the human.
    const textBlocks = message.content.filter(b => b && b.type === 'text' && b.text);
    if (textBlocks.length === 0) return null;
    raw = textBlocks.map(b => b.text).join(' ');
  }
  return cleanUserMessage(raw);
}

/**
 * Stream-parse a jsonl file to extract summary metadata.
 * Early-terminates lookups that are already resolved; keeps counting turns to EOF.
 */
function scanSessionMetadata(filePath) {
  return new Promise((resolve) => {
    const meta = { cwd: null, firstUserMessage: null, model: null, turnCount: 0, slug: null };
    let buf = '';
    let foundFirstUser = false;
    const stream = fs.createReadStream(filePath, { encoding: 'utf-8' });
    stream.on('data', (chunk) => {
      buf += chunk;
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        let entry;
        try { entry = JSON.parse(line); } catch { continue; }
        if (!meta.cwd && entry.cwd) meta.cwd = entry.cwd;
        if (!meta.slug && entry.slug) meta.slug = entry.slug;
        if (entry.type === 'user') {
          meta.turnCount++;
          if (!foundFirstUser) {
            const text = extractUserText(entry.message);
            if (text) { meta.firstUserMessage = text; foundFirstUser = true; }
          }
        } else if (entry.type === 'assistant') {
          if (entry.message && entry.message.model) meta.model = entry.message.model;
        }
      }
    });
    stream.on('end', () => resolve(meta));
    stream.on('error', () => resolve(meta));
  });
}

async function listRecent(limit = 50) {
  const key = String(limit);
  if (_cache.items && _cache.key === key && Date.now() - _cache.at < CACHE_TTL_MS) {
    return _cache.items;
  }
  const all = await listAllJsonls();
  all.sort((a, b) => b.mtime - a.mtime);
  const top = all.slice(0, limit);
  const metas = await Promise.all(top.map(async (f) => {
    const meta = await scanSessionMetadata(f.path);
    return {
      sessionId: f.sessionId,
      path: f.path,
      mtime: f.mtime,
      size: f.size,
      cwd: meta.cwd,
      slug: meta.slug,
      firstUserMessage: meta.firstUserMessage,
      model: meta.model,
      turnCount: meta.turnCount,
    };
  }));
  _cache = { at: Date.now(), key, items: metas };
  return metas;
}

function invalidateCache() { _cache = { at: 0, key: null, items: null }; }

// Case-insensitive literal substring search (no regex — avoids injection & bad
// patterns from user). Per-file match cap keeps runaway sessions from flooding
// results. Stream line by line so we don't buffer whole files.
function searchFile(filePath, queryLower, perFileCap = 3) {
  return new Promise((resolve) => {
    const hits = [];
    let buf = '';
    let lineNo = 0;
    const stream = fs.createReadStream(filePath, { encoding: 'utf-8' });
    const stop = () => { try { stream.destroy(); } catch {} resolve(hits); };
    stream.on('data', (chunk) => {
      buf += chunk;
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        lineNo++;
        if (line.toLowerCase().indexOf(queryLower) === -1) continue;
        // Parse + extract only human-readable text; drop tool_use / tool_result noise.
        let entry;
        try { entry = JSON.parse(line); } catch { continue; }
        let snippet = null;
        let role = entry.type || '';
        if (entry.type === 'user') snippet = extractUserText(entry.message);
        else if (entry.type === 'assistant') snippet = extractAssistantText(entry.message);
        if (!snippet || snippet.toLowerCase().indexOf(queryLower) === -1) continue;
        hits.push({ lineNo, role, snippet });
        if (hits.length >= perFileCap) { stop(); return; }
      }
    });
    stream.on('end', () => resolve(hits));
    stream.on('error', () => resolve(hits));
  });
}

function extractAssistantText(message) {
  if (!message) return null;
  if (typeof message.content === 'string') return message.content.trim() || null;
  if (Array.isArray(message.content)) {
    const textBlocks = message.content.filter(b => b && b.type === 'text' && b.text);
    if (!textBlocks.length) return null;
    return textBlocks.map(b => b.text).join(' ').trim() || null;
  }
  return null;
}

/**
 * Full-text search across all jsonl transcripts, most recent first.
 * Hard caps: perFileCap=3, globalLimit=50, timeoutMs=8000.
 */
async function searchAcross(query, { limit = 50, timeoutMs = 8000, perFileCap = 3 } = {}) {
  const q = String(query || '').trim();
  if (q.length < 2) return { hits: [], truncated: false };
  const ql = q.toLowerCase();
  const all = await listAllJsonls();
  all.sort((a, b) => b.mtime - a.mtime);
  const deadline = Date.now() + timeoutMs;
  const out = [];
  let truncated = false;
  // Light concurrency — 4 files at a time is plenty for disk-bound work.
  let cursor = 0;
  const workers = new Array(4).fill(null).map(async () => {
    while (true) {
      if (out.length >= limit) { truncated = true; return; }
      if (Date.now() > deadline) { truncated = true; return; }
      const i = cursor++;
      if (i >= all.length) return;
      const f = all[i];
      if (f.size > 10 * 1024 * 1024) continue; // skip giant files
      const hits = await searchFile(f.path, ql, perFileCap);
      if (!hits.length) continue;
      for (const h of hits) {
        out.push({
          sessionId: f.sessionId,
          path: f.path,
          mtime: f.mtime,
          lineNo: h.lineNo,
          role: h.role,
          snippet: h.snippet.length > 300 ? h.snippet.slice(0, 298) + '…' : h.snippet,
        });
        if (out.length >= limit) { truncated = true; return; }
      }
    }
  });
  await Promise.all(workers);
  // Order by recency (file mtime), then by line number inside file.
  out.sort((a, b) => b.mtime - a.mtime || a.lineNo - b.lineNo);
  return { hits: out, truncated };
}

module.exports = { listRecent, scanSessionMetadata, invalidateCache, searchAcross, PROJECTS_DIR };
