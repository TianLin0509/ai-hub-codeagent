'use strict';

// 渲染侧的文件夹「最近活动时间」缓存：向 main 批量查询子树最大 mtime，
// 结果带 TTL，4 秒自动刷新只补查过期或新出现的文件夹；手动刷新可强制重算。

const path = require('path');

const DEFAULT_TRACKER_TTL_MS = 120000;
const DEFAULT_BATCH_SIZE = 24;
const REASON_LABELS = Object.freeze({
  time: '超出扫描时间',
  entries: '超出条目上限',
  depth: '超出目录深度',
  unreadable: '部分目录无权限',
});

function formatStamp(ms) {
  return new Date(ms).toLocaleString('zh-CN', { hour12: false });
}

function createFolderActivityTracker(options = {}) {
  const ipcRenderer = options.ipcRenderer;
  const getRoot = typeof options.getRoot === 'function' ? options.getRoot : () => '';
  const onUpdate = typeof options.onUpdate === 'function' ? options.onUpdate : () => {};
  const ttlMs = Number.isFinite(options.ttlMs) ? options.ttlMs : DEFAULT_TRACKER_TTL_MS;
  const batchSize = Math.max(1, options.batchSize || DEFAULT_BATCH_SIZE);
  const now = options.now || Date.now;
  const results = new Map();
  const pending = new Set();
  let version = 0;

  const key = value => String(value || '').toLowerCase();
  const get = directory => results.get(key(directory)) || null;
  const isPending = directory => pending.has(key(directory));

  async function request(directories, { force = false } = {}) {
    const root = getRoot();
    if (!root || !ipcRenderer) return;
    const run = version;
    const todo = [...new Set((directories || []).filter(Boolean))].filter((directory) => {
      if (pending.has(key(directory))) return false;
      const known = results.get(key(directory));
      return force || !known || now() - known.at > ttlMs;
    });
    if (!todo.length) return;
    todo.forEach(directory => pending.add(key(directory)));
    try {
      for (let index = 0; index < todo.length; index += batchSize) {
        const chunk = todo.slice(index, index + batchSize);
        let response;
        try {
          response = await ipcRenderer.invoke('file-manager:folder-activity', { root, directories: chunk, force });
        } catch (error) {
          response = { ok: false, error: String(error && error.message || error) };
        }
        if (run !== version) return;
        const byDirectory = new Map((response && Array.isArray(response.results) ? response.results : [])
          .map(item => [key(item.directory), item]));
        let changed = false;
        for (const directory of chunk) {
          const item = byDirectory.get(key(directory))
            || { ok: false, directory, error: response && response.error || '子树活动查询失败' };
          const previous = results.get(key(directory));
          if (!previous || previous.ok !== item.ok || previous.latestMs !== item.latestMs
            || previous.latestPath !== item.latestPath || previous.incomplete !== item.incomplete) changed = true;
          results.set(key(directory), { ...item, at: now() });
          pending.delete(key(directory));
        }
        // TTL 到期重查但结果不变时不重绘，避免打断悬停与菜单。
        if (changed) onUpdate();
      }
    } finally {
      if (run === version) todo.forEach(directory => pending.delete(key(directory)));
    }
  }

  function clear() {
    version += 1;
    results.clear();
    pending.clear();
  }

  // 文件夹按 max(自身 mtime, 子树最近改动) 排序和显示；文件直接用自身 mtime。
  function effectiveMtime(entry) {
    const own = Number.isFinite(entry && entry.mtimeMs) ? entry.mtimeMs : null;
    if (!entry || entry.type !== 'directory') return own;
    const activity = get(entry.path);
    const deep = activity && activity.ok !== false && Number.isFinite(activity.latestMs) ? activity.latestMs : null;
    if (own === null) return deep;
    return deep === null ? own : Math.max(own, deep);
  }

  function describe(entry) {
    if (!entry || entry.type !== 'directory') return '';
    const activity = get(entry.path);
    if (!activity) return isPending(entry.path) ? '正在计算子树最近改动…（暂按文件夹自身修改时间）' : '';
    if (activity.ok === false) return `子树最近改动未知：${activity.error || '查询失败'}（按文件夹自身修改时间）`;
    if (activity.skipped) return '依赖 / 仓库目录不扫描子树，显示文件夹自身修改时间';
    if (!Number.isFinite(activity.latestMs)) return `子树为空${activity.incomplete ? '（扫描不完整）' : ''}，显示文件夹自身修改时间`;
    const relative = path.relative(entry.path, activity.latestPath) || path.basename(activity.latestPath);
    const reasons = (activity.reasons || []).map(reason => REASON_LABELS[reason] || reason).join('、');
    return `子树最近改动：${relative} ${formatStamp(activity.latestMs)}${activity.incomplete ? `（扫描不完整：${reasons}）` : ''}`;
  }

  return { clear, describe, effectiveMtime, get, isPending, request };
}

module.exports = { DEFAULT_TRACKER_TTL_MS, createFolderActivityTracker };
