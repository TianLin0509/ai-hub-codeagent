'use strict';

const { projectPathKey, projectForCwd } = require('../core/session-search-projects');

function createSidebarProjectFilter({ document: doc, storage, ipcRenderer, onChange }) {
  const control = doc.getElementById?.('session-project-filter');
  if (!control) return { matches: () => true, reveal() {}, refresh() {} };
  const note = doc.getElementById('session-project-filter-note');
  let selected = 'all', projects = [], loaded = false, pending = null;
  try { selected = storage.getItem('hubSidebarProjectFilter') || 'all'; }
  catch (error) { console.warn('[sidebar] project preference could not be read:', error.message); }
  function save() {
    try { storage.setItem('hubSidebarProjectFilter', selected); }
    catch (error) { console.warn('[sidebar] project preference could not be saved:', error.message); }
  }
  function renderOptions() {
    const entries = [['random', '随机', '不属于任何项目库项目的会话和群聊'], ['all', '项目', '所有项目和随机会话']];
    for (const project of projects) {
      const duplicate = projects.some(other => other !== project && other.name === project.name);
      entries.push([projectPathKey(project.path), duplicate ? `${project.name} · ${project.path}` : project.name, project.path]);
    }
    // A removed/unavailable project must not silently turn into “all”.
    if (!entries.some(([value]) => value === selected)) entries.push([selected, '项目暂不可用', selected]);
    control.replaceChildren();
    for (const [value, label, title] of entries) {
      const option = doc.createElement('option');
      option.value = value; option.textContent = label; option.title = title;
      if (label === '项目暂不可用') option.disabled = true;
      control.appendChild(option);
    }
    control.value = selected;
    control.title = entries.find(([value]) => value === selected)?.[2] || '按项目路径筛选';
  }
  function matches(item) {
    if (selected === 'all') return true;
    // Without a library, ownership is unknown, not “random”.
    if (!loaded) return false;
    const owner = projectForCwd(projects, item._isMeeting ? item._meeting?.workspace : item.cwd);
    return selected === 'random' ? !owner : !!owner && projectPathKey(owner.path) === selected;
  }
  function refresh() {
    if (pending) return pending;
    control.setAttribute('aria-busy', 'true');
    pending = (async () => {
      try {
        const response = await ipcRenderer.invoke('workspace:prepared-projects', { searchRoots: true });
        if (!Array.isArray(response?.items)) throw new Error('项目库返回格式无效');
        projects = response.items.filter(item => item && projectPathKey(item.path) && typeof item.name === 'string');
        loaded = true;
        if (note) { note.hidden = true; note.textContent = ''; }
      } catch (error) {
        projects = []; loaded = false;
        const message = `项目库读取失败${loaded ? '，暂用上次名单' : '，无法判断项目归属'}；重新点击项目筛选可重试。`;
        if (note) { note.textContent = message; note.hidden = false; }
        console.warn('[sidebar] project library:', error.message);
      } finally {
        renderOptions();
        control.removeAttribute('aria-busy');
        pending = null;
        onChange();
      }
    })();
    return pending;
  }
  renderOptions();
  control.addEventListener('focus', refresh);
  control.addEventListener('change', () => {
    selected = control.value;
    save(); renderOptions(); onChange();
  });
  return { matches, refresh, reveal(item) {
    if (!matches(item)) { selected = 'all'; save(); renderOptions(); }
  } };
}

module.exports = { createSidebarProjectFilter };
