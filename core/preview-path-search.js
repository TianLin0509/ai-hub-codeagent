'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { fileURLToPath } = require('url');

const DEFAULT_MAX_ENTRIES = 20000;
const DEFAULT_MAX_INDEX_MS = 1200;
const DEFAULT_CACHE_TTL_MS = 30000;
const DEFAULT_LIMIT = 40;
const IGNORED_DIRECTORIES = new Set([
  '.git', '.hg', '.svn',
  'node_modules', 'bower_components',
  'dist', 'build', 'out', 'coverage',
  '.cache', '.next', '.nuxt', '.turbo', '.venv', 'venv',
]);

const indexCache = new Map();
const indexBuilds = new Map();

function cleanPathQuery(value, env = process.env, homeDir = os.homedir()) {
  let query = String(value == null ? '' : value)
    .replace(/[\0\r\n]+/g, '')
    .trim();
  if ((query.startsWith('"') && query.endsWith('"'))
      || (query.startsWith("'") && query.endsWith("'"))) {
    query = query.slice(1, -1).trim();
  }
  query = query.replace(/%([^%]+)%/g, (match, name) => {
    const found = Object.keys(env || {}).find(key => key.toLowerCase() === String(name).toLowerCase());
    return found ? String(env[found]) : match;
  });
  if (query === '~') query = homeDir;
  else if (/^~[\\/]/.test(query)) query = path.join(homeDir, query.slice(2));
  if (/^file:/i.test(query)) {
    try { query = fileURLToPath(query); } catch (_) {}
  }
  return query;
}

