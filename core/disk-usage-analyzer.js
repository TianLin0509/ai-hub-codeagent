'use strict';

const fs = require('fs').promises;
const path = require('path');
const os = require('os');
const { inside } = require('./disk-release-policy');
const { allocatedSizes } = require('./disk-release-windows');

function usageScopes({ testRoot } = {}) {
  if (testRoot) return [{ root: testRoot, label: '隔离测试占用', note: '仅查看占用，文件保留。' }];
  const home = os.homedir(); const drive = process.env.SystemDrive || 'C:';
  return [
    { root: path.join(home, 'Desktop'), label: '桌面和交付产物', note: '照片和文档请先备份；旧视频、重复导出文件可按需整理。' },
    { root: path.join(home, 'xwechat_files'), label: '微信文件与备份', note: '在微信中管理聊天附件和备份，确认保留需要的记录。' },
    { root: path.join(home, '.codex'), label: 'Codex 会话与数据', note: '包含聊天历史；先归档，再选择需要移走的记录。' },
    { root: path.join(home, '.codex-profiles'), label: '其他 Codex 配置与历史', note: '包含配置、鉴权和聊天历史，需按具体用途整理。' },
    { root: path.join(home, '.claude'), label: 'Claude 会话与数据', note: '包含聊天历史和个人记忆，需先归档。' },
    { root: path.join(home, '.ai-hub-community'), label: 'AI Hub 数据', note: '包含正式会话、索引和配置，正在使用的数据保留。' },
    { root: path.join(home, '.android'), label: 'Android 虚拟设备', note: '包含设备快照和登录状态；可在 Android 设备管理器中删除不用的设备。' },
    { root: path.join(home, '.conda'), label: 'Conda 环境与包', note: '环境与包可能共享文件，应使用 Conda 按环境名称卸载。' },
    { root: process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), label: '应用数据和临时文件', note: '可重建缓存从“清理数据”选择；其他应用数据在对应应用中管理。' },
    { root: path.join(drive, 'Vibe'), label: 'Vibe 项目和实验', note: '源码、实验结果和工作副本需按项目确认，旧输出可归档到其他磁盘。' },
    { root: path.join(drive, 'AIWork'), label: 'AIWork 任务与产物', note: '按任务整理旧产物和环境；目录链接会跳过，避免重复计入。' },
    { root: path.join(drive, 'AppData'), label: '模型、浏览器与测试数据', note: '大模型、浏览器配置与剩余测试设备需按用途保留或迁移。' },
  ];
}

// Read-only and bounded: this module never produces cleanup keys or calls unlink/rmdir.
function createDiskUsageAnalyzer(options = {}) {
  const scopes = options.scopes || usageScopes(options);
  const measure = options.allocatedSizes || allocatedSizes;
  const now = options.now || Date.now;
  const maxFiles = options.maxFiles ?? 25000;
  const maxDirs = options.maxDirs ?? 10000;
  const maxMs = options.maxMs ?? 5000;
  let cancelled = false;
  function check() { if (cancelled) throw new Error('占用分析已取消'); }
  async function plain(folder, root) {
    const stat = await fs.lstat(folder);
    if (stat.isSymbolicLink() || !stat.isDirectory()) return false;
    const real = await fs.realpath(folder);
    return inside(root, real, true) && path.resolve(real).toLowerCase() === path.resolve(folder).toLowerCase();
  }
  async function analyzeScope(scope, index) {
    check(); const root = path.resolve(scope.root);
    const item = { path: root, title: scope.label, note: scope.note, bytes: 0, fileCount: 0,
      partial: false, skippedLinks: 0, unreadable: 0, sharedFiles: 0, children: [] };
    try { if (!await plain(root, root)) return { ...item, partial: true, reason: '目录链接已跳过' }; }
    catch (error) { return error.code === 'ENOENT' ? null : { ...item, partial: true, reason: '没有权限或暂时无法读取' }; }
    // Visit sibling tasks before spending the budget inside one deep environment.
    const started = now(); const queue = [root]; const files = []; let folders = 0;
    const identities = new Set(); let stop = false;
    while (folders < queue.length && !stop) {
      check();
      if (now() - started > maxMs || folders >= maxDirs) { item.partial = true; break; }
      const folder = queue[folders++];
      options.onProgress?.({ phase: 'usage', message: `分析 ${index + 1}/${scopes.length}：${scope.label}（已检查 ${files.length} 个文件）` });
      try {
        if (!await plain(folder, root)) { item.skippedLinks++; continue; }
        const entries = await fs.readdir(folder, { withFileTypes: true });
        for (const entry of entries) {
          check();
          if (now() - started > maxMs || files.length >= maxFiles) { item.partial = true; stop = true; break; }
          const target = path.join(folder, entry.name);
          try {
            const stat = await fs.lstat(target);
            if (stat.isSymbolicLink()) { item.skippedLinks++; continue; }
            if (stat.isDirectory()) { queue.push(target); continue; }
            if (!stat.isFile()) { item.unreadable++; continue; }
            const identity = `${stat.dev}:${stat.ino}`;
            if (stat.nlink > 1 && stat.ino) {
              if (identities.has(identity)) { item.sharedFiles++; continue; }
              identities.add(identity);
            }
            const relative = path.relative(root, target);
            const first = relative.split(path.sep)[0];
            files.push({ path: target, size: stat.size, child: relative.includes(path.sep) ? first : '根目录文件' });
          } catch { item.unreadable++; }
        }
      } catch { item.unreadable++; }
    }
    check();
    options.onProgress?.({ phase: 'usage', message: `核对 ${scope.label} 的实际磁盘占用…` });
    // Files can disappear while applications are running. Never substitute logical size for failed allocation checks.
    let sizes;
    try { sizes = await measure(files); }
    catch { sizes = []; item.unreadable += files.length; }
    check(); const children = new Map();
    for (let i = 0; i < files.length; i++) {
      if (!Array.isArray(sizes) || !Number.isFinite(sizes[i]) || sizes[i] < 0) { item.partial = true; continue; }
      const file = files[i]; item.bytes += sizes[i]; item.fileCount++;
      const child = children.get(file.child) || { title: file.child, bytes: 0 };
      child.bytes += sizes[i]; children.set(file.child, child);
    }
    item.partial ||= item.skippedLinks > 0 || item.unreadable > 0;
    item.children = [...children.values()].sort((a, b) => b.bytes - a.bytes).slice(0, 8);
    if (item.partial) item.reason = '仅显示已核对部分；文件很多、目录链接或读取受限的部分未计入';
    return item;
  }
  async function analyze() {
    cancelled = false; const items = [];
    for (let i = 0; i < scopes.length; i++) {
      const item = await analyzeScope(scopes[i], i); if (item) items.push(item);
    }
    check();
    items.sort((a, b) => b.bytes - a.bytes);
    return { ok: true, scannedAt: now(), items, readOnly: true,
      limits: { maxFilesPerDirectory: maxFiles, maxMsPerDirectory: maxMs } };
  }
  return { analyze, cancel: () => { cancelled = true; } };
}

module.exports = { createDiskUsageAnalyzer, usageScopes };
