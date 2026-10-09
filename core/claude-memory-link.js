'use strict';
// Claude Code 的 memory 目录按 cwd 分桶：~/<root>/projects/<slug(cwd)>/memory。
// Hub 现在每个任务都开在全新的 _scratch/inbox-*，归档后路径又变一次，所以用户
// 积累的记忆库（默认在 home 目录对应的桶里）在任何 Hub 会话中都读不到。
//
// 这里在会话 spawn 前把新桶的 memory 指向同一个规范库（Windows junction，
// 不需要管理员权限）。deepseek 走 CLAUDE_CONFIG_DIR=~/.claude-deepseek，
// transcript/settings 刻意隔离，但记忆（用户偏好、协作约定）是要共享的，
// 所以两个 root 都指向同一份库。

const fs = require('fs');
const crypto = require('crypto');
const os = require('os');
const path = require('path');

const { CLAUDE_PROJECT_ROOT_DIRS, projectSlug } = require('./claude-transcript-locator.js');
const { acquireLock, releaseLock } = require('./file-lock.js');
const { createJunctionSync } = require('./fs-junction.js');

function defaultHomeDir() {
  return process.env.USERPROFILE || process.env.HOME || os.homedir();
}

// 规范库 = home 目录自身的 project 桶，也就是用户在迁移到 C:\Workspace 之前
// 一直在用的那个（~/.claude/projects/C--Users-you/memory）。
function canonicalMemoryDir(homeDir = defaultHomeDir()) {
  return path.join(homeDir, '.claude', 'projects', projectSlug(homeDir), 'memory');
}

function isLinked(memoryPath) {
  try {
    return fs.lstatSync(memoryPath).isSymbolicLink();
  } catch {
    return false;
  }
}

function sameResolvedDirectory(left, right) {
  try {
    const normalize = value => {
      const resolved = fs.realpathSync.native(value);
      return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
    };
    return normalize(left) === normalize(right);
  } catch {
    return false;
  }
}

