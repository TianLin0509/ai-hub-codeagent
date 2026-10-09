'use strict';

// 文件管理的视图偏好（浏览范围、排序、类型、隐藏项、缩略图）与「筛选」弹出菜单。
// 偏好与收藏、面板宽度共用一个 localStorage 键，各模块只读写自己的字段。

const { createPopover, menuButton, menuSection } = require('./file-manager-popover');

const STORAGE_KEY = 'hub-file-manager-v2';
const MODES = [['tree', '目录树'], ['recent', '最近修改'], ['search', '项目搜索']];
const SORTS = [['name', '名称'], ['mtime', '修改时间'], ['size', '大小']];
const TYPES = [['all', '全部'], ['image', '图片'], ['document', '文档'], ['slide', '演示'], ['code', '代码']];
const TYPE_GROUPS = {
  image: /\.(png|jpe?g|gif|webp|bmp|svg)$/i,
  document: /\.(md|txt|pdf|docx?|xlsx?|csv)$/i,
  slide: /\.(pptx?|odp)$/i,
  code: /\.(js|ts|jsx|tsx|py|go|rs|json|html|css|ps1|ya?ml|cpp|h)$/i,
};
const SORT_LABELS = Object.fromEntries(SORTS);

function createPrefs(w) {
  function load() {
    try { return JSON.parse(w.localStorage.getItem(STORAGE_KEY) || '{}') || {}; }
    catch (_) { return {}; }
  }
  function save(patch) {
    const next = { ...load(), ...patch };
    w.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  }
  return { load, save };
}

function createViewOptions({ document: d, window: w, anchor, prefs, onChange, report }) {
  // 默认按修改时间降序。旧版每次存任何偏好都会连带写入 sort:'name'，分不清是不是用户选的，
  // 所以只沿用新版里用户亲手选过（sortChosen）的排序。
  const view = { mode: 'tree', sort: 'mtime', descending: true, type: 'all', showHidden: true, thumbnails: false };
  const saved = prefs.load();
  let sortChosen = saved.sortChosen === true && !!SORT_LABELS[saved.sort];
  if (sortChosen) { view.sort = saved.sort; view.descending = !!saved.descending; }
  if (saved.type === 'all' || TYPE_GROUPS[saved.type]) view.type = saved.type;
  view.showHidden = saved.showHidden !== false;
  view.thumbnails = !!saved.thumbnails;

  function persist() {
    try { prefs.save({ sort: view.sort, descending: view.descending, sortChosen, type: view.type, showHidden: view.showHidden, thumbnails: view.thumbnails }); }
    catch (error) { report(new Error(`偏好未保存：${error.message}`)); }
  }
  function set(patch) {
    const before = { ...view };
    if ('sort' in patch || 'descending' in patch) sortChosen = true;
    Object.assign(view, patch);
    if (patch.mode === 'recent') { view.sort = 'mtime'; view.descending = true; }
    persist();
    syncAnchor();
    if (popover.isOpen()) popover.render();
    onChange(view, before);
  }
  function setSort(sort) {
    // 再点当前排序键切换方向；换键时名称默认升序，其余默认降序。
    if (view.sort === sort) set({ descending: !view.descending });
    else set({ sort, descending: sort !== 'name' });
  }
  function matchesType(entry) {
    return (view.showHidden || !entry.hidden)
      && (entry.type === 'directory' || view.type === 'all' || !!TYPE_GROUPS[view.type]?.test(entry.name));
  }
  function sortLabel() {
    return `${SORT_LABELS[view.sort]} ${view.descending ? '↓' : '↑'}`;
  }
  // 非默认视图时给筛选图标一个小圆点，避免「东西藏进菜单后忘了自己筛过」。
  function syncAnchor() {
    const filtered = view.mode !== 'tree' || view.type !== 'all' || !view.showHidden;
    anchor.classList.toggle('has-filter', filtered);
  }

  const popover = createPopover({
    document: d, window: w, anchor, className: 'fm-popover-end fm-view-menu', label: '浏览范围、排序与筛选',
    build(box) {
      const segmented = (title, key, items, isOn, pick) => {
        const section = menuSection(d, box, title);
        const row = d.createElement('div'); row.className = 'fm-segmented'; section.append(row);
        for (const [id, text] of items) {
          menuButton(d, row, text, () => pick(id), {
            className: 'fm-segment', role: 'menuitemradio', checked: isOn(id), data: { fmOption: key, value: id },
          });
        }
        return row;
      };
      segmented('浏览范围', 'mode', MODES, id => view.mode === id, id => set({ mode: id }));
      const sortRow = segmented('排序', 'sort', SORTS, id => view.sort === id, setSort);
      menuButton(d, sortRow, view.descending ? '↓ 降序' : '↑ 升序', () => set({ descending: !view.descending }), {
        className: 'fm-segment fm-direction', title: '切换升序 / 降序', data: { fmOption: 'direction' },
      });
      segmented('类型', 'type', TYPES, id => view.type === id, id => set({ type: id }));
      const show = menuSection(d, box, '显示');
      menuButton(d, show, '隐藏项（点开头）', () => set({ showHidden: !view.showHidden }), {
        className: 'fm-popover-item fm-switch', role: 'menuitemcheckbox', checked: view.showHidden, data: { fmOption: 'showHidden' },
      });
      menuButton(d, show, '图片缩略图', () => set({ thumbnails: !view.thumbnails }), {
        className: 'fm-popover-item fm-switch', role: 'menuitemcheckbox', checked: view.thumbnails, data: { fmOption: 'thumbnails' },
      });
    },
  });
  anchor.addEventListener('click', () => popover.toggle());
  syncAnchor();

  return { view, set, setSort, matchesType, sortLabel, close: () => popover.close(), isOpen: () => popover.isOpen() };
}

module.exports = { STORAGE_KEY, TYPE_GROUPS, createPrefs, createViewOptions };
