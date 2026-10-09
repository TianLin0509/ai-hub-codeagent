'use strict';

// 「本会话改动」：当前会话启动后，工作区里修改过的文件（按 mtime 降序）。
// 复用 main 侧有界的 recent 扫描（跳过依赖目录与链接），不依赖 git，所有 CLI 通用。
// 扫描较重，自动刷新时按节流间隔补查；手动刷新立即重查。

const DEFAULT_INTERVAL_MS = 15000;
const MAX_CHANGES = 200;

function selectSessionChanges(entries, sinceMs, limit = MAX_CHANGES) {
  if (!Number.isFinite(sinceMs) || sinceMs <= 0) return [];
  return (entries || [])
    .filter(entry => entry && entry.type !== 'directory' && Number.isFinite(entry.mtimeMs) && entry.mtimeMs >= sinceMs)
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, limit);
}

function fingerprint(value) {
  if (!value) return '';
  return JSON.stringify([value.since, value.error || '', value.truncated, (value.entries || []).map(e => [e.path, e.mtimeMs, e.size])]);
}

function createSessionChangesTracker(options = {}) {
  const ipcRenderer = options.ipcRenderer;
  const getRoot = options.getRoot || (() => '');
  const getSince = options.getSince || (() => 0);
  const onUpdate = options.onUpdate || (() => {});
  const intervalMs = Number.isFinite(options.intervalMs) ? options.intervalMs : DEFAULT_INTERVAL_MS;
  const now = options.now || Date.now;
  let result = null;
  let lastAt = 0;
  let inflight = null;
  let version = 0;

  async function refresh({ force = false } = {}) {
    const root = getRoot();
    const since = getSince();
    if (!root || !(since > 0) || !ipcRenderer) { if (result) { result = null; onUpdate(); } return; }
    if (inflight) return inflight;
    if (!force && result && now() - lastAt < intervalMs) return;
    const run = version;
    inflight = (async () => {
      let response;
      try { response = await ipcRenderer.invoke('file-manager:scan', { root, query: '', recent: true, since, limit: MAX_CHANGES }); }
      catch (error) { response = { ok: false, error: String(error && error.message || error) }; }
      if (run !== version) return;
      lastAt = now();
      const next = response && response.ok
        ? { since, entries: selectSessionChanges(response.entries, since), truncated: !!response.truncated }
        : { since, entries: [], error: response && response.error || '扫描失败' };
      // 结果没变就不重绘：每次重绘都会打断悬停、菜单和键盘焦点。
      const changed = fingerprint(result) !== fingerprint(next);
      result = next;
      if (changed) onUpdate();
    })().finally(() => { if (run === version) inflight = null; });
    return inflight;
  }

  function clear() {
    version += 1;
    result = null;
    lastAt = 0;
    inflight = null;
  }

  return { clear, get: () => result, refresh };
}

module.exports = { DEFAULT_INTERVAL_MS, MAX_CHANGES, createSessionChangesTracker, selectSessionChanges };
