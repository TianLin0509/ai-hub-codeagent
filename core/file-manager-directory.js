'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_FILE_MANAGER_ENTRY_LIMIT = 3000;
const MAX_FILE_MANAGER_ENTRY_LIMIT = 5000;

function normalizedAbsolute(value) {
  if (typeof value !== 'string' || !value.trim() || !path.isAbsolute(value)) return null;
  return path.resolve(value);
}

function isPathInsideRoot(rootPath, candidatePath) {
  const root = normalizedAbsolute(rootPath);
  const candidate = normalizedAbsolute(candidatePath);
  if (!root || !candidate) return false;
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function entryType(dirent) {
  if (dirent.isDirectory()) return 'directory';
  if (dirent.isFile()) return 'file';
  if (dirent.isSymbolicLink()) return 'link';
  return 'other';
}

function normalizeLimit(value) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1) return DEFAULT_FILE_MANAGER_ENTRY_LIMIT;
  return Math.min(parsed, MAX_FILE_MANAGER_ENTRY_LIMIT);
}

async function listWorkspaceDirectory(payload = {}, deps = {}) {
  const root = normalizedAbsolute(payload.root);
  const directory = normalizedAbsolute(payload.directory || payload.root);
  if (!root || !directory) {
    return { ok: false, error: 'invalid path', code: 'invalid_path', entries: [] };
  }
  if (!isPathInsideRoot(root, directory)) {
    return { ok: false, error: 'directory is outside workspace root', code: 'outside_root', entries: [] };
  }

  const lstat = deps.lstat || fs.promises.lstat.bind(fs.promises);
  const stat = deps.stat || fs.promises.stat.bind(fs.promises);
  const readdir = deps.readdir || fs.promises.readdir.bind(fs.promises);
  try {
    const linkStat = await lstat(directory);
    const isRoot = path.relative(root, directory) === '';
    if (linkStat.isSymbolicLink() && !isRoot) {
      return {
        ok: false,
        error: 'symbolic links and junctions are not expanded inside the file tree',
        code: 'link_not_browsable',
        entries: [],
      };
    }
    const directoryStat = linkStat.isDirectory() ? linkStat : await stat(directory);
    if (!directoryStat.isDirectory()) {
      return { ok: false, error: 'path is not a directory', code: 'not_directory', entries: [] };
    }

    const rawEntries = await readdir(directory, { withFileTypes: true });
    const entries = rawEntries.map((entry) => ({
      name: entry.name,
      path: path.join(directory, entry.name),
      type: entryType(entry),
      hidden: entry.name.startsWith('.'),
      extension: entry.isFile() ? path.extname(entry.name).toLowerCase() : '',
    }));
    entries.sort((left, right) => {
      const rank = { directory: 0, link: 1, file: 2, other: 3 };
      const typeDiff = (rank[left.type] ?? 4) - (rank[right.type] ?? 4);
      return typeDiff || left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: 'base' });
    });

    const limit = normalizeLimit(payload.limit);
    const visible = entries.slice(0, limit);
    // Bound stat concurrency; vanished or inaccessible entries remain explicitly unknown.
    let cursor = 0;
    await Promise.all(Array.from({ length: Math.min(16, visible.length) }, async () => {
      while (cursor < visible.length) {
        const entry = visible[cursor++];
        try {
          const info = await lstat(entry.path);
          entry.size = info.isFile() ? info.size : null;
          entry.mtimeMs = info.mtimeMs;
        } catch (error) {
          entry.size = null;
          entry.mtimeMs = null;
          entry.metadataError = error.code || 'stat_failed';
        }
      }
    }));
    return {
      ok: true,
      root,
      directory,
      entries: visible,
      total: entries.length,
      truncated: entries.length > limit,
    };
  } catch (error) {
    return {
      ok: false,
      error: String(error && error.message || error),
      code: error && error.code === 'ENOENT' ? 'not_found' : 'read_failed',
      entries: [],
    };
  }
}

module.exports = {
  DEFAULT_FILE_MANAGER_ENTRY_LIMIT,
  MAX_FILE_MANAGER_ENTRY_LIMIT,
  isPathInsideRoot,
  listWorkspaceDirectory,
  normalizeLimit,
};
