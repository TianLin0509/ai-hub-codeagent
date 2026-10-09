'use strict';

const path = require('path');
const { isPathInsideRoot } = require('../core/file-manager-directory.js');
const {
  DEFAULT_GROUP_LIMIT,
  groupStateKey,
  groupToggleLabel,
  isNoiseFolder,
  planDirectoryGroups,
} = require('./file-manager-grouping.js');
const { createFolderActivityTracker } = require('./file-manager-activity.js');
const { createSessionChangesTracker } = require('./file-manager-session-changes.js');

const CHEVRON_SVG = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="m6 3.5 4.5 4.5L6 12.5"/></svg>';
const FLASH_MS = 1600;
const NAV_SELECTOR = '[data-fm-node], [data-fm-group-toggle], [data-fm-section-toggle]';

const PREVIEWABLE_EXTENSIONS = new Set([
  '.html', '.htm', '.md', '.markdown', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg', '.pdf',
  '.csv', '.tsv', '.json', '.jsonl', '.js', '.ts', '.jsx', '.tsx', '.mjs', '.cjs', '.py', '.go', '.rs',
  '.java', '.c', '.cpp', '.h', '.hpp', '.cs', '.txt', '.log', '.yaml', '.yml', '.toml', '.ini', '.cfg',
  '.conf', '.sh', '.bat', '.ps1', '.xml', '.sql', '.r', '.rb', '.php', '.swift', '.kt', '.lua', '.zig',
  '.asm', '.css', '.scss', '.less',
]);

const FILE_ICON_PATHS = Object.freeze({
  folder: '<path d="M3 6.8A1.8 1.8 0 0 1 4.8 5h4l1.7 1.8h8.7A1.8 1.8 0 0 1 21 8.6v8.6a1.8 1.8 0 0 1-1.8 1.8H4.8A1.8 1.8 0 0 1 3 17.2Z"/>',
  file: '<path d="M6 2.8h7l5 5v13.4H6Z"/><path d="M13 2.8v5h5"/>',
  code: '<path d="M8.5 8 5 12l3.5 4M15.5 8 19 12l-3.5 4M13.5 5l-3 14"/>',
  image: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="1.7"/><path d="m5 18 4.5-4 3.2 2.7 2.7-2.5L19 18"/>',
  table: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 10h18M9 4v16M15 4v16"/>',
  link: '<path d="m9.5 14.5 5-5M7 16.8l-1.3 1.3a3 3 0 0 1-4.2-4.2l3-3a3 3 0 0 1 4.2 0M17 7.2l1.3-1.3a3 3 0 0 1 4.2 4.2l-3 3a3 3 0 0 1-4.2 0"/>',
});

function extensionOf(name) {
  const match = String(name || '').toLowerCase().match(/(\.[^.\\/]+)$/);
  return match ? match[1] : '';
}

function fileVisualKind(name, type = 'file') {
  if (type === 'directory') return 'folder';
  if (type === 'link') return 'link';
  const extension = extensionOf(name);
  if (['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg'].includes(extension)) return 'image';
  if (['.csv', '.tsv', '.json', '.jsonl', '.xml', '.yaml', '.yml', '.toml'].includes(extension)) return 'table';
  if (['.js', '.ts', '.jsx', '.tsx', '.mjs', '.cjs', '.py', '.go', '.rs', '.java', '.c', '.cpp', '.h', '.hpp', '.cs', '.sh', '.bat', '.ps1', '.sql', '.r', '.rb', '.php', '.swift', '.kt', '.lua', '.zig', '.asm', '.css', '.scss', '.less', '.html', '.htm'].includes(extension)) return 'code';
  return 'file';
}

function isPreviewableFile(name) {
  return PREVIEWABLE_EXTENSIONS.has(extensionOf(name));
}

