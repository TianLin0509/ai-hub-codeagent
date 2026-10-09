'use strict';
// 公司电脑（装了 CodeAgent CLI）上，新建会话与 AI 群聊默认用 CodeAgent，并把它排在会话类型第一位；
// 同时记住用户上次选的会话类型（2026-10-08 用户在公司真机验收后提出）。没装 CodeAgent 的电脑行为不变。
const LAST_KIND_KEY = 'hub:lastSessionKind';
let installed = null;
let pending = null;

function refresh(ipcRenderer) {
  if (!pending) {
    pending = Promise.resolve()
      .then(() => ipcRenderer.invoke('codeagent:available'))
      .then(result => { installed = !!(result && result.installed); return installed; })
      .catch(() => { installed = false; return false; });
  }
  return pending;
}

function isInstalled() { return installed === true; }

function rememberKind(kind) {
  try { if (kind) localStorage.setItem(LAST_KIND_KEY, String(kind)); } catch {}
}

// 上次选过且仍可用的类型优先；没有记录时，装了 CodeAgent 就默认它，否则沿用 Claude。
function preferredKind(validKinds = []) {
  let last = null;
  try { last = localStorage.getItem(LAST_KIND_KEY); } catch {}
  if (last && validKinds.includes(last)) return last;
  return isInstalled() && validKinds.includes('codeagent') ? 'codeagent' : 'claude';
}

function defaultGroupMembers(fallback) {
  if (!isInstalled()) return fallback.map(x => ({ ...x }));
  return [{ kind: 'codeagent', model: 'GLM-5.2-WX-Auto' }, { kind: 'codeagent', model: 'MiniMax-M2.7' }];
}

module.exports = { LAST_KIND_KEY, refresh, isInstalled, rememberKind, preferredKind, defaultGroupMembers };