// 真实目录里的记忆一律先并进规范库再换链接，绝不覆盖、绝不丢。
//
// 2026-07-29 三方审查实测：原实现是 `if (exists) skip`，把「不覆盖」做成了「不处理」。
// 后果实锤——`C--Vibe--scratch-inbox-20260727-231940-87d878` 桶里躺着 22,780 字节的
// 无线大赛项目记忆（当天上午还在写），规范库一个字都读不到，且这条代码路径保证它
// 永远不会自愈。同一小时内又新长出一个空目录孤岛，证明是持续产生而非一次性事故。
// 现在按三种情况分别处理，只有「已是链接」才真的什么都不做。
function fileDigest(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function sameFileContent(left, right) {
  try {
    const a = fs.statSync(left);
    const b = fs.statSync(right);
    return a.size === b.size && fileDigest(left) === fileDigest(right);
  } catch {
    return false;
  }
}

function rollbackCreatedFiles(files, logger) {
  for (const file of files.slice().reverse()) {
    try { fs.unlinkSync(file); } catch (error) {
      logger.warn?.(`[memory] rollback could not remove ${file}: ${error && error.message}`);
    }
  }
}

function conflictDestination(canonical, name, slug, from) {
  const parsed = path.parse(name);
  const slugHash = crypto.createHash('sha256').update(slug).digest('hex').slice(0, 8);
  const contentHash = fileDigest(from).slice(0, 12);
  // Windows 单个文件名通常最多 255 字符。不要把完整 cwd slug 塞进文件名；既容易
  // 超限，也会复刻中文目录 slug 塌缩碰撞。两个短 hash 足够定位来源与内容。
  const base = parsed.name.slice(0, 120);
  const stem = `${base}.island-${slugHash}-${contentHash}`;
  let candidate = path.join(canonical, `${stem}${parsed.ext}`);
  for (let i = 2; fs.existsSync(candidate) && !sameFileContent(candidate, from); i++) {
    candidate = path.join(canonical, `${stem}-${i}${parsed.ext}`);
  }
  return candidate;
}

function mergeIntoCanonical(memoryPath, canonical, slug, logger) {
  const moved = [];
  const conflicts = [];
  const deduplicated = [];
  const created = [];
  const entries = fs.readdirSync(memoryPath, { withFileTypes: true });

  // Claude 当前的 memory 库是平铺 Markdown 文件。遇到子目录、junction 或其它特殊项时
  // 不猜它的语义，也不能换链后把它藏进 backup；在任何写入前硬停，原目录保持原样。
  const unsupported = entries.filter(entry => !entry.isFile()).map(entry => entry.name);
  if (unsupported.length) {
    throw new Error(`memory 目录含非普通文件，已保持原样待人工处理：${unsupported.join(', ')}`);
  }

  try {
    for (const entry of entries) {
      const name = entry.name;
      const from = path.join(memoryPath, name);
      const to = path.join(canonical, name);
      if (fs.existsSync(to)) {
        if (sameFileContent(from, to)) {
          deduplicated.push(name);
          continue;
        }
        // 同名不同内容绝不覆盖。用「来源 hash + 内容 hash」另存；同一份冲突重试时幂等，
        // 源内容后来改变时则会生成新文件，不会被旧 conflict 静默吞掉。
        const keep = conflictDestination(canonical, name, slug, from);
        if (!fs.existsSync(keep)) {
          fs.copyFileSync(from, keep);
          created.push(keep);
        }
        conflicts.push(name);
        continue;
      }
      fs.copyFileSync(from, to);
      created.push(to);
      moved.push(name);
    }
  } catch (error) {
    rollbackCreatedFiles(created, logger);
    throw error;
  }
  if (conflicts.length) {
    logger.warn?.(`[memory] ${conflicts.length} 个同名文件未自动合并，已按来源与内容 hash 另存：${conflicts.join(', ')}`);
  }
  return { moved, conflicts, deduplicated, created };
}

function ensureMemoryLink(cwd, opts = {}) {
  const result = { linked: [], skipped: [], errors: [], merged: [], conflicts: [], deduplicated: [] };
  if (!cwd) return result;
  const homeDir = opts.homeDir || defaultHomeDir();
  const canonical = opts.canonicalDir || canonicalMemoryDir(homeDir);
  const logger = opts.logger || console;
  // 生产会话只维护自己真正消费的 bucket，避免每起一个 Claude 会话都顺手在
  // .claude-deepseek 下制造一个只有 memory junction 的空壳桶（反向亦然），也避免
  // Claude 会话替 DeepSeek 的错链报警。未指定时保留两套都审计的兼容行为，供迁移/测试用。
  const projectRootDirs = opts.projectRootDirs == null
    ? CLAUDE_PROJECT_ROOT_DIRS
    : opts.projectRootDirs;
  if (!Array.isArray(projectRootDirs)
      || projectRootDirs.length === 0
      || projectRootDirs.some(root => !CLAUDE_PROJECT_ROOT_DIRS.includes(root))) {
    result.errors.push(`invalid projectRootDirs: ${JSON.stringify(projectRootDirs)}`);
    return result;
  }

  let canonicalExists = false;
  try { canonicalExists = fs.statSync(canonical).isDirectory(); } catch {}
  if (!canonicalExists) {
    result.skipped.push(`canonical memory store missing: ${canonical}`);
    return result;
  }

  const slug = projectSlug(cwd);
  for (const root of projectRootDirs) {
    const bucket = path.join(homeDir, root, 'projects', slug);
    const memoryPath = path.join(bucket, 'memory');
    const lockPath = path.join(bucket, '.hub-memory-link.lock');
    let lockFd = null;
    try {
      fs.mkdirSync(bucket, { recursive: true });
      lockFd = acquireLock(lockPath);
      if (lockFd == null) {
        result.errors.push(`${memoryPath}: memory link 正由另一个 Hub 处理，本次跳过`);
        continue;
      }
      if (path.resolve(memoryPath) === path.resolve(canonical)) {
        result.skipped.push(memoryPath);
        continue;
      }
      // ① 已是 junction/symlink —— 正常态，什么都不用做。
      if (isLinked(memoryPath)) {
        if (sameResolvedDirectory(memoryPath, canonical)) {
          result.skipped.push(memoryPath);
        } else {
          result.errors.push(`${memoryPath}: 已是链接但没有指向规范库，已保持原样待人工确认`);
        }
        continue;
      }
      if (fs.existsSync(memoryPath)) {
        // ② 是文件不是目录 —— 不该发生，不猜意图，报错让人看见。
        if (!fs.statSync(memoryPath).isDirectory()) {
          result.errors.push(`${memoryPath}: 是文件而非目录，无法链接`);
          continue;
        }
        // ③ 真实目录 —— 先把独有记忆并进规范库，原目录改名留底，再换 junction。
        //    空目录走同一条路径（merge 是 no-op），省一个分支。
        const mergeResult = mergeIntoCanonical(memoryPath, canonical, slug, logger);
        const { moved, conflicts, deduplicated, created } = mergeResult;
        const backup = `${memoryPath}.island-backup-${Date.now()}`;
        try {
          fs.renameSync(memoryPath, backup);
        } catch (renameError) {
          // 源目录还在原位，撤掉刚复制进规范库的文件，避免一次失败把下次重试变成伪冲突。
          rollbackCreatedFiles(created, logger);
          throw renameError;
        }
        try {
          createJunctionSync(canonical, memoryPath);
        } catch (linkError) {
          let restored = false;
          try {
            fs.renameSync(backup, memoryPath);   // 链接失败必须把目录放回去，不能让记忆凭空消失
            restored = true;
          } catch (restoreError) {
            logger.warn?.(`[memory] link failed and source restore also failed; backup retained at ${backup}: ${restoreError && restoreError.message}`);
          }
          if (restored) rollbackCreatedFiles(created, logger);
          throw linkError;
        }
        result.linked.push(memoryPath);
        if (moved.length) result.merged.push(...moved.map(n => `${slug}/${n}`));
        if (conflicts.length) result.conflicts.push(...conflicts.map(n => `${slug}/${n}`));
        if (deduplicated.length) result.deduplicated.push(...deduplicated.map(n => `${slug}/${n}`));
        logger.log?.(`[memory] 回收孤岛桶 ${slug}：并入 ${moved.length} 条，冲突 ${conflicts.length} 条，去重 ${deduplicated.length} 条，原目录留底 ${path.basename(backup)}`);
        continue;
      }
      createJunctionSync(canonical, memoryPath);
      result.linked.push(memoryPath);
    } catch (error) {
      result.errors.push(`${memoryPath}: ${error && error.message ? error.message : String(error)}`);
      logger.warn?.('[memory] link failed:', error && error.message);
    } finally {
      if (lockFd != null) releaseLock(lockFd, lockPath);
    }
  }
  return result;
}

// 记忆面板「一键并入」：对指定孤岛桶执行与 spawn 时同一套 merge→留底→换链。
// 与 ensureMemoryLink 的区别：后者按 cwd 算 slug、在会话启动时被动触发；
// 这个按显式 (root, slug) 定位桶，供人工在面板上对存量孤岛主动收口。
function mergeIslandBucket(root, slug, opts = {}) {
  const homeDir = opts.homeDir || defaultHomeDir();
  const canonical = opts.canonicalDir || canonicalMemoryDir(homeDir);
  const logger = opts.logger || console;
  const result = { merged: [], conflicts: [], deduplicated: [], linked: null, backup: null, error: null };
  if (!CLAUDE_PROJECT_ROOT_DIRS.includes(root)) {
    result.error = `invalid root: ${root}`;
    return result;
  }
  if (!/^[A-Za-z0-9-]+$/.test(String(slug || ''))) {
    result.error = `invalid slug: ${slug}`;
    return result;
  }
  let canonicalExists = false;
  try { canonicalExists = fs.statSync(canonical).isDirectory(); } catch {}
  if (!canonicalExists) {
    result.error = `规范库不存在：${canonical}`;
    return result;
  }
  const bucket = path.join(homeDir, root, 'projects', slug);
  const memoryPath = path.join(bucket, 'memory');
  // 规范库自身不可并入——否则「合并进自己」后改名留底，规范库原地变成指向空处的
  // junction（2026-08-01 E2E 实测事故；ensureMemoryLink 本来就有这个判定）。
  if (path.resolve(memoryPath) === path.resolve(canonical)) {
    result.error = '该桶就是规范库本身，无需也无法并入';
    return result;
  }
  const lockPath = path.join(bucket, '.hub-memory-link.lock');
  let lockFd = null;
  try {
    const st = fs.lstatSync(memoryPath);
    if (st.isSymbolicLink()) {
      result.error = '已是链接，无需并入';
      return result;
    }
    if (!st.isDirectory()) {
      result.error = '不是目录，无法并入';
      return result;
    }
    lockFd = acquireLock(lockPath);
    if (lockFd == null) {
      result.error = '该桶正由另一个 Hub 进程处理';
      return result;
    }
    const { moved, conflicts, deduplicated, created } = mergeIntoCanonical(memoryPath, canonical, slug, logger);
    const backup = `${memoryPath}.island-backup-${Date.now()}`;
    try {
      fs.renameSync(memoryPath, backup);
    } catch (renameError) {
      rollbackCreatedFiles(created, logger);
      throw renameError;
    }
    try {
      createJunctionSync(canonical, memoryPath);
    } catch (linkError) {
      let restored = false;
      try { fs.renameSync(backup, memoryPath); restored = true; } catch (restoreError) {
        logger.warn?.(`[memory] 换链失败且原目录恢复也失败，留底在 ${backup}: ${restoreError && restoreError.message}`);
      }
      if (restored) rollbackCreatedFiles(created, logger);
      throw linkError;
    }
    result.merged = moved;
    result.conflicts = conflicts;
    result.deduplicated = deduplicated;
    result.linked = memoryPath;
    result.backup = backup;
    logger.log?.(`[memory] 面板并入孤岛桶 ${slug}（${root}）：并入 ${moved.length}，冲突另存 ${conflicts.length}，去重 ${deduplicated.length}`);
  } catch (error) {
    result.error = String(error && error.message ? error.message : error);
  } finally {
    if (lockFd != null) releaseLock(lockFd, lockPath);
  }
  return result;
}

module.exports = {
  canonicalMemoryDir,
  ensureMemoryLink,
  mergeIslandBucket,
};
