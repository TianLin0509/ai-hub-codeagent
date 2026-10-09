'use strict';
/**
 * 开发场景的工作目录闸门。
 *
 * 为什么需要它：dev-task 预设的两步 prompt 写死了「读本仓库的 .agents/AUTHOR.md」
 * 和「跑 scripts/merge_task.py --dry-run」，路径都是**仓库内相对路径**。
 * 群聊把工作目录直接给 CLI 当 cwd，而**建群弹窗默认选的是「默认工作目录」**
 * （平铺工作根 C:\Work，不是任何仓库）。
 *
 * 落在那里会发生什么：agent 找不到 .agents/AUTHOR.md，**它不会自己 cd 到某个项目**
 * ——它根本不知道你指的是哪个仓库。实际表现是它开始满盘乱翻、或者反问你一句、
 * 或者随便挑一个仓库动手。三种都不是你要的，而且都要等好几分钟才看得出来。
 *
 * 所以在建群那一刻就挡住，比让它在第一步失败便宜得多。
 *
 * 2026-09-06 放开一条口子：**工作根本身**（默认工作目录）允许开发场景。
 * 用户不想每次都去找项目路径。代价由预设 prompt 承担：建群时会把项目库
 * （已整理项目的中文名 → 路径）写进两步的 prompt，让 AI 按任务描述自己定位到项目根。
 * 其它非仓库目录（临时目录、随便选的文件夹）仍然挡住 —— 那里既不是项目也没有项目库语义。
 */

const fs = require('fs');
const path = require('path');

