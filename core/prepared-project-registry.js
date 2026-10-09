'use strict';
// Formal project identity lives outside the checkout. Discovery is never enrollment.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { getHubDataDir } = require('./data-dir');
const { acquireLock, releaseLock } = require('./file-lock');
const { inspectPreparedProject, listPreparedProjects } = require('./prepared-project-library');
const { readProjectSearchRoots } = require('./session-search-projects');
const hash = text => crypto.createHash('sha256').update(text).digest('hex');
const key = p => path.resolve(p).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
const empty = () => ({ schemaVersion: 1, projects: [], migrations: [] });

function canonical(dir) {
  if (typeof dir !== 'string' || !path.isAbsolute(dir)) throw new Error('项目目录必须是绝对路径');
  return fs.realpathSync.native(dir);
}
function prepared(dir) {
  const resolved = canonical(dir);
  const info = inspectPreparedProject(resolved);
  if (!info) throw new Error(`项目不可用或未完成 project-prep（需要主目录及有效 .agents/project.json）：${dir}`);
  const raw = fs.readFileSync(path.join(resolved, '.agents/project.json'), 'utf8');
  const config = JSON.parse(raw);
  if (Array.isArray(config) || typeof config.name !== 'string' || !config.name.trim()) {
    throw new Error(`项目配置缺少有效 name：${dir}`);
  }
  return { path: resolved, ...info, configHash: hash(raw) };
}
function validateRegistry(data) {
  if (!data || data.schemaVersion !== 1 || !Array.isArray(data.projects) || !Array.isArray(data.migrations)) {
    throw new Error('正式项目登记库格式无效');
  }
  const ids = new Set(), paths = new Set();
  for (const item of data.projects) {
    if (!item || typeof item.id !== 'string' || !item.id || typeof item.path !== 'string'
        || !path.isAbsolute(item.path) || typeof item.name !== 'string' || !item.name.trim()
        || item.source !== 'project-prep' || ids.has(item.id) || paths.has(key(item.path))) {
      throw new Error('正式项目登记记录无效或重复');
    }
    ids.add(item.id); paths.add(key(item.path));
  }
  return data;
}
class PreparedProjectRegistry {
  constructor({ dataDir = getHubDataDir() } = {}) {
    this.file = path.join(path.resolve(dataDir), 'prepared-projects.json');
  }
  read({ allowMissing = false } = {}) {
    try { return validateRegistry(JSON.parse(fs.readFileSync(this.file, 'utf8'))); }
    catch (error) {
      if (error.code === 'ENOENT' && allowMissing) return empty();
      throw new Error(`正式项目库读取失败：${error.code === 'ENOENT' ? '尚未登记，请完成 project-prep 登记或旧项目迁移' : error.message}`);
    }
  }
  // allowMissing 只放行「这台机器还没登记过任何项目」这一种情况（ENOENT）：全新
  // 用户首次打开 Hub 时本就没有 prepared-projects.json，四处 UI（侧栏项目筛选、
  // 全局搜索、群聊创建弹窗、工作区面板）同时弹红字，是把正常初始状态当成故障。
  // 库存在但内容损坏 / 指向已改 仍然照常抛错 —— 那才是真的需要看见的失败。
  list({ searchRoots = false, candidates = [], allowMissing = false } = {}) {
    const registry = this.read({ allowMissing });
    const seen = new Set();
    const items = registry.projects.map(entry => {
      const info = prepared(entry.path); // Fail visibly; do not substitute a clone or an empty list.
      if (key(info.path) !== key(entry.path) || seen.has(key(info.path))) throw new Error(`正式项目路径已改指向或重复：${entry.path}`);
      seen.add(key(info.path));
      const activeAt = candidates.reduce((max, c) => key(c.path) === key(entry.path) ? Math.max(max, Number(c.activeAt) || 0) : max, info.gitActiveAt);
      const search = searchRoots ? readProjectSearchRoots(info.path) : null;
      return { id: entry.id, name: info.name, path: info.path, trunk: info.trunk, activeAt,
        ...(search ? { searchRoots: search.roots, searchWarnings: search.warnings } : {}) };
    });
    items.sort((a, b) => b.activeAt - a.activeAt || a.name.localeCompare(b.name, 'zh-Hans-CN'));
    return { items, schemaVersion: 1 };
  }
  mutate(fn) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const lockPath = `${this.file}.lock`;
    // Never steal a live/slow writer's lock on elapsed time alone.
    const lock = acquireLock(lockPath, { retries: 300, retryDelayMs: 10, staleMs: Infinity });
    if (lock == null) throw new Error(`正式项目登记库正忙或不可写，请重试：${lockPath}`);
    try {
      const data = this.read({ allowMissing: true });
      const before = JSON.stringify(data);
      const result = fn(data);
      validateRegistry(data);
      if (JSON.stringify(data) === before && fs.existsSync(this.file)) return { ...result, changed: false };
      const suffix = `${Date.now()}-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
      let backup = null;
      if (fs.existsSync(this.file)) {
        backup = `${this.file}.backup-${suffix}`;
        fs.copyFileSync(this.file, backup, fs.constants.COPYFILE_EXCL);
      }
      const tmp = `${this.file}.tmp-${suffix}`;
      try {
        fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' });
        fs.renameSync(tmp, this.file);
      } catch (error) {
        if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
        throw error;
      }
      return { ...result, changed: true, backup, registry: this.file };
    } finally { releaseLock(lock, lockPath); }
  }
  enroll(data, info, reason) {
    const found = data.projects.find(p => key(p.path) === key(info.path));
    if (found) return found;
    const item = { id: crypto.randomUUID(), name: info.name, path: info.path, source: 'project-prep',
      registeredAt: Date.now(), reason };
    data.projects.push(item);
    return item;
  }
  register(dir) {
    return this.mutate(data => ({ project: this.enroll(data, prepared(dir), 'project-prep 完成后显式登记') }));
  }
  preview(plan) {
    if (!plan || plan.schemaVersion !== 1 || typeof plan.id !== 'string' || !plan.id || !Array.isArray(plan.entries)) {
      throw new Error('迁移计划格式无效');
    }
    const seen = new Set();
    return plan.entries.map(entry => {
      if (!entry || typeof entry.path !== 'string' || !path.isAbsolute(entry.path)
          || !['retain', 'exclude', 'pending'].includes(entry.decision) || typeof entry.reason !== 'string' || !entry.reason.trim()
          || seen.has(key(entry.path))) throw new Error('迁移项需要唯一绝对路径、决定和证据理由');
      seen.add(key(entry.path));
      if (entry.decision !== 'retain') return { ...entry };
      const info = prepared(entry.path);
      if (!entry.configHash || entry.configHash !== info.configHash) throw new Error(`迁移配置已变化或未绑定摘要：${entry.path}`);
      return { ...entry, path: info.path, name: info.name };
    });
  }
  migrate(plan) {
    return this.mutate(data => {
      const entries = this.preview(plan), digest = hash(JSON.stringify(plan));
      const previous = data.migrations.find(m => m.id === plan.id);
      if (previous && previous.digest !== digest) throw new Error('同名迁移计划内容已变化');
      if (previous) return { migration: previous, entries };
      for (const entry of entries.filter(e => e.decision === 'retain')) this.enroll(data, prepared(entry.path), entry.reason);
      const migration = { id: plan.id, digest, appliedAt: Date.now(), entries };
      data.migrations.push(migration);
      return { migration, entries };
    });
  }
  restore(backup, expectedHash) {
    const restored = validateRegistry(JSON.parse(fs.readFileSync(backup, 'utf8')));
    return this.mutate(data => {
      if (hash(fs.readFileSync(this.file)) !== expectedHash) throw new Error('登记库已发生后续变化，拒绝覆盖；先核对差异');
      Object.assign(data, restored);
      return { restoredFrom: backup };
    });
  }
}
// Read-only migration inventory: explicit candidates, no production enrollment.
function inventory(candidates) {
  return listPreparedProjects(candidates, {}, { siblingScan: false }).map(item => ({
    path: item.path, name: item.name, configHash: prepared(item.path).configHash,
    decision: 'pending', reason: '待核实正式根目录的准备记录',
  }));
}
function projectLocator(meeting) {
  if (!meeting.serialWorkflow?.workRoot && !meeting.serialWorkflow?.projectLocator) return '';
  try {
    const projects = new PreparedProjectRegistry().list().items;
    return [
      '## 正式项目库（本轮重新读取）',
      ...projects.map(p => `- ${p.name} → ${p.path}`),
      projects.length ? '按本轮任务中的名称和路径核实目标；唯一命中就直接使用，不要例行追问。只有确实存在歧义时才说明缺少的事实。'
        : '尚无已登记项目。完成 project-prep 并登记正式主目录后再使用项目库。',
      '用户明确选择的工作目录仍需核实；不得把扫描发现的目录、同名 clone 或旧项目快照自动当作正式项目。',
    ].join('\n');
  } catch (error) {
    return `正式项目库读取失败：${error.message}。不要使用旧快照或猜选同名副本；用户明确的项目路径仍需核实。`;
  }
}
module.exports = { PreparedProjectRegistry, prepared, inventory, hash, projectLocator };