function createFileManagerPanel(options = {}) {
  const document = options.document;
  const windowObject = options.window || (document && document.defaultView) || globalThis;
  const ipcRenderer = options.ipcRenderer;
  const getActiveContext = typeof options.getActiveContext === 'function' ? options.getActiveContext : () => null;
  const openPathInHub = typeof options.openPathInHub === 'function' ? options.openPathInHub : async () => ({ ok: false });
  const onLayoutChange = typeof options.onLayoutChange === 'function' ? options.onLayoutChange : () => {};
  if (!document) throw new Error('document is required');
  if (!ipcRenderer || typeof ipcRenderer.invoke !== 'function') throw new Error('ipcRenderer is required');

  const state = {
    root: '',
    label: '',
    generation: 0,
    cache: new Map(),
    expanded: new Set(),
    expandedGroups: new Set(),
    // 根层分区（本会话改动 / 文件 / 文件夹）的折叠状态，跨根目录保留。
    collapsedSections: new Set(),
    // path -> 高亮开始时间；重渲染时用负 animation-delay 接续，不会重播。
    flash: new Map(),
    sessionStartedAt: 0,
    selectedPath: '',
    query: '',
    statusTimer: null,
  };

  const elements = {};
  let features = null;
  const folderActivity = createFolderActivityTracker({
    ipcRenderer,
    getRoot: () => state.root,
    onUpdate: () => { if (isOpen()) rerenderPreservingView(); },
  });
  const sessionChanges = createSessionChangesTracker({
    ipcRenderer,
    getRoot: () => state.root,
    getSince: () => state.sessionStartedAt,
    onUpdate: () => { if (isOpen()) rerenderPreservingView(); },
  });

  function contextFrom(value, allowFallback = true) {
    if (typeof value === 'string') return { cwd: value, label: '' };
    if (value && typeof value === 'object') {
      return {
        cwd: String(value.cwd || value.root || '').trim(),
        label: String(value.label || value.workspaceLabel || '').trim(),
        sessionStartedAt: Number(value.sessionStartedAt) || 0,
      };
    }
    return allowFallback ? contextFrom(getActiveContext(), false) : { cwd: '', label: '', sessionStartedAt: 0 };
  }

  // 「本会话改动」的起点：显式传入的，或当前会话（同一工作目录）的启动时间；取不到就不显示该区。
  function sessionStartFor(context) {
    if (context.sessionStartedAt > 0) return context.sessionStartedAt;
    const active = contextFrom(getActiveContext(), false);
    return active.cwd && context.cwd && pathKey(active.cwd) === pathKey(context.cwd) ? active.sessionStartedAt : 0;
  }

  function pathKey(value) {
    try { return path.resolve(String(value || '')).toLowerCase(); }
    catch (_) { return String(value || '').toLowerCase(); }
  }

  function isOpen() {
    return !!(elements.panel && elements.panel.style.display !== 'none');
  }

  function isOpenFor(root) {
    return isOpen() && String(root || '').toLowerCase() === state.root.toLowerCase();
  }

  function syncToggleButtons() {
    document.querySelectorAll('.btn-file-manager-toggle').forEach((button) => {
      button.classList.toggle('active', isOpenFor(button.dataset && button.dataset.root));
      button.setAttribute('aria-pressed', String(isOpenFor(button.dataset && button.dataset.root)));
    });
  }

  function scheduleLayoutUpdate() {
    const run = () => {
      try { onLayoutChange(); } catch (_) {}
    };
    if (windowObject && typeof windowObject.requestAnimationFrame === 'function') {
      windowObject.requestAnimationFrame(run);
    } else {
      setTimeout(run, 0);
    }
  }

  function setStatus(message, tone = '', { sticky = false } = {}) {
    if (!elements.status) return;
    if (state.statusTimer) clearTimeout(state.statusTimer);
    state.statusTimer = null;
    elements.status.textContent = String(message || '');
    elements.status.dataset.tone = tone;
    if (message && !sticky) {
      state.statusTimer = setTimeout(() => {
        state.statusTimer = null;
        refreshStatusSummary();
      }, 2200);
    }
  }

  function refreshStatusSummary() {
    const record = state.cache.get(state.root);
    if (!record || record.loading) {
      setStatus(state.root ? '正在读取…' : '当前会话没有工作目录', '', { sticky: true });
      return;
    }
    if (record.error) {
      setStatus(record.error, 'error', { sticky: true });
      return;
    }
    const suffix = record.truncated ? ` · 仅显示前 ${record.entries.length} 项` : '';
    const filter = state.query ? ` · 筛选“${state.query}”` : '';
    setStatus(`${record.total} 项 · 自动刷新${suffix}${filter}`, record.truncated ? 'warning' : '', { sticky: true });
  }

  function iconSvg(kind, className = '') {
    const paths = FILE_ICON_PATHS[kind] || FILE_ICON_PATHS.file;
    return `<svg class="${className}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
  }

  function makeMessageRow(text, depth = 0, tone = '') {
    const row = document.createElement('div');
    row.className = `fm-tree-message${tone ? ` ${tone}` : ''}`;
    row.style.setProperty('--fm-depth', String(depth));
    row.textContent = text;
    return row;
  }

  function descendantMatches(directory, query, seen = new Set()) {
    if (!query || seen.has(directory)) return false;
    seen.add(directory);
    const record = state.cache.get(directory);
    if (!record || !Array.isArray(record.entries)) return false;
    return record.entries.some((entry) => {
      if (entry.name.toLowerCase().includes(query)) return true;
      return entry.type === 'directory' && state.expanded.has(entry.path)
        && descendantMatches(entry.path, query, seen);
    });
  }

  function shouldShowEntry(entry, query) {
    if (!query) return true;
    if (entry.name.toLowerCase().includes(query)) return true;
    return entry.type === 'directory' && state.expanded.has(entry.path)
      && descendantMatches(entry.path, query);
  }

  function makeTreeRow(entry, depth, rowOptions = {}) {
    const row = document.createElement('div');
    row.className = `fm-node fm-node-${entry.type}${entry.hidden ? ' is-hidden' : ''}${isNoiseFolder(entry) ? ' is-noise' : ''}${rowOptions.variant === 'change' ? ' fm-change-row' : ''}`;
    const flashedAt = state.flash.get(entry.path);
    if (flashedAt && Date.now() - flashedAt < FLASH_MS) {
      row.classList.add('fm-flash');
      row.style.animationDelay = `-${Date.now() - flashedAt}ms`;
    }
    row.setAttribute('role', 'none');
    row.style.setProperty('--fm-depth', String(depth));

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'fm-node-button';
    button.dataset.fmNode = 'true';
    button.dataset.path = entry.path;
    button.dataset.type = entry.type;
    button.setAttribute('role', 'treeitem');
    button.setAttribute('aria-level', String(depth + 1));
    if (entry.path === state.selectedPath) button.classList.add('selected');
    if (entry.type === 'directory') {
      button.setAttribute('aria-expanded', String(state.expanded.has(entry.path)));
    }
    const action = entry.type === 'directory'
      ? (state.expanded.has(entry.path) ? '折叠文件夹' : '展开文件夹')
      : (isPreviewableFile(entry.name) ? '在 Hub 中预览' : '使用系统应用打开');
    button.title = `${action} · ${entry.path}`;

    const disclosure = document.createElement('span');
    disclosure.className = 'fm-disclosure';
    if (entry.type === 'directory') {
      disclosure.innerHTML = CHEVRON_SVG;
      disclosure.classList.toggle('expanded', state.expanded.has(entry.path));
    }

    const kind = fileVisualKind(entry.name, entry.type);
    const icon = document.createElement('span');
    icon.className = `fm-node-icon ${kind}`;
    icon.innerHTML = iconSvg(kind);
    const name = document.createElement('span');
    name.className = 'fm-node-name';
    name.textContent = entry.name;
    const meta = document.createElement('span');
    meta.className = 'fm-node-meta';
    if (entry.type === 'directory') {
      const child = state.cache.get(entry.path);
      if (child && !child.loading && !child.error) meta.textContent = String(child.total);
    } else if (entry.type === 'link') {
      meta.textContent = '链接';
    }
    button.append(disclosure, icon, name, meta);
    row.appendChild(button);
    if (features) features.decorateRow(row, button, entry, rowOptions);
    return row;
  }

  // 根层分区标题：可折叠、吸顶；右侧显示当前排序，点击切换升降序。
  function makeSectionHeader({ key, label, count, note = '', sortText = '' }) {
    const collapsed = state.collapsedSections.has(key);
    const header = document.createElement('div');
    header.className = `fm-group-header${collapsed ? ' collapsed' : ''}`;
    header.setAttribute('role', 'presentation');
    header.dataset.group = key;
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'fm-section-toggle';
    toggle.dataset.fmSectionToggle = key;
    toggle.setAttribute('aria-expanded', String(!collapsed));
    toggle.title = collapsed ? `展开${label}` : `折叠${label}`;
    const chevron = document.createElement('span');
    chevron.className = 'fm-section-chevron';
    chevron.innerHTML = CHEVRON_SVG;
    const text = document.createElement('span');
    text.className = 'fm-section-label';
    text.textContent = label;
    const counter = document.createElement('span');
    counter.className = 'fm-group-count';
    counter.textContent = String(count);
    toggle.append(chevron, text, counter);
    if (note) {
      const small = document.createElement('span');
      small.className = 'fm-section-note';
      small.textContent = note;
      toggle.append(small);
    }
    header.append(toggle);
    if (sortText) {
      const sort = document.createElement('button');
      sort.type = 'button';
      sort.className = 'fm-group-sort';
      sort.dataset.fmSort = key;
      sort.title = '切换升序 / 降序（更多排序在筛选菜单）';
      sort.textContent = sortText;
      header.append(sort);
    }
    return header;
  }

  function makeGroupHeader(group) {
    const sortText = features ? features.sortLabel().replace('修改时间', group.group === 'folders' ? '最近改动' : '修改时间') : '';
    return makeSectionHeader({ key: group.group, label: group.label, count: group.total, sortText });
  }

  function toggleSection(key) {
    if (state.collapsedSections.has(key)) state.collapsedSections.delete(key);
    else state.collapsedSections.add(key);
    rerenderPreservingView({ focusSection: key });
  }

  const pad2 = value => String(value).padStart(2, '0');

  // 「本会话改动」区：会话启动后工作区里修改过的文件，默认最多 5 条。
  function appendSessionChanges(query) {
    if (!state.sessionStartedAt || (features && features.mode() !== 'tree')) return;
    const result = sessionChanges.get();
    const started = new Date(state.sessionStartedAt);
    const note = `${pad2(started.getHours())}:${pad2(started.getMinutes())} 启动后`;
    if (!result) {
      elements.tree.appendChild(makeSectionHeader({ key: 'changes', label: '本会话改动', count: '…', note }));
      return;
    }
    const list = result.entries.filter(entry => (!query || entry.name.toLowerCase().includes(query))
      && (!features || features.matchesType(entry)));
    elements.tree.appendChild(makeSectionHeader({ key: 'changes', label: '本会话改动', count: list.length, note }));
    if (state.collapsedSections.has('changes')) return;
    if (result.error) { elements.tree.appendChild(makeMessageRow(`改动扫描失败：${result.error}`, 0, 'error')); return; }
    if (!list.length) {
      if (result.truncated) elements.tree.appendChild(makeMessageRow('扫描达到上限，未找到改动，但可能有遗漏', 0, 'warning'));
      else elements.tree.appendChild(makeMessageRow(query ? '没有匹配的改动' : '会话启动后还没有文件改动', 0));
      return;
    }
    const key = groupStateKey(state.root, 'changes');
    const [plan] = planDirectoryGroups(list, {
      limit: query ? Infinity : DEFAULT_GROUP_LIMIT,
      isExpanded: () => state.expandedGroups.has(key),
      demoteNoise: false,
    });
    for (const entry of plan.visible) elements.tree.appendChild(makeTreeRow(entry, 0, { variant: 'change' }));
    if (plan.showToggle) {
      elements.tree.appendChild(makeGroupToggle(state.root, { ...plan, group: 'changes', label: '改动文件' }, 0));
    }
    if (result.truncated) elements.tree.appendChild(makeMessageRow('扫描达到上限，改动列表可能不完整', 0, 'warning'));
  }

  function makeGroupToggle(directory, group, depth) {
    const row = document.createElement('div');
    row.className = 'fm-group-toggle-row';
    row.setAttribute('role', 'none');
    row.style.setProperty('--fm-depth', String(depth));
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'fm-group-toggle';
    button.dataset.fmGroupToggle = groupStateKey(directory, group.group);
    button.dataset.group = group.group;
    button.setAttribute('role', 'treeitem');
    button.setAttribute('aria-level', String(depth + 1));
    button.setAttribute('aria-expanded', String(group.expanded));
    button.textContent = groupToggleLabel(group);
    row.appendChild(button);
    return row;
  }

  function toggleGroup(key) {
    if (!key) return;
    if (state.expandedGroups.has(key)) state.expandedGroups.delete(key);
    else state.expandedGroups.add(key);
    rerenderPreservingView({ focusToggle: key });
  }

  // 重排（子树活动算完、展开组）时保留滚动位置和键盘焦点。
  function rerenderPreservingView({ focusToggle = '', focusSection = '' } = {}) {
    if (!elements.tree) return;
    const scroll = elements.tree.scrollTop;
    const active = document.activeElement;
    const inTree = !!(active && elements.tree.contains(active));
    const data = inTree && active.dataset ? active.dataset : {};
    const focusedPath = data.path || '';
    const focusedToggle = focusToggle || data.fmGroupToggle || '';
    const focusedSection = focusSection || data.fmSectionToggle || '';
    // 同一路径可能同时出现在「本会话改动」和目录树里，按所在分区区分。
    const focusedChange = !!(inTree && active.closest && active.closest('.fm-change-row'));
    renderTree();
    elements.tree.scrollTop = scroll;
    if (!inTree && !focusToggle && !focusSection) return;
    const target = Array.from(elements.tree.querySelectorAll(NAV_SELECTOR))
      .find(node => (focusedToggle && node.dataset.fmGroupToggle === focusedToggle)
        || (focusedSection && node.dataset.fmSectionToggle === focusedSection)
        || (focusedPath && node.dataset.path === focusedPath && !!node.closest('.fm-change-row') === focusedChange));
    if (target && typeof target.focus === 'function') target.focus({ preventScroll: true });
  }

  function directoryEntriesOf(directories) {
    const result = [];
    for (const directory of directories) {
      const record = state.cache.get(directory);
      if (!record || record.loading || record.error) continue;
      for (const entry of record.entries) if (entry.type === 'directory') result.push(entry.path);
    }
    return result;
  }

  // 只查已显示层级里的文件夹（含被前 N 截掉的，排序需要它们）。
  function requestVisibleActivity({ force = false } = {}) {
    if (!state.root) return Promise.resolve();
    const shown = [state.root, ...Array.from(state.expanded).filter(dir => dir !== state.root)];
    return folderActivity.request(directoryEntriesOf(shown), { force });
  }

  function appendDirectory(directory, depth, query, ancestry = new Set()) {
    if (ancestry.has(directory)) return;
    const nextAncestry = new Set(ancestry);
    nextAncestry.add(directory);
    const record = state.cache.get(directory);
    if (!record || record.loading) {
      elements.tree.appendChild(makeMessageRow('正在读取…', depth, 'loading'));
      return;
    }
    if (record.error) {
      elements.tree.appendChild(makeMessageRow(record.error, depth, 'error'));
      return;
    }
    const shown = (features ? features.sortEntries(record.entries) : record.entries)
      .filter(entry => shouldShowEntry(entry, query) && (!features || features.matchesType(entry)));
    const groups = planDirectoryGroups(shown, {
      // 有筛选词时显示全部匹配，不截断。
      limit: query ? Infinity : DEFAULT_GROUP_LIMIT,
      isExpanded: group => state.expandedGroups.has(groupStateKey(directory, group)),
      isPinned: entry => entry.path === state.selectedPath
        || (entry.type === 'directory' && state.expanded.has(entry.path)),
    });
    for (const group of groups) {
      if (depth === 0) {
        elements.tree.appendChild(makeGroupHeader(group));
        if (state.collapsedSections.has(group.group)) continue;
      }
      for (const entry of group.visible) {
        elements.tree.appendChild(makeTreeRow(entry, depth));
        if (entry.type === 'directory' && state.expanded.has(entry.path)) {
          appendDirectory(entry.path, depth + 1, query, nextAncestry);
        }
      }
      if (group.showToggle) elements.tree.appendChild(makeGroupToggle(directory, group, depth));
    }
    if (record.truncated) {
      elements.tree.appendChild(makeMessageRow(`此目录共 ${record.total} 项，仅显示前 ${record.entries.length} 项`, depth, 'warning'));
    }
  }

  function renderTree() {
    if (!elements.tree) return;
    elements.tree.replaceChildren();
    if (!state.root) {
      elements.tree.appendChild(makeMessageRow('打开一个带工作目录的会话后即可浏览文件。'));
      refreshStatusSummary();
      return;
    }
    if (features && features.renderResults()) { features.afterRender(); return; }
    appendSessionChanges(state.query.toLowerCase());
    const before = elements.tree.children.length;
    appendDirectory(state.root, 0, state.query.toLowerCase());
    if (elements.tree.children.length === before) {
      elements.tree.appendChild(makeMessageRow(state.query ? '没有匹配的已加载文件' : '这个文件夹是空的'));
    }
    for (const [key, at] of state.flash) if (Date.now() - at >= FLASH_MS) state.flash.delete(key);
    refreshStatusSummary();
    if (features) features.afterRender();
  }

  async function loadDirectory(directory, generation = state.generation) {
    state.cache.set(directory, { loading: true, entries: [], total: 0, truncated: false, error: '' });
    renderTree();
    let result;
    try {
      result = await ipcRenderer.invoke('file-manager:list-directory', {
        root: state.root,
        directory,
        limit: 3000,
      });
    } catch (error) {
      result = { ok: false, error: String(error && error.message || error), entries: [] };
    }
    if (generation !== state.generation || !isOpen()) return result;
    state.cache.set(directory, {
      loading: false,
      entries: result && Array.isArray(result.entries) ? result.entries : [],
      total: Number(result && result.total) || 0,
      truncated: !!(result && result.truncated),
      error: result && result.ok === true ? '' : String(result && result.error || '目录读取失败'),
    });
    renderTree();
    if (result && result.ok === true) void folderActivity.request(directoryEntriesOf([directory]));
    return result;
  }

  async function setRoot(context) {
    const next = contextFrom(context);
    if (features) features.rootChanging(next.cwd);
    state.generation += 1;
    state.root = next.cwd;
    state.label = next.label;
    state.cache.clear();
    state.expanded.clear();
    state.expandedGroups.clear();
    state.flash.clear();
    state.sessionStartedAt = sessionStartFor(next);
    folderActivity.clear();
    sessionChanges.clear();
    state.selectedPath = '';
    state.query = '';
    if (elements.filter) elements.filter.value = '';
    if (elements.rootName) elements.rootName.textContent = next.label || (next.cwd ? next.cwd.split(/[\\/]/).filter(Boolean).pop() : '未选择目录');
    if (elements.rootPath) {
      elements.rootPath.textContent = next.cwd || '当前会话没有工作目录';
      elements.rootPath.disabled = !next.cwd;
    }
    if (elements.rootButton) {
      elements.rootButton.disabled = !next.cwd;
      elements.rootButton.title = next.cwd ? `切换目录、收藏与产物目录 · ${next.cwd}` : '当前会话没有工作目录';
    }
    if (!next.cwd) {
      renderTree();
      syncToggleButtons();
      return { ok: false, error: 'missing workspace' };
    }
    state.expanded.add(next.cwd);
    syncToggleButtons();
    void sessionChanges.refresh({ force: true });
    return loadDirectory(next.cwd, state.generation);
  }

  function dispatchPanelOpening() {
    const CustomEventCtor = windowObject && windowObject.CustomEvent;
    if (typeof CustomEventCtor === 'function') {
      document.dispatchEvent(new CustomEventCtor('hub-side-panel-opening', { detail: { panel: 'files' } }));
    }
  }

  async function open(context) {
    const next = contextFrom(context);
    dispatchPanelOpening();
    elements.panel.style.display = 'flex';
    elements.panel.setAttribute('aria-hidden', 'false');
    scheduleLayoutUpdate();
    return setRoot(next);
  }

  function scrollSelectedIntoView() {
    const selectedKey = pathKey(state.selectedPath);
    if (!selectedKey || !elements.tree) return;
    const selected = Array.from(elements.tree.querySelectorAll('[data-fm-node]'))
      .find(button => pathKey(button.dataset.path) === selectedKey);
    if (selected && typeof selected.scrollIntoView === 'function') {
      selected.scrollIntoView({ block: 'center', inline: 'nearest' });
    }
  }

  async function revealDirectory(directory) {
    const target = path.resolve(String(directory || ''));
    if (!state.root || !isPathInsideRoot(state.root, target)) {
      return { ok: false, error: 'target is outside the displayed root', code: 'outside_root' };
    }
    const relative = path.relative(state.root, target);
    if (!relative) {
      state.selectedPath = '';
      renderTree();
      setStatus('已在文件管理中打开', 'success');
      return { ok: true, root: state.root, target, revealed: true };
    }

    let current = state.root;
    for (const segment of relative.split(path.sep).filter(Boolean)) {
      const expected = path.join(current, segment);
      const record = state.cache.get(current);
      const entry = record && !record.loading && !record.error
        ? record.entries.find(item => item.type === 'directory' && pathKey(item.path) === pathKey(expected))
        : null;
      if (!entry) {
        return { ok: false, error: `无法在文件树中定位目录：${expected}`, code: 'directory_not_found' };
      }
      current = entry.path;
      state.expanded.add(current);
      if (!state.cache.has(current)) {
        const loaded = await loadDirectory(current, state.generation);
        if (!loaded || loaded.ok !== true) {
          return { ok: false, error: loaded && loaded.error || `目录读取失败：${current}`, code: 'read_failed' };
        }
      }
    }
    state.selectedPath = current;
    renderTree();
    scrollSelectedIntoView();
    setStatus('已定位到目录', 'success');
    return { ok: true, root: state.root, target: current, revealed: true };
  }

  async function openDirectory(directory, context) {
    const target = typeof directory === 'string' && path.isAbsolute(directory)
      ? path.resolve(directory)
      : '';
    if (!target) return { ok: false, error: 'invalid directory path', code: 'invalid_path' };
    const preferred = contextFrom(context);
    const active = contextFrom(getActiveContext(), false);
    if (!preferred.label && active.cwd && pathKey(active.cwd) === pathKey(preferred.cwd)) {
      preferred.label = active.label;
    }
    const preferredRoot = preferred.cwd && isPathInsideRoot(preferred.cwd, target)
      ? path.resolve(preferred.cwd)
      : target;
    let opened = await open({
      cwd: preferredRoot,
      label: pathKey(preferredRoot) === pathKey(target)
        ? (preferred.label || path.basename(target))
        : preferred.label,
    });
    if ((!opened || opened.ok !== true) && pathKey(preferredRoot) !== pathKey(target)) {
      opened = await open({ cwd: target, label: path.basename(target) });
    }
    if (!opened || opened.ok !== true) return opened || { ok: false, error: 'directory open failed' };

    const revealed = await revealDirectory(target);
    if (revealed.ok) return revealed;
    if (pathKey(state.root) !== pathKey(target)) {
      const fallback = await open({ cwd: target, label: path.basename(target) });
      if (fallback && fallback.ok === true) {
        setStatus('已在文件管理中打开', 'success');
        return { ok: true, root: target, target, revealed: false };
      }
      return fallback;
    }
    return revealed;
  }

  function close() {
    if (!elements.panel || elements.panel.style.display === 'none') return false;
    state.generation += 1;
    if (features) features.close();
    elements.panel.style.display = 'none';
    elements.panel.setAttribute('aria-hidden', 'true');
    syncToggleButtons();
    scheduleLayoutUpdate();
    return true;
  }

  function toggle(context) {
    const next = contextFrom(context);
    if (isOpenFor(next.cwd)) {
      close();
      return Promise.resolve({ ok: true, closed: true });
    }
    return open(next);
  }

  function syncContext(context) {
    if (!isOpen()) {
      syncToggleButtons();
      return Promise.resolve(false);
    }
    const next = contextFrom(context);
    if (next.cwd.toLowerCase() === state.root.toLowerCase()) {
      // 同一工作目录切换到另一个会话：只更新「本会话改动」的起点。
      const startedAt = sessionStartFor(next);
      if (startedAt !== state.sessionStartedAt) {
        state.sessionStartedAt = startedAt;
        sessionChanges.clear();
        void sessionChanges.refresh({ force: true });
        rerenderPreservingView();
      }
      syncToggleButtons();
      return Promise.resolve(false);
    }
    return setRoot(next).then(() => true);
  }

  async function openRootExternal() {
    if (!state.root) return;
    let error = '';
    try { error = await ipcRenderer.invoke('open-path', state.root); }
    catch (caught) { error = String(caught && caught.message || caught); }
    setStatus(error ? `打开失败：${error}` : '已在资源管理器中打开', error ? 'error' : 'success');
  }

  async function copyRootPath() {
    if (!state.root) return;
    let result;
    try { result = await ipcRenderer.invoke('file-manager:copy', { root: state.root, paths: [state.root], kind: 'path' }); }
    catch (error) { result = { ok: false, error: String(error && error.message || error) }; }
    setStatus(result && result.ok ? '已复制路径' : `复制失败：${result && result.error || '未知错误'}`, result && result.ok ? 'success' : 'error');
  }

  async function activateEntry(button) {
    const targetPath = String(button.dataset.path || '');
    const type = String(button.dataset.type || 'file');
    if (!targetPath) return;
    // 重渲染会替换 DOM；把键盘焦点还给同一分区里的同一行，Ctrl+P / 方向键才能接着用。
    const inChange = !!button.closest('.fm-change-row');
    const refocus = () => {
      const node = Array.from(elements.tree.querySelectorAll('[data-fm-node]'))
        .find(item => item.dataset.path === targetPath && !!item.closest('.fm-change-row') === inChange);
      if (node && typeof node.focus === 'function') node.focus({ preventScroll: true });
    };
    if (type === 'directory') {
      if (state.expanded.has(targetPath)) {
        state.expanded.delete(targetPath);
        renderTree();
        refocus();
        return;
      }
      state.expanded.add(targetPath);
      if (!state.cache.has(targetPath)) await loadDirectory(targetPath);
      else renderTree();
      refocus();
      return;
    }
    if (type === 'link' || type === 'other') {
      let error = '';
      try { error = await ipcRenderer.invoke('open-path', targetPath); }
      catch (caught) { error = String(caught && caught.message || caught); }
      setStatus(error ? `打开失败：${error}` : '已使用系统应用打开', error ? 'error' : 'success');
      return;
    }
    state.selectedPath = targetPath;
    renderTree();
    refocus();
    let result;
    try {
      result = await openPathInHub(targetPath, { cwd: state.root, preview: true });
    } catch (error) {
      setStatus(`文件打开失败：${String(error && error.message || error)}`, 'error');
      return;
    }
    if (!result || result.ok === false) {
      setStatus(result && result.error ? result.error : '文件打开失败', 'error');
      return;
    }
    setStatus(result.type === 'preview' ? '已在 Hub 中预览' : '已使用系统应用打开', 'success');
  }

  function handleTreeKeyboard(event) {
    const current = event.target && event.target.closest && event.target.closest(NAV_SELECTOR);
    if (!current) return;
    const buttons = Array.from(elements.tree.querySelectorAll(NAV_SELECTOR));
    const index = buttons.indexOf(current);
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const delta = event.key === 'ArrowDown' ? 1 : -1;
      const next = buttons[Math.max(0, Math.min(buttons.length - 1, index + delta))];
      if (next) next.focus();
      return;
    }
    if (event.key === 'ArrowRight' && current.dataset.type === 'directory' && current.getAttribute('aria-expanded') !== 'true') {
      event.preventDefault();
      void activateEntry(current);
    } else if (event.key === 'ArrowLeft' && current.dataset.type === 'directory' && current.getAttribute('aria-expanded') === 'true') {
      event.preventDefault();
      void activateEntry(current);
    }
  }

  function init() {
    elements.panel = document.getElementById('file-manager-panel');
    elements.tree = document.getElementById('file-manager-tree');
    elements.filter = document.getElementById('file-manager-filter');
    elements.status = document.getElementById('file-manager-status');
    elements.rootButton = document.getElementById('file-manager-root');
    elements.rootName = document.getElementById('file-manager-root-name');
    elements.rootPath = document.getElementById('file-manager-root-path');
    elements.viewMenu = document.getElementById('file-manager-view-menu');
    elements.close = document.getElementById('file-manager-close');
    elements.refresh = document.getElementById('file-manager-refresh');
    elements.openExternal = document.getElementById('file-manager-open-external');
    if (!elements.panel || !elements.tree || !elements.filter) return false;

    elements.close.addEventListener('click', close);
    elements.refresh.addEventListener('click', () => { if (state.root) void features.refresh({ force: true }); });
    elements.openExternal.addEventListener('click', () => { void openRootExternal(); });
    elements.rootPath.addEventListener('click', () => { void copyRootPath(); });
    // Ctrl+P 聚焦筛选框：只在焦点位于文件面板内时生效，不抢终端 / CLI 自己的 Ctrl+P。
    elements.panel.addEventListener('keydown', (event) => {
      if (!(event.ctrlKey || event.metaKey) || event.shiftKey || event.altKey || String(event.key).toLowerCase() !== 'p') return;
      event.preventDefault();
      event.stopPropagation();
      elements.filter.focus();
      elements.filter.select();
    }, true);
    elements.filter.addEventListener('input', () => {
      state.query = elements.filter.value.trim();
      if (features && features.searchChanged()) return;
      renderTree();
    });
    for (const name of ['keydown', 'keypress', 'keyup']) {
      elements.filter.addEventListener(name, event => event.stopPropagation());
    }
    elements.tree.addEventListener('click', (event) => {
      const groupToggle = event.target.closest && event.target.closest('[data-fm-group-toggle]');
      if (groupToggle) { toggleGroup(groupToggle.dataset.fmGroupToggle); return; }
      const sectionToggle = event.target.closest && event.target.closest('[data-fm-section-toggle]');
      if (sectionToggle) { toggleSection(sectionToggle.dataset.fmSectionToggle); return; }
      if (event.target.closest && event.target.closest('[data-fm-sort]')) { features.toggleSortDirection(); return; }
      const button = event.target.closest && event.target.closest('[data-fm-node]');
      if (features && features.handleClick(event, button)) return;
      if (button) void activateEntry(button);
    });
    elements.tree.addEventListener('keydown', handleTreeKeyboard);
    document.addEventListener('hub-side-panel-opening', (event) => {
      if (event && event.detail && event.detail.panel !== 'files') close();
    });
    features = require('./file-manager-features').createFileManagerFeatures({
      document, window: windowObject, ipcRenderer, state, elements, renderTree, makeTreeRow, setStatus,
      isOpen, setRoot, activateEntry, onLayoutChange: scheduleLayoutUpdate,
      addToConversation: options.addToConversation, listConversationTargets: options.listConversationTargets,
      folderActivity, requestVisibleActivity, isPreviewableFile, openRootExternal,
      refreshSessionChanges: refreshOptions => sessionChanges.refresh(refreshOptions),
    });
    features.init();
    renderTree();
    return true;
  }

  return {
    close,
    init,
    isOpen,
    isOpenFor,
    open,
    openDirectory,
    refresh: () => features.refresh(),
    syncContext,
    toggle,
  };
}

module.exports = {
  PREVIEWABLE_EXTENSIONS,
  createFileManagerPanel,
  extensionOf,
  fileVisualKind,
  isPreviewableFile,
};
