'use strict';

const crypto = require('crypto');
const childProcess = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { getHubDataDir, isIsolatedHub } = require('./data-dir.js');
const { acquireLock, releaseLock } = require('./file-lock.js');
const storageRoots = require('./storage-roots.js');

const REGISTRY_VERSION = 1;
const REGISTRY_LOCK_RETRIES = 300;
const REGISTRY_LOCK_RETRY_DELAY_MS = 10;
const REGISTRY_RENAME_RETRIES = 80;
const REGISTRY_RENAME_RETRY_DELAY_MS = 15;
const TRANSIENT_RENAME_CODES = new Set(['EACCES', 'EBUSY', 'EPERM']);
const RENAME_SLEEP_CELL = new Int32Array(new SharedArrayBuffer(4));
const DEFAULT_RECOMMENDED_CATEGORIES = [
  { id: 'ai', directory: 'AI', label: 'AI', description: 'Agent / 应用开发' },
  { id: 'wireless', directory: 'Wireless', label: 'Wireless', description: '无线通信研究' },
];

// ── 平铺工作根（2026-08-31 用户决策）────────────────────────────────────────────
// 以前每个任务都开在 <root>\_scratch\inbox-<时间戳>-<随机>，理由是「产物隔离 + 可整体删」。
// 这一轮把这两条理由都实测了一遍，没能撑住：
//   · 产物冲突 = 29 条路径 / 12 个会话 / 四个月（207 目录合并模拟）
//   · 大 cwd 对 agent 的可测影响 ≈ 0.5%~1% 的工具调用（Grep 98.4% 自带 path 限定；
//     17,288 次 shell 调用里只有 87 次列 cwd 根；目录清单不会自动进上下文）
//   · 「可整体删」四个月里一次没用过（208 个目录 / 151 个超 7 天 / 一个没删）
// 而平铺的收益是实测的：61.3% 的会话需要引用别的会话目录（13,931 次），
// 平铺后这些全变成同一个 cwd 下的相对路径。
//
// 所以默认改成「所有新会话直接开在工作根」。但**不是无条件拆掉根守卫**——
// classifyWorkspace() 里那条「聚合根不能当 workspace」是为 C:\Workspace 写的，那里
// 确实不该干活（用户根规则第一条就禁止）。用一个显式标记区分两种根：
//   <root>\.aiwork-root 存在 → 这是专门的工作根，允许直接在上面开会话
//   标记不存在             → 沿用旧行为，根仍然硬拦，默认落 _scratch
// 标记是文件而不是配置项，因为它跟着目录走：把 AI_HUB_WORKSPACE_ROOT 指回
// C:\Workspace 时守卫自动恢复，不需要记得改任何开关。
const WORK_ROOT_MARKER = '.aiwork-root';

// ── 旧工作根（2026-10-07，C: 盘满、新工作根迁到 D:）─────────────────────────────────
// AI_HUB_WORKSPACE_ROOT 换成 D:\AIWork 后，存量会话的 cwd 仍是 C:\Work 或 C:\Work\<任务>。
// AI_HUB_LEGACY_WORKSPACE_ROOTS 列出的旧根只要**也带 .aiwork-root 标记**，就按平铺工作根对待：
// 分层、常驻根标签、AGENTS.md 播种源（用旧根自己的 AGENTS.md）、scratch 判定都与当前根一致。
// 新会话、默认路径、推荐目录、归档分类仍只看当前根。没有标记的旧根不参与（与 C:\Workspace
// 那类组织根同理：标记跟着目录走）。未设置该 env 时行为与之前完全相同。

function normalizeKey(value) {
  return path.resolve(String(value || '')).replace(/[\\/]+$/, '').toLowerCase();
}

function isPathInside(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return !!relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function safeSlug(value, fallback = 'workspace') {
  const ascii = String(value || '')
    .normalize('NFKC')
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, ' ')
    .replace(/[. ]+$/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 48);
  return ascii || fallback;
}

function timestampSlug(date = new Date()) {
  const pad = n => String(n).padStart(2, '0');
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    '-',
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds()),
  ].join('');
}

class WorkspaceService {
  constructor(opts = {}) {
    this.fs = opts.fs || fs;
    this.path = opts.path || path;
    this.os = opts.os || os;
    this.getHubDataDir = opts.getHubDataDir || getHubDataDir;
    this.isIsolatedHub = opts.isIsolatedHub || isIsolatedHub;
    this.now = opts.now || (() => Date.now());
    this.randomId = opts.randomId || (() => crypto.randomBytes(3).toString('hex'));
    this.logger = opts.logger || console;
    this.workspaceRoot = opts.workspaceRoot || null;
    // 注入 workspaceRoot 的调用方（单测）默认不读 env 里的旧根，避免用户环境变量渗进测试。
    this.legacyWorkspaceRoots = Array.isArray(opts.legacyWorkspaceRoots)
      ? opts.legacyWorkspaceRoots
      : (this.workspaceRoot ? [] : null);
    this.acquireRegistryLock = opts.acquireRegistryLock || acquireLock;
    this.releaseRegistryLock = opts.releaseRegistryLock || releaseLock;
    // 注册表落盘位置必须和 workspaceRoot 一样可注入。原先只有 workspaceRoot 能注入，
    // getRegistryPath() 却硬走 getHubDataDir() —— 单测把 workspace 建在临时目录、
    // 却把条目写进用户的生产 ~/.ai-hub-community/workspaces.json，每跑一次脏一批
    // （2026-07-28 实测生产库 74 条里 48 条是测试残留，selectedPath 还指向已删的临时目录）。
    this.registryPath = opts.registryPath || null;
    this.initGit = opts.initGit || (cwd => {
      const result = childProcess.spawnSync('git', ['init', '--quiet'], {
        cwd,
        windowsHide: true,
        encoding: 'utf8',
      });
      return !result.error && result.status === 0;
    });
  }

  getWorkspaceRoot() {
    if (this.workspaceRoot) return this.path.resolve(this.workspaceRoot);
    const override = storageRoots.workspaceRoot();
    if (override) return this.path.resolve(override);
    if (this.isIsolatedHub()) return this.path.join(this.getHubDataDir(), 'workspaces', 'user');
    return this.path.join(this.os.homedir(), 'Workspaces');
  }

