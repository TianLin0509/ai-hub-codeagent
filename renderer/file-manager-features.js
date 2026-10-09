'use strict';
const path = require('path');
const { pathToFileURL } = require('url');
const { createPrefs, createViewOptions, TYPE_GROUPS } = require('./file-manager-view-options');
const { createRootMenu } = require('./file-manager-root-menu');
const { formatFullTime, formatRelativeTime, isFresh } = require('./file-manager-time');

function formatSize(bytes) {
  if (!Number.isFinite(bytes)) return '—';
  if (bytes < 1024) return `${bytes} B`;
  const unit = Math.min(3, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / 1024 ** unit).toFixed(1)} ${['B', 'KB', 'MB', 'GB'][unit]}`;
}
const ICON = {
  plus: '<path d="M12 5v14M5 12h14"/>',
  eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/>',
  more: '<circle cx="5" cy="12" r="1.3"/><circle cx="12" cy="12" r="1.3"/><circle cx="19" cy="12" r="1.3"/>',
  close: '<path d="m6 6 12 12M18 6 6 18"/>',
};
const svg = name => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON[name]}</svg>`;

// 选择、右键菜单、批量操作、交付记录、自动刷新；视图偏好与根目录下拉分别在
// file-manager-view-options.js 与 file-manager-root-menu.js。
function createFileManagerFeatures(o) {
  const { document: d, window: w, ipcRenderer: ipc, state, elements: el } = o;
  const selected = new Set();
  const entries = new Map();
  let anchor = '';
  let multi = false;
  let results = null;
  let scanVersion = 0;
  let refreshing = false;
  let refreshTimer;
  let searchTimer;
  let menu;
  let jobsOpen = false;
  let view = null;
  let viewOptions = null;
  let rootMenu = null;
  const nodes = {};
  const prefs = createPrefs(w);

  function element(tag, className, text) {
    const node = d.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }
  function button(text, title, action) {
    const node = element('button', '', text); node.type = 'button'; node.title = title;
    node.addEventListener('click', () => { Promise.resolve().then(action).catch(report); });
    return node;
  }
  function iconButton(className, icon, title, action) {
    const node = button('', title, action); node.className = className; node.innerHTML = svg(icon);
    node.setAttribute('aria-label', title); return node;
  }
  function report(error) { o.setStatus(error.message || String(error), 'error', { sticky: true }); }
  async function invoke(channel, payload) {
    const r = await ipc.invoke(`file-manager:${channel}`, payload);
    if (!r || r.ok !== true) throw new Error(r?.error || '操作没有返回成功结果');
    return r;
  }
  function matchesType(entry) { return viewOptions ? viewOptions.matchesType(entry) : true; }
  function mtimeOf(entry) {
    const value = o.folderActivity ? o.folderActivity.effectiveMtime(entry) : entry.mtimeMs;
    return Number.isFinite(value) ? value : -1;
  }
  function sortEntries(list) {
    const { sort, descending } = view;
    return [...list].sort((a, b) => {
      const dir = Number(b.type === 'directory') - Number(a.type === 'directory');
      if (dir) return dir;
      const n = sort === 'size' ? (a.size ?? -1) - (b.size ?? -1) : sort === 'mtime' ? mtimeOf(a) - mtimeOf(b) : a.name.localeCompare(b.name, undefined, { numeric: true });
      return (descending ? -1 : 1) * (n || a.name.localeCompare(b.name));
    });
  }
  async function addToConversation(paths, target) {
    if (!o.addToConversation) throw new Error('当前没有可用输入框');
    await o.addToConversation(paths, target); o.setStatus('文件路径已加入对话草稿，尚未发送', 'success');
  }
  function decorateRow(row, node, entry, options = {}) {
    entries.set(entry.path, entry);
    node.classList.toggle('selected', selected.has(entry.path));
    node.setAttribute('aria-selected', String(selected.has(entry.path)));
    node.draggable = entry.type === 'file';
    node.addEventListener('dragstart', event => {
      const paths = selected.has(entry.path) ? [...selected] : [entry.path];
      event.dataTransfer.setData('application/x-hub-files', JSON.stringify(paths));
      event.dataTransfer.setData('text/plain', paths.join('\n'));
      event.dataTransfer.effectAllowed = 'copy';
    });
    const name = node.querySelector('.fm-node-name');
    name.title = entry.path;
    if (entry.extension && entry.extension.length < entry.name.length) {
      name.replaceChildren(element('span', 'fm-name-base', entry.name.slice(0, -entry.extension.length)), element('span', 'fm-name-extension', entry.name.slice(-entry.extension.length)));
    }
    if (options.variant === 'change' || view.mode !== 'tree') {
      const folder = path.relative(state.root, path.dirname(entry.path));
      if (folder) { const relative = element('span', 'fm-relative', folder); relative.title = entry.path; name.after(relative); }
    }
    const ms = mtimeOf(entry) > 0 ? mtimeOf(entry) : null;
    if (entry.type !== 'directory' && isFresh(ms)) {
      const dot = element('span', 'fm-fresh'); dot.title = '10 分钟内修改过'; node.querySelector('.fm-node-meta').before(dot);
    }
    const detail = element('span', 'fm-file-details');
    const size = element('span', 'fm-file-size', entry.type === 'directory' ? '' : formatSize(entry.size));
    const time = element('time', 'fm-file-time', ms ? formatRelativeTime(ms) : '—');
    const activityNote = entry.type === 'directory' && o.folderActivity ? o.folderActivity.describe(entry) : '';
    time.title = [ms ? `修改时间：${formatFullTime(ms)}` : entry.metadataError || '修改时间未知',
      entry.type === 'directory' ? '' : `大小：${formatSize(entry.size)}`, activityNote].filter(Boolean).join('\n');
    if (activityNote) time.dataset.activity = activityNote;
    detail.append(size, time); node.append(detail);
    const check = element('input', 'fm-select'); check.type = 'checkbox'; check.checked = selected.has(entry.path);
    check.setAttribute('aria-label', `选择 ${entry.name}`); check.dataset.filePath = entry.path; check.tabIndex = -1;
    row.prepend(check);
    // 悬停快捷操作替换时间显示：＋对话、预览、更多。
    const quick = element('span', 'fm-row-actions');
    quick.append(iconButton('fm-quick-add', 'plus', `加入当前对话：${entry.name}`, () => addToConversation([entry.path])));
    if (entry.type === 'file' && o.isPreviewableFile(entry.name)) {
      quick.append(iconButton('fm-quick-preview', 'eye', `在 Hub 中预览：${entry.name}`, () => o.activateEntry(node)));
    }
    quick.append(iconButton('fm-more', 'more', `更多操作：${entry.name}`, () => {
      if (!selected.has(entry.path)) { selected.clear(); selected.add(entry.path); multi = false; o.renderTree(); }
      const rect = row.isConnected ? row.getBoundingClientRect() : el.tree.getBoundingClientRect();
      showMenu(rect.right - 16, rect.top, [...selected]);
    }));
    row.append(quick);
    if (view.thumbnails && TYPE_GROUPS.image.test(entry.name) && entry.size <= 5 * 1024 * 1024) {
      const image = element('img', 'fm-thumbnail'); image.loading = 'lazy'; image.src = pathToFileURL(entry.path).href; image.alt = '';
      image.addEventListener('error', () => image.remove()); node.querySelector('.fm-node-icon').replaceChildren(image);
    }
  }
  function afterRender() {
    const chosen = [...selected].map(p => entries.get(p)).filter(Boolean);
    const showBar = multi && chosen.length > 0;
    el.tree.classList.toggle('fm-multi', showBar);
    nodes.bar.hidden = !showBar;
    nodes.barText.textContent = showBar ? `已选 ${chosen.length} 项 · ${formatSize(chosen.reduce((sum, e) => sum + (e.size || 0), 0))}${chosen.some(e => e.type === 'directory') ? '（不含文件夹内容）' : ''}` : '';
    el.filter.placeholder = view.mode === 'tree' ? '筛选文件…' : view.mode === 'recent' ? '筛选最近修改的文件…' : '搜索项目内文件名或相对路径…';
    el.panel.classList.toggle('fm-wide', el.panel.getBoundingClientRect().width >= 520);
    if (!refreshTimer && o.isOpen()) refreshTimer = w.setTimeout(tick, 4000);
  }
  function renderResults() {
    if (view.mode === 'tree') return false;
    if (!results) el.tree.append(element('div', 'fm-tree-message', '正在扫描项目文件…'));
    else if (results.error) el.tree.append(element('div', 'fm-tree-message error', results.error));
    else {
      const list = sortEntries(results.entries.filter(matchesType));
      list.forEach(entry => el.tree.append(o.makeTreeRow(entry, 0)));
      if (!list.length) el.tree.append(element('div', 'fm-tree-message', '没有匹配文件'));
      o.setStatus(`${list.length} 个结果${results.truncated ? ' · 扫描达到上限，结果不完整' : ''}${results.skipped?.length ? ` · 跳过 ${results.skipped.length} 项（依赖目录、链接或无权限）` : ''}`, results.truncated ? 'warning' : '', { sticky: true });
    }
    return true;
  }
  async function scan() {
    const id = ++scanVersion; const root = state.root; const query = state.query;
    results = null; o.renderTree();
    try {
      const result = await invoke('scan', { root, query, recent: view.mode === 'recent' });
      if (id !== scanVersion || root !== state.root || !o.isOpen()) return;
      results = result;
    } catch (error) { if (id !== scanVersion) return; results = { error: error.message }; }
    if (id === scanVersion) o.renderTree();
  }
  function searchChanged() {
    if (view.mode === 'tree') return false;
    ++scanVersion;
    w.clearTimeout(searchTimer); searchTimer = w.setTimeout(() => { void scan(); }, 250); return true;
  }
  // 自动刷新发现新文件或 mtime 变化时，对应行短暂高亮一次。
  function noteChanges(previous, next) {
    if (!previous || previous.loading || previous.error) return;
    const before = new Map((previous.entries || []).map(e => [e.path, e.mtimeMs]));
    for (const entry of next.entries) {
      if (!before.has(entry.path) || before.get(entry.path) !== entry.mtimeMs) state.flash.set(entry.path, Date.now());
    }
  }
  async function refresh({ force = false } = {}) {
    if (!state.root || !o.isOpen()) return;
    // 手动刷新强制重算子树活动与本会话改动；4 秒自动刷新只补查过期或新出现的部分。
    if (force && view.mode === 'tree') {
      if (o.requestVisibleActivity) void o.requestVisibleActivity({ force: true });
      if (o.refreshSessionChanges) void o.refreshSessionChanges({ force: true });
    }
    if (refreshing) return;
    if (view.mode !== 'tree') { await scan(); return; }
    refreshing = true;
    const generation = state.generation; const root = state.root;
    const scroll = el.tree.scrollTop;
    const focusedPath = d.activeElement?.closest('[data-fm-node]')?.dataset.path;
    const focusedToggle = d.activeElement?.closest('[data-fm-group-toggle]')?.dataset.fmGroupToggle;
    try {
      const dirs = [root, ...state.expanded];
      let changed = false;
      // Refresh only directories actually displayed; preserve expansion and scroll.
      for (const directory of dirs) {
        const r = await ipc.invoke('file-manager:list-directory', { root, directory, limit: 3000 });
        if (generation !== state.generation || !o.isOpen()) return;
        const record = { loading: false, entries: r.entries || [], total: r.total || 0, truncated: !!r.truncated, error: r.ok ? '' : r.error || '读取失败' };
        const previous = state.cache.get(directory);
        if (JSON.stringify(previous) !== JSON.stringify(record)) { noteChanges(previous, record); state.cache.set(directory, record); changed = true; }
      }
      if (changed) {
        const available = new Set([...state.cache.values()].flatMap(r => (r.entries || []).map(e => e.path)));
        for (const p of selected) if (!available.has(p)) selected.delete(p);
        o.renderTree();
        if (focusedPath) [...el.tree.querySelectorAll('[data-fm-node]')].find(n => n.dataset.path === focusedPath)?.focus({ preventScroll: true });
        if (focusedToggle) [...el.tree.querySelectorAll('[data-fm-group-toggle]')].find(n => n.dataset.fmGroupToggle === focusedToggle)?.focus({ preventScroll: true });
        el.tree.scrollTop = scroll;
      }
      if (o.requestVisibleActivity) void o.requestVisibleActivity();
      if (o.refreshSessionChanges) void o.refreshSessionChanges();
    } catch (error) { report(error); }
    finally { refreshing = false; }
  }
  async function tick() {
    refreshTimer = null;
    if (!o.isOpen()) return;
    if (!menu && !d.querySelector('.fm-dialog') && !viewOptions.isOpen() && !rootMenu.isOpen()) {
      if (view.mode === 'tree') await refresh();
      if (jobsOpen) await loadJobs().catch(report);
    }
    if (o.isOpen() && !refreshTimer) refreshTimer = w.setTimeout(tick, 4000);
  }
  function rootChanging(root) {
    ++scanVersion; results = null; selected.clear(); entries.clear(); multi = false;
    if (view.mode !== 'tree') viewOptions.set({ mode: 'tree' });
    rootMenu.rootChanging(root);
    viewOptions.close();
    hideMenu();
  }
  function handleClick(event, node) {
    if (event.target.closest('.fm-row-actions')) return true;
    const checkbox = event.target.closest('.fm-select');
    const p = checkbox?.dataset.filePath || node?.dataset.path;
    if (!p) return false;
    if (checkbox || event.ctrlKey || event.metaKey || event.shiftKey) {
      event.preventDefault();
      multi = true;
      if (event.shiftKey && anchor) {
        const list = [...el.tree.querySelectorAll('[data-fm-node]')].map(e => e.dataset.path);
        const a = list.indexOf(anchor); const b = list.indexOf(p);
        if (a >= 0 && b >= 0) list.slice(Math.min(a, b), Math.max(a, b) + 1).forEach(v => selected.add(v));
        else selected.add(p);
      } else { if (selected.has(p)) selected.delete(p); else selected.add(p); anchor = p; }
      o.renderTree(); return true;
    }
    selected.clear(); selected.add(p); anchor = p; multi = false; return false;
  }
  function hideMenu() { if (menu) menu.remove(); menu = null; }
  function dialog(title, fields = [], description = '', submit = '确定') {
    return new Promise(resolve => {
      const box = element('dialog', 'fm-dialog'); const form = element('form'); form.method = 'dialog';
      form.append(element('h3', '', title));
      if (description) form.append(element('p', '', description));
      const inputs = {};
      fields.forEach(field => {
        const label = element('label', '', field.label);
        const input = element(field.options ? 'select' : 'input');
        if (field.options) field.options.forEach(item => { const option = element('option', '', item.label); option.value = item.id; input.append(option); });
        else { input.type = 'text'; input.value = field.value || ''; }
        input.name = field.key; input.required = true; inputs[field.key] = input; label.append(input); form.append(label);
      });
      const actions = element('div', 'fm-dialog-actions');
      const cancel = button('取消', '', () => box.close());
      const yes = element('button', '', submit); yes.type = 'submit'; actions.append(cancel, yes); form.append(actions); box.append(form); d.body.append(box);
      let result = null;
      form.addEventListener('submit', event => { event.preventDefault(); result = Object.fromEntries(Object.entries(inputs).map(([k, v]) => [k, v.value])); box.close(); });
      box.addEventListener('close', () => { box.remove(); resolve(result); }, { once: true });
      box.showModal(); (Object.values(inputs)[0] || yes).focus();
    });
  }
  async function action(name, paths, root) {
    const p = { root, paths };
    if (name.startsWith('copy-')) { await invoke('copy', { ...p, kind: name.slice(5) }); o.setStatus('已复制', 'success'); return; }
    if (name === 'preview') { const node = [...el.tree.querySelectorAll('[data-fm-node]')].find(n => n.dataset.path === paths[0]); if (node) await o.activateEntry(node); return; }
    if (name === 'external' || name === 'reveal') {
      const r = await ipc.invoke(name === 'external' ? 'open-path' : 'show-in-folder', paths[0]);
      if (typeof r === 'string' && r || r?.error) throw new Error(r.error || r); return;
    }
    if (name === 'conversation' || name === 'target-conversation') {
      let target;
      if (name === 'target-conversation') {
        const targets = o.listConversationTargets ? o.listConversationTargets() : [];
        if (!targets.length) throw new Error('没有可添加的已打开会话');
        const answer = await dialog('添加到指定会话', [{ key: 'target', label: '会话', options: targets }], '将绝对路径加入草稿，不自动发送。');
        if (!answer) return; target = answer.target;
      }
      await addToConversation(paths, target); return;
    }
    if (name === 'favorite') { rootMenu.toggleFavorite(paths, file => entries.get(file)?.type); o.setStatus('收藏已更新（在根目录下拉中）', 'success'); return; }
    if (name === 'properties') {
      o.setStatus('正在统计大小…', '', { sticky: true });
      const r = await invoke('operation', { ...p, action: 'properties' });
      await dialog('文件属性', [], `${paths.join('\n')}\n${r.files} 个文件 · ${formatSize(r.bytes)}${r.truncated || r.skipped.length ? '\n统计不完整：达到扫描上限或跳过链接/无权限目录' : ''}`); return;
    }
    let extra = {};
    if (name === 'rename' || name === 'mkdir') {
      const answer = await dialog(name === 'rename' ? '重命名' : '新建文件夹', [{ key: 'name', label: '名称', value: name === 'rename' ? path.basename(paths[0]) : '' }]);
      if (!answer) return; extra = answer;
    } else if (name === 'copy' || name === 'move') {
      const answer = await dialog(name === 'copy' ? '复制到' : '移动到', [{ key: 'destination', label: '目标目录（绝对路径）' }], '同名文件不覆盖。跨磁盘移动请使用复制到，再移至回收站。');
      if (!answer) return; extra = answer;
    } else if (name === 'trash') {
      if (!await dialog('移至回收站', [], paths.join('\n'), '移至回收站')) return;
    }
    const r = await ipc.invoke('file-manager:operation', { ...p, action: name, ...extra });
    await refresh();
    if (!r?.ok) throw new Error(r?.error || '操作失败');
    o.setStatus('操作完成', 'success');
  }
  function showMenu(x, y, paths) {
    hideMenu(); if (!paths.length) return;
    const root = state.root; const single = paths.length === 1; const entry = entries.get(paths[0]);
    menu = element('div', 'fm-context-menu'); menu.setAttribute('role', 'menu');
    const add = (id, label, enabled = true) => {
      const b = button(label, '', async () => { hideMenu(); await action(id, paths, root); }); b.dataset.fmAction = id; b.disabled = !enabled; b.setAttribute('role', 'menuitem'); menu.append(b);
    };
    const group = label => menu.append(element('div', 'fm-menu-group', label));
    group(single ? path.basename(paths[0]) : `已选 ${paths.length} 项`);
    add('preview', '在 Hub 中打开', single); add('external', '默认应用打开', single); add('reveal', '在资源管理器中定位', single);
    group('复制');
    add('copy-path', '复制绝对路径'); add('copy-relative', '复制相对路径'); add('copy-name', '复制文件名'); add('copy-files', '复制文件（可粘贴）');
    if (single && entry?.type === 'file') add('copy-content', '复制文本内容');
    if (single && TYPE_GROUPS.image.test(paths[0])) add('copy-image', '复制图片');
    group('对话与交付');
    add('conversation', '添加到当前对话（路径）'); add('target-conversation', '添加到指定会话…');
    group('整理');
    add('favorite', '收藏 / 取消收藏'); add('rename', '重命名…', single);
    add('mkdir', '新建文件夹…', single && entry?.type === 'directory');
    add('copy', '复制到…'); add('move', '移动到…'); add('properties', '属性 / 计算大小'); add('trash', '移至回收站…');
    d.body.append(menu); menu.style.left = `${Math.max(4, Math.min(x, w.innerWidth - menu.offsetWidth - 8))}px`;
    menu.style.top = `${Math.max(4, Math.min(y, w.innerHeight - menu.offsetHeight - 8))}px`;
    menu.querySelector('button:not(:disabled)')?.focus();
    menu.addEventListener('keydown', event => {
      if (event.key === 'Escape') { hideMenu(); return; }
      if (['ArrowDown', 'ArrowUp'].includes(event.key)) {
        event.preventDefault(); const list = [...menu.querySelectorAll('button:not(:disabled)')]; const index = list.indexOf(d.activeElement);
        list[(index + (event.key === 'ArrowDown' ? 1 : list.length - 1)) % list.length]?.focus();
      }
    });
  }
  function setJobsOpen(open) { jobsOpen = open; nodes.jobs.hidden = !open; }
  async function loadJobs() {
    const result = await invoke('jobs'); nodes.jobs.replaceChildren(element('strong', '', '交付记录'));
    const labels = { queued: '等待中', running: '处理中', completed: '已同步并验证', prepared: '附件已准备，请在 ChatGPT 窗口发送', failed: '失败', unknown: '结果待核实，请勿重复发送', cancelled: '已取消', resolved: '已由用户核实处理' };
    if (!result.jobs.length) nodes.jobs.append(element('p', '', '暂无交付记录'));
    for (const job of result.jobs) {
      const row = element('div', 'fm-job'); row.dataset.state = job.state;
      row.append(element('div', '', `${job.target === 'company' ? '公司' : 'ChatGPT'} · ${labels[job.state] || job.state}`), element('small', '', (job.paths || []).map(p => path.basename(p)).join('、')));
      if (job.error) row.append(element('p', 'fm-job-error', typeof job.error === 'string' ? job.error : JSON.stringify(job.error)));
      if (job.result?.skipped?.length) row.append(element('p', '', `已跳过：${job.result.skipped.map(x => typeof x === 'string' ? x : JSON.stringify(x)).join('、')}`));
      if (job.state === 'queued') row.append(button('取消', '', async () => { await invoke('cancel-transfer', { id: job.id }); await loadJobs(); }));
      if (job.state === 'failed') row.append(button('重试…', '', () => action(job.target, job.paths, job.root)));
      if (['unknown', 'prepared', 'completed'].includes(job.state)) row.append(button('已在目标端核实…', '', async () => {
        if (!await dialog('确认已核实', [], '请先检查目标端：附件是否已发送、文件是否已收到或残留草稿是否已处理。确认后解除本条记录的重复提交拦截，不会自动重发。', '已核实')) return;
        await invoke('resolve-transfer', { id: job.id }); await loadJobs();
      }));
      for (const [key, label] of [['direct_url', '下载文件'], ['inbox_url', '公司收件箱']]) {
        if (/^https?:\/\//.test(job.result?.[key] || '')) row.append(button(label, job.result[key], async () => { const r = await ipc.invoke('open-external-url', job.result[key]); if (!r?.success) throw new Error('打开链接失败'); }));
      }
      if (job.result?.direct_url) row.append(button('复制下载链接', '', () => { require('electron').clipboard.writeText(job.result.direct_url); }));
      nodes.jobs.append(row);
    }
  }
  // 焦点行优先：方向键只移焦点不改选中，沿用旧选中会把别的文件加进草稿。
  // 焦点行本身在多选集合里时，才按整组多选处理。
  function focusedPaths() {
    const focused = d.activeElement?.closest('[data-fm-node]')?.dataset.path;
    if (focused) return selected.size > 1 && selected.has(focused) ? [...selected] : [focused];
    return [...selected];
  }
  function init() {
    viewOptions = createViewOptions({
      document: d, window: w, anchor: el.viewMenu, prefs, report,
      onChange: async (next, before) => {
        if (next.mode !== before.mode) {
          selected.clear(); multi = false;
          if (next.mode !== 'tree') await scan(); else o.renderTree();
          return;
        }
        o.renderTree();
      },
    });
    view = viewOptions.view;
    rootMenu = createRootMenu({
      document: d, window: w, anchor: el.rootButton, prefs, report, ipcRenderer: ipc,
      getRoot: () => state.root,
      rootEntries: () => state.cache.get(state.root)?.entries,
      setRoot: o.setRoot,
      newFolder: () => action('mkdir', [state.root], state.root),
      jobsOpen: () => jobsOpen,
      toggleJobs: async () => { setJobsOpen(!jobsOpen); if (jobsOpen) await loadJobs(); },
      openExternal: o.openRootExternal,
    });
    const saved = prefs.load();
    if (saved.width && /^\d+px$/.test(saved.width)) { el.panel.style.width = saved.width; el.panel.style.flexBasis = saved.width; }

    // 批量操作条：只在多选时出现。
    nodes.bar = element('div', 'fm-selection-bar'); nodes.bar.hidden = true; nodes.bar.setAttribute('role', 'toolbar'); nodes.bar.setAttribute('aria-label', '批量操作');
    nodes.barText = element('span', 'fm-selection-text');
    const addAll = button('加入对话', '把选中文件的路径加入当前对话草稿（不发送）', () => action('conversation', [...selected], state.root)); addAll.className = 'fm-bar-primary'; addAll.dataset.fmBar = 'conversation';
    const more = button('操作 ▾', '批量操作', () => { const rect = more.getBoundingClientRect(); showMenu(rect.left, rect.top - 8, [...selected]); }); more.dataset.fmBar = 'menu';
    const clear = iconButton('fm-bar-clear', 'close', '取消选择', () => { selected.clear(); multi = false; o.renderTree(); });
    nodes.bar.append(nodes.barText, addAll, more, clear);
    el.tree.after(nodes.bar);
    el.tree.setAttribute('aria-multiselectable', 'true');
    nodes.jobs = element('div', 'fm-jobs'); nodes.jobs.hidden = true; nodes.bar.after(nodes.jobs);
    if (w.ResizeObserver) new w.ResizeObserver(() => el.panel.classList.toggle('fm-wide', el.panel.getBoundingClientRect().width >= 520)).observe(el.panel);
    el.tree.addEventListener('contextmenu', event => {
      const node = event.target.closest('[data-fm-node]'); if (!node) return;
      event.preventDefault(); event.stopPropagation();
      if (!selected.has(node.dataset.path)) { selected.clear(); selected.add(node.dataset.path); multi = false; o.renderTree(); }
      showMenu(event.clientX, event.clientY, [...selected]);
    });
    d.addEventListener('pointerdown', event => { if (menu && !menu.contains(event.target)) hideMenu(); });
    el.panel.addEventListener('keydown', event => {
      if (event.target.matches('input,select,textarea')) return;
      const ctrl = event.ctrlKey || event.metaKey;
      if (ctrl && event.key.toLowerCase() === 'a') { event.preventDefault(); event.stopPropagation(); el.tree.querySelectorAll('[data-fm-node]').forEach(n => selected.add(n.dataset.path)); multi = true; o.renderTree(); }
      if (ctrl && event.key.toLowerCase() === 'c' && selected.size) { event.preventDefault(); event.stopPropagation(); void action('copy-files', [...selected], state.root).catch(report); }
      // Ctrl+Enter：选中行（或焦点行）加入当前对话草稿，不发送。
      if (ctrl && event.key === 'Enter') {
        const paths = focusedPaths();
        if (paths.length) { event.preventDefault(); event.stopPropagation(); void addToConversation(paths).catch(report); }
      }
      if (event.key === 'F2' && selected.size === 1) { event.preventDefault(); void action('rename', [...selected], state.root).catch(report); }
    });
    const resize = element('div', 'fm-resize-handle'); resize.setAttribute('role', 'separator'); resize.setAttribute('aria-label', '调整文件面板宽度'); el.panel.prepend(resize);
    resize.addEventListener('pointerdown', event => {
      event.preventDefault(); resize.setPointerCapture(event.pointerId);
      const start = event.clientX; const width = el.panel.getBoundingClientRect().width;
      const move = e => { const value = Math.max(292, Math.min(w.innerWidth - 40, 900, width + start - e.clientX)); el.panel.style.width = `${value}px`; el.panel.style.flexBasis = `${value}px`; el.panel.classList.toggle('fm-wide', value >= 520); };
      const end = () => {
        resize.removeEventListener('pointermove', move);
        try { prefs.save({ width: el.panel.style.width }); } catch (error) { report(new Error(`偏好未保存：${error.message}`)); }
        o.onLayoutChange();
      };
      resize.addEventListener('pointermove', move); resize.addEventListener('pointerup', end, { once: true });
    });
  }
  function close() { hideMenu(); viewOptions?.close(); rootMenu?.close(); ++scanVersion; w.clearTimeout(refreshTimer); w.clearTimeout(searchTimer); refreshTimer = null; }
  return {
    init, close, rootChanging, refresh, decorateRow, sortEntries, matchesType, afterRender, renderResults, searchChanged, handleClick,
    sortLabel: () => viewOptions.sortLabel(),
    toggleSortDirection: () => viewOptions.set({ descending: !view.descending }),
    mode: () => view.mode,
  };
}

module.exports = { createFileManagerFeatures, formatSize };
