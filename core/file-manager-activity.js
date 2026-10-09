'use strict';

// 文件夹「最近活动时间」= 子树内最大 mtime（文件与子目录都算）。
// Windows 上目录自身的 mtime 只在直接子项增删改名时变化，深层文件改动不会冒泡，
// 所以按目录自身 mtime 排「最新文件夹」会误导。这里按需、有界地扫描子树。

const fs = require('fs');
const path = require('path');
const { checkedPath } = require('./file-manager-service');
const { isPathInsideRoot } = require('./file-manager-directory');

const ACTIVITY_EXCLUDED = new Set(['node_modules', '.git', '.venv', '__pycache__']);
const DEFAULT_ACTIVITY_LIMITS = Object.freeze({ maxDepth: 8, maxEntries: 4000, timeBudgetMs: 700 });
const DEFAULT_ACTIVITY_TTL_MS = 120000;
const MAX_DIRECTORIES_PER_REQUEST = 64;

async function scanFolderActivity(directory, options = {}) {
  const limits = { ...DEFAULT_ACTIVITY_LIMITS, ...options };
  const excluded = options.excluded || ACTIVITY_EXCLUDED;
  const fsp = options.fsp || fs.promises;
  const now = options.now || Date.now;
  const started = now();
  const base = { ok: true, directory, latestMs: null, latestPath: '', incomplete: false, reasons: [], visited: 0 };
  if (excluded.has(path.basename(directory))) return { ...base, skipped: 'excluded' };
  const info = await fsp.lstat(directory);
  if (info.isSymbolicLink()) return { ...base, skipped: 'link' };
  if (!info.isDirectory()) throw new Error('path is not a directory');

  const reasons = new Set();
  const stack = [{ dir: directory, depth: 0 }];
  let latestMs = null;
  let latestPath = '';
  let visited = 0;
  const consider = (full, mtimeMs) => {
    if (Number.isFinite(mtimeMs) && (latestMs === null || mtimeMs > latestMs)) { latestMs = mtimeMs; latestPath = full; }
  };
  while (stack.length) {
    if (now() - started > limits.timeBudgetMs) { reasons.add('time'); break; }
    if (visited >= limits.maxEntries) { reasons.add('entries'); break; }
    const { dir, depth } = stack.pop();
    let children;
    try { children = await fsp.readdir(dir, { withFileTypes: true }); }
    catch (_) { reasons.add('unreadable'); continue; }
    const targets = [];
    for (const child of children) {
      if (visited >= limits.maxEntries) { reasons.add('entries'); break; }
      visited++;
      // 链接 / junction 按设计不跟随，也不计为「不完整」。
      if (child.isSymbolicLink()) continue;
      const full = path.join(dir, child.name);
      if (child.isDirectory()) {
        if (excluded.has(child.name)) continue;
        targets.push(full);
        if (depth + 1 < limits.maxDepth) stack.push({ dir: full, depth: depth + 1 });
        else reasons.add('depth');
      } else if (child.isFile()) {
        targets.push(full);
      }
    }
    for (let index = 0; index < targets.length; index += 16) {
      await Promise.all(targets.slice(index, index + 16).map(async (full) => {
        try { consider(full, (await fsp.lstat(full)).mtimeMs); }
        catch (_) { /* 扫描期间消失的条目不影响结果 */ }
      }));
    }
  }
  return { ...base, latestMs, latestPath, incomplete: reasons.size > 0, reasons: [...reasons], visited };
}

function createFolderActivityService(deps = {}) {
  const scan = deps.scan || scanFolderActivity;
  const ttlMs = Number.isFinite(deps.ttlMs) ? deps.ttlMs : DEFAULT_ACTIVITY_TTL_MS;
  const now = deps.now || Date.now;
  const concurrency = Math.max(1, deps.concurrency || 3);
  const verify = deps.checkedPath || checkedPath;
  const cache = new Map();
  const inflight = new Map();

  function prune() {
    if (cache.size <= 2000) return;
    for (const [key, value] of cache) if (now() - value.at > ttlMs) cache.delete(key);
  }

  function one(root, directory, force) {
    const key = path.resolve(directory).toLowerCase();
    const cached = cache.get(key);
    if (!force && cached && now() - cached.at <= ttlMs) return Promise.resolve({ ...cached.result, cached: true });
    if (inflight.has(key)) return inflight.get(key);
    const job = (async () => {
      const full = await verify(root, directory);
      const result = await scan(full);
      cache.set(key, { at: now(), result });
      prune();
      return result;
    })().catch(error => ({ ok: false, directory, error: String(error && error.message || error) }))
      .finally(() => inflight.delete(key));
    inflight.set(key, job);
    return job;
  }

  async function lookup(payload = {}) {
    const root = typeof payload.root === 'string' && path.isAbsolute(payload.root) ? path.resolve(payload.root) : '';
    if (!root) throw new Error('invalid root');
    const directories = Array.isArray(payload.directories) ? [...new Set(payload.directories.filter(d => typeof d === 'string'))] : [];
    if (directories.length > MAX_DIRECTORIES_PER_REQUEST) throw new Error(`每次最多查询 ${MAX_DIRECTORIES_PER_REQUEST} 个文件夹`);
    const results = new Array(directories.length);
    let cursor = 0;
    await Promise.all(Array.from({ length: Math.min(concurrency, directories.length) }, async () => {
      while (cursor < directories.length) {
        const index = cursor++;
        const directory = directories[index];
        results[index] = path.isAbsolute(directory) && isPathInsideRoot(root, directory)
          ? { ...(await one(root, directory, !!payload.force)), directory }
          : { ok: false, directory, error: 'directory is outside workspace root' };
      }
    }));
    return { ok: true, results };
  }

  return { lookup, clear: () => cache.clear() };
}

module.exports = {
  ACTIVITY_EXCLUDED,
  DEFAULT_ACTIVITY_LIMITS,
  DEFAULT_ACTIVITY_TTL_MS,
  MAX_DIRECTORIES_PER_REQUEST,
  createFolderActivityService,
  scanFolderActivity,
};