  // 仍按平铺工作根对待的旧根：来自 AI_HUB_LEGACY_WORKSPACE_ROOTS，且必须带 .aiwork-root 标记。
  getLegacyWorkspaceRoots() {
    const current = this.getWorkspaceRoot();
    const configured = this.legacyWorkspaceRoots === null
      ? storageRoots.legacyWorkspaceRoots({ current })
      : this.legacyWorkspaceRoots;
    const currentKey = normalizeKey(current);
    const seen = new Set([currentKey]);
    const roots = [];
    for (const item of configured || []) {
      if (!item || typeof item !== 'string' || !item.trim()) continue;
      const resolved = this.path.resolve(item.trim());
      const key = normalizeKey(resolved);
      if (seen.has(key)) continue;
      seen.add(key);
      try {
        if (!this.fs.existsSync(this.path.join(resolved, WORK_ROOT_MARKER))) continue;
      } catch { continue; }
      roots.push(resolved);
    }
    return roots;
  }

  // cwd 归属哪个工作根：先看当前根，再看旧根。返回 { root, legacy } 或 null（工作区之外）。
  _rootMatch(cwd) {
    if (!cwd || typeof cwd !== 'string') return null;
    const resolved = this.path.resolve(cwd);
    const current = this.getWorkspaceRoot();
    const within = root => normalizeKey(resolved) === normalizeKey(root) || isPathInside(root, resolved);
    if (within(current)) return { root: current, legacy: false };
    for (const root of this.getLegacyWorkspaceRoots()) {
      if (within(root)) return { root, legacy: true };
    }
    return null;
  }

  // 给 memory 规则链等调用方用：cwd 所在的工作根（当前根或旧根），工作区之外返回 null。
  workspaceRootFor(cwd) {
    const match = this._rootMatch(cwd);
    return match ? match.root : null;
  }

  // cwd 本身就是一个平铺工作根（当前根带标记，或任一旧根）——常驻容器，不随会话改名。
  _isPermanentRootPath(cwd) {
    const resolved = this.path.resolve(cwd);
    const key = normalizeKey(resolved);
    if (key === normalizeKey(this.getWorkspaceRoot())) return this.isFlatWorkRoot();
    return this.getLegacyWorkspaceRoots().some(root => normalizeKey(root) === key);
  }

  getScratchRoot() {
    return this.path.join(this.getWorkspaceRoot(), '_scratch');
  }

  // cwd 所属工作根的 _scratch（当前根或旧根）；工作区之外返回 null。
  _scratchRootFor(cwd) {
    const match = this._rootMatch(cwd);
    return match ? this.path.join(match.root, '_scratch') : null;
  }

  // 工作根是「可以直接在上面干活的根」还是「只能当组织根的根」？看标记文件。
  // 见文件头 WORK_ROOT_MARKER 处的决策说明。
  isFlatWorkRoot() {
    try {
      return this.fs.existsSync(this.path.join(this.getWorkspaceRoot(), WORK_ROOT_MARKER));
    } catch {
      return false;
    }
  }

  // 平铺模式下的默认工作区 = 工作根本身。
  //
  // 这里**不 seed AGENTS.md**：平铺下 cwd 就是根，根上那份 AGENTS.md 本来就是源文件，
  // 自己播种给自己没有意义（seedUngovernedAgentsFile 也确实会对根返回 false，因为
  // isPathInside(root, root) === false）。所以不再需要给每个任务目录发副本——
  // 存量 198 份副本 + 193 个 .vibe-root，平铺后各只要 1 份。
  //
  // 但 .vibe-root 仍然必须有：Codex 从「最近的带标记祖先」向下收集 AGENTS.md，
  // 根上没标记的话它会一路走到 C:\，把盘符根下所有 AGENTS.md 都读进来。
  ensureDefaultWorkspace(meta = {}) {
    const root = this.getWorkspaceRoot();
    this.fs.mkdirSync(root, { recursive: true });
    try {
      this._ensureCodexRootMarker(root);
    } catch (error) {
      this.logger.warn('[workspace] ensure codex root marker failed:', error && error.message);
    }
    return this.touchWorkspace(root, {
      // **故意忽略 meta.label**。调用方普遍传「未命名任务」「未命名群聊」这类会话级标签
      // （renderer 的 createDefaultWorkspace、session-handlers 的 opts.workspaceLabel），
      // 而 touchWorkspace 每次都会用非空 label 覆盖注册表里的值 —— 照单全收的话，
      // 每开一个新会话都会把工作根重命名成「未命名任务」。工作根是常驻工作区，
      // 名字必须稳定，只认目录名。
      label: this._defaultLabel(root),
      // 平铺根是常驻工作区，不是草稿：draft 会触发归档提示，而平铺方案下没有归档这回事。
      draft: false,
      select: meta.select !== false,
    });
  }

  getRegistryPath() {
    if (this.registryPath) return this.path.resolve(this.registryPath);
    return this.path.join(this.getHubDataDir(), 'workspaces.json');
  }

  ensureRoot() {
    this.fs.mkdirSync(this.getWorkspaceRoot(), { recursive: true });
    this.fs.mkdirSync(this.getScratchRoot(), { recursive: true });
    return this.getWorkspaceRoot();
  }

  _emptyRegistry() {
    return { schemaVersion: REGISTRY_VERSION, selectedPath: null, workspaces: [] };
  }

  _readRegistry(opts = {}) {
    try {
      const parsed = JSON.parse(this.fs.readFileSync(this.getRegistryPath(), 'utf8'));
      // listWorkspaces 会过滤掉目录已消失的条目，selectedPath 却没有对应兜底——
      // 指向一个被删掉的目录时会一直原样传给 renderer。这里统一置空自愈。
      let selectedPath = typeof parsed.selectedPath === 'string' ? parsed.selectedPath : null;
      if (selectedPath && !this._isDirectory(selectedPath)) selectedPath = null;
      return {
        schemaVersion: REGISTRY_VERSION,
        selectedPath,
        workspaces: Array.isArray(parsed.workspaces) ? parsed.workspaces : [],
      };
    } catch (err) {
      if (opts.strict && err && err.code !== 'ENOENT') throw err;
      if (err && err.code !== 'ENOENT') this.logger.warn('[workspace] registry read failed:', err.message);
      return this._emptyRegistry();
    }
  }

