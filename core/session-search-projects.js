'use strict';

const path = require('node:path');

// Project IDs are directory identities, never display names or substrings.
function projectPathKey(value) {
  let raw = typeof value === 'string' ? value.trim() : '';
  // The Win32 extended-length spelling identifies the same project.
  raw = raw.replace(/^(?:\\\\\?\\|\/\/\?\/)UNC[\\/]/i, '\\\\').replace(/^(?:\\\\\?\\|\/\/\?\/)/, '');
  if (!raw) return '';
  const windows = /^[a-z]:[\\/]|^\\\\|^\/\//i.test(raw);
  const api = windows ? path.win32 : path.posix;
  if (!api.isAbsolute(raw)) return '';
  let normalized = api.normalize(raw).replace(/\\/g, '/').replace(/\/+$/, '');
  if (windows && /^[a-z]:$/i.test(normalized)) normalized += '/';
  return windows ? normalized.toLowerCase() : normalized || '/';
}

function withinProject(cwd, root) {
  const key = projectPathKey(cwd), base = projectPathKey(root);
  return !!key && !!base && (key === base || key.startsWith(base.endsWith('/') ? base : base + '/'));
}

function normalizeProjectFilter(filter) {
  if (filter == null) return null;
  if (typeof filter !== 'object' || Array.isArray(filter) || !Array.isArray(filter.roots)) throw new Error('项目筛选无效');
  const readRoots = roots => {
    if (!Array.isArray(roots) || roots.some(root => !projectPathKey(root))) throw new Error('项目目录无效');
    return [...new Set(roots.map(projectPathKey))].sort();
  };
  return { roots: readRoots(filter.roots), excludedRoots: readRoots(filter.excludedRoots || []) };
}

function matchesProjectFilter(cwd, filter) {
  return !filter || (filter.roots.some(root => withinProject(cwd, root))
    && !filter.excludedRoots.some(root => withinProject(cwd, root)));
}

function rootsOf(project) { return [project.path, ...(project.searchRoots || [])].map(projectPathKey).filter(Boolean); }

function projectFilterFor(projects, selectedPath) {
  if (!selectedPath) return null;
  const selected = projects.find(project => projectPathKey(project.path) === projectPathKey(selectedPath));
  if (!selected) return { roots: [], excludedRoots: [] }; // Missing selection must never broaden to all.
  const roots = rootsOf(selected);
  const excludedRoots = projects.filter(project => project !== selected).flatMap(rootsOf)
    .filter(other => roots.some(root => other !== root && withinProject(other, root)));
  return normalizeProjectFilter({ roots, excludedRoots });
}

function projectForCwd(projects, cwd) {
  let best = null, length = -1;
  for (const project of projects) for (const root of rootsOf(project)) {
    if (root.length > length && withinProject(cwd, root)) { best = project; length = root.length; }
  }
  return best;
}

// Read registered Git worktrees once per project-library load, never per query.
// Git's retained metadata can also identify a deleted (not yet pruned) worktree.
function readProjectSearchRoots(projectRoot, deps = {}) {
  const fs = deps.fs || require('node:fs');
  const api = deps.path || path;
  const roots = [projectRoot], warnings = [];
  const gitRoot = api.join(projectRoot, '.git'), directory = api.join(gitRoot, 'worktrees');
  let entries;
  try { entries = fs.readdirSync(directory, { withFileTypes: true }); }
  catch (error) {
    if (error.code !== 'ENOENT') warnings.push('无法读取 worktree 登记');
    return { roots, warnings };
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const admin = api.join(directory, entry.name);
    try {
      const common = fs.readFileSync(api.join(admin, 'commondir'), 'utf8').trim();
      const gitFile = fs.readFileSync(api.join(admin, 'gitdir'), 'utf8').trim();
      const target = api.resolve(admin, gitFile);
      if (!common || !gitFile || projectPathKey(api.resolve(admin, common)) !== projectPathKey(gitRoot)
        || api.basename(target) !== '.git') throw new Error('无效的 Git 登记');
      // If the directory was repurposed, its current Git pointer wins.
      try {
        const pointer = fs.readFileSync(target, 'utf8').trim().match(/^gitdir:\s*(.+)$/);
        if (!pointer || projectPathKey(api.resolve(api.dirname(target), pointer[1])) !== projectPathKey(admin)) throw new Error('Git 指针不一致');
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        // A missing whole worktree can be historical. An existing directory
        // with no .git may have been repurposed and must not inherit ownership.
        try { fs.statSync(api.dirname(target)); }
        catch (directoryError) { if (directoryError.code === 'ENOENT') { roots.push(api.dirname(target)); continue; } throw directoryError; }
        throw new Error('目录存在但 Git 指针已丢失');
      }
      roots.push(api.dirname(target));
    } catch (error) { warnings.push(`worktree ${entry.name} 归属读取失败`); }
  }
  return { roots: [...new Set(roots)], warnings };
}

module.exports = { projectPathKey, withinProject, normalizeProjectFilter, matchesProjectFilter,
  projectFilterFor, projectForCwd, readProjectSearchRoots };
