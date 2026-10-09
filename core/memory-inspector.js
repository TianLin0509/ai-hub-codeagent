'use strict';
// core/memory-inspector.js
//
// 记忆面板的只读数据源：汇总各 CLI 的记忆/规则文件现状、seed 副本健康度、
// 梦境系统的配置与运行状态。只读不写——写的路在 dream-consolidation.js。

const fs = require('fs');
const path = require('path');
const os = require('os');

const { projectSlug } = require('./claude-transcript-locator.js');
const {
  DEFAULT_CONSOLIDATION_CONFIG,
  normalizeConsolidationConfig,
  seedCopyStatus,
  DREAM_BEGIN,
} = require('./dream-consolidation.js');

function statFile(p) {
  try {
    const st = fs.statSync(p);
    if (!st.isFile()) return null;
    let hasDreamSection = false;
    if (/\.md$/i.test(p) && st.size < 1024 * 1024) {
      try { hasDreamSection = fs.readFileSync(p, 'utf8').includes(DREAM_BEGIN); } catch {}
    }
    return { path: p, exists: true, size: st.size, mtime: st.mtimeMs, hasDreamSection };
  } catch {
    return { path: p, exists: false };
  }
}

// 真实总数，不受 listMdFiles 的展示上限影响。
function countMdFiles(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter(e => e.isFile() && /\.md$/i.test(e.name)).length;
  } catch {
    return 0;
  }
}

function listMdFiles(dir, limit = 50) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter(e => e.isFile() && /\.md$/i.test(e.name))
      .map(e => {
        const fp = path.join(dir, e.name);
        const st = fs.statSync(fp);
        return { path: fp, name: e.name, size: st.size, mtime: st.mtimeMs };
      })
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, limit);
  } catch {
    return [];
  }
}

function isSymlinkOrJunction(p) {
  try { return fs.lstatSync(p).isSymbolicLink(); } catch { return false; }
}