  _registryLockPath() {
    return `${this.getRegistryPath()}.lock`;
  }

  _withRegistryLock(fn) {
    const registryPath = this.getRegistryPath();
    this.fs.mkdirSync(this.path.dirname(registryPath), { recursive: true });
    const lockPath = this._registryLockPath();
    const fd = this.acquireRegistryLock(lockPath, {
      retries: REGISTRY_LOCK_RETRIES,
      retryDelayMs: REGISTRY_LOCK_RETRY_DELAY_MS,
    });
    if (fd == null) {
      const error = new Error('workspace 注册表正被另一个 Hub 占用，请稍后重试');
      error.code = 'WORKSPACE_REGISTRY_BUSY';
      throw error;
    }
    try {
      return fn();
    } finally {
      this.releaseRegistryLock(fd, lockPath);
    }
  }

  _renameRegistryWithRetry(source, target) {
    for (let attempt = 0; ; attempt += 1) {
      try {
        this.fs.renameSync(source, target);
        return attempt;
      } catch (error) {
        if (!error || !TRANSIENT_RENAME_CODES.has(error.code) || attempt >= REGISTRY_RENAME_RETRIES) {
          throw error;
        }
        Atomics.wait(RENAME_SLEEP_CELL, 0, 0, REGISTRY_RENAME_RETRY_DELAY_MS);
      }
    }
  }

