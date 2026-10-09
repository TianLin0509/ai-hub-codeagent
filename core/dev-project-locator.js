'use strict';
/*
 * 开发群聊 · 项目定位（任务书第七节 / E01–E04）
 * ────────────────────────────────────────────────────────────────────────────
 *
 * 要解决的问题：界面上选的工作目录**不是**真相。它可能是默认工作根、可能压根不存在、
 * 也可能指着另一个同样有效但不相干的仓库。原来 Hub 直接把它当 cwd 交给 CLI，于是
 *   · 目录不存在 → CLI 起不来，报一个跟任务毫无关系的错；
 *   · 指错仓库 → agent 在错的仓库里动手，事后才发现。
 *
 * 这里只做三件很克制的事：
 *   1. 给 CLI 一个**确实存在**的启动目录（不存在就退到最近的存在祖先，再退到工作根），
 *      并把「这是兜底目录，先只读定位真正的项目根」明确写进 prompt；
 *   2. 用任务原文里的线索去比对**已记录的项目库**——唯一命中就直说用它、不必再问用户；
 *      多个合理候选才要求提一个具体问题；一个都没有就要求问，而不是满盘扫；
 *   3. 判断一个目录是不是有效仓库现场时，`.git` 是**文件**（worktree）同样算数 ——
 *      按「.git 必须是目录」筛会把合法 worktree 丢掉。
 *
 * 不做的：全盘搜索、递归扫描聚合根、自动 git init、替用户拍板选项目。
 */
const fs = require('fs');
const path = require('path');

/** 聚合根：这些目录本身不是项目，也不许在里面递归乱翻。 */
const AGGREGATE_ROOTS = [require('os').homedir()];

function isAggregateRoot(dir) {
  const resolved = path.resolve(String(dir || '')).toLowerCase();
  return AGGREGATE_ROOTS.some(root => path.resolve(root).toLowerCase() === resolved);
}

/** 盘符根（C:\）/ 文件系统根。退到这里毫无意义，而且很危险。 */
function isFilesystemRoot(dir) {
  const resolved = path.resolve(String(dir || ''));
  return path.dirname(resolved) === resolved;
}

function dirExists(dir) {
  try { return !!dir && fs.statSync(dir).isDirectory(); } catch (error) { return false; }
}

/**
 * 这个目录算不算一个有效的仓库现场。
 * kind: 'repo'（普通仓库根）/ 'worktree'（.git 是文件的工作树，同样有效）/
 *       'subdir'（在某个仓库里但不是根）/ 'none'
 */
