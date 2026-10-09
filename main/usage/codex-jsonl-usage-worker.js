'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { parentPort, threadId } = require('node:worker_threads');
const {
  extractCodexRateLimits,
  mergeCodexRateLimitCandidates,
} = require('./agent-usage-parser.js');

const DEFAULT_CANDIDATE_LIMIT = 20;

function scanCodexJsonlUsage(sessionsDir, opts = {}) {
  const startedAt = Date.now();
  const now = new Date();
  const pad = value => String(value).padStart(2, '0');
  const yesterday = new Date(now.getTime() - 86400000);
  const datePaths = [now, yesterday].map(date => path.join(
    sessionsDir,
    String(date.getFullYear()),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
  ));
  const candidateLimit = Math.max(1, Number(opts.candidateLimit) || DEFAULT_CANDIDATE_LIMIT);
  const candidates = [];
  let filesConsidered = 0;

  for (const dir of datePaths) {
    let files;
    try { files = fs.readdirSync(dir).filter(name => name.startsWith('rollout-') && name.endsWith('.jsonl')); }
    catch { continue; }
    const withStats = files.map(name => {
      const filePath = path.join(dir, name);
      try { return { path: filePath, mtime: fs.statSync(filePath).mtimeMs }; }
      catch { return null; }
    }).filter(Boolean).sort((a, b) => b.mtime - a.mtime).slice(0, candidateLimit);
    filesConsidered += withStats.length;
    for (const file of withStats) {
      const entry = extractCodexRateLimits(file.path);
      if (!entry) continue;
      candidates.push({
        ...entry,
        rolloutPath: file.path,
        observedAt: entry.observedAt || file.mtime,
      });
    }
  }

  return {
    data: mergeCodexRateLimitCandidates(candidates, Date.now(), { minObservedAt: opts.minObservedAt || 0 }),
    meta: {
      workerThreadId: threadId,
      scanMs: Date.now() - startedAt,
      filesConsidered,
      matches: candidates.length,
    },
  };
}

parentPort.on('message', message => {
  try {
    const result = scanCodexJsonlUsage(message.sessionsDir, message.opts || {});
    parentPort.postMessage({ id: message.id, ...result });
  } catch (error) {
    parentPort.postMessage({ id: message && message.id, error: error && error.message ? error.message : String(error) });
  }
});