// Claude memory 桶全景：规范库 + 各 bucket 的链接/孤岛状态。
function inspectClaudeMemory(homeDir) {
  const canonical = path.join(homeDir, '.claude', 'projects', projectSlug(homeDir), 'memory');
  const canonicalFiles = listMdFiles(canonical);
  // listMdFiles 只回最近修改的 50 个（列表要能看），但面板标题得说真实总数——
  // 实测规范库有 206 篇，标题写「50 个文件」是错的。
  const canonicalTotal = countMdFiles(canonical);
  const buckets = [];
  for (const root of ['.claude', '.claude-deepseek']) {
    const projectsDir = path.join(homeDir, root, 'projects');
    let entries = [];
    try { entries = fs.readdirSync(projectsDir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const memoryDir = path.join(projectsDir, entry.name, 'memory');
      // 规范库自身不是孤岛——它是所有 junction 的目标。漏掉这个判定时它会以
      // 「孤岛」身份出现在面板上，一键并入会把规范库合并进自己（2026-08-01 E2E 抓出）。
      if (path.resolve(memoryDir) === path.resolve(canonical)) {
        buckets.push({ bucket: entry.name, root, status: 'canonical', path: memoryDir });
        continue;
      }
      let st = null;
      try { st = fs.lstatSync(memoryDir); } catch { continue; }
      if (st.isSymbolicLink()) {
        let target = '';
        try { target = fs.readlinkSync(memoryDir); } catch {}
        buckets.push({ bucket: entry.name, root, status: 'linked', path: memoryDir, target });
      } else if (st.isDirectory()) {
        const files = listMdFiles(memoryDir, 200);
        // 真实空目录不碍事，但也如实列出（它会在下次 spawn 时被换链）。
        // files 给面板做二级展开（前 30 个），fileCount 记真实总数。
        buckets.push({
          bucket: entry.name, root, path: memoryDir,
          status: files.length ? 'island' : 'empty-dir',
          fileCount: files.length,
          files: files.slice(0, 30),
        });
      }
    }
  }
  return {
    canonical: {
      path: canonical,
      exists: canonicalFiles.length > 0 || fs.existsSync(canonical),
      files: canonicalFiles,
      totalFiles: canonicalTotal,
    },
    buckets,
    islandCount: buckets.filter(b => b.status === 'island').length,
    linkedCount: buckets.filter(b => b.status === 'linked').length,
  };
}

function readSmallText(file, maxBytes = 1024 * 1024) {
  try {
    const st = fs.statSync(file);
    if (!st.isFile() || st.size > maxBytes) return '';
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

function ancestorsOutsideIn(dir) {
  const out = [];
  for (let cur = path.resolve(dir);;) {
    out.push(cur);
    const parent = path.dirname(cur);
    if (!parent || parent === cur) break;
    cur = parent;
  }
  return out.reverse();
}

function parseTomlStringArray(text, key, fallback = []) {
  const escaped = String(key).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = String(text || '').match(new RegExp(`^\\s*${escaped}\\s*=\\s*\\[([^\\]]*)\\]`, 'm'));
  if (!match) return fallback.slice();
  const values = match[1].split(',')
    .map(value => value.trim().replace(/^["']|["']$/g, ''))
    .filter(Boolean);
  return values.length ? values : fallback.slice();
}

function firstNonEmptyFile(candidates) {
  for (const file of candidates) {
    try {
      if (fs.statSync(file).isFile() && readSmallText(file).trim()) return file;
    } catch {}
  }
  return null;
}

function pushUniqueFile(rows, seen, label, file, role, extra = {}) {
  if (!file) return;
  const key = path.resolve(file).toLowerCase();
  if (seen.has(key)) return;
  const stat = statFile(file);
  if (!stat || !stat.exists) return;
  seen.add(key);
  rows.push({ label, ...stat, role, ...extra });
}

function codexConfig(codexHome) {
  const text = readSmallText(path.join(codexHome, 'config.toml'));
  return {
    text,
    markers: parseTomlStringArray(text, 'project_root_markers', ['.git']),
    fallbacks: parseTomlStringArray(text, 'project_doc_fallback_filenames', []),
  };
}

function discoverCodexFiles(cwd, codexHome) {
  const rows = [];
  const seen = new Set();
  const config = codexConfig(codexHome);
  const global = firstNonEmptyFile([
    path.join(codexHome, 'AGENTS.override.md'),
    path.join(codexHome, 'AGENTS.md'),
  ]);
  pushUniqueFile(rows, seen, 'Codex 全局指令', global, 'user-global');

  const literal = path.resolve(cwd);
  let projectRoot = null;
  for (let cur = literal;;) {
    if (config.markers.some(marker => fs.existsSync(path.join(cur, marker)))) {
      projectRoot = cur;
      break;
    }
    const parent = path.dirname(cur);
    if (!parent || parent === cur) break;
    cur = parent;
  }
  const dirs = projectRoot
    ? ancestorsOutsideIn(literal).filter(dir => dir === projectRoot || dir.startsWith(projectRoot + path.sep))
    : [literal];
  for (const dir of dirs) {
    const file = firstNonEmptyFile([
      path.join(dir, 'AGENTS.override.md'),
      path.join(dir, 'AGENTS.md'),
      ...config.fallbacks.map(name => path.join(dir, name)),
    ]);
    const seedStatus = file && path.dirname(file).toLowerCase() === literal.toLowerCase()
      ? (seedCopyStatus(file) || 'own')
      : undefined;
    pushUniqueFile(rows, seen, 'Codex 项目指令', file, 'project', seedStatus ? { seedStatus } : {});
  }
  return { rows, projectRoot, config };
}

function discoverClaudeFiles(cwd, configDir, workspaceRoot) {
  const rows = [];
  const seen = new Set();
  pushUniqueFile(rows, seen, 'Claude 全局指令', path.join(configDir, 'CLAUDE.md'), 'user-global');
  const literal = path.resolve(cwd);
  const root = path.resolve(workspaceRoot || literal);
  const relative = path.relative(root, literal);
  const insideRoot = relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
  const dirs = insideRoot
    ? ancestorsOutsideIn(literal).filter(dir => dir === root || dir.startsWith(root + path.sep))
    : ancestorsOutsideIn(literal);
  for (const dir of dirs) {
    pushUniqueFile(rows, seen, 'Claude 项目指令', path.join(dir, 'CLAUDE.md'), 'project');
    pushUniqueFile(rows, seen, 'Claude 本地覆盖', path.join(dir, 'CLAUDE.local.md'), 'local');
  }
  return rows;
}

function discoverKimiFiles(cwd, homeDir) {
  const rows = [];
  const seen = new Set();
  pushUniqueFile(rows, seen, 'Kimi 全局指令', path.join(homeDir, '.kimi-code', 'AGENTS.md'), 'user-global');
  const literal = path.resolve(cwd);
  let projectRoot = null;
  for (let cur = literal;;) {
    if (fs.existsSync(path.join(cur, '.git'))) { projectRoot = cur; break; }
    const parent = path.dirname(cur);
    if (!parent || parent === cur) break;
    cur = parent;
  }
  const dirs = projectRoot
    ? ancestorsOutsideIn(literal).filter(dir => dir === projectRoot || dir.startsWith(projectRoot + path.sep))
    : [literal];
  for (const dir of dirs) {
    const file = path.join(dir, 'AGENTS.md');
    const seedStatus = path.dirname(file).toLowerCase() === literal.toLowerCase()
      ? (seedCopyStatus(file) || (fs.existsSync(file) ? 'own' : 'missing'))
      : undefined;
    pushUniqueFile(rows, seen, 'Kimi 项目指令', file, 'project', seedStatus ? { seedStatus } : {});
  }
  return rows;
}

function discoverGeminiFiles(cwd, homeDir, workspaceRoot) {
  const rows = [];
  const seen = new Set();
  pushUniqueFile(rows, seen, 'Gemini 全局指令', path.join(homeDir, '.gemini', 'GEMINI.md'), 'user-global');
  const literal = path.resolve(cwd);
  const root = path.resolve(workspaceRoot || literal);
  const relative = path.relative(root, literal);
  const insideRoot = relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
  const dirs = insideRoot
    ? ancestorsOutsideIn(literal).filter(dir => dir === root || dir.startsWith(root + path.sep))
    : ancestorsOutsideIn(literal);
  for (const dir of dirs) {
    pushUniqueFile(rows, seen, 'Gemini 项目指令', path.join(dir, 'GEMINI.md'), 'project');
  }
  return rows;
}

function inspectCodexMemory(codexHome) {
  const resolvedHome = path.resolve(codexHome || path.join(os.homedir(), '.codex'));
  const memoryDir = path.join(resolvedHome, 'memories');
  const configText = readSmallText(path.join(resolvedHome, 'config.toml'));
  const enabled = /^\s*memories\s*=\s*true\s*(?:#.*)?$/mi.test(configText);
  const explicitlyDisabled = /^\s*use_memories\s*=\s*false\s*(?:#.*)?$/mi.test(configText);
  const files = listMdFiles(memoryDir, 20);
  const rolloutDir = path.join(memoryDir, 'rollout_summaries');
  let rolloutSummaryCount = 0;
  try {
    rolloutSummaryCount = fs.readdirSync(rolloutDir, { withFileTypes: true })
      .filter(entry => entry.isFile() && /\.md$/i.test(entry.name)).length;
  } catch {}
  return {
    home: resolvedHome,
    path: memoryDir,
    exists: fs.existsSync(memoryDir),
    enabled,
    useMemories: enabled && !explicitlyDisabled,
    totalFiles: countMdFiles(memoryDir),
    rolloutSummaryCount,
    files,
  };
}

// seed 副本全景：scratch 下有多少副本、多少被改过（知识待沉淀）。
function inspectSeedCopies(workspaceRoot) {
  const scratchRoot = path.join(workspaceRoot, '_scratch');
  const copies = [];
  let entries = [];
  try { entries = fs.readdirSync(scratchRoot, { withFileTypes: true }); } catch { return { scratchRoot, copies: [], modifiedCount: 0 }; }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const agentsPath = path.join(scratchRoot, entry.name, 'AGENTS.md');
    const status = seedCopyStatus(agentsPath);
    if (!status) continue;
    copies.push({ cwd: path.join(scratchRoot, entry.name), path: agentsPath, status });
  }
  return { scratchRoot, copies, modifiedCount: copies.filter(c => c.status === 'modified').length };
}

function readConsolidationState(hubDataDir) {
  const dir = path.join(hubDataDir, 'consolidation');
  let state = {};
  try { state = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8')); } catch {}
  let changelogCount = 0;
  let lastEntries = [];
  try {
    const lines = fs.readFileSync(path.join(dir, 'changelog.jsonl'), 'utf8').split(/\r?\n/).filter(Boolean);
    changelogCount = lines.length;
    lastEntries = lines.slice(-50).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch {}
  const staging = statFile(path.join(dir, 'staging.md'));
  return {
    dir,
    state,
    changelogCount,
    lastEntries: lastEntries.reverse(),
    staging,
  };
}

function readChangelog(hubDataDir, limit = 200) {
  const file = path.join(hubDataDir, 'consolidation', 'changelog.jsonl');
  try {
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean);
    return lines.slice(-limit).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean).reverse();
  } catch {
    return [];
  }
}

function getOverview({ homeDir = os.homedir(), workspaceRoot, flatRoot = false, hubDataDir, consolidationConfig }) {
  const claudeMemory = inspectClaudeMemory(homeDir);
  const codexMemory = inspectCodexMemory(path.join(homeDir, '.codex'));
  const seedCopies = inspectSeedCopies(workspaceRoot);
  const consolidation = readConsolidationState(hubDataDir);
  return {
    generatedAt: new Date().toISOString(),
    workspaceRoot,
    flatRoot,
    userGlobalFiles: [
      { label: 'Kimi 全局', ...statFile(path.join(homeDir, '.kimi-code', 'AGENTS.md')) },
      { label: 'Claude 全局', ...statFile(path.join(homeDir, '.claude', 'CLAUDE.md')) },
      { label: 'Codex 全局', ...statFile(path.join(homeDir, '.codex', 'AGENTS.md')) },
      { label: 'Gemini 全局', ...statFile(path.join(homeDir, '.gemini', 'GEMINI.md')) },
    ],
    // 平铺模式下这三份是被 CLI 直接读取的（cwd 就是工作根），不是播种源。
    workspaceFiles: flatRoot
      ? [
        { label: '工作根 AGENTS.md（Codex / Kimi 直接读）', ...statFile(path.join(workspaceRoot, 'AGENTS.md')) },
        { label: '工作根 CLAUDE.md（Claude 直接读）', ...statFile(path.join(workspaceRoot, 'CLAUDE.md')) },
        { label: '工作根 GEMINI.md', ...statFile(path.join(workspaceRoot, 'GEMINI.md')) },
      ]
      : [
        { label: '工作区根 AGENTS.md（seed 源）', ...statFile(path.join(workspaceRoot, 'AGENTS.md')) },
        { label: '工作区根 CLAUDE.md（Claude 向上链）', ...statFile(path.join(workspaceRoot, 'CLAUDE.md')) },
        { label: '工作区根 GEMINI.md', ...statFile(path.join(workspaceRoot, 'GEMINI.md')) },
      ],
    claudeMemory,
    codexMemory,
    seedCopies,
    consolidation: {
      ...consolidation,
      config: normalizeConsolidationConfig(consolidationConfig),
      defaultConfig: DEFAULT_CONSOLIDATION_CONFIG,
      coverage: {
        label: 'seed / memory 孤岛整理器',
        sourceKinds: ['modified-seed-agents', 'claude-memory-island'],
        includesNormalSessions: false,
      },
    },
  };
}

// 某个 session cwd 的记忆视角：只列该 provider **实际读取**的规则链与记忆面。
// DeepSeek 已迁移到 Codex runtime；只有 transcriptKind=deepseek-legacy* 的存量会话
// 仍消费 .claude-deepseek bucket，不能再按公开 kind=deepseek 一刀切成 Claude。
function getSessionFiles({
  cwd,
  kind,
  runtimeKind,
  codexSessionsRoot,
  codexProfile,
  meetingId,
  homeDir = os.homedir(),
  workspaceRoot,
  rulesOnly = false,
}) {
  if (!cwd) return { cwd: null, files: [], memory: null };
  const resolved = path.resolve(String(cwd));
  const baseKind = String(kind || '').replace(/-resume$/, '');
  const effectiveRuntime = String(runtimeKind || kind || '').replace(/-resume$/, '');
  const deepseekLegacy = baseKind === 'deepseek' && effectiveRuntime.startsWith('deepseek-legacy');
  const claudeFamily = baseKind === 'claude' || deepseekLegacy;
  const codexFamily = baseKind === 'codex' || (baseKind === 'deepseek' && !deepseekLegacy);
  const codexHome = codexSessionsRoot
    ? path.dirname(path.resolve(codexSessionsRoot))
    : path.join(homeDir, '.codex');

  let files = [];
  const memory = [];
  let memoryFiles = [];
  let memoryNote = '';
  let ruleNote = '';

  if (claudeFamily) {
    const root = deepseekLegacy ? '.claude-deepseek' : '.claude';
    files = discoverClaudeFiles(resolved, path.join(homeDir, root), workspaceRoot);
    if (rulesOnly) return { files };
    const slug = projectSlug(resolved);
    const memoryDir = path.join(homeDir, root, 'projects', slug, 'memory');
    let status = 'missing';
    let target = '';
    try {
      const st = fs.lstatSync(memoryDir);
      if (st.isSymbolicLink()) {
        status = 'linked';
        try { target = fs.readlinkSync(memoryDir); } catch {}
      } else if (st.isDirectory()) {
        status = listMdFiles(memoryDir, 200).length ? 'island' : 'empty-dir';
      }
    } catch {}
    memory.push({ label: `${root} cwd bucket`, root, path: memoryDir, status, target });
    memoryNote = deepseekLegacy
      ? '这是迁移前仍运行 Claude CLI 的 DeepSeek 会话；spawn 时只维护 .claude-deepseek bucket，并共享主 Claude 规范库。'
      : 'Claude 在 spawn 前把本 cwd 的 memory bucket 链到主规范库；只有 MEMORY.md 路由自动注入，详细条目按需读取。';
    ruleNote = '下方只列 Claude Code 实际读取的全局 CLAUDE.md、祖先 CLAUDE.md 与 CLAUDE.local.md。';
  } else if (codexFamily) {
    const discovered = discoverCodexFiles(resolved, codexHome);
    files = discovered.rows;
    if (rulesOnly) return { files };
    const codexMemory = inspectCodexMemory(codexHome);
    const status = codexMemory.useMemories
      ? 'enabled'
      : (codexMemory.exists ? 'present' : 'disabled');
    memory.push({
      label: baseKind === 'deepseek' ? 'DeepSeek Codex profile memories' : 'Codex local memories',
      root: codexHome,
      path: codexMemory.path,
      status,
      totalFiles: codexMemory.totalFiles,
      rolloutSummaryCount: codexMemory.rolloutSummaryCount,
    });
    memoryFiles = codexMemory.files.map(file => ({
      label: file.name,
      path: file.path,
      exists: true,
      size: file.size,
      mtime: file.mtime,
      role: 'memory',
    }));
    if (baseKind === 'deepseek') {
      memoryNote = codexMemory.useMemories
        ? '当前 DeepSeek 运行在独立 Codex profile，并使用该 profile 自己的 local memories。'
        : `当前 DeepSeek 运行在独立 Codex profile（${codexProfile || 'deepseek-api'}），未启用 Codex local memories。${meetingId ? '群聊会额外注入 Claude MEMORY.md 的只读路由副本。' : ''}`;
    } else {
      memoryNote = codexMemory.useMemories
        ? 'Codex local memories 已启用：它与 Claude memory 完全独立，在会话空闲后后台生成，不保证结束即写。'
        : '该 CODEX_HOME 未启用 local memories；必达规则仍由上方 AGENTS.md 链提供。';
    }
    ruleNote = `Codex 启动时从 ${codexHome} 读取全局指令，再从 project root 向 cwd 合并项目指令；已打开的会话不会实时重建该链。`;
  } else if (baseKind === 'kimi') {
    files = discoverKimiFiles(resolved, homeDir);
    memoryNote = 'Hub 未检测到 Kimi 的独立本地 memory store；可确定的持久上下文是上方 AGENTS.md 链。';
    ruleNote = 'Kimi 读取 ~/.kimi-code/AGENTS.md；有 .git 时从最近 git root 向下读取，无 .git 时只读 cwd。';
  } else if (baseKind === 'gemini') {
    files = discoverGeminiFiles(resolved, homeDir, workspaceRoot);
    const rootGemini = path.join(workspaceRoot, 'GEMINI.md');
    memoryNote = 'Hub 当前只核验 Gemini 的 GEMINI.md 指令链，不把其它 CLI 的 memory 冒充为 Gemini 记忆。';
    ruleNote = fs.existsSync(rootGemini)
      ? '下方只列 Gemini 实际可读取的 GEMINI.md 文件。'
      : `工作根规则缺失：${rootGemini}`;
  } else {
    memoryNote = `${baseKind || '该'} 会话没有 Hub 可核验的 provider memory store。`;
    ruleNote = '该会话没有 provider 指令文件链。';
  }

  return {
    cwd: resolved,
    kind: baseKind,
    runtimeKind: effectiveRuntime,
    claudeFamily,
    codexFamily,
    files,
    memory,
    memoryFiles,
    memoryNote,
    ruleNote,
  };
}

module.exports = {
  getOverview,
  getSessionFiles,
  readChangelog,
  inspectClaudeMemory,
  inspectCodexMemory,
  inspectSeedCopies,
};