function normalizedKey(value) {
  const resolved = path.resolve(String(value || ''));
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function isIgnoredDirectory(name, ignored = IGNORED_DIRECTORIES) {
  return ignored.has(process.platform === 'win32' ? String(name).toLowerCase() : String(name));
}

async function statPath(candidate, fsImpl = fs, onError = null) {
  try {
    return await fsImpl.promises.stat(candidate);
  } catch (error) {
    if (typeof onError === 'function') onError(error, candidate);
    return null;
  }
}

async function resolveExactPath(query, cwd, options = {}) {
  const fsImpl = options.fsImpl || fs;
  const cleaned = cleanPathQuery(query, options.env, options.homeDir);
  if (!cleaned) return null;
  let candidate = cleaned;
  if (!path.isAbsolute(candidate)) {
    if (!cwd || !path.isAbsolute(cwd)) return null;
    candidate = path.resolve(cwd, candidate);
  } else {
    candidate = path.resolve(candidate);
  }
  const stat = await statPath(candidate, fsImpl, options.onStatError);
  if (!stat) return null;
  return {
    path: candidate,
    name: path.basename(candidate) || candidate,
    relativePath: cwd && path.isAbsolute(cwd) ? path.relative(cwd, candidate) || '.' : candidate,
    isDirectory: stat.isDirectory(),
    source: 'exact',
    score: Number.MAX_SAFE_INTEGER,
  };
}

async function buildWorkspaceIndex(root, options = {}) {
  const fsImpl = options.fsImpl || fs;
  const now = options.now || Date.now;
  const maxEntries = Math.max(100, Number(options.maxEntries) || DEFAULT_MAX_ENTRIES);
  const maxIndexMs = Math.max(50, Number(options.maxIndexMs) || DEFAULT_MAX_INDEX_MS);
  const ignored = options.ignoredDirectories || IGNORED_DIRECTORIES;
  const startedAt = now();
  const queue = [root];
  const entries = [];
  const warnings = [];
  let errorsCount = 0;
  let truncated = false;

  while (queue.length > 0) {
    if (entries.length >= maxEntries || now() - startedAt >= maxIndexMs) {
      truncated = true;
      break;
    }
    const directory = queue.shift();
    let children;
    try {
      children = await fsImpl.promises.readdir(directory, { withFileTypes: true });
    } catch (error) {
      errorsCount += 1;
      if (warnings.length < 5) {
        warnings.push({ path: directory, error: String(error && error.message || error) });
      }
      continue;
    }
    children.sort((a, b) => a.name.localeCompare(b.name));
    for (const child of children) {
      if (entries.length >= maxEntries || now() - startedAt >= maxIndexMs) {
        truncated = true;
        break;
      }
      if (child.isSymbolicLink && child.isSymbolicLink()) continue;
      const absolutePath = path.join(directory, child.name);
      if (child.isDirectory && child.isDirectory()) {
        if (isIgnoredDirectory(child.name, ignored)) continue;
        entries.push({
          path: absolutePath,
          name: child.name,
          relativePath: path.relative(root, absolutePath),
          isDirectory: true,
        });
        queue.push(absolutePath);
      } else if (child.isFile && child.isFile()) {
        entries.push({
          path: absolutePath,
          name: child.name,
          relativePath: path.relative(root, absolutePath),
          isDirectory: false,
        });
      }
    }
  }

  return {
    root,
    entries,
    truncated,
    indexedAt: now(),
    elapsedMs: Math.max(0, now() - startedAt),
    errorsCount,
    warnings,
  };
}

async function getWorkspaceIndex(root, options = {}) {
  const now = options.now || Date.now;
  const ttlMs = Math.max(1000, Number(options.cacheTtlMs) || DEFAULT_CACHE_TTL_MS);
  const key = normalizedKey(root);
  const cache = options.cache || indexCache;
  const builds = options.inFlight || indexBuilds;
  const cached = cache.get(key);
  if (cached && now() - cached.indexedAt <= ttlMs) return cached;
  const inFlight = builds.get(key);
  if (inFlight) return inFlight;
  const build = buildWorkspaceIndex(root, options).then((built) => {
    cache.set(key, built);
    return built;
  });
  builds.set(key, build);
  try {
    return await build;
  } finally {
    if (builds.get(key) === build) builds.delete(key);
  }
}

function subsequenceScore(needle, haystack) {
  let queryIndex = 0;
  let first = -1;
  let last = -1;
  for (let index = 0; index < haystack.length && queryIndex < needle.length; index += 1) {
    if (haystack[index] !== needle[queryIndex]) continue;
    if (first < 0) first = index;
    last = index;
    queryIndex += 1;
  }
  if (queryIndex !== needle.length) return -1;
  const span = Math.max(1, last - first + 1);
  return 260 - span - first;
}

function scorePathEntry(entry, query) {
  const raw = String(query || '').trim().toLowerCase();
  if (!raw) return 0;
  const normalizedQuery = raw.replace(/[\\/]+/g, '/');
  const basename = String(entry.name || '').toLowerCase();
  const relative = String(entry.relativePath || entry.path || '').toLowerCase().replace(/\\/g, '/');
  const compactQuery = normalizedQuery.replace(/[^a-z0-9\u0080-\uffff]+/g, '');
  const compactBase = basename.replace(/[^a-z0-9\u0080-\uffff]+/g, '');
  let score = -1;

  if (basename === normalizedQuery) score = 1200;
  else if (relative === normalizedQuery) score = 1120;
  else if (basename.startsWith(normalizedQuery)) score = 1000 - basename.length;
  else if (basename.includes(normalizedQuery)) score = 880 - basename.indexOf(normalizedQuery);
  else if (relative.startsWith(normalizedQuery)) score = 760 - relative.length * 0.01;
  else if (relative.includes(normalizedQuery)) score = 680 - relative.indexOf(normalizedQuery) * 0.2;

  if (compactQuery) {
    score = Math.max(score, subsequenceScore(compactQuery, compactBase));
    score = Math.max(score, subsequenceScore(compactQuery, relative.replace(/[^a-z0-9\u0080-\uffff]+/g, '')) - 30);
  }

  const tokens = normalizedQuery.split(/[^a-z0-9\u0080-\uffff]+/).filter(Boolean);
  if (tokens.length > 1 && tokens.every(token => relative.includes(token))) {
    score = Math.max(score, 720 + tokens.length * 5);
  }
  if (score < 0) return -1;
  if (!entry.isDirectory) score += 8;
  score -= Math.min(80, relative.length * 0.08);
  return score;
}

async function searchPreviewPaths(payload = {}, options = {}) {
  const rawQuery = String(payload.query == null ? '' : payload.query).slice(0, 500);
  const cwd = typeof payload.cwd === 'string' && path.isAbsolute(payload.cwd)
    ? path.resolve(payload.cwd)
    : null;
  const limit = Math.max(1, Math.min(100, Number(payload.limit) || DEFAULT_LIMIT));
  const query = cleanPathQuery(rawQuery, options.env, options.homeDir);
  if (!query) return { results: [], source: 'empty', truncated: false, indexedCount: 0 };

  let exactStatError = null;
  const exact = await resolveExactPath(query, cwd, {
    ...options,
    onStatError(error, candidate) {
      if (!error || !['ENOENT', 'ENOTDIR'].includes(error.code)) {
        exactStatError = { error, candidate };
      }
      if (typeof options.onStatError === 'function') options.onStatError(error, candidate);
    },
  });
  if (!exact && exactStatError && (!cwd || path.isAbsolute(query))) {
    return {
      results: [],
      source: 'error',
      truncated: false,
      indexedCount: 0,
      errorsCount: 1,
      error: `路径无法读取：${String(exactStatError.error && exactStatError.error.message || exactStatError.error)}`,
    };
  }
  const fsImpl = options.fsImpl || fs;
  let rootStat = null;
  let rootError = null;
  if (cwd) {
    try { rootStat = await fsImpl.promises.stat(cwd); }
    catch (error) { rootError = error; }
  }
  if (!rootStat || !rootStat.isDirectory()) {
    return {
      results: exact ? [exact] : [],
      source: exact ? 'exact' : (rootError ? 'error' : 'unavailable'),
      truncated: false,
      indexedCount: 0,
      errorsCount: rootError ? 1 : 0,
      error: rootError
        ? `workspace 无法读取：${String(rootError && rootError.message || rootError)}`
        : (cwd && rootStat ? 'workspace 不是文件夹' : undefined),
    };
  }

  const index = await getWorkspaceIndex(cwd, options);
  const scored = index.entries
    .map(entry => ({ ...entry, source: 'workspace', score: scorePathEntry(entry, query) }))
    .filter(entry => entry.score >= 0)
    .sort((a, b) => b.score - a.score
      || Number(a.isDirectory) - Number(b.isDirectory)
      || a.relativePath.localeCompare(b.relativePath));

  const results = [];
  const seen = new Set();
  for (const entry of exact ? [exact, ...scored] : scored) {
    const key = normalizedKey(entry.path);
    if (seen.has(key)) continue;
    seen.add(key);
    results.push(entry);
    if (results.length >= limit) break;
  }
  return {
    results,
    source: exact ? 'exact+workspace' : 'workspace',
    truncated: index.truncated,
    indexedCount: index.entries.length,
    elapsedMs: index.elapsedMs,
    errorsCount: index.errorsCount,
    warnings: index.warnings,
  };
}

function clearPreviewPathSearchCache(root) {
  if (!root) {
    indexCache.clear();
    indexBuilds.clear();
    return;
  }
  const key = normalizedKey(root);
  indexCache.delete(key);
  indexBuilds.delete(key);
}

module.exports = {
  DEFAULT_CACHE_TTL_MS,
  DEFAULT_LIMIT,
  DEFAULT_MAX_ENTRIES,
  DEFAULT_MAX_INDEX_MS,
  IGNORED_DIRECTORIES,
  buildWorkspaceIndex,
  cleanPathQuery,
  clearPreviewPathSearchCache,
  resolveExactPath,
  scorePathEntry,
  searchPreviewPaths,
};
