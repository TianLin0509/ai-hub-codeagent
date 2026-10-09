'use strict';
/**
 * 项目库：Hub 见过的目录里，哪些已经被 project-prep skill 整理成「可开并行群聊」的项目。
 *
 * 判据只有两条，和 renderer/dev-workspace-guard.js 的放行条件一致：
 *   1. `.git` 是**目录**（主工作树）。linked worktree 的 `.git` 是一个文件，
 *      那是 agent 干活用的临时目录，不是项目根 —— 列进去只会让「AI HUB」出现十几个重名项。
 *   2. `.agents/project.json` 存在且能解析。中文名取它的 `name` 字段，没有就用目录名。
 *
 * 活跃时间取三路最大值：Hub 注册表 / 会话 / 会议记的 lastUsedAt、`.git` 里几个随操作
 * 更新的文件 mtime。后者让「在别的终端 commit 过」的项目也能排到前面。
 *
 * 【同级目录扫描】候选目录原本只有「Hub 已经见过的路径」（注册表 / 会话 cwd / 会议
 * workspace），于是刚被 project-prep 整理好的项目**第一次一定看不见** —— 必须先在它上面
 * 开一次会话把它登记进注册表，下次才出现在项目库里。用户的原话是「现在第一次识别不到，
 * 只有用过一次后才能识别到」。
 * 所以再补一路候选：把已知候选的**父目录**各读一层，父目录下的子目录也当候选。
 * 项目基本都是兄弟关系（同一个 code 根下并排放），这一路就能在「从没用过」时命中。
 * 严格只读一层、不递归、父目录数和每层条目数都封顶，避免变成全盘搜索。
 */
const fs = require('fs');
const path = require('path');

const GIT_ACTIVITY_FILES = ['index', 'HEAD', 'ORIG_HEAD', 'FETCH_HEAD', path.join('logs', 'HEAD'), 'packed-refs'];

// 同级扫描的封顶值：最多读这么多个父目录、每个父目录最多看这么多条子目录。
// 封顶不是性能优化，是**语义边界** —— 项目库宁可漏掉一个偏僻位置的项目，
// 也不能因为某个候选恰好落在一个上万条目的目录里就把建群弹窗卡住。
const SIBLING_SCAN_MAX_PARENTS = 24;
const SIBLING_SCAN_MAX_ENTRIES = 400;

function normalizeKey(p) {
  return String(p || '').replace(/[\\/]+$/, '').toLowerCase();
}

function _mtime(_fs, p) {
  try { return Number(_fs.statSync(p).mtimeMs) || 0; } catch (e) { return 0; }
}

/**
 * @param {string} dir
 * @returns {{name: string, trunk: string, gitActiveAt: number}|null} null = 不是整理过的项目根
 */
function inspectPreparedProject(dir, deps = {}) {
  const _fs = deps.fs || fs;
  const _path = deps.path || path;
  if (!dir || typeof dir !== 'string') return null;
  let gitStat = null;
  try { gitStat = _fs.statSync(_path.join(dir, '.git')); } catch (e) { return null; }
  if (!gitStat.isDirectory()) return null;
  let cfg = null;
  try {
    cfg = JSON.parse(_fs.readFileSync(_path.join(dir, '.agents', 'project.json'), 'utf-8'));
  } catch (e) {
    return null;
  }
  if (!cfg || typeof cfg !== 'object') return null;
  const name = typeof cfg.name === 'string' && cfg.name.trim() ? cfg.name.trim() : _path.basename(dir);
  const trunk = typeof cfg.trunk === 'string' && cfg.trunk.trim() ? cfg.trunk.trim() : '';
  const gitActiveAt = GIT_ACTIVITY_FILES.reduce(
    (max, rel) => Math.max(max, _mtime(_fs, _path.join(dir, '.git', rel))), 0);
  return { name, trunk, gitActiveAt };
}