  // 只能在 _withRegistryLock() 内调用。锁外写入会重新引入多 Hub 的
  // read-modify-write 丢更新；调用方必须先持锁、再读取最新磁盘状态。
  _writeRegistry(registry) {
    const file = this.getRegistryPath();
    this.fs.mkdirSync(this.path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.${Date.now()}.${this.randomId()}.tmp`;
    try {
      this.fs.writeFileSync(tmp, JSON.stringify(registry, null, 2), 'utf8');
      this._renameRegistryWithRetry(tmp, file);
    } finally {
      try { if (this.fs.existsSync(tmp)) this.fs.unlinkSync(tmp); } catch {}
    }
  }

  _mutateRegistry(mutator) {
    return this._withRegistryLock(() => {
      const registry = this._readRegistry({ strict: true });
      const outcome = mutator(registry) || {};
      if (outcome.changed !== false) this._writeRegistry(registry);
      return outcome.value;
    });
  }

  _isDirectory(value) {
    try { return this.fs.statSync(value).isDirectory(); } catch { return false; }
  }

  _defaultLabel(cwd) {
    const resolved = this.path.resolve(cwd);
    if (normalizeKey(resolved) === normalizeKey(this.os.homedir())) return '用户主目录（旧会话）';
    return this.path.basename(resolved) || resolved;
  }

  getWorkspace(cwd) {
    if (!cwd || typeof cwd !== 'string') return null;
    const resolved = this.path.resolve(cwd);
    const registry = this._readRegistry();
    const item = registry.workspaces.find(entry => normalizeKey(entry.path) === normalizeKey(resolved));
    return item ? { ...item } : null;
  }

  isScratchWorkspace(cwd) {
    if (!cwd || typeof cwd !== 'string') return false;
    const resolved = this.path.resolve(cwd);
    const scratchRoot = this._scratchRootFor(resolved);
    return !!scratchRoot && isPathInside(scratchRoot, resolved);
  }

  // workspace 分层（2026-07-29 第五轮，用户决策 2）。
  //
  // 上一轮有人主张「禁止把 C:\Workspace\AI 这类分类根当 workspace」。不采纳：跨项目的审查、
  // 对比、领域规划本来就不属于任何单个项目，分类根正是它们该待的地方——这轮三方审查
  // 报告就写在 C:\Workspace\AI\artifacts\，完全合理。硬门禁会把正当用途一起堵死。
  //
  // 真正该拦的只有**聚合根本身**（C:\Workspace）：在那里搜索会扫穿所有领域，产物会落在组织根，
  // 根规则第一条就明写禁止。分类根的实际代价只有「搜索范围大」，那是 AI 的行为约束
  // （根规则「禁止全盘搜索」已覆盖），不是路径本身的问题。
  //
  // 所以给出层级、让 UI 说清楚用户选的是什么，而不是没收选项：
  //   root     C:\Workspace 本身          —— 唯一硬拦
  //   category C:\Workspace\<领域>        —— 允许，UI 标注「领域工作区」
  //   scratch  C:\Workspace\_scratch\*    —— 允许，走归档提示
  //   project  其余                  —— 常规项目
  //   external 工作区之外            —— 允许（Hub 自己的仓库就在外面）
  // 旧工作根（见文件头 legacy 说明）按同样规则分层：旧根本身 root、其下 _scratch 为 scratch，
  // 其余为 category / project。
  classifyWorkspace(cwd) {
    if (!cwd || typeof cwd !== 'string') return 'external';
    const resolved = this.path.resolve(cwd);
    const match = this._rootMatch(resolved);
    if (!match) return 'external';
    const root = match.root;
    if (normalizeKey(resolved) === normalizeKey(root)) return 'root';
    const scratchRoot = this.path.join(root, '_scratch');
    if (normalizeKey(resolved) === normalizeKey(scratchRoot) || isPathInside(scratchRoot, resolved)) return 'scratch';
    return normalizeKey(this.path.dirname(resolved)) === normalizeKey(root) ? 'category' : 'project';
  }

  // 只有聚合根本身不能当 workspace。返回 null 表示可用，否则是给用户看的理由。
  // 例外：带 .aiwork-root 标记的根是专门的平铺工作根，本来就该在上面干活。
  // 旧根只有带标记才会被认出来，所以旧根本身总是可用。
  workspaceRejectReason(cwd) {
    if (this.classifyWorkspace(cwd) !== 'root') return null;
    const match = this._rootMatch(cwd);
    if (match && match.legacy) return null;
    if (this.isFlatWorkRoot()) return null;
    return `${this.getWorkspaceRoot()} 是组织根，不能直接当工作目录`
      + '——在这里搜索会扫穿所有领域、产物会落在根上。请选具体项目、领域目录或新建临时任务。';
  }

  listArchiveCategories() {
    this.ensureRoot();
    const excluded = new Set(['_scratch', '_admin', 'worktrees']);
    let entries = [];
    try { entries = this.fs.readdirSync(this.getWorkspaceRoot(), { withFileTypes: true }); } catch {}
    return entries
      .filter(entry => entry && entry.isDirectory() && !excluded.has(entry.name.toLowerCase()) && !entry.name.startsWith('.'))
      .map(entry => ({ name: entry.name, path: this.path.join(this.getWorkspaceRoot(), entry.name) }))
      .sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
  }

  listRecommendedWorkspaces() {
    const root = this.getWorkspaceRoot();
    return DEFAULT_RECOMMENDED_CATEGORIES
      .map(item => {
        const cwd = this.path.join(root, item.directory);
        if (!this._isDirectory(cwd)) return null;
        return {
          id: `recommended-${item.id}`,
          path: cwd,
          label: item.label,
          description: item.description,
          tier: this.classifyWorkspace(cwd),
          recommended: true,
          draft: false,
          pinned: false,
        };
      })
      .filter(Boolean);
  }

  // 用户关掉过归档框就不再追问这个 workspace（含「暂留 _scratch」和 ×/Esc）。
  // 落盘而不是只存内存，Hub 重启后同样不再打扰。
  dismissArchive(cwd) {
    if (!cwd) return null;
    const resolved = this.path.resolve(cwd);
    return this._mutateRegistry(registry => {
      const item = registry.workspaces.find(entry => normalizeKey(entry.path) === normalizeKey(resolved));
      if (!item) return { value: null, changed: false };
      item.archiveDismissedAt = this.now();
      return { value: { ...item } };
    });
  }

  getArchiveContext(cwd) {
    const workspace = this.getWorkspace(cwd);
    const required = !!(workspace && workspace.draft && !workspace.archiveDismissedAt
      && this.isScratchWorkspace(workspace.path));
    return {
      required,
      root: this.getWorkspaceRoot(),
      workspace,
      categories: this.listArchiveCategories(),
    };
  }

  planArchive(cwd, opts = {}) {
    const source = this.path.resolve(String(cwd || ''));
    const workspace = this.getWorkspace(source);
    if (!workspace || !workspace.draft || !this.isScratchWorkspace(source)) {
      throw new Error('workspace is not an active scratch draft');
    }

    const parent = this.path.resolve(String(opts.parent || ''));
    if (!this._isDirectory(parent)) throw new Error(`archive parent does not exist: ${parent}`);
    const parentMatch = this._rootMatch(parent);
    if (parentMatch && normalizeKey(parent) === normalizeKey(parentMatch.root)) {
      throw new Error('请选择 Vibe 下的分类目录，不要把项目直接放在 Vibe 根目录');
    }
    const parentScratch = parentMatch ? this.path.join(parentMatch.root, '_scratch') : null;
    if (parentScratch && (normalizeKey(parent) === normalizeKey(parentScratch) || isPathInside(parentScratch, parent))) {
      throw new Error('归档目标不能仍在 _scratch 内');
    }

    const folderName = safeSlug(opts.folderName || workspace.suggestedName || workspace.label, workspace.id || 'workspace');
    const target = this.path.join(parent, folderName);
    if (normalizeKey(source) === normalizeKey(target) || isPathInside(source, target)) {
      throw new Error('archive target overlaps the scratch source');
    }
    if (this.path.parse(source).root.toLowerCase() !== this.path.parse(target).root.toLowerCase()) {
      throw new Error('暂不支持跨磁盘归档，请选择与 _scratch 相同磁盘上的路径');
    }
    if (this.fs.existsSync(target)) throw new Error(`目标路径已存在：${target}`);
    return { source, parent, folderName, target, workspace };
  }

  archiveDraft(cwd, opts = {}) {
    const plan = this.planArchive(cwd, opts);
    return this._withRegistryLock(() => {
      const registry = this._readRegistry({ strict: true });
      const item = registry.workspaces.find(entry => normalizeKey(entry.path) === normalizeKey(plan.source));
      if (!item || !item.draft || !this.isScratchWorkspace(plan.source)) {
        throw new Error('scratch workspace disappeared from registry');
      }
      if (this.fs.existsSync(plan.target)) throw new Error(`目标路径已存在：${plan.target}`);

      this.fs.renameSync(plan.source, plan.target);
      try {
        item.path = plan.target;
        item.label = String(opts.label || item.label || plan.folderName).trim().slice(0, 60) || plan.folderName;
        item.suggestedName = plan.folderName;
        item.draft = false;
        item.archivedAt = this.now();
        item.lastUsedAt = this.now();
        if (registry.selectedPath && normalizeKey(registry.selectedPath) === normalizeKey(plan.source)) {
          registry.selectedPath = plan.target;
        }
        this._writeRegistry(registry);
      } catch (error) {
        try { this.fs.renameSync(plan.target, plan.source); } catch (rollbackError) {
          this.logger.error?.('[workspace] archive registry rollback failed:', rollbackError && rollbackError.message);
        }
        throw error;
      }
      return { ...item };
    });
  }

  touchWorkspace(cwd, meta = {}) {
    if (!cwd || typeof cwd !== 'string') throw new Error('workspace path is required');
    const resolved = this.path.resolve(cwd);
    if (!this._isDirectory(resolved)) throw new Error(`workspace directory does not exist: ${resolved}`);
    const permanentRoot = this._isPermanentRootPath(resolved);
    return this._mutateRegistry(registry => {
      const key = normalizeKey(resolved);
      let item = registry.workspaces.find(entry => normalizeKey(entry.path) === key);
      if (!item) {
        item = {
          id: meta.id || this.randomId(),
          path: resolved,
          label: permanentRoot ? this._defaultLabel(resolved) : (meta.label || this._defaultLabel(resolved)),
          createdAt: this.now(),
          lastUsedAt: this.now(),
          draft: permanentRoot ? false : !!meta.draft,
          pinned: !!meta.pinned,
          gitInitialized: !!meta.gitInitialized,
          ...(permanentRoot ? { permanentRoot: true } : {}),
        };
        registry.workspaces.push(item);
      } else {
        item.path = resolved;
        item.lastUsedAt = this.now();
        if (permanentRoot || item.permanentRoot) {
          // 平铺工作根是所有 Session 共用的常驻容器，不属于任何一个会话。
          // 会话占位名、群聊标题、auto-title 都不得把它改名。
          item.permanentRoot = true;
          item.label = this._defaultLabel(resolved);
          item.draft = false;
          delete item.suggestedName;
          delete item.autoNamedAt;
        } else {
          if (typeof meta.label === 'string' && meta.label.trim()) item.label = meta.label.trim().slice(0, 60);
          // Only ever raise the draft flag here. Clearing it is archiveDraft()'s job —
          // a stray `draft: false` from a reconnect used to silently kill the
          // first-turn archive prompt and strand the workspace in _scratch.
          if (meta.draft === true) item.draft = true;
        }
        if (typeof meta.pinned === 'boolean') item.pinned = meta.pinned;
        if (typeof meta.gitInitialized === 'boolean') item.gitInitialized = meta.gitInitialized;
      }
      if (meta.select !== false) registry.selectedPath = resolved;
      return { value: { ...item, tier: this.classifyWorkspace(resolved) } };
    });
  }

  // Claude Code 会一路向上读到 <root>\CLAUDE.md，但 Codex / Kimi / Gemini 只读
  // 自己的全局 AGENTS.md 和 cwd 自身的那一份——实测在 _scratch\inbox-* 里
  // 问 <root>\AGENTS.md 独有的规则，Codex 答 NO-RULES（git / 非 git 都一样）。
  // 所以把工作区边界规则复制进每个新 scratch，非 Claude 的 CLI 才能拿到。
  // 副本必须跟着源刷新，不能只在缺失时写一次。
  //
  // 2026-07-29 三方审查：两个 seed 原本都是 `existsSync(target) → return false`，
  // 与 main.js 的 ensureHooksDeployed() 2026-04-19 那次事故是同一个错误——「防覆盖」
  // 被实现成「不处理」，老目录永远拿不到新规则（那次已修为内容比对，commit 5dd5dfe）。
  // 实测当时 14 份副本恰好都还和源一致，但那只是因为源两天没改过，不是设计使然。
  //
  // 只比规则正文（剥掉自动生成的头注释），所以用户手工改过头注释不会触发重写；
  // 正文一旦被人改过则视为「这份副本已被接管」，同样不动——只刷新仍是原样复制的那些。
  // 区分「源改了，副本该刷新」和「用户接管了这份副本，不许动」——两者表象相同（正文 ≠ 源），
  // 光比内容分不开。所以往头注释里写一枚 seed-sha256：它记的是**写入当时正文的哈希**。
  //   现正文哈希 == 标记  → 这份还是原样复制的，源变了就刷新
  //   现正文哈希 != 标记  → 用户改过，永不覆盖
  // 老副本没有标记：正文与源一致时补写标记（内容不变）；不一致时先留底再升级，
  // 避免源规则先变、旧副本永远卡死在旧版本。
  //
  // ── seed 副本与 Codex root 标记必须成对出现（2026-07-29 第五轮，用户决策 1）────────
  // Kimi 无 .git 时只读 cwd 自己那份，所以必须 seed；而 Codex 从 project root 向下逐层
  // 收集，会把沿途每一份 seed 副本都读进去——副本内容又恰好等于根规则全文，于是同一份
  // 规则被注入 N 遍（实测 C:\Workspace\AI 4426B 里 62% 是重复；再深一层 AI\proj 变成 4 份）。
  //
  // 试过但不够的方案：只在工作区根/分类根放 `.vibe-root`。它把 root 从 C:\Workspace 收到
  // C:\Workspace\AI，解决了浅层，但 AI\proj 这类更深的 seed 目录仍然读到 AI + proj 两份
  // （Codex 2 实测证伪，沙盘复现一致）。
  //
  // 成立的方案：**seed 到哪，`.vibe-root` 就放到哪**。Codex root 收缩到该目录本身 →
  // 无论多深都只读「全局 + 自己」两份，是 O(1) 而不是 O(深度)。规则一个字不丢，因为
  // 副本就是根规则全文。Kimi 只认 `.git`，对这个标记视而不见，零影响。
  // 边界：项目自有的 AGENTS.md 不会被 seed，也就不会拿到标记，行为完全不变。
  _ensureCodexRootMarker(cwd) {
    const marker = this.path.join(cwd, '.vibe-root');
    try {
      if (this.fs.existsSync(marker)) return false;
      this.fs.writeFileSync(marker,
        '# Codex project_root_markers 标记：AGENTS.md 收集从这一层开始\n'
        + '# 由 AI Hub 随同目录的 seed 版 AGENTS.md 一起生成。没有它，Codex 会把上级每一份\n'
        + '# seed 副本都读一遍，同一份规则重复注入。删掉 AGENTS.md 时把这个也一起删。\n',
        { encoding: 'utf8', flag: 'wx' });
      return true;
    } catch (error) {
      // existsSync 与 writeFileSync 之间可能有另一个会话先写完；这不是失败。
      if (error && error.code === 'EEXIST') return false;
      this.logger.warn('[workspace] write .vibe-root failed:', error && error.message);
      return false;
    }
  }

  // Kimi 无 .git 时只读 cwd 自己，Codex 又会被配套 .vibe-root 收口到 cwd，所以深层
  // seed 必须是一份「从工作区根到 cwd 父目录」的完整合并规则，不能只复制根规则。
  // 否则 parent/AGENTS.md 的项目规则会被 Hub 自己新建的边界挡掉。
  _collectInheritedAgents(cwd, rootSource, rootDir = null) {
    const workspaceRoot = this.path.resolve(rootDir || this.getWorkspaceRoot());
    const resolved = this.path.resolve(cwd);
    const dirs = [];
    for (let cur = this.path.dirname(resolved);;) {
      if (normalizeKey(cur) === normalizeKey(workspaceRoot) || isPathInside(workspaceRoot, cur)) dirs.push(cur);
      if (normalizeKey(cur) === normalizeKey(workspaceRoot)) break;
      const parent = this.path.dirname(cur);
      if (!parent || parent === cur) break;
      cur = parent;
    }
    dirs.reverse();

    const pieces = [];
    const includesBlock = (container, block) => container === block
      || (`\n${container}\n`).includes(`\n${block}\n`);
    for (const dir of dirs) {
      const file = this.path.join(dir, 'AGENTS.md');
      if (!this.fs.existsSync(file)) continue;
      let body = this.fs.readFileSync(file, 'utf8');
      const header = body.match(/^<!--[\s\S]*?-->\r?\n\r?\n/);
      if (header && /由 AI Hub/.test(header[0])) body = body.slice(header[0].length);
      const normalized = body.replace(/\r\n?/g, '\n').trim();
      if (!normalized) continue;

      // 子级项目文件有时已经完整包含根规则。保留更完整的那份，避免合并后又把根规则
      // 重复一遍；不做模糊去重，Markdown 的顺序、缩进和空白都可能有语义。
      if (pieces.some(piece => includesBlock(piece.normalized, normalized))) continue;
      for (let i = pieces.length - 1; i >= 0; i -= 1) {
        if (includesBlock(normalized, pieces[i].normalized)) pieces.splice(i, 1);
      }
      pieces.push({ file, body, normalized });
    }

    // 理论上 rootSource 已在 dirs 里；保底避免异常 workspaceRoot 配置生成空副本。
    if (!pieces.length && this.fs.existsSync(rootSource)) {
      const body = this.fs.readFileSync(rootSource, 'utf8');
      pieces.push({ file: rootSource, body, normalized: body.replace(/\r\n?/g, '\n').trim() });
    }
    return {
      // 单来源保持字节原样；多来源只在文件之间插入分隔空行，不改任一规则正文。
      body: pieces.length === 1 ? pieces[0].body : pieces.map(piece => piece.body).join('\n\n'),
      sources: pieces.map(piece => piece.file),
    };
  }

  _seedAgentsFile(cwd, headerLines, source, bodyOverride = null) {
    const target = this.path.join(cwd, 'AGENTS.md');
    try {
      if (!this.fs.existsSync(source)) return false;
      const body = bodyOverride === null ? this.fs.readFileSync(source, 'utf8') : String(bodyOverride);
      const bodyHash = crypto.createHash('sha256').update(body, 'utf8').digest('hex').slice(0, 16);
      const header = `<!-- ${headerLines}\n     seed-sha256: ${bodyHash} —— Hub 靠它判断这份副本有没有被你改过，别删这行。 -->\n\n`;
      const next = header + body;

      if (!this.fs.existsSync(target)) {
        this.fs.writeFileSync(target, next, 'utf8');
        this._ensureCodexRootMarker(cwd);
        return true;
      }

      const current = this.fs.readFileSync(target, 'utf8');
      if (current === next) {
        // 已是最新。仍然确保标记在位——存量的 23 份副本就是走这条路补上的。
        this._ensureCodexRootMarker(cwd);
        return false;
      }

      const m = current.match(/^<!--[\s\S]*?-->\r?\n\r?\n/);
      // 只能接管 Hub 自己写过的副本。项目自己的 AGENTS.md 也可能以 HTML 注释开头，
      // 不能因为它后面的正文恰好与根规则相同，就把它误认成老 seed 并覆盖。
      // 还要核对当前源路径：不能把另一个 Hub / 旧工作区生成的文件当成本 Hub 副本接管。
      const managedHeader = !!(m && /由 AI Hub/.test(m[0]) && m[0].includes(`自动复制自 ${source}`));
      const currentBody = managedHeader ? current.slice(m[0].length) : current;
      const currentHash = crypto.createHash('sha256').update(currentBody, 'utf8').digest('hex').slice(0, 16);
      const marked = managedHeader ? m[0].match(/seed-sha256:\s*([0-9a-f]{16})/) : null;

      if (marked) {
        // 用户改过正文 = 这份已是项目自己的规则。既不刷新，也不主动补 Codex root 标记
        // （已有的不删——那是上一次 Hub 管理时留下的，去掉反而会让 Codex 突然多读几份）。
        if (marked[1] !== currentHash) return false;
        this.fs.writeFileSync(target, next, 'utf8');                        // 原样副本 + 源已变 → 刷新
        this._ensureCodexRootMarker(cwd);
        this.logger.log?.(`[workspace] AGENTS.md 副本随源刷新: ${target}`);
        return true;
      }

      // 无标记的老副本。旧实现本来就是逐字复制，故这里只统一 CRLF/LF；不能把所有
      // 空白删掉再比，Markdown 缩进和代码块有语义，用户只改排版也算接管。
      const normalizeNewlines = value => String(value).replace(/\r\n?/g, '\n');
      if (managedHeader) {
        if (normalizeNewlines(currentBody) === normalizeNewlines(body)) {
          this.fs.writeFileSync(target, next, 'utf8');                      // 内容本就一致，补标记
          this._ensureCodexRootMarker(cwd);
          return true;
        }
        // 正文与源不一致，且没有 seed 标记可用来区分「源变了」和「用户接管了」。
        //
        // 原先在这里保守跳过——实测直接卡死：2026-07-29 往 C:\Workspace\AGENTS.md 加了「工具自身
        // 豁免迁移」一节后，C:\Workspace\AI\AGENTS.md 这份存量副本再也刷不动，Codex / Kimi 读到的
        // 规则与 Claude 读到的永久不一致。「不覆盖」又一次被做成了「不处理」——正是本轮
        // 三方共同定下的规约要禁的那个反模式（memory-link:59 / seed / ensureHooksDeployed
        // 已经是同一个错误的第四次出现）。
        //
        // 所以改成「留证据再刷新」：header 明确写着由 Hub 自动复制，就按 Hub 管理处理；
        // 万一真是用户改的，改动原样躺在旁边的 .hub-backup-* 里，一个字都没丢。
        // 只发生一次——刷新后这份就带上 seed-sha256，之后都走上面有标记的正常路径。
        const backupBase = `${target}.hub-backup-${timestampSlug(new Date(this.now()))}`;
        let backup = backupBase;
        let backupSuffix = 2;
        try {
          while (this.fs.existsSync(backup)) backup = `${backupBase}-${backupSuffix++}`;
          this.fs.writeFileSync(backup, current, { encoding: 'utf8', flag: 'wx' });
        } catch (backupError) {
          this.logger.warn('[workspace] AGENTS.md 备份失败，放弃刷新:', backupError && backupError.message);
          return false;
        }
        this.fs.writeFileSync(target, next, 'utf8');
        this._ensureCodexRootMarker(cwd);
        this.logger.log?.(`[workspace] 存量 AGENTS.md 副本升级并补标记，原件留底 ${this.path.basename(backup)}：${target}`);
        return true;
      }
      this.logger.warn(`[workspace] AGENTS.md 不是 Hub 生成的副本，保持原样：${target}`);
      return false;
    } catch (error) {
      this.logger.warn('[workspace] seed AGENTS.md failed:', error && error.message);
      return false;
    }
  }

  seedScratchAgentsFile(cwd) {
    // 旧根下的存量 scratch 继续用旧根自己的 AGENTS.md：副本 header 里记的就是那个源路径，
    // 换源会让 _seedAgentsFile 把它当成「别处生成的文件」而不再刷新。
    const source = this.path.join(this.workspaceRootFor(cwd) || this.getWorkspaceRoot(), 'AGENTS.md');
    const header = `由 AI Hub 在新建临时 workspace 时自动复制自 ${source}，并随源文件自动刷新。\n`
      + `     Codex / Kimi / Gemini 读不到上级目录的 AGENTS.md，只能靠这份副本。\n`
      + `     改了正文即视为本项目自己的规则，Hub 不再覆盖。\n`
      + `     归档到正式项目后可以删除，改用项目自己的 AGENTS.md。`;
    return this._seedAgentsFile(cwd, header, source);
  }

  // Kimi / Codex 的 AGENTS.md 发现规则（2026-07-29 探针 + wire.jsonl 实测，详见
  // core/prompt-inspect.js 头注释）：向上找到最近的 .git 才会从根向下收集；
  // **没有 .git 时只读 cwd 自己那一份**，父目录一份都不读。
  // 对工作区内「不在任何 git 仓库、且 cwd 还没有 AGENTS.md」的目录（典型：未 git init
  // 的项目，如 AI\ai-hub-lite），在 spawn 前补一份与 scratch 相同的根规则副本——
  // 否则该目录里起的 Kimi 会话只剩全局约定，工作区边界规则全丢。
  // 有 git 根的目录不插手：根上有没有 AGENTS.md 是项目自己的事（可用 /init 生成）。
  seedUngovernedAgentsFile(cwd) {
    const resolved = this.path.resolve(String(cwd || ''));
    // 只补工作区内的目录——工作区外的 cwd 不该被塞进 C:\Workspace 的规则。
    // 旧工作根内的目录同样算工作区内，规则源是该旧根自己的 AGENTS.md。
    const match = this._rootMatch(resolved);
    if (!match || normalizeKey(resolved) === normalizeKey(match.root)) return false;
    const governingRoot = match.root;
    const scratchRoot = this.path.join(governingRoot, '_scratch');
    // Hub 创建的 scratch 会先 seed、再 git init。存量 scratch 因而天然已有 .git；
    // 如果先走下面的 git 守卫，旧副本就永远不会补 hash / .vibe-root，也不会随源刷新。
    if (normalizeKey(resolved) === normalizeKey(scratchRoot) || isPathInside(scratchRoot, resolved)) {
      return this.seedScratchAgentsFile(resolved);
    }
    const source = this.path.join(governingRoot, 'AGENTS.md');
    const baseHeader = `由 AI Hub 在启动会话时自动复制自 ${source}，并随源文件自动刷新。\n`
      + `     这个目录不在任何 git 仓库内，Kimi 读不到上级目录的 AGENTS.md，只能靠这份副本。\n`
      + `     同目录的 .vibe-root 会把 Codex 收集边界收在这一层，因此 Codex 也只读这一份，不会叠加上级副本。\n`
      + `     改了正文即视为本项目自己的规则，Hub 不再覆盖。\n`
      + `     归档后可保留；若改用项目自己的 AGENTS.md，请连同 .vibe-root 一起按项目需要处理。`;
    const target = this.path.join(resolved, 'AGENTS.md');
    const seed = () => {
      const inherited = this._collectInheritedAgents(resolved, source, governingRoot);
      const sourceNote = inherited.sources.length > 1
        ? `\n     本副本还合并了沿途项目规则：${inherited.sources.slice(1).join('；')}`
        : '';
      return this._seedAgentsFile(resolved, baseHeader + sourceNote, source, inherited.body);
    };
    // 已有文件时先让 _seedAgentsFile 判定所有权：当前 Hub 的托管副本即使后来 git init
    // 也要继续刷新；项目自有文件 / 其他来源的副本会原样保留，且不会拿到 marker。
    if (this.fs.existsSync(target)) return seed();
    for (let cur = resolved;;) {
      if (this.fs.existsSync(this.path.join(cur, '.git'))) return false;
      const parent = this.path.dirname(cur);
      if (!parent || parent === cur) break;
      cur = parent;
    }
    return seed();
  }

  createScratchWorkspace(meta = {}) {
    this.ensureRoot();
    const name = `inbox-${timestampSlug(new Date(this.now()))}-${this.randomId()}`;
    const cwd = this.path.join(this.getScratchRoot(), name);
    this.fs.mkdirSync(cwd, { recursive: false });
    let gitInitialized = false;
    // Temporary conversations are not projects. Shared rules are resolved at
    // submission; no per-session rule copy or artificial Git root is needed.
    try { if (meta.initGit === true) gitInitialized = !!this.initGit(cwd); } catch (err) {
      this.logger.warn('[workspace] scratch git init failed:', err && err.message);
    }
    return this.touchWorkspace(cwd, {
      label: meta.label || '未命名任务',
      draft: true,
      select: meta.select !== false,
      gitInitialized,
    });
  }

  // 没给 cwd 时落到哪，由三件事决定（优先级从高到低）：
  //   1. meta.workspaceMode === 'scratch' —— 用户明确要一次性随机目录
  //   2. 工作根带 .aiwork-root 标记        —— 平铺模式，默认开在根上
  //   3. 其余                              —— 旧行为，建 _scratch\inbox-*
  // 单会话和群聊都走这里，所以群聊自动跟着变，不需要单独改 meeting 路径。
  resolveForSession(cwd, meta = {}) {
    if (typeof cwd === 'string' && cwd.trim()) {
      const resolved = this.path.resolve(cwd.trim());
      const rejectReason = this.workspaceRejectReason(resolved);
      if (rejectReason) throw new Error(rejectReason);
      return this.touchWorkspace(resolved, meta);
    }
    if (meta.workspaceMode === 'scratch') return this.createScratchWorkspace(meta);
    if (this.isFlatWorkRoot()) return this.ensureDefaultWorkspace(meta);
    return this.createScratchWorkspace(meta);
  }

  updateSuggestedName(cwd, title) {
    if (!cwd || !title) return null;
    const resolved = this.path.resolve(cwd);
    const permanentRoot = this._isPermanentRootPath(resolved);
    return this._mutateRegistry(registry => {
      const item = registry.workspaces.find(entry => normalizeKey(entry.path) === normalizeKey(resolved));
      if (!item) return { value: null, changed: false };
      if (permanentRoot || item.permanentRoot) {
        item.permanentRoot = true;
        item.label = this._defaultLabel(resolved);
        item.draft = false;
        delete item.suggestedName;
        delete item.autoNamedAt;
      } else {
        item.label = String(title).trim().slice(0, 60) || item.label;
        item.suggestedName = safeSlug(title, item.id || 'workspace');
        item.autoNamedAt = this.now();
      }
      item.lastUsedAt = this.now();
      return { value: { ...item } };
    });
  }

  renameLabel(cwd, label) {
    const clean = String(label || '').trim().slice(0, 60);
    if (!clean) throw new Error('workspace label is required');
    const resolved = this.path.resolve(String(cwd || ''));
    if (this._isPermanentRootPath(resolved) || (this.getWorkspace(resolved) || {}).permanentRoot) {
      throw new Error('平铺工作根名称固定为目录名，不能按单个任务重命名');
    }
    return this.touchWorkspace(cwd, { label: clean, select: true });
  }

  listWorkspaces(extraPaths = []) {
    this.ensureRoot();
    const legacyRoots = this.getLegacyWorkspaceRoots();
    const updateRegistry = registry => {
      let changed = false;
      for (const cwd of extraPaths) {
        if (!cwd || typeof cwd !== 'string' || !this._isDirectory(cwd)) continue;
        const resolved = this.path.resolve(cwd);
        if (!registry.workspaces.some(entry => normalizeKey(entry.path) === normalizeKey(resolved))) {
          const permanentRoot = this._isPermanentRootPath(resolved);
          registry.workspaces.push({
            id: this.randomId(),
            path: resolved,
            label: this._defaultLabel(resolved),
            createdAt: this.now(),
            lastUsedAt: 0,
            draft: false,
            pinned: false,
            legacy: normalizeKey(resolved) === normalizeKey(this.os.homedir()),
            ...(permanentRoot ? { permanentRoot: true } : {}),
          });
          changed = true;
        }
      }
      const permanentRootKeys = [
        ...(this.isFlatWorkRoot() ? [normalizeKey(this.getWorkspaceRoot())] : []),
        ...legacyRoots.map(root => normalizeKey(root)),
      ];
      for (const rootKey of permanentRootKeys) {
        const rootItem = registry.workspaces.find(entry => entry && normalizeKey(entry.path) === rootKey);
        if (rootItem) {
          const stableLabel = this._defaultLabel(rootItem.path);
          if (!rootItem.permanentRoot || rootItem.label !== stableLabel || rootItem.draft
              || rootItem.suggestedName !== undefined || rootItem.autoNamedAt !== undefined) {
            rootItem.permanentRoot = true;
            rootItem.label = stableLabel;
            rootItem.draft = false;
            delete rootItem.suggestedName;
            delete rootItem.autoNamedAt;
            changed = true;
          }
        }
      }
      const before = registry.workspaces.length;
      registry.workspaces = registry.workspaces.filter(entry => entry && entry.path && this._isDirectory(entry.path));
      if (registry.workspaces.length !== before) changed = true;
      return { value: registry, changed };
    };
    const registry = this._mutateRegistry(updateRegistry);
    const selectedKey = registry.selectedPath ? normalizeKey(registry.selectedPath) : '';
    const items = registry.workspaces
      // tier 供 UI 区分「领域工作区」和普通项目（决策 2：不禁止，但要说清楚选的是什么）。
      .map(entry => ({ ...entry, tier: this.classifyWorkspace(entry.path), selected: normalizeKey(entry.path) === selectedKey }))
      .sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned) || (b.lastUsedAt || 0) - (a.lastUsedAt || 0));
    return {
      root: this.getWorkspaceRoot(),
      scratchRoot: this.getScratchRoot(),
      // UI 靠这个决定「默认」那一档显示成工作根还是临时目录。
      flatRoot: this.isFlatWorkRoot(),
      // 仍被认作平铺工作根的旧根（存量会话所在），只读信息。
      legacyRoots,
      selectedPath: registry.selectedPath,
      recommended: this.listRecommendedWorkspaces(),
      items,
    };
  }
}

module.exports = {
  WorkspaceService,
  DEFAULT_RECOMMENDED_CATEGORIES,
  isPathInside,
  normalizeKey,
  safeSlug,
  timestampSlug,
};