function classifyRepo(dir) {
  if (!dirExists(dir)) return { kind: 'none', repoRoot: null, valid: false, reason: 'not_a_directory' };
  let current = path.resolve(dir);
  for (let depth = 0; depth < 40; depth += 1) {
    const gitPath = path.join(current, '.git');
    let stat = null;
    try { stat = fs.statSync(gitPath); } catch (error) { stat = null; }
    if (stat) {
      // .git 是文件 = git worktree。它是**有效**现场，不能因为不是目录就丢掉。
      const kind = stat.isDirectory() ? 'repo' : 'worktree';
      const atRoot = path.resolve(current) === path.resolve(dir);
      return { kind: atRoot ? kind : 'subdir', repoRoot: current, valid: true, worktree: kind === 'worktree' };
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return { kind: 'none', repoRoot: null, valid: false, reason: 'no_git_upwards' };
}

/**
 * 给 CLI 一个确实存在的启动目录。
 * 界面上那个路径不存在时不能直接拿去 spawn —— CLI 会在启动前就失败，
 * 报一个和任务无关的错。退到最近的存在祖先；祖先也不行就退到工作根。
 */
function resolveLaunchDir(configured, fallbackRoot) {
  const wanted = String(configured || '').trim();
  if (wanted && dirExists(wanted)) return { dir: path.resolve(wanted), corrected: false };
  let current = wanted ? path.resolve(wanted) : '';
  const chain = [];
  while (current) {
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
    chain.push(current);
    // 退到盘符根或聚合根都不算「找到落脚点」：前者毫无意义且危险，后者本来就禁止在里面翻。
    if (dirExists(current) && !isAggregateRoot(current) && !isFilesystemRoot(current)) {
      return { dir: current, corrected: true, reason: 'configured_path_missing', requested: wanted };
    }
  }
  const root = String(fallbackRoot || '').trim();
  if (root && dirExists(root) && !isFilesystemRoot(root)) {
    return { dir: path.resolve(root), corrected: true, reason: 'configured_path_missing', requested: wanted };
  }
  return { dir: null, corrected: true, reason: 'no_valid_directory', requested: wanted };
}

function normalizeProjects(projects) {
  return (Array.isArray(projects) ? projects : [])
    .map(p => ({ name: String((p && p.name) || '').trim(), path: String((p && p.path) || '').trim() }))
    .filter(p => p.path);
}

/**
 * 用任务原文里的线索比对项目库。**只认明确出现的名字或路径**，不做模糊猜测 ——
 * 猜错的代价是在错仓库里动手，比多问一句贵得多。
 */
function matchProjects(taskText, projects) {
  const text = String(taskText || '');
  const list = normalizeProjects(projects);
  if (!text.trim() || !list.length) return [];
  const lower = text.toLowerCase();
  return list.filter((project) => {
    if (project.name && text.includes(project.name)) return true;
    if (project.path && lower.includes(project.path.toLowerCase())) return true;
    const leaf = path.basename(project.path);
    return !!(leaf && leaf.length >= 3 && lower.includes(leaf.toLowerCase()));
  });
}

/**
 * 拼进 prompt 的定位说明。
 * 唯一命中 → 直说用它，不要求用户再选一次（E01/E02）。
 * 多个候选 → 要求提**一个**具体问题，不许自己挑（E03）。
 * 没有候选 → 同样要求问；并明确禁止全盘搜索和自动初始化（§7.7）。
 */
function buildLocatorBlock(opts = {}) {
  const taskText = String(opts.taskText || '');
  const projects = normalizeProjects(opts.projects);
  const launch = opts.launch || {};
  const atWorkRoot = opts.atWorkRoot === true;
  const matches = matchProjects(taskText, projects);
  const lines = ['## 先核实项目现场（不要把界面上的工作目录当成真相）'];

  if (launch.corrected) {
    lines.push(
      `注意：界面上配置的工作目录 ${launch.requested || '(空)'} 现在不存在，`
      + `Hub 已经把 CLI 起在一个确实存在的目录里：${launch.dir || '(无)'}。`,
      '这只是个能让你跑起来的落脚点，**不是**目标项目。先只读定位真正的项目根，确认之前不要在这里写任何文件。',
    );
  } else if (atWorkRoot) {
    lines.push(`当前工作目录 ${launch.dir || ''} 是工作根，不是任何项目的根。先定位到目标项目再动手。`);
  } else {
    lines.push(`当前工作目录：${launch.dir || ''}。开工前先核实它确实是本任务要动的那个项目。`);
  }

  if (matches.length === 1) {
    lines.push(
      `按任务原文里的线索，项目库里只有一个匹配项，已经唯一确认：${matches[0].name || matches[0].path} → ${matches[0].path}`,
      '直接切到它，之后「本仓库」一律指它。**不要再问维护者选哪个**，只需在回复里用一句话说明你纠正到了哪个项目。',
    );
  } else if (matches.length > 1) {
    lines.push('按任务原文里的线索，下面这些都对得上，无法唯一确定：');
    for (const project of matches) lines.push(`- ${project.name || project.path} → ${project.path}`);
    lines.push('这时候**只问一个具体问题**：把这些候选列出来，请维护者指定哪一个，然后停下等回答。不要自己挑一个开始改。');
  } else if (projects.length) {
    lines.push('项目库（按最近活跃排序）：');
    for (const project of projects.slice(0, 12)) lines.push(`- ${project.name || project.path} → ${project.path}`);
    lines.push('任务原文里没有能唯一确定项目的线索。先问维护者一句「是这几个里的哪一个」，不要猜。');
  } else {
    lines.push('项目库是空的。就近做有限的只读核查即可，判断不了就问维护者一句，不要猜。');
  }

  lines.push(
    '任务里出现的路径可能只是**例子或引用**，不能当成目标；拿不准就把它当引用。',
    '判断一个目录是不是有效现场时，`.git` 是文件（git worktree）同样算数，不要因为它不是目录就丢掉。',
      '不许全盘搜索，不许递归扫描用户主目录这类聚合根，也不许自动 git init 造一个新仓库。',
  );
  return lines.join('\n');
}

// 开题报告里声明项目根的那一行。Hub 读到它就把群聊的工作现场绑过去，
// 这样实现位和审查位后续用的是**同一个已核实路径**，而不是各自再猜一遍。
const PROJECT_ROOT_LINE = /(?:^|\n)[ \t]*(?:项目根|已核实项目根|project[ _-]?root)[ \t]*[:：][ \t]*([^\n]+)/i;

function extractDeclaredProjectRoot(reportText) {
  const matched = PROJECT_ROOT_LINE.exec(String(reportText || ''));
  if (!matched) return null;
  const raw = matched[1].trim().replace(/^[`"']|[`"']$/g, '').trim();
  if (!raw) return null;
  return raw;
}

/** 只有「确实存在 + 是有效仓库现场 + 不是聚合根」才允许绑定，否则保持原样。 */
function verifyDeclaredProjectRoot(declared) {
  const raw = String(declared || '').trim();
  if (!raw) return { ok: false, reason: 'empty' };
  if (!dirExists(raw)) return { ok: false, reason: 'not_a_directory', path: raw };
  if (isAggregateRoot(raw)) return { ok: false, reason: 'aggregate_root', path: raw };
  const repo = classifyRepo(raw);
  if (!repo.valid) return { ok: false, reason: repo.reason || 'not_a_repo', path: raw };
  return { ok: true, path: path.resolve(raw), repo };
}

module.exports = {
  AGGREGATE_ROOTS,
  isAggregateRoot,
  isFilesystemRoot,
  dirExists,
  classifyRepo,
  resolveLaunchDir,
  matchProjects,
  buildLocatorBlock,
  extractDeclaredProjectRoot,
  verifyDeclaredProjectRoot,
};