/**
 * 把已知候选的父目录各读一层，子目录补进候选表（activeAt 记 0，排序自然靠后）。
 * 只改传进来的 Map，不做任何 `.git` / `.agents` 判断 —— 那一步交给后面统一的 inspect。
 * @param {Map<string, {path: string, activeAt: number}>} byKey 已去重的候选表，就地补充
 */
function addSiblingCandidates(byKey, deps = {}) {
  const _fs = deps.fs || fs;
  const _path = deps.path || path;
  // 父目录按候选活跃度降序取，封顶时留下的是用户最近真在用的那几个根。
  const ordered = Array.from(byKey.values()).sort((a, b) => b.activeAt - a.activeAt);
  const parents = new Map();
  for (const entry of ordered) {
    let parent;
    try { parent = _path.dirname(entry.path); } catch (e) { continue; }
    if (!parent || normalizeKey(parent) === normalizeKey(entry.path)) continue;  // 盘符根：dirname 等于自身
    const key = normalizeKey(parent);
    if (parents.has(key)) continue;
    parents.set(key, parent);
    if (parents.size >= SIBLING_SCAN_MAX_PARENTS) break;
  }
  for (const parent of parents.values()) {
    let entries = [];
    try { entries = _fs.readdirSync(parent, { withFileTypes: true }); } catch (e) { continue; }
    let seen = 0;
    for (const entry of entries) {
      if (seen >= SIBLING_SCAN_MAX_ENTRIES) break;
      if (!entry || typeof entry.isDirectory !== 'function' || !entry.isDirectory()) continue;
      seen++;
      const name = String(entry.name || '');
      // 和主进程扫工作根用的是同一条过滤：点开头是隐藏目录，下划线开头是 Hub 自己的
      // `_scratch` 这类容器，两者都不会是项目根。
      if (!name || name.startsWith('.') || name.startsWith('_')) continue;
      const child = _path.join(parent, name);
      const key = normalizeKey(child);
      if (byKey.has(key)) continue;
      byKey.set(key, { path: child, activeAt: 0 });
    }
  }
  return byKey;
}

/**
 * @param {Array<{path: string, activeAt?: number}>} candidates 候选目录（可重复，可含非项目）
 * @param {object} deps 可注入 fs / path，供单测用
 * @param {{siblingScan?: boolean}} opts siblingScan=true 时把候选父目录各读一层再判定
 * @returns {Array<{name: string, path: string, trunk: string, activeAt: number}>} 按活跃时间降序
 */
function listPreparedProjects(candidates, deps = {}, opts = {}) {
  const _path = deps.path || path;
  const byKey = new Map();
  for (const c of Array.isArray(candidates) ? candidates : []) {
    const raw = c && typeof c.path === 'string' ? c.path.trim() : '';
    if (!raw) continue;
    const resolved = _path.resolve(raw);
    const key = normalizeKey(resolved);
    const at = Number(c.activeAt) || 0;
    const prev = byKey.get(key);
    if (prev) prev.activeAt = Math.max(prev.activeAt, at);
    else byKey.set(key, { path: resolved, activeAt: at });
  }
  if (opts && opts.siblingScan) addSiblingCandidates(byKey, deps);
  const out = [];
  for (const entry of byKey.values()) {
    const info = inspectPreparedProject(entry.path, deps);
    if (!info) continue;
    const search = opts.searchRoots
      ? require('./session-search-projects').readProjectSearchRoots(entry.path, deps) : null;
    out.push({
      name: info.name,
      path: entry.path,
      trunk: info.trunk,
      activeAt: Math.max(entry.activeAt, info.gitActiveAt),
      ...(search ? { searchRoots: search.roots, searchWarnings: search.warnings } : {}),
    });
  }
  out.sort((a, b) => (b.activeAt - a.activeAt) || a.name.localeCompare(b.name, 'zh-Hans-CN'));
  return out;
}

module.exports = { listPreparedProjects, inspectPreparedProject, addSiblingCandidates, normalizeKey };
