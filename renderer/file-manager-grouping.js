'use strict';

// 目录树每一层分成「文件」「文件夹」两组（文件在前），每组默认只露出前 N 个。
// 纯逻辑：输入已排序、已筛选的条目，输出每组要显示哪些、还藏了几个。

const DEFAULT_GROUP_LIMIT = 5;
const GROUP_ORDER = Object.freeze(['files', 'folders']);
const GROUP_LABELS = Object.freeze({ files: '文件', folders: '文件夹' });
// 噪声目录降权：不占文件夹前 N 名额，统一排在文件夹组末尾；本身照常可见、可展开。
const NOISE_FOLDERS = new Set(['.git', 'node_modules', '__pycache__', '.pytest_cache']);

function isNoiseFolder(entry) {
  return !!(entry && entry.type === 'directory' && NOISE_FOLDERS.has(entry.name));
}

// 链接 / other 与文件同组：它们不能在树里展开。
function entryGroup(entry) {
  return entry && entry.type === 'directory' ? 'folders' : 'files';
}

function groupStateKey(directory, group) {
  return `${String(directory || '').toLowerCase()}|${group}`;
}

function planDirectoryGroups(entries, options = {}) {
  const limit = Number.isFinite(options.limit) && options.limit >= 0 ? options.limit : Infinity;
  const isExpanded = typeof options.isExpanded === 'function' ? options.isExpanded : () => false;
  const isPinned = typeof options.isPinned === 'function' ? options.isPinned : () => false;
  const buckets = { files: [], folders: [] };
  for (const entry of entries || []) buckets[entryGroup(entry)].push(entry);
  if (options.demoteNoise !== false) {
    buckets.folders = [...buckets.folders.filter(e => !isNoiseFolder(e)), ...buckets.folders.filter(isNoiseFolder)];
  }
  return GROUP_ORDER.filter(group => buckets[group].length).map((group) => {
    const all = buckets[group];
    const expanded = !!isExpanded(group);
    const limited = all.length > limit;
    // 已展开的文件夹、当前选中项超出前 N 也保留，避免刷新重排后「消失」。
    const visible = expanded || !limited ? all : all.filter((entry, index) => index < limit || isPinned(entry));
    const hiddenCount = all.length - visible.length;
    return {
      group,
      label: GROUP_LABELS[group],
      total: all.length,
      visible,
      hiddenCount,
      expanded,
      limit,
      showToggle: limited && (expanded || hiddenCount > 0),
    };
  });
}

function groupToggleLabel(plan) {
  if (!plan || !plan.showToggle) return '';
  if (plan.expanded) return `收起${plan.label}`;
  return `显示全部 ${plan.total} 个${plan.label}`;
}

module.exports = {
  DEFAULT_GROUP_LIMIT,
  GROUP_LABELS,
  GROUP_ORDER,
  NOISE_FOLDERS,
  entryGroup,
  isNoiseFolder,
  groupStateKey,
  groupToggleLabel,
  planDirectoryGroups,
};
