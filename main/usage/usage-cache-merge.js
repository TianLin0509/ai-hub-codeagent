'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { shouldPreferCodexLiveUsage } = require('./codex-app-server-usage.js');
const {
  acquireLock,
  acquireLockAsync,
  releaseLock,
  releaseLockAsync,
} = require('../../core/file-lock.js');

function observedAt(value) {
  return Number(value && (value.observedAt || value._ts || value.ts)) || 0;
}

function sameScope(left, right) {
  const a = left && (left.scopeKey || left.codexScopeKey);
  const b = right && (right.scopeKey || right.codexScopeKey);
  if (a && b) return a === b;
  const ar = left && left.sessionsRoot;
  const br = right && right.sessionsRoot;
  if (ar && br) return String(ar).toLowerCase() === String(br).toLowerCase();
  return true;
}

function newerEntry(current, incoming) {
  if (!current) return incoming || null;
  if (!incoming) return current;
  return observedAt(incoming) >= observedAt(current) ? incoming : current;
}

function mergeCodexEntry(current, incoming, now = Date.now()) {
  if (!current) return incoming || null;
  if (!incoming) return current;
  if (!sameScope(current, incoming)) return newerEntry(current, incoming);

  // Missing windows are not new observations. Keep the last weekly quota
  // across reset/refresh gaps with its original timestamp, until data arrives.
  const validWindow = value => typeof value?.pct === 'number' && Number.isFinite(value.pct) && value.pct >= 0;
  if (validWindow(current.usage7d) && !validWindow(incoming.usage7d)) {
    if (!validWindow(incoming.usage5h)) return current;
    incoming = { ...incoming, unavailable: false, usage7d: {
      ...current.usage7d, observedAt: current.usage7d.observedAt || observedAt(current),
    } };
  }

  const currentLive = current.source === 'app-server';
  const incomingLive = incoming.source === 'app-server';
  if (currentLive && !incomingLive && shouldPreferCodexLiveUsage(current, incoming, now)) return current;
  if (incomingLive && !currentLive && shouldPreferCodexLiveUsage(incoming, current, now)) return incoming;
  return newerEntry(current, incoming);
}

function mergeUsageCacheSnapshots(current = {}, incoming = {}, now = Date.now()) {
  const merged = { ...(current || {}) };
  for (const [provider, value] of Object.entries(incoming || {})) {
    if (provider === 'codex') merged.codex = mergeCodexEntry(merged.codex, value, now);
    else merged[provider] = newerEntry(merged[provider], value);
  }
  return merged;
}

const fileCache = new Map();
function readUsageCacheFile(filePath) {
  try {
    const stat = fs.statSync(filePath);
    const stamp = `${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
    let cached = fileCache.get(filePath);
    if (!cached || cached.stamp !== stamp) {
      cached = { stamp, value:JSON.parse(fs.readFileSync(filePath, 'utf8')) };
      fileCache.set(filePath, cached);
      while (fileCache.size > 32) fileCache.delete(fileCache.keys().next().value);
    }
    return structuredClone(cached.value);
  }
  catch { return {}; }
}

function tempPathFor(filePath) {
  return `${filePath}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`;
}

async function writeMergedUsageCacheFile(filePath, incoming, opts = {}) {
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  const lockPath = `${filePath}.lock`;
  const lock = await acquireLockAsync(lockPath, { retries: 100, retryDelayMs: 10 });
  if (!lock) throw new Error(`usage cache lock timeout: ${lockPath}`);
  const tmp = tempPathFor(filePath);
  try {
    const current = readUsageCacheFile(filePath);
    const merged = mergeUsageCacheSnapshots(current, incoming, opts.now || Date.now());
    if (JSON.stringify(current) === JSON.stringify(merged)) return merged;
    await fs.promises.writeFile(tmp, JSON.stringify(merged));
    await fs.promises.rename(tmp, filePath);
    return merged;
  } finally {
    try { await fs.promises.unlink(tmp); } catch {}
    if (lock) await releaseLockAsync(lock, lockPath);
  }
}

function writeMergedUsageCacheFileSync(filePath, incoming, opts = {}) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const lockPath = `${filePath}.lock`;
  const lock = acquireLock(lockPath, { retries: 100, retryDelayMs: 10 });
  if (lock == null) throw new Error(`usage cache lock timeout: ${lockPath}`);
  const tmp = tempPathFor(filePath);
  try {
    const merged = mergeUsageCacheSnapshots(readUsageCacheFile(filePath), incoming, opts.now || Date.now());
    fs.writeFileSync(tmp, JSON.stringify(merged));
    fs.renameSync(tmp, filePath);
    return merged;
  } finally {
    try { fs.unlinkSync(tmp); } catch {}
    if (lock != null) releaseLock(lock, lockPath);
  }
}

module.exports = {
  mergeCodexEntry,
  mergeUsageCacheSnapshots,
  observedAt,
  readUsageCacheFile,
  sameScope,
  writeMergedUsageCacheFile,
  writeMergedUsageCacheFileSync,
};
