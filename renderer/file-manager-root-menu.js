'use strict';

// 根目录下拉：前进 / 后退 / 上级 / 路径跳转、收藏与快捷目录、新建文件夹、交付记录。

const path = require('path');
const { createPopover, menuButton, menuSection } = require('./file-manager-popover');

const QUICK_DIRECTORIES = ['artifacts', 'output'];

function createRootMenu(o) {
  const { document: d, window: w, anchor, prefs, report } = o;
  let history = [];
  let historyIndex = -1;
  let historyMoving = false;
  const saved = prefs.load();
  let favorites = Array.isArray(saved.favorites) ? saved.favorites.filter(f => f && path.isAbsolute(f.path || '')) : [];

  function persist() {
    try { prefs.save({ favorites }); }
    catch (error) { report(new Error(`收藏未保存：${error.message}`)); }
  }
  async function navigate(root, moving = false) {
    historyMoving = moving;
    try { await o.setRoot({ cwd: root, label: path.basename(root) }); } finally { historyMoving = false; }
  }
  function rootChanging(root) {
    if (root && root !== history[historyIndex] && !historyMoving) {
      history = history.slice(0, historyIndex + 1); history.push(root); historyIndex = history.length - 1;
    }
    popover.close();
  }
  function toggleFavorite(paths, typeOf) {
    for (const file of paths) {
      const existing = favorites.findIndex(f => f.path === file);
      if (existing >= 0) favorites.splice(existing, 1);
      else favorites.push({ path: file, type: typeOf(file) || 'directory' });
    }
    persist();
  }
  const run = action => async () => {
    popover.close();
    try { await action(); } catch (error) { report(error); }
  };

  const popover = createPopover({
    document: d, window: w, anchor, className: 'fm-root-menu', label: '目录与收藏',
    build(box) {
      const root = o.getRoot();
      const nav = d.createElement('div'); nav.className = 'fm-root-nav'; box.append(nav);
      menuButton(d, nav, '←', run(() => { historyIndex--; return navigate(history[historyIndex], true); }), { className: 'fm-nav-button', title: '后退', disabled: historyIndex <= 0, data: { fmNav: 'back' } });
      menuButton(d, nav, '→', run(() => { historyIndex++; return navigate(history[historyIndex], true); }), { className: 'fm-nav-button', title: '前进', disabled: historyIndex >= history.length - 1, data: { fmNav: 'forward' } });
      menuButton(d, nav, '↑', run(() => navigate(path.dirname(root))), { className: 'fm-nav-button', title: '上级目录', disabled: !root || path.dirname(root) === root, data: { fmNav: 'up' } });
      const input = d.createElement('input');
      input.className = 'fm-root-path-input'; input.value = root; input.spellcheck = false;
      input.setAttribute('aria-label', '目录路径（回车跳转）');
      input.addEventListener('keydown', event => { if (event.key === 'Enter') void run(() => navigate(input.value.trim()))(); });
      nav.append(input);

      const favSection = menuSection(d, box, '收藏');
      for (const f of favorites) {
        menuButton(d, favSection, `★ ${path.basename(f.path)}`, run(async () => {
          if (f.type === 'directory') await navigate(f.path);
          else { const r = await o.ipcRenderer.invoke('show-in-folder', f.path); if (r?.error) throw new Error(r.error); }
        }), { title: f.path });
      }
      const pinned = favorites.some(f => f.path === root);
      menuButton(d, favSection, pinned ? '取消固定当前目录' : '＋ 固定当前目录', run(() => toggleFavorite([root], () => 'directory')), { disabled: !root, data: { fmRootAction: 'pin' } });

      const existing = new Set((o.rootEntries() || []).filter(e => e.type === 'directory').map(e => e.name));
      const quick = QUICK_DIRECTORIES.filter(name => existing.has(name));
      if (quick.length) {
        const quickSection = menuSection(d, box, '产物目录');
        for (const name of quick) menuButton(d, quickSection, name, run(() => navigate(path.join(root, name))), { title: path.join(root, name) });
      }

      const actions = menuSection(d, box, '操作');
      menuButton(d, actions, '新建文件夹…', run(() => o.newFolder()), { disabled: !root, data: { fmRootAction: 'mkdir' } });
      menuButton(d, actions, o.jobsOpen() ? '收起交付记录' : '交付记录', run(() => o.toggleJobs()), { data: { fmRootAction: 'jobs' } });
      menuButton(d, actions, '在资源管理器中打开', run(() => o.openExternal()), { disabled: !root });
    },
  });
  anchor.addEventListener('click', () => { if (!anchor.disabled) popover.toggle(); });

  return {
    close: () => popover.close(),
    isOpen: () => popover.isOpen(),
    navigate,
    rootChanging,
    toggleFavorite,
  };
}

module.exports = { createRootMenu };
