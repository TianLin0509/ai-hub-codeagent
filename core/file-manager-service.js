'use strict';

const fs = require('fs');
const path = require('path');
const { isPathInsideRoot } = require('./file-manager-directory');
const EXCLUDED = new Set(['node_modules', '.git', '.venv', '__pycache__']);

async function checkedPath(root, target, { allowRoot = true } = {}) {
  if (!isPathInsideRoot(root, target)) throw new Error('路径不在当前目录内');
  const base = path.resolve(root);
  const full = path.resolve(target);
  if (!allowRoot && base.toLowerCase() === full.toLowerCase()) throw new Error('不能修改当前根目录');
  // Inspect every component, including intermediate junctions, before following paths.
  let current = base;
  for (const part of path.relative(base, full).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    if ((await fs.promises.lstat(current)).isSymbolicLink()) throw new Error('请在资源管理器中操作链接或 junction');
  }
  return full;
}

function validName(name) {
  if (typeof name !== 'string' || !name.trim() || /[<>:"/\\|?*\x00-\x1f]/.test(name)
    || /[. ]$/.test(name) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(name)
    || name === '.' || name === '..') throw new Error('文件名无效');
  return name;
}

async function walkFiles(root, { query = '', limit = 10000, maxEntries = 50000, excluded = EXCLUDED } = {}) {
  await checkedPath(root, root);
  const entries = [];
  const skipped = [];
  const pending = [root];
  let visited = 0;
  let truncated = false;
  while (pending.length && !truncated) {
    const directory = pending.pop();
    let children;
    try { children = await fs.promises.readdir(directory, { withFileTypes: true }); }
    catch (error) { skipped.push({ path: directory, reason: error.code }); continue; }
    for (const child of children) {
      if (++visited > maxEntries) { truncated = true; break; }
      const full = path.join(directory, child.name);
      if (child.isSymbolicLink() || excluded.has(child.name)) {
        skipped.push({ path: full, reason: child.isSymbolicLink() ? 'link' : 'excluded' });
        continue;
      }
      if (child.isDirectory()) pending.push(full);
      if (!child.isFile() || !path.relative(root, full).toLowerCase().includes(query.toLowerCase())) continue;
      try {
        const s = await fs.promises.lstat(full);
        if (!s.isFile()) continue;
        entries.push({ name: child.name, path: full, type: 'file', size: s.size, mtimeMs: s.mtimeMs,
          extension: path.extname(child.name).toLowerCase(), hidden: child.name.startsWith('.') });
      } catch (error) { skipped.push({ path: full, reason: error.code }); }
      if (entries.length >= limit) { truncated = true; break; }
    }
  }
  return { ok: true, entries, skipped, truncated, visited };
}

async function fileOperation(payload, shell) {
  const { root, action } = payload;
  const paths = Array.isArray(payload.paths) ? [...new Set(payload.paths)] : [];
  if (!paths.length || paths.length > 200) throw new Error('请选择 1–200 项');
  const sources = [];
  for (const file of paths) sources.push(await checkedPath(root, file, { allowRoot: action === 'mkdir' || action === 'properties' }));
  if (action === 'properties') {
    let bytes = 0;
    let files = 0;
    let truncated = false;
    const skipped = [];
    for (const source of sources) {
      if (sources.some(other => other !== source && isPathInsideRoot(other, source))) continue;
      const s = await fs.promises.lstat(source);
      if (s.isDirectory()) {
        const result = await walkFiles(source, { excluded: new Set() });
        bytes += result.entries.reduce((sum, entry) => sum + entry.size, 0);
        files += result.entries.length;
        truncated ||= result.truncated;
        skipped.push(...result.skipped);
      } else { bytes += s.size; files++; }
    }
    return { ok: true, bytes, files, truncated, skipped };
  }
  if (action === 'mkdir') {
    if (sources.length !== 1) throw new Error('请选择一个父目录');
    await fs.promises.mkdir(path.join(sources[0], validName(payload.name)));
    return { ok: true };
  }
  if (!['rename', 'copy', 'move', 'trash'].includes(action)) throw new Error('不支持的操作');
  if (action === 'rename' && sources.length !== 1) throw new Error('重命名只支持单项');
  let destination;
  if (['copy', 'move'].includes(action)) {
    if (!path.isAbsolute(payload.destination || '')) throw new Error('目标目录必须是绝对路径');
    destination = path.resolve(payload.destination);
    // Destination may be outside workspace; validate ancestors without following junctions.
    await checkedPath(path.parse(destination).root, destination);
    if (!(await fs.promises.stat(destination)).isDirectory()) throw new Error('目标不是目录');
  }
  const results = [];
  for (const source of sources) {
    try {
      if (sources.some(other => other !== source && isPathInsideRoot(other, source))) continue;
      if (action === 'trash') await shell.trashItem(source);
      else {
        const target = action === 'rename' ? path.join(path.dirname(source), validName(payload.name)) : path.join(destination, path.basename(source));
        if (isPathInsideRoot(source, target)) throw new Error('目标不能是源目录或其子目录');
        try { await fs.promises.lstat(target); throw new Error('目标已存在，未覆盖'); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
        if (action === 'copy') {
          await fs.promises.cp(source, target, { recursive: true, errorOnExist: true, force: false, dereference: false,
            filter: async value => { if ((await fs.promises.lstat(value)).isSymbolicLink()) throw new Error('复制中遇到链接，已停止；请检查目标中的部分文件'); return true; } });
        } else if (action === 'move') await require('./cross-volume-move').moveEntry(source, target);
        else await fs.promises.rename(source, target);
      }
      results.push({ path: source, ok: true });
    } catch (error) { results.push({ path: source, ok: false, error: error.message }); }
  }
  return { ok: results.every(item => item.ok), results, error: results.filter(item => !item.ok).map(item => `${path.basename(item.path)}：${item.error}`).join('\n') };
}

module.exports = { checkedPath, validName, walkFiles, fileOperation };