function _sameDir(a, b) {
  const norm = p => String(p || '').replace(/[\\/]+$/, '').replace(/\//g, '\\').toLowerCase();
  return !!a && !!b && norm(a) === norm(b);
}

/**
 * @param {string} dir 用户选的工作目录
 * @param {{fs?: object, workRoot?: string}} [deps] 注入用，测试传假 fs；
 *        workRoot = 平铺工作根路径，dir 等于它时放行（reason: 'work-root'），由 prompt 里的项目库接手定位
 * @returns {{ok: boolean, reason: string, message: string}}
 */
function checkDevWorkspace(dir, deps = {}) {
  const _fs = deps.fs || fs;
  const d = typeof dir === 'string' ? dir.trim() : '';

  if (!d) {
    return {
      ok: false,
      reason: 'no-path',
      message: '开发场景必须选一个项目目录。请点「选择已有路径」挑到项目根，或用「项目库」一键选。',
    };
  }

  if (deps.workRoot && _sameDir(d, deps.workRoot)) {
    return { ok: true, reason: 'work-root', message: '' };
  }

  let stat = null;
  try {
    stat = _fs.statSync(d);
  } catch (e) {
    // 2026-09-08 第五轮：配置的目录不存在时，原来在建房这一刻硬报错把用户挡在外面。
    // 任务书第七节要的是另一种处理：不存在的 cwd 会让 CLI 在启动前就失败，
    // 所以 Hub 应当**退到一个确实存在的目录**、在那里进入只读定位流程，
    // 并把「你配的那个不存在」明确说出来。找不到像样的落脚点才继续硬报错。
    // 只在这个落脚点**本身就是一个有效项目现场**时才放行。
    // 退到一个随便什么存在的文件夹并不能解决问题 —— 那只是把失败推迟到第一步，
    // 而且会造出一个开在非项目目录上的开发房。
    const ancestor = _nearestExistingAncestor(_fs, d);
    const owningProject = ancestor ? _findRepoRoot(_fs, ancestor) : null;
    // 找不到所属项目时退到**平铺工作根**：它是任务书说的「受约束的有效目录」——
    // 带着项目库，CLI 能在那里起来做只读定位，而不是把用户挡在建房外面。
    // 连工作根都拿不到才继续硬报错。
    const workRootFallback = (!owningProject && deps.workRoot && _exists(_fs, deps.workRoot))
      ? deps.workRoot : null;
    const fallback = owningProject || workRootFallback;
    if (fallback) {
      return {
        ok: true,
        reason: 'ready-fallback',
        resolvedRoot: fallback,
        requestedPath: d,
        atWorkRoot: !owningProject,
        message: [
          `你选的目录不存在：${d}`,
          owningProject
            ? `已经退到它所属的项目根：${fallback}`
            : `已经退到默认工作目录：${fallback}（AI 会按任务和项目库自己定位到目标项目）`,
          'AI 会在那里先只读核实这是不是本任务要动的项目，确认之前不写任何文件。',
        ].join(String.fromCharCode(10)),
      };
    }
    return {
      ok: false,
      reason: 'not-found',
      message: `目录不存在：${d}`,
    };
  }
  if (!stat.isDirectory()) {
    return { ok: false, reason: 'not-dir', message: `这不是一个目录：${d}` };
  }

  // 2026-09-08：仓库**子目录**也是合法现场。原来只看 d/.git 在不在，
  // 于是用户选到 repo/src 会被判成「不是 git 仓库」——但那明明就是那个项目。
  // 向上找到仓库根，找到就按仓库根走（.git 是文件的 worktree 同样算数）。
  const repoRoot = _findRepoRoot(_fs, d);
  const isGit = !!repoRoot;
  const base = repoRoot || d;
  const cfg = path.join(base, '.agents', 'project.json');
  const hasCfg = _exists(_fs, cfg);

  if (!isGit) {
    return {
      ok: false,
      reason: 'not-a-repo',
      message: [
        `${d} 不是一个 git 仓库。`,
        '开发场景要在项目根上开：工作位要建分支、合并位要合主干，都需要仓库。',
        '想让 AI 自己找项目，选「默认工作目录」；想指定项目，点「选择已有路径」→「项目库」。',
        '如果你本来就想随便问一句，把场景切回「通用」即可。',
      ].join('\n'),
    };
  }

  if (!hasCfg) {
    return {
      ok: false,
      reason: 'not-prepared',
      message: [
        `${d} 还没整理成可并行开发的形态（缺 .agents/project.json）。`,
        '',
        '开发场景的预设 prompt 会读这个仓库里的 .agents/AUTHOR.md 与 .agents/MERGER.md，',
        '合并位还要跑 scripts/merge_task.py。这些现在都不在，流程会在第一步就断掉。',
        '',
        '先开一个普通会话（不是群聊），在这个项目目录下说：',
        '    用 project-prep skill，把这个仓库整理成能开并行群聊的规范项目。',
        '整理是一次性的，之后这个项目的每个群聊都不用再做。',
      ].join('\n'),
    };
  }

  return {
    ok: true,
    reason: _sameDir(base, d) ? 'ready' : 'ready-subdir',
    // 选中的是子目录时把仓库根带出来，调用方应当用它建群 —— 否则合同里那些
    // 仓库内相对路径（.agents/AUTHOR.md、scripts/merge_task.py）还是找不到。
    resolvedRoot: base,
    message: '',
  };
}

/**
 * 向上找最近一个确实存在的祖先目录。盘符根不算 —— 退到 `C:\` 既没意义又危险。
 */
function _nearestExistingAncestor(_fs, dir) {
  let current = String(dir || '');
  for (let depth = 0; depth < 40; depth += 1) {
    const parent = path.dirname(current);
    if (!parent || parent === current) return null;   // 走到盘符根就放弃
    current = parent;
    if (path.dirname(current) === current) return null;
    if (_exists(_fs, current)) return current;
  }
  return null;
}

/** 从 dir 向上找仓库根。`.git` 是文件（git worktree）同样算数。 */
function _findRepoRoot(_fs, dir) {
  let current = String(dir || '');
  for (let depth = 0; depth < 40 && current; depth += 1) {
    if (_exists(_fs, path.join(current, '.git'))) return current;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}

function _exists(_fs, p) {
  try {
    _fs.statSync(p);
    return true;
  } catch (e) {
    return false;
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { checkDevWorkspace };
}
if (typeof window !== 'undefined') {
  window.DevWorkspaceGuard = { checkDevWorkspace };
}
