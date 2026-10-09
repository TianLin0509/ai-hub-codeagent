'use strict';

const fs = require('fs').promises;
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { AGE_MS, inside, defaultScopes, recognizedTest, testLabel } = require('./disk-release-policy');
const { readProcesses, allocatedSizes } = require('./disk-release-windows');
const { acquireDiskReleaseLock } = require('./disk-release-lock');

const PLAN_TTL_MS = 10 * 60 * 1000;
const MAX_FILES = 150000;

function createDiskReleaseEngine(options = {}) {
  const now = options.now || Date.now;
  const scopes = options.scopes || defaultScopes(options);
  const processes = options.readProcesses || readProcesses;
  const measure = options.allocatedSizes || allocatedSizes;
  const reportProgress = options.onProgress || (() => {});
  const protectedPaths = [options.dataDir, options.testRoot && path.join(options.testRoot, '..', 'data'),
    path.join(os.homedir(), '.ai-hub-community'), path.join(os.homedir(), '.claude'),
    path.join(os.homedir(), '.codex'), process.env.CODEX_HOME, process.env.CLAUDE_CONFIG_DIR]
    .filter(Boolean).map(value => path.resolve(value));
  const lockKey = options.lockPath || 'aihub-disk-release-cleanup-v1';
  let lastPlan = null;
  let cancelled = false;
  let lastProgress = 0;

  function progress(phase, message, extra = {}, force = false) {
    if (!force && now() - lastProgress < 250) return;
    lastProgress = now(); reportProgress({ phase, message, ...extra });
  }
  function abortCheck() { if (cancelled) throw new Error('扫描已取消'); }
  function references(target, rows) {
    const needle = path.resolve(target).toLowerCase();
    return rows.filter(row => String(row.cmd || '').replaceAll('/', '\\').toLowerCase().includes(needle.replaceAll('/', '\\')));
  }
  function unknownDevelopmentProcesses(rows) {
    return rows.some(row => !row.cmd && /^(node|pythonw?|electron|aigroupchathub|claude|codex|qemu.*|emulator)\.exe$/i.test(row.name || ''));
  }
  function installing(rows) {
    return rows.some(row => /\b(?:install|ci|add|sync)\b/i.test(row.cmd || '')
      && /(?:npm-cli\.js|\b(?:pip|uv|pnpm|yarn)(?:\.exe)?\b)/i.test(row.cmd || ''));
  }
  function assertInactive(candidate, rows) {
    if (references(candidate.path, rows).length || unknownDevelopmentProcesses(rows)) throw new Error('活动程序仍在使用，或无法确认活动状态，已保留');
    if (candidate.activeNames?.some(name => rows.some(row => String(row.name).toLowerCase() === name))) throw new Error('相关程序正在运行，缓存已保留');
    if (candidate.mode === 'cache' && installing(rows)) throw new Error('有依赖安装正在进行，缓存已保留');
    if (candidate.mode === 'emulators' && rows.some(row => /qemu|emulator/i.test(row.name))) throw new Error('有 Android 模拟器正在运行，设备已保留');
  }
  function protectedTarget(target) {
    return protectedPaths.some(root => inside(root, target, true) || inside(target, root, true));
  }
  async function assertPlainPath(target, boundary, allowRoot = false, checkProtected = true) {
    target = path.resolve(target); boundary = path.resolve(boundary);
    if (!inside(boundary, target, allowRoot) || (checkProtected && protectedTarget(target))) throw new Error('目录不在可清理范围内');
    let current = target;
    while (true) {
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink()) throw new Error('目录含链接，已保留');
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }
    return target;
  }
  async function disk(root = scopes[0]?.root || os.tmpdir()) {
    const stat = await fs.statfs(root);
    const totalBytes = stat.blocks * stat.bsize;
    const freeBytes = stat.bavail * stat.bsize;
    return { root: path.parse(path.resolve(root)).root, totalBytes, freeBytes,
      usedPct: totalBytes ? Math.round((1 - freeBytes / totalBytes) * 1000) / 10 : null };
  }
  async function inspectTree(root, { allowRecent = false, retainHardLinks = false } = {}) {
    const files = []; const dirs = []; let newest = 0;
    const stack = [root];
    while (stack.length) {
      abortCheck();
      const folder = stack.pop();
      await assertPlainPath(folder, root, true);
      dirs.push(folder);
      const entries = await fs.readdir(folder, { withFileTypes: true });
      for (const entry of entries) {
        abortCheck();
        if (['.git', 'node_modules', '.venv', 'venv'].includes(entry.name)) throw new Error('包含源码或开发环境，已保留');
        const target = path.join(folder, entry.name);
        const stat = await fs.lstat(target);
        if (stat.isSymbolicLink()) throw new Error('包含目录链接，已保留');
        if (stat.isDirectory()) { stack.push(target); continue; }
        if (!stat.isFile()) throw new Error('包含无法确认的文件类型，已保留');
        if (retainHardLinks && stat.nlink > 1) throw new Error('缓存与已安装环境共享文件，已保留');
        newest = Math.max(newest, stat.mtimeMs);
        if (!allowRecent && stat.mtimeMs > now() - AGE_MS) throw new Error('最近两天仍有更新，已保留');
        files.push({ path: target, size: stat.size, mtimeMs: stat.mtimeMs, ino: stat.ino });
        if (files.length > MAX_FILES) throw new Error('文件过多，扫描未完成，本项保留');
        progress('scanning', '正在核对文件、活动状态和占用…', { checkedFiles: files.length });
      }
    }
    return { files, dirs, newest };
  }
  async function hasTestMarker(root) {
    for (const name of ['data/cache/session-search-v3.sqlite', 'data/electron-userdata', 'disk-release-test.json']) {
      try { const stat = await fs.lstat(path.join(root, name)); if (!stat.isSymbolicLink()) return true; } catch {}
    }
    return false;
  }
  async function discover() {
    const found = [];
    for (const scope of scopes) {
      abortCheck();
      try {
        await assertPlainPath(scope.root, path.dirname(scope.root), false, scope.mode === 'cache');
        if (scope.mode === 'cache') { found.push({ ...scope, path: scope.root, tier: 'safe' }); continue; }
        if (scope.mode === 'browserCaches') {
          // Search only profile roots and their immediate children. Never select a profile itself.
          const parents = [scope.root];
          for (const entry of await fs.readdir(scope.root, { withFileTypes: true })) {
            if (entry.isDirectory() && !entry.isSymbolicLink()) parents.push(path.join(scope.root, entry.name));
          }
          const profiles = [...parents];
          for (const parent of parents.slice(1)) {
            for (const entry of await fs.readdir(parent, { withFileTypes: true })) {
              if (entry.isDirectory() && !entry.isSymbolicLink() && /^(Default|Profile \d+)$/.test(entry.name)) profiles.push(path.join(parent, entry.name));
            }
          }
          for (const profile of profiles) {
            for (const name of ['Cache', 'Code Cache', 'GPUCache']) {
              const target = path.join(profile, name);
              try {
                const stat = await fs.lstat(target);
                if (!stat.isDirectory() || stat.isSymbolicLink()) continue;
                // A cache folder must belong to a Chromium profile with its Preferences file.
                const marker = await fs.lstat(path.join(profile, 'Preferences'));
                if (!marker.isFile() || marker.isSymbolicLink()) continue;
                found.push({ ...scope, root: target, path: target, mode: 'cache', tier: 'safe', label: `${scope.label} · ${name}` });
              } catch (error) { if (error.code !== 'ENOENT') throw error; }
            }
          }
          continue;
        }
        for (const entry of await fs.readdir(scope.root, { withFileTypes: true })) {
          if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
          const target = path.join(scope.root, entry.name);
          if (scope.mode === 'tests' && recognizedTest(entry.name) && await hasTestMarker(target)) {
            found.push({ ...scope, path: target, label: testLabel(entry.name), tier: 'safe',
              note: '删除该次测试的隔离数据；正式聊天记录和源码保留。' });
          } else if (scope.mode === 'emulators' && /^\d{8}-.+(?:avd|webview)$/i.test(entry.name)) {
            found.push({ ...scope, path: target, label: 'Android 临时测试设备', tier: 'manual',
              note: '删除虚拟设备、快照及设备内登录状态；以后需要重新创建。' });
          }
        }
      } catch (error) {
        if (error.code !== 'ENOENT') found.push({ ...scope, path: scope.root, tier: 'info', reason: error.message });
      }
    }
    return found;
  }
  async function scan() {
    cancelled = false; lastPlan = null;
    progress('scanning', '正在检查活动程序和可重建的数据…', {}, true);
    const rows = await processes();
    const candidates = await discover(); const items = []; const entries = new Map();
    for (let index = 0; index < candidates.length; index++) {
      abortCheck();
      const candidate = candidates[index];
      const key = crypto.randomUUID();
      const item = { key, title: candidate.label, path: candidate.path, tier: candidate.tier,
        note: candidate.note || '', bytes: 0, fileCount: 0, selected: false, reason: candidate.reason || '' };
      progress('scanning', `正在检查 ${index + 1}/${candidates.length} 项…`, { current: index + 1, total: candidates.length }, true);
      try {
        if (item.tier === 'info') throw new Error(item.reason);
        assertInactive(candidate, rows);
        await assertPlainPath(candidate.path, candidate.root, candidate.mode === 'cache');
        const tree = await inspectTree(candidate.path, { allowRecent: candidate.mode === 'cache', retainHardLinks: candidate.mode === 'cache' });
        if (tree.files.length === 0) continue;
        progress('scanning', '正在核对实际磁盘占用…', {}, true);
        const sizes = await measure(tree.files);
        if (!Array.isArray(sizes) || sizes.length !== tree.files.length || sizes.some(value => !Number.isFinite(value) || value < 0)) {
          throw new Error('无法完整读取实际占用，本项保留');
        }
        item.bytes = sizes.reduce((sum, value) => sum + value, 0);
        item.logicalBytes = tree.files.reduce((sum, file) => sum + file.size, 0);
        item.fileCount = tree.files.length; item.updatedAt = tree.newest;
        item.selected = item.tier === 'safe';
        entries.set(key, { candidate, tree, item });
      } catch (error) { item.tier = 'info'; item.reason = error.message; }
      items.push(item);
    }
    abortCheck();
    items.sort((a, b) => b.bytes - a.bytes);
    const report = { ok: true, scanId: crypto.randomUUID(), scannedAt: now(), disk: await disk(), items,
      totals: { selectedBytes: items.filter(item => item.selected).reduce((sum, item) => sum + item.bytes, 0),
        protectedItems: items.filter(item => item.tier === 'info').length } };
    lastPlan = { report, entries };
    progress('scan-complete', '扫描完成', {}, true);
    return report;
  }
  async function execute(request = {}) {
    if (request.confirmed !== true) throw new Error('请先确认清理清单');
    if (!lastPlan || request.scanId !== lastPlan.report.scanId || now() - lastPlan.report.scannedAt > PLAN_TTL_MS) throw new Error('清单已过期，请重新扫描');
    const keys = [...new Set(Array.isArray(request.keys) ? request.keys : [])];
    if (!keys.length) throw new Error('请先勾选清理项');
    const chosen = keys.map(key => lastPlan.entries.get(key));
    if (chosen.some(entry => !entry)) throw new Error('清单中存在不可清理或未知的项目');
    let release;
    try { release = await acquireDiskReleaseLock(lockKey); } catch (error) {
      if (error.code === 'EEXIST') throw new Error('另一个窗口正在清理，请稍后重试');
      throw error;
    }
    const results = [];
    lastPlan = null;
    try {
      const before = await disk();
      const rows = await processes();
      let index = 0;
      for (const entry of chosen) {
        const { candidate, tree, item } = entry;
        const result = { key: item.key, title: item.title, path: item.path, ok: false, deletedFiles: 0, deletedLogicalBytes: 0 };
        progress('executing', `正在清理 ${++index}/${chosen.length} 项…`, { current: index, total: chosen.length }, true);
        try {
          assertInactive(candidate, rows);
          await assertPlainPath(candidate.path, candidate.root, candidate.mode === 'cache');
          const fresh = await inspectTree(candidate.path, { allowRecent: candidate.mode === 'cache', retainHardLinks: candidate.mode === 'cache' });
          const known = new Map(tree.files.map(file => [file.path, file]));
          if (fresh.files.length !== tree.files.length || fresh.files.some(file => {
            const old = known.get(file.path);
            return !old || old.size !== file.size || old.mtimeMs !== file.mtimeMs || old.ino !== file.ino;
          })) throw new Error('文件在扫描后发生变化，已跳过');
          let failedFiles = 0;
          for (const file of tree.files) {
            try {
              await assertPlainPath(file.path, candidate.path);
              const stat = await fs.lstat(file.path);
              if (!stat.isFile() || stat.size !== file.size || stat.mtimeMs !== file.mtimeMs || stat.ino !== file.ino) { failedFiles++; continue; }
              await fs.unlink(file.path);
              result.deletedFiles++; result.deletedLogicalBytes += file.size;
            } catch { failedFiles++; }
            if (result.deletedFiles % 100 === 0) progress('executing', `正在删除已确认的缓存文件…（${result.deletedFiles} 个）`, { current: index, total: chosen.length });
          }
          for (const folder of [...tree.dirs].reverse()) {
            if (candidate.mode === 'cache' && folder === candidate.path) continue;
            try { await assertPlainPath(folder, candidate.path, true); await fs.rmdir(folder); } catch {}
          }
          result.ok = result.deletedFiles > 0;
          result.partial = failedFiles > 0;
          result.message = failedFiles ? `清理 ${result.deletedFiles} 个文件；${failedFiles} 个在使用或已变化，保留` : `已清理 ${result.deletedFiles} 个文件`;
        } catch (error) { result.message = error.message; }
        results.push(result);
      }
      const after = await disk();
      const report = { ok: true, results, diskBefore: before, diskAfter: after,
        netFreeChangeBytes: after.freeBytes - before.freeBytes,
        freedBytes: Math.max(0, after.freeBytes - before.freeBytes), finishedAt: now() };
      if (options.dataDir) {
        const receiptDir = path.join(options.dataDir, 'disk-release');
        const receipt = path.join(receiptDir, `cleanup-${now()}-${crypto.randomUUID()}.json`);
        try {
          await fs.mkdir(receiptDir, { recursive: true });
          await fs.writeFile(receipt, JSON.stringify(report, null, 2), { encoding: 'utf8', flag: 'wx' }); report.receiptPath = receipt;
        }
        catch { report.receiptError = '清理结果未能保存，可在当前面板查看'; }
      }
      progress('execute-complete', '清理完成', {}, true);
      return report;
    } finally { await release(); }
  }
  return { scan, execute, cancelScan: () => { cancelled = true; }, disk };
}

module.exports = { createDiskReleaseEngine, PLAN_TTL_MS };
